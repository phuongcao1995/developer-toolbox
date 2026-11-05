// Run: node tests/unit/chmod-calculator.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/chmod-calculator/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const sym = (e, start = 0, o) => { const r = L.applySymbolic(e, start, o); assert.equal(r.ok, true, r.error); return r.mode; };

test('modeToOctal pads to 3 or 4 digits', () => {
  assert.equal(L.modeToOctal(0o644), '644'); assert.equal(L.modeToOctal(0), '000');
  assert.equal(L.modeToOctal(0o4755), '4755'); assert.equal(L.modeToOctal(0o644, { pad4: true }), '0644');
  assert.equal(L.modeToOctal(0o7777), '7777'); assert.equal(L.modeToOctal(0o1000), '1000');
});
test('modeToOctal rejects out of range', () => {
  assert.throws(() => L.modeToOctal(4096)); assert.throws(() => L.modeToOctal(-1)); assert.throws(() => L.modeToOctal(1.5));
});
test('parseOctal valid forms', () => {
  assert.equal(L.parseOctal('644').mode, 0o644); assert.equal(L.parseOctal('0644').mode, 0o644);
  assert.equal(L.parseOctal(' 4755 ').mode, 0o4755); assert.equal(L.parseOctal('7').mode, 7); assert.equal(L.parseOctal('0o755').mode, 0o755);
  assert.equal(L.parseOctal('0').mode, 0);
});
test('parseOctal errors are explained', () => {
  assert.match(L.parseOctal('').error, /Enter/);
  assert.match(L.parseOctal('888').error, /8 and 9|octal/);
  assert.match(L.parseOctal('12345').error, /at most 4/);
  assert.match(L.parseOctal('rwx').error, /not an octal digit/);
  assert.match(L.parseOctal('64a').error, /"a"/);
  assert.equal(L.parseOctal('-1').ok, false);
});
test('modeToSymbolic basics', () => {
  assert.equal(L.modeToSymbolic(0o755), 'rwxr-xr-x'); assert.equal(L.modeToSymbolic(0o644), 'rw-r--r--');
  assert.equal(L.modeToSymbolic(0), '---------'); assert.equal(L.modeToSymbolic(0o777), 'rwxrwxrwx');
  assert.equal(L.modeToSymbolic(0o644, { fileType: '-' }), '-rw-r--r--'); assert.equal(L.modeToSymbolic(0o755, { fileType: 'd' }), 'drwxr-xr-x');
});
test('special bit letters s S t T', () => {
  assert.equal(L.modeToSymbolic(0o4755), 'rwsr-xr-x'); assert.equal(L.modeToSymbolic(0o4644), 'rwSr--r--');
  assert.equal(L.modeToSymbolic(0o2755), 'rwxr-sr-x'); assert.equal(L.modeToSymbolic(0o2745), 'rwxr-Sr-x');
  assert.equal(L.modeToSymbolic(0o1777), 'rwxrwxrwt'); assert.equal(L.modeToSymbolic(0o1776), 'rwxrwxrwT');
  assert.equal(L.modeToSymbolic(0o7777, { fileType: 'd' }), 'drwsrwsrwt'); assert.equal(L.modeToSymbolic(0o6000), '--S--S---');
  assert.equal(L.modeToSymbolic(0o2775, { fileType: 'd' }), 'drwxrwsr-x');
});
test('parseSymbolic accepts 9 and 10 characters', () => {
  assert.deepEqual(L.parseSymbolic('rwxr-xr-x'), { ok: true, mode: 0o755, type: null });
  assert.deepEqual(L.parseSymbolic('-rwxr-xr-x'), { ok: true, mode: 0o755, type: '-' });
  assert.equal(L.parseSymbolic('drwxr-sr-t').mode, 0o3755);
  assert.equal(L.parseSymbolic('-rw-r--r--.').mode, 0o644); assert.equal(L.parseSymbolic('-rw-r--r--+').mode, 0o644);
});
test('parseSymbolic s/S/t/T semantics', () => {
  assert.equal(L.parseSymbolic('rwsr-xr-x').mode, 0o4755); assert.equal(L.parseSymbolic('rwSr--r--').mode, 0o4644);
  assert.equal(L.parseSymbolic('rwxr-sr-t').mode, 0o3755); assert.equal(L.parseSymbolic('rwxrwxrwT').mode, 0o1776);
});
test('parseSymbolic errors', () => {
  assert.match(L.parseSymbolic('').error, /Enter/); assert.match(L.parseSymbolic('rwx').error, /9 permission/);
  assert.match(L.parseSymbolic('rwxrwxrwxx').error, /file type/);
  assert.match(L.parseSymbolic('rwxr-xr-q').error, /position 9/);
  assert.match(L.parseSymbolic('rwtr-xr-x').error, /owner or group|only valid/);
  assert.match(L.parseSymbolic('rwxrwxrws').error, /position 9/);
  assert.match(L.parseSymbolic('xwxr-xr-x').error, /position 1/);
});
test('round trip all 4096 modes: octal -> symbolic -> octal', () => {
  for (let m = 0; m < 4096; m++) {
    const s = L.modeToSymbolic(m);
    assert.equal(L.parseSymbolic(s).mode, m, `${m.toString(8)} ${s}`);
    assert.equal(L.parseSymbolic(L.modeToSymbolic(m, { fileType: 'd' })).mode, m);
    assert.equal(L.parseOctal(L.modeToOctal(m)).mode, m);
    assert.equal(L.parseOctal(L.modeToOctal(m, { pad4: true })).mode, m);
  }
});
test('round trip all 4096 modes: symbolic expression reproduces mode from any start', () => {
  for (let m = 0; m < 4096; m++) {
    const e = L.modeToSymbolicExpr(m);
    assert.equal(sym(e, 0o7777, { umask: 0 }), m, `${m.toString(8)} ${e}`);
    assert.equal(sym(e, 0, { umask: 0o077 }), m, `${m.toString(8)} ${e}`);
  }
});
test('modeToSymbolicExpr compaction', () => {
  assert.equal(L.modeToSymbolicExpr(0o755), 'u=rwx,go=rx'); assert.equal(L.modeToSymbolicExpr(0o644), 'u=rw,go=r');
  assert.equal(L.modeToSymbolicExpr(0o777), 'a=rwx'); assert.equal(L.modeToSymbolicExpr(0), 'a=');
  assert.equal(L.modeToSymbolicExpr(0o4755), 'u=rwxs,go=rx'); assert.equal(L.modeToSymbolicExpr(0o1777), 'ug=rwx,o=rwxt');
  assert.equal(L.modeToSymbolicExpr(0o750), 'u=rwx,g=rx,o=');
});
test('explainClass wording', () => {
  assert.equal(L.explainClass(0o755, 'owner'), 'Owner (user) can read, write and execute.');
  assert.equal(L.explainClass(0o755, 'group'), 'Group can read and execute.');
  assert.equal(L.explainClass(0o700, 'other'), 'Others (everyone else) have no access.');
  assert.equal(L.explainClass(0o004, 'other'), 'Others (everyone else) can read.');
  assert.match(L.explainClass(0o755, 'other', { isDir: true }), /list the names.*enter/);
  assert.match(L.explainClass(0, 'group', { isDir: true }), /no access to this directory/);
});
test('explainSpecial describes bits for files and directories', () => {
  assert.equal(L.explainSpecial(0o755).length, 0);
  assert.match(L.explainSpecial(0o4755)[0], /owner/); assert.match(L.explainSpecial(0o2755, { isDir: true })[0], /inherit/);
  assert.match(L.explainSpecial(0o1777, { isDir: true })[0], /delete or rename/); assert.equal(L.explainSpecial(0o7000).length, 3);
});
test('auditMode flags world-writable and setuid', () => {
  assert.equal(L.auditMode(0o777)[0].level, 'danger'); assert.equal(L.auditMode(0o666)[0].level, 'danger');
  assert.equal(L.auditMode(0o1777, { isDir: true })[0].level, 'info');
  assert.ok(L.auditMode(0o4755).some(a => a.level === 'warn' && /Setuid/.test(a.text)));
  assert.ok(L.auditMode(0o2755).some(a => /Setgid/.test(a.text)));
  assert.equal(L.auditMode(0o644).length, 0); assert.equal(L.auditMode(0o755, { isDir: true }).length, 0);
  assert.ok(L.auditMode(0o4644).some(a => /S\)|without owner execute/.test(a.text)));
  assert.ok(L.auditMode(0o600, { isDir: true }).some(a => /execute/.test(a.text)));
  assert.ok(L.auditMode(0, { isDir: true }).some(a => /No one/.test(a.text)));
});
test('parseSymbolicExpr structure', () => {
  const r = L.parseSymbolicExpr('ugo+rx,o-w');
  assert.equal(r.ok, true); assert.equal(r.clauses.length, 2); assert.equal(r.clauses[0].who, 'ugo'); assert.deepEqual(r.clauses[1].ops, [{ op: '-', perms: 'w', copy: null }]);
  assert.equal(L.parseSymbolicExpr('u=g').clauses[0].ops[0].copy, 'g');
  assert.equal(L.parseSymbolicExpr('u+r-w').clauses[0].ops.length, 2);
  assert.equal(L.parseSymbolicExpr('+X').clauses[0].who, ''); assert.equal(L.parseSymbolicExpr('a=').ok, true);
});
test('parseSymbolicExpr errors', () => {
  for (const bad of ['', 'u', 'rwx', 'u+q', 'u+r,,g-w', 'u+r,', 'x+u', 'u=gr', 'ug', 'u++']) {
    const r = L.parseSymbolicExpr(bad);
    if (bad === 'u++') { assert.equal(r.ok, true); continue; } // repeated operator with empty perms is accepted by GNU chmod
    assert.equal(r.ok, false, bad); assert.ok(r.error.length > 5);
  }
  assert.match(L.parseSymbolicExpr('u+q').error, /Invalid permission letter "q"/);
  assert.match(L.parseSymbolicExpr('u').error, /operator/);
});
test('u+x go-w a=r', () => {
  assert.equal(sym('u+x', 0o644), 0o744); assert.equal(sym('go-w', 0o666), 0o644); assert.equal(sym('a=r', 0o755), 0o444);
  assert.equal(sym('g+w', 0o644), 0o664); assert.equal(sym('o=', 0o777), 0o770); assert.equal(sym('a-rwx', 0o777), 0);
});
test('multi-clause expressions', () => {
  assert.equal(sym('ugo+rx,o-w', 0o000), 0o555); assert.equal(sym('u=rwx,g=rx,o=rx', 0o000), 0o755);
  assert.equal(sym('u+rwx,g+rx,o+r', 0), 0o754); assert.equal(sym('u=rw,go=r', 0o777), 0o644);
  assert.equal(sym('u+r-w', 0o222), 0o422);
});
test('copy permissions u=g g=o', () => {
  assert.equal(sym('u=g', 0o470), 0o770); // u takes g's rwx (7)
  assert.equal(sym('g=u', 0o700), 0o770); assert.equal(sym('o=u', 0o750), 0o757); assert.equal(sym('go=u', 0o700), 0o777);
  assert.equal(sym('u+g', 0o040), 0o440); assert.equal(sym('o-u', 0o777), 0o770);
});
test('capital X semantics', () => {
  assert.equal(sym('+X', 0o644, { umask: 0 }), 0o644); // plain file, no x anywhere
  assert.equal(sym('+X', 0o744, { umask: 0 }), 0o755); // already executable by someone
  assert.equal(sym('a+X', 0o644, { isDir: true }), 0o755); // directory always
  assert.equal(sym('u=rwX,g=rX,o=rX', 0o000, { isDir: true }), 0o755);
  assert.equal(sym('u=rwX,g=rX,o=rX', 0o000), 0o644);
  assert.equal(sym('u=rwX,g=rX,o=rX', 0o100), 0o755);
  assert.equal(sym('go+X', 0o640), 0o640);
});
test('X is evaluated against the mode at the time of the clause', () => {
  assert.equal(sym('u+x,g+X', 0o640, { umask: 0 }), 0o750);
});
test('special bits via symbolic', () => {
  assert.equal(sym('u+s', 0o755), 0o4755); assert.equal(sym('g+s', 0o755), 0o2755); assert.equal(sym('+t', 0o777, { umask: 0 }), 0o1777);
  assert.equal(sym('o+t', 0o777), 0o1777); assert.equal(sym('a+s', 0o755, { umask: 0 }), 0o6755); assert.equal(sym('u-s', 0o4755), 0o755);
  assert.equal(sym('g-s', 0o2775), 0o775); assert.equal(sym('o-t', 0o1777), 0o777); assert.equal(sym('u+t', 0o755), 0o755);
  assert.equal(sym('u=rwx', 0o4755), 0o700 | 0o055); // = resets the owner's special bit
  assert.equal(sym('u=rwxs', 0o755), 0o4755); assert.equal(sym('a=rx', 0o7777), 0o555);
});
test('omitted who respects the umask for + and =', () => {
  assert.equal(sym('+w', 0o444, { umask: 0o022 }), 0o644); assert.equal(sym('+x', 0o644, { umask: 0o022 }), 0o755);
  assert.equal(sym('+w', 0o444, { umask: 0 }), 0o666); assert.equal(sym('=rw', 0o000, { umask: 0o077 }), 0o600);
  assert.equal(sym('=rwx', 0o000, { umask: 0o027 }), 0o750); assert.equal(sym('a+w', 0o444, { umask: 0o022 }), 0o666);
});
test('omitted who with - clears in all classes', () => {
  assert.equal(sym('-w', 0o666, { umask: 0o022 }), 0o444); assert.equal(sym('-x', 0o755, { umask: 0o077 }), 0o644);
});
test('applySymbolic reports steps and rejects bad input', () => {
  const r = L.applySymbolic('u+x,go-w', 0o666);
  assert.equal(r.steps.length, 2); assert.equal(r.steps[0].after, 0o766); assert.equal(r.steps[1].before, 0o766); assert.equal(r.mode, 0o744);
  assert.equal(L.applySymbolic('zzz', 0).ok, false); assert.equal(L.applySymbolic('u+x', 99999).ok, false); assert.equal(L.applySymbolic('u+x', -1).ok, false);
});
test('shellQuote', () => {
  assert.equal(L.shellQuote('file.txt'), 'file.txt'); assert.equal(L.shellQuote('my file'), "'my file'"); assert.equal(L.shellQuote(''), "''");
  assert.equal(L.shellQuote("it's"), "'it'\\''s'"); assert.equal(L.shellQuote('a;rm -rf /'), "'a;rm -rf /'"); assert.equal(L.shellQuote('$HOME'), "'$HOME'");
  assert.equal(L.shellQuote('/var/www/html'), '/var/www/html'); assert.equal(L.shellQuote('naïve 日本'), "'naïve 日本'");
});
test('chmodCommand numeric and symbolic', () => {
  assert.equal(L.chmodCommand(0o755, { path: 'run.sh' }), 'chmod 755 run.sh');
  assert.equal(L.chmodCommand(0o4755, { path: 'bin/x' }), 'chmod 4755 bin/x');
  assert.equal(L.chmodCommand(0o755, { path: 'run.sh', form: 'symbolic' }), 'chmod u=rwx,go=rx run.sh');
  assert.equal(L.chmodCommand(0o644, { path: 'my doc.txt', recursive: true }), "chmod -R 644 'my doc.txt'");
  assert.equal(L.chmodCommand(0o644, { path: '-weird' }), 'chmod 644 -- -weird');
  assert.equal(L.chmodCommand(0o600, { path: 'k', recursive: true, verbose: true, changes: true }), 'chmod -Rvc 600 k');
  assert.equal(L.chmodCommand(0o600, { path: '' }), 'chmod 600 file');
});
test('splitWords handles quotes and escapes', () => {
  assert.deepEqual(L.splitWords(`a 'b c' "d e" f\\ g`).words, ['a', 'b c', 'd e', 'f g']);
  assert.ok(L.splitWords("a 'b").error); assert.deepEqual(L.splitWords('').words, []);
  assert.deepEqual(L.splitWords(`"a\\"b"`).words, ['a"b']);
});
test('parseChmodCommand', () => {
  let r = L.parseChmodCommand('chmod 755 a.sh b.sh');
  assert.equal(r.ok, true); assert.equal(r.kind, 'numeric'); assert.equal(r.mode, 0o755); assert.deepEqual(r.files, ['a.sh', 'b.sh']);
  r = L.parseChmodCommand('sudo chmod -R u+x,go-w "my dir"');
  assert.equal(r.kind, 'symbolic'); assert.deepEqual(r.flags, ['-R']); assert.equal(r.modeText, 'u+x,go-w'); assert.deepEqual(r.files, ['my dir']);
  r = L.parseChmodCommand('chmod -w file'); assert.equal(r.kind, 'symbolic'); assert.equal(r.modeText, '-w');
  r = L.parseChmodCommand('chmod --recursive -v 0644 x'); assert.equal(r.mode, 0o644); assert.equal(r.flags.length, 2);
});
test('parseChmodCommand errors', () => {
  assert.equal(L.parseChmodCommand('').ok, false); assert.match(L.parseChmodCommand('ls -l').error, /chmod/);
  assert.match(L.parseChmodCommand('chmod').error, /No mode/); assert.equal(L.parseChmodCommand('chmod 999 f').ok, false);
  assert.equal(L.parseChmodCommand('chmod q+z f').ok, false); assert.match(L.parseChmodCommand("chmod 755 'f").error, /Unterminated/);
  assert.equal(L.parseChmodCommand('chmod 75555 f').ok, false);
});
test('umask', () => {
  const a = L.applyUmask(0o022); assert.equal(a.fileOctal, '644'); assert.equal(a.dirOctal, '755'); assert.equal(a.fileSymbolic, 'rw-r--r--');
  const b = L.applyUmask(0o077); assert.equal(b.fileOctal, '600'); assert.equal(b.dirOctal, '700');
  const c = L.applyUmask(0o002); assert.equal(c.fileOctal, '664'); assert.equal(c.dirOctal, '775');
  const d = L.applyUmask(0); assert.equal(d.fileOctal, '666'); assert.equal(d.dirOctal, '777');
  const e = L.applyUmask(0o777); assert.equal(e.fileOctal, '000'); assert.equal(L.applyUmask(0o027).dirOctal, '750'); assert.equal(L.applyUmask(0o027).umaskSymbolic, 'u=rwx,g=rx,o=');
  assert.equal(L.umaskForMode(0o755), 0o022); assert.equal(L.umaskForMode(0o700), 0o077);
});
test('parseUmask', () => {
  assert.equal(L.parseUmask('022').umask, 0o22); assert.equal(L.parseUmask('0027').umask, 0o27); assert.equal(L.parseUmask('77').umask, 0o77);
  assert.equal(L.parseUmask('1022').extra, true); assert.equal(L.parseUmask('089').ok, false); assert.equal(L.parseUmask('').ok, false);
  assert.match(L.parseUmask('9').error, /octal|8 and 9|0-7/);
});
test('parseLsLine standard', () => {
  const r = L.parseLsLine('-rw-r--r-- 1 alice staff 1024 Jan  5 12:00 notes.txt');
  assert.equal(r.ok, true); assert.equal(r.mode, 0o644); assert.equal(r.octal, '644'); assert.equal(r.owner, 'alice'); assert.equal(r.group, 'staff');
  assert.equal(r.size, '1024'); assert.equal(r.name, 'notes.txt'); assert.equal(r.typeName, 'regular file'); assert.equal(r.date, 'Jan  5 12:00');
});
test('parseLsLine special entries', () => {
  let r = L.parseLsLine('drwxrwxrwt 18 root root 4096 Mar 3 2023 tmp'); assert.equal(r.mode, 0o1777); assert.equal(r.type, 'd'); assert.equal(r.name, 'tmp');
  r = L.parseLsLine('-rwsr-xr-x 1 root root 59976 Nov 24 2022 /usr/bin/passwd'); assert.equal(r.octal, '4755'); assert.equal(r.name, '/usr/bin/passwd');
  r = L.parseLsLine('lrwxrwxrwx 1 root root 7 Aug 1 10:00 bin -> usr/bin'); assert.equal(r.type, 'l'); assert.equal(r.name, 'bin'); assert.equal(r.target, 'usr/bin');
  r = L.parseLsLine('-rw-r--r--. 1 root root 0 2024-01-05 12:00 my file.txt'); assert.equal(r.name, 'my file.txt'); assert.equal(r.mode, 0o644);
  r = L.parseLsLine('-rw-r--r--+ 1 u g 10 2024-01-05 12:00:01.123 +0100 a.txt'); assert.equal(r.name, 'a.txt'); assert.equal(r.mode, 0o644);
  r = L.parseLsLine('crw-rw---- 1 root tty 4, 0 Jan 1 00:00 tty0'); assert.equal(r.type, 'c'); assert.equal(r.size, '4, 0'); assert.equal(r.name, 'tty0');
  r = L.parseLsLine('-rw-r--r-- 1 1000 1000 12 Jan 1 2020 日本語 ファイル.txt'); assert.equal(r.owner, '1000'); assert.equal(r.name, '日本語 ファイル.txt');
});
test('parseLsLine errors', () => {
  assert.match(L.parseLsLine('').error, /Paste/); assert.match(L.parseLsLine('total 24').error, /total/); assert.match(L.parseLsLine('hello world').error, /Not an ls -l/);
  assert.equal(L.parseLsLine('-rwxr-xr-q 1 a b 1 Jan 1 2020 f').ok, false);
});
test('parseLsOutput multiple lines', () => {
  const r = L.parseLsOutput('total 8\n-rw-r--r-- 1 a b 1 Jan 1 2020 x\r\ndrwxr-xr-x 2 a b 4096 Jan 1 2020 d\nbogus line\n');
  assert.equal(r.entries.length, 2); assert.equal(r.errors.length, 1); assert.equal(r.errors[0].line, 4); assert.equal(r.entries[1].mode, 0o755);
});
test('recursiveCommands variants and quoting', () => {
  const v = L.recursiveCommands({ path: 'my site', dirMode: 0o755, fileMode: 0o644 });
  assert.equal(v.length, 4);
  assert.match(v[0].command, /^chmod -R 755 'my site'$/);
  assert.match(v[1].command, /find 'my site' -type d -exec chmod 755 \{\} \+\nfind 'my site' -type f -exec chmod 644 \{\} \+/);
  assert.match(v[2].command, /-print0 \| xargs -0 chmod 755/);
  assert.match(v[3].command, /u=rwX,g=rX,o=rX 'my site'/);
  const w = L.recursiveCommands({ path: '-x', dirMode: 0o700, fileMode: 0o600 });
  assert.match(w[0].command, /chmod -R 700 -- -x/); assert.match(w[1].command, /find \.\/-x -type d/);
  assert.match(L.recursiveCommands({ path: "o'neil" })[1].command, /'o'\\''neil'/);
});
test('presets are coherent', () => {
  assert.ok(L.PRESETS.length >= 14);
  for (const p of L.PRESETS) { assert.ok(p.title && p.use && p.security); assert.ok(['ok', 'warn', 'danger'].includes(p.risk)); }
  assert.equal(L.PRESETS.find(p => p.mode === 0o777).risk, 'danger');
  for (const m of [0o644, 0o755, 0o600, 0o700, 0o400, 0o440, 0o664, 0o1777, 0o2775, 0o4755]) assert.ok(L.PRESETS.some(p => p.mode === m), m.toString(8));
});
test('explainMode combines classes and special', () => {
  const e = L.explainMode(0o4755);
  assert.equal(e.classes.length, 3); assert.equal(e.special.length, 1); assert.match(e.classes[0].text, /read, write and execute/);
});
test('notes mention ACL and umask', () => {
  assert.ok(L.NOTES.some(n => /ACL/.test(n))); assert.ok(L.NOTES.some(n => /umask/.test(n)));
});

test('common presets round-trip to expected symbolic', () => {
  const exp = { 0o644: 'rw-r--r--', 0o755: 'rwxr-xr-x', 0o600: 'rw-------', 0o700: 'rwx------', 0o777: 'rwxrwxrwx', 0o400: 'r--------', 0o440: 'r--r-----', 0o664: 'rw-rw-r--' };
  for (const [m, s] of Object.entries(exp)) assert.equal(L.modeToSymbolic(Number(m)), s);
});
test('constants', () => { assert.equal(L.SETUID, 2048); assert.equal(L.SETGID, 1024); assert.equal(L.STICKY, 512); assert.equal(L.CLASSES.length, 3); });
test('symbolic apply: a+x then a-x', () => { assert.equal(sym('a+x', 0o644, { umask: 0 }), 0o755); assert.equal(sym('a-x', 0o755), 0o644); });
test('symbolic apply: = replaces and empty clears', () => { assert.equal(sym('g=', 0o777), 0o707); assert.equal(sym('u=', 0o777), 0o077); assert.equal(sym('a=', 0o777), 0); });
test('symbolic apply: duplicate letters are harmless', () => { assert.equal(sym('uu+xx', 0o644), 0o744); });
test('symbolic apply: copy uses mode before the clause, not the final mode', () => { assert.equal(sym('u=g,g=u', 0o470), 0o770); assert.equal(sym('g=u,u=g', 0o640), 0o660); });
test('parseSymbolic ignores a trailing ls marker', () => { assert.equal(L.parseSymbolic('rwxr-xr-x@').mode, 0o755); });
test('chmodCommand with path needing quotes and unicode', () => {
  assert.equal(L.chmodCommand(0o644, { path: 'résumé final.pdf' }), "chmod 644 'résumé final.pdf'");
  assert.equal(L.chmodCommand(0o4755, { path: '/usr/bin/x', form: 'symbolic' }), 'chmod u=rwxs,go=rx /usr/bin/x');
});
test('parseChmodCommand round trip with chmodCommand', () => {
  for (const m of [0o644, 0o4755, 0o1777, 0o2775, 0]) {
    const cmd = L.chmodCommand(m, { path: 'my file' });
    const r = L.parseChmodCommand(cmd);
    assert.equal(r.mode, m); assert.deepEqual(r.files, ['my file']);
  }
});
test('large input: ls output with 2000 lines', () => {
  const line = '-rw-r--r-- 1 a b 1 Jan 1 2020 f\n';
  const r = L.parseLsOutput(line.repeat(2000)); assert.equal(r.entries.length, 2000); assert.equal(r.errors.length, 0);
});
test('empty inputs never throw', () => {
  for (const f of [L.parseOctal, L.parseSymbolic, L.parseSymbolicExpr, L.parseChmodCommand, L.parseLsLine, L.parseUmask, L.parseLsOutput]) { assert.doesNotThrow(() => f(undefined)); assert.doesNotThrow(() => f(null)); assert.doesNotThrow(() => f('')); }
});

console.log(`chmod-calculator: ${pass} tests passed`);
