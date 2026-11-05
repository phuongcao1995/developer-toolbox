// Canvas rendering shared by the UI thread and worker.js. Works with DOM canvases or OffscreenCanvas.
import { computeLayout } from './logic.js';

export class UserError extends Error {}

export function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
export function encodeCanvas(cv, mime, quality) {
  if (typeof cv.convertToBlob === 'function') return cv.convertToBlob({ type: mime, quality });
  return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new UserError('The browser could not encode this image (it may be too large for a canvas).'))), mime, quality));
}

/**
 * Draw `source` (ImageBitmap / HTMLImageElement) to a new canvas and encode it.
 * o: { resize (computeLayout opts), vector, mime, quality (0-1 or undefined), fill ('#rrggbb' or null) }
 * Returns { blob, layout }. The caller must check blob.type: unsupported types silently come back as PNG.
 */
export async function convertSource(source, srcW, srcH, o) {
  const layout = computeLayout(srcW, srcH, { ...o.resize, noUpscale: o.vector ? false : o.resize.noUpscale });
  if (layout.error) throw new UserError(layout.error);
  const cv = makeCanvas(layout.outW, layout.outH), g = cv.getContext('2d');
  if (!g) throw new UserError('Could not create a drawing surface (the output may be too large).');
  if (o.fill) { g.fillStyle = o.fill; g.fillRect(0, 0, layout.outW, layout.outH); }
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(source, layout.sx, layout.sy, layout.sw, layout.sh, 0, 0, layout.outW, layout.outH);
  const blob = await encodeCanvas(cv, o.mime, o.quality);
  return { blob, layout };
}
