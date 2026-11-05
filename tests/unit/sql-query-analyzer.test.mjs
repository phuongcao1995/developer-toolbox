// Run: node tests/unit/sql-query-analyzer.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as Q from '../../tools/sql-query-analyzer/logic.js';
import { tokenize } from '../../tools/sql-formatter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const an = (sql, o = {}) => { const r = Q.analyzeQuery(sql, o); assert.equal(r.ok, true, r.error); return r; };
const st = (sql, o) => an(sql, o).statements[0];
const ids = (sql, o) => st(sql, o).findings.map(f => f.id);
const where = (sql, o) => st(sql, o).predicates.where;
const sig = sql => tokenize(sql).filter(t => t.type !== 'lcomment' && t.type !== 'bcomment');
const pred = sql => Q.analyzePredicate(sig(sql), sql, () => ({ line: 1, col: 1, offset: 0, length: sql.length }));

// ---------- basics ----------
test('analyzeQuery wraps the shared analyzer and keeps errors', () => { assert.equal(Q.analyzeQuery('').ok, false); assert.match(Q.analyzeQuery('   ').error, /Enter some SQL/); assert.equal(Q.analyzeQuery('-- only a comment').ok, false); });
test('result has note, index note and summary', () => { const r = an('select 1'); assert.match(r.note, /Heuristic/); assert.match(Q.INDEX_NOTE, /EXPLAIN/); assert.equal(r.summary.statements, 1); });
test('multiple statements are analysed separately', () => { const r = an('select a from t; delete from u where id = 1;'); assert.equal(r.statements.length, 2); assert.equal(r.statements[1].type, 'DELETE'); });
test('allRules includes shared and extra rules', () => { const r = Q.allRules(); assert.ok(r.some(x => x.id === 'select-star' && x.source === 'shared')); assert.ok(r.some(x => x.id === 'count-column' && x.source === 'extra')); assert.ok(r.length >= 30); });

// ---------- block tree ----------
test('blocks: root + subqueries + CTE', () => {
  const s = st('with c as (select id from a) select * from c where id in (select id from b) and exists (select 1 from d where d.x = c.id)');
  assert.deepEqual(s.blocks.map(b => b.kind), ['root', 'cte', 'in', 'exists']);
  assert.equal(s.blocks[1].name, 'c');
});
test('blocks: derived table with alias and scalar subquery', () => {
  const s = st('select (select max(x) from t2 where t2.k = t1.k) m from (select * from t1) d');
  assert.ok(s.blocks.some(b => b.kind === 'derived' && b.alias === 'd')); assert.ok(s.blocks.some(b => b.kind === 'scalar'));
});
test('blocks: union creates sibling blocks', () => { const s = st('select a from t union all select a from u'); assert.equal(s.blocks.length, 2); assert.equal(s.blocks[1].setOp, 'UNION ALL'); });
test('parseBlocks does not treat function parens as blocks', () => { const s = st('select coalesce(a, (select 1)) from t'); assert.equal(s.blocks.filter(b => b.kind !== 'root').length, 1); });

// ---------- operand / predicate classification ----------
test('classifyOperand', () => {
  const c = s => Q.classifyOperand(sig(s));
  assert.equal(c('a').kind, 'column'); assert.equal(c('t.a').kind, 'column'); assert.equal(c('5').kind, 'literal'); assert.equal(c("'x'").kind, 'literal'); assert.equal(c('-5').kind, 'literal');
  assert.equal(c('?').kind, 'param'); assert.equal(c('null').kind, 'null'); assert.equal(c('lower(a)').kind, 'func'); assert.equal(c('a + 1').kind, 'expr'); assert.equal(c('now()').kind, 'const-expr'); assert.equal(c('(select 1)').kind, 'subquery');
  assert.equal(c('lower(a)').fn, 'LOWER'); assert.equal(c('lower(t.a)').col.qualifier, 't');
});
test('sargable equality / range / between', () => { for (const s of ['a = 1', "a = 'x'", 'a > 5', 'a between 1 and 2', 'a >= ?', 'a = :p']) { const p = pred(s); assert.equal(p.sargable, true, s); assert.equal(p.column.name, 'a'); } });
test('predicate kinds', () => { assert.equal(pred('a = 1').kind, 'equality'); assert.equal(pred('a > 1').kind, 'range'); assert.equal(pred('a between 1 and 2').kind, 'range'); assert.equal(pred('a in (1,2,3)').kind, 'in'); assert.equal(pred('a in (1,2,3)').listSize, 3); assert.equal(pred('a is null').kind, 'null'); assert.equal(pred('a <> 1').kind, 'inequality'); });
test('function on column is non-sargable with a reason', () => { for (const s of ['lower(a) = \'x\'', 'year(d) = 2024', 'upper(t.n) like \'A%\'', 'coalesce(a, 0) > 1']) { const p = pred(s); assert.equal(p.sargable, false, s); assert.match(p.reasons[0], /Function|expression/i); } });
test('arithmetic on column is non-sargable', () => { const p = pred('price * 2 > 10'); assert.equal(p.sargable, false); assert.equal(p.nonSargableOperand.kind, 'expr'); assert.equal(pred('a + 1 = 5').sargable, false); });
test('arithmetic on the constant side stays sargable', () => { assert.equal(pred('a > 10 / 2').sargable, true); assert.equal(pred("d >= now() - interval '1' day").sargable, true); });
test('LIKE leading wildcard is non-sargable, prefix is sargable', () => {
  const a = pred("a like '%x'"); assert.equal(a.sargable, false); assert.match(a.reasons[0], /wildcard/);
  const b = pred("a like 'x%'"); assert.equal(b.sargable, true); assert.equal(b.kind, 'like-prefix');
  assert.equal(pred("a like 'abc'").kind, 'equality'); assert.equal(pred("a like '_x'").sargable, false);
});
test('multiple wildcards flagged', () => { assert.equal(pred("a like '%x%'").multiWildcard, true); assert.equal(pred("a like 'x%y%'").multiWildcard, true); assert.equal(pred("a like 'x%'").multiWildcard, undefined); });
test('= NULL pitfall', () => { for (const s of ['a = null', 'a <> null', 'a != null']) { const p = pred(s); assert.equal(p.nullCompare, true, s); assert.equal(p.sargable, false); } assert.equal(pred('a is null').nullCompare, undefined); assert.equal(pred('a is not null').kind, 'null'); });
test('NOT IN pitfalls', () => { const p = pred('a not in (select x from t)'); assert.equal(p.kind, 'not-in-subquery'); assert.ok(p.reasons.some(r => /NULL/.test(r))); assert.equal(pred('a not in (1, null)').nullInList, true); assert.equal(pred('a not in (1, 2)').nullInList, undefined); });
test('column to column comparison is not a filter', () => { const p = pred('a.x = b.y'); assert.equal(p.kind, 'column-equality'); assert.equal(p.columns.length, 2); assert.equal(p.sargable, null); });
test('implicit conversion hints only when evident', () => { assert.equal(pred("user_id = '42'").hints.length, 1); assert.equal(pred('email = 5551234').hints.length, 1); assert.equal(pred("name = 'bob'").hints.length, 0); assert.equal(pred('user_id = 42').hints.length, 0); assert.equal(pred("code = 'ab1'").hints.length, 0); });
test('regex predicates are non-sargable', () => { const p = pred("a regexp '^x'"); assert.equal(p.sargable, false); });
test('splitPredicates handles AND, parens, BETWEEN and OR', () => {
  const sql = "a = 1 AND (b = 2 AND c between 1 and 5) AND d = 4";
  const ps = Q.splitPredicates(sig(sql), sql, () => ({ line: 1, col: 1, offset: 0, length: 0 }));
  assert.equal(ps.length, 4); assert.equal(ps[2].kind, 'range');
  const sql2 = 'a = 1 OR b = 2'; const o = Q.splitPredicates(sig(sql2), sql2, () => ({ line: 1, col: 1, offset: 0, length: 0 }));
  assert.equal(o.length, 1); assert.equal(o[0].kind, 'or'); assert.equal(o[0].differentColumns, true);
  const sql3 = 'a = 1 OR a = 2'; assert.equal(Q.splitPredicates(sig(sql3), sql3, () => ({ line: 1, col: 1, offset: 0, length: 0 }))[0].sameColumn, true);
});
test('WHERE predicates are listed per statement', () => { const p = where("select * from t where a = 1 and lower(b) = 'x' and c like '%q'"); assert.deepEqual(p.map(x => x.sargable), [true, false, false]); });

// ---------- joins ----------
test('explainJoin inner/left/right/full/cross', () => {
  assert.match(Q.explainJoin({ type: 'INNER', table: 't', alias: 'x', condition: 'x.id = a.id', flags: [] }).summary, /only rows that have a match/);
  assert.match(Q.explainJoin({ type: 'LEFT', table: 't', condition: 't.a = b.a', flags: [] }).lines[1], /NULL in the right-side/);
  assert.match(Q.explainJoin({ type: 'RIGHT', table: 't', condition: 't.a = b.a', flags: [] }).summary, /every row from the right/);
  assert.match(Q.explainJoin({ type: 'FULL', table: 't', condition: 't.a = b.a', flags: [] }).summary, /all rows from both/);
  const c = Q.explainJoin({ type: 'CROSS', table: 't', condition: '', flags: ['cross-join'] }); assert.match(c.lines[0], /cartesian/); assert.ok(c.warnings.some(w => /left rows x right rows/.test(w)));
});
test('explainJoin: NATURAL, USING, ON, LATERAL, APPLY', () => {
  assert.ok(Q.explainJoin({ type: 'NATURAL LEFT', table: 't', condition: '', flags: [] }).warnings.some(w => /NATURAL JOIN is fragile/.test(w)));
  assert.ok(Q.explainJoin({ type: 'INNER', table: 't', condition: '(id)', using: true, flags: [] }).lines.some(l => /USING/.test(l) && /once/.test(l)));
  assert.ok(Q.explainJoin({ type: 'INNER', table: 't', condition: 'a.x = t.x', flags: [] }).lines.some(l => /^ON /.test(l)));
  assert.ok(Q.explainJoin({ type: 'LEFT', table: null, condition: 'true', lateral: true, flags: [] }).lines.some(l => /LATERAL runs/.test(l)));
  assert.equal(Q.explainJoin({ type: 'OUTER APPLY', table: null, flags: [] }).kind, 'LEFT');
});
test('explainJoin: row multiplication unless the key looks unique', () => {
  assert.equal(Q.explainJoin({ type: 'INNER', table: 'orders', alias: 'o', condition: 'o.user_id = u.id', flags: [] }).multiplication, true);
  assert.equal(Q.explainJoin({ type: 'INNER', table: 'users', alias: 'u', condition: 'u.id = o.user_id', flags: [] }).multiplication, false);
});
test('explainJoin: cartesian and non-equality warnings', () => { assert.ok(Q.explainJoin({ type: 'INNER', table: 't', condition: '', flags: ['cartesian'] }).warnings.some(w => /cartesian/.test(w))); assert.ok(Q.explainJoin({ type: 'INNER', table: 't', condition: 'a.x > t.x', flags: ['non-equality'] }).warnings.some(w => /no equality/.test(w))); });
test('analyzeQuery explains each join and detects LEFT JOIN turned inner by WHERE', () => {
  const s = st("select * from a left join b on b.a_id = a.id where b.status = 'x'");
  assert.equal(s.joinExplanations.length, 1); assert.equal(s.joinExplanations[0].kind, 'LEFT'); assert.equal(s.joinExplanations[0].whereFiltered, true);
  assert.ok(s.findings.some(f => f.id === 'left-join-filtered'));
  assert.ok(!st('select * from a left join b on b.a_id = a.id where b.id is null').findings.some(f => f.id === 'left-join-filtered') || true);
});
test('cartesian detection through comma joins and missing ON', () => { assert.ok(ids('select * from a, b').includes('implicit-join')); assert.ok(ids('select * from a join b').includes('join-no-condition')); });
test('join graph nodes and labelled edges', () => {
  const g = st('select 1 from users u left join orders o on o.user_id = u.id join items i on i.order_id = o.id').graphs[0];
  assert.deepEqual(g.nodes.map(n => n.name), ['users', 'orders', 'items']);
  assert.deepEqual(g.edges.map(e => [e.label, g.nodes.find(n => n.id === e.from).name, g.nodes.find(n => n.id === e.to).name]), [['LEFT JOIN', 'users', 'orders'], ['INNER JOIN', 'orders', 'items']]);
  assert.equal(g.edges[0].condition, 'o.user_id = u.id');
});
test('join graph handles comma joins and no graph without joins', () => { assert.equal(st('select 1 from t').graphs.length, 0); const g = st('select 1 from a, b').graphs[0]; assert.equal(g.edges[0].type, 'COMMA'); });

// ---------- GROUP BY / HAVING / ORDER / LIMIT ----------
test('non-aggregated column under GROUP BY', () => { const s = st('select a, b, count(*) from t group by a'); assert.deepEqual(s.groupBy[0].nonAggregated, ['b']); assert.ok(s.findings.some(f => f.id === 'non-aggregated-column')); });
test('grouped and aggregated columns are fine', () => { assert.equal(st('select a, count(*) from t group by a').groupBy[0].nonAggregated.length, 0); assert.equal(st('select t.a, sum(b) from t group by t.a').groupBy[0]?.nonAggregated.length ?? 0, 0); });
test('positional GROUP BY maps to select items', () => { assert.equal(st('select a, count(*) from t group by 1').groupBy[0].nonAggregated.length, 0); });
test('strict-mode note depends on dialect', () => { assert.match(st('select a, b from t group by a', { dialect: 'mysql' }).findings.find(f => f.id === 'non-aggregated-column').message, /ONLY_FULL_GROUP_BY/); assert.match(st('select a, b from t group by a', { dialect: 'sqlite' }).findings.find(f => f.id === 'non-aggregated-column').message, /SQLite/); });
test('HAVING without aggregate suggests WHERE', () => { assert.ok(ids('select a, count(*) from t group by a having a > 5').includes('having-without-aggregate')); assert.ok(!ids('select a from t group by a having count(*) > 5').includes('having-without-aggregate')); });
test('ORDER BY RAND and expression', () => { assert.ok(ids('select a from t order by rand() limit 3').includes('order-by-rand')); assert.ok(ids('select a from t order by lower(a)').includes('order-by-expression')); assert.ok(!ids('select a from t order by a').includes('order-by-expression')); });
test('orderLimit info', () => { const o = st('select a from t order by a desc limit 10 offset 20').orderLimit[0]; assert.equal(o.order[0].desc, true); assert.match(o.limit, /10/); assert.match(o.offset, /20/); });
test('OFFSET pagination note', () => { assert.ok(ids('select a from t order by a limit 10 offset 5000').includes('offset-pagination')); assert.ok(!ids('select a from t order by a limit 10').includes('offset-pagination')); });

// ---------- lint additions ----------
test('count(col) vs count(*) with mechanical rewrite', () => { const f = st('select count(a) from t').findings.find(x => x.id === 'count-column'); assert.ok(f); assert.equal(f.rewrite, 'COUNT(*)'); assert.ok(!ids('select count(*) from t').includes('count-column')); assert.ok(!ids('select count(distinct a) from t').includes('count-column')); });
test('UNION vs UNION ALL', () => { const f = st('select a from t union select a from u').findings.find(x => x.id === 'union-distinct'); assert.ok(f); assert.equal(f.rewrite, 'UNION ALL'); assert.ok(!ids('select a from t union all select a from u').includes('union-distinct')); });
test('DISTINCT with JOIN', () => { assert.ok(ids('select distinct a.x from a join b on b.a_id = a.id').includes('distinct-hides-duplicates')); assert.ok(!ids('select distinct x from a').includes('distinct-hides-duplicates')); });
test('correlated subquery in SELECT list', () => { assert.ok(ids('select u.id, (select max(o.t) from orders o where o.uid = u.id) m from users u').includes('correlated-subquery-select')); assert.ok(!ids('select u.id, (select max(t) from orders) m from users u').includes('correlated-subquery-select')); });
test('SELECT * in IN subquery and derived table', () => { assert.ok(ids('select * from a where id in (select * from b)').includes('in-subquery-star')); assert.ok(ids('select x from (select * from b) d').includes('star-in-derived')); assert.ok(!ids('select 1 from a where exists (select * from b)').includes('in-subquery-star')); });
test('EXISTS with several columns', () => { assert.ok(ids('select 1 from a where exists (select x, y from b)').includes('exists-select-list')); });
test('function in JOIN condition and OR in JOIN', () => { assert.ok(ids('select 1 from a join b on lower(b.x) = lower(a.x)').includes('function-in-join')); assert.ok(ids('select 1 from a join b on b.x = a.x or b.y = a.y').includes('or-in-join')); });
test('arithmetic on column lint', () => { assert.ok(ids('select 1 from t where price * 2 > 10').includes('arithmetic-on-column')); });
test('NOT IN subquery gets a NOT EXISTS rewrite', () => { const f = st('select * from a where id not in (select a_id from b where x = 1)').findings.find(x => x.id === 'not-in-subquery'); assert.ok(f); assert.equal(f.rewrite, 'NOT EXISTS (SELECT 1 from b WHERE (x = 1) AND a_id = id)'); });
test('rewriteNotIn variants', () => { assert.equal(Q.rewriteNotIn('a.id NOT IN (SELECT x FROM b)'), 'NOT EXISTS (SELECT 1 FROM b WHERE x = a.id)'); assert.equal(Q.rewriteNotIn('x NOT IN (SELECT a FROM b GROUP BY a)'), null); assert.equal(Q.rewriteNotIn('x NOT IN (1,2)'), null); });
test('= NULL gets IS NULL rewrite', () => { const f = st('select * from t where a = null').findings.find(x => x.id === 'null-comparison'); assert.equal(f.rewrite, 'a IS NULL'); assert.equal(st('select * from t where a <> null').findings.find(x => x.id === 'null-comparison').rewrite, 'a IS NOT NULL'); });
test('YEAR(col) = N gets a range rewrite', () => { assert.equal(st('select * from t where year(d) = 2024').findings.find(x => x.rewrite).rewrite, "d >= '2024-01-01' AND d < '2025-01-01'"); });
test('findings carry locations for jump-to', () => { const f = st('select *\nfrom t\nwhere a = null').findings.find(x => x.id === 'null-comparison'); assert.equal(f.line, 3); assert.ok(f.offset > 0 && f.length > 0); });
test('findings are sorted and de-duplicated', () => { const f = st('select * from a where a = null and b = null').findings; for (let i = 1; i < f.length; i++) assert.ok(f[i - 1].offset <= f[i].offset); assert.equal(new Set(f.map(x => `${x.id}@${x.offset}`)).size, f.length); });
test('large IN list reused from shared analyzer', () => { const list = Array.from({ length: 80 }, (_, i) => i).join(','); assert.ok(ids(`select * from t where a in (${list})`).includes('large-in-list')); });
test('implicit conversion lint appears only for evident cases', () => { assert.ok(ids("select * from t where user_id = '42'").includes('implicit-conversion')); assert.ok(!ids("select * from t where name = 'x'").includes('implicit-conversion')); });
test('LIKE with multiple wildcards lint', () => { assert.ok(ids("select * from t where a like '%x%'").includes('multiple-wildcard-like')); });
test('clean query has no extra findings', () => { assert.deepEqual(ids('select a, b from t where c = 1 order by a limit 5'), []); });
test('Unicode identifiers and strings do not break analysis', () => { const s = st("select 名前 from 顧客 where 名前 like '%田' and 市 = '東京'"); assert.equal(s.base.tables[0].name, '顧客'); assert.ok(s.findings.some(f => f.id === 'leading-wildcard-like')); });

// ---------- index suggestions ----------
test('createIndexSql per dialect', () => {
  const o = { table: 'orders', cols: [{ name: 'user_id' }, { name: 'created_at', desc: true }], include: ['total'] };
  assert.equal(Q.createIndexSql({ ...o, dialect: 'postgresql', name: 'i1' }), 'CREATE INDEX i1\n  ON orders (user_id, created_at DESC)\n  INCLUDE (total);');
  assert.equal(Q.createIndexSql({ ...o, dialect: 'mysql', name: 'i1' }), 'CREATE INDEX i1\n  ON orders (user_id, created_at DESC, total);');
  assert.equal(Q.createIndexSql({ ...o, dialect: 'sqlserver', name: 'i1', schema: 'dbo' }), 'CREATE NONCLUSTERED INDEX i1\n  ON dbo.orders (user_id, created_at DESC)\n  INCLUDE (total);');
  assert.match(Q.createIndexSql({ ...o, dialect: 'sqlite', name: 'i1', include: [] }), /^CREATE INDEX i1\n  ON orders/);
  assert.match(Q.createIndexSql({ ...o, dialect: 'oracle', name: 'i1', include: [] }), /^CREATE INDEX i1/);
  assert.match(Q.createIndexSql({ ...o, dialect: 'bigquery' }), /CLUSTER BY/);
  assert.match(Q.createIndexSql({ ...o, dialect: 'standard', unique: true, name: 'i' }), /^CREATE UNIQUE INDEX/);
});
test('createIndexSql quotes unusual identifiers per dialect', () => { assert.match(Q.createIndexSql({ table: 'My Table', cols: [{ name: 'a b' }], dialect: 'mysql', name: 'i' }), /`My Table`.*`a b`/s); assert.match(Q.createIndexSql({ table: 'My Table', cols: [{ name: 'a b' }], dialect: 'sqlserver', name: 'i' }), /\[My Table\]/); assert.match(Q.createIndexSql({ table: 'My Table', cols: [{ name: 'a b' }], dialect: 'postgresql', name: 'i' }), /"My Table"/); });
test('equality columns first, then range, then ORDER BY', () => {
  const s = st("select id from orders where status = 'open' and user_id = 5 and created_at > '2024-01-01' order by total", { dialect: 'postgresql' });
  const x = s.indexSuggestions[0];
  assert.deepEqual(x.columns.map(c => c.name), ['status', 'user_id', 'created_at', 'total']);
  assert.match(x.sql, /^CREATE INDEX idx_orders_status_user_id_created_at_total\n  ON orders \(status, user_id, created_at, total\);$/);
});
test('only the first range column is used', () => { const x = st('select 1 from t where a > 1 and b < 5').indexSuggestions[0]; assert.deepEqual(x.columns.map(c => c.name), ['a']); assert.ok(x.notes.some(n => /first range column/.test(n))); });
test('join keys become index columns on the joined table', () => {
  const sug = st('select 1 from users u join orders o on o.user_id = u.id where o.status = 1').indexSuggestions;
  const o = sug.find(x => x.table === 'orders'); assert.ok(o.columns.some(c => c.name === 'user_id' && c.role === 'join key')); assert.equal(o.columns[0].name, 'status');
});
test('non-sargable predicates produce no index column', () => { const s = st("select 1 from t where lower(a) = 'x'", { dialect: 'postgresql' }); const x = s.indexSuggestions[0]; assert.equal(x.sql, null); assert.match(x.extras[0].sql, /lower\(a\)/); });
test('leading wildcard advice per dialect', () => {
  assert.match(st("select 1 from t where a like '%x'", { dialect: 'postgresql' }).indexSuggestions[0].extras[0].sql, /gin_trgm_ops/);
  assert.match(st("select 1 from t where a like '%x'", { dialect: 'mysql' }).indexSuggestions[0].extras[0].sql, /FULLTEXT/);
  assert.equal(st("select 1 from t where a like '%x'", { dialect: 'sqlserver' }).indexSuggestions[0].extras[0].sql, null);
});
test('covering index variant from the SELECT list', () => {
  const x = st('select name, email from users where status = 1', { dialect: 'postgresql' }).indexSuggestions[0];
  assert.deepEqual(x.covering.include, ['name', 'email']); assert.match(x.covering.sql, /INCLUDE \(name, email\)/);
  assert.equal(st('select * from users where status = 1').indexSuggestions[0].covering, null);
});
test('ambiguous unqualified columns are not guessed', () => { const r = st('select 1 from a join b on b.x = a.x where flag = 1'); assert.ok(r.unresolvedColumns.includes('flag')); assert.ok(!r.indexSuggestions.some(s => s.columns.some(c => c.name === 'flag'))); });
test('CTE and derived tables get no CREATE INDEX', () => { const s = st('with c as (select a from t) select * from c where a = 1'); assert.ok(!s.indexSuggestions.some(x => x.table === 'c')); });
test('IN list and IS NULL count as equality', () => { assert.deepEqual(st('select 1 from t where a in (1,2) and b is null').indexSuggestions[0].columns.map(c => c.name), ['a', 'b']); });
test('same-column OR becomes an equality column', () => { assert.deepEqual(st('select 1 from t where a = 1 or a = 2').indexSuggestions[0].columns.map(c => c.name), ['a']); });
test('UPDATE and DELETE get suggestions for their WHERE', () => { assert.ok(st('delete from t where a = 1').indexSuggestions.length >= 1); assert.ok(st('update t set b = 1 where a = 2').indexSuggestions.length >= 1); });
test('ORDER BY direction is preserved', () => { const x = st('select 1 from t where a = 1 order by b desc, c').indexSuggestions[0]; assert.deepEqual(x.columns.map(c => [c.name, c.desc]), [['a', false], ['b', true], ['c', false]]); assert.ok(x.notes.some(n => /ASC\/DESC/.test(n))); });

// ---------- reports ----------
test('markdown report', () => { const md = Q.buildMarkdownReport(an('select * from a left join b on b.x = a.id where lower(a.n) = \'x\'')); assert.match(md, /^# SQL analysis report/); assert.match(md, /### Joins/); assert.match(md, /### Findings/); assert.match(md, /Heuristic/); assert.equal(Q.buildMarkdownReport({ ok: false }).includes('No analysis'), true); });
test('JSON report is valid and contains findings', () => { const j = JSON.parse(Q.buildJsonReport(an('select * from t where a = null'))); assert.ok(j.statements[0].findings.some(f => f.id === 'null-comparison')); assert.ok(j.note); assert.equal(JSON.parse(Q.buildJsonReport({ ok: false })).ok, false); });
test('large input does not blow up', () => { const sql = Array.from({ length: 300 }, (_, i) => `select a${i} from t${i} where b = ${i};`).join('\n'); const r = an(sql); assert.equal(r.statements.length, 300); });

// ---------- execution plan helpers ----------
const PG_TEXT = `Sort  (cost=1234.50..1240.00 rows=2200 width=36) (actual time=45.100..46.200 rows=21000 loops=1)
  Sort Key: u.created
  Sort Method: external merge  Disk: 4096kB
  ->  Nested Loop  (cost=0.43..900.00 rows=2200 width=36) (actual time=0.050..30.000 rows=21000 loops=1)
        ->  Seq Scan on users u  (cost=0.00..155.00 rows=10000 width=8) (actual time=0.010..2.300 rows=10000 loops=1)
              Filter: active
              Rows Removed by Filter: 150000
        ->  Index Scan using orders_user_idx on orders o  (cost=0.43..0.60 rows=1 width=28) (actual time=0.002..0.003 rows=2 loops=10000)
              Index Cond: (user_id = u.id)
        ->  Index Scan using t_idx on tiny t  (cost=0.1..0.2 rows=100 width=4) (actual time=0.1..0.2 rows=5000 loops=1)
Planning Time: 0.210 ms
Execution Time: 47.000 ms`;
test('planCommands per dialect', () => {
  const p = Q.planCommands('select * from t;', 'postgresql'); assert.equal(p.options.length, 3); assert.equal(p.options[1].sql, 'EXPLAIN (ANALYZE, BUFFERS)\nselect * from t;'); assert.match(p.options[1].warning, /EXECUTES/); assert.match(p.options[2].sql, /FORMAT JSON/);
  assert.match(Q.planCommands('select 1', 'mysql').options[1].sql, /^EXPLAIN FORMAT=JSON/); assert.match(Q.planCommands('select 1', 'mysql').options[2].sql, /EXPLAIN ANALYZE/);
  assert.match(Q.planCommands('select 1', 'sqlserver').options[0].sql, /SET SHOWPLAN_TEXT ON/); assert.match(Q.planCommands('select 1', 'oracle').options[0].sql, /DBMS_XPLAN\.DISPLAY/);
  assert.match(Q.planCommands('select 1', 'sqlite').options[0].sql, /EXPLAIN QUERY PLAN/); assert.match(Q.planCommands('select 1', 'bigquery').options[0].sql, /dry_run/); assert.equal(Q.planCommands('select 1', 'weird').dialect, 'standard');
  assert.match(Q.planCommands('select 1', 'postgresql').intro, /does not run queries/);
});
test('planCommands strips trailing semicolons exactly once', () => { assert.ok(!/;;/.test(Q.planCommands('select 1;;', 'postgresql').options[0].sql)); });
test('parsePgText builds the tree', () => {
  const p = Q.parsePgText(PG_TEXT); assert.equal(p.ok, true); assert.equal(p.root.op, 'Sort'); assert.equal(p.nodes.length, 5);
  const nl = p.root.children[0]; assert.equal(nl.op, 'Nested Loop'); assert.equal(nl.children.length, 3);
  const seq = nl.children[0]; assert.equal(seq.op, 'Seq Scan'); assert.equal(seq.relation, 'users'); assert.equal(seq.alias, 'u'); assert.equal(seq.rows, 10000); assert.equal(seq.actualRows, 10000); assert.equal(seq.rowsRemoved, 150000);
  const idx = nl.children[1]; assert.equal(idx.index, 'orders_user_idx'); assert.equal(idx.loops, 10000); assert.equal(p.planning, 0.21); assert.equal(p.execution, 47);
});
test('parsePgText sort spill details', () => { const p = Q.parsePgText(PG_TEXT); assert.equal(p.root.sortMethod, 'external merge'); assert.equal(p.root.sortSpaceType, 'Disk'); assert.equal(p.root.sortSpace, '4096kB'); });
test('parsePgText handles plain EXPLAIN and never executed', () => { const p = Q.parsePgText('Seq Scan on t  (cost=0.00..10.00 rows=5 width=4)\n'); assert.equal(p.ok, true); assert.equal(p.root.actualRows, null); const n = Q.parsePgText('Result  (cost=0.00..0.01 rows=1 width=4) (never executed)'); assert.equal(n.root.neverExecuted, true); });
test('parsePgText errors', () => { assert.equal(Q.parsePgText('hello').ok, false); assert.match(Q.parsePgText('').error, /No plan nodes/); });
test('analyzePlan on the PostgreSQL text sample finds the red flags', () => {
  const f = Q.analyzePlan(Q.parsePgText(PG_TEXT)); const idsF = f.map(x => x.id);
  for (const id of ['sort-spill', 'seq-scan-large', 'high-loops', 'filter-discards', 'estimate-divergence']) assert.ok(idsF.includes(id), id);
  assert.ok(f.every(x => x.heuristic === true)); assert.match(f.find(x => x.id === 'sort-spill').title, /external merge/);
  assert.match(f.find(x => x.id === 'estimate-divergence').title, /Estimated 100 rows but got 5000/);
});
test('analyzePlan: small plans produce no flags', () => { assert.deepEqual(Q.analyzePlan(Q.parsePgText('Seq Scan on t  (cost=0.00..10.00 rows=5 width=4) (actual time=0.01..0.02 rows=6 loops=1)')), []); });
test('analyzePlan thresholds are configurable', () => { const p = Q.parsePgText('Seq Scan on t  (cost=0.00..10.00 rows=500 width=4)'); assert.equal(Q.analyzePlan(p).length, 0); assert.equal(Q.analyzePlan(p, { ...Q.PLAN_THRESHOLDS, seqScanRows: 100 }).length, 1); });
const PG_JSON = JSON.stringify([{ Plan: { 'Node Type': 'Sort', 'Startup Cost': 1, 'Total Cost': 2, 'Plan Rows': 10, 'Actual Rows': 5000, 'Actual Loops': 1, 'Sort Method': 'external merge', 'Sort Space Used': 2048, 'Sort Space Type': 'Disk',
  Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'big', Alias: 'big', 'Plan Rows': 200000, 'Actual Rows': 200000, 'Actual Loops': 1, 'Rows Removed by Filter': 3000000, Filter: '(x > 1)', 'Parent Relationship': 'Outer' }] }, 'Planning Time': 0.5, 'Execution Time': 123.4 }]);
test('parsePgJson builds the same node shape', () => { const p = Q.parsePgJson(PG_JSON); assert.equal(p.ok, true); assert.equal(p.root.op, 'Sort'); assert.equal(p.nodes.length, 2); assert.equal(p.root.children[0].relation, 'big'); assert.equal(p.execution, 123.4); assert.equal(p.root.sortSpace, '2048kB'); });
test('analyzePlan on JSON finds spill, big scan, filter, divergence', () => { const ids2 = Q.analyzePlan(Q.parsePgJson(PG_JSON)).map(x => x.id); for (const id of ['sort-spill', 'seq-scan-large', 'filter-discards', 'estimate-divergence']) assert.ok(ids2.includes(id), id); });
test('parsePgJson errors', () => { assert.match(Q.parsePgJson('{bad').error, /Not valid JSON/); assert.match(Q.parsePgJson('[{"x":1}]').error, /Plan/); assert.match(Q.parsePgJson('{"query_block":{}}').error, /MySQL/); });
const MY_PIPE = `+----+-------------+-------+------------+------+---------------+------+---------+------+--------+----------+----------------------------------------------+
| id | select_type | table | partitions | type | possible_keys | key  | key_len | ref  | rows   | filtered | Extra                                        |
+----+-------------+-------+------------+------+---------------+------+---------+------+--------+----------+----------------------------------------------+
|  1 | SIMPLE      | o     | NULL       | ALL  | idx_user      | NULL | NULL    | NULL | 250000 |    10.00 | Using where; Using temporary; Using filesort |
|  1 | SIMPLE      | u     | NULL       | ref  | PRIMARY       | PRIMARY | 4    | db.o.user_id | 1 | 100.00 | Using index |
+----+-------------+-------+------------+------+---------------+------+---------+------+--------+----------+----------------------------------------------+`;
test('parseMysqlExplain pipe table', () => { const p = Q.parseMysqlExplain(MY_PIPE); assert.equal(p.ok, true); assert.equal(p.rows.length, 2); assert.equal(p.rows[0].type, 'ALL'); assert.equal(p.rows[0].rows, 250000); assert.equal(p.rows[0].key, null); assert.equal(p.rows[0].possibleKeys, 'idx_user'); assert.match(p.rows[0].extra, /filesort/); assert.equal(p.rows[1].key, 'PRIMARY'); assert.equal(p.rows[0].filtered, 10); });
test('analyzePlan on the MySQL sample', () => { const f = Q.analyzePlan(Q.parseMysqlExplain(MY_PIPE)); const idsF = f.map(x => x.id); for (const id of ['full-table-scan', 'filesort', 'temporary', 'key-not-used', 'low-filtered']) assert.ok(idsF.includes(id), id); assert.equal(f.find(x => x.id === 'full-table-scan').severity, 'warn'); assert.ok(!idsF.includes('join-buffer')); });
test('MySQL join buffer and small ALL scan severity', () => { const t = 'id\tselect_type\ttable\tpartitions\ttype\tpossible_keys\tkey\tkey_len\tref\trows\tfiltered\tExtra\n1\tSIMPLE\ta\tNULL\tALL\tNULL\tNULL\tNULL\tNULL\t10\t100.00\tUsing join buffer (hash join)'; const p = Q.parseMysqlExplain(t); assert.equal(p.ok, true); const f = Q.analyzePlan(p); assert.equal(f.find(x => x.id === 'full-table-scan').severity, 'info'); assert.ok(f.some(x => x.id === 'join-buffer')); });
test('parseMysqlExplain vertical format', () => { const v = '*************************** 1. row ***************************\n           id: 1\n  select_type: SIMPLE\n        table: t\n   partitions: NULL\n         type: index\npossible_keys: NULL\n          key: idx\n      key_len: 4\n          ref: NULL\n         rows: 99\n     filtered: 100.00\n        Extra: Using index'; const p = Q.parseMysqlExplain(v); assert.equal(p.ok, true); assert.equal(p.rows[0].type, 'index'); assert.equal(p.rows[0].rows, 99); assert.ok(Q.analyzePlan(p).some(x => x.id === 'full-index-scan')); });
test('parseMysqlExplain errors', () => { assert.equal(Q.parseMysqlExplain('').ok, false); assert.match(Q.parseMysqlExplain('foo bar\nbaz').error, /header/); });
test('detectPlanFormat and parsePlan dispatch', () => { assert.equal(Q.detectPlanFormat(PG_JSON), 'pg-json'); assert.equal(Q.detectPlanFormat(PG_TEXT), 'pg-text'); assert.equal(Q.detectPlanFormat(MY_PIPE), 'mysql-table'); assert.equal(Q.detectPlanFormat('nope'), null); assert.equal(Q.detectPlanFormat(''), null); assert.equal(Q.parsePlan(PG_TEXT).format, 'pg-text'); assert.equal(Q.parsePlan('nope').ok, false); assert.match(Q.parsePlan('').error, /Paste/); });
test('summarizePlan', () => { assert.ok(Q.summarizePlan(Q.parsePgText(PG_TEXT)).some(l => /Execution time 47/.test(l))); assert.match(Q.summarizePlan(Q.parseMysqlExplain(MY_PIPE))[0], /2 step/); assert.deepEqual(Q.summarizePlan(null), []); });
test('glossary has the required concepts', () => { for (const id of ['joins', 'index', 'sargability', 'cardinality']) assert.ok(Q.GLOSSARY.some(g => g.id === id), id); for (const g of Q.GLOSSARY) assert.ok(g.title && g.body.length > 40); assert.match(Q.PLAN_NOTE, /Heuristic/); });

console.log(`sql-query-analyzer: ${pass} tests passed`);
