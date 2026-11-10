// Catalog behaviour in real Chrome: the All Tools page, tool cards, filter, sorting, grid/list view and recently used.
//   node tests/browser/catalog.mjs          (needs a static server, see harness.mjs)
// Checks: columns / equal heights / description clamping / bottom-aligned labels at 6 widths, hover and focus states, the favourite
// star (no navigation, state kept, filter kept), filter + clear + Escape + empty state, all six sorts and sort+filter+category together,
// view and sort persistence across a reload, the recently-used limit, and the empty Favorites page. Exit code is non-zero on any failure.
import { start, toolIds } from './harness.mjs';

const ids = toolIds();
const h = await start();
const { ev, sleep, send } = h;
const fails = [];
const check = (name, ok, detail = '') => { if (!ok) fails.push(`${name}${detail ? ' (' + detail + ')' : ''}`); return ok; };
const metrics = (w, hgt, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile });
const go = async hash => { await ev(`location.hash='${hash}'`); await sleep(1500); };
const setv = (sel, value) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const names = () => ev("[...document.querySelectorAll('.tool-card .tool-card-title')].map(t=>t.textContent)");
const sortBy = async v => { await ev(`(()=>{const s=document.querySelector('#catalog-sort'); s.value=${JSON.stringify(v)}; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(350); };
const az = a => [...a].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

// 1. Grid: columns, no overflow, equal row heights, description clamped to 3 lines, category label pinned to the card bottom
// (columns follow the width of the grid's container: with the sidebar open 4 columns from ~1330px, 3 from ~1050px, 2 from ~770px, then 1)
for (const [w, cols] of [[1920, 4], [1440, 4], [1280, 3], [1024, 2], [768, 2], [390, 1]]) {
  await metrics(w, 900, w < 500); await go('#/tools');
  const r = await ev(`(() => {
    const grid = document.querySelector('.tool-grid'), cards = [...grid.querySelectorAll('.tool-card')], rows = {};
    cards.forEach(c => (rows[Math.round(c.offsetTop)] ||= []).push(c));
    let unequal = 0, misaligned = 0, lines = 0;
    for (const r of Object.values(rows)) {
      if (new Set(r.map(c => Math.round(c.getBoundingClientRect().height))).size > 1) unequal++;
      if (new Set(r.map(c => Math.round(c.getBoundingClientRect().bottom - c.querySelector('.tool-card-foot').getBoundingClientRect().bottom))).size > 1) misaligned++;
    }
    for (const c of cards) { const d = c.querySelector('.tool-card-desc'); lines = Math.max(lines, Math.round(d.clientHeight / parseFloat(getComputedStyle(d).lineHeight))); }
    const de = document.documentElement;
    return { cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length, unequal, misaligned, lines, overflow: de.scrollWidth > de.clientWidth + 1 };
  })()`);
  check(`${w}px: ${cols} column(s)`, r.cols === cols, `got ${r.cols}`);
  check(`${w}px: equal card heights`, r.unequal === 0, `${r.unequal} rows differ`);
  check(`${w}px: labels aligned at the bottom`, r.misaligned === 0, `${r.misaligned} rows`);
  check(`${w}px: description <= 3 lines`, r.lines <= 3, String(r.lines));
  check(`${w}px: no horizontal overflow`, !r.overflow);
}

// 2. Hover (category accent border, 2px lift, arrow), star hover cancels the lift, keyboard focus ring
await metrics(1440, 900); await go('#/tools');
await ev("document.querySelector('.tool-card[data-cat=api]').scrollIntoView({block:'center'})"); await sleep(250);
const pos = await ev("(()=>{const r=document.querySelector('.tool-card[data-cat=api]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}})()");
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }); await sleep(450);
const hov = await ev("(()=>{const c=document.querySelector('.tool-card[data-cat=api]'), s=getComputedStyle(c); return {border:s.borderTopColor, transform:s.transform, shadow:s.boxShadow!=='none', arrow:getComputedStyle(c.querySelector('.tool-card-go')).opacity, cursor:s.cursor}})()");
check('hover: border is the category accent', hov.border === 'rgb(219, 39, 119)', hov.border);
check('hover: lifts 2px', hov.transform === 'matrix(1, 0, 0, 1, 0, -2)', hov.transform);
check('hover: shadow and arrow', hov.shadow && hov.arrow === '1'); check('hover: pointer cursor', hov.cursor === 'pointer');
const star = await ev("(()=>{const r=document.querySelector('.tool-card[data-cat=api] .fav-btn').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}})()");
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: star.x, y: star.y }); await sleep(450);
check('pointing at the star does not lift the card', await ev("getComputedStyle(document.querySelector('.tool-card[data-cat=api]')).transform") === 'none');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
await ev("document.querySelector('.tool-card[data-cat=text]').focus()");
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift' });
check('keyboard focus ring is visible', await ev("(()=>{const s=getComputedStyle(document.querySelector('.tool-card[data-cat=text]')); return s.outlineStyle==='solid' && s.outlineWidth==='2px'})()"));

// 3. Favourite star: no navigation, aria-pressed, persisted, filter and focus kept, sidebar count, gold colour
await ev("localStorage.removeItem('devtoolbox:favorites')"); await go('#/tools');
await setv('#catalog-filter', 'json'); await sleep(400);
const hash0 = await ev('location.hash');
await ev("document.querySelector('.tool-card[data-tool=json-formatter] .fav-btn').click()"); await sleep(400);
const fav = await ev(`(()=>({hash:location.hash, pressed:document.querySelector('.tool-card[data-tool=json-formatter] .fav-btn')?.getAttribute('aria-pressed'), stored:localStorage.getItem('devtoolbox:favorites'), filter:document.querySelector('#catalog-filter').value, sidebar:document.querySelector('[data-count=favorites]')?.textContent, focusOnStar:document.activeElement?.classList.contains('fav-btn'), color:getComputedStyle(document.querySelector('.tool-card[data-tool=json-formatter] .fav-btn')).color}))()`);
check('star does not navigate', fav.hash === hash0); check('star: aria-pressed is "true"', fav.pressed === 'true', JSON.stringify(fav.pressed));
check('favourite persisted', /json-formatter/.test(fav.stored || '')); check('filter kept after starring', fav.filter === 'json');
check('sidebar count updated', fav.sidebar === '1'); check('focus stays on the star', fav.focusOnStar); check('starred colour is gold', fav.color === 'rgb(217, 119, 6)', fav.color);

// 4. Filter, clear button, Escape, live count, empty state
await go('#/tools'); await setv('#catalog-filter', 'database'); await sleep(400);
const f = await ev("({count:document.querySelector('.catalog-meta').textContent, clear:!document.querySelector('.search-clear').hidden, shown:document.querySelectorAll('.tool-card').length})");
check('searching by category word works', f.shown > 0 && f.clear && /of \d+ tools/.test(f.count), JSON.stringify(f));
await ev("document.querySelector('.search-clear').click()"); await sleep(300);
check('clear button resets filter and count', await ev("document.querySelector('#catalog-filter').value") === '' && /^\d+ tools$/.test(await ev("document.querySelector('.catalog-meta').textContent")));
await setv('#catalog-filter', 'qqzzxx'); await sleep(400);
check('empty state offers "Clear filters"', await ev("!!document.querySelector('.catalog-results .empty .btn')"));
await ev("document.querySelector('.catalog-results .empty .btn').click()"); await sleep(300);
// (ids only lists routed tools; standalone tools add a few more cards)
check('"Clear filters" restores every tool', await ev("document.querySelectorAll('.tool-card').length") >= ids.length);
await setv('#catalog-filter', 'xml'); await sleep(300);
await ev("document.querySelector('#catalog-filter').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"); await sleep(250);
check('Escape clears the filter', await ev("document.querySelector('#catalog-filter').value") === '');

// 5. Sorting, alone and combined with filter and category
await sortBy('name'); const byName = await names(); check('Name (A-Z)', JSON.stringify(byName) === JSON.stringify(az(byName)));
await sortBy('added'); const added = await names(); check('Recently added: newest first', /Weather|CV Builder/.test(added.slice(0, 3).join(',')), added.slice(0, 3).join(','));
await sortBy('favorites'); check('Favorites first', (await names())[0] === 'JSON Formatter');
await ev("localStorage.removeItem('devtoolbox:recent'); localStorage.removeItem('devtoolbox:usage')");
for (const id of ['uuid-generator', 'cron-generator', 'uuid-generator', 'chmod-calculator']) { await ev(`location.hash='#/tool/${id}'`); await sleep(1300); }
await go('#/tools');
await sortBy('recent'); check('Recently used: last opened first', (await names())[0] === 'Chmod Calculator');
await sortBy('most'); check('Most used: most opened first', (await names())[0] === 'UUID Generator');
await sortBy('name'); await setv('#catalog-filter', 'format'); await sleep(400);
await ev("document.querySelector('.chip[data-cat=data]').click()"); await sleep(350);
const combo = await names(); check('sort + filter + category compose', combo.length > 0 && JSON.stringify(combo) === JSON.stringify(az(combo)), combo.join(','));
await ev("document.querySelector('.search-clear').click(); document.querySelector('.chip[data-chip=all]').click()"); await sleep(300);

// 6. List view and persistence across a reload
await ev("document.querySelector('.seg button[aria-label=\"List view\"]').click()"); await sleep(400);
const list = await ev("(()=>{const g=document.querySelector('.tool-grid'), c=g.querySelector('.tool-card'); return {view:g.dataset.view, cols:getComputedStyle(g).gridTemplateColumns.split(' ').length, h:Math.round(c.getBoundingClientRect().height)}})()");
check('list view: one compact row per tool', list.view === 'list' && list.cols === 1 && list.h < 90, JSON.stringify(list));
await send('Page.reload'); await sleep(2500);
const kept = await ev("({view:document.querySelector('.tool-grid')?.dataset.view, sort:document.querySelector('#catalog-sort')?.value})");
check('view and sort persist after reload', kept.view === 'list' && kept.sort === 'name', JSON.stringify(kept));
await ev("document.querySelector('.seg button[aria-label=\"Grid view\"]').click()"); await sortBy('default');

// 7. Recently used: capped at 20, no duplicates, newest first
await ev("localStorage.removeItem('devtoolbox:recent')");
for (const id of ids.slice(0, 24).concat(['json-formatter'])) { await ev(`location.hash='#/tool/${id}'`); await sleep(260); }
await sleep(800);
const rec = JSON.parse(await ev("localStorage.getItem('devtoolbox:recent')"));
check('recently used is capped at 20', rec.length === 20, String(rec.length)); check('recently used has no duplicates', rec.length === new Set(rec).size);
check('recently used: most recent first', rec[0] === 'json-formatter');

// 8. Empty Favorites page
await ev("localStorage.removeItem('devtoolbox:favorites'); localStorage.removeItem('devtoolbox:recent')"); await go('#/favorites');
check('empty Favorites page explains how to add one', /star/i.test(await ev("document.querySelector('.catalog-results .empty')?.innerText") || '') && await ev("!!document.querySelector('.catalog-results .empty a.btn')"));

for (const e of h.errors) fails.push('console: ' + e.slice(0, 140));
console.log(fails.length ? 'FAILURES:\n  - ' + fails.join('\n  - ') : 'Catalog: all checks passed.');
h.finish();
process.exit(fails.length ? 1 : 0);
