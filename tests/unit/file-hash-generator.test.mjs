// Run: node tests/unit/file-hash-generator.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as L from '../../tools/file-hash-generator/logic.js';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const enc = s => new TextEncoder().encode(s);
const nodeHash = (a, d) => new Uint8Array(crypto.createHash(a.replace('-', '').toLowerCase()).update(d).digest());
const nodeHmac = (a, k, d) => new Uint8Array(crypto.createHmac(a.replace('-', '').toLowerCase(), k).update(d).digest());
const rnd = n => new Uint8Array(crypto.randomBytes(n));

test('MD5 RFC 1321 vectors', () => {
  const v = { '': 'd41d8cd98f00b204e9800998ecf8427e', 'a': '0cc175b9c0f1b6a831c399e269772661', 'abc': '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0', 'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789': 'd174ab98d277d9f5a5611c2c9f419d9f',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a' };
  for (const [k, h] of Object.entries(v)) assert.equal(L.toHex(L.hashBytesSync('MD5', enc(k))), h);
});
test('SHA known vectors (abc / empty)', () => {
  assert.equal(L.toHex(L.hashBytesSync('SHA-1', enc('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(L.toHex(L.hashBytesSync('SHA-256', enc('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(L.toHex(L.hashBytesSync('SHA-256', enc(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(L.toHex(L.hashBytesSync('SHA-384', enc('abc'))), 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
  assert.equal(L.toHex(L.hashBytesSync('SHA-512', enc('abc'))), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
});
test('every algorithm matches node:crypto for lengths around block boundaries', () => {
  for (const a of L.ALGOS) for (const n of [0, 1, 54, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 200, 1000, 4097]) {
    const d = rnd(n);
    assert.deepEqual(L.hashBytesSync(a, d), nodeHash(a, d), `${a} len ${n}`);
  }
});
test('incremental updates in odd chunk sizes equal one-shot', () => {
  const d = rnd(10000);
  for (const a of L.ALGOS) {
    const h = L.createHasher(a); let i = 0, step = 1;
    while (i < d.length) { h.update(d.subarray(i, i + step)); i += step; step = (step * 7 + 3) % 331 + 1; }
    assert.deepEqual(h.digest(), nodeHash(a, d), a);
  }
});
test('million-a SHA-256/SHA-1/MD5', () => {
  const d = new Uint8Array(1000000).fill(97);
  assert.equal(L.toHex(L.hashBytesSync('SHA-256', d)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  assert.equal(L.toHex(L.hashBytesSync('SHA-1', d)), '34aa973cd4c4daa4f61eeb2bdbad27316534016f');
  assert.equal(L.toHex(L.hashBytesSync('MD5', d)), '7707d6ae4e027c70eea2a935c2296f21');
});
test('hasher rejects use after digest', () => {
  const h = L.createHasher('SHA-256'); h.digest(); assert.throws(() => h.update(enc('x')));
});
test('HMAC (JS) matches node:crypto incl. long and empty keys; RFC 4231 case 1', () => {
  for (const a of L.ALGOS) for (const kl of [0, 5, 64, 128, 200]) {
    const k = rnd(kl), d = rnd(333);
    assert.deepEqual(new L.Hmac(a, k).update(d).digest(), nodeHmac(a, k, d), `${a} key ${kl}`);
  }
  const key = new Uint8Array(20).fill(0x0b);
  assert.equal(L.toHex(new L.Hmac('SHA-256', key).update(enc('Hi There')).digest()), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});
test('hashBytes (WebCrypto path) matches node, with and without HMAC key, empty key falls back', async () => {
  const d = rnd(5000);
  const r = await L.hashBytes(d, L.ALGOS);
  for (const a of L.ALGOS) assert.deepEqual(r[a], nodeHash(a, d));
  const k = enc('secret'), rk = await L.hashBytes(d, L.ALGOS, k);
  for (const a of L.ALGOS) assert.deepEqual(rk[a], nodeHmac(a, k, d));
  const re = await L.hashBytes(d, ['SHA-256'], new Uint8Array(0));
  assert.deepEqual(re['SHA-256'], nodeHmac('SHA-256', Buffer.alloc(0), d));
});
test('hashBlob: webcrypto path, incremental path (forced), progress, equal results', async () => {
  const d = rnd(1_000_003), blob = new Blob([d]);
  const prog = [];
  const a = await L.hashBlob(blob, { algos: L.ALGOS, chunkSize: 100_000, onProgress: (x, t) => prog.push([x, t]) });
  const b = await L.hashBlob(blob, { algos: L.ALGOS, chunkSize: 100_000, threshold: 1000 });
  assert.equal(a.method, 'webcrypto'); assert.equal(b.method, 'incremental');
  for (const x of L.ALGOS) { assert.deepEqual(a.digests[x], nodeHash(x, d)); assert.deepEqual(b.digests[x], nodeHash(x, d)); }
  assert.equal(prog[0][0], 0); assert.deepEqual(prog.at(-1), [1_000_003, 1_000_003]);
  const k = enc('k'), c = await L.hashBlob(blob, { algos: ['SHA-512', 'MD5'], key: k, threshold: 10 });
  assert.deepEqual(c.digests['SHA-512'], nodeHmac('SHA-512', k, d)); assert.deepEqual(c.digests['MD5'], nodeHmac('MD5', k, d));
});
test('hashBlob: empty blob and cancel', async () => {
  const e = await L.hashBlob(new Blob([]), { algos: ['SHA-256'] });
  assert.equal(L.toHex(e.digests['SHA-256']), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const e2 = await L.hashBlob(new Blob([]), { algos: ['MD5'], threshold: 0 });
  assert.equal(L.toHex(e2.digests.MD5), 'd41d8cd98f00b204e9800998ecf8427e');
  let n = 0;
  await assert.rejects(L.hashBlob(new Blob([rnd(500)]), { algos: ['MD5'], chunkSize: 100, threshold: 1, isCancelled: () => ++n > 2 }), { name: 'AbortError' });
});
test('encodings', () => {
  const b = Uint8Array.of(0, 15, 255, 171);
  assert.equal(L.toHex(b), '000fffab'); assert.equal(L.toHex(b, true), '000FFFAB');
  assert.equal(L.toBase64(b), Buffer.from(b).toString('base64'));
  assert.equal(L.formatDigest(b, 'HEX'), '000FFFAB'); assert.equal(L.formatDigest(b, 'base64'), 'AA//qw==');
  assert.deepEqual(L.hexToBytes('0x0A:ff'), Uint8Array.of(10, 255));
  assert.throws(() => L.hexToBytes('abc')); assert.throws(() => L.hexToBytes('zz'));
  assert.deepEqual(L.parseKey('é', 'text'), enc('é')); assert.deepEqual(L.parseKey('ff', 'hex'), Uint8Array.of(255));
});
test('Unicode text hashing is UTF-8', () => {
  const t = 'héllo 世界 😀';
  assert.deepEqual(L.hashBytesSync('SHA-256', enc(t)), nodeHash('SHA-256', Buffer.from(t, 'utf8')));
});
test('constantTimeEqual', () => {
  assert.ok(L.constantTimeEqual('abc', 'abc')); assert.ok(!L.constantTimeEqual('abc', 'abd'));
  assert.ok(!L.constantTimeEqual('abc', 'abcd')); assert.ok(!L.constantTimeEqual('', 'a')); assert.ok(L.constantTimeEqual('', ''));
});
test('parseExpectedHash: hex, uppercase, prefixed, spaced, base64, errors', () => {
  const h = nodeHash('SHA-256', enc('x')), hex = L.toHex(h);
  assert.deepEqual(L.parseExpectedHash(hex.toUpperCase()), { hex, algos: ['SHA-256'], format: 'hex' });
  assert.equal(L.parseExpectedHash('sha256:' + hex).hex, hex);
  assert.equal(L.parseExpectedHash(hex.match(/../g).join(':')).hex, hex);
  assert.equal(L.parseExpectedHash(' ' + hex + '\n').hex, hex);
  const b64 = Buffer.from(h).toString('base64');
  assert.deepEqual(L.parseExpectedHash(b64), { hex, algos: ['SHA-256'], format: 'base64' });
  assert.equal(L.parseExpectedHash(b64.replace(/=+$/, '')).hex, hex);
  assert.deepEqual(L.parseExpectedHash(L.toHex(nodeHash('MD5', enc('x')))).algos, ['MD5']);
  assert.deepEqual(L.parseExpectedHash(L.toHex(nodeHash('SHA-1', enc('x')))).algos, ['SHA-1']);
  assert.deepEqual(L.parseExpectedHash(L.toHex(nodeHash('SHA-384', enc('x')))).algos, ['SHA-384']);
  assert.deepEqual(L.parseExpectedHash(L.toHex(nodeHash('SHA-512', enc('x')))).algos, ['SHA-512']);
  assert.ok(L.parseExpectedHash('').error); assert.ok(L.parseExpectedHash('abcd').error); assert.ok(L.parseExpectedHash('hello world!').error);
});
test('parseChecksumFile: GNU, binary marker, BSD, comments, bad lines, uppercase', () => {
  const h1 = 'a'.repeat(64), h2 = 'B'.repeat(32), h3 = 'c'.repeat(40);
  const txt = `# comment\n${h1}  file one.txt\n${h2} *bin.dat\r\nSHA1 (x y.bin) = ${h3}\n\nnot a line\n${'d'.repeat(33)}  odd.txt\n`;
  const r = L.parseChecksumFile(txt);
  assert.deepEqual(r.entries.map(e => [e.name, e.hash, e.algos, e.line]), [
    ['file one.txt', h1, ['SHA-256'], 2], ['bin.dat', h2.toLowerCase(), ['MD5'], 3], ['x y.bin', h3, ['SHA-1'], 4]]);
  assert.deepEqual(r.errors.map(e => e.line), [6, 7]);
  assert.deepEqual(L.parseChecksumFile('').entries, []);
});
test('formatChecksumFile round-trips through parseChecksumFile (incl. escaped names)', () => {
  const rows = [{ hex: 'a'.repeat(64), name: 'a b.txt' }, { hex: 'b'.repeat(64), name: 'we\\ird\nname' }];
  const t = L.formatChecksumFile(rows);
  assert.ok(t.startsWith('a'.repeat(64) + '  a b.txt\n'));
  const p = L.parseChecksumFile(t);
  assert.deepEqual(p.entries.map(e => e.name), ['a b.txt', 'we\\ird\nname']);
  assert.equal(L.formatChecksumFile([{ hex: 'c'.repeat(32), name: 'z' }], { binary: true }), 'c'.repeat(32) + ' *z\n');
  assert.equal(L.formatChecksumFile([]), '');
  assert.equal(L.checksumExtension('SHA-256'), 'sha256');
});
test('matchFileName: exact, base name, missing', () => {
  const names = ['a.txt', 'dir/b.txt', 'c.txt'];
  assert.equal(L.matchFileName('a.txt', names), 0); assert.equal(L.matchFileName('./sub\\b.txt', names), 1);
  assert.equal(L.matchFileName('zzz', names), -1);
});
test('groupIdentical groups by digest', () => {
  const d = s => ({ 'SHA-256': nodeHash('SHA-256', enc(s)) });
  const g = L.groupIdentical([{ name: 'a', digests: d('x') }, { name: 'b', digests: d('x') }, { name: 'c', digests: d('y') }, { name: 'e' }], 'SHA-256');
  assert.deepEqual(g.map(x => x.names), [['a', 'b'], ['c']]);
});
test('formatting helpers and reports', () => {
  assert.equal(L.formatThroughput(10485760, 1000), '10.0 MB/s'); assert.equal(L.formatThroughput(0, 10), '');
  assert.equal(L.formatDuration(500), '500 ms'); assert.equal(L.formatDuration(2500), '2.50 s');
  assert.equal(L.sizeLabel(0), '0 B'); assert.equal(L.sizeLabel(1536), '1.5 KB'); assert.equal(L.sizeLabel(5 * 1073741824), '5.00 GB');
  const items = [{ name: 'f.txt', size: 3, digests: { 'MD5': L.hashBytesSync('MD5', enc('abc')) } }];
  assert.match(L.resultsToText(items, ['MD5', 'SHA-1'], 'hex'), /f\.txt {2}\(3 B\)\n {2}MD5 {6}900150983cd24fb0d6963f7d28e17f72$/);
  const j = JSON.parse(L.resultsToJson(items, ['MD5'], 'HEX', { hmac: false }));
  assert.equal(j.results[0].hashes.MD5, '900150983CD24FB0D6963F7D28E17F72'); assert.equal(j.hmac, false);
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL', name, '\n ', e.message); }
}
console.log(`file-hash-generator: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
