// Sanitizer tests for tools/markdown-editor/render.js. Needs jsdom + dompurify + marked (not part of the repo):
//   DT_NODE_MODULES=<dir containing node_modules> node tests/unit/markdown-render.test.mjs
// Without those packages the DOM-dependent cases are skipped (exit 0).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { makeSlugger, buildHtmlDocument } from '../../tools/markdown-editor/logic.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok -', name); };

// pure checks
t('export document is self-contained (no external requests, dark mode, hljs colours)', () => {
  const d = buildHtmlDocument('T <x>', '<p>hi</p>');
  assert.ok(d.includes('prefers-color-scheme:dark') && d.includes('.hljs-keyword'));
  assert.ok(!/<link|src=["']http|@import|url\(http/i.test(d));
  assert.ok(d.includes('T &lt;x&gt;'));
});
t('slugger unique', () => { const s = makeSlugger(); assert.deepEqual([s('A'), s('A')], ['a', 'a-1']); });

const base = process.env.DT_NODE_MODULES || process.cwd();
let req;
try { req = createRequire(path.resolve(base) + path.sep + 'x.js'); req.resolve('jsdom'); req.resolve('dompurify'); req.resolve('marked'); }
catch { console.log(`skipped DOM tests (jsdom/dompurify/marked not found; set DT_NODE_MODULES). ${pass} passed`); process.exit(0); }

const { JSDOM } = req('jsdom');
const createDOMPurify = req('dompurify');
const { marked } = req('marked');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.matchMedia = () => ({ matches: false });
window.marked = marked; window.DOMPurify = createDOMPurify;
const { renderMarkdown, addHeadingIds, findHeading } = await import('../../tools/markdown-editor/render.js');

const el = html => { const d = document.createElement('div'); d.innerHTML = html; return d; };
t('style tag removed', () => assert.ok(!/<style/i.test(renderMarkdown('<style>body{display:none}</style>\n\nhi'))));
t('form + input removed', () => {
  const h = renderMarkdown('<form action=x><input name=a></form>');
  assert.ok(!/<form|<input/i.test(h), h);
});
t('button/textarea/select/iframe removed', () => {
  const h = renderMarkdown('<button>x</button><textarea>t</textarea><select><option>1</option></select><iframe src="https://e.x"></iframe><object data=x></object><embed src=x>');
  assert.ok(!/<(button|textarea|select|iframe|object|embed)/i.test(h), h);
});
t('style attribute removed', () => assert.ok(!/style=/.test(renderMarkdown('<p style="position:fixed">x</p>'))));
t('id/name are prefixed', () => {
  const d = el(renderMarkdown('<a id=intro name=x>link</a>'));
  const a = d.querySelector('a');
  assert.equal(a.id, 'user-content-intro'); assert.equal(a.getAttribute('name'), 'user-content-x');
});
t('user id cannot hijack heading lookup', () => {
  const d = el(renderMarkdown('<a id=intro>x</a>\n\n# Intro\n\n[go](#intro)'));
  addHeadingIds(d);
  const h = findHeading(d, 'intro');
  assert.equal(h.tagName, 'H1');
  assert.equal(findHeading(d, 'user-content-intro'), null);
  assert.equal(d.querySelector('a[data-anchor]').getAttribute('href'), '#intro');
});
t('img onerror stripped but remote image kept', () => {
  const d = el(renderMarkdown('<img src=x onerror=alert(1)>\n\n![p](https://example.com/a.png)'));
  const imgs = [...d.querySelectorAll('img')];
  assert.equal(imgs.length, 2);
  assert.ok(imgs.every(i => !i.hasAttribute('onerror')));
  assert.equal(imgs[1].getAttribute('src'), 'https://example.com/a.png');
});
t('javascript: link neutralised', () => {
  const d = el(renderMarkdown('[x](javascript:alert(1))'));
  const a = d.querySelector('a');
  assert.ok(!a || !/javascript:/i.test(a.getAttribute('href') || ''));
});
t('external links get rel + target', () => {
  const a = el(renderMarkdown('[x](https://example.com)')).querySelector('a');
  assert.equal(a.target, '_blank'); assert.ok(a.rel.includes('noopener') && a.rel.includes('noreferrer'));
});
t('task list checkboxes survive (disabled, checked state kept)', () => {
  const d = el(renderMarkdown('- [x] done\n- [ ] todo'));
  const boxes = [...d.querySelectorAll('li input')];
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every(b => b.type === 'checkbox' && b.disabled));
  assert.ok(boxes[0].checked && !boxes[1].checked);
});
t('stray checkbox outside li / enabled is removed', () => {
  assert.ok(!/<input/i.test(renderMarkdown('<input type=checkbox disabled>')));
  assert.ok(!/<input/i.test(renderMarkdown('- <input type=checkbox name=z>')));
});
console.log(`${pass} passed`);
