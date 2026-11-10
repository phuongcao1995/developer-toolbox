// Run: node tests/unit/excel-condfmt.test.mjs   (from the project root)
// Tests Sheet Editor conditional formatting, remove duplicates and text to columns.
import assert from 'node:assert/strict';
import '../../tools/excel-editor/js/utils.js';
import '../../tools/excel-editor/js/formula.js';
import '../../tools/excel-editor/js/fill.js';
import '../../tools/excel-editor/js/spreadsheet.js';
import '../../tools/excel-editor/js/condfmt.js';

const { Workbook } = globalThis.SheetApp.spreadsheet;
const CF = globalThis.SheetApp.condfmt;
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const setup = (rows) => {
  const wb = Workbook.createBlank();
  rows.forEach((r, i) => r.forEach((t, j) => { if (t !== null) wb.setCellInput(0, i, j, t); }));
  return wb;
};
const shown = (wb, r, c) => wb.getDisplay(0, r, c).text;
const R = (r1, c1, r2, c2) => ({ r1, c1, r2, c2 });
const red = CF.presetStyle('red');
const bgOf = (fn, r, c) => (fn(r, c) || {}).background || null;

test('cellIs: greater than colours only matching cells', () => {
  const wb = setup([['5'], ['15'], ['abc'], ['25']]);
  CF.addRule(wb, 0, [R(0, 0, 3, 0)], { type: 'cellIs', operator: 'greaterThan', formulae: [10], style: red });
  const f = CF.lookup(wb, 0);
  assert.equal(bgOf(f, 0, 0), null);
  assert.equal(bgOf(f, 1, 0), '#FFC7CE');
  assert.equal(bgOf(f, 2, 0), null); // text is never "greater than" a number here
  assert.equal(bgOf(f, 3, 0), '#FFC7CE');
  assert.equal(f(1, 0).color, '#9C0006');
});

test('cellIs: between, equal text without case, and cell-reference operands', () => {
  const wb = setup([['5', 'Yes', '10'], ['15', 'no', '3']]);
  CF.addRule(wb, 0, [R(0, 0, 1, 0)], { type: 'cellIs', operator: 'between', formulae: [4, 6], style: red });
  CF.addRule(wb, 0, [R(0, 1, 1, 1)], { type: 'cellIs', operator: 'equal', formulae: ['"YES"'], style: red });
  CF.addRule(wb, 0, [R(0, 2, 1, 2)], { type: 'cellIs', operator: 'greaterThan', formulae: ['$A$2'], style: red }); // 10 > 15? no
  const f = CF.lookup(wb, 0);
  assert.ok(f(0, 0)); assert.equal(f(1, 0), null);
  assert.ok(f(0, 1)); assert.equal(f(1, 1), null);
  assert.equal(f(0, 2), null);
});

test('containsText, beginsWith, endsWith', () => {
  const wb = setup([['Apple pie'], ['Banana'], ['pineapple']]);
  CF.addRule(wb, 0, [R(0, 0, 2, 0)], { type: 'containsText', operator: 'containsText', text: 'APPLE', style: red });
  let f = CF.lookup(wb, 0);
  assert.ok(f(0, 0)); assert.equal(f(1, 0), null); assert.ok(f(2, 0));
  CF.clearRules(wb, 0, [R(0, 0, 2, 0)]);
  CF.addRule(wb, 0, [R(0, 0, 2, 0)], { type: 'containsText', operator: 'beginsWith', text: 'apple', style: red });
  f = CF.lookup(wb, 0);
  assert.ok(f(0, 0)); assert.equal(f(2, 0), null);
  CF.clearRules(wb, 0, [R(0, 0, 2, 0)]);
  CF.addRule(wb, 0, [R(0, 0, 2, 0)], { type: 'containsText', operator: 'endsWith', text: 'apple', style: red });
  f = CF.lookup(wb, 0);
  assert.equal(f(0, 0), null); assert.ok(f(2, 0));
});

test('expression rules are relative to the first cell, and duplicates work', () => {
  const wb = setup([['a', '1'], ['b', '2'], ['a', '3']]);
  CF.addRule(wb, 0, [R(0, 0, 2, 1)], { type: 'expression', formulae: ['$B1>=2'], style: red });
  let f = CF.lookup(wb, 0);
  assert.equal(f(0, 0), null); assert.ok(f(1, 0)); assert.ok(f(2, 1));
  CF.clearRules(wb, 0, [R(0, 0, 0, 0)]);
  CF.addRule(wb, 0, [R(0, 0, 2, 0)], { type: 'expression', formulae: ['AND(A1<>"",COUNTIF($A$1:$A$3,A1)>1)'], style: red });
  f = CF.lookup(wb, 0);
  assert.ok(f(0, 0)); assert.equal(f(1, 0), null); assert.ok(f(2, 0));
});

test('top / bottom N, percent, above and below average', () => {
  const wb = setup([['1'], ['2'], ['3'], ['4'], ['10']]);
  CF.addRule(wb, 0, [R(0, 0, 4, 0)], { type: 'top10', rank: 2, style: red });
  let f = CF.lookup(wb, 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => !!f(r, 0)), [false, false, false, true, true]);
  CF.clearRules(wb, 0, [R(0, 0, 4, 0)]);
  CF.addRule(wb, 0, [R(0, 0, 4, 0)], { type: 'top10', rank: 40, percent: true, bottom: true, style: red });
  f = CF.lookup(wb, 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => !!f(r, 0)), [true, true, false, false, false]);
  CF.clearRules(wb, 0, [R(0, 0, 4, 0)]);
  CF.addRule(wb, 0, [R(0, 0, 4, 0)], { type: 'aboveAverage', aboveAverage: true, style: red }); // average 4
  f = CF.lookup(wb, 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => !!f(r, 0)), [false, false, false, false, true]);
});

test('colour scales blend between the colours', () => {
  const wb = setup([['0'], ['5'], ['10']]);
  CF.addRule(wb, 0, [R(0, 0, 2, 0)], { type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFFFFFFF' }, { argb: 'FF000000' }] });
  const f = CF.lookup(wb, 0);
  assert.equal(bgOf(f, 0, 0), 'rgb(255,255,255)');
  assert.equal(bgOf(f, 1, 0), 'rgb(128,128,128)');
  assert.equal(bgOf(f, 2, 0), 'rgb(0,0,0)');
});

test('newest rule wins per property; undo and redo restore the rules', () => {
  const wb = setup([['5']]);
  CF.addRule(wb, 0, [R(0, 0, 0, 0)], { type: 'cellIs', operator: 'greaterThan', formulae: [1], style: CF.presetStyle('red') });
  CF.addRule(wb, 0, [R(0, 0, 0, 0)], { type: 'cellIs', operator: 'greaterThan', formulae: [1], style: CF.presetStyle('green') });
  assert.equal(bgOf(CF.lookup(wb, 0), 0, 0), '#C6EFCE');
  assert.equal(CF.listRules(wb, 0).length, 2);
  wb.undo();
  assert.equal(bgOf(CF.lookup(wb, 0), 0, 0), '#FFC7CE');
  wb.redo();
  assert.equal(bgOf(CF.lookup(wb, 0), 0, 0), '#C6EFCE');
});

test('editing a value updates the formatting; clear and setRules remove rules', () => {
  const wb = setup([['5']]);
  CF.addRule(wb, 0, [R(0, 0, 0, 0)], { type: 'cellIs', operator: 'greaterThan', formulae: [10], style: red });
  assert.equal(CF.lookup(wb, 0)(0, 0), null);
  wb.setCellInput(0, 0, 0, '50');
  assert.ok(CF.lookup(wb, 0)(0, 0));
  CF.setRules(wb, 0, () => false);
  assert.equal(CF.lookup(wb, 0), null);
  assert.equal(CF.listRules(wb, 0).length, 0);
  assert.equal(CF.clearRules(wb, 0, [R(0, 0, 0, 0)]), 0);
});

test('rules read from a file (ExcelJS shape, multi-range refs) are evaluated', () => {
  const wb = setup([['1'], ['20'], [null], ['30']]);
  wb.sheets[0].extras = { conditionalFormattings: [{ ref: 'A1:A2 A4', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['10'], priority: 3, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFFF00' } } } }] }] };
  const f = CF.lookup(wb, 0);
  assert.equal(bgOf(f, 1, 0), '#FFFF00'); assert.equal(bgOf(f, 3, 0), '#FFFF00'); assert.equal(f(0, 0), null);
  assert.equal(CF.listRules(wb, 0)[0].text, 'Cell value is greater than 10');
});

test('remove duplicates keeps the first row of each, shifts the rest up, and can be undone', () => {
  const wb = setup([['Name', 'Qty'], ['a', '1'], ['A', '2'], ['b', '3'], ['a', '4'], ['c', '=A6&"x"']]);
  const out = wb.removeDuplicates(0, R(0, 0, 5, 1), [0], true);
  assert.deepEqual(out, { removed: 2, kept: 3 });
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((r) => shown(wb, r, 0)), ['Name', 'a', 'b', 'c', '', '']);
  assert.equal(shown(wb, 3, 1), 'cx'); // a formula that points at its own row keeps doing so after it moves
  assert.equal(wb.sheets[0].getCell(3, 1).formula, 'A4&"x"');
  wb.undo();
  assert.equal(shown(wb, 2, 0), 'A');
  assert.equal(wb.removeDuplicates(0, R(0, 0, 5, 1), [0, 1], true).removed, 0);
});

test('remove duplicates on all columns without a header', () => {
  const wb = setup([['x', '1'], ['x', '1'], ['x', '2']]);
  assert.equal(wb.removeDuplicates(0, R(0, 0, 2, 1), [0, 1], false).removed, 1);
  assert.equal(shown(wb, 1, 1), '2');
});

test('text to columns splits on a delimiter, converts numbers, refuses to overwrite', () => {
  const wb = setup([['a,1,2.5'], ['b,,x'], ['c']]);
  assert.equal(wb.textToColumns(0, R(0, 0, 2, 0), ',', false, false), 3);
  assert.deepEqual([0, 1, 2].map((c) => shown(wb, 0, c)), ['a', '1', '2.5']);
  assert.equal(typeof wb.getValue(0, 0, 1), 'number');
  assert.deepEqual([0, 1, 2].map((c) => shown(wb, 1, c)), ['b', '', 'x']);
  assert.equal(shown(wb, 2, 1), '');
  const wb2 = setup([['a,b'], [null, 'keep']]);
  wb2.setCellInput(0, 0, 1, 'occupied');
  assert.equal(wb2.textToColumns(0, R(0, 0, 0, 0), ',', false, false), -1);
  assert.equal(shown(wb2, 0, 1), 'occupied');
  assert.equal(wb2.textToColumns(0, R(0, 0, 0, 0), ',', false, true), 2);
  assert.equal(shown(wb2, 0, 1), 'b');
  const wb3 = setup([['a  b   c']]);
  assert.equal(wb3.textToColumns(0, R(0, 0, 0, 0), ' ', true, false), 3);
  assert.equal(shown(wb3, 0, 2), 'c');
});

console.log(`excel-condfmt: ${passed} tests passed`);
