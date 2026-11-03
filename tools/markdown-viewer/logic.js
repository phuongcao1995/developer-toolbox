// Pure helpers for the Markdown viewer (no DOM access).
export { makeSlugger, slugify, countStats } from '../markdown-editor/logic.js';

export const MAX_BYTES = 5 * 1024 * 1024;
const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;

/**
 * Validate a candidate file by metadata only. Returns { ok } or { ok:false, error }.
 * Accepts .md/.markdown/.txt names or text/* MIME types; rejects >5 MB.
 */
export function validateFile({ name = '', size = 0, type = '' } = {}) {
  if (size > MAX_BYTES) return { ok: false, error: `"${name}" is ${(size / 1048576).toFixed(1)} MB — files larger than 5 MB are not supported.` };
  if (!MD_EXT.test(name) && !/^text\//.test(type)) return { ok: false, error: `"${name}" is not a Markdown/text file. Choose a .md, .markdown or .txt file.` };
  return { ok: true };
}

/** Text content sanity check: NUL bytes or many replacement chars indicate binary data. */
export function looksBinary(text) {
  if (text.includes('\u0000')) return true;
  const sample = text.slice(0, 4000);
  const bad = (sample.match(/�/g) || []).length;
  return sample.length > 0 && bad / sample.length > 0.1;
}

/** Add a `depth` (0-based, relative to the shallowest heading present) to TOC entries for indentation. */
export function tocWithDepth(toc) {
  if (!toc.length) return [];
  const min = Math.min(...toc.map(t => t.level));
  return toc.map(t => ({ ...t, depth: Math.min(t.level - min, 4) }));
}

/** Filename for a pasted document (keeps a real name when given). */
export const downloadName = name => (name && /\.[a-z0-9]+$/i.test(name) ? name : `${name || 'document'}.md`);
