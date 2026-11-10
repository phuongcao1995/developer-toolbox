// Run: node tests/unit/excel-formulas.test.mjs   (from the project root)
// Tests the Sheet Editor's formula engine (tools/excel-editor/js/formula.js), which is a plain browser script.
import assert from 'node:assert/strict';
import '../../tools/excel-editor/js/utils.js';
import '../../tools/excel-editor/js/formula.js';

const F = globalThis.SheetApp.formula;
const U = globalThis.SheetApp.utils;
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };

/** Evaluate `formula` against a sheet made from a 2D array (top-left = A1). `at` is the formula cell (for ROW()/COLUMN()). */
function calc(formula, grid = [], at = { row: 0, col: 0 }) {
  const get = (r, c) => { const v = grid[r]?.[c]; return v === undefined || v === '' ? null : v; };
  const maxRow = grid.length - 1, maxCol = Math.max(-1, ...grid.map((r) => r.length - 1));
  const ctx = {
    sheetIndex: 0, row: at.row, col: at.col,
    resolveSheet: (n) => (n.toLowerCase() === 'sheet1' ? 0 : -1),
    getValue: (s, r, c) => get(r, c),
    boundRange: (s, g) => ({ r1: g.r1, c1: g.c1, r2: Math.min(g.r2, maxRow), c2: Math.min(g.c2, maxCol) }),
    getRangeCells: (s, g) => {
      const cells = [];
      for (let r = g.r1; r <= Math.min(g.r2, maxRow); r++) for (let c = g.c1; c <= Math.min(g.c2, maxCol); c++) { const v = get(r, c); if (v !== null) cells.push({ row: r, col: c, value: v }); }
      return { area: (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1), cells };
    },
  };
  return F.evaluate(formula, ctx);
}
const is = (formula, expected, grid) => {
  const got = calc(formula, grid);
  if (typeof expected === 'number' && typeof got === 'number') assert.ok(Math.abs(got - expected) < 1e-9, `${formula} -> ${got}, expected ${expected}`);
  else assert.deepEqual(got, expected, `${formula}`);
};
const serial = (y, m, d) => Math.round(U.dateToSerial(new Date(Date.UTC(y, m - 1, d))));

const people = [
  ['Name', 'Dept', 'Score', 'City'],
  ['Ann', 'Ops', 80, 'Hue'],
  ['Bob', 'Dev', 95, 'Hanoi'],
  ['Cy', 'Ops', 70, 'Hue'],
  ['Di', 'Dev', 60, 'Hue'],
];

test('all new functions are registered', () => {
  for (const n of ['VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'MAXIFS', 'MINIFS', 'IFS', 'SWITCH', 'TEXTJOIN', 'DATEDIF', 'EOMONTH', 'STDEV.S', 'SUMPRODUCT']) assert.ok(F.FUNCTION_NAMES.includes(n), n);
  assert.ok(F.FUNCTION_NAMES.length >= 100, `only ${F.FUNCTION_NAMES.length}`);
  assert.deepEqual(F.findUnsupportedFunctions('VLOOKUP(1,A:B,2,FALSE)+FOO(1)'), ['FOO']);
});

test('VLOOKUP exact, approximate, wildcard and errors', () => {
  is('VLOOKUP("Bob",A2:D5,3,FALSE)', 95, people);
  is('VLOOKUP("b*",A2:D5,4,FALSE)', 'Hanoi', people);
  is('VLOOKUP("bob",A:D,3,0)', 95, people);
  is('VLOOKUP("Zed",A2:D5,3,FALSE)', { error: '#N/A' }, people);
  is('VLOOKUP("Bob",A2:D5,9,FALSE)', { error: '#REF!' }, people);
  const bands = [[0, 'F'], [50, 'D'], [70, 'C'], [90, 'A']];
  is('VLOOKUP(75,A1:B4,2)', 'C', bands); is('VLOOKUP(90,A1:B4,2,TRUE)', 'A', bands); is('VLOOKUP(-1,A1:B4,2)', { error: '#N/A' }, bands);
  is('VLOOKUP(1,A1:B2,2,FALSE)', 0, [[1, null], [2, 3]]); // a blank result is 0, as in Excel
  is('VLOOKUP("1",A1:B2,2,FALSE)', { error: '#N/A' }, [[1, 'x'], [2, 'y']]); // text "1" is not number 1
});
test('HLOOKUP finds by header row', () => is('HLOOKUP("Score",A1:D2,2,FALSE)', 80, people));
test('MATCH and INDEX together', () => {
  is('MATCH("Cy",A1:A5,0)', 4, people);
  is('MATCH(7,A1:A4,1)', 2, [[1], [5], [9], [20]]); is('MATCH(100,A1:A4,-1)', { error: '#N/A' }, [[1], [5], [9], [20]]);
  is('MATCH(6,A1:A4,-1)', 2, [[20], [9], [5], [1]]);
  is('INDEX(C1:C5,MATCH("Di",A1:A5,0))', 60, people);
  is('INDEX(A1:D5,3,4)', 'Hanoi', people); is('INDEX(A1:D5,9,1)', { error: '#REF!' }, people);
  is('INDEX(A1:D1,2)', 'Dept', people);
  is('SUM(INDEX(A2:D5,0,3))', 305, people); // whole column
  is('SUM(INDEX(C2:C5,0,1))', 305, people);
});
test('XLOOKUP', () => {
  is('XLOOKUP("Bob",A2:A5,C2:C5)', 95, people);
  is('XLOOKUP("Zed",A2:A5,C2:C5,"none")', 'none', people);
  is('XLOOKUP("Zed",A2:A5,C2:C5)', { error: '#N/A' }, people);
  is('XLOOKUP("Hue",D2:D5,A2:A5,"-",0,-1)', 'Di', people); // search from the end
  is('XLOOKUP(75,C2:C5,A2:A5,"-",-1)', 'Cy', people); // next smaller
  is('XLOOKUP(75,C2:C5,A2:A5,"-",1)', 'Ann', people); // next larger
  is('XLOOKUP("a*",A2:A5,C2:C5,"-",2)', 80, people);
  is('SUM(XLOOKUP("Bob",A2:A5,B2:D5))', 95, people); // a row comes back as a range
});
test('SUMIFS, COUNTIFS, AVERAGEIFS, MAXIFS, MINIFS', () => {
  is('SUMIFS(C2:C5,B2:B5,"Ops")', 150, people);
  is('SUMIFS(C2:C5,B2:B5,"Dev",D2:D5,"Hue")', 60, people);
  is('COUNTIFS(B2:B5,"Ops",C2:C5,">=75")', 1, people);
  is('COUNTIFS(D:D,"Hue")', 3, people);
  is('AVERAGEIFS(C2:C5,D2:D5,"Hue")', 70, people); is('AVERAGEIFS(C2:C5,D2:D5,"Nowhere")', { error: '#DIV/0!' }, people);
  is('MAXIFS(C2:C5,B2:B5,"Ops")', 80, people); is('MINIFS(C2:C5,B2:B5,"Dev")', 60, people);
  is('SUMIFS(C2:C5,B2:B4,"Ops")', { error: '#VALUE!' }, people);
  is('SUMIFS(C:C,B:B,"Ops")', 150, people);
});
test('SUMPRODUCT, MEDIAN, LARGE, SMALL, RANK, STDEV', () => {
  const g = [[1, 2], [3, 4], [5, 6]];
  is('SUMPRODUCT(A1:A3,B1:B3)', 44, g); is('SUMPRODUCT(A1:A3,B1:B2)', { error: '#VALUE!' }, g);
  is('MEDIAN(A1:B3)', 3.5, g); is('MEDIAN(1,2,3)', 2, g);
  is('LARGE(A1:B3,2)', 5, g); is('SMALL(A1:B3,2)', 2, g); is('LARGE(A1:B3,7)', { error: '#NUM!' }, g);
  is('RANK(5,A1:B3)', 2, g); is('RANK(5,A1:B3,1)', 5, g); is('RANK(7,A1:B3)', { error: '#N/A' }, g);
  is('STDEV(2,4,4,4,5,5,7,9)', 2.138089935299395, g); is('STDEV.P(2,4,4,4,5,5,7,9)', 2, g); is('VAR.P(2,4,4,4,5,5,7,9)', 4, g); is('STDEV(1)', { error: '#DIV/0!' }, g);
});
test('rounding helpers and maths', () => {
  is('CEILING(4.2,0.5)', 4.5); is('FLOOR(4.7,0.5)', 4.5); is('CEILING(7,2)', 8); is('FLOOR(-7,2)', -8);
  is('TRUNC(8.987,2)', 8.98); is('TRUNC(-8.9)', -8); is('SIGN(-4)', -1);
  is('LN(EXP(2))', 2); is('LOG(8,2)', 3); is('LOG10(1000)', 3); is('LN(0)', { error: '#NUM!' });
});
test('IFS, SWITCH, XOR, IFNA, ISNA, TRUE()/FALSE()', () => {
  is('IFS(1>2,"a",2>1,"b")', 'b'); is('IFS(1>2,"a")', { error: '#N/A' });
  is('SWITCH(2,1,"one",2,"two","other")', 'two'); is('SWITCH(9,1,"one","other")', 'other'); is('SWITCH(9,1,"one")', { error: '#N/A' });
  is('XOR(TRUE,FALSE,TRUE,TRUE)', true); is('TRUE()', true); is('FALSE()', false);
  is('IFNA(VLOOKUP("x",A1:B2,2,0),"missing")', 'missing', [['a', 1], ['b', 2]]); is('IFNA(1/0,"m")', { error: '#DIV/0!' });
  is('ISNA(MATCH("x",A1:A2,0))', true, [['a'], ['b']]);
});
test('text functions', () => {
  is('FIND("b","abcabc")', 2); is('FIND("b","abcabc",3)', 5); is('FIND("B","abc")', { error: '#VALUE!' });
  is('SEARCH("B","abc")', 2); is('SEARCH("a?c","xxabc")', 3); is('SEARCH("z","abc")', { error: '#VALUE!' });
  is('SUBSTITUTE("a-b-c","-","+")', 'a+b+c'); is('SUBSTITUTE("a-b-c","-","+",2)', 'a-b+c'); is('SUBSTITUTE("abc","","x")', 'abc');
  is('REPLACE("abcdef",2,3,"X")', 'aXef'); is('REPT("ab",3)', 'ababab'); is('REPT("a",-1)', { error: '#VALUE!' });
  is('PROPER("hELLO wORLD-foo")', 'Hello World-Foo'); is('PROPER("nguyễn văn a")', 'Nguyễn Văn A');
  is('EXACT("a","A")', false); is('EXACT("a","a")', true); is('CHAR(65)', 'A'); is('CODE("A")', 65); is('CLEAN(A1)', 'ab', [['a\u0001b']]);
  is('TEXTJOIN(", ",TRUE,A1:A4)', 'x, y, z', [['x'], [''], ['y'], ['z']]); is('TEXTJOIN("-",FALSE,A1:A3)', 'x--y', [['x'], [''], ['y']]);
  is('TEXTJOIN("/",TRUE,"a","b",1)', 'a/b/1');
});
test('date functions', () => {
  is('DATE(2024,5,1)', serial(2024, 5, 1)); is('DATE(2024,14,1)', serial(2025, 2, 1)); is('DATE(2024,3,0)', serial(2024, 2, 29)); is('DATE(24,1,1)', serial(1924, 1, 1));
  const d = serial(2024, 1, 31);
  is(`YEAR(${d})`, 2024); is(`MONTH(${d})`, 1); is(`DAY(${d})`, 31);
  is(`WEEKDAY(${d})`, 4); is(`WEEKDAY(${d},2)`, 3); is(`WEEKDAY(${d},3)`, 2); // Wednesday
  is(`EDATE(${d},1)`, serial(2024, 2, 29)); is(`EDATE(${d},-2)`, serial(2023, 11, 30)); is(`EDATE(${d},12)`, serial(2025, 1, 31));
  is(`EOMONTH(${d},0)`, d); is(`EOMONTH(${d},1)`, serial(2024, 2, 29)); is(`EOMONTH(${d},-1)`, serial(2023, 12, 31));
  is(`DAYS(${serial(2024, 3, 1)},${serial(2024, 2, 1)})`, 29);
  is(`DATEDIF(${serial(2000, 6, 15)},${serial(2024, 6, 14)},"Y")`, 23); is(`DATEDIF(${serial(2000, 6, 15)},${serial(2024, 6, 15)},"Y")`, 24);
  is(`DATEDIF(${serial(2024, 1, 31)},${serial(2024, 3, 1)},"M")`, 1); is(`DATEDIF(${serial(2024, 1, 10)},${serial(2024, 3, 5)},"MD")`, 24);
  is(`DATEDIF(${serial(2023, 11, 20)},${serial(2024, 2, 10)},"YM")`, 2); is(`DATEDIF(${serial(2023, 11, 20)},${serial(2024, 2, 10)},"YD")`, 82);
  is(`DATEDIF(${serial(2024, 5, 1)},${serial(2024, 1, 1)},"D")`, { error: '#NUM!' }); is('DATEDIF(1,2,"Q")', { error: '#NUM!' });
  is('DATEVALUE("2024-05-31")', serial(2024, 5, 31)); is('DATEVALUE("31/05/2024")', serial(2024, 5, 31)); is('DATEVALUE("nope")', { error: '#VALUE!' });
  is('HOUR(0.75)', 18); is('MINUTE(0.5104166667)', 15); is('SECOND(0.0001)', 9); is('TIME(6,30,0)', 0.2708333333333333); is('TIME(25,0,0)', 1 / 24);
});
test('ROW / COLUMN / ROWS / COLUMNS / CHOOSE', () => {
  assert.equal(calc('ROW()', [], { row: 4, col: 2 }), 5); assert.equal(calc('COLUMN()', [], { row: 4, col: 2 }), 3);
  is('ROW(B7)', 7); is('COLUMN(C1)', 3); is('ROWS(A1:B5)', 5); is('COLUMNS(A1:C5)', 3);
  is('CHOOSE(2,"a","b","c")', 'b'); is('CHOOSE(4,"a","b","c")', { error: '#VALUE!' }); is('CHOOSE(2,10,A1+1)', 6, [[5]]);
});
test('lookups compose with arithmetic and other functions', () => {
  is('VLOOKUP("Bob",A2:D5,3,FALSE)*2+1', 191, people);
  is('IFERROR(VLOOKUP("Zed",A2:D5,3,FALSE),0)', 0, people);
  is('SUM(C2:C5)/COUNTIFS(D2:D5,"Hue")', 305 / 3, people);
  is('UPPER(INDEX(A2:A5,MATCH(MAX(C2:C5),C2:C5,0)))', 'BOB', people);
});
test('result formats for date functions', () => {
  assert.equal(F.inferResultFormat('DATE(2024,1,1)'), 'yyyy-mm-dd'); assert.equal(F.inferResultFormat(' now()'), 'yyyy-mm-dd hh:mm');
  assert.equal(F.inferResultFormat('TIME(1,2,3)'), 'hh:mm:ss'); assert.equal(F.inferResultFormat('SUM(A1)'), null); assert.equal(F.inferResultFormat('A1+1'), null);
});
test('existing behaviour is unchanged', () => {
  is('SUM(1,2,3)', 6); is('IF(A1>1,"y","n")', 'y', [[2]]); is('COUNTIF(A1:A3,">1")', 2, [[1], [2], [3]]); is('1/0', { error: '#DIV/0!' }); is('"a"&"b"', 'ab');
});

test('F4 cycles the reference under the caret', () => {
  const step = (t, a, b) => F.cycleReference(t, a, b);
  assert.deepEqual(step('=A1+B2', 2, 2), { text: '=$A$1+B2', selStart: 1, selEnd: 5 });
  assert.equal(step('=$A$1', 1, 1).text, '=A$1'); assert.equal(step('=A$1', 1, 1).text, '=$A1'); assert.equal(step('=$A1', 1, 1).text, '=A1');
  assert.equal(step('=SUM(A1:B3)', 6, 6).text, '=SUM($A$1:$B$3)'); assert.equal(step('=SUM($A$1:$B$3)', 6, 6).text, '=SUM(A$1:B$3)');
  assert.equal(step("=Data!C5*2", 8, 8).text, '=Data!$C$5*2'); assert.equal(step('=A1+B2', 3, 3) && step('=A1+B2', 3, 3).text, '=A1+B2'.replace('A1', '$A$1'));
  assert.equal(step('=1+2', 2, 2), null); assert.equal(step('=A1 +  B2', 5, 5), null); assert.equal(step('=SUM(A:A)', 6, 6), null); assert.equal(step('text', 0, 0), null);
});
test('references and slots in formulas being typed', () => {
  assert.deepEqual(F.findReferences('=A1+Sheet1!B2:C3').map((r) => [r.start, r.end]), [[1, 3], [4, 16]]);
  assert.deepEqual(F.findReferences('=A1+"unterminated'), []); assert.deepEqual(F.findReferences('A1'), []);
  for (const [t, caret, ok] of [['=', 1, true], ['=SUM(', 5, true], ['=A1+', 4, true], ['=A1, ', 5, true], ['=A1', 3, false], ['=SUM', 4, false], ['abc', 3, false], ['=A1*(', 5, true], ['=IF(A1>', 7, true]]) {
    assert.equal(F.canInsertReference(t, caret), ok, `${t}|${caret}`);
  }
});
test('function name suggestions', () => {
  assert.deepEqual(F.functionPrefixAt('=SU', 3), { prefix: 'SU', start: 1, end: 3 });
  assert.deepEqual(F.functionPrefixAt('=A1+VLO', 7), { prefix: 'VLO', start: 4, end: 7 });
  assert.deepEqual(F.functionPrefixAt('=IF(x,SUM', 9) && F.functionPrefixAt('=IF(x,SUM', 9).prefix, 'SUM'.slice(0, 3));
  assert.equal(F.functionPrefixAt('=A1', 3), null); assert.equal(F.functionPrefixAt('=SUM(', 5), null); assert.equal(F.functionPrefixAt('SU', 2), null); assert.equal(F.functionPrefixAt('=1A', 2), null);
  assert.deepEqual(F.suggestFunctions('sumi'), ['SUMIF', 'SUMIFS']); assert.ok(F.suggestFunctions('s', 3).length === 3); assert.deepEqual(F.suggestFunctions('zzz'), []);
  assert.ok(F.suggestFunctions('STDEV').includes('STDEV.S'));
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} — ${passed} tests passed`);
