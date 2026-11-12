// Weather Forecast: pure logic (no DOM). Data comes from Open-Meteo (https://open-meteo.com/), no API key needed.
export const TZ = 'Asia/Ho_Chi_Minh';
export const API_URL = 'https://api.open-meteo.com/v1/forecast';
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15000;

/**
 * Fixed coordinates, resolved from OpenStreetMap (ward centre for Phong Quảng, street positions for the two addresses, the centre of the
 * "Làng Thể thao Tuyên Sơn" pitch cluster for the stadium; accurate to a few hundred metres, plenty for weather) so they are deterministic and need no runtime geocoding.
 */
export const LOCATIONS = [
  { id: 'phong-quang', name: 'Phường Phong Quảng, Huế, Việt Nam', short: 'Phong Quảng', area: 'Huế', lat: 16.6297, lon: 107.5130 },
  { id: 'ha-huy-tap', name: '282 Hà Huy Tập, Thanh Khê, Đà Nẵng, Việt Nam', short: '282 Hà Huy Tập', area: 'Thanh Khê, Đà Nẵng', lat: 16.0640, lon: 108.1903 },
  { id: 'nguyen-phuoc-lan', name: '214 Nguyễn Phước Lan, Hòa Xuân, Đà Nẵng, Việt Nam', short: '214 Nguyễn Phước Lan', area: 'Hòa Xuân, Đà Nẵng', lat: 16.0222, lon: 108.2246 },
  { id: 'tuyen-son', name: 'Sân bóng Tuyên Sơn, Đà Nẵng, Việt Nam', short: 'Sân Tuyên Sơn', area: 'Đà Nẵng', lat: 16.0347, lon: 108.2271 },
];

const HOURLY = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation_probability', 'precipitation',
  'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'is_day'];
const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max', 'precipitation_sum',
  'wind_speed_10m_max', 'uv_index_max', 'sunrise', 'sunset'];
const CURRENT = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m',
  'wind_direction_10m', 'precipitation', 'is_day'];

export function buildForecastUrl(loc) {
  const p = new URLSearchParams({
    latitude: String(loc.lat), longitude: String(loc.lon), timezone: TZ, forecast_days: '7', wind_speed_unit: 'kmh',
    temperature_unit: 'celsius', precipitation_unit: 'mm',
    current: CURRENT.join(','), hourly: HOURLY.join(','), daily: DAILY.join(','),
  });
  return `${API_URL}?${p}`;
}

// ---------- WMO weather codes ----------
// Every icon name used below. scripts/build-icons.mjs only bundles names it finds on lines mentioning "icon".
export const WEATHER_ICONS = ['sun', 'moon', 'cloud-sun', 'cloud-moon', 'cloud', 'cloud-fog', 'cloud-drizzle', 'cloud-rain', 'cloud-snow', 'cloud-lightning'];
const day = (label, icon, night = icon) => ({ label, icon, night });
const CODES = {
  0: day('Sunny', 'sun', 'moon'), 1: day('Mostly sunny', 'sun', 'moon'), 2: day('Partly cloudy', 'cloud-sun', 'cloud-moon'),
  3: day('Cloudy', 'cloud'), 45: day('Fog', 'cloud-fog'), 48: day('Freezing fog', 'cloud-fog'),
  51: day('Light drizzle', 'cloud-drizzle'), 53: day('Drizzle', 'cloud-drizzle'), 55: day('Heavy drizzle', 'cloud-drizzle'),
  56: day('Freezing drizzle', 'cloud-drizzle'), 57: day('Freezing drizzle', 'cloud-drizzle'),
  61: day('Light rain', 'cloud-rain'), 63: day('Rain', 'cloud-rain'), 65: day('Heavy rain', 'cloud-rain'),
  66: day('Freezing rain', 'cloud-rain'), 67: day('Freezing rain', 'cloud-rain'),
  71: day('Light snow', 'cloud-snow'), 73: day('Snow', 'cloud-snow'), 75: day('Heavy snow', 'cloud-snow'), 77: day('Snow grains', 'cloud-snow'),
  80: day('Light showers', 'cloud-rain'), 81: day('Showers', 'cloud-rain'), 82: day('Heavy showers', 'cloud-rain'),
  85: day('Snow showers', 'cloud-snow'), 86: day('Snow showers', 'cloud-snow'),
  95: day('Thunderstorm', 'cloud-lightning'), 96: day('Thunderstorm, hail', 'cloud-lightning'), 99: day('Thunderstorm, hail', 'cloud-lightning'),
};
/** WMO code -> { label, icon, tone } (tone is a CSS hook: clear | cloud | rain | storm | snow | fog). */
export function weatherCodeInfo(code, isDay = true) {
  const c = CODES[code];
  if (!c) return { label: 'Unknown', icon: 'cloud', tone: 'cloud' };
  const tone = code <= 1 ? 'clear' : code <= 3 ? 'cloud' : code <= 48 ? 'fog' : code >= 95 ? 'storm' : (code >= 71 && code <= 77) || code >= 85 ? 'snow' : 'rain';
  return { label: code === 0 && !isDay ? 'Clear' : code === 1 && !isDay ? 'Mostly clear' : c.label, icon: isDay ? c.icon : c.night, tone };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function degToCompass(deg) {
  if (!Number.isFinite(deg)) return '';
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const at = (arr, i) => (Array.isArray(arr) ? num(arr[i]) : null);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' -> { weekday: 'Mon', label: '10 Nov' } (calendar maths only, independent of the browser's time zone). */
export function describeDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  if (!m) return { weekday: '', label: date || '' };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return { weekday: WEEKDAYS[d.getUTCDay()], label: `${+m[3]} ${MONTHS[+m[2] - 1]}` };
}

/** Current wall-clock time in Vietnam as 'YYYY-MM-DDTHH:mm' (same format as Open-Meteo with timezone=Asia/Ho_Chi_Minh). */
export function nowInVietnam(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Turn a raw Open-Meteo response into a compact, null-tolerant structure. Throws if the essentials are missing. */
export function normalizeForecast(raw) {
  const h = raw && raw.hourly, d = raw && raw.daily;
  if (!h || !Array.isArray(h.time) || !d || !Array.isArray(d.time) || !d.time.length) throw new Error('The weather service returned an unexpected response.');
  const hourly = h.time.map((time, i) => {
    const code = at(h.weather_code, i), isDay = at(h.is_day, i) !== 0, dir = at(h.wind_direction_10m, i);
    return {
      time, date: time.slice(0, 10), hour: time.slice(11, 13), code, isDay, info: weatherCodeInfo(code, isDay),
      temp: at(h.temperature_2m, i), feels: at(h.apparent_temperature, i), humidity: at(h.relative_humidity_2m, i),
      pop: at(h.precipitation_probability, i), precip: at(h.precipitation, i), wind: at(h.wind_speed_10m, i), windDir: dir, compass: degToCompass(dir),
    };
  });
  const daily = d.time.map((date, i) => {
    const code = at(d.weather_code, i);
    return {
      date, ...describeDate(date), code, info: weatherCodeInfo(code, true),
      max: at(d.temperature_2m_max, i), min: at(d.temperature_2m_min, i), pop: at(d.precipitation_probability_max, i),
      precip: at(d.precipitation_sum, i), windMax: at(d.wind_speed_10m_max, i), uv: at(d.uv_index_max, i),
      sunrise: typeof d.sunrise?.[i] === 'string' ? d.sunrise[i].slice(11, 16) : null, sunset: typeof d.sunset?.[i] === 'string' ? d.sunset[i].slice(11, 16) : null,
    };
  });
  const c = raw.current || {};
  const curCode = num(c.weather_code), curDay = num(c.is_day) !== 0, curDir = num(c.wind_direction_10m);
  const slot = typeof c.time === 'string' ? hourly.find(x => x.time === c.time.slice(0, 13) + ':00') : null;
  const current = {
    time: typeof c.time === 'string' ? c.time : null, code: curCode, isDay: curDay, info: weatherCodeInfo(curCode, curDay),
    temp: num(c.temperature_2m) ?? slot?.temp ?? null, feels: num(c.apparent_temperature) ?? slot?.feels ?? null,
    humidity: num(c.relative_humidity_2m) ?? slot?.humidity ?? null, wind: num(c.wind_speed_10m) ?? slot?.wind ?? null,
    windDir: curDir, compass: degToCompass(curDir), precip: num(c.precipitation), pop: slot?.pop ?? null,
  };
  return { current, hourly, daily };
}

/** Pick what to show for "now" (Vietnam time): today's hours with the current one flagged, and the days from today on. */
export function viewForecast(data, nowIso = nowInVietnam()) {
  const today = nowIso.slice(0, 10), hourKey = nowIso.slice(0, 13);
  const firstDay = data.daily.findIndex(x => x.date >= today);
  const days = firstDay < 0 ? [] : data.daily.slice(firstDay);
  return {
    today,
    outdated: !data.daily.some(x => x.date === today),
    hours: data.hourly.filter(x => x.date === today).map(x => ({ ...x, isCurrent: x.time.slice(0, 13) === hourKey })),
    days: days.map(x => ({ ...x, isToday: x.date === today })),
  };
}

// ---------- fetching and caching ----------
const inflight = new Map();

function readCache(storage, id) {
  const c = storage && storage.get(`cache:${id}`, null);
  return c && typeof c.fetchedAt === 'number' && c.data && Array.isArray(c.data.hourly) && Array.isArray(c.data.daily) ? c : null;
}

/** One network request, with a timeout; the caller's signal also aborts it. */
export async function fetchForecast(loc, { fetchImpl = globalThis.fetch, signal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), REQUEST_TIMEOUT_MS);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) { if (signal.aborted) ctl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    let res;
    try { res = await fetchImpl(buildForecastUrl(loc), { signal: ctl.signal, headers: { Accept: 'application/json' } }); }
    catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(ctl.signal.aborted ? 'The weather service took too long to respond.' : 'Could not reach the weather service. Check your connection.');
    }
    if (!res.ok) throw new Error(res.status === 429 ? 'Too many requests to the weather service. Try again in a minute.' : `The weather service returned an error (HTTP ${res.status}).`);
    let json;
    try { json = await res.json(); } catch { throw new Error('The weather service returned an unreadable response.'); }
    if (json && json.error) throw new Error(`The weather service reported an error: ${json.reason || 'unknown'}.`);
    return normalizeForecast(json);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

/**
 * Cached load. Fresh cache (< 10 min) is returned without a request unless `force`. Concurrent calls for the same location share
 * one request. If the request fails but an older cached copy exists, that copy is returned with `error` set (stale-while-error).
 * Resolves { data, fetchedAt, fromCache, error? }; rejects only when there is nothing to show.
 */
export async function loadForecast(loc, { storage, fetchImpl, signal, force = false, now = Date.now() } = {}) {
  const cached = readCache(storage, loc.id);
  if (cached && !force && now - cached.fetchedAt < CACHE_TTL_MS && now >= cached.fetchedAt) return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true };
  let p = inflight.get(loc.id);
  if (!p) {
    p = fetchForecast(loc, { fetchImpl, signal }).then(data => {
      const fetchedAt = Date.now();
      storage?.set(`cache:${loc.id}`, { fetchedAt, data });
      return { data, fetchedAt, fromCache: false };
    }).finally(() => inflight.delete(loc.id));
    inflight.set(loc.id, p);
  }
  try { return await p; } catch (e) {
    if (signal?.aborted) throw e;
    if (cached) return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true, error: e.message };
    throw e;
  }
}

// ---------- formatting ----------
export const fmt = (v, digits = 0, unit = '') => (v == null ? '–' : `${Number(v.toFixed(digits))}${unit}`);
