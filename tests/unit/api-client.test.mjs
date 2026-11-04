// Run: node tests/unit/api-client.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/api-client/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const row = (key, value, extra = {}) => ({ key, value, enabled: true, ...extra });
const enc = s => new TextEncoder().encode(s);
const Q = "'\\''"; // the shell sequence that embeds a single quote

test('methods include HEAD/OPTIONS; body only where allowed', () => {
  assert.ok(L.METHODS.includes('HEAD') && L.METHODS.includes('OPTIONS'));
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(L.methodAllowsBody(m));
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.ok(!L.methodAllowsBody(m));
});
test('buildRequest ignores body for HEAD even if JSON is invalid', () => {
  const r = L.buildRequest({ method: 'HEAD', headers: [], body: '{bad', bodyType: 'json' });
  assert.ok(r.ok); assert.equal(r.body, undefined);
});
test('JSON validated only for json type', () => {
  assert.equal(L.buildRequest({ method: 'POST', headers: [], body: '{bad', bodyType: 'json' }).ok, false);
  const t = L.buildRequest({ method: 'POST', headers: [], body: '{bad', bodyType: 'text' });
  assert.ok(t.ok); assert.equal(t.body, '{bad');
});
test('auto Content-Type only when not set by user', () => {
  assert.equal(L.buildRequest({ method: 'POST', headers: [], body: '{}', bodyType: 'json' }).headers['Content-Type'], 'application/json');
  assert.equal(L.buildRequest({ method: 'POST', headers: [], body: 'a=1', bodyType: 'form' }).autoContentType, 'application/x-www-form-urlencoded');
  assert.match(L.buildRequest({ method: 'POST', headers: [], body: 'hi', bodyType: 'text' }).headers['Content-Type'], /^text\/plain/);
  const u = L.buildRequest({ method: 'POST', headers: [row('content-type', 'application/vnd.x+json')], body: '{}', bodyType: 'json' });
  assert.equal(u.headers['content-type'], 'application/vnd.x+json'); assert.equal(u.autoContentType, null);
  assert.ok(!('Content-Type' in u.headers));
  const raw = L.buildRequest({ method: 'POST', headers: [], body: 'x', bodyType: 'raw' });
  assert.equal(raw.autoContentType, null); assert.deepEqual(raw.headers, {});
});
test('form body normalizes lines', () => {
  assert.equal(L.normalizeFormBody('a=1\nb=x y\n\nc'), 'a=1&b=x+y&c=');
  assert.equal(L.normalizeFormBody('a=1&b=%20'), 'a=1&b=%20');
  assert.equal(L.buildRequest({ method: 'PUT', headers: [], body: 'a=1\nb=2', bodyType: 'form' }).body, 'a=1&b=2');
});
test('invalid header name rejected', () => assert.equal(L.buildRequest({ method: 'GET', headers: [row('bad name', 'x')] }).ok, false));

test('response decoding: text, json, xml, charset', () => {
  assert.equal(L.decodeResponse(enc('{"a":1}'), 'application/json').kind, 'text');
  assert.equal(L.decodeResponse(enc('<a/>'), 'application/atom+xml').kind, 'text');
  assert.equal(L.decodeResponse(enc('x'), 'text/html; charset=utf-8').kind, 'text');
  assert.equal(L.decodeResponse(Uint8Array.from([0xe9]), 'text/plain; charset=iso-8859-1').text, 'é');
});
test('response decoding: binary and empty', () => {
  assert.equal(L.decodeResponse(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1]), 'image/png').kind, 'binary');
  assert.equal(L.decodeResponse(Uint8Array.from([1, 2, 3]), 'application/octet-stream').kind, 'binary');
  assert.equal(L.decodeResponse(new Uint8Array(0), 'image/png').kind, 'empty');
});
test('response decoding: sniff when type is missing', () => {
  assert.equal(L.decodeResponse(enc('hello'), '').kind, 'text');
  assert.equal(L.decodeResponse(Uint8Array.from([0xff, 0xfe, 0, 1, 2]), '').kind, 'binary');
  assert.equal(L.decodeResponse(Uint8Array.from([0xc3, 0x28, 0x41]), '').kind, 'binary'); // invalid UTF-8
});
test('response truncation at cap', () => {
  const d = L.decodeResponse(enc('a'.repeat(100)), 'text/plain', 10);
  assert.equal(d.truncated, true); assert.equal(d.text.length, 10); assert.equal(d.size, 100);
  assert.equal(L.decodeResponse(enc('a'.repeat(10)), 'text/plain', 10).truncated, false);
});

test('timeout clamp', () => {
  assert.equal(L.clampTimeout(''), 30); assert.equal(L.clampTimeout('abc'), 30); assert.equal(L.clampTimeout(0), 1);
  assert.equal(L.clampTimeout(999), 300); assert.equal(L.clampTimeout('45'), 45); assert.equal(L.clampTimeout(2.6), 3);
});
test('error messages: cancelled, timeout uses setting', () => {
  assert.equal(L.describeFetchError(Object.assign(new Error('x'), { name: 'AbortError' })), 'Cancelled');
  assert.equal(L.describeFetchError(new Error('x'), { aborted: true }), 'Cancelled');
  assert.equal(L.describeFetchError(new Error('x'), { timedOut: true, timeoutSec: 5 }), 'Request timed out after 5 seconds.');
  assert.match(L.describeFetchError(new TypeError('Failed to fetch')), /CORS/);
});

test('splitUrl/paramsFromText keep structure', () => {
  assert.deepEqual(L.splitUrl('https://a.b/p?x=1&y#frag'), { base: 'https://a.b/p', query: 'x=1&y', hasQuery: true, hash: '#frag' });
  assert.deepEqual(L.paramsFromText('http://h/p?a=1&b=x%20y&c&d=1+2'), [row('a', '1'), row('b', 'x y'), row('c', ''), row('d', '1 2')]);
  assert.deepEqual(L.paramsFromText('http://h/p'), []);
  assert.doesNotThrow(() => L.paramsFromText('http://h/p?a=%E0%A4%A'));
});
test('applyParamsToUrl rewrites only the query', () => {
  assert.equal(L.applyParamsToUrl('https://h/a%20b/c?old=1#top', [row('q', 'a b'), row('z', '&')]), 'https://h/a%20b/c?q=a%20b&z=%26#top');
  assert.equal(L.applyParamsToUrl('https://h/p?old=1', []), 'https://h/p');
  assert.equal(L.applyParamsToUrl('https://h/p', [row('k', 'v', { enabled: false })]), 'https://h/p');
  assert.equal(L.applyParamsToUrl('https://h', [row('k', 'v')]), 'https://h?k=v');
});
test('params round trip', () => {
  const url = 'https://h/p?a=1&b=two%20words';
  assert.equal(L.applyParamsToUrl(url, L.paramsFromText(url)), url);
});

test('shellQuote escapes single quotes as quote-backslash-quote-quote', () => {
  assert.equal(L.shellQuote("it's"), "'it" + Q + "s'");
  assert.equal(L.shellQuote(''), "''");
  assert.equal(L.shellQuote('$HOME `x` "y"'), "'$HOME `x` \"y\"'");
});
test('toCurl GET', () => assert.equal(L.toCurl({ method: 'GET', url: 'https://a.b/x?y=1' }), "curl 'https://a.b/x?y=1'"));
test('toCurl POST with headers and body', () => {
  const c = L.toCurl({ method: 'POST', url: 'https://a.b', headers: { 'Content-Type': 'application/json', 'X-A': "o'k" }, body: '{"n":"it\'s"}' });
  assert.equal(c, "curl -X POST 'https://a.b' -H 'Content-Type: application/json' -H 'X-A: o" + Q + "k' --data-raw '{\"n\":\"it" + Q + "s\"}'");
});
test('toCurl HEAD uses -I, OPTIONS -X, no body for GET', () => {
  assert.equal(L.toCurl({ method: 'HEAD', url: 'https://a.b' }), "curl -I 'https://a.b'");
  assert.equal(L.toCurl({ method: 'OPTIONS', url: 'https://a.b' }), "curl -X OPTIONS 'https://a.b'");
  assert.equal(L.toCurl({ method: 'GET', url: 'https://a.b', body: 'x' }), "curl 'https://a.b'");
});
test('toCurl accepts rows, skips disabled, keeps live secrets', () => {
  const c = L.toCurl({ method: 'GET', url: 'https://a.b', headers: [row('Authorization', 'Bearer s3cret'), row('X', 'y', { enabled: false })] });
  assert.equal(c, "curl 'https://a.b' -H 'Authorization: Bearer s3cret'");
});
test('toCurl multi-line body and DELETE with body', () => {
  assert.equal(L.toCurl({ method: 'DELETE', url: 'u', body: 'a\nb' }), "curl -X DELETE 'u' --data-raw 'a\nb'");
});

test('sensitive header detection (case-insensitive)', () => {
  for (const n of ['Authorization', 'PROXY-AUTHORIZATION', 'cookie', 'X-API-Key', 'x-auth-token', 'Api-Key', ' authorization ']) assert.ok(L.isSensitiveHeader(n), n);
  assert.ok(!L.isSensitiveHeader('Accept'));
});
test('history entry redacts sensitive headers by default', () => {
  const e = L.makeHistoryEntry({ method: 'GET', url: 'u', body: '', params: [], headers: [row('Authorization', 'Bearer abc'), row('Accept', 'x'), row('Cookie', '')], status: '200' });
  assert.equal(e.headers[0].value, '[redacted]'); assert.equal(e.headers[0].redacted, true);
  assert.equal(e.headers[1].value, 'x'); assert.equal(e.headers[2].redacted, undefined);
  assert.ok(!JSON.stringify(e).includes('abc'));
  assert.strictEqual(e.status, 200);
});
test('history keeps sensitive values when opted in', () => {
  const e = L.makeHistoryEntry({ method: 'GET', url: 'u', headers: [row('Authorization', 'Bearer abc')] }, { keepSensitive: true });
  assert.equal(e.headers[0].value, 'Bearer abc');
});
test('history body capped at 64 KB', () => {
  const e = L.makeHistoryEntry({ method: 'POST', url: 'u', body: 'x'.repeat(70000), headers: [] });
  assert.equal(e.body.length, 65536); assert.equal(e.bodyTruncated, true);
  assert.equal(L.makeHistoryEntry({ method: 'POST', url: 'u', body: 'ok', headers: [] }).bodyTruncated, false);
});
test('restoreRows blanks redacted values', () => {
  const r = L.restoreRows([row('Authorization', '[redacted]', { redacted: true }), row('A', 'b')]);
  assert.deepEqual(r, [row('Authorization', ''), row('A', 'b')]);
});
test('normalizeHistory coerces status and sanitizes', () => {
  const h = L.normalizeHistory([{ id: 'a', method: 'BOGUS', url: 'u', status: '<img onerror=x>' }, { id: 'b', method: 'POST', url: 'u2', status: '201', headers: [{ key: 'A', value: 1 }] }, null, { url: 5 }]);
  assert.equal(h.length, 2); assert.equal(h[0].status, null); assert.equal(h[0].method, 'GET');
  assert.strictEqual(h[1].status, 201); assert.equal(h[1].headers[0].value, '1');
  assert.deepEqual(L.normalizeHistory('nope'), []);
});
test('statusClass coerces', () => { assert.equal(L.statusClass('404'), 'warn'); assert.equal(L.statusClass(204), 'success'); assert.equal(L.statusClass(500), 'danger'); });
test('history add dedupes and caps', () => {
  let l = [];
  for (let i = 0; i < 30; i++) l = L.addHistory(l, { id: 'i' + i, method: 'GET', url: 'u' + i, body: '' });
  assert.equal(l.length, L.HISTORY_MAX);
  l = L.addHistory(l, { id: 'n', method: 'GET', url: 'u29', body: '' });
  assert.equal(l.length, L.HISTORY_MAX); assert.equal(l[0].id, 'n');
  assert.equal(L.removeHistory(l, 'n').length, L.HISTORY_MAX - 1);
});

console.log(`api-client: ${pass} passed`);
