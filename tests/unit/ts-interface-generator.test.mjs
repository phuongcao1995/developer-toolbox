// Run: node tests/unit/ts-interface-generator.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/ts-interface-generator/logic.js';
import { jsonToTypeScript as shared } from '../../assets/js/shared/ts-interfaces.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const gen = (v, o = {}) => { const r = L.generate(typeof v === 'string' ? v : JSON.stringify(v), o); assert.ok(r.ok, r.error && r.error.message); return r.code; };
const has = (out, re) => assert.match(out, re, out);
const lacks = (out, re) => assert.doesNotMatch(out, re, out);

// ---------- parity with the shared module (default options) ----------
const SAMPLES = [
  { a: 1, b: 'x', c: true, d: null },
  { user_profile: { first_name: 'a', 'home-address': { zip: '1' } } },
  { '1a': 1, 'a b': 2, 'a-b': 3, '': 4, ok_$: 5, class: 6 },
  { items: [{ id: 1 }, { id: 2, tag: 'x' }], tags: ['a', 'b'], empty: [], mixed: [1, 'a', null, { x: 1 }], matrix: [[1, 2], [3]] },
  [{ id: 1, name: 'a' }, { id: 2 }],
  [1, 2, 3], '"str"', 42, null, true, [],
  { a: { b: { c: { d: [{ e: 1 }] } } }, categories: [{ id: 1 }], boxes: [{ id: 1 }], statuses: [{ s: 1 }], address: { street: 's' }, addresses: [{ street: 's' }] },
  { date: '2020-01-01', ts: '2020-01-01T10:00:00Z', other: 'x' },
  { Date: { a: 1 }, Array: { a: 2 }, type: { a: 3 } },
  { x: [{ a: 1 }, { b: 2 }], y: { a: 1 }, z: { a: 1 } },
];
for (const [i, v] of SAMPLES.entries()) {
  test(`parity with shared module #${i}`, () => assert.equal(gen(v), shared(v)));
  test(`parity #${i} (type alias, readonly, no export)`, () => {
    const o = { useInterface: false, readonly: true, exportKeyword: false };
    assert.equal(gen(v, o), shared(v, o));
  });
  test(`parity #${i} (mergeArrayShapes=false, rootName)`, () => {
    const o = { mergeArrayShapes: false, rootName: 'my doc' };
    assert.equal(gen(v, o), shared(v, o));
  });
}
test('parity: Date mode / dateAsString=false', () => {
  const v = { d: '2020-01-01T00:00:00Z', e: 'nope' };
  assert.equal(gen(v, { dateMode: 'Date' }), shared(v, { dateAsString: false }));
  assert.equal(gen(v, { dateAsString: false }), shared(v, { dateAsString: false }));
});

// ---------- scanner / error positions ----------
test('scanValue returns the end offset', () => { assert.equal(L.scanValue('  {"a":[1,2,{"b":null}]}  x', 0), 24); assert.equal(L.scanValue('123 456', 0), 3); });
const errOf = s => { const r = L.generate(s); assert.equal(r.ok, false); return r.error; };
test('error: trailing comma with line/column', () => { const e = errOf('{\n  "a": 1,\n}'); assert.equal(e.line, 3); assert.equal(e.column, 1); assert.match(e.message, /Trailing comma/); });
test('error: array trailing comma', () => assert.match(errOf('[1,2,]').message, /Trailing comma/));
test('error: single quotes hint', () => { const e = errOf("{'a': 1}"); assert.match(e.message, /double quotes/); assert.equal(e.column, 2); });
test('error: unquoted key hint', () => assert.match(errOf('{a: 1}').message, /double quotes/));
test('error: comment', () => assert.match(errOf('{"a": 1 /* c */}').message, /Expected "," or "\}"/));
test('error: missing colon', () => assert.match(errOf('{"a" 1}').message, /Expected ":"/));
test('error: unterminated string', () => { const e = errOf('{"a": "abc'); assert.match(e.message, /Unterminated string/); assert.equal(e.column, 7); });
test('error: bad escape and control character', () => { assert.match(errOf('"a\\qb"').message, /Invalid escape/); assert.match(errOf('"a\nb"').message, /control character/); assert.match(errOf('"\\u12G4"').message, /escape/); });
test('error: invalid numbers', () => { for (const s of ['01', '1.', '-', '.5', '+1', '1e']) assert.equal(L.generate(s).ok, false, s); assert.equal(L.generate('1e5').ok, true); assert.equal(L.generate('-0.5E+3').ok, true); });
test('error: NaN / undefined', () => { assert.match(errOf('{"a": NaN}').message, /NaN/); assert.match(errOf('undefined').message, /NaN|undefined/); });
test('error: unexpected end', () => assert.match(errOf('{"a":').message, /end of input/));
test('error: unclosed object', () => assert.match(errOf('{"a":1').message, /end of the input/));
test('error: empty input', () => { const e = errOf('   \n '); assert.ok(e.empty); });
test('error: snippet carries the offending line', () => { const e = errOf('{\n  "a": 1\n  "b": 2\n}'); assert.equal(e.line, 3); assert.equal(e.snippet.line, '  "b": 2'); assert.equal(e.snippet.column, 2); });
test('error: single mode rejects trailing content with position', () => { const r = L.generate('{"a":1} x', { format: 'json' }); assert.equal(r.ok, false); assert.match(r.error.message, /after the JSON document/); assert.equal(r.error.column, 9); });
test('error: deep nesting beyond scan limit is reported', () => { const r = L.generate('['.repeat(1200) + ']'.repeat(1200)); assert.equal(r.ok, false); assert.match(r.error.message, /deeper/); });
test('locate', () => { assert.deepEqual(L.locate('ab\ncd', 4), { line: 2, column: 2 }); assert.deepEqual(L.locate('abc', 0), { line: 1, column: 1 }); });
test('BOM is ignored', () => has(gen('﻿{"a":1}'), /a: number/));

// ---------- basic inference ----------
test('primitives root', () => { has(gen(42), /export type Root = number;/); has(gen('"s"'), /type Root = string;/); has(gen('null'), /type Root = null;/); });
test('root array of objects', () => has(gen([{ a: 1 }]), /export interface RootItem \{\n {2}a: number;\n\}\n\nexport type Root = RootItem\[\];/));
test('empty containers', () => { has(gen({}), /export interface Root \{\}/); has(gen([]), /type Root = unknown\[\];/); has(gen({ a: [], b: {} }), /a: unknown\[\];/); });
test('unicode keys and values', () => { const o = gen({ '名前': '日本', 'emoji😀': '😀', 'café': 1 }); has(o, /"名前": string;/); has(o, /"emoji😀": string;/); has(o, /"café": number;/); });
test('PascalCase names, collision safe', () => { const o = gen({ a: { user: { x: 1 } }, b: { user: { y: 1 } } }); has(o, /interface User \{\n {2}x: number/); has(o, /interface User2 \{\n {2}y: number/); });
test('identical nested shapes share one interface', () => { const o = gen({ a: { x: 1 }, b: { x: 2 } }); assert.equal((o.match(/interface /g) || []).length, 2); });
test('big numbers stay number', () => has(gen('{"n": 12345678901234567890}'), /n: number;/));
test('__proto__ key is handled as data', () => { const o = gen('{"__proto__": {"a": 1}, "b": 2}'); has(o, /b: number/); has(o, /__proto__/); });
test('quoteKeys always', () => { const o = gen({ a: 1, 'b-c': 2 }, { quoteKeys: 'always' }); has(o, /"a": number;/); has(o, /"b-c": number;/); });
test('root name sanitising', () => { has(gen({ a: 1 }, { rootName: 'my-api response' }), /interface MyApiResponse/); has(gen({ a: 1 }, { rootName: 'Date' }), /interface DateType/); has(gen({ a: 1 }, { rootName: '' }), /interface Root/); });

// ---------- options ----------
test('exportKeyword false', () => lacks(gen({ a: { b: 1 } }, { exportKeyword: false }), /export/));
test('type alias', () => has(gen({ a: 1 }, { useInterface: false }), /export type Root = \{\n {2}a: number;\n\};/));
test('readonly', () => { const o = gen({ a: [1], b: { c: 1 } }, { readonly: true }); has(o, /readonly a: readonly number\[\];/); has(o, /readonly c: number;/); });
test('optional from arrays vs undefined union', () => {
  const v = [{ a: 1, b: 2 }, { a: 1 }];
  has(gen(v), /b\?: number;/);
  has(gen(v, { optionalFromArrays: false }), /b: number \| undefined;/);
});
test('merge array element shapes: mixed shapes', () => {
  const v = { l: [{ a: 1 }, { b: 'x' }] };
  const merged = gen(v); has(merged, /a\?: number;/); has(merged, /b\?: string;/);
  const split = gen(v, { mergeArrayShapes: false }); has(split, /interface L1/); has(split, /interface L2/);
});
test('date detection option', () => {
  const v = { a: '2020-01-02', b: '2020-01-02T03:04:05.123+02:00', c: 'hello', d: '2020-1-2' };
  has(gen(v), /a: string;/);
  const d = gen(v, { dateMode: 'Date' }); has(d, /a: Date;/); has(d, /b: Date;/); has(d, /c: string;/); has(d, /d: string;/);
});

// ---------- nullable handling ----------
test('null: union (default)', () => { has(gen([{ a: 'x' }, { a: null }]), /a: string \| null;/); has(gen({ a: null }), /a: null;/); });
test('null: optional mode drops null and marks optional', () => {
  const o = gen({ a: 'x', b: null, l: [1, null] }, { nullHandling: 'optional' });
  has(o, /a: string;/); has(o, /b\?: unknown;/); has(o, /l: number\[\];/);
  has(gen([{ a: 'x' }, { a: null }], { nullHandling: 'optional' }), /a\?: string;/);
});
test('null: omit mode drops null without optional', () => {
  const o = gen([{ a: 'x' }, { a: null }], { nullHandling: 'omit' }); has(o, /a: string;/); lacks(o, /null/);
});
test('null placed last in unions', () => has(gen([{ a: null }, { a: 1 }, { a: 's' }]), /a: number \| string \| null;/));

// ---------- unions of strings ----------
test('string unions: opt-in only', () => { const v = { s: ['a', 'b', 'a'] }; has(gen(v), /s: string\[\];/); has(gen(v, { stringUnions: true }), /s: \("a" \| "b"\)\[\];/); });
test('string unions: respects max distinct', () => {
  const v = { s: ['a', 'b', 'c', 'd', 'e', 'f'] };
  has(gen(v, { stringUnions: true, unionMax: 5 }), /s: string\[\];/);
  has(gen(v, { stringUnions: true, unionMax: 6 }), /s: \("a" \| "b" \| "c" \| "d" \| "e" \| "f"\)\[\];/);
});
test('string unions: across sample objects, not for single values or long text', () => {
  has(gen([{ st: 'on' }, { st: 'off' }, { st: 'on' }], { stringUnions: true }), /st: "on" \| "off";/);
  has(gen({ st: 'on' }, { stringUnions: true }), /st: string;/);
  has(gen({ t: ['x'.repeat(50), 'x'.repeat(50)] }, { stringUnions: true }), /t: string\[\];/);
  has(gen({ t: ['a\nb', 'a\nb'] }, { stringUnions: true }), /t: string\[\];/);
});
test('string unions: quotes escaped', () => {
  has(gen({ q: ['he said "x"', 'y'] }, { stringUnions: true }), /\("he said \\"x\\"" \| "y"\)\[\]/);
});

// ---------- index signatures ----------
test('index signature: numeric-like keys', () => {
  const o = gen({ m: { 1: { a: 1 }, 2: { a: 2 }, 3: { a: 3, b: 'x' } } }, { indexSignatureMin: 3 });
  has(o, /m: \{ \[key: string\]: M \};/); has(o, /interface M \{\n {2}a: number;\n {2}b\?: string;/);
});
test('index signature: off by default and below threshold', () => {
  const v = { m: { 1: 1, 2: 2, 3: 3 } };
  has(gen(v), /"1": number;/); has(gen(v, { indexSignatureMin: 4 }), /"1": number;/);
  has(gen({ m: { a: 1, 2: 2, 3: 3 } }, { indexSignatureMin: 3 }), /"2": number;/);
});
test('index signature at the root and readonly', () => {
  has(gen({ 1: 'a', 2: 'b', 3: 'c' }, { indexSignatureMin: 2 }), /export interface Root \{\n {2}\[key: string\]: string;\n\}/);
  has(gen({ m: { 1: 1, 2: 2 } }, { indexSignatureMin: 2, readonly: true }), /readonly \[key: string\]: number/);
});

// ---------- multiple samples / JSON Lines ----------
test('several documents separated by blank lines merge with optional fields', () => {
  const r = L.generate('{"id":1,"name":"a"}\n\n{"id":2,"email":"e"}\n\n{"id":3,"name":"c","email":null}');
  assert.equal(r.format, 'multi'); assert.equal(r.stats.samples, 3);
  has(r.code, /id: number;/); has(r.code, /name\?: string;/); has(r.code, /email\?: string \| null;/);
  assert.match(r.warnings[0], /3 JSON documents/);
});
test('JSON Lines', () => {
  const r = L.generate('{"a":1}\n{"a":2,"b":true}\n{"a":3}\n', { format: 'multi' });
  has(r.code, /a: number;\n {2}b\?: boolean;/); assert.equal(r.stats.samples, 3);
});
test('JSON Lines with an error reports the line', () => { const r = L.generate('{"a":1}\n{"a":}\n'); assert.equal(r.ok, false); assert.equal(r.error.line, 2); });
test('top-level array as samples', () => {
  const v = [{ a: 1 }, { a: 2, b: 'x' }];
  const merged = gen(v, { arrayAsSamples: true }); has(merged, /export interface Root \{\n {2}a: number;\n {2}b\?: string;/); lacks(merged, /RootItem/);
  has(gen(v), /RootItem\[\]/);
});
test('concatenated documents on one line', () => assert.equal(L.generate('{"a":1}{"a":2}').stats.samples, 2));
test('many samples keep counts: optional only if missing somewhere', () => {
  const docs = Array.from({ length: 50 }, (_, i) => JSON.stringify(i === 49 ? { a: 1 } : { a: 1, b: 2 })).join('\n');
  has(L.generate(docs).code, /b\?: number;/);
  const all = Array.from({ length: 50 }, () => '{"a":1,"b":2}').join('\n'); lacks(L.generate(all).code, /\?/);
});

// ---------- JSON Schema ----------
const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', title: 'Person', type: 'object', description: 'A person',
  required: ['name', 'age'],
  properties: {
    name: { type: 'string', description: 'Full name' }, age: { type: 'integer' }, email: { type: ['string', 'null'] },
    role: { enum: ['admin', 'user'] }, tags: { type: 'array', items: { type: 'string' } }, address: { $ref: '#/definitions/Address' },
    born: { type: 'string', format: 'date' }, flag: { const: true }, meta: { type: 'object', additionalProperties: { type: 'number' } },
    nested: { type: 'object', properties: { deep: { type: 'boolean' } }, required: ['deep'] },
    either: { oneOf: [{ type: 'string' }, { type: 'number' }] }, opt: { type: 'string', nullable: true },
  },
  definitions: { Address: { type: 'object', required: ['street'], properties: { street: { type: 'string' }, zip: { type: 'string' } } } },
};
test('schema: auto-detected via $schema and converted', () => {
  const r = L.generate(JSON.stringify(SCHEMA)); assert.equal(r.format, 'schema');
  has(r.code, /export interface Address \{\n {2}street: string;\n {2}zip\?: string;\n\}/);
  has(r.code, /export interface Root \{/);
  has(r.code, /\/\*\* Full name \*\/\n {2}name: string;/); has(r.code, /age: number;/); has(r.code, /email\?: string \| null;/);
  has(r.code, /role\?: "admin" \| "user";/); has(r.code, /tags\?: string\[\];/); has(r.code, /address\?: Address;/); has(r.code, /flag\?: true;/);
  has(r.code, /meta\?: \{ \[key: string\]: number \};/); has(r.code, /nested\?: Nested;/); has(r.code, /interface Nested \{\n {2}deep: boolean;/);
  has(r.code, /either\?: string \| number;/); has(r.code, /opt\?: string \| null;/); has(r.code, /\/\*\* A person \*\/\nexport interface Root/);
  assert.ok(r.code.indexOf('interface Address') < r.code.indexOf('interface Root'));
});
test('schema: forced via format, dates', () => {
  const r = L.generate(JSON.stringify({ type: 'object', properties: { d: { type: 'string', format: 'date-time' } } }), { format: 'schema', dateMode: 'Date' }); has(r.code, /d\?: Date;/);
});
test('schema: $defs, root $ref, enum alias and recursion', () => {
  const s = { $ref: '#/$defs/Node', $defs: { Node: { type: 'object', properties: { value: { type: 'number' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } }, Color: { enum: ['r', 'g'] } } };
  const r = L.generate(JSON.stringify(s), { format: 'schema' });
  has(r.code, /export interface Node \{\n {2}value\?: number;\n {2}children\?: Node\[\];/); has(r.code, /export type Color = "r" \| "g";/); has(r.code, /export type Root = Node;/);
});
test('schema: root #, allOf merge, anyOf, tuple, unresolved and remote refs warn', () => {
  const s = { type: 'object', properties: { self: { $ref: '#' }, x: { allOf: [{ $ref: '#/definitions/A' }, { properties: { b: { type: 'number' } }, required: ['b'] }] }, y: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    t: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] }, r: { $ref: 'http://x/y.json' }, u: { $ref: '#/definitions/Nope' }, p: { type: 'object', patternProperties: { '^a': { type: 'string' } } } },
  definitions: { A: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } } };
  const r = L.generate(JSON.stringify(s), { format: 'schema' });
  has(r.code, /self\?: Root;/); has(r.code, /interface X \{\n {2}a: string;\n {2}b: number;\n\}/); has(r.code, /y\?: string \| null;/); has(r.code, /t\?: \(string \| number\)\[\];/);
  has(r.code, /r\?: unknown;/); has(r.code, /u\?: unknown;/);
  const w = r.warnings.join('\n'); assert.match(w, /Only local/); assert.match(w, /could not be resolved/); assert.match(w, /patternProperties/); assert.match(w, /Tuple/);
});
test('schema: invalid shapes do not throw', () => { for (const s of ['[]', '"x"', '1', 'true', 'null']) { const r = L.generate(s, { format: 'schema' }); assert.ok(r.ok); assert.ok(r.warnings.length); } });
test('schema: odd property names', () => has(L.generate(JSON.stringify({ type: 'object', required: ['a-b'], properties: { 'a-b': { type: 'string' } } }), { format: 'schema' }).code, /"a-b": string;/));

// ---------- Zod target ----------
test('zod: basic object', () => {
  const o = gen({ s: 'x', n: 1, b: true, u: null, arr: [1], nested: { k: 1 } }, { target: 'zod' });
  assert.ok(o.startsWith('import { z } from "zod";'));
  has(o, /export const NestedSchema = z\.object\(\{\n {2}k: z\.number\(\),\n\}\);\nexport type Nested = z\.infer<typeof NestedSchema>;/);
  has(o, /export const RootSchema = z\.object\(\{\n {2}s: z\.string\(\),\n {2}n: z\.number\(\),\n {2}b: z\.boolean\(\),\n {2}u: z\.null\(\),\n {2}arr: z\.array\(z\.number\(\)\),\n {2}nested: NestedSchema,\n\}\);/);
  has(o, /export type Root = z\.infer<typeof RootSchema>;/);
});
test('zod: optional, nullable, unions, enum, dates, records', () => {
  const v = [{ a: 'x', b: 1, c: null, d: 'on', e: '2020-01-01', m: { 1: 1, 2: 2 } }, { a: 'y', b: 's', d: 'off', e: '2020-02-01', m: { 3: 3, 4: 4 } }];
  const o = gen(v, { target: 'zod', stringUnions: true, dateMode: 'Date', indexSignatureMin: 2, arrayAsSamples: true });
  has(o, /a: z\.enum\(\["x", "y"\]\),/); has(o, /b: z\.union\(\[z\.number\(\), z\.string\(\)\]\),/); has(o, /c: z\.null\(\)\.optional\(\),/); has(o, /d: z\.enum\(\["on", "off"\]\),/);
  has(o, /e: z\.coerce\.date\(\),/); has(o, /m: z\.record\(z\.string\(\), z\.number\(\)\),/);
  has(gen([{ a: 1 }, { a: null }], { target: 'zod' }), /a: z\.number\(\)\.nullable\(\),/);
  has(gen([{ a: 1 }, { a: null }, { a: 's' }], { target: 'zod' }), /a: z\.union\(\[z\.number\(\), z\.string\(\)\]\)\.nullable\(\),/);
  has(gen([{ a: 1, b: 1 }, { a: 1 }], { target: 'zod', optionalFromArrays: false }), /b: z\.number\(\)\.optional\(\),/);
});
test('zod: root array / primitives, quoted keys, readonly, no export', () => {
  has(gen([1, 2], { target: 'zod' }), /export const RootSchema = z\.array\(z\.number\(\)\);/);
  has(gen('"x"', { target: 'zod' }), /RootSchema = z\.string\(\);/);
  has(gen({ 'a-b': 1 }, { target: 'zod' }), /"a-b": z\.number\(\),/);
  has(gen({ a: [1] }, { target: 'zod', readonly: true }), /a: z\.array\(z\.number\(\)\)\.readonly\(\),\n\}\)\.readonly\(\);/);
  lacks(gen({ a: 1 }, { target: 'zod', exportKeyword: false }), /export/);
  has(gen({ s: ['a', 'a'] }, { target: 'zod', stringUnions: true }), /z\.array\(z\.literal\("a"\)\)/);
});
test('zod: from schema with descriptions, literals and recursion', () => {
  const r = L.generate(JSON.stringify(SCHEMA), { target: 'zod' });
  has(r.code, /name: z\.string\(\)\.describe\("Full name"\),/); has(r.code, /role: z\.enum\(\["admin", "user"\]\)\.optional\(\),/); has(r.code, /flag: z\.literal\(true\)\.optional\(\),/);
  has(r.code, /email: z\.string\(\)\.nullable\(\)\.optional\(\),/);
  const rec = L.generate(JSON.stringify({ $schema: 'x', type: 'object', properties: { next: { $ref: '#' } } }), { target: 'zod' });
  has(rec.code, /next: RootSchema\.optional\(\)|z\.lazy\(\(\) => RootSchema\)/);
});
test('zod: numeric enum from schema', () => has(L.generate(JSON.stringify({ type: 'object', required: ['n'], properties: { n: { enum: [1, 2] } } }), { format: 'schema', target: 'zod' }).code, /n: z\.union\(\[z\.literal\(1\), z\.literal\(2\)\]\),/));

// ---------- JSDoc target ----------
test('jsdoc: typedefs', () => {
  const o = gen({ s: 'x', n: null, arr: [{ id: 1 }, { id: 2, t: 'x' }], nested: { k: [1, 'a'] } }, { target: 'jsdoc' });
  has(o, /\/\*\*\n \* @typedef \{Object\} Arr\n \* @property \{number\} id\n \* @property \{string\} \[t\]\n \*\//);
  has(o, /@property \{Array<Arr>\} arr/); has(o, /@property \{null\} n/); has(o, /@property \{Array<number\|string>\} k/); has(o, /@typedef \{Object\} Root/);
});
test('jsdoc: root alias, index, literals, unknown, quoted names, descriptions', () => {
  has(gen([1, 2], { target: 'jsdoc' }), /\/\*\* @typedef \{Array<number>\} Root \*\//);
  has(gen({ m: { 1: 1, 2: 2 } }, { target: 'jsdoc', indexSignatureMin: 2 }), /@property \{Object<string, number>\} m/);
  has(gen({ e: [] }, { target: 'jsdoc' }), /@property \{Array<\*>\} e/); has(gen({ 'a b': 1 }, { target: 'jsdoc' }), /@property \{number\} "a b"/);
  has(gen({ s: ['x', 'x'] }, { target: 'jsdoc', stringUnions: true }), /Array<"x">/);
  const r = L.generate(JSON.stringify(SCHEMA), { target: 'jsdoc' }); has(r.code, /@property \{string\} name - Full name/); has(r.code, /@property \{number\} age/); has(r.code, /@property \{string\|null\} \[email\]/);
});
test('jsdoc: readonly warns', () => assert.match(L.generate('{"a":1}', { target: 'jsdoc', readonly: true }).warnings.join(), /readonly/));
test('all targets produce balanced braces', () => {
  for (const t of ['typescript', 'zod', 'jsdoc']) { const c = gen(SAMPLES[3], { target: t }); assert.equal(c.split('{').length, c.split('}').length, t); }
});

// ---------- stats / misc ----------
test('stats', () => { const r = L.generate('[{"a":1,"b":2},{"a":1}]'); assert.equal(r.stats.declarations, 2); assert.equal(r.stats.properties, 2); assert.equal(r.stats.optional, 1); assert.equal(r.stats.samples, 1); });
test('fileExtension', () => { assert.equal(L.fileExtension('jsdoc'), 'js'); assert.equal(L.fileExtension('zod'), 'ts'); assert.equal(L.fileExtension('typescript', 'dts'), 'd.ts'); });
test('deep nesting: 150 levels inferred; 250 levels degrade to unknown with a warning', () => {
  const nest = n => { let s = '1'; for (let i = 0; i < n; i++) s = `{"a":${s}}`; return s; };
  const r1 = L.generate(nest(150)); assert.ok(r1.ok); assert.equal(r1.warnings.length, 0);
  const r2 = L.generate(nest(250)); assert.ok(r2.ok); assert.match(r2.warnings.join(), /deeper than 200/);
});
test('large input (>= 1 MB) is handled quickly', () => {
  const rows = []; for (let i = 0; i < 12000; i++) rows.push({ id: i, name: 'user ' + i, email: i % 3 ? `u${i}@x.io` : null, tags: ['a', 'b'], profile: { age: i % 90, city: 'Zürich 😀', ...(i % 7 ? {} : { vip: true }) }, created: '2020-01-01T00:00:00Z' });
  const text = JSON.stringify(rows); assert.ok(text.length >= 1_000_000, String(text.length));
  const t0 = Date.now(); const r = L.generate(text, { stringUnions: true, dateMode: 'Date' });
  assert.ok(r.ok); has(r.code, /vip\?: boolean;/); has(r.code, /email: string \| null;/); has(r.code, /created: Date;/); assert.ok(Date.now() - t0 < 5000, 'slow ' + (Date.now() - t0));
  const jl = rows.map(x => JSON.stringify(x)).join('\n'); const r2 = L.generate(jl); assert.equal(r2.format, 'multi'); assert.equal(r2.stats.samples, 12000);
});
test('large input: invalid JSON deep in a big document reports the right position', () => {
  const rows = []; for (let i = 0; i < 20000; i++) rows.push(`{"id":${i},"name":"user number ${i}"}`);
  const text = '[\n' + rows.join(',\n') + ',\n{"id": }\n]';
  assert.ok(text.length > 600000); const r = L.generate(text); assert.equal(r.ok, false); assert.equal(r.error.line, 20002); assert.equal(r.error.column, 8);
});
test('generated TypeScript identifiers are valid', () => {
  const o = gen({ '9lives': { 'a-b': { class: { x: 1 } } }, '': { y: 1 }, 'ünï': { z: 1 } });
  for (const m of o.matchAll(/interface (\S+) \{/g)) assert.match(m[1], /^[A-Za-z_$][A-Za-z0-9_$]*$/);
});

console.log(`ts-interface-generator: ${pass} tests passed`);
