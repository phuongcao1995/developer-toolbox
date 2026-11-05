/*
 * spreadsheet.js — the workbook model.
 * Owns sheets, cells, calculation, undo/redo and every editing operation.
 * Knows nothing about the DOM; the grid and toolbar listen to its change events.
 *
 * Cells are immutable objects { value, formula, style, note, hyperlink }:
 *   value   – number | string | boolean | { error } | null (for formulas: the cached result)
 *   formula – formula text without the leading "=" or null
 *   style   – ExcelJS-shaped style object (font, fill, alignment, border, numFmt) or null; shared, never mutated
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;
  const F = SheetApp.formula;

  const DEFAULT_COL_WIDTH = 100;
  const DEFAULT_ROW_HEIGHT = 24;
  const MIN_ROWS = 200;
  const MIN_COLS = 26;
  const HISTORY_LIMIT = 200;
  const INVALID_SHEET_CHARS = /[\\/?*[\]:]/;

  let nextSheetId = 1;

  function makeCell(props) {
    const cell = {
      value: props.value === undefined ? null : props.value,
      formula: props.formula || null,
      style: props.style || null,
      note: props.note || null,
      hyperlink: props.hyperlink || null,
    };
    const empty = cell.value === null && !cell.formula && !cell.style && !cell.note && !cell.hyperlink;
    return empty ? null : Object.freeze(cell);
  }

  function withCell(cell, changes) {
    return makeCell({ ...(cell || {}), ...changes });
  }

  /* ---------- Range arithmetic ---------- */

  /** Returns the parts of range a not covered by b (up to four rectangles). */
  function subtractRange(a, b) {
    if (!U.rangesIntersect(a, b)) return [a];
    const parts = [];
    if (a.r1 < b.r1) parts.push({ r1: a.r1, c1: a.c1, r2: b.r1 - 1, c2: a.c2 });
    if (a.r2 > b.r2) parts.push({ r1: b.r2 + 1, c1: a.c1, r2: a.r2, c2: a.c2 });
    const top = Math.max(a.r1, b.r1);
    const bottom = Math.min(a.r2, b.r2);
    if (a.c1 < b.c1) parts.push({ r1: top, c1: a.c1, r2: bottom, c2: b.c1 - 1 });
    if (a.c2 > b.c2) parts.push({ r1: top, c1: b.c2 + 1, r2: bottom, c2: a.c2 });
    return parts;
  }

  /** Shifts a range for a row/column insert (count > 0) or delete (count < 0). Null if deleted. */
  function shiftRange(range, axis, at, count) {
    const k1 = axis === 'row' ? 'r1' : 'c1';
    const k2 = axis === 'row' ? 'r2' : 'c2';
    const out = { ...range };
    if (count > 0) {
      if (out[k1] >= at) out[k1] += count;
      if (out[k2] >= at) out[k2] += count;
      return out;
    }
    const n = -count;
    const end = at + n - 1;
    const a = out[k1];
    const b = out[k2];
    if (a >= at && b <= end) return null;
    out[k1] = a > end ? a - n : a >= at ? at : a;
    out[k2] = b > end ? b - n : b >= at ? at - 1 : b;
    return out[k2] < out[k1] ? null : out;
  }

  function shiftIndexMap(map, at, count) {
    const out = new Map();
    for (const [i, v] of map) {
      if (count < 0 && i >= at && i < at - count) continue;
      out.set(i >= at ? i + count : i, v);
    }
    return out;
  }

  function shiftIndexSet(set, at, count) {
    return new Set([...shiftIndexMap(new Map([...set].map((i) => [i, true])), at, count).keys()]);
  }

  /* ---------- Sheet ---------- */

  class Sheet {
    constructor(name) {
      this.id = 'sheet' + nextSheetId++;
      this.name = name;
      this.cells = new Map();
      this.colWidths = new Map();
      this.rowHeights = new Map();
      this.hiddenRows = new Set();
      this.filterHiddenRows = new Set();
      this.merges = [];
      this.validations = [];
      this.filter = null;
      this.frozenRows = 0;
      this.frozenCols = 0;
      this.rowCount = MIN_ROWS;
      this.colCount = MIN_COLS;
      this.state = 'visible';
      this.extras = {};
      this.boundsCache = null;
    }

    clone() {
      const s = new Sheet(this.name);
      s.id = this.id;
      s.cells = new Map(this.cells);
      s.colWidths = new Map(this.colWidths);
      s.rowHeights = new Map(this.rowHeights);
      s.hiddenRows = new Set(this.hiddenRows);
      s.filterHiddenRows = new Set(this.filterHiddenRows);
      s.merges = this.merges.map((m) => ({ ...m }));
      s.validations = this.validations.map((v) => ({ ranges: v.ranges.map((r) => ({ ...r })), rule: v.rule }));
      s.filter = this.filter ? { range: { ...this.filter.range }, conditions: this.filter.conditions.slice() } : null;
      s.frozenRows = this.frozenRows;
      s.frozenCols = this.frozenCols;
      s.rowCount = this.rowCount;
      s.colCount = this.colCount;
      s.state = this.state;
      s.extras = this.extras;
      return s;
    }

    getCell(row, col) {
      return this.cells.get(U.cellKey(row, col)) || null;
    }

    /** Raw write used by importers and operations; does not record history. */
    putCell(row, col, cell) {
      const key = U.cellKey(row, col);
      if (cell) this.cells.set(key, cell);
      else this.cells.delete(key);
      this.boundsCache = null;
    }

    /** Last used row/column (0-based); -1 when the sheet has no cells. */
    usedBounds() {
      if (!this.boundsCache) {
        let maxRow = -1;
        let maxCol = -1;
        for (const key of this.cells.keys()) {
          const { row, col } = U.keyToCell(key);
          if (row > maxRow) maxRow = row;
          if (col > maxCol) maxCol = col;
        }
        for (const m of this.merges) {
          maxRow = Math.max(maxRow, m.r2);
          maxCol = Math.max(maxCol, m.c2);
        }
        this.boundsCache = { maxRow, maxCol };
      }
      return this.boundsCache;
    }

    ensureSize(row, col) {
      const b = this.usedBounds();
      const needRows = Math.max(row, b.maxRow) + 1;
      const needCols = Math.max(col, b.maxCol) + 1;
      if (needRows + 20 > this.rowCount) this.rowCount = Math.min(U.MAX_ROWS, Math.max(MIN_ROWS, needRows + 100));
      if (needCols + 2 > this.colCount) this.colCount = Math.min(U.MAX_COLS, Math.max(MIN_COLS, needCols + 5));
    }

    isRowHidden(row) {
      return this.hiddenRows.has(row) || this.filterHiddenRows.has(row);
    }

    mergeAt(row, col) {
      return this.merges.find((m) => U.rangeContains(m, row, col)) || null;
    }
  }

  /* ---------- Workbook ---------- */

  class Workbook {
    constructor() {
      this.sheets = [];
      this.activeIndex = 0;
      this.extras = {};
      this.listeners = [];
      this.undoStack = [];
      this.redoStack = [];
      this.savedMarker = null;
      this.calcCache = new Map();
      this.evaluating = new Set();
      this.contexts = new Map();
    }

    static createBlank() {
      const wb = new Workbook();
      wb.sheets.push(new Sheet('Sheet1'));
      return wb;
    }

    on(listener) { this.listeners.push(listener); }

    emit(type) {
      this.calcCache.clear();
      for (const fn of this.listeners) fn({ type });
    }

    get activeSheet() { return this.sheets[this.activeIndex]; }

    sheetIndexById(id) { return this.sheets.findIndex((s) => s.id === id); }

    resolveSheet(name) {
      const lower = name.toLowerCase();
      return this.sheets.findIndex((s) => s.name.toLowerCase() === lower);
    }

    setActive(index) {
      if (index === this.activeIndex || !this.sheets[index]) return;
      this.activeIndex = index;
      this.emit('active');
    }

    /* ----- Calculation ----- */

    contextFor(sheetIndex) {
      let ctx = this.contexts.get(sheetIndex);
      if (!ctx) {
        ctx = {
          sheetIndex,
          resolveSheet: (name) => this.resolveSheet(name),
          getValue: (s, r, c) => this.getValue(s, r, c),
          getRangeCells: (s, range) => this.rangeCells(s, range),
          boundRange: (s, range) => this.boundRange(s, range),
        };
        this.contexts.set(sheetIndex, ctx);
      }
      return ctx;
    }

    boundRange(sheetIndex, range) {
      const b = this.sheets[sheetIndex].usedBounds();
      return { r1: range.r1, c1: range.c1, r2: Math.min(range.r2, b.maxRow), c2: Math.min(range.c2, b.maxCol) };
    }

    /** Non-empty cells of a range with their computed values. */
    rangeCells(sheetIndex, range) {
      const sheet = this.sheets[sheetIndex];
      const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
      const bounded = this.boundRange(sheetIndex, range);
      const cells = [];
      const boundedArea = Math.max(0, bounded.r2 - bounded.r1 + 1) * Math.max(0, bounded.c2 - bounded.c1 + 1);
      const push = (row, col) => {
        const value = this.getValue(sheetIndex, row, col);
        if (value !== null) cells.push({ row, col, value });
      };
      if (boundedArea <= sheet.cells.size) {
        for (let r = bounded.r1; r <= bounded.r2; r++) {
          for (let c = bounded.c1; c <= bounded.c2; c++) if (sheet.cells.has(U.cellKey(r, c))) push(r, c);
        }
      } else {
        for (const key of sheet.cells.keys()) {
          const { row, col } = U.keyToCell(key);
          if (U.rangeContains(bounded, row, col)) push(row, col);
        }
        cells.sort((a, b) => a.row - b.row || a.col - b.col);
      }
      return { area, cells };
    }

    /** Computed value of a cell (formulas evaluated, memoised until the next change). */
    getValue(sheetIndex, row, col) {
      const cell = this.sheets[sheetIndex] && this.sheets[sheetIndex].getCell(row, col);
      if (!cell) return null;
      if (!cell.formula) return cell.value;
      return this.compute(sheetIndex, row, col, cell).value;
    }

    /** Calculation details: { value, unsupported?: message } */
    compute(sheetIndex, row, col, cell) {
      const id = sheetIndex + ':' + U.cellKey(row, col);
      const cached = this.calcCache.get(id);
      if (cached) return cached;
      if (this.evaluating.has(id)) return { value: { error: '#CIRC!' }, circular: true };
      this.evaluating.add(id);
      let result;
      try {
        let value = F.evaluate(cell.formula, this.contextFor(sheetIndex));
        if (typeof value === 'number' && Object.is(value, -0)) value = 0;
        result = { value: value === undefined ? null : value };
      } catch (e) {
        const message = e instanceof F.UnsupportedError || e instanceof F.FormulaSyntaxError ? e.message : 'The formula could not be calculated.';
        const hasCached = cell.value !== null;
        result = { value: hasCached ? cell.value : { error: '#NAME?' }, unsupported: message, usesCachedValue: hasCached };
      } finally {
        this.evaluating.delete(id);
      }
      this.calcCache.set(id, result);
      return result;
    }

    /** What the grid shows: text plus hints for alignment and warnings. */
    getDisplay(sheetIndex, row, col) {
      const cell = this.sheets[sheetIndex].getCell(row, col);
      if (!cell) return { text: '', kind: 'empty' };
      let value = cell.value;
      let info = null;
      if (cell.formula) {
        info = this.compute(sheetIndex, row, col, cell);
        value = info.value;
      }
      const numFmt = cell.style && cell.style.numFmt;
      const out = { text: '', kind: 'empty' };
      if (value === null) out.kind = 'empty';
      else if (F.isError(value)) { out.text = value.error; out.kind = 'error'; }
      else if (typeof value === 'number') { out.text = U.formatNumber(value, numFmt); out.kind = 'number'; }
      else if (typeof value === 'boolean') { out.text = value ? 'TRUE' : 'FALSE'; out.kind = 'bool'; }
      else { out.text = String(value); out.kind = 'text'; }
      if (info && info.unsupported) {
        out.warning = info.usesCachedValue
          ? 'Not recalculated here: ' + info.unsupported + ' Showing the value saved in the file; Excel will recalculate it.'
          : info.unsupported + ' Excel will calculate it when you open the saved file.';
      } else if (info && info.circular) {
        out.warning = 'Circular reference: this formula depends on itself.';
      }
      return out;
    }

    /** Text shown in the formula bar / editor for a cell. */
    getInputText(sheetIndex, row, col) {
      const cell = this.sheets[sheetIndex].getCell(row, col);
      if (!cell) return '';
      if (cell.formula) return '=' + cell.formula;
      return U.valueToInputText(cell.value, cell.style && cell.style.numFmt);
    }

    /* ----- History ----- */

    snapshot() {
      return { sheets: this.sheets.map((s) => s.clone()), activeIndex: this.activeIndex };
    }

    restore(snap) {
      this.sheets = snap.sheets.map((s) => s.clone());
      this.activeIndex = Math.min(snap.activeIndex, this.sheets.length - 1);
      this.contexts.clear();
    }

    pushHistory(entry) {
      this.undoStack.push(entry);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }

    /** Applies a set of cell replacements as one undoable step. changes: Map(key -> cell|null) */
    commitCells(sheetIndex, changes, label) {
      if (changes.size === 0) return;
      const sheet = this.sheets[sheetIndex];
      const patch = [];
      for (const [key, after] of changes) {
        const before = sheet.cells.get(key) || null;
        if (before === after) continue;
        patch.push([key, before, after]);
        const { row, col } = U.keyToCell(key);
        sheet.putCell(row, col, after);
      }
      if (patch.length === 0) return;
      const b = sheet.usedBounds();
      sheet.ensureSize(b.maxRow, b.maxCol);
      this.pushHistory({ kind: 'cells', sheetId: sheet.id, patch, label });
      this.emit('cells');
    }

    /** Runs a structural change and records before/after snapshots. */
    transact(label, fn) {
      const before = this.snapshot();
      const result = fn();
      this.contexts.clear();
      this.pushHistory({ kind: 'snapshot', before, after: this.snapshot(), label });
      this.emit('structure');
      return result;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    undo() { return this.step(this.undoStack, this.redoStack, 'before'); }
    redo() { return this.step(this.redoStack, this.undoStack, 'after'); }

    step(from, to, side) {
      const entry = from.pop();
      if (!entry) return null;
      to.push(entry);
      if (entry.kind === 'snapshot') {
        this.restore(entry[side]);
      } else {
        const index = this.sheetIndexById(entry.sheetId);
        if (index >= 0) {
          const sheet = this.sheets[index];
          for (const [key, before, after] of entry.patch) {
            const { row, col } = U.keyToCell(key);
            sheet.putCell(row, col, side === 'before' ? before : after);
          }
          this.activeIndex = index;
        }
      }
      this.emit('structure');
      return entry.label;
    }

    markSaved() { this.savedMarker = this.undoStack[this.undoStack.length - 1] || null; }
    isDirty() { return (this.undoStack[this.undoStack.length - 1] || null) !== this.savedMarker; }

    /* ----- Cell editing ----- */

    /**
     * Stores what a user typed. Returns { ok: true } or { ok: false, message, canOverride }.
     * Data validation with errorStyle "warning"/"information" can be overridden by the caller.
     */
    setCellInput(sheetIndex, row, col, text, options) {
      const sheet = this.sheets[sheetIndex];
      const parsed = U.parseUserInput(text);
      if (parsed.formula !== null) {
        const problem = F.checkSyntax(parsed.formula);
        if (problem) return { ok: false, message: problem };
      }
      const cell = sheet.getCell(row, col);
      if (!(options && options.skipValidation) && parsed.formula === null) {
        const check = this.validateValue(sheetIndex, row, col, parsed.value);
        if (!check.ok) return check;
      }
      let style = cell ? cell.style : null;
      if (parsed.numFmt && (!style || !style.numFmt || style.numFmt === 'General')) {
        style = { ...(style || {}), numFmt: parsed.numFmt };
      }
      const next = withCell(cell, { value: parsed.formula !== null ? null : parsed.value, formula: parsed.formula, style });
      this.commitCells(sheetIndex, new Map([[U.cellKey(row, col), next]]), 'Edit ' + U.cellAddress(row, col));
      return { ok: true };
    }

    clearRanges(sheetIndex, ranges, what) {
      const sheet = this.sheets[sheetIndex];
      const changes = new Map();
      for (const range of ranges) {
        this.forEachExistingCell(sheet, range, (key, cell) => {
          let next;
          if (what === 'formats') next = withCell(cell, { style: null });
          else if (what === 'all') next = null;
          else next = withCell(cell, { value: null, formula: null });
          changes.set(key, next);
        });
      }
      this.commitCells(sheetIndex, changes, what === 'formats' ? 'Clear formatting' : 'Clear');
    }

    forEachExistingCell(sheet, range, fn) {
      const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
      if (area <= sheet.cells.size * 2) {
        for (let r = range.r1; r <= range.r2; r++) {
          for (let c = range.c1; c <= range.c2; c++) {
            const key = U.cellKey(r, c);
            const cell = sheet.cells.get(key);
            if (cell) fn(key, cell, r, c);
          }
        }
      } else {
        for (const [key, cell] of [...sheet.cells]) {
          const { row, col } = U.keyToCell(key);
          if (U.rangeContains(range, row, col)) fn(key, cell, row, col);
        }
      }
    }

    /** Applies a style mutation to every cell in the ranges (creating cells as needed). */
    updateStyle(sheetIndex, ranges, mutate, label) {
      return this.updateStyles(sheetIndex, ranges.map((range) => ({ range, mutate })), label);
    }

    /** Applies several { range, mutate } style changes as one undoable step; later ops build on earlier ones. */
    updateStyles(sheetIndex, ops, label) {
      const sheet = this.sheets[sheetIndex];
      const area = ops.reduce((n, op) => n + (op.range.r2 - op.range.r1 + 1) * (op.range.c2 - op.range.c1 + 1), 0);
      if (area > 2000000) return { ok: false, message: 'Select a smaller range to format (up to 2 million cells).' };
      const changes = new Map();
      for (const { range, mutate } of ops) {
        const memo = new Map();
        for (let r = range.r1; r <= range.r2; r++) {
          for (let c = range.c1; c <= range.c2; c++) {
            const key = U.cellKey(r, c);
            const cell = changes.has(key) ? changes.get(key) : sheet.cells.get(key) || null;
            const old = cell ? cell.style : null;
            let next = memo.get(old);
            if (next === undefined) {
              next = JSON.parse(JSON.stringify(old || {}));
              mutate(next);
              for (const k of Object.keys(next)) {
                const v = next[k];
                if (v == null || (typeof v === 'object' && Object.keys(v).length === 0)) delete next[k];
              }
              if (Object.keys(next).length === 0) next = null;
              memo.set(old, next);
            }
            changes.set(key, withCell(cell, { style: next }));
          }
        }
      }
      this.commitCells(sheetIndex, changes, label || 'Format cells');
      return { ok: true };
    }

    /* ----- Clipboard ----- */

    /** Copies a block: raw cells for internal paste and tab-separated display text for other apps. */
    copyRange(sheetIndex, range) {
      const sheet = this.sheets[sheetIndex];
      const cells = [];
      const lines = [];
      for (let r = range.r1; r <= range.r2; r++) {
        const rowCells = [];
        const rowText = [];
        for (let c = range.c1; c <= range.c2; c++) {
          rowCells.push(sheet.getCell(r, c));
          const t = this.getDisplay(sheetIndex, r, c).text;
          rowText.push(/[\t\n"]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);
        }
        cells.push(rowCells);
        lines.push(rowText.join('\t'));
      }
      return { sheetId: sheet.id, range, cells, text: lines.join('\r\n') };
    }

    /** Pastes cells copied inside the app; formulas shift like in Excel. Cut moves cells. */
    pasteCells(sheetIndex, row, col, clip, isCut) {
      const sheet = this.sheets[sheetIndex];
      const changes = new Map();
      const sourceIndex = this.sheetIndexById(clip.sheetId);
      if (isCut && sourceIndex === sheetIndex) {
        this.forEachExistingCell(sheet, clip.range, (key) => changes.set(key, null));
      }
      clip.cells.forEach((rowCells, i) => {
        rowCells.forEach((cell, j) => {
          const r = row + i;
          const c = col + j;
          if (r >= U.MAX_ROWS || c >= U.MAX_COLS) return;
          let next = cell;
          if (cell && cell.formula && !isCut) {
            next = withCell(cell, { formula: F.shiftFormula(cell.formula, r - (clip.range.r1 + i), c - (clip.range.c1 + j)), value: null });
          }
          changes.set(U.cellKey(r, c), next);
        });
      });
      if (isCut && sourceIndex >= 0 && sourceIndex !== sheetIndex) {
        const before = this.snapshot();
        const source = this.sheets[sourceIndex];
        this.forEachExistingCell(source, clip.range, (key) => source.cells.delete(key));
        source.boundsCache = null;
        for (const [key, cell] of changes) {
          const p = U.keyToCell(key);
          sheet.putCell(p.row, p.col, cell);
        }
        sheet.ensureSize(row + clip.cells.length, col + clip.cells[0].length);
        this.pushHistory({ kind: 'snapshot', before, after: this.snapshot(), label: 'Move cells' });
        this.emit('structure');
        return;
      }
      this.commitCells(sheetIndex, changes, isCut ? 'Move cells' : 'Paste');
    }

    /** Pastes plain text (tab-separated) from another application. */
    pasteText(sheetIndex, row, col, text) {
      const sheet = this.sheets[sheetIndex];
      const rows = U.parseCsv(text.replace(/\r?\n$/, ''), '\t');
      const changes = new Map();
      rows.forEach((values, i) => values.forEach((t, j) => {
        const r = row + i;
        const c = col + j;
        if (r >= U.MAX_ROWS || c >= U.MAX_COLS) return;
        const parsed = U.parseUserInput(t);
        if (parsed.formula !== null && F.checkSyntax(parsed.formula)) {
          parsed.value = t;
          parsed.formula = null;
        }
        const cell = sheet.getCell(r, c);
        let style = cell ? cell.style : null;
        if (parsed.numFmt && (!style || !style.numFmt)) style = { ...(style || {}), numFmt: parsed.numFmt };
        changes.set(U.cellKey(r, c), withCell(cell, { value: parsed.value, formula: parsed.formula, style }));
      }));
      this.commitCells(sheetIndex, changes, 'Paste');
      return { rows: rows.length, cols: rows.reduce((m, r) => Math.max(m, r.length), 0) };
    }

    /* ----- Rows and columns ----- */

    insertRows(sheetIndex, at, count) { return this.changeAxis(sheetIndex, 'row', at, count, 'Insert rows'); }
    deleteRows(sheetIndex, at, count) { return this.changeAxis(sheetIndex, 'row', at, -count, 'Delete rows'); }
    insertCols(sheetIndex, at, count) { return this.changeAxis(sheetIndex, 'col', at, count, 'Insert columns'); }
    deleteCols(sheetIndex, at, count) { return this.changeAxis(sheetIndex, 'col', at, -count, 'Delete columns'); }

    changeAxis(sheetIndex, axis, at, count, label) {
      const sheet = this.sheets[sheetIndex];
      const limit = axis === 'row' ? U.MAX_ROWS : U.MAX_COLS;
      const bounds = sheet.usedBounds();
      const last = axis === 'row' ? bounds.maxRow : bounds.maxCol;
      if (count > 0 && last + count >= limit) return { ok: false, message: 'There is no room to insert more ' + (axis === 'row' ? 'rows.' : 'columns.') };
      this.transact(label, () => {
        for (const s of this.sheets) {
          for (const [key, cell] of s.cells) {
            if (!cell.formula) continue;
            const f = F.adjustForStructureChange(cell.formula, s.name, sheet.name, axis, at, count);
            if (f !== cell.formula) s.cells.set(key, withCell(cell, { formula: f }));
          }
        }
        const moved = new Map();
        for (const [key, cell] of sheet.cells) {
          const { row, col } = U.keyToCell(key);
          let idx = axis === 'row' ? row : col;
          if (count < 0 && idx >= at && idx < at - count) continue;
          if (idx >= at) idx += count;
          moved.set(axis === 'row' ? U.cellKey(idx, col) : U.cellKey(row, idx), cell);
        }
        sheet.cells = moved;
        sheet.boundsCache = null;
        const sizes = axis === 'row' ? 'rowHeights' : 'colWidths';
        sheet[sizes] = shiftIndexMap(sheet[sizes], at, count);
        if (axis === 'row') {
          sheet.hiddenRows = shiftIndexSet(sheet.hiddenRows, at, count);
          sheet.filterHiddenRows = shiftIndexSet(sheet.filterHiddenRows, at, count);
          sheet.rowCount = Math.max(MIN_ROWS, Math.min(U.MAX_ROWS, sheet.rowCount + count));
        } else {
          sheet.colCount = Math.max(MIN_COLS, Math.min(U.MAX_COLS, sheet.colCount + count));
        }
        sheet.merges = sheet.merges.map((m) => shiftRange(m, axis, at, count))
          .filter((m) => m && (m.r1 !== m.r2 || m.c1 !== m.c2));
        sheet.validations = sheet.validations
          .map((v) => ({ rule: v.rule, ranges: v.ranges.map((r) => shiftRange(r, axis, at, count)).filter(Boolean) }))
          .filter((v) => v.ranges.length);
        if (sheet.filter) {
          const range = shiftRange(sheet.filter.range, axis, at, count);
          sheet.filter = range ? { range, conditions: this.shiftFilterConditions(sheet.filter.conditions, axis, at, count) } : null;
          if (!sheet.filter) sheet.filterHiddenRows = new Set();
        }
      });
      return { ok: true };
    }

    shiftFilterConditions(conditions, axis, at, count) {
      if (axis === 'row') return conditions;
      return conditions
        .filter((c) => !(count < 0 && c.col >= at && c.col < at - count))
        .map((c) => (c.col >= at ? { ...c, col: c.col + count } : c));
    }

    setColumnWidth(sheetIndex, cols, width) {
      this.transact('Resize column', () => {
        for (const c of cols) {
          if (Math.abs(width - DEFAULT_COL_WIDTH) < 1) this.sheets[sheetIndex].colWidths.delete(c);
          else this.sheets[sheetIndex].colWidths.set(c, Math.round(width));
        }
      });
    }

    setRowHeight(sheetIndex, rows, height) {
      this.transact('Resize row', () => {
        for (const r of rows) {
          if (Math.abs(height - DEFAULT_ROW_HEIGHT) < 1) this.sheets[sheetIndex].rowHeights.delete(r);
          else this.sheets[sheetIndex].rowHeights.set(r, Math.round(height));
        }
      });
    }

    setFrozen(sheetIndex, rows, cols) {
      this.transact('Freeze panes', () => {
        this.sheets[sheetIndex].frozenRows = rows;
        this.sheets[sheetIndex].frozenCols = cols;
      });
    }

    /* ----- Merging ----- */

    /** Number of non-empty cells besides the top-left that merging would discard. */
    mergeDataLoss(sheetIndex, range) {
      let count = 0;
      this.forEachExistingCell(this.sheets[sheetIndex], range, (key, cell, r, c) => {
        if ((r !== range.r1 || c !== range.c1) && (cell.value !== null || cell.formula)) count++;
      });
      return count;
    }

    merge(sheetIndex, range) {
      if (range.r1 === range.r2 && range.c1 === range.c2) return { ok: false, message: 'Select more than one cell to merge.' };
      this.transact('Merge cells', () => {
        const sheet = this.sheets[sheetIndex];
        this.forEachExistingCell(sheet, range, (key, cell, r, c) => {
          if (r !== range.r1 || c !== range.c1) sheet.putCell(r, c, withCell(cell, { value: null, formula: null }));
        });
        sheet.merges = sheet.merges.filter((m) => !U.rangesIntersect(m, range));
        sheet.merges.push({ ...range });
      });
      return { ok: true };
    }

    unmerge(sheetIndex, range) {
      const sheet = this.sheets[sheetIndex];
      if (!sheet.merges.some((m) => U.rangesIntersect(m, range))) return { ok: false, message: 'The selection has no merged cells.' };
      this.transact('Unmerge cells', () => {
        sheet.merges = sheet.merges.filter((m) => !U.rangesIntersect(m, range));
      });
      return { ok: true };
    }

    /* ----- Worksheets ----- */

    validateSheetName(name, exceptIndex) {
      const n = (name || '').trim();
      if (!n) return 'Enter a sheet name.';
      if (n.length > 31) return 'Sheet names can have at most 31 characters.';
      if (INVALID_SHEET_CHARS.test(n)) return 'Sheet names cannot contain \\ / ? * [ ] or :';
      if (n.startsWith("'") || n.endsWith("'")) return 'Sheet names cannot start or end with an apostrophe.';
      if (this.sheets.some((s, i) => i !== exceptIndex && s.name.toLowerCase() === n.toLowerCase())) return 'Another sheet already uses this name.';
      return null;
    }

    /** "Sheet4" for new sheets; "Name (2)", "Name (3)"… for copies. */
    uniqueSheetName(base) {
      if (!base) {
        let i = this.sheets.length + 1;
        while (this.resolveSheet('Sheet' + i) >= 0) i++;
        return 'Sheet' + i;
      }
      let i = 2;
      while (this.resolveSheet(base + ' (' + i + ')') >= 0) i++;
      return base + ' (' + i + ')';
    }

    addSheet() {
      return this.transact('Add sheet', () => {
        this.sheets.push(new Sheet(this.uniqueSheetName()));
        this.activeIndex = this.sheets.length - 1;
        return this.activeIndex;
      });
    }

    renameSheet(index, newName) {
      const name = newName.trim();
      const problem = this.validateSheetName(name, index);
      if (problem) return { ok: false, message: problem };
      const old = this.sheets[index].name;
      if (old === name) return { ok: true };
      this.transact('Rename sheet', () => {
        this.rewriteAllFormulas((f) => F.renameSheetInFormula(f, old, name));
        this.sheets[index].name = name;
      });
      return { ok: true };
    }

    deleteSheet(index) {
      if (this.sheets.length <= 1) return { ok: false, message: 'A workbook needs at least one sheet.' };
      const name = this.sheets[index].name;
      this.transact('Delete sheet', () => {
        this.sheets.splice(index, 1);
        this.rewriteAllFormulas((f) => F.removeSheetFromFormula(f, name));
        this.activeIndex = Math.min(this.activeIndex, this.sheets.length - 1);
      });
      return { ok: true };
    }

    moveSheet(from, to) {
      if (to < 0 || to >= this.sheets.length || from === to) return;
      this.transact('Move sheet', () => {
        const [sheet] = this.sheets.splice(from, 1);
        this.sheets.splice(to, 0, sheet);
        this.activeIndex = to;
      });
    }

    duplicateSheet(index) {
      this.transact('Duplicate sheet', () => {
        const copy = this.sheets[index].clone();
        copy.id = new Sheet('x').id;
        copy.name = this.uniqueSheetName(this.sheets[index].name.replace(/ \(\d+\)$/, '').slice(0, 25));
        this.sheets.splice(index + 1, 0, copy);
        this.activeIndex = index + 1;
      });
    }

    rewriteAllFormulas(rewrite) {
      for (const s of this.sheets) {
        for (const [key, cell] of s.cells) {
          if (!cell.formula) continue;
          const f = rewrite(cell.formula);
          if (f !== cell.formula) s.cells.set(key, withCell(cell, { formula: f }));
        }
      }
    }

    /* ----- Sorting ----- */

    sortRange(sheetIndex, range, keys, hasHeader) {
      const sheet = this.sheets[sheetIndex];
      if (sheet.merges.some((m) => U.rangesIntersect(m, range))) {
        return { ok: false, message: 'Sorting is not possible because the range contains merged cells. Unmerge them first.' };
      }
      const start = hasHeader ? range.r1 + 1 : range.r1;
      if (start >= range.r2) return { ok: false, message: 'There is nothing to sort: select at least two rows of data.' };
      const rows = [];
      for (let r = start; r <= range.r2; r++) {
        rows.push({ row: r, keys: keys.map((k) => this.getValue(sheetIndex, r, k.col)) });
      }
      const rank = (v) => (v === null || v === '' ? 2 : F.isError(v) ? 1 : 0);
      rows.sort((a, b) => {
        for (let i = 0; i < keys.length; i++) {
          const va = a.keys[i];
          const vb = b.keys[i];
          const ra = rank(va);
          const rb = rank(vb);
          if (ra !== rb) return ra - rb; // blanks and errors always last
          if (ra !== 0) continue;
          const cmp = F.compareValues(va, vb);
          if (cmp !== 0) return keys[i].ascending ? cmp : -cmp;
        }
        return a.row - b.row;
      });
      const changes = new Map();
      rows.forEach((item, i) => {
        const target = start + i;
        for (let c = range.c1; c <= range.c2; c++) {
          let cell = sheet.getCell(item.row, c);
          if (cell && cell.formula && target !== item.row) {
            cell = withCell(cell, { formula: F.shiftFormula(cell.formula, target - item.row, 0) });
          }
          changes.set(U.cellKey(target, c), cell);
        }
      });
      this.commitCells(sheetIndex, changes, 'Sort');
      return { ok: true, count: rows.length };
    }

    /** Expands from a cell to the surrounding block of non-empty cells (like Ctrl+A in Excel). */
    currentRegion(sheetIndex, row, col) {
      const sheet = this.sheets[sheetIndex];
      const filled = (r, c) => r >= 0 && c >= 0 && sheet.cells.has(U.cellKey(r, c)) && this.getValue(sheetIndex, r, c) !== null;
      const region = { r1: row, c1: col, r2: row, c2: col };
      let grew = true;
      let guard = 0;
      while (grew && guard++ < 10000) {
        grew = false;
        const scan = (r1, c1, r2, c2) => {
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (filled(r, c)) return true;
          return false;
        };
        if (region.r1 > 0 && scan(region.r1 - 1, Math.max(0, region.c1 - 1), region.r1 - 1, region.c2 + 1)) { region.r1--; grew = true; }
        if (scan(region.r2 + 1, Math.max(0, region.c1 - 1), region.r2 + 1, region.c2 + 1)) { region.r2++; grew = true; }
        if (region.c1 > 0 && scan(Math.max(0, region.r1 - 1), region.c1 - 1, region.r2 + 1, region.c1 - 1)) { region.c1--; grew = true; }
        if (scan(Math.max(0, region.r1 - 1), region.c2 + 1, region.r2 + 1, region.c2 + 1)) { region.c2++; grew = true; }
      }
      return region;
    }

    /** Guesses whether the first row of a range is a header (text above other types). */
    guessHeader(sheetIndex, range) {
      if (range.r2 <= range.r1) return false;
      let headerText = 0;
      let bodyNonText = 0;
      for (let c = range.c1; c <= range.c2; c++) {
        const h = this.getValue(sheetIndex, range.r1, c);
        const b = this.getValue(sheetIndex, range.r1 + 1, c);
        if (typeof h === 'string') headerText++;
        if (b !== null && typeof b !== 'string') bodyNonText++;
      }
      const width = range.c2 - range.c1 + 1;
      return headerText === width || (headerText > 0 && bodyNonText > 0);
    }

    /* ----- Filtering ----- */

    applyFilter(sheetIndex, range, conditions) {
      this.transact(conditions.length ? 'Filter' : 'Clear filter', () => {
        const sheet = this.sheets[sheetIndex];
        sheet.filter = conditions.length ? { range: { ...range }, conditions: conditions.slice() } : null;
        sheet.filterHiddenRows = new Set();
        if (!sheet.filter) return;
        for (let r = range.r1 + 1; r <= range.r2; r++) {
          const visible = conditions.every((cond) => this.matchesCondition(sheetIndex, r, cond));
          if (!visible) sheet.filterHiddenRows.add(r);
        }
      });
      return { ok: true, hidden: this.sheets[sheetIndex].filterHiddenRows.size };
    }

    matchesCondition(sheetIndex, row, cond) {
      const value = this.getValue(sheetIndex, row, cond.col);
      const shown = this.getDisplay(sheetIndex, row, cond.col).text.toLowerCase();
      const target = String(cond.value == null ? '' : cond.value).toLowerCase();
      const targetNum = U.parseNumber(target);
      const numeric = typeof value === 'number' && targetNum !== null;
      const cmp = numeric ? value - targetNum : shown < target ? -1 : shown > target ? 1 : 0;
      switch (cond.op) {
        case 'contains': return shown.includes(target);
        case 'notContains': return !shown.includes(target);
        case 'equals': return numeric ? value === targetNum : shown === target;
        case 'notEquals': return numeric ? value !== targetNum : shown !== target;
        case 'gt': return value !== null && cmp > 0;
        case 'lt': return value !== null && cmp < 0;
        case 'gte': return value !== null && cmp >= 0;
        case 'lte': return value !== null && cmp <= 0;
        case 'empty': return value === null || value === '';
        case 'notEmpty': return value !== null && value !== '';
        default: return true;
      }
    }

    /* ----- Find and replace ----- */

    findMatches(options) {
      const { query, matchCase, wholeCell, lookIn, scope, sheetIndex } = options;
      if (!query) return [];
      const needle = matchCase ? query : query.toLowerCase();
      const indexes = scope === 'workbook' ? this.sheets.map((_, i) => i) : [sheetIndex];
      const matches = [];
      for (const s of indexes) {
        const sheet = this.sheets[s];
        const found = [];
        for (const key of sheet.cells.keys()) {
          const { row, col } = U.keyToCell(key);
          let hay = lookIn === 'formulas' ? this.getInputText(s, row, col) : this.getDisplay(s, row, col).text;
          if (!matchCase) hay = hay.toLowerCase();
          if (wholeCell ? hay === needle : hay.includes(needle)) found.push({ sheetIndex: s, row, col });
        }
        found.sort((a, b) => a.row - b.row || a.col - b.col);
        matches.push(...found);
      }
      return matches;
    }

    /** Replaces text in cell contents (formulas included). Returns counts of replaced and skipped cells. */
    replaceMatches(matches, options) {
      const flags = options.matchCase ? 'g' : 'gi';
      const pattern = new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const bySheet = new Map();
      let skipped = 0;
      for (const m of matches) {
        const sheet = this.sheets[m.sheetIndex];
        const cell = sheet.getCell(m.row, m.col);
        const input = this.getInputText(m.sheetIndex, m.row, m.col);
        let text;
        if (options.wholeCell) {
          text = (options.matchCase ? input === options.query : input.toLowerCase() === options.query.toLowerCase()) ? options.replacement : null;
        } else {
          text = pattern.test(input) ? input.replace(pattern, () => options.replacement) : null;
          pattern.lastIndex = 0;
        }
        if (text === null) { skipped++; continue; }
        const parsed = U.parseUserInput(text);
        if (parsed.formula !== null && F.checkSyntax(parsed.formula)) { skipped++; continue; }
        if (!bySheet.has(m.sheetIndex)) bySheet.set(m.sheetIndex, new Map());
        bySheet.get(m.sheetIndex).set(U.cellKey(m.row, m.col), withCell(cell, { value: parsed.formula !== null ? null : parsed.value, formula: parsed.formula }));
      }
      let replaced = 0;
      if (bySheet.size === 1) {
        const [[s, changes]] = [...bySheet];
        replaced = changes.size;
        this.commitCells(s, changes, 'Replace');
      } else if (bySheet.size > 1) {
        this.transact('Replace', () => {
          for (const [s, changes] of bySheet) {
            for (const [key, cell] of changes) {
              const p = U.keyToCell(key);
              this.sheets[s].putCell(p.row, p.col, cell);
              replaced++;
            }
          }
        });
      }
      return { replaced, skipped };
    }

    /* ----- Data validation ----- */

    getValidation(sheetIndex, row, col) {
      const v = this.sheets[sheetIndex].validations.find((item) => item.ranges.some((r) => U.rangeContains(r, row, col)));
      return v ? v.rule : null;
    }

    setValidation(sheetIndex, range, rule) {
      this.transact(rule ? 'Set data validation' : 'Remove data validation', () => {
        const sheet = this.sheets[sheetIndex];
        sheet.validations = sheet.validations
          .map((v) => ({ rule: v.rule, ranges: v.ranges.flatMap((r) => subtractRange(r, range)) }))
          .filter((v) => v.ranges.length);
        if (rule) sheet.validations.unshift({ ranges: [{ ...range }], rule });
      });
    }

    validateValue(sheetIndex, row, col, value) {
      const rule = this.getValidation(sheetIndex, row, col);
      if (!rule || checkRule(rule, value)) return { ok: true };
      const message = rule.error || describeRule(rule);
      const style = rule.errorStyle || 'stop';
      return { ok: false, message, canOverride: style !== 'stop' };
    }

    /** Cells in the sheet whose current value breaks their validation rule. */
    findInvalidCells(sheetIndex) {
      const sheet = this.sheets[sheetIndex];
      const keys = new Set();
      for (const v of sheet.validations) {
        for (const range of v.ranges) {
          const b = this.boundRange(sheetIndex, range);
          for (let r = b.r1; r <= b.r2; r++) {
            for (let c = b.c1; c <= b.c2; c++) {
              if (this.getValidation(sheetIndex, r, c) !== v.rule) continue;
              if (!checkRule(v.rule, this.getValue(sheetIndex, r, c))) keys.add(U.cellKey(r, c));
            }
          }
        }
      }
      return keys;
    }

    /* ----- Analysis ----- */

    /** Groups cells in a range by displayed text (trimmed, case-insensitive). */
    findDuplicates(sheetIndex, range) {
      const groups = new Map();
      for (const cell of this.rangeCells(sheetIndex, range).cells) {
        const text = this.getDisplay(sheetIndex, cell.row, cell.col).text.trim().toLowerCase();
        if (!text) continue;
        if (!groups.has(text)) groups.set(text, []);
        groups.get(text).push(U.cellKey(cell.row, cell.col));
      }
      const keys = new Set();
      let groupCount = 0;
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        groupCount++;
        list.forEach((k) => keys.add(k));
      }
      return { keys, groupCount };
    }

    selectionStats(sheetIndex, range) {
      const { cells } = this.rangeCells(sheetIndex, range);
      let sum = 0;
      let numbers = 0;
      let count = 0;
      for (const c of cells) {
        if (c.value === '') continue;
        count++;
        if (typeof c.value === 'number') { sum += c.value; numbers++; }
      }
      return { count, numbers, sum, average: numbers ? sum / numbers : null };
    }
  }

  /* ---------- Validation rules (ExcelJS dataValidation shape) ---------- */

  const SUPPORTED_RULES = ['whole', 'decimal', 'list', 'textLength'];

  function ruleOperands(rule) {
    return (rule.formulae || []).map((f) => (typeof f === 'number' ? f : U.parseNumber(String(f))));
  }

  function listItems(rule) {
    const src = String((rule.formulae || [])[0] || '');
    const m = /^"(.*)"$/s.exec(src);
    return m ? m[1].split(',').map((s) => s.trim()) : null;
  }

  function compareOp(op, x, a, b) {
    switch (op || 'between') {
      case 'between': return x >= a && x <= b;
      case 'notBetween': return x < a || x > b;
      case 'equal': return x === a;
      case 'notEqual': return x !== a;
      case 'greaterThan': return x > a;
      case 'lessThan': return x < a;
      case 'greaterThanOrEqual': return x >= a;
      case 'lessThanOrEqual': return x <= a;
      default: return true;
    }
  }

  function checkRule(rule, value) {
    if (value === null || value === '') return rule.allowBlank !== false;
    if (!SUPPORTED_RULES.includes(rule.type)) return true; // preserved from file, not enforced
    if (rule.type === 'list') {
      const items = listItems(rule);
      if (!items) return true; // list from a cell range: not enforced
      const text = F.toText(value).toLowerCase();
      return items.some((i) => i.toLowerCase() === text);
    }
    const [a, b] = ruleOperands(rule);
    if (a === null || a === undefined) return true;
    if (rule.type === 'textLength') return compareOp(rule.operator, F.toText(value).length, a, b);
    if (typeof value !== 'number') return false;
    if (rule.type === 'whole' && !Number.isInteger(value)) return false;
    return compareOp(rule.operator, value, a, b);
  }

  const OPERATOR_TEXT = {
    between: 'between {a} and {b}', notBetween: 'not between {a} and {b}', equal: 'equal to {a}',
    notEqual: 'not equal to {a}', greaterThan: 'greater than {a}', lessThan: 'less than {a}',
    greaterThanOrEqual: 'at least {a}', lessThanOrEqual: 'at most {a}',
  };

  function describeRule(rule) {
    if (rule.type === 'list') {
      const items = listItems(rule);
      return items ? 'Choose one of: ' + items.join(', ') + '.' : 'Choose a value from the list.';
    }
    const [a, b] = rule.formulae || [];
    const cond = (OPERATOR_TEXT[rule.operator || 'between'] || '').replace('{a}', a).replace('{b}', b);
    const subject = rule.type === 'whole' ? 'a whole number' : rule.type === 'decimal' ? 'a number' : 'text with a length';
    return 'Enter ' + subject + ' ' + cond + '.';
  }

  /** Changes the number of decimals in a number format (for the .0 / .00 buttons). */
  function adjustDecimals(fmt, delta, sample) {
    let base = fmt && fmt !== 'General' ? fmt : null;
    if (!base) {
      const decimals = typeof sample === 'number' && !Number.isInteger(sample) ? Math.min(10, (String(sample).split('.')[1] || '').length) : 0;
      base = decimals ? '0.' + '0'.repeat(decimals) : '0';
    }
    if (U.isDateFormat(base)) return base;
    const m = /0(\.0*)?/.exec(base.split(';')[0].replace(/"[^"]*"/g, (s) => s.replace(/0/g, ' ')));
    if (!m) return base;
    const current = m[1] ? m[1].length - 1 : 0;
    const next = Math.max(0, Math.min(15, current + delta));
    const replacement = next ? '0.' + '0'.repeat(next) : '0';
    return base.split(';').map((part) => part.replace(/0(\.0*)?/, replacement)).join(';');
  }

  SheetApp.spreadsheet = {
    Workbook, Sheet, makeCell, withCell, subtractRange, shiftRange,
    checkRule, describeRule, adjustDecimals, SUPPORTED_RULES,
    DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
