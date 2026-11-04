// Run: node tests/unit/regex-tester.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/regex-tester/logic.js';
import { createRunner } from '../../tools/regex-tester/runner.js';

let pass = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });

// ---- risk heuristics ----
test('no warning on any bundled example (default Email included)', () => {
  for (const ex of L.EXAMPLES) assert.equal(L.riskWarning(ex.pattern, ex.flags), null, ex.name);
});
test('no warning on common safe patterns', () => {
  const safe = ['^\\d+$', '[a-z]+@[a-z]+\\.com', '(?:\\.[\\w-]+)+', '([a-z]+\\.)+[a-z]{2,}', '(\\d+,)*\\d+', '"(?:[^"\\\\]|\\\\.)*"', '(?:a|b)+', '(?:foo|bar)*baz',
    '(\\s|,)*', '^(?:\\d{1,3}\\.){3}\\d{1,3}$', '(?:https?|ftp):\\/\\/\\S+', '^(?=.*\\d)(?=.*[a-z]).{8,}$', '\\b(\\w+)\\s+\\1\\b', '(?:ab|cd)+', '(\\w+)@(\\w+)', '(?:\\r\\n|\\n)+', '[(]+\\d+[)]+', '(x)+', '(a?)b'];
  for (const p of safe) assert.equal(L.riskWarning(p), null, p);
});
test('flags nested quantifiers', () => {
  for (const p of ['(a+)+', '(x*)*', '(x+)*', '(.*)*', '^(\\d+)*$', '(\\w+\\s?)*', '(?:\\w+\\s?)*$', '((a+)+)', '(a+b?)+', '(\\s*\\w+)*', '(a+a)+', '(\\w+(\\.\\w+)*)+'])
    assert.ok(L.riskWarning(p), p);
});
test('flags overlapping alternation in repeated groups', () => {
  for (const p of ['(a|aa)+$', '(a|a)+', '^(a|aa)*$', '(\\w|\\d)+', '(.|a)*', '(?:a|a?)+', '(\\d|\\d\\d)+x']) assert.ok(L.riskWarning(p), p);
});
test('analyzeRisk reports code and snippet; never throws on junk', () => {
  const f = L.analyzeRisk('x(a+)+y');
  assert.equal(f[0].code, 'nested-quantifier'); assert.equal(f[0].snippet, '(a+)');
  for (const p of ['(', ')', '(((', '[', '[a', '\\', '(?<n', '*', '+?', '{', 'a{2,', '(?<=a)+', '(?i:a+)+', '\\u{']) assert.doesNotThrow(() => L.analyzeRisk(p), p);
});
test('bounded repetition and lookarounds are not flagged', () => {
  assert.equal(L.riskWarning('(a+){3}'), null);
  assert.equal(L.riskWarning('(?=(a+)+)'), null);
});

// ---- flags ----
test('flag helpers', () => {
  assert.ok(L.supportsFlag('g')); assert.ok(L.supportsFlag('y')); assert.ok(L.supportsFlag('d')); assert.equal(L.supportsFlag('q'), false);
  assert.equal(L.resolveFlagConflict('gu', 'u'), 'gu');
  assert.equal(L.resolveFlagConflict('guv', 'v'), 'gv');
  assert.equal(L.resolveFlagConflict('guv', 'u'), 'gu');
  assert.equal(L.resolveFlagConflict('ig', 'i'), 'gi');
});
test('y and d flags compile and match', () => {
  const b = L.buildRegex('a', 'dy'); assert.ok(b.ok);
  assert.equal(L.findMatches(b.regex, 'aab').matches.length, 2); // sticky: matches at 0 and 1, then fails at 2
});

// ---- runJob ----
test('runJob matches and replaces', () => {
  const r = L.runJob({ pattern: '(\\d+)', flags: 'g', text: 'a1 b22', replacement: '<$1>' });
  assert.ok(r.ok); assert.equal(r.matches.length, 2); assert.equal(r.replace.result, 'a<1> b<22>');
});
test('runJob reports invalid pattern and bad replacement-free paths', () => {
  const r = L.runJob({ pattern: '(', flags: '', text: 'x' });
  assert.equal(r.ok, false); assert.ok(r.error);
  assert.equal(L.runJob({ pattern: '', text: 'x' }).empty, true);
});

// ---- explain fixes ----
test('explain: unmatched ) is an error', () => {
  const t = L.explain('a)b');
  const close = t.find(x => x.token === ')');
  assert.equal(close.kind, 'error'); assert.match(close.desc, /Unmatched/);
  assert.equal(L.explain('(a)').find(x => x.token === ')').kind, 'group');
});
test('explain: modifier groups', () => {
  const t = L.explain('(?i:x)');
  assert.equal(t[0].token, '(?i:'); assert.match(t[0].desc, /ignore case/); assert.notEqual(t[0].kind, 'error');
  assert.match(L.explain('(?i-s:x)')[0].desc, /turns off: dotAll/);
  assert.equal(L.explain('(?:x)')[0].desc, 'Non-capturing group');
  assert.equal(L.explain('(?z)')[0].kind, 'error');
});

// ---- runner (fake workers; Node has no Worker global) ----
const fakeWorker = (behaviour) => () => {
  const w = { terminated: false, onmessage: null, onerror: null,
    postMessage(msg) { behaviour(w, msg); },
    terminate() { w.terminated = true; } };
  setTimeout(() => w.onmessage?.({ data: { type: 'ready' } }), 0);
  return w;
};
test('runner: falls back in-thread when Worker is unavailable', async () => {
  const r = createRunner();
  const out = await r.run({ pattern: 'a', flags: 'g', text: 'aa' });
  assert.equal(out.fallback, true); assert.equal(out.matches.length, 2); assert.equal(r.usingFallback, true);
});
test('runner: falls back when worker construction throws', async () => {
  const r = createRunner({ createWorker: () => { throw new Error('no workers'); } });
  const out = await r.run({ pattern: 'a', flags: '', text: 'a' });
  assert.equal(out.fallback, true); assert.ok(out.ok); assert.equal(r.usingFallback, true);
});
test('runner: returns worker results', async () => {
  const r = createRunner({ timeoutMs: 500, createWorker: fakeWorker((w, msg) => setTimeout(() => w.onmessage({ data: { id: msg.id, result: { ok: true, matches: [], replace: { ok: true, result: 'x' } } } }), 0)) });
  const out = await r.run({ pattern: 'a', flags: '', text: '' });
  assert.equal(out.ok, true); assert.equal(out.fallback, undefined); assert.equal(out.replace.result, 'x');
  r.dispose();
});
test('runner: a hung worker is terminated after the timeout', async () => {
  let created = 0; const workers = [];
  const r = createRunner({ timeoutMs: 40, createWorker: () => { created++; const w = fakeWorker(() => { /* never replies */ })(); workers.push(w); return w; } });
  const t0 = Date.now();
  const out = await r.run({ pattern: '(a+)+$', flags: '', text: 'x' });
  assert.equal(out.timedOut, true); assert.equal(out.timeoutMs, 40); assert.ok(Date.now() - t0 < 1000);
  assert.equal(workers[0].terminated, true);
  // next run spawns a fresh worker
  const p = r.run({ pattern: 'a', flags: '', text: '' });
  const out2 = await p;
  assert.equal(out2.timedOut, true); assert.equal(created, 2);
  r.dispose();
});
test('runner: a newer run cancels the older one', async () => {
  const w0 = [];
  const r = createRunner({ timeoutMs: 1000, createWorker: () => { const w = fakeWorker((ww, msg) => { if (msg.job.text === 'second') setTimeout(() => ww.onmessage({ data: { id: msg.id, result: { ok: true, matches: [], replace: { ok: true, result: '2' } } } }), 0); })(); w0.push(w); return w; } });
  const first = r.run({ pattern: 'a', text: 'first' });
  await new Promise(res => setTimeout(res, 10));
  const second = r.run({ pattern: 'a', text: 'second' });
  assert.equal((await first).cancelled, true);
  assert.equal((await second).replace.result, '2');
  assert.equal(w0[0].terminated, true);
  r.dispose();
});
test('runner: worker error event falls back in-thread', async () => {
  const r = createRunner({ createWorker: () => { const w = { postMessage() {}, terminate() {}, onmessage: null, onerror: null }; setTimeout(() => w.onerror?.(new Error('load failed')), 0); return w; } });
  const out = await r.run({ pattern: 'b', flags: 'g', text: 'abb' });
  assert.equal(out.fallback, true); assert.equal(out.matches.length, 2);
});
test('runner: disposed runner cancels', async () => {
  const r = createRunner({ createWorker: fakeWorker(() => {}) }); r.dispose();
  assert.equal((await r.run({ pattern: 'a', text: '' })).cancelled, true);
});

for (const { name, fn } of queue) {
  try { await fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}
console.log(`regex-tester: ${pass}/${queue.length} passed`);
