// SQL syntax highlighting built on the formatter's tokenizer. Pure (segments) + a safe DOM renderer (textContent only).
import { tokenize, isSqlKeyword, isSqlFunction, isSqlType } from './logic.js';

/** Highlighting is skipped above this size to keep typing responsive (plain text is shown instead). */
export const HIGHLIGHT_LIMIT = 300000;

const CLASS_OF = { string: 'str', number: 'num', lcomment: 'com', bcomment: 'com', ident: 'idn', placeholder: 'par' };

/**
 * Split `src` into segments {cls, text} that concatenate back to exactly `src`.
 * cls: kw | fn | str | num | com | idn | par | op | '' (plain: whitespace, punctuation, unquoted names).
 */
export function highlightSegments(src, { dialect = 'standard' } = {}) {
  const segs = [];
  const push = (cls, text) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.cls === cls && cls === '') last.text += text; else segs.push({ cls, text });
  };
  if (!src) return segs;
  if (src.length > HIGHLIGHT_LIMIT) return [{ cls: '', text: src }];
  const toks = tokenize(src, { dialect });
  let at = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.pos > at) push('', src.slice(at, t.pos));
    let cls = CLASS_OF[t.type] || '';
    if (t.type === 'word' && t.up) {
      let next = k + 1; // next token (comments do not matter for "name(" detection)
      while (next < toks.length && (toks[next].type === 'lcomment' || toks[next].type === 'bcomment')) next++;
      const call = toks[next]?.text === '(';
      if (call && isSqlFunction(t.up)) cls = 'fn';
      else if (isSqlKeyword(t.up, dialect)) cls = 'kw';
      else if (isSqlType(t.up) && !call) cls = 'kw';
    } else if (t.type === 'op' && !/^[()[\],.;]$/.test(t.text)) cls = 'op';
    push(cls, t.text);
    at = t.pos + t.text.length;
  }
  if (at < src.length) push('', src.slice(at));
  return segs;
}

/** Replace the children of `container` with highlighted spans. `trailingNewline` adds a final "\n" so a last empty line keeps its height. */
export function renderHighlight(container, src, { dialect = 'standard', trailingNewline = false } = {}) {
  const frag = document.createDocumentFragment();
  for (const s of highlightSegments(src, { dialect })) {
    if (!s.cls) { frag.append(document.createTextNode(s.text)); continue; }
    const span = document.createElement('span');
    span.className = `sf-t-${s.cls}`;
    span.textContent = s.text;
    frag.append(span);
  }
  if (trailingNewline) frag.append(document.createTextNode('\n'));
  container.replaceChildren(frag);
}
