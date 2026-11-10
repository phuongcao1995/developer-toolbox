// Run: node tests/unit/excel-fill.test.mjs   (from the project root)
// Tests the Sheet Editor's autofill rules and Workbook.fillRange (plain browser scripts, loaded as side-effect modules).
import assert from 'node:assert/strict';
import '../../tools/excel-editor/js/utils.js';
import '../../tools/excel-editor/js/formula.js';
import '../../tools/excel-editor/js/fill.js';
import '../../tools/excel-editor/js/spreadsheet.js';

const { fill: Fill, utils: U } = globalThis.SheetApp;
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const num = (v, style = null) => ({ value: v, formula: null, style });
const txt = (v) => ({ value: v, formula: null, style: null });
const values = (plan) => plan.map((p) => (p.value === undefined ? `#${p.from}` : p.value));

test('numbers: two cells continue the trend, a single number is copied', () => {
  assert.deepEqual(values(Fill.plan([num(1), num(2)], 3)), [3, 4, 5]);
  assert.deepEqual(values(Fill.plan([num(10), num(20), num(30)], 2)), [40, 50]);
  assert.deepEqual(values(Fill.plan([num(5), num(3)], 3)), [1, -1, -3]);
  assert.deepEqual(values(Fill.plan([num(0.1), num(0.2)], 2)), [0.30000000000000004 && 0.3, 0.4]);
  assert.deepEqual(values(Fill.plan([num(7)], 3)), ['#0', '#0', '#0']);
});
test('numbers filled upwards or to the left run backwards', () => {
  assert.deepEqual(values(Fill.plan([num(5), num(6)], 3, { reverse: true })), [4, 3, 2]);
  assert.deepEqual(values(Fill.plan([num(10)], 2, { reverse: true })), ['#0', '#0']);
});
test('a single date adds one day per step; its format comes from the source cell', () => {
  const date = num(45000, { numFmt: 'yyyy-mm-dd' });
  assert.deepEqual(values(Fill.plan([date], 3)), [45001, 45002, 45003]);
  assert.deepEqual(values(Fill.plan([date], 2, { reverse: true })), [44999, 44998]);
  assert.deepEqual(Fill.plan([date], 1)[0].from, 0);
});
test('text ending in a number counts up', () => {
  assert.deepEqual(values(Fill.plan([txt('Item 1')], 3)), ['Item 2', 'Item 3', 'Item 4']);
  assert.deepEqual(values(Fill.plan([txt('Thứ 2')], 2)), ['Thứ 3', 'Thứ 4']);
  assert.deepEqual(values(Fill.plan([txt('Q1-2024'), txt('Q2-2024')], 1)).length, 1); // different shape: falls back to repeating
  assert.deepEqual(values(Fill.plan([txt('A10'), txt('A12')], 2)), ['A14', 'A16']);
  assert.deepEqual(values(Fill.plan([txt('007')], 2)), ['008', '009']);
  assert.deepEqual(values(Fill.plan([txt('Row 3')], 2, { reverse: true })), ['Row 2', 'Row 1']);
  assert.deepEqual(values(Fill.plan([txt('Row 1')], 2, { reverse: true })), ['Row 0', 'Row 1']); // never counts below zero
});
test('weekday and month names continue the cycle and keep their case', () => {
  assert.deepEqual(values(Fill.plan([txt('Mon')], 3)), ['Tue', 'Wed', 'Thu']);
  assert.deepEqual(values(Fill.plan([txt('Saturday')], 3)), ['Sunday', 'Monday', 'Tuesday']);
  assert.deepEqual(values(Fill.plan([txt('Nov')], 3)), ['Dec', 'Jan', 'Feb']);
  assert.deepEqual(values(Fill.plan([txt('JAN')], 2)), ['FEB', 'MAR']);
  assert.deepEqual(values(Fill.plan([txt('jan')], 2, { reverse: true })), ['dec', 'nov']);
  assert.deepEqual(values(Fill.plan([txt('Jan'), txt('Mar')], 3)), ['May', 'Jul', 'Sep']);
});
test('anything else repeats the selected cells', () => {
  assert.deepEqual(values(Fill.plan([txt('a'), num(1)], 5)), ['#0', '#1', '#0', '#1', '#0']);
  assert.deepEqual(values(Fill.plan([{ value: null, formula: 'A1+1', style: null }], 2)), ['#0', '#0']);
  assert.deepEqual(values(Fill.plan([txt('x'), txt('y'), txt('z')], 2, { reverse: true })), ['#2', '#1']);
  assert.deepEqual(values(Fill.plan([num(1), num(2)], 3, { copyOnly: true })), ['#0', '#1', '#0']);
  assert.deepEqual(Fill.plan([], 3), []); assert.deepEqual(Fill.plan([num(1)], 0), []);
});

// ---- Workbook.fillRange
const { Workbook } = globalThis.SheetApp.spreadsheet;
const setup = (rows) => {
  const wb = Workbook.createBlank();
  rows.forEach((r, i) => r.forEach((t, j) => { if (t !== null) wb.setCellInput(0, i, j, t); }));
  return wb;
};
const display = (wb, r, c) => wb.getDisplay(0, r, c).text;
const col = (wb, c, from, to) => Array.from({ length: to - from + 1 }, (_, i) => display(wb, from + i, c));

test('Workbook.fillRange: series down and up', () => {
  const wb = setup([['1'], ['2']]);
  const range = wb.fillRange(0, { r1: 0, c1: 0, r2: 1, c2: 0 }, 'down', 3);
  assert.deepEqual(range, { r1: 0, r2: 4, c1: 0, c2: 0 });
  assert.deepEqual(col(wb, 0, 0, 5), ['1', '2', '3', '4', '5', '']);
  const wb2 = setup([[null], [null], ['10'], ['20']]);
  wb2.fillRange(0, { r1: 2, c1: 0, r2: 3, c2: 0 }, 'up', 2);
  assert.deepEqual(col(wb2, 0, 0, 3), ['-10', '0', '10', '20']);
});
test('Workbook.fillRange: formulas shift their relative references', () => {
  const wb = setup([['1', '10', '=A1+B1'], ['2', '20', null], ['3', '30', null]]);
  wb.fillRange(0, { r1: 0, c1: 2, r2: 0, c2: 2 }, 'down', 2);
  assert.deepEqual(col(wb, 2, 0, 2), ['11', '22', '33']);
  assert.equal(wb.getInputText(0, 2, 2), '=A3+B3');
});
test('Workbook.fillRange: absolute references stay fixed, and right/left work on rows', () => {
  const wb = setup([['5', '=$A$1*2', null, null]]);
  wb.fillRange(0, { r1: 0, c1: 1, r2: 0, c2: 1 }, 'right', 2);
  assert.equal(wb.getInputText(0, 0, 3), '=$A$1*2');
  const wb2 = setup([[null, null, 'Mon', 'Tue']]);
  wb2.fillRange(0, { r1: 0, c1: 2, r2: 0, c2: 3 }, 'left', 2);
  assert.deepEqual([0, 1, 2, 3].map((c) => display(wb2, 0, c)), ['Sat', 'Sun', 'Mon', 'Tue']);
});
test('Workbook.fillRange: several columns fill independently; copyOnly repeats; one undo step', () => {
  const wb = setup([['1', 'a'], ['2', 'b']]);
  wb.fillRange(0, { r1: 0, c1: 0, r2: 1, c2: 1 }, 'down', 2, { copyOnly: true });
  assert.deepEqual(col(wb, 0, 0, 3), ['1', '2', '1', '2']); assert.deepEqual(col(wb, 1, 0, 3), ['a', 'b', 'a', 'b']);
  wb.undo();
  assert.deepEqual(col(wb, 0, 0, 3), ['1', '2', '', '']);
});
test('Workbook.fillRange: stays inside the sheet', () => {
  const wb = setup([['1'], ['2']]);
  assert.equal(wb.fillRange(0, { r1: 0, c1: 0, r2: 1, c2: 0 }, 'up', 3), null);
  const last = U.MAX_ROWS - 1;
  const r = wb.fillRange(0, { r1: last - 1, c1: 0, r2: last, c2: 0 }, 'down', 5);
  assert.equal(r, null);
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} — ${passed} tests passed`);
