// Run: node tests/unit/html-css-js-playground.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as L from '../../tools/html-css-js-playground/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const NONCE = 'abc123';

// ---------- nonce ----------
test('nonce is 32 hex chars', () => assert.match(L.makeNonce(), /^[0-9a-f]{32}$/));
test('nonce differs between calls', () => assert.notEqual(L.makeNonce(), L.makeNonce()));
test('nonce uses injected bytes', () => assert.equal(L.makeNonce(n => new Uint8Array(n).fill(255)), 'ff'.repeat(16)));

// ---------- escaping ----------
test('escapeInlineScript neutralises </script', () => {
  assert.ok(!/<\/script/i.test(L.escapeInlineScript('a</script>b</SCRIPT >')));
});
test('escapeInlineScript neutralises <!--', () => assert.ok(!L.escapeInlineScript('x = "<!--"').includes('<!--')));
test('escapeInlineScript keeps string value semantics', () => {
  assert.equal(vm.runInNewContext(L.escapeInlineScript('"</script>"')), '</script>');
});
test('escapeInlineStyle', () => assert.ok(!/<\/style/i.test(L.escapeInlineStyle('a{}</STYLE><script>'))));
test('escapeAttr', () => assert.equal(L.escapeAttr('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;'));
test('escape handles null', () => { assert.equal(L.escapeInlineScript(null), ''); assert.equal(L.escapeInlineStyle(undefined), ''); });

// ---------- CSP ----------
test('default CSP has no network and no external script/style', () => {
  const c = L.buildCsp(false);
  assert.ok(c.startsWith("default-src 'none'"));
  assert.ok(c.includes("img-src data: blob: https:"));
  assert.ok(c.includes("script-src 'unsafe-inline';"));
  assert.ok(!/script-src[^;]*https:/.test(c));
  assert.ok(!/connect-src/.test(c));
});
test('relaxed CSP allows https scripts and styles but still no connect', () => {
  const c = L.buildCsp(true);
  assert.match(c, /script-src 'unsafe-inline' https:/);
  assert.match(c, /style-src 'unsafe-inline' https:/);
  assert.ok(!/connect-src/.test(c));
  assert.ok(c.startsWith("default-src 'none'"));
});

// ---------- srcdoc ----------
const SRC = { html: '<h1>Hi</h1>', css: 'h1{color:red}', js: 'console.log(1)' };
test('srcdoc contains CSP meta before the bridge and user code', () => {
  const d = L.buildSrcdoc(SRC, { nonce: NONCE });
  const iCsp = d.indexOf('Content-Security-Policy'), iBridge = d.indexOf('__dtb'), iUser = d.indexOf('<h1>Hi</h1>');
  assert.ok(iCsp > 0 && iCsp < iBridge && iBridge < iUser);
});
test('srcdoc embeds the nonce as JSON string', () => assert.ok(L.buildSrcdoc(SRC, { nonce: NONCE }).includes('N = "abc123"')));
test('srcdoc places css in <style>, html in body, js in last script', () => {
  const d = L.buildSrcdoc(SRC, { nonce: NONCE });
  assert.ok(d.includes('<style>h1{color:red}</style>'));
  assert.ok(/<body>\n<h1>Hi<\/h1>\n<script>console\.log\(1\)<\/script>/.test(d));
});
test('srcdoc escapes </script in JS', () => {
  const d = L.buildSrcdoc({ ...SRC, js: 'var s="</script><b>"' }, { nonce: NONCE });
  assert.equal((d.match(/<\/script>/g) || []).length, 2); // bridge + user script only
});
test('srcdoc escapes </style in CSS', () => {
  const d = L.buildSrcdoc({ ...SRC, css: 'a{}</style><script>alert(1)</script>' }, { nonce: NONCE });
  assert.equal((d.match(/<\/style>/g) || []).length, 1);
});
test('srcdoc uses default CSP unless allowExternal', () => {
  assert.ok(L.buildSrcdoc(SRC, { nonce: NONCE }).includes(L.DEFAULT_CSP));
  assert.ok(L.buildSrcdoc(SRC, { nonce: NONCE, allowExternal: true }).includes(L.RELAXED_CSP));
});
test('srcdoc requires nonce', () => assert.throws(() => L.buildSrcdoc(SRC, {}), /nonce/));
test('srcdoc handles empty source', () => {
  const d = L.buildSrcdoc({}, { nonce: NONCE });
  assert.ok(d.includes('<style></style>') && d.startsWith('<!doctype html>'));
});
test('srcdoc keeps Unicode', () => assert.ok(L.buildSrcdoc({ html: '<p>日本語 😀</p>' }, { nonce: NONCE }).includes('日本語 😀')));
test('bridge origin: specific origin vs wildcard', () => {
  assert.ok(L.buildBridge('n', 'https://app.example').includes('O = "https://app.example"'));
  assert.ok(L.buildBridge('n', 'null').includes('O = "*"'));
  assert.ok(L.buildBridge('n').includes('O = "*"'));
});
test('nonce with special characters is JSON-escaped in bridge', () => {
  const b = L.buildBridge('a"b\\c', undefined);
  assert.doesNotThrow(() => new vm.Script(b));
});

// ---------- bridge behaviour (run the real bridge in a vm with stubs) ----------
function runBridge(nonce = NONCE) {
  const sent = [], listeners = {}, intervals = [];
  const consoleCalls = [];
  const win = {
    parent: { postMessage: (m, o) => sent.push({ m, o }) },
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  const ctx = vm.createContext({
    window: win, console: { log: (...a) => consoleCalls.push(['log', a]), info() {}, warn() {}, error() {}, debug() {} },
    setInterval: fn => { intervals.push(fn); return 1; }, JSON, Object, Array, String, Error,
  });
  ctx.window.window = win;
  vm.runInContext(L.buildBridge(nonce, 'https://app.example'), ctx);
  return { sent, listeners, intervals, ctx, consoleCalls };
}
test('bridge posts console.log with nonce and target origin', () => {
  const b = runBridge();
  vm.runInContext('console.log("hi", 42, {a:1})', b.ctx);
  assert.equal(b.sent.length, 1);
  assert.deepEqual({ ...b.sent[0].m }, { __dtb: NONCE, type: 'console', level: 'log', text: 'hi 42 {a: 1}' });
  assert.equal(b.sent[0].o, 'https://app.example');
  assert.equal(b.consoleCalls.length, 1); // still calls the original
});
test('bridge formats arrays, null, undefined, errors, functions', () => {
  const b = runBridge();
  vm.runInContext('console.warn([1,"a",null,undefined], function foo(){}, new Error("boom").message)', b.ctx);
  assert.equal(b.sent[0].m.level, 'warn');
  assert.equal(b.sent[0].m.text, '[1, "a", null, undefined] [Function: foo] boom');
});
test('bridge handles circular structures', () => {
  const b = runBridge();
  vm.runInContext('var o={}; o.self=o; console.error(o)', b.ctx);
  assert.match(b.sent[0].m.text, /\[Circular\]/);
});
test('bridge truncates huge output', () => {
  const b = runBridge();
  vm.runInContext('console.log("x".repeat(10000))', b.ctx);
  assert.ok(b.sent[0].m.text.length < 4100 && b.sent[0].m.text.endsWith('[truncated]'));
});
test('bridge reports window errors and rejections', () => {
  const b = runBridge();
  b.listeners.error({ message: 'oops', lineno: 3, colno: 9 });
  b.listeners.unhandledrejection({ reason: new vm.runInContext('Error', b.ctx)('nope') });
  assert.equal(b.sent[0].m.type, 'error'); assert.equal(b.sent[0].m.line, 3);
  assert.match(b.sent[1].m.message, /Unhandled promise rejection: /);
});
test('bridge sends ready on load and starts heartbeat', () => {
  const b = runBridge();
  b.listeners.load();
  assert.equal(b.sent.at(-1).m.type, 'ready');
  assert.equal(b.intervals.length, 1);
  b.intervals[0]();
  assert.equal(b.sent.at(-1).m.type, 'beat');
});
test('bridge survives postMessage throwing', () => {
  const b = runBridge();
  b.ctx.window.parent.postMessage = () => { throw new Error('x'); };
  assert.doesNotThrow(() => vm.runInContext('console.log(1)', b.ctx));
});
test('bridge is syntactically valid ES5-style script', () => assert.doesNotThrow(() => new vm.Script(L.buildBridge('n'))));
test('bridge contains no closing script tag', () => assert.ok(!/<\/script/i.test(L.buildBridge('n'))));

// ---------- message validation ----------
test('parseBridgeMessage accepts good console message', () => {
  assert.deepEqual(L.parseBridgeMessage({ __dtb: NONCE, type: 'console', level: 'warn', text: 'a' }, NONCE), { type: 'console', level: 'warn', text: 'a' });
});
test('parseBridgeMessage rejects wrong nonce', () => assert.equal(L.parseBridgeMessage({ __dtb: 'x', type: 'ready' }, NONCE), null));
test('parseBridgeMessage rejects missing nonce / garbage', () => {
  for (const d of [null, undefined, 'str', 5, {}, { type: 'ready' }, []]) assert.equal(L.parseBridgeMessage(d, NONCE), null);
});
test('parseBridgeMessage rejects empty expected nonce', () => assert.equal(L.parseBridgeMessage({ __dtb: '', type: 'ready' }, ''), null));
test('parseBridgeMessage unknown level becomes log', () => assert.equal(L.parseBridgeMessage({ __dtb: NONCE, type: 'console', level: 'weird', text: 't' }, NONCE).level, 'log'));
test('parseBridgeMessage rejects non-string text', () => assert.equal(L.parseBridgeMessage({ __dtb: NONCE, type: 'console', level: 'log', text: { a: 1 } }, NONCE), null));
test('parseBridgeMessage clips long text', () => assert.equal(L.parseBridgeMessage({ __dtb: NONCE, type: 'console', text: 'x'.repeat(99999) }, NONCE).text.length, L.LIMITS.consoleText));
test('parseBridgeMessage error includes line/col', () => {
  const r = L.parseBridgeMessage({ __dtb: NONCE, type: 'error', message: 'bad', line: 4, col: 2 }, NONCE);
  assert.equal(r.text, 'bad (line 4:2)'); assert.equal(r.level, 'error');
});
test('parseBridgeMessage error without numbers', () => assert.equal(L.parseBridgeMessage({ __dtb: NONCE, type: 'error', message: 'bad', line: 'x' }, NONCE).text, 'bad'));
test('parseBridgeMessage unknown type', () => assert.equal(L.parseBridgeMessage({ __dtb: NONCE, type: 'eval' }, NONCE), null));
test('parseBridgeMessage ready/beat', () => {
  assert.deepEqual(L.parseBridgeMessage({ __dtb: NONCE, type: 'ready' }, NONCE), { type: 'ready' });
  assert.deepEqual(L.parseBridgeMessage({ __dtb: NONCE, type: 'beat' }, NONCE), { type: 'beat' });
});

// ---------- watchdog / size / viewport ----------
test('watchdog ok before first signal within limit', () => assert.equal(L.watchdogState({ now: 4000, startedAt: 0, lastSignal: null }), 'ok'));
test('watchdog stuck without any signal', () => assert.equal(L.watchdogState({ now: 6000, startedAt: 0, lastSignal: null }), 'stuck'));
test('watchdog stuck when heartbeat stops', () => assert.equal(L.watchdogState({ now: 20000, startedAt: 0, lastSignal: 10000 }), 'stuck'));
test('watchdog ok with fresh heartbeat', () => assert.equal(L.watchdogState({ now: 20000, startedAt: 0, lastSignal: 19500 }), 'ok'));
test('sourceBytes counts UTF-8', () => assert.equal(L.sourceBytes({ html: '日', css: 'a', js: '' }), 4));
test('checkSize limits', () => {
  assert.equal(L.checkSize({ html: 'x'.repeat(10) }, 5).ok, false);
  assert.equal(L.checkSize({ html: 'x'.repeat(5) }, 5).ok, true);
});
test('viewport presets', () => {
  assert.equal(L.viewportWidth('mobile'), 375); assert.equal(L.viewportWidth('tablet'), 768);
  assert.equal(L.viewportWidth('desktop'), 1280); assert.equal(L.viewportWidth('responsive'), null);
});
test('viewport custom clamps and validates', () => {
  assert.equal(L.viewportWidth('custom', 500), 500); assert.equal(L.viewportWidth('custom', 10), 200);
  assert.equal(L.viewportWidth('custom', 99999), 4000); assert.equal(L.viewportWidth('custom', 'abc'), null);
});

// ---------- export ----------
test('export html is self-contained and escapes', () => {
  const h = L.buildExportHtml({ html: '<p>x</p>', css: 'p{}', js: 'var a="</script>"' }, { title: 'A <b> & c' });
  assert.ok(h.includes('<title>A &lt;b&gt; &amp; c</title>') && h.includes('<style>') && h.includes('<p>x</p>'));
  assert.equal((h.match(/<\/script>/g) || []).length, 1);
  assert.ok(!h.includes('Content-Security-Policy') && !h.includes('__dtb'));
});
test('export omits empty style/script', () => {
  const h = L.buildExportHtml({ html: 'x', css: ' ', js: '' });
  assert.ok(!h.includes('<style>') && !h.includes('<script>'));
});
test('project files link css and js', () => {
  const f = L.buildProjectFiles(SRC);
  assert.deepEqual(f.map(x => x.name), ['index.html', 'style.css', 'script.js']);
  assert.ok(f[0].data.includes('href="style.css"') && f[0].data.includes('src="script.js"'));
  assert.equal(f[1].data, SRC.css); assert.equal(f[2].data, SRC.js);
});
test('new tab page wraps a sandboxed iframe and escapes srcdoc', () => {
  const p = L.buildNewTabPage('<p class="a">&</p><script>1</script>');
  assert.ok(p.includes('sandbox="allow-scripts"') && !p.includes('allow-same-origin'));
  assert.ok(p.includes('srcdoc="&lt;p class=&quot;a&quot;&gt;&amp;&lt;/p&gt;'));
  assert.ok(!p.includes('<script>1'));
});

// ---------- splitter ----------
test('split: basic document', () => {
  const r = L.splitHtml('<!doctype html><html><head><meta charset="utf-8"><title>T</title><style>p{color:red}</style></head><body class="x"><p>Hi</p><script>console.log(1)</script></body></html>');
  assert.equal(r.html, '<p>Hi</p>'); assert.equal(r.css, 'p{color:red}'); assert.equal(r.js, 'console.log(1)');
  assert.ok(r.warnings.some(w => w.includes('<title>')) && r.warnings.some(w => w.includes('<body>')));
});
test('split: multiple style/script blocks are joined', () => {
  const r = L.splitHtml('<style>a{}</style><div></div><style>b{}</style><script>var a=1</script><script>var b=2</script>');
  assert.equal(r.css, 'a{}\n\nb{}'); assert.equal(r.js, 'var a=1\n\nvar b=2'); assert.equal(r.html, '<div></div>');
});
test('split: script with src stays in html', () => {
  const r = L.splitHtml('<script src="x.js"></script><p>a</p>');
  assert.equal(r.js, ''); assert.ok(r.html.includes('src="x.js"'));
});
test('split: module and json scripts stay in html', () => {
  const r = L.splitHtml('<script type="module">import x from "y"</script><script type="application/ld+json">{}</script>');
  assert.equal(r.js, ''); assert.ok(r.html.includes('type="module"') && r.html.includes('ld+json'));
  assert.ok(r.warnings.some(w => /module/.test(w)));
});
test('split: script type text/javascript is moved', () => assert.equal(L.splitHtml('<script type="text/javascript">x()</script>').js, 'x()'));
test('split: commented-out script is not extracted', () => {
  const r = L.splitHtml('<!-- <script>bad()</script> --><p>x</p>');
  assert.equal(r.js, ''); assert.ok(r.html.includes('<!-- <script>bad()</script> -->'));
});
test('split: case-insensitive tags', () => {
  const r = L.splitHtml('<STYLE>a{}</STYLE><SCRIPT>z()</SCRIPT>');
  assert.equal(r.css, 'a{}'); assert.equal(r.js, 'z()');
});
test('split: script containing "<" and strings with </style', () => {
  const r = L.splitHtml('<script>if (a < b && c > d) { x = "<p>" }</script><p>ok</p>');
  assert.equal(r.js, 'if (a < b && c > d) { x = "<p>" }'); assert.equal(r.html, '<p>ok</p>');
});
test('split: fragment without html/body', () => assert.equal(L.splitHtml('<h1>x</h1>').html, '<h1>x</h1>'));
test('split: empty and whitespace', () => {
  assert.deepEqual(L.splitHtml(''), { html: '', css: '', js: '', warnings: [] });
  assert.equal(L.splitHtml('   \n ').html, '');
});
test('split: unterminated script does not hang and is extracted', () => assert.equal(L.splitHtml('<script>abc').js, 'abc'));
test('split: lone < characters survive', () => assert.equal(L.splitHtml('a < b <p>x</p>').html, 'a < b <p>x</p>'));
test('split: Unicode preserved', () => assert.equal(L.splitHtml('<p>héllo 😀</p><script>var s="日本"</script>').js, 'var s="日本"'));
test('split: link in head is kept with warning', () => {
  const r = L.splitHtml('<head><link rel="stylesheet" href="a.css"></head><body><p>x</p></body>');
  assert.ok(r.html.includes('<link rel="stylesheet" href="a.css">')); assert.ok(r.warnings.some(w => /link/i.test(w)));
});
test('split: viewport meta dropped silently', () => assert.equal(L.splitHtml('<meta name="viewport" content="width=device-width"><p>x</p>').html, '<p>x</p>'));
test('split: round trip through export and split', () => {
  const src = { html: '<p>hi</p>', css: 'p{color:red}', js: 'console.log("a</b>")' };
  const r = L.splitHtml(L.buildExportHtml(src));
  assert.equal(r.html, src.html); assert.equal(r.css, src.css);
  assert.equal(r.js.replace(/<\\\//g, '</'), src.js);
});
test('split: style with media attribute is still CSS', () => assert.equal(L.splitHtml('<style media="print">a{}</style>').css, 'a{}'));

// ---------- classify / import ----------
test('classifyFile', () => {
  assert.equal(L.classifyFile('a.HTML'), 'html'); assert.equal(L.classifyFile('a.htm'), 'html');
  assert.equal(L.classifyFile('s.css'), 'css'); assert.equal(L.classifyFile('s.mjs'), 'js');
  assert.equal(L.classifyFile('x.png'), null); assert.equal(L.classifyFile(''), null); assert.equal(L.classifyFile(null), null);
});
test('importFiles splits html, applies css/js after, reports skipped', () => {
  const cur = { html: 'old', css: 'old', js: 'old' };
  const r = L.importFiles([{ name: 'style.css', text: 'NEW{}' }, { name: 'i.html', text: '<p>x</p><style>a{}</style>' }, { name: 'img.png', text: '' }], cur);
  assert.equal(r.src.html, '<p>x</p>'); assert.equal(r.src.css, 'NEW{}'); assert.equal(r.src.js, ''); assert.deepEqual(r.skipped, ['img.png']);
});
test('importFiles js only keeps others', () => {
  const r = L.importFiles([{ name: 'a.js', text: 'x()' }], { html: 'h', css: 'c', js: 'j' });
  assert.deepEqual(r.src, { html: 'h', css: 'c', js: 'x()' });
});

// ---------- CRC32 / ZIP ----------
const enc = new TextEncoder();
test('crc32 known vectors', () => {
  assert.equal(L.crc32(enc.encode('123456789')), 0xCBF43926);
  assert.equal(L.crc32(new Uint8Array(0)), 0);
  assert.equal(L.crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414FA339);
});
/** Minimal reader for STORE zips: validates structure the way unzip tools do. */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(cdOff + cdSize, eocd);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    assert.equal(dv.getUint32(lho, true), 0x04034b50);
    const lnlen = dv.getUint16(lho + 26, true), lxlen = dv.getUint16(lho + 28, true);
    const data = buf.subarray(lho + 30 + lnlen + lxlen, lho + 30 + lnlen + lxlen + csize);
    assert.equal(method, 0); assert.equal(csize, usize); assert.equal(L.crc32(data), crc);
    out.push({ name, flags, data: new TextDecoder().decode(data) });
    p += 46 + nlen;
  }
  return out;
}
test('zip round trip with three files', () => {
  const z = L.createZip(L.buildProjectFiles(SRC));
  const files = readZip(z);
  assert.deepEqual(files.map(f => f.name), ['index.html', 'style.css', 'script.js']);
  assert.equal(files[1].data, SRC.css); assert.equal(files[2].data, SRC.js);
});
test('zip supports Unicode names and content (UTF-8 flag)', () => {
  const f = readZip(L.createZip([{ name: 'données/日本.txt', data: 'héllo 😀' }]));
  assert.equal(f[0].name, 'données/日本.txt'); assert.equal(f[0].data, 'héllo 😀'); assert.equal(f[0].flags & 0x0800, 0x0800);
});
test('zip supports empty files and empty archive', () => {
  assert.equal(readZip(L.createZip([{ name: 'e.txt', data: '' }]))[0].data, '');
  const z = L.createZip([]); assert.equal(z.length, 22); assert.equal(readZip(z).length, 0);
});
test('zip accepts binary Uint8Array', () => {
  const bin = new Uint8Array([0, 255, 1, 2, 3]);
  const z = L.createZip([{ name: 'b.bin', data: bin }]);
  assert.equal(z.length, 30 + 5 + 5 + 46 + 5 + 22);
  readZip(z);
});
test('zip normalises backslash and leading slash names', () => assert.equal(readZip(L.createZip([{ name: '\\a\\b.txt', data: 'x' }]))[0].name, 'a/b.txt'));
test('zip DOS date for fixed date', () => {
  const z = L.createZip([{ name: 'a', data: 'x' }], { date: new Date(2024, 4, 17, 13, 45, 30) });
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint16(10, true), (13 << 11) | (45 << 5) | 15);
  assert.equal(dv.getUint16(12, true), ((2024 - 1980) << 9) | (5 << 5) | 17);
});
test('zip large content', () => {
  const big = 'abc\n'.repeat(500000);
  const f = readZip(L.createZip([{ name: 'big.txt', data: big }]));
  assert.equal(f[0].data.length, big.length);
});

// ---------- examples ----------
test('examples are well-formed and bridge-safe', () => {
  assert.ok(Object.keys(L.EXAMPLES).length >= 4 && L.EXAMPLES[L.DEFAULT_EXAMPLE]);
  for (const [k, ex] of Object.entries(L.EXAMPLES)) {
    assert.ok(ex.label && ex.html && ex.css != null && ex.js, k);
    assert.doesNotThrow(() => new vm.Script(ex.js), k);
    assert.ok(L.checkSize(ex).ok);
    assert.ok(L.buildSrcdoc(ex, { nonce: NONCE }).includes(ex.html));
  }
});

console.log(`html-css-js-playground: ${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
