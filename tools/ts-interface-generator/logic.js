// JSON / JSON Lines / JSON Schema  ->  TypeScript interfaces, Zod schemas or JSDoc typedefs. Pure ES module (no DOM).
// Naming helpers come from the shared module; the inference engine here adds counts (for optional properties across many samples),
// enum-like string unions, index signatures, null handling, multi-document input and alternative output targets.
// With default options the TypeScript output is identical to assets/js/shared/ts-interfaces.js (verified by tests).
import { toPascalCase } from '../../assets/js/shared/ts-interfaces.js';

export const LIMITS = { maxDepth: 200, scanDepth: 1000, unionValueLength: 40 };

export const DEFAULTS = {
  rootName: 'Root', target: 'typescript', format: 'auto',
  exportKeyword: true, useInterface: true, readonly: false,
  optionalFromArrays: true, mergeArrayShapes: true, arrayAsSamples: false,
  nullHandling: 'union', // 'union' (T | null) | 'optional' (T? and null dropped) | 'omit' (null dropped)
  dateMode: 'string', // 'string' | 'Date' (ISO date strings become Date / z.coerce.date())
  stringUnions: false, unionMax: 5, // enum-like unions of string values
  indexSignatureMin: 0, // 0 = off; otherwise objects with >= N numeric-like keys become { [key: string]: V }
  quoteKeys: 'auto', // 'auto' | 'always'
  comments: true, // schema descriptions -> doc comments
};

const RESERVED_NAMES = new Set(['Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Record', 'Promise', 'Map', 'Set', 'Function', 'Symbol',
  'Error', 'Partial', 'Readonly', 'Pick', 'Omit', 'RegExp', 'BigInt', 'any', 'unknown', 'never', 'void', 'null', 'undefined', 'string', 'number',
  'boolean', 'object', 'symbol', 'bigint', 'true', 'false', 'class', 'enum', 'interface', 'type', 'default', 'new', 'delete', 'function', 'var', 'let', 'const']);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_KEY = /^-?\d+(?:\.\d+)?$/;

function singular(name) {
  if (/ies$/i.test(name) && name.length > 4) return name.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(name)) return name;
  if (/ses$|xes$|ches$|shes$/i.test(name) && name.length > 4) return name.slice(0, -2);
  if (/s$/i.test(name) && name.length > 3) return name.slice(0, -1);
  return name;
}

// =============================================================== JSON scanner (positions for errors)
export class JsonScanError extends Error {
  constructor(message, offset, text) {
    super(message);
    this.name = 'JsonScanError'; this.offset = offset;
    const { line, column } = locate(text, offset);
    this.line = line; this.column = column; this.snippet = snippet(text, offset);
  }
}
/** 1-based line / column of a UTF-16 offset. */
export function locate(text, offset) {
  const o = Math.max(0, Math.min(offset, text.length));
  let line = 1, last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < o; i = text.indexOf('\n', i + 1)) { line++; last = i; }
  return { line, column: o - last };
}
function snippet(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  let end = text.indexOf('\n', offset); if (end < 0) end = text.length;
  let line = text.slice(start, end), col = offset - start;
  if (line.length > 120) { const a = Math.max(0, col - 50); line = (a ? '…' : '') + line.slice(a, a + 100); col = col - a + (a ? 1 : 0); }
  return { line, column: col };
}
const WS = new Set([' ', '\t', '\n', '\r']);
const describeChar = (t, i) => (i >= t.length ? 'the end of the input' : `"${t[i] === '\n' ? '\\n' : t[i]}"`);

/** Validate ONE JSON value starting at `start` (after whitespace). Returns the index just after it; throws JsonScanError. */
export function scanValue(text, start = 0) {
  let i = start;
  const fail = (msg, at = i) => { throw new JsonScanError(msg, at, text); };
  const ws = () => { while (i < text.length && WS.has(text[i])) i++; };
  const hintFor = c => {
    if (c === "'") return ' JSON strings and keys use double quotes, not single quotes.';
    if (c === '/' ) return ' Comments are not allowed in JSON.';
    if (/[A-Za-z_$]/.test(c || '')) return ' Keys and strings must be in double quotes; the only bare words are true, false and null.';
    return '';
  };
  function str() {
    const begin = i; i++;
    for (;;) {
      if (i >= text.length) fail('Unterminated string', begin);
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return; }
      if (c < 0x20) fail(`Unescaped control character in a string (use \\n, \\t ...)`, i);
      if (c === 92) {
        const n = text[i + 1];
        if (n === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('Invalid \\u escape: expected 4 hex digits', i); i += 6; continue; }
        if (n === undefined || !'"\\/bfnrt'.includes(n)) fail(`Invalid escape sequence "\\${n ?? ''}"`, i);
        i += 2; continue;
      }
      i++;
    }
  }
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  function val(depth) {
    if (depth > LIMITS.scanDepth) fail(`Nesting is deeper than ${LIMITS.scanDepth} levels`);
    ws();
    if (i >= text.length) fail('Unexpected end of input: a value was expected');
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] === '"') str();
        else if (text[i] === '}') fail('Trailing comma: a property was expected after ","' + ' (JSON does not allow trailing commas)');
        else fail(`Expected a property name in double quotes but found ${describeChar(text, i)}.` + hintFor(text[i]));
        ws();
        if (text[i] !== ':') fail(`Expected ":" after the property name but found ${describeChar(text, i)}`);
        i++; val(depth + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail(`Expected "," or "}" but found ${describeChar(text, i)}`);
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        ws();
        if (text[i] === ']') fail('Trailing comma: a value was expected after ","' + ' (JSON does not allow trailing commas)');
        val(depth + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail(`Expected "," or "]" but found ${describeChar(text, i)}`);
      }
    }
    if (c === '"') { str(); return; }
    for (const w of ['true', 'false', 'null']) if (text.startsWith(w, i)) { i += w.length; if (/[A-Za-z0-9_]/.test(text[i] || '')) fail(`Unexpected characters after "${w}"`); return; }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (m && m[0] !== '') { i += m[0].length; if (/[0-9A-Za-z_.+-]/.test(text[i] || '')) fail('Invalid number'); return; }
    if (/^(NaN|Infinity|-Infinity|undefined)/.test(text.slice(i, i + 9))) fail('NaN, Infinity and undefined are not valid JSON values');
    if (c === '-' || /[0-9]/.test(c)) fail('Invalid number');
    fail(`Unexpected ${describeChar(text, i)}: expected a JSON value.` + hintFor(c));
  }
  val(0);
  return i;
}

/**
 * Split text into JSON documents (one document, JSON Lines, or several documents separated by blank lines / whitespace).
 * Returns { docs: [{ value, start, end }], error: null | JsonScanError, trailing: bool }.
 * `single: true` requires exactly one document (anything after it is an error).
 */
export function parseDocuments(input, { single = false, maxDocs = 100000 } = {}) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const docs = [];
  let i = 0, error = null;
  const skip = () => { while (i < text.length && WS.has(text[i])) i++; };
  skip();
  while (i < text.length) {
    if (docs.length >= maxDocs) { error = new JsonScanError(`More than ${maxDocs} documents`, i, text); break; }
    if (single && docs.length === 1) {
      error = new JsonScanError('Unexpected content after the JSON document. For several documents (JSON Lines, or samples separated by blank lines) choose "Multiple documents".', i, text);
      break;
    }
    try {
      const end = scanValue(text, i);
      let value;
      try { value = JSON.parse(text.slice(i, end)); } catch (e) { throw new JsonScanError(e.message, i, text); }
      docs.push({ value, start: i, end });
      i = end;
    } catch (e) {
      if (e instanceof JsonScanError) { error = e; break; }
      throw e;
    }
    // two values on the same line without a separator, e.g. {"a":1}{"b":2}, are accepted; ", " between documents is not
    skip();
  }
  if (!docs.length && !error) error = new JsonScanError('The input is empty: paste a JSON document', 0, text);
  return { docs, error, text };
}

// =============================================================== type model (with counts)
// {k:'p', n, vals?:Map, cnt?, over?}  {k:'o', n, props: Map<key,{t,c}>}  {k:'a', e}  {k:'u', ms}
const prim = n => ({ k: 'p', n });
const members = t => (t.k === 'u' ? t.ms : [t]);

function shapeSig(t, d = 0) {
  if (d > 100) return '~';
  if (t.k === 'p') return t.n;
  if (t.k === 'a') return '[' + (t.e ? shapeSig(t.e, d + 1) : '') + ']';
  if (t.k === 'u') return t.ms.map(m => shapeSig(m, d + 1)).sort().join('|');
  return '{' + [...t.props].map(([k, p]) => JSON.stringify(k) + (p.c < t.n ? '?' : '') + ':' + shapeSig(p.t, d + 1)).join(',') + '}';
}

function mergeStrings(x, y, o) {
  const vals = new Map(x.vals || []);
  let over = !!x.over || !!y.over;
  for (const v of (y.vals || [])) { if (vals.size > o.unionMax) { over = true; break; } vals.set(v[0], true); }
  if (vals.size > o.unionMax) over = true;
  return { k: 'p', n: 'string', vals, cnt: (x.cnt || 0) + (y.cnt || 0), over };
}

function mergeTypes(a, b, o) {
  if (!a) return b;
  if (!b) return a;
  const out = [];
  for (const m of [...members(a), ...members(b)]) {
    let done = false;
    for (let i = 0; i < out.length && !done; i++) {
      const x = out[i];
      if (x.k === 'p' && m.k === 'p' && x.n === m.n) { if (x.n === 'string' && o.stringUnions) out[i] = mergeStrings(x, m, o); done = true; }
      else if (x.k === 'a' && m.k === 'a') { out[i] = { k: 'a', e: x.e && m.e ? mergeTypes(x.e, m.e, o) : (x.e || m.e) }; done = true; }
      else if (x.k === 'o' && m.k === 'o' && (o.mergeArrayShapes || shapeSig(x) === shapeSig(m))) { out[i] = mergeObjects(x, m, o); done = true; }
    }
    if (!done) out.push(m);
  }
  return out.length === 1 ? out[0] : { k: 'u', ms: out };
}

function mergeObjects(x, y, o) {
  const props = new Map();
  for (const [k, p] of x.props) {
    const q = y.props.get(k);
    props.set(k, q ? { t: mergeTypes(p.t, q.t, o), c: p.c + q.c } : p);
  }
  for (const [k, q] of y.props) if (!x.props.has(k)) props.set(k, q);
  return { k: 'o', n: x.n + y.n, props };
}

function infer(v, o, depth, state) {
  if (depth > LIMITS.maxDepth) { state.deep = true; return prim('unknown'); }
  if (v === null) return prim('null');
  switch (typeof v) {
    case 'string':
      if (o.dateMode === 'Date' && ISO_DATE.test(v)) return prim('Date');
      return o.stringUnions ? { k: 'p', n: 'string', vals: new Map([[v, true]]), cnt: 1, over: v.length > LIMITS.unionValueLength || v.includes('\n') } : prim('string');
    case 'number': return prim('number');
    case 'boolean': return prim('boolean');
    case 'object': break;
    default: return prim('unknown');
  }
  if (Array.isArray(v)) {
    let e = null;
    for (const x of v) e = mergeTypes(e, infer(x, o, depth + 1, state), o);
    return { k: 'a', e };
  }
  const props = new Map();
  for (const k of Object.keys(v)) props.set(k, { t: infer(v[k], o, depth + 1, state), c: 1 });
  return { k: 'o', n: 1, props };
}

// =============================================================== IR (what the emitters consume)
// {k:'prim', n} {k:'lit', vals[]} {k:'ref', name} {k:'arr', e} {k:'union', ms} {k:'index', v}
// declaration: { name, kind:'obj', props:[{key, t, opt, doc}], index: IR|null, doc } | { name, kind:'alias', t, doc }
const P = n => ({ k: 'prim', n });
const irSig = t => JSON.stringify(t);

function normalizeOptions(options) {
  const o = { ...DEFAULTS, ...options };
  if (options && options.dateAsString === false && options.dateMode === undefined) o.dateMode = 'Date'; // shared-module compatibility
  o.unionMax = Math.max(1, Math.min(50, Math.floor(+o.unionMax) || 5));
  o.indexSignatureMin = Math.max(0, Math.floor(+o.indexSignatureMin) || 0);
  return o;
}

function makeNamer(rootName) {
  const used = new Set([rootName]);
  return hint => {
    let base = toPascalCase(hint);
    if (RESERVED_NAMES.has(base)) base += 'Type';
    let name = base, n = 2;
    while (used.has(name)) name = base + n++;
    used.add(name); return name;
  };
}
function safeRoot(o) {
  let rootName = toPascalCase(o.rootName || 'Root');
  if (RESERVED_NAMES.has(rootName)) rootName += 'Type';
  return rootName;
}

function stripNull(t) {
  if (t.k !== 'u') return t.k === 'p' && t.n === 'null' ? null : t;
  const ms = t.ms.filter(m => !(m.k === 'p' && m.n === 'null'));
  return ms.length === 0 ? null : ms.length === 1 ? ms[0] : { k: 'u', ms };
}
const hasNull = t => members(t).some(m => m.k === 'p' && m.n === 'null');

/** Infer model -> { decls, root } */
function lowerInferred(type, o, rootName) {
  const alloc = makeNamer(rootName);
  const decls = [], bySig = new Map();
  const isNumericKeyed = t => o.indexSignatureMin > 0 && t.props.size >= o.indexSignatureMin && [...t.props.keys()].every(k => NUMERIC_KEY.test(k));

  function lowerUnion(t, hint) {
    const ms = [...t.ms].sort((a, b) => (a.k === 'p' && a.n === 'null') - (b.k === 'p' && b.n === 'null'));
    const objs = ms.filter(x => x.k === 'o').length;
    const parts = [];
    ms.forEach((m, i) => {
      const ir = lower(m, objs > 1 ? `${hint}${i + 1}` : hint);
      for (const x of ir.k === 'union' ? ir.ms : [ir]) if (!parts.some(p => irSig(p) === irSig(x))) parts.push(x);
    });
    return parts.length === 1 ? parts[0] : { k: 'union', ms: parts };
  }
  function lower(t, hint) {
    if (t.k === 'p') {
      if (t.n === 'string' && o.stringUnions && t.vals && !t.over && t.cnt >= 2 && t.vals.size <= o.unionMax) return { k: 'lit', vals: [...t.vals.keys()] };
      return P(t.n);
    }
    if (t.k === 'a') {
      if (!t.e) return { k: 'arr', e: P('unknown') };
      let e = t.e;
      if (o.nullHandling !== 'union' && hasNull(e)) e = stripNull(e) || prim('unknown');
      return { k: 'arr', e: lower(e, singular(hint)) };
    }
    if (t.k === 'u') return lowerUnion(t, hint);
    return lowerObject(t, hint, false);
  }
  function lowerObject(t, hint, isRoot) {
    if (isNumericKeyed(t)) {
      let v = null;
      for (const p of t.props.values()) v = mergeTypes(v, p.t, o);
      if (o.nullHandling !== 'union' && hasNull(v)) v = stripNull(v) || prim('unknown');
      const idx = lower(v, singular(hint));
      if (!isRoot) return { k: 'index', v: idx };
      decls.push({ name: rootName, kind: 'obj', props: [], index: idx });
      return { k: 'ref', name: rootName };
    }
    const props = [];
    for (const [key, p] of t.props) {
      let pt = p.t, opt = p.c < t.n;
      if (opt && !o.optionalFromArrays) { pt = mergeTypes(pt, prim('undefined'), o); opt = false; }
      if (o.nullHandling !== 'union' && hasNull(pt)) {
        const s = stripNull(pt);
        if (o.nullHandling === 'optional') opt = true;
        pt = s || prim('unknown');
      }
      props.push({ key, t: lower(pt, key), opt });
    }
    const sig = irSig(props.map(p => [p.key, p.opt, p.t]));
    if (!isRoot && bySig.has(sig)) return { k: 'ref', name: bySig.get(sig) };
    const name = isRoot ? rootName : alloc(hint);
    if (!isRoot) bySig.set(sig, name);
    decls.push({ name, kind: 'obj', props, index: null });
    return { k: 'ref', name };
  }

  let root;
  if (type.k === 'o') root = lowerObject(type, rootName, true);
  else root = lower(type, type.k === 'a' ? rootName + 'Item' : rootName);
  if (root.k !== 'ref' || root.name !== rootName || !decls.some(d => d.name === rootName)) decls.push({ name: rootName, kind: 'alias', t: root });
  return decls;
}

// =============================================================== emitters
const keyText = (k, o) => (o.quoteKeys !== 'always' && IDENT.test(k) ? k : JSON.stringify(k));
const litText = v => JSON.stringify(v);

function tsType(t, o) {
  // returns { s, union }
  switch (t.k) {
    case 'prim': return { s: t.n, union: false };
    case 'ref': return { s: t.name, union: false };
    case 'lit': return { s: t.vals.map(litText).join(' | '), union: t.vals.length > 1 };
    case 'arr': { const e = tsType(t.e, o); const inner = e.union ? `(${e.s})` : e.s; return { s: o.readonly ? `readonly ${inner}[]` : `${inner}[]`, union: false }; }
    case 'index': { const v = tsType(t.v, o); return { s: `{ ${o.readonly ? 'readonly ' : ''}[key: string]: ${v.s} }`, union: false }; }
    case 'union': { const parts = t.ms.map(m => tsType(m, o).s); const seen = new Set(); const u = parts.filter(s => !seen.has(s) && seen.add(s)); return { s: u.join(' | '), union: u.length > 1 }; }
    default: return { s: 'unknown', union: false };
  }
}
const docComment = (text, indent) => {
  const clean = String(text).replace(/\*\//g, '* /').replace(/\r?\n/g, ' ').trim();
  return clean ? `${indent}/** ${clean} */\n` : '';
};

function emitTypeScript(decls, o) {
  const exp = o.exportKeyword ? 'export ' : '', ro = o.readonly ? 'readonly ' : '';
  const out = [];
  for (const d of decls) {
    if (d.kind === 'alias') { out.push(`${docComment(d.doc || '', '')}${exp}type ${d.name} = ${tsType(d.t, o).s};`); continue; }
    const lines = [];
    for (const p of d.props) lines.push(`${o.comments && p.doc ? docComment(p.doc, '  ') : ''}  ${ro}${keyText(p.key, o)}${p.opt ? '?' : ''}: ${tsType(p.t, o).s};`);
    if (d.index) lines.push(`  ${ro}[key: string]: ${tsType(d.index, o).s};`);
    const body = lines.length ? `{\n${lines.join('\n')}\n}` : '{}';
    const doc = o.comments && d.doc ? docComment(d.doc, '') : '';
    out.push(doc + (o.useInterface ? `${exp}interface ${d.name} ${body}` : `${exp}type ${d.name} = ${body};`));
  }
  return out.join('\n\n') + '\n';
}

function emitZod(decls, o, warnings) {
  const exp = o.exportKeyword ? 'export ' : '';
  const declared = new Set();
  const names = new Set(decls.map(d => d.name));
  const ro = o.readonly ? '.readonly()' : '';
  const z = t => {
    switch (t.k) {
      case 'prim': return { string: 'z.string()', number: 'z.number()', boolean: 'z.boolean()', null: 'z.null()', Date: 'z.coerce.date()', undefined: 'z.undefined()', never: 'z.never()' }[t.n] || 'z.unknown()';
      case 'ref': if (!names.has(t.name)) return 'z.unknown()'; if (declared.has(t.name)) return `${t.name}Schema`; warnings.push(`${t.name} is used before it is defined (recursive or forward reference): wrapped in z.lazy(). Zod cannot infer a recursive type; annotate it with z.ZodType<${t.name}> if needed.`); return `z.lazy(() => ${t.name}Schema)`;
      case 'lit': return t.vals.every(v => typeof v === 'string') && t.vals.length > 0 ? (t.vals.length === 1 ? `z.literal(${litText(t.vals[0])})` : `z.enum([${t.vals.map(litText).join(', ')}])`)
        : t.vals.length === 1 ? `z.literal(${litText(t.vals[0])})` : `z.union([${t.vals.map(v => `z.literal(${litText(v)})`).join(', ')}])`;
      case 'arr': return `z.array(${z(t.e)})${ro}`;
      case 'index': return `z.record(z.string(), ${z(t.v)})`;
      case 'union': {
        let ms = t.ms, nullable = false, optional = false;
        if (ms.some(m => m.k === 'prim' && m.n === 'null')) { nullable = true; ms = ms.filter(m => !(m.k === 'prim' && m.n === 'null')); }
        if (ms.some(m => m.k === 'prim' && m.n === 'undefined')) { optional = true; ms = ms.filter(m => !(m.k === 'prim' && m.n === 'undefined')); }
        const lits = ms.filter(m => m.k === 'lit'), rest = ms.filter(m => m.k !== 'lit');
        const flat = [...rest.map(z), ...lits.flatMap(l => l.vals.map(v => `z.literal(${litText(v)})`))];
        let s = flat.length === 0 ? 'z.never()' : flat.length === 1 ? flat[0] : `z.union([${flat.join(', ')}])`;
        if (nullable) s += '.nullable()';
        if (optional) s += '.optional()';
        return s;
      }
      default: return 'z.unknown()';
    }
  };
  const out = [`import { z } from "zod";`];
  const blocks = [];
  for (const d of decls) {
    let schema;
    if (d.kind === 'alias') schema = z(d.t);
    else if (d.props.length === 0 && d.index) schema = z({ k: 'index', v: d.index });
    else {
      const lines = d.props.map(p => {
        let s = z(p.t); if (p.opt) s += '.optional()';
        if (o.comments && p.doc) s += `.describe(${JSON.stringify(p.doc)})`;
        return `  ${keyText(p.key, o)}: ${s},`;
      });
      schema = lines.length ? `z.object({\n${lines.join('\n')}\n})${ro}` : `z.object({})${ro}`;
      if (d.index) schema = `${schema.replace(/\)(\.readonly\(\))?$/, ')')}.catchall(${z(d.index)})${ro}`;
    }
    declared.add(d.name);
    blocks.push(`${exp}const ${d.name}Schema = ${schema};\n${exp}type ${d.name} = z.infer<typeof ${d.name}Schema>;`);
  }
  return out.concat(blocks).join('\n\n') + '\n';
}

function emitJsdoc(decls, o, warnings) {
  if (o.readonly) warnings.push('JSDoc has no readonly modifier: the "readonly" option is ignored for this target.');
  const type = t => {
    switch (t.k) {
      case 'prim': return t.n === 'unknown' ? '*' : t.n;
      case 'ref': return t.name;
      case 'lit': return t.vals.map(litText).join('|');
      case 'arr': return `Array<${type(t.e)}>`;
      case 'index': return `Object<string, ${type(t.v)}>`;
      case 'union': { const seen = new Set(); return t.ms.map(type).filter(s => !seen.has(s) && seen.add(s)).join('|'); }
      default: return '*';
    }
  };
  const nameText = (k, opt) => { const n = /\s/.test(k) ? JSON.stringify(k) : k; return opt ? `[${n}]` : n; };
  const out = [];
  for (const d of decls) {
    if (d.kind === 'alias') { out.push(`/** @typedef {${type(d.t)}} ${d.name} */`); continue; }
    const lines = [`/**`, ...(o.comments && d.doc ? [` * ${String(d.doc).replace(/\r?\n/g, ' ').replace(/\*\//g, '* /')}`] : []), ` * @typedef {Object} ${d.name}`];
    for (const p of d.props) lines.push(` * @property {${type(p.t)}} ${nameText(p.key, p.opt)}${o.comments && p.doc ? ' - ' + String(p.doc).replace(/\r?\n/g, ' ').replace(/\*\//g, '* /') : ''}`);
    if (d.index) lines.push(` * @property {${type(d.index)}} [key: string] - additional properties`);
    lines.push(' */');
    out.push(lines.join('\n'));
  }
  return out.join('\n\n') + '\n';
}

export function emit(decls, options = {}, warnings = []) {
  const o = normalizeOptions(options);
  if (o.target === 'zod') return emitZod(decls, o, warnings);
  if (o.target === 'jsdoc') return emitJsdoc(decls, o, warnings);
  return emitTypeScript(decls, o);
}

// =============================================================== JSON Schema (basic)
const pointerGet = (root, ref) => {
  if (ref === '#') return root;
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    const k = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
};

/** JSON Schema (draft-07 / 2019 / 2020 basics) -> declarations. */
export function schemaToDecls(schema, options = {}, warnings = []) {
  const o = normalizeOptions(options);
  const rootName = safeRoot(o);
  const alloc = makeNamer(rootName);
  const decls = [], refNames = new Map(), inProgress = new Set();
  const warned = new Set();
  const warn = m => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
  const UNSUPPORTED = ['patternProperties', 'if', 'then', 'else', 'not', 'dependencies', 'dependentSchemas', 'propertyNames', 'unevaluatedProperties', 'contains', 'prefixItems'];

  const dateFmt = f => f === 'date-time' || f === 'date';
  function refTarget(ref, hint) {
    if (typeof ref !== 'string' || !ref.startsWith('#')) { warn(`Only local "$ref" values (starting with #) are supported; "${ref}" became unknown.`); return P('unknown'); }
    if (refNames.has(ref)) return { k: 'ref', name: refNames.get(ref) };
    const target = pointerGet(schema, ref);
    if (target === undefined) { warn(`$ref "${ref}" could not be resolved; it became unknown.`); return P('unknown'); }
    if (ref === '#') { refNames.set(ref, rootName); return { k: 'ref', name: rootName }; }
    const seg = decodeURIComponent(ref.split('/').pop());
    const name = alloc(seg || hint);
    refNames.set(ref, name);
    declareNamed(name, target, seg || hint);
    return { k: 'ref', name };
  }
  function declareNamed(name, s, hint) {
    const isObj = s && typeof s === 'object' && (s.properties || s.type === 'object' || s.allOf || (s.additionalProperties && typeof s.additionalProperties === 'object')) && !s.$ref && !s.anyOf && !s.oneOf && !s.enum;
    if (isObj) { lowerObjectInto(name, s, hint); return; }
    const t = lowerS(s, hint);
    decls.push({ name, kind: 'alias', t, doc: s && typeof s === 'object' ? s.description : undefined });
  }
  function collectObject(s) { // merge allOf objects (shallow)
    const merged = { properties: {}, required: [], additionalProperties: undefined, description: s.description };
    const add = part => {
      if (!part || typeof part !== 'object') return;
      let p = part;
      if (p.$ref) { const t = typeof p.$ref === 'string' && p.$ref.startsWith('#') ? pointerGet(schema, p.$ref) : undefined; if (t === undefined) { warn(`allOf member $ref "${p.$ref}" could not be merged.`); return; } p = t; }
      if (p.allOf) p.allOf.forEach(add);
      Object.assign(merged.properties, p.properties || {});
      if (Array.isArray(p.required)) merged.required.push(...p.required);
      if (p.additionalProperties !== undefined) merged.additionalProperties = p.additionalProperties;
      if (!merged.description && p.description) merged.description = p.description;
    };
    add({ properties: s.properties, required: s.required, additionalProperties: s.additionalProperties });
    if (s.allOf) s.allOf.forEach(add);
    return merged;
  }
  function lowerObjectInto(name, s, hint) {
    const entry = { name, kind: 'obj', props: [], index: null, doc: s.description };
    const placeholderIndex = decls.length; decls.push(entry); // keeps order stable; dependencies are re-sorted below
    const m = collectObject(s);
    entry.doc = m.description;
    for (const [key, ps] of Object.entries(m.properties)) {
      const t = lowerS(ps, key);
      entry.props.push({ key, t, opt: !m.required.includes(key), doc: ps && typeof ps === 'object' ? ps.description : undefined });
    }
    const ap = m.additionalProperties;
    if (ap && typeof ap === 'object') entry.index = lowerS(ap, singular(hint));
    else if (ap === true && entry.props.length === 0) entry.index = P('unknown');
    void placeholderIndex;
    return { k: 'ref', name };
  }
  function lowerS(s, hint) {
    if (s === true || s === undefined || s === null) return P('unknown');
    if (s === false) return P('never');
    if (typeof s !== 'object') return P('unknown');
    for (const kw of UNSUPPORTED) if (kw in s) warn(`The "${kw}" keyword is not supported and was ignored.`);
    if (s.$ref) return refTarget(s.$ref, hint);
    if (Array.isArray(s.enum)) {
      const vals = s.enum.filter(v => v === null || ['string', 'number', 'boolean'].includes(typeof v));
      if (vals.length !== s.enum.length) warn('Enum values that are objects or arrays were ignored.');
      return vals.length ? { k: 'lit', vals } : P('unknown');
    }
    if ('const' in s) return s.const === null || ['string', 'number', 'boolean'].includes(typeof s.const) ? { k: 'lit', vals: [s.const] } : P('unknown');
    const unionOf = list => {
      const parts = [];
      list.forEach((x, i) => { const ir = lowerS(x, list.length > 1 && x && x.properties ? `${hint}${i + 1}` : hint); for (const y of ir.k === 'union' ? ir.ms : [ir]) if (!parts.some(p => irSig(p) === irSig(y))) parts.push(y); });
      parts.sort((a, b) => (a.k === 'prim' && a.n === 'null') - (b.k === 'prim' && b.n === 'null'));
      return parts.length === 1 ? parts[0] : { k: 'union', ms: parts };
    };
    if (Array.isArray(s.anyOf)) return unionOf(s.anyOf);
    if (Array.isArray(s.oneOf)) return unionOf(s.oneOf);
    let t = s.type;
    if (Array.isArray(t)) {
      const parts = t.map(x => lowerS({ ...s, type: x }, hint));
      parts.sort((a, b) => (a.k === 'prim' && a.n === 'null') - (b.k === 'prim' && b.n === 'null'));
      return parts.length === 1 ? parts[0] : { k: 'union', ms: parts };
    }
    if (!t) t = s.properties || s.allOf ? 'object' : s.items ? 'array' : undefined;
    let ir;
    switch (t) {
      case 'string': ir = P(o.dateMode === 'Date' && dateFmt(s.format) ? 'Date' : 'string'); break;
      case 'number': case 'integer': ir = P('number'); break;
      case 'boolean': ir = P('boolean'); break;
      case 'null': ir = P('null'); break;
      case 'array': {
        let items = s.items;
        if (Array.isArray(items)) { warn('Tuple-style "items" arrays are approximated by an array of the union of their types.'); ir = { k: 'arr', e: unionOf(items) }; }
        else ir = { k: 'arr', e: lowerS(items, singular(hint)) };
        break;
      }
      case 'object': {
        const m = collectObject(s);
        if (Object.keys(m.properties).length === 0 && m.additionalProperties && typeof m.additionalProperties === 'object') { ir = { k: 'index', v: lowerS(m.additionalProperties, singular(hint)) }; break; }
        if (Object.keys(m.properties).length === 0 && !s.allOf) { ir = m.additionalProperties === false ? { k: 'index', v: P('never') } : { k: 'index', v: P('unknown') }; break; }
        const name = alloc(hint);
        lowerObjectInto(name, s, hint);
        ir = { k: 'ref', name };
        break;
      }
      default: ir = P('unknown');
    }
    if (s.nullable === true) ir = { k: 'union', ms: [ir, P('null')] };
    return ir;
  }

  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) { warn('A JSON Schema must be an object.'); return [{ name: rootName, kind: 'alias', t: P('unknown') }]; }
  const defs = { ...(schema.definitions || {}), ...(schema.$defs || {}) };
  const isObjRoot = !schema.$ref && (schema.properties || schema.type === 'object' || schema.allOf) && !schema.anyOf && !schema.oneOf && !schema.enum;
  let rootIr = null;
  refNames.set('#', rootName);
  if (isObjRoot) lowerObjectInto(rootName, schema, rootName);
  else { rootIr = lowerS(schema, rootName); }
  // every definition is declared too (even if unreferenced)
  for (const key of Object.keys(schema.definitions || {})) refTarget(`#/definitions/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, key);
  for (const key of Object.keys(schema.$defs || {})) refTarget(`#/$defs/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, key);
  void defs; void inProgress;
  if (rootIr) decls.push({ name: rootName, kind: 'alias', t: rootIr, doc: schema.description });
  return sortDecls(decls, rootName);
}

/** Order declarations so dependencies come first (cycles are left as they are); the root goes last. */
function sortDecls(decls, rootName) {
  const byName = new Map(decls.map(d => [d.name, d]));
  const deps = d => {
    const out = new Set();
    const walk = t => { if (!t) return; if (t.k === 'ref') out.add(t.name); else if (t.k === 'arr') walk(t.e); else if (t.k === 'index') walk(t.v); else if (t.k === 'union') t.ms.forEach(walk); };
    if (d.kind === 'alias') walk(d.t); else { d.props.forEach(p => walk(p.t)); walk(d.index); }
    return out;
  };
  const done = new Set(), visiting = new Set(), out = [];
  const visit = d => {
    if (done.has(d.name) || visiting.has(d.name)) return;
    visiting.add(d.name);
    for (const n of deps(d)) { const x = byName.get(n); if (x && n !== d.name) visit(x); }
    visiting.delete(d.name); done.add(d.name); out.push(d);
  };
  for (const d of decls) if (d.name !== rootName) visit(d);
  if (byName.has(rootName)) visit(byName.get(rootName));
  return out;
}

// =============================================================== public API
/** Infer declarations from already-parsed values (several values = several samples merged into one type). */
export function valuesToDecls(values, options = {}, warnings = []) {
  const o = normalizeOptions(options);
  const rootName = safeRoot(o);
  const state = { deep: false };
  let samples = values;
  if (o.arrayAsSamples && values.length === 1 && Array.isArray(values[0])) samples = values[0];
  let type = null;
  for (const v of samples) type = mergeTypes(type, infer(v, o, 0, state), o);
  if (!type) type = prim('unknown');
  if (state.deep) warnings.push(`Nesting deeper than ${LIMITS.maxDepth} levels was typed as unknown.`);
  return lowerInferred(type, o, rootName);
}

const isSchemaLike = v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$schema === 'string';

/**
 * Main entry point.  generate(text, options) -> { ok, code, warnings, stats, format, samples } | { ok:false, error:{message,line,column,offset,snippet} }
 * options.format: 'auto' | 'json' | 'multi' (JSON Lines / several documents) | 'schema'
 */
export function generate(input, options = {}) {
  const o = normalizeOptions(options);
  const warnings = [];
  const text = String(input ?? '');
  if (!text.trim()) return { ok: false, error: { message: 'Paste some JSON, JSON Lines or a JSON Schema first.', line: 1, column: 1, offset: 0, snippet: null, empty: true } };
  const fmt = o.format;
  const parsed = parseDocuments(text, { single: fmt === 'json' || fmt === 'schema' });
  if (parsed.error) {
    const e = parsed.error;
    return { ok: false, error: { message: e.message, line: e.line, column: e.column, offset: e.offset, snippet: e.snippet } };
  }
  const values = parsed.docs.map(d => d.value);
  let format = fmt;
  if (fmt === 'auto') format = values.length > 1 ? 'multi' : isSchemaLike(values[0]) ? 'schema' : 'json';
  let decls;
  if (format === 'schema') {
    decls = schemaToDecls(values[0], o, warnings);
    if (values.length > 1) warnings.push('Only the first document was used as the JSON Schema.');
  } else {
    if (format === 'multi' && values.length > 1) warnings.push(`${values.length} JSON documents were merged into one type; properties missing from some documents are optional.`);
    decls = valuesToDecls(values, o, warnings);
  }
  const code = emit(decls, o, warnings);
  const stats = {
    format, samples: format === 'schema' ? 1 : (o.arrayAsSamples && values.length === 1 && Array.isArray(values[0]) ? values[0].length : values.length),
    declarations: decls.length, properties: decls.reduce((n, d) => n + (d.props ? d.props.length : 0), 0),
    optional: decls.reduce((n, d) => n + (d.props ? d.props.filter(p => p.opt).length : 0), 0), bytes: text.length, lines: code.split('\n').length - 1,
  };
  return { ok: true, code, warnings, stats, format, decls };
}

/** Convenience for tests / other tools: values in, code out. */
export function valuesToCode(values, options = {}) {
  const warnings = [];
  const o = normalizeOptions(options);
  return emit(valuesToDecls(values, o, warnings), o, warnings);
}
export function fileExtension(target, kind = 'ts') {
  if (target === 'jsdoc') return 'js';
  return kind === 'dts' ? 'd.ts' : 'ts';
}
