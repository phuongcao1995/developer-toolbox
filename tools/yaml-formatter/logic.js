// Pure YAML logic. js-yaml (vendored, loaded lazily by the UI) is injected with setYaml(); only the safe DEFAULT_SCHEMA is ever used
// (no JavaScript types, nothing is evaluated). Comments are NOT preserved by js-yaml: callers must warn the user.
let Y = null;
export function setYaml(lib) { Y = lib && (lib.default && lib.default.load ? lib.default : lib); }
const need = () => { if (!Y) throw new Error('js-yaml is not loaded'); return Y; };

export const LIMITS = { maxExpandedNodes: 2_000_000, maxDiffCells: 4_000_000 };
export const DEFAULTS = { indent: 2, sortKeys: false, lineWidth: 80, quote: "'", forceQuotes: false, flow: 'block', expand: true };

// ---------------------------------------------------------------- positions
export function lineStartsOf(text) {
  const s = [0];
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 10) s.push(i + 1); else if (c === 13 && text.charCodeAt(i + 1) !== 10) s.push(i + 1); }
  return s;
}
export function positionAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}
export const formatError = e => `Line ${e.line}, column ${e.column}: ${e.message}`;
const splitLines = text => text.split(/\r\n|\r|\n/);

// ---------------------------------------------------------------- friendly errors
function friendlyHint(reason, text, line) {
  const lines = splitLines(text);
  const src = lines[line - 1] ?? '';
  const r = String(reason);
  if (/tab characters must not be used/i.test(r) || /^\s*\t/.test(src)) return 'YAML forbids tab characters for indentation. Replace the tabs at the start of the line with spaces.';
  if (/duplicated mapping key/i.test(r)) { const k = /^\s*(?:-\s+)?("[^"]*"|'[^']*'|[^:#]+?)\s*:/.exec(src); return `The key ${k ? k[1] : ''} appears twice in the same mapping. Remove or rename one of them (most parsers silently keep only the last).`; }
  if (/bad indentation of a mapping entry/i.test(r)) {
    if (/:\s+[^\s#'"[{|>&*!][^#]*:\s/.test(src)) return 'A plain (unquoted) value contains ": ". Wrap the value in quotes, e.g. key: "a: b".';
    return 'Keys of one mapping must line up exactly. Check the indentation of this line against its siblings (use spaces only).';
  }
  if (/bad indentation of a sequence entry/i.test(r)) return 'List items ("- ") must be indented consistently with their siblings.';
  if (/can not read a block mapping entry|multiline key may not be an implicit key/i.test(r)) return 'This line is not a valid "key: value" pair. A value containing ": " or " #" must be quoted.';
  if (/end of the stream or a document separator is expected/i.test(r)) return 'The content after the previous node does not fit: mixing "- item" lists and "key: value" mappings at the same level is not allowed, or indentation is inconsistent.';
  if (/unidentified alias|undefined alias/i.test(r)) return 'An alias (*name) refers to an anchor (&name) that is not defined earlier in the same document.';
  if (/unknown tag/i.test(r)) return 'Custom or language-specific tags (such as !!js/function or !!python/object) are not supported. This tool only uses the safe standard YAML types.';
  if (/within a flow collection/i.test(r)) return 'A [list] or {mapping} written inline is not closed, or a comma is missing.';
  if (/quoted scalar/i.test(r)) return 'A quoted string is not terminated. Check for a missing closing quote or an unescaped quote inside.';
  if (/anchor|alias/i.test(r)) return 'Check the anchor (&name) and alias (*name) names: they may only contain letters, digits, - and _.';
  if (/incomplete explicit mapping pair|key node is missed/i.test(r)) return 'A "? " complex key is incomplete.';
  if (/end of the stream.*block scalar|block scalar/i.test(r)) return 'Check the indentation of the multi-line (| or >) block.';
  return '';
}

function convertError(e, text) {
  const starts = lineStartsOf(text);
  let line = 1, column = 1, offset = 0;
  if (e && e.mark && typeof e.mark.position === 'number') { offset = Math.min(e.mark.position, text.length); const p = positionAt(starts, offset); line = p.line; column = p.column; }
  if (e && e.mark && typeof e.mark.line === 'number') { line = e.mark.line + 1; column = e.mark.column + 1; offset = starts[Math.min(line - 1, starts.length - 1)] + column - 1; }
  const reason = e && e.reason ? e.reason : (e && e.message) || String(e);
  const hint = e instanceof RangeError ? 'The document is nested too deeply to parse.' : friendlyHint(reason, text, line);
  return { message: e instanceof RangeError ? 'Maximum nesting depth exceeded' : reason, hint, line, column, offset };
}

// ---------------------------------------------------------------- parse
/** -> { ok, docs:[value], count } | { ok:false, error:{message,hint,line,column,offset} }. */
export function parseAll(text, { allowDuplicates = false } = {}) {
  const y = need();
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!src.trim()) return { ok: false, error: { message: 'The input is empty', hint: 'Paste or upload some YAML.', line: 1, column: 1, offset: 0 } };
  try {
    const docs = y.loadAll(src, null, { schema: y.DEFAULT_SCHEMA, json: allowDuplicates });
    return { ok: true, docs, count: docs.length };
  } catch (e) { return { ok: false, error: convertError(e, String(text)) }; }
}

// ---------------------------------------------------------------- value analysis
const isObj = v => v !== null && typeof v === 'object';
/** Detects cycles and the size the value has when every alias is expanded (memoised, so shared references are cheap to count). */
export function analyzeValue(value) {
  const state = new Map(); // object -> 1 visiting | number size
  let cyclic = false;
  const visit = v => {
    if (!isObj(v) || v instanceof Date || v instanceof Uint8Array) return 1;
    const s = state.get(v);
    if (s === 1) { cyclic = true; return 1; }
    if (typeof s === 'number') return s;
    state.set(v, 1);
    let size = 1;
    const kids = Array.isArray(v) ? v : Object.values(v);
    for (const k of kids) { size += visit(k); if (size > 1e15) size = 1e15; }
    state.set(v, size);
    return size;
  };
  let size;
  try { size = visit(value); } catch { return { cyclic: false, size: Infinity, deep: true }; }
  return { cyclic, size, deep: false };
}
export function countShared(value) {
  const seen = new Set(); let shared = 0;
  const walk = v => { if (!isObj(v) || v instanceof Date) return; if (seen.has(v)) { shared++; return; } seen.add(v); for (const k of Array.isArray(v) ? v : Object.values(v)) walk(k); };
  try { walk(value); } catch { /* ignore */ }
  return shared;
}

// ---------------------------------------------------------------- dump / convert
export function dumpOptions(o = {}) {
  const c = { ...DEFAULTS, ...o };
  const flowLevel = c.flow === 'block' ? -1 : c.flow === 'flow' ? 0 : Number(String(c.flow).replace('flow-', ''));
  return {
    indent: c.indent, sortKeys: !!c.sortKeys, lineWidth: c.lineWidth > 0 ? c.lineWidth : -1,
    quotingType: c.quote === '"' ? '"' : "'", forceQuotes: !!c.forceQuotes, flowLevel: Number.isFinite(flowLevel) ? flowLevel : -1,
    noRefs: !!c.expand, skipInvalid: true, noCompatMode: false,
  };
}
/** Dump documents (array of values) -> YAML text; multi-document output is separated by '---'. */
export function dumpDocs(docs, opts = {}) {
  const y = need(), d = dumpOptions(opts);
  const warnings = [];
  const parts = docs.map((doc, i) => {
    const a = analyzeValue(doc);
    let o = d;
    if (d.noRefs) {
      if (a.cyclic) { o = { ...d, noRefs: false }; warnings.push(`Document ${i + 1} contains a circular alias, so aliases cannot be expanded; anchors were kept.`); }
      else if (a.size > LIMITS.maxExpandedNodes) { o = { ...d, noRefs: false }; warnings.push(`Document ${i + 1} would grow to ${a.size === Infinity ? 'an enormous number of' : a.size.toLocaleString('en')} nodes if aliases were expanded (alias bomb); anchors and aliases were kept.`); }
    }
    return y.dump(doc === undefined ? null : doc, o);
  });
  const text = parts.length > 1 ? parts.map(p => `---\n${p}`).join('') : parts[0] ?? '';
  return { text, warnings };
}

/** Parse, then re-dump. Returns { ok, text, count, warnings, sameData, diff } or { ok:false, error }. */
export function formatYaml(text, opts = {}) {
  const r = parseAll(text, opts);
  if (!r.ok) return r;
  const { text: out, warnings } = dumpDocs(r.docs, opts);
  const w = [...warnings, ...scanComments(text).length ? [`The input contains comments. js-yaml cannot preserve them, so they are dropped from the formatted output.`] : []];
  const huge = r.docs.some(d => analyzeValue(d).size > LIMITS.maxExpandedNodes);
  const back = huge ? null : parseAll(out, opts);
  const sameData = huge ? null : back.ok && stableEqual(r.docs, back.docs);
  if (sameData === false) w.push('The formatted output does not parse to exactly the same data as the input. Review the diff before using it.');
  return { ok: true, text: out, count: r.count, warnings: w, sameData, diff: diffSummary(String(text).replace(/^﻿/, ''), out) };
}

function jsonReplacer(_k, v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Array.from(v);
  return v;
}
export function yamlToJson(text, opts = {}) {
  const r = parseAll(text, opts);
  if (!r.ok) return r;
  const warnings = [];
  for (let i = 0; i < r.docs.length; i++) {
    const a = analyzeValue(r.docs[i]);
    if (a.cyclic) return { ok: false, error: { message: 'The document contains a circular alias, which JSON cannot represent', hint: '', line: 1, column: 1, offset: 0 } };
    if (a.size > LIMITS.maxExpandedNodes) return { ok: false, error: { message: `Expanding aliases would create ${a.size === Infinity ? 'an enormous number of' : a.size.toLocaleString('en')} JSON nodes (alias bomb); refused`, hint: '', line: 1, column: 1, offset: 0 } };
  }
  const value = r.count === 1 ? r.docs[0] : r.docs;
  if (r.count > 1) warnings.push(`The input has ${r.count} documents, so the JSON is an array with one entry per document.`);
  const json = JSON.stringify(value === undefined ? null : value, jsonReplacer, opts.indent === '\t' ? '\t' : (opts.indent ?? 2));
  return { ok: true, text: json ?? 'null', count: r.count, warnings };
}

/** Offset of the first syntax error in JSON text (-1 if none); JSON.parse messages do not always carry a position. */
export function jsonErrorOffset(text) {
  let i = 0; const n = text.length;
  const ws = () => { while (i < n && ' \t\r\n'.includes(text[i])) i++; };
  const bad = () => { throw i; };
  const str = () => {
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c < ' ') bad();
      if (c === '\\') { i++; const e = text[i]; if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) bad(); i += 5; continue; } if (!'"\\/bfnrt'.includes(e || '')) bad(); }
      i++;
    }
    bad();
  };
  const value = d => {
    if (d > 1500) bad();
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws(); if (text[i] === '}') { i++; return; }
      for (;;) { ws(); if (text[i] !== '"') bad(); str(); ws(); if (text[i] !== ':') bad(); i++; value(d + 1); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return; } bad(); }
    } else if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(d + 1); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return; } bad(); }
    } else if (c === '"') str();
    else { const m = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(text.slice(i, i + 400)); if (!m) bad(); i += m[0].length; }
  };
  try { value(0); ws(); return i < n ? i : -1; } catch (e) { return typeof e === 'number' ? e : 0; }
}

export function jsonToYaml(text, opts = {}) {
  const src = String(text ?? '');
  if (!src.trim()) return { ok: false, error: { message: 'The input is empty. Paste JSON to convert.', hint: '', line: 1, column: 1, offset: 0 } };
  let value;
  try { value = JSON.parse(src); } catch (e) {
    let off = -1; const m = /position (\d+)/.exec(e.message);
    off = m ? Number(m[1]) : jsonErrorOffset(src);
    const p = positionAt(lineStartsOf(src), Math.max(0, off));
    return { ok: false, error: { message: `Invalid JSON: ${e.message.split('\n')[0].slice(0, 160)}`, hint: '', line: p.line, column: p.column, offset: Math.max(0, off) } };
  }
  const { text: out, warnings } = dumpDocs([value], { ...opts, expand: true });
  return { ok: true, text: out, count: 1, warnings };
}

// ---------------------------------------------------------------- stable comparison and diff
export function stableStringify(v) {
  const seen = new Set();
  const f = x => {
    if (x instanceof Date) return JSON.stringify(x.toISOString());
    if (typeof x === 'number') return Number.isNaN(x) ? '"NaN"' : Number.isFinite(x) ? String(x) : (x > 0 ? '"Infinity"' : '"-Infinity"');
    if (!isObj(x)) return x === undefined ? 'null' : JSON.stringify(x);
    if (seen.has(x)) return '"[circular]"';
    seen.add(x);
    const out = Array.isArray(x) ? `[${x.map(f).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${f(x[k])}`).join(',')}}`;
    seen.delete(x);
    return out;
  };
  return f(v);
}
export function stableEqual(a, b) { try { return stableStringify(a) === stableStringify(b); } catch { return false; } }

/** Line diff summary: { added, removed, unchanged, changes:[{type:'+'|'-', line, text}] (first 200), approximate }. */
export function diffSummary(a, b) {
  const A = splitLines(a), B = splitLines(b);
  while (A.length && A[A.length - 1] === '') A.pop();
  while (B.length && B[B.length - 1] === '') B.pop();
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a2 = A.slice(s, ea), b2 = B.slice(s, eb);
  const changes = [];
  const push = (type, line, text) => { if (changes.length < 200) changes.push({ type, line, text }); };
  let added = 0, removed = 0, approximate = false;
  if (a2.length * b2.length <= LIMITS.maxDiffCells) {
    const m = a2.length, n = b2.length, w = n + 1;
    const dp = new Uint32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i * w + j] = a2[i] === b2[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && a2[i] === b2[j]) { i++; j++; }
      else if (j < n && (i >= m || dp[i * w + j + 1] > dp[(i + 1) * w + j])) { added++; push('+', s + j + 1, b2[j]); j++; }
      else { removed++; push('-', s + i + 1, a2[i]); i++; }
    }
  } else {
    approximate = true;
    const count = new Map(); for (const l of a2) count.set(l, (count.get(l) || 0) + 1);
    for (const l of b2) { const c = count.get(l) || 0; if (c > 0) count.set(l, c - 1); else added++; }
    for (const c of count.values()) removed += c;
  }
  return { added, removed, unchanged: A.length - removed, changes, approximate, identical: added === 0 && removed === 0 };
}

// ---------------------------------------------------------------- checks panel
const BOOL_1_1 = /^(y|Y|n|N|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF)$/;
/** Comment positions (a '#' that starts a comment, ignoring # inside quotes and block scalars). */
export function scanComments(text) {
  const out = []; const lines = splitLines(String(text));
  let blockIndent = -1;
  lines.forEach((raw, idx) => {
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent >= 0) { if (raw.trim() === '' || indent > blockIndent) return; blockIndent = -1; }
    let q = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (q) { if (c === '\\' && q === '"') i++; else if (c === q) { if (q === "'" && raw[i + 1] === "'") i++; else q = null; } continue; }
      if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,-]/.test(raw[i - 1]))) { q = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) { out.push({ line: idx + 1, column: i + 1 }); break; }
    }
    if (/[:-]\s+[|>][-+0-9]*\s*(#.*)?$/.test(raw) || /^\s*[|>][-+0-9]*\s*(#.*)?$/.test(raw)) blockIndent = indent;
  });
  return out;
}

/**
 * Text-level heuristics. Each finding: { level:'warn'|'info', line, code, message }. These are hints about portability between YAML 1.1
 * parsers (PyYAML, Ruby, many Go/Java libraries) and YAML 1.2 parsers (js-yaml, yaml.js): they cannot see inside every construct.
 */
export function checkYaml(text) {
  const findings = []; const lines = splitLines(String(text).replace(/^﻿/, ''));
  const add = (level, line, code, message) => findings.push({ level, line, code, message });
  let blockIndent = -1, docs = 1;
  const anchors = new Map(), aliasUse = new Set();
  lines.forEach((raw, idx) => {
    const ln = idx + 1; const indent = raw.length - raw.trimStart().length;
    if (blockIndent >= 0) { if (raw.trim() === '' || indent > blockIndent) return; blockIndent = -1; }
    if (/^---(\s|$)/.test(raw) && idx > 0) docs++;
    if (/^\t/.test(raw) || /^ +\t/.test(raw)) add('warn', ln, 'tab-indent', 'Tab character in indentation. YAML only allows spaces for indentation.');
    const noComment = raw.replace(/(^|\s)#.*$/, '$1');
    if (/[:-]\s+[|>][-+0-9]*\s*$/.test(noComment) || /^\s*[|>][-+0-9]*\s*$/.test(noComment)) blockIndent = indent;
    for (const m of noComment.matchAll(/(^|[\s[{,])&([^\s,\]}]+)/g)) if (!anchors.has(m[2])) anchors.set(m[2], ln);
    for (const m of noComment.matchAll(/(^|[\s[{,:-])\*([^\s,\]}]+)/g)) aliasUse.add(m[2]);
    if (/^\s*(?:-\s+)?<<\s*:/.test(noComment)) add('info', ln, 'merge-key', 'Merge key "<<" is a YAML 1.1 extension; it is expanded here, but strict YAML 1.2 parsers may treat it as a plain key.');
    // extract the scalar value on this line
    let value = null;
    const body = noComment.trim().replace(/^(?:-\s+)+/, '');
    const km = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"[\]{}&*!|>%@`,][^:#]*?)\s*:(?:\s+(.*))?$/.exec(body);
    if (km) value = (km[1] ?? '').trim();
    else if (/^\s*-\s/.test(noComment) || /^-\s*$/.test(noComment.trim())) value = body;
    if (value === null || value === '') {
      if (km && km[1] === undefined && /:\s*$/.test(body) && !/^\s*-/.test(raw)) { /* nested mapping or null: ambiguous, skip */ }
      return;
    }
    value = value.replace(/^(?:&\S+\s+)/, '');
    if (/^["'[{|>*!&]/.test(value)) return;
    if (BOOL_1_1.test(value)) {
      if (/^(y|Y|n|N)$/.test(value)) add('warn', ln, 'bool-yn', `Unquoted ${value} is a string in YAML 1.2 but a boolean in YAML 1.1 parsers. Quote it ("${value}") if you mean the letter.`);
      else add('warn', ln, 'norway', `Unquoted ${value} is a plain string in YAML 1.2 (this tool) but a boolean in YAML 1.1 parsers (PyYAML, Ruby...). The "Norway problem": the country code NO becomes false. Quote it ("${value}") for text, or use true/false for booleans.`);
    } else if (/^(true|false|True|False|TRUE|FALSE)$/.test(value)) { /* fine in every version */ }
    else if (/^(~|null|Null|NULL)$/.test(value)) add('info', ln, 'null', `${value} is parsed as null. Quote it ("${value}") if you mean the text.`);
    else if (/^[-+]?0[0-9]+$/.test(value)) add('warn', ln, 'octal', `${value} looks like an octal number: YAML 1.1 parsers read it as ${/^[-+]?0[0-7]+$/.test(value) ? 'octal ' + parseInt(value, 8) : 'decimal (invalid octal)'}, YAML 1.2 parsers as decimal ${parseInt(value, 10)} (js-yaml) or text. Quote it ("${value}") for an identifier such as a zip code or file mode, or write 0o755 for explicit octal.`);
    else if (/^[-+]?0o[0-7]+$/.test(value)) add('info', ln, 'octal12', `${value} is YAML 1.2 octal notation; YAML 1.1 parsers read it as a string.`);
    else if (/^\d{1,2}(:[0-5]\d){1,2}$/.test(value)) add('warn', ln, 'sexagesimal', `${value} is a base-60 number in YAML 1.1 (e.g. 12:30 = 750), a string in YAML 1.2. Quote it ("${value}") to be safe.`);
    else if (/^[-+]?\d+\.\d*0$/.test(value) && !/^[-+]?\d+\.0$/.test(value)) add('warn', ln, 'trailing-zero', `${value} is parsed as the number ${Number(value)}; the trailing zero is lost (version numbers like 1.10 become 1.1). Quote it ("${value}").`);
    else if (/^[-+]?\d{16,}$/.test(value)) add('warn', ln, 'bigint', `${value} exceeds 2^53 and loses precision when parsed as a JavaScript number. Quote it to keep it exact.`);
    else if (/^\d{4}-\d{2}-\d{2}([Tt ][\d:.]+.*)?$/.test(value)) add('info', ln, 'timestamp', `${value} is parsed as a timestamp (a date), not a string. Quote it to keep text.`);
    else if (/^[-+]?(\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$/.test(value)) add('info', ln, 'special-float', `${value} is a special float; JSON output writes it as a string.`);
    else if (/^[-+]?(0x[0-9a-fA-F]+|0b[01]+)$/.test(value)) add('info', ln, 'radix', `${value} is parsed as a number in hexadecimal/binary notation. Quote it if it is an identifier.`);
    else if (/^\d+(_\d+)+$/.test(value)) add('info', ln, 'underscore-int', `${value} is a number with underscores in YAML 1.1 (${value.replace(/_/g, '')}) and a string in YAML 1.2.`);
    else if (/^[^"'].*: /.test(value) && !km) add('warn', ln, 'colon', 'A plain scalar containing ": " is ambiguous. Quote the value.');
    else if (/:\s/.test(value) && km) add('warn', ln, 'colon', 'The value contains ": " which makes it look like a nested mapping. Quote the value.');
    else if (/^[-?:](\s|$)/.test(value) && km) add('info', ln, 'indicator', 'A value starting with - ? or : followed by a space needs quotes.');
    else if (/^[@`%]/.test(value)) add('warn', ln, 'reserved-indicator', `Values starting with "${value[0]}" are reserved in YAML and must be quoted.`);
  });
  for (const [name, ln] of anchors) if (!aliasUse.has(name)) add('info', ln, 'unused-anchor', `Anchor &${name} is never used by an alias.`);
  findings.sort((a, b) => a.line - b.line);
  return { findings, documents: docs, anchors: [...anchors.keys()], aliases: [...aliasUse] };
}

// ---------------------------------------------------------------- outline / paths
const identRe = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export function pathToString(parts) {
  let s = '';
  for (const p of parts) s += typeof p === 'number' ? `[${p}]` : identRe.test(p) ? (s ? `.${p}` : p) : `[${JSON.stringify(p)}]`;
  return s || '$';
}
export function describeValue(v) {
  if (v === null || v === undefined) return { type: 'null', preview: 'null' };
  if (Array.isArray(v)) return { type: 'array', preview: `[${v.length}]` };
  if (v instanceof Date) return { type: 'timestamp', preview: v.toISOString() };
  if (v instanceof Uint8Array) return { type: 'binary', preview: `${v.length} bytes` };
  if (typeof v === 'object') return { type: 'object', preview: `{${Object.keys(v).length}}` };
  if (typeof v === 'string') return { type: 'string', preview: v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v };
  return { type: typeof v, preview: String(v) };
}
export const childrenOf = v => {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (isObj(v) && !(v instanceof Date) && !(v instanceof Uint8Array)) return Object.keys(v).map(k => [k, v[k]]);
  return [];
};
/** Search keys and scalar values (case-insensitive) with an iterative DFS that stops at cycles. */
export function searchValue(root, query, cap = 300) {
  const q = String(query || '').toLowerCase(); const hits = [];
  if (!q) return hits;
  const stack = [{ v: root, path: [], anc: [] }];
  while (stack.length && hits.length < cap) {
    const { v, path, anc } = stack.pop();
    if (!isObj(v) || v instanceof Date || v instanceof Uint8Array) {
      const d = describeValue(v);
      if (path.length && String(d.preview).toLowerCase().includes(q)) hits.push({ path, why: 'value', preview: d.preview });
      continue;
    }
    if (anc.includes(v)) continue;
    const kids = childrenOf(v);
    for (let i = kids.length - 1; i >= 0; i--) {
      const [k, c] = kids[i];
      stack.push({ v: c, path: [...path, k], anc: [...anc, v] });
    }
    for (const [k, c] of kids) if (typeof k === 'string' && k.toLowerCase().includes(q)) hits.push({ path: [...path, k], why: 'key', preview: describeValue(c).preview });
  }
  return hits.slice(0, cap);
}

/** Validation summary for the Validate button. */
export function summarize(docs) {
  return docs.map((d, i) => {
    const t = describeValue(d);
    const a = analyzeValue(d);
    return { index: i + 1, type: t.type, size: t.type === 'object' ? Object.keys(d).length : t.type === 'array' ? d.length : null, nodes: a.size, shared: countShared(d), cyclic: a.cyclic };
  });
}

export function sizeStats(before, after) {
  const enc = new TextEncoder(); const b = enc.encode(before).length, a = enc.encode(after).length;
  return { before: b, after: a, saved: b - a, percent: b ? ((b - a) / b) * 100 : 0 };
}

export const SAMPLE = `# Deployment config (comments are dropped when formatting)
defaults: &defaults
  image: nginx:1.10
  replicas: 2
  country: NO
  mode: 0755
services:
  web:
    <<: *defaults
    ports: [80, 443]
    env: {LOG_LEVEL: info, DEBUG: off}
  worker:
    <<: *defaults
    replicas: 5
    command: "run --queue=default"
---
second: document
`;
