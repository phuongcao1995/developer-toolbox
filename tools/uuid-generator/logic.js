// Pure UUID helpers (no DOM). Randomness always comes from a CSPRNG (Web Crypto).

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const MAX_COUNT = 1000;

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const hyphenate = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** Turn 16 random bytes into a v4 UUID by setting version (0100) and variant (10) bits (RFC 4122 / 9562). */
export function uuidFromRandomBytes(bytes) {
  if (!bytes || bytes.length !== 16) throw new Error('Need exactly 16 random bytes.');
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return hyphenate(hex(b));
}

/** Generate one lowercase hyphenated v4 UUID: crypto.randomUUID() with a getRandomValues fallback. */
export function generateV4(cryptoObj = globalThis.crypto) {
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Secure random number generator (Web Crypto) is not available in this browser.');
  }
  return uuidFromRandomBytes(cryptoObj.getRandomValues(new Uint8Array(16)));
}

/** Validate a user-entered count; returns an integer or throws a clear Error. */
export function parseCount(value) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+$/.test(s)) throw new Error('Count must be a whole number.');
  const n = Number(s);
  if (n < 1 || n > MAX_COUNT) throw new Error(`Count must be between 1 and ${MAX_COUNT}.`);
  return n;
}

/** Apply display options to a canonical (lowercase, hyphenated) UUID. */
export function formatUuid(uuid, { upper = false, hyphens = true, braces = false, urn = false } = {}) {
  let s = hyphens ? uuid : uuid.replace(/-/g, '');
  s = upper ? s.toUpperCase() : s.toLowerCase();
  if (braces) s = `{${s}}`;
  if (urn) s = `urn:uuid:${s}`;
  return s;
}

export const SEPARATORS = { newline: '\n', comma: ',', 'comma-space': ', ', space: ' ' };

/** Generate `count` formatted UUIDs. Returns an array of strings. */
export function generateMany(count, opts = {}, cryptoObj) {
  const n = parseCount(count);
  return Array.from({ length: n }, () => formatUuid(generateV4(cryptoObj), opts));
}

const VARIANTS = [
  [0x80, 0x00, 'NCS (reserved, backward compatibility)'],
  [0xc0, 0x80, 'RFC 4122 / RFC 9562 (standard)'],
  [0xe0, 0xc0, 'Microsoft (reserved, GUID)'],
  [0xe0, 0xe0, 'Reserved for future definition'],
];
// Common names by version (RFC 9562).
const VERSION_NAMES = { 1: 'time-based (Gregorian)', 2: 'DCE security', 3: 'name-based (MD5)', 4: 'random', 5: 'name-based (SHA-1)', 6: 'reordered time-based', 7: 'Unix-time ordered', 8: 'custom' };

/**
 * Inspect a UUID string. Accepts braces, urn:uuid: prefix and missing hyphens.
 * Returns { valid, message?, canonical?, version?, variant?, nil?, max? }.
 */
export function inspectUuid(input) {
  let s = String(input ?? '').trim();
  if (!s) return { valid: false, message: 'Enter a UUID to inspect.' };
  s = s.replace(/^urn:uuid:/i, '');
  if (/^\{.*\}$/.test(s)) s = s.slice(1, -1);
  const bare = s.replace(/-/g, '');
  if (/[^0-9a-f]/i.test(bare)) {
    const c = /[^0-9a-f]/i.exec(bare)[0];
    return { valid: false, message: `Invalid character "${c}": UUIDs only contain hexadecimal digits (0-9, a-f) and hyphens.` };
  }
  if (bare.length !== 32) return { valid: false, message: `Expected 32 hex digits but found ${bare.length}.` };
  if (s.includes('-') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return { valid: false, message: 'Hyphens are in the wrong places (expected 8-4-4-4-12).' };
  }
  const canonical = hyphenate(bare.toLowerCase());
  const bytes = bare.match(/../g).map(h => parseInt(h, 16));
  const nil = bare === '0'.repeat(32), max = bare.toLowerCase() === 'f'.repeat(32);
  const variant = VARIANTS.find(([mask, val]) => (bytes[8] & mask) === val)[2];
  const version = bytes[6] >> 4;
  const rfc = (bytes[8] & 0xc0) === 0x80;
  return {
    valid: true, canonical, nil, max, variant,
    version: nil || max ? null : version,
    versionName: nil ? 'nil UUID' : max ? 'max UUID' : (rfc ? VERSION_NAMES[version] : undefined),
  };
}
