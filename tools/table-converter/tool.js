import {
  copyText, downloadFile, pickFile, enableDrop, readFileAsText, showMessage, initTabs,
  escapeHtml, debounce, renderIcons, formatBytes,
} from '../../assets/js/components/ui.js';
import { convert, summarizeTable, FORMATS, PAIRS, ConvertError, LARGE_INPUT_WARN, WORKER_MIN } from './logic.js';

const PREVIEW_LIMIT = 500;
const OUTPUT_DISPLAY_MAX = 5_000_000; // characters shown in the output box; Copy / Download always use the full text

const SAMPLES = {
  json: JSON.stringify([
    { id: 1, name: "Ada O'Neil", email: 'ada@example.com', active: true, balance: 120.5, tags: ['admin', 'dev'] },
    { id: 2, name: 'Linus | T', email: null, active: false, balance: 0, tags: [] },
    { id: 3, name: 'Grace "Amazing" Hopper', email: 'grace@example.com', active: true, balance: 99, tags: ['ops'] },
  ], null, 2),
  csv: 'id,name,city,score,member\n1,"Smith, John",London,88.5,true\n2,Maria "Mia" Lopez,Madrid,92,false\n3,"Multi\nLine",Paris,,true\n',
  markdown: '| Name | Role | Score |\n| :--- | :---: | ---: |\n| Ada | Admin | 98 |\n| Linus \\| T | Dev | 87 |\n| Grace | Ops | 91 |\n',
  xml: '<?xml version="1.0" encoding="UTF-8"?>\n<library>\n  <book id="1" lang="en">\n    <title>Dune &amp; Co</title>\n    <author>Frank Herbert</author>\n  </book>\n  <book id="2" lang="ja">\n    <title>吾輩は猫である</title>\n    <author>夏目漱石</author>\n    <note><![CDATA[<b>classic</b>]]></note>\n  </book>\n</library>\n',
};

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const ids = ['from', 'to', 'convert', 'auto', 'swap', 'sample', 'upload', 'clear', 'delim', 'header', 'infer',
      'null', 'shape', 'align', 'table', 'dialect', 'multi', 'msg', 'warn', 'in', 'out', 'in-stats', 'out-stats', 'copy', 'download',
      'preview', 'in-panel', 'flatten', 'escf', 'bom', 'quote', 'comment', 'trim', 'skipempty', 'dedupe', 'xmlroot', 'xmlrow',
      'large', 'large-text', 'large-go', 'progress', 'ptext', 'pbar', 'cancel'];
    const el = Object.fromEntries(ids.map(id => [id, $('tc-' + id)]));

    const state = { last: null, full: '', job: 0, worker: null, allowLarge: false, running: false }; // last successful conversion result
    const saved = ctx.storage.get('opts', {}) || {};
    const PERSIST = ['from', 'to', 'auto', 'delim', 'header', 'infer', 'null', 'shape', 'align', 'table', 'dialect', 'multi', 'flatten', 'escf', 'bom',
      'quote', 'comment', 'trim', 'skipempty', 'dedupe', 'xmlroot', 'xmlrow'];

    // ---- restore / persist option controls ----
    const getVal = k => (el[k].type === 'checkbox' ? el[k].checked : el[k].value);
    for (const k of PERSIST) {
      if (!(k in saved) || !el[k]) continue;
      if (el[k].type === 'checkbox') el[k].checked = !!saved[k]; else el[k].value = saved[k];
    }
    const persist = () => ctx.storage.set('opts', Object.fromEntries(PERSIST.map(k => [k, getVal(k)])));

    // ---- format selects: only valid pairs enabled ----
    function syncSelects() {
      const valid = PAIRS[el.from.value] || [];
      [...el.to.options].forEach(o => { o.disabled = !valid.includes(o.value); });
      if (!valid.includes(el.to.value)) el.to.value = valid[0];
      // show only the options relevant to the current direction
      const tokens = [`${el.from.value}-in`, `${el.to.value}-out`];
      root.querySelectorAll('[data-for]').forEach(n => { n.hidden = !n.dataset.for.split(' ').some(t => tokens.includes(t)); });
    }

    // ---- stats helpers ----
    const lineCount = s => (s ? s.split(/\r\n|\n|\r/).length : 0);
    const showInStats = () => { el['in-stats'].textContent = el.in.value ? `${el.in.value.length.toLocaleString()} chars · ${lineCount(el.in.value).toLocaleString()} lines` : ''; };

    // ---- preview table ----
    function renderPreview(table) {
      if (!table) { el.preview.innerHTML = '<div class="empty"><p>Nothing to preview yet.</p></div>'; return; }
      const total = table.rowCount ?? table.rows.length;
      const shown = table.rows.slice(0, PREVIEW_LIMIT);
      const cell = v => (v === null || v === undefined ? '<span class="tc-null">NULL</span>'
        : v === '' ? '<span class="tc-null">(empty)</span>'
          : escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v));
      const head = table.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
      const body = shown.map((r, i) => `<tr><td class="tc-rownum">${i + 1}</td>${table.columns.map((_, c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`).join('');
      const notice = total > PREVIEW_LIMIT
        ? `<div class="alert alert-info tc-notice">Preview limited to the first ${PREVIEW_LIMIT} of ${total.toLocaleString()} rows. The text output contains all rows.</div>` : '';
      el.preview.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th class="tc-rownum">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>${notice}`;
    }

    // ---- conversion ----
    const readOpts = () => ({
      delimiter: el.delim.value, header: el.header.checked, inferTypes: el.infer.checked,
      emptyAsNull: el.null.checked, indent: ctx.indentUnit, jsonShape: el.shape.value,
      mdAlign: el.align.value, flatten: el.flatten.checked, escapeFormulas: el.escf.checked, tableName: el.table.value, dialect: el.dialect.value, multiRow: el.multi.checked,
      quote: el.quote.value, comment: el.comment.value, trim: el.trim.checked, skipEmptyRows: el.skipempty.checked, dedupeHeaders: el.dedupe.checked,
      xmlRoot: el.xmlroot.value.trim(), xmlRow: el.xmlrow.value.trim() || 'row',
    });

    function clearOutput() {
      state.last = null; state.full = ''; el.out.value = ''; el['out-stats'].textContent = ''; renderPreview(null);
    }
    function showFailure(message, known = true) {
      clearOutput();
      showMessage(el.msg, 'error', known ? message : `Unexpected error: ${message}`);
    }
    function showResult(res) {
      state.last = res; state.full = res.output;
      el.out.value = res.output.length > OUTPUT_DISPLAY_MAX
        ? res.output.slice(0, OUTPUT_DISPLAY_MAX) + `\n… (display truncated: ${res.output.length.toLocaleString()} characters in total; Copy and Download use the full output)`
        : res.output;
      const t = res.table;
      el['out-stats'].textContent = t ? `${(t.rowCount ?? t.rows.length).toLocaleString()} rows × ${t.columns.length} columns` : `${res.output.length.toLocaleString()} chars`;
      renderPreview(t);
      if (res.warnings.length) showMessage(el.warn, 'warn', 'Parsed with warnings:\n' + res.warnings.join('\n'));
    }

    function setProgress(on, text = '', pct = null) {
      el.progress.hidden = !on;
      if (on) { el.ptext.textContent = text; if (pct === null) el.pbar.removeAttribute('value'); else el.pbar.value = pct; }
    }
    function stopWorker() { if (state.worker) { try { state.worker.terminate(); } catch { /* ignore */ } state.worker = null; } }

    /** Run the conversion in a module worker. Resolves {fallback:true} when no worker can be used. */
    function convertInWorker(job, payload) {
      return new Promise(resolve => {
        let w;
        try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch { resolve({ fallback: true }); return; }
        state.worker = w;
        let started = false;
        const finish = r => { if (state.worker === w) stopWorker(); resolve(r); };
        w.onmessage = ev => {
          const d = ev.data || {};
          if (d.type === 'ready') { started = true; return; }
          if (d.id !== job) return;
          if (d.type === 'progress') setProgress(true, `${d.stage}… ${Math.round(d.fraction * 100)}%`, d.stage === 'Parsing' ? Math.round(d.fraction * 70) : 70 + Math.round(d.fraction * 30));
          else if (d.type === 'done') finish({ result: d.result });
          else if (d.type === 'error') finish({ error: d.message, known: d.known });
        };
        w.onerror = () => { stopWorker(); resolve(started ? { error: 'The background conversion crashed (probably out of memory). Try a smaller file.', known: true } : { fallback: true }); };
        w.postMessage({ id: job, ...payload });
      });
    }

    async function run({ quiet = false } = {}) {
      showMessage(el.msg, null); showMessage(el.warn, null); el.large.hidden = true;
      const job = ++state.job;
      stopWorker(); setProgress(false);
      const input = el.in.value;
      if (!input.trim()) {
        clearOutput();
        if (!quiet) showMessage(el.msg, 'warn', 'Paste or upload some input first.');
        return;
      }
      if (input.length > LARGE_INPUT_WARN && !state.allowLarge) {
        clearOutput();
        el['large-text'].textContent = `This input is ${formatBytes(input.length)}. Converting very large data can use a lot of memory and take a while (it runs in the background and can be cancelled).`;
        el.large.hidden = false;
        return;
      }
      const opts = readOpts(), from = el.from.value, to = el.to.value;
      try {
        if (input.length >= WORKER_MIN) {
          el.cancel.disabled = false;
          setProgress(true, 'Starting…', null);
          const r = await convertInWorker(job, { input, from, to, opts });
          if (job !== state.job) return; // cancelled or superseded
          if (!r.fallback) {
            setProgress(false);
            if (r.error !== undefined) return showFailure(r.error, r.known);
            return showResult({ ...r.result, table: r.result.table });
          }
          setProgress(true, 'Converting on the page (Web Workers are unavailable here; this cannot be cancelled)…', null);
          el.cancel.disabled = true;
          await new Promise(res => setTimeout(res, 30)); // let the progress box paint before the synchronous work
          if (job !== state.job) return;
          const res = convert(input, from, to, opts);
          setProgress(false);
          return showResult({ ...res, table: summarizeTable(res.table) });
        }
        showResult(convert(input, from, to, { ...opts, onProgress: null }));
      } catch (err) {
        setProgress(false);
        showFailure(err.message, err instanceof ConvertError);
      }
    }
    const autoRun = debounce(() => { if (el.auto.checked) run({ quiet: true }); }, 250);

    // ---- events ----
    const on = (node, ev, fn) => node.addEventListener(ev, fn);
    on(el.in, 'input', () => { state.allowLarge = false; showInStats(); autoRun(); });
    on(el.convert, 'click', () => run());
    on(el['large-go'], 'click', () => { state.allowLarge = true; run(); });
    on(el.cancel, 'click', () => {
      state.job++; stopWorker(); setProgress(false);
      showMessage(el.warn, 'info', 'Conversion cancelled.');
    });
    on(el.from, 'change', () => { syncSelects(); persist(); autoRun(); });
    on(el.to, 'change', () => { syncSelects(); persist(); autoRun(); });
    for (const k of ['delim', 'header', 'infer', 'null', 'shape', 'align', 'table', 'dialect', 'multi', 'auto', 'flatten', 'escf', 'bom', 'quote', 'comment', 'trim', 'skipempty', 'dedupe', 'xmlroot', 'xmlrow']) {
      on(el[k], ['table', 'xmlroot', 'xmlrow'].includes(k) ? 'input' : 'change', () => { persist(); autoRun(); });
    }

    on(el.sample, 'click', () => { el.in.value = SAMPLES[el.from.value]; state.allowLarge = false; showInStats(); run(); });
    on(el.clear, 'click', () => {
      state.job++; stopWorker(); setProgress(false); state.allowLarge = false;
      el.in.value = ''; clearOutput(); el.large.hidden = true;
      showMessage(el.msg, null); showMessage(el.warn, null); showInStats(); el.in.focus();
    });
    on(el.copy, 'click', () => copyText(state.full, 'Output copied'));
    on(el.download, 'click', () => {
      if (!state.full) return downloadFile('', ''); // shows the shared "Nothing to download" toast
      const fmt = FORMATS[el.to.value];
      downloadFile(`table.${fmt.ext}`, (el.to.value === 'csv' && el.bom.checked ? '﻿' : '') + state.full, fmt.mime);
    });

    // swap: output becomes the new input (only possible if the output format is a valid source)
    on(el.swap, 'click', () => {
      const out = state.full, oldFrom = el.from.value, oldTo = el.to.value;
      if (!out) { showMessage(el.msg, 'warn', 'Nothing to swap: convert something first.'); return; }
      if (!PAIRS[oldTo]) { showMessage(el.msg, 'warn', `${FORMATS[oldTo].label} output cannot be used as an input format.`); return; }
      el.in.value = out; el.from.value = oldTo; state.allowLarge = false;
      syncSelects();
      if (PAIRS[oldTo].includes(oldFrom)) el.to.value = oldFrom;
      persist(); showInStats(); run();
    });

    // file upload / drag & drop: pick the source format from the extension
    async function loadFile(file) {
      try {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const text = await readFileAsText(file);
        const guess = { json: 'json', csv: 'csv', tsv: 'csv', md: 'markdown', markdown: 'markdown', xml: 'xml' }[ext];
        if (guess) { el.from.value = guess; if (ext === 'tsv') el.delim.value = 'tab'; syncSelects(); }
        else if (/^\s*[[{]/.test(text)) { el.from.value = 'json'; syncSelects(); }
        else if (/^\s*<\?xml|^\s*<[A-Za-z_]/.test(text)) { el.from.value = 'xml'; syncSelects(); }
        state.allowLarge = false;
        el.in.value = text; showInStats(); persist(); run();
      } catch (err) { showMessage(el.msg, 'error', `Could not read file: ${err.message}`); }
    }
    on(el.upload, 'click', async () => { const f = await pickFile('.csv,.tsv,.json,.md,.markdown,.txt,.xml'); if (f) loadFile(f); });
    const disposeDrop = enableDrop(el['in-panel'], loadFile);

    initTabs(root);
    syncSelects();
    showInStats();
    renderPreview(null);
    renderIcons(root);

    return () => { state.job++; stopWorker(); disposeDrop(); };
  },
};
