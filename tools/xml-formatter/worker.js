// Runs the heavy XML operations off the main thread (used for inputs above ~1 MB).
import { runOp } from './logic.js';

self.onmessage = e => {
  const { id, op, text, opts } = e.data;
  try { self.postMessage({ id, result: runOp(op, text, opts) }); }
  catch (err) { self.postMessage({ id, crash: String(err && err.message || err) }); }
};
