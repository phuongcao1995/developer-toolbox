// Response panel: status line, Body (Pretty / Tree / Raw / Preview), Headers, Cookies and Timing views.
// Every piece of response data reaches the DOM through textContent / the sandboxed iframe srcdoc, never innerHTML.
import { el as h, formatBytes, downloadFile, toast } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import { explainHeader, statusExplain, splitSetCookie, parseSetCookie, cookieIssues, pickTimingEntry, computeTiming, REDIRECT_NOTE } from './response.js';
import { createJsonTree } from './tree.js';

const EXT = [[/json/i, 'json'], [/html/i, 'html'], [/xml/i, 'xml'], [/javascript/i, 'js'], [/csv/i, 'csv'], [/^\s*text\//i, 'txt'], [/png/i, 'png'], [/jpe?g/i, 'jpg'], [/gif/i, 'gif'], [/webp/i, 'webp'], [/pdf/i, 'pdf'], [/zip/i, 'zip'], [/gzip/i, 'gz']];
export const extFor = ct => (EXT.find(([re]) => re.test(ct || '')) || [null, 'bin'])[1];
const isHtml = ct => /\b(text\/html|application\/xhtml\+xml)\b/i.test(ct || '');
const TTFB_NOTE = 'TTFB = time until the response headers arrived (measured around fetch()). The Timing tab shows a DNS / connect / TLS breakdown only when the server allows it with Timing-Allow-Origin.';

export function createResponseView(root, { copy }) {
  const $ = s => root.querySelector(s);
  const q = {
    status: $('#ac-status'), meta: $('#ac-meta'), explain: $('#ac-status-explain'), trunc: $('#ac-trunc'), output: $('#ac-output'),
    loading: $('#ac-loading'), tree: $('#ac-tree'), preview: $('#ac-preview'), treebar: $('#ac-treebar'), treeQ: $('#ac-tree-q'), treeCount: $('#ac-tree-count'),
    rheaders: $('#ac-rheaders'), rcount: $('#ac-rheaders-count'), ccount: $('#ac-rcookies-count'), cookies: $('#ac-cookies'), timing: $('#ac-timing'),
    copy: $('[data-action="copy-res"]'), dl: $('[data-action="download-res"]'), dlLabel: $('#ac-dl-label'),
  };
  const viewBtns = [...root.querySelectorAll('[data-view]')];
  q.meta.title = TTFB_NOTE;
  let cur = null, view = 'pretty', tree = null;

  const destroyTree = () => { tree?.destroy(); tree = null; lastQ = ''; hitTotal = 0; q.tree.replaceChildren(); q.treeCount.textContent = ''; q.treeQ.value = ''; };
  const note = text => h('p', { class: 'hint' }, text);

  function setView(v) {
    if (cur && ((v === 'tree' && cur.json === undefined) || (v === 'preview' && !cur.html))) v = 'pretty';
    view = v;
    for (const b of viewBtns) { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
    q.output.hidden = v === 'tree' || v === 'preview';
    q.tree.hidden = v !== 'tree'; q.treebar.hidden = v !== 'tree'; q.preview.hidden = v !== 'preview';
    if (!cur) return;
    if (v === 'pretty') q.output.textContent = cur.pretty;
    else if (v === 'raw') q.output.textContent = cur.raw;
    else if (v === 'tree' && !tree) {
      tree = createJsonTree(q.tree, cur.json, { copy });
    } else if (v === 'preview') {
      q.preview.replaceChildren(
        note('Sandboxed preview: scripts, forms, popups and same-origin access are disabled. Remote images and styles referenced by the page may still load.'),
        h('iframe', { class: 'ac-iframe', sandbox: '', srcdoc: cur.raw, title: 'HTML response preview', referrerpolicy: 'no-referrer' }));
    }
    if (v !== 'preview') q.preview.replaceChildren();
  }
  viewBtns.forEach(b => b.addEventListener('click', () => { if (!b.disabled) setView(b.dataset.view); }));

  const tbtn = name => root.querySelector(`[data-action="tree-${name}"]`);
  let lastQ = '', hitTotal = 0, hitPlus = false;
  const runSearch = () => {
    if (!tree) return;
    const t = q.treeQ.value.trim();
    lastQ = t;
    if (!t) { tree.clearSearch(); hitTotal = 0; q.treeCount.textContent = ''; return; }
    const r = tree.search(t);
    hitTotal = r.count; hitPlus = r.truncated;
    q.treeCount.textContent = r.count ? `${r.index + 1} of ${r.count}${r.truncated ? '+' : ''}` : 'No matches';
  };
  const step = fn => {
    if (!tree) return;
    if (q.treeQ.value.trim() !== lastQ) return runSearch();
    if (!hitTotal) return;
    q.treeCount.textContent = `${fn() + 1} of ${hitTotal}${hitPlus ? '+' : ''}`;
  };
  let st = null;
  q.treeQ.addEventListener('input', () => { clearTimeout(st); st = setTimeout(runSearch, 200); });
  q.treeQ.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(st); step(() => (e.shiftKey ? tree.prev() : tree.next())); } });
  tbtn('next').addEventListener('click', () => step(() => tree.next()));
  tbtn('prev').addEventListener('click', () => step(() => tree.prev()));
  tbtn('expand').addEventListener('click', () => { if (!tree) return; const r = tree.expandAll(); if (r.capped) toast('Expanded as far as is practical; open deeper nodes individually.', 'info'); });
  tbtn('collapse').addEventListener('click', () => tree?.collapseAll());

  function renderHeaders(entries) {
    q.rcount.textContent = String(entries.length);
    if (!entries.length) {
      q.rheaders.replaceChildren(h('tr', {}, h('td', { colspan: '3', class: 'hint' }, 'No readable headers (the server may not expose them via CORS, or the response is opaque).')));
      return;
    }
    q.rheaders.replaceChildren(...entries.map(([k, v]) => {
      const info = explainHeader(k);
      return h('tr', {}, h('td', { class: 'ac-hdr-name', title: info || '' }, k), h('td', { class: 'ac-hdr-val' }, v), h('td', { class: 'ac-hdr-info' }, info || ''));
    }));
  }

  function renderCookies(res, https) {
    let list = [];
    try { if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie(); } catch { /* ignore */ }
    if (!list.length) { const raw = res.headers.get('set-cookie'); if (raw) list = splitSetCookie(raw); }
    q.ccount.textContent = String(list.length);
    if (!list.length) {
      q.cookies.replaceChildren(h('div', { class: 'alert alert-info' },
        'No Set-Cookie headers are visible to this page. Browsers never expose Set-Cookie to fetch() (it is a forbidden response header), even when the server sent one, so cookies cannot be listed here. ' +
        'Open DevTools > Application > Cookies (or the Network tab) to see them. Whether the browser stores or sends cookies on cross-origin requests is controlled by the Credentials setting.'));
      return;
    }
    const cards = list.map(raw => {
      const c = parseSetCookie(raw), issues = cookieIssues(c, { https });
      const attrs = [['Domain', c.domain], ['Path', c.path], ['Expires', c.expires], ['Max-Age', c.maxAge == null ? '' : String(c.maxAge)], ['SameSite', c.sameSite], ['Secure', c.secure ? 'yes' : ''], ['HttpOnly', c.httpOnly ? 'yes' : ''], ['Partitioned', c.partitioned ? 'yes' : '']].filter(a => a[1]);
      return h('div', { class: 'ac-cookie' },
        h('div', {}, h('b', { class: 'mono' }, c.name || '(no name)'), ' = ', h('span', { class: 'mono ac-hdr-val' }, c.value)),
        h('div', { class: 'hint' }, attrs.map(([k, v]) => `${k}: ${v}`).join(' · ') || 'No attributes (session cookie)'),
        issues.length ? h('ul', { class: 'ac-issues' }, issues.map(i => h('li', { class: `ac-issue-${i.level}` }, i.text))) : h('div', { class: 'hint' }, 'No issues found.'));
    });
    q.cookies.replaceChildren(...cards);
  }

  function renderTiming({ res, url, t0, ttfb, total, size }) {
    let entry = null;
    try {
      const names = [...new Set([res.url, url].filter(Boolean))];
      for (const n of names) { entry = pickTimingEntry(performance.getEntriesByName(n, 'resource'), t0); if (entry) break; }
    } catch { /* Resource Timing unavailable */ }
    const ct = computeTiming(entry);
    const rows = [['Time to first byte (measured)', ttfb], ['Total (measured)', total]];
    const kids = [h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, `${v.toFixed(0)} ms`)))))),
      h('p', { class: 'hint' }, `Response size: ${formatBytes(size)}.`)];
    if (ct.available) {
      const max = Math.max(...ct.phases.map(p => p.ms), 1);
      kids.push(h('h4', { class: 'ac-h4' }, 'Resource Timing breakdown'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, ct.phases.map(p => h('tr', {},
          h('td', {}, p.name), h('td', { class: 'mono' }, `${p.ms.toFixed(1)} ms`),
          h('td', { class: 'ac-bar-cell' }, h('span', { class: 'ac-bar', style: `width:${Math.max(1, Math.round(p.ms / max * 100))}%` }))))))));
      if (ct.note) kids.push(h('p', { class: 'hint' }, ct.note));
      if (entry?.nextHopProtocol) kids.push(h('p', { class: 'hint' }, `Protocol: ${entry.nextHopProtocol}`));
    } else {
      kids.push(h('div', { class: 'alert alert-info' }, entry
        ? `No DNS / connect / TLS breakdown. ${ct.note} Only the measured TTFB and total are shown.`
        : 'The browser did not provide a Resource Timing entry for this request (it may have been evicted, or the response was opaque). Only the measured TTFB and total are shown.'));
    }
    q.timing.replaceChildren(...kids);
  }

  function clear() {
    cur = null; destroyTree(); q.preview.replaceChildren();
    q.status.hidden = true; q.status.textContent = ''; q.meta.textContent = ''; q.explain.hidden = true; q.explain.textContent = '';
    q.trunc.hidden = true; q.trunc.textContent = ''; q.output.textContent = '';
    q.rheaders.replaceChildren(); q.rcount.textContent = '0'; q.ccount.textContent = '0';
    q.cookies.replaceChildren(note('Send a request to see its cookies.')); q.timing.replaceChildren(note('Send a request to see timing details.'));
    q.copy.disabled = true; q.dl.disabled = true; q.dlLabel.textContent = 'Download';
    for (const b of viewBtns) b.disabled = b.dataset.view === 'tree' || b.dataset.view === 'preview';
    setView('pretty');
  }

  /** info: { res, bytes, ttfb, total, t0, url, method } */
  function show(info) {
    clear();
    const { res, bytes, ttfb, total, url, method } = info;
    const ct = res.headers.get('content-type') || '';
    const opaque = res.type === 'opaqueredirect' || res.type === 'opaque';
    const dec = L.decodeResponse(bytes, ct);
    const blob = new Blob([bytes], { type: ct || 'application/octet-stream' });
    let pretty = '', raw = '', json, isJson = false;
    if (dec.kind === 'text') {
      raw = dec.text;
      const fmt = dec.truncated ? { text: dec.text, isJson: false } : L.formatResponseBody(dec.text, ct);
      pretty = fmt.text; isJson = fmt.isJson;
      if (isJson) { try { json = JSON.parse(dec.text); } catch { json = undefined; } }
    } else if (dec.kind === 'binary') {
      pretty = raw = `Binary response (${ct || 'unknown type'}, ${formatBytes(dec.size)}). It is not displayed as text: use Download to save it.`;
    } else {
      pretty = raw = opaque ? 'Opaque response: the browser hides the status, headers and body of this response.'
        : res.status === 204 || res.status === 304 || method === 'HEAD' ? '(no response body)' : '(empty response body)';
    }
    cur = { pretty, raw, json, html: dec.kind === 'text' && isHtml(ct), blob, ct, truncated: dec.truncated, kind: dec.kind };

    const status = Number(res.status);
    q.status.hidden = false;
    q.status.className = `badge badge-${opaque ? 'info' : L.statusClass(status)}`;
    q.status.textContent = opaque ? 'Opaque redirect' : `${status} ${res.statusText || ''}`.trim();
    q.meta.textContent = `TTFB ${ttfb.toFixed(0)} ms · total ${total.toFixed(0)} ms · ${formatBytes(dec.size)}${isJson ? ' · JSON' : ''}${dec.kind === 'binary' ? ' · binary' : ''}`;
    q.explain.hidden = false;
    q.explain.textContent = opaque ? `${statusExplain(0)} ${REDIRECT_NOTE}` : `${statusExplain(status)}${status >= 300 && status < 400 ? ` ${REDIRECT_NOTE}` : ''}`;
    if (dec.truncated) {
      q.trunc.hidden = false;
      q.trunc.textContent = `Truncated: showing the first ${formatBytes(L.MAX_DISPLAY_BYTES)} of ${formatBytes(dec.size)}. Copy and Tree apply to the shown part; Download saves the full response.`;
    }
    q.copy.disabled = dec.kind !== 'text'; q.dl.disabled = dec.kind === 'empty';
    q.dlLabel.textContent = dec.truncated ? 'Download full response' : 'Download';
    viewBtns.find(b => b.dataset.view === 'tree').disabled = json === undefined;
    viewBtns.find(b => b.dataset.view === 'preview').disabled = !cur.html;
    setView('pretty');
    renderHeaders(opaque ? [] : [...res.headers.entries()]);
    renderCookies(res, /^https:/i.test(url));
    renderTiming({ res, url, t0: info.t0, ttfb, total, size: dec.size });
  }

  return {
    clear, show, destroy: destroyTree,
    setLoading(b) { q.loading.hidden = !b; },
    showText(text) { clear(); q.output.textContent = text; },
    copyBody() { if (!cur || cur.kind !== 'text') return toast('Nothing to copy', 'warn'); copy(view === 'raw' ? cur.raw : cur.pretty, cur.truncated ? 'Shown part of the response copied' : 'Response copied'); },
    download() { if (!cur) return toast('Nothing to download', 'warn'); downloadFile(`response.${extFor(cur.ct)}`, cur.blob); },
    hasResponse: () => !!cur,
  };
}
