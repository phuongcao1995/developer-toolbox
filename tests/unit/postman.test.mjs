// Run: node tests/unit/postman.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { importCollection, importEnvironment, exportCollection, exportEnvironment, POSTMAN_SCHEMA } from '../../tools/api-client/postman.js';
import { countRequests, findNode, walk } from '../../tools/api-client/store.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const col = (item, extra = {}) => ({ info: { name: 'C', schema: SCHEMA }, item, ...extra });
const first = r => { let hit; walk([r.collection], n => { if (!hit && n.type === 'request') hit = n; }); return hit; };

test('basic import: folders and requests', () => {
  const r = importCollection(col([
    { name: 'F', item: [{ name: 'Get', request: { method: 'GET', url: { raw: 'https://a.io/x?y=1', protocol: 'https', host: ['a', 'io'], path: ['x'], query: [{ key: 'y', value: '1' }] } } }] },
    { name: 'Top', request: { method: 'post', url: 'https://a.io/t' } },
  ]));
  assert.ok(r.ok, r.error);
  assert.equal(r.collection.type, 'collection'); assert.equal(r.collection.name, 'C');
  assert.equal(r.collection.items[0].type, 'folder'); assert.equal(r.collection.items[0].items[0].request.url, 'https://a.io/x?y=1');
  assert.equal(r.collection.items[1].request.method, 'POST');
  assert.deepEqual(r.stats, { requests: 2, folders: 1, scripts: 0 });
});
test('accepts JSON text', () => assert.ok(importCollection(JSON.stringify(col([])).toString()).ok));
test('url object without raw is rebuilt; disabled query kept as disabled param', () => {
  const r = importCollection(col([{ name: 'a', request: { method: 'GET', url: { protocol: 'http', host: ['localhost'], port: '3000', path: ['api', 'v1'], query: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }] } } }]));
  const q = first(r).request;
  assert.equal(q.url, 'http://localhost:3000/api/v1?a=1');
  assert.deepEqual(q.params.map(p => [p.key, p.value, p.enabled]), [['a', '1', true], ['b', '2', false]]);
});
test('headers incl. disabled', () => {
  const q = first(importCollection(col([{ name: 'a', request: { url: 'u', header: [{ key: 'A', value: '1' }, { key: 'B', value: '2', disabled: true }] } }]))).request;
  assert.deepEqual(q.headers.map(h => [h.key, h.enabled]), [['A', true], ['B', false]]);
});
test('raw json body, language json', () => {
  const q = first(importCollection(col([{ name: 'a', request: { method: 'POST', url: 'u', body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } } }]))).request;
  assert.equal(q.bodyType, 'json'); assert.equal(q.body, '{"a":1}');
});
test('raw xml body adds Content-Type', () => {
  const q = first(importCollection(col([{ name: 'a', request: { method: 'POST', url: 'u', body: { mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } } } }]))).request;
  assert.equal(q.bodyType, 'raw'); assert.ok(q.headers.some(h => h.key === 'Content-Type' && h.value === 'application/xml'));
});
test('urlencoded body keeps {{vars}} unencoded', () => {
  const q = first(importCollection(col([{ name: 'a', request: { method: 'POST', url: 'u', body: { mode: 'urlencoded', urlencoded: [{ key: 'a b', value: '{{x}}&é' }, { key: 'off', value: '1', disabled: true }] } } }]))).request;
  assert.equal(q.bodyType, 'form'); assert.equal(q.body, 'a%20b={{x}}%26%C3%A9');
});
test('formdata: text kept, files skipped with warning', () => {
  const r = importCollection(col([{ name: 'a', request: { method: 'POST', url: 'u', body: { mode: 'formdata', formdata: [{ key: 'a', value: '1', type: 'text' }, { key: 'f', type: 'file', src: 'x.png' }] } } }]));
  const q = first(r).request;
  assert.equal(q.bodyType, 'multipart'); assert.equal(q.body, 'a=1'); assert.ok(r.warnings.some(w => /file/.test(w)));
});
test('graphql body becomes JSON', () => {
  const q = first(importCollection(col([{ name: 'g', request: { method: 'POST', url: 'u', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } } }]))).request;
  assert.equal(q.bodyType, 'json'); assert.deepEqual(JSON.parse(q.body), { query: '{ me { id } }', variables: { a: 1 } });
});
test('file body mode warns', () => assert.ok(importCollection(col([{ name: 'a', request: { url: 'u', body: { mode: 'file', file: {} } } }])).warnings.some(w => /binary|file/.test(w))));
test('auth: bearer, basic, apikey, noauth', () => {
  const mk = auth => first(importCollection(col([{ name: 'a', request: { url: 'u', auth } }]))).request.auth;
  assert.deepEqual(mk({ type: 'bearer', bearer: [{ key: 'token', value: 'T' }] }), { type: 'bearer', token: 'T', prefix: 'Bearer' });
  assert.deepEqual(mk({ type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }), { type: 'basic', username: 'u', password: 'p' });
  assert.deepEqual(mk({ type: 'apikey', apikey: [{ key: 'key', value: 'X-K' }, { key: 'value', value: 'v' }, { key: 'in', value: 'query' }] }), { type: 'apikey', in: 'query', name: 'X-K', value: 'v' });
  assert.deepEqual(mk({ type: 'noauth' }), { type: 'none' });
});
test('auth inheritance: collection -> folder -> request, noauth stops it', () => {
  const r = importCollection(col([
    { name: 'F', auth: { type: 'bearer', bearer: [{ key: 'token', value: 'FOLD' }] }, item: [{ name: 'in', request: { url: 'u' } }, { name: 'off', request: { url: 'u', auth: { type: 'noauth' } } }] },
    { name: 'root', request: { url: 'u' } },
  ], { auth: { type: 'basic', basic: [{ key: 'username', value: 'cu' }, { key: 'password', value: 'cp' }] } }));
  const [f, root] = r.collection.items;
  assert.equal(f.items[0].request.auth.token, 'FOLD'); assert.equal(f.items[1].request.auth.type, 'none'); assert.equal(root.request.auth.username, 'cu');
});
test('unsupported auth type warns', () => {
  const r = importCollection(col([{ name: 'a', request: { url: 'u', auth: { type: 'oauth2', oauth2: [] } } }]));
  assert.ok(r.warnings.some(w => /oauth2/.test(w))); assert.equal(first(r).request.auth.type, 'none');
});
test('scripts are counted and skipped with a warning', () => {
  const r = importCollection(col([
    { name: 'a', event: [{ listen: 'prerequest', script: { exec: ['pm.x()'] } }, { listen: 'test', script: { exec: ['pm.test()'] } }], request: { url: 'u' } },
    { name: 'F', event: [{ listen: 'test', script: { exec: ['x'] } }], item: [] },
    { name: 'empty', event: [{ listen: 'test', script: { exec: [''] } }], request: { url: 'u' } },
  ], { event: [{ listen: 'prerequest', script: { exec: ['y'] } }] }));
  assert.equal(r.stats.scripts, 4); assert.ok(r.warnings.some(w => /4 pre-request\/test scripts skipped/.test(w)));
});
test('collection variables become suggestions', () => {
  const r = importCollection(col([], { variable: [{ key: 'baseUrl', value: 'http://x' }, { key: 's', value: 'v', type: 'secret' }] }));
  assert.deepEqual(r.variables.map(v => [v.key, v.value, v.secret]), [['baseUrl', 'http://x', false], ['s', 'v', true]]);
});
test('dynamic variables mapped; unsupported listed', () => {
  const r = importCollection(col([{ name: 'a', request: { method: 'POST', url: 'u/{{$guid}}?t={{$timestamp}}', body: { mode: 'raw', raw: '{{$randomEmail}} {{$randomInt}}' } } }]));
  const q = first(r).request;
  assert.ok(q.url.includes('{{$uuid}}') && q.url.includes('{{$timestamp}}')); assert.ok(q.body.includes('{{$randomEmail}}'));
  assert.ok(r.warnings.some(w => /\$randomEmail/.test(w)));
});
test('v2.0 schema warns, missing schema warns, v1 rejected', () => {
  assert.ok(importCollection({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [] }).warnings.length);
  assert.ok(importCollection({ info: { name: 'x' }, item: [] }).warnings.length);
  assert.match(importCollection({ id: 'a', name: 'old', requests: [], order: [] }).error, /v1/);
  assert.match(importCollection({ info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' }, item: [] }).error, /v1/);
});
test('malformed input gives clear errors, never throws', () => {
  for (const bad of ['', '   ', '{not json', 'null', '[]', '42', '{}', '{"info":{"name":"x"}}', '{"info":"x","item":[]}']) {
    let r; assert.doesNotThrow(() => { r = importCollection(bad); }, bad);
    assert.equal(r.ok, false, bad); assert.ok(typeof r.error === 'string' && r.error.length > 5, bad);
  }
  assert.match(importCollection('{oops').error, /Not valid JSON/);
  assert.equal(importCollection(null).ok, false); assert.equal(importCollection(undefined).ok, false);
});
test('environment file given to collection import is explained', () => assert.match(importCollection({ name: 'E', values: [], _postman_variable_scope: 'environment' }).error, /environment/));
test('items of the wrong shape are ignored', () => {
  const r = importCollection(col([null, 5, 'x', { name: 'nothing' }, { name: 'ok', request: { url: 'u' } }]));
  assert.ok(r.ok); assert.equal(countRequests([r.collection]), 1);
});
test('huge collection guard (request count)', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: 'r' + i, request: { url: 'u' } }));
  const r = importCollection(col(items), { requests: 50 });
  assert.equal(r.ok, false); assert.match(r.error, /more than 50 requests/);
  assert.ok(importCollection(col(items), { requests: 60 }).ok);
});
test('huge collection guard (default limit and depth)', () => {
  const items = Array.from({ length: 5001 }, (_, i) => ({ name: 'r' + i, request: { url: 'u' } }));
  assert.equal(importCollection(col(items)).ok, false);
  let nested = [{ name: 'leaf', request: { url: 'u' } }];
  for (let i = 0; i < 30; i++) nested = [{ name: 'f' + i, item: nested }];
  assert.match(importCollection(col(nested)).error, /nested/);
});
test('huge text guard', () => {
  const r = importCollection(' '.repeat(26 * 1024 * 1024));
  assert.equal(r.ok, false); assert.match(r.error, /too large/);
});
test('hostile keys do not pollute prototypes', () => {
  const r = importCollection('{"info":{"name":"x","schema":"' + SCHEMA + '"},"item":[{"name":"__proto__","request":{"url":"u","__proto__":{"polluted":1},"header":[{"key":"__proto__","value":"x"}]}}]}');
  assert.ok(r.ok); assert.equal({}.polluted, undefined);
});
test('script / html payloads stay as inert strings', () => {
  const r = importCollection(col([{ name: '<img src=x onerror=alert(1)>', request: { url: 'u' } }]));
  assert.equal(r.collection.items[0].name, '<img src=x onerror=alert(1)>');
});

// ---------- environments ----------
test('environment import', () => {
  const r = importEnvironment({ id: 'x', name: 'Staging', values: [{ key: 'host', value: 'h', enabled: true }, { key: 'tok', value: '', type: 'secret' }, { key: 'off', value: '1', enabled: false }] });
  assert.ok(r.ok); assert.equal(r.environment.name, 'Staging');
  assert.deepEqual(r.environment.vars.map(v => [v.key, v.secret, v.enabled]), [['host', false, true], ['tok', true, true], ['off', false, false]]);
  assert.ok(r.warnings.some(w => /Secret/.test(w)));
});
test('environment import: globals flag and errors', () => {
  assert.equal(importEnvironment({ name: 'G', _postman_variable_scope: 'globals', values: [] }).isGlobals, true);
  for (const bad of ['', '{', '[]', '{}', '{"info":{},"item":[]}']) assert.equal(importEnvironment(bad).ok, false, bad);
});
test('environment export blanks secrets unless included', () => {
  const env = { name: 'E', vars: [{ key: 'a', value: '1', secret: false, enabled: true }, { key: 's', value: 'SECRET', secret: true, enabled: true }] };
  const a = exportEnvironment(env);
  assert.equal(a.values[1].value, ''); assert.equal(a.values[1].type, 'secret'); assert.ok(!JSON.stringify(a).includes('SECRET'));
  assert.equal(exportEnvironment(env, { includeSecrets: true }).values[1].value, 'SECRET');
  assert.equal(a._postman_variable_scope, 'environment');
});

// ---------- export / round trip ----------
const sampleTree = () => ({
  type: 'collection', id: 'c1', name: 'My API', items: [
    { type: 'folder', id: 'f1', name: 'Users', items: [
      { type: 'request', id: 'r1', name: 'List', request: { method: 'GET', url: 'https://{{host}}/users?page=1', params: [{ key: 'page', value: '1', enabled: true }, { key: 'x', value: 'y', enabled: false }], headers: [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-Off', value: '1', enabled: false }], bodyType: 'json', body: '', auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' }, settings: {} } },
      { type: 'request', id: 'r2', name: 'Create', request: { method: 'POST', url: 'https://{{host}}/users', params: [], headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], bodyType: 'json', body: '{"name":"Zoë \\"Q\\"","n":[1,2]}', auth: { type: 'basic', username: 'u', password: 'p' }, settings: {} } },
    ] },
    { type: 'request', id: 'r3', name: 'Form', request: { method: 'POST', url: 'http://localhost:8080/f', params: [], headers: [], bodyType: 'form', body: 'a=1&b=x%20y', auth: { type: 'apikey', in: 'query', name: 'k', value: 'v' }, settings: {} } },
    { type: 'request', id: 'r4', name: 'Multi', request: { method: 'POST', url: 'https://h/m', params: [], headers: [], bodyType: 'multipart', body: 'a=1\nb=two words', auth: { type: 'none' }, settings: {} } },
  ],
});
const strip = n => (n.type === 'request' ? { name: n.name, request: n.request } : { name: n.name, items: n.items.map(strip) });
test('export has v2.1 shape', () => {
  const x = exportCollection(sampleTree());
  assert.equal(x.info.schema, POSTMAN_SCHEMA); assert.equal(x.info.name, 'My API'); assert.equal(x.item[0].name, 'Users');
  const list = x.item[0].item[0].request;
  assert.equal(list.url.raw, 'https://{{host}}/users?page=1'); assert.deepEqual(list.url.host, ['{{host}}']); assert.deepEqual(list.url.path, ['users']);
  assert.equal(list.url.query[1].disabled, true); assert.equal(list.header[1].disabled, true);
  assert.deepEqual(list.auth, { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] });
  assert.equal(x.item[0].item[1].request.body.options.raw.language, 'json');
  assert.equal(x.item[1].request.body.mode, 'urlencoded'); assert.deepEqual(x.item[1].request.body.urlencoded[1], { key: 'b', value: 'x y', type: 'text' });
  assert.equal(x.item[2].request.body.mode, 'formdata');
});
test('round trip: export -> import preserves requests', () => {
  const src = sampleTree();
  const back = importCollection(JSON.parse(JSON.stringify(exportCollection(src, { includeSecrets: true }))));
  assert.ok(back.ok, back.error);
  assert.deepEqual(strip(back.collection), strip(src));
});
test('export blanks literal secrets but keeps {{var}} references', () => {
  const x = JSON.stringify(exportCollection(sampleTree()));
  assert.ok(!x.includes('"p"') && x.includes('{{token}}'));
  const raw = JSON.parse(x).item[0].item[1].request.auth.basic;
  assert.equal(raw.find(f => f.key === 'password').value, '');
});
test('export variables: secrets blanked unless included', () => {
  const vars = [{ key: 'a', value: '1', secret: false }, { key: 's', value: 'TOP', secret: true }];
  const x = exportCollection(sampleTree(), { variables: vars });
  assert.ok(!JSON.stringify(x).includes('TOP')); assert.equal(x.variable.length, 2);
  assert.ok(JSON.stringify(exportCollection(sampleTree(), { variables: vars, includeSecrets: true })).includes('TOP'));
});
test('round trip survives JSON stringify of unicode and quotes', () => {
  const src = sampleTree();
  const text = JSON.stringify(exportCollection(src, { includeSecrets: true }));
  assert.deepEqual(strip(importCollection(text).collection), strip(src));
});
test('custom auth prefix exports as Authorization apikey', () => {
  const t = { type: 'collection', id: 'c', name: 'n', items: [{ type: 'request', id: 'r', name: 'a', request: { method: 'GET', url: 'https://h', params: [], headers: [], bodyType: 'json', body: '', auth: { type: 'custom', prefix: 'Token', credential: 'abc' }, settings: {} } }] };
  const x = exportCollection(t, { includeSecrets: true });
  assert.deepEqual(x.item[0].request.auth.apikey[1], { key: 'value', value: 'Token abc', type: 'string' });
});
test('exportCollection rejects non-collection', () => assert.throws(() => exportCollection({ type: 'folder' })));
test('imported tree is addressable by id', () => {
  const r = importCollection(col([{ name: 'a', request: { url: 'u' } }]));
  assert.ok(findNode([r.collection], r.collection.items[0].id));
});

console.log(`postman: ${pass} passed`);
