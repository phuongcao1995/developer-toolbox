// Run: node tests/unit/weather-alerts.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/weather-forecast/logic.js';
import * as C from '../../tools/weather-forecast/conditions.js';
import * as A from '../../tools/weather-forecast/alerts.js';
let pass = 0;
const queue = [];
const test = (n, f) => queue.push(async () => { try { await f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } });
const memStore = () => { const m = new Map(); return { get: (k, d = null) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; } }; };
const key = x => C.classifyCondition(x).key;

// ---------- conditions ----------
test('rain: hourly intensity bands', () => {
  const r = precip => key({ code: 61, precip, pop: 80, cloud: 100 });
  assert.equal(r(0.4), 'rain-light'); assert.equal(r(2.5), 'rain-light'); assert.equal(r(5), 'rain-moderate');
  assert.equal(r(12), 'rain-heavy'); assert.equal(r(25), 'rain-very-heavy');
});
test('rain: daily totals follow the 16 / 50 / 100 mm bands', () => {
  const r = precip => key({ code: 63, precip, pop: 90, period: 'day' });
  assert.equal(r(10), 'rain-light'); assert.equal(r(30), 'rain-moderate'); assert.equal(r(70), 'rain-heavy'); assert.equal(r(120), 'rain-very-heavy');
});
test('rain: a "heavy rain" code is not downgraded by a tiny amount; no precipitation and no rain code means no rain', () => {
  assert.equal(key({ code: 65, precip: 0.5, pop: 90 }), 'rain-heavy');
  assert.equal(key({ code: 3, precip: 0, cloud: 95, pop: 70 }), 'overcast');
  assert.equal(C.classifyCondition({ code: 95, precip: 3, pop: 80 }).thunder, true);
});
test('overcast: thick cloud, no rain, no sunshine', () => {
  const c = C.classifyCondition({ code: 3, isDay: true, temp: 27, feels: 30, cloud: 96, uv: 1, precip: 0, pop: 10 });
  assert.equal(c.key, 'overcast'); assert.equal(c.vi, 'Trời âm u, không nắng, không mưa');
});
test('sunshine is graded by sun, UV and feels-like, never by temperature alone', () => {
  assert.equal(key({ code: 0, cloud: 5, uv: 10, temp: 36, feels: 43, precip: 0 }), 'sun-extreme');
  assert.equal(key({ code: 0, cloud: 10, uv: 9, temp: 34, feels: 37, precip: 0 }), 'sun-hot');
  assert.equal(key({ code: 0, cloud: 15, uv: 7, temp: 29, feels: 31, precip: 0 }), 'sun-pleasant');
  assert.equal(key({ code: 1, cloud: 60, uv: 5, temp: 28, feels: 30, precip: 0 }), 'sun-slight');
  assert.equal(key({ code: 0, cloud: 10, uv: 2, temp: 33, feels: 34, precip: 0 }), 'sun-slight', 'low UV (early/late sun) is only mild sunshine');
  assert.equal(key({ code: 0, cloud: 10, uv: 8, temp: 24, feels: 22, precip: 0 }), 'sun-slight', 'cool air is only mild sunshine');
  // 38 °C on paper, but the sky is overcast: not "hot sunshine"
  assert.equal(key({ code: 3, cloud: 92, uv: 3, temp: 38, feels: 42, precip: 0 }), 'overcast');
  assert.equal(key({ code: 0, cloud: 5, uv: 11, temp: 31, feels: 33, precip: 0 }), 'sun-hot', 'strong UV plus a feels-like of 33');
});
test('night, fog and missing data', () => {
  assert.equal(key({ code: 0, isDay: false, cloud: 5, temp: 24 }), 'night-clear');
  assert.equal(key({ code: 2, isDay: false, cloud: 60, temp: 24 }), 'night-cloudy');
  assert.equal(key({ code: 45, cloud: 100, temp: 22 }), 'fog');
  assert.equal(key({}), 'unknown');
  assert.equal(C.describeCondition(C.classifyCondition({}), {}).en, 'Weather data is unavailable.');
});
test('every condition has English + Vietnamese names and an icon that icons.js can draw', () => {
  for (const [k, c] of Object.entries(C.CONDITIONS)) { assert.ok(c.en && c.vi && c.icon && c.tone, k); assert.ok(L.WEATHER_ICONS.includes(c.icon), `${k}: ${c.icon}`); }
  assert.deepEqual(['rain-light', 'rain-moderate', 'rain-heavy', 'rain-very-heavy'].map(k => C.CONDITIONS[k].vi), ['Mưa nhỏ', 'Mưa vừa', 'Mưa to', 'Mưa rất to']);
  assert.deepEqual(['sun-slight', 'sun-pleasant', 'sun-hot', 'sun-extreme'].map(k => C.CONDITIONS[k].vi), ['Nắng nhẹ', 'Nắng đẹp vừa phải', 'Nắng nóng', 'Nắng gắt']);
});
test('description mentions rain chance and amount for rain, and feels-like when it differs', () => {
  const c = C.classifyCondition({ code: 63, precip: 4, pop: 85 });
  const t = C.describeCondition(c, { temp: 26, feels: 31, pop: 85, precip: 4 });
  assert.match(t.en, /85%/); assert.match(t.en, /4 mm/); assert.match(t.vi, /85%/);
  const s = C.describeCondition(C.classifyCondition({ code: 0, cloud: 5, uv: 9, temp: 34, feels: 38 }), { temp: 34, feels: 38, uv: 9 });
  assert.match(s.en, /Feels like 38/); assert.match(s.en, /UV/);
});

// ---------- alerts ----------
const DAYS = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
/** Seven-day Open-Meteo payload. `o` overrides daily arrays (rain, gust, tmax, feels) and hourly codes. */
function raw7(o = {}) {
  const time = []; for (const d of DAYS) for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`);
  const per = (arr, def) => time.map((_, i) => (arr ? arr[Math.floor(i / 24)] : def));
  const rain = o.rain || DAYS.map(() => 0);
  return {
    current: { time: '2026-11-13T09:00', temperature_2m: 27, apparent_temperature: 29, relative_humidity_2m: 80, weather_code: 3, wind_speed_10m: 10, wind_direction_10m: 90, precipitation: 0, is_day: 1, cloud_cover: 90 },
    hourly: { time, temperature_2m: per(null, 27), apparent_temperature: per(null, 29), relative_humidity_2m: per(null, 75), precipitation_probability: per(o.pop, 20),
      precipitation: time.map((_, i) => (rain[Math.floor(i / 24)] / 24) * (i % 24 === 15 ? 6 : 0.5 / 1) * 0 + (i % 24 === 15 ? rain[Math.floor(i / 24)] / 2 : 0)),
      weather_code: time.map((_, i) => (o.code ? o.code(i) : 3)), wind_speed_10m: per(null, 10), wind_direction_10m: per(null, 90), is_day: time.map((_, i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)),
      cloud_cover: per(null, 90), uv_index: per(null, 2), wind_gusts_10m: per(o.gust, 20) },
    daily: { time: DAYS, weather_code: DAYS.map(() => 3), temperature_2m_max: o.tmax || DAYS.map(() => 29), temperature_2m_min: DAYS.map(() => 23), precipitation_probability_max: DAYS.map(() => 40),
      precipitation_sum: rain, wind_speed_10m_max: DAYS.map(() => 15), uv_index_max: DAYS.map(() => 5), sunrise: DAYS.map(d => `${d}T06:00`), sunset: DAYS.map(d => `${d}T17:15`),
      cloud_cover_mean: DAYS.map(() => 80), apparent_temperature_max: o.feels || DAYS.map(() => 32), wind_gusts_10m_max: o.gust || DAYS.map(() => 25) },
  };
}
const NOW = Date.parse('2026-11-13T05:00:00Z'); // 12:00 Vietnam
const okForecasts = (r = raw7()) => Object.fromEntries(L.LOCATIONS.map(l => [l.id, { status: 'ok', data: L.normalizeForecast(r), fetchedAt: NOW - 60000 }]));
const okFeed = data => ({ status: 'ok', data, fetchedAt: NOW - 30000 });
const calmSources = () => ({ gdacs: okFeed([]), usgs: okFeed([]), flood: Object.fromEntries(L.LOCATIONS.map(l => [l.id, okFeed({ dates: DAYS, flow: [100, 98, 96, 95, 94, 93, 92] })])) });
const near = (loc, dKm, dir = 0) => ({ lat: loc.lat + dKm / 111 * (dir ? 0 : 1), lon: loc.lon + (dir ? dKm / 111 : 0) });

test('detailed conditions reach the normalised forecast (current, hourly, daily)', () => {
  const d = L.normalizeForecast(raw7({ rain: [60, 0, 0, 0, 0, 0, 0] }));
  assert.equal(d.current.cond.key, 'overcast'); assert.ok(d.current.text.en && d.current.text.vi);
  assert.equal(d.daily[0].cond.key, 'rain-heavy'); assert.equal(d.daily[1].cond.key, 'overcast');
  assert.ok(d.hourly.every(h => h.cond && h.text));
  assert.equal(d.hourly[0].info.label, 'Cloudy', 'the raw WMO info is still there');
});
test('forecast URL asks for cloud cover, UV, gusts and feels-like maximum', () => {
  const u = new URL(L.buildForecastUrl(L.LOCATIONS[0]));
  for (const v of ['cloud_cover', 'uv_index', 'wind_gusts_10m']) assert.ok(u.searchParams.get('hourly').includes(v), v);
  for (const v of ['cloud_cover_mean', 'apparent_temperature_max', 'wind_gusts_10m_max']) assert.ok(u.searchParams.get('daily').includes(v), v);
});
test('calm week with every source answering: no alerts and "complete" (the exact no-alert message may be shown)', () => {
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(), calmSources(), NOW);
  assert.equal(r.count, 0); assert.equal(r.complete, true); assert.deepEqual(r.unavailable, []); assert.equal(r.loading, false);
  assert.equal(A.NO_ALERTS_TEXT, 'No severe weather or natural disaster alerts expected in the next 7 days.');
});
test('still loading sources: reported as loading, not as "no alerts"', () => {
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(), null, NOW);
  assert.equal(r.loading, true); assert.equal(r.complete, false);
});
test('very heavy rain: one merged group for all locations, a Watch (never a confirmed Warning), flood risk too', () => {
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(raw7({ rain: [5, 120, 90, 10, 0, 0, 0] })), calmSources(), NOW);
  const rain = r.groups.find(g => g.key === 'fx:rain'), flood = r.groups.find(g => g.key === 'fx:flood');
  assert.ok(rain && flood); assert.equal(rain.items.length, L.LOCATIONS.length); assert.equal(rain.level, 'watch'); assert.equal(rain.kind, 'forecast');
  assert.ok(r.groups.every(g => g.level !== 'warning'));
  assert.equal(new Set(r.groups.map(g => g.key)).size, r.groups.length, 'no duplicate events');
  assert.match(rain.items[0].whenText, /Sat 14 Nov|Tomorrow/); assert.match(rain.items[0].severity, /120 mm/);
  assert.ok(rain.sources.some(s => /^https:\/\//.test(s.url)) && rain.precautions.length >= 3 && rain.description && rain.checkedMs);
  assert.equal(r.groups[0].level, 'watch'); assert.equal(r.top, 'watch');
  for (const l of L.LOCATIONS) assert.equal(r.byLocation[l.id], 'watch');
});
test('a Very heavy rain hour alerts even when the 24 h total is under 50 mm', () => {
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(raw7({ rain: [0, 45, 0, 0, 0, 0, 0] })), calmSources(), NOW);
  const g = r.groups.find(x => x.key === 'fx:rain');
  assert.ok(g, 'alert present'); assert.equal(g.level, 'advisory'); assert.match(g.items[0].severity, /Very heavy rain/);
});
test('only the affected location gets the alert', () => {
  const f = okForecasts(), wet = L.LOCATIONS[1];
  f[wet.id] = { status: 'ok', data: L.normalizeForecast(raw7({ rain: [0, 60, 0, 0, 0, 0, 0] })), fetchedAt: NOW };
  const r = A.buildAlerts(L.LOCATIONS, f, calmSources(), NOW);
  const g = r.groups.find(x => x.key === 'fx:rain');
  assert.deepEqual(g.items.map(i => i.locId), [wet.id]); assert.equal(g.level, 'advisory');
  assert.deepEqual(Object.keys(r.byLocation), [wet.id]);
});
test('river-flow rise upgrades the flood risk and is mentioned', () => {
  const s = calmSources(); s.flood[L.LOCATIONS[0].id] = okFeed({ dates: DAYS, flow: [100, 150, 320, 400, 300, 200, 150] });
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(raw7({ rain: [0, 40, 40, 0, 0, 0, 0] })), s, NOW);
  const f = r.groups.find(g => g.key === 'fx:flood'), it = f.items.find(i => i.locId === L.LOCATIONS[0].id);
  assert.ok(it && /400 m³\/s/.test(it.severity)); assert.ok(['advisory', 'watch'].includes(it.level));
  assert.equal(f.items.some(i => i.locId === L.LOCATIONS[1].id), false, '80 mm over 2 days with a flat river is below the flood threshold');
});
test('strong gusts and extreme heat', () => {
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(raw7({ gust: [20, 95, 30, 20, 20, 20, 20], tmax: [30, 38, 38, 38, 30, 30, 30], feels: [33, 44, 44, 44, 33, 33, 33] })), calmSources(), NOW);
  assert.equal(r.groups.find(g => g.key === 'fx:wind').level, 'watch'); assert.match(r.groups.find(g => g.key === 'fx:wind').items[0].severity, /storm force/);
  const heat = r.groups.find(g => g.key === 'fx:heat'); assert.equal(heat.level, 'watch'); assert.match(heat.items[0].severity, /3 hot days in a row/);
});
test('GDACS cyclone: red + close = Warning; far away = Informational or ignored; shared across locations as one event', () => {
  const loc = L.LOCATIONS[0], p = near(loc, 250);
  const ev = (o = {}) => ({ type: 'TC', id: 1, name: 'Tropical Cyclone TEST', level: 'red', lat: p.lat, lon: p.lon, from: NOW - 2 * 86400000, to: NOW + 86400000, modified: NOW - 3600000,
    report: 'https://www.gdacs.org/report.aspx?eventid=1', severity: 'Typhoon (maximum wind speed of 150 km/h)', countries: [], ...o });
  let s = calmSources(); s.gdacs = okFeed([ev()]);
  let r = A.buildAlerts(L.LOCATIONS, okForecasts(), s, NOW);
  assert.equal(r.groups.length, 1); assert.equal(r.groups[0].kind, 'reported'); assert.equal(r.groups[0].level, 'warning'); assert.equal(r.groups[0].items.length, L.LOCATIONS.length);
  assert.match(r.groups[0].type, /TEST/); assert.match(r.groups[0].items[0].severity, /Typhoon/); assert.equal(r.groups[0].sources[0].url, 'https://www.gdacs.org/report.aspx?eventid=1');
  assert.equal(r.groups[0].updatedMs, NOW - 3600000);
  s.gdacs = okFeed([ev({ lat: 10, lon: 130 })]); r = A.buildAlerts(L.LOCATIONS, okForecasts(), s, NOW);
  assert.equal(r.count, 0, 'a typhoon 2000+ km away is not shown');
  const mid = near(loc, 1000); s.gdacs = okFeed([ev({ lat: mid.lat, lon: mid.lon })]); r = A.buildAlerts(L.LOCATIONS, okForecasts(), s, NOW);
  assert.equal(r.groups[0].level, 'info', 'a distant red cyclone is informational only');
  s.gdacs = okFeed([ev({ to: NOW - 3 * 86400000 })]); r = A.buildAlerts(L.LOCATIONS, okForecasts(), s, NOW);
  assert.equal(r.count, 0, 'finished events are dropped');
});
test('USGS earthquakes: severity by magnitude and distance, small or old ones ignored, one group per quake', () => {
  const loc = L.LOCATIONS[2], q = (id, mag, km, ageH = 5) => ({ id, mag, place: `${km} km test`, ...(() => { const p = near(loc, km, 1); return { lat: p.lat, lon: p.lon }; })(), depth: 10, time: NOW - ageH * 3600000, updated: NOW - 1000, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, tsunami: false });
  const s = calmSources(); s.usgs = okFeed([q('big', 6.2, 60), q('mid', 4.3, 150), q('tiny', 2.4, 20), q('old', 6.0, 20, 24 * 9), q('far', 5.0, 450)]);
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(), s, NOW);
  const by = Object.fromEntries(r.groups.map(g => [g.key, g]));
  assert.equal(by['usgs:big'].level, 'warning'); assert.ok(by['usgs:mid']); assert.equal(by['usgs:tiny'], undefined); assert.equal(by['usgs:old'], undefined); assert.equal(by['usgs:far'], undefined);
  assert.match(by['usgs:big'].items[0].whenText, /^Reported /); assert.match(by['usgs:big'].description, /cannot be predicted/);
  assert.equal(r.groups[0].key, 'usgs:big', 'most severe first');
});
test('a failed source is reported as unavailable, not as "no risk"', () => {
  const s = calmSources(); s.gdacs = { status: 'error', error: 'down' };
  const f = okForecasts(); f[L.LOCATIONS[3].id] = { status: 'error', error: 'timeout' };
  const r = A.buildAlerts(L.LOCATIONS, f, s, NOW);
  assert.equal(r.complete, false); assert.equal(r.count, 0);
  assert.ok(r.unavailable.some(x => /GDACS/.test(x))); assert.ok(r.unavailable.some(x => x.includes(L.LOCATIONS[3].short)));
  assert.equal(A.buildAlerts(L.LOCATIONS, okForecasts(), { ...calmSources(), usgs: { status: 'error' } }, NOW).unavailable[0], 'USGS earthquake reports');
});
test('missing river-flow data is flagged but does not break the rest', () => {
  const s = calmSources(); s.flood = Object.fromEntries(L.LOCATIONS.map(l => [l.id, { status: 'error' }]));
  const r = A.buildAlerts(L.LOCATIONS, okForecasts(raw7({ rain: [0, 60, 0, 0, 0, 0, 0] })), s, NOW);
  assert.ok(r.groups.some(g => g.key === 'fx:rain')); assert.ok(r.unavailable.includes('River-flow forecast')); assert.equal(r.complete, false);
});
test('parsers: non-https links fall back to the agency home page; bad rows are dropped', () => {
  const g = A.parseGdacs({ features: [
    { geometry: { type: 'Point', coordinates: [108, 16] }, properties: { eventtype: 'TC', eventid: 7, name: 'X', alertlevel: 'Orange', iscurrent: 'true', fromdate: '2026-11-10T00:00:00', todate: '2026-11-14T00:00:00', datemodified: '2026-11-13T00:00:00', url: { report: 'javascript:alert(1)' }, affectedcountries: [{ iso3: 'VNM' }] } },
    { geometry: { type: 'Point', coordinates: [0, 0] }, properties: { eventtype: 'EQ', eventid: 8, alertlevel: 'Green', iscurrent: 'true' } },
    { geometry: null, properties: { eventtype: 'TC', eventid: 9, alertlevel: 'Green', iscurrent: 'false' } }] });
  assert.equal(g.length, 1); assert.equal(g[0].report, A.SOURCES.gdacs.url); assert.deepEqual(g[0].countries, ['VNM']); assert.equal(g[0].level, 'orange');
  assert.deepEqual(A.parseGdacs(null), []); assert.deepEqual(A.parseUsgs({}), []);
  const u = A.parseUsgs({ features: [{ id: 'a', geometry: { coordinates: [108, 16, 10] }, properties: { mag: 4, time: 1, url: 'http://x' } }, { id: 'b', geometry: null, properties: { mag: 4, time: 1 } }] });
  assert.equal(u.length, 1); assert.equal(u[0].url, A.SOURCES.usgs.url);
  assert.throws(() => A.parseFlood({}), /unexpected/);
});
test('distanceKm', () => {
  assert.ok(Math.abs(A.distanceKm(16, 108, 17, 108) - 111.2) < 0.5); assert.equal(A.distanceKm(16, 108, 16, 108), 0);
});
test('loadAlertSources: one failing source does not block the others; results are cached', async () => {
  const storage = memStore(); let n = 0;
  const fetchImpl = async url => {
    n++;
    if (url.includes('gdacs.org')) return { ok: false, status: 503 };
    if (url.includes('earthquake.usgs.gov')) { assert.match(url, /minmagnitude=3/); return { ok: true, status: 200, json: async () => ({ features: [] }) }; }
    return { ok: true, status: 200, json: async () => ({ daily: { time: DAYS, river_discharge: [1, 2, 3, 4, 5, 6, 7] } }) };
  };
  const r = await A.loadAlertSources(L.LOCATIONS, { storage, fetchImpl, now: Date.now() });
  assert.equal(r.gdacs.status, 'error'); assert.equal(r.usgs.status, 'ok'); assert.ok(Object.values(r.flood).every(x => x.status === 'ok')); assert.equal(n, L.LOCATIONS.length + 2);
  await A.loadAlertSources(L.LOCATIONS, { storage, fetchImpl, now: Date.now() });
  assert.equal(n, L.LOCATIONS.length + 3, 'only the failed source is requested again; the rest come from the 10-minute cache');
});
test('loadAlertSources: a failed refresh falls back to a recent saved copy', async () => {
  const storage = memStore(), good = async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) }), bad = async () => { throw new TypeError('offline'); };
  await A.loadAlertSources([L.LOCATIONS[0]], { storage, fetchImpl: good });
  const r = await A.loadAlertSources([L.LOCATIONS[0]], { storage, fetchImpl: bad, force: true });
  assert.equal(r.usgs.status, 'ok'); assert.match(r.usgs.error, /Could not reach/);
});

for (const q of queue) await q();
console.log(`weather-alerts: ${pass} passed`);
