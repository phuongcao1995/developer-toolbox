/*
 * md5.js — local MD5 implementation following RFC 1321.
 *
 * LEGACY ONLY. MD5 is cryptographically broken (practical collisions) and must
 * never be used for passwords or integrity against an attacker. It is included
 * only to check checksums from older systems. Web Crypto does not provide MD5,
 * so this file implements it locally with no network access. Verified against
 * the RFC 1321 test suite in tests/run-tests.js.
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});

  // Per-round left-rotation amounts.
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // K[i] = floor(abs(sin(i + 1)) * 2^32), as defined in RFC 1321.
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
  }

  /** @param {Uint8Array} bytes @returns {Uint8Array} 16-byte digest */
  function md5(bytes) {
    const length = bytes.length;
    // Message + 0x80 + zero padding + 64-bit little-endian bit length.
    const paddedLength = (Math.floor((length + 8) / 64) + 1) * 64;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[length] = 0x80;

    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, (length * 8) >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(length / 0x20000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const M = new Uint32Array(16);

    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let j = 0; j < 16; j++) M[j] = view.getUint32(offset + j * 4, true);

      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }

        F = (F + A + K[i] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, a0, true);
    outView.setUint32(4, b0, true);
    outView.setUint32(8, c0, true);
    outView.setUint32(12, d0, true);
    return out;
  }

  Saltbox.md5 = md5;
})(typeof window !== 'undefined' ? window : globalThis);
