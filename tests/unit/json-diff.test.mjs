// Run: node tests/unit/json-diff.test.mjs
import assert from 'node:assert/strict';
import { diffJson, toJsonPatch, toText, canonical, MARKERS } from '../../assets/js/shared/json-diff.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const clone = v => JSON.parse(JSON.stringify(v));

// Minimal RFC 6902 applier (add/remove/replace) used to prove that patches reproduce B.
function apply(doc, ops) {
  doc = clone(doc);
  const seg = p => p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const op of ops) {
    const parts = seg(op.path);
    if (!parts.length) { assert.equal(op.op, 'replace'); doc = clone(op.value); continue; }
    let parent = doc;
    for (let i = 0; i < parts.length - 1; i++) { parent = parent[parts[i]]; assert.ok(parent !== undefined, 'bad path ' + op.path); }
    const last = parts[parts.length - 1];
    if (Array.isArray(parent)) {
      const idx = last === '-' ? parent.length : Number(last);
      if (op.op === 'add') parent.splice(idx, 0, clone(op.value));
      else if (op.op === 'remove') { assert.ok(idx < parent.length, 'remove out of range ' + op.path); parent.splice(idx, 1); }
      else { assert.ok(idx < parent.length); parent[idx] = clone(op.value); }
    } else if (op.op === 'remove') { assert.ok(last in parent, 'remove missing ' + op.path); delete parent[last]; }
    else { if (op.op === 'replace') assert.ok(last in parent, 'replace missing ' + op.path); parent[last] = clone(op.value); }
  }
  return doc;
}
const norm = v => Array.isArray(v) ? v.map(norm).sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1)) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v;

test('identical values and key-order insensitivity', () => {
  assert.equal(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }).equal, true);
  assert.equal(diffJson(1, 1).changes.length, 0);
  assert.equal(diffJson(null, null).equal, true);
});
test('added / removed / changed / type-changed with pointers', () => {
  const d = diffJson({ a: 1, b: 2, c: 'x', d: [1] }, { a: 1, b: 3, e: true, c: 5, d: { k: 1 } });
  const by = k => d.changes.filter(c => c.kind === k);
  assert.deepEqual(by('changed').map(c => [c.path, c.before, c.after]), [['/b', 2, 3]]);
  assert.deepEqual(by('added').map(c => [c.path, c.after]), [['/e', true]]);
  assert.deepEqual(by('type-changed').map(c => c.path).sort(), ['/c', '/d']);
  assert.deepEqual(d.counts, { added: 1, removed: 0, changed: 1, 'type-changed': 2 });
  assert.equal(diffJson({ x: 1 }, {}).changes[0].kind, 'removed');
});
test('type changes: null vs object, array vs object, number vs string', () => {
  assert.equal(diffJson(null, {}).changes[0].kind, 'type-changed');
  assert.equal(diffJson([], {}).changes[0].kind, 'type-changed');
  assert.equal(diffJson(1, '1').changes[0].kind, 'type-changed');
  assert.equal(diffJson(1, 1.5).changes[0].kind, 'changed');
  assert.equal(diffJson(1, 2).changes[0].path, '');
});
test('pointer escaping of ~ and /', () => {
  const d = diffJson({ 'a/b': 1, 'm~n': 1 }, { 'a/b': 2, 'm~n': 2 });
  assert.deepEqual(d.changes.map(c => c.path).sort(), ['/a~1b', '/m~0n']);
});
test('arrays by index (default)', () => {
  const d = diffJson([1, 2, 3], [1, 9]);
  assert.deepEqual(d.changes.map(c => [c.kind, c.path]), [['changed', '/1'], ['removed', '/2']]);
  const d2 = diffJson([1], [1, 2, 3]);
  assert.deepEqual(d2.changes.map(c => [c.kind, c.path]), [['added', '/1'], ['added', '/2']]);
  assert.equal(diffJson([[1, 2]], [[1, 3]]).changes[0].path, '/0/1');
});
test('arrays matched by identity key', () => {
  const a = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }];
  const b = [{ id: 3, n: 'c' }, { id: 2, n: 'B' }, { id: 4, n: 'd' }];
  const d = diffJson(a, b, { arrayMode: 'key', key: 'id' });
  assert.deepEqual(d.changes.map(c => [c.kind, c.path]).sort(), [['added', '/-'], ['changed', '/1/n'], ['removed', '/0']].sort());
  // index mode would report much more noise
  assert.ok(diffJson(a, b).changes.length > d.changes.length);
});
test('arrays ignoring order', () => {
  assert.equal(diffJson([1, 2, { a: 1, b: 2 }], [{ b: 2, a: 1 }, 2, 1], { arrayMode: 'unordered' }).equal, true);
  const d = diffJson([1, 2, 2, 3], [2, 3, 4], { arrayMode: 'unordered' });
  assert.deepEqual(d.counts, { added: 1, removed: 2, changed: 0, 'type-changed': 0 });
});
test('JSON Patch reproduces B (index mode, exact)', () => {
  const cases = [
    [{ a: 1, b: [1, 2, 3], c: { d: 1 } }, { a: 2, b: [1, 2], c: {}, z: 1 }],
    [[1, 2, 3, 4, 5], [1, 2]],
    [[1], [1, 2, 3]],
    [{ l: [{ x: 1 }, { x: 2 }, { x: 3 }] }, { l: [{ x: 1 }] }],
    [1, 'two'],
    [{ a: null }, { a: [1] }],
    [{ 'a/b': { 'c~d': [1, 2] } }, { 'a/b': { 'c~d': [1, 3, 4] } }],
  ];
  for (const [a, b] of cases) assert.deepEqual(apply(a, toJsonPatch(diffJson(a, b).changes)), b, JSON.stringify([a, b]));
});
test('JSON Patch for key / unordered mode reproduces B up to element order', () => {
  const a = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }, { id: 5, n: 'e' }];
  const b = [{ id: 3, n: 'C' }, { id: 4, n: 'd' }, { id: 2, n: 'b' }];
  const ops = toJsonPatch(diffJson(a, b, { arrayMode: 'key', key: 'id' }).changes);
  assert.deepEqual(norm(apply(a, ops)), norm(b));
  const u1 = [1, 2, 3, 3, { a: 1 }], u2 = [3, { a: 1 }, 4, 1];
  assert.deepEqual(norm(apply(u1, toJsonPatch(diffJson(u1, u2, { arrayMode: 'unordered' }).changes))), norm(u2));
});
test('patch op names and values', () => {
  const ops = toJsonPatch(diffJson({ a: 1, b: 1 }, { a: 2, c: 3 }).changes);
  assert.deepEqual(ops.map(o => o.op).sort(), ['add', 'remove', 'replace']);
  assert.deepEqual(ops.find(o => o.op === 'replace'), { op: 'replace', path: '/a', value: 2 });
  assert.deepEqual(ops.find(o => o.op === 'remove'), { op: 'remove', path: '/b' });
});
test('text output uses +, -, ~ markers (not colour only)', () => {
  const t = toText(diffJson({ a: 1, b: 2, c: 1 }, { a: 2, c: '1', d: 4 }).changes);
  assert.match(t, /^~ \/a {2}changed: 1 -> 2$/m);
  assert.match(t, /^- \/b {2}removed: 2$/m);
  assert.match(t, /^\+ \/d {2}added: 4$/m);
  assert.match(t, /^~ \/c {2}type changed \(number -> string\)/m);
  assert.equal(MARKERS.added, '+'); assert.equal(MARKERS.removed, '−'); assert.equal(MARKERS.changed, '~');
});
test('guards: maxChanges truncates, maxDepth compares subtree as a whole', () => {
  const a = Array.from({ length: 100 }, (_, i) => i), b = a.map(x => x + 1);
  const d = diffJson(a, b, { maxChanges: 10 });
  assert.equal(d.changes.length, 10); assert.equal(d.truncated, true); assert.equal(d.equal, false);
  const d2 = diffJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, { maxDepth: 2 });
  assert.deepEqual(d2.changes.map(c => c.path), ['/a/b']);
});
test('very deep documents do not overflow the stack', () => {
  let x = 1, y = 2;
  for (let i = 0; i < 100000; i++) { x = [x]; y = [y]; }
  const d = diffJson(x, y); // maxDepth guard stops descent
  assert.equal(d.changes.length, 1);
});
test('canonical: key order independent, distinguishes types', () => {
  assert.equal(canonical({ a: 1, b: [1, { c: 2, d: 3 }] }), canonical({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(canonical(1), canonical('1'));
});
test('__proto__ keys are handled as plain data', () => {
  const a = JSON.parse('{"__proto__":{"x":1}}'), b = JSON.parse('{"__proto__":{"x":2}}');
  assert.deepEqual(diffJson(a, b).changes.map(c => c.path), ['/__proto__/x']);
});

console.log(`json-diff: ${pass} passed`);
