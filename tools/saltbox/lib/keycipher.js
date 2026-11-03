/*
 * keycipher.js — passphrase encryption compatible with CryptoJS.
 *
 * Reproduces CryptoJS.AES.encrypt(text, passphrase).toString() and
 * CryptoJS.AES.decrypt(base64, passphrase) without any external library:
 *   output = Base64("Salted__" + 8-byte salt + AES-256-CBC ciphertext)
 *   key (32 bytes) + IV (16 bytes) = OpenSSL EVP_BytesToKey(MD5, 1 iteration)
 *
 * LEGACY INTEROP ONLY. This scheme has no authentication (a modified message
 * may decrypt to garbage instead of failing) and its key derivation is a single
 * MD5 round, so weak passphrases fall quickly to offline guessing. Prefer the
 * Encrypt / decrypt tab (AES-GCM + PBKDF2) for anything new.
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});
  const { requireSubtle, wipe } = Saltbox.core;
  const enc = Saltbox.encoding;
  const gen = Saltbox.generator;

  const MAGIC = enc.utf8Encode('Salted__');
  const SALT_BYTES = 8;
  const KEY_BYTES = 32;
  const IV_BYTES = 16;
  const HEADER_BYTES = MAGIC.length + SALT_BYTES;

  /** OpenSSL EVP_BytesToKey with MD5 and one iteration, as used by CryptoJS. */
  function deriveKeyAndIv(passphrase, salt) {
    const pass = enc.utf8Encode(passphrase);
    const out = new Uint8Array(KEY_BYTES + IV_BYTES);
    let previous = new Uint8Array(0);
    for (let offset = 0; offset < out.length; offset += 16) {
      const block = new Uint8Array(previous.length + pass.length + salt.length);
      block.set(previous, 0);
      block.set(pass, previous.length);
      block.set(salt, previous.length + pass.length);
      previous = Saltbox.md5(block);
      out.set(previous, offset);
    }
    wipe(pass);
    return { key: out.slice(0, KEY_BYTES), iv: out.slice(KEY_BYTES) };
  }

  async function importAesKey(keyBytes, usage) {
    return requireSubtle().importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [usage]);
  }

  /** Encrypts UTF-8 text; returns the CryptoJS-style Base64 string. */
  async function encryptWithKey(plaintext, passphrase) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('Enter some text to encrypt.');
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('Enter a key.');
    const salt = gen.randomBytes(SALT_BYTES);
    const { key, iv } = deriveKeyAndIv(passphrase, salt);
    try {
      const cryptoKey = await importAesKey(key, 'encrypt');
      const ct = new Uint8Array(await requireSubtle().encrypt({ name: 'AES-CBC', iv }, cryptoKey, enc.utf8Encode(plaintext)));
      const packed = new Uint8Array(HEADER_BYTES + ct.length);
      packed.set(MAGIC, 0);
      packed.set(salt, MAGIC.length);
      packed.set(ct, HEADER_BYTES);
      return enc.bytesToBase64(packed);
    } finally {
      wipe(key); wipe(iv);
    }
  }

  /** Decrypts a CryptoJS-style Base64 string back to UTF-8 text. */
  async function decryptWithKey(encoded, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('Enter a key.');
    let packed;
    try { packed = enc.base64ToBytes(String(encoded || '').trim()); }
    catch (_) { throw new Error('The encrypted text is not valid Base64.'); }
    if (packed.length === 0) throw new Error('Paste the encrypted text to decrypt.');
    const hasMagic = packed.length >= HEADER_BYTES && MAGIC.every((b, i) => packed[i] === b);
    if (!hasMagic) throw new Error('Unrecognised data. Expected CryptoJS/OpenSSL output that starts with "Salted__" (Base64 "U2FsdGVkX1").');
    const body = packed.slice(HEADER_BYTES);
    if (body.length === 0 || body.length % 16 !== 0) throw new Error('The encrypted text is truncated or corrupted.');

    const { key, iv } = deriveKeyAndIv(passphrase, packed.slice(MAGIC.length, HEADER_BYTES));
    try {
      const cryptoKey = await importAesKey(key, 'decrypt');
      const plain = new Uint8Array(await requireSubtle().decrypt({ name: 'AES-CBC', iv }, cryptoKey, body));
      return enc.utf8Decode(plain);
    } catch (_) {
      // Bad padding or non-UTF-8 output: CBC cannot tell a wrong key from damaged data.
      throw new Error('Decryption failed: the key is wrong or the data is corrupted.');
    } finally {
      wipe(key); wipe(iv);
    }
  }

  Saltbox.keycipher = { encryptWithKey, decryptWithKey };
})(typeof window !== 'undefined' ? window : globalThis);
