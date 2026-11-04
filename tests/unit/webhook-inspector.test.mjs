// Run from repo root: node tests/unit/webhook-inspector.test.mjs
import assert from 'node:assert/strict';
import { sanitizeHistory, parseExternalResponse, resolveExternal, privateHostKind, parseRetryAfter, nextPollDelay, capBody, BODY_CAP,
  redactHeaders, prepareForStorage, mergeExternal, WebhookError, exportHistory, curlRedactionWarning, toCurl } from '../../tools/webhook-inspector/logic.js';

let pass = 0;
const t = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };
const NOW = new Date('2024-01-01T00:00:00Z');
const good = (o = {}) => ({ id: 'a', source: 'simulated', method: 'post', url: 'https://x/a', path: '/a', headers: { A: 'b' }, query: [['k', 'v']], body: 'x', size: 1, time: '2024-01-02T00:00:00Z', ...o });

t('sanitizeHistory keeps good record, uppercases method', () => {
  const [r] = sanitizeHistory([good()], NOW);
  assert.equal(r.method, 'POST'); assert.deepEqual(r.headers, { A: 'b' });
});
t('headers null / array / non-string values do not crash', () => {
  const out = sanitizeHistory([good({ headers: null }), good({ id: 'b', headers: [1, 2] }), good({ id: 'c', headers: { a: { x: 1 }, b: 2, c: 's' } })], NOW);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].headers, {}); assert.deepEqual(out[1].headers, {}); assert.deepEqual(out[2].headers, { b: '2', c: 's' });
});
t('query shapes', () => {
  const out = sanitizeHistory([good({ query: 'nope' }), good({ id: 'b', query: { a: 1 } }), good({ id: 'c', query: [['a', 1], 'bad', [null, 'x']] })], NOW);
  assert.deepEqual(out.map(r => r.query), [[], [], [['a', '1']]]);
});
t('unusable records dropped, not thrown', () => {
  const junk = [null, 5, 'x', [], {}, good({ id: '' }), good({ id: 'm', method: 12 }), good({ id: 's', source: 'evil' }), good({ id: 'z', method: '<b>' })];
  assert.deepEqual(sanitizeHistory([...junk, good({ id: 'ok' })], NOW).map(r => r.id), ['ok']);
  assert.deepEqual(sanitizeHistory('nope'), []);
  assert.deepEqual(sanitizeHistory(null), []);
});
t('numbers finite, strings coerced, bad time replaced, duplicates removed', () => {
  const [r, ...rest] = sanitizeHistory([good({ size: Infinity, time: 'garbage', url: null, body: null }), good()], NOW);
  assert.equal(r.size, 0); assert.equal(r.time, NOW.toISOString()); assert.equal(r.url, ''); assert.equal(r.body, '');
  assert.equal(rest.length, 0);
});
t('parseExternalResponse skips malformed and counts', () => {
  const { records, skipped } = parseExternalResponse({ data: [{ uuid: 'u1', method: 'post', url: 'https://webhook.site/x', headers: { A: ['1', '2'] }, content: 'hi' }, null, 5, { nouuid: 1 }, { uuid: 'u2', headers: 'str' }] }, NOW);
  assert.equal(records.length, 2); assert.equal(skipped, 3);
  assert.equal(records[0].headers.A, '1, 2'); assert.deepEqual(records[1].headers, {});
});
t('parseExternalResponse still throws on wrong top-level shape', () => {
  assert.throws(() => parseExternalResponse({ nope: 1 }), WebhookError);
  assert.throws(() => parseExternalResponse(null), WebhookError);
});
t('mergeExternal works with parsed records', () => {
  const { records } = parseExternalResponse({ data: [{ uuid: 'u1' }] }, NOW);
  assert.equal(mergeExternal([], records).added, 1);
});
t('custom API url: https required except loopback', () => {
  assert.throws(() => resolveExternal('', 'http://example.com/api'), /https/);
  assert.throws(() => resolveExternal('', 'http://192.168.1.5/api'), /https/);
  assert.equal(resolveExternal('', 'http://localhost:3000/api').privateHost, 'loopback');
  assert.equal(resolveExternal('', 'http://127.0.0.1/api').privateHost, 'loopback');
  assert.equal(resolveExternal('', 'https://example.com/api').privateHost, null);
  assert.equal(resolveExternal('', 'https://169.254.169.254/latest').privateHost, 'link-local');
  assert.equal(resolveExternal('', 'https://nas.local/api').privateHost, 'private');
  assert.equal(resolveExternal('', 'https://[::1]/api').privateHost, 'loopback');
});
t('privateHostKind ranges', () => {
  const k = privateHostKind;
  assert.deepEqual([k('10.1.2.3'), k('172.16.0.1'), k('172.31.255.1'), k('172.32.0.1'), k('192.168.0.1'), k('192.169.0.1'), k('8.8.8.8')],
    ['private', 'private', 'private', null, 'private', null, null]);
  assert.deepEqual([k('localhost'), k('foo.localhost'), k('127.5.5.5'), k('[::1]'), k('fe80::1'), k('fd00::1'), k('a.example.com')],
    ['loopback', 'loopback', 'loopback', 'loopback', 'link-local', 'private', null]);
});
t('webhook.site derivation unchanged and has no privateHost', () => {
  const r = resolveExternal('https://webhook.site/6f1c2a40-5b6d-11ee-9a3e-0242ac120002');
  assert.equal(r.service, 'webhook.site'); assert.ok(r.apiUrl.startsWith('https://webhook.site/token/'));
});
t('Retry-After parsing', () => {
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 10000);
  assert.equal(parseRetryAfter(null), null); assert.equal(parseRetryAfter('soon'), null);
});
t('backoff is exponential, capped at 60s, honours Retry-After', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(n => nextPollDelay(n)), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  assert.equal(nextPollDelay(1, 120000), 120000);
  assert.equal(nextPollDelay(1, 10 * 3600 * 1000), 300000);
  assert.equal(nextPollDelay(3, 1000), 20000);
});
t('body cap', () => {
  assert.equal(capBody('abc').truncated, false);
  const big = 'é'.repeat(BODY_CAP); // 2 bytes each
  const c = capBody(big); assert.ok(c.truncated); assert.ok(new TextEncoder().encode(c.body).length <= BODY_CAP);
  assert.ok(!c.body.includes('�'));
  assert.equal(capBody('a'.repeat(BODY_CAP)).truncated, false);
});
t('redaction of sensitive headers (case-insensitive)', () => {
  const h = redactHeaders({ Authorization: 'Bearer x', 'proxy-authorization': 'y', COOKIE: 'a=1', 'Set-Cookie': 'b', 'X-Api-Key': 'k', 'x-auth-token': 't', 'Content-Type': 'application/json' });
  assert.deepEqual(Object.values(h), ['[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]', 'application/json']);
});
t('prepareForStorage redacts + caps + flags, leaves original intact', () => {
  const rec = good({ headers: { Authorization: 'secret' }, body: 'x'.repeat(BODY_CAP + 10) });
  const out = prepareForStorage(rec);
  assert.equal(out.headers.Authorization, '[redacted]'); assert.equal(out.redacted, true); assert.equal(out.truncated, true);
  assert.equal(rec.headers.Authorization, 'secret'); assert.equal(rec.body.length, BODY_CAP + 10);
  assert.equal(prepareForStorage(good()).redacted, undefined);
  const [back] = sanitizeHistory([JSON.parse(JSON.stringify(out))], NOW);
  assert.ok(back.redacted && back.truncated);
});
t('export redacts credential headers by default', () => {
  const rec = good({ headers: { Authorization: 'Bearer s3cret', 'X-Api-Key': 'k', Accept: 'a' } });
  const out = JSON.parse(exportHistory([rec], NOW));
  assert.equal(out.includesSecrets, false);
  assert.equal(out.requests[0].headers.Authorization, '[redacted]'); assert.equal(out.requests[0].headers['X-Api-Key'], '[redacted]');
  assert.equal(out.requests[0].headers.Accept, 'a'); assert.equal(out.requests[0].redacted, true);
  assert.ok(!JSON.stringify(out).includes('s3cret'));
  assert.equal(rec.headers.Authorization, 'Bearer s3cret'); // input not mutated
});
t('export with includeSecrets keeps values and says so', () => {
  const rec = good({ headers: { Cookie: 'sid=1' } });
  const out = JSON.parse(exportHistory([rec], NOW, { includeSecrets: true }));
  assert.equal(out.includesSecrets, true); assert.equal(out.requests[0].headers.Cookie, 'sid=1');
});
t('cURL from redacted record warns', () => {
  const red = prepareForStorage(good({ headers: { Authorization: 'Bearer x' } }));
  assert.match(curlRedactionWarning(red), /redacted/);
  assert.ok(toCurl(red).includes('[redacted]'));
  assert.equal(curlRedactionWarning(good()), '');
});
console.log(`${pass} tests passed`);
