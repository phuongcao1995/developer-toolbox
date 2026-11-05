// Application shell: sidebar, top bar, dashboard, settings, command palette, dynamic tool loader.
import { CATEGORIES, TOOLS, getTool, getCategory, searchToolsDetailed, validateRegistry } from './registry.js';
import { storage, settings } from './storage.js';
import { createRouter, hrefTo } from './router.js';
import * as ui from './components/ui.js';

const { $, $$, el, escapeHtml, renderIcons, icon } = ui;
const main = $('#main');
const RECENT_MAX = 10;

// ---------- State (persisted) ----------
const favorites = {
  list: () => storage.get('favorites', []).filter(id => getTool(id)),
  has: id => favorites.list().includes(id),
  toggle(id) {
    const l = favorites.list(); const i = l.indexOf(id);
    i >= 0 ? l.splice(i, 1) : l.push(id); storage.set('favorites', l); return i < 0;
  },
};
const recent = {
  list: () => storage.get('recent', []).filter(id => getTool(id)),
  push(id) { storage.set('recent', [id, ...recent.list().filter(x => x !== id)].slice(0, RECENT_MAX)); },
};
/** Usage statistics: { [toolId]: { count, last } }. Stored locally only. */
const usage = {
  all() {
    const raw = storage.get('usage', {}) || {}, out = {};
    for (const [id, v] of Object.entries(raw)) if (getTool(id) && Number.isFinite(v?.count)) out[id] = { count: Math.max(0, v.count | 0), last: Number(v.last) || 0 };
    return out;
  },
  hit(id) { const u = usage.all(); u[id] = { count: (u[id]?.count || 0) + 1, last: Date.now() }; storage.set('usage', u); },
  /** Tools ordered by open count (ties: most recent first). */
  top(n = 6) {
    return Object.entries(usage.all()).sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last).slice(0, n).map(([id]) => getTool(id));
  },
  totals() { const v = Object.values(usage.all()); return { opens: v.reduce((n, x) => n + x.count, 0), tools: v.filter(x => x.count > 0).length }; },
};
/** Quick-access list used by Alt+1…9: favorites first, then most used, de-duplicated. */
const quickAccess = (n = 9) => [...new Set([...favorites.list(), ...usage.top(n).map(t => t.id)])].slice(0, n).map(getTool);

/** Wrap matched [start,end) ranges of `text` in <mark>; returns a node list (safe: built with text nodes). */
function highlight(text, ranges = []) {
  if (!ranges.length) return [text];
  const out = []; let pos = 0;
  for (const [a, b] of ranges) { if (a > pos) out.push(text.slice(pos, a)); out.push(el('mark', {}, text.slice(a, b))); pos = b; }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

// ---------- Theme & settings ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  if (btn) { btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon'); btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'; renderIcons(btn); }
}
const currentTheme = () => settings.get().theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function applySettings() {
  const s = settings.get();
  document.documentElement.style.setProperty('--editor-font-size', `${s.fontSize}px`);
  applyTheme(currentTheme());
}

// ---------- Tool cards ----------
// Standalone tools (own page, own UI) open in a new tab; everything else is a hash route inside the shell.
const toolLinkAttrs = tool => tool.standalone ? { href: tool.href, target: '_blank', rel: 'noopener' } : { href: hrefTo('tool', tool.id) };
function toolCard(tool, ranges = [], badge = '') {
  const fav = favorites.has(tool.id);
  const cat = getCategory(tool.category);
  const card = el('a', { class: 'tool-card', ...toolLinkAttrs(tool) },
    el('div', { class: 'tool-card-icon', html: icon(tool.icon) }),
    el('div', { class: 'tool-card-body' },
      el('div', { class: 'tool-card-title' }, highlight(tool.name, ranges)),
      el('div', { class: 'tool-card-desc' }, tool.description),
      el('span', { class: 'badge' }, cat?.name || ''), badge ? el('span', { class: 'card-note' }, badge) : null),
    el('button', { class: `fav-btn${fav ? ' active' : ''}`, 'aria-label': fav ? 'Remove from favorites' : 'Add to favorites', 'aria-pressed': fav, title: 'Favorite',
      html: icon('star'), onclick: e => { e.preventDefault(); e.stopPropagation(); favorites.toggle(tool.id); route(router.current, true); } }));
  return card;
}
const toolGrid = (tools, badgeFor) => el('div', { class: 'tool-grid' }, tools.map(t => toolCard(t, [], badgeFor?.(t))));
const emptyState = (title, text, href, linkText) => el('div', { class: 'empty' }, el('strong', {}, title), el('p', {}, text),
  href ? el('a', { class: 'btn', href }, linkText) : null);
const section = (title, content, extra) => el('section', { class: 'section' },
  el('div', { class: 'section-head' }, el('h2', {}, title), extra || ''), content);

// ---------- Views ----------
function viewDashboard() {
  const favs = favorites.list().map(getTool), rec = recent.list().slice(0, 4).map(getTool);
  const used = usage.all(), totals = usage.totals();
  // "Most used" only appears once a tool has been opened at least twice, and never repeats the recent row.
  const frequent = usage.top(8).filter(t => used[t.id].count >= 2 && !rec.includes(t)).slice(0, 4);
  const updated = TOOLS.filter(t => t.note).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 4);
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'hero' },
    el('h1', {}, 'Welcome to Developer Toolbox'),
    el('p', {}, `${TOOLS.length} everyday developer utilities that run in your browser. Tools process your input locally; the few that use the network are listed under About.`),
    el('div', { class: 'row' },
      el('button', { class: 'hero-search', onclick: openPalette, html: `${icon('search')}<span>Search tools…</span><kbd>Ctrl K</kbd>` }),
      el('button', { class: 'btn btn-ghost', onclick: openShortcuts, html: `${icon('keyboard')}<span>Shortcuts</span><kbd>?</kbd>` }))));
  if (totals.opens) {
    const topTool = usage.top(1)[0];
    frag.append(el('p', { class: 'usage-line' }, `${totals.opens} ${totals.opens === 1 ? 'open' : 'opens'} across ${totals.tools} ${totals.tools === 1 ? 'tool' : 'tools'}`,
      topTool ? [' · most used: ', el('a', { href: hrefTo('tool', topTool.id) }, topTool.name)] : ''));
  }
  if (favs.length) frag.append(section('Favorites', toolGrid(favs)));
  if (rec.length) frag.append(section('Recently used', toolGrid(rec), el('a', { href: hrefTo('recent'), class: 'link' }, 'View all')));
  if (frequent.length) frag.append(section('Most used', toolGrid(frequent, t => `${used[t.id].count} opens`)));
  if (!favs.length && !rec.length) {
    const starters = ['json-formatter', 'jwt-decoder', 'regex-tester', 'diff-checker'].map(getTool).filter(Boolean);
    frag.append(section('Good places to start', toolGrid(starters), el('span', { class: 'hint' }, 'Star a tool to pin it here.')));
  }
  if (updated.length) frag.append(section('Recently updated', toolGrid(updated, t => `${t.updated}: ${t.note}`)));
  frag.append(section('Browse by category', el('div', { class: 'cat-grid' }, CATEGORIES.map(c => {
    const n = TOOLS.filter(t => t.category === c.id).length;
    return el('a', { class: 'cat-card', href: hrefTo('category', c.id) }, el('span', { html: icon(c.icon) }), el('div', {}, el('strong', {}, c.name), el('small', {}, `${n} tools`)));
  }))));
  return { title: 'Dashboard', node: frag };
}

function viewCatalog({ category = null, ids = null, title, empty }) {
  const wrap = el('div');
  const input = el('input', { class: 'input', type: 'search', placeholder: 'Filter tools…', 'aria-label': 'Filter tools' });
  const chips = el('div', { class: 'chips' });
  let activeCat = category;
  const results = el('div');
  const draw = () => {
    chips.replaceChildren(...[{ id: null, name: 'All' }, ...CATEGORIES].map(c =>
      el('button', { class: `chip${activeCat === c.id ? ' active' : ''}`, 'aria-pressed': activeCat === c.id, onclick: () => { activeCat = c.id; draw(); } }, c.name)));
    let list = searchToolsDetailed(input.value, activeCat);
    if (ids) list = list.filter(r => ids.includes(r.tool.id));
    results.replaceChildren(list.length
      ? el('div', { class: 'tool-grid' }, list.map(r => toolCard(r.tool, r.ranges)))
      : emptyState(empty || 'No tools match', 'Try a different search or category.'));
    count.textContent = input.value ? `${list.length} ${list.length === 1 ? 'tool' : 'tools'} found` : '';
    renderIcons(results);
  };
  const count = el('span', { class: 'sr-only', role: 'status' });
  input.addEventListener('input', ui.debounce(draw, 100));
  wrap.append(el('div', { class: 'toolbar' }, input, count), chips, results);
  draw();
  return { title, node: wrap };
}

function viewSettings() {
  const s = settings.get();
  const wrap = el('div', { class: 'settings card' });
  wrap.innerHTML = `
    <div class="field"><label for="set-theme">Theme</label>
      <select id="set-theme" class="select"><option value="light">Light</option><option value="dark">Dark</option></select></div>
    <div class="field"><label for="set-font">Default editor font size (px)</label>
      <input id="set-font" class="input" type="number" min="10" max="24" value="${s.fontSize}"></div>
    <div class="field"><label for="set-indent">Default indentation</label>
      <select id="set-indent" class="select"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tab</option></select></div>
    <div class="row">
      <button class="btn" id="clear-history">${icon('history')} Clear history &amp; favorites</button>
      <button class="btn btn-danger" id="reset-prefs">${icon('rotate-ccw')} Reset all preferences</button>
    </div>
    <p class="hint">Tools read the indentation and font size when they open. Changes apply the next time you open a tool.</p>`;
  $('#set-theme', wrap).value = currentTheme();
  $('#set-indent', wrap).value = s.indent;
  $('#set-theme', wrap).onchange = e => { settings.set({ theme: e.target.value }); };
  $('#set-font', wrap).onchange = e => { const v = Math.min(24, Math.max(10, Number(e.target.value) || 13)); e.target.value = v; settings.set({ fontSize: v }); };
  $('#set-indent', wrap).onchange = e => settings.set({ indent: e.target.value });
  $('#clear-history', wrap).onclick = async () => {
    if (await ui.confirmDialog('Clear history', 'Remove recently used tools, favorites, and saved tool history (API requests, webhooks)?', 'Clear')) {
      storage.clear(['recent', 'favorites', 'usage', 'tool:']); ui.toast('History cleared', 'success'); renderSidebarCounts();
    }
  };
  $('#reset-prefs', wrap).onclick = async () => {
    if (await ui.confirmDialog('Reset preferences', 'Reset theme, font size and indentation to defaults?', 'Reset')) {
      settings.reset(); ui.toast('Preferences reset', 'success'); route(router.current, true);
    }
  };
  return { title: 'Settings', node: wrap };
}

function viewAbout() {
  const wrap = el('div', { class: 'card prose' });
  wrap.innerHTML = `<p><strong>Developer Toolbox</strong> is a static, framework-free collection of ${TOOLS.length} developer utilities
    built with HTML, CSS and vanilla ES modules. Each tool lives in its own folder under <code>tools/</code> and is loaded on demand.</p>
    <h3>Privacy</h3><p>All processing happens locally in your browser. Only the API Client (requests you send), and optional CDN libraries
    (Lucide icons, Prettier, Markdown renderer, syntax highlighter) use the network.</p>
    <h3>Usage statistics</h3><p>Open counts and recently used tools are kept only in this browser’s local storage and can be removed in Settings → Clear history.</p>
    <h3>Shortcuts</h3><p>Press <kbd>?</kbd> for the full list. <kbd>Ctrl</kbd>+<kbd>K</kbd> opens global search.</p>`;
  return { title: 'About', node: wrap };
}

// ---------- Tool loader ----------
let disposeTool = null;
async function viewTool(id, rerender = false) {
  const tool = getTool(id);
  if (!tool) return { title: 'Not found', node: emptyState('Tool not found', `There is no tool called “${id}”.`, hrefTo('tools'), 'Browse all tools') };
  if (!rerender) { recent.push(id); usage.hit(id); } // count real navigations only, not re-renders
  const fav = favorites.has(id);
  const page = el('div', { class: 'tool-page' });
  const head = el('div', { class: 'tool-head' },
    el('div', { class: 'tool-head-icon', html: icon(tool.icon) }),
    el('div', { class: 'tool-head-text' }, el('h1', {}, tool.name), el('p', {}, tool.description)),
    el('button', { class: `btn fav-toggle${fav ? ' active' : ''}`, 'aria-pressed': fav,
      html: `${icon('star')}<span>${fav ? 'Favorited' : 'Favorite'}</span>`,
      onclick: e => { const on = favorites.toggle(id); const b = e.currentTarget;
        b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); b.querySelector('span').textContent = on ? 'Favorited' : 'Favorite'; renderSidebarCounts(); } }));
  if (tool.standalone) {
    page.append(head, el('div', { class: 'panel' }, el('div', { class: 'panel-body stack' },
      el('p', {}, `${tool.name} is a standalone app with its own interface. It opens in its own tab, runs entirely in your browser and does not upload your files.`),
      el('div', { class: 'row' }, el('a', { class: 'btn btn-primary', href: tool.href, target: '_blank', rel: 'noopener', html: `${icon('external-link')}<span>Open ${escapeHtml(tool.name)}</span>` })))));
    return { title: tool.name, node: page };
  }
  const root = el('div', { class: `tool-root tool-${id}` }, el('div', { class: 'loading-block' }, el('span', { class: 'spinner' }), 'Loading tool…'));
  page.append(head, root);
  // Mount asynchronously so the shell paints first.
  queueMicrotask(() => mountTool(tool, root));
  return { title: tool.name, node: page, noWrap: true };
}

/** Per-mount lifecycle: abort signal, registered cleanups, and auto-cancelled debounces. */
function createLifecycle() {
  const controller = new AbortController(), cleanups = [], debounces = [];
  let done = false;
  return {
    controller, debounces,
    onCleanup: fn => { if (typeof fn === 'function') cleanups.push(fn); },
    dispose() {
      if (done) return; done = true;
      controller.abort();
      debounces.forEach(d => d.cancel());
      for (const fn of cleanups.reverse()) { try { fn(); } catch (e) { console.error('Tool cleanup failed', e); } }
    },
  };
}

/**
 * Load a tool's stylesheet once. This is deliberately a module-level function: the <link> element lives in <head>
 * for the rest of the session, and its onload/onerror handlers must not capture any per-mount state (the mount's
 * lifecycle object holds the tool's cleanup closures, which reference the tool's DOM). Handlers are also cleared
 * after the load so nothing stays attached to the element.
 */
const cssLoads = new Map();
function loadToolCss(href) {
  if (!cssLoads.has(href)) {
    cssLoads.set(href, new Promise(resolve => {
      const link = el('link', { rel: 'stylesheet', href });
      const done = () => { link.onload = link.onerror = null; resolve(); };
      link.onload = link.onerror = done;
      document.head.append(link);
    }));
  }
  return cssLoads.get(href);
}

const withTimeout =(p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

async function mountTool(tool, root, attempt = 0) {
  const token = ++mountToken;
  const life = createLifecycle();
  disposeTool = () => life.dispose();
  ui.setDebounceScope(life.debounces);
  try {
    const base = `tools/${tool.id}/`;
    const [html] = await Promise.all([
      withTimeout(fetch(base + 'index.html', { signal: life.controller.signal }).then(r => { if (!r.ok) throw new Error(`${base}index.html returned HTTP ${r.status}`); return r.text(); }), 15000, 'Loading the tool'),
      loadToolCss(base + 'tool.css'),
    ]);
    // A retry bypasses a cached failed module fetch.
    const mod = await import(`../../${tool.entry}${attempt ? `?retry=${attempt}` : ''}`);
    if (token !== mountToken) return life.dispose(); // navigated away while loading
    root.innerHTML = html;
    const s = settings.get();
    const ctx = {
      toolId: tool.id, meta: tool, ui, settings, storage: scopedStorage(tool.id),
      indentUnit: settings.indentUnit(), fontSize: s.fontSize,
      signal: life.controller.signal, onCleanup: life.onCleanup, debounce: ui.debounce,
    };
    const mount = mod.default?.mount ?? mod.mount;
    if (typeof mount !== 'function') throw new Error('The tool module does not export mount(root, ctx)');
    const cleanup = await mount(root, ctx);
    life.onCleanup(cleanup); // tools may still simply return a cleanup function
    if (token !== mountToken) return life.dispose();
    renderIcons(root);
  } catch (err) {
    life.dispose();
    if (err?.name === 'AbortError' && token !== mountToken) return;
    console.error(err);
    if (token === mountToken) {
      root.replaceChildren(el('div', { class: 'alert alert-error', role: 'alert' },
        el('strong', {}, `Could not load “${tool.name}”.`), el('p', {}, err.message),
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: () => { root.replaceChildren(el('div', { class: 'loading-block' }, el('span', { class: 'spinner' }), 'Loading tool…')); mountTool(tool, root, attempt + 1); } }, 'Retry'),
          el('a', { class: 'btn', href: hrefTo('tools') }, 'Browse all tools'))));
    }
  }
}
let mountToken = 0;
/** Per-tool storage namespace so “Clear history” can wipe it (keys start with tool:). */
const scopedStorage = id => ({
  get: (k, f) => storage.get(`tool:${id}:${k}`, f),
  set: (k, v) => storage.set(`tool:${id}:${k}`, v),
  remove: k => storage.remove(`tool:${id}:${k}`),
});

// ---------- Routing / rendering ----------
let firstRoute = true;
/** Tell screen readers the page changed and move focus to <main> (not on the initial load). */
function announceRoute(title, initial) {
  const live = $('#route-announcer');
  if (live) live.textContent = `${title}`;
  if (!initial) main.focus({ preventScroll: true });
}
async function route(r = router.current, rerender = false) {
  if (rerender !== true) rerender = false; // the router passes the parsed hash only
  router.current = r;
  mountToken++; // invalidate in-flight tool loads
  try { disposeTool?.(); } catch (e) { console.error(e); }
  disposeTool = null;
  ui.setDebounceScope(null);
  let view;
  switch (r.name) {
    case 'dashboard': view = viewDashboard(); break;
    case 'tools': view = viewCatalog({ title: 'All Tools' }); break;
    case 'favorites': view = viewCatalog({ title: 'Favorites', ids: favorites.list(), empty: 'No favorites yet' }); break;
    case 'recent': view = viewCatalog({ title: 'Recently Used', ids: recent.list(), empty: 'No recently used tools' }); break;
    case 'category': { const c = getCategory(r.param); view = c ? viewCatalog({ title: c.name, category: c.id }) : viewCatalog({ title: 'All Tools' }); break; }
    case 'settings': view = viewSettings(); break;
    case 'about': view = viewAbout(); break;
    case 'tool': view = await viewTool(r.param, rerender); break;
    default: view = { title: 'Not found', node: emptyState('Page not found', 'That route does not exist.') };
  }
  main.replaceChildren();
  if (view.noWrap) main.append(view.node);
  else { main.append(el('div', { class: 'page-head' }, el('h1', {}, view.title === 'Dashboard' ? '' : view.title)), view.node); if (view.title === 'Dashboard') $('.page-head', main).remove(); }
  renderIcons(main);
  document.title = `${view.title} · Developer Toolbox`;
  main.scrollTop = 0; window.scrollTo(0, 0);
  if (!rerender) announceRoute(view.title, firstRoute);
  firstRoute = false;
  highlightNav(r); renderSidebarCounts(); closeSidebar();
}

// ---------- Sidebar ----------
const NAV = [
  { name: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
  { name: 'tools', label: 'All Tools', icon: 'grid-2x2' },
  { name: 'favorites', label: 'Favorites', icon: 'star', count: () => favorites.list().length },
  { name: 'recent', label: 'Recently Used', icon: 'history', count: () => recent.list().length },
];
function buildSidebar() {
  const nav = $('#nav');
  const link = (n, href, label, ic, count) => `<a class="nav-link" data-nav="${n}" href="${href}" title="${escapeHtml(label)}">${icon(ic)}<span>${escapeHtml(label)}</span>${count ? `<em class="count" data-count="${n}"></em>` : ''}</a>`;
  nav.innerHTML =
    NAV.map(n => link(n.name, hrefTo(n.name), n.label, n.icon, !!n.count)).join('') +
    `<div class="nav-label">Categories</div>` +
    CATEGORIES.map(c => link('category/' + c.id, hrefTo('category', c.id), c.name, c.icon)).join('') +
    `<div class="nav-label">App</div>` +
    link('settings', hrefTo('settings'), 'Settings', 'settings') + link('about', hrefTo('about'), 'About', 'info');
  renderIcons(nav);
}
function highlightNav(r) {
  const key = r.name === 'category' ? `category/${r.param}` : r.name;
  const toolCat = r.name === 'tool' ? `category/${getTool(r.param)?.category}` : null;
  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.nav === key || (toolCat && a.dataset.nav === toolCat)));
}
function renderSidebarCounts() {
  NAV.filter(n => n.count).forEach(n => { const e = $(`[data-count="${n.name}"]`); if (e) { const c = n.count(); e.textContent = c || ''; } });
}
const closeSidebar = () => document.body.classList.remove('sidebar-open');

// ---------- Command palette (Ctrl+K) ----------
let palette = null;
function openPalette() {
  if (palette) { $('input', palette.modal)?.focus(); return; }
  let cat = null, idx = 0, items = [];
  const listId = 'palette-list';
  const input = el('input', {
    class: 'input palette-input', type: 'search', placeholder: 'Search by name, description, keyword or category…', 'aria-label': 'Search tools',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' });
  const chips = el('div', { class: 'chips' });
  const list = el('div', { class: 'palette-list', role: 'listbox', id: listId, 'aria-label': 'Matching tools' });
  const status = el('div', { class: 'sr-only', role: 'status' });
  const footer = el('div', { class: 'palette-foot', html: '<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>' });

  /** Empty query: suggest favorites and recent tools first, then everything else. */
  const suggestions = () => {
    const first = [...new Set([...recent.list(), ...favorites.list()])];
    const rest = TOOLS.map(t => t.id).filter(id => !first.includes(id));
    return [...first, ...rest].map(getTool).filter(t => !cat || t.category === cat).map(tool => ({ tool, ranges: [], tag: first.includes(tool.id) ? (favorites.has(tool.id) ? 'Favorite' : 'Recent') : '' }));
  };
  const setActive = i => {
    idx = Math.max(0, Math.min(i, items.length - 1));
    [...list.querySelectorAll('[role=option]')].forEach((n, k) => { const on = k === idx; n.classList.toggle('active', on); n.setAttribute('aria-selected', on); if (on) { input.setAttribute('aria-activedescendant', n.id); n.scrollIntoView?.({ block: 'nearest' }); } });
  };
  const draw = () => {
    chips.replaceChildren(...[{ id: null, name: 'All' }, ...CATEGORIES].map(c => el('button', { class: `chip${cat === c.id ? ' active' : ''}`, 'aria-pressed': cat === c.id, tabindex: '-1',
      onclick: () => { cat = c.id; idx = 0; draw(); input.focus(); } }, c.name)));
    const q = input.value.trim();
    items = q ? searchToolsDetailed(q, cat) : suggestions();
    list.replaceChildren(...(items.length ? items.map((r, i) => el('a', { class: 'palette-item', id: `palette-opt-${i}`, ...toolLinkAttrs(r.tool), role: 'option', 'aria-selected': 'false', tabindex: '-1',
      onclick: () => palette?.close(), onmousemove: () => { if (idx !== i) setActive(i); } },
      el('span', { html: icon(r.tool.icon) }),
      el('div', { class: 'palette-text' }, el('strong', {}, highlight(r.tool.name, r.ranges)), el('small', {}, r.tool.description)),
      r.tag ? el('span', { class: 'badge' }, r.tag) : null))
      : [el('div', { class: 'empty' }, el('strong', {}, `No tools match “${q}”`), el('p', {}, 'Check the spelling, try a keyword like “json” or “url”, or clear the category filter.'))]));
    status.textContent = items.length ? `${items.length} ${items.length === 1 ? 'tool' : 'tools'} available` : 'No matching tools';
    renderIcons(list); setActive(idx);
  };
  const open = i => { const r = items[i]; if (!r) return; palette.close(); router.go('tool', r.tool.id); };
  input.addEventListener('input', ui.debounce(() => { idx = 0; draw(); }, 60));
  input.addEventListener('keydown', e => {
    const page = 6;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(idx + 1 >= items.length ? 0 : idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(idx - 1 < 0 ? items.length - 1 : idx - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(idx + page); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(idx - page); }
    else if (e.key === 'Home' && !input.value) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !input.value) { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); open(idx); }
  });
  palette = ui.openModal({ title: 'Search tools', body: el('div', {}, input, chips, list, status, footer), onClose: () => { palette = null; } });
  palette.modal.classList.add('palette');
  draw(); input.focus();
}

// ---------- Keyboard shortcuts ----------
const SHORTCUTS = [
  { keys: ['Ctrl', 'K'], text: 'Open global search (⌘K on macOS)' },
  { keys: ['/'], text: 'Open global search' },
  { keys: ['?'], text: 'Show this help' },
  { keys: ['g', 'd'], text: 'Go to Dashboard' },
  { keys: ['g', 't'], text: 'Go to All Tools' },
  { keys: ['g', 'f'], text: 'Go to Favorites' },
  { keys: ['g', 'r'], text: 'Go to Recently Used' },
  { keys: ['g', 's'], text: 'Go to Settings' },
  { keys: ['Alt', '1…9'], text: 'Open quick-access tool 1–9 (favorites first, then most used)' },
  { keys: ['↑', '↓', 'Enter'], text: 'Navigate and open results in search' },
  { keys: ['Esc'], text: 'Close dialogs' },
];
function openShortcuts() {
  if (document.querySelector('.modal-overlay')) return;
  const quick = quickAccess();
  const rows = SHORTCUTS.map(s => el('tr', {}, el('td', {}, s.keys.map((k, i) => [i ? (s.keys[0] === 'g' ? ' then ' : ' + ') : '', el('kbd', {}, k)])), el('td', {}, s.text)));
  const body = el('div', {}, el('table', { class: 'shortcut-table' }, el('tbody', {}, rows)),
    el('h4', { class: 'shortcut-sub' }, 'Your quick access'),
    quick.length ? el('ol', { class: 'quick-list' }, quick.map(t => el('li', {}, el('a', { href: hrefTo('tool', t.id), onclick: () => dlg.close() }, t.name))))
      : el('p', { class: 'hint' }, 'Favorite a tool or use a few tools and they will appear here for Alt+1…9.'));
  const dlg = ui.openModal({ title: 'Keyboard shortcuts', body });
}

/** True while the user is typing into a field, where single-key shortcuts must not fire. */
const isTyping = t => t instanceof Element && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') != null);
let chord = null;
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (document.querySelector('.modal-overlay') || e.defaultPrevented) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
    const t = quickAccess()[Number(e.code.slice(5)) - 1];
    if (t) { e.preventDefault(); router.go('tool', t.id); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
  if (chord) {
    const dest = { d: ['dashboard'], t: ['tools'], f: ['favorites'], r: ['recent'], s: ['settings'] }[e.key.toLowerCase()];
    clearTimeout(chord); chord = null;
    if (dest) { e.preventDefault(); router.go(...dest); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  else if (e.key === '?') { e.preventDefault(); openShortcuts(); }
  else if (e.key === 'g') chord = setTimeout(() => { chord = null; }, 1200);
}

// ---------- Boot ----------
const router = createRouter(route);
function boot() {
  const problems = validateRegistry();
  if (problems.length) console.warn('Tool registry problems:\n' + problems.join('\n'));
  applySettings();
  settings.onChange(applySettings);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!settings.get().theme) applyTheme(currentTheme()); });
  buildSidebar();
  $('#theme-toggle').addEventListener('click', () => settings.set({ theme: currentTheme() === 'dark' ? 'light' : 'dark' }));
  $('#open-search').addEventListener('click', openPalette);
  $('#open-shortcuts')?.addEventListener('click', openShortcuts);
  // Desktop: collapse to an icon rail (remembered). Narrow screens: open/close the drawer.
  const COLLAPSE_KEY = 'sidebar-collapsed', narrow = () => matchMedia('(max-width: 860px)').matches;
  const setCollapsed = on => {
    document.body.classList.toggle('sidebar-collapsed', on);
    const t = $('#menu-toggle'); t.setAttribute('aria-expanded', String(!on));
    t.title = on ? 'Expand sidebar' : 'Collapse sidebar';
  };
  setCollapsed(storage.get(COLLAPSE_KEY, false) === true);
  $('#menu-toggle').addEventListener('click', () => {
    if (narrow()) { document.body.classList.toggle('sidebar-open'); return; }
    const on = !document.body.classList.contains('sidebar-collapsed');
    setCollapsed(on); storage.set(COLLAPSE_KEY, on);
  });
  $('#scrim').addEventListener('click', closeSidebar);
  $('#open-settings').addEventListener('click', () => router.go('settings'));
  document.addEventListener('keydown', onGlobalKey);
  router.start();
  // Lucide loads async from CDN; refresh icons once it is ready.
  window.addEventListener('load', () => renderIcons());
}
boot();
