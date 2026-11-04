// Run: node tests/unit/table-converter-v2.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as T from '../../tools/table-converter/logic.js';

let pass = 0, total = 0;
const test = (name, fn) => { total++; try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };

// ---- CSV dialect ----
test('detectDialect: delimiter by consistency, ignores quoted delimiters', () => {
  assert.equal(T.detectDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
  assert.equal(T.detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(T.detectDelimiter('a|b|c\n1|2|3'), '|');
  assert.equal(T.detectDelimiter('a;b\n"x,y,z,w";2\n"q,r";3'), ';');
  assert.equal(T.detectDelimiter('single column\nfoo'), ',');
});
test('detectDialect: single-quote char', () => {
  assert.equal(T.detectDialect("a,b\n'x, y',2\n'z',3").quote, "'");
  assert.equal(T.detectDialect('a,b\n"x, y",2').quote, '"');
  const r = T.convert("a,b\n'x, y',2", 'csv', 'json', { delimiter: 'auto', quote: 'auto' });
  assert.deepEqual(JSON.parse(r.output), [{ a: 'x, y', b: '2' }]);
});
test('csv: CR-only, CRLF, mixed newlines and BOM', () => {
  assert.deepEqual(T.parseCsvRows('a,b\r1,2\r3,4').rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(T.parseCsvRows('﻿a,b\r\n1,2\n3,4\r').rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(T.parseCsvRows('a\r"x\ry"\rz').rows, [['a'], ['x\ry'], ['z']]);
  assert.deepEqual(T.parseCsvRows('a\r"x\ry"\rz').lines, [1, 2, 4]);
});
test('csv: ragged rows give warnings with row and line numbers', () => {
  const t = T.parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8,9\n');
  const rw = t.warnings.filter(w => /^Row/.test(w));
  assert.equal(rw.length, 2);
  assert.match(rw[0], /Row 2 \(line 3\): 2 field\(s\) but the header has 3/);
  assert.match(rw[1], /Row 3 \(line 4\): 4 fields but the header has 3; 1 extra/);
  assert.deepEqual(t.rows[1], ['4', '5', '', '']);
  assert.equal(t.columns.length, 4);
});
test('csv: duplicate headers de-duplicated (default) with warning, or kept', () => {
  const t = T.parseCsv('id,id,,name\n1,2,3,4');
  assert.deepEqual(t.columns, ['id', 'id_2', 'column_3', 'name']);
  assert.ok(t.warnings.some(w => /"id" \(column 2\) was renamed to "id_2"/.test(w)));
  const k = T.parseCsv('id,id\n1,2', { dedupeHeaders: false });
  assert.deepEqual(k.columns, ['id', 'id']);
  assert.ok(k.warnings.some(w => /kept as-is/.test(w)));
});
test('csv: no header, trim, skip empty rows, comment lines', () => {
  const t = T.parseCsv('1,2\n3,4', { header: false });
  assert.deepEqual(t.columns, ['column_1', 'column_2']); assert.equal(t.rows.length, 2);
  assert.deepEqual(T.parseCsvRows(' a , b \n', ',', { trim: true }).rows, [['a', 'b']]);
  assert.deepEqual(T.parseCsvRows(' "  a " , b \n', ',', { trim: true }).rows, [['  a ', 'b']]);
  const e = T.parseCsv('a,b\n1,2\n,\n3,4', { skipEmptyRows: true });
  assert.equal(e.rows.length, 2);
  const c = T.parseCsv('# comment\na,b\n# another\n1,2\n', { comment: '#' });
  assert.deepEqual(c.columns, ['a', 'b']); assert.deepEqual(c.rows, [['1', '2']]);
  assert.equal(T.parseCsvRows('#x\n"#y"\n', ',', { comment: '#' }).rows.length, 1);
});
test('csv: malformed quotes give line and column', () => {
  assert.throws(() => T.parseCsvRows('a,b\n1,"oops\n2,3'), e => e instanceof T.ConvertError && e.line === 2 && e.column === 3 && /opened at line 2, column 3/.test(e.message));
  assert.throws(() => T.parseCsvRows('a,b\n"x"y,2'), e => e.line === 2 && e.column === 4 && /unexpected "y" after the closing quote/.test(e.message));
  assert.throws(() => T.parseCsvRows("a\n'x'y", ',', { quote: "'" }), /unexpected "y"/);
  assert.deepEqual(T.parseCsvRows('a\n"x""y"').rows, [['a'], ['x"y']]);
  assert.deepEqual(T.parseCsvRows('a,b"c').rows, [['a', 'b"c']]); // stray quote mid-field is literal
});
test('csv: onProgress is called and ends at 1', () => {
  const big = 'a,b\n' + '12345,hello\n'.repeat(300000);
  const seen = [];
  T.parseCsvRows(big, ',', { onProgress: f => seen.push(f) });
  assert.ok(seen.length >= 3); assert.equal(seen[seen.length - 1], 1);
});
test('json errors include column', () => {
  assert.throws(() => T.parseJson('[\n{"a": }]'), /Invalid JSON/);
});

// ---- Unicode ----
const UNI = ['😀 emoji 🚀', '中文字符 日本語 한국어', 'שלום עולם مرحبا', 'é ä न्न', 'ZWJ 👨‍👩‍👧', 'quote " , ; | \' and \\ back'];
test('unicode round-trips CSV -> JSON -> CSV unchanged', () => {
  const table = { columns: ['k', 'v'], rows: UNI.map((u, i) => [String(i), u]) };
  const csv = T.toCsv(table);
  const json = T.convert(csv, 'csv', 'json').output;
  assert.deepEqual(JSON.parse(json).map(o => o.v), UNI);
  const csv2 = T.convert(json, 'json', 'csv').output;
  assert.deepEqual(T.parseCsv(csv2).rows.map(r => r[1]), UNI);
});
test('unicode round-trips via Markdown and SQL output', () => {
  const rows = UNI.filter(u => !u.includes('|'));
  const csv = T.toCsv({ columns: ['v'], rows: rows.map(r => [r]) });
  const md = T.convert(csv, 'csv', 'markdown').output;
  assert.deepEqual(T.parseMarkdown(md).rows.map(r => r[0]), rows);
  const back = T.convert(md, 'markdown', 'csv').output;
  assert.deepEqual(T.parseCsv(back).rows.map(r => r[0]), rows);
  const sql = T.convert(csv, 'csv', 'sql', { dialect: 'sqlserver' }).output;
  for (const u of rows) assert.ok(sql.includes(`N'${u.replace(/'/g, "''")}'`), u);
  const sql2 = T.convert(csv, 'csv', 'sql').output;
  for (const u of rows) assert.ok(sql2.includes(`'${u.replace(/'/g, "''")}'`), u);
});
test('displayWidth: code points, wide chars, combining marks', () => {
  assert.equal(T.displayWidth('abc'), 3);
  assert.equal(T.displayWidth('中文'), 4);
  assert.equal(T.displayWidth('😀'), 2);
  assert.equal(T.displayWidth('é'), 1);
  assert.equal(T.displayWidth('👨‍👩'), 4);
  assert.equal(T.displayWidth('한국어'), 6);
  assert.equal(T.displayWidth('שלום'), 4);
});
test('markdown columns align by display width', () => {
  const md = T.toMarkdown({ columns: ['name', 'n'], rows: [['中文', 1], ['abcd', 22]] });
  const lines = md.split('\n').map(l => T.displayWidth(l));
  assert.equal(new Set(lines).size, 1, md);
});

// ---- XML ----
test('sanitizeXmlName', () => {
  assert.equal(T.sanitizeXmlName('first name'), 'first_name');
  assert.equal(T.sanitizeXmlName('1st'), '_1st');
  assert.equal(T.sanitizeXmlName(''), '_');
  assert.equal(T.sanitizeXmlName('a<b>&c'), 'a_b__c');
  assert.equal(T.sanitizeXmlName('ns:tag'), 'ns:tag');
  assert.equal(T.sanitizeXmlName('a:b:c'), 'a_b_c');
  assert.equal(T.sanitizeXmlName('-x'), '_-x');
  assert.equal(T.sanitizeXmlName('名前'), '名前');
});
test('xml parse -> json: attributes, text, repeated elements, cdata, entities, namespaces', () => {
  const xml = `<?xml version="1.0"?>
<!-- c -->
<lib xmlns:x="urn:x" id="7">
  <book x:lang="en" year='1999'><title>A &amp; B &#x1F600; &lt;</title></book>
  <book><title><![CDATA[<raw> & ]]></title></book>
  <x:note>hi</x:note>
  <empty/>
  <mixed a="1">text</mixed>
</lib>`;
  const j = T.parseXmlToJson(xml);
  assert.deepEqual(j, { lib: {
    '@xmlns:x': 'urn:x', '@id': '7',
    book: [{ '@x:lang': 'en', '@year': '1999', title: 'A & B 😀 <' }, { title: { '#cdata': '<raw> & ' } }],
    'x:note': 'hi', empty: null, mixed: { '@a': '1', '#text': 'text' },
  } });
});
test('xml -> json via convert() and back (round trip)', () => {
  const src = '<r a="1"><i>1</i><i>2</i><e/><t>x &lt; y</t></r>';
  const json = T.convert(src, 'xml', 'json').output;
  const back = T.convert(json, 'json', 'xml').output;
  assert.deepEqual(T.parseXmlToJson(back), T.parseXmlToJson(src));
});
test('json -> xml: attrs, #text, arrays, cdata, escaping, root naming', () => {
  const r = T.jsonToXml({ lib: { '@id': 'a"b', book: [{ '#text': 'x<y' }, { '#cdata': 'a]]>b' }], n: null, num: 5, flag: true } }, { declaration: false });
  assert.equal(r.output, '<lib id="a&quot;b">\n  <book>x&lt;y</book>\n  <book><![CDATA[a]]]]><![CDATA[>b]]></book>\n  <n/>\n  <num>5</num>\n  <flag>true</flag>\n</lib>');
  assert.equal(T.jsonToXml([1, 2], { declaration: false }).output, '<root>\n  <item>1</item>\n  <item>2</item>\n</root>');
  assert.equal(T.jsonToXml({ a: 1, b: 2 }, { declaration: false, indent: '' }).output, '<root><a>1</a><b>2</b></root>');
  assert.equal(T.jsonToXml('hi', { declaration: false }).output, '<root>hi</root>');
  assert.match(T.jsonToXml({ a: 1 }).output, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<a>1<\/a>$/);
});
test('json -> xml sanitises names and strips illegal characters, with warnings', () => {
  const r = T.jsonToXml({ 'my key': { '1x': 'a\u0001b' } }, { declaration: false });
  assert.equal(r.output, '<my_key>\n  <_1x>a�b</_1x>\n</my_key>');
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /"my key" -> "my_key"/);
});
test('table -> xml: <rows><row>, sanitised and unique names', () => {
  const r = T.convert('first name,1st,first name\nAda & Co,<b>,\n', 'csv', 'xml', { xmlRoot: 'data' });
  assert.equal(r.output, '<?xml version="1.0" encoding="UTF-8"?>\n<data>\n  <row>\n    <first_name>Ada &amp; Co</first_name>\n    <_1st>&lt;b&gt;</_1st>\n    <first_name_2/>\n  </row>\n</data>');
  assert.ok(r.warnings.some(w => /"first name" is written as <first_name_2>|<_1st>/.test(w)));
  assert.match(T.convert('a\n1', 'csv', 'xml').output, /<rows>\n {2}<row>\n {4}<a>1<\/a>/);
});
test('xml -> csv: records from repeated children', () => {
  const r = T.convert('<rows><row id="1"><n>A</n></row><row id="2"><n>B</n><x>9</x></row></rows>', 'xml', 'csv');
  assert.equal(r.output, '@id,n,x\n1,A,\n2,B,9');
});
test('xml parse errors are friendly with line and column', () => {
  const bad = (x, re) => assert.throws(() => T.parseXmlToJson(x), e => e instanceof T.ConvertError && re.test(e.message), x);
  bad('<a><b></a>', /line 1, column 7.*closing tag <\/a> does not match the open <b>/);
  bad('<a>\n<b>', /never closed/);
  bad('<a>&nbsp;</a>', /unknown entity &nbsp;/);
  bad('<a>a & b</a>', /"&" must be written as &amp;/);
  bad('<a x=1/>', /must be in quotes/);
  bad('<a x="1" x="2"/>', /appears twice/);
  bad('<a/><b/>', /only one root/);
  bad('text<a/>', /text before the root/);
  bad('', /no root element/);
  bad('<a>\n  <b>\n</c>', /line 3, column 1\): closing tag <\/c>/);
  bad('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', /entity declarations are not supported/);
  bad('<a b="<"/>', /not allowed inside the value/);
  bad('<a>&#0;</a>', /not a legal XML character/);
});
test('xml: deep nesting is rejected, not stack-overflowed', () => {
  assert.throws(() => T.parseXmlToJson('<a>'.repeat(2000) + '</a>'.repeat(2000)), /nested more than/);
});
test('xml: pairs available, unsupported pair still rejected', () => {
  assert.ok(T.PAIRS.json.includes('xml') && T.PAIRS.csv.includes('xml') && T.PAIRS.xml.includes('json'));
  assert.throws(() => T.convert('<a/>', 'xml', 'xml'), /not supported/);
});

// ---- size thresholds / progress ----
test('constants and convert progress callback', () => {
  assert.equal(T.LARGE_INPUT_WARN, 10 * 1024 * 1024); assert.equal(T.WORKER_MIN, 2 * 1024 * 1024);
  const stages = new Set();
  T.convert('a,b\n' + '1,2\n'.repeat(400000), 'csv', 'json', { onProgress: p => stages.add(p.stage) });
  assert.ok(stages.has('Parsing') && stages.has('Writing'));
});

console.log(`table-converter-v2: ${pass}/${total} passed`);
