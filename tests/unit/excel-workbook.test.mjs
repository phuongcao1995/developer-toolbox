// Run: node tests/unit/excel-workbook.test.mjs   (from the project root)
// Tests Sheet Editor workbook operations: hide/show, paste special, format painter, tab colour, quick date/time.
import assert from 'node:assert/strict';
import '../../tools/excel-editor/js/utils.js';
import '../../tools/excel-editor/js/formula.js';
import '../../tools/excel-editor/js/fill.js';
import '../../tools/excel-editor/js/spreadsheet.js';

const { Workbook } = globalThis.SheetApp.spreadsheet;
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const setup = (rows) => {
  const wb = Workbook.createBlank();
  rows.forEach((r, i) => r.forEach((t, j) => { if (t !== null) wb.setCellInput(0, i, j, t); }));
  return wb;
};
const shown = (wb, r, c) => wb.getDisplay(0, r, c).text;
const bold = { font: { bold: true } };

test('hide and show columns and rows, with undo', () => {
  const wb = setup([['a', 'b', 'c']]);
  const sheet = wb.sheets[0];
  assert.equal(wb.setHidden(0, 'col', [1], true), 1);
  assert.ok(sheet.hiddenCols.has(1));
  assert.equal(wb.setHidden(0, 'col', [1], true), 0); // already hidden: no new undo step
  wb.undo();
  assert.ok(!wb.sheets[0].hiddenCols.has(1));
  wb.redo();
  assert.ok(wb.sheets[0].hiddenCols.has(1));
  assert.equal(wb.setHidden(0, 'col', [0, 1, 2], false), 1);
  assert.equal(wb.setHidden(0, 'row', [3, 4], true), 2);
  assert.deepEqual([...wb.sheets[0].hiddenRows], [3, 4]);
});
test('hidden columns move with inserted and deleted columns', () => {
  const wb = setup([['a', 'b', 'c', 'd']]);
  wb.setHidden(0, 'col', [2], true);
  wb.insertCols(0, 0, 1);
  assert.deepEqual([...wb.sheets[0].hiddenCols], [3]);
  wb.deleteCols(0, 0, 2);
  assert.deepEqual([...wb.sheets[0].hiddenCols], [1]);
  wb.deleteCols(0, 1, 1); // deleting the hidden column removes it from the set
  assert.deepEqual([...wb.sheets[0].hiddenCols], []);
});
test('hidden columns survive cloning (sheet duplicate)', () => {
  const wb = setup([['a']]);
  wb.setHidden(0, 'col', [4], true);
  wb.duplicateSheet(0);
  assert.deepEqual([...wb.sheets[1].hiddenCols], [4]);
});

const clip = (wb, r1, c1, r2, c2) => wb.copyRange(0, { r1, c1, r2, c2 });
test('paste special: values only turns formulas into results and keeps the target format', () => {
  const wb = setup([['2', '=A1*10', null, 'x']]);
  wb.updateStyle(0, [{ r1: 0, c1: 3, r2: 0, c2: 3 }], (s) => { s.font = { bold: true }; }, 'bold');
  wb.pasteSpecial(0, 0, 3, clip(wb, 0, 1, 0, 1), 'values');
  assert.equal(wb.getInputText(0, 0, 3), '20');
  assert.deepEqual(wb.sheets[0].getCell(0, 3).style.font, { bold: true });
});
test('paste special: formulas only shifts references and ignores the source format', () => {
  const wb = setup([['1', '=A1+1'], ['5', null]]);
  wb.updateStyle(0, [{ r1: 0, c1: 1, r2: 0, c2: 1 }], (s) => { s.font = { bold: true }; }, 'bold');
  wb.pasteSpecial(0, 1, 1, clip(wb, 0, 1, 0, 1), 'formulas');
  assert.equal(wb.getInputText(0, 1, 1), '=A2+1'); assert.equal(shown(wb, 1, 1), '6');
  assert.equal(wb.sheets[0].getCell(1, 1).style, null);
});
test('paste special: formats only leaves values alone', () => {
  const wb = setup([['1', 'keep']]);
  wb.updateStyle(0, [{ r1: 0, c1: 0, r2: 0, c2: 0 }], (s) => { s.font = { italic: true }; }, 'it');
  wb.pasteSpecial(0, 0, 1, clip(wb, 0, 0, 0, 0), 'formats');
  assert.equal(shown(wb, 0, 1), 'keep'); assert.deepEqual(wb.sheets[0].getCell(0, 1).style.font, { italic: true });
});
test('paste special: transpose swaps rows and columns (formulas become results)', () => {
  const wb = setup([['1', '2', '3'], ['4', '5', '=B2*2']]);
  const size = wb.pasteSpecial(0, 5, 0, clip(wb, 0, 0, 1, 2), 'transpose');
  assert.deepEqual(size, { rows: 3, cols: 2 });
  assert.deepEqual([5, 6, 7].map((r) => [shown(wb, r, 0), shown(wb, r, 1)]), [['1', '4'], ['2', '5'], ['3', '10']]);
  assert.equal(wb.getInputText(0, 7, 1), '10');
});
test('paste special is one undo step', () => {
  const wb = setup([['1', '2']]);
  wb.pasteSpecial(0, 3, 0, clip(wb, 0, 0, 0, 1), 'values');
  wb.undo();
  assert.equal(shown(wb, 3, 0), '');
});
test('format painter: applyFormat copies a style onto a range and creates cells', () => {
  const wb = setup([['x']]);
  assert.equal(wb.applyFormat(0, { r1: 2, c1: 0, r2: 3, c2: 1 }, bold), true);
  assert.deepEqual(wb.sheets[0].getCell(3, 1).style, bold);
  wb.undo();
  assert.equal(wb.sheets[0].getCell(3, 1), null);
  assert.equal(wb.applyFormat(0, { r1: 0, c1: 0, r2: 999999, c2: 9 }, bold), false); // too large
});
test('tab colour can be set, cleared and undone', () => {
  const wb = setup([['x']]);
  wb.setTabColor(0, '#ff8800');
  assert.deepEqual(wb.sheets[0].extras.tabColor, { argb: 'FFFF8800' });
  wb.setTabColor(0, null);
  assert.equal(wb.sheets[0].extras.tabColor, undefined);
  wb.undo();
  assert.deepEqual(wb.sheets[0].extras.tabColor, { argb: 'FFFF8800' });
});
test('setCellValue adds a format only when the cell has none', () => {
  const wb = setup([['x']]);
  wb.setCellValue(0, 0, 0, 45000, 'yyyy-mm-dd');
  assert.equal(wb.sheets[0].getCell(0, 0).value, 45000); assert.equal(wb.sheets[0].getCell(0, 0).style.numFmt, 'yyyy-mm-dd');
  wb.updateStyle(0, [{ r1: 1, c1: 0, r2: 1, c2: 0 }], (s) => { s.numFmt = '0.0'; }, 'fmt');
  wb.setCellValue(0, 1, 0, 45000, 'yyyy-mm-dd');
  assert.equal(wb.sheets[0].getCell(1, 0).style.numFmt, '0.0');
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} — ${passed} tests passed`);
