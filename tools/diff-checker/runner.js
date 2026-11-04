// Runs diffs in a Web Worker above WORKER_LINE_THRESHOLD lines (cancellable via terminate()), in-thread otherwise
// or when a Worker cannot be created.
import { splitLines, diffCodes, materialize, eolStyle, WORKER_LINE_THRESHOLD } from './logic.js';

const countLines = s => { let n = 1, i = -1; while ((i = s.indexOf('\n', i + 1)) !== -1) n++; return n; };

/** createRunner() -> { run(a, b, opts) -> Promise<result | {cancelled:true}>, cancel(), dispose() } */
export function createRunner({ threshold = WORKER_LINE_THRESHOLD, createWorker } = {}) {
  const make = createWorker || (() => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  let worker = null, current = null, seq = 0;

  const kill = () => { if (worker) { try { worker.terminate(); } catch { /* ignore */ } } worker = null; };
  const finish = r => { if (!current) return; const c = current; current = null; c.resolve(r); };

  function inThread(a, b, opts) {
    // Yield once so a spinner can paint before the synchronous work starts.
    return new Promise(resolve => setTimeout(() => {
      try {
        const A = splitLines(a), B = splitLines(b);
        resolve({ ...materialize(A, B, diffCodes(A, B, opts)), eolA: eolStyle(A), eolB: eolStyle(B), linesA: A.length, linesB: B.length });
      } catch (e) { resolve({ error: String(e && e.message || e) }); }
    }, 0));
  }

  function run(a, b, opts) {
    if (current) finish({ cancelled: true });
    const big = countLines(a) + countLines(b) > threshold && (typeof createWorker !== 'undefined' || typeof Worker !== 'undefined');
    if (!big) return inThread(a, b, opts);
    return new Promise(resolve => {
      const id = ++seq;
      let w;
      try { w = make(); } catch { resolve(inThread(a, b, opts)); return; }
      worker = w;
      current = { id, resolve };
      w.onmessage = ev => {
        const d = ev.data || {};
        if (d.id !== id) return;
        kill();
        if (d.error) return finish({ error: d.error });
        const A = splitLines(a), B = splitLines(b);
        finish({ ...materialize(A, B, d.codes, !!d.approximate), eolA: d.eolA, eolB: d.eolB, linesA: d.linesA, linesB: d.linesB });
      };
      w.onerror = () => { // worker failed to load/crashed: fall back to the main thread
        if (worker !== w) return;
        kill();
        if (current && current.id === id) { current = null; resolve(inThread(a, b, opts)); }
      };
      try { w.postMessage({ id, a, b, opts }); } catch { kill(); current = null; resolve(inThread(a, b, opts)); }
    });
  }
  return {
    run,
    cancel() { kill(); finish({ cancelled: true }); },
    dispose() { kill(); finish({ cancelled: true }); },
  };
}
