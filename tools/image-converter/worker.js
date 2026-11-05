// Module worker: decode + resize + encode one image off the UI thread using OffscreenCanvas.
// in : { id, file, o }   out: { id, ok:true, blob, srcW, srcH, layout } | { id, ok:false, code:'decode'|'limit'|'error', message }
import { checkInputLimits } from './logic.js';
import { convertSource } from './render.js';

self.onmessage = async e => {
  const { id, file, o } = e.data;
  let bmp = null;
  try {
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { return self.postMessage({ id, ok: false, code: 'decode', message: 'decode' }); }
    const lim = checkInputLimits(file.size, bmp.width, bmp.height);
    if (lim) return self.postMessage({ id, ok: false, code: 'limit', message: lim });
    const { blob, layout } = await convertSource(bmp, bmp.width, bmp.height, o);
    self.postMessage({ id, ok: true, blob, srcW: bmp.width, srcH: bmp.height, layout });
  } catch (err) {
    self.postMessage({ id, ok: false, code: 'error', message: err?.message || String(err) });
  } finally { bmp?.close?.(); }
};
self.postMessage({ ready: true });
