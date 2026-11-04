// Pure helpers for presenting responses: header/status explanations, Set-Cookie parsing, resource timing. No DOM.

export const HEADER_INFO = {
  'content-type': 'Media type (and charset) of the body. Clients use it to decide how to parse the response.',
  'content-length': 'Size of the body in bytes (of the encoded body when compressed).',
  'content-encoding': 'Compression applied to the body (gzip, br, deflate). The browser decompresses it transparently.',
  'content-disposition': 'Hints how to handle the body: show inline or download as an attachment, with a suggested filename.',
  'content-language': 'Natural language of the intended audience of the content.',
  'content-security-policy': 'Restricts which sources scripts, styles, frames and other resources may load from. A key defence against XSS.',
  'content-security-policy-report-only': 'Like Content-Security-Policy but only reports violations instead of blocking them.',
  'cache-control': 'Caching rules for browsers and proxies (max-age, no-store, no-cache, private, public, immutable...).',
  'etag': 'Opaque version identifier of the resource. Sent back as If-None-Match to get a cheap 304 Not Modified.',
  'last-modified': 'When the resource last changed. Used for conditional requests (If-Modified-Since).',
  'expires': 'Legacy absolute expiry time for caching; Cache-Control: max-age takes precedence.',
  'age': 'Seconds the response has spent in a shared cache (CDN/proxy).',
  'vary': 'Request headers that influence the response. Caches must key on them (e.g. Accept-Encoding, Origin).',
  'set-cookie': 'Asks the browser to store a cookie. Check the Secure, HttpOnly and SameSite attributes.',
  'location': 'Target URL for redirects (3xx) or the URL of a newly created resource (201).',
  'retry-after': 'How long to wait before retrying (seconds or a date), sent with 429/503/3xx.',
  'www-authenticate': 'Sent with 401: the authentication scheme(s) the server accepts (Basic, Bearer...).',
  'strict-transport-security': 'HSTS: tells browsers to use HTTPS only for this host for max-age seconds.',
  'x-content-type-options': 'nosniff stops browsers from guessing a different content type than declared.',
  'x-frame-options': 'Controls whether the page may be embedded in frames (DENY / SAMEORIGIN). Superseded by CSP frame-ancestors.',
  'x-xss-protection': 'Legacy XSS filter switch; modern browsers ignore it. Prefer a Content-Security-Policy.',
  'referrer-policy': 'How much referrer information is sent when navigating away from this resource.',
  'permissions-policy': 'Enables or disables browser features (camera, geolocation...) for the page and embedded frames.',
  'cross-origin-opener-policy': 'Isolates the browsing context group (same-origin, same-origin-allow-popups).',
  'cross-origin-embedder-policy': 'Requires cross-origin resources to opt in (CORP/CORS); needed for cross-origin isolation.',
  'cross-origin-resource-policy': 'Which origins may load this resource (same-origin, same-site, cross-origin).',
  'access-control-allow-origin': 'CORS: the origin allowed to read this response (* or one exact origin).',
  'access-control-allow-methods': 'CORS preflight answer: HTTP methods allowed for cross-origin requests.',
  'access-control-allow-headers': 'CORS preflight answer: request headers allowed for cross-origin requests.',
  'access-control-allow-credentials': 'CORS: true allows cookies/Authorization; cannot be combined with Access-Control-Allow-Origin: *.',
  'access-control-expose-headers': 'CORS: extra response headers JavaScript may read (beyond the safelisted ones).',
  'access-control-max-age': 'CORS: how long (seconds) the browser may cache the preflight result.',
  'timing-allow-origin': 'Origins allowed to see detailed Resource Timing data (DNS, connect, TLS) for this response.',
  'server': 'Software identifying the origin server. Often hidden to reduce fingerprinting.',
  'date': 'When the server generated the response.',
  'connection': 'Connection management (keep-alive / close); not used in HTTP/2+.',
  'transfer-encoding': 'How the body is framed on the wire (chunked). Handled by the browser.',
  'accept-ranges': 'Whether the server supports byte-range requests (bytes) for partial downloads.',
  'content-range': 'Which part of the resource a 206 Partial Content response contains.',
  'link': 'Typed links to other resources (preload hints, pagination rel=next/prev...).',
  'x-request-id': 'Correlation ID for tracing this request in server logs (non-standard but common).',
  'x-ratelimit-limit': 'Request quota in the current window (non-standard; some APIs use RateLimit-*).',
  'x-ratelimit-remaining': 'Requests left in the current window.',
  'x-ratelimit-reset': 'When the rate-limit window resets (epoch seconds or seconds remaining, depends on the API).',
  'allow': 'Methods the resource supports; sent with 405 and OPTIONS responses.',
  'alt-svc': 'Advertises alternative endpoints (e.g. HTTP/3) for this origin.',
  'nel': 'Network Error Logging policy: where browsers report network failures.',
  'report-to': 'Reporting endpoint group definition used by CSP/NEL reports.',
  'via': 'Proxies/gateways the response passed through.',
  'x-powered-by': 'Technology disclosed by the server (e.g. Express). Better removed.',
};
export const explainHeader = name => HEADER_INFO[String(name || '').trim().toLowerCase()] || null;

const STATUS_INFO = {
  100: 'Continue: the server received the headers; the client may send the body.',
  101: 'Switching Protocols: the connection is upgrading (for example to WebSocket).',
  200: 'OK: the request succeeded.', 201: 'Created: a new resource was created (see Location).', 202: 'Accepted: processing was queued, not finished yet.',
  204: 'No Content: success with an empty body.', 206: 'Partial Content: a byte range of the resource was returned.',
  301: 'Moved Permanently: the resource has a new URL; clients should update links.', 302: 'Found: temporary redirect.', 303: 'See Other: fetch the result from another URL with GET.',
  304: 'Not Modified: your cached copy is still valid.', 307: 'Temporary Redirect: repeat the same request (same method) at another URL.', 308: 'Permanent Redirect: like 301 but the method is preserved.',
  400: 'Bad Request: the server could not understand the request (malformed syntax or invalid data).', 401: 'Unauthorized: authentication is missing or invalid.', 403: 'Forbidden: you are authenticated but not allowed.',
  404: 'Not Found: no resource at this URL.', 405: 'Method Not Allowed: the resource does not support this method (see Allow).', 406: 'Not Acceptable: the server cannot produce a response matching the Accept headers.',
  408: 'Request Timeout: the server gave up waiting for the request.', 409: 'Conflict: the request conflicts with the current state of the resource.', 410: 'Gone: the resource was permanently removed.',
  413: 'Payload Too Large: the request body exceeds the server limit.', 415: 'Unsupported Media Type: the Content-Type of the body is not accepted.', 418: "I'm a teapot: an April Fools' status; some APIs use it for blocked bots.",
  422: 'Unprocessable Content: the body is well-formed but semantically invalid (validation errors).', 429: 'Too Many Requests: rate limit hit; see Retry-After.',
  500: 'Internal Server Error: the server failed unexpectedly.', 501: 'Not Implemented: the server does not support this functionality.', 502: 'Bad Gateway: an upstream server returned an invalid response.',
  503: 'Service Unavailable: overloaded or down for maintenance; see Retry-After.', 504: 'Gateway Timeout: an upstream server did not answer in time.',
};
/** One-sentence explanation of an HTTP status code (falls back to the class). status 0 = opaque / unavailable. */
export function statusExplain(status) {
  const s = Number(status);
  if (s === 0) return 'Opaque response: the browser hides status and headers (no-cors request or a manual redirect).';
  if (STATUS_INFO[s]) return STATUS_INFO[s];
  if (s >= 100 && s < 200) return 'Informational response.';
  if (s >= 200 && s < 300) return 'Success.';
  if (s >= 300 && s < 400) return 'Redirection: further action is needed to complete the request.';
  if (s >= 400 && s < 500) return 'Client error: the request has a problem.';
  if (s >= 500 && s < 600) return 'Server error: the server failed to fulfil a valid request.';
  return 'Unknown status code.';
}

// ---------- cookies ----------
/** Split a combined Set-Cookie header string into individual cookies (commas inside Expires are respected). */
export function splitSetCookie(value) {
  const s = String(value ?? '');
  if (!s.trim()) return [];
  return s.split(/,(?=\s*[^;,=\s]+=)/).map(x => x.trim()).filter(Boolean);
}
/** Parse one Set-Cookie value. */
export function parseSetCookie(raw) {
  const parts = String(raw).split(';');
  const first = parts.shift() || '';
  const eq = first.indexOf('=');
  const c = { name: (eq >= 0 ? first.slice(0, eq) : first).trim(), value: eq >= 0 ? first.slice(eq + 1).trim() : '', domain: '', path: '', expires: '', maxAge: null, secure: false, httpOnly: false, sameSite: '', partitioned: false, raw: String(raw) };
  for (const p of parts) {
    const i = p.indexOf('=');
    const k = (i >= 0 ? p.slice(0, i) : p).trim().toLowerCase(), v = i >= 0 ? p.slice(i + 1).trim() : '';
    if (k === 'domain') c.domain = v; else if (k === 'path') c.path = v; else if (k === 'expires') c.expires = v;
    else if (k === 'max-age') { const n = Number(v); c.maxAge = Number.isFinite(n) ? n : null; }
    else if (k === 'secure') c.secure = true; else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'samesite') c.sameSite = v.toLowerCase(); else if (k === 'partitioned') c.partitioned = true;
  }
  return c;
}
/** Security observations about a cookie. level: 'bad' | 'warn' | 'info'. */
export function cookieIssues(c, { https = true } = {}) {
  const out = [];
  if (!c.secure) out.push({ level: https ? 'bad' : 'warn', text: 'Missing Secure: the cookie can be sent over plain HTTP.' });
  if (!c.httpOnly) out.push({ level: 'warn', text: 'Missing HttpOnly: JavaScript (and any XSS) can read this cookie.' });
  if (!c.sameSite) out.push({ level: 'warn', text: 'No SameSite attribute: browsers default to Lax; set it explicitly.' });
  else if (c.sameSite === 'none' && !c.secure) out.push({ level: 'bad', text: 'SameSite=None requires Secure; browsers reject this cookie.' });
  else if (c.sameSite === 'none') out.push({ level: 'info', text: 'SameSite=None: sent on cross-site requests (needed for third-party use; CSRF-sensitive).' });
  if (/^__Host-/i.test(c.name) && (!c.secure || c.path !== '/' || c.domain)) out.push({ level: 'bad', text: '__Host- prefix requires Secure, Path=/ and no Domain.' });
  if (/^__Secure-/i.test(c.name) && !c.secure) out.push({ level: 'bad', text: '__Secure- prefix requires the Secure attribute.' });
  if (c.maxAge != null && c.maxAge > 400 * 86400) out.push({ level: 'info', text: 'Lifetime longer than 400 days is capped by modern browsers.' });
  return out;
}

// ---------- timing ----------
/** Pick the Resource Timing entry for a request started at t0 (performance.now() time base). */
export function pickTimingEntry(entries, t0) {
  const list = (entries || []).filter(e => e && e.startTime >= t0 - 5);
  return list.length ? list[list.length - 1] : null;
}
/**
 * Break a PerformanceResourceTiming-like entry into phases.
 * available=false when the browser zeroed the detail (cross-origin without Timing-Allow-Origin).
 */
export function computeTiming(e) {
  const NOTE = 'Not exposed for cross-origin responses (the server must send Timing-Allow-Origin).';
  if (!e) return { available: false, phases: [], total: null, note: NOTE };
  const n = v => (Number.isFinite(v) ? v : 0);
  const exposed = n(e.requestStart) > 0 && n(e.responseStart) > 0;
  const total = n(e.duration) || Math.max(0, n(e.responseEnd) - n(e.startTime));
  if (!exposed) return { available: false, phases: [], total, note: NOTE };
  const dns = Math.max(0, n(e.domainLookupEnd) - n(e.domainLookupStart));
  const tls = n(e.secureConnectionStart) > 0 ? Math.max(0, n(e.connectEnd) - n(e.secureConnectionStart)) : 0;
  const connect = Math.max(0, n(e.connectEnd) - n(e.connectStart) - tls);
  const request = Math.max(0, n(e.responseStart) - n(e.requestStart));
  const response = Math.max(0, n(e.responseEnd) - n(e.responseStart));
  const redirect = Math.max(0, n(e.redirectEnd) - n(e.redirectStart));
  const phases = [['Redirect', redirect], ['DNS lookup', dns], ['TCP connect', connect], ['TLS handshake', tls], ['Request sent + waiting (TTFB)', request], ['Response download', response]].map(([name, ms]) => ({ name, ms }));
  const reused = dns === 0 && connect === 0 && tls === 0;
  return { available: true, phases, total, note: reused ? 'DNS / connect / TLS are 0 ms: an existing connection was reused (or the lookup was cached).' : '' };
}

export const REDIRECT_NOTE = 'Browsers do not expose redirect hops to web pages. "Follow" (default) returns only the final response. "Manual" returns an opaque-redirect response (status 0, no headers or body) as soon as a redirect happens, which at least tells you one occurred.';
