// Module Web Worker: runs one conversion off the main thread, reporting progress. The page terminate()s it on Cancel.
import { convert, summarizeTable } from './logic.js';

self.onmessage = ev => {
  const { id, input, from, to, opts } = ev.data || {};
  let last = 0;
  try {
    const res = convert(input, from, to, {
      ...opts,
      onProgress: p => { const now = Date.now(); if (now - last > 80 || p.fraction === 1) { last = now; self.postMessage({ id, type: 'progress', stage: p.stage, fraction: p.fraction }); } },
    });
    self.postMessage({ id, type: 'done', result: { output: res.output, warnings: res.warnings, ext: res.ext, mime: res.mime, table: summarizeTable(res.table) } });
  } catch (e) {
    self.postMessage({ id, type: 'error', message: String((e && e.message) || e), known: !!(e && e.name === 'ConvertError') });
  }
};
self.postMessage({ type: 'ready' });
