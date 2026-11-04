// Run: node tests/unit/curl.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { parseCurl, buildCurl, buildFetch, buildPython, tokenize, shellQuote, base64Utf8, urlencodeStrict, isForbiddenHeader } from '../../assets/js/shared/curl.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const hv = (r, name) => r.headers.find(h => h.key.toLowerCase() === name.toLowerCase())?.value;
const core = r => ({ method: r.method, url: r.url, headers: r.headers.map(h => [h.key, h.value]), body: r.body, bodyType: r.bodyType, form: r.form.map(f => [f.key, f.value]), auth: r.auth });

// ---------- tokenizer ----------
test('tokenize: plain words', () => assert.deepEqual(tokenize('curl -X POST url').tokens, ['curl', '-X', 'POST', 'url']));
test('tokenize: single quotes are literal', () => assert.deepEqual(tokenize(`a 'b "c" \\n $x' d`).tokens, ['a', 'b "c" \\n $x', 'd']));
test('tokenize: double quotes with escapes', () => assert.deepEqual(tokenize('a "b \\"c\\" \\$x \\\\ \\n"').tokens, ['a', 'b "c" $x \\ \\n']));
test('tokenize: adjacent quoted segments concatenate', () => assert.deepEqual(tokenize(`a'b'"c"d`).tokens, ['abcd']));
test('tokenize: empty quoted argument kept', () => assert.deepEqual(tokenize(`a '' ""`).tokens, ['a', '', '']));
test('tokenize: ANSI-C quoting', () => assert.deepEqual(tokenize(`$'a\\nb\\t\\'q\\' \\u00e9 \\x41 \\101 \\\\'`).tokens, ["a\nb\t'q' é A A \\"]));
test('tokenize: ANSI-C utf-8 bytes and astral', () => assert.deepEqual(tokenize(`$'\\xc3\\xa9 \\U0001F600'`).tokens, ['é 😀']));
test('tokenize: backslash-newline continuation', () => assert.deepEqual(tokenize('curl \\\n  -X POST \\\r\n  url').tokens, ['curl', '-X', 'POST', 'url']));
test('tokenize: backslash escapes outside quotes', () => assert.deepEqual(tokenize('a\\ b c\\"d').tokens, ['a b', 'c"d']));
test('tokenize: stops at pipe / semicolon / &&', () => {
  for (const t of ['curl a | jq .', 'curl a ; echo', 'curl a && echo']) { const r = tokenize(t); assert.deepEqual(r.tokens, ['curl', 'a']); assert.ok(r.stopped); }
  assert.ok(!tokenize(`curl 'a|b;c'`).stopped);
});
test('tokenize: lone & stays in the URL', () => assert.deepEqual(tokenize('curl http://h/?a=1&b=2').tokens, ['curl', 'http://h/?a=1&b=2']));
test('tokenize: unterminated quote flagged', () => { const r = tokenize(`curl 'abc`); assert.ok(r.unterminated); assert.deepEqual(r.tokens, ['curl', 'abc']); });
test('tokenize: expansions flagged, not evaluated', () => { const r = tokenize('curl "$TOKEN" $(date)'); assert.ok(r.expansions); assert.equal(r.tokens[1], '$TOKEN'); });
test('tokenize: comments', () => assert.deepEqual(tokenize('a b # c d\ne').tokens, ['a', 'b', 'e']));
test('tokenize cmd: carets and continuation', () => assert.deepEqual(tokenize('curl ^\n  "http://h/" ^\n  -H ^"a: b^"', 'cmd').tokens, ['curl', 'http://h/', '-H', 'a: b']));
test('tokenize cmd: escaped quotes inside', () => assert.deepEqual(tokenize('x ^"^{^\\^"a^\\^":1^}^"', 'cmd').tokens, ['x', '{"a":1}']));
test('tokenize powershell: doubled single quote and backtick', () => assert.deepEqual(tokenize("a 'it''s' \"x`ty\"", 'powershell').tokens, ['a', "it's", 'x\ty']));

// ---------- parse ----------
test('parse: simple GET', () => {
  const r = parseCurl('curl https://api.example.com/x?y=1');
  assert.equal(r.method, 'GET'); assert.equal(r.url, 'https://api.example.com/x?y=1'); assert.equal(r.body, ''); assert.deepEqual(r.warnings, []);
});
test('parse: leading $ prompt and curl.exe', () => assert.equal(parseCurl('$ curl.exe https://a.io').url, 'https://a.io'));
test('parse: -X and headers', () => {
  const r = parseCurl(`curl -X PUT 'https://a.io/r' -H 'Accept: text/plain' --header "X-A: 1:2"`);
  assert.equal(r.method, 'PUT'); assert.equal(hv(r, 'accept'), 'text/plain'); assert.equal(hv(r, 'X-A'), '1:2');
});
test('parse: --request=PATCH and --header=... forms', () => {
  const r = parseCurl('curl --request=PATCH --header="A: b" https://a.io');
  assert.equal(r.method, 'PATCH'); assert.equal(hv(r, 'A'), 'b');
});
test('parse: -XPOST and -H attached values, clustered flags', () => {
  const r = parseCurl(`curl -sSLXPOST -H'A: b' https://a.io`);
  assert.equal(r.method, 'POST'); assert.equal(hv(r, 'A'), 'b'); assert.equal(r.options.followRedirects, true);
});
test('parse: implicit POST with -d, JSON content type', () => {
  const r = parseCurl(`curl https://a.io -H 'Content-Type: application/json' -d '{"a":"b \\"q\\""}'`);
  assert.equal(r.method, 'POST'); assert.equal(r.bodyType, 'json'); assert.equal(r.body, '{"a":"b \\"q\\""}');
});
test('parse: explicit -X wins over implicit POST', () => assert.equal(parseCurl(`curl -X PUT -d a=1 https://a.io`).method, 'PUT'));
test('parse: multiple -d joined with &', () => {
  const r = parseCurl('curl -d a=1 --data b=2 --data-raw c=3 --data-binary d=4 https://a.io');
  assert.equal(r.body, 'a=1&b=2&c=3&d=4'); assert.equal(r.bodyType, 'form');
});
test('parse: --data-urlencode forms', () => {
  const r = parseCurl(`curl --data-urlencode 'q=a b&c' --data-urlencode 'x y' --data-urlencode '=é/' https://a.io`);
  assert.equal(r.body, 'q=a%20b%26c&x%20y&%C3%A9%2F');
});
test('parse: -d @file unsupported but not fatal', () => {
  const r = parseCurl('curl -d @body.json https://a.io');
  assert.equal(r.body, ''); assert.ok(r.warnings.some(w => /file/.test(w)));
});
test('parse: --data-raw keeps leading @', () => assert.equal(parseCurl(`curl --data-raw '@x' https://a.io`).body, '@x'));
test('parse: -G moves data to the query', () => {
  const r = parseCurl('curl -G -d a=1 -d b=2 https://a.io/p');
  assert.equal(r.url, 'https://a.io/p?a=1&b=2'); assert.equal(r.method, 'GET'); assert.equal(r.body, '');
  assert.equal(parseCurl('curl --get -d c=3 "https://a.io/p?x=1#f"').url, 'https://a.io/p?x=1&c=3#f');
});
test('parse: -I means HEAD', () => assert.equal(parseCurl('curl -I https://a.io').method, 'HEAD'));
test('parse: -u basic auth', () => {
  assert.deepEqual(parseCurl(`curl -u 'me:p:w' https://a.io`).auth, { type: 'basic', username: 'me', password: 'p:w' });
  const r = parseCurl('curl -u me https://a.io');
  assert.equal(r.auth.password, ''); assert.ok(r.warnings.length);
});
test('parse: -A, -e, -b become headers (with browser warning)', () => {
  const r = parseCurl(`curl -A 'UA/1' -e http://ref/ -b 'a=b; c=d' https://a.io`);
  assert.equal(hv(r, 'user-agent'), 'UA/1'); assert.equal(hv(r, 'referer'), 'http://ref/'); assert.equal(hv(r, 'cookie'), 'a=b; c=d');
  assert.ok(r.warnings.some(w => /browser/.test(w)));
});
test('parse: --compressed -L -k -s -v flags', () => {
  const r = parseCurl('curl --compressed -L -k -s -v https://a.io');
  assert.equal(r.options.compressed, true); assert.equal(r.options.followRedirects, true); assert.equal(r.options.insecure, true);
});
test('parse: --url and positional', () => assert.equal(parseCurl('curl --url https://a.io -s').url, 'https://a.io'));
test('parse: URL without scheme warns', () => {
  const r = parseCurl('curl example.com/x'); assert.equal(r.url, 'http://example.com/x'); assert.ok(r.warnings.some(w => /scheme/.test(w)));
});
test('parse: --json sets headers and body', () => {
  const r = parseCurl(`curl --json '{"a":1}' https://a.io`);
  assert.equal(r.method, 'POST'); assert.equal(r.body, '{"a":1}'); assert.equal(hv(r, 'content-type'), 'application/json'); assert.equal(hv(r, 'accept'), 'application/json'); assert.equal(r.bodyType, 'json');
});
test('parse: --json keeps explicit content type', () => assert.equal(hv(parseCurl(`curl -H 'Content-Type: application/vnd.x+json' --json '{}' https://a.io`), 'content-type'), 'application/vnd.x+json'));
test('parse: multipart -F', () => {
  const r = parseCurl(`curl -F 'a=1' -F 'b=hello world;type=text/plain' -F 'f=@/tmp/x.png' --form-string 'c=@lit' https://a.io`);
  assert.equal(r.bodyType, 'multipart'); assert.equal(r.method, 'POST');
  assert.deepEqual(r.form.map(f => [f.key, f.value, f.file]), [['a', '1', false], ['b', 'hello world', false], ['f', '', true], ['c', '@lit', false]]);
  assert.ok(r.warnings.some(w => /file uploads are not supported/.test(w)));
});
test('parse: unknown flags are collected, not fatal', () => {
  const r = parseCurl('curl --frobnicate -Z https://a.io');
  assert.equal(r.url, 'https://a.io'); assert.ok(r.warnings.some(w => /--frobnicate/.test(w)));
});
test('parse: -o file consumes its value', () => assert.equal(parseCurl('curl -o out.txt https://a.io').url, 'https://a.io'));
test('parse: stops at pipe', () => { const r = parseCurl('curl https://a.io | jq .'); assert.equal(r.url, 'https://a.io'); assert.ok(r.warnings.some(w => /ignored/.test(w))); });
test('parse: unicode and emoji in body', () => assert.equal(parseCurl(`curl -d '{"n":"héllo 日本 😀"}' -H 'Content-Type: application/json' https://a.io`).body, '{"n":"héllo 日本 😀"}'));
test('parse: Chrome style $\'..\' body with escapes', () => {
  const r = parseCurl(`curl 'https://a.io' -H 'content-type: application/json' --data-raw $'{"a":"it\\'s\\\\n"}'`);
  assert.equal(r.body, `{"a":"it's\\n"}`);
});
test('parse: Chrome "Copy as cURL (cmd)" caret format', () => {
  const t = 'curl ^"https://a.io/x^" ^\n  -H ^"accept: application/json^" ^\n  -H ^"content-type: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":^\\^"b^\\^"^}^"';
  const r = parseCurl(t);
  assert.equal(r.url, 'https://a.io/x'); assert.equal(r.method, 'POST'); assert.equal(r.body, '{"a":"b"}'); assert.equal(r.bodyType, 'json');
});
test('parse: PowerShell backtick continuation', () => {
  const r = parseCurl("curl.exe -X POST `\n  'https://a.io' `\n  -H 'A: it''s' `\n  --data-raw 'x=1'");
  assert.equal(r.url, 'https://a.io'); assert.equal(hv(r, 'A'), "it's"); assert.equal(r.body, 'x=1');
});
test('parse: JSON-looking body without content-type', () => {
  const r = parseCurl(`curl -d '{"a":1}' https://a.io`);
  assert.equal(r.bodyType, 'json'); assert.ok(r.warnings.some(w => /Content-Type/.test(w)));
});
test('parse: text and raw body types from Content-Type', () => {
  assert.equal(parseCurl(`curl -H 'Content-Type: text/plain' -d hi https://a.io`).bodyType, 'text');
  assert.equal(parseCurl(`curl -H 'Content-Type: application/xml' -d '<a/>' https://a.io`).bodyType, 'raw');
});
test('parse: empty input, missing URL, empty header values', () => {
  assert.ok(parseCurl('').warnings.length);
  assert.ok(parseCurl('curl -X POST').warnings.some(w => /No URL/.test(w)));
  assert.equal(parseCurl(`curl -H 'X-Empty;' https://a.io`).headers[0].value, '');
});
test('parse: never throws on garbage', () => {
  for (const t of ['curl', '-', '--', "curl '", 'curl -H', 'curl -d', '\u0000', '"""', "curl --data-urlencode"]) assert.doesNotThrow(() => parseCurl(t), t);
});
test('parse: shell variable warning', () => assert.ok(parseCurl('curl -H "Authorization: Bearer $TOKEN" https://a.io').warnings.some(w => /not expanded/.test(w))));
test('parse: --oauth2-bearer', () => assert.equal(hv(parseCurl('curl --oauth2-bearer abc https://a.io'), 'authorization'), 'Bearer abc'));
test('forbidden header list', () => { assert.ok(isForbiddenHeader('Cookie') && isForbiddenHeader('sec-fetch-mode')); assert.ok(!isForbiddenHeader('Authorization')); });

// ---------- build ----------
test('build: GET minimal', () => assert.equal(buildCurl({ url: 'https://a.io' }), "curl 'https://a.io'"));
test('build: POST with body drops redundant -X', () => assert.equal(buildCurl({ method: 'POST', url: 'u', body: 'x' }), "curl 'u' --data-raw 'x'"));
test('build: POST without body keeps -X', () => assert.equal(buildCurl({ method: 'POST', url: 'u' }), "curl -X POST 'u'"));
test('build: HEAD and DELETE', () => {
  assert.equal(buildCurl({ method: 'HEAD', url: 'u' }), "curl -I 'u'");
  assert.equal(buildCurl({ method: 'DELETE', url: 'u' }), "curl -X DELETE 'u'");
});
test('build: single quote escaping', () => assert.equal(buildCurl({ url: 'u', headers: { A: "it's" } }), "curl 'u' -H 'A: it'\\''s'"));
test('build: basic auth uses -u, bearer becomes header, api key header/query', () => {
  assert.equal(buildCurl({ url: 'u', auth: { type: 'basic', username: 'a', password: 'b' } }), "curl 'u' -u 'a:b'");
  assert.equal(buildCurl({ url: 'u', auth: { type: 'bearer', token: 't' } }), "curl 'u' -H 'Authorization: Bearer t'");
  assert.equal(buildCurl({ url: 'https://h/p', auth: { type: 'apikey', in: 'query', name: 'k', value: 'a b' } }), "curl 'https://h/p?k=a%20b'");
  assert.equal(buildCurl({ url: 'u', auth: { type: 'apikey', in: 'header', name: 'X-K', value: 'v' } }), "curl 'u' -H 'X-K: v'");
});
test('build: skips disabled header rows', () => assert.equal(buildCurl({ url: 'u', headers: [{ key: 'A', value: '1' }, { key: 'B', value: '2', enabled: false }] }), "curl 'u' -H 'A: 1'"));
test('build: pretty posix / cmd / powershell', () => {
  const req = { method: 'POST', url: 'https://a.io', headers: { A: 'b' }, body: 'x' };
  assert.equal(buildCurl(req, { pretty: true }), "curl 'https://a.io' \\\n  -H 'A: b' \\\n  --data-raw 'x'");
  assert.equal(buildCurl(req, { shell: 'powershell', pretty: true }), "curl.exe 'https://a.io' `\n  -H 'A: b' `\n  --data-raw 'x'");
  assert.ok(buildCurl(req, { shell: 'cmd', pretty: true }).includes(' ^\n  '));
});
test('build: powershell doubles single quotes', () => assert.equal(buildCurl({ url: 'u', headers: { A: "it's" } }, { shell: 'powershell' }), "curl.exe 'u' -H 'A: it''s'"));
test('build: cmd escapes quotes and specials', () => {
  const c = buildCurl({ method: 'POST', url: 'https://a.io', body: '{"a":"b&c"}' }, { shell: 'cmd' });
  assert.ok(c.includes('^"https://a.io^"')); assert.ok(c.includes('^{^\\^"a^\\^"')); assert.ok(c.includes('b^&c'));
});
test('build: multipart', () => {
  const c = buildCurl({ method: 'POST', url: 'u', bodyType: 'multipart', form: [{ key: 'a', value: '1' }, { key: 'b', value: '@x' }] });
  assert.equal(c, "curl 'u' -F 'a=1' --form-string 'b=@x'");
});
test('build: -L option', () => assert.equal(buildCurl({ url: 'u', options: { followRedirects: true } }), "curl -L 'u'"));
test('shellQuote helpers', () => { assert.equal(shellQuote("a'b"), "'a'\\''b'"); assert.equal(shellQuote("a'b", 'powershell'), "'a''b'"); });
test('base64Utf8 / urlencodeStrict', () => {
  assert.equal(base64Utf8('user:pässwörd'), 'dXNlcjpww6Rzc3fDtnJk'); assert.equal(base64Utf8(''), '');
  assert.equal(urlencodeStrict("a b!'()*~"), 'a%20b%21%27%28%29%2A~');
});

// ---------- round trips ----------
const SAMPLES = [
  { method: 'GET', url: 'https://a.io/p?x=1&y=%20z', headers: [], body: '', bodyType: 'json', form: [], auth: null },
  { method: 'POST', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{"a":"it\'s \\"q\\"","n":[1,2]}', bodyType: 'json', form: [], auth: null },
  { method: 'PUT', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-A', value: 'é 日本 😀' }], body: '{"u":"日本 😀"}', bodyType: 'json', form: [], auth: null },
  { method: 'POST', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'text/plain' }], body: 'line1\nline2 $HOME `x` "y" \\ end', bodyType: 'text', form: [], auth: null },
  { method: 'POST', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'a=1&b=%20x', bodyType: 'form', form: [], auth: null },
  { method: 'GET', url: 'https://a.io', headers: [{ key: 'Accept', value: '*/*' }], body: '', bodyType: 'json', form: [], auth: { type: 'basic', username: 'u', password: "p'w" } },
  { method: 'DELETE', url: 'https://a.io/1', headers: [], body: '', bodyType: 'json', form: [], auth: null },
  { method: 'HEAD', url: 'https://a.io', headers: [], body: '', bodyType: 'json', form: [], auth: null },
  { method: 'POST', url: 'https://a.io', headers: [], body: '', bodyType: 'multipart', form: [{ key: 'a', value: 'x y' }, { key: 'b', value: "it's" }, { key: 'c', value: '@notfile' }], auth: null },
  { method: 'POST', url: 'https://a.io', headers: [{ key: 'Content-Type', value: 'application/xml' }], body: '<a b="c"/>', bodyType: 'raw', form: [], auth: null },
];
for (const [i, s] of SAMPLES.entries()) {
  for (const shell of ['posix', 'powershell', 'cmd']) {
    for (const pretty of [false, true]) {
      test(`round trip #${i} ${shell}${pretty ? ' pretty' : ''}`, () => {
        const built = buildCurl(s, { shell, pretty });
        const back = parseCurl(built);
        assert.deepEqual(core(back), core(s), built);
      });
    }
  }
}
test('round trip: parse(build(parse(x))) is stable', () => {
  const x = parseCurl(`curl -sL 'https://a.io/x' -H "Accept: application/json" -H 'Content-Type: application/json' -u u:p --data-raw $'{"é":"\\u00e9\\n"}'`);
  assert.deepEqual(core(parseCurl(buildCurl(x))), core(x));
});

// ---------- fetch / python snippets ----------
test('fetch: GET', () => assert.equal(buildFetch({ url: 'https://a.io' }, { pretty: false }), 'fetch("https://a.io") .then(res => res.text()) .then(console.log) .catch(console.error);'));
test('fetch: POST JSON body escaped', () => {
  const s = buildFetch({ method: 'POST', url: 'https://a.io', headers: { 'Content-Type': 'application/json' }, body: '{"a":"b\\"c"}' });
  assert.ok(s.includes('method: "POST"')); assert.ok(s.includes('"Content-Type": "application/json"')); assert.ok(s.includes('body: "{\\"a\\":\\"b\\\\\\"c\\"}"'));
});
test('fetch: basic auth uses UTF-8 base64, multipart uses FormData', () => {
  assert.ok(buildFetch({ url: 'u', auth: { type: 'basic', username: 'user', password: 'pässwörd' } }).includes('Basic dXNlcjpww6Rzc3fDtnJk'));
  const f = buildFetch({ method: 'POST', url: 'u', bodyType: 'multipart', form: [{ key: 'a', value: 'b' }] });
  assert.ok(f.includes('new FormData()') && f.includes('form.append("a", "b");') && f.includes('body: form'));
});
test('fetch: line separators and quotes are escaped', () => {
  const s = buildFetch({ method: 'POST', url: 'https://a.io/?q="x"', headers: { A: 'x\ny' }, body: 'a\u2028b' });
  assert.ok(s.includes('\\u2028') && !s.includes('\u2028') && s.includes('?q=\\"x\\"') && s.includes('"x\\ny"'));
});
test('python: GET and POST', () => {
  assert.equal(buildPython({ url: 'https://a.io' }), 'import requests\n\nresponse = requests.get(\n    "https://a.io",\n)\n\nprint(response.status_code)\nprint(response.text)\n');
  const p = buildPython({ method: 'POST', url: 'u', headers: { A: 'b"c' }, body: 'line1\nline2\t"x"\\', auth: { type: 'basic', username: 'u', password: 'p' } });
  assert.ok(p.includes('requests.post(')); assert.ok(p.includes('"A": "b\\"c",')); assert.ok(p.includes('data="line1\\nline2\\t\\"x\\"\\\\".encode("utf-8")')); assert.ok(p.includes('auth=("u", "p")'));
});
test('python: custom method, multipart', () => {
  assert.ok(buildPython({ method: 'PURGE', url: 'u' }).includes('requests.request("PURGE",'));
  assert.ok(buildPython({ method: 'POST', url: 'u', bodyType: 'multipart', form: [{ key: 'a', value: 'b' }] }).includes('"a": (None, "b"),'));
});

console.log(`curl: ${pass} passed`);
