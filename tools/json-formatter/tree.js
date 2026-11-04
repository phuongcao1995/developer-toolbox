// Accessible, lazy JSON tree explorer (DOM). All text goes through textContent / text nodes.
//
//   const tree = createTree(host, { el, copyText, toast });
//   tree.setData(value); tree.reveal(['a', 0, 'b']); tree.expandAll(); tree.collapseAll();
//   tree.search('foo', 'both'|'keys'|'values') -> count;  tree.step(+1|-1) -> {index,count};  tree.destroy()
//
// Performance: DOM is created only for expanded nodes, containers show PAGE children at a time ("show more"),
// expand-all works level by level in requestAnimationFrame chunks, and search walks the data (not the DOM).
import { formatPath } from '../../assets/js/shared/jsonpath.js';

export const PAGE = 200;
export const EXPAND_LIMIT = 20000;
export const MAX_MATCHES = 2000;
const MAX_TEXT = 300;

const isCont = v => v !== null && typeof v === 'object';

/** Search the data (iteratively); returns up to `limit` matches as segment arrays, in document order. */
export function searchData(root, q, mode = 'both', limit = MAX_MATCHES) {
  const needle = String(q).toLowerCase();
  const out = []; let truncated = false;
  if (!needle) return { matches: out, truncated };
  const wantKeys = mode !== 'values', wantVals = mode !== 'keys';
  const segsOf = link => { const s = []; for (let l = link; l && l.parent; l = l.parent) s.push(l.key); return s.reverse(); };
  const stack = [[root, { key: null, parent: null }, false]];
  while (stack.length) {
    const [v, link, keyIsName] = stack.pop();
    let hit = false;
    if (wantKeys && keyIsName && String(link.key).toLowerCase().includes(needle)) hit = true;
    if (!hit && wantVals && !isCont(v) && String(v).toLowerCase().includes(needle)) hit = true;
    if (hit) { if (out.length >= limit) { truncated = true; break; } out.push(segsOf(link)); }
    if (isCont(v)) {
      if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], { key: i, parent: link }, false]); }
      else { const ks = Object.keys(v); for (let i = ks.length - 1; i >= 0; i--) stack.push([v[ks[i]], { key: ks[i], parent: link }, true]); }
    }
  }
  return { matches: out, truncated };
}

export function createTree(host, { el, copyText, toast }) {
  const recOf = new WeakMap();
  let rootRec = null, ul = null;
  let openSet = new Set(), rendered = [], token = 0, raf = 0;
  let q = '', mode = 'both', matches = [], cur = -1, curLi = null, truncated = false;

  const keyLabel = rec => rec.parent ? String(rec.key) : 'root';

  /** Text with <mark> around occurrences of the active query (when `on`). */
  function hl(text, on) {
    if (!q || !on) return [text];
    const low = text.toLowerCase(), n = q.length, parts = [];
    let i = 0, at;
    while ((at = low.indexOf(q, i)) !== -1 && parts.length < 200) {
      if (at > i) parts.push(text.slice(i, at));
      parts.push(el('mark', { class: 'jt-mark' }, text.slice(at, at + n)));
      i = at + n;
    }
    if (i < text.length) parts.push(text.slice(i));
    return parts.length ? parts : [text];
  }

  function paint(rec) {
    const wantKeys = mode !== 'values', wantVals = mode !== 'keys';
    const isNameKey = rec.parent && !Array.isArray(rec.parent.value);
    rec.keyEl.replaceChildren(...(rec.parent ? hl(isNameKey ? JSON.stringify(String(rec.key)) : String(rec.key), wantKeys && isNameKey) : ['root']));
    if (rec.valEl) {
      const v = rec.value, t = v === null ? 'null' : typeof v;
      let text = t === 'string' ? v : String(v);
      const cut = text.length > MAX_TEXT;
      if (cut) text = text.slice(0, MAX_TEXT);
      const shown = t === 'string' ? hl(text, wantVals) : hl(text, wantVals);
      rec.valEl.replaceChildren(...(t === 'string' ? ['"', ...shown, cut ? '…"' : '"'] : shown));
      if (cut) rec.valEl.title = v.slice(0, 2000);
    }
  }

  function makeRec(parent, key, value) {
    const segs = parent ? parent.segs.concat(key) : [];
    const rec = { parent, key, value, segs, depth: parent ? parent.depth + 1 : 1, cont: isCont(value), open: false, built: false, kids: [], shown: 0, keys: null, keyIdx: null };
    const empty = rec.cont && !Object.keys(value).length;
    rec.expandable = rec.cont && !empty;
    const li = el('li', { class: 'jt-item', role: 'treeitem', 'aria-level': String(rec.depth), tabindex: '-1' });
    if (rec.expandable) li.setAttribute('aria-expanded', 'false');
    const row = el('div', { class: 'jt-row' });
    const label = keyLabel(rec);
    if (rec.expandable) {
      rec.toggle = el('button', { class: 'jt-toggle', type: 'button', tabindex: '-1', 'aria-label': `Toggle ${label}` }, '▶');
      row.append(rec.toggle);
    } else row.append(el('span', { class: 'jt-spacer' }));
    rec.keyEl = el('span', { class: 'jt-key' });
    row.append(rec.keyEl);
    if (parent) row.append(el('span', { class: 'jt-colon' }, ':'));
    if (!rec.cont) {
      const t = value === null ? 'null' : typeof value;
      rec.valEl = el('span', { class: `jt-${t}` });
      row.append(rec.valEl);
      if (t === 'string') row.append(el('span', { class: 'jt-badge', title: 'String length' }, `${value.length} chars`));
    } else {
      const n = Array.isArray(value) ? value.length : Object.keys(value).length;
      row.append(el('span', { class: 'jt-badge', title: Array.isArray(value) ? 'Array length' : 'Object keys' }, Array.isArray(value) ? `[${n}]` : `{${n}}`));
    }
    row.append(el('span', { class: 'jt-actions' },
      el('button', { class: 'jt-act', type: 'button', tabindex: '-1', 'data-act': 'path', title: 'Copy JSONPath', 'aria-label': `Copy path of ${label}` }, 'path'),
      el('button', { class: 'jt-act', type: 'button', tabindex: '-1', 'data-act': 'value', title: 'Copy value', 'aria-label': `Copy value of ${label}` }, 'value')));
    li.append(row);
    rec.li = li; rec.row = row;
    recOf.set(li, rec);
    rendered.push(rec);
    paint(rec);
    return rec;
  }

  function showMore(rec, n = PAGE) {
    if (!rec.keys && !Array.isArray(rec.value)) rec.keys = Object.keys(rec.value);
    const total = Array.isArray(rec.value) ? rec.value.length : rec.keys.length;
    const end = Math.min(total, rec.shown + n), frag = document.createDocumentFragment(), created = [];
    for (let i = rec.shown; i < end; i++) {
      const k = Array.isArray(rec.value) ? i : rec.keys[i];
      const c = makeRec(rec, k, rec.value[k]);
      rec.kids.push(c); created.push(c); frag.append(c.li);
    }
    rec.shown = end;
    if (rec.moreLi) rec.moreLi.remove();
    rec.moreLi = null;
    if (end < total) {
      const li = el('li', { class: 'jt-item jt-more', role: 'treeitem', 'aria-level': String(rec.depth + 1), tabindex: '-1' },
        el('div', { class: 'jt-row' }, el('span', { class: 'jt-spacer' }), el('button', { class: 'jt-morebtn', type: 'button', tabindex: '-1' }, `Show ${Math.min(PAGE, total - end)} more (${total - end} remaining)`)));
      recOf.set(li, { more: true, parent: rec, li });
      rec.moreLi = li; frag.append(li);
    }
    rec.group.append(frag);
    if (q) { /* newly created rows are painted with highlights in makeRec */ }
    return created;
  }

  function setOpen(rec, open) {
    if (!rec.expandable) return;
    if (open && !rec.built) {
      rec.built = true;
      rec.group = el('ul', { class: 'jt-children', role: 'group' });
      rec.li.append(rec.group);
      showMore(rec);
    }
    rec.open = open;
    if (rec.group) rec.group.hidden = !open;
    rec.li.setAttribute('aria-expanded', String(open));
    rec.toggle.textContent = open ? '▼' : '▶';
    if (open) openSet.add(rec); else openSet.delete(rec);
  }

  function childAt(rec, index) {
    if (!rec.built) setOpen(rec, true);
    const total = Array.isArray(rec.value) ? rec.value.length : (rec.keys || (rec.keys = Object.keys(rec.value))).length;
    if (index < 0 || index >= total) return null;
    while (rec.shown <= index) showMore(rec);
    return rec.kids[index];
  }

  function focusLi(li, scroll = true) {
    if (!li) return;
    if (focusLi.cur && focusLi.cur !== li) focusLi.cur.tabIndex = -1;
    li.tabIndex = 0; focusLi.cur = li;
    li.focus({ preventScroll: !scroll });
    if (scroll) li.scrollIntoView({ block: 'nearest' });
  }

  /** Expand the path and return the rec (or the deepest rec reached). */
  function reveal(segs, { focus = true } = {}) {
    if (!rootRec) return null;
    let rec = rootRec;
    setOpen(rec, true);
    for (let i = 0; i < segs.length; i++) {
      if (!rec.expandable) break;
      const seg = segs[i];
      let idx;
      if (Array.isArray(rec.value)) idx = typeof seg === 'number' ? seg : /^\d+$/.test(String(seg)) ? Number(seg) : -1;
      else {
        if (!rec.keys) rec.keys = Object.keys(rec.value);
        if (!rec.keyIdx) { rec.keyIdx = new Map(); rec.keys.forEach((k, j) => rec.keyIdx.set(k, j)); }
        idx = rec.keyIdx.has(String(seg)) ? rec.keyIdx.get(String(seg)) : -1;
      }
      const child = childAt(rec, idx);
      if (!child) break;
      rec = child;
      if (i < segs.length - 1) setOpen(rec, true);
    }
    if (focus) { focusLi(rec.li); }
    return rec;
  }

  function cancelExpand() { token++; if (raf) cancelAnimationFrame(raf); raf = 0; }

  /** Level-by-level, time-sliced expand. Resolves with {nodes, limited}. */
  function expandAll() {
    cancelExpand();
    if (!rootRec) return Promise.resolve({ nodes: 0, limited: false });
    const my = token;
    return new Promise(resolve => {
      let level = [rootRec], next = [], pos = 0, created = 0, limited = false;
      const step = () => {
        if (my !== token) return resolve({ nodes: created, limited, cancelled: true });
        const deadline = performance.now() + 12;
        while (performance.now() < deadline) {
          if (pos >= level.length) { if (!next.length) { raf = 0; return resolve({ nodes: created, limited }); } level = next; next = []; pos = 0; }
          if (created >= EXPAND_LIMIT) { limited = true; raf = 0; return resolve({ nodes: created, limited }); }
          const rec = level[pos++];
          if (!rec.expandable) continue;
          if (!rec.open) setOpen(rec, true);
          created += rec.shown;
          for (const k of rec.kids) if (k.expandable) next.push(k);
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
  }

  function collapseAll() {
    cancelExpand();
    for (const rec of [...openSet]) if (rec !== rootRec) setOpen(rec, false);
    if (rootRec) focusLi(rootRec.li, false);
  }

  // ---- keyboard / mouse
  const items = li => li ? li : null;
  const parentLi = li => li.parentElement && li.parentElement.closest('li.jt-item');
  function lastVisible(li) {
    for (;;) {
      const r = recOf.get(li);
      if (r && !r.more && r.open && r.group && r.group.lastElementChild) li = r.group.lastElementChild; else return li;
    }
  }
  function nextVisible(li) {
    const r = recOf.get(li);
    if (r && !r.more && r.open && r.group && r.group.firstElementChild) return r.group.firstElementChild;
    for (let x = li; x; x = parentLi(x)) if (x.nextElementSibling) return x.nextElementSibling;
    return null;
  }
  function prevVisible(li) {
    const p = li.previousElementSibling;
    return p ? lastVisible(p) : parentLi(li);
  }

  function activate(rec) {
    if (rec.more) { const li = rec.parent.moreLi; const created = showMore(rec.parent); focusLi((created[0] && created[0].li) || li); return; }
    if (rec.expandable) setOpen(rec, !rec.open);
  }

  async function copy(rec, what) {
    if (what === 'path') await copyText(formatPath(rec.segs), 'JSONPath copied');
    else await copyText(JSON.stringify(rec.value, null, 2), 'Value copied');
  }

  function onKey(e) {
    const li = e.target.closest && e.target.closest('li.jt-item');
    if (!li || e.target !== li || e.altKey || e.ctrlKey || e.metaKey) return;
    const rec = recOf.get(li); if (!rec) return;
    let to = null, handled = true;
    switch (e.key) {
      case 'ArrowDown': to = nextVisible(li); break;
      case 'ArrowUp': to = prevVisible(li); break;
      case 'ArrowRight':
        if (rec.expandable && !rec.open) setOpen(rec, true);
        else if (rec.expandable && rec.open && rec.group.firstElementChild) to = rec.group.firstElementChild;
        break;
      case 'ArrowLeft':
        if (!rec.more && rec.expandable && rec.open) setOpen(rec, false);
        else to = parentLi(li);
        break;
      case 'Home': to = rootRec && rootRec.li; break;
      case 'End': to = rootRec && lastVisible(rootRec.li); break;
      case 'Enter': case ' ': activate(rec); break;
      case 'p': case 'P': if (!rec.more) copy(rec, 'path'); break;
      case 'v': case 'V': if (!rec.more) copy(rec, 'value'); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    if (to) focusLi(to);
  }
  function onClick(e) {
    const li = e.target.closest('li.jt-item'); if (!li || !host.contains(li)) return;
    const rec = recOf.get(li); if (!rec) return;
    const act = e.target.closest('[data-act]');
    if (act) { e.stopPropagation(); if (!rec.more) copy(rec, 'value' === act.dataset.act ? 'value' : 'path'); return; }
    if (e.target.closest('.jt-toggle')) { setOpen(rec, !rec.open); focusLi(li, false); return; }
    if (e.target.closest('.jt-morebtn')) { activate(rec); return; }
    if (e.target.closest('.jt-row') && recOf.get(e.target.closest('li.jt-item')) === rec) focusLi(li, false);
  }
  function onDbl(e) {
    const li = e.target.closest('li.jt-item'); const rec = li && recOf.get(li);
    if (rec && rec.expandable && !e.target.closest('button')) setOpen(rec, !rec.open);
  }
  host.addEventListener('keydown', onKey);
  host.addEventListener('click', onClick);
  host.addEventListener('dblclick', onDbl);

  function setCurrent(i) {
    cur = i;
    if (curLi) curLi.classList.remove('jt-current');
    curLi = null;
    if (i < 0 || i >= matches.length) return;
    const rec = reveal(matches[i], { focus: false });
    if (rec) { curLi = rec.row; curLi.classList.add('jt-current'); rec.li.scrollIntoView({ block: 'center' }); }
  }

  const api = {
    setData(value) {
      cancelExpand();
      host.replaceChildren(); openSet = new Set(); rendered = []; matches = []; cur = -1; curLi = null; focusLi.cur = null;
      rootRec = null;
      if (value === undefined) return;
      ul = el('ul', { class: 'jt-tree', role: 'tree', 'aria-label': 'JSON tree' });
      rootRec = makeRec(null, null, value);
      ul.append(rootRec.li); host.append(ul);
      setOpen(rootRec, true);
      rootRec.li.tabIndex = 0; focusLi.cur = rootRec.li;
      if (q) api.search(q, mode);
    },
    hasData: () => !!rootRec,
    reveal(segs) { return reveal(segs); },
    expandAll, collapseAll,
    /** Set the search; returns { count, truncated }. Empty query clears highlights. */
    search(text, m = mode) {
      q = String(text || '').toLowerCase(); mode = m;
      if (curLi) { curLi.classList.remove('jt-current'); curLi = null; }
      matches = []; cur = -1; truncated = false;
      if (rootRec && q) { const r = searchData(rootRec.value, q, mode); matches = r.matches; truncated = r.truncated; }
      for (const rec of rendered) paint(rec);
      if (matches.length) setCurrent(0);
      return { count: matches.length, truncated, index: cur };
    },
    step(dir) {
      if (!matches.length) return { index: -1, count: 0 };
      setCurrent((cur + dir + matches.length) % matches.length);
      return { index: cur, count: matches.length };
    },
    destroy() { cancelExpand(); host.removeEventListener('keydown', onKey); host.removeEventListener('click', onClick); host.removeEventListener('dblclick', onDbl); host.replaceChildren(); },
  };
  void items; void toast;
  return api;
}
