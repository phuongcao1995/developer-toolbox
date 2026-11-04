// Pure diff logic (no DOM). Pipeline:
//   split lines -> comparison keys (options) -> integer ids -> drop blank (optional) lines
//   -> common prefix/suffix trim -> drop lines present on one side only -> linear-space Myers (middle snake)
//   -> list of matched line pairs -> edit script. Everything not matched is a deletion / insertion,
//   so the result is always a true minimal (shortest edit script) diff - never a "replace everything" fallback.

export const DEFAULT_OPTS = Object.freeze({
  ignoreCase: false,
  ws: 'none',            // 'none' | 'edges' | 'collapse' | 'all'
  ignoreBlank: false,
  ignoreEol: true,       // CRLF vs LF differences are ignored (a notice is shown when they differ)
  trimTrailing: false,
});
/** Options that make the comparison exact (used for patch export). */
export const EXACT_OPTS = Object.freeze({ ignoreCase: false, ws: 'none', ignoreBlank: false, ignoreEol: false, trimTrailing: false });

export const MAX_INLINE_LEN = 5000;
export const WORKER_LINE_THRESHOLD = 20000;

export const hasIgnoreOptions = o => !!(o && (o.ignoreCase || (o.ws && o.ws !== 'none') || o.ignoreBlank || o.trimTrailing));

// ---------- lines ----------
/**
 * Split on "\n". A "\r" directly before it is the CRLF marker (eol = '\r\n'); a lone "\r" inside a line stays content,
 * so the original text can always be reproduced exactly. A last line without terminator has eol = ''.
 */
export function splitLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const parts = s.split('\n');
  const last = parts.pop();
  const lines = new Array(parts.length + (last === '' ? 0 : 1));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    lines[i] = p.charCodeAt(p.length - 1) === 13 ? { text: p.slice(0, -1), eol: '\r\n' } : { text: p, eol: '\n' };
  }
  if (last !== '') lines[parts.length] = { text: last, eol: '' };
  return lines;
}

/** 'none' | 'lf' | 'crlf' | 'mixed' (the unterminated last line does not count). */
export function eolStyle(lines) {
  let crlf = 0, lf = 0;
  for (const l of lines) { if (l.eol === '\r\n') crlf++; else if (l.eol === '\n') lf++; }
  return crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
}

const WS_END = /\s+$/, WS_RUN = /\s+/g, ALL_WS = /\s+/g;
function normText(t, o) {
  if (o.trimTrailing) t = t.replace(WS_END, '');
  if (o.ws === 'edges') t = t.trim();
  else if (o.ws === 'collapse') t = t.replace(WS_RUN, ' ');
  else if (o.ws === 'all') t = t.replace(ALL_WS, '');
  if (o.ignoreCase) t = t.toLowerCase();
  return t;
}

/** Map lines of both sides to integer ids (equal comparison key => equal id). */
export function lineIds(A, B, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const map = new Map();
  const plain = !hasIgnoreOptions(o);
  const conv = lines => {
    const ids = new Int32Array(lines.length), blank = o.ignoreBlank ? new Uint8Array(lines.length) : null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let k = plain ? l.text : normText(l.text, o);
      if (blank && l.text.trim() === '') blank[i] = 1;
      // The unterminated last line always differs from a terminated one; with exact EOL the terminator type counts too.
      const e = o.ignoreEol ? (l.eol === '' ? '\u0000' : '') : (l.eol === '' ? '\u0000' : l.eol === '\r\n' ? '\u0001' : '');
      if (e) k += e;
      let id = map.get(k);
      if (id === undefined) { id = map.size; map.set(k, id); }
      ids[i] = id;
    }
    return { ids, blank };
  };
  const a = conv(A), b = conv(B);
  return { a: a.ids, b: b.ids, blankA: a.blank, blankB: b.blank, count: map.size };
}

// ---------- core: LCS matches via Myers middle snake ----------
/**
 * Longest-common-subsequence matches of two integer arrays.
 * Returns { ma, mb } (equal-length arrays of matched positions, ascending). Edit distance = n + m - 2 * ma.length.
 */
export function lcsMatches(a, b, idCount) {
  const n = a.length, m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const ma = [], mb = [];
  for (let i = 0; i < pre; i++) { ma.push(i); mb.push(i); }

  // Lines that occur on one side only can never be part of an LCS: drop them before the expensive core.
  const aEnd = n - suf, bEnd = m - suf;
  const size = idCount !== undefined ? idCount : maxId(a, b) + 1;
  const cntA = new Uint8Array(size), cntB = new Uint8Array(size);
  for (let i = pre; i < aEnd; i++) cntA[a[i]] = 1;
  for (let j = pre; j < bEnd; j++) cntB[b[j]] = 1;
  const fa = [], ia = [], fb = [], ib = [];
  for (let i = pre; i < aEnd; i++) if (cntB[a[i]]) { fa.push(a[i]); ia.push(i); }
  for (let j = pre; j < bEnd; j++) if (cntA[b[j]]) { fb.push(b[j]); ib.push(j); }
  const A = Int32Array.from(fa), B = Int32Array.from(fb);
  const sub = [], subB = [];
  const st = { work: 0, limit: WORK_LIMIT, approximate: false };
  rec(A, 0, A.length, B, 0, B.length, sub, subB, st);
  for (let k = 0; k < sub.length; k++) { ma.push(ia[sub[k]]); mb.push(ib[subB[k]]); }

  for (let i = 0; i < suf; i++) { ma.push(aEnd + i); mb.push(bEnd + i); }
  return { ma, mb, approximate: st.approximate };
}
function maxId(a, b) { let mx = 0; for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i]; for (let i = 0; i < b.length; i++) if (b[i] > mx) mx = b[i]; return mx; }

/** Work units (diagonal steps + snake steps) Myers may spend before switching to unique-line anchoring (~1 s). */
export const WORK_LIMIT = 6e7;
const BUDGET = { budget: true };

function rec(a, aLo, aHi, b, bLo, bHi, oa, ob, st) {
  let pre = 0;
  while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
  for (let i = 0; i < pre; i++) { oa.push(aLo + i); ob.push(bLo + i); }
  aLo += pre; bLo += pre;
  let suf = 0;
  while (aHi - suf > aLo && bHi - suf > bLo && a[aHi - 1 - suf] === b[bHi - 1 - suf]) suf++;
  const sA = aHi - suf, sB = bHi - suf;
  if (aLo < sA && bLo < sB) {
    const sp = bisect(a, aLo, sA, b, bLo, sB, st);
    if (sp === BUDGET) patience(a, aLo, sA, b, bLo, sB, oa, ob, st);
    else if (sp) {
      rec(a, aLo, aLo + sp.x, b, bLo, bLo + sp.y, oa, ob, st);
      rec(a, aLo + sp.x, sA, b, bLo + sp.y, sB, oa, ob, st);
    }
  }
  for (let i = 0; i < suf; i++) { oa.push(sA + i); ob.push(sB + i); }
}

/**
 * Fallback once the Myers budget is spent (huge AND very different inputs, e.g. whole blocks moved): anchor on lines that occur
 * exactly once on each side (longest increasing subsequence), recurse between anchors. Result is valid but may be non-minimal;
 * `st.approximate` is set so the UI can say so. Small gaps without anchors are still diffed exactly.
 */
function patience(a, aLo, aHi, b, bLo, bHi, oa, ob, st) {
  st.approximate = true;
  const n = aHi - aLo, m = bHi - bLo;
  if (n * m <= 4e6 || n + m <= 2000) { const s2 = { work: 0, limit: Infinity, approximate: false }; rec(a, aLo, aHi, b, bLo, bHi, oa, ob, s2); return; }
  const posA = new Map(), posB = new Map();
  for (let i = aLo; i < aHi; i++) { const v = a[i]; posA.set(v, posA.has(v) ? -1 : i); }
  for (let j = bLo; j < bHi; j++) { const v = b[j]; posB.set(v, posB.has(v) ? -1 : j); }
  // anchors in B order -> A index; LIS over A indices
  const pairsA = [], pairsB = [];
  for (let j = bLo; j < bHi; j++) { const v = b[j]; if (posB.get(v) === j) { const i = posA.get(v); if (i !== undefined && i >= 0) { pairsA.push(i); pairsB.push(j); } } }
  if (!pairsA.length) return; // nothing to anchor on: leave this gap as replaced
  const tails = [], prev = new Int32Array(pairsA.length).fill(-1);
  for (let k = 0; k < pairsA.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairsA[tails[mid]] < pairsA[k]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const chain = [];
  for (let k = tails[tails.length - 1]; k !== -1; k = prev[k]) chain.push(k);
  chain.reverse();
  let ca = aLo, cb = bLo;
  const sub = { work: 0, limit: Infinity, approximate: false };
  for (const k of chain) {
    const ai = pairsA[k], bj = pairsB[k];
    gapDiff(a, ca, ai, b, cb, bj, oa, ob, st, sub);
    oa.push(ai); ob.push(bj); ca = ai + 1; cb = bj + 1;
  }
  gapDiff(a, ca, aHi, b, cb, bHi, oa, ob, st, sub);
}
function gapDiff(a, aLo, aHi, b, bLo, bHi, oa, ob, st) {
  if (aLo >= aHi || bLo >= bHi) return;
  // The gap gets a fresh (shared-limit-free) Myers budget: gaps are small relative to the whole, and patience recurses if not.
  const gs = { work: 0, limit: WORK_LIMIT, approximate: false };
  rec(a, aLo, aHi, b, bLo, bHi, oa, ob, gs);
  if (gs.approximate) st.approximate = true;
}

/** Find the middle snake of the two (non-empty, prefix/suffix-free) ranges; returns {x,y}, null (nothing in common) or BUDGET. */
function bisect(a, aLo, aHi, b, bLo, bHi, st) {
  const n = aHi - aLo, m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2), off = maxD, len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1), v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0; v2[off + 1] = 0;
  const delta = n - m, front = delta % 2 !== 0;
  let k1s = 0, k1e = 0, k2s = 0, k2e = 0;
  const ok = (x, y) => (x > 0 || y > 0) && (x < n || y < m) ? { x, y } : null; // must make progress
  for (let d = 0; d < maxD; d++) {
    if (st.work > st.limit) return BUDGET;
    for (let k1 = -d + k1s; k1 <= d - k1e; k1 += 2) {
      const o1 = off + k1;
      let x1 = (k1 === -d || (k1 !== d && v1[o1 - 1] < v1[o1 + 1])) ? v1[o1 + 1] : v1[o1 - 1] + 1;
      let y1 = x1 - k1;
      const x0 = x1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1++; y1++; }
      st.work += 1 + x1 - x0;
      v1[o1] = x1;
      if (x1 > n) k1e += 2;
      else if (y1 > m) k1s += 2;
      else if (front) {
        const o2 = off + delta - k1;
        if (o2 >= 0 && o2 < len && v2[o2] !== -1) {
          const x2 = n - v2[o2];
          if (x1 >= x2) return ok(x1, y1);
        }
      }
    }
    for (let k2 = -d + k2s; k2 <= d - k2e; k2 += 2) {
      const o2 = off + k2;
      let x2 = (k2 === -d || (k2 !== d && v2[o2 - 1] < v2[o2 + 1])) ? v2[o2 + 1] : v2[o2 - 1] + 1;
      let y2 = x2 - k2;
      const x0 = x2;
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) { x2++; y2++; }
      st.work += 1 + x2 - x0;
      v2[o2] = x2;
      if (x2 > n) k2e += 2;
      else if (y2 > m) k2s += 2;
      else if (!front) {
        const o1 = off + delta - k2;
        if (o1 >= 0 && o1 < len && v1[o1] !== -1) {
          const x1 = v1[o1], y1 = off + x1 - o1;
          if (x1 >= n - x2) return ok(x1, y1);
        }
      }
    }
  }
  return null; // nothing in common
}

// ---------- line diff ----------
/** Op codes used by diffCodes (compact, transferable from a worker). */
export const OP = { EQ: 0, DEL: 1, ADD: 2, DEL_IGN: 3, ADD_IGN: 4 };

/**
 * Diff two line arrays. Returns { codes: Uint8Array, ... } where each entry consumes one line:
 * EQ (both sides), DEL (A only), ADD (B only), DEL_IGN / ADD_IGN (blank line skipped by `ignoreBlank`).
 */
export function diffCodes(A, B, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const { a, b, blankA, blankB, count } = lineIds(A, B, o);
  let ca = a, cb = b, ra = null, rb = null; // candidate arrays + index maps when blank lines are skipped
  if (o.ignoreBlank) {
    const ka = [], kb = [], ma = [], mb = [];
    for (let i = 0; i < a.length; i++) if (!blankA[i]) { ka.push(a[i]); ma.push(i); }
    for (let j = 0; j < b.length; j++) if (!blankB[j]) { kb.push(b[j]); mb.push(j); }
    ca = Int32Array.from(ka); cb = Int32Array.from(kb); ra = ma; rb = mb;
  }
  const { ma, mb, approximate } = lcsMatches(ca, cb, count);
  const codes = new Uint8Array(A.length + B.length - ma.length);
  let p = 0, i = 0, j = 0;
  const gap = (ea, eb) => {
    for (; i < ea; i++) codes[p++] = blankA && blankA[i] ? OP.DEL_IGN : OP.DEL;
    for (; j < eb; j++) codes[p++] = blankB && blankB[j] ? OP.ADD_IGN : OP.ADD;
  };
  for (let k = 0; k < ma.length; k++) {
    const x = ra ? ra[ma[k]] : ma[k], y = rb ? rb[mb[k]] : mb[k];
    gap(x, y);
    codes[p++] = OP.EQ; i = x + 1; j = y + 1;
  }
  gap(A.length, B.length);
  codes.approximate = !!approximate;
  return codes;
}

/** Turn op codes into op objects { type:'='|'-'|'+', a?, b?, aNo?, bNo?, ignored? } and compute stats. */
export function materialize(A, B, codes, approximate = !!codes.approximate) {
  const ops = new Array(codes.length);
  let ai = 0, bi = 0, adds = 0, dels = 0, equal = 0, changed = 0, runD = 0, runA = 0;
  const closeRun = () => { changed += Math.min(runD, runA); runD = runA = 0; };
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    if (c === OP.EQ) { closeRun(); ops[k] = { type: '=', a: A[ai], b: B[bi], aNo: ++ai, bNo: ++bi }; equal++; }
    else if (c === OP.DEL) { dels++; runD++; ops[k] = { type: '-', a: A[ai], aNo: ++ai }; }
    else if (c === OP.ADD) { adds++; runA++; ops[k] = { type: '+', b: B[bi], bNo: ++bi }; }
    else if (c === OP.DEL_IGN) { closeRun(); ops[k] = { type: '-', a: A[ai], aNo: ++ai, ignored: true }; }
    else { closeRun(); ops[k] = { type: '+', b: B[bi], bNo: ++bi, ignored: true }; }
  }
  closeRun();
  const total = Math.max(A.length, B.length);
  const stats = {
    adds, dels, changed, added: adds - changed, removed: dels - changed, equal,
    identicalPct: total ? Math.round((equal / total) * 1000) / 10 : 100,
  };
  return { ops, stats, identical: adds === 0 && dels === 0, approximate };
}

/**
 * Diff two texts. Returns { ops, stats, identical, eolA, eolB, linesA, linesB }.
 */
export function computeDiff(origText, modText, opts = {}) {
  const A = splitLines(origText), B = splitLines(modText);
  return { ...materialize(A, B, diffCodes(A, B, opts)), eolA: eolStyle(A), eolB: eolStyle(B), linesA: A.length, linesB: B.length };
}

/** Human description of a line-ending mismatch, or null if the sides agree / have no line ends. */
export function eolNotice(eolA, eolB) {
  if (eolA === eolB || eolA === 'none' || eolB === 'none') return null;
  const nm = { lf: 'LF', crlf: 'CRLF', mixed: 'mixed CRLF/LF' };
  return `Line endings differ: original uses ${nm[eolA]}, modified uses ${nm[eolB]}.`;
}

// ---------- inline (word / character) refinement ----------
const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Tokens as arrays of strings. 'char' = code points (surrogate pairs are never split). */
export function tokenize(text, gran) {
  return gran === 'char' ? Array.from(text) : (text.match(TOKEN_RE) || []);
}

/**
 * Compare two changed lines. gran: 'word' | 'char'. Returns { a:[{text,changed}], b:[...] },
 * { skipped:true } when a line exceeds MAX_INLINE_LEN, or null when lines are too dissimilar to be worth highlighting.
 */
export function inlineDiff(aText, bText, opts = {}, gran = 'word') {
  if (aText.length > MAX_INLINE_LEN || bText.length > MAX_INLINE_LEN) return { skipped: true };
  const o = { ...DEFAULT_OPTS, ...opts };
  const ta = tokenize(aText, gran), tb = tokenize(bText, gran);
  const ids = new Map();
  const key = t => {
    let k = t;
    if (/^\s+$/.test(t)) { if (o.ws === 'all') k = ''; else if (o.ws === 'collapse' || o.ws === 'edges') k = ' '; }
    if (o.ignoreCase) k = k.toLowerCase();
    let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); } return id;
  };
  const ia = Int32Array.from(ta, key), ib = Int32Array.from(tb, key);
  const { ma, mb } = lcsMatches(ia, ib, ids.size);
  const flagA = new Uint8Array(ta.length).fill(1), flagB = new Uint8Array(tb.length).fill(1);
  for (let k = 0; k < ma.length; k++) { flagA[ma[k]] = 0; flagB[mb[k]] = 0; }
  const build = (toks, flags) => {
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const ch = flags[i] === 1, last = out[out.length - 1];
      if (last && last.changed === ch) last.text += toks[i]; else out.push({ text: toks[i], changed: ch });
    }
    return out;
  };
  let sa = build(ta, flagA), sb = build(tb, flagB);
  // Word mode: when one changed span faces one changed span, refine it at code-point level (trim shared edges).
  if (gran === 'word') {
    const ca = sa.filter(s => s.changed), cb = sb.filter(s => s.changed);
    if (ca.length === 1 && cb.length === 1) {
      const x = Array.from(ca[0].text), y = Array.from(cb[0].text);
      let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
      let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
      if (p + s > 0) { sa = refine(sa, ca[0], x, p, s); sb = refine(sb, cb[0], y, p, s); }
    }
  }
  const kept = sa.reduce((n, g) => n + (g.changed ? 0 : g.text.length), 0);
  if (kept < 0.3 * Math.max(aText.length, bText.length)) return null; // highlighting would just be noise
  return { a: sa, b: sb };
}
function refine(arr, seg, cps, p, s) {
  const parts = [];
  if (p) parts.push({ text: cps.slice(0, p).join(''), changed: false });
  const core = cps.slice(p, cps.length - s).join('');
  if (core) parts.push({ text: core, changed: true });
  if (s) parts.push({ text: cps.slice(cps.length - s).join(''), changed: false });
  const out = [];
  for (const g of arr) for (const q of (g === seg ? parts : [g])) {
    const last = out[out.length - 1];
    if (last && last.changed === q.changed) last.text += q.text; else out.push({ ...q });
  }
  return out;
}

// ---------- view models ----------
/**
 * Pair deletions with insertions inside each change block (sets op.pair) and return the side-by-side rows:
 * [{ l: op|null, r: op|null, change: bool }]. Ignored (blank-skipped) ops are shown neutrally on their own side.
 */
export function buildSideRows(ops) {
  const rows = [];
  let i = 0;
  while (i < ops.length) {
    const o = ops[i];
    if (o.type === '=') { rows.push({ l: o, r: o, change: false }); i++; continue; }
    if (o.ignored) { rows.push(o.type === '-' ? { l: o, r: null, change: false } : { l: null, r: o, change: false }); i++; continue; }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].type !== '=' && !ops[i].ignored) { (ops[i].type === '-' ? dels : adds).push(ops[i]); i++; }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) { dels[p].pair = adds[p]; adds[p].pair = dels[p]; }
    const n = Math.max(dels.length, adds.length);
    for (let p = 0; p < n; p++) rows.push({ l: dels[p] || null, r: adds[p] || null, change: true });
  }
  return rows;
}

/** Unified rows are the ops themselves; this also sets op.pair (same pairing as the side view). */
export function buildUnifiedRows(ops) { buildSideRows(ops); return ops; }

/** Indices of rows that start a change block. `isChange(row)` decides which rows are changes. */
export function changeStarts(rows, isChange) {
  const out = [];
  let prev = false;
  for (let i = 0; i < rows.length; i++) { const c = isChange(rows[i]); if (c && !prev) out.push(i); prev = c; }
  return out;
}

/** Which rows to show for `context` lines around changes: Uint8Array visible flags. context < 0 = all. */
export function visibleMask(isChangeAt, count, context) {
  const vis = new Uint8Array(count);
  if (context < 0) return vis.fill(1);
  for (let i = 0; i < count; i++) {
    if (!isChangeAt(i)) continue;
    const lo = Math.max(0, i - context), hi = Math.min(count - 1, i + context);
    for (let k = lo; k <= hi; k++) vis[k] = 1;
  }
  return vis;
}

// ---------- unified patch ----------
const lineContent = l => l.text + (l.eol === '\r\n' ? '\r' : '');

/**
 * Standard unified diff (---/+++ headers, @@ hunks). The ops must come from an EXACT comparison
 * (see exportPatch) so the patch applies to the original text byte for byte.
 */
export function toUnifiedText(ops, { context = 3, aName = 'original', bName = 'modified' } = {}) {
  const changed = [];
  ops.forEach((o, i) => { if (o.type !== '=') changed.push(i); });
  if (!changed.length) return '';
  const hunks = [];
  let start = Math.max(0, changed[0] - context), end = Math.min(ops.length, changed[0] + context + 1);
  for (let c = 1; c < changed.length; c++) {
    const s = Math.max(0, changed[c] - context), e = Math.min(ops.length, changed[c] + context + 1);
    if (s <= end) end = e; else { hunks.push([start, end]); start = s; end = e; }
  }
  hunks.push([start, end]);
  const out = [`--- ${aName}`, `+++ ${bName}`];
  for (const [s, e] of hunks) {
    let aCount = 0, bCount = 0, aStart = null, bStart = null;
    const body = [];
    for (let i = s; i < e; i++) {
      const o = ops[i];
      if (o.type !== '+') { aCount++; if (aStart === null) aStart = o.aNo; }
      if (o.type !== '-') { bCount++; if (bStart === null) bStart = o.bNo; }
      const line = o.type === '-' ? o.a : o.b;
      body.push((o.type === '=' ? ' ' : o.type) + lineContent(line));
      if (line.eol === '') body.push('\\ No newline at end of file');
    }
    // An empty range is reported as the line *before* the change (git convention).
    if (aStart === null) aStart = prevNo(ops, s, 'aNo');
    if (bStart === null) bStart = prevNo(ops, s, 'bNo');
    const rng = (st, c) => c === 1 ? `${st}` : `${st},${c}`;
    out.push(`@@ -${rng(aStart, aCount)} +${rng(bStart, bCount)} @@`, ...body);
  }
  return out.join('\n') + '\n';
}
function prevNo(ops, idx, key) {
  for (let i = idx - 1; i >= 0; i--) if (ops[i][key]) return ops[i][key];
  return 0;
}

/** Patch for original -> modified computed on the real text (all ignore options off). */
export function exportPatch(origText, modText, { context = 3, aName = 'original', bName = 'modified' } = {}) {
  const r = computeDiff(origText, modText, EXACT_OPTS);
  return r.identical ? '' : toUnifiedText(r.ops, { context, aName, bName });
}
