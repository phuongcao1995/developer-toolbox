// JWT signature verification (WebCrypto) and a separate claims check. No DOM, nothing is stored.
// Verification answers ONE question: "was this token signed by the holder of this key?". It never validates claims.
import { base64urlToBytes } from './logic.js';

export const CLAIMS_DISCLAIMER = 'This checks the signature only. It does not validate exp, nbf, iss, aud or any other claim, and it does not prove the key itself is the one you should trust.';

const HASH = { 256: 'SHA-256', 384: 'SHA-384', 512: 'SHA-512' };
const CURVES = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' };
const SIG_BYTES = { ES256: 64, ES384: 96, ES512: 132 }; // raw r||s, as JWT (RFC 7518 3.4) requires

/** Algorithm family of a JWT alg string: 'HS' | 'RS' | 'PS' | 'ES' | null. */
export function algFamily(alg) {
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(String(alg));
  return m ? m[1] : null;
}

export const FAMILY_NEEDS = {
  HS: 'a shared secret (HMAC)',
  RS: 'an RSA public key (PEM "PUBLIC KEY" or JWK)',
  PS: 'an RSA public key (PEM "PUBLIC KEY" or JWK)',
  ES: 'an EC public key on the matching curve (PEM "PUBLIC KEY" or JWK)',
};

const result = (status, reason, extra = {}) => ({ status, reason, ...extra });
const looksLikePem = t => /-----BEGIN [A-Z0-9 ]+-----/.test(t);
const looksLikeJwk = t => /^\s*\{/.test(t);

function pemToDer(pem) {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!m) throw new Error('The PEM block is malformed (missing matching BEGIN/END lines).');
  const label = m[1];
  if (/PRIVATE KEY/.test(label)) throw new Error('That is a PRIVATE key. Never paste private keys here; paste the matching PUBLIC key (PEM "PUBLIC KEY").');
  if (label === 'CERTIFICATE') throw new Error('X.509 certificates are not supported. Extract the public key first (openssl x509 -pubkey -noout -in cert.pem).');
  if (label === 'RSA PUBLIC KEY') throw new Error('PKCS#1 "RSA PUBLIC KEY" is not supported. Convert it to SPKI: openssl rsa -RSAPublicKey_in -pubout.');
  if (label !== 'PUBLIC KEY') throw new Error(`Unsupported PEM type "${label}". Expected "PUBLIC KEY" (SPKI).`);
  const b64 = m[2].replace(/\s+/g, '');
  let bin;
  try { bin = atob(b64); } catch { throw new Error('The PEM body is not valid Base64.'); }
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function parseJwk(text) {
  let jwk;
  try { jwk = JSON.parse(text); } catch (e) { throw new Error(`The JWK is not valid JSON: ${e.message}`); }
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw new Error('A JWK must be a JSON object.');
  if (Array.isArray(jwk.keys)) {
    if (jwk.keys.length !== 1) throw new Error('This is a JWK Set with several keys. Paste the single JWK that matches the token\'s "kid".');
    jwk = jwk.keys[0];
  }
  return jwk;
}

/**
 * Verify a JWT signature.
 * key: { text, secretEncoding: 'utf8' | 'base64url' }  (text is a secret for HS*, or a PEM/JWK public key otherwise)
 * Returns { status: 'valid' | 'invalid' | 'error', reason, alg, warnings[] }:
 *   valid   = the signature matches this key (claims NOT checked)
 *   invalid = the key is fine but the signature does not match (or the token is unsigned / alg none)
 *   error   = could not verify (bad key, wrong key type, malformed token, ...)
 */
export async function verifyJwt(token, key, cryptoObj = globalThis.crypto) {
  const warnings = [];
  const subtle = cryptoObj && cryptoObj.subtle;
  if (!subtle) return result('error', 'Web Crypto (crypto.subtle) is not available. Open this page over HTTPS or localhost.', { warnings });
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return result('error', `Expected 3 dot-separated parts but found ${parts.length}.`, { warnings });
  let header;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(parts[0]))); }
  catch { return result('error', 'The header could not be decoded.', { warnings }); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return result('error', 'The header is not a JSON object.', { warnings });
  const alg = header.alg;
  if (typeof alg !== 'string') return result('error', 'The header "alg" is missing or not a string.', { warnings });
  if (alg.toLowerCase() === 'none') return result('invalid', 'alg is "none": the token is unsigned, so there is no signature to verify. It is never valid.', { alg, warnings });
  const family = algFamily(alg);
  if (!family) return result('error', `Unsupported algorithm "${alg}". Supported: HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512.`, { alg, warnings });
  if (!parts[2]) return result('invalid', `The signature segment is empty although alg is "${alg}".`, { alg, warnings });

  let sig;
  try { sig = base64urlToBytes(parts[2]); } catch (e) { return result('error', `The signature ${e.message}.`, { alg, warnings }); }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const hashName = HASH[alg.slice(2)];
  const text = String(key?.text ?? '');
  if (!text.trim()) return result('error', `Enter ${FAMILY_NEEDS[family]} to verify an ${alg} token.`, { alg, warnings });

  try {
    if (family === 'HS') {
      // Algorithm-confusion guard: a public key (PEM/JWK) must never be used as an HMAC secret.
      let secret;
      if (looksLikePem(text)) {
        return result('error', 'Refused: an HS* token needs a shared secret, but a PEM key was supplied. Using a public key as the HMAC secret is the classic algorithm-confusion attack (an attacker re-signs an RS256 token as HS256 with the public key). Paste the real shared secret.', { alg, warnings, confusion: true });
      }
      if (looksLikeJwk(text)) {
        const jwk = parseJwk(text);
        if (jwk.kty !== 'oct') return result('error', `Refused: an HS* token needs a symmetric key (JWK kty "oct") but the JWK has kty "${jwk.kty}". Using an asymmetric key as an HMAC secret is the algorithm-confusion attack.`, { alg, warnings, confusion: true });
        if (jwk.alg && jwk.alg !== alg) return result('error', `The JWK says alg "${jwk.alg}" but the token uses "${alg}".`, { alg, warnings });
        if (typeof jwk.k !== 'string') return result('error', 'The JWK has no "k" member.', { alg, warnings });
        secret = base64urlToBytes(jwk.k);
      } else if (key?.secretEncoding === 'base64url') {
        try { secret = base64urlToBytes(text.trim()); } catch (e) { return result('error', `The secret is not valid base64url: ${e.message}.`, { alg, warnings }); }
      } else {
        secret = new TextEncoder().encode(text.replace(/\r?\n$/, ''));
      }
      if (!secret.length) return result('error', 'The secret is empty.', { alg, warnings });
      if (secret.length < Number(alg.slice(2)) / 8) warnings.push(`The secret is ${secret.length} bytes, shorter than the ${Number(alg.slice(2)) / 8} bytes RFC 7518 recommends for ${alg}.`);
      const k = await subtle.importKey('raw', secret, { name: 'HMAC', hash: hashName }, false, ['verify']);
      // subtle.verify compares in constant time (no early exit on the first differing byte).
      const ok = await subtle.verify('HMAC', k, sig, data);
      return ok ? result('valid', `The HMAC matches this secret (${alg}).`, { alg, warnings })
        : result('invalid', 'The signature does not match this secret and token. The token was altered or signed with a different key.', { alg, warnings });
    }

    // Asymmetric: need a PUBLIC key of the right family.
    if (!looksLikePem(text) && !looksLikeJwk(text)) {
      return result('error', `${alg} needs ${FAMILY_NEEDS[family]}, but the key does not look like a PEM or JWK. A shared secret cannot verify an ${alg} token.`, { alg, warnings, confusion: true });
    }
    const importAlg = family === 'RS' ? { name: 'RSASSA-PKCS1-v1_5', hash: hashName }
      : family === 'PS' ? { name: 'RSA-PSS', hash: hashName }
        : { name: 'ECDSA', namedCurve: CURVES[alg] };
    let publicKey;
    if (looksLikeJwk(text)) {
      const jwk = parseJwk(text);
      if (jwk.d !== undefined || jwk.p !== undefined || jwk.q !== undefined) return result('error', 'That JWK contains PRIVATE key material. Never paste private keys; remove "d", "p", "q", ... and paste only the public JWK.', { alg, warnings });
      const wantKty = family === 'ES' ? 'EC' : 'RSA';
      if (jwk.kty === 'oct') return result('error', `Key type mismatch: ${alg} needs a ${wantKty} public key but the JWK is a symmetric "oct" key.`, { alg, warnings, confusion: true });
      if (jwk.kty !== wantKty) return result('error', `Key type mismatch: ${alg} needs a ${wantKty} key but the JWK has kty "${jwk.kty}".`, { alg, warnings });
      if (family === 'ES' && jwk.crv !== CURVES[alg]) return result('error', `Curve mismatch: ${alg} needs ${CURVES[alg]} but the JWK uses ${jwk.crv}.`, { alg, warnings });
      if (jwk.alg && jwk.alg !== alg) return result('error', `The JWK says alg "${jwk.alg}" but the token uses "${alg}".`, { alg, warnings });
      if (jwk.use && jwk.use !== 'sig') return result('error', `The JWK has use "${jwk.use}", not "sig".`, { alg, warnings });
      const clean = { kty: jwk.kty, ext: true, ...(family === 'ES' ? { crv: jwk.crv, x: jwk.x, y: jwk.y } : { n: jwk.n, e: jwk.e }) };
      try { publicKey = await subtle.importKey('jwk', clean, importAlg, false, ['verify']); }
      catch (e) { return result('error', `The JWK could not be imported for ${alg}: ${e.message || 'invalid key'}.`, { alg, warnings }); }
    } else {
      const der = pemToDer(text);
      try { publicKey = await subtle.importKey('spki', der, importAlg, false, ['verify']); }
      catch (e) { return result('error', `The PEM public key does not fit ${alg} (${family === 'ES' ? `expected an EC ${CURVES[alg]} key` : 'expected an RSA key'}): ${e.message || 'import failed'}.`, { alg, warnings, confusion: true }); }
    }
    if (family !== 'ES' && publicKey.algorithm.modulusLength < 2048) warnings.push(`The RSA key is only ${publicKey.algorithm.modulusLength} bits; 2048 or more is expected.`);
    if (family === 'ES' && sig.length !== SIG_BYTES[alg]) {
      return result('invalid', `An ${alg} signature must be exactly ${SIG_BYTES[alg]} bytes (raw r||s) but this one is ${sig.length}. If it came from OpenSSL it may be DER-encoded; JWT does not use DER.`, { alg, warnings });
    }
    const verifyAlg = family === 'RS' ? 'RSASSA-PKCS1-v1_5' : family === 'PS' ? { name: 'RSA-PSS', saltLength: Number(alg.slice(2)) / 8 } : { name: 'ECDSA', hash: hashName };
    const ok = await subtle.verify(verifyAlg, publicKey, sig, data);
    return ok ? result('valid', `The signature matches this public key (${alg}).`, { alg, warnings })
      : result('invalid', 'The signature does not match this public key and token. The token was altered or signed with a different key.', { alg, warnings });
  } catch (e) {
    return result('error', e && e.message ? e.message : 'Verification failed.', { alg, warnings });
  }
}

/**
 * Separate claims check. Independent of the signature result.
 * expected: { iss?: string, aud?: string }  leeway in seconds. Returns { items: [{claim, status, message}], failed: number }.
 * status: 'ok' | 'fail' | 'skipped'
 */
export function checkClaims(payload, now = Date.now() / 1000, expected = {}, leeway = 0) {
  const items = [];
  const add = (claim, status, message) => items.push({ claim, status, message });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { items: [{ claim: '-', status: 'fail', message: 'The payload is not a JSON object, so there are no claims to check.' }], failed: 1 };
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  if ('exp' in payload) {
    if (!isNum(payload.exp)) add('exp', 'fail', '"exp" is not a number.');
    else if (now > payload.exp + leeway) add('exp', 'fail', `Expired ${Math.round(now - payload.exp)} s ago.`);
    else add('exp', 'ok', 'Not expired.');
  } else add('exp', 'skipped', 'No "exp" claim: the token never expires by its claims.');
  if ('nbf' in payload) {
    if (!isNum(payload.nbf)) add('nbf', 'fail', '"nbf" is not a number.');
    else if (now + leeway < payload.nbf) add('nbf', 'fail', `Not valid yet (starts in ${Math.round(payload.nbf - now)} s).`);
    else add('nbf', 'ok', 'Already valid.');
  } else add('nbf', 'skipped', 'No "nbf" claim.');
  if ('iat' in payload) {
    if (!isNum(payload.iat)) add('iat', 'fail', '"iat" is not a number.');
    else if (payload.iat > now + 60 + leeway) add('iat', 'fail', 'Issued in the future.');
    else add('iat', 'ok', 'Issued in the past.');
  } else add('iat', 'skipped', 'No "iat" claim.');
  const iss = String(expected.iss ?? '').trim();
  if (!iss) add('iss', 'skipped', 'No expected issuer entered, so "iss" was not checked.');
  else if (typeof payload.iss !== 'string') add('iss', 'fail', `The token has no string "iss" (expected "${iss}").`);
  else if (payload.iss === iss) add('iss', 'ok', 'Matches the expected issuer.');
  else add('iss', 'fail', `The issuer is "${payload.iss}", expected "${iss}".`);
  const aud = String(expected.aud ?? '').trim();
  if (!aud) add('aud', 'skipped', 'No expected audience entered, so "aud" was not checked.');
  else {
    const list = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud];
    if (list.includes(aud)) add('aud', 'ok', 'The audience list contains the expected value.');
    else add('aud', 'fail', `The audience is ${JSON.stringify(payload.aud ?? null)}, expected "${aud}".`);
  }
  return { items, failed: items.filter(i => i.status === 'fail').length };
}
