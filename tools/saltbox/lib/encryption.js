/*
 * encryption.js — authenticated encryption with AES-GCM (Web Crypto).
 *
 * Security-critical choices:
 *  - A NEW random 96-bit IV is generated for every encryption. Reusing an IV
 *    with the same key breaks AES-GCM confidentiality and authenticity.
 *  - Password mode derives a 256-bit key with PBKDF2 and a fresh random salt.
 *  - The envelope header is bound as Additional Authenticated Data (AAD), so
 *    tampering with the metadata makes decryption fail.
 *  - Keys are created non-extractable; nothing is persisted anywhere.
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});
  const { requireSubtle } = Saltbox.core;
  const enc = Saltbox.encoding;
  const gen = Saltbox.generator;

  const FORMAT = 'saltbox-aes-gcm';
  const VERSION = 1;
  const IV_BYTES = 12;          // 96-bit IV, the recommended size for GCM
  const SALT_BYTES = 16;
  const TAG_BYTES = 16;         // 128-bit tag, appended to ciphertext by Web Crypto
  const PASSWORD_KEY_BITS = 256;
  const ALLOWED_KEY_BITS = [128, 256];
  const ALLOWED_KDF_HASHES = ['SHA-256', 'SHA-512'];
  const ALLOWED_ENCODINGS = ['base64', 'hex'];

  // ---- Keys ---------------------------------------------------------------

  /** Parses a user-supplied raw key (hex or Base64) into 16 or 32 bytes. */
  function parseKey(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Enter a key or generate one.');
    let bytes = null;
    if (/^(0x)?[0-9a-fA-F\s:]+$/.test(trimmed)) {
      try { bytes = enc.hexToBytes(trimmed); } catch (_) { bytes = null; }
    }
    if (!bytes || !ALLOWED_KEY_BITS.includes(bytes.length * 8)) {
      try { bytes = enc.base64ToBytes(trimmed); } catch (_) { bytes = null; }
    }
    if (!bytes || !ALLOWED_KEY_BITS.includes(bytes.length * 8)) {
      throw new Error('A key must be 128 or 256 bits: 32 or 64 hex characters, or the Base64 equivalent.');
    }
    return bytes;
  }

  function generateKey(bits = 256) {
    if (!ALLOWED_KEY_BITS.includes(bits)) throw new Error('Key size must be 128 or 256 bits.');
    return gen.randomBytes(bits / 8);
  }

  function importRawKey(keyBytes) {
    return requireSubtle().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function deriveKeyFromPassword(password, salt, iterations, hash) {
    const subtle = requireSubtle();
    const baseKey = await subtle.importKey('raw', enc.utf8Encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash },
      baseKey,
      { name: 'AES-GCM', length: PASSWORD_KEY_BITS },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ---- Envelope -------------------------------------------------------------

  /** Header fields that are authenticated (AAD). Order is fixed. */
  function buildAad(env) {
    const kdf = env.kdf || {};
    return enc.utf8Encode(JSON.stringify([
      env.format, env.version, env.mode, env.cipher, env.keyBits,
      kdf.name || null, kdf.hash || null, kdf.iterations || null, kdf.salt || null,
      env.encoding,
    ]));
  }

  function validateIterations(iterations) {
    const { minIterations, maxIterations } = Saltbox.password.LIMITS;
    if (!Number.isInteger(iterations) || iterations < minIterations || iterations > maxIterations) {
      throw new Error(`Iterations must be a whole number between ${minIterations} and ${maxIterations.toLocaleString('en-US')}.`);
    }
  }

  /**
   * Encrypts UTF-8 text. Returns an envelope object with all metadata needed
   * to decrypt (except the password or key).
   */
  async function encryptText(plaintext, {
    mode = 'password', password, keyBytes,
    iterations = 600000, hash = 'SHA-256', encoding = 'base64',
  } = {}) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('Enter some text to encrypt.');
    }
    if (!ALLOWED_ENCODINGS.includes(encoding)) throw new Error('Choose Base64 or hex output.');

    const iv = gen.randomBytes(IV_BYTES); // fresh IV every time — never reused
    const envelope = { format: FORMAT, version: VERSION, mode, cipher: 'AES-GCM', encoding };
    let key;

    if (mode === 'password') {
      if (typeof password !== 'string' || password.length === 0) throw new Error('Enter a password.');
      if (!ALLOWED_KDF_HASHES.includes(hash)) throw new Error('Key derivation hash must be SHA-256 or SHA-512.');
      validateIterations(iterations);
      const salt = gen.randomBytes(SALT_BYTES);
      envelope.keyBits = PASSWORD_KEY_BITS;
      envelope.kdf = { name: 'PBKDF2', hash, iterations, salt: enc.encodeBytes(salt, encoding) };
      key = await deriveKeyFromPassword(password, salt, iterations, hash);
    } else if (mode === 'key') {
      if (!(keyBytes instanceof Uint8Array) || !ALLOWED_KEY_BITS.includes(keyBytes.length * 8)) {
        throw new Error('A key must be 128 or 256 bits.');
      }
      envelope.keyBits = keyBytes.length * 8;
      key = await importRawKey(keyBytes);
    } else {
      throw new Error(`Unknown key source: ${mode}`);
    }

    envelope.iv = enc.encodeBytes(iv, encoding);
    const ciphertext = await requireSubtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(envelope), tagLength: TAG_BYTES * 8 },
      key,
      enc.utf8Encode(plaintext)
    );
    envelope.ciphertext = enc.encodeBytes(new Uint8Array(ciphertext), encoding);
    return envelope;
  }

  function serializeEnvelope(envelope) {
    return JSON.stringify(envelope, null, 2);
  }

  /** Parses and strictly validates an exported envelope. */
  function parseEnvelope(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Paste the encrypted data (the JSON block produced by Encrypt).');
    let env;
    try {
      env = JSON.parse(trimmed);
    } catch (_) {
      throw new Error('The encrypted data is not valid JSON. Paste the complete block, including the braces.');
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('The encrypted data must be a JSON object.');
    if (env.format !== FORMAT) throw new Error(`Unrecognised format. Expected "${FORMAT}".`);
    if (env.version !== VERSION) throw new Error(`Unsupported version ${String(env.version).slice(0, 10)}. This tool reads version ${VERSION}.`);
    if (env.cipher !== 'AES-GCM') throw new Error('Unsupported cipher. Only AES-GCM is supported.');
    if (!ALLOWED_ENCODINGS.includes(env.encoding)) throw new Error('The "encoding" field must be "base64" or "hex".');
    if (!ALLOWED_KEY_BITS.includes(env.keyBits)) throw new Error('The "keyBits" field must be 128 or 256.');
    if (env.mode !== 'password' && env.mode !== 'key') throw new Error('The "mode" field must be "password" or "key".');

    const decode = (value, field) => {
      if (typeof value !== 'string') throw new Error(`The "${field}" field is missing.`);
      try { return enc.decodeToBytes(value, env.encoding); }
      catch (_) { throw new Error(`The "${field}" field is not valid ${env.encoding === 'hex' ? 'hex' : 'Base64'}.`); }
    };

    const parsed = { envelope: env, iv: decode(env.iv, 'iv'), ciphertext: decode(env.ciphertext, 'ciphertext') };
    if (parsed.iv.length !== IV_BYTES) throw new Error(`The IV must be ${IV_BYTES} bytes.`);
    if (parsed.ciphertext.length < TAG_BYTES) throw new Error('The ciphertext is too short to contain an authentication tag.');

    if (env.mode === 'password') {
      const kdf = env.kdf;
      if (!kdf || kdf.name !== 'PBKDF2') throw new Error('Password-encrypted data must include PBKDF2 parameters.');
      if (!ALLOWED_KDF_HASHES.includes(kdf.hash)) throw new Error('The KDF hash must be SHA-256 or SHA-512.');
      if (env.keyBits !== PASSWORD_KEY_BITS) throw new Error('Password-encrypted data must use a 256-bit key.');
      validateIterations(kdf.iterations);
      parsed.salt = decode(kdf.salt, 'kdf.salt');
      if (parsed.salt.length < 8 || parsed.salt.length > 64) throw new Error('The salt must be between 8 and 64 bytes.');
    } else if (env.kdf !== undefined) {
      throw new Error('Key-encrypted data must not include KDF parameters.');
    }
    return parsed;
  }

  /** Decrypts an envelope string. Throws a clear error on any failure. */
  async function decryptText(envelopeText, { password, keyBytes } = {}) {
    const parsed = parseEnvelope(envelopeText);
    const env = parsed.envelope;
    let key;
    if (env.mode === 'password') {
      if (typeof password !== 'string' || password.length === 0) throw new Error('This data was encrypted with a password. Enter it to decrypt.');
      key = await deriveKeyFromPassword(password, parsed.salt, env.kdf.iterations, env.kdf.hash);
    } else {
      if (!(keyBytes instanceof Uint8Array)) throw new Error('This data was encrypted with a raw key. Enter the key to decrypt.');
      if (keyBytes.length * 8 !== env.keyBits) throw new Error(`This data needs a ${env.keyBits}-bit key, but the key entered is ${keyBytes.length * 8} bits.`);
      key = await importRawKey(keyBytes);
    }

    let plainBytes;
    try {
      plainBytes = await requireSubtle().decrypt(
        { name: 'AES-GCM', iv: parsed.iv, additionalData: buildAad(env), tagLength: TAG_BYTES * 8 },
        key,
        parsed.ciphertext
      );
    } catch (_) {
      // GCM gives no detail by design: wrong key and tampering look identical.
      throw new Error('Decryption failed: the password or key is wrong, or the data has been modified.');
    }
    return enc.utf8Decode(new Uint8Array(plainBytes));
  }

  Saltbox.encryption = {
    FORMAT, VERSION, IV_BYTES, SALT_BYTES, TAG_BYTES,
    parseKey, generateKey, encryptText, decryptText,
    serializeEnvelope, parseEnvelope,
  };
})(typeof window !== 'undefined' ? window : globalThis);
