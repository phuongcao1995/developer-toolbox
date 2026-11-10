/*
 * fill.js — autofill: decides what the cells added by dragging the fill handle (or Ctrl+D / Ctrl+R) should contain.
 * Pure logic with no DOM access, so it can be tested in Node.
 *
 * plan(cells, count, { reverse, copyOnly }) looks at one line of source cells (a column when filling up or down, a row when
 * filling left or right) and returns `count` instructions, one per new cell, in the order they are added:
 *   { from: i }              copy source cell i (formulas shift their relative references, styles are kept)
 *   { from: i, value: v }    use value v, but take the style of source cell i
 *
 * Rules, as in Excel:
 *   - numbers (and dates): two or more cells continue the linear trend; a single number is copied; a single date adds a day
 *   - text ending in a number ("Item 1", "Thứ 2"): the number counts up (or follows the step of the selected cells)
 *   - weekday and month names (English): continue the cycle
 *   - formulas, booleans and anything else: the selected cells repeat
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;

  const LISTS = [
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ];

  const isPlainNumber = (c) => c && !c.formula && typeof c.value === 'number';
  const isDateCell = (c) => isPlainNumber(c) && !!(c.style && c.style.numFmt && U.isDateFormat(c.style.numFmt));
  const isPlainText = (c) => c && !c.formula && typeof c.value === 'string' && c.value !== '';
  const round = (x) => parseFloat(x.toPrecision(14));

  /** Position of source cell `index` for the k-th new cell (k = 0, 1, ...) when filling forwards or backwards. */
  const position = (n, k, reverse) => (reverse ? -1 - k : n + k);
  /** Which source cell a repeated pattern takes for position p (works for negative positions too). */
  const cycle = (n, p) => ((p % n) + n) % n;

  function linearTrend(values) {
    const n = values.length;
    const mx = (n - 1) / 2;
    const my = values.reduce((a, b) => a + b, 0) / n;
    let num = 0; let den = 0;
    values.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); });
    const slope = den === 0 ? 0 : num / den;
    return { slope, intercept: my - slope * mx };
  }

  function numberSeries(cells, count, reverse) {
    const n = cells.length;
    const values = cells.map((c) => c.value);
    let slope; let intercept;
    if (n === 1) {
      if (!isDateCell(cells[0])) return null; // a lone number is simply copied
      slope = 1; intercept = values[0];
    } else ({ slope, intercept } = linearTrend(values));
    return Array.from({ length: count }, (_, k) => ({ from: cycle(n, position(n, k, reverse)), value: round(intercept + slope * position(n, k, reverse)) }));
  }

  /** "Item 7" -> { prefix: 'Item ', number: 7, digits: 1, suffix: '' } (the last run of digits). */
  function splitNumber(text) {
    const m = /^([\s\S]*?)(\d+)(\D*)$/.exec(text);
    return m ? { prefix: m[1], number: Number(m[2]), digits: m[2].length, padded: m[2].length > 1 && m[2][0] === '0', suffix: m[3] } : null;
  }

  function textNumberSeries(cells, count, reverse) {
    const parts = cells.map((c) => splitNumber(c.value));
    if (parts.some((p) => !p)) return null;
    if (parts.some((p) => p.prefix !== parts[0].prefix || p.suffix !== parts[0].suffix)) return null;
    const n = cells.length;
    const numbers = parts.map((p) => p.number);
    const { slope, intercept } = n === 1 ? { slope: 1, intercept: numbers[0] } : linearTrend(numbers);
    const { prefix, suffix, digits, padded } = parts[0];
    return Array.from({ length: count }, (_, k) => {
      const p = position(n, k, reverse);
      const v = Math.round(intercept + slope * p);
      if (v < 0) return { from: cycle(n, p), value: cells[cycle(n, p)].value };
      return { from: cycle(n, p), value: prefix + (padded ? String(v).padStart(digits, '0') : String(v)) + suffix };
    });
  }

  function matchCase(sample, text) {
    if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return text.toUpperCase();
    if (sample === sample.toLowerCase()) return text.toLowerCase();
    return text;
  }

  function listSeries(cells, count, reverse) {
    const texts = cells.map((c) => c.value.trim());
    for (const list of LISTS) {
      const idx = texts.map((t) => list.findIndex((x) => x.toLowerCase() === t.toLowerCase()));
      if (idx.some((i) => i < 0)) continue;
      const n = cells.length; const L = list.length;
      const step = n === 1 ? 1 : ((idx[n - 1] - idx[n - 2]) % L + L) % L || 1;
      return Array.from({ length: count }, (_, k) => {
        const base = reverse ? idx[0] - step * (k + 1) : idx[n - 1] + step * (k + 1);
        const word = list[((base % L) + L) % L];
        return { from: cycle(n, position(n, k, reverse)), value: matchCase(cells[0].value.trim(), word) };
      });
    }
    return null;
  }

  function plan(cells, count, options) {
    const opts = options || {};
    const n = cells.length;
    if (!n || count <= 0) return [];
    const repeat = () => Array.from({ length: count }, (_, k) => ({ from: cycle(n, position(n, k, !!opts.reverse)) }));
    if (opts.copyOnly) return repeat();
    const reverse = !!opts.reverse;
    if (cells.every(isPlainNumber)) return numberSeries(cells, count, reverse) || repeat();
    if (cells.every(isPlainText)) return listSeries(cells, count, reverse) || textNumberSeries(cells, count, reverse) || repeat();
    return repeat();
  }

  SheetApp.fill = { plan };
})(typeof window !== 'undefined' ? window : globalThis);
