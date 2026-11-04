import { copyText, showMessage, bindActions, el, escapeHtml, renderIcons } from '../../assets/js/components/ui.js';
import { FIELDS, MONTH_NAMES, DAY_NAMES, PRESETS, parseCron, explain, nextRuns, formatRun, detectMode, composeField } from './logic.js';

const DEFAULT_EXPR = '0 9 * * 1-5';
const MODES = [['every', 'Every'], ['specific', 'Specific values'], ['range', 'Range'], ['step', 'Step (every N)']];

/** Short label for a value in a given field (names for month / weekday). */
const valueLabel = (spec, v) => spec.key === 'month' ? MONTH_NAMES[v - 1].slice(0, 3)
  : spec.key === 'dow' ? DAY_NAMES[v].slice(0, 3) : String(v);
/** Selectable values for a field (day-of-week uses 0-6 in the UI). */
const valuesOf = spec => Array.from({ length: spec.top - spec.min + 1 }, (_, i) => spec.min + i);

function relative(ms) {
  const s = Math.round(ms / 1000), a = Math.abs(s);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [n, sec] of units) if (a >= sec) { const q = Math.floor(a / sec); return `in ${q} ${n}${q > 1 ? 's' : ''}`; }
  return 'in less than a minute';
}

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const input = $('cron-expr'), msg = $('cron-msg');
    let lastRuns = [], lastDates = [], relCells = [];

    // ---------- builder ----------
    const cards = FIELDS.map(spec => {
      const vals = valuesOf(spec);
      const modeSel = el('select', { class: 'select', 'aria-label': `${spec.label} mode` },
        MODES.map(([v, l]) => el('option', { value: v }, l)));
      const boxes = vals.map(v => {
        const cb = el('input', { type: 'checkbox', value: v });
        return { v, cb, label: el('label', {}, cb, valueLabel(spec, v)) };
      });
      const grid = el('div', { class: 'cron-grid' }, boxes.map(b => b.label));
      const opt = v => el('option', { value: v }, valueLabel(spec, v));
      const fromSel = el('select', { class: 'select', 'aria-label': 'From' }, vals.map(opt));
      const toSel = el('select', { class: 'select', 'aria-label': 'To' }, vals.map(opt));
      toSel.value = spec.top;
      const range = el('div', { class: 'cron-sub' }, 'From', fromSel, 'to', toSel);
      const stepInp = el('input', { class: 'input', type: 'number', min: 1, max: spec.top - spec.min + 1, value: 5, 'aria-label': 'Step' });
      const startSel = el('select', { class: 'select', 'aria-label': 'Start' }, vals.map(opt));
      const step = el('div', { class: 'cron-sub' }, 'Every', stepInp, `${spec.unit}(s), starting at`, startSel);
      const exprTag = el('span', { class: 'mono' }, '*');
      const hint = el('p', { class: 'hint', role: 'status', hidden: true }, 'Tick at least one value, or switch the mode to "Every".');
      const card = el('div', { class: 'cron-card' },
        el('h4', {}, spec.label, exprTag), modeSel, grid, hint, range, step);
      const c = { spec, modeSel, boxes, fromSel, toSel, stepInp, startSel, grid, range, step, exprTag, card, hint };
      const showPanels = () => {
        grid.hidden = modeSel.value !== 'specific'; range.hidden = modeSel.value !== 'range'; step.hidden = modeSel.value !== 'step';
      };
      c.showPanels = showPanels;
      card.addEventListener('input', () => { showPanels(); fromBuilder(); });
      showPanels();
      return c;
    });
    $('cron-builder').append(...cards.map(c => c.card));

    const getState = c => ({
      mode: c.modeSel.value,
      values: c.boxes.filter(b => b.cb.checked).map(b => b.v),
      from: Number(c.fromSel.value), to: Number(c.toSel.value),
      step: Number(c.stepInp.value), start: Number(c.startSel.value),
    });
    const setState = (c, st) => {
      c.modeSel.value = st.mode;
      c.boxes.forEach(b => { b.cb.checked = st.values.includes(b.v); });
      c.fromSel.value = st.from; c.toSel.value = st.to;
      c.stepInp.value = st.step; c.startSel.value = st.start;
      c.showPanels();
    };

    /** Builder -> expression text. */
    function fromBuilder() {
      cards.forEach(c => { c.hint.hidden = true; });
      try {
        const texts = cards.map(c => {
          try { return composeField(getState(c), c.spec); }
          catch (e) { if (getState(c).mode === 'specific') c.hint.hidden = false; throw e; }
        });
        input.value = texts.join(' ');
        update(false);
      } catch (e) { showMessage(msg, 'error', e.message); }
    }
    /** Expression -> builder UI (only when the expression is valid). */
    function toBuilder(parsed) {
      cards.forEach(c => setState(c, detectMode(parsed.fields[c.spec.key], c.spec)));
    }

    // ---------- presets ----------
    $('cron-presets').append(...PRESETS.map(([label, expr]) =>
      el('button', { class: 'chip', title: expr, onclick: () => { input.value = expr; update(true); } }, label)));

    // ---------- render ----------
    const tzUtc = () => root.querySelector('input[name="cron-tz"]:checked')?.value === 'utc';
    const renderRuns = parsed => {
      const tb = $('cron-runs'), note = $('cron-runs-note');
      tb.replaceChildren(); note.hidden = true; lastRuns = []; lastDates = []; relCells = [];
      $('cron-dst-note').hidden = tzUtc(); // DST only matters for local time
      if (!parsed) return;
      const utc = tzUtc();
      const now = Date.now();
      const { runs, exhausted } = nextRuns(parsed, new Date(), { count: 10, utc });
      lastRuns = runs.map(d => formatRun(d, utc)); lastDates = runs;
      runs.forEach((d, i) => {
        const rel = el('td', { class: 'cron-rel' }, relative(d.getTime() - now));
        relCells.push(rel);
        tb.append(el('tr', {}, el('td', {}, String(i + 1)), el('td', { class: 'mono' }, lastRuns[i]), rel));
      });
      if (exhausted) {
        note.hidden = false;
        note.textContent = runs.length === 0
          ? 'This expression never matches within the next 10 years (for example day 31 in a 30-day month, or Feb 30).'
          : `Only ${runs.length} run(s) occur within the next 10 years.`;
      }
      $('cron-count').textContent = String(runs.length || 10);
    };

    function update(syncBuilder) {
      const parsed = parseCron(input.value);
      if (!parsed.ok) {
        $('cron-explain').textContent = '';
        msg.hidden = false; msg.className = 'alert alert-error';
        msg.innerHTML = parsed.errors.length === 1 ? escapeHtml(parsed.errors[0].message)
          : '<ul>' + parsed.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('') + '</ul>';
        if (!input.value.trim()) showMessage(msg, null);
        renderRuns(null);
        cards.forEach(c => { c.exprTag.textContent = parsed.errors.some(e => e.field === c.spec.key) ? 'invalid' : c.exprTag.textContent; });
        return;
      }
      showMessage(msg, null);
      $('cron-explain').textContent = explain(parsed) + (parsed.alias ? `  (${parsed.alias} = ${parsed.expr})` : '');
      cards.forEach(c => { c.exprTag.textContent = parsed.fields[c.spec.key].text; });
      if (syncBuilder) toBuilder(parsed);
      renderRuns(parsed);
      ctx.storage.set('expr', input.value.trim());
    }

    input.addEventListener('input', () => update(true));
    root.querySelectorAll('input[name="cron-tz"]').forEach(r => r.addEventListener('change', () => renderRuns(parseCron(input.value).ok ? parseCron(input.value) : null)));
    bindActions(root, {
      copy: () => { if (parseCron(input.value).ok) copyText(input.value.trim()); else showMessage(msg, 'error', 'Fix the expression before copying.'); },
      clear: () => { input.value = ''; update(false); input.focus(); },
      'copy-runs': () => copyText(lastRuns.join('\n')),
    });

    input.value = ctx.storage.get('expr', DEFAULT_EXPR) || DEFAULT_EXPR;
    update(true);
    // Refresh the "relative" column once a minute; cleared on unmount.
    // Only the relative-time cells are touched; the list is recomputed only once its first run has passed.
    const timer = setInterval(() => {
      const now = Date.now();
      if (!lastDates.length) return;
      if (lastDates[0].getTime() <= now) { const p = parseCron(input.value); if (p.ok) renderRuns(p); return; }
      lastDates.forEach((d, i) => { const t = relative(d.getTime() - now); if (relCells[i].textContent !== t) relCells[i].textContent = t; });
    }, 60000);
    renderIcons(root);
    return () => clearInterval(timer);
  },
};
