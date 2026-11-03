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
  return {
    id, source: 'simulated', method,
    url: `https://${host}${idPath}${path === '/' ? '' : path}${qs}`,
    path: idPath + (path === '/' ? '' : path), headers: finalHeaders, query, body,
    size: byteLength(body), time: now.toISOString(),
  };
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

/** Drop malformed items loaded from storage. */
export function sanitizeHistory(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && typeof r === 'object' && r.id && r.method && typeof r.headers === 'object').slice(0, HISTORY_CAP);
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

export function exportHistory(list, now = new Date()) {
  return JSON.stringify({ exportedAt: now.toISOString(), count: list.length, requests: list }, null, 2);
}

export const methodBadgeClass = m => ({ GET: 'badge-info', POST: 'badge-success', PUT: 'badge-warn', PATCH: 'badge-warn', DELETE: 'badge-danger' }[m] || '');

// ------------------------------------------------------------ external service (webhook.site)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
    return { apiUrl: u.toString(), service: 'custom' };
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
  for (const [k, v] of Object.entries(r.headers || {})) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  const body = r.content == null ? '' : String(r.content);
  let url = String(r.url || '');
  let path = '/';
  try { const u = new URL(url); path = u.pathname + u.search; } catch { path = url; }
  return {
    id: `ext-${r.uuid}`, source: 'external', method: String(r.method || 'GET').toUpperCase(),
    url, path, headers, query: toPairs(r.query), body,
    size: Number.isFinite(Number(r.size)) ? Number(r.size) : byteLength(body),
    time: parseExternalTime(r.created_at, now), ip: r.ip || undefined,
  };
}

/** Validate an API response and return normalised records (throws a friendly error if the shape is wrong). */
export function parseExternalResponse(json, now = new Date()) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) {
    throw new WebhookError('Unexpected response format: expected JSON like { "data": [ ... ] }. Check that the URL is the service\'s requests API.');
  }
  return json.data.map(r => normalizeExternalRequest(r, now));
}

/** Add only the records whose id is not already known. Returns { list, added }. */
export function mergeExternal(list, incoming, cap = HISTORY_CAP) {
  const known = new Set(list.map(r => r.id));
  const fresh = incoming.filter(r => !known.has(r.id)).sort((a, b) => new Date(a.time) - new Date(b.time));
  let out = list;
  for (const r of fresh) out = addToHistory(out, r, cap); // oldest first, so the newest ends up on top
  return { list: out, added: fresh.length };
}
