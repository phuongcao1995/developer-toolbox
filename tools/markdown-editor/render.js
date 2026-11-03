// Markdown rendering shared by markdown-editor and markdown-viewer (uses the DOM + lazily loaded CDN libs).
import { loadScript, loadStyle } from '../../assets/js/components/ui.js';
import { makeSlugger } from './logic.js';

const CDN = {
  marked: 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  purify: 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
  hljs: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  light: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css',
  dark: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
};

/**
 * Load marked + DOMPurify (required) and highlight.js (optional, failure only disables colouring).
 * Rejects with a readable Error if a required library is unavailable.
 */
export async function loadMarkdownLibs() {
  try { await Promise.all([loadScript(CDN.marked), loadScript(CDN.purify)]); }
  catch (e) { throw new Error(`Markdown libraries could not be loaded (${e.message}). Check your internet connection and try again.`); }
  if (!window.marked?.parse || !window.DOMPurify) throw new Error('Markdown libraries loaded but are unavailable.');
  try { await loadScript(CDN.hljs); } catch { /* optional */ }
}

/** Convert Markdown to SANITIZED html. Links: external -> new tab, "#anchor" -> data-anchor (handled by the page). */
export function renderMarkdown(md) {
  const raw = window.marked.parse(String(md ?? ''), { gfm: true, breaks: false });
  const clean = window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('a[href]').forEach(a => {
    if (a.getAttribute('href').startsWith('#')) a.dataset.anchor = '1';
    else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  tpl.content.querySelectorAll('input[type="checkbox"]').forEach(i => { i.disabled = true; });
  return tpl.innerHTML;
}

/** Give headings unique ids and return the table of contents [{id, level, text}]. */
export function addHeadingIds(container) {
  const slug = makeSlugger(), toc = [];
  container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    const text = h.textContent.trim();
    h.id = slug(text);
    toc.push({ id: h.id, level: +h.tagName[1], text });
  });
  return toc;
}

/** Syntax-highlight fenced code blocks that declare a known language. */
export function highlightCode(container) {
  const hljs = window.hljs;
  if (!hljs) return;
  container.querySelectorAll('pre code[class*="language-"]').forEach(code => {
    const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
    if (lang && hljs.getLanguage(lang)) { try { hljs.highlightElement(code); } catch { /* ignore */ } }
  });
}

/** Make "#anchor" links scroll inside the page instead of changing location.hash (hash routing!). */
export function handleAnchorClicks(container) {
  const onClick = e => {
    const a = e.target.closest('a[data-anchor]');
    if (!a || !container.contains(a)) return;
    e.preventDefault();
    let id = a.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const target = [...container.querySelectorAll('[id]')].find(n => n.id === id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  container.addEventListener('click', onClick);
  return () => container.removeEventListener('click', onClick);
}

/** Keep the highlight.js stylesheet in sync with the app theme. Returns a disposer. */
export function syncHighlightTheme() {
  loadStyle(CDN.light); loadStyle(CDN.dark);
  const links = () => ({
    light: document.querySelector(`link[href="${CDN.light}"]`),
    dark: document.querySelector(`link[href="${CDN.dark}"]`),
  });
  const apply = () => {
    const theme = document.documentElement.dataset.theme;
    const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const l = links();
    if (l.light) l.light.disabled = dark;
    if (l.dark) l.dark.disabled = !dark;
  };
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
