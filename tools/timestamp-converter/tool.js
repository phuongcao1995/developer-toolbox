import { copyText, showMessage, bindActions, el, renderIcons } from '../../assets/js/components/ui.js';
import { unixToDate, UNIT_NAMES, fieldsToUnix, parseIso, describeInstant, listTimeZones, browserTimeZone,
  zonedParts, tzOffsetMs, formatOffset } from './logic.js';

const FIELD_KEYS = ['year', 'month', 'day', 'hour', 'minute', 'second', 'ms'];

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    let live = true;
    let unixRows = [];

    // ---------- time zone select ----------
    const tzSel = $('ts-tz');
    const zones = listTimeZones();
    tzSel.append(...zones.map(z => el('option', { value: z }, z)));
    const savedTz = ctx.storage.get('tz', null);
    tzSel.value = zones.includes(savedTz) ? savedTz : browserTimeZone();
    const selectedTz = () => tzSel.value;
    const interpTz = () => { const m = $('ts-interp').value; return m === 'utc' ? 'UTC' : m === 'zone' ? selectedTz() : browserTimeZone(); };
    const tzHint = () => { $('ts-tz-hint').textContent = `${selectedTz()} is currently ${formatOffset(tzOffsetMs(Date.now(), selectedTz()))}. Your browser zone: ${browserTimeZone()}.`; };

    // ---------- helpers ----------
    /** Render [label, value] rows with a copy button each. */
    function renderRows(tbody, rows) {
      tbody.replaceChildren(...rows.map(([label, value]) => el('tr', {},
        el('td', {}, label), el('td', { class: 'ts-val' }, value),
        el('td', { class: 'ts-act' }, el('button', { class: 'btn btn-sm btn-ghost', 'aria-label': `Copy ${label}`, title: 'Copy',
          html: '<i data-lucide="copy"></i>', onclick: () => copyText(String(value), `Copied ${label}`) })))));
      renderIcons(tbody);
    }

    // ---------- live clock ----------
    const tick = () => {
      const n = Date.now();
      $('ts-now-s').textContent = Math.floor(n / 1000);
      $('ts-now-ms').textContent = n;
      $('ts-now-iso').textContent = new Date(n).toISOString();
    };
    tick();
    const timer = setInterval(() => { if (live) tick(); }, 1000);

    // ---------- Unix -> date ----------
    function convertUnix() {
      const msg = $('ts-unix-msg'), badge = $('ts-unit-badge'), out = $('ts-unix-out');
      showMessage(msg, null); badge.hidden = true; out.replaceChildren(); unixRows = [];
      const text = $('ts-unix').value;
      if (!text.trim()) return;
      try {
        const r = unixToDate(text, $('ts-unit').value);
        badge.hidden = false; badge.textContent = `${$('ts-unit').value === 'auto' ? 'Detected' : 'Using'}: ${UNIT_NAMES[r.unit]}`;
        unixRows = [['Seconds', String(Math.floor(r.ms / 1000))], ['Milliseconds', String(r.ms)], ...describeInstant(r.ms, selectedTz())];
        renderRows(out, unixRows);
      } catch (e) { showMessage(msg, 'error', e.message); }
    }

    // ---------- Date -> Unix ----------
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fieldInputs = Object.fromEntries(FIELD_KEYS.map(k => [k, $('ts-f-' + k)]));
    const setFields = p => FIELD_KEYS.forEach(k => { fieldInputs[k].value = p[k] ?? 0; });
    const syncDtlFromFields = () => {
      const f = readFields(false);
      $('ts-dtl').value = f && f.year >= 1 && f.year <= 9999 && f.month >= 1 && f.month <= 12 && f.day >= 1 && f.day <= 31
        ? `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}` : '';
    };
    /** Read the field inputs. Returns null if year/month/day are all blank (nothing entered yet). */
    function readFields() {
      const vals = {}; let any = false;
      for (const k of FIELD_KEYS) {
        const raw = fieldInputs[k].value.trim();
        if (raw !== '') any = true;
        vals[k] = raw === '' ? (k === 'month' || k === 'day' ? NaN : k === 'year' ? NaN : 0) : Number(raw);
      }
      return any ? vals : null;
    }
    function convertDate() {
      const msg = $('ts-date-msg'), out = $('ts-date-out');
      showMessage(msg, null); out.replaceChildren();
      const f = readFields();
      if (!f) return;
      try {
        for (const k of ['year', 'month', 'day']) if (Number.isNaN(f[k])) throw new Error(`Enter a ${k}.`);
        const r = fieldsToUnix(f, interpTz());
        renderRows(out, [['Seconds', String(r.seconds)], ['Milliseconds', String(r.ms)], ['ISO 8601 (UTC)', new Date(r.ms).toISOString()],
          ['Zone used', interpTz()]]);
        if (r.status !== 'ok') showMessage(msg, 'warn', r.note);
      } catch (e) { showMessage(msg, 'error', e.message); }
    }
    const fillNow = () => { setFields({ ...zonedParts(Date.now(), interpTz()), ms: new Date().getMilliseconds() }); syncDtlFromFields(); convertDate(); };

    $('ts-dtl').addEventListener('input', () => {
      const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec($('ts-dtl').value);
      if (m) { setFields({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] || 0), ms: 0 }); }
      else FIELD_KEYS.forEach(k => { fieldInputs[k].value = ''; });
      convertDate();
    });
    FIELD_KEYS.forEach(k => fieldInputs[k].addEventListener('input', () => { syncDtlFromFields(); convertDate(); }));

    // ---------- ISO ----------
    function convertIso() {
      const msg = $('ts-iso-msg'), out = $('ts-iso-out');
      showMessage(msg, null); out.replaceChildren();
      const t = $('ts-iso').value;
      if (!t.trim()) return;
      try {
        const r = parseIso(t, interpTz());
        renderRows(out, [['Seconds', String(r.seconds)], ['Milliseconds', String(r.ms)], ...describeInstant(r.ms, selectedTz())]);
        if (r.status && r.status !== 'ok') showMessage(msg, 'warn', r.note);
        else if (!r.offsetGiven && !r.dateOnly) showMessage(msg, 'info', `No offset given; interpreted in ${interpTz()}.`);
      } catch (e) { showMessage(msg, 'error', e.message); }
    }

    const refreshAll = () => { tzHint(); convertUnix(); convertDate(); convertIso(); };
    tzSel.addEventListener('change', () => { ctx.storage.set('tz', selectedTz()); refreshAll(); });
    $('ts-interp').addEventListener('change', () => { convertDate(); convertIso(); });
    $('ts-unix').addEventListener('input', convertUnix);
    $('ts-unit').addEventListener('change', convertUnix);
    $('ts-iso').addEventListener('input', convertIso);

    bindActions(root, {
      'toggle-live': (e, b) => {
        live = !live; if (live) tick();
        b.querySelector('span').textContent = live ? 'Pause' : 'Resume';
        b.querySelector('i,svg')?.replaceWith(el('i', { 'data-lucide': live ? 'pause' : 'play' })); renderIcons(b);
      },
      'copy-now-s': () => copyText($('ts-now-s').textContent),
      'copy-now-ms': () => copyText($('ts-now-ms').textContent),
      'copy-now-iso': () => copyText($('ts-now-iso').textContent),
      'unix-now': () => { $('ts-unit').value = 's'; $('ts-unix').value = Math.floor(Date.now() / 1000); convertUnix(); },
      'unix-clear': () => { $('ts-unix').value = ''; convertUnix(); },
      'unix-copy-all': () => copyText(unixRows.map(([k, v]) => `${k}: ${v}`).join('\n')),
      'date-now': fillNow,
      'date-clear': () => { FIELD_KEYS.forEach(k => { fieldInputs[k].value = ''; }); $('ts-dtl').value = ''; convertDate(); },
      'iso-clear': () => { $('ts-iso').value = ''; convertIso(); },
    });

    // initial state
    $('ts-unix').value = String(Math.floor(Date.now() / 1000));
    fillNow();
    refreshAll();
    renderIcons(root);
    return () => clearInterval(timer);
  },
};
