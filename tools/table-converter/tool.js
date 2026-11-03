import {
  copyText, downloadFile, pickFile, enableDrop, readFileAsText, showMessage, initTabs,
  escapeHtml, debounce, renderIcons,
} from '../../assets/js/components/ui.js';
import { convert, FORMATS, PAIRS, ConvertError } from './logic.js';

const PREVIEW_LIMIT = 500;

const SAMPLES = {
  json: JSON.stringify([
    { id: 1, name: "Ada O'Neil", email: 'ada@example.com', active: true, balance: 120.5, tags: ['admin', 'dev'] },
    { id: 2, name: 'Linus | T', email: null, active: false, balance: 0, tags: [] },
    { id: 3, name: 'Grace "Amazing" Hopper', email: 'grace@example.com', active: true, balance: 99, tags: ['ops'] },
  ], null, 2),
  csv: 'id,name,city,score,member\n1,"Smith, John",London,88.5,true\n2,Maria "Mia" Lopez,Madrid,92,false\n3,"Multi\nLine",Paris,,true\n',
  markdown: '| Name | Role | Score |\n| :--- | :---: | ---: |\n| Ada | Admin | 98 |\n| Linus \\| T | Dev | 87 |\n| Grace | Ops | 91 |\n',
};

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const el = Object.fromEntries(['from', 'to', 'convert', 'auto', 'swap', 'sample', 'upload', 'clear', 'delim', 'header', 'infer',
      'null', 'shape', 'align', 'table', 'dialect', 'multi', 'msg', 'warn', 'in', 'out', 'in-stats', 'out-stats', 'copy', 'download',
      'preview', 'in-panel'].map(id => [id, $('tc-' + id)]));

    const state = { last: null }; // last successful conversion result
    const saved = ctx.storage.get('opts', {}) || {};
    const PERSIST = ['from', 'to', 'auto', 'delim', 'header', 'infer', 'null', 'shape', 'align', 'table', 'dialect', 'multi'];

    // ---- restore / persist option controls ----
    const getVal = k => (el[k].type === 'checkbox' ? el[k].checked : el[k].value);
    for (const k of PERSIST) {
      if (!(k in saved)) continue;
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
    const lineCount = s => (s ? s.split('\n').length : 0);
    const showInStats = () => { el['in-stats'].textContent = el.in.value ? `${el.in.value.length.toLocaleString()} chars · ${lineCount(el.in.value)} lines` : ''; };

    // ---- preview table ----
    function renderPreview(table) {
      if (!table) { el.preview.innerHTML = '<div class="empty"><p>Nothing to preview yet.</p></div>'; return; }
      const shown = table.rows.slice(0, PREVIEW_LIMIT);
      const cell = v => (v === null || v === undefined ? '<span class="tc-null">NULL</span>'
        : v === '' ? '<span class="tc-null">(empty)</span>'
          : escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v));
      const head = table.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
      const body = shown.map((r, i) => `<tr><td class="tc-rownum">${i + 1}</td>${table.columns.map((_, c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`).join('');
      const notice = table.rows.length > PREVIEW_LIMIT
        ? `<div class="alert alert-info tc-notice">Preview limited to the first ${PREVIEW_LIMIT} of ${table.rows.length.toLocaleString()} rows. The text output contains all rows.</div>` : '';
      el.preview.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th class="tc-rownum">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>${notice}`;
    }

    // ---- conversion ----
    function run({ quiet = false } = {}) {
      showMessage(el.msg, null); showMessage(el.warn, null);
      const input = el.in.value;
      if (!input.trim()) {
        state.last = null; el.out.value = ''; el['out-stats'].textContent = ''; renderPreview(null);
        if (!quiet) showMessage(el.msg, 'warn', 'Paste or upload some input first.');
        return;
      }
      try {
        const res = convert(input, el.from.value, el.to.value, {
          delimiter: el.delim.value, header: el.header.checked, inferTypes: el.infer.checked,
          emptyAsNull: el.null.checked, indent: ctx.indentUnit, jsonShape: el.shape.value,
          mdAlign: el.align.value, tableName: el.table.value, dialect: el.dialect.value, multiRow: el.multi.checked,
        });
        state.last = res;
        el.out.value = res.output;
        el['out-stats'].textContent = `${res.table.rows.length.toLocaleString()} rows × ${res.table.columns.length} columns`;
        renderPreview(res.table);
        if (res.warnings.length) showMessage(el.warn, 'warn', 'Parsed with warnings:\n' + res.warnings.join('\n'));
      } catch (err) {
        state.last = null; el.out.value = ''; el['out-stats'].textContent = ''; renderPreview(null);
        const known = err instanceof ConvertError;
        showMessage(el.msg, 'error', known ? err.message : `Unexpected error: ${err.message}`);
      }
    }
    const autoRun = debounce(() => { if (el.auto.checked) run({ quiet: true }); }, 250);

    // ---- events ----
    const on = (node, ev, fn) => node.addEventListener(ev, fn);
    on(el.in, 'input', () => { showInStats(); autoRun(); });
    on(el.convert, 'click', () => run());
    on(el.from, 'change', () => { syncSelects(); persist(); autoRun(); });
    on(el.to, 'change', () => { syncSelects(); persist(); autoRun(); });
    for (const k of ['delim', 'header', 'infer', 'null', 'shape', 'align', 'table', 'dialect', 'multi', 'auto']) {
      on(el[k], k === 'table' ? 'input' : 'change', () => { persist(); autoRun(); });
    }

    on(el.sample, 'click', () => { el.in.value = SAMPLES[el.from.value]; showInStats(); run(); });
    on(el.clear, 'click', () => {
      el.in.value = ''; el.out.value = ''; state.last = null; el['out-stats'].textContent = '';
      showMessage(el.msg, null); showMessage(el.warn, null); renderPreview(null); showInStats(); el.in.focus();
    });
    on(el.copy, 'click', () => copyText(el.out.value, 'Output copied'));
    on(el.download, 'click', () => {
      if (!el.out.value) return downloadFile('', ''); // shows the shared "Nothing to download" toast
      const fmt = FORMATS[el.to.value];
      downloadFile(`table.${fmt.ext}`, el.out.value, fmt.mime);
    });

    // swap: output becomes the new input (only possible if the output format is a valid source)
    on(el.swap, 'click', () => {
      const out = el.out.value, oldFrom = el.from.value, oldTo = el.to.value;
      if (!out) { showMessage(el.msg, 'warn', 'Nothing to swap: convert something first.'); return; }
      if (!PAIRS[oldTo]) { showMessage(el.msg, 'warn', `${FORMATS[oldTo].label} output cannot be used as an input format.`); return; }
      el.in.value = out; el.from.value = oldTo;
      syncSelects();
      if (PAIRS[oldTo].includes(oldFrom)) el.to.value = oldFrom;
      persist(); showInStats(); run();
    });

    // file upload / drag & drop: pick the source format from the extension
    async function loadFile(file) {
      try {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const text = await readFileAsText(file);
        const guess = { json: 'json', csv: 'csv', tsv: 'csv', md: 'markdown', markdown: 'markdown' }[ext];
        if (guess) { el.from.value = guess; if (ext === 'tsv') el.delim.value = 'tab'; syncSelects(); }
        else if (/^\s*[[{]/.test(text)) { el.from.value = 'json'; syncSelects(); }
        el.in.value = text; showInStats(); persist(); run();
      } catch (err) { showMessage(el.msg, 'error', `Could not read file: ${err.message}`); }
    }
    on(el.upload, 'click', async () => { const f = await pickFile('.csv,.tsv,.json,.md,.markdown,.txt'); if (f) loadFile(f); });
    const disposeDrop = enableDrop(el['in-panel'], loadFile);

    initTabs(root);
    syncSelects();
    showInStats();
    renderPreview(null);
    renderIcons(root);

    return () => { disposeDrop(); };
  },
};
