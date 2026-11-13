import { el, bindActions, renderIcons } from '../../assets/js/components/ui.js';
import { weatherSvg } from './icons.js';
import { LOCATIONS, loadForecast, viewForecast, nowInVietnam, describeDate, fmt } from './logic.js';
import { LEVEL_INFO, NO_ALERTS_TEXT, SOURCES, loadAlertSources, buildAlerts, vnTime } from './alerts.js';

const icon = name => el('i', { 'data-lucide': name });
// Lucide icons used by the UI (listed on an "icon" line so scripts/build-icons.mjs bundles them).
export const UI_ICONS = ['thermometer', 'droplets', 'wind', 'umbrella', 'sunrise', 'sunset', 'arrow-up', 'arrow-down', 'sun', 'cloud-off', 'loader', 'map-pin', 'refresh-cw', 'chevron-down', 'triangle-alert', 'shield-check', 'external-link', 'info', 'siren', 'octagon-alert', 'clock'];
const wxIcon = (name, cls = '') => el('span', { class: `wx-ic ${cls}` }, weatherSvg(name));

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
/** Condition name in English with its Vietnamese name. */
const condName = c => [c.en, el('span', { class: 'wx-cond-vi' }, c.vi)];
const textLines = t => el('div', { class: 'wx-desc' }, el('p', {}, t.en), el('p', { class: 'wx-desc-vi', lang: 'vi' }, t.vi));

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
  return el('section', { class: `wx-current tone-${cur.cond.tone}${cur.isDay ? '' : ' is-night'}`, 'aria-label': 'Current weather' },
    el('div', { class: 'wx-current-main' },
      wxIcon(cur.cond.icon, 'wx-ic-xl'),
      el('div', {},
        el('div', { class: 'wx-temp-xl' }, fmt(cur.temp), el('span', {}, '°C')),
        el('div', { class: 'wx-cond' }, condName(cur.cond)),
        el('div', { class: 'wx-asof' }, cur.time ? `Observed ${cur.time.slice(11, 16)}` : `As of ${nowIso.slice(11, 16)}`))),
    el('div', { class: 'wx-current-side' },
      textLines(cur.text),
      el('div', { class: 'wx-stats' },
        stat('Feels like', deg(cur.feels), '', 'thermometer'), stat('Humidity', pct(cur.humidity), '', 'droplets'),
        stat('Wind', windText(cur), '', 'wind'), stat('Rain chance', pct(cur.pop), cur.pop == null ? '' : 'this hour', 'umbrella'),
        stat('Rain expected', today ? mm(today.precip) : '–', today ? 'today, total' : '', 'droplets')),
      chips));
}

function hourlySection(hours) {
  const strip = el('div', { class: 'wx-hours', role: 'list', tabindex: '0', 'aria-label': 'Hourly forecast, scrolls sideways' });
  const detail = el('div', { class: 'wx-detail', role: 'status', 'aria-live': 'polite' });
  const cards = hours.map(h => {
    const b = el('button', { class: `wx-hour tone-${h.cond.tone}${h.isCurrent ? ' is-now' : ''}`, type: 'button', role: 'listitem',
      'aria-label': `${h.hour}:00, ${h.cond.en}, ${fmt(h.temp)} degrees, rain chance ${pct(h.pop)}` },
      el('span', { class: 'wx-hour-t' }, h.isCurrent ? 'Now' : `${h.hour}:00`),
      wxIcon(h.cond.icon), el('span', { class: 'wx-hour-temp' }, deg(h.temp)),
      el('span', { class: 'wx-hour-pop' }, icon('droplets'), pct(h.pop)));
    b.addEventListener('click', () => select(h, b));
    return b;
  });
  function select(h, btn) {
    cards.forEach(c => c.classList.toggle('is-sel', c === btn));
    detail.replaceChildren(
      el('div', { class: 'wx-detail-h' }, wxIcon(h.cond.icon), el('strong', {}, `${h.hour}:00`), el('span', {}, condName(h.cond)), h.isCurrent ? el('span', { class: 'badge' }, 'Now') : null),
      textLines(h.text),
      el('div', { class: 'wx-stats' },
        stat('Temperature', deg(h.temp)), stat('Feels like', deg(h.feels)), stat('Rain chance', pct(h.pop)),
        stat('Rain expected', mm(h.precip)), stat('Wind', windText(h)), stat('Humidity', pct(h.humidity)),
        stat('Cloud cover', pct(h.cloud)), stat('UV index', h.uv == null ? '–' : fmt(h.uv, 1), uvLevel(h.uv))));
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
      textLines(d.text),
      el('div', { class: 'wx-stats' },
        stat('Rain expected', mm(d.precip)), stat('Feels like (max)', deg(d.feelsMax)), stat('Cloud cover', pct(d.cloud)), stat('Max wind', d.windMax == null ? '–' : `${fmt(d.windMax)} km/h`),
        stat('UV index', d.uv == null ? '–' : fmt(d.uv, 1), uvLevel(d.uv)),
        stat('Sunrise', d.sunrise || '–'), stat('Sunset', d.sunset || '–')));
    const head = el('button', { class: 'wx-day-row', type: 'button', 'aria-expanded': String(i === 0) },
      el('span', { class: 'wx-day-name' }, el('strong', {}, d.isToday ? 'Today' : d.weekday), el('span', { class: 'hint' }, d.label)),
      el('span', { class: 'wx-day-cond' }, wxIcon(d.cond.icon), el('span', { class: 'wx-day-cond-t' }, el('span', {}, d.cond.en), el('span', { class: 'wx-cond-vi' }, d.cond.vi))),
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

// ---------- alerts ----------
const LEVEL_ICON = { info: 'info', advisory: 'triangle-alert', watch: 'octagon-alert', warning: 'siren' };
const levelPill = level => el('span', { class: `wx-pill lvl-${level}` }, icon(LEVEL_ICON[level]), LEVEL_INFO[level].label, el('span', { class: 'wx-pill-vi' }, LEVEL_INFO[level].vi));
const link = s => el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.name, icon('external-link'));
const checkedText = ms => (ms ? vnTime(ms) : 'not available');

function alertGroup(g, locName, isOpen, onToggle, onPick) {
  const d = el('details', { class: `wx-alert lvl-${g.level}`, open: isOpen || null });
  d.addEventListener('toggle', () => onToggle(g.key, d.open));
  const forecast = g.kind === 'forecast';
  const rows = g.items.map(a => el('li', { class: 'wx-alert-row' },
    el('div', { class: 'wx-alert-loc' }, el('button', { class: 'wx-linkbtn', type: 'button', 'data-pick': a.locId, 'aria-label': `Show ${locName(a.locId)}` }, icon('map-pin'), locName(a.locId)), levelPill(a.level)),
    el('div', { class: 'wx-alert-when' }, icon('clock'), a.whenText),
    el('div', { class: 'wx-alert-sev' }, a.severity)));
  d.append(
    el('summary', {},
      el('span', { class: 'wx-alert-sum' },
        el('span', { class: 'wx-alert-line' }, levelPill(g.level), el('strong', { class: 'wx-alert-type' }, g.type), el('span', { class: 'wx-cond-vi' }, g.typeVi),
          el('span', { class: `wx-kind ${g.kind}`, title: forecast ? 'Estimated from weather models; not an official warning.' : 'Reported by the source agency.' }, forecast ? 'Forecast risk (model)' : 'Reported event')),
        el('span', { class: 'wx-alert-aff' }, 'Affects: ', g.items.map(a => el('span', { class: 'wx-chip' }, locName(a.locId))))),
      el('span', { class: 'wx-chev', 'aria-hidden': 'true' }, icon('chevron-down'))),
    el('div', { class: 'wx-alert-body' },
      el('ul', { class: 'wx-alert-rows' }, rows),
      el('p', {}, g.description),
      el('p', { class: 'hint' }, forecast ? 'This is a risk estimated from forecast models, not a confirmed event or an official warning. Confirm with the Vietnamese authorities below before acting on it.'
        : 'This event was reported by the source listed below.'),
      el('h4', {}, 'Recommended precautions'), el('ul', { class: 'wx-tips' }, g.precautions.map(t => el('li', {}, t))),
      el('div', { class: 'wx-alert-src' }, el('strong', {}, 'Source: '), g.sources.map(link)),
      el('div', { class: 'hint' }, `Last verified ${checkedText(g.checkedMs)}${g.updatedMs && !forecast ? ` · source updated ${checkedText(g.updatedMs)}` : ''}`)));
  d.addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) { e.preventDefault(); onPick(b.dataset.pick); } });
  return d;
}

function alertsSection(av, { locName, isOpen, onToggle, onPick }) {
  if (av.loading) return el('section', { class: 'wx-alerts', 'aria-busy': 'true', 'aria-label': 'Severe weather and disaster alerts' },
    el('div', { class: 'wx-alerts-head lvl-none' }, el('span', { class: 'spinner' }), el('div', {}, el('strong', {}, 'Checking for severe weather and natural disaster alerts…'))));
  const n = av.count;
  const head = n
    ? el('div', { class: `wx-alerts-head lvl-${av.top}` }, icon(LEVEL_ICON[av.top]), el('div', {},
      el('strong', {}, `${n} ${n === 1 ? 'alert' : 'alerts'} for the next 7 days · highest level: ${LEVEL_INFO[av.top].label} (${LEVEL_INFO[av.top].vi})`), el('div', { class: 'wx-alerts-sub' }, LEVEL_INFO[av.top].hint)))
    : av.complete
      ? el('div', { class: 'wx-alerts-head lvl-clear' }, icon('shield-check'), el('div', {}, el('strong', {}, NO_ALERTS_TEXT),
        el('div', { class: 'wx-alerts-sub' }, 'Checked: weather-model forecast for all locations, GDACS cyclone and flood reports, USGS earthquake reports.')))
      : el('div', { class: 'wx-alerts-head lvl-unknown' }, icon('info'), el('div', {}, el('strong', {}, 'Alert information is incomplete, so we cannot confirm there is no risk.'),
        el('div', { class: 'wx-alerts-sub' }, 'No alerts were found in the data that is available.')));
  const kids = [head];
  if (n) kids.push(el('div', { class: 'wx-alert-list' }, av.groups.map(g => alertGroup(g, locName, isOpen(g), onToggle, onPick))));
  if (av.unavailable.length) kids.push(el('div', { class: 'wx-alerts-unavail', role: 'status' }, icon('info'), el('div', {},
    el('strong', {}, 'Unavailable right now: '), av.unavailable.join('; '), '. ', 'Missing data is not the same as no risk.')));
  kids.push(el('div', { class: 'wx-alerts-foot hint' }, 'Always confirm with the official Vietnamese sources: ', link(SOURCES.nchmf), ' · ', link(SOURCES.vndma), ' · ', link(SOURCES.igp),
    '. Earthquakes cannot be forecast, so only events reported in the last 7 days are listed.'));
  return el('section', { class: 'wx-alerts', 'aria-label': 'Severe weather and natural disaster alerts' }, kids);
}

// ---------- tool ----------
export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const alertsEl = $('wx-alerts'), tabsEl = $('wx-tabs'), viewEl = $('wx-view'), updatedEl = $('wx-updated'), clockEl = $('wx-clock');
    const savedId = ctx.storage.get('location', null);
    let selected = LOCATIONS.some(l => l.id === savedId) ? savedId : LOCATIONS[0].id;
    /** id -> { status: 'loading'|'ok'|'error', data, fetchedAt, error, refreshing } */
    const state = new Map(LOCATIONS.map(l => [l.id, { status: 'loading' }]));
    let renderedHour = '';
    /** Alert sources (null until the first load finishes), the evaluated alerts, and which alert cards the user opened or closed. */
    let sources = null, alertsView = buildAlerts(LOCATIONS, {}, null);
    const alertOpen = new Map();
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
    async function loadAlerts(force) {
      try { sources = await loadAlertSources(LOCATIONS, { storage: ctx.storage, signal: ctx.signal, force }); } catch { if (ctx.signal.aborted) return; }
      renderAll();
    }
    // Independent promises: one failing location never blocks the others.
    const loadAll = force => Promise.all([...LOCATIONS.map(l => load(l, force)), loadAlerts(force)]);

    // ----- render -----
    function renderTabs() {
      tabsEl.replaceChildren(...LOCATIONS.map(l => {
        const s = state.get(l.id), on = l.id === selected;
        return el('button', { class: `wx-tab${on ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on), tabindex: on ? '0' : '-1', 'data-loc': l.id },
          el('span', { class: 'wx-tab-ic' }, s.data ? wxIcon(s.data.current.cond.icon) : icon(s.status === 'error' ? 'cloud-off' : 'loader')),
          el('span', { class: 'wx-tab-text' },
            el('span', { class: 'wx-tab-name' }, l.short), el('span', { class: 'wx-tab-area' }, l.area),
            el('span', { class: 'wx-tab-now' }, s.data ? s.data.current.cond.en : s.status === 'error' ? 'Unavailable' : 'Loading…')),
          s.data ? el('span', { class: 'wx-tab-temp' }, `${fmt(s.data.current.temp)}°`) : null,
          alertsView.byLocation[l.id] ? el('span', { class: `wx-tab-alert lvl-${alertsView.byLocation[l.id]}`, title: `${LEVEL_INFO[alertsView.byLocation[l.id]].label} alert`, role: 'img',
            'aria-label': `${LEVEL_INFO[alertsView.byLocation[l.id]].label} alert for ${l.short}` }, icon('triangle-alert')) : null);
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

    function renderAlerts() {
      alertsView = buildAlerts(LOCATIONS, Object.fromEntries(state), sources);
      alertsEl.replaceChildren(alertsSection(alertsView, {
        locName: id => LOCATIONS.find(l => l.id === id)?.short || id,
        isOpen: g => alertOpen.get(g.key) ?? (g.level === 'watch' || g.level === 'warning'),
        onToggle: (key, open) => alertOpen.set(key, open),
        onPick: id => { selectLocation(id); viewEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
      }));
      renderIcons(alertsEl);
    }

    function renderAll() {
      renderAlerts(); renderTabs(); renderView();
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
      if (renderedHour && iso.slice(0, 13) !== renderedHour && state.get(selected).status === 'ok') { renderAlerts(); renderView(); }
    };
    tick();
    const timer = setInterval(tick, 20000);

    renderAll();
    loadAll(false);
    return () => clearInterval(timer);
  },
};
