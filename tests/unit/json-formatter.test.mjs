// Run: node tests/unit/json-formatter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/json-formatter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const deep = n => '['.repeat(n) + ']'.repeat(n);

test('deep nesting: stats/sortKeys do not overflow', () => {
  const v = JSON.parse(deep(200000));
  assert.equal(L.stats(v).depth, 200000);
  assert.ok(L.sortKeys(v));
});
test('deep nesting: depth guard gives friendly error', () => {
  const v = JSON.parse(deep(5000));
  for (const fn of [L.formatJson, L.minifyJson, L.toXml, L.toYaml]) assert.throws(() => fn(v), /nested too deeply \(limit 2000\)/);
  assert.doesNotThrow(() => L.toCsv([v]));
});
test('deep nesting: parseJson does not crash', () => {
  const r = L.parseJson(deep(200000));
  assert.ok(r.ok || typeof r.message === 'string');
});
test('deep nesting: lossless minify works, format is limited', () => {
  assert.equal(L.reformatLossless(deep(200000), { minify: true }), deep(200000));
  assert.throws(() => L.reformatLossless(deep(3000)), /too deeply/);
  assert.equal(L.reformatLossless(deep(50), { minify: true }).length, 100);
});
test('sortKeys sorts nested and keeps arrays, __proto__ safe', () => {
  assert.equal(JSON.stringify(L.sortKeys({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })), '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}');
  const p = L.sortKeys(JSON.parse('{"b":1,"__proto__":{"x":1}}'));
  assert.deepEqual(Object.keys(p), ['__proto__', 'b']);
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
});
test('stats counts nodes', () => assert.deepEqual(L.stats({ a: [1, 2], b: null }), { nodes: 5, depth: 3 }));

// ---- lossiness
test('lossy: big integer', () => {
  const a = L.analyzeLossiness('{"id": 12345678901234567890, "ok": 9007199254740992, "f": 1.5}');
  assert.equal(a.numberCount, 1); assert.equal(a.numbers[0].path, '$.id'); assert.equal(a.numbers[0].becomes, '12345678901234567000');
});
test('lossy: 2^53+1, overflow, underflow, long decimals', () => {
  assert.equal(L.analyzeLossiness('[9007199254740993]').numberCount, 1);
  assert.equal(L.analyzeLossiness('[1e400, -1e999]').numberCount, 2);
  assert.match(L.analyzeLossiness('[1e400]').numbers[0].reason, /Infinity/);
  assert.equal(L.analyzeLossiness('[1e-400]').numberCount, 1);
  assert.equal(L.analyzeLossiness('[0.1000000000000000055511151231257827]').numberCount, 1);
});
test('lossy: safe numbers are not flagged', () => {
  const a = L.analyzeLossiness('[0, -0, 1.0, 1.10, 0.1, 0.30000000000000004, 1e10, 1E+2, 123456789012345680000, 5e-324, 1.7976931348623157e308, 0.00]');
  assert.equal(a.numberCount, 0, JSON.stringify(a.numbers));
  assert.equal(a.lossy, false);
});
test('lossy: duplicate keys with path', () => {
  const a = L.analyzeLossiness('{"a":{"x":1,"x":2},"l":[{"k":1,"k":2}],"b":1,"b":2}');
  assert.equal(a.dupCount, 3);
  assert.deepEqual(a.dups.map(d => `${d.path}|${d.key}`), ['$.a|x', '$.l[0]|k', '$|b']);
});
test('lossy: duplicate detection compares unescaped keys; same key in different objects is fine', () => {
  assert.equal(L.analyzeLossiness('{"a":1,"\\u0061":2}').dupCount, 1);
  assert.equal(L.analyzeLossiness('[{"a":1},{"a":2}]').dupCount, 0);
});
test('lossy: numbers inside strings ignored, invalid JSON returns ok:false', () => {
  assert.equal(L.analyzeLossiness('{"a":"12345678901234567890"}').lossy, false);
  assert.equal(L.analyzeLossiness('{bad').ok, false);
});
test('describeLossiness', () => {
  assert.equal(L.describeLossiness(L.analyzeLossiness('[1,2]')), '');
  const s = L.describeLossiness(L.analyzeLossiness('{"a":12345678901234567890,"a":1}'));
  assert.match(s, /^Formatting will change these values: /); assert.match(s, /1 number/); assert.match(s, /1 duplicate key/);
});

// ---- lossless reformat
test('lossless format keeps big numbers, 1e400 and dup keys', () => {
  const out = L.reformatLossless('{"a":12345678901234567890,"a":1e400,"b":[1,2,{}],"c":[]}', { indent: 2 });
  assert.equal(out, '{\n  "a": 12345678901234567890,\n  "a": 1e400,\n  "b": [\n    1,\n    2,\n    {}\n  ],\n  "c": []\n}');
});
test('lossless minify keeps strings, escapes and unicode verbatim', () => {
  const src = ' {  "k\\u00e9y" : "a \\"q\\" \\\\ \\n ,{}[]: é 😀" , "n" : -0.0e+10 , "t":true,"z":null } ';
  assert.equal(L.reformatLossless(src, { minify: true }), '{"k\\u00e9y":"a \\"q\\" \\\\ \\n ,{}[]: é 😀","n":-0.0e+10,"t":true,"z":null}');
});
test('lossless format equals JSON.stringify for plain data', () => {
  const v = { a: [1, 2, { b: 'x,y:z' }], c: {}, d: [], e: [[]], f: [{}] };
  for (const ind of [2, 4, '\t']) assert.equal(L.reformatLossless(JSON.stringify(v), { indent: ind }), JSON.stringify(v, null, ind));
});
test('lossless: scalars and errors', () => {
  assert.equal(L.reformatLossless('  123456789012345678901234567890 '), '123456789012345678901234567890');
  assert.throws(() => L.reformatLossless('{"a":1,}'), e => e.scanError && e.offset === 7);
});

// ---- error positions
test('error: position, line, column and caret snippet', () => {
  const r = L.parseJson('{\n  "a": 1,\n  "b": ,\n}');
  assert.equal(r.ok, false); assert.equal(r.line, 3); assert.equal(r.column, 8);
  assert.match(r.message, /line 3, column 8/);
  assert.equal(r.snippet, '  "b": ,\n       ^');
  assert.equal(r.offset, 19);
});
test('error: end of input, trailing garbage, bad tokens', () => {
  const a = L.parseJson('{"a":[1,2'); assert.equal(a.offset, 9); assert.match(a.message, /end of JSON input/);
  const b = L.parseJson('{"a":1} x'); assert.equal(b.offset, 8);
  const c = L.parseJson("{'a':1}"); assert.equal(c.column, 2);
  const d = L.parseJson('[01]'); assert.equal(d.offset, 2);
  const e = L.parseJson('["a\nb"]'); assert.match(e.message, /control character/);
  const f = L.parseJson('["\\x"]'); assert.match(f.message, /bad escape/);
  const g = L.parseJson('[tru]'); assert.equal(g.offset, 1);
  assert.equal(L.parseJson('').ok, false);
});
test('error: valid input still parses; long line snippet is trimmed', () => {
  assert.deepEqual(L.parseJson('[1, {"a": null}]').value, [1, { a: null }]);
  const r = L.parseJson('{"a":"' + 'x'.repeat(200) + '", oops}');
  assert.ok(r.snippet.split('\n')[0].length < 80); assert.ok(r.snippet.includes('^'));
});

// ---- flatten / csv
test('flatten escapes dots so keys do not collide', () => {
  const f = L.flatten({ 'a.b': 1, a: { b: 2 }, c: [3, { d: 4 }], 'e\\f': 5 });
  assert.deepEqual(f, { 'a\\.b': 1, 'a.b': 2, 'c.0': 3, 'c.1.d': 4, 'e\\\\f': 5 });
});
test('flatten empty containers and primitives', () => {
  assert.deepEqual(L.flatten({ a: [], b: {} }), { a: '[]', b: '{}' });
  assert.deepEqual(L.flatten(5), { value: 5 });
});
test('flatten collision report (array index vs numeric key)', () => {
  const c = [];
  L.flatten({ x: [1], 'x.0': 2 }, '', {}, { collisions: c });
  assert.deepEqual(c, []);
  const c2 = [];
  L.flatten({ x: { 0: 1 }, y: 1 }, '', { y: 0 }, { collisions: c2 });
  assert.deepEqual(c2, ['y']);
});
test('csv: formula escaping opt-in', () => {
  const data = [{ a: '=1+1', b: '+x', c: '-y', d: '@z', e: '\tt', f: 'ok', g: -5 }];
  const off = L.toCsv(data);
  assert.ok(off.includes('=1+1'));
  const on = L.toCsv(data, { escapeFormulas: true });
  assert.equal(on, 'a,b,c,d,e,f,g\r\n\'=1+1,\'+x,\'-y,\'@z,\'\tt,ok,-5');
});
test('csv: back-compat delimiter string and quoting', () => {
  assert.equal(L.toCsv([{ a: 'x;y', b: 1 }], ';'), 'a;b\r\n"x;y";1');
  assert.equal(L.toCsv([{ a: 'q"q' }]), 'a\r\n"q""q"');
});
test('csv: dotted keys escaped in headers', () => {
  assert.equal(L.toCsv([{ 'a.b': 1, a: { b: 2 } }]).split('\r\n')[0], 'a\\.b,a.b');
});

// ---- toXml edge cases
test('xml: invalid element names fall back to <item key="...">', () => {
  const x = L.toXml({ 'a b': 1, '1x': 2, 'x:y': 3, xmlfoo: 4, '': 5, ok: 6, 'a"b': 7 }, { indent: 0 });
  assert.ok(x.includes('<item key="a b">1</item>'));
  assert.ok(x.includes('<item key="1x">2</item>'));
  assert.ok(x.includes('<item key="x:y">3</item>'));
  assert.ok(x.includes('<item key="xmlfoo">4</item>'));
  assert.ok(x.includes('<item key="">5</item>'));
  assert.ok(x.includes('<ok>6</ok>'));
  assert.ok(x.includes('<item key="a&quot;b">7</item>'));
});
test('xml: escaping of & < > " \' and control characters', () => {
  const x = L.toXml({ s: `a&b<c>d"e'f\u0001\u0008g\tTab\nNL` }, { indent: 0 });
  assert.ok(x.includes('<s>a&amp;b&lt;c&gt;d&quot;e&apos;fg\tTab\nNL</s>'), x);
  assert.ok(!/[\u0000-\u0008]/.test(x));
  const k = L.toXml({ 'k\n"\t': 1 }, { indent: 0 });
  assert.ok(k.includes('key="k&#10;&quot;&#9;"'), k);
  assert.ok(!L.toXml({ a: '\ud800x' }).includes('\ud800')); // lone surrogate dropped
});
test('xml: arrays -> repeated elements, nested arrays keep structure, empty containers', () => {
  const x = L.toXml({ a: [1, 2], e: [], o: {}, n: [[1, 2], []] }, { indent: 0 });
  assert.ok(x.includes('<a>1</a><a>2</a>'));
  assert.ok(x.includes('<e/><o/>'));
  assert.ok(x.includes('<n><item>1</item><item>2</item></n><n/>'));
  assert.ok(L.toXml([1, 'x'], { indent: 0 }).includes('<root><item>1</item><item>x</item></root>'));
});
test('xml: null -> xsi:nil with namespace, or empty element', () => {
  const x = L.toXml({ a: null, b: { c: null } }, { indent: 0 });
  assert.ok(x.includes('<a xsi:nil="true"/>') && x.includes('<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'), x);
  assert.ok(!L.toXml({ a: 1 }).includes('xmlns:xsi'));
  assert.ok(L.toXml({ a: null }, { nullMode: 'empty', indent: 0 }).includes('<a/>'));
  assert.ok(L.toXml(null, { indent: 0 }).includes('<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>'));
});
test('xml: unicode preserved, root option, wrapRoot=false, declaration', () => {
  const x = L.toXml({ '\u00e9t\u00e9': '\u65e5\u672c\u8a9e \u{1F600}', 'caf\u00e9': 1 }, { indent: 0 });
  assert.ok(x.includes('<\u00e9t\u00e9>\u65e5\u672c\u8a9e \u{1F600}</\u00e9t\u00e9>') && x.includes('<caf\u00e9>1</caf\u00e9>'));
  assert.ok(L.toXml({ a: 1 }, { root: 'doc', indent: 0 }).endsWith('<doc><a>1</a></doc>'));
  assert.ok(L.toXml({ a: 1 }, { root: 'bad name', indent: 0 }).endsWith('<root><a>1</a></root>'));
  assert.ok(L.toXml({ only: { x: 1 } }, { wrapRoot: false, indent: 0 }).endsWith('<only><x>1</x></only>'));
  assert.ok(L.toXml({ a: 1, b: 2 }, { wrapRoot: false, indent: 0 }).includes('<root>')); // cannot unwrap two keys
  assert.ok(L.toXml({ a: 1 }).startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <a>1</a>'));
  assert.ok(!L.toXml({ a: 1 }, { declaration: false }).startsWith('<?xml'));
  assert.equal(L.toXml(5, { indent: 0 }), '<?xml version="1.0" encoding="UTF-8"?><root>5</root>');
});
test('xml: output is well formed (round trip via a tiny checker)', () => {
  const x = L.toXml({ 'a b': [{ '1': 'x<&>' }, null], k: { 'k2': true } }, { declaration: false });
  const tags = [...x.matchAll(/<(\/?)([^\s/>]+)[^>]*?(\/?)>/g)];
  const st = [];
  for (const [, close, name, self] of tags) { if (self) continue; if (close) assert.equal(st.pop(), name); else st.push(name); }
  assert.equal(st.length, 0);
});

// ---- sample generator
import * as G from '../../tools/json-formatter/generate.js';
import { searchData } from '../../tools/json-formatter/tree.js';

test('template: placeholders, types and interpolation', () => {
  const v = G.generateFromTemplate({ n: '{{name}}', e: '{{email}}', u: '{{uuid}}', i: '{{int(5,7)}}', f: '{{float(0,1)}}', b: '{{bool}}', d: '{{date}}', p: '{{pick(a,b,c)}}', l: '{{lorem(5)}}', mix: 'user-{{int(1,1)}}@x.io', lit: 'plain', num: 3 }, { seed: 's' });
  assert.match(v.n, /^\w+ \w+$/); assert.match(v.e, /^[^@\s]+@[^@\s]+\.[a-z]+$/);
  assert.match(v.u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(Number.isInteger(v.i) && v.i >= 5 && v.i <= 7); assert.ok(typeof v.f === 'number' && v.f >= 0 && v.f <= 1);
  assert.equal(typeof v.b, 'boolean'); assert.match(v.d, /^\d{4}-\d{2}-\d{2}$/); assert.ok(['a', 'b', 'c'].includes(v.p));
  assert.equal(v.l.replace(/\.$/, '').split(' ').length, 5); assert.equal(v.mix, 'user-1@x.io'); assert.equal(v.lit, 'plain'); assert.equal(v.num, 3);
});
test('template: $repeat repeats the first element independently', () => {
  const v = G.generateFromTemplate('{"xs":[{"$repeat":4,"id":"{{int(1,1000000)}}","k":"v"},"tail"]}', { seed: 1 });
  assert.equal(v.xs.length, 5); assert.equal(v.xs[4], 'tail');
  assert.ok(v.xs.slice(0, 4).every(x => !('$repeat' in x) && x.k === 'v'));
  assert.ok(new Set(v.xs.slice(0, 4).map(x => x.id)).size > 1);
  assert.deepEqual(G.generateFromTemplate([{ $repeat: 0, a: 1 }]), []);
});
test('template: seeded output is deterministic, unseeded varies', () => {
  const t = G.SAMPLE_TEMPLATE;
  assert.deepEqual(G.generateFromTemplate(t, { seed: 'abc' }), G.generateFromTemplate(t, { seed: 'abc' }));
  assert.notDeepEqual(G.generateFromTemplate(t, { seed: 'abc' }), G.generateFromTemplate(t, { seed: 'abd' }));
  assert.notDeepEqual(G.generateFromTemplate({ u: '{{uuid}}' }), G.generateFromTemplate({ u: '{{uuid}}' }));
});
test('template: errors and caps', () => {
  assert.throws(() => G.generateFromTemplate({ a: '{{nope}}' }), /Unknown placeholder/);
  assert.throws(() => G.generateFromTemplate({ a: '{{int(x,2)}}' }), /Bad number/);
  assert.throws(() => G.generateFromTemplate([{ $repeat: -1 }]), /\$repeat/);
  assert.throws(() => G.generateFromTemplate([{ $repeat: 10000, a: [{ $repeat: 10000 }] }]), /node limit/);
  assert.throws(() => G.generateFromTemplate('{bad'), SyntaxError);
  assert.deepEqual(G.generateFromTemplate({ ['__proto__']: 1 }).constructor, Object);
});
test('schema: honours types, enum, min/max, format, required, nesting, arrays', () => {
  const schema = {
    type: 'object', required: ['id', 'email', 'age', 'st', 'tags', 'when', 'addr'],
    properties: {
      id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 18, maximum: 20 },
      st: { enum: ['a', 'b'] }, tags: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 4, maxLength: 4 } },
      when: { type: 'string', format: 'date-time' }, price: { type: 'number', minimum: 1, maximum: 2, multipleOf: 0.5 },
      addr: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', maxLength: 5 } } }, c: { const: 7 },
    },
  };
  for (let s = 0; s < 20; s++) {
    const v = G.generateFromSchema(schema, { seed: s });
    assert.match(v.id, /^[0-9a-f-]{36}$/); assert.match(v.email, /@/); assert.ok(v.age >= 18 && v.age <= 20 && Number.isInteger(v.age));
    assert.ok(['a', 'b'].includes(v.st)); assert.equal(v.tags.length, 3); assert.ok(v.tags.every(t => t.length === 4));
    assert.match(v.when, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); assert.ok(v.addr.zip.length <= 5);
    if ('price' in v) assert.ok(v.price >= 1 && v.price <= 2 && (v.price * 2) % 1 === 0);
    if ('c' in v) assert.equal(v.c, 7);
  }
});
test('schema: generated data validates against the schema (round trip)', async () => {
  const { validate } = await import('../../assets/js/shared/json-schema.js');
  const schema = G.SAMPLE_SCHEMA;
  for (let s = 0; s < 25; s++) { const r = validate(schema, G.generateFromSchema(schema, { seed: 'k' + s })); assert.equal(r.valid, true, JSON.stringify(r.errors)); }
  const withRef = { definitions: { n: { type: 'object', required: ['v'], properties: { v: { type: 'integer' }, next: { $ref: '#/definitions/n' } } } }, $ref: '#/definitions/n' };
  const g = G.generateFromSchema(withRef, { seed: 1 });
  assert.equal(typeof g.v, 'number'); // recursion terminates
});
test('schema: seeded output is deterministic', () => {
  assert.deepEqual(G.generateFromSchema(G.SAMPLE_SCHEMA, { seed: 'x' }), G.generateFromSchema(G.SAMPLE_SCHEMA, { seed: 'x' }));
  assert.ok(G.generateFromSchema('{"type":"array","minItems":2,"items":{"type":"boolean"}}', { seed: 1 }).length >= 2);
});

// ---- tree search (pure part of the tree explorer)
test('tree search: keys / values / both, document order, paths', () => {
  const d = { name: 'Ann', items: [{ name: 'Bob', n: 1 }, { tag: 'ann-x' }], x: { y: 'Ann' } };
  assert.deepEqual(searchData(d, 'ann', 'values').matches, [['name'], ['items', 1, 'tag'], ['x', 'y']]);
  assert.deepEqual(searchData(d, 'name', 'keys').matches, [['name'], ['items', 0, 'name']]);
  assert.equal(searchData(d, 'ann', 'both').matches.length, 3);
  assert.deepEqual(searchData(d, 'zzz').matches, []);
  assert.deepEqual(searchData(d, '1', 'values').matches, [['items', 0, 'n']]);
  assert.equal(searchData(d, '').matches.length, 0);
});
test('tree search: cap and truncation flag, deep data', () => {
  const r = searchData(Array.from({ length: 5000 }, () => 'hit'), 'hit', 'values', 100);
  assert.equal(r.matches.length, 100); assert.equal(r.truncated, true);
  let v = 'needle'; for (let i = 0; i < 50000; i++) v = [v];
  assert.equal(searchData(v, 'needle').matches[0].length, 50000);
});

console.log(`json-formatter: ${pass} passed`);
