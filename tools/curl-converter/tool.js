// cURL Converter UI. Parsing/building lives in logic.js and assets/js/shared/curl.js. No network calls are made.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, initTabs, renderIcons } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import * as L from './logic.js';

const SAMPLE = `curl 'https://api.example.com/v1/orders?status=open&api_key=sk_live_123456' \\
  -X POST \\
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' \\
  -H 'Content-Type: application/json' \\
  -H 'Cookie: session=abc123; theme=dark' \\
  --data-raw '{"customer":"Zoë","items":[{"sku":"A-1","qty":2}],"note":"it'\\''s fine"}' \\
  --compressed`;
const BODY_PREVIEW_LIMIT = 20000;
const EDITOR_LANG = { javascript: 'javascript', python: 'python', shell: 'shell', plain: 'plain' };

const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const badge = (text, cls = 'badge') => h('span', cls, text);

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      shell: $('#cc-shell'), reveal: $('#cc-reveal'), input: $('#cc-input'), msg: $('#cc-msg'), warnings: $('#cc-warnings'), parsed: $('#cc-parsed'),
      target: $('#cc-target'), output: $('#cc-output'), crlf: $('#cc-crlf'), crlfWrap: $('#cc-crlf-wrap'), copyNote: $('#cc-copy-note'),
      method: $('#cb-method'), url: $('#cb-url'), params: $('#cb-params'), headers: $('#cb-headers'), bodyType: $('#cb-bodytype'), body: $('#cb-body'), bodyWrap: $('#cb-body-wrap'),
      fieldsWrap: $('#cb-fields-wrap'), fields: $('#cb-fields'), auth: $('#cb-auth'), user: $('#cb-user'), pass: $('#cb-pass'), token: $('#cb-token'), keyIn: $('#cb-key-in'),
      keyName: $('#cb-key-name'), keyValue: $('#cb-key-value'), follow: $('#cb-follow'), insecure: $('#cb-insecure'), compressed: $('#cb-compressed'),
      bshell: $('#cb-shell'), pretty: $('#cb-pretty'), breveal: $('#cb-reveal'), bout: $('#cb-output'), bmsg: $('#cb-msg'), bwarn: $('#cb-warnings'), bnote: $('#cb-copy-note'),
    };

    // ---------- setup ----------
    for (const t of L.TARGETS) els.target.append(Object.assign(document.createElement('option'), { value: t.id, textContent: t.label }));
    for (const m of L.METHODS) els.method.append(Object.assign(document.createElement('option'), { value: m, textContent: m }));
    els.shell.value = ctx.storage.get('shell', 'auto') || 'auto';
    els.target.value = ctx.storage.get('target', 'fetch'); if (!els.target.value) els.target.value = 'fetch';
    const saved = ctx.storage.get('build', null) || {};
    els.method.value = saved.method || 'GET'; els.bodyType.value = saved.bodyType || 'none'; els.bshell.value = saved.shell || 'posix';
    els.pretty.checked = saved.pretty !== false; els.follow.checked = !!saved.follow; els.insecure.checked = !!saved.insecure; els.compressed.checked = !!saved.compressed;
    if (!els.method.value) els.method.value = 'GET'; if (!els.bodyType.value) els.bodyType.value = 'none'; if (!els.bshell.value) els.bshell.value = 'posix';

    const edIn = createEditor(els.input, { language: 'shell', storage: ctx.storage, storageKey: 'curl-input', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const edOut = createEditor(els.output, { language: 'plain', storage: ctx.storage, storageKey: 'curl-code', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, readOnly: true, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const edBody = createEditor(els.body, { language: 'json', storage: ctx.storage, storageKey: 'build-body', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false, toolbar: ['wrap', 'find'] });
    const edBout = createEditor(els.bout, { language: 'shell', storage: ctx.storage, storageKey: 'build-out', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, readOnly: true, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const selectTab = initTabs(root);

    let reveal = false, req = null, bReq = null;

    // ---------- key / value rows ----------
    function addRow(container, label, key = '', value = '', ph = {}) {
      const row = h('div', 'cc-kvrow');
      const k = h('input', 'input'); k.type = 'text'; k.value = key; k.placeholder = ph.key || 'Name'; k.setAttribute('aria-label', `${label} name`); k.autocomplete = 'off'; k.spellcheck = false;
      const v = h('input', 'input'); v.type = 'text'; v.value = value; v.placeholder = ph.value || 'Value'; v.setAttribute('aria-label', `${label} value`); v.autocomplete = 'off'; v.spellcheck = false;
      const rm = h('button', 'btn btn-sm btn-icon', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove ${label.toLowerCase()}`); rm.dataset.remove = '1';
      row.append(k, v, rm); container.append(row);
      return k;
    }
    const readRows = container => [...container.querySelectorAll('.cc-kvrow')].map(r => { const i = r.querySelectorAll('input'); return { key: i[0].value, value: i[1].value }; });
    addRow(els.params, 'Parameter'); addRow(els.headers, 'Header', '', '', { key: 'Accept', value: 'application/json' }); addRow(els.fields, 'Field');

    // ---------- parsed view ----------
    function section(title) { const s = h('section', 'cc-sec'); s.append(h('h4', '', title)); return s; }
    function kvTable(rows, cols, extra) {
      const wrap = h('div', 'cc-tablewrap'); const t = h('table', 'cc-kvtable');
      const thead = h('thead'); const tr = h('tr'); cols.forEach(c => { const th = h('th', '', c); th.scope = 'col'; tr.append(th); }); thead.append(tr); t.append(thead);
      const tb = h('tbody');
      for (const r of rows) {
        const row = h('tr'); row.append(h('td', '', r.key), h('td', '', r.value));
        if (extra) { const td = h('td'); for (const b of extra(r)) td.append(b, document.createTextNode(' ')); row.append(td); }
        tb.append(row);
      }
      t.append(tb); wrap.append(t); return wrap;
    }
    function renderParsed(a) {
      const out = document.createDocumentFragment();
      const rl = section('Request'); const line = h('div', 'cc-reqline'); line.append(h('span', 'cc-method-badge', a.method), h('span', 'cc-url', a.url || '(no URL)')); rl.append(line); out.append(rl);
      if (a.urlParts) {
        const s = section('URL parts'); const dl = h('dl', 'cc-dl');
        const rows = [['Scheme', a.urlParts.scheme], ['Host', a.urlParts.host], ['Port', a.urlParts.port], ['Path', a.urlParts.path]];
        if (a.urlParts.userinfo) rows.push(['User info', a.urlParts.userinfo]);
        if (a.urlParts.hash) rows.push(['Fragment', a.urlParts.hash]);
        for (const [k, v] of rows) dl.append(h('dt', '', k), h('dd', '', v));
        s.append(dl); out.append(s);
      }
      if (a.query.length) { const s = section(`Query parameters (${a.query.length})`); s.append(kvTable(a.query, ['Name', 'Value', ''], r => (r.sensitive ? [badge('secret', 'badge badge-warn')] : []))); out.append(s); }
      const hs = section(`Headers (${a.headers.length})`);
      if (a.headers.length) hs.append(kvTable(a.headers, ['Name', 'Value', ''], r => [...(r.sensitive ? [badge('secret', 'badge badge-warn')] : []), ...(r.forbidden ? [Object.assign(badge('browser-controlled'), { title: 'Browsers refuse to set this header from fetch()/XHR' })] : [])]));
      else hs.append(h('p', 'cc-empty', 'No headers'));
      out.append(hs);
      if (a.auth) { const s = section('Authentication'); const dl = h('dl', 'cc-dl'); dl.append(h('dt', '', a.auth.type), h('dd', '', a.auth.detail)); s.append(dl); out.append(s); }
      if (a.body) {
        const s = section(`Body (${a.body.kind}${a.body.bytes != null ? `, ${a.body.bytes.toLocaleString()} bytes` : ''})`);
        if (a.body.kind === 'json') s.append(h('pre', 'cc-pre', a.body.pretty.length > BODY_PREVIEW_LIMIT ? a.body.pretty.slice(0, BODY_PREVIEW_LIMIT) + '\n… truncated in this view' : a.body.pretty));
        else if (a.body.kind === 'form' || a.body.kind === 'multipart') s.append(kvTable(a.body.fields, ['Field', 'Value']));
        else s.append(h('pre', 'cc-pre', a.body.raw.length > BODY_PREVIEW_LIMIT ? a.body.raw.slice(0, BODY_PREVIEW_LIMIT) + '\n… truncated in this view' : a.body.raw));
        out.append(s);
      }
      if (a.flags.length) { const s = section('Flags'); const c = h('div', 'cc-chips'); a.flags.forEach(f => c.append(badge(f, 'badge badge-info'))); s.append(c); out.append(s); }
      els.parsed.replaceChildren(out);
    }

    function setWarnings(ul, list) { ul.replaceChildren(...list.map(w => h('li', '', w))); }
    const targetDef = () => L.TARGETS.find(t => t.id === els.target.value) || L.TARGETS[0];

    function runParse() {
      const text = els.input.value;
      showMessage(els.msg, null);
      if (!text.trim()) { req = null; els.parsed.replaceChildren(h('p', 'cc-empty', 'Paste a cURL command above to see it parsed.')); els.output.value = ''; els.warnings.replaceChildren(); els.copyNote.textContent = ''; return; }
      let r;
      try { r = L.parseCurl(text, { shell: els.shell.value }); } catch (e) { req = null; showMessage(els.msg, 'error', `Could not parse this command: ${e.message}`); return; }
      req = r;
      if (!r.url) showMessage(els.msg, 'error', 'No URL was found in this command. Make sure it starts with curl and contains a URL.');
      setWarnings(els.warnings, r.warnings);
      renderParsed(L.analyze(r, { reveal }));
      renderCode();
    }
    function codeFor(request, real, eolCrlf) {
      const t = targetDef();
      const src = real || reveal ? request : L.maskRequest(request);
      return t.id === 'http' ? L.buildRawHttp(src, { eol: eolCrlf ? '\r\n' : '\n' }) : t.build(src);
    }
    function renderCode() {
      const t = targetDef();
      edOut.setLanguage(EDITOR_LANG[t.lang] || 'plain');
      els.crlfWrap.hidden = t.id !== 'http';
      if (!req || !req.url) { els.output.value = ''; els.copyNote.textContent = ''; return; }
      try { els.output.value = codeFor(req, false, false); } catch (e) { els.output.value = ''; showMessage(els.msg, 'error', `Could not generate ${t.label}: ${e.message}`); }
      els.copyNote.textContent = L.hasSecrets(req) && !reveal ? 'Secrets are masked in this view. Copy and Download use the real values.' : '';
    }
    const runParseSoon = ctx.debounce(runParse, 250);

    function copyReal(request, shownEl, noteMaker, getReal) {
      if (!request) { toast('Nothing to copy', 'warn'); return; }
      const text = getReal();
      copyText(text, L.hasSecrets(request) && !reveal ? 'Copied with the real secret values (the display is masked)' : 'Copied to clipboard');
      void shownEl; void noteMaker;
    }

    // ---------- build tab ----------
    function collectForm() {
      const t = els.auth.value;
      return {
        method: els.method.value, url: els.url.value, params: readRows(els.params), headers: readRows(els.headers), bodyType: els.bodyType.value, body: els.body.value, fields: readRows(els.fields),
        auth: { type: t, username: els.user.value, password: els.pass.value, token: els.token.value, in: els.keyIn.value, name: els.keyName.value, value: els.keyValue.value },
        options: { followRedirects: els.follow.checked || undefined, insecure: els.insecure.checked || undefined, compressed: els.compressed.checked || undefined },
      };
    }
    function syncBuildUi() {
      const bt = els.bodyType.value;
      els.bodyWrap.hidden = !['json', 'text', 'raw'].includes(bt); els.fieldsWrap.hidden = !['form', 'multipart'].includes(bt);
      edBody.setLanguage(bt === 'json' ? 'json' : 'plain');
      for (const k of ['basic', 'bearer', 'apikey']) $(`#cb-auth-${k}`).hidden = els.auth.value !== k;
    }
    const buildShellCmd = (request, real) => L.buildCurlFull(real || breveal() ? request : L.maskRequest(request), { shell: els.bshell.value, pretty: els.pretty.checked });
    const breveal = () => els.breveal.checked;
    function runBuild() {
      syncBuildUi();
      showMessage(els.bmsg, null);
      const r = L.requestFromForm(collectForm());
      bReq = null;
      setWarnings(els.bwarn, r.warnings);
      if (r.errors.length) {
        els.bout.value = '';
        els.bnote.textContent = '';
        if (els.url.value.trim() || r.errors.some(e => !/Enter a URL/.test(e))) showMessage(els.bmsg, 'error', r.errors.join(' '));
        return;
      }
      bReq = r.request;
      els.bout.value = buildShellCmd(bReq, false);
      els.bnote.textContent = L.hasSecrets(bReq) && !breveal() ? 'Secrets are masked in this view. Copy, Download and "Open in converter" use the real values.' : '';
      ctx.storage.set('build', { method: els.method.value, bodyType: els.bodyType.value, shell: els.bshell.value, pretty: els.pretty.checked, follow: els.follow.checked, insecure: els.insecure.checked, compressed: els.compressed.checked });
    }
    const runBuildSoon = ctx.debounce(runBuild, 150);

    function setReveal(v) { reveal = v; els.reveal.checked = v; els.breveal.checked = v; if (req) { renderParsed(L.analyze(req, { reveal })); renderCode(); } runBuild(); }

    async function loadFile(file) {
      if (!file) return;
      try { els.input.value = await readFileAsText(file); runParse(); } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const buildPanel = $('[data-panel="build"]');
    const onRemove = e => {
      const b = e.target.closest('button[data-remove]'); if (!b) return;
      const container = b.closest('.cc-kv'), row = b.closest('.cc-kvrow');
      const neighbour = row.nextElementSibling || row.previousElementSibling;
      row.remove(); (neighbour?.querySelector('input'))?.focus();
      runBuild();
    };
    const disposers = [
      on(els.input, 'input', runParseSoon),
      on(els.shell, 'change', () => { ctx.storage.set('shell', els.shell.value); runParse(); }),
      on(els.target, 'change', () => { ctx.storage.set('target', els.target.value); renderCode(); }),
      on(els.reveal, 'change', () => setReveal(els.reveal.checked)),
      on(els.breveal, 'change', () => setReveal(els.breveal.checked)),
      on($('#cc-sample'), 'click', () => { els.input.value = SAMPLE; els.shell.value = 'auto'; runParse(); }),
      on($('#cc-clear'), 'click', () => { els.input.value = ''; runParse(); els.input.focus(); }),
      on($('#cc-upload'), 'click', async () => loadFile(await pickFile('.txt,.sh,.bash,.cmd,.bat,.ps1,text/*'))),
      on($('#cc-copy'), 'click', () => copyReal(req && req.url ? req : null, els.output, null, () => codeFor(req, true, els.crlf.checked))),
      on($('#cc-download'), 'click', () => {
        if (!req || !req.url) { toast('Nothing to download yet', 'warn'); return; }
        const t = targetDef(); downloadFile(`request.${t.ext}`, codeFor(req, true, els.crlf.checked), 'text/plain;charset=utf-8');
      }),
      enableDrop($('[data-panel="parse"] .panel'), loadFile),
      // build tab
      on(buildPanel, 'input', runBuildSoon), on(buildPanel, 'change', runBuild), on(buildPanel, 'click', onRemove),
      on($('#cb-add-param'), 'click', () => addRow(els.params, 'Parameter').focus()),
      on($('#cb-add-header'), 'click', () => addRow(els.headers, 'Header').focus()),
      on($('#cb-add-field'), 'click', () => addRow(els.fields, 'Field').focus()),
      on($('#cb-copy'), 'click', () => copyReal(bReq, els.bout, null, () => buildShellCmd(bReq, true))),
      on($('#cb-download'), 'click', () => {
        if (!bReq) { toast('Fill in a valid URL first', 'warn'); return; }
        const ext = { posix: 'sh', cmd: 'cmd', powershell: 'ps1' }[els.bshell.value];
        downloadFile(`request.${ext}`, buildShellCmd(bReq, true), 'text/plain;charset=utf-8');
      }),
      on($('#cb-open'), 'click', () => {
        if (!bReq) { toast('Fill in a valid URL first', 'warn'); return; }
        els.input.value = buildShellCmd(bReq, true); els.shell.value = els.bshell.value; ctx.storage.set('shell', els.shell.value);
        selectTab('parse'); runParse(); toast('Command loaded in the From cURL tab', 'success');
      }),
    ];
    syncBuildUi(); runParse(); runBuild(); renderIcons(root);
    return () => { runParseSoon.cancel(); runBuildSoon.cancel(); disposers.forEach(d => d()); edIn.destroy(); edOut.destroy(); edBody.destroy(); edBout.destroy(); };
  },
};
