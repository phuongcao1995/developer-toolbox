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

/** Parse hex in flexible notations: "48 65", "0x48,0x65", "\x48\x65", "4865". */
export function hexToBytes(text) {
  const cleaned = text.replace(/0x|\\x/gi, '').replace(/[\s,;:\-]/g, '');
  if (cleaned === '') return new Uint8Array(0);
  if (/[^0-9a-f]/i.test(cleaned)) throw new Error('Invalid hex: found a character that is not 0-9 or a-f.');
  if (cleaned.length % 2) throw new Error('Invalid hex: odd number of digits (' + cleaned.length + ').');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
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

// ---------- HTML entities ----------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', deg: '°', plusmn: '±', times: '×', divide: '÷', middot: '·', bull: '•', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥' };
export function htmlEncode(text, all = false) {
  let out = '';
  for (const ch of text) { // iterates by code point, so astral chars become one entity
    const cp = ch.codePointAt(0);
    if (ch === '&') out += '&amp;'; else if (ch === '<') out += '&lt;'; else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;'; else if (ch === "'") out += '&#39;';
    else if (all && cp > 126) out += `&#${cp};`;
    else out += ch;
  }
  return out;
}
export function htmlDecode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}

// ---------- MD5 (RFC 1321) ----------
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

export function md5(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64); // room for 0x80 + zeros + 8-byte length, multiple of 64
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len << 3) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true); // high bits of bit-length
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), odv = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => odv.setUint32(i * 4, v, true));
  return bytesToHex(out);
}

export async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 needs the Web Crypto API, which browsers only expose on HTTPS or localhost.');
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}

// ---------- Operation registry ----------
/** Each op: {id, name, group, desc, params?: [{key,label,options:[[value,label]]}], run(value, params) -> value | Promise<value>} */
export const OPERATIONS = [
  { id: 'base64-encode', name: 'Base64 encode', group: 'Encode', desc: 'Bytes (UTF-8) to Base64',
    params: [{ key: 'variant', label: 'Alphabet', options: [['std', 'Standard'], ['url', 'URL-safe']] }],
    run: (v, p) => base64Encode(toBytes(v), p.variant === 'url') },
  { id: 'base64-decode', name: 'Base64 decode', group: 'Decode', desc: 'Base64 (standard or URL-safe) to bytes',
    run: v => base64Decode(toText(v)) },
  { id: 'url-encode', name: 'URL encode', group: 'Encode', desc: 'Percent-encode text (encodeURIComponent)',
    run: v => encodeURIComponent(toText(v)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) },
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
  { id: 'html-encode', name: 'HTML entity encode', group: 'Encode', desc: 'Escape & < > " \'',
    params: [{ key: 'scope', label: 'Scope', options: [['basic', 'Special chars'], ['all', 'Also non-ASCII']] }],
    run: (v, p) => htmlEncode(toText(v), p.scope === 'all') },
  { id: 'html-decode', name: 'HTML entity decode', group: 'Decode', desc: 'Decode named and numeric entities',
    run: v => htmlDecode(toText(v)) },
  { id: 'utf8-encode', name: 'UTF-8 encode (to hex bytes)', group: 'Encode', desc: 'Text to its UTF-8 bytes, shown as hex',
    run: v => bytesToHex(toBytes(v), ' ') },
  { id: 'utf8-decode', name: 'UTF-8 decode (from bytes/hex)', group: 'Decode', desc: 'Bytes (or hex text) to UTF-8 text',
    run: v => {
      const bytes = v instanceof Uint8Array ? v : hexToBytes(v);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('These bytes are not valid UTF-8.'); }
    } },
  { id: 'sha256', name: 'SHA-256', group: 'Hash', desc: 'One-way hash (hex). Not encryption.', run: v => sha256(toBytes(v)) },
  { id: 'md5', name: 'MD5', group: 'Hash', desc: 'One-way hash (hex). Broken for security; fine for checksums.', run: v => md5(toBytes(v)) },
];
export const getOp = id => OPERATIONS.find(o => o.id === id);

export const defaultParams = op => Object.fromEntries((op.params || []).map(p => [p.key, p.options[0][0]]));

/** Human-readable rendering of a pipeline value. */
export function displayValue(v) {
  if (typeof v === 'string') return { text: v, binary: false };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(v), binary: false, bytes: v.length }; }
  catch { return { text: bytesToHex(v, ' '), binary: true, bytes: v.length }; } // not text: show hex
}

/**
 * Run steps sequentially; each enabled step consumes the previous output.
 * Returns {results: [{status:'ok'|'error'|'skipped'|'off', output, error, binary, bytes}], final, error, failedAt}
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
  return { results, final, failedAt, error: failedAt >= 0 ? results[failedAt].error : null };
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
];
