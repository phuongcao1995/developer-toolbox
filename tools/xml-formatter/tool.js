// XML Formatter & Validator UI. All parsing/formatting is in logic.js (pure); heavy work (>1 MB) goes to worker.js.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, formatBytes, renderIcons, initTabs } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { createSplit } from '../../assets/js/components/split.js';
import * as L from './logic.js';

const HEAVY = 1_000_000;      // characters above which work moves to a Web Worker
const LIVE_MAX = 300_000;     // live well-formedness badge is skipped above this size
const MAX_FILE = 20 * 1024 * 1024;
const CHUNK = 200;            // tree rows rendered per batch
const XPATH_CAP = 500;

const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/** Runs logic ops in a module worker for big inputs; falls back to the main thread if workers are unavailable or fail. */
function createRunner() {
  let worker = null, seq = 0, broken = false;
  const pending = new Map();
  const failAll = msg => { for (const p of pending.values()) p.reject(new Error(msg)); pending.clear(); };
  const ensure = () => {
    if (worker || broken || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.crash ? p.reject(new Error(e.data.crash)) : p.resolve(e.data.result); };
      worker.onerror = () => { broken = true; failAll('worker failed'); worker?.terminate(); worker = null; };
    } catch { broken = true; worker = null; }
    return worker;
  };
  return {
    async run(op, text, opts) {
      if (text.length > HEAVY && ensure()) {
        try {
          return await new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ id, op, text, opts }); });
        } catch { /* fall back to the main thread below */ }
      }
      await new Promise(r => setTimeout(r, 0)); // let the "working" state paint
      return L.runOp(op, text, opts);
    },
    destroy() { failAll('closed'); worker?.terminate(); worker = null; },
  };
}

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      indent: $('#xf-indent'), wrap: $('#xf-wrap'), empty: $('#xf-empty'), trim: $('#xf-trim'), strip: $('#xf-strip'),
      input: $('#xf-input'), output: $('#xf-output'), msg: $('#xf-msg'), goto: $('#xf-goto'), live: $('#xf-live'),
      stats: $('#xf-stats'), outTitle: $('#xf-out-title'),
      tree: $('#xf-tree'), tsearch: $('#xf-tsearch'), thits: $('#xf-thits'),
      xp: $('#xf-xp'), xpmsg: $('#xf-xpmsg'), xpres: $('#xf-xpres'), xpex: $('#xf-xpex'),
      cprefix: $('#xf-cprefix'), ctext: $('#xf-ctext'), croot: $('#xf-croot'), carray: $('#xf-carray'), ccoerce: $('#xf-ccoerce'), cdecl: $('#xf-cdecl'),
      info: $('#xf-info'),
    };
    const store = (k, d) => { try { return ctx.storage.get(k, d) ?? d; } catch { return d; } };
    const save = (k, v) => { try { ctx.storage.set(k, v); } catch { /* ignore */ } };

    // ---- persisted options
    els.indent.value = store('indent', ctx.indentUnit === '\t' ? 'tab' : ctx.indentUnit === '    ' ? '4' : '2');
    els.wrap.value = store('wrap', 'never'); els.empty.value = store('empty', 'keep');
    els.trim.checked = store('trim', true); els.strip.checked = store('strip', false);
    els.cprefix.value = store('cprefix', '@'); els.ctext.value = store('ctext', '#text'); els.croot.value = store('croot', 'root');
    els.carray.checked = store('carray', false); els.ccoerce.checked = store('ccoerce', false); els.cdecl.checked = store('cdecl', true);
    for (const [k, e] of Object.entries({ indent: els.indent, wrap: els.wrap, empty: els.empty, cprefix: els.cprefix, ctext: els.ctext, croot: els.croot })) {
      e.addEventListener('change', () => save(k, e.value));
    }
    for (const [k, e] of Object.entries({ trim: els.trim, strip: els.strip, carray: els.carray, ccoerce: els.ccoerce, cdecl: els.cdecl })) {
      e.addEventListener('change', () => save(k, e.checked));
    }

    const edIn = createEditor(els.input, { language: 'xml', storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false });
    const edOut = createEditor(els.output, { language: 'xml', storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, readOnly: true, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const split = createSplit($('.xf-panels'), { direction: 'horizontal', storage: ctx.storage, storageKey: 'panels', labels: ['input', 'output'] });
    const runner = createRunner();
    const disposers = [];
    const on = (target, ev, fn) => { target.addEventListener(ev, fn); disposers.push(() => target.removeEventListener(ev, fn)); };

    let outKind = 'xml', outName = 'formatted.xml', gotoOffset = null, runToken = 0;
    let info = null, infoFor = null;      // last summarize() result and the input text it belongs to
    let parsed = null;                    // { text, r } cache of the last full parse on the main thread
    let destroyed = false;

    const indentUnit = () => (els.indent.value === 'tab' ? '\t' : ' '.repeat(Number(els.indent.value)));
    const formatOpts = () => ({
      indent: indentUnit(), wrap: els.wrap.value === 'never' || els.wrap.value === 'always' ? els.wrap.value : Number(els.wrap.value),
      selfClosing: els.empty.value, trimText: els.trim.checked, stripComments: els.strip.checked,
    });
    const convOpts = () => ({
      attrPrefix: els.cprefix.value, textKey: els.ctext.value || '#text', rootName: els.croot.value.trim() || 'root',
      forceArray: els.carray.checked, coerce: els.ccoerce.checked, declaration: els.cdecl.checked, indent: indentUnit(), trimText: els.trim.checked,
    });

    const getParsed = () => {
      const text = els.input.value;
      if (!parsed || parsed.text !== text) parsed = { text, r: L.parse(text) };
      return parsed.r;
    };

    // ---- messages
    const showError = (error, extra = '') => {
      gotoOffset = error.offset ?? null;
      showMessage(els.msg, 'error', `${L.formatError(error)}${extra}`);
      els.goto.hidden = gotoOffset == null;
    };
    const clearMsg = () => { showMessage(els.msg, null); els.goto.hidden = true; gotoOffset = null; };
    const jsonHint = text => (/^\s*[[{]/.test(text) ? '\nThis looks like JSON. Use XML → JSON / JSON → XML in the "XML ↔ JSON" tab to convert it.' : '');
    const setOutput = (text, kind, name, title) => {
      outKind = kind; outName = name; els.output.value = text;
      edOut.setLanguage(kind === 'json' ? 'json' : 'xml'); els.outTitle.textContent = title;
    };
    const clearOutput = () => { els.output.value = ''; els.stats.replaceChildren(); };
    const badge = (text, cls = 'badge') => { const b = mk('span', cls, text); els.stats.append(b); };
    const setStats = (label, before, after, i) => {
      els.stats.replaceChildren();
      badge(label, 'badge badge-info');
      if (after != null) {
        const s = L.sizeStats(before, after);
        badge(`Before: ${formatBytes(s.before)}`); badge(`After: ${formatBytes(s.after)}`);
        badge(`${Math.abs(s.percent).toFixed(1)}% ${s.saved >= 0 ? 'smaller' : 'larger'}`, `badge ${s.saved >= 0 ? 'badge-success' : 'badge-warn'}`);
      }
      if (i) { badge(`${i.stats.elements} elements`); badge(`${i.stats.attributes} attributes`); badge(`depth ${i.stats.maxDepth}`); }
    };

    // ---- main actions
    async function run(op) {
      const text = els.input.value;
      clearMsg();
      if (!text.trim()) { showMessage(els.msg, 'warn', 'Enter, paste or upload some XML first.'); clearOutput(); return; }
      const token = ++runToken;
      const buttons = ['#xf-format', '#xf-minify', '#xf-validate', '#xf-toJson', '#xf-fromJson'].map(s => $(s));
      buttons.forEach(b => { b.disabled = true; });
      showMessage(els.msg, 'info', text.length > HEAVY ? 'Working on a large document…' : 'Working…');
      try {
        const opts = op === 'toJson' || op === 'fromJson' ? convOpts() : formatOpts();
        const res = await runner.run(op, text, opts);
        if (destroyed || token !== runToken) return;
        clearMsg();
        if (!res.ok) {
          if (op !== 'fromJson') clearOutput();
          showError(res.error, op === 'fromJson' ? '' : jsonHint(text));
          if (op !== 'validate') els.stats.replaceChildren();
          if (op === 'validate') setStats('Invalid', 0, null, null);
          return;
        }
        const notes = (res.warnings || []);
        if (op === 'fromJson') {
          setOutput(res.text, 'xml', 'converted.xml', 'Output (XML)');
          setStats('JSON → XML', text, res.text);
        } else {
          info = res.info; infoFor = text; renderInfo();
          if (op === 'validate') {
            setStats('Well-formed', 0, null, res.info);
            badge(`Root: <${res.info.root}>`);
          } else if (op === 'toJson') {
            setOutput(res.text, 'json', 'converted.json', 'Output (JSON)'); setStats('XML → JSON', text, res.text, res.info);
          } else {
            setOutput(res.text, 'xml', op === 'format' ? 'formatted.xml' : 'minified.xml', op === 'format' ? 'Output (formatted XML)' : 'Output (minified XML)');
            setStats(op === 'format' ? 'Formatted' : 'Minified', text, res.text, res.info);
          }
        }
        if (op === 'validate') showMessage(els.msg, notes.length ? 'warn' : 'success', `The document is well-formed.${notes.length ? '\n' + notes.join('\n') : ''}`);
        else if (notes.length) showMessage(els.msg, 'warn', notes.join('\n'));
      } catch (e) {
        if (!destroyed && token === runToken) { clearOutput(); showMessage(els.msg, 'error', `Unexpected error: ${e.message}`); }
      } finally { buttons.forEach(b => { b.disabled = false; }); }
    }

    async function loadFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE) { showMessage(els.msg, 'error', `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE)}.`); return; }
      try { els.input.value = await readFileAsText(file); els.input.dispatchEvent(new Event('input', { bubbles: true })); clearMsg(); clearOutput(); }
      catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    // ---- live check (small inputs only)
    const live = ctx.debounce(() => {
      if (destroyed) return;
      const text = els.input.value;
      els.live.className = 'badge';
      if (!text.trim()) { els.live.textContent = ''; return; }
      if (text.length > LIVE_MAX) { els.live.textContent = 'Live check off (large input)'; return; }
      const r = getParsed();
      els.live.className = r.ok ? 'badge badge-success' : 'badge badge-danger';
      els.live.textContent = r.ok ? 'Well-formed' : `Error at ${r.error.line}:${r.error.column}`;
      els.live.title = r.ok ? '' : r.error.message;
    }, 350);
    on(els.input, 'input', () => { live(); treeStale = true; });

    // ================================================================ tree explorer
    let treeStale = true, treeEntities = null, treeRoot = null;
    const states = new WeakMap(); // element node -> { li, ul, rendered, kids, open, toggle }
    const rows = new WeakMap();   // any node/attr entry -> row element

    const isBlankText = s => !/[^ \t\r\n]/.test(s);
    const kidsOf = node => {
      const out = [];
      for (const a of node.attrs) out.push({ kind: 'attr', attr: a, owner: node });
      for (const c of node.children) {
        if (c.type === 'text' && isBlankText(c.value)) continue;
        out.push({ kind: c.type, node: c });
      }
      return out;
    };
    const lineOf = off => parsed?.r.ok ? L.positionAt(parsed.r.doc.lineStarts, off, parsed.r.doc.bom).line : '';
    const truncate = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

    function makeRow(entry) {
      const li = mk('li'); const row = mk('div', 'xf-row'); li.append(row);
      const act = (label, aria, fn) => { const b = mk('button', 'xf-act', label); b.type = 'button'; b.setAttribute('aria-label', aria); b.addEventListener('click', fn); return b; };
      if (entry.kind === 'attr') {
        row.append(mk('span', 'xf-tog-gap'));
        const l = mk('span', 'xf-lbl'); l.append(mk('span', 'xf-an', `@${entry.attr.name}`), mk('span', 'xf-muted', ' = '), mk('span', 'xf-av', `"${truncate(L.decodeEntities(entry.attr.raw, treeEntities))}"`));
        row.append(l, act('XPath', `Copy XPath of attribute ${entry.attr.name}`, () => copyText(L.xpathOfAttr(entry.owner, entry.attr.name), 'XPath copied')));
        rows.set(entry.attr, li); return li;
      }
      const node = entry.node;
      if (node.type === 'element') {
        const kids = kidsOf(node); const st = { li, ul: null, rendered: 0, kids, open: false, toggle: null };
        states.set(node, st);
        if (kids.length) {
          const tg = mk('button', 'xf-tog', '▸'); tg.type = 'button'; tg.setAttribute('aria-expanded', 'false'); tg.setAttribute('aria-label', `Expand ${node.name}`);
          tg.addEventListener('click', () => setOpen(node, !st.open)); st.toggle = tg; row.append(tg);
        } else row.append(mk('span', 'xf-tog-gap'));
        const l = mk('span', 'xf-lbl'); l.append(mk('span', 'xf-name', `<${node.name}${kids.length ? '' : '/'}>`));
        const nAttr = node.attrs.length, nEl = node.children.filter(c => c.type === 'element').length;
        if (kids.length) l.append(mk('span', 'xf-ln', [nAttr ? `${nAttr} attr` : '', nEl ? `${nEl} child` : ''].filter(Boolean).join(', ')));
        l.append(mk('span', 'xf-ln', `line ${lineOf(node.offset)}`));
        row.append(l, act('XPath', `Copy XPath of ${node.name}`, () => copyText(L.xpathOf(node), 'XPath copied')));
      } else {
        row.append(mk('span', 'xf-tog-gap'));
        const l = mk('span', 'xf-lbl');
        if (node.type === 'text') l.append(mk('span', 'xf-txt', `"${truncate(L.nodeLabel(node, treeEntities))}"`));
        else if (node.type === 'cdata') l.append(mk('span', 'xf-muted', 'CDATA '), mk('span', 'xf-txt', `"${truncate(L.nodeLabel(node))}"`));
        else if (node.type === 'comment') l.append(mk('span', 'xf-muted', `<!-- ${truncate(L.nodeLabel(node))} -->`));
        else l.append(mk('span', 'xf-muted', `<?${truncate(L.nodeLabel(node))}?>`));
        row.append(l);
        if (node.type === 'text' || node.type === 'cdata') row.append(act('Copy', 'Copy text', () => copyText(node.type === 'text' ? L.decodeEntities(node.value, treeEntities).trim() : node.value)));
      }
      rows.set(node, li); return li;
    }
    function renderChunk(st) {
      st.ul.querySelector(':scope > li.xf-morewrap')?.remove();
      const end = Math.min(st.kids.length, st.rendered + CHUNK);
      for (; st.rendered < end; st.rendered++) st.ul.append(makeRow(st.kids[st.rendered]));
      if (st.rendered < st.kids.length) {
        const li = mk('li', 'xf-morewrap'); const b = mk('button', 'btn btn-sm xf-more', `Show ${Math.min(CHUNK, st.kids.length - st.rendered)} more (${st.kids.length - st.rendered} remaining)`);
        b.type = 'button'; b.addEventListener('click', () => renderChunk(st)); li.append(b); st.ul.append(li);
      }
    }
    function setOpen(node, open) {
      const st = states.get(node); if (!st || !st.toggle) return;
      if (open && !st.ul) { st.ul = mk('ul'); st.li.append(st.ul); renderChunk(st); }
      st.open = open; if (st.ul) st.ul.hidden = !open;
      st.toggle.textContent = open ? '▾' : '▸'; st.toggle.setAttribute('aria-expanded', String(open)); st.toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${node.name}`);
    }
    function buildTree() {
      els.tree.replaceChildren(); els.thits.replaceChildren();
      const text = els.input.value;
      if (!text.trim()) { els.tree.append(mk('p', 'hint', 'Enter some XML, then open this tab (or press "Rebuild from input").')); return; }
      const r = getParsed();
      treeStale = false;
      if (!r.ok) { const p = mk('p', 'alert alert-error', L.formatError(r.error)); p.setAttribute('role', 'alert'); els.tree.append(p); return; }
      treeEntities = r.entities; treeRoot = r.doc.root;
      const ul = mk('ul'); ul.append(makeRow({ kind: 'element', node: r.doc.root })); els.tree.append(ul);
      expandDepth(r.doc.root, 2);
    }
    function expandDepth(node, depth, budget = { n: 3000 }) {
      if (depth <= 0 || budget.n <= 0) return;
      setOpen(node, true);
      const st = states.get(node); if (!st) return;
      for (const k of st.kids.slice(0, st.rendered)) if (k.kind === 'element') { if (--budget.n <= 0) return; expandDepth(k.node, depth - 1, budget); }
    }
    function reveal(node) {
      const chain = []; for (let c = node; c; c = c.parent) chain.unshift(c);
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i], st = states.get(a); if (!st) return;
        setOpen(a, true);
        const idx = st.kids.findIndex(k => k.node === chain[i + 1]);
        while (st.rendered <= idx && st.rendered < st.kids.length) renderChunk(st);
      }
      const li = rows.get(node);
      const row = li?.firstElementChild; if (!row) return;
      row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1500);
      (row.querySelector('.xf-act') || row.querySelector('.xf-tog'))?.focus({ preventScroll: true });
    }
    function revealHit(node) {
      // text/cdata/comment nodes live under their parent element's list
      reveal(node.type === 'element' ? node : node);
    }
    const searchTree = ctx.debounce(() => {
      els.thits.replaceChildren();
      const q = els.tsearch.value.trim(); if (!q) return;
      if (treeStale || !treeRoot) buildTree();
      if (!treeRoot) return;
      const hits = L.searchTree(treeRoot, q, treeEntities, 300);
      els.thits.append(mk('div', '', hits.length ? `${hits.length >= 300 ? '300+' : hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length >= 300 ? ' (showing the first 300)' : ''}. Choose one to reveal it in the tree.` : 'No matches.'));
      if (!hits.length) return;
      const ul = mk('ul');
      for (const h of hits) {
        const li = mk('li'); const b = mk('button', '', ''); b.type = 'button';
        const label = h.node.type === 'element' ? `<${h.node.name}>` : truncate(L.nodeLabel(h.node, treeEntities), 80);
        b.append(mk('span', '', label), mk('span', 'why', `${h.why} · line ${lineOf(h.node.offset)}`));
        b.addEventListener('click', () => revealHit(h.node)); li.append(b); ul.append(li);
      }
      els.thits.append(ul);
    }, 250);
    on(els.tsearch, 'input', searchTree);

    // ================================================================ XPath
    let xpText = '';
    for (const ex of ['//*', '//@*', '//*[@id]', "//text()[normalize-space()]", 'count(//*)', '//comment()']) {
      const b = mk('button', '', ex); b.type = 'button'; b.addEventListener('click', () => { els.xp.value = ex; runXPath(); }); els.xpex.append(b);
    }
    const domPath = n => {
      const parts = [];
      let c = n;
      if (c.nodeType === 2) { parts.push(`@${c.nodeName}`); c = c.ownerElement; }
      for (; c && c.nodeType !== 9; c = c.parentNode) {
        if (c.nodeType === 1) {
          let idx = 1; for (let s = c.previousElementSibling; s; s = s.previousElementSibling) if (s.nodeName === c.nodeName) idx++;
          parts.push(`${c.nodeName}[${idx}]`);
        } else if (c.nodeType === 3 || c.nodeType === 4) parts.push('text()'); else if (c.nodeType === 8) parts.push('comment()');
      }
      return '/' + parts.reverse().join('/');
    };
    function runXPath() {
      showMessage(els.xpmsg, null); els.xpres.replaceChildren(); xpText = '';
      const expr = els.xp.value.trim();
      if (!expr) { showMessage(els.xpmsg, 'warn', 'Enter an XPath expression.'); return; }
      if (!els.input.value.trim()) { showMessage(els.xpmsg, 'warn', 'Enter some XML in the input first.'); return; }
      const r = getParsed();
      if (!r.ok) { showMessage(els.xpmsg, 'error', `The input is not well-formed, so it cannot be queried.\n${L.formatError(r.error)}`); return; }
      try {
        const dom = new DOMParser().parseFromString(els.input.value.replace(/^﻿/, ''), 'application/xml');
        const perr = dom.getElementsByTagName('parsererror')[0];
        if (perr) { showMessage(els.xpmsg, 'error', `The browser XML parser rejected the document: ${perr.textContent.trim().slice(0, 300)}`); return; }
        const nsMap = {}; for (const n of r.namespaces) if (n.prefix && !(n.prefix in nsMap)) nsMap[n.prefix] = n.uri;
        const base = dom.createNSResolver(dom.documentElement);
        const resolver = p => (Object.prototype.hasOwnProperty.call(nsMap, p) ? nsMap[p] : base.lookupNamespaceURI(p));
        const res = dom.evaluate(expr, dom, resolver, XPathResult.ANY_TYPE, null);
        const lines = [];
        const summary = txt => { els.xpres.append(mk('p', 'hint', txt)); };
        if (res.resultType === XPathResult.NUMBER_TYPE) { summary(`Number: ${res.numberValue}`); lines.push(String(res.numberValue)); }
        else if (res.resultType === XPathResult.STRING_TYPE) { summary(`String: ${res.stringValue}`); lines.push(res.stringValue); }
        else if (res.resultType === XPathResult.BOOLEAN_TYPE) { summary(`Boolean: ${res.booleanValue}`); lines.push(String(res.booleanValue)); }
        else {
          const ser = new XMLSerializer(); let n, count = 0, capped = false;
          const list = mk('div', 'xf-xpres');
          while ((n = res.iterateNext())) {
            if (count >= XPATH_CAP) { capped = true; break; }
            count++;
            const item = mk('div', 'xf-xpitem'); let kind, preview;
            if (n.nodeType === 1) { kind = 'element'; preview = ser.serializeToString(n); }
            else if (n.nodeType === 2) { kind = 'attribute'; preview = `${n.nodeName}="${n.value}"`; }
            else if (n.nodeType === 3 || n.nodeType === 4) { kind = 'text'; preview = n.nodeValue; }
            else if (n.nodeType === 8) { kind = 'comment'; preview = `<!--${n.nodeValue}-->`; }
            else if (n.nodeType === 7) { kind = 'processing instruction'; preview = `<?${n.target} ${n.data}?>`; }
            else { kind = `node type ${n.nodeType}`; preview = n.nodeValue ?? ''; }
            lines.push(n.nodeType === 1 ? preview : (n.nodeType === 2 ? n.value : preview));
            item.append(mk('div', 'path', `#${count} ${kind} · ${domPath(n)}`), mk('pre', '', truncate(preview, 600)));
            list.append(item);
          }
          summary(`${count}${capped ? '+' : ''} node${count === 1 ? '' : 's'} matched${capped ? ` (showing the first ${XPATH_CAP})` : ''}.`);
          els.xpres.append(list);
        }
        xpText = lines.join('\n');
      } catch (e) {
        showMessage(els.xpmsg, 'error', `XPath error: ${e.message}`);
      }
    }
    on($('#xf-xprun'), 'click', runXPath);
    on(els.xp, 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runXPath(); } });
    on($('#xf-xpcopy'), 'click', () => copyText(xpText, 'Results copied'));

    // ================================================================ Info tab
    function renderInfo() {
      els.info.replaceChildren();
      const text = els.input.value;
      if (!info || infoFor !== text) {
        els.info.append(mk('p', 'hint', text.trim() ? 'Statistics are computed by Validate, Format or Minify. Press Validate to refresh them.' : 'Enter some XML to see statistics.'));
        return;
      }
      const table = rowsArr => { const t = mk('table'); for (const [k, v] of rowsArr) { const tr = mk('tr'); const th = mk('th', '', k); th.scope = 'row'; tr.append(th, mk('td', '', String(v))); t.append(tr); } return t; };
      const s = info.stats, bytes = new TextEncoder().encode(text).length;
      els.info.append(mk('h4', '', 'Document'), table([
        ['Root element', `<${info.root}>`], ['Size', `${formatBytes(bytes)} (${bytes} bytes, ${text.length} characters)`],
        ['XML declaration', info.decl ? `version ${info.decl.version}${info.decl.encoding ? `, encoding ${info.decl.encoding}` : ''}${info.decl.standalone ? `, standalone ${info.decl.standalone}` : ''}` : 'none'],
        ['DOCTYPE', info.doctype ? `${info.doctype.name}${info.doctype.systemId ? ` (SYSTEM "${info.doctype.systemId}", never loaded)` : ''}` : 'none'],
        ['Byte order mark', info.bom ? 'present' : 'none'],
      ]), mk('h4', '', 'Counts'), table([
        ['Elements', s.elements], ['Unique element names', s.uniqueNames], ['Attributes', s.attributes], ['Text nodes (non-blank)', s.textNodes],
        ['Comments', s.comments], ['CDATA sections', s.cdata], ['Processing instructions', s.pis], ['Entity declarations', s.entityDecls], ['Maximum depth', s.maxDepth],
      ]));
      els.info.append(mk('h4', '', 'Namespaces'));
      if (!info.namespaces.length) els.info.append(mk('p', 'hint', 'No namespace declarations.'));
      else {
        const wrap = mk('div', 'scroll'); const t = mk('table');
        const head = mk('tr'); for (const h of ['Prefix', 'URI', 'Declared on', 'Line']) { const th = mk('th', '', h); th.scope = 'col'; head.append(th); }
        t.append(head);
        for (const n of info.namespaces) { const tr = mk('tr'); tr.append(mk('td', '', n.prefix || '(default)'), mk('td', '', n.uri), mk('td', '', `<${n.element}>`), mk('td', '', String(n.line))); t.append(tr); }
        wrap.append(t); els.info.append(wrap);
      }
      if (info.warnings.length) { els.info.append(mk('h4', '', 'Warnings')); const ul = mk('ul'); for (const w of info.warnings) ul.append(mk('li', '', w)); els.info.append(ul); }
    }

    // ---- tabs
    const selectTab = initTabs($('.xf-tabs'), name => {
      if (name === 'tree' && (treeStale || !els.tree.firstChild)) buildTree();
      if (name === 'info') {
        if (els.input.value.trim() && (!info || infoFor !== els.input.value)) { const r = getParsed(); if (r.ok) { info = L.summarize(r); infoFor = els.input.value; } }
        renderInfo();
      }
    });
    void selectTab;

    // ---- wiring
    on($('#xf-format'), 'click', () => run('format'));
    on($('#xf-minify'), 'click', () => run('minify'));
    on($('#xf-validate'), 'click', () => run('validate'));
    on($('#xf-toJson'), 'click', () => run('toJson'));
    on($('#xf-fromJson'), 'click', () => run('fromJson'));
    on($('#xf-trefresh'), 'click', buildTree);
    on($('#xf-texpand'), 'click', () => { if (!treeRoot) return; const b = { n: 3000 }; const all = n => { if (b.n-- <= 0) return; setOpen(n, true); const st = states.get(n); if (!st) return; while (st.rendered < st.kids.length && b.n > 0) renderChunk(st); for (const k of st.kids) if (k.kind === 'element' && rows.has(k.node)) all(k.node); }; all(treeRoot); if (b.n <= 0) toast('Expanded the first 3000 nodes only', 'info'); });
    on($('#xf-tcollapse'), 'click', () => { if (treeRoot) { for (const k of states.get(treeRoot)?.kids || []) if (k.kind === 'element') collapseAll(k.node); setOpen(treeRoot, true); } });
    const collapseAll = n => { const st = states.get(n); if (!st) return; setOpen(n, false); for (const k of st.kids.slice(0, st.rendered)) if (k.kind === 'element') collapseAll(k.node); };
    on(els.goto, 'click', () => { if (gotoOffset != null) edIn.select(gotoOffset, Math.min(gotoOffset + 1, els.input.value.length)); });
    on($('#xf-sample'), 'click', () => { els.input.value = L.SAMPLE; els.input.dispatchEvent(new Event('input', { bubbles: true })); clearMsg(); clearOutput(); });
    on($('#xf-upload'), 'click', async () => loadFile(await pickFile('.xml,.svg,.xsd,.xsl,.xslt,.rss,.atom,.plist,.kml,.gpx,.json,.txt')));
    on($('#xf-clear'), 'click', () => { els.input.value = ''; els.input.dispatchEvent(new Event('input', { bubbles: true })); clearOutput(); clearMsg(); els.input.focus(); });
    on($('#xf-copy'), 'click', () => copyText(els.output.value));
    on($('#xf-download'), 'click', () => downloadFile(outName, els.output.value, outKind === 'json' ? 'application/json;charset=utf-8' : 'application/xml;charset=utf-8'));
    on($('#xf-swap'), 'click', () => {
      if (!els.output.value) { toast('Nothing to move: run Format, Minify or a conversion first', 'warn'); return; }
      els.input.value = els.output.value; els.input.dispatchEvent(new Event('input', { bubbles: true })); clearOutput(); clearMsg();
    });
    on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run('format'); } });
    disposers.push(enableDrop($('#xf-drop'), loadFile));
    renderIcons(root);
    live();

    return () => {
      destroyed = true; runToken++; live.cancel(); searchTree.cancel();
      disposers.forEach(d => d()); runner.destroy(); split.destroy(); edIn.destroy(); edOut.destroy();
    };
  },
};
