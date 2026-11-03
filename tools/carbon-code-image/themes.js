// Colour palettes (own tokens - no external highlight.js theme sheet) and background gradient presets.
// Palette keys: bg fg border + token classes used by highlight.js: kw str com num fn type lit attr tag var prop op, ln (line numbers).

export const THEMES = {
  'one-dark': { label: 'One Dark', dark: true, bg: '#282c34', fg: '#abb2bf', border: 'rgba(255,255,255,.10)', kw: '#c678dd', str: '#98c379', com: '#7f848e', num: '#d19a66', fn: '#61afef', type: '#e5c07b', lit: '#d19a66', attr: '#d19a66', tag: '#e06c75', var: '#e06c75', prop: '#e06c75', op: '#56b6c2', ln: '#5c6370' },
  dracula: { label: 'Dracula', dark: true, bg: '#282a36', fg: '#f8f8f2', border: 'rgba(255,255,255,.10)', kw: '#ff79c6', str: '#f1fa8c', com: '#6c7bb0', num: '#bd93f9', fn: '#50fa7b', type: '#8be9fd', lit: '#bd93f9', attr: '#50fa7b', tag: '#ff79c6', var: '#ffb86c', prop: '#8be9fd', op: '#ff79c6', ln: '#6272a4' },
  monokai: { label: 'Monokai', dark: true, bg: '#272822', fg: '#f8f8f2', border: 'rgba(255,255,255,.10)', kw: '#f92672', str: '#e6db74', com: '#8c8870', num: '#ae81ff', fn: '#a6e22e', type: '#66d9ef', lit: '#ae81ff', attr: '#a6e22e', tag: '#f92672', var: '#fd971f', prop: '#a6e22e', op: '#f92672', ln: '#75715e' },
  nord: { label: 'Nord', dark: true, bg: '#2e3440', fg: '#d8dee9', border: 'rgba(255,255,255,.10)', kw: '#81a1c1', str: '#a3be8c', com: '#7b88a1', num: '#b48ead', fn: '#88c0d0', type: '#8fbcbb', lit: '#81a1c1', attr: '#8fbcbb', tag: '#81a1c1', var: '#d8dee9', prop: '#88c0d0', op: '#81a1c1', ln: '#4c566a' },
  'night-owl': { label: 'Night Owl', dark: true, bg: '#011627', fg: '#d6deeb', border: 'rgba(255,255,255,.12)', kw: '#c792ea', str: '#ecc48d', com: '#637777', num: '#f78c6c', fn: '#82aaff', type: '#ffcb8b', lit: '#ff5874', attr: '#addb67', tag: '#7fdbca', var: '#addb67', prop: '#7fdbca', op: '#c792ea', ln: '#4b6479' },
  'solarized-dark': { label: 'Solarized Dark', dark: true, bg: '#002b36', fg: '#93a1a1', border: 'rgba(255,255,255,.10)', kw: '#859900', str: '#2aa198', com: '#586e75', num: '#d33682', fn: '#268bd2', type: '#b58900', lit: '#cb4b16', attr: '#b58900', tag: '#268bd2', var: '#cb4b16', prop: '#268bd2', op: '#859900', ln: '#586e75' },
  'github-light': { label: 'GitHub Light', dark: false, bg: '#ffffff', fg: '#24292f', border: 'rgba(27,31,36,.15)', kw: '#cf222e', str: '#0a3069', com: '#6e7781', num: '#0550ae', fn: '#8250df', type: '#953800', lit: '#0550ae', attr: '#0550ae', tag: '#116329', var: '#953800', prop: '#0550ae', op: '#24292f', ln: '#8c959f' },
  'solarized-light': { label: 'Solarized Light', dark: false, bg: '#fdf6e3', fg: '#586e75', border: 'rgba(0,0,0,.12)', kw: '#859900', str: '#2aa198', com: '#93a1a1', num: '#d33682', fn: '#268bd2', type: '#b58900', lit: '#cb4b16', attr: '#b58900', tag: '#268bd2', var: '#cb4b16', prop: '#268bd2', op: '#859900', ln: '#93a1a1' },
};

export const TOKEN_CLASSES = ['kw', 'str', 'com', 'num', 'fn', 'type', 'lit', 'attr', 'tag', 'var', 'prop', 'op'];
/** Colour for a token class in a theme (plain text uses the foreground colour). */
export const colorFor = (theme, cls) => (cls === 'plain' ? theme.fg : theme[cls] || theme.fg);

export const GRADIENTS = [
  { id: 'purple-haze', name: 'Purple haze', angle: 135, stops: [['#667eea', 0], ['#764ba2', 1]] },
  { id: 'ocean', name: 'Ocean', angle: 135, stops: [['#4facfe', 0], ['#00f2fe', 1]] },
  { id: 'sunset', name: 'Sunset', angle: 135, stops: [['#fa709a', 0], ['#fee140', 1]] },
  { id: 'candy', name: 'Candy', angle: 135, stops: [['#a18cd1', 0], ['#fbc2eb', 1]] },
  { id: 'forest', name: 'Forest', angle: 135, stops: [['#0ba360', 0], ['#3cba92', 1]] },
  { id: 'fire', name: 'Fire', angle: 135, stops: [['#f12711', 0], ['#f5af19', 1]] },
  { id: 'peach', name: 'Peach', angle: 135, stops: [['#ffecd2', 0], ['#fcb69f', 1]] },
  { id: 'midnight', name: 'Midnight', angle: 135, stops: [['#232526', 0], ['#414345', 1]] },
];

/** CSS value for a gradient preset (used by the preview; the canvas renderer builds the same gradient from the same data). */
export const gradientCss = g => `linear-gradient(${g.angle}deg, ${g.stops.map(([c, p]) => `${c} ${Math.round(p * 100)}%`).join(', ')})`;

/**
 * Start/end points of a CSS linear-gradient line of `angle` degrees over a w x h box
 * (CSS rule: the line passes through the centre and its length is |w sin a| + |h cos a|).
 */
export function gradientLine(w, h, angle) {
  const a = (angle * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy), cx = w / 2, cy = h / 2;
  return { x0: cx - (dx * len) / 2, y0: cy - (dy * len) / 2, x1: cx + (dx * len) / 2, y1: cy + (dy * len) / 2 };
}
