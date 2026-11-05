// Run: node tests/unit/curl-converter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as L from '../../tools/curl-converter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const has = (out, re) => assert.match(out, re, out);
const lacks = (out, re) => assert.doesNotMatch(out, re, out);
const P = (cmd, o) => L.parseCurl(cmd, o);
const dir = mkdtempSync(join(tmpdir(), 'curlconv-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
const tool = bin => { const r = spawnSync(bin, ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0; };
const HAVE_PY = tool('python') ? 'python' : tool('python3') ? 'python3' : null;
const HAVE_PHP = tool('php');

const JSON_REQ = { method: 'POST', url: 'https://api.example.com/v1/items?id=1&a=b%20c', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Note', value: `it's "q" \\ $HOME \`x\`` }], body: '{"name":"Zoë \u{1F600}","n":1}', bodyType: 'json', auth: { type: 'basic', username: 'bob', password: 'p"w' } };
const FORM_REQ = { method: 'POST', url: 'http://example.com:8080/login', headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'user=a%20b&pass=x%26y', bodyType: 'form' };
const MULTI_REQ = { method: 'POST', url: 'https://up.example.com/upload', headers: [], bodyType: 'multipart', form: [{ key: 'title', value: 'Hello "world"' }, { key: 'note', value: 'line1\nline2' }] };
const GET_REQ = { method: 'GET', url: 'https://example.com/', headers: [{ key: 'Accept', value: 'text/html' }] };
const ALL = [JSON_REQ, FORM_REQ, MULTI_REQ, GET_REQ, { method: 'DELETE', url: 'https://x.io/a/1' }, { method: 'PATCH', url: 'https://x.io/a', body: 'raw text', bodyType: 'text', headers: [{ key: 'Content-Type', value: 'text/plain' }] }];

function checkJs(code, ext = 'mjs') {
  const f = join(dir, `t${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(f, code);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + '\n' + code);
}

// ---------- parseUrl ----------
test('parseUrl: parts and query order/duplicates', () => {
  const u = L.parseUrl('https://user:pa%20ss@Example.com:8443/a/b?x=1&y=%C3%A9&x=2&flag#frag');
  assert.equal(u.valid, true); assert.equal(u.scheme, 'https'); assert.equal(u.hostname, 'example.com'); assert.equal(u.port, '8443'); assert.equal(u.path, '/a/b');
  assert.equal(u.username, 'user'); assert.equal(u.password, 'pa ss'); assert.equal(u.hash, '#frag');
  assert.deepEqual(u.query.map(q => [q.key, q.value]), [['x', '1'], ['y', 'é'], ['x', '2'], ['flag', '']]);
});
test('parseUrl: invalid / schemeless / plus decoding', () => {
  assert.equal(L.parseUrl('example.com/x').valid, false); assert.equal(L.parseUrl('').valid, false); assert.equal(L.parseUrl('http://').valid, false);
  assert.equal(L.parseUrl('http://a.io/?q=a+b').query[0].value, 'a b'); assert.equal(L.parseUrl('http://a.io/?q=%E0%A4%A').query[0].value, '%E0%A4%A');
});

// ---------- masking ----------
test('isSensitiveHeader / param', () => {
  for (const h of ['Authorization', 'Cookie', 'X-API-Key', 'x-auth-token', 'Proxy-Authorization', 'X-Custom-Secret', 'Set-Cookie']) assert.ok(L.isSensitiveHeader(h), h);
  for (const h of ['Accept', 'Content-Type', 'User-Agent', 'X-Request-Id']) assert.ok(!L.isSensitiveHeader(h), h);
  for (const p of ['api_key', 'token', 'access_token', 'password', 'sig']) assert.ok(L.isSensitiveParam(p), p);
  assert.ok(!L.isSensitiveParam('page'));
});
test('maskHeaderValue keeps structure', () => {
  assert.equal(L.maskHeaderValue('Authorization', 'Bearer abc.def'), `Bearer ${L.MASK}`);
  assert.equal(L.maskHeaderValue('Authorization', 'abc'), L.MASK);
  assert.equal(L.maskHeaderValue('Cookie', 'a=1; b=2'), `a=${L.MASK}; b=${L.MASK}`);
  assert.equal(L.maskHeaderValue('X-API-Key', 'k'), L.MASK); assert.equal(L.maskHeaderValue('X-API-Key', ''), '');
});
test('maskUrl masks sensitive params and userinfo passwords only', () => {
  assert.equal(L.maskUrl('https://a.io/p?id=1&api_key=SECRET&token=T#x'), `https://a.io/p?id=1&api_key=${L.MASK}&token=${L.MASK}#x`);
  assert.equal(L.maskUrl('https://u:pw@a.io/'), `https://u:${L.MASK}@a.io/`); assert.equal(L.maskUrl('https://a.io/?page=2'), 'https://a.io/?page=2');
});
test('maskRequest hides secrets without touching the original', () => {
  const req = { url: 'https://a.io/?key=K', headers: [{ key: 'Authorization', value: 'Bearer X' }, { key: 'Accept', value: 'a' }], auth: { type: 'basic', username: 'u', password: 'p' } };
  const m = L.maskRequest(req);
  assert.equal(m.headers[0].value, `Bearer ${L.MASK}`); assert.equal(m.headers[1].value, 'a'); assert.equal(m.auth.password, L.MASK); assert.equal(m.auth.username, 'u'); assert.match(m.url, /key=•/);
  assert.equal(req.headers[0].value, 'Bearer X'); assert.equal(req.auth.password, 'p'); assert.equal(req.url, 'https://a.io/?key=K');
  assert.deepEqual(L.maskRequest({ url: 'x', auth: { type: 'bearer', token: 't' } }).auth, { type: 'bearer', token: L.MASK });
  assert.equal(L.maskRequest({ url: 'x', auth: { type: 'apikey', in: 'header', name: 'n', value: 'v' } }).auth.value, L.MASK);
});
test('hasSecrets', () => { assert.ok(L.hasSecrets(JSON_REQ)); assert.ok(!L.hasSecrets(GET_REQ)); assert.ok(L.hasSecrets({ url: 'https://a.io/?token=1' })); });
test('masked display never contains the real secret in any target', () => {
  const req = P(`curl https://a.io/x?api_key=TOPSECRET -H 'Authorization: Bearer TOPSECRET' -H 'Cookie: sid=TOPSECRET' -H 'X-API-Key: TOPSECRET' -u bob:TOPSECRET`);
  const masked = L.maskRequest(req);
  for (const t of L.TARGETS) { const code = t.build(masked); lacks(code, /TOPSECRET/); lacks(code, /Ym9iOlRPUFNFQ1JFVA/); }
  for (const t of L.TARGETS) has(t.build(req), /TOPSECRET|Ym9iOlRPUFNFQ1JFVA/);
});

// ---------- analyze ----------
test('analyze: JSON body, query table, headers, masking and reveal', () => {
  const req = P(`curl -X POST 'https://api.example.com/v1/items?id=1&api_key=S3&tag=a&tag=b' -H 'Authorization: Bearer aaa.bbb.ccc' -H 'Content-Type: application/json' -H 'Cookie: sid=1' -d '{"a":{"b":[1,2]}}' -L`);
  const a = L.analyze(req);
  assert.equal(a.method, 'POST'); assert.equal(a.urlParts.host, 'api.example.com'); assert.equal(a.urlParts.port, '443 (default)'); assert.equal(a.urlParts.path, '/v1/items');
  assert.deepEqual(a.query.map(q => [q.key, q.value, q.sensitive]), [['id', '1', false], ['api_key', L.MASK, true], ['tag', 'a', false], ['tag', 'b', false]]);
  assert.equal(a.headers[0].value, `Bearer ${L.MASK}`); assert.equal(a.headers[2].value, `sid=${L.MASK}`); assert.equal(a.headers[1].value, 'application/json');
  assert.equal(a.body.kind, 'json'); assert.equal(a.body.pretty, '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
  assert.equal(a.auth.type, 'Bearer'); assert.match(a.auth.detail, /JWT/); assert.deepEqual(a.flags, ['Follow redirects (-L)']);
  const r = L.analyze(req, { reveal: true });
  assert.equal(r.headers[0].value, 'Bearer aaa.bbb.ccc'); assert.equal(r.query[1].value, 'S3'); assert.match(r.auth.detail, /aaa\.bbb\.ccc/); assert.match(r.url, /api_key=S3/);
});
test('analyze: basic auth from -u and from header', () => {
  assert.match(L.analyze(P('curl -u bob:secret https://a.io')).auth.detail, /user "bob", password •/);
  assert.match(L.analyze(P('curl -u bob:secret https://a.io'), { reveal: true }).auth.detail, /"secret"/);
  const h = L.analyze(P(`curl -H 'Authorization: Basic ${btoa('al:pw')}' https://a.io`)); assert.equal(h.auth.type, 'Basic'); assert.match(h.auth.detail, /user "al"/); lacks(h.auth.detail, /pw/);
});
test('analyze: API key header / query, unknown scheme', () => {
  assert.equal(L.analyze(P(`curl -H 'X-API-Key: k' https://a.io`)).auth.type, 'API key');
  assert.match(L.analyze(P(`curl 'https://a.io/?api_key=k'`)).auth.detail, /api_key/);
  assert.equal(L.analyze(P(`curl -H 'Authorization: Digest abc' https://a.io`)).auth.type, 'Digest');
});
test('analyze: form, multipart and text bodies; invalid JSON warns', () => {
  const f = L.analyze(P(`curl -d 'a=1&b=x%20y&password=p' https://a.io`)); assert.equal(f.body.kind, 'form'); assert.deepEqual(f.body.fields.map(x => [x.key, x.value]), [['a', '1'], ['b', 'x y'], ['password', L.MASK]]);
  const m = L.analyze(P(`curl -F a=1 -F b=2 https://a.io`)); assert.equal(m.body.kind, 'multipart'); assert.equal(m.body.fields.length, 2);
  const t = L.analyze(P(`curl -H 'Content-Type: text/plain' -d 'hello' https://a.io`)); assert.equal(t.body.kind, 'text'); assert.equal(t.body.bytes, 5);
  const bad = L.analyze(P(`curl -H 'Content-Type: application/json' -d '{oops' https://a.io`)); assert.equal(bad.body.kind, 'text'); assert.ok(bad.warnings.some(w => /not valid JSON/.test(w)));
  assert.equal(L.analyze(P('curl https://a.io')).body, null);
});
test('analyze: invalid URL and forbidden headers flagged', () => {
  const a = L.analyze({ method: 'GET', url: 'nope', headers: [{ key: 'Cookie', value: 'a=1' }] }); assert.equal(a.urlParts, null); assert.ok(a.warnings.some(w => /could not be parsed/.test(w))); assert.equal(a.headers[0].forbidden, true);
});
test('analyze: unicode body size in bytes', () => assert.equal(L.analyze({ method: 'POST', url: 'https://a.io', body: 'é\u{1F600}', headers: [] }).body.bytes, 6));

// ---------- raw HTTP ----------
test('raw http: request line, Host, headers, Content-Length', () => {
  const t = L.buildRawHttp(JSON_REQ);
  assert.ok(t.startsWith('POST /v1/items?id=1&a=b%20c HTTP/1.1\nHost: api.example.com\nContent-Type: application/json\n'));
  has(t, /Authorization: Basic Ym9iOnAidw==/); has(t, new RegExp(`Content-Length: ${new TextEncoder().encode(JSON_REQ.body).length}\\n\\n\\{`)); assert.ok(t.endsWith(JSON_REQ.body));
});
test('raw http: port, ipv6, no body, CRLF mode, explicit Host / Content-Length kept', () => {
  assert.ok(L.buildRawHttp({ url: 'http://h:81/x' }).includes('Host: h:81\n'));
  assert.ok(L.buildRawHttp({ url: 'http://h:80/x' }).includes('Host: h\n'));
  assert.ok(L.buildRawHttp({ url: 'https://h:443/x' }).includes('Host: h\n'));
  assert.ok(L.buildRawHttp({ url: 'http://[::1]:3000/x' }).includes('Host: [::1]:3000\n'));
  assert.equal(L.buildRawHttp({ method: 'get', url: 'http://h' }), 'GET / HTTP/1.1\nHost: h\n\n');
  assert.equal(L.buildRawHttp({ url: 'http://h/p?q=1' }, { eol: '\r\n' }), 'GET /p?q=1 HTTP/1.1\r\nHost: h\r\n\r\n');
  const t = L.buildRawHttp({ method: 'POST', url: 'http://h', body: 'x', headers: [{ key: 'Host', value: 'other' }, { key: 'Content-Length', value: '1' }] });
  assert.equal(t.match(/Host:/g).length, 1); assert.equal(t.match(/Content-Length/g).length, 1);
});
test('raw http: multipart body with boundary and byte length', () => {
  const t = L.buildRawHttp(MULTI_REQ, { eol: '\r\n' });
  has(t, new RegExp(`Content-Type: multipart/form-data; boundary=${L.BOUNDARY}\\r\\n`)); has(t, /Content-Disposition: form-data; name="title"\r\n\r\nHello "world"\r\n/); assert.ok(t.endsWith(`--${L.BOUNDARY}--\r\n`));
  const body = t.slice(t.indexOf('\r\n\r\n') + 4); has(t, new RegExp(`Content-Length: ${new TextEncoder().encode(body).length}\\r\\n`));
});
test('raw http: unicode content length counts bytes', () => has(L.buildRawHttp({ method: 'POST', url: 'http://h', body: 'é\u{1F600}' }), /Content-Length: 6\n/));

// ---------- fetch / python from the shared module are wired ----------
test('shared builders are re-exported and work', () => { has(L.buildFetch(GET_REQ), /fetch\("https:\/\/example.com\/"/); has(L.buildPython(JSON_REQ), /requests\.post\(/); });

// ---------- axios ----------
test('axios: json object literal, headers, auth', () => {
  const o = L.buildAxios({ method: 'POST', url: 'https://a.io/x', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Id', value: '1' }], body: '{"a":1,"b":[true]}', auth: { type: 'basic', username: 'u', password: 'p' } });
  has(o, /^import axios from 'axios';/); has(o, /method: "post"/); has(o, /url: "https:\/\/a\.io\/x"/); has(o, /headers: \{\n {4}"Content-Type": "application\/json",\n {4}"X-Id": "1"\n {2}\}/);
  has(o, /auth: \{\n {4}username: "u",\n {4}password: "p"\n {2}\}/); has(o, /data: \{\n {4}"a": 1,\n {4}"b": \[\n {6}true\n {4}\]\n {2}\}/);
});
test('axios: string body for non-JSON, big ints and invalid JSON; multipart FormData; insecure', () => {
  has(L.buildAxios(FORM_REQ), /data: "user=a%20b&pass=x%26y"/);
  has(L.buildAxios({ method: 'POST', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":12345678901234567890}' }), /data: "\{\\"id\\":12345678901234567890\}"/);
  has(L.buildAxios({ method: 'POST', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{bad' }), /data: "\{bad"/);
  const m = L.buildAxios(MULTI_REQ); has(m, /const form = new FormData\(\);\nform\.append\("title", "Hello \\"world\\""\);\nform\.append\("note", "line1\\nline2"\);/); has(m, /data: form/); lacks(m, /Content-Type/);
  const k = L.buildAxios({ url: 'https://a.io', options: { insecure: true } }); has(k, /import https from 'node:https';/); has(k, /rejectUnauthorized: false/);
});

// ---------- Go ----------
test('go: structure, raw string body, headers, basic auth', () => {
  const g = L.buildGo(JSON_REQ);
  has(g, /^package main\n\nimport \(\n\t"fmt"\n\t"io"\n\t"net\/http"\n\t"strings"\n\)/); has(g, /payload := strings\.NewReader\(`\{"name":"Zoë \u{1F600}","n":1\}`\)/u);
  has(g, /http\.NewRequest\("POST", "https:\/\/api\.example\.com\/v1\/items\?id=1&a=b%20c", payload\)/); has(g, /req\.Header\.Set\("Content-Type", "application\/json"\)/);
  has(g, /req\.Header\.Set\("X-Note", "it's \\"q\\" \\\\ \$HOME `x`"\)/); has(g, /req\.SetBasicAuth\("bob", "p\\"w"\)/); has(g, /client := &http\.Client\{\}/);
});
test('go: escaping of backticks / CR / control characters falls back to interpreted strings', () => {
  has(L.buildGo({ method: 'POST', url: 'https://a.io', body: 'a`b' }), /strings\.NewReader\("a`b"\)/);
  has(L.buildGo({ method: 'POST', url: 'https://a.io', body: 'a\r\nb' }), /strings\.NewReader\("a\\r\\nb"\)/);
  has(L.buildGo({ method: 'POST', url: 'https://a.io', body: 'a\u0001b' }), /"a\\x01b"/);
  has(L.buildGo({ method: 'POST', url: 'https://a.io', body: 'multi\nline' }), /strings\.NewReader\(`multi\nline`\)/);
  assert.equal(L.goStr('a"b\\c\n\t'), '"a\\"b\\\\c\\n\\t"');
});
test('go: multipart, insecure and Host header', () => {
  const g = L.buildGo(MULTI_REQ); has(g, /"bytes"/); has(g, /"mime\/multipart"/); has(g, /mw\.WriteField\("title", "Hello \\"world\\""\)/); has(g, /http\.NewRequest\("POST", "https:\/\/up\.example\.com\/upload", &buf\)/); has(g, /mw\.FormDataContentType\(\)/);
  const k = L.buildGo({ url: 'https://a.io', headers: [{ key: 'Host', value: 'virtual' }], options: { insecure: true } }); has(k, /"crypto\/tls"/); has(k, /InsecureSkipVerify: true/); has(k, /req\.Host = "virtual"/); lacks(k, /Header\.Set\("Host"/);
  has(L.buildGo({ url: 'https://a.io' }), /http\.NewRequest\("GET", "https:\/\/a\.io", nil\)/);
});

// ---------- PHP ----------
test('php: options, escaping', () => {
  const p = L.buildPhp(JSON_REQ);
  has(p, /^<\?php\n\n\$ch = curl_init\(\);/); has(p, /CURLOPT_URL => 'https:\/\/api\.example\.com\/v1\/items\?id=1&a=b%20c'/); has(p, /CURLOPT_POST => true/); has(p, /'X-Note: it\\'s "q" \\\\ \$HOME `x`'/);
  has(p, /CURLOPT_USERPWD => 'bob:p"w'/); has(p, /CURLOPT_POSTFIELDS => '\{"name":"Zoë \u{1F600}","n":1\}'/u);
});
test('php: methods, multipart array, flags', () => {
  has(L.buildPhp({ method: 'DELETE', url: 'https://a.io' }), /CURLOPT_CUSTOMREQUEST => 'DELETE'/); has(L.buildPhp({ method: 'HEAD', url: 'https://a.io' }), /CURLOPT_NOBODY => true/);
  lacks(L.buildPhp(GET_REQ), /CUSTOMREQUEST|CURLOPT_POST /); has(L.buildPhp({ method: 'PUT', url: 'https://a.io', body: 'x' }), /CUSTOMREQUEST => 'PUT'[\s\S]*POSTFIELDS => 'x'/);
  has(L.buildPhp(MULTI_REQ), /CURLOPT_POSTFIELDS => \[\n {8}'title' => 'Hello "world"',\n {8}'note' => 'line1\nline2',\n {4}\]/);
  const f = L.buildPhp({ url: 'https://a.io', options: { followRedirects: true, insecure: true, compressed: true } }); has(f, /FOLLOWLOCATION => true/); has(f, /VERIFYPEER => false/); has(f, /ENCODING => ''/);
});

// ---------- Node ----------
test('node: https/http choice, headers, Content-Length, basic auth', () => {
  const n = L.buildNode(JSON_REQ);
  has(n, /^const https = require\('node:https'\);/); has(n, /const url = new URL\("https:\/\/api\.example\.com\/v1\/items\?id=1&a=b%20c"\);/); has(n, /https\.request\(url, \{\n {2}method: "POST"/);
  has(n, /Authorization: "Basic Ym9iOnAidw=="/); has(n, /"Content-Length": Buffer\.byteLength\(body\)/); has(n, /req\.write\(body\);\nreq\.end\(\);/);
  has(L.buildNode(FORM_REQ), /^const http = require\('node:http'\);/); lacks(L.buildNode(GET_REQ), /req\.write/);
  has(L.buildNode({ url: 'https://a.io', options: { insecure: true } }), /rejectUnauthorized: false/);
});
test('node: multipart builds the body by hand', () => {
  const n = L.buildNode(MULTI_REQ);
  has(n, /const boundary = "----DeveloperToolboxFormBoundary7MA4YWxk";/); has(n, /name=\$\{JSON\.stringify\("title"\)\}/); has(n, /"Content-Type": `multipart\/form-data; boundary=\$\{boundary\}`/);
});

// ---------- HTTPie ----------
test('httpie: simple forms', () => {
  assert.equal(L.buildHttpie(GET_REQ), "http GET https://example.com/ Accept:text/html");
  assert.equal(L.buildHttpie({ method: 'DELETE', url: 'https://x.io/a/1' }), 'http DELETE https://x.io/a/1');
  assert.equal(L.buildHttpie(FORM_REQ), "http --form POST http://example.com:8080/login 'user=a b' 'pass=x&y'");
  assert.equal(L.buildHttpie(MULTI_REQ), `http --multipart POST https://up.example.com/upload 'title=Hello "world"' 'note=line1\nline2'`);
});
test('httpie: json body, auth, flags, quoting', () => {
  const h = L.buildHttpie(JSON_REQ);
  assert.ok(h.startsWith(`http -a 'bob:p"w' --raw '{"name":"Zoë \u{1F600}","n":1}' POST 'https://api.example.com/v1/items?id=1&a=b%20c'`), h);
  has(h, /Content-Type:application\/json/); has(h, /'X-Note:it'\\''s "q" \\ \$HOME `x`'/);
  has(L.buildHttpie({ url: 'https://a.io', options: { followRedirects: true, insecure: true } }), /^http --follow --verify=no GET /);
  has(L.buildHttpie({ method: 'POST', url: 'https://a.io', body: "it's" }), /--raw 'it'\\''s' POST/);
});

// ---------- PowerShell ----------
test('powershell: hashtable, content type, body, method', () => {
  const p = L.buildPowerShell(JSON_REQ);
  has(p, /^\$headers = @\{\n {4}'X-Note' = 'it''s "q" \\ \$HOME `x`'\n {4}'Authorization' = 'Basic Ym9iOnAidw=='\n\}\n\$body = '\{"name":"Zoë \u{1F600}","n":1\}'\n\nInvoke-RestMethod -Uri 'https:\/\/api\.example\.com\/v1\/items\?id=1&a=b%20c' `\n {4}-Method Post `\n {4}-Headers \$headers `\n {4}-ContentType 'application\/json' `\n {4}-Body \$body\n$/u);
  has(L.buildPowerShell(GET_REQ), /-Method Get/); has(L.buildPowerShell({ method: 'PURGE', url: 'https://a.io' }), /-CustomMethod 'PURGE'/);
  has(L.buildPowerShell({ url: 'https://a.io', headers: [{ key: 'User-Agent', value: 'x' }], options: { insecure: true } }), /-UserAgent 'x'[\s\S]*-SkipCertificateCheck/);
});
test('powershell: duplicate headers merged, smart quotes doubled, multipart form', () => {
  has(L.buildPowerShell({ url: 'https://a.io', headers: [{ key: 'X-A', value: '1' }, { key: 'x-a', value: '2' }] }), /'X-A' = '1, 2'/);
  has(L.buildPowerShell({ url: 'https://a.io', body: 'it’s', method: 'POST' }), /\$body = 'it’’s'/);
  const m = L.buildPowerShell(MULTI_REQ); has(m, /# -Form requires PowerShell 7/); has(m, /\$form = @\{\n {4}'title' = 'Hello "world"'/); has(m, /-Form \$form/);
});

// ---------- explicit Authorization header beats -u ----------
test('explicit Authorization header wins over -u (curl semantics)', () => {
  const req = P(`curl -u a:b -H 'Authorization: Bearer T' https://a.io`);
  for (const f of [L.buildNode, L.buildPowerShell, L.buildRawHttp, L.buildAxios, L.buildGo]) { const c = f(req); lacks(c, /YTpi|SetBasicAuth|auth: \{/); has(c, /Bearer T/); }
});

// ---------- syntax validation of generated code ----------
test('generated JavaScript parses (fetch, axios, node) for all sample requests', () => {
  for (const r of ALL) { checkJs(L.buildFetch(r), 'mjs'); checkJs(L.buildAxios(r), 'mjs'); checkJs(L.buildNode(r), 'cjs'); }
});
test('generated JavaScript parses with hostile strings', () => {
  const r = { method: 'POST', url: 'https://a.io/?q="\'`${x}\\', headers: [{ key: 'X-Q', value: '"\'`${x}\\\n  ' }, { key: 'a-b', value: '1' }], body: '"\'`${x}\\\n  ', bodyType: 'text' };
  checkJs(L.buildFetch(r)); checkJs(L.buildAxios(r)); checkJs(L.buildNode(r), 'cjs');
  const m = { method: 'POST', url: 'https://a.io', bodyType: 'multipart', form: [{ key: 'k"`${y}', value: 'v\'`${z}\\\n' }] }; checkJs(L.buildAxios(m)); checkJs(L.buildNode(m), 'cjs');
});
test('generated Python parses (when python is installed)', () => {
  if (!HAVE_PY) return;
  for (const r of [...ALL, { method: 'POST', url: 'https://a.io', body: 'a"b\\c\né\u0001', headers: [{ key: 'X', value: '\'"\\' }] }]) {
    const f = join(dir, 't.py'); writeFileSync(f, L.buildPython(r));
    const x = spawnSync(HAVE_PY, ['-I', '-c', `import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())`, f], { encoding: 'utf8' });
    assert.equal(x.status, 0, x.stderr);
  }
});
test('generated PHP lints (when php is installed)', () => {
  if (!HAVE_PHP) return;
  for (const r of ALL) { const f = join(dir, 't.php'); writeFileSync(f, L.buildPhp(r)); const x = spawnSync('php', ['-l', f], { encoding: 'utf8' }); assert.equal(x.status, 0, x.stdout + x.stderr); }
});
test('generated Go is gofmt-clean when go is installed', () => {
  if (!tool('go')) return;
  for (const r of ALL) { const f = join(dir, 't.go'); writeFileSync(f, L.buildGo(r)); const x = spawnSync('gofmt', ['-e', f], { encoding: 'utf8' }); assert.equal(x.status, 0, x.stderr); }
});

// ---------- curl round trips through the shared parser ----------
test('buildCurlFull round trips through parseCurl in all three shells', () => {
  for (const shell of ['posix', 'cmd', 'powershell']) for (const pretty of [false, true]) for (const r of [JSON_REQ, FORM_REQ, GET_REQ, { method: 'PUT', url: 'https://a.io/x', body: 'plain', bodyType: 'text', headers: [{ key: 'Content-Type', value: 'text/plain' }] }]) {
    const cmd = L.buildCurlFull(r, { shell, pretty }); const back = P(cmd, { shell });
    assert.equal(back.method, r.method, cmd); assert.equal(back.url, r.url, cmd); assert.equal(back.body, r.body || '', cmd);
    const want = L.resolveRequest(r); const wantH = want.headers.map(h => `${h.key}:${h.value}`);
    assert.deepEqual(back.headers.map(h => `${h.key}:${h.value}`), wantH, cmd);
    if (want.basic) assert.deepEqual(back.auth, { type: 'basic', username: want.basic.username, password: want.basic.password }, cmd);
  }
});
test('buildCurlFull adds -k and --compressed', () => {
  assert.equal(L.buildCurlFull({ url: 'https://a.io', options: { insecure: true, compressed: true, followRedirects: true } }), "curl --compressed -k -L 'https://a.io'");
  const back = P(L.buildCurlFull({ url: 'https://a.io', options: { insecure: true, compressed: true } })); assert.equal(back.options.insecure, true); assert.equal(back.options.compressed, true);
});
test('parse -> every generator never throws (messy real-world commands)', () => {
  const cmds = [
    `curl 'https://example.com/api' -H 'accept: */*' -H 'accept-language: en' --data-raw $'{"a":"\\u00e9\\n"}' --compressed`,
    'curl ^"https://example.com/api^" ^\n  -H ^"Content-Type: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"',
    'curl.exe -X POST `\n  "https://example.com/" `\n  -H "Content-Type: application/json" `\n  -d \'{"a": 1}\'',
    'curl -F "file=@/tmp/x.png" -F a=b https://a.io', 'curl', 'curl --unknown-flag', "curl 'unterminated", 'curl -d', 'curl ftp://x.io/f',
  ];
  for (const c of cmds) { const r = P(c); for (const t of L.TARGETS) assert.equal(typeof t.build(r), 'string', `${t.id}: ${c}`); L.analyze(r); }
});

// ---------- every target on every sample returns something sensible ----------
test('TARGETS: unique ids, labels, extensions and generate()', () => {
  assert.equal(new Set(L.TARGETS.map(t => t.id)).size, L.TARGETS.length); assert.ok(L.TARGETS.length >= 12);
  for (const t of L.TARGETS) { assert.ok(t.label && t.ext && t.lang, t.id); for (const r of ALL) { const o = t.build(r); assert.ok(o.length > 10, t.id); has(o, /a\.io|example\.com|x\.io/); } }
  assert.equal(L.generate('http', GET_REQ), L.buildRawHttp(GET_REQ)); assert.throws(() => L.generate('nope', GET_REQ));
});
test('no generator embeds a stray "undefined" / "[object" for minimal requests', () => {
  for (const t of L.TARGETS) { const o = t.build({ url: 'https://a.io' }); lacks(o, /undefined|\[object|NaN/); }
});

// ---------- form -> request ----------
const FORM = { method: 'post', url: 'api.example.com/items', params: [{ key: 'q', value: 'a b&c' }, { key: '', value: 'skip' }], headers: [{ key: 'X-Id', value: ' 7 ' }, { key: '', value: '' }],
  bodyType: 'json', body: '{"a":1}', auth: { type: 'bearer', token: 'T' }, options: { followRedirects: true } };
test('requestFromForm: normalises method / url / params / headers / content type', () => {
  const { request: r, errors, warnings } = L.requestFromForm(FORM);
  assert.deepEqual(errors, []); assert.equal(r.method, 'POST'); assert.equal(r.url, 'https://api.example.com/items?q=a%20b%26c'); assert.ok(warnings.some(w => /https:\/\/ was assumed/.test(w)));
  assert.deepEqual(r.headers.map(h => [h.key, h.value]), [['X-Id', '7'], ['Content-Type', 'application/json']]); assert.deepEqual(r.auth, { type: 'bearer', token: 'T' }); assert.equal(r.options.followRedirects, true);
  assert.equal(L.buildCurl(r), "curl -L 'https://api.example.com/items?q=a%20b%26c' -H 'X-Id: 7' -H 'Content-Type: application/json' -H 'Authorization: Bearer T' --data-raw '{\"a\":1}'".replace("curl -L 'h", "curl -L 'h"));
});
test('requestFromForm: existing query string and fragment', () => {
  assert.equal(L.requestFromForm({ url: 'https://a.io/p?x=1#top', params: [{ key: 'y', value: '2' }] }).request.url, 'https://a.io/p?x=1&y=2#top');
  assert.equal(L.requestFromForm({ url: 'https://a.io/p?', params: [{ key: 'y', value: '2' }] }).request.url, 'https://a.io/p?y=2');
});
test('requestFromForm: body types', () => {
  const f = L.requestFromForm({ url: 'https://a.io', method: 'POST', bodyType: 'form', fields: [{ key: 'a b', value: 'é&=' }, { key: 'c', value: '' }] }).request;
  assert.equal(f.body, 'a%20b=%C3%A9%26%3D&c='); assert.equal(f.headers[0].value, 'application/x-www-form-urlencoded');
  const m = L.requestFromForm({ url: 'https://a.io', method: 'POST', bodyType: 'multipart', fields: [{ key: 'k', value: 'v' }] }).request;
  assert.equal(m.bodyType, 'multipart'); assert.deepEqual(m.form, [{ key: 'k', value: 'v' }]); assert.equal(m.headers.length, 0);
  assert.equal(L.requestFromForm({ url: 'https://a.io', bodyType: 'text', body: 'hi' }).request.headers[0].value, 'text/plain');
  assert.equal(L.requestFromForm({ url: 'https://a.io', bodyType: 'raw', body: 'x' }).request.headers.length, 0);
  assert.equal(L.requestFromForm({ url: 'https://a.io', bodyType: 'none', body: 'ignored' }).request.body, '');
  const custom = L.requestFromForm({ url: 'https://a.io', bodyType: 'json', body: '{}', headers: [{ key: 'content-type', value: 'application/vnd.api+json' }] }).request; assert.equal(custom.headers.length, 1);
});
test('requestFromForm: validation errors and warnings', () => {
  assert.ok(L.requestFromForm({ url: '' }).errors.some(e => /Enter a URL/.test(e)));
  assert.ok(L.requestFromForm({ url: 'https://' }).errors.length > 0);
  assert.ok(L.requestFromForm({ url: 'https://a.io', method: 'GE T' }).errors.some(e => /method/.test(e)));
  assert.ok(L.requestFromForm({ url: 'https://a.io', headers: [{ key: 'bad name', value: 'x' }] }).errors.some(e => /not a valid header name/.test(e)));
  assert.ok(L.requestFromForm({ url: 'https://a.io', headers: [{ key: 'X', value: 'a\nb' }] }).errors.some(e => /line break/.test(e)));
  assert.ok(L.requestFromForm({ url: 'https://a.io', bodyType: 'json', body: '{x' }).warnings.some(w => /not valid JSON/.test(w)));
  assert.ok(L.requestFromForm({ url: 'https://a.io', method: 'GET', bodyType: 'text', body: 'x' }).warnings.some(w => /GET requests/.test(w)));
  assert.ok(L.requestFromForm({ url: 'https://a.io', auth: { type: 'bearer', token: '' } }).warnings.some(w => /token is empty/.test(w)));
  assert.ok(L.requestFromForm({ url: 'https://a.io', auth: { type: 'basic' } }).warnings.some(w => /Basic auth/.test(w)));
});
test('requestFromForm: auth variants produce the right curl', () => {
  const mk = auth => L.buildCurl(L.requestFromForm({ url: 'https://a.io', auth }).request);
  assert.equal(mk({ type: 'basic', username: 'u', password: 'p' }), "curl 'https://a.io' -u 'u:p'");
  assert.equal(mk({ type: 'apikey', in: 'header', name: 'X-Key', value: 'v' }), "curl 'https://a.io' -H 'X-Key: v'");
  assert.equal(mk({ type: 'apikey', in: 'query', name: 'key', value: 'v w' }), "curl 'https://a.io?key=v%20w'");
  assert.equal(mk({ type: 'none' }), "curl 'https://a.io'");
});
test('requestFromForm -> curl -> parse round trip in each shell', () => {
  const { request } = L.requestFromForm({ method: 'PUT', url: 'https://a.io/r', headers: [{ key: 'X-T', value: 'a "b" \'c\' $d' }], bodyType: 'json', body: '{"s":"é \u{1F600}","t":"it\'s"}', auth: { type: 'basic', username: 'us', password: 'pw' } });
  for (const shell of ['posix', 'cmd', 'powershell']) { const back = P(L.buildCurlFull(request, { shell, pretty: true }), { shell }); assert.equal(back.method, 'PUT'); assert.equal(back.body, request.body); assert.equal(back.headers.find(h => h.key === 'X-T').value, 'a "b" \'c\' $d'); assert.equal(back.auth.username, 'us'); }
});

// ---------- large input ----------
test('large body (1.5 MB) converts in every target quickly', () => {
  const body = JSON.stringify({ blob: 'xé"\\'.repeat(250000) });
  assert.ok(body.length > 1_500_000);
  const req = { method: 'POST', url: 'https://a.io/upload', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Authorization', value: 'Bearer T' }], body, bodyType: 'json' };
  const t0 = Date.now();
  for (const t of L.TARGETS) { const o = t.build(req); assert.ok(o.length >= body.length, t.id); }
  const a = L.analyze(req); assert.equal(a.body.kind, 'json'); assert.ok(a.body.bytes > 1_500_000);
  assert.ok(Date.now() - t0 < 8000, `slow ${Date.now() - t0}ms`);
  const back = P(L.buildCurl(req)); assert.equal(back.body, body);
});

console.log(`curl-converter: ${pass} tests passed`);
