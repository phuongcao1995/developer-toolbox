// HTML/CSS/JS Playground UI. The preview runs user code ONLY inside <iframe sandbox="allow-scripts"> (no allow-same-origin).
import { copyText, downloadFile, toast, showMessage, readFileAsText, confirmDialog, renderIcons, el } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { createSplit } from '../../assets/js/components/split.js';
import * as L from './logic.js';

const TAB_BREAKPOINT = 760;

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      example: $('#pg-example'), reset: $('#pg-reset'), auto: $('#pg-auto'), run: $('#pg-run'), stop: $('#pg-stop'),
      layout: $('#pg-layout'), viewport: $('#pg-viewport'), width: $('#pg-width'), widthField: $('#pg-width-field'),
      clearRun: $('#pg-clear-run'), external: $('#pg-external'), remember: $('#pg-remember'), extWarn: $('#pg-ext-warn'),
      msg: $('#pg-msg'), main: $('#pg-main'), wrap: $('#pg-frame-wrap'), empty: $('#pg-empty'), status: $('#pg-status'),
      stuck: $('#pg-stuck'), log: $('#pg-log'), count: $('#pg-count'), filter: $('#pg-filter'), file: $('#pg-file'),
      html: $('#pg-html'), css: $('#pg-css'), js: $('#pg-js'),
    };
    const PANELS = ['html', 'css', 'js'];
    const LANGS = { html: 'html', css: 'css', js: 'javascript' };

    // ---------------------------------------------------------------- state / persistence
    for (const [k, ex] of Object.entries(L.EXAMPLES)) els.example.append(el('option', { value: k }, ex.label));
    els.example.value = L.DEFAULT_EXAMPLE;

    els.remember.checked = ctx.storage.get('remember', true) !== false;
    const savedOpts = els.remember.checked ? (ctx.storage.get('opts', null) || {}) : {};
    if (typeof savedOpts.auto === 'boolean') els.auto.checked = savedOpts.auto;
    if (typeof savedOpts.clearRun === 'boolean') els.clearRun.checked = savedOpts.clearRun;
    if (['side', 'top'].includes(savedOpts.layout)) els.layout.value = savedOpts.layout;
    if (['responsive', 'mobile', 'tablet', 'desktop', 'custom'].includes(savedOpts.viewport)) els.viewport.value = savedOpts.viewport;
    if (Number.isFinite(savedOpts.width)) els.width.value = String(savedOpts.width);
    if (L.EXAMPLES[savedOpts.example]) els.example.value = savedOpts.example;
    // 'Allow external resources' is deliberately never persisted: it always starts off.

    const savedSrc = els.remember.checked ? ctx.storage.get('src', null) : null;
    const initial = savedSrc && typeof savedSrc === 'object' && PANELS.every(p => typeof savedSrc[p] === 'string') ? savedSrc : L.EXAMPLES[els.example.value];
    for (const p of PANELS) els[p].value = initial[p];

    const persist = () => {
      ctx.storage.set('remember', els.remember.checked);
      if (!els.remember.checked) { ctx.storage.remove('src'); ctx.storage.remove('opts'); return; }
      ctx.storage.set('opts', { auto: els.auto.checked, clearRun: els.clearRun.checked, layout: els.layout.value, viewport: els.viewport.value,
        width: Number(els.width.value) || 600, example: els.example.value });
      ctx.storage.set('src', getSource());
    };
    const persistSoon = ctx.debounce(persist, 500);

    const getSource = () => ({ html: els.html.value, css: els.css.value, js: els.js.value });
    const setSource = src => { for (const p of PANELS) { editors[p].setValue(src[p] ?? ''); els[p].value = src[p] ?? ''; } };

    // ---------------------------------------------------------------- editors + split
    const editors = {};
    for (const p of PANELS) {
      editors[p] = createEditor(els[p], { language: LANGS[p], storage: ctx.storage, storageKey: `pg-${p}`, fontSize: ctx.fontSize, indentUnit: ctx.indentUnit,
        ariaLabel: `${p.toUpperCase()} code`, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    }
    let split = null;
    const makeSplit = () => {
      split?.destroy();
      split = createSplit(els.main, { direction: els.layout.value === 'top' ? 'vertical' : 'horizontal', ratio: els.layout.value === 'top' ? 0.5 : 0.5, stackBelow: TAB_BREAKPOINT,
        storage: ctx.storage, storageKey: `pg-${els.layout.value}`, labels: ['editors', 'preview'] });
    };
    makeSplit();

    // narrow screens: tabs instead of three editors
    let activeTab = 'html';
    const selectTab = name => {
      activeTab = name;
      root.querySelectorAll('.pg-tab').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
      root.querySelectorAll('.pg-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      root.querySelectorAll('.pg-ed').forEach(d => d.classList.toggle('active', d.dataset.ed === name));
    };
    const syncTabbed = () => { root.classList.toggle('pg-tabbed', root.clientWidth > 0 && root.clientWidth < TAB_BREAKPOINT); };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(syncTabbed) : null;
    ro?.observe(root); syncTabbed();
    selectTab('html');

    // ---------------------------------------------------------------- console
    const entries = [];
    const renderLog = () => {
      const f = els.filter.value;
      const shown = f === 'all' ? entries : entries.filter(e => e.level === f);
      const nodes = shown.map(e => el('div', { class: `pg-entry lvl-${e.level}` }, el('span', { class: 'pg-lvl' }, e.level), el('span', { class: 'pg-text' }, e.text)));
      if (!nodes.length) nodes.push(el('div', { class: 'pg-log-empty' }, entries.length ? 'No messages at this level.' : 'Console output from your JavaScript appears here (console.log / info / warn / error, uncaught errors).'));
      const atBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 30;
      els.log.replaceChildren(...nodes);
      if (atBottom) els.log.scrollTop = els.log.scrollHeight;
      const errs = entries.filter(e => e.level === 'error').length;
      els.count.textContent = `${entries.length} message${entries.length === 1 ? '' : 's'}${errs ? `, ${errs} error${errs === 1 ? '' : 's'}` : ''}`;
      els.count.className = `badge${errs ? ' badge-danger' : ''}`;
    };
    let logRaf = 0;
    const addEntry = e => {
      entries.push({ level: e.level, text: e.text });
      if (entries.length > L.LIMITS.consoleEntries) entries.splice(0, entries.length - L.LIMITS.consoleEntries);
      if (!logRaf) logRaf = requestAnimationFrame(() => { logRaf = 0; renderLog(); });
    };
    const clearLog = () => { entries.length = 0; renderLog(); };

    // ---------------------------------------------------------------- run / stop / watchdog
    let frame = null, nonce = '', startedAt = 0, lastSignal = null, watchdog = 0, stuckShown = false;
    const setStatus = (text, cls = '') => { els.status.textContent = text; els.status.className = `badge ${cls}`.trim(); };
    const applyViewport = () => {
      const w = L.viewportWidth(els.viewport.value, els.width.value);
      els.widthField.hidden = els.viewport.value !== 'custom';
      if (frame) { frame.style.width = w ? `${w}px` : '100%'; frame.style.maxWidth = 'none'; }
    };
    const stopWatchdog = () => { clearInterval(watchdog); watchdog = 0; };
    function stop(message) {
      stopWatchdog();
      if (frame) { frame.srcdoc = ''; frame.remove(); frame = null; }
      nonce = ''; stuckShown = false; els.stuck.hidden = true;
      els.empty.hidden = false; els.empty.textContent = message || 'Preview stopped. Press Run to start it again.';
      setStatus('Stopped');
    }
    function run() {
      const src = getSource();
      const size = L.checkSize(src);
      if (!size.ok) { showMessage(els.msg, 'error', `The source is ${(size.bytes / 1e6).toFixed(2)} MB; the playground limit is ${(size.max / 1e6).toFixed(1)} MB. Remove some code and run again.`); return; }
      showMessage(els.msg, null);
      stop('');
      els.empty.hidden = true;
      if (els.clearRun.checked) clearLog();
      nonce = L.makeNonce();
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts'); // never add allow-same-origin: user code must not reach this app's origin
      f.setAttribute('title', 'Preview of your HTML, CSS and JavaScript');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.srcdoc = L.buildSrcdoc(src, { nonce, allowExternal: els.external.checked, parentOrigin: location.origin });
      frame = f;
      els.wrap.append(f);
      applyViewport();
      startedAt = Date.now(); lastSignal = null; stuckShown = false; els.stuck.hidden = true;
      setStatus('Running', 'badge-info');
      watchdog = setInterval(() => {
        if (!frame) return;
        const state = L.watchdogState({ now: Date.now(), startedAt, lastSignal });
        if (state === 'stuck' && !stuckShown) {
          stuckShown = true; els.stuck.hidden = false; setStatus('Not responding', 'badge-danger');
          addEntry({ level: 'error', text: `Preview has not responded for ${L.LIMITS.stuckSeconds} seconds (endless loop?). Use Stop to remove it.` });
        } else if (state === 'ok' && stuckShown) { stuckShown = false; els.stuck.hidden = true; setStatus('Running', 'badge-success'); }
      }, 1000);
    }

    const onMessage = e => {
      if (!frame || e.source !== frame.contentWindow || e.origin !== 'null') return;
      const m = L.parseBridgeMessage(e.data, nonce);
      if (!m) return;
      if (m.type === 'ready') { lastSignal = Date.now(); setStatus('Running', 'badge-success'); }
      else if (m.type === 'beat') lastSignal = Date.now();
      else addEntry(m);
    };
    window.addEventListener('message', onMessage);

    const runSoon = ctx.debounce(() => { if (els.auto.checked) run(); }, 700);

    // ---------------------------------------------------------------- import / export
    async function importFiles(fileList) {
      const files = [...fileList];
      if (!files.length) return;
      const read = [];
      for (const f of files) {
        if (f.size > L.LIMITS.totalBytes) { showMessage(els.msg, 'error', `${f.name} is larger than ${(L.LIMITS.totalBytes / 1e6).toFixed(1)} MB and was not imported.`); continue; }
        try { read.push({ name: f.name, text: await readFileAsText(f) }); } catch { showMessage(els.msg, 'error', `Could not read ${f.name}.`); }
      }
      if (!read.length) return;
      const r = L.importFiles(read, getSource());
      const notes = [];
      if (r.skipped.length) notes.push(`Skipped (unsupported type): ${r.skipped.join(', ')}.`);
      notes.push(...r.warnings);
      const names = read.filter(f => L.classifyFile(f.name)).map(f => f.name);
      if (!names.length) { showMessage(els.msg, 'warn', notes.join(' ') || 'Nothing to import. Use .html, .css or .js files.'); return; }
      setSource(r.src);
      showMessage(els.msg, notes.length ? 'warn' : 'success', `Imported ${names.join(', ')}.${notes.length ? ' ' + notes.join(' ') : ''}`);
      persist(); run();
    }
    const exportSource = () => getSource();
    const hasCode = () => PANELS.some(p => els[p].value.trim());

    function openNewTab() {
      if (!hasCode()) { toast('Nothing to preview', 'warn'); return; }
      const page = L.buildNewTabPage(L.buildSrcdoc(exportSource(), { nonce: L.makeNonce(), allowExternal: els.external.checked }));
      const url = URL.createObjectURL(new Blob([page], { type: 'text/html;charset=utf-8' }));
      const a = el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' });
      document.body.append(a); a.click(); a.remove();
      blobTimers.push(setTimeout(() => URL.revokeObjectURL(url), 60000));
      toast('Opened in a new tab (your code still runs in a sandboxed frame; console output is only shown here)', 'info', 4500);
    }
    const blobTimers = [];

    const resetExample = async () => {
      const ex = L.EXAMPLES[els.example.value];
      const cur = getSource();
      const same = PANELS.every(p => cur[p] === ex[p]);
      if (!same && hasCode() && !(await confirmDialog('Replace your code?', `This replaces the HTML, CSS and JS panels with the "${ex.label}" example. Your current code will be lost.`, 'Replace'))) return;
      setSource(ex); showMessage(els.msg, null); persist(); run();
    };

    // ---------------------------------------------------------------- events
    const disposers = [];
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); disposers.push(() => t.removeEventListener(ev, fn, o)); };
    for (const p of PANELS) on(els[p], 'input', () => { runSoon(); persistSoon(); });
    on(els.run, 'click', run);
    on(els.stop, 'click', () => stop(''));
    on($('#pg-stuck-stop'), 'click', () => stop('Preview stopped because it was not responding. Fix the code and press Run.'));
    on(els.reset, 'click', resetExample);
    on(els.auto, 'change', () => { persist(); if (els.auto.checked) run(); });
    on(els.clearRun, 'change', persist);
    on(els.example, 'change', persist);
    on(els.layout, 'change', () => { makeSplit(); persist(); });
    on(els.viewport, 'change', () => { applyViewport(); persist(); });
    on(els.width, 'input', () => { applyViewport(); persistSoon(); });
    on(els.external, 'change', () => { els.extWarn.hidden = !els.external.checked; run(); });
    on(els.remember, 'change', () => { persist(); toast(els.remember.checked ? 'Your code will be kept in this browser' : 'Saved code removed from this browser', 'info'); });
    on(els.filter, 'change', renderLog);
    on($('#pg-console-clear'), 'click', clearLog);
    on($('#pg-console-copy'), 'click', () => copyText(entries.map(e => `[${e.level}] ${e.text}`).join('\n'), 'Console copied'));
    on($('#pg-import'), 'click', () => els.file.click());
    on(els.file, 'change', async () => { await importFiles(els.file.files); els.file.value = ''; });
    on($('#pg-dl-html'), 'click', () => { if (!hasCode()) { toast('Nothing to download', 'warn'); return; } downloadFile('playground.html', L.buildExportHtml(exportSource()), 'text/html;charset=utf-8'); });
    on($('#pg-dl-zip'), 'click', () => {
      if (!hasCode()) { toast('Nothing to download', 'warn'); return; }
      downloadFile('playground.zip', new Blob([L.createZip(L.buildProjectFiles(exportSource()))], { type: 'application/zip' }));
    });
    on($('#pg-newtab'), 'click', openNewTab);
    on(root.querySelector('.pg'), 'click', e => { const t = e.target.closest('.pg-tab'); if (t) selectTab(t.dataset.tab); });
    on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
    // drop files anywhere on the tool
    on(root, 'dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); root.classList.add('pg-drag'); } });
    on(root, 'dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('pg-drag'); });
    on(root, 'drop', e => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); root.classList.remove('pg-drag'); importFiles(e.dataTransfer.files); });

    renderLog(); renderIcons(root);
    applyViewport();
    run();

    return () => {
      stopWatchdog(); window.removeEventListener('message', onMessage); ro?.disconnect();
      disposers.forEach(d => d()); blobTimers.forEach(clearTimeout);
      if (logRaf) cancelAnimationFrame(logRaf);
      if (frame) { frame.srcdoc = ''; frame.remove(); frame = null; }
      split?.destroy(); PANELS.forEach(p => editors[p].destroy());
      root.classList.remove('pg-tabbed', 'pg-drag');
    };
  },
};
