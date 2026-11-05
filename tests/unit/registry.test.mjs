// Run: node tests/unit/registry.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { TOOLS, validateRegistry, searchToolsDetailed, searchTools, editDistance } from '../../assets/js/registry.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const top = q => searchTools(q)[0]?.id;

test('registry is valid', () => assert.deepEqual(validateRegistry(), []));
test('every tool has its files', () => {
  for (const t of TOOLS.filter(x => !x.standalone)) for (const f of ['index.html', 'tool.js', 'tool.css']) assert.ok(existsSync(`tools/${t.id}/${f}`), `${t.id}/${f}`);
});
test('standalone tools link to an existing page and have no entry', () => {
  const s = TOOLS.filter(x => x.standalone);
  assert.ok(s.length >= 2);
  for (const t of s) { assert.ok(existsSync(t.href), t.href); assert.equal(t.entry, undefined); }
});
test('standalone pages reference only local, existing scripts and styles', () => {
  for (const t of TOOLS.filter(x => x.standalone)) {
    const html = readFileSync(t.href, 'utf8');
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      if (/^(data:|#)/.test(m[1])) continue;
      assert.ok(!/^https?:/.test(m[1]), `${t.id} loads external resource ${m[1]}`);
      assert.ok(existsSync(join(dirname(t.href), m[1])), `${t.id}: missing ${m[1]}`);
    }
  }
});
test('validator catches problems', () => {
  const bad = [{ id: 'a', name: 'A', description: 'd', category: 'nope', icon: 'x', entry: 'e', keywords: [], updated: 'x' }, { id: 'a', name: 'A' }];
  const p = validateRegistry(bad);
  assert.ok(p.length >= 4); assert.ok(p.some(s => s.includes('Duplicate')));
});
test('name search ranks name first', () => assert.equal(top('json'), 'json-formatter'));
test('keyword search', () => assert.equal(top('cron'), 'cron-generator'));
test('description search', () => assert.ok(searchTools('percent').some(t => t.id === 'url-encoder')));
test('category search', () => assert.ok(searchTools('database').length >= 3));
test('multi-word AND', () => {
  assert.equal(searchTools('http status')[0].id, 'http-status-reference');
  assert.deepEqual(searchTools('json zzzzqq'), []);
});
test('subsequence fuzzy', () => assert.equal(top('jsnfmt'), 'json-formatter'));
test('typo tolerance', () => {
  assert.equal(top('regx'), 'regex-tester');
  assert.ok(searchTools('formater').some(t => t.id === 'json-formatter'));
  assert.equal(top('timestmp'), 'timestamp-converter');
});
test('diacritics ignored', () => assert.equal(top('JSÓN'), 'json-formatter'));
test('no match', () => assert.deepEqual(searchTools('qqqqxxxx'), []));
test('empty query returns all', () => assert.equal(searchTools('').length, TOOLS.length));
test('category filter', () => assert.ok(searchTools('', 'utility').every(t => t.category === 'utility')));
test('highlight ranges point into the name', () => {
  const r = searchToolsDetailed('form').find(x => x.tool.id === 'json-formatter');
  assert.deepEqual(r.ranges, [[5, 9]]);
  assert.equal(r.tool.name.slice(...r.ranges[0]).toLowerCase(), 'form');
  const f = searchToolsDetailed('jsnfmt')[0];
  assert.ok(f.ranges.length >= 2);
  assert.ok(f.ranges.every(([a, b]) => a < b && b <= f.tool.name.length));
});
test('edit distance', () => {
  assert.equal(editDistance('abc', 'abd'), 1);
  assert.equal(editDistance('ab', 'ba'), 1);
  assert.ok(editDistance('abc', 'xyzxyz') > 2);
});
console.log(`${pass} passed`);
