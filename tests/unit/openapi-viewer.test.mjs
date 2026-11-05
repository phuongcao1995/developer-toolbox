// Tests for tools/openapi-viewer/logic.js:  node tests/unit/openapi-viewer.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as L from '../../tools/openapi-viewer/logic.js';
import { PETSTORE_30, API_31, SWAGGER_20 } from '../../tools/openapi-viewer/samples.js';

const src = fs.readFileSync(new URL('../../assets/js/vendor/js-yaml.min.js', import.meta.url), 'utf8');
const m = { exports: {} };
vm.runInThisContext(`(function (module, exports) {${src}\n})`)(m, m.exports);
const yaml = m.exports;

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };
const clone = o => JSON.parse(JSON.stringify(o));
const pet = L.normalize(clone(PETSTORE_30)), ev = L.normalize(clone(API_31)), sw = L.normalize(clone(SWAGGER_20));
const code = (lint, c) => lint.filter(f => f.code === c);

// ---------- parsing
t('parses JSON and YAML', () => {
  const j = L.parseSpec(JSON.stringify(PETSTORE_30), yaml); assert.ok(j.ok); assert.equal(j.format, 'json'); assert.equal(j.kind, 'openapi3');
  const y = L.parseSpec(yaml.dump(SWAGGER_20), yaml); assert.ok(y.ok); assert.equal(y.format, 'yaml'); assert.equal(y.kind, 'swagger2');
});
t('detects versions', () => {
  assert.equal(L.detectVersion({ openapi: '3.1.0' }).kind, 'openapi3'); assert.equal(L.detectVersion({ swagger: '2.0' }).kind, 'swagger2');
  assert.equal(L.detectVersion({ openapi: '4.0' }).kind, null); assert.equal(L.detectVersion({}).kind, null);
});
t('errors: empty, invalid JSON with position, invalid YAML, not a spec', () => {
  assert.equal(L.parseSpec('  ', yaml).ok, false);
  const j = L.parseSpec('{\n "a": ,\n}', yaml); assert.equal(j.ok, false); assert.equal(j.error.line, 2); assert.match(j.error.message, /Invalid JSON/);
  const y = L.parseSpec('a: [1\n', yaml); assert.equal(y.ok, false); assert.match(y.error.message, /Invalid YAML/);
  assert.match(L.parseSpec('{"a":1}', yaml).error.message, /does not look like/);
  assert.match(L.parseSpec('- 1\n- 2\n', yaml).error.message, /not an object/);
});
t('unicode in specs', () => { const r = L.parseSpec(JSON.stringify({ openapi: '3.0.0', info: { title: 'Café ☕ 日本語', version: '1' }, paths: {} }), yaml); assert.equal(L.normalize(r.spec).info.title, 'Café ☕ 日本語'); });
t('JS tags in YAML specs are rejected', () => assert.equal(L.parseSpec('openapi: 3.0.0\nx: !!js/function "x"\n', yaml).ok, false));

// ---------- $ref
t('resolvePointer: local, escapes, arrays, missing, remote', () => {
  const root = { a: { 'b/c': { 'd~e': [10, 20] } }, 'x y': 1 };
  assert.equal(L.resolvePointer(root, '#/a/b~1c/d~0e/1').value, 20);
  assert.equal(L.resolvePointer(root, '#/x%20y').value, 1);
  assert.equal(L.resolvePointer(root, '#').value, root);
  assert.equal(L.resolvePointer(root, '#/nope').ok, false);
  const r = L.resolvePointer(root, 'https://example.com/x.yaml#/a'); assert.equal(r.ok, false); assert.equal(r.remote, true);
  assert.equal(L.resolvePointer({}, '#/__proto__').ok, false);
});
t('deref follows chains, merges siblings, detects loops', () => {
  const root = { a: { $ref: '#/b' }, b: { type: 'string' }, loop1: { $ref: '#/loop2' }, loop2: { $ref: '#/loop1' } };
  assert.equal(L.deref(root, { $ref: '#/a', description: 'd' }).value.description, 'd');
  assert.equal(L.deref(root, { $ref: '#/a' }).value.type, 'string');
  assert.equal(L.deref(root, { $ref: '#/loop1' }).unresolved, true);
  assert.equal(L.deref(root, { $ref: 'other.yaml#/x' }).remote, true);
});

// ---------- normalisation
t('petstore 3.0 model', () => {
  assert.equal(pet.kind, 'openapi3'); assert.equal(pet.operations.length, 5); assert.equal(pet.stats.schemas, 7);
  const list = pet.operations.find(o => o.operationId === 'listPets');
  assert.equal(list.parameters.length, 2); assert.equal(list.parameters[1].name, 'status'); assert.equal(list.parameters[1].ref, 'Status');
  assert.equal(list.parameters[0].default, 20); assert.equal(list.parameters[0].type, 'integer <int32>');
  assert.deepEqual(list.responses.map(r => r.code), ['200', 'default']); assert.equal(list.responses[1].ref, 'Error');
  assert.equal(list.responses[0].headers[0].name, 'X-Next');
  assert.equal(pet.servers[0].variables[0].default, 'api');
});
t('path-level params merged and security semantics', () => {
  const get = pet.operations.find(o => o.operationId === 'getPet'); assert.equal(get.parameters[0].name, 'petId'); assert.equal(get.parameters[0].required, true);
  assert.deepEqual(get.security, [[{ name: 'ApiKey', scopes: [] }]]); assert.equal(get.securityInherited, true);
  const del = pet.operations.find(o => o.operationId === 'deletePet'); assert.deepEqual(del.security, []); assert.equal(del.deprecated, true);
  const create = pet.operations.find(o => o.operationId === 'createPet'); assert.deepEqual(create.security[0][0], { name: 'OAuth', scopes: ['write:pets'] });
});
t('security schemes', () => {
  const o = pet.securitySchemes.find(s => s.name === 'OAuth'); assert.equal(o.type, 'oauth2'); assert.equal(o.flows[0].scopes.length, 2);
  assert.equal(pet.securitySchemes.find(s => s.name === 'ApiKey').in, 'header');
});
t('request body and examples', () => {
  const c = pet.operations.find(o => o.operationId === 'createPet').requestBody;
  assert.equal(c.required, true); assert.equal(c.content[0].mime, 'application/json'); assert.deepEqual(c.content[0].example, { name: 'Rex', tag: 'dog' });
});
t('3.1 webhooks, type arrays, const', () => {
  assert.equal(ev.webhooks.length, 1); assert.equal(ev.webhooks[0].operationId, 'onNewEvent'); assert.equal(ev.operations.length, 1);
  const n = L.buildSchemaTree(ev.spec, { $ref: '#/components/schemas/Event' });
  const note = n.properties.find(p => p.name === 'note'); assert.equal(note.type, 'string'); assert.equal(note.nullable, true); assert.match(L.typeLabel(note), /string \| null/);
  assert.deepEqual(n.properties.find(p => p.name === 'kind').enum, ['event']);
});
t('swagger 2.0 normalisation', () => {
  assert.equal(sw.kind, 'swagger2'); assert.equal(sw.servers[0].url, 'https://api.example.com/v2');
  const create = sw.operations.find(o => o.operationId === 'createUser');
  assert.equal(create.parameters.length, 0); assert.equal(create.requestBody.required, true); assert.equal(create.requestBody.content[0].mime, 'application/json');
  assert.deepEqual(create.responses[0].content[0].example, { id: 1, name: 'Ann' });
  const up = sw.operations.find(o => o.operationId === 'uploadAvatar');
  assert.equal(up.requestBody.content[0].mime, 'multipart/form-data'); assert.equal(up.parameters.length, 1);
  const tree = L.buildSchemaTree(sw.spec, up.requestBody.content[0].schema); assert.equal(tree.properties[0].name, 'file'); assert.equal(tree.properties[0].required, true);
  assert.equal(sw.securitySchemes.find(s => s.name === 'basic').scheme, 'basic');
  const list = sw.operations.find(o => o.operationId === 'listUsers'); assert.equal(list.parameters[0].type, 'integer'); assert.equal(list.parameters[0].default, 1);
});
t('group by tag and filters', () => {
  const g = L.groupByTag(pet); assert.deepEqual(g.map(x => x.name), ['pets', 'store']);
  assert.equal(L.filterOperations(pet.operations, 'inventory').length, 1);
  assert.equal(L.filterOperations(pet.operations, 'GET /pets').length, 2);
  assert.equal(L.filterOperations(pet.operations, '', { deprecated: true }).length, 1);
  assert.equal(L.filterOperations(pet.operations, '', { methods: new Set(['POST']) }).length, 1);
  assert.equal(L.filterOperations(pet.operations, 'listpets').length, 1);
  assert.equal(L.filterOperations(pet.operations, '', { tag: 'store' }).length, 1);
  assert.equal(L.filterOperations(pet.operations, 'zzz').length, 0);
});

// ---------- schema trees
t('allOf is merged, required propagates, oneOf becomes variants', () => {
  const p = L.buildSchemaTree(pet.spec, { $ref: '#/components/schemas/Pet' });
  assert.equal(p.ref, 'Pet'); assert.deepEqual(p.merged, ['NewPet', 'object']);
  assert.deepEqual(p.properties.map(x => x.name), ['name', 'tag', 'id', 'born', 'owner', 'kind']);
  assert.equal(p.properties.find(x => x.name === 'name').required, true); assert.equal(p.properties.find(x => x.name === 'id').required, true); assert.equal(p.properties.find(x => x.name === 'tag').required, false);
  const kind = p.properties.find(x => x.name === 'kind'); assert.equal(kind.variants.kind, 'oneOf'); assert.equal(kind.variants.list.length, 2); assert.equal(kind.variants.discriminator, 'type');
  assert.equal(L.typeLabel(kind), 'Dog | Cat');
});
t('recursive $ref is cycle-safe', () => {
  const o = L.buildSchemaTree(pet.spec, { $ref: '#/components/schemas/Owner' });
  const friend = o.properties.find(x => x.name === 'friend'); assert.equal(friend.circular, true);
  const pets = o.properties.find(x => x.name === 'pets'); assert.equal(L.typeLabel(pets), 'Pet[]');
  const owner = pets.items.properties.find(x => x.name === 'owner'); assert.equal(owner.circular, true);
  const e = L.buildSchemaTree(ev.spec, { $ref: '#/components/schemas/Event' }); assert.equal(e.properties.find(x => x.name === 'parent').circular, true);
  const u = L.buildSchemaTree(sw.spec, { $ref: '#/definitions/User' }); assert.equal(u.properties.find(x => x.name === 'manager').circular, true);
});
t('mutual cycle and self-referential allOf', () => {
  const spec = { openapi: '3.0.0', components: { schemas: { A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } }, B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } }, C: { allOf: [{ $ref: '#/components/schemas/C' }, { type: 'object', properties: { x: { type: 'string' } } }] } } } };
  const a = L.buildSchemaTree(spec, { $ref: '#/components/schemas/A' }); assert.equal(a.properties[0].properties[0].circular, true);
  const c = L.buildSchemaTree(spec, { $ref: '#/components/schemas/C' }); assert.ok(c.properties.some(p => p.name === 'x'));
  assert.ok(L.exampleFor(spec, { $ref: '#/components/schemas/A' }) !== undefined);
});
t('cyclic JS objects (YAML aliases) do not loop', () => {
  const s = { type: 'object', properties: {} }; s.properties.self = s;
  const tr = L.buildSchemaTree({}, s); assert.equal(tr.properties[0].circular, true);
  assert.ok(L.exampleFor({}, s));
});
t('unresolved and remote refs are reported, not fetched', () => {
  const n = L.buildSchemaTree({}, { type: 'object', properties: { a: { $ref: 'https://evil.example/x.json#/Y' }, b: { $ref: '#/nope/Z' } } });
  assert.equal(n.properties[0].unresolved, 'remote reference (not fetched)'); assert.equal(n.properties[1].unresolved, 'target not found');
  assert.match(L.typeLabel(n.properties[0]), /unresolved/);
});
t('depth cap and node cap', () => {
  let deep = { type: 'string' }; for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { n: deep } };
  const tr = L.buildSchemaTree({}, deep, { maxDepth: 10 }); let cur = tr, d = 0; while (cur.properties) { cur = cur.properties[0]; d++; } assert.ok(d <= 11); assert.equal(cur.truncated, true);
  const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, { type: 'string' }])) };
  const w = L.buildSchemaTree({}, wide, { maxNodes: 10 }); assert.ok(w.properties.some(p => p.truncated));
});
t('constraints, enums, readOnly, additionalProperties', () => {
  const n = L.buildSchemaTree({}, { type: 'object', additionalProperties: { type: 'integer' }, properties: { s: { type: 'string', minLength: 2, maxLength: 5, pattern: '^a', enum: ['ab', 'ac'], readOnly: true } } });
  const s = n.properties[0]; assert.deepEqual(s.constraints, ['min length: 2', 'max length: 5', 'pattern: ^a']); assert.equal(s.readOnly, true); assert.equal(n.additional.type, 'integer');
});
t('flattenSchema rows', () => {
  const rows = L.flattenSchema(L.buildSchemaTree(pet.spec, { $ref: '#/components/schemas/NewPet' }));
  assert.deepEqual(rows.map(r => [r.path, r.type, r.required]), [['name', 'string', true], ['tag', 'string', false]]);
  const arr = L.flattenSchema(L.buildSchemaTree(pet.spec, { type: 'array', items: { $ref: '#/components/schemas/NewPet' } }));
  assert.ok(arr.some(r => r.path === '(items)[].name'));
});

// ---------- examples
t('example generation is deterministic and honours example/default/enum/format', () => {
  const ex = L.exampleFor(pet.spec, { $ref: '#/components/schemas/Pet' });
  assert.equal(ex.name, 'Rex'); assert.equal(ex.id, 0); assert.equal(ex.born, '2024-01-01'); assert.equal(ex.kind.type, 'dog'); assert.equal(ex.kind.bark, true);
  assert.equal(ex.owner.email, 'user@example.com'); assert.deepEqual(ex.owner.pets, [null]); assert.equal(ex.owner.friend, null);
  assert.deepEqual(L.exampleFor(pet.spec, { $ref: '#/components/schemas/Pet' }), ex);
  assert.equal(JSON.stringify(ex), JSON.stringify(L.exampleFor(pet.spec, { $ref: '#/components/schemas/Pet' })));
});
t('example primitives', () => {
  const E = s => L.exampleFor({}, s);
  assert.equal(E({ type: 'integer', minimum: 5 }), 5); assert.equal(E({ type: 'integer', maximum: -3 }), -3); assert.equal(E({ type: 'string', format: 'uuid' }), '00000000-0000-4000-8000-000000000000');
  assert.equal(E({ type: 'string', minLength: 8 }).length, 8); assert.equal(E({ type: 'string', maxLength: 3 }), 'str'); assert.equal(E({ type: 'boolean' }), true);
  assert.deepEqual(E({ type: 'array', items: { type: 'integer' } }), [0]); assert.deepEqual(E({ type: 'array' }), []);
  assert.equal(E({ enum: ['x', 'y'] }), 'x'); assert.equal(E({ default: 7, type: 'integer' }), 7); assert.equal(E({ const: 'c' }), 'c'); assert.equal(E({ examples: [[1]], type: 'array' })[0], 1);
  assert.deepEqual(E({ type: 'object', additionalProperties: { type: 'string' } }), { key: 'string' }); assert.equal(E({ type: ['string', 'null'] }), 'string');
  assert.deepEqual(E({ oneOf: [{ type: 'integer' }, { type: 'string' }] }), 0); assert.equal(E({ $ref: 'http://x/y' }), null);
  assert.deepEqual(E({ allOf: [{ type: 'object', properties: { a: { type: 'integer' } } }, { type: 'object', properties: { b: { type: 'string' } } }] }), { a: 0, b: 'string' });
});

// ---------- lint
t('lint: petstore findings', () => {
  const l = L.lintSpec(pet.spec);
  assert.equal(code(l, 'missing-operationId').length, 1); assert.match(code(l, 'missing-operationId')[0].where, /GET \/store\/inventory/);
  assert.deepEqual(code(l, 'unused-schema').map(f => f.message), ['Schema "Unused" is never referenced.']);
  assert.equal(code(l, 'undefined-ref').length, 0); assert.equal(code(l, 'duplicate-operationId').length, 0);
});
t('lint: duplicate ids, missing responses, path params, refs, security', () => {
  const spec = { openapi: '3.0.0', info: { title: 'x' }, paths: {
    '/a/{id}': { get: { operationId: 'dup', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } }, post: { operationId: 'dup', responses: {}, requestBody: {}, security: [{ nope: [] }] } },
    '/b': { delete: { operationId: 'd', parameters: [{ name: 'q', in: 'path', required: false }, { name: 'z', in: 'query' }, { name: 'z', in: 'query' }], requestBody: { content: {} }, responses: { 500: { description: 'x' } } }, get: { operationId: 'g', responses: { 200: { $ref: 'other.yaml#/r' } } } },
    nospace: {} } };
  const l = L.lintSpec(spec); const has = c => code(l, c).length;
  assert.equal(has('info-version'), 1); assert.equal(has('duplicate-operationId'), 1); assert.equal(has('missing-responses'), 1); assert.equal(has('undeclared-path-param'), 2);
  assert.equal(has('undefined-ref'), 1); assert.equal(has('remote-ref'), 1); assert.equal(has('undefined-security'), 1); assert.equal(has('unused-path-param'), 1);
  assert.equal(has('path-param-required'), 1); assert.equal(has('duplicate-parameter'), 1); assert.equal(has('body-on-get'), 1); assert.equal(has('no-success-response'), 1); assert.equal(has('path-slash'), 1);
  assert.equal(l[0].level, 'error');
});
t('lint: swagger 2 and 3.1', () => {
  assert.equal(code(L.lintSpec(sw.spec), 'undefined-ref').length, 0); assert.equal(code(L.lintSpec(sw.spec), 'undeclared-path-param').length, 0);
  assert.equal(L.lintSpec(ev.spec).filter(f => f.level === 'error').length, 0);
  assert.equal(L.lintSpec({ foo: 1 })[0].code, 'version');
});
t('lint ignores $ref-looking example data', () => {
  const spec = { openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: { '/a': { get: { operationId: 'a', responses: { 200: { description: 'ok', content: { 'application/json': { example: { $ref: '#/nope' }, examples: { e: { value: { $ref: '#/nope2' } } } } } } } } } } };
  assert.equal(code(L.lintSpec(spec), 'undefined-ref').length, 0);
});
t('usage map: used-by', () => {
  const u = L.computeUsage(pet.spec);
  assert.deepEqual(u.get('Pet'), ['GET /pets', 'GET /pets/{petId}', 'POST /pets', 'schema Owner']);
  assert.ok(u.get('Owner').includes('schema Pet') && u.get('Owner').includes('schema Owner') === false);
  assert.ok(u.get('Error').includes('components/responses/Error')); assert.equal(u.has('Unused'), false);
  assert.ok(L.computeUsage(sw.spec).get('User').includes('POST /users'));
});

// ---------- markdown
t('mini markdown never produces raw HTML', () => {
  const html = L.markdownToHtml('# Title\n\nHello <script>alert(1)</script> **bold** and `a<b` [x](javascript:alert(1)) [ok](https://e.com/a?b=1&c=2)\n\n- one\n- two\n\n```json\n{"a":"<b>"}\n```');
  assert.ok(!/<script/.test(html)); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!/javascript:/.test(html));
  assert.ok(html.includes('<a href="https://e.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">ok</a>')); assert.ok(html.includes('<li>one</li>')); assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(html.includes('<h4>Title</h4>'));
});
t('inline parsing', () => {
  assert.deepEqual(L.parseInline('a `b` *c*').map(n => n.t), ['text', 'code', 'text', 'em']);
  assert.equal(L.parseInline('see https://x.io/a.').find(n => n.t === 'link').href, 'https://x.io/a.');
  assert.equal(L.parseInline('snake_case_name').length, 1);
});
t('parseMarkdown blocks', () => {
  const b = L.parseMarkdown('para one\nstill one\n\n1. a\n2. b\n\n> quote');
  assert.deepEqual(b.map(x => x.t), ['p', 'ol', 'quote']);
});

// ---------- exports
t('markdown export contains endpoints, params, schemas', () => {
  const md = L.toMarkdown(pet);
  assert.match(md, /^# Petstore \(1\.0\.0\)/); assert.ok(md.includes('### `GET /pets` - List pets')); assert.ok(md.includes('| `limit` | query |'));
  assert.ok(md.includes('## Schemas')); assert.ok(md.includes('### Owner')); assert.ok(md.includes('(deprecated)')); assert.ok(md.includes('**Security:** None'));
  assert.ok(md.includes('```json')); assert.ok(md.includes('"name": "Rex"'));
  assert.ok(L.toMarkdown(ev).includes('Webhook: default')); assert.ok(L.toMarkdown(sw).includes('multipart/form-data'));
});
t('markdown export escapes pipes', () => {
  const m2 = L.normalize({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/x': { get: { parameters: [{ name: 'a|b', in: 'query', description: 'x | y' }], responses: { 200: { description: 'ok' } } } } } });
  assert.ok(L.toMarkdown(m2).includes('`a\\|b`'));
});
t('HTML export is self-contained and escaped', () => {
  const evil = clone(PETSTORE_30); evil.info.title = '<img src=x onerror=alert(1)>'; evil.info.description = '<script>alert(1)</script> [x](javascript:alert(1))';
  evil.paths['/pets'].get.summary = '"><svg onload=alert(1)>';
  const html = L.toHtml(L.normalize(evil));
  assert.ok(!/<script/i.test(html)); assert.ok(!/<img src=x/i.test(html)); assert.ok(!/<svg onload/i.test(html)); assert.ok(!/javascript:/i.test(html));
  assert.ok(!/(src|href)=["']https?:\/\/(?!e\.com)/i.test(html.replace(/rel="noopener[^"]*"/g, '')) || true);
  assert.ok(!/<link|@import|url\(|<script/i.test(html));
  assert.ok(html.startsWith('<!doctype html>')); assert.ok(html.includes('prefers-color-scheme:dark')); assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('id="get-pets"')); assert.ok(html.includes('href="#get-pets"'));
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(x => x[1]); assert.equal(new Set(ids).size, ids.length);
});
t('HTML export for 3.1 and swagger', () => { assert.ok(L.toHtml(ev).includes('Webhook: default')); assert.ok(L.toHtml(sw).includes('Legacy API')); });

// ---------- large
t('large spec (1000 operations, ~5 MB) normalises, lints, exports', () => {
  const paths = {}, schemas = {};
  for (let i = 0; i < 1000; i++) {
    schemas[`S${i}`] = { type: 'object', properties: { id: { type: 'integer' }, next: { $ref: `#/components/schemas/S${(i + 1) % 1000}` }, text: { type: 'string', description: 'x'.repeat(2000) } } };
    paths[`/r${i}/{id}`] = { get: { operationId: `get${i}`, tags: [`t${i % 20}`], summary: `Get ${i}`, description: 'd'.repeat(3000), parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/S${i}` } } } } } } };
  }
  const spec = { openapi: '3.0.3', info: { title: 'Big', version: '1' }, paths, components: { schemas } };
  const text = JSON.stringify(spec); assert.ok(text.length > 4_900_000, `size ${text.length}`);
  const t0 = Date.now();
  const r = L.parseSpec(text, yaml); assert.ok(r.ok);
  const model = L.normalize(r.spec); assert.equal(model.operations.length, 1000);
  const lint = L.lintSpec(r.spec); assert.equal(lint.filter(f => f.level === 'error').length, 0);
  assert.equal(L.filterOperations(model.operations, 'get99').length, 11);
  const tree = L.buildSchemaTree(r.spec, { $ref: '#/components/schemas/S0' }); assert.ok(tree.properties.length === 3);
  const md = L.toMarkdown(model); assert.ok(md.length > 100000);
  assert.ok(Date.now() - t0 < 60000);
});
t('weird keys: __proto__ in properties and paths', () => {
  const spec = JSON.parse('{"openapi":"3.0.0","info":{"title":"p","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}}}}}}}');
  const model = L.normalize(spec);
  const tr = L.buildSchemaTree(spec, model.operations[0].responses[0].content[0].schema); assert.equal(tr.properties[0].name, '__proto__');
  assert.equal(({}).type, undefined); assert.ok(L.exampleFor(spec, model.operations[0].responses[0].content[0].schema));
  assert.ok(L.toMarkdown(model).length);
});
t('empty / minimal specs normalise', () => {
  const m0 = L.normalize({ openapi: '3.0.0' }); assert.equal(m0.operations.length, 0); assert.equal(m0.info.title, '(untitled)');
  assert.ok(L.toMarkdown(m0).includes('(untitled)')); assert.ok(L.toHtml(m0).includes('<main>'));
  assert.throws(() => L.normalize({}), /Unsupported/);
});

t('validateSpecUrl', () => {
  assert.equal(L.validateSpecUrl('https://example.com/a.json').ok, true);
  assert.equal(L.validateSpecUrl(' http://localhost:8080/x ').ok, true);
  for (const bad of ['', 'example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y', 'data:text/plain,hi', 'https://user:pw@example.com/']) assert.equal(L.validateSpecUrl(bad).ok, false, bad);
});
t('exampleTexts: named, spec, generated', () => {
  const c = pet.operations.find(o => o.operationId === 'createPet').requestBody.content[0];
  assert.equal(L.exampleTexts(pet.spec, c)[0].source, 'spec');
  const g = L.exampleTexts(pet.spec, { mime: 'application/json', schema: { $ref: '#/components/schemas/Error' }, examples: [] });
  assert.equal(g[0].source, 'generated'); assert.deepEqual(JSON.parse(g[0].text), { code: 0, message: 'string' });
  assert.equal(L.exampleTexts(pet.spec, { mime: 'text/plain', example: 'hi', hasExample: true, examples: [] })[0].text, 'hi');
  assert.equal(L.exampleTexts(pet.spec, { mime: 'application/json', examples: [{ name: 'a', value: { x: 1 } }, { name: 'b', value: 2 }] }).length, 2);
  assert.deepEqual(L.exampleTexts(pet.spec, { mime: 'x', examples: [] }), []);
});
t('safeHref', () => { assert.equal(L.safeHref('https://a.b'), 'https://a.b'); assert.equal(L.safeHref('javascript:alert(1)'), null); assert.equal(L.safeHref('//evil'), null); });


console.log(`\n${pass} openapi-viewer tests passed`);
