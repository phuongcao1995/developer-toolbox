// Run: node tests/unit/ts-interfaces.test.mjs
import assert from 'node:assert/strict';
import { jsonToTypeScript as ts, toPascalCase } from '../../assets/js/shared/ts-interfaces.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const has = (out, re) => assert.match(out, re, out);
const lacks = (out, re) => assert.doesNotMatch(out, re, out);

test('simple object with primitives', () => {
  const out = ts({ a: 1, b: 'x', c: true, d: null });
  has(out, /export interface Root \{\n {2}a: number;\n {2}b: string;\n {2}c: boolean;\n {2}d: null;\n\}/);
});
test('JSON text input; invalid text throws', () => {
  has(ts('{"n": 12345678901234567890}'), /n: number;/);
  assert.throws(() => ts('{bad'), SyntaxError);
});
test('nested objects become named interfaces (PascalCase)', () => {
  const out = ts({ user_profile: { first_name: 'a', 'home-address': { zip: '1' } } });
  has(out, /export interface HomeAddress \{\n {2}zip: string;/);
  has(out, /export interface UserProfile \{\n {2}first_name: string;\n {2}"home-address": HomeAddress;/);
  has(out, /export interface Root \{\n {2}user_profile: UserProfile;/);
  assert.ok(out.indexOf('interface HomeAddress') < out.indexOf('interface UserProfile') && out.indexOf('interface UserProfile') < out.indexOf('interface Root'));
});
test('quoted keys for non-identifiers (numeric, spaces, dashes, empty)', () => {
  const out = ts({ '1a': 1, 'a b': 2, 'a-b': 3, '': 4, ok_$: 5, 'class': 6 });
  for (const k of ['"1a"', '"a b"', '"a-b"', '""']) has(out, new RegExp(`  ${k.replace(/[$]/g, '\\$')}: number;`));
  has(out, /ok_\$: number;/); has(out, /class: number;/);
});
test('arrays: element type, empty arrays, mixed unions, null', () => {
  has(ts({ a: [] }), /a: unknown\[\];/);
  has(ts({ a: [1, 2] }), /a: number\[\];/);
  has(ts({ a: [1, 'x', true] }), /a: \(number \| string \| boolean\)\[\];/);
  has(ts({ a: [1, null] }), /a: \(number \| null\)\[\];/);
  has(ts({ a: [[1], ['x']] }), /a: \(number \| string\)\[\]\[\];/);
  has(ts({ a: [[], [1]] }), /a: number\[\]\[\];/);
  has(ts({ a: null }), /a: null;/);
});
test('array element objects are merged; missing properties become optional', () => {
  const out = ts({ items: [{ id: 1, name: 'a' }, { id: 2, tag: 'x' }] });
  has(out, /export interface Item \{\n {2}id: number;\n {2}name\?: string;\n {2}tag\?: string;\n\}/);
  has(out, /items: Item\[\];/);
});
test('property types merge into unions across elements', () => {
  const out = ts([{ v: 1 }, { v: 'x' }, { v: null }]);
  has(out, /v: number \| string \| null;/);
});
test('root array and root primitive', () => {
  const out = ts([{ a: 1 }]);
  has(out, /export interface RootItem \{\n {2}a: number;\n\}/); has(out, /export type Root = RootItem\[\];/);
  has(ts('"hello"'), /export type Root = string;/);
  has(ts([]), /export type Root = unknown\[\];/);
  has(ts(null), /export type Root = null;/);
});
test('structurally identical interfaces are deduplicated', () => {
  const out = ts({ home: { x: 1, y: 2 }, work: { x: 3, y: 4 }, other: { x: 'a' } });
  assert.equal((out.match(/interface /g) || []).length, 3); // Home (shared), Other, Root
  has(out, /home: Home;/); has(out, /work: Home;/);
});
test('name collisions get suffixes; reserved names avoided', () => {
  const out = ts({ a: { item: { x: 1 } }, b: { item: { y: 1 } } });
  has(out, /interface Item \{\n {2}x: number;/); has(out, /interface Item2 \{\n {2}y: number;/);
  const r = ts({ date: { v: 1 }, string: { v: 'x' }, array: { z: 1 } });
  lacks(r, /interface (Date|String|Array) /); has(r, /interface DateType/);
  const c = ts({ root: { a: 1 } }); has(c, /interface Root2 \{/); has(c, /export interface Root \{\n {2}root: Root2;/);
});
test('option: rootName, exportKeyword, useInterface', () => {
  const out = ts({ a: { b: 1 } }, { rootName: 'my-doc', exportKeyword: false, useInterface: false });
  has(out, /^type A = \{/m); has(out, /^type MyDoc = \{\n {2}a: A;\n\};/m); lacks(out, /export/); lacks(out, /interface/);
  has(ts({ a: 1 }, { rootName: 'Thing' }), /export interface Thing \{/);
  has(ts({ a: 1 }, { rootName: '123' }), /interface T123 \{/);
});
test('option: readonly', () => {
  const out = ts({ a: [1], b: [{ x: 1 }], c: 'x' }, { readonly: true });
  has(out, /readonly a: readonly number\[\];/); has(out, /readonly b: readonly B\[\];/); has(out, /readonly c: string;/);
  has(ts({ a: [1, 'x'] }, { readonly: true }), /readonly a: readonly \(number \| string\)\[\];/);
});
test('option: optionalFromArrays=false uses | undefined', () => {
  const out = ts([{ a: 1 }, { b: 2 }], { optionalFromArrays: false });
  has(out, /a: number \| undefined;/); lacks(out, /\?:/);
});
test('option: dateAsString', () => {
  has(ts({ d: '2024-01-02T03:04:05Z' }), /d: string;/);
  has(ts({ d: '2024-01-02T03:04:05Z', e: 'hello' }, { dateAsString: false }), /d: Date;\n {2}e: string;/);
});
test('option: mergeArrayShapes=false keeps distinct shapes as a union', () => {
  const out = ts({ xs: [{ a: 1 }, { b: 2 }] }, { mergeArrayShapes: false });
  has(out, /xs: \(Xs1 \| Xs2\)\[\];/); has(out, /interface Xs1 \{\n {2}a: number;/); has(out, /interface Xs2 \{\n {2}b: number;/);
  assert.equal((ts({ xs: [{ a: 1 }, { a: 2 }] }, { mergeArrayShapes: false }).match(/interface /g) || []).length, 2);
});
test('null and object union in arrays', () => {
  has(ts({ xs: [{ a: 1 }, null] }), /xs: \(Xs \| null\)\[\];/);
});
test('unicode, big and odd values do not break output', () => {
  has(ts({ 'héllo': 1, '\u{1F600}': 2, 'a"b': 3 }), /"a\\"b": number;/);
  has(ts({ n: 1e400 === Infinity ? 1 : 0 }), /n: number;/);
  const deep = JSON.parse('['.repeat(150) + '1' + ']'.repeat(150));
  assert.ok(ts(deep).startsWith('export type Root ='));
});
test('toPascalCase', () => {
  assert.equal(toPascalCase('user_name'), 'UserName'); assert.equal(toPascalCase('user-name'), 'UserName');
  assert.equal(toPascalCase('userName'), 'UserName'); assert.equal(toPascalCase('9lives'), 'T9lives'); assert.equal(toPascalCase('@@'), 'Item');
});
test('output is stable (deterministic) and ends with newline', () => {
  const v = { a: [{ b: 1 }, { c: [1, 'x'] }], d: { e: null } };
  assert.equal(ts(v), ts(JSON.parse(JSON.stringify(v)))); assert.ok(ts(v).endsWith('}\n'));
});

console.log(`ts-interfaces: ${pass} passed`);
