import { copyText, downloadFile, toast, pickFile, enableDrop, showMessage, bindActions, readFileAsText, debounce, el, renderIcons, formatBytes } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const input = q('input'), output = q('output'), stepsBox = q('steps'), opSelect = q('opselect'), auto = q('auto'), err = q('err');
    let steps = [];            // [{uid, op, enabled, params}]
    let uid = 0, runToken = 0, finalText = '';
    const rows = new Map();    // uid -> {box, out}

    // Operation picker grouped by category.
    for (const g of ['Encode', 'Decode', 'Hash']) {
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
      const res = await L.runPipeline(input.value, steps);
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
        finalText = ''; output.value = ''; q('outbadge').textContent = '';
      } else {
        showMessage(err, null);
        finalText = res.final.text; output.value = finalText;
        q('outbadge').textContent = res.final.binary ? `binary · ${res.final.bytes} B (hex)` : `${finalText.length} chars`;
      }
      q('inmeta').textContent = input.value ? `${input.value.length} chars · ${formatBytes(new TextEncoder().encode(input.value).length)} UTF-8` : '';
    }
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

    const loadFile = async f => {
      if (f.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB', 'error');
      try { input.value = await readFileAsText(f); run(); toast(`Loaded ${f.name}`, 'success'); } catch (e) { toast('Could not read file: ' + e.message, 'error'); }
    };

    bindActions(root, {
      add() { steps.push({ uid: ++uid, op: opSelect.value, enabled: true, params: {} }); renderSteps(); changed(); if (!auto.checked) run(); },
      run() { run(); },
      reset() { steps = []; renderSteps(); persist(); run(); },
      clear() { input.value = ''; run(); input.focus(); },
      copy() { copyText(finalText); },
      download() { downloadFile('output.txt', finalText); },
      use() { if (!finalText) return toast('No output to reuse', 'warn'); input.value = finalText; run(); },
      async upload() { const f = await pickFile('.txt,.json,.csv,.log,text/*'); if (f) loadFile(f); },
    });
    const offDrop = enableDrop(input.closest('.panel'), loadFile);

    renderSteps(); renderIcons(root);
    run();
    return () => { runToken++; offDrop(); };
  },
};
