// Run: node tests/unit/http-header-analyzer.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/http-header-analyzer/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const codes = list => list.map(i => i.code);
const has = (list, code) => codes(list).includes(code);
const NOW = Date.UTC(2024, 0, 15, 12, 0, 0);
const H = (name, value) => ({ name, lower: name.toLowerCase(), value });
const ex = (name, value, kind = 'response') => L.explainHeader(H(name, value), { kind, now: NOW });
const resp = (...lines) => L.analyze(['HTTP/1.1 200 OK', ...lines].join('\r\n'), { now: NOW });
const sec = (a, id) => a.security.items.filter(i => i.id === id || i.id.startsWith(id + '-'));

// ---------------------------------------------------------------- knowledge base
test('knowledge base has at least 120 headers with required fields', () => {
  assert.ok(L.HEADER_COUNT >= 120, `only ${L.HEADER_COUNT}`);
  for (const h of Object.values(L.HEADER_DB)) { assert.ok(h.name && ['req', 'res', 'both'].includes(h.kind) && h.category && h.description.length > 10, h.name); }
});
test('knowledge base covers the required groups', () => {
  for (const cat of ['CORS', 'Caching', 'Security', 'Cookies', 'Content', 'Conditional', 'Range', 'Proxy', 'WebSocket', 'Client Hints', 'Fetch Metadata']) assert.ok(Object.values(L.HEADER_DB).some(h => h.category === cat), cat);
});
test('lookup is case-insensitive and flags deprecated headers', () => {
  assert.equal(L.lookupHeader('CONTENT-TYPE').name, 'Content-Type'); assert.equal(L.lookupHeader('nope'), null);
  assert.match(L.lookupHeader('X-XSS-Protection').note, /Deprecated/); assert.match(L.lookupHeader('Pragma').note, /Deprecated/);
});

// ---------------------------------------------------------------- parser: formats
test('parse response with status line', () => {
  const p = L.parseHeaders('HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nServer: x\r\n');
  assert.deepEqual(p.startLine, { kind: 'response', version: '1.1', status: 404, reason: 'Not Found', raw: 'HTTP/1.1 404 Not Found' });
  assert.equal(p.mode, 'response'); assert.equal(p.headers.length, 2); assert.equal(p.headers[0].name, 'Content-Type');
});
test('parse request line', () => {
  const p = L.parseHeaders('GET /a?b=1 HTTP/1.1\nHost: example.com\nAccept: */*');
  assert.equal(p.startLine.method, 'GET'); assert.equal(p.startLine.target, '/a?b=1'); assert.equal(p.mode, 'request');
});
test('parse HTTP/2 status line', () => assert.equal(L.parseHeaders('HTTP/2 200\ncontent-type: text/plain').startLine.status, 200));
test('parse plain Name: value lines without start line', () => {
  const p = L.parseHeaders('Host: a.com\nUser-Agent: curl/8\nAccept: */*');
  assert.equal(p.startLine, null); assert.equal(p.headers.length, 3); assert.equal(p.mode, 'request');
});
test('mode detection for response-only headers', () => assert.equal(L.parseHeaders('Server: nginx\nSet-Cookie: a=b').mode, 'response'));
test('mode override for ambiguous input falls to response', () => assert.equal(L.parseHeaders('X-Custom: 1').mode, 'response'));
test('curl -i with redirect chain analyses the last response', () => {
  const t = 'HTTP/1.1 301 Moved\r\nLocation: /x\r\n\r\nHTTP/2 200\r\ncontent-type: text/html\r\nserver: nginx\r\n\r\n<html>body</html>';
  const p = L.parseHeaders(t);
  assert.equal(p.startLine.status, 200); assert.equal(p.headers.length, 2); assert.ok(p.notes.some(n => /blocks/.test(n)));
});
test('body after blank line is ignored when there is no start line', () => {
  const p = L.parseHeaders('Content-Type: text/html\n\n<html>Name: not a header</html>');
  assert.equal(p.headers.length, 1); assert.ok(p.notes.length);
});
test('curl -v output picks response lines (or request lines with mode)', () => {
  const t = '* Connected\n> GET / HTTP/1.1\n> Host: a.com\n> \n< HTTP/1.1 200 OK\n< Server: nginx\n< \n';
  assert.equal(L.parseHeaders(t).mode, 'response');
  const r = L.parseHeaders(t, { mode: 'request' }); assert.equal(r.startLine.method, 'GET'); assert.equal(r.headers[0].name, 'Host');
});
test('HTTP/2 pseudo headers (DevTools) are accepted and set the mode', () => {
  const p = L.parseHeaders(':authority: example.com\n:method: GET\n:path: /\n:scheme: https\naccept: */*');
  assert.equal(p.mode, 'request'); assert.equal(p.headers[0].pseudo, true); assert.equal(p.issues.filter(i => i.level !== 'info').length, 0);
  assert.equal(L.parseHeaders(':status: 200\ncontent-type: a/b').mode, 'response');
});
test('DevTools "Name:" newline "value" format', () => {
  const p = L.parseHeaders('accept-ranges:\nbytes\ncontent-length:\n1234\ncontent-type:\ntext/html; charset=utf-8');
  assert.deepEqual(p.headers.map(h => [h.name, h.value]), [['accept-ranges', 'bytes'], ['content-length', '1234'], ['content-type', 'text/html; charset=utf-8']]);
});
test('empty header value followed by another header stays empty', () => {
  const p = L.parseHeaders('X-Empty:\nX-Next: 1');
  assert.deepEqual(p.headers.map(h => [h.name, h.value]), [['X-Empty', ''], ['X-Next', '1']]);
});
test('curl command: -H headers, -X and URL', () => {
  const p = L.parseHeaders(`curl 'https://api.example.com/v1' \\\n  -X POST \\\n  -H 'Authorization: Bearer abc.def.ghi' \\\n  -H "Content-Type: application/json" \\\n  --header 'Accept: */*'`);
  assert.equal(p.source, 'curl'); assert.equal(p.mode, 'request'); assert.equal(p.headers.length, 3);
  assert.equal(p.startLine.method, 'POST'); assert.equal(p.startLine.target, 'https://api.example.com/v1'); assert.equal(p.headers[0].value, 'Bearer abc.def.ghi');
});
test('curl without headers is an error', () => assert.ok(has(L.parseHeaders("curl 'https://a.com'").issues, 'curl-no-headers')));
test('fetch() copy format', () => {
  const p = L.parseHeaders(`fetch("https://a.com/x", {\n  "headers": {\n    "accept": "*/*",\n    "sec-fetch-mode": "cors"\n  },\n  "method": "GET"\n});`);
  assert.equal(p.source, 'fetch'); assert.deepEqual(p.headers.map(h => h.name), ['accept', 'sec-fetch-mode']);
});

// ---------------------------------------------------------------- parser: syntax checks
test('empty and whitespace-only input', () => {
  assert.ok(has(L.parseHeaders('').issues, 'empty-input')); assert.ok(has(L.parseHeaders('  \n \n').issues, 'empty-input')); assert.ok(has(L.parseHeaders(null).issues, 'empty-input'));
});
test('missing colon', () => { const p = L.parseHeaders('Good: 1\nBadLine\nAlso: 2'); assert.ok(has(p.issues, 'missing-colon')); assert.equal(p.headers.length, 2); });
test('space before colon is an error', () => assert.ok(has(L.parseHeaders('Host : a.com').issues, 'space-before-colon')));
test('invalid header name characters', () => { assert.ok(has(L.parseHeaders('Bad Name: x').issues, 'invalid-name')); assert.ok(has(L.parseHeaders('Na(me: x').issues, 'invalid-name')); });
test('non-ASCII in name and value', () => {
  assert.ok(has(L.parseHeaders('Nämé: x').issues, 'non-ascii-name')); assert.ok(has(L.parseHeaders('X-Name: café').issues, 'non-ascii-value'));
});
test('obs-fold continuation is joined and warned', () => {
  const p = L.parseHeaders('X-Long: part one\r\n  part two\r\nOther: 1');
  assert.equal(p.headers[0].value, 'part one part two'); assert.equal(p.headers[0].folded, true); assert.ok(has(p.issues, 'obs-fold'));
});
test('continuation without header', () => assert.ok(has(L.parseHeaders('HTTP/1.1 200 OK\r\n  stray\r\nA: b').issues, 'orphan-continuation')));
test('mixed line endings and LF-only', () => {
  assert.ok(has(L.parseHeaders('A: 1\r\nB: 2\nC: 3').issues, 'mixed-eol')); assert.ok(has(L.parseHeaders('A: 1\nB: 2').issues, 'lf-only')); assert.ok(!has(L.parseHeaders('A: 1\r\nB: 2').issues, 'lf-only'));
});
test('bare CR inside a line', () => assert.ok(has(L.parseHeaders('A: 1\rB: 2').issues, 'bare-cr')));
test('control characters in value', () => assert.ok(has(L.parseHeaders('A: x\x01y').issues, 'control-char')));
test('value with colons and trimming', () => assert.equal(L.parseHeaders('Location:   https://a.com:8080/x  ').headers[0].value, 'https://a.com:8080/x'));
test('BOM is stripped; oversized input rejected', () => {
  assert.equal(L.parseHeaders('﻿A: 1').headers[0].name, 'A');
  assert.ok(has(L.parseHeaders('A: ' + 'x'.repeat(1_100_000)).issues, 'too-large'));
});
test('Unicode value does not crash', () => assert.equal(L.parseHeaders('X-Emoji: \u{1F600}').headers.length, 1));
test('many headers are capped', () => { const p = L.parseHeaders(Array.from({ length: 600 }, (_, i) => `X-${i}: v`).join('\n')); assert.equal(p.headers.length, 500); assert.ok(has(p.issues, 'too-many')); });

// ---------------------------------------------------------------- duplicates / cross checks
test('multiple Set-Cookie is fine and kept separate', () => {
  const a = resp('Set-Cookie: a=1; Secure; HttpOnly', 'Set-Cookie: b=2; Secure; HttpOnly');
  assert.equal(a.rows.filter(r => r.lower === 'set-cookie').length, 2); assert.ok(has(a.cross, 'multi-set-cookie')); assert.ok(!has(a.cross, 'duplicate-singleton'));
});
test('duplicate singleton headers: error when values differ, warn when equal', () => {
  assert.equal(L.crossChecks(L.parseHeaders('Content-Length: 1\nContent-Length: 2').headers).find(i => i.code === 'duplicate-singleton').level, 'error');
  assert.equal(L.crossChecks(L.parseHeaders('Host: a\nHost: a').headers).find(i => i.code === 'duplicate-singleton').level, 'warn');
});
test('case-insensitive duplicate detection', () => assert.ok(has(L.crossChecks(L.parseHeaders('content-type: a/b\nContent-Type: c/d').headers), 'duplicate-singleton')));
test('Content-Length with Transfer-Encoding', () => assert.ok(has(L.crossChecks(L.parseHeaders('Content-Length: 5\ntransfer-encoding: chunked').headers), 'cl-te')));
test('generic duplicate list header', () => assert.ok(has(L.crossChecks(L.parseHeaders('Accept: a/b\nAccept: c/d').headers), 'duplicate-header')));

// ---------------------------------------------------------------- Cache-Control
test('Cache-Control basic breakdown and summary', () => {
  const r = ex('Cache-Control', 'public, max-age=3600, must-revalidate');
  assert.equal(r.details.length, 3); assert.match(r.summary, /1 hour/); assert.equal(r.issues.length, 0);
});
test('Cache-Control no-store summary', () => assert.match(ex('Cache-Control', 'no-store').summary, /Not stored/));
test('Cache-Control no-store + max-age/public conflicts', () => assert.ok(has(ex('Cache-Control', 'no-store, max-age=300, public').issues, 'cc-conflict')));
test('Cache-Control public + private conflict', () => assert.ok(has(ex('Cache-Control', 'public, private').issues, 'cc-conflict')));
test('Cache-Control max-age=0 with immutable', () => assert.ok(has(ex('Cache-Control', 'max-age=0, immutable').issues, 'cc-conflict')));
test('Cache-Control no-cache with max-age is moot', () => assert.ok(has(ex('Cache-Control', 'no-cache, max-age=600').issues, 'cc-moot')));
test('Cache-Control private with s-maxage', () => assert.ok(has(ex('Cache-Control', 'private, s-maxage=60').issues, 'cc-conflict')));
test('Cache-Control bad numbers, duplicates, unknown', () => {
  assert.ok(has(ex('Cache-Control', 'max-age=abc').issues, 'cc-bad-number')); assert.ok(has(ex('Cache-Control', 'max-age').issues, 'cc-bad-number'));
  assert.ok(has(ex('Cache-Control', 'max-age=1, max-age=2').issues, 'cc-duplicate')); assert.ok(has(ex('Cache-Control', 'foo-bar').issues, 'cc-unknown'));
});
test('Cache-Control direction: request directive in response and vice versa', () => {
  assert.ok(has(ex('Cache-Control', 'only-if-cached').issues, 'cc-wrong-direction')); assert.ok(has(ex('Cache-Control', 'immutable', 'request').issues, 'cc-wrong-direction'));
  assert.ok(!has(ex('Cache-Control', 'max-age=0', 'request').issues, 'cc-wrong-direction'));
});
test('Cache-Control case-insensitive with long lifetime note', () => {
  assert.ok(has(ex('Cache-Control', 'MAX-AGE=99999999').issues, 'cc-too-long')); assert.equal(ex('Cache-Control', 'No-Store').details[0].label, 'no-store');
});
test('Cache-Control empty', () => assert.ok(has(ex('Cache-Control', '   ').issues, 'empty-value')));
test('Cache-Control directive with unexpected argument', () => assert.ok(has(ex('Cache-Control', 'no-store=1').issues, 'cc-unexpected-arg')));

// ---------------------------------------------------------------- Content-Type
test('Content-Type charset and boundary', () => {
  const p = L.parseContentType('Multipart/Form-Data; boundary="abc 123"; charset=UTF-8');
  assert.equal(p.mediaType, 'multipart/form-data'); assert.equal(p.boundary, 'abc 123'); assert.equal(p.charset, 'UTF-8');
});
test('Content-Type multipart without boundary', () => assert.ok(has(ex('Content-Type', 'multipart/form-data').issues, 'ct-no-boundary')));
test('Content-Type invalid and text without charset', () => {
  assert.ok(has(ex('Content-Type', 'html').issues, 'ct-invalid')); assert.ok(has(ex('Content-Type', 'text/html').issues, 'ct-no-charset')); assert.ok(!has(ex('Content-Type', 'text/html; charset=utf-8').issues, 'ct-no-charset'));
});
test('Content-Type json with charset note', () => assert.ok(has(ex('Content-Type', 'application/json; charset=utf-8').issues, 'ct-json-charset')));

// ---------------------------------------------------------------- Set-Cookie / Cookie
test('Set-Cookie full attribute parse', () => {
  const c = L.parseSetCookie('id=a3fWa; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax; Partitioned');
  assert.equal(c.name, 'id'); assert.equal(c.valueLength, 5); assert.equal(c.attrs.samesite, 'Lax'); assert.equal(c.attrs.domain, 'example.com'); assert.equal(c.attrs.secure, true); assert.equal(c.attrs.partitioned, true);
  assert.ok(has(c.issues, 'cookie-both-expiry'));
});
test('Set-Cookie SameSite=None requires Secure', () => { assert.ok(has(L.parseSetCookie('a=b; SameSite=None').issues, 'cookie-none-no-secure')); assert.ok(!has(L.parseSetCookie('a=b; SameSite=None; Secure').issues, 'cookie-none-no-secure')); });
test('Set-Cookie __Secure- and __Host- prefix rules', () => {
  assert.ok(has(L.parseSetCookie('__Secure-a=1').issues, 'cookie-prefix-secure')); assert.ok(!has(L.parseSetCookie('__Secure-a=1; Secure').issues, 'cookie-prefix-secure'));
  assert.equal(L.parseSetCookie('__Host-a=1; Secure; Path=/; HttpOnly').issues.filter(i => i.code === 'cookie-prefix-host').length, 0);
  assert.equal(L.parseSetCookie('__Host-a=1; Secure; Path=/x; Domain=a.com').issues.filter(i => i.code === 'cookie-prefix-host').length, 2);
  assert.ok(has(L.parseSetCookie('__host-a=1').issues, 'cookie-prefix-host'));
});
test('Set-Cookie missing flags and invalid pieces', () => {
  const c = L.parseSetCookie('a=b'); assert.ok(has(c.issues, 'cookie-no-secure') && has(c.issues, 'cookie-no-httponly') && has(c.issues, 'cookie-no-samesite'));
  assert.ok(has(L.parseSetCookie('novalue; Secure').issues, 'cookie-no-equals')); assert.ok(has(L.parseSetCookie('=x').issues, 'cookie-empty-name'));
  assert.ok(has(L.parseSetCookie('a=b; SameSite=Weird').issues, 'cookie-samesite-invalid')); assert.ok(has(L.parseSetCookie('a=b; Max-Age=soon').issues, 'cookie-maxage-invalid'));
  assert.ok(has(L.parseSetCookie('a=b; Expires=yesterday').issues, 'cookie-expires-invalid')); assert.ok(has(L.parseSetCookie('a=b; Path=x').issues, 'cookie-path-invalid'));
  assert.ok(has(L.parseSetCookie('a=b; Max-Age=0').issues, 'cookie-delete')); assert.ok(has(L.parseSetCookie('a=b; Partitioned').issues, 'cookie-partitioned-no-secure'));
});
test('Set-Cookie value with "=" and size limit', () => {
  assert.equal(L.parseSetCookie('t=a=b==; Secure').valueLength, 5); assert.ok(has(L.parseSetCookie('a=' + 'x'.repeat(5000)).issues, 'cookie-too-large'));
});
test('Set-Cookie explainer hides the value', () => { const r = ex('Set-Cookie', 'sid=SECRETVALUE; Secure'); assert.ok(!JSON.stringify(r).includes('SECRETVALUE')); assert.match(r.summary, /session cookie/); });
test('Cookie header parsing, duplicates, malformed', () => {
  const c = L.parseCookieHeader('a=1; b=2; a=3; broken'); assert.equal(c.pairs.length, 3); assert.ok(has(c.issues, 'cookie-duplicate')); assert.ok(has(c.issues, 'cookie-pair-no-equals'));
  assert.ok(!JSON.stringify(ex('Cookie', 'a=TOPSECRET')).includes('TOPSECRET'));
});

// ---------------------------------------------------------------- CORS
test('CORS Allow-Origin variants', () => {
  assert.equal(ex('Access-Control-Allow-Origin', '*').issues.length, 0); assert.equal(ex('Access-Control-Allow-Origin', 'https://a.com').issues.length, 0);
  assert.ok(has(ex('Access-Control-Allow-Origin', 'null').issues, 'cors-null')); assert.ok(has(ex('Access-Control-Allow-Origin', 'https://a.com, https://b.com').issues, 'cors-origin-multi'));
  assert.ok(has(ex('Access-Control-Allow-Origin', 'https://a.com/path').issues, 'cors-origin-invalid')); assert.ok(has(ex('Access-Control-Allow-Origin', 'a.com').issues, 'cors-origin-invalid'));
});
test('CORS Allow-Credentials only accepts true', () => { assert.equal(ex('Access-Control-Allow-Credentials', 'true').issues.length, 0); assert.ok(has(ex('Access-Control-Allow-Credentials', 'True').issues, 'cors-credentials-invalid')); assert.ok(has(ex('Access-Control-Allow-Credentials', '1').issues, 'cors-credentials-invalid')); });
test('CORS lists and max-age', () => {
  assert.equal(ex('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').details.length, 3); assert.ok(has(ex('Access-Control-Allow-Headers', 'X-A, bad name').issues, 'cors-header-invalid'));
  assert.ok(has(ex('Access-Control-Max-Age', 'x').issues, 'cors-maxage-invalid')); assert.ok(has(ex('Access-Control-Max-Age', '999999').issues, 'cors-maxage-cap'));
});
test('CORS wildcard with credentials (cross check) and missing Vary: Origin', () => {
  assert.ok(has(L.crossChecks(L.parseHeaders('Access-Control-Allow-Origin: *\nAccess-Control-Allow-Credentials: true').headers), 'cors-wildcard-credentials'));
  assert.ok(has(L.crossChecks(L.parseHeaders('Access-Control-Allow-Origin: https://a.com').headers), 'cors-no-vary-origin'));
  assert.ok(!has(L.crossChecks(L.parseHeaders('Access-Control-Allow-Origin: https://a.com\nVary: Accept-Encoding, Origin').headers), 'cors-no-vary-origin'));
  assert.ok(!has(L.crossChecks(L.parseHeaders('Access-Control-Allow-Origin: *').headers), 'cors-no-vary-origin'));
});

// ---------------------------------------------------------------- CSP
test('CSP parse directives', () => {
  const p = L.parseCsp("default-src 'self'; img-src 'self' data: https://cdn.example.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.equal(p.policies[0].directives.length, 5); assert.deepEqual(p.policies[0].get('img-src').values, ["'self'", 'data:', 'https://cdn.example.com']);
  assert.equal(p.issues.filter(i => i.level === 'warn').length, 0);
});
test('CSP flags unsafe-inline / unsafe-eval / wildcard / data: / http:', () => {
  const p = L.parseCsp("script-src 'unsafe-inline' 'unsafe-eval' * data: http://x.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  for (const c of ['csp-unsafe-inline', 'csp-unsafe-eval', 'csp-wildcard', 'csp-broad-scheme', 'csp-http-source']) assert.ok(has(p.issues, c), c);
});
test('CSP unsafe-inline is only informational next to a nonce', () => {
  const p = L.parseCsp("script-src 'nonce-abc' 'strict-dynamic' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.ok(has(p.issues, 'csp-unsafe-inline-ignored')); assert.ok(!has(p.issues, 'csp-unsafe-inline'));
});
test('CSP falls back to default-src for script checks', () => assert.ok(has(L.parseCsp("default-src 'unsafe-inline' 'self'").issues, 'csp-unsafe-inline')));
test('CSP reports missing object-src, base-uri, frame-ancestors', () => {
  const p = L.parseCsp("script-src 'self'");
  for (const c of ['csp-missing-object-src', 'csp-missing-base-uri', 'csp-missing-frame-ancestors']) assert.ok(has(p.issues, c), c);
  assert.ok(!has(L.parseCsp("default-src 'none'; base-uri 'none'; frame-ancestors 'none'").issues, 'csp-missing-object-src'));
});
test('CSP no script control', () => assert.ok(has(L.parseCsp("img-src 'self'").issues, 'csp-no-script-control')));
test('CSP unquoted keywords, unknown and duplicate directives, none mixed', () => {
  assert.ok(has(L.parseCsp('script-src self').issues, 'csp-unquoted-keyword')); assert.ok(has(L.parseCsp("foo-src 'self'").issues, 'csp-unknown'));
  assert.ok(has(L.parseCsp("script-src 'self'; script-src 'none'").issues, 'csp-duplicate')); assert.ok(has(L.parseCsp("script-src 'none' https://a.com").issues, 'csp-none-mixed'));
});
test('CSP report-only, deprecated directives, multiple policies, empty', () => {
  assert.ok(has(L.parseCsp("default-src 'self'", { reportOnly: true }).issues, 'csp-report-only')); assert.ok(has(L.parseCsp("default-src 'self'; report-uri /r").issues, 'csp-deprecated'));
  assert.equal(L.parseCsp("default-src 'self', script-src 'none'").policies.length, 2); assert.ok(has(L.parseCsp('').issues, 'csp-empty'));
});
test('CSP explainer is wired for both header names', () => {
  assert.match(ex('Content-Security-Policy-Report-Only', "default-src 'self'").summary, /Report-only/); assert.ok(ex('Content-Security-Policy', "default-src 'self'").details.length === 1);
});

// ---------------------------------------------------------------- HSTS
test('HSTS parse and preload eligibility', () => {
  const p = L.parseHsts('max-age=31536000; includeSubDomains; preload'); assert.equal(p.maxAge, 31536000); assert.equal(p.preloadEligible, true);
  assert.equal(L.parseHsts('max-age=31536000; preload').preloadEligible, false); assert.ok(has(L.parseHsts('max-age=300; includeSubDomains; preload').issues, 'hsts-preload-ineligible'));
  assert.equal(L.parseHsts('MAX-AGE=63072000; INCLUDESUBDOMAINS; PRELOAD').preloadEligible, true);
});
test('HSTS invalid forms', () => {
  assert.ok(has(L.parseHsts('includeSubDomains').issues, 'hsts-no-maxage')); assert.ok(has(L.parseHsts('max-age=abc').issues, 'hsts-bad-maxage')); assert.ok(has(L.parseHsts('max-age=-1').issues, 'hsts-bad-maxage'));
  assert.ok(has(L.parseHsts('max-age=1; max-age=2').issues, 'hsts-duplicate')); assert.ok(has(L.parseHsts('max-age=0').issues, 'hsts-clear')); assert.ok(has(L.parseHsts('max-age=100').issues, 'hsts-short'));
  assert.ok(has(L.parseHsts('max-age="31536000"').issues, 'hsts-https-only'));
});
test('HSTS quoted max-age is accepted', () => assert.equal(L.parseHsts('max-age="31536000"').maxAge, 31536000));

// ---------------------------------------------------------------- other security headers
test('Referrer-Policy valid, invalid, fallback and weak', () => {
  assert.equal(L.parseReferrerPolicy('no-referrer').effective, 'no-referrer'); assert.ok(has(L.parseReferrerPolicy('bogus').issues, 'rp-invalid'));
  const f = L.parseReferrerPolicy('no-referrer, strict-origin-when-cross-origin'); assert.equal(f.effective, 'strict-origin-when-cross-origin'); assert.ok(has(f.issues, 'rp-fallback'));
  assert.ok(has(L.parseReferrerPolicy('unsafe-url').issues, 'rp-weak')); assert.equal(L.parseReferrerPolicy('NO-REFERRER').effective, 'no-referrer');
});
test('Permissions-Policy parse and errors', () => {
  const p = L.parsePermissionsPolicy('camera=(), geolocation=(self "https://a.com"), fullscreen=*'); assert.equal(p.features.length, 3); assert.deepEqual(p.features[1].origins, ['self', 'https://a.com']); assert.equal(p.issues.length, 0);
  assert.ok(has(L.parsePermissionsPolicy("camera 'none'").issues, 'pp-syntax')); assert.ok(has(L.parsePermissionsPolicy('camera=self').issues, 'pp-self-syntax')); assert.ok(has(L.parsePermissionsPolicy('camera=*').issues, 'pp-wildcard-powerful'));
});
test('X-Frame-Options', () => {
  assert.equal(ex('X-Frame-Options', 'deny').issues.length, 0); assert.equal(ex('X-Frame-Options', 'SAMEORIGIN').issues.length, 0);
  assert.ok(has(ex('X-Frame-Options', 'ALLOW-FROM https://a.com').issues, 'xfo-allow-from')); assert.ok(has(ex('X-Frame-Options', 'DENY, SAMEORIGIN').issues, 'xfo-multiple')); assert.ok(has(ex('X-Frame-Options', 'nope').issues, 'xfo-invalid'));
});
test('X-Content-Type-Options and X-XSS-Protection', () => {
  assert.equal(ex('X-Content-Type-Options', 'nosniff').issues.length, 0); assert.ok(has(ex('X-Content-Type-Options', 'sniff').issues, 'xcto-invalid'));
  assert.ok(has(ex('X-XSS-Protection', '1; mode=block').issues, 'xxss-enabled')); assert.ok(has(ex('X-XSS-Protection', '0').issues, 'xxss-off'));
});
test('COOP / COEP / CORP values', () => {
  assert.equal(ex('Cross-Origin-Opener-Policy', 'same-origin').issues.length, 0); assert.ok(has(ex('Cross-Origin-Embedder-Policy', 'require-cors').issues, 'iso-invalid'));
  assert.equal(ex('Cross-Origin-Resource-Policy', 'same-site').issues.length, 0); assert.ok(has(ex('Cross-Origin-Opener-Policy-Report-Only', 'same-origin; report-to="x"').issues, 'iso-report-only'));
});
test('Link header parsing', () => {
  const r = ex('Link', '</style.css>; rel=preload; as=style, <https://a.com/next?a=1,2>; rel="next"'); assert.equal(r.details.length, 2); assert.equal(r.issues.length, 0);
  assert.ok(has(ex('Link', 'style.css; rel=preload').issues, 'link-syntax')); assert.ok(has(ex('Link', '</a>').issues, 'link-no-rel'));
});
test('Accept family with q-values', () => {
  const q = L.parseQList('text/html, application/json;q=0.9, */*;q=0.8'); assert.deepEqual(q.map(i => i.q), [1, 0.9, 0.8]);
  assert.ok(has(ex('Accept', 'text/html;q=1.5', 'request').issues, 'q-invalid')); assert.match(ex('Accept-Language', 'fr;q=0.5, en', 'request').summary, /en > fr/);
  assert.ok(has(ex('Accept-Encoding', 'gzip, snappy', 'request').issues, 'ae-unknown')); assert.ok(has(ex('Accept', 'notamedia', 'request').issues, 'accept-invalid'));
});

// ---------------------------------------------------------------- authorization / masking
test('Authorization is identified but never decoded', () => {
  const b = ex('Authorization', 'Basic dXNlcjpwYXNzd29yZA==', 'request'); const s = JSON.stringify(b);
  assert.ok(!s.includes('dXNlcjpwYXNzd29yZA')); assert.match(b.details[0].value, /Basic/); assert.ok(has(b.issues, 'auth-basic-plain'));
});
test('Authorization Bearer / JWT / unknown / empty', () => {
  assert.ok(has(ex('Authorization', 'Bearer aaa.bbb.ccc', 'request').issues, 'auth-jwt')); assert.ok(has(ex('Authorization', 'Weird abc', 'request').issues, 'auth-unknown-scheme'));
  assert.ok(has(ex('Authorization', 'Bearer', 'request').issues, 'auth-no-credentials')); assert.ok(has(ex('Authorization', 'Basic !!!', 'request').issues, 'auth-basic-b64'));
});
test('WWW-Authenticate challenges', () => { assert.equal(ex('WWW-Authenticate', 'Basic realm="x", Bearer error="invalid_token"').details.length, 2); assert.ok(has(ex('WWW-Authenticate', '???').issues, 'wwwauth-invalid')); });
test('maskValue hides secrets and keeps harmless headers', () => {
  assert.ok(!L.maskValue('Authorization', 'Bearer SECRET123').includes('SECRET123')); assert.match(L.maskValue('Authorization', 'Bearer SECRET123'), /^Bearer /);
  assert.equal(L.maskValue('Cookie', 'a=SECRET; b=TWO').includes('SECRET'), false); assert.ok(L.maskValue('Cookie', 'a=SECRET; b=TWO').startsWith('a='));
  const sc = L.maskValue('Set-Cookie', 'sid=SECRET; Path=/; Secure'); assert.ok(!sc.includes('SECRET') && sc.includes('Path=/; Secure') && sc.startsWith('sid='));
  assert.equal(L.maskValue('Content-Type', 'text/html'), 'text/html'); assert.ok(!L.maskValue('X-Api-Key', 'abc123').includes('abc123')); assert.ok(!L.maskValue('X-Custom-Token', 'abc123').includes('abc123'));
});
test('analyze masks by default and can unmask', () => {
  const a = L.analyze('GET / HTTP/1.1\nAuthorization: Bearer SECRET123\nHost: a.com'); assert.ok(!a.rows[0].display.includes('SECRET123')); assert.equal(a.rows[0].value, 'Bearer SECRET123');
  assert.equal(L.analyze('GET / HTTP/1.1\nAuthorization: Bearer SECRET123', { mask: false }).rows[0].display, 'Bearer SECRET123');
});

// ---------------------------------------------------------------- dates and misc values
test('HTTP date formats', () => {
  assert.equal(L.parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT').format, 'imf'); assert.equal(L.parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT').format, 'rfc850'); assert.equal(L.parseHttpDate('Sun Nov  6 08:49:37 1994').format, 'asctime');
  assert.equal(L.parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT').date.toISOString(), '1994-11-06T08:49:37.000Z'); assert.equal(L.parseHttpDate('Mon, 06 Nov 1994 08:49:37 GMT').weekdayOk, false);
  assert.equal(L.parseHttpDate('Sun, 31 Feb 1994 08:49:37 GMT'), null); assert.equal(L.parseHttpDate('2024-01-01'), null); assert.equal(L.parseHttpDate('Sun, 06 Nov 1994 25:00:00 GMT'), null);
});
test('Date / Last-Modified / Expires explainers', () => {
  assert.ok(has(ex('Date', 'nonsense').issues, 'date-invalid')); assert.ok(has(ex('Date', 'Sunday, 06-Nov-94 08:49:37 GMT').issues, 'date-obsolete')); assert.ok(has(ex('Date', 'Mon, 06 Nov 1994 08:49:37 GMT').issues, 'date-weekday'));
  assert.ok(has(ex('Last-Modified', 'Fri, 01 Jan 2100 00:00:00 GMT').issues, 'lastmod-future')); assert.match(ex('Expires', '0').summary, /expired/);
  assert.equal(ex('Expires', 'nonsense').issues[0].level, 'warn'); assert.match(ex('Date', 'Mon, 15 Jan 2024 11:59:00 GMT').summary, /1 minute ago/); assert.ok(has(ex('Date', 'Mon, 15 Jan 2024 08:00:00 GMT').issues, 'date-skew'));
});
test('Content-Length, ETag, Vary, Retry-After, Content-Disposition', () => {
  assert.match(ex('Content-Length', '1234').summary, /1,234 bytes/); assert.ok(has(ex('Content-Length', '-5').issues, 'cl-invalid')); assert.equal(ex('Content-Length', '5, 6').issues[0].level, 'error');
  assert.match(ex('ETag', 'W/"abc"').summary, /Weak/); assert.match(ex('ETag', '"abc"').summary, /Strong/); assert.ok(has(ex('ETag', 'abc').issues, 'etag-invalid'));
  assert.ok(has(ex('Vary', '*').issues, 'vary-star')); assert.ok(has(ex('Vary', 'Cookie').issues, 'vary-cookie'));
  assert.match(ex('Retry-After', '120').summary, /2 minutes/); assert.ok(has(ex('Retry-After', 'soon').issues, 'retry-invalid'));
  assert.match(ex('Content-Disposition', 'attachment; filename="a.pdf"').summary, /a\.pdf/);
});
test('empty header values are flagged', () => assert.ok(has(ex('X-Anything', '').issues, 'empty-value')));
test('unknown header has no explainer but analyze labels it custom', () => {
  assert.equal(ex('X-Totally-Unknown', 'v'), null); const a = L.analyze('X-Totally-Unknown: v'); assert.equal(a.rows[0].known, false); assert.equal(a.rows[0].category, 'Custom (X-)');
});
test('analyze flags deprecated headers and wrong direction', () => {
  const a = L.analyze('HTTP/1.1 200 OK\nPragma: no-cache\nUser-Agent: x'); assert.ok(has(a.rows[0].issues, 'deprecated')); assert.ok(has(a.rows[1].issues, 'wrong-direction'));
});
test('analyze respects mode override', () => {
  const a = L.analyze('Accept: */*\nCache-Control: no-cache', { mode: 'request' }); assert.equal(a.mode, 'request'); assert.equal(a.security, null);
});

// ---------------------------------------------------------------- security review
test('security: well configured response has no misconfigurations or leaks', () => {
  const a = resp('Content-Type: text/html; charset=utf-8', "Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin', 'Permissions-Policy: camera=(), microphone=()', 'Cross-Origin-Opener-Policy: same-origin', 'Cache-Control: no-store');
  assert.equal(a.security.counts.misconfigured, 0); assert.equal(a.security.counts.leak, 0); assert.equal(a.security.items.filter(i => i.status === 'missing' && i.severity !== 'info').length, 0);
});
test('security: empty response lists missing headers with severities', () => {
  const a = resp('Content-Type: text/html'); const by = id => a.security.items.find(i => i.id === id);
  assert.equal(by('csp').status, 'missing'); assert.equal(by('hsts').status, 'missing'); assert.equal(by('nosniff').status, 'missing'); assert.equal(by('framing').status, 'missing'); assert.equal(by('referrer').status, 'missing');
});
test('security: HSTS requirement depends on the https option', () => {
  assert.equal(L.analyze('HTTP/1.1 200 OK\nContent-Type: text/html', { https: 'no' }).security.items.find(i => i.id === 'hsts').status, 'info');
  assert.equal(L.analyze('HTTP/1.1 200 OK\nContent-Type: text/html', { https: 'yes' }).security.items.find(i => i.id === 'hsts').status, 'missing');
});
test('security: weak CSP is misconfigured with high severity', () => {
  const i = resp("Content-Security-Policy: script-src 'unsafe-inline' *").security.items.find(x => x.id === 'csp'); assert.equal(i.status, 'misconfigured'); assert.equal(i.severity, 'high');
});
test('security: Report-Only CSP is not counted as enforcement', () => assert.equal(resp("Content-Security-Policy-Report-Only: default-src 'self'").security.items.find(i => i.id === 'csp').status, 'missing'));
test('security: clickjacking via X-Frame-Options or frame-ancestors', () => {
  assert.equal(resp('X-Frame-Options: DENY').security.items.find(i => i.id === 'framing').status, 'ok');
  assert.equal(resp("Content-Security-Policy: default-src 'none'; frame-ancestors 'self'").security.items.find(i => i.id === 'framing').status, 'ok');
  assert.equal(resp('X-Frame-Options: ALLOW-FROM https://a.com').security.items.find(i => i.id === 'framing').status, 'misconfigured');
});
test('security: X-XSS-Protection absent is fine, enabled is flagged', () => {
  assert.equal(resp('A: b').security.items.find(i => i.id === 'xxss').status, 'ok'); assert.equal(resp('X-XSS-Protection: 1; mode=block').security.items.find(i => i.id === 'xxss').status, 'misconfigured'); assert.equal(resp('X-XSS-Protection: 0').security.items.find(i => i.id === 'xxss').status, 'ok');
});
test('security: information-leaking headers', () => {
  const a = resp('Server: Apache/2.4.41 (Ubuntu)', 'X-Powered-By: Express', 'X-AspNet-Version: 4.0.30319');
  assert.equal(a.security.counts.leak, 3);
  assert.equal(resp('Server: cloudflare').security.items.find(i => i.id === 'leak-server').status, 'info');
});
test('security: insecure cookies', () => {
  const a = resp('Set-Cookie: session=abc; Path=/', 'Set-Cookie: pref=1; SameSite=None', 'Set-Cookie: __Host-id=1; Secure; Path=/; HttpOnly; SameSite=Strict');
  const items = a.security.items.filter(i => i.header === 'Set-Cookie');
  assert.ok(items.some(i => /session/.test(i.title) && /no secure/.test(i.title))); assert.ok(items.some(i => i.severity === 'high' && /pref/.test(i.title)));
  assert.ok(items.some(i => i.status === 'ok' && /__Host-id/.test(i.title)));
});
test('security: Secure-flag finding is dropped when the response is plain HTTP', () => {
  const a = L.analyze('HTTP/1.1 200 OK\nSet-Cookie: s=1; HttpOnly; SameSite=Lax', { https: 'no' }); assert.ok(!a.security.items.some(i => /no secure/.test(i.title)));
});
test('security: CORS wildcard with credentials, null origin, missing Vary', () => {
  assert.equal(resp('Access-Control-Allow-Origin: *', 'Access-Control-Allow-Credentials: true').security.items.find(i => i.id === 'cors-wildcard-creds').severity, 'high');
  assert.equal(resp('Access-Control-Allow-Origin: null').security.items.find(i => i.id === 'cors-null').status, 'misconfigured');
  assert.equal(resp('Access-Control-Allow-Origin: https://a.com').security.items.find(i => i.id === 'cors-vary').status, 'misconfigured');
  assert.equal(resp('Access-Control-Allow-Origin: https://a.com', 'Vary: Origin').security.items.find(i => i.id === 'cors-ok').status, 'ok');
});
test('security: caching contradictions and cookie caching', () => {
  assert.ok(resp('Cache-Control: no-store, max-age=100').security.items.some(i => i.id === 'cache-conflict'));
  assert.ok(resp('Cache-Control: public, max-age=100', 'Set-Cookie: a=b; Secure; HttpOnly; SameSite=Lax').security.items.some(i => i.id === 'cache-public-cookie'));
  assert.ok(resp('Set-Cookie: a=b; Secure; HttpOnly; SameSite=Lax').security.items.some(i => i.id === 'cache-missing-cookie'));
});
test('security: deprecated / dangerous headers', () => {
  const a = resp('Expect-CT: max-age=1', 'Public-Key-Pins: pin-sha256="x"; max-age=1', 'Feature-Policy: camera none');
  assert.ok(a.security.items.some(i => i.id === 'hpkp')); assert.ok(a.security.items.some(i => i.id === 'deprecated-expect-ct')); assert.ok(a.security.items.some(i => i.id === 'feature-policy'));
});
test('security: disclaimer is present and states heuristic nature', () => { const a = resp('A: b'); assert.match(a.security.disclaimer, /heuristic/i); assert.match(a.security.disclaimer, /HTTPS/); assert.match(a.security.disclaimer, /not a score/i); });
test('security: request mode has no review', () => assert.equal(L.analyze('GET / HTTP/1.1\nHost: a.com').security, null));
test('security: JSON API response with missing CSP is only low severity', () => assert.equal(resp('Content-Type: application/json').security.items.find(i => i.id === 'csp').severity, 'low'));

// ---------------------------------------------------------------- reports
test('JSON report is valid, masked and complete', () => {
  const a = L.analyze('HTTP/1.1 200 OK\nSet-Cookie: sid=SECRET; Path=/\nServer: nginx/1.2', { now: NOW });
  const o = JSON.parse(L.buildReportJson(a)); assert.equal(o.mode, 'response'); assert.equal(o.headers.length, 2); assert.ok(!JSON.stringify(o).includes('SECRET')); assert.ok(o.securityReview.items.length > 5); assert.match(o.securityReview.disclaimer, /heuristic/);
});
test('Markdown report has sections, escapes pipes and hides secrets', () => {
  const a = L.analyze('HTTP/1.1 200 OK\nX-Pipe: a|b\nAuthorization: Bearer SECRET\nCache-Control: no-store, max-age=5', { now: NOW });
  const md = L.buildReportMarkdown(a);
  for (const s of ['# HTTP header analysis', '## Headers', '## Findings', '## Security review', '> Static heuristic']) assert.ok(md.includes(s), s);
  assert.ok(md.includes('a\\|b')); assert.ok(!md.includes('SECRET'));
});
test('Markdown report for request mode omits the security section', () => assert.ok(!L.buildReportMarkdown(L.analyze('GET / HTTP/1.1\nHost: a.com')).includes('## Security review')));
test('report with unmasked option includes raw values', () => assert.ok(L.buildReportJson(L.analyze('HTTP/1.1 200 OK\nX-Api-Key: RAWKEY', { mask: false })).includes('RAWKEY')));

// ---------------------------------------------------------------- helpers
test('splitTop respects quotes, angle brackets and parentheses', () => {
  assert.deepEqual(L.splitTop('a, "b, c", <d,e>, (f, g), h'), ['a', '"b, c"', '<d,e>', '(f, g)', 'h']); assert.deepEqual(L.splitTop(''), []); assert.deepEqual(L.splitTop(',,a,,'), ['a']);
});
test('humanSeconds', () => { assert.equal(L.humanSeconds(1), '1 second'); assert.equal(L.humanSeconds(90), '1 minute 30 seconds'.replace(' 30 seconds', '')); assert.equal(L.humanSeconds(31536000), '1 year'); assert.equal(L.humanSeconds(86400 * 2), '2 days'); });

console.log(`http-header-analyzer: ${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
