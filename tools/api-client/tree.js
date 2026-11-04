// Lightweight collapsible JSON tree: lazy rendering, paging, search, keyboard navigation (WAI-ARIA tree pattern).
// All text goes through textContent. The pure helpers (formatPath, searchTree, ...) have no DOM dependency.

export const PAGE_SIZE = 200;
const isObj = v => v !== null && typeof v === 'object';
const IDENT = /^[A-Za-z_$][\w$]*$/;

export const childKeys = v => (Array.isArray(v) ? Array.from({ length: v.length }, (_, i) => i) : isObj(v) ? Object.keys(v) : []);
export const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** JSONPath-like accessor: ['a', 0, 'b c'] -> $.a[0]["b c"] */
export function formatPath(path) {
  return '$' + path.map(k => (typeof k === 'number' ? `[${k}]` : IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('');
}
/** Short single-line preview of a value. */
export function previewValue(v, max = 120) {
  if (typeof v === 'string') { const s = v.length > max ? v.slice(0, max) + '…' : v; return JSON.stringify(s); }
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (isObj(v)) return `Object{${Object.keys(v).length}}`;
  return String(v);
}
/** Text copied by "copy value": JSON for containers, the raw text for strings, literals otherwise. */
export const copyValueText = v => (typeof v === 'string' ? v : isObj(v) ? JSON.stringify(v, null, 2) : String(v));

/**
 * Iterative search over keys and primitive values (case-insensitive substring).
 * Returns { matches: [{path, where}], truncated } — capped by maxMatches / maxScan so huge documents stay responsive.
 */
export function searchTree(value, query, { maxMatches = 500, maxScan = 250000 } = {}) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return { matches: [], truncated: false };
  const matches = []; let scanned = 0, truncated = false;
  const stack = [{ v: value, key: null, parent: null }];
  const pathOf = n => { const p = []; for (let x = n; x && x.parent; x = x.parent) p.push(x.key); return p.reverse(); };
  while (stack.length) {
    const n = stack.pop();
    if (++scanned > maxScan) { truncated = true; break; }
    const keyHit = n.parent && typeof n.key === 'string' && n.key.toLowerCase().includes(q);
    const valHit = !isObj(n.v) && String(n.v).toLowerCase().includes(q);
    if (keyHit || valHit) { matches.push({ path: pathOf(n), where: keyHit ? 'key' : 'value' }); if (matches.length >= maxMatches) { truncated = true; break; } }
    if (isObj(n.v)) { const ks = childKeys(n.v); for (let i = ks.length - 1; i >= 0; i--) stack.push({ v: n.v[ks[i]], key: ks[i], parent: n }); }
  }
  return { matches, truncated };
}

/**
 * Mount a tree into host. opts: { pageSize, copy(text,label), search: {maxMatches,maxScan} }.
 * Returns { destroy, expandAll(limit), collapseAll, search(q) -> {count, truncated}, next(), prev(), clearSearch }.
 */
export function createJsonTree(host, value, opts = {}) {
  const page = opts.pageSize || PAGE_SIZE;
  const copy = opts.copy || (() => {});
  const doc = host.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  host.replaceChildren();
  const rootUl = el('ul', 'jt-tree'); rootUl.setAttribute('role', 'tree'); rootUl.setAttribute('aria-label', 'JSON response tree');
  host.append(rootUl);
  let hits = [], hitIdx = -1;

  // node: { value, key, path, level, li, row, group, expanded, shown, keys }
  function build(value, key, path, level) {
    const n = { value, key, path, level, expanded: false, shown: 0, keys: childKeys(value), children: new Map() };
    const container = isObj(value) && n.keys.length > 0;
    const li = el('li', 'jt-item'); li.setAttribute('role', 'treeitem'); li.setAttribute('aria-level', String(level)); li.tabIndex = -1; li._node = n;
    const row = el('div', 'jt-row');
    const caret = el('span', 'jt-caret', container ? '▸' : ''); caret.setAttribute('aria-hidden', 'true');
    row.append(caret);
    if (key !== null) { row.append(el('span', 'jt-key', typeof key === 'number' ? String(key) : JSON.stringify(key)), el('span', 'jt-colon', ': ')); }
    const t = typeOf(value);
    const val = el('span', `jt-val jt-${t}`, container || isObj(value) ? (Array.isArray(value) ? `[${value.length}]` : `{${n.keys.length}}`) : previewValue(value));
    if (typeof value === 'string' && value.length > 120) val.title = `${value.length} characters`;
    row.append(val);
    const mk = (label, aria, fn) => { const b = el('button', 'jt-btn', label); b.type = 'button'; b.tabIndex = -1; b.setAttribute('aria-label', aria); b.addEventListener('click', e => { e.stopPropagation(); fn(); }); return b; };
    row.append(mk('path', `Copy path ${formatPath(path)}`, () => copy(formatPath(path), 'Path copied')), mk('copy', 'Copy value', () => copy(copyValueText(value), 'Value copied')));
    li.append(row);
    n.li = li; n.row = row; n.caret = caret;
    if (container) {
      li.setAttribute('aria-expanded', 'false');
      n.group = el('ul', 'jt-group'); n.group.setAttribute('role', 'group'); n.group.hidden = true; li.append(n.group);
      row.addEventListener('click', e => { if (e.target.closest('.jt-btn')) return; focusNode(n); toggle(n); });
    } else row.addEventListener('click', e => { if (!e.target.closest('.jt-btn')) focusNode(n); });
    return n;
  }
  function renderChildren(n) {
    const end = Math.min(n.keys.length, n.shown + page);
    n.group.querySelector(':scope > li.jt-more')?.remove();
    for (let i = n.shown; i < end; i++) {
      const k = n.keys[i];
      const c = build(n.value[k], k, [...n.path, k], n.level + 1); n.children.set(k, c); n.group.append(c.li);
    }
    n.shown = end;
    if (hits.length) applyMarks();
    if (end < n.keys.length) {
      const li = el('li', 'jt-more'); li.setAttribute('role', 'none');
      const b = el('button', 'btn btn-sm', `Show more (${n.keys.length - end} remaining)`); b.type = 'button';
      b.addEventListener('click', () => { renderChildren(n); });
      li.append(b); n.group.append(li);
    }
  }
  function expand(n) {
    if (!n.group || n.expanded) return;
    n.expanded = true; n.group.hidden = false; n.li.setAttribute('aria-expanded', 'true'); n.caret.textContent = '▾';
    if (!n.shown) renderChildren(n);
  }
  function collapse(n) {
    if (!n.group || !n.expanded) return;
    n.expanded = false; n.group.hidden = true; n.li.setAttribute('aria-expanded', 'false'); n.caret.textContent = '▸';
  }
  const toggle = n => (n.expanded ? collapse(n) : expand(n));

  const root = build(value, null, [], 1);
  root.li.classList.add('jt-root');
  rootUl.append(root.li);
  const visible = () => [...rootUl.querySelectorAll('li.jt-item')].filter(li => !li.parentElement.closest('ul[hidden]'));
  let current = root;
  function focusNode(n) {
    current.li.tabIndex = -1; current = n; n.li.tabIndex = 0; n.li.focus({ preventScroll: false });
  }
  root.li.tabIndex = 0;
  if (root.group) expand(root);

  rootUl.addEventListener('keydown', e => {
    const li = e.target.closest?.('li.jt-item');
    if (!li || e.target !== li || e.ctrlKey || e.altKey || e.metaKey) return;
    const n = li._node, list = visible(), i = list.indexOf(li);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': if (list[i + 1]) focusNode(list[i + 1]._node); break;
      case 'ArrowUp': if (list[i - 1]) focusNode(list[i - 1]._node); break;
      case 'Home': focusNode(list[0]._node); break;
      case 'End': focusNode(list[list.length - 1]._node); break;
      case 'ArrowRight': if (n.group && !n.expanded) expand(n); else if (n.group && n.expanded && n.children.size) focusNode(n.children.values().next().value); break;
      case 'ArrowLeft': if (n.group && n.expanded) collapse(n); else { const p = li.parentElement.closest('li.jt-item'); if (p) focusNode(p._node); } break;
      case 'Enter': case ' ': if (n.group) toggle(n); break;
      case 'c': case 'C': copy(copyValueText(n.value), 'Value copied'); break;
      case 'p': case 'P': copy(formatPath(n.path), 'Path copied'); break;
      case '*': { const par = li.parentElement.closest('li.jt-item')?._node; if (par) for (const s of par.children.values()) expand(s); break; }
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  /** Ensure the node at path is rendered (expanding ancestors and paging as needed). */
  function reveal(path) {
    let n = root;
    if (n.group) expand(n);
    for (const k of path) {
      if (!n.group) return null;
      expand(n);
      const idx = n.keys.findIndex(x => x === k);
      if (idx < 0) return null;
      while (n.shown <= idx) renderChildren(n);
      n = n.children.get(k);
      if (!n) return null;
    }
    return n;
  }
  const applyMarks = () => { const keys = new Set(hits.map(h => JSON.stringify(h.path))); for (const li of rootUl.querySelectorAll('li.jt-item')) li.firstChild.classList.toggle('jt-match', keys.size > 0 && keys.has(JSON.stringify(li._node.path))); };
  function goto(i) {
    if (!hits.length) return;
    if (hits[hitIdx]) { const old = reveal(hits[hitIdx].path); if (old) old.row.classList.remove('jt-current'); }
    hitIdx = (i + hits.length) % hits.length;
    const n = reveal(hits[hitIdx].path);
    if (n) { n.row.classList.add('jt-current'); focusNode(n); n.row.scrollIntoView?.({ block: 'nearest' }); }
  }
  function clearSearch() {
    rootUl.querySelectorAll('.jt-match,.jt-current').forEach(x => x.classList.remove('jt-match', 'jt-current'));
    hits = []; hitIdx = -1;
  }
  return {
    root: rootUl,
    destroy() { host.replaceChildren(); },
    expandAll(limit = 2000) {
      let budget = limit, capped = false;
      let level = [root];
      while (level.length && !capped) {
        const nextLevel = [];
        for (const n of level) {
          if (!n.group) continue;
          if (budget <= 0) { capped = true; break; }
          expand(n); budget -= n.shown;
          for (const c of n.children.values()) nextLevel.push(c);
        }
        level = nextLevel;
      }
      return { capped };
    },
    collapseAll() { for (const li of rootUl.querySelectorAll('li.jt-item')) { const n = li._node; if (n !== root) collapse(n); } if (root.group) expand(root); },
    search(q) {
      clearSearch();
      const r = searchTree(value, q, opts.search);
      hits = r.matches;
      // mark only what is already rendered; reveal on navigation keeps the DOM small
      applyMarks();
      if (hits.length) goto(0);
      return { count: hits.length, truncated: r.truncated, index: hitIdx };
    },
    next() { goto(hitIdx + 1); return hitIdx; },
    prev() { goto(hitIdx - 1); return hitIdx; },
    clearSearch,
  };
}
