// Pure, DOM-free logic behind the shared editor component (editor.js) and the splitter (split.js).
// Everything here works on plain strings/numbers so it can be unit-tested in Node (tests/unit/editor-core.test.mjs).
//
// An "edit" is { from, to, text, selStart, selEnd }: replace value.slice(from, to) with `text`, then select
// [selStart, selEnd] in the NEW document. editor.js applies edits with execCommand('insertText') so native undo works.

export const LIMITS = {
  uploadBytes: 5 * 1024 * 1024,   // default upload / drop size cap
  gutterChars: 2 * 1024 * 1024,   // above this (or gutterLines) gutter, line highlight and highlighting are switched off
  gutterLines: 200000,
  highlightWrapChars: 120000,     // wrapped text cannot be windowed, so the whole layer is rendered: keep it small
  findCap: 10000,                 // stop counting matches here ("10,000+")
  fontMin: 10, fontMax: 24,
};

export const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
export const clampFontSize = (v, lo = LIMITS.fontMin, hi = LIMITS.fontMax) => Math.round(clamp(Number(v), lo, hi));

// ---------------------------------------------------------------- lines
/** Number of lines (a trailing newline starts a new, empty line). */
export function countLines(text) {
  let n = 1, i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}
/** Offsets at which each line starts (Uint32Array, length === countLines). */
export function lineStarts(text) {
  const a = new Uint32Array(countLines(text));
  let k = 1, i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) a[k++] = i + 1;
  return a;
}
/** 0-based line containing offset `pos`, given lineStarts(). */
export function lineIndexAt(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}
/** 0-based line of `pos` without a lineStarts table (counts newlines before pos). */
export function lineOfOffset(text, pos) {
  let n = 0, i = -1;
  const end = Math.min(pos, text.length);
  while ((i = text.indexOf('\n', i + 1)) !== -1 && i < end) n++;
  return n;
}
export const lineStartOf = (value, pos) => (pos <= 0 ? 0 : value.lastIndexOf('\n', pos - 1) + 1);
/** [from, to] covering every line touched by the selection [s, e]; a selection ending at a line start excludes that line. */
export function lineBounds(value, s, e) {
  const from = lineStartOf(value, s);
  const end = e > s && value[e - 1] === '\n' ? e - 1 : e;
  let to = value.indexOf('\n', end);
  if (to === -1) to = value.length;
  return [from, to];
}
/** Selection range for line number `line` (0-based), including its newline when there is one. Null if out of range. */
export function lineSelection(value, line) {
  if (line < 0) return null;
  let start = 0;
  for (let k = 0; k < line; k++) { const i = value.indexOf('\n', start); if (i === -1) return null; start = i + 1; }
  const nl = value.indexOf('\n', start);
  return { start, end: nl === -1 ? value.length : nl + 1 };
}
/** Gutter text for 0-based half-open line range [from, to): "from+1\n...\nto". */
export function gutterText(from, to) {
  if (to <= from) return '';
  const parts = new Array(to - from);
  for (let i = from; i < to; i++) parts[i - from] = i + 1;
  return parts.join('\n');
}
export const gutterDigits = lineCount => String(Math.max(1, lineCount)).length;
/** Which lines to render: the visible ones plus a buffer. Half-open, clamped. */
export function computeWindow({ scrollTop, viewHeight, lineHeight, padTop = 0, lineCount, buffer = 40 }) {
  const lh = Math.max(1, lineHeight);
  const vis0 = clamp(Math.floor((scrollTop - padTop) / lh), 0, Math.max(0, lineCount - 1));
  const vis1 = clamp(Math.ceil((scrollTop + viewHeight - padTop) / lh), vis0 + 1, lineCount);
  return { start: Math.max(0, vis0 - buffer), end: Math.min(lineCount, vis1 + buffer), vis0, vis1 };
}
export const windowCovers = (win, vis0, vis1) => !!win && vis0 >= win.start && vis1 <= win.end;
/** Does this text exceed the limits above which gutter / highlight are disabled? */
export const overGutterLimit = (length, lines) => length > LIMITS.gutterChars || lines > LIMITS.gutterLines;

// ---------------------------------------------------------------- generic edit building
/** Map offset `p` (old document) through ascending, non-overlapping changes [{at, del, ins}]. assoc<0: stay before an insertion at p. */
export function mapPos(changes, p, assoc = 1) {
  let shift = 0;
  for (const c of changes) {
    const end = c.at + c.del;
    if (p < c.at || (p === c.at && c.del === 0 && assoc < 0)) break;
    if (p >= end) { shift += c.ins.length - c.del; continue; }
    return c.at + shift + c.ins.length; // inside a replaced range: collapse after the replacement
  }
  return p + shift;
}
function applyChanges(value, from, to, changes) {
  let out = '', cur = from;
  for (const c of changes) { out += value.slice(cur, c.at) + c.ins; cur = c.at + c.del; }
  return out + value.slice(cur, to);
}
function makeEdit(value, from, to, changes, s, e) {
  return { from, to, text: applyChanges(value, from, to, changes), selStart: mapPos(changes, s, s === e ? 1 : -1), selEnd: mapPos(changes, e, 1) };
}
/** Shrink an edit to the part that really differs (common prefix/suffix removed); selection fields are untouched. */
export function trimEdit(value, ed) {
  const old = value.slice(ed.from, ed.to), nw = ed.text;
  let p = 0;
  const max = Math.min(old.length, nw.length);
  while (p < max && old.charCodeAt(p) === nw.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && old.charCodeAt(old.length - 1 - q) === nw.charCodeAt(nw.length - 1 - q)) q++;
  // never split a surrogate pair
  const isHi = c => c >= 0xd800 && c <= 0xdbff, isLo = c => c >= 0xdc00 && c <= 0xdfff;
  if (p > 0 && isHi(nw.charCodeAt(p - 1))) p--;
  if (q > 0 && isLo(nw.charCodeAt(nw.length - q))) q--;
  return { ...ed, from: ed.from + p, to: ed.to - q, text: nw.slice(p, nw.length - q) };
}
export const applyEditToString = (value, ed) => value.slice(0, ed.from) + ed.text + value.slice(ed.to);

const isBlankLine = l => l === '' || l === '\r' || /^[ \t]*\r?$/.test(l);
/** Calls fn(lineStart, lineEnd, text) for each line in [from, to]. */
function eachLine(value, from, to, fn) {
  let pos = from;
  for (;;) {
    let le = value.indexOf('\n', pos);
    if (le === -1 || le > to) le = to;
    fn(pos, le, value.slice(pos, le));
    if (le >= to) break;
    pos = le + 1;
  }
}

// ---------------------------------------------------------------- indent / outdent
/** Indent every non-blank line touched by [s, e]. Null when there is nothing to indent. */
export function indentEdit(value, s, e, unit = '  ') {
  const [from, to] = lineBounds(value, s, e), changes = [];
  eachLine(value, from, to, (ls, _le, l) => { if (!isBlankLine(l)) changes.push({ at: ls, del: 0, ins: unit }); });
  return changes.length ? makeEdit(value, from, to, changes, s, e) : null;
}
/** Remove one indent level (a tab, or up to unit-width spaces) from each line touched by [s, e]. Null when nothing to remove. */
export function outdentEdit(value, s, e, unit = '  ') {
  const [from, to] = lineBounds(value, s, e), changes = [];
  const width = unit === '\t' ? 4 : Math.max(1, unit.length);
  eachLine(value, from, to, (ls, _le, l) => {
    if (l[0] === '\t') { changes.push({ at: ls, del: 1, ins: '' }); return; }
    let k = 0;
    while (k < width && l[k] === ' ') k++;
    if (k) changes.push({ at: ls, del: k, ins: '' });
  });
  return changes.length ? makeEdit(value, from, to, changes, s, e) : null;
}
/** Tab / Shift+Tab. Caret: insert one unit; selection: indent its lines. Shift: outdent. Null = nothing to do. */
export function tabEdit(value, s, e, { shift = false, unit = '  ' } = {}) {
  if (shift) return outdentEdit(value, s, e, unit);
  if (s === e) return { from: s, to: e, text: unit, selStart: s + unit.length, selEnd: s + unit.length };
  return indentEdit(value, s, e, unit) || { from: s, to: e, text: unit, selStart: s + unit.length, selEnd: s + unit.length };
}

// ---------------------------------------------------------------- Enter: auto-indent
const CLOSER_OF = { '{': '}', '[': ']', '(': ')' };
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
/**
 * Enter at [s, e]. Keeps the current line's indentation, adds one level after { [ ( (and ':' with opts.colon, and an
 * opening tag with opts.tags) and splits an empty pair `{|}` / `<div>|</div>` into three lines. Null = let the browser handle it.
 */
export function enterEdit(value, s, e, { unit = '  ', colon = false, tags = false, eol = '\n' } = {}) {
  const ls = lineStartOf(value, s);
  const before = value.slice(ls, s);
  const indent = /^[ \t]*/.exec(before)[0];
  const trimmed = before.trimEnd();
  const last = trimmed.slice(-1);
  let extra = '', split = false;
  if (last && CLOSER_OF[last]) { extra = unit; split = value[e] === CLOSER_OF[last]; }
  else if (colon && last === ':') extra = unit;
  else if (tags && last === '>' && !trimmed.endsWith('/>')) {
    const m = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>$/.exec(trimmed);
    if (m && !VOID_TAGS.has(m[1].toLowerCase())) { extra = unit; split = value.startsWith(`</${m[1]}`, e); }
  }
  if (!extra && !indent) return null;
  let text = eol + indent + extra;
  const caret = s + text.length;
  if (split) text += eol + indent;
  return { from: s, to: e, text, selStart: caret, selEnd: caret };
}

// ---------------------------------------------------------------- auto-close brackets / quotes
export const DEFAULT_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const AFTER_OK = /[\s)\]}>,;:.]/;
/**
 * Key typed with caret/selection [s, e]. Returns an edit (wrap selection, insert a pair, or type over a closer with
 * caretOnly:true) or null to let the browser insert the key normally.
 */
export function autoCloseEdit(value, s, e, key, pairs = DEFAULT_PAIRS) {
  const close = pairs[key];
  const isCloser = Object.values(pairs).includes(key);
  if (s !== e) {
    if (!close) return null;
    const text = key + value.slice(s, e) + close;
    return { from: s, to: e, text, selStart: s + 1, selEnd: e + 1 };
  }
  const next = value[s], prev = s > 0 ? value[s - 1] : '';
  if (isCloser && next === key) return { from: s, to: s, text: '', selStart: s + 1, selEnd: s + 1, caretOnly: true };
  if (!close) return null;
  const quote = close === key;
  if (quote && (/[\w$\\]/.test(prev) || prev === key)) return null;
  if (next !== undefined && next !== '' && !AFTER_OK.test(next)) return null;
  return { from: s, to: s, text: key + close, selStart: s + 1, selEnd: s + 1 };
}
/** Backspace with the caret between an empty pair `(|)` removes both characters. */
export function autoCloseBackspace(value, s, e, pairs = DEFAULT_PAIRS) {
  if (s !== e || s < 1) return null;
  const open = value[s - 1];
  if (pairs[open] === undefined || pairs[open] !== value[s]) return null;
  return { from: s - 1, to: s + 1, text: '', selStart: s - 1, selEnd: s - 1 };
}

// ---------------------------------------------------------------- comments
const LANG_CONFIG = {
  json: { comment: null, autoClose: true, highlighter: 'json' },
  jsonc: { comment: { line: '//' }, autoClose: true, highlighter: 'json' },
  javascript: { comment: { line: '//' }, autoClose: true, highlighter: 'javascript' },
  typescript: { comment: { line: '//' }, autoClose: true, highlighter: 'javascript' },
  css: { comment: { block: ['/*', '*/'] }, autoClose: true, highlighter: 'css' },
  scss: { comment: { line: '//' }, autoClose: true, highlighter: 'css' },
  less: { comment: { line: '//' }, autoClose: true, highlighter: 'css' },
  html: { comment: { block: ['<!--', '-->'] }, autoClose: false, tags: true, highlighter: 'html' },
  xml: { comment: { block: ['<!--', '-->'] }, autoClose: false, tags: true, highlighter: 'html' },
  markdown: { comment: { block: ['<!--', '-->'] }, autoClose: false },
  yaml: { comment: { line: '#' }, autoClose: false, colon: true },
  python: { comment: { line: '#' }, autoClose: true, colon: true },
  sql: { comment: { line: '--' }, autoClose: true },
  shell: { comment: { line: '#' }, autoClose: true },
  graphql: { comment: { line: '#' }, autoClose: true },
  plain: { comment: null, autoClose: false },
};
const LANG_ALIASES = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', babel: 'javascript', ts: 'typescript', tsx: 'typescript', htm: 'html', vue: 'html',
  svg: 'xml', yml: 'yaml', md: 'markdown', py: 'python', sh: 'shell', bash: 'shell', gql: 'graphql', text: 'plain', txt: 'plain', 'json5': 'jsonc' };
/** Normalised language config { name, comment, autoClose, colon, tags, highlighter } (unknown -> plain). */
export function languageConfig(language) {
  const key = String(language || 'plain').toLowerCase();
  const name = LANG_CONFIG[key] ? key : (LANG_ALIASES[key] || 'plain');
  return { name, comment: null, autoClose: false, colon: false, tags: false, highlighter: null, ...LANG_CONFIG[name] };
}
export const commentTokens = language => languageConfig(language).comment;

/**
 * Toggle line comments on the lines touched by [s, e]. `tok` is {line:'//'} or {block:['/*','*\/']}.
 * If every non-blank line is commented they are uncommented, otherwise all are commented at the shallowest indent.
 */
export function toggleCommentEdit(value, s, e, tok) {
  if (!tok || (!tok.line && !tok.block)) return null;
  const [from, to] = lineBounds(value, s, e);
  const lines = [];
  eachLine(value, from, to, (ls, le, l) => { if (!isBlankLine(l)) lines.push({ ls, le, l }); });
  if (!lines.length) return null;
  const [open, close] = tok.line ? [tok.line, ''] : tok.block;
  const indentOf = l => /^[ \t]*/.exec(l)[0].length;
  const contentEnd = l => l.replace(/[ \t\r]+$/, '').length;
  const isCommented = l => {
    const body = l.slice(indentOf(l), contentEnd(l));
    return body.startsWith(open) && (!close || (body.length >= open.length + close.length && body.endsWith(close)));
  };
  const changes = [];
  if (lines.every(x => isCommented(x.l))) {
    for (const { ls, l } of lines) {
      const a = indentOf(l);
      changes.push({ at: ls + a, del: open.length + (l[a + open.length] === ' ' ? 1 : 0), ins: '' });
      if (close) {
        const end = contentEnd(l), body = l.slice(0, end);
        const hasSpace = body.length - close.length - 1 >= a + open.length && body[body.length - close.length - 1] === ' ';
        const cl = close.length + (hasSpace ? 1 : 0);
        changes.push({ at: ls + end - cl, del: cl, ins: '' });
      }
    }
  } else {
    const col = Math.min(...lines.map(x => indentOf(x.l)));
    for (const { ls, l } of lines) {
      changes.push({ at: ls + col, del: 0, ins: open + ' ' });
      if (close) changes.push({ at: ls + contentEnd(l), del: 0, ins: ' ' + close });
    }
  }
  return makeEdit(value, from, to, changes, s, e);
}

// ---------------------------------------------------------------- line operations
const eolOf = value => (value.includes('\r\n') ? '\r\n' : '\n');
const crEnd = (value, to) => (to > 0 && value[to - 1] === '\r' ? to - 1 : to);
const stripCr = l => (l.endsWith('\r') ? l.slice(0, -1) : l);
/** Duplicate the lines touched by [s, e] below themselves; the selection moves to the copy. */
export function duplicateLineEdit(value, s, e) {
  const [from, to] = lineBounds(value, s, e);
  const eol = eolOf(value), body = stripCr(value.slice(from, to));
  const at = from + body.length; // insert before the original line break (and before its CR)
  const shift = body.length + eol.length;
  return { from: at, to: at, text: eol + body, selStart: s + shift, selEnd: e + shift };
}
/** Move the lines touched by [s, e] up (dir -1) or down (+1). Null at the document edge. */
export function moveLinesEdit(value, s, e, dir) {
  const [from, to] = lineBounds(value, s, e);
  const eol = eolOf(value);
  const block = stripCr(value.slice(from, to));
  if (dir < 0) {
    if (from === 0) return null;
    const pStart = lineStartOf(value, from - 1);
    const prev = stripCr(value.slice(pStart, from - 1));
    const delta = pStart - from;
    return { from: pStart, to: crEnd(value, to), text: block + eol + prev, selStart: s + delta, selEnd: e + delta };
  }
  if (to >= value.length) return null;
  let nEnd = value.indexOf('\n', to + 1);
  if (nEnd === -1) nEnd = value.length;
  const next = stripCr(value.slice(to + 1, nEnd));
  const delta = next.length + eol.length;
  return { from, to: crEnd(value, nEnd), text: next + eol + block, selStart: s + delta, selEnd: e + delta };
}
/** Delete the lines touched by [s, e] (with one line break). */
export function deleteLineEdit(value, s, e) {
  let [from, to] = lineBounds(value, s, e);
  if (to < value.length) to += 1; // swallow the line break after the block
  else if (from > 0) from -= 1;   // last line: swallow the one before instead
  const caret = Math.min(from, Math.max(0, value.length - (to - from)));
  return { from, to, text: '', selStart: caret, selEnd: caret };
}

// ---------------------------------------------------------------- find & replace
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const cleanRegexError = err => String(err?.message || err || 'Invalid regular expression').replace(/^Invalid regular expression:?\s*/i, '').replace(/^\/.*\/[a-z]*:\s*/, '');
/** Compile a search. -> { re, error }. Never throws. `sticky` builds a y-regex (anchored at lastIndex) instead of g. */
export function compileFind(query, { caseSensitive = false, wholeWord = false, regex = false } = {}, sticky = false) {
  if (!query) return { re: null, error: null };
  const src = regex ? query : escapeRegExp(query);
  const flags = (caseSensitive ? '' : 'i') + (regex ? 'm' : '') + (sticky ? 'y' : 'g');
  const attempts = [[wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, flags + 'u']];
  if (regex) attempts.push([wholeWord ? `(?<!\\w)(?:${src})(?!\\w)` : src, flags]); // legacy (non-unicode) escapes
  let first = null;
  for (const [pattern, f] of attempts) {
    try { return { re: new RegExp(pattern, f), error: null }; } catch (err) { first ||= err; }
  }
  return { re: null, error: cleanRegexError(first) };
}
/** Next index after an empty match at `i`, never landing inside a surrogate pair. */
export function advanceIndex(text, i, unicode = true) {
  const c = text.charCodeAt(i);
  return unicode && c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? i + 2 : i + 1;
}
/** All matches (up to `limit`): { matches:[{index,length}], error, capped }. */
export function findAll(text, opts, query, limit = LIMITS.findCap) {
  const { re, error } = compileFind(query, opts);
  if (!re) return { matches: [], error, capped: false };
  const matches = [];
  let m, capped = false;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (matches.length >= limit) { capped = true; break; }
    matches.push({ index: m.index, length: m[0].length });
    if (m[0].length === 0) { re.lastIndex = advanceIndex(text, m.index, re.unicode); if (re.lastIndex > text.length) break; }
  }
  return { matches, error: null, capped };
}
/** First match starting at or after `from` (optionally wrapping to the start). -> {index,length,wrapped} | null. */
export function findNextFrom(text, opts, query, from, wrap = true) {
  const { re } = compileFind(query, opts);
  if (!re) return null;
  const tryAt = start => {
    if (start > text.length) return null;
    re.lastIndex = start;
    const m = re.exec(text);
    return m ? { index: m.index, length: m[0].length } : null;
  };
  const a = tryAt(from);
  if (a) return { ...a, wrapped: false };
  if (!wrap || from === 0) return null;
  const b = tryAt(0);
  return b ? { ...b, wrapped: true } : null;
}
/** Last match starting before `before` (wrapping to the last match in the text). */
export function findPrevBefore(text, opts, query, before, wrap = true) {
  const { re } = compileFind(query, opts);
  if (!re) return null;
  let m, last = null, final = null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const cur = { index: m.index, length: m[0].length };
    if (cur.index < before) last = cur; else if (last || !wrap) break;
    final = cur;
    if (m[0].length === 0) { re.lastIndex = advanceIndex(text, m.index, re.unicode); if (re.lastIndex > text.length) break; }
  }
  if (last) return { ...last, wrapped: false };
  return wrap && final ? { ...final, wrapped: true } : null;
}
/** Step from selection {start,end}: dir +1 / -1. -> {index,length,wrapped} | null. */
export function stepFind(text, opts, query, sel, dir = 1) {
  if (!query) return null;
  if (dir >= 0) {
    let r = findNextFrom(text, opts, query, sel.end);
    // an empty match right at the caret would not move anything: skip past it
    if (r && r.length === 0 && r.index === sel.end && sel.start === sel.end && !r.wrapped) r = findNextFrom(text, opts, query, advanceIndex(text, sel.end));
    return r;
  }
  return findPrevBefore(text, opts, query, sel.start);
}
/** "3 of 12", "10,000+", "No results", or the regex error. */
export function describeCount({ query = '', error = null, total = 0, capped = false, current = -1 } = {}) {
  if (error) return `Invalid regex: ${error}`;
  if (!query) return '';
  if (!total) return 'No results';
  const n = total.toLocaleString('en-US') + (capped ? '+' : '');
  return current >= 0 ? `${(current + 1).toLocaleString('en-US')} of ${n}` : `${n} found`;
}
/** Index in `matches` of the match exactly covering [a, b], else -1. */
export function currentMatchIndex(matches, a, b) {
  let lo = 0, hi = matches.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, m = matches[mid];
    if (m.index === a) return m.length === b - a ? mid : (matches[mid + 1]?.index === a && matches[mid + 1].length === b - a ? mid + 1 : -1);
    if (m.index < a) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
/** Expand $$, $&, $`, $', $1..$99 and $<name> (regex mode). */
export function expandReplacement(repl, m, text) {
  return repl.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]+)>)/g, (x, a, name) => {
    if (a === '$') return '$';
    if (a === '&') return m[0];
    if (a === '`') return text.slice(0, m.index);
    if (a === "'") return text.slice(m.index + m[0].length);
    if (name !== undefined) return m.groups?.[name] ?? '';
    const n = Number(a);
    return n >= 1 && n < m.length ? (m[n] ?? '') : x;
  });
}
/** Edit replacing the match that exactly spans [a, b]; null if the selection is not a match. */
export function replaceMatchEdit(text, opts, query, repl, a, b) {
  const { re } = compileFind(query, opts, true);
  if (!re || a < 0 || b > text.length) return null;
  re.lastIndex = a;
  const m = re.exec(text);
  if (!m || m.index !== a || a + m[0].length !== b) return null;
  const out = opts?.regex ? expandReplacement(repl, m, text) : repl;
  return { from: a, to: b, text: out, selStart: a + out.length, selEnd: a + out.length };
}
/** Replace every match. -> { edit (spanning first..last match, or null), count, error }. */
export function replaceAllEdit(text, opts, query, repl) {
  const { re, error } = compileFind(query, opts);
  if (!re) return { edit: null, count: 0, error };
  let m, count = 0, first = -1, cur = 0, out = '';
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (first < 0) { first = m.index; cur = first; }
    out += text.slice(cur, m.index) + (opts?.regex ? expandReplacement(repl, m, text) : repl);
    cur = m.index + m[0].length;
    count++;
    if (m[0].length === 0) { re.lastIndex = advanceIndex(text, m.index, re.unicode); if (re.lastIndex > text.length) break; }
  }
  if (!count) return { edit: null, count: 0, error: null };
  return { edit: { from: first, to: cur, text: out, selStart: first, selEnd: first + out.length }, count, error: null };
}

// ---------------------------------------------------------------- files
export const hasNul = text => String(text ?? '').includes('\u0000');
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic|mp[34]|m4a|wav|ogg|webm|mov|avi|mkv|pdf|zip|gz|tgz|rar|7z|tar|bz2|xz|exe|dll|so|dylib|bin|class|jar|wasm|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|sqlite|db)$/i;
/** Quick pre-read check of a dropped/picked file. -> { ok, reason }. NUL bytes are checked after reading (hasNul). */
export function checkTextFile({ name = '', size = 0, type = '' } = {}, maxBytes = LIMITS.uploadBytes) {
  if (size > maxBytes) return { ok: false, reason: `File is too large (${(size / 1048576).toFixed(1)} MB; the limit is ${(maxBytes / 1048576).toFixed(0)} MB)` };
  if (/^(image|audio|video|font)\//i.test(type) || /^application\/(pdf|zip|gzip|octet-stream|x-zip|x-tar|vnd\.|msword|wasm)/i.test(type) || BINARY_EXT.test(name)) {
    return { ok: false, reason: 'That looks like a binary file, not text' };
  }
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------- split / resize math
/** Keep both panels at least `min` px wide. Falls back to 0.5 when the container is too small. */
export function clampRatio(ratio, size, min = 120, handle = 8) {
  const avail = size - handle;
  if (!(avail > 2 * min)) return 0.5;
  const lo = min / avail;
  return clamp(Number.isFinite(ratio) ? ratio : 0.5, lo, 1 - lo);
}
/** Ratio of the first panel for a pointer at `pos` (client coordinate) in a container starting at `start` with `size`. */
export function ratioFromPointer(pos, start, size, handle = 8) {
  const avail = size - handle;
  return avail > 0 ? (pos - start - handle / 2) / avail : 0.5;
}
/** Ratio after a keyboard step of `px` pixels (negative = shrink the first panel). */
export function stepRatio(ratio, px, size, handle = 8) {
  const avail = size - handle;
  return avail > 0 ? ratio + px / avail : ratio;
}
export const ratioToPercent = ratio => Math.round(ratio * 100);
/** Clamp an editor height (px). */
export const clampHeight = (h, min = 120, max = 4000) => Math.round(clamp(Number(h), min, max));

// ---------------------------------------------------------------- highlighters
// Each takes the full text and returns segments [{ text, type }] whose texts concatenate back to the input.
// Types: keyword string number comment function operator punctuation identifier property tag attribute regexp plain.
// All are single-pass (linear) hand-written scanners; unterminated constructs simply run to a line/file end.

function out() {
  const segs = [];
  return { segs, push(type, text) {
    if (!text) return;
    const l = segs[segs.length - 1];
    if (l && l.type === type) l.text += text; else segs.push({ text, type });
  } };
}
const isWs = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isDigit = c => c >= 48 && c <= 57;
const isIdStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isIdPart = c => isIdStart(c) || isDigit(c);
const isCssIdPart = c => isIdPart(c) || c === 45;

/** Index just after a quoted string starting at i (quote char q). Stops before a newline (unless `multiline`) or at EOF. */
function scanString(text, i, q, multiline = false) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += (!multiline && text.charCodeAt(j + 1) === 10) ? 1 : 2; continue; }
    if (c === q) return j + 1;
    if (c === 10 && !multiline) return j;
    j++;
  }
  return n;
}
function scanBlockComment(text, i, endStr) {
  const k = text.indexOf(endStr, i + 2);
  return k === -1 ? text.length : k + endStr.length;
}
function scanLineEnd(text, i) {
  const k = text.indexOf('\n', i);
  return k === -1 ? text.length : k;
}

export function highlightJson(text) {
  const o = out(), n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isWs(c)) { let j = i + 1; while (j < n && isWs(text.charCodeAt(j))) j++; o.push('plain', text.slice(i, j)); i = j; continue; }
    if (c === 34) {
      const j = scanString(text, i, 34);
      let type = 'string';
      if (text.charCodeAt(j - 1) === 34 && j - i > 1) {
        let k = j;
        while (k < n && isWs(text.charCodeAt(k))) k++;
        if (text.charCodeAt(k) === 58) type = 'property';
      }
      o.push(type, text.slice(i, j)); i = j; continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 47) { const j = scanLineEnd(text, i); o.push('comment', text.slice(i, j)); i = j; continue; }
    if (c === 47 && text.charCodeAt(i + 1) === 42) { const j = scanBlockComment(text, i, '*/'); o.push('comment', text.slice(i, j)); i = j; continue; }
    if (isDigit(c) || (c === 45 && isDigit(text.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) { const d = text.charCodeAt(j); if (isDigit(d) || d === 46 || d === 101 || d === 69 || ((d === 43 || d === 45) && (text.charCodeAt(j - 1) | 32) === 101)) j++; else break; }
      o.push('number', text.slice(i, j)); i = j; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(text.charCodeAt(j))) j++;
      const w = text.slice(i, j);
      o.push(w === 'true' || w === 'false' || w === 'null' ? 'keyword' : 'plain', w); i = j; continue;
    }
    if (c === 123 || c === 125 || c === 91 || c === 93 || c === 44 || c === 58) { o.push('punctuation', text[i]); i++; continue; }
    o.push('plain', text[i]); i++;
  }
  return o.segs;
}

const JS_KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return super switch ' +
  'throw try typeof var void while with yield async await static get set from as enum implements interface package private protected public type namespace declare readonly abstract keyof is ' +
  'true false null undefined NaN Infinity this').split(' '));
const JS_EXPR_KEYWORDS = new Set('return typeof instanceof in of new delete void throw case do else yield await extends'.split(' ')); // a `/` after these starts a regex
const JS_CONTROL = new Set('if for while switch catch with function return'.split(' '));

export function highlightJs(text) {
  const o = out(), n = text.length;
  let i = 0, exprEnd = false; // exprEnd: previous significant token ends an expression, so `/` is division
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isWs(c)) { let j = i + 1; while (j < n && isWs(text.charCodeAt(j))) j++; o.push('plain', text.slice(i, j)); i = j; continue; }
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) { const j = scanLineEnd(text, i); o.push('comment', text.slice(i, j)); i = j; continue; }
      if (d === 42) { const j = scanBlockComment(text, i, '*/'); o.push('comment', text.slice(i, j)); i = j; continue; }
      if (!exprEnd) { // regex literal: up to an unescaped / outside [...] on the same line
        let j = i + 1, inClass = false, ok = false;
        while (j < n) {
          const x = text.charCodeAt(j);
          if (x === 10) break;
          if (x === 92) { j += 2; continue; }
          if (x === 91) inClass = true; else if (x === 93) inClass = false;
          else if (x === 47 && !inClass) { ok = true; j++; break; }
          j++;
        }
        if (ok) { while (j < n && isIdPart(text.charCodeAt(j))) j++; o.push('regexp', text.slice(i, j)); i = j; exprEnd = true; continue; }
      }
      let j = i + 1;
      if (text.charCodeAt(j) === 61) j++;
      o.push('operator', text.slice(i, j)); i = j; exprEnd = false; continue;
    }
    if (c === 34 || c === 39) { const j = scanString(text, i, c); o.push('string', text.slice(i, j)); i = j; exprEnd = true; continue; }
    if (c === 96) { const j = scanString(text, i, 96, true); o.push('string', text.slice(i, j)); i = j; exprEnd = true; continue; }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      let j = i + 1;
      const hex = (text.charCodeAt(i + 1) | 32) === 120 && c === 48;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (isIdPart(d) || d === 46) j++;
        else if ((d === 43 || d === 45) && !hex && (text.charCodeAt(j - 1) | 32) === 101) j++;
        else break;
      }
      o.push('number', text.slice(i, j)); i = j; exprEnd = true; continue;
    }
    if (isIdStart(c) || c === 35) {
      let j = i + 1;
      while (j < n && isIdPart(text.charCodeAt(j))) j++;
      const w = text.slice(i, j);
      let type;
      if (JS_KEYWORDS.has(w) && text.charCodeAt(i - 1) !== 46) type = 'keyword';
      else if (text.charCodeAt(j) === 40) type = 'function';
      else type = 'identifier';
      o.push(type, w); i = j;
      exprEnd = type === 'keyword' ? !JS_EXPR_KEYWORDS.has(w) : true;
      if (JS_CONTROL.has(w) && type === 'keyword') exprEnd = false;
      continue;
    }
    if (c === 123 || c === 40 || c === 91 || c === 59 || c === 44 || c === 46) { o.push('punctuation', text[i]); i++; exprEnd = false; continue; }
    if (c === 125 || c === 41 || c === 93) { o.push('punctuation', text[i]); i++; exprEnd = true; continue; }
    if ('+-*%=<>!&|^~?:@'.includes(text[i])) {
      let j = i + 1;
      while (j < n && '+-*%=<>!&|^~?:'.includes(text[j])) j++;
      o.push('operator', text.slice(i, j)); i = j; exprEnd = false; continue;
    }
    o.push('plain', text[i]); i++;
  }
  return o.segs;
}

const CSS_GROUPING_AT = new Set(['media', 'supports', 'layer', 'container', 'document', 'scope', 'starting-style']);
export function highlightCss(text) {
  const o = out(), n = text.length;
  const stack = []; // per open brace: true = contains rules (selectors), false = contains declarations
  let atName = '', i = 0, afterColon = false;
  const inRules = () => stack.length === 0 || stack[stack.length - 1] === true;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isWs(c)) { let j = i + 1; while (j < n && isWs(text.charCodeAt(j))) j++; o.push('plain', text.slice(i, j)); i = j; continue; }
    if (c === 47 && text.charCodeAt(i + 1) === 42) { const j = scanBlockComment(text, i, '*/'); o.push('comment', text.slice(i, j)); i = j; continue; }
    if (c === 47 && text.charCodeAt(i + 1) === 47) { const j = scanLineEnd(text, i); o.push('comment', text.slice(i, j)); i = j; continue; } // SCSS/Less
    if (c === 34 || c === 39) { const j = scanString(text, i, c); o.push('string', text.slice(i, j)); i = j; continue; }
    if (c === 123) { stack.push(atName ? CSS_GROUPING_AT.has(atName) : false); o.push('punctuation', '{'); i++; atName = ''; afterColon = false; continue; }
    if (c === 125) { stack.pop(); o.push('punctuation', '}'); i++; atName = ''; afterColon = false; continue; }
    if (c === 59) { o.push('punctuation', ';'); i++; atName = ''; afterColon = false; continue; }
    if (c === 64) { // @rule
      let j = i + 1;
      while (j < n && isCssIdPart(text.charCodeAt(j))) j++;
      atName = text.slice(i + 1, j).toLowerCase().replace(/^-\w+-/, '');
      o.push('keyword', text.slice(i, j)); i = j; continue;
    }
    if (inRules()) {
      if (c === 46 || c === 35 || c === 58) { // .class #id :pseudo ::pseudo
        let j = i + 1;
        while (j < n && (text.charCodeAt(j) === 58 || isCssIdPart(text.charCodeAt(j)))) j++;
        o.push('attribute', text.slice(i, j)); i = j; continue;
      }
      if (c === 91) { const k = text.indexOf(']', i); const j = k === -1 ? n : k + 1; o.push('attribute', text.slice(i, j)); i = j; continue; }
      if (isIdStart(c) || c === 45) {
        let j = i + 1;
        while (j < n && isCssIdPart(text.charCodeAt(j))) j++;
        o.push(atName ? 'identifier' : 'tag', text.slice(i, j)); i = j; continue;
      }
      if (isDigit(c)) {
        let j = i + 1;
        while (j < n && (isIdPart(text.charCodeAt(j)) || text.charCodeAt(j) === 46 || text.charCodeAt(j) === 37)) j++;
        o.push('number', text.slice(i, j)); i = j; continue;
      }
      o.push(c === 62 || c === 43 || c === 126 || c === 42 ? 'operator' : 'punctuation', text[i]); i++; continue;
    }
    // declaration context
    if (c === 58 && !afterColon) { afterColon = true; o.push('punctuation', ':'); i++; continue; }
    if (c === 35) { // #rrggbb
      let j = i + 1;
      while (j < n && isIdPart(text.charCodeAt(j))) j++;
      o.push('number', text.slice(i, j)); i = j; continue;
    }
    if (isDigit(c) || ((c === 46 || c === 45 || c === 43) && (isDigit(text.charCodeAt(i + 1)) || (text.charCodeAt(i + 1) === 46 && isDigit(text.charCodeAt(i + 2)))))) {
      let j = i + 1;
      while (j < n) { const d = text.charCodeAt(j); if (isDigit(d) || d === 46 || d === 37 || isIdStart(d) ) j++; else break; }
      o.push('number', text.slice(i, j)); i = j; continue;
    }
    if (c === 33) { let j = i + 1; while (j < n && isCssIdPart(text.charCodeAt(j))) j++; o.push('keyword', text.slice(i, j)); i = j; continue; } // !important
    if (isIdStart(c) || c === 45) {
      let j = i + 1;
      while (j < n && isCssIdPart(text.charCodeAt(j))) j++;
      const type = afterColon ? (text.charCodeAt(j) === 40 ? 'function' : 'identifier') : 'property';
      o.push(type, text.slice(i, j)); i = j; continue;
    }
    o.push(c === 40 || c === 41 || c === 44 ? 'punctuation' : 'operator', text[i]); i++;
  }
  return o.segs;
}

const SCRIPT_TYPES_PLAIN = /^(text\/(template|x-|html|plain)|application\/(ld\+json)?)/i;
export function highlightHtml(text) {
  const o = out(), n = text.length;
  let i = 0;
  const pushSegs = segs => { for (const s of segs) o.push(s.type, s.text); };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 60) { // <
      if (text.startsWith('<!--', i)) { const j = scanBlockComment(text, i + 0, '-->'); o.push('comment', text.slice(i, j)); i = j; continue; }
      if (text.startsWith('<![CDATA[', i)) { const j = scanBlockComment(text, i + 6, ']]>'); o.push('string', text.slice(i, j)); i = j; continue; }
      const d = text.charCodeAt(i + 1);
      if (d === 33 || d === 63) { const k = text.indexOf('>', i); const j = k === -1 ? n : k + 1; o.push(d === 33 ? 'keyword' : 'comment', text.slice(i, j)); i = j; continue; }
      const closing = d === 47, nameAt = i + (closing ? 2 : 1);
      if (isIdStart(text.charCodeAt(nameAt)) && text.charCodeAt(nameAt) !== 36) {
        let j = nameAt;
        while (j < n && !isWs(text.charCodeAt(j)) && text.charCodeAt(j) !== 62 && text.charCodeAt(j) !== 47) j++;
        const name = text.slice(nameAt, j).toLowerCase();
        o.push('tag', text.slice(i, j));
        let afterEq = false, selfClose = false;
        const tagStart = j;
        while (j < n) {
          const x = text.charCodeAt(j);
          if (isWs(x)) { let k = j + 1; while (k < n && isWs(text.charCodeAt(k))) k++; o.push('plain', text.slice(j, k)); j = k; continue; }
          if (x === 62) { o.push('tag', '>'); j++; break; }
          if (x === 47) { if (text.charCodeAt(j + 1) === 62) { o.push('tag', '/>'); j += 2; selfClose = true; break; } o.push('plain', '/'); j++; continue; }
          if (x === 61) { o.push('operator', '='); j++; afterEq = true; continue; }
          if (x === 34 || x === 39) { const k = scanString(text, j, x, true); o.push('string', text.slice(j, k)); j = k; afterEq = false; continue; }
          let k = j + 1;
          while (k < n) { const y = text.charCodeAt(k); if (isWs(y) || y === 61 || y === 62 || (y === 47 && text.charCodeAt(k + 1) === 62)) break; k++; }
          o.push(afterEq ? 'string' : 'attribute', text.slice(j, k)); j = k; afterEq = false;
        }
        i = j;
        if (!closing && !selfClose && (name === 'script' || name === 'style') && j <= n) {
          const re = new RegExp(`</${name}`, 'gi');
          re.lastIndex = j;
          const m = re.exec(text);
          const end = m ? m.index : n;
          const tm = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(text.slice(tagStart, j));
          const t = tm ? tm[1] : '';
          const inner = text.slice(j, end);
          if (name === 'style') pushSegs(highlightCss(inner));
          else if (/json/i.test(t)) pushSegs(highlightJson(inner));
          else if (t && SCRIPT_TYPES_PLAIN.test(t) && !/javascript|ecmascript|module/i.test(t)) o.push('plain', inner);
          else pushSegs(highlightJs(inner));
          i = end;
        }
        continue;
      }
      o.push('plain', '<'); i++; continue;
    }
    if (c === 38) { // &entity;
      let j = i + 1;
      while (j < n && j - i < 12 && (isIdPart(text.charCodeAt(j)) || text.charCodeAt(j) === 35)) j++;
      if (text.charCodeAt(j) === 59 && j > i + 1) { o.push('keyword', text.slice(i, j + 1)); i = j + 1; continue; }
      o.push('plain', '&'); i++; continue;
    }
    let j = i + 1;
    while (j < n) { const x = text.charCodeAt(j); if (x === 60 || x === 38) break; j++; }
    o.push('plain', text.slice(i, j)); i = j;
  }
  return o.segs;
}

const HIGHLIGHTERS = { json: highlightJson, javascript: highlightJs, css: highlightCss, html: highlightHtml };
/** Highlighter function for a language name (json, css, scss, less, html, xml, svg, javascript, js, typescript...) or null. */
export function getHighlighter(language) {
  const h = languageConfig(language).highlighter;
  return h ? HIGHLIGHTERS[h] : null;
}
export const SYNTAX_TYPES = ['keyword', 'string', 'number', 'comment', 'function', 'operator', 'punctuation', 'identifier', 'property', 'tag', 'attribute', 'regexp', 'plain'];

/** Cumulative start offsets of segments (Uint32Array, length segs.length + 1; last = total length). */
export function segmentOffsets(segs) {
  const a = new Uint32Array(segs.length + 1);
  let p = 0;
  for (let i = 0; i < segs.length; i++) { a[i] = p; p += segs[i].text.length; }
  a[segs.length] = p;
  return a;
}
/** Segments covering text offsets [A, B) (first/last are sliced). Concatenation === text.slice(A, B). */
export function sliceSegments(segs, offsets, A, B) {
  const res = [];
  if (B <= A || !segs.length) return res;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= A) lo = mid; else hi = mid - 1; }
  for (let k = lo; k < segs.length && offsets[k] < B; k++) {
    const s = segs[k], from = Math.max(0, A - offsets[k]), to = Math.min(s.text.length, B - offsets[k]);
    res.push(from === 0 && to === s.text.length ? s : { text: s.text.slice(from, to), type: s.type });
  }
  return res;
}
