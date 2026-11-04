// Pure-logic tests for tools/markdown-editor/logic.js (front matter, TOC, lists, indent, find/replace, stats, scheduling).
import assert from 'node:assert/strict';
import {
  parseFrontMatter, buildToc, continueList, indentEdit, outdentEdit, findMatches, replaceAll, replaceAt,
  countStats, readingMinutes, renderDelay, validateImport, hasNul, interpolate, applyEdit, buildHtmlDocument, buildTocHtml,
} from '../../tools/markdown-editor/logic.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok -', name); };

// ----- front matter
t('front matter detected and stripped', () => {
  const r = parseFrontMatter('---\ntitle: Hi\ntags: [a]\n---\n# Body\n');
  assert.equal(r.raw, 'title: Hi\ntags: [a]');
  assert.equal(r.body, '# Body\n');
  assert.equal(r.lineOffset, 4);
  assert.equal(r.offset, '---\ntitle: Hi\ntags: [a]\n---\n'.length);
});
t('front matter: CRLF, BOM, empty block, "..." terminator', () => {
  assert.equal(parseFrontMatter('---\r\na: 1\r\n---\r\nx').body, 'x');
  assert.equal(parseFrontMatter('﻿---\na: 1\n---\nx').body, 'x');
  assert.equal(parseFrontMatter('---\n---\nx').raw, '');
  assert.equal(parseFrontMatter('---\na: 1\n...\nx').body, 'x');
});
t('front matter: not triggered by a leading rule or unterminated block', () => {
  assert.equal(parseFrontMatter('---\nJust prose here\n---\ntext').raw, null);
  assert.equal(parseFrontMatter('---\na: 1\nno end').raw, null);
  assert.equal(parseFrontMatter('text\n---\na: 1\n---\n').raw, null);
  assert.equal(parseFrontMatter('').raw, null);
});

// ----- TOC
t('toc: ATX headings with levels, lines and cleaned text', () => {
  const md = '# One\n\ntext\n## **Two** [link](x) ##\n###### Six\n';
  const toc = buildToc(md);
  assert.deepEqual(toc.map(h => [h.level, h.text, h.line]), [[1, 'One', 0], [2, 'Two link', 3], [6, 'Six', 4]]);
  assert.equal(md.slice(toc[1].offset, toc[1].offset + 3), '## ');
});
t('toc: skips fenced code and front matter', () => {
  const md = '---\ntitle: x\n# not a heading\n---\n# Real\n```sh\n# comment\n```\n~~~\n# also code\n~~~\n## After\n';
  assert.deepEqual(buildToc(md).map(h => h.text), ['Real', 'After']);
  assert.equal(buildToc(md)[0].line, 4);
});
t('toc: setext headings, not hr/list lines, "#hashtag" ignored', () => {
  const md = 'Title\n=====\n\nSub\n---\n\n- item\n---\n\n#hashtag\n';
  const toc = buildToc(md);
  assert.deepEqual(toc.map(h => [h.level, h.text]), [[1, 'Title'], [2, 'Sub']]);
});
t('toc: longer fence closes only with matching fence', () => {
  assert.deepEqual(buildToc('````\n```\n# x\n````\n# y').map(h => h.text), ['y']);
});

// ----- list continuation
const apply = (v, pos) => { const e = continueList(v, pos); return e && { v: applyEdit(v, e), pos: e.selStart }; };
t('list: bullet continues', () => { const r = apply('- a', 3); assert.equal(r.v, '- a\n- '); assert.equal(r.pos, 6); });
t('list: ordered increments, keeps delimiter and indent', () => { assert.equal(apply('  9) x', 6).v, '  9) x\n  10) '); });
t('list: task continues unchecked', () => { assert.equal(apply('- [x] done', 10).v, '- [x] done\n- [ ] '); });
t('list: empty item exits list', () => { const r = apply('- a\n- ', 6); assert.equal(r.v, '- a\n'); assert.equal(r.pos, 4); assert.equal(apply('1. ', 3).v, ''); });
t('list: caret mid-line splits, inside marker or non-list is default', () => {
  assert.equal(apply('* ab', 3).v, '* a\n* b');
  assert.equal(continueList('- a', 1), null);
  assert.equal(continueList('plain', 5), null);
  assert.equal(continueList('**bold** x', 10), null);
});

// ----- indent / outdent
t('indent multi-line selection, blank lines untouched', () => {
  const v = 'a\n\nb\nc';
  const e = indentEdit(v, 0, 5, '  ');
  assert.equal(applyEdit(v, e), '  a\n\n  b\nc');
  assert.deepEqual([e.selStart, e.selEnd], [0, 5 + 4]);
});
t('outdent removes tab or up to unit spaces', () => {
  const v = '    a\n\tb\n c\nd';
  const e = outdentEdit(v, 0, v.length, '  ');
  assert.equal(applyEdit(v, e), '  a\nb\nc\nd');
  assert.equal(e.selEnd, v.length - (2 + 1 + 1));
});
t('outdent: nothing to remove -> null; caret clamps', () => {
  assert.equal(outdentEdit('abc', 1, 1), null);
  const e = outdentEdit('  abc', 1, 1, '  ');
  assert.equal(applyEdit('  abc', e), 'abc');
  assert.equal(e.selStart, 0);
});

// ----- find / replace
t('find: literal, case and regex flags', () => {
  assert.equal(findMatches('Foo foo FOO', 'foo').matches.length, 3);
  assert.equal(findMatches('Foo foo FOO', 'foo', { caseSensitive: true }).matches.length, 1);
  assert.equal(findMatches('a.b axb', 'a.b').matches.length, 1);
  assert.equal(findMatches('a.b axb', 'a.b', { regex: true }).matches.length, 2);
  assert.equal(findMatches('x\ny', '^\\w$', { regex: true }).matches.length, 2);
});
t('find: invalid regex reports error; empty query; zero-length terminates; limit', () => {
  assert.ok(findMatches('a', '(', { regex: true }).error);
  assert.deepEqual(findMatches('abc', '').matches, []);
  assert.equal(findMatches('abc', 'x*', { regex: true }).matches.length, 4);
  assert.equal(findMatches('aaaa', 'a', {}, 2).matches.length, 2);
});
t('replaceAll: literal keeps $ verbatim; regex expands groups', () => {
  assert.deepEqual(replaceAll('a a', 'a', '$&$1'), { text: '$&$1 $&$1', count: 2, error: null });
  assert.equal(replaceAll('john smith', '(\\w+) (\\w+)', '$2, $1', { regex: true }).text, 'smith, john');
  assert.equal(replaceAll('ab', '(?<x>a)', '[$<x>]', { regex: true }).text, '[a]b');
  assert.equal(replaceAll('abc', '(', 'x', { regex: true }).error !== null, true);
  assert.equal(replaceAll('Aa', 'a', 'x', { caseSensitive: true }).text, 'Ax');
});
t('replaceAt: single replacement at index', () => {
  const e = replaceAt('foo bar foo', 'foo', 'X', {}, 8);
  assert.deepEqual(e, { from: 8, to: 11, text: 'X' });
  assert.equal(replaceAt('foo', 'foo', 'X', {}, 1), null);
  assert.equal(replaceAt('ab', '(a)(b)', '$2$1', { regex: true }, 0).text, 'ba');
});

// ----- stats / scheduling / validation / scroll
t('stats: words, chars, lines, reading time', () => {
  assert.deepEqual(countStats(''), { words: 0, chars: 0, lines: 0, minutes: 0 });
  const s = countStats('one two\nthree');
  assert.deepEqual([s.words, s.chars, s.lines, s.minutes], [3, 13, 2, 1]);
  assert.equal(readingMinutes(200), 1);
  assert.equal(readingMinutes(201), 2);
  assert.equal(countStats(Array(1000).fill('w').join(' ')).minutes, 5);
});
t('adaptive render delay', () => {
  assert.equal(renderDelay(10), 120);
  assert.equal(renderDelay(100 * 1024), 400);
  assert.equal(renderDelay(1024 * 1024 - 1), 400);
  assert.equal(renderDelay(1024 * 1024), null);
});
t('import validation', () => {
  assert.equal(validateImport({ name: 'a.md', size: 10 }).ok, true);
  assert.equal(validateImport({ name: 'a.TXT', size: 10 }).ok, true);
  assert.equal(validateImport({ name: 'a.png', size: 10, type: 'image/png' }).ok, false);
  assert.equal(validateImport({ name: 'a.md', size: 5 * 1024 * 1024 + 1 }).ok, false);
  assert.equal(validateImport({ name: 'x', size: 1, type: 'text/plain' }).ok, true);
  assert.equal(hasNul('a\u0000b'), true);
  assert.equal(hasNul('ab'), false);
});
t('interpolate maps through anchors', () => {
  const a = [[0, 0], [100, 300], [200, 400]];
  assert.equal(interpolate(a, 50), 150);
  assert.equal(interpolate(a, 150), 350);
  assert.equal(interpolate(a, -5), 0);
  assert.equal(interpolate(a, 999), 400);
  assert.equal(interpolate([[0, 0], [10, 5], [10, 7], [20, 9]], 10), 5);
  assert.equal(interpolate([], 7), 7);
});
t('html export: optional TOC, escaped, still self-contained', () => {
  const toc = [{ id: 'a', level: 2, text: 'A <b>' }, { id: 'b', level: 3, text: 'B' }];
  const d = buildHtmlDocument('T', '<h2 id="a">A</h2>', { toc });
  assert.ok(d.includes('<nav class="toc"') && d.includes('href="#a"') && d.includes('A &lt;b&gt;') && d.includes('class="l1"'));
  assert.ok(!buildHtmlDocument('T', '<p>x</p>').includes('<nav'));
  assert.ok(!/<link|src=["']http|@import|url\(http/i.test(d));
  assert.equal(buildTocHtml([]), '');
});

console.log(`${pass} passed`);
