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

  const MD5_CHUNK = 8 * 1024 * 1024; // read files in 8 MB slices

  /**
   * MD5 of a Blob/File read in slices (never holds the whole file in memory).
   * options: { chunkSize, onProgress(doneBytes, totalBytes), signal (AbortSignal) }. Rejects with name "AbortError" when cancelled.
   * @returns {Promise<Uint8Array>}
   */
  async function md5Blob(blob, { chunkSize = MD5_CHUNK, onProgress, signal } = {}) {
    const h = Saltbox.md5Stream();
    for (let pos = 0; pos < blob.size; pos += chunkSize) {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
      const buf = await blob.slice(pos, Math.min(pos + chunkSize, blob.size)).arrayBuffer();
      h.update(new Uint8Array(buf));
      if (onProgress) onProgress(Math.min(pos + chunkSize, blob.size), blob.size);
    }
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
    return h.digest();
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
    return compareToActual(algorithm, await hashBytes(algorithm, bytes), expected);
  }

  /** Like compareDigest but takes an already computed digest (used for chunked file hashing). */
  function compareToActual(algorithm, actual, expected) {
    const expectedBytes = parseDigest(expected);
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
    ALGORITHMS, getAlgorithm, hashBytes, hashText, md5Blob, MD5_CHUNK,
    compareDigest, compareToActual, algorithmsForHexLength, parseDigest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
