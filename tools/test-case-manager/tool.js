import {
  el, escapeHtml, icon, renderIcons, openModal, confirmDialog, toast, bindActions, downloadFile, pickFile, enableDrop,
  readFileAsText, readFileAsArrayBuffer, loadScript, formatBytes,
} from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import * as IO from './io.js';
import { openStore } from './store.js';

const PAGE_SIZE = 100;
const PREVIEW_ROWS = 100;
const XLSX_URL = new URL('../../assets/js/vendor/xlsx.full.min.js', import.meta.url).href;
const PRIORITY_BADGE = { Critical: 'badge-danger', High: 'badge-warn', Medium: 'badge-info', Low: '' };
const STATUS_CLASS = { 'Not Run': 's-notrun', Pass: 's-pass', Fail: 's-fail', Blocked: 's-blocked' };

let xlsxPromise = null;
/** SheetJS is ~1 MB, so it is fetched only when an .xlsx file is read or written. */
const loadXlsx = () => (xlsxPromise ||= loadScript(XLSX_URL).then(() => {
  if (!globalThis.XLSX) throw new Error('The Excel library did not initialise.');
  return globalThis.XLSX;
}).catch(e => { xlsxPromise = null; throw new Error(`Could not load the Excel library (${e.message})`); }));

const nowIso = () => new Date().toISOString();
const tick = () => new Promise(r => setTimeout(r, 0));
const options = (values, selected, first) =>
  (first ? `<option value="">${escapeHtml(first)}</option>` : '') +
  values.map(v => `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#tcm-' + id);
    const saved = ctx.storage.get('view', {}) || {};
    const view = {
      sort: L.SORT_KEYS.includes(saved.sort?.key) ? { key: saved.sort.key, dir: saved.sort.dir === 'desc' ? 'desc' : 'asc' } : { key: 'id', dir: 'asc' },
      q: '', status: '', priority: '', page: 1, selected: new Set(),
    };
    let cases = [], store = null, ready = false, disposed = false;
    const closers = new Set();

    $('status').innerHTML = options(L.STATUSES, '', 'All statuses');
    $('priority').innerHTML = options(L.PRIORITIES, '', 'All priorities');
    $('bulk-status').innerHTML = options(L.STATUSES, '', 'Set status…');
    $('bulk-priority').innerHTML = options(L.PRIORITIES, '', 'Set priority…');

    const saveView = () => ctx.storage.set('view', { sort: view.sort, exportFormat: saved.exportFormat, exportScope: saved.exportScope });

    // ------------------------------------------------------------ data
    const filterActive = () => !!(view.q.trim() || view.status || view.priority);
    const visible = () => L.sortCases(L.filterCases(cases, view), view.sort);
    const find = id => cases.find(c => c.id === id);

    /** Update memory (and the list on screen) first, then persist. A failed write is reported but the data stays on screen. */
    async function commit({ put = [], remove = [] }) {
      const gone = new Set(remove.map(L.idKey));
      cases = L.applyPlan(cases.filter(c => !gone.has(L.idKey(c.id))), put);
      for (const id of remove) view.selected.delete(id);
      render();
      if (!put.length && !remove.length) return;
      try { await store.apply({ put, remove }); }
      catch (e) { toast(`Could not save to this browser: ${e.message || e}`, 'error', 5000); }
    }

    // ------------------------------------------------------------ modal plumbing (modals live outside the tool root, so track them for cleanup)
    function modal(opts, width) {
      let h;
      h = openModal({ ...opts, onClose: () => { closers.delete(h.close); opts.onClose?.(); } });
      h.modal.classList.add('tcm-modal');
      if (width) h.modal.style.maxWidth = width;
      closers.add(h.close);
      renderIcons(h.modal);
      return h;
    }

    // ------------------------------------------------------------ list rendering
    function render() {
      if (!ready || disposed) return;
      const body = $('body'), all = visible();
      const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      view.page = Math.min(Math.max(1, view.page), pages);
      const slice = all.slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
      const active = document.activeElement, keepFocus = active && root.contains(active) && active.closest('#tcm-body') ? active.dataset.focusKey : null;

      if (!cases.length) {
        body.innerHTML = `<div class="empty tcm-empty"><i data-lucide="clipboard-check"></i><p><strong>No test cases yet</strong></p>
          <p>Add your first test case, or import a spreadsheet.</p>
          <div class="row tcm-empty-actions"><button class="btn btn-primary" type="button" data-action="add"><i data-lucide="plus"></i> Add test case</button>
          <button class="btn" type="button" data-action="import"><i data-lucide="upload"></i> Import</button></div></div>`;
      } else if (!all.length) {
        body.innerHTML = `<div class="empty tcm-empty"><i data-lucide="search"></i><p><strong>No test cases match</strong></p>
          <div class="row tcm-empty-actions"><button class="btn" type="button" data-action="clear-filters">Clear search and filters</button></div></div>`;
      } else {
        const allSelected = all.every(c => view.selected.has(c.id)), someSelected = all.some(c => view.selected.has(c.id));
        const th = (key, label) => {
          const on = view.sort.key === key, dir = view.sort.dir;
          return `<th class="tcm-c-${key}" aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="tcm-sort" type="button" data-action="sort" data-key="${key}" data-focus-key="sort-${key}">${label}${on ? `<i data-lucide="${dir === 'asc' ? 'arrow-up' : 'arrow-down'}"></i>` : ''}</button></th>`;
        };
        const rows = slice.map(c => {
          const id = escapeHtml(c.id);
          return `<tr data-id="${id}"${view.selected.has(c.id) ? ' class="selected"' : ''}>
            <td class="tcm-c-check"><input type="checkbox" data-select aria-label="Select ${id}"${view.selected.has(c.id) ? ' checked' : ''}></td>
            <td class="tcm-c-id mono">${id}</td>
            <td class="tcm-c-title"><button class="tcm-link" type="button" data-action="edit" title="Edit">${escapeHtml(c.title)}</button></td>
            <td class="tcm-c-priority"><span class="badge ${PRIORITY_BADGE[c.priority] || ''}">${escapeHtml(c.priority)}</span></td>
            <td class="tcm-c-status"><select class="select tcm-status ${STATUS_CLASS[c.status] || ''}" data-status data-focus-key="status-${id}" aria-label="Status of ${id}">${options(L.STATUSES, c.status)}</select></td>
            <td class="tcm-c-actions"><button class="btn btn-ghost btn-icon btn-sm" type="button" data-action="edit" aria-label="Edit ${id}" title="Edit"><i data-lucide="pencil"></i></button>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" data-action="duplicate" aria-label="Duplicate ${id}" title="Duplicate"><i data-lucide="copy"></i></button>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" data-action="delete" aria-label="Delete ${id}" title="Delete"><i data-lucide="trash-2"></i></button></td></tr>`;
        }).join('');
        body.innerHTML = `<div class="table-wrap tcm-table-wrap"><table class="table tcm-table"><thead><tr>
          <th class="tcm-c-check"><input type="checkbox" id="tcm-all" aria-label="Select all ${plural(all.length, 'matching test case')}"></th>
          ${th('id', 'ID')}${th('title', 'Title')}${th('priority', 'Priority')}${th('status', 'Status')}<th class="tcm-c-actions"><span class="sr-only">Actions</span></th>
          </tr></thead><tbody>${rows}</tbody></table></div>`;
        const head = body.querySelector('#tcm-all');
        head.checked = allSelected; head.indeterminate = someSelected && !allSelected;
      }
      renderIcons(body);
      if (keepFocus) body.querySelector(`[data-focus-key="${CSS.escape(keepFocus)}"]`)?.focus();

      const n = all.length, start = n ? (view.page - 1) * PAGE_SIZE + 1 : 0;
      $('pager').hidden = !n;
      $('count').textContent = `${start.toLocaleString('en')}–${Math.min(n, view.page * PAGE_SIZE).toLocaleString('en')} of ${plural(n, 'test case')}${filterActive() ? ` (filtered from ${cases.length.toLocaleString('en')})` : ''}`;
      $('page').textContent = pages > 1 ? `Page ${view.page} of ${pages}` : '';
      root.querySelector('[data-action="prev"]').disabled = view.page <= 1;
      root.querySelector('[data-action="next"]').disabled = view.page >= pages;
      $('pager').querySelectorAll('[data-action="prev"],[data-action="next"],#tcm-page').forEach(x => { x.hidden = pages <= 1; });

      $('bulk').hidden = !view.selected.size;
      $('selected').textContent = `${view.selected.size.toLocaleString('en')} selected`;
      root.querySelector('[data-action="export"]').disabled = !cases.length;
    }

    // ------------------------------------------------------------ add / edit
    function editCase(existing) {
      const isNew = !existing;
      const base = existing || L.makeCase({});
      const suggested = L.nextId(cases.map(c => c.id));
      const steps = [...base.steps];
      const ctl = {};
      const err = key => el('div', { class: 'tcm-err', id: `tcm-e-${key}`, role: 'alert' });
      const field = (key, label, control, extra = '') => el('div', { class: `field ${extra}` }, el('label', { for: `tcm-f-${key}` }, label), control, err(key));
      const text = (key, rows = 2) => (ctl[key] = el('textarea', { class: 'textarea', id: `tcm-f-${key}`, rows }, base[key]));
      const select = (key, values) => { ctl[key] = el('select', { class: 'select', id: `tcm-f-${key}`, html: options(values, base[key]) }); return ctl[key]; };
      ctl.id = el('input', { class: 'input mono', id: 'tcm-f-id', value: isNew ? '' : base.id, placeholder: `${suggested} (automatic)`, maxlength: L.MAX_ID_LENGTH, autocomplete: 'off', spellcheck: 'false' });
      ctl.title = el('input', { class: 'input', id: 'tcm-f-title', value: base.title, autocomplete: 'off', required: true, 'aria-required': 'true' });

      const stepsBox = el('div', { class: 'tcm-steps' });
      const drawSteps = focusIndex => {
        stepsBox.replaceChildren(...steps.map((s, i) => {
          const btn = (name, label, disabled, fn) => el('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `${label} ${i + 1}`, title: label, disabled, onclick: fn, html: icon(name) });
          return el('div', { class: 'tcm-step' },
            el('span', { class: 'tcm-step-n', 'aria-hidden': 'true' }, String(i + 1)),
            el('textarea', { class: 'textarea', rows: 2, 'aria-label': `Step ${i + 1}`, oninput: e => { steps[i] = e.target.value; } }, s),
            el('div', { class: 'tcm-step-btns' },
              btn('arrow-up', 'Move step up', i === 0, () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; drawSteps(i - 1); }),
              btn('arrow-down', 'Move step down', i === steps.length - 1, () => { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; drawSteps(i + 1); }),
              btn('trash-2', 'Remove step', false, () => { steps.splice(i, 1); drawSteps(Math.min(i, steps.length - 1)); })));
        }));
        renderIcons(stepsBox);
        if (focusIndex != null && focusIndex >= 0) stepsBox.querySelectorAll('textarea')[focusIndex]?.focus();
      };
      drawSteps();

      const body = el('form', { class: 'tcm-form', novalidate: true, onsubmit: e => e.preventDefault() },
        el('div', { class: 'tcm-grid3' }, field('id', isNew ? 'Test case ID' : 'Test case ID *', ctl.id), field('priority', 'Priority', select('priority', L.PRIORITIES)), field('status', 'Status', select('status', L.STATUSES))),
        field('title', 'Title *', ctl.title),
        field('description', 'Description / objective', text('description')),
        field('preconditions', 'Preconditions', text('preconditions')),
        el('div', { class: 'field' }, el('span', { class: 'label', id: 'tcm-steps-label' }, 'Test steps'), stepsBox,
          el('button', { class: 'btn btn-sm tcm-add-step', type: 'button', onclick: () => { steps.push(''); drawSteps(steps.length - 1); }, html: `${icon('plus')} Add step` }), err('steps')),
        field('expected', 'Expected results', text('expected')),
        field('actual', 'Actual results', text('actual')),
        el('div', { class: 'tcm-grid2' }, field('testData', 'Test data', text('testData')), field('notes', 'Notes / comments', text('notes'))));

      const save = () => {
        const c = L.makeCase({
          id: ctl.id.value.trim() || (isNew ? suggested : ''), title: ctl.title.value, description: ctl.description.value, preconditions: ctl.preconditions.value,
          steps, expected: ctl.expected.value, actual: ctl.actual.value, status: ctl.status.value, priority: ctl.priority.value,
          testData: ctl.testData.value, notes: ctl.notes.value, createdAt: base.createdAt, updatedAt: nowIso(),
        });
        const errors = L.validateCase(c, cases.filter(o => o !== existing));
        body.querySelectorAll('.tcm-err').forEach(n => { n.textContent = ''; });
        body.querySelectorAll('[aria-invalid]').forEach(n => n.removeAttribute('aria-invalid'));
        for (const e of errors) {
          const box = body.querySelector(`#tcm-e-${e.field}`); if (box) box.textContent = e.message;
          ctl[e.field]?.setAttribute('aria-invalid', 'true');
        }
        if (errors.length) { (ctl[errors[0].field] || ctl.title).focus(); return false; }
        commit({ put: [c], remove: existing && existing.id !== c.id ? [existing.id] : [] });
        toast(isNew ? `Added ${c.id}` : `Saved ${c.id}`, 'success');
        return true;
      };
      modal({ title: isNew ? 'Add test case' : `Edit ${base.id}`, body, actions: [{ label: 'Cancel' }, { label: isNew ? 'Add' : 'Save', primary: true, onClick: () => save() || false }] }, '760px');
    }

    async function deleteCases(list) {
      if (!list.length) return;
      const one = list.length === 1;
      const ok = await confirmDialog(one ? 'Delete test case' : `Delete ${list.length} test cases`,
        one ? `Delete “${list[0].title}” (${list[0].id})? This cannot be undone.` : `Delete ${list.length} selected test cases? This cannot be undone.`, 'Delete');
      if (!ok || disposed) return;
      await commit({ remove: list.map(c => c.id) });
      toast(one ? `Deleted ${list[0].id}` : `Deleted ${list.length} test cases`, 'success');
    }

    function patchSelected(patch) {
      const list = cases.filter(c => view.selected.has(c.id));
      if (!list.length) return;
      const t = nowIso();
      commit({ put: list.map(c => ({ ...c, ...patch, updatedAt: t })) });
      toast(`Updated ${plural(list.length, 'test case')}`, 'success');
    }

    // ------------------------------------------------------------ export
    function openExport(scope) {
      const sorted = L.sortCases(cases, view.sort);
      const sets = {
        all: sorted,
        filtered: visible(),
        selected: sorted.filter(c => view.selected.has(c.id)),
      };
      const initial = scope || (sets.selected.length ? 'selected' : filterActive() ? 'filtered' : 'all');
      const radio = (value, label) => el('label', { class: 'check' },
        el('input', { type: 'radio', name: 'tcm-scope', value, checked: value === initial, disabled: !sets[value].length }), ` ${label} (${sets[value].length.toLocaleString('en')})`);
      const format = el('select', { class: 'select', id: 'tcm-x-format', 'aria-label': 'File format' },
        ...Object.entries(IO.FORMATS).map(([v, l]) => el('option', { value: v, selected: v === (IO.FORMATS[saved.exportFormat] ? saved.exportFormat : 'xlsx') }, l)));
      const msg = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
      const go = el('button', { class: 'btn btn-primary', type: 'button' }, 'Export');
      const body = el('div', { class: 'stack' },
        el('div', { class: 'field' }, el('label', { for: 'tcm-x-format' }, 'Format'), format),
        el('fieldset', { class: 'tcm-scope' }, el('legend', { class: 'label' }, 'Test cases to export'), radio('all', 'All'), radio('filtered', 'Current search and filters'), radio('selected', 'Selected')),
        el('p', { class: 'hint' }, 'The file name includes the date and time. Test steps are exported as numbered lines (JSON keeps them as a list).'),
        msg,
        el('div', { class: 'tcm-foot' }, el('button', { class: 'btn', type: 'button', onclick: () => h.close() }, 'Cancel'), go));
      const h = modal({ title: 'Export test cases', body }, '480px');
      go.addEventListener('click', async () => {
        const chosen = body.querySelector('input[name="tcm-scope"]:checked')?.value;
        const list = sets[chosen] || [];
        if (!list.length) { msg.hidden = false; msg.textContent = 'There are no test cases to export for that choice.'; return; }
        const fmt = format.value;
        go.classList.add('loading'); go.disabled = true; msg.hidden = true;
        try {
          const XLSX = fmt === 'xlsx' ? await loadXlsx() : null;
          await tick();
          const out = IO.buildExport(fmt, list, { XLSX });
          downloadFile(out.name, typeof out.data === 'string' ? out.data : new Blob([out.data], { type: out.mime }), out.mime);
          saved.exportFormat = fmt; saved.exportScope = chosen; saveView();
          toast(`Exported ${plural(list.length, 'test case')} to ${out.name}`, 'success');
          h.close();
        } catch (e) {
          go.classList.remove('loading'); go.disabled = false;
          msg.hidden = false; msg.textContent = `Export failed: ${e.message || e}`;
        }
      });
    }

    // ------------------------------------------------------------ import wizard
    async function downloadTemplate(fmt) {
      try {
        const XLSX = fmt === 'xlsx' ? await loadXlsx() : null;
        const out = IO.buildExport(fmt, IO.SAMPLE_CASES.map(c => L.makeCase(c)), { XLSX, base: 'test-cases-template' });
        downloadFile(`test-cases-template.${fmt}`, typeof out.data === 'string' ? out.data : new Blob([out.data], { type: out.mime }), out.mime);
      } catch (e) { toast(e.message || String(e), 'error', 5000); }
    }

    function openImport() {
      const box = el('div', { class: 'tcm-wizard stack' });
      const h = modal({ title: 'Import test cases', body: box }, '940px');
      let table = null, mapping = {}, mode = 'skip', records = [], plan = null, onlyProblems = true, fileName = '';

      const loading = text => box.replaceChildren(el('div', { class: 'loading-block' }, el('span', { class: 'spinner' }), text));
      const foot = (...btns) => el('div', { class: 'tcm-foot' }, ...btns);
      const stat = (label, value, cls = '') => el('div', { class: `tcm-stat ${cls}` }, el('strong', {}, value.toLocaleString('en')), el('span', {}, label));
      const colName = i => (table.headers[i] ? table.headers[i] : `Column ${i + 1}`);

      // -------- step 1: choose a file
      function stepPick(error) {
        const choose = async () => { const f = await pickFile('.xlsx,.csv,.json'); if (f) handleFile(f); };
        const drop = el('div', { class: 'tcm-drop', tabindex: '0', role: 'button', 'aria-label': 'Choose a file to import, or drop one here', onclick: choose,
          onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } } },
        el('div', { html: icon('upload') }), el('p', {}, 'Drop an Excel, CSV or JSON file here'),
        el('span', { class: 'btn btn-primary' }, 'Choose file'));
        enableDrop(drop, handleFile);
        const tpl = fmt => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => downloadTemplate(fmt) }, IO.FORMATS[fmt]);
        box.replaceChildren(drop,
          error ? el('div', { class: 'alert alert-error', role: 'alert' }, error) : null,
          el('div', { class: 'row tcm-tpl' }, el('span', { class: 'hint' }, 'Need a starting point? Download a sample:'), tpl('xlsx'), tpl('csv'), tpl('json')),
          el('p', { class: 'hint' }, `Columns are matched by name (ID, Title, Steps, Expected Results, Status, Priority…) and you can adjust the mapping before anything is saved. Up to ${IO.MAX_IMPORT_ROWS.toLocaleString('en')} rows or ${formatBytes(IO.MAX_IMPORT_BYTES)}.`));
        renderIcons(box);
        drop.focus();
      }

      async function handleFile(file) {
        loading(`Reading ${file.name}…`);
        await tick();
        try {
          const ext = IO.fileExtension(file.name);
          if (!['xlsx', 'csv', 'json'].includes(ext)) throw new IO.ImportError(`Unsupported file type ".${ext || '?'}". Use .xlsx, .csv or .json.`);
          if (file.size > IO.MAX_IMPORT_BYTES) throw new IO.ImportError(`This file is ${formatBytes(file.size)}; the limit is ${formatBytes(IO.MAX_IMPORT_BYTES)}.`);
          let content, XLSX = null;
          if (ext === 'xlsx') [content, XLSX] = await Promise.all([readFileAsArrayBuffer(file), loadXlsx()]);
          else content = await readFileAsText(file);
          await tick();
          table = IO.parseImport(file.name, content, XLSX);
          fileName = file.name; mapping = L.autoMap(table.headers); mode = 'skip';
          recompute(); onlyProblems = problemCount() > 0;
          stepReview();
        } catch (e) { if (!disposed) stepPick(e instanceof IO.ImportError || e.message ? e.message : String(e)); }
      }

      const recompute = () => {
        records = L.buildRecords(table.headers, table.rows, table.rowNumbers, mapping);
        plan = L.planImport(records, cases, mode);
      };
      const problemCount = () => records.filter(r => r.errors.length || r.dup).length;

      // -------- step 2: map columns, preview, validate
      function stepReview() {
        const unit = table.unit.toLowerCase();
        const mapGrid = el('div', { class: 'tcm-mapgrid' }, ...L.FIELDS.map(f => el('div', { class: 'field' },
          el('label', { for: `tcm-m-${f.key}` }, f.label + (f.required ? ' *' : '')),
          el('select', { class: 'select', id: `tcm-m-${f.key}`, 'data-key': f.key,
            html: `<option value="-1">— not mapped —</option>${table.headers.map((_, i) => `<option value="${i}"${mapping[f.key] === i ? ' selected' : ''}>${escapeHtml(colName(i))}</option>`).join('')}` }))));
        const mapSummary = el('summary', {});
        const mapBox = el('details', { class: 'tcm-map' }, mapSummary, mapGrid);
        const dupSelect = el('select', { class: 'select', id: 'tcm-dup', html: L.DUP_MODES.map(m => `<option value="${m.value}"${m.value === mode ? ' selected' : ''}>${m.label}</option>`).join('') });
        const stats = el('div', { class: 'tcm-stats' });
        const filterBox = el('input', { type: 'checkbox', id: 'tcm-only', checked: onlyProblems });
        const preview = el('div', { class: 'table-wrap tcm-preview' });
        const importBtn = el('button', { class: 'btn btn-primary', type: 'button' });

        const refresh = () => {
          const s = plan.summary, matched = L.FIELDS.filter(f => mapping[f.key] >= 0).length;
          mapSummary.textContent = `Column mapping — ${matched} of ${L.FIELDS.length} fields matched`;
          if (mapping.title < 0) mapBox.open = true;
          const dups = records.filter(r => r.dup).length;
          stats.replaceChildren(stat(`${unit}s`, s.total), stat('ready', s.total - s.failed - dups, 'ok'), stat('with errors', s.failed, s.failed ? 'bad' : ''), stat('duplicate IDs', dups, dups ? 'warn' : ''));
          const shown = records.filter(r => !onlyProblems || r.errors.length || r.dup);
          const rows = shown.slice(0, PREVIEW_ROWS).map(r => {
            const dupText = r.dup ? `Duplicate ID (${r.dup === 'existing' ? 'already in your list' : 'repeated in this file'}) → ${{ skip: 'will be skipped', overwrite: 'will overwrite', new: 'gets a new ID' }[mode]}` : '';
            const result = r.errors.length
              ? r.errors.map(e => `<div class="tcm-bad"><strong>${escapeHtml(e.column)}</strong>: ${escapeHtml(e.message)}</div>`).join('')
              : r.dup ? `<div class="tcm-warn">${escapeHtml(dupText)}</div>`
                : `<span class="tcm-ok">Ready${r.hasId ? '' : ' · ID generated'}</span>`;
            return `<tr class="${r.errors.length ? 'tcm-row-bad' : ''}"><td>${r.row}</td><td class="mono">${escapeHtml(r.case.id || '—')}</td><td>${escapeHtml(r.case.title || '—')}</td>
              <td>${escapeHtml(r.case.priority)}</td><td>${escapeHtml(r.case.status)}</td><td>${result}</td></tr>`;
          }).join('');
          preview.innerHTML = shown.length
            ? `<table class="table"><thead><tr><th>${escapeHtml(table.unit)}</th><th>ID</th><th>Title</th><th>Priority</th><th>Status</th><th>Check</th></tr></thead><tbody>${rows}</tbody></table>`
            + (shown.length > PREVIEW_ROWS ? `<p class="hint tcm-more">Showing the first ${PREVIEW_ROWS} of ${shown.length.toLocaleString('en')}.</p>` : '')
            : `<p class="hint tcm-more">${onlyProblems ? 'No problems found.' : 'Nothing to import: no rows were recognised. Check the column mapping.'}</p>`;
          const n = s.added + s.overwritten;
          importBtn.textContent = n ? `Import ${plural(n, 'test case')}` : 'Nothing to import';
          importBtn.disabled = !n;
        };
        mapGrid.addEventListener('change', e => { mapping[e.target.dataset.key] = Number(e.target.value); recompute(); refresh(); });
        dupSelect.addEventListener('change', () => { mode = dupSelect.value; recompute(); refresh(); });
        filterBox.addEventListener('change', () => { onlyProblems = filterBox.checked; refresh(); });
        importBtn.addEventListener('click', doImport);

        box.replaceChildren(
          el('div', { class: 'row tcm-fileline' }, el('strong', {}, fileName), el('span', { class: 'hint' }, `${table.sheetName ? `Sheet “${table.sheetName}” · ` : ''}${plural(table.rows.length, unit)}`),
            el('span', { class: 'spacer' }), el('button', { class: 'btn btn-sm', type: 'button', onclick: () => stepPick() }, 'Change file')),
          mapBox, stats,
          el('div', { class: 'row tcm-options' }, el('div', { class: 'field tcm-dup' }, el('label', { for: 'tcm-dup' }, 'If an ID already exists'), dupSelect),
            el('label', { class: 'check' }, filterBox, ' Show only rows with problems')),
          preview,
          foot(el('button', { class: 'btn', type: 'button', onclick: () => h.close() }, 'Cancel'), importBtn));
        refresh();
      }

      // -------- step 3: summary
      async function doImport() {
        const final = L.planImport(records, cases, mode);
        loading(`Importing ${plural(final.summary.added + final.summary.overwritten, 'test case')}…`);
        await tick();
        await commit({ put: final.put });
        if (!disposed) stepDone(final);
      }

      function stepDone(p) {
        const s = p.summary, imported = s.added + s.overwritten;
        const fails = p.failures.slice(0, PREVIEW_ROWS).map(f => `<tr><td>${f.row}</td><td>${f.errors.map(e => `<div class="tcm-bad"><strong>${escapeHtml(e.column)}</strong>: ${escapeHtml(e.message)}</div>`).join('')}</td></tr>`).join('');
        box.replaceChildren(
          el('div', { class: `alert ${imported ? 'alert-success' : 'alert-warn'}`, role: 'status' }, imported ? `Imported ${plural(imported, 'test case')}.` : 'No test cases were imported.'),
          el('div', { class: 'tcm-stats' }, stat('total', s.total), stat('added', s.added, 'ok'), stat('overwritten', s.overwritten, s.overwritten ? 'ok' : ''), stat('skipped', s.skipped, s.skipped ? 'warn' : ''), stat('failed', s.failed, s.failed ? 'bad' : '')),
          p.failures.length ? el('div', { class: 'stack' }, el('strong', {}, 'Rows that were not imported'),
            el('div', { class: 'table-wrap tcm-preview', html: `<table class="table"><thead><tr><th>${escapeHtml(table.unit)}</th><th>Problem</th></tr></thead><tbody>${fails}</tbody></table>${p.failures.length > PREVIEW_ROWS ? `<p class="hint tcm-more">Showing the first ${PREVIEW_ROWS} of ${p.failures.length.toLocaleString('en')}.</p>` : ''}` })) : null,
          foot(el('button', { class: 'btn', type: 'button', onclick: () => stepPick() }, 'Import another file'), el('button', { class: 'btn btn-primary', type: 'button', onclick: () => h.close() }, 'Done')));
      }

      stepPick();
    }

    // ------------------------------------------------------------ events
    const onSearch = ctx.debounce(() => { view.q = $('q').value; view.page = 1; render(); }, 150);
    $('q').addEventListener('input', onSearch);
    for (const k of ['status', 'priority']) $(k).addEventListener('change', () => { view[k] = $(k).value; view.page = 1; render(); });
    $('bulk-status').addEventListener('change', e => { if (e.target.value) patchSelected({ status: e.target.value }); e.target.value = ''; });
    $('bulk-priority').addEventListener('change', e => { if (e.target.value) patchSelected({ priority: e.target.value }); e.target.value = ''; });

    root.addEventListener('change', e => {
      const t = e.target, tr = t.closest('tr[data-id]');
      if (t.id === 'tcm-all') {
        for (const c of visible()) (t.checked ? view.selected.add(c.id) : view.selected.delete(c.id));
        render();
      } else if (t.matches('[data-select]') && tr) {
        const id = tr.dataset.id;
        if (t.checked) view.selected.add(id); else view.selected.delete(id);
        render();
        body().querySelector(`tr[data-id="${CSS.escape(id)}"] [data-select]`)?.focus();
      } else if (t.matches('[data-status]') && tr) {
        const c = find(tr.dataset.id);
        if (c && c.status !== t.value) commit({ put: [{ ...c, status: t.value, updatedAt: nowIso() }] });
      }
    });
    const body = () => $('body');

    bindActions(root, {
      add: () => editCase(null),
      import: () => openImport(),
      export: () => openExport(),
      'export-selected': () => openExport('selected'),
      'delete-selected': () => deleteCases(cases.filter(c => view.selected.has(c.id))),
      'clear-selection': () => { view.selected.clear(); render(); },
      'clear-filters': () => { view.q = view.status = view.priority = ''; $('q').value = ''; $('status').value = ''; $('priority').value = ''; view.page = 1; render(); },
      prev: () => { view.page--; render(); },
      next: () => { view.page++; render(); },
      sort: (e, b) => {
        const key = b.dataset.key;
        view.sort = view.sort.key === key ? { key, dir: view.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
        saveView(); render();
      },
      edit: (e, b) => { const c = find(b.closest('tr')?.dataset.id); if (c) editCase(c); },
      duplicate: (e, b) => {
        const c = find(b.closest('tr')?.dataset.id); if (!c) return;
        const d = L.duplicateCase(c, cases.map(x => x.id));
        commit({ put: [d] });
        toast(`Duplicated as ${d.id}`, 'success');
      },
      delete: (e, b) => { const c = find(b.closest('tr')?.dataset.id); if (c) deleteCases([c]); },
    });

    // ------------------------------------------------------------ start
    (async () => {
      try {
        store = await openStore();
        cases = (await store.all()).map(c => L.makeCase(c));
      } catch (e) {
        $('body').innerHTML = '';
        $('note').hidden = false; $('note').textContent = `Could not load saved test cases: ${e.message || e}`;
        return;
      }
      if (disposed) { store.close(); return; }
      ready = true;
      if (!store.persistent) {
        $('note').hidden = false;
        $('note').textContent = 'Your browser is blocking local storage, so test cases are kept in memory only and will be lost when you leave this page. Export them to keep a copy.';
      }
      render();
    })();

    return () => { disposed = true; closers.forEach(close => close()); store?.close(); };
  },
};
