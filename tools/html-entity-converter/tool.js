// HTML Entity Converter UI. Encoding / decoding live in logic.js; everything shown is inserted with textContent.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, initTabs, formatBytes, renderIcons } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { createSplit } from '../../assets/js/components/split.js';
import * as L from './logic.js';

const PREVIEW_LIMIT = 20000;
const NOTES = {
  special: 'Only the characters of the chosen "Encode for" set are converted; accented letters, symbols and emoji stay as they are.',
  nonascii: 'The special characters and every non-ASCII character are converted. The result is pure ASCII.',
  all: 'Every character, letters and digits included, becomes a reference (useful for obfuscation or testing). C1 controls and NUL are kept as they are.',
};
const DEFAULTS = { scope: 'nonascii', safe: 'default', numeric: 'decimal', context: 'text', named: true, keep: false, invisible: true };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      scope: $('#hec-scope'), safe: $('#hec-safe'), numeric: $('#hec-numeric'), context: $('#hec-context'), named: $('#hec-named'), keep: $('#hec-keep'),
      invisible: $('#hec-invisible'), note: $('#hec-note'), msg: $('#hec-msg'), text: $('#hec-text'), ent: $('#hec-ent'), hints: $('#hec-hints'), stats: $('#hec-stats'),
      preview: $('#hec-preview'), q: $('#hec-q'), cat: $('#hec-cat'), style: $('#hec-style'), rows: $('#hec-rows'), refCount: $('#hec-ref-count'),
    };
    const saved = { ...DEFAULTS, ...(ctx.storage.get('opts', null) || {}) };
    els.scope.value = saved.scope; els.safe.value = saved.safe; els.numeric.value = saved.numeric; els.context.value = saved.context;
    els.named.checked = !!saved.named; els.keep.checked = !!saved.keep; els.invisible.checked = !!saved.invisible;
    for (const c of L.CATEGORIES) els.cat.append(Object.assign(document.createElement('option'), { value: c, textContent: c }));
    els.style.value = ctx.storage.get('refStyle', 'name');
    if (!els.style.value) els.style.value = 'name';

    const edText = createEditor(els.text, { language: 'plain', storage: ctx.storage, storageKey: 'text', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const edEnt = createEditor(els.ent, { language: 'plain', storage: ctx.storage, storageKey: 'entities', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const split = createSplit($('.hec-panels'), { direction: 'horizontal', storage: ctx.storage, storageKey: 'panels', labels: ['plain text', 'HTML entities'] });
    const selectTab = initTabs(root);

    let side = 'text'; // which editor the user edited last: that one is the source of truth
    const opts = () => ({
      scope: els.scope.value, safe: els.safe.value, preferNamed: els.named.checked, keepExisting: els.keep.checked,
      numeric: els.numeric.value === 'decimal' ? 'decimal' : 'hex', hexCase: els.numeric.value === 'hexlower' ? 'lower' : 'upper',
    });
    const persist = () => ctx.storage.set('opts', { scope: els.scope.value, safe: els.safe.value, numeric: els.numeric.value, context: els.context.value,
      named: els.named.checked, keep: els.keep.checked, invisible: els.invisible.checked });

    const badge = (text, cls = 'badge') => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    const hint = (type, text, btn) => {
      const d = document.createElement('div'); d.className = `alert alert-${type}`; d.textContent = text + (btn ? ' ' : '');
      if (btn) d.append(btn);
      els.hints.append(d);
    };
    const actionBtn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = label; b.addEventListener('click', fn); return b; };

    function renderPreview() {
      const t = els.text.value;
      const cut = t.length > PREVIEW_LIMIT;
      const shown = cut ? t.slice(0, PREVIEW_LIMIT) : t;
      els.preview.textContent = (els.invisible.checked ? L.visualizeInvisible(shown) : shown) + (cut ? `\n\n… preview limited to the first ${PREVIEW_LIMIT.toLocaleString()} characters` : '');
    }

    function run() {
      els.hints.replaceChildren(); els.stats.replaceChildren(); showMessage(els.msg, null);
      const o = opts();
      let sourceLabel;
      if (side === 'text') {
        const r = L.encodeDetailed(els.text.value, o);
        els.ent.value = r.text;
        sourceLabel = 'Encoded';
        const s = r.stats;
        if (s.loneSurrogates) hint('warn', `${s.loneSurrogates} unpaired surrogate code unit(s) cannot be represented and were replaced by U+FFFD.`);
        if (s.c1Kept) hint('info', `${s.c1Kept} control character(s) (NUL or U+0080-U+009F) were kept as they are: a numeric reference to them would decode to a different character.`);
        els.stats.append(badge('Encoded', 'badge badge-info'), badge(`${s.named} named`), badge(`${s.decimal + s.hex} numeric`), badge(`${s.kept} existing kept`), badge(`${s.astral} astral (emoji etc.)`));
      } else {
        const r = L.decodeDetailed(els.ent.value, { context: els.context.value });
        els.text.value = r.text;
        sourceLabel = 'Decoded';
        const s = r.stats;
        els.stats.append(badge('Decoded', 'badge badge-info'), badge(`${s.named} named`), badge(`${s.decimal + s.hex} numeric`));
        if (s.legacy) els.stats.append(badge(`${s.legacy} without ";"`));
        if (s.invalid) els.stats.append(badge(`${s.invalid} invalid`, 'badge badge-danger'));
        if (s.remapped) els.stats.append(badge(`${s.remapped} windows-1252 remapped`, 'badge badge-warn'));
        if (s.unknown) els.stats.append(badge(`${s.unknown} unknown name(s)`, 'badge badge-warn'));
        if (s.invalid) hint('warn', `${s.invalid} numeric reference(s) are outside Unicode or are surrogates / zero and were replaced by U+FFFD, as browsers do.`);
        if (s.remapped) hint('info', `${s.remapped} reference(s) in the range &#128;-&#159; were mapped through windows-1252 (for example &#128; is the euro sign), as browsers do.`);
        if (s.ambiguous) hint('info', `${s.ambiguous} ambiguous reference(s) such as &copy=1 were left unchanged, as browsers do in attribute values.`);
        if (s.unknown) hint('warn', `${s.unknown} named reference(s) are not in this tool's table and were left as they are.`);
      }
      const dbl = L.detectDoubleEncoded(els.ent.value);
      if (side === 'entities' && els.ent.value && (dbl.doubleEncoded || dbl.decodesAgain)) {
        hint('warn', dbl.doubleEncoded
          ? `This looks double-encoded (${dbl.count} reference(s) such as &amp;lt; or &amp;#39;). The decoded text still contains entities.`
          : 'The decoded text still contains entities, so the input may be encoded more than once.',
        actionBtn('Decode again', decodeAgain));
      }
      const ts = L.textStats(els.text.value), es = L.textStats(els.ent.value);
      els.stats.append(badge(`Text: ${ts.codePoints.toLocaleString()} chars, ${formatBytes(ts.bytes)}`), badge(`Entities: ${es.chars.toLocaleString()} chars, ${formatBytes(es.bytes)}`));
      if (ts.astral) els.stats.append(badge(`${ts.astral} astral`));
      renderPreview();
      return sourceLabel;
    }
    const runSoon = ctx.debounce(run, 120);

    function decodeAgain() {
      const r = L.decodeRepeatedly(els.ent.value, { context: els.context.value, passes: 1 });
      els.ent.value = r.text; side = 'entities'; run();
    }
    // The "Decode again" header button: the plain text becomes the new entity input (peels one more layer).
    function peel() {
      if (!els.text.value) { toast('Nothing to decode again', 'warn'); return; }
      if (!L.hasEntities(els.text.value, { context: els.context.value })) { toast('The decoded text contains no more entities', 'info'); return; }
      els.ent.value = els.text.value; side = 'entities'; run();
    }

    const updateNote = () => { els.note.textContent = NOTES[els.scope.value] + ' Decoding handles named, decimal and hex references, including legacy names without ";" and code points above U+FFFF.'; };

    async function loadFile(file) {
      if (!file) return;
      try { els.text.value = await readFileAsText(file); side = 'text'; run(); } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    // ---------- reference browser ----------
    const refStyleText = e => (els.style.value === 'char' ? e.char : L.entityText(e, els.style.value));
    let shown = [];
    function renderRows() {
      shown = L.searchEntities(els.q.value, els.cat.value);
      els.refCount.textContent = `${shown.length} of ${L.ENTITIES.length} entities. Use Insert to add one to the entities editor, or Copy.`;
      const frag = document.createDocumentFragment();
      shown.forEach((e, i) => {
        const tr = document.createElement('tr');
        const td = (child, cls) => { const c = document.createElement('td'); if (cls) c.className = cls; if (child != null) c.append(child); tr.append(c); return c; };
        td(e.char === ' ' ? '␣' : e.char, 'hec-glyph').setAttribute('aria-label', `character ${e.name}`);
        const name = document.createElement('code'); name.textContent = `&${e.name};`;
        const nameTd = td(name);
        if (e.alias) nameTd.append(Object.assign(document.createElement('span'), { className: 'hec-alias', textContent: 'alias' }));
        else if (e.legacy) nameTd.append(Object.assign(document.createElement('span'), { className: 'hec-alias', textContent: 'also without ;', title: 'Browsers also accept this name without the closing semicolon' }));
        td(Object.assign(document.createElement('code'), { textContent: `&#${e.cp};` }));
        td(Object.assign(document.createElement('code'), { textContent: `${L.codePointLabel(e.cp)}` }));
        td(e.desc);
        const act = td(null, 'hec-act-cell'); const wrap = document.createElement('div'); wrap.className = 'hec-act';
        for (const [kind, label] of [['insert', 'Insert'], ['copy', 'Copy']]) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-sm'; b.dataset.kind = kind; b.dataset.i = String(i);
          b.textContent = label; b.setAttribute('aria-label', `${label} ${e.name}`); wrap.append(b);
        }
        act.append(wrap); frag.append(tr);
      });
      if (!shown.length) { const tr = document.createElement('tr'); const c = document.createElement('td'); c.colSpan = 6; c.textContent = 'No entity matches your search.'; tr.append(c); frag.append(tr); }
      els.rows.replaceChildren(frag);
    }
    function onRowClick(e) {
      const b = e.target.closest('button[data-kind]');
      if (!b) return;
      const ent = shown[+b.dataset.i]; if (!ent) return;
      const text = refStyleText(ent);
      if (b.dataset.kind === 'copy') { copyText(text, `Copied ${text}`); return; }
      const ta = els.ent, s = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? s;
      ta.setRangeText(text, s, en, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      toast(`Inserted ${text} into the entities editor`, 'success');
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const disposers = [
      on(els.text, 'input', () => { side = 'text'; runSoon(); }),
      on(els.ent, 'input', () => { side = 'entities'; runSoon(); }),
      ...[els.scope, els.safe, els.numeric, els.context, els.named, els.keep].map(c => on(c, 'change', () => { persist(); updateNote(); run(); })),
      on(els.invisible, 'change', () => { persist(); renderPreview(); }),
      on($('#hec-upload'), 'click', async () => loadFile(await pickFile('.txt,.html,.htm,.xml,.md,.json,.csv,text/*'))),
      on($('#hec-clear'), 'click', () => { els.text.value = ''; els.ent.value = ''; side = 'text'; run(); els.text.focus(); }),
      on($('#hec-copy-text'), 'click', () => copyText(els.text.value)),
      on($('#hec-copy-ent'), 'click', () => copyText(els.ent.value)),
      on($('#hec-dl-text'), 'click', () => downloadFile('text.txt', els.text.value, 'text/plain;charset=utf-8')),
      on($('#hec-dl-ent'), 'click', () => downloadFile('entities.txt', els.ent.value, 'text/plain;charset=utf-8')),
      on($('#hec-again'), 'click', peel),
      on(els.q, 'input', ctx.debounce(renderRows, 100)),
      on(els.cat, 'change', renderRows),
      on(els.style, 'change', () => ctx.storage.set('refStyle', els.style.value)),
      on(els.rows, 'click', onRowClick),
      enableDrop($('#hec-drop-text'), loadFile),
      enableDrop($('#hec-drop-ent'), async f => { if (!f) return; try { els.ent.value = await readFileAsText(f); side = 'entities'; run(); } catch { showMessage(els.msg, 'error', 'Could not read that file.'); } }),
    ];
    updateNote(); renderRows(); run(); renderIcons(root);
    void selectTab;
    return () => { runSoon.cancel(); disposers.forEach(d => d()); split.destroy(); edText.destroy(); edEnt.destroy(); };
  },
};
