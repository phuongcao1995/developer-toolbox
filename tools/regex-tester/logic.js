// Pure regex helpers (no DOM): compile, match, replace, highlight segmentation and a tokenizer-based explainer.

export const MAX_MATCHES = 1000;
export const TIME_BUDGET_MS = 750;
const FLAG_ORDER = 'dgimsuvy';
export const sortFlags = flags => [...new Set(flags)].sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)).join('');

/** Is this regex flag available in the current engine? (feature-detected, e.g. "v" needs a recent browser) */
export function supportsFlag(flag) {
  try { new RegExp('', flag); return true; } catch { return false; }
}

/** u and v cannot be combined: when `changed` was just switched on, drop its counterpart. */
export function resolveFlagConflict(flags, changed) {
  let f = [...new Set(flags)];
  if (changed === 'v' && f.includes('v')) f = f.filter(x => x !== 'u');
  if (changed === 'u' && f.includes('u')) f = f.filter(x => x !== 'v');
  return sortFlags(f.join(''));
}

/** Compile a pattern; never throws. */
export function buildRegex(pattern, flags = '') {
  if (pattern === '') return { ok: false, empty: true, error: 'Enter a pattern to start testing.' };
  try { return { ok: true, regex: new RegExp(pattern, sortFlags(flags)) }; }
  catch (e) { return { ok: false, error: String(e.message || e).replace(/^Invalid regular expression: /, '') }; }
}

/** Show a pattern as /pattern/flags (RegExp#source escapes any unescaped slashes). */
export function toLiteral(pattern, flags = '') {
  let src = pattern;
  try { src = new RegExp(pattern).source; } catch { /* keep raw */ }
  return `/${src}/${sortFlags(flags)}`;
}

// ---------------- ReDoS heuristics (warn only, never block) ----------------
export const WORKER_TIMEOUT_MS = 1500; // a matching job running longer than this is terminated

/** Minimal tolerant regex parser: builds {type:'atom'|'group'|'look', min, max, start, end, alts?, text?}. Never throws. */
function parseForRisk(p) {
  let i = 0;
  const ESC = /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[pP]\{[^}]*\}|k<[^>]*>|c[A-Za-z]|[\s\S])/;
  function quant(node) {
    const c = p[i];
    if (c === '*') { node.min = 0; node.max = Infinity; i++; }
    else if (c === '+') { node.min = 1; node.max = Infinity; i++; }
    else if (c === '?') { node.min = 0; node.max = 1; i++; }
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i));
      if (m) { node.min = +m[1]; node.max = m[2] ? (m[3] === '' ? Infinity : +m[3]) : +m[1]; i += m[0].length; } else return;
    } else return;
    if (p[i] === '?') i++; // lazy
  }
  function parseAlts(depth) {
    const alts = [[]];
    while (i < p.length) {
      const c = p[i];
      if (c === ')') { if (depth > 0) break; i++; continue; }
      if (c === '|') { alts.push([]); i++; continue; }
      const start = i;
      let node;
      if (c === '(') {
        i++;
        let look = false, m;
        const rest = p.slice(i, i + 40);
        if ((m = /^\?(<=|<!|=|!)/.exec(rest))) { look = true; i += m[0].length; }
        else if ((m = /^\?<[^>]*>/.exec(rest))) i += m[0].length;
        else if ((m = /^\?[a-zA-Z]*(?:-[a-zA-Z]*)?:/.exec(rest))) i += m[0].length;
        else if (rest[0] === '?') i++;
        const inner = parseAlts(depth + 1);
        if (p[i] === ')') i++;
        node = look ? { type: 'look', min: 1, max: 1 } : { type: 'group', alts: inner, min: 1, max: 1 };
      } else if (c === '[') {
        let j = i + 1;
        if (p[j] === '^') j++;
        while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? 2 : 1;
        node = { type: 'atom', text: p.slice(i, j + 1), min: 1, max: 1 };
        i = Math.min(j + 1, p.length);
      } else if (c === '\\') {
        const m = ESC.exec(p.slice(i, i + 40));
        const t = m ? m[0] : '\\';
        node = /^\\[bB]$/.test(t) ? { type: 'look', min: 1, max: 1 } : { type: 'atom', text: t, min: 1, max: 1 };
        i += t.length;
      } else if (c === '^' || c === '$') { node = { type: 'look', min: 1, max: 1 }; i++; }
      else if ('*+?'.includes(c)) { i++; continue; } // stray quantifier
      else { const cp = String.fromCodePoint(p.codePointAt(i)); node = { type: 'atom', text: cp, min: 1, max: 1 }; i += cp.length; }
      node.start = start; node.end = i;
      quant(node);
      alts[alts.length - 1].push(node);
    }
    return alts;
  }
  return parseAlts(0);
}

const SAMPLE_CHARS = (() => {
  const s = ['\n', '\r', '\t', ' ', 'é', '中', '_'];
  for (let c = 33; c < 127; c++) s.push(String.fromCharCode(c));
  return s;
})();

/** Do two single-atom regex sources match any common sample character? Unknown atoms (e.g. backreferences) -> false. */
function atomsOverlap(a, b, ci) {
  try {
    const fl = ci ? 'i' : '';
    const ra = new RegExp(`^(?:${a})$`, fl), rb = new RegExp(`^(?:${b})$`, fl);
    return SAMPLE_CHARS.some(ch => ra.test(ch) && rb.test(ch));
  } catch { return false; }
}

/** Atoms that can be matched repeatedly (own max is unbounded, or they sit inside an unbounded group), at any depth. */
function repeatedAtoms(seq, inside = false, out = []) {
  for (const n of seq) {
    const rep = inside || n.max === Infinity;
    if (n.type === 'atom' && rep) out.push(n.text);
    else if (n.type === 'group') n.alts.forEach(a => repeatedAtoms(a, rep, out));
  }
  return out;
}

/** First atoms a sequence can start with (looking through groups; stops at the first mandatory node). */
function firstAtoms(seq, out = []) {
  for (const n of seq) {
    if (n.type === 'atom') out.push(n.text);
    else if (n.type === 'group') n.alts.forEach(a => firstAtoms(a, out));
    if (n.min >= 1 && n.type !== 'look') break;
  }
  return out;
}

const literalOf = seq => (seq.length && seq.every(n => n.type === 'atom' && n.min === 1 && n.max === 1 && !/^\\[A-Za-z0-9]|^\[|^\.$/.test(n.text))
  ? seq.map(n => (n.text.length > 1 ? n.text.slice(1) : n.text)).join('') : null);

/** Is some string in W+ splittable into words of W in two different ways? (exact, for small literal alternations) */
function ambiguousWords(words) {
  const uniq = new Set(words);
  if (uniq.size < words.length) return true;
  if (words.length > 8 || words.some(w => w.length > 20 || w === '')) return false;
  const maxLen = Math.max(...words.map(w => w.length));
  const limit = maxLen * 3;
  const counts = new Map([['', 1]]);
  let frontier = ['']; // strings built so far, via BFS over concatenation
  for (let depth = 0; depth < 4; depth++) {
    const next = [];
    for (const f of frontier) for (const w of words) {
      const s = f + w;
      if (s.length > limit) continue;
      const c = (counts.get(s) || 0) + 1;
      counts.set(s, c);
      if (c > 1 && s !== '') return true;
      if (c === 1) next.push(s);
    }
    frontier = next;
  }
  return false;
}

function inspectGroup(node, src, ci, found) {
  const snippet = src.slice(node.start, node.end);
  // (A) nested quantifier: a repeated group whose body repeats without a delimiter that separates iterations
  for (const seq of node.alts) {
    const rep = repeatedAtoms(seq);
    const hasUnb = seq.some(hasUnboundedDeep);
    if (!hasUnb) continue;
    const delimiter = seq.some(n => n.type === 'atom' && n.min >= 1 && n.max !== Infinity && !rep.some(r => atomsOverlap(n.text, r, ci)));
    if (!delimiter) { found.push({ code: 'nested-quantifier', snippet, message: `The repeated group ${snippet} contains its own repetition with nothing that separates iterations (like (a+)+ or (\\w+\\s?)*). The same text can be split many ways, so on some inputs this can backtrack catastrophically and freeze the page.` }); return; }
  }
  // (B) overlapping alternation inside the repeated group
  if (node.alts.length > 1) {
    const lits = node.alts.map(literalOf);
    if (lits.every(l => l !== null) && ambiguousWords(lits)) {
      found.push({ code: 'overlapping-alternation', snippet, message: `The alternation in ${snippet} can match the same text in more than one way (like (a|aa)+ or (a|a)+) and is repeated, which can backtrack catastrophically.` });
      return;
    }
    for (let a = 0; a < node.alts.length; a++) for (let b = a + 1; b < node.alts.length; b++) {
      const A = node.alts[a], B = node.alts[b];
      const single = s => s.length === 1 && s[0].type === 'atom';
      if (!(single(A) || single(B))) continue;
      const fa = firstAtoms(A), fb = firstAtoms(B);
      if (fa.some(x => fb.some(y => atomsOverlap(x, y, ci)))) {
        found.push({ code: 'overlapping-alternation', snippet, message: `Branches of the repeated alternation ${snippet} overlap (like (\\w|\\d)+ or (a|aa)+), so the same text can match several ways and may backtrack catastrophically.` });
        return;
      }
    }
  }
}

function hasUnboundedDeep(n) {
  if (n.max === Infinity) return true;
  return n.type === 'group' && n.alts.some(a => a.some(hasUnboundedDeep));
}

function walk(alts, src, ci, found) {
  for (const seq of alts) for (const n of seq) {
    if (n.type !== 'group') continue;
    if (n.max === Infinity) inspectGroup(n, src, ci, found);
    walk(n.alts, src, ci, found);
  }
}

/** All ReDoS-style findings for a pattern: [{code, snippet, message}] (heuristic; empty = nothing suspicious found). */
export function analyzeRisk(pattern, flags = '') {
  const found = [];
  try { walk(parseForRisk(String(pattern)), String(pattern), String(flags).includes('i'), found); } catch { /* heuristic only */ }
  return found;
}

/** Heuristic warning text for patterns prone to catastrophic backtracking, or null. Warn-only: never blocks matching. */
export function riskWarning(pattern, flags = '') {
  const f = analyzeRisk(pattern, flags);
  return f.length ? f[0].message : null;
}

/**
 * Collect matches. Respects the g flag like JS does (no g -> at most one match).
 * Stops at `max` matches or the time budget (the regex engine itself cannot be interrupted).
 * Returns {matches:[{index,end,text,groups:[{n,value}],named:{}}], truncated, reason}
 */
export function findMatches(regex, text, max = MAX_MATCHES, budgetMs = TIME_BUDGET_MS) {
  let fl = regex.flags.includes('g') || regex.flags.includes('y') ? regex.flags : regex.flags + 'g';
  if (!fl.includes('d') && supportsFlag('d')) fl += 'd'; // hasIndices: gives exact group positions
  const re = new RegExp(regex.source, fl);
  const single = !regex.flags.includes('g') && !regex.flags.includes('y');
  const matches = [];
  const start = Date.now();
  let truncated = false, reason = '';
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      index: m.index, end: m.index + m[0].length, text: m[0],
      groups: m.slice(1).map((value, i) => ({ n: i + 1, value })),
      named: m.groups ? { ...m.groups } : null,
      // [start,end] of every group (index 0 = whole match; undefined for groups that did not participate); null without the d flag
      indices: m.indices ? Array.from(m.indices, p => (p ? [p[0], p[1]] : undefined)) : null,
      namedIndices: m.indices && m.indices.groups ? Object.fromEntries(Object.entries(m.indices.groups).map(([k, p]) => [k, p ? [p[0], p[1]] : undefined])) : null,
      lastIndex: re.lastIndex,
    });
    if (single) break;
    if (m[0] === '') { // zero-length match: step forward one code point (or unit) so we never loop forever
      const cp = re.unicode || re.flags.includes('v') ? text.codePointAt(re.lastIndex) : 0;
      re.lastIndex += cp > 0xffff ? 2 : 1;
      if (re.lastIndex > text.length) break;
    }
    if (matches.length >= max) { truncated = true; reason = `Stopped after ${max} matches.`; break; }
    if (Date.now() - start > budgetMs) { truncated = true; reason = `Stopped after ${budgetMs} ms to keep the page responsive.`; break; }
  }
  return { matches, truncated, reason };
}

/**
 * Split text into highlight segments: [{text, match: index|null, empty?: true}].
 * Zero-length matches become {text:'', empty:true} markers. Overlap is impossible (matches are sequential).
 */
export function segmentText(text, matches) {
  const segs = [];
  let pos = 0;
  matches.forEach((m, i) => {
    if (m.index > pos) segs.push({ text: text.slice(pos, m.index), match: null });
    if (m.end > m.index) segs.push({ text: text.slice(m.index, m.end), match: i });
    else segs.push({ text: '', match: i, empty: true });
    pos = Math.max(pos, m.end);
  });
  if (pos < text.length) segs.push({ text: text.slice(pos), match: null });
  return segs;
}

/** Apply String#replace semantics ($1, $<name>, $&, $$ ...). Returns {ok, result, error}. */
export function replaceAll(regex, text, replacement) {
  try { return { ok: true, result: text.replace(regex, replacement) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Expand a replacement template for one match exactly like String.prototype.replace (GetSubstitution):
 * $$ $& $` $' $n $nn $<name>. `m` is {text, index, groups:[{value}], named}.
 */
export function expandReplacement(template, m, text) {
  const caps = m.groups.length;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== '$' || i === template.length - 1) { out += c; continue; }
    const n = template[i + 1];
    if (n === '$') { out += '$'; i++; }
    else if (n === '&') { out += m.text; i++; }
    else if (n === '`') { out += text.slice(0, m.index); i++; }
    else if (n === "'") { out += text.slice(m.index + m.text.length); i++; }
    else if (n >= '0' && n <= '9') {
      let digits = n, num = +n;
      const two = template[i + 2] >= '0' && template[i + 2] <= '9' ? +(n + template[i + 2]) : -1;
      if (two >= 1 && two <= caps) { digits = n + template[i + 2]; num = two; }
      if (num >= 1 && num <= caps) { out += m.groups[num - 1].value ?? ''; i += digits.length; }
      else out += '$';
    } else if (n === '<') {
      const close = template.indexOf('>', i + 2);
      if (!m.named || close < 0) out += '$';
      else { out += m.named[template.slice(i + 2, close)] ?? ''; i = close; }
    } else out += '$';
  }
  return out;
}

/**
 * Per-match replacement list built from already-found matches (no regex execution).
 * Returns [{index, original, replacement}] (capped at `limit` items; `total` is the real count).
 */
export function replaceDetails(matches, text, template, limit = 500) {
  const items = matches.slice(0, limit).map(m => ({ index: m.index, original: m.text, replacement: expandReplacement(template, m, text) }));
  return { items, total: matches.length };
}

/** String#split with a regex (captures are included in the output, like JS does). Returns {ok, parts, error}. */
export function splitText(regex, text, limit) {
  try {
    const lim = limit === undefined || limit === '' || limit === null ? undefined : Math.max(0, Math.floor(Number(limit)) || 0);
    const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ''));
    return { ok: true, parts: text.split(re, lim) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** JSON-friendly view of matches for the "Matches as JSON" mode. */
export function matchesToJson(matches) {
  return matches.map((m, i) => ({
    match: m.text, index: m.index, end: m.end, length: m.end - m.index,
    groups: m.groups.map(g => ({ group: g.n, value: g.value ?? null, ...(m.indices && m.indices[g.n] ? { start: m.indices[g.n][0], end: m.indices[g.n][1] } : {}) })),
    ...(m.named ? { named: Object.fromEntries(Object.entries(m.named).map(([k, v]) => [k, v ?? null])) } : {}),
  }));
}

/**
 * One matching job (matches + replacement) - shared by the Web Worker, the in-thread fallback and the tests.
 * job.mode: 'replace' (default) | 'split' | 'json' decides which extra output is prepared (split runs a second regex pass).
 * Returns { ok, error?, matches, truncated, reason, replace:{ok,result|error}, diff?, split? }.
 */
export function runJob({ pattern, flags = '', text = '', replacement = '', max = MAX_MATCHES, budget = TIME_BUDGET_MS, mode = 'replace', splitLimit }) {
  const built = buildRegex(pattern, flags);
  if (!built.ok) return { ok: false, empty: !!built.empty, error: built.error };
  const found = findMatches(built.regex, text, max, budget);
  const out = { ok: true, ...found, replace: replaceAll(built.regex, text, replacement) };
  out.diff = replaceDetails(found.matches, text, replacement);
  if (mode === 'split') out.split = splitText(built.regex, text, splitLimit);
  return out;
}

// ---------------- Explainer ----------------
const CLASS_ESCAPES = { d: 'a digit (0-9)', D: 'any non-digit', w: 'a word character (letter, digit, underscore)', W: 'any non-word character', s: 'a whitespace character', S: 'any non-whitespace character' };
const CTRL = { n: 'a line feed (newline)', r: 'a carriage return', t: 'a tab', v: 'a vertical tab', f: 'a form feed', 0: 'the NUL character' };

const q = s => JSON.stringify(s);
const nm = c => (c === ' ' ? 'space' : q(c));

/** Describe one escape sequence starting at the backslash. Returns {len, desc, kind}. */
function readEscape(p, i, inClass) {
  const c = p[i + 1];
  if (c === undefined) return { len: 1, desc: 'a literal backslash (dangling at the end)', kind: 'escape' };
  if (CLASS_ESCAPES[c]) return { len: 2, desc: `Matches ${CLASS_ESCAPES[c]}`, kind: 'class' };
  if (c === 'b') return inClass ? { len: 2, desc: 'Matches a backspace character', kind: 'escape' } : { len: 2, desc: 'Word boundary — position between a word character and a non-word character', kind: 'anchor' };
  if (c === 'B' && !inClass) return { len: 2, desc: 'Non-word-boundary — position that is not a word boundary', kind: 'anchor' };
  if (c === '0' && !/\d/.test(p[i + 2] || '')) return { len: 2, desc: 'Matches the NUL character', kind: 'escape' };
  if (CTRL[c] && c !== '0') return { len: 2, desc: `Matches ${CTRL[c]}`, kind: 'escape' };
  let m;
  const rest = p.slice(i);
  if ((m = rest.match(/^\\x([0-9a-fA-F]{2})/))) return { len: 4, desc: `Matches the character with hex code ${m[1]}`, kind: 'escape' };
  if ((m = rest.match(/^\\u\{([0-9a-fA-F]+)\}/))) return { len: m[0].length, desc: `Matches the Unicode code point U+${m[1].toUpperCase()}`, kind: 'escape' };
  if ((m = rest.match(/^\\u([0-9a-fA-F]{4})/))) return { len: 6, desc: `Matches the Unicode character U+${m[1].toUpperCase()}`, kind: 'escape' };
  if ((m = rest.match(/^\\c([A-Za-z])/))) return { len: 3, desc: `Matches control character Ctrl+${m[1].toUpperCase()}`, kind: 'escape' };
  if ((m = rest.match(/^\\([pP])\{([^}]*)\}/))) return { len: m[0].length, desc: `Matches a character ${m[1] === 'P' ? 'NOT ' : ''}with Unicode property ${m[2]} (needs the u flag)`, kind: 'class' };
  if (!inClass && (m = rest.match(/^\\k<([^>]+)>/))) return { len: m[0].length, desc: `Backreference — matches the same text as the group named "${m[1]}"`, kind: 'backref' };
  if (!inClass && (m = rest.match(/^\\([1-9]\d*)/))) return { len: m[0].length, desc: `Backreference — matches the same text captured by group ${m[1]}`, kind: 'backref' };
  return { len: 2, desc: `Matches the literal character ${nm(c)}${/[A-Za-z0-9]/.test(c) ? '' : ' (escaped)'}`, kind: 'escape' };
}

/** Describe the interior of a [...] class. */
function describeClassBody(body) {
  const parts = [];
  for (let i = 0; i < body.length;) {
    let a, len;
    if (body[i] === '\\') { const e = readEscape(body, i, true); len = e.len; a = { text: body.slice(i, i + len), desc: e.desc.replace(/^Matches /, ''), range: /^\\[nrtvf0]$|^\\x|^\\u|^\\[^A-Za-z0-9]$/.test(body.slice(i, i + len)) }; }
    else { const cp = String.fromCodePoint(body.codePointAt(i)); len = cp.length; a = { text: cp, desc: nm(cp), range: true }; }
    // range "a-z": single chars joined by '-' and followed by another single item
    if (a.range && body[i + len] === '-' && i + len + 1 < body.length) {
      let j = i + len + 1, endText;
      if (body[j] === '\\') { const e = readEscape(body, j, true); endText = body.slice(j, j + e.len); j += e.len; }
      else { endText = String.fromCodePoint(body.codePointAt(j)); j += endText.length; }
      parts.push(`${a.text} to ${endText}`); i = j; continue;
    }
    parts.push(a.desc); i += len;
  }
  return parts.join(', ');
}

/**
 * Tokenize and explain a pattern.
 * Returns [{token, desc, depth, kind}] in pattern order, depth reflecting group nesting.
 */
export function explain(pattern, flags = '') {
  const out = [];
  const multiline = flags.includes('m'), dotAll = flags.includes('s');
  let depth = 0, groupCount = 0;
  const stack = []; // open group descriptions
  const push = (token, desc, kind, d = depth) => out.push({ token, desc, depth: d, kind });
  const isQuantAt = k => {
    const c = pattern[k];
    return c === '*' || c === '+' || c === '?' || (c === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(k)));
  };

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    // ---- quantifiers ----
    if (isQuantAt(i)) {
      let tok, desc;
      if (c === '*') { tok = '*'; desc = '0 or more times'; }
      else if (c === '+') { tok = '+'; desc = '1 or more times'; }
      else if (c === '?') { tok = '?'; desc = 'optional (0 or 1 time)'; }
      else {
        const m = pattern.slice(i).match(/^\{(\d+)(,(\d*))?\}/); tok = m[0];
        const lo = m[1], hasComma = m[2] !== undefined, hi = m[3];
        desc = !hasComma ? `exactly ${lo} time${lo === '1' ? '' : 's'}` : hi === '' ? `${lo} or more times` : `between ${lo} and ${hi} times`;
      }
      i += tok.length;
      let lazy = false;
      if (pattern[i] === '?' ) { lazy = true; tok += '?'; i++; }
      push(tok, `Quantifier — repeat the previous item ${desc}${lazy ? ', as few times as possible (lazy)' : ' (greedy)'}`, 'quantifier');
      continue;
    }
    if (c === '\\') { const e = readEscape(pattern, i, false); push(pattern.slice(i, i + e.len), e.desc, e.kind); i += e.len; continue; }
    if (c === '^') { push('^', multiline ? 'Anchor — start of a line (m flag is on)' : 'Anchor — start of the string', 'anchor'); i++; continue; }
    if (c === '$') { push('$', multiline ? 'Anchor — end of a line (m flag is on)' : 'Anchor — end of the string', 'anchor'); i++; continue; }
    if (c === '.') { push('.', dotAll ? 'Any character, including newlines (s flag is on)' : 'Any character except a line break', 'class'); i++; continue; }
    if (c === '|') { push('|', 'Alternation (OR) — match what is before OR what is after', 'alt', Math.max(0, depth - 1)); i++; continue; }
    if (c === '[') {
      // find closing bracket honoring escapes; a leading ] is literal in some dialects but JS treats [] as empty
      let j = i + 1;
      const neg = pattern[j] === '^'; if (neg) j++;
      const bodyStart = j;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      if (j >= pattern.length) { push(pattern.slice(i), 'Unterminated character class — the "[" has no closing "]"', 'error'); break; }
      const body = pattern.slice(bodyStart, j);
      push(pattern.slice(i, j + 1), body === '' ? (neg ? 'Any character (empty negated class)' : 'Matches nothing (empty class)') : `Any one character ${neg ? 'NOT ' : ''}in: ${describeClassBody(body)}`, 'class');
      i = j + 1; continue;
    }
    if (c === '(') {
      let tok = '(', desc, kind = 'group';
      const rest = pattern.slice(i);
      let m;
      if (rest.startsWith('(?:')) { tok = '(?:'; desc = 'Non-capturing group'; }
      else if (rest.startsWith('(?=')) { tok = '(?='; desc = 'Positive lookahead — what follows must match (not consumed)'; kind = 'look'; }
      else if (rest.startsWith('(?!')) { tok = '(?!'; desc = 'Negative lookahead — what follows must NOT match'; kind = 'look'; }
      else if (rest.startsWith('(?<=')) { tok = '(?<='; desc = 'Positive lookbehind — what precedes must match (not consumed)'; kind = 'look'; }
      else if (rest.startsWith('(?<!')) { tok = '(?<!'; desc = 'Negative lookbehind — what precedes must NOT match'; kind = 'look'; }
      else if ((m = rest.match(/^\(\?<([A-Za-z_$][\w$]*)>/))) { tok = m[0]; groupCount++; desc = `Named capturing group "${m[1]}" (group ${groupCount})`; }
      else if ((m = rest.match(/^\(\?([ims]*)(?:-([ims]*))?:/)) && (m[1] || m[2])) {
        tok = m[0];
        const names = { i: 'ignore case', m: 'multiline', s: 'dotAll' };
        const on = [...(m[1] || '')].map(f => names[f]), off = [...(m[2] || '')].map(f => names[f]);
        desc = `Non-capturing group with modifiers${on.length ? ` — turns on: ${on.join(', ')}` : ''}${off.length ? ` — turns off: ${off.join(', ')}` : ''} (inside this group only)`;
      }
      else if (rest.startsWith('(?')) { tok = '(?'; desc = 'Group with unrecognised modifier'; kind = 'error'; }
      else { groupCount++; desc = `Capturing group ${groupCount}`; }
      push(tok, desc, kind); stack.push(tok); depth++; i += tok.length; continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      const wasOpen = stack.length > 0;
      push(')', wasOpen ? `End of group opened by ${stack.pop()}` : 'Unmatched ")" — no group is open', wasOpen ? 'group' : 'error');
      i++; continue;
    }
    // ---- literal run: stop before a quantifier so it binds to the last char only ----
    let j = i, run = '';
    while (j < pattern.length && !'\\^$.|[()*+?{'.includes(pattern[j])) { run += pattern[j]; j++; }
    if (run === '') { run = c; j = i + 1; } // stray "{" or similar
    else if (isQuantAt(j) && run.length > 1) { // leave the last code point for the quantifier
      const last = Array.from(run).pop(); run = run.slice(0, run.length - last.length); j -= last.length;
    }
    push(run, run.length === 1 || [...run].length === 1 ? `Matches the literal character ${nm(run)}` : `Matches the literal text ${q(run)}`, 'literal');
    i = j;
  }
  if (stack.length) push('', `${stack.length} group${stack.length > 1 ? 's are' : ' is'} never closed — add ")"`, 'error', 0);
  // tokens cover the pattern without gaps: record where each one sits so the UI can highlight it in the pattern text
  let pos = 0;
  for (const tk of out) { tk.start = pos; pos += tk.token.length; tk.end = pos; }
  return out;
}

/**
 * Locate every group in the pattern: [{n (capturing number or null), name|null, kind:'capture'|'named'|'noncapture'|'lookahead'|'lookbehind', start, end, open}]
 * where start/end cover the whole "(...)" including parentheses, and `open` is the opening token like "(?<year>".
 */
export function groupSpans(pattern, flags = '') {
  const spans = [], stack = [];
  let n = 0;
  for (const tk of explain(pattern, flags)) {
    if (tk.token[0] === '(' && tk.token !== ')') {
      const name = /^\(\?<([A-Za-z_$][\w$]*)>$/.exec(tk.token);
      const look = tk.kind === 'look';
      const capturing = tk.token === '(' || !!name;
      const g = { n: capturing ? ++n : null, name: name ? name[1] : null, kind: look ? (tk.token.includes('<') ? 'lookbehind' : 'lookahead') : name ? 'named' : capturing ? 'capture' : 'noncapture', start: tk.start, end: -1, open: tk.token };
      spans.push(g); stack.push(g);
    } else if (tk.token === ')' && tk.kind === 'group') {
      const g = stack.pop();
      if (g) g.end = tk.end;
    }
  }
  return spans.filter(g => g.end > 0);
}

// ---------------- Examples ----------------
export const EXAMPLES = [
  { name: 'Email address', pattern: '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', flags: 'g', text: 'Contact: ada@example.com, bob.smith+news@mail.example.co.uk or invalid@ here.' },
  { name: 'URL (http/https)', pattern: 'https?:\\/\\/(?:[\\w-]+\\.)+[a-z]{2,}(?::\\d+)?(?:\\/[^\\s]*)?', flags: 'gi', text: 'Docs at https://developer.mozilla.org/en-US/docs and http://localhost:3000/app (not ftp://x.org).' },
  { name: 'IPv4 address', pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b', flags: 'g', text: 'Hosts: 192.168.1.1, 10.0.0.255, 256.1.1.1 (invalid), 8.8.8.8' },
  { name: 'Date (YYYY-MM-DD)', pattern: '(?<year>\\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\\d|3[01])', flags: 'g', text: 'Released 2024-03-15, patched 2024-12-01, bad date 2024-13-45.' },
  { name: 'Hex colour', pattern: '#(?:[0-9a-fA-F]{3}){1,2}\\b', flags: 'g', text: 'Colors: #fff, #1A2B3C, #12345 (too short), #abcdef.' },
  { name: 'Phone number (US)', pattern: '\\(?\\b\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}\\b', flags: 'g', text: 'Call (555) 123-4567 or 555.987.6543 or 5551234567.' },
  { name: 'Time (24h HH:MM)', pattern: '\\b(?:[01]\\d|2[0-3]):[0-5]\\d\\b', flags: 'g', text: 'Meetings at 09:30, 14:45 and 24:00 (invalid), 23:59.' },
  { name: 'HTML tag', pattern: '<\\/?([a-z][a-z0-9]*)\\b[^>]*>', flags: 'gi', text: '<div class="a"><p>Hello <b>world</b></p><br/></div>' },
  { name: 'Word repeated twice', pattern: '\\b(\\w+)\\s+\\1\\b', flags: 'gi', text: 'This is is a test of the the backreference.' },
  { name: 'Strong password check', pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^\\w\\s]).{8,}$', flags: 'm', text: 'Passw0rd!\nweakpass\nSTRONG#pass1' },
  { name: 'UUID', pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b', flags: 'gi', text: 'id=123e4567-e89b-12d3-a456-426614174000 and 550e8400-e29b-41d4-a716-446655440000' },
  { name: 'Quoted strings', pattern: '"((?:[^"\\\\]|\\\\.)*)"', flags: 'g', text: 'say "hello" and "escaped \\"quote\\"" ok' },
  { name: 'Leading / trailing whitespace', pattern: '^\\s+|\\s+$', flags: 'gm', text: '   padded line   \nclean\n\ttabbed' },
  { name: 'Positions between characters (zero-length)', pattern: '\\b', flags: 'g', text: 'zero-length matches' },
];

// ---------------- Lint: common regex mistakes ----------------
/** Length of the escape sequence starting at p[i] === '\\'. */
function escLen(p, i) {
  const rest = p.slice(i);
  let m;
  if ((m = /^\\u\{[0-9a-fA-F]+\}/.exec(rest))) return m[0].length;
  if ((m = /^\\[pP]\{[^}]*\}/.exec(rest))) return m[0].length;
  if (/^\\u[0-9a-fA-F]{4}/.test(rest)) return 6;
  if (/^\\x[0-9a-fA-F]{2}/.test(rest)) return 4;
  if (/^\\c[A-Za-z]/.test(rest)) return 3;
  if (i + 1 >= p.length) return 1;
  return 1 + String.fromCodePoint(p.codePointAt(i + 1)).length;
}

/** Split a class body (between [ and ]) into items: [{text, start, end, range?:{from,to}}] with absolute offsets. */
function classItems(p, from, to) {
  const items = [];
  const one = k => { const len = p[k] === '\\' ? escLen(p, k) : String.fromCodePoint(p.codePointAt(k)).length; return { text: p.slice(k, k + len), len }; };
  const isSet = t => /^\\[dDwWsSpP]/.test(t);
  for (let k = from; k < to;) {
    const a = one(k);
    const item = { text: a.text, start: k, end: k + a.len };
    if (p[k + a.len] === '-' && k + a.len + 1 < to && !isSet(a.text)) {
      const b = one(k + a.len + 1);
      if (!isSet(b.text)) { item.range = { from: a.text, to: b.text }; item.end = k + a.len + 1 + b.len; }
    }
    items.push(item); k = item.end;
  }
  return items;
}

const SYNTAX_CHARS = '^$\\.*+?()[]{}|/';
const KNOWN_LETTER_ESC = 'dDwWsSbBnrtvf0xucpPk';
const TLD_RE = /^(?:com|org|net|edu|gov|io|co|uk|de|fr|dev|app|info|biz|me|us|ca|au|jp|cn|ru|br|in)(?![a-z])/i;

/**
 * Detect common regex mistakes. Pure and tolerant (never throws, works on invalid patterns).
 * Returns [{id, severity:'error'|'warning'|'info', message, suggestion, start?, end?}] sorted by position.
 */
export function lintRegex(pattern, flags = '') {
  const out = [];
  const p = String(pattern ?? ''), f = String(flags ?? '');
  if (p === '') return out;
  const strict = f.includes('u') || f.includes('v');
  const add = (id, severity, message, suggestion, start, end) => out.push({ id, severity, message, suggestion, ...(start === undefined ? {} : { start, end }) });
  try {
    // ---- pass 1: group census and class ranges ----
    let caps = 0; const names = new Set(); const classes = [];
    for (let i = 0; i < p.length;) {
      const c = p[i];
      if (c === '\\') { i += escLen(p, i); continue; }
      if (c === '[') {
        let j = i + 1; if (p[j] === '^') j++;
        const bodyStart = j;
        while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? escLen(p, j) : 1;
        if (j >= p.length) { i++; continue; }
        classes.push({ start: i, end: j + 1, bodyStart, bodyEnd: j, negated: p[i + 1] === '^' });
        i = j + 1; continue;
      }
      if (c === '(') {
        const m = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(p.slice(i));
        if (m) { caps++; names.add(m[1]); } else if (p[i + 1] !== '?') caps++;
      }
      i++;
    }
    const classAt = k => classes.find(c => k >= c.start && k < c.end);

    // ---- classes ----
    for (const cl of classes) {
      const items = classItems(p, cl.bodyStart, cl.bodyEnd);
      if (cl.bodyStart === cl.bodyEnd) {
        add('empty-class', 'warning', cl.negated ? '[^] matches any character including newlines.' : '[] never matches anything in JavaScript.', cl.negated ? 'Use [\\s\\S] (or the s flag with .) for clarity.' : 'Remove it, or put characters inside the brackets.', cl.start, cl.end);
        continue;
      }
      for (const it of items) {
        if (it.range && it.range.from === 'A' && it.range.to === 'z') add('az-range', 'warning', '[A-z] also matches the characters [ \\ ] ^ _ and ` that sit between Z and a in ASCII.', 'Use [A-Za-z] (or [A-Za-z_] if you meant to include the underscore).', it.start, it.end);
        if (/^\\[1-9]$/.test(it.text)) add('backref-in-class', 'warning', `${it.text} inside a character class is an octal escape, not a backreference${strict ? ' (a SyntaxError with the u/v flag)' : ''}.`, 'Backreferences cannot be used inside [...]. Move it outside the class.', it.start, it.end);
      }
      const seen = new Set();
      for (const it of items) {
        if (it.range) continue;
        if (seen.has(it.text) && it.text !== '-') add('duplicate-class-char', 'info', `The character ${it.text} appears more than once in the class.`, 'Remove the duplicate.', it.start, it.end);
        else seen.add(it.text);
      }
      if (items.some(it => it.text === '|') && items.length > 2) add('pipe-in-class', 'info', 'Inside [...] the "|" is a literal pipe, not alternation.', 'Remove the "|" unless you really want to match a pipe character.', cl.start, cl.end);
    }

    // ---- pass 2: main scan (outside classes) ----
    const stack = []; let lastTok = 'start', topAlt = false, hasStart = false, hasEnd = false, anchorSeen = false;
    let seenShort = null, seenLookbehind = null, seenP = null, seenBoundary = false;
    const nonAscii = /[^\x00-\x7f]|\\u(?!00[0-7])[0-9a-fA-F]{4}|\\p\{(?:L|Letter|Lu|Ll|Script)/;
    for (let i = 0; i < p.length;) {
      const cl = classAt(i);
      if (cl) { i = cl.end; lastTok = 'atom'; continue; }
      const c = p[i];
      if (c === '\\') {
        const len = escLen(p, i), esc = p.slice(i, i + len), n = p[i + 1];
        lastTok = 'atom';
        if (n >= '1' && n <= '9') {
          const digits = /^\d+/.exec(p.slice(i + 1))[0], num = +digits;
          if (num > caps) add('bad-backreference', strict ? 'error' : 'warning', `\\${num} refers to group ${num} but the pattern has only ${caps} capturing group${caps === 1 ? '' : 's'}.`, strict ? 'Fix the group number.' : 'Without the u flag this is treated as an octal escape. Fix the group number.', i, i + 1 + digits.length);
          i += 1 + digits.length; continue;
        }
        if (n === 'k') {
          const m = /^\\k<([^>]*)>/.exec(p.slice(i));
          if (m && !names.has(m[1])) add('bad-backreference', 'error', `\\k<${m[1]}> refers to a group name that does not exist.`, 'Define it with (?<name>...) or fix the name.', i, i + m[0].length);
          else if (!m && (names.size || strict)) add('bad-backreference', 'error', '\\k must be followed by a group name like \\k<name>.', 'Write \\k<name>.', i, i + 2);
          i += m ? m[0].length : 2; continue;
        }
        if ((n === 'd' || n === 'w') && !seenShort) seenShort = { start: i, end: i + 2, which: n };
        if (n === 'b' || n === 'B') seenBoundary = true;
        if ((n === 'p' || n === 'P') && /^\\[pP]\{/.test(esc) && !strict && !seenP) seenP = { start: i, end: i + len };
        if (n !== undefined && !/[A-Za-z0-9]/.test(n) && !SYNTAX_CHARS.includes(n)) {
          add('unnecessary-escape', strict ? 'error' : 'info', `\\${n} is an unnecessary escape${strict ? ' and a SyntaxError with the u/v flag' : ''}.`, `Write ${n === ' ' ? 'a plain space' : n} without the backslash.`, i, i + len);
        } else if (n !== undefined && /[A-Za-z]/.test(n) && !KNOWN_LETTER_ESC.includes(n)) {
          add('unnecessary-escape', strict ? 'error' : 'warning', `\\${n} is not a known escape; without the u flag it just matches the letter "${n}"${strict ? ' (a SyntaxError with the u/v flag)' : ''}.`, `Write ${n} without the backslash.`, i, i + len);
        }
        i += len; continue;
      }
      if (c === '(') {
        const rest = p.slice(i); let m, tok = '(', kind = 'capture';
        if ((m = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?\)/.exec(rest)) && (m[1] || m[2])) {
          const letters = [...new Set((m[1] + (m[2] || '')).split(''))].filter(l => 'gimsuyd'.includes(l));
          add('inline-flags', 'error', `Inline flag group ${m[0]} is not supported in JavaScript (it is a SyntaxError).`, `Use the ${letters.map(l => `"${l}"`).join(', ') || 'matching'} flag button instead (flags apply to the whole pattern), or scope modifiers with (?i:...) in recent browsers.`, i, i + m[0].length);
          i += m[0].length; lastTok = 'atom'; continue;
        }
        if (rest.startsWith('(?<=') || rest.startsWith('(?<!')) { tok = rest.slice(0, 4); kind = 'lookbehind'; if (!seenLookbehind) seenLookbehind = { start: i, end: i + 4 }; }
        else if (rest.startsWith('(?=') || rest.startsWith('(?!')) { tok = rest.slice(0, 3); kind = 'lookahead'; }
        else if (rest.startsWith('(?:')) { tok = '(?:'; kind = 'noncapture'; }
        else if ((m = /^\(\?<[A-Za-z_$][\w$]*>/.exec(rest))) { tok = m[0]; kind = 'named'; }
        else if ((m = /^\(\?[a-z-]+:/.exec(rest))) { tok = m[0]; kind = 'modifier'; }
        stack.push({ kind, start: i }); i += tok.length; lastTok = 'open'; continue;
      }
      if (c === ')') {
        if (lastTok === 'alt') add('empty-alternation', 'warning', 'An empty alternative before ")" makes the group match the empty string.', 'Use (?:...)? to make the group optional instead.', i - 1, i);
        const g = stack.pop();
        const q = /^(?:[*+?]|\{\d+(?:,\d*)?\})/.exec(p.slice(i + 1));
        if (g && q && (g.kind === 'lookahead' || g.kind === 'lookbehind')) {
          const hard = g.kind === 'lookbehind' || strict;
          add('quantified-lookaround', hard ? 'error' : 'warning', `A quantifier after a ${g.kind} is ${hard ? 'a SyntaxError' : 'pointless (the assertion consumes nothing)'}.`, 'Remove the quantifier, or wrap the assertion in (?:...) if you meant "optional".', g.start, i + 1 + q[0].length);
        }
        i++; lastTok = 'atom'; continue;
      }
      if (c === '|') {
        if (['alt', 'open', 'start'].includes(lastTok)) add('empty-alternation', 'warning', 'Empty alternative: it matches the empty string, so this pattern matches everywhere.', 'Remove the stray "|" or add something before it.', i, i + 1);
        if (!stack.length) topAlt = true;
        i++; lastTok = 'alt'; continue;
      }
      if (c === '^') { anchorSeen = true; if (i === 0) hasStart = true; i++; lastTok = 'anchor'; continue; }
      if (c === '$') { anchorSeen = true; if (i === p.length - 1) hasEnd = true; i++; lastTok = 'anchor'; continue; }
      if (c === '{') {
        const m = /^\{,(\d*)\}/.exec(p.slice(i));
        if (m) add('comma-quantifier', strict ? 'error' : 'warning', `{,${m[1]}} is not a quantifier in JavaScript: it matches the literal text "{,${m[1]}}"${strict ? ' (and is a SyntaxError with the u/v flag)' : ''}.`, `Use {0,${m[1]}} for "up to ${m[1] || 'any number of'} times".`, i, i + m[0].length);
      }
      if (c === '.') {
        const next = p[i + 1], quantified = next !== undefined && '*+?{'.includes(next);
        const after = p.slice(i + 1), before = p.slice(0, i), at = before.lastIndexOf('@');
        const domainLike = TLD_RE.test(after)
          || (at >= 0 && !classAt(at) && /^(?:\[|\\w|\\d|\(|[A-Za-z])/.test(after))
          || (/(?:\\d|\[0-9\])(?:[+*]|\{\d+(?:,\d*)?\})?$/.test(before) && /^(?:\\d|\[0-9\]|\()/.test(after));
        if (domainLike && !quantified) add('unescaped-dot', 'warning', 'An unescaped "." matches ANY character, but in a domain / IP / version pattern you probably want a literal dot.', 'Escape it as \\. so "examplexcom" or "1x2" no longer match.', i, i + 1);
      }
      i++; lastTok = 'atom';
    }
    if (lastTok === 'alt') add('empty-alternation', 'warning', 'The pattern ends with "|", so it has an empty alternative that matches everywhere.', 'Remove the trailing "|".', p.length - 1, p.length);

    // ---- greedy dot between delimiters ----
    const D = '(?:\\\\[()\\[\\]{}.*+?|\\\\/^$-]|[^\\w\\s\\\\^$.*+?()\\[\\]{}|])';
    const greedy = new RegExp(`(${D})((?:\\((?:\\?:)?)?)\\.([*+])(?!\\?)\\)?(${D})`, 'g');
    let gm;
    while ((gm = greedy.exec(p))) {
      greedy.lastIndex = gm.index + 1;
      if (classAt(gm.index)) continue;
      const s = gm.index + gm[1].length + gm[2].length;
      const open = gm[1], close = gm[4], q = gm[3];
      const raw = close.startsWith('\\') ? close.slice(1) : close;
      add('greedy-between-delimiters', 'warning', `Greedy ".${q}" between ${open} and ${close} runs to the LAST ${close} on the line, swallowing everything between several pairs.`, `Use the lazy ".${q}?" or a negated class like [^${raw === '\\' ? '\\\\' : raw}]${q} (usually faster and clearer).`, s, s + 2);
    }

    // ---- anchors ----
    const endsDollar = p.endsWith('$') && p[p.length - 2] !== '\\';
    if (topAlt && (p[0] === '^' || endsDollar)) add('anchor-alternation', 'warning', 'With a top-level "|", ^ and $ bind only to the first / last alternative, not to the whole pattern.', 'Wrap the alternatives: ^(?:a|b)$.', 0, p.length);
    const searching = f.includes('g') || f.includes('y');
    const substantive = /[+*?{]|\[|\\[dwsDWS]|\(/.test(p) && p.length >= 5;
    if (!anchorSeen && !seenBoundary && substantive && !searching) add('missing-anchors', 'info', 'The pattern has no ^ or $ anchors, so it matches anywhere inside longer text ("abc123xyz" passes a [0-9]+ check).', 'If you validate a whole string, anchor it: ^...$. Ignore this if you are searching within text.');
    else if (hasStart !== hasEnd && !topAlt && substantive && !searching) add('missing-anchors', 'info', hasStart ? 'The pattern is anchored at the start but not the end, so trailing junk is accepted.' : 'The pattern is anchored at the end but not the start, so leading junk is accepted.', hasStart ? 'Add $ at the end to validate the whole string.' : 'Add ^ at the start to validate the whole string.');
    if (f.includes('m') && anchorSeen) add('multiline-anchors', 'info', 'With the m flag, ^ and $ match at every line break, not just at the start/end of the whole text.', 'Remove the m flag if you want to validate the whole string. JavaScript has no \\A / \\Z.');

    // ---- notes ----
    if (seenShort) add('ascii-shorthand', 'info', `\\${seenShort.which} is ASCII-only in JavaScript (even with the u flag): ${seenShort.which === 'd' ? 'it never matches digits from other scripts such as Arabic-Indic digits' : 'it never matches letters like é or ж'}.`, seenShort.which === 'd' ? 'Use \\p{Nd} with the u flag for any Unicode decimal digit.' : 'Use \\p{L} (letters) or [\\p{L}\\p{N}_] with the u flag.', seenShort.start, seenShort.end);
    if (seenBoundary && nonAscii.test(p)) add('boundary-non-ascii', 'warning', '\\b only knows ASCII word characters, so it misbehaves next to non-ASCII letters (é, ü, ж, ...).', 'Use lookarounds such as (?<![\\p{L}\\p{N}_])...(?![\\p{L}\\p{N}_]) with the u flag.');
    if (seenLookbehind) add('lookbehind-support', 'info', 'Lookbehind (?<=...) / (?<!...) needs Safari 16.4+ (older Safari throws a SyntaxError) and is not available in Go/RE2.', 'If you must support older engines, capture the prefix in a group instead.', seenLookbehind.start, seenLookbehind.end);
    if (seenP) add('unicode-property-no-u', 'warning', `${p.slice(seenP.start, seenP.end)} only works with the u (or v) flag; without it, it matches the literal text "p{...}".`, 'Turn on the u flag.', seenP.start, seenP.end);
    for (const r of analyzeRisk(p, f)) {
      const at = r.snippet ? p.indexOf(r.snippet) : -1;
      add('backtracking', 'warning', r.message, 'Remove the nested/overlapping repetition, make the alternatives mutually exclusive, or bound the repeat counts.', at >= 0 ? at : undefined, at >= 0 ? at + r.snippet.length : undefined);
    }
  } catch { /* lint is best effort */ }
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9) || rank[a.severity] - rank[b.severity]);
}
