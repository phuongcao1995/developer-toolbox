// Run: node tests/unit/regex-tester-export.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as X from '../../tools/regex-tester/exporters.js';

let pass = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });

test('JavaScript: literal with flags sorted, slashes escaped once', () => {
  assert.match(X.toJavaScript('a/b', 'ig').code, /const re = \/a\\\/b\/gi;/);
  assert.match(X.toJavaScript('a\\/b', 'g').code, /\/a\\\/b\/g;/); // already escaped: not doubled
  assert.match(X.toJavaScript('\\d+', '').code, /\/\\d\+\/;/);
});
test('JavaScript: the generated literal round-trips through RegExp', () => {
  for (const p of ['a/b', 'https?:\\/\\/x', 'line1\nline2', 'tab\there', '"q"\'s', '[/]', '\\\\', 'caf\u00e9 \ud83d\ude00']) {
    const code = X.toJavaScript(p, 'gu').code;
    const m = /const re = \/(.*)\/([a-z]*);/.exec(code);
    assert.ok(m, p);
    const orig = new RegExp(p, 'gu'), gen = new RegExp(m[1], m[2]);
    for (const t of ['a/b', 'line1\nline2', 'tab\there', '"q"\'s', '/', '\\', 'café 😀']) assert.deepEqual(t.match(gen), t.match(orig), p + ' on ' + JSON.stringify(t));
  }
  // a raw newline must not appear in the generated source
  assert.ok(!X.toJavaScript('a\nb', '').code.split('\n')[0].includes('\n') && X.toJavaScript('a\nb', '').code.includes('a\\nb'));
});
test('JavaScript: empty pattern becomes (?:)', () => { assert.match(X.toJavaScript('', '').code, /\(\?:\)/); });

test('Python: raw string, flags, named groups rewritten', () => {
  assert.match(X.toPython('\\d+\\.\\d+', 'im').code, /re\.compile\(r"\\d\+\\\.\\d\+", re\.IGNORECASE \| re\.MULTILINE\)/);
  const n = X.toPython('(?<year>\\d{4})-\\k<year>', 'g');
  assert.match(n.code, /\(\?P<year>/); assert.match(n.code, /\(\?P=year\)/);
  assert.ok(n.notes.some(x => /finditer|findall/.test(x)));
});
test('Python: quotes and trailing backslash avoid broken raw strings', () => {
  assert.match(X.toPython('say "hi"', '').code, /r'say "hi"'/);
  const both = X.toPython('"\'', '').code; assert.match(both, /compile\("\\"'"\)/);
  const trailing = X.toPython('a\\\\', '').code; assert.match(trailing, /r"a\\\\"/); // even number of backslashes is fine in a raw string
  const odd = X.toPython('a\\', '').code; assert.match(odd, /"a\\\\"/); assert.ok(!/r"a\\"/.test(odd));
  assert.match(X.toPython('a\nb', '').code, /r"a\\nb"/);
});
test('Python: Unicode note present', () => { assert.ok(X.toPython('\\d', '').notes.some(n => /re\.ASCII/.test(n))); });

test('PHP: delimiter slash escaped, modifiers, single-quoted string escaping', () => {
  assert.match(X.toPHP('a/b', 'iu').code, /\$pattern = '\/a\\\\\/b\/iu';/);
  assert.match(X.toPHP('\\d+', '').code, /'\/\\\\d\+\/'/);
  assert.match(X.toPHP("it's", '').code, /'\/it\\'s\/'/);
  assert.match(X.toPHP('a\\/b', '').code, /'\/a\\\\\/b\/'/); // already escaped slash is not doubled
  assert.match(X.toPHP('x', 'y').code, /\/A';/);
});
test('PHP: g flag noted and preg_match_all used', () => {
  const r = X.toPHP('a', 'g'); assert.match(r.code, /preg_match_all/); assert.ok(r.notes.some(n => /g:/.test(n)));
});

test('Java: double-escaped backslashes, quotes and control characters', () => {
  assert.match(X.toJava('\\d+\\.\\w', 'i').code, /Pattern\.compile\("\\\\d\+\\\\\.\\\\w", Pattern\.CASE_INSENSITIVE\)/);
  assert.match(X.toJava('say "hi"', '').code, /"say \\"hi\\""/);
  assert.match(X.toJava('a\nb', '').code, /"a\\\\nb"/); // newline normalised to the regex escape \n, then doubled
  assert.match(X.toJava('\\\\', '').code, /"\\\\\\\\"/);
  assert.match(X.toJava('caf\u00e9', '').code, /"caf\u00e9"/);
});
test('Java: group-name restriction warned', () => { assert.ok(X.toJava('(?<my_name>a)', '').warnings.length >= 1); assert.equal(X.toJava('(?<name>a)', '').warnings.length, 0); });

test('Go: raw string; lookaround and backreference warnings (RE2)', () => {
  const a = X.toGo('(?=a)b', ''); assert.ok(a.warnings.some(w => /RE2/.test(w)) && /lookahead/.test(a.warnings[0]));
  assert.ok(X.toGo('(?<!a)b', '').warnings.length >= 1);
  assert.ok(X.toGo('(a)\\1', '').warnings.some(w => /backreference/.test(w)));
  assert.ok(X.toGo('(?<n>a)\\k<n>', '').warnings.some(w => /backreference/.test(w)));
  assert.equal(X.toGo('a+b', '').warnings.length, 0);
  assert.match(X.toGo('\\d+', 'i').code, /regexp\.MustCompile\(`\(\?i\)\\d\+`\)/);
});
test('Go: backtick in the pattern falls back to an interpreted string', () => {
  assert.match(X.toGo('a`b\\d"', '').code, /MustCompile\("a`b\\\\d\\""\)/);
});
test('Go: named groups rewritten to (?P<', () => { assert.match(X.toGo('(?<y>\\d)', '').code, /\(\?P<y>/); });

test('C#: verbatim string doubles quotes, keeps backslashes', () => {
  assert.match(X.toCSharp('\\d+ "x"', 'im').code, /new Regex\(@"\\d\+ ""x""", RegexOptions\.IgnoreCase \| RegexOptions\.Multiline\)/);
  assert.match(X.toCSharp('a\nb', '').code, /@"a\\nb"/);
});

test('every exporter returns {code, notes, warnings} and handles empty and odd input', () => {
  for (const e of X.EXPORTERS) {
    for (const [p, f] of [['', ''], ['a', 'dgimsuvy'], ['\\u{1F600}', 'u'], ['[\\]/]', 'g'], ['\ud83d\ude00', 'u']]) {
      const r = e.build(p, f);
      assert.equal(typeof r.code, 'string', e.id); assert.ok(Array.isArray(r.notes) && Array.isArray(r.warnings), e.id);
    }
  }
  assert.deepEqual(X.EXPORTERS.map(e => e.id), ['javascript', 'python', 'php', 'java', 'go', 'csharp']);
});
test('unicode and astral characters pass through unchanged', () => {
  for (const b of [X.toPython, X.toPHP, X.toJava, X.toGo, X.toCSharp]) assert.ok(b('caf\u00e9\ud83d\ude00', '').code.includes('caf\u00e9\ud83d\ude00'));
});

for (const { name, fn } of queue) {
  try { await fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}
console.log(`regex-tester-export: ${pass}/${queue.length} passed`);
