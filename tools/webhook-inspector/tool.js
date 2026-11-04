import {
  copyText, downloadFile, showMessage, escapeHtml, debounce, renderIcons, confirmDialog, toast,
} from '../../assets/js/components/ui.js';
import {
  METHODS, TEMPLATES, WebhookError, randomId, demoUrl, formatSize, getHeader, buildSimulatedRequest, formatBody, toCurl,
  addToHistory, sanitizeHistory, filterRequests, exportHistory, methodBadgeClass, resolveExternal, parseExternalResponse, mergeExternal,
  prepareForStorage, hasSensitiveHeaders, curlRedactionWarning, parseRetryAfter, nextPollDelay, privateHostWarning,
  POLL_BASE_MS, POLL_MAX_FAILURES, BODY_CAP,
} from './logic.js';

const POLL_MS = POLL_BASE_MS;

/** Crypto-backed random source for endpoint ids. */
const rng = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; };

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#wh-' + id);
    const store = ctx.storage;
    const cfg = { mode: 'demo', endpointId: '', extUrl: '', apiUrl: '', ...(store.get('cfg', {}) || {}) };
    if (!cfg.endpointId) cfg.endpointId = randomId(12, rng);
    let history = sanitizeHistory(store.get('history', []));
    let selectedId = null;
    let timer = null, inFlight = null, polling = false, failures = 0;
    const confirmedHosts = new Set(); // private hosts the user already approved this session
    const saveCfg = () => store.set('cfg', cfg);
    // Persist a redacted, size-capped copy; the in-memory list keeps full values for the current session.
    const saveHistory = () => store.set('history', history.map(prepareForStorage));

    // ---------------- static controls ----------------
    $('method').innerHTML = METHODS.map(m => `<option>${m}</option>`).join('');
    $('filter-method').insertAdjacentHTML('beforeend', METHODS.map(m => `<option>${m}</option>`).join(''));
    $('template').insertAdjacentHTML('beforeend', TEMPLATES.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join(''));
    $('method').value = 'POST';
    $('ext-url').value = cfg.extUrl; $('api-url').value = cfg.apiUrl;

    // ---------------- mode switch ----------------
    function setMode(mode) {
      cfg.mode = mode; saveCfg();
      root.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
      root.querySelectorAll('[data-mode-panel]').forEach(p => { p.hidden = p.dataset.modePanel !== mode; });
      if (mode === 'demo') stopPolling('Not polling');
      selectedId = null;
      renderList();
    }
    root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // ---------------- demo endpoint ----------------
    const endpoint = () => demoUrl(cfg.endpointId);
    const showEndpoint = () => { $('endpoint').value = endpoint(); };
    $('copy-endpoint').addEventListener('click', () => copyText(endpoint(), 'Simulated endpoint URL copied'));
    $('new-endpoint').addEventListener('click', () => { cfg.endpointId = randomId(12, rng); saveCfg(); showEndpoint(); toast('New simulated URL generated', 'success'); });

    // ---------------- simulate ----------------
    function applyTemplate(id) {
      const t = TEMPLATES.find(x => x.id === id);
      if (!t) return;
      $('method').value = t.method; $('path').value = t.path; $('headers').value = t.headers; $('body').value = t.body;
      showMessage($('sim-msg'), null);
    }
    $('template').addEventListener('change', e => applyTemplate(e.target.value));
    $('compose-clear').addEventListener('click', () => {
      $('method').value = 'POST'; $('path').value = '/'; $('headers').value = ''; $('body').value = ''; $('template').value = '';
      showMessage($('sim-msg'), null);
    });
    $('simulate').addEventListener('click', () => {
      try {
        const rec = buildSimulatedRequest({
          endpoint: endpoint(), method: $('method').value, pathQuery: $('path').value,
          headersText: $('headers').value, body: $('body').value,
        }, new Date(), randomId(10, rng));
        history = addToHistory(history, rec); saveHistory();
        selectedId = rec.id; showMessage($('sim-msg'), null);
        renderList(); toast('Simulated request recorded', 'success');
      } catch (err) {
        showMessage($('sim-msg'), 'error', err instanceof WebhookError ? err.message : `Could not simulate: ${err.message}`);
      }
    });

    // ---------------- external polling ----------------
    const setStatus = (text, cls = '') => { const b = $('poll-status'); b.textContent = text; b.className = `badge ${cls}`.trim(); };
    const setPollingUi = on => { polling = on; $('poll-start').disabled = on; $('poll-stop').disabled = !on; };

    function readExternalInputs() {
      cfg.extUrl = $('ext-url').value.trim(); cfg.apiUrl = $('api-url').value.trim(); saveCfg();
      return resolveExternal(cfg.extUrl, cfg.apiUrl); // throws WebhookError when invalid
    }

    /** Ask before talking to loopback/private/link-local hosts (custom API URLs only). Resolves true when OK to continue. */
    async function confirmHost(api) {
      if (!api.privateHost || confirmedHosts.has(api.host)) return true;
      const ok = await confirmDialog('Private network address', privateHostWarning(api.privateHost, api.host), 'Continue');
      if (ok) confirmedHosts.add(api.host);
      return ok;
    }

    /**
     * One fetch of the external API. Resolves { ok, aborted?, fatal?, retryAfterMs? }.
     * `fatal` failures (e.g. unknown token) are never retried.
     */
    async function pollOnce(apiUrl) {
      if (inFlight) return { ok: false, busy: true }; // never overlap requests
      const ctl = inFlight = new AbortController();
      let timedOut = false, fatal = false, retryAfterMs = null;
      const timeout = setTimeout(() => { timedOut = true; ctl.abort(); }, 15000);
      try {
        const res = await fetch(apiUrl, { headers: { Accept: 'application/json' }, signal: ctl.signal });
        if (!res.ok) {
          if (res.status === 404) fatal = true;
          if (res.status === 429) retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));
          const hint = res.status === 404 ? 'Token not found — check the URL/UUID (it may have expired).'
            : res.status === 429 ? `Rate limited by the service (HTTP 429)${retryAfterMs != null ? ` — it asked us to wait ${Math.ceil(retryAfterMs / 1000)}s` : ''}.`
              : `The service answered HTTP ${res.status}.`;
          throw new WebhookError(hint);
        }
        let json;
        try { json = await res.json(); } catch (e) { if (e?.name === 'AbortError') throw e; throw new WebhookError('The response was not valid JSON.'); }
        const { records, skipped } = parseExternalResponse(json);
        const { list, added } = mergeExternal(history, records);
        history = list; saveHistory();
        if (skipped) showMessage($('ext-msg'), 'warn', `${skipped} malformed request${skipped === 1 ? ' was' : 's were'} skipped.`);
        else showMessage($('ext-msg'), null);
        setStatus(`Last check ${new Date().toLocaleTimeString()}${added ? ` · ${added} new` : ''}${skipped ? ` · ${skipped} skipped` : ''}`, 'badge-success');
        renderList();
        return { ok: true };
      } catch (err) {
        let msg;
        if (err.name === 'AbortError') msg = timedOut ? 'The request timed out after 15 seconds.' : ''; // empty = user pressed Stop
        else if (err instanceof WebhookError) msg = err.message;
        else if (err instanceof TypeError) msg = 'Network or CORS error: the browser could not read the service response. Check your internet connection, the URL, and that the service allows cross-origin requests (webhook.site does). Ad blockers can also block it.';
        else msg = err.message;
        if (msg) { showMessage($('ext-msg'), 'error', msg); setStatus('Error', 'badge-danger'); }
        return { ok: false, aborted: !msg, fatal, retryAfterMs };
      } finally { clearTimeout(timeout); inFlight = null; }
    }

    function stopPolling(label = 'Stopped') {
      clearTimeout(timer); timer = null; failures = 0;
      inFlight?.abort();
      setPollingUi(false); setStatus(label);
    }
    /** Poll again after `delay`; failures back off exponentially (max 60s, honouring Retry-After) and stop after repeated errors. */
    function schedule(apiUrl, delay) {
      timer = setTimeout(async () => {
        if (!polling) return;
        const r = await pollOnce(apiUrl);
        if (!polling || r.aborted) return;
        if (r.ok) { failures = 0; schedule(apiUrl, POLL_MS); return; }
        if (r.busy) { schedule(apiUrl, POLL_MS); return; }
        failures++;
        if (r.fatal || failures >= POLL_MAX_FAILURES) {
          stopPolling(r.fatal ? 'Stopped (error)' : `Stopped after ${failures} failed attempts`);
          setStatus(r.fatal ? 'Stopped (error)' : `Stopped after ${failures} failed attempts`, 'badge-danger');
          return;
        }
        const wait = nextPollDelay(failures, r.retryAfterMs);
        setStatus(`Retrying in ${Math.round(wait / 1000)}s (failure ${failures}/${POLL_MAX_FAILURES})`, 'badge-warn');
        schedule(apiUrl, wait);
      }, delay);
    }
    $('poll-start').addEventListener('click', async () => {
      let api;
      try { api = readExternalInputs(); } catch (err) { showMessage($('ext-msg'), 'error', err.message); return; }
      if (!await confirmHost(api)) return;
      showMessage($('ext-msg'), null);
      failures = 0;
      setPollingUi(true); setStatus('Polling…', 'badge-info');
      const r = await pollOnce(api.apiUrl);
      if (!polling) return; // stopped while the first request was running
      if (!r.ok) { stopPolling('Stopped (error)'); setStatus('Stopped (error)', 'badge-danger'); return; }
      schedule(api.apiUrl, POLL_MS);
    });
    $('poll-stop').addEventListener('click', () => stopPolling());
    $('poll-once').addEventListener('click', async () => {
      try {
        const api = readExternalInputs();
        if (!await confirmHost(api)) return;
        showMessage($('ext-msg'), null); await pollOnce(api.apiUrl);
      } catch (err) { showMessage($('ext-msg'), 'error', err.message); }
    });

    // ---------------- list ----------------
    const visible = () => filterRequests(history, { source: cfg.mode === 'demo' ? 'simulated' : 'external', method: $('filter-method').value, text: $('search').value });
    const timeLabel = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(); };

    function renderList() {
      const items = visible();
      $('count').textContent = items.length;
      if (selectedId && !items.some(r => r.id === selectedId)) selectedId = null;
      if (!selectedId && items.length) selectedId = items[0].id;
      $('list').innerHTML = items.length ? items.map(r => `
        <button type="button" class="wh-item${r.id === selectedId ? ' active' : ''}" role="option" aria-selected="${r.id === selectedId}" data-id="${escapeHtml(r.id)}">
          <div class="wh-item-top">
            <span class="badge wh-method ${methodBadgeClass(r.method)}">${escapeHtml(r.method)}</span>
            <span class="wh-item-path" title="${escapeHtml(r.url)}">${escapeHtml(r.path || r.url)}</span>
          </div>
          <div class="wh-item-meta">
            <span class="badge ${r.source === 'simulated' ? 'badge-warn' : 'badge-info'}">${r.source === 'simulated' ? 'SIMULATED' : 'EXTERNAL'}</span>
            <span>${escapeHtml(timeLabel(r.time))}</span><span>${escapeHtml(formatSize(r.size || 0))}</span>
          </div>
        </button>`).join('')
        : `<div class="wh-empty">${history.length ? 'No requests match the current filter.'
          : cfg.mode === 'demo' ? 'No requests yet. Pick a sample template and press “Simulate request”.' : 'No requests yet. Start polling or fetch once after your webhook has been called.'}</div>`;
      renderDetail();
    }

    // ---------------- detail ----------------
    const kvTable = (pairs, empty) => pairs.length
      ? `<div class="table-wrap"><table class="table"><tbody>${pairs.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="hint">${empty}</p>`;

    function renderDetail() {
      const box = $('detail');
      const r = history.find(x => x.id === selectedId);
      if (!r) { box.innerHTML = '<div class="wh-empty">Select a request to inspect it.</div>'; return; }
      const body = formatBody(r.body, getHeader(r.headers, 'content-type') || '');
      const bodyLabel = { json: 'Body (JSON, pretty-printed)', form: 'Body (form-decoded)', text: 'Body (raw)', empty: 'Body' }[body.kind];
      const notes = [];
      if (r.truncated) notes.push(`Body truncated to ${formatSize(BODY_CAP)} (original size ${formatSize(r.size || 0)}).`);
      if (r.redacted) notes.push('Credential header values were redacted before this request was saved in your browser, so "Copy as cURL" will contain "[redacted]" placeholders.');
      else if (hasSensitiveHeaders(r.headers)) notes.push('Credential headers (Authorization, Cookie, API keys) are shown here but are saved as [redacted].');
      box.innerHTML = `
        <div class="wh-detail-head">
          <span class="badge wh-method ${methodBadgeClass(r.method)}">${escapeHtml(r.method)}</span>
          <span class="badge ${r.source === 'simulated' ? 'badge-warn' : 'badge-info'}">${r.source === 'simulated' ? 'SIMULATED' : 'EXTERNAL'}</span>
          <span class="wh-meta">${escapeHtml(timeLabel(r.time))} · ${escapeHtml(formatSize(r.size || 0))}${r.ip ? ` · from ${escapeHtml(r.ip)}` : ''}</span>
          <span class="spacer"></span>
          <button class="btn btn-sm" data-act="curl" type="button"><i data-lucide="terminal"></i> Copy as cURL</button>
          <button class="btn btn-sm" data-act="body" type="button"><i data-lucide="copy"></i> Copy body</button>
          <button class="btn btn-sm btn-danger" data-act="delete" type="button"><i data-lucide="trash-2"></i> Delete</button>
          <div class="wh-detail-url">${escapeHtml(r.url)}</div>
        </div>
        ${notes.map(n => `<div class="alert alert-info">${escapeHtml(n)}</div>`).join('')}
        <div><h4>Headers (${Object.keys(r.headers).length})</h4>${kvTable(Object.entries(r.headers), 'No headers.')}</div>
        <div><h4>Query parameters (${r.query.length})</h4>${kvTable(r.query, 'No query parameters.')}</div>
        <div><h4>${bodyLabel}</h4>
          ${body.kind === 'empty' ? '<p class="hint">Empty body.</p>'
            : body.kind === 'form' ? kvTable(body.pairs, '') : `<pre class="code-block">${escapeHtml(body.text)}</pre>`}
        </div>`;
      renderIcons(box);
    }

    // ---------------- list / detail events ----------------
    $('list').addEventListener('click', e => {
      const item = e.target.closest('.wh-item');
      if (!item) return;
      selectedId = item.dataset.id; renderList();
    });
    $('detail').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      const r = history.find(x => x.id === selectedId);
      if (!btn || !r) return;
      if (btn.dataset.act === 'curl') {
        copyText(toCurl(r), 'cURL command copied');
        const w = curlRedactionWarning(r);
        if (w) toast(w, 'warn', 6000);
      }
      else if (btn.dataset.act === 'body') { if (!r.body) toast('This request has no body', 'warn'); else copyText(r.body, 'Body copied'); }
      else if (btn.dataset.act === 'delete') {
        history = history.filter(x => x.id !== r.id); saveHistory(); selectedId = null; renderList(); toast('Request deleted');
      }
    });
    $('filter-method').addEventListener('change', renderList);
    $('search').addEventListener('input', debounce(renderList, 150));
    $('export').addEventListener('click', () => {
      const list = visible();
      if (!list.length) { toast('No requests to export', 'warn'); return; }
      const secrets = $('export-secrets').checked;
      downloadFile(`webhook-requests-${new Date().toISOString().slice(0, 10)}.json`, exportHistory(list, new Date(), { includeSecrets: secrets }), 'application/json;charset=utf-8');
      if (!secrets && list.some(r => hasSensitiveHeaders(r.headers))) toast('Credential headers were redacted in the export', 'info');
    });
    $('clear-all').addEventListener('click', async () => {
      const source = cfg.mode === 'demo' ? 'simulated' : 'external';
      if (!history.some(r => r.source === source)) { toast('Nothing to clear', 'warn'); return; }
      if (!await confirmDialog('Clear all requests', `Delete all ${source} requests from history? This cannot be undone.`, 'Clear all')) return;
      history = history.filter(r => r.source !== source); saveHistory(); selectedId = null; renderList();
    });

    showEndpoint();
    saveCfg();
    setMode(cfg.mode === 'external' ? 'external' : 'demo');
    renderIcons(root);

    // Cleanup: stop the timer, abort any in-flight request.
    return () => { clearTimeout(timer); timer = null; inFlight?.abort(); };
  },
};
