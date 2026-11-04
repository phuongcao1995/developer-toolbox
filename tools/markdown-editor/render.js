// Markdown rendering shared by markdown-editor and markdown-viewer (uses the DOM + lazily loaded CDN libs).
import { loadScript, loadStyle } from '../../assets/js/components/ui.js';
import { makeSlugger } from './logic.js';

export { hasMermaid, renderMermaidBlocks, mermaidForExport, sanitizeSvg } from './mermaid.js';

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

const FORBID_TAGS = ['style', 'form', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'base'];
export const ID_PREFIX = 'user-content-';
const HEADINGS = 'h1,h2,h3,h4,h5,h6';

/**
 * Build a dedicated DOMPurify instance (so hooks never leak into other users of window.DOMPurify).
 * - <input> survives only as a disabled task-list checkbox inside <li>, with no other attributes.
 * - user-supplied id/name are prefixed, so they can never clobber heading ids or document/form properties.
 * - links get rel="noopener noreferrer" (+ target=_blank for external ones).
 */
export function createPurifier(DOMPurify) {
  const purify = typeof DOMPurify === 'function' ? DOMPurify(globalThis.window ?? globalThis) : DOMPurify;
  purify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeType !== 1) return;
    if (node.localName === 'input') {
      const ok = node.getAttribute('type')?.toLowerCase() === 'checkbox' && node.hasAttribute('disabled') && node.parentNode?.localName === 'li';
      if (!ok) { node.remove(); return; }
      const keepChecked = node.hasAttribute('checked');
      [...node.attributes].forEach(a => node.removeAttribute(a.name));
      node.setAttribute('type', 'checkbox'); node.setAttribute('disabled', '');
      if (keepChecked) node.setAttribute('checked', '');
      return;
    }
    for (const attr of ['id', 'name']) {
      const v = node.getAttribute(attr);
      if (v !== null && !v.startsWith(ID_PREFIX)) node.setAttribute(attr, ID_PREFIX + v);
    }
    if (node.localName === 'a' && node.hasAttribute('href')) {
      if (node.getAttribute('href').startsWith('#')) { node.removeAttribute('target'); node.setAttribute('data-anchor', '1'); }
      else { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    }
  });
  return purify;
}

/** Sanitize rendered HTML with the hardened configuration. */
export function sanitizeHtml(purify, raw) {
  return purify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'form'],
    SANITIZE_NAMED_PROPS: true,
  });
}

let purifier = null;

/** Convert Markdown to SANITIZED html. Links: external -> new tab, "#anchor" -> data-anchor (handled by the page). Remote images stay allowed. */
export function renderMarkdown(md) {
  const raw = window.marked.parse(String(md ?? ''), { gfm: true, breaks: false });
  purifier ??= createPurifier(window.DOMPurify);
  return sanitizeHtml(purifier, raw);
}

/** Give headings unique ids and return the table of contents [{id, level, text}]. */
export function addHeadingIds(container) {
  const slug = makeSlugger(), toc = [];
  container.querySelectorAll(HEADINGS).forEach(h => {
    const text = h.textContent.trim();
    h.id = slug(text);
    toc.push({ id: h.id, level: +h.tagName[1], text });
  });
  return toc;
}

/**
 * Syntax-highlight fenced code blocks with highlight.js. Only languages hljs knows are highlighted; unknown or missing
 * languages (and mermaid blocks) stay plain text. Used for BOTH the live preview and the exported HTML.
 */
export function highlightCode(container) {
  const hljs = window.hljs;
  if (!hljs) return;
  container.querySelectorAll('pre code[class*="language-"]').forEach(code => {
    if (code.dataset.highlighted) return;
    const lang = /language-([\w+#-]+)/.exec(code.className)?.[1]?.toLowerCase();
    if (lang && lang !== 'mermaid' && hljs.getLanguage(lang)) { try { hljs.highlightElement(code); } catch { /* ignore: stays plain */ } }
  });
}

/**
 * Print only `selector` (scoped, no global CSS): injects a <style media="print"> that hides everything else, calls
 * window.print() and removes the style again after printing. Returns a disposer (also removes the style on unmount).
 */
export function printScoped(selector, onDone, extraCss = '') {
  const style = document.createElement('style');
  style.media = 'print';
  style.textContent = `html,body{height:auto!important;overflow:visible!important;background:#fff!important}
body *{visibility:hidden!important}
${selector},${selector} *{visibility:visible!important}
${selector}{position:absolute!important;left:0;top:0;width:100%!important;height:auto!important;max-height:none!important;overflow:visible!important;border:0!important;padding:0!important;color:#000;background:#fff}
${selector} pre{white-space:pre-wrap!important;word-break:break-word}
${selector} pre,${selector} figure,${selector} table,${selector} img{break-inside:avoid}
${extraCss}`;
  document.head.append(style);
  let done = false;
  const finish = () => { if (done) return; done = true; window.removeEventListener('afterprint', finish); style.remove(); onDone?.(); };
  window.addEventListener('afterprint', finish);
  // Some browsers do not fire afterprint reliably; print() blocks in most, so also finish when it returns.
  setTimeout(() => { try { window.print(); } finally { setTimeout(finish, 1000); } }, 50);
  return finish;
}

/** Only headings whose id was generated by addHeadingIds are valid anchor targets (user ids are prefixed/ignored). */
export function findHeading(container, id) {
  return [...container.querySelectorAll(HEADINGS)].find(n => n.id === id) || null;
}

/** Make "#anchor" links scroll inside the page instead of changing location.hash (hash routing!). */
export function handleAnchorClicks(container) {
  const onClick = e => {
    const a = e.target.closest('a[data-anchor]');
    if (!a || !container.contains(a)) return;
    e.preventDefault();
    let id = a.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    findHeading(container, id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  container.addEventListener('click', onClick);
  return () => container.removeEventListener('click', onClick);
}

/** Keep the highlight.js stylesheet in sync with the app theme. Returns a disposer. */
export function syncHighlightTheme() {
  const had = [CDN.light, CDN.dark].map(h => !!document.querySelector(`link[href="${h}"]`));
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
  // Remove the stylesheets this call added so they do not leak after the tool is unmounted.
  return () => {
    mo.disconnect();
    [CDN.light, CDN.dark].forEach((h, i) => { if (!had[i]) document.querySelector(`link[href="${h}"]`)?.remove(); });
  };
}
