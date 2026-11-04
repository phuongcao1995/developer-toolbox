import { copyText, downloadFile, toast, pickFile, enableDrop, showMessage, bindActions, readFileAsArrayBuffer, debounce, el, renderIcons, formatBytes } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const input = q('input'), output = q('output'), stepsBox = q('steps'), opSelect = q('opselect'), auto = q('auto'), err = q('err');
    let steps = [];            // [{uid, op, enabled, params}]
    let uid = 0, runToken = 0, finalText = '';
    let fileBytes = null, fileName = '';   // a loaded file is kept as raw bytes (the textarea would normalise line endings and mangle binary)
    let finalValue = null, view = 'text';  // last pipeline result (string | Uint8Array) and the output view
    const FILE_WARN = 10 * 1024 * 1024, FILE_MAX = 50 * 1024 * 1024, SHOW_MAX = 2_000_000;
    const rows = new Map();    // uid -> {box, out}

    // Operation picker grouped by category.
    for (const g of L.GROUPS) {
      const og = el('optgroup', { label: g });
      L.OPERATIONS.filter(o => o.group === g).forEach(o => og.append(el('option', { value: o.id, title: o.desc }, o.name)));
      opSelect.append(og);
    }

    // Restore persisted pipeline.
    try {
      const saved = ctx.storage.get('steps');
      if (Array.isArray(saved)) steps = saved.filter(s => L.getOp(s.op)).map(s => ({ uid: ++uid, op: s.op, enabled: s.enabled !== false, params: s.params || {} }));
    } catch { /* ignore */ }
    const persist = () => { try { ctx.storage.set('steps', steps.map(({ op, enabled, params }) => ({ op, enabled, params }))); } catch { /* ignore */ } };

    // ---- Rendering of the step list (structure) ----
    function renderSteps() {
      rows.clear(); stepsBox.replaceChildren();
      q('count').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
      if (!steps.length) { stepsBox.append(el('div', { class: 'cc-empty' }, 'No steps yet. Add an operation below or click an example recipe.')); return; }
      steps.forEach((s, i) => {
        const op = L.getOp(s.op);
        const sel = el('select', { class: 'select', 'aria-label': `Step ${i + 1} operation` });
        L.OPERATIONS.forEach(o => sel.append(el('option', { value: o.id, selected: o.id === s.op }, o.name)));
        sel.addEventListener('change', () => { s.op = sel.value; s.params = {}; renderSteps(); changed(); });
        const head = el('div', { class: 'cc-step-head' },
          el('span', { class: 'cc-num' }, `${i + 1}.`),
          el('label', { class: 'check', title: 'Enable / disable this step' },
            el('input', { type: 'checkbox', checked: s.enabled, onchange: e => { s.enabled = e.target.checked; changed(); } }), 'On'),
          sel);
        for (const p of op.params || []) {
          const ps = el('select', { class: 'select cc-param', 'aria-label': p.label, title: p.label });
          p.options.forEach(([v, label]) => ps.append(el('option', { value: v, selected: (s.params[p.key] ?? p.options[0][0]) === v }, label)));
          ps.addEventListener('change', () => { s.params[p.key] = ps.value; changed(); });
          head.append(ps);
        }
        head.append(el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm btn-icon', title: 'Move up', 'aria-label': 'Move step up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          el('button', { class: 'btn btn-sm btn-icon', title: 'Move down', 'aria-label': 'Move step down', disabled: i === steps.length - 1, onclick: () => move(i, 1) }, '↓'),
          el('button', { class: 'btn btn-sm btn-icon btn-danger', title: 'Remove step', 'aria-label': 'Remove step', onclick: () => { steps.splice(i, 1); renderSteps(); changed(); } }, '✕'));
        const out = el('div', { class: 'cc-out' });
        const box = el('div', { class: 'cc-step' }, head, out);
        rows.set(s.uid, { box, out });
        stepsBox.append(box);
      });
    }
    const move = (i, d) => { [steps[i], steps[i + d]] = [steps[i + d], steps[i]]; renderSteps(); changed(); };

    // ---- Execution ----
    async function run() {
      const token = ++runToken;
      const res = await L.runPipeline(fileBytes || input.value, steps);
      if (token !== runToken) return; // a newer run superseded this one
      const PREVIEW = 4000;
      steps.forEach((s, i) => {
        const r = res.results[i], row = rows.get(s.uid); if (!row || !r) return;
        row.box.classList.toggle('off', !s.enabled); row.box.classList.toggle('error', r.status === 'error');
        row.out.classList.toggle('errtxt', r.status === 'error');
        if (r.status === 'error') row.out.textContent = `Error in step ${i + 1}: ${r.error}`;
        else if (r.status === 'off') row.out.textContent = '(disabled — passes data through unchanged)';
        else if (r.status === 'skipped') row.out.textContent = '(not run because an earlier step failed)';
        else {
          const note = r.binary ? `[binary, ${r.bytes} bytes, shown as hex] ` : '';
          row.out.textContent = note + (r.text.length > PREVIEW ? r.text.slice(0, PREVIEW) + `… (${r.text.length} chars total)` : r.text || '(empty)');
        }
      });
      if (res.failedAt >= 0) {
        showMessage(err, 'error', `Step ${res.failedAt + 1} (${L.getOp(steps[res.failedAt].op).name}) failed: ${res.error}`);
        finalValue = null; renderOutput();
      } else {
        showMessage(err, null);
        finalValue = res.finalValue; renderOutput(res.final);
      }
      q('inmeta').textContent = fileBytes ? `File: ${formatBytes(fileBytes.length)} (raw bytes)` : input.value ? `${input.value.length} chars · ${formatBytes(new TextEncoder().encode(input.value).length)} UTF-8` : '';
    }
    /** Show the final value as text or hex; finalText is what Copy / Download text use. */
    function renderOutput(final) {
      if (finalValue === null) { finalText = ''; output.value = ''; q('outbadge').textContent = ''; return; }
      const bytes = L.valueBytes(finalValue);
      const d = final || L.displayValue(finalValue);
      if (view === 'hex') { finalText = L.bytesToHex(bytes, ' '); q('outbadge').textContent = `${bytes.length} B · hex`; }
      else { finalText = d.text; q('outbadge').textContent = d.binary ? `binary · ${bytes.length} B (shown as hex)` : `${finalText.length} chars · ${formatBytes(bytes.length)}`; }
      output.value = finalText.length > SHOW_MAX ? finalText.slice(0, SHOW_MAX) + `
… (display truncated, ${finalText.length} chars in total — Copy and Download use the full output)` : finalText;
    }
    root.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
      view = b.dataset.view;
      root.querySelectorAll('[data-view]').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b); });
      renderOutput();
    }));
    const runSoon = debounce(run, 150);
    const changed = () => { persist(); if (auto.checked) runSoon(); };
    input.addEventListener('input', () => { if (auto.checked) runSoon(); else q('inmeta').textContent = ''; });

    // ---- Recipes ----
    const recipes = q('recipes');
    L.RECIPES.forEach(r => recipes.append(el('button', { class: 'chip', onclick: () => {
      input.value = r.input;
      steps = r.steps.map(s => ({ uid: ++uid, op: s.op, enabled: true, params: { ...(s.params || {}) } }));
      renderSteps(); persist(); run();
    } }, r.name)));

    function setFile(bytes, name) {
      fileBytes = bytes; fileName = name;
      const on = !!bytes;
      q('filebar').hidden = !on; input.disabled = on;
      if (on) { q('filename').textContent = name; q('filesize').textContent = formatBytes(bytes.length); input.value = ''; }
      input.placeholder = on ? 'A file is loaded — remove it to type text instead.' : 'Type, paste, or drop any file here (files are read as raw bytes)…';
      showMessage(q('filewarn'), on && bytes.length > FILE_WARN ? 'warn' : null, `This file is ${formatBytes(bytes.length)}. Large inputs can take a while and every step keeps its own copy in memory.`);
    }
    const loadFile = async f => {
      if (f.size > FILE_MAX) return toast(`File is larger than ${formatBytes(FILE_MAX)}; choose a smaller one`, 'error');
      try { setFile(new Uint8Array(await readFileAsArrayBuffer(f)), f.name); run(); toast(`Loaded ${f.name} (${formatBytes(f.size)})`, 'success'); }
      catch (e) { toast('Could not read file: ' + e.message, 'error'); }
    };

    bindActions(root, {
      add() { steps.push({ uid: ++uid, op: opSelect.value, enabled: true, params: {} }); renderSteps(); changed(); if (!auto.checked) run(); },
      run() { run(); },
      reset() { steps = []; renderSteps(); persist(); run(); },
      clear() { setFile(null, ''); input.value = ''; run(); input.focus(); },
      'remove-file'() { setFile(null, ''); run(); input.focus(); },
      copy() { copyText(finalText); },
      download() { downloadFile(view === 'hex' ? 'output.hex.txt' : 'output.txt', finalText); },
      'download-bytes'() {
        if (finalValue === null) return toast('No output to download', 'warn');
        const bytes = L.valueBytes(finalValue);
        if (!bytes.length) return toast('The output is empty', 'warn');
        downloadFile('output.bin', new Blob([bytes], { type: 'application/octet-stream' }));
      },
      use() {
        if (finalValue === null) return toast('No output to reuse', 'warn');
        const d = L.displayValue(finalValue);
        if (d.binary) setFile(L.valueBytes(finalValue).slice(), 'pipeline output'); // keep real bytes
        else { setFile(null, ''); input.value = d.text; }
        run();
      },
      async upload() { const f = await pickFile(''); if (f) loadFile(f); },
    });
    const offDrop = enableDrop(input.closest('.panel'), loadFile);

    renderSteps(); renderIcons(root);
    run();
    return () => { runToken++; offDrop(); };
  },
};
