// Pure diff logic (no DOM). Line diff = Myers O(ND) after trimming common prefix/suffix,
// with word/char-level refinement inside paired changed lines.

/** Max edit distance explored before falling back to a coarse "replace all" result (bounds memory ~ D^2). */
export const MAX_D = 3000;

/**
 * Split text into lines. CRLF/CR are normalised to LF. A final line without a trailing newline
 * is flagged `noEol` so "a" vs "a\n" is reported (like git's "\ No newline at end of file").
 */
export function splitLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (s === '') return [];
  const parts = s.split('\n');
  const endsWithNl = parts[parts.length - 1] === '';
  if (endsWithNl) parts.pop();
  return parts.map((t, i) => ({ text: t, noEol: !endsWithNl && i === parts.length - 1 }));
}

/** Comparison key for a line under the given options. */
function lineKey(l, opts) {
  let t = l.text;
  if (opts.ignoreWhitespace) t = t.replace(/\s+/g, '');
  if (opts.ignoreCase) t = t.toLowerCase();
  return l.noEol ? t + '\u0000' : t;
}

/**
 * Generic Myers diff on two integer arrays.
 * Returns { ops: Array<'=' | '-' | '+'> , approximate } where each op consumes one element
 * (`=` both, `-` from a, `+` from b).
 */
export function myers(a, b, maxD = MAX_D) {
  const n = a.length, m = b.length;
  // Trim common prefix / suffix (cheap and shrinks D dramatically).
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
  const mid = diffCore(A, B, maxD);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push('=');
  for (const o of mid.ops) ops.push(o);
  for (let i = 0; i < suf; i++) ops.push('=');
  return { ops, approximate: mid.approximate };
}

function diffCore(a, b, maxD) {
  const n = a.length, m = b.length;
  if (n === 0) return { ops: new Array(m).fill('+'), approximate: false };
  if (m === 0) return { ops: new Array(n).fill('-'), approximate: false };
  const cap = Math.min(n + m, maxD);
  const off = cap + 2;
  const v = new Int32Array(2 * cap + 5);
  v[off + 1] = 0;
  const trace = []; // trace[d] = copy of v for k in [-d-1, d+1] taken BEFORE round d
  for (let d = 0; d <= cap; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return { ops: backtrack(trace, n, m), approximate: false };
    }
  }
  // Too different: give up on minimality and report a full replacement.
  return { ops: [...new Array(n).fill('-'), ...new Array(m).fill('+')], approximate: true };
}

function backtrack(trace, n, m) {
  const out = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d], at = k => vv[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push('='); x--; y--; }
    if (d > 0) { out.push(x === prevX ? '+' : '-'); }
    x = prevX; y = prevY;
  }
  return out.reverse();
}

/**
 * Diff two texts. Returns
 * { ops:[{type:'=' | '-' | '+', a?:line, b?:line, aNo?, bNo?}], stats:{added,removed}, identical, approximate }
 */
export function computeDiff(origText, modText, opts = {}) {
  const A = splitLines(origText), B = splitLines(modText);
  const ids = new Map();
  const toIds = ls => ls.map(l => { const k = lineKey(l, opts); let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); } return id; });
  const { ops: raw, approximate } = myers(toIds(A), toIds(B));
  let ai = 0, bi = 0, added = 0, removed = 0;
  const ops = raw.map(t => {
    if (t === '=') { const o = { type: '=', a: A[ai], b: B[bi], aNo: ai + 1, bNo: bi + 1 }; ai++; bi++; return o; }
    if (t === '-') { removed++; return { type: '-', a: A[ai], aNo: ++ai }; }
    added++; return { type: '+', b: B[bi], bNo: ++bi };
  });
  return { ops, stats: { added, removed }, identical: added === 0 && removed === 0, approximate };
}

// ---------- inline (word / character) refinement ----------
const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Compare two changed lines. Returns { a:[{text,changed}], b:[...] } or null if the lines
 * are too dissimilar (highlighting would just be noise) or too long.
 */
export function inlineDiff(aText, bText, opts = {}) {
  if (aText.length > 2000 || bText.length > 2000) return null;
  const ta = aText.match(TOKEN_RE) || [], tb = bText.match(TOKEN_RE) || [];
  const ids = new Map();
  const key = t => {
    let k = opts.ignoreWhitespace && /^\s+$/.test(t) ? '' : t;
    if (opts.ignoreCase) k = k.toLowerCase();
    let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); } return id;
  };
  const { ops } = myers(ta.map(key), tb.map(key), 400);
  const sa = [], sb = [];
  let i = 0, j = 0;
  const push = (arr, text, changed) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text; else arr.push({ text, changed });
  };
  for (const o of ops) {
    if (o === '=') { push(sa, ta[i], false); push(sb, tb[j], false); i++; j++; }
    else if (o === '-') push(sa, ta[i++], true);
    else push(sb, tb[j++], true);
  }
  // Character-level refinement: exactly one changed span on each side -> trim shared prefix/suffix.
  const ca = sa.filter(s => s.changed), cb = sb.filter(s => s.changed);
  if (ca.length === 1 && cb.length === 1) {
    const x = ca[0].text, y = cb[0].text;
    let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    if (p + s > 0) {
      const split = (arr, seg, full) => {
        const idx = arr.indexOf(seg);
        const parts = [];
        if (p) parts.push({ text: full.slice(0, p), changed: false });
        const core = full.slice(p, full.length - s);
        if (core) parts.push({ text: core, changed: true });
        if (s) parts.push({ text: full.slice(full.length - s), changed: false });
        arr.splice(idx, 1, ...parts);
      };
      split(sa, ca[0], x); split(sb, cb[0], y);
      // Re-merge neighbours with identical flag.
      for (const arr of [sa, sb]) for (let q = arr.length - 1; q > 0; q--) if (arr[q].changed === arr[q - 1].changed) { arr[q - 1].text += arr[q].text; arr.splice(q, 1); }
    }
  }
  // Too dissimilar -> highlighting would just be noise.
  const kept = sa.reduce((n, g) => n + (g.changed ? 0 : g.text.length), 0);
  if (kept < 0.3 * Math.max(aText.length, bText.length)) return null;
  return { a: sa, b: sb };
}

// ---------- view models ----------
/**
 * Build row models for rendering.
 * side:    [{ left:{no,text,type,segs}|null, right:{...}|null }]
 * unified: [{ type:'='|'-'|'+', aNo, bNo, text, segs, noEol }]
 */
export function buildRows(ops, opts = {}) {
  const side = [], unified = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === '=') {
      const o = ops[i++];
      side.push({ left: { no: o.aNo, text: o.a.text, type: '=' }, right: { no: o.bNo, text: o.b.text, type: '=' } });
      unified.push({ type: '=', aNo: o.aNo, bNo: o.bNo, text: o.b.text, noEol: o.b.noEol });
      continue;
    }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].type !== '=') { (ops[i].type === '-' ? dels : adds).push(ops[i]); i++; }
    const pairs = Math.min(dels.length, adds.length);
    const segs = [];
    for (let p = 0; p < pairs; p++) segs.push(inlineDiff(dels[p].a.text, adds[p].b.text, opts));
    const rows = Math.max(dels.length, adds.length);
    for (let p = 0; p < rows; p++) {
      const d = dels[p], a = adds[p], s = segs[p];
      side.push({
        left: d ? { no: d.aNo, text: d.a.text, type: '-', segs: s?.a } : null,
        right: a ? { no: a.bNo, text: a.b.text, type: '+', segs: s?.b } : null,
      });
    }
    dels.forEach((d, p) => unified.push({ type: '-', aNo: d.aNo, text: d.a.text, segs: segs[p]?.a, noEol: d.a.noEol }));
    adds.forEach((a, p) => unified.push({ type: '+', bNo: a.bNo, text: a.b.text, segs: segs[p]?.b, noEol: a.b.noEol }));
  }
  return { side, unified };
}

/** Standard unified diff text (---/+++ headers, @@ hunks, `context` lines of context). */
export function toUnifiedText(ops, { context = 3, aName = 'original', bName = 'modified' } = {}) {
  const changed = [];
  ops.forEach((o, i) => { if (o.type !== '=') changed.push(i); });
  if (!changed.length) return '';
  // Group changes whose context windows touch or overlap into hunks.
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
      const line = o.type === '=' ? o.b : o.type === '-' ? o.a : o.b;
      body.push((o.type === '=' ? ' ' : o.type) + line.text);
      if (line.noEol) body.push('\\ No newline at end of file');
    }
    // Empty ranges are reported as the line *before* the change (git convention).
    if (aStart === null) aStart = prevNo(ops, s, 'aNo');
    if (bStart === null) bStart = prevNo(ops, s, 'bNo');
    const rng = (st, c) => c === 1 ? `${st}` : `${st},${c}`;
    out.push(`@@ -${rng(aCount ? aStart : aStart, aCount)} +${rng(bCount ? bStart : bStart, bCount)} @@`, ...body);
  }
  return out.join('\n') + '\n';
}

/** Line number of the closest preceding op that has `key` (0 if none). */
function prevNo(ops, idx, key) {
  for (let i = idx - 1; i >= 0; i--) if (ops[i][key]) return ops[i][key];
  return 0;
}
