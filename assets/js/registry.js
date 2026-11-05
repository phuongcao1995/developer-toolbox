// Lightweight tool registry. To add a tool: create tools/<id>/{index.html,tool.js,tool.css}
// and append an entry below. `icon` is a Lucide icon name.
export const CATEGORIES = [
  { id: 'data',    name: 'JSON & Data',        icon: 'braces' },
  { id: 'text',    name: 'Text & Docs',        icon: 'file-text' },
  { id: 'code',    name: 'Code Development',   icon: 'code-2' },
  { id: 'utility', name: 'URL, Time & Utilities', icon: 'wrench' },
  { id: 'api',     name: 'API & Database',     icon: 'database' },
  { id: 'files',   name: 'Files & Media',      icon: 'file-archive' },
  { id: 'web',     name: 'Web Development',    icon: 'globe' },
];

const DEFAULT_UPDATED = '2026-11-03';
const t = (id, name, description, category, icon, keywords) =>
  ({ id, name, description, category, icon, keywords, entry: `tools/${id}/tool.js`, version: '1.0', updated: DEFAULT_UPDATED, note: '' });

export const TOOLS = [
  t('json-formatter', 'JSON Formatter', 'Format, minify, validate and explore JSON; convert to XML, CSV or YAML.', 'data', 'braces', ['json', 'beautify', 'minify', 'validate', 'tree', 'xml', 'csv', 'yaml']),
  t('cyberchef', 'Data Converter', 'CyberChef-style pipeline: Base64, URL, Hex, HTML entities, SHA-256, MD5, UTF-8.', 'data', 'chef-hat', ['cyberchef', 'encode', 'decode', 'hash', 'sha256', 'md5', 'hex', 'pipeline']),
  t('jwt-decoder', 'JWT Decoder', 'Decode JSON Web Tokens and inspect header, payload and expiry (no signature check).', 'data', 'key-round', ['jwt', 'token', 'bearer', 'auth', 'decode', 'claims']),
  t('regex-tester', 'Regex Tester', 'Test JavaScript regular expressions with live match and group highlighting.', 'data', 'regex', ['regex', 'regexp', 'pattern', 'match', 'groups']),
  t('saltbox', 'Saltbox', 'Hash (SHA/MD5), PBKDF2 password hashing, AES-GCM encryption, CryptoJS-compatible AES, secure random generator and encoders — all local.', 'data', 'lock-keyhole', ['saltbox', 'hash', 'sha256', 'md5', 'pbkdf2', 'salt', 'password', 'aes', 'encrypt', 'decrypt', 'cryptojs', 'random', 'key', 'iv']),
  t('api-client', 'API Client', 'Send HTTP requests, inspect responses, and keep a request history.', 'data', 'send', ['http', 'rest', 'request', 'fetch', 'postman', 'headers']),

  t('diff-checker', 'Diff Checker', 'Compare two texts side-by-side or unified with highlighted changes.', 'text', 'git-compare', ['diff', 'compare', 'difference', 'merge']),
  t('markdown-editor', 'Markdown Editor', 'Write Markdown with live preview, split view, and HTML/Markdown export.', 'text', 'pen-line', ['markdown', 'md', 'editor', 'preview', 'html']),
  t('text-pad', 'Text Pad', 'Distraction-free writing pad that autosaves in your browser, with live word count, case and line tools, focus mode and .txt export.', 'text', 'notebook-pen', ['text', 'type', 'write', 'notepad', 'writebox', 'scratchpad', 'notes', 'word count', 'autosave', 'focus']),
  t('markdown-viewer', 'Markdown Viewer', 'Open .md files with rendered output, table of contents and code highlighting.', 'text', 'book-open', ['markdown', 'md', 'viewer', 'reader', 'toc']),
  t('code-beautifier', 'Code Beautifier', 'Format or minify HTML, CSS, JavaScript and JSON with configurable indentation.', 'text', 'wand-2', ['beautify', 'format', 'minify', 'html', 'css', 'javascript']),
  t('sql-formatter', 'SQL Formatter', 'Format and minify SQL, with configurable indentation and keyword case.', 'text', 'database', ['sql', 'format', 'query', 'select', 'minify']),

  t('prettier-playground', 'Prettier Playground', 'Format JS, TS, JSX, CSS, HTML, JSON and Markdown with Prettier options.', 'code', 'sparkles', ['prettier', 'format', 'typescript', 'jsx', 'lint']),
  t('carbon-code-image', 'Code Image Generator', 'Turn code into a beautiful PNG image with themes and custom backgrounds.', 'code', 'image', ['carbon', 'screenshot', 'png', 'snippet', 'image']),
  t('base64-converter', 'Base64 Converter', 'Encode and decode text, images and files as Base64 with UTF-8 support.', 'code', 'binary', ['base64', 'encode', 'decode', 'image', 'file', 'utf-8']),

  t('url-encoder', 'URL Encoder / Decoder', 'Encode, decode and parse URLs; edit query parameters.', 'utility', 'link', ['url', 'uri', 'encode', 'decode', 'query', 'percent']),
  t('cron-generator', 'Cron Generator', 'Build and explain cron expressions and preview upcoming run times.', 'utility', 'clock', ['cron', 'schedule', 'crontab', 'job']),
  t('uuid-generator', 'UUID Generator', 'Generate one or many UUID v4 values with formatting options.', 'utility', 'fingerprint', ['uuid', 'guid', 'random', 'id']),
  t('timestamp-converter', 'Timestamp Converter', 'Convert Unix timestamps and dates, with UTC, local and timezone views.', 'utility', 'calendar-clock', ['unix', 'epoch', 'timestamp', 'date', 'iso', 'timezone']),

  t('webhook-inspector', 'Webhook Inspector', 'Inspect webhook requests — demo mode with simulated requests, optional external service.', 'api', 'webhook', ['webhook', 'inspect', 'http', 'request', 'callback']),
  t('table-converter', 'Table Converter', 'Convert between JSON, CSV, SQL INSERT and Markdown tables.', 'api', 'table', ['csv', 'json', 'sql', 'markdown', 'table', 'convert']),
  t('http-status-reference', 'HTTP Status Codes', 'Searchable reference of HTTP status codes with usage notes.', 'api', 'list-checks', ['http', 'status', 'code', '404', '500', 'reference']),

  // Added in the second release (each is an independent child project under tools/<id>/).
  t('html-entity-converter', 'HTML Entity Converter', 'Encode and decode HTML entities (named, decimal, hex) with live two-way conversion and a searchable entity reference.', 'text', 'code-xml', ['html entities', 'encode', 'decode', 'escape html', 'unicode', 'numeric character reference', 'nbsp', 'copyright', 'special characters']),
  t('ts-interface-generator', 'TypeScript Interface Generator', 'Generate TypeScript interfaces, Zod schemas or JSDoc typedefs from JSON, JSON Lines or JSON Schema.', 'code', 'braces', ['typescript', 'interface', 'json to ts', 'zod', 'jsdoc', 'json schema', 'types', 'quicktype', 'd.ts', 'jsonl']),
  t('sql-query-analyzer', 'SQL Query Analyzer', 'Analyze SQL without running it: structure, join diagram, sargability, index suggestions, anti-patterns and a helper for reading EXPLAIN plans.', 'api', 'database-zap', ['sql', 'query', 'analyzer', 'index', 'explain', 'execution plan', 'join', 'sargable', 'lint', 'performance']),
  t('openapi-viewer', 'OpenAPI / Swagger Viewer', 'Browse OpenAPI 3.x and Swagger 2.0 specs as endpoints and schemas, lint them, generate example payloads, and export Markdown or standalone HTML docs.', 'api', 'network', ['openapi', 'swagger', 'api', 'spec', 'docs', 'endpoints', 'schema', 'rest', 'lint', 'yaml']),
  t('xml-formatter', 'XML Formatter & Validator', 'Beautify, minify and validate XML with exact error positions, a tree explorer, XPath queries and XML/JSON conversion.', 'data', 'file-code', ['xml', 'format', 'beautify', 'minify', 'validate', 'xpath', 'tree', 'well-formed', 'xml to json']),
  t('yaml-formatter', 'YAML Formatter & Validator', 'Format and validate YAML (multi-document), convert to and from JSON, and catch common YAML pitfalls.', 'data', 'file-cog', ['yaml', 'yml', 'format', 'validate', 'lint', 'json', 'convert', 'anchors', 'kubernetes', 'config']),
  t('git-command-generator', 'Git Command Generator', 'Build Git commands for common tasks, with explanations, danger warnings and undo hints. Commands are shown, never run.', 'utility', 'git-branch', ['git', 'command', 'branch', 'merge', 'rebase', 'reset', 'revert', 'stash', 'undo', 'cheat sheet', 'reflog']),
  t('image-converter', 'Image Converter', 'Convert, resize and compress images to PNG, JPEG or WebP in batches, then download them singly or as a ZIP.', 'files', 'image-down', ['image', 'convert', 'png', 'jpeg', 'webp', 'resize', 'compress', 'batch', 'zip', 'svg']),
  t('file-hash-generator', 'File Hash Generator', 'Hash text and files with MD5, SHA-1, SHA-256, SHA-384 and SHA-512 (plus HMAC), compare against an expected hash, and verify checksum files.', 'files', 'hash', ['hash', 'checksum', 'md5', 'sha256', 'sha1', 'sha512', 'hmac', 'verify', 'sha256sum', 'integrity']),
  t('qr-code', 'QR Code Generator & Reader', 'Create QR codes for text, URLs, Wi-Fi, contacts and more, and read them from images or the camera.', 'files', 'qr-code', ['qr', 'qrcode', 'barcode', 'scan', 'wifi', 'vcard', 'url', 'camera', 'generator', 'reader']),
  t('chmod-calculator', 'Chmod Calculator', 'Convert chmod permissions between checkboxes, octal, symbolic and commands, apply symbolic expressions and umask, and parse ls -l output.', 'utility', 'lock-keyhole', ['chmod', 'permissions', 'unix', 'linux', 'octal', 'umask', 'symbolic', 'ls', 'setuid', 'sticky']),
  t('html-css-js-playground', 'HTML/CSS/JS Playground', 'Write HTML, CSS and JavaScript with a live sandboxed preview, a console and project export.', 'web', 'square-terminal', ['html', 'css', 'javascript', 'playground', 'sandbox', 'preview', 'codepen', 'console', 'zip']),
  t('color-converter', 'Color Converter', 'Convert colours between HEX, RGB, HSL, HWB, Lab, LCH, OKLab and OKLCH, build palettes and check WCAG contrast.', 'web', 'palette', ['color', 'colour', 'hex', 'rgb', 'hsl', 'oklch', 'contrast', 'wcag', 'palette', 'gradient', 'colorblind']),
  t('http-header-analyzer', 'HTTP Header Analyzer', 'Parse and explain HTTP request or response headers and review security headers, cookies, CORS and caching.', 'web', 'shield-check', ['http', 'headers', 'security', 'csp', 'hsts', 'cors', 'cookie', 'cache-control', 'curl', 'response']),
  t('curl-converter', 'cURL Converter', 'Convert cURL commands to fetch, axios, Python, Go, PHP, Node, HTTPie and PowerShell, or build a cURL command from a form.', 'api', 'terminal-square', ['curl', 'fetch', 'axios', 'python requests', 'go', 'php', 'httpie', 'powershell', 'http request', 'convert']),
];

export const getTool = id => TOOLS.find(x => x.id === id) || null;
export const getCategory = id => CATEGORIES.find(c => c.id === id) || null;

/** Per-tool release notes. `note` is shown under "Recently updated" on the dashboard; keep it to one short sentence. */
const RELEASES = {
  'cron-generator': { updated: '2026-11-03', version: '1.1', note: 'Day-of-week 7 handled, clearer errors, DST note, visible keyboard focus.' },
  'markdown-editor': { updated: '2026-11-04', version: '1.2', note: 'Table of contents, Mermaid diagrams, fullscreen, find & replace and safer preview.' },
  'markdown-viewer': { updated: '2026-11-04', version: '1.2', note: 'Table of contents, Mermaid, in-document search and safe rendering of untrusted files.' },
  'json-formatter': { updated: '2026-11-04', version: '1.2', note: 'Tree explorer, JSONPath, Schema validation, JSON diff, TypeScript and sample data.' },
  'sql-formatter': { updated: '2026-11-04', version: '1.2', note: 'Syntax highlighting, query analysis, explain, SQL to JSON and dialects.' },
  'jwt-decoder': { updated: '2026-11-04', version: '1.2', note: 'Signature verification (HS/RS/ES/PS), security warnings and a live expiry countdown.' },
  'api-client': { updated: '2026-11-04', version: '1.2', note: 'Collections, environments, auth helpers, cURL and Postman import/export, JSON tree.' },
  'regex-tester': { updated: '2026-11-04', version: '1.2', note: '47 templates, mistake checker, code export, cheat sheet; runs in a safe worker.' },
  'table-converter': { updated: '2026-11-04', version: '1.2', note: 'XML conversion, large-file worker, better CSV handling and Unicode.' },
  'diff-checker': { updated: '2026-11-04', version: '1.2', note: 'Exact diffs on huge files, character-level view, folding and ignore options.' },
  'cyberchef': { updated: '2026-11-04', version: '1.1', note: 'Binary-safe output, HTML entities, Base32/58, ROT13 and more operations.' },
  'timestamp-converter': { updated: '2026-11-04', version: '1.1', note: 'Exact nanoseconds and microseconds, ambiguity hints.' },
  'uuid-generator': { updated: '2026-11-04', version: '1.1', note: 'UUID v7, nil and max UUIDs.' },
  'webhook-inspector': { updated: '2026-11-03', version: '1.1', note: 'Redacts secrets in stored history, backs off when polling fails.' },
  'base64-converter': { updated: '2026-11-03', version: '1.1', note: 'Rejects unsafe data-URI types and builds safe HTML/CSS snippets.' },
};
for (const [id, r] of Object.entries(RELEASES)) Object.assign(getTool(id) || {}, r);

/** Dev-time sanity check of the registry; returns a list of problems (empty = healthy). */
export function validateRegistry(tools = TOOLS, categories = CATEGORIES) {
  const problems = [], seen = new Set(), cats = new Set(categories.map(c => c.id));
  for (const x of tools) {
    if (!/^[a-z0-9-]+$/.test(x.id || '')) problems.push(`Invalid tool id: ${x.id}`);
    if (seen.has(x.id)) problems.push(`Duplicate tool id: ${x.id}`);
    seen.add(x.id);
    if (!cats.has(x.category)) problems.push(`${x.id}: unknown category "${x.category}"`);
    for (const f of ['name', 'description', 'icon', 'entry']) if (!x[f]) problems.push(`${x.id}: missing ${f}`);
    if (!Array.isArray(x.keywords) || !x.keywords.length) problems.push(`${x.id}: needs keywords`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.updated || '')) problems.push(`${x.id}: updated must be YYYY-MM-DD`);
  }
  return problems;
}

// ---------- Search ----------
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Damerau-Levenshtein distance; returns max+1 early when the length gap alone exceeds `max`. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** Subsequence match ("jsnfmt" -> "JSON Formatter"). Returns {score, idx[]} or null. Rewards consecutive and word-start hits. */
function subsequence(word, text) {
  const idx = []; let ti = 0, score = 0, prev = -2;
  for (const ch of word) {
    const at = text.indexOf(ch, ti);
    if (at < 0) return null;
    score += (at === prev + 1 ? 3 : 1) + (at === 0 || /[\s\-/]/.test(text[at - 1]) ? 2 : 0);
    idx.push(at); prev = at; ti = at + 1;
  }
  return { score, idx };
}

/** Merge sorted character indexes into [start,end) ranges. */
const toRanges = idx => idx.reduce((r, i) => {
  const last = r[r.length - 1];
  if (last && last[1] === i) last[1] = i + 1; else r.push([i, i + 1]);
  return r;
}, []);

/** Score one query word against a tool. Returns {score, nameIdx[]} or null if it does not match at all. */
function matchWord(w, x, cat) {
  const name = norm(x.name), desc = norm(x.description), kws = x.keywords.map(norm), catName = norm(cat?.name);
  const at = name.indexOf(w);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s\-/]/.test(name[at - 1]);
    return { score: (wordStart ? 100 : 70) - Math.min(at, 20), nameIdx: [...Array(w.length).keys()].map(i => at + i) };
  }
  if (x.id.includes(w)) return { score: 60, nameIdx: [] };
  if (kws.includes(w)) return { score: 55, nameIdx: [] };
  if (kws.some(k => k.startsWith(w))) return { score: 45, nameIdx: [] };
  if (kws.some(k => k.includes(w))) return { score: 30, nameIdx: [] };
  if (catName.includes(w)) return { score: 20, nameIdx: [] };
  if (desc.includes(w)) return { score: 15, nameIdx: [] };
  if (w.length >= 3) {
    const sub = subsequence(w, name);
    if (sub) return { score: 8 + sub.score, nameIdx: sub.idx };
    // typo tolerance against the words of the name and the keywords
    const max = w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0;
    if (max) {
      const pool = [...name.split(/[\s\-/]+/), ...kws];
      if (pool.some(p => editDistance(w, p, max) <= max || editDistance(w, p.slice(0, w.length), max) <= max)) return { score: 6, nameIdx: [] };
    }
  }
  return null;
}

/**
 * Ranked search. Every word of the query must match (AND). Returns [{tool, score, ranges}] where `ranges`
 * are [start,end) character ranges inside tool.name to highlight. An empty query returns all tools in registry order.
 */
export function searchToolsDetailed(query = '', category = null, tools = TOOLS) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const pool = tools.filter(x => !category || x.category === category);
  if (!words.length) return pool.map(tool => ({ tool, score: 0, ranges: [] }));
  const out = [];
  for (const tool of pool) {
    const cat = getCategory(tool.category);
    let score = 0, idx = [], ok = true;
    for (const w of words) {
      const m = matchWord(w, tool, cat);
      if (!m) { ok = false; break; }
      score += m.score; idx = idx.concat(m.nameIdx);
    }
    if (ok) out.push({ tool, score, ranges: toRanges([...new Set(idx)].sort((a, b) => a - b)) });
  }
  return out.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
}

/** Search by name, description, keywords and category with fuzzy matching; optional category filter. */
export const searchTools = (query = '', category = null) => searchToolsDetailed(query, category).map(r => r.tool);
