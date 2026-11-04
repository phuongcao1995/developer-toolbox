// Run: node tests/unit/url-encoder.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/url-encoder/logic.js';
let pass = 0;
const test = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };
const rebuild = (u, edit) => { const r = L.parseUrl(u); if (edit) edit(r.params); return L.buildUrl(r.fields, r.params); };

test('pristine rebuild keeps bytes', () => {
  for (const u of ['https://e.com/p?a=1;b=2&c=/x:y,z#f/g:h', 'https://e.com/p?', 'https://e.com/p#', 'https://e.com/p?a=%zz&b=%E4#x', 'https://e.com/p?a=1&&b=2'])
    assert.equal(rebuild(u), u, u);
});
test('edit re-encodes only edited pairs', () => {
  const out = rebuild('https://e.com/p?a=1;b=/x:y,z&c=%zz&d=1#h', ps => { ps[2].value = 'v w'; ps[2].dirty = true; });
  assert.equal(out, 'https://e.com/p?a=1;b=/x:y,z&c=%zz&d=v%20w#h');
});
test('delete and add keep untouched pairs raw', () => {
  assert.equal(rebuild('https://e.com/?a=/&b=2', ps => ps.splice(1, 1)), 'https://e.com/?a=/');
  assert.equal(rebuild('https://e.com/?a=/', ps => ps.push({ key: 'k', value: 'é', hasEq: true, dirty: true })), 'https://e.com/?a=/&k=%C3%A9');
});
test('decode errors name sequence and offset', () => {
  assert.throws(() => L.decodeComponent('ab%zzc'), /"%zz" at position 3/);
  assert.throws(() => L.decodeComponent('ok %E4 x'), /"%E4 x" at position 4|%E4/);
  assert.throws(() => L.decodeFull('a%'), /position 2/);
});
test('encode/decode roundtrip', () => {
  assert.equal(L.decodeComponent(L.encodeComponent('a b&é', { form: true }), { form: true }), 'a b&é');
});
console.log(`url-encoder: ${pass} passed`);
