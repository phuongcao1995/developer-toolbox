/**
 * Folio — editor controller.
 *
 * Wraps the contenteditable <article> and implements every toolbar command.
 * Simple inline formatting uses document.execCommand (still the only native
 * rich-text API and supported by all current browsers); anything where
 * execCommand behaves inconsistently across browsers (paragraph styles,
 * indentation, line spacing, tables, images, page breaks) manipulates the
 * DOM directly. Every change is recorded in Folio.History.
 */
(function (Folio) {
  'use strict';

  const u = Folio.util;
  const ui = Folio.ui;

  const LEAF_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,blockquote,li,pre,div';
  const TOGGLES = ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull', 'insertUnorderedList', 'insertOrderedList'];
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

  class Editor {
    /**
     * @param {HTMLElement} root contenteditable element
     * @param {object} opts
     * @param {function} opts.onChange        called after any content change
     * @param {function} opts.getZoom         current zoom factor
     * @param {function} opts.contentWidthPt  printable width of the page
     */
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.savedRange = null;
      this.pendingFontSize = null;
      this.selectedImage = null;
      this.history = new Folio.History(root, () => this.updateUndoButtons());
      this.stateFrame = 0;
    }

    init() {
      try {
        document.execCommand('defaultParagraphSeparator', false, 'p');
        document.execCommand('styleWithCSS', false, true);
      } catch (e) { /* older browsers: harmless */ }

      document.addEventListener('selectionchange', () => this.onSelectionChange());
      this.root.addEventListener('input', (e) => this.onInput(e));
      this.root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
      this.root.addEventListener('keydown', (e) => this.onKeyDown(e));
      this.root.addEventListener('paste', (e) => this.onPaste(e));
      this.root.addEventListener('click', (e) => this.onClick(e));
      this.setupImageResizer();
      window.addEventListener('resize', () => this.positionResizer());
      this.history.reset();
    }

    /* ================================================================== */
    /* Selection                                                          */
    /* ================================================================== */
    inEditor(node) { return node && (node === this.root || this.root.contains(node)); }

    currentRange() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && this.inEditor(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
      return this.savedRange;
    }

    onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (!this.inEditor(r.commonAncestorContainer)) return;
      this.savedRange = r.cloneRange();
      if (this.selectedImage && !(r.startContainer === this.selectedImage.parentNode && r.toString() === '' && !r.collapsed)) {
        this.hideResizer();
      }
      this.scheduleStateUpdate();
    }

    /** Put the caret back where it was before a toolbar control took focus. */
    restoreSelection() {
      const sel = window.getSelection();
      if (sel.rangeCount && this.inEditor(sel.getRangeAt(0).commonAncestorContainer) && document.activeElement === this.root) return;
      this.root.focus({ preventScroll: true });
      if (this.savedRange && this.inEditor(this.savedRange.startContainer) && this.savedRange.startContainer.isConnected) {
        sel.removeAllRanges();
        sel.addRange(this.savedRange);
      } else {
        this.placeCaret(this.root.firstElementChild || this.root, true);
      }
    }

    placeCaret(el, atStart) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(!!atStart);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      this.savedRange = r.cloneRange();
    }

    /** Leaf block elements touched by the current selection. */
    getSelectedBlocks() {
      const range = this.currentRange();
      if (!range) return [];
      let blocks = Array.from(this.root.querySelectorAll(LEAF_BLOCKS)).filter((el) => range.intersectsNode(el));
      blocks = blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o)));
      // A selection ending at the very start of a block doesn't include it.
      if (blocks.length > 1 && !range.collapsed) {
        const last = blocks[blocks.length - 1];
        const probe = document.createRange();
        probe.setStart(last, 0);
        try { probe.setEnd(range.endContainer, range.endOffset); } catch (e) { /* ignore */ }
        if (probe.toString() === '' && !probe.cloneContents().querySelector('img')) blocks.pop();
      }
      if (!blocks.length) {
        const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        const cell = start && start.closest('td,th');
        if (cell && this.inEditor(cell)) blocks = [cell];
      }
      return blocks;
    }

    closestInEditor(selector) {
      const range = this.currentRange();
      if (!range) return null;
      let n = range.startContainer;
      if (n.nodeType !== 1) n = n.parentElement;
      const el = n && n.closest(selector);
      return el && this.inEditor(el) && el !== this.root ? el : null;
    }

    /* ================================================================== */
    /* Change tracking                                                    */
    /* ================================================================== */
    /** Run a DOM-changing operation as a single undoable step. */
    transact(fn) {
      this.history.flush();
      const result = fn();
      this.ensureBlocks();
      this.history.record();
      this.opts.onChange();
      this.scheduleStateUpdate();
      return result;
    }

    exec(cmd, value = null) {
      this.restoreSelection();
      this.transact(() => document.execCommand(cmd, false, value));
    }

    onBeforeInput(e) {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); }
    }

    onInput(e) {
      if (this.root.querySelector('font[size="7"]')) this.normalizeFontTags();
      this.ensureBlocks();
      if (e.inputType && e.inputType.startsWith('format')) this.history.record();
      else this.history.scheduleTyping();
      this.hideResizer();
      this.opts.onChange();
      this.updateUndoButtons();
    }

    undo() { this.hideResizer(); if (this.history.undo()) { this.opts.onChange(); this.scheduleStateUpdate(); } }
    redo() { this.hideResizer(); if (this.history.redo()) { this.opts.onChange(); this.scheduleStateUpdate(); } }

    /** Keep the document a sequence of blocks (no bare text at the top level). */
    ensureBlocks() {
      if (!this.root.firstChild || (this.root.childNodes.length === 1 && this.root.firstChild.nodeType === 3 && !this.root.textContent.trim())) {
        this.root.innerHTML = '<p><br></p>';
        this.placeCaret(this.root.firstChild, true);
        return;
      }
      this.fixNestedBlocks();
      // Empty blocks need a <br> or they collapse to zero height.
      this.root.querySelectorAll('p:empty, h1:empty, h2:empty, h3:empty, h4:empty, h5:empty, h6:empty, li:empty, blockquote:empty, td:empty, th:empty')
        .forEach((el) => el.appendChild(document.createElement('br')));
      const stray = Array.from(this.root.childNodes).filter((n) =>
        (n.nodeType === 3 && n.data.trim()) || (n.nodeType === 1 && !/^(P|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TABLE|HR|DIV)$/.test(n.tagName)));
      if (!stray.length) return;
      const caret = this.history.saveCaret();
      let p = null;
      for (const n of Array.from(this.root.childNodes)) {
        if (stray.includes(n)) {
          if (!p) { p = document.createElement('p'); this.root.insertBefore(p, n); }
          p.appendChild(n);
        } else p = null;
      }
      this.history.restoreCaret(caret);
    }

    /**
     * Chrome's list command can produce <p><ul>…</ul></p>, which is invalid
     * HTML: re-parsing it (undo, reopen) leaves stray empty paragraphs. Split
     * any paragraph/heading that contains block children so each block
     * stands on its own, keeping the paragraph's attributes on the inline parts.
     */
    fixNestedBlocks() {
      const BLOCK = /^(P|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|DIV|HR)$/;
      const bad = Array.from(this.root.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))
        .filter((el) => Array.from(el.children).some((c) => BLOCK.test(c.tagName)));
      if (!bad.length) return;
      // Nodes are moved, not recreated, so the caret can be restored by
      // reference (text offsets can't express a caret in an empty item).
      const sel = window.getSelection();
      const r = sel.rangeCount ? sel.getRangeAt(0) : null;
      const saved = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
      // Innermost first, so nested cases resolve outward.
      bad.reverse().forEach((el) => {
        const parts = [];
        let run = null;
        for (const n of Array.from(el.childNodes)) {
          if (n.nodeType === 1 && BLOCK.test(n.tagName)) { run = null; parts.push(n); continue; }
          if (n.nodeType === 3 && !n.data.trim() && !run) continue;
          if (!run) {
            run = document.createElement(el.tagName.toLowerCase());
            for (const a of el.attributes) run.setAttribute(a.name, a.value);
            parts.push(run);
          }
          run.appendChild(n);
        }
        el.replaceWith(...parts);
      });
      if (saved && saved[0].isConnected && saved[2].isConnected) {
        try {
          const nr = document.createRange();
          nr.setStart(saved[0], saved[1]);
          nr.setEnd(saved[2], saved[3]);
          sel.removeAllRanges();
          sel.addRange(nr);
          this.savedRange = nr.cloneRange();
        } catch (e) { /* offsets no longer valid; leave selection as is */ }
      }
    }

    /* ================================================================== */
    /* Character formatting                                               */
    /* ================================================================== */
    applyColor(kind, color) {
      this.restoreSelection();
      this.transact(() => {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand(kind === 'fore' ? 'foreColor' : 'hiliteColor', false, color);
      });
    }

    applyFont(name) {
      this.restoreSelection();
      this.transact(() => document.execCommand('fontName', false, u.fontStack(name)));
    }

    /**
     * execCommand('fontSize') only knows HTML sizes 1–7, so we apply size 7
     * as a marker and immediately replace those <font> tags with
     * <span style="font-size: Npt">.
     */
    applyFontSize(pt) {
      pt = u.roundHalf(Math.min(400, Math.max(1, pt)));
      this.pendingFontSize = pt;
      this.restoreSelection();
      this.transact(() => {
        document.execCommand('styleWithCSS', false, false);
        document.execCommand('fontSize', false, '7');
        document.execCommand('styleWithCSS', false, true);
        this.normalizeFontTags();
      });
    }

    normalizeFontTags() {
      const fonts = this.root.querySelectorAll('font[size="7"]');
      if (!fonts.length) return;
      const caret = this.history.saveCaret();
      const pt = this.pendingFontSize || 11;
      fonts.forEach((f) => {
        const span = document.createElement('span');
        span.style.fontSize = pt + 'pt';
        if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
        if (f.getAttribute('face')) span.style.fontFamily = f.getAttribute('face');
        while (f.firstChild) span.appendChild(f.firstChild);
        f.replaceWith(span);
        span.querySelectorAll('[style]').forEach((el) => {
          el.style.fontSize = '';
          if (!el.getAttribute('style')) el.removeAttribute('style');
        });
      });
      this.history.restoreCaret(caret);
    }

    /* ================================================================== */
    /* Paragraph formatting                                               */
    /* ================================================================== */
    /** Change paragraph style (Normal, Heading 1–4, Quote). */
    applyBlockStyle(tag) {
      this.restoreSelection();
      const blocks = this.getSelectedBlocks();
      if (blocks.some((b) => b.tagName === 'LI')) {
        ui.toast('Paragraph styles can\u2019t be applied inside a list. Remove the list formatting first.');
        return;
      }
      const caret = this.history.saveCaret();
      this.transact(() => {
        for (let block of blocks) {
          if (block.tagName === 'TD' || block.tagName === 'TH') {
            // Cell with bare inline content: wrap it first.
            const p = document.createElement('p');
            while (block.firstChild) p.appendChild(block.firstChild);
            block.appendChild(p);
            block = p;
          }
          // Leaving a quote: move the paragraph out of its <blockquote>.
          const parentQuote = block.parentElement && block.parentElement.tagName === 'BLOCKQUOTE' ? block.parentElement : null;
          if (parentQuote && tag !== 'blockquote') {
            parentQuote.parentNode.insertBefore(block, parentQuote.nextSibling);
            if (!parentQuote.textContent.trim() && !parentQuote.querySelector('img')) parentQuote.remove();
          }
          if (parentQuote && tag === 'blockquote') continue;
          const special = tag === 'title' || tag === 'subtitle'; // Title and Subtitle are paragraphs with a class
          const realTag = special ? 'p' : tag;
          const currentClass = block.classList.contains('title') ? 'title' : block.classList.contains('subtitle') ? 'subtitle' : '';
          if (block.tagName.toLowerCase() === realTag && currentClass === (special ? tag : '')) continue;
          const el = document.createElement(realTag);
          for (const a of block.attributes) el.setAttribute(a.name, a.value);
          el.classList.remove('title', 'subtitle');
          if (!el.getAttribute('class')) el.removeAttribute('class');
          if (special) el.classList.add(tag);
          // Spacing overrides belong to Normal paragraphs, not headings.
          if (tag !== 'p') { el.style.marginTop = ''; el.style.marginBottom = ''; }
          if (!el.getAttribute('style')) el.removeAttribute('style');
          while (block.firstChild) el.appendChild(block.firstChild);
          block.replaceWith(el);
        }
      });
      this.history.restoreCaret(caret);
    }

    applyLineSpacing(value) {
      this.restoreSelection();
      const blocks = this.getSelectedBlocks();
      this.transact(() => blocks.forEach((b) => { b.style.lineHeight = String(value); }));
    }

    /** Paragraph settings: indents, first line / hanging, spacing before and after, line spacing. */
    async paragraphDialog() {
      this.restoreSelection();
      const saved = this.currentRange() && this.currentRange().cloneRange();
      const blocks = this.getSelectedBlocks().filter((b) => b.tagName !== 'TD' && b.tagName !== 'TH');
      if (!blocks.length) return;
      const lists = blocks.some((b) => b.tagName === 'LI');
      const first = blocks[0];
      const cs = getComputedStyle(first);
      const pt = (v) => Math.round((parseFloat(v) || 0) * 0.75 * 10) / 10;
      const inch = (v) => Math.round((parseFloat(v) || 0) * 0.75 / 72 * 100) / 100;
      const indent = parseFloat(cs.textIndent) || 0;
      const fontPx = parseFloat(cs.fontSize) || 15;
      const lh = first.style.lineHeight || '';
      let line = 'multiple', at = Math.round(((parseFloat(cs.lineHeight) || fontPx * 1.15) / fontPx) * 100) / 100;
      if (/pt$|px$/.test(lh)) { line = 'atleast'; at = u.cssLengthToPt(lh, 11); }
      else if ([1, 1.15, 1.5, 2].includes(at)) line = String(at);
      const body = document.createElement('div');
      body.className = 'form-grid';
      body.innerHTML =
        `<div class="form-row"><label>Left indent (in)<input name="left" type="number" step="0.05" min="0" max="20" value="${lists ? 0 : inch(cs.marginLeft)}"${lists ? ' disabled' : ''}></label>` +
        `<label>Right indent (in)<input name="right" type="number" step="0.05" min="0" max="20" value="${lists ? 0 : inch(cs.marginRight)}"${lists ? ' disabled' : ''}></label></div>` +
        `<div class="form-row"><label>Special<select name="special"${lists ? ' disabled' : ''}><option value="none"${indent === 0 ? ' selected' : ''}>(none)</option>` +
        `<option value="first"${indent > 0 ? ' selected' : ''}>First line</option><option value="hanging"${indent < 0 ? ' selected' : ''}>Hanging</option></select></label>` +
        `<label>By (in)<input name="by" type="number" step="0.05" min="0" max="20" value="${lists ? 0 : Math.abs(inch(indent))}"${lists ? ' disabled' : ''}></label></div>` +
        `<div class="form-row"><label>Space before (pt)<input name="before" type="number" step="1" min="0" max="500" value="${pt(cs.marginTop)}"></label>` +
        `<label>Space after (pt)<input name="after" type="number" step="1" min="0" max="500" value="${pt(cs.marginBottom)}"></label></div>` +
        `<div class="form-row"><label>Line spacing<select name="line">` +
        [['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5 lines'], ['2', 'Double'], ['multiple', 'Multiple'], ['atleast', 'At least']]
          .map(([v, l]) => `<option value="${v}"${v === line ? ' selected' : ''}>${l}</option>`).join('') + `</select></label>` +
        `<label>At (lines, or pt for At least)<input name="at" type="number" step="0.05" min="0.1" max="500" value="${at}"></label></div>` +
        (lists ? '<p class="form-hint">Indents of list items are set by the list. Use Increase / Decrease indent to nest them.</p>' : '');
      const res = await ui.modal({
        title: 'Paragraph', body,
        actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
        collect: (form) => Object.fromEntries(Array.from(form.elements).filter((f) => f.name).map((f) => [f.name, f.value]))
      });
      this.root.focus({ preventScroll: true });
      if (saved) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(saved); this.savedRange = saved; }
      if (res.action !== 'ok') return;
      const v = res.values;
      const n = (k, d) => { const x = parseFloat(v[k]); return isFinite(x) ? x : d; };
      this.transact(() => blocks.forEach((b) => {
        const isLi = b.tagName === 'LI';
        const set = (prop, value) => { if (value === '' || value === null) b.style.removeProperty(prop); else b.style.setProperty(prop, value); };
        if (!isLi) {
          const left = Math.max(0, n('left', 0)) * 72, right = Math.max(0, n('right', 0)) * 72, by = Math.max(0, n('by', 0)) * 72;
          set('margin-left', left ? left + 'pt' : '');
          set('margin-right', right ? right + 'pt' : '');
          set('text-indent', v.special === 'first' && by ? by + 'pt' : v.special === 'hanging' && by ? -by + 'pt' : '');
        }
        set('margin-top', Math.max(0, n('before', 0)) + 'pt');
        set('margin-bottom', Math.max(0, n('after', 0)) + 'pt');
        if (v.line === 'atleast') set('line-height', Math.max(1, n('at', 12)) + 'pt');
        else set('line-height', v.line === 'multiple' ? String(Math.max(0.1, n('at', 1))) : v.line);
        if (!b.getAttribute('style')) b.removeAttribute('style');
      }));
    }

    /** Increase/decrease indent: nests list items, or shifts paragraphs by 0.5 in. */
    indent(dir) {
      this.restoreSelection();
      const blocks = this.getSelectedBlocks();
      if (blocks.some((b) => b.tagName === 'LI')) {
        this.transact(() => document.execCommand(dir > 0 ? 'indent' : 'outdent'));
        return;
      }
      this.transact(() => blocks.forEach((b) => {
        if (b.tagName === 'TD' || b.tagName === 'TH') return;
        const cur = u.cssLengthToPt(b.style.marginLeft, 11) || 0;
        const next = Math.max(0, Math.round((cur + dir * 36) / 36) * 36);
        b.style.marginLeft = next ? next + 'pt' : '';
        if (!b.getAttribute('style')) b.removeAttribute('style');
      }));
    }

    /* ================================================================== */
    /* Block insertion helpers                                            */
    /* ================================================================== */
    /** The top-level block (or table-cell child) containing the caret. */
    hostBlock() {
      const range = this.currentRange();
      let n = range ? range.startContainer : null;
      if (!n || !this.inEditor(n)) return null;
      if (n === this.root) return this.root.childNodes[range.startOffset] || this.root.lastChild;
      while (n.parentNode && n.parentNode !== this.root && !/^(TD|TH)$/.test(n.parentNode.nodeName)) n = n.parentNode;
      return n;
    }

    isEmptyBlock(el) {
      return el && el.nodeType === 1 && el.tagName === 'P' && !el.textContent.trim() && !el.querySelector('img,table,hr');
    }

    /** Insert block nodes after the caret's block (replacing it if empty). */
    insertBlocks(nodes) {
      const host = this.hostBlock();
      const parent = host ? host.parentNode : this.root;
      const last = nodes[nodes.length - 1];
      if (host && this.isEmptyBlock(host)) {
        nodes.forEach((n) => parent.insertBefore(n, host));
        host.remove();
      } else {
        const ref = host ? host.nextSibling : null;
        nodes.forEach((n) => parent.insertBefore(n, ref));
      }
      // Always leave an editable paragraph after a table or break.
      let after = last.nextSibling;
      if (!after || after.nodeType !== 1 || after.tagName === 'TABLE' || after.tagName === 'HR') {
        after = document.createElement('p');
        after.appendChild(document.createElement('br'));
        parent.insertBefore(after, last.nextSibling);
      }
      return after;
    }

    insertPageBreak() {
      this.restoreSelection();
      this.transact(() => {
        const host = this.hostBlock();
        const range = this.currentRange();
        // In ordinary paragraphs, split at the caret (like Word does).
        if (host && /^(P|H[1-6])$/.test(host.nodeName) && host.parentNode === this.root && range && range.collapsed) {
          document.execCommand('insertParagraph');
          const now = this.hostBlock();
          const hr = document.createElement('hr');
          hr.className = 'page-break';
          now.parentNode.insertBefore(hr, now);
          return;
        }
        const hr = document.createElement('hr');
        hr.className = 'page-break';
        const after = this.insertBlocks([hr]);
        this.placeCaret(after, true);
      });
    }

    /* ================================================================== */
    /* Text tools: change case, special characters, horizontal line, format painter */
    /* ================================================================== */
    /** Changes the case of the selection (or of the word at the caret). modes: sentence, lower, upper, title, toggle. */
    changeCase(mode) {
      this.restoreSelection();
      let range = this.currentRange();
      if (!range) return;
      if (range.collapsed) {
        // Word at the caret.
        const node = range.startContainer;
        if (node.nodeType !== 3) return;
        const re = /[\p{L}\p{N}'\u2019]/u;
        let a = range.startOffset, b = a;
        while (a > 0 && re.test(node.data[a - 1])) a--;
        while (b < node.data.length && re.test(node.data[b])) b++;
        if (a === b) return;
        range = range.cloneRange();
        range.setStart(node, a); range.setEnd(node, b);
      }
      const keep = { sc: range.startContainer, so: range.startOffset, ec: range.endContainer, eo: range.endOffset };
      const texts = [];
      const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n) && this.inEditor(n)) texts.push(n);
      if (range.commonAncestorContainer.nodeType === 3 && !texts.length) texts.push(range.commonAncestorContainer);
      this.transact(() => {
        const state = { capNext: mode === 'sentence' ? this.startsSentence(texts[0], texts[0] === keep.sc ? keep.so : 0) : false, inWord: false };
        for (const n of texts) {
          const from = n === keep.sc ? keep.so : 0;
          const to = n === keep.ec ? keep.eo : n.data.length;
          if (to > from) n.replaceData(from, to - from, u.changeCase(n.data.slice(from, to), mode, state));
        }
        const sel = window.getSelection();
        const r = document.createRange();
        r.setStart(keep.sc, keep.so); r.setEnd(keep.ec, keep.eo);
        sel.removeAllRanges(); sel.addRange(r);
      });
    }

    /** True when the text before `offset` in `node` is the start of a sentence (nothing before it, or ". " etc.). */
    startsSentence(node, offset) {
      const before = node.data.slice(0, offset).replace(/\s+$/, '');
      if (before) return /[.!?]$/.test(before);
      const block = node.parentElement && node.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote');
      return !block || !block.textContent.slice(0, block.textContent.indexOf(node.data)).trim();
    }

    /** Types text at the caret (used for symbols and the date). */
    insertText(text) {
      this.restoreSelection();
      this.transact(() => document.execCommand('insertText', false, text));
    }

    /** A horizontal line between paragraphs (saved as a paragraph with a bottom border). */
    insertHorizontalLine() {
      this.restoreSelection();
      this.transact(() => {
        const after = this.insertBlocks([document.createElement('hr')]);
        this.placeCaret(after, true);
      });
    }

    /** Remembers the formatting at the caret for the format painter. */
    captureFormat() {
      const range = this.currentRange();
      let node = range && range.startContainer;
      if (node && node.nodeType !== 1) node = node.parentElement;
      if (!node || !this.inEditor(node)) return null;
      const cs = getComputedStyle(node);
      const hex = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c); return m && (m[4] === undefined || parseFloat(m[4]) > 0) ? '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('') : null; };
      let bg = null;
      for (let n = node; n && n !== this.root; n = n.parentElement) { const b = hex(getComputedStyle(n).backgroundColor); if (b) { bg = b; break; } }
      return {
        bold: parseInt(cs.fontWeight, 10) >= 600, italic: cs.fontStyle === 'italic',
        underline: cs.textDecorationLine.includes('underline'), strike: cs.textDecorationLine.includes('line-through'),
        sup: cs.verticalAlign === 'super' || !!node.closest('sup'), sub: cs.verticalAlign === 'sub' || !!node.closest('sub'),
        font: u.firstFontFamily(cs.fontFamily) || '', size: u.roundHalf(parseFloat(cs.fontSize) * 0.75), color: hex(cs.color), bg
      };
    }

    /** Gives the selected text the captured formatting. Returns false when nothing is selected. */
    applyFormat(f) {
      this.restoreSelection();
      const range = this.currentRange();
      if (!f || !range || range.collapsed) return false;
      const state = (c) => { try { return document.queryCommandState(c); } catch (err) { return false; } };
      this.history.flush();
      for (const [cmd, want] of [['bold', f.bold], ['italic', f.italic], ['underline', f.underline], ['strikeThrough', f.strike], ['superscript', f.sup], ['subscript', f.sub]]) {
        if (state(cmd) !== !!want) document.execCommand(cmd, false, null);
      }
      if (f.font) document.execCommand('fontName', false, u.fontStack(f.font));
      this.applyFontSize(f.size);
      if (f.color) this.applyColor('fore', f.color);
      if (f.bg) this.applyColor('back', f.bg);
      this.transact(() => {});
      return true;
    }

    /* ================================================================== */
    /* Links                                                              */
    /* ================================================================== */
    normalizeUrl(s) {
      const v = (s || '').trim();
      if (!v || /\s/.test(v)) return null;
      if (/^(javascript|data|vbscript|file):/i.test(v)) return null;
      if (/^(https?:\/\/|mailto:|tel:|#)/i.test(v)) return v;
      if (/^[^@\s/]+@[^@\s]+\.[^@\s]+$/.test(v)) return 'mailto:' + v;
      if (/^(www\.)?[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/i.test(v)) return 'https://' + v;
      return null;
    }

    async linkDialog() {
      this.restoreSelection();
      const range = this.currentRange();
      if (!range) return;
      const saved = range.cloneRange();
      const anchor = this.closestInEditor('a');
      const selectedText = anchor ? anchor.textContent : saved.toString();
      const showText = !!anchor || saved.collapsed;

      const body = document.createElement('div');
      body.className = 'form-grid';
      body.innerHTML =
        (showText ? `<label>Text to display<input name="text" type="text" value="${u.escapeHtml(selectedText)}"></label>` : '') +
        `<label>Address<input name="url" type="text" required placeholder="https://example.com or name@example.com" value="${u.escapeHtml(anchor ? anchor.getAttribute('href') : '')}"></label>` +
        '<p class="form-hint">Web addresses, email addresses and #bookmarks are supported. Ctrl+click a link in the document to open it.</p>';
      const actions = [{ label: 'Cancel', value: 'cancel' }];
      if (anchor) actions.push({ label: 'Remove link', value: 'remove', danger: true });
      actions.push({ label: anchor ? 'Update link' : 'Insert link', value: 'ok', primary: true });

      const res = await ui.modal({
        title: anchor ? 'Edit link' : 'Insert link',
        body, actions,
        collect: (form) => ({ text: form.elements.text ? form.elements.text.value : null, url: form.elements.url.value })
      });
      // Restore the selection the dialog took away.
      this.root.focus({ preventScroll: true });
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(saved);
      this.savedRange = saved;

      if (res.action === 'remove' && anchor) {
        this.transact(() => {
          const r = document.createRange();
          r.selectNodeContents(anchor);
          sel.removeAllRanges(); sel.addRange(r);
          document.execCommand('unlink');
        });
        return;
      }
      if (res.action !== 'ok') return;
      const url = this.normalizeUrl(res.values.url);
      if (!url) { ui.toast('That doesn\u2019t look like a web or email address. Example: https://example.com'); return; }
      const text = res.values.text;
      this.transact(() => {
        if (anchor) {
          anchor.setAttribute('href', url);
          if (text && text !== anchor.textContent) anchor.textContent = text;
        } else if (saved.collapsed) {
          const a = document.createElement('a');
          a.setAttribute('href', url);
          a.textContent = text || url;
          saved.insertNode(a);
          const after = document.createRange();
          after.setStartAfter(a);
          after.collapse(true);
          sel.removeAllRanges(); sel.addRange(after);
        } else {
          document.execCommand('createLink', false, url);
        }
      });
    }

    /* ================================================================== */
    /* Tables                                                             */
    /* ================================================================== */
    insertTable(rows, cols) {
      rows = Math.min(100, Math.max(1, rows | 0));
      cols = Math.min(20, Math.max(1, cols | 0));
      this.restoreSelection();
      const widthPt = Math.floor(this.opts.contentWidthPt() / cols * 10) / 10;
      const table = document.createElement('table');
      const tbody = table.appendChild(document.createElement('tbody'));
      for (let r = 0; r < rows; r++) {
        const tr = tbody.appendChild(document.createElement('tr'));
        for (let c = 0; c < cols; c++) tr.appendChild(this.newCell('td', widthPt));
      }
      this.transact(() => {
        this.insertBlocks([table]);
        this.placeCaret(table.querySelector('td p'), true);
      });
    }

    newCell(tag, widthPt) {
      const td = document.createElement(tag);
      if (widthPt) td.style.width = widthPt + 'pt';
      const p = td.appendChild(document.createElement('p'));
      p.appendChild(document.createElement('br'));
      return td;
    }

    /** Info about the table at the caret, used by the table menu. */
    tableContext() {
      const cell = this.closestInEditor('td,th');
      if (!cell) return null;
      const table = cell.closest('table');
      const merged = !!Array.from(table.querySelectorAll('td,th')).some((c) => c.closest('table') === table && (c.rowSpan > 1 || c.colSpan > 1));
      return { cell, row: cell.parentElement, table, merged };
    }

    tableAction(action) {
      this.restoreSelection();
      const ctx = this.tableContext();
      if (!ctx) return;
      const { cell, row, table } = ctx;
      if (['mergeCells', 'splitCell', 'headerRow', 'borders', 'shade'].includes(action) || /^shade:/.test(action)) { this.tableFormat(action, ctx); return; }
      if (ctx.merged && action !== 'deleteTable') {
        ui.toast('Rows and columns can\u2019t be edited in tables with merged cells.');
        return;
      }
      const rows = Array.from(table.rows).filter((r) => r.closest('table') === table);
      const idx = cell.cellIndex;
      this.transact(() => {
        let focus = null;
        switch (action) {
          case 'rowAbove': case 'rowBelow': {
            const tr = document.createElement('tr');
            for (const c of row.cells) tr.appendChild(this.newCell(c.tagName.toLowerCase() === 'th' && action === 'rowBelow' ? 'td' : c.tagName.toLowerCase(), u.cssLengthToPt(c.style.width, 11)));
            row.parentNode.insertBefore(tr, action === 'rowAbove' ? row : row.nextSibling);
            focus = tr.cells[Math.min(idx, tr.cells.length - 1)];
            break;
          }
          case 'colLeft': case 'colRight': {
            for (const r of rows) {
              const ref = r.cells[Math.min(idx, r.cells.length - 1)];
              const c = this.newCell(ref ? ref.tagName.toLowerCase() : 'td');
              r.insertBefore(c, action === 'colLeft' ? ref : (ref ? ref.nextSibling : null));
              if (r === row) focus = c;
            }
            this.equalizeColumns(table, rows);
            break;
          }
          case 'deleteRow': {
            const next = row.nextElementSibling || row.previousElementSibling;
            row.remove();
            if (!next) { this.removeTable(table); return; }
            focus = next.cells[Math.min(idx, next.cells.length - 1)];
            break;
          }
          case 'deleteCol': {
            for (const r of rows) if (r.cells[idx]) r.cells[idx].remove();
            if (!rows.some((r) => r.cells.length)) { this.removeTable(table); return; }
            this.equalizeColumns(table, rows);
            focus = row.cells[Math.min(idx, row.cells.length - 1)];
            break;
          }
          case 'deleteTable': this.removeTable(table); return;
        }
        if (focus) this.placeCaret(focus.querySelector('p') || focus, true);
      });
    }

    /** Occupancy grid of a table: grid[r][c] = the cell covering that position. */
    tableGrid(table) {
      const rows = Array.from(table.rows).filter((r) => r.closest('table') === table);
      const grid = [];
      rows.forEach((row, r) => {
        grid[r] = grid[r] || [];
        let c = 0;
        for (const cell of row.cells) {
          while (grid[r][c]) c++;
          const rs = Math.max(1, cell.rowSpan || 1), cs = Math.max(1, cell.colSpan || 1);
          for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
            grid[r + dr] = grid[r + dr] || [];
            for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = cell;
          }
          c += cs;
        }
      });
      return { rows, grid };
    }

    /** The cells of the table that the selection touches (just the current cell when the caret is collapsed). */
    selectedCells(table, fallback) {
      const range = this.currentRange();
      if (!range || range.collapsed) return [fallback];
      const cellOf = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; const c = e && e.closest('td,th'); return c && c.closest('table') === table ? c : null; };
      const a = cellOf(range.startContainer), b = cellOf(range.endContainer);
      const all = Array.from(table.querySelectorAll('td,th')).filter((c) => c.closest('table') === table);
      if (!a || !b || a === b) {
        const hit = all.filter((c) => range.intersectsNode(c));
        return hit.length ? hit : [fallback];
      }
      // Like dragging in Word: the block of cells between the first and the last cell of the selection.
      const { grid } = this.tableGrid(table);
      const pos = (cell) => { for (let r = 0; r < grid.length; r++) { const c = grid[r].indexOf(cell); if (c >= 0) return { r, c }; } return { r: 0, c: 0 }; };
      const pa = pos(a), pb = pos(b);
      const ext = (cell, p) => ({ r1: p.r, c1: p.c, r2: p.r + Math.max(1, cell.rowSpan || 1) - 1, c2: p.c + Math.max(1, cell.colSpan || 1) - 1 });
      const ea = ext(a, pa), eb = ext(b, pb);
      const box = { r1: Math.min(ea.r1, eb.r1), c1: Math.min(ea.c1, eb.c1), r2: Math.max(ea.r2, eb.r2), c2: Math.max(ea.c2, eb.c2) };
      const out = new Set();
      for (let r = box.r1; r <= box.r2; r++) for (let c = box.c1; c <= box.c2; c++) if (grid[r] && grid[r][c]) out.add(grid[r][c]);
      return Array.from(out);
    }

    /** Merge / split cells, shading, header row and borders. */
    tableFormat(action, ctx) {
      const { cell, table } = ctx;
      if (action === 'borders') { this.transact(() => table.classList.toggle('borderless')); return; }
      if (action === 'headerRow') {
        const first = table.rows[0];
        if (!first) return;
        const makeHeader = first.cells[0].tagName !== 'TH';
        const ri = cell.parentElement.rowIndex, ci = cell.cellIndex;
        this.transact(() => {
          for (const c of Array.from(first.cells)) {
            const n = document.createElement(makeHeader ? 'th' : 'td');
            for (const a of c.attributes) n.setAttribute(a.name, a.value);
            while (c.firstChild) n.appendChild(c.firstChild);
            c.replaceWith(n);
          }
          const again = table.rows[ri] && table.rows[ri].cells[ci];
          if (again) this.placeCaret(again.querySelector('p') || again, true); // replacing the cells dropped the caret
        });
        return;
      }
      if (action === 'shade' || action.startsWith('shade:')) {
        const color = action.slice(6);
        const cells = this.selectedCells(table, cell);
        this.transact(() => cells.forEach((c) => { c.style.backgroundColor = color || ''; if (!c.getAttribute('style')) c.removeAttribute('style'); }));
        return;
      }
      const { rows, grid } = this.tableGrid(table);
      if (action === 'splitCell') {
        const rs = Math.max(1, cell.rowSpan || 1), cs = Math.max(1, cell.colSpan || 1);
        if (rs === 1 && cs === 1) { ui.toast('This cell is not merged.'); return; }
        const r0 = rows.indexOf(cell.parentElement);
        const c0 = grid[r0].indexOf(cell);
        const width = u.cssLengthToPt(cell.style.width, 11);
        this.transact(() => {
          cell.rowSpan = 1; cell.colSpan = 1; cell.removeAttribute('rowspan'); cell.removeAttribute('colspan');
          for (let dr = 0; dr < rs; dr++) {
            for (let dc = 0; dc < cs; dc++) {
              if (!dr && !dc) continue;
              const row = rows[r0 + dr];
              // Insert before the first cell of that row that sits to the right of this column.
              let before = null;
              for (const x of row.cells) { if (grid[r0 + dr].indexOf(x) > c0 + dc) { before = x; break; } }
              row.insertBefore(this.newCell(cell.tagName.toLowerCase(), width && cs ? width / cs : 0), before);
            }
          }
          if (width && cs > 1) cell.style.width = width / cs + 'pt';
        });
        return;
      }
      // mergeCells
      const cells = this.selectedCells(table, cell);
      if (cells.length < 2) { ui.toast('Select two or more cells to merge.'); return; }
      let r1 = Infinity, r2 = -1, c1 = Infinity, c2 = -1;
      grid.forEach((line, r) => line.forEach((x, c) => { if (cells.includes(x)) { r1 = Math.min(r1, r); r2 = Math.max(r2, r); c1 = Math.min(c1, c); c2 = Math.max(c2, c); } }));
      const inside = new Set();
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) inside.add(grid[r][c]);
      // The rectangle must not cut through a cell that is already merged beyond it.
      for (const x of inside) {
        const r = grid.findIndex((line) => line.includes(x));
        const c = grid[r].indexOf(x);
        if (r < r1 || c < c1 || r + (x.rowSpan || 1) - 1 > r2 || c + (x.colSpan || 1) - 1 > c2) { ui.toast('Those cells can\u2019t be merged because the selection cuts through an already merged cell.'); return; }
      }
      const origin = grid[r1][c1];
      this.transact(() => {
        for (const x of inside) {
          if (x === origin) continue;
          for (const p of Array.from(x.children)) { if (p.textContent.trim() || p.querySelector('img')) origin.appendChild(p); }
          x.remove();
        }
        // Drop the empty placeholder paragraph left in front of real content.
        const ps = Array.from(origin.children);
        if (ps.length > 1) ps.filter((p) => p.tagName === 'P' && !p.textContent.trim() && !p.querySelector('img')).forEach((p) => p.remove());
        origin.colSpan = c2 - c1 + 1; origin.rowSpan = r2 - r1 + 1;
        if (origin.colSpan === 1) origin.removeAttribute('colspan');
        if (origin.rowSpan === 1) origin.removeAttribute('rowspan');
        origin.style.width = '';
        if (!origin.getAttribute('style')) origin.removeAttribute('style');
        if (!origin.children.length) { const p = origin.appendChild(document.createElement('p')); p.appendChild(document.createElement('br')); }
        this.placeCaret(origin.querySelector('p') || origin, true);
      });
    }

    equalizeColumns(table, rows) {
      const n = Math.max(...rows.map((r) => r.cells.length));
      const avail = table.parentElement === this.root ? this.opts.contentWidthPt() : (u.cssLengthToPt(table.parentElement.style.width, 11) || this.opts.contentWidthPt());
      const w = Math.floor(avail / n * 10) / 10;
      rows.forEach((r) => Array.from(r.cells).forEach((c) => { c.style.width = w + 'pt'; }));
    }

    removeTable(table) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      table.replaceWith(p);
      this.placeCaret(p, true);
    }

    /** Tab / Shift+Tab moves between cells; Tab in the last cell adds a row. */
    moveCell(cell, back) {
      const table = cell.closest('table');
      const cells = Array.from(table.querySelectorAll('td,th')).filter((c) => c.closest('table') === table);
      const i = cells.indexOf(cell);
      let target = cells[i + (back ? -1 : 1)];
      if (!target && !back) {
        const ctx = this.tableContext();
        if (ctx && !ctx.merged) { this.tableAction('rowBelow'); return; }
      }
      if (target) {
        const r = document.createRange();
        r.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
      }
    }

    /* ================================================================== */
    /* Images                                                             */
    /* ================================================================== */
    async insertImageFiles(files) {
      const list = Array.from(files);
      for (const file of list) {
        if (!IMAGE_TYPES.includes(file.type)) {
          ui.toast(`"${file.name}" isn\u2019t a supported image. Use PNG, JPEG, GIF, WebP, BMP or SVG.`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          ui.toast(`"${file.name}" is larger than ${u.formatBytes(MAX_IMAGE_BYTES)}.`);
          continue;
        }
        const url = u.trackObjectUrl(URL.createObjectURL(file));
        let dims;
        try { dims = await this.loadImageSize(url); } catch (e) {
          ui.toast(`"${file.name}" could not be read as an image.`);
          continue;
        }
        const maxW = u.ptToPx(this.opts.contentWidthPt());
        let w = dims.w || 300, h = dims.h || 150;
        if (w > maxW) { h = Math.round(h * maxW / w); w = Math.round(maxW); }
        const img = document.createElement('img');
        img.src = url;
        img.alt = file.name.replace(/\.[^.]+$/, '');
        img.setAttribute('width', String(w));
        img.setAttribute('height', String(h));
        this.insertInline(img);
      }
    }

    loadImageSize(url) {
      return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = reject;
        im.src = url;
      });
    }

    insertInline(node) {
      this.restoreSelection();
      this.transact(() => {
        const range = this.currentRange();
        range.deleteContents();
        // Drop the placeholder <br> of an empty paragraph.
        const host = this.closestInEditor('p,h1,h2,h3,h4,h5,h6,li,td,th');
        if (host && !host.textContent && !host.querySelector('img')) {
          host.querySelectorAll('br').forEach((br) => br.remove());
          range.selectNodeContents(host);
          range.collapse(true);
        }
        range.insertNode(node);
        const after = document.createRange();
        after.setStartAfter(node);
        after.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(after);
        this.savedRange = after.cloneRange();
      });
    }

    setupImageResizer() {
      this.resizer = document.getElementById('imgResizer');
      this.resizeLabel = document.getElementById('imgSize');
      const handle = document.getElementById('imgHandle');
      let start = null;
      handle.addEventListener('pointerdown', (e) => {
        if (!this.selectedImage) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const img = this.selectedImage;
        const w = parseFloat(img.getAttribute('width')) || img.naturalWidth;
        const ratio = (img.naturalHeight || parseFloat(img.getAttribute('height')) || w) / (img.naturalWidth || w);
        start = { x: e.clientX, w, ratio };
        this.history.flush();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!start || !this.selectedImage) return;
        const zoom = this.opts.getZoom();
        const maxW = u.ptToPx(this.opts.contentWidthPt());
        const w = Math.round(Math.min(maxW, Math.max(16, start.w + (e.clientX - start.x) / zoom)));
        this.selectedImage.setAttribute('width', String(w));
        this.selectedImage.setAttribute('height', String(Math.round(w * start.ratio)));
        this.positionResizer();
      });
      const end = () => {
        if (!start) return;
        start = null;
        this.history.record();
        this.opts.onChange();
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    selectImage(img) {
      this.selectedImage = img;
      const r = document.createRange();
      r.selectNode(img);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      this.savedRange = r.cloneRange();
      this.resizer.hidden = false;
      this.positionResizer();
    }

    positionResizer() {
      const img = this.selectedImage;
      if (!img || this.resizer.hidden) return;
      if (!img.isConnected) { this.hideResizer(); return; }
      const zoom = this.opts.getZoom();
      const page = this.resizer.parentElement.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      Object.assign(this.resizer.style, {
        left: (ir.left - page.left) / zoom + 'px',
        top: (ir.top - page.top) / zoom + 'px',
        width: ir.width / zoom + 'px',
        height: ir.height / zoom + 'px'
      });
      this.resizeLabel.textContent = `${Math.round(ir.width / zoom)} × ${Math.round(ir.height / zoom)} px`;
    }

    hideResizer() {
      if (!this.resizer || this.resizer.hidden) return;
      this.resizer.hidden = true;
      this.selectedImage = null;
    }

    /* ================================================================== */
    /* Events                                                             */
    /* ================================================================== */
    onClick(e) {
      const img = e.target.closest && e.target.closest('img');
      if (img && this.inEditor(img)) { this.selectImage(img); return; }
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href.startsWith('#')) {
          const target = this.root.querySelector(`[id="${CSS.escape(href.slice(1))}"], a[name="${CSS.escape(href.slice(1))}"]`);
          if (target) target.scrollIntoView({ block: 'center' });
        } else if (this.normalizeUrl(href)) window.open(href, '_blank', 'noopener');
      }
    }

    onKeyDown(e) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey) {
        if (key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
        if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); return; }
        if (key === 'k') { e.preventDefault(); this.linkDialog(); return; }
        if (key === 'v' && e.shiftKey) this.plainNext = true; // Ctrl+Shift+V: paste as plain text (the paste event follows)
        if (key === '=' && !e.shiftKey) { e.preventDefault(); this.exec('subscript'); return; }
        if (key === '+' || (key === '=' && e.shiftKey)) { e.preventDefault(); this.exec('superscript'); return; }
        const align = { l: 'justifyLeft', e: 'justifyCenter', r: 'justifyRight', j: 'justifyFull' }[key];
        if (align && !e.shiftKey) { e.preventDefault(); this.exec(align); return; }
        if (key === 'enter') { e.preventDefault(); this.insertPageBreak(); return; }
      }
      if (e.key === 'Tab' && !mod && !e.altKey) {
        const cell = this.closestInEditor('td,th');
        if (cell) { e.preventDefault(); this.moveCell(cell, e.shiftKey); return; }
        if (this.closestInEditor('li')) { e.preventDefault(); this.indent(e.shiftKey ? -1 : 1); return; }
        if (!e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '\t'); }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedImage) {
        e.preventDefault();
        const img = this.selectedImage;
        this.hideResizer();
        this.transact(() => {
          const r = document.createRange();
          r.setStartBefore(img); r.collapse(true);
          img.remove();
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(r);
        });
      }
    }

    /* ---------- paste ---------- */
    onPaste(e) {
      const cd = e.clipboardData;
      if (!cd) return;
      const plain = this.plainNext;
      this.plainNext = false;
      const html = plain ? '' : cd.getData('text/html');
      const files = plain ? [] : Array.from(cd.files || []).filter((f) => f.type.startsWith('image/'));
      e.preventDefault();
      if (!html && files.length) { this.insertImageFiles(files); return; }
      this.history.flush();
      if (html) {
        const { html: clean, droppedImages } = this.sanitize(html);
        this.transact(() => document.execCommand('insertHTML', false, clean));
        if (droppedImages) ui.toast('Some pasted images could not be included. Insert them from a file instead.');
        return;
      }
      const text = cd.getData('text/plain');
      if (!text) return;
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) { this.transact(() => document.execCommand('insertText', false, text)); return; }
      const out = lines.map((l) => `<p>${l ? u.escapeHtml(l) : '<br>'}</p>`).join('');
      this.transact(() => document.execCommand('insertHTML', false, out));
    }

    /**
     * Reduce pasted HTML (from web pages, Word, Google Docs) to the subset the
     * editor and exporter understand. Classes, scripts, event handlers and
     * unknown tags are removed; supported inline styles are kept.
     */
    sanitize(html) {
      const src = new DOMParser().parseFromString(html, 'text/html').body;
      const out = document.createElement('div');
      let droppedImages = 0;
      const KEEP = /^(P|H[1-6]|BLOCKQUOTE|PRE|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|B|STRONG|I|EM|U|S|STRIKE|DEL|SUB|SUP|A|IMG|BR|SPAN|CODE|HR)$/;
      const DROP = /^(SCRIPT|STYLE|META|LINK|TITLE|HEAD|IFRAME|OBJECT|EMBED|SVG|CANVAS|VIDEO|AUDIO|INPUT|BUTTON|SELECT|TEXTAREA|NOSCRIPT|TEMPLATE|O:P|XML)$/i;
      const BLOCKISH = /^(DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|FIGURE|FIGCAPTION|ADDRESS|CENTER|DL|DT|DD)$/;
      const STYLE_PROPS = ['font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'color', 'background-color', 'font-size', 'font-family', 'vertical-align', 'text-align'];
      const isBlockEl = (n) => n && n.nodeType === 1 && /^(P|H[1-6]|BLOCKQUOTE|PRE|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|HR|DIV)$/.test(n.tagName);

      const copyStyle = (from, to) => {
        for (const prop of STYLE_PROPS) {
          const v = from.style.getPropertyValue(prop);
          if (v && !/var\(|inherit|initial|windowtext/i.test(v)) to.style.setProperty(prop, v);
        }
      };

      const walk = (node, parent) => {
        for (const n of Array.from(node.childNodes)) {
          if (n.nodeType === 3) {
            const t = n.data.replace(/[\r\n\t ]+/g, ' ');
            if (!t.trim() && (/^(UL|OL|TABLE|THEAD|TBODY|TFOOT|TR|DIV)$/.test(parent.tagName) || isBlockEl(n.previousSibling) || isBlockEl(n.nextSibling))) continue;
            parent.appendChild(document.createTextNode(t));
            continue;
          }
          if (n.nodeType !== 1) continue;
          const tag = n.tagName.toUpperCase();
          if (DROP.test(tag)) continue;
          if (tag === 'IMG') {
            const s = n.getAttribute('src') || '';
            let url = null;
            if (s.startsWith('data:image/')) { const b = u.dataUrlToBlob(s); if (b) url = u.trackObjectUrl(URL.createObjectURL(b)); }
            else if (/^(https?:|blob:)/i.test(s)) url = s;
            if (!url) { droppedImages++; continue; }
            const img = document.createElement('img');
            img.src = url;
            img.alt = n.getAttribute('alt') || '';
            const w = parseInt(n.getAttribute('width'), 10), h = parseInt(n.getAttribute('height'), 10);
            if (w) img.setAttribute('width', String(w));
            if (h) img.setAttribute('height', String(h));
            parent.appendChild(img);
            continue;
          }
          if (KEEP.test(tag)) {
            const el = document.createElement(tag.toLowerCase());
            if (tag === 'A') {
              const href = this.normalizeUrl(n.getAttribute('href'));
              if (!href) { walk(n, parent); continue; }
              el.setAttribute('href', href);
            }
            if (tag === 'TD' || tag === 'TH') {
              if (n.colSpan > 1) el.colSpan = n.colSpan;
              if (n.rowSpan > 1) el.rowSpan = n.rowSpan;
            }
            if (tag === 'OL') {
              if (n.getAttribute('start')) el.setAttribute('start', n.getAttribute('start'));
              if (n.getAttribute('type')) el.setAttribute('type', n.getAttribute('type'));
            }
            copyStyle(n, el);
            walk(n, el);
            if (tag === 'SPAN' && !el.getAttribute('style')) { while (el.firstChild) parent.appendChild(el.firstChild); continue; }
            parent.appendChild(el);
            continue;
          }
          if (BLOCKISH.test(tag)) {
            const hasBlocks = Array.from(n.children).some((c) => isBlockEl(c) || BLOCKISH.test(c.tagName));
            if (hasBlocks) { walk(n, parent); continue; }
            const p = document.createElement('p');
            copyStyle(n, p);
            walk(n, p);
            parent.appendChild(p);
            continue;
          }
          if (tag === 'FONT') {
            const span = document.createElement('span');
            if (n.getAttribute('color')) span.style.color = n.getAttribute('color');
            if (n.getAttribute('face')) span.style.fontFamily = n.getAttribute('face');
            copyStyle(n, span);
            walk(n, span);
            parent.appendChild(span);
            continue;
          }
          walk(n, parent); // unknown wrapper: keep its content
        }
      };
      walk(src, out);
      return { html: out.innerHTML, droppedImages };
    }

    /* ================================================================== */
    /* Toolbar state                                                      */
    /* ================================================================== */
    scheduleStateUpdate() {
      if (this.stateFrame) return;
      this.stateFrame = requestAnimationFrame(() => { this.stateFrame = 0; this.updateState(); });
    }

    updateUndoButtons() {
      const undo = document.querySelector('[data-cmd="undo"]');
      const redo = document.querySelector('[data-cmd="redo"]');
      if (undo) undo.disabled = !this.history.canUndo();
      if (redo) redo.disabled = !this.history.canRedo();
    }

    updateState() {
      this.updateUndoButtons();
      const range = this.currentRange();
      if (!range) return;
      for (const cmd of TOGGLES) {
        let on = false;
        try { on = document.queryCommandState(cmd); } catch (e) { /* unsupported */ }
        const btn = document.querySelector(`[data-cmd="${cmd}"]`);
        if (btn) { btn.classList.toggle('is-active', on); btn.setAttribute('aria-pressed', String(on)); }
      }
      let node = range.startContainer;
      if (node.nodeType !== 1) node = node.parentElement;
      if (!node || !this.inEditor(node)) return;

      const block = node.closest('h1,h2,h3,h4,h5,h6,blockquote,p,li,td,th');
      const styleSel = document.getElementById('blockStyle');
      let tag = block ? block.tagName.toLowerCase() : 'p';
      if (block && block.closest('blockquote') && this.inEditor(block.closest('blockquote'))) tag = 'blockquote';
      if (/^(h5|h6)$/.test(tag)) tag = 'h4';
      if (tag === 'p' && block && block.classList.contains('title')) tag = 'title';
      if (tag === 'p' && block && block.classList.contains('subtitle')) tag = 'subtitle';
      if (!styleSel.querySelector(`option[value="${tag}"]`)) tag = 'p';
      if (document.activeElement !== styleSel) styleSel.value = tag;

      const cs = getComputedStyle(node);
      const fam = u.firstFontFamily(cs.fontFamily) || '';
      const fontSel = document.getElementById('fontFamily');
      if (document.activeElement !== fontSel) {
        let opt = Array.from(fontSel.options).find((o) => o.value.toLowerCase() === fam.toLowerCase());
        fontSel.querySelectorAll('option[data-dynamic]').forEach((o) => { if (o !== opt) o.remove(); });
        if (!opt && fam) {
          opt = new Option(fam, fam);
          opt.dataset.dynamic = '1';
          fontSel.add(opt, 0);
        }
        if (opt) fontSel.value = opt.value;
      }
      const sizeInput = document.getElementById('fontSize');
      if (document.activeElement !== sizeInput) {
        const pt = u.roundHalf(parseFloat(cs.fontSize) * 0.75);
        sizeInput.value = String(pt);
      }
      this.opts.onSelectionState && this.opts.onSelectionState({ inTable: !!this.closestInEditor('td,th') });
    }

    /* ================================================================== */
    /* Document load / reset                                              */
    /* ================================================================== */
    setContent(fragmentOrHtml) {
      this.hideResizer();
      this.root.innerHTML = '';
      if (typeof fragmentOrHtml === 'string') this.root.innerHTML = fragmentOrHtml;
      else this.root.appendChild(fragmentOrHtml);
      this.ensureBlocks();
      this.root.focus({ preventScroll: true });
      this.placeCaret(this.root.firstElementChild || this.root, true);
      const ws = this.root.closest('.workspace');
      if (ws) ws.scrollTop = 0;
      this.history.reset();
      this.scheduleStateUpdate();
    }
  }

  Folio.Editor = Editor;
})(window.Folio = window.Folio || {});
