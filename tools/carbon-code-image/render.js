// Canvas renderer for the PNG export. It draws from the exact same data as the DOM preview
// (highlighted lines + computeLayout geometry + theme palette), so the two stay visually identical.
// Only needs a 2D context-like canvas; contains no DOM lookups.
import { segments } from './highlight.js';
import { FONT_STACK, UI_FONT, shadowSpec, MAC_DOTS, lineNumberText, colorFor, gradientLine, GRADIENTS } from './logic.js';

function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Measure the width of one monospace cell for the given font size (uses any canvas). */
export function measureCharWidth(canvas, fontSize) {
  const g = canvas.getContext('2d');
  g.font = `${fontSize}px ${FONT_STACK}`;
  return g.measureText('M'.repeat(20)).width / 20; // averaging 20 glyphs avoids sub-pixel rounding error
}

/** Vertical metrics: baseline offset inside a line box of height lineH (same maths as CSS half-leading). */
export function baselineOffset(g, fontSize, lineH) {
  g.font = `${fontSize}px ${FONT_STACK}`;
  const m = g.measureText('Mg');
  const asc = m.fontBoundingBoxAscent ?? fontSize * 0.95, desc = m.fontBoundingBoxDescent ?? fontSize * 0.3;
  return (lineH - (asc + desc)) / 2 + asc;
}

/**
 * Draw the whole image. `canvas` is resized to stage size x scale.
 * model = { lines, layout, opts, theme }
 */
export function renderToCanvas(canvas, { lines, layout, opts, theme }, scale) {
  const W = Math.round(layout.stageW * scale), H = Math.round(layout.stageH * scale);
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas is not available in this browser.');
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, layout.stageW, layout.stageH);

  // 1. background
  if (opts.bgMode === 'solid') { g.fillStyle = opts.bgColor; g.fillRect(0, 0, layout.stageW, layout.stageH); }
  else if (opts.bgMode === 'gradient') {
    const gr = GRADIENTS.find(x => x.id === opts.gradient) || GRADIENTS[0];
    const { x0, y0, x1, y1 } = gradientLine(layout.stageW, layout.stageH, gr.angle);
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    for (const [c, p] of gr.stops) grad.addColorStop(p, c);
    g.fillStyle = grad; g.fillRect(0, 0, layout.stageW, layout.stageH);
  }

  // 2. window (shadow is applied while filling; shadow offsets are not affected by the transform, so scale them)
  const { x, y, w, h } = layout.win;
  g.save();
  if (opts.shadow) {
    const s = shadowSpec(theme);
    g.shadowColor = s.color; g.shadowBlur = s.blur * scale; g.shadowOffsetX = 0; g.shadowOffsetY = s.offsetY * scale;
  }
  roundRectPath(g, x, y, w, h, opts.radius);
  g.fillStyle = theme.bg; g.fill();
  g.restore();
  // 1px ring just outside the window (CSS: box-shadow 0 0 0 1px)
  roundRectPath(g, x - 0.5, y - 0.5, w + 1, h + 1, opts.radius + 0.5);
  g.strokeStyle = theme.border; g.lineWidth = 1; g.stroke();

  // 3. window contents, clipped to the rounded window
  g.save();
  roundRectPath(g, x, y, w, h, opts.radius); g.clip();

  if (layout.titleH) {
    MAC_DOTS.forEach((c, i) => { g.beginPath(); g.arc(x + 20 + i * 20, y + layout.titleH / 2, 6, 0, Math.PI * 2); g.fillStyle = c; g.fill(); });
    if (opts.title) {
      g.font = `13px ${UI_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = theme.ln;
      g.fillText(opts.title, x + w / 2, y + layout.titleH / 2 + 0.5, w - 160 > 40 ? w - 160 : 40);
      g.textAlign = 'left';
    }
  }

  g.font = `${opts.fontSize}px ${FONT_STACK}`; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  const base = baselineOffset(g, opts.fontSize, layout.lineH);
  const left = x + layout.codeX, top = y + layout.codeY;
  lines.forEach((line, i) => {
    const by = top + i * layout.lineH + base;
    if (opts.lineNumbers) {
      g.fillStyle = theme.ln;
      const num = lineNumberText(i, layout.digits), trimmed = num.trimStart();
      g.fillText(trimmed, left + (num.length - trimmed.length) * layout.charW, by);
    }
    // One fillText per run of narrow characters; wide characters are pinned to their own 2-cell column.
    let col = 0;
    const tx = left + layout.gutter;
    for (const tok of line) {
      if (tok.cls === 'plain' && !tok.text.trim()) { for (const s of segments(tok.text, col)) col = s.col + s.cols; continue; }
      g.fillStyle = colorFor(theme, tok.cls);
      for (const s of segments(tok.text, col)) {
        if (s.text.trim()) g.fillText(s.text, tx + s.col * layout.charW, by);
        col = s.col + s.cols;
      }
    }
  });
  g.restore();
  return canvas;
}

/** Canvas -> PNG Blob (rejects when the browser cannot encode it, e.g. canvas too large). */
export const canvasToBlob = canvas => new Promise((resolve, reject) => {
  try { canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The browser could not encode the image (it may be too large). Try a lower scale.'))), 'image/png'); }
  catch (e) { reject(e); }
});
