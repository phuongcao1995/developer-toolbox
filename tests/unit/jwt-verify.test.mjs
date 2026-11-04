// Run: node tests/unit/jwt-verify.test.mjs   (from the project root; uses Node's Web Crypto and node:crypto as an independent signer)
import assert from 'node:assert/strict';
import { webcrypto, createHmac, generateKeyPairSync, sign as nodeSign, constants } from 'node:crypto';
import { verifyJwt, checkClaims, algFamily } from '../../tools/jwt-decoder/verify.js';
import { base64urlEncode } from '../../tools/jwt-decoder/logic.js';

let pass = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); pass++; } catch (e) { failed++; process.exitCode = 1; console.error('FAIL', name, '\n  ', e.message); } };
const b64u = buf => Buffer.from(buf).toString('base64url');
const seg = o => b64u(JSON.stringify(o));
const verify = (token, key) => verifyJwt(token, key, webcrypto);
const signingInput = (alg, payload = { sub: '1', name: 'Jane' }, extra = {}) => `${seg({ alg, typ: 'JWT', ...extra })}.${seg(payload)}`;

// ---- known vectors ----
const JWT_IO = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
// RFC 7515 Appendix A.1 (HS256) with the JWK key from A.1.1
const RFC7515_TOKEN = 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7515_JWK = '{"kty":"oct","k":"AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow"}';

await test('jwt.io HS256 example verifies with its secret (UTF-8)', async () => {
  const r = await verify(JWT_IO, { text: 'your-256-bit-secret' });
  assert.equal(r.status, 'valid', r.reason);
  assert.ok(r.warnings.some(w => /shorter/.test(w)), 'short secret note');
});
await test('jwt.io example: wrong secret is invalid, one flipped payload char is invalid', async () => {
  assert.equal((await verify(JWT_IO, { text: 'your-256-bit-secreT' })).status, 'invalid');
  const parts = JWT_IO.split('.'); parts[1] = parts[1].replace('IiwibmFt', 'IiwibmFu');
  assert.equal((await verify(parts.join('.'), { text: 'your-256-bit-secret' })).status, 'invalid');
});
await test('RFC 7515 A.1 HS256 vector with JWK oct key', async () => {
  const r = await verify(RFC7515_TOKEN, { text: RFC7515_JWK });
  assert.equal(r.status, 'valid', r.reason);
});
await test('base64url secret mode', async () => {
  const k = Buffer.from('0123456789abcdef0123456789abcdef');
  const si = signingInput('HS256');
  const tok = `${si}.${b64u(createHmac('sha256', k).update(si).digest())}`;
  assert.equal((await verify(tok, { text: b64u(k), secretEncoding: 'base64url' })).status, 'valid');
  assert.equal((await verify(tok, { text: b64u(k), secretEncoding: 'utf8' })).status, 'invalid');
  assert.equal((await verify(tok, { text: '!!!', secretEncoding: 'base64url' })).status, 'error');
});
await test('HS384 / HS512 against node:crypto', async () => {
  for (const [alg, h] of [['HS384', 'sha384'], ['HS512', 'sha512']]) {
    const si = signingInput(alg);
    const tok = `${si}.${b64u(createHmac(h, 'secret').update(si).digest())}`;
    assert.equal((await verify(tok, { text: 'secret' })).status, 'valid', alg);
  }
});
await test('alg none is never valid, whatever the key', async () => {
  for (const a of ['none', 'None', 'NONE']) {
    const r = await verify(`${seg({ alg: a })}.${seg({ x: 1 })}.`, { text: 'secret' });
    assert.notEqual(r.status, 'valid'); assert.equal(r.status, 'invalid');
    const r2 = await verify(`${seg({ alg: a })}.${seg({ x: 1 })}.c2ln`, { text: '' });
    assert.notEqual(r2.status, 'valid');
  }
});
await test('empty signature and malformed tokens are not valid', async () => {
  assert.equal((await verify(`${seg({ alg: 'HS256' })}.${seg({})}.`, { text: 'k' })).status, 'invalid');
  assert.equal((await verify('abc', { text: 'k' })).status, 'error');
  assert.equal((await verify(`${seg({ alg: 'XX256' })}.${seg({})}.c2ln`, { text: 'k' })).status, 'error');
  assert.equal((await verify(`${seg({ alg: 5 })}.${seg({})}.c2ln`, { text: 'k' })).status, 'error');
  assert.equal((await verify(JWT_IO, { text: '' })).status, 'error');
});

// ---- RSA ----
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
const rsaJwk = JSON.stringify(rsa.publicKey.export({ format: 'jwk' }));
for (const [alg, hash] of [['RS256', 'sha256'], ['RS384', 'sha384'], ['RS512', 'sha512']]) {
  await test(`${alg} with PEM and JWK`, async () => {
    const si = signingInput(alg);
    const tok = `${si}.${b64u(nodeSign(hash, Buffer.from(si), rsa.privateKey))}`;
    assert.equal((await verify(tok, { text: rsaPem })).status, 'valid', alg + ' pem');
    assert.equal((await verify(tok, { text: rsaJwk })).status, 'valid', alg + ' jwk');
    const bad = tok.slice(0, -4) + (tok.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    assert.equal((await verify(bad, { text: rsaPem })).status, 'invalid');
  });
}
await test('PS256 (RSA-PSS)', async () => {
  const si = signingInput('PS256');
  const sig = nodeSign('sha256', Buffer.from(si), { key: rsa.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  assert.equal((await verify(`${si}.${b64u(sig)}`, { text: rsaPem })).status, 'valid');
});

// ---- ECDSA (raw r||s) ----
for (const [alg, curve, hash, len] of [['ES256', 'P-256', 'sha256', 64], ['ES384', 'P-384', 'sha384', 96], ['ES512', 'P-521', 'sha512', 132]]) {
  await test(`${alg} raw r||s signature with PEM and JWK`, async () => {
    const kp = generateKeyPairSync('ec', { namedCurve: curve });
    const si = signingInput(alg);
    const raw = nodeSign(hash, Buffer.from(si), { key: kp.privateKey, dsaEncoding: 'ieee-p1363' });
    assert.equal(raw.length, len);
    const tok = `${si}.${b64u(raw)}`;
    assert.equal((await verify(tok, { text: kp.publicKey.export({ type: 'spki', format: 'pem' }) })).status, 'valid', alg + ' pem');
    assert.equal((await verify(tok, { text: JSON.stringify(kp.publicKey.export({ format: 'jwk' })) })).status, 'valid', alg + ' jwk');
    const der = nodeSign(hash, Buffer.from(si), kp.privateKey); // DER: wrong for JWT
    const r = await verify(`${si}.${b64u(der)}`, { text: kp.publicKey.export({ type: 'spki', format: 'pem' }) });
    assert.equal(r.status, 'invalid'); assert.match(r.reason, /raw r\|\|s|DER/);
  });
}
await test('ES256 token with a P-384 key is refused (curve mismatch)', async () => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const si = signingInput('ES256');
  const tok = `${si}.${b64u(nodeSign('sha256', Buffer.from(si), { key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, dsaEncoding: 'ieee-p1363' }))}`;
  assert.equal((await verify(tok, { text: JSON.stringify(kp.publicKey.export({ format: 'jwk' })) })).status, 'error');
  assert.equal((await verify(tok, { text: kp.publicKey.export({ type: 'spki', format: 'pem' }) })).status, 'error');
});

// ---- algorithm confusion / key type mismatch ----
await test('HS256 token + public key (PEM or JWK) is refused as algorithm confusion, even if the MAC would match', async () => {
  const si = signingInput('HS256');
  // attacker signs the token with the PUBLIC KEY TEXT as the HMAC secret
  const forged = `${si}.${b64u(createHmac('sha256', rsaPem).update(si).digest())}`;
  const r = await verify(forged, { text: rsaPem });
  assert.equal(r.status, 'error'); assert.equal(r.confusion, true); assert.match(r.reason, /algorithm-confusion/i);
  const r2 = await verify(forged, { text: rsaJwk });
  assert.equal(r2.status, 'error'); assert.equal(r2.confusion, true);
});
await test('RS256 / ES256 token + shared secret is refused', async () => {
  for (const alg of ['RS256', 'ES256']) {
    const r = await verify(`${signingInput(alg)}.c2ln`, { text: 'a-shared-secret' });
    assert.equal(r.status, 'error', alg); assert.equal(r.confusion, true);
  }
});
await test('RS256 token with an EC key, and ES256 with an RSA key, are mismatches', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const r1 = await verify(`${signingInput('RS256')}.c2ln`, { text: ec.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(r1.status, 'error');
  const r2 = await verify(`${signingInput('ES256')}.${b64u(Buffer.alloc(64))}`, { text: rsaPem });
  assert.equal(r2.status, 'error');
  const r3 = await verify(`${signingInput('RS256')}.c2ln`, { text: JSON.stringify(ec.publicKey.export({ format: 'jwk' })) });
  assert.match(r3.reason, /mismatch/i);
});
await test('private keys are refused', async () => {
  const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.match((await verify(`${signingInput('RS256')}.c2ln`, { text: pem })).reason, /PRIVATE/);
  assert.match((await verify(`${signingInput('RS256')}.c2ln`, { text: JSON.stringify(rsa.privateKey.export({ format: 'jwk' })) })).reason, /PRIVATE/);
});
await test('JWK alg member must match the token alg', async () => {
  const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), alg: 'RS512' };
  assert.match((await verify(`${signingInput('RS256')}.c2ln`, { text: JSON.stringify(jwk) })).reason, /RS512/);
});
await test('algFamily', () => {
  assert.equal(algFamily('HS256'), 'HS'); assert.equal(algFamily('ES512'), 'ES'); assert.equal(algFamily('none'), null); assert.equal(algFamily('EdDSA'), null);
});

// ---- separate claims check ----
await test('claims check is independent and explicit about what was not checked', async () => {
  const now = 1_700_000_000;
  let r = checkClaims({ exp: now + 10, nbf: now - 10, iat: now - 20, iss: 'a', aud: ['x', 'y'] }, now, { iss: 'a', aud: 'y' });
  assert.equal(r.failed, 0);
  r = checkClaims({ exp: now - 1 }, now, {});
  assert.equal(r.failed, 1); assert.equal(r.items.find(i => i.claim === 'exp').status, 'fail');
  assert.equal(r.items.find(i => i.claim === 'iss').status, 'skipped');
  r = checkClaims({ nbf: now + 100, iss: 'evil', aud: 'q' }, now, { iss: 'a', aud: 'y' });
  assert.equal(r.items.filter(i => i.status === 'fail').map(i => i.claim).join(), 'nbf,iss,aud');
  assert.equal(checkClaims([], now).failed, 1);
  // a valid signature does not make claims valid
  const si = signingInput('HS256', { exp: 1 });
  const tok = `${si}.${b64u(createHmac('sha256', 's').update(si).digest())}`;
  assert.equal((await verify(tok, { text: 's' })).status, 'valid');
  assert.equal(checkClaims({ exp: 1 }, now).failed, 1);
});

console.log(`jwt-verify: ${pass} passed, ${failed} failed`);
