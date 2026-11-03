// Pure JWT helpers (no DOM). NOTE: decoding never verifies the signature.

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Decode a base64url segment to bytes. Throws Error with a specific reason. */
export function base64urlToBytes(seg) {
  const s = seg.replace(/=+$/, ''); // tolerate padding even though JWT forbids it
  if (!B64URL.test(s)) throw new Error('contains characters that are not valid base64url (A-Z a-z 0-9 - _)');
  if (s.length % 4 === 1) throw new Error('has an impossible base64url length');
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(std);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function base64urlEncode(bytes) {
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const encodeJsonSegment = obj => base64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));

/** Decode a segment into JSON (UTF-8 safe). Returns {ok, value, json} or {ok:false, error}. */
function decodeSegment(seg, label) {
  if (!seg) return { ok: false, error: `${label} segment is empty.` };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(seg));
  } catch (e) {
    const m = e.message || '';
    return { ok: false, error: /utf-?8|encoded data/i.test(m) ? `${label} is not valid UTF-8 text.` : `${label} ${m}.` };
  }
  try {
    const value = JSON.parse(text);
    return { ok: true, value, json: JSON.stringify(value, null, 2) };
  } catch (e) { return { ok: false, error: `${label} decoded but is not valid JSON: ${e.message}`, raw: text }; }
}

/** Strip whitespace/quotes and an optional "Bearer " prefix. */
export function cleanToken(input) {
  return String(input ?? '').trim().replace(/^authorization:\s*/i, '').replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').replace(/\s+/g, '');
}

/**
 * Decode a JWT string. Always returns an object; `ok` is true only when structure, header and payload are all fine.
 * { ok, errors[], parts, header:{ok,value,json,error}, payload:{...}, signature, alg }
 */
export function decodeJwt(input) {
  const token = cleanToken(input);
  const res = { ok: false, errors: [], token, parts: [], header: null, payload: null, signature: '', alg: null };
  if (!token) { res.errors.push('Paste a JWT to decode it.'); res.empty = true; return res; }
  const parts = token.split('.');
  res.parts = parts;
  if (parts.length !== 3) {
    res.errors.push(`A JWT has 3 dot-separated parts (header.payload.signature) but this has ${parts.length}.` +
      (parts.length === 5 ? ' Five parts usually means an encrypted JWE token, which cannot be decoded without the key.' : ''));
    if (parts.length < 2) return res;
  }
  res.header = decodeSegment(parts[0], 'Header');
  res.payload = decodeSegment(parts[1], 'Payload');
  res.signature = parts[2] ?? '';
  if (res.signature && !B64URL.test(res.signature.replace(/=+$/, ''))) res.errors.push('Signature contains characters that are not valid base64url.');
  if (!res.header.ok) res.errors.push(res.header.error);
  if (!res.payload.ok) res.errors.push(res.payload.error);
  if (res.header.ok) {
    const h = res.header.value;
    if (h && typeof h === 'object' && !Array.isArray(h)) res.alg = typeof h.alg === 'string' ? h.alg : null;
    else res.errors.push('Header JSON is not an object.');
    if (res.alg === null && h && typeof h === 'object') res.errors.push('Header has no "alg" field.');
  }
  if (res.payload.ok && !(res.payload.value && typeof res.payload.value === 'object' && !Array.isArray(res.payload.value))) {
    res.errors.push('Payload is valid JSON but not an object, so it has no claims.');
  }
  res.ok = res.errors.length === 0;
  return res;
}

// ---------- Time claims ----------
const pad = n => String(n).padStart(2, '0');
export function formatUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}
export function formatLocal(date) {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* ignore */ }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tz ? ` (${tz})` : ''}`;
}

/** Duration in seconds -> "2h 5m", "3 days", "45s". Uses the two largest meaningful units. */
export function formatDuration(totalSeconds) {
  let s = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  if (s < 60) return `${s}s`;
  const units = [['year', 31536000], ['day', 86400], ['h', 3600], ['m', 60]];
  for (let i = 0; i < units.length; i++) {
    const [name, size] = units[i];
    if (s >= size) {
      const n = Math.floor(s / size);
      if (name === 'year' || name === 'day') return `${n} ${name}${n === 1 ? '' : 's'}`;
      const [n2name, n2size] = units[i + 1] || [];
      const rest = n2name ? Math.floor((s % size) / n2size) : 0;
      return rest ? `${n}${name} ${rest}${n2name}` : `${n}${name}`;
    }
  }
  return `${s}s`;
}

/** Describe one NumericDate claim. verbs = [futureText, pastText] e.g. ['expires in', 'expired'] */
export function describeTime(claim, value, now, verbs) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { claim, valid: false, error: `"${claim}" should be a number (seconds since epoch), got ${JSON.stringify(value)}.` };
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return { claim, valid: false, error: `"${claim}" is out of range.` };
  const delta = value - now;
  const rel = Math.abs(delta) < 1 ? 'now' : delta > 0 ? `${verbs[0]} ${formatDuration(delta)}` : `${formatDuration(delta)} ago`.replace(/^/, `${verbs[1]} `);
  return { claim, valid: true, value, utc: formatUtc(date), local: formatLocal(date), relative: rel, delta };
}

/**
 * Evaluate time-based claims. `now` is epoch seconds.
 * Returns {state: 'expired'|'valid'|'none'|'notyet', label, items:[...]}
 */
export function evaluateTimes(payload, now = Date.now() / 1000) {
  const items = [];
  if (!payload || typeof payload !== 'object') return { state: 'none', label: 'No claims', items };
  const spec = [['exp', ['expires in', 'expired']], ['iat', ['issues in', 'issued']], ['nbf', ['becomes valid in', 'became valid']]];
  for (const [claim, verbs] of spec) if (claim in payload) items.push(describeTime(claim, payload[claim], now, verbs));
  const exp = items.find(i => i.claim === 'exp'), nbf = items.find(i => i.claim === 'nbf');
  let state = 'none', label = 'No expiration (exp) claim';
  if (exp && exp.valid) {
    if (exp.delta <= 0) { state = 'expired'; label = 'Expired'; } else { state = 'valid'; label = 'Not expired'; }
  } else if (exp) { label = 'Invalid exp claim'; }
  if (nbf && nbf.valid && nbf.delta > 0 && state !== 'expired') { state = 'notyet'; label = 'Not valid yet'; }
  return { state, label, items };
}

/** Build a demo token (alg HS256, bogus signature) valid for one hour from `now`. */
export function sampleToken(now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: '1234567890', name: 'Jane Dœ', admin: true, iat: now, nbf: now - 60, exp: now + 3600, iss: 'https://example.com' };
  return `${encodeJsonSegment(header)}.${encodeJsonSegment(payload)}.${base64urlEncode(new TextEncoder().encode('not-a-real-signature-demo'))}`;
}
