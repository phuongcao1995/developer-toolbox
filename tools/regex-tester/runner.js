// Runs regex jobs in a Web Worker that is terminate()d when it takes too long (the regex engine cannot be interrupted
// any other way). Falls back to in-thread execution only if a Worker cannot be created (then results carry fallback:true).
import { runJob, WORKER_TIMEOUT_MS } from './logic.js';

export { WORKER_TIMEOUT_MS };
const READY_TIMEOUT_MS = 4000;

/**
 * createRunner({ timeoutMs, createWorker }) -> { run(job), dispose() }
 * run(job) resolves with one of:
 *   { ok:true, matches, truncated, reason, replace }   (+ fallback:true when run in-thread)
 *   { ok:false, error }                                 (invalid pattern etc.)
 *   { timedOut:true, timeoutMs }                        (worker was terminated)
 *   { cancelled:true }                                  (superseded by a newer run() or disposed)
 * `createWorker` is injectable for tests; the default builds a module worker from ./worker.js (relative URL, static hosting safe).
 */
export function createRunner({ timeoutMs = WORKER_TIMEOUT_MS, createWorker } = {}) {
  const make = createWorker || (() => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  let worker = null, ready = null, fallback = typeof createWorker === 'undefined' && typeof Worker === 'undefined';
  let current = null; // { id, resolve, timer }
  let seq = 0, disposed = false;

  function kill() {
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
    worker = null; ready = null;
  }
  function settle(result) {
    if (!current) return;
    clearTimeout(current.timer);
    const { resolve } = current; current = null;
    resolve(result);
  }

  function spawn() {
    if (worker) return ready;
    let w;
    try { w = make(); } catch { fallback = true; return Promise.resolve(false); }
    worker = w;
    ready = new Promise(resolveReady => {
      const readyTimer = setTimeout(() => { if (worker === w) { kill(); fallback = true; } resolveReady(false); }, READY_TIMEOUT_MS);
      w.onmessage = ev => {
        const d = ev.data || {};
        if (d.type === 'ready') { clearTimeout(readyTimer); resolveReady(true); return; }
        if (current && d.id === current.id) settle(d.result);
      };
      w.onerror = () => { // script failed to load/parse, or crashed
        clearTimeout(readyTimer);
        if (worker === w) { kill(); fallback = true; }
        resolveReady(false);
        if (current) { const job = current.job; settle({ __retry: job }); }
      };
    });
    return ready;
  }

  async function run(job) {
    if (disposed) return { cancelled: true };
    if (current) { kill(); settle({ cancelled: true }); } // an older job may still be spinning: drop its worker
    if (fallback) return { ...runJob(job), fallback: true };
    const id = ++seq;
    const ok = await spawn();
    if (id !== seq || disposed) return { cancelled: true };
    if (!ok || !worker) { fallback = true; return { ...runJob(job), fallback: true }; }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!current || current.id !== id) return;
        kill(); settle({ timedOut: true, timeoutMs });
      }, timeoutMs);
      current = { id, resolve, timer, job };
      try { worker.postMessage({ id, job }); } catch { kill(); fallback = true; settle({ __retry: job }); }
    }).then(r => (r && r.__retry ? { ...runJob(r.__retry), fallback: true } : r));
  }

  return {
    run,
    get usingFallback() { return fallback; },
    dispose() { disposed = true; kill(); settle({ cancelled: true }); },
  };
}
