// Run: node tests/unit/diff-checker.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/diff-checker/logic.js';
import { createRunner } from '../../tools/diff-checker/runner.js';

const queue = [];
const test = (name, fn) => queue.push({ name, fn });

// deterministic PRNG
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/** Brute-force LCS length (O(nm) DP). */
function lcsLen(a, b) {
  const n = a.length, m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[m];
}
const reconstruct = ops => {
  const A = [], B = [];
  for (const o of ops) { if (o.type !== '+') A.push(o.a.text + o.a.eol); if (o.type !== '-') B.push(o.b.text + o.b.eol); }
  return [A.join(''), B.join('')];
};

/** Tiny unified-patch applier (strict: context and removed lines must match). */
function applyPatch(orig, patch) {
  const parts = orig === '' ? [] : orig.split('\n');
  let finalNl = true;
  if (parts.length) { const last = parts.pop(); if (last !== '') { parts.push(last); finalNl = false; } }
  const src = parts.map((t, i) => ({ t, nl: !(i === parts.length - 1 && !finalNl) }));
  const out = [];
  let pos = 0;
  const lines = patch.split('\n');
  assert.equal(lines.pop(), '', 'patch ends with newline');
  let i = 0;
  assert.ok(lines[i++].startsWith('--- ')); assert.ok(lines[i++].startsWith('+++ '));
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[i++]);
    assert.ok(m, 'hunk header: ' + lines[i - 1]);
    const aStart = +m[1], aCount = m[2] === undefined ? 1 : +m[2];
    const target = aCount === 0 ? aStart : aStart - 1;
    while (pos < target) out.push(src[pos++]);
    let last = null, seenA = 0;
    while (i < lines.length && !lines[i].startsWith('@@ ')) {
      const l = lines[i++], tag = l[0], body = l.slice(1);
      if (tag === '\\') { if (last && last.kind !== '-') last.ref.nl = false; continue; }
      if (tag === ' ' || tag === '-') {
        const s = src[pos++]; seenA++;
        assert.ok(s, 'patch runs past end of original');
        assert.equal(s.t, body, 'context/removal mismatch');
        if (tag === ' ') { const r = { t: s.t, nl: s.nl }; out.push(r); last = { kind: ' ', ref: r }; } else last = { kind: '-' };
      } else if (tag === '+') { const r = { t: body, nl: true }; out.push(r); last = { kind: '+', ref: r }; }
      else assert.fail('bad patch line ' + l);
    }
    assert.equal(seenA, aCount, 'hunk old-count');
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.map(r => r.t + (r.nl ? '\n' : '')).join('');
}

// ---------- splitting ----------
test('splitLines keeps exact terminators', () => {
  assert.deepEqual(L.splitLines(''), []);
  assert.deepEqual(L.splitLines('a\r\nb\nc'), [{ text: 'a', eol: '\r\n' }, { text: 'b', eol: '\n' }, { text: 'c', eol: '' }]);
  assert.deepEqual(L.splitLines('\n'), [{ text: '', eol: '\n' }]);
  assert.equal(L.eolStyle(L.splitLines('a\r\nb\r\n')), 'crlf');
  assert.equal(L.eolStyle(L.splitLines('a\nb\r\n')), 'mixed');
  assert.equal(L.eolStyle(L.splitLines('a')), 'none');
});

// ---------- correctness vs brute-force ----------
test('random inputs: reconstruct both sides and edit script is minimal (3000 cases)', () => {
  const r = rng(12345);
  for (let t = 0; t < 3000; t++) {
    const alpha = 1 + Math.floor(r() * 6);
    const gen = () => Array.from({ length: Math.floor(r() * 24) }, () => 'xyzuvw'[Math.floor(r() * alpha)]);
    const a = gen(), b = gen();
    const ta = a.join('\n') + (a.length ? '\n' : ''), tb = b.join('\n') + (b.length ? '\n' : '');
    const res = L.computeDiff(ta, tb);
    const [ra, rb] = reconstruct(res.ops);
    assert.equal(ra, ta); assert.equal(rb, tb);
    const optimum = a.length + b.length - 2 * lcsLen(a, b);
    assert.equal(res.stats.adds + res.stats.dels, optimum, `case ${t}: ${a.join('')} vs ${b.join('')}`);
    assert.equal(res.identical, optimum === 0 && ta === tb);
  }
});
test('lcsMatches directly: larger random arrays (n<=120) are optimal and strictly increasing', () => {
  const r = rng(99);
  for (let t = 0; t < 300; t++) {
    const k = 2 + Math.floor(r() * 10);
    const a = Int32Array.from({ length: Math.floor(r() * 120) }, () => Math.floor(r() * k));
    const b = Int32Array.from({ length: Math.floor(r() * 120) }, () => Math.floor(r() * k));
    const { ma, mb } = L.lcsMatches(a, b);
    assert.equal(ma.length, lcsLen(a, b));
    for (let i = 0; i < ma.length; i++) { assert.equal(a[ma[i]], b[mb[i]]); if (i) { assert.ok(ma[i] > ma[i - 1] && mb[i] > mb[i - 1]); } }
  }
});
test('structured edits (insert/delete/move blocks) stay minimal', () => {
  const r = rng(7);
  for (let t = 0; t < 200; t++) {
    const a = Array.from({ length: 60 }, (_, i) => 'L' + (i % 9));
    const b = a.slice();
    for (let e = 0; e < 6; e++) {
      const p = Math.floor(r() * b.length);
      const kind = r();
      if (kind < 0.33) b.splice(p, 1 + Math.floor(r() * 3));
      else if (kind < 0.66) b.splice(p, 0, 'N' + Math.floor(r() * 4), 'L' + Math.floor(r() * 9));
      else { const blk = b.splice(p, 4); b.splice(Math.floor(r() * b.length), 0, ...blk); }
    }
    const res = L.computeDiff(a.join('\n') + '\n', b.join('\n') + '\n');
    assert.equal(res.stats.adds + res.stats.dels, a.length + b.length - 2 * lcsLen(a, b));
  }
});
test('identical, empty and one-sided inputs', () => {
  assert.equal(L.computeDiff('', '').identical, true);
  assert.equal(L.computeDiff('a\nb\n', 'a\nb\n').identical, true);
  const r = L.computeDiff('', 'a\nb\n'); assert.deepEqual([r.stats.adds, r.stats.dels], [2, 0]);
  const r2 = L.computeDiff('a\nb\n', ''); assert.deepEqual([r2.stats.adds, r2.stats.dels], [0, 2]);
  assert.equal(L.computeDiff('a', 'a\n').identical, false, 'missing final newline is a difference');
});

// ---------- large inputs ----------
test('20,000 lines with every 5th changed gives exactly the 4,000 true changes', () => {
  const a = [], b = [];
  for (let i = 0; i < 20000; i++) { a.push(`const value${i} = compute(${i});`); b.push(i % 5 === 0 ? `const value${i} = recompute(${i}, true);` : a[i]); }
  const res = L.computeDiff(a.join('\n'), b.join('\n'));
  assert.equal(res.stats.changed, 4000);
  assert.equal(res.stats.adds, 4000); assert.equal(res.stats.dels, 4000);
  assert.equal(res.stats.equal, 16000);
  assert.equal(res.stats.added, 0); assert.equal(res.stats.removed, 0);
});
test('20,000 lines, changes whose text also occurs elsewhere (no unique-line shortcut) are still minimal', () => {
  const r = rng(5);
  const a = Array.from({ length: 20000 }, (_, i) => 'row ' + i);
  const b = a.slice();
  for (let i = 0; i < 20000; i += 5) b[i] = 'row ' + Math.floor(r() * 20000); // duplicates existing lines
  const t0 = performance.now();
  const res = L.computeDiff(a.join('\n'), b.join('\n'));
  const ms = performance.now() - t0;
  const ids = new Map(); const ia = Int32Array.from(a, s => ids.get(s) ?? (ids.set(s, ids.size), ids.size - 1)); const ib = Int32Array.from(b, s => ids.get(s));
  assert.ok(res.stats.adds + res.stats.dels <= 8000, 'never worse than the 4000 replacements');
  assert.ok(L.lcsMatches(ia, ib).ma.length === res.stats.equal);
  console.log(`      (20k dup-heavy diff: ${ms.toFixed(0)} ms, edit distance ${res.stats.adds + res.stats.dels})`);
});
test('100,000 lines (every 5th changed) finishes in < 2 s with exact result', () => {
  const a = [], b = [];
  for (let i = 0; i < 100000; i++) { a.push(`line ${i} some text here`); b.push(i % 5 === 0 ? `line ${i} CHANGED text` : a[i]); }
  const ta = a.join('\n'), tb = b.join('\n');
  const t0 = performance.now();
  const res = L.computeDiff(ta, tb);
  const ms = performance.now() - t0;
  console.log(`      (100k lines: ${ms.toFixed(0)} ms)`);
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.equal(res.stats.changed, 20000); assert.equal(res.stats.equal, 80000);
});
test('100,000 lines of unrelated content (worst case, all unique) is fast and fully replaced', () => {
  const a = Array.from({ length: 100000 }, (_, i) => 'a' + i).join('\n'), b = Array.from({ length: 100000 }, (_, i) => 'b' + i).join('\n');
  const t0 = performance.now();
  const res = L.computeDiff(a, b);
  const ms = performance.now() - t0;
  console.log(`      (100k fully different: ${ms.toFixed(0)} ms)`);
  assert.ok(ms < 2000);
  assert.equal(res.stats.changed, 100000);
});
test('100,000 lines with shuffled-block moves stays correct', () => {
  const a = Array.from({ length: 100000 }, (_, i) => 'l' + i);
  const b = a.slice(50000).concat(a.slice(0, 50000));
  const t0 = performance.now();
  const res = L.computeDiff(a.join('\n') + '\n', b.join('\n') + '\n');
  const ms = performance.now() - t0;
  console.log(`      (100k block swap: ${ms.toFixed(0)} ms)`);
  assert.equal(res.stats.equal, 50000);
  assert.ok(ms < 4000, `took ${ms} ms`);
  assert.equal(res.approximate, true, 'budget fallback is reported');
});

// ---------- options ----------
const D = (a, b, o) => L.computeDiff(a, b, o);
test('ignore case', () => {
  assert.equal(D('Hello\nWorld', 'hello\nWORLD', { ignoreCase: true }).identical, true);
  assert.equal(D('Hello', 'hello').identical, false);
});
test('whitespace modes: none / edges / collapse / all', () => {
  assert.equal(D('a b', 'a  b', { ws: 'none' }).identical, false);
  assert.equal(D('  a b  ', 'a b', { ws: 'edges' }).identical, true);
  assert.equal(D('a  b', 'a b', { ws: 'edges' }).identical, false);
  assert.equal(D('a  \t b', 'a b', { ws: 'collapse' }).identical, true);
  assert.equal(D(' a b', 'a b', { ws: 'collapse' }).identical, false, 'collapse keeps edges');
  assert.equal(D('a b', 'ab', { ws: 'collapse' }).identical, false);
  assert.equal(D(' a\t b ', 'ab', { ws: 'all' }).identical, true);
});
test('trim trailing whitespace', () => {
  assert.equal(D('a  \nb', 'a\nb', { trimTrailing: true }).identical, true);
  assert.equal(D('  a', 'a', { trimTrailing: true }).identical, false);
});
test('ignore blank lines: invisible to stats, line numbers stay monotonic', () => {
  const r = D('a\n\n\nb\nc\n', 'a\nb\n\nc\nX\n', { ignoreBlank: true });
  assert.equal(r.stats.adds, 1); assert.equal(r.stats.dels, 0);
  assert.equal(r.ops.filter(o => o.ignored).length, 3);
  let pa = 0, pb = 0;
  for (const o of r.ops) { if (o.aNo) { assert.equal(o.aNo, pa + 1); pa = o.aNo; } if (o.bNo) { assert.equal(o.bNo, pb + 1); pb = o.bNo; } }
  assert.equal(pa, 5); assert.equal(pb, 5);
  assert.equal(D('a\n\nb', 'a\nb', { ignoreBlank: true }).identical, true);
  assert.equal(D('a\n\nb', 'a\nb').identical, false);
  assert.equal(D('a\n  \nb', 'a\nb', { ignoreBlank: true }).identical, true, 'whitespace-only counts as blank');
});
test('ignore line endings: CRLF vs LF identical, notice reported; exact mode sees it', () => {
  const r = D('a\r\nb\r\n', 'a\nb\n', { ignoreEol: true });
  assert.equal(r.identical, true);
  assert.equal(r.eolA, 'crlf'); assert.equal(r.eolB, 'lf');
  assert.match(L.eolNotice(r.eolA, r.eolB), /CRLF.*LF/);
  assert.match(L.eolNotice('mixed', 'lf'), /mixed/);
  assert.equal(L.eolNotice('lf', 'lf'), null);
  assert.equal(L.eolNotice('none', 'crlf'), null);
  assert.equal(D('a\r\nb\r\n', 'a\nb\n', { ignoreEol: false }).identical, false);
  assert.equal(D('a\nb', 'a\nb\n', { ignoreEol: true }).identical, false, 'final newline still differs');
});
test('options combine', () => {
  assert.equal(D('  Foo   Bar \r\n\r\nBaz', 'foo bar\nbaz', { ignoreCase: true, ws: 'collapse', trimTrailing: true, ignoreBlank: true }).identical, false); // leading ws kept by collapse
  assert.equal(D('  Foo   Bar \r\n\r\nBaz', 'foo bar\nbaz', { ignoreCase: true, ws: 'edges', ignoreBlank: true }).identical, false); // inner run stays
  assert.equal(D('  Foo   Bar \r\n\r\nBaz', 'foo bar\nbaz', { ignoreCase: true, ws: 'all', ignoreBlank: true }).identical, true);
});
test('hasIgnoreOptions', () => {
  assert.equal(L.hasIgnoreOptions({}), false);
  assert.equal(L.hasIgnoreOptions({ ws: 'all' }), true);
  assert.equal(L.hasIgnoreOptions({ ignoreEol: true }), false);
});

// ---------- inline ----------
const joinText = segs => segs.map(s => s.text).join('');
test('inline word diff highlights the changed word', () => {
  const r = L.inlineDiff('let total = price * qty;', 'let total = cost * qty;', {}, 'word');
  assert.deepEqual(r.a.filter(s => s.changed).map(s => s.text), ['price']);
  assert.deepEqual(r.b.filter(s => s.changed).map(s => s.text), ['cost']);
  assert.equal(joinText(r.a), 'let total = price * qty;'); assert.equal(joinText(r.b), 'let total = cost * qty;');
});
test('inline word mode refines a single changed token at character level', () => {
  const r = L.inlineDiff('const foobar = 1;', 'const foobaz = 1;', {}, 'word');
  assert.deepEqual(r.a.filter(s => s.changed).map(s => s.text), ['r']);
  assert.deepEqual(r.b.filter(s => s.changed).map(s => s.text), ['z']);
});
test('inline char mode', () => {
  const r = L.inlineDiff('kitten sitting', 'sitten kitting', {}, 'char');
  assert.equal(joinText(r.a), 'kitten sitting'); assert.equal(joinText(r.b), 'sitten kitting');
  assert.ok(r.a.some(s => s.changed));
});
test('inline is surrogate-pair safe (emoji, astral CJK)', () => {
  const lone = s => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  const cases = [['I like 😀 cats and dogs', 'I like 😁 cats and dogs'], ['😀😀😀x', '😀😁😀x'], ['a𠮷b𠮷c', 'a𠮷d𠮷c'], ['😀', '😁'], ['x👍🏽y', 'x👍🏿y']];
  for (const gran of ['word', 'char']) for (const [x, y] of cases) {
    const r = L.inlineDiff(x, y, {}, gran);
    if (!r) continue; // judged too dissimilar - fine
    for (const seg of [...r.a, ...r.b]) assert.ok(!lone(seg.text), `${gran}: lone surrogate in ${JSON.stringify(seg.text)} for ${x}`);
    assert.equal(joinText(r.a), x); assert.equal(joinText(r.b), y);
  }
  assert.deepEqual(L.tokenize('a😀b', 'char'), ['a', '😀', 'b']);
  const r = L.inlineDiff('x 😀 y', 'x 😁 y', {}, 'char');
  assert.deepEqual(r.a.filter(s => s.changed).map(s => s.text), ['😀']);
});
test('inline skips lines over 5000 chars and flags it', () => {
  const long = 'x'.repeat(L.MAX_INLINE_LEN + 1);
  assert.deepEqual(L.inlineDiff(long, long + 'y', {}, 'word'), { skipped: true });
  assert.ok(L.inlineDiff('x'.repeat(L.MAX_INLINE_LEN), 'x'.repeat(L.MAX_INLINE_LEN - 1) + 'y', {}, 'char').a);
});
test('inline respects ignoreCase / whitespace options', () => {
  const r = L.inlineDiff('Foo  bar', 'foo bar', { ignoreCase: true, ws: 'collapse' }, 'word');
  assert.equal(r.a.some(s => s.changed), false);
});
test('inline returns null for unrelated lines', () => {
  assert.equal(L.inlineDiff('abcdefghij', 'klmnopqrst', {}, 'word'), null);
});

// ---------- view models ----------
test('side rows pair deletions with insertions; stats: added/removed/changed', () => {
  const r = D('a\nb\nc\nd', 'a\nB\nC\nD\nE\nd');
  const rows = L.buildSideRows(r.ops);
  assert.ok(rows.every(x => x.l || x.r));
  const chg = rows.filter(x => x.change);
  assert.equal(chg.filter(x => x.l && x.r).length, 2);
  assert.equal(r.stats.changed, 2); assert.equal(r.stats.added, 2); assert.equal(r.stats.removed, 0);
  assert.deepEqual(L.changeStarts(rows, x => x.change), [1]);
});
test('visibleMask folds long unchanged runs, honours context and "all"', () => {
  const chg = i => i === 10 || i === 50;
  const vis = L.visibleMask(chg, 100, 3);
  assert.equal(vis.reduce((s, v) => s + v, 0), 14);
  assert.equal(vis[6], 0); assert.equal(vis[7], 1); assert.equal(vis[13], 1); assert.equal(vis[14], 0);
  assert.equal(L.visibleMask(chg, 100, 0).reduce((s, v) => s + v, 0), 2);
  assert.equal(L.visibleMask(chg, 100, -1).reduce((s, v) => s + v, 0), 100);
});
test('identical % stat', () => {
  assert.equal(D('a\nb\nc\nd', 'a\nb\nc\nX').stats.identicalPct, 75);
  assert.equal(D('', '').stats.identicalPct, 100);
});

// ---------- patch export ----------
function patchRoundTrip(a, b, context) {
  const p = L.exportPatch(a, b, { context });
  if (a === b) { assert.equal(p, ''); return; }
  assert.equal(applyPatch(a, p), b, `patch must reproduce B\n${p}`);
}
test('unified patch applies cleanly: fixed cases', () => {
  const cases = [
    ['', 'a\nb\n'], ['a\nb\n', ''], ['a\n', 'a\n'], ['a', 'a\n'], ['a\n', 'a'], ['a\nb', 'a\nc'], ['a\nb\n', 'a\nb'], ['x', 'y'],
    ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', '1\n2\nthree\n4\n5\n6\n7\n8\n9\n10\n11\n'],
    ['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'], ['a\r\nb\n', 'a\nb\r\n'], ['\n\n\n', '\n'], ['a\n\nb\n', 'a\nb\n'], ['', '\n'],
  ];
  for (const [a, b] of cases) for (const c of [0, 1, 3, 10]) patchRoundTrip(a, b, c);
});
test('unified patch applies cleanly: 1500 random texts, random context', () => {
  const r = rng(2024);
  const eols = ['\n', '\r\n'];
  for (let t = 0; t < 1500; t++) {
    const gen = () => {
      const n = Math.floor(r() * 18); let s = '';
      for (let i = 0; i < n; i++) s += 'abc '[Math.floor(r() * 3)].repeat(Math.floor(r() * 2)) + (r() < 0.1 ? '  ' : '') + (i === n - 1 && r() < 0.3 ? '' : eols[r() < 0.85 ? 0 : 1]);
      return s;
    };
    patchRoundTrip(gen(), gen(), [0, 1, 3][Math.floor(r() * 3)]);
  }
});
test('export with ignore options on still yields an exact patch (computed on real text)', () => {
  const a = 'Hello World\n  indented\nsame\n\nend\n', b = 'hello world\nindented\nsame\nend\n';
  assert.equal(D(a, b, { ignoreCase: true, ws: 'all', ignoreBlank: true }).identical, true, 'view says identical');
  const p = L.exportPatch(a, b);
  assert.notEqual(p, '');
  assert.equal(applyPatch(a, p), b);
});
test('patch hunk header numbers', () => {
  const p = L.exportPatch('a\nb\nc\n', 'a\nX\nc\n', { context: 1, aName: 'a.txt', bName: 'b.txt' });
  assert.equal(p, '--- a.txt\n+++ b.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n');
  assert.equal(L.exportPatch('', 'a\n'), '--- original\n+++ modified\n@@ -0,0 +1 @@\n+a\n');
});
test('large patch applies (5000 lines, scattered edits)', () => {
  const r = rng(3);
  const a = Array.from({ length: 5000 }, (_, i) => 'line ' + i), b = a.slice();
  for (let k = 0; k < 300; k++) { const p = Math.floor(r() * b.length); if (r() < 0.4) b.splice(p, 1); else if (r() < 0.5) b.splice(p, 0, 'new ' + k); else b[p] = 'mod ' + k; }
  patchRoundTrip(a.join('\n') + '\n', b.join('\n') + '\n', 3);
});

// ---------- runner ----------
test('runner: in-thread path matches computeDiff; worker construction failure falls back', async () => {
  const a = 'a\nb\nc\n', b = 'a\nX\nc\n';
  const direct = L.computeDiff(a, b);
  const r1 = await createRunner().run(a, b, {});
  assert.deepEqual(r1.stats, direct.stats);
  const runner = createRunner({ threshold: 0, createWorker: () => { throw new Error('no workers'); } });
  const r2 = await runner.run(a, b, {});
  assert.deepEqual(r2.stats, direct.stats); assert.equal(r2.eolA, 'lf');
});
test('runner: worker path (fake worker) + cancel', async () => {
  const logic = L;
  const fake = () => {
    const w = { terminated: false, postMessage(m) { setTimeout(() => { if (w.terminated) return; const A = logic.splitLines(m.a), B = logic.splitLines(m.b); w.onmessage({ data: { id: m.id, codes: logic.diffCodes(A, B, m.opts), eolA: 'lf', eolB: 'lf', linesA: A.length, linesB: B.length } }); }, 5); }, terminate() { w.terminated = true; } };
    return w;
  };
  const runner = createRunner({ threshold: 0, createWorker: fake });
  const r = await runner.run('a\nb\n', 'a\nc\n', {});
  assert.equal(r.stats.changed, 1);
  const p = runner.run('a\nb\n', 'a\nc\n', {});
  runner.cancel();
  assert.deepEqual(await p, { cancelled: true });
});

// ---------- run ----------
let pass = 0, fail = 0;
for (const { name, fn } of queue) {
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n' + (e && e.stack || e)); }
}
console.log(`\ndiff-checker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
