/*
 * utils.js — dependency-free helpers shared by every module.
 * Cell addresses, CSV parsing/serialisation, text decoding, file sniffing,
 * value parsing/formatting and small DOM helpers.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});

  const MAX_ROWS = 1048576;
  const MAX_COLS = 16384;

  /* ---------- Cell addresses ---------- */

  function colToLetters(col) {
    let n = col + 1;
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function lettersToCol(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function cellAddress(row, col) {
    return colToLetters(col) + (row + 1);
  }

  function parseAddress(text) {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(text).trim());
    if (!m) return null;
    const row = Number(m[2]) - 1;
    const col = lettersToCol(m[1]);
    if (row < 0 || row >= MAX_ROWS || col >= MAX_COLS) return null;
    return { row, col };
  }

  function normalizeRange(r1, c1, r2, c2) {
    return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  }

  /** Parses "A1" or "A1:C5" into a normalised range, or null. */
  function parseRange(text) {
    const parts = String(text).trim().split(':');
    if (parts.length > 2) return null;
    const a = parseAddress(parts[0]);
    const b = parts.length === 2 ? parseAddress(parts[1]) : a;
    if (!a || !b) return null;
    return normalizeRange(a.row, a.col, b.row, b.col);
  }

  function rangeAddress(range) {
    const a = cellAddress(range.r1, range.c1);
    const b = cellAddress(range.r2, range.c2);
    return a === b ? a : a + ':' + b;
  }

  function rangeContains(range, row, col) {
    return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
  }

  function rangesIntersect(a, b) {
    return a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1;
  }

  /** Numeric map key: fast and unique for every valid Excel cell. */
  function cellKey(row, col) {
    return row * MAX_COLS + col;
  }

  function keyToCell(key) {
    return { row: Math.floor(key / MAX_COLS), col: key % MAX_COLS };
  }

  /* ---------- CSV ---------- */

  /** RFC 4180 parser. Handles quoted delimiters, escaped quotes and newlines inside quotes. */
  function parseCsv(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
      if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  const CSV_DELIMITERS = [',', ';', '\t', '|'];

  /** Picks the delimiter whose field count is most consistent across the first lines. */
  function detectDelimiter(text) {
    const sample = text.slice(0, 64 * 1024);
    let best = { delimiter: ',', score: -1, confident: false };
    for (const d of CSV_DELIMITERS) {
      const rows = parseCsv(sample, d).slice(0, 30).filter((r) => r.length > 1 || r[0] !== '');
      if (rows.length === 0) continue;
      const counts = rows.map((r) => r.length);
      const first = counts[0];
      if (first < 2) continue;
      const consistent = counts.filter((c) => c === first).length / counts.length;
      const score = consistent * 100 + Math.min(first, 50);
      if (score > best.score) best = { delimiter: d, score, confident: consistent >= 0.9 };
    }
    return { delimiter: best.delimiter, confident: best.confident };
  }

  const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

  /**
   * Serialises rows of { text, isString } to CSV.
   * protectFormulas prefixes text that a spreadsheet would execute (CSV injection).
   */
  function serializeCsv(rows, options) {
    const delimiter = options.delimiter || ',';
    const needsQuote = new RegExp('[' + (delimiter === '\t' ? '\\t' : '\\' + delimiter) + '"\\r\\n]');
    return rows
      .map((row) => row.map((cell) => {
        let text = cell.text == null ? '' : String(cell.text);
        if (options.protectFormulas && cell.isString && FORMULA_TRIGGER.test(text)) text = "'" + text;
        return needsQuote.test(text) || /^\s|\s$/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      }).join(delimiter))
      .join('\r\n');
  }

  /* ---------- Text decoding and file sniffing ---------- */

  /** Decodes bytes, honouring a BOM; falls back to Windows-1258 (Vietnamese) when not valid UTF-8. */
  function decodeText(bytes, encoding) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (encoding && encoding !== 'auto') {
      return { text: stripBom(new TextDecoder(encoding).decode(view)), encoding };
    }
    if (view[0] === 0xff && view[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(view.subarray(2)), encoding: 'utf-16le' };
    if (view[0] === 0xfe && view[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(view.subarray(2)), encoding: 'utf-16be' };
    try {
      return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(view)), encoding: 'utf-8' };
    } catch (err) {
      return { text: new TextDecoder('windows-1258').decode(view), encoding: 'windows-1258' };
    }
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  /** Identifies the container from magic bytes: 'zip' (xlsx), 'cfb' (xls), 'text' or 'binary'. */
  function sniffContainer(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
    const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (b.length >= 8 && cfb.every((v, i) => b[i] === v)) return 'cfb';
    const sample = b.subarray(0, 4096);
    const isUtf16 = (sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff);
    if (!isUtf16 && sample.includes(0)) return 'binary';
    return 'text';
  }

  /** Lists the entry names of a zip archive from its central directory (no decompression). */
  function listZipEntries(buffer) {
    const view = new DataView(buffer);
    const len = buffer.byteLength;
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const names = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > len || view.getUint32(offset, true) !== 0x02014b50) return null;
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      names.push(decoder.decode(new Uint8Array(buffer, offset + 46, nameLen)));
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ---------- Dates ---------- */

  const MS_PER_DAY = 86400000;
  const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01

  function dateToSerial(date) {
    return date.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET;
  }

  function serialToDate(serial) {
    return new Date(Math.round((serial - EXCEL_EPOCH_OFFSET) * MS_PER_DAY));
  }

  function isDateFormat(fmt) {
    if (!fmt || fmt === 'General' || fmt === '@') return false;
    const stripped = fmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[dmyhs]/i.test(stripped);
  }

  /* ---------- Value parsing and display ---------- */

  const NUMBER_PATTERN = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][+-]?\d+)?$/;

  /** Converts plain text to a number, or null. Leading-zero codes ("007") stay text. */
  function parseNumber(text) {
    const t = text.trim();
    if (!t || !/\d/.test(t) || !NUMBER_PATTERN.test(t)) return null;
    if (/^[+-]?0\d/.test(t)) return null;
    if ((t.replace(/e.*$/i, '').match(/\d/g) || []).length > 15) return null; // beyond double precision: keep as text
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Interprets what a user typed into a cell.
   * Returns { value, formula, numFmt } — numFmt is only set when the input implies one.
   */
  function parseUserInput(text) {
    if (text == null || text === '') return { value: null, formula: null };
    if (text.length > 1 && text[0] === '=') return { value: null, formula: text.slice(1) };
    if (text[0] === "'") return { value: text.slice(1), formula: null, forceText: true };
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') return { value: upper === 'TRUE', formula: null };
    const pct = /^(.+)%$/.exec(trimmed);
    if (pct) {
      const n = parseNumber(pct[1]);
      if (n !== null) return { value: n / 100, formula: null, numFmt: '0%' };
    }
    const n = parseNumber(trimmed);
    if (n !== null) return { value: n, formula: null };
    const date = parseDateText(trimmed);
    if (date) return { value: date.serial, formula: null, numFmt: date.numFmt };
    return { value: text, formula: null };
  }

  /** Accepts ISO dates (2024-05-31, optional time) and day-first dates (31/05/2024). */
  function parseDateText(text) {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    let y; let mo; let d; let hasTime = false; let hasSeconds = false; let h = 0; let mi = 0; let s = 0;
    if (m) {
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (m[4] !== undefined) { hasTime = true; h = Number(m[4]); mi = Number(m[5]); s = Number(m[6] || 0); hasSeconds = m[6] !== undefined; }
    } else {
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      if (!m) return null;
      [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    if (date.getUTCDate() !== d) return null;
    return { serial: dateToSerial(date), numFmt: hasTime ? (hasSeconds ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd hh:mm') : (m[0].includes('/') ? 'dd/mm/yyyy' : 'yyyy-mm-dd') };
  }

  /** Excel "General" rendering: up to 11 significant digits. */
  function formatGeneralNumber(n) {
    if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) return n.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E');
    return String(parseFloat(n.toPrecision(11)));
  }

  function formatNumber(value, numFmt) {
    if (!numFmt || numFmt === 'General') return formatGeneralNumber(value);
    const ssf = root.XLSX && root.XLSX.SSF;
    if (ssf) {
      try { return ssf.format(numFmt, value); } catch (err) { /* fall through to General */ }
    }
    return formatGeneralNumber(value);
  }

  /** The text a user types to reproduce a value — shown in the formula bar and editor. */
  function valueToInputText(value, numFmt) {
    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'object' && value.error) return value.error;
    if (typeof value === 'number') {
      if (isDateFormat(numFmt)) {
        const d = serialToDate(value);
        const iso = d.toISOString();
        const hasTime = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
        return hasTime ? iso.slice(0, 10) + ' ' + iso.slice(11, 19) : iso.slice(0, 10);
      }
      return String(value);
    }
    const s = String(value);
    // Text that would otherwise be re-read as a number/formula keeps its apostrophe.
    const reparsed = parseUserInput(s);
    return reparsed.formula !== null || typeof reparsed.value !== 'string' ? "'" + s : s;
  }

  /* ---------- Colours ---------- */

  function argbToCss(color) {
    if (!color || !color.argb || color.argb.length < 6) return null;
    return '#' + color.argb.slice(-6);
  }

  function cssToArgb(hex) {
    return { argb: 'FF' + hex.replace('#', '').toUpperCase() };
  }

  /* ---------- DOM ---------- */

  /** Creates an element. Text is always assigned via textContent, never parsed as HTML. */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function nextFrame() {
    return new Promise((resolve) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => setTimeout(resolve, 0)) : setTimeout(resolve, 0)));
  }

  SheetApp.utils = {
    MAX_ROWS, MAX_COLS,
    colToLetters, lettersToCol, cellAddress, parseAddress, parseRange, rangeAddress, normalizeRange,
    rangeContains, rangesIntersect, cellKey, keyToCell,
    parseCsv, detectDelimiter, serializeCsv, CSV_DELIMITERS,
    decodeText, sniffContainer, listZipEntries, formatBytes,
    dateToSerial, serialToDate, isDateFormat,
    parseNumber, parseUserInput, formatGeneralNumber, formatNumber, valueToInputText,
    argbToCss, cssToArgb, el, downloadBlob, clamp, nextFrame,
  };
})(typeof window !== 'undefined' ? window : globalThis);
