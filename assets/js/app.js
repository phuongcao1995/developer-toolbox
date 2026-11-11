// Application shell: sidebar, top bar, dashboard, settings, command palette, dynamic tool loader.
import { CATEGORIES, TOOLS, getTool, getCategory, searchToolsDetailed, validateRegistry } from './registry.js';
import { storage, settings } from './storage.js';
import { createRouter, hrefTo } from './router.js';
import * as ui from './components/ui.js';

const { $, $$, el, escapeHtml, renderIcons, icon } = ui;
const main = $('#main');
const RECENT_MAX = 20;

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
/**
 * One tool card. `onFav(tool)` lets a list that can redraw itself (the catalog) handle a favourite toggle in place, keeping its
 * filter, sort and scroll position; without it the current page is re-rendered. The star never triggers the card's navigation.
 */
function toolCard(tool, ranges = [], badge = '', onFav = null) {
  const fav = favorites.has(tool.id);
  const cat = getCategory(tool.category);
  const favBtn = el('button', { class: `fav-btn${fav ? ' active' : ''}`, type: 'button', 'aria-label': fav ? `Remove ${tool.name} from favorites` : `Add ${tool.name} to favorites`, 'aria-pressed': fav,
    title: fav ? 'Remove from favorites' : 'Add to favorites', html: icon('star'),
    onclick: e => { e.preventDefault(); e.stopPropagation(); favorites.toggle(tool.id); if (onFav) onFav(tool); else route(router.current, true); } });
  return el('a', { class: 'tool-card', 'data-cat': tool.category, 'data-tool': tool.id, ...toolLinkAttrs(tool) },
    el('div', { class: 'tool-card-icon', html: icon(tool.icon) }),
    el('div', { class: 'tool-card-body' },
      el('div', { class: 'tool-card-title' }, highlight(tool.name, ranges)),
      el('div', { class: 'tool-card-desc', title: tool.description }, tool.description),
      badge ? el('div', { class: 'card-note' }, badge) : null,
      el('div', { class: 'tool-card-foot' }, el('span', { class: 'badge badge-cat' }, cat?.name || ''))),
    favBtn,
    el('span', { class: 'tool-card-go', 'aria-hidden': 'true', html: icon('arrow-up-right') }));
}
const toolGrid = (tools, badgeFor) => el('div', { class: 'tool-grid' }, tools.map(t => toolCard(t, [], badgeFor?.(t))));
const emptyState = (title, text, href, linkText) => el('div', { class: 'empty' }, el('strong', {}, title), el('p', {}, text),
  href ? el('a', { class: 'btn', href }, linkText) : null);
const section = (title, content, extra) => el('section', { class: 'section' },
  el('div', { class: 'section-head' }, el('h2', {}, title), extra || ''), content);

// ---------- Views ----------
function viewDashboard() {
  const favs = favorites.list().map(getTool), recentAll = recent.list().map(getTool);
  // Each tool appears once on the page: Favorites, then Recently used, then Most used.
  const rec = recentAll.filter(t => !favs.includes(t)).slice(0, 4);
  const used = usage.all(), totals = usage.totals();
  const frequent = usage.top(8).filter(t => used[t.id].count >= 2 && !rec.includes(t) && !favs.includes(t)).slice(0, 4);
  const updated = TOOLS.filter(t => t.note).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 4);
  const frag = document.createDocumentFragment();
  // Search and shortcuts live in the top bar, so the header is just a title and one summary line.
  const topTool = totals.opens ? usage.top(1)[0] : null;
  frag.append(el('div', { class: 'hero' },
    el('h1', {}, 'Developer Toolbox'),
    el('p', {}, `${TOOLS.length} tools that run in your browser; your input stays local (see About for the few that use the network).`,
      totals.opens ? [` · ${totals.opens} ${totals.opens === 1 ? 'open' : 'opens'} across ${totals.tools} ${totals.tools === 1 ? 'tool' : 'tools'}`, topTool ? [', most used: ', el('a', { href: hrefTo('tool', topTool.id) }, topTool.name)] : ''] : '')));
  if (favs.length) frag.append(section('Favorites', toolGrid(favs)));
  if (rec.length) frag.append(section('Recently used', toolGrid(rec), el('a', { href: hrefTo('recent'), class: 'link' }, 'View all')));
  if (frequent.length) frag.append(section('Most used', toolGrid(frequent, t => `${used[t.id].count} opens`)));
  if (!favs.length && !recentAll.length) {
    const starters = ['json-formatter', 'jwt-decoder', 'regex-tester', 'diff-checker'].map(getTool).filter(Boolean);
    frag.append(section('Good places to start', toolGrid(starters), el('span', { class: 'hint' }, 'Star a tool to pin it here.')));
  }
  if (updated.length) frag.append(section('Recently updated', toolGrid(updated, t => `${t.updated}: ${t.note}`)));
  frag.append(section('Browse by category', el('div', { class: 'cat-grid' }, CATEGORIES.map(c => {
    const n = TOOLS.filter(t => t.category === c.id).length;
    return el('a', { class: 'cat-card', 'data-cat': c.id, href: hrefTo('category', c.id) }, el('span', { html: icon(c.icon) }), el('div', {}, el('strong', {}, c.name), el('small', {}, `${n} tools`)));
  }))));
  return { title: 'Dashboard', node: frag };
}

// Sorting and view preferences for the catalog pages, remembered between visits.
const SORTS = [['default', 'Default'], ['name', 'Name (A–Z)'], ['recent', 'Recently used'], ['most', 'Most used'], ['favorites', 'Favorites first'], ['added', 'Recently added']];
const catalogPrefs = {
  get() { const p = storage.get('catalogPrefs', {}) || {}; return { sort: SORTS.some(s => s[0] === p.sort) ? p.sort : 'default', view: p.view === 'list' ? 'list' : 'grid' }; },
  set(patch) { storage.set('catalogPrefs', { ...catalogPrefs.get(), ...patch }); },
};
/**
 * Order search results. They arrive in the default order (relevance while searching, otherwise the page's natural order), which
 * is also the tie-breaker, so sorting composes with the search and category filters. A tool with no `added` date counts as newest.
 */
function sortResults(results, mode) {
  if (mode === 'default') return results;
  const pos = new Map(results.map((r, i) => [r.tool.id, i])), u = usage.all(), favs = new Set(favorites.list());
  const last = r => u[r.tool.id]?.last || 0, count = r => u[r.tool.id]?.count || 0, added = r => r.tool.added || '9999-12-31';
  const by = {
    name: (a, b) => a.tool.name.localeCompare(b.tool.name, undefined, { sensitivity: 'base' }),
    recent: (a, b) => last(b) - last(a),
    most: (a, b) => count(b) - count(a) || last(b) - last(a),
    favorites: (a, b) => Number(favs.has(b.tool.id)) - Number(favs.has(a.tool.id)),
    added: (a, b) => added(b).localeCompare(added(a)),
  }[mode];
  return [...results].sort((a, b) => by(a, b) || pos.get(a.tool.id) - pos.get(b.tool.id));
}

/**
 * A browsable list of tools with a filter (name, description, keywords, category), category chips, sorting and a grid/list view.
 * `ids` restricts the list to certain tools (an array, or a function returning one so it stays current), in that order by default.
 */
function viewCatalog({ category = null, ids = null, title, empty, emptyText = '' }) {
  const prefs = catalogPrefs.get();
  let sort = prefs.sort, view = prefs.view, activeCat = category;
  const wrap = el('div');
  const input = el('input', { class: 'input', type: 'search', id: 'catalog-filter', placeholder: 'Filter tools by name, description or category…', 'aria-label': 'Filter tools by name, description or category', autocomplete: 'off', spellcheck: 'false' });
  const clearBtn = el('button', { class: 'search-clear', type: 'button', 'aria-label': 'Clear filter', title: 'Clear filter (Esc)', hidden: true, html: icon('x') });
  const sortSel = el('select', { class: 'select', id: 'catalog-sort', 'aria-label': 'Sort tools' }, SORTS.map(([v, l]) => el('option', { value: v }, l)));
  sortSel.value = sort;
  const gridBtn = el('button', { type: 'button', title: 'Grid view', 'aria-label': 'Grid view', html: icon('grid-2x2') });
  const listBtn = el('button', { type: 'button', title: 'List view', 'aria-label': 'List view', html: icon('list') });
  const chips = el('div', { class: 'chips catalog-chips', role: 'group', 'aria-label': 'Filter by category' });
  const meta = el('div', { class: 'catalog-meta', role: 'status', 'aria-live': 'polite' });
  const results = el('div', { class: 'catalog-results' });

  const clearAll = () => { input.value = ''; activeCat = null; draw(); input.focus(); };
  const onFav = tool => { renderSidebarCounts(); draw(); results.querySelector(`[data-tool="${tool.id}"] .fav-btn`)?.focus(); };
  const emptyView = (q, scope) => {
    if (!q && !activeCat) return emptyState(empty || 'No tools to show', emptyText || 'Try a different search or category.', hrefTo('tools'), 'Browse all tools');
    return el('div', { class: 'empty' }, el('strong', {}, q ? `No tools match “${q}”` : 'No tools in this category'),
      el('p', {}, scope ? 'Check the spelling, or clear the filters to see all of them.' : 'Check the spelling, try a keyword such as “json” or “url”, or clear the filters.'),
      el('button', { class: 'btn', type: 'button', onclick: clearAll }, 'Clear filters'));
  };
  function draw() {
    const q = input.value.trim(), idList = typeof ids === 'function' ? ids() : ids;
    clearBtn.hidden = !input.value;
    gridBtn.setAttribute('aria-pressed', String(view === 'grid')); listBtn.setAttribute('aria-pressed', String(view === 'list'));
    chips.replaceChildren(...[{ id: null, name: 'All' }, ...CATEGORIES].map(c =>
      el('button', { class: `chip${activeCat === c.id ? ' active' : ''}`, type: 'button', 'data-cat': c.id, 'data-chip': c.id ?? 'all', 'aria-pressed': activeCat === c.id,
        onclick: () => { activeCat = c.id; draw(); chips.querySelector(`[data-chip="${c.id ?? 'all'}"]`)?.focus(); } }, c.name)));
    let list = searchToolsDetailed(q, activeCat);
    if (idList) {
      const order = new Map(idList.map((id, i) => [id, i]));
      list = list.filter(r => order.has(r.tool.id));
      if (!q) list.sort((a, b) => order.get(a.tool.id) - order.get(b.tool.id)); // a Favorites / Recently used page keeps its own order
    }
    list = sortResults(list, sort);
    const scope = idList ? idList.length : TOOLS.length, filtered = q || activeCat;
    results.replaceChildren(list.length ? el('div', { class: 'tool-grid', 'data-view': view }, list.map(r => toolCard(r.tool, r.ranges, '', onFav))) : emptyView(q, !!idList));
    meta.textContent = filtered ? `${list.length} of ${scope} ${scope === 1 ? 'tool' : 'tools'}` : `${scope} ${scope === 1 ? 'tool' : 'tools'}`;
    renderIcons(wrap);
  }
  const redraw = ui.debounce(draw, 100);
  input.addEventListener('input', () => { clearBtn.hidden = !input.value; redraw(); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; draw(); } });
  clearBtn.addEventListener('click', () => { input.value = ''; draw(); input.focus(); });
  sortSel.addEventListener('change', () => { sort = sortSel.value; catalogPrefs.set({ sort }); draw(); });
  gridBtn.addEventListener('click', () => { view = 'grid'; catalogPrefs.set({ view }); draw(); });
  listBtn.addEventListener('click', () => { view = 'list'; catalogPrefs.set({ view }); draw(); });
  wrap.append(
    el('div', { class: 'catalog-bar' },
      el('div', { class: 'search-field' }, input, clearBtn),
      el('label', { class: 'sort-field' }, el('span', {}, 'Sort'), sortSel),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, gridBtn, listBtn)),
    chips, meta, results);
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
  const head = el('div', { class: 'tool-head', 'data-cat': tool.category },
    el('div', { class: 'tool-head-icon', html: icon(tool.icon) }),
    el('div', { class: 'tool-head-text' }, el('h1', {}, tool.name), el('p', { title: tool.description }, tool.description)),
    el('button', { class: `btn btn-icon fav-toggle${fav ? ' active' : ''}`, 'aria-pressed': fav, title: fav ? 'Remove from favorites' : 'Add to favorites',
      html: `${icon('star')}<span class="sr-only">${fav ? 'Favorited' : 'Favorite'}</span>`,
      onclick: e => { const on = favorites.toggle(id); const b = e.currentTarget;
        b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); b.title = on ? 'Remove from favorites' : 'Add to favorites';
        b.querySelector('span').textContent = on ? 'Favorited' : 'Favorite'; renderSidebarCounts(); } }),
    el('button', { class: 'btn btn-icon', type: 'button', title: `Share ${tool.name}`, 'aria-label': `Share ${tool.name}`, html: `${icon('share-2')}<span class="sr-only">Share</span>`, onclick: () => openShare(tool) }));
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
    case 'favorites': view = viewCatalog({ title: 'Favorites', ids: () => favorites.list(), empty: 'No favorites yet', emptyText: 'Click the star on any tool to pin it here for quick access.' }); break;
    case 'recent': view = viewCatalog({ title: 'Recently Used', ids: () => recent.list(), empty: 'No recently used tools', emptyText: 'Tools you open will show up here, most recent first.' }); break;
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
  if (!rerender) { main.scrollTop = 0; window.scrollTo(0, 0); } // a re-render (e.g. after starring a card) must not jump to the top
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
  const link = (n, href, label, ic, count, cat) => `<a class="nav-link"${cat ? ` data-cat="${escapeHtml(cat)}"` : ''} data-nav="${n}" href="${href}" title="${escapeHtml(label)}">${icon(ic)}<span>${escapeHtml(label)}</span>${count ? `<em class="count" data-count="${n}"></em>` : ''}</a>`;
  nav.innerHTML =
    NAV.map(n => link(n.name, hrefTo(n.name), n.label, n.icon, !!n.count)).join('') +
    `<div class="nav-label">Categories</div>` +
    CATEGORIES.map(c => link('category/' + c.id, hrefTo('category', c.id), c.name, c.icon, false, c.id)).join('') +
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
    chips.replaceChildren(...[{ id: null, name: 'All' }, ...CATEGORIES].map(c => el('button', { class: `chip${cat === c.id ? ' active' : ''}`, 'data-cat': c.id, 'aria-pressed': cat === c.id, tabindex: '-1',
      onclick: () => { cat = c.id; idx = 0; draw(); input.focus(); } }, c.name)));
    const q = input.value.trim();
    items = q ? searchToolsDetailed(q, cat) : suggestions();
    list.replaceChildren(...(items.length ? items.map((r, i) => el('a', { class: 'palette-item', 'data-cat': r.tool.category, id: `palette-opt-${i}`, ...toolLinkAttrs(r.tool), role: 'option', 'aria-selected': 'false', tabindex: '-1',
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

// ---------- Share ----------
const SITE_URL = 'https://developer-toolbox.caongocphuong95.workers.dev/';
/** Public URL of the current page (tool or category), always on the production domain so shared links work for everyone. */
function shareTarget(tool = null) {
  const r = router.current;
  tool = tool || (r?.name === 'tool' ? getTool(r.param) : null);
  const cat = r?.name === 'category' ? getCategory(r.param) : null;
  if (tool) {
    const c = getCategory(tool.category), tag = (c?.name || '').replace(/[^A-Za-z0-9]+/g, '');
    return { tool, url: tool.standalone ? new URL(tool.href, SITE_URL).href : SITE_URL + hrefTo('tool', tool.id), title: `${tool.name} · Developer Toolbox`,
      text: `${tool.name}: ${tool.description} Free, runs in your browser.`, tags: ['DeveloperTools', ...(tag ? [tag] : [])] };
  }
  if (cat) return { url: SITE_URL + hrefTo('category', cat.id), title: `${cat.name} · Developer Toolbox`, text: `${cat.name} tools, free in your browser.`, tags: ['DeveloperTools'] };
  return { url: SITE_URL, title: 'Developer Toolbox', text: `Developer Toolbox: ${TOOLS.length} free developer tools that run in your browser.`, tags: ['DeveloperTools'] };
}
function openShare(tool = null) {
  if (document.querySelector('.modal-overlay')) return;
  const { tool: t0, url, title, text, tags } = shareTarget(tool);
  const u = encodeURIComponent(url), t = encodeURIComponent(text), hashtags = encodeURIComponent(tags.join(','));
  // [name, href, brand colour, badge text]
  const targets = [
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`, '#1877f2', 'f'],
    ['X', `https://twitter.com/intent/tweet?url=${u}&text=${t}&hashtags=${hashtags}`, '#111111', '𝕏'],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`, '#0a66c2', 'in'],
    ['WhatsApp', `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '#25d366', 'W'],
    ['Telegram', `https://t.me/share/url?url=${u}&text=${t}`, '#229ed9', 'T'],
    ['Reddit', `https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(title)}`, '#ff4500', 'R'],
    ['Email', `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${text}
${url}`)}`, '#6b7280', '@'],
  ];
  const input = el('input', { class: 'input', type: 'text', readonly: true, value: url, 'aria-label': 'Link to share' });
  input.addEventListener('focus', () => input.select());
  const copyBtn = el('button', { class: 'btn btn-primary', type: 'button', html: `${icon('copy')}<span>Copy</span>`,
    onclick: async () => { if (await ui.copyText(url, 'Link copied')) { copyBtn.lastChild.textContent = 'Copied'; setTimeout(() => { copyBtn.lastChild.textContent = 'Copy'; }, 1800); } } });
  const body = el('div', { class: 'share' },
    t0
      ? el('div', { class: 'share-preview share-tool', 'data-cat': t0.category }, el('div', { class: 'share-tool-icon', html: icon(t0.icon) }),
          el('div', {}, el('strong', {}, t0.name), el('small', {}, t0.description), el('em', {}, tags.map(x => '#' + x).join(' '))))
      : el('div', { class: 'share-preview' }, el('img', { src: 'assets/icons/og-image.png', alt: '', width: 1200, height: 630 }),
          el('div', {}, el('strong', {}, title), el('small', {}, text))),
    el('div', { class: 'share-grid' }, targets.map(([name, href, color, mark]) =>
      el('a', { class: 'share-btn', href, target: '_blank', rel: 'noopener noreferrer', style: `--brand:${color}` },
        el('span', { class: 'share-mark', 'aria-hidden': 'true' }, mark), el('span', {}, name)))),
    el('div', { class: 'share-copy' }, input, copyBtn),
    navigator.share ? el('button', { class: 'btn share-native', type: 'button', html: `${icon('share-2')}<span>Share via device…</span>`,
      onclick: () => navigator.share({ title, text, url }).catch(() => {}) }) : null);
  ui.openModal({ title: 'Share', body });
  renderIcons(body);
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
  $('#open-share')?.addEventListener('click', () => openShare());
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
  renderIcons(); // the static shell markup (top bar, logo)
  router.start();
}
boot();
