/*
 * file-manager.js — reading and writing spreadsheet files, entirely in the browser.
 *   .xlsx  read + write with ExcelJS (values, formulas, styles, merges, validation, notes, images)
 *   .xls   read with SheetJS; write with SheetJS (values and number formats only — see warnings)
 *   .csv   read + write with the parser in utils.js
 * Nothing is uploaded anywhere.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;
  const F = SheetApp.formula;
  const { Workbook, Sheet, makeCell } = SheetApp.spreadsheet;

  const LARGE_FILE_BYTES = 30 * 1024 * 1024;
  const MAX_FILE_BYTES = 300 * 1024 * 1024;
  const XLS_MAX_ROWS = 65536;
  const XLS_MAX_COLS = 256;

  const FORMAT_LABELS = { xlsx: 'Excel workbook (.xlsx)', xlsm: 'Excel macro-enabled workbook (.xlsm)', xls: 'Excel 97–2003 workbook (.xls)', csv: 'CSV text (.csv)' };
  const MIME = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv;charset=utf-8',
  };

  class FileError extends Error {}

  /* The two big libraries are loaded on demand (the app starts fetching them right after it is ready), so the editor is usable
     before ~1.9 MB of scripts have arrived. */
  const LIBRARY_FILES = { ExcelJS: 'vendor/exceljs.min.js', XLSX: 'vendor/xlsx.full.min.js' };
  const libraryLoads = {};
  function loadLibrary(name) {
    if (root[name]) return Promise.resolve(root[name]);
    if (!libraryLoads[name]) {
      libraryLoads[name] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LIBRARY_FILES[name];
        s.onload = () => (root[name] ? resolve(root[name]) : reject(new Error(name + ' did not initialise')));
        s.onerror = () => reject(new Error('Could not load ' + LIBRARY_FILES[name]));
        document.head.appendChild(s);
      }).catch((e) => { delete libraryLoads[name]; throw new FileError((name === 'XLSX' ? 'SheetJS' : 'ExcelJS') + ' could not be loaded (' + e.message + '). Reload the page and try again.'); });
    }
    return libraryLoads[name];
  }
  const ensureLibraries = (names) => Promise.all(names.map(loadLibrary));

  function requireLibrary(name) {
    if (!root[name]) {
      throw new FileError((name === 'XLSX' ? 'SheetJS' : 'ExcelJS') + ' is not loaded. Check your connection or install the libraries in the vendor folder (see README).');
    }
    return root[name];
  }

  /* ---------- Unit conversions ---------- */

  const charsToPx = (w) => Math.round(w * 7 + 5);
  const pxToChars = (px) => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
  const ptToPx = (pt) => Math.round((pt * 4) / 3);
  const pxToPt = (px) => Math.round(px * 0.75 * 100) / 100;

  /* ---------- Detection ---------- */

  /**
   * Reads a File and works out what it really is (by content, not just extension).
   * Returns { name, size, format, buffer } or throws FileError.
   */
  async function inspectFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new FileError('This file is ' + U.formatBytes(file.size) + '. Files up to ' + U.formatBytes(MAX_FILE_BYTES) + ' can be opened in the browser.');
    }
    const ext = (file.name.match(/\.([^.]+)$/) || [])[1];
    const extension = ext ? ext.toLowerCase() : '';
    if (!['xlsx', 'xlsm', 'xls', 'csv', 'txt', 'tsv'].includes(extension)) {
      throw new FileError('"' + file.name + '" is not a supported file. Open an .xlsx, .xls or .csv file.');
    }
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) throw new FileError('"' + file.name + '" is empty.');
    const container = U.sniffContainer(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)));
    let format;
    if (container === 'zip') {
      if (['csv', 'txt', 'tsv'].includes(extension)) throw new FileError('"' + file.name + '" is a compressed file, not CSV text. Rename it to .xlsx if it is an Excel workbook.');
      format = extension === 'xlsm' ? 'xlsm' : 'xlsx';
    } else if (container === 'cfb') {
      if (extension !== 'xls') {
        throw new FileError('"' + file.name + '" is password-protected or in the older .xls format with the wrong extension. Remove the password in Excel, or rename the file to .xls, and try again.');
      }
      format = 'xls';
    } else if (container === 'text') {
      if (extension === 'xlsx' || extension === 'xlsm') throw new FileError('"' + file.name + '" is damaged or not a real Excel workbook (it contains plain text).');
      format = extension === 'xls' ? 'xls' : 'csv'; // .xls may hold HTML/XML spreadsheets, which SheetJS reads
    } else {
      throw new FileError('"' + file.name + '" is damaged or uses a format this editor cannot read.');
    }
    return { name: file.name, size: file.size, format, buffer, isLarge: file.size > LARGE_FILE_BYTES };
  }

  /* ---------- Feature scan (things the editor cannot keep) ---------- */

  const PACKAGE_FEATURES = [
    [/^xl\/charts\/chart[^/]*\.xml$/i, 'chart', 'charts'],
    [/^xl\/pivotTables\/[^/]*\.xml$/i, 'pivot table', 'pivot tables'],
    [/^xl\/vbaProject\.bin$/i, 'macro project', 'macros (VBA)'],
    [/^xl\/externalLinks\/[^/]*\.xml$/i, 'external link', 'links to other workbooks'],
    [/^xl\/tables\/[^/]*\.xml$/i, 'Excel table', 'Excel tables (they become plain ranges; data is kept)'],
    [/^xl\/slicers\/[^/]*\.xml$/i, 'slicer', 'slicers'],
    [/^xl\/threadedComments\/[^/]*\.xml$/i, 'threaded comment', 'threaded comments (older-style notes are kept)'],
    [/^xl\/ctrlProps\/[^/]*\.xml$/i, 'form control', 'form controls'],
  ];

  function scanPackage(buffer) {
    const names = U.listZipEntries(buffer) || [];
    const lost = [];
    for (const [pattern, , label] of PACKAGE_FEATURES) {
      const count = names.filter((n) => pattern.test(n)).length;
      if (count) lost.push(label + (count > 1 && !label.includes('(') ? ' (' + count + ')' : ''));
    }
    // Charts are anchored through drawing parts too, so only count drawings beyond the charts.
    const drawings = names.filter((n) => /^xl\/drawings\/drawing[^/]*\.xml$/i.test(n)).length;
    const charts = names.filter((n) => /^xl\/charts\/chart[^/]*\.xml$/i.test(n)).length;
    return { lost, hasDrawings: drawings > 0 && charts === 0 };
  }

  /* ---------- XLSX import (ExcelJS) ---------- */

  function cloneStyle(style, memo) {
    if (!style) return null;
    if (memo.has(style)) return memo.get(style);
    const copy = JSON.parse(JSON.stringify(style));
    for (const k of Object.keys(copy)) {
      const v = copy[k];
      if (v == null || (typeof v === 'object' && Object.keys(v).length === 0)) delete copy[k];
    }
    if (copy.numFmt === 'General') delete copy.numFmt;
    const result = Object.keys(copy).length ? copy : null;
    memo.set(style, result);
    return result;
  }

  function normalizeImported(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return U.dateToSerial(value);
    if (typeof value === 'object') {
      if (value.error) return { error: value.error };
      if (value.richText) return value.richText.map((r) => r.text).join('');
      return null;
    }
    return value;
  }

  function ensureDateFormat(style) {
    if (style && U.isDateFormat(style.numFmt)) return style;
    return { ...(style || {}), numFmt: 'yyyy-mm-dd' };
  }

  function convertExcelJsCell(cell, styleMemo, stats) {
    let style = cloneStyle(cell.style, styleMemo);
    const v = cell.value;
    let value = null;
    let formula = null;
    let hyperlink = null;
    if (v instanceof Date) {
      value = U.dateToSerial(v);
      style = ensureDateFormat(style);
    } else if (v !== null && typeof v === 'object') {
      if (v.formula !== undefined || v.sharedFormula !== undefined) {
        formula = cell.formula || v.formula;
        if (v.shareType === 'array') stats.arrayFormulas++;
        if (v.result instanceof Date) style = ensureDateFormat(style);
        value = normalizeImported(v.result);
        F.findUnsupportedFunctions(formula).forEach((name) => stats.unsupportedFunctions.add(name));
      } else if (v.hyperlink !== undefined) {
        hyperlink = { target: v.hyperlink, tooltip: v.tooltip };
        value = normalizeImported(typeof v.text === 'object' ? v.text : v.text);
      } else if (v.richText) {
        value = normalizeImported(v);
        stats.richText++;
      } else if (v.error) {
        value = { error: v.error };
      }
    } else if (v !== undefined) {
      value = v;
    }
    const note = cell.note || null;
    return makeCell({ value, formula, style, note, hyperlink });
  }

  /** Groups per-cell validation entries back into rectangles. */
  function groupValidations(model) {
    const byRule = new Map();
    for (const [address, rule] of Object.entries(model || {})) {
      const range = U.parseRange(address.split(' ')[0]);
      if (!range) continue;
      const key = JSON.stringify(rule);
      if (!byRule.has(key)) byRule.set(key, { rule, cells: [] });
      byRule.get(key).cells.push(range);
    }
    const out = [];
    for (const { rule, cells } of byRule.values()) {
      const columns = new Map();
      for (const r of cells) {
        for (let c = r.c1; c <= r.c2; c++) {
          if (!columns.has(c)) columns.set(c, []);
          for (let row = r.r1; row <= r.r2; row++) columns.get(c).push(row);
        }
      }
      const runs = [];
      for (const [c, rows] of [...columns].sort((a, b) => a[0] - b[0])) {
        rows.sort((a, b) => a - b);
        let start = rows[0];
        for (let i = 1; i <= rows.length; i++) {
          if (i === rows.length || rows[i] !== rows[i - 1] + 1) {
            const prev = runs.find((run) => run.c2 === c - 1 && run.r1 === start && run.r2 === rows[i - 1]);
            if (prev) prev.c2 = c;
            else runs.push({ r1: start, r2: rows[i - 1], c1: c, c2: c });
            start = rows[i];
          }
        }
      }
      out.push({ rule, ranges: runs });
    }
    return out;
  }

  async function readXlsx(info) {
    const ExcelJS = requireLibrary('ExcelJS');
    const ewb = new ExcelJS.Workbook();
    try {
      await ewb.xlsx.load(info.buffer);
    } catch (e) {
      throw new FileError('"' + info.name + '" could not be read. It may be damaged or password-protected. (' + e.message + ')');
    }
    const wb = new Workbook();
    const pkg = scanPackage(info.buffer);
    const stats = { arrayFormulas: 0, richText: 0, unsupportedFunctions: new Set(), conditionalFormats: 0, images: 0, validationsNotEnforced: 0, hiddenCols: 0 };
    const styleMemo = new Map();
    for (const ws of ewb.worksheets) {
      const sheet = new Sheet(ws.name);
      sheet.state = ws.state || 'visible';
      (ws.columns || []).forEach((col, i) => {
        if (col.width) sheet.colWidths.set(i, charsToPx(col.width));
        if (col.hidden) sheet.hiddenCols.add(i);
      });
      ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const r = rowNumber - 1;
        if (row.height) sheet.rowHeights.set(r, ptToPx(row.height));
        if (row.hidden) sheet.hiddenRows.add(r);
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (cell.type === ExcelJS.ValueType.Merge) return;
          const converted = convertExcelJsCell(cell, styleMemo, stats);
          if (converted) sheet.putCell(r, colNumber - 1, converted);
        });
      });
      sheet.merges = ((ws.model && ws.model.merges) || []).map((m) => U.parseRange(m)).filter(Boolean);
      const view = (ws.views || [])[0];
      if (view && view.state === 'frozen') {
        sheet.frozenRows = view.ySplit || 0;
        sheet.frozenCols = view.xSplit || 0;
      }
      sheet.validations = groupValidations(ws.dataValidations && ws.dataValidations.model);
      stats.validationsNotEnforced += sheet.validations.filter((v) => !SheetApp.spreadsheet.SUPPORTED_RULES.includes(v.rule.type)).length;
      const extras = {};
      if (ws.conditionalFormattings && ws.conditionalFormattings.length) {
        extras.conditionalFormattings = ws.conditionalFormattings;
        stats.conditionalFormats += ws.conditionalFormattings.length;
      }
      const images = ws.getImages ? ws.getImages() : [];
      if (images.length) {
        extras.images = images.map((img) => {
          const media = ewb.getImage(Number(img.imageId));
          const tl = img.range.tl;
          const br = img.range.br;
          return {
            buffer: media.buffer, extension: media.extension,
            range: br ? { tl: { col: tl.col, row: tl.row }, br: { col: br.col, row: br.row }, editAs: img.range.editAs }
              : { tl: { col: tl.col, row: tl.row }, ext: img.range.ext, editAs: img.range.editAs },
          };
        }).filter((img) => img.buffer);
        stats.images += extras.images.length;
      }
      if (ws.autoFilter) extras.autoFilter = ws.autoFilter;
      if (ws.pageSetup) extras.pageSetup = ws.pageSetup;
      if (ws.headerFooter) extras.headerFooter = ws.headerFooter;
      if (ws.properties && ws.properties.tabColor) extras.tabColor = ws.properties.tabColor;
      sheet.extras = extras;
      const b = sheet.usedBounds();
      sheet.ensureSize(b.maxRow, b.maxCol);
      wb.sheets.push(sheet);
    }
    if (wb.sheets.length === 0) throw new FileError('"' + info.name + '" has no worksheets.');
    wb.extras.definedNames = ewb.definedNames && ewb.definedNames.model;
    wb.activeIndex = Math.max(0, wb.sheets.findIndex((s) => s.state === 'visible'));

    const lost = pkg.lost.slice();
    if (info.format === 'xlsm' && !lost.some((l) => l.startsWith('macros'))) lost.push('macros (VBA)');
    if (pkg.hasDrawings && stats.images === 0) lost.push('shapes, text boxes and drawings');
    if (stats.arrayFormulas) lost.push('array formulas (' + stats.arrayFormulas + ' cells are saved as regular formulas)');
    if (stats.richText) lost.push('mixed formatting inside cells (' + stats.richText + ' cells keep their text but lose partial formatting)');

    const notes = [];
    if (stats.images) notes.push(stats.images + ' image(s) are kept in the file but not shown in the editor. Inserting or deleting rows does not move them.');
    if (pkg.hasDrawings && stats.images) notes.push('Shapes and text boxes, if any, are removed when saving.');
    if (stats.conditionalFormats) notes.push('Some conditional formatting (data bars, icon sets) is kept in the file but not drawn here, and conditional formatting is not adjusted when rows or columns move.');
    if (stats.unsupportedFunctions.size) {
      notes.push('Some formulas use functions this editor cannot calculate (' + [...stats.unsupportedFunctions].slice(0, 6).join(', ') + '). They keep the results saved in the file and are recalculated when opened in Excel.');
    }
    if (stats.validationsNotEnforced) notes.push('Some data validation rules (dates, times or custom formulas) are kept but not checked while editing.');
    return { workbook: wb, lost, notes };
  }

  /* ---------- XLS import (SheetJS) ---------- */

  const XLS_ERROR_CODES = { 0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#NAME?', 36: '#NUM!', 42: '#N/A' };

  function readXls(info) {
    const XLSX = requireLibrary('XLSX');
    let xwb;
    try {
      xwb = XLSX.read(new Uint8Array(info.buffer), { type: 'array', cellFormula: true, cellNF: true, cellStyles: true, cellDates: false });
    } catch (e) {
      const protectedFile = /password|encrypt/i.test(e.message);
      throw new FileError(protectedFile
        ? '"' + info.name + '" is password-protected. Remove the password in Excel and try again.'
        : '"' + info.name + '" could not be read. It may be damaged. (' + e.message + ')');
    }
    const wb = new Workbook();
    const stats = { unsupportedFunctions: new Set(), formulas: 0 };
    const sheetMeta = (xwb.Workbook && xwb.Workbook.Sheets) || [];
    xwb.SheetNames.forEach((name, index) => {
      const ws = xwb.Sheets[name];
      const sheet = new Sheet(name);
      if (sheetMeta[index] && sheetMeta[index].Hidden) sheet.state = 'hidden';
      for (const address of Object.keys(ws)) {
        if (address[0] === '!') continue;
        const pos = U.parseAddress(address);
        if (!pos) continue;
        const c = ws[address];
        let value = null;
        if (c.t === 'n' || c.t === 's' || c.t === 'b') value = c.v;
        else if (c.t === 'e') value = { error: XLS_ERROR_CODES[c.v] || c.w || '#N/A' };
        else if (c.t === 'd') value = U.dateToSerial(c.v);
        const formula = c.f || null;
        if (formula) {
          stats.formulas++;
          F.findUnsupportedFunctions(formula).forEach((fn) => stats.unsupportedFunctions.add(fn));
        }
        const style = c.z && c.z !== 'General' ? { numFmt: c.z } : null;
        const cell = makeCell({ value, formula, style });
        if (cell) sheet.putCell(pos.row, pos.col, cell);
      }
      sheet.merges = (ws['!merges'] || []).map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
      (ws['!cols'] || []).forEach((col, i) => {
        if (!col) return;
        const px = col.wpx || (col.wch ? charsToPx(col.wch) : 0);
        if (px) sheet.colWidths.set(i, px);
        if (col.hidden) sheet.hiddenCols.add(i);
      });
      (ws['!rows'] || []).forEach((row, i) => {
        if (!row) return;
        const px = row.hpx || (row.hpt ? ptToPx(row.hpt) : 0);
        if (px) sheet.rowHeights.set(i, px);
        if (row.hidden) sheet.hiddenRows.add(i);
      });
      const b = sheet.usedBounds();
      sheet.ensureSize(b.maxRow, b.maxCol);
      wb.sheets.push(sheet);
    });
    if (wb.sheets.length === 0) throw new FileError('"' + info.name + '" has no worksheets.');
    wb.activeIndex = Math.max(0, wb.sheets.findIndex((s) => s.state === 'visible'));
    const lost = ['cell formatting such as fonts, colours and borders (the legacy .xls reader keeps values, formulas, number formats, merges and sizes only)'];
    const notes = [];
    if (stats.unsupportedFunctions.size) notes.push('Some formulas use functions this editor cannot calculate (' + [...stats.unsupportedFunctions].slice(0, 6).join(', ') + '); they show the results saved in the file.');
    return { workbook: wb, lost, notes };
  }

  /* ---------- CSV import ---------- */

  /** Prepares CSV text for the import dialog. */
  function prepareCsv(info, encoding) {
    const decoded = U.decodeText(info.buffer, encoding);
    const detection = U.detectDelimiter(decoded.text);
    return { text: decoded.text, encoding: decoded.encoding, delimiter: detection.delimiter, confident: detection.confident };
  }

  function parseCsvNumber(text, decimalComma) {
    if (!decimalComma) return U.parseNumber(text);
    const t = text.trim();
    if (!/^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(t)) return null;
    return U.parseNumber(t.replace(/\./g, '').replace(',', '.'));
  }

  /**
   * Builds a one-sheet workbook from CSV text.
   * options: { delimiter, decimalComma, convertValues, interpretFormulas, sheetName }
   */
  function csvToWorkbook(text, options) {
    const rows = U.parseCsv(text, options.delimiter);
    const wb = new Workbook();
    const sheet = new Sheet(options.sheetName || 'Sheet1');
    let formulaLike = 0;
    rows.forEach((fields, r) => {
      if (r >= U.MAX_ROWS) return;
      fields.forEach((field, c) => {
        if (field === '' || c >= U.MAX_COLS) return;
        let value = field;
        let formula = null;
        let style = null;
        if (field[0] === '=' && field.length > 1) {
          if (options.interpretFormulas && !F.checkSyntax(field.slice(1))) {
            formula = field.slice(1);
            value = null;
          } else {
            formulaLike++;
          }
        } else if (options.convertValues) {
          const n = parseCsvNumber(field, options.decimalComma);
          if (n !== null) {
            value = n;
          } else {
            const parsed = U.parseUserInput(field);
            // Only convert dates when they display exactly as written, so re-saving is lossless.
            if (parsed.numFmt && typeof parsed.value === 'number' && U.formatNumber(parsed.value, parsed.numFmt) === field.trim()) {
              value = parsed.value;
              style = { numFmt: parsed.numFmt };
            }
          }
        }
        sheet.putCell(r, c, makeCell({ value, formula, style }));
      });
    });
    const b = sheet.usedBounds();
    sheet.ensureSize(b.maxRow, b.maxCol);
    wb.sheets.push(sheet);
    const notes = [];
    if (formulaLike) notes.push(formulaLike + ' value(s) starting with "=" were imported as text, not formulas.');
    if (rows.length > U.MAX_ROWS) notes.push('Only the first ' + U.MAX_ROWS.toLocaleString() + ' rows were imported (the Excel row limit).');
    return { workbook: wb, lost: [], notes, rowCount: rows.length };
  }

  /* ---------- Export ---------- */

  function exportValue(wb, sheetIndex, row, col, cell) {
    if (!cell.formula) return { value: cell.value };
    const result = wb.compute(sheetIndex, row, col, cell);
    if (result.unsupported && !result.usesCachedValue) return { value: null, noResult: true };
    return { value: result.value };
  }

  function sheetNamesExist(wb, refText) {
    const names = [];
    String(refText).replace(/(?:'((?:[^']|'')+)'|([^'!,]+))!/g, (m, quoted, plain) => names.push(quoted ? quoted.replace(/''/g, "'") : plain));
    return names.every((n) => wb.resolveSheet(n) >= 0);
  }

  async function writeXlsx(wb) {
    await ensureLibraries(['ExcelJS']);
    const ExcelJS = requireLibrary('ExcelJS');
    const ewb = new ExcelJS.Workbook();
    ewb.creator = 'Sheet Editor';
    ewb.calcProperties = { fullCalcOnLoad: true };
    for (let s = 0; s < wb.sheets.length; s++) {
      const sheet = wb.sheets[s];
      const extras = sheet.extras || {};
      const views = sheet.frozenRows || sheet.frozenCols
        ? [{ state: 'frozen', xSplit: sheet.frozenCols, ySplit: sheet.frozenRows }] : [];
      const ws = ewb.addWorksheet(sheet.name, { state: sheet.state, views, properties: extras.tabColor ? { tabColor: extras.tabColor } : undefined });
      for (const [c, px] of sheet.colWidths) ws.getColumn(c + 1).width = pxToChars(px);
      for (const c of sheet.hiddenCols) ws.getColumn(c + 1).hidden = true;
      for (const [r, px] of sheet.rowHeights) ws.getRow(r + 1).height = pxToPt(px);
      const styleMemo = new Map();
      for (const [key, cell] of sheet.cells) {
        const { row, col } = U.keyToCell(key);
        const target = ws.getCell(row + 1, col + 1);
        const out = exportValue(wb, s, row, col, cell);
        let value = out.value;
        if (value && typeof value === 'object' && value.error) {
          value = F.ERRORS.includes(value.error) && value.error !== '#CIRC!' ? { error: value.error } : null;
        }
        if (cell.formula) {
          target.value = out.noResult || value === null ? { formula: cell.formula } : { formula: cell.formula, result: value };
        } else if (cell.hyperlink && value !== null) {
          target.value = { text: F.toText(value), hyperlink: cell.hyperlink.target, tooltip: cell.hyperlink.tooltip };
        } else {
          target.value = value;
        }
        if (cell.style) {
          if (!styleMemo.has(cell.style)) styleMemo.set(cell.style, JSON.parse(JSON.stringify(cell.style)));
          target.style = styleMemo.get(cell.style);
        }
        if (cell.note) target.note = cell.note;
      }
      for (const r of new Set([...sheet.hiddenRows, ...sheet.filterHiddenRows])) ws.getRow(r + 1).hidden = true;
      for (const m of sheet.merges) ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1);
      for (const v of sheet.validations) {
        for (const range of v.ranges) ws.dataValidations.add(U.rangeAddress(range), v.rule);
      }
      (extras.conditionalFormattings || []).forEach((cf) => ws.addConditionalFormatting(cf));
      (extras.images || []).forEach((img) => {
        const id = ewb.addImage({ buffer: img.buffer, extension: img.extension });
        ws.addImage(id, img.range);
      });
      if (sheet.filter) {
        const f = sheet.filter.range;
        ws.autoFilter = U.rangeAddress({ r1: f.r1, c1: f.c1, r2: f.r1, c2: f.c2 });
      } else if (extras.autoFilter) {
        ws.autoFilter = extras.autoFilter;
      }
      if (extras.pageSetup) Object.assign(ws.pageSetup, extras.pageSetup);
      if (extras.headerFooter) Object.assign(ws.headerFooter, extras.headerFooter);
    }
    const names = (wb.extras.definedNames || []).filter((n) => n.ranges && n.ranges.every((r) => sheetNamesExist(wb, r)));
    if (names.length) ewb.definedNames.model = names;
    const buffer = await ewb.xlsx.writeBuffer();
    return new Blob([buffer], { type: MIME.xlsx });
  }

  function xlsLimitProblem(wb) {
    for (const sheet of wb.sheets) {
      const b = sheet.usedBounds();
      if (b.maxRow >= XLS_MAX_ROWS || b.maxCol >= XLS_MAX_COLS) {
        return 'Sheet "' + sheet.name + '" is larger than the .xls limit of 65,536 rows and 256 columns. Save as .xlsx instead.';
      }
    }
    return null;
  }

  function writeXls(wb) {
    const XLSX = requireLibrary('XLSX');
    const problem = xlsLimitProblem(wb);
    if (problem) throw new FileError(problem);
    const xwb = XLSX.utils.book_new();
    const errorCodes = Object.fromEntries(Object.entries(XLS_ERROR_CODES).map(([k, v]) => [v, Number(k)]));
    wb.sheets.forEach((sheet, s) => {
      const ws = {};
      for (const [key, cell] of sheet.cells) {
        const { row, col } = U.keyToCell(key);
        const { value } = exportValue(wb, s, row, col, cell);
        const numFmt = cell.style && cell.style.numFmt;
        let out = null;
        if (typeof value === 'number') out = { t: 'n', v: value };
        else if (typeof value === 'boolean') out = { t: 'b', v: value };
        else if (typeof value === 'string') out = { t: 's', v: value };
        else if (value && value.error) out = errorCodes[value.error] !== undefined ? { t: 'e', v: errorCodes[value.error] } : { t: 's', v: value.error };
        if (!out) continue;
        if (numFmt) out.z = numFmt;
        ws[U.cellAddress(row, col)] = out;
      }
      const b = sheet.usedBounds();
      ws['!ref'] = U.rangeAddress({ r1: 0, c1: 0, r2: Math.max(0, b.maxRow), c2: Math.max(0, b.maxCol) });
      ws['!merges'] = sheet.merges.map((m) => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }));
      const cols = [];
      for (const [c, px] of sheet.colWidths) cols[c] = { wpx: px };
      for (const c of sheet.hiddenCols) cols[c] = { ...(cols[c] || {}), hidden: true };
      if (cols.length) ws['!cols'] = cols;
      const rows = [];
      for (const [r, px] of sheet.rowHeights) rows[r] = { hpx: px };
      for (const r of new Set([...sheet.hiddenRows, ...sheet.filterHiddenRows])) rows[r] = { ...(rows[r] || {}), hidden: true };
      if (rows.length) ws['!rows'] = rows;
      XLSX.utils.book_append_sheet(xwb, ws, sheet.name);
    });
    xwb.Workbook = { Sheets: wb.sheets.map((s) => ({ Hidden: s.state === 'visible' ? 0 : 1 })) };
    const data = XLSX.write(xwb, { bookType: 'biff8', type: 'array' });
    return new Blob([data], { type: MIME.xls });
  }

  /**
   * options: { sheetIndex, delimiter, bom, protectFormulas, decimalComma, values: 'display' | 'raw' }
   */
  function writeCsv(wb, options) {
    const s = options.sheetIndex;
    const sheet = wb.sheets[s];
    const b = sheet.usedBounds();
    const rows = [];
    for (let r = 0; r <= b.maxRow; r++) {
      const row = [];
      for (let c = 0; c <= b.maxCol; c++) {
        const value = wb.getValue(s, r, c);
        let text;
        if (options.values === 'raw') {
          text = typeof value === 'number' ? String(value) : value === null ? '' : value && value.error ? value.error : F.toText(value);
        } else {
          text = wb.getDisplay(s, r, c).text;
        }
        if (typeof value === 'number' && options.decimalComma) text = text.replace(/[.,]/g, (ch) => (ch === '.' ? ',' : '.'));
        row.push({ text, isString: typeof value === 'string' });
      }
      rows.push(row);
    }
    const csv = U.serializeCsv(rows, options);
    return new Blob([(options.bom ? '\uFEFF' : '') + csv + (csv ? '\r\n' : '')], { type: MIME.csv });
  }

  /* ---------- What a given export will drop ---------- */

  /** True when cells carry formatting; number formats alone can be ignored (CSV "as displayed" keeps them). */
  function sheetHasStyles(sheet, ignoreNumberFormats) {
    for (const cell of sheet.cells.values()) {
      if (!cell.style) continue;
      if (!ignoreNumberFormats || Object.keys(cell.style).some((k) => k !== 'numFmt')) return true;
    }
    return false;
  }

  function sheetHasFormulas(sheet) {
    for (const cell of sheet.cells.values()) if (cell.formula) return true;
    return false;
  }

  /** Human-readable list of what will be lost if the workbook is saved in this format. */
  function exportWarnings(wb, format, options, fileInfo) {
    const warnings = [];
    const lostFromFile = (fileInfo && fileInfo.lost) || [];
    if (format === 'xlsx') {
      lostFromFile.forEach((l) => warnings.push('Not kept: ' + l + '.'));
      if (fileInfo && fileInfo.format === 'xls') warnings.push('The file was opened from .xls, so its original fonts, colours and borders were not loaded and will not appear in the .xlsx.');
      return warnings;
    }
    if (format === 'xls') {
      const problem = xlsLimitProblem(wb);
      if (problem) warnings.push(problem);
      if (wb.sheets.some(sheetHasFormulas)) warnings.push('Formulas are replaced by their current results (the .xls writer cannot save formulas).');
      if (wb.sheets.some(sheetHasStyles)) warnings.push('Fonts, colours, borders and alignment are removed; number formats are kept.');
      if (wb.sheets.some((s) => s.validations.length)) warnings.push('Data validation rules are removed.');
      if (wb.sheets.some((s) => s.frozenRows || s.frozenCols)) warnings.push('Frozen rows and columns are removed.');
      if (wb.sheets.some((s) => s.extras.images || s.extras.conditionalFormattings)) warnings.push('Images and conditional formatting are removed.');
      if (wb.sheets.some((s) => [...s.cells.values()].some((c) => c.note || c.hyperlink))) warnings.push('Notes and hyperlinks are removed.');
      lostFromFile.forEach((l) => warnings.push('Not kept: ' + l + '.'));
      return warnings;
    }
    const sheet = wb.sheets[options.sheetIndex];
    const others = wb.sheets.length - 1;
    if (others > 0) warnings.push('Only "' + sheet.name + '" is saved. The other ' + others + ' sheet' + (others > 1 ? 's are' : ' is') + ' not included.');
    if (sheetHasFormulas(sheet)) warnings.push('Formulas are saved as their calculated results.');
    if (sheetHasStyles(sheet, options.values !== 'raw')) warnings.push(options.values === 'raw' ? 'All formatting is removed, including number and date formats.' : 'Fonts, colours, borders and alignment are removed; values are saved as displayed.');
    if (sheet.merges.length) warnings.push('Merged cells are split; only the top-left cell keeps its value.');
    if (sheet.validations.length || sheet.frozenRows || sheet.frozenCols) warnings.push('Data validation and frozen panes are removed.');
    if (sheet.hiddenRows.size || sheet.filterHiddenRows.size) warnings.push('Hidden and filtered-out rows are included in the CSV.');
    if (fileInfo && fileInfo.format !== 'csv') lostFromFile.forEach((l) => warnings.push('Not kept: ' + l + '.'));
    return warnings;
  }

  async function loadWorkbook(info) {
    if (info.format === 'xlsx' || info.format === 'xlsm' || info.format === 'xls') await ensureLibraries(['XLSX', 'ExcelJS']);
    if (info.format === 'xlsx' || info.format === 'xlsm') return readXlsx(info);
    if (info.format === 'xls') return readXls(info);
    throw new FileError('Use the CSV import options to open "' + info.name + '".');
  }

  SheetApp.fileManager = {
    FileError, FORMAT_LABELS, inspectFile, loadWorkbook, prepareCsv, csvToWorkbook,
    writeXlsx, writeXls, writeCsv, exportWarnings, ensureLibraries,
  };
})(typeof window !== 'undefined' ? window : globalThis);
