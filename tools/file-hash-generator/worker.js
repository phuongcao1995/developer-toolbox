// Module worker: hashes one File/Blob per request so the UI thread stays responsive.
// Protocol  in : { type:'hash', id, file, algos, key }   out: { type:'progress'|'done'|'error', id, ... }
import { hashBlob } from './logic.js';

const cancelled = new Set();
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  if (m.type !== 'hash') return;
  const t0 = performance.now();
  let last = 0;
  try {
    const { digests, method } = await hashBlob(m.file, {
      algos: m.algos, key: m.key || null,
      isCancelled: () => cancelled.has(m.id),
      onProgress: (done, total) => { const n = performance.now(); if (n - last > 80 || done === total) { last = n; self.postMessage({ type: 'progress', id: m.id, done, total }); } },
    });
    self.postMessage({ type: 'done', id: m.id, digests, method, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, cancelled: err?.name === 'AbortError', message: err?.message || String(err) });
  } finally { cancelled.delete(m.id); }
};
self.postMessage({ type: 'ready' });
