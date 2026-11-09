// Run: node tests/unit/test-case-manager.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as L from '../../tools/test-case-manager/logic.js';
import * as IO from '../../tools/test-case-manager/io.js';
import { createMemoryStore, openStore } from '../../tools/test-case-manager/store.js';

const XLSX = createRequire(import.meta.url)('../../assets/js/vendor/xlsx.full.min.js');
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error('FAIL', name, '\n  ', e.stack.split('\n').slice(0, 3).join('\n   ')); process.exitCode = 1; } };
const mk = (o = {}) => L.makeCase({ id: 'TC-001', title: 'T', ...o }, '2026-01-01T00:00:00.000Z');
const NOW = '2026-02-02T00:00:00.000Z';

// ---------------------------------------------------------------- model
await test('makeCase fills defaults and trims', () => {
  const c = L.makeCase({ title: '  Hello  ' });
  assert.equal(c.title, 'Hello'); assert.equal(c.status, 'Not Run'); assert.equal(c.priority, 'Medium'); assert.deepEqual(c.steps, []);
});
await test('status and priority are matched case-insensitively, with synonyms', () => {
  assert.equal(L.normalizeStatus('PASS'), 'Pass'); assert.equal(L.normalizeStatus('passed'), 'Pass');
  assert.equal(L.normalizeStatus('not run'), 'Not Run'); assert.equal(L.normalizeStatus('Not-Run'), 'Not Run'); assert.equal(L.normalizeStatus('FAILED'), 'Fail');
  assert.equal(L.normalizeStatus(''), 'Not Run'); assert.equal(L.normalizeStatus('maybe'), null);
  assert.equal(L.normalizePriority('critical'), 'Critical'); assert.equal(L.normalizePriority(' high '), 'High'); assert.equal(L.normalizePriority('urgent'), null);
});
await test('validateCase', () => {
  assert.deepEqual(L.validateCase(mk()), []);
  assert.equal(L.validateCase(mk({ title: ' ' }))[0].field, 'title');
  assert.equal(L.validateCase(mk({ id: '' }))[0].field, 'id');
  assert.equal(L.validateCase({ ...mk(), status: 'Weird' })[0].field, 'status');
  assert.equal(L.validateCase({ ...mk(), priority: 'Weird' })[0].field, 'priority');
  assert.equal(L.validateCase(mk({ id: 'x'.repeat(65) }))[0].field, 'id');
  assert.equal(L.validateCase(mk({ id: 'a\u0001b' }))[0].field, 'id');
  assert.equal(L.validateCase(mk({ notes: 'x'.repeat(L.MAX_FIELD_LENGTH + 1) }))[0].field, 'notes');
});
await test('validateCase flags a duplicate ID case-insensitively, but only among others', () => {
  assert.match(L.validateCase(mk({ id: 'tc-001' }), [mk()])[0].message, /already used/);
  assert.deepEqual(L.validateCase(mk({ id: 'TC-002' }), [mk()]), []);
});
await test('nextId', () => {
  assert.equal(L.nextId([]), 'TC-001');
  assert.equal(L.nextId(['TC-001', 'TC-009']), 'TC-010');
  assert.equal(L.nextId(['tc-5', 'LOGIN-1']), 'TC-006');
  assert.equal(L.nextId(['TC-999']), 'TC-1000');
  assert.equal(L.nextId(new Set(['tc-001'])), 'TC-002');
});
await test('duplicateCase', () => {
  const src = mk({ steps: ['a', 'b'], status: 'Fail', actual: 'boom', priority: 'High' });
  const d = L.duplicateCase(src, ['TC-001'], NOW);
  assert.equal(d.id, 'TC-002'); assert.equal(d.title, 'T (copy)'); assert.equal(d.status, 'Not Run'); assert.equal(d.actual, ''); assert.equal(d.priority, 'High');
  assert.deepEqual(d.steps, ['a', 'b']); d.steps.push('c'); assert.equal(src.steps.length, 2);
});

// ---------------------------------------------------------------- steps
await test('steps round-trip through text', () => {
  const steps = ['Open page', 'Type "a, b"\nthen press Enter', 'Check result'];
  assert.deepEqual(L.parseSteps(L.stepsToText(steps)), steps);
  assert.equal(L.stepsToText(['a', 'b']), '1. a\n2. b');
});
await test('parseSteps accepts several shapes', () => {
  assert.deepEqual(L.parseSteps('1) one\r\n2) two'), ['one', 'two']);
  assert.deepEqual(L.parseSteps('one\ntwo\n\nthree'), ['one', 'two', 'three']);
  assert.deepEqual(L.parseSteps(['a', ' ', { action: 'b' }, { step: 'c' }, 4]), ['a', 'b', 'c', '4']);
  assert.deepEqual(L.parseSteps(''), []); assert.deepEqual(L.parseSteps(null), []);
});

// ---------------------------------------------------------------- filter / sort
const list = [
  mk({ id: 'TC-10', title: 'banana', priority: 'Low', status: 'Pass' }),
  mk({ id: 'TC-2', title: 'Apple', priority: 'Critical', status: 'Fail', notes: 'checkout bug' }),
  mk({ id: 'TC-1', title: 'cherry', priority: 'High', status: 'Not Run', steps: ['Open the cart'] }),
];
await test('filterCases', () => {
  assert.deepEqual(L.filterCases(list, { q: 'APPLE' }).map(c => c.id), ['TC-2']);
  assert.deepEqual(L.filterCases(list, { q: 'cart' }).map(c => c.id), ['TC-1']);
  assert.deepEqual(L.filterCases(list, { q: 'checkout', status: 'Fail' }).map(c => c.id), ['TC-2']);
  assert.deepEqual(L.filterCases(list, { priority: 'Low' }).map(c => c.id), ['TC-10']);
  assert.equal(L.filterCases(list, { status: 'Blocked' }).length, 0);
  assert.equal(L.filterCases(list, {}).length, 3);
});
await test('sortCases', () => {
  const ids = o => L.sortCases(list, o).map(c => c.id);
  assert.deepEqual(ids({ key: 'id' }), ['TC-1', 'TC-2', 'TC-10']); // natural order, not "TC-10" before "TC-2"
  assert.deepEqual(ids({ key: 'id', dir: 'desc' }), ['TC-10', 'TC-2', 'TC-1']);
  assert.deepEqual(ids({ key: 'title' }), ['TC-2', 'TC-10', 'TC-1']);
  assert.deepEqual(ids({ key: 'priority' }), ['TC-2', 'TC-1', 'TC-10']); // Critical first
  assert.deepEqual(ids({ key: 'status' }), ['TC-1', 'TC-10', 'TC-2']);
  assert.equal(list[0].id, 'TC-10'); // input untouched
});

// ---------------------------------------------------------------- mapping
await test('autoMap recognises common header names', () => {
  const m = L.autoMap(['Test Case ID', 'Summary', 'Pre-conditions', 'Steps', 'Expected Result', 'Result', 'Severity', 'Comments', 'Junk']);
  assert.equal(m.id, 0); assert.equal(m.title, 1); assert.equal(m.preconditions, 2); assert.equal(m.steps, 3); assert.equal(m.expected, 4);
  assert.equal(m.status, 5); assert.equal(m.priority, 6); assert.equal(m.notes, 7); assert.equal(m.description, -1); assert.equal(m.actual, -1);
});
await test('autoMap uses each column once and prefers exact export labels', () => {
  const m = L.autoMap(['Title', 'Name', 'Test Steps', 'Steps']);
  assert.equal(m.title, 0); assert.equal(m.steps, 2);
  assert.equal(L.autoMap(['x', 'y']).title, -1);
  assert.equal(L.autoMap(['testCaseId', 'expected_results', 'TEST DATA']).testData, 2);
});

// ---------------------------------------------------------------- records and validation
const H = ['ID', 'Title', 'Status', 'Priority', 'Steps'];
const rec = (rows, nums) => L.buildRecords(H, rows, nums || rows.map((_, i) => i + 2), L.autoMap(H), NOW);
await test('buildRecords: valid row', () => {
  const [r] = rec([['TC-7', 'Login', 'passed', 'high', '1. open\n2. type']]);
  assert.deepEqual(r.errors, []); assert.equal(r.case.status, 'Pass'); assert.equal(r.case.priority, 'High'); assert.deepEqual(r.case.steps, ['open', 'type']); assert.equal(r.hasId, true);
});
await test('buildRecords: errors carry row and column name', () => {
  const rs = rec([['A', '', 'Done', 'Urgent', ''], ['B', 'ok', '', '', '']], [5, 9]);
  assert.equal(rs[0].row, 5);
  assert.deepEqual(rs[0].errors.map(e => [e.field, e.column]).sort(), [['priority', 'Priority'], ['status', 'Status'], ['title', 'Title']]);
  assert.match(rs[0].errors.find(e => e.field === 'priority').message, /Urgent/);
  assert.equal(rs[1].errors.length, 0); assert.equal(rs[1].row, 9);
});
await test('buildRecords: blank rows dropped; missing ID is allowed (auto)', () => {
  const rs = rec([['', '', '', '', ''], [' ', '', '', '', ''], ['', 'No id', '', '', '']]);
  assert.equal(rs.length, 1); assert.equal(rs[0].hasId, false); assert.deepEqual(rs[0].errors, []);
});
await test('buildRecords: unmapped title column is reported per row', () => {
  const headers = ['ID', 'Foo'];
  const [r] = L.buildRecords(headers, [['1', 'x']], [2], L.autoMap(headers), NOW);
  assert.equal(r.errors[0].field, 'title'); assert.equal(r.errors[0].column, 'Title');
});
await test('buildRecords: numbers, dates, booleans and the export escape', () => {
  const headers = ['id', 'title', 'notes'];
  const [r] = L.buildRecords(headers, [[42, "'=SUM(A1)", true]], [2], L.autoMap(headers), NOW);
  assert.equal(r.case.id, '42'); assert.equal(r.case.title, '=SUM(A1)'); assert.equal(r.case.notes, 'true');
});

// ---------------------------------------------------------------- duplicates and planning
const stored = [mk({ id: 'TC-001', title: 'old 1', createdAt: '2020-01-01T00:00:00.000Z' }), mk({ id: 'TC-002', title: 'old 2' })];
const recs = rows => rec(rows);
await test('markDuplicates: existing and in-file, case-insensitive, invalid ignored', () => {
  const rs = L.markDuplicates(recs([['tc-001', 'a', '', '', ''], ['TC-050', 'b', '', '', ''], ['tc-050', 'c', '', '', ''], ['TC-001', '', '', '', ''], ['', 'no id', '', '', '']]), stored);
  assert.deepEqual(rs.map(r => r.dup), ['existing', null, 'file', null, null]);
});
await test('planImport skip', () => {
  const p = L.planImport(recs([['TC-001', 'dup', '', '', ''], ['TC-003', 'new', '', '', ''], ['TC-003', 'again', '', '', ''], ['', '', '', 'Urgent', '']]), stored, 'skip', NOW);
  assert.deepEqual(p.summary, { total: 4, added: 1, overwritten: 0, skipped: 2, failed: 1 });
  assert.deepEqual(p.put.map(c => c.id), ['TC-003']); assert.equal(p.put[0].title, 'new');
  assert.deepEqual(p.skippedRows, [2, 4]); assert.equal(p.failures[0].row, 5);
  assert.equal(stored.length, 2);
});
await test('planImport overwrite keeps stored ID spelling and createdAt', () => {
  const p = L.planImport(recs([['tc-001', 'updated', 'Pass', 'High', '']]), stored, 'overwrite', NOW);
  assert.deepEqual(p.summary, { total: 1, added: 0, overwritten: 1, skipped: 0, failed: 0 });
  assert.equal(p.put[0].id, 'TC-001'); assert.equal(p.put[0].title, 'updated'); assert.equal(p.put[0].createdAt, '2020-01-01T00:00:00.000Z'); assert.equal(p.put[0].updatedAt, NOW);
  const merged = L.applyPlan(stored, p.put);
  assert.equal(merged.length, 2); assert.equal(merged.find(c => c.id === 'TC-001').title, 'updated');
});
await test('planImport overwrite: a repeated ID in the file ends with the last row', () => {
  const p = L.planImport(recs([['TC-010', 'first', '', '', ''], ['TC-010', 'second', '', '', '']]), stored, 'overwrite', NOW);
  assert.equal(p.put.length, 1); assert.equal(p.put[0].title, 'second');
  assert.equal(p.summary.added + p.summary.overwritten, 2);
});
await test('planImport new: duplicates get fresh IDs that avoid every used ID', () => {
  const p = L.planImport(recs([['TC-001', 'dup', '', '', ''], ['TC-003', 'explicit later', '', '', ''], ['', 'blank id', '', '', '']]), stored, 'new', NOW);
  const ids = p.put.map(c => c.id);
  assert.equal(new Set(ids.map(L.idKey)).size, 3); assert.ok(!ids.slice(0, 1).includes('TC-001'));
  assert.ok(ids.includes('TC-003')); // explicit ID is kept
  assert.ok(!ids.filter(i => i !== 'TC-003').includes('TC-003'));
  assert.equal(p.summary.added, 3);
});
await test('planImport: summary always adds up', () => {
  const rows = [['TC-001', 'a', '', '', ''], ['', '', '', '', 'x'], ['TC-9', 'b', 'bad', '', ''], ['TC-9', 'c', '', '', ''], ['', 'd', '', '', '']];
  for (const mode of ['skip', 'overwrite', 'new']) {
    const { summary: s } = L.planImport(recs(rows), stored, mode, NOW);
    assert.equal(s.added + s.overwritten + s.skipped + s.failed, s.total, mode);
  }
});
await test('planImport of nothing', () => assert.deepEqual(L.planImport([], stored, 'skip', NOW).summary, { total: 0, added: 0, overwritten: 0, skipped: 0, failed: 0 }));

// ---------------------------------------------------------------- CSV
const sample = IO.SAMPLE_CASES.map(c => L.makeCase(c, NOW));
const tricky = [
  mk({ id: 'TC-1', title: 'Quotes "and", commas', description: 'line1\nline2', steps: ['a', 'multi\nline step'], notes: '  keep ' }),
  mk({ id: 'TC-2', title: '=HYPERLINK("x")', notes: '@cmd', testData: '-5 and +1', status: 'Blocked', priority: 'Critical' }),
  mk({ id: 'TC-3', title: 'Unicode ✓ 日本語 😀', expected: 'ünï' }),
];
const roundTrip = (format, cases) => {
  const out = IO.buildExport(format, cases, { XLSX, now: new Date(2026, 10, 9, 14, 25, 30) });
  const content = format === 'xlsx' ? out.data : typeof out.data === 'string' ? out.data : new TextDecoder().decode(out.data);
  const t = IO.parseImport(out.name, content, XLSX);
  const recs = L.buildRecords(t.headers, t.rows, t.rowNumbers, L.autoMap(t.headers), NOW);
  return { out, t, recs, cases: recs.map(r => r.case) };
};
const same = (a, b) => {
  const pick = c => Object.fromEntries(L.FIELDS.map(f => [f.key, c[f.key]]));
  assert.deepEqual(a.map(pick), b.map(pick));
};
for (const fmt of ['csv', 'json', 'xlsx']) {
  await test(`${fmt}: export then import preserves every field`, () => {
    const r = roundTrip(fmt, [...sample, ...tricky]);
    assert.deepEqual(r.recs.flatMap(x => x.errors), []);
    same(r.cases, [...sample, ...tricky]);
  });
  await test(`${fmt}: empty export imports as nothing`, () => {
    if (fmt === 'json') assert.throws(() => roundTrip(fmt, []), IO.ImportError);
    else assert.equal(roundTrip(fmt, []).recs.length, 0);
  });
}
await test('export file names carry a local timestamp', () => {
  assert.equal(IO.exportFileName('csv', new Date(2026, 10, 9, 4, 5, 6)), 'test-cases_20261109-040506.csv');
  assert.equal(IO.exportFileName('json', new Date(2026, 0, 2, 13, 14, 15), 'x'), 'x_20260102-131415.json');
});
await test('csv export: BOM, CRLF, readable header, formula guard', () => {
  const s = IO.toCsvFile(tricky);
  assert.ok(s.startsWith('﻿Test Case ID,Title,Description,Preconditions,Test Steps,Expected Results,Actual Results,Status,Priority,Test Data,Notes\r\n'));
  assert.ok(s.includes("'=HYPERLINK"));
  assert.ok(s.includes("'@cmd"));
  assert.ok(!s.includes(",-5 and") || s.includes("'-5 and"));
});
await test('json export structure', () => {
  const j = JSON.parse(IO.toJsonFile(sample, new Date('2026-11-09T00:00:00Z')));
  assert.equal(j.format, 'test-cases'); assert.equal(j.version, 1); assert.equal(j.count, 3); assert.equal(j.exportedAt, '2026-11-09T00:00:00.000Z');
  assert.deepEqual(j.testCases[0].steps, ['Open the login page', 'Enter a valid e-mail and password', 'Click "Sign in"']);
});

await test('xlsx export never writes formula cells', () => {
  const wb = XLSX.read(new Uint8Array(IO.toXlsxFile(tricky, XLSX)), { type: 'array' });
  const ws = wb.Sheets['Test Cases'];
  for (const [addr, cell] of Object.entries(ws)) if (!addr.startsWith('!')) { assert.equal(cell.f, undefined, addr); assert.equal(cell.t, 's', addr); }
  assert.equal(ws.B3.v, '=HYPERLINK("x")');
});

// ---------------------------------------------------------------- CSV parsing details
await test('csv import: BOM, semicolons, CRLF, quoted newlines, line numbers', () => {
  const t = IO.parseImport('a.csv', '﻿ID;Title;Test Steps\r\nTC-1;"Two\nlines";"1. a\n2. b"\r\n\r\nTC-2;Plain;\r\n');
  assert.deepEqual(t.headers, ['ID', 'Title', 'Test Steps']);
  assert.equal(t.rows.length, 2); assert.deepEqual(t.rowNumbers, [2, 6]); assert.equal(t.rows[0][1], 'Two\nlines'); assert.equal(t.unit, 'Row');
});
await test('csv import: errors are readable', () => {
  assert.throws(() => IO.parseImport('a.csv', ''), /empty/);
  assert.throws(() => IO.parseImport('a.csv', 'ID,Title\n1,"unterminated'), e => e instanceof IO.ImportError && /line/i.test(e.message));
});
await test('csv import: header-only file has no rows', () => assert.equal(IO.parseImport('a.csv', 'ID,Title\n').rows.length, 0));
await test('csv import: ragged rows', () => {
  const t = IO.parseImport('a.csv', 'ID,Title,Status\nTC-1,Short\nTC-2,Long,Pass,extra\n');
  const rs = L.buildRecords(t.headers, t.rows, t.rowNumbers, L.autoMap(t.headers), NOW);
  assert.equal(rs.length, 2); assert.equal(rs[0].case.status, 'Not Run'); assert.equal(rs[1].case.status, 'Pass');
});

// ---------------------------------------------------------------- JSON parsing details
await test('json import: array, wrapper object, camelCase and spaced keys, array steps', () => {
  const t = IO.parseImport('a.json', JSON.stringify({ testCases: [{ 'Test Case ID': 'A', title: 'x', testData: 'd', steps: ['one', 'two'], status: 'fail' }, { 'Test Case ID': 'B', title: 'y', expectedResult: 'ok' }] }));
  assert.equal(t.unit, 'Item'); assert.deepEqual(t.rowNumbers, [1, 2]);
  const rs = L.buildRecords(t.headers, t.rows, t.rowNumbers, L.autoMap(t.headers), NOW);
  assert.deepEqual(rs.map(r => r.case.id), ['A', 'B']); assert.deepEqual(rs[0].case.steps, ['one', 'two']);
  assert.equal(rs[0].case.testData, 'd'); assert.equal(rs[0].case.status, 'Fail'); assert.equal(rs[1].case.expected, 'ok');
});
await test('json import: bad input', () => {
  assert.throws(() => IO.parseImport('a.json', '{oops'), /Invalid JSON/);
  assert.throws(() => IO.parseImport('a.json', '{"a":1}'), /array/);
  assert.throws(() => IO.parseImport('a.json', '[]'), /no test cases/);
  assert.throws(() => IO.parseImport('a.json', '[{"title":"x"}, 3]'), /Item 2/);
  assert.doesNotThrow(() => IO.parseImport('a.json', '﻿[{"title":"x"}]'));
});
await test('import: unsupported extension', () => assert.throws(() => IO.parseImport('a.pdf', ''), /Unsupported/));

// ---------------------------------------------------------------- XLSX parsing details
await test('xlsx import: finds the header row below blank rows and reports real sheet rows', () => {
  const ws = XLSX.utils.aoa_to_sheet([[], [], ['ID', 'Title', 'Priority'], ['TC-1', 'First', 'High'], [], ['TC-2', 'Second', 'low']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cases');
  const t = IO.parseImport('a.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), XLSX);
  assert.deepEqual(t.headers, ['ID', 'Title', 'Priority']); assert.deepEqual(t.rowNumbers, [4, 6]); assert.equal(t.sheetName, 'Cases');
});
await test('xlsx import: numbers, booleans and an empty first sheet', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Empty');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'title', 'notes'], [101, 'Numeric id', true]]), 'Data');
  const t = IO.parseImport('a.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), XLSX);
  const [r] = L.buildRecords(t.headers, t.rows, t.rowNumbers, L.autoMap(t.headers), NOW);
  assert.equal(t.sheetName, 'Data'); assert.equal(r.case.id, '101');
});
await test('xlsx import: corrupt file and empty workbook', () => {
  assert.throws(() => IO.parseImport('a.xlsx', new TextEncoder().encode('not a zip').buffer, XLSX), IO.ImportError);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'S');
  assert.throws(() => IO.parseImport('a.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), XLSX), /no data/);
});

// ---------------------------------------------------------------- large import
await test('10,000-row CSV imports quickly and plans correctly', () => {
  const t0 = Date.now();
  const lines = ['ID,Title,Status,Priority,Steps'];
  for (let i = 1; i <= 10000; i++) lines.push(`TC-${String(i).padStart(3, '0')},Case ${i},${['Pass', 'Fail', 'Blocked', 'Not Run'][i % 4]},${['Low', 'Medium', 'High', 'Critical'][i % 4]},"1. a\n2. b"`);
  const t = IO.parseImport('big.csv', lines.join('\n'));
  const rs = L.buildRecords(t.headers, t.rows, t.rowNumbers, L.autoMap(t.headers), NOW);
  const p = L.planImport(rs, stored, 'skip', NOW);
  assert.equal(p.summary.total, 10000); assert.equal(p.summary.skipped, 2); assert.equal(p.summary.added, 9998);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
await test('row limit is enforced', () => {
  const lines = ['ID,Title']; for (let i = 0; i <= IO.MAX_IMPORT_ROWS; i++) lines.push(`${i},t`);
  assert.throws(() => IO.parseImport('big.csv', lines.join('\n')), /limit/);
});

// ---------------------------------------------------------------- store
await test('memory store: put, replace, remove, clear', async () => {
  const s = createMemoryStore();
  await s.apply({ put: [mk({ id: 'A' }), mk({ id: 'B' })] });
  await s.apply({ put: [mk({ id: 'A', title: 'changed' })], remove: ['B'] });
  const all = await s.all();
  assert.equal(all.length, 1); assert.equal(all[0].title, 'changed');
  all[0].title = 'mutated outside'; assert.equal((await s.all())[0].title, 'changed'); // returns copies
  await s.clear(); assert.equal((await s.all()).length, 0);
});
await test('openStore falls back to memory without IndexedDB or when it throws', async () => {
  assert.equal((await openStore(null)).persistent, false);
  assert.equal((await openStore({ open() { throw new Error('denied'); } })).persistent, false);
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} — ${passed} tests passed`);
