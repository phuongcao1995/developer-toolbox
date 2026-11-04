// Pure data-conversion operations for the pipeline tool (no DOM access).
// A pipeline value is either a JS string (text) or a Uint8Array (raw bytes).

const enc = new TextEncoder();

export const toBytes = v => (v instanceof Uint8Array ? v : enc.encode(v));

/** Strict UTF-8 text view of a value; throws a helpful error when bytes are not valid UTF-8. */
export function toText(v) {
  if (typeof v === 'string') return v;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(v); }
  catch { throw new Error('Input is binary data (not valid UTF-8 text). Put a "Hex encode" or "Base64 encode" step before this one.'); }
}

export const bytesToHex = (bytes, sep = '') => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(sep);

/**
 * Parse hex in flexible notations: "48 65", "0x48,0x65", "\x48\x65", "4865", "0x4865".
 * Every token is validated BEFORE any prefix is stripped, so garbage such as "10x5" or "zz0x41" is rejected
 * instead of being silently rewritten.
 */
export function hexToBytes(text) {
  const tokens = String(text).split(/[\s,;:\-]+/).filter(t => t !== '');
  let digits = '';
  for (const tok of tokens) {
    if (/^[0-9a-f]+$/i.test(tok)) { digits += tok; continue; }
    if (!/^(?:(?:0x|\\x)[0-9a-f]+)+$/i.test(tok)) {
      throw new Error(`Invalid hex: "${tok.length > 24 ? tok.slice(0, 24) + '…' : tok}" is not a hex number (use digits 0-9 a-f, optionally prefixed 0x or \\x).`);
    }
    for (const piece of tok.split(/0x|\\x/i)) if (piece) digits += piece.length % 2 ? '0' + piece : piece; // "0x5" means byte 05
  }
  if (digits.length % 2) throw new Error('Invalid hex: odd number of digits (' + digits.length + ').');
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
  return out;
}

// ---------- Base64 ----------
export function base64Encode(bytes, urlSafe = false) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let s = btoa(bin);
  if (urlSafe) s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return s;
}
export function base64Decode(text) {
  let s = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('Invalid Base64: contains characters outside the Base64 alphabet.');
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Error('Invalid Base64: length is not valid.');
  if (s.includes('=')) throw new Error('Invalid Base64: "=" padding may only appear at the end.');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Base32 (RFC 4648) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes, pad = true) {
  let out = '', bits = 0, acc = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i]; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  if (pad) while (out.length % 8) out += '=';
  return out;
}
export function base32Decode(text) {
  const s = text.replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
  if (/[^A-Z2-7]/.test(s)) throw new Error('Invalid Base32: only A-Z and 2-7 are allowed (padding "=" only at the end).');
  if ([1, 3, 6].includes(s.length % 8)) throw new Error('Invalid Base32: length is not valid.');
  const out = []; let bits = 0, acc = 0;
  for (const ch of s) {
    acc = (acc << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}

// ---------- Base58 (Bitcoin alphabet) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = []; // base-58 digits, little endian
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
export function base58Decode(text) {
  const s = text.replace(/\s+/g, '');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58.indexOf(s[i]);
    if (v < 0) throw new Error(`Invalid Base58: "${s[i]}" is not in the Bitcoin alphabet (0, O, I and l are excluded).`);
    let carry = v;
    for (let j = 0; j < out.length; j++) { carry += out[j] * 58; out[j] = carry & 255; carry >>= 8; }
    while (carry) { out.push(carry & 255); carry >>= 8; }
  }
  const res = new Uint8Array(zeros + out.length);
  for (let i = 0; i < out.length; i++) res[zeros + i] = out[out.length - 1 - i];
  return res;
}

// ---------- Text helpers ----------
export const rot13 = t => t.replace(/[A-Za-z]/g, c => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.charCodeAt(0) - (c <= 'Z' ? 65 : 97) + 13) % 26)));
/** ROT47 rotates the printable ASCII range ! (33) .. ~ (126) by 47. */
export const rot47 = t => t.replace(/[!-~]/g, c => String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 47) % 94)));
export function reverseText(t) {
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t), s => s.segment)
    : Array.from(t);
  return parts.reverse().join('');
}

/** Bytes -> groups of 8 binary digits. */
export const toBinary = (bytes, sep = ' ') => Array.from(bytes, b => b.toString(2).padStart(8, '0')).join(sep);
export function fromBinary(text) {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  let bits = '';
  for (const t of tokens) {
    const clean = t.replace(/^0b/i, '');
    if (!/^[01]+$/.test(clean)) throw new Error(`Invalid binary: "${t.slice(0, 20)}" contains characters other than 0 and 1.`);
    bits += tokens.length === 1 ? clean : clean.padStart(Math.ceil(clean.length / 8) * 8, '0');
  }
  if (bits.length % 8) throw new Error(`Invalid binary: ${bits.length} bits is not a multiple of 8.`);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.substr(i * 8, 8), 2);
  return out;
}
export const toDecimal = (bytes, sep = ' ') => Array.from(bytes).join(sep);
export function fromDecimal(text) {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  return Uint8Array.from(tokens, t => {
    if (!/^\d+$/.test(t)) throw new Error(`Invalid decimal: "${t.slice(0, 20)}" is not a whole number.`);
    const n = Number(t);
    if (n > 255) throw new Error(`Invalid decimal: ${t} is greater than 255 (one byte).`);
    return n;
  });
}

// ---------- HTML entities ----------
// Compact table: HTML 4 set (252) plus common HTML5 additions. Codes are decimal code points.
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const GREEK_UP = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'.split(' ');
const GREEK_UP2 = 'Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');
const GREEK_LO = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'.split(' ');
const OTHERS = ('quot 34 amp 38 lt 60 gt 62 apos 39 OElig 338 oelig 339 Scaron 352 scaron 353 Yuml 376 fnof 402 circ 710 tilde 732 ' +
  'thetasym 977 upsih 978 piv 982 ensp 8194 emsp 8195 thinsp 8201 zwnj 8204 zwj 8205 lrm 8206 rlm 8207 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220 rdquo 8221 bdquo 8222 ' +
  'dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242 Prime 8243 lsaquo 8249 rsaquo 8250 oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472 real 8476 trade 8482 alefsym 8501 ' +
  'larr 8592 uarr 8593 rarr 8594 darr 8595 harr 8596 crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 ' +
  'forall 8704 part 8706 exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722 lowast 8727 radic 8730 prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746 int 8747 ' +
  'there4 8756 sim 8764 cong 8773 asymp 8776 ne 8800 equiv 8801 le 8804 ge 8805 sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 sdot 8901 ' +
  'lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 lang 10216 rang 10217 loz 9674 spades 9824 clubs 9827 hearts 9829 diams 9830 ' +
  // HTML5 additions
  'Tab 9 NewLine 10 excl 33 num 35 dollar 36 percnt 37 lpar 40 rpar 41 ast 42 plus 43 comma 44 period 46 sol 47 colon 58 semi 59 equals 61 quest 63 commat 64 ' +
  'lsqb 91 bsol 92 rsqb 93 Hat 94 lowbar 95 grave 96 lcub 123 verbar 124 rcub 125 hyphen 8208 dash 8208 numsp 8199 puncsp 8200 hairsp 8202 check 10003 cross 10007 star 9734 starf 9733 phone 9742 female 9792 male 9794 ' +
  'hearts 9829 NotEqual 8800 hbar 8463 ell 8467 Omega 937 ohm 937 half 189 centerdot 183 bigstar 9733 checkmark 10003 copysr 8471 incare 8453 sung 9834 flat 9837 natural 9838 sharp 9839').split(' ');

/** name -> string (the character(s)) */
export const NAMED_ENTITIES = (() => {
  const m = Object.create(null);
  LATIN1.forEach((n, i) => { m[n] = String.fromCodePoint(160 + i); });
  GREEK_UP.forEach((n, i) => { m[n] = String.fromCodePoint(913 + i); });
  GREEK_UP2.forEach((n, i) => { m[n] = String.fromCodePoint(931 + i); });
  GREEK_LO.forEach((n, i) => { m[n] = String.fromCodePoint(945 + i); });
  for (let i = 0; i < OTHERS.length; i += 2) if (!(OTHERS[i] in m) || OTHERS[i] === 'Omega') m[OTHERS[i]] = String.fromCodePoint(+OTHERS[i + 1]);
  m.AMP = '&'; m.LT = '<'; m.GT = '>'; m.QUOT = '"'; m.COPY = '©'; m.REG = '®';
  return m;
})();

/** Names that HTML5 also recognises WITHOUT a trailing semicolon ("&amp", "&copy", "&eacute"). */
const LEGACY = new Set([...LATIN1, 'amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);

/** Reverse map char -> preferred name (first definition wins; aliases like "dash" never override). */
const NAME_OF = (() => {
  const m = new Map();
  const prefer = ['quot', 'amp', 'lt', 'gt', 'apos'];
  for (const n of [...prefer, ...Object.keys(NAMED_ENTITIES)]) {
    if (n === 'AMP' || n === 'LT' || n === 'GT' || n === 'QUOT' || n === 'COPY' || n === 'REG') continue;
    if (['hyphen', 'dash', 'ohm', 'half', 'centerdot', 'bigstar', 'checkmark', 'NotEqual', 'Tab', 'NewLine', 'sung'].includes(n)) continue;
    const ch = NAMED_ENTITIES[n];
    if (ch.length === 1 && ch.charCodeAt(0) < 128 && !'&<>"\''.includes(ch)) continue; // never name plain ASCII
    if (!m.has(ch)) m.set(ch, n);
  }
  m.set('‐', 'hyphen');
  return m;
})();

const C1 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];

/** Code point of a numeric character reference per the HTML spec (invalid -> U+FFFD, C1 controls -> Windows-1252). */
function numericRef(cp) {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0xFFFD;
  if (cp >= 0x80 && cp <= 0x9F) return C1[cp - 0x80];
  return cp;
}

/**
 * Decode HTML character references: named (with or without ";" for the legacy set), decimal and hex numeric.
 * Invalid numeric references (0, > 0x10FFFF, surrogates) become U+FFFD; 0x80-0x9F map through Windows-1252.
 */
export function decodeHtmlEntities(text) {
  return String(text).replace(/&(?:#(?:[xX]([0-9a-fA-F]+)|([0-9]+))|([A-Za-z][A-Za-z0-9]*))(;?)/g, (m, hex, dec, name, semi) => {
    if (name === undefined) {
      const digits = hex ?? dec;
      const cp = digits.replace(/^0+/, '').length > 8 ? 0x110000 : parseInt(digits, hex !== undefined ? 16 : 10);
      return String.fromCodePoint(numericRef(cp));
    }
    if (semi && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) return NAMED_ENTITIES[name];
    // no (known) semicolon form: longest legacy prefix wins, rest stays literal ("&notit;" -> "¬it;")
    for (let len = Math.min(name.length, 6); len >= 2; len--) {
      const p = name.slice(0, len);
      if (LEGACY.has(p)) return NAMED_ENTITIES[p] + name.slice(len) + semi;
    }
    return m;
  });
}

/**
 * Encode text as HTML entities.
 *   mode: 'named' (uses &name; where one exists, else hex-less numeric &#N;), 'numeric' (&#N;) or 'hex' (&#xH;)
 *   onlyNonAscii: true -> leave every ASCII character alone (including & < > " ') and encode only non-ASCII.
 *   specialOnly: true -> encode only & < > " ' (leave all non-ASCII alone). Ignored when onlyNonAscii is set.
 * Default: encodes the five special characters and all non-ASCII. Works on code points (astral characters become one
 * reference); lone surrogates become U+FFFD.
 */
export function encodeHtmlEntities(text, { mode = 'named', onlyNonAscii = false, specialOnly = false } = {}) {
  const num = cp => (mode === 'hex' ? `&#x${cp.toString(16).toUpperCase()};` : `&#${cp};`);
  const SPECIAL = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' };
  let out = '';
  for (const ch of String(text)) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
    const special = cp < 128 && ch in SPECIAL;
    if (cp < 128) {
      if (!special || onlyNonAscii) out += ch;
      else if (mode === 'named') out += `&${SPECIAL[ch]};`;
      else out += num(cp);
    } else if (specialOnly && !onlyNonAscii) out += String.fromCodePoint(cp);
    else if (mode === 'named' && NAME_OF.has(String.fromCodePoint(cp))) out += `&${NAME_OF.get(String.fromCodePoint(cp))};`;
    else out += num(cp);
  }
  return out;
}

// Backwards-compatible names used by older callers.
export const htmlEncode = (text, all = false) => encodeHtmlEntities(text, { mode: 'named', specialOnly: !all });
export const htmlDecode = decodeHtmlEntities;

// ---------- MD5 (RFC 1321) ----------
// No per-block allocations: one reusable 16-word buffer, constants in typed arrays, the input is read in place and only the
// final 1-2 padded blocks are copied.
const MD5_S = new Uint8Array(64), MD5_G = new Uint8Array(64), MD5_K = new Int32Array(64);
(() => {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) {
    MD5_S[i] = S[(i >> 4) * 4 + (i % 4)];
    MD5_G[i] = i < 16 ? i : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16;
    MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }
})();
const MD5_M = new Int32Array(16);

export function md5(bytes) {
  const len = bytes.length;
  const st = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  const M = MD5_M;
  const block = (src, off) => {
    for (let i = 0, p = off; i < 16; i++, p += 4) M[i] = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24);
    let A = st[0], B = st[1], C = st[2], D = st[3];
    for (let i = 0; i < 64; i++) {
      let F;
      if (i < 16) F = (B & C) | (~B & D);
      else if (i < 32) F = (D & B) | (~D & C);
      else if (i < 48) F = B ^ C ^ D;
      else F = C ^ (B | ~D);
      F = (F + A + MD5_K[i] + M[MD5_G[i]]) | 0;
      A = D; D = C; C = B;
      const s = MD5_S[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    st[0] = (st[0] + A) | 0; st[1] = (st[1] + B) | 0; st[2] = (st[2] + C) | 0; st[3] = (st[3] + D) | 0;
  };
  const full = Math.floor(len / 64) * 64;
  for (let off = 0; off < full; off += 64) block(bytes, off);
  const rest = len - full;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  for (let i = 0; i < rest; i++) tail[i] = bytes[full + i];
  tail[rest] = 0x80;
  const tdv = new DataView(tail.buffer);
  tdv.setUint32(tail.length - 8, (len * 8) >>> 0, true);
  tdv.setUint32(tail.length - 4, Math.floor(len / 0x20000000), true);
  for (let off = 0; off < tail.length; off += 64) block(tail, off);
  const out = new Uint8Array(16), odv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) odv.setUint32(i * 4, st[i] >>> 0, true);
  return bytesToHex(out);
}

export async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 needs the Web Crypto API, which browsers only expose on HTTPS or localhost.');
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}

/** encodeURIComponent with a friendly message for lone surrogates (which it rejects with "URI malformed"). */
export function urlEncode(text) {
  try { return encodeURIComponent(text).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
  catch {
    let at = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) { i++; continue; }
      if (c >= 0xD800 && c <= 0xDFFF) { at = i; break; }
    }
    throw new Error(`The text contains a lone UTF-16 surrogate (U+${at >= 0 ? text.charCodeAt(at).toString(16).toUpperCase() : 'D800'} at position ${at}), which cannot be URL-encoded. It is usually half of a split emoji; remove it or use "UTF-8 encode (to hex bytes)", which replaces it with U+FFFD.`);
  }
}

// ---------- Operation registry ----------
/** Each op: {id, name, group, desc, params?: [{key,label,options:[[value,label]]}], run(value, params) -> value | Promise<value>} */
export const OPERATIONS = [
  { id: 'base64-encode', name: 'Base64 encode', group: 'Encode', desc: 'Bytes (UTF-8) to Base64',
    params: [{ key: 'variant', label: 'Alphabet', options: [['std', 'Standard'], ['url', 'URL-safe']] }],
    run: (v, p) => base64Encode(toBytes(v), p.variant === 'url') },
  { id: 'base64-decode', name: 'Base64 decode', group: 'Decode', desc: 'Base64 (standard or URL-safe) to bytes',
    run: v => base64Decode(toText(v)) },
  { id: 'base32-encode', name: 'Base32 encode', group: 'Encode', desc: 'Bytes to Base32 (RFC 4648)',
    params: [{ key: 'pad', label: 'Padding', options: [['yes', 'With = padding'], ['no', 'No padding']] }],
    run: (v, p) => base32Encode(toBytes(v), p.pad !== 'no') },
  { id: 'base32-decode', name: 'Base32 decode', group: 'Decode', desc: 'Base32 (RFC 4648, case-insensitive) to bytes',
    run: v => base32Decode(toText(v)) },
  { id: 'base58-encode', name: 'Base58 encode', group: 'Encode', desc: 'Bytes to Base58 (Bitcoin alphabet)',
    run: v => base58Encode(toBytes(v)) },
  { id: 'base58-decode', name: 'Base58 decode', group: 'Decode', desc: 'Base58 (Bitcoin alphabet) to bytes',
    run: v => base58Decode(toText(v)) },
  { id: 'url-encode', name: 'URL encode', group: 'Encode', desc: 'Percent-encode text (encodeURIComponent)',
    run: v => urlEncode(toText(v)) },
  { id: 'url-decode', name: 'URL decode', group: 'Decode', desc: 'Decode %XX sequences',
    run: v => { try { return decodeURIComponent(toText(v)); } catch { throw new Error('Malformed percent-encoding (bad %XX sequence or invalid UTF-8).'); } } },
  { id: 'hex-encode', name: 'Hex encode', group: 'Encode', desc: 'Bytes to hexadecimal',
    params: [{ key: 'sep', label: 'Separator', options: [['space', 'Space'], ['none', 'None'], ['comma', 'Comma'], ['0x', '0x prefix']] }],
    run: (v, p) => {
      const b = toBytes(v);
      if (p.sep === 'none') return bytesToHex(b);
      if (p.sep === 'comma') return bytesToHex(b, ',');
      if (p.sep === '0x') return Array.from(b, x => '0x' + x.toString(16).padStart(2, '0')).join(' ');
      return bytesToHex(b, ' ');
    } },
  { id: 'hex-decode', name: 'Hex decode', group: 'Decode', desc: 'Hexadecimal to bytes',
    run: v => hexToBytes(toText(v)) },
  { id: 'binary-encode', name: 'To binary', group: 'Encode', desc: 'Bytes to 8-bit binary groups',
    params: [{ key: 'sep', label: 'Separator', options: [['space', 'Space'], ['none', 'None']] }],
    run: (v, p) => toBinary(toBytes(v), p.sep === 'none' ? '' : ' ') },
  { id: 'binary-decode', name: 'From binary', group: 'Decode', desc: 'Binary digits (0/1) to bytes',
    run: v => fromBinary(toText(v)) },
  { id: 'decimal-encode', name: 'To decimal', group: 'Encode', desc: 'Bytes to decimal numbers (0-255)',
    params: [{ key: 'sep', label: 'Separator', options: [['space', 'Space'], ['comma', 'Comma']] }],
    run: (v, p) => toDecimal(toBytes(v), p.sep === 'comma' ? ',' : ' ') },
  { id: 'decimal-decode', name: 'From decimal', group: 'Decode', desc: 'Decimal numbers (0-255) to bytes',
    run: v => fromDecimal(toText(v)) },
  { id: 'html-encode', name: 'HTML entity encode', group: 'Encode', desc: 'Escape & < > " \' and non-ASCII as entities',
    params: [
      { key: 'mode', label: 'Entity style', options: [['named', 'Named (&amp;)'], ['numeric', 'Decimal (&#38;)'], ['hex', 'Hex (&#x26;)']] },
      { key: 'scope', label: 'Scope', options: [['basic', 'Special chars only'], ['all', 'Special + non-ASCII'], ['nonascii', 'Non-ASCII only']] },
    ],
    run: (v, p) => encodeHtmlEntities(toText(v), { mode: p.mode || 'named', specialOnly: (p.scope || 'basic') === 'basic', onlyNonAscii: p.scope === 'nonascii' }) },
  { id: 'html-decode', name: 'HTML entity decode', group: 'Decode', desc: 'Decode named and numeric entities',
    run: v => decodeHtmlEntities(toText(v)) },
  { id: 'utf8-encode', name: 'UTF-8 encode (to hex bytes)', group: 'Encode', desc: 'Text to its UTF-8 bytes, shown as hex',
    run: v => bytesToHex(toBytes(v), ' ') },
  { id: 'utf8-decode', name: 'UTF-8 decode (from bytes/hex)', group: 'Decode', desc: 'Bytes (or hex text) to UTF-8 text',
    run: v => {
      const bytes = v instanceof Uint8Array ? v : hexToBytes(v);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('These bytes are not valid UTF-8.'); }
    } },
  { id: 'rot13', name: 'ROT13', group: 'Text', desc: 'Rotate letters by 13 (not encryption)', run: v => rot13(toText(v)) },
  { id: 'rot47', name: 'ROT47', group: 'Text', desc: 'Rotate printable ASCII by 47 (not encryption)', run: v => rot47(toText(v)) },
  { id: 'reverse', name: 'Reverse', group: 'Text', desc: 'Reverse text (by visible characters) or bytes',
    run: v => (v instanceof Uint8Array ? Uint8Array.from(v).reverse() : reverseText(v)) },
  { id: 'uppercase', name: 'Uppercase', group: 'Text', desc: 'Convert text to upper case', run: v => toText(v).toUpperCase() },
  { id: 'lowercase', name: 'Lowercase', group: 'Text', desc: 'Convert text to lower case', run: v => toText(v).toLowerCase() },
  { id: 'remove-ws', name: 'Remove whitespace', group: 'Text', desc: 'Delete spaces, tabs and line breaks',
    params: [{ key: 'what', label: 'Remove', options: [['all', 'All whitespace'], ['lines', 'Line breaks only'], ['spaces', 'Spaces and tabs only']] }],
    run: (v, p) => toText(v).replace(p.what === 'lines' ? /[\r\n]+/g : p.what === 'spaces' ? /[ \t]+/g : /\s+/g, '') },
  { id: 'sha256', name: 'SHA-256', group: 'Hash', desc: 'One-way hash (hex). Not encryption.', run: v => sha256(toBytes(v)) },
  { id: 'md5', name: 'MD5', group: 'Hash', desc: 'One-way hash (hex). Broken for security; fine for checksums.', run: v => md5(toBytes(v)) },
];
export const GROUPS = ['Encode', 'Decode', 'Text', 'Hash'];
export const getOp = id => OPERATIONS.find(o => o.id === id);

export const defaultParams = op => Object.fromEntries((op.params || []).map(p => [p.key, p.options[0][0]]));

/** Human-readable rendering of a pipeline value. */
export function displayValue(v) {
  if (typeof v === 'string') return { text: v, binary: false };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(v), binary: false, bytes: v.length }; }
  catch { return { text: bytesToHex(v, ' '), binary: true, bytes: v.length }; } // not text: show hex
}

/** The exact bytes of a pipeline value (strings are UTF-8 encoded). */
export const valueBytes = v => toBytes(v);

/**
 * Run steps sequentially; each enabled step consumes the previous output.
 * `input` may be a string or a Uint8Array (a loaded file).
 * Returns {results: [...], final, finalValue (the raw string/bytes, binary-safe), error, failedAt}
 */
export async function runPipeline(input, steps) {
  let value = input;
  const results = [];
  let failedAt = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (failedAt >= 0) { results.push({ status: 'skipped' }); continue; }
    if (!s.enabled) { results.push({ status: 'off' }); continue; }
    const op = getOp(s.op);
    try {
      value = await op.run(value, { ...defaultParams(op), ...(s.params || {}) });
      results.push({ status: 'ok', ...displayValue(value) });
    } catch (err) {
      failedAt = i; results.push({ status: 'error', error: err.message || String(err) });
    }
  }
  const final = failedAt >= 0 ? null : displayValue(value);
  return { results, final, finalValue: failedAt >= 0 ? null : value, failedAt, error: failedAt >= 0 ? results[failedAt].error : null };
}

/** One-click example recipes. */
export const RECIPES = [
  { name: 'Base64 decode', input: 'SGVsbG8sIFdvcmxkISDwn5GL', steps: [{ op: 'base64-decode' }] },
  { name: 'URL decode', input: 'name%3DJo%C3%A3o%26city%3DS%C3%A3o%20Paulo', steps: [{ op: 'url-decode' }] },
  { name: 'Text to hex', input: 'Hello, World!', steps: [{ op: 'hex-encode' }] },
  { name: 'MD5 of text', input: 'abc', steps: [{ op: 'md5' }] },
  { name: 'SHA-256 of text', input: 'abc', steps: [{ op: 'sha256' }] },
  { name: 'Base64 then hex', input: 'Pipeline demo', steps: [{ op: 'base64-encode' }, { op: 'hex-encode', params: { sep: 'none' } }] },
  { name: 'HTML escape', input: '<a href="x">Tom & Jerry\'s</a>', steps: [{ op: 'html-encode' }] },
  { name: 'Base32', input: 'foobar', steps: [{ op: 'base32-encode' }] },
  { name: 'Base58', input: 'Hello World!', steps: [{ op: 'base58-encode' }] },
  { name: 'ROT13', input: 'Hello, World!', steps: [{ op: 'rot13' }] },
];
