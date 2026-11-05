// Chmod Calculator - pure logic (no DOM). A mode is an integer 0..4095 (0o7777):
//   0o4000 setuid, 0o2000 setgid, 0o1000 sticky, then rwx for owner (0o700), group (0o070), other (0o007).

export const SETUID = 0o4000, SETGID = 0o2000, STICKY = 0o1000;
export const CLASSES = ['owner', 'group', 'other'];
export const CLASS_LETTER = { owner: 'u', group: 'g', other: 'o' };
export const CLASS_SHIFT = { owner: 6, group: 3, other: 0 };
export const FILE_TYPES = { '-': 'regular file', d: 'directory', l: 'symbolic link', c: 'character device', b: 'block device', p: 'named pipe (FIFO)', s: 'socket', D: 'door', C: 'high-performance file', M: 'migrated file', n: 'network special file', P: 'port' };

const isMode = m => Number.isInteger(m) && m >= 0 && m <= 0o7777;

// ---------- octal ----------
/** Mode -> octal string. 3 digits when no special bit is set, otherwise 4 (or always 4 with pad4). */
export function modeToOctal(mode, { pad4 = false } = {}) {
  if (!isMode(mode)) throw new RangeError('mode must be an integer 0..4095');
  const s = mode.toString(8);
  return pad4 || mode > 0o777 ? s.padStart(4, '0') : s.padStart(3, '0');
}

/** Parse an octal mode string (1-4 digits, optional 0o prefix). Returns {ok, mode} or {ok:false, error}. */
export function parseOctal(input) {
  let s = String(input ?? '').trim();
  if (!s) return { ok: false, error: 'Enter an octal mode such as 644 or 4755.' };
  if (/^0o/i.test(s)) s = s.slice(2);
  if (!/^[0-9]+$/.test(s)) {
    const bad = [...s].find(c => !/[0-7]/.test(c));
    return { ok: false, error: `"${bad}" is not an octal digit. Use only digits 0-7 (for example 644 or 1777).` };
  }
  if (/[89]/.test(s)) return { ok: false, error: 'Octal digits are 0-7; the digits 8 and 9 are not allowed.' };
  if (s.length > 4) return { ok: false, error: `Too long: a mode has at most 4 octal digits (special, owner, group, other); got ${s.length}.` };
  return { ok: true, mode: parseInt(s, 8) };
}

// ---------- symbolic string (as printed by ls -l) ----------
/** Mode -> 9 characters like rwxr-sr-t. Applies the s/S and t/T rules. fileType adds a leading type char. */
export function modeToSymbolic(mode, { fileType = null } = {}) {
  if (!isMode(mode)) throw new RangeError('mode must be an integer 0..4095');
  let out = '';
  for (const [i, cls] of CLASSES.entries()) {
    const b = (mode >> CLASS_SHIFT[cls]) & 7;
    const x = b & 1;
    let xc = x ? 'x' : '-';
    if (i === 0 && mode & SETUID) xc = x ? 's' : 'S';
    if (i === 1 && mode & SETGID) xc = x ? 's' : 'S';
    if (i === 2 && mode & STICKY) xc = x ? 't' : 'T';
    out += (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + xc;
  }
  return (fileType || '') + out;
}

/**
 * Parse rwxr-xr-x style text, optionally preceded by a file type char (-rwxr-xr-x, drwxr-sr-t) and optionally followed
 * by ls markers (. + @). Returns {ok, mode, type} or {ok:false, error}.
 */
export function parseSymbolic(input) {
  let s = String(input ?? '').trim();
  if (!s) return { ok: false, error: 'Enter a 9-character mode such as rwxr-xr-x (a leading file type character like - or d is optional).' };
  s = s.replace(/[.+@]$/, '');
  let type = null;
  if (s.length === 10) { type = s[0]; if (!/^[-dlcbpsDCMnP?]$/.test(type)) return { ok: false, error: `"${type}" is not a known file type character (use - d l c b p s).` }; s = s.slice(1); }
  if (s.length !== 9) return { ok: false, error: `Expected 9 permission characters (3 per class), got ${s.length}. Example: rwxr-xr-x.` };
  const allowed = [['r-', 'r'], ['w-', 'w'], ['xsStT-', 'x']];
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    const c = s[i], pos = i % 3, cls = Math.floor(i / 3);
    const want = ['r', 'w', 'x or s/S/t/T'][pos];
    const okChars = pos < 2 ? allowed[pos][0] : (cls === 2 ? 'xtT-' : 'xsS-');
    if (!okChars.includes(c)) {
      const hint = pos === 2 && 'sStT'.includes(c) ? ` ("${c}" is only valid in the ${c === 's' || c === 'S' ? 'owner or group' : 'other'} execute position)` : '';
      return { ok: false, error: `Invalid character "${c}" at position ${i + 1} (${CLASSES[cls]} ${['read', 'write', 'execute'][pos]}): expected ${pos < 2 ? `${want} or -` : okChars.split('').join(', ')}.${hint}` };
    }
    const sh = CLASS_SHIFT[CLASSES[cls]];
    if (pos === 0 && c === 'r') mode |= 4 << sh;
    if (pos === 1 && c === 'w') mode |= 2 << sh;
    if (pos === 2) {
      if (c === 'x' || c === 's' || c === 't') mode |= 1 << sh;
      if (c === 's' || c === 'S') mode |= cls === 0 ? SETUID : SETGID;
      if (c === 't' || c === 'T') mode |= STICKY;
    }
  }
  return { ok: true, mode, type };
}

// ---------- plain-English explanation ----------
const list = a => (a.length <= 1 ? a.join('') : a.length === 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const WHO = { owner: 'Owner (user)', group: 'Group', other: 'Others (everyone else)' };

/** Explain one class: "Owner can read, write and execute." isDir switches the wording for directories. */
export function explainClass(mode, cls, { isDir = false } = {}) {
  const b = (mode >> CLASS_SHIFT[cls]) & 7;
  const acts = [];
  if (b & 4) acts.push(isDir ? 'list the names inside' : 'read');
  if (b & 2) acts.push(isDir ? 'create, rename and delete entries in' : 'write');
  if (b & 1) acts.push(isDir ? 'enter (cd into / access files in)' : 'execute');
  const who = WHO[cls];
  if (!acts.length) return `${who} have no access${isDir ? ' to this directory' : ''}.`;
  return isDir ? `${who} can ${list(acts)} the directory.` : `${who} can ${list(acts)}.`;
}

/** Descriptions of the special bits that are set (empty array when none). */
export function explainSpecial(mode, { isDir = false } = {}) {
  const out = [];
  if (mode & SETUID) out.push(isDir ? 'Setuid on a directory is ignored by Linux (some BSDs use it differently).' : 'Setuid: the program runs with the file owner\'s privileges instead of the caller\'s.');
  if (mode & SETGID) out.push(isDir ? 'Setgid: new files and subdirectories inherit the directory\'s group (and subdirectories inherit setgid).' : 'Setgid: the program runs with the file group\'s privileges (on some systems also affects mandatory locking).');
  if (mode & STICKY) out.push(isDir ? 'Sticky bit: only a file\'s owner, the directory owner or root may delete or rename entries, even if others can write the directory (as in /tmp).' : 'Sticky bit on a regular file has no effect on modern systems.');
  return out;
}

/** Full explanation: {classes:[{cls,text}], special:[...]}. */
export function explainMode(mode, opts = {}) {
  return { classes: CLASSES.map(cls => ({ cls, text: explainClass(mode, cls, opts) })), special: explainSpecial(mode, opts) };
}

/** Security / usability audit: [{level:'danger'|'warn'|'info', text}]. */
export function auditMode(mode, { isDir = false } = {}) {
  const out = [];
  const o = mode & 7, g = (mode >> 3) & 7, u = (mode >> 6) & 7;
  if (o & 2) {
    if (isDir && mode & STICKY) out.push({ level: 'info', text: 'World-writable directory with the sticky bit: acceptable for shared scratch areas like /tmp, because users can only delete their own entries.' });
    else out.push({ level: 'danger', text: 'World-writable: any user or process on the system can modify this' + (isDir ? ' directory\'s contents' : ' file') + '. Avoid; fix the owner/group instead of opening permissions.' });
  }
  if (mode & SETUID) out.push({ level: !isDir && (u & 1) ? 'warn' : 'info', text: !isDir && (u & 1) ? 'Setuid executable: runs as its owner. Dangerous if the file is writable by others or is a script (kernels ignore setuid on interpreted scripts on Linux, and race conditions make it unsafe).' : (isDir ? 'Setuid on a directory has no effect on Linux.' : 'Setuid without owner execute (shown as S) does nothing useful.') });
  if (mode & SETGID && !isDir && (g & 1)) out.push({ level: 'warn', text: 'Setgid executable: runs with the file\'s group privileges; review for privilege escalation.' });
  if (mode & SETGID && !isDir && !(g & 1)) out.push({ level: 'info', text: 'Setgid without group execute (shown as S) marks mandatory locking on some systems; usually unintended.' });
  if (mode & STICKY && !isDir) out.push({ level: 'info', text: 'Sticky bit on a regular file is ignored on Linux; it is only meaningful on directories.' });
  if (g & 2 && !(o & 2)) out.push({ level: 'info', text: 'Group-writable: every member of the file\'s group can modify it. Intended for shared project directories; combine with setgid on directories.' });
  if (isDir && ((u & 4) && !(u & 1))) out.push({ level: 'warn', text: 'Owner can list this directory but not enter it (read without execute): names are visible but files cannot be opened.' });
  if (isDir && !(u & 1) && !(g & 1) && !(o & 1)) out.push({ level: 'warn', text: 'No one has execute (search) permission on this directory, so nobody (except root) can access anything inside it.' });
  if (!isDir && (u & 1) && !(u & 4) ) out.push({ level: 'info', text: 'Execute without read: binaries run, but scripts cannot be interpreted without read permission.' });
  if (!isDir && (o & 4) && !(g & 4)) out.push({ level: 'info', text: 'Others can read but the group cannot: unusual, since the group is normally at least as privileged as others.' });
  if (!isDir && (u & 2) === 0 && mode !== 0 && (g & 2 || o & 2)) out.push({ level: 'info', text: 'Owner cannot write but others can: unusual permission shape.' });
  if (mode === 0) out.push({ level: 'info', text: 'No permissions for anyone: only root can access it (owner can still chmod it back).' });
  const order = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------- symbolic mode expressions ----------
/**
 * Parse an expression such as u+x, go-w, a=r, u=g, +X, ugo+rx,o-w, u=rwx,g=rx,o=rx.
 * Returns {ok, clauses:[{who, ops:[{op, perms, copy}]}]} or {ok:false, error, at}.
 * perms is a subset of 'rwxXst'; copy is 'u'|'g'|'o' when the right-hand side is another class.
 */
export function parseSymbolicExpr(input) {
  const src = String(input ?? '').trim();
  if (!src) return { ok: false, error: 'Enter a symbolic mode such as u+x, go-w or a=r.', at: 0 };
  const clauses = [];
  let pos = 0;
  const parts = src.split(',');
  for (const part of parts) {
    if (part === '') return { ok: false, error: `Empty clause near position ${pos + 1}: remove the extra comma.`, at: pos };
    let i = 0, who = '';
    while (i < part.length && 'ugoa'.includes(part[i])) { if (!who.includes(part[i])) who += part[i]; i++; }
    if (i >= part.length || !'+-='.includes(part[i])) {
      const c = part[i];
      return { ok: false, error: c === undefined ? `Clause "${part}" needs an operator (+, - or =) after the user classes.` : `Unexpected "${c}" at position ${pos + i + 1}: expected one of + - = (after the optional u, g, o, a letters).`, at: pos + i };
    }
    const ops = [];
    while (i < part.length) {
      const op = part[i];
      if (!'+-='.includes(op)) return { ok: false, error: `Unexpected "${op}" at position ${pos + i + 1}: expected + - or =.`, at: pos + i };
      i++;
      let perms = '', copy = null;
      if (i < part.length && 'ugo'.includes(part[i])) {
        copy = part[i]; i++;
        if (i < part.length && !'+-='.includes(part[i])) return { ok: false, error: `"${part[i - 1]}" copies another class's permissions and cannot be combined with letters (found "${part[i]}" at position ${pos + i + 1}).`, at: pos + i };
      } else {
        while (i < part.length && !'+-='.includes(part[i])) {
          const c = part[i];
          if (!'rwxXst'.includes(c)) return { ok: false, error: `Invalid permission letter "${c}" at position ${pos + i + 1}. Allowed: r w x X s t, or u g o to copy.`, at: pos + i };
          if (!perms.includes(c)) perms += c;
          i++;
        }
      }
      ops.push({ op, perms, copy });
    }
    clauses.push({ who, ops });
    pos += part.length + 1;
  }
  return { ok: true, clauses };
}

/**
 * Apply a symbolic expression to a starting mode (GNU chmod semantics).
 *  - omitted who: acts like "a" but permission bits set in umask are left alone for + and =
 *  - X: execute only if the target is a directory or already has an execute bit for someone
 *  - u/g/o on the right-hand side copies that class's rwx as it was before this clause
 *  - s applies to setuid for u and setgid for g; t (sticky) applies to o and a
 * Returns {ok, mode, steps:[{clause, before, after}]} or {ok:false, error}.
 */
export function applySymbolic(expr, startMode = 0, { umask = 0o022, isDir = false } = {}) {
  if (!isMode(startMode)) return { ok: false, error: 'Starting mode must be between 0 and 7777 octal.' };
  const p = parseSymbolicExpr(expr);
  if (!p.ok) return p;
  let mode = startMode;
  const steps = [];
  const clauseTexts = String(expr).trim().split(',');
  p.clauses.forEach((cl, idx) => {
    const before = mode;
    const explicit = cl.who.length > 0;
    const who = explicit ? cl.who : 'a';
    const classes = new Set();
    for (const w of who) { if (w === 'a') { classes.add('u'); classes.add('g'); classes.add('o'); } else classes.add(w); }
    // bits the clause may touch
    let affected = 0;
    for (const c of classes) affected |= { u: 0o700 | SETUID, g: 0o070 | SETGID, o: 0o007 }[c];
    if (classes.has('o')) affected |= STICKY;
    for (const { op, perms, copy } of cl.ops) {
      let value = 0;
      if (copy) {
        const src = (mode >> CLASS_SHIFT[{ u: 'owner', g: 'group', o: 'other' }[copy]]) & 7;
        for (const c of classes) value |= src << CLASS_SHIFT[{ u: 'owner', g: 'group', o: 'other' }[c]];
      } else {
        let bits = 0;
        for (const ch of perms) {
          if (ch === 'r') bits |= 4; else if (ch === 'w') bits |= 2; else if (ch === 'x') bits |= 1;
          else if (ch === 'X' && (isDir || (mode & 0o111))) bits |= 1;
        }
        for (const c of classes) value |= bits << CLASS_SHIFT[{ u: 'owner', g: 'group', o: 'other' }[c]];
        if (perms.includes('s')) { if (classes.has('u')) value |= SETUID; if (classes.has('g')) value |= SETGID; }
        if (perms.includes('t') && (classes.has('o'))) value |= STICKY;
      }
      let eff = value, mask = affected;
      if (!explicit && op !== '-') { eff &= ~umask & 0o777 | (value & 0o7000); mask = affected & (~umask | 0o7000); }
      if (op === '+') mode |= eff;
      else if (op === '-') mode &= ~eff;
      else mode = (mode & ~mask) | eff;
    }
    steps.push({ clause: clauseTexts[idx], before, after: mode });
  });
  return { ok: true, mode, steps };
}

/** Compact symbolic chmod argument for an exact mode, e.g. u=rwx,go=rx or u=rwxs,g=rx,o=rwxt. */
export function modeToSymbolicExpr(mode) {
  if (!isMode(mode)) throw new RangeError('mode must be an integer 0..4095');
  const per = CLASSES.map((cls, i) => {
    const b = (mode >> CLASS_SHIFT[cls]) & 7;
    let s = (b & 4 ? 'r' : '') + (b & 2 ? 'w' : '') + (b & 1 ? 'x' : '');
    if (i === 0 && mode & SETUID) s += 's';
    if (i === 1 && mode & SETGID) s += 's';
    if (i === 2 && mode & STICKY) s += 't';
    return s;
  });
  const letters = ['u', 'g', 'o'];
  const groups = [];
  per.forEach((s, i) => {
    const g = groups.find(x => x.s === s);
    if (g) g.who += letters[i]; else groups.push({ s, who: letters[i] });
  });
  if (groups.length === 1 && groups[0].who === 'ugo' && !(mode & 0o7000)) return `a=${groups[0].s}`;
  return groups.map(g => `${g.who}=${g.s}`).join(',');
}

// ---------- shell quoting ----------
/** POSIX single-quote an argument only when needed. */
export function shellQuote(s) {
  s = String(s);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
const findPath = p => (p.startsWith('-') || /^[!(]/.test(p) ? './' + p : p);

/** Build `chmod ...` for a mode. opts: path, form 'numeric'|'symbolic', recursive, verbose, changes. */
export function chmodCommand(mode, { path = 'file', form = 'numeric', recursive = false, verbose = false, changes = false } = {}) {
  const flags = (recursive ? 'R' : '') + (verbose ? 'v' : '') + (changes ? 'c' : '');
  const modeArg = form === 'symbolic' ? modeToSymbolicExpr(mode) : modeToOctal(mode);
  const p = String(path ?? '');
  const parts = ['chmod'];
  if (flags) parts.push('-' + flags);
  parts.push(modeArg);
  if (p.startsWith('-')) parts.push('--');
  parts.push(shellQuote(p || 'file'));
  return parts.join(' ');
}

/**
 * Parse a pasted chmod command line: `chmod [-R -v -c -f] MODE FILE...`.
 * Returns {ok, kind:'numeric'|'symbolic', modeText, flags, files} or {ok:false,error}.
 */
export function parseChmodCommand(line) {
  const s = String(line ?? '').trim();
  if (!s) return { ok: false, error: 'Enter a chmod command such as chmod 755 script.sh.' };
  const toks = splitWords(s);
  if (toks.error) return { ok: false, error: toks.error };
  let t = toks.words;
  if (t[0] === 'sudo') t = t.slice(1);
  if (t[0] !== 'chmod') return { ok: false, error: 'The command must start with chmod (optionally after sudo).' };
  t = t.slice(1);
  const flags = []; let i = 0;
  for (; i < t.length; i++) {
    const w = t[i];
    if (w === '--') { i++; break; }
    if (/^-[RvcfhH]+$/.test(w) || /^--(recursive|verbose|changes|silent|quiet|preserve-root|no-preserve-root)$/.test(w)) { flags.push(w); continue; }
    break; // anything else (including a symbolic mode such as -w) is the mode argument
  }
  const modeText = t[i];
  if (modeText === undefined) return { ok: false, error: 'No mode given after chmod (for example 755 or u+x).' };
  const files = t.slice(i + 1);
  if (/^[0-7]+$/.test(modeText) || /^0o/i.test(modeText) || /^[0-9]+$/.test(modeText)) {
    const r = parseOctal(modeText);
    if (!r.ok) return r;
    return { ok: true, kind: 'numeric', modeText, mode: r.mode, flags, files };
  }
  const e = parseSymbolicExpr(modeText);
  if (!e.ok) return e;
  return { ok: true, kind: 'symbolic', modeText, flags, files };
}

/** Split a command line into words honouring '...' and "..." quotes and backslash escapes outside single quotes. */
export function splitWords(s) {
  const words = []; let cur = '', inW = false, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; inW = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; inW = true; continue; }
    if (/\s/.test(c)) { if (inW) { words.push(cur); cur = ''; inW = false; } continue; }
    cur += c; inW = true;
  }
  if (q) return { error: `Unterminated ${q === "'" ? 'single' : 'double'} quote in the command.` };
  if (inW) words.push(cur);
  return { words };
}

// ---------- umask ----------
/** Parse an umask: 1-4 octal digits. Returns {ok, umask} (low 9 bits kept; a 4th leading digit is reported). */
export function parseUmask(input) {
  const r = parseOctal(input);
  if (!r.ok) return { ok: false, error: r.error.replace('mode', 'umask').replace('Enter an octal umask such as 644 or 4755.', 'Enter an umask such as 022 or 077.') };
  return { ok: true, umask: r.mode & 0o777, extra: r.mode > 0o777 };
}

/** Default permissions created under an umask: files start from 666, directories from 777. */
export function applyUmask(umask) {
  const u = umask & 0o777;
  const file = 0o666 & ~u, dir = 0o777 & ~u;
  return { umask: u, file, dir, fileOctal: modeToOctal(file), dirOctal: modeToOctal(dir), fileSymbolic: modeToSymbolic(file), dirSymbolic: modeToSymbolic(dir), umaskSymbolic: modeToSymbolicExpr(0o777 & ~u) };
}

/** Umask that yields a given directory mode (777 - mode): bits missing from the mode. */
export function umaskForMode(mode) { return ~mode & 0o777; }

// ---------- ls -l ----------
const LS_RE = /^\s*([-bcdlpsDCMnP?])([-rwxsStT]{9})[.+@]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(?:(\d+|\d+,\s*\d+)\s+)?(.*)$/;
const DATE_RE = /^(?:[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[+-]\d{4})?)?)\s+/;

/** Parse one `ls -l` line. Returns {ok, type, typeName, symbolic, mode, octal, links, owner, group, size, date, name, target} or {ok:false,error}. */
export function parseLsLine(line) {
  const s = String(line ?? '');
  if (!s.trim()) return { ok: false, error: 'Paste a line from ls -l, for example: -rw-r--r-- 1 alice staff 1024 Jan  5 12:00 notes.txt' };
  if (/^\s*total\s+\d+/.test(s)) return { ok: false, error: 'That is the "total" summary line; paste an entry line instead.' };
  const m = LS_RE.exec(s);
  if (!m) return { ok: false, error: 'Not an ls -l line. Expected: type+permissions (e.g. -rwxr-xr-x), link count, owner, group, size, date and name.' };
  const sym = parseSymbolic(m[2]);
  if (!sym.ok) return sym;
  let rest = m[7], date = null;
  const dm = DATE_RE.exec(rest);
  if (dm) { date = dm[0].trim(); rest = rest.slice(dm[0].length); }
  let name = rest, target = null;
  if (m[1] === 'l' && rest.includes(' -> ')) { const k = rest.indexOf(' -> '); name = rest.slice(0, k); target = rest.slice(k + 4); }
  return { ok: true, type: m[1], typeName: FILE_TYPES[m[1]] || 'unknown', symbolic: m[2], mode: sym.mode, octal: modeToOctal(sym.mode), links: Number(m[3]), owner: m[4], group: m[5], size: m[6] ?? null, date, name, target };
}

/** Parse every line of pasted ls -l output. Returns {entries, errors:[{line, error}]} (total lines skipped). */
export function parseLsOutput(text) {
  const entries = [], errors = [];
  String(text ?? '').split(/\r?\n/).forEach((l, i) => {
    if (!l.trim() || /^\s*total\s+\d+/.test(l)) return;
    const r = parseLsLine(l);
    if (r.ok) entries.push({ ...r, line: i + 1 }); else errors.push({ line: i + 1, error: r.error });
  });
  return { entries, errors };
}

// ---------- recursive helper ----------
/** Variants for applying permissions recursively. Returns [{id,title,command,note}]. */
export function recursiveCommands({ path = '.', dirMode = 0o755, fileMode = 0o644 } = {}) {
  const p = shellQuote(String(path || '.'));
  const fp = shellQuote(findPath(String(path || '.')));
  const d = modeToOctal(dirMode), f = modeToOctal(fileMode);
  const dsym = `u=rwX,g=rX,o=rX`;
  const out = [
    { id: 'R-same', title: `chmod -R ${d} (same mode for everything)`, command: `chmod -R ${d}${String(path).startsWith('-') ? ' --' : ''} ${p}`, note: 'Simple but gives plain files the directory mode (e.g. execute bits on every file). Usually wrong for mixed trees.' },
    { id: 'find-split', title: 'Different modes for directories and files (find + -exec)', command: `find ${fp} -type d -exec chmod ${d} {} +\nfind ${fp} -type f -exec chmod ${f} {} +`, note: 'Safe with any file name; {} + batches many files per chmod call. Symbolic links are not followed.' },
    { id: 'find-print0', title: 'Same as above with find -print0 | xargs -0', command: `find ${fp} -type d -print0 | xargs -0 chmod ${d}\nfind ${fp} -type f -print0 | xargs -0 chmod ${f}`, note: 'The null separator keeps names with spaces or newlines intact. xargs -0 is available in GNU and BSD.' },
    { id: 'X-trick', title: 'Capital X: execute only for directories (and already-executable files)', command: `chmod -R ${dsym}${String(path).startsWith('-') ? ' --' : ''} ${p}`, note: 'X adds execute only to directories or files that already have an execute bit, so scripts stay executable and data files do not become executable.' },
  ];
  return out;
}

// ---------- presets ----------
export const PRESETS = [
  { mode: 0o644, risk: 'ok', title: 'Standard file', use: 'Regular files: web content, documents, configs that are not secret.', security: 'World-readable; only the owner can modify. Do not use for private keys or credentials.' },
  { mode: 0o755, risk: 'ok', title: 'Standard directory / executable', use: 'Directories, scripts and binaries that everyone may run or traverse.', security: 'Anyone can list and execute; only the owner can change. Fine for public tooling.' },
  { mode: 0o600, risk: 'ok', title: 'Private file', use: 'SSH private keys (required by ssh), .env files, tokens, credentials.', security: 'Only the owner can read or write. Preferred default for secrets.' },
  { mode: 0o700, risk: 'ok', title: 'Private directory / executable', use: '~/.ssh, private scripts, personal working directories.', security: 'Only the owner has any access. Required for ~/.ssh by OpenSSH.' },
  { mode: 0o400, risk: 'ok', title: 'Read-only for owner', use: 'Keys and certificates that must never change (e.g. AWS .pem files).', security: 'Even the owner cannot write without chmod first; protects against accidental overwrite.' },
  { mode: 0o440, risk: 'ok', title: 'Read-only for owner and group', use: 'Files like /etc/sudoers.d/* shared with an admin group.', security: 'Group members can read; nobody else. Nothing is writable.' },
  { mode: 0o664, risk: 'warn', title: 'Group-writable file', use: 'Shared project files where a trusted group collaborates (with umask 002).', security: 'Every group member can modify the file. Make sure the group is small and trusted.' },
  { mode: 0o775, risk: 'warn', title: 'Group-writable directory', use: 'Shared team directories; usually paired with setgid (2775).', security: 'Group members can create and delete files. Without setgid new files may get the wrong group.' },
  { mode: 0o666, risk: 'danger', title: 'World-writable file', use: 'Almost never. Sometimes seen on sockets or log files by mistake.', security: 'Any user or process can overwrite it. Treat as a security smell; fix ownership instead.' },
  { mode: 0o777, risk: 'danger', title: 'Everyone can do everything', use: 'Never recommended on a real system; often applied as a "quick fix" for permission errors.', security: 'World-writable and executable: any local user (or a compromised service) can replace its contents. Find the real ownership problem instead.' },
  { mode: 0o1777, risk: 'ok', title: 'Sticky world-writable directory', use: '/tmp and /var/tmp style shared scratch space.', security: 'Everyone can create files, but only the owner (or root) can delete or rename their own. Required for safe world-writable directories.' },
  { mode: 0o2775, risk: 'ok', title: 'Setgid shared directory', use: 'Team directories where new files should inherit the directory\'s group.', security: 'Group members collaborate; others can read. New entries inherit the group, preventing group drift.' },
  { mode: 0o4755, risk: 'warn', title: 'Setuid executable', use: 'Privileged helpers such as passwd or sudo that must run as their owner (root).', security: 'Runs with the owner\'s rights. Keep the owner-only write bit, audit the program, never set on scripts or writable files.' },
  { mode: 0o2755, risk: 'warn', title: 'Setgid executable', use: 'Programs that need a specific group\'s access (e.g. mail or games).', security: 'Runs with the file\'s group privileges. Audit like setuid.' },
  { mode: 0o750, risk: 'ok', title: 'Owner full, group read/execute', use: 'Service directories where a group needs read access but others must not (e.g. /var/log/app).', security: 'No access for others; group cannot modify.' },
  { mode: 0o640, risk: 'ok', title: 'Owner read/write, group read', use: 'Config files read by a service group (e.g. /etc/ssl/private with group ssl-cert).', security: 'No access for others; good for configs holding mild secrets.' },
];

export const NOTES = [
  'Access Control Lists (setfacl/getfacl) can grant more or less access than the mode shows. A "+" after the mode in ls -l (for example -rw-r--r--+) means an ACL is present; with an ACL the group digit shows the ACL mask, not the owning group.',
  'The effective mode of a new file is requested mode AND NOT umask. Files are created with 666 and directories with 777 before the umask is applied; execute bits are never added to new regular files automatically.',
  'Default ACLs on a directory override the umask for newly created entries, so a 644 you expect may come out differently.',
  'GNU chmod keeps setuid/setgid on directories when you use a numeric mode of 3 or 4 digits (chmod 755 dir keeps an existing setgid); use a 5-digit mode (chmod 00755) or a symbolic form such as g-s to clear them. A symbolic = clause for a class also resets that class\'s special bit.',
  'chmod does not follow symbolic links when used recursively and ignores the mode of a link itself on Linux; it changes the target\'s mode.',
  'Filesystems such as FAT/exFAT, NTFS mounts and some network or container mounts ignore chmod or fix every file to one mode.',
  'Root (and processes with CAP_DAC_OVERRIDE) bypass read/write checks; mode bits do not protect against root.',
];
