// HTML/CSS/JS Playground - pure logic (no DOM): srcdoc builder, bridge protocol, HTML splitter, export page, ZIP writer, examples.

export const LIMITS = { totalBytes: 1_000_000, consoleEntries: 500, consoleText: 4000, stuckSeconds: 5 };

export const DEFAULT_CSP = "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data: https:; media-src data: blob: https:";
export const RELAXED_CSP = "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:; font-src data: https:; media-src data: blob: https:";

export const buildCsp = allowExternal => (allowExternal ? RELAXED_CSP : DEFAULT_CSP);

/** Random hex nonce. `randomBytes(n)` may be injected for tests; defaults to crypto.getRandomValues. */
export function makeNonce(randomBytes) {
  const bytes = randomBytes ? randomBytes(16) : crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(b => (b & 255).toString(16).padStart(2, '0')).join('');
}

/** Make text safe to embed inside an inline <script>: no `</script`, no `<!--`, no U+2028/2029 issues (those are valid in ES2019). */
export function escapeInlineScript(js) {
  return String(js ?? '').replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}
/** Same for <style>: `</style` would end the element early. */
export function escapeInlineStyle(css) {
  return String(css ?? '').replace(/<\/(style)/gi, '<\\/$1');
}

/** Attribute-safe string for srcdoc="...". */
export const escapeAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The bridge runs first inside the preview. It reports console output, errors and a heartbeat to the parent window.
 * It is plain ES5 so it also works in the oldest browsers. __NONCE__ / __ORIGIN__ are replaced by JSON strings.
 */
const BRIDGE_TEMPLATE = `(function () {
  var N = __NONCE__, O = __ORIGIN__, P = window.parent, MAX = 4000;
  function send(type, data) {
    try { var m = { __dtb: N, type: type }; for (var k in data) m[k] = data[k]; P.postMessage(m, O); } catch (e) {}
  }
  function cut(s) { s = String(s); return s.length > MAX ? s.slice(0, MAX) + '... [truncated]' : s; }
  function fmt(v, depth, seen) {
    var t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return depth ? JSON.stringify(v) : v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return String(v);
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (v instanceof Error) return (v.stack || (v.name + ': ' + v.message));
    if (seen.indexOf(v) !== -1) return '[Circular]';
    if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen.push(v);
    var out;
    try {
      if (Array.isArray(v)) {
        var parts = [];
        for (var i = 0; i < v.length && i < 100; i++) parts.push(fmt(v[i], depth + 1, seen));
        if (v.length > 100) parts.push('... ' + (v.length - 100) + ' more items');
        out = '[' + parts.join(', ') + ']';
      } else if (typeof Node !== 'undefined' && v instanceof Node) {
        out = '<' + String(v.nodeName).toLowerCase() + '>';
      } else {
        var keys = Object.keys(v), ps = [];
        for (var j = 0; j < keys.length && j < 100; j++) ps.push(keys[j] + ': ' + fmt(v[keys[j]], depth + 1, seen));
        var tag = Object.prototype.toString.call(v);
        out = (tag !== '[object Object]' ? tag.slice(8, -1) + ' ' : '') + '{' + ps.join(', ') + '}';
      }
    } catch (e) { out = '[Unprintable]'; }
    seen.pop();
    return out;
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i], 0, []));
      send('console', { level: level === 'debug' ? 'log' : level, text: cut(parts.join(' ')) });
      try { if (orig) orig.apply(console, arguments); } catch (e) {}
    };
  });
  window.addEventListener('error', function (e) {
    send('error', { message: cut(e && e.message ? e.message : 'Script error'), line: e && e.lineno | 0, col: e && e.colno | 0 });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    send('error', { message: cut('Unhandled promise rejection: ' + (r instanceof Error ? r.message : fmt(r, 0, []))), line: 0, col: 0 });
  });
  window.addEventListener('load', function () {
    send('ready', {});
    setInterval(function () { send('beat', {}); }, 1000);
  });
})();`;

export function buildBridge(nonce, parentOrigin) {
  const origin = parentOrigin && parentOrigin !== 'null' ? parentOrigin : '*';
  return BRIDGE_TEMPLATE.replace('__NONCE__', () => JSON.stringify(String(nonce))).replace('__ORIGIN__', () => JSON.stringify(origin));
}

/**
 * Build the srcdoc for the preview iframe.
 * @param {{html?:string, css?:string, js?:string}} src
 * @param {{nonce:string, allowExternal?:boolean, parentOrigin?:string}} opts
 */
export function buildSrcdoc(src, opts) {
  const { nonce, allowExternal = false, parentOrigin } = opts || {};
  if (!nonce) throw new Error('A nonce is required');
  const csp = buildCsp(allowExternal);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${escapeInlineScript(buildBridge(nonce, parentOrigin))}</script>
<style>${escapeInlineStyle(src?.css)}</style>
</head>
<body>
${src?.html ?? ''}
<script>${escapeInlineScript(src?.js)}</script>
</body>
</html>`;
}

/**
 * Validate and normalise a message from the preview. Returns null for anything that is not a well-formed bridge message
 * for THIS run (wrong nonce, wrong shape). Caller must additionally check event.source === iframe.contentWindow.
 */
export function parseBridgeMessage(data, nonce) {
  if (!data || typeof data !== 'object' || data.__dtb !== nonce || typeof nonce !== 'string' || !nonce) return null;
  const clip = s => String(s).slice(0, LIMITS.consoleText);
  switch (data.type) {
    case 'ready': return { type: 'ready' };
    case 'beat': return { type: 'beat' };
    case 'console': {
      const level = ['log', 'info', 'warn', 'error'].includes(data.level) ? data.level : 'log';
      if (typeof data.text !== 'string') return null;
      return { type: 'console', level, text: clip(data.text) };
    }
    case 'error': {
      if (typeof data.message !== 'string') return null;
      const line = Number.isFinite(data.line) ? data.line | 0 : 0, col = Number.isFinite(data.col) ? data.col | 0 : 0;
      return { type: 'error', level: 'error', text: clip(data.message) + (line ? ` (line ${line}${col ? `:${col}` : ''})` : ''), line, col };
    }
    default: return null;
  }
}

/** Watchdog decision: 'ok' | 'stuck'. `lastSignal` = ms timestamp of the last ready/beat, `startedAt` = run start. */
export function watchdogState({ now, startedAt, lastSignal, seconds = LIMITS.stuckSeconds }) {
  const ref = lastSignal ?? startedAt;
  return now - ref > seconds * 1000 ? 'stuck' : 'ok';
}

/** Total source size in UTF-8 bytes. */
export function sourceBytes(src) {
  const enc = new TextEncoder();
  return enc.encode(src.html || '').length + enc.encode(src.css || '').length + enc.encode(src.js || '').length;
}
export function checkSize(src, max = LIMITS.totalBytes) {
  const bytes = sourceBytes(src);
  return { ok: bytes <= max, bytes, max };
}

export const VIEWPORTS = { responsive: null, mobile: 375, tablet: 768, desktop: 1280 };
/** Width in px for a preset ('responsive' => null meaning fill the pane). Custom width is clamped to 200..4000. */
export function viewportWidth(preset, custom) {
  if (preset === 'custom') {
    const n = Math.round(Number(custom));
    return Number.isFinite(n) ? Math.min(4000, Math.max(200, n)) : null;
  }
  return VIEWPORTS[preset] ?? null;
}

// ---------------------------------------------------------------- export / wrapper pages

/** Self-contained single-file HTML (no CSP, no bridge) for download. */
export function buildExportHtml(src, { title = 'Playground' } = {}) {
  const t = String(title).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const css = String(src?.css ?? '').trim() ? `<style>\n${escapeInlineStyle(src.css)}\n</style>\n` : '';
  const js = String(src?.js ?? '').trim() ? `<script>\n${escapeInlineScript(src.js)}\n</script>\n` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
${css}</head>
<body>
${src?.html ?? ''}
${js}</body>
</html>
`;
}

/** The three files of a multi-file export. index.html links style.css and script.js. */
export function buildProjectFiles(src, { title = 'Playground' } = {}) {
  const t = String(title).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${src?.html ?? ''}
<script src="script.js"></script>
</body>
</html>
`;
  return [
    { name: 'index.html', data: index },
    { name: 'style.css', data: String(src?.css ?? '') },
    { name: 'script.js', data: String(src?.js ?? '') },
  ];
}

/**
 * Page opened in a new tab via a Blob URL. A blob: page inherits the app origin, so user code must NOT run in it directly:
 * the wrapper only hosts a sandboxed iframe (allow-scripts, no allow-same-origin) that carries the srcdoc.
 */
export function buildNewTabPage(srcdoc) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playground preview</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe sandbox="allow-scripts" srcdoc="${escapeAttr(srcdoc)}" title="Preview"></iframe></body></html>`;
}

// ---------------------------------------------------------------- HTML splitter

const RE_CSS_TYPE = /^(text\/css)?$/i;
const RE_JS_TYPE = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

function attrOf(tagText, name) {
  const m = new RegExp(`\\s${name}\\s*(?:=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`, 'i').exec(tagText);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/**
 * Split a full HTML document into { html, css, js, warnings }. Inline <style> and classic inline <script> blocks move to
 * css / js; everything else in <head> (except title/charset/viewport) plus the <body> content becomes html.
 * Scripts with src, module scripts and non-JS types stay in the html text.
 */
export function splitHtml(source) {
  const text = String(source ?? '');
  const warnings = [];
  const css = [], js = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { out += text.slice(i); break; }
    out += text.slice(i, lt);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const stop = end < 0 ? text.length : end + 3;
      out += text.slice(lt, stop); i = stop; continue;
    }
    const m = /^<(script|style)(?=[\s>/])/i.exec(text.slice(lt, lt + 8));
    if (!m) { out += '<'; i = lt + 1; continue; }
    const name = m[1].toLowerCase();
    const gt = text.indexOf('>', lt);
    if (gt < 0) { out += text.slice(lt); break; }
    const openTag = text.slice(lt, gt + 1);
    const closeRe = new RegExp(`</${name}(?=[\\s>/])`, 'i');
    const rest = text.slice(gt + 1);
    const cm = closeRe.exec(rest);
    const bodyEnd = cm ? gt + 1 + cm.index : text.length;
    const closeGt = cm ? text.indexOf('>', bodyEnd) : -1;
    const stop = cm ? (closeGt < 0 ? text.length : closeGt + 1) : text.length;
    const content = text.slice(gt + 1, bodyEnd);
    const type = (attrOf(openTag, 'type') ?? '').trim();
    const hasSrc = attrOf(openTag, 'src') != null;
    let moved = false;
    if (name === 'style' && RE_CSS_TYPE.test(type)) { css.push(content.replace(/^\n+|\s+$/g, '')); moved = true; }
    else if (name === 'script' && !hasSrc && RE_JS_TYPE.test(type)) { js.push(content.replace(/^\n+|\s+$/g, '')); moved = true; }
    else if (name === 'script' && !hasSrc && /^module$/i.test(type)) warnings.push('A <script type="module"> was kept in the HTML panel (module scripts cannot be merged into the JS panel).');
    if (!moved) out += text.slice(lt, stop);
    i = stop;
  }

  let html = out;
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleM && titleM[1].trim()) warnings.push(`The <title> ("${titleM[1].trim().slice(0, 60)}") was dropped; the playground has no head panel.`);
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
  html = html.replace(/<meta\s+[^>]*charset[^>]*>/gi, '').replace(/<meta\s+[^>]*name\s*=\s*["']?viewport["']?[^>]*>/gi, '');
  html = html.replace(/<!doctype[^>]*>/gi, '').replace(/<\/?(html|head)(\s[^>]*)?>/gi, '');
  const bodyTag = /<body(\s[^>]*)?>/i.exec(html);
  if (bodyTag && bodyTag[1] && bodyTag[1].trim()) warnings.push(`Attributes on <body> (${bodyTag[1].trim().slice(0, 60)}) were dropped.`);
  html = html.replace(/<\/?body(\s[^>]*)?>/gi, '');
  const headLeft = /<(link|meta|base)\b/i.test(html) ? ' External <link>/<meta> tags from the head were kept at the top of the HTML panel.' : '';
  if (headLeft) warnings.push(headLeft.trim());
  html = html.replace(/\n{3,}/g, '\n\n').trim();
  return { html, css: css.filter(Boolean).join('\n\n'), js: js.filter(Boolean).join('\n\n'), warnings };
}

/** Which panel a dropped/imported file name belongs to. */
export function classifyFile(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  return null;
}

/**
 * Apply imported files ([{name, text}]) on top of the current source. A .html file is split into the three panels;
 * a .css / .js file replaces its panel. Returns { src, warnings, skipped }.
 */
export function importFiles(files, current) {
  const src = { html: current.html, css: current.css, js: current.js };
  const warnings = [], skipped = [];
  const ordered = [...files].sort((a, b) => (classifyFile(a.name) === 'html' ? -1 : 0) - (classifyFile(b.name) === 'html' ? -1 : 0));
  for (const f of ordered) {
    const kind = classifyFile(f.name);
    if (!kind) { skipped.push(f.name); continue; }
    if (kind === 'html') {
      const r = splitHtml(f.text);
      src.html = r.html; src.css = r.css; src.js = r.js; warnings.push(...r.warnings);
    } else src[kind] = f.text;
  }
  return { src, warnings, skipped };
}

// ---------------------------------------------------------------- ZIP (STORE only)

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Create a ZIP archive (no compression). files: [{name, data: string | Uint8Array}]. Names are UTF-8. Returns Uint8Array. */
export function createZip(files, { date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: dd } = dosDateTime(date);
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(String(f.name).replace(/\\/g, '/').replace(/^\/+/, ''));
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// ---------------------------------------------------------------- examples

export const EXAMPLES = {
  hello: {
    label: 'Hello, world',
    html: '<h1>Hello, Playground!</h1>\n<p>Edit the HTML, CSS and JS panels. Click the button.</p>\n<button id="btn">Say hi</button>\n<p id="out"></p>',
    css: 'body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n  color: #1a2030;\n}\nh1 { color: #3a58e8; }\nbutton { padding: .5rem 1rem; font-size: 1rem; cursor: pointer; }',
    js: "const out = document.getElementById('out');\nlet n = 0;\ndocument.getElementById('btn').addEventListener('click', () => {\n  n++;\n  out.textContent = `Clicked ${n} time${n === 1 ? '' : 's'}`;\n  console.log('clicked', n);\n});\nconsole.info('Ready');",
  },
  flexbox: {
    label: 'Flexbox demo',
    html: '<div class="row">\n  <div class="box">1</div>\n  <div class="box">2</div>\n  <div class="box tall">3</div>\n  <div class="box">4</div>\n  <div class="box">5</div>\n</div>',
    css: 'body { font-family: system-ui, sans-serif; margin: 1rem; }\n.row {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 12px;\n  justify-content: space-between;\n  align-items: center;\n  border: 2px dashed #8893a8;\n  padding: 12px;\n}\n.box {\n  flex: 1 1 80px;\n  min-height: 60px;\n  display: grid;\n  place-items: center;\n  background: #3a58e8;\n  color: #fff;\n  border-radius: 8px;\n  font-weight: 700;\n}\n.tall { min-height: 120px; background: #0f7453; }',
    js: "// Try changing justify-content / align-items in the CSS panel.\nconsole.log('boxes:', document.querySelectorAll('.box').length);",
  },
  canvas: {
    label: 'Canvas animation',
    html: '<canvas id="c" width="320" height="200"></canvas>\n<p>Bouncing ball (requestAnimationFrame)</p>',
    css: 'body { margin: 1rem; font-family: system-ui, sans-serif; }\ncanvas { border: 1px solid #8893a8; max-width: 100%; background: #fff; }',
    js: "const c = document.getElementById('c'), g = c.getContext('2d');\nlet x = 40, y = 40, vx = 2.4, vy = 1.8;\nfunction frame() {\n  g.clearRect(0, 0, c.width, c.height);\n  x += vx; y += vy;\n  if (x < 12 || x > c.width - 12) vx = -vx;\n  if (y < 12 || y > c.height - 12) vy = -vy;\n  g.fillStyle = '#c62d3d';\n  g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill();\n  requestAnimationFrame(frame);\n}\nframe();\nconsole.log('animation started');",
  },
  dom: {
    label: 'DOM demo (todo list, no network)',
    html: '<h2>Todo</h2>\n<form id="f"><input id="t" placeholder="New item" aria-label="New item"> <button>Add</button></form>\n<ul id="list"></ul>',
    css: 'body { font-family: system-ui, sans-serif; margin: 1.5rem; }\nli { margin: .25rem 0; }\nli.done { text-decoration: line-through; opacity: .6; }\ninput { padding: .4rem; }',
    js: "const list = document.getElementById('list');\ndocument.getElementById('f').addEventListener('submit', e => {\n  e.preventDefault();\n  const t = document.getElementById('t');\n  if (!t.value.trim()) { console.warn('Empty item ignored'); return; }\n  const li = document.createElement('li');\n  li.textContent = t.value.trim();\n  li.addEventListener('click', () => li.classList.toggle('done'));\n  list.append(li);\n  console.log('added', JSON.stringify(t.value.trim()));\n  t.value = '';\n});",
  },
};
export const DEFAULT_EXAMPLE = 'hello';
