import { el, toast, confirmDialog, openModal, pickFile, readFileAsText, downloadFile, bindActions, renderIcons } from '../../assets/js/components/ui.js';
import { importJSON, sampleCV, validate, sectionHasContent, SECTION_IDS, FONTS } from './model.js';
import { renderCV } from './render.js';
import { TEMPLATES, LEVELS, STYLES, getTemplate, allCSS } from './templates.js';
import { createStore } from './store.js';
import { buildForm } from './forms.js';
import { printCV, buildDocument, asText, asJSON, fileBase } from './export.js';

const SWATCHES = ['#1d4ed8', '#0e7490', '#0f766e', '#16a34a', '#b45309', '#e11d48', '#6d28d9', '#334155'];
const PAGE_PX = 297 * 96 / 25.4; // A4 height in CSS px
const PAPER_W = 210 * 96 / 25.4;

const isEmptyCV = cv => !cv.personal.name && !cv.personal.title && !SECTION_IDS.some(id => sectionHasContent(cv, id));

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const store = createStore(ctx.storage);
    let cv = store.load();
    
    const css = el('style', {}, allCSS());
    root.append(css);

    const paper = $('cvb-paper'), sizer = $('cvb-sizer'), scroll = $('cvb-scroll'), form = $('cvb-form');

    // ---------- preview ----------
    const previewData = () => (isEmptyCV(cv) ? { ...sampleCV(), settings: cv.settings } : cv);
    let lastScale = 1;
    function fit() {
      const sheet = paper.firstElementChild;
      if (!sheet) return;
      const avail = scroll.clientWidth - 24;
      const scale = Math.min(1, Math.max(0.2, avail / PAPER_W));
      lastScale = scale;
      paper.style.transform = `scale(${scale})`;
      sizer.style.width = Math.round(PAPER_W * scale) + 'px';
      sizer.style.height = Math.round(sheet.offsetHeight * scale) + 'px';
    }
    function renderPreview() {
      const data = previewData();
      paper.innerHTML = renderCV(data);
      // Approximate page-break guides (real pagination is decided by the printer).
      const h = paper.firstElementChild.offsetHeight;
      const pages = Math.max(1, Math.ceil((h - 3) / PAGE_PX));
      for (let k = 1; k < pages; k++) paper.append(el('div', { class: 'cvb-break', style: `top:${Math.round(k * PAGE_PX)}px`, 'aria-hidden': 'true' }, el('span', {}, `Page ${k + 1}`)));
      $('cvb-pages').textContent = `A4 · ≈ ${pages} page${pages === 1 ? '' : 's'}`;
      $('cvb-example').hidden = !isEmptyCV(cv);
      const issues = validate(cv).filter(i => !(i.path === 'personal.name' && isEmptyCV(cv)));
      const ib = $('cvb-issues');
      ib.hidden = !issues.length;
      ib.textContent = `${issues.length} issue${issues.length === 1 ? '' : 's'}`;
      ib._issues = issues;
      fit();
    }
    const renderSoon = ctx.debounce(renderPreview, 60);

    // ---------- persistence ----------
    const flush = () => {
      saveNow.cancel?.();
      const ok = store.save(cv);
            const st = $('cvb-saved');
      if (st) { st.textContent = ok ? 'Saved' : 'Could not save (storage full)'; st.classList.toggle('cvb-err', !ok); }
    };
    const saveNow = ctx.debounce(flush, 400);
    const changed = () => { $('cvb-saved').textContent = 'Saving…'; saveNow(); renderSoon(); };

    // ---------- toolbar state ----------
    const fontSel = $('cvb-font');
    for (const [v, l] of Object.entries(FONTS)) fontSel.append(el('option', { value: v }, l));
    const sw = $('cvb-swatches');
    for (const c of SWATCHES) sw.append(el('button', { type: 'button', class: 'cvb-sw', style: `background:${c}`, 'aria-label': `Accent ${c}`, 'data-color': c }));
    function syncToolbar() {
      const s = cv.settings, tpl = getTemplate(s.template);
      $('cvb-tpl-name').textContent = tpl.name;
      $('cvb-color').value = s.color || tpl.accent;
      fontSel.value = s.font;
      $('cvb-size').value = s.size; $('cvb-size-out').textContent = s.size + ' pt';
      $('cvb-density').value = s.density;
      sw.querySelectorAll('.cvb-sw').forEach(b => b.setAttribute('aria-pressed', String((s.color || tpl.accent).toLowerCase() === b.dataset.color)));
    }
    function syncVersions() {
      const sel = $('cvb-version');
      sel.replaceChildren(...store.list().map(v => el('option', { value: v.id }, v.name)));
      sel.value = store.active;
    }
    const rebuildForm = () => buildForm(form, cv, { onChange: changed, rebuild: rebuildForm });
    function loadActive() { cv = store.load(); syncVersions(); syncToolbar(); rebuildForm(); renderPreview(); $('cvb-saved').textContent = ''; }

    $('cvb-version').addEventListener('change', e => { flush(); store.select(e.target.value); loadActive(); });
    const setSetting = (k, v) => { cv.settings[k] = v; syncToolbar(); changed(); };
    $('cvb-color').addEventListener('input', e => setSetting('color', e.target.value));
    sw.addEventListener('click', e => { const b = e.target.closest('.cvb-sw'); if (b) setSetting('color', b.dataset.color); });
    fontSel.addEventListener('change', () => setSetting('font', fontSel.value));
    $('cvb-size').addEventListener('input', e => setSetting('size', Number(e.target.value)));
    $('cvb-density').addEventListener('change', e => setSetting('density', e.target.value));

    // Close popovers on outside click / Escape.
    const onDocClick = e => root.querySelectorAll('.cvb-pop[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
    const onKey = e => { if (e.key === 'Escape') root.querySelectorAll('.cvb-pop[open]').forEach(d => { d.open = false; d.querySelector('summary')?.focus(); }); };
    document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey);
    const closePops = () => root.querySelectorAll('.cvb-pop[open]').forEach(d => { d.open = false; });

    // ---------- version actions ----------
    const askName = (title, value) => new Promise(res => {
      const input = el('input', { class: 'input', value, 'aria-label': 'Name', maxlength: '60' });
      let out = null;
      const m = openModal({ title, body: input, onClose: () => res(out), actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { out = input.value.trim() || null; } }] });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { out = input.value.trim() || null; m.close(); } });
      input.select();
    });
    const activeName = () => store.list().find(v => v.id === store.active)?.name || 'CV';

    // ---------- template gallery ----------
    function openGallery() {
      let level = 'all', style = 'all', compare = false;
      const picks = [];
      const body = el('div', { class: 'cvb-gal' });
      const modalRef = openModal({ title: 'Choose a template', body, onClose: () => {} });
      modalRef.modal.classList.add('cvb-gal-modal');
      const data = () => (isEmptyCV(cv) ? sampleCV() : cv);
      const thumb = (t, scale = 0.27) => {
        const d = { ...data(), settings: { ...cv.settings, template: t.id } };
        const box = el('div', { class: 'cvb-thumb', style: `width:${Math.round(PAPER_W * scale)}px;height:${Math.round(PAGE_PX * scale)}px` });
        const inner = el('div', { class: 'cvb-thumb-in', 'aria-hidden': 'true', style: `transform:scale(${scale})` });
        inner.innerHTML = renderCV(d, t.id);
        box.append(inner);
        return box;
      };
      const chipRow = (items, cur, onPick, label) => el('div', { class: 'cvb-chiprow', role: 'group', 'aria-label': label },
        items.map(([id, text]) => el('button', { type: 'button', class: `btn btn-sm ${cur() === id ? 'active' : ''}`, 'aria-pressed': String(cur() === id), onclick: () => { onPick(id); draw(); } }, text)));
      function draw() {
        body.replaceChildren();
        body.append(
          chipRow([['all', 'All levels'], ...LEVELS.map(l => [l.id, l.label])], () => level, v => { level = v; }, 'Career level'),
          chipRow([['all', 'All styles'], ...STYLES.map(s => [s, s])], () => style, v => { style = v; }, 'Design style'),
          el('label', { class: 'check cvb-cmp' }, el('input', { type: 'checkbox', checked: compare ? '' : null, onchange: e => { compare = e.target.checked; picks.length = 0; draw(); } }), ' Compare two templates'));
        if (compare && picks.length) {
          const row = el('div', { class: 'cvb-compare' });
          for (const id of picks) {
            const t = getTemplate(id);
            row.append(el('figure', {}, thumb(t, 0.42), el('figcaption', {}, el('strong', {}, t.name), el('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => { choose(t.id); } }, 'Use'))));
          }
          body.append(row);
        }
        const grid = el('div', { class: 'cvb-tgrid' });
        for (const t of TEMPLATES) {
          if ((level !== 'all' && t.level !== level) || (style !== 'all' && t.style !== style)) continue;
          const selected = compare ? picks.includes(t.id) : cv.settings.template === t.id;
          const card = el('button', { type: 'button', class: `cvb-tcard ${selected ? 'is-on' : ''}`, 'aria-pressed': String(selected), 'aria-label': `${t.name}, ${t.level} level, ${t.style} style${t.ats ? ', ATS friendly' : ''}`,
            onclick: () => {
              if (!compare) return choose(t.id);
              const i = picks.indexOf(t.id);
              if (i >= 0) picks.splice(i, 1); else { picks.push(t.id); if (picks.length > 2) picks.shift(); }
              draw();
            } },
            thumb(t),
            el('span', { class: 'cvb-tname' }, t.name, t.ats ? el('span', { class: 'cvb-ats', title: 'Single-column, plain text order: reads cleanly in applicant tracking systems' }, 'ATS') : null),
            el('span', { class: 'cvb-tmeta' }, `${LEVELS.find(l => l.id === t.level).label} · ${t.style}`),
            el('span', { class: 'cvb-tblurb' }, t.blurb));
          grid.append(card);
        }
        if (!grid.children.length) grid.append(el('p', { class: 'cvb-none' }, 'No template matches both filters.'));
        body.append(grid);
      }
      function choose(id) { setSetting('template', id); renderPreview(); modalRef.close(); }
      draw();
    }

    // ---------- actions ----------
    const requireContent = () => { if (isEmptyCV(cv)) { toast('Add some content first', 'warn'); return false; } return true; };
    const actions = {
      templates: openGallery,
      'color-reset': () => setSetting('color', ''),
      'view-edit': () => setView('edit'),
      'view-preview': () => setView('preview'),
      async 'ver-new'() { const n = await askName('New CV', 'My CV'); if (!n) return; flush(); store.create(n); loadActive(); },
      'ver-dup'() { flush(); store.duplicate(); loadActive(); toast('Duplicated', 'success'); },
      async 'ver-rename'() { const n = await askName('Rename CV', activeName()); if (n) { store.rename(store.active, n); syncVersions(); } },
      async 'ver-del'() {
        if (store.list().length <= 1) return toast('Keep at least one CV', 'warn');
        if (await confirmDialog('Delete CV', `Delete "${activeName()}"? This cannot be undone.`, 'Delete')) { store.remove(store.active); loadActive(); }
      },
      async pdf() {
        closePops();
        if (!requireContent()) return;
        flush();
        try { await printCV(cv); toast('Choose "Save as PDF", paper A4, margins None, and turn off headers and footers.', 'info', 7000); }
        catch { toast('Could not open the print dialog', 'error'); }
      },
      'export-json'() { closePops(); if (requireContent()) downloadFile(fileBase(cv) + '.json', asJSON(cv), 'application/json'); },
      'export-text'() { closePops(); if (requireContent()) downloadFile(fileBase(cv) + '.txt', asText(cv)); },
      'export-html'() { closePops(); if (requireContent()) downloadFile(fileBase(cv) + '.html', buildDocument(cv), 'text/html;charset=utf-8'); },
      async import() {
        closePops();
        const f = await pickFile('.json,application/json');
        if (!f) return;
        try {
          const imported = importJSON(await readFileAsText(f));
          flush(); store.create((imported.personal.name || f.name.replace(/\.json$/i, '') || 'Imported') + ' (imported)', imported); loadActive();
          toast('Imported as a new CV', 'success');
        } catch (e) { toast(e.message || 'Import failed', 'error'); }
      },
      example() { closePops(); flush(); const s = sampleCV(); s.settings = { ...cv.settings }; store.create('Example CV', s); loadActive(); },
      issues(e, btn) {
        const list = btn._issues || [];
        openModal({ title: 'Things to check', body: el('ul', { class: 'cvb-issue-list' }, list.map(i => el('li', {}, i.message))), actions: [{ label: 'Close', primary: true }] });
      },
    };
    bindActions(root, actions);

    function setView(v) {
      $('cvb').dataset.view = v;
      root.querySelectorAll('.cvb-tabs .btn').forEach(b => { const on = b.dataset.action === 'view-' + v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
      if (v === 'preview') requestAnimationFrame(fit);
    }

    // ---------- start ----------
    syncVersions(); syncToolbar(); rebuildForm(); renderPreview();
    renderIcons(root);
    const ro = new ResizeObserver(() => fit());
    ro.observe(scroll);
    const onHide = () => flush();
    window.addEventListener('pagehide', onHide);

    return () => {
      flush();
      ro.disconnect();
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onHide);
      saveNow.cancel?.(); renderSoon.cancel?.();
    };
  },
};
