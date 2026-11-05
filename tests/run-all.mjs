// Runs every Node test file in tests/unit plus Saltbox's own suite and prints a summary.
//   node tests/run-all.mjs            all suites (DOM suites need `npm install` first)
//   node tests/run-all.mjs --no-dom   do not print the notice about missing jsdom/dompurify/marked (those DOM tests skip themselves)
//   node tests/run-all.mjs sql json   only suites whose file name contains one of the words
// Exit code is non-zero when any suite fails, so it can be used in CI.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noDom = args.includes('--no-dom');
const filters = args.filter(a => !a.startsWith('--'));

const suites = readdirSync(join(root, 'tests', 'unit')).filter(f => f.endsWith('.test.mjs')).sort()
  .map(f => ({ name: f.replace('.test.mjs', ''), file: join('tests', 'unit', f) }));
suites.push({ name: 'saltbox (crypto vectors)', file: join('tools', 'saltbox', 'tests', 'run-tests.js') });

const domReady = ['jsdom', 'dompurify', 'marked'].every(p => existsSync(join(root, 'node_modules', p)));
if (!domReady && !noDom) console.log('Note: jsdom/dompurify/marked are not installed (run `npm install`); the Markdown DOM tests will be skipped.\n');

const picked = filters.length ? suites.filter(s => filters.some(w => s.name.includes(w))) : suites;
let failed = 0, total = 0; const t0 = Date.now();
for (const s of picked) {
  const t = Date.now();
  // NODE_NO_WARNINGS: the app's .js files are ES modules inside a package without "type": "module" (which would break the
  // CommonJS Saltbox tests and the vendored UMD jsQR), so Node prints a harmless reparse warning for every suite.
  const r = spawnSync(process.execPath, [s.file], { cwd: root, encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const ms = Date.now() - t;
  const ok = r.status === 0;
  if (!ok) failed++;
  const outLines = r.stdout.trim().split('\n').filter(Boolean);
  const summary = [...outLines].reverse().find(l => /\d+\s*(\/\s*\d+\s*)?(tests?\s+)?passed|passed/i.test(l)) || outLines.pop() || (r.stderr.trim().split('\n').pop() || '');
  total += Number((summary.match(/(\d+)\s*(?:\/\s*\d+\s*)?(?:tests?\s+)?passed/i) || summary.match(/(\d+)\s+[\w-]+\s+tests\s+passed/i) || [])[1] || 0);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(30)} ${String(ms).padStart(6)} ms  ${summary.trim().slice(0, 90)}`);
  if (!ok) console.log((r.stdout + r.stderr).trim().split('\n').slice(-12).map(l => '      ' + l).join('\n'));
}
console.log(`\n${picked.length - failed}/${picked.length} suites passed (${total} individual tests counted from the suites' summaries) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
