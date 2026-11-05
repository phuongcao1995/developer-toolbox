// Color Converter UI. All maths lives in logic.js.
import { copyText, downloadFile, initTabs, renderIcons, el, toast } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

const css = c => { const k = L.to255(c); return `rgba(${k.r}, ${k.g}, ${k.b}, ${L.roundTo(k.a, 3)})`; };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const E = id => $('#cc-' + id);
    const els = ['input', 'input-msg', 'picker', 'alpha', 'alpha-out', 'eyedropper', 'swatch', 'info', 'rounding', 'syntax', 'hexcase', 'hexshort', 'remember', 'formats',
      'scheme', 'steps', 'steps-field', 'end', 'end-picker', 'end-field', 'space', 'space-field', 'palette', 'palette-msg', 'exp-format', 'exp-prefix', 'export',
      'fg', 'fg-picker', 'bg', 'bg-picker', 'contrast-msg', 'sample', 'ratio', 'wcag', 'apca', 'suggest', 'cvd', 'batch-in', 'batch-count', 'batch-out']
      .reduce((o, k) => { o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = E(k); return o; }, {});

    // ---------------------------------------------------------------- persisted options
    const saved = ctx.storage.get('opts', null) || {};
    els.remember.checked = ctx.storage.get('remember', true) !== false;
    if (els.remember.checked) {
      if (saved.rounding) els.rounding.value = saved.rounding;
      if (saved.syntax) els.syntax.value = saved.syntax;
      if (saved.hexcase) els.hexcase.value = saved.hexcase;
      els.hexshort.checked = !!saved.hexshort;
      if (typeof saved.color === 'string') els.input.value = saved.color;
      if (L.parseColor(saved.fg).ok) els.fg.value = saved.fg;
      if (L.parseColor(saved.bg).ok) els.bg.value = saved.bg;
    }
    const persist = () => {
      ctx.storage.set('remember', els.remember.checked);
      if (!els.remember.checked) { ctx.storage.remove('opts'); return; }
      ctx.storage.set('opts', { rounding: els.rounding.value, syntax: els.syntax.value, hexcase: els.hexcase.value, hexshort: els.hexshort.checked,
        color: els.input.value, fg: els.fg.value, bg: els.bg.value });
    };
    const persistSoon = ctx.debounce(persist, 400);
    const opts = () => ({ rounding: els.rounding.value, syntax: els.syntax.value, hexCase: els.hexcase.value, hexShort: els.hexshort.checked });
    const hex = c => L.formatHex(c, { hexCase: els.hexcase.value, hexShort: els.hexshort.checked });

    // ---------------------------------------------------------------- helpers
    const say = (node, text, type = '') => { node.textContent = text || ''; node.className = `cc-msg${type ? ' cc-msg-' + type : ''}`; };
    const swatch = (c, cls = 'cc-chip') => { const d = el('span', { class: cls, 'aria-hidden': 'true' }); d.append(el('span', { class: 'cc-chip-fill' })); d.firstChild.style.background = css(c); return d; };
    const copyBtn = (text, label) => el('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': label, title: label, onclick: () => copyText(text) }, el('i', { 'data-lucide': 'copy' }));

    let cur = L.parseColor(els.input.value).color || L.parseColor('#3a58e8').color;

    // ---------------------------------------------------------------- CONVERT
    function renderConvert() {
      els.swatch.replaceChildren(el('span', { class: 'cc-chip-fill' }));
      els.swatch.firstChild.style.background = css(cur);
      els.swatch.setAttribute('aria-label', `Colour preview: ${hex(cur)}`);
      const rows = L.formatAll(cur, opts());
      els.formats.replaceChildren(...rows.map(r => el('tr', {}, el('th', { scope: 'row' }, r.label), el('td', { class: 'cc-val' }, r.value), el('td', {}, copyBtn(r.value, `Copy ${r.label}`)))));
      const nm = L.nearestName(cur);
      const info = [nm.exact ? `CSS name: ${nm.name}` : `Nearest CSS name: ${nm.name} (${nm.hex})`];
      const lum = L.relativeLuminance(cur);
      info.push(`Relative luminance ${L.roundTo(lum, 4)}`);
      els.info.replaceChildren(...info.map(t => el('span', { class: 'badge' }, t)));
      if (cur._outOfGamut) els.info.append(el('span', { class: 'badge badge-warn' }, 'Outside sRGB: RGB/HEX are clamped; Lab/OKLab/OKLCH/color() keep the original'));
      els.picker.value = L.formatHex(cur, { alpha: false });
      els.alpha.value = String(L.roundTo(cur.a, 2)); els.alphaOut.textContent = String(L.roundTo(cur.a, 2));
      renderIcons(els.formats);
      renderPalette(); renderContrast(); renderCvd();
    }
    function setColor(c, { from = '', text = null, gamut = true } = {}) {
      cur = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 };
      cur._outOfGamut = !gamut;
      if (from !== 'input') els.input.value = text ?? (cur.a < 1 ? L.formatColor(cur, 'hex', opts()) : hex(cur));
      say(els.inputMsg, '');
      renderConvert(); persistSoon();
    }
    function onInput() {
      const r = L.parseColor(els.input.value);
      if (!r.ok) { say(els.inputMsg, r.error, 'error'); els.input.setAttribute('aria-invalid', 'true'); return; }
      els.input.removeAttribute('aria-invalid');
      setColor(r.color, { from: 'input', gamut: r.inGamut !== false });
      say(els.inputMsg, [`Parsed as ${r.format}.`, ...(r.warnings || [])].join(' '), 'ok');
    }

    // ---------------------------------------------------------------- PALETTE
    let paletteEntries = [];
    function renderPalette() {
      const kind = els.scheme.value;
      els.stepsField.hidden = !['monochromatic', 'tints', 'shades', 'gradient'].includes(kind);
      els.endField.hidden = els.spaceField.hidden = kind !== 'gradient';
      say(els.paletteMsg, '');
      let list;
      if (L.SCHEMES[kind]) list = L.harmony(cur, kind);
      else if (kind === 'monochromatic') list = L.monochromatic(cur, +els.steps.value || 7);
      else if (kind === 'tints') list = [{ name: 'base', color: cur }, ...L.tints(cur, +els.steps.value || 5)];
      else if (kind === 'shades') list = [{ name: 'base', color: cur }, ...L.shades(cur, +els.steps.value || 5)];
      else if (kind === 'scale') list = L.materialScale(cur);
      else {
        const end = L.parseColor(els.end.value);
        if (!end.ok) { say(els.paletteMsg, `End colour: ${end.error}`, 'error'); list = []; }
        else list = L.gradient(cur, end.color, +els.steps.value || 7, els.space.value);
      }
      paletteEntries = list;
      els.palette.replaceChildren(...list.map(e => {
        const h = hex(e.color);
        const b = el('button', { type: 'button', class: 'cc-sw', title: `Copy ${h}`, 'aria-label': `${e.name}: ${h}. Copy`, onclick: () => copyText(h, `Copied ${h}`) });
        const fill = el('span', { class: 'cc-sw-fill' }); fill.style.background = css(e.color);
        b.append(fill, el('span', { class: 'cc-sw-name' }, e.name), el('span', { class: 'cc-sw-hex' }, h));
        return b;
      }));
      if (!list.length) els.palette.replaceChildren(el('p', { class: 'hint' }, 'No colours to show.'));
      els.export.value = list.length ? L.exportPalette(list.map(e => ({ name: e.name, color: e.color })), els.expFormat.value, { prefix: els.expPrefix.value || 'color', hexCase: els.hexcase.value }) : '';
    }

    // ---------------------------------------------------------------- CONTRAST
    function readPair() {
      const f = L.parseColor(els.fg.value), b = L.parseColor(els.bg.value);
      return { f, b };
    }
    function renderContrast() {
      const { f, b } = readPair();
      const errs = [!f.ok && `Foreground: ${f.error}`, !b.ok && `Background: ${b.error}`].filter(Boolean);
      say(els.contrastMsg, errs.join(' '), errs.length ? 'error' : '');
      if (errs.length) return;
      els.fg.removeAttribute('aria-invalid');
      els.fgPicker.value = L.formatHex(f.color, { alpha: false }); els.bgPicker.value = L.formatHex(b.color, { alpha: false });
      els.sample.style.color = css(f.color); els.sample.style.background = css(L.composite(b.color, { r: 1, g: 1, b: 1, a: 1 }));
      const ratio = L.contrastRatio(f.color, b.color);
      els.ratio.textContent = `Contrast ratio ${L.formatRatio(ratio)}`;
      els.wcag.replaceChildren(...L.wcagChecks(ratio).map(c => el('tr', {}, el('td', {}, c.label), el('td', {}, `${c.min}:1`),
        el('td', {}, el('span', { class: `badge ${c.pass ? 'badge-success' : 'badge-danger'}` }, c.pass ? 'Pass' : 'Fail')))));
      const lc = L.apcaLc(f.color, b.color);
      els.apca.textContent = `APCA (informational, WCAG 3 draft): Lc ${L.roundTo(lc, 1)}. Roughly |Lc| 75+ suits body text, 60+ large text, 45+ headlines; this is not a pass/fail standard yet.`;
      if (f.color.a < 1 || b.color.a < 1) els.apca.textContent += ' Translucent colours are composited (background over white, then text over background).';
      // suggestions
      const items = [];
      for (const [label, target] of [['AA normal text (4.5:1)', 4.5], ['AA large text / UI (3:1)', 3], ['AAA normal text (7:1)', 7]]) {
        const s = L.suggestForeground(f.color, b.color, target);
        if (!s) items.push(el('li', {}, `${label}: not reachable with this background by changing only the text colour. Change the background.`));
        else if (s.unchanged) items.push(el('li', {}, `${label}: already passes (${L.formatRatio(s.ratio)}).`));
        else {
          const h = L.formatHex(s.color, { alpha: false });
          items.push(el('li', {}, swatch(s.color), ` ${label}: nearest passing text colour `, el('code', {}, h), ` (${L.formatRatio(s.ratio)}) `,
            el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { els.fg.value = h; renderContrast(); renderCvd(); persistSoon(); } }, 'Apply')));
        }
      }
      els.suggest.replaceChildren(el('ul', {}, ...items));
      renderCvd();
    }

    // ---------------------------------------------------------------- CVD
    function renderCvd() {
      const f = L.parseColor(els.fg.value), b = L.parseColor(els.bg.value);
      const types = [['normal', 'Normal vision']].concat(Object.entries(L.CVD).map(([k, v]) => [k, v.label]));
      const sim = (c, t) => (t === 'normal' ? L.clampRgb(c) : L.simulateCvd(c, t));
      els.cvd.replaceChildren(...types.map(([t, label]) => {
        const sc = sim(cur, t);
        const card = el('div', { class: 'cc-cvd-card' }, el('h3', {}, label));
        const row = el('div', { class: 'cc-cvd-row' }, swatch(sc, 'cc-chip cc-chip-lg'), el('code', {}, L.formatHex(sc, { alpha: false })));
        card.append(row);
        if (f.ok && b.ok) {
          const fs = sim(f.color, t), bs = sim(L.composite(b.color, { r: 1, g: 1, b: 1, a: 1 }), t);
          const tile = el('div', { class: 'cc-cvd-tile' }, 'Aa text');
          tile.style.color = css(fs); tile.style.background = css(bs);
          card.append(tile, el('p', { class: 'hint' }, `Text/background contrast ${L.formatRatio(L.contrastRatio(fs, bs))}`));
        }
        return card;
      }));
    }

    // ---------------------------------------------------------------- BATCH
    let batch = { rows: [] };
    function renderBatch() {
      batch = L.parseMany(els.batchIn.value, opts());
      const okN = batch.rows.filter(r => r.ok).length;
      els.batchCount.textContent = batch.total ? `${okN} of ${batch.total} parsed${batch.truncated ? ` (only the first ${L.MAX_BATCH_LINES} lines are processed)` : ''}` : 'No input';
      els.batchOut.replaceChildren(...batch.rows.map(r => {
        if (!r.ok) return el('tr', {}, el('td', {}, r.input), el('td', { colspan: '5', class: 'cc-err' }, `Line ${r.line}: ${r.error}`));
        const td = (t) => el('td', { class: 'cc-val' }, t);
        return el('tr', {}, el('td', {}, r.input), el('td', {}, swatch(r.color)), td(r.hex), td(r.rgb), td(r.hsl), td(r.oklch));
      }));
    }
    const renderBatchSoon = ctx.debounce(renderBatch, 250);

    // ---------------------------------------------------------------- events
    const disposers = [];
    const on = (t, ev, fn) => { t.addEventListener(ev, fn); disposers.push(() => t.removeEventListener(ev, fn)); };
    initTabs(root);
    on(els.input, 'input', onInput);
    on(els.picker, 'input', () => { const r = L.parseColor(els.picker.value); setColor({ ...r.color, a: cur.a }); });
    on(els.alpha, 'input', () => { setColor({ ...cur, a: +els.alpha.value }); });
    for (const k of ['rounding', 'syntax', 'hexcase', 'hexshort']) on(els[k], 'change', () => { persist(); renderConvert(); renderBatch(); });
    on(els.remember, 'change', () => { persist(); toast(els.remember.checked ? 'Options will be remembered' : 'Saved options removed', 'info'); });
    if (typeof window.EyeDropper === 'function') {
      els.eyedropper.hidden = false;
      on(els.eyedropper, 'click', async () => {
        try { const r = await new window.EyeDropper().open(); const p = L.parseColor(r.sRGBHex); if (p.ok) setColor({ ...p.color, a: cur.a }); }
        catch (e) { if (e?.name !== 'AbortError') say(els.inputMsg, 'The eyedropper could not pick a colour.', 'error'); }
      });
    }
    on(els.scheme, 'change', renderPalette);
    on(els.steps, 'input', renderPalette);
    on(els.space, 'change', renderPalette);
    on(els.end, 'input', () => { const r = L.parseColor(els.end.value); if (r.ok) els.endPicker.value = L.formatHex(r.color, { alpha: false }); renderPalette(); });
    on(els.endPicker, 'input', () => { els.end.value = els.endPicker.value; renderPalette(); });
    on(els.expFormat, 'change', renderPalette);
    on(els.expPrefix, 'input', renderPalette);
    on($('#cc-exp-copy'), 'click', () => copyText(els.export.value));
    on($('#cc-exp-download'), 'click', () => {
      const ext = { css: 'css', scss: 'scss', tailwind: 'js', json: 'json' }[els.expFormat.value];
      downloadFile(`palette.${ext}`, els.export.value, 'text/plain;charset=utf-8');
    });
    for (const k of ['fg', 'bg']) {
      on(els[k], 'input', () => { renderContrast(); persistSoon(); });
      on(els[k + 'Picker'], 'input', () => { els[k].value = els[k + 'Picker'].value; renderContrast(); persistSoon(); });
    }
    on($('#cc-swap'), 'click', () => { [els.fg.value, els.bg.value] = [els.bg.value, els.fg.value]; renderContrast(); persistSoon(); });
    on($('#cc-use-current'), 'click', () => { els.fg.value = L.formatColor(cur, 'hex', opts()); renderContrast(); persistSoon(); });
    on(els.batchIn, 'input', renderBatchSoon);
    on($('#cc-batch-sample'), 'click', () => { els.batchIn.value = '#ff0000\nrgb(0 128 255)\nhsl(280 60% 40%)\noklch(0.7 0.15 150)\ntomato\ncolor(display-p3 1 0.5 0)\n#12345'; renderBatch(); });
    on($('#cc-batch-clear'), 'click', () => { els.batchIn.value = ''; renderBatch(); els.batchIn.focus(); });
    on($('#cc-batch-copy'), 'click', () => copyText(batch.rows.length ? L.batchToCsv(batch.rows) : '', 'Copied CSV'));

    // initial paint
    const first = L.parseColor(els.input.value);
    if (!first.ok) els.input.value = '#3a58e8';
    onInput();
    renderBatch(); renderIcons(root);
    return () => { disposers.forEach(d => d()); };
  },
};
