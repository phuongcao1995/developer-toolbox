// Lightweight tool registry. To add a tool: create tools/<id>/{index.html,tool.js,tool.css}
// and append an entry below. `icon` is a Lucide icon name.
export const CATEGORIES = [
  { id: 'data',    name: 'JSON & Data',        icon: 'braces' },
  { id: 'text',    name: 'Text & Docs',        icon: 'file-text' },
  { id: 'code',    name: 'Code Development',   icon: 'code-2' },
  { id: 'utility', name: 'URL, Time & Utilities', icon: 'wrench' },
  { id: 'api',     name: 'API & Database',     icon: 'database' },
];

const t = (id, name, description, category, icon, keywords) =>
  ({ id, name, description, category, icon, keywords, entry: `tools/${id}/tool.js` });

export const TOOLS = [
  t('json-formatter', 'JSON Formatter', 'Format, minify, validate and explore JSON; convert to XML, CSV or YAML.', 'data', 'braces', ['json', 'beautify', 'minify', 'validate', 'tree', 'xml', 'csv', 'yaml']),
  t('cyberchef', 'Data Converter', 'CyberChef-style pipeline: Base64, URL, Hex, HTML entities, SHA-256, MD5, UTF-8.', 'data', 'chef-hat', ['cyberchef', 'encode', 'decode', 'hash', 'sha256', 'md5', 'hex', 'pipeline']),
  t('jwt-decoder', 'JWT Decoder', 'Decode JSON Web Tokens and inspect header, payload and expiry (no signature check).', 'data', 'key-round', ['jwt', 'token', 'bearer', 'auth', 'decode', 'claims']),
  t('regex-tester', 'Regex Tester', 'Test JavaScript regular expressions with live match and group highlighting.', 'data', 'regex', ['regex', 'regexp', 'pattern', 'match', 'groups']),
  t('api-client', 'API Client', 'Send HTTP requests, inspect responses, and keep a request history.', 'data', 'send', ['http', 'rest', 'request', 'fetch', 'postman', 'headers']),

  t('diff-checker', 'Diff Checker', 'Compare two texts side-by-side or unified with highlighted changes.', 'text', 'git-compare', ['diff', 'compare', 'difference', 'merge']),
  t('markdown-editor', 'Markdown Editor', 'Write Markdown with live preview, split view, and HTML/Markdown export.', 'text', 'pen-line', ['markdown', 'md', 'editor', 'preview', 'html']),
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
];

export const getTool = id => TOOLS.find(x => x.id === id) || null;
export const getCategory = id => CATEGORIES.find(c => c.id === id) || null;

/** Search by name, description, keywords; optional category filter. Name hits rank highest. */
export function searchTools(query = '', category = null) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return TOOLS
    .filter(x => !category || x.category === category)
    .map(x => {
      const name = x.name.toLowerCase(), desc = x.description.toLowerCase(), kw = x.keywords.join(' ');
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 10;
        else if (kw.includes(w)) score += 5;
        else if (desc.includes(w)) score += 2;
        else return { x, score: -1 };
      }
      return { x, score };
    })
    .filter(r => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.x);
}
