/**
 * Folio — page header and footer.
 *
 * The editor is one continuous flow, so the header is shown once at the top of the first page and the footer once at the bottom of
 * the last page. In the saved .docx they are real Word headers and footers, so Word repeats them on every page and fills in
 * page-number fields (the chips inserted by "Page number" / "Pages").
 *
 * Each region is a small contenteditable box with its own mini toolbar (bold, italic, underline, alignment, page number).
 * Pasted content is reduced to plain text, so nothing unsafe can enter through here.
 */
(function (Folio) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let header, footer, bar, active = null, onChange = () => {};

  const FIELD_HTML = (name, label) =>
    `<span class="fld" data-field="${name}" contenteditable="false" title="${label}: Word fills this in on every page">1</span>`;

  const isEmpty = (el) => el.textContent.replace(/[\s​]/g, '') === '' && !el.querySelector('.fld, img, table');

  /** Browsers leave a stray <br> or <div> behind after deleting; clear it so the placeholder shows again. */
  function normalize(el) {
    if (isEmpty(el)) el.innerHTML = '';
  }

  function positionBar() {
    if (!active || bar.hidden) return;
    const r = active.getBoundingClientRect();
    const barH = bar.offsetHeight || 32;
    const top = r.top - barH - 6 >= 48 ? r.top - barH - 6 : r.bottom + 6; // above the region, or below it when there is no room
    bar.style.top = top + 'px';
    bar.style.left = Math.max(8, Math.min(r.left, window.innerWidth - bar.offsetWidth - 8)) + 'px';
  }

  function show(el) {
    active = el;
    bar.hidden = false;
    bar.setAttribute('aria-label', el === header ? 'Header formatting' : 'Footer formatting');
    positionBar();
  }

  function hideSoon() {
    setTimeout(() => {
      const a = document.activeElement;
      if (a === header || a === footer || bar.contains(a)) return;
      bar.hidden = true;
      active = null;
    }, 0);
  }

  function run(cmd) {
    if (!active) return;
    active.focus();
    if (cmd === 'PAGE' || cmd === 'NUMPAGES') document.execCommand('insertHTML', false, FIELD_HTML(cmd, cmd === 'PAGE' ? 'Page number' : 'Total pages') + '​');
    else if (cmd === 'clear') { active.innerHTML = ''; onChange(); }
    else document.execCommand(cmd, false, null);
    normalize(active);
    positionBar();
    onChange();
  }

  function bind(el) {
    el.addEventListener('focus', () => show(el));
    el.addEventListener('blur', hideSoon);
    el.addEventListener('input', () => { normalize(el); onChange(); positionBar(); });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (text) document.execCommand('insertText', false, text.replace(/\r?\n+/g, ' '));
    });
    el.addEventListener('drop', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); const ed = $('editor'); ed.focus(); }
    });
  }

  const api = {
    init(opts) {
      onChange = (opts && opts.onChange) || onChange;
      header = $('pageHeader'); footer = $('pageFooter'); bar = $('hfBar');
      [header, footer].forEach(bind);
      bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the text selection
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-hf]');
        if (b) run(b.dataset.hf);
      });
      bar.addEventListener('focusout', hideSoon);
      const reposition = () => positionBar();
      window.addEventListener('resize', reposition);
      document.getElementById('workspace').addEventListener('scroll', reposition);
    },

    /** Loads the header/footer of an opened document (DocumentFragments, or null). */
    setContent(headerFragment, footerFragment) {
      [[header, headerFragment], [footer, footerFragment]].forEach(([el, frag]) => {
        el.innerHTML = '';
        if (frag) el.appendChild(frag);
        normalize(el);
      });
    },

    clear() { api.setContent(null, null); },

    /** Places the regions in the page margins (page sizes are in twips; px converts them). */
    applyPage(page, px) {
      const p = $('page').style;
      p.setProperty('--hf-left', px(page.margins.left) + 'px');
      p.setProperty('--hf-right', px(page.margins.right) + 'px');
      p.setProperty('--hf-header-top', px(page.headerTw || 720) + 'px');
      p.setProperty('--hf-footer-bottom', px(page.footerTw || 720) + 'px');
      positionBar();
    },

    applyDefaults(styles) {
      [header, footer].forEach((el) => Object.entries(styles).forEach(([k, v]) => el.style.setProperty(k, v)));
    },

    get header() { return header; },
    get footer() { return footer; }
  };

  Folio.headerFooter = api;
})(window.Folio = window.Folio || {});
