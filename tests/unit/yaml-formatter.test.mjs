// Tests for tools/yaml-formatter/logic.js using the vendored js-yaml:  node tests/unit/yaml-formatter.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as L from '../../tools/yaml-formatter/logic.js';

const src = fs.readFileSync(new URL('../../assets/js/vendor/js-yaml.min.js', import.meta.url), 'utf8');
assert.match(src.slice(0, 80), /js-yaml 4\.1/);
const m = { exports: {} };
vm.runInThisContext(`(function (module, exports) {${src}
})`)(m, m.exports);
L.setYaml(m.exports);

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };
const bad = (text, re, line, opts) => {
  const r = L.parseAll(text, opts);
  assert.equal(r.ok, false, text);
  assert.match(r.error.message + ' ' + r.error.hint, re);
  if (line) assert.equal(r.error.line, line);
  return r.error;
};

t('parses normal documents', () => { const r = L.parseAll('a: 1\nb: [x, y]\n'); assert.deepEqual(r.docs, [{ a: 1, b: ['x', 'y'] }]); });
t('empty input is an error', () => { bad('', /empty/i); bad('  \n', /empty/i); });
t('multi-document', () => { const r = L.parseAll('---\na: 1\n---\nb: 2\n'); assert.equal(r.count, 2); });
t('unicode round trip', () => {
  const r = L.formatYaml('名前: Zoë\nemoji: "😀"\n');
  assert.ok(r.ok); assert.ok(r.text.includes('名前: Zoë')); assert.ok(r.sameData);
});
t('BOM is ignored', () => assert.ok(L.parseAll('\uFEFFa: 1').ok));

// errors + friendly hints
t('tab indentation', () => bad('a:\n\tb: 1\n', /tab/i, 2));
t('duplicate key', () => { const e = bad('a: 1\nb: 2\na: 3\n', /duplicate/i, 3); assert.match(e.hint, /appears twice/); });
t('allowDuplicates keeps last', () => assert.deepEqual(L.parseAll('a: 1\na: 2\n', { allowDuplicates: true }).docs, [{ a: 2 }]));
t('bad indentation', () => bad('a:\n  b: 1\n c: 2\n', /indentation/i, 3));
t('colon in plain scalar', () => bad('a: b: c\n', /quote/i, 1));
t('undefined alias', () => bad('a: *x\n', /anchor/i, 1));
t('js tags refused (safe schema)', () => {
  bad('a: !!js/function "function(){}"\n', /not supported/i);
  bad('a: !!js/regexp /x/\n', /not supported/i);
});
t('unterminated flow and quotes', () => { bad('a: [1, 2\n', /flow|list/i); bad('a: "x\n', /quote/i); });
t('mixed list and mapping', () => bad('- a\nb: 1\n', /does not fit|mixing/i, 2));
t('error offset points into the text', () => {
  const text = 'ok: 1\nbad: [1\n'; const e = bad(text, /.*/); assert.ok(e.offset <= text.length && e.offset >= 0);
});
t('deep nesting does not crash', () => {
  const r = L.parseAll('['.repeat(20000)); assert.equal(r.ok, false);
});

// anchors / merge / expansion
t('merge keys and aliases expand', () => {
  const r = L.formatYaml('base: &b {x: 1}\nuse:\n  <<: *b\n  y: 2\nref: *b\n', { expand: true });
  assert.ok(!r.text.includes('&') && !r.text.includes('*') && !r.text.includes('<<'), r.text);
  assert.equal(r.sameData, true);
});
t('expand off keeps anchors for shared nodes', () => {
  const r = L.formatYaml('a: &x [1, 2]\nb: *x\n', { expand: false });
  assert.match(r.text, /&ref_0/); assert.match(r.text, /\*ref_0/); assert.equal(r.sameData, true);
});
t('alias bomb is refused for expansion and JSON', () => {
  let lines = ['a0: &a0 [x,x,x,x,x,x,x,x,x,x]'];
  for (let i = 1; i < 12; i++) lines.push(`a${i}: &a${i} [${Array(10).fill('*a' + (i - 1)).join(',')}]`);
  const text = lines.join('\n');
  const f = L.formatYaml(text, { expand: true });
  assert.ok(f.ok); assert.ok(f.warnings.some(w => /alias bomb/.test(w)));
  assert.ok(f.text.length < 5000);
  const j = L.yamlToJson(text); assert.equal(j.ok, false); assert.match(j.error.message, /alias bomb/);
});
t('cyclic alias handled', () => {
  const f = L.formatYaml('&a [*a]\n', { expand: true });
  assert.ok(f.ok); assert.ok(f.warnings.some(w => /circular/.test(w)));
  assert.equal(L.yamlToJson('&a [*a]\n').ok, false);
});
t('analyzeValue sizes', () => {
  const s = [1]; const a = L.analyzeValue({ x: s, y: s });
  assert.equal(a.size, 1 + 2 * 2); assert.equal(a.cyclic, false); assert.equal(L.countShared({ x: s, y: s }), 1);
});

// formatting options
t('indent 2 vs 4', () => {
  assert.equal(L.formatYaml('a: {b: {c: 1}}', { indent: 2 }).text, 'a:\n  b:\n    c: 1\n');
  assert.equal(L.formatYaml('a: {b: {c: 1}}', { indent: 4 }).text, 'a:\n    b:\n        c: 1\n');
});
t('sort keys', () => assert.equal(L.formatYaml('b: 1\na: 2\nc: {z: 1, w: 2}\n', { sortKeys: true }).text, 'a: 2\nb: 1\nc:\n  w: 2\n  z: 1\n'));
t('quote style', () => {
  assert.equal(L.formatYaml('a: "yes"\n', { quote: "'" }).text, "a: 'yes'\n");
  assert.equal(L.formatYaml('a: "yes"\n', { quote: '"' }).text, 'a: "yes"\n');
  assert.equal(L.formatYaml('a: hello\n', { forceQuotes: true, quote: '"' }).text, 'a: "hello"\n');
});
t('flow level', () => {
  assert.equal(L.formatYaml('a:\n  - 1\n  - {b: 2}\n', { flow: 'flow-1' }).text, 'a: [1, {b: 2}]\n');
  assert.equal(L.formatYaml('a: {b: [1]}', { flow: 'flow' }).text, '{a: {b: [1]}}\n');
  assert.equal(L.formatYaml('a: [1, 2]', { flow: 'block' }).text, 'a:\n  - 1\n  - 2\n');
});
t('line width folds long strings', () => {
  const long = 'word '.repeat(40).trim();
  const out = L.formatYaml(`a: ${long}\n`, { lineWidth: 40 }).text;
  assert.ok(out.split('\n').length > 2); assert.ok(L.formatYaml(out).sameData);
  assert.equal(L.formatYaml(`a: ${long}\n`, { lineWidth: 0 }).text.split('\n').length, 2);
});
t('multi-document format keeps separators', () => {
  const r = L.formatYaml('a: 1\n---\nb: 2\n'); assert.equal(r.text, '---\na: 1\n---\nb: 2\n'); assert.equal(r.count, 2);
});
t('format is idempotent', () => { const a = L.formatYaml(L.SAMPLE).text; assert.equal(L.formatYaml(a).text, a); });
t('strings that look special are quoted on output', () => {
  const out = L.formatYaml('a: "yes"\nb: "123"\nc: "null"\nd: "a: b"\n').text;
  assert.deepEqual(L.parseAll(out).docs[0], { a: 'yes', b: '123', c: 'null', d: 'a: b' });
});
t('comments produce a warning', () => {
  const r = L.formatYaml('# hi\na: 1 # trailing\n'); assert.ok(r.warnings.some(w => /comments/.test(w)));
  assert.equal(L.formatYaml('a: "x # not a comment"\nb: |\n  # in block\n').warnings.filter(w => /comments/.test(w)).length, 0);
});
t('large document (1.5 MB) formats and stays equal', () => {
  const text = Array.from({ length: 30000 }, (_, i) => `key${i}:\n  name: item ${i}\n  tags: [a, b]\n  n: ${i}`).join('\n') + '\n';
  assert.ok(text.length > 1_000_000);
  const r = L.formatYaml(text); assert.ok(r.ok); assert.ok(r.sameData);
});

// conversion
t('yaml to json', () => {
  assert.deepEqual(JSON.parse(L.yamlToJson('a: 1\nb: [x]\nc: ~\nd: 2024-01-05\n').text), { a: 1, b: ['x'], c: null, d: '2024-01-05T00:00:00.000Z' });
  const multi = L.yamlToJson('a: 1\n---\nb: 2\n'); assert.deepEqual(JSON.parse(multi.text), [{ a: 1 }, { b: 2 }]); assert.ok(multi.warnings.length);
  assert.equal(L.yamlToJson('a: 1\n', { indent: '\t' }).text, '{\n\t"a": 1\n}');
});
t('special floats become strings in JSON', () => assert.deepEqual(JSON.parse(L.yamlToJson('a: .inf\nb: .nan\n').text), { a: 'Infinity', b: 'NaN' }));
t('yaml error propagates from conversion', () => assert.equal(L.yamlToJson('a: [').ok, false));
t('json to yaml', () => {
  const r = L.jsonToYaml('{"a":1,"b":[true,null,"yes"],"c":{"d":"x: y"}}');
  assert.equal(r.text, "a: 1\nb:\n  - true\n  - null\n  - 'yes'\nc:\n  d: 'x: y'\n");
  assert.deepEqual(L.parseAll(r.text).docs[0], { a: 1, b: [true, null, 'yes'], c: { d: 'x: y' } });
});
t('json to yaml errors with position', () => {
  const r = L.jsonToYaml('{\n  "a": ,\n}'); assert.equal(r.ok, false); assert.equal(r.error.line, 2); assert.match(r.error.message, /Invalid JSON/);
  assert.equal(L.jsonToYaml('').ok, false);
});
t('json to yaml respects options', () => {
  assert.equal(L.jsonToYaml('{"b":1,"a":{"c":2}}', { sortKeys: true, indent: 4 }).text, 'a:\n    c: 2\nb: 1\n');
});
t('json unicode and top-level scalar', () => { assert.equal(L.jsonToYaml('"日本"').text, '日本\n'); assert.equal(L.jsonToYaml('[]').text, '[]\n'); });

// checks
const codes = text => L.checkYaml(text).findings.map(f => f.code);
t('checks: Norway problem and 1.1 booleans', () => {
  const f = L.checkYaml('country: NO\nanswer: yes\nflag: off\nletter: n\nok: "no"\nreal: true\n').findings;
  assert.deepEqual(f.map(x => x.code), ['norway', 'norway', 'norway', 'bool-yn']);
  assert.deepEqual(f.map(x => x.line), [1, 2, 3, 4]);
});
t('checks: list items', () => assert.deepEqual(codes('countries:\n  - NO\n  - SE\n  - "no"\n'), ['norway']));
t('checks: octal, sexagesimal, versions, bigint, timestamp, null', () => {
  assert.deepEqual(codes('a: 0755\nb: 12:30\nc: 1.10\nd: 1234567890123456789\ne: 2024-01-05\nf: ~\ng: Null\nh: 1.0\ni: 0o17\n'),
    ['octal', 'sexagesimal', 'trailing-zero', 'bigint', 'timestamp', 'null', 'null', 'octal12']);
});
t('checks: quoted and flow values are skipped, comments ignored', () => {
  assert.deepEqual(codes('a: "NO"\nb: [yes, no]\nc: foo # NO\nd: |\n  yes\n  0755\n'), []);
});
t('checks: tabs, merge keys, anchors', () => {
  const c = codes('x: &used 1\ny: &unused 2\nz: *used\nm:\n  <<: *used\n\tbad: 1\n');
  assert.ok(c.includes('tab-indent')); assert.ok(c.includes('merge-key')); assert.ok(c.includes('unused-anchor'));
  assert.ok(!L.checkYaml('x: &used 1\nz: *used\n').findings.some(f => f.code === 'unused-anchor'));
});
t('checks: document count and colon values', () => {
  assert.equal(L.checkYaml('a: 1\n---\nb: 2\n---\nc: 3\n').documents, 3);
  assert.ok(codes('a: foo: bar\n').includes('colon'));
  assert.ok(codes('a: @foo\n').includes('reserved-indicator'));
});
t('scanComments', () => {
  assert.equal(L.scanComments('a: 1 # c\n# d\nb: "x # y"\nc: \'#\'\nurl: http://x/#frag\n').length, 2);
});

// outline / search
t('pathToString', () => {
  assert.equal(L.pathToString(['a', 0, 'b-c', 'x y', 'z']), 'a[0].b-c["x y"].z');
  assert.equal(L.pathToString([]), '$');
});
t('searchValue finds keys and values, survives cycles', () => {
  const doc = L.parseAll('users:\n  - name: Ann\n    role: admin\n  - name: Bob\n').docs[0];
  const h = L.searchValue(doc, 'ann'); assert.equal(h.length, 1); assert.equal(L.pathToString(h[0].path), 'users[0].name');
  assert.equal(L.searchValue(doc, 'name').length, 2);
  const cyc = L.parseAll('&a {self: *a, v: 1}\n').docs[0];
  assert.ok(L.searchValue(cyc, 'v').length >= 1);
  assert.equal(L.searchValue(doc, '').length, 0);
});
t('describeValue and childrenOf', () => {
  assert.equal(L.describeValue([1, 2]).preview, '[2]'); assert.equal(L.describeValue({ a: 1 }).type, 'object'); assert.equal(L.describeValue(null).type, 'null');
  assert.deepEqual(L.childrenOf({ a: 1 }), [['a', 1]]); assert.deepEqual(L.childrenOf('x'), []);
});
t('summarize', () => {
  const s = L.summarize(L.parseAll('a: 1\n---\n[1,2]\n').docs); assert.equal(s[0].size, 1); assert.equal(s[1].type, 'array');
});

// diff
t('diffSummary', () => {
  const d = L.diffSummary('a: 1\nb: 2\nc: 3\n', 'a: 1\nb: 5\nc: 3\nd: 4\n');
  assert.equal(d.added, 2); assert.equal(d.removed, 1); assert.deepEqual(d.changes.map(c => c.type + c.text), ['-b: 2', '+b: 5', '+d: 4']);
  assert.equal(L.diffSummary('x\n', 'x\n').identical, true);
});
t('diffSummary large input falls back to approximate', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n'), b = Array.from({ length: 3000 }, (_, i) => `m${i}`).join('\n');
  const d = L.diffSummary(a, b); assert.equal(d.approximate, true); assert.equal(d.added, 3000);
});
t('format result carries diff and sameData', () => {
  const r = L.formatYaml('b: 1\na: 2\n', { sortKeys: true }); assert.ok(r.diff.added > 0 && r.sameData);
});
t('stableEqual ignores key order', () => assert.ok(L.stableEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })));

console.log(`\n${pass} yaml-formatter tests passed`);
