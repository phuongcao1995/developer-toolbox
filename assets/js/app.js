// Application shell: sidebar, top bar, dashboard, settings, command palette, dynamic tool loader.
import { CATEGORIES, TOOLS, getTool, getCategory, searchTools } from './registry.js';
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
function toolCard(tool) {
  const fav = favorites.has(tool.id);
  const cat = getCategory(tool.category);
  const card = el('a', { class: 'tool-card', href: hrefTo('tool', tool.id) },
    el('div', { class: 'tool-card-icon', html: icon(tool.icon) }),
    el('div', { class: 'tool-card-body' },
      el('div', { class: 'tool-card-title' }, tool.name),
      el('div', { class: 'tool-card-desc' }, tool.description),
      el('span', { class: 'badge' }, cat?.name || '')),
    el('button', { class: `fav-btn${fav ? ' active' : ''}`, 'aria-label': fav ? 'Remove from favorites' : 'Add to favorites', 'aria-pressed': fav, title: 'Favorite',
      html: icon('star'), onclick: e => { e.preventDefault(); e.stopPropagation(); favorites.toggle(tool.id); route(); } }));
  return card;
}
const toolGrid = tools => el('div', { class: 'tool-grid' }, tools.map(toolCard));
const emptyState = (title, text) => el('div', { class: 'empty' }, el('strong', {}, title), el('p', {}, text));
const section = (title, content, extra) => el('section', { class: 'section' },
  el('div', { class: 'section-head' }, el('h2', {}, title), extra || ''), content);

// ---------- Views ----------
function viewDashboard() {
  const favs = favorites.list().map(getTool), rec = recent.list().slice(0, 6).map(getTool);
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'hero' },
    el('h1', {}, 'Welcome to Developer Toolbox'),
    el('p', {}, `${TOOLS.length} everyday developer utilities. Everything runs in your browser — your data never leaves this page.`),
    el('button', { class: 'hero-search', onclick: openPalette, html: `${icon('search')}<span>Search tools…</span><kbd>Ctrl K</kbd>` })));
  frag.append(section('Favorites', favs.length ? toolGrid(favs) : emptyState('No favorites yet', 'Click the star on any tool to pin it here.')));
  frag.append(section('Recently used', rec.length ? toolGrid(rec) : emptyState('Nothing yet', 'Tools you open will show up here.'),
    rec.length ? el('a', { href: hrefTo('recent'), class: 'link' }, 'View all') : ''));
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
      el('button', { class: `chip${activeCat === c.id ? ' active' : ''}`, onclick: () => { activeCat = c.id; draw(); } }, c.name)));
    let list = searchTools(input.value, activeCat);
    if (ids) list = list.filter(t => ids.includes(t.id));
    results.replaceChildren(list.length ? toolGrid(list) : emptyState(empty || 'No tools match', 'Try a different search or category.'));
    renderIcons(results);
  };
  input.addEventListener('input', draw);
  wrap.append(el('div', { class: 'toolbar' }, input), chips, results);
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
      storage.clear(['recent', 'favorites', 'tool:']); ui.toast('History cleared', 'success'); renderSidebarCounts();
    }
  };
  $('#reset-prefs', wrap).onclick = async () => {
    if (await ui.confirmDialog('Reset preferences', 'Reset theme, font size and indentation to defaults?', 'Reset')) {
      settings.reset(); ui.toast('Preferences reset', 'success'); route();
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
    <h3>Shortcuts</h3><p><kbd>Ctrl</kbd>+<kbd>K</kbd> opens global search. <kbd>Esc</kbd> closes dialogs.</p>`;
  return { title: 'About', node: wrap };
}

// ---------- Tool loader ----------
let disposeTool = null;
async function viewTool(id) {
  const tool = getTool(id);
  if (!tool) return { title: 'Not found', node: emptyState('Tool not found', `There is no tool called “${id}”.`) };
  recent.push(id);
  const fav = favorites.has(id);
  const page = el('div', { class: 'tool-page' });
  const head = el('div', { class: 'tool-head' },
    el('div', { class: 'tool-head-icon', html: icon(tool.icon) }),
    el('div', { class: 'tool-head-text' }, el('h1', {}, tool.name), el('p', {}, tool.description)),
    el('button', { class: `btn fav-toggle${fav ? ' active' : ''}`, 'aria-pressed': fav,
      html: `${icon('star')}<span>${fav ? 'Favorited' : 'Favorite'}</span>`,
      onclick: e => { const on = favorites.toggle(id); const b = e.currentTarget;
        b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); b.querySelector('span').textContent = on ? 'Favorited' : 'Favorite'; renderSidebarCounts(); } }));
  const root = el('div', { class: `tool-root tool-${id}` }, el('div', { class: 'loading-block' }, el('span', { class: 'spinner' }), 'Loading tool…'));
  page.append(head, root);
  // Mount asynchronously so the shell paints first.
  queueMicrotask(() => mountTool(tool, root));
  return { title: tool.name, node: page, noWrap: true };
}

async function mountTool(tool, root) {
  const token = ++mountToken;
  try {
    const base = `tools/${tool.id}/`;
    const [html] = await Promise.all([
      fetch(base + 'index.html').then(r => { if (!r.ok) throw new Error(`index.html: HTTP ${r.status}`); return r.text(); }),
      new Promise(res => { // load tool CSS (once)
        const href = base + 'tool.css';
        if (document.querySelector(`link[href="${href}"]`)) return res();
        const l = el('link', { rel: 'stylesheet', href }); l.onload = l.onerror = () => res(); document.head.append(l);
      }),
    ]);
    const mod = await import(`../../${tool.entry}`);
    if (token !== mountToken) return; // navigated away while loading
    root.innerHTML = html;
    const s = settings.get();
    const ctx = {
      toolId: tool.id, ui, settings, storage: scopedStorage(tool.id),
      indentUnit: settings.indentUnit(), fontSize: s.fontSize,
    };
    const cleanup = await (mod.default?.mount ?? mod.mount)(root, ctx);
    if (token !== mountToken) { cleanup?.(); return; }
    disposeTool = typeof cleanup === 'function' ? cleanup : null;
    renderIcons(root);
  } catch (err) {
    console.error(err);
    if (token === mountToken) root.replaceChildren(el('div', { class: 'alert alert-error' }, `Failed to load “${tool.name}”: ${err.message}`));
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
async function route(r = router.current) {
  router.current = r;
  mountToken++; // invalidate in-flight tool loads
  try { disposeTool?.(); } catch (e) { console.error(e); }
  disposeTool = null;
  let view;
  switch (r.name) {
    case 'dashboard': view = viewDashboard(); break;
    case 'tools': view = viewCatalog({ title: 'All Tools' }); break;
    case 'favorites': view = viewCatalog({ title: 'Favorites', ids: favorites.list(), empty: 'No favorites yet' }); break;
    case 'recent': view = viewCatalog({ title: 'Recently Used', ids: recent.list(), empty: 'No recently used tools' }); break;
    case 'category': { const c = getCategory(r.param); view = c ? viewCatalog({ title: c.name, category: c.id }) : viewCatalog({ title: 'All Tools' }); break; }
    case 'settings': view = viewSettings(); break;
    case 'about': view = viewAbout(); break;
    case 'tool': view = await viewTool(r.param); break;
    default: view = { title: 'Not found', node: emptyState('Page not found', 'That route does not exist.') };
  }
  main.replaceChildren();
  if (view.noWrap) main.append(view.node);
  else { main.append(el('div', { class: 'page-head' }, el('h1', {}, view.title === 'Dashboard' ? '' : view.title)), view.node); if (view.title === 'Dashboard') $('.page-head', main).remove(); }
  renderIcons(main);
  document.title = `${view.title} · Developer Toolbox`;
  main.scrollTop = 0; window.scrollTo(0, 0);
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
  const link = (n, href, label, ic, count) => `<a class="nav-link" data-nav="${n}" href="${href}">${icon(ic)}<span>${escapeHtml(label)}</span>${count ? `<em class="count" data-count="${n}"></em>` : ''}</a>`;
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
  let cat = null, idx = 0, results = [];
  const input = el('input', { class: 'input palette-input', type: 'search', placeholder: 'Search by name, description or keyword…', 'aria-label': 'Search tools' });
  const chips = el('div', { class: 'chips' }), list = el('div', { class: 'palette-list', role: 'listbox' });
  const draw = () => {
    chips.replaceChildren(...[{ id: null, name: 'All' }, ...CATEGORIES].map(c => el('button', { class: `chip${cat === c.id ? ' active' : ''}`, onclick: () => { cat = c.id; idx = 0; draw(); input.focus(); } }, c.name)));
    results = searchTools(input.value, cat);
    list.replaceChildren(...(results.length ? results.map((t, i) => el('a', { class: `palette-item${i === idx ? ' active' : ''}`, href: hrefTo('tool', t.id), role: 'option', onclick: () => palette?.close() },
      el('span', { html: icon(t.icon) }), el('div', {}, el('strong', {}, t.name), el('small', {}, t.description))))
      : [el('div', { class: 'empty' }, 'No matching tools')]));
    renderIcons(list); list.children[idx]?.scrollIntoView?.({ block: 'nearest' });
  };
  input.addEventListener('input', () => { idx = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, results.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); draw(); }
    else if (e.key === 'Enter' && results[idx]) { e.preventDefault(); const id = results[idx].id; palette.close(); router.go('tool', id); }
  });
  const body = el('div', {}, input, chips, list);
  palette = ui.openModal({ title: 'Search tools', body, onClose: () => { palette = null; } });
  palette.modal.classList.add('palette');
  draw(); input.focus();
}

// ---------- Boot ----------
const router = createRouter(route);
function boot() {
  applySettings();
  settings.onChange(applySettings);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!settings.get().theme) applyTheme(currentTheme()); });
  buildSidebar();
  $('#theme-toggle').addEventListener('click', () => settings.set({ theme: currentTheme() === 'dark' ? 'light' : 'dark' }));
  $('#open-search').addEventListener('click', openPalette);
  $('#menu-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#scrim').addEventListener('click', closeSidebar);
  $('#open-settings').addEventListener('click', () => router.go('settings'));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
  router.start();
  // Lucide loads async from CDN; refresh icons once it is ready.
  window.addEventListener('load', () => renderIcons());
}
boot();
