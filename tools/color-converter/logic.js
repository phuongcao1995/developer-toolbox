// Color Converter - pure maths and parsing (no DOM).
// Colour model: { r, g, b, a } with r/g/b = gamma-encoded sRGB in 0..1 (may be slightly outside for out-of-gamut input) and a = alpha 0..1.

const clamp01 = x => Math.min(1, Math.max(0, x));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mod = (x, n) => ((x % n) + n) % n;

// ---------------------------------------------------------------- matrix helpers
const mul3 = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
const mulM = (a, b) => a.map((row, i) => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const xyFromWhite = ([x, y]) => [x / y, 1, (1 - x - y) / y];

/** RGB -> XYZ matrix from primaries (xy) and white point (xy). */
export function rgbToXyzMatrix(primaries, white) {
  const cols = primaries.map(([x, y]) => [x / y, 1, (1 - x - y) / y]);
  const P = [[cols[0][0], cols[1][0], cols[2][0]], [cols[0][1], cols[1][1], cols[2][1]], [cols[0][2], cols[1][2], cols[2][2]]];
  const S = mul3(inv3(P), xyFromWhite(white));
  return P.map(row => row.map((v, j) => v * S[j]));
}
const D65_XY = [0.3127, 0.3290], D50_XY = [0.3457, 0.3585];
export const WHITE_D65 = xyFromWhite(D65_XY), WHITE_D50 = xyFromWhite(D50_XY);
const M_SRGB = rgbToXyzMatrix([[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], D65_XY);
const M_P3 = rgbToXyzMatrix([[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], D65_XY);
const M_SRGB_INV = inv3(M_SRGB), M_P3_INV = inv3(M_P3);

/** Bradford chromatic adaptation matrix between two XYZ white points. */
export function bradford(srcWhite, dstWhite) {
  const MA = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
  const s = mul3(MA, srcWhite), d = mul3(MA, dstWhite);
  const D = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return mulM(mulM(inv3(MA), D), MA);
}
const D65_TO_D50 = bradford(WHITE_D65, WHITE_D50), D50_TO_D65 = bradford(WHITE_D50, WHITE_D65);

// ---------------------------------------------------------------- transfer functions
export const srgbToLinear = c => { const s = Math.sign(c), a = Math.abs(c); return s * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4); };
export const linearToSrgb = c => { const s = Math.sign(c), a = Math.abs(c); return s * (a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055); };

const toLin = c => [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
const fromLin = (lin, a = 1) => ({ r: linearToSrgb(lin[0]), g: linearToSrgb(lin[1]), b: linearToSrgb(lin[2]), a });

// ---------------------------------------------------------------- spaces
export const srgbToXyz = c => mul3(M_SRGB, toLin(c));                  // D65
export const xyzToSrgb = (xyz, a = 1) => fromLin(mul3(M_SRGB_INV, xyz), a);
export const srgbToXyzD50 = c => mul3(D65_TO_D50, srgbToXyz(c));
export const xyzD50ToSrgb = (xyz, a = 1) => xyzToSrgb(mul3(D50_TO_D65, xyz), a);

const EPS = 216 / 24389, KAPPA = 24389 / 27;
export function srgbToLab(c) {
  const xyz = srgbToXyzD50(c).map((v, i) => v / WHITE_D50[i]);
  const f = xyz.map(t => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116));
  return { l: 116 * f[1] - 16, a: 500 * (f[0] - f[1]), b: 200 * (f[1] - f[2]) };
}
export function labToSrgb({ l, a, b }, alpha = 1) {
  const fy = (l + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const xr = fx ** 3 > EPS ? fx ** 3 : (116 * fx - 16) / KAPPA;
  const yr = l > KAPPA * EPS ? ((l + 16) / 116) ** 3 : l / KAPPA;
  const zr = fz ** 3 > EPS ? fz ** 3 : (116 * fz - 16) / KAPPA;
  return xyzD50ToSrgb([xr * WHITE_D50[0], yr * WHITE_D50[1], zr * WHITE_D50[2]], alpha);
}
const toPolar = (x, y) => { const c = Math.hypot(x, y); return { c, h: c < 1e-9 ? 0 : mod(Math.atan2(y, x) * 180 / Math.PI, 360) }; };
const fromPolar = (c, h) => [c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)];
export const srgbToLch = c => { const { l, a, b } = srgbToLab(c); const p = toPolar(a, b); return { l, c: p.c, h: p.c < 0.0015 ? 0 : p.h }; };
export const lchToSrgb = ({ l, c, h }, alpha = 1) => { const [a, b] = fromPolar(c, h); return labToSrgb({ l, a, b }, alpha); };

export function srgbToOklab(c) {
  const [r, g, b] = toLin(c);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return { l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s };
}
export function oklabToSrgb({ l, a, b }, alpha = 1) {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return fromLin([4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_], alpha);
}
export const srgbToOklch = c => { const { l, a, b } = srgbToOklab(c); const p = toPolar(a, b); return { l, c: p.c, h: p.c < 0.0004 ? 0 : p.h }; };
export const oklchToSrgb = ({ l, c, h }, alpha = 1) => { const [a, b] = fromPolar(c, h); return oklabToSrgb({ l, a, b }, alpha); };

export const srgbToDisplayP3 = c => mul3(M_P3_INV, srgbToXyz(c)).map(linearToSrgb);
export const displayP3ToSrgb = (p3, a = 1) => xyzToSrgb(mul3(M_P3, p3.map(srgbToLinear)), a);

export function srgbToHsl(c) {
  const { r, g, b } = clampRgb(c), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0, s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? mod((g - b) / d, 6) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: mod(h, 360), s: clamp01(s), l };
}
export function hslToSrgb({ h, s, l }, a = 1) {
  const hh = mod(h, 360);
  const f = n => { const k = mod(n + hh / 30, 12); return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return { r: f(0), g: f(8), b: f(4), a };
}
export function srgbToHwb(c) { const { h } = srgbToHsl(c); const { r, g, b } = clampRgb(c); return { h, w: Math.min(r, g, b), b: 1 - Math.max(r, g, b) }; }
export function hwbToSrgb({ h, w, b }, a = 1) {
  if (w + b >= 1) { const g = w / (w + b); return { r: g, g, b: g, a }; }
  const c = hslToSrgb({ h, s: 1, l: 0.5 }, a);
  const k = 1 - w - b;
  return { r: c.r * k + w, g: c.g * k + w, b: c.b * k + w, a };
}
export function srgbToHsv(c) {
  const { r, g, b } = clampRgb(c), max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { h: srgbToHsl(c).h, s: max === 0 ? 0 : (max - min) / max, v: max };
}
export function hsvToSrgb({ h, s, v }, a = 1) {
  const l = v * (1 - s / 2), sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return hslToSrgb({ h, s: sl, l }, a);
}
/** Naive (non-ICC) CMYK. */
export function srgbToCmyk(c) {
  const { r, g, b } = clampRgb(c), k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
}
export const cmykToSrgb = ({ c, m, y, k }, a = 1) => ({ r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k), a });

export function clampRgb(c) { return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a ?? 1) }; }
export const inGamut = c => [c.r, c.g, c.b].every(v => v >= -0.0005 && v <= 1.0005);
export const to255 = c => { const k = clampRgb(c); return { r: Math.round(k.r * 255), g: Math.round(k.g * 255), b: Math.round(k.b * 255), a: k.a }; };
export const from255 = (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a });

// ---------------------------------------------------------------- named colours (148 incl. gray/grey variants)
const NAMES_SRC = 'aliceblue f0f8ff,antiquewhite faebd7,aqua 00ffff,aquamarine 7fffd4,azure f0ffff,beige f5f5dc,bisque ffe4c4,black 000000,blanchedalmond ffebcd,blue 0000ff,blueviolet 8a2be2,brown a52a2a,burlywood deb887,cadetblue 5f9ea0,chartreuse 7fff00,chocolate d2691e,coral ff7f50,cornflowerblue 6495ed,cornsilk fff8dc,crimson dc143c,cyan 00ffff,darkblue 00008b,darkcyan 008b8b,darkgoldenrod b8860b,darkgray a9a9a9,darkgreen 006400,darkgrey a9a9a9,darkkhaki bdb76b,darkmagenta 8b008b,darkolivegreen 556b2f,darkorange ff8c00,darkorchid 9932cc,darkred 8b0000,darksalmon e9967a,darkseagreen 8fbc8f,darkslateblue 483d8b,darkslategray 2f4f4f,darkslategrey 2f4f4f,darkturquoise 00ced1,darkviolet 9400d3,deeppink ff1493,deepskyblue 00bfff,dimgray 696969,dimgrey 696969,dodgerblue 1e90ff,firebrick b22222,floralwhite fffaf0,forestgreen 228b22,fuchsia ff00ff,gainsboro dcdcdc,ghostwhite f8f8ff,gold ffd700,goldenrod daa520,gray 808080,green 008000,greenyellow adff2f,grey 808080,honeydew f0fff0,hotpink ff69b4,indianred cd5c5c,indigo 4b0082,ivory fffff0,khaki f0e68c,lavender e6e6fa,lavenderblush fff0f5,lawngreen 7cfc00,lemonchiffon fffacd,lightblue add8e6,lightcoral f08080,lightcyan e0ffff,lightgoldenrodyellow fafad2,lightgray d3d3d3,lightgreen 90ee90,lightgrey d3d3d3,lightpink ffb6c1,lightsalmon ffa07a,lightseagreen 20b2aa,lightskyblue 87cefa,lightslategray 778899,lightslategrey 778899,lightsteelblue b0c4de,lightyellow ffffe0,lime 00ff00,limegreen 32cd32,linen faf0e6,magenta ff00ff,maroon 800000,mediumaquamarine 66cdaa,mediumblue 0000cd,mediumorchid ba55d3,mediumpurple 9370db,mediumseagreen 3cb371,mediumslateblue 7b68ee,mediumspringgreen 00fa9a,mediumturquoise 48d1cc,mediumvioletred c71585,midnightblue 191970,mintcream f5fffa,mistyrose ffe4e1,moccasin ffe4b5,navajowhite ffdead,navy 000080,oldlace fdf5e6,olive 808000,olivedrab 6b8e23,orange ffa500,orangered ff4500,orchid da70d6,palegoldenrod eee8aa,palegreen 98fb98,paleturquoise afeeee,palevioletred db7093,papayawhip ffefd5,peachpuff ffdab9,peru cd853f,pink ffc0cb,plum dda0dd,powderblue b0e0e6,purple 800080,rebeccapurple 663399,red ff0000,rosybrown bc8f8f,royalblue 4169e1,saddlebrown 8b4513,salmon fa8072,sandybrown f4a460,seagreen 2e8b57,seashell fff5ee,sienna a0522d,silver c0c0c0,skyblue 87ceeb,slateblue 6a5acd,slategray 708090,slategrey 708090,snow fffafa,springgreen 00ff7f,steelblue 4682b4,tan d2b48c,teal 008080,thistle d8bfd8,tomato ff6347,turquoise 40e0d0,violet ee82ee,wheat f5deb3,white ffffff,whitesmoke f5f5f5,yellow ffff00,yellowgreen 9acd32';
export const NAMED_COLORS = Object.fromEntries(NAMES_SRC.split(',').map(p => p.split(' ')));

// ---------------------------------------------------------------- parsing
const NUM = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/i;
function tok(t) {
  const s = String(t).trim().toLowerCase();
  if (s === 'none') return { v: 0, unit: '' };
  const m = NUM.exec(s);
  if (!m) return null;
  return { v: parseFloat(m[1]), unit: (m[2] || '').toLowerCase() };
}
const HUE_UNITS = { '': 1, deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const hueOf = t => (t && t.unit !== '%' ? mod(t.v * HUE_UNITS[t.unit], 360) : null);
const alphaOf = t => (t ? clamp01(t.unit === '%' ? t.v / 100 : t.unit === '' ? t.v : NaN) : 1);
/** number or percentage -> value where 100% = `full`. */
const scaled = (t, full) => (t && ['', '%'].includes(t.unit) ? (t.unit === '%' ? t.v / 100 * full : t.v) : null);

const err = error => ({ ok: false, error });
const ok = (color, format, extra = {}) => ({ ok: true, color: { r: color.r, g: color.g, b: color.b, a: clamp01(color.a ?? 1) }, format, ...extra });

function parseHex(s) {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  const n = i => parseInt(h.slice(i, i + 2), 16);
  return from255(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1);
}

/** Parse any supported colour string. Returns { ok, color, format, inGamut, warnings } or { ok:false, error }. */
export function parseColor(input) {
  const raw = String(input ?? '').trim().replace(/;$/, '').trim();
  if (!raw) return err('Enter a colour.');
  if (raw.length > 200) return err('That is too long to be a colour.');
  const lower = raw.toLowerCase();
  if (lower === 'transparent') return ok({ r: 0, g: 0, b: 0, a: 0 }, 'name');
  if (lower === 'currentcolor') return err('"currentColor" depends on the page and cannot be converted.');
  if (NAMED_COLORS[lower]) return ok(parseHex(NAMED_COLORS[lower]), 'name');
  const hex = parseHex(raw);
  if (hex) return ok(hex, 'hex');
  if (/^#/.test(raw)) return err('Invalid hex colour: use 3, 4, 6 or 8 hex digits (0-9, a-f), for example #3a58e8.');

  const fm = /^([a-z][a-z0-9-]*)\(\s*([\s\S]*)\)$/i.exec(raw);
  if (!fm) return err(`Unrecognised colour "${raw.slice(0, 40)}". Try #rrggbb, rgb(), hsl(), hwb(), lab(), lch(), oklab(), oklch(), color(), cmyk() or a CSS colour name.`);
  const fn = fm[1].toLowerCase();
  let body = fm[2], alphaTok = null;
  const slash = body.indexOf('/');
  if (slash >= 0) { alphaTok = body.slice(slash + 1).trim(); body = body.slice(0, slash); }
  const commas = body.includes(',');
  let args = body.trim().split(commas ? /\s*,\s*/ : /\s+/).filter(s => s !== '');
  const warnings = [];
  const FUNCS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'cmyk', 'device-cmyk'];
  if (!FUNCS.includes(fn)) return err(`Unsupported colour function "${fn}()".`);

  if (fn === 'color') {
    if (!args.length) return err('color() needs a colour space and three values.');
    const space = args.shift().toLowerCase();
    if (!['srgb', 'srgb-linear', 'display-p3'].includes(space)) return err(`color(${space}) is not supported. Supported spaces: srgb, srgb-linear, display-p3.`);
    if (args.length === 4 && !alphaTok && commas) alphaTok = args.pop();
    if (args.length !== 3) return err(`color(${space} ...) needs 3 values (got ${args.length}).`);
  } else {
    const want = { rgb: 3, rgba: 3, hsl: 3, hsla: 3, hwb: 3, lab: 3, lch: 3, oklab: 3, oklch: 3, cmyk: 4, 'device-cmyk': 4 }[fn];
    if (!alphaTok && args.length === want + 1) alphaTok = args.pop();
    if (args.length !== want) return err(`${fn}() needs ${want} values (got ${args.length}).`);
  }
  const t = args.map(tok);
  if (t.some(x => !x)) return err(`Could not read a number in "${raw.slice(0, 60)}". Values must be numbers or percentages.`);
  let a = 1;
  if (alphaTok != null) {
    const at = tok(alphaTok);
    a = at ? alphaOf(at) : NaN;
    if (!Number.isFinite(a)) return err(`Invalid alpha value "${alphaTok}".`);
  }
  const done = (c, format) => ok({ ...c, a }, format, { inGamut: inGamut(c), warnings });
  const need = (v, what) => (v == null ? err(`Invalid ${what} in ${fn}().`) : null);

  switch (fn) {
    case 'rgb': case 'rgba': {
      const v = t.map(x => (x.unit === '%' ? x.v / 100 : x.unit === '' ? x.v / 255 : null));
      if (v.includes(null)) return err('rgb() values must be numbers or percentages.');
      if (v.some(x => x < 0 || x > 1)) warnings.push('rgb() values outside 0-255 were clamped.');
      return done({ r: clamp01(v[0]), g: clamp01(v[1]), b: clamp01(v[2]) }, 'rgb');
    }
    case 'hsl': case 'hsla': {
      const h = hueOf(t[0]), s = scaled(t[1], 100), l = scaled(t[2], 100);
      const e = need(h, 'hue') || need(s, 'saturation') || need(l, 'lightness'); if (e) return e;
      return done(clampRgb(hslToSrgb({ h, s: clamp(s, 0, 100) / 100, l: clamp(l, 0, 100) / 100 })), 'hsl');
    }
    case 'hwb': {
      const h = hueOf(t[0]), w = scaled(t[1], 100), b = scaled(t[2], 100);
      const e = need(h, 'hue') || need(w, 'whiteness') || need(b, 'blackness'); if (e) return e;
      return done(clampRgb(hwbToSrgb({ h, w: clamp(w, 0, 100) / 100, b: clamp(b, 0, 100) / 100 })), 'hwb');
    }
    case 'lab': {
      const L = scaled(t[0], 100), A = scaled(t[1], 125), B = scaled(t[2], 125);
      const e = need(L, 'lightness') || need(A, 'a axis') || need(B, 'b axis'); if (e) return e;
      return done(labToSrgb({ l: clamp(L, 0, 100), a: A, b: B }), 'lab');
    }
    case 'lch': {
      const L = scaled(t[0], 100), C = scaled(t[1], 150), H = hueOf(t[2]);
      const e = need(L, 'lightness') || need(C, 'chroma') || need(H, 'hue'); if (e) return e;
      return done(lchToSrgb({ l: clamp(L, 0, 100), c: Math.max(0, C), h: H }), 'lch');
    }
    case 'oklab': {
      const L = scaled(t[0], 1), A = scaled(t[1], 0.4), B = scaled(t[2], 0.4);
      const e = need(L, 'lightness') || need(A, 'a axis') || need(B, 'b axis'); if (e) return e;
      return done(oklabToSrgb({ l: clamp(L, 0, 1), a: A, b: B }), 'oklab');
    }
    case 'oklch': {
      const L = scaled(t[0], 1), C = scaled(t[1], 0.4), H = hueOf(t[2]);
      const e = need(L, 'lightness') || need(C, 'chroma') || need(H, 'hue'); if (e) return e;
      return done(oklchToSrgb({ l: clamp(L, 0, 1), c: Math.max(0, C), h: H }), 'oklch');
    }
    case 'color': {
      const v = t.map(x => scaled(x, 1));
      if (v.includes(null)) return err('color() values must be numbers or percentages.');
      const space = fm[2].trim().split(/[\s,]+/)[0].toLowerCase();
      if (space === 'srgb') return done({ r: v[0], g: v[1], b: v[2] }, 'color(srgb)');
      if (space === 'srgb-linear') return done(fromLin(v), 'color(srgb-linear)');
      return done(displayP3ToSrgb(v), 'color(display-p3)');
    }
    default: { // cmyk
      const allPlain = t.every(x => x.unit === '');
      const v = t.map(x => (x.unit === '%' ? x.v / 100 : allPlain && t.every(y => y.v <= 1) ? x.v : allPlain ? x.v / 100 : null));
      if (v.includes(null)) return err('cmyk() values must be percentages or numbers.');
      return done(clampRgb(cmykToSrgb({ c: clamp01(v[0]), m: clamp01(v[1]), y: clamp01(v[2]), k: clamp01(v[3]) })), 'cmyk');
    }
  }
}

// ---------------------------------------------------------------- formatting
export const roundTo = (x, d) => { const f = 10 ** d, r = Math.round((x + Math.sign(x) * Number.EPSILON) * f) / f; return r === 0 ? 0 : r; };
const COMPACT = { rgb: 0, hsl: 0, hwb: 0, hsv: 0, cmyk: 0, labL: 2, lab: 2, oklabL: 3, oklab: 4, oklchC: 4, oklchH: 2, color: 4, alpha: 3 };
/** Decimal places for a component given the rounding option ('compact' | 0..6 | 'full'). */
export function precision(opts, key) {
  const r = opts?.rounding ?? 'compact';
  if (r === 'compact') return COMPACT[key] ?? 2;
  if (r === 'full') return 6;
  return clamp(Math.round(Number(r)) || 0, 0, 6);
}
const n = (x, d) => String(roundTo(x, d));

function alphaPart(c, opts, sep) { return c.a < 1 - 1e-9 ? `${sep}${n(c.a, precision(opts, 'alpha'))}` : ''; }

export function formatHex(c, { hexCase = 'lower', hexShort = false, alpha = true } = {}) {
  const k = to255(c);
  const parts = [k.r, k.g, k.b];
  if (alpha && k.a < 1) parts.push(Math.round(k.a * 255));
  let s = parts.map(v => v.toString(16).padStart(2, '0')).join('');
  if (hexShort && (s.length === 6 || s.length === 8) && [...s].every((ch, i) => i % 2 === 1 || ch === s[i + 1])) s = [...s].filter((_, i) => i % 2 === 0).join('');
  return '#' + (hexCase === 'upper' ? s.toUpperCase() : s.toLowerCase());
}

const FORMATS = {
  hex: { label: 'HEX', fn: (c, o) => formatHex(c, { ...o, alpha: true }) },
  hex8: { label: 'HEX8 (#RRGGBBAA)', fn: (c, o) => { const k = to255(c); const s = [k.r, k.g, k.b, Math.round(k.a * 255)].map(v => v.toString(16).padStart(2, '0')).join(''); return '#' + (o.hexCase === 'upper' ? s.toUpperCase() : s); } },
  rgb: { label: 'RGB', fn: (c, o) => {
    const p = precision(o, 'rgb'), k = clampRgb(c), v = [k.r, k.g, k.b].map(x => n(x * 255, p));
    return o.syntax === 'legacy' ? (c.a < 1 - 1e-9 ? `rgba(${v.join(', ')}, ${n(c.a, precision(o, 'alpha'))})` : `rgb(${v.join(', ')})`) : `rgb(${v.join(' ')}${alphaPart(c, o, ' / ')})`;
  } },
  hsl: { label: 'HSL', fn: (c, o) => {
    const p = precision(o, 'hsl'), h = srgbToHsl(c), v = [n(h.h, p), `${n(h.s * 100, p)}%`, `${n(h.l * 100, p)}%`];
    return o.syntax === 'legacy' ? (c.a < 1 - 1e-9 ? `hsla(${v.join(', ')}, ${n(c.a, precision(o, 'alpha'))})` : `hsl(${v.join(', ')})`) : `hsl(${v.join(' ')}${alphaPart(c, o, ' / ')})`;
  } },
  hwb: { label: 'HWB', fn: (c, o) => { const p = precision(o, 'hwb'), h = srgbToHwb(c); return `hwb(${n(h.h, p)} ${n(h.w * 100, p)}% ${n(h.b * 100, p)}%${alphaPart(c, o, ' / ')})`; } },
  hsv: { label: 'HSV / HSB (not CSS)', fn: (c, o) => { const p = precision(o, 'hsv'), h = srgbToHsv(c); return `hsv(${n(h.h, p)} ${n(h.s * 100, p)}% ${n(h.v * 100, p)}%${alphaPart(c, o, ' / ')})`; } },
  cmyk: { label: 'CMYK (naive, not ICC)', fn: (c, o) => { const p = precision(o, 'cmyk'), k = srgbToCmyk(c); return `cmyk(${[k.c, k.m, k.y, k.k].map(x => n(x * 100, p) + '%').join(' ')}${alphaPart(c, o, ' / ')})`; } },
  lab: { label: 'Lab (D50)', fn: (c, o) => { const v = srgbToLab(c); return `lab(${n(v.l, precision(o, 'labL'))} ${n(v.a, precision(o, 'lab'))} ${n(v.b, precision(o, 'lab'))}${alphaPart(c, o, ' / ')})`; } },
  lch: { label: 'LCH (D50)', fn: (c, o) => { const v = srgbToLch(c); return `lch(${n(v.l, precision(o, 'labL'))} ${n(v.c, precision(o, 'lab'))} ${n(v.h, precision(o, 'lab'))}${alphaPart(c, o, ' / ')})`; } },
  oklab: { label: 'OKLab', fn: (c, o) => { const v = srgbToOklab(c); return `oklab(${n(v.l, precision(o, 'oklabL'))} ${n(v.a, precision(o, 'oklab'))} ${n(v.b, precision(o, 'oklab'))}${alphaPart(c, o, ' / ')})`; } },
  oklch: { label: 'OKLCH', fn: (c, o) => { const v = srgbToOklch(c); return `oklch(${n(v.l, precision(o, 'oklabL'))} ${n(v.c, precision(o, 'oklchC'))} ${n(v.h, precision(o, 'oklchH'))}${alphaPart(c, o, ' / ')})`; } },
  srgb: { label: 'color(srgb)', fn: (c, o) => { const p = precision(o, 'color'); return `color(srgb ${n(c.r, p)} ${n(c.g, p)} ${n(c.b, p)}${alphaPart(c, o, ' / ')})`; } },
  p3: { label: 'color(display-p3)', fn: (c, o) => { const p = precision(o, 'color'), v = srgbToDisplayP3(c); return `color(display-p3 ${n(v[0], p)} ${n(v[1], p)} ${n(v[2], p)}${alphaPart(c, o, ' / ')})`; } },
  android: { label: 'Android / Flutter ARGB', fn: (c, o) => { const k = to255(c); const s = [Math.round(k.a * 255), k.r, k.g, k.b].map(v => v.toString(16).padStart(2, '0')).join(''); return '#' + (o.hexCase === 'upper' ? s.toUpperCase() : s) + `  (0x${s.toUpperCase()})`; } },
};
export const FORMAT_IDS = Object.keys(FORMATS);

export function formatColor(c, id, opts = {}) {
  const f = FORMATS[id];
  if (!f) throw new Error(`Unknown format ${id}`);
  return f.fn(c, opts);
}
/** All output formats: [{ id, label, value }]. */
export function formatAll(c, opts = {}) { return FORMAT_IDS.map(id => ({ id, label: FORMATS[id].label, value: FORMATS[id].fn(c, opts) })); }

// ---------------------------------------------------------------- names
export function deltaE(c1, c2) { const a = srgbToOklab(c1), b = srgbToOklab(c2); return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b) * 100; }
/** Nearest CSS named colour by OKLab distance: { name, hex, exact, distance }. */
export function nearestName(c) {
  const k = clampRgb(c);
  let best = null;
  for (const [name, hex] of Object.entries(NAMED_COLORS)) {
    const d = deltaE(k, parseHex(hex));
    if (!best || d < best.distance - 1e-12) best = { name, hex: '#' + hex, distance: d };
  }
  best.exact = best.distance < 0.001;
  return best;
}

// ---------------------------------------------------------------- contrast (WCAG 2.x) + APCA
export function relativeLuminance(c) { const [r, g, b] = toLin(clampRgb(c)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
/** Composite a (possibly translucent) colour over an opaque backdrop. */
export function composite(fg, bg) { const a = fg.a ?? 1; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; }
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
/** Contrast ratio of fg on bg (translucent bg is composited over white, then fg over bg). */
export function contrastRatio(fg, bg) {
  const b = composite(bg, WHITE), f = composite(fg, b);
  const l1 = relativeLuminance(f), l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** Display ratio truncated (never rounded up) to 2 decimals, so 4.499 never shows as a pass-looking 4.50. */
export const formatRatio = r => `${(Math.floor(r * 100 + 1e-9) / 100).toFixed(2)}:1`;
export const WCAG_LEVELS = [
  { id: 'aa-normal', label: 'AA, normal text', min: 4.5 },
  { id: 'aa-large', label: 'AA, large text (18pt, or 14pt bold)', min: 3 },
  { id: 'aaa-normal', label: 'AAA, normal text', min: 7 },
  { id: 'aaa-large', label: 'AAA, large text', min: 4.5 },
  { id: 'ui', label: 'AA, UI components and graphics', min: 3 },
];
export function wcagChecks(ratio) { return WCAG_LEVELS.map(l => ({ ...l, pass: ratio + 1e-9 >= l.min })); }

/** APCA-W3 0.0.98G-4g lightness contrast (Lc, signed). Informational only. */
export function apcaLc(fg, bg) {
  const b = composite(bg, WHITE), f = composite(fg, b);
  const Y = c => { const k = clampRgb(c); return 0.2126729 * k.r ** 2.4 + 0.7151522 * k.g ** 2.4 + 0.0721750 * k.b ** 2.4; };
  const soft = y => (y < 0.022 ? y + (0.022 - y) ** 1.414 : y);
  const yt = soft(Y(f)), yb = soft(Y(b));
  if (Math.abs(yb - yt) < 0.0005) return 0;
  let out;
  if (yb > yt) { const s = (yb ** 0.56 - yt ** 0.57) * 1.14; out = s < 0.1 ? 0 : s - 0.027; }
  else { const s = (yb ** 0.65 - yt ** 0.62) * 1.14; out = s > -0.1 ? 0 : s + 0.027; }
  return out * 100;
}

/**
 * Nearest foreground (by OKLab lightness change, hue and chroma kept) that reaches `target` against bg.
 * Returns { color, ratio } or null when even black/white cannot reach it.
 */
export function suggestForeground(fg, bg, target) {
  if (contrastRatio(fg, bg) >= target) return { color: { ...clampRgb(fg) }, ratio: contrastRatio(fg, bg), unchanged: true };
  const base = srgbToOklch(clampRgb(fg));
  let best = null;
  for (let step = 1; step <= 400; step++) {
    for (const dir of [-1, 1]) {
      const l = base.l + dir * step * 0.0025;
      if (l < 0 || l > 1) continue;
      const cand = clampRgb(oklchToSrgb({ l, c: base.c, h: base.h }, fg.a));
      const r = contrastRatio(cand, bg);
      if (r >= target && (!best || Math.abs(l - base.l) < best.d)) best = { color: cand, ratio: r, d: Math.abs(l - base.l) };
    }
    if (best) break;
  }
  if (best) return { color: best.color, ratio: best.ratio };
  for (const ext of [{ r: 0, g: 0, b: 0, a: 1 }, WHITE]) {
    const r = contrastRatio(ext, bg);
    if (r >= target) return { color: ext, ratio: r };
  }
  return null;
}

// ---------------------------------------------------------------- colour-blindness simulation (Machado et al. 2009, severity 1.0, linear RGB)
export const CVD = {
  protanopia: { label: 'Protanopia (no red cones)', m: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]] },
  deuteranopia: { label: 'Deuteranopia (no green cones)', m: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]] },
  tritanopia: { label: 'Tritanopia (no blue cones)', m: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]] },
  achromatopsia: { label: 'Achromatopsia (no colour)', m: [[0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722]] },
};
export function simulateCvd(c, type) {
  const def = CVD[type];
  if (!def) throw new Error(`Unknown simulation ${type}`);
  const out = mul3(def.m, toLin(clampRgb(c)));
  return clampRgb(fromLin(out.map(clamp01), c.a));
}

// ---------------------------------------------------------------- palettes
const rotate = (c, deg) => { const h = srgbToHsl(c); return hslToSrgb({ ...h, h: h.h + deg }, c.a); };
const mixSrgb = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });
export const mix = mixSrgb;

export const SCHEMES = {
  complementary: { label: 'Complementary', offsets: [0, 180] },
  analogous: { label: 'Analogous', offsets: [-30, 0, 30] },
  triadic: { label: 'Triadic', offsets: [0, 120, 240] },
  tetradic: { label: 'Tetradic (rectangle)', offsets: [0, 60, 180, 240] },
  split: { label: 'Split-complementary', offsets: [0, 150, 210] },
};
/** Harmony colours: [{ name, color }]. */
export function harmony(c, scheme) {
  const s = SCHEMES[scheme];
  if (!s) throw new Error(`Unknown scheme ${scheme}`);
  return s.offsets.map(o => ({ name: o === 0 ? 'base' : `${o > 0 ? '+' : ''}${o}deg`, color: clampRgb(rotate(c, o)) }));
}
/** Monochromatic: same hue and saturation, HSL lightness spread between 10% and 90%. */
export function monochromatic(c, count = 7) {
  count = clamp(Math.round(count), 2, 20);
  const h = srgbToHsl(c);
  return Array.from({ length: count }, (_, i) => ({ name: `mono-${i + 1}`, color: clampRgb(hslToSrgb({ ...h, l: 0.9 - (0.8 * i) / (count - 1) }, c.a)) }));
}
/** Tints (mix with white) from the base towards white; excludes pure white. */
export function tints(c, count = 5) {
  count = clamp(Math.round(count), 1, 20);
  return Array.from({ length: count }, (_, i) => ({ name: `tint-${i + 1}`, color: clampRgb(mixSrgb(c, WHITE, (i + 1) / (count + 1))) }));
}
export function shades(c, count = 5) {
  count = clamp(Math.round(count), 1, 20);
  const black = { r: 0, g: 0, b: 0, a: c.a };
  return Array.from({ length: count }, (_, i) => ({ name: `shade-${i + 1}`, color: clampRgb(mixSrgb(c, black, (i + 1) / (count + 1))) }));
}
const SCALE = [[50, 52], [100, 37], [200, 26], [300, 12], [400, 6], [500, 0], [600, -6], [700, -12], [800, -18], [900, -24]];
/** Material-like 50..900 scale: HSL lightness shifted (in percentage points) around the base colour, which becomes 500. */
export function materialScale(c) {
  const h = srgbToHsl(c);
  return SCALE.map(([step, d]) => ({ name: String(step), color: d === 0 ? clampRgb(c) : clampRgb(hslToSrgb({ ...h, l: clamp(h.l + d / 100, 0.02, 0.98) }, c.a)) }));
}
/** N-step gradient including both ends. space: 'srgb' | 'oklab'. */
export function gradient(c1, c2, steps = 7, space = 'srgb') {
  steps = clamp(Math.round(steps), 2, 50);
  const out = [];
  const o1 = srgbToOklab(c1), o2 = srgbToOklab(c2);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1), a = c1.a + (c2.a - c1.a) * t;
    const col = space === 'oklab' ? oklabToSrgb({ l: o1.l + (o2.l - o1.l) * t, a: o1.a + (o2.a - o1.a) * t, b: o1.b + (o2.b - o1.b) * t }, a) : { ...mixSrgb(c1, c2, t), a };
    out.push({ name: `step-${i + 1}`, color: clampRgb(col) });
  }
  return out;
}

// ---------------------------------------------------------------- palette export
export const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'color';
export const EXPORT_FORMATS = { css: 'CSS variables', scss: 'SCSS variables', tailwind: 'Tailwind config', json: 'JSON' };
/** entries: [{ name, color }]. */
export function exportPalette(entries, format, { prefix = 'color', hexCase = 'lower' } = {}) {
  const px = slug(prefix);
  const hex = e => formatHex(e.color, { hexCase });
  const names = [];
  const named = entries.map((e, i) => {
    let nm = slug(e.name || `${i + 1}`);
    while (names.includes(nm)) nm += '-x';
    names.push(nm);
    return { ...e, key: nm };
  });
  switch (format) {
    case 'css': return `:root {\n${named.map(e => `  --${px}-${e.key}: ${hex(e)};`).join('\n')}\n}`;
    case 'scss': return named.map(e => `$${px}-${e.key}: ${hex(e)};`).join('\n');
    case 'json': return JSON.stringify({ [px]: Object.fromEntries(named.map(e => [e.key, hex(e)])) }, null, 2);
    case 'tailwind': {
      const numeric = named.every(e => /^\d+$/.test(e.key));
      const body = numeric
        ? `      '${px}': {\n${named.map(e => `        ${e.key}: '${hex(e)}',`).join('\n')}\n      },`
        : named.map(e => `      '${px}-${e.key}': '${hex(e)}',`).join('\n');
      return `// tailwind.config.js\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n${body.replace(/^/gm, '  ')}\n      },\n    },\n  },\n};`;
    }
    default: throw new Error(`Unknown export format ${format}`);
  }
}

// ---------------------------------------------------------------- batch
export const MAX_BATCH_LINES = 1000;
/** One colour per line. Returns { rows, truncated }. Blank lines are skipped. */
export function parseMany(text, opts = {}) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean);
  const truncated = lines.length > MAX_BATCH_LINES;
  const rows = lines.slice(0, MAX_BATCH_LINES).map((input, i) => {
    const r = parseColor(input);
    if (!r.ok) return { line: i + 1, input, ok: false, error: r.error };
    const c = r.color;
    return { line: i + 1, input, ok: true, format: r.format, color: c, hex: formatColor(c, 'hex', opts), rgb: formatColor(c, 'rgb', opts), hsl: formatColor(c, 'hsl', opts), oklch: formatColor(c, 'oklch', opts), inGamut: r.inGamut !== false };
  });
  return { rows, truncated, total: lines.length };
}
const csvCell = s => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
export function batchToCsv(rows) {
  return ['input,status,hex,rgb,hsl,oklch,error', ...rows.map(r => [r.input, r.ok ? 'ok' : 'error', r.hex ?? '', r.rgb ?? '', r.hsl ?? '', r.oklch ?? '', r.error ?? ''].map(csvCell).join(','))].join('\n');
}
