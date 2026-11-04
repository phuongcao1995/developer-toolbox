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
  jsonc: { label: 'JSON with comments (.jsonc)', parser: 'jsonc', ext: 'jsonc', mime: 'application/json', plugins: ['babel', 'estree'] },
  json5: { label: 'JSON5', parser: 'json5', ext: 'json5', mime: 'application/json5', plugins: ['babel', 'estree'] },
  yaml: { label: 'YAML', parser: 'yaml', ext: 'yaml', mime: 'text/yaml', plugins: ['yaml'] },
  graphql: { label: 'GraphQL', parser: 'graphql', ext: 'graphql', mime: 'application/graphql', plugins: ['graphql'] },
  handlebars: { label: 'Handlebars', parser: 'glimmer', ext: 'hbs', mime: 'text/x-handlebars-template', plugins: ['glimmer'] },
  vue: { label: 'Vue', parser: 'vue', ext: 'vue', mime: 'text/x-vue', plugins: ['html', 'babel', 'estree', 'postcss', 'typescript'] },
  markdown: { label: 'Markdown', parser: 'markdown', ext: 'md', mime: 'text/markdown', plugins: ['markdown'] },
};

const EXT_TO_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'vue', json: 'json', jsonc: 'jsonc', json5: 'json5', yaml: 'yaml', yml: 'yaml', graphql: 'graphql', gql: 'graphql', hbs: 'handlebars', handlebars: 'handlebars', md: 'markdown', markdown: 'markdown' };
export const detectLanguageByName = (name = '') => EXT_TO_LANG[String(name).toLowerCase().split('.').pop()] || null;

export const DEFAULT_OPTIONS = {
  tabWidth: 2, useTabs: false, semi: true, singleQuote: false, trailingComma: 'all', printWidth: 80, bracketSpacing: true, arrowParens: 'always',
  quoteProps: 'as-needed', endOfLine: 'lf', proseWrap: 'preserve', bracketSameLine: false, jsxSingleQuote: false,
  htmlWhitespaceSensitivity: 'css', embeddedLanguageFormatting: 'auto',
};
// objectWrap exists only in Prettier 3.5+, so it is intentionally not offered for the pinned 3.3.3.
const ENUMS = {
  trailingComma: ['none', 'es5', 'all'], arrowParens: ['always', 'avoid'], quoteProps: ['as-needed', 'consistent', 'preserve'],
  endOfLine: ['lf', 'crlf', 'cr', 'auto'], proseWrap: ['always', 'never', 'preserve'], htmlWhitespaceSensitivity: ['css', 'strict', 'ignore'],
  embeddedLanguageFormatting: ['auto', 'off'],
};
const BOOLS = ['useTabs', 'semi', 'singleQuote', 'bracketSpacing', 'bracketSameLine', 'jsxSingleQuote'];

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
    arrowParens: pick(raw.arrowParens, ENUMS.arrowParens, d.arrowParens),
    quoteProps: pick(raw.quoteProps, ENUMS.quoteProps, d.quoteProps),
    endOfLine: pick(raw.endOfLine, ENUMS.endOfLine, d.endOfLine),
    proseWrap: pick(raw.proseWrap, ENUMS.proseWrap, d.proseWrap),
    bracketSameLine: !!raw.bracketSameLine,
    jsxSingleQuote: !!raw.jsxSingleQuote,
    htmlWhitespaceSensitivity: pick(raw.htmlWhitespaceSensitivity, ENUMS.htmlWhitespaceSensitivity, d.htmlWhitespaceSensitivity),
    embeddedLanguageFormatting: pick(raw.embeddedLanguageFormatting, ENUMS.embeddedLanguageFormatting, d.embeddedLanguageFormatting),
  };
}

/** Serialize options as .prettierrc JSON (all options, so the file is explicit). */
export const toPrettierrc = options => JSON.stringify(sanitizeOptions(options), null, 2) + '\n';

/**
 * Parse a .prettierrc (JSON) text. Returns { options, ignored[] } where ignored lists keys/values that were not understood.
 * Values that are invalid for a known key are reported and replaced by defaults. Throws Error on invalid JSON / non-objects.
 */
export function parsePrettierrc(text) {
  let obj;
  try { obj = JSON.parse(String(text).replace(/^﻿/, '')); }
  catch (e) { throw new Error(`Not valid JSON (.prettierrc must be JSON here; YAML/TOML/JS configs are not supported): ${e.message}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('A .prettierrc must be a JSON object such as {"semi": false}.');
  const ignored = [];
  const known = new Set(Object.keys(DEFAULT_OPTIONS));
  const merged = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$schema') continue;
    if (k === 'overrides') { ignored.push('overrides (not supported)'); continue; }
    if (!known.has(k)) { ignored.push(`${k} (unknown option)`); continue; }
    const ok = ENUMS[k] ? ENUMS[k].includes(v) : BOOLS.includes(k) ? typeof v === 'boolean' : Number.isFinite(Number(v)) && typeof v !== 'boolean';
    if (!ok) { ignored.push(`${k} (invalid value ${JSON.stringify(v)})`); continue; }
    merged[k] = v;
  }
  return { options: sanitizeOptions(merged), ignored };
}

export const pluginUrl = name => `${CDN_BASE}plugins/${name}.js`;

/**
 * Resolve loaded plugin objects from a global (window.prettierPlugins). Throws an Error naming the missing plugin,
 * the Prettier version and the CDN URL it should have come from.
 */
export function resolvePlugins(names, globalObj) {
  const reg = globalObj?.prettierPlugins || {};
  return names.map(n => {
    if (!reg[n]) {
      throw Object.assign(new Error(`Prettier plugin "${n}" (prettier@${PRETTIER_VERSION}) did not register itself after loading ${pluginUrl(n)}. The script may be blocked or served incorrectly; check the network tab and your content blocker.`), { cdn: true, plugin: n });
    }
    return reg[n];
  });
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
