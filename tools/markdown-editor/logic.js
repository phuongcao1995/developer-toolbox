// Pure helpers for the Markdown editor (no DOM access).
// Editing actions return an "edit": replace [from,to) of the value with `text`, then select [selStart,selEnd]
// (positions refer to the NEW value). The UI applies it so the browser's undo stack is preserved.

export const applyEdit = (value, e) => value.slice(0, e.from) + e.text + value.slice(e.to);

/** URL/anchor-friendly slug; accents stripped, unicode letters kept. */
export function slugify(text) {
  const s = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s || 'section';
}

/** Returns a function giving unique slugs: intro, intro-1, intro-2 … */
export function makeSlugger() {
  const used = new Set(), counts = new Map();
  return text => {
    const base = slugify(text);
    let slug = base, n = counts.get(base) || 0;
    while (used.has(slug)) slug = `${base}-${++n}`;
    counts.set(base, n); used.add(slug);
    return slug;
  };
}

export function countStats(text) {
  const t = String(text ?? '');
  const words = (t.match(/\S+/g) || []).length;
  return { words, chars: t.length, lines: t === '' ? 0 : t.split('\n').length, minutes: readingMinutes(words) };
}

/** Reading time in whole minutes at 200 wpm (0 for an empty document, otherwise at least 1). */
export const readingMinutes = words => (words > 0 ? Math.max(1, Math.ceil(words / 200)) : 0);

export const escapeHtmlText = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Title for exports: first level-1 heading, else the fallback. */
export function guessTitle(md, fallback = 'Document') {
  const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(String(md ?? ''));
  return m ? m[1].replace(/[*_`~]/g, '') : fallback;
}

const EXPORT_CSS = `:root{color-scheme:light dark;--fg:#1f2430;--bg:#fff;--muted:#566074;--line:#e2e5eb;--code:#f1f3f6;--pre:#f4f6fa;--link:#2f52e0;--th:#f1f3f6;--bq:#cfd5e1}
@media (prefers-color-scheme:dark){:root{--fg:#e6e9ef;--bg:#14171d;--muted:#a3adc0;--line:#2c323d;--code:#222733;--pre:#1b1f27;--link:#8ea6ff;--th:#222733;--bq:#3a4252}}
body{max-width:800px;margin:2rem auto;padding:0 1rem;font:16px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em}h1,h2{border-bottom:1px solid var(--line);padding-bottom:.3em}
a{color:var(--link)}code{background:var(--code);padding:.15em .35em;border-radius:4px;font:.9em ui-monospace,Consolas,monospace}
pre{background:var(--pre);padding:12px 14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:4px solid var(--bq);color:var(--muted)}
table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:6px 12px}th{background:var(--th)}
img{max-width:100%}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-type{color:#d73a49}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-meta .hljs-string{color:#0a7d4b}.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:#005cc5}
.hljs-title,.hljs-section,.hljs-selector-id,.hljs-selector-class,.hljs-name{color:#6f42c1}.hljs-built_in,.hljs-meta{color:#b45309}.hljs-deletion{color:#b31d28}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
@media (prefers-color-scheme:dark){.hljs-comment,.hljs-quote{color:#8b949e}.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-type,.hljs-deletion{color:#ff7b72}
.hljs-string,.hljs-regexp,.hljs-addition{color:#7ee787}.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:#79c0ff}
.hljs-title,.hljs-section,.hljs-selector-id,.hljs-selector-class,.hljs-name{color:#d2a8ff}.hljs-built_in,.hljs-meta{color:#ffa657}}
.toc{border:1px solid var(--line);border-radius:6px;padding:.4em 1em;margin:0 0 2em;background:var(--pre)}.toc h2{border:0;margin:.4em 0;font-size:1.1em}.toc ul{list-style:none;margin:0 0 .6em;padding:0}.toc li{margin:.2em 0}
.toc .l1{margin-left:1.2em}.toc .l2{margin-left:2.4em}.toc .l3{margin-left:3.6em}.toc .l4{margin-left:4.8em}.toc .l5{margin-left:6em}
.md-mermaid{margin:1em 0;padding:8px;overflow:auto;text-align:center;background:var(--pre);border-radius:6px}.md-mermaid svg{max-width:100%;height:auto}
.md-img-missing{color:var(--muted);font-style:italic}pre{tab-size:4}
@media print{body{max-width:none;margin:0}pre{white-space:pre-wrap}.toc{break-inside:avoid}}`;

/** Table-of-contents <nav> for the exported document. `toc` = [{id, level, text}] (ids from the rendered headings). */
export function buildTocHtml(toc) {
  if (!toc?.length) return '';
  const min = Math.min(...toc.map(t => t.level));
  const items = toc.map(t => `<li class="l${Math.min(t.level - min, 5)}"><a href="#${escapeHtmlText(t.id)}">${escapeHtmlText(t.text)}</a></li>`).join('\n');
  return `<nav class="toc" aria-label="Table of contents">\n<h2>Contents</h2>\n<ul>\n${items}\n</ul>\n</nav>\n`;
}

/** Complete standalone HTML document with minimal inline CSS. `bodyHtml` must already be sanitized. opts.toc adds a contents list. */
export function buildHtmlDocument(title, bodyHtml, opts = {}) {
  const toc = opts.toc?.length ? buildTocHtml(opts.toc) : '';
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtmlText(title)}</title>\n<style>\n${EXPORT_CSS}\n</style>\n</head>\n<body>\n${toc}${bodyHtml}\n</body>\n</html>\n`;
}

// ---------- toolbar edits ----------
const lineBounds = (value, start, end) => {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  // A selection ending right after a newline should not drag the next line in.
  const e = end > start && value[end - 1] === '\n' ? end - 1 : end;
  let to = value.indexOf('\n', e);
  if (to === -1) to = value.length;
  return [from, to];
};

/** Wrap selection in `mark` (toggles off if already wrapped). Empty selection inserts a placeholder. */
function wrap(value, s, e, mark, placeholder) {
  const sel = value.slice(s, e), m = mark.length;
  // Already wrapped outside the selection -> unwrap.
  if (value.slice(s - m, s) === mark && value.slice(e, e + m) === mark && s - m >= 0) {
    return { from: s - m, to: e + m, text: sel, selStart: s - m, selEnd: e - m };
  }
  // Selection itself includes the markers -> unwrap.
  if (sel.length >= 2 * m && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(m, sel.length - m);
    return { from: s, to: e, text: inner, selStart: s, selEnd: s + inner.length };
  }
  const body = sel || placeholder;
  return { from: s, to: e, text: mark + body + mark, selStart: s + m, selEnd: s + m + body.length };
}

/** Transform each selected line. `fn(line, index)` returns the new line. */
function mapLines(value, s, e, fn) {
  const [from, to] = lineBounds(value, s, e);
  const text = value.slice(from, to).split('\n').map(fn).join('\n');
  return { from, to, text, selStart: from, selEnd: from + text.length };
}

function prefixLines(value, s, e, regex, make) {
  const [from, to] = lineBounds(value, s, e);
  const lines = value.slice(from, to).split('\n');
  const nonEmpty = lines.filter(l => l.trim() !== '');
  const allHave = nonEmpty.length > 0 && nonEmpty.every(l => regex.test(l)); // toggle off when all lines already prefixed
  let n = 0;
  return mapLines(value, s, e, l => {
    if (allHave) return l.replace(regex, '');
    if (l.trim() === '' && lines.length > 1) return l;
    return make(l.replace(regex, ''), n++);
  });
}

const TABLE = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |';

/** Insert a block (table, hr, code block) on its own lines. */
function insertBlock(value, s, e, block, selectRel) {
  const before = value.slice(0, s), after = value.slice(e);
  const pre = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const post = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const text = pre + block + post;
  const base = s + pre.length;
  return { from: s, to: e, text, selStart: base + (selectRel?.[0] ?? block.length), selEnd: base + (selectRel?.[1] ?? block.length) };
}

/**
 * Compute the edit for a toolbar action.
 * actions: bold italic strike heading link image code codeblock ul ol task quote table hr
 */
export function editFor(action, value, start, end) {
  const sel = value.slice(start, end);
  switch (action) {
    case 'bold': return wrap(value, start, end, '**', 'bold text');
    case 'italic': return wrap(value, start, end, '*', 'italic text');
    case 'strike': return wrap(value, start, end, '~~', 'strikethrough');
    case 'code': return wrap(value, start, end, '`', 'code');
    case 'heading': // cycles none -> # -> ## -> ### -> none
      return mapLines(value, start, end, l => {
        const m = /^(#{1,6})\s+/.exec(l);
        if (!m) return '# ' + l;
        return m[1].length >= 3 ? l.slice(m[0].length) : '#'.repeat(m[1].length + 1) + ' ' + l.slice(m[0].length);
      });
    case 'link': {
      const label = sel || 'link text', url = 'https://';
      const text = `[${label}](${url})`;
      // Select the URL so it can be typed/pasted straight away (or the label if there was no selection).
      return sel
        ? { from: start, to: end, text, selStart: start + label.length + 3, selEnd: start + label.length + 3 + url.length }
        : { from: start, to: end, text, selStart: start + 1, selEnd: start + 1 + label.length };
    }
    case 'image': {
      const alt = sel || 'alt text', text = `![${alt}](https://)`;
      return { from: start, to: end, text, selStart: start + 2, selEnd: start + 2 + alt.length };
    }
    case 'ul': return prefixLines(value, start, end, /^\s*[-*+]\s+(?!\[[ xX]\]\s)/, l => '- ' + l);
    case 'ol': return prefixLines(value, start, end, /^\s*\d+[.)]\s+/, (l, i) => `${i + 1}. ${l}`);
    case 'task': return prefixLines(value, start, end, /^\s*[-*+]\s+\[[ xX]\]\s+/, l => '- [ ] ' + l);
    case 'quote': return prefixLines(value, start, end, /^\s{0,3}>\s?/, l => '> ' + l);
    case 'codeblock': {
      const body = sel || 'code';
      const block = '```\n' + body + '\n```';
      return insertBlock(value, start, end, block, [4, 4 + body.length]);
    }
    case 'table': return insertBlock(value, start, end, TABLE, [2, 10]);
    case 'hr': return insertBlock(value, start, end, '---');
    default: return null;
  }
}

export const SAMPLE = `# Welcome to the Markdown editor

Write on the left, see the preview on the right. **Bold**, *italic*, ~~strikethrough~~ and \`inline code\` all work.

## Lists

- [x] Task lists
- [ ] Tables and code blocks
- Plain bullet

1. First
2. Second

## Code

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Supported |
| --- | --- |
| Tables | yes |
| Links | [Example](https://example.com) |

> Blockquotes work too.
`;

// ---------- front matter ----------
/**
 * Detect a YAML front matter block (--- ... --- or ... at the very top). Returns
 * { raw, body, offset, lineOffset }: `raw` is the YAML text (null when absent), `body` the Markdown after it,
 * `offset` the number of characters removed and `lineOffset` the number of lines removed.
 * The first non-blank line must look like YAML (key:, comment) so a document that merely starts with a rule is left alone.
 */
export function parseFrontMatter(md) {
  const s = String(md ?? '');
  const bom = s.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const text = bom ? s.slice(1) : s;
  const none = { raw: null, body: s, offset: 0, lineOffset: 0 };
  if (!text.startsWith('---')) return none;
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return none;
  const raw = m[1] ?? '';
  const first = raw.split(/\r?\n/).find(l => l.trim() !== '');
  if (first !== undefined && !/^(#|[A-Za-z0-9_"'.$@-][^\n]*?:(\s|$))/.test(first)) return none;
  const consumed = m[0];
  return { raw, body: text.slice(consumed.length), offset: bom + consumed.length, lineOffset: (consumed.match(/\n/g) || []).length };
}

// ---------- table of contents (source based) ----------
const cleanHeading = t => t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, '').replace(/[*_`~]/g, '').trim();

/**
 * Headings of a Markdown source: [{level, text, line, offset}] (line = 0-based line of the whole document, offset = char index).
 * Skips fenced code and the front matter. Handles ATX (#) and setext (=== / ---) headings.
 */
export function buildToc(md) {
  const s = String(md ?? '');
  const fm = parseFrontMatter(s);
  const lines = s.split('\n');
  const out = [];
  let off = 0, fence = null, prev = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, ''), start = off;
    off += lines[i].length + 1;
    if (start < fm.offset) continue;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      prev = null; continue;
    }
    if (f) { fence = { ch: f[1][0], len: f[1].length }; prev = null; continue; }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) { out.push({ level: atx[1].length, text: cleanHeading(atx[2] || ''), line: i, offset: start }); prev = null; continue; }
    const set = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (set && prev) {
      out.push({ level: set[1][0] === '=' ? 1 : 2, text: cleanHeading(prev.text), line: prev.line, offset: prev.offset });
      prev = null; continue;
    }
    const plain = line.trim() !== '' && !/^\s*([-*+>|]|\d+[.)])(\s|$)/.test(line) && !/^( {4}|\t)/.test(line) && !/^\s*<\/?\w/.test(line);
    prev = plain ? { text: line.trim(), line: i, offset: start } : null;
  }
  return out;
}

// ---------- import validation ----------
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const IMPORT_RE = /\.(md|markdown|mdown|mkd|txt)$/i;
/** Metadata check for a file chosen/dropped for import. Returns { ok } or { ok:false, error }. */
export function validateImport({ name = '', size = 0, type = '' } = {}) {
  if (size > MAX_IMPORT_BYTES) return { ok: false, error: `"${name}" is larger than 5 MB.` };
  if (!IMPORT_RE.test(name) && !/^text\//.test(type)) return { ok: false, error: `"${name}" is not a Markdown or text file (.md, .markdown, .txt).` };
  return { ok: true };
}
/** NUL bytes indicate binary content. */
export const hasNul = text => String(text ?? '').includes('\u0000');

// ---------- render scheduling ----------
/** Debounce (ms) for the live preview by document size; null = manual "Render" mode (>= 1 MB). */
export function renderDelay(length) {
  if (length < 100 * 1024) return 120;
  if (length < 1024 * 1024) return 400;
  return null;
}

// ---------- list continuation ----------
const LIST_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
/**
 * Enter pressed with the caret at `pos`: returns an edit continuing the list item on the current line,
 * or clears the marker when the item is empty (exits the list), or null when the line is not a list item
 * (or the caret sits inside the marker) so the browser's default Enter applies.
 */
export function continueList(value, pos) {
  const ls = value.lastIndexOf('\n', pos - 1) + 1;
  let le = value.indexOf('\n', pos);
  if (le === -1) le = value.length;
  const line = value.slice(ls, le).replace(/\r$/, '');
  const m = LIST_RE.exec(line);
  if (!m || pos - ls < m[0].length) return null;
  if (line.slice(m[0].length).trim() === '') return { from: ls, to: ls + line.length, text: '', selStart: ls, selEnd: ls };
  const marker = m[3] !== undefined ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  const text = `\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`;
  return { from: pos, to: pos, text, selStart: pos + text.length, selEnd: pos + text.length };
}

// ---------- indent / outdent ----------
/** Indent every line touched by the selection [s,e]. Blank lines are left alone. */
export function indentEdit(value, s, e, unit = '  ') {
  const [from, to] = lineBounds(value, s, e);
  const lines = value.slice(from, to).split('\n');
  const text = lines.map(l => (l === '' ? l : unit + l)).join('\n');
  const startAdd = lines[0] === '' ? 0 : unit.length;
  return { from, to, text, selStart: s === from ? from : s + startAdd, selEnd: e + (text.length - (to - from)) };
}

/** Remove one indent level (a tab, or up to unit.length spaces) from every line touched by [s,e]. Null if nothing to remove. */
export function outdentEdit(value, s, e, unit = '  ') {
  const [from, to] = lineBounds(value, s, e);
  const lines = value.slice(from, to).split('\n');
  const width = Math.max(1, unit.length);
  const removed = lines.map(l => (l[0] === '\t' ? 1 : (new RegExp(`^ {1,${width}}`).exec(l)?.[0].length ?? 0)));
  if (!removed.some(Boolean)) return null;
  const text = lines.map((l, i) => l.slice(removed[i])).join('\n');
  const map = p => {
    let acc = from, shift = 0;
    for (let i = 0; i < lines.length; i++) {
      const le = acc + lines[i].length;
      if (p <= le || i === lines.length - 1) return p - shift - Math.min(removed[i], Math.max(0, p - acc));
      shift += removed[i]; acc = le + 1;
    }
    return p - shift;
  };
  return { from, to, text, selStart: map(s), selEnd: map(e) };
}

// ---------- find & replace ----------
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function makeRe(query, { caseSensitive = false, regex = false } = {}, extra = 'g') {
  return new RegExp(regex ? query : escapeRe(query), extra + (caseSensitive ? '' : 'i') + (regex ? 'm' : ''));
}
/** All matches: { matches:[{index,length}], error }. Invalid regex -> error string. Capped at `limit`. */
export function findMatches(text, query, opts = {}, limit = 10000) {
  if (!query) return { matches: [], error: null };
  let re;
  try { re = makeRe(query, opts); } catch (e) { return { matches: [], error: e.message }; }
  const matches = [];
  let m;
  while (matches.length < limit && (m = re.exec(text))) {
    matches.push({ index: m.index, length: m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return { matches, error: null };
}
function expandReplacement(repl, m, text) {
  return repl.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]+)>)/g, (x, a, name) => {
    if (a === '$') return '$';
    if (a === '&') return m[0];
    if (a === '`') return text.slice(0, m.index);
    if (a === "'") return text.slice(m.index + m[0].length);
    if (name !== undefined) return m.groups?.[name] ?? '';
    const n = Number(a);
    return n >= 1 && n < m.length ? (m[n] ?? '') : x;
  });
}
/** Edit replacing the match that starts at `index` (regex mode expands $1, $&, $<name>). Null if no match starts there. */
export function replaceAt(text, query, repl, opts, index) {
  if (!query) return null;
  let re;
  try { re = makeRe(query, opts, 'y'); } catch { return null; }
  re.lastIndex = index;
  const m = re.exec(text);
  if (!m) return null;
  const out = opts?.regex ? expandReplacement(repl, m, text) : repl;
  return { from: index, to: index + m[0].length, text: out };
}
/** Replace every match. Returns { text, count, error }. */
export function replaceAll(text, query, repl, opts = {}) {
  if (!query) return { text, count: 0, error: null };
  let re;
  try { re = makeRe(query, opts); } catch (e) { return { text, count: 0, error: e.message }; }
  let count = 0;
  const out = text.replace(re, opts.regex ? (...a) => {
    count++;
    const hasGroups = typeof a[a.length - 1] === 'object';
    const groups = hasGroups ? a[a.length - 1] : undefined;
    const tail = hasGroups ? 3 : 2; // [..., offset, string, groups?]
    const m = Object.assign(a.slice(0, a.length - tail), { index: a[a.length - tail], groups });
    return expandReplacement(repl, m, text);
  } : () => { count++; return repl; });
  return { text: out, count, error: null };
}

// ---------- scroll mapping ----------
/** Piecewise-linear map of `v` through sorted anchor pairs [[from,to],...] (clamped, tolerant of duplicate keys). */
export function interpolate(anchors, v) {
  if (!anchors.length) return v;
  if (v <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [a0, b0] = anchors[i - 1], [a1, b1] = anchors[i];
    if (v <= a1) return a1 === a0 ? b1 : b0 + ((v - a0) / (a1 - a0)) * (b1 - b0);
  }
  return anchors[anchors.length - 1][1];
}
