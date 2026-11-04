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

/** A syntactically safe MIME type: type/subtype using only letters, digits and . + - */
export const isSafeMime = m => /^[a-z]+\/[A-Za-z0-9.+-]+$/i.test(String(m ?? ''));
export const isImageMime = m => /^image\/[A-Za-z0-9.+-]+$/i.test(String(m ?? ''));

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
    mime = m[1].trim() || null;
    if (mime !== null && !isSafeMime(mime)) throw new Error(`The data: URI declares an invalid MIME type "${mime.length > 40 ? mime.slice(0, 40) + '...' : mime}". Only values like "image/png" (letters, digits and . + -) are accepted.`);
    if (mime) mime = mime.toLowerCase();
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

/** "BM" alone is common in text; require a plausible BITMAPFILEHEADER (size field, zero reserved bytes, sane pixel offset). */
function looksLikeBmp(b) {
  if (b.length < 14) return false;
  const u32 = i => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const size = u32(2), offset = u32(10);
  return u32(6) === 0 && size >= 26 && size <= b.length && offset >= 14 && offset <= size;
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
  if (str(0, 'BM') && looksLikeBmp(b)) return 'image/bmp';
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

/** Build a data URI from a Base64 payload (no wrapping) and MIME. Throws on an unsafe MIME or non-Base64 payload. */
export function toDataUri(b64, mime) {
  const m = mime || 'application/octet-stream';
  if (!isSafeMime(m)) throw new Error(`Invalid MIME type "${String(m).slice(0, 40)}". Use a value like "image/png".`);
  if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new Error('Payload is not valid Base64.');
  return `data:${m};base64,${b64}`;
}

const escAttr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escCss = s => String(s).replace(/[\\"()\s<>]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');

/** Reject anything that is not a plain image data URI before it goes into a snippet. */
function assertImageUri(uri) {
  if (!/^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/.test(String(uri))) throw new Error('Not a valid image data URI (expected data:image/<type>;base64,<data>).');
  return String(uri);
}

/** Ready-to-use snippets for an image data URI (validated and escaped, so hostile input cannot add attributes or tags). */
export const imgSnippet = uri => `<img src="${escAttr(assertImageUri(uri))}" alt="">`;
export const cssSnippet = uri => `background-image: url("${escCss(assertImageUri(uri))}");`;

export const SIZE_WARN_BYTES = 20 * 1024 * 1024;

/** Images above this size are refused in the Image tab (the data: URI would be ~1.33x larger and slow to render). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/**
 * Make a user-typed file name safe for download: strips control characters (C0, DEL, C1, bidi/zero-width controls),
 * path separators and characters Windows rejects, trims dots/spaces and avoids reserved device names. Never returns ''.
 */
export function sanitizeFilename(name, fallback = 'download') {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (WINDOWS_RESERVED.test(s)) s = '_' + s;
  if (s.length > 200) s = s.slice(0, 200);
  return s || fallback;
}
