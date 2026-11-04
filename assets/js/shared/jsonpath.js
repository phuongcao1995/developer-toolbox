// JSONPath (RFC 9535 subset). Pure ES module, no dependencies, NO eval / new Function.
//
// Supported: $  .name  ['name']  [n] (negative ok)  [a:b:c] slices  *  .. (recursive descent)
//   [?(<expr>)] / [?<expr>] filters with: @ and $ paths, literals (number, 'str', "str", true, false, null),
//   ==  !=  <  <=  >  >=  in  =~ /re/flags  &&  ||  !  ( )  and the functions length(x) count(x).
//   Several selectors may be unioned in one bracket: ['a','b'], [0,2], [1:3, 'x'].
// Not supported: the full RFC function extensions (match/search/value), non-singular comparison semantics.
// Limits: MAX_RESULTS results, MAX_DEPTH nesting for descent / filter parentheses.

export const MAX_RESULTS = 10000;
export const MAX_DEPTH = 1000;
export const MAX_QUERY_LENGTH = 10000;

export class JSONPathError extends Error {
  constructor(message, position) {
    super(`${message} (at position ${position})`);
    this.name = 'JSONPathError';
    this.position = position;
    this.detail = message;
  }
}

const own = Object.prototype.hasOwnProperty;
const isObj = v => v !== null && typeof v === 'object';
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Format a path (array of string|number segments) as `$.a[0].b` / `$['odd key']`. */
export function formatPath(segs) {
  let s = '$';
  for (const k of segs) {
    if (typeof k === 'number') s += `[${k}]`;
    else if (IDENT.test(k)) s += '.' + k;
    else s += `['${String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  return s;
}

// ------------------------------------------------------------------ parser
const isNameStart = c => /[A-Za-z_\u0080-￿]/.test(c);
const isNameChar = c => /[A-Za-z0-9_\-\u0080-￿$]/.test(c);

/** Parse a query into {segments:[{desc:boolean, selectors:[...]}]}. Throws JSONPathError. */
export function parse(query) {
  if (typeof query !== 'string') throw new JSONPathError('Query must be a string', 0);
  if (query.length > MAX_QUERY_LENGTH) throw new JSONPathError(`Query too long (max ${MAX_QUERY_LENGTH} characters)`, MAX_QUERY_LENGTH);
  const src = query;
  let i = 0;
  const err = (m, p = i) => { throw new JSONPathError(m, p); };
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function readString() {
    const q = src[i]; const start = i; i++;
    let out = '';
    for (;;) {
      if (i >= src.length) err('Unterminated string', start);
      const c = src[i];
      if (c === q) { i++; return out; }
      if (c === '\\') {
        const e = src[i + 1];
        if (e === undefined) err('Unterminated string', start);
        const map = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '/': '/', '\\': '\\', "'": "'", '"': '"' };
        if (e === 'u') {
          const h = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) err('Bad \\u escape', i);
          out += String.fromCharCode(parseInt(h, 16)); i += 6;
        } else if (own.call(map, e)) { out += map[e]; i += 2; }
        else err(`Bad escape '\\${e}'`, i);
      } else { out += c; i++; }
    }
  }
  const readInt = () => {
    const m = /^-?(0|[1-9]\d*)/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) err('Integer out of range', i - m[0].length);
    return n;
  };
  function readName() {
    const start = i;
    if (i >= src.length || !isNameStart(src[i])) err('Expected a member name', i);
    while (i < src.length && isNameChar(src[i])) i++;
    return src.slice(start, i);
  }

  // ---- filter expressions (recursive descent; depth bounded)
  let depth = 0;
  function parseOr() {
    let l = parseAnd();
    for (;;) { ws(); if (src.startsWith('||', i)) { i += 2; l = { t: 'or', l, r: parseAnd() }; } else return l; }
  }
  function parseAnd() {
    let l = parseUnary();
    for (;;) { ws(); if (src.startsWith('&&', i)) { i += 2; l = { t: 'and', l, r: parseUnary() }; } else return l; }
  }
  function parseUnary() {
    ws();
    if (src[i] === '!' && src[i + 1] !== '=') { i++; if (++depth > 200) err('Expression nested too deeply'); const e = parseUnary(); depth--; return { t: 'not', e }; }
    return parseComparison();
  }
  function parseComparison() {
    const l = parsePrimary();
    ws();
    const m = /^(==|!=|<=|>=|<|>|=~|in(?![A-Za-z0-9_]))/.exec(src.slice(i, i + 3));
    if (!m) return l;
    const op = m[1]; const opPos = i; i += op.length;
    ws();
    if (op === '=~') {
      if (src[i] === '/') {
        const start = i; i++;
        let body = '';
        for (;;) {
          if (i >= src.length) err('Unterminated regular expression', start);
          if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
          if (src[i] === '/') break;
          body += src[i++];
        }
        i++;
        const fm = /^[gimsuy]*/.exec(src.slice(i))[0]; i += fm.length;
        let re; try { re = new RegExp(body, fm.replace('g', '').replace('y', '')); } catch (e) { err('Invalid regular expression: ' + e.message, start); }
        return { t: 'cmp', op, l, r: { t: 'regex', re } };
      }
      const r = parsePrimary();
      return { t: 'cmp', op, l, r };
    }
    const r = parsePrimary();
    ws();
    void opPos;
    return { t: 'cmp', op, l, r };
  }
  function parsePrimary() {
    ws();
    const c = src[i];
    if (c === undefined) err('Unexpected end of expression');
    if (c === '(') {
      i++; if (++depth > 200) err('Expression nested too deeply');
      const e = parseOr(); ws();
      if (src[i] !== ')') err("Expected ')'");
      i++; depth--; return e;
    }
    if (c === '@' || c === '$') { i++; const segs = parseSegments(false); return { t: 'path', abs: c === '$', segs }; }
    if (c === "'" || c === '"') return { t: 'lit', v: readString() };
    if (c === '[') { // array literal
      i++; const items = []; ws();
      if (src[i] === ']') { i++; return { t: 'lit', v: items }; }
      for (;;) {
        const p = parsePrimary();
        if (p.t !== 'lit') err('Array literals may only contain literals');
        items.push(p.v); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; break; }
        err("Expected ',' or ']'");
      }
      return { t: 'lit', v: items };
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) err('Invalid number');
      i += m[0].length; return { t: 'lit', v: Number(m[0]) };
    }
    if (isNameStart(c)) {
      const start = i; const name = readName();
      if (name === 'true') return { t: 'lit', v: true };
      if (name === 'false') return { t: 'lit', v: false };
      if (name === 'null') return { t: 'lit', v: null };
      if (src[i] === '(') {
        if (name !== 'length' && name !== 'count') err(`Unknown function '${name}' (supported: length, count)`, start);
        i++; const arg = parseOr(); ws();
        if (src[i] !== ')') err("Expected ')'");
        i++; return { t: 'fn', name, arg };
      }
      err(`Unexpected identifier '${name}'`, start);
    }
    err(`Unexpected character '${c}'`);
  }

  // ---- selectors / segments
  function parseBracket() {
    // at '[' already consumed
    const sels = [];
    for (;;) {
      ws();
      const c = src[i];
      if (c === undefined) err("Missing ']'");
      if (c === '*') { i++; sels.push({ t: 'wild' }); }
      else if (c === "'" || c === '"') sels.push({ t: 'name', name: readString() });
      else if (c === '?') {
        i++; ws();
        const e = parseOr();
        sels.push({ t: 'filter', e });
      } else if (c === '-' || c === ':' || (c >= '0' && c <= '9')) {
        const start = i;
        const a = readInt(); ws();
        if (src[i] === ':') {
          i++; ws(); const b = /^-?\d/.test(src.slice(i, i + 2)) ? readInt() : null; ws();
          let st = null;
          if (src[i] === ':') { i++; ws(); st = /^-?\d/.test(src.slice(i, i + 2)) ? readInt() : null; ws(); }
          sels.push({ t: 'slice', start: a, end: b, step: st });
        } else if (a === null) err('Expected an index or slice', start);
        else sels.push({ t: 'index', index: a });
      } else err(`Unexpected character '${c}' in bracket selector`);
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return sels; }
      err(src[i] === undefined ? "Missing ']'" : `Expected ',' or ']' but found '${src[i]}'`);
    }
  }
  function parseSegments(top) {
    const segs = [];
    for (;;) {
      if (i >= src.length) break;
      if (!top) { // inside a filter: stop at anything that is not part of the path
        const c = src[i];
        if (c !== '.' && c !== '[') break;
      }
      const c = src[i];
      if (c === '.') {
        if (src[i + 1] === '.') {
          i += 2;
          if (src[i] === '[') { i++; segs.push({ desc: true, selectors: parseBracket() }); }
          else if (src[i] === '*') { i++; segs.push({ desc: true, selectors: [{ t: 'wild' }] }); }
          else segs.push({ desc: true, selectors: [{ t: 'name', name: readName() }] });
        } else {
          i++;
          if (src[i] === '*') { i++; segs.push({ desc: false, selectors: [{ t: 'wild' }] }); }
          else segs.push({ desc: false, selectors: [{ t: 'name', name: readName() }] });
        }
      } else if (c === '[') { i++; segs.push({ desc: false, selectors: parseBracket() }); }
      else if (/\s/.test(c) && top) { ws(); if (i < src.length) err(`Unexpected character '${src[i]}'`); }
      else err(`Unexpected character '${c}'`);
    }
    return segs;
  }

  ws();
  if (src[i] !== '$') err("A JSONPath query must start with '$'", i);
  i++;
  const segments = parseSegments(true);
  return { segments };
}

// ------------------------------------------------------------------ evaluation
const MISSING = Symbol('missing');

function normSlice(sel, len) {
  const step = sel.step ?? 1;
  if (step === 0) return null;
  const norm = x => (x < 0 ? len + x : x);
  let lo, hi;
  if (step > 0) {
    const s = norm(sel.start ?? 0), e = norm(sel.end ?? len);
    lo = Math.min(Math.max(s, 0), len); hi = Math.min(Math.max(e, 0), len);
  } else {
    const s = norm(sel.start ?? len - 1), e = sel.end == null ? -len - 1 : norm(sel.end);
    hi = Math.min(Math.max(s, -1), len - 1); lo = Math.min(Math.max(e, -1), len - 1);
  }
  return { step, lo, hi };
}

function jsonEqual(a, b, d = 0) {
  if (a === b) return true;
  if (typeof a !== typeof b || !isObj(a) || !isObj(b) || d > 200) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!own.call(b, k) || !jsonEqual(a[k], b[k], d + 1)) return false;
  return true;
}

function evalOperand(n, cur, root, ctx) {
  switch (n.t) {
    case 'lit': return n.v;
    case 'regex': return n.re;
    case 'path': {
      const nodes = run(n.segs, [{ path: [], value: n.abs ? root : cur }], ctx, true);
      return nodes.length ? nodes[0].value : MISSING;
    }
    case 'fn': {
      if (n.name === 'count') {
        if (n.arg.t !== 'path') return MISSING;
        return run(n.arg.segs, [{ path: [], value: n.arg.abs ? root : cur }], ctx, true).length;
      }
      const v = evalOperand(n.arg, cur, root, ctx);
      if (typeof v === 'string') return [...v].length;
      if (Array.isArray(v)) return v.length;
      if (isObj(v)) return Object.keys(v).length;
      return MISSING;
    }
    default: return truthy(n, cur, root, ctx);
  }
}

function truthy(n, cur, root, ctx) {
  switch (n.t) {
    case 'or': return truthy(n.l, cur, root, ctx) || truthy(n.r, cur, root, ctx);
    case 'and': return truthy(n.l, cur, root, ctx) && truthy(n.r, cur, root, ctx);
    case 'not': return !truthy(n.e, cur, root, ctx);
    case 'cmp': return compare(n, cur, root, ctx);
    case 'path': {
      // existence test
      return run(n.segs, [{ path: [], value: n.abs ? root : cur }], ctx, true).length > 0;
    }
    case 'lit': return !!n.v;
    case 'fn': { const v = evalOperand(n, cur, root, ctx); return v !== MISSING && v !== 0; }
    default: return false;
  }
}

function compare(n, cur, root, ctx) {
  const a = evalOperand(n.l, cur, root, ctx), b = evalOperand(n.r, cur, root, ctx);
  switch (n.op) {
    case '==': return a === MISSING || b === MISSING ? a === b : jsonEqual(a, b);
    case '!=': return !(a === MISSING || b === MISSING ? a === b : jsonEqual(a, b));
    case '<': case '<=': case '>': case '>=': {
      if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) return false;
      return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b;
    }
    case 'in': {
      if (a === MISSING || b === MISSING) return false;
      if (Array.isArray(b)) return b.some(x => jsonEqual(a, x));
      if (typeof b === 'string' && typeof a === 'string') return b.includes(a);
      if (isObj(b) && typeof a === 'string') return own.call(b, a);
      return false;
    }
    case '=~': {
      if (typeof a !== 'string' || b === MISSING) return false;
      let re = b instanceof RegExp ? b : typeof b === 'string' ? ctx.regexCache(b) : null;
      return re ? re.test(a) : false;
    }
    default: return false;
  }
}

function children(node) {
  const v = node.value;
  if (Array.isArray(v)) return v.map((x, i) => ({ path: node.path.concat(i), value: x }));
  if (isObj(v)) return Object.keys(v).map(k => ({ path: node.path.concat(k), value: v[k] }));
  return [];
}

function applySelectors(sels, node, root, ctx, out) {
  const v = node.value;
  const push = (k, val) => {
    if (ctx.count >= MAX_RESULTS) { ctx.truncated = true; return false; }
    out.push({ path: node.path.concat(k), value: val }); ctx.count++; return true;
  };
  for (const s of sels) {
    if (ctx.truncated && !ctx.inFilter) return;
    switch (s.t) {
      case 'name':
        if (isObj(v) && !Array.isArray(v) && own.call(v, s.name)) push(s.name, v[s.name]);
        break;
      case 'index':
        if (Array.isArray(v)) { const ix = s.index < 0 ? v.length + s.index : s.index; if (ix >= 0 && ix < v.length) push(ix, v[ix]); }
        break;
      case 'wild':
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (!push(i, v[i])) break; }
        else if (isObj(v)) { for (const k of Object.keys(v)) if (!push(k, v[k])) break; }
        break;
      case 'slice':
        if (Array.isArray(v)) {
          const r = normSlice(s, v.length);
          if (!r) break;
          if (r.step > 0) { for (let i = r.lo; i < r.hi; i += r.step) if (!push(i, v[i])) break; }
          else { for (let i = r.hi; i > r.lo; i += r.step) if (!push(i, v[i])) break; }
        }
        break;
      case 'filter':
        if (isObj(v)) {
          const kids = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.keys(v).map(k => [k, v[k]]);
          for (const [k, x] of kids) {
            if (++ctx.steps > ctx.maxSteps) { ctx.truncated = true; return; }
            if (truthy(s.e, x, root, ctx) && !push(k, x)) break;
          }
        }
        break;
      default: break;
    }
  }
}

function run(segs, start, root, ctxOrFlag, filterMode) {
  // overloaded: run(segs, nodes, ctx, true) from filters; run(segs, nodes, root, ctx) from query()
  let ctx, rootV;
  if (typeof ctxOrFlag === 'boolean') { ctx = root; rootV = ctx.root; }
  else { ctx = ctxOrFlag; rootV = root; }
  let nodes = start;
  const inner = typeof ctxOrFlag === 'boolean' || filterMode;
  const saved = ctx.inFilter;
  if (inner) ctx.inFilter = true;
  for (const seg of segs) {
    const out = [];
    const sub = inner ? { ...ctx } : ctx; // filters get their own result budget
    if (inner) { sub.count = 0; sub.truncated = false; sub.regexCache = ctx.regexCache; sub.root = ctx.root; }
    for (const node of nodes) {
      if (seg.desc) {
        // document-order traversal of node and all descendants (iterative, depth capped)
        const stack = [[node, 0]];
        while (stack.length) {
          const [cur, d] = stack.pop();
          applySelectors(seg.selectors, cur, rootV, sub, out);
          if (!inner && ctx.truncated) break;
          if (d >= MAX_DEPTH) { ctx.depthLimited = true; continue; }
          if (++ctx.steps > ctx.maxSteps) { ctx.truncated = true; break; }
          const kids = children(cur);
          for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1]);
        }
      } else applySelectors(seg.selectors, node, rootV, sub, out);
      if (!inner && ctx.truncated) break;
    }
    if (inner) { if (sub.truncated) ctx.truncated = true; ctx.steps = sub.steps ?? ctx.steps; }
    nodes = out;
  }
  ctx.inFilter = saved;
  return nodes;
}

/**
 * Run a JSONPath query. Returns [{path: 'a[0].b' style `$.a[0].b`, segments: [...], value}].
 * The array has .truncated = true when MAX_RESULTS (or the step budget) was hit, and .depthLimited when
 * recursive descent hit MAX_DEPTH. Throws JSONPathError (with .position) on a bad query.
 */
export function query(data, expr, opts = {}) {
  const parsed = typeof expr === 'string' ? parse(expr) : expr;
  const cache = new Map();
  const ctx = {
    count: 0, truncated: false, depthLimited: false, inFilter: false, steps: 0,
    maxSteps: opts.maxSteps ?? 5_000_000, root: data,
    regexCache: s => { if (!cache.has(s)) { let r = null; try { r = new RegExp(s); } catch { r = null; } cache.set(s, r); } return cache.get(s); },
  };
  const nodes = run(parsed.segments, [{ path: [], value: data }], data, ctx, false);
  const res = nodes.map(n => ({ path: formatPath(n.path), segments: n.path, value: n.value }));
  res.truncated = ctx.truncated; res.depthLimited = ctx.depthLimited;
  return res;
}

export default query;
