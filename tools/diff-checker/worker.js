// Module worker: computes the line diff off the main thread. Request {id, a, b, opts}; reply {id, codes, eolA, eolB, linesA, linesB} or {id, error}.
import { splitLines, diffCodes, eolStyle } from './logic.js';

self.onmessage = ev => {
  const { id, a, b, opts } = ev.data || {};
  try {
    const A = splitLines(a), B = splitLines(b);
    const codes = diffCodes(A, B, opts);
    self.postMessage({ id, codes, eolA: eolStyle(A), eolB: eolStyle(B), linesA: A.length, linesB: B.length, approximate: codes.approximate }, [codes.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
