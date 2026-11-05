// Execution-plan helpers (pure, no DOM). This tool NEVER runs a query: it generates EXPLAIN statements for you to run on
// your own database and parses the plan text you paste back. All red flags are heuristics.

export const PLAN_NOTE = 'Heuristic reading of a pasted plan. Row estimates, thresholds and "large" are rules of thumb; confirm on your own data and database version.';

// ---------- how to obtain a real plan ----------
const stripSemi = s => String(s).trim().replace(/;+\s*$/, '');
export const EXPLAINABLE = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'REPLACE', 'VALUES', 'TABLE']);

/**
 * Per-dialect ways to get a REAL plan, with a ready-to-run statement for `sql` (one statement).
 * Returns {dialect, label, intro, options:[{id, title, sql, warning?, note}]}.
 */
export function planCommands(sql, dialect = 'standard') {
  const q = stripSemi(sql);
  const d = {
    postgresql: { label: 'PostgreSQL', options: [
      { id: 'explain', title: 'Estimated plan (does not run the query)', sql: `EXPLAIN\n${q};`, note: 'Shows the planner\'s chosen plan and its estimates.' },
      { id: 'analyze', title: 'Actual plan with timing and buffers', sql: `EXPLAIN (ANALYZE, BUFFERS)\n${q};`, warning: 'EXPLAIN ANALYZE EXECUTES the statement. For INSERT/UPDATE/DELETE wrap it: BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;', note: 'Compare estimated rows with actual rows; BUFFERS shows cache hits and reads.' },
      { id: 'json', title: 'Actual plan as JSON (paste it back here)', sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n${q};`, warning: 'Executes the statement, like ANALYZE.', note: 'JSON is easiest for tools and visualisers to read.' },
    ] },
    mysql: { label: 'MySQL / MariaDB', options: [
      { id: 'explain', title: 'Estimated plan (table format)', sql: `EXPLAIN\n${q};`, note: 'Look at type, key, rows and Extra.' },
      { id: 'json', title: 'Detailed plan as JSON', sql: `EXPLAIN FORMAT=JSON\n${q};`, note: 'Includes cost estimates (MySQL 5.7+; MariaDB uses EXPLAIN FORMAT=JSON too).' },
      { id: 'analyze', title: 'Actual execution (MySQL 8.0.18+)', sql: `EXPLAIN ANALYZE\n${q};`, warning: 'EXPLAIN ANALYZE executes the statement (MariaDB: use ANALYZE ' + 'instead).', note: 'Shows actual rows and time per iterator.' },
    ] },
    sqlserver: { label: 'SQL Server', options: [
      { id: 'showplan-text', title: 'Estimated plan as text', sql: `SET SHOWPLAN_TEXT ON;\nGO\n${q};\nGO\nSET SHOWPLAN_TEXT OFF;\nGO`, note: 'The query is not executed while SHOWPLAN is on.' },
      { id: 'showplan-xml', title: 'Estimated plan as XML (open as a graphical plan in SSMS)', sql: `SET SHOWPLAN_XML ON;\nGO\n${q};\nGO\nSET SHOWPLAN_XML OFF;\nGO`, note: 'Or press Ctrl+L in SSMS for the estimated plan, Ctrl+M to include the actual plan.' },
      { id: 'stats', title: 'Actual I/O and time statistics', sql: `SET STATISTICS IO, TIME ON;\n${q};\nSET STATISTICS IO, TIME OFF;`, warning: 'This runs the query.', note: 'Logical reads are usually the best measure of work.' },
    ] },
    oracle: { label: 'Oracle', options: [
      { id: 'explain-plan', title: 'Estimated plan', sql: `EXPLAIN PLAN FOR\n${q};\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);`, note: 'Writes to PLAN_TABLE; does not execute the statement.' },
      { id: 'actual', title: 'Actual plan of the last run', sql: `ALTER SESSION SET STATISTICS_LEVEL = ALL;\n${q};\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));`, warning: 'Runs the statement.', note: 'Compare E-Rows with A-Rows.' },
    ] },
    sqlite: { label: 'SQLite', options: [
      { id: 'eqp', title: 'Query plan', sql: `EXPLAIN QUERY PLAN\n${q};`, note: 'Look for SCAN (full table scan) versus SEARCH ... USING INDEX.' },
    ] },
    bigquery: { label: 'BigQuery', options: [
      { id: 'dry', title: 'Dry run (bytes processed, no execution)', sql: `-- Console: the query validator shows estimated bytes.\n-- CLI:\nbq query --use_legacy_sql=false --dry_run '<your query>'`, note: 'BigQuery has no EXPLAIN statement; open "Execution details" on a finished job in the console for stages and slot time.' },
    ] },
    standard: { label: 'Standard SQL', options: [
      { id: 'explain', title: 'EXPLAIN (syntax varies by database)', sql: `EXPLAIN\n${q};`, note: 'Choose a dialect above for ANALYZE, JSON and SHOWPLAN variants.' },
    ] },
  };
  const e = d[dialect] || d.standard;
  return { dialect: d[dialect] ? dialect : 'standard', label: e.label, intro: 'This tool does not run queries and cannot produce a real plan. Run one of these on your own database, then paste the result below.', options: e.options };
}

// ---------- parsers ----------
const num = s => (s == null || s === '' ? null : Number(s));

function node(init) {
  return { op: '', relation: null, alias: null, index: null, startupCost: null, cost: null, rows: null, width: null, actualRows: null, actualTime: null, loops: null, neverExecuted: false, details: [], children: [], filter: null, rowsRemoved: null, sortMethod: null, sortSpace: null, sortSpaceType: null, batches: null, ...init };
}

/** Parse PostgreSQL text-format EXPLAIN. Returns {ok, format:'pg-text', root, planning, execution, nodes} or {ok:false, error}. */
export function parsePgText(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const re = /^(\s*)(->\s*)?(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=(\d+)\)(?:\s+\(actual(?: time=([\d.]+)\.\.([\d.]+))? rows=([\d.]+) loops=(\d+)\)|\s+\(never executed\))?/;
  const roots = []; const stack = []; const all = [];
  let planning = null, execution = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let m = /^\s*Planning Time:\s*([\d.]+)\s*ms/.exec(raw); if (m) { planning = num(m[1]); continue; }
    m = /^\s*Execution Time:\s*([\d.]+)\s*ms/.exec(raw); if (m) { execution = num(m[1]); continue; }
    m = re.exec(raw);
    if (m) {
      const indent = m[1].length + (m[2] ? m[2].length : 0);
      let desc = m[3].trim();
      const n = node({ startupCost: num(m[4]), cost: num(m[5]), rows: num(m[6]), width: num(m[7]), actualTime: m[9] != null ? num(m[9]) : null, actualRows: m[10] != null ? num(m[10]) : null, loops: m[11] != null ? num(m[11]) : null, neverExecuted: /never executed/.test(raw), _indent: indent });
      const using = /^(.*?)\s+using\s+(\S+)(.*)$/.exec(desc);
      if (using) { n.index = using[2]; desc = `${using[1]}${using[3]}`; }
      const on = /^(.*?)\s+on\s+(\S+)(?:\s+(\S+))?$/.exec(desc);
      if (on) { n.relation = on[2]; n.alias = on[3] || null; desc = on[1]; }
      n.op = desc.replace(/^->\s*/, '').trim();
      while (stack.length && stack[stack.length - 1]._indent >= indent) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(n); else roots.push(n);
      stack.push(n); all.push(n);
      continue;
    }
    const last = stack[stack.length - 1];
    const dl = raw.trim();
    if (last && /:/.test(dl) && !/^->/.test(dl)) {
      last.details.push(dl);
      let d;
      if ((d = /^Sort Method:\s*(.+?)(?:\s+(Memory|Disk):\s*(\S+))?$/.exec(dl))) { last.sortMethod = d[1].trim(); last.sortSpaceType = d[2] || (/external/i.test(d[1]) ? 'Disk' : null); last.sortSpace = d[3] || null; if (/Disk/.test(dl)) last.sortSpaceType = 'Disk'; }
      if ((d = /^Rows Removed by (?:Join )?Filter:\s*(\d+)/.exec(dl))) last.rowsRemoved = num(d[1]);
      if ((d = /^(?:Filter|Index Cond|Join Filter|Hash Cond|Recheck Cond):\s*(.*)$/.exec(dl)) && !last.filter) last.filter = d[1];
      if ((d = /Batches:\s*(\d+)/.exec(dl))) last.batches = num(d[1]);
    }
  }
  if (!roots.length) return { ok: false, error: 'No plan nodes found. Expected lines like "Seq Scan on users  (cost=0.00..155.00 rows=10000 width=36)".' };
  return { ok: true, format: 'pg-text', root: roots[0], roots, nodes: all, planning, execution };
}

function fromPgJsonNode(p) {
  const n = node({ op: p['Node Type'] || '?', relation: p['Relation Name'] ?? null, alias: p.Alias ?? null, index: p['Index Name'] ?? null, startupCost: p['Startup Cost'] ?? null, cost: p['Total Cost'] ?? null, rows: p['Plan Rows'] ?? null,
    width: p['Plan Width'] ?? null, actualRows: p['Actual Rows'] ?? null, actualTime: p['Actual Total Time'] ?? null, loops: p['Actual Loops'] ?? null, filter: p.Filter ?? p['Index Cond'] ?? p['Hash Cond'] ?? null,
    rowsRemoved: p['Rows Removed by Filter'] ?? null, sortMethod: p['Sort Method'] ?? null, sortSpace: p['Sort Space Used'] != null ? `${p['Sort Space Used']}kB` : null, sortSpaceType: p['Sort Space Type'] ?? null, batches: p['Hash Batches'] ?? null });
  if (p['Join Type']) n.details.push(`Join Type: ${p['Join Type']}`);
  n.parentRel = p['Parent Relationship'] ?? null;
  n.children = (p.Plans || []).map(fromPgJsonNode);
  return n;
}
const flatten = n => [n, ...n.children.flatMap(flatten)];

/** Parse PostgreSQL EXPLAIN (FORMAT JSON) output. */
export function parsePgJson(text) {
  let data;
  try { data = JSON.parse(String(text).trim()); } catch (e) { return { ok: false, error: `Not valid JSON: ${e.message}` }; }
  const first = Array.isArray(data) ? data[0] : data;
  const plan = first && (first.Plan || first['QUERY PLAN']?.[0]?.Plan);
  if (!plan || typeof plan !== 'object') {
    if (data && data.query_block) return { ok: false, error: 'This is MySQL EXPLAIN FORMAT=JSON, which this helper does not read yet. Paste the tabular EXPLAIN output instead.' };
    return { ok: false, error: 'JSON has no "Plan" object. Paste the output of EXPLAIN (FORMAT JSON).' };
  }
  const root = fromPgJsonNode(plan);
  return { ok: true, format: 'pg-json', root, roots: [root], nodes: flatten(root), planning: first['Planning Time'] ?? null, execution: first['Execution Time'] ?? null };
}

const MYSQL_COLS = ['id', 'select_type', 'table', 'partitions', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'];
const mysqlRow = obj => {
  const nn = v => (v === 'NULL' || v === undefined ? null : v);
  return { id: nn(obj.id), selectType: nn(obj.select_type), table: nn(obj.table), partitions: nn(obj.partitions), type: nn(obj.type), possibleKeys: nn(obj.possible_keys), key: nn(obj.key), keyLen: nn(obj.key_len), ref: nn(obj.ref),
    rows: obj.rows != null && /^\d+$/.test(String(obj.rows)) ? Number(obj.rows) : null, filtered: obj.filtered != null && !Number.isNaN(Number(obj.filtered)) ? Number(obj.filtered) : null, extra: nn(obj.Extra ?? obj.extra) || '' };
};

/** Parse MySQL EXPLAIN output: pipe table, tab/space separated table, or vertical (\G) format. */
export function parseMysqlExplain(text) {
  const src = String(text ?? '').replace(/\r/g, '');
  const lines = src.split('\n').filter(l => l.trim());
  if (!lines.length) return { ok: false, error: 'Nothing to parse.' };
  const rows = [];
  if (/^\*+\s*\d+\.\s*row\s*\*+/m.test(src)) {
    let cur = null;
    for (const l of lines) {
      if (/^\*+\s*\d+\.\s*row/.test(l)) { cur = {}; rows.push(cur); continue; }
      const m = /^\s*([A-Za-z_]+):\s?(.*)$/.exec(l);
      if (m && cur) cur[m[1]] = m[2].trim();
    }
  } else if (lines.some(l => l.trim().startsWith('|'))) {
    const data = lines.filter(l => l.trim().startsWith('|')).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    const head = data[0].map(c => c.toLowerCase() === 'extra' ? 'Extra' : c.toLowerCase());
    if (!head.includes('select_type') || !head.includes('type')) return { ok: false, error: 'Header row is missing (expected id | select_type | table | ... | type | ... | Extra).' };
    for (const r of data.slice(1)) { const o = {}; head.forEach((h, i) => { o[h] = r[i] ?? ''; }); rows.push(o); }
  } else {
    const splitter = l => (l.includes('\t') ? l.split('\t') : l.trim().split(/\s{2,}/));
    const head = splitter(lines[0]).map(c => c.trim()).map(c => c.toLowerCase() === 'extra' ? 'Extra' : c.toLowerCase());
    if (!head.includes('select_type') || !head.includes('type')) return { ok: false, error: 'Could not find the EXPLAIN header (id, select_type, table, ..., type, ..., Extra). Paste the whole output including the header row.' };
    for (const l of lines.slice(1)) { const c = splitter(l); const o = {}; head.forEach((h, i) => { o[h] = (c[i] ?? '').trim(); }); rows.push(o); }
  }
  if (!rows.length) return { ok: false, error: 'No rows found under the header.' };
  return { ok: true, format: 'mysql-table', rows: rows.map(mysqlRow), columns: MYSQL_COLS };
}

/** Detect the pasted plan format. */
export function detectPlanFormat(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^[[{]/.test(s)) return 'pg-json';
  if (/\(cost=\d/.test(s)) return 'pg-text';
  if (/select_type/i.test(s) || /^\*+\s*\d+\.\s*row/m.test(s)) return 'mysql-table';
  return null;
}

/** Parse any supported plan text. */
export function parsePlan(text) {
  const f = detectPlanFormat(text);
  if (!String(text ?? '').trim()) return { ok: false, error: 'Paste an EXPLAIN result.' };
  if (f === 'pg-json') return parsePgJson(text);
  if (f === 'pg-text') return parsePgText(text);
  if (f === 'mysql-table') return parseMysqlExplain(text);
  return { ok: false, error: 'Unrecognised plan. Supported: PostgreSQL EXPLAIN text or JSON, MySQL EXPLAIN table.' };
}

// ---------- red flags ----------
export const PLAN_THRESHOLDS = { seqScanRows: 10000, loops: 1000, divergence: 10, filterRemoved: 10000, mysqlRows: 10000 };

const flag = (severity, id, title, detail, where) => ({ severity, id, title, detail, where: where || null, heuristic: true });

/** Analyse a parsed plan and return [{severity, id, title, detail, where}] (all heuristic). */
export function analyzePlan(plan, th = PLAN_THRESHOLDS) {
  if (!plan || !plan.ok) return [];
  const out = [];
  if (plan.format === 'mysql-table') {
    plan.rows.forEach((r, i) => {
      const where = `row ${i + 1} (${r.table || 'derived'})`;
      if (r.type && r.type.toUpperCase() === 'ALL') out.push(flag(r.rows != null && r.rows >= th.mysqlRows ? 'warn' : 'info', 'full-table-scan', `type=ALL: full table scan on ${r.table || 'a table'}${r.rows != null ? ` (~${r.rows} rows examined)` : ''}`, 'Every row is read. Fine for tiny tables; on large ones consider an index on the filter/join columns.', where));
      if (r.type && r.type.toLowerCase() === 'index') out.push(flag('info', 'full-index-scan', `type=index: full index scan on ${r.table || 'a table'}`, 'The whole index is read. It is cheaper than a table scan but still linear in the table size.', where));
      if (/using filesort/i.test(r.extra)) out.push(flag('warn', 'filesort', 'Using filesort', 'MySQL sorts rows itself instead of reading them in index order. An index matching ORDER BY (after equality columns) can avoid it.', where));
      if (/using temporary/i.test(r.extra)) out.push(flag('warn', 'temporary', 'Using temporary', 'An internal temporary table is built (often for GROUP BY / DISTINCT / UNION); it can spill to disk.', where));
      if (/using join buffer/i.test(r.extra)) out.push(flag('warn', 'join-buffer', 'Using join buffer', 'The join column of this table has no usable index, so MySQL buffers rows and compares in blocks.', where));
      if (!r.key && r.possibleKeys) out.push(flag('info', 'key-not-used', `possible_keys lists ${r.possibleKeys} but key is NULL`, 'The optimizer decided not to use an index, often because the query reads a large share of the table or a predicate is not sargable.', where));
      if (r.rows != null && r.rows >= 1000000) out.push(flag('info', 'many-rows', `~${r.rows} rows estimated for ${r.table || 'a table'}`, 'The row estimate is large; check that selective predicates are indexed.', where));
      if (r.filtered != null && r.filtered <= 10 && r.rows != null && r.rows >= 1000) out.push(flag('info', 'low-filtered', `filtered=${r.filtered}% of ~${r.rows} rows`, 'Most examined rows are discarded afterwards; an index on the discarding predicate would read fewer rows.', where));
    });
    return out;
  }
  const nodes = plan.nodes;
  for (const n of nodes) {
    const name = `${n.op}${n.relation ? ' on ' + n.relation : ''}`;
    const rowsSeen = Math.max(n.rows || 0, n.actualRows != null && n.loops ? n.actualRows * n.loops : 0);
    if (/^(Parallel )?Seq Scan/.test(n.op) && rowsSeen >= th.seqScanRows) out.push(flag('warn', 'seq-scan-large', `Seq Scan on ${n.relation || 'a table'} (${rowsSeen} rows)`, 'The whole table is read. If a selective filter or join key exists, an index may help; for large fractions of the table a scan is often the right choice.', name));
    if (n.sortMethod && (/external/i.test(n.sortMethod) || n.sortSpaceType === 'Disk')) out.push(flag('warn', 'sort-spill', `Sort spilled to disk (${n.sortMethod}${n.sortSpace ? ', ' + n.sortSpace : ''})`, 'The sort did not fit in work_mem. Raise work_mem for this query, reduce rows before sorting, or use an index that provides the order.', name));
    if (n.batches != null && n.batches > 1) out.push(flag('info', 'hash-batches', `Hash used ${n.batches} batches`, 'A hash table larger than work_mem is processed in several passes using temporary files.', name));
    if (n.loops != null && n.loops >= th.loops && !n.neverExecuted) out.push(flag('warn', 'high-loops', `${n.op} executed ${n.loops} times (loops=${n.loops})`, 'Typically the inner side of a Nested Loop. If each iteration is slow this multiplies; check the inner side has an index on the join key or that the join method is appropriate.', name));
    if (n.rows != null && n.actualRows != null && !n.neverExecuted) {
      const est = Math.max(n.rows, 1), act = Math.max(n.actualRows, 1);
      const ratio = Math.max(est / act, act / est);
      if (ratio >= th.divergence && Math.max(est, act) >= 10) out.push(flag('warn', 'estimate-divergence', `Estimated ${n.rows} rows but got ${n.actualRows} per loop (${ratio >= 1000 ? '>1000' : ratio.toFixed(0)}x off)`, 'Bad estimates lead to bad join and scan choices. Run ANALYZE on the table, check for correlated columns or consider extended statistics.', name));
    }
    if (n.rowsRemoved != null && n.rowsRemoved >= th.filterRemoved && n.actualRows != null && n.rowsRemoved >= 10 * Math.max(n.actualRows, 1)) out.push(flag('warn', 'filter-discards', `Filter removed ${n.rowsRemoved} rows to return ${n.actualRows}`, 'Most rows read are thrown away. An index on the filter column would let the database skip them.', name));
  }
  return out;
}

/** Short plain-English summary lines for a parsed plan. */
export function summarizePlan(plan) {
  if (!plan || !plan.ok) return [];
  if (plan.format === 'mysql-table') return [`${plan.rows.length} step(s): ${plan.rows.map(r => `${r.table || '-'} [${r.type || '?'}]`).join(', ')}`];
  const s = [`${plan.nodes.length} plan node(s); top node: ${plan.root.op}${plan.root.cost != null ? ` (total cost ${plan.root.cost})` : ''}`];
  if (plan.planning != null) s.push(`Planning time ${plan.planning} ms`);
  if (plan.execution != null) s.push(`Execution time ${plan.execution} ms`);
  return s;
}

// ---------- glossary ----------
export const GLOSSARY = [
  { id: 'joins', title: 'JOIN types', body: 'INNER JOIN keeps rows that match on both sides. LEFT JOIN keeps every left row and fills right columns with NULL when nothing matches. RIGHT JOIN is the mirror image. FULL JOIN keeps unmatched rows from both sides. CROSS JOIN pairs every row with every row (rows = left x right).',
    diagram: [['A', 'B', 'INNER', 'only the overlap'], ['A', 'B', 'LEFT', 'all of A + overlap'], ['A', 'B', 'RIGHT', 'overlap + all of B'], ['A', 'B', 'FULL', 'everything from both']] },
  { id: 'index', title: 'What is an index?', body: 'A sorted copy of one or more columns with pointers to the rows, like a book index. It makes lookups, joins and sorts on those columns fast, but costs disk space and slows INSERT/UPDATE/DELETE. A composite index (a, b) helps filters on a, or on a and b, but generally not on b alone.' },
  { id: 'sargability', title: 'Sargability', body: 'A predicate is sargable (Search ARGument ABLE) when the database can use an index to seek straight to matching rows. Wrapping the column in a function or arithmetic (YEAR(created) = 2024, price * 2 > 10) or a leading wildcard (LIKE \'%abc\') usually makes it non-sargable, forcing a scan. Move the work to the other side: created >= \'2024-01-01\' AND created < \'2025-01-01\'.' },
  { id: 'cardinality', title: 'Cardinality and selectivity', body: 'Cardinality is the number of distinct values in a column. Selectivity is how few rows a predicate keeps (status = \'active\' matching 95% of rows is not selective; email = ... matching one row is). Indexes pay off on selective predicates; the optimizer uses statistics to estimate this.' },
  { id: 'covering', title: 'Covering indexes', body: 'If an index contains every column the query reads, the database can answer from the index alone without visiting the table ("index-only scan"). PostgreSQL and SQL Server support INCLUDE (cols) for extra payload columns; MySQL and others achieve it by appending columns to the key.' },
  { id: 'order', title: 'Composite index column order', body: 'Common heuristic: equality columns first, then the range column, then ORDER BY columns. Equality-first keeps matching rows adjacent. Some engines (and the Equality-Sort-Range rule) prefer putting ORDER BY before the range column when the sort matters more; verify with EXPLAIN.' },
  { id: 'plan', title: 'Reading a plan', body: 'Read from the innermost (most indented) node outwards. Compare estimated rows with actual rows, watch for full scans on big tables, sorts that spill to disk and operations repeated thousands of times.' },
];
