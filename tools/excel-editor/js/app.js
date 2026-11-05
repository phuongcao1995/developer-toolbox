/*
 * app.js — wires the model, grid, toolbar and file manager together.
 * Owns the open / new / download flows, import and export options, drag-and-drop,
 * keyboard shortcuts and unsaved-change protection.
 */
(function (root) {
  'use strict';
  const SheetApp = root.SheetApp;
  const U = SheetApp.utils;
  const D = SheetApp.dialogs;
  const FM = SheetApp.fileManager;
  const { Workbook } = SheetApp.spreadsheet;
  const { el } = U;
  const $ = (id) => document.getElementById(id);

  const DELIMITER_LABELS = [[',', 'Comma ( , )'], [';', 'Semicolon ( ; )'], ['\t', 'Tab'], ['|', 'Vertical bar ( | )']];

  const app = {
    wb: null,
    grid: null,
    toolbar: null,
    file: null,
    statusTimer: null,

    init() {
      this.wb = Workbook.createBlank();
      this.file = blankFileInfo();
      this.grid = new SheetApp.GridView($('grid'), this.wb, {
        onSelectionChange: () => this.toolbar && this.toolbar.refresh(),
        onEditInput: (text) => this.toolbar.onEditInput(text),
        commitInput: (row, col, text) => this.commitInput(row, col, text),
        onContextMenu: (e) => this.toolbar.gridMenu(e),
        onStatus: (message) => this.status(message),
      });
      this.toolbar = new SheetApp.Toolbar(this);
      this.attachListeners(this.wb);
      this.bindFileInput();
      this.bindDragAndDrop();
      this.bindShortcuts();
      this.bindNotice();
      window.addEventListener('beforeunload', (e) => {
        if (this.wb.isDirty()) { e.preventDefault(); e.returnValue = ''; }
      });
      this.checkLibraries();
      this.toolbar.refresh();
      this.grid.focus();
    },

    attachListeners(wb) {
      wb.on((event) => {
        if (event.type === 'cells') this.grid.renderNow();
        else this.grid.layout();
        this.toolbar.refresh();
      });
    },

    isPristine() {
      return !this.file.format && !this.wb.canUndo() && !this.wb.canRedo();
    },

    status(message) {
      const node = $('status-message');
      node.textContent = message || '';
      clearTimeout(this.statusTimer);
      if (message) this.statusTimer = setTimeout(() => { node.textContent = ''; }, 5000);
    },

    checkLibraries() {
      const missing = [];
      if (!root.ExcelJS) missing.push('ExcelJS (needed for .xlsx)');
      if (!root.XLSX) missing.push('SheetJS (needed for .xls and number formats)');
      if (missing.length) {
        this.showNotice('warn', 'Some file formats are unavailable because ' + missing.join(' and ') + ' could not be loaded. CSV files still work.', [
          'Connect to the internet and reload, or download the libraries into the vendor folder (see README) to work offline.',
        ]);
      }
    },

    /* ---------- Editing ---------- */

    async commitInput(row, col, text) {
      const result = this.wb.setCellInput(this.wb.activeIndex, row, col, text);
      if (result.ok) return true;
      if (result.canOverride) {
        const keep = await D.confirm({
          title: 'This value breaks the rule for ' + U.cellAddress(row, col),
          message: result.message, confirmText: 'Keep this value', cancelText: 'Edit again',
        });
        if (keep) {
          this.wb.setCellInput(this.wb.activeIndex, row, col, text, { skipValidation: true });
          return true;
        }
        return false;
      }
      D.toast(result.message, 'error');
      return false;
    },

    undo() {
      if (this.grid.isEditing()) this.grid.cancelEdit();
      const label = this.wb.undo();
      this.status(label ? 'Undid: ' + label : 'Nothing to undo.');
      this.grid.focus();
    },

    redo() {
      if (this.grid.isEditing()) this.grid.commitEdit(0, 0);
      const label = this.wb.redo();
      this.status(label ? 'Redid: ' + label : 'Nothing to redo.');
      this.grid.focus();
    },

    /* ---------- New / open ---------- */

    async confirmDiscard(action) {
      if (this.grid.isEditing()) await this.grid.commitEdit(0, 0);
      if (!this.wb.isDirty()) return true;
      return D.confirm({
        title: 'Discard unsaved changes?',
        message: 'Changes to "' + this.file.name + '" have not been downloaded. ' + action + ' will discard them.',
        confirmText: 'Discard changes', cancelText: 'Keep editing', danger: true,
      });
    },

    async newWorkbook() {
      if (!(await this.confirmDiscard('Creating a new workbook'))) return;
      this.useWorkbook(Workbook.createBlank(), blankFileInfo());
      this.status('New workbook created.');
    },

    useWorkbook(wb, fileInfo) {
      this.wb = wb;
      this.file = fileInfo;
      this.attachListeners(wb);
      wb.markSaved();
      this.grid.setWorkbook(wb);
      this.hideNotice();
      if (fileInfo.lost && fileInfo.lost.length) {
        this.showNotice('warn', 'Some parts of this file cannot be kept and will be missing when you download it: ' + fileInfo.lost.map(shortLabel).join(', ') + '.', fileInfo.lost.concat(fileInfo.notes || []));
      } else if (fileInfo.notes && fileInfo.notes.length) {
        this.showNotice('info', fileInfo.notes[0], fileInfo.notes);
      }
      this.toolbar.refresh();
      this.grid.focus();
    },

    chooseFile() {
      $('file-input').value = '';
      $('file-input').click();
    },

    bindFileInput() {
      $('file-input').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) this.openFile(file);
      });
    },

    async openFile(file) {
      if (!(await this.confirmDiscard('Opening another file'))) return;
      try {
        D.setBusy('Reading ' + file.name + '…');
        await U.nextFrame();
        const info = await FM.inspectFile(file);
        D.setBusy('');
        if (info.isLarge) {
          const go = await D.confirm({
            title: 'Open a large file?',
            message: '"' + file.name + '" is ' + U.formatBytes(file.size) + '. Opening it may take a while and use a lot of memory. Everything stays on your computer.',
            confirmText: 'Open file',
          });
          if (!go) return;
        }
        let result;
        let extra = {};
        if (info.format === 'csv') {
          const options = await this.csvImportDialog(info);
          if (!options) return;
          D.setBusy('Importing ' + file.name + '…');
          await U.nextFrame();
          result = FM.csvToWorkbook(options.text, options);
          extra = { delimiter: options.delimiter, decimalComma: options.decimalComma };
        } else {
          D.setBusy('Opening ' + file.name + '…');
          await U.nextFrame();
          result = await FM.loadWorkbook(info);
        }
        this.useWorkbook(result.workbook, {
          name: file.name, baseName: file.name.replace(/\.[^.]+$/, ''), format: info.format, size: info.size,
          lost: result.lost, notes: result.notes, ...extra,
        });
        const sheets = result.workbook.sheets.length;
        D.toast('Opened "' + file.name + '" (' + sheets + (sheets === 1 ? ' sheet).' : ' sheets).'), 'success');
      } catch (e) {
        D.setBusy('');
        const message = e instanceof FM.FileError ? e.message : 'Something went wrong while opening "' + file.name + '": ' + e.message;
        await D.alert({ title: 'The file could not be opened', message });
      } finally {
        D.setBusy('');
      }
    },

    csvImportDialog(info) {
      let prepared = FM.prepareCsv(info, 'auto');
      const detectedEncoding = prepared.encoding;
      return D.open({
        title: 'Import "' + info.name + '"', submitText: 'Import', wide: true,
        build: (body) => {
          const delimiter = D.select(DELIMITER_LABELS, prepared.delimiter);
          const encoding = D.select([
            ['auto', 'Automatic (' + detectedEncoding.toUpperCase() + ')'], ['utf-8', 'UTF-8'],
            ['windows-1258', 'Windows-1258 (Vietnamese)'], ['windows-1252', 'Windows-1252 (Western)'], ['utf-16le', 'UTF-16'],
          ], 'auto');
          const decimal = D.select([['.', 'Point (1,234.5)'], [',', 'Comma (1.234,5)']], prepared.delimiter === ';' ? ',' : '.');
          const convert = D.checkbox('Convert numbers and dates', true);
          const formulas = D.checkbox('Treat values starting with "=" as formulas', false);
          const detection = el('p', { class: prepared.confident ? 'note' : 'note warn' });
          const preview = el('div', { class: 'preview', tabindex: '0', 'aria-label': 'Preview of the first rows' });
          const update = () => {
            detection.textContent = prepared.confident
              ? 'Columns appear to be separated by ' + DELIMITER_LABELS.find(([d]) => d === prepared.delimiter)[1].toLowerCase() + '.'
              : 'The separator could not be detected reliably. Check the preview and choose the right one.';
            const rows = U.parseCsv(prepared.text.slice(0, 20000), delimiter.value).slice(0, 8);
            const width = Math.min(8, rows.reduce((m, r) => Math.max(m, r.length), 0));
            const table = el('table', {}, rows.map((r) => el('tr', {}, Array.from({ length: width }, (_, i) => el('td', { text: r[i] === undefined ? '' : r[i] })))));
            preview.replaceChildren(table);
          };
          delimiter.addEventListener('change', update);
          encoding.addEventListener('change', () => {
            prepared = { ...FM.prepareCsv(info, encoding.value), delimiter: delimiter.value };
            update();
          });
          update();
          body.append(
            detection,
            el('div', { class: 'field-row' }, [D.field('Separator', delimiter), D.field('Text encoding', encoding), D.field('Decimal separator', decimal)]),
            convert.node,
            formulas.node,
            el('small', { class: 'hint', text: 'Leave formulas off for files from untrusted sources. Codes with leading zeros (007) and long numbers such as IDs stay as text.' }),
            el('h3', { class: 'subhead', text: 'Preview' }),
            preview,
          );
          return () => ({
            text: prepared.text, delimiter: delimiter.value, decimalComma: decimal.value === ',',
            convertValues: convert.input.checked, interpretFormulas: formulas.input.checked,
            sheetName: safeSheetName(info.name.replace(/\.[^.]+$/, '')),
          });
        },
      });
    },

    /* ---------- Download ---------- */

    async save() {
      if (this.grid.isEditing()) {
        await this.grid.commitEdit(0, 0);
        if (this.grid.isEditing()) return;
      }
      const choice = await this.exportDialog();
      if (!choice) { this.grid.focus(); return; }
      try {
        D.setBusy('Preparing ' + choice.filename + '…');
        await U.nextFrame();
        let blob;
        if (choice.format === 'xlsx') blob = await FM.writeXlsx(this.wb);
        else if (choice.format === 'xls') blob = FM.writeXls(this.wb);
        else blob = FM.writeCsv(this.wb, choice.csv);
        U.downloadBlob(blob, choice.filename);
        // Only a lossless download counts as saving the work.
        if (choice.lossless) this.wb.markSaved();
        this.toolbar.refresh();
        D.toast('Downloaded "' + choice.filename + '".' + (choice.lossless ? '' : ' Keep editing here or download an .xlsx to keep everything.'), 'success');
      } catch (e) {
        await D.alert({ title: 'The file could not be created', message: e instanceof FM.FileError ? e.message : 'Something went wrong: ' + e.message });
      } finally {
        D.setBusy('');
        this.grid.focus();
      }
    },

    exportDialog() {
      const wb = this.wb;
      const file = this.file;
      const csvDefaults = () => ({
        sheetIndex: wb.activeIndex, delimiter: file.delimiter || ',', bom: true, protectFormulas: true,
        decimalComma: !!file.decimalComma, values: 'display',
      });
      // Keep the original format when nothing would be lost; otherwise suggest .xlsx.
      const original = file.format === 'xlsm' ? 'xlsx' : file.format;
      let initial = 'xlsx';
      let reason = '';
      if (original === 'xls' || original === 'csv') {
        const losses = FM.exportWarnings(wb, original, csvDefaults(), file);
        if (losses.length === 0) initial = original;
        else reason = 'The original format (.' + original + ') cannot keep everything in this workbook, so .xlsx is selected.';
      }
      if (file.format === 'xlsm') reason = 'Macro-enabled workbooks are saved as .xlsx; macros cannot be kept.';
      return D.open({
        title: 'Download', submitText: 'Download', wide: true,
        build: (body) => {
          const name = el('input', { class: 'input', value: file.baseName, 'aria-label': 'File name' });
          const ext = el('span', { class: 'ext' });
          const formats = [
            ['xlsx', 'Excel workbook (.xlsx)', 'All sheets, formulas and formatting. Recommended.'],
            ['xls', 'Excel 97–2003 (.xls)', 'For very old Excel versions. Values and number formats only.'],
            ['csv', 'CSV (.csv)', 'One sheet as plain text, for other programs.'],
          ];
          const radios = formats.map(([value, label, hint]) => {
            const input = el('input', { type: 'radio', name: 'export-format', value });
            input.checked = value === initial;
            return { input, node: el('label', { class: 'radio-card' }, [input, el('span', {}, [el('strong', { text: label }), el('small', { text: hint })])]) };
          });
          const d = csvDefaults();
          const sheet = D.select(wb.sheets.map((s, i) => [String(i), s.name]), String(d.sheetIndex));
          const delimiter = D.select(DELIMITER_LABELS, d.delimiter);
          const decimal = D.select([['.', 'Point (1234.5)'], [',', 'Comma (1234,5)']], d.decimalComma ? ',' : '.');
          const values = D.select([['display', 'As displayed'], ['raw', 'Raw values']], 'display');
          const bom = D.checkbox('Add a byte-order mark so Excel reads Vietnamese and other accents correctly', true);
          const protect = D.checkbox('Protect against formula injection (prefix text starting with = + - @ with an apostrophe)', true);
          const csvBox = el('fieldset', { class: 'csv-options' }, [
            el('legend', { text: 'CSV options' }),
            el('div', { class: 'field-row' }, [D.field('Sheet', sheet), D.field('Separator', delimiter), D.field('Decimal separator', decimal), D.field('Values', values)]),
            bom.node, protect.node,
          ]);
          const warnBox = el('div', { class: 'export-warnings', 'aria-live': 'polite' });
          const format = () => radios.find((r) => r.input.checked).input.value;
          const csvOptions = () => ({
            sheetIndex: Number(sheet.value), delimiter: delimiter.value, bom: bom.input.checked,
            protectFormulas: protect.input.checked, decimalComma: decimal.value === ',', values: values.value,
          });
          const update = () => {
            const f = format();
            ext.textContent = '.' + f;
            csvBox.hidden = f !== 'csv';
            const warnings = FM.exportWarnings(wb, f, csvOptions(), file);
            warnBox.replaceChildren();
            if (warnings.length) {
              warnBox.append(el('p', { class: 'warn-title', text: 'What this download will not include' }), D.warningList(warnings));
            } else {
              warnBox.append(el('p', { class: 'ok-title', text: 'Everything you can see in the editor is included.' }));
            }
          };
          radios.forEach((r) => r.input.addEventListener('change', update));
          [sheet, delimiter, decimal, values, bom.input, protect.input].forEach((n) => n.addEventListener('change', update));
          update();
          body.append(
            reason ? el('p', { class: 'note', text: reason }) : '',
            D.field('File name', el('div', { class: 'name-row' }, [name, ext])),
            el('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Format' }, radios.map((r) => r.node)),
            csvBox, warnBox,
          );
          return () => {
            const base = name.value.trim().replace(/[\\/:*?"<>|]+/g, '_');
            if (!base) return { error: 'Enter a file name.' };
            const f = format();
            const warnings = FM.exportWarnings(wb, f, csvOptions(), file);
            if (f === 'xls' && warnings.some((w) => /65,536/.test(w))) return { error: warnings.find((w) => /65,536/.test(w)) };
            file.baseName = base;
            return { format: f, filename: base + '.' + f, csv: csvOptions(), lossless: f === 'xlsx' || warnings.length === 0 };
          };
        },
      });
    },

    /* ---------- Notice banner ---------- */

    bindNotice() {
      $('notice-close').addEventListener('click', () => this.hideNotice());
      $('notice-details').addEventListener('click', () => D.alert({ title: 'About this file', message: 'Details of what the editor shows and keeps:', items: this.noticeItems }));
    },

    showNotice(kind, text, items) {
      const notice = $('notice');
      notice.className = 'notice ' + kind;
      $('notice-text').textContent = text;
      this.noticeItems = items || [];
      $('notice-details').hidden = this.noticeItems.length < 2;
      notice.hidden = false;
    },

    hideNotice() { $('notice').hidden = true; },

    /* ---------- Drag and drop ---------- */

    bindDragAndDrop() {
      const zone = $('drop-zone');
      let depth = 0;
      const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
      window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; zone.hidden = false; } });
      window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone.hidden = true; } });
      window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
      window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        zone.hidden = true;
        const files = [...e.dataTransfer.files];
        if (files.length > 1) D.toast('Opening the first file only: ' + files[0].name, 'info');
        if (files[0]) this.openFile(files[0]);
      });
    },

    /* ---------- Shortcuts ---------- */

    bindShortcuts() {
      document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.target.closest && e.target.closest('dialog')) return;
        const key = e.key.toLowerCase();
        const target = e.target;
        const inOtherField = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && target !== this.grid.editor;
        const editing = this.grid.isEditing();
        const textBusy = inOtherField || editing;
        const handle = (fn) => { e.preventDefault(); fn(); };
        if (key === 's') handle(() => this.save());
        else if (key === 'o') handle(() => this.chooseFile());
        else if (key === 'f' && !inOtherField) handle(() => this.toolbar.openFind(false));
        else if (key === 'h' && !inOtherField) handle(() => this.toolbar.openFind(true));
        else if (textBusy) return;
        else if (key === 'z') handle(() => (e.shiftKey ? this.redo() : this.undo()));
        else if (key === 'y') handle(() => this.redo());
        else if (key === 'b') handle(() => this.toolbar.toggleFont('bold'));
        else if (key === 'i') handle(() => this.toolbar.toggleFont('italic'));
        else if (key === 'u') handle(() => this.toolbar.toggleFont('underline'));
      });
    },
  };

  function blankFileInfo() {
    return { name: 'Untitled.xlsx', baseName: 'Untitled', format: null, size: 0, lost: [], notes: [] };
  }

  function shortLabel(text) {
    return text.replace(/\s*\(.*\)$/, '');
  }

  function safeSheetName(name) {
    const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31);
    return cleaned || 'Sheet1';
  }

  SheetApp.app = app;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
  else app.init();
})(typeof window !== 'undefined' ? window : globalThis);
