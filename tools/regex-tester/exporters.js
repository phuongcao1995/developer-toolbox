// Pure "copy as code" builders. Each returns { code, notes:[string], warnings:[string] }.
// Only JavaScript semantics are tested by this tool: other engines differ (see notes) and results can differ.
import { sortFlags } from './logic.js';

/** Replace raw control characters by their regex escapes so the generated source stays on one line. */
function normalizeControl(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[i + 1];
      if (n === '\n') out += '\\n'; else if (n === '\r') out += '\\r'; else if (n === '\t') out += '\\t'; else out += c + n;
      i++; continue;
    }
    if (c === '\n') out += '\\n'; else if (c === '\r') out += '\\r'; else if (c === '\t') out += '\\t';
    else if (c === '\u2028') out += '\\u2028'; else if (c === '\u2029') out += '\\u2029';
    else out += c;
  }
  return out;
}

/** Escape every "/" that is not already escaped (needed for /.../ and PHP delimiters). */
function escapeSlashes(p, delim = '/') {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { out += c + p[i + 1]; i++; continue; }
    out += c === delim ? '\\' + delim : c;
  }
  return out;
}

const hasLookaround = p => /\(\?<?[=!]/.test(p);
const hasBackref = p => /\\[1-9]|\\k</.test(p);
const hasNamed = p => /\(\?<(?![=!])[A-Za-z_]/.test(p);
const unsupportedFlags = (flags, supported) => [...flags].filter(c => !supported.includes(c));

export function toJavaScript(pattern, flags = '') {
  const f = sortFlags(flags);
  const src = escapeSlashes(normalizeControl(pattern));
  const notes = [];
  if (pattern === '') notes.push('The pattern is empty: /(?:)/ is what JavaScript prints for an empty regex.');
  return { code: `const re = /${src === '' ? '(?:)' : src}/${f};\nconst matches = [...text.matchAll(re)];${f.includes('g') ? '' : '\n// matchAll() needs the g flag; use text.match(re) for a single match.'}`, notes, warnings: [] };
}

export function toPython(pattern, flags = '') {
  const notes = [], warnings = [];
  let p = normalizeControl(pattern);
  if (hasNamed(p)) { p = p.replace(/\(\?<(?![=!])([A-Za-z_]\w*)>/g, '(?P<$1>').replace(/\\k<([A-Za-z_]\w*)>/g, '(?P=$1)'); notes.push('Named groups were rewritten from (?<n>) to (?P<n>) for Python.'); }
  const opts = [];
  const map = { i: 're.IGNORECASE', m: 're.MULTILINE', s: 're.DOTALL' };
  for (const c of sortFlags(flags)) if (map[c]) opts.push(map[c]);
  const un = unsupportedFlags(sortFlags(flags), 'ims');
  if (un.includes('g')) notes.push('g: use re.finditer() / re.findall() to get all matches.');
  if (un.includes('y')) notes.push('y (sticky): use pattern.match(text, pos) instead.');
  if (un.some(c => 'dvu'.includes(c))) notes.push('Flags d / u / v have no Python equivalent (str patterns are already Unicode).');
  notes.push('In Python, \\d \\w \\s match Unicode characters by default; add re.ASCII for JavaScript-like behaviour.');
  let lit;
  if (!p.includes('"') && !/\\$/.test(p.replace(/\\\\/g, '')) && !p.includes('\n')) lit = `r"${p}"`;
  else if (!p.includes("'") && !/\\$/.test(p.replace(/\\\\/g, ''))) lit = `r'${p}'`;
  else lit = `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return { code: `import re\n\npattern = re.compile(${lit}${opts.length ? ', ' + opts.join(' | ') : ''})\nmatches = pattern.findall(text)`, notes, warnings };
}

export function toPHP(pattern, flags = '') {
  const notes = [], warnings = [];
  const p = escapeSlashes(normalizeControl(pattern));
  const map = { i: 'i', m: 'm', s: 's', u: 'u', y: 'A' };
  const mods = [...sortFlags(flags)].map(c => map[c] || '').join('');
  const un = unsupportedFlags(sortFlags(flags), 'imsuy');
  if (un.includes('g')) notes.push('g: PHP uses preg_match_all() for all matches (the code below does that).');
  if (un.includes('y')) notes.push('y was mapped to the A (anchored) modifier, which is close but not identical to sticky.');
  if (un.some(c => 'dv'.includes(c))) notes.push('Flags d / v have no PHP equivalent.');
  notes.push('In PHP the u modifier means "pattern and subject are UTF-8"; \\d \\w stay ASCII without it.');
  const lit = "'" + `/${p}/${mods}`.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  return { code: `<?php\n$pattern = ${lit};\npreg_match_all($pattern, $text, $matches, PREG_SET_ORDER);`, notes, warnings };
}

function javaString(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c === 0x7f) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out;
}

export function toJava(pattern, flags = '') {
  const notes = [], warnings = [];
  const map = { i: 'Pattern.CASE_INSENSITIVE', m: 'Pattern.MULTILINE', s: 'Pattern.DOTALL', u: 'Pattern.UNICODE_CASE' };
  const opts = [...sortFlags(flags)].filter(c => map[c]).map(c => map[c]);
  const un = unsupportedFlags(sortFlags(flags), 'imsu');
  if (un.includes('g')) notes.push('g: loop with matcher.find() to get all matches (the code below does that).');
  if (un.some(c => 'ydv'.includes(c))) notes.push('Flags y / d / v have no direct Java equivalent.');
  notes.push('The pattern is shown double-escaped (every backslash doubled) as Java source requires.');
  if (/\(\?<[A-Za-z]*[_$]/.test(pattern)) warnings.push('Java group names may only contain letters and digits (no _ or $).');
  notes.push('In Java a "[" inside a character class starts a nested class: escape it as \\[ .');
  const lit = `"${javaString(normalizeControl(pattern))}"`;
  return { code: `Pattern p = Pattern.compile(${lit}${opts.length ? ', ' + opts.join(' | ') : ''});\nMatcher m = p.matcher(text);\nwhile (m.find()) {\n    System.out.println(m.group());\n}`, notes, warnings };
}

export function toGo(pattern, flags = '') {
  const notes = [], warnings = [];
  let p = normalizeControl(pattern);
  if (hasLookaround(p)) warnings.push('Go uses RE2, which does NOT support lookahead or lookbehind: regexp.MustCompile will panic on this pattern.');
  if (hasBackref(p)) warnings.push('Go uses RE2, which does NOT support backreferences (\\1, \\k<name>): regexp.MustCompile will panic on this pattern.');
  if (hasNamed(p)) { p = p.replace(/\(\?<(?![=!])([A-Za-z_]\w*)>/g, '(?P<$1>'); notes.push('Named groups were rewritten to (?P<name>...), accepted by every Go version.'); }
  const goFlags = [...sortFlags(flags)].filter(c => 'ims'.includes(c)).join('');
  const un = unsupportedFlags(sortFlags(flags), 'ims');
  if (un.includes('g')) notes.push('g: use re.FindAllString(text, -1) for all matches (the code below does that).');
  if (un.some(c => 'ydvu'.includes(c))) notes.push('Flags y / d / u / v have no Go equivalent (Go strings are UTF-8 already).');
  notes.push('Go (RE2) \\d \\w \\s are ASCII-only and matching is linear-time, with no catastrophic backtracking.');
  const body = (goFlags ? `(?${goFlags})` : '') + p;
  const lit = body.includes('`') ? `"${body.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '`' + body + '`';
  return { code: `re := regexp.MustCompile(${lit})\nmatches := re.FindAllString(text, -1)`, notes, warnings };
}

export function toCSharp(pattern, flags = '') {
  const notes = [], warnings = [];
  const map = { i: 'RegexOptions.IgnoreCase', m: 'RegexOptions.Multiline', s: 'RegexOptions.Singleline' };
  const opts = [...sortFlags(flags)].filter(c => map[c]).map(c => map[c]);
  const un = unsupportedFlags(sortFlags(flags), 'ims');
  if (un.includes('g')) notes.push('g: use regex.Matches(text) for all matches (the code below does that).');
  if (un.some(c => 'ydvu'.includes(c))) notes.push('Flags y / d / u / v have no .NET equivalent.');
  notes.push('.NET \\d \\w match Unicode characters unless you pass RegexOptions.ECMAScript, and $ also matches before a trailing newline.');
  const lit = `@"${normalizeControl(pattern).replace(/"/g, '""')}"`;
  return { code: `var regex = new Regex(${lit}${opts.length ? ', ' + opts.join(' | ') : ''});\nvar matches = regex.Matches(text);`, notes, warnings };
}

export const EXPORTERS = [
  { id: 'javascript', label: 'JavaScript', build: toJavaScript },
  { id: 'python', label: 'Python', build: toPython },
  { id: 'php', label: 'PHP', build: toPHP },
  { id: 'java', label: 'Java', build: toJava },
  { id: 'go', label: 'Go', build: toGo },
  { id: 'csharp', label: 'C#', build: toCSharp },
];
