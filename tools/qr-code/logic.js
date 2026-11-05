// Pure, DOM-free helpers for the QR Code tool: payload builders (with escaping), QR matrix creation on top of
// the vendored qrcode-generator (passed in, so this file has no imports), SVG output, contrast checks and
// parsing/type detection of decoded QR text (Wi-Fi, vCard, MECARD, mailto, SMS, geo, URL ...).

export const EC_LEVELS = ['L', 'M', 'Q', 'H'];
export const EC_INFO = { L: 'Low (~7% recoverable)', M: 'Medium (~15%)', Q: 'Quartile (~25%)', H: 'High (~30%)' };
/** Maximum payload of a version-40 symbol per mode and error-correction level (ISO/IEC 18004). */
export const MAX_CAPACITY = {
  Numeric: { L: 7089, M: 5596, Q: 3993, H: 3057 },
  Alphanumeric: { L: 4296, M: 3391, Q: 2420, H: 1852 },
  Byte: { L: 2953, M: 2331, Q: 1663, H: 1273 },
};
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DECODE_DIM = 2000;

// ---------------------------------------------------------------- text helpers
export function utf8Bytes(str) { return Array.from(new TextEncoder().encode(str)); }
export const byteLength = str => new TextEncoder().encode(str).length;

/** Pick the most compact QR data mode for the text. */
export function detectMode(text) {
  if (/^[0-9]+$/.test(text)) return 'Numeric';
  if (/^[0-9A-Z $%*+\-./:]+$/.test(text)) return 'Alphanumeric';
  return 'Byte';
}
export function dataLength(text, mode) { return mode === 'Byte' ? byteLength(text) : text.length; }

// ---------------------------------------------------------------- payload builders
const escWifi = s => String(s).replace(/([\\;,:"])/g, '\\$1');
const wifiVal = s => (/^[0-9a-fA-F]+$/.test(s) ? `"${s}"` : escWifi(s)); // all-hex values must be quoted or they are read as hex bytes
export function buildWifi({ ssid = '', password = '', type = 'WPA', hidden = false } = {}) {
  if (!ssid) return { error: 'Enter the network name (SSID).' };
  if (!['WPA', 'WEP', 'nopass'].includes(type)) return { error: 'Unknown security type.' };
  if (type !== 'nopass' && !password) return { error: 'Enter the password, or choose “No password”.' };
  if (type === 'WPA' && (password.length < 8 || password.length > 63)) return { error: 'WPA passwords must be 8\u201363 characters.' };
  return { text: `WIFI:T:${type};S:${wifiVal(ssid)};${type === 'nopass' ? '' : `P:${wifiVal(password)};`}${hidden ? 'H:true;' : ''};` };
}

const escVcard = s => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([;,])/g, '\\$1');
export function buildVcard(f = {}) {
  const g = k => String(f[k] ?? '').trim();
  if (!g('firstName') && !g('lastName') && !g('org')) return { error: 'Enter at least a name or an organisation.' };
  const lines = ['BEGIN:VCARD', 'VERSION:3.0',
    `N:${escVcard(g('lastName'))};${escVcard(g('firstName'))};;;`,
    `FN:${escVcard([g('firstName'), g('lastName')].filter(Boolean).join(' ') || g('org'))}`];
  if (g('org')) lines.push(`ORG:${escVcard(g('org'))}`);
  if (g('title')) lines.push(`TITLE:${escVcard(g('title'))}`);
  if (g('phone')) lines.push(`TEL;TYPE=CELL:${escVcard(g('phone'))}`);
  if (g('email')) lines.push(`EMAIL:${escVcard(g('email'))}`);
  if (g('url')) lines.push(`URL:${escVcard(g('url'))}`);
  if (g('street') || g('city') || g('region') || g('postal') || g('country'))
    lines.push(`ADR:;;${escVcard(g('street'))};${escVcard(g('city'))};${escVcard(g('region'))};${escVcard(g('postal'))};${escVcard(g('country'))}`);
  if (g('note')) lines.push(`NOTE:${escVcard(g('note'))}`);
  lines.push('END:VCARD');
  return { text: lines.join('\n') };
}

export const isEmail = s => /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(s);
export function buildEmail({ to = '', subject = '', body = '' } = {}) {
  to = to.trim(); if (!to) return { error: 'Enter the recipient address.' };
  if (!to.split(',').every(a => isEmail(a.trim()))) return { error: 'That does not look like a valid email address.' };
  const q = [];
  if (subject) q.push(`subject=${encodeURIComponent(subject)}`);
  if (body) q.push(`body=${encodeURIComponent(body)}`);
  return { text: `mailto:${to.split(',').map(a => a.trim()).join(',')}${q.length ? '?' + q.join('&') : ''}` };
}

export function buildSms({ number = '', message = '' } = {}) {
  const n = number.replace(/[\s().-]/g, '');
  if (!n) return { error: 'Enter the phone number.' };
  if (!/^\+?[0-9]{3,15}$/.test(n)) return { error: 'Phone numbers may contain digits, an optional leading +, and 3\u201315 digits.' };
  return { text: `SMSTO:${n}:${message}` };
}

export function buildGeo({ lat = '', lng = '' } = {}) {
  const a = Number(String(lat).trim()), b = Number(String(lng).trim());
  if (String(lat).trim() === '' || String(lng).trim() === '') return { error: 'Enter both latitude and longitude.' };
  if (!Number.isFinite(a) || a < -90 || a > 90) return { error: 'Latitude must be a number between -90 and 90.' };
  if (!Number.isFinite(b) || b < -180 || b > 180) return { error: 'Longitude must be a number between -180 and 180.' };
  return { text: `geo:${a},${b}` };
}

export function buildUrl(input = '') {
  const s = input.trim(); if (!s) return { error: 'Enter a URL.' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/\s]+:\d+(\/|$)/.test(s)) return { text: s };
  return { text: `https://${s}`, note: 'No scheme given, so https:// was added.' };
}

export function buildPayload(preset, f = {}) {
  switch (preset) {
    case 'text': return f.text ? { text: f.text } : { error: 'Enter some text.' };
    case 'url': return buildUrl(f.url);
    case 'wifi': return buildWifi(f);
    case 'vcard': return buildVcard(f);
    case 'email': return buildEmail(f);
    case 'sms': return buildSms(f);
    case 'geo': return buildGeo(f);
    default: return { error: 'Unknown content type.' };
  }
}

// ---------------------------------------------------------------- matrix / svg
/**
 * Build the module matrix. `qrcode` is the vendored qrcode-generator factory.
 * Returns { size, version, mode, bytes, ec, isDark(r,c), rows: boolean[][] } or { error }.
 */
export function makeMatrix(qrcode, text, ec = 'M') {
  if (!text) return { error: 'Nothing to encode.' };
  if (!EC_LEVELS.includes(ec)) return { error: 'Unknown error-correction level.' };
  qrcode.stringToBytes = utf8Bytes; // the library defaults to Latin-1; QR readers expect UTF-8 for non-ASCII text
  const mode = detectMode(text), len = dataLength(text, mode), max = MAX_CAPACITY[mode][ec];
  if (len > max) return { error: capacityMessage(mode, len, ec) };
  let q;
  try { q = qrcode(0, ec); q.addData(text, mode); q.make(); }
  catch (e) { return { error: capacityMessage(mode, len, ec, String(e?.message || e)) }; }
  const size = q.getModuleCount(), rows = [];
  for (let r = 0; r < size; r++) { const row = []; for (let c = 0; c < size; c++) row.push(!!q.isDark(r, c)); rows.push(row); }
  return { size, version: (size - 17) / 4, mode, bytes: byteLength(text), length: len, ec, rows, isDark: (r, c) => rows[r][c] };
}
export function capacityMessage(mode, len, ec, detail = '') {
  const unit = mode === 'Byte' ? 'bytes (UTF-8)' : 'characters';
  const others = EC_LEVELS.filter(l => MAX_CAPACITY[mode][l] >= len && l !== ec);
  return `Too much data: ${len.toLocaleString()} ${unit} in ${mode.toLowerCase()} mode, but a QR code holds at most ${MAX_CAPACITY[mode][ec].toLocaleString()} at error-correction level ${ec} (version 40).`
    + (others.length ? ` Lower the error-correction level (${others.join(' or ')} would fit) or shorten the content.` : ' Shorten the content (emoji and CJK characters take 3\u20134 bytes each).')
    + (detail && !/overflow/i.test(detail) ? ` (${detail})` : '');
}

export const isHexColor = s => /^#[0-9a-fA-F]{6}$/.test(String(s));
/** Integer module scale so the symbol is pixel-exact: returns { scale, total, px, tooSmall }. */
export function computeScale(modules, margin, targetPx) {
  const units = modules + 2 * margin, scale = Math.max(1, Math.floor(targetPx / units));
  return { scale, units, px: scale * units, tooSmall: targetPx < units };
}

/** Compact SVG: one <path> with a rectangle per horizontal run of dark modules. No external references. */
export function matrixToSvg(m, { margin = 4, size = 512, fg = '#000000', bg = '#ffffff', transparent = false } = {}) {
  if (!isHexColor(fg) || !isHexColor(bg)) throw new Error('Colours must be #rrggbb.');
  const units = m.size + 2 * margin; let d = '';
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.rows[r][c]) { c++; continue; }
      let e = c; while (e < m.size && m.rows[r][e]) e++;
      d += `M${c + margin} ${r + margin}h${e - c}v1h-${e - c}z`; c = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${units} ${units}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + (transparent ? '' : `<rect width="${units}" height="${units}" fill="${bg}"/>`) + `<path fill="${fg}" d="${d}"/></svg>`;
}

// ---------------------------------------------------------------- colours
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrastRatio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** Returns a list of readable-QR warnings for the colour/margin choice. */
export function checkReadability(fg, bg, margin, transparent = false) {
  const w = [];
  const back = transparent ? '#ffffff' : bg, ratio = contrastRatio(fg, back);
  if (luminance(fg) > luminance(back)) w.push('Light-on-dark (inverted) codes are not read by many scanners. Use a dark foreground on a light background.');
  if (ratio < 3) w.push(`Contrast is very low (${ratio.toFixed(1)}:1); scanners will probably fail. Aim for at least 4:1, ideally much higher.`);
  else if (ratio < 4.5 && !(luminance(fg) > luminance(back))) w.push(`Contrast is only ${ratio.toFixed(1)}:1; some scanners may struggle. Darker modules or a lighter background read more reliably.`);
  if (transparent) w.push('With a transparent background the code is only as readable as whatever it is placed on; scanners expect a light area behind the dark modules.');
  if (margin < 4) w.push(`A quiet zone of ${margin} module${margin === 1 ? '' : 's'} is smaller than the 4 required by the standard; some scanners will fail.`);
  return { ratio, warnings: w };
}

// ---------------------------------------------------------------- reading: parsing decoded text
function splitUnescaped(s, sep) {
  const parts = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; }
    else if (s[i] === sep) { parts.push(cur); cur = ''; }
    else cur += s[i];
  }
  parts.push(cur); return parts;
}
const unescapeSlash = s => s.replace(/\\(.)/g, '$1');

export function parseWifi(text) {
  const m = /^WIFI:(.*)$/is.exec(text.trim()); if (!m) return null;
  const f = {};
  for (const part of splitUnescaped(m[1], ';')) {
    if (!part) continue;
    const i = part.indexOf(':'); if (i < 1) continue;
    let v = unescapeSlash(part.slice(i + 1));
    f[part.slice(0, i).toUpperCase()] = v;
  }
  const unq = v => (v && v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
  if (f.S === undefined) return null;
  return { ssid: unq(f.S), password: unq(f.P ?? ''), security: f.T || 'nopass', hidden: String(f.H).toLowerCase() === 'true' };
}

const unescapeVcard = s => s.replace(/\\([nN])/g, '\n').replace(/\\([\\;,])/g, '$1');
export function parseVcard(text) {
  if (!/^\s*BEGIN:VCARD/i.test(text)) return null;
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = []; const get = [];
  for (const line of lines) {
    const i = line.indexOf(':'); if (i < 1) continue;
    const [name, ...params] = line.slice(0, i).split(';'); const key = name.toUpperCase().replace(/^.*\./, '');
    if (['BEGIN', 'END', 'VERSION'].includes(key)) continue;
    const val = line.slice(i + 1);
    const type = params.map(p => p.replace(/^TYPE=/i, '')).filter(p => !/=/.test(p)).join(',').toLowerCase();
    get.push({ key, val, type });
  }
  const label = { FN: 'Name', ORG: 'Organisation', TITLE: 'Title', TEL: 'Phone', EMAIL: 'Email', URL: 'Website', NOTE: 'Note', BDAY: 'Birthday' };
  for (const { key, val, type } of get) {
    if (key === 'N') { const p = splitUnescaped(val, ';').map(unescapeVcard); if (!get.some(g => g.key === 'FN')) out.push({ label: 'Name', value: [p[3], p[1], p[2], p[0]].filter(Boolean).join(' ') }); }
    else if (key === 'ADR') out.push({ label: 'Address', value: splitUnescaped(val, ';').map(unescapeVcard).filter(Boolean).join(', ') });
    else if (label[key]) out.push({ label: label[key] + (type && ['TEL', 'EMAIL'].includes(key) ? ` (${type})` : ''), value: unescapeVcard(val).replace(/\\,/g, ',') });
  }
  return { fields: out };
}

export function parseMecard(text) {
  const m = /^MECARD:(.*)$/is.exec(text.trim()); if (!m) return null;
  const labels = { N: 'Name', TEL: 'Phone', EMAIL: 'Email', URL: 'Website', ADR: 'Address', NOTE: 'Note', ORG: 'Organisation', BDAY: 'Birthday' };
  const fields = [];
  for (const part of splitUnescaped(m[1], ';')) {
    const i = part.indexOf(':'); if (i < 1) continue;
    const k = part.slice(0, i).toUpperCase(); let v = unescapeSlash(part.slice(i + 1));
    if (k === 'N') v = v.split(',').reverse().join(' ').trim();
    if (labels[k]) fields.push({ label: labels[k], value: v });
  }
  return { fields };
}

function parseQuery(q) {
  const o = {}; for (const kv of q.split('&')) { if (!kv) continue; const i = kv.indexOf('='); const k = i < 0 ? kv : kv.slice(0, i); let v = i < 0 ? '' : kv.slice(i + 1); try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep raw */ } o[k.toLowerCase()] = v; } return o;
}
export function parseMailto(text) {
  const m = /^mailto:([^?]*)(?:\?(.*))?$/is.exec(text.trim()); if (!m) return null;
  let to = m[1]; try { to = decodeURIComponent(to); } catch { /* raw */ }
  const q = parseQuery(m[2] || '');
  return { to, subject: q.subject || '', body: q.body || '', cc: q.cc || '' };
}
export function parseSms(text) {
  let m = /^smsto:([^:]*):?(.*)$/is.exec(text.trim());
  if (m) return { number: m[1], message: m[2] };
  m = /^sms:([^?;]*)(?:[?;](.*))?$/is.exec(text.trim());
  if (m) { const q = parseQuery(m[2] || ''); return { number: m[1], message: q.body || '' }; }
  return null;
}
export function parseGeo(text) {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,-?\d+(?:\.\d+)?)?(?:[;?].*)?$/i.exec(text.trim()); if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// Punycode (RFC 3492) decoder, used to show what an xn-- host really looks like.
export function punycodeDecode(input) {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const adapt = (delta, num, first) => { delta = first ? Math.floor(delta / damp) : delta >> 1; delta += Math.floor(delta / num); let k = 0; while (delta > (((base - tMin) * tMax) >> 1)) { delta = Math.floor(delta / (base - tMin)); k += base; } return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew)); };
  const digit = c => (c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : base);
  let n = 128, i = 0, bias = 72; const out = [];
  let b = input.lastIndexOf('-'); if (b < 0) b = 0;
  for (let j = 0; j < b; j++) out.push(input.charCodeAt(j));
  for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
    const oldi = i; let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= input.length) throw new RangeError('Bad punycode');
      const d = digit(input.charCodeAt(idx++)); if (d >= base) throw new RangeError('Bad punycode');
      i += d * w; const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break; w *= base - t;
    }
    const len = out.length + 1; bias = adapt(i - oldi, len, oldi === 0); n += Math.floor(i / len); i %= len;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
export function hostToUnicode(host) {
  return host.split('.').map(l => { if (!/^xn--/i.test(l)) return l; try { return punycodeDecode(l.slice(4)); } catch { return l; } }).join('.');
}

/** Analyse a decoded URL. Only http/https are ever linkable. */
export function analyzeUrl(text) {
  const raw = text.trim(); let u;
  try { u = new URL(raw); } catch { return null; }
  if (/\s/.test(raw)) return null;
  const warnings = [], scheme = u.protocol.replace(':', '').toLowerCase();
  const linkable = scheme === 'http' || scheme === 'https';
  if (!linkable) {
    warnings.push(['javascript', 'data', 'vbscript', 'file', 'blob'].includes(scheme) ? `This is a "${scheme}:" address, not a web page. It is shown as text and cannot be opened from here; do not paste it into your browser.` : `"${scheme}:" links are not opened from this tool; copy it if you trust it.`);
    return { href: raw, scheme, linkable, host: '', unicodeHost: '', warnings };
  }
  const host = u.hostname, unicodeHost = hostToUnicode(host);
  if (/(^|\.)xn--/i.test(host)) warnings.push(`The host uses internationalised characters (punycode). It displays as "${unicodeHost}" but may be imitating another site; check the spelling carefully.`);
  if (/[^\x00-\x7f]/.test(host)) warnings.push('The host contains non-ASCII characters.');
  if (u.username || u.password) warnings.push('The address contains a username/password section before the host (user@host). Attackers use this to make a link look like a different site; the real host is shown above.');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[.*\]$/.test(host)) warnings.push('The link points at a raw IP address rather than a domain name.');
  if (scheme === 'http') warnings.push('This link is not encrypted (http://).');
  if (raw.length > 500) warnings.push('This is a very long URL.');
  if (u.port && !['80', '443'].includes(u.port)) warnings.push(`It uses a non-standard port (${u.port}).`);
  return { href: u.href, scheme, linkable, host, unicodeHost, warnings };
}

/** Classify decoded text. Returns { type, label, parsed?, url? }. */
export function detectType(text) {
  const t = String(text ?? '');
  let p;
  if ((p = parseWifi(t))) return { type: 'wifi', label: 'Wi-Fi network', parsed: p };
  if ((p = parseVcard(t))) return { type: 'vcard', label: 'Contact (vCard)', parsed: p };
  if ((p = parseMecard(t))) return { type: 'mecard', label: 'Contact (MECARD)', parsed: p };
  if ((p = parseMailto(t))) return { type: 'email', label: 'Email', parsed: p };
  if ((p = parseSms(t))) return { type: 'sms', label: 'SMS', parsed: p };
  if ((p = parseGeo(t))) return { type: 'geo', label: 'Location', parsed: p };
  if (/^tel:/i.test(t.trim())) return { type: 'tel', label: 'Phone number', parsed: { number: t.trim().slice(4) } };
  if (/^otpauth(-migration)?:\/\//i.test(t.trim())) return { type: 'otp', label: 'Authenticator (2FA) secret', parsed: {} };
  if ((p = analyzeUrl(t))) return { type: 'url', label: p.linkable ? 'Web link' : 'Link (not a web address)', url: p };
  return { type: 'text', label: 'Plain text' };
}

// ---------------------------------------------------------------- reading: image helpers
export function scaleToFit(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scale: s };
}

function cropRgba(img, x0, y0, w, h) {
  if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) return { data: new Uint8ClampedArray(img.data), width: w, height: h };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { data: out, width: w, height: h };
}
function findInRegion(jsQR, region, max) {
  const { width, height, data } = region, found = [];
  for (let n = 0; n < max; n++) {
    const r = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
    if (!r) break;
    const pts = [r.location.topLeftCorner, r.location.topRightCorner, r.location.bottomLeftCorner, r.location.bottomRightCorner];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.12 + 2, padY = (Math.max(...ys) - Math.min(...ys)) * 0.12 + 2;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - padX)), x1 = Math.min(width - 1, Math.ceil(Math.max(...xs) + padX));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - padY)), y1 = Math.min(height - 1, Math.ceil(Math.max(...ys) + padY));
    found.push({ text: r.data, bounds: { x0, y0, x1, y1 } });
    for (let y = y0; y <= y1; y++) data.fill(255, (y * width + x0) * 4, (y * width + x1 + 1) * 4);
  }
  return found;
}
/**
 * Find several QR codes in one RGBA image using jsQR, which decodes only one code per call and often fails when
 * several are present. Strategy: whole image (painting each found code white and repeating), then overlapping
 * 2x2 tiles, then 3x3 tiles if nothing was found yet. Duplicates (same text, overlapping box) are merged.
 * `jsQR` is the vendored function; image = { data: Uint8ClampedArray, width, height }.
 */
export function findAllQr(jsQR, image, { max = 8 } = {}) {
  const { width: W, height: H } = image, all = [];
  const add = (list, ox, oy) => {
    for (const f of list) {
      const b = { x0: f.bounds.x0 + ox, y0: f.bounds.y0 + oy, x1: f.bounds.x1 + ox, y1: f.bounds.y1 + oy };
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      if (all.some(a => a.text === f.text && cx >= a.bounds.x0 && cx <= a.bounds.x1 && cy >= a.bounds.y0 && cy <= a.bounds.y1)) continue;
      all.push({ text: f.text, bounds: b });
    }
  };
  add(findInRegion(jsQR, cropRgba(image, 0, 0, W, H), max), 0, 0);
  for (const [cols, rows] of [[2, 1], [1, 2], [2, 2], [3, 3]]) {
    if (cols === 3 && all.length) break;
    if (W < 120 * cols || H < 120 * rows) continue;
    const tw = Math.ceil(W / cols), th = Math.ceil(H / rows), ow = Math.round(tw * 0.1), oh = Math.round(th * 0.1);
    for (let ty = 0; ty < rows && all.length < max; ty++) for (let tx = 0; tx < cols && all.length < max; tx++) {
      const x0 = Math.max(0, tx * tw - ow), y0 = Math.max(0, ty * th - oh);
      const w = Math.min(W - x0, (tx * tw - x0) + tw + (tx < cols - 1 ? ow : 0)), h = Math.min(H - y0, (ty * th - y0) + th + (ty < rows - 1 ? oh : 0));
      add(findInRegion(jsQR, cropRgba(image, x0, y0, w, h), max), x0, y0);
    }
  }
  return all.slice(0, max);
}

/** Rasterise a matrix to RGBA (dark = black on white, with quiet zone) - used by tests and by the camera-less decode check. */
export function matrixToRgba(m, scale = 4, margin = 4, canvasW = 0, canvasH = 0, ox = 0, oy = 0) {
  const units = m.size + 2 * margin, side = units * scale;
  const W = canvasW || side, H = canvasH || side, data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const r = Math.floor(y / scale) - margin, c = Math.floor(x / scale) - margin;
    if (r >= 0 && c >= 0 && r < m.size && c < m.size && m.rows[r][c]) { const i = ((y + oy) * W + (x + ox)) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  }
  return { data, width: W, height: H };
}

export function friendlyCameraError(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError') return 'Camera permission was denied. Allow camera access for this site in your browser\u2019s address-bar/site settings, then try again.';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No camera was found on this device.';
  if (n === 'NotReadableError' || n === 'TrackStartError') return 'The camera is in use by another application or could not be started.';
  if (n === 'OverconstrainedError') return 'The requested camera is not available.';
  if (n === 'SecurityError') return 'Camera access is blocked. Cameras need a secure context (HTTPS or localhost).';
  if (n === 'AbortError') return 'Camera start was interrupted. Try again.';
  return `Could not start the camera${err?.message ? `: ${err.message}` : '.'}`;
}
