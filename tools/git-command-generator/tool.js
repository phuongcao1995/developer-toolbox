// Git Command Generator UI. Shows commands only: nothing is executed. All untrusted text goes through textContent / safe DOM.
import { copyText, toast, renderIcons } from '../../assets/js/components/ui.js';
import * as G from './logic.js';

const SVG = 'http://www.w3.org/2000/svg';
function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const sv = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const TABS = ['builder', 'cheat', 'explain', 'favs'];

/** Commit-graph diagram built with SVG DOM calls only. Status is conveyed by text and line style, not colour alone. */
function commitDiagram(d) {
  const gap = 74, r = 17, w = d.nodes.length * gap + 40, hgt = 120;
  const svg = sv('svg', { viewBox: `0 0 ${w} ${hgt}`, role: 'img', class: 'gg-svg', 'aria-label': `${d.title}: ${d.text}` });
  svg.append(sv('title', {}, d.title));
  const x = i => 40 + i * gap, y = 74;
  d.nodes.forEach((n, i) => {
    if (i > 0) svg.append(sv('line', { x1: x(i - 1) + r, y1: y, x2: x(i) - r, y2: y, class: `gg-edge${n.state === 'faded' ? ' gg-dashed' : ''}` }));
  });
  d.nodes.forEach((n, i) => {
    svg.append(sv('circle', { cx: x(i), cy: y, r, class: `gg-node${n.state ? ' gg-' + n.state : ''}` }));
    svg.append(sv('text', { x: x(i), y: y + 5, 'text-anchor': 'middle', class: 'gg-label' }, n.label));
    const cap = n.state === 'faded' ? 'unreachable' : n.state === 'new' ? 'new commit' : n.state === 'source' ? 'file source' : '';
    if (cap) svg.append(sv('text', { x: x(i), y: y + 38, 'text-anchor': 'middle', class: 'gg-cap' }, cap));
  });
  const bx = x(d.branch.at);
  svg.append(sv('rect', { x: bx - 26, y: 8, width: 52, height: 22, rx: 5, class: 'gg-branch' }));
  svg.append(sv('text', { x: bx, y: 23, 'text-anchor': 'middle', class: 'gg-btext' }, d.branch.name));
  svg.append(sv('line', { x1: bx, y1: 30, x2: bx, y2: y - r - 2, class: 'gg-edge' }));
  return svg;
}

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = { find: $('#gg-find'), task: $('#gg-task'), shell: $('#gg-shell'), form: $('#gg-form'), summary: $('#gg-summary'), out: $('#gg-out'),
      tabs: [...root.querySelectorAll('.gg-tabs [role="tab"]')], favCount: $('#gg-fav-count') };
    const store = (k, d) => { try { return ctx.storage.get(k, d) ?? d; } catch { return d; } };
    const save = (k, v) => { try { ctx.storage.set(k, v); } catch { /* storage unavailable */ } };

    let shell = G.SHELLS[store('shell', 'posix')] ? store('shell', 'posix') : (/Win/i.test(navigator.platform || '') ? 'powershell' : 'posix');
    let taskId = G.getTask(store('task', '')) ? store('task', '') : 'commit';
    let allVals = store('values', {}); if (!allVals || typeof allVals !== 'object') allVals = {};
    let favs = G.sanitizeFavourites(store('favs', []));
    let current = null;

    for (const [k, label] of Object.entries(G.SHELLS)) els.shell.append(new Option(label, k));
    els.shell.value = shell;

    // ---------- task picker ----------
    function fillTasks(query) {
      const q = String(query || '').toLowerCase().trim();
      els.task.replaceChildren();
      let n = 0;
      for (const [cat, label] of G.CATEGORIES) {
        const list = G.tasksByCategory(cat).filter(t => !q || `${t.title} ${t.summary} ${label} ${t.id}`.toLowerCase().includes(q) || (q.split(/\s+/).every(w => `${t.title} ${t.summary} ${label}`.toLowerCase().includes(w))));
        if (!list.length) continue;
        const g = document.createElement('optgroup'); g.label = label;
        for (const t of list) { g.append(new Option(t.title, t.id)); n++; }
        els.task.append(g);
      }
      if (!n) els.task.append(new Option('No matching task', ''));
      if ([...els.task.options].some(o => o.value === taskId)) els.task.value = taskId;
      else if (n && q) { taskId = els.task.options[0].value; els.task.value = taskId; }
      return n;
    }

    // ---------- form ----------
    let formKey = '';
    const values = () => allVals[taskId] || (allVals[taskId] = {});
    function renderForm(force) {
      const task = G.getTask(taskId);
      const v = { ...G.defaultValues(task), ...values() };
      const vis = G.visibleFields(task, v);
      const key = taskId + ':' + vis.map(f => f.id).join(',');
      if (!force && key === formKey) return;
      formKey = key;
      els.summary.textContent = task.summary;
      els.form.replaceChildren();
      for (const f of vis) {
        const id = `gg-f-${f.id}`;
        const wrap = h('div', f.type === 'check' ? 'gg-check' : 'field');
        let input;
        if (f.type === 'check') {
          input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!v[f.id];
          const lab = h('label', 'check'); lab.append(input, ' ', f.label); wrap.append(lab);
          input.id = id;
        } else {
          wrap.append(Object.assign(h('label', '', f.label), { htmlFor: id }));
          if (f.type === 'select') { input = h('select', 'select'); for (const [val, label] of f.options) input.append(new Option(label, val)); input.value = v[f.id]; }
          else if (f.type === 'textarea' || f.type === 'paths') { input = h('textarea', 'textarea'); input.rows = f.type === 'paths' ? 3 : 4; input.value = v[f.id]; input.spellcheck = false; }
          else { input = h('input', 'input'); input.type = f.type === 'int' ? 'number' : 'text'; if (f.type === 'int') { input.min = f.min ?? 0; input.inputMode = 'numeric'; } input.value = v[f.id]; input.spellcheck = false; input.autocomplete = 'off'; }
          input.id = id;
          if (f.ex) input.placeholder = f.ex;
          if (f.req && typeof f.req !== 'function') input.setAttribute('aria-required', 'true');
        }
        if (f.help) { const hp = h('div', 'gg-help', f.help); hp.id = `${id}-help`; wrap.append(input, hp); input.setAttribute('aria-describedby', hp.id); } else if (f.type !== 'check') wrap.append(input); else wrap.append();
        const er = h('div', 'gg-err'); er.id = `${id}-err`; er.hidden = true; er.setAttribute('role', 'alert'); wrap.append(er);
        input.dataset.field = f.id;
        const ev = f.type === 'check' || f.type === 'select' ? 'change' : 'input';
        input.addEventListener(ev, () => { values()[f.id] = f.type === 'check' ? input.checked : input.value; save('values', allVals); update(); });
        els.form.append(wrap);
      }
    }
    function showErrors(res) {
      for (const input of els.form.querySelectorAll('[data-field]')) {
        const er = $(`#${input.id}-err`); const msg = res.errors[input.dataset.field];
        er.hidden = !msg; er.textContent = msg || '';
        if (msg) { input.setAttribute('aria-invalid', 'true'); const d = (input.getAttribute('aria-describedby') || '').split(' ').filter(Boolean); if (!d.includes(er.id)) input.setAttribute('aria-describedby', [...d, er.id].join(' ')); }
        else input.removeAttribute('aria-invalid');
      }
    }

    // ---------- output ----------
    function update() {
      renderForm(false);
      const task = G.getTask(taskId);
      const res = G.generate(task, values(), { shell });
      current = res;
      showErrors(res);
      const out = els.out; out.replaceChildren();
      if (res.danger) {
        const box = h('div', 'gg-danger', h('div', '', h('span', 'badge badge-danger', res.danger.level === 'high' ? 'DANGER' : 'CAUTION'), ' ', h('strong', '', 'What could go wrong')), h('p', '', res.danger.what), h('p', '', h('strong', '', 'How to undo / recover: '), res.danger.undo));
        for (const extra of res.dangers.filter(d => d !== res.danger)) box.append(h('p', '', extra.what, ' ', h('em', '', 'Undo: ' + extra.undo)));
        box.setAttribute('role', 'note'); out.append(box);
      }
      if (!res.ok) {
        const parts = [];
        if (res.missing.length) parts.push(`Fill in: ${res.missing.map(id => task.fields.find(f => f.id === id).label.replace(/\s*\(.*$/, '')).join(', ')}.`);
        if (Object.keys(res.errors).length) parts.push('Fix the highlighted fields.');
        out.append(h('div', 'alert alert-warn', parts.join(' '), ' The preview shows <placeholders> until then.'));
      }
      for (const w of res.warnings) out.append(h('div', 'alert alert-info', w));
      const steps = h('ol', 'gg-steps');
      for (const s of res.steps) {
        if (!s.text) { steps.append(h('li', 'gg-comment', s.comment)); continue; }
        const pre = h('code', 'gg-cmd'); pre.textContent = s.text;
        const btn = h('button', 'btn btn-sm', 'Copy'); btn.type = 'button'; btn.setAttribute('aria-label', `Copy: ${s.text.slice(0, 60)}`);
        btn.addEventListener('click', () => copyText(s.text));
        steps.append(h('li', '', s.comment ? h('div', 'gg-why', s.comment) : null, h('div', 'gg-cmdrow', pre, btn)));
      }
      out.append(steps);
      if (res.flags.length) { const dl = h('dl', 'gg-flags'); for (const [f, t] of res.flags) { const dt = h('dt'); dt.append(h('code', '', f)); dl.append(dt, h('dd', '', t)); } out.append(h('h4', '', 'What each part does'), dl); }
      const list = (title, items, cls) => { if (!items.length) return; const ul = h('ul', cls || 'gg-list'); items.forEach(i => ul.append(h('li', '', i))); out.append(h('h4', '', title), ul); };
      list('Undo / recover', res.undo); list('Alternatives', res.alts); list('Notes', res.notes);
    }

    // ---------- tabs ----------
    function activate(name, focus) {
      if (!TABS.includes(name)) name = 'builder';
      els.tabs.forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
      for (const k of TABS) $(`#gg-panel-${k}`).hidden = k !== name;
      save('tab', name);
    }

    // ---------- cheat sheet ----------
    const cheatList = $('#gg-cheat-list');
    function renderCheat() {
      const rows = G.searchCheatsheet($('#gg-cheat-q').value);
      cheatList.replaceChildren();
      $('#gg-cheat-count').textContent = `${rows.length} of ${G.CHEATSHEET.length} commands`;
      for (const e of rows) {
        const btn = h('button', 'btn btn-sm', 'Copy'); btn.type = 'button'; btn.setAttribute('aria-label', `Copy ${e.cmd}`);
        btn.addEventListener('click', () => copyText(e.cmd));
        const code = h('code', 'gg-cmd'); code.textContent = e.cmd;
        cheatList.append(h('li', 'gg-cheat-row', h('div', 'gg-cheat-main', code, h('span', 'gg-muted', e.desc, ' ', h('span', 'badge', e.cat))), btn));
      }
      if (!rows.length) cheatList.append(h('li', 'gg-muted', 'No command matches your search.'));
    }

    // ---------- explainer ----------
    function renderExplain() {
      const box = $('#gg-explain'); box.replaceChildren();
      box.append(h('p', '', 'Three commands that "undo" things, but they act on different layers: the branch pointer, a new commit, or just your files.'));
      const t = G.EXPLAINER.table;
      const table = h('table', 'table gg-table');
      table.append(h('thead', '', h('tr', '', ...t.head.map(x => h('th', '', x)))));
      const tb = h('tbody'); for (const r of t.rows) tb.append(h('tr', '', h('th', '', r[0]), ...r.slice(1).map(x => h('td', '', x)))); table.append(tb);
      box.append(h('div', 'table-wrap', table));
      for (const d of G.EXPLAINER.diagrams) {
        const pre = h('pre', 'gg-ascii'); pre.textContent = d.ascii;
        box.append(h('section', 'gg-diagram', h('h4', '', d.title), h('p', '', d.text), commitDiagram(d), h('details', '', h('summary', '', 'Text version'), pre)));
      }
      box.append(h('p', 'gg-muted', 'Rule of thumb: private mistakes, use reset; already shared, use revert; only file contents, use restore.'));
    }

    // ---------- favourites ----------
    function renderFavs() {
      els.favCount.textContent = String(favs.length);
      const box = $('#gg-favs'); box.replaceChildren();
      if (!favs.length) { box.append(h('p', 'gg-muted', 'No favourites yet.')); return; }
      for (const f of favs) {
        const pre = h('pre', 'gg-ascii'); pre.textContent = f.text;
        const copy = h('button', 'btn btn-sm', 'Copy'); copy.type = 'button'; copy.addEventListener('click', () => copyText(f.text));
        const del = h('button', 'btn btn-sm btn-danger', 'Delete'); del.type = 'button'; del.setAttribute('aria-label', `Delete favourite ${f.label}`);
        del.addEventListener('click', () => { favs = G.removeFavourite(favs, f.id); save('favs', favs); renderFavs(); });
        const open = f.task && G.getTask(f.task) ? (() => { const b = h('button', 'btn btn-sm', 'Open builder'); b.type = 'button'; b.addEventListener('click', () => { taskId = f.task; els.find.value = ''; fillTasks(''); save('task', taskId); renderForm(true); update(); activate('builder'); }); return b; })() : null;
        box.append(h('div', 'gg-fav', h('div', 'gg-fav-head', h('strong', '', f.label), h('span', 'gg-fav-btns', open, copy, del)), pre));
      }
    }

    // ---------- events ----------
    const on = (t, ev, fn) => { t.addEventListener(ev, fn); return () => t.removeEventListener(ev, fn); };
    const disposers = [
      on(els.find, 'input', () => { fillTasks(els.find.value); if (els.task.value) { taskId = els.task.value; save('task', taskId); update(); } }),
      on(els.task, 'change', () => { if (!els.task.value) return; taskId = els.task.value; save('task', taskId); renderForm(true); update(); }),
      on(els.shell, 'change', () => { shell = els.shell.value; save('shell', shell); update(); }),
      on($('#gg-reset'), 'click', () => { delete allVals[taskId]; save('values', allVals); renderForm(true); update(); }),
      on($('#gg-copy-all'), 'click', () => current && copyText(current.script)),
      on($('#gg-copy-plain'), 'click', () => current && copyText(current.plain)),
      on($('#gg-save'), 'click', () => {
        if (!current || !current.plain) return;
        if (!current.ok) { toast('Fill in the required fields before saving', 'warn'); return; }
        favs = G.addFavourite(favs, { label: G.getTask(taskId).title, text: current.script, task: taskId }); save('favs', favs); renderFavs(); toast('Saved to favourites', 'success');
      }),
      on($('#gg-cheat-q'), 'input', renderCheat),
      ...els.tabs.map((b, idx) => [on(b, 'click', () => activate(b.dataset.tab)), on(b, 'keydown', e => {
        const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); activate(TABS[e.key === 'Home' ? 0 : TABS.length - 1], true); } else if (k) { e.preventDefault(); activate(TABS[(idx + k + TABS.length) % TABS.length], true); }
      })]).flat(),
    ];

    fillTasks(''); renderForm(true); update(); renderCheat(); renderExplain(); renderFavs();
    activate(TABS.includes(store('tab', 'builder')) ? store('tab', 'builder') : 'builder');
    renderIcons(root);
    return () => disposers.forEach(d => d());
  },
};
