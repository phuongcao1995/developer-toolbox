// Lazy Mermaid support for fenced ```mermaid blocks (shared by markdown-editor and markdown-viewer via render.js).
// The library is only loaded when a mermaid block is present in the rendered document.
import { loadScript } from '../../assets/js/components/ui.js';

// Pinned version. No SRI hash: it cannot be computed offline, so integrity relies on the exact version pin
// (jsDelivr serves immutable files for a pinned version). TODO: add the integrity hash once it can be generated.
export const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
const SELECTOR = 'pre > code.language-mermaid';
const CACHE_MAX = 60;

const cache = new Map(); // `${theme}\0${source}` -> sanitized svg string
let seq = 0, initTheme = null, scratch = null;

export const hasMermaid = container => !!container.querySelector(SELECTOR);
export const isDarkTheme = () => {
  const theme = document.documentElement.dataset.theme;
  return theme === 'dark' || (theme !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
};

/**
 * Sanitize Mermaid's SVG output with DOMPurify's SVG profile, then neutralise anything in <style> that could fetch
 * resources or escape the diagram. `DOMPurify` is the global (function) or an instance; a fresh instance is used so no
 * other hooks apply. Returns '' when nothing safe is left.
 */
export function sanitizeSvg(DOMPurify, svg) {
  const purify = typeof DOMPurify === 'function' ? DOMPurify(globalThis.window ?? globalThis) : DOMPurify;
  const clean = purify.sanitize(String(svg ?? ''), {
    USE_PROFILES: { svg: true, svgFilters: true },
    // No SANITIZE_NAMED_PROPS here: it would prefix ids and break the diagram's own url(#marker) / #id style references.
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'a'],
  });
  if (!clean) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('style').forEach(st => {
    st.textContent = st.textContent.replace(/@import[^;]*;?/gi, '').replace(/url\((?!\s*['"]?#)[^)]*\)/gi, 'none').replace(/expression\([^)]*\)/gi, '');
  });
  // Diagrams never need external resources: drop <image> and any non-fragment href.
  tpl.content.querySelectorAll('image').forEach(n => n.remove());
  tpl.content.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) if (/(^|:)href$/i.test(a.name) && !a.value.trim().startsWith('#')) n.removeAttribute(a.name);
  });
  return tpl.innerHTML;
}

async function loadMermaid() {
  await loadScript(MERMAID_SRC);
  if (!window.mermaid?.render) throw new Error('Mermaid loaded but is unavailable.');
  return window.mermaid;
}

function init(mermaid, theme) {
  if (initTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict', // no click handlers / raw HTML in labels
    theme: theme === 'dark' ? 'dark' : 'default',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  });
  initTheme = theme;
}

const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function sourceDetails(src) {
  const d = mk('details', 'md-mermaid-src');
  d.append(mk('summary', '', 'Diagram source'));
  const pre = mk('pre'), code = mk('code', 'language-mermaid', src);
  pre.append(code); d.append(pre);
  return d;
}

/**
 * Render every ```mermaid block inside `container` to an inline SVG. Failures are per diagram: an inline error box is
 * shown above the untouched source. If Mermaid cannot be loaded (offline) a single message is shown and the code blocks stay.
 * `isStale()` aborts quietly when a newer render superseded this one. Resolves { rendered, failed, unavailable }.
 */
export async function renderMermaidBlocks(container, { isStale = () => false } = {}) {
  const blocks = [...container.querySelectorAll(SELECTOR)];
  const result = { rendered: 0, failed: 0, unavailable: false };
  if (!blocks.length) return result;

  let mermaid;
  try { mermaid = await loadMermaid(); }
  catch (e) {
    result.unavailable = true;
    if (!isStale()) {
      const first = blocks[0].parentNode;
      const box = mk('div', 'alert alert-warn md-mermaid-note', `Diagrams could not be rendered because Mermaid could not be loaded (${e.message}). The diagram source is shown as code.`);
      box.setAttribute('role', 'status');
      first.parentNode?.insertBefore(box, first);
    }
    return result;
  }
  const theme = isDarkTheme() ? 'dark' : 'default';
  init(mermaid, theme);
  // Sandbox: Mermaid measures text in a hidden, isolated container instead of the document body.
  if (!scratch || !scratch.isConnected) {
    scratch = mk('div'); scratch.setAttribute('aria-hidden', 'true');
    scratch.style.cssText = 'position:absolute;left:-10000px;top:0;width:1200px;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    document.body.append(scratch);
  }

  for (const code of blocks) {
    if (isStale()) return result;
    const pre = code.parentNode;
    if (!pre?.isConnected) continue;
    const src = code.textContent;
    const key = `${theme}\0${src}`;
    let svg = cache.get(key), err = null;
    if (svg === undefined) {
      const id = `mmd-${++seq}`;
      try {
        const out = await mermaid.render(id, src, scratch);
        svg = sanitizeSvg(window.DOMPurify, out.svg);
        if (!svg) throw new Error('The diagram produced no safe output.');
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, svg);
      } catch (e) {
        err = e;
        svg = null;
        document.getElementById(id)?.remove(); document.getElementById(`d${id}`)?.remove(); // leftovers from a failed render
      }
    }
    if (isStale() || !pre.isConnected) return result;
    if (svg) {
      const fig = mk('figure', 'md-mermaid');
      fig.setAttribute('role', 'img'); fig.setAttribute('aria-label', 'Mermaid diagram');
      const holder = mk('div', 'md-mermaid-svg'); holder.innerHTML = svg;
      fig.append(holder, sourceDetails(src));
      pre.replaceWith(fig);
      result.rendered++;
    } else {
      const box = mk('div', 'md-mermaid md-mermaid-error');
      const msg = mk('div', 'alert alert-error', `Diagram error: ${String(err?.message ?? err ?? 'unknown error').split('\n')[0].slice(0, 300)}`);
      msg.setAttribute('role', 'alert');
      pre.parentNode.insertBefore(box, pre);
      box.append(msg, pre); // original source stays visible
      result.failed++;
    }
  }
  return result;
}

/** Prepare a CLONE of rendered HTML for export: rendered diagrams become bare inline SVG snapshots; failed/unavailable keep their code. */
export function mermaidForExport(clone) {
  clone.querySelectorAll('figure.md-mermaid').forEach(fig => {
    fig.querySelector('details')?.remove();
    fig.removeAttribute('role');
  });
  clone.querySelectorAll('.md-mermaid-error').forEach(box => { box.querySelector('.alert')?.remove(); });
  clone.querySelectorAll('.md-mermaid-note').forEach(n => n.remove());
}
