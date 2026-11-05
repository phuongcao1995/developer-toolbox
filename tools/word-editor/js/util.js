/**
 * Folio — shared utilities.
 *
 * Unit conversions, colour normalisation, font stacks and small helpers used
 * by both the importer and the exporter. Everything hangs off the global
 * `Folio` namespace so modules can be loaded with plain <script> tags.
 */
(function (Folio) {
  'use strict';

  const util = {};

  /* ---------------------------------------------------------------------- */
  /* Units                                                                   */
  /* ---------------------------------------------------------------------- */
  // Word measures most things in twips (1/20 pt); drawings use EMUs.
  util.TWIPS_PER_PT = 20;
  util.TWIPS_PER_INCH = 1440;
  util.PX_PER_INCH = 96;
  util.EMU_PER_PX = 9525;

  util.twipsToPt = (tw) => tw / 20;
  util.ptToTwips = (pt) => Math.round(pt * 20);
  util.twipsToPx = (tw) => (tw / 1440) * 96;
  util.pxToTwips = (px) => Math.round((px / 96) * 1440);
  util.pxToPt = (px) => px * 0.75;
  util.ptToPx = (pt) => pt / 0.75;

  /** Round to the nearest half point (Word stores sizes in half points). */
  util.roundHalf = (n) => Math.round(n * 2) / 2;

  /**
   * Convert a CSS length to points.
   * @param {string} value  e.g. "12pt", "16px", "1.2em", "150%"
   * @param {number} basePt size used to resolve em / % values
   * @returns {number|null}
   */
  util.cssLengthToPt = function (value, basePt) {
    if (value == null) return null;
    const m = String(value).trim().match(/^(-?[\d.]+)\s*(pt|px|em|rem|%|in|cm|mm|pc)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    switch ((m[2] || 'px').toLowerCase()) {
      case 'pt': return n;
      case 'px': return n * 0.75;
      case 'em': return n * (basePt || 11);
      case 'rem': return n * 12;
      case '%': return (n / 100) * (basePt || 11);
      case 'in': return n * 72;
      case 'cm': return (n / 2.54) * 72;
      case 'mm': return (n / 25.4) * 72;
      case 'pc': return n * 12;
      default: return null;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Colours                                                                 */
  /* ---------------------------------------------------------------------- */
  let colorCtx = null;

  /**
   * Normalise any CSS colour ("red", "rgb(1,2,3)", "#abc") to "RRGGBB".
   * Returns null for transparent / invalid colours.
   */
  util.colorToHex = function (css) {
    if (!css) return null;
    const s = String(css).trim().toLowerCase();
    if (s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'currentcolor' || s === 'auto') return null;
    if (/^#?[0-9a-f]{6}$/.test(s)) return s.replace('#', '').toUpperCase();
    if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
    const sentinel = '#010203';
    colorCtx.fillStyle = sentinel;
    colorCtx.fillStyle = s;
    const out = colorCtx.fillStyle;
    if (out === sentinel && s !== sentinel) return null; // invalid colour string
    if (out.startsWith('#')) return out.slice(1).toUpperCase();
    const m = out.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase();
  };

  /**
   * Word's highlight palette. Highlights matching one of these are written as
   * <w:highlight>; any other background colour is written as run shading.
   */
  util.HIGHLIGHTS = {
    yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF',
    blue: '0000FF', red: 'FF0000', darkBlue: '000080', darkCyan: '008080',
    darkGreen: '008000', darkMagenta: '800080', darkRed: '800000',
    darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000',
    white: 'FFFFFF'
  };
  util.highlightNameForHex = function (hex) {
    for (const [name, h] of Object.entries(util.HIGHLIGHTS)) if (h === hex) return name;
    return null;
  };

  /* ---------------------------------------------------------------------- */
  /* Fonts                                                                   */
  /* ---------------------------------------------------------------------- */
  // Fallbacks so documents still look reasonable when Office fonts are absent.
  const FONT_FALLBACKS = {
    'calibri': 'Calibri, Carlito, "Segoe UI", Arial, sans-serif',
    'calibri light': '"Calibri Light", Calibri, Carlito, Arial, sans-serif',
    'cambria': 'Cambria, Caladea, Georgia, serif',
    'arial': 'Arial, "Liberation Sans", Helvetica, sans-serif',
    'helvetica': 'Helvetica, Arial, sans-serif',
    'times new roman': '"Times New Roman", "Liberation Serif", Times, serif',
    'georgia': 'Georgia, "Times New Roman", serif',
    'garamond': 'Garamond, "EB Garamond", Georgia, serif',
    'verdana': 'Verdana, "DejaVu Sans", sans-serif',
    'tahoma': 'Tahoma, Verdana, sans-serif',
    'trebuchet ms': '"Trebuchet MS", Tahoma, sans-serif',
    'courier new': '"Courier New", "Liberation Mono", Courier, monospace',
    'consolas': 'Consolas, "Courier New", monospace',
    'segoe ui': '"Segoe UI", Arial, sans-serif'
  };

  /** Build a CSS font-family value with sensible fallbacks for a Word font. */
  util.fontStack = function (name) {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    if (FONT_FALLBACKS[key]) return FONT_FALLBACKS[key];
    const quoted = /[\s\d]/.test(name) ? `"${name.replace(/"/g, '')}"` : name;
    return `${quoted}, sans-serif`;
  };

  /** First family of a CSS font-family list, without quotes. */
  util.firstFontFamily = function (css) {
    if (!css) return null;
    const first = String(css).split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (!first || /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial)$/i.test(first)) return null;
    return first;
  };

  /* ---------------------------------------------------------------------- */
  /* Strings / XML                                                           */
  /* ---------------------------------------------------------------------- */
  // Characters that are illegal in XML 1.0 (they would corrupt the .docx).
  const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

  util.escapeXml = function (s) {
    return String(s)
      .replace(INVALID_XML, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  util.escapeHtml = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  /** Make a string safe to use as a file name. */
  util.safeFileName = function (name, ext) {
    let base = String(name || '').replace(/\.(docx?|dotx)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').trim();
    if (!base) base = 'Untitled document';
    return base.slice(0, 120) + ext;
  };

  util.formatBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };

  util.debounce = function (fn, ms) {
    let t = null;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
    wrapped.flush = function () {
      if (t !== null) { clearTimeout(t); t = null; fn(); }
    };
    wrapped.cancel = function () { clearTimeout(t); t = null; };
    wrapped.pending = () => t !== null;
    return wrapped;
  };

  /** Escape a string for use inside a RegExp. */
  util.escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ---------------------------------------------------------------------- */
  /* Binary helpers                                                          */
  /* ---------------------------------------------------------------------- */
  /** Identify a file by its first bytes instead of trusting the extension. */
  util.sniffFormat = function (bytes) {
    if (!bytes || bytes.length < 4) return 'empty';
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) return 'zip';
    if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) return 'ole';
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 64)).trimStart().toLowerCase();
    if (head.startsWith('{\\rtf')) return 'rtf';
    if (head.startsWith('<?xml') || head.startsWith('<html') || head.startsWith('<!doctype') || head.startsWith('mime-version')) return 'markup';
    return 'unknown';
  };

  /** Image MIME type from the first bytes (null if not a supported image). */
  util.sniffImage = function (bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    return null;
  };

  /** Blob URLs created for images; revoked when a new document replaces them. */
  const objectUrls = new Set();
  util.trackObjectUrl = (url) => { objectUrls.add(url); return url; };
  util.revokeObjectUrls = function () {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls.clear();
  };

  /** Take ownership of the current URL set (so a failed import can restore it). */
  util.detachObjectUrls = function () {
    const out = Array.from(objectUrls);
    objectUrls.clear();
    return out;
  };
  util.attachObjectUrls = function (urls) { urls.forEach((u) => objectUrls.add(u)); };

  /** Convert a data: URL into a Blob. */
  util.dataUrlToBlob = function (dataUrl) {
    const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    if (m[2]) {
      const bin = atob(m[3]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }
    return new Blob([decodeURIComponent(m[3])], { type: mime });
  };

  Folio.util = util;
})(window.Folio = window.Folio || {});
