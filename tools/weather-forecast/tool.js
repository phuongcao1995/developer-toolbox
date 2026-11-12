import { el, bindActions, renderIcons } from '../../assets/js/components/ui.js';
import { weatherSvg } from './icons.js';
import { LOCATIONS, loadForecast, viewForecast, nowInVietnam, describeDate, fmt } from './logic.js';

const icon = name => el('i', { 'data-lucide': name });
// Lucide icons used by the UI (listed on an "icon" line so scripts/build-icons.mjs bundles them).
export const UI_ICONS = ['thermometer', 'droplets', 'wind', 'umbrella', 'sunrise', 'sunset', 'arrow-up', 'arrow-down', 'sun', 'cloud-off', 'loader', 'map-pin', 'refresh-cw', 'chevron-down'];
const wxIcon =(name, cls = '') => el('span', { class: `wx-ic ${cls}` }, weatherSvg(name));

/** 'YYYY-MM-DDTHH:mm' (Vietnam) -> 'Tue, 10 Nov 2026 · 09:45'. */
function clockText(iso) {
  const d = describeDate(iso);
  return `${d.weekday}, ${d.label} ${iso.slice(0, 4)} · ${iso.slice(11, 16)}`;
}

/** Small label/value cell. */
const stat = (label, value, sub, ic) => el('div', { class: 'wx-stat' },
  el('span', { class: 'wx-stat-l' }, ic ? icon(ic) : null, label), el('span', { class: 'wx-stat-v' }, value), sub ? el('span', { class: 'wx-stat-s' }, sub) : null);

const windText = h => h.wind == null ? '–' : `${fmt(h.wind)} km/h${h.compass ? ' ' + h.compass : ''}`;
const mm = v => v == null ? '–' : `${fmt(v, 1)} mm`;
const pct = v => v == null ? '–' : `${fmt(v)}%`;
const deg = v => v == null ? '–' : `${fmt(v)}°`;

function uvLevel(uv) {
  if (uv == null) return '';
  return uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme';
}

// ---------- sections ----------
function currentCard(cur, nowIso, today) {
  const chip = (ic, text) => el('span', { class: 'wx-chip' }, icon(ic), text);
  const chips = today ? el('div', { class: 'wx-chips' },
    today.max != null ? chip('arrow-up', `High ${deg(today.max)}`) : null, today.min != null ? chip('arrow-down', `Low ${deg(today.min)}`) : null,
    today.sunrise ? chip('sunrise', today.sunrise) : null, today.sunset ? chip('sunset', today.sunset) : null,
    today.uv != null ? chip('sun', `UV ${fmt(today.uv, 1)} · ${uvLevel(today.uv)}`) : null) : null;
  return el('section', { class: `wx-current tone-${cur.info.tone}${cur.isDay ? '' : ' is-night'}`, 'aria-label': 'Current weather' },
    el('div', { class: 'wx-current-main' },
      wxIcon(cur.info.icon, 'wx-ic-xl'),
      el('div', {},
        el('div', { class: 'wx-temp-xl' }, fmt(cur.temp), el('span', {}, '°C')),
        el('div', { class: 'wx-cond' }, cur.info.label),
        el('div', { class: 'wx-asof' }, cur.time ? `Observed ${cur.time.slice(11, 16)}` : `As of ${nowIso.slice(11, 16)}`))),
    el('div', { class: 'wx-current-side' },
      el('div', { class: 'wx-stats' },
        stat('Feels like', deg(cur.feels), '', 'thermometer'), stat('Humidity', pct(cur.humidity), '', 'droplets'),
        stat('Wind', windText(cur), '', 'wind'), stat('Rain chance', pct(cur.pop), cur.pop == null ? '' : 'this hour', 'umbrella')),
      chips));
}

function hourlySection(hours) {
  const strip = el('div', { class: 'wx-hours', role: 'list', tabindex: '0', 'aria-label': 'Hourly forecast, scrolls sideways' });
  const detail = el('div', { class: 'wx-detail', role: 'status', 'aria-live': 'polite' });
  const cards = hours.map(h => {
    const b = el('button', { class: `wx-hour tone-${h.info.tone}${h.isCurrent ? ' is-now' : ''}`, type: 'button', role: 'listitem',
      'aria-label': `${h.hour}:00, ${h.info.label}, ${fmt(h.temp)} degrees` },
      el('span', { class: 'wx-hour-t' }, h.isCurrent ? 'Now' : `${h.hour}:00`),
      wxIcon(h.info.icon), el('span', { class: 'wx-hour-temp' }, deg(h.temp)),
      el('span', { class: 'wx-hour-pop' }, icon('droplets'), pct(h.pop)));
    b.addEventListener('click', () => select(h, b));
    return b;
  });
  function select(h, btn) {
    cards.forEach(c => c.classList.toggle('is-sel', c === btn));
    detail.replaceChildren(
      el('div', { class: 'wx-detail-h' }, wxIcon(h.info.icon), el('strong', {}, `${h.hour}:00`), el('span', {}, h.info.label), h.isCurrent ? el('span', { class: 'badge' }, 'Now') : null),
      el('div', { class: 'wx-stats' },
        stat('Temperature', deg(h.temp)), stat('Feels like', deg(h.feels)), stat('Rain chance', pct(h.pop)),
        stat('Precipitation', mm(h.precip)), stat('Wind', windText(h)), stat('Humidity', pct(h.humidity))));
    renderIcons(detail);
  }
  strip.append(...cards);
  const idx = Math.max(0, hours.findIndex(h => h.isCurrent));
  // Called after insertion: select the current hour and centre it without scrolling the page.
  const init = () => {
    if (!cards.length) return;
    select(hours[idx], cards[idx]);
    strip.scrollLeft = Math.max(0, cards[idx].offsetLeft - (strip.clientWidth - cards[idx].offsetWidth) / 2);
  };
  return { node: el('section', { class: 'wx-section' }, el('h2', {}, 'Today, hour by hour'), strip, detail), init };
}

function dailySection(days) {
  const lo = Math.min(...days.map(d => d.min ?? Infinity)), hi = Math.max(...days.map(d => d.max ?? -Infinity));
  const range = hi > lo ? hi - lo : 1;
  const rows = days.map((d, i) => {
    const left = d.min == null ? 0 : ((d.min - lo) / range) * 100;
    const width = d.min == null || d.max == null ? 0 : Math.max(4, ((d.max - d.min) / range) * 100);
    const more = el('div', { class: 'wx-day-more', hidden: i !== 0 },
      el('div', { class: 'wx-stats' },
        stat('Precipitation', mm(d.precip)), stat('Max wind', d.windMax == null ? '–' : `${fmt(d.windMax)} km/h`),
        stat('UV index', d.uv == null ? '–' : fmt(d.uv, 1), uvLevel(d.uv)),
        stat('Sunrise', d.sunrise || '–'), stat('Sunset', d.sunset || '–')));
    const head = el('button', { class: 'wx-day-row', type: 'button', 'aria-expanded': String(i === 0) },
      el('span', { class: 'wx-day-name' }, el('strong', {}, d.isToday ? 'Today' : d.weekday), el('span', { class: 'hint' }, d.label)),
      el('span', { class: 'wx-day-cond' }, wxIcon(d.info.icon), el('span', {}, d.info.label)),
      el('span', { class: 'wx-day-rain' }, icon('droplets'), el('span', {}, `${pct(d.pop)} · ${mm(d.precip)}`)),
      el('span', { class: 'wx-day-temps', 'aria-label': `Low ${fmt(d.min)}, high ${fmt(d.max)} degrees` },
        el('span', { class: 'wx-lo' }, deg(d.min)),
        el('span', { class: 'wx-bar-track', 'aria-hidden': 'true' }, el('span', { class: 'wx-bar-fill', style: `left:${left}%;width:${width}%` })),
        el('span', { class: 'wx-hi' }, deg(d.max))),
      el('span', { class: 'wx-chev', 'aria-hidden': 'true' }, icon('chevron-down')));
    head.addEventListener('click', () => {
      const open = more.hidden; more.hidden = !open; head.setAttribute('aria-expanded', String(open));
    });
    return el('div', { class: `wx-day${d.isToday ? ' is-today' : ''}` }, head, more);
  });
  return el('section', { class: 'wx-section' }, el('h2', {}, `Next ${days.length} days`), el('div', { class: 'wx-days' }, rows));
}

// ---------- tool ----------
export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const tabsEl = $('wx-tabs'), viewEl = $('wx-view'), updatedEl = $('wx-updated'), clockEl = $('wx-clock');
    const savedId = ctx.storage.get('location', null);
    let selected = LOCATIONS.some(l => l.id === savedId) ? savedId : LOCATIONS[0].id;
    /** id -> { status: 'loading'|'ok'|'error', data, fetchedAt, error, refreshing } */
    const state = new Map(LOCATIONS.map(l => [l.id, { status: 'loading' }]));
    let renderedHour = '';
    const dayRefreshed = new Set();

    // ----- load -----
    async function load(loc, force) {
      const s = state.get(loc.id);
      if (s.refreshing) return;
      if (s.status === 'ok') s.refreshing = true; else s.status = 'loading';
      renderAll();
      try {
        const r = await loadForecast(loc, { storage: ctx.storage, signal: ctx.signal, force });
        Object.assign(s, { status: 'ok', data: r.data, fetchedAt: r.fetchedAt, error: r.error || null, refreshing: false });
      } catch (e) {
        if (ctx.signal.aborted) return;
        Object.assign(s, s.data ? { error: e.message, refreshing: false } : { status: 'error', error: e.message, refreshing: false });
      }
      renderAll();
    }
    // Independent promises: one failing location never blocks the others.
    const loadAll = force => Promise.all(LOCATIONS.map(l => load(l, force)));

    // ----- render -----
    function renderTabs() {
      tabsEl.replaceChildren(...LOCATIONS.map(l => {
        const s = state.get(l.id), on = l.id === selected;
        return el('button', { class: `wx-tab${on ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on), tabindex: on ? '0' : '-1', 'data-loc': l.id },
          el('span', { class: 'wx-tab-ic' }, s.data ? wxIcon(s.data.current.info.icon) : icon(s.status === 'error' ? 'cloud-off' : 'loader')),
          el('span', { class: 'wx-tab-text' },
            el('span', { class: 'wx-tab-name' }, l.short), el('span', { class: 'wx-tab-area' }, l.area),
            el('span', { class: 'wx-tab-now' }, s.data ? s.data.current.info.label : s.status === 'error' ? 'Unavailable' : 'Loading…')),
          s.data ? el('span', { class: 'wx-tab-temp' }, `${fmt(s.data.current.temp)}°`) : null);
      }));
      renderIcons(tabsEl);
    }

    function renderView() {
      const loc = LOCATIONS.find(l => l.id === selected), s = state.get(loc.id);
      const head = el('div', { class: 'wx-loc' },
        el('div', {}, el('h2', { class: 'wx-loc-name' }, icon('map-pin'), loc.name), el('div', { class: 'hint' }, `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`)),
        el('button', { class: 'btn btn-sm', type: 'button', 'data-action': 'refresh-one', disabled: s.status === 'loading' || s.refreshing || null,
          'aria-label': `Refresh ${loc.short}` }, icon('refresh-cw'), el('span', {}, s.refreshing ? 'Refreshing…' : 'Refresh')));
      const nodes = [head];
      let hourly = null;
      updatedEl.textContent = '';
      if (s.status === 'loading') {
        nodes.push(el('div', { class: 'wx-loading', role: 'status' }, el('span', { class: 'spinner' }), 'Loading forecast…'));
      } else if (s.status === 'error') {
        nodes.push(el('div', { class: 'alert alert-error', role: 'alert' }, el('strong', {}, 'Could not load the forecast. '), s.error,
          el('div', { class: 'row wx-retry' }, el('button', { class: 'btn', type: 'button', 'data-action': 'refresh-one' }, icon('refresh-cw'), 'Try again'))));
      } else {
        const nowIso = nowInVietnam(), v = viewForecast(s.data, nowIso);
        if (s.error) nodes.push(el('div', { class: 'alert alert-warn', role: 'status' }, `Showing saved data. Could not refresh: ${s.error}`));
        if (v.outdated) nodes.push(el('div', { class: 'alert alert-info', role: 'status' }, 'This data is from an earlier day. Refreshing…'));
        nodes.push(currentCard(s.data.current, nowIso, v.days.find(d => d.isToday)));
        if (v.hours.length) { hourly = hourlySection(v.hours); nodes.push(hourly.node); }
        else nodes.push(el('div', { class: 'alert alert-info' }, 'No hourly data is available for today.'));
        nodes.push(v.days.length ? dailySection(v.days) : el('div', { class: 'alert alert-info' }, 'No daily forecast is available.'));
        const t = nowInVietnam(s.fetchedAt);
        updatedEl.textContent = `Updated ${t.slice(0, 10) === nowIso.slice(0, 10) ? '' : describeDate(t).label + ' '}${t.slice(11, 16)}`;
        renderedHour = nowIso.slice(0, 13);
        if (v.outdated && !dayRefreshed.has(loc.id)) { dayRefreshed.add(loc.id); queueMicrotask(() => load(loc, true)); }
      }
      viewEl.replaceChildren(...nodes);
      renderIcons(viewEl);
      hourly?.init();
    }

    function renderAll() {
      renderTabs(); renderView();
      const busy = [...state.values()].some(s => s.status === 'loading' || s.refreshing);
      const btn = $('wx-refresh-all'); btn.disabled = busy; btn.querySelector('span').textContent = busy ? 'Refreshing…' : 'Refresh all';
    }

    function selectLocation(id, focus) {
      selected = id; ctx.storage.set('location', id); renderAll();
      if (focus) tabsEl.querySelector(`[data-loc="${id}"]`)?.focus();
    }
    tabsEl.addEventListener('click', e => { const b = e.target.closest('[data-loc]'); if (b) selectLocation(b.dataset.loc); });
    tabsEl.addEventListener('keydown', e => {
      const i = LOCATIONS.findIndex(l => l.id === selected), n = LOCATIONS.length;
      const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (to < 0) return;
      e.preventDefault(); selectLocation(LOCATIONS[to].id, true);
    });
    bindActions(root, {
      'refresh-all': () => { dayRefreshed.clear(); loadAll(true); },
      'refresh-one': () => load(LOCATIONS.find(l => l.id === selected), true),
    });

    // ----- clock: every 20 s; re-render when the Vietnam hour changes so "Now" follows the real time -----
    const tick = () => {
      const iso = nowInVietnam();
      clockEl.textContent = clockText(iso);
      if (renderedHour && iso.slice(0, 13) !== renderedHour && state.get(selected).status === 'ok') renderView();
    };
    tick();
    const timer = setInterval(tick, 20000);

    renderAll();
    loadAll(false);
    return () => clearInterval(timer);
  },
};
