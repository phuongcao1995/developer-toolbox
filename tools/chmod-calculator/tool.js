// Chmod Calculator UI. All logic lives in logic.js. Untrusted text (ls output, paths) only reaches the DOM through textContent.
import { copyText, renderIcons } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const RISK = { ok: ['OK', 'badge badge-success'], warn: ['Caution', 'badge badge-warn'], danger: ['Danger', 'badge badge-danger'] };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      body: $('#cm-grid-body'), setuid: $('#cm-setuid'), setgid: $('#cm-setgid'), sticky: $('#cm-sticky'), type: $('#cm-type'), showType: $('#cm-showtype'), pad4: $('#cm-pad4'),
      octal: $('#cm-octal'), symbolic: $('#cm-symbolic'), command: $('#cm-command'), form: $('#cm-form'), path: $('#cm-path'), rec: $('#cm-rec'), verb: $('#cm-verb'),
      explain: $('#cm-explain'), start: $('#cm-start'), expr: $('#cm-expr'), applyUmask: $('#cm-apply-umask'), applyDir: $('#cm-apply-dir'), applyOut: $('#cm-apply-out'),
      umask: $('#cm-umask'), umaskOut: $('#cm-umask-out'), ls: $('#cm-ls'), lsOut: $('#cm-ls-out'), rpath: $('#cm-rpath'), rdir: $('#cm-rdir'), rfile: $('#cm-rfile'), recOut: $('#cm-rec-out'),
    };
    const err = id => $(`#cm-${id}-err`);
    const showErr = (id, text) => {
      const box = err(id); if (!box) return;
      box.hidden = !text; box.textContent = text || '';
      const input = { octal: els.octal, symbolic: els.symbolic, command: els.command, apply: els.expr, umask: els.umask, rec: els.rdir }[id];
      if (input) { if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
    };
    const store = (k, d) => { try { const v = ctx.storage.get(k, d); return v ?? d; } catch { return d; } };
    const save = (k, v) => { try { ctx.storage.set(k, v); } catch { /* storage unavailable */ } };

    const DEFAULT_MODE = 0o644;
    let mode = Number.isInteger(store('mode', DEFAULT_MODE)) && store('mode', DEFAULT_MODE) >= 0 && store('mode', DEFAULT_MODE) <= 0o7777 ? store('mode', DEFAULT_MODE) : DEFAULT_MODE;

    // ---------- build the checkbox grid ----------
    const boxes = {};
    for (const [bit, label, letter] of [[4, 'Read', 'r'], [2, 'Write', 'w'], [1, 'Execute', 'x']]) {
      const tr = h('tr');
      tr.append(h('th', '', `${label} (${bit})`)); tr.firstChild.scope = 'row';
      for (const cls of L.CLASSES) {
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.setAttribute('aria-label', `${cls[0].toUpperCase() + cls.slice(1)} ${label.toLowerCase()}`);
        cb.dataset.shift = L.CLASS_SHIFT[cls]; cb.dataset.bit = bit; cb.dataset.letter = letter;
        boxes[`${cls}-${letter}`] = cb;
        cb.addEventListener('change', () => {
          const m = (mode & ~(bit << L.CLASS_SHIFT[cls])) | (cb.checked ? bit << L.CLASS_SHIFT[cls] : 0);
          setMode(m, 'grid');
        });
        const td = h('td'); td.append(cb); tr.append(td);
      }
      els.body.append(tr);
    }
    for (const [el, bit] of [[els.setuid, L.SETUID], [els.setgid, L.SETGID], [els.sticky, L.STICKY]]) {
      el.addEventListener('change', () => setMode(el.checked ? mode | bit : mode & ~bit, 'grid'));
    }

    // ---------- state restore ----------
    els.type.value = store('type', 'file') === 'dir' ? 'dir' : 'file';
    els.showType.checked = !!store('showType', false);
    els.pad4.checked = !!store('pad4', false);
    els.form.value = store('form', 'numeric') === 'symbolic' ? 'symbolic' : 'numeric';
    els.path.value = String(store('path', 'script.sh'));
    els.rec.checked = !!store('rec', false);
    els.verb.checked = !!store('verb', false);
    els.applyDir.checked = els.type.value === 'dir';
    const isDir = () => els.type.value === 'dir';

    // ---------- core sync ----------
    function render(source) {
      for (const cls of L.CLASSES) for (const letter of 'rwx') {
        const bit = { r: 4, w: 2, x: 1 }[letter];
        boxes[`${cls}-${letter}`].checked = !!((mode >> L.CLASS_SHIFT[cls]) & bit);
      }
      els.setuid.checked = !!(mode & L.SETUID); els.setgid.checked = !!(mode & L.SETGID); els.sticky.checked = !!(mode & L.STICKY);
      const typeChar = els.showType.checked ? (isDir() ? 'd' : '-') : null;
      if (source !== 'octal') { els.octal.value = L.modeToOctal(mode, { pad4: els.pad4.checked }); showErr('octal', ''); }
      if (source !== 'symbolic') { els.symbolic.value = L.modeToSymbolic(mode, { fileType: typeChar }); showErr('symbolic', ''); }
      if (source !== 'command') { els.command.value = L.chmodCommand(mode, { path: els.path.value.trim() || 'file', form: els.form.value, recursive: els.rec.checked, verbose: els.verb.checked }); showErr('command', ''); }
      renderExplain();
      save('mode', mode);
    }
    function setMode(m, source) { mode = m; render(source); }

    function renderExplain() {
      const e = L.explainMode(mode, { isDir: isDir() });
      const box = els.explain; box.replaceChildren();
      const ul = h('ul', 'cm-list');
      for (const c of e.classes) ul.append(h('li', '', c.text));
      box.append(ul);
      for (const s of e.special) box.append(h('p', 'cm-note', h('strong', '', 'Special: '), s));
      const audit = L.auditMode(mode, { isDir: isDir() });
      if (audit.length) {
        const al = h('ul', 'cm-audit');
        for (const a of audit) al.append(h('li', `cm-audit-${a.level}`, h('span', a.level === 'danger' ? 'badge badge-danger' : a.level === 'warn' ? 'badge badge-warn' : 'badge', a.level === 'danger' ? 'Danger' : a.level === 'warn' ? 'Caution' : 'Note'), ' ', a.text));
        box.append(al);
      } else box.append(h('p', 'cm-muted', 'No security concerns detected for this mode.'));
    }

    // ---------- field handlers ----------
    const onOctal = () => {
      const r = L.parseOctal(els.octal.value);
      if (!r.ok) { showErr('octal', r.error); return; }
      showErr('octal', ''); setMode(r.mode, 'octal');
    };
    const onSymbolic = () => {
      const r = L.parseSymbolic(els.symbolic.value);
      if (!r.ok) { showErr('symbolic', r.error); return; }
      showErr('symbolic', '');
      if (r.type) { els.type.value = r.type === 'd' ? 'dir' : 'file'; save('type', els.type.value); }
      setMode(r.mode, 'symbolic');
    };
    const onCommand = () => {
      const r = L.parseChmodCommand(els.command.value);
      if (!r.ok) { showErr('command', r.error); return; }
      showErr('command', '');
      if (r.files.length) { els.path.value = r.files.join(' '); save('path', els.path.value); }
      els.rec.checked = r.flags.some(f => /R|recursive/.test(f)); els.verb.checked = r.flags.some(f => /v|verbose/.test(f));
      els.form.value = r.kind;
      if (r.kind === 'numeric') { setMode(r.mode, 'command'); return; }
      const um = L.parseUmask(els.applyUmask.value);
      const res = L.applySymbolic(r.modeText, mode, { umask: um.ok ? um.umask : 0o022, isDir: isDir() });
      if (!res.ok) { showErr('command', res.error); return; }
      setMode(res.mode, 'command');
    };
    const rebuildCommandField = () => { render(null); };

    const on = (t, ev, fn) => { t.addEventListener(ev, fn); return () => t.removeEventListener(ev, fn); };
    const disposers = [
      on(els.octal, 'input', onOctal), on(els.symbolic, 'input', onSymbolic), on(els.command, 'input', onCommand),
      on(els.type, 'change', () => { save('type', els.type.value); els.applyDir.checked = isDir(); render(null); renderApply(); }),
      on(els.showType, 'change', () => { save('showType', els.showType.checked); render(null); }),
      on(els.pad4, 'change', () => { save('pad4', els.pad4.checked); render(null); }),
      on(els.form, 'change', () => { save('form', els.form.value); rebuildCommandField(); }),
      on(els.path, 'input', () => { save('path', els.path.value); render(null); }),
      on(els.rec, 'change', () => { save('rec', els.rec.checked); rebuildCommandField(); }),
      on(els.verb, 'change', () => { save('verb', els.verb.checked); rebuildCommandField(); }),
      on($('#cm-reset'), 'click', () => { els.type.value = 'file'; els.showType.checked = false; els.pad4.checked = false; setMode(DEFAULT_MODE, null); }),
    ];
    root.querySelectorAll('[data-copy]').forEach(b => disposers.push(on(b, 'click', () => copyText($(`#${b.dataset.copy}`).value))));

    // ---------- apply symbolic expression ----------
    const parseStart = text => {
      const t = text.trim();
      if (/^[0-7]{1,4}$/.test(t)) return L.parseOctal(t);
      if (/^0o/i.test(t)) return L.parseOctal(t);
      const r = L.parseSymbolic(t);
      if (r.ok) return r;
      return /^[0-9]+$/.test(t) ? L.parseOctal(t) : { ok: false, error: `Starting mode: ${r.error}` };
    };
    let applyResult = null;
    function renderApply() {
      els.applyOut.replaceChildren(); applyResult = null;
      const start = parseStart(els.start.value);
      if (!start.ok) { showErr('apply', start.error.startsWith('Starting') ? start.error : `Starting mode: ${start.error}`); return; }
      const um = L.parseUmask(els.applyUmask.value);
      if (!um.ok) { showErr('apply', `Umask: ${um.error}`); return; }
      if (!els.expr.value.trim()) { showErr('apply', ''); return; }
      const r = L.applySymbolic(els.expr.value, start.mode, { umask: um.umask, isDir: els.applyDir.checked });
      if (!r.ok) { showErr('apply', r.error); return; }
      showErr('apply', '');
      applyResult = r;
      const dirChar = els.applyDir.checked ? 'd' : '-';
      const ol = h('ol', 'cm-steps');
      for (const s of r.steps) ol.append(h('li', '', h('code', '', s.clause), ': ', h('code', '', `${L.modeToOctal(s.before)} ${L.modeToSymbolic(s.before)}`), ' → ', h('code', '', `${L.modeToOctal(s.after)} ${L.modeToSymbolic(s.after)}`)));
      const useBtn = h('button', 'btn btn-sm btn-primary', 'Use result as current mode'); useBtn.type = 'button';
      useBtn.addEventListener('click', () => { els.type.value = els.applyDir.checked ? 'dir' : 'file'; save('type', els.type.value); setMode(r.mode, null); });
      els.applyOut.append(
        h('p', 'cm-result', 'Result: ', h('code', '', L.modeToOctal(r.mode)), ' ', h('code', '', dirChar + L.modeToSymbolic(r.mode)), ' ', h('code', '', `chmod ${L.modeToOctal(r.mode)}`)),
        ol, useBtn);
    }
    for (const el of [els.start, els.expr, els.applyUmask, els.applyDir]) disposers.push(on(el, el === els.applyDir ? 'change' : 'input', renderApply));

    // ---------- umask ----------
    function renderUmask() {
      els.umaskOut.replaceChildren();
      const r = L.parseUmask(els.umask.value);
      if (!r.ok) { showErr('umask', r.error); return; }
      showErr('umask', r.extra ? 'Only the last three digits of an umask are used for permissions; the leading digit is ignored here.' : '');
      const a = L.applyUmask(r.umask);
      const t = h('table', 'table cm-small');
      t.append(h('thead', '', h('tr', '', h('th', '', 'New item'), h('th', '', 'Starts from'), h('th', '', 'Result'), h('th', '', 'Symbolic'))));
      const tb = h('tbody');
      tb.append(h('tr', '', h('th', '', 'File'), h('td', '', '666'), h('td', '', h('code', '', a.fileOctal)), h('td', '', h('code', '', a.fileSymbolic))));
      tb.append(h('tr', '', h('th', '', 'Directory'), h('td', '', '777'), h('td', '', h('code', '', a.dirOctal)), h('td', '', h('code', '', 'd' + a.dirSymbolic))));
      t.append(tb);
      els.umaskOut.append(t, h('p', 'cm-muted', `umask ${L.modeToOctal(a.umask)} removes ${L.modeToSymbolic(a.umask)} bits. Equivalent: umask -S prints ${a.umaskSymbolic}. Set it in a shell with `, h('code', '', `umask ${L.modeToOctal(a.umask)}`), '.'));
    }
    disposers.push(on(els.umask, 'input', renderUmask));
    disposers.push(on($('#cm-umask-from'), 'click', () => {
      els.umask.value = L.modeToOctal(L.umaskForMode(mode & 0o777)); renderUmask();
    }));

    // ---------- ls -l ----------
    function renderLs() {
      els.lsOut.replaceChildren();
      if (!els.ls.value.trim()) { showErr('ls', ''); return; }
      const { entries, errors } = L.parseLsOutput(els.ls.value);
      showErr('ls', errors.length ? errors.map(e => `Line ${e.line}: ${e.error}`).join(' ') : '');
      for (const e of entries) {
        const useBtn = h('button', 'btn btn-sm', 'Use this mode'); useBtn.type = 'button';
        useBtn.addEventListener('click', () => { els.type.value = e.type === 'd' ? 'dir' : 'file'; save('type', els.type.value); if (e.name) { els.path.value = e.name; save('path', e.name); } setMode(e.mode, null); });
        const card = h('div', 'cm-ls-entry',
          h('div', '', h('strong', '', e.name || '(no name)'), e.target ? ` → ${e.target}` : '', ' ', h('span', 'badge', e.typeName)),
          h('div', 'cm-muted', 'Owner ', h('code', '', e.owner), ', group ', h('code', '', e.group), ' · mode ', h('code', '', e.octal), ' ', h('code', '', e.symbolic), e.size != null ? ` · size ${e.size}` : '', e.date ? ` · ${e.date}` : ''),
          h('div', 'cm-muted', 'Ownership command: ', h('code', '', `chown ${L.shellQuote(e.owner + ':' + e.group)} ${L.shellQuote(e.name || 'file')}`)),
          useBtn);
        els.lsOut.append(card);
      }
    }
    disposers.push(on(els.ls, 'input', renderLs));

    // ---------- recursive helper ----------
    function renderRec() {
      els.recOut.replaceChildren();
      const d = L.parseOctal(els.rdir.value), f = L.parseOctal(els.rfile.value);
      if (!d.ok) { showErr('rec', `Directory mode: ${d.error}`); return; }
      if (!f.ok) { showErr('rec', `File mode: ${f.error}`); return; }
      showErr('rec', '');
      for (const v of L.recursiveCommands({ path: els.rpath.value.trim() || '.', dirMode: d.mode, fileMode: f.mode })) {
        const pre = h('pre', 'cm-code'); pre.textContent = v.command;
        const btn = h('button', 'btn btn-sm', 'Copy'); btn.type = 'button';
        btn.addEventListener('click', () => copyText(v.command));
        els.recOut.append(h('div', 'cm-var', h('div', 'cm-var-head', h('strong', '', v.title), btn), pre, h('p', 'cm-muted', v.note)));
      }
    }
    for (const el of [els.rpath, els.rdir, els.rfile]) disposers.push(on(el, 'input', renderRec));

    // ---------- presets & notes ----------
    const pb = $('#cm-presets-body');
    for (const p of L.PRESETS) {
      const [rl, rc] = RISK[p.risk];
      const btn = h('button', 'btn btn-sm', 'Apply'); btn.type = 'button'; btn.setAttribute('aria-label', `Apply ${L.modeToOctal(p.mode)}: ${p.title}`);
      btn.addEventListener('click', () => { setMode(p.mode, null); root.querySelector('#cm-grid-title').scrollIntoView({ block: 'nearest' }); });
      pb.append(h('tr', '', h('th', '', h('code', '', L.modeToOctal(p.mode))), h('td', '', h('code', '', L.modeToSymbolic(p.mode))), h('td', '', h('strong', '', p.title), ' ', h('span', rc, rl)), h('td', '', p.use), h('td', '', p.security), h('td', '', btn)));
    }
    for (const n of L.NOTES) $('#cm-notes').append(h('li', '', n));

    // ---------- init ----------
    render(null); renderApply(); renderUmask(); renderRec();
    renderIcons(root);
    return () => disposers.forEach(d => d());
  },
};
