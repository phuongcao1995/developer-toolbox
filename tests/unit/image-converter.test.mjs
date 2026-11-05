// Run: node tests/unit/image-converter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as I from '../../tools/image-converter/logic.js';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const enc = s => new TextEncoder().encode(s);

// minimal independent ZIP reader: walks the central directory, then each local header
function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22; assert.equal(dv.getUint32(e, true), 0x06054b50, 'EOCD signature');
  const count = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
  assert.equal(cdOff + cdSize, e, 'central directory ends at EOCD'); assert.equal(dv.getUint16(e + 8, true), count);
  const out = []; let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), cs = dv.getUint32(p + 20, true), us = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    assert.equal(dv.getUint32(lo, true), 0x04034b50); assert.equal(dv.getUint16(lo + 6, true), flags); assert.equal(dv.getUint32(lo + 14, true), crc);
    const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true); assert.equal(lnl, nl);
    const data = u8.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + cs);
    assert.equal(method, 0); assert.equal(cs, us); assert.equal(I.crc32(data), crc);
    out.push({ name, data, flags }); p += 46 + nl + xl + cl;
  }
  assert.equal(p, cdOff + cdSize); return out;
}

test('CRC-32 known vectors', () => {
  assert.equal(I.crc32(enc('')), 0); assert.equal(I.crc32(enc('a')), 0xe8b7be43); assert.equal(I.crc32(enc('123456789')), 0xcbf43926);
  assert.equal(I.crc32(enc('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(I.crc32(enc('6789'), I.crc32(enc('12345'))), 0xcbf43926, 'incremental');
  if (zlib.crc32) { const d = new Uint8Array(100000).map((_, i) => (i * 31) & 255); assert.equal(I.crc32(d), zlib.crc32(d)); }
});
test('ZIP: structure, CRCs, UTF-8 names, empty file, binary data round-trip', () => {
  const bin = new Uint8Array(70000).map((_, i) => (i * 7 + 3) & 255);
  const zip = I.buildZip([{ name: 'a.txt', data: enc('hello') }, { name: 'sub/日本語 😀.png', data: bin }, { name: 'empty.bin', data: new Uint8Array(0) }]);
  const r = readZip(zip);
  assert.deepEqual(r.map(x => x.name), ['a.txt', 'sub/日本語 😀.png', 'empty.bin']);
  assert.equal(new TextDecoder().decode(r[0].data), 'hello'); assert.deepEqual(r[1].data, bin); assert.equal(r[2].data.length, 0);
  assert.ok(r.every(x => x.flags === 0x0800));
  assert.equal(zip.length, 3 * (30 + 46) + 5 + 70000 + 0 + enc('a.txt').length * 2 + enc('sub/日本語 😀.png').length * 2 + enc('empty.bin').length * 2 + 22);
});
test('ZIP: empty archive is a bare EOCD; date encoding', () => {
  const z = I.buildZip([]); assert.equal(z.length, 22); assert.equal(new DataView(z.buffer).getUint32(0, true), 0x06054b50);
  const one = I.buildZip([{ name: 'x', data: enc('y'), date: new Date(2024, 4, 17, 13, 45, 30) }]); const dv = new DataView(one.buffer);
  assert.equal(dv.getUint16(10, true), (13 << 11) | (45 << 5) | 15); assert.equal(dv.getUint16(12, true), ((2024 - 1980) << 9) | (5 << 5) | 17);
});
test('ZIP: extracts with the system archiver when one is available (bsdtar/unzip)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-')); const f = path.join(dir, 't.zip'), out = path.join(dir, 'out'); fs.mkdirSync(out);
  const data = new Uint8Array(5000).map((_, i) => i & 255);
  fs.writeFileSync(f, I.buildZip([{ name: 'one.bin', data }, { name: 'two.txt', data: enc('two') }]));
  let r = spawnSync('tar', ['-xf', f, '-C', out]); if (r.error || r.status !== 0) r = spawnSync('unzip', ['-o', f, '-d', out]);
  if (r.error || r.status !== 0) { console.log('  (skipped: no system zip extractor)'); return; }
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(out, 'one.bin'))), data); assert.equal(fs.readFileSync(path.join(out, 'two.txt'), 'utf8'), 'two');
});
test('ZIP: too many files rejected', () => {
  assert.throws(() => I.zipParts(Array.from({ length: 65536 }, (_, i) => ({ name: 'f' + i, data: new Uint8Array(0) }))), /Too many/);
});
test('computeLayout: none/percent/width/height/max with and without upscale', () => {
  const L = (m, o) => I.computeLayout(1000, 500, { mode: m, ...o });
  assert.deepEqual([L('none').outW, L('none').outH], [1000, 500]);
  assert.deepEqual([L('percent', { percent: 50 }).outW, L('percent', { percent: 50 }).outH], [500, 250]);
  assert.equal(L('percent', { percent: 200, noUpscale: true }).outW, 1000); assert.equal(L('percent', { percent: 200, noUpscale: false }).outW, 2000);
  assert.deepEqual([L('width', { width: 250 }).outW, L('width', { width: 250 }).outH], [250, 125]);
  assert.deepEqual([L('height', { height: 100 }).outW, L('height', { height: 100 }).outH], [200, 100]);
  assert.equal(L('width', { width: 4000, noUpscale: true }).outW, 1000); assert.ok(L('width', { width: 4000, noUpscale: true }).notes.length);
  assert.equal(L('width', { width: 4000, noUpscale: false }).outH, 2000);
  assert.deepEqual([L('max', { width: 400 }).outW, L('max', { width: 400 }).outH], [400, 200]);
  assert.ok(L('width', { width: 0 }).error); assert.ok(L('percent', { percent: 0 }).error); assert.ok(L('box', { width: 10 }).error); assert.ok(L('wat').error);
  assert.ok(I.computeLayout(0, 5, {}).error);
});
test('computeLayout: box fit modes', () => {
  const B = (fit, o = {}) => I.computeLayout(1000, 500, { mode: 'box', width: 200, height: 200, fit, ...o });
  const c = B('contain'); assert.deepEqual([c.outW, c.outH], [200, 100]);
  const s = B('stretch'); assert.deepEqual([s.outW, s.outH], [200, 200]);
  const v = B('cover'); assert.deepEqual([v.outW, v.outH], [200, 200]); assert.equal(v.sw, 500); assert.equal(v.sh, 500); assert.equal(v.sx, 250); assert.equal(v.sy, 0);
  const big = B('cover', { width: 2000, height: 2000 }); assert.deepEqual([big.outW, big.outH, big.sw, big.sh], [500, 500, 500, 500]);
  const bigC = B('contain', { width: 3000, height: 3000 }); assert.deepEqual([bigC.outW, bigC.outH], [1000, 500]);
  const bigS = B('stretch', { width: 3000, height: 300 }); assert.deepEqual([bigS.outW, bigS.outH], [1000, 300]);
  assert.deepEqual([B('contain', { width: 3000, height: 3000, noUpscale: false }).outW], [3000]);
});
test('output limits', () => {
  assert.match(I.computeLayout(1000, 500, { mode: 'width', width: 20000, noUpscale: false }).error, /per-side/);
  assert.match(I.computeLayout(1000, 1000, { mode: 'box', width: 15000, height: 15000, fit: 'stretch', noUpscale: false }).error, /too large/);
  assert.equal(I.checkInputLimits(1000, 100, 100), null); assert.match(I.checkInputLimits(26 * 1048576), /25 MB/); assert.match(I.checkInputLimits(10, 8000, 8000), /64\.0 megapixels/);
  assert.equal(I.checkInputLimits(25 * 1048576, 7000, 7000), null);
});
test('filename templates and sanitising', () => {
  const d = new Date(2024, 0, 5);
  assert.equal(I.applyTemplate('{name}-{w}x{h}', { name: 'photo.JPG', w: 800, h: 600, ext: 'webp', date: d }), 'photo-800x600.webp');
  assert.equal(I.applyTemplate('', { name: 'a.png', w: 1, h: 1, ext: 'png' }), 'a.png');
  assert.equal(I.applyTemplate('img_{n}_{date}.{ext}', { name: 'a', w: 1, h: 1, ext: 'jpg', index: 3, date: d }), 'img_3_2024-01-05.jpg');
  assert.equal(I.applyTemplate('{name}/../x:y*', { name: 'a', w: 1, h: 1, ext: 'png' }), 'a_.._x_y_.png');
  assert.equal(I.applyTemplate('{format}-{name}', { name: 'q', w: 1, h: 1, ext: 'png' }), 'png-q.png');
  assert.equal(I.sanitizeFilename('CON'), '_CON'); assert.equal(I.sanitizeFilename('...'), 'image'); assert.equal(I.sanitizeFilename('a\u0000b\nc'), 'a_b_c'); assert.equal(I.sanitizeFilename('日本語 😀'), '日本語 😀');
  assert.deepEqual(I.uniqueNames(['a.png', 'b.png', 'a.png', 'A.png', 'a.png']), ['a.png', 'b.png', 'a-1.png', 'A-2.png', 'a-3.png']);
});
test('savings and size formatting', () => {
  assert.equal(I.savings(1000, 250).text, '75.0% smaller'); assert.equal(I.savings(1000, 1500).text, '50.0% larger'); assert.equal(I.savings(1000, 1000).text, 'same size'); assert.equal(I.savings(0, 5).text, '');
  assert.equal(I.formatSize(500), '500 B'); assert.equal(I.formatSize(2048), '2.0 KB'); assert.equal(I.formatSize(3 * 1048576), '3.00 MB');
  assert.equal(I.clampQuality(80), 0.8); assert.equal(I.clampQuality(1000), 1); assert.equal(I.clampQuality(-5), 0.01); assert.equal(I.clampQuality('x'), 0.9);
  assert.equal(I.mimeToExt('image/jpeg'), 'jpg'); assert.equal(I.mimeToFormatKey('image/webp'), 'webp'); assert.equal(I.mimeToFormatKey('image/gif'), null);
});
test('sniffType', () => {
  assert.equal(I.sniffType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png'); assert.equal(I.sniffType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(I.sniffType(enc('GIF89a....')), 'image/gif'); assert.equal(I.sniffType(enc('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp'); assert.equal(I.sniffType(enc('BM....')), 'image/bmp');
  assert.equal(I.sniffType(enc('\0\0\0\x1cftypavif')), 'image/avif'); assert.equal(I.sniffType(enc('  <svg xmlns="x"></svg>')), 'image/svg+xml'); assert.equal(I.sniffType(enc('<?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(I.sniffType(enc('hello world')), null); assert.equal(I.sniffType(new Uint8Array(2)), null);
});
function gif(frames) {
  const b = [...enc('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]; // 2-colour global table
  for (let i = 0; i < frames; i++) b.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0);
  b.push(0x3b); return Uint8Array.from(b);
}
test('isAnimated: GIF (1 vs 2 frames), WebP VP8X flag / ANIM, APNG acTL, static PNG', () => {
  assert.equal(I.isAnimated(gif(1)), false); assert.equal(I.isAnimated(gif(2)), true); assert.equal(I.isAnimated(gif(5)), true);
  const riff = (...chunks) => { const body = chunks.flat(); return Uint8Array.from([...enc('RIFF'), body.length + 4, 0, 0, 0, ...enc('WEBP'), ...body]); };
  const chunk = (id, data) => [...enc(id), data.length, 0, 0, 0, ...data, ...(data.length & 1 ? [0] : [])];
  assert.equal(I.isAnimated(riff(chunk('VP8X', [0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0]))), true);
  assert.equal(I.isAnimated(riff(chunk('VP8X', [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]), chunk('VP8 ', [1, 2, 3, 4]))), false);
  assert.equal(I.isAnimated(riff(chunk('VP8 ', [1, 2, 3, 4]))), false);
  const png = (...ids) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ids.flatMap(id => [0, 0, 0, 0, ...enc(id), 0, 0, 0, 0])]);
  assert.equal(I.isAnimated(png('IHDR', 'acTL', 'IDAT')), true); assert.equal(I.isAnimated(png('IHDR', 'IDAT')), false);
  assert.equal(I.isAnimated(enc('nothing')), false);
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL', name, '\n ', e.message); }
}
console.log(`image-converter: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
