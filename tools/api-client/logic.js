// Pure helpers for the API client (no DOM access).

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const HISTORY_MAX = 25;

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
 * Merge enabled query-param rows into the URL's existing query string.
 * Params already in the URL are preserved; table rows are appended.
 */
export function buildUrl(raw, params) {
  const v = validateUrl(raw);
  if (!v.ok) return v;
  const u = v.url;
  for (const r of activeRows(params)) u.searchParams.append(String(r.key).trim(), String(r.value ?? ''));
  return { ok: true, url: u.toString() };
}

/** Parse the query string of a URL into rows (used to restore history / sync). */
export function paramsFromUrl(raw) {
  try { return [...new URL(raw).searchParams].map(([key, value]) => ({ key, value, enabled: true })); } catch { return []; }
}

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

/**
 * Build the fetch init pieces.
 * Returns { ok, headers (plain object), body (string|undefined), error? }.
 * Content-Type: application/json is added when a body exists and no Content-Type was given.
 */
export function buildRequest({ method, headers, body }) {
  const h = {};
  for (const r of activeRows(headers)) {
    const k = String(r.key).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) return { ok: false, error: `Invalid header name "${k}".` };
    h[k] = String(r.value ?? '');
  }
  let payload;
  if (method !== 'GET' && String(body ?? '').trim() !== '') {
    const j = parseJson(body);
    if (!j.ok) return { ok: false, error: j.error };
    payload = body;
    if (!Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
  }
  return { ok: true, headers: h, body: payload };
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
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'info';
  if (status >= 400 && status < 500) return 'warn';
  return 'danger';
}

/** Explain a thrown fetch error in plain language. */
export function describeFetchError(err, { timedOut = false, aborted = false, url = '' } = {}) {
  if (timedOut) return 'Request timed out after 30 seconds.';
  if (aborted) return 'Request cancelled.';
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err?.message || '')) {
    const mixed = /^http:/i.test(url) ? '\n• The URL is plain http:// — browsers block mixed content when this app is served over https. Try https://.' : '';
    return 'Network error — the request could not complete (the browser does not say why).\n' +
      '• Most likely a CORS block: the server must send an Access-Control-Allow-Origin header (and handle OPTIONS preflight for custom headers/methods). Browsers hide response details for blocked requests.\n' +
      '• Try a CORS-enabled API such as https://jsonplaceholder.typicode.com/todos/1.\n' +
      '• Other causes: DNS failure / wrong host, server down, you are offline, or a certificate problem.' + mixed;
  }
  return err?.message || String(err);
}

// ---------- history ----------
const sig = e => `${e.method} ${e.url}`;

/** Add an entry (newest first, deduped by method+url+body, capped). */
export function addHistory(list, entry) {
  const key = x => `${sig(x)}\n${x.body || ''}`;
  const next = [entry, ...(list || []).filter(x => key(x) !== key(entry))];
  return next.slice(0, HISTORY_MAX);
}
export const removeHistory = (list, id) => (list || []).filter(x => x.id !== id);
