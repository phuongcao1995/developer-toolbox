// Pure URL encode/decode/parse/build helpers (no DOM).

/** Explain why decodeURI(Component) failed: find the first malformed % sequence. */
function describeUriError(input) {
  const m = /%(?![0-9A-Fa-f]{2})/.exec(input);
  if (m) {
    const frag = input.slice(m.index, m.index + 3);
    return `Malformed percent-sequence "${frag}" at position ${m.index + 1}: "%" must be followed by two hex digits (e.g. %20).`;
  }
  return 'Invalid UTF-8 percent-encoded sequence (for example a lone %E4 byte). The bytes after "%" do not form valid UTF-8 text.';
}

/** Encode with encodeURIComponent; `form` turns %20 into "+" (application/x-www-form-urlencoded). */
export function encodeComponent(str, { form = false } = {}) {
  let out;
  try { out = encodeURIComponent(str); }
  catch { throw new Error('Cannot encode: the text contains a lone surrogate (broken emoji/Unicode character).'); }
  return form ? out.replace(/%20/g, '+') : out;
}

/** Decode with decodeURIComponent; `form` first turns "+" into a space. Throws Error with a clear message. */
export function decodeComponent(str, { form = false } = {}) {
  const src = form ? str.replace(/\+/g, ' ') : str;
  try { return decodeURIComponent(src); }
  catch { throw new Error(describeUriError(src)); }
}

/** encodeURI: keeps reserved characters (: / ? # [ ] @ ! $ & ' ( ) * + , ; =) intact. */
export function encodeFull(str) {
  try { return encodeURI(str); }
  catch { throw new Error('Cannot encode: the text contains a lone surrogate (broken emoji/Unicode character).'); }
}

export function decodeFull(str) {
  try { return decodeURI(str); }
  catch { throw new Error(describeUriError(str)); }
}

// ---------- query string ----------

/** Safe decode that never throws (falls back to the raw text and flags it). */
function lenientDecode(s) {
  const t = s.replace(/\+/g, ' ');
  try { return { text: decodeURIComponent(t), bad: false }; } catch { return { text: t, bad: true }; }
}

/**
 * Parse a query string ("?a=1&a=2&b=&c") into ordered rows. Duplicates and empty values are kept;
 * `hasEq` remembers whether "=" was present so "c" and "c=" round-trip faithfully.
 */
export function parseQuery(search) {
  const q = String(search || '').replace(/^\?/, '');
  if (!q) return [];
  const rows = [];
  for (const seg of q.split('&')) {
    if (seg === '') continue;
    const i = seg.indexOf('=');
    const rawK = i < 0 ? seg : seg.slice(0, i);
    const rawV = i < 0 ? '' : seg.slice(i + 1);
    const k = lenientDecode(rawK), v = lenientDecode(rawV);
    rows.push({ key: k.text, value: v.text, hasEq: i >= 0, malformed: k.bad || v.bad });
  }
  return rows;
}

/** Build a query string (without "?") from rows. `spaceAsPlus` selects "+" instead of "%20". */
export function buildQuery(rows, { spaceAsPlus = false } = {}) {
  const enc = s => encodeComponent(s, { form: spaceAsPlus });
  return rows
    .filter(r => r.key !== '' || r.value !== '')
    .map(r => (r.value === '' && r.hasEq === false) ? enc(r.key) : `${enc(r.key)}=${enc(r.value)}`)
    .join('&');
}

// ---------- URL parsing ----------

export const URL_FIELDS = ['protocol', 'username', 'password', 'hostname', 'port', 'origin', 'pathname', 'search', 'hash'];

/**
 * Parse a URL. Returns { ok:true, fields, params, assumedHttps } or { ok:false, error, canAssumeHttps }.
 * With `assumeHttps`, input lacking a scheme gets "https://" prepended.
 */
export function parseUrl(input, { assumeHttps = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter a URL to parse.', canAssumeHttps: false };
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z0-9.-]+:\d+(\/|$|\?|#)/.test(raw);
  let text = raw, assumed = false;
  if (!hasScheme && assumeHttps) { text = 'https://' + raw.replace(/^\/\//, ''); assumed = true; }
  let u;
  try { u = new URL(text); }
  catch {
    return {
      ok: false,
      canAssumeHttps: !hasScheme && !assumeHttps,
      error: hasScheme
        ? 'This is not a valid URL (check the host, port and special characters).'
        : 'Relative or scheme-less URL: a protocol such as "https://" is required to parse it.',
    };
  }
  const fields = {};
  for (const f of URL_FIELDS) fields[f] = u[f];
  fields.origin = u.origin; // "null" for opaque origins such as mailto:
  fields.host = u.host;
  fields.href = u.href;
  return { ok: true, fields, params: parseQuery(u.search), assumedHttps: assumed };
}

/** Rebuild a full URL string from parsed fields and (edited) params; everything else is preserved. */
export function buildUrl(fields, params, opts) {
  const q = buildQuery(params, opts);
  const auth = fields.username ? `${fields.username}${fields.password ? ':' + fields.password : ''}@` : '';
  const slashes = /^[a-z][a-z0-9+.-]*:\/\//i.test(fields.href || '') ? '//' : '';
  const host = fields.host ?? (fields.hostname + (fields.port ? ':' + fields.port : ''));
  const hash = fields.hash && fields.hash !== '#' ? fields.hash : '';
  return `${fields.protocol}${slashes}${auth}${host}${fields.pathname}${q ? '?' + q : ''}${hash}`;
}
