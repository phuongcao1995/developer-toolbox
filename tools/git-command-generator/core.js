// Git Command Generator - core helpers (no DOM): shell quoting, ref-name validation, field validation, builder context.
// The tool only ever PRINTS commands; nothing is executed.

export const SHELLS = { posix: 'Bash / Zsh / Git Bash', powershell: 'PowerShell', cmd: 'Command Prompt (cmd.exe)' };

const PH = '\u0001'; // marks an unfilled placeholder such as <branch>; rendered raw, never quoted
export const placeholder = label => `${PH}<${label}>`;
export const isPlaceholder = s => typeof s === 'string' && s.includes(PH);

/** Quote one argument for the given shell ('posix' | 'powershell' | 'cmd'). Placeholders are returned unquoted. */
export function quoteArg(s, shell = 'posix') {
  s = String(s);
  if (s.includes(PH)) return s.split(PH).join('');
  if (shell === 'cmd') {
    if (s === '') return '""';
    if (/^[A-Za-z0-9_@+=:,./\\~-]+$/.test(s)) return s;
    return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }
  if (shell === 'powershell') {
    if (s === '') return "''";
    if (/^[A-Za-z0-9_+=:./~-][A-Za-z0-9_@+=:./~-]*$/.test(s)) return s;
    return `'${s.replace(/['‘’‚‛]/g, m => m + m)}'`;
  }
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./][A-Za-z0-9_@%+=:,./~-]*$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A user-supplied value (optionally glued to a flag prefix such as --author=). Raw strings in token lists are flags/subcommands. */
export const Q = (v, prefix = '') => ({ q: String(v), p: prefix });
export function renderTokens(tokens, shell = 'posix') {
  return tokens.map(t => {
    if (typeof t === 'string') return t;
    if (!t.p) return quoteArg(t.q, shell);
    // flag=value: leave bare when the value needs no quoting, otherwise quote the whole token
    return quoteArg(t.q, shell) === t.q || t.q.includes(PH) ? t.p + quoteArg(t.q, shell) : quoteArg(t.p + t.q, shell);
  }).join(' ');
}
export const COMMENT_PREFIX = { posix: '# ', powershell: '# ', cmd: 'REM ' };

// ---------- ref names (git check-ref-format) ----------
/**
 * Implements the rules of `git check-ref-format` for branch / tag names:
 * no ".." ; no ASCII control chars, space, ~ ^ : ? * [ \ ; no component starting with "." or ending ".lock";
 * no leading/trailing "/" or "//" ; no trailing "." ; no "@{" ; not the single character "@"; cannot start with "-".
 * `allowOneLevel` is true for branch/tag names (a single component such as "main").
 */
export function validateRefName(name, { allowOneLevel = true } = {}) {
  const s = String(name ?? '');
  if (s === '') return { ok: false, error: 'Name is empty.' };
  if (s === '@') return { ok: false, error: 'The single character "@" is not a valid ref name.' };
  if (s.startsWith('-')) return { ok: false, error: 'A name cannot start with "-" (it would be read as a command-line option).' };
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return { ok: false, error: 'Control characters are not allowed.' };
    if (ch === ' ') return { ok: false, error: 'Spaces are not allowed (use - or _).' };
    if ('~^:?*[\\'.includes(ch)) return { ok: false, error: `The character "${ch}" is not allowed in ref names.` };
  }
  if (s.includes('..')) return { ok: false, error: 'Two consecutive dots ".." are not allowed.' };
  if (s.includes('@{')) return { ok: false, error: 'The sequence "@{" is not allowed.' };
  if (s.startsWith('/') || s.endsWith('/')) return { ok: false, error: 'A name cannot start or end with "/".' };
  if (s.includes('//')) return { ok: false, error: 'Consecutive slashes "//" are not allowed.' };
  if (s.endsWith('.')) return { ok: false, error: 'A name cannot end with a dot.' };
  const parts = s.split('/');
  for (const p of parts) {
    if (p.startsWith('.')) return { ok: false, error: 'No path component may start with a dot.' };
    if (p.endsWith('.lock')) return { ok: false, error: 'No path component may end with ".lock".' };
  }
  if (!allowOneLevel && parts.length < 2) return { ok: false, error: 'Needs at least one "/" (for example refs/heads/main).' };
  return { ok: true };
}

/** Looser check for revisions: hashes, HEAD~3, main..feature, HEAD@{1}, origin/main, v1.0^{commit}, :/message. */
export function validateRevision(rev) {
  const s = String(rev ?? '');
  if (s === '') return { ok: false, error: 'Revision is empty.' };
  if (s.startsWith('-')) return { ok: false, error: 'A revision cannot start with "-" (it would be read as an option).' };
  if (/[\s\u0000-\u001f\u007f\\]/.test(s)) return { ok: false, error: 'Revisions cannot contain spaces, control characters or backslashes.' };
  if (/[?*[]/.test(s) && !/^:\//.test(s)) return { ok: false, error: 'Wildcard characters are not allowed in a revision.' };
  return { ok: true };
}

export function validateRemoteName(name) {
  const s = String(name ?? '');
  if (!s) return { ok: false, error: 'Remote name is empty.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return { ok: false, error: 'Remote names use letters, digits, ".", "_" and "-" and cannot start with "-" or ".".' };
  if (s.endsWith('.lock') || s.includes('..')) return { ok: false, error: 'Remote name is not a valid ref component.' };
  return { ok: true };
}

export function validateUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return { ok: false, error: 'URL is empty.' };
  if (/\s/.test(s)) return { ok: false, error: 'URLs cannot contain spaces.' };
  if (s.startsWith('-')) return { ok: false, error: 'A URL cannot start with "-" (it would be read as an option).' };
  if (/^(ext|fd)::/i.test(s)) return { ok: false, error: 'ext:: and fd:: transports can run arbitrary commands and are not supported here.' };
  if (/^(https?|ssh|git|file|ftps?):\/\/[^/]+/i.test(s) || /^file:\/\/\//i.test(s)) return { ok: true };
  if (/^[\w.-]+@[\w.-]+:[^\s]*$/.test(s)) return { ok: true }; // scp-like git@host:org/repo.git
  if (/^([A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)/.test(s)) return { ok: true }; // local path
  return { ok: false, error: 'Use https://host/path.git, ssh://host/path.git, git@host:path.git or a local path.' };
}

export const validateEmail = s => (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s ?? '')) ? { ok: true } : { ok: false, error: 'Enter an email address like name@example.com.' });

/** Validate one field value. Returns null when fine, otherwise an error string. Empty optional values are fine. */
export function validateValue(field, value, { required = field.req } = {}) {
  const t = field.type;
  if (t === 'check') return null;
  const v = value == null ? '' : String(value);
  if (!v.trim()) return required ? 'Required.' : null;
  const wrap = r => (r.ok ? null : r.error);
  switch (t) {
    case 'ref': return wrap(validateRefName(v.trim()));
    case 'refpath': return wrap(validateRefName(v.trim()));
    case 'rev': return wrap(validateRevision(v.trim()));
    case 'revs': { for (const x of v.trim().split(/\s+/)) { const r = validateRevision(x); if (!r.ok) return `"${x}": ${r.error}`; } return null; }
    case 'remote': return wrap(validateRemoteName(v.trim()));
    case 'url': return wrap(validateUrl(v));
    case 'email': return wrap(validateEmail(v.trim()));
    case 'int': return /^\d+$/.test(v.trim()) && Number(v) >= (field.min ?? 0) ? null : `Enter a whole number${field.min ? ` of at least ${field.min}` : ''}.`;
    case 'path': return /[\u0000\n\r]/.test(v) ? 'Paths cannot contain line breaks or NUL.' : null;
    case 'paths': return /\u0000/.test(v) ? 'Paths cannot contain NUL.' : null;
    case 'select': return field.options.some(o => o[0] === v) ? null : 'Choose one of the listed options.';
    case 'key': return /^[A-Za-z][A-Za-z0-9-]*(\.[^\s.=]+)*\.[A-Za-z][A-Za-z0-9-]*$/.test(v.trim()) ? null : 'Use section.key or section.subsection.key, for example user.name.';
    case 'alias': return /^[A-Za-z][A-Za-z0-9_-]*$/.test(v.trim()) ? null : 'Alias names use letters, digits, "-" and "_".';
    case 'text': return /[\u0000\n\r]/.test(v) ? 'Line breaks are not allowed here.' : null;
    case 'date': return /[\u0000\n\r]/.test(v) ? 'Invalid date.' : null;
    case 'textarea': return /\u0000/.test(v) ? 'NUL is not allowed.' : null;
    default: return null;
  }
}

/** Split a pasted list (one per line, or whitespace separated when `spaces`) into non-empty entries. */
export const splitLines = s => String(s ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);

/** Commit message -> tokens: one -m per paragraph (git joins them with blank lines). */
export function messageTokens(msg, flag = '-m') {
  const paras = String(msg).replace(/\r\n/g, '\n').trim().split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
  return paras.flatMap(p => [flag, Q(p)]);
}

/** Builder context handed to every task's build(). Collects commands, flag docs, danger, undo hints, alternatives and notes. */
export function createBuilder() {
  const b = {
    steps: [], flags: [], dangers: [], undoHints: [], alts: [], notes: [], warnings: [],
    git(...tokens) { const t = tokens.flat().filter(x => x != null && x !== false && x !== ''); b.steps.push({ tokens: ['git', ...t] }); return b; },
    sh(...tokens) { b.steps.push({ tokens: tokens.flat().filter(x => x != null && x !== false && x !== '') }); return b; },
    comment(text) { b.steps.push({ tokens: [], comment: text }); return b; },
    say(text) { const last = b.steps[b.steps.length - 1]; if (last && last.tokens.length && !last.comment) last.comment = text; else b.comment(text); return b; },
    flag(name, text) { if (!b.flags.some(f => f[0] === name)) b.flags.push([name, text]); return b; },
    danger(level, what, undo) { b.dangers.push({ level, what, undo }); return b; },
    undo(text) { b.undoHints.push(text); return b; },
    alt(text) { b.alts.push(text); return b; },
    note(text) { b.notes.push(text); return b; },
    warn(text) { b.warnings.push(text); return b; },
  };
  return b;
}
