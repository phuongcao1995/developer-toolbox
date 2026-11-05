/**
 * Folio — undo / redo history.
 *
 * The browser's native undo stack only knows about execCommand edits and is
 * wiped by any direct DOM change (tables, find & replace, imports). Folio keeps
 * its own stack of HTML snapshots instead, so every operation is undoable.
 *
 * Images are stored as short blob: URLs in the document, so snapshots stay
 * small even for documents with many pictures.
 */
(function (Folio) {
  'use strict';

  const MAX_STEPS = 300;
  const MAX_TOTAL_CHARS = 40 * 1024 * 1024; // safety cap on memory use

  class History {
    /**
     * @param {HTMLElement} root   the contenteditable element
     * @param {function} onChange  called whenever undo/redo availability changes
     */
    constructor(root, onChange) {
      this.root = root;
      this.onChange = onChange || (() => {});
      this.stack = [];
      this.index = -1;
      // Typing is grouped: a snapshot is taken after a short pause.
      this.scheduleTyping = Folio.util.debounce(() => this.record(), 500);
    }

    /** Forget everything and start from the current document state. */
    reset() {
      this.scheduleTyping.cancel();
      this.stack = [this.snapshot()];
      this.index = 0;
      this.onChange();
    }

    snapshot() {
      return { html: this.root.innerHTML, sel: this.saveCaret() };
    }

    /** Record the current state as a new step (no-op if nothing changed). */
    record() {
      this.scheduleTyping.cancel();
      const snap = this.snapshot();
      const cur = this.stack[this.index];
      if (cur && cur.html === snap.html) { cur.sel = snap.sel; return; }
      this.stack.splice(this.index + 1);
      this.stack.push(snap);
      this.index = this.stack.length - 1;
      this.trim();
      this.onChange();
    }

    /** Commit any pending typing so it becomes its own undo step. */
    flush() {
      if (this.scheduleTyping.pending()) this.record();
    }

    trim() {
      while (this.stack.length > MAX_STEPS) { this.stack.shift(); this.index--; }
      let total = this.stack.reduce((n, s) => n + s.html.length, 0);
      while (total > MAX_TOTAL_CHARS && this.stack.length > 2) {
        total -= this.stack.shift().html.length;
        this.index--;
      }
    }

    canUndo() { return this.index > 0 || this.scheduleTyping.pending(); }
    canRedo() { return this.index < this.stack.length - 1; }

    undo() {
      this.flush();
      if (this.index <= 0) return false;
      this.index--;
      this.restore(this.stack[this.index]);
      return true;
    }

    redo() {
      if (!this.canRedo()) return false;
      this.index++;
      this.restore(this.stack[this.index]);
      return true;
    }

    restore(snap) {
      this.root.innerHTML = snap.html;
      this.restoreCaret(snap.sel);
      this.onChange();
    }

    /* ------------------------------------------------------------------ */
    /* Caret persistence as character offsets (robust to DOM replacement) */
    /* ------------------------------------------------------------------ */
    saveCaret() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      if (!this.root.contains(r.startContainer)) return null;
      return { start: this.offsetOf(r.startContainer, r.startOffset), end: this.offsetOf(r.endContainer, r.endOffset) };
    }

    offsetOf(node, offset) {
      const r = document.createRange();
      r.selectNodeContents(this.root);
      try { r.setEnd(node, offset); } catch (e) { return 0; }
      return r.toString().length;
    }

    restoreCaret(pos) {
      if (!pos) return;
      const start = this.pointAt(pos.start);
      const end = this.pointAt(pos.end);
      if (!start || !end) return;
      const r = document.createRange();
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    pointAt(target) {
      const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
      let n, acc = 0, last = null;
      while ((n = walker.nextNode())) {
        const len = n.data.length;
        if (acc + len >= target) return { node: n, offset: target - acc };
        acc += len;
        last = n;
      }
      if (last) return { node: last, offset: last.data.length };
      return { node: this.root, offset: 0 };
    }
  }

  Folio.History = History;
})(window.Folio = window.Folio || {});
