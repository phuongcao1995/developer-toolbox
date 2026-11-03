import { copyText, downloadFile, toast, showMessage, bindActions, escapeHtml, renderIcons, formatBytes, confirmDialog } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

const EXAMPLE_URL = 'https://jsonplaceholder.typicode.com/todos/1';
const TIMEOUT_MS = 30000;

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const state = {
      params: [{ key: '', value: '', enabled: true }],
      headers: [{ key: '', value: '', enabled: true }],
      history: ctx.storage.get('history', []),
      resText: '', resHeaders: [], resContentType: '', controller: null,
    };
    const el = {
      method: $('#ac-method'), url: $('#ac-url'), send: $('#ac-send'), cancel: $('#ac-cancel'), error: $('#ac-error'),
      body: $('#ac-body'), bodyMsg: $('#ac-body-msg'), bodyNote: $('#ac-body-note'),
      status: $('#ac-status'), meta: $('#ac-meta'), output: $('#ac-output'), loading: $('#ac-loading'),
      rheaders: $('#ac-rheaders'), rcount: $('#ac-rheaders-count'), history: $('#ac-history'),
    };

    // ---------- tabs (request + response use separate attribute names) ----------
    const wireTabs = (tabAttr, panelAttr, onSel) => {
      const tabs = [...root.querySelectorAll(`[${tabAttr}]`)], panels = [...root.querySelectorAll(`[${panelAttr}]`)];
      const select = name => {
        tabs.forEach(t => t.classList.toggle('active', t.getAttribute(tabAttr) === name));
        panels.forEach(p => { p.hidden = p.getAttribute(panelAttr) !== name; });
        onSel?.(name);
      };
      tabs.forEach(t => t.addEventListener('click', () => select(t.getAttribute(tabAttr))));
      return select;
    };
    wireTabs('data-tab', 'data-panel');
    wireTabs('data-rtab', 'data-rpanel');

    // ---------- key/value editors ----------
    const lists = { params: $('#ac-params-rows'), headers: $('#ac-headers-rows') };
    function renderRows(kind) {
      const host = lists[kind];
      host.innerHTML = state[kind].map((r, i) => `
        <div class="ac-row ${r.enabled ? '' : 'off'}" data-i="${i}">
          <input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''} aria-label="Enable row">
          <input class="input mono" data-f="key" value="${escapeHtml(r.key)}" placeholder="${kind === 'params' ? 'name' : 'Header-Name'}" spellcheck="false" aria-label="Key">
          <input class="input mono ac-val" data-f="value" value="${escapeHtml(r.value)}" placeholder="value" spellcheck="false" aria-label="Value">
          <button class="btn btn-ghost btn-icon btn-sm" data-del="${i}" aria-label="Remove row"><i data-lucide="x"></i></button>
        </div>`).join('');
      renderIcons(host);
      updateCounts();
    }
    function updateCounts() {
      $('#ac-params-count').textContent = L.activeRows(state.params).length;
      $('#ac-headers-count').textContent = L.activeRows(state.headers).length;
    }
    for (const kind of ['params', 'headers']) {
      const host = lists[kind];
      host.addEventListener('input', e => {
        const row = e.target.closest('.ac-row'); if (!row) return;
        const r = state[kind][+row.dataset.i], f = e.target.dataset.f;
        r[f] = f === 'enabled' ? e.target.checked : e.target.value;
        if (f === 'enabled') row.classList.toggle('off', !r.enabled);
        updateCounts();
      });
      host.addEventListener('click', e => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        state[kind].splice(+b.dataset.del, 1);
        if (!state[kind].length) state[kind].push({ key: '', value: '', enabled: true });
        renderRows(kind);
      });
    }

    // ---------- body ----------
    function syncBodyState() {
      const get = el.method.value === 'GET';
      el.body.disabled = get;
      el.bodyNote.textContent = get ? 'GET requests have no body.' : 'Content-Type: application/json is added automatically if not set.';
    }
    el.method.addEventListener('change', syncBodyState);
    el.body.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = el.body;
      el.body.setRangeText(ctx.indentUnit, s, en, 'end');
    });

    // ---------- response rendering ----------
    function clearResponse() {
      el.status.hidden = true; el.meta.textContent = ''; el.rheaders.innerHTML = ''; el.rcount.textContent = '0';
      state.resText = ''; state.resHeaders = [];
    }
    function setBusy(busy) {
      el.send.hidden = busy; el.cancel.hidden = !busy; el.loading.hidden = !busy;
      el.method.disabled = busy;
    }
    function showResponse({ res, text, ms }) {
      const fmt = L.formatResponseBody(text, res.headers.get('content-type') || '');
      state.resText = fmt.text; state.resContentType = res.headers.get('content-type') || '';
      state.resHeaders = [...res.headers.entries()];
      el.status.hidden = false;
      el.status.className = `badge badge-${L.statusClass(res.status)}`;
      el.status.textContent = `${res.status} ${res.statusText || ''}`.trim();
      el.meta.textContent = `${ms.toFixed(0)} ms · ${formatBytes(L.byteLength(text))}${fmt.isJson ? ' · JSON' : ''}`;
      el.output.textContent = text === '' ? '(empty response body)' : fmt.text;
      el.rcount.textContent = state.resHeaders.length;
      el.rheaders.innerHTML = state.resHeaders.length
        ? state.resHeaders.map(([k, v]) => `<tr><td class="ac-hdr-name">${escapeHtml(k)}</td><td class="ac-hdr-val">${escapeHtml(v)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="hint">No readable headers (the server may not expose them via CORS).</td></tr>';
    }

    // ---------- send ----------
    async function send() {
      showMessage(el.error, null);
      const method = el.method.value;
      const built = L.buildUrl(el.url.value, state.params);
      if (!built.ok) { showMessage(el.error, 'error', built.error); el.url.focus(); return; }
      const req = L.buildRequest({ method, headers: state.headers, body: el.body.value });
      if (!req.ok) { showMessage(el.error, 'error', req.error); return; }

      clearResponse();
      el.output.textContent = '';
      const controller = new AbortController();
      state.controller = controller;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
      setBusy(true);
      const t0 = performance.now();
      try {
        const res = await fetch(built.url, { method, headers: req.headers, body: req.body, signal: controller.signal });
        const text = await res.text();
        showResponse({ res, text, ms: performance.now() - t0 });
        pushHistory(res.status);
      } catch (err) {
        const aborted = controller.signal.aborted && !timedOut;
        el.output.textContent = 'No response received.';
        showMessage(el.error, aborted ? 'warn' : 'error', L.describeFetchError(err, { timedOut, aborted: aborted || err?.name === 'AbortError', url: built.url }));
        if (!aborted) pushHistory(null);
      } finally {
        clearTimeout(timer); state.controller = null; setBusy(false);
      }
    }

    // ---------- history ----------
    function pushHistory(status) {
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        method: el.method.value, url: el.url.value.trim(), body: el.body.value,
        params: state.params.filter(r => r.key || r.value), headers: state.headers.filter(r => r.key || r.value),
        status, at: Date.now(),
      };
      state.history = L.addHistory(state.history, entry);
      ctx.storage.set('history', state.history);
      renderHistory();
    }
    function renderHistory() {
      el.history.innerHTML = state.history.length ? state.history.map(h => `
        <div class="ac-hist-item" data-id="${escapeHtml(h.id)}" title="${escapeHtml(h.url)}">
          <div class="ac-hist-main"><b>${escapeHtml(h.method)}</b>${h.status ? `<span class="badge badge-${L.statusClass(h.status)}">${h.status}</span>` : '<span class="badge badge-danger">failed</span>'}
            <span class="ac-hist-url">${escapeHtml(h.url)}</span></div>
          <button class="btn btn-ghost btn-icon btn-sm" data-hdel="${escapeHtml(h.id)}" aria-label="Delete entry"><i data-lucide="x"></i></button>
        </div>`).join('') : '<div class="ac-hist-empty">No requests yet.</div>';
      renderIcons(el.history);
    }
    el.history.addEventListener('click', e => {
      const del = e.target.closest('[data-hdel]');
      if (del) {
        state.history = L.removeHistory(state.history, del.dataset.hdel);
        ctx.storage.set('history', state.history); renderHistory(); return;
      }
      const item = e.target.closest('.ac-hist-item');
      const h = item && state.history.find(x => x.id === item.dataset.id);
      if (!h) return;
      el.method.value = h.method; el.url.value = h.url; el.body.value = h.body || '';
      state.params = h.params?.length ? structuredClone(h.params) : [{ key: '', value: '', enabled: true }];
      state.headers = h.headers?.length ? structuredClone(h.headers) : [{ key: '', value: '', enabled: true }];
      renderRows('params'); renderRows('headers'); syncBodyState(); showMessage(el.error, null);
      toast('Request restored', 'info', 1400);
    });

    // ---------- actions ----------
    const jsonOnBody = fn => {
      const r = fn(el.body.value);
      if (!r.ok) showMessage(el.bodyMsg, 'error', r.error); else return r;
    };
    bindActions(root, {
      'add-param': () => { state.params.push({ key: '', value: '', enabled: true }); renderRows('params'); },
      'add-header': () => { state.headers.push({ key: '', value: '', enabled: true }); renderRows('headers'); },
      prettify: () => {
        const r = jsonOnBody(t => L.prettifyJson(t, ctx.indentUnit === '\t' ? '\t' : ctx.indentUnit.length));
        if (r) { el.body.value = r.text; showMessage(el.bodyMsg, null); }
      },
      validate: () => {
        const r = jsonOnBody(L.parseJson);
        if (r) showMessage(el.bodyMsg, 'success', r.value === undefined ? 'Body is empty.' : 'Valid JSON.');
      },
      'copy-res': () => copyText(state.resText, 'Response copied'),
      'download-res': () => {
        const ext = /json/i.test(state.resContentType) ? 'json' : /html/i.test(state.resContentType) ? 'html' : 'txt';
        downloadFile(`response.${ext}`, state.resText, 'text/plain;charset=utf-8');
      },
      'clear-history': async () => {
        if (!state.history.length) return toast('History is already empty', 'info');
        if (await confirmDialog('Clear history', 'Delete all saved requests?', 'Clear')) {
          state.history = []; ctx.storage.set('history', []); renderHistory();
        }
      },
    });
    el.send.addEventListener('click', send);
    el.cancel.addEventListener('click', () => state.controller?.abort());
    el.url.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    $('#ac-example').addEventListener('click', () => {
      el.method.value = 'GET'; el.url.value = EXAMPLE_URL; syncBodyState(); showMessage(el.error, null); send();
    });

    renderRows('params'); renderRows('headers'); renderHistory(); syncBodyState();
    return () => state.controller?.abort();
  },
};
