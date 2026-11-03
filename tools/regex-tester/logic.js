// Pure regex helpers (no DOM): compile, match, replace, highlight segmentation and a tokenizer-based explainer.

export const MAX_MATCHES = 1000;
export const TIME_BUDGET_MS = 750;
const FLAG_ORDER = 'dgimsuvy';
export const sortFlags = flags => [...new Set(flags)].sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)).join('');

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

/** Heuristic warning for patterns prone to catastrophic backtracking, e.g. (a+)+ or (.*)*. */
export function riskWarning(pattern) {
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return 'This pattern has a quantified group containing a quantifier (like (a+)+). On some inputs it can backtrack catastrophically and freeze the page.';
  }
  return null;
}

/**
 * Collect matches. Respects the g flag like JS does (no g -> at most one match).
 * Stops at `max` matches or the time budget (the regex engine itself cannot be interrupted).
 * Returns {matches:[{index,end,text,groups:[{n,value}],named:{}}], truncated, reason}
 */
export function findMatches(regex, text, max = MAX_MATCHES, budgetMs = TIME_BUDGET_MS) {
  const re = new RegExp(regex.source, regex.flags.includes('g') || regex.flags.includes('y') ? regex.flags : regex.flags + 'g');
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
      else if (rest.startsWith('(?')) { tok = '(?'; desc = 'Group with unrecognised modifier'; kind = 'error'; }
      else { groupCount++; desc = `Capturing group ${groupCount}`; }
      push(tok, desc, kind); stack.push(tok); depth++; i += tok.length; continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      push(')', stack.length ? `End of group opened by ${stack.pop()}` : 'Unmatched ")" — no group is open', stack.length >= 0 ? 'group' : 'error');
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
  return out;
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
