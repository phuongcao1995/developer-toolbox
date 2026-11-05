// Text Pad - pure logic (no DOM).

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/** Count words (Unicode aware when Intl.Segmenter exists, whitespace split otherwise). */
export function countWords(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 0;
  if (segmenter) { let n = 0; for (const seg of segmenter.segment(s)) if (seg.isWordLike) n++; return n; }
  return s.trim().split(/\s+/).length;
}

/** Text statistics. readMinutes assumes 200 words per minute, speakMinutes 130. */
export function textStats(text) {
  const s = String(text ?? '');
  const words = countWords(s);
  const trimmed = s.trim();
  return {
    chars: [...s].length,
    charsNoSpaces: [...s.replace(/\s/g, '')].length,
    words,
    lines: s === '' ? 0 : s.split(/\r\n|\r|\n/).length,
    paragraphs: trimmed ? trimmed.split(/(?:\r?\n[ \t]*){2,}/).length : 0,
    sentences: trimmed ? (trimmed.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || []).filter(x => x.trim()).length : 0,
    readMinutes: words / 200,
    speakMinutes: words / 130,
  };
}

/** "0 min", "<1 min", "3 min", "1 h 5 min". */
export function formatDuration(minutes) {
  if (!(minutes > 0)) return '0 min';
  if (minutes < 1) return '<1 min';
  const m = Math.round(minutes);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const LINES = /\r\n|\r|\n/;

export const TRANSFORMS = {
  upper: s => s.toUpperCase(),
  lower: s => s.toLowerCase(),
  title: s => s.toLowerCase().replace(/(^|[\s"'(\[{-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()),
  sentence: s => s.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()),
  trim: s => s.split(LINES).map(l => l.replace(/[ \t]+$/g, '')).join('\n').trim(),
  'collapse-spaces': s => s.replace(/[ \t]{2,}/g, ' '),
  'remove-blank-lines': s => s.split(LINES).filter(l => l.trim()).join('\n'),
  'sort-lines': s => s.split(LINES).sort((a, b) => a.localeCompare(b)).join('\n'),
  'unique-lines': s => [...new Set(s.split(LINES))].join('\n'),
  'reverse-lines': s => s.split(LINES).reverse().join('\n'),
};

/** Apply a named transform to the whole text, or to the [start, end) selection when it is non-empty. */
export function applyTransform(name, text, start = 0, end = start) {
  const fn = TRANSFORMS[name];
  if (!fn) throw new Error(`Unknown transform: ${name}`);
  if (start === end) return { text: fn(text), selStart: 0, selEnd: 0 };
  const mid = fn(text.slice(start, end));
  return { text: text.slice(0, start) + mid + text.slice(end), selStart: start, selEnd: start + mid.length };
}

/** Safe .txt file name derived from the first non-empty line. */
export function suggestFileName(text, fallback = 'text-pad') {
  const first = String(text ?? '').split(LINES).find(l => l.trim()) || '';
  const base = first.replace(/^#+\s*/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().replace(/\s+/g, '-').slice(0, 40).replace(/[-.]+$/, '');
  return (base || fallback) + '.txt';
}
