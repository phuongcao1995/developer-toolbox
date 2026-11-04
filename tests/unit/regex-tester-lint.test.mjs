// Run: node tests/unit/regex-tester-lint.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/regex-tester/logic.js';

let pass = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const ids = (p, f = '') => L.lintRegex(p, f).map(x => x.id);
const find = (p, f, id) => L.lintRegex(p, f).find(x => x.id === id);

test('finding shape: id, severity, message, suggestion, range', () => {
  const f = find('[A-z]+', '', 'az-range');
  assert.ok(f); assert.equal(f.severity, 'warning'); assert.ok(f.message && f.suggestion);
  assert.equal('[A-z]+'.slice(f.start, f.end), 'A-z');
});
test('empty / junk input never throws', () => {
  assert.deepEqual(L.lintRegex(''), []);
  for (const p of ['(', ')', '[', '[a', '\\', '(?<', '{', '(?<n', '[]', '[^]', '\\k<', 'a{,', '(((', '|', '||']) assert.doesNotThrow(() => L.lintRegex(p, 'u'), p);
  assert.deepEqual(L.lintRegex(undefined), []);
});
test('[A-z] is flagged, [A-Za-z] is not', () => { assert.ok(ids('[A-z]').includes('az-range')); assert.ok(!ids('[A-Za-z_]').includes('az-range')); });
test('unescaped dot in domain / email / IP patterns', () => {
  assert.ok(ids('[\\w-]+@[\\w-]+.com').includes('unescaped-dot'));
  assert.ok(ids('^example.com$').includes('unescaped-dot'));
  assert.ok(ids('\\d{1,3}.\\d{1,3}.\\d{1,3}.\\d{1,3}').includes('unescaped-dot'));
  const f = find('^example.com$', '', 'unescaped-dot'); assert.equal(f.start, 8);
});
test('escaped dots and intentional dots are not flagged', () => {
  assert.ok(!ids('^example\\.com$').includes('unescaped-dot'));
  assert.ok(!ids('^\\d{1,3}\\.\\d{1,3}$').includes('unescaped-dot'));
  assert.ok(!ids('a.*b').includes('unescaped-dot'));
  assert.ok(!ids('[.]com').includes('unescaped-dot'));
});
test('validation pattern without anchors gets an info; anchored or global does not', () => {
  assert.ok(ids('[0-9]+abc').includes('missing-anchors'));
  assert.ok(!ids('^[0-9]+abc$').includes('missing-anchors'));
  assert.ok(!ids('[0-9]+abc', 'g').includes('missing-anchors'));
  assert.ok(!ids('\\bfoo[0-9]+\\b').includes('missing-anchors'));
  assert.equal(find('[0-9]+abc', '', 'missing-anchors').severity, 'info');
});
test('only-one-anchor is reported', () => {
  const f = find('^[0-9]+abc', '', 'missing-anchors'); assert.ok(f); assert.match(f.message, /end/);
  assert.match(find('[0-9]+abc$', '', 'missing-anchors').message, /start/);
});
test('top-level alternation with anchors', () => {
  assert.ok(ids('^a|b$').includes('anchor-alternation'));
  assert.ok(!ids('^(?:a|b)$').includes('anchor-alternation'));
});
test('greedy .* / .+ between delimiters suggests lazy or negated class', () => {
  const f = find('"(.*)"', 'g', 'greedy-between-delimiters');
  assert.ok(f); assert.match(f.suggestion, /\.\*\?/); assert.match(f.suggestion, /\[\^"\]/);
  assert.equal('"(.*)"'.slice(f.start, f.end), '.*');
  for (const p of ['<.+>', '\\(.*\\)', '\\[.*\\]', '\'.*\'', '\\{.*\\}']) assert.ok(ids(p, 'g').includes('greedy-between-delimiters'), p);
});
test('lazy, negated and non-delimiter dots are not flagged as greedy', () => {
  for (const p of ['"(.*?)"', '"([^"]*)"', 'a.*b', '^.*$', '\\s.*\\s', '[".*"]']) assert.ok(!ids(p, 'g').includes('greedy-between-delimiters'), p);
});
test('^/$ with the m flag get a note; without m they do not', () => {
  assert.ok(ids('^a+$', 'm').includes('multiline-anchors'));
  assert.ok(!ids('^a+$', '').includes('multiline-anchors'));
  assert.ok(!ids('a+', 'm').includes('multiline-anchors'));
});
test('\\d / \\w ASCII-only note', () => {
  const f = find('\\d+', 'g', 'ascii-shorthand'); assert.ok(f); assert.equal(f.severity, 'info'); assert.match(f.suggestion, /\\p\{Nd\}/);
  assert.match(find('\\w+', 'g', 'ascii-shorthand').message, /\\w/);
  assert.ok(!ids('[a-z]+', 'g').includes('ascii-shorthand'));
});
test('inline flags (?i) are an error with a flag suggestion', () => {
  const f = find('(?i)abc', '', 'inline-flags'); assert.ok(f); assert.equal(f.severity, 'error'); assert.match(f.suggestion, /"i"/);
  assert.equal(f.start, 0); assert.equal(f.end, 4);
  assert.ok(ids('(?i)a(?-s)b').filter(x => x === 'inline-flags').length === 2);
  assert.ok(!ids('(?i:abc)').includes('inline-flags'));
  assert.throws(() => new RegExp('(?i)abc')); // really is invalid
});
test('lookbehind support caveat', () => {
  assert.ok(ids('(?<=\\$)\\d+', 'g').includes('lookbehind-support'));
  assert.ok(ids('(?<!a)b', 'g').includes('lookbehind-support'));
  assert.ok(!ids('(?<year>\\d+)', 'g').includes('lookbehind-support'));
  assert.ok(!ids('(?=a)b', 'g').includes('lookbehind-support'));
});
test('\\b with non-ASCII text', () => {
  assert.ok(ids('\\bcaf\u00e9\\b', 'g').includes('boundary-non-ascii'));
  assert.ok(ids('\\b\\p{L}+\\b', 'gu').includes('boundary-non-ascii'));
  assert.ok(!ids('\\bcafe\\b', 'g').includes('boundary-non-ascii'));
});
test('backreference to a non-existent group', () => {
  const f = find('(a)\\2', '', 'bad-backreference'); assert.ok(f); assert.match(f.message, /only 1 capturing group/);
  assert.ok(ids('\\1').includes('bad-backreference'));
  assert.ok(!ids('(a)\\1').includes('bad-backreference'));
  assert.equal(find('(a)\\2', 'u', 'bad-backreference').severity, 'error');
});
test('named backreference to an unknown name', () => {
  assert.ok(ids('(?<a>x)\\k<b>').includes('bad-backreference'));
  assert.ok(!ids('(?<a>x)\\k<a>').includes('bad-backreference'));
});
test('empty alternation: a||b, (|a), (a|), leading and trailing |', () => {
  for (const p of ['a||b', '(|a)', '(a|)', '|a', 'a|', '(?:|a)']) assert.ok(ids(p).includes('empty-alternation'), p);
  for (const p of ['a|b', '(a|b)', '\\|a', '[|]a', 'a\\|']) assert.ok(!ids(p).includes('empty-alternation'), p);
  assert.equal(find('a||b', '', 'empty-alternation').start, 2);
});
test('quantifier on a lookaround', () => {
  assert.ok(ids('(?=a)+').includes('quantified-lookaround'));
  assert.equal(find('(?=a)+', 'u', 'quantified-lookaround').severity, 'error');
  assert.equal(find('(?=a)*', '', 'quantified-lookaround').severity, 'warning');
  assert.equal(find('(?<=a)?b', '', 'quantified-lookaround').severity, 'error');
  assert.ok(!ids('(?:(?=a))?b').includes('quantified-lookaround'));
  assert.ok(!ids('(a)+').includes('quantified-lookaround'));
});
test('unnecessary escapes are info without u and errors with u', () => {
  assert.equal(find('\\@', '', 'unnecessary-escape').severity, 'info');
  assert.equal(find('\\@', 'u', 'unnecessary-escape').severity, 'error');
  assert.throws(() => new RegExp('\\@', 'u'));
  assert.equal(find('\\e', '', 'unnecessary-escape').severity, 'warning');
  for (const p of ['\\.', '\\/', '\\d', '\\n', '\\$', '\\\\', '\\(\\)', '\\u00e9', '\\x41', '\\*']) assert.ok(!ids(p, 'u').includes('unnecessary-escape'), p);
});
test('catastrophic backtracking hint reuses analyzeRisk', () => {
  const f = find('(a+)+$', '', 'backtracking'); assert.ok(f); assert.equal(f.severity, 'warning');
  assert.ok(f.start >= 0 && '(a+)+$'.slice(f.start, f.end) === '(a+)');
  assert.ok(!ids('^\\d+$').includes('backtracking'));
});
test('duplicate characters in a class', () => {
  const f = find('[aab]', '', 'duplicate-class-char'); assert.ok(f); assert.equal('[aab]'.slice(f.start, f.end), 'a'); assert.equal(f.start, 2);
  assert.ok(ids('[\\d\\d]').includes('duplicate-class-char'));
  assert.ok(!ids('[abc]').includes('duplicate-class-char'));
  assert.ok(!ids('[a-ca-c]').includes('duplicate-class-char'));
});
test('{,n} is literal in JavaScript', () => {
  const f = find('a{,3}', '', 'comma-quantifier'); assert.ok(f); assert.match(f.suggestion, /\{0,3\}/);
  assert.equal(L.buildRegex('a{,3}', '').regex.test('a{,3}'), true);
  assert.ok(!ids('a{1,3}').includes('comma-quantifier'));
  assert.equal(find('a{,3}', 'u', 'comma-quantifier').severity, 'error');
});
test('\\1 inside a class is not a backreference', () => {
  assert.ok(ids('(a)[\\1]').includes('backref-in-class'));
  assert.ok(!ids('(a)\\1').includes('backref-in-class'));
});
test('\\p{...} without the u flag', () => {
  assert.ok(ids('\\p{L}+', 'g').includes('unicode-property-no-u'));
  assert.ok(!ids('\\p{L}+', 'gu').includes('unicode-property-no-u'));
});
test('empty class and pipe in class', () => {
  assert.ok(ids('a[]b').includes('empty-class'));
  assert.ok(ids('[a|b|c]').includes('pipe-in-class'));
  assert.ok(!ids('[|]').includes('pipe-in-class'));
});
test('findings are sorted by position and positions are in range', () => {
  const p = '(?i)[A-z]+@x.com[aab]';
  const list = L.lintRegex(p);
  assert.ok(list.length >= 4);
  let last = -1;
  for (const f of list) if (f.start !== undefined) { assert.ok(f.start >= last); last = f.start; assert.ok(f.end > f.start && f.end <= p.length); }
});
test('every bundled example and a clean pattern are free of errors', () => {
  for (const ex of L.EXAMPLES) assert.ok(!L.lintRegex(ex.pattern, ex.flags).some(f => f.severity === 'error'), ex.name);
  assert.deepEqual(L.lintRegex('^[A-Za-z]+$', ''), []);
});

for (const { name, fn } of queue) {
  try { await fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}
console.log(`regex-tester-lint: ${pass}/${queue.length} passed`);
