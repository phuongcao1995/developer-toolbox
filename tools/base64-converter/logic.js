// Pure Base64 helpers (no DOM). Works in browsers and Node 16+.

const CHUNK = 0x8000; // avoid call-stack overflow in String.fromCharCode.apply

/** Uint8Array -> standard Base64 (chunked). */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Convert standard Base64 to the URL-safe alphabet; optionally keep padding. */
export function toUrlSafe(b64, keepPadding = false) {
  const s = b64.replace(/\+/g, '-').replace(/\//g, '_');
  return keepPadding ? s : s.replace(/=+$/, '');
}

/** Insert a newline every `cols` characters (cols <= 0 -> unchanged). */
export function wrapLines(s, cols) {
  if (!cols || cols <= 0) return s;
  const out = [];
  for (let i = 0; i < s.length; i += cols) out.push(s.slice(i, i + cols));
  return out.join('\n');
}

/** Encode bytes with options { urlSafe, wrap (columns or 0) }. */
export function encodeBytes(bytes, { urlSafe = false, wrap = 0 } = {}) {
  let s = bytesToBase64(bytes);
  if (urlSafe) s = toUrlSafe(s);
  return wrapLines(s, wrap);
}

export function encodeText(text, opts) {
  return encodeBytes(new TextEncoder().encode(text), opts);
}

/**
 * Tolerant normalisation: strips a data: URI prefix, whitespace, converts URL-safe
 * characters, and re-adds missing padding. Returns { b64, mime }.
 * Throws Error with a clear message on invalid input.
 */
export function normalizeBase64(input) {
  let s = String(input ?? '').trim();
  let mime = null;
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(s);
  if (m) {
    mime = m[1] || null;
    s = s.slice(m[0].length);
    if (!/;base64/i.test(m[2])) throw new Error('This data: URI is not Base64-encoded (missing ";base64").');
  }
  s = s.replace(/\s+/g, '');
  if (!s) throw new Error('Input is empty.');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bad = /[^A-Za-z0-9+/=]/.exec(s);
  if (bad) throw new Error(`Invalid character "${bad[0]}" at position ${bad.index + 1}. Base64 only allows A-Z a-z 0-9 + / (or - _ for URL-safe) and =.`);
  const body = s.replace(/=+$/, '');
  if (body.includes('=')) throw new Error('Padding "=" may only appear at the end.');
  if (s.length - body.length > 2) throw new Error('Too much "=" padding (maximum 2).');
  if (body.length % 4 === 1) throw new Error('Invalid length: a Base64 string cannot have 1 leftover character. Data is truncated or corrupted.');
  return { b64: body + '='.repeat((4 - (body.length % 4)) % 4), mime };
}

/** Base64 (tolerant) -> { bytes, mime }. */
export function decodeToBytes(input) {
  const { b64, mime } = normalizeBase64(input);
  let bin;
  try { bin = atob(b64); } catch { throw new Error('Input is not valid Base64.'); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/** Base64 -> UTF-8 string; throws if the bytes are not valid UTF-8. */
export function decodeText(input) {
  const { bytes } = decodeToBytes(input);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Decoded bytes are not valid UTF-8 text (probably binary data). Use the File tab to download it instead.'); }
}

/** Sniff a MIME type from magic bytes. Returns null if unknown. */
export function detectMime(b) {
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  const str = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 4) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (str(0, 'GIF8')) return 'image/gif';
  if (str(0, 'RIFF') && str(8, 'WEBP')) return 'image/webp';
  if (str(0, 'BM')) return 'image/bmp';
  if (at(0, 0, 0, 1, 0)) return 'image/x-icon';
  if (str(4, 'ftypavif')) return 'image/avif';
  if (str(0, '%PDF')) return 'application/pdf';
  if (at(0, 0x50, 0x4b, 3, 4)) return 'application/zip';
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/avif': 'avif', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'text/plain': 'txt', 'application/json': 'json', 'text/html': 'html' };
export const extForMime = mime => EXT[(mime || '').toLowerCase()] || 'bin';

/** Build a data URI from a Base64 payload (no wrapping) and MIME. */
export const toDataUri = (b64, mime) => `data:${mime || 'application/octet-stream'};base64,${b64}`;

/** Ready-to-use snippets for an image data URI. */
export const imgSnippet = uri => `<img src="${uri}" alt="">`;
export const cssSnippet = uri => `background-image: url("${uri}");`;

export const SIZE_WARN_BYTES = 20 * 1024 * 1024;
