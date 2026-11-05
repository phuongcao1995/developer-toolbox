/*
 * toolbar.js — everything around the grid: toolbar buttons, formula bar, name box,
 * sheet tabs, status bar, and the find/sort/filter/validation dialogs.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;
  const D = SheetApp.dialogs;
  const { adjustDecimals, describeRule } = SheetApp.spreadsheet;
  const { el } = U;
  const $ = (id) => document.getElementById(id);

  const FILTER_OPERATORS = [
    ['contains', 'contains'], ['notContains', 'does not contain'], ['equals', 'equals'], ['notEquals', 'does not equal'],
    ['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'],
    ['empty', 'is empty'], ['notEmpty', 'is not empty'],
  ];
  const VALIDATION_OPERATORS = [
    ['between', 'between'], ['notBetween', 'not between'], ['equal', 'equal to'], ['notEqual', 'not equal to'],
    ['greaterThan', 'greater than'], ['lessThan', 'less than'], ['greaterThanOrEqual', 'at least'], ['lessThanOrEqual', 'at most'],
  ];

  class Toolbar {
    constructor(app) {
      this.app = app;
      this.find = { open: false };
      this.bind();
    }

    get wb() { return this.app.wb; }
    get grid() { return this.app.grid; }
    get sheetIndex() { return this.app.wb.activeIndex; }

    selection() { return this.grid.getSelection(); }

    activeCell() {
      const { active } = this.selection();
      return this.wb.activeSheet.getCell(active.row, active.col);
    }

    activeStyle() {
      const cell = this.activeCell();
      return (cell && cell.style) || {};
    }

    /* ---------- Binding ---------- */

    bind() {
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || btn.disabled) return;
        this.run(btn.dataset.action, btn);
      });
      $('font-name').addEventListener('change', (e) => this.applyFont({ name: e.target.value || undefined }));
      $('font-size').addEventListener('change', (e) => this.applyFont({ size: Number(e.target.value) }));
      $('number-format').addEventListener('change', (e) => this.setNumberFormat(e.target.value));
      $('text-color').addEventListener('input', (e) => { $('text-color-swatch').style.background = e.target.value; });
      $('text-color').addEventListener('change', (e) => this.applyFont({ color: U.cssToArgb(e.target.value) }));
      $('fill-color').addEventListener('input', (e) => { $('fill-color-swatch').style.background = e.target.value; });
      $('fill-color').addEventListener('change', (e) => this.format((s) => { s.fill = { type: 'pattern', pattern: 'solid', fgColor: U.cssToArgb(e.target.value) }; }, 'Fill colour'));
      $('text-color-swatch').style.background = $('text-color').value;
      $('fill-color-swatch').style.background = $('fill-color').value;
      this.bindFormulaBar();
      this.bindNameBox();
    }

    run(action, button) {
      const app = this.app;
      const actions = {
        new: () => app.newWorkbook(),
        open: () => app.chooseFile(),
        save: () => app.save(),
        undo: () => app.undo(),
        redo: () => app.redo(),
        bold: () => this.toggleFont('bold'),
        italic: () => this.toggleFont('italic'),
        underline: () => this.toggleFont('underline'),
        'align-left': () => this.setAlignment('horizontal', 'left'),
        'align-center': () => this.setAlignment('horizontal', 'center'),
        'align-right': () => this.setAlignment('horizontal', 'right'),
        'valign-top': () => this.setAlignment('vertical', 'top'),
        'valign-middle': () => this.setAlignment('vertical', 'middle'),
        'valign-bottom': () => this.setAlignment('vertical', 'bottom'),
        wrap: () => this.toggleWrap(),
        merge: () => this.toggleMerge(),
        'borders-menu': () => this.bordersMenu(button),
        'decimals-less': () => this.changeDecimals(-1),
        'decimals-more': () => this.changeDecimals(1),
        'clear-format': () => this.wb.clearRanges(this.sheetIndex, [this.selection().range], 'formats'),
        'rows-menu': () => this.rowsMenu(button),
        'sort-asc': () => this.quickSort(true),
        'sort-desc': () => this.quickSort(false),
        filter: () => this.filterDialog(),
        find: () => this.openFind(false),
        'data-menu': () => this.dataMenu(button),
        'freeze-menu': () => this.freezeMenu(button),
        'add-sheet': () => { this.wb.addSheet(); this.grid.focus(); },
      };
      if (actions[action]) {
        if (this.grid.isEditing() && !['undo', 'redo'].includes(action)) this.grid.commitEdit(0, 0);
        actions[action]();
      }
    }

    menuAt(button, items) {
      const r = button.getBoundingClientRect();
      D.menu(r.left, r.bottom + 4, items);
    }

    /* ---------- Formatting ---------- */

    format(mutate, label) {
      const result = this.wb.updateStyle(this.sheetIndex, [this.selection().range], mutate, label);
      if (result && !result.ok) D.toast(result.message, 'error');
      this.grid.focus();
    }

    applyFont(changes) {
      this.format((s) => {
        s.font = { ...(s.font || {}), ...changes };
        for (const k of Object.keys(s.font)) if (s.font[k] === undefined) delete s.font[k];
      }, 'Font');
    }

    toggleFont(prop) {
      const on = !(this.activeStyle().font || {})[prop];
      this.format((s) => {
        s.font = { ...(s.font || {}) };
        if (on) s.font[prop] = true;
        else delete s.font[prop];
      }, prop[0].toUpperCase() + prop.slice(1));
    }

    setAlignment(prop, value) {
      const current = (this.activeStyle().alignment || {})[prop];
      this.format((s) => {
        s.alignment = { ...(s.alignment || {}) };
        if (current === value) delete s.alignment[prop];
        else s.alignment[prop] = value;
      }, 'Alignment');
    }

    toggleWrap() {
      const on = !(this.activeStyle().alignment || {}).wrapText;
      this.format((s) => {
        s.alignment = { ...(s.alignment || {}) };
        if (on) s.alignment.wrapText = true; else delete s.alignment.wrapText;
      }, 'Wrap text');
    }

    setNumberFormat(fmt) {
      if (fmt === 'custom') return;
      this.format((s) => { if (fmt === 'General') delete s.numFmt; else s.numFmt = fmt; }, 'Number format');
    }

    changeDecimals(delta) {
      const { active } = this.selection();
      const value = this.wb.getValue(this.sheetIndex, active.row, active.col);
      const fmt = adjustDecimals(this.activeStyle().numFmt, delta, value);
      this.format((s) => { s.numFmt = fmt; }, 'Decimal places');
    }

    async toggleMerge() {
      const { range } = this.selection();
      const sheet = this.wb.activeSheet;
      if (sheet.merges.some((m) => U.rangesIntersect(m, range))) {
        this.wb.unmerge(this.sheetIndex, range);
        return;
      }
      const lost = this.wb.mergeDataLoss(this.sheetIndex, range);
      if (lost > 0) {
        const ok = await D.confirm({
          title: 'Merge cells?',
          message: 'Merging keeps only the top-left value. ' + lost + ' other cell' + (lost > 1 ? 's' : '') + ' in the selection will be cleared.',
          confirmText: 'Merge and clear', danger: true,
        });
        if (!ok) return;
      }
      const result = this.wb.merge(this.sheetIndex, range);
      if (!result.ok) D.toast(result.message, 'error');
    }

    bordersMenu(button) {
      const thin = { style: 'thin', color: { argb: 'FF1C2421' } };
      const thick = { style: 'medium', color: { argb: 'FF1C2421' } };
      const apply = (label, opsFor) => () => {
        const r = this.selection().range;
        this.wb.updateStyles(this.sheetIndex, opsFor(r), label);
        this.grid.focus();
      };
      const side = (range, sides, value) => ({
        range,
        mutate: (s) => {
          s.border = { ...(s.border || {}) };
          for (const k of sides) { if (value) s.border[k] = value; else delete s.border[k]; }
        },
      });
      const outside = (r, v) => [
        side({ ...r, r2: r.r1 }, ['top'], v), side({ ...r, r1: r.r2 }, ['bottom'], v),
        side({ ...r, c2: r.c1 }, ['left'], v), side({ ...r, c1: r.c2 }, ['right'], v),
      ];
      this.menuAt(button, [
        { label: 'All borders', action: apply('Borders', (r) => [side(r, ['top', 'right', 'bottom', 'left'], thin)]) },
        { label: 'Outside borders', action: apply('Borders', (r) => outside(r, thin)) },
        { label: 'Thick outside borders', action: apply('Borders', (r) => outside(r, thick)) },
        { label: 'Bottom border', action: apply('Borders', (r) => [side({ ...r, r1: r.r2 }, ['bottom'], thin)]) },
        '-',
        { label: 'No borders', action: apply('Remove borders', (r) => [side(r, ['top', 'right', 'bottom', 'left'], null)]) },
        { label: 'No fill', action: () => this.format((s) => { delete s.fill; }, 'Remove fill') },
      ]);
    }

    /* ---------- Rows, columns, sorting ---------- */

    rowsMenu(button) {
      this.menuAt(button, this.structureItems());
    }

    structureItems() {
      const { range } = this.selection();
      const nRows = range.r2 - range.r1 + 1;
      const nCols = range.c2 - range.c1 + 1;
      const s = this.sheetIndex;
      const plural = (n, word) => (n > 1 ? n + ' ' + word + 's' : word);
      const run = (fn) => () => {
        const result = fn();
        if (result && !result.ok) D.toast(result.message, 'error');
        this.grid.layout();
        this.grid.focus();
      };
      const wholeSheetRows = nRows >= this.wb.activeSheet.rowCount;
      const wholeSheetCols = nCols >= this.wb.activeSheet.colCount;
      return [
        { label: 'Insert ' + plural(nRows, 'row') + ' above', action: run(() => this.wb.insertRows(s, range.r1, nRows)), disabled: wholeSheetRows },
        { label: 'Insert ' + plural(nRows, 'row') + ' below', action: run(() => this.wb.insertRows(s, range.r2 + 1, nRows)), disabled: wholeSheetRows },
        { label: 'Insert ' + plural(nCols, 'column') + ' left', action: run(() => this.wb.insertCols(s, range.c1, nCols)), disabled: wholeSheetCols },
        { label: 'Insert ' + plural(nCols, 'column') + ' right', action: run(() => this.wb.insertCols(s, range.c2 + 1, nCols)), disabled: wholeSheetCols },
        '-',
        { label: 'Delete ' + plural(nRows, 'row'), action: run(() => this.wb.deleteRows(s, range.r1, nRows)), disabled: wholeSheetRows },
        { label: 'Delete ' + plural(nCols, 'column'), action: run(() => this.wb.deleteCols(s, range.c1, nCols)), disabled: wholeSheetCols },
      ];
    }

    /** Range to act on: the selection if it spans several cells, otherwise the surrounding data block. */
    workingRange() {
      const { range, active } = this.selection();
      const single = range.r1 === range.r2 && range.c1 === range.c2;
      const sheet = this.wb.activeSheet;
      const whole = range.r2 >= sheet.rowCount - 1 || range.c2 >= sheet.colCount - 1;
      if (!single && !whole) return range;
      const region = this.wb.currentRegion(this.sheetIndex, active.row, active.col);
      if (whole && !single) {
        const b = sheet.usedBounds();
        return { r1: range.r1, c1: range.c1, r2: Math.min(range.r2, b.maxRow), c2: Math.min(range.c2, b.maxCol) };
      }
      return region;
    }

    quickSort(ascending) {
      const { active } = this.selection();
      const range = this.workingRange();
      if (range.r2 <= range.r1) { D.toast('Select a block of data with at least two rows to sort.', 'error'); return; }
      const hasHeader = this.wb.guessHeader(this.sheetIndex, range);
      const col = U.clamp(active.col, range.c1, range.c2);
      const result = this.wb.sortRange(this.sheetIndex, range, [{ col, ascending }], hasHeader);
      if (!result.ok) { D.toast(result.message, 'error'); return; }
      this.grid.selectRange(range, { row: range.r1, col });
      D.toast('Sorted ' + result.count + ' rows of ' + U.rangeAddress(range) + ' by column ' + U.colToLetters(col) + (hasHeader ? ', keeping the header row.' : '.'), 'success');
    }

    columnOptions(range, hasHeader) {
      const out = [];
      for (let c = range.c1; c <= range.c2; c++) {
        const header = hasHeader ? this.wb.getDisplay(this.sheetIndex, range.r1, c).text : '';
        out.push([String(c), 'Column ' + U.colToLetters(c) + (header ? ' (' + header + ')' : '')]);
      }
      return out;
    }

    async sortDialog() {
      const range = this.workingRange();
      const { active } = this.selection();
      await D.open({
        title: 'Sort range', submitText: 'Sort',
        build: (body) => {
          const rangeInput = el('input', { class: 'input', value: U.rangeAddress(range) });
          const header = D.checkbox('My data has a header row', this.wb.guessHeader(this.sheetIndex, range));
          const by = D.select([], String(active.col));
          const order = D.select([['asc', 'A → Z, smallest first'], ['desc', 'Z → A, largest first']]);
          const then = D.select([]);
          const thenOrder = D.select([['asc', 'A → Z'], ['desc', 'Z → A']]);
          const refresh = () => {
            const r = U.parseRange(rangeInput.value) || range;
            const opts = this.columnOptions(r, header.input.checked);
            const keep = by.value;
            const keepThen = then.value;
            by.replaceChildren(...opts.map(([v, l]) => el('option', { value: v, text: l })));
            then.replaceChildren(el('option', { value: '', text: 'None' }), ...opts.map(([v, l]) => el('option', { value: v, text: l })));
            by.value = opts.some(([v]) => v === keep) ? keep : opts[0][0];
            then.value = keepThen;
          };
          rangeInput.addEventListener('change', refresh);
          header.input.addEventListener('change', refresh);
          refresh();
          body.append(D.field('Range', rangeInput), header.node, D.field('Sort by', by), D.field('Order', order), D.field('Then by (optional)', then), D.field('Then order', thenOrder));
          return () => {
            const r = U.parseRange(rangeInput.value);
            if (!r) return { error: 'Enter a range such as A1:D20.' };
            const keys = [{ col: Number(by.value), ascending: order.value === 'asc' }];
            if (then.value !== '') keys.push({ col: Number(then.value), ascending: thenOrder.value === 'asc' });
            const result = this.wb.sortRange(this.sheetIndex, r, keys, header.input.checked);
            if (!result.ok) return { error: result.message };
            D.toast('Sorted ' + result.count + ' rows.', 'success');
            return true;
          };
        },
      });
      this.grid.focus();
    }

    /* ---------- Filter ---------- */

    async filterDialog() {
      const sheet = this.wb.activeSheet;
      const existing = sheet.filter;
      const range = existing ? existing.range : this.workingRange();
      if (range.r2 <= range.r1 && !existing) { D.toast('Select a block of data with a header row to filter.', 'error'); return; }
      let conditions = existing ? existing.conditions.slice() : [];
      const result = await D.open({
        title: 'Filter rows', submitText: 'Apply filter', wide: true,
        build: (body) => {
          const rangeInput = el('input', { class: 'input', value: U.rangeAddress(range) });
          const list = el('ul', { class: 'condition-list' });
          const col = D.select([]);
          const op = D.select(FILTER_OPERATORS);
          const value = el('input', { class: 'input', placeholder: 'Value' });
          const currentRange = () => U.parseRange(rangeInput.value) || range;
          const opName = (o) => (FILTER_OPERATORS.find(([k]) => k === o) || [o, o])[1];
          const renderList = () => {
            list.replaceChildren(...conditions.map((c, i) => el('li', {}, [
              el('span', { text: 'Column ' + U.colToLetters(c.col) + ' ' + opName(c.op) + (['empty', 'notEmpty'].includes(c.op) ? '' : ' "' + c.value + '"') }),
              el('button', { type: 'button', class: 'btn btn-quiet', text: 'Remove', onclick: () => { conditions.splice(i, 1); renderList(); } }),
            ])));
            if (!conditions.length) list.append(el('li', { class: 'muted', text: 'No conditions yet. All rows are shown.' }));
          };
          const refreshCols = () => {
            const opts = this.columnOptions(currentRange(), true);
            col.replaceChildren(...opts.map(([v, l]) => el('option', { value: v, text: l })));
            const active = String(this.selection().active.col);
            if (opts.some(([v]) => v === active)) col.value = active;
          };
          op.addEventListener('change', () => { value.disabled = ['empty', 'notEmpty'].includes(op.value); });
          rangeInput.addEventListener('change', refreshCols);
          refreshCols();
          renderList();
          const add = el('button', {
            type: 'button', class: 'btn', text: 'Add condition',
            onclick: () => {
              if (!value.disabled && value.value === '') { value.focus(); return; }
              conditions.push({ col: Number(col.value), op: op.value, value: value.value });
              value.value = '';
              renderList();
            },
          });
          body.append(
            D.field('Data range (first row is the header)', rangeInput),
            el('div', { class: 'field-row' }, [D.field('Column', col), D.field('Condition', op), D.field('Value', value), add]),
            el('h3', { class: 'subhead', text: 'Rows are shown when they match every condition' }),
            list,
            existing ? el('button', { type: 'button', class: 'btn btn-quiet', text: 'Remove filter and show all rows', onclick: () => { conditions = []; renderList(); } }) : null,
          );
          return () => {
            const r = U.parseRange(rangeInput.value);
            if (!r || r.r2 <= r.r1) return { error: 'Enter a range with a header row and at least one data row, such as A1:D20.' };
            if (!value.disabled && value.value !== '') conditions.push({ col: Number(col.value), op: op.value, value: value.value });
            if (conditions.some((c) => c.col < r.c1 || c.col > r.c2)) return { error: 'A condition uses a column outside the range.' };
            return { range: r, conditions };
          };
        },
      });
      if (!result) { this.grid.focus(); return; }
      const out = this.wb.applyFilter(this.sheetIndex, result.range, result.conditions);
      this.grid.layout();
      this.grid.focus();
      D.toast(result.conditions.length ? out.hidden + ' row' + (out.hidden === 1 ? '' : 's') + ' hidden by the filter.' : 'Filter removed. All rows are shown.', 'success');
    }

    /* ---------- Data validation, duplicates, freeze ---------- */

    dataMenu(button) {
      this.menuAt(button, [
        { label: 'Custom sort…', action: () => this.sortDialog() },
        { label: 'Filter…', action: () => this.filterDialog() },
        '-',
        { label: 'Data validation…', action: () => this.validationDialog() },
        { label: 'Show cells that break validation', action: () => this.showInvalid() },
        { label: 'Highlight duplicates', action: () => this.highlightDuplicates() },
        { label: 'Clear highlights', action: () => { this.grid.clearHighlights(); this.grid.renderNow(); } },
        '-',
        { label: 'Clear contents', shortcut: 'Del', action: () => this.wb.clearRanges(this.sheetIndex, [this.selection().range], 'contents') },
        { label: 'Clear everything', action: () => this.wb.clearRanges(this.sheetIndex, [this.selection().range], 'all') },
      ]);
    }

    highlightDuplicates() {
      const range = this.workingRange();
      const { keys, groupCount } = this.wb.findDuplicates(this.sheetIndex, range);
      this.grid.setHighlights(keys, 'dup');
      D.toast(keys.size
        ? keys.size + ' cells in ' + U.rangeAddress(range) + ' share a value with another cell (' + groupCount + ' different value' + (groupCount > 1 ? 's' : '') + '). Press Esc to clear.'
        : 'No duplicate values in ' + U.rangeAddress(range) + '.', keys.size ? 'info' : 'success');
    }

    showInvalid() {
      const keys = this.wb.findInvalidCells(this.sheetIndex);
      this.grid.setHighlights(keys, 'invalid');
      D.toast(keys.size ? keys.size + ' cell(s) break their validation rule. Press Esc to clear.' : 'Every validated cell is valid.', keys.size ? 'info' : 'success');
    }

    async validationDialog() {
      const { range, active } = this.selection();
      const sheet = this.wb.activeSheet;
      if (range.r2 >= sheet.rowCount - 1 && range.c2 >= sheet.colCount - 1) {
        D.toast('Select the cells to validate first (not the whole sheet).', 'error');
        return;
      }
      const current = this.wb.getValidation(this.sheetIndex, active.row, active.col);
      const supported = !current || SheetApp.spreadsheet.SUPPORTED_RULES.includes(current.type);
      const result = await D.open({
        title: 'Data validation for ' + U.rangeAddress(range), submitText: 'Save rule',
        build: (body) => {
          const type = D.select([['none', 'Any value (no rule)'], ['whole', 'Whole number'], ['decimal', 'Decimal number'], ['list', 'List of items'], ['textLength', 'Text length']], current && supported ? current.type : 'none');
          const op = D.select(VALIDATION_OPERATORS, (current && current.operator) || 'between');
          const min = el('input', { class: 'input', inputmode: 'decimal', value: current && current.formulae ? String(current.formulae[0] ?? '') : '' });
          const max = el('input', { class: 'input', inputmode: 'decimal', value: current && current.formulae ? String(current.formulae[1] ?? '') : '' });
          const listValue = current && current.type === 'list' ? String(current.formulae[0] || '').replace(/^"|"$/g, '') : '';
          const items = el('input', { class: 'input', value: listValue, placeholder: 'Yes, No, Maybe' });
          const style = D.select([['stop', 'Reject the value'], ['warning', 'Warn, but allow it']], (current && current.errorStyle) || 'stop');
          const message = el('input', { class: 'input', value: (current && current.error) || '', placeholder: 'Optional message shown when input is invalid' });
          const blank = D.checkbox('Allow empty cells', !current || current.allowBlank !== false);
          const opField = D.field('Condition', op);
          const minField = D.field('Value', min);
          const maxField = D.field('And', max);
          const itemsField = D.field('Items (separated by commas)', items);
          const sync = () => {
            const t = type.value;
            opField.hidden = minField.hidden = !['whole', 'decimal', 'textLength'].includes(t);
            maxField.hidden = minField.hidden || !['between', 'notBetween'].includes(op.value);
            itemsField.hidden = t !== 'list';
          };
          type.addEventListener('change', sync);
          op.addEventListener('change', sync);
          sync();
          if (!supported) body.append(el('p', { class: 'note', text: 'These cells have a rule from the original file that the editor keeps but cannot edit. Saving replaces it.' }));
          body.append(D.field('Allow', type), el('div', { class: 'field-row' }, [opField, minField, maxField]), itemsField, D.field('When input is invalid', style), D.field('Message', message), blank.node);
          return () => {
            if (type.value === 'none') return { rule: null };
            const rule = { type: type.value, allowBlank: blank.input.checked, showErrorMessage: true, errorStyle: style.value };
            if (message.value.trim()) rule.error = message.value.trim();
            if (type.value === 'list') {
              const list = items.value.split(',').map((s) => s.trim()).filter(Boolean);
              if (!list.length) return { error: 'Enter at least one item.' };
              if (list.join(',').length > 250) return { error: 'The list is too long for Excel (255 characters at most).' };
              rule.formulae = ['"' + list.join(',').replace(/"/g, '') + '"'];
            } else {
              const a = U.parseNumber(min.value);
              if (a === null) return { error: 'Enter a number for the value.' };
              rule.operator = op.value;
              rule.formulae = [a];
              if (['between', 'notBetween'].includes(op.value)) {
                const b = U.parseNumber(max.value);
                if (b === null || b < a) return { error: 'Enter a second number that is at least the first.' };
                rule.formulae.push(b);
              }
            }
            return { rule };
          };
        },
      });
      if (result) {
        this.wb.setValidation(this.sheetIndex, range, result.rule);
        const invalid = result.rule ? this.wb.findInvalidCells(this.sheetIndex).size : 0;
        D.toast(result.rule ? 'Rule saved: ' + describeRule(result.rule) + (invalid ? ' ' + invalid + ' existing cell(s) break it; use Data → Show cells that break validation.' : '') : 'Validation removed.', 'success');
      }
      this.grid.focus();
    }

    freezeMenu(button) {
      const { active } = this.selection();
      const set = (rows, cols) => () => { this.wb.setFrozen(this.sheetIndex, rows, cols); this.grid.layout(); this.grid.focus(); };
      this.menuAt(button, [
        { label: 'No frozen panes', action: set(0, 0) },
        { label: 'Freeze top row', action: set(1, 0) },
        { label: 'Freeze first column', action: set(0, 1) },
        { label: 'Freeze above and left of ' + U.cellAddress(active.row, active.col), action: set(active.row, active.col), disabled: active.row === 0 && active.col === 0 },
      ]);
    }

    /* ---------- Find and replace ---------- */

    openFind(focusReplace) {
      if (this.findPanel) {
        this.findPanel.querySelector(focusReplace ? '.find-replace' : '.find-query').focus();
        return;
      }
      const query = el('input', { class: 'input find-query', placeholder: 'Find', 'aria-label': 'Find' });
      const replacement = el('input', { class: 'input find-replace', placeholder: 'Replace with', 'aria-label': 'Replace with' });
      const matchCase = D.checkbox('Match case');
      const whole = D.checkbox('Entire cell');
      const lookIn = D.select([['values', 'Search displayed values'], ['formulas', 'Search contents and formulas']]);
      const scope = D.select([['sheet', 'This sheet'], ['workbook', 'All sheets']]);
      const info = el('p', { class: 'find-info', 'aria-live': 'polite' });
      const options = (forReplace) => ({
        query: query.value, matchCase: matchCase.input.checked, wholeCell: whole.input.checked,
        lookIn: forReplace ? 'formulas' : lookIn.value, scope: scope.value, sheetIndex: this.sheetIndex,
      });
      const next = (forReplace) => {
        const matches = this.wb.findMatches(options(forReplace));
        if (!matches.length) { info.textContent = query.value ? 'No matches.' : ''; return null; }
        const { active } = this.selection();
        const s = this.sheetIndex;
        const after = (m) => m.sheetIndex > s || (m.sheetIndex === s && (m.row > active.row || (m.row === active.row && m.col > active.col)));
        const target = matches.find(after) || matches[0];
        if (target.sheetIndex !== s) this.wb.setActive(target.sheetIndex);
        this.grid.select({ row: target.row, col: target.col });
        info.textContent = (matches.indexOf(target) + 1) + ' of ' + matches.length + ' matches';
        return target;
      };
      const replaceOne = () => {
        const { active } = this.selection();
        const here = this.wb.findMatches(options(true)).find((m) => m.sheetIndex === this.sheetIndex && m.row === active.row && m.col === active.col);
        if (here) {
          const res = this.wb.replaceMatches([here], { ...options(true), replacement: replacement.value });
          if (!res.replaced) info.textContent = 'This cell could not be replaced (the result is not a valid formula).';
        }
        next(true);
      };
      const replaceAll = () => {
        const matches = this.wb.findMatches(options(true));
        if (!matches.length) { info.textContent = 'No matches.'; return; }
        const res = this.wb.replaceMatches(matches, { ...options(true), replacement: replacement.value });
        info.textContent = 'Replaced ' + res.replaced + ' cell' + (res.replaced === 1 ? '' : 's') + (res.skipped ? '; ' + res.skipped + ' skipped' : '') + '.';
      };
      const close = () => { this.findPanel.remove(); this.findPanel = null; this.grid.focus(); };
      const panel = el('section', { class: 'find-panel', role: 'dialog', 'aria-label': 'Find and replace' }, [
        el('div', { class: 'find-head' }, [el('h2', { text: 'Find and replace' }), el('button', { type: 'button', class: 'notice-close', 'aria-label': 'Close find and replace', text: '×', onclick: close })]),
        query, replacement,
        el('div', { class: 'find-options' }, [matchCase.node, whole.node]),
        el('div', { class: 'find-options' }, [lookIn, scope]),
        el('div', { class: 'find-actions' }, [
          el('button', { type: 'button', class: 'btn btn-primary', text: 'Find next', onclick: () => next(false) }),
          el('button', { type: 'button', class: 'btn', text: 'Replace', onclick: replaceOne }),
          el('button', { type: 'button', class: 'btn', text: 'Replace all', onclick: replaceAll }),
        ]),
        info,
      ]);
      panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); if (e.target === replacement) replaceOne(); else next(false); }
      });
      document.body.append(panel);
      this.findPanel = panel;
      (focusReplace ? replacement : query).focus();
    }

    /* ---------- Formula bar and name box ---------- */

    bindFormulaBar() {
      const input = $('formula-input');
      input.addEventListener('focus', () => {
        if (!this.grid.isEditing()) {
          this.grid.setEditTextFromBar(input.value);
          input.focus();
        } else {
          this.grid.editing.viaBar = true;
        }
      });
      input.addEventListener('input', () => {
        this.grid.setEditTextFromBar(input.value);
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.altKey && !e.shiftKey) { e.preventDefault(); this.grid.commitEdit(1, 0); }
        else if (e.key === 'Tab') { e.preventDefault(); this.grid.commitEdit(0, e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); this.grid.cancelEdit(); }
        else if (e.key === 'Enter' && e.altKey) {
          e.preventDefault();
          const pos = input.selectionStart;
          input.value = input.value.slice(0, pos) + '\n' + input.value.slice(input.selectionEnd);
          input.selectionStart = input.selectionEnd = pos + 1;
          input.dispatchEvent(new Event('input'));
        }
      });
      input.addEventListener('blur', () => {
        setTimeout(() => {
          const ed = this.grid.editing;
          if (ed && ed.viaBar && document.activeElement !== input && document.activeElement !== this.grid.editor) this.grid.commitEdit(0, 0);
        }, 0);
      });
    }

    bindNameBox() {
      const box = $('name-box');
      box.addEventListener('focus', () => box.select());
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.refresh(); this.grid.focus(); return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        let text = box.value.trim();
        let sheetIndex = this.sheetIndex;
        const bang = text.lastIndexOf('!');
        if (bang > 0) {
          const name = text.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
          sheetIndex = this.wb.resolveSheet(name);
          text = text.slice(bang + 1);
          if (sheetIndex < 0) { D.toast('There is no sheet named "' + name + '".', 'error'); return; }
        }
        const range = U.parseRange(text);
        if (!range) { D.toast('"' + box.value + '" is not a cell address. Try C5 or A1:D10.', 'error'); return; }
        if (sheetIndex !== this.sheetIndex) this.wb.setActive(sheetIndex);
        this.grid.select({ row: range.r1, col: range.c1 }, { row: range.r2, col: range.c2 });
        this.grid.focus();
      });
    }

    onEditInput(text) {
      const input = $('formula-input');
      if (document.activeElement !== input) input.value = text;
    }

    /* ---------- Refresh ---------- */

    refresh() {
      const wb = this.wb;
      const { active, range } = this.selection();
      const sheet = wb.activeSheet;
      const cell = sheet.getCell(active.row, active.col);
      const style = (cell && cell.style) || {};
      const font = style.font || {};
      const align = style.alignment || {};
      const press = (action, on) => document.querySelectorAll('[data-action="' + action + '"]').forEach((b) => b.setAttribute('aria-pressed', on ? 'true' : 'false'));
      press('bold', font.bold);
      press('italic', font.italic);
      press('underline', font.underline);
      press('align-left', align.horizontal === 'left');
      press('align-center', align.horizontal === 'center');
      press('align-right', align.horizontal === 'right');
      press('valign-top', align.vertical === 'top');
      press('valign-middle', align.vertical === 'middle');
      press('valign-bottom', align.vertical === 'bottom');
      press('wrap', align.wrapText);
      press('merge', sheet.merges.some((m) => U.rangesIntersect(m, range)));
      const fontName = $('font-name');
      fontName.value = [...fontName.options].some((o) => o.value === font.name) ? font.name : '';
      const size = $('font-size');
      const sizeValue = String(font.size || 10);
      if (![...size.options].some((o) => o.value === sizeValue)) size.append(el('option', { text: sizeValue }));
      size.value = sizeValue;
      const fmt = $('number-format');
      const numFmt = style.numFmt || 'General';
      const known = [...fmt.options].find((o) => o.value === numFmt && o.value !== 'custom');
      const custom = fmt.querySelector('option[value="custom"]');
      custom.hidden = !!known;
      custom.textContent = 'Custom: ' + numFmt;
      fmt.value = known ? numFmt : 'custom';

      document.querySelector('[data-action="undo"]').disabled = !wb.canUndo();
      document.querySelector('[data-action="redo"]').disabled = !wb.canRedo();

      const nameBox = $('name-box');
      if (document.activeElement !== nameBox) nameBox.value = U.cellAddress(active.row, active.col);
      const input = $('formula-input');
      if (!this.grid.isEditing()) {
        input.value = wb.getInputText(this.sheetIndex, active.row, active.col);
        input.style.height = '';
      }
      this.refreshValueInfo(cell, active);
      this.refreshTabs();
      this.refreshStatus(range, active);
      this.refreshFileInfo();
      $('empty-hint').hidden = !(this.app.isPristine() && sheet.cells.size === 0 && wb.sheets.length === 1 && !this.grid.isEditing());
    }

    /** Shows the stored value next to how it is displayed, so format and value are never confused. */
    refreshValueInfo(cell, active) {
      const box = $('value-info');
      box.replaceChildren();
      box.className = 'value-info';
      if (!cell) return;
      const display = this.wb.getDisplay(this.sheetIndex, active.row, active.col);
      const parts = [];
      const fmt = cell.style && cell.style.numFmt;
      if (display.warning) {
        box.classList.add('warn');
        box.append(el('span', { text: display.warning }));
        return;
      }
      const validation = this.wb.getValidation(this.sheetIndex, active.row, active.col);
      if (cell.formula) parts.push(['Result', display.text || '(empty)']);
      else if (typeof cell.value === 'number' && fmt) parts.push(['Stored value', U.formatGeneralNumber(cell.value)]);
      if (fmt && typeof this.wb.getValue(this.sheetIndex, active.row, active.col) === 'number') parts.push(['Format', fmt]);
      if (validation) parts.push(['Rule', describeRule(validation)]);
      for (const [label, value] of parts) {
        box.append(el('span', { class: 'vi' }, [el('span', { class: 'vi-label', text: label }), el('span', { class: 'vi-value', text: value })]));
      }
    }

    refreshStatus(range, active) {
      const sheet = this.wb.activeSheet;
      $('status-sheet').textContent = sheet.name;
      const rows = range.r2 - range.r1 + 1;
      const cols = range.c2 - range.c1 + 1;
      const multi = rows > 1 || cols > 1;
      $('status-selection').textContent = multi ? U.rangeAddress(range) + ' (' + rows.toLocaleString() + ' × ' + cols.toLocaleString() + ')' : U.cellAddress(active.row, active.col);
      const stats = $('status-stats');
      stats.replaceChildren();
      if (multi) {
        const st = this.wb.selectionStats(this.sheetIndex, range);
        const item = (label, value) => el('span', { class: 'stat' }, [el('span', { class: 'stat-label', text: label }), el('span', { text: value })]);
        stats.append(item('Count', st.count.toLocaleString()));
        if (st.numbers) {
          stats.append(item('Sum', U.formatGeneralNumber(st.sum)), item('Average', U.formatGeneralNumber(st.average)));
        }
      }
      if (sheet.filter) stats.append(el('span', { class: 'stat filter-on', text: 'Filter on: ' + sheet.filterHiddenRows.size + ' rows hidden' }));
    }

    refreshFileInfo() {
      const f = this.app.file;
      $('file-name').textContent = f.name;
      $('file-name').title = f.name;
      const meta = [];
      if (f.format) meta.push(SheetApp.fileManager.FORMAT_LABELS[f.format] || f.format);
      meta.push(this.wb.sheets.length + (this.wb.sheets.length === 1 ? ' sheet' : ' sheets'));
      if (f.size) meta.push('about ' + U.formatBytes(f.size));
      $('file-meta').replaceChildren(...meta.map((m) => el('span', { class: 'meta-chip', text: m })));
      $('dirty-flag').hidden = !this.wb.isDirty();
      document.title = (this.wb.isDirty() ? '• ' : '') + f.name + ' — Sheet Editor';
    }

    refreshTabs() {
      const tabs = $('tabs');
      const wb = this.wb;
      const nodes = wb.sheets.map((sheet, i) => {
        const selected = i === wb.activeIndex;
        const tab = el('button', {
          type: 'button', role: 'tab', class: 'tab' + (selected ? ' active' : '') + (sheet.state !== 'visible' ? ' hidden-sheet' : ''),
          'aria-selected': selected ? 'true' : 'false', tabindex: selected ? '0' : '-1', draggable: 'true',
          title: sheet.state !== 'visible' ? sheet.name + ' (hidden in Excel)' : sheet.name + '. Double-click to rename; right-click for more.',
          text: sheet.name,
        });
        tab.addEventListener('click', () => { this.grid.commitEdit(0, 0); wb.setActive(i); this.grid.focus(); });
        tab.addEventListener('dblclick', () => this.renameSheet(i));
        tab.addEventListener('contextmenu', (e) => { e.preventDefault(); wb.setActive(i); this.tabMenu(e.clientX, e.clientY, i); });
        tab.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = U.clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, wb.sheets.length - 1);
            wb.setActive(next);
            setTimeout(() => tabs.children[next] && tabs.children[next].focus(), 0);
          } else if (e.key === 'F2') { e.preventDefault(); this.renameSheet(i); }
          else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const r = tab.getBoundingClientRect();
            this.tabMenu(r.left, r.top - 4, i);
          }
        });
        tab.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-sheet-index', String(i)); e.dataTransfer.effectAllowed = 'move'; });
        tab.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-sheet-index')) { e.preventDefault(); tab.classList.add('drop-target'); } });
        tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
        tab.addEventListener('drop', (e) => {
          e.preventDefault();
          tab.classList.remove('drop-target');
          const from = Number(e.dataTransfer.getData('text/x-sheet-index'));
          if (!Number.isNaN(from)) wb.moveSheet(from, i);
        });
        return tab;
      });
      tabs.replaceChildren(...nodes);
      const active = tabs.children[wb.activeIndex];
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    tabMenu(x, y, index) {
      const wb = this.wb;
      D.menu(x, y, [
        { label: 'Rename…', action: () => this.renameSheet(index) },
        { label: 'Duplicate', action: () => wb.duplicateSheet(index) },
        { label: 'Move left', action: () => wb.moveSheet(index, index - 1), disabled: index === 0 },
        { label: 'Move right', action: () => wb.moveSheet(index, index + 1), disabled: index === wb.sheets.length - 1 },
        '-',
        { label: 'Delete…', action: () => this.deleteSheet(index), disabled: wb.sheets.length === 1 },
      ]);
    }

    async renameSheet(index) {
      const wb = this.wb;
      const name = await D.prompt({
        title: 'Rename sheet', label: 'Sheet name', value: wb.sheets[index].name, submitText: 'Rename',
        validate: (v) => wb.validateSheetName(v, index),
      });
      if (name !== null) {
        const result = wb.renameSheet(index, name);
        if (!result.ok) D.toast(result.message, 'error');
      }
      this.grid.focus();
    }

    async deleteSheet(index) {
      const wb = this.wb;
      const sheet = wb.sheets[index];
      const ok = await D.confirm({
        title: 'Delete "' + sheet.name + '"?',
        message: sheet.cells.size
          ? 'The sheet has ' + sheet.cells.size.toLocaleString() + ' non-empty cells. Formulas on other sheets that refer to it will show #REF!. You can undo this.'
          : 'The sheet is empty. You can undo this.',
        confirmText: 'Delete sheet', danger: true,
      });
      if (ok) {
        const result = wb.deleteSheet(index);
        if (!result.ok) D.toast(result.message, 'error');
      }
      this.grid.focus();
    }

    /* ---------- Grid context menu ---------- */

    gridMenu(e) {
      const pasteItem = {
        label: 'Paste', shortcut: 'Ctrl+V',
        action: async () => {
          try {
            const text = await navigator.clipboard.readText();
            this.grid.pasteText(text);
          } catch (err) {
            D.toast('Your browser blocked clipboard access from the menu. Press Ctrl+V to paste.', 'info');
          }
          this.grid.focus();
        },
      };
      D.menu(e.clientX, e.clientY, [
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => this.grid.copySelectionToSystem(true) },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => this.grid.copySelectionToSystem(false) },
        pasteItem,
        '-',
        ...this.structureItems(),
        '-',
        { label: 'Clear contents', shortcut: 'Del', action: () => this.wb.clearRanges(this.sheetIndex, [this.selection().range], 'contents') },
        { label: 'Clear formatting', action: () => this.wb.clearRanges(this.sheetIndex, [this.selection().range], 'formats') },
        '-',
        { label: 'Sort A → Z', action: () => this.quickSort(true) },
        { label: 'Sort Z → A', action: () => this.quickSort(false) },
      ]);
    }
  }

  SheetApp.Toolbar = Toolbar;
})(typeof window !== 'undefined' ? window : globalThis);
