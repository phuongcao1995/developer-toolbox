// Table converter: pure functions (no DOM). All formats go through one in-memory model:
//   table = { columns: string[], rows: any[][], align?: ('left'|'center'|'right'|null)[] }
// Parsers produce a table, writers consume one.

export class ConvertError extends Error {
  constructor(message, line = null, column = null) { super(message); this.name = 'ConvertError'; this.line = line; this.column = column; }
}

export const FORMATS = {
  json: { label: 'JSON', ext: 'json', mime: 'application/json;charset=utf-8' },
  csv: { label: 'CSV', ext: 'csv', mime: 'text/csv;charset=utf-8' },
  markdown: { label: 'Markdown table', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  sql: { label: 'SQL INSERT', ext: 'sql', mime: 'application/sql;charset=utf-8' },
  xml: { label: 'XML', ext: 'xml', mime: 'application/xml;charset=utf-8' },
};
/** Valid source -> targets. SQL cannot be a source. */
export const PAIRS = {
  json: ['csv', 'sql', 'markdown', 'xml'],
  csv: ['json', 'sql', 'markdown', 'xml'],
  markdown: ['csv', 'json', 'sql', 'xml'],
  xml: ['json', 'csv', 'sql', 'markdown'],
};

/** Inputs larger than LARGE_INPUT_WARN get a warning + "Convert anyway"; larger than WORKER_MIN they are converted in a Web Worker. */
export const LARGE_INPUT_WARN = 10 * 1024 * 1024;
export const WORKER_MIN = 2 * 1024 * 1024;

export const DELIMITERS = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' };
export const resolveDelimiter = d => DELIMITERS[d] ?? (typeof d === 'string' && d.length === 1 ? d : ',');

const stripBom = s => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

// ---------------------------------------------------------------- helpers

/** Longest row length (loop instead of Math.max(...spread), which overflows the stack on big inputs). */
function maxLen(rows, min = 0) {
  let w = min;
  for (const r of rows) if (r.length > w) w = r.length;
  return w;
}

/**
 * Guarantee non-empty column names and (unless dedupe is false) unique ones.
 * Returns { columns, warnings } - warnings explain every rename.
 */
export function normalizeColumnsDetailed(names, { dedupe = true } = {}) {
  const seen = new Set(), warnings = [], dups = new Set();
  const columns = names.map((raw, i) => {
    let name = String(raw ?? '').trim();
    if (!name) { name = `column_${i + 1}`; warnings.push(`Column ${i + 1} has no name; it is called "${name}".`); }
    if (seen.has(name)) {
      if (dedupe) {
        let n = 2; while (seen.has(`${name}_${n}`)) n++;
        warnings.push(`Duplicate column name "${name}" (column ${i + 1}) was renamed to "${name}_${n}".`);
        name = `${name}_${n}`;
      } else dups.add(name);
    }
    seen.add(name);
    return name;
  });
  for (const d of dups) warnings.push(`Duplicate column name "${d}" was kept as-is: JSON output can hold only one value per name, so later columns overwrite earlier ones. Turn on "De-duplicate headers" to rename them.`);
  return { columns, warnings };
}
/** Guarantee unique, non-empty column names (CSV headers can repeat or be blank). */
export const normalizeColumns = names => normalizeColumnsDetailed(names).columns;

/** Cell value -> text for CSV / Markdown output. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Guess delimiter and quote character from a sample: the delimiter whose per-line count is the most consistent
 * across the first 30 non-empty lines wins (quote-aware). Quote is " unless the sample only uses single-quoted fields.
 */
export function detectDialect(text) {
  const full = stripBom(String(text));
  const s = full.slice(0, 65536);
  let quote = '"';
  if (!s.includes('"') && /(^|[,;\t|\n\r])'[^'\n\r]*'(?=[,;\t|\n\r]|$)/.test(s)) quote = "'";
  let lines = s.split(/\r\n|\n|\r/);
  if (full.length > s.length) lines.pop(); // last line is cut off
  lines = lines.filter(l => l.trim() !== '').slice(0, 30);
  let best = { delimiter: ',', lines: -1, count: 0 };
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map(l => { let n = 0, inQ = false; for (const ch of l) { if (ch === quote) inQ = !inQ; else if (!inQ && ch === d) n++; } return n; });
    const freq = new Map(); counts.forEach(c => { if (c > 0) freq.set(c, (freq.get(c) || 0) + 1); });
    let mode = 0, modeLines = 0;
    for (const [c, f] of freq) if (f > modeLines || (f === modeLines && c > mode)) { mode = c; modeLines = f; }
    if (modeLines > best.lines || (modeLines === best.lines && mode > best.count)) best = { delimiter: d, lines: modeLines, count: mode };
  }
  return { delimiter: best.lines > 0 ? best.delimiter : ',', quote };
}
/** Guess the delimiter (see detectDialect). */
export const detectDelimiter = text => detectDialect(text).delimiter;

// ---------------------------------------------------------------- CSV

/**
 * RFC 4180 parser. Handles quoted fields, embedded delimiters/newlines, doubled-quote escapes, CRLF / LF / CR-only line ends, BOM.
 * opts: quote (default '"'), comment (line prefix to ignore, e.g. '#'), trim (trim whitespace around every unquoted field),
 *       onProgress(fraction) called roughly every MB.
 * Returns { rows: string[][], lines: number[] } where lines[i] is the 1-based start line of row i.
 * Completely blank lines are skipped; a quoted-empty field like "" is a real one-column row.
 * Throws ConvertError (with .line and .column) on malformed quoting.
 */
export function parseCsvRows(text, delimiter = ',', opts = {}) {
  const { quote = '"', comment = '', trim = false, onProgress = null } = opts;
  const s = stripBom(String(text));
  const n = s.length, dc = delimiter.charCodeAt(0);
  const rows = [], lines = [];
  let i = 0, line = 1, lineStart = 0, nextReport = 1 << 20;
  const nl = (from, to) => { // advance line counters over [from, to) which may contain line breaks
    for (let k = from; k < to; k++) {
      const c = s.charCodeAt(k);
      if (c === 10 || (c === 13 && s.charCodeAt(k + 1) !== 10)) { line++; lineStart = k + 1; }
    }
  };
  const skipEol = () => { // consume one line break at i (CRLF, LF or CR)
    if (s.charCodeAt(i) === 13 && s.charCodeAt(i + 1) === 10) i += 2; else i++;
    line++; lineStart = i;
  };
  const delimName = delimiter === '\t' ? 'tab' : delimiter;
  while (i < n) {
    if (onProgress && i >= nextReport) { onProgress(i / n); nextReport = i + (1 << 20); }
    if (comment && s.startsWith(comment, i)) { // whole line ignored
      while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++;
      if (i < n) skipEol();
      continue;
    }
    const row = [], rowLine = line;
    let anyQuoted = false;
    for (;;) {
      let field, quotedField = false;
      if (trim) { let j = i; while (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9) j++; if (s[j] === quote && s.charCodeAt(j) !== dc) i = j; }
      if (s[i] === quote) {
        quotedField = anyQuoted = true;
        const qLine = line, qCol = i - lineStart + 1;
        i++;
        field = '';
        for (;;) {
          const j = s.indexOf(quote, i);
          if (j < 0) throw new ConvertError(`Unterminated quoted field: the quote opened at line ${qLine}, column ${qCol} is never closed. Add the closing ${quote} or remove the stray quote character.`, qLine, qCol);
          field += s.slice(i, j); nl(i, j);
          if (s[j + 1] === quote) { field += quote; i = j + 2; continue; }
          i = j + 1; break;
        }
        if (trim) while (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9) i++;
        if (i < n) {
          const c = s.charCodeAt(i);
          if (c !== dc && c !== 10 && c !== 13) {
            throw new ConvertError(`Line ${line}, column ${i - lineStart + 1}: unexpected "${s[i]}" after the closing quote (expected "${delimName}" or the end of the line). A quote inside a quoted field must be doubled (${quote}${quote}), or the field must end here.`, line, i - lineStart + 1);
          }
        }
      } else {
        let j = i;
        while (j < n) { const c = s.charCodeAt(j); if (c === dc || c === 10 || c === 13) break; j++; }
        field = s.slice(i, j); i = j;
      }
      row.push(trim && !quotedField ? field.trim() : field);
      if (i < n && s.charCodeAt(i) === dc) { i++; continue; }
      break;
    }
    if (i < n) skipEol();
    if (row.length === 1 && row[0] === '' && !anyQuoted) continue; // blank line
    rows.push(row); lines.push(rowLine);
  }
  if (onProgress) onProgress(1);
  return { rows, lines };
}

const capWarnings = (list, noun = 'more') => list.slice(0, 10).concat(list.length > 10 ? [`…and ${list.length - 10} ${noun}.`] : []);

/**
 * CSV text -> table. header=false invents column_N names. Warnings list ragged rows (with row and line numbers) and
 * renamed headers. opts: delimiter, quote, header, dedupeHeaders (default true), skipEmptyRows, comment, trim, onProgress.
 */
export function parseCsv(text, { delimiter = ',', header = true, dedupeHeaders = true, skipEmptyRows = false, quote = '"', comment = '', trim = false, onProgress = null } = {}) {
  const { rows, lines } = parseCsvRows(text, delimiter, { quote, comment, trim, onProgress });
  if (!rows.length) throw new ConvertError('CSV input is empty (no data rows found).');
  let names, body = rows, bodyLines = lines;
  if (header) { names = rows[0]; body = rows.slice(1); bodyLines = lines.slice(1); }
  if (skipEmptyRows) {
    const keep = [];
    body.forEach((r, k) => { if (r.some(c => c !== '')) keep.push(k); });
    if (keep.length !== body.length) { bodyLines = keep.map(k => bodyLines[k]); body = keep.map(k => body[k]); }
  }
  const expected = names ? names.length : (body[0] ? body[0].length : 0);
  const width = maxLen(body, expected);
  const warnings = [];
  body.forEach((r, idx) => {
    if (r.length === expected) return;
    const where = `Row ${idx + 1} (line ${bodyLines[idx]})`;
    const ref = header ? 'the header has' : 'the first row has';
    warnings.push(r.length < expected
      ? `${where}: ${r.length} field(s) but ${ref} ${expected}; the missing ${expected - r.length} were filled with empty values.`
      : `${where}: ${r.length} fields but ${ref} ${expected}; ${r.length - expected} extra column(s) were added.`);
  });
  const nameList = names ? (names.length < width ? [...names, ...Array(width - names.length).fill('')] : names) : Array(width).fill('');
  const norm = normalizeColumnsDetailed(nameList, { dedupe: dedupeHeaders !== false });
  const fixed = body.map(r => (r.length >= width ? r : [...r, ...Array(width - r.length).fill('')]));
  return { columns: norm.columns, rows: fixed, warnings: [...(header ? norm.warnings : []), ...capWarnings(warnings, 'more ragged row(s)')] };
}

/** Quote a CSV field only when needed. */
export function csvField(v, delimiter = ',', escapeFormulas = false) {
  let t = cellText(v);
  // Opt-in CSV-injection guard: a leading quote stops spreadsheets evaluating =, +, -, @, tab and CR cells.
  // Plain numbers such as -5 or +1.5 are left alone.
  if (escapeFormulas && /^[=+\-@\t\r]/.test(t) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) t = "'" + t;
  return (t.includes('"') || t.includes(delimiter) || /[\r\n]/.test(t) || /^\s|\s$/.test(t))
    ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCsv(table, { delimiter = ',', header = true, eol = '\n', escapeFormulas = false } = {}) {
  const out = [];
  if (header) out.push(table.columns.map(c => csvField(c, delimiter, escapeFormulas)).join(delimiter));
  for (const r of table.rows) out.push(r.map(v => csvField(v, delimiter, escapeFormulas)).join(delimiter));
  return out.join(eol);
}

// ---------------------------------------------------------------- JSON

/** Convert 1-based line/column from a JSON.parse error message or character position. */
function describeJsonError(err, text) {
  const msg = String(err.message || err);
  let line = null;
  const lc = msg.match(/line (\d+) column (\d+)/i);
  const pos = msg.match(/position (\d+)/i);
  let col = null;
  if (lc) { line = Number(lc[1]); col = Number(lc[2]); }
  else if (pos) { const p = Number(pos[1]); line = text.slice(0, p).split('\n').length; col = p - text.lastIndexOf('\n', p - 1); }
  return new ConvertError(`Invalid JSON${line ? ` (line ${line}${col ? `, column ${col}` : ''})` : ''}: ${msg}`, line, col);
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nestedToText = v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

/** Integer literals in JSON text beyond +-2^53 (JSON.parse silently rounds them). Skips string contents. */
export function findUnsafeIntegers(src) {
  const re = /"(?:[^"\\]+|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  const found = [];
  let count = 0, m;
  while ((m = re.exec(src))) {
    const t = m[0];
    if (t.charCodeAt(0) === 34 || t.length < 16 || /[.eE]/.test(t)) continue; // strings, short ints, non-integers
    const b = BigInt(t);
    if (b > 9007199254740992n || b < -9007199254740992n) { count++; if (found.length < 3) found.push(t); }
  }
  return { count, examples: found };
}

/** Flatten nested plain objects to dot paths ({a:{b:1}} -> {'a.b':1}). Dots/backslashes in keys are escaped
 *  with a backslash. Arrays are NOT expanded: they stay as JSON text in one cell. Iterative. */
export function flattenObject(obj) {
  const out = {};
  const stack = [[obj, '']];
  const esc = k => k.replace(/[\\.]/g, m => '\\' + m);
  while (stack.length) {
    const [v, path] = stack.pop();
    if (isPlainObject(v) && Object.keys(v).length) {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) stack.push([v[keys[i]], path ? path + '.' + esc(keys[i]) : esc(keys[i])]);
    } else Object.defineProperty(out, path, { value: isPlainObject(v) ? '{}' : v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Accepts array of objects, array of arrays, array of scalars, or a single object.
 *  flatten: expand nested objects into dot-path columns (arrays stay JSON text). */
export function parseJson(text, { header = true, flatten = false } = {}) {
  const src = stripBom(String(text));
  if (!src.trim()) throw new ConvertError('JSON input is empty.');
  let data;
  try { data = JSON.parse(src); } catch (e) { throw describeJsonError(e, src); }
  if (isPlainObject(data)) data = [data];
  if (!Array.isArray(data)) throw new ConvertError('JSON must be an array of objects, an array of arrays, or a single object.');
  if (!data.length) throw new ConvertError('JSON array is empty — nothing to convert.');
  const warnings = [];
  const unsafe = findUnsafeIntegers(src);
  if (unsafe.count) warnings.push(`${unsafe.count} integer(s) exceed 2^53 and lose precision when parsed (e.g. ${unsafe.examples.join(', ')}). Quote them as strings in the source to keep them exact.`);

  if (data.every(isPlainObject)) {
    if (flatten) data = data.map(flattenObject);
    const cols = [];
    const seen = new Set();
    for (const o of data) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const rows = data.map(o => cols.map(k => (k in o ? nestedToText(o[k]) : null)));
    return { columns: cols, rows, warnings };
  }
  if (data.every(Array.isArray)) {
    let names, body = data;
    if (header && data.length > 1) { names = data[0].map(cellText); body = data.slice(1); }
    const width = maxLen(body, names ? names.length : 0);
    const columns = normalizeColumns(names ? [...names, ...Array(Math.max(0, width - names.length)).fill('')] : Array(width).fill(''));
    const rows = body.map(r => Array.from({ length: width }, (_, i) => (i < r.length ? nestedToText(r[i]) : null)));
    return { columns, rows, warnings };
  }
  if (data.every(v => !isPlainObject(v) && !Array.isArray(v))) {
    return { columns: ['value'], rows: data.map(v => [v]), warnings };
  }
  const bad = data.findIndex(v => !isPlainObject(v));
  throw new ConvertError(`Mixed array: element ${bad} is not an object like the others. Use an array of objects, or an array of arrays.`);
}

export function toJson(table, { indent = '  ', shape = 'objects' } = {}) {
  const ind = indent === '' ? undefined : indent;
  if (shape === 'arrays') return JSON.stringify([table.columns, ...table.rows], null, ind);
  const objs = table.rows.map(r => Object.fromEntries(table.columns.map((c, i) => [c, r[i] ?? null])));
  return JSON.stringify(objs, null, ind);
}

// ---------------------------------------------------------------- Markdown

const SEP_CELL = /^:?-+:?$/;

/** Split a table row on unescaped pipes; `\|` becomes `|`, `<br>` becomes a newline. */
export function splitMdRow(line) {
  let s = line.trim();
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '|') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  // a leading/trailing pipe creates empty edge cells
  if (s.startsWith('|')) cells.shift();
  if (s.endsWith('|') && !s.endsWith('\\|')) cells.pop();
  return cells.map(c => c.trim().replace(/<br\s*\/?>/gi, '\n'));
}

/** Parse the first Markdown (GFM) table found in text. */
export function parseMarkdown(text) {
  const lines = stripBom(String(text)).split(/\r\n|\n|\r/);
  let start = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|') && !lines[i + 1].includes('|')) continue;
    const sep = lines[i + 1].trim();
    if (!sep || !/^[\s|:-]+$/.test(sep) || !sep.includes('-')) continue;
    const sepCells = splitMdRow(sep);
    if (sepCells.length && sepCells.every(c => SEP_CELL.test(c)) && lines[i].trim() !== '') { start = i; break; }
  }
  if (start < 0) {
    throw new ConvertError('No Markdown table found. Expected a header row followed by a separator row such as |---|---|.');
  }
  const header = splitMdRow(lines[start]);
  const sepCells = splitMdRow(lines[start + 1]);
  if (header.length !== sepCells.length) {
    throw new ConvertError(`Line ${start + 2}: separator row has ${sepCells.length} column(s) but the header has ${header.length}.`, start + 2);
  }
  const align = sepCells.map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
  const rows = [];
  const warnings = [];
  for (let i = start + 2; i < lines.length; i++) {
    if (lines[i].trim() === '' || !lines[i].includes('|')) break; // table ends
    const cells = splitMdRow(lines[i]);
    if (cells.length !== header.length) warnings.push(`Line ${i + 1}: ${cells.length} cell(s), expected ${header.length}.`);
    rows.push(Array.from({ length: header.length }, (_, k) => cells[k] ?? ''));
  }
  return { columns: normalizeColumns(header), rows, align, warnings: warnings.slice(0, 5) };
}

/** Terminal-style display width of one code point: 0 for combining/format marks, 2 for East-Asian wide and emoji, else 1 (approximation). */
export function charWidth(cp) {
  if (cp < 0x300) return cp < 32 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  if (/^[\p{Mn}\p{Me}\p{Cf}]$/u.test(String.fromCodePoint(cp))) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
/** Display width of a string, counted per code point (not UTF-16 unit). */
export function displayWidth(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

const escMd = t => t.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** Generate an aligned GFM table. align: 'auto' (numbers right) | 'left' | 'center' | 'right' | 'none'. */
export function toMarkdown(table, { align = 'auto' } = {}) {
  const head = table.columns.map(c => escMd(String(c)));
  const body = table.rows.map(r => table.columns.map((_, i) => escMd(cellText(r[i]))));
  const aligns = table.columns.map((_, i) => {
    if (align === 'auto') {
      if (table.align && table.align[i]) return table.align[i];
      const vals = table.rows.map(r => r[i]).filter(v => v !== null && v !== '' && v !== undefined);
      return vals.length && vals.every(v => typeof v === 'number' || (typeof v === 'string' && isNumeric(v))) ? 'right' : 'left';
    }
    return align === 'none' ? null : align;
  });
  const widths = head.map((h, i) => {
    let w = Math.max(3, displayWidth(h));
    for (const r of body) { const cw = displayWidth(r[i]); if (cw > w) w = cw; }
    return w;
  });
  const pad = (t, w, a) => {
    const gap = Math.max(0, w - displayWidth(t));
    return a === 'right' ? ' '.repeat(gap) + t : a === 'center' ? ' '.repeat(gap >> 1) + t + ' '.repeat(gap - (gap >> 1)) : t + ' '.repeat(gap);
  };
  const fmt = cells => `| ${cells.map((c, i) => pad(c, widths[i], aligns[i])).join(' | ')} |`;
  const sep = widths.map((w, i) => {
    const a = aligns[i];
    return a === 'center' ? `:${'-'.repeat(w - 2)}:` : a === 'right' ? `${'-'.repeat(w - 1)}:` : a === 'left' ? `:${'-'.repeat(w - 1)}` : '-'.repeat(w);
  });
  return [fmt(head), `| ${sep.join(' | ')} |`, ...body.map(fmt)].join('\n');
}

// ---------------------------------------------------------------- type inference

/** Strict number check: no leading zeros ("007" stays text), no hex, at most 15 integer digits. */
export function isNumeric(s) {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return false;
  return s.replace(/^-/, '').split(/[.eE]/)[0].length <= 15 && Number.isFinite(Number(s));
}

/**
 * Column-wise inference for string tables: a column becomes numbers only if EVERY non-empty value
 * is numeric (or booleans if every one is true/false). Empty cells in inferred columns become null.
 */
export function inferTypes(table) {
  const rows = table.rows.map(r => r.slice());
  table.columns.forEach((_, c) => {
    const vals = rows.map(r => r[c]).filter(v => v !== '' && v !== null && v !== undefined);
    if (!vals.length || !vals.every(v => typeof v === 'string')) return;
    let conv = null;
    if (vals.every(isNumeric)) conv = Number;
    else if (vals.every(v => /^(true|false)$/i.test(v))) conv = v => v.toLowerCase() === 'true';
    if (!conv) return;
    for (const r of rows) r[c] = r[c] === '' || r[c] == null ? null : conv(r[c]);
  });
  return { ...table, rows };
}

// ---------------------------------------------------------------- SQL

export const DIALECTS = {
  ansi: { label: 'ANSI / PostgreSQL / SQLite ("x")', open: '"', close: '"' },
  mysql: { label: 'MySQL / MariaDB (`x`)', open: '`', close: '`' },
  sqlserver: { label: 'SQL Server ([x])', open: '[', close: ']' },
};

/** Quote one identifier part, doubling the closing quote char inside it. */
export function quoteIdent(name, dialect = 'ansi') {
  const d = DIALECTS[dialect] || DIALECTS.ansi;
  return d.open + String(name).split(d.close).join(d.close + d.close) + d.close;
}

/** Validate a table name (optionally schema-qualified: dbo.users) and return its quoted form. */
export function quoteTableName(name, dialect = 'ansi') {
  const parts = String(name ?? '').trim().split('.');
  if (!parts.length || parts.some(p => !/^[A-Za-z_][A-Za-z0-9_$ ]*$/.test(p.trim()))) {
    throw new ConvertError('Invalid table name. Use letters, digits, "_" or "$", not starting with a digit (schema.table allowed).');
  }
  return parts.map(p => quoteIdent(p.trim(), dialect)).join('.');
}

/** SQL literal for one value. */
export function sqlLiteral(v, dialect = 'ansi') {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return dialect === 'sqlserver' ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE');
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (dialect === 'mysql') s = s.replace(/\\/g, '\\\\'); // MySQL treats backslash as an escape char by default
  s = s.replace(/'/g, "''");
  const prefix = dialect === 'sqlserver' && /[^\x00-\x7F]/.test(s) ? 'N' : ''; // keep Unicode intact on SQL Server
  return `${prefix}'${s}'`;
}

export function toSql(table, { tableName = 'my_table', dialect = 'ansi', multiRow = true, emptyAsNull = false } = {}) {
  if (!table.rows.length) throw new ConvertError('No data rows to generate INSERT statements for.');
  const target = quoteTableName(tableName, dialect);
  const cols = table.columns.map(c => quoteIdent(c, dialect)).join(', ');
  const tuples = table.rows.map(r =>
    '(' + table.columns.map((_, i) => {
      const v = r[i];
      return sqlLiteral(emptyAsNull && v === '' ? null : v, dialect);
    }).join(', ') + ')');
  const head = `INSERT INTO ${target} (${cols}) VALUES`;
  if (!multiRow) return tuples.map(t => `${head} ${t};`).join('\n');
  // SQL Server allows at most 1000 row constructors per INSERT
  const size = dialect === 'sqlserver' ? 1000 : Infinity;
  const stmts = [];
  for (let i = 0; i < tuples.length; i += Math.min(size, tuples.length)) {
    stmts.push(`${head}\n  ${tuples.slice(i, i + size).join(',\n  ')};`);
  }
  return stmts.join('\n');
}

// ---------------------------------------------------------------- XML
// Hand-written parser/serializer (no DOM): works in Node tests and inside Web Workers, and reports exact line/column.
// JSON mapping: attributes -> "@name", text -> "#text", CDATA -> "#cdata", repeated sibling elements -> arrays,
// namespace prefixes and xmlns declarations are kept as plain keys ("ns:tag", "@xmlns:ns"). Comments / processing
// instructions / the XML declaration are dropped. Values stay strings (no number inference); empty elements become null.

const NAME_START = /[A-Za-z_:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]/u;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]/u;
const MAX_XML_DEPTH = 500;

/** Make any string a legal XML element/attribute name (invalid chars -> "_", leading digit/dash/dot gets a "_" prefix). */
export function sanitizeXmlName(raw) {
  let s = String(raw ?? '');
  let out = '';
  for (const ch of s) out += NAME_CHAR.test(ch) ? ch : '_';
  if (out === '') return '_';
  if (!NAME_START.test(String.fromCodePoint(out.codePointAt(0)))) out = '_' + out;
  // a name may hold at most one colon with something on both sides; anything else would be a malformed QName
  if (out.startsWith(':') || out.endsWith(':') || out.split(':').length > 2) out = out.replace(/:/g, '_');
  return out;
}

/** Remove characters that are illegal in XML 1.0 (control chars, lone surrogates, U+FFFE/FFFF). Returns {text, removed}. */
export function cleanXmlText(s) {
  let removed = 0, out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) || c >= 0x10000) out += ch;
    else { removed++; out += '\uFFFD'; }
  }
  return { text: out, removed };
}
const escXmlText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escXmlAttr = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
const cdata = s => '<![CDATA[' + s.split(']]>').join(']]]]><![CDATA[>') + ']]>';

const XML_ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/**
 * Parse XML text into a tree: { name, attrs:[[k,v]], children:[{t:'el',node}|{t:'text',text}|{t:'cdata',text}], line, col }.
 * Throws ConvertError with a friendly "Line L, column C: ..." message.
 */
export function parseXmlTree(src) {
  const s = stripBom(String(src));
  const n = s.length;
  let i = 0, line = 1, lineStart = 0;
  const pos = idx => { // line/column of an absolute index (computed lazily by scanning: only used for errors and element starts)
    let l = line, ls = lineStart;
    if (idx < i) { l = 1; ls = 0; for (let k = 0; k < idx; k++) { const c = s.charCodeAt(k); if (c === 10 || (c === 13 && s.charCodeAt(k + 1) !== 10)) { l++; ls = k + 1; } } }
    else for (let k = i; k < idx; k++) { const c = s.charCodeAt(k); if (c === 10 || (c === 13 && s.charCodeAt(k + 1) !== 10)) { l++; ls = k + 1; } }
    return { line: l, col: idx - ls + 1 };
  };
  const fail = (msg, idx = i) => { const p = pos(idx); throw new ConvertError(`Invalid XML (line ${p.line}, column ${p.col}): ${msg}`, p.line, p.col); };
  const advance = to => { // move i to 'to' keeping line counters right
    for (let k = i; k < to; k++) { const c = s.charCodeAt(k); if (c === 10 || (c === 13 && s.charCodeAt(k + 1) !== 10)) { line++; lineStart = k + 1; } }
    i = to;
  };
  const readName = () => {
    const start = i;
    const cp = s.codePointAt(i);
    if (cp === undefined || !NAME_START.test(String.fromCodePoint(cp))) fail(i < n ? `"${s[i]}" cannot start an element or attribute name.` : 'unexpected end of input where a name was expected.');
    let j = i;
    while (j < n) { const c = String.fromCodePoint(s.codePointAt(j)); if (!NAME_CHAR.test(c)) break; j += c.length; }
    i = j;
    return s.slice(start, j);
  };
  const skipWs = () => { let j = i; while (j < n && /\s/.test(s[j])) j++; advance(j); };
  const decode = (raw, at) => raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^;&\s<]*);?/g, (m, body, off) => {
    if (!m.endsWith(';')) fail(`"&" must be written as &amp; (or complete the entity with ";").`, at + off);
    if (body[0] === '#') {
      const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!(cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF))) fail(`character reference &${body}; is not a legal XML character.`, at + off);
      return String.fromCodePoint(cp);
    }
    if (!(body in XML_ENT)) fail(`unknown entity &${body}; (XML only predefines &lt; &gt; &amp; &quot; &apos;; write other characters directly or as &#...; numeric references).`, at + off);
    return XML_ENT[body];
  });

  const root = { name: '#document', attrs: [], children: [], line: 1, col: 1 };
  const stack = [root];
  let rootSeen = false;
  const cur = () => stack[stack.length - 1];

  while (i < n) {
    if (s[i] !== '<') { // text
      let j = s.indexOf('<', i); if (j < 0) j = n;
      const raw = s.slice(i, j);
      if (stack.length === 1) { if (raw.trim() !== '') fail(rootSeen ? 'text after the root element is not allowed.' : 'text before the root element is not allowed.'); }
      else cur().children.push({ t: 'text', text: decode(raw, i) });
      advance(j); continue;
    }
    if (s.startsWith('<!--', i)) {
      const j = s.indexOf('-->', i + 4);
      if (j < 0) fail('comment is never closed (missing "-->").');
      advance(j + 3); continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      if (stack.length === 1) fail('CDATA is only allowed inside an element.');
      const j = s.indexOf(']]>', i + 9);
      if (j < 0) fail('CDATA section is never closed (missing "]]>").');
      cur().children.push({ t: 'cdata', text: s.slice(i + 9, j) });
      advance(j + 3); continue;
    }
    if (s.startsWith('<?', i)) {
      const j = s.indexOf('?>', i + 2);
      if (j < 0) fail('processing instruction / XML declaration is never closed (missing "?>").');
      advance(j + 2); continue;
    }
    if (s.startsWith('<!', i)) {
      if (!/^<!DOCTYPE/i.test(s.slice(i, i + 9))) fail('unsupported markup declaration.');
      // skip a DOCTYPE (with optional [ internal subset ]), but refuse entity declarations (entity expansion attacks)
      let j = i + 9, depth = 0;
      while (j < n) { const c = s[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; j++; }
      if (j >= n) fail('DOCTYPE is never closed.');
      if (/<!ENTITY/i.test(s.slice(i, j))) fail('DTD entity declarations are not supported (they can expand into huge documents). Remove the <!ENTITY ...> lines.');
      advance(j + 1); continue;
    }
    if (s[i + 1] === '/') { // closing tag
      const at = i;
      advance(i + 2);
      const name = readName(); skipWs();
      if (s[i] !== '>') fail('closing tag must end with ">".');
      const open = cur();
      if (stack.length === 1) fail(`closing tag </${name}> has no matching opening tag.`, at);
      if (open.name !== name) fail(`closing tag </${name}> does not match the open <${open.name}> (opened at line ${open.line}, column ${open.col}).`, at);
      stack.pop(); advance(i + 1); continue;
    }
    // opening / self-closing tag
    const at = i;
    if (stack.length === 1 && rootSeen) fail('only one root element is allowed; found a second top-level element.');
    if (stack.length > MAX_XML_DEPTH) fail(`elements are nested more than ${MAX_XML_DEPTH} levels deep.`);
    advance(i + 1);
    const p = pos(at);
    const node = { name: readName(), attrs: [], children: [], line: p.line, col: p.col };
    for (;;) {
      const before = i; skipWs();
      if (s[i] === '>' || (s[i] === '/' && s[i + 1] === '>')) break;
      if (i >= n) fail(`tag <${node.name}> is never closed (missing ">").`, at);
      if (i === before) fail('attributes must be separated by whitespace.');
      const an = readName(); skipWs();
      if (s[i] !== '=') fail(`attribute "${an}" needs a value: write ${an}="..." .`);
      advance(i + 1); skipWs();
      const q = s[i];
      if (q !== '"' && q !== "'") fail(`value of attribute "${an}" must be in quotes.`);
      const j = s.indexOf(q, i + 1);
      if (j < 0) fail(`value of attribute "${an}" is never closed (missing ${q}).`);
      if (node.attrs.some(a => a[0] === an)) fail(`attribute "${an}" appears twice on <${node.name}>.`, at);
      const raw = s.slice(i + 1, j);
      if (raw.includes('<')) fail(`"<" is not allowed inside the value of attribute "${an}" (write &lt;).`);
      node.attrs.push([an, decode(raw, i + 1).replace(/[\t\n\r]/g, ' ')]);
      advance(j + 1);
    }
    cur().children.push({ t: 'el', node });
    if (stack.length === 1) rootSeen = true;
    if (s[i] === '/') advance(i + 2);
    else { advance(i + 1); stack.push(node); }
  }
  if (stack.length > 1) { const open = cur(); fail(`<${open.name}> (opened at line ${open.line}, column ${open.col}) is never closed.`, n); }
  if (!rootSeen) fail('no root element found.', 0);
  return root.children.find(c => c.t === 'el').node;
}

/** Tree node -> JSON value using the @attr / #text / #cdata convention. */
export function xmlNodeToJson(node, depth = 0) {
  if (depth > MAX_XML_DEPTH) throw new ConvertError('XML is nested too deeply.');
  const obj = {};
  for (const [k, v] of node.attrs) obj['@' + k] = v;
  let text = '', cd = '', hasEl = false;
  const groups = new Map();
  for (const c of node.children) {
    if (c.t === 'text') text += c.text;
    else if (c.t === 'cdata') cd += c.text;
    else { hasEl = true; (groups.get(c.node.name) || groups.set(c.node.name, []).get(c.node.name)).push(xmlNodeToJson(c.node, depth + 1)); }
  }
  if (hasEl) text = text.trim(); // indentation between child elements is not content
  const hasAttrs = node.attrs.length > 0;
  if (!hasAttrs && !hasEl && cd === '') return text === '' ? null : text;
  if (text !== '') obj['#text'] = text;
  if (cd !== '') obj['#cdata'] = cd;
  for (const [name, list] of groups) obj[name] = list.length === 1 ? list[0] : list;
  return obj;
}

/** XML text -> JSON value { rootName: ... }. */
export function parseXmlToJson(src) {
  const root = parseXmlTree(src);
  return { [root.name]: xmlNodeToJson(root) };
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const scalarText = v => (typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * JSON value -> XML text. Object keys starting with "@" become attributes, "#text" / "#cdata" become content, arrays
 * become repeated elements. A single-key top-level object supplies the root name; otherwise the value is wrapped in <rootName>.
 * Names are sanitised (renames reported in warnings). Returns { output, warnings }.
 */
export function jsonToXml(data, { indent = '  ', rootName = 'root', itemName = 'item', declaration = true } = {}) {
  const warnings = [];
  const renamed = new Map();
  let removedChars = 0;
  const nm = raw => {
    const out = sanitizeXmlName(raw);
    if (out !== raw && !renamed.has(raw)) renamed.set(raw, out);
    return out;
  };
  const txt = v => { const c = cleanXmlText(scalarText(v)); removedChars += c.removed; return c.text; };
  const nlq = indent === '' ? '' : '\n';
  const lines = [];
  const emit = (depth, s) => lines.push(indent.repeat(depth) + s);

  function element(name, value, depth) {
    if (depth > MAX_XML_DEPTH) throw new ConvertError('JSON is nested too deeply to convert to XML.');
    const tag = nm(name);
    if (Array.isArray(value)) { for (const item of value) element(name, Array.isArray(item) ? { [itemName]: item } : item, depth); return; }
    if (value === null || value === undefined) { emit(depth, `<${tag}/>`); return; }
    if (!isObj(value)) { emit(depth, `<${tag}>${escXmlText(txt(value))}</${tag}>`); return; }
    let attrs = '', text = null, cd = null;
    const kids = [];
    for (const [k, v] of Object.entries(value)) {
      if (k[0] === '@') { if (v !== null && v !== undefined) attrs += ` ${nm(k.slice(1))}="${escXmlAttr(txt(v))}"`; }
      else if (k === '#text') text = v === null || v === undefined ? null : txt(v);
      else if (k === '#cdata') cd = v === null || v === undefined ? null : txt(v);
      else kids.push([k, v]);
    }
    if (!kids.length) {
      const inner = (text !== null ? escXmlText(text) : '') + (cd !== null ? cdata(cd) : '');
      emit(depth, inner === '' ? `<${tag}${attrs}/>` : `<${tag}${attrs}>${inner}</${tag}>`);
      return;
    }
    emit(depth, `<${tag}${attrs}>`);
    if (text !== null && text !== '') emit(depth + 1, escXmlText(text));
    if (cd !== null && cd !== '') emit(depth + 1, cdata(cd));
    for (const [k, v] of kids) element(k, v, depth + 1);
    emit(depth, `</${tag}>`);
  }

  if (isObj(data) && Object.keys(data).filter(k => k[0] !== '@' && k[0] !== '#').length === 1 && !Object.keys(data).some(k => k[0] === '@' || k[0] === '#')) {
    const [[k, v]] = Object.entries(data);
    if (Array.isArray(v)) element(rootName, { [k]: v }, 0); else element(k, v, 0);
  } else element(rootName, Array.isArray(data) ? { [itemName]: data } : data, 0);

  if (renamed.size) warnings.push('Names that are not valid XML were renamed: ' + [...renamed].slice(0, 8).map(([a, b]) => `"${a}" -> "${b}"`).join(', ') + (renamed.size > 8 ? `, …and ${renamed.size - 8} more` : '') + '.');
  if (removedChars) warnings.push(`${removedChars} character(s) that XML 1.0 forbids (control characters or lone surrogates) were replaced with U+FFFD.`);
  const head = declaration ? '<?xml version="1.0" encoding="UTF-8"?>' + nlq : '';
  return { output: head + lines.join(nlq), warnings };
}

/** Table -> <rows><row><column>value</column>...</row></rows>. Column names are sanitised and made unique. */
export function tableToXml(table, { indent = '  ', rootName = 'rows', rowName = 'row', declaration = true } = {}) {
  const warnings = [];
  const used = new Set(), names = table.columns.map(c => {
    const base = sanitizeXmlName(c);
    let name = base, k = 2;
    while (used.has(name)) name = `${base}_${k++}`;
    used.add(name);
    if (name !== c) warnings.push(`Column "${c}" is written as <${name}>.`);
    return name;
  });
  const root = sanitizeXmlName(rootName), row = sanitizeXmlName(rowName);
  let removed = 0;
  const nlq = indent === '' ? '' : '\n';
  const out = [];
  if (declaration) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<${root}>`);
  for (const r of table.rows) {
    out.push(indent + `<${row}>`);
    names.forEach((nme, i) => {
      const v = r[i];
      if (v === null || v === undefined || v === '') { out.push(indent + indent + `<${nme}/>`); return; }
      const c = cleanXmlText(cellText(v)); removed += c.removed;
      out.push(indent + indent + `<${nme}>${escXmlText(c.text)}</${nme}>`);
    });
    out.push(indent + `</${row}>`);
  }
  out.push(`</${root}>`);
  if (removed) warnings.push(`${removed} forbidden control character(s) were replaced with U+FFFD.`);
  return { output: out.join(nlq), warnings: warnings.slice(0, 10) };
}

/** XML -> table: the root's child elements are records; their attributes ("@x") and child elements become columns. */
export function xmlToTable(src) {
  const root = parseXmlTree(src);
  const recs = root.children.filter(c => c.t === 'el').map(c => c.node);
  const warnings = [];
  if (!recs.length) throw new ConvertError(`<${root.name}> has no child elements, so there are no records to turn into rows. Use the JSON output instead.`);
  const names = new Set(recs.map(r => r.name));
  if (names.size > 1) warnings.push(`The root has different child elements (${[...names].slice(0, 4).join(', ')}…); each one became a row.`);
  const cols = [], seen = new Set();
  const rowObjs = recs.map(r => {
    const o = {};
    for (const [k, v] of r.attrs) o['@' + k] = v;
    const j = xmlNodeToJson(r);
    if (j !== null && typeof j === 'object') { for (const [k, v] of Object.entries(j)) if (k[0] !== '@') o[k] = v; }
    else if (j !== null) o['#text'] = j;
    for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    return o;
  });
  return { columns: cols, rows: rowObjs.map(o => cols.map(k => (k in o ? nestedToText(o[k]) : null))), warnings };
}

/**
 * Full conversion. opts: delimiter ('auto' allowed), header, inferTypes, emptyAsNull, indent, jsonShape,
 * tableName, dialect, multiRow, mdAlign.
 * Returns { output, table, warnings, ext, mime }.
 */
export function convert(input, from, to, opts = {}) {
  if (!PAIRS[from]?.includes(to)) throw new ConvertError(`Converting ${from} to ${to} is not supported.`);
  if (!String(input ?? '').trim()) throw new ConvertError('Input is empty.');
  const header = opts.header !== false;
  const progress = opts.onProgress || null;
  const stage = (name, fraction = 0) => { if (progress) progress({ stage: name, fraction }); };
  let table;
  stage('Parsing');
  const pushWarn = [];
  if (from === 'json' && to === 'xml') { // structural: keeps nesting, @attributes and arrays
    let data;
    const src = stripBom(String(input));
    try { data = JSON.parse(src); } catch (e) { throw describeJsonError(e, src); }
    const x = jsonToXml(data, { indent: opts.indent ?? '  ', rootName: opts.xmlRoot || 'root' });
    const u = findUnsafeIntegers(src);
    const w = u.count ? [`${u.count} integer(s) exceed 2^53 and lose precision when parsed (e.g. ${u.examples.join(', ')}).`] : [];
    return { output: x.output, table: null, warnings: [...w, ...x.warnings], ext: 'xml', mime: FORMATS.xml.mime };
  }
  if (from === 'xml' && to === 'json') {
    const out = parseXmlToJson(input);
    return { output: JSON.stringify(out, null, (opts.indent ?? '  ') === '' ? undefined : (opts.indent ?? '  ')), table: null, warnings: [], ext: 'json', mime: FORMATS.json.mime };
  }
  if (from === 'json') table = parseJson(input, { header, flatten: !!opts.flatten });
  else if (from === 'csv') {
    let d, q = opts.quote && opts.quote !== 'auto' ? opts.quote : '"';
    if (opts.delimiter === 'auto' || opts.quote === 'auto') {
      const dia = detectDialect(input);
      d = opts.delimiter === 'auto' ? dia.delimiter : resolveDelimiter(opts.delimiter);
      if (opts.quote === 'auto') q = dia.quote;
      if (opts.delimiter === 'auto') pushWarn.push(`Detected delimiter: ${dia.delimiter === '\t' ? 'tab' : '"' + dia.delimiter + '"'}${opts.quote === 'auto' ? `, quote: ${dia.quote}` : ''}.`);
    } else d = resolveDelimiter(opts.delimiter);
    table = parseCsv(input, {
      delimiter: d, quote: q, header, dedupeHeaders: opts.dedupeHeaders !== false, skipEmptyRows: !!opts.skipEmptyRows,
      comment: opts.comment || '', trim: !!opts.trim, onProgress: progress ? f => stage('Parsing', f) : null,
    });
    table.warnings = [...pushWarn, ...table.warnings];
  } else if (from === 'xml') table = xmlToTable(input);
  else table = parseMarkdown(input);

  if (from !== 'json' && from !== 'xml' && opts.inferTypes) table = inferTypes(table);
  if (opts.emptyAsNull && (to === 'json' || to === 'sql')) {
    table = { ...table, rows: table.rows.map(r => r.map(v => (v === '' ? null : v))) };
  }

  stage('Writing');
  let output;
  const extra = [];
  switch (to) {
    case 'csv': output = toCsv(table, { delimiter: resolveDelimiter(opts.delimiter === 'auto' ? 'comma' : opts.delimiter), header, escapeFormulas: !!opts.escapeFormulas }); break;
    case 'json': output = toJson(table, { indent: opts.indent ?? '  ', shape: opts.jsonShape }); break;
    case 'markdown': output = toMarkdown(table, { align: opts.mdAlign || 'auto' }); break;
    case 'sql': output = toSql(table, opts); break;
    case 'xml': { const x = tableToXml(table, { indent: opts.indent ?? '  ', rootName: opts.xmlRoot || 'rows', rowName: opts.xmlRow || 'row' }); output = x.output; extra.push(...x.warnings); break; }
  }
  table = { ...table, warnings: [...(table.warnings || []), ...extra] };
  return { output, table, warnings: table.warnings, ext: FORMATS[to].ext, mime: FORMATS[to].mime };
}

/** Light-weight view of a table for the UI / worker messages: columns, the first `limit` rows and the real row count. */
export function summarizeTable(table, limit = 500) {
  if (!table) return null;
  return { columns: table.columns, rows: table.rows.slice(0, limit), rowCount: table.rows.length };
}
