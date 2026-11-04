// Module Web Worker: executes one regex job at a time. The page terminate()s it if a pattern runs too long.
import { runJob } from './logic.js';

self.onmessage = ev => {
  const { id, job } = ev.data || {};
  let result;
  try { result = runJob(job); } catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
  self.postMessage({ id, result });
};
self.postMessage({ type: 'ready' });
