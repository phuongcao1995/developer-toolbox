// Run: node tests/unit/editor-core.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as C from '../../assets/js/components/editor-core.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const apply = (v, ed) => C.applyEditToString(v, ed);
/** Apply an edit and return the document with the selection shown as [ ] (or | for a caret). */
const show = (v, ed) => {
  const t = apply(v, ed);
  return ed.selStart === ed.selEnd ? t.slice(0, ed.selStart) + '|' + t.slice(ed.selStart)
    : t.slice(0, ed.selStart) + '[' + t.slice(ed.selStart, ed.selEnd) + ']' + t.slice(ed.selEnd);
};

// ---------- lines ----------
test('countLines / lineStarts', () => {
  assert.equal(C.countLines(''), 1); assert.equal(C.countLines('a\nb'), 2); assert.equal(C.countLines('a\n'), 2); assert.equal(C.countLines('\n\n'), 3);
  assert.deepEqual([...C.lineStarts('ab\n\ncd')], [0, 3, 4]);
  const st = C.lineStarts('ab\n\ncd');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(p => C.lineIndexAt(st, p)), [0, 0, 0, 1, 2, 2, 2]);
  assert.equal(C.lineOfOffset('ab\ncd\nef', 4), 1); assert.equal(C.lineOfOffset('ab\ncd\nef', 3), 1); assert.equal(C.lineOfOffset('ab\ncd', 2), 0);
});
test('lineBounds', () => {
  assert.deepEqual(C.lineBounds('ab\ncd\nef', 4, 4), [3, 5]);
  assert.deepEqual(C.lineBounds('ab\ncd\nef', 1, 4), [0, 5]);
  assert.deepEqual(C.lineBounds('ab\ncd\nef', 0, 3), [0, 2]); // selection ending at a line start excludes that line
  assert.deepEqual(C.lineBounds('\nab', 0, 0), [0, 0]);
  assert.deepEqual(C.lineBounds('', 0, 0), [0, 0]);
});
test('lineSelection', () => {
  assert.deepEqual(C.lineSelection('ab\ncd\nef', 1), { start: 3, end: 6 });
  assert.deepEqual(C.lineSelection('ab\ncd\nef', 2), { start: 6, end: 8 });
  assert.equal(C.lineSelection('ab', 3), null); assert.equal(C.lineSelection('ab', -1), null);
});
test('gutterText / digits / window', () => {
  assert.equal(C.gutterText(0, 3), '1\n2\n3'); assert.equal(C.gutterText(8, 11), '9\n10\n11'); assert.equal(C.gutterText(5, 5), '');
  assert.equal(C.gutterDigits(1), 1); assert.equal(C.gutterDigits(99999), 5); assert.equal(C.gutterDigits(100000), 6); assert.equal(C.gutterDigits(0), 1);
  const w = C.computeWindow({ scrollTop: 400, viewHeight: 200, lineHeight: 20, padTop: 10, lineCount: 1000, buffer: 5 });
  assert.equal(w.vis0, 19); assert.equal(w.vis1, 30); assert.equal(w.start, 14); assert.equal(w.end, 35);
  assert.ok(C.windowCovers(w, 20, 30)); assert.ok(!C.windowCovers(w, 10, 30)); assert.ok(!C.windowCovers(null, 0, 1));
  const top = C.computeWindow({ scrollTop: 0, viewHeight: 100, lineHeight: 20, lineCount: 3, buffer: 40 });
  assert.deepEqual([top.start, top.end], [0, 3]);
  const past = C.computeWindow({ scrollTop: 1e6, viewHeight: 100, lineHeight: 20, lineCount: 10 });
  assert.ok(past.end <= 10 && past.start >= 0 && past.vis0 <= 9);
  assert.ok(C.overGutterLimit(3 * 1024 * 1024, 10)); assert.ok(C.overGutterLimit(10, 200001)); assert.ok(!C.overGutterLimit(1000, 1000));
});
test('clamp helpers', () => {
  assert.equal(C.clamp(5, 0, 3), 3); assert.equal(C.clamp(-1, 0, 3), 0); assert.equal(C.clamp(NaN, 2, 3), 2); assert.equal(C.clamp(Infinity, 0, 3), 0);
  assert.equal(C.clampFontSize(5), 10); assert.equal(C.clampFontSize(99), 24); assert.equal(C.clampFontSize('14'), 14); assert.equal(C.clampFontSize(13.6), 14); assert.equal(C.clampFontSize('x'), 10);
  assert.equal(C.clampHeight(10), 120); assert.equal(C.clampHeight(99999), 4000);
});

// ---------- indent / outdent ----------
test('tab: caret inserts a unit', () => assert.equal(show('ab', C.tabEdit('ab', 1, 1, { unit: '  ' })), 'a  |b'));
test('tab: tab unit', () => assert.equal(show('ab', C.tabEdit('ab', 2, 2, { unit: '\t' })), 'ab\t|'));
test('tab: multi-line selection indents every non-blank line, keeps selection', () => {
  const v = 'a\n\nb\nc';
  assert.equal(show(v, C.tabEdit(v, 0, 6, { unit: '  ' })), '[  a\n\n  b\n  c]'); // a selection starting at a line start stays before the indent
});
test('indent: selection start at line start covers the indent', () => {
  const v = 'a\nb'; const ed = C.indentEdit(v, 0, 3, '  ');
  assert.equal(apply(v, ed), '  a\n  b'); assert.deepEqual([ed.selStart, ed.selEnd], [0, 7]);
});
test('indent: mid-line selection start shifts by one unit', () => {
  const v = 'abc\ndef'; const ed = C.indentEdit(v, 1, 5, '  ');
  assert.equal(apply(v, ed), '  abc\n  def'); assert.deepEqual([ed.selStart, ed.selEnd], [3, 9]);
});
test('indent: selection ending at next line start excludes that line', () => {
  const v = 'a\nb'; assert.equal(apply(v, C.indentEdit(v, 0, 2, '  ')), '  a\nb');
});
test('indent: single non-empty selection indents the line, never replaces the text', () => {
  const v = 'hello'; assert.equal(apply(v, C.tabEdit(v, 1, 3, { unit: '  ' })), '  hello');
});
test('indent: all blank lines -> null from indentEdit, tab falls back to inserting', () => {
  assert.equal(C.indentEdit('\n\n', 0, 2, '  '), null);
  assert.equal(apply('\n\n', C.tabEdit('\n\n', 0, 2, { unit: '  ' })), '  ');
});
test('indent: CRLF', () => {
  const v = 'a\r\n\r\nb\r\n'; assert.equal(apply(v, C.indentEdit(v, 0, 7, '\t')), '\ta\r\n\r\n\tb\r\n');
});
test('outdent: tabs, spaces up to unit, partial', () => {
  const v = '\ta\n    b\n c\nd'; const ed = C.outdentEdit(v, 0, v.length, '  ');
  assert.equal(apply(v, ed), 'a\n  b\nc\nd');
});
test('outdent: tab unit removes up to 4 spaces', () => assert.equal(apply('      x', C.outdentEdit('      x', 6, 6, '\t')), '  x'));
test('outdent: caret on a line outdents it and keeps caret', () => {
  const v = '    ab'; const ed = C.tabEdit(v, 5, 5, { shift: true, unit: '  ' });
  assert.equal(show(v, ed), '  a|b');
});
test('outdent: nothing to remove -> null', () => { assert.equal(C.tabEdit('ab', 1, 1, { shift: true }), null); assert.equal(C.outdentEdit('a\nb', 0, 3), null); });
test('outdent: caret inside the removed indent collapses to the edit point', () => assert.equal(show('    ab', C.outdentEdit('    ab', 1, 1, '  ')), '|  ab'));
test('outdent: CRLF', () => assert.equal(apply('  a\r\n  b', C.outdentEdit('  a\r\n  b', 0, 8, '  ')), 'a\r\nb'));
test('indent then outdent is identity (random docs)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 200; k++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ' '.repeat(Math.floor(rnd() * 3)) + 'x'.repeat(1 + Math.floor(rnd() * 3)));
    const v = lines.join('\n');
    const a = Math.floor(rnd() * (v.length + 1)), b = Math.floor(rnd() * (v.length + 1));
    const s = Math.min(a, b), e = Math.max(a, b);
    const ed = C.indentEdit(v, s, e, '  ');
    if (!ed) continue;
    const v2 = apply(v, ed);
    const back = C.outdentEdit(v2, ed.selStart, ed.selEnd, '  ');
    assert.equal(apply(v2, back), v, JSON.stringify({ v, s, e }));
  }
});

// ---------- Enter / auto-indent ----------
test('enter: keeps indentation', () => assert.equal(show('  ab', C.enterEdit('  ab', 4, 4)), '  ab\n  |'));
test('enter: no indent, nothing special -> null (browser default)', () => assert.equal(C.enterEdit('ab', 2, 2), null));
test('enter: extra level after {', () => assert.equal(show('{', C.enterEdit('{', 1, 1)), '{\n  |'));
test('enter: extra level after [ and ( with trailing spaces', () => {
  assert.equal(show('  f(  ', C.enterEdit('  f(  ', 6, 6, { unit: '\t' })), '  f(  \n  \t|');
});
test('enter: splits an empty pair into three lines', () => {
  assert.equal(show('{}', C.enterEdit('{}', 1, 1)), '{\n  |\n}');
  assert.equal(show('  []', C.enterEdit('  []', 3, 3, { unit: '    ' })), '  [\n      |\n  ]');
});
test('enter: pair split only when the closer matches', () => assert.equal(show('{)', C.enterEdit('{)', 1, 1)), '{\n  |)'));
test('enter: replaces the selection', () => assert.equal(show('{ab}', C.enterEdit('{ab}', 1, 3)), '{\n  |\n}'));
test('enter: colon option', () => {
  assert.equal(C.enterEdit('if x:', 5, 5), null);
  assert.equal(show('if x:', C.enterEdit('if x:', 5, 5, { colon: true })), 'if x:\n  |');
});
test('enter: tags option splits <div></div> and skips void / self-closing tags', () => {
  assert.equal(show('<div></div>', C.enterEdit('<div></div>', 5, 5, { tags: true })), '<div>\n  |\n</div>');
  assert.equal(show('<ul class="a">', C.enterEdit('<ul class="a">', 14, 14, { tags: true })), '<ul class="a">\n  |');
  assert.equal(C.enterEdit('<br>', 4, 4, { tags: true }), null);
  assert.equal(C.enterEdit('<img src="a"/>', 14, 14, { tags: true }), null);
  assert.equal(C.enterEdit('<div>', 5, 5, {}), null);
});
test('enter: CRLF eol option', () => assert.equal(apply('{', C.enterEdit('{', 1, 1, { eol: '\r\n' })), '{\r\n  '));
test('enter: caret mid-line keeps the tail', () => assert.equal(show('  ab', C.enterEdit('  ab', 3, 3)), '  a\n  |b'));

// ---------- auto-close ----------
test('autoclose: inserts pairs before whitespace/end/closer', () => {
  assert.equal(show('', C.autoCloseEdit('', 0, 0, '(')), '(|)');
  assert.equal(show('a ', C.autoCloseEdit('a ', 2, 2, '{')), 'a {|}');
  assert.equal(show('(x)', C.autoCloseEdit('(x)', 2, 2, '[')), '(x[|])');
});
test('autoclose: not before a word character', () => assert.equal(C.autoCloseEdit('ab', 0, 0, '('), null));
test('autoclose: quotes not after word chars (apostrophes) or backslash', () => {
  assert.equal(C.autoCloseEdit("don", 3, 3, "'"), null);
  assert.equal(C.autoCloseEdit('\\', 1, 1, '"'), null);
  assert.equal(show('x = ', C.autoCloseEdit('x = ', 4, 4, '"')), 'x = "|"');
});
test('autoclose: types over an existing closer', () => {
  const ed = C.autoCloseEdit('()', 1, 1, ')'); assert.equal(ed.caretOnly, true); assert.equal(ed.selStart, 2); assert.equal(apply('()', ed), '()');
  const q = C.autoCloseEdit('""', 1, 1, '"'); assert.equal(q.caretOnly, true);
});
test('autoclose: wraps a selection and keeps it selected', () => assert.equal(show('abc', C.autoCloseEdit('abc', 0, 3, '"')), '"[abc]"'));
test('autoclose: closer with no match, non-pair keys -> null', () => { assert.equal(C.autoCloseEdit('a', 1, 1, ')'), null); assert.equal(C.autoCloseEdit('a', 1, 1, 'x'), null); assert.equal(C.autoCloseEdit('abc', 0, 3, 'x'), null); });
test('autoclose: backspace deletes an empty pair', () => {
  assert.equal(show('()', C.autoCloseBackspace('()', 1, 1)), '|');
  assert.equal(C.autoCloseBackspace('(x)', 1, 1), null); assert.equal(C.autoCloseBackspace('()', 1, 2), null); assert.equal(C.autoCloseBackspace('', 0, 0), null);
  assert.equal(show('a""b', C.autoCloseBackspace('a""b', 2, 2)), 'a|b');
});

// ---------- comments ----------
const LINE = { line: '//' }, BLOCK = { block: ['<!--', '-->'] }, CSS = { block: ['/*', '*/'] };
test('comment tokens per language', () => {
  assert.deepEqual(C.commentTokens('javascript'), LINE); assert.deepEqual(C.commentTokens('js'), LINE); assert.deepEqual(C.commentTokens('ts'), LINE);
  assert.deepEqual(C.commentTokens('css'), CSS); assert.deepEqual(C.commentTokens('html'), BLOCK); assert.deepEqual(C.commentTokens('svg'), BLOCK);
  assert.deepEqual(C.commentTokens('python'), { line: '#' }); assert.deepEqual(C.commentTokens('sql'), { line: '--' }); assert.deepEqual(C.commentTokens('yaml'), { line: '#' });
  assert.equal(C.commentTokens('json'), null); assert.equal(C.commentTokens('plain'), null); assert.equal(C.commentTokens('nonsense'), null); assert.equal(C.commentTokens(undefined), null);
});
test('language config', () => {
  assert.equal(C.languageConfig('json').autoClose, true); assert.equal(C.languageConfig('plain').autoClose, false); assert.equal(C.languageConfig('html').tags, true);
  assert.equal(C.languageConfig('yaml').colon, true); assert.equal(C.languageConfig('JS').name, 'javascript'); assert.equal(C.languageConfig('x').name, 'plain');
});
test('line comment: comment at the shallowest indent, uncomment round trip', () => {
  const v = '  a\n    b\n\n  c';
  const ed = C.toggleCommentEdit(v, 0, v.length, LINE);
  const c = apply(v, ed);
  assert.equal(c, '  // a\n  //   b\n\n  // c');
  const back = C.toggleCommentEdit(c, 0, c.length, LINE);
  assert.equal(apply(c, back), v);
});
test('line comment: mixed lines get commented (not toggled off)', () => {
  const v = '// a\nb'; assert.equal(apply(v, C.toggleCommentEdit(v, 0, v.length, LINE)), '// // a\n// b');
});
test('line comment: uncomment without the space', () => assert.equal(apply('//a', C.toggleCommentEdit('//a', 0, 3, LINE)), 'a'));
test('line comment: caret only affects its line and stays on the same character', () => {
  const v = 'a\nbcd\ne'; assert.equal(show(v, C.toggleCommentEdit(v, 4, 4, LINE)), 'a\n// bc|d\ne');
});
test('line comment: blank-only selection -> null; no token -> null', () => { assert.equal(C.toggleCommentEdit('\n\n', 0, 2, LINE), null); assert.equal(C.toggleCommentEdit('a', 0, 1, null), null); });
test('line comment: python hash and sql dashes', () => {
  assert.equal(apply('x = 1', C.toggleCommentEdit('x = 1', 0, 0, { line: '#' })), '# x = 1');
  assert.equal(apply('-- a\n-- b', C.toggleCommentEdit('-- a\n-- b', 0, 9, { line: '--' })), 'a\nb');
});
test('block comment (html/css) per line and round trip', () => {
  const h = '<p>x</p>\n  <i>y</i>';
  const c = apply(h, C.toggleCommentEdit(h, 0, h.length, BLOCK));
  assert.equal(c, '<!-- <p>x</p> -->\n<!--   <i>y</i> -->');
  assert.equal(apply(c, C.toggleCommentEdit(c, 0, c.length, BLOCK)), h);
  const s = 'a { b: c }';
  const cc = apply(s, C.toggleCommentEdit(s, 0, 0, CSS));
  assert.equal(cc, '/* a { b: c } */'); assert.equal(apply(cc, C.toggleCommentEdit(cc, 0, 0, CSS)), s);
});
test('block comment: trailing whitespace and CRLF are preserved outside the markers', () => {
  const v = 'a  \r\nb'; const c = apply(v, C.toggleCommentEdit(v, 0, v.length, BLOCK));
  assert.equal(c, '<!-- a -->  \r\n<!-- b -->');
  assert.equal(apply(c, C.toggleCommentEdit(c, 0, c.length, BLOCK)), v);
});

// ---------- line operations ----------
test('duplicate line: caret keeps column on the copy', () => {
  assert.equal(show('ab\ncd', C.duplicateLineEdit('ab\ncd', 1, 1)), 'ab\na|b\ncd');
  assert.equal(show('ab', C.duplicateLineEdit('ab', 2, 2)), 'ab\nab|');
});
test('duplicate line: multi-line selection and CRLF', () => {
  assert.equal(show('a\nb\nc', C.duplicateLineEdit('a\nb\nc', 0, 3)), 'a\nb\n[a\nb]\nc');
  assert.equal(apply('a\r\nb\r\n', C.duplicateLineEdit('a\r\nb\r\n', 0, 0)), 'a\r\na\r\nb\r\n');
});
test('move line up/down', () => {
  assert.equal(show('a\nb\nc', C.moveLinesEdit('a\nb\nc', 2, 2, -1)), '|b\na\nc');
  assert.equal(show('a\nb\nc', C.moveLinesEdit('a\nb\nc', 2, 2, 1)), 'a\nc\n|b');
  assert.equal(C.moveLinesEdit('a\nb', 0, 0, -1), null); assert.equal(C.moveLinesEdit('a\nb', 2, 2, 1), null); assert.equal(C.moveLinesEdit('a', 0, 0, 1), null);
});
test('move lines: multi-line block and CRLF', () => {
  assert.equal(apply('a\nb\nc\nd', C.moveLinesEdit('a\nb\nc\nd', 2, 5, -1)), 'b\nc\na\nd');
  assert.equal(apply('a\r\nb\r\nc\r\n', C.moveLinesEdit('a\r\nb\r\nc\r\n', 0, 0, 1)), 'b\r\na\r\nc\r\n');
  assert.equal(apply('a\r\nb\r\nc\r\n', C.moveLinesEdit('a\r\nb\r\nc\r\n', 3, 3, -1)), 'b\r\na\r\nc\r\n');
});
test('move line: down then up is identity', () => {
  const v = 'one\ntwo\nthree'; const d = C.moveLinesEdit(v, 5, 5, 1); const v2 = apply(v, d);
  assert.equal(apply(v2, C.moveLinesEdit(v2, d.selStart, d.selEnd, -1)), v);
});
test('delete line', () => {
  assert.equal(show('a\nb\nc', C.deleteLineEdit('a\nb\nc', 2, 2)), 'a\n|c');
  assert.equal(show('a\nb\nc', C.deleteLineEdit('a\nb\nc', 4, 4)), 'a\nb|');
  assert.equal(show('a', C.deleteLineEdit('a', 1, 1)), '|');
  assert.equal(apply('a\nb\nc\nd', C.deleteLineEdit('a\nb\nc\nd', 2, 5)), 'a\nd');
});
test('trimEdit removes the unchanged prefix/suffix and never splits surrogates', () => {
  const v = 'hello world'; const t = C.trimEdit(v, { from: 0, to: 11, text: 'hello brave world', selStart: 0, selEnd: 0 });
  assert.equal(apply(v, t), 'hello brave world'); assert.ok(t.to - t.from <= 1);
  const e = '\u{1F600}x'; const t2 = C.trimEdit(e, { from: 0, to: 3, text: '\u{1F601}x', selStart: 0, selEnd: 0 });
  assert.equal(apply(e, t2), '\u{1F601}x');
  assert.equal(apply('a\ud83d\ude00', C.trimEdit('a\ud83d\ude00', { from: 0, to: 3, text: 'a\ud83d\ude01' })), 'a\ud83d\ude01');
  const same = C.trimEdit('abc', { from: 0, to: 3, text: 'abc' }); assert.equal(same.text, ''); assert.equal(same.from, same.to);
});

// ---------- find / replace ----------
const F = (text, q, o = {}, limit) => C.findAll(text, o, q, limit);
test('find: plain, case, regex metacharacters are literal', () => {
  assert.equal(F('aAa', 'a').matches.length, 3); assert.equal(F('aAa', 'a', { caseSensitive: true }).matches.length, 2);
  assert.equal(F('a.b a+b', 'a.b').matches.length, 1); assert.equal(F('(x) (x)', '(x)').matches.length, 2); assert.equal(F('a/b', 'a/b').matches.length, 1);
});
test('find: whole word', () => {
  assert.equal(F('cat concat cat_ cat', 'cat', { wholeWord: true }).matches.length, 2);
  assert.equal(F('naïve cafe café', 'caf', { wholeWord: true }).matches.length, 0);
  assert.equal(F('über über_x', 'über', { wholeWord: true }).matches.length, 1);
  assert.equal(F('a1 a', 'a', { wholeWord: true }).matches.length, 1);
});
test('find: regex, groups, multiline anchors', () => {
  assert.equal(F('a1 b22 c333', '\\d+', { regex: true }).matches.length, 3);
  assert.deepEqual(F('x\ny\nz', '^.$', { regex: true }).matches.map(m => m.index), [0, 2, 4]);
  assert.equal(F('foo bar', '(?<w>\\w+)', { regex: true }).matches.length, 2);
});
test('find: invalid regex -> error, no throw', () => {
  const r = F('abc', '(', { regex: true }); assert.ok(r.error && r.error.length > 0); assert.deepEqual(r.matches, []);
  assert.ok(F('abc', '[', { regex: true }).error); assert.ok(F('abc', '*', { regex: true }).error); assert.ok(F('abc', '\\', { regex: true }).error);
  assert.equal(C.compileFind('(', { regex: true }).re, null);
});
test('find: legacy escapes still work (identity escape without u flag)', () => assert.equal(F('a-b', 'a\\-b', { regex: true }).matches.length, 1));
test('find: empty query -> nothing', () => { assert.deepEqual(F('abc', '').matches, []); assert.equal(F('abc', '').error, null); });
test('find: zero-length matches terminate and are counted per position', () => {
  assert.equal(F('abc', '', { regex: true }).matches.length, 0);
  assert.equal(F('abc', 'x*', { regex: true }).matches.length, 4);
  assert.equal(F('', 'x*', { regex: true }).matches.length, 1);
  assert.equal(F('a\n\nb', '^$', { regex: true }).matches.length, 1);
});
test('find: surrogate pairs are never split', () => {
  const t = 'a\u{1F600}b\u{1F600}';
  assert.deepEqual(F(t, '\u{1F600}').matches, [{ index: 1, length: 2 }, { index: 4, length: 2 }]);
  assert.deepEqual(F(t, '.', { regex: true }).matches.map(m => m.length), [1, 2, 1, 2]);
  const e = F(t, 'x*', { regex: true }).matches.map(m => m.index); assert.deepEqual(e, [0, 1, 3, 4, 6]); // never 2 or 5 (mid pair)
  assert.equal(F('\u{1F600}', '\\u{1F600}', { regex: true }).matches.length, 1);
});
test('find: cap and capped flag', () => {
  const r = F('a'.repeat(50), 'a', {}, 10); assert.equal(r.matches.length, 10); assert.equal(r.capped, true);
  const s = F('a'.repeat(10), 'a', {}, 10); assert.equal(s.matches.length, 10); assert.equal(s.capped, false);
  assert.equal(F('a'.repeat(20000), 'a').matches.length, 10000); assert.equal(F('a'.repeat(20000), 'a').capped, true);
});
test('find: step next/prev with wrap', () => {
  const t = 'ab ab ab', o = {};
  assert.deepEqual(C.stepFind(t, o, 'ab', { start: 0, end: 0 }, 1), { index: 0, length: 2, wrapped: false });
  assert.deepEqual(C.stepFind(t, o, 'ab', { start: 0, end: 2 }, 1), { index: 3, length: 2, wrapped: false });
  assert.deepEqual(C.stepFind(t, o, 'ab', { start: 6, end: 8 }, 1), { index: 0, length: 2, wrapped: true });
  assert.deepEqual(C.stepFind(t, o, 'ab', { start: 3, end: 5 }, -1), { index: 0, length: 2, wrapped: false });
  assert.deepEqual(C.stepFind(t, o, 'ab', { start: 0, end: 2 }, -1), { index: 6, length: 2, wrapped: true });
  assert.equal(C.stepFind(t, o, 'zz', { start: 0, end: 0 }, 1), null); assert.equal(C.stepFind(t, o, 'zz', { start: 0, end: 0 }, -1), null);
  assert.equal(C.stepFind(t, o, '', { start: 0, end: 0 }, 1), null); assert.equal(C.stepFind(t, { regex: true }, '(', { start: 0, end: 0 }, 1), null);
});
test('find: stepping over empty regex matches advances', () => {
  let sel = { start: 0, end: 0 }; const seen = [];
  for (let k = 0; k < 5; k++) { const m = C.stepFind('ab', { regex: true }, 'x*', sel, 1); seen.push(m.index); sel = { start: m.index, end: m.index + m.length }; }
  assert.deepEqual(seen, [1, 2, 0, 1, 2]); // a match at the caret itself is skipped so Enter always moves
});
test('find: single match wraps to itself', () => assert.deepEqual(C.stepFind('xay', {}, 'a', { start: 1, end: 2 }, 1), { index: 1, length: 1, wrapped: true }));
test('count label', () => {
  assert.equal(C.describeCount({ query: 'a', total: 12, current: 2 }), '3 of 12');
  assert.equal(C.describeCount({ query: 'a', total: 12, current: -1 }), '12 found');
  assert.equal(C.describeCount({ query: 'a', total: 10000, capped: true, current: -1 }), '10,000+ found');
  assert.equal(C.describeCount({ query: 'a', total: 10000, capped: true, current: 4 }), '5 of 10,000+');
  assert.equal(C.describeCount({ query: 'a', total: 0 }), 'No results'); assert.equal(C.describeCount({ query: '' }), '');
  assert.match(C.describeCount({ query: '(', error: 'Unterminated group' }), /Invalid regex: Unterminated group/);
});
test('currentMatchIndex', () => {
  const m = F('ab ab ab', 'ab').matches;
  assert.equal(C.currentMatchIndex(m, 3, 5), 1); assert.equal(C.currentMatchIndex(m, 3, 4), -1); assert.equal(C.currentMatchIndex(m, 1, 3), -1); assert.equal(C.currentMatchIndex([], 0, 0), -1);
});
test('replace current: plain is literal, regex expands tokens', () => {
  assert.deepEqual(C.replaceMatchEdit('a.b', {}, '.', '$1', 1, 2), { from: 1, to: 2, text: '$1', selStart: 3, selEnd: 3 });
  assert.equal(C.replaceMatchEdit('John Smith', { regex: true }, '(\\w+) (\\w+)', '$2, $1', 0, 10).text, 'Smith, John');
  assert.equal(C.replaceMatchEdit('abc', { regex: true }, 'b', '[$&][$$][$`][$\']', 1, 2).text, '[b][$][a][c]');
  assert.equal(C.replaceMatchEdit('x-y', { regex: true }, '(?<a>x)', '<$<a>>', 0, 1).text, '<x>');
  assert.equal(C.replaceMatchEdit('x', { regex: true }, 'x', '$3', 0, 1).text, '$3'); // unknown group stays literal
  assert.equal(C.replaceMatchEdit('abc', {}, 'b', 'X', 0, 2), null); assert.equal(C.replaceMatchEdit('abc', {}, 'b', 'X', 0, 1), null);
});
test('replace all: counts, case, regex, minimal edit span', () => {
  const r = C.replaceAllEdit('a-a-a', {}, 'a', 'bb'); assert.equal(r.count, 3); assert.equal(apply('a-a-a', r.edit), 'bb-bb-bb');
  const m = C.replaceAllEdit('xxaxxaxx', {}, 'a', '_'); assert.equal(apply('xxaxxaxx', m.edit), 'xx_xx_xx'); assert.equal(m.edit.from, 2); assert.equal(m.edit.to, 6);
  assert.equal(apply('A a', C.replaceAllEdit('A a', { caseSensitive: true }, 'a', 'x').edit), 'A x');
  assert.equal(apply('k1=v1', C.replaceAllEdit('k1=v1', { regex: true }, '(\\w)(\\d)=', '$2$1=').edit), '1k=v1');
  assert.equal(C.replaceAllEdit('abc', {}, 'z', 'x').edit, null); assert.equal(C.replaceAllEdit('abc', {}, '', 'x').count, 0);
  assert.ok(C.replaceAllEdit('abc', { regex: true }, '(', 'x').error);
});
test('replace all: empty matches terminate and surrogates stay intact', () => {
  assert.equal(apply('ab', C.replaceAllEdit('ab', { regex: true }, 'x*', '-').edit), '-a-b-');
  const t = '\u{1F600}'; assert.equal(apply(t, C.replaceAllEdit(t, { regex: true }, 'x*', '-').edit), '-\u{1F600}-');
  assert.equal(apply('a\u{1F600}a', C.replaceAllEdit('a\u{1F600}a', {}, '\u{1F600}', '.').edit), 'a.a');
});
test('replace all: whole word and delete', () => {
  assert.equal(apply('cat concat cat', C.replaceAllEdit('cat concat cat', { wholeWord: true }, 'cat', 'dog').edit), 'dog concat dog');
  assert.equal(apply('a b a', C.replaceAllEdit('a b a', {}, ' a', '').edit), 'a b');
});

// ---------- files ----------
test('checkTextFile', () => {
  assert.equal(C.checkTextFile({ name: 'a.json', size: 10, type: 'application/json' }).ok, true);
  assert.equal(C.checkTextFile({ name: 'a.txt', size: 10, type: '' }).ok, true);
  assert.equal(C.checkTextFile({ name: 'a.png', size: 10, type: 'image/png' }).ok, false);
  assert.equal(C.checkTextFile({ name: 'a.pdf', size: 10, type: '' }).ok, false);
  assert.equal(C.checkTextFile({ name: 'a.xlsx', size: 10, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).ok, false);
  const big = C.checkTextFile({ name: 'a.txt', size: 6 * 1048576 }); assert.equal(big.ok, false); assert.match(big.reason, /too large/);
  assert.equal(C.checkTextFile({ name: 'a.txt', size: 3 * 1048576 }, 2 * 1048576).ok, false);
  assert.equal(C.hasNul('a\u0000b'), true); assert.equal(C.hasNul('ab'), false); assert.equal(C.hasNul(null), false);
});

// ---------- split / resize math ----------
test('clampRatio / ratioFromPointer / stepRatio', () => {
  assert.equal(C.clampRatio(0.5, 1008, 120, 8), 0.5);
  assert.ok(Math.abs(C.clampRatio(0, 1008, 120, 8) - 0.12) < 1e-9); assert.ok(Math.abs(C.clampRatio(1, 1008, 120, 8) - 0.88) < 1e-9);
  assert.equal(C.clampRatio(0.1, 200, 120, 8), 0.5); assert.equal(C.clampRatio(NaN, 1000), 0.5); assert.equal(C.clampRatio(0.3, 0, 120), 0.5);
  assert.equal(C.ratioFromPointer(504, 0, 1008, 8), 0.5); assert.equal(C.ratioFromPointer(104, 100, 1008, 8), 0); assert.equal(C.ratioFromPointer(5, 0, 0), 0.5);
  assert.ok(Math.abs(C.stepRatio(0.5, 100, 1008, 8) - 0.6) < 1e-9); assert.equal(C.stepRatio(0.5, 10, 0), 0.5);
  assert.equal(C.ratioToPercent(0.456), 46);
  // drag far past either end stays inside the clamp
  for (const p of [-1e6, -5, 0, 1e6]) { const r = C.clampRatio(C.ratioFromPointer(p, 0, 1008), 1008); assert.ok(r >= 0.12 - 1e-9 && r <= 0.88 + 1e-9); }
});

// ---------- highlighters ----------
const join = segs => segs.map(s => s.text).join('');
const types = (segs, t) => segs.filter(s => s.type === t).map(s => s.text);
test('json highlighter', () => {
  const t = '{"a": [1, -2.5e+3, true, null], "b\\"c": "x", /* c */ // d\n}';
  const s = C.highlightJson(t);
  assert.equal(join(s), t);
  assert.deepEqual(types(s, 'property'), ['"a"', '"b\\"c"']); assert.deepEqual(types(s, 'string'), ['"x"']);
  assert.deepEqual(types(s, 'number'), ['1', '-2.5e+3']); assert.deepEqual(types(s, 'keyword'), ['true', 'null']); assert.equal(types(s, 'comment').length, 2);
});
test('json highlighter: unterminated string stops at the newline', () => {
  const s = C.highlightJson('"abc\n123'); assert.equal(join(s), '"abc\n123'); assert.deepEqual(types(s, 'string'), ['"abc']); assert.deepEqual(types(s, 'number'), ['123']);
});
test('css highlighter', () => {
  const t = '@media (min-width: 10px) { .a > b:hover { color: #fff; margin: -2px 0 !important; background: url("x.png"); } }\n/* c */';
  const s = C.highlightCss(t);
  assert.equal(join(s), t);
  assert.ok(types(s, 'keyword').includes('@media')); assert.ok(types(s, 'keyword').includes('!important'));
  assert.ok(types(s, 'property').includes('color')); assert.ok(types(s, 'property').includes('margin'));
  assert.ok(types(s, 'attribute').includes('.a')); assert.ok(types(s, 'attribute').includes(':hover')); assert.ok(types(s, 'tag').includes('b'));
  assert.ok(types(s, 'number').includes('#fff')); assert.ok(types(s, 'number').includes('-2px')); assert.ok(types(s, 'function').includes('url'));
  assert.deepEqual(types(s, 'comment'), ['/* c */']);
});
test('css highlighter: pseudo selector in a rules context is not a property', () => {
  const s = C.highlightCss('a:hover { color: red }'); assert.ok(!types(s, 'property').includes('a')); assert.deepEqual(types(s, 'property'), ['color']);
});
test('css highlighter: unbalanced braces never throw', () => { assert.equal(join(C.highlightCss('}}}} { { a')), '}}}} { { a'); });
test('html highlighter', () => {
  const t = '<!DOCTYPE html>\n<!-- hi -->\n<div class="a b" id=x data-k=\'v\' hidden>Tom &amp; Jerry<br/></div>';
  const s = C.highlightHtml(t);
  assert.equal(join(s), t);
  assert.deepEqual(types(s, 'comment'), ['<!-- hi -->']); assert.ok(types(s, 'keyword').includes('<!DOCTYPE html>')); assert.ok(types(s, 'keyword').includes('&amp;'));
  assert.deepEqual(types(s, 'attribute'), ['class', 'id', 'data-k', 'hidden']); assert.ok(types(s, 'string').includes('"a b"')); assert.ok(types(s, 'string').includes('x'));
  assert.ok(types(s, 'tag').includes('<div')); assert.ok(types(s, 'tag').some(x => x.includes('</div')));
});
test('html highlighter: embedded script/style/json', () => {
  const t = '<style>a { color: red }</style><script>const x = 1; // c\n</script><script type="application/json">{"k": 1}</script><script type="text/template"><b></script>';
  const s = C.highlightHtml(t);
  assert.equal(join(s), t);
  assert.ok(types(s, 'property').includes('color')); assert.ok(types(s, 'keyword').includes('const')); assert.ok(types(s, 'property').includes('"k"'));
  assert.ok(types(s, 'comment').includes('// c'));
});
test('html highlighter: unterminated constructs', () => {
  for (const t of ['<div', '<div class="a', '<!-- x', '<![CDATA[ x', '<script>var', '<', '<<>>', '&', '& x', '<a href=', '</']) assert.equal(join(C.highlightHtml(t)), t, t);
});
test('js highlighter', () => {
  const t = 'const re = /a[/]b/gi, n = 0x1F + 1_0.5e-3; // end\nfunction f(a) { return a / 2 / 3; }\nlet s = `x ${y}`, q = \'it\\\'s\';';
  const s = C.highlightJs(t);
  assert.equal(join(s), t);
  assert.deepEqual(types(s, 'regexp'), ['/a[/]b/gi']); assert.ok(types(s, 'keyword').includes('const')); assert.ok(types(s, 'keyword').includes('return'));
  assert.ok(types(s, 'function').includes('f')); assert.ok(types(s, 'number').includes('0x1F')); assert.ok(types(s, 'number').includes('1_0.5e-3'));
  assert.deepEqual(types(s, 'comment'), ['// end']); assert.ok(types(s, 'string').includes('`x ${y}`')); assert.ok(types(s, 'string').includes("'it\\'s'"));
  assert.equal(types(s, 'regexp').length, 1); // `a / 2 / 3` is division
});
test('js highlighter: regex after return, keyword after dot is a plain property', () => {
  const s = C.highlightJs('return /x/.test(y); a.class = 1;'); assert.deepEqual(types(s, 'regexp'), ['/x/']);
  assert.deepEqual(types(s, 'keyword'), ['return']);
});
test('js highlighter: unterminated pieces', () => {
  for (const t of ['"abc', '\'a\\', '`abc ${', '/* x', '// x', '/abc', 'a = /', '1e', '0x', '.', '..5', '@', '#', '\\']) assert.equal(join(C.highlightJs(t)), t, t);
});
test('getHighlighter', () => {
  assert.equal(C.getHighlighter('json'), C.highlightJson); assert.equal(C.getHighlighter('js'), C.highlightJs); assert.equal(C.getHighlighter('scss'), C.highlightCss);
  assert.equal(C.getHighlighter('svg'), C.highlightHtml); assert.equal(C.getHighlighter('plain'), null); assert.equal(C.getHighlighter('nope'), null);
});
test('segments: only known types, no empty segments, adjacent types merged', () => {
  for (const h of [C.highlightJson, C.highlightJs, C.highlightCss, C.highlightHtml]) {
    const s = h('{"a": 1} a { b: c } <a b="c">d</a> var x = 1;\n');
    for (let i = 0; i < s.length; i++) { assert.ok(C.SYNTAX_TYPES.includes(s[i].type), s[i].type); assert.ok(s[i].text.length > 0); if (i) assert.notEqual(s[i].type, s[i - 1].type); }
  }
});
test('highlighters: round trip on 500 random strings each (fuzz)', () => {
  let seed = 12345; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const alphabet = ['{', '}', '[', ']', '(', ')', '"', "'", '`', '/', '*', '\\', '<', '>', '!', '-', '=', ':', ';', ',', '.', '#', '@', '&', '$', '%', ' ', '\n', '\r\n', '\t', 'a', 'Z', '_', '0', '9', 'e', 'x', 'é', '\u{1F600}', '\ud83d', '\ude00', '\u0000', '</script', '<script>', '<style>', '/*', '*/', '//', '<!--', '-->', '<![CDATA[', 'true', 'null', 'return ', 'function ', '@media ', '!important', '\u2028'];
  for (const [name, h] of [['json', C.highlightJson], ['js', C.highlightJs], ['css', C.highlightCss], ['html', C.highlightHtml]]) {
    for (let k = 0; k < 500; k++) {
      const len = rnd(60); let t = '';
      for (let i = 0; i < len; i++) t += alphabet[rnd(alphabet.length)];
      assert.equal(join(h(t)), t, `${name}: ${JSON.stringify(t)}`);
    }
  }
});
test('highlighters: empty and whitespace-only input', () => {
  for (const h of [C.highlightJson, C.highlightJs, C.highlightCss, C.highlightHtml]) { assert.deepEqual(h(''), []); assert.equal(join(h('  \n\t ')), '  \n\t '); }
});
test('highlighters: linear time on pathological input (200 KB)', () => {
  const cases = ['"'.repeat(200000), '/*'.repeat(100000), '<a '.repeat(66000), '\\'.repeat(200000), '{'.repeat(200000), '/'.repeat(200000), '<script>'.repeat(25000), 'a'.repeat(200000), '1e+'.repeat(60000)];
  for (const [name, h] of [['json', C.highlightJson], ['js', C.highlightJs], ['css', C.highlightCss], ['html', C.highlightHtml]]) {
    for (const t of cases) { const t0 = performance.now(); const s = h(t); const dt = performance.now() - t0; assert.equal(join(s).length, t.length); assert.ok(dt < 1500, `${name} ${t.slice(0, 6)} ${dt.toFixed(0)}ms`); }
  }
});
test('sliceSegments covers an arbitrary window exactly', () => {
  const t = '{"a": [1, 2, {"b": null}],\n "c": "d"}\n'.repeat(5); const segs = C.highlightJson(t); const off = C.segmentOffsets(segs);
  assert.equal(off[segs.length], t.length);
  for (const [a, b] of [[0, 0], [0, 5], [3, 40], [10, t.length], [t.length - 3, t.length], [0, t.length], [7, 8]]) assert.equal(join(C.sliceSegments(segs, off, a, b)), t.slice(a, b), `${a}-${b}`);
  let seed = 3; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let k = 0; k < 200; k++) { const a = rnd(t.length), b = a + rnd(t.length - a + 1); assert.equal(join(C.sliceSegments(segs, off, a, b)), t.slice(a, b)); }
  assert.deepEqual(C.sliceSegments([], new Uint32Array(1), 0, 5), []);
});

console.log(`editor-core: ${pass} tests passed`);
