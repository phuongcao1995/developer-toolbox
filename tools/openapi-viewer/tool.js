// OpenAPI / Swagger viewer UI. All parsing, $ref resolution, lint, example generation and export logic lives in logic.js.
// Spec content is only ever inserted with textContent (no innerHTML). No requests are sent to the described API.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, formatBytes, renderIcons, initTabs } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import { PETSTORE_30, API_31, SWAGGER_20 } from './samples.js';

const YAML_SRC = 'assets/js/vendor/js-yaml.min.js';
const MAX_FILE = 20 * 1024 * 1024;
const MAX_FETCH = 10 * 1024 * 1024;
const FETCH_TIMEOUT = 15000;
const PAGE = 150;
const CHUNK = 150;
const SAMPLES = { p30: PETSTORE_30, e31: API_31, s20: SWAGGER_20 };
const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const methodBadge = m => mk('span', `oa-m oa-m-${m.toLowerCase()}`, m);

function renderInlines(parent, list) {
  for (const n of list) {
    if (n.t === 'code') parent.append(mk('code', '', n.text));
    else if (n.t === 'strong') parent.append(mk('strong', '', n.text));
    else if (n.t === 'em') parent.append(mk('em', '', n.text));
    else if (n.t === 'link' && L.safeHref(n.href)) { const a = mk('a', '', n.text); a.href = L.safeHref(n.href); a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; parent.append(a); }
    else parent.append(document.createTextNode(n.text));
  }
}
/** Minimal Markdown (via the pure AST parser) rendered with DOM nodes only. */
function renderMarkdown(text) {
  const box = mk('div', 'oa-md');
  for (const b of L.parseMarkdown(text)) {
    let el;
    if (b.t === 'p') { el = mk('p'); renderInlines(el, b.inlines); }
    else if (b.t === 'h') { el = mk('h4'); renderInlines(el, b.inlines); }
    else if (b.t === 'ul' || b.t === 'ol') { el = mk(b.t); for (const it of b.items) { const li = mk('li'); renderInlines(li, it); el.append(li); } }
    else if (b.t === 'quote') { el = mk('blockquote'); renderInlines(el, b.inlines); }
    else { el = mk('pre'); el.append(mk('code', '', b.text)); }
    box.append(el);
  }
  return box;
}

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      source: $('#oa-source'), input: $('#oa-input'), msg: $('#oa-msg'), app: $('#oa-app'), name: $('#oa-name'), badges: $('#oa-badges'),
      q: $('#oa-q'), tag: $('#oa-tag'), methods: $('#oa-methods'), dep: $('#oa-dep'), count: $('#oa-count'), list: $('#oa-list'), detail: $('#oa-detail'),
      sq: $('#oa-sq'), slist: $('#oa-slist'), sdetail: $('#oa-sdetail'), info: $('#oa-info'), lint: $('#oa-lint'), lintLevel: $('#oa-lintlevel'), lintCount: $('#oa-lintcount'),
      fetchBox: $('#oa-fetch'), fetchToggle: $('#oa-fetch-toggle'), url: $('#oa-url'), fetchGo: $('#oa-fetch-go'), fetchCancel: $('#oa-fetch-cancel'), sample: $('#oa-sample'),
    };
    const store = (k, d) => { try { return ctx.storage.get(k, d) ?? d; } catch { return d; } };
    const save = (k, v) => { try { ctx.storage.set(k, v); } catch { /* ignore */ } };
    const disposers = [];
    const on = (t, ev, fn) => { t.addEventListener(ev, fn); disposers.push(() => t.removeEventListener(ev, fn)); };
    let destroyed = false, busy = false, fetchAbort = null;
    let model = null, lintCache = null, usage = null, selectedKey = null, selectedSchema = null;
    let filtered = [], shown = PAGE, activeTab = 'endpoints';
    els.url.value = store('url', '');

    // ---- method chips
    const methodSet = new Set();
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER']) {
      const lab = mk('label', 'oa-mchip'); const cb = mk('input'); cb.type = 'checkbox'; cb.value = m; cb.setAttribute('aria-label', `${m} requests`);
      cb.addEventListener('change', () => { cb.checked ? methodSet.add(m) : methodSet.delete(m); refreshList(); });
      lab.append(cb, mk('span', '', m)); els.methods.append(lab);
    }
    const effMethods = () => { if (!methodSet.size) return null; const s = new Set(); for (const m of methodSet) { if (m === 'OTHER') ['HEAD', 'OPTIONS', 'TRACE'].forEach(x => s.add(x)); else s.add(m); } return s; };

    async function ensureYaml() {
      if (window.jsyaml) return window.jsyaml;
      try { await ctx.ui.loadScript(YAML_SRC); return window.jsyaml; }
      catch (e) { showMessage(els.msg, 'error', `The YAML library could not be loaded (${e.message}). JSON documents still work.`); return null; }
    }

    // ================================================================ loading
    async function load(text) {
      if (busy) return;
      busy = true; showMessage(els.msg, 'info', 'Reading the specification…');
      try {
        await new Promise(r => setTimeout(r, 0));
        const looksJson = /^\s*[{[]/.test(text);
        const yaml = looksJson ? null : await ensureYaml();
        if (!looksJson && !yaml) return;
        const r = L.parseSpec(text, yaml);
        if (destroyed) return;
        if (!r.ok) { model = null; els.app.hidden = true; showMessage(els.msg, 'error', `Line ${r.error.line}, column ${r.error.column}: ${r.error.message}`); return; }
        if (!r.kind) { showMessage(els.msg, 'error', `Unsupported version "${r.version}". Only OpenAPI 3.x and Swagger 2.0 are supported.`); return; }
        model = L.normalize(r.spec);
        lintCache = null; usage = null; selectedKey = null; selectedSchema = null;
        showMessage(els.msg, null);
        render(r);
        els.source.open = text.length < 200000;
      } catch (e) { showMessage(els.msg, 'error', `Could not process the document: ${e.message}`); }
      finally { busy = false; }
    }

    function render(r) {
      els.app.hidden = false;
      els.name.textContent = `${model.info.title}${model.info.version ? ` ${model.info.version}` : ''}`;
      els.badges.replaceChildren();
      const b = (t, c = 'badge') => els.badges.append(mk('span', c, t));
      b(`${model.kind === 'swagger2' ? 'Swagger' : 'OpenAPI'} ${model.version}`, 'badge badge-info'); b(r.format.toUpperCase());
      b(`${model.stats.operations} operation${model.stats.operations === 1 ? '' : 's'}`); if (model.stats.webhooks) b(`${model.stats.webhooks} webhook${model.stats.webhooks === 1 ? '' : 's'}`);
      b(`${model.stats.schemas} schema${model.stats.schemas === 1 ? '' : 's'}`); b(`${model.stats.tags} tag${model.stats.tags === 1 ? '' : 's'}`);
      const tags = new Set(); for (const op of [...model.operations, ...model.webhooks]) (op.tags.length ? op.tags : ['default']).forEach(t => tags.add(t));
      els.tag.replaceChildren(new Option('All tags', '')); for (const t of [...model.tags.map(x => x.name), ...tags].filter((x, i, a) => a.indexOf(x) === i)) els.tag.append(new Option(t, t));
      els.q.value = ''; els.dep.checked = false; methodSet.clear(); els.methods.querySelectorAll('input').forEach(i => { i.checked = false; });
      els.detail.replaceChildren(mk('p', 'hint', 'Select an endpoint to see its details.'));
      els.sdetail.replaceChildren(mk('p', 'hint', 'Select a schema to explore its structure and see where it is used.'));
      refreshList(); renderSchemaList(); renderInfo(); renderLint();
    }

    // ================================================================ endpoints list
    const allOps = () => [...model.operations, ...model.webhooks];
    function refreshList() {
      if (!model) return;
      filtered = L.filterOperations(allOps(), els.q.value, { methods: effMethods(), tag: els.tag.value || undefined, deprecated: els.dep.checked });
      shown = PAGE; drawList();
    }
    function drawList() {
      els.list.replaceChildren();
      const total = allOps().length;
      els.count.textContent = filtered.length === total ? `${total} endpoint${total === 1 ? '' : 's'}` : `${filtered.length} of ${total} endpoints match`;
      if (!filtered.length) { els.list.append(mk('p', 'hint', total ? 'No endpoints match the filters.' : 'This document defines no paths or webhooks.')); els.list.style.display = 'block'; return; }
      els.list.style.display = '';
      let n = 0, truncated = false;
      for (const g of L.groupByTag(model, filtered)) {
        if (n >= shown) { truncated = true; break; }
        const h = mk('h3', 'oa-group', g.name); els.list.append(h);
        for (const op of g.ops) {
          if (n >= shown) { truncated = true; break; }
          n++;
          const btn = mk('button', `oa-row${op.deprecated ? ' dep' : ''}`); btn.type = 'button'; btn.dataset.key = op.key;
          btn.append(methodBadge(op.method), mk('span', 'p', op.path));
          if (op.summary) btn.append(mk('span', 'hint', op.summary));
          if (op.deprecated) btn.append(mk('span', 'badge badge-warn', 'deprecated'));
          btn.setAttribute('aria-label', `${op.method} ${op.path}${op.summary ? `: ${op.summary}` : ''}${op.deprecated ? ' (deprecated)' : ''}`);
          if (op.key === selectedKey) btn.setAttribute('aria-current', 'true');
          btn.addEventListener('click', () => selectOp(op));
          els.list.append(btn);
        }
      }
      if (truncated) { const more = mk('button', 'btn btn-sm oa-more', `Show ${Math.min(PAGE, filtered.length - shown)} more`); more.type = 'button'; more.addEventListener('click', () => { shown += PAGE; drawList(); }); els.list.append(more); }
    }
    const refilter = ctx.debounce(refreshList, 200);
    on(els.q, 'input', refilter); on(els.tag, 'change', refreshList); on(els.dep, 'change', refreshList);

    function selectOp(op, scroll = false) {
      selectedKey = op.key;
      for (const b of els.list.querySelectorAll('.oa-row')) { if (b.dataset.key === op.key) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
      renderOp(op);
      if (scroll || window.matchMedia('(max-width: 820px)').matches) els.detail.scrollIntoView({ block: 'start' });
    }

    // ================================================================ schema tree
    function treeChildren(node) {
      const kids = [];
      for (const p of node.properties || []) kids.push(p);
      if (node.items) kids.push({ ...node.items, name: node.items.name ?? '[items]', required: false });
      if (node.additional && typeof node.additional === 'object') kids.push({ ...node.additional, name: '[additionalProperties]', required: false });
      if (node.variants) node.variants.list.forEach((v, i) => kids.push({ ...v, name: `${node.variants.kind} ${i + 1}`, required: false }));
      return kids;
    }
    function schemaRow(node, open) {
      const li = mk('li'); const row = mk('div', 'oa-srow'); li.append(row);
      const kids = (node.circular || node.unresolved || node.truncated) ? [] : treeChildren(node);
      let ul = null;
      if (kids.length) {
        const tg = mk('button', 'oa-tog', open ? '▾' : '▸'); tg.type = 'button'; tg.setAttribute('aria-expanded', String(open)); tg.setAttribute('aria-label', `Toggle ${node.name || 'schema'}`);
        const toggle = want => {
          if (want && !ul) { ul = mk('ul'); renderChunk(ul, kids, 0); li.append(ul); }
          if (ul) ul.hidden = !want; tg.textContent = want ? '▾' : '▸'; tg.setAttribute('aria-expanded', String(want));
        };
        tg.addEventListener('click', () => toggle(tg.getAttribute('aria-expanded') !== 'true')); row.append(tg);
        if (open) toggle(true);
      } else row.append(mk('span', 'oa-gap'));
      if (node.name !== undefined) row.append(mk('span', 'oa-sn', String(node.name)));
      row.append(mk('span', 'oa-st', L.typeLabel(node)));
      if (node.required) row.append(mk('span', 'badge badge-danger', 'required'));
      if (node.readOnly) row.append(mk('span', 'badge', 'read-only')); if (node.writeOnly) row.append(mk('span', 'badge', 'write-only')); if (node.deprecated) row.append(mk('span', 'badge badge-warn', 'deprecated'));
      if (node.circular) row.append(mk('span', 'badge badge-info', 'recursive'));
      if (node.truncated) row.append(mk('span', 'badge badge-warn', 'depth limit'));
      if (node.unresolved) row.append(mk('span', 'badge badge-danger', node.unresolved));
      if (node.description) row.append(mk('span', 'oa-sd', node.description));
      const extras = [];
      if (node.merged) extras.push(`allOf: ${node.merged.join(' + ')}`);
      if (node.variants?.discriminator) extras.push(`discriminator: ${node.variants.discriminator}`);
      if (node.enum) extras.push(`enum: ${node.enum.map(v => JSON.stringify(v)).join(' | ')}`);
      if (node.default !== undefined) extras.push(`default: ${JSON.stringify(node.default)}`);
      if (node.example !== undefined) extras.push(`example: ${JSON.stringify(node.example)}`);
      if (node.constraints?.length) extras.push(node.constraints.join(', '));
      if (node.additional === true) extras.push('additional properties allowed'); if (node.additional === false) extras.push('no additional properties');
      if (extras.length) li.append(mk('div', 'oa-sx', extras.join(' · ')));
      return li;
    }
    function renderChunk(ul, kids, from) {
      ul.querySelector(':scope > li.oa-morewrap')?.remove();
      const end = Math.min(kids.length, from + CHUNK);
      for (let i = from; i < end; i++) ul.append(schemaRow(kids[i], false));
      if (end < kids.length) { const li = mk('li', 'oa-morewrap'); const b = mk('button', 'btn btn-sm oa-more', `Show ${Math.min(CHUNK, kids.length - end)} more (${kids.length - end} remaining)`); b.type = 'button'; b.addEventListener('click', () => renderChunk(ul, kids, end)); li.append(b); ul.append(li); }
    }
    function schemaTreeEl(schema) {
      const box = mk('div', 'oa-stree'); const ul = mk('ul');
      ul.append(schemaRow(L.buildSchemaTree(model.spec, schema), true)); box.append(ul); return box;
    }
    function exampleEl(c) {
      const wrap = mk('div', 'oa-ex');
      let list;
      try { list = L.exampleTexts(model.spec, c); } catch { list = []; }
      if (!list.length) return wrap;
      for (const ex of list.slice(0, 10)) {
        const head = mk('div', 'oa-ex-head');
        head.append(mk('span', '', `${ex.source === 'spec' ? 'Example' : 'Generated example'}${ex.name ? `: ${ex.name}` : ''}`));
        const cp = mk('button', 'btn btn-sm', 'Copy'); cp.type = 'button'; cp.setAttribute('aria-label', 'Copy example'); cp.addEventListener('click', () => copyText(ex.text, 'Example copied')); head.append(cp);
        const pre = mk('pre'); pre.append(mk('code', '', ex.text.length > 60000 ? `${ex.text.slice(0, 60000)}\n… (truncated for display; copy gives the full text)` : ex.text)); pre.tabIndex = 0;
        wrap.append(head, pre);
      }
      return wrap;
    }
    function contentEl(contents, label) {
      const box = mk('div');
      if (!contents.length) return box;
      const bar = mk('div', 'oa-ctypes'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', `${label} content types`);
      const body = mk('div');
      const show = i => { [...bar.children].forEach((b, j) => b.setAttribute('aria-pressed', String(i === j))); body.replaceChildren(); const c = contents[i]; if (c.schema) body.append(schemaTreeEl(c.schema)); else body.append(mk('p', 'hint', 'No schema defined.')); body.append(exampleEl(c)); };
      contents.forEach((c, i) => { const b = mk('button', 'btn btn-sm', c.mime); b.type = 'button'; b.addEventListener('click', () => show(i)); bar.append(b); });
      box.append(bar, body); show(0); return box;
    }

    // ================================================================ operation detail
    function table(head, rows) {
      const wrap = mk('div', 'oa-scroll'); const t = mk('table'); const tr = mk('tr');
      for (const h of head) { const th = mk('th', '', h); th.scope = 'col'; tr.append(th); } t.append(mk('thead')); t.firstChild.append(tr);
      const tb = mk('tbody'); for (const r of rows) { const row = mk('tr'); for (const c of r) { const td = mk('td'); if (c instanceof Node) td.append(c); else td.textContent = c; row.append(td); } tb.append(row); }
      t.append(tb); wrap.append(t); return wrap;
    }
    function securityEl(op) {
      if (op.security === null) return null;
      const p = mk('p');
      if (!op.security.length) { p.textContent = 'No authentication required.'; return p; }
      op.security.forEach((req, i) => {
        if (i) p.append(' or ');
        if (!req.length) p.append('none (optional) ');
        req.forEach((r, j) => { if (j) p.append(' + '); p.append(mk('code', '', r.name + (r.scopes.length ? ` [${r.scopes.join(', ')}]` : ''))); });
      });
      return p;
    }
    function renderOp(op) {
      const d = els.detail; d.replaceChildren();
      const h = mk('h3'); h.append(methodBadge(op.method), mk('span', 'path', op.path)); if (op.deprecated) h.append(mk('span', 'badge badge-warn', 'deprecated')); if (op.kind === 'webhook') h.append(mk('span', 'badge badge-info', 'webhook'));
      d.append(h);
      if (op.summary) d.append(mk('p', '', op.summary));
      const meta = mk('p', 'hint'); meta.textContent = [op.operationId && `operationId: ${op.operationId}`, op.tags.length && `tags: ${op.tags.join(', ')}`].filter(Boolean).join('  ·  '); if (meta.textContent) d.append(meta);
      if (op.description) d.append(renderMarkdown(op.description));
      if (op.externalDocs?.url && L.safeHref(op.externalDocs.url)) { const p = mk('p'); const a = mk('a', '', op.externalDocs.description || op.externalDocs.url); a.href = L.safeHref(op.externalDocs.url); a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; p.append(a); d.append(p); }
      const sec = securityEl(op); if (sec) { d.append(mk('h4', '', 'Security')); d.append(sec); if (op.securityInherited && op.security.length) d.append(mk('p', 'hint', 'Inherited from the document-level security.')); }
      if (op.servers?.length) { d.append(mk('h4', '', 'Servers (operation level)')); for (const s of op.servers) d.append(mk('p', '', `${s.url}${s.description ? ` - ${s.description}` : ''}`)); }
      if (op.parameters.length) {
        d.append(mk('h4', '', `Parameters (${op.parameters.length})`));
        d.append(table(['Name', 'In', 'Type', 'Required', 'Default', 'Description'], op.parameters.map(p => {
          const desc = mk('span'); desc.textContent = p.description || ''; if (p.enum) desc.append(mk('div', 'hint', `enum: ${p.enum.map(v => JSON.stringify(v)).join(' | ')}`)); if (p.deprecated) desc.append(mk('div', 'hint', 'deprecated')); if (p.unresolved) desc.append(mk('div', 'hint', `unresolved: ${p.unresolved}`));
          const nm = mk('code', '', p.name);
          return [nm, p.in, p.type || '', p.required ? 'yes' : 'no', p.default !== undefined ? JSON.stringify(p.default) : '', desc];
        })));
      }
      if (op.requestBody) {
        d.append(mk('h4', '', `Request body${op.requestBody.required ? ' (required)' : ''}`));
        if (op.requestBody.description) d.append(mk('p', '', op.requestBody.description));
        if (op.requestBody.unresolved) d.append(mk('p', 'alert alert-warn', `Unresolved: ${op.requestBody.unresolved}`));
        d.append(contentEl(op.requestBody.content, 'Request'));
      }
      if (op.responses.length) {
        d.append(mk('h4', '', 'Responses'));
        op.responses.forEach((r, i) => {
          const det = mk('details', 'oa-resp'); if (i === 0 || op.responses.length <= 3) det.open = true;
          const sum = mk('summary'); sum.append(mk('code', '', r.code), mk('span', '', r.description || '')); if (r.unresolved) sum.append(mk('span', 'badge badge-danger', r.unresolved)); det.append(sum);
          const body = mk('div', 'oa-resp-body');
          if (r.headers.length) body.append(table(['Header', 'Type', 'Description'], r.headers.map(h2 => [h2.name, h2.type, h2.description])));
          let built = false; const fill = () => { if (built) return; built = true; body.append(contentEl(r.content, `Response ${r.code}`)); };
          if (det.open) fill(); det.addEventListener('toggle', () => { if (det.open) fill(); });
          det.append(body); d.append(det);
        });
      }
    }

    // ================================================================ schemas tab
    function renderSchemaList() {
      els.slist.replaceChildren();
      const q = els.sq.value.trim().toLowerCase();
      const list = model.schemas.filter(s => !q || s.name.toLowerCase().includes(q));
      if (!list.length) { els.slist.append(mk('p', 'hint', model.schemas.length ? 'No schemas match.' : 'This document defines no schemas.')); els.slist.style.display = 'block'; return; }
      els.slist.style.display = '';
      for (const s of list.slice(0, 400)) {
        const b = mk('button', 'oa-row'); b.type = 'button'; b.dataset.name = s.name; b.append(mk('span', 'p', s.name));
        if (s.name === selectedSchema) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => selectSchema(s.name)); els.slist.append(b);
      }
      if (list.length > 400) els.slist.append(mk('p', 'hint', `Showing the first 400 of ${list.length}. Use the filter to narrow down.`));
    }
    on(els.sq, 'input', ctx.debounce(() => model && renderSchemaList(), 200));
    function selectSchema(name) {
      const s = model.schemas.find(x => x.name === name); if (!s) return;
      selectedSchema = name;
      for (const b of els.slist.querySelectorAll('.oa-row')) { if (b.dataset.name === name) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
      const d = els.sdetail; d.replaceChildren();
      d.append(mk('h3', '', name));
      const tree = L.buildSchemaTree(model.spec, { $ref: s.pointer });
      if (tree.description) d.append(renderMarkdown(tree.description));
      d.append(mk('h4', '', 'Structure')); d.append(schemaTreeEl({ $ref: s.pointer }));
      d.append(mk('h4', '', 'Example payload (generated)'));
      d.append(exampleEl({ mime: 'application/json', schema: { $ref: s.pointer }, examples: [] }));
      usage ??= L.computeUsage(model.spec);
      const used = usage.get(name) || [];
      d.append(mk('h4', '', `Used by (${used.length})`));
      if (!used.length) d.append(mk('p', 'hint', 'Not referenced anywhere in this document.'));
      else {
        const ul = mk('ul', 'oa-used');
        for (const u of used.slice(0, 200)) {
          const li = mk('li'); const b = mk('button', 'oa-link', u); b.type = 'button';
          const m = /^([A-Z]+) (.+)$/.exec(u); const sm = /^schema (.+)$/.exec(u);
          if (m) { const op = allOps().find(o => o.method === m[1] && o.path === m[2]); if (op) b.addEventListener('click', () => { switchTab('endpoints'); selectOp(op, true); }); else b.disabled = true; }
          else if (sm) b.addEventListener('click', () => selectSchema(sm[1]));
          else b.disabled = true;
          li.append(b); ul.append(li);
        }
        d.append(ul); if (used.length > 200) d.append(mk('p', 'hint', `Showing the first 200 of ${used.length}.`));
      }
    }

    // ================================================================ info tab
    function renderInfo() {
      const d = els.info; d.replaceChildren();
      const i = model.info;
      d.append(mk('h4', '', 'API'));
      d.append(mk('p', '', `${i.title}${i.version ? ` (version ${i.version})` : ''}`));
      if (i.summary) d.append(mk('p', '', i.summary));
      if (i.description) d.append(renderMarkdown(i.description));
      const link = (label, url) => { const p = mk('p'); p.append(`${label}: `); if (L.safeHref(url)) { const a = mk('a', '', url); a.href = L.safeHref(url); a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; p.append(a); } else p.append(String(url)); d.append(p); };
      if (i.termsOfService) link('Terms of service', i.termsOfService);
      if (i.contact) { const c = i.contact; d.append(mk('p', '', `Contact: ${[c.name, c.email].filter(Boolean).join(' · ')}`)); if (c.url) link('Contact URL', c.url); }
      if (i.license) { d.append(mk('p', '', `License: ${i.license.name || ''}`)); if (i.license.url) link('License URL', i.license.url); }
      if (model.externalDocs?.url) link(model.externalDocs.description || 'External documentation', model.externalDocs.url);
      d.append(mk('h4', '', 'Servers'));
      if (!model.servers.length) d.append(mk('p', 'hint', 'No servers defined (clients assume the URL the document was served from).'));
      for (const s of model.servers) {
        d.append(mk('p', '', `${s.url}${s.description ? ` - ${s.description}` : ''}`));
        if (s.variables?.length) d.append(table(['Variable', 'Default', 'Allowed values', 'Description'], s.variables.map(v => [v.name, String(v.default ?? ''), (v.enum || []).join(', '), v.description || ''])));
      }
      d.append(mk('h4', '', 'Security'));
      if (model.security.length) d.append(mk('p', '', `Global requirement: ${model.security.map(req => (req.length ? req.map(r => r.name + (r.scopes.length ? ` [${r.scopes.join(', ')}]` : '')).join(' + ') : 'none')).join(' or ')}`));
      if (!model.securitySchemes.length) d.append(mk('p', 'hint', 'No security schemes defined.'));
      for (const s of model.securitySchemes) {
        d.append(mk('p', '', `${s.name}: ${[s.type, s.scheme, s.bearerFormat, s.in && `in ${s.in}`, s.keyName && `name ${s.keyName}`, s.url].filter(Boolean).join(', ')}${s.description ? ` - ${s.description}` : ''}`));
        for (const f of s.flows || []) {
          d.append(mk('p', 'hint', `Flow ${f.name || ''}: ${[f.authorizationUrl && `authorize ${f.authorizationUrl}`, f.tokenUrl && `token ${f.tokenUrl}`].filter(Boolean).join(', ')}`));
          if (f.scopes.length) d.append(table(['Scope', 'Description'], f.scopes.map(sc => [sc.name, sc.description || ''])));
        }
      }
      if (model.tags.length) { d.append(mk('h4', '', 'Tags')); d.append(table(['Tag', 'Description'], model.tags.map(t => [t.name, t.description]))); }
    }

    // ================================================================ lint tab
    function renderLint() {
      lintCache ??= L.lintSpec(model.spec);
      const counts = { error: 0, warn: 0, info: 0 }; for (const f of lintCache) counts[f.level]++;
      els.lintCount.textContent = String(lintCache.length);
      els.lintCount.className = `badge ${counts.error ? 'badge-danger' : counts.warn ? 'badge-warn' : ''}`;
      els.lint.replaceChildren();
      els.lint.append(mk('p', '', `${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}, ${counts.info} note${counts.info === 1 ? '' : 's'}. Hints only: this is not a full schema validation.`));
      const level = els.lintLevel.value;
      const list = lintCache.filter(f => level === 'all' || f.level === level);
      if (!list.length) { els.lint.append(mk('p', 'alert alert-success', lintCache.length ? 'No findings at this level.' : 'No problems found.')); return; }
      const ul = mk('ul');
      for (const f of list.slice(0, 500)) {
        const li = mk('li'); li.append(mk('span', `badge ${f.level === 'error' ? 'badge-danger' : f.level === 'warn' ? 'badge-warn' : 'badge-info'}`, f.level === 'info' ? 'note' : f.level === 'warn' ? 'warning' : 'error'));
        const t = mk('span'); t.append(document.createTextNode(f.message)); if (f.where) t.append(mk('span', 'where', f.where)); li.append(t); ul.append(li);
      }
      els.lint.append(ul); if (list.length > 500) els.lint.append(mk('p', 'hint', `Showing the first 500 of ${list.length}.`));
    }
    on(els.lintLevel, 'change', () => model && renderLint());

    // ---- tabs
    const selectTab = initTabs($('.oa-tabs'), name => { activeTab = name; save('tab', name); });
    const switchTab = name => selectTab(name);
    const savedTab = store('tab', 'endpoints'); if (['endpoints', 'schemas', 'info', 'lint'].includes(savedTab)) selectTab(savedTab);

    // ================================================================ fetch
    on(els.fetchToggle, 'click', () => { els.fetchBox.hidden = !els.fetchBox.hidden; els.fetchToggle.setAttribute('aria-expanded', String(!els.fetchBox.hidden)); if (!els.fetchBox.hidden) els.url.focus(); });
    async function fetchSpec() {
      const v = L.validateSpecUrl(els.url.value);
      if (!v.ok) { showMessage(els.msg, 'error', v.error); return; }
      save('url', els.url.value.trim());
      fetchAbort = new AbortController(); els.fetchGo.disabled = true; els.fetchCancel.hidden = false;
      let timedOut = false; const timer = setTimeout(() => { timedOut = true; fetchAbort.abort(); }, FETCH_TIMEOUT);
      showMessage(els.msg, 'info', `Fetching ${v.url}…`);
      try {
        const res = await fetch(v.url, { signal: fetchAbort.signal, credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' } });
        if (!res.ok) throw new Error(`The server answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
        const len = Number(res.headers.get('content-length')); if (len > MAX_FETCH) throw new Error(`The document is ${formatBytes(len)}; the limit is ${formatBytes(MAX_FETCH)}.`);
        const reader = res.body?.getReader(); let text;
        if (reader) {
          const chunks = []; let total = 0;
          for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > MAX_FETCH) { fetchAbort.abort(); throw new Error(`The document is larger than ${formatBytes(MAX_FETCH)}.`); } chunks.push(value); }
          text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
        } else text = await res.text();
        if (destroyed) return;
        els.input.value = text; showMessage(els.msg, null); await load(text);
      } catch (e) {
        if (destroyed) return;
        if (e.name === 'AbortError') showMessage(els.msg, timedOut ? 'error' : 'warn', timedOut ? `The request timed out after ${FETCH_TIMEOUT / 1000} seconds.` : 'Fetch cancelled.');
        else if (e instanceof TypeError) showMessage(els.msg, 'error', 'The browser could not fetch that URL. The server may be unreachable, or it does not allow cross-origin requests (CORS). Download the file and use "Open file" instead.');
        else showMessage(els.msg, 'error', e.message);
      } finally { clearTimeout(timer); fetchAbort = null; els.fetchGo.disabled = false; els.fetchCancel.hidden = true; }
    }
    on(els.fetchGo, 'click', fetchSpec);
    on(els.url, 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fetchSpec(); } });
    on(els.fetchCancel, 'click', () => fetchAbort?.abort());

    // ================================================================ inputs
    async function loadFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE) { showMessage(els.msg, 'error', `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE)}.`); return; }
      try { const text = await readFileAsText(file); els.input.value = text; await load(text); } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }
    on($('#oa-load'), 'click', () => load(els.input.value));
    on($('#oa-upload'), 'click', async () => loadFile(await pickFile('.json,.yaml,.yml,.txt')));
    on($('#oa-clear'), 'click', () => { els.input.value = ''; model = null; els.app.hidden = true; showMessage(els.msg, null); els.input.focus(); });
    on(els.sample, 'change', () => { const s = SAMPLES[els.sample.value]; if (!s) return; const text = JSON.stringify(s, null, 2); els.input.value = text; els.sample.value = ''; load(text); });
    on(els.input, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); load(els.input.value); } });
    disposers.push(enableDrop($('#oa-drop'), loadFile));

    // ================================================================ exports
    const fileBase = () => (model?.info.title || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'api';
    on($('#oa-md'), 'click', () => { if (model) downloadFile(`${fileBase()}.md`, L.toMarkdown(model), 'text/markdown;charset=utf-8'); });
    on($('#oa-mdcopy'), 'click', () => { if (model) copyText(L.toMarkdown(model), 'Markdown copied'); });
    on($('#oa-html'), 'click', () => { if (model) downloadFile(`${fileBase()}.html`, L.toHtml(model), 'text/html;charset=utf-8'); });

    renderIcons(root);
    return () => { destroyed = true; fetchAbort?.abort(); refilter.cancel(); disposers.forEach(d => d()); };
  },
};
