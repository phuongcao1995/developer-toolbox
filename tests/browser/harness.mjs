// Minimal Chrome DevTools Protocol harness for the browser checks (no dependencies; Node 22+ for global WebSocket/fetch).
//
// Usage: start a static server first (for example `npm run serve`, which serves http://localhost:8080/),
// then run `node tests/browser/smoke.mjs` or `node tests/browser/leak.mjs`.
//
// Environment: BASE (default http://localhost:8080/), CHROME_PATH (auto-detected for Windows, macOS and Linux).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE = process.env.BASE || 'http://localhost:8080/';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

/** Tool ids in registry order (parsed from the registry source so this works without importing browser code). */
export const toolIds = () => [...readFileSync(join(ROOT, 'assets/js/registry.js'), 'utf8').matchAll(/^\s+t\('([a-z0-9-]+)'/gm)].map(m => m[1]);

export async function start({ base = BASE } = {}) {
  const chromePath = CANDIDATES.find(p => existsSync(p));
  if (!chromePath) throw new Error('Chrome/Chromium/Edge not found. Set CHROME_PATH.');
  try { await fetch(base); } catch { throw new Error(`Nothing is serving ${base}. Start a static server first (npm run serve) or set BASE.`); }
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'devtoolbox-chrome-'));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let targets;
  for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://localhost:${port}/json`)).json(); if (targets.length) break; } catch { /* retry */ } await sleep(200); }
  if (!targets?.length) { chrome.kill(); throw new Error('Could not connect to Chrome DevTools.'); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const errors = []; const handlers = new Map();
  const on = (method, fn) => handlers.set(method, fn);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('CONSOLE ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('LOG ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  /** Evaluate an expression in the page. Returns the value, or '__PAGE_UNRESPONSIVE__' after 25 s. */
  const ev = async expr => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), new Promise(res => setTimeout(() => res({ TIMEOUT: true }), 25000))]);
    if (r.TIMEOUT) return '__PAGE_UNRESPONSIVE__';
    return r.result?.result?.value ?? (r.result?.exceptionDetails ? 'EXC:' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) : undefined);
  };
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); // never test stale modules
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: base }); await sleep(1500);
  await ev('localStorage.clear()');
  const finish = () => { try { ws.close(); } catch { /* ignore */ } chrome.kill(); };
  return { ev, send, sleep, errors, finish, on, base };
}
