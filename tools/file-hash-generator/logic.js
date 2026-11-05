// Pure, DOM-free logic for the File Hash Generator.
// Incremental MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 / HMAC in plain JS (tested against node:crypto),
// WebCrypto-backed fast path for smaller inputs, checksum-file parsing/formatting and hash comparison.

export const ALGOS = ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
export const DIGEST_BYTES = { 'MD5': 16, 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };
export const BLOCK_BYTES = { 'MD5': 64, 'SHA-1': 64, 'SHA-256': 64, 'SHA-384': 128, 'SHA-512': 128 };
export const CHUNK_BYTES = 8 * 1024 * 1024;            // Blob.slice() read size
export const INCREMENTAL_THRESHOLD = 64 * 1024 * 1024; // >= this: pure-JS incremental (progress + cancel); below: WebCrypto
export const TEXT_MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------- hashers
class BlockHasher {
  constructor(blockSize) { this._bs = blockSize; this._buf = new Uint8Array(blockSize); this._n = 0; this._len = 0; this._done = false; }
  update(data) {
    if (this._done) throw new Error('Hasher already finalised');
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    let i = 0; const len = data.length; this._len += len;
    if (this._n) {
      const take = Math.min(this._bs - this._n, len);
      this._buf.set(data.subarray(0, take), this._n); this._n += take; i = take;
      if (this._n === this._bs) { this._block(this._buf, 0); this._n = 0; }
    }
    for (; i + this._bs <= len; i += this._bs) this._block(data, i);
    if (i < len) { this._buf.set(data.subarray(i), 0); this._n = len - i; }
    return this;
  }
  _pad(lenBytes, littleEndian) {
    const bs = this._bs, bits = this._len * 8;
    const padLen = (this._n < bs - lenBytes ? bs : 2 * bs) - this._n;
    const pad = new Uint8Array(padLen); pad[0] = 0x80;
    const hi = Math.floor(bits / 4294967296), lo = bits >>> 0, dv = new DataView(pad.buffer);
    if (littleEndian) { dv.setUint32(padLen - 8, lo, true); dv.setUint32(padLen - 4, hi, true); }
    else { dv.setUint32(padLen - 8, hi, false); dv.setUint32(padLen - 4, lo, false); }
    const savedLen = this._len; this.update(pad); this._len = savedLen; this._done = true;
  }
}

const ROTL = (x, n) => (x << n) | (x >>> (32 - n));
const ROTR = (x, n) => (x >>> n) | (x << (32 - n));

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

export class Md5 extends BlockHasher {
  constructor() { super(64); this.h = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476); this.w = new Uint32Array(16); }
  _block(d, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) { const j = o + i * 4; w[i] = d[j] | (d[j + 1] << 8) | (d[j + 2] << 16) | (d[j + 3] << 24); }
    let a = this.h[0], b = this.h[1], c = this.h[2], dd = this.h[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & dd); g = i; }
      else if (i < 32) { f = (dd & b) | (~dd & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ dd; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~dd); g = (7 * i) & 15; }
      const t = dd; dd = c; c = b;
      b = (b + ROTL((a + f + MD5_K[i] + w[g]) | 0, MD5_S[i])) | 0; a = t;
    }
    this.h[0] += a; this.h[1] += b; this.h[2] += c; this.h[3] += dd;
  }
  digest() {
    this._pad(8, true);
    const out = new Uint8Array(16), dv = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) dv.setUint32(i * 4, this.h[i], true);
    return out;
  }
}

export class Sha1 extends BlockHasher {
  constructor() { super(64); this.h = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0); this.w = new Uint32Array(80); }
  _block(d, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) { const j = o + i * 4; w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3]; }
    for (let i = 16; i < 80; i++) w[i] = ROTL(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = this.h[0], b = this.h[1], c = this.h[2], dd = this.h[3], e = this.h[4];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & dd); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ dd; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & dd) | (c & dd); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ dd; k = 0xca62c1d6; }
      const t = (ROTL(a, 5) + f + e + k + w[i]) | 0;
      e = dd; dd = c; c = ROTL(b, 30); b = a; a = t;
    }
    this.h[0] += a; this.h[1] += b; this.h[2] += c; this.h[3] += dd; this.h[4] += e;
  }
  digest() {
    this._pad(8, false);
    const out = new Uint8Array(20), dv = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) dv.setUint32(i * 4, this.h[i], false);
    return out;
  }
}

// SHA-2 constants are derived (fractional parts of square/cube roots of primes) with exact BigInt math,
// which avoids transcription errors; the results are verified against node:crypto in the tests.
function primes(n) { const p = []; for (let c = 2; p.length < n; c++) if (p.every(q => c % q)) p.push(c); return p; }
function iroot(n, k) { // floor(n^(1/k)) for BigInt
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
  for (;;) { const y = ((BigInt(k) - 1n) * x + n / x ** (BigInt(k) - 1n)) / BigInt(k); if (y >= x) return x; x = y; }
}
const fracBits = (p, k, bits) => iroot(BigInt(p) * (1n << BigInt(bits * k)), k) & ((1n << BigInt(bits)) - 1n);
const P80 = primes(80);
const K256 = Uint32Array.from(P80.slice(0, 64), p => Number(fracBits(p, 3, 32)));
const H256 = Uint32Array.from(P80.slice(0, 8), p => Number(fracBits(p, 2, 32)));
const K512 = new Uint32Array(160); // hi, lo pairs
P80.forEach((p, i) => { const v = fracBits(p, 3, 64); K512[i * 2] = Number(v >> 32n); K512[i * 2 + 1] = Number(v & 0xffffffffn); });
const initH512 = start => { const h = new Uint32Array(16); P80.slice(start, start + 8).forEach((p, i) => { const v = fracBits(p, 2, 64); h[i * 2] = Number(v >> 32n); h[i * 2 + 1] = Number(v & 0xffffffffn); }); return h; };
const H512 = initH512(0), H384 = initH512(8);

export class Sha256 extends BlockHasher {
  constructor() { super(64); this.h = Uint32Array.from(H256); this.w = new Uint32Array(64); }
  _block(d, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) { const j = o + i * 4; w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3]; }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (ROTR(a, 7) ^ ROTR(a, 18) ^ (a >>> 3)) + w[i - 7] + (ROTR(b, 17) ^ ROTR(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, dd, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const s = this.h; s[0] += a; s[1] += b; s[2] += c; s[3] += dd; s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
  digest() {
    this._pad(8, false);
    const out = new Uint8Array(32), dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.h[i], false);
    return out;
  }
}

// SHA-512 / SHA-384 using 32-bit hi/lo pairs.
export class Sha512 extends BlockHasher {
  constructor(is384 = false) { super(128); this.is384 = is384; this.h = Uint32Array.from(is384 ? H384 : H512); this.w = new Uint32Array(160); }
  _block(d, o) {
    const w = this.w;
    for (let i = 0; i < 32; i++) { const j = o + i * 4; w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3]; }
    for (let t = 16; t < 80; t++) {
      const i15 = (t - 15) * 2, i2 = (t - 2) * 2, h15 = w[i15], l15 = w[i15 + 1], h2 = w[i2], l2 = w[i2 + 1];
      // sigma0 = ROTR1 ^ ROTR8 ^ SHR7
      const s0h = ((h15 >>> 1) | (l15 << 31)) ^ ((h15 >>> 8) | (l15 << 24)) ^ (h15 >>> 7);
      const s0l = ((l15 >>> 1) | (h15 << 31)) ^ ((l15 >>> 8) | (h15 << 24)) ^ ((l15 >>> 7) | (h15 << 25));
      // sigma1 = ROTR19 ^ ROTR61 ^ SHR6
      const s1h = ((h2 >>> 19) | (l2 << 13)) ^ ((l2 >>> 29) | (h2 << 3)) ^ (h2 >>> 6);
      const s1l = ((l2 >>> 19) | (h2 << 13)) ^ ((h2 >>> 29) | (l2 << 3)) ^ ((l2 >>> 6) | (h2 << 26));
      const lo = (w[(t - 16) * 2 + 1] >>> 0) + (s0l >>> 0) + (w[(t - 7) * 2 + 1] >>> 0) + (s1l >>> 0);
      w[t * 2 + 1] = lo | 0; // low word
      w[t * 2] = (w[(t - 16) * 2] + s0h + w[(t - 7) * 2] + s1h + Math.floor(lo / 4294967296)) | 0;
    }
    const s = this.h;
    let ah = s[0], al = s[1], bh = s[2], bl = s[3], ch = s[4], cl = s[5], dh = s[6], dl = s[7];
    let eh = s[8], el = s[9], fh = s[10], fl = s[11], gh = s[12], gl = s[13], hh = s[14], hl = s[15];
    for (let t = 0; t < 80; t++) {
      // Sigma1(e) = ROTR14 ^ ROTR18 ^ ROTR41
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      const t1lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[t * 2 + 1] >>> 0) + (w[t * 2 + 1] >>> 0);
      const t1l = t1lo | 0;
      const t1h = (hh + S1h + chh + K512[t * 2] + w[t * 2] + Math.floor(t1lo / 4294967296)) | 0;
      // Sigma0(a) = ROTR28 ^ ROTR34 ^ ROTR39
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2lo = (S0l >>> 0) + (mjl >>> 0);
      const t2l = t2lo | 0, t2h = (S0h + mjh + Math.floor(t2lo / 4294967296)) | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      const elo = (dl >>> 0) + (t1l >>> 0);
      el = elo | 0; eh = (dh + t1h + Math.floor(elo / 4294967296)) | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      const alo = (t1l >>> 0) + (t2l >>> 0);
      al = alo | 0; ah = (t1h + t2h + Math.floor(alo / 4294967296)) | 0;
    }
    const add = (i, hi, lo) => { const l = (s[i + 1] >>> 0) + (lo >>> 0); s[i + 1] = l | 0; s[i] = (s[i] + hi + Math.floor(l / 4294967296)) | 0; };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  digest() {
    this._pad(16, false);
    const n = this.is384 ? 48 : 64, out = new Uint8Array(n), dv = new DataView(out.buffer);
    for (let i = 0; i < n / 4; i++) dv.setUint32(i * 4, this.h[i], false);
    return out;
  }
}

export function createHasher(algo) {
  switch (algo) {
    case 'MD5': return new Md5();
    case 'SHA-1': return new Sha1();
    case 'SHA-256': return new Sha256();
    case 'SHA-384': return new Sha512(true);
    case 'SHA-512': return new Sha512(false);
    default: throw new Error(`Unsupported algorithm: ${algo}`);
  }
}

/** Incremental HMAC (RFC 2104) over any hasher above. */
export class Hmac {
  constructor(algo, key) {
    this.algo = algo; const bs = BLOCK_BYTES[algo];
    if (typeof key === 'string') key = new TextEncoder().encode(key);
    if (key.length > bs) key = createHasher(algo).update(key).digest();
    const k = new Uint8Array(bs); k.set(key);
    this.opad = k.map(b => b ^ 0x5c);
    this.inner = createHasher(algo).update(k.map(b => b ^ 0x36));
  }
  update(d) { this.inner.update(d); return this; }
  digest() { return createHasher(this.algo).update(this.opad).update(this.inner.digest()).digest(); }
}

export const hashBytesSync = (algo, data) => createHasher(algo).update(data).digest();

// ---------------------------------------------------------------- encodings
export function toHex(bytes, upper = false) {
  let s = ''; for (let i = 0; i < bytes.length; i++) s += (bytes[i] + 256).toString(16).slice(1);
  return upper ? s.toUpperCase() : s;
}
export function toBase64(bytes) {
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function formatDigest(bytes, format = 'hex') {
  return format === 'HEX' ? toHex(bytes, true) : format === 'base64' ? toBase64(bytes) : toHex(bytes);
}
export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '').replace(/[\s:_-]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('Key contains non-hex characters.');
  if (h.length % 2) throw new Error('Hex key must have an even number of digits.');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
/** Parse an HMAC key given as 'text' (UTF-8) or 'hex'. Throws a readable Error. */
export function parseKey(value, kind) {
  return kind === 'hex' ? hexToBytes(value) : new TextEncoder().encode(value);
}

// ---------------------------------------------------------------- compare
/** Compare two strings without early exit on the first differing character. */
export function constantTimeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i % (x.length || 1)) || 0) ^ (y.charCodeAt(i % (y.length || 1)) || 0);
  return diff === 0;
}

const B64_BYTES = new Set(Object.values(DIGEST_BYTES));
function b64ToBytes(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+$/.test(t) || t.length % 4 === 1) return null;
  try { const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); } catch { return null; }
}
export const algosForByteLength = n => ALGOS.filter(a => DIGEST_BYTES[a] === n);

/**
 * Interpret a user-pasted expected hash. Accepts hex (any case, optional spaces/colons, optional "sha256:" prefix),
 * or base64. Returns { hex, algos } where algos is the list of algorithms with that digest length, or { error }.
 */
export function parseExpectedHash(input) {
  let s = String(input ?? '').trim();
  if (!s) return { error: 'empty' };
  s = s.replace(/^(md5|sha-?1|sha-?256|sha-?384|sha-?512)\s*[:=]\s*/i, '');
  const compact = s.replace(/[\s:]/g, '');
  if (/^[0-9a-fA-F]+$/.test(compact)) {
    const bytes = compact.length / 2;
    if (compact.length % 2 || !B64_BYTES.has(bytes)) return { error: `A ${compact.length}-character hex string is not a known digest length (32, 40, 64, 96 or 128 hex characters).` };
    return { hex: compact.toLowerCase(), algos: algosForByteLength(bytes), format: 'hex' };
  }
  const raw = b64ToBytes(s.replace(/\s/g, ''));
  if (raw && B64_BYTES.has(raw.length)) return { hex: toHex(raw), algos: algosForByteLength(raw.length), format: 'base64' };
  return { error: 'Not recognised as a hex or base64 digest.' };
}

// ---------------------------------------------------------------- checksum files
/**
 * Parse GNU (`hash  name`, `hash *name`) and BSD (`SHA256 (name) = hash`) checksum lines. '#' comments and blank lines are skipped.
 * Returns { entries: [{ hash, name, algos, line }], errors: [{ line, text }] }.
 */
export function parseChecksumFile(text) {
  const entries = [], errors = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, idx) => {
    let line = raw.replace(/^﻿/, '');
    if (!line.trim() || /^\s*[#;]/.test(line)) return;
    let m = /^\s*(MD5|SHA-?1|SHA-?224|SHA-?256|SHA-?384|SHA-?512)\s*\((.+)\)\s*=\s*([0-9a-fA-F]+)\s*$/i.exec(line);
    let hash, name, algoHint = null;
    if (m) { hash = m[3]; name = m[2]; algoHint = m[1].toUpperCase().replace(/^SHA(\d)/, 'SHA-$1'); }
    else {
      m = /^\s*\\?([0-9a-fA-F]{32,128})[ \t]+[ *]?(.+?)\s*$/.exec(line);
      if (!m) { errors.push({ line: idx + 1, text: raw.trim() }); return; }
      hash = m[1]; name = m[2];
      if (/^\s*\\/.test(line)) name = name.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    }
    const algos = algosForByteLength(hash.length / 2);
    if (hash.length % 2 || !algos.length) { errors.push({ line: idx + 1, text: raw.trim() }); return; }
    entries.push({ hash: hash.toLowerCase(), name, algos: algoHint && algos.includes(algoHint) ? [algoHint] : algos, line: idx + 1 });
  });
  return { entries, errors };
}

const baseName = n => String(n).split(/[\\/]/).pop();
/** Find the dropped file matching a checksum entry name (exact first, then by base name). Returns index or -1. */
export function matchFileName(entryName, fileNames) {
  let i = fileNames.indexOf(entryName); if (i >= 0) return i;
  const b = baseName(entryName); i = fileNames.findIndex(n => baseName(n) === b); return i;
}

/** `hash  name` lines, sha256sum style (two spaces = text mode, as GNU coreutils prints). Newline in names is escaped per GNU. */
export function formatChecksumFile(rows, { binary = false } = {}) {
  return rows.map(({ hex, name }) => {
    const esc = /[\\\n]/.test(name);
    const n = esc ? name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n') : name;
    return `${esc ? '\\' : ''}${hex}${binary ? ' *' : '  '}${n}`;
  }).join('\n') + (rows.length ? '\n' : '');
}
export const checksumExtension = algo => ({ 'MD5': 'md5', 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' }[algo] || 'txt');

/** Group result items by identical digest for one algorithm. items: [{name, digests:{algo:Uint8Array}}] */
export function groupIdentical(items, algo) {
  const map = new Map();
  for (const it of items) { const d = it.digests?.[algo]; if (!d) continue; const k = toHex(d); (map.get(k) || map.set(k, []).get(k)).push(it.name); }
  return [...map.entries()].map(([hex, names]) => ({ hex, names }));
}

// ---------------------------------------------------------------- hashing drivers
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const subtle = () => globalThis.crypto?.subtle;
const SUBTLE_NAME = { 'SHA-1': 'SHA-1', 'SHA-256': 'SHA-256', 'SHA-384': 'SHA-384', 'SHA-512': 'SHA-512' };

/** Hash a Uint8Array with every requested algorithm. Uses WebCrypto for SHA-* when available. Returns { [algo]: Uint8Array }. */
export async function hashBytes(data, algos, key = null) {
  const out = {};
  for (const algo of algos) {
    if (algo !== 'MD5' && subtle() && !(key && key.length === 0)) {
      try {
        if (key) {
          const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: SUBTLE_NAME[algo] }, false, ['sign']);
          out[algo] = new Uint8Array(await subtle().sign('HMAC', k, data));
        } else out[algo] = new Uint8Array(await subtle().digest(SUBTLE_NAME[algo], data));
        continue;
      } catch { /* fall through to JS */ }
    }
    out[algo] = key ? new Hmac(algo, key).update(data).digest() : hashBytesSync(algo, data);
  }
  return out;
}

/**
 * Hash a Blob/File. opts: { algos, key (Uint8Array|null), chunkSize, threshold, onProgress(done,total), isCancelled() }.
 * Below `threshold` the data is read in slices and hashed with WebCrypto (MD5 and empty-key HMAC in JS);
 * at/above it every algorithm is fed incrementally slice by slice so progress and cancel stay responsive.
 * Returns { digests, method: 'webcrypto' | 'incremental' }.
 */
export async function hashBlob(blob, opts) {
  const { algos, key = null, chunkSize = CHUNK_BYTES, threshold = INCREMENTAL_THRESHOLD, onProgress, isCancelled } = opts;
  const total = blob.size, check = () => { if (isCancelled?.()) throw abortError(); };
  onProgress?.(0, total);
  if (total < threshold) {
    const buf = new Uint8Array(total);
    for (let off = 0; off < total; off += chunkSize) {
      check();
      buf.set(new Uint8Array(await blob.slice(off, Math.min(total, off + chunkSize)).arrayBuffer()), off);
      onProgress?.(Math.min(total, off + chunkSize), total);
    }
    check();
    return { digests: await hashBytes(buf, algos, key), method: 'webcrypto' };
  }
  const hs = algos.map(a => key ? new Hmac(a, key) : createHasher(a));
  for (let off = 0; off < total; off += chunkSize) {
    check();
    const part = new Uint8Array(await blob.slice(off, Math.min(total, off + chunkSize)).arrayBuffer());
    for (const h of hs) h.update(part);
    onProgress?.(Math.min(total, off + chunkSize), total);
  }
  const digests = {}; algos.forEach((a, i) => { digests[a] = hs[i].digest(); });
  return { digests, method: 'incremental' };
}

// ---------------------------------------------------------------- misc formatting
export function formatThroughput(bytes, ms) {
  if (!(ms > 0) || !bytes) return '';
  const mbps = bytes / 1048576 / (ms / 1000);
  return `${mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} MB/s`;
}
export function formatDuration(ms) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`; }
export const sizeLabel = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

/** Plain-text report. items: [{name,size,digests}] */
export function resultsToText(items, algos, format) {
  return items.map(it => [it.name + (it.size != null ? `  (${sizeLabel(it.size)})` : ''), ...algos.filter(a => it.digests?.[a]).map(a => `  ${a.padEnd(8)} ${formatDigest(it.digests[a], format)}`)].join('\n')).join('\n\n');
}
export function resultsToJson(items, algos, format, extra = {}) {
  return JSON.stringify({ ...extra, results: items.map(it => ({ name: it.name, ...(it.size != null ? { size: it.size } : {}), hashes: Object.fromEntries(algos.filter(a => it.digests?.[a]).map(a => [a, formatDigest(it.digests[a], format)])) })) }, null, 2);
}
