import { copyText, downloadFile, toast, showMessage, bindActions, pickFile, enableDrop, readFileAsText, debounce, escapeHtml, confirmDialog } from '../../assets/js/components/ui.js';
import { editFor, countStats, buildHtmlDocument, guessTitle, SAMPLE } from './logic.js';
import { loadMarkdownLibs, renderMarkdown, addHeadingIds, highlightCode, handleAnchorClicks, syncHighlightTheme } from './render.js';

const MAX_FILE = 5 * 1024 * 1024;
const FILE_RE = /\.(md|markdown|mdown|txt)$/i;

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const input = $('#me-input'), preview = $('#me-preview'), panes = $('#me-panes'), msg = $('#me-msg');
    const state = { libsOk: false, html: '', fileName: ctx.storage.get('fileName', 'document.md'), disposed: false };
    const disposers = [];

    input.value = ctx.storage.get('draft', null) ?? SAMPLE;
    setMode(ctx.storage.get('mode', 'split'));

    // ---------- modes ----------
    function setMode(mode) {
      if (!['editor', 'split', 'preview'].includes(mode)) mode = 'split';
      panes.dataset.mode = mode; ctx.storage.set('mode', mode);
      root.querySelectorAll('[data-mode]').forEach(c => { if (c.classList.contains('chip')) c.classList.toggle('active', c.dataset.mode === mode); });
    }
    root.querySelectorAll('.chip[data-mode]').forEach(c => c.addEventListener('click', () => setMode(c.dataset.mode)));

    // ---------- preview ----------
    const renderPreview = () => {
      const md = input.value;
      if (!state.libsOk) {
        state.html = '';
        preview.innerHTML = `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
        return;
      }
      try {
        state.html = renderMarkdown(md);
        preview.innerHTML = state.html;
        addHeadingIds(preview);
        highlightCode(preview);
      } catch (e) { showMessage(msg, 'error', `Could not render Markdown: ${e.message}`); }
    };
    const stats = () => {
      const s = countStats(input.value);
      $('#me-stats').textContent = `${s.words} words · ${s.chars} chars · ${s.lines} lines`;
    };
    const save = debounce(() => {
      ctx.storage.set('draft', input.value);
      $('#me-saved').textContent = 'Draft saved';
    }, 500);
    const onInput = debounce(renderPreview, 120);
    input.addEventListener('input', () => { stats(); onInput(); $('#me-saved').textContent = ''; save(); });

    // ---------- formatting ----------
    function applyFormat(action) {
      const edit = editFor(action, input.value, input.selectionStart, input.selectionEnd);
      if (!edit) return;
      input.focus();
      // execCommand keeps the native undo stack; fall back to setRangeText where unsupported.
      input.setSelectionRange(edit.from, edit.to);
      let ok = false;
      try { ok = document.execCommand('insertText', false, edit.text); } catch { ok = false; }
      if (!ok) { input.setRangeText(edit.text, edit.from, edit.to, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }
      input.setSelectionRange(edit.selStart, edit.selEnd);
    }
    root.querySelector('.me-format').addEventListener('click', e => {
      const b = e.target.closest('[data-fmt]'); if (b) applyFormat(b.dataset.fmt);
    });
    input.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); applyFormat('bold'); }
        else if (k === 'i') { e.preventDefault(); applyFormat('italic'); }
        else if (k === 'k') { e.preventDefault(); applyFormat('link'); }
      } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        input.setRangeText(ctx.indentUnit, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    // ---------- files ----------
    async function openFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE) return showMessage(msg, 'error', `"${file.name}" is larger than 5 MB.`);
      if (!FILE_RE.test(file.name) && !(file.type || '').startsWith('text/')) {
        return showMessage(msg, 'error', `"${file.name}" is not a Markdown or text file (.md, .markdown, .txt).`);
      }
      try {
        const text = await readFileAsText(file);
        if (text.includes('\u0000')) return showMessage(msg, 'error', `"${file.name}" looks like a binary file.`);
        input.value = text; state.fileName = file.name.replace(/\.(txt)$/i, '.md');
        ctx.storage.set('fileName', state.fileName);
        showMessage(msg, null); stats(); renderPreview(); save();
        toast(`Opened ${file.name}`, 'success');
      } catch (e) { showMessage(msg, 'error', `Could not read file: ${e.message}`); }
    }
    disposers.push(enableDrop(input, openFile), enableDrop(preview, openFile));

    // ---------- export ----------
    const needHtml = () => {
      if (!state.libsOk) { showMessage(msg, 'error', 'HTML output needs the Markdown libraries, which could not be loaded. Check your connection and reload.'); return null; }
      if (!input.value.trim()) { toast('Nothing to export — the editor is empty', 'warn'); return null; }
      state.html = renderMarkdown(input.value);
      return state.html;
    };
    // Export HTML omits highlight.js markup (no stylesheet inline) so code is rendered as plain preformatted text.
    bindActions(root, {
      open: async () => openFile(await pickFile('.md,.markdown,.mdown,.txt,text/*')),
      'export-md': () => downloadFile(state.fileName.replace(/\.[^.]+$/, '') + '.md', input.value, 'text/markdown;charset=utf-8'),
      'export-html': () => {
        const html = needHtml(); if (!html) return;
        const tpl = document.createElement('template'); tpl.innerHTML = html;
        addHeadingIds(tpl.content);
        tpl.content.querySelectorAll('a[data-anchor]').forEach(a => a.removeAttribute('data-anchor'));
        downloadFile(state.fileName.replace(/\.[^.]+$/, '') + '.html', buildHtmlDocument(guessTitle(input.value), tpl.innerHTML), 'text/html;charset=utf-8');
      },
      'copy-md': () => copyText(input.value, 'Markdown copied'),
      'copy-html': () => { const html = needHtml(); if (html) copyText(html, 'HTML copied'); },
      clear: async () => {
        if (!input.value) return;
        if (!await confirmDialog('Clear editor', 'Remove all content? This cannot be undone.', 'Clear')) return;
        input.value = ''; state.fileName = 'document.md'; ctx.storage.set('fileName', state.fileName);
        stats(); renderPreview(); save();
      },
    });

    disposers.push(handleAnchorClicks(preview));
    stats();
    renderPreview(); // plain-text fallback until libs are ready

    // Load libraries lazily (not awaited so the shell can show the tool at once); the editor stays usable if this fails.
    loadMarkdownLibs().then(() => {
      if (state.disposed) return;
      state.libsOk = true;
      disposers.push(syncHighlightTheme());
      renderPreview();
    }).catch(e => { if (!state.disposed) showMessage(msg, 'error', e.message); });

    return () => { state.disposed = true; disposers.forEach(d => d()); };
  },
};
