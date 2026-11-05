/**
 * Folio — find & replace.
 *
 * Matches are found in a flattened copy of the document text, so a match
 * can span formatting boundaries ("he<b>llo</b>"). Matches never cross
 * paragraph boundaries. Highlighting uses the CSS Custom Highlight API where
 * available (no DOM changes); otherwise only the current match is selected.
 */
(function (Folio) {
  'use strict';

  const u = Folio.util;
  const BLOCK = /^(P|H[1-6]|LI|TD|TH|BLOCKQUOTE|PRE|DIV|TABLE|TR|UL|OL)$/;
  const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  class FindReplace {
    constructor(editor) {
      this.editor = editor;
      this.root = editor.root;
      this.matches = [];
      this.current = -1;
      this.$ = (id) => document.getElementById(id);
      this.panel = this.$('findPanel');
      this.input = this.$('findInput');
      this.replaceInput = this.$('replaceInput');
      this.refresh = u.debounce(() => this.search(false), 150);
      this.bind();
    }

    bind() {
      this.input.addEventListener('input', () => this.refresh());
      this.$('findCase').addEventListener('change', () => this.search(false));
      this.$('findWord').addEventListener('change', () => this.search(false));
      this.$('findNext').addEventListener('click', () => this.step(1));
      this.$('findPrev').addEventListener('click', () => this.step(-1));
      this.$('replaceOne').addEventListener('click', () => this.replaceCurrent());
      this.$('replaceAll').addEventListener('click', () => this.replaceAll());
      this.$('findClose').addEventListener('click', () => this.close());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      });
      this.replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.replaceCurrent(); }
        if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      });
      // Document edits invalidate match positions.
      this.root.addEventListener('input', () => { if (!this.panel.hidden) this.refresh(); });
    }

    open(focusReplace) {
      // Sit just below the toolbar, whose height changes when it wraps.
      this.panel.style.top = (document.getElementById('toolbar').getBoundingClientRect().bottom + 8) + 'px';
      this.panel.hidden = false;
      const sel = window.getSelection();
      const text = sel && sel.rangeCount ? sel.toString() : '';
      if (text && text.length < 100 && !text.includes('\n')) this.input.value = text;
      (focusReplace ? this.replaceInput : this.input).focus();
      this.input.select();
      this.search(false);
    }

    close() {
      this.panel.hidden = true;
      this.clearHighlights();
      this.matches = [];
      this.editor.restoreSelection();
    }

    /* ---------- searching ---------- */
    /** Flatten text nodes; a \u0000 separator stops matches crossing blocks. */
    buildIndex() {
      const nodes = [];
      let text = '';
      let lastBlock = null;
      const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        let b = n.parentElement;
        while (b && b !== this.root && !BLOCK.test(b.tagName)) b = b.parentElement;
        if (b !== lastBlock) { text += '\u0000'; lastBlock = b; }
        nodes.push({ node: n, start: text.length });
        text += n.data;
      }
      return { text, nodes };
    }

    pattern() {
      const q = this.input.value;
      if (!q) return null;
      let src = u.escapeRegExp(q);
      if (this.$('findWord').checked) src = '(?<![\\p{L}\\p{N}_])' + src + '(?![\\p{L}\\p{N}_])';
      return new RegExp(src, 'gu' + (this.$('findCase').checked ? '' : 'i'));
    }

    /** Map a flat-text offset back to (node, offset). */
    locate(index, pos, isEnd) {
      const list = index.nodes;
      let lo = 0, hi = list.length - 1, found = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].start <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      let entry = list[found];
      // An end offset exactly at a node boundary belongs to the previous node.
      if (isEnd && pos === entry.start && found > 0) entry = list[found - 1];
      return { node: entry.node, offset: Math.min(pos - entry.start, entry.node.data.length) };
    }

    search(keepPosition) {
      this.clearHighlights();
      this.matches = [];
      const re = this.pattern();
      if (!re) { this.current = -1; this.updateCount(); return; }
      const index = this.buildIndex();
      let m;
      while ((m = re.exec(index.text))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const s = this.locate(index, m.index, false);
        const e = this.locate(index, m.index + m[0].length, true);
        const r = document.createRange();
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
        this.matches.push(r);
        if (this.matches.length >= 5000) break;
      }
      if (!keepPosition) this.current = this.matches.length ? this.firstAfterCaret() : -1;
      else this.current = Math.min(this.current, this.matches.length - 1);
      this.paint();
    }

    firstAfterCaret() {
      const caret = this.editor.savedRange;
      if (!caret) return 0;
      const i = this.matches.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, caret) >= 0);
      return i < 0 ? 0 : i;
    }

    step(dir) {
      if (!this.matches.length) { this.search(false); if (!this.matches.length) return; }
      else this.current = (this.current + dir + this.matches.length) % this.matches.length;
      this.paint(true);
    }

    paint(scroll) {
      this.updateCount();
      if (hasHighlights) {
        CSS.highlights.set('folio-find', new Highlight(...this.matches));
        if (this.current >= 0) CSS.highlights.set('folio-find-current', new Highlight(this.matches[this.current]));
      }
      const r = this.matches[this.current];
      if (!r) return;
      // Select the current match so it is visible even without highlights.
      if (!hasHighlights || scroll) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r.cloneRange());
        this.editor.savedRange = r.cloneRange();
      }
      const el = r.startContainer.parentElement;
      if (el) {
        const rect = r.getBoundingClientRect();
        const ws = document.getElementById('workspace').getBoundingClientRect();
        if (rect.top < ws.top + 60 || rect.bottom > ws.bottom - 40) el.scrollIntoView({ block: 'center' });
      }
    }

    clearHighlights() {
      if (hasHighlights) { CSS.highlights.delete('folio-find'); CSS.highlights.delete('folio-find-current'); }
    }

    updateCount() {
      const c = this.$('findCount');
      if (!this.input.value) c.textContent = '';
      else if (!this.matches.length) c.textContent = 'No results';
      else c.textContent = `${this.current + 1} of ${this.matches.length}`;
    }

    /* ---------- replacing ---------- */
    /** Replace a range's text, keeping the formatting of its first character. */
    replaceRange(r, text) {
      const sNode = r.startContainer, sOff = r.startOffset;
      if (sNode === r.endContainer) {
        sNode.replaceData(sOff, r.endOffset - sOff, text);
        return;
      }
      sNode.replaceData(sOff, sNode.data.length - sOff, text);
      const rest = document.createRange();
      rest.setStart(sNode, sOff + text.length);
      rest.setEnd(r.endContainer, r.endOffset);
      rest.deleteContents();
    }

    replaceCurrent() {
      if (!this.matches.length) { this.search(false); if (!this.matches.length) return; }
      const r = this.matches[this.current];
      if (!r) return;
      const text = this.replaceInput.value;
      this.editor.transact(() => this.replaceRange(r, text));
      this.search(true);
      if (this.matches.length) this.paint(true);
    }

    replaceAll() {
      this.search(false);
      const n = this.matches.length;
      if (!n) { Folio.ui.toast('No matches to replace.'); return; }
      const text = this.replaceInput.value;
      // Work backwards so earlier ranges stay valid.
      this.editor.transact(() => { for (let i = n - 1; i >= 0; i--) this.replaceRange(this.matches[i], text); });
      this.search(false);
      Folio.ui.toast(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}.`);
    }
  }

  Folio.FindReplace = FindReplace;
})(window.Folio = window.Folio || {});
