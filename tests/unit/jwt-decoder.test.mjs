// Run: node tests/unit/jwt-decoder.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/jwt-decoder/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const NOW = 1_700_000_000;
const codes = w => w.map(x => x.code);
const tok = (h, p, sig = 'c2ln') => `${L.encodeJsonSegment(h)}.${L.encodeJsonSegment(p)}.${sig}`;

test('alg none (any case) is critical', () => {
  for (const a of ['none', 'None', 'NONE']) {
    const w = L.securityWarnings({ alg: a }, { exp: NOW + 100 }, '', NOW);
    assert.equal(w[0].severity, 'critical'); assert.equal(w[0].code, 'alg-none');
    assert.ok(!codes(w).includes('empty-signature'));
  }
});
test('empty signature with real alg is critical', () => {
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, {}, '', NOW)).includes('empty-signature'));
  assert.ok(!codes(L.securityWarnings({ alg: 'RS256' }, {}, 'abc', NOW)).includes('empty-signature'));
});
test('numeric alg gives clear message, decodeJwt too', () => {
  const w = L.securityWarnings({ alg: 5 }, {}, 'x', NOW);
  assert.ok(codes(w).includes('alg-type'));
  const d = L.decodeJwt(tok({ alg: 5 }, { a: 1 }));
  assert.ok(d.errors.some(e => /must be a string/.test(e)) && !d.errors.some(e => /no "alg"/.test(e)));
  assert.ok(L.decodeJwt(tok({ typ: 'JWT' }, {})).errors.some(e => /no "alg"/.test(e)));
});
test('HMAC note, weak and unknown alg', () => {
  assert.ok(codes(L.securityWarnings({ alg: 'HS256' }, {}, 'x', NOW)).includes('hmac'));
  assert.ok(codes(L.securityWarnings({ alg: 'FOO' }, {}, 'x', NOW)).includes('unknown-alg'));
  assert.ok(codes(L.securityWarnings({ alg: 'RS1' }, {}, 'x', NOW)).includes('weak-alg'));
  assert.ok(!codes(L.securityWarnings({ alg: 'ES256' }, {}, 'x', NOW)).some(c => c === 'unknown-alg' || c === 'weak-alg'));
});
test('key injection headers and kid', () => {
  for (const k of ['jku', 'x5u', 'jwk', 'x5c']) assert.ok(codes(L.securityWarnings({ alg: 'RS256', [k]: 'x' }, {}, 'x', NOW)).includes('key-injection'), k);
  assert.ok(codes(L.securityWarnings({ alg: 'RS256', kid: '1' }, {}, 'x', NOW)).includes('kid'));
});
test('typ missing is info only', () => {
  const w = L.securityWarnings({ alg: 'RS256' }, { exp: NOW + 5, iss: 'a', aud: 'b' }, 'x', NOW).find(x => x.code === 'typ-missing');
  assert.equal(w.severity, 'info');
});
test('time heuristics', () => {
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, { exp: NOW * 1000 }, 'x', NOW)).includes('exp-ms'));
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, { iat: NOW + 3600 }, 'x', NOW)).includes('iat-future'));
  assert.ok(!codes(L.securityWarnings({ alg: 'RS256' }, { iat: NOW + 30 }, 'x', NOW)).includes('iat-future'));
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, { nbf: NOW + 100, exp: NOW + 50 }, 'x', NOW)).includes('nbf-after-exp'));
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, { iat: NOW, exp: NOW - 5 }, 'x', NOW)).includes('exp-before-iat'));
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, { iat: NOW, exp: NOW + 2 * 31536000 }, 'x', NOW)).includes('long-lived'));
  assert.ok(codes(L.securityWarnings({ alg: 'RS256' }, { exp: 'soon' }, 'x', NOW)).includes('exp-type'));
});
test('missing exp/iss/aud are info', () => {
  const w = L.securityWarnings({ alg: 'RS256', typ: 'JWT' }, {}, 'x', NOW);
  assert.deepEqual(codes(w).sort(), ['aud-missing', 'exp-missing', 'iss-missing']);
  assert.ok(w.every(x => x.severity === 'info'));
});
test('warnings are severity ordered', () => {
  const w = L.securityWarnings({ alg: 'none', jku: 'x' }, {}, '', NOW);
  const rank = { critical: 0, warning: 1, info: 2 };
  for (let i = 1; i < w.length; i++) assert.ok(rank[w[i - 1].severity] <= rank[w[i].severity]);
});
test('null/non-object inputs do not throw', () => {
  assert.deepEqual(L.securityWarnings(null, null, '', NOW), []);
  assert.doesNotThrow(() => L.securityWarnings([], 'x', '', NOW));
});
test('claim descriptions', () => {
  for (const c of ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti', 'scope', 'azp', 'nonce', 'roles', 'cnf', 'kid']) assert.ok(L.claimDescription(c), c);
  assert.equal(L.claimDescription('custom'), '');
  assert.equal(L.claimDescription('constructor'), '');
  assert.equal(L.claimDescription('__proto__'), '');
});
test('formatDuration two-unit output', () => {
  const f = L.formatDuration;
  assert.equal(f(0), '0s'); assert.equal(f(45), '45s'); assert.equal(f(60), '1m'); assert.equal(f(203), '3m 23s');
  assert.equal(f(7500), '2h 5m'); assert.equal(f(7200), '2h'); assert.equal(f(86400 * 3 + 3600 * 4), '3d 4h');
  assert.equal(f(31536000 + 86400 * 2), '1y 2d'); assert.equal(f(-90), '1m 30s');
});
test('formatCountdown', () => {
  assert.equal(L.formatCountdown(252), '00:04:12'); assert.equal(L.formatCountdown(86400 + 7509), '1d 02:05:09'); assert.equal(L.formatCountdown(-5), '00:00:05');
});
test('evaluateTimes states never claim validity', () => {
  assert.equal(L.evaluateTimes({ exp: NOW + 3600 }, NOW).state, 'valid');
  assert.match(L.evaluateTimes({ exp: NOW + 3600 }, NOW).label, /per its claims/);
  assert.equal(L.evaluateTimes({ exp: NOW + 120 }, NOW).state, 'soon');
  assert.equal(L.evaluateTimes({ exp: NOW - 1 }, NOW).state, 'expired');
  assert.equal(L.evaluateTimes({ exp: NOW + 3600, nbf: NOW + 60 }, NOW).state, 'notyet');
  assert.equal(L.evaluateTimes({}, NOW).state, 'none');
  assert.equal(L.evaluateTimes({ exp: 'x' }, NOW).state, 'invalid');
});
test('relative text uses consistent units', () => {
  const it = L.evaluateTimes({ exp: NOW + 7500 }, NOW).items[0];
  assert.equal(it.relative, 'expires in 2h 5m');
});
test('whitespace stripping detection', () => {
  const t = tok({ alg: 'HS256' }, { a: 1 });
  assert.equal(L.decodeJwt(t).whitespaceStripped, false);
  assert.equal(L.decodeJwt('Bearer ' + t + '\n').whitespaceStripped, false);
  const broken = t.slice(0, 10) + '\n' + t.slice(10);
  const d = L.decodeJwt(broken);
  assert.equal(d.whitespaceStripped, true); assert.equal(d.token, t);
});
test('sampleToken still decodes', () => {
  const d = L.decodeJwt(L.sampleToken(NOW));
  assert.ok(d.ok); assert.equal(d.alg, 'HS256');
});

console.log(`jwt-decoder: ${pass} passed`);
