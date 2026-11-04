// Run: node tests/unit/sql-formatter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { formatSql, minifySql, tokenize, tokenStream, sqlWarnings, sqlStats, SQL_DIALECTS, isSqlKeyword, isSqlFunction, isSqlType } from '../../tools/sql-formatter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const strings = (sql, dialect) => tokenize(sql, { dialect }).filter(t => t.type === 'string').map(t => t.text);

test('mysql: backslash-escaped quote stays inside the literal, ; not split', () => {
  const sql = "select 'a\\'b;c' from t";
  assert.deepEqual(strings(sql, 'mysql'), ["'a\\'b;c'"]);
  const out = formatSql(sql, { dialect: 'mysql' });
  assert.equal(out, "SELECT\n  'a\\'b;c'\nFROM t");
  assert.equal(sqlWarnings(sql, { dialect: 'mysql' }).length, 0);
  assert.equal(formatSql(out, { dialect: 'mysql' }), out); // idempotent
});
test('standard: backslash is a normal char, so \'a\\\' is a complete string', () => {
  const sql = "select 'a\\' from t";
  assert.deepEqual(strings(sql, 'standard'), ["'a\\'"]);
  assert.equal(formatSql(sql), "SELECT\n  'a\\'\nFROM t");
  assert.equal(sqlWarnings(sql).length, 0);
  for (const d of ['postgresql', 'sqlserver', 'sqlite', 'oracle']) assert.deepEqual(strings(sql, d), ["'a\\'"], d);
});
test('standard: doubled quote still escapes', () => {
  assert.deepEqual(strings("select 'it''s'", 'standard'), ["'it''s'"]);
  assert.deepEqual(strings("select 'it''s'", 'mysql'), ["'it''s'"]);
});
test('bigquery: backslash escapes, double-quoted strings, triple quotes', () => {
  assert.deepEqual(strings('select "a\\"b;c", \'x\\\'y\'', 'bigquery'), ['"a\\"b;c"', "'x\\'y'"]);
  assert.deepEqual(strings("select '''it's ; ok'''", 'bigquery'), ["'''it's ; ok'''"]);
});
test('mysql: "..." is a string, standard: identifier; backticks are identifiers', () => {
  assert.equal(tokenize('select "a"', { dialect: 'mysql' })[1].type, 'string');
  assert.equal(tokenize('select "a"', { dialect: 'standard' })[1].type, 'ident');
  assert.equal(tokenize('select `a b`', { dialect: 'mysql' })[1].type, 'ident');
});
test('mysql: # line comments; other dialects keep #temp names', () => {
  assert.equal(tokenize('select 1 # note\nfrom t', { dialect: 'mysql' })[2].type, 'lcomment');
  assert.equal(tokenize('select * from #tmp', { dialect: 'sqlserver' })[3].type, 'word');
});
test('t-sql bracket identifiers; postgres has none (array subscripts)', () => {
  assert.equal(tokenize('select [my col] from t', { dialect: 'sqlserver' })[1].type, 'ident');
  assert.notEqual(tokenize('select [my col] from t', { dialect: 'postgresql' })[1].type, 'ident');
});
test('postgres dollar quoting and E strings; sqlserver has no dollar quoting', () => {
  assert.deepEqual(strings("select $$a ' ; b$$, $f$x$f$", 'postgresql'), ['$$a \' ; b$$', '$f$x$f$']);
  assert.deepEqual(strings("select E'a\\'b;c'", 'postgresql'), ["E'a\\'b;c'"]);
  assert.deepEqual(strings("select E'a\\'", 'standard').length, 1);
  assert.equal(strings("select $$a$$", 'sqlserver').length, 0);
});
test('every dialect formats a basic query', () => {
  for (const d of Object.keys(SQL_DIALECTS)) assert.equal(formatSql('select a,b from t where x=1', { dialect: d }), 'SELECT\n  a,\n  b\nFROM t\nWHERE x = 1', d);
});
test('dialect keywords are recased only in their dialect', () => {
  assert.match(formatSql('select a from t straight_join u', { dialect: 'mysql' }), /STRAIGHT_JOIN/);
  assert.equal(formatSql('select dual from t', { dialect: 'standard' }).includes('dual'), true);
});

test('performance: 60000 columns format in < 1.5 s', () => {
  const sql = 'select ' + Array.from({ length: 60000 }, (_, i) => `c${i}`).join(', ') + ' from t where a = 1 and b = 2';
  const t0 = performance.now();
  const out = formatSql(sql);
  const ms = performance.now() - t0;
  console.log(`  60000 columns: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.equal(out.split('\n').length, 60000 + 4);
});

test('after "." a keyword is an identifier', () => {
  const out = formatSql('select a.select, t.from, x.where from t where a.and = 1', { keywordCase: 'upper' });
  assert.equal(out, 'SELECT\n  a.select,\n  t.from,\n  x.where\nFROM t\nWHERE a.and = 1');
  assert.equal(formatSql('SELECT t.FROM FROM t'), 'SELECT\n  t.FROM\nFROM t');
  assert.equal(formatSql('select * from s.order order by 1'), 'SELECT\n  *\nFROM s.order\nORDER BY 1');
  assert.equal(tokenize('a.select')[2].up, undefined);
});
test('unterminated string / comment give visible warnings', () => {
  const w = sqlWarnings("select 'abc\nfrom t");
  assert.equal(w.length, 1); assert.match(w[0], /Unterminated string literal starting at line 1, column 8/);
  assert.match(sqlWarnings('select 1 /* never closed')[0], /block comment/);
  assert.match(sqlWarnings('select "abc', { dialect: 'standard' })[0], /quoted identifier/);
  assert.match(sqlWarnings('select $$abc', { dialect: 'postgresql' })[0], /string literal/);
  assert.equal(sqlWarnings("select 'ok', \"id\" -- fine").length, 0);
  // the literal is left untouched
  assert.ok(formatSql("select 'abc  def").endsWith("'abc  def"));
});
test('minify keeps /*+ */ and --+ hints, drops other comments', () => {
  assert.equal(minifySql('select /*+ index(t i) */ a -- note\nfrom t'), 'select /*+ index(t i) */ a from t');
  assert.equal(minifySql('select --+ FULL(t)\n a from t -- bye'), 'select --+ FULL(t)\na from t');
  assert.equal(minifySql('select /*! SQL_NO_CACHE */ 1 /* x */'), 'select /*! SQL_NO_CACHE */ 1');
  assert.equal(minifySql("select 'a  b' ,  \"c  d\"  from  t"), "select 'a  b',\"c  d\" from t");
});
test('FOR UPDATE on its own line', () => {
  assert.equal(formatSql('select a from t where id = 1 for update'), 'SELECT\n  a\nFROM t\nWHERE id = 1\nFOR UPDATE');
  assert.equal(formatSql('select a from t for update of t nowait'), 'SELECT\n  a\nFROM t\nFOR UPDATE of t nowait');
  assert.equal(formatSql('select a from t for share'), 'SELECT\n  a\nFROM t\nFOR SHARE');
  assert.equal(formatSql('select a from t for no key update'), 'SELECT\n  a\nFROM t\nFOR NO KEY UPDATE');
  // not a locking clause outside queries
  assert.equal(formatSql('create trigger x on t for update as select 1').includes('\nFOR UPDATE'), false);
});
test('array[...] contents are not recased', () => {
  assert.equal(formatSql('select array[left, right], array[1,2] from t', { keywordCase: 'upper' }).includes('[left, right]'), true);
  assert.equal(formatSql('create table t (a int[], b text)').includes('int[]') || formatSql('create table t (a int[], b text)').includes('INT[]'), true);
});

test('format: existing behaviour intact (join, case, subquery)', () => {
  const out = formatSql("select u.id, case when u.x = 1 then 'a' else 'b' end as k from users u left join o on o.id = u.id where a between 1 and 2 and (b = 1 or c = 2) order by 1");
  assert.equal(out, "SELECT\n  u.id,\n  CASE\n    WHEN u.x = 1 THEN 'a'\n    ELSE 'b'\n  END AS k\nFROM users u\nLEFT JOIN o\n  ON o.id = u.id\nWHERE a BETWEEN 1 AND 2\n  AND (b = 1 OR c = 2)\nORDER BY 1");
  assert.equal(formatSql(out), out);
});
test('format preserves token stream (only keyword case changes)', () => {
  const sql = "select a.b, 'x\\y' , \"Q\" from t where c in (select 1) -- hi\n;";
  assert.deepEqual(tokenStream(formatSql(sql), { ignoreCase: true }), tokenStream(sql, { ignoreCase: true }));
  const my = "select 'a\\'b;c', \"d\\\"e\" from t";
  assert.deepEqual(tokenStream(formatSql(my, { dialect: 'mysql' }), { ignoreCase: true, dialect: 'mysql' }), tokenStream(my, { ignoreCase: true, dialect: 'mysql' }));
});
test('sqlStats honours dialect', () => {
  assert.equal(sqlStats("select 'a\\';b'", { dialect: 'mysql' }).statements, 1);
  assert.equal(sqlStats("select 'a\\';b'", { dialect: 'standard' }).statements, 2);
});

// ---------- formatting options: max width, comma-first, function case ----------
const nonSpace = s => s.replace(/\s+/g, '');
test('maxWidth: off by default, wraps long IN lists and keeps every token', () => {
  const sql = 'select a from t where id in (' + Array.from({ length: 40 }, (_, i) => i + 1).join(', ') + ')';
  const plain = formatSql(sql);
  assert.ok(plain.split('\n').some(l => l.length > 100));
  for (const w of [80, 100, 120]) {
    const out = formatSql(sql, { maxWidth: w });
    assert.ok(out.split('\n').every(l => l.length <= w), `width ${w}`);
    assert.ok(out.split('\n').length > plain.split('\n').length);
    assert.equal(nonSpace(out), nonSpace(plain));
    assert.equal(formatSql(out, { maxWidth: w }), out); // idempotent
  }
  assert.equal(formatSql(sql, { maxWidth: 0 }), plain);
});
test('maxWidth: function arguments, GROUP BY lists, strings with commas stay intact, tabs', () => {
  const sql = "select coalesce(aaaaaaaaaaaa, bbbbbbbbbbbbb, ccccccccccccc, ddddddddddddd, 'x, y, z', eeeeeeeeeee) as v from t group by aaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb, cccccccccccccccc, dddddddddddddddd, eeeeeeeeeeeeeeee";
  const out = formatSql(sql, { maxWidth: 60 });
  assert.ok(out.includes("'x, y, z'"));
  assert.ok(out.split('\n').every(l => l.length <= 60), out);
  assert.deepEqual(tokenStream(out, { ignoreCase: true }), tokenStream(sql, { ignoreCase: true }));
  const tabbed = formatSql(sql, { maxWidth: 60, indent: '\t' });
  assert.equal(nonSpace(tabbed), nonSpace(out));
  assert.equal(formatSql('select a, b from t', { maxWidth: 80 }), formatSql('select a, b from t')); // short lines unchanged
});
test('commaFirst: leading commas in select/set/with lists, default off, round-trips', () => {
  const sql = 'with a as (select 1), b as (select 2) select x, y, z from t group by x, y';
  const out = formatSql(sql, { commaFirst: true });
  assert.ok(out.includes('SELECT\n  x\n  , y\n  , z\nFROM t'), out);
  assert.ok(out.includes('\n, b AS ('), out);
  assert.ok(out.includes('GROUP BY x, y'));
  assert.ok(!formatSql(sql).includes('\n  , '));
  assert.deepEqual(tokenStream(out, { ignoreCase: true }), tokenStream(sql, { ignoreCase: true }));
  assert.equal(formatSql(out, { commaFirst: true }), out);
  assert.equal(formatSql('update t set a = 1, b = 2', { commaFirst: true }), 'UPDATE t\nSET\n  a = 1\n  , b = 2');
  assert.ok(formatSql('create table t (a int, b int)', { commaFirst: true }).includes('\n  , b INT'));
  assert.equal(formatSql('select f(a, b), c from t', { commaFirst: true }), 'SELECT\n  f(a, b)\n  , c\nFROM t'.replace('f(', 'F(').replace('F(', 'f('));
  assert.ok(formatSql('select a, -- c\n b from t', { commaFirst: true }).includes('-- c'));
  assert.equal(formatSql('select a, b from t', { commaFirst: false }), 'SELECT\n  a,\n  b\nFROM t');
});
test('functionCase: auto / upper / lower / preserve (keywords unaffected)', () => {
  const sql = 'Select Count(*), lower(Name), myFunc(x), Coalesce(a, b) from t where x In (1) and Not Exists (select 1)';
  const auto = formatSql(sql);
  assert.ok(auto.includes('COUNT(*)') && auto.includes('LOWER(Name)') && auto.includes('myFunc(x)') && auto.includes('COALESCE(a, b)'));
  assert.equal(formatSql(sql, { functionCase: 'auto' }), auto);
  const lower = formatSql(sql, { functionCase: 'lower' });
  assert.ok(lower.includes('count(*)') && lower.includes('lower(Name)') && lower.includes('coalesce(a, b)') && lower.includes('myFunc(x)'));
  assert.ok(lower.includes('SELECT') && lower.includes('WHERE x IN (1)') && lower.includes('NOT EXISTS ('));
  const upper = formatSql(sql, { functionCase: 'upper', keywordCase: 'lower' });
  assert.ok(upper.includes('COUNT(*)') && upper.includes('COALESCE(a, b)') && upper.includes('select') && upper.includes('where x in (1)'));
  const keep = formatSql(sql, { functionCase: 'preserve' });
  assert.ok(keep.includes('Count(*)') && keep.includes('Coalesce(a, b)') && keep.includes('SELECT'));
  assert.ok(formatSql('select count(*) from t', { keywordCase: 'preserve', functionCase: 'upper' }).includes('COUNT(*)'));
  assert.ok(formatSql('select t.count (x) from t', { functionCase: 'lower' }).includes('t.count'));
  assert.deepEqual(tokenStream(lower, { ignoreCase: true }), tokenStream(sql, { ignoreCase: true }));
});
test('options combine and stay idempotent', () => {
  const sql = "select a, b, coalesce(c, d, e, f, g, h, i, j, k, l, m, n) from t where x in (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25) order by a, b";
  const o = { maxWidth: 80, commaFirst: true, functionCase: 'lower', keywordCase: 'lower' };
  const out = formatSql(sql, o);
  assert.equal(formatSql(out, o), out);
  assert.ok(out.split('\n').every(l => l.length <= 80));
  assert.deepEqual(tokenStream(out, { ignoreCase: true }), tokenStream(sql, { ignoreCase: true }));
});
test('vocabulary helpers exported for the analyser', () => {
  assert.equal(isSqlKeyword('SELECT'), true); assert.equal(isSqlKeyword('FOO'), false);
  assert.equal(isSqlKeyword('STRAIGHT_JOIN', 'mysql'), true); assert.equal(isSqlKeyword('STRAIGHT_JOIN', 'standard'), false);
  assert.equal(isSqlFunction('COUNT'), true); assert.equal(isSqlType('INT'), true);
});

console.log(`sql-formatter: ${pass} passed`);
