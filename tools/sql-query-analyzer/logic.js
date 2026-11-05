// SQL Query Analyzer - pure logic (no DOM, no network, never runs SQL). Builds on the shared analyser
// (assets/js/shared/sql-analyzer.js) and the formatter tokenizer; adds block structure, predicate/sargability
// analysis, join explanations, index suggestions and extra lint rules. Everything here is HEURISTIC.
import { analyzeSql, HEURISTIC_NOTE, LINT_RULES } from '../../assets/js/shared/sql-analyzer.js';
import { tokenize, SQL_DIALECTS, isSqlKeyword, isSqlType } from '../sql-formatter/logic.js';

export { HEURISTIC_NOTE, LINT_RULES, SQL_DIALECTS };
export * from './plan.js';

export const INDEX_NOTE = 'Heuristic suggestions derived from the SQL text only. Verify with EXPLAIN on your database, with your data and existing indexes, before creating anything.';

/** Rules added by this tool on top of LINT_RULES: id -> [severity, message, suggestion]. */
export const EXTRA_RULES = {
  'arithmetic-on-column': ['warn', 'Arithmetic or an expression on a column in a comparison makes the predicate non-sargable.', 'Isolate the column on one side: price > 10 / 2 instead of price * 2 > 10.'],
  'in-subquery-star': ['warn', 'SELECT * inside IN (subquery): IN needs a single column.', 'Select exactly the column to compare, or use EXISTS.'],
  'star-in-derived': ['info', 'SELECT * in a derived table or CTE pulls columns the outer query may not need.', 'List only the required columns so the optimizer can prune work.'],
  'exists-select-list': ['info', 'EXISTS ignores the subquery select list; naming several columns is misleading.', 'Use SELECT 1 (or SELECT *) inside EXISTS.'],
  'correlated-subquery-select': ['warn', 'Correlated subquery in the SELECT list: it may run once per output row.', 'Rewrite as a JOIN with GROUP BY, or a window function, if the table is large.'],
  'distinct-hides-duplicates': ['info', 'DISTINCT together with JOIN often hides duplicate rows created by a one-to-many join.', 'Fix the join (join on a unique key, aggregate first) or use EXISTS instead of joining just to filter.'],
  'union-distinct': ['info', 'UNION removes duplicates (sorting or hashing all rows); UNION ALL does not.', 'Use UNION ALL when duplicates cannot occur or do not matter.'],
  'function-in-join': ['warn', 'A function or expression wraps a column in a JOIN condition, so indexes on that column are usually not used.', 'Compare raw columns (normalise data at write time or add a functional/computed index).'],
  'implicit-conversion': ['info', 'Possible implicit type conversion: the literal type may not match the column type.', 'Compare using the column\'s own type (quote strings, do not quote numbers) or cast the literal, not the column.'],
  'count-column': ['info', 'COUNT(column) skips NULLs; if you want the number of rows COUNT(*) is clearer (and never slower).', 'Use COUNT(*) to count rows, COUNT(col) only to count non-NULL values.'],
  'or-in-join': ['warn', 'OR in a JOIN condition usually prevents index use and can multiply rows.', 'Split into two joins / UNION ALL, or restructure the condition.'],
  'multiple-wildcard-like': ['warn', 'LIKE pattern with several wildcards (or leading and trailing %) cannot use a B-tree index efficiently.', 'Use full-text or trigram search for substring matching.'],
  'not-in-null-list': ['warn', 'NOT IN with a NULL in the list never matches any row.', 'Remove the NULL or use NOT EXISTS / IS NOT NULL logic.'],
  'offset-pagination': ['info', 'OFFSET pagination reads and discards all skipped rows, so deep pages get slower.', 'Use keyset pagination: WHERE id > :last_seen_id ORDER BY id LIMIT n.'],
  'having-without-aggregate': ['info', 'HAVING condition has no aggregate; it could filter earlier in WHERE.', 'Move non-aggregate conditions to WHERE so rows are removed before grouping.'],
  'non-aggregated-column': ['warn', 'Column in the SELECT list is neither aggregated nor in GROUP BY.', 'Add it to GROUP BY or wrap it in an aggregate (MIN/MAX/ANY_VALUE).'],
  'order-by-expression': ['info', 'ORDER BY on an expression or function cannot use a plain index order.', 'Order by a stored/indexed column or add a functional index.'],
  'left-join-filtered': ['warn', 'WHERE filters the right-hand table of a LEFT JOIN, which silently turns it into an INNER JOIN.', 'Move the condition into the ON clause (or use IS NULL for anti-joins).'],
};
const RULES = { ...LINT_RULES, ...EXTRA_RULES };

// ---------- token helpers ----------
const AGG = new Set('COUNT SUM AVG MIN MAX GROUP_CONCAT STRING_AGG ARRAY_AGG LISTAGG JSON_AGG JSONB_AGG JSON_ARRAYAGG BOOL_AND BOOL_OR EVERY STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP MEDIAN ANY_VALUE APPROX_COUNT_DISTINCT BIT_AND BIT_OR XMLAGG'.split(' '));
const CONSTS = new Set(['NULL', 'TRUE', 'FALSE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP', 'SYSDATE', 'DEFAULT', 'UNKNOWN']);
const DATE_PARTS = new Set('YEAR MONTH DAY HOUR MINUTE SECOND WEEK QUARTER DAYS MONTHS YEARS HOURS MINUTES SECONDS EPOCH'.split(' '));
const COMPARE = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '<=>', '==', '!<', '!>']);
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'OUTER']);
const SET_OPS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);
const RANDOM_FNS = new Set(['RAND', 'RANDOM', 'NEWID', 'DBMS_RANDOM.VALUE']);

const cleanName = t => {
  const x = t.text;
  const a = x[0];
  if (a === '"' || a === '`') return x.slice(1, x.endsWith(a) && x.length > 1 ? -1 : undefined).split(a + a).join(a);
  if (a === '[') return x.slice(1, x.endsWith(']') ? -1 : undefined);
  return x;
};
const isName = t => !!t && (t.type === 'word' || t.type === 'ident');
const lc = s => String(s ?? '').toLowerCase();
const isUp = (t, ...w) => !!t && t.type === 'word' && w.includes(t.text.toUpperCase());

function makeLocator(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos, length = 0) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: pos - starts[lo] + 1, offset: pos, length };
  };
}

/** Tokens of one statement without comments, split on top-level ';'. */
function splitStatements(sql, dialect) {
  const sig = tokenize(sql, { dialect }).filter(t => t.type !== 'lcomment' && t.type !== 'bcomment');
  const out = []; let cur = [];
  for (const t of sig) { if (t.type === 'op' && t.text === ';') { if (cur.length) out.push(cur); cur = []; } else cur.push(t); }
  if (cur.length) out.push(cur);
  return out;
}
const spanText = (sql, toks) => (toks.length ? sql.slice(toks[0].pos, toks[toks.length - 1].pos + toks[toks.length - 1].text.length) : '');
const spanLoc = (loc, toks) => (toks.length ? loc(toks[0].pos, toks[toks.length - 1].pos + toks[toks.length - 1].text.length - toks[0].pos) : { line: 1, col: 1, offset: 0, length: 0 });

/** Split tokens at depth-0 separators. `isSep(token, index, tokens)` decides. BETWEEN ... AND is not split. */
function splitDepth0(toks, isSep, { between = false } = {}) {
  const parts = []; let cur = []; let depth = 0, pendingBetween = 0;
  toks.forEach((t, i) => {
    if (t.type === 'op' && (t.text === '(' || t.text === '[')) depth++;
    else if (t.type === 'op' && (t.text === ')' || t.text === ']')) depth--;
    if (depth === 0 && between && isUp(t, 'BETWEEN')) pendingBetween++;
    if (depth === 0 && isSep(t, i, toks)) {
      if (between && pendingBetween > 0 && isUp(t, 'AND')) { pendingBetween--; cur.push(t); return; }
      parts.push(cur); cur = []; return;
    }
    cur.push(t);
  });
  parts.push(cur);
  return parts.filter(p => p.length);
}

function matchingParen(toks, open) {
  let d = 0;
  for (let i = open; i < toks.length; i++) { if (toks[i].type === 'op' && toks[i].text === '(') d++; else if (toks[i].type === 'op' && toks[i].text === ')') { d--; if (d === 0) return i; } }
  return -1;
}

// ---------- block structure (query / subquery tree) ----------
/** Parse one statement's tokens into a tree of query blocks with clause token ranges. */
export function parseBlocks(T) {
  const blocks = [];
  const mk = (kind, parent, start, extra = {}) => { const b = { id: blocks.length, kind, parent, start, end: T.length, clauses: {}, cur: null, children: [], ...extra }; blocks.push(b); if (parent != null) blocks[parent].children.push(b.id); return b; };
  const closeClause = (b, at) => { if (b.cur) { b.cur.end = at; b.cur = null; } };
  const openClause = (b, name, at, skip = 1) => { closeClause(b, at); const c = { name, kw: at, start: at + skip, end: T.length }; (b.clauses[name] ||= []).push(c); b.cur = c; };
  const root = mk('root', null, 0);
  const frames = [{ block: root.id, isBlock: true }];
  for (let i = 0; i < T.length; i++) {
    const t = T[i]; const u = t.type === 'word' ? t.text.toUpperCase() : null;
    const frame = frames[frames.length - 1]; const blk = blocks[frame.block];
    if (t.type === 'op' && t.text === '(') {
      const nx = T[i + 1];
      if (isUp(nx, 'SELECT', 'WITH')) {
        const prev = T[i - 1]; const pu = prev && prev.type === 'word' ? prev.text.toUpperCase() : null; const cc = blk.cur?.name;
        let kind = 'scalar', name = null;
        if (cc === 'WITH' && pu === 'AS') {
          kind = 'cte';
          let k = i - 2; if (T[k]?.text === ')') { let d = 0; for (; k >= 0; k--) { if (T[k].text === ')') d++; else if (T[k].text === '(') { d--; if (d === 0) { k--; break; } } } }
          name = isName(T[k]) ? cleanName(T[k]) : null;
        } else if ((cc === 'FROM' || cc === 'JOIN') && (pu === 'FROM' || pu === 'JOIN' || pu === 'LATERAL' || prev?.text === ',' || pu === 'APPLY')) kind = 'derived';
        else if (pu === 'EXISTS') kind = 'exists';
        else if (pu === 'IN') kind = 'in';
        const nb = mk(kind, blk.id, i + 1, { open: i, parentClause: cc || null, name, lateral: pu === 'LATERAL' || pu === 'APPLY' });
        frames.push({ block: nb.id, isBlock: true });
      } else frames.push({ block: blk.id, isBlock: false });
      continue;
    }
    if (t.type === 'op' && t.text === ')' && frames.length > 1) {
      const f = frames.pop();
      if (f.isBlock) { const b = blocks[f.block]; closeClause(b, i); b.end = i; b.close = i; if (b.kind === 'derived' || b.kind === 'scalar') { const a = T[i + 1]; const k = isUp(a, 'AS') ? i + 2 : i + 1; if (isName(T[k]) && !(T[k].type === 'word' && isSqlKeyword(T[k].text.toUpperCase()))) b.alias = cleanName(T[k]); } }
      continue;
    }
    if (!frame.isBlock || !u) continue;
    const nxU = T[i + 1]?.type === 'word' ? T[i + 1].text.toUpperCase() : null;
    if (u === 'SELECT' || u === 'WITH' || u === 'WHERE' || u === 'HAVING' || u === 'QUALIFY' || u === 'SET' || u === 'VALUES' || u === 'RETURNING' || u === 'LIMIT' || u === 'OFFSET' || u === 'FETCH' ) openClause(blk, u, i);
    else if (u === 'FROM') { if (!(T[i - 1]?.text.toUpperCase() === 'DISTINCT' && (isUp(T[i - 2], 'IS', 'NOT')))) openClause(blk, 'FROM', i); }
    else if ((u === 'GROUP' || u === 'ORDER') && nxU === 'BY') { openClause(blk, u === 'GROUP' ? 'GROUP_BY' : 'ORDER_BY', i, 2); i++; }
    else if (u === 'ON') openClause(blk, 'ON', i);
    else if (u === 'USING' && blk.cur?.name === 'JOIN') openClause(blk, 'USING', i);
    else if (JOIN_WORDS.has(u) && !((u === 'LEFT' || u === 'RIGHT') && T[i + 1]?.text === '(')) { const pu = T[i - 1]?.type === 'word' ? T[i - 1].text.toUpperCase() : null; if (!(pu && JOIN_WORDS.has(pu) && blk.cur?.name === 'JOIN')) openClause(blk, 'JOIN', i); }
    else if (SET_OPS.has(u)) {
      closeClause(blk, i); blk.end = i;
      const all = isUp(T[i + 1], 'ALL'), distinct = isUp(T[i + 1], 'DISTINCT');
      const nb = mk('union', blk.parent, i + 1, { setOp: { op: u, all, distinct, index: i }, parentClause: blk.parentClause, unionOf: blk.id });
      frame.block = nb.id;
    }
  }
  for (const f of frames) { const b = blocks[f.block]; closeClause(b, T.length); b.end = T.length; }
  return blocks;
}

// ---------- operand / predicate analysis ----------
function colRef(tk) {
  if (!tk.length) return null;
  const parts = [];
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (i % 2 === 0) {
      if (!isName(t)) return null;
      if (t.type === 'word' && CONSTS.has(t.text.toUpperCase())) return null;
      parts.push(cleanName(t));
    } else if (!(t.type === 'op' && t.text === '.')) return null;
  }
  if (tk.length % 2 === 0) return null;
  return { qualifier: parts.length > 1 ? parts[parts.length - 2] : null, name: parts[parts.length - 1], text: parts.join('.') };
}

function containsColumn(tk) {
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (!isName(t)) continue;
    const nx = tk[i + 1];
    if (nx && nx.type === 'op' && nx.text === '(' && t.type === 'word') continue; // function name
    const pv = tk[i - 1];
    if (pv && ((pv.type === 'op' && pv.text === '::') || isUp(pv, 'AS'))) continue; // cast target type
    if (t.type === 'word') { const u = t.text.toUpperCase(); if (CONSTS.has(u) || DATE_PARTS.has(u) || isSqlType(u)) continue; if (isSqlKeyword(u) && !(pv && pv.text === '.')) continue; }
    return true;
  }
  return false;
}
function firstColumn(tk) {
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (!isName(t)) continue;
    const nx = tk[i + 1];
    if (nx && nx.type === 'op' && nx.text === '(' && t.type === 'word') continue;
    const pv = tk[i - 1];
    if (pv && ((pv.type === 'op' && pv.text === '::') || isUp(pv, 'AS'))) continue;
    if (t.type === 'word') { const u = t.text.toUpperCase(); if (CONSTS.has(u) || DATE_PARTS.has(u) || isSqlType(u)) continue; if (isSqlKeyword(u) && !(pv && pv.text === '.')) continue; }
    // gather qualified chain
    let j = i; const parts = [cleanName(t)];
    while (tk[j + 1]?.text === '.' && isName(tk[j + 2])) { parts.push(cleanName(tk[j + 2])); j += 2; }
    return { qualifier: parts.length > 1 ? parts[parts.length - 2] : null, name: parts[parts.length - 1], text: parts.join('.') };
  }
  return null;
}

/** Classify one side of a comparison. */
export function classifyOperand(tk) {
  const t = tk;
  if (!t.length) return { kind: 'empty' };
  if (t.length === 1) {
    const x = t[0];
    if (x.type === 'number' || x.type === 'string') return { kind: 'literal', literal: x.text, literalType: x.type };
    if (x.type === 'placeholder') return { kind: 'param' };
    if (x.type === 'word' && CONSTS.has(x.text.toUpperCase())) return { kind: x.text.toUpperCase() === 'NULL' ? 'null' : 'const', text: x.text };
  }
  if (t.length === 2 && t[0].text === '-' && t[1].type === 'number') return { kind: 'literal', literal: `-${t[1].text}`, literalType: 'number' };
  if (t[0].text === '(' && isUp(t[1], 'SELECT', 'WITH')) return { kind: 'subquery' };
  const col = colRef(t);
  if (col) return { kind: 'column', col };
  if (isName(t[0]) && t[0].type === 'word' && t[1]?.text === '(') {
    const close = matchingParen(t, 1);
    const inner = close > 0 ? t.slice(2, close) : t.slice(2);
    const rest = close > 0 ? t.slice(close + 1) : [];
    if (!containsColumn(inner) && !containsColumn(rest)) return { kind: 'const-expr' };
    const col2 = firstColumn(inner) || firstColumn(rest);
    if (rest.length) return { kind: 'expr', col: col2 };
    return { kind: 'func', fn: t[0].text.toUpperCase(), col: col2, args: inner };
  }
  if (containsColumn(t)) return { kind: 'expr', col: firstColumn(t) };
  return { kind: 'const-expr' };
}

const NUMERICISH = /(^|_)(id|qty|quantity|count|amount|price|total|num|number|age|year)$|^id$/i;
const TEXTISH = /(name|email|phone|code|zip|postal|sku|slug|title|token|uuid|status|city|country)$/i;

/** Analyse one leaf predicate (no top-level AND/OR). */
export function analyzePredicate(tk, sql, loc) {
  const base = { text: spanText(sql, tk), ...spanLoc(loc, tk), reasons: [], hints: [], sargable: null, kind: 'other', column: null, columns: [] };
  if (!tk.length) return base;
  let t = tk;
  // strip wrapping parens (non-subquery)
  while (t[0].text === '(' && t[0].type === 'op' && matchingParen(t, 0) === t.length - 1 && !isUp(t[1], 'SELECT', 'WITH')) t = t.slice(1, -1);
  if (!t.length) return base;
  if (isUp(t[0], 'EXISTS') || (isUp(t[0], 'NOT') && isUp(t[1], 'EXISTS'))) return { ...base, kind: isUp(t[0], 'NOT') ? 'not-exists' : 'exists', sargable: true };
  // find the operator at depth 0
  let depth = 0, opAt = -1, op = null, neg = false;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x.type === 'op' && x.text === '(') depth++; else if (x.type === 'op' && x.text === ')') depth--;
    if (depth !== 0) continue;
    if (x.type === 'op' && COMPARE.has(x.text)) { opAt = i; op = x.text; break; }
    if (x.type === 'word') {
      const u = x.text.toUpperCase();
      if (u === 'NOT' && isUp(t[i + 1], 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'RLIKE', 'REGEXP')) { opAt = i + 1; op = t[i + 1].text.toUpperCase(); neg = true; break; }
      if (['IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'RLIKE', 'REGEXP'].includes(u) && i > 0) { opAt = i; op = u; break; }
    }
  }
  if (opAt < 0) return base;
  const left = t.slice(0, neg ? opAt - 1 : opAt), right = t.slice(opAt + 1);
  const L = classifyOperand(left);
  let R;
  let listSize = null, kind = 'other';
  if (op === 'IS') { const r2 = isUp(right[0], 'NOT') ? right.slice(1) : right; R = classifyOperand(r2); kind = isUp(r2[0], 'NULL') ? 'null' : 'other'; if (isUp(r2[0], 'DISTINCT')) kind = 'other'; base.negated = isUp(right[0], 'NOT'); }
  else if (op === 'IN') { kind = neg ? 'not-in' : 'in'; if (right[0]?.text === '(' && isUp(right[1], 'SELECT', 'WITH')) { kind = neg ? 'not-in-subquery' : 'in-subquery'; R = { kind: 'subquery' }; } else { const inner = right.slice(1, matchingParen(right, 0) > 0 ? matchingParen(right, 0) : undefined); listSize = splitDepth0(inner, x => x.type === 'op' && x.text === ',').length; R = { kind: 'list', hasNull: inner.some(x => isUp(x, 'NULL')) }; } }
  else if (op === 'BETWEEN') { kind = neg ? 'not-between' : 'range'; R = { kind: 'const-expr' }; }
  else if (op === 'LIKE' || op === 'ILIKE' || op === 'RLIKE' || op === 'REGEXP') {
    kind = neg ? 'not-like' : 'like'; R = classifyOperand(right);
    if (R.kind === 'literal' && R.literalType === 'string') {
      const body = R.literal.replace(/^[A-Za-z]?['"]/, '').replace(/['"]$/, '');
      const pct = (body.match(/%/g) || []).length;
      base.like = { pattern: body, leading: /^[%_]/.test(body), wildcards: pct + (body.match(/_/g) || []).length, percents: pct };
      if (op === 'RLIKE' || op === 'REGEXP') base.like = { pattern: body, regex: true };
    }
  }
  else { R = classifyOperand(right); kind = op === '=' || op === '<=>' || op === '==' ? 'equality' : (op === '<>' || op === '!=') ? 'inequality' : 'range'; }
  base.kind = kind; base.op = neg ? `NOT ${op}` : op; base.listSize = listSize; base.left = L; base.right = R;
  const valueLike = k => ['literal', 'param', 'const', 'const-expr', 'subquery', 'null', 'list'].includes(k);
  const fnReason = (side, o) => (o.kind === 'func' ? `Function ${o.fn}() is applied to column ${o.col ? o.col.text : ''}, so an index on that column cannot be searched directly.` : `An expression on column ${o.col ? o.col.text : ''} must be evaluated for every row, so an index on that column cannot be searched directly.`);
  if (L.kind === 'column' && (valueLike(R.kind) || op === 'BETWEEN')) { base.column = L.col; base.sargable = true; }
  else if (R.kind === 'column' && valueLike(L.kind) && ['equality', 'inequality', 'range'].includes(kind)) { base.column = R.col; base.sargable = true; }
  else if (L.kind === 'column' && R.kind === 'column') { base.column = L.col; base.columns = [L.col, R.col]; base.sargable = null; base.kind = kind === 'equality' ? 'column-equality' : 'column-compare'; }
  else if ((L.kind === 'func' || L.kind === 'expr') && (valueLike(R.kind) || op === 'BETWEEN')) { base.sargable = false; base.column = L.col; base.nonSargableOperand = L; base.reasons.push(fnReason('left', L)); }
  else if ((R.kind === 'func' || R.kind === 'expr') && valueLike(L.kind)) { base.sargable = false; base.column = R.col; base.nonSargableOperand = R; base.reasons.push(fnReason('right', R)); }
  else if (L.kind === 'func' || L.kind === 'expr') { base.sargable = false; base.column = L.col; base.nonSargableOperand = L; base.reasons.push(fnReason('left', L)); }
  else if (R.kind === 'func' || R.kind === 'expr') { base.sargable = false; base.column = R.col; base.nonSargableOperand = R; base.reasons.push(fnReason('right', R)); }
  if (kind === 'like' && base.like && !base.like.regex) {
    if (base.like.leading) { base.sargable = false; base.reasons.push('The pattern starts with a wildcard, so a B-tree index cannot narrow the search (every row must be checked).'); }
    else if (base.like.wildcards > 0) { base.kind = 'like-prefix'; base.reasons.push('Prefix pattern: a B-tree index can be used for the part before the first wildcard (in PostgreSQL this needs text_pattern_ops or the C collation).'); }
    else base.kind = 'equality';
    if (base.like.percents >= 2 || (base.like.leading && /%$/.test(base.like.pattern))) base.multiWildcard = true;
  }
  if (kind === 'like' && base.like && base.like.regex) { base.sargable = false; base.reasons.push('Regular-expression matching generally cannot use a B-tree index.'); }
  if (kind === 'inequality' && base.sargable) base.reasons.push('<> / != matches almost every row, so the optimizer rarely uses an index for it.');
  if (kind === 'not-in' || kind === 'not-in-subquery' || kind === 'not-like') { base.sargable = false; base.reasons.push('Negated conditions (NOT IN / NOT LIKE) typically cannot be answered by an index seek.'); }
  if (kind === 'not-in-subquery') base.reasons.push('NOT IN (subquery) returns no rows at all if the subquery yields a NULL; prefer NOT EXISTS.');
  if (kind === 'not-in' && R.hasNull) base.nullInList = true;
  if ((op === '=' || op === '<>' || op === '!=') && (R.kind === 'null' || L.kind === 'null')) { base.nullCompare = true; base.sargable = false; base.reasons.push(`Comparing with NULL using ${op} is never true; use IS ${op === '=' ? '' : 'NOT '}NULL.`); }
  if (kind === 'null') base.sargable = L.kind === 'column' ? true : (L.kind === 'func' || L.kind === 'expr' ? false : base.sargable);
  // implicit conversion hints, only when evident from names and literal types
  if (base.column && ((L.kind === 'column' && R.kind === 'literal') || (R.kind === 'column' && L.kind === 'literal'))) {
    const lit = L.kind === 'literal' ? L : R;
    const name = base.column.name;
    if (lit.literalType === 'string' && /^'-?\d+(\.\d+)?'$/.test(lit.literal) && NUMERICISH.test(name)) base.hints.push(`'${name}' looks numeric but is compared to a quoted string ${lit.literal}: depending on the database this may force a conversion of the column or the literal.`);
    if (lit.literalType === 'number' && TEXTISH.test(name)) base.hints.push(`'${name}' looks like a text column but is compared to the number ${lit.literal}: databases such as MySQL and SQL Server convert every row value, which prevents index use.`);
  }
  return base;
}

/** Flatten a WHERE/HAVING/ON expression into leaf predicates; OR groups become {kind:'or', branches}. */
export function splitPredicates(tk, sql, loc) {
  if (!tk.length) return [];
  let t = tk;
  while (t.length && t[0].text === '(' && t[0].type === 'op' && matchingParen(t, 0) === t.length - 1 && !isUp(t[1], 'SELECT', 'WITH')) t = t.slice(1, -1);
  const ors = splitDepth0(t, x => isUp(x, 'OR'), { between: false });
  if (ors.length > 1) {
    const branches = ors.map(b => splitPredicates(b, sql, loc));
    const leaves = branches.flat().flatMap(p => (p.kind === 'or' ? p.branches.flat() : [p]));
    const colNames = new Set(leaves.map(p => (p.column ? lc(p.column.text) : null)).filter(Boolean));
    const withoutCol = leaves.some(p => !p.column);
    return [{ kind: 'or', text: spanText(sql, t), ...spanLoc(loc, t), branches, columns: [...colNames], sameColumn: colNames.size === 1 && !withoutCol, differentColumns: colNames.size > 1, reasons: [], hints: [], sargable: colNames.size === 1 ? true : false }];
  }
  const ands = splitDepth0(t, x => isUp(x, 'AND'), { between: true });
  if (ands.length === 1) {
    const one = ands[0];
    if (one[0].text === '(' && one[0].type === 'op' && matchingParen(one, 0) === one.length - 1 && !isUp(one[1], 'SELECT', 'WITH')) return splitPredicates(one, sql, loc);
    return [analyzePredicate(one, sql, loc)];
  }
  return ands.flatMap(a => splitPredicates(a, sql, loc));
}

const rangeOf = (T, r) => (r ? T.slice(r.start, r.end) : []);
const clauseToks = (T, b, name) => (b.clauses[name] || []).flatMap(c => rangeOf(T, c));

// ---------- select list ----------
function selectItems(T, b, sql, loc) {
  const toks = clauseToks(T, b, 'SELECT').filter((t, i, a) => !(i === 0 && isUp(t, 'DISTINCT', 'ALL')));
  const raw = splitDepth0(toks, x => x.type === 'op' && x.text === ',');
  return raw.map((tk, i) => {
    let core = tk;
    // strip alias: "AS name" or trailing bare identifier
    const asIdx = tk.findIndex((x, k) => isUp(x, 'AS') && k > 0 && tk.slice(0, k).filter(y => y.text === '(').length === tk.slice(0, k).filter(y => y.text === ')').length);
    let alias = null;
    if (asIdx > 0) { alias = cleanName(tk[asIdx + 1] || { text: '' }); core = tk.slice(0, asIdx); }
    else if (tk.length > 1 && isName(tk[tk.length - 1]) && !(tk[tk.length - 2].type === 'op' && ['.', '(', '+', '-', '*', '/', '||', '::', ','].includes(tk[tk.length - 2].text)) && !(tk[tk.length - 1].type === 'word' && isSqlKeyword(tk[tk.length - 1].text.toUpperCase()))) { alias = cleanName(tk[tk.length - 1]); core = tk.slice(0, -1); }
    let isAgg = false, isWindow = false;
    core.forEach((x, k) => { if (x.type === 'word' && core[k + 1]?.text === '(' && AGG.has(x.text.toUpperCase())) isAgg = true; if (isUp(x, 'OVER')) isWindow = true; });
    const col = colRef(core);
    const star = core.length && core[core.length - 1].text === '*' && (core.length === 1 || core[core.length - 2].text === '.');
    return { index: i, text: spanText(sql, tk), ...spanLoc(loc, tk), alias, col, isAgg: isAgg && !isWindow, isWindow, star, hasColumn: containsColumn(core) };
  });
}

// ---------- plain-English explanations ----------
const JOIN_INFO = {
  INNER: ['Keeps only rows that have a match on both sides.', 'Rows without a partner on either side are dropped from the result.'],
  LEFT: ['Keeps every row from the left side and adds matching right-side columns.', 'Left rows with no match are kept with NULL in the right-side columns; unmatched right rows are dropped.'],
  RIGHT: ['Keeps every row from the right side and adds matching left-side columns.', 'Right rows with no match are kept with NULL in the left-side columns; unmatched left rows are dropped.'],
  FULL: ['Keeps all rows from both sides.', 'Unmatched rows from either side appear once, with NULLs for the other side.'],
  CROSS: ['Pairs every left row with every right row (cartesian product).', 'Rows returned = left rows x right rows; no rows are lost.'],
};
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

function pairsOf(cond) {
  // extract a.x = b.y pairs from a condition string
  const out = []; const re = /([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*\.\s*([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*=\s*([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*\.\s*([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])/g;
  const un = s => s.replace(/^["`[]|["`\]]$/g, '');
  let m; while ((m = re.exec(cond))) out.push({ lq: un(m[1]), lc: un(m[2]), rq: un(m[3]), rc: un(m[4]) });
  return out;
}

/** Explain one join in plain English. `info` = {type, table, alias, condition, using, flags, derived, lateral, natural}. */
export function explainJoin(j, { leftNames = [], whereFilteredRight = false } = {}) {
  const raw = String(j.type || 'INNER').toUpperCase();
  const natural = raw.includes('NATURAL') || j.natural;
  const apply = raw.endsWith('APPLY');
  const base = raw.replace('NATURAL', '').replace('APPLY', '').trim() || 'INNER';
  const kind = apply ? (raw.startsWith('OUTER') ? 'LEFT' : 'INNER') : base;
  const target = j.table ? (j.alias ? `${j.table} (${j.alias})` : j.table) : 'a subquery';
  const info = JOIN_INFO[kind] || JOIN_INFO.INNER;
  const lines = [];
  const warnings = [];
  lines.push(`${raw}${j.lateral && !apply ? ' LATERAL' : ''} JOIN ${target}: ${info[0]}`);
  lines.push(info[1]);
  if (natural) { lines.push('NATURAL joins on ALL columns with the same name in both tables.'); warnings.push('NATURAL JOIN is fragile: adding a same-named column to either table silently changes the join. Prefer explicit ON or USING.'); }
  if (j.lateral || apply) lines.push(`${apply ? 'APPLY' : 'LATERAL'} runs the right-hand ${j.table ? 'expression' : 'subquery'} once per left row and may reference the left row's columns.`);
  if (j.using) lines.push(`USING ${j.condition}: joins on the same-named column(s) and shows each once in the result (ON would keep both copies).`);
  else if (j.condition && !natural) lines.push(`ON ${norm(j.condition)}: rows are matched when this condition is true (ON can express any condition; USING only equality on same-named columns).`);
  if ((j.flags || []).includes('cartesian')) warnings.push('No usable join condition: this is a cartesian product (every row combination). Add an ON condition unless that is intended.');
  if ((j.flags || []).includes('cross-join')) warnings.push('Cross join: result size is left rows x right rows. Make sure both sides are small or this is intended.');
  if ((j.flags || []).includes('non-equality')) warnings.push('The condition has no equality comparison; the database may need to compare many row pairs (nested loop).');
  if (kind === 'LEFT' && whereFilteredRight) warnings.push('A WHERE condition on this table\'s columns removes the NULL rows a LEFT JOIN creates, which makes it behave like an INNER JOIN. Move the condition into ON.');
  // row multiplication
  const pairs = pairsOf(j.condition || '');
  const aliasL = lc(j.alias || j.table);
  const mine = pairs.map(p => (lc(p.lq) === aliasL ? { col: p.lc } : lc(p.rq) === aliasL ? { col: p.rc } : null)).filter(Boolean);
  let multiplication = false;
  if (!natural && !j.using && !(j.flags || []).includes('cartesian') && kind !== 'CROSS' && mine.length) {
    const likelyUnique = mine.some(m => lc(m.col) === 'id' || /^(uuid|guid)$/i.test(m.col));
    if (!likelyUnique) { multiplication = true; warnings.push(`Row multiplication: if ${j.alias || j.table}.${mine[0].col} is not unique, each matching left row is repeated once per match, which inflates counts and sums.`); }
  }
  return { type: raw, kind, summary: lines[0], lines, warnings, multiplication, target, pairs };
}

// ---------- index suggestions ----------
const identOk = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const quoteId = (s, dialect) => {
  if (identOk(s)) return s;
  if (dialect === 'mysql' || dialect === 'bigquery') return '`' + s.replace(/`/g, '``') + '`';
  if (dialect === 'sqlserver') return '[' + s.replace(/]/g, ']]') + ']';
  return '"' + s.replace(/"/g, '""') + '"';
};
const idxName = (table, cols) => `idx_${table}_${cols.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60).replace(/_+$/, '');

/** CREATE INDEX statement for a dialect. cols: [{name, desc?}] ; include: [name]. Returns string. */
export function createIndexSql({ table, schema = null, cols, include = [], dialect = 'standard', name = null, unique = false }) {
  const q = s => quoteId(s, dialect);
  const tn = (schema ? q(schema) + '.' : '') + q(table);
  const nm = q(name || idxName(table, cols.map(c => c.name)));
  const list = cols.map(c => `${q(c.name)}${c.desc && dialect !== 'sqlite' ? ' DESC' : c.desc ? ' DESC' : ''}`).join(', ');
  if (dialect === 'bigquery') return `-- BigQuery has no CREATE INDEX for this case. Cluster the table instead:\n-- CREATE TABLE ${tn}_clustered CLUSTER BY ${cols.map(c => q(c.name)).join(', ')} AS SELECT * FROM ${tn};`;
  const u = unique ? 'UNIQUE ' : '';
  if (dialect === 'sqlserver') return `CREATE ${u}NONCLUSTERED INDEX ${nm}\n  ON ${tn} (${list})${include.length ? `\n  INCLUDE (${include.map(q).join(', ')})` : ''};`;
  if (dialect === 'postgresql') return `CREATE ${u}INDEX ${nm}\n  ON ${tn} (${list})${include.length ? `\n  INCLUDE (${include.map(q).join(', ')})` : ''};`;
  const all = include.length && !['postgresql', 'sqlserver'].includes(dialect) ? `${list}, ${include.map(q).join(', ')}` : list;
  return `CREATE ${u}INDEX ${nm}\n  ON ${tn} (${all});`;
}

/** Plain index candidates for one block: equality first, then the first range column, then ORDER BY / GROUP BY columns. */
function indexCandidates(ctx) {
  const { block, tables, sql, T, preds, onPreds, orderItems, groupItems, selectItems: sel, stars, columnsUsed, dialect } = ctx;
  const aliasMap = new Map();
  for (const t of tables) { if (t.alias) aliasMap.set(lc(t.alias), t); aliasMap.set(lc(t.name), aliasMap.get(lc(t.name)) || t); }
  const real = tables.filter(t => t.kind === 'table');
  const resolve = col => {
    if (!col) return null;
    if (col.qualifier) { const t = aliasMap.get(lc(col.qualifier)); return t && t.kind === 'table' ? t : null; }
    return real.length === 1 && tables.length === 1 ? real[0] : null;
  };
  const per = new Map();
  const get = t => { const k = `${t.schema || ''}.${t.name}|${lc(t.alias || '')}`; if (!per.has(k)) per.set(k, { table: t, eq: [], range: [], order: [], group: [], reasons: new Map(), extra: [] }); return per.get(k); };
  const addUnique = (arr, name) => { if (!arr.some(x => lc(x.name) === lc(name))) arr.push({ name }); };
  const unresolved = [];
  const visit = (p, role) => {
    if (p.kind === 'or') { if (p.sameColumn) for (const b of p.branches.flat()) visit(b, role); return; }
    if (!p.column) return;
    const t = resolve(p.column);
    if (!t) { if (p.sargable) unresolved.push(p.column.text); return; }
    const e = get(t);
    if (p.sargable === false) {
      if (p.nonSargableOperand?.kind === 'func' && p.nonSargableOperand.fn && ['LOWER', 'UPPER', 'TRIM', 'DATE', 'YEAR', 'MONTH'].includes(p.nonSargableOperand.fn)) e.extra.push({ kind: 'functional', predicate: p });
      if (p.like?.leading) e.extra.push({ kind: 'wildcard', column: p.column.name });
      return;
    }
    if (['equality', 'in', 'null', 'in-subquery'].includes(p.kind)) { addUnique(e.eq, p.column.name); e.reasons.set(lc(p.column.name), role === 'join' ? 'join key' : p.kind === 'in' ? 'IN list (equality)' : p.kind === 'null' ? 'IS NULL' : 'equality filter'); }
    else if (['range', 'like-prefix'].includes(p.kind)) { addUnique(e.range, p.column.name); e.reasons.set(lc(p.column.name), p.kind === 'like-prefix' ? 'prefix LIKE (range)' : 'range filter'); }
  };
  preds.forEach(p => visit(p, 'where'));
  // join equality columns (both sides)
  for (const p of onPreds) {
    if (p.kind === 'column-equality' && p.columns.length === 2) for (const c of p.columns) { const t = resolve(c); if (t) { const e = get(t); addUnique(e.eq, c.name); e.reasons.set(lc(c.name), 'join key'); } }
    else visit(p, 'join');
  }
  // ORDER BY / GROUP BY: only plain columns of one table
  const plain = items => items.length && items.every(i => i.col && !i.expr);
  if (plain(orderItems)) {
    const ts = orderItems.map(i => resolve(i.col)); if (ts.every(t => t && t === ts[0])) { const e = get(ts[0]); orderItems.forEach(i => { if (!e.order.some(x => lc(x.name) === lc(i.col.name))) e.order.push({ name: i.col.name, desc: i.desc }); }); }
  } else if (plain(groupItems)) {
    const ts = groupItems.map(i => resolve(i.col)); if (ts.every(t => t && t === ts[0])) { const e = get(ts[0]); groupItems.forEach(i => { if (!e.group.some(x => lc(x.name) === lc(i.col.name))) e.group.push({ name: i.col.name }); }); }
  }
  const out = [];
  for (const e of per.values()) {
    const cols = []; const roles = [];
    const push = (c, role) => { if (cols.length >= 5 || cols.some(x => lc(x.name) === lc(c.name))) return; cols.push({ name: c.name, desc: !!c.desc, role }); roles.push(role); };
    e.eq.forEach(c => push(c, e.reasons.get(lc(c.name)) || 'equality'));
    if (e.range.length) push(e.range[0], e.reasons.get(lc(e.range[0].name)) || 'range');
    e.order.forEach(c => push(c, 'ORDER BY'));
    e.group.forEach(c => push(c, 'GROUP BY'));
    const notes = [];
    if (cols.length === 1 && lc(cols[0].name) === 'id') notes.push('A column named id is usually the primary key, which is already indexed; skip this index if so.');
    if (e.range.length > 1) notes.push(`Only the first range column (${e.range[0].name}) can be used for seeking; ${e.range.slice(1).map(c => c.name).join(', ')} is only filtered afterwards.`);
    if (e.range.length && e.order.length) notes.push('With a range condition, ORDER BY columns after it cannot avoid a sort in every engine; verify with EXPLAIN (some prefer ORDER BY before the range column).');
    if (e.order.some(c => c.desc) && e.order.some(c => !c.desc)) notes.push('Mixed ASC/DESC ORDER BY needs matching directions in the index (supported by PostgreSQL, MySQL 8+, SQL Server, Oracle).');
    if (e.eq.length + e.range.length === 0 && e.order.length + e.group.length > 0 && !sel.length === false) notes.push('This index only helps ordering/grouping; with no filter it may be used for a full ordered scan.');
    // covering
    let covering = null;
    if (cols.length && !stars.length) {
      const key = new Set(cols.map(c => lc(c.name)));
      const inc = [];
      for (const c of columnsUsed) { const t = c.qualifier ? aliasMap.get(lc(c.qualifier)) : (real.length === 1 && tables.length === 1 ? real[0] : null); if (t === e.table && !key.has(lc(c.name)) && !inc.includes(c.name)) inc.push(c.name); }
      if (inc.length && inc.length <= 5) covering = { include: inc, sql: createIndexSql({ table: e.table.name, schema: e.table.schema, cols, include: inc, dialect, name: idxName(e.table.name, cols.map(c => c.name)) + '_cover' }) };
    }
    const extras = [];
    for (const x of e.extra) {
      if (x.kind === 'wildcard') extras.push(wildcardAdvice(e.table, x.column, dialect));
      else if (x.kind === 'functional') extras.push(functionalAdvice(e.table, x.predicate, dialect));
    }
    if (!cols.length && !extras.length) continue;
    out.push({ table: e.table.name, schema: e.table.schema, alias: e.table.alias, columns: cols, sql: cols.length ? createIndexSql({ table: e.table.name, schema: e.table.schema, cols, dialect }) : null, covering, notes, extras: extras.filter(Boolean) });
  }
  return { suggestions: out, unresolved: [...new Set(unresolved)] };
}

function wildcardAdvice(table, column, dialect) {
  const q = s => quoteId(s, dialect);
  const tn = (table.schema ? q(table.schema) + '.' : '') + q(table.name);
  if (dialect === 'postgresql') return { kind: 'trigram', text: `LIKE '%...' on ${column} cannot use a B-tree index. With the pg_trgm extension a trigram index can:`, sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE INDEX ${q(idxName(table.name, [column, 'trgm']))}\n  ON ${tn} USING gin (${q(column)} gin_trgm_ops);` };
  if (dialect === 'mysql') return { kind: 'fulltext', text: `LIKE '%...' on ${column} cannot use a B-tree index. A FULLTEXT index supports word search (MATCH ... AGAINST) instead of substring LIKE:`, sql: `ALTER TABLE ${tn} ADD FULLTEXT INDEX ${q(idxName(table.name, [column, 'ft']))} (${q(column)});` };
  if (dialect === 'sqlserver') return { kind: 'fulltext', text: `LIKE '%...' on ${column} cannot use a B-tree index. Consider SQL Server Full-Text Search (CREATE FULLTEXT INDEX) and CONTAINS().`, sql: null };
  return { kind: 'wildcard', text: `LIKE '%...' on ${column} cannot use a B-tree index. Consider full-text or trigram search where your database supports it.`, sql: null };
}
function functionalAdvice(table, p, dialect) {
  const q = s => quoteId(s, dialect);
  const tn = (table.schema ? q(table.schema) + '.' : '') + q(table.name);
  const col = p.column.name; const fn = p.nonSargableOperand.fn;
  const expr = `${fn.toLowerCase()}(${q(col)})`;
  if (dialect === 'postgresql') return { kind: 'functional', text: `${fn}(${col}) in the filter can be served by an expression index:`, sql: `CREATE INDEX ${q(idxName(table.name, [fn.toLowerCase(), col]))}\n  ON ${tn} (${expr});` };
  if (dialect === 'mysql') return { kind: 'functional', text: `${fn}(${col}) in the filter can be served by a functional index (MySQL 8.0.13+):`, sql: `CREATE INDEX ${q(idxName(table.name, [fn.toLowerCase(), col]))}\n  ON ${tn} ((${expr}));` };
  if (dialect === 'sqlite' || dialect === 'oracle') return { kind: 'functional', text: `${fn}(${col}) in the filter can be served by an expression / function-based index:`, sql: `CREATE INDEX ${q(idxName(table.name, [fn.toLowerCase(), col]))}\n  ON ${tn} (${expr});` };
  if (dialect === 'sqlserver') return { kind: 'functional', text: `SQL Server: add a computed column for ${fn}(${col}) and index it, or rewrite the filter as a range on ${col}.`, sql: null };
  return { kind: 'functional', text: `Rewrite the filter so ${col} is compared directly, or use a functional index if your database supports one.`, sql: null };
}

// ---------- mechanical rewrites ----------
/** Rewrite `x NOT IN (SELECT col FROM ... [WHERE ...])` as NOT EXISTS when the subquery is simple. Returns string or null. */
export function rewriteNotIn(notInText) {
  const m = /^\s*(.+?)\s+NOT\s+IN\s*\(\s*SELECT\s+(?:DISTINCT\s+)?([\w."`[\]]+)\s+(FROM\s+[\s\S]+?)\)\s*$/i.exec(notInText);
  if (!m) return null;
  const [, left, col, rest] = m;
  if (/\bSELECT\b/i.test(rest) || /\b(GROUP\s+BY|HAVING|LIMIT|ORDER\s+BY|UNION)\b/i.test(rest)) return null;
  const w = /\s+WHERE\s+([\s\S]+)$/i.exec(rest);
  const from = w ? rest.slice(0, w.index) : rest;
  const cond = w ? `(${norm(w[1])}) AND ${col} = ${left.trim()}` : `${col} = ${left.trim()}`;
  return `NOT EXISTS (SELECT 1 ${norm(from)} WHERE ${cond})`;
}
const yearRewrite = (fnArgsCol, op, lit) => {
  const y = Number(lit); if (!Number.isInteger(y) || y < 1 || y > 9999) return null;
  const a = `'${String(y).padStart(4, '0')}-01-01'`, b = `'${String(y + 1).padStart(4, '0')}-01-01'`;
  if (op === '=') return `${fnArgsCol} >= ${a} AND ${fnArgsCol} < ${b}`;
  if (op === '>') return `${fnArgsCol} >= ${b}`;
  if (op === '>=') return `${fnArgsCol} >= ${a}`;
  if (op === '<') return `${fnArgsCol} < ${a}`;
  if (op === '<=') return `${fnArgsCol} < ${b}`;
  return null;
};

// ---------- the main analysis ----------
const mkFinding = (id, extra, stmtIndex) => { const r = RULES[id]; return { id, severity: r ? r[0] : 'info', message: extra.message || r[1], suggestion: extra.suggestion || r[2], heuristic: true, source: id in EXTRA_RULES ? 'extra' : 'shared', rewrite: extra.rewrite || null, statement: stmtIndex, line: extra.line, col: extra.col, offset: extra.offset, length: extra.length }; };

function stmtLocalFindings(sql, T, blocks, stmt, loc, dialect, stmtIndex, derived) {
  const out = [];
  const add = (id, extra) => out.push(mkFinding(id, extra, stmtIndex));
  const { blockInfos } = derived;
  const findIn = (id, p) => derived.shared.find(f => f.id === id && f.offset >= p.offset && f.offset <= p.offset + p.length) || out.find(f => f.id === id && f.offset >= p.offset && f.offset <= p.offset + p.length);
  // statement-level: UNION without ALL
  for (const b of blocks) if (b.setOp && b.setOp.op === 'UNION' && !b.setOp.all) { const t = T[b.setOp.index]; const l = loc(t.pos, t.text.length); const end = T[b.setOp.index + (b.setOp.distinct ? 1 : 0)]; add('union-distinct', { ...l, rewrite: 'UNION ALL' }); void end; }
  for (const bi of blockInfos) {
    const b = bi.block;
    // SELECT-list based rules
    const sel = bi.select;
    const selKw = T[b.clauses.SELECT?.[0]?.kw];
    const hasStarOnly = sel.some(i => i.star);
    if (hasStarOnly && b.kind === 'in') add('in-subquery-star', spanLoc(loc, T.slice(b.start, b.end)));
    else if (hasStarOnly && (b.kind === 'derived' || b.kind === 'cte')) add('star-in-derived', spanLoc(loc, sel.filter(i => i.star).map(i => ({ pos: i.offset, text: ' '.repeat(i.length) }))));
    if (b.kind === 'exists' && sel.length > 1) add('exists-select-list', spanLoc(loc, T.slice(b.clauses.SELECT[0].start, b.clauses.SELECT[0].end)));
    if (b.kind === 'scalar' && b.parentClause === 'SELECT') {
      const parent = blockInfos[b.parent];
      const own = new Set(bi.tables.map(t => lc(t.alias || t.name)).concat(bi.tables.map(t => lc(t.name))));
      const anc = new Set(); let p = parent; while (p) { p.tables.forEach(t => { anc.add(lc(t.alias || t.name)); anc.add(lc(t.name)); }); p = blockInfos[p.block.parent]; }
      const quals = new Set(); const sl = T.slice(b.start, b.end);
      sl.forEach((t, k) => { if (isName(t) && sl[k + 1]?.text === '.' && isName(sl[k + 2])) quals.add(lc(cleanName(t))); });
      if ([...quals].some(q => anc.has(q) && !own.has(q))) add('correlated-subquery-select', spanLoc(loc, sl.slice(0, 2)));
    }
    if (b.kind === 'root' || b.kind === 'union' || b.kind === 'derived' || b.kind === 'cte' || b.kind === 'scalar' || b.kind === 'in' || b.kind === 'exists') {
      // DISTINCT + JOIN
      const selToks = rangeOf(T, b.clauses.SELECT?.[0]);
      if (isUp(selToks[0], 'DISTINCT') && bi.joins.some(j => !/CROSS/.test(String(j.type).toUpperCase())) && !b.clauses.GROUP_BY) add('distinct-hides-duplicates', spanLoc(loc, [selToks[0]]));
      // COUNT(col)
      const toks = [...clauseToks(T, b, 'SELECT'), ...clauseToks(T, b, 'HAVING')];
      toks.forEach((t, k) => { if (isUp(t, 'COUNT') && toks[k + 1]?.text === '(') { const c = matchingParen(toks, k + 1); const inner = toks.slice(k + 2, c); if (inner.length && !isUp(inner[0], 'DISTINCT') && inner.length && colRef(inner) && !(inner.length === 1 && inner[0].text === '*')) { const whole = toks.slice(k, c + 1); add('count-column', { ...spanLoc(loc, whole), rewrite: 'COUNT(*)' }); } } });
      // HAVING without aggregate
      const havingPreds = bi.having;
      for (const p of havingPreds) if (p.kind !== 'or' && !/\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|STRING_AGG|ARRAY_AGG|LISTAGG|STDDEV|VARIANCE|MEDIAN|ANY_VALUE|BOOL_AND|BOOL_OR|EVERY)\s*\(/i.test(p.text)) add('having-without-aggregate', p);
      // non-aggregated column
      if (bi.nonAggregated.length) for (const i of bi.nonAggregated) add('non-aggregated-column', { ...i, message: `Column ${i.text} in the SELECT list is neither aggregated nor in GROUP BY.${strictNote(dialect)}` });
      // ORDER BY expression / random
      for (const i of bi.order) if (i.expr && !i.random) add('order-by-expression', i);
      // OFFSET
      const off = b.clauses.OFFSET?.[0] || null;
      const lim = b.clauses.LIMIT?.[0] || null;
      let offTok = null;
      if (off) offTok = T.slice(off.start, off.end);
      else if (lim) { const lt = T.slice(lim.start, lim.end); const k = lt.findIndex(x => x.type === 'op' && x.text === ',') ; if (k > 0 && dialect === 'mysql') offTok = lt.slice(0, k); }
      if (offTok && offTok.length) { const n = offTok[0].type === 'number' ? Number(offTok[0].text) : null; if (n === null || n >= 1000 || (off && n > 0)) add('offset-pagination', { ...spanLoc(loc, offTok), message: n !== null && n < 1000 ? `OFFSET ${n}: harmless for small values, but deep pages (large OFFSET) read and discard every skipped row.` : undefined }); }
    }
    // predicate-based rules (WHERE + ON + HAVING)
    const checkPred = (p, where) => {
      if (p.kind === 'or') { if (where === 'on') add('or-in-join', p); for (const b2 of p.branches.flat()) checkPred(b2, where); return; }
      if (p.nullCompare) { const nf = findIn('null-comparison', p); const rw = p.text.replace(/\s*(=|<>|!=)\s*NULL\s*$/i, (m, o) => (o === '=' ? ' IS NULL' : ' IS NOT NULL')); if (nf && rw !== p.text) nf.rewrite = rw; else if (!nf) add('null-comparison', { ...p, rewrite: rw !== p.text ? rw : null }); }
      if (p.nullInList) add('not-in-null-list', p);
      if (p.multiWildcard) add('multiple-wildcard-like', p);
      if (p.sargable === false && p.nonSargableOperand) {
        if (where === 'on') add('function-in-join', p);
        else if (p.nonSargableOperand.kind === 'expr') add('arithmetic-on-column', p);
      }
      if (p.kind === 'not-in-subquery' && where === 'where') { const rw = rewriteNotIn(p.text); const nf = findIn('not-in-subquery', p); if (rw && nf) nf.rewrite = rw; }
      for (const h of p.hints) add('implicit-conversion', { ...p, message: h });
      // YEAR(col) = 2024 mechanical rewrite attached to the shared function-on-column finding
      if (p.nonSargableOperand?.kind === 'func' && p.nonSargableOperand.fn === 'YEAR' && p.right?.kind === 'literal' && p.right.literalType === 'number' && p.column) {
        const rw = yearRewrite(p.column.text, p.op, p.right.literal); const f = findIn('function-on-column', p);
        if (rw) { if (f) f.rewrite = rw; else add('arithmetic-on-column', { ...p, message: 'YEAR() on a column in a comparison is non-sargable.', rewrite: rw }); }
      }
      void where;
    };
    bi.where.forEach(p => checkPred(p, 'where')); bi.having.forEach(p => checkPred(p, 'having')); bi.on.forEach(p => checkPred(p, 'on'));
    // left join whose right table is filtered in WHERE
    bi.joinExplanations.forEach(je => { if (je.kind === 'LEFT' && je.whereFiltered) add('left-join-filtered', { line: je.join.line, col: je.join.col, offset: je.join.offset, length: je.join.length }); });
  }
  // merge shared-analyzer findings with the rewrite for NOT IN already attached above
  return out;
}
const strictNote = d => (d === 'mysql' ? ' (an error when ONLY_FULL_GROUP_BY is on, the default since MySQL 5.7.5).' : d === 'sqlite' ? ' (SQLite accepts it and picks an arbitrary row).' : ['postgresql', 'sqlserver', 'oracle', 'bigquery'].includes(d) ? ' (an error in this database).' : ' (an error in strict SQL).');

function inRange(pos, tokens, b) { const a = tokens[b.start]; const e = tokens[b.end - 1]; if (!a) return false; return pos >= a.pos && pos <= (e ? e.pos + e.text.length : a.pos); }

/**
 * Full analysis. Returns {ok, error?, dialect, note, warnings, statements:[...], summary} where each statement has
 * type, line, base (shared analyzer record), blocks (tree), joinExplanations, predicates, groupBy, orderLimit,
 * indexSuggestions, findings (shared + extra), graph and tree.
 */
export function analyzeQuery(sql, { dialect = 'standard', inListThreshold = 50 } = {}) {
  const shared = analyzeSql(sql, { dialect, inListThreshold });
  if (!shared.ok) return shared;
  const loc = makeLocator(sql);
  const stmtToks = splitStatements(sql, dialect);
  const statements = shared.statements.map((base, si) => {
    const T = stmtToks[si] || [];
    const blocks = parseBlocks(T);
    const blockInfos = [];
    const lookup = pos => { let best = null; for (const b of blocks) { if (inRange(pos, T, b)) if (!best || (b.end - b.start) < (best.end - best.start) || (b.end - b.start === best.end - best.start && b.id > best.id)) best = b; } return best || blocks[0]; };
    for (const b of blocks) blockInfos[b.id] = { block: b, tables: [], joins: [], columns: [], select: [], where: [], having: [], on: [], order: [], group: [], nonAggregated: [], joinExplanations: [] };
    for (const t of base.tables) blockInfos[lookup(t.offset).id].tables.push(t);
    for (const j of base.joins) blockInfos[lookup(j.offset).id].joins.push(j);
    for (const c of base.columns) blockInfos[lookup(c.offset).id].columns.push(c);
    for (const bi of blockInfos) {
      const b = bi.block;
      bi.select = selectItems(T, b, sql, loc);
      bi.where = splitPredicates(clauseToks(T, b, 'WHERE'), sql, loc);
      bi.having = splitPredicates(clauseToks(T, b, 'HAVING'), sql, loc);
      bi.on = (b.clauses.ON || []).flatMap(c => splitPredicates(rangeOf(T, c), sql, loc));
      // ORDER BY / GROUP BY items
      const mkItems = name => splitDepth0(clauseToks(T, b, name), x => x.type === 'op' && x.text === ',').map(tk => {
        let desc = false, core = tk;
        if (isUp(core[core.length - 1], 'ASC', 'DESC')) { desc = isUp(core[core.length - 1], 'DESC'); core = core.slice(0, -1); }
        if (isUp(core[core.length - 2], 'NULLS') && isUp(core[core.length - 1], 'FIRST', 'LAST')) core = core.slice(0, -2);
        const col = colRef(core); const cls = classifyOperand(core);
        const random = core.some(x => x.type === 'word' && RANDOM_FNS.has(x.text.toUpperCase()) && core[core.indexOf(x) + 1]?.text === '(');
        return { text: spanText(sql, tk), ...spanLoc(loc, tk), col, desc, expr: !col && core.length > 0 && !(core.length === 1 && core[0].type === 'number'), positional: core.length === 1 && core[0].type === 'number', random, cls };
      });
      bi.order = mkItems('ORDER_BY'); bi.group = mkItems('GROUP_BY');
      // GROUP BY validation
      const hasAgg = bi.select.some(i => i.isAgg);
      if ((bi.group.length || hasAgg) && b.clauses.SELECT) {
        const grp = bi.group.map(g => (g.positional ? bi.select[Number(g.text) - 1]?.col : g.col)).filter(Boolean);
        for (const i of bi.select) {
          if (i.isAgg || i.isWindow || i.star || !i.hasColumn) continue;
          if (!i.col) continue; // complex expressions are not checked
          const inGroup = grp.some(g => lc(g.name) === lc(i.col.name) && (!g.qualifier || !i.col.qualifier || lc(g.qualifier) === lc(i.col.qualifier)));
          if (!inGroup) bi.nonAggregated.push(i);
        }
        if (!bi.group.length && !hasAgg) bi.nonAggregated.length = 0;
      }
      // joins explained
      const whereCols = collectColumns(bi.where);
      bi.joinExplanations = bi.joins.map(j => {
        const jj = { ...j, lateral: /\bLATERAL\b/i.test(sql.slice(j.offset, j.offset + 80)) };
        const names = new Set([lc(j.alias), lc(j.table)].filter(Boolean));
        const whereFiltered = whereCols.some(c => c.qualifier && names.has(lc(c.qualifier)) && !c.isNullTest);
        return { join: j, ...explainJoin(jj, { whereFilteredRight: whereFiltered }), kind: explainJoinKind(j.type), whereFiltered };
      });
    }
    const root = blockInfos[0];
    // index suggestions per block that has tables
    const suggestions = []; const unresolved = [];
    for (const bi of blockInfos) {
      if (!bi.tables.length || !['root', 'union', 'derived', 'cte', 'scalar', 'in', 'exists'].includes(bi.block.kind)) continue;
      if (base.type !== 'SELECT' && bi.block.id === 0 && !['UPDATE', 'DELETE'].includes(base.type)) continue;
      const stars = base.stars.filter(s => lookup(s.offset) === bi.block);
      const columnsUsed = bi.columns.filter(c => c.clauses.includes('SELECT'));
      const r = indexCandidates({ block: bi.block, tables: bi.tables, sql, T, preds: bi.where, onPreds: bi.on, orderItems: bi.order, groupItems: bi.group, selectItems: bi.select, stars, columnsUsed, dialect });
      r.suggestions.forEach(s => suggestions.push({ ...s, block: bi.block.id }));
      unresolved.push(...r.unresolved);
    }
    const findingsShared = base.findings.map(f => ({ ...f, source: 'shared', rewrite: null }));
    const extra = stmtLocalFindings(sql, T, blocks, base, loc, dialect, si, { blockInfos, shared: findingsShared });
    const findings = [...findingsShared, ...extra].sort((a, b) => a.offset - b.offset || a.id.localeCompare(b.id));
    const dedup = []; for (const f of findings) if (!dedup.some(g => g.id === f.id && g.offset === f.offset)) dedup.push(f);
    return {
      index: si, type: base.type, line: base.line, col: base.col, offset: base.offset, length: base.length, base,
      blocks: blockInfos.map(bi => ({ id: bi.block.id, kind: bi.block.kind, parent: bi.block.parent, name: bi.block.name || bi.block.alias || null, alias: bi.block.alias || null, tables: bi.tables.map(t => ({ name: t.name, schema: t.schema, alias: t.alias, kind: t.kind })), joins: bi.joins.length, children: bi.block.children, clause: bi.block.parentClause || null, setOp: bi.block.setOp ? bi.block.setOp.op + (bi.block.setOp.all ? ' ALL' : '') : null, ...(T[bi.block.start] ? loc(T[bi.block.start].pos) : {}) })),
      joinExplanations: blockInfos.flatMap(bi => bi.joinExplanations.map(j => ({ ...j, block: bi.block.id }))),
      predicates: { where: root.where.length || blockInfos.some(b => b.where.length) ? blockInfos.flatMap(b => b.where.map(p => ({ ...p, block: b.block.id }))) : [], having: blockInfos.flatMap(b => b.having.map(p => ({ ...p, block: b.block.id }))), on: blockInfos.flatMap(b => b.on.map(p => ({ ...p, block: b.block.id }))) },
      groupBy: blockInfos.filter(b => b.group.length || b.nonAggregated.length || b.having.length).map(b => ({ block: b.block.id, group: b.group.map(g => g.text), having: b.having.map(p => ({ text: p.text, hasAggregate: /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|STRING_AGG|ARRAY_AGG|LISTAGG)\s*\(/i.test(p.text) })), nonAggregated: b.nonAggregated.map(i => i.text), strict: strictNote(dialect).trim() })),
      orderLimit: blockInfos.filter(b => b.order.length || b.block.clauses.LIMIT || b.block.clauses.OFFSET || b.block.clauses.FETCH).map(b => ({ block: b.block.id, order: b.order.map(o => ({ text: o.text, expr: o.expr, random: o.random, desc: o.desc, positional: o.positional })), limit: b.block.clauses.LIMIT ? spanText(sql, rangeOf(T, b.block.clauses.LIMIT[0])) : null, offset: b.block.clauses.OFFSET ? spanText(sql, rangeOf(T, b.block.clauses.OFFSET[0])) : null })),
      indexSuggestions: suggestions, unresolvedColumns: [...new Set(unresolved)],
      graphs: buildGraphs(blockInfos),
      findings: dedup, text: sql.slice(base.offset, base.offset + base.length),
    };
  });
  const findings = statements.flatMap(s => s.findings);
  return { ok: true, dialect, note: HEURISTIC_NOTE, indexNote: INDEX_NOTE, warnings: shared.warnings, statements, summary: { statements: statements.length, tables: shared.summary.tables, findings: findings.length, warnings: findings.filter(f => f.severity === 'warn').length, maxComplexity: shared.summary.maxComplexity } };
}

function explainJoinKind(type) { const t = String(type).toUpperCase().replace('NATURAL', '').replace('APPLY', '').trim(); return t || 'INNER'; }
function collectColumns(preds) {
  const out = [];
  const walk = p => { if (p.kind === 'or') { p.branches.flat().forEach(walk); return; } if (p.column) out.push({ ...p.column, isNullTest: p.kind === 'null' && p.negated === false }); if (p.columns?.length) p.columns.forEach(c => out.push(c)); if (p.nonSargableOperand?.col) out.push(p.nonSargableOperand.col); };
  preds.forEach(walk); return out;
}

// ---------- join graph ----------
/** Graph per block that has at least one table: {block, title, nodes:[{id,label,kind}], edges:[{from,to,type,label,condition}]}. */
export function buildGraphs(blockInfos) {
  const graphs = [];
  for (const bi of blockInfos) {
    const tables = bi.tables.filter(t => t.role === 'from' || t.role === 'join' || t.role === 'using');
    if (!tables.length || (!bi.joins.length && tables.length < 2)) continue;
    const nodes = []; const byKey = new Map();
    const key = t => lc(t.alias || t.name);
    for (const t of tables) { if (byKey.has(key(t))) continue; const n = { id: `n${nodes.length}`, label: t.alias && t.alias !== t.name ? `${t.name} ${t.alias}` : t.name, name: t.name, alias: t.alias, kind: t.kind === 'derived' ? 'subquery' : t.kind }; nodes.push(n); byKey.set(key(t), n); byKey.set(lc(t.name), byKey.get(lc(t.name)) || n); }
    const edges = [];
    const fromTables = tables.filter(t => t.role === 'from');
    const first = fromTables[0] ? byKey.get(key(fromTables[0])) : nodes[0];
    for (let i = 1; i < fromTables.length; i++) edges.push({ from: first.id, to: byKey.get(key(fromTables[i])).id, type: 'COMMA', label: 'implicit join (comma)', condition: '' });
    let prev = first;
    for (const j of bi.joins) {
      const target = byKey.get(lc(j.alias || j.table)) || nodes.find(n => n.kind === 'subquery' && !edges.some(e => e.to === n.id));
      if (!target) continue;
      const pairs = pairsOf(j.condition || '');
      let from = null;
      for (const p of pairs) { const l = byKey.get(lc(p.lq)), r = byKey.get(lc(p.rq)); if (l === target && r && r !== target) { from = r; break; } if (r === target && l && l !== target) { from = l; break; } }
      edges.push({ from: (from || prev).id, to: target.id, type: String(j.type).toUpperCase(), label: `${String(j.type).toUpperCase()} JOIN`, condition: norm(j.condition) });
      prev = target;
    }
    if (nodes.length) graphs.push({ block: bi.block.id, title: bi.block.kind === 'root' ? 'Main query' : `${bi.block.kind}${bi.block.name ? ' ' + bi.block.name : bi.block.alias ? ' ' + bi.block.alias : ''}`, nodes, edges });
  }
  return graphs;
}

// ---------- reports ----------
/** Markdown report of an analysis result (plain text, no HTML). */
export function buildMarkdownReport(analysis, { title = 'SQL analysis report' } = {}) {
  if (!analysis || !analysis.ok) return `# ${title}\n\nNo analysis available.\n`;
  const L = [`# ${title}`, '', `> ${analysis.note}`, '', `Dialect: ${SQL_DIALECTS[analysis.dialect]?.label || analysis.dialect}  `, `Statements: ${analysis.summary.statements} | Tables: ${analysis.summary.tables.join(', ') || 'none'} | Findings: ${analysis.summary.findings} (${analysis.summary.warnings} warnings)`, ''];
  for (const s of analysis.statements) {
    L.push(`## Statement ${s.index + 1} (${s.type}, line ${s.line})`, '', '```sql', s.text.length > 2000 ? s.text.slice(0, 2000) + '\n-- ...' : s.text, '```', '');
    if (s.joinExplanations.length) { L.push('### Joins', ''); for (const j of s.joinExplanations) { L.push(`- **${j.type} JOIN ${j.target}**: ${j.summary}`); for (const w of j.warnings) L.push(`  - Warning: ${w}`); } L.push(''); }
    const preds = [...s.predicates.where, ...s.predicates.on].filter(p => p.kind !== 'or');
    if (preds.length) { L.push('### Predicates', ''); for (const p of preds) L.push(`- \`${p.text.replace(/\s+/g, ' ')}\` - ${p.sargable === true ? 'sargable' : p.sargable === false ? 'NOT sargable' : 'n/a'}${p.reasons.length ? ': ' + p.reasons.join(' ') : ''}`); L.push(''); }
    if (s.indexSuggestions.length) { L.push(`### Index suggestions`, '', `_${analysis.indexNote}_`, ''); for (const x of s.indexSuggestions) { if (x.sql) L.push('```sql', x.sql, '```'); if (x.covering) L.push('Covering variant:', '```sql', x.covering.sql, '```'); for (const n of x.notes) L.push(`- ${n}`); for (const e of x.extras) { L.push(`- ${e.text}`); if (e.sql) L.push('```sql', e.sql, '```'); } } L.push(''); }
    if (s.findings.length) { L.push('### Findings', ''); for (const f of s.findings) L.push(`- **${f.severity}** \`${f.id}\` (line ${f.line}, col ${f.col}): ${f.message} ${f.suggestion}${f.rewrite ? ` Rewrite: \`${f.rewrite.replace(/\s+/g, ' ')}\`` : ''}`); L.push(''); }
  }
  return L.join('\n');
}

/** JSON report (string). Drops token-level internals. */
export function buildJsonReport(analysis) {
  if (!analysis || !analysis.ok) return JSON.stringify({ ok: false }, null, 2);
  const strip = p => { const { left, right, nonSargableOperand, branches, ...rest } = p; return { ...rest, ...(branches ? { branches: branches.map(b => b.map(strip)) } : {}) }; };
  return JSON.stringify({ note: analysis.note, indexNote: analysis.indexNote, dialect: analysis.dialect, summary: analysis.summary, warnings: analysis.warnings, statements: analysis.statements.map(s => ({
    index: s.index, type: s.type, line: s.line, text: s.text, blocks: s.blocks, joins: s.joinExplanations.map(j => ({ type: j.type, target: j.target, summary: j.summary, lines: j.lines, warnings: j.warnings })),
    predicates: { where: s.predicates.where.map(strip), having: s.predicates.having.map(strip), on: s.predicates.on.map(strip) }, groupBy: s.groupBy, orderLimit: s.orderLimit, indexSuggestions: s.indexSuggestions, graphs: s.graphs,
    findings: s.findings.map(f => ({ id: f.id, severity: f.severity, line: f.line, col: f.col, message: f.message, suggestion: f.suggestion, rewrite: f.rewrite })) })) }, null, 2);
}

/** All lint rules (shared + extra) as [{id, severity, message, suggestion, source}] for the reference list. */
export const allRules = () => Object.entries(RULES).map(([id, r]) => ({ id, severity: r[0], message: r[1], suggestion: r[2], source: id in EXTRA_RULES ? 'extra' : 'shared' }));
