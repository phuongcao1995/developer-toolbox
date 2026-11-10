/*
 * condfmt.js — conditional formatting: evaluates the rules kept in sheet.extras.conditionalFormattings
 * (the same shape ExcelJS reads and writes, so files round-trip) and adds/removes rules.
 *
 * Supported rules: cellIs (comparisons), containsText, expression (any formula, written relative to the
 * first cell of the range), top10, aboveAverage, colorScale (2 or 3 colours). Others (data bars, icon sets)
 * are kept in the file but not drawn.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;
  const F = SheetApp.formula;

  const OPERATORS = [
    ['greaterThan', 'is greater than'], ['lessThan', 'is less than'],
    ['greaterThanOrEqual', 'is at least'], ['lessThanOrEqual', 'is at most'],
    ['equal', 'equals'], ['notEqual', 'does not equal'],
    ['between', 'is between'], ['notBetween', 'is not between'],
  ];

  const PRESETS = {
    red: { label: 'Light red fill, dark red text', font: 'FF9C0006', fill: 'FFFFC7CE' },
    yellow: { label: 'Yellow fill, dark yellow text', font: 'FF9C5700', fill: 'FFFFEB9C' },
    green: { label: 'Green fill, dark green text', font: 'FF006100', fill: 'FFC6EFCE' },
    blue: { label: 'Light blue fill, dark blue text', font: 'FF1F4E79', fill: 'FFDDEBF7' },
    bold: { label: 'Bold red text', font: 'FFC00000', fill: null, bold: true },
  };

  function presetStyle(key) {
    const p = PRESETS[key] || PRESETS.red;
    const style = { font: { color: { argb: p.font } } };
    if (p.bold) style.font.bold = true;
    if (p.fill) style.fill = { type: 'pattern', pattern: 'solid', bgColor: { argb: p.fill }, fgColor: { argb: p.fill } };
    return style;
  }

  function rangesOf(ref) {
    return String(ref || '').split(/\s+/).filter(Boolean).map((part) => {
      try { return U.parseRange(part); } catch (e) { return null; }
    }).filter(Boolean);
  }

  function textOf(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function compare(op, v, a, b) {
    const numeric = typeof v === 'number' && typeof a === 'number';
    const x = numeric ? v : textOf(v).toLowerCase();
    const y = numeric ? a : textOf(a).toLowerCase();
    if (v === null) return false;
    switch (op) {
      case 'equal': return x === y;
      case 'notEqual': return x !== y;
      case 'greaterThan': return typeof v === typeof a && x > y;
      case 'lessThan': return typeof v === typeof a && x < y;
      case 'greaterThanOrEqual': return typeof v === typeof a && x >= y;
      case 'lessThanOrEqual': return typeof v === typeof a && x <= y;
      case 'between': return typeof v === 'number' && typeof a === 'number' && typeof b === 'number' && v >= Math.min(a, b) && v <= Math.max(a, b);
      case 'notBetween': return !(typeof v === 'number' && typeof a === 'number' && typeof b === 'number' && v >= Math.min(a, b) && v <= Math.max(a, b));
      default: return false;
    }
  }

  function toCss(style) {
    const css = {};
    if (!style) return css;
    const font = style.font || {};
    const color = U.argbToCss(font.color);
    if (color) css.color = color;
    if (font.bold) css.fontWeight = '700';
    if (font.italic) css.fontStyle = 'italic';
    const deco = [];
    if (font.underline) deco.push('underline');
    if (font.strike) deco.push('line-through');
    if (deco.length) css.textDecoration = deco.join(' ');
    const fill = style.fill;
    if (fill) {
      const bg = U.argbToCss(fill.bgColor) || U.argbToCss(fill.fgColor);
      if (bg) css.background = bg;
    }
    return css;
  }

  function hexToRgb(argb) {
    const h = String(argb || 'FFFFFFFF').slice(-6);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return 'rgb(' + x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',') + ')';
  }

  /**
   * Builds a lookup for one sheet: styleAt(row, col) -> { css } | null.
   * Statistics (average, ranks, min/max) are computed once per compile.
   */
  function compile(wb, sheetIndex) {
    const sheet = wb.sheets[sheetIndex];
    const list = (sheet.extras && sheet.extras.conditionalFormattings) || [];
    if (!list.length) return null;
    const ctxBase = wb.contextFor(sheetIndex);
    const entries = [];
    for (const group of list) {
      const ranges = rangesOf(group.ref);
      if (!ranges.length) continue;
      for (const rule of group.rules || []) entries.push({ ranges, rule, priority: rule.priority || 1e6 });
    }
    entries.sort((a, b) => a.priority - b.priority);
    const live = entries.filter((e) => ['cellIs', 'containsText', 'expression', 'top10', 'aboveAverage', 'colorScale'].includes(e.rule.type));
    if (!live.length) return null;

    const numbersOf = (ranges) => {
      const out = [];
      for (const range of ranges) for (const c of wb.rangeCells(sheetIndex, range).cells) if (typeof c.value === 'number') out.push(c.value);
      return out;
    };
    for (const e of live) {
      const t = e.rule.type;
      if (t === 'top10') {
        const nums = numbersOf(e.ranges).sort((a, b) => (e.rule.bottom ? a - b : b - a));
        const n = Math.max(1, e.rule.percent ? Math.ceil((nums.length * (e.rule.rank || 10)) / 100) : (e.rule.rank || 10));
        e.limit = nums.length ? nums[Math.min(n, nums.length) - 1] : null;
      } else if (t === 'aboveAverage') {
        const nums = numbersOf(e.ranges);
        e.avg = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
      } else if (t === 'colorScale') {
        const nums = numbersOf(e.ranges);
        e.min = nums.length ? Math.min(...nums) : 0;
        e.max = nums.length ? Math.max(...nums) : 0;
      }
    }

    const operand = (formula, row, col, top) => {
      if (typeof formula === 'number') return formula;
      let text = String(formula === undefined ? '' : formula).trim();
      if (/^".*"$/.test(text)) return text.slice(1, -1);
      if (text.startsWith('=')) text = text.slice(1);
      const n = U.parseNumber(text);
      if (n !== null && /^[-+\d.\s,%eE]+$/.test(text)) return n;
      try { return F.evaluate(F.shiftFormula(text, row - top.r1, col - top.c1), Object.assign(Object.create(ctxBase), { row, col })); } catch (err) { return null; }
    };

    const cache = new Map();
    function styleAt(row, col) {
      const key = U.cellKey(row, col);
      if (cache.has(key)) return cache.get(key);
      let result = null;
      for (const e of live) {
        const top = e.ranges.find((r) => U.rangeContains(r, row, col));
        if (!top) continue;
        const rule = e.rule;
        const value = wb.getValue(sheetIndex, row, col);
        let hit = false, css = null;
        if (rule.type === 'cellIs') {
          const f = rule.formulae || [];
          hit = compare(rule.operator, value, operand(f[0], row, col, top), operand(f[1], row, col, top));
        } else if (rule.type === 'containsText') {
          const needle = String(rule.text || '').toLowerCase();
          const hay = textOf(value).toLowerCase();
          const op = rule.operator || 'containsText';
          hit = value !== null && (op === 'beginsWith' ? hay.startsWith(needle) : op === 'endsWith' ? hay.endsWith(needle) : op === 'notContains' ? !hay.includes(needle) : hay.includes(needle));
        } else if (rule.type === 'expression') {
          const v = operand('=' + String((rule.formulae || [''])[0]).replace(/^=/, ''), row, col, top);
          hit = v === true || (typeof v === 'number' && v !== 0);
        } else if (rule.type === 'top10') {
          hit = typeof value === 'number' && e.limit !== null && (rule.bottom ? value <= e.limit : value >= e.limit);
        } else if (rule.type === 'aboveAverage') {
          hit = typeof value === 'number' && e.avg !== null && (rule.aboveAverage === false ? value < e.avg : value > e.avg);
        } else if (rule.type === 'colorScale' && typeof value === 'number') {
          const colors = (rule.color || []).map((c) => c.argb);
          if (colors.length >= 2) {
            const span = e.max - e.min;
            const t = span ? (value - e.min) / span : 0;
            const bg = colors.length >= 3
              ? (t < 0.5 ? mix(colors[0], colors[1], t * 2) : mix(colors[1], colors[2], (t - 0.5) * 2))
              : mix(colors[0], colors[1], t);
            css = { background: bg };
            hit = true;
          }
        }
        if (!hit) continue;
        css = css || toCss(rule.style);
        result = Object.assign({}, css, result || {}); // higher priority (earlier) wins per property
      }
      cache.set(key, result);
      return result;
    }
    return styleAt;
  }

  /** Cached per workbook state: the cache lives in calcCache, which is cleared on every change. */
  function lookup(wb, sheetIndex) {
    const key = 'cf:' + sheetIndex;
    if (!wb.calcCache.has(key)) wb.calcCache.set(key, { fn: compile(wb, sheetIndex) });
    return wb.calcCache.get(key).fn;
  }

  /* ---------- Editing ---------- */

  function setList(wb, sheetIndex, mutate, label) {
    const sheet = wb.sheets[sheetIndex];
    wb.transact(label, () => {
      const extras = { ...(sheet.extras || {}) };
      const next = mutate((extras.conditionalFormattings || []).map((g) => ({ ...g, rules: (g.rules || []).slice() })));
      if (next.length) extras.conditionalFormattings = next; else delete extras.conditionalFormattings;
      sheet.extras = extras;
    });
  }

  function nextPriority(list) {
    return list.reduce((m, g) => (g.rules || []).reduce((mm, r) => Math.max(mm, r.priority || 0), m), 0) + 1;
  }

  /** New rules go first (priority 1) so they win over older ones, like Excel. */
  function addRule(wb, sheetIndex, ranges, rule) {
    const ref = ranges.map(U.rangeAddress).join(' ');
    setList(wb, sheetIndex, (list) => {
      list.forEach((g) => g.rules.forEach((r) => { r.priority = (r.priority || nextPriority(list)) + 1; }));
      list.unshift({ ref, rules: [{ ...rule, priority: 1 }] });
      return list;
    }, 'Conditional formatting');
  }

  /** Removes every rule that touches the given ranges. Returns how many were removed. */
  function clearRules(wb, sheetIndex, ranges) {
    let removed = 0;
    setList(wb, sheetIndex, (list) => list.filter((g) => {
      const hit = rangesOf(g.ref).some((r) => ranges.some((q) => U.rangesIntersect(r, q)));
      if (hit) removed += (g.rules || []).length;
      return !hit;
    }), 'Clear conditional formatting');
    return removed;
  }

  /** Keeps only the rules for which keep(rule) is true; groups left empty are dropped. */
  function setRules(wb, sheetIndex, keep) {
    setList(wb, sheetIndex, (list) => list
      .map((g) => ({ ...g, rules: g.rules.filter(keep) }))
      .filter((g) => g.rules.length), 'Conditional formatting');
  }

  function describe(group, rule) {
    const f = rule.formulae || [];
    const op = (OPERATORS.find((o) => o[0] === rule.operator) || [])[1];
    switch (rule.type) {
      case 'cellIs': return 'Cell value ' + (op || rule.operator) + ' ' + f.join(' and ');
      case 'containsText': return 'Text ' + ({ beginsWith: 'begins with', endsWith: 'ends with', notContains: 'does not contain' }[rule.operator] || 'contains') + ' "' + rule.text + '"';
      case 'expression': return 'Formula ' + f[0];
      case 'top10': return (rule.bottom ? 'Bottom ' : 'Top ') + (rule.rank || 10) + (rule.percent ? '%' : '');
      case 'aboveAverage': return rule.aboveAverage === false ? 'Below average' : 'Above average';
      case 'colorScale': return (rule.color || []).length === 3 ? '3-colour scale' : '2-colour scale';
      case 'dataBar': return 'Data bar (not drawn here)';
      case 'iconSet': return 'Icon set (not drawn here)';
      default: return rule.type + ' (not drawn here)';
    }
  }

  function listRules(wb, sheetIndex) {
    const out = [];
    for (const g of (wb.sheets[sheetIndex].extras || {}).conditionalFormattings || []) {
      for (const rule of g.rules || []) out.push({ ref: g.ref, text: describe(g, rule), rule });
    }
    return out;
  }

  SheetApp.condfmt = { OPERATORS, PRESETS, presetStyle, lookup, addRule, clearRules, setRules, listRules };
})(typeof window !== 'undefined' ? window : globalThis);
