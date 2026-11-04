// Run: node tests/unit/cyberchef.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as C from '../../tools/cyberchef/logic.js';

let pass = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const enc = s => new TextEncoder().encode(s);
const op = (id, v, p = {}) => { const o = C.getOp(id); return o.run(v, { ...C.defaultParams(o), ...p }); };

// ---- MD5 ----
test('md5 known vectors (RFC 1321)', () => {
  const v = { '': 'd41d8cd98f00b204e9800998ecf8427e', a: '0cc175b9c0f1b6a831c399e269772661', abc: '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0', abcdefghijklmnopqrstuvwxyz: 'c3fcd3d76192e4007dfb496cca67e13b',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a' };
  for (const [k, h] of Object.entries(v)) assert.equal(C.md5(enc(k)), h, k);
});
test('md5 matches node crypto for lengths 0..300 and padding boundaries', () => {
  for (let n = 0; n <= 300; n++) { const b = randomBytes(n); assert.equal(C.md5(new Uint8Array(b)), createHash('md5').update(b).digest('hex'), String(n)); }
});
test('md5 large input and subarray views', () => {
  const b = new Uint8Array(randomBytes(5 * 1024 * 1024));
  assert.equal(C.md5(b), createHash('md5').update(b).digest('hex'));
  const sub = b.subarray(3, 1000);
  assert.equal(C.md5(sub), createHash('md5').update(sub).digest('hex'));
});

// ---- hex ----
test('hexToBytes accepts common notations', () => {
  assert.deepEqual([...C.hexToBytes('48 65 6c')], [0x48, 0x65, 0x6c]);
  assert.deepEqual([...C.hexToBytes('0x48,0x65')], [0x48, 0x65]);
  assert.deepEqual([...C.hexToBytes('\\x48\\x65')], [0x48, 0x65]);
  assert.deepEqual([...C.hexToBytes('0x4865')], [0x48, 0x65]);
  assert.deepEqual([...C.hexToBytes('4865')], [0x48, 0x65]);
  assert.deepEqual([...C.hexToBytes('0x5')], [5]);
  assert.equal(C.hexToBytes('').length, 0);
});
test('hexToBytes rejects instead of silently stripping 0x inside tokens', () => {
  assert.throws(() => C.hexToBytes('10x5'), /Invalid hex/);
  assert.throws(() => C.hexToBytes('zz0x41'), /Invalid hex/);
  assert.throws(() => C.hexToBytes('4g'), /Invalid hex/);
  assert.throws(() => C.hexToBytes('abc'), /odd number/);
});

// ---- URL encode ----
test('url-encode friendly error for lone surrogates, fine for emoji', () => {
  assert.equal(op('url-encode', '😀 a'), '%F0%9F%98%80%20a');
  assert.throws(() => op('url-encode', 'ab\uD83Dcd'), /lone UTF-16 surrogate/);
  assert.equal(op('url-encode', "it's (x)*"), 'it%27s%20%28x%29%2A');
});

// ---- Base32 / Base58 ----
test('base32 RFC 4648 vectors', () => {
  const v = { '': '', f: 'MY======', fo: 'MZXQ====', foo: 'MZXW6===', foob: 'MZXW6YQ=', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI======' };
  for (const [k, e] of Object.entries(v)) { assert.equal(C.base32Encode(enc(k)), e); assert.equal(new TextDecoder().decode(C.base32Decode(e)), k); }
  assert.equal(C.base32Encode(enc('foob'), false), 'MZXW6YQ');
  assert.equal(new TextDecoder().decode(C.base32Decode('mzxw6ytboi')), 'foobar');
  assert.throws(() => C.base32Decode('MZXW1==='), /Invalid Base32/);
  assert.throws(() => C.base32Decode('M'), /length/);
});
test('base58 vectors and leading zeros', () => {
  assert.equal(C.base58Encode(enc('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(C.base58Encode(enc('hello world')), 'StV1DL6CwTryKyV');
  assert.equal(C.base58Encode(Uint8Array.of(0, 0, 1)), '112');
  assert.deepEqual([...C.base58Decode('112')], [0, 0, 1]);
  assert.equal(new TextDecoder().decode(C.base58Decode('2NEpo7TZRRrLZSi2U')), 'Hello World!');
  assert.equal(C.base58Encode(new Uint8Array(0)), '');
  assert.throws(() => C.base58Decode('0OIl'), /Invalid Base58/);
  const r = new Uint8Array(randomBytes(64)); r[0] = 0; assert.deepEqual([...C.base58Decode(C.base58Encode(r))], [...r]);
});

// ---- text ops ----
test('rot13 / rot47 are involutions', () => {
  assert.equal(C.rot13('Hello, World!'), 'Uryyb, Jbeyq!');
  assert.equal(C.rot13(C.rot13('Zebra é')), 'Zebra é');
  assert.equal(C.rot47('Hello'), 'w6==@');
  assert.equal(C.rot47(C.rot47('Hello, World! ~')), 'Hello, World! ~');
});
test('binary / decimal round trips', () => {
  assert.equal(C.toBinary(enc('Hi')), '01001000 01101001');
  assert.deepEqual([...C.fromBinary('01001000 01101001')], [72, 105]);
  assert.deepEqual([...C.fromBinary('0100100001101001')], [72, 105]);
  assert.deepEqual([...C.fromBinary('0b01001000')], [72]);
  assert.throws(() => C.fromBinary('0102'), /Invalid binary/);
  assert.throws(() => C.fromBinary('1010'), /multiple of 8/);
  assert.equal(C.toDecimal(enc('Hi')), '72 105');
  assert.deepEqual([...C.fromDecimal('72, 105')], [72, 105]);
  assert.throws(() => C.fromDecimal('256'), /greater than 255/);
  assert.throws(() => C.fromDecimal('1.5'), /Invalid decimal/);
});
test('reverse, case, whitespace ops', () => {
  assert.equal(op('reverse', 'abc😀'), '😀cba');
  assert.equal(op('reverse', 'éa'), 'aé');
  assert.deepEqual([...op('reverse', Uint8Array.of(1, 2, 3))], [3, 2, 1]);
  assert.equal(op('uppercase', 'abc é'), 'ABC É');
  assert.equal(op('lowercase', 'ABC'), 'abc');
  assert.equal(op('remove-ws', ' a b\n\tc '), 'abc');
  assert.equal(op('remove-ws', 'a b\nc', { what: 'lines' }), 'a bc');
});

// ---- HTML entities ----
test('named entity table has >= 250 entries and round-trips', () => {
  const names = Object.keys(C.NAMED_ENTITIES);
  assert.ok(names.length >= 250, String(names.length));
  for (const n of ['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'eacute', 'Omega', 'alpha', 'euro', 'rarr', 'hearts', 'hellip', 'infin']) assert.ok(C.NAMED_ENTITIES[n], n);
  assert.equal(C.decodeHtmlEntities('&eacute;&Eacute;&alpha;&euro;&rarr;&hearts;'), 'éÉα€→♥');
  for (const n of names) assert.equal(C.decodeHtmlEntities(`&${n};`), C.NAMED_ENTITIES[n], n);
});
test('decode: numeric, hex, astral, invalid refs -> U+FFFD', () => {
  assert.equal(C.decodeHtmlEntities('&#65;&#x42;&#X43;'), 'ABC');
  assert.equal(C.decodeHtmlEntities('&#128512;&#x1F600;'), '😀😀');
  assert.equal(C.decodeHtmlEntities('&#0;'), '�');
  assert.equal(C.decodeHtmlEntities('&#xD800;'), '�');
  assert.equal(C.decodeHtmlEntities('&#x110000;'), '�');
  assert.equal(C.decodeHtmlEntities('&#99999999999999;'), '�');
  assert.equal(C.decodeHtmlEntities('&#128;'), '€'); // C1 maps through windows-1252
  assert.equal(C.decodeHtmlEntities('&#65'), 'A');   // missing semicolon still decodes
  assert.equal(C.decodeHtmlEntities('&#;&#x;&# 5'), '&#;&#x;&# 5');
});
test('decode: legacy entities without semicolon, unknown stay literal', () => {
  assert.equal(C.decodeHtmlEntities('a &amp b &lt c &copy 2024 &eacute'), 'a & b < c © 2024 é');
  assert.equal(C.decodeHtmlEntities('&notit;'), '¬it;');
  assert.equal(C.decodeHtmlEntities('&ampfoo'), '&foo');
  assert.equal(C.decodeHtmlEntities('&alpha'), '&alpha'); // not a legacy entity: needs ;
  assert.equal(C.decodeHtmlEntities('&bogus; &x'), '&bogus; &x');
  assert.equal(C.decodeHtmlEntities('&amp;lt;'), '&lt;'); // no double decoding
  assert.equal(C.decodeHtmlEntities('&hasOwnProperty; &constructor;'), '&hasOwnProperty; &constructor;');
});
test('encode: named / numeric / hex, astral, onlyNonAscii', () => {
  assert.equal(C.encodeHtmlEntities('<a href="x">Tom & Jerry\'s é €</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s &eacute; &euro;&lt;/a&gt;');
  assert.equal(C.encodeHtmlEntities('é<', { mode: 'numeric' }), '&#233;&#60;');
  assert.equal(C.encodeHtmlEntities('é<', { mode: 'hex' }), '&#xE9;&#x3C;');
  assert.equal(C.encodeHtmlEntities('😀', { mode: 'named' }), '&#128512;');
  assert.equal(C.encodeHtmlEntities('😀', { mode: 'hex' }), '&#x1F600;');
  assert.equal(C.encodeHtmlEntities('<é>', { onlyNonAscii: true }), '<&eacute;>');
  assert.equal(C.encodeHtmlEntities('<é>', { specialOnly: true }), '&lt;é&gt;');
  assert.equal(C.encodeHtmlEntities('\uD800'), '&#65533;');
});
test('encode then decode is lossless for mixed text in all modes', () => {
  const s = 'a<b>&"\'é€😀中文́ ω ∑ ♥ ';
  for (const mode of ['named', 'numeric', 'hex']) for (const o of [{}, { onlyNonAscii: true }, { specialOnly: true }]) {
    assert.equal(C.decodeHtmlEntities(C.encodeHtmlEntities(s, { mode, ...o })), s, mode + JSON.stringify(o));
  }
});

// ---- pipeline / binary safety ----
test('pipeline keeps real bytes, including non-UTF-8 and file input', async () => {
  const bin = Uint8Array.of(0xff, 0x00, 0xfe, 0x80);
  const r = await C.runPipeline(bin, []);
  assert.deepEqual([...r.finalValue], [255, 0, 254, 128]);
  assert.equal(r.final.binary, true);
  assert.equal(r.final.text, 'ff 00 fe 80');
  const r2 = await C.runPipeline('/8A=', [{ op: 'base64-decode', enabled: true }]);
  assert.deepEqual([...C.valueBytes(r2.finalValue)], [0xff, 0xc0]);
  const r3 = await C.runPipeline(bin, [{ op: 'md5', enabled: true }]);
  assert.equal(r3.finalValue, createHash('md5').update(bin).digest('hex'));
  const r4 = await C.runPipeline(bin, [{ op: 'base64-encode', enabled: true }, { op: 'base64-decode', enabled: true }]);
  assert.deepEqual([...r4.finalValue], [...bin]);
  const r5 = await C.runPipeline('x', [{ op: 'hex-decode', enabled: true }]);
  assert.equal(r5.failedAt, 0); assert.equal(r5.finalValue, null);
});
test('sha256 of binary input matches node', async () => {
  const b = new Uint8Array(randomBytes(1000));
  const r = await C.runPipeline(b, [{ op: 'sha256', enabled: true }]);
  assert.equal(r.finalValue, createHash('sha256').update(b).digest('hex'));
});
test('every operation has a unique id, group and runs on sample input', async () => {
  const ids = new Set();
  for (const o of C.OPERATIONS) {
    assert.ok(!ids.has(o.id), o.id); ids.add(o.id);
    assert.ok(C.GROUPS.includes(o.group), o.id);
  }
  for (const rec of C.RECIPES) { const r = await C.runPipeline(rec.input, rec.steps.map(s => ({ ...s, enabled: true }))); assert.equal(r.failedAt, -1, rec.name); }
});

(async () => {
  for (const { name, fn } of queue) { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } }
  console.log(`cyberchef: ${pass}/${queue.length} passed`);
})();
