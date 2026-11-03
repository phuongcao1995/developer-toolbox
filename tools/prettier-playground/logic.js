// Prettier Playground - pure logic (no DOM). Prettier itself is loaded from a CDN by tool.js.

export const PRETTIER_VERSION = '3.3.3';
export const CDN_BASE = `https://cdn.jsdelivr.net/npm/prettier@${PRETTIER_VERSION}/`;

/**
 * Language table. `plugins` lists the files under /plugins/ that must be loaded for the parser to work
 * (babel and typescript parsers need the estree printer; html embeds JS/CSS so it also gets those).
 */
export const LANGUAGES = {
  javascript: { label: 'JavaScript', parser: 'babel', ext: 'js', mime: 'text/javascript', plugins: ['babel', 'estree'] },
  jsx: { label: 'JSX', parser: 'babel', ext: 'jsx', mime: 'text/javascript', plugins: ['babel', 'estree'] },
  typescript: { label: 'TypeScript', parser: 'typescript', ext: 'ts', mime: 'text/typescript', plugins: ['typescript', 'estree'] },
  tsx: { label: 'TSX', parser: 'typescript', ext: 'tsx', mime: 'text/typescript', plugins: ['typescript', 'estree'] },
  css: { label: 'CSS', parser: 'css', ext: 'css', mime: 'text/css', plugins: ['postcss'] },
  scss: { label: 'SCSS', parser: 'scss', ext: 'scss', mime: 'text/x-scss', plugins: ['postcss'] },
  less: { label: 'Less', parser: 'less', ext: 'less', mime: 'text/x-less', plugins: ['postcss'] },
  html: { label: 'HTML', parser: 'html', ext: 'html', mime: 'text/html', plugins: ['html', 'babel', 'estree', 'postcss'] },
  json: { label: 'JSON', parser: 'json', ext: 'json', mime: 'application/json', plugins: ['babel', 'estree'] },
  markdown: { label: 'Markdown', parser: 'markdown', ext: 'md', mime: 'text/markdown', plugins: ['markdown'] },
};

const EXT_TO_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown' };
export const detectLanguageByName = (name = '') => EXT_TO_LANG[String(name).toLowerCase().split('.').pop()] || null;

export const DEFAULT_OPTIONS = {
  tabWidth: 2, useTabs: false, semi: true, singleQuote: false, trailingComma: 'all', printWidth: 80, bracketSpacing: true, arrowParens: 'always',
};

/** Starting options derived from the user's global indentation setting. */
export function defaultsFromIndent(unit) {
  const o = { ...DEFAULT_OPTIONS };
  if (unit === '\t') o.useTabs = true; else if (unit && unit.length === 4) o.tabWidth = 4; else if (unit && unit.length === 8) o.tabWidth = 8;
  return o;
}

/** Validate/clamp untrusted option values (from storage or the form) into a clean Prettier option object. */
export function sanitizeOptions(raw = {}) {
  const d = DEFAULT_OPTIONS;
  const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
  return {
    tabWidth: int(raw.tabWidth, 1, 16, d.tabWidth),
    useTabs: !!raw.useTabs,
    semi: raw.semi !== false,
    singleQuote: !!raw.singleQuote,
    trailingComma: pick(raw.trailingComma, ['none', 'es5', 'all'], d.trailingComma),
    printWidth: int(raw.printWidth, 20, 400, d.printWidth),
    bracketSpacing: raw.bracketSpacing !== false,
    arrowParens: pick(raw.arrowParens, ['always', 'avoid'], d.arrowParens),
  };
}

/** Full argument for prettier.format(code, ...). `plugins` are the loaded plugin objects. */
export function buildFormatOptions(langId, rawOptions, plugins) {
  const lang = LANGUAGES[langId];
  if (!lang) throw new Error(`Unknown language: ${langId}`);
  return { parser: lang.parser, plugins, ...sanitizeOptions(rawOptions) };
}

/** Extract {message, line, column, frame} from a Prettier syntax error (message has an ANSI-free code frame appended). */
export function parseError(err) {
  const raw = String(err?.message || err);
  const clean = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const loc = err?.loc?.start || err?.loc || null;
  let line = loc?.line ?? null, column = loc?.column ?? null;
  if (line == null) { const m = /\((\d+):(\d+)\)/.exec(clean) || /line (\d+),? column (\d+)/i.exec(clean); if (m) { line = +m[1]; column = +m[2]; } }
  const [first, ...restLines] = clean.split('\n');
  const message = first.replace(/\s*\(\d+:\d+\)\s*$/, '').trim();
  const frame = restLines.join('\n').trim();
  return { message, line, column, frame };
}
export function describeError(err) {
  const { message, line, column, frame } = parseError(err);
  return `${line != null ? `Line ${line}, column ${column == null ? '?' : column}: ` : ''}${message}${frame ? `\n\n${frame}` : ''}`;
}
