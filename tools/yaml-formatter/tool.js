// YAML Formatter & Validator UI. Parsing/dumping use the vendored js-yaml (loaded lazily); everything else is in logic.js.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, formatBytes, renderIcons, initTabs, confirmDialog } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { createSplit } from '../../assets/js/components/split.js';
import * as L from './logic.js';

const YAML_SRC = 'assets/js/vendor/js-yaml.min.js';
const LIVE_MAX = 300_000;
const MAX_FILE = 20 * 1024 * 1024;
const CHUNK = 200;
const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      indent: $('#yf-indent'), width: $('#yf-width'), quote: $('#yf-quote'), flow: $('#yf-flow'),
      sort: $('#yf-sort'), expand: $('#yf-expand'), force: $('#yf-force'), dups: $('#yf-dups'), warn: $('#yf-warn'),
      input: $('#yf-input'), output: $('#yf-output'), msg: $('#yf-msg'), goto: $('#yf-goto'), live: $('#yf-live'),
      stats: $('#yf-stats'), outTitle: $('#yf-out-title'), checks: $('#yf-checks'),
      tree: $('#yf-tree'), tsearch: $('#yf-tsearch'), thits: $('#yf-thits'), changes: $('#yf-changes'),
    };
    const store = (k, d) => { try { return ctx.storage.get(k, d) ?? d; } catch { return d; } };
    const save = (k, v) => { try { ctx.storage.set(k, v); } catch { /* ignore */ } };
    els.indent.value = store('indent', ctx.indentUnit === '    ' ? '4' : '2');
    els.width.value = store('width', '80'); els.quote.value = store('quote', "'"); els.flow.value = store('flow', 'block');
    for (const k of ['sort', 'expand', 'force', 'dups', 'warn']) els[k].checked = store(k, k === 'expand' || k === 'warn');
    for (const k of ['indent', 'width', 'quote', 'flow']) els[k].addEventListener('change', () => save(k, els[k].value));
    for (const k of ['sort', 'expand', 'force', 'dups', 'warn']) els[k].addEventListener('change', () => save(k, els[k].checked));

    const edIn = createEditor(els.input, { language: 'yaml', storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: '  ', drop: false });
    const edOut = createEditor(els.output, { language: 'yaml', storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: '  ', readOnly: true, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const split = createSplit($('.yf-panels'), { direction: 'horizontal', storage: ctx.storage, storageKey: 'panels', labels: ['input', 'output'] });
    const disposers = [];
    const on = (target, ev, fn) => { target.addEventListener(ev, fn); disposers.push(() => target.removeEventListener(ev, fn)); };
    let destroyed = false, busy = false, gotoOffset = null, outName = 'formatted.yaml', outKind = 'yaml';
    let parsed = null, treeStale = true, treeDocs = null;

    const opts = () => ({
      indent: Number(els.indent.value), lineWidth: Number(els.width.value), quote: els.quote.value, flow: els.flow.value,
      sortKeys: els.sort.checked, expand: els.expand.checked, forceQuotes: els.force.checked, allowDuplicates: els.dups.checked,
    });
    async function ensureYaml() {
      if (window.jsyaml) { L.setYaml(window.jsyaml); return true; }
      try { await ctx.ui.loadScript(YAML_SRC); L.setYaml(window.jsyaml); return true; }
      catch (e) { showMessage(els.msg, 'error', `The YAML library could not be loaded (${e.message})`); return false; }
    }
    const getParsed = () => {
      const text = els.input.value, key = els.dups.checked;
      if (!parsed || parsed.text !== text || parsed.key !== key) parsed = { text, key, r: L.parseAll(text, { allowDuplicates: key }) };
      return parsed.r;
    };

    const showError = error => {
      gotoOffset = error.offset ?? null;
      showMessage(els.msg, 'error', `${L.formatError(error)}${error.hint ? `\n${error.hint}` : ''}`);
      els.goto.hidden = gotoOffset == null;
    };
    const clearMsg = () => { showMessage(els.msg, null); els.goto.hidden = true; gotoOffset = null; };
    const badge = (text, cls = 'badge') => els.stats.append(mk('span', cls, text));
    const clearOutput = () => { els.output.value = ''; els.stats.replaceChildren(); };
    const setOutput = (text, kind, name, title) => { outKind = kind; outName = name; els.output.value = text; edOut.setLanguage(kind); els.outTitle.textContent = title; };
    const setStats = (label, before, after, extra = []) => {
      els.stats.replaceChildren(); badge(label, 'badge badge-info');
      if (after != null) { const s = L.sizeStats(before, after); badge(`Before: ${formatBytes(s.before)}`); badge(`After: ${formatBytes(s.after)}`); badge(`${Math.abs(s.percent).toFixed(1)}% ${s.saved >= 0 ? 'smaller' : 'larger'}`, `badge ${s.saved >= 0 ? 'badge-success' : 'badge-warn'}`); }
      for (const e of extra) badge(e);
    };
    const gotoLine = line => { const starts = L.lineStartsOf(els.input.value); const off = starts[Math.min(line - 1, starts.length - 1)] ?? 0; edIn.select(off, off); };

    // ---- checks
    function renderChecks() {
      els.checks.replaceChildren();
      const text = els.input.value;
      if (!text.trim()) { els.checks.append(mk('p', 'hint', 'Enter some YAML to see checks.')); return; }
      const c = L.checkYaml(text);
      const comments = L.scanComments(text);
      const head = mk('p', '', `${c.documents} document${c.documents === 1 ? '' : 's'} · ${c.anchors.length} anchor${c.anchors.length === 1 ? '' : 's'} · ${c.aliases.length} alias${c.aliases.length === 1 ? '' : 'es'} used · ${comments.length} comment${comments.length === 1 ? '' : 's'}`);
      els.checks.append(head);
      const items = [];
      if (comments.length) items.push({ level: 'info', line: comments[0].line, message: `${comments.length} comment${comments.length === 1 ? '' : 's'} found. Formatting drops comments because js-yaml cannot preserve them.` });
      items.push(...c.findings);
      if (!c.findings.length) els.checks.append(mk('p', 'alert alert-success', 'No portability problems found.'));
      const ul = mk('ul');
      for (const f of items.slice(0, 300)) {
        const li = mk('li'); li.append(mk('span', `badge ${f.level === 'warn' ? 'badge-warn' : 'badge-info'}`, f.level === 'warn' ? 'warning' : 'note'));
        li.append(mk('span', 'msg', f.message));
        const b = mk('button', 'yf-link', `line ${f.line}`); b.type = 'button'; b.setAttribute('aria-label', `Go to line ${f.line}`); b.addEventListener('click', () => gotoLine(f.line)); li.append(b);
        ul.append(li);
      }
      els.checks.append(ul);
      if (items.length > 300) els.checks.append(mk('p', 'hint', `Showing the first 300 of ${items.length}.`));
    }

    // ---- changes (diff)
    function renderChanges(res, before) {
      els.changes.replaceChildren();
      if (!res) { els.changes.append(mk('p', 'hint', 'Run Format to compare the result with the input.')); return; }
      const d = res.diff, row = mk('div', 'row');
      row.append(mk('span', 'badge badge-success', `+${d.added} lines`), mk('span', 'badge badge-danger', `-${d.removed} lines`), mk('span', 'badge', `${d.unchanged} unchanged`),
        mk('span', `badge ${res.sameData === true ? 'badge-success' : res.sameData === false ? 'badge-warn' : ''}`, res.sameData === true ? 'Data identical after re-parsing' : res.sameData === false ? 'Data differs' : 'Data check skipped (alias expansion too large)'),
        mk('span', 'badge', `${res.count} document${res.count === 1 ? '' : 's'}`));
      els.changes.append(row);
      if (d.approximate) els.changes.append(mk('p', 'hint', 'Large change: counts are approximate and no line list is shown.'));
      if (d.identical) { els.changes.append(mk('p', 'hint', 'The formatted output is identical to the input.')); return; }
      const box = mk('div', 'yf-diff'); box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Changed lines'); box.tabIndex = 0;
      for (const ch of d.changes) { const r = mk('div', ch.type === '+' ? 'add' : 'del'); r.append(mk('span', 'ln', String(ch.line)), mk('span', '', `${ch.type} ${ch.text}`)); box.append(r); }
      els.changes.append(box);
      if (d.added + d.removed > d.changes.length && !d.approximate) els.changes.append(mk('p', 'hint', `Showing the first ${d.changes.length} changed lines.`));
      void before;
    }

    // ---- main actions
    async function run(op) {
      if (busy) return;
      const text = els.input.value;
      clearMsg();
      if (!text.trim()) { showMessage(els.msg, 'warn', 'Enter, paste or upload some YAML first.'); clearOutput(); return; }
      if (!(await ensureYaml())) return;
      if (op === 'format' && els.warn.checked && L.scanComments(text).length && L.parseAll(text, { allowDuplicates: els.dups.checked }).ok) {
        const ok = await confirmDialog('Comments will be removed', 'This YAML contains comments. The formatter cannot preserve comments, so they will be missing from the output (your input stays untouched). Continue?', 'Format anyway');
        if (!ok) return;
      }
      busy = true; showMessage(els.msg, 'info', 'Working…');
      await new Promise(r => setTimeout(r, 0));
      try {
        const o = opts();
        if (op === 'format') {
          const res = L.formatYaml(text, o);
          clearMsg();
          if (!res.ok) { clearOutput(); showError(res.error); renderChanges(null); return; }
          setOutput(res.text, 'yaml', 'formatted.yaml', 'Output (formatted YAML)');
          setStats('Formatted', text, res.text, [`${res.count} document${res.count === 1 ? '' : 's'}`, res.diff.identical ? 'No changes' : `+${res.diff.added} / -${res.diff.removed} lines`]);
          renderChanges(res, text);
          if (res.warnings.length) showMessage(els.msg, 'warn', res.warnings.join('\n'));
        } else if (op === 'validate') {
          const r = getParsed(); clearMsg();
          if (!r.ok) { showError(r.error); setStats('Invalid', 0, null); return; }
          const sm = L.summarize(r.docs);
          setStats('Valid YAML', 0, null, [`${r.count} document${r.count === 1 ? '' : 's'}`, ...sm.slice(0, 5).map(s => `doc ${s.index}: ${s.type}${s.size != null ? ` (${s.size})` : ''}`)]);
          const chk = L.checkYaml(text).findings.filter(f => f.level === 'warn').length;
          showMessage(els.msg, chk ? 'warn' : 'success', `The YAML is valid (${r.count} document${r.count === 1 ? '' : 's'}).${chk ? `\n${chk} portability warning${chk === 1 ? '' : 's'}: see the Checks tab.` : ''}`);
        } else if (op === 'toJson') {
          const res = L.yamlToJson(text, { ...o, indent: o.indent });
          clearMsg();
          if (!res.ok) { showError(res.error); return; }
          setOutput(res.text, 'json', 'converted.json', 'Output (JSON)'); setStats('YAML → JSON', text, res.text, [`${res.count} document${res.count === 1 ? '' : 's'}`]);
          if (res.warnings.length) showMessage(els.msg, 'info', res.warnings.join('\n'));
        } else if (op === 'fromJson') {
          const res = L.jsonToYaml(text, o);
          clearMsg();
          if (!res.ok) { showError(res.error); return; }
          setOutput(res.text, 'yaml', 'converted.yaml', 'Output (YAML)'); setStats('JSON → YAML', text, res.text);
        }
        renderChecks(); treeStale = true;
      } catch (e) { clearOutput(); showMessage(els.msg, 'error', `Unexpected error: ${e.message}`); }
      finally { busy = false; }
    }

    async function loadFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE) { showMessage(els.msg, 'error', `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE)}.`); return; }
      try { els.input.value = await readFileAsText(file); els.input.dispatchEvent(new Event('input', { bubbles: true })); clearMsg(); clearOutput(); }
      catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    // ---- live status
    const live = ctx.debounce(async () => {
      if (destroyed) return;
      const text = els.input.value; els.live.className = 'badge'; els.live.title = '';
      if (!text.trim()) { els.live.textContent = ''; return; }
      if (text.length > LIVE_MAX) { els.live.textContent = 'Live check off (large input)'; return; }
      if (!(await ensureYaml()) || destroyed) return;
      const r = getParsed();
      els.live.className = r.ok ? 'badge badge-success' : 'badge badge-danger';
      els.live.textContent = r.ok ? `Valid (${r.count} doc${r.count === 1 ? '' : 's'})` : `Error at ${r.error.line}:${r.error.column}`;
      if (!r.ok) els.live.title = r.error.message;
      if (activeTab === 'checks') renderChecks();
    }, 400);
    on(els.input, 'input', () => { live(); treeStale = true; });

    // ================================================================ outline
    const states = new Map(); // JSON.stringify(path) -> { li, ul, kids, rendered, open, toggle }
    const pkey = p => JSON.stringify(p);
    function makeRow(key, value, path, anc) {
      const li = mk('li'), row = mk('div', 'yf-row'); li.append(row);
      const d = L.describeValue(value);
      const kids = (anc.includes(value) ? [] : L.childrenOf(value));
      const cyc = L.childrenOf(value).length > 0 && anc.includes(value);
      const st = { li, ul: null, kids, rendered: 0, open: false, toggle: null, value, path, anc: [...anc, value] };
      states.set(pkey(path), st);
      if (kids.length) {
        const tg = mk('button', 'yf-tog', '▸'); tg.type = 'button'; tg.setAttribute('aria-expanded', 'false'); tg.setAttribute('aria-label', `Expand ${L.pathToString(path)}`);
        tg.addEventListener('click', () => setOpen(st, !st.open)); st.toggle = tg; row.append(tg);
      } else row.append(mk('span', 'yf-gap'));
      const l = mk('span', 'yf-lbl');
      l.append(mk('span', 'yf-key', typeof key === 'number' ? `[${key}]` : String(key)), mk('span', 'yf-muted', ': '));
      if (cyc) l.append(mk('span', 'yf-muted', '↻ circular alias'));
      else l.append(mk('span', d.type === 'string' ? 'yf-val' : d.type === 'number' || d.type === 'boolean' ? 'yf-num' : 'yf-muted', d.type === 'string' ? JSON.stringify(d.preview) : d.preview));
      row.append(l);
      const b = mk('button', 'yf-act', 'Copy path'); b.type = 'button'; b.setAttribute('aria-label', `Copy path ${L.pathToString(path)}`);
      b.addEventListener('click', () => copyText(L.pathToString(path), 'Path copied')); row.append(b);
      return li;
    }
    function renderChunk(st) {
      st.ul.querySelector(':scope > li.yf-morewrap')?.remove();
      const end = Math.min(st.kids.length, st.rendered + CHUNK);
      for (; st.rendered < end; st.rendered++) { const [k, v] = st.kids[st.rendered]; st.ul.append(makeRow(k, v, [...st.path, k], st.anc)); }
      if (st.rendered < st.kids.length) {
        const li = mk('li', 'yf-morewrap'); const b = mk('button', 'btn btn-sm yf-more', `Show ${Math.min(CHUNK, st.kids.length - st.rendered)} more (${st.kids.length - st.rendered} remaining)`);
        b.type = 'button'; b.addEventListener('click', () => renderChunk(st)); li.append(b); st.ul.append(li);
      }
    }
    function setOpen(st, open) {
      if (!st.toggle) return;
      if (open && !st.ul) { st.ul = mk('ul'); st.li.append(st.ul); renderChunk(st); }
      st.open = open; if (st.ul) st.ul.hidden = !open;
      st.toggle.textContent = open ? '▾' : '▸'; st.toggle.setAttribute('aria-expanded', String(open));
    }
    function buildTree() {
      els.tree.replaceChildren(); els.thits.replaceChildren(); states.clear(); treeDocs = null;
      if (!els.input.value.trim()) { els.tree.append(mk('p', 'hint', 'Enter some YAML, then open this tab.')); return; }
      const r = getParsed(); treeStale = false;
      if (!r.ok) { const p = mk('p', 'alert alert-error', L.formatError(r.error)); p.setAttribute('role', 'alert'); els.tree.append(p); return; }
      treeDocs = r.docs;
      const ul = mk('ul');
      r.docs.forEach((doc, i) => { const li = makeRow(r.count > 1 ? `document ${i + 1}` : 'root', doc, r.count > 1 ? [i] : [], []); ul.append(li); });
      els.tree.append(ul);
      for (const st of states.values()) if (st.path.length === 0 || (treeDocs.length > 1 && st.path.length === 1)) setOpen(st, true);
    }
    const multi = () => treeDocs && treeDocs.length > 1;
    function reveal(path) {
      const full = multi() ? path : path;
      for (let i = 0; i <= full.length; i++) {
        const prefix = full.slice(0, i), st = states.get(pkey(prefix));
        if (!st) { if (i === 0 && multi()) continue; return; }
        if (i === full.length) break;
        setOpen(st, true);
        const idx = st.kids.findIndex(([k]) => k === full[i]);
        while (st.rendered <= idx && st.rendered < st.kids.length) renderChunk(st);
      }
      const st = states.get(pkey(full)); const row = st?.li.firstElementChild; if (!row) return;
      row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1500);
      (row.querySelector('.yf-act'))?.focus({ preventScroll: true });
    }
    const searchTree = ctx.debounce(() => {
      els.thits.replaceChildren();
      const q = els.tsearch.value.trim(); if (!q) return;
      if (treeStale || !treeDocs) buildTree();
      if (!treeDocs) return;
      const hits = [];
      treeDocs.forEach((doc, i) => { for (const h of L.searchValue(doc, q, 300)) hits.push({ ...h, path: multi() ? [i, ...h.path] : h.path }); });
      els.thits.append(mk('div', '', hits.length ? `${hits.length >= 300 ? '300+' : hits.length} match${hits.length === 1 ? '' : 'es'}. Choose one to reveal it.` : 'No matches.'));
      if (!hits.length) return;
      const ul = mk('ul');
      for (const h of hits.slice(0, 300)) {
        const li = mk('li'), b = mk('button'); b.type = 'button';
        b.append(mk('span', '', L.pathToString(h.path)), mk('span', 'why', `${h.why}: ${String(h.preview).slice(0, 40)}`));
        b.addEventListener('click', () => reveal(h.path)); li.append(b); ul.append(li);
      }
      els.thits.append(ul);
    }, 250);
    on(els.tsearch, 'input', searchTree);

    // ---- tabs
    let activeTab = 'checks';
    initTabs($('.yf-tabs'), name => {
      activeTab = name;
      if (name === 'checks') renderChecks();
      if (name === 'outline' && (treeStale || !els.tree.firstChild)) { ensureYaml().then(ok => { if (ok && !destroyed) buildTree(); }); }
    });

    // ---- wiring
    on($('#yf-format'), 'click', () => run('format'));
    on($('#yf-validate'), 'click', () => run('validate'));
    on($('#yf-toJson'), 'click', () => run('toJson'));
    on($('#yf-fromJson'), 'click', () => run('fromJson'));
    on($('#yf-trefresh'), 'click', async () => { if (await ensureYaml()) buildTree(); });
    on($('#yf-texpand'), 'click', () => {
      let budget = 3000;
      const all = st => { if (budget-- <= 0 || !st.toggle) return; setOpen(st, true); while (st.rendered < st.kids.length && budget > 0) renderChunk(st); for (const [k] of st.kids) { const c = states.get(pkey([...st.path, k])); if (c) all(c); } };
      for (const st of [...states.values()]) if (st.path.length === 0 || (multi() && st.path.length === 1)) all(st);
      if (budget <= 0) toast('Expanded the first 3000 nodes only', 'info');
    });
    on($('#yf-tcollapse'), 'click', () => { for (const st of states.values()) if (st.path.length > (multi() ? 1 : 0)) setOpen(st, false); });
    on(els.goto, 'click', () => { if (gotoOffset != null) edIn.select(gotoOffset, Math.min(gotoOffset + 1, els.input.value.length)); });
    const setInput = v => { els.input.value = v; els.input.dispatchEvent(new Event('input', { bubbles: true })); };
    on($('#yf-sample'), 'click', () => { setInput(L.SAMPLE); clearMsg(); clearOutput(); renderChanges(null); });
    on($('#yf-upload'), 'click', async () => loadFile(await pickFile('.yaml,.yml,.json,.txt,.toml,.conf')));
    on($('#yf-clear'), 'click', () => { setInput(''); clearOutput(); clearMsg(); renderChanges(null); els.input.focus(); });
    on($('#yf-copy'), 'click', () => copyText(els.output.value));
    on($('#yf-download'), 'click', () => downloadFile(outName, els.output.value, outKind === 'json' ? 'application/json;charset=utf-8' : 'application/yaml;charset=utf-8'));
    on($('#yf-swap'), 'click', () => { if (!els.output.value) { toast('Nothing to move: run Format or a conversion first', 'warn'); return; } setInput(els.output.value); clearOutput(); clearMsg(); });
    on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run('format'); } });
    disposers.push(enableDrop($('#yf-drop'), loadFile));
    renderIcons(root); renderChecks(); live();

    return () => { destroyed = true; live.cancel(); searchTree.cancel(); disposers.forEach(d => d()); split.destroy(); edIn.destroy(); edOut.destroy(); };
  },
};
