// Test Case Manager: reading and writing CSV / JSON / XLSX. No DOM and no storage.
// The SheetJS library is passed in (`XLSX`) so this module loads in Node for tests and only fetches SheetJS in the browser on demand.
import { parseCsvRows, detectDelimiter, toCsv } from '../table-converter/logic.js';
import { FIELDS, stepsToText } from './logic.js';

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50000;
export const FORMATS = { xlsx: 'Excel (.xlsx)', csv: 'CSV (.csv)', json: 'JSON (.json)' };
export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
};

export class ImportError extends Error {}

export const fileExtension = name => (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';

// ------------------------------------------------------------------ parsing

const text = v => String(v ?? '').trim();
const isBlankRow = cells => cells.every(c => c === '' || c == null || (typeof c === 'string' && !c.trim()) || (Array.isArray(c) && !c.length));

function tableFrom(format, headerRow, dataRows, rowNumbers, extra = {}) {
  const keep = [];
  dataRows.forEach((cells, i) => { if (!isBlankRow(cells)) keep.push(i); });
  if (keep.length > MAX_IMPORT_ROWS) throw new ImportError(`This file has ${keep.length.toLocaleString('en')} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString('en')}. Split it into smaller files.`);
  return {
    format, headers: headerRow.map(text), rows: keep.map(i => dataRows[i]), rowNumbers: keep.map(i => rowNumbers[i]),
    unit: 'Row', ...extra,
  };
}

export function parseCsvFile(source) {
  let parsed;
  try { parsed = parseCsvRows(source, detectDelimiter(source)); }
  catch (e) { throw new ImportError(`Could not read the CSV${e.line ? ` (line ${e.line}${e.column ? `, column ${e.column}` : ''})` : ''}: ${e.message}`); }
  if (!parsed.rows.length) throw new ImportError('The CSV file is empty.');
  return tableFrom('csv', parsed.rows[0], parsed.rows.slice(1), parsed.lines.slice(1));
}

/** Accepts [ {...}, ... ] or { testCases | test_cases | cases | tests | data: [ ... ] }. */
export function parseJsonFile(source) {
  let data;
  try { data = JSON.parse(source.replace(/^﻿/, '')); }
  catch (e) { throw new ImportError(`Invalid JSON: ${e.message}`); }
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const key = ['testCases', 'test_cases', 'testcases', 'cases', 'tests', 'data'].find(k => Array.isArray(data[k]));
    if (key) data = data[key];
  }
  if (!Array.isArray(data)) throw new ImportError('Expected a JSON array of test cases (or an object with a "testCases" array).');
  if (!data.length) throw new ImportError('The JSON file contains no test cases.');
  const headers = [];
  const seen = new Set();
  data.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ImportError(`Item ${i + 1} is not an object.`);
    for (const k of Object.keys(item)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  });
  const rows = data.map(item => headers.map(h => item[h]));
  return tableFrom('json', headers, rows, data.map((_, i) => i + 1), { unit: 'Item' });
}

export function parseXlsxFile(buffer, XLSX) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw new ImportError('This is not a valid .xlsx file (an Excel workbook is a ZIP archive). Old .xls files are not supported; re-save it as .xlsx.');
  let wb;
  try { wb = XLSX.read(new Uint8Array(buffer), { type: 'array' }); }
  catch (e) { throw new ImportError(`Could not read the Excel file: ${e.message}`); }
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const start = XLSX.utils.decode_range(ws['!ref']).s.r;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
    const h = aoa.findIndex(r => !isBlankRow(r));
    if (h < 0) continue;
    const data = aoa.slice(h + 1);
    return tableFrom('xlsx', aoa[h], data, data.map((_, i) => start + h + i + 2), { sheetName: name });
  }
  throw new ImportError('The workbook has no data.');
}

/** Parse an uploaded file. `content` is text for csv/json and an ArrayBuffer for xlsx. */
export function parseImport(fileName, content, XLSX) {
  const ext = fileExtension(fileName);
  if (ext === 'csv') return parseCsvFile(content);
  if (ext === 'json') return parseJsonFile(content);
  if (ext === 'xlsx') return parseXlsxFile(content, XLSX);
  throw new ImportError(`Unsupported file type ".${ext || '?'}". Use .xlsx, .csv or .json.`);
}

// ------------------------------------------------------------------ serialising

export const EXPORT_COLUMNS = FIELDS.map(f => f.label);

/** Cases as a rectangular table with readable column names; steps become numbered lines. */
export function toTable(cases) {
  return {
    columns: EXPORT_COLUMNS,
    rows: cases.map(c => FIELDS.map(f => (f.key === 'steps' ? stepsToText(c.steps) : c[f.key] ?? ''))),
  };
}

/** UTF-8 CSV with a BOM (so Excel opens it correctly) and CRLF line ends. Cells starting with = + - @ get a leading ' (CSV-injection guard). */
export const toCsvFile = cases => '﻿' + toCsv(toTable(cases), { eol: '\r\n', escapeFormulas: true });

const EXPORT_KEYS = FIELDS.map(f => f.key);
/** JSON export keeps steps as a real array. */
export function toJsonFile(cases, now = new Date()) {
  return JSON.stringify({
    format: 'test-cases', version: 1, exportedAt: now.toISOString(), count: cases.length,
    testCases: cases.map(c => ({ ...Object.fromEntries(EXPORT_KEYS.map(k => [k, c[k]])), createdAt: c.createdAt, updatedAt: c.updatedAt })),
  }, null, 2);
}

/** Excel workbook as a Uint8Array. Values are written as text cells, so nothing is ever evaluated as a formula. */
export function toXlsxFile(cases, XLSX) {
  const { columns, rows } = toTable(cases);
  const ws = XLSX.utils.aoa_to_sheet([columns, ...rows.map(r => r.map(v => String(v)))]);
  const widths = { id: 14, title: 36, description: 40, preconditions: 32, steps: 48, expected: 40, actual: 32, status: 11, priority: 10, testData: 24, notes: 28 };
  ws['!cols'] = FIELDS.map(f => ({ wch: widths[f.key] || 20 }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Test Cases');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

/** "test-cases_20261109-142530.csv" (local time). */
export function exportFileName(ext, d = new Date(), base = 'test-cases') {
  const p = n => String(n).padStart(2, '0');
  return `${base}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/** Serialise for download: returns { name, mime, data } where data is a string or Uint8Array. */
export function buildExport(format, cases, { XLSX, now = new Date(), base } = {}) {
  const name = exportFileName(format, now, base);
  if (format === 'csv') return { name, mime: MIME.csv, data: toCsvFile(cases) };
  if (format === 'json') return { name, mime: MIME.json, data: toJsonFile(cases, now) };
  if (format === 'xlsx') return { name, mime: MIME.xlsx, data: toXlsxFile(cases, XLSX) };
  throw new Error(`Unknown export format "${format}"`);
}

// ------------------------------------------------------------------ sample template

export const SAMPLE_CASES = [
  { id: 'TC-001', title: 'Login with valid credentials', description: 'A registered user can sign in.', preconditions: 'User account exists and is active.',
    steps: ['Open the login page', 'Enter a valid e-mail and password', 'Click "Sign in"'], expected: 'The user lands on the dashboard.',
    actual: '', status: 'Not Run', priority: 'High', testData: 'user@example.com / Passw0rd!', notes: '' },
  { id: 'TC-002', title: 'Login with a wrong password', description: 'Sign-in is refused and no account details leak.', preconditions: 'User account exists.',
    steps: ['Open the login page', 'Enter a valid e-mail and a wrong password', 'Click "Sign in"'], expected: 'An "Invalid credentials" message is shown.',
    actual: 'Invalid credentials message shown.', status: 'Pass', priority: 'Medium', testData: '', notes: 'Covers the lock-out rule too.' },
  { id: 'TC-003', title: 'Reset password by e-mail', description: '', preconditions: '',
    steps: ['Click "Forgot password"', 'Enter the account e-mail', 'Open the e-mail and follow the link'], expected: 'A new password can be set.',
    actual: '', status: 'Blocked', priority: 'Low', testData: '', notes: 'Blocked until the mail server is back.' },
];
