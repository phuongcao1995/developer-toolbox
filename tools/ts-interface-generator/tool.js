// TypeScript Interface Generator UI. All inference / emitting lives in logic.js (which builds on assets/js/shared/ts-interfaces.js).
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, formatBytes, renderIcons } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { createSplit } from '../../assets/js/components/split.js';
import * as L from './logic.js';

const SAMPLE = `{
  "id": 1,
  "name": "Ada Lovelace",
  "email": null,
  "active": true,
  "role": "admin",
  "created": "2024-05-01T10:00:00Z",
  "address": { "street": "12 St James", "zip": "W1" },
  "orders": [
    { "id": 10, "total": 12.5, "status": "paid", "items": [{ "sku": "A-1", "qty": 2 }] },
    { "id": 11, "total": 7, "status": "shipped", "coupon": "SPRING" },
    { "id": 12, "total": 3, "status": "paid" }
  ]
}`;
const NOTES = {
  typescript: 'Nested objects become named interfaces. Arrays merge the shapes of their elements; properties missing from some elements become optional.',
  zod: 'Emits one Zod schema per object plus an inferred type. Requires the "zod" package (v3.22+ or v4).',
  jsdoc: 'Emits JSDoc @typedef blocks you can paste into plain JavaScript files (checkJs / editor hints). Export and interface options do not apply.',
};
const EXTS = { typescript: [['d.ts', '.d.ts'], ['ts', '.ts']], zod: [['ts', '.ts']], jsdoc: [['js', '.js']] };
const DEFAULTS = { target: 'typescript', format: 'auto', root: 'Root', style: 'interface', nullHandling: 'union', exp: true, readonly: false, optional: true, merge: true,
  samples: false, date: false, quote: false, comments: true, union: false, unionMax: 5, index: false, indexMin: 5 };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      target: $('#tsg-target'), format: $('#tsg-format'), root: $('#tsg-root'), style: $('#tsg-style'), nul: $('#tsg-null'), exp: $('#tsg-export'),
      readonly: $('#tsg-readonly'), optional: $('#tsg-optional'), merge: $('#tsg-merge'), samples: $('#tsg-samples'), date: $('#tsg-date'), quote: $('#tsg-quote'),
      comments: $('#tsg-comments'), union: $('#tsg-union'), unionMax: $('#tsg-union-max'), index: $('#tsg-index'), indexMin: $('#tsg-index-min'),
      input: $('#tsg-input'), output: $('#tsg-output'), msg: $('#tsg-msg'), stats: $('#tsg-stats'), warnings: $('#tsg-warnings'), note: $('#tsg-note'),
      ext: $('#tsg-ext'), styleField: $('#tsg-style-field'), inTitle: $('#tsg-in-title'),
    };
    const s = { ...DEFAULTS, ...(ctx.storage.get('opts', null) || {}) };
    els.target.value = s.target; els.format.value = s.format; els.root.value = s.root || 'Root'; els.style.value = s.style; els.nul.value = s.nullHandling;
    els.exp.checked = !!s.exp; els.readonly.checked = !!s.readonly; els.optional.checked = !!s.optional; els.merge.checked = !!s.merge; els.samples.checked = !!s.samples;
    els.date.checked = !!s.date; els.quote.checked = !!s.quote; els.comments.checked = !!s.comments; els.union.checked = !!s.union; els.unionMax.value = s.unionMax;
    els.index.checked = !!s.index; els.indexMin.value = s.indexMin;
    if (!els.target.value) els.target.value = 'typescript';

    const edIn = createEditor(els.input, { language: 'json', storage: ctx.storage, storageKey: 'input', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const edOut = createEditor(els.output, { language: 'typescript', storage: ctx.storage, storageKey: 'output', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, readOnly: true, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const split = createSplit($('.tsg-panels'), { direction: 'horizontal', storage: ctx.storage, storageKey: 'panels', labels: ['input', 'output'] });

    const num = (el, min, max, def) => { const n = Math.floor(+el.value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
    const options = () => ({
      target: els.target.value, format: els.format.value, rootName: els.root.value.trim() || 'Root', useInterface: els.style.value === 'interface', nullHandling: els.nul.value,
      exportKeyword: els.exp.checked, readonly: els.readonly.checked, optionalFromArrays: els.optional.checked, mergeArrayShapes: els.merge.checked, arrayAsSamples: els.samples.checked,
      dateMode: els.date.checked ? 'Date' : 'string', quoteKeys: els.quote.checked ? 'always' : 'auto', comments: els.comments.checked,
      stringUnions: els.union.checked, unionMax: num(els.unionMax, 1, 50, 5), indexSignatureMin: els.index.checked ? num(els.indexMin, 1, 1000, 5) : 0,
    });
    const persist = () => ctx.storage.set('opts', { target: els.target.value, format: els.format.value, root: els.root.value, style: els.style.value, nullHandling: els.nul.value,
      exp: els.exp.checked, readonly: els.readonly.checked, optional: els.optional.checked, merge: els.merge.checked, samples: els.samples.checked, date: els.date.checked,
      quote: els.quote.checked, comments: els.comments.checked, union: els.union.checked, unionMax: num(els.unionMax, 1, 50, 5), index: els.index.checked, indexMin: num(els.indexMin, 1, 1000, 5) });

    const badge = (text, cls = 'badge') => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    let lastError = null;

    function syncTarget() {
      const t = els.target.value;
      els.note.textContent = NOTES[t];
      edOut.setLanguage(t === 'jsdoc' ? 'javascript' : 'typescript');
      const prev = els.ext.value;
      els.ext.replaceChildren(...EXTS[t].map(([v, label]) => Object.assign(document.createElement('option'), { value: v, textContent: label })));
      if ([...els.ext.options].some(o => o.value === prev)) els.ext.value = prev;
      els.styleField.hidden = t !== 'typescript'; els.exp.disabled = t === 'jsdoc'; els.readonly.disabled = false;
    }

    function showError(err) {
      lastError = err;
      const box = els.msg;
      box.hidden = false; box.className = 'alert alert-error'; box.setAttribute('role', 'alert'); box.replaceChildren();
      if (err.empty) { box.className = 'alert alert-info'; box.setAttribute('role', 'status'); box.textContent = err.message; return; }
      box.append(document.createTextNode(`Invalid input at line ${err.line}, column ${err.column}: ${err.message}`));
      if (err.snippet) {
        const pre = document.createElement('code'); pre.className = 'tsg-err-pre';
        pre.textContent = `${err.snippet.line}\n${' '.repeat(Math.max(0, err.snippet.column))}^`; box.append(pre);
      }
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm tsg-err-btn'; b.textContent = 'Go to error';
      b.addEventListener('click', () => { els.input.focus(); try { els.input.setSelectionRange(err.offset, Math.min(els.input.value.length, err.offset + 1)); } catch { /* ignore */ } });
      box.append(document.createElement('br'), b);
    }

    function run() {
      const text = els.input.value;
      els.stats.replaceChildren(); els.warnings.replaceChildren(); showMessage(els.msg, null);
      if (!text.trim()) { els.output.value = ''; lastError = null; return; }
      let r;
      try { r = L.generate(text, options()); } catch (e) { r = { ok: false, error: { message: `Unexpected failure: ${e.message}`, line: 1, column: 1, offset: 0 } }; }
      if (!r.ok) { els.output.value = ''; showError(r.error); return; }
      lastError = null;
      els.output.value = r.code;
      const st = r.stats;
      const label = { json: 'JSON', multi: 'Multiple documents', schema: 'JSON Schema' }[r.format] || r.format;
      els.stats.append(badge(label, 'badge badge-info'), badge(`${st.declarations} declaration${st.declarations === 1 ? '' : 's'}`), badge(`${st.properties} properties`),
        badge(`${st.optional} optional`), badge(`${st.samples} sample${st.samples === 1 ? '' : 's'}`), badge(`Input ${formatBytes(new Blob([text]).size)}`));
      els.inTitle.textContent = r.format === 'schema' ? 'JSON Schema input' : r.format === 'multi' ? 'JSON documents input' : 'JSON input';
      for (const w of r.warnings) els.warnings.append(Object.assign(document.createElement('li'), { textContent: w }));
    }
    const runSoon = ctx.debounce(run, 250);

    async function loadFile(file) {
      if (!file) return;
      try {
        const t = await readFileAsText(file);
        els.input.value = t;
        if (/\.jsonl$|\.ndjson$/i.test(file.name)) els.format.value = 'multi';
        else if (/schema\.json$/i.test(file.name)) els.format.value = 'schema';
        persist(); run();
      } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const optionControls = [els.target, els.format, els.style, els.nul, els.exp, els.readonly, els.optional, els.merge, els.samples, els.date, els.quote, els.comments, els.union, els.index];
    const disposers = [
      on(els.input, 'input', runSoon),
      on(els.root, 'input', () => { persist(); runSoon(); }),
      ...[els.unionMax, els.indexMin].map(c => on(c, 'input', () => { persist(); runSoon(); })),
      ...optionControls.map(c => on(c, 'change', () => { persist(); if (c === els.target) syncTarget(); run(); })),
      on($('#tsg-upload'), 'click', async () => loadFile(await pickFile('.json,.jsonl,.ndjson,.txt,application/json'))),
      on($('#tsg-sample'), 'click', () => { els.input.value = SAMPLE; els.format.value = 'auto'; run(); }),
      on($('#tsg-clear'), 'click', () => { els.input.value = ''; run(); els.input.focus(); }),
      on($('#tsg-copy'), 'click', () => copyText(els.output.value)),
      on($('#tsg-download'), 'click', () => {
        if (!els.output.value) { toast('Nothing to download yet', 'warn'); return; }
        const ext = els.ext.value || 'ts';
        downloadFile(`types.${ext}`, els.output.value, 'text/plain;charset=utf-8');
      }),
      enableDrop($('#tsg-drop'), loadFile),
    ];
    syncTarget(); run(); renderIcons(root);
    void lastError;
    return () => { runSoon.cancel(); disposers.forEach(d => d()); split.destroy(); edIn.destroy(); edOut.destroy(); };
  },
};
