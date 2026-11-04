import { copyText, downloadFile, toast, showMessage, bindActions, pickFile, enableDrop, readFileAsText, escapeHtml, formatBytes } from '../../assets/js/components/ui.js';
import { validateFile, looksBinary, tocWithDepth, downloadName, parseFrontMatter, findMatches, MAX_BYTES } from './logic.js';
import {
  loadMarkdownLibs, renderMarkdown, addHeadingIds, highlightCode, handleAnchorClicks, syncHighlightTheme, findHeading,
  hasMermaid, renderMermaidBlocks, printScoped,
} from '../markdown-editor/render.js';

const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const MAX_MARKS = 3000;
const REL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i; // anything else is a relative reference

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const msg = $('#mv-msg'), note = $('#mv-note'), spin = $('#mv-spin'), article = $('#mv-article'), tocList = $('#mv-toc'), layout = $('#mv-layout'), empty = $('#mv-empty');
    const pastePanel = $('#mv-paste'), pasteInput = $('#mv-paste-input'), info = $('#mv-fileinfo');
    const fmEl = $('#mv-fm'), fmText = $('#mv-fm-text');
    const searchBar = $('#mv-search'), sq = $('#mv-search-q'), scase = $('#mv-search-case'), scount = $('#mv-search-count');
    const state = { source: '', name: '', size: 0, libs: null, disposed: false, observer: null, seq: 0, marks: [], cur: -1 };
    const disposers = [];
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    const on = (target, type, fn) => { target.addEventListener(type, fn); disposers.push(() => target.removeEventListener(type, fn)); };

    // Libraries are loaded once, on demand, and shared by every render call.
    const libs = () => state.libs ??= loadMarkdownLibs().then(() => { if (!state.disposed) disposers.push(syncHighlightTheme()); });

    // ---------- active heading tracking (one IntersectionObserver for all headings) ----------
    function setActive(id) {
      tocList.querySelectorAll('a').forEach(a => { const act = a.dataset.id === id; a.classList.toggle('active', act); if (act) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current'); });
      // Keep the active entry visible inside the TOC list only (never scroll the page itself).
      const act = tocList.querySelector('a.active');
      if (act && (act.offsetTop < tocList.scrollTop || act.offsetTop + act.offsetHeight > tocList.scrollTop + tocList.clientHeight)) {
        tocList.scrollTop = act.offsetTop - tocList.clientHeight / 2;
      }
    }
    function observeHeadings() {
      state.observer?.disconnect(); state.observer = null;
      const heads = [...article.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      if (!heads.length || !('IntersectionObserver' in window)) return;
      const visible = new Set();
      // Band near the top of the viewport; the topmost heading inside it (or the last one passed) is "active".
      state.observer = new IntersectionObserver(entries => {
        for (const en of entries) en.isIntersecting ? visible.add(en.target) : visible.delete(en.target);
        const top = heads.find(h => visible.has(h));
        if (top) setActive(top.id);
        else {
          const above = heads.filter(h => h.getBoundingClientRect().top < 0).pop();
          if (above) setActive(above.id);
        }
      }, { rootMargin: '0px 0px -70% 0px', threshold: 0 });
      heads.forEach(h => state.observer.observe(h));
    }

    // ---------- post-processing of the rendered article ----------
    function addAnchorButtons() {
      article.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
        if (!h.id) return;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'mv-anchor-btn'; b.dataset.id = h.id; b.textContent = '#';
        b.setAttribute('aria-label', `Copy link to section: ${h.textContent.trim()}`); b.title = 'Copy link to this heading';
        h.append(b);
      });
    }
    // Relative images/links are NOT resolved: the document is opened without its folder.
    function showNote(text) { note.hidden = false; note.textContent = text; }
    const REL_NOTE = 'Relative image paths and links are not resolved, because the file is opened without its folder. Images that cannot load are shown as their alt text.';
    function guardImages() {
      article.querySelectorAll('img').forEach(img => {
        const fail = () => {
          const rel = !REL_RE.test(img.getAttribute('src') || '');
          const span = document.createElement('span');
          span.className = 'md-img-missing'; span.textContent = img.alt ? `[image: ${img.alt}]` : '[image not available]';
          span.title = rel ? 'Relative image path (not resolved)' : 'Image could not be loaded';
          img.replaceWith(span);
          if (rel) showNote(REL_NOTE);
        };
        if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail();
        else img.addEventListener('error', fail, { once: true });
      });
    }
    on(article, 'click', e => {
      const btn = e.target.closest('.mv-anchor-btn');
      if (btn) { copyText(`#${btn.dataset.id}`, `Copied anchor #${btn.dataset.id}`); return; }
      const a = e.target.closest('a[href]');
      if (a && !a.hasAttribute('data-anchor') && !REL_RE.test(a.getAttribute('href') || '')) {
        e.preventDefault(); showNote(REL_NOTE);
      }
    });

    // ---------- render ----------
    async function show(text, name, size) {
      const seq = ++state.seq, stale = () => seq !== state.seq || state.disposed;
      state.source = text; state.name = name; state.size = size;
      showMessage(msg, null); note.hidden = true; clearMarks(); closeSearch();
      if (!text.trim()) {
        showMessage(msg, 'warn', 'The document is empty — nothing to display.');
        layout.hidden = true; empty.hidden = false; setButtons(false); info.hidden = true;
        return;
      }
      try { await libs(); } catch (e) { state.libs = null; showMessage(msg, 'error', e.message); return; }
      if (stale()) return;
      const slow = text.length > 50000;
      if (slow) { spin.hidden = false; await nextFrame(); if (stale()) return; }
      try {
        const fm = parseFrontMatter(text);
        article.innerHTML = renderMarkdown(fm.body);
        fmEl.hidden = fm.raw === null; fmText.textContent = fm.raw ?? ''; // escaped text only
        const toc = tocWithDepth(addHeadingIds(article));
        highlightCode(article);
        tocList.innerHTML = toc.length
          ? toc.map(t => `<li><a data-id="${escapeHtml(t.id)}" style="padding-left:${8 + t.depth * 14}px" role="link" tabindex="0">${escapeHtml(t.text)}</a></li>`).join('')
          : '<li class="mv-toc-empty">No headings in this document.</li>';
        addAnchorButtons(); guardImages();
        empty.hidden = true; layout.hidden = false; setButtons(true);
        info.hidden = false;
        info.innerHTML = `<b>${escapeHtml(name)}</b> · ${formatBytes(size)}`;
        observeHeadings();
        if (toc[0]) setActive(toc[0].id);
        if (hasMermaid(article)) { spin.hidden = false; await renderMermaidBlocks(article, { isStale: stale }); }
      } catch (e) { showMessage(msg, 'error', `Could not render Markdown: ${e.message}`); }
      finally { if (!stale()) spin.hidden = true; }
    }
    const setButtons = on_ => { for (const id of ['mv-copy', 'mv-download', 'mv-print', 'mv-search-btn']) $('#' + id).disabled = !on_; };

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
      const h = findHeading(article, id); // renderer-generated heading ids only
      if (!h) return;
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(id);
      if (matchMedia('(max-width: 900px)').matches) setTocCollapsed(true);
    }
    function setTocCollapsed(c) {
      $('#mv-toc-wrap').classList.toggle('collapsed', c);
      $('.mv-toc-toggle').setAttribute('aria-expanded', String(!c));
    }
    on(tocList, 'click', e => { const a = e.target.closest('a[data-id]'); if (a) goTo(a.dataset.id); });
    on(tocList, 'keydown', e => { const a = e.target.closest('a[data-id]'); if (a && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goTo(a.dataset.id); } });
    disposers.push(handleAnchorClicks(article));

    // ---------- in-document search (safe DOM walk: text nodes are split, never re-parsed as HTML) ----------
    function clearMarks() {
      const parents = new Set();
      for (const m of article.querySelectorAll('mark.mv-hit')) {
        const p = m.parentNode; if (!p) continue;
        p.replaceChild(document.createTextNode(m.textContent), m); parents.add(p);
      }
      parents.forEach(p => p.normalize());
      state.marks = []; state.cur = -1; scount.textContent = '';
    }
    function runSearch() {
      clearMarks();
      const q = sq.value;
      if (!q) return;
      const opts = { caseSensitive: scase.getAttribute('aria-pressed') === 'true' };
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.parentElement?.closest('script,style,.mv-anchor-btn') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const nodes = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
      const marks = [];
      for (const node of nodes) {
        if (marks.length >= MAX_MARKS) break;
        const { matches } = findMatches(node.data, q, opts);
        const local = [];
        for (let i = matches.length - 1; i >= 0; i--) { // back to front so earlier offsets stay valid
          const m = matches[i];
          node.splitText(m.index + m.length);
          const hit = node.splitText(m.index);
          const mark = document.createElement('mark'); mark.className = 'mv-hit';
          hit.parentNode.replaceChild(mark, hit); mark.append(hit);
          local.unshift(mark);
        }
        marks.push(...local);
      }
      state.marks = marks.slice(0, MAX_MARKS);
      if (!marks.length) { scount.textContent = 'No results'; return; }
      goToMark(0);
    }
    function goToMark(i) {
      const n = state.marks.length; if (!n) return;
      state.marks[state.cur]?.classList.remove('current');
      state.cur = (i + n) % n;
      const m = state.marks[state.cur]; m.classList.add('current');
      m.scrollIntoView({ block: 'center', behavior: 'auto' });
      scount.textContent = `${state.cur + 1} of ${n}${n >= MAX_MARKS ? '+' : ''}`;
    }
    function openSearch() {
      if (layout.hidden) return;
      searchBar.hidden = false; sq.focus(); sq.select();
      if (sq.value) runSearch();
    }
    function closeSearch() { if (searchBar.hidden) return; searchBar.hidden = true; clearMarks(); }
    let searchTimer = 0;
    on(sq, 'input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
    disposers.push(() => clearTimeout(searchTimer));
    on(scase, 'click', () => { const p = scase.getAttribute('aria-pressed') !== 'true'; scase.setAttribute('aria-pressed', String(p)); scase.classList.toggle('active', p); runSearch(); });
    on(searchBar, 'click', e => {
      const b = e.target.closest('[data-search]'); if (!b) return;
      if (b.dataset.search === 'close') { closeSearch(); $('#mv-main').focus(); }
      else { if (!state.marks.length) runSearch(); else goToMark(state.cur + (b.dataset.search === 'next' ? 1 : -1)); }
    });
    on(searchBar, 'keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); $('#mv-main').focus(); }
      else if (e.key === 'Enter' && e.target === sq) {
        e.preventDefault(); clearTimeout(searchTimer);
        if (!state.marks.length) runSearch(); else goToMark(state.cur + (e.shiftKey ? -1 : 1));
      }
    });
    // Ctrl/Cmd+F only inside the tool (focus within the viewer); elsewhere the browser's own find applies.
    on(root, 'keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !layout.hidden) {
        if (e.target.closest('#mv-paste')) return;
        e.preventDefault(); openSearch();
      }
    });

    // ---------- print ----------
    let printCleanup = null;
    disposers.push(() => printCleanup?.());

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
      'toggle-toc': () => setTocCollapsed(!$('#mv-toc-wrap').classList.contains('collapsed')),
      search: () => openSearch(),
      print: () => {
        if (layout.hidden) return;
        closeSearch(); // search marks must not be printed
        const t = `.tool-${ctx.toolId}`;
        printCleanup?.();
        printCleanup = printScoped(`${t} .mv-article`, () => { printCleanup = null; },
          `${t} .mv-layout,${t} .mv-main{display:block!important;overflow:visible!important;height:auto!important}${t} .mv-toc,${t} .mv-anchor-btn{display:none!important}`);
      },
      copy: () => copyText(state.source, 'Markdown source copied'),
      download: () => state.source ? downloadFile(downloadName(state.name), state.source, 'text/markdown;charset=utf-8') : toast('Nothing to download', 'warn'),
    });
    disposers.push(enableDrop(empty, loadFile), enableDrop(layout, loadFile));

    return () => {
      state.disposed = true; state.seq++; state.observer?.disconnect();
      timers.forEach(clearTimeout);
      disposers.forEach(d => { try { d(); } catch { /* ignore */ } });
    };
  },
};
