import { copyText, downloadFile, toast, showMessage, bindActions, pickFile, enableDrop, readFileAsText, escapeHtml, formatBytes } from '../../assets/js/components/ui.js';
import { validateFile, looksBinary, tocWithDepth, downloadName, MAX_BYTES } from './logic.js';
import { loadMarkdownLibs, renderMarkdown, addHeadingIds, highlightCode, handleAnchorClicks, syncHighlightTheme } from '../markdown-editor/render.js';

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const msg = $('#mv-msg'), article = $('#mv-article'), tocList = $('#mv-toc'), layout = $('#mv-layout'), empty = $('#mv-empty');
    const pastePanel = $('#mv-paste'), pasteInput = $('#mv-paste-input'), info = $('#mv-fileinfo');
    const state = { source: '', name: '', size: 0, libs: null, disposed: false, observer: null };
    const disposers = [];

    // Libraries are loaded once, on demand, and shared by every render call.
    const libs = () => state.libs ??= loadMarkdownLibs().then(() => { if (!state.disposed) disposers.push(syncHighlightTheme()); });

    // ---------- active heading tracking ----------
    function setActive(id) {
      tocList.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.id === id));
      // Keep the active entry visible inside the TOC list only (never scroll the page itself).
      const act = tocList.querySelector('a.active');
      if (act && (act.offsetTop < tocList.scrollTop || act.offsetTop + act.offsetHeight > tocList.scrollTop + tocList.clientHeight)) {
        tocList.scrollTop = act.offsetTop - tocList.clientHeight / 2;
      }
    }
    function observeHeadings() {
      state.observer?.disconnect();
      const heads = [...article.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      if (!heads.length || !('IntersectionObserver' in window)) return;
      const visible = new Set();
      // Band near the top of the viewport; the topmost heading inside it (or the last one passed) is "active".
      state.observer = new IntersectionObserver(entries => {
        for (const en of entries) en.isIntersecting ? visible.add(en.target) : visible.delete(en.target);
        const top = heads.find(h => visible.has(h));
        if (top) setActive(top.id);
        else {
          // No heading in the band: use the last heading above the viewport.
          const above = heads.filter(h => h.getBoundingClientRect().top < 0).pop();
          if (above) setActive(above.id);
        }
      }, { rootMargin: '0px 0px -70% 0px', threshold: 0 });
      heads.forEach(h => state.observer.observe(h));
    }

    // ---------- render ----------
    async function show(text, name, size) {
      state.source = text; state.name = name; state.size = size;
      showMessage(msg, null);
      if (!text.trim()) {
        showMessage(msg, 'warn', 'The document is empty — nothing to display.');
        layout.hidden = true; empty.hidden = false; setButtons(false); info.hidden = true;
        return;
      }
      try { await libs(); } catch (e) { state.libs = null; showMessage(msg, 'error', e.message); return; }
      if (state.disposed) return;
      try {
        article.innerHTML = renderMarkdown(text);
        const toc = tocWithDepth(addHeadingIds(article));
        highlightCode(article);
        tocList.innerHTML = toc.length
          ? toc.map(t => `<li><a data-id="${escapeHtml(t.id)}" style="padding-left:${8 + t.depth * 14}px" role="link" tabindex="0">${escapeHtml(t.text)}</a></li>`).join('')
          : '<li class="mv-toc-empty">No headings in this document.</li>';
        empty.hidden = true; layout.hidden = false; setButtons(true);
        info.hidden = false;
        info.innerHTML = `<b>${escapeHtml(name)}</b> · ${formatBytes(size)}`;
        observeHeadings();
        if (toc[0]) setActive(toc[0].id);
      } catch (e) { showMessage(msg, 'error', `Could not render Markdown: ${e.message}`); }
    }
    const setButtons = on => { $('#mv-copy').disabled = !on; $('#mv-download').disabled = !on; };

    // ---------- file loading ----------
    async function loadFile(file) {
      if (!file) return;
      const v = validateFile(file);
      if (!v.ok) return showMessage(msg, 'error', v.error);
      try {
        const text = await readFileAsText(file);
        if (looksBinary(text)) return showMessage(msg, 'error', `"${file.name}" appears to be a binary file, not text.`);
        pastePanel.hidden = true; $('#mv-paste-btn').classList.remove('active');
        await show(text, file.name, file.size);
      } catch (e) { showMessage(msg, 'error', `Could not read "${file.name}": ${e.message}`); }
    }

    // ---------- TOC ----------
    function goTo(id) {
      const h = [...article.querySelectorAll('[id]')].find(n => n.id === id);
      if (!h) return;
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(id);
      if (matchMedia('(max-width: 900px)').matches) $('#mv-toc-wrap').classList.add('collapsed');
    }
    tocList.addEventListener('click', e => { const a = e.target.closest('a[data-id]'); if (a) goTo(a.dataset.id); });
    tocList.addEventListener('keydown', e => { const a = e.target.closest('a[data-id]'); if (a && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goTo(a.dataset.id); } });
    disposers.push(handleAnchorClicks(article));

    // ---------- actions ----------
    bindActions(root, {
      open: async () => loadFile(await pickFile('.md,.markdown,.mdown,.mkd,.txt,text/*')),
      'toggle-paste': () => {
        pastePanel.hidden = !pastePanel.hidden;
        $('#mv-paste-btn').classList.toggle('active', !pastePanel.hidden);
        if (!pastePanel.hidden) pasteInput.focus();
      },
      'render-paste': () => {
        const t = pasteInput.value;
        if (!t.trim()) return showMessage(msg, 'error', 'Paste some Markdown first.');
        if (new Blob([t]).size > MAX_BYTES) return showMessage(msg, 'error', 'Pasted text is larger than 5 MB.');
        show(t, 'pasted.md', new Blob([t]).size);
      },
      'clear-paste': () => { pasteInput.value = ''; pasteInput.focus(); },
      'toggle-toc': () => $('#mv-toc-wrap').classList.toggle('collapsed'),
      copy: () => copyText(state.source, 'Markdown source copied'),
      download: () => state.source ? downloadFile(downloadName(state.name), state.source, 'text/markdown;charset=utf-8') : toast('Nothing to download', 'warn'),
    });
    disposers.push(enableDrop(empty, loadFile), enableDrop(layout, loadFile));

    return () => { state.disposed = true; state.observer?.disconnect(); disposers.forEach(d => d()); };
  },
};
