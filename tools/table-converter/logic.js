// Table converter: pure functions (no DOM). All formats go through one in-memory model:
//   table = { columns: string[], rows: any[][], align?: ('left'|'center'|'right'|null)[] }
// Parsers produce a table, writers consume one.

export class ConvertError extends Error {
  constructor(message, line = null) { super(message); this.name = 'ConvertError'; this.line = line; }
}

export const FORMATS = {
  json: { label: 'JSON', ext: 'json', mime: 'application/json;charset=utf-8' },
  csv: { label: 'CSV', ext: 'csv', mime: 'text/csv;charset=utf-8' },
  markdown: { label: 'Markdown table', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  sql: { label: 'SQL INSERT', ext: 'sql', mime: 'application/sql;charset=utf-8' },
};
/** Valid source -> targets. SQL cannot be a source. */
export const PAIRS = {
  json: ['csv', 'sql', 'markdown'],
  csv: ['json', 'sql', 'markdown'],
  markdown: ['csv', 'json', 'sql'],
};

export const DELIMITERS = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' };
export const resolveDelimiter = d => DELIMITERS[d] ?? (typeof d === 'string' && d.length === 1 ? d : ',');

const stripBom = s => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

// ---------------------------------------------------------------- helpers

/** Guarantee unique, non-empty column names (CSV headers can repeat or be blank). */
export function normalizeColumns(names) {
  const seen = new Set();
  return names.map((raw, i) => {
    let name = String(raw ?? '').trim() || `column_${i + 1}`;
    if (seen.has(name)) { let n = 2; while (seen.has(`${name}_${n}`)) n++; name = `${name}_${n}`; }
    seen.add(name);
    return name;
  });
}

/** Cell value -> text for CSV / Markdown output. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Guess the delimiter from the first non-empty line (ignoring quoted sections). */
export function detectDelimiter(text) {
  const line = stripBom(String(text)).split(/\r\n|\n|\r/).find(l => l.trim() !== '') ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

// ---------------------------------------------------------------- CSV

/**
 * RFC 4180 parser. Handles quoted fields, embedded delimiters/newlines, "" escapes, CRLF/LF/CR, BOM.
 * Returns { rows: string[][], lines: number[] } where lines[i] is the 1-based start line of row i.
 * Throws ConvertError with a line number on malformed quoting.
 */
export function parseCsvRows(text, delimiter = ',') {
  const s = stripBom(String(text));
  const rows = [], lines = [];
  let field = '', row = [], line = 1, rowLine = 1;
  let i = 0;
  const n = s.length;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    // skip completely blank lines
    if (!(row.length === 0 && field === '')) {
      endField();
      if (!(row.length === 1 && row[0] === '')) { rows.push(row); lines.push(rowLine); }
    }
    row = [];
  };

  while (i < n) {
    const ch = s[i];
    if (ch === '"' && field === '') {
      // quoted field
      const startLine = line;
      i++;
      let closed = false;
      while (i < n) {
        const c = s[i];
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++; closed = true; break;
        }
        if (c === '\n') line++;
        else if (c === '\r') { if (s[i + 1] === '\n') { field += '\r'; i++; } line++; field += s[i]; i++; continue; }
        field += c; i++;
      }
      if (!closed) throw new ConvertError(`Unterminated quoted field starting on line ${startLine}.`, startLine);
      const next = s[i];
      if (i < n && next !== delimiter && next !== '\n' && next !== '\r') {
        throw new ConvertError(`Line ${line}: unexpected character "${next}" after closing quote (expected delimiter or end of line).`, line);
      }
    } else if (ch === delimiter) {
      endField(); i++;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      i++;
      endRow(); line++; rowLine = line;
    } else { field += ch; i++; }
  }
  if (field !== '' || row.length) endRow();
  return { rows, lines };
}

/** CSV text -> table. header=false invents column_N names. Warnings list ragged rows. */
export function parseCsv(text, { delimiter = ',', header = true } = {}) {
  const { rows, lines } = parseCsvRows(text, delimiter);
  if (!rows.length) throw new ConvertError('CSV input is empty.');
  const warnings = [];
  let names, body = rows, bodyLines = lines;
  if (header) { names = rows[0]; body = rows.slice(1); bodyLines = lines.slice(1); }
  let width = Math.max(names ? names.length : 0, ...body.map(r => r.length));
  if (names && names.length < width) names = [...names, ...Array(width - names.length).fill('')];
  if (!names) names = Array(width).fill('');
  const columns = normalizeColumns(names);
  const fixed = body.map((r, idx) => {
    if (r.length !== (header ? rows[0].length : width)) {
      warnings.push(`Line ${bodyLines[idx]}: ${r.length} field(s), expected ${header ? rows[0].length : width}.`);
    }
    return r.length >= width ? r : [...r, ...Array(width - r.length).fill('')];
  });
  return { columns, rows: fixed, warnings: warnings.slice(0, 5).concat(warnings.length > 5 ? [`…and ${warnings.length - 5} more.`] : []) };
}

/** Quote a CSV field only when needed. */
export function csvField(v, delimiter = ',') {
  const t = cellText(v);
  return (t.includes('"') || t.includes(delimiter) || /[\r\n]/.test(t) || /^\s|\s$/.test(t))
    ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCsv(table, { delimiter = ',', header = true, eol = '\n' } = {}) {
  const out = [];
  if (header) out.push(table.columns.map(c => csvField(c, delimiter)).join(delimiter));
  for (const r of table.rows) out.push(r.map(v => csvField(v, delimiter)).join(delimiter));
  return out.join(eol);
}

// ---------------------------------------------------------------- JSON

/** Convert 1-based line/column from a JSON.parse error message or character position. */
function describeJsonError(err, text) {
  const msg = String(err.message || err);
  let line = null;
  const lc = msg.match(/line (\d+) column (\d+)/i);
  const pos = msg.match(/position (\d+)/i);
  if (lc) line = Number(lc[1]);
  else if (pos) line = text.slice(0, Number(pos[1])).split('\n').length;
  return new ConvertError(`Invalid JSON${line ? ` (line ${line})` : ''}: ${msg}`, line);
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nestedToText = v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

/** Accepts array of objects, array of arrays, array of scalars, or a single object. */
export function parseJson(text, { header = true } = {}) {
  const src = stripBom(String(text));
  if (!src.trim()) throw new ConvertError('JSON input is empty.');
  let data;
  try { data = JSON.parse(src); } catch (e) { throw describeJsonError(e, src); }
  if (isPlainObject(data)) data = [data];
  if (!Array.isArray(data)) throw new ConvertError('JSON must be an array of objects, an array of arrays, or a single object.');
  if (!data.length) throw new ConvertError('JSON array is empty — nothing to convert.');

  if (data.every(isPlainObject)) {
    const cols = [];
    const seen = new Set();
    for (const o of data) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const rows = data.map(o => cols.map(k => (k in o ? nestedToText(o[k]) : null)));
    return { columns: cols, rows, warnings: [] };
  }
  if (data.every(Array.isArray)) {
    let names, body = data;
    if (header && data.length > 1) { names = data[0].map(cellText); body = data.slice(1); }
    const width = Math.max(names ? names.length : 0, ...body.map(r => r.length));
    const columns = normalizeColumns(names ? [...names, ...Array(Math.max(0, width - names.length)).fill('')] : Array(width).fill(''));
    const rows = body.map(r => Array.from({ length: width }, (_, i) => (i < r.length ? nestedToText(r[i]) : null)));
    return { columns, rows, warnings: [] };
  }
  if (data.every(v => !isPlainObject(v) && !Array.isArray(v))) {
    return { columns: ['value'], rows: data.map(v => [v]), warnings: [] };
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
  const widths = head.map((h, i) => Math.max(3, h.length, ...body.map(r => r[i].length)));
  const pad = (t, w, a) => (a === 'right' ? t.padStart(w) : a === 'center' ? t.padStart(Math.floor((w + t.length) / 2)).padEnd(w) : t.padEnd(w));
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

// ---------------------------------------------------------------- orchestration

/**
 * Full conversion. opts: delimiter ('auto' allowed), header, inferTypes, emptyAsNull, indent, jsonShape,
 * tableName, dialect, multiRow, mdAlign.
 * Returns { output, table, warnings, ext, mime }.
 */
export function convert(input, from, to, opts = {}) {
  if (!PAIRS[from]?.includes(to)) throw new ConvertError(`Converting ${from} to ${to} is not supported.`);
  if (!String(input ?? '').trim()) throw new ConvertError('Input is empty.');
  const header = opts.header !== false;
  let table;
  if (from === 'json') table = parseJson(input, { header });
  else if (from === 'csv') {
    const d = opts.delimiter === 'auto' ? detectDelimiter(input) : resolveDelimiter(opts.delimiter);
    table = parseCsv(input, { delimiter: d, header });
  } else table = parseMarkdown(input);

  if (from !== 'json' && opts.inferTypes) table = inferTypes(table);
  if (opts.emptyAsNull && (to === 'json' || to === 'sql')) {
    table = { ...table, rows: table.rows.map(r => r.map(v => (v === '' ? null : v))) };
  }

  let output;
  switch (to) {
    case 'csv': output = toCsv(table, { delimiter: resolveDelimiter(opts.delimiter === 'auto' ? 'comma' : opts.delimiter), header }); break;
    case 'json': output = toJson(table, { indent: opts.indent ?? '  ', shape: opts.jsonShape }); break;
    case 'markdown': output = toMarkdown(table, { align: opts.mdAlign || 'auto' }); break;
    case 'sql': output = toSql(table, opts); break;
  }
  return { output, table, warnings: table.warnings || [], ext: FORMATS[to].ext, mime: FORMATS[to].mime };
}
