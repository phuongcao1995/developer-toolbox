// Run: node tests/unit/text-pad.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/text-pad/logic.js';

const test = (name, fn) => { try { fn(); } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };

test('empty text', () => {
  const s = L.textStats('');
  assert.deepEqual([s.words, s.chars, s.lines, s.paragraphs, s.sentences], [0, 0, 0, 0, 0]);
});
test('word, char and line counts', () => {
  const s = L.textStats('Hello  world.\nSecond line!');
  assert.equal(s.words, 4); assert.equal(s.lines, 2); assert.equal(s.chars, 26); assert.equal(s.charsNoSpaces, 22);
  assert.equal(s.sentences, 2);
});
test('paragraphs split on blank lines', () => assert.equal(L.textStats('a\n\nb\n\n\nc').paragraphs, 3));
test('chars count code points, not UTF-16 units', () => assert.equal(L.textStats('a😀b').chars, 3));
test('CRLF lines', () => assert.equal(L.textStats('a\r\nb\r\nc').lines, 3));
test('formatDuration', () => {
  assert.equal(L.formatDuration(0), '0 min'); assert.equal(L.formatDuration(0.3), '<1 min');
  assert.equal(L.formatDuration(3.2), '3 min'); assert.equal(L.formatDuration(65), '1 h 5 min');
});
test('case transforms', () => {
  assert.equal(L.TRANSFORMS.upper('abc'), 'ABC');
  assert.equal(L.TRANSFORMS.title('hELLO big wORLD'), 'Hello Big World');
  assert.equal(L.TRANSFORMS.sentence('hello there. how ARE you?\nfine'), 'Hello there. How are you?\nFine');
});
test('line transforms', () => {
  assert.equal(L.TRANSFORMS['sort-lines']('b\na\nc'), 'a\nb\nc');
  assert.equal(L.TRANSFORMS['unique-lines']('a\nb\na'), 'a\nb');
  assert.equal(L.TRANSFORMS['reverse-lines']('1\n2\n3'), '3\n2\n1');
  assert.equal(L.TRANSFORMS['remove-blank-lines']('a\n\n  \nb'), 'a\nb');
  assert.equal(L.TRANSFORMS.trim('a  \nb\t\n\n'), 'a\nb');
  assert.equal(L.TRANSFORMS['collapse-spaces']('a   b \t c'), 'a b c');
});
test('applyTransform on selection and whole text', () => {
  const sel = L.applyTransform('upper', 'abc def ghi', 4, 7);
  assert.equal(sel.text, 'abc DEF ghi'); assert.deepEqual([sel.selStart, sel.selEnd], [4, 7]);
  assert.equal(L.applyTransform('upper', 'abc').text, 'ABC');
  assert.throws(() => L.applyTransform('nope', 'x'));
});
test('suggestFileName', () => {
  assert.equal(L.suggestFileName(''), 'text-pad.txt');
  assert.equal(L.suggestFileName('\n# My Notes: Day 1?\nbody'), 'My-Notes-Day-1.txt');
  assert.equal(L.suggestFileName('a/b\\c'), 'abc.txt');
});
