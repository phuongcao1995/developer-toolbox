// Run: node tests/unit/code-beautifier.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/code-beautifier/logic.js';
let pass = 0;
const test = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };

test('inline gaps are collapsed to one space', () => {
  assert.equal(L.minifyHtml('<span>x</span>\n<span>y</span>'), '<span>x</span> <span>y</span>');
  assert.equal(L.minifyHtml('<p>a <b>b</b>\n   <i>c</i> d</p>'), '<p>a <b>b</b> <i>c</i> d</p>');
  assert.equal(L.minifyHtml('<a href="#">x</a>\n\n<button>y</button>'), '<a href="#">x</a> <button>y</button>');
});
test('gaps next to block tags are dropped', () => {
  assert.equal(L.minifyHtml('<div>\n  <p>x</p>\n  <p>y</p>\n</div>'), '<div><p>x</p><p>y</p></div>');
  assert.equal(L.minifyHtml('<ul>\n <li>a</li>\n <li>b</li>\n</ul>'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(L.minifyHtml('<p>  text  </p>'), '<p>text</p>');
});
test('pre / textarea / script / style preserved or minified', () => {
  const pre = '<pre>  a\n   b  </pre>';
  assert.equal(L.minifyHtml('<div>\n' + pre + '\n</div>'), '<div>' + pre + '</div>');
  const ta = '<textarea>\n  x\n</textarea>';
  assert.ok(L.minifyHtml('<p>' + ta + '</p>').includes(ta));
  assert.equal(L.minifyHtml('<style>\n a { color: red; }\n</style>'), '<style>a{color:red}</style>');
  assert.equal(L.minifyHtml('<script>\n var a = 1;\n // c\n</script>'), '<script>var a=1;</script>');
});
test('comments removed, conditional kept', () => {
  assert.equal(L.minifyHtml('<p>a</p><!-- gone --><p>b</p>'), '<p>a</p><p>b</p>');
  assert.ok(L.minifyHtml('<!--[if IE]><p>x</p><![endif]-->').includes('[if IE]'));
});
test('CSS refuses // line comments and scss/less dialect', () => {
  assert.throws(() => L.minifyCss('a { color: red; } // note\nb { top: 0 }'), /line comment/);
  assert.throws(() => L.minify('css', 'a{b:c}', { dialect: 'scss' }), /SCSS/);
  assert.throws(() => L.minify('css', 'a{b:c}', { dialect: 'less' }), /LESS/);
  assert.equal(L.minifyCss('a{background:url(//cdn.x/y.png)} b{content:"//"}'), 'a{background:url(//cdn.x/y.png)}b{content:"//"}');
  assert.equal(L.minify('css', 'a { b: c ; }'), 'a{b:c}');
});
test('detectCssDialect / names', () => {
  assert.equal(L.detectCssDialect('x.SCSS'), 'scss'); assert.equal(L.detectCssDialect('x.less'), 'less'); assert.equal(L.detectCssDialect('x.css'), null);
  assert.equal(L.detectLanguageByName('a.svg'), 'html');
});
test('content detection', () => {
  assert.equal(L.detectLanguageByContent('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'xml');
  assert.equal(L.detectLanguageByContent('<?xml version="1.0"?><a/>'), 'xml');
  assert.equal(L.detectLanguageByContent('{"a": 1,}'), 'json');
  assert.equal(L.detectLanguageByContent('{"a": 1}'), 'json');
  assert.equal(L.detectLanguageByContent('[1, 2,]'), 'json');
  assert.equal(L.detectLanguageByContent('[1,2].map(x => x)'), 'js');
  assert.equal(L.detectLanguageByContent('<div class="a">x</div>'), 'html');
  assert.equal(L.detectLanguageByContent('const a = 1;'), 'js');
  assert.equal(L.detectLanguageByContent('a { color: red; }'), 'css');
});
test('JS/JSON minify unchanged', () => {
  assert.equal(L.minifyJs('var a = 1;\n// c\nvar b = a + 2;'), 'var a=1;var b=a+2;');
  assert.equal(L.minifyJson('{ "a" : [1, 2] }'), '{"a":[1,2]}');
});
console.log(`code-beautifier: ${pass} passed`);
