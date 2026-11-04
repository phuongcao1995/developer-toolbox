// Run: node tests/unit/table-converter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as T from '../../tools/table-converter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };

test('300000-row CSV parses and converts (no spread stack overflow)', () => {
  const lines = ['id,name,score'];
  for (let i = 0; i < 300000; i++) lines.push(`${i},name${i},${i % 100}`);
  const t0 = performance.now();
  const r = T.convert(lines.join('\n'), 'csv', 'json', { header: true, indent: '' });
  const ms = performance.now() - t0;
  assert.equal(r.table.rows.length, 300000);
  console.log(`  300k-row CSV -> JSON: ${ms.toFixed(0)} ms`);
  const md = T.convert(lines.slice(0, 200001).join('\n'), 'csv', 'markdown');
  assert.equal(md.table.rows.length, 200000);
});
test('300000-row JSON array of arrays and objects', () => {
  const arr = Array.from({ length: 300000 }, (_, i) => [i, 'x']);
  const r = T.parseJson(JSON.stringify(arr), { header: false });
  assert.equal(r.rows.length, 300000);
  const r2 = T.parseJson(JSON.stringify(arr), { header: true });
  assert.equal(r2.rows.length, 299999);
});

test('csv: quoted-empty row in one-column CSV is kept, blank lines skipped', () => {
  assert.deepEqual(T.parseCsvRows('a\n""\nb').rows, [['a'], [''], ['b']]);
  assert.deepEqual(T.parseCsvRows('a\n\nb\n').rows, [['a'], ['b']]);
  assert.deepEqual(T.parseCsvRows('a\n\n\n"b"\n\n').rows, [['a'], ['b']]);
  assert.deepEqual(T.parseCsvRows('a\n""').rows, [['a'], ['']]);
  assert.deepEqual(T.parseCsvRows('a,b\n"",\n').rows, [['a', 'b'], ['', '']]);
  assert.deepEqual(T.parseCsvRows('a\r\n""\r\nb\r\n').rows, [['a'], [''], ['b']]);
});
test('csv: line numbers still tracked', () => {
  const { lines } = T.parseCsvRows('a\n\n"x\ny"\nz');
  assert.deepEqual(lines, [1, 3, 5]);
});
test('csv: parse basics unchanged', () => {
  const t = T.parseCsv('a,b\n1,"x, y"\n2,z');
  assert.deepEqual(t.columns, ['a', 'b']); assert.deepEqual(t.rows, [['1', 'x, y'], ['2', 'z']]);
});

test('json: flatten nested objects with dot paths (opt-in)', () => {
  const src = '[{"a":{"b":1,"c":{"d":2}},"t":[1,2],"e":{},"x.y":3},{"a":{"b":4}}]';
  const off = T.parseJson(src);
  assert.deepEqual(off.columns, ['a', 't', 'e', 'x.y']);
  assert.equal(off.rows[0][0], '{"b":1,"c":{"d":2}}');
  const on = T.parseJson(src, { flatten: true });
  assert.deepEqual(on.columns, ['a.b', 'a.c.d', 't', 'e', 'x\\.y']);
  assert.deepEqual(on.rows[0], [1, 2, '[1,2]', '{}', 3]);
  assert.deepEqual(on.rows[1], [4, null, null, null, null]);
});
test('json: flatten does not collide a.b with {a:{b}}', () => {
  const on = T.parseJson('[{"a.b":1,"a":{"b":2}}]', { flatten: true });
  assert.equal(on.columns.length, 2);
});
test('json: flatten via convert()', () => {
  const r = T.convert('[{"a":{"b":1}}]', 'json', 'csv', { flatten: true });
  assert.equal(r.output, 'a.b\n1');
});
test('json: unsafe integer warning', () => {
  const r = T.parseJson('[{"id":12345678901234567890,"s":"98765432109876543210","ok":9007199254740992,"f":1.5}]');
  assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /1 integer\(s\) exceed 2\^53/); assert.match(r.warnings[0], /12345678901234567890/);
  assert.equal(T.parseJson('[{"id":9007199254740993}]').warnings.length, 1);
  assert.equal(T.parseJson('[{"id":-9007199254740993}]').warnings.length, 1);
  assert.equal(T.parseJson('[{"id":9007199254740992,"s":"12345678901234567890"}]').warnings.length, 0);
  const c = T.convert('[[1],[12345678901234567890]]', 'json', 'csv');
  assert.equal(c.warnings.length, 1);
});
test('json: findUnsafeIntegers ignores strings containing escaped quotes', () => {
  assert.equal(T.findUnsafeIntegers('["a\\"12345678901234567890","b"]').count, 0);
});

test('csv output: escape formulas is opt-in', () => {
  const table = { columns: ['a', '=h'], rows: [['=1+1', '+x'], ['-y', '@z'], ['\tt', '-5'], ['ok', '1.5e3']] };
  assert.equal(T.toCsv(table), 'a,=h\n=1+1,+x\n-y,@z\n"\tt",-5\nok,1.5e3');
  assert.equal(T.toCsv(table, { escapeFormulas: true }), "a,'=h\n'=1+1,'+x\n'-y,'@z\n'\tt,-5\nok,1.5e3");
  assert.equal(T.convert('[{"a":"=cmd|x"}]', 'json', 'csv', { escapeFormulas: true }).output, "a\n'=cmd|x");
  assert.equal(T.convert('[{"a":"=cmd|x"}]', 'json', 'csv', {}).output, 'a\n=cmd|x');
});

test('markdown/sql still work', () => {
  const r = T.convert('a,b\n1,x', 'csv', 'markdown');
  assert.match(r.output, /\|\s+a \| b\s+\|/);
  assert.match(T.convert('a,b\n1,x', 'csv', 'sql').output, /INSERT INTO "my_table"/);
});

console.log(`table-converter: ${pass} passed`);
