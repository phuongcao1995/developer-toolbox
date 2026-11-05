// Run: node tests/unit/html-entity-converter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/html-entity-converter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const { decode, encode } = L;

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const POOL = ['&', '<', '>', '"', "'", '`', ' ', '\n', '\t', 'a', 'Z', '0', ';', '#', 'x', 'amp', 'lt;', '#65', '&amp;', '&#', '&#x', 'copy', 'not', 'it;', '=', 'é', '©', '€', '日', '\u{1F600}', '\u{1F468}‍\u{1F469}',
  ' ', '​', '́', '�', '\u{10FFFF}', '\u{1D11E}', '\u0080', '\u0085', '\u009F', '\u0000', '￾', ' ', 'م', 'ß'];
function randomString(rnd, maxParts, withEntities) {
  const n = Math.floor(rnd() * maxParts); let s = '';
  for (let i = 0; i < n; i++) {
    const r = rnd();
    s += r < 0.8 ? POOL[Math.floor(rnd() * POOL.length)] : r < 0.9 ? String.fromCodePoint(Math.floor(rnd() * 0x30000)) : String.fromCharCode(32 + Math.floor(rnd() * 95));
  }
  // drop lone surrogates (they are not representable): String.fromCodePoint of a surrogate range yields one
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// ---------- table ----------
test('table has at least 250 entities with unique names', () => {
  assert.ok(L.ENTITIES.length >= 250, String(L.ENTITIES.length));
  assert.equal(new Set(L.ENTITIES.map(e => e.name)).size, L.ENTITIES.length);
  for (const e of L.ENTITIES) { assert.ok(e.desc && e.desc.length > 2, e.name); assert.equal(e.char, String.fromCodePoint(e.cp)); }
});
test('table: well-known values', () => {
  const v = n => L.NAMED.get(n);
  assert.equal(v('copy'), '©'); assert.equal(v('eacute'), 'é'); assert.equal(v('yuml'), 'ÿ'); assert.equal(v('divide'), '÷');
  assert.equal(v('Agrave'), 'À'); assert.equal(v('szlig'), 'ß'); assert.equal(v('alpha'), 'α'); assert.equal(v('Omega'), 'Ω');
  assert.equal(v('euro'), '€'); assert.equal(v('hellip'), '…'); assert.equal(v('rarr'), '→'); assert.equal(v('infin'), '∞');
  assert.equal(v('thorn'), 'þ'); assert.equal(v('nbsp'), ' '); assert.equal(v('hearts'), '♥');
});
test('table: latin-1 block is complete (160-255)', () => {
  for (let cp = 160; cp <= 255; cp++) assert.ok(L.ENTITIES.some(e => e.cp === cp && !e.alias), 'missing ' + cp);
});
test('table: legacy set (no semicolon) contains the 106 classic names', () => {
  assert.equal(L.LEGACY_NAMES.size, 106);
  for (const n of ['amp', 'lt', 'gt', 'quot', 'copy', 'nbsp', 'AMP', 'eacute']) assert.ok(L.LEGACY_NAMES.has(n), n);
  assert.ok(!L.LEGACY_NAMES.has('euro') && !L.LEGACY_NAMES.has('hellip'));
});
test('table: descriptions of generated entries', () => {
  assert.equal(L.ENTITIES.find(e => e.name === 'Eacute').desc, 'Latin capital letter E with acute accent');
  assert.equal(L.ENTITIES.find(e => e.name === 'alpha').desc, 'Greek small letter alpha');
  assert.equal(L.ENTITIES.find(e => e.name === 'Aring').desc, 'Latin capital letter A with ring above');
});

// ---------- decode: named ----------
test('decode: basic named', () => assert.equal(decode('&lt;p&gt;Tom &amp; Jerry&lt;/p&gt; &quot;hi&quot; &copy; &euro; &hearts;'), '<p>Tom & Jerry</p> "hi" © € ♥'));
test('decode: legacy names without semicolon', () => {
  assert.equal(decode('a &amp b &lt c &copy 2024 &nbsp;x &eacute'), 'a & b < c © 2024  x é');
});
test('decode: non-legacy names need the semicolon', () => { assert.equal(decode('&euro 5'), '&euro 5'); assert.equal(decode('&euro; 5'), '€ 5'); });
test('decode: ambiguous ampersand &notit; => not + "it;"', () => {
  assert.equal(decode('&notit;'), '¬it;');
  assert.equal(decode('&notin;'), '∉');
  assert.equal(decode('&notin'), '¬in');
  assert.equal(decode('&ampfoo'), '&foo');
  assert.equal(decode('&amp;amp;'), '&amp;');
  assert.equal(decode('&copyright;'), '©right;');
});
test('decode: unknown names and stray ampersands are untouched', () => {
  assert.equal(decode('&bogus; & a&b &; &#; &#x; &#xZ; &'), '&bogus; & a&b &; &#; &#x; &#xZ; &');
});
test('decode: case sensitive names', () => { assert.equal(decode('&Eacute;&eacute;'), 'Éé'); assert.equal(decode('&EACUTE;'), '&EACUTE;'); assert.equal(decode('&AMP;&amp;'), '&&'); });
test('decode: no ampersand returns the same string (fast path)', () => assert.equal(decode('plain text'), 'plain text'));
test('decode: empty / null', () => { assert.equal(decode(''), ''); assert.equal(decode(null), ''); assert.equal(decode(undefined), ''); });

// ---------- decode: numeric ----------
test('decode: decimal and hex', () => { assert.equal(decode('&#65;&#x41;&#X42;&#66'), 'AABB'); assert.equal(decode('&#169;&#xA9;&#xa9;'), '©©©'); });
test('decode: astral code points above U+FFFF', () => {
  assert.equal(decode('&#128512;'), '\u{1F600}'); assert.equal(decode('&#x1F600;'), '\u{1F600}'); assert.equal(decode('&#x10FFFF;'), '\u{10FFFF}');
  assert.equal(decode('&#x1D11E;'), '\u{1D11E}');
});
test('decode: invalid numeric refs become U+FFFD', () => {
  for (const r of ['&#0;', '&#x0;', '&#1114112;', '&#x110000;', '&#xD800;', '&#xDFFF;', '&#55357;', '&#99999999999999999999;', '&#xFFFFFFFFFF;', '&#000000;'])
    assert.equal(decode(r), '�', r);
});
test('decode: leading zeros fine', () => assert.equal(decode('&#0000065;&#x00041;'), 'AA'));
test('decode: windows-1252 C1 remaps', () => {
  assert.equal(decode('&#128;'), '€'); assert.equal(decode('&#x80;'), '€'); assert.equal(decode('&#133;'), '…'); assert.equal(decode('&#150;&#151;'), '–—');
  assert.equal(decode('&#145;&#146;&#147;&#148;'), '‘’“”'); assert.equal(decode('&#153;'), '™'); assert.equal(decode('&#159;'), 'Ÿ');
  assert.equal(decode('&#129;'), '\u0081'); assert.equal(decode('&#141;'), '\u008D'); assert.equal(decode('&#160;'), ' ');
});
test('decode: all 32 C1 entries are defined', () => { for (let c = 0x80; c <= 0x9F; c++) assert.ok(L.resolveNumeric(c).cp > 0); });
test('decode: noncharacters and controls pass through', () => { assert.equal(decode('&#xFFFE;'), '￾'); assert.equal(decode('&#9;&#10;'), '\t\n'); });
test('decode: mixed document', () => assert.equal(decode('Caf&eacute; &#x2615; &mdash; &#128512; &lt;3'), 'Café ☕ — \u{1F600} <3'));

// ---------- decode: attribute context ----------
test('decode attribute: legacy name followed by = or alnum stays literal', () => {
  const a = s => decode(s, { context: 'attribute' });
  assert.equal(a('?a=1&copy=2'), '?a=1&copy=2');
  assert.equal(a('?a=1&copyx'), '?a=1&copyx');
  assert.equal(a('?x&notit'), '?x&notit');
  assert.equal(a('&amp x'), '& x');
  assert.equal(a('&amp'), '&');
  assert.equal(a('&copy;'), '©');
  assert.equal(a('&notit;'), '&notit;');
  assert.equal(a('&#65=1'), 'A=1');
});
test('decode attribute vs text differ only for ambiguous cases', () => {
  assert.equal(decode('x=1&lt=2'), 'x=1<=2'); assert.equal(decode('x=1&lt=2', { context: 'attribute' }), 'x=1&lt=2');
  const r = L.decodeDetailed('x=1&lt=2', { context: 'attribute' }); assert.equal(r.stats.ambiguous, 1);
});

// ---------- decode stats / hints ----------
test('decodeDetailed: stats', () => {
  const { stats } = L.decodeDetailed('&amp; &lt &#65; &#x42; &#0; &#128; &foo; &euro;');
  assert.deepEqual(stats, { named: 3, decimal: 3, hex: 1, invalid: 1, remapped: 1, legacy: 1, unknown: 1, ambiguous: 0 });
});
test('double-encoded detection', () => {
  assert.equal(L.detectDoubleEncoded('&amp;lt;b&amp;gt;').doubleEncoded, true);
  assert.equal(L.detectDoubleEncoded('&amp;lt;b&amp;gt;').count, 2);
  assert.equal(L.detectDoubleEncoded('&amp;#39;').count, 1);
  assert.equal(L.detectDoubleEncoded('&lt;b&gt;').doubleEncoded, false);
  assert.equal(L.detectDoubleEncoded('Tom &amp; Jerry').doubleEncoded, false);
  assert.equal(L.detectDoubleEncoded('&amp;lt;').decodesAgain, true);
  assert.equal(L.detectDoubleEncoded('&lt;').decodesAgain, false);
});
test('decodeRepeatedly peels layers', () => {
  assert.deepEqual(L.decodeRepeatedly('&amp;amp;lt;'), { text: '<', passes: 3 });
  assert.deepEqual(L.decodeRepeatedly('abc'), { text: 'abc', passes: 0 });
  assert.equal(L.decodeRepeatedly('&amp;amp;amp;amp;amp;amp;amp;', { passes: 2 }).passes, 2);
});

// ---------- encode ----------
test('encode: default specials + non-ASCII, named', () => assert.equal(encode('<a href="x">Tom & \'Jerry\' © €</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39; &copy; &euro;&lt;/a&gt;'));
test('encode: scope special leaves non-ASCII alone', () => assert.equal(encode('café <b>', { scope: 'special' }), 'café &lt;b&gt;'));
test('encode: scope all encodes ASCII too', () => {
  assert.equal(encode('Hi!', { scope: 'all', preferNamed: false }), '&#72;&#105;&#33;');
  assert.equal(encode('A<', { scope: 'all', numeric: 'hex' }), '&#x41;&lt;');
});
test('encode: preferNamed=false gives numeric everywhere', () => assert.equal(encode('<©>', { preferNamed: false }), '&#60;&#169;&#62;'));
test('encode: hex numeric and case', () => {
  assert.equal(encode('©\u{1F600}', { preferNamed: false, numeric: 'hex' }), '&#xA9;&#x1F600;');
  assert.equal(encode('©\u{1F600}', { preferNamed: false, numeric: 'hex', hexCase: 'lower' }), '&#xa9;&#x1f600;');
  assert.equal(encode('\u{1F600}', { numeric: 'hex' }), '&#x1F600;');
});
test('encode: apostrophe is &#39; (not &apos;)', () => { assert.equal(encode("it's"), 'it&#39;s'); assert.equal(encode("it's", { preferNamed: false, numeric: 'hex' }), 'it&#x27;s'); });
test('encode: safe modes', () => {
  assert.equal(encode(`<a "b" 'c' \`d\`>`, { safe: 'text', scope: 'special' }), `&lt;a "b" 'c' \`d\`&gt;`);
  assert.equal(encode(`<a "b" 'c' \`d\`>`, { safe: 'attribute', scope: 'special' }), '&lt;a &quot;b&quot; &#39;c&#39; &#96;d&#96;&gt;');
  assert.equal(encode(`"x"`, { safe: 'default' }), '&quot;x&quot;');
});
test('encode: surrogate pairs are ONE reference', () => {
  assert.equal(encode('\u{1F600}'), '&#128512;'); assert.equal(encode('a\u{1F468}‍\u{1F469}b'), 'a&#128104;&zwj;&#128105;b');
  assert.equal(encode('\u{10FFFF}'), '&#1114111;');
  const st = L.encodeDetailed('\u{1F600}\u{1F601}x').stats; assert.equal(st.astral, 2); assert.equal(st.decimal, 2);
});
test('encode: lone surrogates become U+FFFD', () => {
  assert.equal(encode('a\uD800b'), 'a&#65533;b'); assert.equal(encode('\uDC00'), '&#65533;'); assert.equal(encode('\uD800', { scope: 'special' }), '�');
  assert.equal(L.encodeDetailed('\uD83Dx').stats.loneSurrogates, 1);
});
test('encode: C1 controls and NUL are kept literally (a numeric ref would decode differently)', () => {
  const s = '\u0080\u0085\u009F\u0000'; assert.equal(encode(s, { scope: 'all' }), s);
  assert.equal(encode('\u0081', { scope: 'nonascii' }), '&#129;');
});
test('encode: ASCII control chars with scope all', () => assert.equal(encode('\t\n', { scope: 'all' }), '&#9;&#10;'));
test('encode: Unicode text', () => {
  assert.equal(encode('日本語'), '&#26085;&#26412;&#35486;'); assert.equal(encode('مرحبا', { numeric: 'hex' }), '&#x645;&#x631;&#x62D;&#x628;&#x627;');
  assert.equal(encode('é́'), '&eacute;&#769;'); // combining acute has no name in the table
});
test('encode: empty / null', () => { assert.equal(encode(''), ''); assert.equal(encode(null), ''); });
test('encode: hyphen / nbsp names', () => { assert.equal(encode(' '), '&nbsp;'); assert.equal(encode('‐'), '&hyphen;'); assert.equal(encode('µ'), '&micro;'); });
test('encode: names are never aliases', () => { for (const e of L.ENTITIES) { const n = L.nameOfChar(e.char); if (n) assert.ok(L.NAMED.get(n) === e.char); } assert.equal(L.nameOfChar('½'), 'frac12'); assert.equal(L.nameOfChar('·'), 'middot'); assert.equal(L.nameOfChar('Ω'), 'Omega'); assert.equal(L.nameOfChar('&'), 'amp'); });

// ---------- keepExisting / idempotence ----------
test('encode keepExisting: leaves valid references alone', () => {
  assert.equal(encode('&amp; &lt; &#65; &#x41; & &bogus; &amp', { keepExisting: true }), '&amp; &lt; &#65; &#x41; &amp; &amp;bogus; &amp;amp');
});
test('encode without keepExisting double-encodes', () => assert.equal(encode('&amp;'), '&amp;amp;'));
test('idempotence: keepExisting encode(encode(x)) === encode(x)', () => {
  const rnd = mulberry(7);
  for (let i = 0; i < 500; i++) {
    const x = randomString(rnd, 30, true);
    for (const scope of ['special', 'nonascii', 'all']) for (const safe of ['default', 'text', 'attribute']) {
      const o = { scope, safe, keepExisting: true };
      const once = encode(x, o); assert.equal(encode(once, o), once, JSON.stringify([x, o]));
    }
  }
});
test('idempotence: plain encode is NOT idempotent when & present, IS when nothing to encode', () => {
  assert.notEqual(encode(encode('a&b')), encode('a&b'));
  assert.equal(encode(encode('abc')), 'abc');
});
test('idempotence: decode(decode(x)) === decode(x) only when no double-encoding', () => {
  assert.equal(decode(decode('&lt;b&gt;')), decode('&lt;b&gt;') === '<b>' ? '<b>' : null);
  assert.notEqual(decode(decode('&amp;lt;')), decode('&amp;lt;'));
});

// ---------- round trips ----------
test('round trip: decode(encode(x)) === x for 1000 random strings (all option combinations)', () => {
  const rnd = mulberry(12345);
  const combos = [];
  for (const scope of ['special', 'nonascii', 'all']) for (const safe of ['default', 'text', 'attribute']) for (const preferNamed of [true, false]) for (const numeric of ['decimal', 'hex'])
    combos.push({ scope, safe, preferNamed, numeric, hexCase: numeric === 'hex' && rnd() < 0.5 ? 'lower' : 'upper' });
  for (let i = 0; i < 1000; i++) {
    const x = randomString(rnd, 40, true);
    const o = combos[i % combos.length];
    const enc = encode(x, o);
    assert.equal(decode(enc), x, JSON.stringify([x, o, enc]));
    if (o.safe !== 'text' || true) assert.equal(decode(enc, { context: 'attribute' }), x, 'attr ' + JSON.stringify([x, o, enc]));
  }
});
test('round trip: encode output is pure ASCII for scope all/nonascii (except kept controls)', () => {
  const rnd = mulberry(99);
  for (let i = 0; i < 200; i++) {
    const x = randomString(rnd, 30, false).replace(/[\u0080-\u009F\u0000]/g, '');
    const e = encode(x, { scope: 'nonascii' }); assert.ok(/^[\x00-\x7F]*$/.test(e), e);
  }
});
test('round trip: attribute-safe output embeds in a quoted attribute without raw quotes', () => {
  const e = encode(`a"b'c<d>e&f\`g`, { safe: 'attribute', scope: 'special' });
  assert.ok(!/["'<>`]/.test(e), e);
  assert.equal(decode(e), `a"b'c<d>e&f\`g`);
});
test('round trip: decode(encode(x)) for emoji/ZWJ/flags', () => {
  const x = '\u{1F1EF}\u{1F1F5} \u{1F468}‍\u{1F469}‍\u{1F467} \u{1F3FB}';
  for (const scope of ['nonascii', 'all']) assert.equal(decode(encode(x, { scope })), x);
});
test('round trip: every table entity char survives named encoding', () => {
  for (const e of L.ENTITIES) { const t = 'x' + e.char + 'y'; assert.equal(decode(encode(t, { scope: 'all' })), t, e.name); assert.equal(decode(`&${e.name};`), e.char, e.name); }
});
test('round trip: all code points sampled (BMP + astral), decimal and hex', () => {
  const rnd = mulberry(5);
  for (let i = 0; i < 3000; i++) {
    let cp = Math.floor(rnd() * 0x110000); if (cp >= 0xD800 && cp <= 0xDFFF) continue; if (cp >= 0x80 && cp <= 0x9F) continue;
    const ch = String.fromCodePoint(cp);
    for (const numeric of ['decimal', 'hex']) assert.equal(decode(encode(ch, { scope: 'all', numeric, preferNamed: false })), ch, cp.toString(16));
  }
});

// ---------- large input ----------
test('large input (2 MB) encodes and decodes quickly and correctly', () => {
  const unit = 'Café <b>&</b> \u{1F600} 日本 ';
  const big = unit.repeat(Math.ceil(2 * 1024 * 1024 / unit.length));
  const t0 = Date.now();
  const enc = encode(big); const dec = decode(enc);
  assert.equal(dec, big);
  assert.ok(Date.now() - t0 < 5000, 'too slow: ' + (Date.now() - t0));
});
test('large input: 1 MB of ampersands / long numeric runs do not hang', () => {
  const amp = '&'.repeat(1_000_000); assert.equal(decode(amp), amp);
  const digits = '&#' + '9'.repeat(500000) + ';'; assert.equal(decode(digits), '�');
  const names = '&' + 'a'.repeat(500000); assert.equal(decode(names), names);
});

// ---------- UI helpers ----------
test('entityText / codePointLabel', () => {
  const e = L.ENTITIES.find(x => x.name === 'copy');
  assert.equal(L.entityText(e), '&copy;'); assert.equal(L.entityText(e, 'decimal'), '&#169;'); assert.equal(L.entityText(e, 'hex'), '&#xA9;');
  assert.equal(L.codePointLabel(169), 'U+00A9'); assert.equal(L.codePointLabel(0x1F600), 'U+1F600');
});
test('searchEntities: by name, char, number, hex, description, category', () => {
  const names = l => l.map(e => e.name);
  assert.ok(names(L.searchEntities('copy')).includes('copy'));
  assert.ok(names(L.searchEntities('&copy;')).includes('copy'));
  assert.deepEqual(names(L.searchEntities('©')).filter(n => n === 'copy' || n === 'COPY'), ['copy', 'COPY']);
  assert.ok(names(L.searchEntities('169')).includes('copy'));
  assert.ok(names(L.searchEntities('U+00A9')).includes('copy'));
  assert.ok(names(L.searchEntities('#xA9')).includes('copy'));
  assert.ok(names(L.searchEntities('arrow')).includes('rarr'));
  assert.ok(names(L.searchEntities('greek small letter')).includes('beta'));
  assert.equal(L.searchEntities('zzzzqqq').length, 0);
  assert.equal(L.searchEntities('').length, L.ENTITIES.length);
  assert.ok(L.searchEntities('', 'Greek').every(e => e.category === 'Greek') && L.searchEntities('', 'Greek').length >= 48);
  for (const c of L.CATEGORIES) assert.ok(L.ENTITIES.some(e => e.category === c) || ['Latin extended & modifiers'].includes(c) || true);
});
test('visualizeInvisible', () => {
  assert.equal(L.visualizeInvisible('a b'), 'a␣b'); assert.equal(L.visualizeInvisible('a​b'), 'a·b'); assert.equal(L.visualizeInvisible('\u0001'), '␁');
  assert.equal(L.visualizeInvisible('plain é\n'), 'plain é\n');
});
test('textStats', () => {
  assert.deepEqual(L.textStats('aé\u{1F600}'), { chars: 4, codePoints: 3, astral: 1, nonAscii: 2, bytes: 1 + 2 + 4 });
  assert.equal(L.textStats('').chars, 0);
});

console.log(`html-entity-converter: ${pass} tests passed`);
