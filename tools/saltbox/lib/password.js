/*
 * password.js — salted password hashing with PBKDF2 (Web Crypto).
 *
 * PBKDF2 is deliberately slow: every guess an attacker makes costs
 * `iterations` HMAC computations. The salt makes each hash unique so
 * precomputed (rainbow) tables are useless. A salt is NOT a secret.
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});
  const { requireSubtle, timingSafeEqual } = Saltbox.core;
  const enc = Saltbox.encoding;

  // Iteration recommendations from the OWASP Password Storage Cheat Sheet (2023+).
  const PRESETS = {
    'SHA-256': { recommendedIterations: 600000, defaultLength: 32, phcId: 'pbkdf2-sha256' },
    'SHA-512': { recommendedIterations: 210000, defaultLength: 64, phcId: 'pbkdf2-sha512' },
  };

  const LIMITS = {
    minIterations: 1,
    maxIterations: 10000000, // guards against hostile inputs freezing the tab
    minSaltBytes: 1,
    recommendedSaltBytes: 16,
    maxSaltBytes: 1024,
    minLength: 16,
    maxLength: 512,
  };

  function getPreset(hash) {
    const preset = PRESETS[hash];
    if (!preset) throw new Error(`Unsupported PBKDF2 hash: ${hash}. Choose SHA-256 or SHA-512.`);
    return preset;
  }

  function validateParams({ hash, iterations, salt, length }) {
    getPreset(hash);
    if (!Number.isInteger(iterations) || iterations < LIMITS.minIterations || iterations > LIMITS.maxIterations) {
      throw new Error(`Iterations must be a whole number between ${LIMITS.minIterations} and ${LIMITS.maxIterations.toLocaleString('en-US')}.`);
    }
    if (!(salt instanceof Uint8Array) || salt.length < LIMITS.minSaltBytes || salt.length > LIMITS.maxSaltBytes) {
      throw new Error('Enter or generate a salt (1 to 1024 bytes).');
    }
    if (!Number.isInteger(length) || length < LIMITS.minLength || length > LIMITS.maxLength) {
      throw new Error(`Output length must be between ${LIMITS.minLength} and ${LIMITS.maxLength} bytes.`);
    }
  }

  /** Returns human-readable warnings for weak parameter choices. */
  function assessParams({ hash, iterations, saltLength }) {
    const warnings = [];
    const preset = PRESETS[hash];
    if (preset && Number.isFinite(iterations) && iterations < preset.recommendedIterations) {
      warnings.push(
        `${iterations.toLocaleString('en-US')} iterations is below the recommended ` +
        `${preset.recommendedIterations.toLocaleString('en-US')} for PBKDF2-${hash}. ` +
        'Fewer iterations make offline guessing cheaper.'
      );
    }
    if (Number.isFinite(saltLength) && saltLength > 0 && saltLength < LIMITS.recommendedSaltBytes) {
      warnings.push(`A ${saltLength}-byte salt is short. Use at least ${LIMITS.recommendedSaltBytes} random bytes.`);
    }
    return warnings;
  }

  /** Core derivation: PBKDF2-HMAC-<hash>. @returns {Promise<Uint8Array>} */
  async function pbkdf2(passwordBytes, salt, iterations, hash, length) {
    validateParams({ hash, iterations, salt, length });
    const subtle = requireSubtle();
    // The password is imported as non-extractable key material.
    const baseKey = await subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', hash, salt, iterations },
      baseKey,
      length * 8
    );
    return new Uint8Array(bits);
  }

  /**
   * Hashes a password. If no salt is supplied, a fresh 16-byte random salt
   * is generated.
   */
  async function hashPassword(password, { hash = 'SHA-256', iterations, salt, length } = {}) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Enter a password to hash.');
    }
    const preset = getPreset(hash);
    const params = {
      hash,
      iterations: iterations ?? preset.recommendedIterations,
      salt: salt ?? Saltbox.generator.randomBytes(LIMITS.recommendedSaltBytes),
      length: length ?? preset.defaultLength,
    };
    const started = (root.performance || Date).now();
    const derived = await pbkdf2(enc.utf8Encode(password), params.salt, params.iterations, params.hash, params.length);
    const elapsedMs = (root.performance || Date).now() - started;
    return { ...params, derived, elapsedMs, encoded: encodePHC({ ...params, derived }) };
  }

  /**
   * PHC-style string: $pbkdf2-sha256$i=600000$<salt>$<hash>
   * (salt and hash in unpadded standard Base64, as in the PHC string format).
   */
  function encodePHC({ hash, iterations, salt, derived }) {
    const b64 = (b) => enc.bytesToBase64(b).replace(/=+$/, '');
    return `$${getPreset(hash).phcId}$i=${iterations}$${b64(salt)}$${b64(derived)}`;
  }

  function parsePHC(text) {
    const parts = String(text).trim().split('$');
    // ['', id, 'i=N', salt, hash]
    if (parts.length !== 5 || parts[0] !== '') {
      throw new Error('Expected a string like $pbkdf2-sha256$i=600000$<salt>$<hash>.');
    }
    const [, id, iterPart, saltPart, hashPart] = parts;
    const hash = Object.keys(PRESETS).find((h) => PRESETS[h].phcId === id);
    if (!hash) throw new Error(`Unsupported scheme "${id.slice(0, 32)}". Use pbkdf2-sha256 or pbkdf2-sha512.`);
    const match = /^i=(\d{1,9})$/.exec(iterPart);
    if (!match) throw new Error('The iteration field must look like i=600000.');
    const iterations = Number(match[1]);
    let salt, derived;
    try {
      salt = enc.base64ToBytes(saltPart);
      derived = enc.base64ToBytes(hashPart);
    } catch (_) {
      throw new Error('The salt or hash field is not valid Base64.');
    }
    validateParams({ hash, iterations, salt, length: derived.length });
    return { hash, iterations, salt, derived };
  }

  /** Re-derives with the stored parameters and compares in constant time. */
  async function verifyPassword(password, encoded) {
    const stored = parsePHC(encoded);
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Enter the password to check.');
    }
    const candidate = await pbkdf2(enc.utf8Encode(password), stored.salt, stored.iterations, stored.hash, stored.derived.length);
    return timingSafeEqual(candidate, stored.derived);
  }

  Saltbox.password = {
    PRESETS, LIMITS, pbkdf2, hashPassword, verifyPassword,
    encodePHC, parsePHC, assessParams,
  };
})(typeof window !== 'undefined' ? window : globalThis);
