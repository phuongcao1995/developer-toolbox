// Code Beautifier - pure logic (no DOM). Formatting of HTML/CSS/JS is done by js-beautify in tool.js;
// JSON formatting and all minifiers live here so they can be tested in Node.

export const LANGUAGES = {
  html: { label: 'HTML', ext: 'html', mime: 'text/html' },
  css: { label: 'CSS', ext: 'css', mime: 'text/css' },
  js: { label: 'JavaScript', ext: 'js', mime: 'text/javascript' },
  json: { label: 'JSON', ext: 'json', mime: 'application/json' },
};

/** Guess the language from a file name; returns null when unknown. */
export function detectLanguageByName(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  const map = { html: 'html', htm: 'html', xhtml: 'html', vue: 'html', css: 'css', scss: 'css', less: 'css',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', json: 'json', map: 'json', webmanifest: 'json' };
  return map[ext] || null;
}

/** Cheap content sniffing used when pasting into an empty editor. */
export function detectLanguageByContent(text = '') {
  const t = text.trim();
  if (!t) return null;
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return 'json'; } catch { /* fall through */ } }
  if (/^<!doctype html|^<html|^<(div|body|head|p|span|section|ul|table|form|a|h[1-6])[\s>]/i.test(t)) return 'html';
  if (/^(@import|@media|@charset|:root|[.#]?[\w-]+(\s*[>+~,]\s*[.#]?[\w-]+)*\s*\{[^{}]*:[^{}]*;?\s*\})/i.test(t)) return 'css';
  return 'js';
}

/** Convert the UI indent choice ('2'|'4'|'8'|'tab') into an indent string / back. */
export function indentChoiceFromUnit(unit) {
  if (unit === '\t') return 'tab';
  return ['2', '4', '8'].includes(String(unit?.length)) ? String(unit.length) : '2';
}
export const indentUnitFromChoice = c => (c === 'tab' ? '\t' : ' '.repeat(Number(c) || 2));

/** js-beautify option object for an indent choice. */
export function beautifyOptions(choice, { preserveBlank = true } = {}) {
  return {
    indent_size: choice === 'tab' ? 1 : Number(choice) || 2,
    indent_char: choice === 'tab' ? '\t' : ' ',
    indent_with_tabs: choice === 'tab',
    preserve_newlines: preserveBlank,
    max_preserve_newlines: 2,
    end_with_newline: false,
    wrap_line_length: 0,
  };
}

// ---------- size stats ----------
export const byteLength = s => new TextEncoder().encode(s ?? '').length;
export function sizeStats(before, after) {
  const b = byteLength(before), a = byteLength(after);
  const saved = b - a;
  return { before: b, after: a, saved, percent: b ? (saved / b) * 100 : 0 };
}

// ---------- JSON ----------
/** Turn a JSON.parse error into {message, line, column}. */
export function jsonErrorInfo(err, text) {
  const msg = String(err?.message || err);
  let line = null, column = null;
  let m = /line (\d+) column (\d+)/i.exec(msg);
  if (m) { line = +m[1]; column = +m[2]; }
  else if ((m = /position (\d+)/i.exec(msg))) {
    const pos = Math.min(+m[1], text.length);
    const before = text.slice(0, pos).split('\n');
    line = before.length; column = before[before.length - 1].length + 1;
  }
  return { message: msg, line, column };
}
function assertJson(text) {
  if (!text.trim()) throw new Error('Input is empty.');
  try { JSON.parse(text); } catch (e) {
    const { message, line, column } = jsonErrorInfo(e, text);
    throw new Error(`Invalid JSON: ${message}${line && !/line \d+/i.test(message) ? ` (line ${line}, column ${column})` : ''}`);
  }
}
/** Walk validated JSON text, copying strings verbatim and dropping whitespace elsewhere (keeps number text exact). */
function* jsonTokens(text) {
  let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      yield text.slice(i, j + 1); i = j + 1;
    } else if ('{}[],:'.includes(c)) { yield c; i++; }
    else { let j = i; while (j < n && !/[\s{}[\],:]/.test(text[j])) j++; yield text.slice(i, j); i = j; }
  }
}
export function minifyJson(text) {
  assertJson(text);
  return [...jsonTokens(text)].join('');
}
export function formatJson(text, indentUnit = '  ') {
  assertJson(text);
  const toks = [...jsonTokens(text)];
  let out = '', depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k], next = toks[k + 1];
    if (t === '{' || t === '[') {
      if (next === (t === '{' ? '}' : ']')) { out += t + next; k++; continue; } // empty container
      depth++; out += t + '\n' + indentUnit.repeat(depth);
    } else if (t === '}' || t === ']') { depth--; out += '\n' + indentUnit.repeat(depth) + t; }
    else if (t === ',') out += ',\n' + indentUnit.repeat(depth);
    else if (t === ':') out += ': ';
    else out += t;
  }
  return out;
}

// ---------- CSS ----------
/**
 * Removes comments (except /*! banners), collapses whitespace and strips it around structural characters.
 * Strings and unquoted url(...) contents are copied verbatim. Spaces inside parentheses are kept around operators
 * so calc(1px + 2px) stays valid.
 */
export function minifyCss(src) {
  const out = [];
  let i = 0, depth = 0, pendingSpace = false;
  const n = src.length;
  const last = () => (out.length ? out[out.length - 1].slice(-1) : '');
  const push = text => {
    if (pendingSpace && out.length) {
      const prev = last(), c = text[0];
      // Inside (...) only trim around ( ) , :  - outside also around combinators and block punctuation.
      const drop = depth > 0
        ? '(,:'.includes(prev) || c === ')' || c === ','
        : '{};,:>~+'.includes(prev) || '{};,>~+'.includes(c);
      if (!drop) out.push(' ');
    }
    pendingSpace = false;
    if (text === '}' && last() === ';') { // the last semicolon of a block is optional
      out[out.length - 1] = out[out.length - 1].slice(0, -1);
      if (!out[out.length - 1]) out.pop();
    }
    out.push(text);
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment in CSS.');
      if (src[i + 2] === '!') push(src.slice(i, end + 2)); // keep license banners
      else pendingSpace = true; // a comment still separates tokens
      i = end + 2; continue;
    }
    if (/\s/.test(c)) { pendingSpace = true; i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; else if (src[j] === '\n') break; j++; }
      if (src[j] !== c) throw new Error('Unterminated string in CSS.');
      push(src.slice(i, j + 1)); i = j + 1; continue;
    }
    if ((c === 'u' || c === 'U') && /^url\(\s*[^"'\s]/i.test(src.slice(i, i + 40))) {
      const end = src.indexOf(')', i);
      if (end < 0) throw new Error('Unterminated url( in CSS.');
      push('url(' + src.slice(i + 4, end).trim() + ')'); i = end + 1; continue;
    }
    push(c); i++;
    if (c === '(') depth++; // adjust after pushing so the space rules for ")" still see the inner depth
    else if (c === ')') depth = Math.max(0, depth - 1);
  }
  return out.join('').trim();
}

// ---------- JavaScript ----------
const ID_CHAR = /[A-Za-z0-9_$#\\\u0080-￿]/;
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// Multi-character punctuators (longest first) so ">>>=" is not split and "++" is recognised.
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
// After these punctuators a line break is significant for ASI (or ambiguous) so it is kept.
const NEWLINE_SENSITIVE_PUNCT = new Set([')', ']', '}', '++', '--']);

function skipString(src, i) { // returns index after the closing quote
  const q = src[i]; let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j++;
    else if (src[j] === '\n') break;
    j++;
  }
  if (src[j] !== q) throw new Error(`Unterminated string literal at position ${i}.`);
  return j + 1;
}
function skipTemplate(src, i) { // i at the opening backtick; handles nested ${ ... } incl. strings/templates
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && src[j + 1] === '{') {
      j += 2; let depth = 1;
      while (j < src.length && depth > 0) {
        const d = src[j];
        if (d === '"' || d === "'") j = skipString(src, j);
        else if (d === '`') j = skipTemplate(src, j);
        else { if (d === '{') depth++; else if (d === '}') depth--; j++; }
      }
      continue;
    }
    j++;
  }
  throw new Error(`Unterminated template literal at position ${i}.`);
}
function skipRegex(src, i) {
  let j = i + 1, inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n') break;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true; else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; while (/[A-Za-z]/.test(src[j] || '')) j++; return j; }
    j++;
  }
  throw new Error(`Unterminated regular expression at position ${i}.`);
}

/**
 * Conservative JS minifier: removes comments and redundant whitespace only (no renaming/mangling).
 * Tokenises strings, template literals and regex literals (regex-vs-division is decided heuristically from the
 * previous token). Newlines are kept wherever dropping them could change automatic semicolon insertion.
 */
export function minifyJs(src) {
  let out = '', i = 0;
  const n = src.length;
  if (src.startsWith('#!')) { const e = src.indexOf('\n'); out = (e < 0 ? src : src.slice(0, e)) + '\n'; i = e < 0 ? n : e + 1; }
  let prev = null; // last emitted significant token {text, type}
  let sawNl = false;
  const emit = (text, type) => {
    if (prev) {
      const a = prev.text.slice(-1), b = text[0];
      const needSpace = (ID_CHAR.test(a) && ID_CHAR.test(b)) || (a === '+' && b === '+') || (a === '-' && b === '-')
        || (a === '/' && (b === '/' || b === '*')) || (prev.type === 'num' && b === '.');
      // A line break is safe to drop after an operator/opening bracket/separator, or before a closing one.
      const dropNl = (prev.type === 'punct' && !NEWLINE_SENSITIVE_PUNCT.has(prev.text)) || [')', ']', '}', ';', ','].includes(text);
      if (sawNl && !dropNl) out += '\n';
      else if (needSpace) out += ' ';
    }
    out += text; prev = { text, type }; sawNl = false;
  };
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.type === 'punct') return !NEWLINE_SENSITIVE_PUNCT.has(prev.text) || prev.text === '}';
    if (prev.type === 'ident') return REGEX_AFTER_KEYWORD.has(prev.text);
    return false;
  };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (/\s/.test(c)) { if (c === '\n' || c === '\r' || c === ' ' || c === ' ') sawNl = true; i++; continue; }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment.');
      if (/[\n\r]/.test(src.slice(i, end))) sawNl = true;
      i = end + 2; continue;
    }
    if (c === '"' || c === "'") { const e = skipString(src, i); emit(src.slice(i, e), 'str'); i = e; continue; }
    if (c === '`') { const e = skipTemplate(src, i); emit(src.slice(i, e), 'tpl'); i = e; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(c2 || ''))) {
      let j = i; const hex = /^0[xXbBoO]/.test(src.slice(i, i + 2));
      while (j < n && (/[0-9A-Za-z_.]/.test(src[j]) || (!hex && /[eE]/.test(src[j - 1]) && /[+-]/.test(src[j])))) j++;
      emit(src.slice(i, j), 'num'); i = j; continue;
    }
    if (ID_CHAR.test(c)) {
      let j = i; while (j < n && ID_CHAR.test(src[j])) j++;
      emit(src.slice(i, j), 'ident'); i = j; continue;
    }
    if (c === '/' && regexAllowed()) { const e = skipRegex(src, i); emit(src.slice(i, e), 'regex'); i = e; continue; }
    const p = PUNCT.find(op => src.startsWith(op, i)) || c;
    emit(p, 'punct'); i += p.length;
  }
  return out;
}

// ---------- HTML ----------
const RAW_TAGS = new Set(['pre', 'textarea', 'script', 'style']);

/** Collapse whitespace between attributes of one tag, leaving quoted values untouched. */
function compactTag(tag) {
  let out = '', quote = '', ws = false;
  for (const ch of tag) {
    if (quote) { out += ch; if (ch === quote) quote = ''; continue; }
    if (/\s/.test(ch)) { ws = true; continue; }
    if (ws && ch !== '>') out += ' ';
    ws = false;
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out.replace(/\s+\/>$/, '/>');
}

/**
 * HTML minifier: removes comments (keeps IE conditional comments), collapses whitespace and removes whitespace-only
 * gaps between tags that contain a line break. <pre>/<textarea> are untouched; <script>/<style> bodies are
 * minified with the JS/CSS minifiers when that succeeds, otherwise left as they are.
 */
export function minifyHtml(src) {
  let out = '', i = 0, buf = '';
  const n = src.length;
  const flushText = () => {
    if (!buf) return;
    if (/^\s+$/.test(buf)) { if (!/[\r\n]/.test(buf) && out) out += ' '; }
    else out += buf.replace(/\s+/g, ' ');
    buf = '';
  };
  while (i < n) {
    const c = src[i];
    if (c !== '<') { buf += c; i++; continue; }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      const comment = src.slice(i, stop);
      if (/^<!--\[if|^<!--<!\[endif/i.test(comment)) { flushText(); out += comment; }
      i = stop; continue;
    }
    const m = /^<(\/?)([a-zA-Z][^\s/>]*|!|\?)/.exec(src.slice(i, i + 64));
    if (!m) { buf += c; i++; continue; } // a lone '<' in text
    // find the end of the tag, respecting quoted attribute values
    let j = i + 1, q = '';
    while (j < n) {
      const d = src[j];
      if (q) { if (d === q) q = ''; } else if (d === '"' || d === "'") q = d; else if (d === '>') break;
      j++;
    }
    const tag = src.slice(i, j + 1);
    flushText();
    out += (m[2] === '!' || m[2] === '?') ? tag : compactTag(tag);
    i = j + 1;
    const name = m[2].toLowerCase();
    if (!m[1] && RAW_TAGS.has(name) && !/\/>$/.test(tag)) {
      const rest = src.slice(i), cm = new RegExp(`</${name}\\s*>`, 'i').exec(rest);
      const body = cm ? rest.slice(0, cm.index) : rest;
      out += rawBody(name, body, tag);
      i += body.length;
    }
  }
  flushText();
  return out.trim();
}
function rawBody(name, body, openTag) {
  if (name === 'style') { try { return minifyCss(body); } catch { return body; } }
  if (name === 'script') {
    const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(openTag)?.[1]?.toLowerCase();
    if (!type || /javascript|ecmascript|module/.test(type)) { try { return minifyJs(body); } catch { return body; } }
    if (/json/.test(type)) { try { return minifyJson(body); } catch { return body; } }
  }
  return body;
}

/** Single entry point for tool.js and tests. */
export function minify(lang, code) {
  if (!code.trim()) throw new Error('Input is empty.');
  switch (lang) {
    case 'css': return minifyCss(code);
    case 'js': return minifyJs(code);
    case 'html': return minifyHtml(code);
    case 'json': return minifyJson(code);
    default: throw new Error(`Minify is not supported for ${lang}.`);
  }
}
