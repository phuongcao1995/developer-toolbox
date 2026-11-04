// Run from repo root: node tests/unit/base64-converter.test.mjs
import assert from 'node:assert/strict';
import { normalizeBase64, decodeToBytes, detectMime, toDataUri, imgSnippet, cssSnippet, isSafeMime, isImageMime, sanitizeFilename, IMAGE_MAX_BYTES } from '../../tools/base64-converter/logic.js';

let pass = 0;
const t = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };

t('valid data URI mime accepted + lowercased', () => assert.equal(normalizeBase64('data:IMAGE/PNG;base64,AAAA').mime, 'image/png'));
t('hostile mime rejected', () => {
  assert.throws(() => normalizeBase64('data:image/png"onerror="alert(1);base64,AAAA'), /invalid MIME/i);
  assert.throws(() => normalizeBase64('data:image/png"><script>;base64,AAAA'), /invalid MIME/i);
  assert.throws(() => normalizeBase64('data:foo;base64,AAAA'), /invalid MIME/i);
});
t('empty mime still allowed', () => assert.equal(normalizeBase64('data:;base64,AAAA').mime, null));
t('mime predicates', () => {
  assert.ok(isImageMime('image/svg+xml') && !isImageMime('image/png"x') && !isImageMime('text/html'));
  assert.ok(isSafeMime('application/vnd.api+json') && !isSafeMime('a b/c') && !isSafeMime(null));
});
t('toDataUri validates', () => {
  assert.equal(toDataUri('AAAA', 'image/png'), 'data:image/png;base64,AAAA');
  assert.equal(toDataUri('AAAA'), 'data:application/octet-stream;base64,AAAA');
  assert.throws(() => toDataUri('AAAA', 'image/png"x'));
  assert.throws(() => toDataUri('AA"AA', 'image/png'));
});
t('snippets for a good URI', () => {
  const u = 'data:image/png;base64,iVBOR+/=';
  assert.equal(imgSnippet(u), `<img src="${u}" alt="">`);
  assert.equal(cssSnippet(u), `background-image: url("${u}");`);
});
t('snippets reject hostile URIs', () => {
  for (const bad of ['data:image/png"onerror="x;base64,AAAA', 'data:image/png;base64,AA"><script>', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/png;base64,AA\nAA'])
    { assert.throws(() => imgSnippet(bad)); assert.throws(() => cssSnippet(bad)); }
});
const bytes = a => Uint8Array.from(a);
const ascii = s => bytes([...s].map(c => c.charCodeAt(0)));
t('text starting with BM is not bmp', () => {
  assert.equal(detectMime(ascii('BMW makes cars and BMX bikes')), null);
  assert.equal(detectMime(ascii('BM')), null);
  assert.equal(detectMime(ascii('BMI calculator: weight / height^2')), null);
});
t('real BMP header is bmp', () => {
  const b = new Uint8Array(30); b[0] = 0x42; b[1] = 0x4d; b[2] = 30; b[10] = 26;
  assert.equal(detectMime(b), 'image/bmp');
  b[6] = 1; assert.equal(detectMime(b), null); // reserved bytes non-zero
  b[6] = 0; b[2] = 200; assert.equal(detectMime(b), null); // size larger than data
});
t('other sniffing unchanged', () => {
  assert.equal(detectMime(bytes([0x89, 0x50, 0x4e, 0x47, 1, 2])), 'image/png');
  assert.equal(detectMime(ascii('<svg xmlns="x"></svg>')), 'image/svg+xml');
  assert.deepEqual([...decodeToBytes('data:image/png;base64,iVBORw==').bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
t('sanitizeFilename strips control chars, separators, reserved names', () => {
  assert.equal(sanitizeFilename('a\u0000b\nc\u007f.txt'), 'abc.txt');
  assert.equal(sanitizeFilename('../../etc/passwd'), '.._.._etc_passwd'.replace(/^\.+/, ''));
  assert.equal(sanitizeFilename('con.txt'), '_con.txt');
  assert.equal(sanitizeFilename('  . '), 'download');
  assert.equal(sanitizeFilename('x\u202eexe.txt'), 'xexe.txt');
  assert.equal(sanitizeFilename('', 'f.bin'), 'f.bin');
});
t('image cap is 10 MB', () => assert.equal(IMAGE_MAX_BYTES, 10 * 1024 * 1024));
console.log(`${pass} tests passed`);
