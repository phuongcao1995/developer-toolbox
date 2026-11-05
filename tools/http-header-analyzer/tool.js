// HTTP Header Analyzer UI. All parsing/analysis is in logic.js; untrusted text is only ever set through textContent.
import { copyText, downloadFile, initTabs, renderIcons, el, enableDrop, readFileAsText, toast, enableTabIndent } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

const SAMPLE_RES = `HTTP/2 200
date: Mon, 15 Jan 2024 12:00:00 GMT
content-type: text/html; charset=utf-8
server: nginx/1.18.0
x-powered-by: Express
cache-control: public, max-age=3600
vary: Accept-Encoding
set-cookie: session=abc123; Path=/; HttpOnly
set-cookie: pref=dark; Path=/; SameSite=None
strict-transport-security: max-age=300
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'
x-xss-protection: 1; mode=block
access-control-allow-origin: https://app.example.com
`;
const SAMPLE_REQ = `GET /api/items?page=2 HTTP/1.1
Host: api.example.com
User-Agent: Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0
Accept: application/json, text/plain;q=0.9, */*;q=0.8
Accept-Encoding: gzip, deflate, br
Accept-Language: en-US,en;q=0.9,fr;q=0.5
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl
Cookie: session=abc123; theme=dark
Origin: https://app.example.com
Sec-Fetch-Mode: cors
Cache-Control: no-cache
`;
const LEVEL_LABEL = { error: 'Error', warn: 'Warning', info: 'Note' };
const LEVEL_CLASS = { error: 'badge-danger', warn: 'badge-warn', info: 'badge-info' };
const STATUS_LABEL = { ok: 'OK', missing: 'Missing', misconfigured: 'Misconfigured', leak: 'Information leak', info: 'Note' };
const STATUS_CLASS = { ok: 'badge-success', missing: 'badge-warn', misconfigured: 'badge-danger', leak: 'badge-warn', info: 'badge-info' };

const badge = (text, cls = '') => el('span', { class: `badge ${cls}`.trim() }, text);

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = { mode: $('#ha-mode'), https: $('#ha-https'), mask: $('#ha-mask'), remember: $('#ha-remember'), text: $('#ha-text'), summary: $('#ha-summary'), notes: $('#ha-notes'),
      rows: $('#ha-rows'), rowsEmpty: $('#ha-rows-empty'), filter: $('#ha-filter'), disclaimer: $('#ha-disclaimer'), security: $('#ha-security'), issues: $('#ha-issues'), report: $('#ha-report'), file: $('#ha-file') };

    const saved = ctx.storage.get('opts', null) || {};
    els.remember.checked = ctx.storage.get('remember', true) !== false;
    if (els.remember.checked) {
      if (['auto', 'request', 'response'].includes(saved.mode)) els.mode.value = saved.mode;
      if (['unknown', 'yes', 'no'].includes(saved.https)) els.https.value = saved.https;
      if (typeof saved.mask === 'boolean') els.mask.checked = saved.mask;
    }
    // Pasted headers can contain credentials: they are intentionally never written to storage.
    const persist = () => {
      ctx.storage.set('remember', els.remember.checked);
      if (!els.remember.checked) { ctx.storage.remove('opts'); return; }
      ctx.storage.set('opts', { mode: els.mode.value, https: els.https.value, mask: els.mask.checked });
    };

    let result = null;
    const showTab = initTabs(root);

    function renderRows() {
      const q = els.filter.value.trim().toLowerCase();
      const rows = (result?.rows || []).filter(r => !q || [r.name, r.category, r.description, r.summary, r.display].some(t => String(t).toLowerCase().includes(q)));
      els.rows.replaceChildren(...rows.map(r => {
        const worst = r.issues.find(i => i.level === 'error') || r.issues.find(i => i.level === 'warn');
        const nameCell = el('td', { class: 'ha-name' }, el('code', {}, r.name));
        if (r.note) nameCell.append(el('div', {}, badge(r.note.split(':')[0], /deprecated|obsolete|removed/i.test(r.note) ? 'badge-warn' : '')));
        const valueCell = el('td', { class: 'ha-value' }, el('code', {}, r.display));
        if (r.display !== r.value) valueCell.append(el('div', { class: 'hint' }, 'masked'));
        const expl = el('td', { class: 'ha-expl' }, el('div', {}, r.summary || r.description));
        if (r.summary) expl.append(el('div', { class: 'hint' }, r.description));
        const flags = r.issues.filter(i => i.level !== 'info');
        if (flags.length) expl.append(el('div', { class: 'ha-flags' }, ...flags.slice(0, 3).map(i => badge(`${LEVEL_LABEL[i.level]}: ${i.message}`, LEVEL_CLASS[i.level]))));
        if (r.details.length || r.issues.length) {
          const det = el('details', { class: 'ha-details' }, el('summary', {}, `Details${r.issues.length ? ` (${r.issues.length} finding${r.issues.length === 1 ? '' : 's'})` : ''}`));
          if (r.details.length) det.append(el('dl', { class: 'ha-dl' }, ...r.details.flatMap(d => [el('dt', {}, d.label), el('dd', {}, [d.value, d.note ? ` (${d.note})` : ''].join(''))])));
          if (r.issues.length) det.append(el('ul', { class: 'ha-ul' }, ...r.issues.map(i => el('li', {}, badge(LEVEL_LABEL[i.level], LEVEL_CLASS[i.level]), ' ', i.message))));
          expl.append(det);
        }
        return el('tr', { class: worst ? `ha-row-${worst.level}` : '' }, nameCell, valueCell, el('td', {}, badge(r.category)), expl);
      }));
      els.rowsEmpty.hidden = rows.length > 0;
      els.rowsEmpty.textContent = result?.rows.length ? 'No headers match the filter.' : 'Paste headers above to see them here.';
    }

    function renderSecurity() {
      els.security.replaceChildren();
      if (!result || result.mode !== 'response') {
        els.disclaimer.textContent = result ? 'The security review applies to response headers. Switch the type to "Response headers" if this is a response.' : 'Paste response headers to get a security review.';
        return;
      }
      const s = result.security;
      els.disclaimer.textContent = s.disclaimer;
      const c = s.counts;
      els.security.append(el('div', { class: 'ha-counts' }, badge(`${c.ok} OK`, 'badge-success'), badge(`${c.missing} missing`, 'badge-warn'), badge(`${c.misconfigured} misconfigured`, 'badge-danger'), badge(`${c.leak} information leaks`, 'badge-warn'), badge(`${c.info} notes`, 'badge-info')));
      const order = { high: 0, medium: 1, low: 2, info: 3 };
      const statusOrder = { misconfigured: 0, leak: 1, missing: 2, info: 3, ok: 4 };
      const items = [...s.items].sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || order[a.severity] - order[b.severity]);
      const wrap = el('div', { class: 'table-wrap' });
      const tbl = el('table', { class: 'table' }, el('caption', { class: 'sr-only' }, 'Security review checklist'),
        el('thead', {}, el('tr', {}, ...['Status', 'Severity', 'Header', 'Finding'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, ...items.map(i => el('tr', {}, el('td', {}, badge(STATUS_LABEL[i.status], STATUS_CLASS[i.status])), el('td', {}, i.severity === 'info' ? '-' : i.severity),
          el('td', {}, el('code', {}, i.header)), el('td', {}, el('strong', {}, i.title), el('div', {}, i.message), i.recommendation ? el('div', { class: 'hint' }, `Recommendation: ${i.recommendation}`) : null)))));
      wrap.append(tbl); els.security.append(wrap);
    }

    function renderIssues() {
      els.issues.replaceChildren();
      if (!result) return;
      const all = [
        ...result.issues.map(i => ({ ...i, where: i.line ? `Line ${i.line}` : 'Input' })),
        ...result.cross.map(i => ({ ...i, where: i.header || 'Headers' })),
        ...result.rows.flatMap(r => r.issues.filter(i => i.level !== 'info').map(i => ({ ...i, where: r.name }))),
      ];
      const seen = new Set();
      const list = all.filter(i => { const k = `${i.where}|${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
      if (!list.length) { els.issues.append(el('p', { class: 'alert alert-success' }, 'No syntax problems or value warnings found.')); return; }
      for (const level of ['error', 'warn', 'info']) {
        const group = list.filter(i => i.level === level); if (!group.length) continue;
        els.issues.append(el('h3', { class: 'ha-h' }, `${LEVEL_LABEL[level]}s (${group.length})`),
          el('ul', { class: 'ha-ul' }, ...group.map(i => el('li', {}, el('code', {}, i.where), ': ', i.message))));
      }
    }

    function renderSummary() {
      els.summary.replaceChildren(); els.notes.replaceChildren();
      if (!result) return;
      const errs = result.issues.filter(i => i.level === 'error');
      if (!result.rows.length) { els.summary.append(el('div', { class: 'alert alert-error' }, errs[0]?.message || 'No headers found.')); }
      else {
        const nIssues = result.rows.reduce((n, r) => n + r.issues.filter(i => i.level !== 'info').length, 0) + result.issues.filter(i => i.level !== 'info').length + result.cross.filter(i => i.level !== 'info').length;
        els.summary.append(badge(`${result.mode === 'request' ? 'Request' : 'Response'} headers`, 'badge-info'), badge(`${result.rows.length} header${result.rows.length === 1 ? '' : 's'}`),
          result.startLine ? badge(result.startLine.raw.slice(0, 80)) : null, badge(`${nIssues} warning${nIssues === 1 ? '' : 's'} or error${nIssues === 1 ? '' : 's'}`, nIssues ? 'badge-warn' : 'badge-success'));
        if (result.parsed.source !== 'raw') els.summary.append(badge(`from ${result.parsed.source}`));
      }
      for (const n of result.notes) els.notes.append(el('p', { class: 'hint' }, n));
    }

    function renderReport() {
      els.report.value = result && result.rows.length ? L.buildReportMarkdown(result) : '';
    }

    function analyze() {
      const text = els.text.value;
      if (!text.trim()) { result = null; }
      else result = L.analyze(text, { mode: els.mode.value, https: els.https.value, mask: els.mask.checked });
      renderSummary(); renderRows(); renderSecurity(); renderIssues(); renderReport();
      renderIcons(root);
    }
    const analyzeSoon = ctx.debounce(analyze, 250);

    const disposers = [];
    const on = (t, ev, fn) => { t.addEventListener(ev, fn); disposers.push(() => t.removeEventListener(ev, fn)); };
    enableTabIndent(els.text, '  ');
    on(els.text, 'input', analyzeSoon);
    on(els.mode, 'change', () => { persist(); analyze(); });
    on(els.https, 'change', () => { persist(); analyze(); });
    on(els.mask, 'change', () => { persist(); analyze(); });
    on(els.remember, 'change', () => { persist(); toast(els.remember.checked ? 'Options will be remembered (pasted headers are never saved)' : 'Saved options removed', 'info'); });
    on(els.filter, 'input', renderRows);
    on($('#ha-sample-res'), 'click', () => { els.text.value = SAMPLE_RES; els.mode.value = 'auto'; analyze(); });
    on($('#ha-sample-req'), 'click', () => { els.text.value = SAMPLE_REQ; els.mode.value = 'auto'; analyze(); });
    on($('#ha-clear'), 'click', () => { els.text.value = ''; analyze(); els.text.focus(); });
    on($('#ha-upload'), 'click', () => els.file.click());
    const load = async f => {
      if (!f) return;
      if (f.size > L.LIMITS.bytes) { toast('That file is larger than 1 MB', 'error'); return; }
      try { els.text.value = await readFileAsText(f); analyze(); } catch { toast('Could not read that file', 'error'); }
    };
    on(els.file, 'change', async () => { await load(els.file.files[0]); els.file.value = ''; });
    disposers.push(enableDrop($('#ha-drop'), load));
    on($('#ha-copy-md'), 'click', () => copyText(els.report.value, 'Markdown copied'));
    on($('#ha-copy-json'), 'click', () => copyText(result && result.rows.length ? L.buildReportJson(result) : '', 'JSON copied'));
    on($('#ha-dl-md'), 'click', () => downloadFile('header-report.md', els.report.value, 'text/markdown;charset=utf-8'));
    on($('#ha-dl-json'), 'click', () => downloadFile('header-report.json', result && result.rows.length ? L.buildReportJson(result) : '', 'application/json;charset=utf-8'));

    analyze(); void showTab;
    return () => { disposers.forEach(d => d()); };
  },
};
