// Weather Forecast: severe weather and natural disaster alerts (pure logic, no DOM). Free public sources, no API key, all CORS-enabled:
//   - GDACS (UN / European Commission)      tropical cyclones, floods, tsunamis, volcanoes: "reported" events with an alert colour
//   - USGS earthquake catalogue             earthquakes reported in the last 7 days near each location
//   - Open-Meteo forecast + flood models    rain, wind and heat thresholds, river-flow rise: "forecast risk" (never presented as confirmed)
// Vietnam's own agencies (NCHMF, VNDMA) publish no browser-readable API, so they are linked as the authority to confirm with.
import { viewForecast, nowInVietnam, describeDate, CACHE_TTL_MS, REQUEST_TIMEOUT_MS } from './logic.js';

export const LEVELS = ['info', 'advisory', 'watch', 'warning'];
export const LEVEL_INFO = {
  info: { label: 'Informational', vi: 'Thông tin', hint: 'General information.' },
  advisory: { label: 'Advisory', vi: 'Lưu ý', hint: 'Be aware and prepare.' },
  watch: { label: 'Watch', vi: 'Theo dõi', hint: 'Potential danger; monitor closely.' },
  warning: { label: 'Warning', vi: 'Cảnh báo', hint: 'Confirmed or imminent danger; take precautions immediately.' },
};
export const NO_ALERTS_TEXT = 'No severe weather or natural disaster alerts expected in the next 7 days.';

export const SOURCES = {
  nchmf: { name: 'National Center for Hydro-Meteorological Forecasting (NCHMF, Vietnam)', url: 'https://nchmf.gov.vn/' },
  vndma: { name: 'Vietnam Disaster Management Authority', url: 'https://vndms.dmc.gov.vn/' },
  igp: { name: 'Institute of Geophysics, VAST (Vietnam)', url: 'https://igp-vast.vn/' },
  gdacs: { name: 'GDACS, UN / European Commission', url: 'https://www.gdacs.org/' },
  usgs: { name: 'USGS Earthquake Hazards Program', url: 'https://earthquake.usgs.gov/earthquakes/map/' },
  openmeteo: { name: 'Open-Meteo forecast and flood models', url: 'https://open-meteo.com/' },
};

const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';
const USGS_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood';
const STALE_MAX_MS = 6 * 3600 * 1000; // a saved copy older than this is not shown as current when a refresh fails
const DAY_MS = 86400000;

const safeUrl = (u, fallback) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : fallback);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rank = level => LEVELS.indexOf(level);

/** Great-circle distance in km. */
export function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- fetching ----------
async function getJson(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) { if (signal.aborted) ctl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    let res;
    try { res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: 'application/json' } }); }
    catch (e) { if (signal?.aborted) throw e; throw new Error(ctl.signal.aborted ? 'The service took too long to respond.' : 'Could not reach the service.'); }
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`The service returned an error (HTTP ${res.status}).`);
    try { return await res.json(); } catch { throw new Error('The service returned an unreadable response.'); }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

const inflight = new Map();
/** Cached, de-duplicated load that never rejects (except on abort): { status:'ok', data, fetchedAt, error? } or { status:'error', error }. */
async function cachedFeed(key, produce, { storage, signal, force = false, now = Date.now() } = {}) {
  const c = storage && storage.get(`cache:${key}`, null);
  const saved = c && typeof c.fetchedAt === 'number' && c.data != null ? c : null;
  if (saved && !force && now >= saved.fetchedAt && now - saved.fetchedAt < CACHE_TTL_MS) return { status: 'ok', data: saved.data, fetchedAt: saved.fetchedAt, fromCache: true };
  let p = inflight.get(key);
  if (!p) {
    p = produce().then(data => { const fetchedAt = Date.now(); storage?.set(`cache:${key}`, { fetchedAt, data }); return { status: 'ok', data, fetchedAt }; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try { return await p; } catch (e) {
    if (signal?.aborted) throw e;
    if (saved && now - saved.fetchedAt < STALE_MAX_MS) return { status: 'ok', data: saved.data, fetchedAt: saved.fetchedAt, fromCache: true, error: e.message };
    return { status: 'error', error: e.message };
  }
}

const GDACS_TYPES = new Set(['TC', 'FL', 'TS', 'VO']);
/** GDACS GeoJSON -> compact list of current events (GDACS dates are UTC without a zone marker). */
export function parseGdacs(json) {
  if (!json || !Array.isArray(json.features)) return [];
  const out = [];
  for (const f of json.features) {
    const p = f && f.properties;
    if (!p || !GDACS_TYPES.has(p.eventtype) || String(p.iscurrent) === 'false') continue;
    const c = f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    const level = String(p.alertlevel || p.episodealertlevel || '').toLowerCase();
    out.push({
      type: p.eventtype, id: p.eventid, name: p.name || p.eventname || p.description || p.eventtype, level: ['green', 'orange', 'red'].includes(level) ? level : 'green',
      lat: c ? num(c[1]) : null, lon: c ? num(c[0]) : null, from: Date.parse(`${p.fromdate}Z`) || null, to: Date.parse(`${p.todate}Z`) || null,
      modified: Date.parse(`${p.datemodified}Z`) || null, report: safeUrl(p.url && p.url.report, SOURCES.gdacs.url),
      severity: p.severitydata && p.severitydata.severitytext ? String(p.severitydata.severitytext) : '',
      countries: Array.isArray(p.affectedcountries) ? p.affectedcountries.map(x => x.iso3).filter(Boolean) : [],
    });
  }
  return out;
}

/** USGS GeoJSON -> compact list of earthquakes. */
export function parseUsgs(json) {
  if (!json || !Array.isArray(json.features)) return [];
  return json.features.map(f => {
    const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
    return { id: f.id, mag: num(p.mag), place: String(p.place || 'Unknown location'), time: num(p.time), updated: num(p.updated), url: safeUrl(p.url, SOURCES.usgs.url),
      lat: c ? num(c[1]) : null, lon: c ? num(c[0]) : null, depth: c ? num(c[2]) : null, tsunami: p.tsunami === 1 };
  }).filter(e => e.mag != null && e.lat != null && e.lon != null && e.time != null);
}

/** Open-Meteo flood response -> { dates, flow } (m³/s, forecast river discharge near the point). */
export function parseFlood(json) {
  const d = json && json.daily;
  if (!d || !Array.isArray(d.time) || !Array.isArray(d.river_discharge)) throw new Error('The river-flow service returned an unexpected response.');
  return { dates: d.time, flow: d.river_discharge.map(num) };
}

/**
 * Load every alert source. Each entry resolves to { status:'ok'|'error', data, fetchedAt, error? }; one failing source never blocks the others.
 * Returns { gdacs, usgs, flood: { [locationId]: entry } }.
 */
export async function loadAlertSources(locations, opts = {}) {
  const { fetchImpl, signal } = opts, now = opts.now ?? Date.now();
  const lat = locations.reduce((s, l) => s + l.lat, 0) / locations.length, lon = locations.reduce((s, l) => s + l.lon, 0) / locations.length;
  const since = new Date(now - 7 * DAY_MS).toISOString().slice(0, 19);
  const usgsUrl = `${USGS_URL}?${new URLSearchParams({ format: 'geojson', latitude: lat.toFixed(3), longitude: lon.toFixed(3), maxradiuskm: '500', starttime: since, minmagnitude: '3', orderby: 'time', limit: '200' })}`;
  const [gdacs, usgs, ...floods] = await Promise.all([
    cachedFeed('gdacs', async () => parseGdacs(await getJson(GDACS_URL, { fetchImpl, signal })), opts),
    cachedFeed('usgs', async () => parseUsgs(await getJson(usgsUrl, { fetchImpl, signal })), opts),
    ...locations.map(l => cachedFeed(`flood:${l.id}`, async () => parseFlood(await getJson(
      `${FLOOD_URL}?${new URLSearchParams({ latitude: String(l.lat), longitude: String(l.lon), daily: 'river_discharge', forecast_days: '7', timezone: 'Asia/Ho_Chi_Minh' })}`, { fetchImpl, signal })), opts)),
  ]);
  return { gdacs, usgs, flood: Object.fromEntries(locations.map((l, i) => [l.id, floods[i]])) };
}

// ---------- evaluating ----------
const TYPES = {
  rain: { en: 'Heavy rain', vi: 'Mưa lớn', desc: 'Forecast rainfall at or above the heavy-rain thresholds used in Vietnam (50 mm in 24 h is heavy, 100 mm is very heavy). This is a model forecast, so timing and amounts can shift.',
    tips: ['Avoid low-lying roads and underpasses; never drive through flowing water.', 'Move vehicles and valuables off the ground floor or basement.', 'Clear drains near your home and keep a torch and phone power bank ready.', 'Follow NCHMF forecasts for updates.'] },
  flood: { en: 'Flood / flash flood risk', vi: 'Nguy cơ lũ lụt, lũ quét', desc: 'Heavy rain over several days and/or a strong rise in forecast river flow raises the risk of urban flooding, river flooding and flash floods in upstream areas.',
    tips: ['Check local flood and dike notices; be ready to move to higher ground.', 'Keep documents, medicine, water and food in a waterproof bag.', 'Switch off electricity at the mains if water enters the house.', 'Do not cross flooded roads, bridges or streams.'] },
  landslide: { en: 'Landslide risk', vi: 'Nguy cơ sạt lở đất', desc: 'Prolonged or intense rain saturates soil and can trigger landslides on slopes, hillside roads, riverbanks and coastal embankments. This is estimated from rainfall totals only, not from a ground survey.',
    tips: ['Stay away from steep slopes, cuttings, riverbanks and the foot of hills.', 'Watch for cracks in the ground, tilting trees or muddy water in streams; leave immediately if you see them.', 'Avoid mountain and hillside roads during and after heavy rain.', 'Follow instructions from local authorities.'] },
  wind: { en: 'Strong winds', vi: 'Gió mạnh', desc: 'Forecast wind gusts reach gale or storm force. This can come from a tropical depression or storm, a strong cold-air surge or a thunderstorm.',
    tips: ['Secure or bring in loose objects, signboards, roof sheets and pots.', 'Stay away from trees, scaffolding, power lines and the coast.', 'Avoid riding motorbikes, and avoid going to sea or the beach.', 'Check roof and window fastenings.'] },
  heat: { en: 'Extreme heat', vi: 'Nắng nóng gay gắt', desc: 'Very high temperatures and/or feels-like values combined with strong sunshine can cause heat exhaustion and heat stroke.',
    tips: ['Drink water regularly, even if you are not thirsty.', 'Avoid outdoor work and exercise between 10:00 and 16:00.', 'Wear light clothing, a hat and sunscreen; check on elders and children.', 'Never leave people or pets in parked vehicles.'] },
  thunder: { en: 'Severe thunderstorms', vi: 'Dông mạnh', desc: 'Thunderstorms are forecast, possibly with hail and sudden strong gusts. They develop quickly and are hard to time precisely.',
    tips: ['Stay indoors and away from windows during lightning; do not shelter under isolated trees.', 'Unplug sensitive electronics.', 'Postpone outdoor activities until 30 minutes after the last thunder.'] },
  cyclone: { en: 'Tropical storm / typhoon', vi: 'Bão, áp thấp nhiệt đới', desc: 'A tropical depression, storm or typhoon is being tracked by GDACS, which aggregates the official tropical cyclone agencies. Track, strength and landfall can change quickly.',
    tips: ['Follow NCHMF and local authority bulletins several times a day.', 'Stock water, food, medicine, torches and charged power banks for at least 3 days.', 'Reinforce the roof and windows; secure loose objects; move boats to shelter.', 'If evacuation is ordered, go early and take documents.'] },
  gflood: { en: 'Flooding (reported)', vi: 'Lũ lụt', desc: 'GDACS reports a flood event affecting this area.',
    tips: ['Check local flood notices and avoid flooded roads.', 'Be ready to move to higher ground.', 'Keep documents, medicine and water in a waterproof bag.'] },
  tsunami: { en: 'Tsunami', vi: 'Sóng thần', desc: 'GDACS reports a tsunami event in the region.',
    tips: ['Move away from the coast immediately if you feel a strong earthquake or are told to evacuate.', 'Follow official instructions only.'] },
  volcano: { en: 'Volcanic activity', vi: 'Núi lửa', desc: 'GDACS reports volcanic activity within range of this area.', tips: ['Follow local authority advice.'] },
  quake: { en: 'Earthquake', vi: 'Động đất', desc: 'Earthquakes cannot be predicted; this is an event reported by USGS in the last 7 days. Aftershocks are possible after a significant earthquake.',
    tips: ['If shaking occurs: drop, cover and hold on; stay away from windows and heavy furniture.', 'After a strong shock, check for gas leaks and damage and expect aftershocks.', 'Stay out of damaged buildings.', 'Follow Vietnam Institute of Geophysics and local authority notices.'] },
};
const VN_SOURCES = [SOURCES.nchmf, SOURCES.vndma];

/** Calendar words for a 'YYYY-MM-DD' relative to today. */
function dayWord(date, today) {
  const diff = Math.round((Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10))) / DAY_MS);
  const d = describeDate(date);
  return diff === 0 ? `Today, ${d.label}` : diff === 1 ? `Tomorrow, ${d.weekday} ${d.label}` : `${d.weekday} ${d.label}`;
}
/** Epoch ms -> 'Fri 13 Nov 2026, 14:00 (Vietnam time)'. */
export function vnTime(ms) {
  const iso = nowInVietnam(ms), d = describeDate(iso);
  return `${d.weekday} ${d.label} ${iso.slice(0, 4)}, ${iso.slice(11, 16)}`;
}

const maxBy = (arr, f) => arr.reduce((best, x) => (best == null || (f(x) ?? -Infinity) > (f(best) ?? -Infinity) ? x : best), null);
const mm1 = v => `${Number(v.toFixed(v >= 10 ? 0 : 1))} mm`;

/** Model-derived alerts for one location. Capped at "watch": a forecast is never a confirmed warning. */
function forecastAlerts(loc, data, flood, nowIso, checkedMs) {
  const v = viewForecast(data, nowIso), days = v.days.slice(0, 7);
  if (!days.length) return [];
  const out = [];
  const push = (type, r, date, hour, severity, extra = '') => out.push({
    key: `fx:${type}`, type: TYPES[type].en, typeVi: TYPES[type].vi, typeId: type, level: LEVELS[Math.min(2, r)], kind: 'forecast', locId: loc.id,
    whenText: dayWord(date, v.today) + (hour ? `, around ${hour}:00` : ''), whenSort: date + (hour || '00'), severity, extra,
    description: TYPES[type].desc, precautions: TYPES[type].tips, sources: [SOURCES.openmeteo, ...VN_SOURCES], updatedMs: checkedMs, checkedMs,
  });
  const hoursOf = date => data.hourly.filter(h => h.date === date);
  const peakHour = (date, f) => { const h = maxBy(hoursOf(date), f); return h && (f(h) ?? 0) > 0 ? h.hour : null; };
  const rain = days.map(d => d.precip ?? 0);
  const rain3 = rain.map((_, i) => rain.slice(i, i + 3).reduce((a, b) => a + b, 0));
  const dRain = maxBy(days, d => d.precip), r1 = dRain?.precip ?? 0, i3 = rain3.indexOf(Math.max(...rain3)), r3 = rain3[i3] ?? 0;

  // Heavy rain. A "Very heavy rain" condition (hourly or daily) always raises at least an Advisory, even when the 24 h total is below 50 mm.
  const vhHour = data.hourly.filter(h => h.date >= v.today && h.cond.key === 'rain-very-heavy'), vhDay = days.some(d => d.cond.key === 'rain-very-heavy');
  if (r1 >= 50 || vhHour.length || vhDay) {
    const hr = maxBy(vhHour, h => h.precip);
    const lvl = r1 >= 100 ? 2 : 1, date = r1 >= 50 || !hr ? dRain.date : hr.date;
    push('rain', lvl, date, r1 >= 50 || !hr ? peakHour(date, h => h.precip) : hr.hour,
      `${r1 >= 50 ? `Up to ${mm1(r1)} in 24 h (${r1 >= 100 ? 'very heavy, mưa rất to' : 'heavy, mưa to'}).` : ''}${hr ? ` Very heavy rain (mưa rất to) up to ${mm1(hr.precip)} per hour.` : ''} Rain chance up to ${dRain?.pop == null ? 'n/a' : dRain.pop + '%'}.`.trim());
  }
  // Flood risk: rain totals, supported by the river-flow model when it is available.
  let fl = r1 >= 100 || r3 >= 150 ? 2 : r1 >= 70 || r3 >= 100 ? 1 : -1, flowNote = '';
  const flow = flood && flood.status === 'ok' ? flood.data : null;
  if (flow) {
    const f = flow.flow, base = f.find(x => x != null && x > 0) ?? null, peak = f.reduce((m, x) => (x != null && x > m ? x : m), 0), pi = f.indexOf(peak);
    if (base && peak / base >= 1.5 && r3 >= 70) { fl = Math.min(2, Math.max(fl, 1) + (fl >= 1 ? 1 : 0)); }
    if (base && peak >= 200 && peak / base >= 2) { fl = Math.max(fl, peak / base >= 3 && peak >= 500 ? 2 : 1); }
    if (base && peak / base >= 1.5) flowNote = ` River flow near here is forecast to rise from about ${Math.round(base)} to ${Math.round(peak)} m³/s around ${describeDate(flow.dates[pi] || '').label}.`;
  }
  if (fl >= 0) {
    push('flood', fl, r1 >= 70 ? dRain.date : days[i3].date, null,
      `${r3 > 0 ? `${mm1(r3)} of rain over 3 days (${mm1(r1)} in the wettest 24 h).` : 'Little rain forecast here.'}${flowNote}`);
  }
  // Landslide risk from rainfall totals
  if (r3 >= 150 || r1 >= 100) push('landslide', r3 >= 250 ? 2 : 1, r1 >= 100 ? dRain.date : days[i3].date, null, `${mm1(r3)} of rain over 3 days (${mm1(r1)} in the wettest 24 h).`);
  // Strong winds
  const dWind = maxBy(days, d => d.gustMax ?? d.windMax), g = dWind?.gustMax ?? dWind?.windMax ?? 0;
  if (g >= 62) push('wind', g >= 88 ? 2 : 1, dWind.date, peakHour(dWind.date, h => h.gust ?? h.wind), `Gusts up to ${Math.round(g)} km/h (${g >= 118 ? 'typhoon force' : g >= 88 ? 'storm force' : 'gale force'}).`);
  // Extreme heat: a single hot day is an advisory, three in a row a watch.
  const xHour = data.hourly.filter(h => h.date >= v.today && h.cond.key === 'sun-extreme').map(h => h.date);
  const hot = days.map(d => (d.feelsMax ?? d.max ?? 0) >= 41 || (d.max ?? 0) >= 37 || d.cond.key === 'sun-extreme' || xHour.includes(d.date)); // an "Extremely hot" condition always counts
  const hotDay = days.find((_, i) => hot[i]);
  if (hotDay) {
    let run = 0, best = 0; for (const h of hot) { run = h ? run + 1 : 0; best = Math.max(best, run); }
    const hi = maxBy(days.filter((_, i) => hot[i]), d => d.feelsMax ?? d.max);
    push('heat', best >= 3 ? 2 : 1, hotDay.date, null, `Up to ${Math.round(hi.max ?? 0)}°C, feels like ${Math.round(hi.feelsMax ?? hi.max ?? 0)}°C${hi.uv != null ? `, UV ${Number(hi.uv.toFixed(1))}` : ''}${best >= 3 ? `; ${best} hot days in a row` : ''}.`);
  }
  // Thunderstorms (hail codes are the stronger signal)
  const storms = data.hourly.filter(h => h.date >= v.today && h.code != null && h.code >= 95 && (h.pop ?? 100) >= 50);
  if (storms.length) {
    const s = storms.find(h => h.code >= 96) || storms[0];
    push('thunder', s.code >= 96 ? 1 : 0, s.date, s.hour, `${s.code >= 96 ? 'Thunderstorm with hail' : 'Thunderstorm'} in the forecast${s.pop != null ? ` (rain chance ${Math.round(s.pop)}%)` : ''}; ${storms.length} stormy hour${storms.length === 1 ? '' : 's'} in the next 7 days.`);
  }
  return out;
}

/** GDACS events near a location -> alerts. Distance bands cap how high an alert can go for far-away systems. */
function gdacsAlerts(loc, events, now, checkedMs) {
  const out = [];
  for (const e of events) {
    if (e.to != null && e.to < now - DAY_MS) continue;
    const km = e.lat != null ? distanceKm(loc.lat, loc.lon, e.lat, e.lon) : null, inVn = e.countries.includes('VNM');
    const base = { green: 1, orange: 2, red: 3 }[e.level];
    let r;
    if (e.type === 'TC') {
      const reach = km ?? (inVn ? 600 : null);
      if (reach == null || reach > 1500) continue;
      r = Math.min(base, reach <= 400 ? 3 : reach <= 800 ? 2 : 1);
      if (reach > 800) r = 0;
    } else {
      const near = (km != null && km <= (e.type === 'TS' ? 500 : 300)) || inVn;
      if (!near) continue;
      r = km != null && km > 300 ? Math.min(base, 1) : base;
    }
    const meta = e.type === 'TC' ? 'cyclone' : e.type === 'FL' ? 'gflood' : e.type === 'TS' ? 'tsunami' : 'volcano';
    const t = TYPES[meta], level = LEVELS[r];
    out.push({
      key: `gdacs:${e.type}:${e.id}`, type: `${t.en}: ${e.name}`, typeVi: t.vi, typeId: meta, level, kind: 'reported', locId: loc.id,
      whenText: e.from ? `Reported ${vnTime(e.from)}${e.to ? `, active until ${vnTime(e.to)}` : ''}` : 'Reported by GDACS', whenSort: e.from ? nowInVietnam(e.from) : '',
      severity: `${e.severity || `GDACS ${e.level} alert`}${km != null ? `; about ${Math.round(km)} km from here` : ''}. GDACS alert colour: ${e.level}.`,
      description: t.desc, precautions: t.tips, sources: [{ name: `GDACS report: ${e.name}`, url: e.report }, SOURCES.gdacs, ...VN_SOURCES],
      updatedMs: e.modified, checkedMs,
    });
  }
  return out;
}

/** USGS earthquakes (reported in the last 7 days) near a location -> alerts. */
function quakeAlerts(loc, quakes, now, checkedMs) {
  const out = [];
  for (const q of quakes) {
    if (q.time < now - 7 * DAY_MS || q.time > now + 3600000) continue;
    const km = distanceKm(loc.lat, loc.lon, q.lat, q.lon), m = q.mag;
    const r = (m >= 6 && km <= 300) || (m >= 5 && km <= 100) ? 3 : (m >= 5 && km <= 300) || (m >= 4 && km <= 100) ? 2
      : (m >= 4 && km <= 300) || (m >= 3 && km <= 100) ? 1 : m >= 3 && km <= 300 ? 0 : m >= 6.5 && km <= 800 ? 1 : -1;
    if (r < 0) continue;
    out.push({
      key: `usgs:${q.id}`, type: `${TYPES.quake.en} M${m.toFixed(1)}`, typeVi: TYPES.quake.vi, typeId: 'quake', level: LEVELS[r], kind: 'reported', locId: loc.id,
      whenText: `Reported ${vnTime(q.time)}`, whenSort: nowInVietnam(q.time),
      severity: `Magnitude ${m.toFixed(1)}, ${q.place}${q.depth != null ? `, depth ${Math.round(q.depth)} km` : ''}; about ${Math.round(km)} km from here${q.tsunami ? '. A tsunami message was issued by NOAA.' : '.'}`,
      description: TYPES.quake.desc, precautions: TYPES.quake.tips, sources: [{ name: 'USGS event page', url: q.url }, SOURCES.usgs, SOURCES.igp],
      updatedMs: q.updated ?? q.time, checkedMs,
    });
  }
  return out;
}

/**
 * Combine everything into alerts for all locations.
 * @param {object[]} locations
 * @param {Object<string, {status, data, fetchedAt}>} forecasts per location (the same entries the weather view uses)
 * @param {{gdacs, usgs, flood}|null} sources result of loadAlertSources (null while loading)
 * @returns {{ loading, groups, count, unavailable: string[], complete: boolean, top: string|null, byLocation: Object<string, string> }}
 *   groups: one entry per distinct event (alerts for the same event at several locations are merged), most severe first.
 *   byLocation: highest alert level per affected location. complete: every source answered, so "no alerts" can be trusted.
 */
export function buildAlerts(locations, forecasts, sources, now = Date.now()) {
  const nowIso = nowInVietnam(now), unavailable = [];
  const pending = locations.some(l => !forecasts[l.id] || forecasts[l.id].status === 'loading');
  if (!sources || pending) return { loading: true, groups: [], count: 0, unavailable, complete: false, top: null, byLocation: {} };
  const alerts = [];
  for (const loc of locations) {
    const f = forecasts[loc.id], flood = sources.flood && sources.flood[loc.id];
    if (!f || f.status !== 'ok' || !f.data) { unavailable.push(`Weather forecast for ${loc.short}`); }
    else if (!viewForecast(f.data, nowIso).days.length) unavailable.push(`Weather forecast for ${loc.short} (data out of date)`);
    else alerts.push(...forecastAlerts(loc, f.data, flood, nowIso, f.fetchedAt));
    if (sources.gdacs.status === 'ok') alerts.push(...gdacsAlerts(loc, sources.gdacs.data, now, sources.gdacs.fetchedAt));
    if (sources.usgs.status === 'ok') alerts.push(...quakeAlerts(loc, sources.usgs.data, now, sources.usgs.fetchedAt));
  }
  if (sources.gdacs.status !== 'ok') unavailable.push('GDACS tropical cyclone and flood reports');
  if (sources.usgs.status !== 'ok') unavailable.push('USGS earthquake reports');
  const floodFailed = locations.filter(l => !sources.flood || !sources.flood[l.id] || sources.flood[l.id].status !== 'ok');
  if (floodFailed.length) unavailable.push(`River-flow forecast${floodFailed.length < locations.length ? ` (${floodFailed.map(l => l.short).join(', ')})` : ''}`);

  const map = new Map();
  for (const a of alerts) {
    let g = map.get(a.key);
    if (!g) { g = { key: a.key, type: a.type, typeVi: a.typeVi, typeId: a.typeId, kind: a.kind, description: a.description, precautions: a.precautions, sources: a.sources, items: [], level: a.level, updatedMs: 0, checkedMs: 0 }; map.set(a.key, g); }
    g.items.push(a);
    if (rank(a.level) > rank(g.level)) g.level = a.level;
    g.updatedMs = Math.max(g.updatedMs, a.updatedMs || 0); g.checkedMs = Math.max(g.checkedMs, a.checkedMs || 0);
  }
  const order = new Map(locations.map((l, i) => [l.id, i]));
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => rank(b.level) - rank(a.level) || order.get(a.locId) - order.get(b.locId));
  groups.sort((a, b) => rank(b.level) - rank(a.level) || String(a.items[0].whenSort).localeCompare(String(b.items[0].whenSort)));
  const byLocation = {};
  for (const a of alerts) if (rank(a.level) > rank(byLocation[a.locId] || 'x')) byLocation[a.locId] = a.level;
  return { loading: false, groups, count: groups.length, unavailable, complete: !unavailable.length, top: groups[0]?.level ?? null, byLocation };
}
