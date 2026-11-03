/*
 * encoding.js — reversible text/byte encodings.
 * Encoding is NOT encryption: anyone can reverse these transforms.
 */
(function (root) {
  'use strict';

  const Saltbox = (root.Saltbox = root.Saltbox || {});
  const textEncoder = new TextEncoder();
  // fatal: true makes invalid UTF-8 throw instead of silently inserting U+FFFD.
  const textDecoder = new TextDecoder('utf-8', { fatal: true });

  function utf8Encode(text) {
    return textEncoder.encode(String(text));
  }

  function utf8Decode(bytes) {
    try {
      return textDecoder.decode(bytes);
    } catch (_) {
      throw new Error('The decoded bytes are not valid UTF-8 text.');
    }
  }

  // ---- Hexadecimal -------------------------------------------------------

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  /** Accepts optional 0x prefix and whitespace, colon or dash separators. */
  function hexToBytes(hex) {
    const clean = String(hex)
      .trim()
      .replace(/^0x/i, '')
      .replace(/[\s:-]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(clean)) {
      throw new Error('Hex input may only contain 0–9 and a–f.');
    }
    if (clean.length % 2 !== 0) {
      throw new Error('Hex input must have an even number of digits.');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }

  // ---- Base64 / Base64URL --------------------------------------------------

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000; // avoid call-stack limits on large inputs
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /** Accepts standard Base64 and Base64URL, with or without padding. */
  function base64ToBytes(input) {
    let clean = String(input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
      throw new Error('Base64 input contains characters outside A–Z, a–z, 0–9, +, / and =.');
    }
    clean = clean.replace(/=+$/, '');
    if (clean.length % 4 === 1) {
      throw new Error('Base64 input has an invalid length.');
    }
    clean += '='.repeat((4 - (clean.length % 4)) % 4);
    let binary;
    try {
      binary = atob(clean);
    } catch (_) {
      throw new Error('Base64 input could not be decoded.');
    }
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  // ---- URL (percent) encoding ----------------------------------------------

  function urlEncode(text) {
    return encodeURIComponent(String(text));
  }

  function urlDecode(text) {
    try {
      return decodeURIComponent(String(text));
    } catch (_) {
      throw new Error('The input contains a malformed %-escape sequence.');
    }
  }

  // ---- Binary (8-bit groups of UTF-8 bytes) --------------------------------

  function textToBinary(text) {
    return Array.from(utf8Encode(text), (b) => b.toString(2).padStart(8, '0')).join(' ');
  }

  function binaryToText(binary) {
    const clean = String(binary).replace(/\s+/g, '');
    if (!/^[01]*$/.test(clean)) throw new Error('Binary input may only contain 0 and 1.');
    if (clean.length % 8 !== 0) {
      throw new Error('Binary input must be a multiple of 8 bits.');
    }
    const out = new Uint8Array(clean.length / 8);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 8, 8), 2);
    return utf8Decode(out);
  }

  // ---- UTF-8 byte list (decimal) -------------------------------------------

  function textToByteList(text) {
    return Array.from(utf8Encode(text)).join(' ');
  }

  function byteListToText(list) {
    const parts = String(list).trim().split(/[\s,]+/).filter(Boolean);
    const out = new Uint8Array(parts.length);
    parts.forEach((p, i) => {
      if (!/^\d{1,3}$/.test(p) || Number(p) > 255) {
        throw new Error(`"${p.slice(0, 12)}" is not a byte value between 0 and 255.`);
      }
      out[i] = Number(p);
    });
    return utf8Decode(out);
  }

  // ---- Generic helpers used by the crypto modules ---------------------------

  /** Encodes bytes for display: 'hex' | 'base64' | 'base64url'. */
  function encodeBytes(bytes, format) {
    switch (format) {
      case 'hex': return bytesToHex(bytes);
      case 'base64': return bytesToBase64(bytes);
      case 'base64url': return bytesToBase64Url(bytes);
      default: throw new Error(`Unknown output encoding: ${format}`);
    }
  }

  /** Decodes user-provided material: 'hex' | 'base64' | 'base64url' | 'utf8'. */
  function decodeToBytes(text, format) {
    switch (format) {
      case 'hex': return hexToBytes(text);
      case 'base64':
      case 'base64url': return base64ToBytes(text);
      case 'utf8': return utf8Encode(text);
      default: throw new Error(`Unknown input encoding: ${format}`);
    }
  }

  /** Text-level transforms used by the Encode / Decode tool. */
  const TEXT_CODECS = {
    base64: {
      encode: (t) => bytesToBase64(utf8Encode(t)),
      decode: (t) => utf8Decode(base64ToBytes(t)),
    },
    base64url: {
      encode: (t) => bytesToBase64Url(utf8Encode(t)),
      decode: (t) => utf8Decode(base64ToBytes(t)),
    },
    hex: {
      encode: (t) => bytesToHex(utf8Encode(t)),
      decode: (t) => utf8Decode(hexToBytes(t)),
    },
    url: { encode: urlEncode, decode: urlDecode },
    binary: { encode: textToBinary, decode: binaryToText },
    bytes: { encode: textToByteList, decode: byteListToText },
  };

  function transformText(format, direction, text) {
    const codec = TEXT_CODECS[format];
    if (!codec) throw new Error(`Unknown format: ${format}`);
    if (direction !== 'encode' && direction !== 'decode') {
      throw new Error(`Unknown direction: ${direction}`);
    }
    return codec[direction](text);
  }

  Saltbox.encoding = {
    utf8Encode, utf8Decode,
    bytesToHex, hexToBytes,
    bytesToBase64, bytesToBase64Url, base64ToBytes,
    urlEncode, urlDecode,
    textToBinary, binaryToText,
    textToByteList, byteListToText,
    encodeBytes, decodeToBytes, transformText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
