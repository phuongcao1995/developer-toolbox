// Shared SQL analyser - pure functions, no DOM, no network, no eval.
//
//   analyzeSql(sql, { dialect, inListThreshold })  -> { ok, error? , statements[], findings[], summary, warnings[] }
//   explainSql(sql, { dialect })                    -> { ok, error?, statements[{steps, indexHints, ...}] }
//
// IMPORTANT: this is HEURISTIC static text analysis of the SQL string (token stream, one linear pass per
// statement). It never connects to a database, never executes the query and is NOT an execution plan.
// Reuses the O(n) tokenizer of the SQL Formatter, so comments, string literals and quoted identifiers are
// never mistaken for code. Designed to be reused by a future "SQL Query Analyzer" tool.
import { tokenize, isSqlKeyword, isSqlFunction } from '../../../tools/sql-formatter/logic.js';

export const HEURISTIC_NOTE = 'Heuristic static analysis - not a database execution plan; use EXPLAIN on your database for real plans.';

const set = s => new Set(s.split(/\s+/).filter(Boolean));
const KNOWN_TYPES = set(`SELECT INSERT UPDATE DELETE MERGE CREATE ALTER DROP TRUNCATE REPLACE WITH EXPLAIN GRANT REVOKE BEGIN COMMIT
ROLLBACK SET USE SHOW DESCRIBE DESC CALL EXEC EXECUTE VALUES TABLE PRAGMA ANALYZE VACUUM START SAVEPOINT COMMENT RENAME DECLARE`);
const WALKED = set('SELECT INSERT UPDATE DELETE MERGE REPLACE WITH VALUES TABLE');
const AGGREGATES = set(`COUNT SUM AVG MIN MAX GROUP_CONCAT STRING_AGG ARRAY_AGG LISTAGG JSON_AGG JSONB_AGG JSON_ARRAYAGG JSON_OBJECTAGG
BOOL_AND BOOL_OR EVERY STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP MEDIAN MODE PERCENTILE_CONT PERCENTILE_DISC BIT_AND
BIT_OR XMLAGG ANY_VALUE APPROX_COUNT_DISTINCT`);
const WINDOW_ONLY = set('ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE PERCENT_RANK CUME_DIST');
const NOT_FUNCTIONS = set('FILTER WITHIN OVER IN ANY ALL SOME EXISTS AS ON USING VALUES');
const SET_OPS = set('UNION INTERSECT EXCEPT MINUS');
const JOIN_WORDS = set('NATURAL INNER LEFT RIGHT FULL OUTER CROSS');
const COMPARE_OPS = set('= <> != < > <= >= <=> ==');
const EXTRA_RESERVED = set('USE FORCE TABLESAMPLE PIVOT UNPIVOT WITHIN FILTER OVER STRAIGHT_JOIN APPLY');
const COLUMN_CLAUSES = set('SELECT WHERE ON GROUP_BY HAVING ORDER_BY SET USING_COLS INTO RETURNING QUALIFY WINDOW');
const NULL_CMP_CLAUSES = set('SELECT WHERE ON HAVING QUALIFY ORDER_BY');

/** Documented complexity formula (also returned as `complexity.formula`). */
export const COMPLEXITY_FORMULA = '1 + 2*joins + 2*subqueries + 1*CTEs + 2*(extra UNION parts) + 2*window functions + 1 if GROUP BY + 1 if HAVING + 1 if DISTINCT + 0.5*(AND/OR operators in WHERE/ON/HAVING); rounded. Levels: <=5 low, <=12 medium, else high.';

const clean = t => {
  const x = t.text;
  if (t.type !== 'ident') return x;
  const a = x[0];
  if (a === '"' || a === '`') return x.slice(1, x.endsWith(a) && x.length > 1 ? -1 : undefined).split(a + a).join(a);
  if (a === '[') return x.slice(1, x.endsWith(']') ? -1 : undefined);
  return x;
};
const isNameTok = t => !!t && (t.type === 'word' || t.type === 'ident');

function makeLocator(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos, length = 0) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: pos - starts[lo] + 1, offset: pos, length };
  };
}

function splitStatements(sig) {
  const out = []; let cur = [];
  for (const t of sig) {
    if (t.type === 'op' && t.text === ';') { if (cur.length) out.push(cur); cur = []; } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Message / suggestion catalogue: every finding id is documented here. */
export const LINT_RULES = {
  'select-star': ['info', 'SELECT * returns every column, including ones you may not need.', 'List only the columns you need; this reduces data transfer and keeps results stable when the table changes.'],
  'update-no-where': ['warn', 'UPDATE without a WHERE clause changes every row.', 'Add a WHERE clause, or confirm that updating all rows is intended (consider running it in a transaction).'],
  'delete-no-where': ['warn', 'DELETE without a WHERE clause removes every row.', 'Add a WHERE clause, or use TRUNCATE if you really want to empty the table.'],
  'leading-wildcard-like': ['warn', 'LIKE pattern starts with a wildcard, so a normal B-tree index cannot be used for the search.', 'Anchor the pattern at the start (LIKE \'abc%\') or use full-text / trigram search.'],
  'function-on-column': ['warn', 'A function wraps a column inside a WHERE comparison (non-sargable: indexes on that column are usually not used).', 'Move the function to the other side of the comparison, or use a functional/computed index.'],
  'implicit-join': ['warn', 'Comma-separated tables in FROM (implicit join): a forgotten WHERE condition silently becomes a cartesian product.', 'Use explicit JOIN ... ON syntax.'],
  'or-different-columns': ['info', 'OR across different columns often prevents a single index from being used.', 'Consider UNION ALL of separate queries, or make sure each branch is indexed.'],
  'not-in-subquery': ['warn', 'NOT IN (subquery) returns no rows if the subquery yields any NULL, and is often slow.', 'Use NOT EXISTS or a LEFT JOIN ... IS NULL anti-join.'],
  'limit-no-order': ['warn', 'LIMIT / TOP without ORDER BY returns an arbitrary set of rows.', 'Add an ORDER BY (with a unique tie-breaker) so the result is deterministic.'],
  'order-by-rand': ['warn', 'ORDER BY RAND()/RANDOM() sorts the whole result set just to pick random rows.', 'Pick random keys with an indexed range or sample approach instead of sorting all rows.'],
  'null-comparison': ['warn', 'Comparing with NULL using = or <> never evaluates to true.', 'Use IS NULL / IS NOT NULL (or IS [NOT] DISTINCT FROM).'],
  'distinct-group-by': ['info', 'DISTINCT together with GROUP BY is usually redundant.', 'Remove DISTINCT unless it is applied to a subset of the grouped output you rely on.'],
  'large-in-list': ['info', 'Very large IN (...) list.', 'Consider a temporary table / join, or batching the lookup.'],
  'join-no-condition': ['warn', 'JOIN without ON/USING produces a cartesian product.', 'Add an ON condition (or use CROSS JOIN explicitly if that is intended).'],
  'join-non-equality': ['info', 'JOIN condition has no equality comparison; the database may have to compare many row pairs.', 'Check that this range/inequality join is intended and indexed.'],
};

function walkStatement(T, env) {
  const { src, loc, dialect, opts } = env;
  const n = T.length;
  const up = i => (i >= 0 && i < n && T[i].type === 'word' ? T[i].up || T[i].text.toUpperCase() : null);
  const isKw = t => t.type === 'word' && !!(t.up || t.text) && (isSqlKeyword((t.up || t.text.toUpperCase()), dialect) || EXTRA_RESERVED.has(t.up));
  const kwFn = t => isSqlFunction(t.up || '');
  const match = new Int32Array(n).fill(-1);
  { const st = []; for (let i = 0; i < n; i++) { if (T[i].text === '(' && T[i].type === 'op') st.push(i); else if (T[i].text === ')' && T[i].type === 'op' && st.length) match[st.pop()] = i; } }
  const closeOf = i => (match[i] >= 0 ? match[i] : n);
  const snippet = (a, b) => (b > a && a < n ? src.slice(T[a].pos, T[Math.min(b, n) - 1].pos + T[Math.min(b, n) - 1].text.length) : '');
  const tokLoc = i => loc(T[i].pos, T[i].text.length);

  const A = { tables: [], columns: [], stars: [], joins: [], ctes: [], aggregates: new Map(), windows: [], params: [], findings: [],
    subCount: 0, maxDepth: 0, distinct: false, implicitJoins: 0, boolOps: 0, scopes: [], type: null, hasWith: false };
  const finding = (id, i, extra = {}) => {
    const r = LINT_RULES[id];
    A.findings.push({ id, severity: r[0], message: extra.message || r[1], suggestion: extra.suggestion || r[2], heuristic: true, ...tokLoc(i), ...(extra.loc || {}) });
  };

  const mkScope = (kind, isQuery, parent, depth) => ({ kind, isQuery, parent, q: null, depth, clause: null, clauseStart: 0, clauses: [], cteExpect: false, expectTable: false,
    joinCur: null, awaitAlias: null, mainType: null, hasSelect: false, hasWhere: false, hasGroup: false, hasHaving: false, hasOrder: false,
    hasLimit: false, limitTok: -1, distinct: false, setOps: 0, derived: false, cteName: null, existsCtx: false, closeAt: -1 });
  const root = mkScope('stmt', true, null, 0);
  const stack = [root];
  A.scopes.push(root);
  const qOf = s => (s.isQuery ? s : s.q);

  const closeClause = (q, at) => {
    if (q.clause) {
      const c = { name: q.clause, start: q.clauseStart, end: at };
      q.clauses.push(c);
      if (q.clause === 'ON' && q.joinCur) { q.joinCur.condStart = q.joinCur.condStart ?? c.start; q.joinCur.condEnd = at; }
    }
  };
  const setClause = (q, name, at) => { closeClause(q, at); q.clause = name; q.clauseStart = at + 1; q.expectTable = false; };
  const clauseOfCol = q => (q.clause === 'INTO' ? 'INSERT' : (q.clause || '').replace('_', ' '));

  const operandEnd = i => {
    const p = T[i - 1];
    if (!p) return false;
    if (p.type === 'ident' || p.type === 'string' || p.type === 'number' || p.type === 'placeholder') return true;
    if (p.text === ')' && p.type === 'op') return true;
    if (p.type === 'word') return !isKw(p) || p.up === 'END';
    return false;
  };

  const parseTable = (q, i, role) => {
    let j = i; const parts = [];
    while (isNameTok(T[j])) {
      parts.push(clean(T[j])); j++;
      if (T[j]?.text === '.' && isNameTok(T[j + 1])) j++; else break;
    }
    if (T[j]?.text === '(' && T[j].type === 'op' && (role === 'from' || role === 'join' || role === 'using')) return { end: i, fn: true };
    let alias = null;
    let k = j;
    if (up(k) === 'AS') k++;
    if (isNameTok(T[k]) && (T[k].type === 'ident' || !isKw(T[k]))) { alias = clean(T[k]); j = k + 1; }
    const e = { name: parts[parts.length - 1], schema: parts.length > 1 ? parts.slice(0, -1).join('.') : null, alias, kind: 'table', role,
      depth: q.depth, ...tokLoc(i) };
    A.tables.push(e);
    return { end: j - 1, entry: e };
  };

  const checkFunctionOnColumn = (nameIdx, open, q) => {
    if (q.clause !== 'WHERE') return;
    const close = closeOf(open);
    const before = T[nameIdx - 1], after = T[close + 1];
    const cmp = t => !!t && ((t.type === 'op' && COMPARE_OPS.has(t.text)) || (t.type === 'word' && ['LIKE', 'ILIKE', 'IN', 'BETWEEN', 'IS', 'NOT'].includes(t.up)));
    if (!cmp(before) && !cmp(after)) return;
    // only genuine value-comparison contexts: skip when an argument contains a subquery
    let hasCol = false;
    for (let k = open + 1; k < close; k++) {
      const t = T[k];
      if (t.type === 'word' && (t.up === 'SELECT' || t.up === 'WITH')) return;
      if (!isNameTok(t) || (t.type === 'word' && (isKw(t) || (T[k + 1]?.text === '(' && T[k + 1].type === 'op')))) continue;
      if (T[k - 1]?.text === '::' || up(k - 1) === 'AS' || T[k - 1]?.type === 'string' || T[k - 1]?.type === 'number') continue;
      hasCol = true; break;
    }
    if (hasCol) finding('function-on-column', nameIdx, { message: `Function ${T[nameIdx].text}() wraps a column inside a WHERE comparison (non-sargable: an index on that column is usually not used).` });
  };

  const likeWildcard = i => {
    const nx = T[i + 1];
    const startsPct = t => t?.type === 'string' && /^[A-Za-z]?['"]%/.test(t.text);
    if (startsPct(nx)) return true;
    return nx?.type === 'word' && /^CONCAT$/i.test(nx.text) && T[i + 2]?.text === '(' && startsPct(T[i + 3]);
  };

  // ---- main walk ----
  for (let i = 0; i < n; i++) {
    const t = T[i];
    const top = stack[stack.length - 1];
    const q = qOf(top);
    const u = t.type === 'word' ? (t.up || t.text.toUpperCase()) : null;
    const prevDot = T[i - 1]?.text === '.' && T[i - 1].type === 'op';

    if (t.type === 'placeholder') A.params.push(i);

    // alias after a derived table "( SELECT ... ) [AS] x"
    if (q.awaitAlias && top === q) {
      const d = q.awaitAlias;
      if (u === 'AS') continue;
      q.awaitAlias = null;
      if (isNameTok(t) && (t.type === 'ident' || !isKw(t))) { A.tables.push({ name: clean(t), schema: null, alias: clean(t), kind: 'derived', role: d.role, depth: q.depth, ...tokLoc(i) }); continue; }
    }

    if (t.type === 'op' && t.text === '(') {
      const nx = T[i + 1];
      const isSub = nx?.type === 'word' && (nx.up === 'SELECT' || nx.up === 'WITH');
      const prev = T[i - 1];
      if (isSub) {
        if (prev?.up === 'IN' && T[i - 2]?.up === 'NOT') finding('not-in-subquery', i - 2, {});
        const s = mkScope('sub', true, q, q.depth + 1);
        s.q = null; s.closeAt = closeOf(i); s.existsCtx = prev?.up === 'EXISTS';
        const inCte = q.clause === 'WITH';
        if (inCte) { s.cteName = q.lastCte || null; q.cteExpect = false; } else A.subCount++;
        if (q.expectTable && (q.clause === 'FROM' || q.clause === 'JOIN' || q.clause === 'USING')) { s.derived = true; s.role = q.clause === 'JOIN' ? 'join' : 'from'; q.expectTable = false; if (q.clause === 'JOIN' && q.joinCur) q.joinCur.derived = true; }
        A.maxDepth = Math.max(A.maxDepth, s.depth);
        A.scopes.push(s); stack.push(s);
      } else {
        const fnTok = prev;
        let fn = null;
        if (fnTok && fnTok.type === 'word' && !NOT_FUNCTIONS.has(fnTok.up) && (!isKw(fnTok) || kwFn(fnTok)) && !['INTO', 'WITH', 'UPDATE'].includes(q.clause) && !(q.expectTable)) {
          fn = { name: fnTok.text, idx: i - 1 };
          const fu = fnTok.up;
          const closeIdx = closeOf(i);
          let nxt = T[closeIdx + 1];
          if (nxt?.up === 'FILTER' && T[closeIdx + 2]?.text === '(' && match[closeIdx + 2] >= 0) nxt = T[match[closeIdx + 2] + 1];
          if (nxt?.up === 'OVER') A.windows.push({ name: fnTok.text, ...tokLoc(i - 1) });
          else if (AGGREGATES.has(fu)) { const a = A.aggregates.get(fu) || { name: fu, count: 0, loc: tokLoc(i - 1) }; a.count++; A.aggregates.set(fu, a); }
          checkFunctionOnColumn(i - 1, i, q);
          if (q.clause === 'ORDER_BY' && /^(RAND|RANDOM|NEWID|RANDOMBLOB)$/.test(fu)) finding('order-by-rand', i - 1, { message: `ORDER BY ${fnTok.text}() sorts the whole result set just to pick random rows.` });
        }
        if (prev?.up === 'IN') {
          const close = closeOf(i); let commas = 0, depth = 0;
          for (let k = i + 1; k < close; k++) { const x = T[k]; if (x.type !== 'op') continue; if (x.text === '(') depth++; else if (x.text === ')') depth--; else if (x.text === ',' && depth === 0) commas++; }
          if (commas + 1 > (opts.inListThreshold ?? 50)) finding('large-in-list', i - 1, { message: `IN list with ${commas + 1} items.` });
        }
        const s = mkScope('expr', false, null, q.depth);
        s.q = q; s.closeAt = closeOf(i); s.fn = fn;
        stack.push(s);
      }
      continue;
    }
    if (t.type === 'op' && t.text === ')') {
      if (stack.length > 1) {
        const s = stack.pop();
        if (s.isQuery) {
          closeClause(s, i);
          const parent = qOf(stack[stack.length - 1]);
          if (s.derived) parent.awaitAlias = { role: s.role };
        }
      }
      continue;
    }

    if (top.isQuery && u && !prevDot) {
      const nx = up(i + 1);
      let handled = true;
      switch (u) {
        case 'WITH':
          if (q.clause === null && !q.mainType) { setClause(q, 'WITH', i); q.cteExpect = true; q.hasWith = true; if (q === root) A.hasWith = true; if (nx === 'RECURSIVE') i++; }
          else handled = false;
          break;
        case 'SELECT':
          setClause(q, 'SELECT', i); q.hasSelect = true;
          if (!q.mainType) q.mainType = 'SELECT';
          break;
        case 'DISTINCT':
          if (q.clause === 'SELECT' && up(i - 1) === 'SELECT') { q.distinct = true; if (q === root) A.distinct = true; } else handled = false;
          break;
        case 'FROM':
          if (up(i - 1) === 'DISTINCT' && ['IS', 'NOT'].includes(up(i - 2))) { handled = false; break; }
          setClause(q, 'FROM', i); q.expectTable = true;
          break;
        case 'INSERT': case 'REPLACE':
          if (!q.mainType && (u === 'INSERT' || nx === 'INTO')) { q.mainType = u; q.clause = null; closeClause(q, i); q.clause = 'INSERT'; q.clauseStart = i + 1; } else handled = false;
          break;
        case 'INTO':
          if (q.mainType === 'INSERT' || q.mainType === 'REPLACE') { setClause(q, 'INTO', i); q.expectTable = true; } else handled = false;
          break;
        case 'UPDATE':
          if (!q.mainType) { q.mainType = 'UPDATE'; setClause(q, 'UPDATE', i); q.expectTable = true; }
          else if (up(i - 1) === 'KEY') setClause(q, 'SET', i);
          else handled = false;
          break;
        case 'DELETE':
          if (!q.mainType) { q.mainType = 'DELETE'; setClause(q, 'DELETE', i); } else handled = false;
          break;
        case 'MERGE':
          if (!q.mainType) { q.mainType = 'MERGE'; setClause(q, 'MERGE', i); if (nx === 'INTO') i++; q.expectTable = true; } else handled = false;
          break;
        case 'SET':
          if (q.mainType === 'UPDATE' || q.mainType === 'MERGE') setClause(q, 'SET', i); else handled = false;
          break;
        case 'VALUES': setClause(q, 'VALUES', i); break;
        case 'WHERE': setClause(q, 'WHERE', i); q.hasWhere = true; break;
        case 'GROUP': if (nx === 'BY') { setClause(q, 'GROUP_BY', i + 1); q.hasGroup = true; i++; } else handled = false; break;
        case 'HAVING': setClause(q, 'HAVING', i); q.hasHaving = true; break;
        case 'ORDER': if (nx === 'BY') { setClause(q, 'ORDER_BY', i + 1); q.hasOrder = true; i++; } else handled = false; break;
        case 'LIMIT': setClause(q, 'LIMIT', i); q.hasLimit = true; q.limitTok = i; break;
        case 'FETCH': if (nx === 'FIRST' || nx === 'NEXT') { setClause(q, 'FETCH', i); q.hasLimit = true; q.limitTok = i; } else handled = false; break;
        case 'TOP': if (q.clause === 'SELECT') { q.hasLimit = true; q.limitTok = i; } handled = false; break;
        case 'OFFSET': setClause(q, 'OFFSET', i); break;
        case 'QUALIFY': case 'RETURNING': case 'WINDOW': setClause(q, u, i); break;
        case 'UNION': case 'INTERSECT': case 'EXCEPT': case 'MINUS':
          if (SET_OPS.has(u)) { q.setOps++; setClause(q, 'SETOP', i); if (nx === 'ALL' || nx === 'DISTINCT') i++; q.clause = null; } break;
        case 'USING':
          if (q.joinCur && q.clause === 'JOIN') { q.joinCur.usingMark = true; setClause(q, 'USING_COLS', i); q.joinCur.condStart = i + 1; }
          else if (q.mainType === 'MERGE' || q.mainType === 'DELETE') { setClause(q, 'USING', i); q.expectTable = true; }
          else handled = false;
          break;
        case 'ON':
          if (nx === 'CONFLICT') { setClause(q, 'UPSERT', i); i++; }
          else if (nx === 'DUPLICATE') { setClause(q, 'UPSERT', i); }
          else if (q.clause === 'JOIN' || q.clause === 'USING_COLS') { setClause(q, 'ON', i); if (q.joinCur) q.joinCur.condStart = i + 1; }
          else if (q.mainType === 'MERGE') setClause(q, 'ON', i);
          else handled = false;
          break;
        case 'STRAIGHT_JOIN': case 'NATURAL': case 'INNER': case 'LEFT': case 'RIGHT': case 'FULL': case 'OUTER': case 'CROSS': case 'JOIN': {
          let k = i; const words = [];
          while (T[k]?.type === 'word' && (JOIN_WORDS.has(up(k)))) { words.push(up(k)); k++; }
          let kind = null;
          if (up(k) === 'JOIN') { kind = 'JOIN'; k++; }
          else if (up(k) === 'STRAIGHT_JOIN') { kind = 'JOIN'; k++; }
          else if (up(k) === 'APPLY' && (words.at(-1) === 'CROSS' || words.at(-1) === 'OUTER')) { kind = 'APPLY'; k++; }
          if (!kind || !q.hasSelect && !q.mainType) { handled = false; break; }
          const jt = (words.filter(w => w !== 'OUTER').join(' ') || 'INNER') + (kind === 'APPLY' ? ' APPLY' : '');
          setClause(q, 'JOIN', i); q.expectTable = true;
          q.joinCur = { type: jt, table: null, alias: null, schema: null, condition: '', using: false, flags: [], ...tokLoc(i) };
          A.joins.push(q.joinCur);
          i = k - 1;
          break;
        }
        case 'LATERAL': case 'ONLY': if (q.expectTable) { /* keep waiting for the table name */ } else handled = false; break;
        default: handled = false;
      }
      if (handled) continue;
    }

    // table names
    if (top.isQuery && q.expectTable && isNameTok(t) && !(t.type === 'word' && isKw(t) && !kwFn(t))) {
      const role = ({ FROM: 'from', JOIN: 'join', INTO: 'insert', UPDATE: 'update', USING: 'using', MERGE: 'merge' })[q.clause] || 'from';
      const r = parseTable(q, i, role);
      q.expectTable = false;
      if (r.entry) {
        if (q.clause === 'JOIN' && q.joinCur) { q.joinCur.table = r.entry.name; q.joinCur.schema = r.entry.schema; q.joinCur.alias = r.entry.alias; }
        i = r.end;
      } else { /* table function: let the "(" be handled normally */ }
      continue;
    }

    if (top.isQuery && t.type === 'op' && t.text === ',') {
      if (q.clause === 'FROM' || q.clause === 'JOIN' || q.clause === 'ON' || q.clause === 'USING_COLS') {
        if (q.clause !== 'FROM') { setClause(q, 'FROM', i); q.joinCur = null; }
        q.expectTable = true; A.implicitJoins++; finding('implicit-join', i);
      }
      else if (q.clause === 'USING' || q.clause === 'UPDATE') q.expectTable = true;
      else if (q.clause === 'WITH') q.cteExpect = true;
      continue;
    }
    // CTE name
    if (top.isQuery && q.clause === 'WITH' && q.cteExpect && isNameTok(t)) {
      q.cteExpect = false; q.lastCte = clean(t); A.ctes.push({ name: clean(t), ...tokLoc(i) });
      continue;
    }

    // boolean operators (complexity)
    if (u === 'AND' || u === 'OR') { if (['WHERE', 'ON', 'HAVING'].includes(q.clause)) A.boolOps++; continue; }

    // comparisons with NULL
    if (t.type === 'op' && (t.text === '=' || t.text === '<>' || t.text === '!=') && NULL_CMP_CLAUSES.has(q.clause)) {
      if (up(i + 1) === 'NULL' || up(i - 1) === 'NULL') finding('null-comparison', i, { message: `Comparison "${t.text} NULL" never evaluates to true.` });
      continue;
    }
    if ((u === 'LIKE' || u === 'ILIKE') && likeWildcard(i)) { finding('leading-wildcard-like', i); continue; }

    // select-list star
    if (t.type === 'op' && t.text === '*' && top.isQuery && q.clause === 'SELECT') {
      const p = T[i - 1];
      if (p && (p.up === 'SELECT' || p.up === 'DISTINCT' || p.up === 'ALL' || p.text === ',' || p.up === 'TOP' || (p.type === 'number' && T[i - 2]?.up === 'TOP'))) {
        A.stars.push({ qualifier: null, ...tokLoc(i) });
        if (!top.existsCtx) finding('select-star', i);
      }
      continue;
    }

    // columns
    if (isNameTok(t) && COLUMN_CLAUSES.has(q.clause || '')) {
      if (t.type === 'word' && (isKw(t) || (T[i + 1]?.text === '(' && T[i + 1].type === 'op'))) continue;
      const p = T[i - 1];
      if (p && (p.text === '::' || p.up === 'AS' || p.up === 'INTERVAL')) continue;
      if (operandEnd(i)) continue; // implicit alias, window name, interval unit...
      if (T[i + 1]?.type === 'string') continue; // typed literal: DATE '2020-01-01'
      const parts = [clean(t)]; let j = i; let star = false;
      while (T[j + 1]?.text === '.' && T[j + 1].type === 'op' && (isNameTok(T[j + 2]) || T[j + 2]?.text === '*')) {
        if (T[j + 2].text === '*' && T[j + 2].type === 'op') { star = true; j += 2; break; }
        parts.push(clean(T[j + 2])); j += 2;
      }
      if (T[j + 1]?.text === '(' && T[j + 1].type === 'op' && !star) { i = j; continue; } // schema.fn(...)
      if (star) {
        A.stars.push({ qualifier: parts.join('.'), ...tokLoc(i) });
        if (q.clause === 'SELECT' && !top.existsCtx) finding('select-star', i, { message: `SELECT ${parts.join('.')}.* returns every column of that table.` });
      } else {
        A.columns.push({ name: parts[parts.length - 1], qualifier: parts.length > 1 ? parts.slice(0, -1).join('.') : null, clause: clauseOfCol(q), idx: i,
          ...tokLoc(i) });
      }
      i = j;
    }
  }
  // close any dangling scopes (unbalanced parentheses)
  while (stack.length > 0) { const s = stack.pop(); if (s.isQuery) closeClause(s, n); }

  // ---- post-processing per scope ----
  for (const s of A.scopes) {
    if (s.hasLimit && !s.hasOrder && s.mainType === 'SELECT' && !s.existsCtx) finding('limit-no-order', s.limitTok);
    if (s.distinct && s.hasGroup) { const c = s.clauses.find(c => c.name === 'SELECT'); finding('distinct-group-by', c ? c.start - 1 : 0); }
    // OR across different columns, per WHERE clause
    for (const c of s.clauses) if (c.name === 'WHERE') orCheck(c.start, c.end);
  }
  function colsIn(a, b, acc) {
    for (let k = a; k < b; k++) {
      const t = T[k];
      if (t.type === 'op' && t.text === '(' && T[k + 1]?.type === 'word' && (T[k + 1].up === 'SELECT' || T[k + 1].up === 'WITH')) { k = closeOf(k); continue; }
      if (!isNameTok(t) || (t.type === 'word' && (isKw(t) || T[k + 1]?.text === '('))) continue;
      if (T[k - 1]?.text === '.' || T[k - 1]?.text === '::' || T[k - 1]?.type === 'string') continue;
      if (T[k - 1] && (T[k - 1].type === 'ident' || T[k - 1].type === 'number')) continue;
      let name = clean(t), j = k;
      while (T[j + 1]?.text === '.' && isNameTok(T[j + 2])) { name += '.' + clean(T[j + 2]); j += 2; }
      acc.add(name.toLowerCase()); k = j;
    }
    return acc;
  }
  function orCheck(a, b) {
    let start = a;
    const groups = [];
    for (let k = a; k < b; k++) {
      const t = T[k];
      if (t.type === 'op' && t.text === '(') {
        if (!(T[k + 1]?.type === 'word' && (T[k + 1].up === 'SELECT' || T[k + 1].up === 'WITH')) && match[k] >= 0) orCheck(k + 1, match[k]);
        k = closeOf(k); continue;
      }
      if (t.type === 'word' && t.up === 'OR' && !(T[k - 1]?.text === '.')) { groups.push([start, k]); start = k + 1; }
    }
    if (!groups.length) return;
    groups.push([start, b]);
    const sets = groups.map(([x, y]) => colsIn(x, y, new Set()));
    const union = new Set(); sets.forEach(s => s.forEach(v => union.add(v)));
    const same = sets.every(s => s.size === sets[0].size && [...s].every(v => sets[0].has(v)));
    if (union.size > 1 && !same) finding('or-different-columns', groups[0][1], { message: `OR combines conditions on different columns (${[...union].slice(0, 4).join(', ')}${union.size > 4 ? ', ...' : ''}).` });
  }

  // joins: condition text and flags
  for (const j of A.joins) {
    if (j.condStart != null && j.condEnd != null && j.condEnd > j.condStart) j.condition = snippet(j.condStart, j.condEnd);
    else if (j.condStart != null && j.usingMark) j.condition = snippet(j.condStart, Math.min(n, j.condStart + 1 + (T[j.condStart]?.text === '(' ? closeOf(j.condStart) - j.condStart : 0)));
    j.using = !!j.usingMark; delete j.usingMark; delete j.condStart; delete j.condEnd; delete j.derived;
    const isCross = j.type === 'CROSS' || j.type.endsWith('APPLY');
    const natural = j.type.startsWith('NATURAL');
    const trivial = /^\s*(1\s*=\s*1|TRUE)\s*$/i.test(j.condition);
    if (isCross) j.flags.push(j.type === 'CROSS' ? 'cross-join' : 'apply');
    else if (!natural && (!j.condition || trivial)) { j.flags.push('cartesian'); A.cartJoins = (A.cartJoins || 0) + 1; }
    else if (!natural && !j.using && !/(^|[^<>!:])=(?!>)|<=>|==/.test(j.condition.replace(/<=|>=/g, ''))) j.flags.push('non-equality');
  }
  A.joins.forEach(j => {
    if (j.flags.includes('cartesian')) finding('join-no-condition', 0, { loc: { line: j.line, col: j.col, offset: j.offset, length: j.length }, message: `${j.type} JOIN ${j.table || '(subquery)'} has no ON/USING condition${j.condition ? ' (trivial condition ' + j.condition + ')' : ''}, which produces a cartesian product.` });
    if (j.flags.includes('non-equality')) finding('join-non-equality', 0, { loc: { line: j.line, col: j.col, offset: j.offset, length: j.length }, message: `JOIN ${j.table || '(subquery)'} ON ${j.condition} has no equality comparison.` });
  });
  return { A, root, T, snippet, closeOf };
}

function complexityOf(a) {
  const b = { joins: 2 * a.joins, subqueries: 2 * a.subqueries, ctes: a.ctes, unions: 2 * Math.max(0, a.unionParts - 1), windows: 2 * a.windows,
    groupBy: a.groupBy ? 1 : 0, having: a.having ? 1 : 0, distinct: a.distinct ? 1 : 0, conditions: 0.5 * a.boolOps };
  const score = Math.round(1 + Object.values(b).reduce((x, y) => x + y, 0));
  return { score, level: score <= 5 ? 'low' : score <= 12 ? 'medium' : 'high', breakdown: b, formula: COMPLEXITY_FORMULA };
}

function analyzeOne(T, index, env) {
  const { loc } = env;
  const first = T[0];
  const fu = first.type === 'word' ? first.text.toUpperCase() : '';
  let type = KNOWN_TYPES.has(fu) ? fu : 'UNKNOWN';
  const startsWith = type;
  const base = { index, type, startsWith, ...loc(first.pos, T[T.length - 1].pos + T[T.length - 1].text.length - first.pos) };

  let walkFrom = 0, walk = WALKED.has(type);
  let object = null;
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE'].includes(type)) {
    // object kind/name for DDL; analyse an embedded query (CREATE VIEW ... AS SELECT) if present
    const kinds = new Set(['TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'SEQUENCE']);
    let k = 1;
    while (k < T.length && !(T[k].type === 'word' && kinds.has(T[k].text.toUpperCase()))) k++;
    if (k < T.length) {
      object = { kind: T[k].text.toUpperCase(), name: null };
      let j = k + 1;
      while (['IF', 'NOT', 'EXISTS', 'ONLY', 'CONCURRENTLY'].includes(T[j]?.text?.toUpperCase())) j++;
      const parts = [];
      while (isNameTok(T[j])) { parts.push(clean(T[j])); j++; if (T[j]?.text === '.' && isNameTok(T[j + 1])) j++; else break; }
      object.name = parts.join('.') || null;
    }
    for (let d = 0, q = 1; q < T.length; q++) {
      if (T[q].text === '(') d++; else if (T[q].text === ')') d--;
      else if (d === 0 && T[q].type === 'word' && (T[q].up === 'SELECT' || T[q].up === 'WITH') && T[q - 1]?.up === 'AS') { walkFrom = q; walk = true; break; }
    }
  }
  const slice = T.slice(walkFrom);
  const r = walk ? walkStatement(slice, env) : null;
  const A = r?.A || { tables: [], columns: [], stars: [], joins: [], ctes: [], aggregates: new Map(), windows: [], params: [], findings: [], subCount: 0, maxDepth: 0, distinct: false, boolOps: 0, scopes: [], implicitJoins: 0 };
  const root = r?.root;
  if (walk && root?.mainType && (type === 'WITH' || type === 'VALUES' || type === 'TABLE')) type = root.mainType;
  if (walk && type === 'WITH' && !root?.mainType) type = 'SELECT';
  base.type = type;
  if (object) base.object = object;
  if (object?.kind === 'TABLE' && object.name) {
    const p = object.name.split('.');
    A.tables.unshift({ name: p[p.length - 1], schema: p.length > 1 ? p.slice(0, -1).join('.') : null, alias: null, kind: 'table', role: type.toLowerCase(), depth: 0, ...loc(first.pos, 0) });
  }

  // CTE flags, alias resolution
  const cteNames = new Set(A.ctes.map(c => c.name.toLowerCase()));
  for (const t of A.tables) if (t.kind === 'table' && !t.schema && cteNames.has(t.name.toLowerCase())) t.kind = 'cte';
  const realTables = A.tables.filter(t => t.kind === 'table');
  const byQual = new Map();
  for (const t of A.tables) { if (t.alias) byQual.set(t.alias.toLowerCase(), t); if (t.kind !== 'derived') byQual.set((t.schema ? t.schema + '.' : '') + t.name.toLowerCase(), t); byQual.set(t.name.toLowerCase(), byQual.get(t.name.toLowerCase()) || t); }
  const colMap = new Map();
  for (const c of A.columns) {
    const key = `${(c.qualifier || '').toLowerCase()}|${c.name.toLowerCase()}`;
    let e = colMap.get(key);
    if (!e) {
      const tab = c.qualifier ? byQual.get(c.qualifier.toLowerCase()) : null;
      let table = tab ? tab.name : null, inferred = false;
      if (!c.qualifier && A.tables.length === 1 && A.tables[0].kind !== 'derived') { table = A.tables[0].name; inferred = true; }
      e = { name: c.name, qualifier: c.qualifier, table, inferred, clauses: [], line: c.line, col: c.col, offset: c.offset, length: c.length, count: 0 };
      colMap.set(key, e);
    }
    e.count++;
    if (!e.clauses.includes(c.clause)) e.clauses.push(c.clause);
  }
  const columns = [...colMap.values()];

  const cl = root ? root.clauses : [];
  const clauseText = {};
  if (r) for (const c of cl) if (['SELECT', 'FROM', 'WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY', 'LIMIT', 'OFFSET', 'SET', 'VALUES', 'QUALIFY', 'RETURNING', 'INTO'].includes(c.name) && !(c.name in clauseText)) {
    const s = r.snippet(c.start, c.end).replace(/\s+/g, ' ').trim(); clauseText[c.name] = s.length > 240 ? s.slice(0, 237) + '...' : s;
  }

  // statement-level lints on the root scope
  if (root && type === 'UPDATE' && !root.hasWhere) A.findings.push(mk('update-no-where', LINT_RULES['update-no-where'], loc(first.pos, first.text.length)));
  if (root && type === 'DELETE' && !root.hasWhere) A.findings.push(mk('delete-no-where', LINT_RULES['delete-no-where'], loc(first.pos, first.text.length)));
  function mk(id, r2, l) { return { id, severity: r2[0], message: r2[1], suggestion: r2[2], heuristic: true, ...l }; }
  A.findings.sort((x, y) => x.offset - y.offset);
  for (const f of A.findings) f.statement = index;

  const agg = [...A.aggregates.values()];
  const stats = {
    joins: A.joins.length, subqueries: A.subCount, ctes: A.ctes.length, unionParts: 1 + (root?.setOps || 0), windows: A.windows.length,
    groupBy: !!root?.hasGroup, having: !!root?.hasHaving, distinct: A.distinct, boolOps: A.boolOps,
  };
  const params = A.params.map(i => ({ text: slice[i].text, kind: slice[i].text === '?' ? 'positional' : /^\$\d+$/.test(slice[i].text) ? 'numbered' : /^%/.test(slice[i].text) ? 'format' : slice[i].text[0] === ':' ? 'named' : 'variable', ...loc(slice[i].pos, slice[i].text.length) }));
  return {
    ...base,
    ctes: A.ctes, tables: A.tables, columns, stars: A.stars, joins: A.joins,
    clauses: { where: !!root?.hasWhere, groupBy: !!root?.hasGroup, having: !!root?.hasHaving, orderBy: !!root?.hasOrder, limit: !!root?.hasLimit, distinct: A.distinct, select: !!root?.hasSelect },
    clauseText, implicitJoins: A.implicitJoins,
    aggregates: agg, windowFunctions: A.windows, subqueries: { count: A.subCount, maxDepth: A.maxDepth },
    unionParts: stats.unionParts, parameters: params, complexity: complexityOf({ ...stats }),
    findings: A.findings, realTableCount: realTables.length,
  };
}

/**
 * Analyse SQL text. Never throws: returns {ok:false, error} for empty or unrecognisable input.
 * Options: dialect (see SQL_DIALECTS in the formatter), inListThreshold (default 50).
 */
export function analyzeSql(sql, { dialect = 'standard', inListThreshold = 50 } = {}) {
  try {
    if (typeof sql !== 'string' || !sql.trim()) return { ok: false, error: 'Enter some SQL to analyze.' };
    const toks = tokenize(sql, { dialect });
    const loc = makeLocator(sql);
    const warnings = [];
    for (const t of toks) if (t.unterminated) { const l = loc(t.pos); warnings.push(`Unterminated ${t.type === 'bcomment' ? 'block comment' : t.type === 'ident' ? 'quoted identifier' : 'string literal'} at line ${l.line}, column ${l.col}; the rest of the input was treated as part of it.`); }
    const sig = toks.filter(t => t.type !== 'lcomment' && t.type !== 'bcomment');
    const stmts = splitStatements(sig);
    if (!stmts.length) return { ok: false, error: 'No SQL statements found (only comments or whitespace).' };
    const env = { src: sql, loc, dialect, opts: { inListThreshold } };
    const statements = stmts.map((T, i) => analyzeOne(T, i, env));
    if (statements.every(s => s.type === 'UNKNOWN')) return { ok: false, error: 'Could not recognise a SQL statement. A statement should start with SELECT, INSERT, UPDATE, DELETE, WITH, CREATE, etc.' };
    const findings = statements.flatMap(s => s.findings);
    const uniq = (arr) => [...new Set(arr)];
    return {
      ok: true, dialect, note: HEURISTIC_NOTE, warnings, statements, findings,
      summary: {
        statements: statements.length,
        tables: uniq(statements.flatMap(s => s.tables.filter(t => t.kind === 'table').map(t => (t.schema ? t.schema + '.' : '') + t.name))),
        findings: findings.length, warnings: findings.filter(f => f.severity === 'warn').length,
        maxComplexity: Math.max(...statements.map(s => s.complexity.score)),
      },
    };
  } catch (e) {
    return { ok: false, error: `Could not analyze this input: ${e && e.message ? e.message : e}` };
  }
}

// ---------- explanation ----------
const usageOf = (a, ...names) => a.columns.filter(c => c.clauses.some(x => names.includes(x)));
const colLabel = c => (c.qualifier ? `${c.qualifier}.` : c.table && c.inferred ? `${c.table}.` : '') + c.name;
const tableLabel = t => (t.schema ? t.schema + '.' : '') + t.name + (t.alias ? ` (alias ${t.alias})` : '');
const JOIN_TEXT = { INNER: 'inner join (only matching rows)', LEFT: 'left join (all rows from the left side, matches from the right)', RIGHT: 'right join (all rows from the right side, matches from the left)',
  FULL: 'full join (all rows from both sides)', CROSS: 'cross join (every combination of rows)', 'CROSS APPLY': 'cross apply', 'OUTER APPLY': 'outer apply' };

/**
 * Plain-English explanation of each statement. Describes the LOGICAL processing order, which is NOT how the database
 * physically executes the query (the optimiser may reorder, use indexes, parallelise, ...).
 */
export function explainSql(sql, opts = {}) {
  const an = analyzeSql(sql, opts);
  if (!an.ok) return an;
  try {
    const statements = an.statements.map(s => {
      const ct = s.clauseText;
      const steps = []; let effect = null;
      const add = (clause, text) => steps.push({ n: steps.length + 1, clause, text });
      const real = s.tables.filter(t => t.kind !== 'derived');
      if (s.type === 'SELECT') {
        if (s.ctes.length) add('WITH', `Define ${s.ctes.length} named temporary result${s.ctes.length > 1 ? 's' : ''}: ${s.ctes.map(c => c.name).join(', ')}. Each one can be referenced like a table below.`);
        const from = s.tables.filter(t => t.role === 'from');
        if (from.length) add('FROM', `Start from ${from.map(tableLabel).join(' and ')}${from.length > 1 ? ' (listed with commas: every row combination, restricted by WHERE)' : ''}.`);
        else if (!ct.FROM) add('FROM', 'No FROM clause: the query evaluates its expressions once, without reading a table.');
        for (const j of s.joins) add('JOIN', `Combine with ${j.table ? tableLabel(j) : 'a subquery'} using a ${JOIN_TEXT[j.type] || j.type.toLowerCase() + ' join'}${j.condition ? `, matching rows where ${j.using ? 'USING ' : ''}${j.condition}` : j.flags.includes('cross-join') ? '' : ' with no condition'}.`);
        if (ct.WHERE) add('WHERE', `Keep only rows where ${ct.WHERE}.`);
        if (ct.GROUP_BY) add('GROUP BY', `Group the remaining rows by ${ct.GROUP_BY}${s.aggregates.length ? ` so aggregate functions (${s.aggregates.map(a => a.name).join(', ')}) are computed per group` : ''}.`);
        else if (s.aggregates.length && !s.windowFunctions.length) add('AGGREGATE', `Compute ${s.aggregates.map(a => a.name).join(', ')} over all remaining rows, producing a single result row.`);
        if (ct.HAVING) add('HAVING', `Keep only groups where ${ct.HAVING}.`);
        if (s.windowFunctions.length) add('WINDOW', `Evaluate window function${s.windowFunctions.length > 1 ? 's' : ''} ${[...new Set(s.windowFunctions.map(w => w.name))].join(', ')} over the rows (rows are kept, a value is added to each).`);
        if (ct.SELECT) add('SELECT', `Compute the output columns: ${ct.SELECT}.`);
        if (s.clauses.distinct) add('DISTINCT', 'Remove duplicate output rows.');
        if (s.unionParts > 1) add('UNION', `Combine ${s.unionParts} SELECT parts with set operators (UNION / INTERSECT / EXCEPT); each part above is processed the same way.`);
        if (ct.ORDER_BY) add('ORDER BY', `Sort the result by ${ct.ORDER_BY}.`);
        if (ct.OFFSET) add('OFFSET', `Skip the first ${ct.OFFSET.replace(/^OFFSET\s*/i, '')} rows.`);
        if (ct.LIMIT) add('LIMIT', `Return only the first ${ct.LIMIT.replace(/^LIMIT\s*/i, '')} rows.`);
        if (s.subqueries.count) add('SUBQUERIES', `The query contains ${s.subqueries.count} subquer${s.subqueries.count > 1 ? 'ies' : 'y'} (max nesting depth ${s.subqueries.maxDepth}); each is evaluated by the same logical order.`);
      } else if (s.type === 'INSERT' || s.type === 'REPLACE') {
        const t = real.find(x => x.role === 'insert');
        const cols = s.columns.filter(c => c.clauses.includes('INSERT')).map(c => c.name);
        effect = `Adds rows to ${t ? tableLabel(t) : 'a table'}${cols.length ? ` (columns ${cols.join(', ')})` : ''}${ct.VALUES ? ' from the listed VALUES' : s.clauses.select ? ' from the result of a SELECT' : ''}.${s.type === 'REPLACE' ? ' Existing rows with the same key are deleted first.' : ''}`;
        add(s.type, effect);
        if (s.clauses.select) add('SELECT', 'The SELECT part is evaluated first (logical order: FROM/JOIN, WHERE, GROUP BY, ..., SELECT) and its rows are inserted.');
      } else if (s.type === 'UPDATE') {
        const t = real.find(x => x.role === 'update');
        effect = `Changes rows of ${t ? tableLabel(t) : 'a table'} ${ct.WHERE ? `that match ${ct.WHERE}` : '(ALL rows: there is no WHERE clause)'}.`;
        add('UPDATE', `Target table ${t ? tableLabel(t) : '(unknown)'}.`);
        if (ct.WHERE) add('WHERE', `Select the rows where ${ct.WHERE}.`); else add('WHERE', 'No WHERE clause: every row is selected.');
        if (ct.SET) add('SET', `Assign new values: ${ct.SET.replace(/^SET\s*/i, '')}.`);
      } else if (s.type === 'DELETE') {
        const t = real[0];
        effect = `Removes rows from ${t ? tableLabel(t) : 'a table'} ${ct.WHERE ? `that match ${ct.WHERE}` : '(ALL rows: there is no WHERE clause)'}.`;
        add('DELETE', `Target table ${t ? tableLabel(t) : '(unknown)'}.`);
        if (ct.WHERE) add('WHERE', `Select the rows where ${ct.WHERE}.`); else add('WHERE', 'No WHERE clause: every row is selected.');
      } else if (s.type === 'MERGE') {
        effect = 'Compares a target and a source table and applies INSERT / UPDATE / DELETE actions depending on whether rows match.';
        add('MERGE', effect);
      } else if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE'].includes(s.type)) {
        effect = `${s.type} ${s.object ? s.object.kind + (s.object.name ? ' ' + s.object.name : '') : ''} (schema/definition change, not a query).`;
        add(s.type, effect);
      } else { effect = `${s.type} statement: no query structure to explain.`; add(s.type, effect); }

      const hintCols = (names, label) => usageOf(s, ...names).map(c => ({ column: colLabel(c), table: c.table, usage: label })).filter(Boolean);
      const hints = [];
      const seen = new Map();
      for (const [names, label] of [[['WHERE'], 'WHERE'], [['ON', 'USING COLS'], 'JOIN'], [['ORDER BY'], 'ORDER BY'], [['GROUP BY'], 'GROUP BY']]) {
        for (const h of hintCols(names, label)) {
          const e = seen.get(h.column) || { column: h.column, table: h.table, usage: [] };
          if (!e.usage.includes(h.usage)) e.usage.push(h.usage);
          seen.set(h.column, e);
        }
      }
      hints.push(...seen.values());
      return {
        index: s.index, type: s.type, line: s.line, steps, effect,
        orderNote: s.type === 'SELECT' ? 'This is the LOGICAL order in which SQL defines evaluation (FROM/JOIN, WHERE, GROUP BY, HAVING, SELECT, DISTINCT, ORDER BY, LIMIT). The database is free to execute the query in a different physical order.' : null,
        indexHints: { heuristic: true, note: 'Heuristic: these columns appear in WHERE / JOIN / ORDER BY / GROUP BY. They are candidates to consider indexing; whether an index helps depends on your data, existing indexes and the optimiser. Verify with EXPLAIN.', columns: hints },
      };
    });
    return { ok: true, note: HEURISTIC_NOTE, statements, analysis: an };
  } catch (e) {
    return { ok: false, error: `Could not explain this input: ${e && e.message ? e.message : e}` };
  }
}
