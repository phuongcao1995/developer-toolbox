import { copyText, escapeHtml, debounce, renderIcons } from '../../assets/js/components/ui.js';
import { STATUS_CODES, CATEGORIES, countByCategory, searchStatus } from './data.js';

export default {
  mount(root) {
    const q = root.querySelector('#hs-q');
    const chipsBox = root.querySelector('#hs-chips');
    const list = root.querySelector('#hs-list');
    const empty = root.querySelector('#hs-empty');
    const count = root.querySelector('#hs-count');
    const state = { category: 'all', open: new Set() };

    // ---- category chips with counts ----
    const counts = countByCategory();
    const chipDefs = [['all', 'All'], ...Object.entries(CATEGORIES).map(([k, v]) => [k, k === 'unofficial' ? v : `${k} ${v}`])];
    chipsBox.innerHTML = chipDefs.map(([key, label]) =>
      `<button type="button" class="chip" data-cat="${key}"${/xx$/.test(key) ? ' title="Includes unofficial codes of this class"' : ''}>${escapeHtml(label)} <span class="hint">${counts[key]}</span></button>`).join('');
    const syncChips = () => chipsBox.querySelectorAll('.chip').forEach(c => {
      const on = c.dataset.cat === state.category;
      c.classList.toggle('active', on); c.setAttribute('aria-pressed', on);
    });

    // ---- rendering ----
    const summary = s => s.description.length > 110 ? s.description.slice(0, 107) + '…' : s.description;

    function detailHtml(s) {
      const hints = [
        s.unofficial ? '<span class="badge badge-warn">Unofficial</span>' : '<span class="badge badge-success">Standard</span>',
        `<span class="badge">${escapeHtml(CATEGORIES[s.statusClass])}</span>`,
        s.hint ? `<span class="badge badge-info">${escapeHtml(s.hint)}</span>` : '',
      ].join('');
      return `<div class="hs-detail" id="hs-detail-${s.code}" role="region" aria-labelledby="hs-head-${s.code}">
        <div class="hs-badges">${hints}</div>
        <div><h4>Description</h4><p>${escapeHtml(s.description)}</p></div>
        <div><h4>Common usage</h4><p>${escapeHtml(s.commonUsage)}</p></div>
        <div><h4>Example</h4>
          <div class="hs-line"><pre class="code-block">${escapeHtml(s.example)}</pre></div></div>
        <div><h4>Reference</h4><p>${escapeHtml(s.rfc)}</p></div>
        <div class="row">
          <button type="button" class="btn btn-sm" data-copy="line" data-code="${s.code}"><i data-lucide="copy"></i> Copy response line</button>
          <button type="button" class="btn btn-sm" data-copy="code" data-code="${s.code}"><i data-lucide="hash"></i> Copy code</button>
        </div>
      </div>`;
    }

    const itemHtml = s => {
      const open = state.open.has(s.code);
      return `<div class="hs-item${open ? ' open' : ''}" data-code="${s.code}">
          <button type="button" class="hs-head" id="hs-head-${s.code}" aria-expanded="${open}" aria-controls="hs-detail-${s.code}">
            <span class="hs-code c${s.statusClass[0]}">${s.code}</span>
            <span class="hs-title">${escapeHtml(s.title)}${s.unofficial ? ' <span class="badge badge-warn">unofficial</span>' : ''}</span>
            <span class="hs-sum">${escapeHtml(summary(s))}</span>
            <i data-lucide="chevron-right" class="hs-chev"></i>
          </button>${open ? detailHtml(s) : ''}
        </div>`;
    };

    function render() {
      const items = searchStatus(q.value, state.category);
      count.textContent = `${items.length} of ${STATUS_CODES.length} codes`;
      empty.hidden = items.length > 0;
      list.innerHTML = items.map(itemHtml).join('');
      renderIcons(list);
      syncChips();
    }

    // ---- events ----
    const onList = e => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const s = STATUS_CODES.find(x => x.code === Number(copyBtn.dataset.code));
        if (!s) return;
        if (copyBtn.dataset.copy === 'line') copyText(s.line, 'Response line copied');
        else copyText(String(s.code), 'Code copied');
        return;
      }
      const head = e.target.closest('.hs-head');
      if (!head) return;
      const code = Number(head.parentElement.dataset.code);
      // Toggle just this row in place; no full re-render (keeps focus, scroll position and other rows untouched).
      const item = head.parentElement, s = STATUS_CODES.find(x => x.code === code);
      if (state.open.has(code)) { state.open.delete(code); item.querySelector('.hs-detail')?.remove(); }
      else { state.open.add(code); head.insertAdjacentHTML('afterend', detailHtml(s)); renderIcons(item); }
      item.classList.toggle('open', state.open.has(code));
      head.setAttribute('aria-expanded', String(state.open.has(code)));
    };
    list.addEventListener('click', onList);

    chipsBox.addEventListener('click', e => {
      const c = e.target.closest('[data-cat]');
      if (!c) return;
      state.category = c.dataset.cat; render();
    });
    const onInput = debounce(render, 80);
    q.addEventListener('input', onInput);
    root.querySelector('#hs-reset').addEventListener('click', () => { q.value = ''; state.category = 'all'; render(); q.focus(); });

    // "/" focuses search unless the user is already typing somewhere
    const onKey = e => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault(); q.focus(); q.select();
    };
    document.addEventListener('keydown', onKey);

    render();
    return () => document.removeEventListener('keydown', onKey);
  },
};
