// Module worker: parses + analyses large JSON off the main thread.
// Request:  { id, text }
// Response: { id, ok:true, value, stats, lossy }  |  { id, ok:false, message, line?, column?, offset?, snippet? }
import { parseJson, stats, analyzeLossiness, describeLossiness } from './logic.js';

self.onmessage = e => {
  const { id, text } = e.data || {};
  try {
    const r = parseJson(String(text ?? ''));
    if (!r.ok) { self.postMessage({ id, ...r }); return; }
    let lossy = '';
    try { lossy = describeLossiness(analyzeLossiness(text)); } catch { /* best effort */ }
    self.postMessage({ id, ok: true, value: r.value, stats: stats(r.value), lossy });
  } catch (err) {
    self.postMessage({ id, ok: false, message: (err && err.message) || String(err) });
  }
};
