// Webhook inspector: pure logic (no DOM). A static page cannot receive real HTTP requests, so
// requests are either SIMULATED locally (source 'simulated') or imported from an external
// inspection service such as webhook.site (source 'external').
//
// Request record shape:
//  { id, source, method, url, path, headers:{name:value}, query:[[k,v]], body, size, time (ISO), ip? }

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const HISTORY_CAP = 100;
export const DEMO_HOST = 'webhook.demo.local';

export class WebhookError extends Error {
  constructor(message) { super(message); this.name = 'WebhookError'; }
}

// ------------------------------------------------------------ ids / urls

/** Random lowercase id. `rng` returns a float in [0,1) (inject crypto-based one from the UI). */
export function randomId(len = 12, rng = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}
export const demoUrl = id => `https://${DEMO_HOST}/${id}`;

const byteLength = s => new TextEncoder().encode(String(s ?? '')).length;
export const formatSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

// ------------------------------------------------------------ headers

/** Case-insensitive header lookup. */
export function getHeader(headers, name) {
  const k = Object.keys(headers || {}).find(h => h.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : headers[k];
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Parse "Name: value" lines. Repeated names are joined with ", ". Throws with the line number. */
export function parseHeadersText(text) {
  const headers = {};
  String(text ?? '').split(/\r\n|\n|\r/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const idx = raw.indexOf(':');
    if (idx < 1) throw new WebhookError(`Header line ${i + 1}: expected "Name: value", got "${raw.trim()}".`);
    const name = raw.slice(0, idx).trim(), value = raw.slice(idx + 1).trim();
    if (!HEADER_NAME.test(name)) throw new WebhookError(`Header line ${i + 1}: "${name}" is not a valid header name.`);
    const existing = Object.keys(headers).find(h => h.toLowerCase() === name.toLowerCase());
    if (existing) headers[existing] += `, ${value}`; else headers[name] = value;
  });
  return headers;
}
export const headersToText = headers => Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

// ------------------------------------------------------------ simulated requests

/** Split "/path?a=1&b=2" into { path, query:[[k,v]] }. Fragment is dropped. */
export function parsePathQuery(input) {
  let s = String(input ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw new WebhookError('Enter only a path and query (e.g. /hooks/github?debug=1); the host is the demo endpoint.');
  if (/\s/.test(s)) throw new WebhookError('Path must not contain spaces; percent-encode them as %20.');
  s = s.split('#')[0];
  if (!s.startsWith('/')) s = '/' + s;
  const q = s.indexOf('?');
  const path = q < 0 ? s : s.slice(0, q);
  const query = q < 0 ? [] : [...new URLSearchParams(s.slice(q + 1)).entries()];
  return { path, query };
}

/**
 * Build a "received" record from the compose form. Validates method / headers / body.
 * `now` and `id` injectable for testing.
 */
export function buildSimulatedRequest({ endpoint, method, pathQuery, headersText, body }, now = new Date(), id = randomId(10)) {
  method = String(method || '').toUpperCase();
  if (!METHODS.includes(method)) throw new WebhookError(`Unsupported method "${method}".`);
  const { path, query } = parsePathQuery(pathQuery);
  const headers = parseHeadersText(headersText);
  body = String(body ?? '');
  if (body !== '' && (method === 'GET' || method === 'HEAD')) throw new WebhookError(`${method} requests cannot carry a body. Clear the body or pick another method.`);
  const host = (endpoint.match(/^https?:\/\/([^/]+)/i) || [])[1] || DEMO_HOST;
  const idPath = new URL(endpoint).pathname.replace(/\/$/, ''); // /<endpoint id>
  const finalHeaders = { Host: host, ...headers };
  if (body !== '' && getHeader(finalHeaders, 'content-length') === undefined) finalHeaders['Content-Length'] = String(byteLength(body));
  const qs = query.length ? '?' + new URLSearchParams(query).toString() : '';
  return withCappedBody({
    id, source: 'simulated', method,
    url: `https://${host}${idPath}${path === '/' ? '' : path}${qs}`,
    path: idPath + (path === '/' ? '' : path), headers: finalHeaders, query, body,
    size: byteLength(body), time: now.toISOString(),
  });
}

// ------------------------------------------------------------ sample templates

const pretty = o => JSON.stringify(o, null, 2);

export const TEMPLATES = [
  {
    id: 'github-push', label: 'GitHub push', method: 'POST', path: '/github',
    headers: 'Content-Type: application/json\nUser-Agent: GitHub-Hookshot/abc1234\nX-GitHub-Event: push\nX-GitHub-Delivery: 8f1c2a40-5b6d-11ee-9a3e-0242ac120002\nX-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000',
    body: pretty({
      ref: 'refs/heads/main', before: '0000000000000000000000000000000000000000', after: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      repository: { id: 123456, full_name: 'octocat/hello-world', private: false, html_url: 'https://github.com/octocat/hello-world' },
      pusher: { name: 'octocat', email: 'octocat@example.com' },
      commits: [{ id: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', message: 'Fix typo in README', author: { name: 'Octo Cat', email: 'octocat@example.com' }, added: [], removed: [], modified: ['README.md'] }],
    }),
  },
  {
    id: 'stripe-payment', label: 'Stripe payment_intent.succeeded', method: 'POST', path: '/stripe',
    headers: 'Content-Type: application/json\nUser-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)\nStripe-Signature: t=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000',
    body: pretty({
      id: 'evt_1Nxxxxxxxxxxxxxxxxxxxxxx', object: 'event', api_version: '2023-10-16', created: 1700000000, livemode: false, type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_3Nxxxxxxxxxxxxxxxxxxxxxx', object: 'payment_intent', amount: 2000, currency: 'usd', status: 'succeeded', receipt_email: 'customer@example.com', metadata: { order_id: '6735' } } },
    }),
  },
  {
    id: 'slack-command', label: 'Slack slash command', method: 'POST', path: '/slack',
    headers: 'Content-Type: application/x-www-form-urlencoded\nUser-Agent: Slackbot 1.0 (+https://api.slack.com/robots)\nX-Slack-Request-Timestamp: 1700000000\nX-Slack-Signature: v0=0000000000000000000000000000000000000000000000000000000000000000',
    body: 'token=gIkuvaNzQIHg97ATvDxqgjtO&team_id=T0001&team_domain=example&channel_id=C2147483705&channel_name=general&user_id=U2147483697&user_name=Steve&command=%2Fdeploy&text=production+v1.2.3&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1234%2F5678&trigger_id=13345224609.738474920.8088930838d88f008e0',
  },
  {
    id: 'form-post', label: 'HTML form POST', method: 'POST', path: '/contact',
    headers: 'Content-Type: application/x-www-form-urlencoded\nUser-Agent: Mozilla/5.0',
    body: 'name=Jane+Doe&email=jane%40example.com&message=Hello%2C+world%21%0ASecond+line&subscribe=on',
  },
  {
    id: 'plain-json', label: 'Plain JSON', method: 'POST', path: '/events',
    headers: 'Content-Type: application/json\nUser-Agent: my-service/2.1',
    body: pretty({ event: 'user.created', id: 42, data: { email: 'user@example.com', roles: ['member'] }, createdAt: '2024-01-15T10:30:00Z' }),
  },
];

// ------------------------------------------------------------ body formatting

/**
 * Decide how to show a body: { kind: 'empty'|'json'|'form'|'text', text, pairs? }.
 * JSON is pretty-printed; urlencoded bodies are decoded into key/value pairs.
 */
export function formatBody(body, contentType = '') {
  const raw = String(body ?? '');
  if (raw === '') return { kind: 'empty', text: '' };
  const ct = String(contentType).toLowerCase();
  if (ct.includes('x-www-form-urlencoded')) {
    const pairs = [...new URLSearchParams(raw).entries()];
    return { kind: 'form', text: pairs.map(([k, v]) => `${k} = ${v}`).join('\n'), pairs };
  }
  if (ct.includes('json') || /^\s*[[{]/.test(raw)) {
    try { return { kind: 'json', text: JSON.stringify(JSON.parse(raw), null, 2) }; } catch { /* fall through to raw */ }
  }
  return { kind: 'text', text: raw };
}

// ------------------------------------------------------------ cURL

/** POSIX single-quote escaping: ' becomes '\'' */
export const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Build a bash-compatible curl command reproducing the request. Host/Content-Length are left for curl to set. */
export function toCurl(rec) {
  const parts = ['curl'];
  if (rec.method === 'HEAD') parts.push('-I');
  else if (rec.method !== 'GET') parts.push('-X', rec.method);
  parts.push(shellQuote(rec.url));
  for (const [k, v] of Object.entries(rec.headers || {})) {
    if (/^(host|content-length)$/i.test(k)) continue;
    parts.push('-H', shellQuote(`${k}: ${v}`));
  }
  if (rec.body) parts.push('--data-raw', shellQuote(rec.body));
  return parts.join(' ');
}

// ------------------------------------------------------------ history

/** Newest first, capped. Replaces an entry with the same id. */
export function addToHistory(list, rec, cap = HISTORY_CAP) {
  return [rec, ...list.filter(r => r.id !== rec.id)].slice(0, cap);
}

export const BODY_CAP = 64 * 1024; // bytes of body kept per request (memory and storage)
export const REDACTED = '[redacted]';
const SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
export const isSensitiveHeader = name => SENSITIVE_HEADERS.includes(String(name).toLowerCase());
export const hasSensitiveHeaders = headers => Object.keys(headers || {}).some(isSensitiveHeader);

/** Replace the values of credential-bearing headers with "[redacted]" (returns a new object). */
export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = isSensitiveHeader(k) ? REDACTED : v;
  return out;
}

/** Limit a body to `cap` UTF-8 bytes. Returns { body, truncated }. */
export function capBody(body, cap = BODY_CAP) {
  const text = String(body ?? '');
  if (text.length * 3 <= cap) return { body: text, truncated: false }; // cheap path: cannot exceed the cap
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= cap) return { body: text, truncated: false };
  return { body: new TextDecoder().decode(bytes.subarray(0, cap)).replace(/�+$/, ''), truncated: true };
}

/** Apply the body cap to a record; `size` keeps the original byte size. */
export function withCappedBody(rec, cap = BODY_CAP) {
  const { body, truncated } = capBody(rec.body, cap);
  return truncated ? { ...rec, body, truncated: true } : rec;
}

/** Copy of a record that is safe to persist: credential headers redacted (flagged), body capped. */
export function prepareForStorage(rec) {
  const out = withCappedBody({ ...rec });
  if (hasSensitiveHeaders(out.headers)) { out.headers = redactHeaders(out.headers); out.redacted = true; }
  return out;
}

const plainObject = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const scalarString = v => (typeof v === 'string' ? v : ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') ? String(v) : null);

function cleanHeaders(h) {
  const out = {};
  if (!plainObject(h)) return out;
  for (const [k, v] of Object.entries(h)) { const sv = scalarString(v); if (sv !== null) out[k] = sv; }
  return out;
}
function cleanQuery(q) {
  if (!Array.isArray(q)) return [];
  return q.filter(p => Array.isArray(p) && p.length >= 2 && scalarString(p[0]) !== null && scalarString(p[1]) !== null).map(p => [scalarString(p[0]), scalarString(p[1])]);
}

/** Validate one stored record; returns a clean record or null when unusable. */
export function sanitizeRecord(r, now = new Date()) {
  if (!plainObject(r)) return null;
  const id = scalarString(r.id);
  const method = typeof r.method === 'string' ? r.method.trim().toUpperCase() : '';
  if (!id || !/^[A-Z]{1,20}$/.test(method)) return null;
  if (r.source !== 'simulated' && r.source !== 'external') return null;
  const body = r.body == null ? '' : (scalarString(r.body) ?? '');
  const t = r.time == null ? new Date(NaN) : new Date(r.time);
  const out = {
    id, source: r.source, method,
    url: scalarString(r.url) ?? '', path: scalarString(r.path) ?? '',
    headers: cleanHeaders(r.headers), query: cleanQuery(r.query), body,
    size: typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0 ? r.size : byteLength(body),
    time: Number.isNaN(t.getTime()) ? now.toISOString() : t.toISOString(),
  };
  if (!out.path) out.path = out.url;
  if (typeof r.ip === 'string' && r.ip) out.ip = r.ip;
  if (r.redacted === true) out.redacted = true;
  if (r.truncated === true) out.truncated = true;
  return out;
}

/** Validate shapes of items loaded from storage; unusable records are dropped (never throws). */
export function sanitizeHistory(list, now = new Date()) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const item of list) {
    let rec = null;
    try { rec = sanitizeRecord(item, now); } catch { rec = null; }
    if (!rec || seen.has(rec.id)) continue;
    seen.add(rec.id); out.push(withCappedBody(rec));
    if (out.length >= HISTORY_CAP) break;
  }
  return out;
}

/** Filter by source, method and free text (url / headers / body). */
export function filterRequests(list, { source = null, method = 'ALL', text = '' } = {}) {
  const t = String(text).trim().toLowerCase();
  return list.filter(r => {
    if (source && r.source !== source) return false;
    if (method !== 'ALL' && r.method !== method) return false;
    if (!t) return true;
    return `${r.method} ${r.url} ${headersToText(r.headers)} ${r.body}`.toLowerCase().includes(t);
  });
}

/**
 * Export as JSON. Credential-bearing header values (Authorization, Cookie, API keys...) are replaced with "[redacted]"
 * unless `includeSecrets` is true, so a shared export does not leak tokens. Bodies are exported as stored.
 */
export function exportHistory(list, now = new Date(), { includeSecrets = false } = {}) {
  const requests = includeSecrets ? list : list.map(r => (hasSensitiveHeaders(r.headers) ? { ...r, headers: redactHeaders(r.headers), redacted: true } : r));
  return JSON.stringify({ exportedAt: now.toISOString(), count: requests.length, includesSecrets: !!includeSecrets, requests }, null, 2);
}

/** True when the record's headers contain "[redacted]" placeholders (so a generated cURL command will not authenticate). */
export const hasRedactedValues = rec => Object.values(rec?.headers || {}).some(v => v === REDACTED);

/** Warning shown when copying cURL for a request whose credential headers were redacted, else ''. */
export function curlRedactionWarning(rec) {
  return hasRedactedValues(rec)
    ? 'Credential header values are redacted ("[redacted]") in this saved request. Replace them with real values before running the command.'
    : '';
}

export const methodBadgeClass = m => ({ GET: 'badge-info', POST: 'badge-success', PUT: 'badge-warn', PATCH: 'badge-warn', DELETE: 'badge-danger' }[m] || '');

// ------------------------------------------------------------ external service (webhook.site)

/**
 * Classify a hostname: 'loopback' (localhost, 127/8, ::1), 'private' (10/8, 172.16/12, 192.168/16, *.local, ULA),
 * 'link-local' (169.254/16, fe80::/10) or null for ordinary hosts.
 */
export function privateHostKind(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return 'loopback';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    return null;
  }
  if (h.endsWith('.local')) return 'private';
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'private';
  if (h.startsWith('::ffff:')) return 'private'; // IPv4-mapped IPv6: cannot be judged reliably
  return null;
}

/** Human-readable warning for a private/loopback/link-local API host, or '' when the host is public. */
export function privateHostWarning(kind, host) {
  if (!kind) return '';
  const what = { loopback: 'a loopback address (this computer)', private: 'a private network address', 'link-local': 'a link-local address (often cloud metadata or LAN devices)' }[kind];
  return `"${host}" is ${what}. Polling sends a request from your browser to that host every few seconds. Only continue if you trust it and meant to do this.`;
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export const POLL_BASE_MS = 5000, POLL_MAX_MS = 60000, POLL_MAX_FAILURES = 5, RETRY_AFTER_CAP_MS = 5 * 60 * 1000;

/** Delay before the next attempt after `failures` consecutive failures: exponential (5s, 10s, 20s ... max 60s), at least Retry-After (capped at 5 min). */
export function nextPollDelay(failures, retryAfterMs = null) {
  const exp = Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** Math.max(0, failures - 1));
  return retryAfterMs == null ? exp : Math.max(exp, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
}

const UUID =/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Work out the polling URL. webhook.site's public API (documented): GET https://webhook.site/token/<uuid>/requests
 * returns { data: [ { uuid, method, url, headers, query, content, created_at, ip, size, ... } ] } with CORS enabled.
 * An explicit API URL always wins (useful for self-hosted instances that expose the same format).
 */
export function resolveExternal(inspectionUrl, apiUrl = '') {
  const api = String(apiUrl ?? '').trim();
  if (api) {
    let u;
    try { u = new URL(api); } catch { throw new WebhookError('API URL is not a valid URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new WebhookError('API URL must start with http:// or https://');
    const privateHost = privateHostKind(u.hostname);
    if (u.protocol === 'http:' && privateHost !== 'loopback') throw new WebhookError('API URL must use https:// (plain http:// is only allowed for localhost / 127.0.0.1).');
    return { apiUrl: u.toString(), service: 'custom', host: u.hostname, privateHost };
  }
  const input = String(inspectionUrl ?? '').trim();
  if (!input) throw new WebhookError('Paste your inspection URL from the external service first (e.g. https://webhook.site/<uuid>).');
  let u;
  try { u = new URL(input); } catch { throw new WebhookError('That does not look like a valid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new WebhookError('The URL must start with http:// or https://');
  const id = (u.pathname + u.hash).match(UUID);
  if (/(^|\.)webhook\.site$/i.test(u.hostname)) {
    if (!id) throw new WebhookError('Could not find the token UUID in that webhook.site URL.');
    return { apiUrl: `https://webhook.site/token/${id[0].toLowerCase()}/requests?sorting=newest&per_page=50`, service: 'webhook.site' };
  }
  throw new WebhookError('Polling is only built in for webhook.site. For other services, enter an API URL that returns the same JSON format ({ "data": [ ... ] }).');
}

function parseExternalTime(s, fallback) {
  if (!s) return fallback.toISOString();
  const str = String(s);
  // webhook.site returns "YYYY-MM-DD HH:MM:SS" (UTC) without a zone marker
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
}

/** Convert query given as object or array into [[k,v]] pairs. */
function toPairs(q) {
  if (Array.isArray(q)) return q.map(p => (Array.isArray(p) ? [String(p[0]), String(p[1] ?? '')] : [String(p?.name ?? ''), String(p?.value ?? '')]));
  if (q && typeof q === 'object') return Object.entries(q).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => [k, typeof x === 'object' ? JSON.stringify(x) : String(x ?? '')]));
  return [];
}

/** Map one webhook.site request object into our record shape. */
export function normalizeExternalRequest(r, now = new Date()) {
  if (!r || typeof r !== 'object' || !r.uuid) throw new WebhookError('Unexpected request object in response (missing "uuid").');
  const headers = {};
  if (plainObject(r.headers)) for (const [k, v] of Object.entries(r.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  const body = r.content == null ? '' : typeof r.content === 'object' ? JSON.stringify(r.content) : String(r.content);
  let url = String(r.url || '');
  let path = '/';
  try { const u = new URL(url); path = u.pathname + u.search; } catch { path = url; }
  return withCappedBody({
    id: `ext-${r.uuid}`, source: 'external', method: String(r.method || 'GET').toUpperCase(),
    url, path, headers, query: toPairs(r.query), body,
    size: Number.isFinite(Number(r.size)) ? Number(r.size) : byteLength(body),
    time: parseExternalTime(r.created_at, now), ip: typeof r.ip === 'string' && r.ip ? r.ip : undefined,
  });
}

/**
 * Validate an API response. Returns { records, skipped } where `skipped` counts malformed entries that were ignored.
 * Throws a friendly error only if the overall shape is wrong.
 */
export function parseExternalResponse(json, now = new Date()) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) {
    throw new WebhookError('Unexpected response format: expected JSON like { "data": [ ... ] }. Check that the URL is the service\'s requests API.');
  }
  const records = []; let skipped = 0;
  for (const r of json.data) {
    try { records.push(normalizeExternalRequest(r, now)); } catch { skipped++; }
  }
  return { records, skipped };
}

/** Add only the records whose id is not already known. Returns { list, added }. */
export function mergeExternal(list, incoming, cap = HISTORY_CAP) {
  const known = new Set(list.map(r => r.id));
  const fresh = incoming.filter(r => !known.has(r.id)).sort((a, b) => new Date(a.time) - new Date(b.time));
  let out = list;
  for (const r of fresh) out = addToHistory(out, r, cap); // oldest first, so the newest ends up on top
  return { list: out, added: fresh.length };
}
