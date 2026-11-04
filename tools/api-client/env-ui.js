// Environment manager dialog: globals + named environments, key/value rows with a "secret" toggle, import / export.
import { dialog, askText, checkbox, h } from './dialogs.js';
import { blankVar, uid, exportEnvs, DYNAMIC_VARS } from './store.js';
import { exportEnvironment } from './postman.js';
import { runImport, mergeEnvs, fileSlug } from './compose.js';
import { downloadFile, pickFile, readFileAsText, confirmDialog } from '../../assets/js/components/ui.js';

/**
 * env: the live environments state { globals, envs, activeId } (mutated in place).
 * persist(): save it; onChange(): refresh the toolbar selector and the variable hints.
 */
export function openEnvManager({ env, persist, onChange }) {
  let sel = env.activeId || 'globals';
  const current = () => (sel === 'globals' ? null : env.envs.find(e => e.id === sel) || null);
  const vars = () => (sel === 'globals' ? env.globals : (current()?.vars || env.globals));
  const changed = () => { persist(); onChange(); };

  const listHost = h('div', { class: 'ac-env-list', role: 'group', 'aria-label': 'Environments' });
  const editHost = h('div', { class: 'ac-env-edit' });
  const msg = h('div', { hidden: true, 'aria-live': 'polite' });
  const showMsg = (type, text) => { msg.hidden = !text; msg.className = `alert alert-${type}`; msg.textContent = text || ''; };
  const secrets = checkbox('Include secret values in exports', false);

  function renderList() {
    const item = (id, label, active) => {
      const b = h('button', { class: `btn btn-sm ac-env-item${sel === id ? ' active' : ''}`, type: 'button', 'aria-pressed': String(sel === id) }, label, active ? ' (active)' : '');
      b.addEventListener('click', () => { sel = id; renderAll(); });
      return b;
    };
    listHost.replaceChildren(item('globals', 'Globals', false), ...env.envs.map(e => item(e.id, e.name, e.id === env.activeId)));
  }

  function renderEditor() {
    const e = current();
    const title = sel === 'globals' ? 'Globals (available in every request)' : e ? e.name : 'Globals';
    const tools = h('div', { class: 'ac-env-tools' });
    const btn = (label, fn, opts = {}) => {
      const b = h('button', { class: `btn btn-sm${opts.danger ? ' btn-danger' : ''}`, type: 'button' }, label);
      b.disabled = !!opts.disabled; b.addEventListener('click', fn); return b;
    };
    const isG = sel === 'globals' || !e;
    tools.append(
      btn('New environment', async () => {
        const name = await askText({ title: 'New environment', label: 'Name', confirmLabel: 'Create' });
        if (!name) return;
        const ne = { id: uid(), name, vars: [] };
        env.envs.push(ne); sel = ne.id; if (!env.activeId) env.activeId = ne.id;
        changed(); renderAll();
      }),
      btn('Rename', async () => {
        const name = await askText({ title: 'Rename environment', label: 'Name', value: e.name, confirmLabel: 'Rename' });
        if (name) { e.name = name; changed(); renderAll(); }
      }, { disabled: isG }),
      btn('Duplicate', () => {
        const c = { id: uid(), name: `${e.name} (copy)`, vars: e.vars.map(v => ({ ...v })) };
        env.envs.splice(env.envs.indexOf(e) + 1, 0, c); sel = c.id; changed(); renderAll();
      }, { disabled: isG }),
      btn(env.activeId === (e && e.id) ? 'Active' : 'Make active', () => { env.activeId = e.id; changed(); renderAll(); }, { disabled: isG || env.activeId === e.id }),
      btn('Delete', async () => {
        if (!(await confirmDialog('Delete environment', `Delete "${e.name}" and its ${e.vars.length} variable${e.vars.length === 1 ? '' : 's'}?`, 'Delete'))) return;
        env.envs.splice(env.envs.indexOf(e), 1);
        if (env.activeId === e.id) env.activeId = null;
        sel = 'globals'; changed(); renderAll();
      }, { danger: true, disabled: isG }));

    const rows = h('div', { class: 'ac-rows ac-env-rows' });
    const list = vars();
    const drawRows = () => {
      rows.replaceChildren(...list.map((v, i) => {
        const en = h('input', { type: 'checkbox', 'aria-label': `Enable variable ${i + 1}` }); en.checked = v.enabled !== false;
        const key = h('input', { class: 'input mono', placeholder: 'name', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Variable ${i + 1} name` }); key.value = v.key;
        const val = h('input', { class: 'input mono', placeholder: 'value', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Variable ${i + 1} value` });
        val.value = v.value; val.type = v.secret ? 'password' : 'text';
        const sec = h('input', { type: 'checkbox', 'aria-label': `Variable ${i + 1} is secret` }); sec.checked = !!v.secret;
        const del = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Remove variable ${i + 1}` }, '✕');
        en.addEventListener('change', () => { v.enabled = en.checked; changed(); });
        key.addEventListener('input', () => { v.key = key.value.trim(); changed(); });
        val.addEventListener('input', () => { v.value = val.value; changed(); });
        sec.addEventListener('change', () => { v.secret = sec.checked; val.type = sec.checked ? 'password' : 'text'; changed(); });
        del.addEventListener('click', () => { list.splice(i, 1); changed(); drawRows(); });
        return h('div', { class: 'ac-env-row' }, en, key, val, h('label', { class: 'ac-check', title: 'Secret values are masked here and left out of exports' }, sec, ' secret'), del);
      }));
      if (!list.length) rows.append(h('p', { class: 'hint' }, 'No variables yet.'));
    };
    drawRows();
    const add = h('button', { class: 'btn btn-sm', type: 'button' }, '+ Add variable');
    add.addEventListener('click', () => { list.push(blankVar()); changed(); drawRows(); [...rows.querySelectorAll('.ac-env-row')].pop()?.querySelector('input.mono')?.focus(); });
    editHost.replaceChildren(h('h4', { class: 'ac-h4' }, title), tools, rows, add);
  }

  function renderAll() { renderList(); renderEditor(); }

  const exportAll = () => {
    const out = exportEnvs(env, { includeSecrets: secrets.input.checked });
    downloadFile('api-client-environments.json', JSON.stringify(out, null, 2), 'application/json');
    showMsg('success', secrets.input.checked ? 'Exported with secret values. Keep the file private.' : 'Exported. Secret values were left out.');
  };
  const exportPostman = () => {
    const e = current();
    const src = e || { name: 'Globals', vars: env.globals };
    const out = exportEnvironment(src, { includeSecrets: secrets.input.checked });
    if (!e) out._postman_variable_scope = 'globals';
    downloadFile(`${fileSlug(src.name)}.postman_environment.json`, JSON.stringify(out, null, 2), 'application/json');
    showMsg('success', secrets.input.checked ? 'Exported for Postman with secret values.' : 'Exported for Postman. Secret values were left out.');
  };
  const importFile = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    let text;
    try { text = await readFileAsText(f); } catch { return showMsg('error', 'The file could not be read.'); }
    const r = runImport(text);
    if (!r.ok) return showMsg('error', r.error);
    if (r.kind === 'dt-collection' || r.kind === 'postman-collection') return showMsg('error', 'That file is a collection. Use "Import…" in the Collections tab (its variables are added as an environment automatically).');
    const m = mergeEnvs(env, r);
    Object.assign(env, m.state);
    const notes = [...r.warnings];
    if (m.skippedGlobals) notes.push(`${m.skippedGlobals} global variable${m.skippedGlobals === 1 ? '' : 's'} already existed and were kept.`);
    if (r.envs[0]) sel = r.envs[0].id;
    changed(); renderAll();
    showMsg(notes.length ? 'warn' : 'success', [r.summary, ...notes].join('\n'));
  };
  const bar = (...kids) => h('div', { class: 'ac-env-tools' }, ...kids);
  const mk = (label, fn, title) => { const b = h('button', { class: 'btn btn-sm', type: 'button', title: title || '' }, label); b.addEventListener('click', fn); return b; };

  renderAll();
  dialog({
    title: 'Environments & variables', wide: true, onClose: () => { persist(); onChange(); },
    body: [
      h('p', { class: 'hint' }, 'Use ', h('code', {}, '{{name}}'), ' in the URL, params, headers, body and auth. An environment overrides globals of the same name. Dynamic variables: ',
        h('code', {}, DYNAMIC_VARS.map(v => `{{${v}}}`).join(' ')), '.'),
      h('div', { class: 'ac-env-layout' }, listHost, editHost),
      h('div', { class: 'ac-env-foot' }, secrets.label,
        bar(mk('Export all (JSON)', exportAll), mk('Export selected for Postman', exportPostman), mk('Import…', importFile, 'Import a Developer Toolbox environment export or a Postman environment'))),
      msg,
      h('p', { class: 'hint' }, 'Secret values are masked in this dialog and excluded from exports and history, but they are stored unencrypted in this browser\'s localStorage. Do not use secrets on a shared computer.'),
    ],
    actions: [{ label: 'Done', primary: true }],
  });
}
