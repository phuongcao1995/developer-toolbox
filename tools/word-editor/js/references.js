/**
 * Folio — footnotes and table of contents.
 *
 * Footnotes: a marker (<span class="fn" data-note="…">) sits in the text; the notes are listed under the document and numbered in
 * reading order. In the saved .docx they are real Word footnotes (word/footnotes.xml), so Word puts each at the bottom of its page.
 * Click a marker to edit or delete its note.
 *
 * Table of contents: built from Heading 1–3. Each entry links to its heading. Page numbers are not included (Word adds them when
 * you update the field there); headings are saved as bookmarks so the links keep working in Word.
 */
(function (Folio) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const u = Folio.util;
  const ui = Folio.ui;
  let editor, listEl, onChange = () => {};

  function markers() {
    return Array.from(editor.root.querySelectorAll('span.fn'));
  }

  /** Numbers the markers in reading order and rebuilds the list under the page. */
  function refresh() {
    if (!listEl) return;
    const list = markers();
    list.forEach((m, i) => {
      const n = String(i + 1);
      if (m.textContent !== n) m.textContent = n;
      m.setAttribute('contenteditable', 'false');
      m.title = 'Footnote ' + n + ': ' + (m.getAttribute('data-note') || '') + ' (click to edit)';
    });
    listEl.hidden = !list.length;
    listEl.replaceChildren();
    if (!list.length) return;
    const ol = document.createElement('ol');
    list.forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m.getAttribute('data-note') || '';
      ol.appendChild(li);
    });
    listEl.appendChild(ol);
  }

  async function noteDialog(initial, isNew) {
    const body = document.createElement('div');
    body.className = 'form-grid';
    const label = document.createElement('label');
    label.textContent = 'Footnote text';
    const ta = document.createElement('textarea');
    ta.name = 'note';
    ta.rows = 4;
    ta.maxLength = 2000;
    ta.value = initial || '';
    label.appendChild(ta);
    body.appendChild(label);
    const actions = [{ label: 'Cancel', value: 'cancel' }];
    if (!isNew) actions.push({ label: 'Delete footnote', value: 'delete', danger: true });
    actions.push({ label: isNew ? 'Insert' : 'Save', value: 'ok', primary: true });
    return ui.modal({ title: isNew ? 'Insert footnote' : 'Edit footnote', body, actions, collect: (form) => form.elements.note.value.trim() });
  }

  async function insertFootnote() {
    editor.restoreSelection();
    const saved = editor.currentRange() && editor.currentRange().cloneRange();
    const res = await noteDialog('', true);
    if (saved) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(saved); editor.savedRange = saved; }
    if (res.action !== 'ok' || !res.values) return;
    const span = document.createElement('span');
    span.className = 'fn';
    span.setAttribute('data-note', res.values);
    span.setAttribute('contenteditable', 'false');
    span.textContent = '1';
    editor.insertInline(span);
    refresh();
    onChange();
  }

  async function editFootnote(marker) {
    const res = await noteDialog(marker.getAttribute('data-note') || '', false);
    if (res.action === 'delete') {
      editor.transact(() => marker.remove());
    } else if (res.action === 'ok' && res.values) {
      editor.transact(() => marker.setAttribute('data-note', res.values));
    } else return;
    refresh();
    onChange();
  }

  /* ---------- table of contents ---------- */

  function buildToc() {
    const heads = Array.from(editor.root.querySelectorAll('h1,h2,h3')).filter((h) => !h.closest('.toc') && h.textContent.trim());
    const toc = document.createElement('div');
    toc.className = 'toc';
    toc.setAttribute('contenteditable', 'false');
    const title = document.createElement('p');
    title.className = 'toc-title';
    title.innerHTML = '<b></b>';
    title.firstChild.textContent = 'Contents';
    toc.appendChild(title);
    if (!heads.length) {
      const p = document.createElement('p');
      p.textContent = 'Add Heading 1–3 paragraphs, then update the table of contents.';
      toc.appendChild(p);
    }
    const used = new Set(Array.from(editor.root.querySelectorAll('[id]')).map((e) => e.id));
    heads.forEach((h, i) => {
      if (!h.id || !/^toc-\d+$/.test(h.id)) {
        let n = i + 1;
        while (used.has('toc-' + n)) n++;
        h.id = 'toc-' + n;
        used.add(h.id);
      }
      const level = Number(h.tagName[1]);
      const p = document.createElement('p');
      p.className = 'toc-' + level;
      p.style.marginLeft = (level - 1) * 18 + 'pt';
      p.style.marginTop = '0';
      p.style.marginBottom = '2pt';
      const a = document.createElement('a');
      a.setAttribute('href', '#' + h.id);
      a.textContent = h.textContent.trim();
      p.appendChild(a);
      toc.appendChild(p);
    });
    return toc;
  }

  function insertToc() {
    editor.restoreSelection();
    const existing = editor.root.querySelector('.toc');
    editor.transact(() => {
      const toc = buildToc();
      if (existing) existing.replaceWith(toc);
      else editor.insertBlocks([toc]);
    });
    onChange();
    ui.toast(existing ? 'Table of contents updated.' : 'Table of contents inserted. Use the TOC button again to update it after you change headings.');
  }

  function init(opts) {
    editor = opts.editor;
    listEl = $('footnoteList');
    onChange = opts.onChange || onChange;
    editor.root.addEventListener('click', (e) => {
      const m = e.target.closest && e.target.closest('span.fn');
      if (m && editor.root.contains(m)) { e.preventDefault(); editFootnote(m); }
    });
    refresh();
  }

  Folio.references = { init, refresh, insertFootnote, insertToc };
})(window.Folio = window.Folio || {});
