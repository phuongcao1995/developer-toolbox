// Mermaid SVG sanitiser + block rendering fallbacks. Needs jsdom + dompurify (see markdown-render.test.mjs):
//   DT_NODE_MODULES=<dir containing node_modules> node tests/unit/markdown-mermaid.test.mjs
// Mermaid itself is never loaded here (it comes from a CDN); the real diagram rendering is NOT covered by tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok -', name); };

const base = process.env.DT_NODE_MODULES || process.cwd();
let req;
try { req = createRequire(path.resolve(base) + path.sep + 'x.js'); req.resolve('jsdom'); req.resolve('dompurify'); }
catch { console.log('skipped DOM tests (jsdom/dompurify not found; set DT_NODE_MODULES). 0 passed'); process.exit(0); }

const { JSDOM } = req('jsdom');
const createDOMPurify = req('dompurify');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const DOMPurify = createDOMPurify(dom.window);
const { sanitizeSvg, hasMermaid, renderMermaidBlocks, mermaidForExport } = await import('../../tools/markdown-editor/mermaid.js');

await t('sanitizeSvg keeps shapes, text, markers and local url() refs', () => {
  const svg = '<svg viewBox="0 0 10 10" id="mmd-1"><style>#mmd-1 .a{fill:red}</style><defs><marker id="m"><path d="M0 0L1 1"/></marker></defs><g class="a"><rect width="5" height="5"/><text x="1" y="1">Hi</text></g><path marker-end="url(#m)" d="M0 0L5 5"/></svg>';
  const out = sanitizeSvg(DOMPurify, svg);
  assert.ok(out.includes('<rect') && out.includes('<text') && out.includes('marker-end="url(#m)"') && out.includes('id="m"') && out.includes('#mmd-1 .a'));
});
await t('sanitizeSvg strips scripts, handlers, foreignObject, links and external resources', () => {
  const svg = '<svg><script>alert(1)</script><rect onclick="alert(1)" width="1" height="1"/><foreignObject><div onmouseover="x()">hi</div></foreignObject>'
    + '<a href="javascript:alert(1)"><text>x</text></a><image href="https://evil.test/a.png"/><use href="https://evil.test/x.svg#a"/>'
    + '<style>@import url(https://evil.test/a.css);.x{background:url(https://evil.test/p.png);fill:url(#ok)}</style></svg>';
  const out = sanitizeSvg(DOMPurify, svg);
  assert.ok(!/<script|onclick|onmouseover|foreignObject|javascript:|<image|evil\.test|@import/i.test(out), out);
  assert.ok(out.includes('url(#ok)'));
});
await t('hasMermaid detects only mermaid fences', () => {
  const d = document.createElement('div');
  d.innerHTML = '<pre><code class="language-js">x</code></pre>';
  assert.equal(hasMermaid(d), false);
  d.innerHTML = '<pre><code class="language-mermaid">graph TD;A-->B</code></pre>';
  assert.equal(hasMermaid(d), true);
});
await t('no mermaid block -> nothing is loaded (no script element added)', async () => {
  const d = document.createElement('div'); d.innerHTML = '<p>hi</p>';
  const r = await renderMermaidBlocks(d);
  assert.deepEqual(r, { rendered: 0, failed: 0, unavailable: false });
  assert.equal(document.querySelectorAll('script').length, 0);
});
await t('library unavailable -> message shown and code block kept', async () => {
  const d = document.createElement('div');
  d.innerHTML = '<pre><code class="language-mermaid">graph TD;A-->B</code></pre>';
  document.body.append(d);
  // jsdom never loads external scripts; simulate a failed load by firing the error event on the injected <script>.
  const p = renderMermaidBlocks(d);
  await new Promise(r => setTimeout(r, 0));
  [...document.querySelectorAll('script')].pop().dispatchEvent(new dom.window.Event('error'));
  const r = await p;
  assert.equal(r.unavailable, true);
  assert.ok(d.querySelector('.md-mermaid-note')?.textContent.includes('Mermaid could not be loaded'));
  assert.ok(d.querySelector('pre code.language-mermaid'));
});
await t('per-diagram error box keeps the source (stubbed mermaid)', async () => {
  window.mermaid = { initialize() {}, async render(id, src) { if (src.includes('BAD')) throw new Error('Parse error on line 1'); return { svg: '<svg><rect width="1" height="1"/></svg>' }; } };
  window.DOMPurify = DOMPurify;
  const d = document.createElement('div');
  d.innerHTML = '<pre><code class="language-mermaid">graph TD;A-->B</code></pre><pre><code class="language-mermaid">BAD</code></pre>';
  document.body.append(d);
  const p = renderMermaidBlocks(d);
  await new Promise(r => setTimeout(r, 0));
  [...document.querySelectorAll('script')].pop().dispatchEvent(new dom.window.Event('load')); // simulate the CDN script loading
  const r = await p;
  assert.deepEqual([r.rendered, r.failed], [1, 1]);
  assert.ok(d.querySelector('figure.md-mermaid svg rect'));
  const err = d.querySelector('.md-mermaid-error');
  assert.ok(err.querySelector('.alert-error').textContent.includes('Parse error') && err.querySelector('pre code').textContent === 'BAD');
  // export: figure keeps only the svg, error box keeps only the code
  const clone = d.cloneNode(true); mermaidForExport(clone);
  assert.ok(clone.querySelector('figure svg') && !clone.querySelector('details') && !clone.querySelector('.alert'));
});

console.log(`${pass} passed`);
