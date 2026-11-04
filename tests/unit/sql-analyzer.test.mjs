// Run: node tests/unit/sql-analyzer.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { analyzeSql, explainSql, HEURISTIC_NOTE } from '../../assets/js/shared/sql-analyzer.js';
import { sqlToJson } from '../../assets/js/shared/sql-json.js';
import { highlightSegments } from '../../tools/sql-formatter/highlight.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const an = (sql, o) => { const r = analyzeSql(sql, o); assert.equal(r.ok, true, r.error); return r; };
const ids = r => r.findings.map(f => f.id);
const st = (sql, o) => an(sql, o).statements[0];

// ---------- structure ----------
test('statement types', () => {
  for (const [sql, t] of [['select 1', 'SELECT'], ['insert into t values (1)', 'INSERT'], ['update t set a=1 where b=2', 'UPDATE'], ['delete from t where a=1', 'DELETE'],
    ['create table t (a int)', 'CREATE'], ['alter table t add column b int', 'ALTER'], ['drop table t', 'DROP'], ['truncate table t', 'TRUNCATE'],
    ['merge into t using s on t.id = s.id when matched then update set a = 1', 'MERGE'], ['with c as (select 1) select * from c', 'SELECT']]) assert.equal(st(sql).type, t, sql);
  assert.equal(st('with c as (select 1) select * from c').startsWith, 'WITH');
  assert.equal(st('with c as (select 1) delete from t where id in (select * from c)').type, 'DELETE');
});
test('tables with alias and schema', () => {
  const s = st('select u.id from public.users as u join orders o on o.uid = u.id');
  assert.deepEqual(s.tables.map(t => [t.schema, t.name, t.alias, t.kind]), [['public', 'users', 'u', 'table'], [null, 'orders', 'o', 'table']]);
});
test('quoted identifiers and dialect quoting', () => {
  const s = st('select "My Col" from "Sch"."My Table" t');
  assert.equal(s.tables[0].name, 'My Table'); assert.equal(s.tables[0].schema, 'Sch'); assert.equal(s.tables[0].alias, 't');
  const m = st('select `a` from `db`.`t`', { dialect: 'mysql' });
  assert.equal(m.tables[0].name, 't'); assert.equal(m.tables[0].schema, 'db');
  assert.equal(st('select a from [dbo].[Orders]', { dialect: 'sqlserver' }).tables[0].name, 'Orders');
});
test('CTEs are listed and referenced as cte', () => {
  const s = st('with a as (select 1 as x), b (y) as (select x from a) select y from b join a on 1 = 1');
  assert.deepEqual(s.ctes.map(c => c.name), ['a', 'b']);
  assert.deepEqual(s.tables.filter(t => t.kind === 'cte').map(t => t.name), ['a', 'b', 'a']);
  assert.equal(s.complexity.breakdown.ctes, 2);
});
test('recursive CTE', () => {
  const s = st('with recursive t(n) as (select 1 union all select n+1 from t where n < 5) select n from t');
  assert.deepEqual(s.ctes.map(c => c.name), ['t']);
});
test('joins: types, conditions, flags', () => {
  const s = st("select * from a left outer join b on a.id = b.aid inner join c on c.x > a.y cross join d join e using (k) join f");
  assert.deepEqual(s.joins.map(j => j.type), ['LEFT', 'INNER', 'CROSS', 'INNER', 'INNER']);
  assert.equal(s.joins[0].condition, 'a.id = b.aid');
  assert.ok(s.joins[1].flags.includes('non-equality'));
  assert.ok(s.joins[2].flags.includes('cross-join'));
  assert.equal(s.joins[3].using, true);
  assert.ok(s.joins[4].flags.includes('cartesian'));
  assert.ok(ids(an("select * from a join b on 1=1")).includes('join-no-condition'));
});
test('implicit comma join', () => {
  const r = an('select 1 from a, b, c where a.id = b.id');
  assert.equal(r.statements[0].implicitJoins, 2);
  assert.ok(ids(r).includes('implicit-join'));
  assert.equal(r.statements[0].tables.length, 3);
});
test('clause presence', () => {
  const s = st('select distinct a, count(*) from t where x = 1 group by a having count(*) > 1 order by a limit 5');
  assert.deepEqual(s.clauses, { where: true, groupBy: true, having: true, orderBy: true, limit: true, distinct: true, select: true });
  const p = st('select a from t');
  assert.equal(p.clauses.where, false); assert.equal(p.clauses.limit, false);
});
test('aggregates and window functions', () => {
  const s = st('select count(*), sum(a), max(b), row_number() over (partition by c order by d), sum(x) over (partition by y) from t');
  assert.deepEqual(s.aggregates.map(a => a.name).sort(), ['COUNT', 'MAX', 'SUM']);
  assert.equal(s.aggregates.find(a => a.name === 'SUM').count, 1); // the windowed SUM is not an aggregate
  assert.deepEqual(s.windowFunctions.map(w => w.name.toLowerCase()), ['row_number', 'sum']);
  assert.equal(s.complexity.breakdown.windows, 4);
});
test('subquery count and nesting depth', () => {
  const s = st('select (select max(x) from b) m from a where id in (select id from c where z = (select 1 from d)) and exists (select 1 from e)');
  assert.equal(s.subqueries.count, 4); assert.equal(s.subqueries.maxDepth, 2);
  const d = st('select * from (select * from (select 1) x) y');
  assert.equal(d.subqueries.count, 2); assert.equal(d.subqueries.maxDepth, 2);
  assert.deepEqual(d.tables.filter(t => t.kind === 'derived').map(t => t.alias).sort(), ['x', 'y']);
});
test('UNION parts', () => {
  assert.equal(st('select a from x union select a from y union all select a from z').unionParts, 3);
  assert.equal(st('select a from x intersect select a from y').unionParts, 2);
  assert.equal(st('select a from x').unionParts, 1);
});
test('parameters / placeholders', () => {
  const s = st("select * from t where a = ? and b = $1 and c = :name and d = @v and e = %s and f = '?:x'");
  assert.deepEqual(s.parameters.map(p => [p.text, p.kind]), [['?', 'positional'], ['$1', 'numbered'], [':name', 'named'], ['@v', 'variable'], ['%s', 'format']]);
});
test('columns: qualifiers resolved, aliases and strings ignored', () => {
  const s = st("select u.name as n, u.age a2, status from users u where u.id = 1 and 'x' = u.k order by n");
  const names = s.columns.map(c => (c.qualifier ? c.qualifier + '.' : '') + c.name);
  assert.ok(names.includes('u.name') && names.includes('u.age') && names.includes('u.id') && names.includes('u.k') && names.includes('status'));
  assert.ok(!names.includes('a2'));
  assert.equal(s.columns.find(c => c.name === 'name').table, 'users');
  assert.equal(s.columns.find(c => c.name === 'status').table, 'users'); // single table: inferred
  assert.equal(s.columns.find(c => c.name === 'status').inferred, true);
});
test('INSERT columns and UPDATE SET columns', () => {
  assert.deepEqual(st('insert into t (a, b) values (1, 2)').columns.map(c => c.name), ['a', 'b']);
  const u = st("update t set a = 1, b = b + 1 where id = 3");
  assert.deepEqual([...new Set(u.columns.map(c => c.name))].sort(), ['a', 'b', 'id']);
});
test('multiple statements, locations', () => {
  const r = an('select 1;\nselect * from t;\n  delete from x');
  assert.equal(r.statements.length, 3);
  const f = r.findings.find(f => f.id === 'select-star');
  assert.equal(f.line, 2); assert.equal(f.col, 8);
  assert.equal('select 1;\nselect * from t;\n  delete from x'.slice(f.offset, f.offset + f.length), '*');
  assert.equal(r.findings.find(f => f.id === 'delete-no-where').line, 3);
  assert.equal(r.findings.find(f => f.id === 'delete-no-where').statement, 2);
});
test('DDL object info', () => {
  const s = st('create table if not exists public.t (a int)');
  assert.deepEqual(s.object, { kind: 'TABLE', name: 'public.t' });
  assert.equal(s.tables[0].name, 't');
});

// ---------- lint ----------
test('lint: select *', () => {
  assert.ok(ids(an('select * from t')).includes('select-star'));
  assert.ok(ids(an('select t.* from t')).includes('select-star'));
  assert.ok(!ids(an('select count(*) from t')).includes('select-star'));
  assert.ok(!ids(an('select a from t where exists (select * from u)')).includes('select-star'));
  assert.ok(!ids(an('select 2 * 3 from t')).includes('select-star'));
});
test('lint: update/delete without where', () => {
  assert.ok(ids(an('update t set a = 1')).includes('update-no-where'));
  assert.ok(!ids(an('update t set a = 1 where id = 1')).includes('update-no-where'));
  assert.ok(ids(an('delete from t')).includes('delete-no-where'));
  assert.ok(!ids(an('delete from t where a = 1')).includes('delete-no-where'));
  assert.ok(!ids(an("select 'update t set a=1' from x")).includes('update-no-where'));
});
test('lint: leading wildcard LIKE', () => {
  assert.ok(ids(an("select a from t where n like '%abc'")).includes('leading-wildcard-like'));
  assert.ok(ids(an("select a from t where n not like '%abc%'")).includes('leading-wildcard-like'));
  assert.ok(ids(an("select a from t where n like concat('%', ?)")).includes('leading-wildcard-like'));
  assert.ok(!ids(an("select a from t where n like 'abc%'")).includes('leading-wildcard-like'));
});
test('lint: function on column in WHERE', () => {
  assert.ok(ids(an("select a from t where lower(name) = 'x'")).includes('function-on-column'));
  assert.ok(ids(an('select a from t where year(created) = 2020')).includes('function-on-column'));
  assert.ok(!ids(an('select a from t where created > now()')).includes('function-on-column'));
  assert.ok(!ids(an("select lower(name) from t where id = 1")).includes('function-on-column'));
  assert.ok(!ids(an("select a from t where name = lower('X')")).includes('function-on-column'));
});
test('lint: OR across different columns', () => {
  assert.ok(ids(an('select 1 from t where a = 1 or b = 2')).includes('or-different-columns'));
  assert.ok(!ids(an('select 1 from t where a = 1 or a = 2')).includes('or-different-columns'));
  assert.ok(!ids(an('select 1 from t where (a = 1 and b = 2) or (a = 3 and b = 4)')).includes('or-different-columns'));
  assert.ok(ids(an('select 1 from t where x = 1 and (a = 1 or b = 2)')).includes('or-different-columns'));
});
test('lint: NOT IN subquery', () => {
  assert.ok(ids(an('select 1 from t where id not in (select id from u)')).includes('not-in-subquery'));
  assert.ok(!ids(an('select 1 from t where id not in (1, 2)')).includes('not-in-subquery'));
  assert.ok(!ids(an('select 1 from t where id in (select id from u)')).includes('not-in-subquery'));
});
test('lint: LIMIT without ORDER BY', () => {
  assert.ok(ids(an('select a from t limit 10')).includes('limit-no-order'));
  assert.ok(ids(an('select top 5 a from t', { dialect: 'sqlserver' })).includes('limit-no-order'));
  assert.ok(!ids(an('select a from t order by a limit 10')).includes('limit-no-order'));
  assert.ok(!ids(an('select a from t where exists (select 1 from u limit 1) order by a')).includes('limit-no-order'));
});
test('lint: ORDER BY RAND()', () => {
  assert.ok(ids(an('select a from t order by rand() limit 1', { dialect: 'mysql' })).includes('order-by-rand'));
  assert.ok(ids(an('select a from t order by random()', { dialect: 'postgresql' })).includes('order-by-rand'));
  assert.ok(!ids(an('select rand() from t order by a')).includes('order-by-rand'));
});
test('lint: = NULL', () => {
  assert.ok(ids(an('select a from t where b = null')).includes('null-comparison'));
  assert.ok(ids(an('select a from t where null <> b')).includes('null-comparison'));
  assert.ok(!ids(an('select a from t where b is null')).includes('null-comparison'));
  assert.ok(!ids(an('update t set b = null where id = 1')).includes('null-comparison'));
  assert.ok(!ids(an("select a from t where b = 'null'")).includes('null-comparison'));
});
test('lint: DISTINCT with GROUP BY, large IN list', () => {
  assert.ok(ids(an('select distinct a from t group by a')).includes('distinct-group-by'));
  assert.ok(!ids(an('select distinct a from t')).includes('distinct-group-by'));
  const big = `select 1 from t where id in (${Array.from({ length: 60 }, (_, i) => i).join(',')})`;
  assert.ok(ids(an(big)).includes('large-in-list'));
  assert.ok(!ids(an('select 1 from t where id in (1,2,3)')).includes('large-in-list'));
  assert.ok(!ids(an(big, { inListThreshold: 100 })).includes('large-in-list'));
});
test('lint findings are complete and labelled heuristic', () => {
  const r = an("select * from a, b where lower(a.x) = 'q' and a.n like '%z' limit 3");
  assert.ok(r.findings.length >= 4);
  for (const f of r.findings) {
    assert.ok(f.id && ['info', 'warn'].includes(f.severity) && f.message && f.suggestion && f.heuristic === true);
    assert.ok(Number.isInteger(f.line) && Number.isInteger(f.col) && f.line >= 1 && f.col >= 1);
  }
  assert.ok(r.note.includes('not a database execution plan'));
});
test('comments and strings never trigger rules', () => {
  const r = an("select a /* select * from x */ from t -- delete from y\nwhere b = ' or c = null like ''%x''' ");
  assert.deepEqual(ids(r), []);
  assert.deepEqual(r.statements[0].tables.map(t => t.name), ['t']);
});
test('mysql backslash string does not leak into analysis', () => {
  const r = an("select a from t where b = 'x\\' or c = null; delete from z", { dialect: 'mysql' });
  assert.equal(r.statements.length, 1); // the escaped quote keeps everything after it inside the string
  assert.ok(!ids(r).includes('null-comparison'));
  assert.ok(r.warnings.length >= 1);
});

// ---------- complexity ----------
test('complexity score follows the documented formula', () => {
  const simple = st('select a from t');
  assert.equal(simple.complexity.score, 1); assert.equal(simple.complexity.level, 'low');
  const hard = st('with c as (select 1) select distinct a, row_number() over (order by a) from t join u on t.id = u.id and t.x = u.x where a in (select 1) group by a having count(*) > 1 union select 1');
  // 1 + 2 join + 2 subq + 1 cte + 2 union + 2 window + 1 group + 1 having + 1 distinct + 0.5*2 conditions(AND) = 14 -> rounded
  assert.equal(hard.complexity.score, 14); assert.equal(hard.complexity.level, 'high');
  assert.ok(hard.complexity.formula.includes('joins'));
});

// ---------- robustness ----------
test('garbage / empty input never throws', () => {
  for (const g of ['', '   ', null, undefined, 42, '(((', ')))', "'unterminated", '/* open', 'asdf qwer', ';;;', '-- only comment', '\u0000\u0001', 'select (((', 'select ) from', 'a'.repeat(1000), '"', '[', '$$', 'select from where group by']) {
    let r; assert.doesNotThrow(() => { r = analyzeSql(g); }, String(g));
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.equal(typeof r.error, 'string');
    assert.doesNotThrow(() => explainSql(g));
    assert.doesNotThrow(() => sqlToJson(g));
  }
  assert.equal(analyzeSql('').ok, false);
  assert.equal(analyzeSql('asdf qwer zxcv').ok, false);
  assert.equal(analyzeSql('-- hi').ok, false);
});
test('unbalanced parentheses still analyse', () => {
  const r = analyzeSql('select a from t where (b = 1 and (c = 2');
  assert.equal(r.ok, true);
  assert.equal(r.statements[0].tables[0].name, 't');
});
test('fuzz: random token soup never throws', () => {
  const bag = ['select', 'from', 'where', 'join', 'on', '(', ')', ',', 'a', 'b.c', "'x'", '1', 'union', 'with', 'as', 'limit', 'order', 'by', 'group', 'having', 'in', 'not', 'like', '=', '*', '--', '/*', ';', 'insert', 'into', 'values', 'update', 'set', 'delete', '?', ':p', 'case', 'when', 'then', 'end', 'over', 'distinct', '"q"', '`b`'];
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 30) }, () => bag[Math.floor(rnd() * bag.length)]).join(' ');
    for (const d of ['standard', 'mysql', 'sqlserver']) {
      assert.doesNotThrow(() => { analyzeSql(s, { dialect: d }); explainSql(s, { dialect: d }); sqlToJson(s, { dialect: d }); }, s);
    }
  }
});
test('performance: 50k-token query analyses in < 1s', () => {
  const cols = Array.from({ length: 5000 }, (_, i) => `c${i}`).join(', ');            // ~10k tokens
  const ins = Array.from({ length: 10000 }, (_, i) => i).join(', ');                   // ~20k tokens
  const ors = Array.from({ length: 2500 }, (_, i) => `x${i} = ${i}`).join(' or ');     // ~10k tokens
  const sql = `select ${cols} from t join u on t.id = u.id where id in (${ins}) and (${ors}) and f(g(h(1))) = 2 group by c1 order by c2`;
  const t0 = performance.now();
  const r = analyzeSql(sql);
  const ms = performance.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  console.log(`  (50k-token analysis: ${ms.toFixed(0)} ms)`);
  assert.ok(r.statements[0].columns.length >= 5000);
  const t1 = performance.now(); explainSql(sql); assert.ok(performance.now() - t1 < 1000);
});
test('deep nesting does not blow the stack', () => {
  const sql = `${'select * from ('.repeat(300)}select 1${') x'.repeat(300)}`;
  const r = analyzeSql(sql);
  assert.equal(r.ok, true); assert.equal(r.statements[0].subqueries.maxDepth, 300);
});

// ---------- explain ----------
test('explain: SELECT reading order and heuristic labels', () => {
  const r = explainSql("select u.name, count(o.id) c from users u join orders o on o.uid = u.id where u.active = 1 group by u.name having count(o.id) > 2 order by c desc limit 5");
  assert.equal(r.ok, true);
  const s = r.statements[0];
  assert.deepEqual(s.steps.map(x => x.clause), ['FROM', 'JOIN', 'WHERE', 'GROUP BY', 'HAVING', 'SELECT', 'ORDER BY', 'LIMIT']);
  assert.ok(s.orderNote.includes('LOGICAL'));
  assert.ok(s.orderNote.includes('not') || s.orderNote.includes('free to execute'));
  assert.equal(s.indexHints.heuristic, true);
  assert.ok(/heuristic/i.test(s.indexHints.note));
  const cols = s.indexHints.columns.map(c => c.column);
  assert.ok(cols.includes('u.active') && cols.includes('o.uid') && cols.includes('u.id'));
  assert.ok(r.note.includes('EXPLAIN'));
});
test('explain: DISTINCT and UNION steps', () => {
  const s = explainSql('select distinct a from t order by a').statements[0];
  assert.deepEqual(s.steps.map(x => x.clause), ['FROM', 'SELECT', 'DISTINCT', 'ORDER BY']);
  assert.ok(explainSql('select a from x union select a from y').statements[0].steps.some(x => x.clause === 'UNION'));
});
test('explain: INSERT/UPDATE/DELETE effect', () => {
  assert.ok(/Adds rows to t \(columns a, b\)/.test(explainSql('insert into t (a,b) values (1,2)').statements[0].effect));
  const u = explainSql('update t set a = 1').statements[0];
  assert.ok(u.effect.includes('ALL rows'));
  const d = explainSql('delete from t where id = 5').statements[0];
  assert.ok(d.effect.includes('Removes rows from t') && d.effect.includes('id = 5'));
  assert.equal(d.orderNote, null);
});
test('explain: error passthrough', () => {
  const r = explainSql('   ');
  assert.equal(r.ok, false); assert.equal(typeof r.error, 'string');
  assert.ok(HEURISTIC_NOTE.includes('not a database execution plan'));
});

// ---------- SQL -> JSON ----------
test('sql->json: multi-row insert with all value kinds', () => {
  const r = sqlToJson("INSERT INTO users (id, name, active, score, note, token, created) VALUES (1, 'Ann', true, -3.5, NULL, 0xFF, NOW()), (2, 'O''Neil', FALSE, 1e3, 'x', X'AB', CURRENT_TIMESTAMP)");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, [
    { id: 1, name: 'Ann', active: true, score: -3.5, note: null, token: '0xFF', created: 'NOW()' },
    { id: 2, name: "O'Neil", active: false, score: 1000, note: 'x', token: '0xAB', created: 'CURRENT_TIMESTAMP' },
  ]);
  assert.ok(r.notes.some(n => n.includes('created') && n.includes('not evaluated')));
  assert.ok(r.notes.some(n => n.includes('hex')));
  assert.equal(r.shape, 'array'); assert.equal(JSON.parse(r.json).length, 2);
});
test('sql->json: mysql backslash escapes only in backslash dialects', () => {
  const sql = "insert into t (a) values ('a\\'b\\n'), ('c\\d')";
  assert.deepEqual(sqlToJson(sql, { dialect: 'mysql' }).data, [{ a: "a'b\n" }, { a: 'cd' }]);
  const std = sqlToJson("insert into t (a) values ('c\\d')");
  assert.deepEqual(std.data, [{ a: 'c\\d' }]);
});
test('sql->json: groups by table, merges multiple inserts, quoted names', () => {
  const r = sqlToJson('insert into a (x) values (1); insert into "b" ("y z") values (2); insert into a (x) values (3);');
  assert.deepEqual(r.data, { a: [{ x: 1 }, { x: 3 }], b: [{ 'y z': 2 }] });
  assert.equal(r.shape, 'object'); assert.equal(r.rows, 3);
  assert.deepEqual(sqlToJson('insert into a (x) values (1); insert into a (x) values (2)').data, [{ x: 1 }, { x: 2 }]);
});
test('sql->json: expressions, big numbers, no column list, negative numbers', () => {
  const r = sqlToJson("insert into t values (-5, +2, 12345678901234567890, 1+2, concat('a','b'), 'a;b')");
  assert.deepEqual(r.data, [{ column_1: -5, column_2: 2, column_3: '12345678901234567890', column_4: '1+2', column_5: "concat('a','b')", column_6: 'a;b' }]);
  assert.ok(r.notes.some(n => n.includes('column_1')));
  assert.ok(r.notes.some(n => n.includes('precision')));
});
test('sql->json: comments ignored, ON DUPLICATE tail noted, __proto__ safe', () => {
  const r = sqlToJson("-- hi\ninsert into t (a, __proto__) /* c */ values (1, 2) on duplicate key update a = 2;", { dialect: 'mysql' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.notes.some(n => n.includes('ON')));
  assert.equal(Object.keys(r.data[0]).length, 2);
  assert.equal(({}).a, undefined);
});
test('sql->json: unsupported / malformed give clear errors', () => {
  for (const [sql, re] of [['select * from t', /only INSERT/], ['insert into t (a) select 1', /INSERT \.\.\. SELECT/], ['insert into t (a, b) values (1)', /1 value but 2 columns/],
    ['insert into t (a) values (1', /closing parenthesis/], ['insert into t (a) values (1,)', /empty value/], ['update t set a = 1', /only INSERT/], ['', /Enter an INSERT/],
    ['insert into t (a) values (1) garbage', /unexpected "garbage"/], ['insert into t default values', /no data/]]) {
    const r = sqlToJson(sql); assert.equal(r.ok, false, sql); assert.match(r.error, re, sql);
  }
});

// ---------- highlighter ----------
test('highlight segments round-trip the source and classify tokens', () => {
  const sql = "SELECT count(*), 'a''b', 12.5, \"Id\", :p FROM t -- note\nWHERE a >= 1 /* c */ AND b IN (1)";
  const segs = highlightSegments(sql);
  assert.equal(segs.map(s => s.text).join(''), sql);
  const cls = x => segs.find(s => s.text === x)?.cls;
  assert.equal(cls('SELECT'), 'kw'); assert.equal(cls('count'), 'fn'); assert.equal(cls("'a''b'"), 'str'); assert.equal(cls('12.5'), 'num');
  assert.equal(cls('"Id"'), 'idn'); assert.equal(cls(':p'), 'par'); assert.equal(cls('-- note'), 'com'); assert.equal(cls('/* c */'), 'com'); assert.equal(cls('>='), 'op');
  assert.ok(segs.some(s => s.cls === '' && s.text.includes(' t ')));
});
test('highlight: dialect aware strings, large input fallback, unterminated', () => {
  const my = highlightSegments("select 'a\\'b' from t", { dialect: 'mysql' });
  assert.equal(my.filter(s => s.cls === 'str').length, 1);
  const big = 'x'.repeat(400000);
  assert.equal(highlightSegments(big).length, 1);
  const un = highlightSegments("select 'abc");
  assert.equal(un.map(s => s.text).join(''), "select 'abc");
  assert.equal(highlightSegments('').length, 0);
});

console.log(`sql-analyzer: ${pass} passed`);
