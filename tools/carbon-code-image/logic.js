// Code Image Generator - pure logic (no DOM): options, geometry shared by the preview and the PNG renderer.
export { highlight, LANGUAGES, detectLanguageByName } from './highlight.js';
export { THEMES, GRADIENTS, TOKEN_CLASSES, gradientCss, gradientLine, colorFor } from './themes.js';
import { THEMES, GRADIENTS } from './themes.js';
import { LANGUAGES } from './highlight.js';

/** Same stack in CSS (preview) and canvas (export) so glyph metrics match. */
export const FONT_STACK = "'JetBrains Mono','Fira Code','SF Mono',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace";
export const UI_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MAX_CANVAS_PIXELS = 120e6; // stay well below browser canvas limits (~268M px, 16384 px per side)
export const MAX_CANVAS_SIDE = 16000;

export const DEFAULT_OPTIONS = {
  lang: 'javascript', theme: 'one-dark', bgMode: 'gradient', bgColor: '#abb8c3', gradient: 'purple-haze', padding: 48, fontSize: 14, radius: 12,
  autoWidth: true, width: 680, windowStyle: 'mac', title: 'example.js', lineNumbers: false, shadow: true, scale: 2,
};

const clamp = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

/** Clamp/validate untrusted option values (storage, form). */
export function sanitizeOptions(raw = {}) {
  const d = DEFAULT_OPTIONS;
  return {
    lang: LANGUAGES[raw.lang] ? raw.lang : d.lang,
    theme: THEMES[raw.theme] ? raw.theme : d.theme,
    bgMode: ['solid', 'gradient', 'none'].includes(raw.bgMode) ? raw.bgMode : d.bgMode,
    bgColor: /^#[0-9a-fA-F]{6}$/.test(raw.bgColor) ? raw.bgColor : d.bgColor,
    gradient: GRADIENTS.some(g => g.id === raw.gradient) ? raw.gradient : d.gradient,
    padding: clamp(raw.padding, 16, 128, d.padding),
    fontSize: clamp(raw.fontSize, 10, 28, d.fontSize),
    radius: clamp(raw.radius, 0, 32, d.radius),
    autoWidth: raw.autoWidth !== false,
    width: clamp(raw.width, 320, 1400, d.width),
    windowStyle: ['mac', 'none'].includes(raw.windowStyle) ? raw.windowStyle : d.windowStyle,
    title: String(raw.title ?? d.title).slice(0, 80),
    lineNumbers: !!raw.lineNumbers,
    shadow: raw.shadow !== false,
    scale: [1, 2, 3].includes(Number(raw.scale)) ? Number(raw.scale) : d.scale,
  };
}

/**
 * Compute every pixel position once. `lines` come from highlight(); `charW` is the measured monospace advance.
 * Returned numbers are in CSS px at scale 1; the DOM preview and the canvas renderer both read this object.
 */
export function computeLayout(lines, o, charW) {
  const lineH = Math.round(o.fontSize * 1.55);
  const titleH = o.windowStyle === 'mac' ? 44 : 0;
  const padX = 22, padTop = titleH ? 8 : 22, padBottom = 22;
  const n = Math.max(1, lines.length);
  const digits = String(n).length;
  const gutter = o.lineNumbers ? Math.ceil(digits * charW) + 22 : 0;
  const maxCols = lines.reduce((m, l) => Math.max(m, l.reduce((s, t) => s + t.text.length, 0)), 0);
  const autoW = Math.ceil(gutter + maxCols * charW + padX * 2);
  const winW = o.autoWidth ? Math.max(autoW, 260) : o.width;
  const winH = titleH + padTop + n * lineH + padBottom;
  return {
    lineH, titleH, padX, padTop, padBottom, gutter, digits, charW, lineCount: n,
    win: { x: o.padding, y: o.padding, w: winW, h: winH },
    stageW: winW + o.padding * 2, stageH: winH + o.padding * 2,
    codeX: padX, codeY: titleH + padTop,
  };
}

/** Pixel size of the exported PNG, plus an error string when it would exceed canvas limits. */
export function exportSize(layout, scale) {
  const w = Math.round(layout.stageW * scale), h = Math.round(layout.stageH * scale);
  let error = null;
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE || w * h > MAX_CANVAS_PIXELS) {
    error = `The image would be ${w} x ${h}px, which is too large for the browser. Lower the scale, padding or amount of code.`;
  }
  return { w, h, error };
}

export const exportFileName = (title, lang, scale) => {
  const base = String(title || '').replace(/\.[A-Za-z0-9]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `code-${lang}`;
  return `${base}${scale > 1 ? `@${scale}x` : ''}.png`;
};

/** Line-number text for one line, right-aligned to the widest number. */
export const lineNumberText = (i, digits) => String(i + 1).padStart(digits, ' ');

/** Drop shadow of the window (CSS box-shadow blur radius == canvas shadowBlur, so both renderers agree). */
export const shadowSpec = theme => ({ offsetY: 24, blur: 64, color: theme.dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.30)' });
export const MAC_DOTS = ['#ff5f56', '#ffbd2e', '#27c93f'];
