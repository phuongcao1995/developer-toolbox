// Run: node tests/unit/weather-forecast.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/weather-forecast/logic.js';
let pass = 0;
const queue = [];
const test = (n, f) => queue.push(async () => { try { await f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } });

const memStore = () => { const m = new Map(); return { get: (k, d = null) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; }, m }; };

/** A synthetic Open-Meteo payload: 2 days of hours (2026-11-10, 11) and 2 daily rows. */
function raw(extra = {}) {
  const time = [];
  for (const d of ['2026-11-10', '2026-11-11']) for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`);
  const fill = v => time.map((_, i) => (typeof v === 'function' ? v(i) : v));
  return {
    current: { time: '2026-11-10T09:45', temperature_2m: 27.4, apparent_temperature: 31, relative_humidity_2m: 80, weather_code: 61, wind_speed_10m: 12, wind_direction_10m: 45, precipitation: 0.3, is_day: 1 },
    hourly: { time, temperature_2m: fill(i => 20 + i % 24), apparent_temperature: fill(25), relative_humidity_2m: fill(70), precipitation_probability: fill(40), precipitation: fill(0.1),
      weather_code: fill(3), wind_speed_10m: fill(8), wind_direction_10m: fill(180), is_day: fill(i => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)) },
    daily: { time: ['2026-11-10', '2026-11-11'], weather_code: [61, 0], temperature_2m_max: [30, 31], temperature_2m_min: [22, 23], precipitation_probability_max: [80, 10],
      precipitation_sum: [5.2, 0], wind_speed_10m_max: [20, 15], uv_index_max: [7.5, 9], sunrise: ['2026-11-10T06:01', '2026-11-11T06:02'], sunset: ['2026-11-10T17:12', '2026-11-11T17:11'] },
    ...extra,
  };
}

test('locations: six, Vietnam coordinates, unique ids', () => {
  assert.equal(L.LOCATIONS.length, 6);
  assert.equal(new Set(L.LOCATIONS.map(l => l.id)).size, 6);
  for (const l of L.LOCATIONS) { assert.ok(l.lat > 15.9 && l.lat < 16.7 && l.lon > 107.4 && l.lon < 108.3, l.id); assert.ok(l.name && l.short); }
  assert.notDeepEqual([L.LOCATIONS[1].lat, L.LOCATIONS[1].lon], [L.LOCATIONS[2].lat, L.LOCATIONS[2].lon], 'the two Đà Nẵng addresses differ');
});
test('buildForecastUrl', () => {
  const u = new URL(L.buildForecastUrl(L.LOCATIONS[2]));
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('timezone'), 'Asia/Ho_Chi_Minh');
  assert.equal(u.searchParams.get('forecast_days'), '7');
  assert.equal(u.searchParams.get('latitude'), String(L.LOCATIONS[2].lat));
  assert.ok(u.searchParams.get('hourly').includes('precipitation_probability'));
  assert.ok(u.searchParams.get('daily').includes('uv_index_max'));
});
test('weather codes and compass', () => {
  assert.deepEqual(L.weatherCodeInfo(0, true), { label: 'Sunny', icon: 'sun', tone: 'clear' });
  assert.equal(L.weatherCodeInfo(0, false).icon, 'moon');
  assert.equal(L.weatherCodeInfo(95).label, 'Thunderstorm');
  assert.equal(L.weatherCodeInfo(63).tone, 'rain');
  assert.equal(L.weatherCodeInfo(999).label, 'Unknown');
  assert.equal(L.weatherCodeInfo(null).icon, 'cloud');
  assert.equal(L.degToCompass(0), 'N'); assert.equal(L.degToCompass(359), 'N'); assert.equal(L.degToCompass(90), 'E');
  assert.equal(L.degToCompass(225), 'SW'); assert.equal(L.degToCompass(-90), 'W'); assert.equal(L.degToCompass(null), '');
});
test('normalize: shapes and values', () => {
  const d = L.normalizeForecast(raw());
  assert.equal(d.hourly.length, 48); assert.equal(d.daily.length, 2);
  assert.equal(d.current.temp, 27.4); assert.equal(d.current.pop, 40); assert.equal(d.current.compass, 'NE'); assert.equal(d.current.info.label, 'Light rain');
  assert.equal(d.daily[0].weekday, 'Tue'); assert.equal(d.daily[0].label, '10 Nov'); assert.equal(d.daily[0].uv, 7.5); assert.equal(d.daily[0].sunrise, '06:01');
  assert.equal(d.hourly[0].isDay, false); assert.equal(d.hourly[12].isDay, true);
});
test('normalize: missing and invalid fields become null, not crashes', () => {
  const r = raw(); delete r.hourly.apparent_temperature; r.hourly.temperature_2m[3] = null; r.daily.uv_index_max = [null, 'x']; r.current = {};
  const d = L.normalizeForecast(r);
  assert.equal(d.hourly[0].feels, null); assert.equal(d.hourly[3].temp, null); assert.equal(d.daily[0].uv, null); assert.equal(d.daily[1].uv, null);
  assert.equal(d.current.temp, null); assert.equal(d.current.info.label, 'Unknown');
  assert.equal(L.fmt(null), '–'); assert.equal(L.fmt(27.46, 1, '°'), '27.5°');
});
test('normalize: rejects unusable responses', () => {
  assert.throws(() => L.normalizeForecast(null), /unexpected/);
  assert.throws(() => L.normalizeForecast({}), /unexpected/);
  assert.throws(() => L.normalizeForecast({ hourly: { time: [] }, daily: { time: [] } }), /unexpected/);
});
test('nowInVietnam is UTC+7 whatever the host zone', () => {
  assert.equal(L.nowInVietnam(Date.UTC(2026, 10, 10, 17, 30)), '2026-11-11T00:30');
  assert.equal(L.nowInVietnam(Date.UTC(2026, 10, 10, 0, 0)), '2026-11-10T07:00');
  assert.equal(L.nowInVietnam(Date.UTC(2026, 10, 10, 16, 59)), '2026-11-10T23:59');
});
test('viewForecast: today, current hour, outdated detection', () => {
  const d = L.normalizeForecast(raw());
  let v = L.viewForecast(d, '2026-11-10T09:45');
  assert.equal(v.hours.length, 24); assert.equal(v.hours.filter(h => h.isCurrent).length, 1); assert.equal(v.hours.find(h => h.isCurrent).hour, '09');
  assert.equal(v.days.length, 2); assert.equal(v.days[0].isToday, true); assert.equal(v.days[1].isToday, false); assert.equal(v.outdated, false);
  v = L.viewForecast(d, '2026-11-11T00:10');
  assert.equal(v.days.length, 1); assert.equal(v.days[0].date, '2026-11-11'); assert.equal(v.hours[0].isCurrent, true);
  v = L.viewForecast(d, '2026-11-20T10:00');
  assert.equal(v.outdated, true); assert.equal(v.days.length, 0); assert.equal(v.hours.length, 0);
});

const okFetch = (body = raw(), counter) => async () => { if (counter) counter.n++; return { ok: true, status: 200, json: async () => body }; };

test('fetchForecast: HTTP errors, bad JSON, API error flag, network failure', async () => {
  const loc = L.LOCATIONS[0];
  await assert.rejects(L.fetchForecast(loc, { fetchImpl: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
  await assert.rejects(L.fetchForecast(loc, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /Too many/);
  await assert.rejects(L.fetchForecast(loc, { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) }), /unreadable/);
  await assert.rejects(L.fetchForecast(loc, { fetchImpl: async () => ({ ok: true, json: async () => ({ error: true, reason: 'bad coords' }) }) }), /bad coords/);
  await assert.rejects(L.fetchForecast(loc, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /Could not reach/);
  assert.equal((await L.fetchForecast(loc, { fetchImpl: okFetch() })).daily.length, 2);
});
test('loadForecast: caches 10 minutes, force bypasses, dedupes concurrent calls', async () => {
  const storage = memStore(), c = { n: 0 }, loc = L.LOCATIONS[0];
  const [a, b] = await Promise.all([L.loadForecast(loc, { storage, fetchImpl: okFetch(raw(), c) }), L.loadForecast(loc, { storage, fetchImpl: okFetch(raw(), c) })]);
  assert.equal(c.n, 1); assert.equal(a.fromCache, false); assert.equal(b.data.daily.length, 2);
  const cached = await L.loadForecast(loc, { storage, fetchImpl: okFetch(raw(), c) });
  assert.equal(c.n, 1); assert.equal(cached.fromCache, true);
  await L.loadForecast(loc, { storage, fetchImpl: okFetch(raw(), c), force: true });
  assert.equal(c.n, 2);
  await L.loadForecast(loc, { storage, fetchImpl: okFetch(raw(), c), now: Date.now() + L.CACHE_TTL_MS + 1000 });
  assert.equal(c.n, 3);
});
test('loadForecast: failure with cache returns stale data + error; without cache rejects', async () => {
  const storage = memStore(), loc = L.LOCATIONS[1], bad = async () => { throw new TypeError('offline'); };
  await assert.rejects(L.loadForecast(loc, { storage, fetchImpl: bad }), /Could not reach/);
  await L.loadForecast(loc, { storage, fetchImpl: okFetch() });
  const r = await L.loadForecast(loc, { storage, fetchImpl: bad, force: true });
  assert.equal(r.fromCache, true); assert.match(r.error, /Could not reach/); assert.equal(r.data.daily.length, 2);
});
test('loadForecast: one location failing does not affect the others', async () => {
  const storage = memStore();
  const fetchImpl = async url => (url.includes(`latitude=${L.LOCATIONS[1].lat}&`) ? { ok: false, status: 503 } : { ok: true, json: async () => raw() });
  const res = await Promise.allSettled(L.LOCATIONS.map(l => L.loadForecast(l, { storage, fetchImpl })));
  assert.deepEqual(res.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
});
test('loadForecast: ignores a corrupt cache entry', async () => {
  const storage = memStore(), c = { n: 0 }; storage.set('cache:phong-quang', { fetchedAt: Date.now(), data: { nope: 1 } });
  await L.loadForecast(L.LOCATIONS[0], { storage, fetchImpl: okFetch(raw(), c) });
  assert.equal(c.n, 1);
});

for (const q of queue) await q();
console.log(`weather-forecast: ${pass} passed`);
