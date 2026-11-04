import { copyText, downloadFile, toast, showMessage, bindActions, confirmDialog, pickFile, readFileAsText, enableTabIndent } from '../../assets/js/components/ui.js';
import { parseCurl, buildCurl, buildFetch, buildPython } from '../../assets/js/shared/curl.js';
import * as L from './logic.js';
import * as S from './store.js';
import * as C from './compose.js';
import { REDIRECT_NOTE } from './response.js';
import { createResponseView } from './response-ui.js';
import { createCollections } from './collections-ui.js';
import { openEnvManager } from './env-ui.js';
import { dialog, h } from './dialogs.js';

const EXAMPLE_URL = 'https://jsonplaceholder.typicode.com/todos/1';
const COPY_LABELS = { 'curl-posix': 'cURL (bash)', 'curl-cmd': 'cURL (cmd)', 'curl-powershell': 'cURL (PowerShell)', fetch: 'fetch() snippet', python: 'Python requests snippet' };

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const blank = () => ({ key: '', value: '', enabled: true });
    const state = {
      params: [blank()], headers: [blank()], auth: L.normalizeAuth(null),
      history: [], controller: null, cancelled: false, activeId: null, snapshot: null, revealAuth: false, lastDirty: false,
    };
    const el = {
      app: $('#ac-app'), method: $('#ac-method'), url: $('#ac-url'), send: $('#ac-send'), cancel: $('#ac-cancel'), error: $('#ac-error'),
      warn: $('#ac-warn'), warnText: $('#ac-warn-text'), body: $('#ac-body'), bodyType: $('#ac-body-type'), bodyMsg: $('#ac-body-msg'), bodyNote: $('#ac-body-note'),
      timeout: $('#ac-timeout'), redirect: $('#ac-redirect'), credentials: $('#ac-credentials'), env: $('#ac-env'), copyas: $('#ac-copyas'),
      history: $('#ac-history'), saveSens: $('#ac-save-sens'), histQ: $('#ac-hist-q'), histF: $('#ac-hist-f'),
      reqName: $('#ac-reqname'), reqPath: $('#ac-reqpath'), dirty: $('#ac-dirty'), varsNote: $('#ac-vars-note'), colNote: $('#ac-col-note'),
      authType: $('#ac-auth-type'), authFields: $('#ac-auth-fields'), authPreview: $('#ac-auth-preview'), authLine: $('#ac-auth-line'), authReveal: $('#ac-auth-reveal'), authBadge: $('#ac-auth-badge'),
      side: $('#ac-side'), sideToggle: $('#ac-side-toggle'), scrim: $('#ac-scrim'), forbidden: $('#ac-forbidden'),
    };
    $('#ac-redirect-note').textContent = REDIRECT_NOTE;

    // ---------- persistence ----------
    const colInfo = S.parseStored(ctx.storage.get('collections', null));
    const col = { tree: colInfo.tree, readOnly: colInfo.readOnly };
    const envState = S.normalizeEnvs(ctx.storage.get('envs', null));
    let colSize = { bytes: 0, warn: false };
    const store = (key, value, what) => {
      const ok = ctx.storage.set(key, value);
      if (!ok) toast(`Could not save ${what}: browser storage is full or blocked. Export your data to keep it.`, 'error', 6000);
      return ok;
    };
    function updateColNote() {
      const msgs = [...colInfo.warnings];
      if (colSize.warn) msgs.push(`Collections use ${(colSize.bytes / 1048576).toFixed(1)} MB of the roughly 5 MB browser storage. Export and delete what you no longer need.`);
      showMessage(el.colNote, msgs.length ? 'warn' : null, msgs.join('\n'));
    }
    function persistCollections() {
      if (col.readOnly) return;
      const payload = S.serializeStore(col.tree);
      colSize = S.storageSize(payload);
      store('collections', payload, 'collections');
      updateColNote();
      updateReqLabel(); refresh.flush?.();
    }
    const persistEnvs = () => { store('envs', envState, 'environments'); };
    const persistHistory = () => { store('history', state.history, 'history'); };
    if (!col.readOnly) colSize = S.storageSize(S.serializeStore(col.tree));
    updateColNote();

    state.history = L.normalizeHistory(ctx.storage.get('history', [])).map(e => ({ ...e, headers: L.redactRows(e.headers, false), auth: L.redactAuth(e.auth, false) }));
    persistHistory();

    // ---------- variables / environments ----------
    const activeEnv = () => envState.envs.find(e => e.id === envState.activeId) || null;
    const currentVars = () => S.buildVarMap(envState.globals, activeEnv());
    function renderEnvSelect() {
      const opts = [h('option', { value: '' }, 'No environment'), ...envState.envs.map(e => h('option', { value: e.id }, e.name))];
      el.env.replaceChildren(...opts);
      el.env.value = envState.activeId || '';
    }
    el.env.addEventListener('change', () => { envState.activeId = el.env.value || null; persistEnvs(); refresh(); });
    function updateVarsNote() {
      const d = readDraft();
      const texts = [d.url, d.body, ...d.headers.flatMap(r => [r.key, r.value]), ...Object.entries(d.auth).filter(([k, v]) => typeof v === 'string' && k !== 'type' && k !== 'in').map(([, v]) => v)];
      const used = [...new Set(texts.flatMap(t => S.findVars(t, { skipDynamic: true })))];
      const vars = currentVars();
      const missing = used.filter(n => !Object.prototype.hasOwnProperty.call(vars, n));
      if (missing.length) el.varsNote.textContent = `Unresolved variable${missing.length === 1 ? '' : 's'}: ${missing.map(n => `{{${n}}}`).join(', ')}. Define ${missing.length === 1 ? 'it' : 'them'} under Environments, or they are sent as literal text.`;
      else if (used.length) el.varsNote.textContent = `Variables resolved at send time: ${used.map(n => `{{${n}}}`).join(', ')}${activeEnv() ? ` (environment: ${activeEnv().name})` : ''}.`;
      else el.varsNote.textContent = '';
      el.varsNote.classList.toggle('ac-varsnote-bad', missing.length > 0);
    }

    // ---------- tabs (ARIA tablist, arrow-key navigation) ----------
    const uid = Math.random().toString(36).slice(2, 7);
    const wireTabs = (tabAttr, panelAttr, onSel) => {
      const tabs = [...root.querySelectorAll(`[${tabAttr}]`)], panels = [...root.querySelectorAll(`[${panelAttr}]`)];
      tabs[0]?.parentElement?.setAttribute('role', 'tablist');
      // Keep existing ids (e.g. #ac-cookies / #ac-timing are looked up by id elsewhere); only add one when missing.
      tabs.forEach(t => { t.setAttribute('role', 'tab'); if (!t.id) t.id = `ac-${uid}-t-${t.getAttribute(tabAttr)}`; });
      panels.forEach(p => {
        const name = p.getAttribute(panelAttr), t = tabs.find(x => x.getAttribute(tabAttr) === name);
        p.setAttribute('role', 'tabpanel'); if (!p.id) p.id = `ac-${uid}-p-${name}`;
        if (t) { p.setAttribute('aria-labelledby', t.id); t.setAttribute('aria-controls', p.id); }
      });
      const select = name => {
        tabs.forEach(t => { const on = t.getAttribute(tabAttr) === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
        panels.forEach(p => { p.hidden = p.getAttribute(panelAttr) !== name; });
        onSel?.(name);
      };
      tabs.forEach((t, i) => {
        t.addEventListener('click', () => select(t.getAttribute(tabAttr)));
        t.addEventListener('keydown', e => {
          const stepBy = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          const to = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : stepBy ? (i + stepBy + tabs.length) % tabs.length : null;
          if (to == null) return;
          e.preventDefault(); tabs[to].focus(); select(tabs[to].getAttribute(tabAttr));
        });
      });
      select(tabs.find(t => t.classList.contains('active'))?.getAttribute(tabAttr) || tabs[0]?.getAttribute(tabAttr));
      return select;
    };
    wireTabs('data-tab', 'data-panel', name => { if (name !== 'auth' && state.revealAuth) { state.revealAuth = false; updateAuthPreview(); } });
    wireTabs('data-stab', 'data-spanel');
    wireTabs('data-rtab', 'data-rpanel');

    // ---------- sidebar drawer (<= 720px) ----------
    const openSide = () => { el.app.classList.add('side-open'); el.scrim.hidden = false; el.sideToggle.setAttribute('aria-expanded', 'true'); el.side.querySelector('[role=tab][aria-selected=true]')?.focus(); };
    const closeSide = (refocus = true) => {
      if (!el.app.classList.contains('side-open')) return;
      el.app.classList.remove('side-open'); el.scrim.hidden = true; el.sideToggle.setAttribute('aria-expanded', 'false');
      if (refocus && el.side.contains(document.activeElement)) el.sideToggle.focus();
    };
    el.sideToggle.addEventListener('click', () => (el.app.classList.contains('side-open') ? closeSide() : openSide()));
    $('#ac-side-close').addEventListener('click', () => closeSide());
    el.scrim.addEventListener('click', () => closeSide());

    // ---------- key/value editors ----------
    const lists = { params: $('#ac-params-rows'), headers: $('#ac-headers-rows') };
    const NOUN = { params: 'Param', headers: 'Header' };
    function renderRows(kind) {
      const n = NOUN[kind];
      lists[kind].replaceChildren(...state[kind].map((r, i) => {
        const cb = h('input', { type: 'checkbox', 'data-f': 'enabled', 'aria-label': `Enable ${n.toLowerCase()} ${i + 1}` }); cb.checked = r.enabled !== false;
        const k = h('input', { class: 'input mono', 'data-f': 'key', placeholder: kind === 'params' ? 'name' : 'Header-Name', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${n} ${i + 1} key` }); k.value = r.key;
        const v = h('input', { class: 'input mono ac-val', 'data-f': 'value', placeholder: 'value', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${n} ${i + 1} value` }); v.value = r.value;
        const del = h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'data-del': String(i), 'aria-label': `Remove ${n.toLowerCase()} ${i + 1}` }, '✕');
        return h('div', { class: `ac-row${r.enabled === false ? ' off' : ''}`, 'data-i': String(i) }, cb, k, v, del);
      }));
      updateCounts();
    }
    function updateCounts() {
      $('#ac-params-count').textContent = String(L.activeRows(state.params).length);
      $('#ac-headers-count').textContent = String(L.activeRows(state.headers).length);
      const bad = L.forbiddenHeaderNames(state.headers);
      el.forbidden.hidden = !bad.length;
      el.forbidden.textContent = bad.length ? `The browser controls ${bad.join(', ')} and will drop ${bad.length === 1 ? 'it' : 'them'} silently.` : '';
    }
    const syncUrlFromParams = () => { if (el.url.value.trim()) el.url.value = L.applyParamsToUrl(el.url.value, state.params); };
    function syncParamsFromUrl() {
      const fromUrl = L.paramsFromText(el.url.value);
      const disabled = state.params.filter(r => r.enabled === false && (r.key || r.value));
      state.params = [...fromUrl, ...disabled];
      if (!state.params.length) state.params.push(blank());
      renderRows('params');
    }
    for (const kind of ['params', 'headers']) {
      lists[kind].addEventListener('input', e => {
        const row = e.target.closest('.ac-row'); if (!row) return;
        const r = state[kind][+row.dataset.i], f = e.target.dataset.f;
        r[f] = f === 'enabled' ? e.target.checked : e.target.value;
        if (f === 'enabled') row.classList.toggle('off', !r.enabled);
        updateCounts();
        if (kind === 'params') syncUrlFromParams(); else updateBodyNote();
      });
      lists[kind].addEventListener('click', e => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        state[kind].splice(+b.dataset.del, 1);
        if (!state[kind].length) state[kind].push(blank());
        renderRows(kind);
        if (kind === 'params') syncUrlFromParams(); else updateBodyNote();
        refresh();
      });
    }
    el.url.addEventListener('input', syncParamsFromUrl);

    // ---------- auth tab ----------
    function authField(label, key, { secret = false, placeholder = '' } = {}) {
      const input = h('input', { class: 'input mono', type: secret ? 'password' : 'text', placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
      input.value = state.auth[key] || '';
      input.addEventListener('input', () => { state.auth[key] = input.value; authChanged(); });
      const kids = [label, input];
      if (secret) {
        const show = h('input', { type: 'checkbox', 'aria-label': `Show ${label.toLowerCase()}` });
        show.addEventListener('change', () => { input.type = show.checked ? 'text' : 'password'; });
        kids.push(h('span', { class: 'ac-check ac-showpw' }, show, ' show'));
      }
      return h('label', { class: 'ac-field' }, ...kids);
    }
    function renderAuth() {
      const t = state.auth.type;
      el.authType.value = t;
      const f = [];
      if (t === 'bearer') f.push(authField('Token', 'token', { secret: true, placeholder: '{{token}}' }), authField('Scheme prefix', 'prefix', { placeholder: 'Bearer' }));
      else if (t === 'basic') f.push(authField('Username', 'username'), authField('Password', 'password', { secret: true }));
      else if (t === 'apikey') {
        const where = h('select', { class: 'select', 'aria-label': 'Add API key to' }, h('option', { value: 'header' }, 'Header'), h('option', { value: 'query' }, 'Query parameter'));
        where.value = state.auth.in || 'header';
        where.addEventListener('change', () => { state.auth.in = where.value; authChanged(); });
        f.push(h('label', { class: 'ac-field' }, 'Add to', where), authField('Name', 'name', { placeholder: 'X-API-Key' }), authField('Value', 'value', { secret: true, placeholder: '{{apiKey}}' }));
      } else if (t === 'custom') f.push(authField('Scheme prefix', 'prefix', { placeholder: 'Token' }), authField('Credential', 'credential', { secret: true }));
      else f.push(h('p', { class: 'hint' }, 'No authentication is added. Choose a type above.'));
      el.authFields.replaceChildren(...f);
      authChanged();
    }
    function authChanged() {
      const on = state.auth.type !== 'none';
      el.authBadge.hidden = !on; el.authBadge.textContent = on ? 'on' : '';
      updateAuthPreview();
    }
    function updateAuthPreview() {
      const p = C.previewAuth(readDraft(), { vars: currentVars() });
      el.authPreview.hidden = p.state === 'none';
      el.authReveal.hidden = !(p.state === 'header' || p.state === 'query');
      el.authReveal.textContent = state.revealAuth ? 'Hide' : 'Reveal'; el.authReveal.setAttribute('aria-pressed', String(state.revealAuth));
      let text = '';
      if (p.state === 'header') text = `${p.name}: ${state.revealAuth ? p.value : C.maskDisplay(p.value)}`;
      else if (p.state === 'query') text = `?${p.name}=${state.revealAuth ? p.value : '••••••'}  (query parameter)`;
      else if (p.state === 'skipped') text = `Skipped: your "${p.name}" header in the Headers tab takes precedence.`;
      else if (p.state === 'incomplete') text = 'Incomplete: fill in the fields above.';
      if (p.missing.length) text += `   (unresolved: ${p.missing.map(n => `{{${n}}}`).join(', ')})`;
      el.authLine.textContent = text;
    }
    el.authType.addEventListener('change', () => { state.auth = L.normalizeAuth({ type: el.authType.value }); state.revealAuth = false; renderAuth(); });
    el.authReveal.addEventListener('click', () => { state.revealAuth = !state.revealAuth; updateAuthPreview(); });

    // ---------- body ----------
    const userContentType = () => L.activeRows(state.headers).find(r => r.key.trim().toLowerCase() === 'content-type');
    function updateBodyNote() {
      const m = el.method.value, can = L.methodAllowsBody(m), type = el.bodyType.value;
      el.body.disabled = !can; el.bodyType.disabled = !can;
      root.querySelectorAll('[data-action="prettify"],[data-action="validate"]').forEach(b => { b.disabled = !can || type !== 'json'; });
      if (!can) { el.bodyNote.textContent = `${m} requests have no body.`; return; }
      if (type === 'multipart') { el.bodyNote.textContent = 'Multipart: one key=value per line. The browser sets Content-Type with the boundary itself (a Content-Type header of yours is dropped). File uploads are not supported.'; return; }
      const ct = userContentType();
      const auto = { json: 'application/json', text: 'text/plain;charset=UTF-8', form: 'application/x-www-form-urlencoded', raw: null }[type];
      el.bodyNote.textContent = ct ? `Content-Type from your headers: ${ct.value}`
        : auto ? `Content-Type: ${auto} is added automatically (add a Content-Type header to override). {{variables}} are resolved before sending.` : 'Raw body: no Content-Type is added unless you set one.';
    }
    el.method.addEventListener('change', updateBodyNote);
    el.bodyType.addEventListener('change', () => { showMessage(el.bodyMsg, null); updateBodyNote(); });
    enableTabIndent(el.body, ctx.indentUnit);

    // ---------- draft <-> UI ----------
    const readSettings = () => ({ timeout: L.clampTimeout(el.timeout.value), redirect: el.redirect.value, credentials: el.credentials.value });
    function readDraft() {
      const keep = r => r.key || r.value;
      return {
        method: el.method.value, url: el.url.value.trim(), params: state.params.filter(keep).map(r => ({ ...r })), headers: state.headers.filter(keep).map(r => ({ ...r })),
        bodyType: el.bodyType.value, body: el.body.value, auth: L.normalizeAuth(state.auth), settings: readSettings(),
      };
    }
    function writeDraft(d) {
      const n = S.normalizeRequest(d);
      el.method.value = n.method; el.url.value = n.url; el.body.value = n.body; el.bodyType.value = n.bodyType;
      state.params = n.params.length ? n.params.map(r => ({ ...r })) : (L.paramsFromText(n.url).length ? L.paramsFromText(n.url) : [blank()]);
      state.headers = n.headers.length ? n.headers.map(r => ({ ...r })) : [blank()];
      state.auth = L.normalizeAuth(n.auth); state.revealAuth = false;
      el.timeout.value = n.settings.timeout || L.DEFAULT_TIMEOUT_SEC; el.redirect.value = n.settings.redirect || 'follow'; el.credentials.value = n.settings.credentials || 'same-origin';
      renderRows('params'); renderRows('headers'); renderAuth(); updateBodyNote();
      showMessage(el.error, null); showMessage(el.bodyMsg, null); el.warn.hidden = true;
    }
    const snapshotOf = () => JSON.stringify(S.normalizeRequest(readDraft()));
    const activeNode = () => (state.activeId ? S.findNode(col.tree, state.activeId) : null);
    const isDirty = () => !!(activeNode() && state.snapshot !== null && snapshotOf() !== state.snapshot);
    function setActive(id) { state.activeId = id; state.snapshot = id ? snapshotOf() : null; updateReqLabel(); updateDirty(true); }
    function updateReqLabel() {
      const n = activeNode();
      el.reqName.textContent = n ? n.node.name : 'Untitled request';
      el.reqPath.textContent = n ? S.pathOf(col.tree, n.node.id).slice(0, -1).join(' / ') : '';
    }
    function updateDirty(force) {
      const d = isDirty();
      el.dirty.hidden = !d;
      if (d !== state.lastDirty || force) { state.lastDirty = d; collections.render(); }
    }
    const refresh = ctx.debounce(() => { updateVarsNote(); updateAuthPreview(); updateDirty(); }, 150);
    $('.ac-main').addEventListener('input', () => refresh());
    $('.ac-main').addEventListener('change', () => refresh());
    root.addEventListener('ac-renamed', updateReqLabel);

    const discardOk = async () => !isDirty() || confirmDialog('Unsaved changes', 'The open request has unsaved changes. Discard them?', 'Discard');

    // ---------- collections ----------
    const collections = createCollections({
      root, col, persist: persistCollections, isDirty, activeId: () => state.activeId,
      async openRequest(node) {
        if (!(await discardOk())) return;
        writeDraft(node.request); view.clear(); setActive(node.id); closeSide(false); refresh();
      },
      saveCurrentAs(parentId, name) {
        const node = S.addRequest(col.tree, parentId, name, readDraft());
        if (!node) { toast('Could not save the request (size limit reached).', 'error'); return null; }
        persistCollections(); setActive(node.id); toast(`Saved to "${S.pathOf(col.tree, node.id).slice(0, -1).join(' / ')}"`, 'success'); return node;
      },
      onRemoved(ids) { if (state.activeId && ids.has(state.activeId)) { state.activeId = null; state.snapshot = null; updateReqLabel(); updateDirty(true); } },
    });

    function saveRequest() {
      if (col.readOnly) return toast('Collections are read-only because they were saved by a different version.', 'warn');
      if (!activeNode()) return saveAs();
      S.updateRequest(col.tree, state.activeId, readDraft());
      persistCollections(); state.snapshot = snapshotOf(); updateDirty(true); toast('Request saved', 'success', 1400);
    }
    function suggestName() {
      const d = readDraft();
      try { const u = new URL(d.url); return `${d.method} ${u.pathname === '/' ? u.host : u.pathname}`.slice(0, 80); } catch { return `${d.method} request`; }
    }
    function saveAs() {
      if (col.readOnly) return toast('Collections are read-only because they were saved by a different version.', 'warn');
      const conts = [];
      S.walk(col.tree, (n, _p, _i, depth) => { if (S.isContainer(n)) conts.push({ id: n.id, name: n.name, depth }); });
      const name = h('input', { class: 'input', type: 'text', 'aria-label': 'Request name', maxlength: '200', autocomplete: 'off' });
      name.value = activeNode()?.node.name || suggestName();
      const dest = h('select', { class: 'select', 'aria-label': 'Save into' }, ...conts.map(c => h('option', { value: c.id }, `${' '.repeat(c.depth)}${c.name}`)), h('option', { value: '__new__' }, '+ New collection…'));
      const newName = h('input', { class: 'input', type: 'text', 'aria-label': 'New collection name', maxlength: '200', placeholder: 'Collection name', autocomplete: 'off' });
      const newWrap = h('label', { class: 'ac-field' }, 'New collection name', newName);
      const pre = collections.selectedContainer(); dest.value = pre && conts.some(c => c.id === pre.id) ? pre.id : (conts[0]?.id || '__new__');
      const sync = () => { newWrap.hidden = dest.value !== '__new__'; }; dest.addEventListener('change', sync); sync();
      const err = h('div', { class: 'alert alert-error', hidden: true, role: 'alert' });
      dialog({
        title: 'Save request as', body: [h('label', { class: 'ac-field' }, 'Request name', name), h('label', { class: 'ac-field' }, 'Save into', dest), newWrap, err],
        actions: [{ label: 'Cancel' }, {
          label: 'Save', primary: true,
          onClick: () => {
            const fail = m => { err.hidden = false; err.textContent = m; return false; };
            if (!name.value.trim()) return fail('Enter a request name.');
            let parent = dest.value;
            if (parent === '__new__') {
              if (!newName.value.trim()) return fail('Enter a collection name.');
              const c = S.addContainer(col.tree, null, newName.value); if (!c) return fail('Could not create the collection (size limit reached).');
              parent = c.id;
            }
            const node = S.addRequest(col.tree, parent, name.value, readDraft());
            if (!node) return fail('Could not save the request (size limit reached).');
            persistCollections(); collections.select(node.id); setActive(node.id); toast('Request saved', 'success', 1400);
          },
        }],
      });
    }

    // ---------- import ----------
    async function importFile() {
      const area = h('textarea', { class: 'textarea code ac-import-area', spellcheck: 'false', 'aria-label': 'Import file contents', placeholder: 'Paste JSON here, or choose a file…' });
      const pick = h('button', { class: 'btn btn-sm', type: 'button' }, 'Choose file…');
      pick.addEventListener('click', async () => {
        const f = await pickFile('.json,application/json'); if (!f) return;
        try { area.value = await readFileAsText(f); } catch { err.hidden = false; err.textContent = 'The file could not be read.'; }
      });
      const err = h('div', { class: 'alert alert-error', hidden: true, role: 'alert' });
      dialog({
        title: 'Import collection or environment', wide: true,
        body: [h('p', { class: 'hint' }, 'Accepts a Developer Toolbox collection or environment export, a Postman Collection v2.1 file or a Postman environment file (the format is detected automatically). Postman scripts are not run and are skipped.'), pick, area, err],
        actions: [{ label: 'Cancel' }, {
          label: 'Import', primary: true,
          onClick: () => {
            const r = C.runImport(area.value);
            if (!r.ok) { err.hidden = false; err.textContent = r.error; return false; }
            if (r.collections.length && col.readOnly) { err.hidden = false; err.textContent = 'Collections are read-only because they were saved by a different version.'; return false; }
            const notes = [...r.warnings];
            for (const c of r.collections) collections.add(c);
            if (r.envs.length || r.globals.length) {
              const m = C.mergeEnvs(envState, r); Object.assign(envState, m.state);
              if (m.skippedGlobals) notes.push(`${m.skippedGlobals} global variable${m.skippedGlobals === 1 ? '' : 's'} already existed and were kept.`);
              persistEnvs(); renderEnvSelect(); refresh();
            }
            showMessage(el.error, notes.length ? 'warn' : 'success', [r.summary, ...notes].join('\n'));
          },
        }],
      });
    }
    async function importCurl() {
      if (!(await discardOk())) return;
      const area = h('textarea', { class: 'textarea code ac-import-area', spellcheck: 'false', 'aria-label': 'cURL command', placeholder: "curl -X POST 'https://api.example.com/items' -H 'Content-Type: application/json' -d '{\"a\":1}'" });
      const shell = h('select', { class: 'select', 'aria-label': 'Shell the command was written for' },
        h('option', { value: 'auto' }, 'Detect automatically'), h('option', { value: 'posix' }, 'bash / zsh'), h('option', { value: 'cmd' }, 'Windows cmd'), h('option', { value: 'powershell' }, 'PowerShell'));
      const err = h('div', { class: 'alert alert-error', hidden: true, role: 'alert' });
      dialog({
        title: 'Import cURL command', wide: true,
        body: [h('p', { class: 'hint' }, 'Paste a curl command (for example from browser DevTools "Copy as cURL"). It is parsed locally and never executed.'), h('label', { class: 'ac-field' }, 'Shell', shell), area, err],
        actions: [{ label: 'Cancel' }, {
          label: 'Import', primary: true,
          onClick: () => {
            const parsed = parseCurl(area.value, { shell: shell.value });
            if (!parsed.url) { err.hidden = false; err.textContent = parsed.warnings.join('\n') || 'No URL found in the command.'; return false; }
            const { draft, warnings } = C.draftFromCurl(parsed);
            writeDraft(draft); view.clear(); setActive(null); refresh(); closeSide(false);
            showMessage(el.error, warnings.length ? 'warn' : 'success', warnings.length ? `cURL imported with notes:\n• ${warnings.join('\n• ')}` : 'cURL command imported.');
          },
        }],
      });
    }

    // ---------- response ----------
    const view = createResponseView(root, { copy: copyText });
    const setBusy = busy => { el.send.hidden = busy; el.cancel.hidden = !busy; view.setLoading(busy); el.method.disabled = busy; };

    // ---------- send ----------
    async function send(anyway = false) {
      if (state.controller) return; // a request is already in flight (Enter key, double click)
      showMessage(el.error, null); el.warn.hidden = true;
      const draft = readDraft();
      const c = C.composeRequest(draft, { vars: currentVars() });
      if (c.missing.length && anyway !== true) {
        el.warnText.textContent = `Unresolved variable${c.missing.length === 1 ? '' : 's'}: ${c.missing.map(n => `{{${n}}}`).join(', ')}. ${c.missing.length === 1 ? 'It' : 'They'} will be sent as literal text.`;
        el.warn.hidden = false; $('#ac-send-anyway').focus(); return;
      }
      if (!c.ok) { showMessage(el.error, 'error', c.error); if (/URL|protocol/i.test(c.error)) el.url.focus(); return; }
      const timeoutSec = L.clampTimeout(el.timeout.value); el.timeout.value = timeoutSec;
      let body = c.body;
      if (c.formFields) { body = new FormData(); for (const [k, v] of c.formFields) body.append(k, v); }
      view.clear();
      const controller = new AbortController();
      state.controller = controller; state.cancelled = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSec * 1000);
      setBusy(true);
      const t0 = performance.now();
      try {
        const res = await fetch(c.url, { method: c.method, headers: c.headers, body, signal: controller.signal, redirect: c.settings.redirect || 'follow', credentials: c.settings.credentials || 'same-origin' });
        const ttfb = performance.now() - t0;
        const bytes = new Uint8Array(await res.arrayBuffer());
        view.show({ res, bytes, ttfb, total: performance.now() - t0, t0, url: c.url, method: c.method });
        pushHistory(draft, res.type === 'opaqueredirect' ? 0 : res.status);
      } catch (err) {
        const cancelled = state.cancelled && !timedOut;
        view.showText(cancelled ? 'Request cancelled.' : 'No response received.');
        showMessage(el.error, cancelled ? 'info' : timedOut ? 'warn' : 'error', L.describeFetchError(err, { timedOut, aborted: cancelled, url: c.url, timeoutSec }));
        if (!cancelled) pushHistory(draft, null);
      } finally {
        clearTimeout(timer);
        if (state.controller === controller) state.controller = null;
        setBusy(false);
      }
    }
    el.send.addEventListener('click', () => send());
    $('#ac-send-anyway').addEventListener('click', () => send(true));
    el.cancel.addEventListener('click', () => { state.cancelled = true; state.controller?.abort(); });
    el.url.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    // Ctrl/Cmd+Enter sends only while focus is inside this tool (listener lives on the tool root, not the document).
    root.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); send(); }
      else if (e.key === 'Escape' && el.app.classList.contains('side-open')) { e.stopPropagation(); closeSide(); }
    });
    $('#ac-example').addEventListener('click', () => {
      if (state.controller) return;
      el.method.value = 'GET'; el.url.value = EXAMPLE_URL; syncParamsFromUrl(); updateBodyNote(); showMessage(el.error, null); refresh(); send();
    });

    // ---------- history ----------
    function pushHistory(draft, status) {
      const entry = L.makeHistoryEntry({ ...draft, status }, { keepSensitive: el.saveSens.checked });
      state.history = L.addHistory(state.history, entry);
      persistHistory(); renderHistory();
    }
    function renderHistory() {
      const list = L.filterHistoryByStatus(L.searchHistory(state.history, el.histQ.value), el.histF.value);
      if (!list.length) { el.history.replaceChildren(h('div', { class: 'ac-hist-empty' }, state.history.length ? 'No history entries match the filter.' : 'No requests yet.')); return; }
      el.history.replaceChildren(...list.map(e => {
        const st = e.status == null ? null : Number(e.status);
        const badge = st == null ? h('span', { class: 'badge badge-danger' }, 'failed') : st === 0 ? h('span', { class: 'badge badge-info' }, 'redirect') : h('span', { class: `badge badge-${L.statusClass(st)}` }, String(st));
        const main = h('button', { type: 'button', class: 'ac-hist-main', 'data-hact': 'restore', 'aria-label': `Restore ${e.method} ${e.url}` }, h('b', {}, e.method), badge, h('span', { class: 'ac-hist-url' }, e.url));
        const mk = (act, label, aria, extra = {}) => h('button', { type: 'button', class: 'btn btn-ghost btn-sm ac-hist-btn', 'data-hact': act, 'aria-label': aria, ...extra }, label);
        return h('div', { class: `ac-hist-item${e.pinned ? ' pinned' : ''}`, role: 'listitem', 'data-id': e.id, title: e.url },
          main, mk('pin', e.pinned ? 'Unpin' : 'Pin', `${e.pinned ? 'Unpin' : 'Pin'} ${e.method} ${e.url}`, { 'aria-pressed': String(!!e.pinned) }),
          mk('rerun', 'Re-run', `Re-run ${e.method} ${e.url}`), mk('delete', '✕', `Delete entry ${e.method} ${e.url}`));
      }));
    }
    async function restoreHistory(e) {
      if (!(await discardOk())) return false;
      const r = C.draftFromHistory(e);
      writeDraft(r.draft); view.clear(); setActive(null); refresh(); closeSide(false);
      toast(r.notes.length ? `Request restored; ${r.notes.join('; ')}` : 'Request restored', r.notes.length ? 'warn' : 'info', r.notes.length ? 4000 : 1400);
      return true;
    }
    el.history.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-hact]'); if (!b) return;
      const id = b.closest('.ac-hist-item')?.dataset.id, e = state.history.find(x => x.id === id); if (!e) return;
      const act = b.dataset.hact;
      if (act === 'delete') { state.history = L.removeHistory(state.history, id); persistHistory(); renderHistory(); }
      else if (act === 'pin') { state.history = L.togglePin(state.history, id); persistHistory(); renderHistory(); }
      else if (act === 'restore') await restoreHistory(e);
      else if (act === 'rerun') { if (await restoreHistory(e)) send(); }
    });
    el.histQ.addEventListener('input', renderHistory);
    el.histF.addEventListener('change', renderHistory);

    // ---------- actions ----------
    const jsonOnBody = fn => { const r = fn(el.body.value); if (!r.ok) showMessage(el.bodyMsg, 'error', r.error); else return r; };
    bindActions(root, {
      'add-param': () => { state.params.push(blank()); renderRows('params'); },
      'add-header': () => { state.headers.push(blank()); renderRows('headers'); },
      prettify: () => {
        const r = jsonOnBody(t => L.prettifyJson(t, ctx.indentUnit === '\t' ? '\t' : ctx.indentUnit.length));
        if (r) { el.body.value = r.text; showMessage(el.bodyMsg, null); refresh(); }
      },
      validate: () => {
        const r = jsonOnBody(L.parseJson);
        if (r) showMessage(el.bodyMsg, 'success', r.value === undefined ? 'Body is empty.' : 'Valid JSON.');
      },
      'copy-as': () => {
        showMessage(el.error, null);
        const c = C.composeRequest(readDraft(), { vars: currentVars() });
        if (!c.ok) return showMessage(el.error, 'error', c.error);
        const r = C.snippetRequest(c), kind = el.copyas.value;
        const text = kind.startsWith('curl-') ? buildCurl(r, { shell: kind.slice(5) }) : kind === 'fetch' ? buildFetch(r) : buildPython(r);
        const creds = c.usedSecret || !!c.auth.header || Object.keys(c.headers).some(L.isSensitiveHeader);
        copyText(text, `${COPY_LABELS[kind] || 'Snippet'} copied${creds ? ' (contains resolved credentials)' : ''}${c.missing.length ? '; unresolved variables left as typed' : ''}`);
      },
      'copy-res': () => view.copyBody(),
      'download-res': () => view.download(),
      'save': saveRequest,
      'save-as': saveAs,
      'new-request': async () => {
        if (!(await discardOk())) return;
        writeDraft(S.blankRequest()); view.clear(); setActive(null); refresh(); el.url.focus();
      },
      'new-collection': () => collections.newCollection(),
      'import-file': importFile,
      'import-curl': importCurl,
      'manage-env': () => openEnvManager({ env: envState, persist: persistEnvs, onChange: () => { renderEnvSelect(); refresh(); } }),
      'export-history': () => {
        if (!state.history.length) return toast('History is empty', 'info');
        downloadFile('api-client-history.json', JSON.stringify(L.exportHistory(state.history), null, 2), 'application/json');
        toast('History exported with sensitive values removed', 'success');
      },
      'clear-history': async () => {
        const n = state.history.filter(x => !x.pinned).length;
        if (!n) return toast(state.history.length ? 'Only pinned entries remain (unpin to remove them)' : 'History is already empty', 'info');
        if (await confirmDialog('Clear history', `Delete ${n} unpinned request${n === 1 ? '' : 's'}? Pinned entries are kept.`, 'Clear')) {
          state.history = L.clearUnpinned(state.history); persistHistory(); renderHistory();
        }
      },
    });

    // ---------- init ----------
    renderEnvSelect(); renderRows('params'); renderRows('headers'); renderAuth(); renderHistory(); updateBodyNote(); view.clear();
    collections.render(); updateReqLabel(); updateVarsNote();
    const stop = () => { state.controller?.abort(); view.destroy(); };
    ctx.onCleanup?.(stop);
    return stop;
  },
};
