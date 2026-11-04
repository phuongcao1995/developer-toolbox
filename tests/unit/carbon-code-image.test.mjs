// Run: node tests/unit/carbon-code-image.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/carbon-code-image/logic.js';
import { normalizeCode } from '../../tools/carbon-code-image/highlight.js';
import { renderToCanvas } from '../../tools/carbon-code-image/render.js';
let pass = 0;
const test = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };

test('textCols counts code points and wide chars', () => {
  assert.equal(L.textCols('abc'), 3);
  assert.equal(L.textCols('日本語'), 6);
  assert.equal(L.textCols('a😀b'), 4);           // astral emoji is ONE code point, two cells
  assert.equal(L.textCols('e\u0301'), 1);         // combining accent adds no cell
  assert.equal(L.textCols('ｱ'), 1 + 0);           // half-width kana is narrow? (U+FF71 > U+FF60) -> 1
});
test('segments pin wide chars to columns', () => {
  const s = L.segments('ab日c', 2);
  assert.deepEqual(s.map(x => [x.text, x.col, x.cols]), [['ab', 2, 2], ['日', 4, 2], ['c', 6, 1]]);
});
test('layout width uses cells, not UTF-16 length', () => {
  const lines = L.highlight('日本語日本語', 'plain');
  const o = L.sanitizeOptions({ lineNumbers: false });
  const lay = L.computeLayout(lines, o, 8);
  assert.equal(lay.win.w, Math.max(Math.ceil(12 * 8 + 44), 260));
});
test('tabs align by cells', () => {
  assert.equal(normalizeCode('日\tx', 4), '日  x'); // 日 = 2 cells, tab pads to col 4
});
test('limitLines caps at 3000', () => {
  const big = Array.from({ length: 3500 }, (_, i) => 'l' + i).join('\n');
  const r = L.limitLines(big);
  assert.equal(r.truncated, true); assert.equal(r.total, 3500); assert.equal(r.code.split('\n').length, 3000);
  assert.equal(L.limitLines('a\nb').truncated, false);
});
test('renderer draws one fillText per run, not per glyph', () => {
  const calls = [];
  const g = new Proxy({ measureText: () => ({ width: 10, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }), fillText: (t, x) => calls.push([t, x]) },
    { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { width: 0, height: 0, getContext: () => g };
  const lines = L.highlight('const x = 1;', 'javascript');
  const o = L.sanitizeOptions({});
  const layout = L.computeLayout(lines, o, 8);
  renderToCanvas(canvas, { lines, layout, opts: o, theme: L.THEMES[o.theme] }, 1);
  assert.ok(calls.length <= lines[0].length, `calls=${calls.length}`);
  assert.ok(calls.some(c => c[0].length > 1));
});
console.log(`carbon-code-image: ${pass} passed`);
