/*
 * hash.js — one-way message digests.
 * A hash cannot be "decrypted". Fast hashes (even SHA-256) are NOT suitable
 * for storing passwords: use a slow, salted KDF such as PBKDF2 (password.js).
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});
  const { requireSubtle, timingSafeEqual } = Saltbox.core;
  const enc = Saltbox.encoding;

  const ALGORITHMS = {
    'MD5': {
      bits: 128, legacy: true,
      note: 'Broken: collisions can be produced in seconds. Use only to check checksums published by older systems.',
    },
    'SHA-1': {
      bits: 160, legacy: true,
      note: 'Deprecated: practical collisions exist (SHAttered, 2017). Use only for compatibility with older systems.',
    },
    'SHA-256': {
      bits: 256, legacy: false,
      note: 'SHA-2 family, 256-bit output. Good for checksums and integrity checks. Too fast to store passwords on its own.',
    },
    'SHA-384': {
      bits: 384, legacy: false,
      note: 'SHA-2 family, a truncated SHA-512 variant with a 384-bit output. Resistant to length-extension attacks.',
    },
    'SHA-512': {
      bits: 512, legacy: false,
      note: 'SHA-2 family, 512-bit output. Often faster than SHA-256 on 64-bit CPUs. Too fast to store passwords on its own.',
    },
  };

  function getAlgorithm(name) {
    const info = ALGORITHMS[name];
    if (!info) throw new Error(`Unsupported hash algorithm: ${name}`);
    return info;
  }

  /** @returns {Promise<Uint8Array>} */
  async function hashBytes(algorithm, bytes) {
    getAlgorithm(algorithm);
    if (algorithm === 'MD5') return Saltbox.md5(bytes); // local, legacy
    const digest = await requireSubtle().digest(algorithm, bytes);
    return new Uint8Array(digest);
  }

  function hashText(algorithm, text) {
    return hashBytes(algorithm, enc.utf8Encode(text));
  }

  /** Lists algorithms whose hex digest has the given number of characters. */
  function algorithmsForHexLength(length) {
    return Object.keys(ALGORITHMS).filter((n) => ALGORITHMS[n].bits / 4 === length);
  }

  /**
   * Parses an expected digest given as hex (any case, optional separators)
   * or Base64. Returns bytes or throws.
   */
  function parseDigest(expected) {
    const trimmed = String(expected).trim();
    if (!trimmed) throw new Error('Paste the hash you want to compare against.');
    try {
      return enc.hexToBytes(trimmed);
    } catch (_) {
      try {
        return enc.base64ToBytes(trimmed);
      } catch (__) {
        throw new Error('The expected hash is neither valid hex nor valid Base64.');
      }
    }
  }

  /**
   * Compares the digest of `bytes` with an expected digest.
   * Uses a constant-time byte comparison.
   */
  async function compareDigest(algorithm, bytes, expected) {
    const expectedBytes = parseDigest(expected);
    const actual = await hashBytes(algorithm, bytes);
    const info = getAlgorithm(algorithm);
    const lengthMatches = expectedBytes.length === actual.length;
    return {
      match: lengthMatches && timingSafeEqual(actual, expectedBytes),
      lengthMatches,
      expectedBits: expectedBytes.length * 8,
      algorithmBits: info.bits,
      likelyAlgorithms: algorithmsForHexLength(expectedBytes.length * 2),
      actualHex: enc.bytesToHex(actual),
    };
  }

  Saltbox.hash = {
    ALGORITHMS, getAlgorithm, hashBytes, hashText,
    compareDigest, algorithmsForHexLength, parseDigest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
