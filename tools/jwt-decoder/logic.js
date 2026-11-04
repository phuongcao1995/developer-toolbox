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

/** True when whitespace INSIDE the token (not around it / after "Bearer ") had to be removed. */
export function hadInnerWhitespace(input) {
  const s = String(input ?? '').trim().replace(/^authorization:\s*/i, '').replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '');
  return /\s/.test(s.trim());
}

/**
 * Decode a JWT string. Always returns an object; `ok` is true only when structure, header and payload are all fine.
 * { ok, errors[], parts, header:{ok,value,json,error}, payload:{...}, signature, alg }
 */
export function decodeJwt(input) {
  const token = cleanToken(input);
  const res = { ok: false, errors: [], whitespaceStripped: hadInnerWhitespace(input), token, parts: [], header: null, payload: null, signature: '', alg: null };
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
    if (res.alg === null && h && typeof h === 'object' && !Array.isArray(h)) {
      if (!('alg' in h)) res.errors.push('Header has no "alg" field.');
      else res.errors.push(`Header "alg" must be a string (e.g. "HS256") but is ${JSON.stringify(h.alg)} (${h.alg === null ? 'null' : typeof h.alg}). Treat this token as malformed.`);
    }
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

/** Duration in seconds -> two largest units: "1y 2d", "3d 4h", "2h 5m", "4m 3s", "45s". */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Math.abs(Number(totalSeconds) || 0)));
  const units = [['y', 31536000], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  for (let i = 0; i < units.length; i++) {
    const [name, size] = units[i];
    if (s >= size) {
      const n = Math.floor(s / size);
      const next = units[i + 1];
      const rest = next ? Math.floor((s % size) / next[1]) : 0;
      return rest ? `${n}${name} ${rest}${next[0]}` : `${n}${name}`;
    }
  }
  return '0s';
}

/** Live countdown text: "00:04:12", "1d 02:05:09". */
export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(Math.abs(Number(totalSeconds) || 0)));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${d ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(sec)}`;
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

export const SOON_SECONDS = 300;

/**
 * Evaluate time-based claims. `now` is epoch seconds.
 * State describes ONLY what the claims say - never that the signature or token is valid.
 * Returns {state: 'expired'|'soon'|'valid'|'none'|'notyet'|'invalid', label, items:[...]}
 */
export function evaluateTimes(payload, now = Date.now() / 1000) {
  const items = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { state: 'none', label: 'No claims', items };
  const spec = [['exp', ['expires in', 'expired']], ['iat', ['issues in', 'issued']], ['nbf', ['becomes valid in', 'became valid']], ['auth_time', ['authenticates in', 'authenticated']]];
  for (const [claim, verbs] of spec) if (claim in payload) items.push(describeTime(claim, payload[claim], now, verbs));
  const exp = items.find(i => i.claim === 'exp'), nbf = items.find(i => i.claim === 'nbf');
  let state = 'none', label = 'No expiration (exp) claim';
  if (exp && exp.valid) {
    if (exp.delta <= 0) { state = 'expired'; label = 'Expired'; }
    else if (exp.delta < SOON_SECONDS) { state = 'soon'; label = 'Expires soon'; }
    else { state = 'valid'; label = 'Not expired (per its claims)'; }
  } else if (exp) { state = 'invalid'; label = 'Invalid exp claim'; }
  if (nbf && nbf.valid && nbf.delta > 0 && state !== 'expired') { state = 'notyet'; label = 'Not valid yet (nbf in the future)'; }
  return { state, label, items };
}

// ---------- Claim documentation ----------
export const CLAIM_DOCS = {
  iss: 'Issuer - who created and signed the token.',
  sub: 'Subject - the principal the token is about (usually a user ID).',
  aud: 'Audience - who the token is intended for. Recipients must reject tokens not meant for them.',
  exp: 'Expiration time - the token must not be accepted on or after this time.',
  nbf: 'Not before - the token must not be accepted before this time.',
  iat: 'Issued at - when the token was issued.',
  jti: 'JWT ID - unique identifier, useful to detect replay.',
  scope: 'OAuth 2 scopes granted (space-separated string).',
  scp: 'Scopes granted (array or string, depending on the issuer).',
  azp: 'Authorized party - the client the token was issued to.',
  client_id: 'OAuth client identifier the token was issued to.',
  nonce: 'Value from the auth request that binds the token to a client session (replay protection).',
  auth_time: 'When the user actually authenticated.',
  at_hash: 'Hash of the access token (OpenID Connect).',
  c_hash: 'Hash of the authorization code (OpenID Connect).',
  email: 'Email address of the user.',
  email_verified: 'Whether the issuer says the email address was verified.',
  name: 'Full name of the user.',
  given_name: 'Given (first) name.',
  family_name: 'Family (last) name.',
  preferred_username: 'Shorthand name the user prefers.',
  picture: 'URL of the user profile picture.',
  locale: 'User locale, e.g. en-US.',
  roles: 'Roles assigned to the user.',
  groups: 'Groups the user belongs to.',
  permissions: 'Permissions granted.',
  acr: 'Authentication Context Class Reference - the assurance level achieved.',
  amr: 'Authentication Methods References - e.g. pwd, otp, mfa.',
  sid: 'Session ID.',
  cnf: 'Confirmation - key the token is bound to (proof-of-possession, e.g. DPoP / mTLS).',
  typ: 'Type of the token (e.g. JWT, at+jwt).',
  kid: 'Key ID - hints which key was used to sign.',
  alg: 'Signing algorithm.',
  cty: 'Content type - used for nested JWTs.',
  jku: 'URL of a JWK Set holding the signing key (verifiers must not trust it blindly).',
  jwk: 'Public key embedded in the header (verifiers must not trust it blindly).',
  x5u: 'URL of the X.509 certificate chain (verifiers must not trust it blindly).',
  x5c: 'Embedded X.509 certificate chain (verifiers must not trust it blindly).',
  x5t: 'SHA-1 thumbprint of the X.509 certificate.',
  'x5t#S256': 'SHA-256 thumbprint of the X.509 certificate.',
  crit: 'Critical header parameters the verifier must understand.',
  ver: 'Token version.',
  tid: 'Tenant ID.',
  oid: 'Object ID of the principal in the directory.',
  upn: 'User principal name.',
  hd: 'Hosted domain (Google Workspace).',
};

/** Description for a claim/header name, or '' when unknown (own properties only). */
export const claimDescription = name => (Object.prototype.hasOwnProperty.call(CLAIM_DOCS, name) ? CLAIM_DOCS[name] : '');

// ---------- Security / sanity warnings ----------
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };
const WEAK_ALGS = { RS1: 'uses SHA-1', HS1: 'uses SHA-1', ES1: 'uses SHA-1', RSA1_5: 'uses RSA PKCS#1 v1.5 encryption (known padding-oracle weaknesses)' };
const YEAR = 31536000;

/**
 * Inspect decoded header/payload (values, may be null) and the raw signature segment.
 * Returns [{severity:'critical'|'warning'|'info', code, message}] sorted by severity.
 * These are heuristics about the token's CONTENT; the signature is never verified here.
 */
export function securityWarnings(header, payload, signaturePart = '', now = Date.now() / 1000) {
  const out = [];
  const add = (severity, code, message) => out.push({ severity, code, message });
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const num = v => typeof v === 'number' && Number.isFinite(v);

  if (isObj(header)) {
    const alg = header.alg;
    if (typeof alg === 'string') {
      if (alg.toLowerCase() === 'none') add('critical', 'alg-none', 'Unsigned token ("alg": "none") - it carries no signature, so anyone can forge it. It must never be accepted.');
      else {
        if (!signaturePart) add('critical', 'empty-signature', `The signature segment is empty although alg is "${alg}". A verifier must reject this token.`);
        if (/^HS(256|384|512)$/i.test(alg)) add('info', 'hmac', `${alg} is symmetric (HMAC): the same shared secret signs and verifies, so any party able to verify can also forge tokens. Use a long, random secret.`);
        if (Object.prototype.hasOwnProperty.call(WEAK_ALGS, alg.toUpperCase())) add('warning', 'weak-alg', `Algorithm "${alg}" ${WEAK_ALGS[alg.toUpperCase()]} and is weak or legacy.`);
        else if (!/^(HS|RS|ES|PS)(256|384|512)$|^EdDSA$|^Ed(25519|448)$/i.test(alg)) add('warning', 'unknown-alg', `Unrecognised algorithm "${alg}". Verifiers should accept only an explicit allow-list of algorithms.`);
      }
    } else if ('alg' in header) {
      add('critical', 'alg-type', `Header "alg" must be a string but is ${JSON.stringify(header.alg)} (${header.alg === null ? 'null' : typeof header.alg}). The token is malformed and must be rejected.`);
    } else {
      add('critical', 'alg-missing', 'Header has no "alg" - the token is malformed and must be rejected.');
    }
    const injected = ['jku', 'x5u', 'jwk', 'x5c'].filter(k => k in header);
    if (injected.length) add('warning', 'key-injection', `Header contains ${injected.join(', ')}. Attackers use header-supplied keys or key URLs so a forged token verifies against their own key. Verifiers must not trust keys named by the token itself; use a pinned allow-list.`);
    if ('kid' in header) add('info', 'kid', 'Header has a "kid". If a server uses it unvalidated in a database query, file path or URL it can be abused for injection or path traversal.');
    if (!('typ' in header)) add('info', 'typ-missing', 'Header has no "typ" (informational only).');
  }

  if (isObj(payload)) {
    const { exp, iat, nbf } = payload;
    const ms = v => num(v) && v > 1e11;
    for (const [k, v] of [['exp', exp], ['iat', iat], ['nbf', nbf]]) {
      if (k in payload && !num(v)) add('warning', `${k}-type`, `"${k}" should be a number of seconds since the epoch but is ${JSON.stringify(v)}.`);
      else if (ms(v)) add('warning', `${k}-ms`, `"${k}" (${v}) looks like milliseconds, not seconds. Verifiers will read it as a date thousands of years away.`);
    }
    if (num(iat) && !ms(iat) && iat > now + 60) add('warning', 'iat-future', `"iat" is in the future (${formatDuration(iat - now)} from now) - clock skew or a forged token.`);
    if (num(nbf) && num(exp) && !ms(nbf) && !ms(exp) && nbf > exp) add('warning', 'nbf-after-exp', '"nbf" is later than "exp" - the token can never be valid.');
    if (num(iat) && num(exp) && !ms(iat) && !ms(exp)) {
      if (exp < iat) add('warning', 'exp-before-iat', '"exp" is earlier than "iat" - the token was already expired when issued.');
      else if (exp - iat > YEAR) add('warning', 'long-lived', `Very long lifetime (${formatDuration(exp - iat)}). Long-lived bearer tokens are risky if leaked.`);
    }
    if (!('exp' in payload)) add('info', 'exp-missing', 'No "exp" claim - the token never expires by its own claims.');
    if (!('iss' in payload)) add('info', 'iss-missing', 'No "iss" claim - the issuer cannot be checked.');
    if (!('aud' in payload)) add('info', 'aud-missing', 'No "aud" claim - the audience cannot be checked.');
  }
  return out.map((w, i) => ({ w, i })).sort((a, b) => SEV_ORDER[a.w.severity] - SEV_ORDER[b.w.severity] || a.i - b.i).map(x => x.w);
}

/** Build a demo token (alg HS256, bogus signature) valid for one hour from `now`. */
export function sampleToken(now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: '1234567890', name: 'Jane Dœ', admin: true, iat: now, nbf: now - 60, exp: now + 3600, iss: 'https://example.com' };
  return `${encodeJsonSegment(header)}.${encodeJsonSegment(payload)}.${base64urlEncode(new TextEncoder().encode('not-a-real-signature-demo'))}`;
}
