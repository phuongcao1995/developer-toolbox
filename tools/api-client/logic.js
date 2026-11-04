// Pure helpers for the API client (no DOM access).
import { base64Utf8 } from '../../assets/js/shared/curl.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const BODY_TYPES = ['json', 'text', 'form', 'raw', 'multipart'];
export const HISTORY_MAX = 25;
export const PINNED_MAX = 50;
export const HISTORY_BODY_MAX = 64 * 1024;        // chars of request body kept in history
export const MAX_DISPLAY_BYTES = 2 * 1024 * 1024; // response bytes rendered as text
export const DEFAULT_TIMEOUT_SEC = 30;
export const REDACTED = '[redacted]';
export const SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token', 'api-key'];

/** Does this HTTP method send a request body from this tool? */
export const methodAllowsBody = method => BODY_METHODS.includes(String(method || '').toUpperCase());

/** Clamp a user-entered timeout to an integer 1..300 (seconds); empty/invalid -> default. */
export function clampTimeout(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || String(v ?? '').trim() === '') return DEFAULT_TIMEOUT_SEC;
  return Math.min(300, Math.max(1, n));
}

/** Returns { ok, url?, error? }. Only absolute http/https URLs are accepted. */
export function validateUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'Enter a URL, e.g. https://jsonplaceholder.typicode.com/todos/1' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'Invalid URL. Include the protocol, e.g. https://example.com/path' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `Unsupported protocol "${u.protocol}" — only http and https are allowed.` };
  return { ok: true, url: u };
}

/** Keep rows that are enabled and have a non-empty key. */
export const activeRows = rows => (rows || []).filter(r => r && r.enabled !== false && String(r.key ?? '').trim() !== '');

/**
 * Merge enabled query-param rows into the URL's existing query string (appending).
 * NOTE: the UI keeps params and the URL field in sync, so it sends the URL field as-is; this helper is kept for callers
 * that hold a URL and a separate row list.
 */
export function buildUrl(raw, params) {
  const v = validateUrl(raw);
  if (!v.ok) return v;
  const u = v.url;
  for (const r of activeRows(params)) u.searchParams.append(String(r.key).trim(), String(r.value ?? ''));
  return { ok: true, url: u.toString() };
}

/** Parse the query string of a (complete) URL into rows. */
export function paramsFromUrl(raw) {
  try { return [...new URL(raw).searchParams].map(([key, value]) => ({ key, value, enabled: true })); } catch { return []; }
}

// ---------- two-way params <-> URL text ----------
/** Decode one query component tolerantly ("+" is a space; malformed escapes are kept as typed). */
function decodeComponent(str) {
  const t = str.replace(/\+/g, ' ');
  try { return decodeURIComponent(t); } catch { return t; }
}

/** Split a raw URL string into { base, query, hasQuery, hash } without altering any part. */
export function splitUrl(raw) {
  const str = String(raw ?? '');
  const h = str.indexOf('#');
  const hash = h >= 0 ? str.slice(h) : '';
  const rest = h >= 0 ? str.slice(0, h) : str;
  const qi = rest.indexOf('?');
  return { base: qi >= 0 ? rest.slice(0, qi) : rest, query: qi >= 0 ? rest.slice(qi + 1) : '', hasQuery: qi >= 0, hash };
}

/** Parse the query of raw (possibly incomplete) URL text into param rows. */
export function paramsFromText(raw) {
  const { query } = splitUrl(raw);
  if (!query) return [];
  return query.split('&').filter(p => p !== '').map(p => {
    const i = p.indexOf('=');
    return { key: decodeComponent(i >= 0 ? p.slice(0, i) : p), value: i >= 0 ? decodeComponent(p.slice(i + 1)) : '', enabled: true };
  });
}

/** Serialize enabled rows to a query string (no leading "?"). */
/** encodeURIComponent that leaves {{variable}} placeholders untouched so substitution still works. */
export const encodeKeepVars = s => String(s).split(/(\{\{[^{}]+\}\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join('');
export const serializeParams = rows => activeRows(rows).map(r => `${encodeKeepVars(String(r.key).trim())}=${encodeKeepVars(String(r.value ?? ''))}`).join('&');

/** Replace only the query part of raw URL text with the enabled rows; scheme/host/path and #hash stay exactly as typed. */
export function applyParamsToUrl(raw, rows) {
  const { base, hash } = splitUrl(raw);
  const q = serializeParams(rows);
  return base + (q ? '?' + q : '') + hash;
}

// ---------- body ----------
/** Validate JSON text. Returns { ok, value?, error? } (empty text is ok with value undefined). */
export function parseJson(text) {
  if (!String(text ?? '').trim()) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: `Invalid JSON: ${e.message}` }; }
}

export function prettifyJson(text, indent = 2) {
  const r = parseJson(text);
  if (!r.ok) return r;
  if (r.value === undefined) return { ok: true, text: '' };
  return { ok: true, text: JSON.stringify(r.value, null, indent) };
}

/** Form body: one "key=value" per line (encoded for you) or a single already-encoded "a=1&b=2" string. */
export function normalizeFormBody(text) {
  const t = String(text ?? '');
  if (!/[\r\n]/.test(t.trim())) return t.trim();
  const usp = new URLSearchParams();
  for (const line of t.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const i = line.indexOf('=');
    usp.append(i >= 0 ? line.slice(0, i) : line, i >= 0 ? line.slice(i + 1) : '');
  }
  return usp.toString();
}

const DEFAULT_CT = { json: 'application/json', text: 'text/plain;charset=UTF-8', form: 'application/x-www-form-urlencoded', raw: null, multipart: null };

/** Multipart body text: one "key=value" per line -> [[key, value], ...] (blank lines skipped). */
export function parseFormLines(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const i = line.indexOf('=');
    out.push(i >= 0 ? [line.slice(0, i), line.slice(i + 1)] : [line, '']);
  }
  return out;
}
/** Inverse of parseFormLines. */
export const formToLines = form => (form || []).map(f => `${f.key}=${String(f.value ?? '').replace(/\r?\n/g, ' ')}`).join('\n');

// ---------- auth ----------
export const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey', 'custom'];
const AUTH_SECRET_FIELDS = ['token', 'password', 'value', 'credential'];
export function normalizeAuth(a) {
  const s = v => (typeof v === 'string' ? v.slice(0, 20000) : '');
  if (!a || typeof a !== 'object' || !AUTH_TYPES.includes(a.type) || a.type === 'none') return { type: 'none' };
  const base = { type: a.type };
  if (a.type === 'bearer') return { ...base, token: s(a.token), prefix: s(a.prefix) || 'Bearer', ...(a.redacted ? { redacted: true } : {}) };
  if (a.type === 'basic') return { ...base, username: s(a.username), password: s(a.password), ...(a.redacted ? { redacted: true } : {}) };
  if (a.type === 'apikey') return { ...base, in: a.in === 'query' ? 'query' : 'header', name: s(a.name), value: s(a.value), ...(a.redacted ? { redacted: true } : {}) };
  return { ...base, prefix: s(a.prefix), credential: s(a.credential), ...(a.redacted ? { redacted: true } : {}) };
}
/**
 * Compute what the Auth tab adds to a request. Values must already be variable-substituted.
 * Returns { header: {key,value}|null, url, skipped (an explicit header of that name wins), authorization (display string or null) }.
 */
export function applyAuth(auth, { url = '', headers = [] } = {}) {
  const a = normalizeAuth(auth);
  const has = name => activeRows(headers).some(r => r.key.trim().toLowerCase() === name.toLowerCase());
  let header = null, out = url;
  if (a.type === 'bearer' && a.token) header = { key: 'Authorization', value: `${a.prefix || 'Bearer'} ${a.token}` };
  else if (a.type === 'basic' && (a.username || a.password)) header = { key: 'Authorization', value: 'Basic ' + base64Utf8(`${a.username}:${a.password}`) };
  else if (a.type === 'custom' && a.credential) header = { key: 'Authorization', value: `${a.prefix ? a.prefix + ' ' : ''}${a.credential}` };
  else if (a.type === 'apikey' && a.name.trim() && a.value !== '') {
    if (a.in === 'query') {
      const h = out.indexOf('#'), base = h >= 0 ? out.slice(0, h) : out, frag = h >= 0 ? out.slice(h) : '';
      out = `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(a.name.trim())}=${encodeURIComponent(a.value)}${frag}`;
    } else header = { key: a.name.trim(), value: a.value };
  }
  const skipped = !!(header && has(header.key));
  return { header: skipped ? null : header, url: out, skipped, authorization: header && header.key.toLowerCase() === 'authorization' ? header.value : null };
}
/** Auth with secret fields blanked (for history). Variable-only values like {{token}} are not secrets and are kept. */
export function redactAuth(auth, keep = false) {
  const a = normalizeAuth(auth);
  if (keep || a.type === 'none') return a;
  let any = false;
  for (const f of AUTH_SECRET_FIELDS) if (typeof a[f] === 'string' && a[f] !== '' && !isVariableOnly(a[f])) { a[f] = ''; any = true; }
  if (any) a.redacted = true;
  return a;
}
/** True for values made only of {{variables}} (optionally after an auth scheme word): safe to store. */
export const isVariableOnly = v => /^\s*(?:(?:Bearer|Basic|Token|ApiKey|Digest)\s+)?(?:\{\{[^{}]+\}\}\s*)+$/i.test(String(v ?? ''));

/** Header names a browser refuses to set from fetch() (they are dropped silently). */
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
export const forbiddenHeaderNames = rows => [...new Set(activeRows(rows).map(r => r.key.trim()).filter(k => FORBIDDEN.test(k) || k.toLowerCase() === 'cookie'))];

/**
 * Build the fetch init pieces.
 * Returns { ok, headers (plain object), body (string|undefined), autoContentType (string|null), error? }.
 * A body is only sent for methods that allow one. JSON is validated only for the JSON body type.
 * Content-Type is added only when the user has not set one (autoContentType reports what was added).
 */
export function buildRequest({ method, headers, body, bodyType = 'json' }) {
  const h = {};
  for (const r of activeRows(headers)) {
    const k = String(r.key).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) return { ok: false, error: `Invalid header name "${k}".` };
    h[k] = String(r.value ?? '');
  }
  let payload, autoContentType = null, formFields;
  const type = BODY_TYPES.includes(bodyType) ? bodyType : 'json';
  if (type === 'multipart' && methodAllowsBody(method) && String(body ?? '').trim() !== '') {
    // The browser must generate the multipart boundary itself, so a user Content-Type is dropped.
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-type') delete h[k];
    formFields = parseFormLines(body);
    return { ok: true, headers: h, body: undefined, formFields, autoContentType: null };
  }
  if (type !== 'multipart' && methodAllowsBody(method) && String(body ?? '').trim() !== '') {
    if (type === 'json') {
      const j = parseJson(body);
      if (!j.ok) return { ok: false, error: j.error };
    }
    payload = type === 'form' ? normalizeFormBody(body) : String(body);
    if (!Object.keys(h).some(k => k.toLowerCase() === 'content-type') && DEFAULT_CT[type]) {
      h['Content-Type'] = DEFAULT_CT[type]; autoContentType = DEFAULT_CT[type];
    }
  }
  return { ok: true, headers: h, body: payload, autoContentType };
}

// ---------- response ----------
/** Content types that are safe to show as text. */
export function isTextualType(contentType = '') {
  return /^\s*text\/|application\/(json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|yaml|x-yaml|graphql|toml|sql)|\+(json|xml|yaml)\b|\b(json|xml|javascript)\b/i.test(contentType || '');
}

function textDecoderFor(contentType) {
  const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType || '');
  if (m) { try { return new TextDecoder(m[1]); } catch { /* unknown charset */ } }
  return new TextDecoder('utf-8');
}

const KNOWN_BINARY = /^\s*(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|x-tar|wasm|x-7z-compressed|vnd\.)/i;

/**
 * Turn response bytes (Uint8Array) into something displayable.
 * Returns { kind: 'text'|'binary'|'empty', size, text?, truncated }.
 * Text is limited to the first `cap` bytes (truncated: true); binary is never decoded.
 */
export function decodeResponse(bytes, contentType = '', cap = MAX_DISPLAY_BYTES) {
  const size = bytes.byteLength;
  if (size === 0) return { kind: 'empty', size, text: '', truncated: false };
  let textual = isTextualType(contentType);
  if (!textual && !KNOWN_BINARY.test(contentType || '')) {
    // Unknown or missing type: text if the leading bytes have no NULs and decode as UTF-8
    // (a multi-byte character split by the 4 KB sample edge is tolerated).
    const head = bytes.subarray(0, Math.min(size, 4096));
    textual = !head.includes(0);
    if (textual) {
      const tolerance = size > head.length ? 3 : 0;
      const dec = new TextDecoder('utf-8', { fatal: true });
      textual = false;
      for (let cut = 0; cut <= tolerance && cut < head.length; cut++) {
        try { dec.decode(head.subarray(0, head.length - cut)); textual = true; break; } catch { /* try a shorter prefix */ }
      }
    }
  }
  if (!textual) return { kind: 'binary', size, truncated: false };
  const truncated = size > cap;
  return { kind: 'text', size, text: textDecoderFor(contentType).decode(truncated ? bytes.subarray(0, cap) : bytes), truncated };
}

/** Pretty-print JSON responses, leave anything else as raw text. */
export function formatResponseBody(text, contentType = '') {
  const looksJson = /json/i.test(contentType) || /^\s*[\[{]/.test(text);
  if (looksJson) {
    try { return { text: JSON.stringify(JSON.parse(text), null, 2), isJson: true }; } catch { /* fall through */ }
  }
  return { text, isJson: false };
}

export const byteLength = text => new TextEncoder().encode(text).length;

export function statusClass(status) {
  status = Number(status);
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'info';
  if (status >= 400 && status < 500) return 'warn';
  return 'danger';
}

/** Explain a thrown fetch error in plain language. */
export function describeFetchError(err, { timedOut = false, aborted = false, url = '', timeoutSec = DEFAULT_TIMEOUT_SEC } = {}) {
  if (timedOut) return `Request timed out after ${timeoutSec} second${timeoutSec === 1 ? '' : 's'}.`;
  if (aborted || err?.name === 'AbortError') return 'Cancelled';
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err?.message || '')) {
    const mixed = /^http:/i.test(url) ? '\n• The URL is plain http:// — browsers block mixed content when this app is served over https. Try https://.' : '';
    return 'Network error — the request could not complete (the browser does not say why).\n' +
      '• Most likely a CORS block: the server must send an Access-Control-Allow-Origin header (and handle OPTIONS preflight for custom headers/methods). Browsers hide response details for blocked requests.\n' +
      '• Try a CORS-enabled API such as https://jsonplaceholder.typicode.com/todos/1.\n' +
      '• Other causes: DNS failure / wrong host, server down, you are offline, or a certificate problem.' + mixed;
  }
  return err?.message || String(err);
}

// ---------- cURL ----------
/** POSIX single-quote a string; every ' becomes '\'' . */
export const shellQuote = str => `'${String(str).replace(/'/g, `'\\''`)}'`;

/**
 * Build a copy-pasteable curl command from { method, url, headers (object or rows), body }.
 * Uses exactly the values given (live values; redaction only applies to saved history).
 */
export function toCurl({ method = 'GET', url, headers = {}, body } = {}) {
  const m = String(method || 'GET').toUpperCase();
  const parts = ['curl'];
  if (m === 'HEAD') parts.push('-I');
  else if (m !== 'GET') parts.push('-X', m);
  parts.push(shellQuote(url ?? ''));
  const pairs = Array.isArray(headers) ? activeRows(headers).map(r => [String(r.key).trim(), String(r.value ?? '')]) : Object.entries(headers || {});
  for (const [k, v] of pairs) parts.push('-H', shellQuote(`${k}: ${v}`));
  if (body !== undefined && body !== null && body !== '' && methodAllowsBody(m)) parts.push('--data-raw', shellQuote(body));
  return parts.join(' ');
}


// ---------- history ----------
const sig = e => `${e.method} ${e.url}`;

export const isSensitiveHeader = name => SENSITIVE_HEADERS.includes(String(name || '').trim().toLowerCase());

/** Rows safe to persist: sensitive values become "[redacted]" (marked redacted:true) unless keepSensitive. Variable-only values ({{token}}) are kept. */
export function redactRows(rows, keepSensitive = false) {
  return (rows || []).map(r => (!keepSensitive && isSensitiveHeader(r.key) && String(r.value ?? '') !== '' && !isVariableOnly(r.value)
    ? { ...r, value: REDACTED, redacted: true } : { ...r }));
}

/** Cap a body for storage. Returns { body, truncated }. */
export function capBody(body, max = HISTORY_BODY_MAX) {
  const s = String(body ?? '');
  return s.length > max ? { body: s.slice(0, max), truncated: true } : { body: s, truncated: false };
}

/** Build a persistable history entry (redacted headers/auth, capped body). Entries hold the template ({{vars}} unresolved), never resolved secrets. */
export function makeHistoryEntry({ method, url, body, bodyType, params, headers, status, auth }, { keepSensitive = false, now = Date.now(), id } = {}) {
  const cap = capBody(body);
  return {
    id: id || now.toString(36) + Math.random().toString(36).slice(2, 6),
    method, url, body: cap.body, bodyTruncated: cap.truncated, bodyType: bodyType || 'json',
    params: (params || []).filter(r => r.key || r.value).map(r => ({ ...r })),
    headers: redactRows((headers || []).filter(r => r.key || r.value), keepSensitive),
    auth: redactAuth(auth, keepSensitive), pinned: false,
    status: status == null ? null : Number(status), at: now,
  };
}

/** Rows for restoring a history entry: redacted values come back empty (they were never stored). */
export const restoreRows = rows => (rows || []).map(r => ({ key: r.key, value: r.redacted ? '' : (r.value ?? ''), enabled: r.enabled !== false }));

/** Sanitize history read from storage (it may be old, edited or corrupt). Status is coerced with Number(). */
export function normalizeHistory(list) {
  if (!Array.isArray(list)) return [];
  const rows = a => (Array.isArray(a) ? a.filter(r => r && typeof r === 'object').map(r => ({ key: String(r.key ?? ''), value: String(r.value ?? ''), enabled: r.enabled !== false, ...(r.redacted ? { redacted: true } : {}) })) : []);
  let pinned = 0, plain = 0;
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.url !== 'string') continue;
    const pin = e.pinned === true;
    if (pin ? pinned >= PINNED_MAX : plain >= HISTORY_MAX) continue;
    if (pin) pinned++; else plain++;
    const st = e.status == null ? null : Number(e.status);
    out.push({
      id: String(e.id ?? Math.random().toString(36).slice(2)), method: METHODS.includes(e.method) ? e.method : 'GET', url: e.url,
      body: typeof e.body === 'string' ? e.body : '', bodyTruncated: !!e.bodyTruncated, bodyType: BODY_TYPES.includes(e.bodyType) ? e.bodyType : 'json',
      params: rows(e.params), headers: rows(e.headers), auth: normalizeAuth(e.auth), pinned: pin, status: Number.isFinite(st) ? st : null, at: Number(e.at) || 0,
    });
  }
  return out;
}

/** Add an entry (newest first, deduped by method+url+body, unpinned capped; pinned entries are never evicted). */
export function addHistory(list, entry) {
  const key = x => `${sig(x)}\n${x.body || ''}`;
  const old = (list || []).find(x => key(x) === key(entry));
  const e = old?.pinned ? { ...entry, pinned: true } : entry;
  const next = [e, ...(list || []).filter(x => key(x) !== key(entry))];
  let plain = 0;
  return next.filter(x => x.pinned || ++plain <= HISTORY_MAX);
}
export const removeHistory = (list, id) => (list || []).filter(x => x.id !== id);
export const togglePin = (list, id) => (list || []).map(x => (x.id === id ? { ...x, pinned: !x.pinned } : x));
/** Remove everything except pinned entries. */
export const clearUnpinned = list => (list || []).filter(x => x.pinned);

/** Case-insensitive AND-search over method, url, body, status ("failed" matches entries without a status). */
export function searchHistory(list, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list || [];
  return (list || []).filter(h => {
    const hay = `${h.method} ${h.url} ${h.status == null ? 'failed' : h.status} ${h.body || ''}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}

/** Status filter for the history list: 'all' | 'pinned' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed'. */
export function filterHistoryByStatus(list, filter = 'all') {
  const l = list || [];
  if (filter === 'all' || !filter) return l;
  if (filter === 'pinned') return l.filter(h => h.pinned);
  if (filter === 'failed') return l.filter(h => h.status == null);
  const d = Number(String(filter)[0]);
  return l.filter(h => h.status != null && Math.floor(h.status / 100) === d);
}

// ---------- history export (always redacted) ----------
const SENSITIVE_QUERY = /token|key|secret|passw|auth|signature|^sig$|session|credential|code$/i;
const SENSITIVE_JSON = /("(?:password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|client_secret)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
/** Replace values of sensitive-looking query parameters with [redacted] (text-based, tolerant of invalid URLs). */
export function redactUrl(url) {
  const { base, query, hasQuery, hash } = splitUrl(url);
  if (!hasQuery) return String(url ?? '');
  const q = query.split('&').map(p => {
    const i = p.indexOf('=');
    if (i < 0) return p;
    const name = decodeComponent(p.slice(0, i));
    return SENSITIVE_QUERY.test(name) && !isVariableOnly(p.slice(i + 1)) && p.slice(i + 1) !== '' ? `${p.slice(0, i)}=${encodeURIComponent(REDACTED)}` : p;
  }).join('&');
  return `${base}?${q}${hash}`;
}
export const redactBody = body => String(body ?? '').replace(SENSITIVE_JSON, (_m, k) => `${k}"${REDACTED}"`);
/** JSON-serialisable history export; never contains sensitive header/auth values regardless of the "save sensitive" setting. */
export function exportHistory(list, { now = Date.now() } = {}) {
  return {
    app: 'developer-toolbox-api-client', v: 1, kind: 'history', exportedAt: new Date(now).toISOString(),
    entries: (list || []).map(h => ({
      method: h.method, url: redactUrl(h.url), status: h.status ?? null, at: h.at ? new Date(h.at).toISOString() : null, pinned: !!h.pinned,
      headers: redactRows(h.headers, false).map(r => ({ key: r.key, value: r.value, enabled: r.enabled !== false })),
      auth: redactAuth(h.auth, false), bodyType: h.bodyType, body: redactBody(h.body),
    })),
  };
}
