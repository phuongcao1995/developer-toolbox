// Run: node tests/unit/api-client-compose.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as C from '../../tools/api-client/compose.js';
import * as L from '../../tools/api-client/logic.js';
import * as S from '../../tools/api-client/store.js';
import { parseCurl, buildCurl, buildFetch, buildPython } from '../../assets/js/shared/curl.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const row = (key, value, extra = {}) => ({ key, value, enabled: true, ...extra });
const draft = (o = {}) => ({ ...S.blankRequest(), ...o });
const vars = obj => S.buildVarMap([], { vars: Object.entries(obj).map(([key, v]) => ({ key, ...(typeof v === 'object' ? v : { value: v }), enabled: true })) });

test('compose substitutes url, headers, body and auth', () => {
  const v = vars({ host: 'api.test', tok: { value: 'abc', secret: true }, id: '7' });
  const c = C.composeRequest(draft({
    method: 'POST', url: 'https://{{host}}/items/{{id}}', headers: [row('X-Id', '{{id}}')],
    body: '{"id":"{{id}}"}', auth: { type: 'bearer', token: '{{tok}}', prefix: 'Bearer' },
  }), { vars: v });
  assert.ok(c.ok); assert.deepEqual(c.missing, []); assert.equal(c.usedSecret, true);
  assert.equal(c.url, 'https://api.test/items/7');
  assert.equal(c.headers['X-Id'], '7');
  assert.equal(c.headers.Authorization, 'Bearer abc');
  assert.equal(c.body, '{"id":"7"}');
  assert.equal(c.headers['Content-Type'], 'application/json');
});
test('compose reports unresolved variables even when the url is invalid', () => {
  const c = C.composeRequest(draft({ url: '{{base}}/x' }), { vars: vars({}) });
  assert.equal(c.ok, false); assert.deepEqual(c.missing, ['base']);
});
test('compose: dynamic variables resolve and are not "missing"', () => {
  const c = C.composeRequest(draft({ url: 'https://x.test/?t={{$timestamp}}', headers: [row('X-R', '{{$uuid}}')] }), { vars: vars({}), dyn: { now: 5000, uuid: () => 'U' } });
  assert.ok(c.ok); assert.deepEqual(c.missing, []); assert.equal(c.url, 'https://x.test/?t=5'); assert.equal(c.headers['X-R'], 'U');
});
test('compose: basic auth is UTF-8 safe base64; apikey in query is appended and encoded', () => {
  const b = C.composeRequest(draft({ url: 'https://x.test', auth: { type: 'basic', username: 'josé', password: 'p:ß' } }));
  assert.equal(b.headers.Authorization, 'Basic ' + Buffer.from('josé:p:ß', 'utf8').toString('base64'));
  const q = C.composeRequest(draft({ url: 'https://x.test/a?x=1', auth: { type: 'apikey', in: 'query', name: 'api key', value: 'a&b' } }));
  assert.equal(q.url, 'https://x.test/a?x=1&api%20key=a%26b');
  const cu = C.composeRequest(draft({ url: 'https://x.test', auth: { type: 'custom', prefix: 'Token', credential: 'zz' } }));
  assert.equal(cu.headers.Authorization, 'Token zz');
});
test('compose: an explicit Authorization header wins over the Auth tab', () => {
  const c = C.composeRequest(draft({ url: 'https://x.test', headers: [row('authorization', 'Mine')], auth: { type: 'bearer', token: 't', prefix: 'Bearer' } }));
  assert.equal(c.headers.authorization, 'Mine'); assert.equal(c.headers.Authorization, undefined); assert.equal(c.auth.skipped, true);
});
test('compose: multipart yields formFields and no body; GET ignores body', () => {
  const m = C.composeRequest(draft({ method: 'POST', url: 'https://x.test', bodyType: 'multipart', body: 'a=1\nb=two' }));
  assert.deepEqual(m.formFields, [['a', '1'], ['b', 'two']]); assert.equal(m.body, undefined);
  const g = C.composeRequest(draft({ method: 'GET', url: 'https://x.test', body: '{bad' }));
  assert.ok(g.ok); assert.equal(g.body, undefined);
});
test('compose: invalid JSON body is reported', () => {
  const c = C.composeRequest(draft({ method: 'POST', url: 'https://x.test', body: '{bad' }));
  assert.equal(c.ok, false); assert.match(c.error, /Invalid JSON/);
});
test('snippetRequest feeds curl / fetch / python builders', () => {
  const c = C.composeRequest(draft({ method: 'POST', url: 'https://x.test/a', body: '{"a":1}', auth: { type: 'bearer', token: 't', prefix: 'Bearer' } }));
  const r = C.snippetRequest(c);
  const sh = buildCurl(r, { shell: 'posix' });
  assert.match(sh, /curl -X POST -L 'https:\/\/x\.test\/a'|curl -L 'https:\/\/x\.test\/a'/);
  assert.match(sh, /-H 'Authorization: Bearer t'/); assert.match(sh, /--data-raw '\{"a":1\}'/);
  assert.match(buildCurl(r, { shell: 'powershell' }), /^curl\.exe /);
  assert.match(buildCurl(r, { shell: 'cmd' }), /\^"/);
  assert.match(buildFetch(r), /fetch\("https:\/\/x\.test\/a"/);
  assert.match(buildPython(r), /requests\.post\(/);
  const manual = C.snippetRequest({ ...c, settings: { redirect: 'manual' } });
  assert.doesNotMatch(buildCurl(manual), / -L /); assert.match(buildFetch(manual), /redirect: "manual"/);
});
test('snippetRequest multipart', () => {
  const c = C.composeRequest(draft({ method: 'POST', url: 'https://x.test', bodyType: 'multipart', body: 'a=1' }));
  assert.match(buildCurl(C.snippetRequest(c)), /-F 'a=1'/);
  assert.match(buildFetch(C.snippetRequest(c)), /FormData/);
});
test('previewAuth states', () => {
  assert.equal(C.previewAuth(draft({ auth: { type: 'none' } })).state, 'none');
  const p = C.previewAuth(draft({ url: 'https://x', auth: { type: 'bearer', token: '{{t}}', prefix: 'Bearer' } }), { vars: vars({ t: 'sek' }) });
  assert.equal(p.state, 'header'); assert.equal(p.value, 'Bearer sek');
  assert.equal(C.previewAuth(draft({ url: 'https://x', auth: { type: 'bearer', token: '', prefix: 'Bearer' } })).state, 'incomplete');
  assert.equal(C.previewAuth(draft({ url: 'https://x', auth: { type: 'apikey', in: 'query', name: 'k', value: 'v' } })).state, 'query');
  assert.equal(C.previewAuth(draft({ url: 'https://x', headers: [row('Authorization', 'x')], auth: { type: 'bearer', token: 't', prefix: 'Bearer' } })).state, 'skipped');
  assert.deepEqual(C.previewAuth(draft({ auth: { type: 'bearer', token: '{{nope}}', prefix: 'Bearer' } })).missing, ['nope']);
});
test('maskDisplay hides the credential but keeps the scheme', () => {
  assert.match(C.maskDisplay('Bearer supersecrettoken'), /^Bearer •+$/);
  assert.ok(!C.maskDisplay('Bearer supersecrettoken').includes('secret'));
  assert.match(C.maskDisplay('abc'), /^•{6}$/);
});
test('draftFromCurl maps method, url params, headers, body, basic auth', () => {
  const p = parseCurl(`curl -u bob:pw -X PUT 'https://x.test/a?q=1&r=2' -H 'X-A: b' -d '{"k":1}'`);
  const { draft: d, warnings } = C.draftFromCurl(p);
  assert.equal(d.method, 'PUT'); assert.equal(d.url, 'https://x.test/a?q=1&r=2');
  assert.deepEqual(d.params.map(r => r.key), ['q', 'r']);
  assert.equal(d.headers.find(h => h.key === 'X-A').value, 'b');
  assert.deepEqual(d.auth, { type: 'basic', username: 'bob', password: 'pw' });
  assert.equal(d.bodyType, 'json'); assert.equal(d.body, '{"k":1}'); assert.ok(Array.isArray(warnings));
});
test('draftFromCurl multipart + unsupported method warns', () => {
  const p = parseCurl(`curl -F a=1 -F 'b=two' https://x.test/up`);
  const r = C.draftFromCurl(p);
  assert.equal(r.draft.bodyType, 'multipart'); assert.equal(r.draft.body, 'a=1\nb=two');
  const w = C.draftFromCurl({ method: 'TRACE', url: 'https://x.test', headers: [], body: '', bodyType: 'json', form: [], auth: null });
  assert.equal(w.draft.method, 'GET'); assert.ok(w.warnings.some(x => /TRACE/.test(x)));
});
test('draftFromHistory notes redacted values', () => {
  const e = L.makeHistoryEntry({ method: 'GET', url: 'https://x.test', headers: [row('Authorization', 'Bearer x')], auth: { type: 'bearer', token: 'tok', prefix: 'Bearer' }, body: '', bodyType: 'json', params: [] });
  const r = C.draftFromHistory(e);
  assert.equal(r.draft.headers[0].value, ''); assert.equal(r.draft.auth.token, ''); assert.ok(r.notes.length);
});
test('history entries never hold resolved secrets (template only)', () => {
  const e = L.makeHistoryEntry({ method: 'GET', url: 'https://{{host}}/a', headers: [row('Authorization', 'Bearer {{tok}}')], auth: { type: 'bearer', token: '{{tok}}', prefix: 'Bearer' }, body: '', bodyType: 'json', params: [] });
  assert.ok(JSON.stringify(e).includes('{{tok}}')); assert.equal(e.auth.token, '{{tok}}');
});
test('filterHistoryByStatus', () => {
  const l = [{ status: 200 }, { status: 404 }, { status: null }, { status: 503, pinned: true }];
  assert.equal(L.filterHistoryByStatus(l, '2xx').length, 1); assert.equal(L.filterHistoryByStatus(l, '4xx').length, 1);
  assert.equal(L.filterHistoryByStatus(l, 'failed').length, 1); assert.equal(L.filterHistoryByStatus(l, 'pinned').length, 1);
  assert.equal(L.filterHistoryByStatus(l, 'all').length, 4);
});
test('classifyImport detects kinds and rejects junk', () => {
  assert.equal(C.classifyImport('').ok, false);
  assert.match(C.classifyImport('{nope').error, /valid JSON/);
  assert.equal(C.classifyImport('[]').ok, false);
  assert.equal(C.classifyImport(JSON.stringify({ info: {}, item: [] })).kind, 'postman-collection');
  assert.equal(C.classifyImport(JSON.stringify({ values: [] })).kind, 'postman-env');
  assert.equal(C.classifyImport(JSON.stringify({ app: S.EXPORT_APP, kind: 'history' })).ok, false);
  assert.equal(C.classifyImport(JSON.stringify({ requests: [] })).ok, false);
  assert.equal(C.classifyImport(JSON.stringify({ hello: 1 })).ok, false);
});
test('runImport: collection round trip through Developer Toolbox export', () => {
  const tree = []; const col = S.addContainer(tree, null, 'Col');
  S.addRequest(tree, col.id, 'R', { method: 'POST', url: 'https://x.test', body: '{}' });
  const text = JSON.stringify(S.exportCollection(tree, col.id));
  const r = C.runImport(text);
  assert.ok(r.ok); assert.equal(r.kind, 'dt-collection'); assert.equal(r.collections[0].name, 'Col'); assert.notEqual(r.collections[0].id, col.id);
});
test('runImport: postman collection with variables creates an env and reports skipped scripts', () => {
  const pm = { info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, variable: [{ key: 'a', value: '1' }],
    event: [{ listen: 'prerequest', script: { exec: ['x'] } }], item: [{ name: 'r', request: { method: 'GET', url: 'https://x.test' } }] };
  const r = C.runImport(JSON.stringify(pm));
  assert.ok(r.ok); assert.equal(r.envs.length, 1); assert.equal(r.envs[0].vars[0].key, 'a');
  assert.ok(r.warnings.some(w => /script/.test(w)));
});
test('runImport: postman environment and globals', () => {
  const e = C.runImport(JSON.stringify({ name: 'Dev', values: [{ key: 'k', value: 'v', type: 'secret', enabled: true }] }));
  assert.equal(e.envs[0].name, 'Dev'); assert.equal(e.envs[0].vars[0].secret, true); assert.ok(e.envs[0].id);
  const g = C.runImport(JSON.stringify({ name: 'G', _postman_variable_scope: 'globals', values: [{ key: 'k', value: 'v' }] }));
  assert.equal(g.globals.length, 1); assert.equal(g.envs.length, 0);
});
test('runImport: DT environments export', () => {
  const st = S.normalizeEnvs({ globals: [{ key: 'g', value: '1' }], envs: [{ name: 'E', vars: [{ key: 's', value: 'x', secret: true }] }] });
  const r = C.runImport(JSON.stringify(S.exportEnvs(st)));
  assert.equal(r.envs[0].vars[0].value, ''); assert.equal(r.globals[0].key, 'g'); assert.ok(r.warnings.some(w => /Secret/.test(w)));
});
test('mergeEnvs de-duplicates names and keeps existing globals', () => {
  const st = S.normalizeEnvs({ globals: [{ key: 'g', value: '1' }], envs: [{ name: 'Dev', vars: [] }] });
  const m = C.mergeEnvs(st, { envs: [{ name: 'Dev', vars: [] }], globals: [{ key: 'g', value: '2' }, { key: 'h', value: '3' }] });
  assert.deepEqual(m.state.envs.map(e => e.name), ['Dev', 'Dev (2)']);
  assert.equal(m.state.globals.find(g => g.key === 'g').value, '1'); assert.equal(m.skippedGlobals, 1); assert.equal(m.state.globals.length, 2);
});
test('stripSecrets removes auth, sensitive headers, query tokens and JSON secrets but keeps {{vars}}', () => {
  const tree = []; const col = S.addContainer(tree, null, 'C');
  S.addRequest(tree, col.id, 'R', {
    method: 'POST', url: 'https://x.test/a?token=abc&q=1', params: [row('token', 'abc'), row('q', '1')],
    headers: [row('Authorization', 'Bearer real'), row('X-Api-Key', '{{key}}'), row('Accept', 'x')],
    auth: { type: 'bearer', token: 'real', prefix: 'Bearer' }, body: '{"password":"hunter2","n":1}',
  });
  const s = C.stripSecrets(tree[0]); const r = s.items[0].request;
  const dump = JSON.stringify(s);
  assert.ok(!dump.includes('real') && !dump.includes('abc') && !dump.includes('hunter2'));
  assert.equal(r.headers[1].value, '{{key}}'); assert.equal(r.headers[2].value, 'x');
  assert.equal(r.params[1].value, '1'); assert.match(r.url, /q=1/);
  assert.ok(C.countSecrets(tree[0]) >= 2);
  assert.ok(JSON.stringify(tree).includes('real')); // original untouched
});
test('fileSlug', () => { assert.equal(C.fileSlug('My API / v2!'), 'my-api-v2'); assert.equal(C.fileSlug(''), 'export'); });

console.log(`api-client-compose: ${pass} passed`);
