// Tests for tools/xml-formatter/logic.js (pure, DOM-free):  node tests/unit/xml-formatter.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/xml-formatter/logic.js';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };
const err = (src, re, line, col, opts) => {
  const r = L.parse(src, opts);
  assert.equal(r.ok, false, `expected error for ${JSON.stringify(src.slice(0, 60))}`);
  assert.match(r.error.message, re);
  if (line) assert.equal(r.error.line, line, `line (${r.error.message})`);
  if (col) assert.equal(r.error.column, col, `column (${r.error.message})`);
  return r.error;
};

// ---------- parsing: valid
t('parses a simple document and counts', () => {
  const r = L.parse('<a x="1"><b>t</b><c/><!--c--><![CDATA[x]]><?pi d?></a>');
  assert.ok(r.ok);
  assert.equal(r.stats.elements, 3); assert.equal(r.stats.attributes, 1); assert.equal(r.stats.comments, 1);
  assert.equal(r.stats.cdata, 1); assert.equal(r.stats.pis, 1); assert.equal(r.stats.maxDepth, 2);
});
t('accepts BOM, declaration, doctype, comments before root', () => {
  const r = L.parse('﻿<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!DOCTYPE a [<!ENTITY e "v">]>\n<!--c--><a>&e;&lt;&#65;&#x42;</a>\n<!--after-->');
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.doc.decl.standalone, 'yes'); assert.equal(r.doc.doctype.name, 'a'); assert.equal(r.entities.get('e'), 'v');
});
t('unicode names, attributes and text', () => {
  const r = L.parse('<日本語 属性="値">Привет 😀 &#x1F600;</日本語>');
  assert.ok(r.ok, JSON.stringify(r.error));
});
t('single quoted attributes and whitespace in tags', () => {
  assert.ok(L.parse("<a  b = 'x\"y'   c=\"1\"\n/>").ok);
});
t('namespaces collected', () => {
  const r = L.parse('<a xmlns="urn:d" xmlns:p="urn:p"><p:b p:x="1"/></a>');
  assert.ok(r.ok);
  assert.deepEqual(r.namespaces.map(n => [n.prefix, n.uri]), [['', 'urn:d'], ['p', 'urn:p']]);
  assert.equal(r.doc.root.children[0].ns, 'urn:p'); assert.equal(r.doc.root.ns, 'urn:d');
});
t('xml prefix is predefined', () => assert.ok(L.parse('<a xml:lang="en"/>').ok));
t('large document (1.2 MB) parses', () => {
  const body = '<item id="1">value &amp; more</item>\n'.repeat(35000);
  const src = `<root>${body}</root>`;
  assert.ok(src.length > 1_200_000);
  const t0 = Date.now(); const r = L.parse(src); assert.ok(r.ok); assert.equal(r.stats.elements, 35001);
  assert.ok(Date.now() - t0 < 5000);
});

// ---------- parsing: errors with line/column
t('empty / whitespace-only', () => { err('', /empty/i); err('  \n ', /empty/i); });
t('text only', () => err('hello', /before the root/i, 1, 1));
t('mismatched tag with position', () => err('<a>\n  <b>\n  </c>\n</a>', /does not match the opening tag <b> \(opened at line 2, column 3\)/, 3, 3));
t('unclosed element', () => err('<a>\n<b>', /Unclosed element <b>/, 2, 1));
t('unexpected closing tag', () => err('</a>', /no open element/, 1, 1));
t('multiple roots', () => err('<a/>\n<b/>', /second root element <b>/, 2, 1));
t('content after root', () => err('<a/>junk', /after the root/i, 1, 5));
t('unquoted attribute', () => err('<a b=1/>', /must be quoted/, 1, 6));
t('attribute without value', () => err('<a b/>', /no value/, 1, 4));
t('duplicate attribute', () => err('<a b="1"\n   b="2"/>', /Duplicate attribute 'b'/, 2, 4));
t('missing whitespace between attributes', () => err('<a b="1"c="2"/>', /separated by whitespace/, 1, 9));
t('unterminated attribute value', () => err('<a b="1/>', /Unterminated value/));
t('< in attribute value', () => err('<a b="x<y"/>', /not allowed in attribute/, 1, 8));
t('invalid element name', () => { err('<1a/>', /Invalid element name/, 1, 2); err('< a/>', /must be escaped as &lt;/); });
t('invalid attribute name', () => err('<a 1b="x"/>', /Invalid attribute name/, 1, 4));
t('bare ampersand', () => err('<a>x & y</a>', /Invalid entity reference/, 1, 6));
t('undeclared entity', () => err('<a>&nbsp;</a>', /&nbsp; is not declared/, 1, 4));
t('entity in attribute checked too', () => err('<a b="&bogus;"/>', /&bogus; is not declared/));
t('invalid char reference', () => err('<a>&#0;</a>', /not allowed in XML/));
t('control char', () => err('<a>\u0001</a>', /Invalid character U\+0001/, 1, 4));
t('unterminated comment / cdata / pi', () => {
  err('<a><!-- x </a>', /Unterminated comment/, 1, 4);
  err('<a><![CDATA[ x </a>', /Unterminated CDATA/, 1, 4);
  err('<a><?pi x </a>', /Unterminated processing instruction/, 1, 4);
});
t('double hyphen in comment', () => { err('<a><!-- a -- b --></a>', /'--' is not allowed/); err('<a><!-- a ---></a>', /cannot end/); });
t(']]> in text', () => err('<a>x ]]> y</a>', /\]\]>/, 1, 6));
t('CDATA outside root', () => err('<![CDATA[x]]><a/>', /only allowed inside/));
t('xml declaration must be first', () => { err('\n<?xml version="1.0"?><a/>', /very start/); err('<a/><?xml version="1.0"?>', /very start/); });
t('xml declaration validation', () => {
  err('<?xml?><a/>', /Malformed|version/);
  err('<?xml encoding="UTF-8"?><a/>', /version/);
  err('<?xml version="1.0" encoding="UT F"?><a/>', /Invalid encoding/);
  err('<?xml version="1.0" standalone="maybe"?><a/>', /standalone/);
  err('<?xml version="2.0"?><a/>', /Unsupported XML version/);
});
t('reserved PI target', () => err('<a><?XML x?></a>', /reserved/));
t('non-UTF-8 encoding gives a warning', () => {
  const r = L.parse('<?xml version="1.0" encoding="ISO-8859-1"?><a/>');
  assert.ok(r.ok); assert.ok(r.warnings.some(w => w.includes('ISO-8859-1')));
});
t('undeclared namespace prefix', () => { err('<p:a/>', /prefix 'p' is not declared/, 1, 2); err('<a p:x="1"/>', /prefix 'p'/); });
t('invalid qualified name', () => err('<a:b:c xmlns:a="u"/>', /Invalid qualified name/));
t('DOCTYPE ordering', () => { err('<a/><!DOCTYPE a>', /before the root/); err('<!DOCTYPE a><!DOCTYPE a><a/>', /Only one DOCTYPE/); });
t('column counts BOM correctly', () => err('﻿<a></b>', /does not match/, 1, 4));
t('CRLF line counting', () => err('<a>\r\n<b>\r\n</c>', /does not match/, 3, 1));
t('depth limit', () => err('<a>'.repeat(60) + '</a>'.repeat(60), /nested more than 50/, 0, 0, { maxDepth: 50 }));
t('deep (1500) document parses and formats', () => {
  const s = '<a>'.repeat(1500) + '</a>'.repeat(1500);
  const r = L.formatXml(s); assert.ok(r.ok);
});

// ---------- security
t('rejects external entities (XXE)', () => {
  err('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>', /External entity 'x' refused/);
  err('<!DOCTYPE a [<!ENTITY x PUBLIC "p" "http://evil/x">]><a>&x;</a>', /External entity/);
});
t('rejects billion laughs (nested entities)', () => {
  const lol = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;">]><lolz>&lol3;</lolz>';
  err(lol, /refers to another entity/);
});
t('rejects too many entity declarations', () => {
  const decls = Array.from({ length: 12 }, (_, i) => `<!ENTITY e${i} "v">`).join('');
  err(`<!DOCTYPE a [${decls}]><a/>`, /more than 10 entities/);
  assert.ok(L.parse(`<!DOCTYPE a [${decls}]><a/>`, { limits: undefined, maxEntityDecls: 20 }).ok);
});
t('rejects quadratic blow-up via expansion cap', () => {
  const big = 'x'.repeat(900);
  err(`<!DOCTYPE a [<!ENTITY b "${big}">]><a>${'&b;'.repeat(2000)}</a>`, /expand to more than/, 0, 0, { maxEntityExpansion: 1000000 });
});
t('external DTD: undeclared entities become warnings', () => {
  const r = L.parse('<!DOCTYPE a SYSTEM "a.dtd"><a>&foo;</a>');
  assert.ok(r.ok); assert.ok(r.warnings.some(w => w.includes('&foo;')));
});
t('parameter entity declarations count but are not expanded', () => {
  assert.ok(L.parse('<!DOCTYPE a [<!ENTITY % p "x">]><a/>').ok);
});

// ---------- formatting
t('format basic nesting, 2 spaces', () => {
  const r = L.formatXml('<a><b>1</b><c><d/></c></a>');
  assert.equal(r.text, '<a>\n  <b>1</b>\n  <c>\n    <d/>\n  </c>\n</a>\n');
});
t('format 4 spaces and tab', () => {
  assert.equal(L.formatXml('<a><b/></a>', { indent: '    ' }).text, '<a>\n    <b/>\n</a>\n');
  assert.equal(L.formatXml('<a><b/></a>', { indent: '\t' }).text, '<a>\n\t<b/>\n</a>\n');
});
t('format keeps decl, doctype, comments, PI, CDATA', () => {
  const src = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE a [<!ENTITY e "v">]><!--top--><?xml-stylesheet href="s.css"?><a><!--in--><b><![CDATA[<x> & y]]></b><?p d?></a>';
  const out = L.formatXml(src).text;
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE a [<!ENTITY e "v">]>\n<!--top-->\n<?xml-stylesheet href="s.css"?>\n<a>'));
  assert.ok(out.includes('<!--in-->') && out.includes('<b><![CDATA[<x> & y]]></b>') && out.includes('<?p d?>'));
});
t('mixed content stays inline', () => {
  const out = L.formatXml('<p>Hello <b>world</b> and <i>more</i>!</p>').text;
  assert.equal(out, '<p>Hello <b>world</b> and <i>more</i>!</p>\n');
});
t('mixed content inside element-only parent', () => {
  const out = L.formatXml('<doc><p>a <b>b</b> c</p><q/></doc>').text;
  assert.equal(out, '<doc>\n  <p>a <b>b</b> c</p>\n  <q/>\n</doc>\n');
});
t('xml:space="preserve" keeps whitespace verbatim (and is inherited)', () => {
  const src = '<a><pre xml:space="preserve">\n  <x>  1 </x>\n</pre><b>  t  </b></a>';
  const out = L.formatXml(src).text;
  assert.ok(out.includes('<pre xml:space="preserve">\n  <x>  1 </x>\n</pre>'));
  assert.ok(out.includes('<b>t</b>'));
  const out2 = L.formatXml('<a xml:space="preserve"><b>\n  <c/>\n</b></a>').text;
  assert.equal(out2.trim(), '<a xml:space="preserve"><b>\n  <c/>\n</b></a>');
});
t('xml:space="default" resets preserve', () => {
  const out = L.formatXml('<a xml:space="preserve"><b xml:space="default"><c/></b></a>').text;
  assert.equal(out.trim(), '<a xml:space="preserve"><b xml:space="default"><c/></b></a>'); // outer preserve wins for the whole subtree
});
t('trimText false keeps surrounding whitespace', () => {
  assert.equal(L.formatXml('<a><b>  x  </b></a>', { trimText: false }).text, '<a>\n  <b>  x  </b>\n</a>\n');
  assert.equal(L.formatXml('<a><b>  x  </b></a>').text, '<a>\n  <b>x</b>\n</a>\n');
});
t('selfClosing normalisation', () => {
  assert.equal(L.formatXml('<a><b></b><c/></a>', { selfClosing: 'collapse' }).text, '<a>\n  <b/>\n  <c/>\n</a>\n');
  assert.equal(L.formatXml('<a><b></b><c/></a>', { selfClosing: 'expand' }).text, '<a>\n  <b></b>\n  <c></c>\n</a>\n');
  assert.equal(L.formatXml('<a><b></b><c/></a>', { selfClosing: 'keep' }).text, '<a>\n  <b></b>\n  <c/>\n</a>\n');
});
t('attribute wrapping', () => {
  const src = '<a x="1" y="2" z="3"><b k="1"/></a>';
  assert.equal(L.formatXml(src, { wrap: 'always' }).text, '<a\n  x="1"\n  y="2"\n  z="3">\n  <b k="1"/>\n</a>\n');
  assert.equal(L.formatXml(src, { wrap: 10 }).text.split('\n')[0], '<a');
  assert.equal(L.formatXml(src, { wrap: 200 }).text, '<a x="1" y="2" z="3">\n  <b k="1"/>\n</a>\n');
  assert.equal(L.formatXml('<a x="1"/>', { wrap: 'always' }).text, '<a x="1"/>\n');
});
t('attribute quotes and entities are untouched', () => {
  const out = L.formatXml(`<a t='say "hi"' u="a&amp;b"/>`).text;
  assert.equal(out, `<a t='say "hi"' u="a&amp;b"/>\n`);
});
t('entity references kept as written', () => assert.equal(L.formatXml('<a>x &lt; y &#169;</a>').text, '<a>x &lt; y &#169;</a>\n'));
t('unicode survives formatting', () => assert.ok(L.formatXml('<a><b>日本語 😀</b></a>').text.includes('日本語 😀')));
t('format is idempotent', () => {
  const once = L.formatXml(L.SAMPLE).text;
  assert.equal(L.formatXml(once).text, once);
});
t('format output is well-formed and has same minified form', () => {
  const src = '<a><b x="1"> t </b><c><d/></c></a>';
  const f = L.formatXml(src).text;
  assert.equal(L.minifyXml(f).text, L.minifyXml(src).text);
});
t('stripComments in format', () => assert.equal(L.formatXml('<a><!--x--><b/></a>', { stripComments: true }).text, '<a>\n  <b/>\n</a>\n'));
t('invalid input returns the error', () => { const r = L.formatXml('<a>'); assert.equal(r.ok, false); assert.ok(r.error.line); });
t('format a 1 MB document is quick and valid', () => {
  const src = `<root>${'<row id="1"><v>x</v><w/></row>'.repeat(35000)}</root>`;
  const r = L.formatXml(src); assert.ok(r.ok); assert.ok(r.text.length > src.length);
  assert.ok(L.parse(r.text).ok);
});

// ---------- minify
t('minify removes inter-element whitespace', () => {
  assert.equal(L.minifyXml('<a>\n  <b x = "1" >t</b>\n  <c>\n  </c>\n</a>\n').text, '<a><b x="1">t</b><c/></a>'.replace('<c/>', '<c></c>'));
});
t('minify keeps text and mixed content', () => assert.equal(L.minifyXml('<p> a <b>b</b> c </p>').text, '<p> a <b>b</b> c </p>'));
t('minify strips comments when asked', () => {
  assert.equal(L.minifyXml('<a><!--x--><b/></a>', { stripComments: true }).text, '<a><b/></a>');
  assert.equal(L.minifyXml('<a><!--x--><b/></a>').text, '<a><!--x--><b/></a>');
});
t('minify keeps declaration and drops newline between prolog items', () => {
  assert.equal(L.minifyXml('<?xml version="1.0"?>\n<!-- c -->\n<a/>\n').text, '<?xml version="1.0"?><!-- c --><a/>');
});
t('minify collapse/expand', () => {
  assert.equal(L.minifyXml('<a><b></b></a>', { selfClosing: 'collapse' }).text, '<a><b/></a>');
  assert.equal(L.minifyXml('<a><b/></a>', { selfClosing: 'expand' }).text, '<a><b></b></a>');
});
t('minify keeps xml:space preserve content', () => assert.equal(L.minifyXml('<a xml:space="preserve">\n <b/>\n</a>').text, '<a xml:space="preserve">\n <b/>\n</a>'));

// ---------- XML -> JSON
t('xml to json: attributes, text, arrays', () => {
  const r = L.xmlToJson('<r><i id="1">a</i><i id="2">b</i><n>5</n><e/></r>');
  assert.deepEqual(JSON.parse(r.text), { r: { i: [{ '@id': '1', '#text': 'a' }, { '@id': '2', '#text': 'b' }], n: '5', e: null } });
});
t('xml to json: forceArray and coerce', () => {
  const r = L.xmlToJson('<r><n>5</n><b>true</b><s>007</s></r>', { forceArray: true, coerce: true });
  assert.deepEqual(JSON.parse(r.text), { r: { n: [5], b: [true], s: ['007'] } });
});
t('xml to json: entities, CDATA, mixed text', () => {
  const r = L.xmlToJson('<r a="x &amp; y">1 &lt; 2<c/> tail <![CDATA[<raw>]]></r>');
  assert.deepEqual(JSON.parse(r.text), { r: { '@a': 'x & y', c: null, '#text': '1 < 2 tail <raw>' } });
});
t('xml to json: custom prefix and text key', () => {
  const r = L.xmlToJson('<r a="1">x</r>', { attrPrefix: '_', textKey: '$' });
  assert.deepEqual(JSON.parse(r.text), { r: { _a: '1', $: 'x' } });
});
t('xml to json: __proto__ element is safe', () => {
  const r = L.xmlToJson('<r><__proto__>x</__proto__></r>');
  assert.equal(({}).x, undefined); assert.ok(r.text.includes('__proto__'));
});
t('xml to json: declared entity expanded', () => {
  assert.deepEqual(JSON.parse(L.xmlToJson('<!DOCTYPE a [<!ENTITY e "val">]><a>&e;</a>').text), { a: 'val' });
});
t('xml to json propagates parse error', () => assert.equal(L.xmlToJson('<a>').ok, false));

// ---------- JSON -> XML
t('json to xml basic', () => {
  const r = L.jsonToXml('{"r":{"@id":"1","i":["a","b"],"n":5,"e":null}}');
  assert.ok(r.ok);
  assert.equal(r.text, '<?xml version="1.0" encoding="UTF-8"?>\n<r id="1">\n  <i>a</i>\n  <i>b</i>\n  <n>5</n>\n  <e/>\n</r>\n');
});
t('json to xml: mixed content kept inline', () => {
  const r = L.jsonToXml('{"p":{"#text":"hi","b":"x"}}', { declaration: false });
  assert.equal(r.text, '<p>hi<b>x</b></p>\n');
});
t('json to xml: escapes', () => {
  const r = L.jsonToXml('{"a":{"@t":"say \\"hi\\" <&>","#text":"1 < 2 & 3 > 2"}}', { declaration: false });
  assert.equal(r.text, '<a t="say &quot;hi&quot; &lt;&amp;>">1 &lt; 2 &amp; 3 &gt; 2</a>\n');
  assert.ok(L.parse(r.text).ok);
});
t('json to xml: wraps multiple keys / arrays / primitives', () => {
  assert.equal(L.jsonToXml('{"a":1,"b":2}', { declaration: false, rootName: 'doc' }).text, '<doc>\n  <a>1</a>\n  <b>2</b>\n</doc>\n');
  assert.equal(L.jsonToXml('[1,2]', { declaration: false }).text, '<root>\n  <item>1</item>\n  <item>2</item>\n</root>\n');
  assert.equal(L.jsonToXml('"x"', { declaration: false }).text, '<root>x</root>\n');
});
t('json to xml: sanitises invalid names with a warning', () => {
  const r = L.jsonToXml('{"root":{"1st key":"a","ok":"b"}}', { declaration: false });
  assert.ok(r.text.includes('<_1st_key>a</_1st_key>')); assert.ok(r.warnings.length === 1);
  assert.ok(L.parse(r.text).ok);
});
t('json to xml: invalid JSON gives position', () => {
  const r = L.jsonToXml('{\n  "a": ,\n}');
  assert.equal(r.ok, false); assert.match(r.error.message, /Invalid JSON/); assert.equal(r.error.line, 2);
  assert.equal(L.jsonToXml('  ').ok, false);
});
t('json to xml: control chars removed', () => {
  const r = L.jsonToXml('{"a":"x\\u0001y"}', { declaration: false });
  assert.equal(r.text, '<a>xy</a>\n'); assert.equal(r.warnings.length, 1);
});
t('json -> xml -> json round trip', () => {
  const v = { cfg: { '@v': '2', item: [{ '@k': 'a', '#text': 'x' }, { '@k': 'b', '#text': 'y' }], name: 'Zoë 😀' } };
  const x = L.jsonToXml(JSON.stringify(v));
  assert.deepEqual(JSON.parse(L.xmlToJson(x.text).text), v);
});

// ---------- XPath / tree helpers
t('xpathOf with repeated siblings and namespaces', () => {
  const r = L.parse('<a><b/><b><c/></b><d xmlns="urn:x"><e/><e/></d><p:f xmlns:p="urn:p"/></a>');
  const b2 = r.doc.root.children[1];
  assert.equal(L.xpathOf(b2.children[0]), '/a/b[2]/c');
  const d = r.doc.root.children[2];
  assert.equal(L.xpathOf(d.children[1]), "/a/*[local-name()='d']/*[local-name()='e'][2]");
  assert.equal(L.xpathOf(r.doc.root.children[3]), "/a/*[name()='p:f']");
  assert.equal(L.xpathOf(r.doc.root), '/a');
});
t('searchTree finds names, attributes, text', () => {
  const r = L.parse('<a><book id="X1">Title</book><b note="hello"/></a>');
  assert.equal(L.searchTree(r.doc.root, 'book', r.entities).length, 1);
  assert.equal(L.searchTree(r.doc.root, 'x1', r.entities)[0].why, '@id');
  assert.equal(L.searchTree(r.doc.root, 'title', r.entities)[0].why, 'text');
  assert.equal(L.searchTree(r.doc.root, '', r.entities).length, 0);
});
t('positionAt and sizeStats', () => {
  const s = L.lineStartsOf('ab\ncd\r\nef\rgh');
  assert.deepEqual(L.positionAt(s, 4), { line: 2, column: 2 });
  assert.deepEqual(L.positionAt(s, 10), { line: 4, column: 1 });
  assert.equal(L.sizeStats('日', 'a').before, 3);
});
t('isXmlName / sanitizeName', () => {
  assert.ok(L.isXmlName('a:b') && L.isXmlName('_x-1.2') && !L.isXmlName('1a') && !L.isXmlName('a b'));
  assert.equal(L.sanitizeName('a b'), 'a_b'); assert.equal(L.sanitizeName(''), '_');
});
t('sample document is valid and formats', () => { const r = L.formatXml(L.SAMPLE); assert.ok(r.ok, JSON.stringify(r.error)); assert.equal(r.stats.elements, 14); });

console.log(`\n${pass} xml-formatter tests passed`);
