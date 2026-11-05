// HTTP Header Analyzer - pure logic (no DOM): parser, value explainers, cross checks, security review, reports.
import { HEADER_DB, HEADER_COUNT, lookupHeader } from './headers-db.js';
export { HEADER_DB, HEADER_COUNT, lookupHeader };

export const LIMITS = { bytes: 1_000_000, headers: 500 };
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const issue = (level, code, message, extra = {}) => ({ level, code, message, ...extra });

// ---------------------------------------------------------------- generic helpers
/** Split on `sep` outside of quoted strings, <angle> brackets and (parens). */
export function splitTop(s, sep = ',') {
  const out = []; let cur = '', q = false, angle = 0, paren = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === '\\' && i + 1 < s.length) cur += s[++i]; else if (ch === '"') q = false; continue; }
    if (ch === '"') { q = true; cur += ch; continue; }
    if (ch === '<') angle++; else if (ch === '>' && angle) angle--;
    if (ch === '(') paren++; else if (ch === ')' && paren) paren--;
    if (ch === sep && !angle && !paren) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(x => x !== '');
}
const unquote = v => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);
/** "a=1; b="x y"; c" -> [{key:'a', value:'1'}, ...] (keys lower-cased). */
export function parseParams(parts) {
  return parts.map(p => {
    const i = p.indexOf('=');
    return i < 0 ? { key: p.trim().toLowerCase(), value: null } : { key: p.slice(0, i).trim().toLowerCase(), value: unquote(p.slice(i + 1).trim()) };
  });
}
export function humanSeconds(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 60) return `${n} second${n === 1 ? '' : 's'}`;
  const units = [['year', 31536000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const parts = [];
  let rest = n;
  for (const [u, s] of units) { const c = Math.floor(rest / s); if (c) { parts.push(`${c} ${u}${c === 1 ? '' : 's'}`); rest -= c * s; } if (parts.length === 2) break; }
  return parts.join(' ');
}
const D = (label, value, note) => ({ label, value, ...(note ? { note } : {}) });
const result = (summary, details = [], issues = []) => ({ summary, details, issues });

// ---------------------------------------------------------------- HTTP dates
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Returns { format: 'imf'|'rfc850'|'asctime', date: Date, weekdayOk } or null. */
export function parseHttpDate(value) {
  const v = String(value).trim();
  let m, fmt, y, mo, d, h, mi, s, wd;
  if ((m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(v))) {
    fmt = 'imf'; wd = DAYS.indexOf(m[1]); d = +m[2]; mo = MONTHS.indexOf(m[3]); y = +m[4]; h = +m[5]; mi = +m[6]; s = +m[7];
  } else if ((m = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(v))) {
    fmt = 'rfc850'; wd = DAYS_LONG.indexOf(m[1]); d = +m[2]; mo = MONTHS.indexOf(m[3]); y = +m[4]; y += y < 70 ? 2000 : 1900; h = +m[5]; mi = +m[6]; s = +m[7];
  } else if ((m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(v))) {
    fmt = 'asctime'; wd = DAYS.indexOf(m[1]); mo = MONTHS.indexOf(m[2]); d = +m[3]; h = +m[4]; mi = +m[5]; s = +m[6]; y = +m[7];
  } else return null;
  const date = new Date(Date.UTC(y, mo, d, h, mi, s));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 60) return null;
  return { format: fmt, date, weekdayOk: date.getUTCDay() === wd };
}
function relTime(date, now) {
  const diff = Math.round((date.getTime() - now) / 1000);
  return diff >= 0 ? `in ${humanSeconds(diff)}` : `${humanSeconds(-diff)} ago`;
}

// ---------------------------------------------------------------- Cache-Control
const CC = {
  'max-age': ['both', 'seconds', 'Response is fresh for this many seconds (request: client accepts responses no older than this).'],
  's-maxage': ['res', 'seconds', 'Like max-age but only for shared caches (CDNs, proxies); overrides max-age and Expires there.'],
  'no-cache': ['both', 'fields', 'May be stored, but must be revalidated with the origin before every reuse.'],
  'no-store': ['both', null, 'Caches must not store any part of the request or response.'],
  'no-transform': ['both', null, 'Intermediaries must not alter the body (no re-compression, image optimisation).'],
  'must-revalidate': ['res', null, 'Once stale, a cache must revalidate and must not serve it stale (even when disconnected).'],
  'proxy-revalidate': ['res', null, 'Like must-revalidate, but for shared caches only.'],
  'must-understand': ['res', null, 'Cache only if it understands the status code semantics; otherwise treat as no-store.'],
  private: ['res', 'fields', 'Only the end user\'s private cache (browser) may store it; shared caches must not.'],
  public: ['res', null, 'Any cache may store it, even if it would normally not be cacheable (for example with Authorization).'],
  immutable: ['res', null, 'The response will never change while fresh: browsers skip revalidation on reload.'],
  'stale-while-revalidate': ['res', 'seconds', 'May serve a stale response for this many seconds while revalidating in the background.'],
  'stale-if-error': ['both', 'seconds', 'May serve a stale response for this many seconds if the origin errors.'],
  'max-stale': ['req', 'optional-seconds', 'Client accepts a stale response (optionally up to this many seconds stale).'],
  'min-fresh': ['req', 'seconds', 'Client wants a response that stays fresh for at least this many more seconds.'],
  'only-if-cached': ['req', null, 'Client only wants a cached response; reply 504 if none.'],
};
export function parseCacheControl(value, kind = 'response') {
  const issues = [], directives = [];
  const parts = splitTop(String(value));
  if (!parts.length) return { directives, issues: [issue('error', 'cc-empty', 'Cache-Control is empty.')], map: {} };
  const map = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    const name = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    const arg = i < 0 ? null : unquote(p.slice(i + 1).trim());
    const def = CC[name];
    const d = { name, arg, meaning: def ? def[2] : 'Unknown or extension directive (ignored by caches that do not understand it).' };
    if (!def) issues.push(issue('info', 'cc-unknown', `Unknown directive "${name}" (extension or typo).`));
    else {
      if (def[1] === 'seconds' && (arg == null || !/^\d+$/.test(arg))) issues.push(issue('error', 'cc-bad-number', `${name} needs a non-negative integer number of seconds${arg != null ? ` (got "${arg}")` : ''}.`));
      if (def[1] === 'optional-seconds' && arg != null && !/^\d+$/.test(arg)) issues.push(issue('error', 'cc-bad-number', `${name} takes an optional integer (got "${arg}").`));
      if (!def[1] && arg != null) issues.push(issue('warn', 'cc-unexpected-arg', `${name} does not take a value.`));
      if (kind === 'response' && def[0] === 'req') issues.push(issue('info', 'cc-wrong-direction', `${name} is a request directive and is ignored in a response.`));
      if (kind === 'request' && def[0] === 'res') issues.push(issue('info', 'cc-wrong-direction', `${name} is a response directive and is ignored in a request.`));
      if (arg != null && p.slice(p.indexOf('=') + 1).trim().startsWith('"') && def[1] && def[1].includes('seconds')) issues.push(issue('info', 'cc-quoted-number', `${name} should not quote its number.`));
    }
    if (map[name] !== undefined) issues.push(issue('warn', 'cc-duplicate', `Directive "${name}" appears more than once; caches may use either value.`));
    else map[name] = arg == null ? true : arg;
    directives.push(d);
  }
  const num = k => (typeof map[k] === 'string' && /^\d+$/.test(map[k]) ? parseInt(map[k], 10) : null);
  if (map.public && map.private) issues.push(issue('warn', 'cc-conflict', 'public and private contradict each other.'));
  if (map['no-store']) {
    const pointless = ['public', 'max-age', 's-maxage', 'immutable', 'stale-while-revalidate', 'stale-if-error', 'must-revalidate'].filter(k => map[k] !== undefined && !(k === 'max-age' && num(k) === 0));
    if (pointless.length) issues.push(issue('warn', 'cc-conflict', `no-store forbids storing, so ${pointless.join(', ')} ${pointless.length > 1 ? 'have' : 'has'} no effect (contradictory).`));
    if (map['no-cache']) issues.push(issue('info', 'cc-redundant', 'no-cache is redundant next to no-store.'));
  }
  if (map['no-cache'] && !map['no-store'] && num('max-age') > 0) issues.push(issue('info', 'cc-moot', 'max-age is moot here: no-cache forces revalidation before every reuse.'));
  if (num('max-age') === 0 && map.immutable) issues.push(issue('warn', 'cc-conflict', 'immutable with max-age=0 is contradictory.'));
  if (map.immutable && num('max-age') === null && num('s-maxage') === null) issues.push(issue('info', 'cc-immutable-no-age', 'immutable has no effect without a max-age.'));
  if (map.private && map['s-maxage'] !== undefined) issues.push(issue('warn', 'cc-conflict', 's-maxage is for shared caches, but private forbids them from storing the response.'));
  if (num('max-age') > 31536000 || num('s-maxage') > 31536000) issues.push(issue('info', 'cc-too-long', 'Lifetimes above one year (31536000 s) are not meaningful; caches may cap them.'));
  if (map['must-revalidate'] && map['stale-while-revalidate'] !== undefined) issues.push(issue('info', 'cc-swr-mr', 'must-revalidate prevents serving stale content, which weakens stale-while-revalidate.'));
  return { directives, issues, map, maxAge: num('max-age'), sMaxAge: num('s-maxage') };
}
function explainCacheControl(v, ctx) {
  const p = parseCacheControl(v, ctx.kind === 'request' ? 'request' : 'response');
  let summary = 'Caching directives.';
  if (p.map['no-store']) summary = 'Not stored by any cache.';
  else if (p.map['no-cache']) summary = 'Stored but revalidated on every use.';
  else if (p.map.private) summary = `Browser (private) cache only${p.maxAge != null ? `, fresh for ${humanSeconds(p.maxAge)}` : ''}.`;
  else if (p.maxAge != null) summary = `Cacheable, fresh for ${humanSeconds(p.maxAge)}${p.map.public ? ' (public)' : ''}${p.sMaxAge != null ? `; shared caches ${humanSeconds(p.sMaxAge)}` : ''}.`;
  return result(summary, p.directives.map(d => D(d.name + (d.arg != null ? `=${d.arg}` : ''), d.meaning)), p.issues);
}

// ---------------------------------------------------------------- Content-Type
export function parseContentType(value) {
  const parts = splitTop(String(value), ';');
  const mt = (parts.shift() || '').toLowerCase();
  const m = /^([a-z0-9!#$&^_.+-]+)\/([a-z0-9!#$&^_.+*-]+)$/.exec(mt);
  const params = parseParams(parts);
  const get = k => params.find(p => p.key === k)?.value ?? null;
  return { valid: !!m, mediaType: mt, type: m?.[1] || '', subtype: m?.[2] || '', params, charset: get('charset'), boundary: get('boundary') };
}
function explainContentType(v) {
  const p = parseContentType(v), issues = [], details = [];
  if (!p.valid) { issues.push(issue('error', 'ct-invalid', `"${p.mediaType.slice(0, 60)}" is not a valid type/subtype media type.`)); return result('Invalid media type.', details, issues); }
  details.push(D('Media type', p.mediaType));
  if (p.charset) details.push(D('charset', p.charset, 'Character encoding of text content.'));
  if (p.boundary) details.push(D('boundary', p.boundary, 'Separator between parts of a multipart body.'));
  for (const q of p.params) if (!['charset', 'boundary'].includes(q.key)) details.push(D(q.key, q.value ?? ''));
  if (p.type === 'multipart' && !p.boundary) issues.push(issue('error', 'ct-no-boundary', 'multipart/* requires a boundary parameter.'));
  if (p.boundary && p.type !== 'multipart') issues.push(issue('info', 'ct-boundary', 'boundary is only meaningful for multipart types.'));
  if (p.type === 'text' && !p.charset) issues.push(issue('info', 'ct-no-charset', 'text/* without charset: the client guesses the encoding; add charset=utf-8.'));
  if (p.charset && /^(application\/json|application\/.*\+json)$/.test(p.mediaType)) issues.push(issue('info', 'ct-json-charset', 'JSON is always UTF-8; the charset parameter is unnecessary.'));
  if (p.charset && !/^[a-z0-9._:-]+$/i.test(p.charset)) issues.push(issue('warn', 'ct-charset', `Unusual charset value "${p.charset}".`));
  if (p.type === 'text' && p.subtype === 'javascript' ) { /* fine */ }
  if (p.mediaType === 'application/x-javascript' || p.mediaType === 'text/x-javascript') issues.push(issue('info', 'ct-legacy', 'Legacy JavaScript media type; use text/javascript.'));
  return result(`${p.mediaType}${p.charset ? `, ${p.charset}` : ''}`, details, issues);
}

// ---------------------------------------------------------------- Cookies
const COOKIE_NAME_BAD = /[\s\x00-\x1f\x7f()<>@,;:\\"/[\]?={}]/;
export function parseSetCookie(value) {
  const issues = [];
  const segs = String(value).split(';');
  const pair = segs.shift().trim();
  const eq = pair.indexOf('=');
  const out = { name: '', valueLength: 0, attrs: {}, issues, valid: true };
  if (eq < 0) { out.valid = false; issues.push(issue('error', 'cookie-no-equals', 'The cookie-pair has no "=": browsers ignore this cookie.')); out.name = pair; return out; }
  out.name = pair.slice(0, eq).trim(); out.valueLength = pair.length - eq - 1;
  if (!out.name) { out.valid = false; issues.push(issue('error', 'cookie-empty-name', 'Cookie name is empty.')); }
  else if (COOKIE_NAME_BAD.test(out.name)) issues.push(issue('warn', 'cookie-bad-name', `Cookie name "${out.name}" contains characters that are not allowed in a token.`));
  const A = out.attrs;
  for (const s of segs) {
    const t = s.trim(); if (!t) continue;
    const i = t.indexOf('=');
    const k = (i < 0 ? t : t.slice(0, i)).trim().toLowerCase(), v = i < 0 ? null : t.slice(i + 1).trim();
    switch (k) {
      case 'secure': A.secure = true; break;
      case 'httponly': A.httponly = true; break;
      case 'partitioned': A.partitioned = true; break;
      case 'samesite': A.samesite = v; break;
      case 'domain': A.domain = v; break;
      case 'path': A.path = v; break;
      case 'max-age': A.maxAge = v; break;
      case 'expires': A.expires = v; break;
      case 'priority': A.priority = v; break;
      default: (A.other ||= []).push(k);
    }
  }
  const lname = out.name.toLowerCase();
  if (A.samesite != null) {
    const ss = A.samesite.toLowerCase();
    if (!['strict', 'lax', 'none'].includes(ss)) issues.push(issue('warn', 'cookie-samesite-invalid', `SameSite="${A.samesite}" is invalid (use Strict, Lax or None); browsers treat it as the default.`));
    if (ss === 'none' && !A.secure) issues.push(issue('error', 'cookie-none-no-secure', 'SameSite=None requires Secure; browsers reject the cookie otherwise.'));
  } else issues.push(issue('info', 'cookie-no-samesite', 'No SameSite attribute: modern browsers default to Lax.'));
  if (!A.secure) issues.push(issue('warn', 'cookie-no-secure', 'Not marked Secure: the cookie can be sent over plain HTTP.'));
  if (!A.httponly) issues.push(issue('warn', 'cookie-no-httponly', 'Not marked HttpOnly: JavaScript can read it (XSS can steal it). Fine only for cookies scripts must read.'));
  if (A.partitioned && !A.secure) issues.push(issue('error', 'cookie-partitioned-no-secure', 'Partitioned cookies must be Secure.'));
  if (lname.startsWith('__secure-') && !A.secure) issues.push(issue('error', 'cookie-prefix-secure', '__Secure- prefix requires the Secure attribute.'));
  if (lname.startsWith('__host-')) {
    if (!A.secure) issues.push(issue('error', 'cookie-prefix-host', '__Host- prefix requires the Secure attribute.'));
    if (A.domain != null) issues.push(issue('error', 'cookie-prefix-host', '__Host- prefix forbids the Domain attribute (host-only cookie).'));
    if (A.path !== '/') issues.push(issue('error', 'cookie-prefix-host', '__Host- prefix requires Path=/.'));
  }
  if (A.maxAge != null && !/^-?\d+$/.test(A.maxAge)) issues.push(issue('warn', 'cookie-maxage-invalid', `Max-Age="${A.maxAge}" is not an integer; it is ignored.`));
  else if (A.maxAge != null && parseInt(A.maxAge, 10) <= 0) issues.push(issue('info', 'cookie-delete', 'Max-Age of 0 or less deletes the cookie.'));
  else if (A.maxAge != null && parseInt(A.maxAge, 10) > 34560000) issues.push(issue('info', 'cookie-long', 'Browsers cap cookie lifetime at about 400 days.'));
  if (A.expires != null && Number.isNaN(Date.parse(A.expires))) issues.push(issue('warn', 'cookie-expires-invalid', `Expires="${A.expires}" is not a valid date; it is ignored.`));
  if (A.expires != null && A.maxAge != null) issues.push(issue('info', 'cookie-both-expiry', 'Both Expires and Max-Age are set; Max-Age takes precedence.'));
  if (A.path != null && !A.path.startsWith('/')) issues.push(issue('warn', 'cookie-path-invalid', 'Path must start with "/"; otherwise the default path is used.'));
  if (A.domain && A.domain.startsWith('.')) issues.push(issue('info', 'cookie-domain-dot', 'Leading dot in Domain is ignored; the cookie is sent to subdomains whenever Domain is set.'));
  if (A.domain === '') issues.push(issue('info', 'cookie-domain-empty', 'Empty Domain is ignored.'));
  if (A.priority != null && !['low', 'medium', 'high'].includes(A.priority.toLowerCase())) issues.push(issue('warn', 'cookie-priority-invalid', 'Priority must be Low, Medium or High.'));
  if (A.other?.length) issues.push(issue('info', 'cookie-unknown-attr', `Unknown attribute(s) ignored: ${[...new Set(A.other)].join(', ')}.`));
  if (out.name.length + out.valueLength > 4096) issues.push(issue('warn', 'cookie-too-large', 'Name plus value exceeds 4096 bytes; browsers drop larger cookies.'));
  return out;
}
function explainSetCookie(v) {
  const c = parseSetCookie(v);
  const A = c.attrs, d = [D('Name', c.name || '(none)'), D('Value', `${c.valueLength} characters (hidden)`)];
  if (A.domain != null) d.push(D('Domain', A.domain, 'Hosts that receive the cookie.'));
  d.push(D('Path', A.path ?? '(default: directory of the request URL)'));
  if (A.expires != null) d.push(D('Expires', A.expires));
  if (A.maxAge != null) d.push(D('Max-Age', `${A.maxAge}${/^-?\d+$/.test(A.maxAge) && +A.maxAge > 0 ? ` (${humanSeconds(+A.maxAge)})` : ''}`));
  d.push(D('Secure', A.secure ? 'yes' : 'no', 'Only sent over HTTPS.'), D('HttpOnly', A.httponly ? 'yes' : 'no', 'Hidden from document.cookie.'),
    D('SameSite', A.samesite ?? '(not set: Lax by default)', 'When the cookie is sent on cross-site requests.'));
  if (A.partitioned) d.push(D('Partitioned', 'yes', 'CHIPS: separate cookie jar per top-level site.'));
  return result(`Sets cookie "${c.name}"${A.maxAge == null && A.expires == null ? ' (session cookie)' : ''}.`, d, c.issues);
}
export function parseCookieHeader(value) {
  const issues = [], pairs = [];
  for (const part of String(value).split(';')) {
    const t = part.trim(); if (!t) continue;
    const i = t.indexOf('=');
    if (i < 0) { issues.push(issue('warn', 'cookie-pair-no-equals', `"${t.slice(0, 30)}" has no "=".`)); continue; }
    pairs.push({ name: t.slice(0, i).trim(), valueLength: t.length - i - 1 });
  }
  const seen = new Set();
  for (const p of pairs) { if (seen.has(p.name)) issues.push(issue('warn', 'cookie-duplicate', `Cookie "${p.name}" is sent more than once (different paths or domains).`)); seen.add(p.name); }
  if (String(value).length > 8000) issues.push(issue('warn', 'cookie-header-large', 'The Cookie header is very large; many servers reject headers above 8 KB.'));
  if (!pairs.length) issues.push(issue('error', 'cookie-empty', 'No cookie pairs found.'));
  return { pairs, issues };
}
function explainCookie(v) {
  const p = parseCookieHeader(v);
  return result(`${p.pairs.length} cookie${p.pairs.length === 1 ? '' : 's'} sent.`, p.pairs.map(c => D(c.name, `${c.valueLength} characters (hidden)`)), p.issues);
}

// ---------------------------------------------------------------- CORS
function explainCors(lower, v, ctx) {
  const t = v.trim(), issues = [];
  switch (lower) {
    case 'access-control-allow-origin': {
      let s;
      if (t === '*') s = 'Any origin may read this response (no credentials).';
      else if (t === 'null') { s = 'The "null" origin is allowed.'; issues.push(issue('warn', 'cors-null', '"null" origin is sent by sandboxed iframes and file:// pages; allowing it is risky.')); }
      else if (/^https?:\/\/[^/\s]+$/i.test(t)) s = `Only ${t} may read this response.`;
      else if (t.includes(',') || /\s/.test(t)) { s = 'Invalid value.'; issues.push(issue('error', 'cors-origin-multi', 'Only one origin (or * or null) is allowed; use server logic to echo the matching Origin.')); }
      else { s = 'Invalid value.'; issues.push(issue('error', 'cors-origin-invalid', 'Must be an origin (scheme://host[:port], no path or trailing slash), *, or null.')); }
      return result(s, [D('Value', t)], issues);
    }
    case 'access-control-allow-credentials':
      if (t !== 'true') issues.push(issue('error', 'cors-credentials-invalid', 'The only valid value is the exact, case-sensitive string "true"; omit the header otherwise.'));
      return result(t === 'true' ? 'Cross-origin requests may include credentials.' : 'Invalid value.', [], issues);
    case 'access-control-allow-headers': case 'access-control-allow-methods': case 'access-control-expose-headers': case 'access-control-request-headers': {
      const items = splitTop(t);
      if (!items.length) issues.push(issue('error', 'cors-empty', 'Empty list.'));
      if (items.includes('*') && items.length > 1) issues.push(issue('warn', 'cors-wildcard-mix', '"*" should stand alone.'));
      if (lower.endsWith('methods') || lower === 'access-control-allow-methods') for (const m of items) if (m !== '*' && !TOKEN.test(m)) issues.push(issue('error', 'cors-method-invalid', `"${m}" is not a valid method token.`));
      if (lower === 'access-control-allow-headers' || lower === 'access-control-expose-headers' || lower === 'access-control-request-headers') for (const h of items) if (h !== '*' && !TOKEN.test(h)) issues.push(issue('error', 'cors-header-invalid', `"${h}" is not a valid header name.`));
      if (items.includes('*')) issues.push(issue('info', 'cors-wildcard-credentials', '"*" is treated as a literal name when the request includes credentials.'));
      return result(items.join(', '), items.map(i => D(i, '')), issues);
    }
    case 'access-control-max-age':
      if (!/^-?\d+$/.test(t)) issues.push(issue('error', 'cors-maxage-invalid', 'Must be an integer number of seconds.'));
      else if (+t > 86400) issues.push(issue('info', 'cors-maxage-cap', 'Browsers cap preflight caching (Chrome 2 hours, Firefox 24 hours).'));
      return result(/^\d+$/.test(t) ? `Preflight cached for ${humanSeconds(+t)}.` : 'Invalid value.', [], issues);
    default: return null;
  }
}

// ---------------------------------------------------------------- Content-Security-Policy
const CSP_DIRECTIVES = {
  'default-src': 'Fallback for the other fetch directives.', 'script-src': 'Valid sources for JavaScript.', 'script-src-elem': 'Sources for <script> elements.', 'script-src-attr': 'Sources for inline event handlers.',
  'style-src': 'Valid sources for stylesheets.', 'style-src-elem': 'Sources for <style> and <link rel=stylesheet>.', 'style-src-attr': 'Sources for style attributes.', 'img-src': 'Sources for images.',
  'font-src': 'Sources for fonts.', 'connect-src': 'Targets for fetch, XHR, WebSocket, EventSource.', 'media-src': 'Sources for audio and video.', 'object-src': 'Sources for <object>, <embed> and <applet> plugins.',
  'frame-src': 'Sources for <iframe> and <frame>.', 'child-src': 'Sources for workers and nested browsing contexts.', 'worker-src': 'Sources for Worker, SharedWorker and ServiceWorker.', 'manifest-src': 'Sources for web app manifests.',
  'prefetch-src': 'Sources for prefetch/prerender (deprecated).', 'base-uri': 'Allowed URLs for <base>.', 'form-action': 'Allowed targets for form submissions.', 'frame-ancestors': 'Which parents may embed this page (replaces X-Frame-Options).',
  sandbox: 'Applies an iframe-style sandbox to the document.', 'report-uri': 'URL to POST violation reports to (deprecated: use report-to).', 'report-to': 'Reporting group that receives violation reports.',
  'upgrade-insecure-requests': 'Rewrites http:// subresource URLs to https://.', 'block-all-mixed-content': 'Blocks mixed content (deprecated; browsers now auto-upgrade).',
  'require-trusted-types-for': 'Enforces Trusted Types for DOM XSS sinks.', 'trusted-types': 'Allowed Trusted Types policy names.', 'plugin-types': 'Allowed plugin MIME types (removed).', referrer: 'Referrer policy (removed; use Referrer-Policy).',
  'navigate-to': 'Restricts navigation targets (removed from the spec).',
};
const CSP_FETCH = ['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr', 'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src', 'prefetch-src'];
const CSP_KEYWORDS = ['self', 'none', 'unsafe-inline', 'unsafe-eval', 'strict-dynamic', 'unsafe-hashes', 'report-sample', 'wasm-unsafe-eval', 'unsafe-allow-redirects'];
const CSP_DEPRECATED = { 'report-uri': 'deprecated in favour of report-to', 'block-all-mixed-content': 'deprecated', 'prefetch-src': 'deprecated/removed', 'plugin-types': 'removed', referrer: 'removed', 'navigate-to': 'removed' };
/** Parse a CSP header into policies (a header value may contain several, comma-separated). */
export function parseCsp(value, { reportOnly = false } = {}) {
  const issues = [], policies = [];
  const raw = String(value);
  const polTexts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!polTexts.length) issues.push(issue('error', 'csp-empty', 'The policy is empty.'));
  polTexts.forEach((text, pi) => {
    const dirs = [], seen = new Set();
    for (const seg of text.split(';')) {
      const t = seg.trim(); if (!t) continue;
      const [nameRaw, ...vals] = t.split(/\s+/);
      const name = nameRaw.toLowerCase();
      if (seen.has(name)) { issues.push(issue('warn', 'csp-duplicate', `Directive ${name} is repeated; only the first one is used.`)); continue; }
      seen.add(name);
      dirs.push({ name, values: vals, meaning: CSP_DIRECTIVES[name] || '' });
      if (!CSP_DIRECTIVES[name]) issues.push(issue('warn', 'csp-unknown', `Unknown directive "${name}" is ignored.`));
      else if (CSP_DEPRECATED[name]) issues.push(issue('info', 'csp-deprecated', `${name} is ${CSP_DEPRECATED[name]}.`));
      for (const v of vals) {
        if (CSP_KEYWORDS.includes(v.toLowerCase())) issues.push(issue('warn', 'csp-unquoted-keyword', `Keyword "${v}" must be quoted ('${v.toLowerCase()}'); unquoted it is read as a host name.`));
      }
      if (vals.map(v => v.toLowerCase()).includes("'none'") && vals.length > 1) issues.push(issue('warn', 'csp-none-mixed', `In ${name}, 'none' is ignored when other sources are listed.`));
    }
    policies.push({ index: pi, directives: dirs, get: n => dirs.find(d => d.name === n) });
    const P = policies[pi];
    const eff = n => P.get(n) || (CSP_FETCH.includes(n) ? P.get('default-src') : null);
    const has = (d, token) => d && d.values.some(v => v.toLowerCase() === token);
    const scriptDir = eff('script-src');
    if (scriptDir) {
      const hardened = scriptDir.values.some(v => /^'(nonce-|sha(256|384|512)-)/i.test(v)) || has(scriptDir, "'strict-dynamic'");
      if (has(scriptDir, "'unsafe-inline'")) issues.push(hardened
        ? issue('info', 'csp-unsafe-inline-ignored', `'unsafe-inline' in ${scriptDir.name} is ignored by browsers when a nonce/hash/'strict-dynamic' is present (kept as a fallback).`)
        : issue('warn', 'csp-unsafe-inline', `'unsafe-inline' in ${scriptDir.name} allows inline scripts and defeats most XSS protection.`));
      if (has(scriptDir, "'unsafe-eval'")) issues.push(issue('warn', 'csp-unsafe-eval', `'unsafe-eval' in ${scriptDir.name} allows eval() and similar string-to-code APIs.`));
      if (scriptDir.values.includes('*')) issues.push(issue('warn', 'csp-wildcard', `Wildcard * in ${scriptDir.name} allows scripts from any host.`));
      if (scriptDir.values.some(v => /^(data:|https?:)$/i.test(v))) issues.push(issue('warn', 'csp-broad-scheme', `Scheme-only source (${scriptDir.values.filter(v => /^(data:|https?:)$/i.test(v)).join(', ')}) in ${scriptDir.name} is far too broad.`));
      if (scriptDir.values.some(v => /^(blob:|filesystem:)$/i.test(v))) issues.push(issue('info', 'csp-blob', `blob:/filesystem: in ${scriptDir.name} can allow script injection through user-controlled objects.`));
    }
    for (const d of dirs) {
      if (d.name === 'script-src' || d.name === 'default-src') continue;
      if (['style-src', 'object-src', 'frame-src', 'connect-src', 'worker-src'].includes(d.name)) {
        if (d.values.includes('*')) issues.push(issue(d.name === 'object-src' ? 'warn' : 'info', 'csp-wildcard', `Wildcard * in ${d.name} allows any host.`));
      }
      if (d.name === 'style-src' && has(d, "'unsafe-inline'")) issues.push(issue('info', 'csp-style-unsafe-inline', "'unsafe-inline' in style-src permits inline styles (lower risk than scripts)."));
      if (d.name === 'object-src' && d.values.some(v => /^data:$/i.test(v))) issues.push(issue('warn', 'csp-broad-scheme', 'data: in object-src allows plugin content from data URLs.'));
    }
    const def = P.get('default-src');
    if (def) {
      if (def.values.includes('*')) issues.push(issue('warn', 'csp-wildcard', 'Wildcard * in default-src allows any host for everything not listed separately.'));
      if (!P.get('script-src') && has(def, "'unsafe-inline'")) { /* reported above through eff() */ }
    }
    if (dirs.some(d => d.values.some(v => /^http:/i.test(v)))) issues.push(issue('warn', 'csp-http-source', 'A source uses http://: content could be tampered with in transit.'));
    if (!P.get('object-src') && !(def && has(def, "'none'"))) issues.push(issue('warn', 'csp-missing-object-src', "object-src is not restricted: add object-src 'none' (or default-src 'none')."));
    if (!P.get('base-uri')) issues.push(issue('warn', 'csp-missing-base-uri', "base-uri is not set: injected <base> tags can redirect relative URLs. Add base-uri 'none' or 'self'."));
    if (!P.get('frame-ancestors')) issues.push(issue('warn', 'csp-missing-frame-ancestors', "frame-ancestors is not set (it does not fall back to default-src): clickjacking is not prevented by this policy. Add frame-ancestors 'none' or 'self'."));
    if (!P.get('default-src') && !P.get('script-src')) issues.push(issue('warn', 'csp-no-script-control', 'Neither script-src nor default-src is set: scripts are unrestricted.'));
    if (polTexts.length > 1) issues.push(issue('info', 'csp-multiple', `The header contains ${polTexts.length} policies; all of them are enforced (a resource must satisfy each).`));
  });
  if (reportOnly) issues.push(issue('info', 'csp-report-only', 'Report-Only: violations are reported but nothing is blocked.'));
  // de-duplicate identical messages (multiple policies)
  const uniq = []; for (const i of issues) if (!uniq.some(u => u.code === i.code && u.message === i.message)) uniq.push(i);
  return { policies, issues: uniq, reportOnly };
}
function explainCsp(v, ctx, ro) {
  const p = parseCsp(v, { reportOnly: ro });
  const details = p.policies.flatMap(pol => pol.directives.map(d => D(d.name, d.values.join(' ') || '(no sources)', d.meaning)));
  const n = p.policies.reduce((a, b) => a + b.directives.length, 0);
  return result(`${ro ? 'Report-only policy' : 'Policy'} with ${n} directive${n === 1 ? '' : 's'}.`, details, p.issues);
}

// ---------------------------------------------------------------- other security headers
export function parseHsts(value) {
  const issues = [], map = {};
  for (const part of splitTop(String(value), ';')) {
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase(), v = i < 0 ? null : unquote(part.slice(i + 1).trim());
    if (k in map) issues.push(issue('warn', 'hsts-duplicate', `Directive ${k} is repeated; the header is ignored by browsers if a directive appears twice.`));
    map[k] = v ?? true;
    if (!['max-age', 'includesubdomains', 'preload'].includes(k)) issues.push(issue('info', 'hsts-unknown', `Unknown directive "${k}" is ignored.`));
  }
  let maxAge = null;
  if (!('max-age' in map)) issues.push(issue('error', 'hsts-no-maxage', 'max-age is required; without it browsers ignore the header.'));
  else if (!/^\d+$/.test(String(map['max-age']))) issues.push(issue('error', 'hsts-bad-maxage', `max-age must be a non-negative integer (got "${map['max-age']}").`));
  else maxAge = parseInt(map['max-age'], 10);
  const includeSubDomains = 'includesubdomains' in map, preload = 'preload' in map;
  if (maxAge === 0) issues.push(issue('info', 'hsts-clear', 'max-age=0 tells browsers to forget this host\'s HSTS policy.'));
  else if (maxAge != null && maxAge < 15552000) issues.push(issue('warn', 'hsts-short', `max-age ${humanSeconds(maxAge)} is short; 1 year (31536000) or more is recommended.`));
  const eligible = maxAge != null && maxAge >= 31536000 && includeSubDomains && preload;
  if (preload && !eligible) issues.push(issue('warn', 'hsts-preload-ineligible', `Not eligible for the preload list: needs max-age >= 31536000${maxAge != null && maxAge < 31536000 ? ' (yours is lower)' : ''}, includeSubDomains and preload.`));
  if (!preload && maxAge >= 31536000 && includeSubDomains) issues.push(issue('info', 'hsts-preload-possible', 'Meets the preload requirements; add "preload" only if you intend to submit the domain to hstspreload.org (hard to undo).'));
  issues.push(issue('info', 'hsts-https-only', 'Browsers only honour HSTS received over HTTPS; it is ignored over plain HTTP.'));
  return { maxAge, includeSubDomains, preload, preloadEligible: eligible, issues };
}
function explainHsts(v) {
  const p = parseHsts(v);
  return result(p.maxAge != null ? `HTTPS only for ${humanSeconds(p.maxAge)}${p.includeSubDomains ? ', including subdomains' : ''}${p.preload ? ', preload requested' : ''}.` : 'Invalid HSTS policy.',
    [D('max-age', p.maxAge == null ? 'missing/invalid' : `${p.maxAge} (${humanSeconds(p.maxAge)})`), D('includeSubDomains', p.includeSubDomains ? 'yes' : 'no'), D('preload', p.preload ? 'yes' : 'no'), D('Preload list eligible', p.preloadEligible ? 'yes' : 'no')], p.issues);
}
export const REFERRER_POLICIES = {
  'no-referrer': 'Never send the Referer header.', 'no-referrer-when-downgrade': 'Send the full URL unless going from HTTPS to HTTP.', origin: 'Send only the origin.',
  'origin-when-cross-origin': 'Full URL for same-origin, origin only for cross-origin.', 'same-origin': 'Send the Referer only for same-origin requests.',
  'strict-origin': 'Send the origin, but not on HTTPS to HTTP downgrades.', 'strict-origin-when-cross-origin': 'Full URL same-origin; origin cross-origin; nothing on downgrade (browser default).', 'unsafe-url': 'Always send the full URL (can leak paths and queries).',
};
export function parseReferrerPolicy(value) {
  const issues = [], tokens = splitTop(String(value)).map(t => t.toLowerCase());
  const valid = tokens.filter(t => t in REFERRER_POLICIES);
  tokens.filter(t => !(t in REFERRER_POLICIES)).forEach(t => issues.push(issue('error', 'rp-invalid', `"${t}" is not a valid Referrer-Policy value.`)));
  if (!tokens.length) issues.push(issue('error', 'rp-empty', 'Referrer-Policy is empty.'));
  const effective = valid.at(-1) || null;
  if (tokens.length > 1) issues.push(issue('info', 'rp-fallback', `Several values: browsers use the last one they understand (${effective ?? 'none valid'}).`));
  if (effective && ['unsafe-url', 'no-referrer-when-downgrade', 'origin-when-cross-origin'].includes(effective)) issues.push(issue('warn', 'rp-weak', `${effective} can leak full URLs to other sites; prefer strict-origin-when-cross-origin or stricter.`));
  return { tokens, effective, issues };
}
function explainReferrerPolicy(v) { const p = parseReferrerPolicy(v); return result(p.effective ? REFERRER_POLICIES[p.effective] : 'No valid policy.', p.tokens.map(t => D(t, REFERRER_POLICIES[t] || 'invalid')), p.issues); }

const POWERFUL = ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'bluetooth', 'hid', 'display-capture', 'clipboard-read', 'clipboard-write', 'midi', 'xr-spatial-tracking'];
export function parsePermissionsPolicy(value) {
  const issues = [], features = [];
  for (const part of splitTop(String(value))) {
    const i = part.indexOf('=');
    if (i < 0) { issues.push(issue('error', 'pp-syntax', `"${part.slice(0, 40)}" has no "=": looks like the old Feature-Policy syntax. Use feature=(allowlist).`)); continue; }
    const name = part.slice(0, i).trim().toLowerCase(); let list = part.slice(i + 1).trim();
    let origins;
    if (list === '*') origins = ['*'];
    else if (/^\(.*\)$/.test(list)) origins = list.slice(1, -1).split(/\s+/).filter(Boolean).map(o => o.replace(/^"|"$/g, ''));
    else if (/^self$/i.test(list)) { origins = ['self']; issues.push(issue('error', 'pp-self-syntax', `${name}=self is invalid: use ${name}=(self).`)); }
    else { origins = [list]; issues.push(issue('error', 'pp-allowlist-syntax', `Allowlist for ${name} must be * or a parenthesised list, e.g. ${name}=(self).`)); }
    features.push({ name, origins });
    if (origins.includes('*') && POWERFUL.includes(name)) issues.push(issue('warn', 'pp-wildcard-powerful', `${name}=* lets every embedded origin use a powerful feature.`));
  }
  if (!features.length && !issues.length) issues.push(issue('error', 'pp-empty', 'Permissions-Policy is empty.'));
  return { features, issues };
}
function explainPermissionsPolicy(v) {
  const p = parsePermissionsPolicy(v);
  return result(`${p.features.length} feature${p.features.length === 1 ? '' : 's'} configured.`, p.features.map(f => D(f.name, f.origins.length ? f.origins.join(' ') : 'disabled for everyone', f.origins.length ? '' : 'Empty allowlist () turns the feature off.')), p.issues);
}
function explainXfo(v) {
  const t = v.trim(), up = t.toUpperCase(), issues = [];
  if (up === 'DENY') return result('The page cannot be shown in any frame.', [], issues);
  if (up === 'SAMEORIGIN') return result('The page may only be framed by the same origin.', [], issues);
  if (up.startsWith('ALLOW-FROM')) { issues.push(issue('warn', 'xfo-allow-from', 'ALLOW-FROM is obsolete and ignored by modern browsers; use CSP frame-ancestors.')); return result('Obsolete ALLOW-FROM.', [], issues); }
  if (t.includes(',')) issues.push(issue('error', 'xfo-multiple', 'Multiple values: browsers ignore the header when values conflict. Send exactly one of DENY or SAMEORIGIN.'));
  else issues.push(issue('error', 'xfo-invalid', `"${t.slice(0, 40)}" is not valid; use DENY or SAMEORIGIN.`));
  return result('Invalid value.', [], issues);
}
function explainXcto(v) {
  const ok = v.trim().toLowerCase() === 'nosniff';
  return result(ok ? 'Browsers must not MIME-sniff: the declared Content-Type is trusted.' : 'Invalid value.', [], ok ? [] : [issue('error', 'xcto-invalid', `The only defined value is "nosniff" (got "${v.trim().slice(0, 40)}").`)]);
}
function explainXss(v) {
  const t = v.trim();
  if (t.startsWith('0')) return result('XSS auditor disabled (recommended).', [], [issue('info', 'xxss-off', 'Good: 0 disables the legacy filter. Rely on Content-Security-Policy.')]);
  return result('Legacy XSS filter enabled.', [], [issue('warn', 'xxss-enabled', 'X-XSS-Protection is deprecated; the filters it controls were removed from modern browsers and could introduce vulnerabilities in old ones. Send 0 or omit it and use CSP.')]);
}
function explainIsolation(lower, v) {
  const t = v.trim().toLowerCase(), issues = [];
  const tables = {
    'cross-origin-opener-policy': { 'same-origin': 'Popups/openers from other origins are cut off (needed for cross-origin isolation).', 'same-origin-allow-popups': 'Same-origin isolation, but popups you open may keep a reference.', 'unsafe-none': 'Default: no isolation.', 'noopener-allow-popups': 'Opener reference to cross-origin popups is dropped.' },
    'cross-origin-embedder-policy': { 'require-corp': 'Every cross-origin subresource must opt in via CORP/CORS.', credentialless: 'Cross-origin no-cors requests are sent without credentials.', 'unsafe-none': 'Default: no restriction.' },
    'cross-origin-resource-policy': { 'same-origin': 'Only same-origin pages may load this resource.', 'same-site': 'Only same-site pages may load this resource.', 'cross-origin': 'Any origin may load this resource.' },
  };
  const key = lower.replace('-report-only', '');
  const table = tables[key]; const base = t.split(';')[0].trim();
  if (!table[base]) { issues.push(issue('error', 'iso-invalid', `"${base.slice(0, 40)}" is not valid for ${key}. Valid: ${Object.keys(table).join(', ')}.`)); return result('Invalid value.', [], issues); }
  if (lower.endsWith('report-only')) issues.push(issue('info', 'iso-report-only', 'Report-only mode: not enforced.'));
  return result(table[base], [D('Value', base)], issues);
}
function explainLink(v) {
  const items = splitTop(v), issues = [], details = [];
  for (const it of items) {
    const m = /^<([^>]*)>(.*)$/.exec(it);
    if (!m) { issues.push(issue('error', 'link-syntax', `"${it.slice(0, 40)}" must start with <URL>.`)); continue; }
    const params = parseParams(splitTop(m[2].replace(/^\s*;/, ''), ';'));
    const rel = params.find(p => p.key === 'rel')?.value;
    if (!rel) issues.push(issue('warn', 'link-no-rel', `Link to ${m[1].slice(0, 60)} has no rel parameter.`));
    details.push(D(m[1], params.map(p => `${p.key}${p.value != null ? `=${p.value}` : ''}`).join('; ')));
  }
  return result(`${items.length} link${items.length === 1 ? '' : 's'}.`, details, issues);
}
export function parseQList(value) {
  return splitTop(String(value)).map(item => {
    const [tokenRaw, ...ps] = splitTop(item, ';');
    const params = parseParams(ps);
    const qp = params.find(p => p.key === 'q');
    const q = qp ? Number(qp.value) : 1;
    return { value: tokenRaw, q, qValid: !qp || (/^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(qp.value)), params: params.filter(p => p.key !== 'q') };
  });
}
function explainQList(lower, v) {
  const items = parseQList(v), issues = [];
  if (!items.length) issues.push(issue('error', 'q-empty', 'Empty list.'));
  for (const it of items) if (!it.qValid) issues.push(issue('error', 'q-invalid', `q-value for "${it.value}" must be between 0 and 1 with at most 3 decimals.`));
  if (lower === 'accept-encoding') for (const it of items) if (!['gzip', 'br', 'deflate', 'zstd', 'identity', 'compress', 'x-gzip', '*'].includes(it.value.toLowerCase())) issues.push(issue('info', 'ae-unknown', `Unknown content coding "${it.value}".`));
  if (lower === 'accept') for (const it of items) if (!/^(\*|[\w.+-]+)\/(\*|[\w.+-]+)$/.test(it.value)) issues.push(issue('warn', 'accept-invalid', `"${it.value}" is not a media range.`));
  const sorted = [...items].sort((a, b) => b.q - a.q);
  return result(`Preference order: ${sorted.map(i => i.value).join(' > ') || '(none)'}.`, items.map(i => D(i.value, `q=${i.q}`, i.q === 0 ? 'Not acceptable.' : '')), issues);
}

// ---------------------------------------------------------------- authentication
const AUTH_SCHEMES = { basic: 'Base64 user:password (not encrypted).', bearer: 'Bearer token (OAuth 2.0 / JWT).', digest: 'Challenge-response with hashed credentials.', negotiate: 'SPNEGO / Kerberos / NTLM.', ntlm: 'Windows NTLM.', 'aws4-hmac-sha256': 'AWS Signature Version 4.', hawk: 'Hawk HMAC scheme.', dpop: 'Demonstrating Proof of Possession token.', mutual: 'Mutual authentication.', scram: 'SCRAM.', 'scram-sha-256': 'SCRAM-SHA-256.', hoba: 'HTTP Origin-Bound Auth.', oauth: 'OAuth 1.0.', token: 'Opaque token (custom).', apikey: 'API key (custom).' };
export function maskAuthorization(value) {
  const t = String(value).trim(), m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return '';
  return m[2] ? `${m[1]} ${'\u2022'.repeat(8)} (${m[2].length} characters hidden)` : m[1];
}
function explainAuthorization(lower, v) {
  const t = v.trim(), m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t), issues = [];
  if (!m) return result('Empty credentials.', [], [issue('error', 'auth-empty', 'No authentication scheme given.')]);
  const scheme = m[1], cred = m[2] || '', sl = scheme.toLowerCase();
  const details = [D('Scheme', scheme, AUTH_SCHEMES[sl] || 'Unknown or custom scheme.'), D('Credentials', cred ? `${cred.length} characters (hidden, never decoded)` : '(none)')];
  if (!AUTH_SCHEMES[sl]) issues.push(issue('info', 'auth-unknown-scheme', `Unrecognised scheme "${scheme}".`));
  if (!cred) issues.push(issue('error', 'auth-no-credentials', `${scheme} needs credentials after the scheme name.`));
  if (sl === 'basic' && cred) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cred)) issues.push(issue('warn', 'auth-basic-b64', 'Basic credentials should be base64 (user:password).'));
    issues.push(issue('info', 'auth-basic-plain', 'Basic is only encoded, not encrypted: use it only over HTTPS.'));
  }
  if (sl === 'bearer' && cred) {
    if (/\s/.test(cred)) issues.push(issue('warn', 'auth-bearer-space', 'Bearer tokens must not contain spaces.'));
    if (/^[\w-]+\.[\w-]+\.[\w-]*$/.test(cred)) issues.push(issue('info', 'auth-jwt', 'Looks like a JWT. Not decoded here; use the JWT Decoder tool locally.'));
  }
  return result(`${scheme} credentials${cred ? ` (${cred.length} characters, hidden)` : ''}.`, details, issues);
}
function explainWwwAuth(v) {
  const challenges = splitTop(v).filter(c => /^[A-Za-z][\w-]*(\s|$)/.test(c));
  const details = challenges.map(c => { const s = c.split(/\s+/)[0]; return D(s, c.slice(s.length).trim(), AUTH_SCHEMES[s.toLowerCase()] || ''); });
  const issues = challenges.length ? [] : [issue('error', 'wwwauth-invalid', 'No valid challenge found (expected "Scheme realm=...").')];
  if (challenges.some(c => /^basic/i.test(c) && !/realm=/i.test(c))) issues.push(issue('info', 'wwwauth-realm', 'Basic challenges should include a realm.'));
  return result(`${challenges.length} challenge${challenges.length === 1 ? '' : 's'}.`, details, issues);
}

// ---------------------------------------------------------------- dates and misc
function explainDate(lower, v, ctx) {
  const now = ctx.now ?? Date.now(), t = v.trim(), issues = [];
  if (lower === 'expires' && /^(0|-1)$/.test(t)) return result('Already expired (invalid dates and 0 mean "in the past").', [], [issue('info', 'expires-zero', 'Expires: 0 is a common way to mark a response as stale.')]);
  const p = parseHttpDate(t);
  if (!p) {
    issues.push(issue(lower === 'expires' ? 'warn' : 'error', 'date-invalid', `Not a valid HTTP date. Expected "Sun, 06 Nov 1994 08:49:37 GMT".${lower === 'expires' ? ' Caches treat an invalid Expires as already expired.' : ''}`));
    return result('Invalid date.', [], issues);
  }
  if (p.format !== 'imf') issues.push(issue('warn', 'date-obsolete', `Obsolete ${p.format === 'rfc850' ? 'RFC 850' : 'asctime'} date format; senders must use IMF-fixdate.`));
  if (!p.weekdayOk) issues.push(issue('warn', 'date-weekday', 'The weekday name does not match the date.'));
  if (lower === 'last-modified' && p.date.getTime() > now + 60000) issues.push(issue('warn', 'lastmod-future', 'Last-Modified is in the future.'));
  if (lower === 'date' && Math.abs(p.date.getTime() - now) > 300000) issues.push(issue('info', 'date-skew', `Date differs from your clock by ${humanSeconds(Math.round(Math.abs(p.date.getTime() - now) / 1000))}: the response may be old, or clocks may be skewed.`));
  return result(`${p.date.toISOString()} (${relTime(p.date, now)}).`, [D('UTC', p.date.toISOString()), D('Relative', relTime(p.date, now))], issues);
}
function explainContentLength(v) {
  const t = v.trim();
  if (/^\d+$/.test(t)) return result(`${Number(t).toLocaleString('en-US')} bytes.`, [], Number(t) > Number.MAX_SAFE_INTEGER ? [issue('warn', 'cl-huge', 'Value exceeds safe integer range.')] : []);
  if (/^\d+(\s*,\s*\d+)+$/.test(t)) return result('Multiple lengths.', [], [issue(new Set(t.split(/\s*,\s*/)).size > 1 ? 'error' : 'warn', 'cl-list', 'Content-Length has several values; differing values are a request-smuggling risk and must be rejected.')]);
  return result('Invalid length.', [], [issue('error', 'cl-invalid', 'Content-Length must be a non-negative integer.')]);
}
function explainEtag(v) {
  const m = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(v.trim());
  if (!m) return result('Invalid ETag.', [], [issue('error', 'etag-invalid', 'ETag must be a quoted string, optionally prefixed with W/ (weak).')]);
  return result(m[1] ? 'Weak validator (semantically equivalent content).' : 'Strong validator (byte-for-byte identical content).', [D('Opaque tag', m[2])]);
}
function explainVary(v) {
  const t = v.trim();
  if (t === '*') return result('Every request is unique: shared caches cannot reuse it.', [], [issue('warn', 'vary-star', 'Vary: * effectively disables shared caching.')]);
  const items = splitTop(t), issues = [];
  items.filter(i => !TOKEN.test(i)).forEach(i => issues.push(issue('error', 'vary-invalid', `"${i}" is not a header name.`)));
  if (items.some(i => i.toLowerCase() === 'cookie')) issues.push(issue('info', 'vary-cookie', 'Vary: Cookie fragments caches heavily.'));
  return result(`Cache key also depends on: ${items.join(', ') || '(none)'}.`, items.map(i => D(i, '')), issues);
}
function explainRetryAfter(v, ctx) {
  const t = v.trim();
  if (/^\d+$/.test(t)) return result(`Retry after ${humanSeconds(+t)}.`);
  const p = parseHttpDate(t);
  if (p) return result(`Retry ${relTime(p.date, ctx.now ?? Date.now())}.`);
  return result('Invalid value.', [], [issue('error', 'retry-invalid', 'Must be seconds or an HTTP date.')]);
}
function explainContentDisposition(v) {
  const parts = splitTop(v, ';'), type = (parts.shift() || '').toLowerCase(), params = parseParams(parts), issues = [];
  if (!['inline', 'attachment', 'form-data'].includes(type)) issues.push(issue('warn', 'cd-type', `Unusual disposition type "${type}".`));
  const fn = params.find(p => p.key === 'filename' || p.key === 'filename*');
  if (fn && /[\\/]/.test(fn.value || '') && fn.key === 'filename') issues.push(issue('warn', 'cd-path', 'filename contains a path separator; browsers strip it, but avoid it.'));
  return result(type === 'attachment' ? `Download${fn ? ` as ${fn.value}` : ''}.` : type === 'inline' ? 'Display in the browser.' : `Disposition: ${type}.`, params.map(p => D(p.key, p.value ?? '')), issues);
}
function explainLocation(v) {
  const t = v.trim();
  const issues = /\s/.test(t) ? [issue('warn', 'loc-space', 'URL contains unencoded spaces.')] : [];
  return result(/^https?:\/\//i.test(t) ? `Absolute redirect to ${t}.` : `Relative reference ${t}.`, [], issues);
}
function explainServerLike(lower, v) {
  const issues = [];
  if (/\d+\.\d+/.test(v) || (lower !== 'server' && v.trim())) issues.push(issue('warn', 'info-leak', `${lower === 'server' ? 'Server' : HEADER_DB[lower]?.name || lower} reveals ${/\d+\.\d+/.test(v) ? 'software and version' : 'implementation details'} to attackers (fingerprinting).`));
  return result(lower === 'server' ? `Origin software: ${v.trim() || '(empty)'}.` : `Discloses implementation detail: ${v.trim()}.`, [], issues);
}
function explainSimpleList(lower, v) {
  const items = splitTop(v);
  return result(items.join(', '), []);
}

/** Explain a header value. ctx: { kind: 'request'|'response', now } */
export function explainHeader(h, ctx = {}) {
  const lower = h.lower, v = String(h.value ?? '');
  const kind = ctx.kind || 'response';
  if (v.trim() === '' && !['cookie', 'accept-encoding'].includes(lower)) return result('Empty value.', [], [issue('warn', 'empty-value', 'This header has an empty value.')]);
  try {
    switch (lower) {
      case 'cache-control': return explainCacheControl(v, { kind });
      case 'content-type': return explainContentType(v);
      case 'set-cookie': return explainSetCookie(v);
      case 'cookie': return explainCookie(v);
      case 'access-control-allow-origin': case 'access-control-allow-credentials': case 'access-control-allow-headers': case 'access-control-allow-methods':
      case 'access-control-expose-headers': case 'access-control-max-age': case 'access-control-request-headers': return explainCors(lower, v, ctx);
      case 'content-security-policy': return explainCsp(v, ctx, false);
      case 'content-security-policy-report-only': return explainCsp(v, ctx, true);
      case 'strict-transport-security': return explainHsts(v);
      case 'referrer-policy': return explainReferrerPolicy(v);
      case 'permissions-policy': return explainPermissionsPolicy(v);
      case 'x-frame-options': return explainXfo(v);
      case 'x-content-type-options': return explainXcto(v);
      case 'x-xss-protection': return explainXss(v);
      case 'cross-origin-opener-policy': case 'cross-origin-embedder-policy': case 'cross-origin-resource-policy':
      case 'cross-origin-opener-policy-report-only': case 'cross-origin-embedder-policy-report-only': return explainIsolation(lower, v);
      case 'link': return explainLink(v);
      case 'accept': case 'accept-language': case 'accept-encoding': return explainQList(lower, v);
      case 'authorization': case 'proxy-authorization': return explainAuthorization(lower, v);
      case 'www-authenticate': case 'proxy-authenticate': return explainWwwAuth(v);
      case 'date': case 'expires': case 'last-modified': case 'if-modified-since': case 'if-unmodified-since': return explainDate(lower, v, ctx);
      case 'content-length': return explainContentLength(v);
      case 'etag': case 'if-none-match': case 'if-match': return lower === 'etag' ? explainEtag(v) : result(splitTop(v).join(', '));
      case 'vary': return explainVary(v);
      case 'retry-after': return explainRetryAfter(v, ctx);
      case 'content-disposition': return explainContentDisposition(v);
      case 'location': return explainLocation(v);
      case 'server': case 'x-powered-by': case 'x-aspnet-version': case 'x-aspnetmvc-version': case 'x-generator': case 'x-runtime': return explainServerLike(lower, v);
      case 'content-encoding': case 'transfer-encoding': case 'connection': case 'allow': case 'accept-ranges': case 'content-language': return explainSimpleList(lower, v);
      default: return null;
    }
  } catch (e) {
    return result('Could not analyse this value.', [], [issue('warn', 'explain-failed', `Analysis failed: ${e.message}`)]);
  }
}

// ---------------------------------------------------------------- masking
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|api-key|x-amz-security-token)$/;
export const isSensitive = lower => SENSITIVE.test(lower) || /(token|secret|password|apikey)/.test(lower);
/** Value safe to display/export when masking is on. */
export function maskValue(name, value) {
  const lower = String(name).toLowerCase(), v = String(value);
  if (lower === 'authorization' || lower === 'proxy-authorization') return maskAuthorization(v);
  if (lower === 'cookie') return v.split(';').map(p => { const t = p.trim(), i = t.indexOf('='); return i < 0 ? t : `${t.slice(0, i)}=${'\u2022'.repeat(6)}`; }).filter(Boolean).join('; ');
  if (lower === 'set-cookie') { const i = v.indexOf('='), j = v.indexOf(';'); if (i < 0 || (j >= 0 && j < i)) return v; const end = j < 0 ? v.length : j; return `${v.slice(0, i)}=${'\u2022'.repeat(6)}${v.slice(end)}`; }
  if (isSensitive(lower) && v) return '\u2022'.repeat(8) + ` (${v.length} characters hidden)`;
  return v;
}

// ---------------------------------------------------------------- parser
const RES_LINE = /^HTTP\/(\d(?:\.\d)?)\s+(\d{3})(?:\s+(.*))?$/i;
const REQ_LINE = /^([A-Za-z]+)\s+(\S+)\s+HTTP\/(\d(?:\.\d)?)\s*$/;
const REQ_ONLY = ['host', 'user-agent', 'cookie', 'accept', 'accept-encoding', 'accept-language', 'authorization', 'origin', 'referer', 'if-none-match', 'if-modified-since', 'range', 'upgrade-insecure-requests', 'te', 'expect'];
const RES_ONLY = ['server', 'set-cookie', 'etag', 'last-modified', 'location', 'strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'www-authenticate', 'accept-ranges', 'age', 'vary', 'retry-after', 'x-powered-by', 'expires'];

function extractFromCurl(text) {
  const t = text.replace(/\\\r?\n/g, ' ');
  const headers = [], re = /(?:^|\s)(?:-H|--header)\s*(?:=\s*)?(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)"|\$'((?:[^'\\]|\\.)*)'|(\S+))/g;
  let m;
  while ((m = re.exec(t))) headers.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').replace(/\\(["\\$`])/g, '$1'));
  const method = /(?:^|\s)(?:-X|--request)\s+(\S+)/.exec(t)?.[1];
  const url = /(?:^|\s)(?:--url\s+)?['"]?(https?:\/\/[^\s'"]+)/.exec(t)?.[1];
  const cookie = /(?:^|\s)(?:-b|--cookie)\s+(?:'([^']*)'|"([^"]*)")/.exec(t);
  if (cookie) headers.push(`Cookie: ${cookie[1] ?? cookie[2]}`);
  return { text: headers.join('\n'), method, url };
}
function extractFromFetch(text) {
  const m = /["']?headers["']?\s*:\s*(\{[\s\S]*?\})\s*[,}]/.exec(text);
  if (!m) return null;
  try { const o = JSON.parse(m[1]); return { text: Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') }; } catch { return null; }
}

/**
 * Parse pasted headers. opts.mode: 'auto' | 'request' | 'response' (only used to pick among several blocks and to resolve ambiguity).
 * Returns { headers, startLine, issues, mode, notes, source }.
 */
export function parseHeaders(input, opts = {}) {
  let text = String(input ?? '');
  const issues = [], notes = [];
  const out = { headers: [], startLine: null, issues, mode: 'unknown', notes, source: 'raw' };
  if (text.length > LIMITS.bytes) { issues.push(issue('error', 'too-large', `Input is larger than ${LIMITS.bytes / 1e6} MB; paste only the header block.`)); return out; }
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) { issues.push(issue('error', 'empty-input', 'Paste some HTTP headers to analyse.')); return out; }
  const trimmed = text.trim();
  let curlMethod = null, curlUrl = null;
  if (/^curl\s/i.test(trimmed)) {
    const c = extractFromCurl(trimmed);
    out.source = 'curl'; notes.push('Detected a curl command: its -H headers are analysed as request headers.');
    if (!c.text) { issues.push(issue('error', 'curl-no-headers', 'The curl command has no -H/--header options.')); return out; }
    text = c.text; curlMethod = c.method; curlUrl = c.url; opts = { ...opts, mode: opts.mode && opts.mode !== 'auto' ? opts.mode : 'request' };
  } else if (/\bfetch\s*\(/.test(trimmed)) {
    const f = extractFromFetch(trimmed);
    if (f) { out.source = 'fetch'; notes.push('Detected a fetch() call: its headers object is analysed as request headers.'); text = f.text; opts = { ...opts, mode: opts.mode && opts.mode !== 'auto' ? opts.mode : 'request' }; }
  }
  // line endings
  const crlf = (text.match(/\r\n/g) || []).length, allLf = (text.match(/\n/g) || []).length, lfOnly = allLf - crlf;
  if (crlf && lfOnly) issues.push(issue('warn', 'mixed-eol', `Mixed line endings (${crlf} CRLF, ${lfOnly} LF). HTTP requires CRLF; servers may reject mixed or LF-only headers.`));
  else if (!crlf && allLf) issues.push(issue('info', 'lf-only', 'Lines end with LF only; on the wire HTTP uses CRLF (fine for pasted text).'));
  let lines = text.split(/\r?\n/);
  // curl -v style
  if (lines.some(l => /^[<>] /.test(l))) {
    const want = opts.mode === 'request' ? '>' : (lines.some(l => l.startsWith('< ')) ? '<' : '>');
    lines = lines.filter(l => l.startsWith(want + ' ') || l === want).map(l => l.slice(2));
    notes.push(`Detected curl -v output: showing the "${want}" lines (${want === '<' ? 'response' : 'request'}).`);
  }
  // blocks
  const blocks = []; let cur = null;
  lines.forEach((raw, idx) => {
    if (raw.trim() === '') { cur = null; return; }
    if (!cur) { cur = []; blocks.push(cur); }
    cur.push({ raw, no: idx + 1 });
  });
  if (!blocks.length) { issues.push(issue('error', 'empty-input', 'Paste some HTTP headers to analyse.')); return out; }
  const isStart = b => RES_LINE.test(b[0].raw.trim()) || REQ_LINE.test(b[0].raw.trim());
  const startBlocks = blocks.filter(isStart);
  let block;
  if (startBlocks.length) {
    const pickRes = opts.mode !== 'request';
    const preferred = startBlocks.filter(b => (pickRes ? RES_LINE : REQ_LINE).test(b[0].raw.trim()));
    block = (preferred.length ? preferred : startBlocks).at(-1);
    if (blocks.length > 1) notes.push(`Input has ${blocks.length} blocks separated by blank lines (redirect chain or body); analysing the ${startBlocks.length > 1 ? 'last matching header block' : 'header block'} and ignoring the rest.`);
  } else {
    block = blocks[0];
    if (blocks.length > 1) notes.push('Only the first block (up to the first blank line) was analysed; anything after it is treated as a message body.');
  }
  let body = block;
  const first = body[0].raw.trim();
  let m;
  if ((m = RES_LINE.exec(first))) { out.startLine = { kind: 'response', version: m[1], status: +m[2], reason: (m[3] || '').trim(), raw: first }; out.mode = 'response'; body = body.slice(1); }
  else if ((m = REQ_LINE.exec(first))) { out.startLine = { kind: 'request', method: m[1], target: m[2], version: m[3], raw: first }; out.mode = 'request'; body = body.slice(1); }
  else if (curlMethod || curlUrl) out.startLine = { kind: 'request', method: curlMethod || 'GET', target: curlUrl || '', version: '', raw: `${curlMethod || 'GET'} ${curlUrl || ''}`.trim() };
  // header lines
  const NAME_ONLY = /^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+:\s*$/, HEADERISH = /^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+:(\s|$)/;
  for (let i = 0; i < body.length; i++) {
    let { raw, no } = body[i];
    if (raw.includes('\r')) issues.push(issue('error', 'bare-cr', 'A bare CR (carriage return without LF) appears in this line; it is not allowed in HTTP headers.', { line: no }));
    raw = raw.replace(/\r/g, '');
    if (/^[ \t]/.test(raw)) {
      const prev = out.headers.at(-1);
      if (prev) { prev.value = `${prev.value} ${raw.trim()}`.trim(); prev.folded = true; issues.push(issue('warn', 'obs-fold', `Line ${no} is a folded (obs-fold) continuation of "${prev.name}". Folding is deprecated; senders must not generate it and proxies must unfold it.`, { line: no, header: prev.name })); }
      else issues.push(issue('error', 'orphan-continuation', 'A line starting with whitespace has no header to continue.', { line: no }));
      continue;
    }
    const start = raw.startsWith(':') ? 1 : 0;
    const ci = raw.indexOf(':', start);
    if (ci < 0) { issues.push(issue('error', 'missing-colon', `Line ${no} has no colon, so it is not a header: "${raw.slice(0, 60)}".`, { line: no })); continue; }
    let name = raw.slice(0, ci), value = raw.slice(ci + 1).trim();
    // Chrome DevTools copies "Name:" and the value on the next line
    if (NAME_ONLY.test(raw) && body[i + 1] && !HEADERISH.test(body[i + 1].raw.replace(/\r/g, '')) && !/^[ \t]/.test(body[i + 1].raw) && !RES_LINE.test(body[i + 1].raw)) {
      value = body[i + 1].raw.replace(/\r/g, '').trim(); i++;
      if (!notes.some(n => n.startsWith('Detected "Name:"'))) notes.push('Detected "Name:" followed by the value on the next line (DevTools copy format).');
    }
    const pseudo = name.startsWith(':');
    if (/\s$/.test(name) || /^\s/.test(name)) { issues.push(issue('error', 'space-before-colon', `Line ${no}: whitespace around the header name "${name.trim()}". RFC 9112 forbids whitespace before the colon; servers must reject it with 400.`, { line: no, header: name.trim() })); name = name.trim(); }
    if (!name || name === ':') { issues.push(issue('error', 'empty-name', `Line ${no} has an empty header name.`, { line: no })); continue; }
    if (pseudo ? !/^:[a-z]+$/.test(name) : !TOKEN.test(name)) {
      const bad = /[^\x20-\x7e]/.test(name);
      issues.push(issue('error', bad ? 'non-ascii-name' : 'invalid-name', `Line ${no}: "${name.slice(0, 40)}" is not a valid header name${bad ? ' (non-ASCII characters)' : ' (allowed: letters, digits and !#$%&\'*+-.^_`|~)'}.`, { line: no, header: name }));
    }
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) issues.push(issue('error', 'control-char', `Line ${no}: the value of "${name}" contains control characters.`, { line: no, header: name }));
    if (/[^\x00-\x7f]/.test(value)) issues.push(issue('warn', 'non-ascii-value', `Line ${no}: the value of "${name}" contains non-ASCII characters. Header values should be ASCII; non-ASCII bytes are opaque and encoding is undefined (use RFC 8187 / percent-encoding).`, { line: no, header: name }));
    out.headers.push({ name, lower: name.toLowerCase(), value, line: no, pseudo, folded: false });
  }
  if (out.headers.length > LIMITS.headers) { issues.push(issue('warn', 'too-many', `More than ${LIMITS.headers} headers; only the first ${LIMITS.headers} are analysed.`)); out.headers.length = LIMITS.headers; }
  if (!out.headers.length && !issues.some(i => i.level === 'error')) issues.push(issue('error', 'no-headers', 'No header lines found.'));
  // HTTP/2 pseudo headers decide mode
  if (out.mode === 'unknown') out.mode = detectMode(out.headers);
  if (opts.mode === 'request' || opts.mode === 'response') out.modeOverride = opts.mode;
  return out;
}

/** 'request' | 'response' by start line, pseudo headers and characteristic headers (ties -> response). */
export function detectMode(headers) {
  if (headers.some(h => h.lower === ':status')) return 'response';
  if (headers.some(h => [':method', ':path', ':authority', ':scheme'].includes(h.lower))) return 'request';
  let req = 0, res = 0;
  for (const h of headers) {
    if (REQ_ONLY.includes(h.lower) || h.lower.startsWith('sec-fetch-') || h.lower.startsWith('sec-ch-') || h.lower.startsWith('access-control-request-')) req++;
    if (RES_ONLY.includes(h.lower) || h.lower.startsWith('access-control-allow-') || h.lower.startsWith('cross-origin-')) res++;
  }
  return req > res ? 'request' : 'response';
}

// ---------------------------------------------------------------- cross checks
const SINGLETON = ['content-length', 'content-type', 'host', 'date', 'etag', 'last-modified', 'location', 'expires', 'age', 'server', 'authorization', 'user-agent', 'referer', 'origin', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'access-control-allow-origin', 'access-control-allow-credentials', 'retry-after', 'content-encoding'];
export function crossChecks(headers, mode = 'response') {
  const issues = [];
  const by = {};
  for (const h of headers) (by[h.lower] ||= []).push(h);
  for (const [k, list] of Object.entries(by)) {
    if (list.length < 2) continue;
    const name = list[0].name;
    if (k === 'set-cookie') issues.push(issue('info', 'multi-set-cookie', `${list.length} Set-Cookie headers: valid and expected (they must stay separate; do not merge with commas).`, { header: name }));
    else if (SINGLETON.includes(k)) {
      const differ = new Set(list.map(h => h.value)).size > 1;
      issues.push(issue(differ ? 'error' : 'warn', 'duplicate-singleton', `${name} appears ${list.length} times${differ ? ' with different values' : ''}; it must be sent at most once (recipients may reject or pick one).`, { header: name }));
    } else issues.push(issue('info', 'duplicate-header', `${name} appears ${list.length} times; recipients combine the values as a comma-separated list.`, { header: name }));
  }
  const names = Object.keys(by);
  if (by['content-length'] && by['transfer-encoding']) issues.push(issue('error', 'cl-te', 'Both Content-Length and Transfer-Encoding are present: a request-smuggling risk. Servers must ignore Content-Length when Transfer-Encoding is set (and many reject the message).', { header: 'Content-Length' }));
  if (mode === 'response') {
    const cc = by['cache-control']?.[0] ? parseCacheControl(by['cache-control'][0].value) : null;
    if (cc && by.pragma && /no-cache/i.test(by.pragma[0].value) && cc.map['max-age'] > 0) issues.push(issue('warn', 'cache-pragma-conflict', 'Pragma: no-cache conflicts with a positive max-age. Pragma is legacy; remove it or fix Cache-Control.', { header: 'Pragma' }));
    if (cc && by.expires && (cc.map['max-age'] !== undefined || cc.map['s-maxage'] !== undefined)) issues.push(issue('info', 'cache-expires-ignored', 'Expires is ignored because Cache-Control max-age/s-maxage is present.', { header: 'Expires' }));
    if (cc?.map['no-store'] && by.etag) issues.push(issue('info', 'cache-nostore-etag', 'ETag is of little use with Cache-Control: no-store (nothing is stored to revalidate).', { header: 'ETag' }));
    const ao = by['access-control-allow-origin']?.[0]?.value.trim();
    const acac = by['access-control-allow-credentials']?.[0]?.value.trim();
    if (ao === '*' && acac === 'true') issues.push(issue('error', 'cors-wildcard-credentials', 'Access-Control-Allow-Origin: * cannot be combined with Access-Control-Allow-Credentials: true; browsers block the response. Echo a specific origin instead.', { header: 'Access-Control-Allow-Origin' }));
    if (ao && ao !== '*' && ao !== 'null') {
      const vary = (by.vary || []).flatMap(h => splitTop(h.value).map(x => x.toLowerCase()));
      if (!vary.includes('origin') && !vary.includes('*')) issues.push(issue('warn', 'cors-no-vary-origin', 'A specific Access-Control-Allow-Origin without "Vary: Origin" can cause caches to serve the wrong origin\'s response to other sites.', { header: 'Vary' }));
    }
    if (by['access-control-allow-headers']?.length || by['access-control-allow-methods']?.length) { /* preflight response - nothing to add */ }
    if (by['cross-origin-embedder-policy'] && !by['cross-origin-opener-policy']) issues.push(issue('info', 'isolation-incomplete', 'COEP is set without COOP same-origin: cross-origin isolation needs both.', { header: 'Cross-Origin-Embedder-Policy' }));
    if (by['set-cookie'] && cc?.map.public) issues.push(issue('warn', 'cache-public-cookie', 'Cache-Control: public together with Set-Cookie can let a shared cache store and replay a personalised response.', { header: 'Cache-Control' }));
  }
  void names;
  return issues;
}

// ---------------------------------------------------------------- full analysis
/** Analyse parsed headers. opts: { mode: 'auto'|'request'|'response', now, https: 'yes'|'no'|'unknown', mask: boolean } */
export function analyze(input, opts = {}) {
  const parsed = typeof input === 'string' ? parseHeaders(input, opts) : input;
  const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : parsed.mode === 'unknown' ? 'response' : parsed.mode;
  const mask = opts.mask !== false;
  const ctx = { kind: mode, now: opts.now };
  const rows = parsed.headers.map(h => {
    const info = lookupHeader(h.lower);
    const ex = explainHeader(h, ctx);
    const wrongSide = info && info.kind !== 'both' && ((info.kind === 'req' && mode === 'response') || (info.kind === 'res' && mode === 'request'));
    const issues = [...(ex?.issues || [])];
    if (wrongSide) issues.push(issue('info', 'wrong-direction', `${info.name} is normally a ${info.kind === 'req' ? 'request' : 'response'} header; it is unusual in a ${mode}.`));
    if (info?.note && /^(deprecated|obsolete|removed)/i.test(info.note)) issues.push(issue('warn', 'deprecated', `${info.name}: ${info.note}`));
    return {
      name: h.name, lower: h.lower, line: h.line, value: h.value, display: mask ? maskValue(h.name, h.value) : h.value, pseudo: h.pseudo,
      known: !!info, category: info ? info.category : (h.pseudo ? 'HTTP/2 pseudo-header' : h.lower.startsWith('x-') ? 'Custom (X-)' : 'Unknown'),
      description: info ? info.description : h.pseudo ? 'HTTP/2 or HTTP/3 pseudo-header carrying the request/response line.' : 'Not in the built-in list: custom or vendor-specific header.',
      note: info?.note || '', summary: ex?.summary || '', details: ex?.details || [], issues,
    };
  });
  const cross = crossChecks(parsed.headers, mode);
  const security = mode === 'response' ? securityReview(parsed, rows, { https: opts.https || 'unknown', now: opts.now }) : null;
  return { parsed, mode, rows, cross, security, startLine: parsed.startLine, issues: parsed.issues, notes: parsed.notes, opts: { https: opts.https || 'unknown', mask } };
}

// ---------------------------------------------------------------- security review (response headers)
export const SECURITY_DISCLAIMER = 'Static heuristic only: it looks at the headers you pasted, not at the application. Recommendations depend on the app (for example CSP and HSTS are only meaningful for HTML served over HTTPS; some APIs legitimately omit them). Treat it as a checklist for discussion, not a score or a pass/fail audit.';
const item = (id, status, severity, header, title, message, recommendation = '') => ({ id, status, severity, header, title, message, recommendation });

export function securityReview(parsed, rows, { https = 'unknown', now } = {}) {
  const items = [];
  const get = n => rows.find(r => r.lower === n);
  const all = n => rows.filter(r => r.lower === n);
  const hdrs = parsed.headers;
  const isHtml = (() => { const ct = get('content-type'); return !ct || /text\/html|application\/xhtml/i.test(ct.value); })();
  const httpsOk = https !== 'no';

  // CSP
  const csp = get('content-security-policy'), cspRo = get('content-security-policy-report-only');
  if (csp) {
    const p = parseCsp(csp.value);
    const bad = p.issues.filter(i => i.level === 'warn' && !['csp-missing-frame-ancestors', 'csp-missing-base-uri', 'csp-missing-object-src'].includes(i.code));
    const gaps = p.issues.filter(i => ['csp-missing-frame-ancestors', 'csp-missing-base-uri', 'csp-missing-object-src'].includes(i.code));
    if (bad.length) items.push(item('csp', 'misconfigured', bad.some(i => /unsafe|wildcard|broad|no-script/.test(i.code)) ? 'high' : 'medium', 'Content-Security-Policy', 'CSP has weaknesses', bad.map(i => i.message).join(' '), 'Remove unsafe-inline/unsafe-eval and wildcards; use nonces or hashes with strict-dynamic.'));
    else items.push(item('csp', 'ok', 'info', 'Content-Security-Policy', 'CSP present', 'A Content-Security-Policy is set and no obvious weaknesses were found in script sources.'));
    for (const g of gaps) items.push(item(g.code, 'misconfigured', 'low', 'Content-Security-Policy', g.code === 'csp-missing-object-src' ? 'CSP: object-src not restricted' : g.code === 'csp-missing-base-uri' ? 'CSP: base-uri not set' : 'CSP: frame-ancestors not set', g.message, 'Add the missing directive.'));
  } else if (cspRo) items.push(item('csp', 'missing', 'medium', 'Content-Security-Policy', 'Only a Report-Only CSP', 'Content-Security-Policy-Report-Only reports violations but does not enforce anything.', 'Move to an enforced Content-Security-Policy once the reports are clean.'));
  else items.push(item('csp', 'missing', isHtml ? 'medium' : 'low', 'Content-Security-Policy', 'No Content-Security-Policy', 'No CSP: injected scripts are not restricted by the browser.' + (isHtml ? '' : ' (Less relevant for non-HTML responses such as JSON APIs.)'), "Start with e.g. default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'."));

  // HSTS
  const hsts = get('strict-transport-security');
  if (hsts) {
    const p = parseHsts(hsts.value);
    const errs = p.issues.filter(i => i.level === 'error'), warns = p.issues.filter(i => i.level === 'warn');
    if (errs.length) items.push(item('hsts', 'misconfigured', 'medium', 'Strict-Transport-Security', 'HSTS is invalid', errs.map(i => i.message).join(' '), 'Use e.g. max-age=31536000; includeSubDomains'));
    else if (warns.length) items.push(item('hsts', 'misconfigured', 'low', 'Strict-Transport-Security', 'HSTS could be stronger', warns.map(i => i.message).join(' '), 'Use max-age of at least 31536000.'));
    else items.push(item('hsts', 'ok', 'info', 'Strict-Transport-Security', 'HSTS present', `max-age ${humanSeconds(p.maxAge ?? 0)}${p.includeSubDomains ? ', includeSubDomains' : ''}${p.preload ? ', preload' : ''}.`));
    if (https === 'no') items.push(item('hsts-http', 'info', 'info', 'Strict-Transport-Security', 'HSTS over HTTP is ignored', 'You marked the response as served over HTTP; browsers ignore HSTS there.'));
  } else if (httpsOk) items.push(item('hsts', 'missing', 'medium', 'Strict-Transport-Security', 'No HSTS', `Browsers will keep allowing plain-HTTP first visits.${https === 'unknown' ? ' (Only relevant if the site is served over HTTPS.)' : ''}`, 'Add Strict-Transport-Security: max-age=31536000; includeSubDomains once all subdomains support HTTPS.'));
  else items.push(item('hsts', 'info', 'info', 'Strict-Transport-Security', 'HSTS not applicable', 'The response is marked as plain HTTP; HSTS only works over HTTPS.'));

  // nosniff
  const xcto = get('x-content-type-options');
  if (!xcto) items.push(item('nosniff', 'missing', 'low', 'X-Content-Type-Options', 'No X-Content-Type-Options', 'Browsers may MIME-sniff responses and execute uploaded content as script or HTML.', 'Add X-Content-Type-Options: nosniff'));
  else if (xcto.value.trim().toLowerCase() !== 'nosniff') items.push(item('nosniff', 'misconfigured', 'low', 'X-Content-Type-Options', 'Invalid X-Content-Type-Options', `Value "${xcto.value.slice(0, 40)}" is not "nosniff".`, 'Use exactly: nosniff'));
  else items.push(item('nosniff', 'ok', 'info', 'X-Content-Type-Options', 'nosniff set', 'MIME sniffing is disabled.'));

  // clickjacking
  const xfo = get('x-frame-options');
  const cspFa = csp ? parseCsp(csp.value).policies.some(p => p.get('frame-ancestors')) : false;
  if (cspFa) items.push(item('framing', 'ok', 'info', 'Content-Security-Policy', 'Framing restricted via frame-ancestors', 'CSP frame-ancestors controls who may embed the page.'));
  else if (xfo) {
    const ex = explainXfo(xfo.value);
    if (ex.issues.some(i => i.level !== 'info')) items.push(item('framing', 'misconfigured', 'medium', 'X-Frame-Options', 'X-Frame-Options is not effective', ex.issues.map(i => i.message).join(' '), 'Use X-Frame-Options: DENY or SAMEORIGIN, or CSP frame-ancestors.'));
    else items.push(item('framing', 'ok', 'info', 'X-Frame-Options', 'Framing restricted', ex.summary));
  } else items.push(item('framing', 'missing', isHtml ? 'medium' : 'low', 'X-Frame-Options', 'No clickjacking protection', 'Neither X-Frame-Options nor CSP frame-ancestors is set, so other sites can embed this page in a frame.', "Add Content-Security-Policy: frame-ancestors 'self' (and optionally X-Frame-Options: SAMEORIGIN for old browsers)."));

  // referrer
  const rp = get('referrer-policy');
  if (!rp) items.push(item('referrer', 'missing', 'low', 'Referrer-Policy', 'No Referrer-Policy', 'Browsers default to strict-origin-when-cross-origin, but older ones may leak full URLs.', 'Add Referrer-Policy: strict-origin-when-cross-origin (or no-referrer).'));
  else { const p = parseReferrerPolicy(rp.value); if (p.issues.some(i => i.level !== 'info')) items.push(item('referrer', 'misconfigured', 'low', 'Referrer-Policy', 'Referrer-Policy needs attention', p.issues.filter(i => i.level !== 'info').map(i => i.message).join(' '), 'Use strict-origin-when-cross-origin or stricter.')); else items.push(item('referrer', 'ok', 'info', 'Referrer-Policy', 'Referrer-Policy set', REFERRER_POLICIES[p.effective])); }

  // permissions policy
  const pp = get('permissions-policy'), fp = get('feature-policy');
  if (pp) { const p = parsePermissionsPolicy(pp.value); if (p.issues.some(i => i.level !== 'info')) items.push(item('permissions', 'misconfigured', 'low', 'Permissions-Policy', 'Permissions-Policy needs attention', p.issues.map(i => i.message).join(' '), 'Fix the syntax: feature=(allowlist).')); else items.push(item('permissions', 'ok', 'info', 'Permissions-Policy', 'Permissions-Policy set', `${p.features.length} feature(s) configured.`)); }
  else items.push(item('permissions', 'missing', 'info', 'Permissions-Policy', 'No Permissions-Policy', 'Optional: disables powerful browser features (camera, microphone, geolocation) you do not use.', 'Add e.g. Permissions-Policy: camera=(), microphone=(), geolocation=()'));
  if (fp) items.push(item('feature-policy', 'misconfigured', 'info', 'Feature-Policy', 'Feature-Policy is deprecated', 'Replaced by Permissions-Policy.', 'Migrate to Permissions-Policy.'));

  // XSS
  const xxss = get('x-xss-protection');
  if (xxss) { const e = explainXss(xxss.value); if (e.issues.some(i => i.level === 'warn')) items.push(item('xxss', 'misconfigured', 'low', 'X-XSS-Protection', 'Deprecated X-XSS-Protection enabled', e.issues[0].message, 'Send X-XSS-Protection: 0 or remove it.')); else items.push(item('xxss', 'ok', 'info', 'X-XSS-Protection', 'X-XSS-Protection disabled', 'Set to 0, as recommended.')); }
  else items.push(item('xxss', 'ok', 'info', 'X-XSS-Protection', 'X-XSS-Protection absent', 'Good: the header is deprecated and should be absent (or 0).'));

  // isolation
  for (const [n, valid] of [['cross-origin-opener-policy', 'COOP'], ['cross-origin-embedder-policy', 'COEP'], ['cross-origin-resource-policy', 'CORP']]) {
    const r = get(n);
    if (r) { const e = explainIsolation(n, r.value); if (e.issues.some(i => i.level === 'error')) items.push(item(n, 'misconfigured', 'low', r.name, `${valid} is invalid`, e.issues[0].message)); else items.push(item(n, 'ok', 'info', r.name, `${valid} set`, e.summary)); }
    else items.push(item(n, 'missing', 'info', n.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('-'), `No ${valid}`, valid === 'CORP' ? 'Optional: stops other sites from loading this resource (Spectre-style leaks).' : 'Optional: only needed for cross-origin isolation or extra popup isolation.'));
  }

  // information leaks
  for (const n of ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator', 'x-runtime']) {
    for (const r of all(n)) {
      const version = /\d+(\.\d+)+|\/\d/.test(r.value);
      if (n === 'server' && !version) items.push(item('leak-server', 'info', 'info', r.name, 'Server header without version', `"${r.value}" names the software but not its version.`));
      else items.push(item(`leak-${n}`, 'leak', version || n !== 'server' ? 'low' : 'info', r.name, `${r.name} discloses technology`, `"${r.value.slice(0, 80)}" helps attackers fingerprint the stack${version ? ' and pick known vulnerabilities for that version' : ''}.`, n === 'server' ? 'Remove the version number (or the header).' : 'Remove this header.'));
    }
  }

  // cookies
  for (const r of all('set-cookie')) {
    const c = parseSetCookie(r.value);
    const sensitive = /sess|auth|token|jwt|sid|login|csrf|xsrf/i.test(c.name) || c.name.toLowerCase().startsWith('__host-') || c.name.toLowerCase().startsWith('__secure-');
    const probs = c.issues.filter(i => ['cookie-none-no-secure', 'cookie-prefix-secure', 'cookie-prefix-host', 'cookie-partitioned-no-secure', 'cookie-samesite-invalid', 'cookie-no-equals', 'cookie-too-large'].includes(i.code) || (i.code === 'cookie-no-secure' && httpsOk) || i.code === 'cookie-no-httponly');
    if (!probs.length) { items.push(item(`cookie-${c.name}`, 'ok', 'info', 'Set-Cookie', `Cookie "${c.name}" looks fine`, 'Secure, HttpOnly and SameSite attributes look reasonable.')); continue; }
    for (const p of probs) {
      const sev = ['cookie-none-no-secure', 'cookie-prefix-secure', 'cookie-prefix-host', 'cookie-partitioned-no-secure'].includes(p.code) ? 'high' : p.code === 'cookie-no-httponly' ? (sensitive ? 'medium' : 'low') : p.code === 'cookie-no-secure' ? (sensitive ? 'medium' : 'low') : 'medium';
      items.push(item(`${p.code}-${c.name}`, 'misconfigured', sev, 'Set-Cookie', `Cookie "${c.name}": ${p.code.replace('cookie-', '').replace(/-/g, ' ')}`, p.message, 'Set Secure; HttpOnly; SameSite=Lax (or Strict) unless scripts must read it.'));
    }
  }

  // CORS
  const ao = get('access-control-allow-origin'), acac = get('access-control-allow-credentials');
  if (ao) {
    const v = ao.value.trim();
    if (v === '*' && acac?.value.trim() === 'true') items.push(item('cors-wildcard-creds', 'misconfigured', 'high', 'Access-Control-Allow-Origin', 'Wildcard origin with credentials', 'Browsers reject "*" together with credentials, and echoing arbitrary origins to "fix" it would expose authenticated data.', 'Allow-list specific origins and send Vary: Origin.'));
    else if (v === '*') items.push(item('cors-wildcard', 'info', 'info', 'Access-Control-Allow-Origin', 'Any origin may read this response', 'Fine for public, unauthenticated data; wrong for anything personalised.'));
    else if (v === 'null') items.push(item('cors-null', 'misconfigured', 'medium', 'Access-Control-Allow-Origin', 'Origin "null" allowed', 'Sandboxed iframes and local files send Origin: null; allowing it is almost as open as "*".', 'Remove it.'));
    else {
      const vary = all('vary').flatMap(r => splitTop(r.value).map(x => x.toLowerCase()));
      if (!vary.includes('origin') && !vary.includes('*')) items.push(item('cors-vary', 'misconfigured', 'low', 'Vary', 'Missing Vary: Origin', 'The allowed origin varies per request but caches are not told, so a cached response may be served to the wrong site.', 'Add Vary: Origin'));
      else items.push(item('cors-ok', 'ok', 'info', 'Access-Control-Allow-Origin', 'CORS origin is specific', `Only ${v} is allowed and Vary: Origin is present.`));
    }
  }

  // caching
  const cc = get('cache-control'), hasCookie = all('set-cookie').length > 0;
  if (cc) {
    const p = parseCacheControl(cc.value);
    const bad = p.issues.filter(i => ['cc-conflict', 'cc-bad-number', 'cc-duplicate'].includes(i.code));
    if (bad.length) items.push(item('cache-conflict', 'misconfigured', 'low', 'Cache-Control', 'Contradictory or invalid Cache-Control', bad.map(i => i.message).join(' '), 'Remove the contradictory directives.'));
    if (hasCookie && p.map.public) items.push(item('cache-public-cookie', 'misconfigured', 'medium', 'Cache-Control', 'public response sets a cookie', 'A shared cache could store and replay a response that sets a personal cookie.', 'Use private or no-store for responses that set cookies.'));
    if (hasCookie && !p.map['no-store'] && !p.map.private && !p.map['no-cache'] && !p.map.public && p.maxAge) items.push(item('cache-cookie-fresh', 'misconfigured', 'low', 'Cache-Control', 'Cacheable response sets a cookie', 'A cacheable response with Set-Cookie may be shared between users by CDNs.', 'Add private or no-store.'));
  } else if (hasCookie) items.push(item('cache-missing-cookie', 'missing', 'low', 'Cache-Control', 'Set-Cookie without Cache-Control', 'Responses that set cookies should say how shared caches may treat them.', 'Add Cache-Control: private, no-store (or an appropriate policy).'));
  else items.push(item('cache-missing', 'info', 'info', 'Cache-Control', 'No Cache-Control', 'Caches will apply heuristic freshness (often 10% of the age since Last-Modified). Sensitive pages should send no-store.', 'Add an explicit Cache-Control policy.'));
  const pragma = get('pragma'), exp = get('expires');
  if (exp && cc && parseCacheControl(cc.value).map['no-store'] === undefined) { const ex = explainDate('expires', exp.value, { now }); if (ex.issues.some(i => i.code === 'date-invalid')) items.push(item('expires-invalid', 'info', 'info', 'Expires', 'Invalid Expires', 'An invalid Expires is treated as already expired.')); }
  if (pragma) items.push(item('pragma', 'info', 'info', 'Pragma', 'Legacy Pragma header', 'Pragma is deprecated; rely on Cache-Control.'));

  // deprecated security headers
  for (const n of ['expect-ct', 'public-key-pins', 'public-key-pins-report-only', 'x-download-options', 'x-permitted-cross-domain-policies', 'report-to']) {
    const r = get(n); if (r) items.push(item(`deprecated-${n}`, 'info', 'info', r.name, `${r.name} is obsolete`, HEADER_DB[n]?.note || 'Deprecated header.'));
  }
  if (get('public-key-pins')) items.push(item('hpkp', 'misconfigured', 'medium', 'Public-Key-Pins', 'HPKP can lock users out', 'Public key pinning was removed from browsers because a mistake can make a site unreachable.', 'Remove it.'));

  return { items, disclaimer: SECURITY_DISCLAIMER, counts: countItems(items) };
}
function countItems(items) {
  const c = { ok: 0, missing: 0, misconfigured: 0, leak: 0, info: 0 };
  for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
  return c;
}

// ---------------------------------------------------------------- reports
const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const mdEsc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/** Plain object report (JSON friendly). */
export function buildReportObject(a) {
  return {
    tool: 'Developer Toolbox - HTTP Header Analyzer',
    mode: a.mode,
    startLine: a.startLine ? a.startLine.raw : null,
    https: a.opts?.https,
    valuesMasked: a.opts?.mask,
    notes: a.notes,
    syntaxIssues: a.issues.map(i => ({ level: i.level, code: i.code, line: i.line ?? null, message: i.message })),
    headers: a.rows.map(r => ({ name: r.name, value: a.opts?.mask === false ? r.value : r.display, category: r.category, description: r.description, note: r.note || undefined, summary: r.summary || undefined,
      issues: r.issues.filter(i => i.level !== 'info' || true).map(i => ({ level: i.level, code: i.code, message: i.message })) })),
    crossChecks: a.cross.map(i => ({ level: i.level, code: i.code, header: i.header, message: i.message })),
    securityReview: a.security ? { disclaimer: a.security.disclaimer, items: a.security.items } : null,
  };
}
export const buildReportJson = a => JSON.stringify(buildReportObject(a), null, 2);
export function buildReportMarkdown(a) {
  const o = buildReportObject(a), L = [];
  L.push('# HTTP header analysis', '');
  L.push(`- Mode: **${o.mode}**${o.startLine ? ` (\`${o.startLine}\`)` : ''}`, `- Headers: ${o.headers.length}`, `- Sensitive values masked: ${o.valuesMasked ? 'yes' : 'no'}`);
  for (const n of o.notes) L.push(`- Note: ${n}`);
  L.push('');
  if (o.syntaxIssues.length) { L.push('## Syntax issues', ''); for (const i of [...o.syntaxIssues].sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level])) L.push(`- **${i.level}**${i.line ? ` (line ${i.line})` : ''}: ${i.message}`); L.push(''); }
  L.push('## Headers', '', '| Name | Value | Category | Meaning |', '| --- | --- | --- | --- |');
  for (const h of o.headers) L.push(`| ${mdEsc(h.name)} | \`${mdEsc(h.value).replace(/`/g, "'")}\` | ${mdEsc(h.category)} | ${mdEsc(h.summary || h.description)} |`);
  L.push('');
  const findings = o.headers.flatMap(h => h.issues.filter(i => i.level !== 'info').map(i => ({ ...i, header: h.name })));
  if (findings.length) { L.push('## Findings', ''); for (const f of findings.sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level])) L.push(`- **${f.level}** \`${f.header}\`: ${f.message}`); L.push(''); }
  if (o.crossChecks.length) { L.push('## Cross-header checks', ''); for (const i of o.crossChecks) L.push(`- **${i.level}**${i.header ? ` \`${i.header}\`` : ''}: ${i.message}`); L.push(''); }
  if (o.securityReview) {
    L.push('## Security review (response headers)', '', `> ${o.securityReview.disclaimer}`, '');
    L.push('| Status | Severity | Header | Finding |', '| --- | --- | --- | --- |');
    for (const i of o.securityReview.items) L.push(`| ${i.status} | ${i.severity} | ${mdEsc(i.header)} | ${mdEsc(i.title)}: ${mdEsc(i.message)}${i.recommendation ? ` Recommendation: ${mdEsc(i.recommendation)}` : ''} |`);
    L.push('');
  }
  return L.join('\n');
}
