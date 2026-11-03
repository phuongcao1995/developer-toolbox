/*
 * core.js — shared namespace and small security helpers.
 * Every other module attaches itself to the global `Saltbox` object, so the
 * app works as plain <script> files (no build step, no ES-module CORS issues
 * when opened from disk).
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});

  /**
   * Returns the SubtleCrypto interface or throws a readable error.
   * Web Crypto is only exposed in secure contexts (HTTPS or localhost).
   */
  function requireSubtle() {
    const c = root.crypto;
    if (!c || !c.subtle) {
      throw new Error(
        'Web Crypto is unavailable. Open this page over HTTPS or from localhost.'
      );
    }
    return c.subtle;
  }

  /**
   * Constant-time comparison of two byte arrays of equal length.
   * Avoids early-exit timing differences when checking hashes or tags.
   * (Length itself is not secret here: it is fixed by the algorithm.)
   */
  function timingSafeEqual(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /** Best-effort wipe of a byte buffer once it is no longer needed. */
  function wipe(bytes) {
    if (bytes instanceof Uint8Array) bytes.fill(0);
  }

  Saltbox.core = { requireSubtle, timingSafeEqual, wipe };
})(typeof window !== 'undefined' ? window : globalThis);
