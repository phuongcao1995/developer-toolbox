/*
 * grid.js — the spreadsheet grid view.
 * Renders only the visible cells into four panes (frozen corner, frozen top, frozen left, body),
 * and handles selection, editing, keyboard navigation, resizing and the clipboard.
 * Cell text is always written with textContent.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;
  const F = SheetApp.formula;
  const { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } = SheetApp.spreadsheet;

  const HEADER_HEIGHT = 26;
  const RESIZE_ZONE = 5;
  const MIN_SIZE = 12;
  const EXTRA_RENDER = 2; // rows/cols rendered beyond the viewport for smoother scrolling
  const REF_COLORS = ['#1a73e8', '#d93025', '#188038', '#9334e6', '#e8710a', '#129eaf']; // one per reference while a formula is edited
  const BORDER_CSS = {
    thin: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', dotted: '1px dotted',
    hair: '1px dotted', double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed',
    mediumDashDot: '2px dashed', dashDotDot: '1px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed',
  };

  /** Positions along one axis with a default size and sparse overrides. */
  class Axis {
    constructor(defaultSize) {
      this.def = defaultSize;
      this.setSizes(new Map());
    }

    setSizes(sizes) {
      this.sizes = sizes;
      this.keys = [...sizes.keys()].sort((a, b) => a - b);
      this.prefix = [];
      let acc = 0;
      for (const k of this.keys) {
        acc += sizes.get(k) - this.def;
        this.prefix.push(acc);
      }
    }

    size(i) { return this.sizes.has(i) ? this.sizes.get(i) : this.def; }

    offset(i) {
      let lo = 0;
      let hi = this.keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.keys[mid] < i) lo = mid + 1; else hi = mid;
      }
      return i * this.def + (lo ? this.prefix[lo - 1] : 0);
    }

    indexAt(pos, count) {
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.offset(mid) <= pos) lo = mid; else hi = mid - 1;
      }
      return Math.max(0, lo);
    }
  }

  function cellStyleCss(style, kind) {
    const css = {};
    const font = style && style.font;
    if (font) {
      if (font.bold) css.fontWeight = '700';
      if (font.italic) css.fontStyle = 'italic';
      const deco = [];
      if (font.underline) deco.push('underline');
      if (font.strike) deco.push('line-through');
      if (deco.length) css.textDecoration = deco.join(' ');
      if (font.size) css.fontSize = Math.round((font.size * 4) / 3) + 'px';
      if (font.name) css.fontFamily = '"' + font.name.replace(/["\\]/g, '') + '", var(--font-ui)';
      const color = U.argbToCss(font.color);
      if (color) css.color = color;
    }
    const fill = style && style.fill;
    if (fill && fill.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
      const bg = U.argbToCss(fill.fgColor) || U.argbToCss(fill.bgColor);
      if (bg) css.background = bg;
    }
    const align = (style && style.alignment) || {};
    const horizontal = align.horizontal && align.horizontal !== 'general'
      ? align.horizontal : kind === 'number' ? 'right' : kind === 'bool' || kind === 'error' ? 'center' : 'left';
    css.justifyContent = horizontal === 'right' ? 'flex-end' : horizontal === 'center' || horizontal === 'centerContinuous' ? 'center' : 'flex-start';
    css.textAlign = horizontal === 'right' ? 'right' : horizontal === 'center' || horizontal === 'centerContinuous' ? 'center' : 'left';
    css.alignItems = align.vertical === 'top' ? 'flex-start' : align.vertical === 'middle' ? 'center' : 'flex-end';
    if (align.wrapText) css.whiteSpace = 'pre-wrap';
    if (align.indent) css.paddingLeft = 4 + align.indent * 9 + 'px';
    const border = style && style.border;
    if (border) {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const b = border[side];
        if (b && b.style) css['border' + side[0].toUpperCase() + side.slice(1)] = (BORDER_CSS[b.style] || '1px solid') + ' ' + (U.argbToCss(b.color) || '#1c2421');
      }
    }
    return { css, horizontal, wrap: !!align.wrapText };
  }

  class GridView {
    /**
     * handlers: onSelectionChange(), onEditInput(text), commitInput(row, col, text) -> Promise<boolean>,
     *           onContextMenu(event, hit), onStatus(message), onClipboardPaste()
     */
    constructor(container, workbook, handlers) {
      this.container = container;
      this.wb = workbook;
      this.handlers = handlers;
      this.rowAxis = new Axis(DEFAULT_ROW_HEIGHT);
      this.colAxis = new Axis(DEFAULT_COL_WIDTH);
      this.anchor = { row: 0, col: 0 };
      this.focusCell = { row: 0, col: 0 };
      this.editing = null;
      this.clipboard = null;
      this.highlights = { keys: new Set(), className: '' };
      this.renderPending = false;
      this.sheetViews = new Map(); // sheet id -> { anchor, focus, scrollLeft, scrollTop }
      this.currentSheetId = null;
      this.buildDom();
      this.bindEvents();
      this.layout();
    }

    /* ---------- DOM ---------- */

    buildDom() {
      const el = U.el;
      this.scroller = el('div', { class: 'grid-scroller' });
      this.sizer = el('div', { class: 'grid-sizer' });
      this.stage = el('div', { class: 'grid-stage', role: 'grid', 'aria-label': 'Spreadsheet cells' });
      const pane = (cls) => el('div', { class: 'grid-pane ' + cls });
      this.panes = {
        colHeadFrozen: pane('col-head'), colHeadBody: pane('col-head'),
        rowHeadFrozen: pane('row-head'), rowHeadBody: pane('row-head'),
        corner: pane('cells pane-corner'), top: pane('cells pane-top'), left: pane('cells pane-left'), body: pane('cells pane-body'),
      };
      this.cornerHeader = el('button', { class: 'grid-corner', type: 'button', 'aria-label': 'Select all cells', title: 'Select all (Ctrl+A)' });
      this.editor = el('textarea', {
        class: 'cell-editor', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
        'aria-label': 'Cell input', 'aria-multiline': 'true', rows: '1',
      });
      this.guide = el('div', { class: 'resize-guide', hidden: true });
      this.live = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
      this.stage.append(...Object.values(this.panes), this.cornerHeader, this.guide, this.editor);
      this.sizer.append(this.stage);
      this.scroller.append(this.sizer);
      this.container.append(this.scroller, this.live);
    }

    bindEvents() {
      this.scroller.addEventListener('scroll', () => this.scheduleRender());
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.scheduleRender()).observe(this.scroller);
      this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.stage.addEventListener('dblclick', (e) => this.onDoubleClick(e));
      this.stage.addEventListener('contextmenu', (e) => this.onContextMenu(e));
      this.stage.addEventListener('pointermove', (e) => this.updateCursor(e));
      this.cornerHeader.addEventListener('click', () => this.selectAll());
      this.editor.addEventListener('keydown', (e) => this.onKeyDown(e));
      this.editor.addEventListener('input', () => this.onEditorInput());
      this.editor.addEventListener('keyup', () => { if (this.editing) this.updateAssist(); });
      this.editor.addEventListener('click', () => { if (this.editing) this.updateAssist(); });
      this.editor.addEventListener('compositionstart', () => { if (!this.editing) this.beginEdit('', true, false); });
      this.editor.addEventListener('copy', (e) => this.onCopy(e, false));
      this.editor.addEventListener('cut', (e) => this.onCopy(e, true));
      this.editor.addEventListener('paste', (e) => this.onPaste(e));
      this.editor.addEventListener('blur', () => {
        // Commit when focus leaves for something other than the formula bar.
        setTimeout(() => {
          const target = document.activeElement;
          if (this.editing && target && target.hasAttribute && target.hasAttribute('data-keeps-edit')) this.editing.viaBar = true;
          if (this.editing && target !== this.editor && !this.editing.viaBar) this.commitEdit(0, 0);
        }, 0);
      });
    }

    setWorkbook(wb) {
      this.wb = wb;
      this.sheetViews = new Map();
      this.currentSheetId = wb.activeSheet.id;
      this.anchor = { row: 0, col: 0 };
      this.focusCell = { row: 0, col: 0 };
      this.editing = null;
      this.clipboard = null;
      this.clearHighlights();
      this.scroller.scrollTo(0, 0);
      this.layout();
    }

    get sheet() { return this.wb.activeSheet; }

    /** Rebuild axis sizes from the sheet (after structure changes or switching sheets). */
    /** Each sheet remembers its own selection and scroll position, like Excel. */
    switchSheetView() {
      const id = this.sheet.id;
      if (id === this.currentSheetId) return;
      if (this.currentSheetId) {
        this.sheetViews.set(this.currentSheetId, {
          anchor: this.anchor, focus: this.focusCell, scrollLeft: this.scroller.scrollLeft, scrollTop: this.scroller.scrollTop,
        });
      }
      const view = this.sheetViews.get(id) || { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 }, scrollLeft: 0, scrollTop: 0 };
      this.currentSheetId = id;
      this.anchor = view.anchor;
      this.focusCell = view.focus;
      this.clearHighlights();
      this.pendingScroll = view;
    }

    layout() {
      this.switchSheetView();
      const sheet = this.sheet;
      const rows = new Map(sheet.rowHeights);
      for (const r of sheet.hiddenRows) rows.set(r, 0);
      for (const r of sheet.filterHiddenRows) rows.set(r, 0);
      this.rowAxis.setSizes(rows);
      const cols = new Map(sheet.colWidths);
      for (const c of sheet.hiddenCols) cols.set(c, 0);
      this.colAxis.setSizes(cols);
      this.rowHeadWidth = Math.max(44, String(sheet.rowCount).length * 8 + 20);
      this.clampSelection();
      if (this.pendingScroll) {
        // Size the scroll area first so the saved position can be restored.
        this.renderNow();
        this.scroller.scrollLeft = this.pendingScroll.scrollLeft;
        this.scroller.scrollTop = this.pendingScroll.scrollTop;
        this.pendingScroll = null;
      }
      this.renderNow();
    }

    clampSelection() {
      const s = this.sheet;
      const clampCell = (p) => ({ row: Math.min(p.row, s.rowCount - 1), col: Math.min(p.col, s.colCount - 1) });
      this.anchor = clampCell(this.anchor);
      this.focusCell = clampCell(this.focusCell);
    }

    scheduleRender() {
      if (this.renderPending) return;
      this.renderPending = true;
      requestAnimationFrame(() => {
        this.renderPending = false;
        this.renderNow();
      });
    }

    /* ---------- Geometry ---------- */

    metrics() {
      const s = this.sheet;
      const frozenRows = Math.min(s.frozenRows, s.rowCount - 1);
      const frozenCols = Math.min(s.frozenCols, s.colCount - 1);
      return {
        frozenRows, frozenCols,
        frozenW: this.colAxis.offset(frozenCols),
        frozenH: this.rowAxis.offset(frozenRows),
        sl: this.scroller.scrollLeft,
        st: this.scroller.scrollTop,
        vw: this.scroller.clientWidth,
        vh: this.scroller.clientHeight,
        rh: this.rowHeadWidth,
      };
    }

    /** Converts stage coordinates to what is under the pointer. */
    hitTest(x, y) {
      const m = this.metrics();
      const s = this.sheet;
      const contentX = x - m.rh < m.frozenW ? x - m.rh : x - m.rh + m.sl;
      const contentY = y - HEADER_HEIGHT < m.frozenH ? y - HEADER_HEIGHT : y - HEADER_HEIGHT + m.st;
      const col = this.colAxis.indexAt(contentX, s.colCount);
      const row = this.rowAxis.indexAt(contentY, s.rowCount);
      if (x < m.rh && y < HEADER_HEIGHT) return { area: 'corner' };
      if (y < HEADER_HEIGHT) {
        const right = this.colAxis.offset(col + 1) - contentX;
        const left = contentX - this.colAxis.offset(col);
        if (right <= RESIZE_ZONE) return { area: 'colresize', col };
        if (left <= RESIZE_ZONE && col > 0) return { area: 'colresize', col: this.prevVisibleCol(col) };
        return { area: 'colhead', col };
      }
      if (x < m.rh) {
        const bottom = this.rowAxis.offset(row + 1) - contentY;
        const top = contentY - this.rowAxis.offset(row);
        if (bottom <= RESIZE_ZONE) return { area: 'rowresize', row };
        if (top <= RESIZE_ZONE && row > 0) return { area: 'rowresize', row: this.prevVisibleRow(row) };
        return { area: 'rowhead', row };
      }
      return { area: 'cell', row, col };
    }

    prevVisibleRow(row) {
      let r = row - 1;
      while (r > 0 && this.rowAxis.size(r) === 0) r--;
      return Math.max(0, r);
    }

    prevVisibleCol(col) { return Math.max(0, col - 1); }

    stagePoint(e) {
      const rect = this.stage.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    /** Stage rectangle of a range (used for the editor). */
    rangeStageRect(range) {
      const m = this.metrics();
      const x1 = this.colAxis.offset(range.c1);
      const y1 = this.rowAxis.offset(range.r1);
      const w = this.colAxis.offset(range.c2 + 1) - x1;
      const h = this.rowAxis.offset(range.r2 + 1) - y1;
      return {
        x: m.rh + x1 - (range.c1 >= m.frozenCols ? m.sl : 0),
        y: HEADER_HEIGHT + y1 - (range.r1 >= m.frozenRows ? m.st : 0),
        w, h,
      };
    }

    /* ---------- Selection ---------- */

    expandForMerges(range) {
      const r = { ...range };
      let changed = true;
      while (changed) {
        changed = false;
        for (const m of this.sheet.merges) {
          if (!U.rangesIntersect(m, r)) continue;
          if (m.r1 < r.r1 || m.c1 < r.c1 || m.r2 > r.r2 || m.c2 > r.c2) {
            r.r1 = Math.min(r.r1, m.r1); r.c1 = Math.min(r.c1, m.c1);
            r.r2 = Math.max(r.r2, m.r2); r.c2 = Math.max(r.c2, m.c2);
            changed = true;
          }
        }
      }
      return r;
    }

    getSelection() {
      const range = this.expandForMerges(U.normalizeRange(this.anchor.row, this.anchor.col, this.focusCell.row, this.focusCell.col));
      return { active: { ...this.anchor }, range };
    }

    select(anchor, focus, options) {
      const s = this.sheet;
      const grow = (p) => {
        if (p.row >= s.rowCount - 1 && s.rowCount < U.MAX_ROWS) s.rowCount = Math.min(U.MAX_ROWS, p.row + 101);
        if (p.col >= s.colCount - 1 && s.colCount < U.MAX_COLS) s.colCount = Math.min(U.MAX_COLS, p.col + 6);
        return { row: U.clamp(p.row, 0, s.rowCount - 1), col: U.clamp(p.col, 0, s.colCount - 1) };
      };
      this.anchor = grow(anchor);
      this.focusCell = grow(focus || anchor);
      if (!options || options.scroll !== false) this.scrollIntoView(this.focusCell.row, this.focusCell.col);
      this.renderNow();
      this.handlers.onSelectionChange();
      this.announce();
    }

    selectRange(range, active) {
      this.select(active || { row: range.r1, col: range.c1 }, { row: range.r2, col: range.c2 });
      if (active) {
        this.anchor = active;
        this.focusCell = { row: range.r1 === active.row ? range.r2 : range.r1, col: range.c1 === active.col ? range.c2 : range.c1 };
        this.renderNow();
      }
    }

    selectAll() {
      this.select({ row: 0, col: 0 }, { row: this.sheet.rowCount - 1, col: this.sheet.colCount - 1 }, { scroll: false });
      this.focus();
    }

    announce() {
      clearTimeout(this.announceTimer);
      this.announceTimer = setTimeout(() => {
        const { row, col } = this.anchor;
        const shown = this.wb.getDisplay(this.wb.activeIndex, row, col).text;
        this.live.textContent = U.cellAddress(row, col) + (shown ? ', ' + shown : ', empty');
      }, 150);
    }

    scrollIntoView(row, col) {
      const m = this.metrics();
      if (col >= m.frozenCols) {
        const x = this.colAxis.offset(col);
        const w = this.colAxis.size(col);
        const viewW = m.vw - m.rh - m.frozenW;
        const left = m.sl + m.frozenW;
        if (x < left) this.scroller.scrollLeft = x - m.frozenW;
        else if (x + w > left + viewW) this.scroller.scrollLeft = x + w - viewW - m.frozenW;
      }
      if (row >= m.frozenRows) {
        const y = this.rowAxis.offset(row);
        const h = this.rowAxis.size(row);
        const viewH = m.vh - HEADER_HEIGHT - m.frozenH;
        const top = m.st + m.frozenH;
        if (y < top) this.scroller.scrollTop = y - m.frozenH;
        else if (y + h > top + viewH) this.scroller.scrollTop = y + h - viewH - m.frozenH;
      }
    }

    /* ---------- Rendering ---------- */

    renderNow() {
      const s = this.sheet;
      this.cfStyle = SheetApp.condfmt ? SheetApp.condfmt.lookup(this.wb, this.wb.activeIndex) : null;
      const totalW = this.rowHeadWidth + this.colAxis.offset(s.colCount);
      const totalH = HEADER_HEIGHT + this.rowAxis.offset(s.rowCount);
      this.sizer.style.width = totalW + 'px';
      this.sizer.style.height = totalH + 'px';
      const m = this.metrics();
      this.stage.style.width = m.vw + 'px';
      this.stage.style.height = m.vh + 'px';
      const bodyW = Math.max(0, m.vw - m.rh - m.frozenW);
      const bodyH = Math.max(0, m.vh - HEADER_HEIGHT - m.frozenH);

      const colRange = (fromPx, widthPx) => {
        const first = this.colAxis.indexAt(fromPx, s.colCount);
        const last = this.colAxis.indexAt(fromPx + widthPx, s.colCount);
        return [first, Math.min(s.colCount - 1, last + EXTRA_RENDER)];
      };
      const rowRange = (fromPx, heightPx) => {
        const first = this.rowAxis.indexAt(fromPx, s.rowCount);
        const last = this.rowAxis.indexAt(fromPx + heightPx, s.rowCount);
        return [first, Math.min(s.rowCount - 1, last + EXTRA_RENDER)];
      };
      const [bc0, bc1] = colRange(m.sl + m.frozenW, bodyW);
      const [br0, br1] = rowRange(m.st + m.frozenH, bodyH);
      const bodyCols = [Math.max(bc0, m.frozenCols), bc1];
      const bodyRows = [Math.max(br0, m.frozenRows), br1];
      const frozenCols = [0, m.frozenCols - 1];
      const frozenRows = [0, m.frozenRows - 1];
      const xBody = m.sl + m.frozenW;
      const yBody = m.st + m.frozenH;

      const place = (pane, left, top, width, height) => {
        pane.style.left = left + 'px';
        pane.style.top = top + 'px';
        pane.style.width = Math.max(0, width) + 'px';
        pane.style.height = Math.max(0, height) + 'px';
      };
      const P = this.panes;
      place(P.colHeadFrozen, m.rh, 0, m.frozenW, HEADER_HEIGHT);
      place(P.colHeadBody, m.rh + m.frozenW, 0, bodyW, HEADER_HEIGHT);
      place(P.rowHeadFrozen, 0, HEADER_HEIGHT, m.rh, m.frozenH);
      place(P.rowHeadBody, 0, HEADER_HEIGHT + m.frozenH, m.rh, bodyH);
      place(P.corner, m.rh, HEADER_HEIGHT, m.frozenW, m.frozenH);
      place(P.top, m.rh + m.frozenW, HEADER_HEIGHT, bodyW, m.frozenH);
      place(P.left, m.rh, HEADER_HEIGHT + m.frozenH, m.frozenW, bodyH);
      place(P.body, m.rh + m.frozenW, HEADER_HEIGHT + m.frozenH, bodyW, bodyH);
      this.cornerHeader.style.width = m.rh + 'px';
      this.cornerHeader.style.height = HEADER_HEIGHT + 'px';
      this.stage.classList.toggle('has-frozen-rows', m.frozenRows > 0);
      this.stage.classList.toggle('has-frozen-cols', m.frozenCols > 0);

      const sel = this.getSelection();
      this.renderColHeaders(P.colHeadFrozen, frozenCols, 0, sel);
      this.renderColHeaders(P.colHeadBody, bodyCols, xBody, sel);
      this.renderRowHeaders(P.rowHeadFrozen, frozenRows, 0, sel);
      this.renderRowHeaders(P.rowHeadBody, bodyRows, yBody, sel);
      this.renderCells(P.corner, frozenRows, frozenCols, 0, 0, sel);
      this.renderCells(P.top, frozenRows, bodyCols, xBody, 0, sel);
      this.renderCells(P.left, bodyRows, frozenCols, 0, yBody, sel);
      this.renderCells(P.body, bodyRows, bodyCols, xBody, yBody, sel);
      this.positionEditor();
    }

    renderColHeaders(pane, [c0, c1], xOff, sel) {
      const frag = document.createDocumentFragment();
      const s = this.sheet;
      const fullCols = sel.range.r1 === 0 && sel.range.r2 >= s.rowCount - 1;
      const filtered = new Set(s.filter ? s.filter.conditions.map((c) => c.col) : []);
      for (let c = c0; c <= c1; c++) {
        const w = this.colAxis.size(c);
        if (w === 0) continue;
        const inSel = c >= sel.range.c1 && c <= sel.range.c2;
        const label = U.colToLetters(c) + (filtered.has(c) ? ' ▾' : '');
        frag.append(U.el('div', {
          class: 'hdr col' + (inSel ? (fullCols ? ' selected' : ' active') : '') + (filtered.has(c) ? ' filtered' : '') + (this.colAxis.size(c + 1) === 0 && c + 1 < s.colCount ? ' before-hidden' : ''),
          style: { left: this.colAxis.offset(c) - xOff + 'px', width: w + 'px' },
          text: label,
        }));
      }
      pane.replaceChildren(frag);
    }

    renderRowHeaders(pane, [r0, r1], yOff, sel) {
      const frag = document.createDocumentFragment();
      const s = this.sheet;
      const fullRows = sel.range.c1 === 0 && sel.range.c2 >= s.colCount - 1;
      for (let r = r0; r <= r1; r++) {
        const h = this.rowAxis.size(r);
        if (h === 0) continue;
        const inSel = r >= sel.range.r1 && r <= sel.range.r2;
        frag.append(U.el('div', {
          class: 'hdr row' + (inSel ? (fullRows ? ' selected' : ' active') : '') + (this.rowAxis.size(r + 1) === 0 && r + 1 < s.rowCount ? ' before-hidden' : ''),
          style: { top: this.rowAxis.offset(r) - yOff + 'px', height: h + 'px' },
          text: String(r + 1),
        }));
      }
      pane.replaceChildren(frag);
    }

    renderCells(pane, [r0, r1], [c0, c1], xOff, yOff, sel) {
      const frag = document.createDocumentFragment();
      if (r1 < r0 || c1 < c0) { pane.replaceChildren(frag); return; }
      const s = this.sheet;
      const wbIndex = this.wb.activeIndex;
      const area = { r1: r0, c1: c0, r2: r1, c2: c1 };
      const xOf = (c) => this.colAxis.offset(c) - xOff;
      const yOf = (r) => this.rowAxis.offset(r) - yOff;

      // Gridlines (one line per visible row and column).
      const width = xOf(c1 + 1) - xOf(c0);
      const height = yOf(r1 + 1) - yOf(r0);
      for (let r = r0; r <= r1; r++) {
        const h = this.rowAxis.size(r);
        if (h) frag.append(U.el('div', { class: 'gl h', style: { top: yOf(r) + h - 1 + 'px', left: xOf(c0) + 'px', width: width + 'px' } }));
      }
      for (let c = c0; c <= c1; c++) {
        const w = this.colAxis.size(c);
        if (w) frag.append(U.el('div', { class: 'gl v', style: { left: xOf(c) + w - 1 + 'px', top: yOf(r0) + 'px', height: height + 'px' } }));
      }

      const merges = s.merges.filter((m) => U.rangesIntersect(m, area));
      const covered = new Set();
      for (const m of merges) {
        for (let r = Math.max(m.r1, r0); r <= Math.min(m.r2, r1); r++) {
          for (let c = Math.max(m.c1, c0); c <= Math.min(m.c2, c1); c++) covered.add(U.cellKey(r, c));
        }
      }

      for (let r = r0; r <= r1; r++) {
        const h = this.rowAxis.size(r);
        if (h === 0) continue;
        for (let c = c0; c <= c1; c++) {
          const key = U.cellKey(r, c);
          if (covered.has(key) || !s.cells.has(key)) continue;
          const w = this.colAxis.size(c);
          let overflowW = w;
          const node = this.buildCell(wbIndex, r, c, xOf(c), yOf(r), w, h, (display, info) => {
            // Left-aligned unwrapped text spills into empty neighbours, as in Excel.
            if (display.kind !== 'text' || info.wrap || info.horizontal !== 'left') return w;
            let cc = c + 1;
            while (cc <= c1 + 8 && cc < s.colCount && !s.cells.has(U.cellKey(r, cc)) && !covered.has(U.cellKey(r, cc)) && !s.mergeAt(r, cc)) {
              overflowW += this.colAxis.size(cc);
              cc++;
            }
            return overflowW;
          });
          if (node) frag.append(node);
        }
      }
      for (const m of merges) {
        const node = this.buildCell(wbIndex, m.r1, m.c1, xOf(m.c1), yOf(m.r1), xOf(m.c2 + 1) - xOf(m.c1), yOf(m.r2 + 1) - yOf(m.r1), null, true);
        if (node) frag.append(node);
      }

      if (this.highlights.keys.size) {
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            if (!this.highlights.keys.has(U.cellKey(r, c))) continue;
            frag.append(U.el('div', { class: 'cell-mark ' + this.highlights.className, style: { left: xOf(c) + 'px', top: yOf(r) + 'px', width: this.colAxis.size(c) - 1 + 'px', height: this.rowAxis.size(r) - 1 + 'px' } }));
          }
        }
      }

      const rectOf = (range) => ({
        left: xOf(range.c1) + 'px', top: yOf(range.r1) + 'px',
        width: xOf(range.c2 + 1) - xOf(range.c1) - 1 + 'px', height: yOf(range.r2 + 1) - yOf(range.r1) - 1 + 'px',
      });
      if (this.editing && this.editing.refs.length) {
        this.editing.refs.forEach((r, i) => {
          if (r.sheetName !== null && r.sheetName.toLowerCase() !== s.name.toLowerCase()) return;
          const box = { r1: Math.min(r.r1, r.r2), r2: Math.min(Math.max(r.r1, r.r2), s.rowCount - 1), c1: Math.min(r.c1, r.c2), c2: Math.min(Math.max(r.c1, r.c2), s.colCount - 1) };
          if (box.r1 > box.r2 || box.c1 > box.c2 || !U.rangesIntersect(box, area)) return;
          frag.append(U.el('div', { class: 'ref-box', style: { ...rectOf(box), borderColor: REF_COLORS[i % REF_COLORS.length] } }));
        });
      }
      if (this.clipboard && this.clipboard.sheetId === s.id && U.rangesIntersect(this.clipboard.data.range, area)) {
        frag.append(U.el('div', { class: 'copy-range', style: rectOf(this.clipboard.data.range) }));
      }
      const isSingle = sel.range.r1 === sel.range.r2 && sel.range.c1 === sel.range.c2;
      const activeRange = this.expandForMerges({ r1: sel.active.row, c1: sel.active.col, r2: sel.active.row, c2: sel.active.col });
      const activeIsWhole = activeRange.r1 === sel.range.r1 && activeRange.r2 === sel.range.r2 && activeRange.c1 === sel.range.c1 && activeRange.c2 === sel.range.c2;
      if (!isSingle && !activeIsWhole && U.rangesIntersect(sel.range, area)) {
        frag.append(U.el('div', { class: 'sel-range', style: rectOf(sel.range) }));
      }
      if (U.rangesIntersect(activeRange, area)) frag.append(U.el('div', { class: 'sel-active', style: rectOf(activeRange) }));
      if (this.fillDrag && this.fillDrag.preview && U.rangesIntersect(this.fillDrag.preview, area)) {
        frag.append(U.el('div', { class: 'fill-preview', style: rectOf(this.fillDrag.preview) }));
      }
      // Fill handle: the small square at the bottom-right corner of the selection (drag it to autofill).
      const sr = sel.range;
      if (!this.editing && sr.r2 < s.rowCount - 1 && sr.c2 < s.colCount - 1 && sr.r2 >= r0 && sr.r2 <= r1 && sr.c2 >= c0 && sr.c2 <= c1) {
        frag.append(U.el('div', { class: 'fill-handle', style: { left: xOf(sr.c2 + 1) - 5 + 'px', top: yOf(sr.r2 + 1) - 5 + 'px' } }));
      }
      pane.replaceChildren(frag);
    }

    buildCell(sheetIndex, r, c, x, y, w, h, overflow, isMerge) {
      const cell = this.sheet.getCell(r, c);
      if (!cell && !isMerge) return null;
      const display = this.wb.getDisplay(sheetIndex, r, c);
      const info = cellStyleCss(cell && cell.style, display.kind);
      const cf = this.cfStyle && cell ? this.cfStyle(r, c) : null;
      if (cf) Object.assign(info.css, cf);
      const node = U.el('div', {
        class: 'cell' + (display.kind === 'error' ? ' is-error' : '') + (display.warning ? ' has-warning' : '') + (isMerge ? ' is-merge' : ''),
        style: { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', ...info.css },
      });
      if (display.warning) node.title = display.warning;
      else if (cell && cell.note) node.title = typeof cell.note === 'string' ? cell.note : (cell.note.texts || []).map((t) => t.text).join('');
      if (cell && cell.note) node.classList.add('has-note');
      if (display.text) {
        const textW = overflow ? overflow(display, info) : w;
        const span = U.el('span', { class: 'cell-text', text: display.text });
        if (textW > w) {
          span.style.width = textW - 8 + 'px';
          node.classList.add('overflows');
        }
        node.append(span);
      }
      return node;
    }

    /* ---------- Highlights ---------- */

    setHighlights(keys, className) {
      this.highlights = { keys, className };
      this.renderNow();
    }

    clearHighlights() {
      this.highlights = { keys: new Set(), className: '' };
    }

    /* ---------- Pointer interaction ---------- */

    updateCursor(e) {
      if (this.drag) return;
      const p = this.stagePoint(e);
      const hit = this.hitTest(p.x, p.y);
      this.stage.style.cursor = hit.area === 'colresize' ? 'col-resize' : hit.area === 'rowresize' ? 'row-resize' : this.nearFillHandle(p.x, p.y) ? 'crosshair' : '';
    }

    onPointerDown(e) {
      if (e.button !== 0 || e.target === this.editor || e.target === this.cornerHeader) return;
      const { x, y } = this.stagePoint(e);
      const hit = this.hitTest(x, y);
      if (this.editing) {
        if (hit.area === 'cell' && this.editing.text.startsWith('=') && this.startPointing(e, hit)) return; // clicking a cell inserts its reference
        this.commitEdit(0, 0);
      }
      e.preventDefault();
      this.focus();
      if (hit.area === 'colresize' || hit.area === 'rowresize') { this.startResize(e, hit); return; }
      if (hit.area === 'cell' && e.pointerType !== 'touch' && this.nearFillHandle(x, y)) { this.startFill(); return; }
      if (e.pointerType === 'touch') {
        if (hit.area === 'cell') {
          const now = Date.now();
          const sameCell = this.lastTap && this.lastTap.row === hit.row && this.lastTap.col === hit.col && now - this.lastTap.time < 400;
          this.select({ row: hit.row, col: hit.col }, null, { scroll: false });
          if (sameCell) this.beginEdit(null, false, true);
          this.lastTap = { row: hit.row, col: hit.col, time: now };
        } else if (hit.area === 'colhead') this.selectColumns(hit.col, hit.col);
        else if (hit.area === 'rowhead') this.selectRows(hit.row, hit.row);
        return;
      }
      if (hit.area === 'cell') {
        if (e.shiftKey) this.select(this.anchor, { row: hit.row, col: hit.col }, { scroll: false });
        else this.select({ row: hit.row, col: hit.col }, null, { scroll: false });
      } else if (hit.area === 'colhead') {
        if (e.shiftKey) this.selectColumns(this.anchor.col, hit.col);
        else this.selectColumns(hit.col, hit.col);
      } else if (hit.area === 'rowhead') {
        if (e.shiftKey) this.selectRows(this.anchor.row, hit.row);
        else this.selectRows(hit.row, hit.row);
      } else {
        return;
      }
      this.drag = { kind: hit.area, startCol: e.shiftKey ? this.anchor.col : hit.col, startRow: e.shiftKey ? this.anchor.row : hit.row };
      const move = (ev) => {
        const p = this.stagePoint(ev);
        this.autoScroll(p);
        const h = this.hitTest(U.clamp(p.x, this.rowHeadWidth + 1, this.scroller.clientWidth - 1), U.clamp(p.y, HEADER_HEIGHT + 1, this.scroller.clientHeight - 1));
        if (this.drag.kind === 'cell') this.select(this.anchor, { row: h.row, col: h.col }, { scroll: false });
        else if (this.drag.kind === 'colhead') this.selectColumns(this.drag.startCol, h.col);
        else this.selectRows(this.drag.startRow, h.row);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.drag = null;
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }

    /** True when (x, y) in stage coordinates is on the selection's fill handle. */
    nearFillHandle(x, y) {
      if (this.editing || this.drag || this.fillDrag) return false;
      const m = this.metrics();
      if (x < m.rh || y < HEADER_HEIGHT) return false;
      const r = this.getSelection().range;
      if (r.r2 >= this.sheet.rowCount - 1 || r.c2 >= this.sheet.colCount - 1) return false;
      const rect = this.rangeStageRect(r);
      return Math.abs(x - (rect.x + rect.w)) <= 6 && Math.abs(y - (rect.y + rect.h)) <= 6;
    }

    /** Which way and how far a fill drag reaches when the pointer is over cell (row, col). */
    fillTarget(src, row, col) {
      const down = Math.max(0, row - src.r2), up = Math.max(0, src.r1 - row);
      const right = Math.max(0, col - src.c2), left = Math.max(0, src.c1 - col);
      const v = Math.max(down, up), h = Math.max(right, left);
      if (!v && !h) return null;
      if (v >= h) return up > down ? { dir: 'up', count: up, preview: { ...src, r1: src.r1 - up, r2: src.r1 - 1 } } : { dir: 'down', count: down, preview: { ...src, r1: src.r2 + 1, r2: src.r2 + down } };
      return left > right ? { dir: 'left', count: left, preview: { ...src, c1: src.c1 - left, c2: src.c1 - 1 } } : { dir: 'right', count: right, preview: { ...src, c1: src.c2 + 1, c2: src.c2 + right } };
    }

    startFill() {
      const src = this.getSelection().range;
      this.fillDrag = { src, target: null, preview: null };
      this.stage.style.cursor = 'crosshair';
      const move = (ev) => {
        const p = this.stagePoint(ev);
        this.autoScroll(p);
        const h = this.hitTest(U.clamp(p.x, this.rowHeadWidth + 1, this.scroller.clientWidth - 1), U.clamp(p.y, HEADER_HEIGHT + 1, this.scroller.clientHeight - 1));
        if (h.area !== 'cell') return;
        const grown = { row: Math.min(h.row, this.sheet.rowCount - 1), col: Math.min(h.col, this.sheet.colCount - 1) };
        this.fillDrag.target = this.fillTarget(src, grown.row, grown.col);
        this.fillDrag.preview = this.fillDrag.target ? this.fillDrag.target.preview : null;
        this.renderNow();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        const t = this.fillDrag && this.fillDrag.target;
        this.fillDrag = null;
        this.stage.style.cursor = '';
        if (t) this.fill(src, t.dir, t.count, false); else this.renderNow();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }

    /** Autofills and selects the result. */
    fill(src, dir, count, copyOnly) {
      const range = this.wb.fillRange(this.wb.activeIndex, src, dir, count, { copyOnly });
      if (range) this.selectRange(range, { row: range.r1, col: range.c1 }); else this.renderNow();
      this.focus();
      return range;
    }

    /** Ctrl+D / Ctrl+R: copy the first row (column) of the selection over the rest, or the row above (column to the left) for a single row (column). */
    fillSelection(vertical) {
      const r = this.getSelection().range;
      const size = vertical ? r.r2 - r.r1 : r.c2 - r.c1;
      if (size > 0) {
        const src = vertical ? { ...r, r2: r.r1 } : { ...r, c2: r.c1 };
        this.wb.fillRange(this.wb.activeIndex, src, vertical ? 'down' : 'right', size, { copyOnly: true });
      } else if (vertical ? r.r1 > 0 : r.c1 > 0) {
        const src = vertical ? { ...r, r1: r.r1 - 1, r2: r.r1 - 1 } : { ...r, c1: r.c1 - 1, c2: r.c1 - 1 };
        this.wb.fillRange(this.wb.activeIndex, src, vertical ? 'down' : 'right', 1, { copyOnly: true });
      }
      this.renderNow();
    }

    autoScroll(p) {
      const edge = 20;
      if (p.x > this.scroller.clientWidth - edge) this.scroller.scrollLeft += 30;
      else if (p.x < this.rowHeadWidth + edge && this.scroller.scrollLeft > 0) this.scroller.scrollLeft -= 30;
      if (p.y > this.scroller.clientHeight - edge) this.scroller.scrollTop += 24;
      else if (p.y < HEADER_HEIGHT + edge && this.scroller.scrollTop > 0) this.scroller.scrollTop -= 24;
    }

    selectColumns(a, b) {
      const s = this.sheet;
      const top = this.firstVisibleRow();
      this.select({ row: top, col: a }, { row: s.rowCount - 1, col: b }, { scroll: false });
      this.anchor = { row: top, col: a };
      this.focusCell = { row: s.rowCount - 1, col: b };
      this.renderNow();
    }

    selectRows(a, b) {
      this.select({ row: a, col: 0 }, { row: b, col: this.sheet.colCount - 1 }, { scroll: false });
    }

    firstVisibleRow() {
      let r = 0;
      while (r < this.sheet.rowCount - 1 && this.rowAxis.size(r) === 0) r++;
      return r;
    }

    startResize(e, hit) {
      const isCol = hit.area === 'colresize';
      const index = isCol ? hit.col : hit.row;
      const axis = isCol ? this.colAxis : this.rowAxis;
      const startSize = axis.size(index);
      const start = isCol ? e.clientX : e.clientY;
      const rect = this.rangeStageRect(isCol ? { r1: 0, c1: index, r2: 0, c2: index } : { r1: index, c1: 0, r2: index, c2: 0 });
      const origin = isCol ? rect.x : rect.y;
      this.guide.hidden = false;
      this.guide.className = 'resize-guide ' + (isCol ? 'vertical' : 'horizontal');
      let size = startSize;
      const show = () => {
        if (isCol) { this.guide.style.left = origin + size + 'px'; this.guide.style.top = '0'; }
        else { this.guide.style.top = origin + size + 'px'; this.guide.style.left = '0'; }
        this.handlers.onStatus((isCol ? 'Width: ' : 'Height: ') + Math.round(size) + ' px');
      };
      show();
      this.drag = { kind: 'resize' };
      const move = (ev) => {
        size = Math.max(MIN_SIZE, startSize + (isCol ? ev.clientX : ev.clientY) - start);
        show();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.guide.hidden = true;
        this.drag = null;
        this.handlers.onStatus('');
        if (Math.round(size) === Math.round(startSize)) return;
        const targets = this.resizeTargets(isCol, index);
        if (isCol) this.wb.setColumnWidth(this.wb.activeIndex, targets, size);
        else this.wb.setRowHeight(this.wb.activeIndex, targets, size);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }

    /** Resizing a selected column/row resizes every selected one, like Excel. */
    resizeTargets(isCol, index) {
      const { range } = this.getSelection();
      const s = this.sheet;
      const whole = isCol ? range.r1 <= this.firstVisibleRow() && range.r2 >= s.rowCount - 1 : range.c1 === 0 && range.c2 >= s.colCount - 1;
      const inside = isCol ? index >= range.c1 && index <= range.c2 : index >= range.r1 && index <= range.r2;
      if (!whole || !inside) return [index];
      const out = [];
      for (let i = isCol ? range.c1 : range.r1; i <= (isCol ? range.c2 : range.r2); i++) out.push(i);
      return out;
    }

    /** Double-clicking a column edge fits the column to its content. */
    autoFitColumn(col) {
      const s = this.sheet;
      const canvas = this.measureCanvas || (this.measureCanvas = document.createElement('canvas'));
      const ctx = canvas.getContext('2d');
      const baseFont = getComputedStyle(this.stage).fontFamily;
      let max = 0;
      let checked = 0;
      for (const key of s.cells.keys()) {
        const p = U.keyToCell(key);
        if (p.col !== col || checked++ > 20000) continue;
        const cell = s.cells.get(key);
        const font = (cell.style && cell.style.font) || {};
        ctx.font = (font.bold ? '700 ' : '') + Math.round(((font.size || 10) * 4) / 3) + 'px ' + baseFont;
        max = Math.max(max, ctx.measureText(this.wb.getDisplay(this.wb.activeIndex, p.row, p.col).text).width);
      }
      if (max > 0) this.wb.setColumnWidth(this.wb.activeIndex, this.resizeTargets(true, col), Math.min(600, Math.ceil(max + 16)));
    }

    onDoubleClick(e) {
      const hit = this.hitTest(...Object.values(this.stagePoint(e)));
      if (hit.area === 'colresize') this.autoFitColumn(hit.col);
      else if (hit.area === 'rowresize') this.wb.setRowHeight(this.wb.activeIndex, this.resizeTargets(false, hit.row), DEFAULT_ROW_HEIGHT);
      else if (hit.area === 'cell') this.beginEdit(null, false, true);
    }

    onContextMenu(e) {
      const hit = this.hitTest(...Object.values(this.stagePoint(e)));
      if (hit.area === 'corner') return;
      e.preventDefault();
      const { range } = this.getSelection();
      if (hit.area === 'cell' && !U.rangeContains(range, hit.row, hit.col)) this.select({ row: hit.row, col: hit.col }, null, { scroll: false });
      if (hit.area === 'colhead' && !(hit.col >= range.c1 && hit.col <= range.c2)) this.selectColumns(hit.col, hit.col);
      if (hit.area === 'rowhead' && !(hit.row >= range.r1 && hit.row <= range.r2)) this.selectRows(hit.row, hit.row);
      this.handlers.onContextMenu(e, hit);
    }

    /* ---------- Keyboard ---------- */

    focus() {
      // After a modal dialog closes, Chromium can report the editor as focused while it ignores typing.
      // A blur/focus cycle makes the focus real. Never do this mid-edit (blur would commit).
      if (document.activeElement === this.editor && !this.editing) this.editor.blur();
      if (document.activeElement !== this.editor) this.editor.focus({ preventScroll: true });
    }

    onKeyDown(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (this.editing) { this.onEditingKey(e); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const s = this.sheet;
      const page = Math.max(1, Math.floor((this.scroller.clientHeight - HEADER_HEIGHT) / DEFAULT_ROW_HEIGHT) - 1);
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      switch (e.key) {
        case 'ArrowUp': handled(); this.move(-1, 0, shift, ctrl); return;
        case 'ArrowDown': handled(); this.move(1, 0, shift, ctrl); return;
        case 'ArrowLeft': handled(); this.move(0, -1, shift, ctrl); return;
        case 'ArrowRight': handled(); this.move(0, 1, shift, ctrl); return;
        case 'PageDown': handled(); this.move(page, 0, shift, false); return;
        case 'PageUp': handled(); this.move(-page, 0, shift, false); return;
        case 'Tab': handled(); this.move(0, shift ? -1 : 1, false, false); return;
        case 'Home': {
          handled();
          const target = ctrl ? { row: this.firstVisibleRow(), col: 0 } : { row: (shift ? this.focusCell : this.anchor).row, col: 0 };
          if (shift) this.select(this.anchor, target); else this.select(target);
          return;
        }
        case 'End': {
          handled();
          const b = s.usedBounds();
          const row = (shift ? this.focusCell : this.anchor).row;
          let target;
          if (ctrl) target = { row: Math.max(0, b.maxRow), col: Math.max(0, b.maxCol) };
          else {
            let last = 0;
            for (let c = Math.max(0, b.maxCol); c >= 0; c--) if (s.cells.has(U.cellKey(row, c))) { last = c; break; }
            target = { row, col: last };
          }
          if (shift) this.select(this.anchor, target); else this.select(target);
          return;
        }
        case 'Enter': handled(); this.beginEdit(null, false, true); return;
        case 'F2': handled(); this.beginEdit(null, false, true); return;
        case 'Delete': case 'Backspace': {
          handled();
          this.wb.clearRanges(this.wb.activeIndex, [this.getSelection().range], 'contents');
          return;
        }
        case 'Escape':
          if (this.clipboard || this.highlights.keys.size) {
            this.clipboard = null;
            this.clearHighlights();
            this.renderNow();
          }
          return;
        default: break;
      }
      if (ctrl && (e.key === 'a' || e.key === 'A')) { handled(); this.selectAll(); }
      if (ctrl && e.code === 'Semicolon') { handled(); this.insertNow(shift); }
      if (ctrl && shift && (e.key === 'v' || e.key === 'V')) this.pasteValuesOnly = true; // the paste event follows; keep the browser default
      if (ctrl && !shift && (e.key === 'd' || e.key === 'D')) { handled(); this.fillSelection(true); }
      if (ctrl && !shift && (e.key === 'r' || e.key === 'R')) { handled(); this.fillSelection(false); }
      // Printable keys reach the textarea; the input event then starts editing.
    }

    onEditingKey(e) {
      if (this.assistKey(e)) return;
      const ed = this.editing;
      const done = (dr, dc) => { e.preventDefault(); this.commitEdit(dr, dc); };
      if (e.key === 'Enter' && (e.altKey || (e.ctrlKey && !e.shiftKey))) {
        e.preventDefault();
        const t = this.editor;
        const pos = t.selectionStart;
        t.value = t.value.slice(0, pos) + '\n' + t.value.slice(t.selectionEnd);
        t.selectionStart = t.selectionEnd = pos + 1;
        this.onEditorInput();
        return;
      }
      if (e.key === 'Enter') return done(e.shiftKey ? -1 : 1, 0);
      if (e.key === 'Tab') return done(0, e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
      if (ed.quick && !ed.text.startsWith('=')) {
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        if (arrows[e.key]) return done(...arrows[e.key]);
      }
    }

    /** Moves the active cell (or extends the selection) skipping hidden rows and merged areas. */
    move(dr, dc, extend, jump) {
      const s = this.sheet;
      const from = extend ? this.focusCell : this.anchor;
      let row = from.row;
      let col = from.col;
      if (jump) {
        ({ row, col } = this.jumpTarget(from, dr, dc));
      } else {
        const merge = !extend && s.mergeAt(row, col);
        if (merge) {
          if (dr > 0) row = merge.r2;
          if (dr < 0) row = merge.r1;
          if (dc > 0) col = merge.c2;
          if (dc < 0) col = merge.c1;
        }
        const colStep = Math.sign(dc);
        for (let i = 0; i < Math.abs(dc); i++) {
          let next = col + colStep;
          while (next > 0 && next < s.colCount - 1 && this.colAxis.size(next) === 0) next += colStep;
          if (next < 0 || next >= U.MAX_COLS || this.colAxis.size(next) === 0) break;
          col = next;
        }
        const step = Math.sign(dr);
        for (let i = 0; i < Math.abs(dr); i++) {
          let next = row + step;
          while (next > 0 && next < s.rowCount - 1 && this.rowAxis.size(next) === 0) next += step;
          if (next < 0 || this.rowAxis.size(next) === 0) break;
          row = next;
        }
      }
      if (extend) {
        this.select(this.anchor, { row, col });
        return;
      }
      const target = s.mergeAt(row, col);
      this.select(target ? { row: target.r1, col: target.c1 } : { row, col });
    }

    /** Ctrl+Arrow: jump to the edge of the current block of data, like Excel. */
    jumpTarget(from, dr, dc) {
      const s = this.sheet;
      const has = (r, c) => s.cells.has(U.cellKey(r, c));
      const b = s.usedBounds();
      const limitR = dr > 0 ? Math.max(b.maxRow, from.row) : 0;
      const limitC = dc > 0 ? Math.max(b.maxCol, from.col) : 0;
      let r = from.row;
      let c = from.col;
      const step = () => { r += dr; c += dc; };
      const inside = () => (dr ? (dr > 0 ? r <= limitR : r >= 0) : (dc > 0 ? c <= limitC : c >= 0));
      const startFilled = has(r, c);
      step();
      if (!inside()) return { row: U.clamp(r - dr, 0, s.rowCount - 1), col: U.clamp(c - dc, 0, s.colCount - 1) };
      if (startFilled && has(r, c)) {
        while (inside() && has(r + dr, c + dc)) step();
      } else {
        while (inside() && !has(r, c)) step();
        if (!inside()) { r = dr > 0 ? limitR : dr < 0 ? 0 : r - dr; c = dc > 0 ? limitC : dc < 0 ? 0 : c - dc; }
      }
      return { row: U.clamp(r, 0, s.rowCount - 1), col: U.clamp(c, 0, s.colCount - 1) };
    }

    /* ---------- Editing ---------- */

    isEditing() { return !!this.editing; }

    /* ---------- Formula assistance: point-and-click references, colour boxes, F4 and function suggestions ---------- */

    /** The text box the user is typing in: the cell editor, or the formula bar when editing started there. */
    activeInput() {
      return this.editing && this.editing.viaBar ? document.getElementById('formula-input') || this.editor : this.editor;
    }

    /** Replaces the text being edited (keeping the cell editor and the formula bar in step) and places the caret/selection. */
    setEditText(text, selStart, selEnd) {
      const ed = this.editing;
      ed.text = text;
      this.editor.value = text;
      const input = this.activeInput();
      if (input !== this.editor) input.value = text;
      input.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
      this.positionEditor();
      this.handlers.onEditInput(text);
    }

    /** Recomputes the coloured reference boxes and the function suggestions for the formula being edited. */
    updateAssist() {
      const ed = this.editing;
      if (!ed) return;
      const found = ed.text.startsWith('=') ? F.findReferences(ed.text).map((r) => r.ref) : [];
      const key = found.map((r) => [r.sheetName, r.r1, r.c1, r.r2, r.c2].join(',')).join(';');
      const changed = key !== ed.refsKey;
      ed.refs = found; ed.refsKey = key;
      const input = this.activeInput();
      const caret = input.selectionStart == null ? ed.text.length : input.selectionStart;
      const fp = ed.text.startsWith('=') && input.selectionStart === input.selectionEnd ? F.functionPrefixAt(ed.text, caret) : null;
      const items = fp ? F.suggestFunctions(fp.prefix) : [];
      if (items.length && !(items.length === 1 && items[0] === fp.prefix.toUpperCase())) this.showSuggest(items, fp, input); else this.hideSuggest();
      if (changed) this.renderNow();
    }

    showSuggest(items, fp, input) {
      const ed = this.editing;
      const prev = ed.suggest;
      ed.suggest = { items, index: prev && items[prev.index] === prev.items[prev.index] ? prev.index : 0, start: fp.start, end: fp.end };
      if (!this.suggestEl) {
        this.suggestEl = U.el('ul', { class: 'fn-suggest', role: 'listbox', 'aria-label': 'Function suggestions' });
        this.suggestEl.addEventListener('mousedown', (e) => {
          const li = e.target.closest('li');
          if (!li || !this.editing || !this.editing.suggest) return;
          e.preventDefault();
          this.acceptSuggest(Number(li.dataset.index));
        });
        document.body.append(this.suggestEl);
      }
      const list = this.suggestEl;
      list.replaceChildren(...items.map((name, i) => U.el('li', { role: 'option', 'data-index': String(i), 'aria-selected': String(i === ed.suggest.index), class: i === ed.suggest.index ? 'active' : '' }, name)));
      const rect = input.getBoundingClientRect();
      list.style.left = Math.max(4, rect.left) + 'px';
      list.style.top = rect.bottom + 2 + 'px';
      list.hidden = false;
    }

    hideSuggest() {
      if (this.suggestEl) this.suggestEl.hidden = true;
      if (this.editing) this.editing.suggest = null;
    }

    acceptSuggest(index) {
      const ed = this.editing;
      const s = ed && ed.suggest;
      if (!s || !s.items[index]) return;
      const name = s.items[index];
      const text = ed.text.slice(0, s.start) + name + '(' + ed.text.slice(s.end);
      this.hideSuggest();
      this.setEditText(text, s.start + name.length + 1);
      this.updateAssist();
      this.activeInput().focus();
    }

    /** Keys that belong to formula assistance (F4, and navigating the suggestion list). Returns true when the key was used. */
    assistKey(e) {
      const ed = this.editing;
      if (!ed) return false;
      if (e.key === 'F4' && ed.text.startsWith('=')) {
        e.preventDefault();
        const input = this.activeInput();
        const r = F.cycleReference(ed.text, input.selectionStart, input.selectionEnd);
        if (r) { this.setEditText(r.text, r.selStart, r.selEnd); ed.pointing = null; this.updateAssist(); }
        return true;
      }
      const s = ed.suggest;
      if (!s) return false;
      const move = (delta) => {
        e.preventDefault();
        s.index = (s.index + delta + s.items.length) % s.items.length;
        [...this.suggestEl.children].forEach((li, i) => { li.classList.toggle('active', i === s.index); li.setAttribute('aria-selected', String(i === s.index)); });
      };
      if (e.key === 'ArrowDown') { move(1); return true; }
      if (e.key === 'ArrowUp') { move(-1); return true; }
      if (e.key === 'Tab') { e.preventDefault(); this.acceptSuggest(s.index); return true; }
      if (e.key === 'Escape') { e.preventDefault(); this.hideSuggest(); return true; }
      return false;
    }

    /**
     * While a formula is edited, clicking (or dragging over) cells writes their address into it, like Excel.
     * Returns false when the caret is not where a reference can go; the click then commits the edit instead.
     */
    startPointing(e, hit) {
      const ed = this.editing;
      const input = this.activeInput();
      const caret = input.selectionStart == null ? ed.text.length : input.selectionStart;
      const continuing = !!ed.pointing && caret === ed.pointing.end && input.selectionStart === input.selectionEnd;
      if (!continuing && !F.canInsertReference(ed.text, caret)) return false;
      e.preventDefault();
      const here = { row: hit.row, col: hit.col };
      const anchor = continuing && e.shiftKey ? ed.pointing.anchor : here;
      ed.pointing = { start: continuing ? ed.pointing.start : caret, end: continuing ? ed.pointing.end : caret, anchor };
      this.hideSuggest();
      this.pointAt(anchor, here);
      input.focus({ preventScroll: true });
      this.drag = { kind: 'point' };
      const move = (ev) => {
        const p = this.stagePoint(ev);
        this.autoScroll(p);
        const h = this.hitTest(U.clamp(p.x, this.rowHeadWidth + 1, this.scroller.clientWidth - 1), U.clamp(p.y, HEADER_HEIGHT + 1, this.scroller.clientHeight - 1));
        if (h.area === 'cell' && this.editing && this.editing.pointing) this.pointAt(this.editing.pointing.anchor, { row: h.row, col: h.col });
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.drag = null;
        if (this.editing) this.activeInput().focus({ preventScroll: true });
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      return true;
    }

    /** Writes the address of the block between two cells where the pointed reference goes. */
    pointAt(anchor, to) {
      const ed = this.editing;
      const p = ed.pointing;
      const r = U.normalizeRange(anchor.row, anchor.col, to.row, to.col);
      const address = r.r1 === r.r2 && r.c1 === r.c2 ? U.cellAddress(r.r1, r.c1) : U.cellAddress(r.r1, r.c1) + ':' + U.cellAddress(r.r2, r.c2);
      const text = ed.text.slice(0, p.start) + address + ed.text.slice(p.end);
      p.end = p.start + address.length;
      this.setEditText(text, p.end);
      this.updateAssist();
    }


    /**
     * Starts editing the active cell. text === null loads the cell's content;
     * quick means typing replaced the content (arrow keys then commit).
     */
    beginEdit(text, quick, selectEnd) {
      const { row, col } = this.anchor;
      const original = this.wb.getInputText(this.wb.activeIndex, row, col);
      const value = text === null ? original : text;
      this.editing = { row, col, original, text: value, quick, viaBar: false, pointing: null, refs: [], refsKey: '', suggest: null };
      if (text === null || selectEnd) {
        this.editor.value = value;
        const end = value.length;
        this.editor.setSelectionRange(end, end);
      }
      this.stage.classList.add('is-editing');
      this.positionEditor();
      this.focus();
      this.handlers.onEditInput(this.editor.value);
      this.updateAssist();
    }

    onEditorInput() {
      if (!this.editing) {
        const typed = this.editor.value;
        if (!typed) return;
        this.beginEdit(typed, true, false);
        return;
      }
      this.editing.text = this.editor.value;
      this.editing.pointing = null; // typing ends "point at a cell" mode
      this.positionEditor();
      this.handlers.onEditInput(this.editor.value);
      this.updateAssist();
    }

    /** Called by the formula bar while the user types there. */
    setEditTextFromBar(text) {
      if (!this.editing) {
        this.beginEdit(text, false, true);
        this.editing.viaBar = true;
      }
      this.editing.text = text;
      this.editing.pointing = null;
      this.editor.value = text;
      this.positionEditor();
      this.updateAssist();
    }

    async commitEdit(dr, dc) {
      const ed = this.editing;
      if (!ed || ed.committing) return;
      if (ed.text === ed.original) {
        this.finishEdit();
        if (dr || dc) this.move(dr, dc, false, false);
        return;
      }
      ed.committing = true;
      const ok = await this.handlers.commitInput(ed.row, ed.col, ed.text);
      ed.committing = false;
      if (!ok) {
        this.positionEditor();
        this.focus();
        return;
      }
      this.finishEdit();
      if (dr || dc) this.move(dr, dc, false, false);
      else this.handlers.onSelectionChange();
    }

    cancelEdit() {
      this.finishEdit();
      this.handlers.onSelectionChange();
    }

    finishEdit() {
      this.hideSuggest();
      this.editing = null;
      this.editor.value = '';
      this.stage.classList.remove('is-editing');
      this.positionEditor();
      this.focus();
    }

    positionEditor() {
      const ed = this.editing;
      const anchor = ed ? { row: ed.row, col: ed.col } : this.anchor;
      const range = this.expandForMerges({ r1: anchor.row, c1: anchor.col, r2: anchor.row, c2: anchor.col });
      const rect = this.rangeStageRect(range);
      const st = this.editor.style;
      st.left = rect.x + 'px';
      st.top = rect.y + 'px';
      st.minWidth = rect.w + 'px';
      st.minHeight = rect.h + 'px';
      if (!ed) {
        st.width = rect.w + 'px';
        st.height = rect.h + 'px';
        return;
      }
      const cell = this.sheet.getCell(anchor.row, anchor.col);
      const info = cellStyleCss(cell && cell.style, 'text');
      st.fontWeight = info.css.fontWeight || '';
      st.fontStyle = info.css.fontStyle || '';
      st.fontSize = info.css.fontSize || '';
      const maxW = Math.max(rect.w, this.scroller.clientWidth - rect.x - 8);
      st.width = rect.w + 'px';
      st.whiteSpace = info.wrap ? 'pre-wrap' : 'pre';
      st.width = U.clamp(this.editor.scrollWidth + 4, rect.w, maxW) + 'px';
      st.height = rect.h + 'px';
      st.height = Math.max(rect.h, this.editor.scrollHeight) + 'px';
    }

    /* ---------- Clipboard ---------- */

    onCopy(e, isCut) {
      if (this.editing) return;
      e.preventDefault();
      const { range } = this.getSelection();
      const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
      if (area > 500000) {
        this.handlers.onStatus('Select fewer than 500,000 cells to copy.');
        return;
      }
      const data = this.wb.copyRange(this.wb.activeIndex, range);
      e.clipboardData.setData('text/plain', data.text);
      this.clipboard = { data, isCut, sheetId: this.sheet.id };
      this.renderNow();
      this.handlers.onStatus(isCut ? 'Cut ' + U.rangeAddress(range) + '. Select a destination and paste.' : 'Copied ' + U.rangeAddress(range) + '.');
    }

    onPaste(e) {
      if (this.editing) return;
      e.preventDefault();
      const valuesOnly = this.pasteValuesOnly;
      this.pasteValuesOnly = false;
      const text = e.clipboardData.getData('text/plain');
      if (valuesOnly && this.clipboard && text === this.clipboard.data.text) this.pasteSpecial('values');
      else this.pasteText(text);
    }

    /** Paste special from the last copy made in the editor. mode: 'values' | 'formulas' | 'formats' | 'transpose'. */
    pasteSpecial(mode) {
      const clip = this.clipboard;
      if (!clip) { this.handlers.onStatus('Copy cells in the editor first (Ctrl+C), then choose Paste special.'); return; }
      const { row, col } = this.anchor;
      const size = this.wb.pasteSpecial(this.wb.activeIndex, row, col, clip.data, mode);
      this.select({ row, col }, { row: row + size.rows - 1, col: col + size.cols - 1 }, { scroll: false });
      this.renderNow();
    }

    /** Ctrl+; puts today's date in the active cell, Ctrl+Shift+; the current time. */
    insertNow(withTime) {
      const { row, col } = this.anchor;
      const n = new Date();
      const serial = U.dateToSerial(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds())));
      this.wb.setCellValue(this.wb.activeIndex, row, col, withTime ? serial - Math.floor(serial) : Math.floor(serial), withTime ? 'hh:mm' : 'yyyy-mm-dd');
    }

    /** Pastes text; uses the richer internal copy when the text matches it. */
    pasteText(text) {
      const { row, col } = this.anchor;
      const internal = this.clipboard;
      if (internal && text === internal.data.text) {
        this.wb.pasteCells(this.wb.activeIndex, row, col, internal.data, internal.isCut);
        const r = internal.data.range;
        this.select({ row, col }, { row: row + r.r2 - r.r1, col: col + r.c2 - r.c1 }, { scroll: false });
        if (internal.isCut) this.clipboard = null;
      } else if (text) {
        const size = this.wb.pasteText(this.wb.activeIndex, row, col, text);
        this.select({ row, col }, { row: row + size.rows - 1, col: col + Math.max(0, size.cols - 1) }, { scroll: false });
        this.clipboard = null;
      }
      this.renderNow();
    }

    copySelectionToSystem(isCut) {
      // Triggers the same copy/cut path as the keyboard shortcut.
      this.focus();
      if (!document.execCommand(isCut ? 'cut' : 'copy')) this.handlers.onStatus('Use Ctrl+' + (isCut ? 'X' : 'C') + ' to ' + (isCut ? 'cut.' : 'copy.'));
    }
  }

  SheetApp.GridView = GridView;
  SheetApp.cellStyleCss = cellStyleCss;
})(typeof window !== 'undefined' ? window : globalThis);
