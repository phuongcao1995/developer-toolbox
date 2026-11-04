// Run: node tests/unit/jsonpath.test.mjs
import assert from 'node:assert/strict';
import { query, parse, formatPath, JSONPathError, MAX_RESULTS } from '../../assets/js/shared/jsonpath.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const vals = (d, q) => query(d, q).map(r => r.value);
const paths = (d, q) => query(d, q).map(r => r.path);

const store = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings', price: 8.95, tag: 'x' },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', price: 8.99, tag: 'x' },
      { category: 'fiction', author: 'Tolkien', title: 'Rings', price: 22.99, tag: 'y' },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  'odd key': { 'a.b': 1 },
};

test('root and child names', () => {
  assert.deepEqual(vals(store, '$.store.bicycle.color'), ['red']);
  assert.deepEqual(paths(store, '$.store.bicycle.color'), ['$.store.bicycle.color']);
  assert.equal(query(store, '$').length, 1);
});
test('bracket names incl. quotes and escapes', () => {
  assert.deepEqual(vals(store, "$['odd key']['a.b']"), [1]);
  assert.deepEqual(vals(store, '$["odd key"]["a.b"]'), [1]);
  assert.deepEqual(paths(store, "$['odd key']['a.b']"), ["$['odd key']['a.b']"]);
  assert.deepEqual(vals({ "it's": 5 }, "$['it\\'s']"), [5]);
});
test('indices incl negative and out of range', () => {
  assert.equal(vals(store, '$.store.book[0].title')[0], 'Sayings');
  assert.equal(vals(store, '$.store.book[-1].title')[0], 'Rings');
  assert.deepEqual(vals(store, '$.store.book[10]'), []);
  assert.deepEqual(vals(store, '$.store.book[-10]'), []);
  assert.deepEqual(paths(store, '$.store.book[1].price'), ['$.store.book[1].price']);
});
test('slices', () => {
  const a = [0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(vals(a, '$[1:3]'), [1, 2]);
  assert.deepEqual(vals(a, '$[:2]'), [0, 1]);
  assert.deepEqual(vals(a, '$[5:]'), [5, 6]);
  assert.deepEqual(vals(a, '$[::2]'), [0, 2, 4, 6]);
  assert.deepEqual(vals(a, '$[-2:]'), [5, 6]);
  assert.deepEqual(vals(a, '$[::-1]'), [6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(vals(a, '$[5:1:-2]'), [5, 3]);
  assert.deepEqual(vals(a, '$[::0]'), []);
  assert.deepEqual(vals(a, '$[10:20]'), []);
});
test('wildcard on arrays and objects', () => {
  assert.equal(query(store, '$.store.book[*]').length, 4);
  assert.deepEqual(vals({ a: 1, b: 2 }, '$.*'), [1, 2]);
  assert.deepEqual(vals({ a: 1 }, '$.a.*'), []);
});
test('recursive descent', () => {
  assert.deepEqual(vals(store, '$..author'), ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'Tolkien']);
  assert.equal(vals(store, '$..price').length, 5);
  assert.deepEqual(vals({ a: { b: 1 } }, '$..*'), [{ b: 1 }, 1]);
  assert.deepEqual(vals([[1, 2], [3]], '$..[0]'), [[1, 2], 1, 3]);
  assert.deepEqual(vals({ a: [{ k: 1 }, { k: 2 }] }, '$..k'), [1, 2]);
});
test('union selectors', () => {
  assert.deepEqual(vals({ a: 1, b: 2, c: 3 }, "$['a','c']"), [1, 3]);
  assert.deepEqual(vals([10, 20, 30], '$[0,2]'), [10, 30]);
  assert.deepEqual(vals([10, 20, 30, 40], '$[0:2, 3]'), [10, 20, 40]);
});
test('filters: comparison', () => {
  assert.deepEqual(vals(store, '$.store.book[?(@.price < 10)].title'), ['Sayings', 'Moby Dick']);
  assert.deepEqual(vals(store, '$.store.book[?@.price >= 22.99].title'), ['Rings']);
  assert.deepEqual(vals(store, "$.store.book[?(@.category == 'reference')].author"), ['Nigel Rees']);
  assert.deepEqual(vals(store, "$.store.book[?(@.category != 'fiction')].author"), ['Nigel Rees']);
});
test('filters: && || ! and parentheses', () => {
  assert.deepEqual(vals(store, "$.store.book[?(@.price < 10 && @.tag == 'x')].title"), ['Sayings', 'Moby Dick']);
  assert.deepEqual(vals(store, "$.store.book[?(@.price > 20 || @.category == 'reference')].title"), ['Sayings', 'Rings']);
  assert.deepEqual(vals(store, '$.store.book[?(!@.tag)].title'), ['Sword']);
  assert.deepEqual(vals(store, "$.store.book[?((@.price < 9 || @.price > 20) && @.tag == 'y')].title"), ['Rings']);
});
test('filters: existence, in, regex, literals', () => {
  assert.deepEqual(vals(store, '$.store.book[?(@.tag)].title'), ['Sayings', 'Moby Dick', 'Rings']);
  assert.deepEqual(vals(store, "$.store.book[?(@.tag in ['y','z'])].title"), ['Rings']);
  assert.deepEqual(vals(store, '$.store.book[?(@.author =~ /^Her/)].title'), ['Moby Dick']);
  assert.deepEqual(vals(store, '$.store.book[?(@.author =~ /tolkien/i)].title'), ['Rings']);
  assert.deepEqual(vals([{ a: true }, { a: null }, { a: false }], '$[?(@.a == null)]'), [{ a: null }]);
  assert.deepEqual(vals([{ a: true }, { a: false }], '$[?(@.a == true)]'), [{ a: true }]);
  assert.deepEqual(vals([{ n: 1 }, { n: 2 }], '$[?(@.n == 2)].n'), [2]);
  assert.deepEqual(vals([{ n: 'a' }, { n: 5 }], '$[?(@.n > 1)].n'), [5]); // type mismatch is false, no throw
});
test('filters on objects, nested @ and $ references, length()', () => {
  assert.deepEqual(vals({ a: { v: 1 }, b: { v: 5 } }, '$[?(@.v > 2)]'), [{ v: 5 }]);
  assert.deepEqual(vals({ lim: 5, xs: [{ v: 1 }, { v: 9 }] }, '$.xs[?(@.v > $.lim)]'), [{ v: 9 }]);
  assert.deepEqual(vals([{ t: 'ab' }, { t: 'abcd' }], '$[?(length(@.t) > 2)].t'), ['abcd']);
  assert.equal(vals([{ k: [1, 2] }, { k: [] }], '$[?(count(@.k[*]) == 2)]').length, 1);
  assert.deepEqual(vals([{ a: [{ b: 1 }] }, { a: [{ b: 2 }] }], '$[?(@.a[?(@.b == 2)])]'), [{ a: [{ b: 2 }] }]);
});
test('result paths are formatted for the tree', () => {
  assert.equal(formatPath(['a', 0, 'b c', "d'e"]), "$.a[0]['b c']['d\\'e']");
  assert.deepEqual(query(store, '$.store.book[2].title')[0].segments, ['store', 'book', 2, 'title']);
});
test('own properties only (no prototype leak)', () => {
  assert.deepEqual(vals({}, '$.constructor'), []);
  assert.deepEqual(vals({}, "$['__proto__']"), []);
  assert.deepEqual(vals([], '$.length'), []);
});
test('errors carry a position', () => {
  const bad = (q, re) => {
    try { query({}, q); assert.fail('no throw: ' + q); } catch (e) {
      assert.ok(e instanceof JSONPathError, q + ' -> ' + e);
      assert.equal(typeof e.position, 'number');
      if (re) assert.match(e.message, re);
    }
  };
  bad('store', /start with '\$'/);
  bad('$.', /member name/);
  bad('$[', /Missing|Unexpected/);
  bad("$['a", /Unterminated/);
  bad('$[?(@.a ==)]', /Unexpected/);
  bad('$[?(@.a == 1]', /Expected '\)'/);
  bad('$[?(foo(@.a))]', /Unknown function/);
  bad('$[?(@.a =~ /(/)]', /regular expression/);
  bad('$.a b', /Unexpected character/);
  assert.equal(new JSONPathError('x', 7).position, 7);
  try { parse('$.a[?(@.x ~ 1)]'); assert.fail('should throw'); } catch (e) { assert.ok(e.position >= 8); }
});
test('results are capped at 10000 and flagged', () => {
  const big = Array.from({ length: 12000 }, (_, i) => i);
  const r = query(big, '$[*]');
  assert.equal(r.length, MAX_RESULTS); assert.equal(r.truncated, true);
  const r2 = query(big, '$..*');
  assert.equal(r2.length, MAX_RESULTS); assert.equal(r2.truncated, true);
  assert.equal(query([1, 2], '$[*]').truncated, false);
});
test('deep documents do not overflow; depth limit flagged', () => {
  let v = { x: 1 }; for (let i = 0; i < 5000; i++) v = { c: v };
  const r = query(v, '$..x');
  assert.equal(r.depthLimited, true);
  let w = { x: 1 }; for (let i = 0; i < 300; i++) w = { c: w };
  assert.equal(query(w, '$..x').length, 1);
});
test('no code execution: expressions are only parsed', () => {
  globalThis.__pwn = 0;
  assert.throws(() => query({}, '$[?(globalThis.__pwn = 1)]'), JSONPathError);
  assert.throws(() => query({}, '$[?(@.a == (globalThis.__pwn = 1))]'), JSONPathError);
  assert.equal(globalThis.__pwn, 0);
});
test('whitespace tolerance and unicode names', () => {
  assert.deepEqual(vals({ 'é': 1 }, '$.é'), [1]);
  assert.deepEqual(vals([1, 2, 3], '$[ 0 , 1 ]'), [1, 2]);
  assert.equal(vals([{ a: 1 }], '$[?( @.a == 1 )]').length, 1);
});

console.log(`jsonpath: ${pass} passed`);
