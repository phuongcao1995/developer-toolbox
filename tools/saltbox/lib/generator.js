/*
 * generator.js — cryptographically secure random values.
 * All randomness comes from crypto.getRandomValues(); Math.random() is never used.
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});
  const enc = Saltbox.encoding;

  const MAX_BYTES = 4096;
  const MAX_CHARS = 4096;
  const MAX_COUNT = 50;

  const CHARSETS = {
    alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
  };

  function getRandomValuesSafe(array) {
    const c = root.crypto;
    if (!c || typeof c.getRandomValues !== 'function') {
      throw new Error('Secure randomness (crypto.getRandomValues) is unavailable in this browser.');
    }
    // getRandomValues accepts at most 65,536 bytes per call.
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i += 65536) {
      c.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
    }
    return array;
  }

  function randomBytes(length) {
    if (!Number.isInteger(length) || length < 1) {
      throw new Error('Length must be a whole number of at least 1.');
    }
    return getRandomValuesSafe(new Uint8Array(length));
  }

  /**
   * Uniform random integer in [0, max). Uses rejection sampling so that no
   * value is more likely than another (a plain modulo would introduce bias).
   */
  function randomInt(max) {
    if (!Number.isInteger(max) || max < 1 || max > 0x100000000) {
      throw new Error('randomInt: max out of range.');
    }
    const limit = 0x100000000 - (0x100000000 % max);
    const buf = new Uint32Array(1);
    let value;
    do {
      getRandomValuesSafe(buf);
      value = buf[0];
    } while (value >= limit);
    return value % max;
  }

  function randomString(length, charset) {
    if (!charset || charset.length < 2) throw new Error('Character set is too small.');
    let out = '';
    for (let i = 0; i < length; i++) out += charset[randomInt(charset.length)];
    return out;
  }

  /**
   * Generator definitions. `unit` says what the length means; `entropy`
   * returns the number of random bits in one generated value.
   */
  const TYPES = {
    salt: {
      label: 'Salt', unit: 'bytes', defaultLength: 16, min: 8, max: 64, encodings: ['hex', 'base64', 'base64url'],
      note: 'A salt makes identical passwords hash differently. It is stored next to the hash and is not secret. Use 16 bytes or more, unique per password.',
      make: (len, o) => enc.encodeBytes(randomBytes(len), o.encoding),
      entropy: (len) => len * 8,
    },
    key: {
      label: 'AES key', unit: 'bits', defaultLength: 256, fixed: [128, 256], encodings: ['hex', 'base64', 'base64url'],
      note: 'Raw AES key material. Anyone with this key can decrypt your data, so treat it like a password and store it securely.',
      make: (len, o) => enc.encodeBytes(randomBytes(len / 8), o.encoding),
      entropy: (len) => len,
    },
    iv: {
      label: 'AES-GCM IV', unit: 'bytes', defaultLength: 12, fixed: [12], encodings: ['hex', 'base64', 'base64url'],
      note: '96-bit (12-byte) nonce for AES-GCM. Never reuse an IV with the same key. The Encrypt tool generates a fresh one automatically.',
      make: (len, o) => enc.encodeBytes(randomBytes(len), o.encoding),
      entropy: (len) => len * 8,
    },
    hex: {
      label: 'Hex string', unit: 'characters', defaultLength: 32, min: 1, max: MAX_CHARS,
      note: 'Each hex character carries 4 bits of randomness.',
      make: (len) => enc.bytesToHex(randomBytes(Math.ceil(len / 2))).slice(0, len),
      entropy: (len) => len * 4,
    },
    base64: {
      label: 'Base64 string', unit: 'bytes', defaultLength: 32, min: 1, max: MAX_BYTES,
      note: 'Random bytes encoded as standard Base64. The length is the number of random bytes, not output characters.',
      make: (len) => enc.bytesToBase64(randomBytes(len)),
      entropy: (len) => len * 8,
    },
    password: {
      label: 'Password', unit: 'characters', defaultLength: 20, min: 8, max: 256,
      note: 'Each character is drawn uniformly from the selected set using rejection sampling, so no character is more likely than another.',
      make: (len, o) => randomString(len, CHARSETS.alphanumeric + (o.symbols ? CHARSETS.symbols : '')),
      entropy: (len, o) => len * Math.log2(CHARSETS.alphanumeric.length + (o.symbols ? CHARSETS.symbols.length : 0)),
    },
    token: {
      label: 'URL-safe token', unit: 'bytes', defaultLength: 32, min: 8, max: MAX_BYTES,
      note: 'Random bytes as Base64URL without padding, safe for URLs, cookies and file names. 32 bytes (256 bits) suits session or reset tokens.',
      make: (len) => enc.bytesToBase64Url(randomBytes(len)),
      entropy: (len) => len * 8,
    },
  };

  function validateLength(type, length) {
    const def = TYPES[type];
    if (!def) throw new Error(`Unknown generator type: ${type}`);
    if (!Number.isInteger(length)) throw new Error('Length must be a whole number.');
    if (def.fixed) {
      if (!def.fixed.includes(length)) {
        throw new Error(`${def.label} length must be ${def.fixed.join(' or ')} ${def.unit}.`);
      }
    } else if (length < def.min || length > def.max) {
      throw new Error(`${def.label} length must be between ${def.min} and ${def.max} ${def.unit}.`);
    }
    return def;
  }

  /** @returns {{values: string[], entropyBits: number}} */
  function generate(type, { length, count = 1, encoding = 'hex', symbols = false } = {}) {
    const def = validateLength(type, length);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      throw new Error(`Count must be between 1 and ${MAX_COUNT}.`);
    }
    if (def.encodings && !def.encodings.includes(encoding)) {
      throw new Error(`Unsupported encoding for ${def.label}: ${encoding}`);
    }
    const options = { encoding, symbols };
    const values = [];
    for (let i = 0; i < count; i++) values.push(def.make(length, options));
    return { values, entropyBits: def.entropy(length, options) };
  }

  Saltbox.generator = {
    TYPES, CHARSETS, MAX_COUNT,
    randomBytes, randomInt, randomString, generate,
  };
})(typeof window !== 'undefined' ? window : globalThis);
