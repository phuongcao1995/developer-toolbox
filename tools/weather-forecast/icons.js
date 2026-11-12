// Multi-colour weather icons as inline SVG (24x24 grid). Colours come from CSS variables so they follow light/dark themes.
const NS = 'http://www.w3.org/2000/svg';

const SUN_RAYS = '<g class="wi-rays" stroke="var(--wi-sun)" stroke-width="1.8" stroke-linecap="round"><path d="M12 1.5v2.2M12 20.3v2.2M1.5 12h2.2M20.3 12h2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></g>';
const sun = (x = 12, y = 12, r = 4.6, rays = true) => `${rays ? SUN_RAYS : ''}<circle cx="${x}" cy="${y}" r="${r}" fill="var(--wi-sun)"/>`;
const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="var(--wi-moon)"/>';
const CLOUD = (fill = 'var(--wi-cloud)', dy = 0) =>
  `<path transform="translate(0 ${dy})" d="M7 19.5a4.2 4.2 0 0 1-.5-8.37 5.6 5.6 0 0 1 10.8 1.07A3.65 3.65 0 0 1 17 19.5Z" fill="${fill}"/>`;
const drops = (n, color = 'var(--wi-rain)') => ({
  1: `<g stroke="${color}" stroke-width="1.8" stroke-linecap="round"><path d="M9 20.6l.7-1.6M13 20.6l.7-1.6M17 20.6l.7-1.6"/></g>`,
  2: `<g stroke="${color}" stroke-width="1.9" stroke-linecap="round"><path d="M8.5 21l1-2.6M12.5 22l1-2.6M16.5 21l1-2.6"/></g>`,
}[n]);
const snow = '<g fill="var(--wi-snow)"><circle cx="9" cy="20.6" r="1.1"/><circle cx="13" cy="21.8" r="1.1"/><circle cx="17" cy="20.6" r="1.1"/></g>';
const bolt = '<path d="M12.8 14.2l-2.6 4h2.3l-1 3.6 3.9-5.1h-2.4l1.1-2.5Z" fill="var(--wi-sun)"/>';
const fog = '<g stroke="var(--wi-fog)" stroke-width="1.8" stroke-linecap="round"><path d="M6 20h12M8 22.2h8"/></g>';

const SHAPES = {
  sun: sun(),
  moon: MOON + '<circle cx="18.5" cy="5.5" r=".9" fill="var(--wi-moon)"/><circle cx="21" cy="9" r=".6" fill="var(--wi-moon)"/>',
  'cloud-sun': `${sun(8.5, 8.5, 3.6, false)}<g stroke="var(--wi-sun)" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 1.8v1.4M1.8 8.5h1.4M3.8 3.8l1 1M13.2 3.8l-1 1"/></g>${CLOUD()}`,
  'cloud-moon': `<path d="M13.5 9.2A4.6 4.6 0 0 1 7.2 3a4.6 4.6 0 1 0 6.3 6.2Z" fill="var(--wi-moon)"/>${CLOUD()}`,
  cloud: `<path d="M7.5 18.5a3.6 3.6 0 0 1-.3-7.2 5 5 0 0 1 9.6.7 3.3 3.3 0 0 1-.1 6.5Z" fill="var(--wi-cloud)"/>`,
  'cloud-fog': CLOUD('var(--wi-cloud)', -3) + fog,
  'cloud-drizzle': CLOUD('var(--wi-cloud)', -3) + drops(1),
  'cloud-rain': CLOUD('var(--wi-cloud-dark)', -3) + drops(2),
  'cloud-snow': CLOUD('var(--wi-cloud)', -3) + snow,
  'cloud-lightning': CLOUD('var(--wi-cloud-dark)', -3) + bolt,
};

/** Returns an <svg> element for a weather icon name from logic.js (WEATHER_ICONS); unknown names fall back to a cloud. */
export function weatherSvg(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `wi wi-${SHAPES[name] ? name : 'cloud'}`);
  svg.innerHTML = SHAPES[name] || SHAPES.cloud;
  return svg;
}
