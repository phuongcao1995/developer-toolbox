import { copyText, downloadFile, toast, showMessage, bindActions, pickFile, enableDrop, readFileAsText, escapeHtml, formatBytes } from '../../assets/js/components/ui.js';
import {
  inlineDiff, buildSideRows, buildUnifiedRows, changeStarts, visibleMask, toUnifiedText, hasIgnoreOptions, eolNotice,
  EXACT_OPTS,
} from './logic.js';
import { createRunner } from './runner.js';

const MAX_FILE = 5 * 1024 * 1024;     // per opened file
const GUARD_CHARS = 5 * 1024 * 1024;  // combined paste size that needs "Compare anyway"
const AUTO_MAX_CHARS = 200000;        // above this total, auto-compare is paused
const CHUNK = 300;                    // rows appended per batch
const FOLD_STEP = 1000;               // lines revealed per fold click

const DEFAULT_UI = { ws: 'none', ignoreCase: false, trimTrailing: false, ignoreBlank: false, ignoreEol: true, view: 'side', gran: 'word', context: 3, wrap: true, auto: true };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const a = $('#df-a'), b = $('#df-b'), out = $('#df-output'), msg = $('#df-msg'), notesEl = $('#df-notes');
    const guard = $('#df-guard'), busy = $('#df-busy'), live = $('#df-live'), posEl = $('#df-pos');
    const el = { ws: $('#df-ws'), ignoreCase: $('#df-case'), trimTrailing: $('#df-trim'), ignoreBlank: $('#df-blank'), ignoreEol: $('#df-eol'), context: $('#df-context'), wrap: $('#df-wrap'), auto: $('#df-auto') };
    const names = { a: 'original', b: 'modified' };
    const life = new AbortController();
    const runner = createRunner(), exportRunner = createRunner();

    // ---------- persisted UI state ----------
    const saved = { ...DEFAULT_UI, ...(ctx.storage.get('ui', null) || {}) };
    if (!['side', 'unified'].includes(saved.view)) saved.view = 'side';
    if (!['line', 'word', 'char'].includes(saved.gran)) saved.gran = 'word';
    el.ws.value = ['none', 'edges', 'collapse', 'all'].includes(saved.ws) ? saved.ws : 'none';
    el.ignoreCase.checked = !!saved.ignoreCase; el.trimTrailing.checked = !!saved.trimTrailing;
    el.ignoreBlank.checked = !!saved.ignoreBlank; el.ignoreEol.checked = saved.ignoreEol !== false;
    el.context.value = [0, 1, 3, 5, -1].includes(Number(saved.context)) ? String(saved.context) : '3';
    el.wrap.checked = saved.wrap !== false; el.auto.checked = saved.auto !== false;
    let view = saved.view, gran = saved.gran;
    const persist = () => ctx.storage.set('ui', {
      ws: el.ws.value, ignoreCase: el.ignoreCase.checked, trimTrailing: el.trimTrailing.checked, ignoreBlank: el.ignoreBlank.checked,
      ignoreEol: el.ignoreEol.checked, view, gran, context: Number(el.context.value), wrap: el.wrap.checked, auto: el.auto.checked,
    });
    const opts = () => ({ ws: el.ws.value, ignoreCase: el.ignoreCase.checked, trimTrailing: el.trimTrailing.checked, ignoreBlank: el.ignoreBlank.checked, ignoreEol: el.ignoreEol.checked });

    // ---------- state ----------
    let current = null;            // last diff result (for the options in `shownOpts`)
    let shownOpts = opts();
    let seq = 0, force = false, busyTimer = null;
    // render model
    let rows = [], vis = null, starts = [], startOf = new Map(), cursor = 0, tbody = null, moreEl = null;
    let curChange = -1, segCache = new WeakMap(), inlineSkipped = 0;
    const isChangeRow = r => view === 'side' ? r.change : (r.type !== '=' && !r.ignored);

    // ---------- small helpers ----------
    const nLines = t => { if (!t) return 0; let n = 1, i = -1; while ((i = t.indexOf('\n', i + 1)) !== -1) n++; return t.endsWith('\n') ? n - 1 : n; };
    const counts = t => t ? `${nLines(t).toLocaleString()} lines · ${formatBytes(t.length)}` : '';
    const updateCounts = () => { $('#df-a-count').textContent = counts(a.value); $('#df-b-count').textContent = counts(b.value); };
    const announce = text => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); };
    const setStats = s => {
      $('#df-added').textContent = `+${s ? s.added : 0}`; $('#df-removed').textContent = `−${s ? s.removed : 0}`;
      $('#df-changed').textContent = `~${s ? s.changed : 0}`; $('#df-ident').textContent = `${s ? s.identicalPct : 100}% identical`;
    };
    const setNotes = list => {
      notesEl.textContent = '';
      for (const t of list) { const li = document.createElement('li'); li.textContent = t; notesEl.appendChild(li); }
      notesEl.hidden = !list.length;
    };
    const setPressed = (attr, value) => root.querySelectorAll(`[data-${attr}]`).forEach(c => { const on = c.dataset[attr] === value; c.classList.toggle('active', on); c.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    const baseNotes = () => {
      const list = [];
      if (current) {
        const n = eolNotice(current.eolA, current.eolB);
        if (n) list.push(n + (shownOpts.ignoreEol ? ' This difference is ignored (see "Ignore line endings").' : ' Every line therefore shows as changed.'));
        if (current.approximate) list.push('The inputs are huge and very different, so the diff is a good but not guaranteed-minimal result.');
      }
      if (hasIgnoreOptions(shownOpts)) list.push('Ignore options are active. The exported patch always reflects the exact text, not these options.');
      if (inlineSkipped) list.push(`${inlineSkipped} changed line pair(s) longer than 5,000 characters were shown without inline highlighting.`);
      return list;
    };
    const refreshNotes = () => setNotes(baseNotes());

    // ---------- rendering ----------
    const noEolMark = line => line && line.eol === '' ? ' <span class="eof">⏎ no newline at end of file</span>' : '';
    function segsFor(op) {
      if (gran === 'line' || !op.pair) return null;
      if (segCache.has(op)) return segCache.get(op);
      const d = op.type === '-' ? op : op.pair, ad = op.type === '+' ? op : op.pair;
      const r = inlineDiff(d.a.text, ad.b.text, shownOpts, gran);
      if (r && r.skipped) { inlineSkipped++; segCache.set(d, null); segCache.set(ad, null); return null; }
      segCache.set(d, r ? r.a : null); segCache.set(ad, r ? r.b : null);
      return segCache.get(op);
    }
    const textHtml = (text, segs) => segs ? segs.map(s => s.changed ? `<span class="w">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)).join('') : escapeHtml(text);

    function sideRowHtml(r, i) {
      const cell = (op, which) => {
        if (!op) return '<td class="no"></td><td class="sign"></td><td class="txt empty-cell"></td>';
        const line = which === 'l' ? op.a : op.b, no = which === 'l' ? op.aNo : op.bNo;
        const changed = op.type !== '=' && !op.ignored;
        const cls = changed ? (op.type === '-' ? 'del-c' : 'add-c') : '';
        const sign = changed ? (op.type === '-' ? '−' : '+') : '';
        return `<td class="no">${no}</td><td class="sign ${cls}" aria-hidden="true">${sign}</td><td class="txt ${cls}">${textHtml(line.text, changed ? segsFor(op) : null)}${noEolMark(line)}</td>`;
      };
      const k = startOf.get(i);
      return `<tr data-r="${i}"${k !== undefined ? ` data-chg="${k}"` : ''}>${cell(r.l, 'l')}${cell(r.r, 'r')}</tr>`;
    }
    function unifiedRowHtml(o, i) {
      const changed = o.type !== '=' && !o.ignored;
      const cls = changed ? (o.type === '+' ? 'add' : 'del') : '';
      const line = o.type === '-' ? o.a : o.b;
      const sign = changed ? (o.type === '+' ? '+' : '−') : '';
      const k = startOf.get(i);
      return `<tr class="${cls}" data-r="${i}"${k !== undefined ? ` data-chg="${k}"` : ''}><td class="no">${o.aNo ?? ''}</td><td class="no">${o.bNo ?? ''}</td><td class="sign" aria-hidden="true">${sign}</td><td class="txt">${textHtml(line.text, changed ? segsFor(o) : null)}${noEolMark(line)}</td></tr>`;
    }
    const rowHtml = (i) => view === 'side' ? sideRowHtml(rows[i], i) : unifiedRowHtml(rows[i], i);
    const foldHtml = (from, to) => {
      const n = to - from, label = `… ${n.toLocaleString()} unchanged line${n === 1 ? '' : 's'}`;
      return `<tr class="fold" data-from="${from}" data-to="${to}"><td colspan="${view === 'side' ? 6 : 4}"><button type="button" class="fold-btn" aria-label="Show ${n} unchanged line${n === 1 ? '' : 's'}">${label}</button></td></tr>`;
    };

    /** Append up to ~`units` rows starting at `cursor` (a folded run counts as one). */
    function renderChunk(units) {
      if (!tbody || cursor >= rows.length) return;
      let html = '', used = 0, i = cursor;
      const before = inlineSkipped;
      while (i < rows.length && used < units) {
        if (vis[i]) { html += rowHtml(i); i++; used++; continue; }
        let j = i; while (j < rows.length && !vis[j]) j++;
        html += foldHtml(i, j); i = j; used++;
      }
      cursor = i;
      tbody.insertAdjacentHTML('beforeend', html);
      if (inlineSkipped !== before) refreshNotes();
      if (moreEl) { moreEl.hidden = cursor >= rows.length; moreEl.textContent = `Showing ${Math.min(cursor, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} rows - scroll to load more`; }
    }
    const fillViewport = () => { while (cursor < rows.length && out.scrollHeight <= out.clientHeight + 600) renderChunk(CHUNK); };
    const ensureRendered = idx => { while (cursor <= idx && cursor < rows.length) renderChunk(CHUNK * 2); };

    function emptyMsg(text) { out.className = 'df-output'; out.textContent = ''; const d = document.createElement('div'); d.className = 'empty'; const p = document.createElement('p'); p.textContent = text; d.appendChild(p); out.appendChild(d); }

    function render() {
      setPressed('view', view); setPressed('gran', gran);
      out.classList.toggle('wrap', el.wrap.checked);
      posEl.textContent = ''; curChange = -1; inlineSkipped = 0; segCache = new WeakMap();
      tbody = null; moreEl = null; rows = []; starts = [];
      if (!current) { out.className = 'df-output' + (el.wrap.checked ? ' wrap' : ''); out.innerHTML = '<div class="empty">Enter text on both sides to see the differences.</div>'; refreshNotes(); return; }
      if (current.identical) {
        emptyMsg('The two texts are identical' + (hasIgnoreOptions(shownOpts) || shownOpts.ignoreEol ? ' (with the selected options).' : '.'));
        refreshNotes(); return;
      }
      rows = view === 'side' ? buildSideRows(current.ops) : buildUnifiedRows(current.ops);
      starts = changeStarts(rows, isChangeRow);
      startOf = new Map(starts.map((r, k) => [r, k]));
      const ctxN = Number(el.context.value);
      vis = visibleMask(i => isChangeRow(rows[i]), rows.length, ctxN);
      // a fold hiding a single line is pointless: show it
      for (let i = 0; i < rows.length; i++) if (!vis[i] && (i === 0 || vis[i - 1]) && (i + 1 >= rows.length || vis[i + 1])) vis[i] = 1;
      cursor = 0;
      out.className = 'df-output' + (el.wrap.checked ? ' wrap' : '');
      out.innerHTML = view === 'side'
        ? '<table class="df side" aria-label="Side by side differences"><colgroup><col style="width:46px"><col style="width:20px"><col><col style="width:46px"><col style="width:20px"><col></colgroup><tbody></tbody></table><div class="df-more" hidden></div>'
        : '<table class="df uni" aria-label="Unified differences"><colgroup><col style="width:46px"><col style="width:46px"><col style="width:20px"><col></colgroup><tbody></tbody></table><div class="df-more" hidden></div>';
      tbody = out.querySelector('tbody'); moreEl = out.querySelector('.df-more');
      renderChunk(CHUNK); fillViewport();
      refreshNotes();
    }

    // lazy load while scrolling
    out.addEventListener('scroll', () => {
      if (cursor < rows.length && out.scrollTop + out.clientHeight > out.scrollHeight - 800) renderChunk(CHUNK);
    }, { passive: true, signal: life.signal });

    // expand folds (delegated; real buttons so Enter/Space work)
    out.addEventListener('click', e => {
      const btn = e.target.closest('.fold-btn');
      if (!btn) return;
      const tr = btn.closest('tr.fold'), from = Number(tr.dataset.from), to = Number(tr.dataset.to);
      const k = Math.min(to - from, FOLD_STEP);
      let html = '';
      for (let i = from; i < from + k; i++) { vis[i] = 1; html += rowHtml(i); }
      if (from + k < to) html += foldHtml(from + k, to);
      tr.insertAdjacentHTML('beforebegin', html);
      const remain = from + k < to ? tr.previousElementSibling : null;
      tr.remove();
      if (remain) remain.querySelector('.fold-btn')?.focus();
      else out.focus({ preventScroll: true });
    }, { signal: life.signal });

    // ---------- change navigation ----------
    function goChange(k) {
      if (!starts.length) { toast('No changes to navigate', 'info'); return; }
      curChange = (k + starts.length) % starts.length;
      const idx = starts[curChange];
      ensureRendered(idx);
      const tr = out.querySelector(`tr[data-r="${idx}"]`);
      out.querySelector('tr.cur')?.classList.remove('cur');
      if (tr) {
        tr.classList.add('cur');
        const delta = tr.getBoundingClientRect().top - out.getBoundingClientRect().top;
        out.scrollTop += delta - out.clientHeight / 3;
      }
      const text = `Change ${curChange + 1} of ${starts.length}`;
      posEl.textContent = text; announce(text);
    }
    const next = () => goChange(curChange + 1), prev = () => goChange(curChange < 0 ? starts.length - 1 : curChange - 1);
    root.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || t.isContentEditable)) return;
      if (e.key === 'n') { e.preventDefault(); next(); } else if (e.key === 'p') { e.preventDefault(); prev(); }
    }, { signal: life.signal });

    // ---------- compare ----------
    const totalChars = () => a.value.length + b.value.length;
    function hideBusy() { clearTimeout(busyTimer); busy.hidden = true; }
    async function compare() {
      const my = ++seq;
      showMessage(msg, null); guard.hidden = true; hideBusy();
      updateCounts();
      if (!a.value && !b.value) { current = null; setStats(null); render(); announce('Both sides are empty.'); return; }
      if (totalChars() > GUARD_CHARS && !force) {
        runner.cancel();
        $('#df-guard-text').textContent = `This input is large (${formatBytes(totalChars())}). Comparing it can take a while and use a lot of memory.`;
        guard.hidden = false; return;
      }
      const o = opts();
      clearTimeout(busyTimer);
      busyTimer = setTimeout(() => { busy.hidden = false; }, 150);
      const res = await runner.run(a.value, b.value, o);
      if (my !== seq) return;
      hideBusy();
      if (res.cancelled) { showMessage(msg, 'info', 'Comparison cancelled.'); return; }
      if (res.error) { showMessage(msg, 'error', `Could not compare: ${res.error}`); return; }
      current = res; shownOpts = o;
      setStats(res.stats);
      render();
      announce(res.identical ? 'The texts are identical.' : `${res.stats.added} added, ${res.stats.removed} removed, ${res.stats.changed} changed lines. ${res.stats.identicalPct} percent identical.`);
    }
    const onInput = () => {
      force = false; guard.hidden = true;
      updateCounts();
      if (!el.auto.checked) return;
      if (totalChars() >= AUTO_MAX_CHARS) { autoRun.cancel(); showMessage(msg, 'info', 'Auto-compare is paused for large input. Press Compare to run it.'); return; }
      autoRun();
    };
    // debounced wrapper (ctx.debounce is cancelled automatically on unmount; also cancelled explicitly below)
    const autoRun = ctx.debounce(() => { compare(); }, 300);

    // ---------- files ----------
    async function loadInto(side, file) {
      if (!file) return;
      if (file.size > MAX_FILE) return showMessage(msg, 'error', `"${file.name}" is larger than 5 MB.`);
      try {
        const text = await readFileAsText(file);
        if (text.includes('\u0000')) return showMessage(msg, 'error', `"${file.name}" looks like a binary file, not text.`);
        (side === 'a' ? a : b).value = text; names[side] = file.name;
        force = false; compare();
      } catch (e) { showMessage(msg, 'error', `Could not read file: ${e.message}`); }
    }

    // ---------- export ----------
    /** Patch text computed on the exact text, so it always applies to the original even when ignore options are on. */
    async function patchText() {
      if (!current) return null;
      const o = shownOpts;
      const exactNeeded = hasIgnoreOptions(o) || (o.ignoreEol && current.eolA !== current.eolB);
      let res = current;
      if (exactNeeded) {
        res = await exportRunner.run(a.value, b.value, EXACT_OPTS);
        if (res.error || res.cancelled) return null;
        toast('Patch reflects the exact text (ignore options are not applied)', 'info', 3800);
      }
      return res.identical ? '' : toUnifiedText(res.ops, { context: 3, aName: names.a, bName: names.b });
    }

    bindActions(root, {
      compare: () => { force = false; compare(); },
      'compare-anyway': () => { force = true; compare(); },
      cancel: () => { runner.cancel(); hideBusy(); },
      swap: () => { [a.value, b.value] = [b.value, a.value]; [names.a, names.b] = [names.b, names.a]; compare(); },
      clear: () => { a.value = b.value = ''; names.a = 'original'; names.b = 'modified'; force = false; compare(); },
      'copy-a': () => a.value ? copyText(a.value, 'Original copied') : toast('Original is empty', 'warn'),
      'copy-b': () => b.value ? copyText(b.value, 'Modified copied') : toast('Modified is empty', 'warn'),
      'upload-a': async () => loadInto('a', await pickFile()),
      'upload-b': async () => loadInto('b', await pickFile()),
      next, prev,
      copy: async () => {
        if (!current) return toast('Nothing to copy - compare some text first', 'warn');
        const p = await patchText();
        if (p === null) return;
        if (!p) return toast('The texts are identical - no patch to copy', 'info');
        copyText(p, 'Unified diff copied');
      },
      download: async () => {
        if (!current) return toast('Nothing to download - compare some text first', 'warn');
        const p = await patchText();
        if (p === null) return;
        if (!p) return toast('The texts are identical - no patch to download', 'info');
        downloadFile('changes.diff', p);
      },
    });
    root.querySelectorAll('[data-view]').forEach(c => c.addEventListener('click', () => { view = c.dataset.view; persist(); render(); }));
    root.querySelectorAll('[data-gran]').forEach(c => c.addEventListener('click', () => { gran = c.dataset.gran; persist(); render(); }));
    el.context.addEventListener('change', () => { persist(); render(); });
    el.wrap.addEventListener('change', () => { persist(); out.classList.toggle('wrap', el.wrap.checked); });
    [el.ws, el.ignoreCase, el.trimTrailing, el.ignoreBlank, el.ignoreEol].forEach(o => o.addEventListener('change', () => { persist(); compare(); }));
    el.auto.addEventListener('change', () => { persist(); if (el.auto.checked && totalChars() < AUTO_MAX_CHARS) compare(); });
    [a, b].forEach(t => t.addEventListener('input', onInput));
    const drops = [enableDrop(a, f => loadInto('a', f)), enableDrop(b, f => loadInto('b', f))];

    render();
    return () => {
      life.abort(); seq++;
      autoRun.cancel(); hideBusy();
      runner.dispose(); exportRunner.dispose();
      drops.forEach(d => d());
    };
  },
};
