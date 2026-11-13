// Weather Forecast: detailed condition classification (pure logic, no DOM).
// A condition comes from precipitation, cloud cover, UV, temperature and the feels-like value together, never from temperature alone.
// The WMO weather code is only used as a hint (e.g. "thunderstorm", "fog") and to fill gaps when a measurement is missing.

/** Condition table. `icon` names are drawn by icons.js (listed in WEATHER_ICONS in logic.js). */
export const CONDITIONS = {
  'rain-light': { en: 'Light rain', vi: 'Mưa nhỏ', icon: 'cloud-drizzle', tone: 'rain', group: 'rain' },
  'rain-moderate': { en: 'Moderate rain', vi: 'Mưa vừa', icon: 'cloud-rain', tone: 'rain', group: 'rain' },
  'rain-heavy': { en: 'Heavy rain', vi: 'Mưa to', icon: 'cloud-downpour', tone: 'rain', group: 'rain' },
  'rain-very-heavy': { en: 'Very heavy rain', vi: 'Mưa rất to', icon: 'cloud-downpour', tone: 'storm', group: 'rain' },
  overcast: { en: 'Overcast', vi: 'Trời âm u, không nắng, không mưa', icon: 'cloud-overcast', tone: 'cloud', group: 'cloud' },
  fog: { en: 'Fog', vi: 'Sương mù', icon: 'cloud-fog', tone: 'fog', group: 'cloud' },
  'sun-slight': { en: 'Slightly sunny', vi: 'Nắng nhẹ', icon: 'cloud-sun', tone: 'clear', group: 'sun' },
  'sun-pleasant': { en: 'Pleasant sunshine', vi: 'Nắng đẹp vừa phải', icon: 'sun', tone: 'clear', group: 'sun' },
  'sun-hot': { en: 'Hot', vi: 'Nắng nóng', icon: 'sun-hot', tone: 'hot', group: 'sun' },
  'sun-extreme': { en: 'Extremely hot', vi: 'Nắng gắt', icon: 'sun-blaze', tone: 'hot', group: 'sun' },
  'night-clear': { en: 'Clear night', vi: 'Trời quang đãng', icon: 'moon', tone: 'clear', group: 'night' },
  'night-cloudy': { en: 'Cloudy night', vi: 'Đêm có mây', icon: 'cloud-moon', tone: 'cloud', group: 'night' },
  unknown: { en: 'No data', vi: 'Chưa có dữ liệu', icon: 'cloud', tone: 'cloud', group: 'none' },
};

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Rain intensity. Hourly uses mm per hour; daily uses the 24 h total thresholds of Vietnam's hydro-meteorological service
// (light ≤ 16 mm, moderate 16-50 mm, heavy 50-100 mm, very heavy > 100 mm).
const RAIN_LEVELS = ['rain-light', 'rain-moderate', 'rain-heavy', 'rain-very-heavy'];
export function rainLevel(mm, period = 'hour') {
  const cut = period === 'day' ? [16, 50, 100] : [2.5, 8, 20];
  return mm <= cut[0] ? 0 : mm <= cut[1] ? 1 : mm <= cut[2] ? 2 : 3;
}
/** Minimum level implied by the weather code alone (used when the model says "heavy rain" but the amount is small or missing). */
const CODE_FLOOR = { 55: 1, 63: 1, 65: 2, 81: 1, 82: 2, 95: 1, 96: 2, 99: 2 };

/** Fraction of sky that is clear (0-1). Falls back to the weather code when cloud cover is missing. */
function clearFraction(cloud, code) {
  if (cloud != null) return Math.max(0, Math.min(1, 1 - cloud / 100));
  return { 0: 0.95, 1: 0.8, 2: 0.5, 3: 0.1 }[code] ?? null;
}

/**
 * Classify one moment or one day.
 * @param {object} x { code, isDay, temp, feels, cloud (%), uv, precip (mm), pop (%), period: 'hour'|'day' }
 * For a day: temp/feels are the day's maximum, cloud its mean, uv its peak, precip its total.
 * @returns {{ key, en, vi, icon, tone, group, thunder: boolean, rainMm: number|null }}
 */
export function classifyCondition({ code = null, isDay = true, temp = null, feels = null, cloud = null, uv = null, precip = null, pop = null, period = 'hour' } = {}) {
  const c = num(code), t = num(temp), f = num(feels), cl = num(cloud), u = num(uv), p = num(precip), pr = num(pop);
  const thunder = c != null && c >= 95;
  const wet = c != null && RAIN_CODES.has(c);
  const pack = key => ({ key, ...CONDITIONS[key], thunder, rainMm: p });
  if (c == null && cl == null && p == null && t == null) return pack('unknown');

  // 1. Rain: measured/forecast precipitation decides; the code only helps when the amount is missing or the model flags a downpour.
  // A trace amount (a tenth of a millimetre) with a low rain chance is not worth calling rain.
  const minRain = period === 'day' ? 1 : 0.2;
  const rainy = p != null ? (p >= minRain && (pr == null || pr >= 25 || p >= 1)) || (wet && (pr == null || pr >= 60) && p > 0) : wet && (pr == null || pr >= 50);
  if (rainy) {
    let lvl = p != null && p >= minRain ? rainLevel(p, period) : 0;
    if (wet && period === 'hour') lvl = Math.max(lvl, CODE_FLOOR[c] ?? 0);
    if (wet && period === 'day' && p == null) lvl = Math.max(lvl, CODE_FLOOR[c] ?? 0);
    return pack(RAIN_LEVELS[lvl]);
  }
  // 2. Fog.
  if (c === 45 || c === 48) return pack('fog');
  const clear = clearFraction(cl, c);
  // 3. Night: no sunshine to grade.
  if (!isDay) return pack(clear != null && clear >= 0.65 ? 'night-clear' : clear != null && clear > 0.2 ? 'night-cloudy' : 'overcast');
  // 4. Day, dry, thick cloud: overcast.
  if (clear == null || clear <= 0.2) return pack(clear == null && t != null && f != null ? 'sun-slight' : 'overcast');
  // 5. Sunny: how strong is the sun (clear sky x UV) and how hot does it feel. Heat only counts when the sun is really out.
  const heat = f ?? t;
  const sunStrong = clear >= 0.4 && (u == null || u >= 6);
  if (heat != null && clear >= 0.4 && (heat >= 41 || (heat >= 38 && u != null && u >= 8))) return pack('sun-extreme');
  if (heat != null && clear >= 0.4 && sunStrong && (heat >= 35 || (heat >= 33 && u != null && u >= 8))) return pack('sun-hot');
  if (clear < 0.5 || (u != null && u < 3) || (heat != null && heat < 24)) return pack('sun-slight');
  return pack('sun-pleasant');
}

const f0 = v => Math.round(v);
/** Short, plain-language sentence (English + Vietnamese) built from the same numbers that drove the classification. */
export function describeCondition(cond, { temp = null, feels = null, pop = null, precip = null, uv = null, period = 'hour' } = {}) {
  const t = num(temp), f = num(feels), pr = num(pop), p = num(precip), u = num(uv);
  const key = cond.key, per = period === 'day' ? 'over the day' : 'this hour', perVi = period === 'day' ? 'cả ngày' : 'trong giờ này';
  const amount = p != null && p > 0 ? { en: ` About ${Number(p.toFixed(1))} mm expected ${per}.`, vi: ` Dự kiến khoảng ${Number(p.toFixed(1))} mm ${perVi}.` } : { en: '', vi: '' };
  const chance = pr != null ? { en: ` Chance of rain ${f0(pr)}%.`, vi: ` Khả năng mưa ${f0(pr)}%.` } : { en: '', vi: '' };
  const feelsNote = t != null && f != null && Math.abs(f - t) >= 3
    ? { en: ` Feels like ${f0(f)}°C (${f > t ? 'muggy' : 'breezy'}).`, vi: ` Cảm giác như ${f0(f)}°C (${f > t ? 'oi bức' : 'mát do gió'}).` } : { en: '', vi: '' };
  const uvNote = u != null && u >= 8 ? { en: ` UV is ${u >= 11 ? 'extreme' : 'very high'}: cover up.`, vi: ` Chỉ số UV ${u >= 11 ? 'cực cao' : 'rất cao'}: cần che chắn.` } : { en: '', vi: '' };
  const storm = cond.thunder ? { en: ' Thunder and lightning possible.', vi: ' Có thể có dông, sét.' } : { en: '', vi: '' };
  const D = {
    'rain-light': ['Light drizzly rain; a light jacket or umbrella is enough.', 'Mưa nhỏ, nhẹ nhàng; mang theo áo mưa hoặc ô là đủ.'],
    'rain-moderate': ['Steady rain; roads get wet and slippery.', 'Mưa vừa, đường ướt và trơn.'],
    'rain-heavy': ['Heavy rain; expect poor visibility and local flooding on low streets.', 'Mưa to, tầm nhìn kém, có thể ngập cục bộ ở đường thấp.'],
    'rain-very-heavy': ['Very heavy rain; avoid travel if you can, flooding is likely.', 'Mưa rất to, hạn chế đi lại, nguy cơ ngập cao.'],
    overcast: ['Grey, overcast sky with no sunshine and no rain.', 'Trời nhiều mây, âm u, không nắng, không mưa.'],
    fog: ['Foggy, reduced visibility.', 'Có sương mù, tầm nhìn hạn chế.'],
    'sun-slight': ['Mild sunshine with some cloud; comfortable outdoors.', 'Nắng nhẹ xen mây, ra ngoài dễ chịu.'],
    'sun-pleasant': ['Bright, comfortable sunshine, not too hot.', 'Nắng đẹp vừa phải, không quá nóng.'],
    'sun-hot': ['Hot and sunny; drink water and limit time in direct sun around midday.', 'Nắng nóng; uống đủ nước, tránh nắng trực tiếp lúc trưa.'],
    'sun-extreme': ['Intense sun and dangerous heat; avoid midday outdoor activity.', 'Nắng gắt, nguy cơ sốc nhiệt; tránh hoạt động ngoài trời giữa trưa.'],
    'night-clear': ['Clear night sky.', 'Đêm quang đãng.'],
    'night-cloudy': ['Cloudy night, no rain expected.', 'Đêm có mây, không mưa.'],
    unknown: ['Weather data is unavailable.', 'Chưa có dữ liệu thời tiết.'],
  }[key] || ['', ''];
  const group = cond.group;
  const extra = group === 'rain' ? [amount, chance, storm] : group === 'sun' ? [feelsNote, uvNote, chance.en && pr >= 30 ? chance : { en: '', vi: '' }]
    : group === 'cloud' || group === 'night' ? [feelsNote, pr != null && pr >= 30 ? chance : { en: '', vi: '' }] : [];
  return { en: D[0] + extra.map(e => e.en).join(''), vi: D[1] + extra.map(e => e.vi).join('') };
}
