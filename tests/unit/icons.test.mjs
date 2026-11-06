// Run: node tests/unit/icons.test.mjs   (from the project root)
// Every icon the source names literally must exist in assets/js/icons.js. Regenerate with `node scripts/build-icons.mjs`.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ICONS } from '../../assets/js/icons.js';
import { TOOLS, CATEGORIES } from '../../assets/js/registry.js';

const test = (name, fn) => { try { fn(); } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const SKIP = new Set(['node_modules', '.git', 'vendor', 'excel-editor', 'word-editor', 'tests', 'docs', 'scripts']);
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { if (SKIP.has(f)) continue; const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|html)$/.test(f) && f !== 'icons.js') files.push(p); } })('.');

test('registry and category icons exist', () => {
  for (const x of [...TOOLS, ...CATEGORIES]) if (!x.standalone || x.icon) assert.ok(ICONS[x.icon], `missing icon "${x.icon}" (${x.id})`);
});
test('literal icon names in the source exist', () => {
  const missing = new Set();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/data-lucide="([a-z0-9-]+)"|\bicon\(\s*['"`]([a-z0-9-]+)['"`]/g)) { const n = m[1] || m[2]; if (!ICONS[n]) missing.add(`${n} (${f})`); }
  assert.deepEqual([...missing], []);
});
test('icons are well-formed SVG fragments', () => {
  for (const [n, s] of Object.entries(ICONS)) assert.ok(/^(<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/>)+$/.test(s), n);
});
test('icon sprite stays small', () => assert.ok(readFileSync('assets/js/icons.js', 'utf8').length < 60000));
