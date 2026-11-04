// Pure timestamp / time-zone logic (no DOM). Relies only on Date and Intl.

/** Supported range: years 0001-9999 (inclusive). */
export const MIN_MS = -62135596800000;
export const MAX_MS = 253402300799999;

/** Date.UTC that does not remap years 0-99 to 1900-1999. */
export function utcMs(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms)); t.setUTCFullYear(y, mo - 1, d);
  return t.getTime();
}

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');

// ------------------------------------------------------------------ units

/** Guess the unit of a numeric Unix timestamp from its magnitude. */
export function detectUnit(n) {
  const a = Math.abs(n);
  if (a < 1e11) return 's';      // up to year ~5138 in seconds
  if (a < 1e14) return 'ms';
  if (a < 1e17) return 'us';
  return 'ns';
}
export const UNIT_NAMES = { s: 'seconds', ms: 'milliseconds', us: 'microseconds', ns: 'nanoseconds' };
/** Nanoseconds per unit, and the number of fractional digits that still matter (exact BigInt maths). */
const NS_PER = { s: 1000000000n, ms: 1000000n, us: 1000n, ns: 1n };
const FRAC_DIGITS = { s: 9, ms: 6, us: 3, ns: 0 };

/** Floor division for BigInt (rounds toward negative infinity). */
export const floorDiv = (a, b) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };

/**
 * Ambiguity hint: integers between 1e8 and 1e11 are valid both as seconds (1973-5138) and as milliseconds (Jan 1970-1973).
 * Returns null or { assumed, alternative }.
 */
export function unitAmbiguity(text, unit = 'auto') {
  if (unit !== 'auto') return null;
  const m = /^[+-]?(\d+)(?:\.\d+)?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const a = Math.abs(Number(m[1]));
  return a >= 1e8 && a < 1e11 ? { assumed: 's', alternative: 'ms' } : null;
}

/**
 * Convert text like "1700000000" or "-86400.5" to a Date.
 * unit: 'auto' | 's' | 'ms' | 'us' | 'ns'. Returns { ms, ns (BigInt, exact, truncated toward zero at 1 ns), us (BigInt), unit, date, ambiguity };
 * throws Error on invalid input. Big values never pass through floating point.
 */
export function unixToDate(text, unit = 'auto') {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('Enter a Unix timestamp.');
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error('Not a number: a Unix timestamp contains only digits (optionally a leading minus and a decimal point).');
  const intPart = m[2].replace(/^0+(?=\d)/, '');
  const u = unit === 'auto' ? detectUnit(Number(intPart)) : unit;
  if (!NS_PER[u]) throw new Error(`Unknown unit "${unit}".`);
  const fd = FRAC_DIGITS[u];
  const frac = (m[3] || '').slice(0, fd).padEnd(fd, '0');
  let ns = BigInt(intPart) * NS_PER[u] + (fd ? BigInt(frac) : 0n);
  if (m[1] === '-') ns = -ns;
  const msBig = floorDiv(ns, 1000000n);
  if (msBig > BigInt(MAX_MS)) checkRange(Infinity);
  if (msBig < BigInt(MIN_MS)) checkRange(-Infinity);
  const ms = Number(msBig);
  checkRange(ms);
  return { ms, ns, us: floorDiv(ns, 1000n), unit: u, date: new Date(ms), ambiguity: unitAmbiguity(s, unit) };
}

/** ISO 8601 UTC string with nanosecond precision from exact nanoseconds. */
export function isoFromNs(ns) {
  const ms = Number(floorDiv(ns, 1000000n));
  const sub = ((ns % 1000000000n) + 1000000000n) % 1000000000n;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${String(sub).padStart(9, '0')}Z`);
}

function checkRange(ms) {
  if (ms === -Infinity || ms < MIN_MS) throw new Error('Out of range: the date is before year 0001.');
  if (!Number.isFinite(ms) || ms > MAX_MS) throw new Error('Out of range: the date is after year 9999 (max 253402300799 seconds). Check the unit; this may be milliseconds or microseconds.');
}

// ------------------------------------------------------------------ time zones

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return dtfCache.get(tz);
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  const year = o.era === 'B' ? 1 - Number(o.year) : Number(o.year); // BC years are not expected, but stay safe
  return { year, month: +o.month, day: +o.day, hour: +o.hour, minute: +o.minute, second: +o.second };
}

/** UTC offset (ms, east positive) of `tz` at the instant `ms`. */
export function tzOffsetMs(ms, tz) {
  if (tz === 'UTC') return 0;
  const p = zonedParts(ms, tz);
  const asUtc = utcMs(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export const formatOffset = off => {
  const m = Math.round(off / 60000), sign = m < 0 ? '-' : '+', a = Math.abs(m);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

export const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/**
 * Convert wall-clock fields in `tz` to a UTC instant, handling DST.
 * Returns { ms, status: 'ok'|'gap'|'ambiguous', note? }.
 *  - gap: the wall time does not exist (spring forward); shifted forward by the gap like JS Date.
 *  - ambiguous: the wall time occurs twice (fall back); the earlier occurrence is used.
 */
export function zonedToUtc(f, tz) {
  const wall = utcMs(f.year, f.month, f.day, f.hour, f.minute, f.second, f.ms || 0);
  if (tz === 'UTC') return { ms: wall, status: 'ok' };
  // Candidate offsets: those in effect a day before and after the naive guess cover any single transition.
  const offs = [...new Set([tzOffsetMs(wall - 864e5, tz), tzOffsetMs(wall + 864e5, tz)])];
  const valid = offs.map(o => wall - o).filter(c => tzOffsetMs(c, tz) === wall - c).sort((a, b) => a - b);
  if (valid.length === 1) return { ms: valid[0], status: 'ok' };
  if (valid.length > 1) return { ms: valid[0], status: 'ambiguous', note: `This local time occurs twice in ${tz} (clocks go back); the earlier occurrence is used.` };
  // Gap: interpret using the offset in effect before the transition.
  const before = tzOffsetMs(wall - 864e5, tz);
  return { ms: wall - before, status: 'gap', note: `This local time does not exist in ${tz} (clocks jump forward); it was shifted forward.` };
}

// ------------------------------------------------------------------ parsing input dates

/** Validate calendar fields; throws Error with a specific message. */
export function validateFields(f) {
  const { year, month, day, hour, minute, second } = f;
  const ms = f.ms || 0;
  for (const [k, v] of Object.entries({ year, month, day, hour, minute, second, ms })) {
    if (!Number.isInteger(v)) throw new Error(`${k} must be a whole number.`);
  }
  if (year < 1 || year > 9999) throw new Error('Year must be between 1 and 9999.');
  if (month < 1 || month > 12) throw new Error('Month must be between 1 and 12.');
  const dim = new Date(Date.UTC(2001, month, 0)).getUTCDate() + (month === 2 && isLeap(year) ? 1 : 0);
  if (day < 1 || day > dim) throw new Error(`Day must be between 1 and ${dim} for ${pad(month)}/${year}.`);
  if (hour < 0 || hour > 23) throw new Error('Hour must be between 0 and 23.');
  if (minute < 0 || minute > 59) throw new Error('Minute must be between 0 and 59.');
  if (second < 0 || second > 59) throw new Error('Second must be between 0 and 59.');
  if (ms < 0 || ms > 999) throw new Error('Milliseconds must be between 0 and 999.');
}
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Convert calendar fields to a Unix instant in `tz` ('UTC' or an IANA name).
 * Returns { ms, seconds, status, note }.
 */
export function fieldsToUnix(f, tz = 'UTC') {
  validateFields(f);
  const r = zonedToUtc({ ...f, ms: f.ms || 0 }, tz);
  checkRange(r.ms);
  return { ...r, seconds: Math.floor(r.ms / 1000) };
}

const ISO_RE = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parse an ISO 8601 date/time. Date-only values and strings with Z/offset are absolute (date-only = UTC midnight);
 * date-times without an offset are interpreted in `tz`.
 * Returns { ms, seconds, status, note, offsetGiven }.
 */
export function parseIso(text, tz = 'UTC') {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('Enter an ISO 8601 date, e.g. 2023-11-14T22:13:20Z.');
  const m = ISO_RE.exec(s);
  if (!m) throw new Error('Not a valid ISO 8601 date. Expected YYYY-MM-DD, YYYY-MM-DDTHH:mm[:ss[.sss]] optionally followed by Z or +HH:MM.');
  const f = { year: Number(m[1]), month: +m[2], day: +m[3], hour: +(m[4] ?? 0), minute: +(m[5] ?? 0), second: +(m[6] ?? 0),
    ms: m[7] ? Math.round(Number(('0.' + m[7]).slice(0, 12)) * 1000) : 0 };
  if (f.ms === 1000) f.ms = 999;
  validateFields(f);
  if (m[8]) {
    let off = 0;
    if (m[8].toUpperCase() !== 'Z') {
      const d = m[8].replace(':', ''), sign = d[0] === '-' ? -1 : 1;
      const oh = +d.slice(1, 3), om = d.length > 3 ? +d.slice(3, 5) : 0;
      if (oh > 23 || om > 59) throw new Error('Invalid UTC offset (hours 00-23, minutes 00-59).');
      off = sign * (oh * 60 + om) * 60000;
    }
    const ms = utcMs(f.year, f.month, f.day, f.hour, f.minute, f.second, f.ms) - off;
    checkRange(ms);
    return { ms, seconds: Math.floor(ms / 1000), status: 'ok', offsetGiven: true };
  }
  const dateOnly = m[4] === undefined;
  const r = fieldsToUnix(f, dateOnly ? 'UTC' : tz);
  return { ...r, offsetGiven: false, dateOnly };
}

// ------------------------------------------------------------------ formatting

/** "Tue, 2023-11-14 17:13:20.000 EST (UTC-05:00)" for an instant in a zone. */
export function formatInZone(ms, tz) {
  const p = zonedParts(ms, tz);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms));
  let abbr = tz;
  try { abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(x => x.type === 'timeZoneName').value; } catch { /* keep tz */ }
  const msPart = pad(((ms % 1000) + 1000) % 1000, 3);
  return `${wd}, ${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${msPart} ${abbr} (${formatOffset(tzOffsetMs(ms, tz))})`;
}

/** Relative time such as "3 days ago" / "in 2 hours". */
export function relativeTime(ms, nowMs = Date.now()) {
  const diff = ms - nowMs, a = Math.abs(diff);
  if (a < 1000) return 'just now';
  const units = [['year', 365 * 86400000], ['month', 30 * 86400000], ['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  for (const [name, size] of units) {
    if (a >= size) {
      const q = Math.floor(a / size);
      return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(diff < 0 ? -q : q, name);
    }
  }
  return 'just now';
}

/** All outputs for an instant, as [label, value] rows. */
export function describeInstant(ms, tz, nowMs = Date.now()) {
  const d = new Date(ms);
  return [
    ['UTC', formatInZone(ms, 'UTC')],
    ['Local', formatInZone(ms, browserTimeZone())],
    ['ISO 8601', d.toISOString()],
    ['RFC 2822 / UTC string', d.toUTCString()],
    ['Relative', relativeTime(ms, nowMs)],
    [`Selected zone (${tz})`, formatInZone(ms, tz)],
  ];
}

const FALLBACK_ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Africa/Cairo', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];

/** IANA zone names (always includes UTC and the browser zone). */
export function listTimeZones() {
  let z;
  try { z = Intl.supportedValuesOf('timeZone'); } catch { z = FALLBACK_ZONES; }
  const set = new Set(['UTC', ...z, browserTimeZone()]);
  return [...set].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}
