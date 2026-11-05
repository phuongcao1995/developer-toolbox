// Pure, DOM-free logic for the Image Converter: size/fit maths, file-name templates, limits, format sniffing,
// animation detection and a small STORE-only ZIP writer (CRC-32).

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PIXELS = 50e6;
export const MAX_OUTPUT_SIDE = 16384;
export const MAX_OUTPUT_PIXELS = 100e6;
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export const FORMATS = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG', lossy: false },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', lossy: true },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP', lossy: true },
  avif: { mime: 'image/avif', ext: 'avif', label: 'AVIF', lossy: true },
};
export const mimeToExt = m => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }[m] || 'img');
export const mimeToFormatKey = m => Object.keys(FORMATS).find(k => FORMATS[k].mime === m) || null;
export const clampQuality = q => { const n = Number(q); return Number.isFinite(n) ? Math.min(1, Math.max(0.01, n / 100)) : 0.9; };

// ---------------------------------------------------------------- limits
export function checkInputLimits(size, w = 0, h = 0) {
  if (size > MAX_FILE_BYTES) return `This file is ${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB per file.`;
  if (w && h && w * h > MAX_PIXELS) return `This image is ${w}×${h} (${(w * h / 1e6).toFixed(1)} megapixels); the limit is ${MAX_PIXELS / 1e6} MP.`;
  return null;
}
export function checkOutputLimits(w, h) {
  if (w > MAX_OUTPUT_SIDE || h > MAX_OUTPUT_SIDE) return `Output ${w}×${h} exceeds the ${MAX_OUTPUT_SIDE}px per-side limit of browser canvases. Choose a smaller size.`;
  if (w * h > MAX_OUTPUT_PIXELS) return `Output ${w}×${h} is too large for a canvas (${(w * h / 1e6).toFixed(0)} MP). Choose a smaller size.`;
  return null;
}

// ---------------------------------------------------------------- size / fit
const posInt = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
/**
 * Work out the output canvas size and the source rectangle to draw.
 * opts: { mode: 'none'|'percent'|'width'|'height'|'max'|'box', percent, width, height, fit: 'contain'|'cover'|'stretch', noUpscale }
 * Returns { outW, outH, sx, sy, sw, sh, scaled, notes[] } or { error }.
 */
export function computeLayout(srcW, srcH, opts = {}) {
  const { mode = 'none', noUpscale = true, fit = 'contain' } = opts, notes = [];
  if (!(srcW > 0 && srcH > 0)) return { error: 'The image has no size.' };
  let scale = 1;
  const full = (w, h) => ({ outW: Math.max(1, w), outH: Math.max(1, h), sx: 0, sy: 0, sw: srcW, sh: srcH });
  const finish = (w, h) => { const err = checkOutputLimits(w, h); return err ? { error: err } : { ...full(w, h), notes }; };
  const cap = s => { if (noUpscale && s > 1) { notes.push('Upscaling skipped (image kept at its original size).'); return 1; } return s; };
  switch (mode) {
    case 'none': return finish(srcW, srcH);
    case 'percent': {
      const p = Number(opts.percent); if (!(p > 0)) return { error: 'Enter a percentage greater than 0.' };
      scale = cap(p / 100); return finish(Math.round(srcW * scale), Math.round(srcH * scale));
    }
    case 'width': {
      const w = posInt(opts.width); if (!w) return { error: 'Enter a width in pixels.' };
      scale = cap(w / srcW); return finish(Math.round(srcW * scale), Math.round(srcH * scale));
    }
    case 'height': {
      const h = posInt(opts.height); if (!h) return { error: 'Enter a height in pixels.' };
      scale = cap(h / srcH); return finish(Math.round(srcW * scale), Math.round(srcH * scale));
    }
    case 'max': {
      const m = posInt(opts.width); if (!m) return { error: 'Enter a maximum dimension in pixels.' };
      scale = cap(m / Math.max(srcW, srcH)); return finish(Math.round(srcW * scale), Math.round(srcH * scale));
    }
    case 'box': {
      let bw = posInt(opts.width), bh = posInt(opts.height);
      if (!bw || !bh) return { error: 'Enter both a width and a height.' };
      if (fit === 'stretch') {
        if (noUpscale && (bw > srcW || bh > srcH)) { notes.push('Upscaling skipped.'); bw = Math.min(bw, srcW); bh = Math.min(bh, srcH); }
        return finish(bw, bh);
      }
      if (fit === 'contain') { scale = cap(Math.min(bw / srcW, bh / srcH)); return finish(Math.round(srcW * scale), Math.round(srcH * scale)); }
      if (fit === 'cover') {
        let s = Math.max(bw / srcW, bh / srcH);
        if (noUpscale && s > 1) { notes.push('Upscaling skipped; the box was shrunk to fit the source.'); bw = Math.max(1, Math.round(bw / s)); bh = Math.max(1, Math.round(bh / s)); s = 1; }
        const err = checkOutputLimits(bw, bh); if (err) return { error: err };
        const sw = Math.min(srcW, bw / s), sh = Math.min(srcH, bh / s);
        return { outW: bw, outH: bh, sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, notes };
      }
      return { error: 'Unknown fit mode.' };
    }
    default: return { error: 'Unknown resize mode.' };
  }
}

// ---------------------------------------------------------------- names
export function sanitizeFilename(name) {
  let n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 180) || 'image';
}
export const stripExtension = n => String(n).replace(/\.[A-Za-z0-9]{1,5}$/, '');
/** Tokens: {name} {w} {h} {ext} {format} {n} (1-based index) {date} (YYYY-MM-DD). The extension is appended if the template has no {ext}. */
export function applyTemplate(tpl, { name, w, h, ext, index = 1, date = new Date() }) {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const t = String(tpl || '').trim() || '{name}';
  const hasExt = /\{ext\}/.test(t);
  let out = t.replace(/\{(name|w|h|ext|format|n|date)\}/g, (_, k) => ({ name: stripExtension(name), w, h, ext, format: ext, n: index, date: d }[k]));
  out = sanitizeFilename(out);
  return hasExt ? out : `${out}.${ext}`;
}
export function uniqueNames(names) {
  const seen = new Map(), used = new Set(names.map(n => n.toLowerCase()));
  return names.map(n => {
    const k = n.toLowerCase(); const c = seen.get(k) || 0; seen.set(k, c + 1);
    if (!c) return n;
    const dot = n.lastIndexOf('.'), base = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
    let i = c, cand; do { cand = `${base}-${i++}${ext}`; } while (used.has(cand.toLowerCase())); used.add(cand.toLowerCase()); return cand;
  });
}

// ---------------------------------------------------------------- formatting
export const formatSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
export function savings(orig, out) {
  if (!orig) return { pct: 0, text: '' };
  const pct = (1 - out / orig) * 100;
  return { pct, text: pct >= 0.05 ? `${pct.toFixed(1)}% smaller` : pct <= -0.05 ? `${(-pct).toFixed(1)}% larger` : 'same size' };
}

// ---------------------------------------------------------------- sniffing / animation
const ascii = (b, o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
export function sniffType(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && ascii(b, 1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 'GIF8')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis'))) return 'image/avif';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 1024))).replace(/^﻿/, '').trimStart();
  if (/^<svg[\s>/]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>/]/i.test(head))) return 'image/svg+xml';
  return null;
}
/** true when the file is an animated GIF / WebP / APNG (the converter keeps only the first frame). */
export function isAnimated(b) {
  const t = sniffType(b);
  if (t === 'image/gif') {
    let p = 6; if (b.length < 13) return false;
    const flags = b[10]; p = 13; if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
    let frames = 0;
    while (p < b.length) {
      const c = b[p++];
      if (c === 0x21) { p++; while (p < b.length && b[p]) p += b[p] + 1; p++; }
      else if (c === 0x2c) {
        if (++frames > 1) return true;
        const f = b[p + 8]; p += 9; if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
        p++; while (p < b.length && b[p]) p += b[p] + 1; p++;
      } else break;
    }
    return false;
  }
  if (t === 'image/webp') {
    let p = 12;
    while (p + 8 <= b.length) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); const len = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
      if (id === 'VP8X') return !!(b[p + 8] & 0x02);
      if (id === 'ANIM' || id === 'ANMF') return true;
      if (id === 'VP8 ' || id === 'VP8L') return false;
      p += 8 + len + (len & 1);
    }
    return false;
  }
  if (t === 'image/png') {
    let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; const id = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (id === 'acTL') return true; if (id === 'IDAT') return false;
      p += 12 + len;
    }
  }
  return false;
}

// ---------------------------------------------------------------- CRC-32 and ZIP (STORE)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(data, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
/**
 * STORE-only ZIP. entries: [{ name, data: Uint8Array, date?: Date }]. Returns an array of Uint8Array parts
 * (concatenate or pass to new Blob). Names are UTF-8 (general-purpose flag bit 11). No ZIP64: throws beyond 4 GB / 65535 files.
 */
export function zipParts(entries) {
  if (entries.length > 65535) throw new Error('Too many files for a ZIP (max 65,535).');
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), { time, date } = dosDateTime(e.date || new Date()), crc = crc32(e.data), size = e.data.length;
    if (size > 0xfffffffe || offset > 0xfffffffe) throw new Error('ZIP too large (ZIP64 is not supported).');
    const lh = new DataView(new ArrayBuffer(30 + name.length)); const lb = new Uint8Array(lh.buffer);
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true); lb.set(name, 30);
    const ch = new DataView(new ArrayBuffer(46 + name.length)); const cb = new Uint8Array(ch.buffer);
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true); cb.set(name, 46);
    central.push(cb); parts.push(lb, e.data); offset += lb.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  if (offset + cdSize > 0xfffffffe) throw new Error('ZIP too large (ZIP64 is not supported).');
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true); eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  return [...parts, ...central, new Uint8Array(eocd.buffer)];
}
export function buildZip(entries) {
  const parts = zipParts(entries), out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
