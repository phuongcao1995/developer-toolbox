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
  return { words, chars: t.length, lines: t === '' ? 0 : t.split('\n').length };
}

export const escapeHtmlText = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Title for exports: first level-1 heading, else the fallback. */
export function guessTitle(md, fallback = 'Document') {
  const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(String(md ?? ''));
  return m ? m[1].replace(/[*_`~]/g, '') : fallback;
}

const EXPORT_CSS = `body{max-width:800px;margin:2rem auto;padding:0 1rem;font:16px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2430}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em}h1,h2{border-bottom:1px solid #e2e5eb;padding-bottom:.3em}
a{color:#2f52e0}code{background:#f1f3f6;padding:.15em .35em;border-radius:4px;font:.9em ui-monospace,Consolas,monospace}
pre{background:#f4f6fa;padding:12px 14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:4px solid #cfd5e1;color:#566074}
table{border-collapse:collapse}th,td{border:1px solid #d5dae3;padding:6px 12px}th{background:#f1f3f6}
img{max-width:100%}hr{border:0;border-top:1px solid #e2e5eb;margin:2em 0}`;

/** Complete standalone HTML document with minimal inline CSS. `bodyHtml` must already be sanitized. */
export function buildHtmlDocument(title, bodyHtml) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtmlText(title)}</title>\n<style>\n${EXPORT_CSS}\n</style>\n</head>\n<body>\n${bodyHtml}\n</body>\n</html>\n`;
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
