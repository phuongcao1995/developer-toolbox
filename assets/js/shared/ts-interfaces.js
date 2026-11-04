// JSON -> TypeScript declarations. Pure ES module, no dependencies, no DOM.
//
//   import { jsonToTypeScript } from './ts-interfaces.js';
//   jsonToTypeScript({ a: 1, items: [{ id: 1 }, { id: 2, tag: 'x' }] }, { rootName: 'Doc' });
//
// Options (all optional):
//   rootName          'Root'  name of the top-level declaration
//   exportKeyword     true    prefix declarations with `export`
//   optionalFromArrays true   properties missing in some array elements become optional (`?`);
//                             when false they are typed `T | undefined` instead
//   useInterface      true    `interface X {}` (false -> `type X = {}`)
//   readonly          false   `readonly` properties and `readonly T[]` arrays
//   dateAsString      true    ISO date strings stay `string` (false -> `Date`)
//   mergeArrayShapes  true    objects inside one array are merged into one interface (false -> union of distinct shapes)
//
// Behaviour: nested objects become named interfaces (PascalCase from the key, collision-safe, structurally identical
// interfaces are shared), arrays get a merged element type, mixed arrays become unions, empty arrays are `unknown[]`,
// keys that are not identifiers are quoted. Numbers are always `number` (JSON big numbers included).

const RESERVED_NAMES = new Set(['Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Record', 'Promise', 'Map', 'Set', 'Function', 'Symbol',
  'Error', 'Partial', 'Readonly', 'Pick', 'Omit', 'RegExp', 'BigInt', 'any', 'unknown', 'never', 'void', 'null', 'undefined', 'string', 'number',
  'boolean', 'object', 'symbol', 'bigint', 'true', 'false', 'class', 'enum', 'interface', 'type', 'default', 'new', 'delete', 'function', 'var', 'let', 'const']);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
const own = Object.prototype.hasOwnProperty;
const isObj = v => v !== null && typeof v === 'object';

/** 'user_name' / 'user-name' / 'userName' -> 'UserName'; never empty, never starts with a digit. */
export function toPascalCase(s) {
  const words = String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let out = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
  if (!out) out = 'Item';
  if (/^\d/.test(out)) out = 'T' + out;
  return out;
}

function singular(name) {
  if (/ies$/i.test(name) && name.length > 4) return name.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(name)) return name;
  if (/ses$|xes$|ches$|shes$/i.test(name) && name.length > 4) return name.slice(0, -2);
  if (/s$/i.test(name) && name.length > 3) return name.slice(0, -1);
  return name;
}

// ---- type model: {k:'p', n} | {k:'o', props: Map<key,{t,opt}>} | {k:'a', e: type|null} | {k:'u', ms: type[]}
const prim = n => ({ k: 'p', n });

function members(t) { return t.k === 'u' ? t.ms : [t]; }
function shapeSig(t, d = 0) {
  if (d > 100) return '~';
  if (t.k === 'p') return t.n;
  if (t.k === 'a') return '[' + (t.e ? shapeSig(t.e, d + 1) : '') + ']';
  if (t.k === 'u') return t.ms.map(m => shapeSig(m, d + 1)).sort().join('|');
  return '{' + [...t.props].map(([k, p]) => JSON.stringify(k) + (p.opt ? '?' : '') + ':' + shapeSig(p.t, d + 1)).join(',') + '}';
}

function mergeTypes(a, b, o) {
  if (!a) return b;
  if (!b) return a;
  const out = [];
  for (const m of [...members(a), ...members(b)]) {
    let done = false;
    for (let i = 0; i < out.length && !done; i++) {
      const x = out[i];
      if (x.k === 'p' && m.k === 'p' && x.n === m.n) done = true;
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
    props.set(k, q ? { t: mergeTypes(p.t, q.t, o), opt: p.opt || q.opt } : missing(p, o));
  }
  for (const [k, q] of y.props) if (!x.props.has(k)) props.set(k, missing(q, o));
  return { k: 'o', props };
}
function missing(p, o) {
  if (p.opt) return p;
  return o.optionalFromArrays ? { t: p.t, opt: true } : { t: mergeTypes(p.t, prim('undefined'), o), opt: false };
}

function infer(v, o, depth = 0) {
  if (depth > 200) return prim('unknown');
  if (v === null) return prim('null');
  switch (typeof v) {
    case 'string': return prim(!o.dateAsString && ISO_DATE.test(v) ? 'Date' : 'string');
    case 'number': return prim('number');
    case 'boolean': return prim('boolean');
    case 'object': break;
    default: return prim('unknown');
  }
  if (Array.isArray(v)) {
    let e = null;
    for (const x of v) e = mergeTypes(e, infer(x, o, depth + 1), o);
    return { k: 'a', e };
  }
  const props = new Map();
  for (const k of Object.keys(v)) props.set(k, { t: infer(v[k], o, depth + 1), opt: false });
  return { k: 'o', props };
}

/** Infer the (unnamed) type model of a JSON value. Exposed for reuse/testing. */
export function inferType(value, options = {}) {
  return infer(value, normalize(options));
}

function normalize(options) {
  return {
    rootName: 'Root', exportKeyword: true, optionalFromArrays: true, useInterface: true, readonly: false, dateAsString: true, mergeArrayShapes: true,
    ...options,
  };
}

/** Convert a JSON value (or JSON text) to TypeScript declarations. Throws SyntaxError for invalid JSON text. */
export function jsonToTypeScript(input, options = {}) {
  const o = normalize(options);
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  let rootName = toPascalCase(o.rootName || 'Root');
  if (RESERVED_NAMES.has(rootName)) rootName += 'Type';
  const type = infer(value, o);
  const used = new Set([rootName]); // names in use
  const bySig = new Map(); // body text -> name
  const decls = [];
  const exp = o.exportKeyword ? 'export ' : '';
  const ro = o.readonly ? 'readonly ' : '';

  const allocate = hint => {
    let base = toPascalCase(hint);
    if (RESERVED_NAMES.has(base)) base += 'Type';
    let name = base, n = 2;
    while (used.has(name)) name = base + n++;
    used.add(name); return name;
  };
  const keyText = k => IDENT.test(k) ? k : JSON.stringify(k);

  /** Returns {s, union} where union = needs parens inside an array type. */
  function render(t, hint) {
    if (t.k === 'p') return { s: t.n, union: false };
    if (t.k === 'a') {
      if (!t.e) return { s: o.readonly ? 'readonly unknown[]' : 'unknown[]', union: false };
      const el = render(t.e, singular(hint));
      const inner = el.union ? `(${el.s})` : el.s;
      return { s: o.readonly ? `readonly ${inner}[]` : `${inner}[]`, union: false };
    }
    if (t.k === 'u') {
      const ms = [...t.ms].sort((a, b) => (a.k === 'p' && a.n === 'null') - (b.k === 'p' && b.n === 'null'));
      // when several objects survive (mergeArrayShapes=false) they each need their own name
      const parts = ms.map((m, i) => render(m, ms.filter(x => x.k === 'o').length > 1 ? `${hint}${i + 1}` : hint));
      const seen = new Set();
      const uniq = parts.map(p => p.s).filter(s => !seen.has(s) && seen.add(s));
      return { s: uniq.join(' | '), union: uniq.length > 1 };
    }
    return { s: declare(t, hint, false), union: false };
  }

  function declare(t, hint, isRoot) {
    const lines = [];
    for (const [k, p] of t.props) {
      const r = render(p.t, k);
      lines.push(`  ${ro}${keyText(k)}${p.opt ? '?' : ''}: ${r.s};`);
    }
    const body = lines.length ? `{\n${lines.join('\n')}\n}` : '{}';
    if (!isRoot && bySig.has(body)) return bySig.get(body);
    const name = isRoot ? rootName : allocate(hint);
    if (!isRoot) bySig.set(body, name);
    decls.push(o.useInterface ? `${exp}interface ${name} ${body}` : `${exp}type ${name} = ${body};`);
    return name;
  }

  if (type.k === 'o') declare(type, rootName, true);
  else decls.push(`${exp}type ${rootName} = ${render(type, type.k === 'a' ? rootName + 'Item' : rootName).s};`);
  // post-order: dependencies were pushed before the root declaration
  return decls.join('\n\n') + '\n';
}

export default jsonToTypeScript;
