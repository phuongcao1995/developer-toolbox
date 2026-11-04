// Structural JSON diff. Pure ES module, no dependencies.
//
// diffJson(a, b, opts) -> { changes, counts, truncated }
//   change = { kind: 'added'|'removed'|'changed'|'type-changed', path: '/json/pointer', before?, after? }
//   opts.arrayMode: 'index' (default) | 'key' (match elements by opts.key, e.g. 'id') | 'unordered' (multiset, ignores order)
//   opts.key: identity key for arrayMode 'key'
//   opts.maxDepth (default 200): deeper subtrees are compared as a whole
//   opts.maxChanges (default 5000): stop and set truncated
// Objects are key-order insensitive. Paths of matched array elements use the index in A (index in B for additions
// in 'index' mode), which is what toJsonPatch() relies on.
// toJsonPatch(changes) -> RFC 6902 ops (add / remove / replace), ordered so that applying them sequentially to A gives B
//   (exact for 'index' mode; for 'key' / 'unordered' modes added elements are appended with "/-", so element ORDER of B
//   is not reproduced, only its content).

const own = Object.prototype.hasOwnProperty;
const isObj = v => v !== null && typeof v === 'object';
export const typeName = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const esc = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

/** Canonical string of a value: sorted object keys. Depth/size safe (falls back to a type tag when too deep). */
let deepSeq = 0;
export function canonical(v, depth = 0) {
  if (!isObj(v)) return JSON.stringify(v) ?? 'undefined';
  if (depth > 500) return `"~too-deep-${++deepSeq}~"`; // never equal to anything: too deep to compare, so never hide a difference
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x, depth + 1)).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k], depth + 1)).join(',') + '}';
}

/** Iterative structural equality (key-order independent); safe for any depth. */
function equalSafe(a, b) {
  const stack = [[a, b]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x === y) continue;
    if (!isObj(x) || !isObj(y) || Array.isArray(x) !== Array.isArray(y)) { if (Number.isNaN(x) && Number.isNaN(y)) continue; return false; }
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    for (const k of kx) { if (!own.call(y, k)) return false; stack.push([x[k], y[k]]); }
  }
  return true;
}

export function diffJson(a, b, opts = {}) {
  const mode = opts.arrayMode || 'index';
  const key = opts.key || 'id';
  const maxDepth = opts.maxDepth ?? 200, maxChanges = opts.maxChanges ?? 5000;
  const changes = [];
  let truncated = false;
  const push = c => { if (changes.length >= maxChanges) { truncated = true; return false; } changes.push(c); return true; };

  // iterative with explicit stack so deep documents cannot overflow; tasks are processed in order.
  const stack = [{ a, b, path: '', depth: 0 }];
  while (stack.length && !truncated) {
    const task = stack.pop();
    if (task.emit) { push(task.emit); continue; }
    const { a: x, b: y, path, depth } = task;
    const tx = typeName(x), ty = typeName(y);
    if (tx !== ty) { push({ kind: 'type-changed', path, before: x, after: y }); continue; }
    if (!isObj(x)) { if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) push({ kind: 'changed', path, before: x, after: y }); continue; }
    if (depth >= maxDepth) { if (!equalSafe(x, y)) push({ kind: 'changed', path, before: x, after: y }); continue; }
    const next = [];
    if (tx === 'object') {
      for (const k of Object.keys(x)) {
        if (!own.call(y, k)) next.push({ emit: { kind: 'removed', path: `${path}/${esc(k)}`, before: x[k] } });
        else next.push({ a: x[k], b: y[k], path: `${path}/${esc(k)}`, depth: depth + 1 });
      }
      for (const k of Object.keys(y)) if (!own.call(x, k)) next.push({ emit: { kind: 'added', path: `${path}/${esc(k)}`, after: y[k] } });
    } else if (mode === 'index') {
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) next.push({ a: x[i], b: y[i], path: `${path}/${i}`, depth: depth + 1 });
      for (let i = n; i < x.length; i++) next.push({ emit: { kind: 'removed', path: `${path}/${i}`, before: x[i] } });
      for (let i = n; i < y.length; i++) next.push({ emit: { kind: 'added', path: `${path}/${i}`, after: y[i] } });
    } else if (mode === 'key') {
      const idOf = el => (isObj(el) && !Array.isArray(el) && own.call(el, key) && !isObj(el[key])) ? typeName(el[key]) + ':' + String(el[key]) : null;
      const bIdx = new Map();
      y.forEach((el, j) => { const id = idOf(el); if (id !== null && !bIdx.has(id)) bIdx.set(id, j); });
      const used = new Set();
      x.forEach((el, i) => {
        const id = idOf(el), j = id === null ? undefined : bIdx.get(id);
        if (j === undefined || used.has(j)) next.push({ emit: { kind: 'removed', path: `${path}/${i}`, before: el, arrayIndex: i } });
        else { used.add(j); next.push({ a: el, b: y[j], path: `${path}/${i}`, depth: depth + 1 }); }
      });
      y.forEach((el, j) => { if (!used.has(j)) next.push({ emit: { kind: 'added', path: `${path}/-`, after: el, arrayIndex: j } }); });
    } else { // unordered multiset
      const pool = new Map();
      y.forEach((el, j) => { const c = canonical(el); if (!pool.has(c)) pool.set(c, []); pool.get(c).push(j); });
      const used = new Set();
      x.forEach((el, i) => {
        const l = pool.get(canonical(el));
        if (l && l.length) used.add(l.shift());
        else next.push({ emit: { kind: 'removed', path: `${path}/${i}`, before: el, arrayIndex: i } });
      });
      y.forEach((el, j) => { if (!used.has(j)) next.push({ emit: { kind: 'added', path: `${path}/-`, after: el, arrayIndex: j } }); });
    }
    // Push in reverse so tasks pop in document order; emits are pushed as tasks to keep ordering stable.
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i].emit ? { emit: next[i].emit } : next[i]);
  }
  return finish(changes, truncated);

  function finish(list, trunc) {
    const counts = { added: 0, removed: 0, changed: 0, 'type-changed': 0 };
    for (const c of list) counts[c.kind]++;
    return { changes: list, counts, truncated: trunc, equal: list.length === 0 && !trunc };
  }
}

/** Compare two JSON pointers: parents before children, numeric segments numerically. */
function cmpPath(p, q) {
  const a = p.split('/'), b = q.split('/');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const na = /^\d+$/.test(a[i]), nb = /^\d+$/.test(b[i]);
    if (na && nb) return Number(a[i]) - Number(b[i]);
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** RFC 6902 patch operations for a list of changes from diffJson(). */
export function toJsonPatch(changes) {
  const toOp = c => c.kind === 'added' ? { op: 'add', path: c.path, value: c.after }
    : c.kind === 'removed' ? { op: 'remove', path: c.path }
      : { op: 'replace', path: c.path, value: c.after };
  const replaces = changes.filter(c => c.kind === 'changed' || c.kind === 'type-changed').map(toOp);
  // removals: deepest / highest index first so earlier removals do not shift later paths
  const removes = changes.filter(c => c.kind === 'removed').map(toOp).sort((x, y) => cmpPath(y.path, x.path));
  const adds = changes.filter(c => c.kind === 'added').map(toOp);
  return [...replaces, ...removes, ...adds];
}

/** Human readable lines: "+ /a/b  added: 1", "- /x  removed", "~ /y  changed: 1 -> 2" (type changes marked "type"). */
export function toText(changes) {
  const show = v => { let s = JSON.stringify(v); if (s === undefined) s = String(v); return s.length > 120 ? s.slice(0, 117) + '...' : s; };
  return changes.map(c => {
    const p = c.path === '' ? '(root)' : c.path;
    if (c.kind === 'added') return `+ ${p}  added: ${show(c.after)}`;
    if (c.kind === 'removed') return `- ${p}  removed: ${show(c.before)}`;
    if (c.kind === 'type-changed') return `~ ${p}  type changed (${typeName(c.before)} -> ${typeName(c.after)}): ${show(c.before)} -> ${show(c.after)}`;
    return `~ ${p}  changed: ${show(c.before)} -> ${show(c.after)}`;
  }).join('\n');
}

export const MARKERS = { added: '+', removed: '−', changed: '~', 'type-changed': '~' };
