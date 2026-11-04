import { copyText, downloadFile, toast, showMessage, bindActions, pickFile, enableDrop, readFileAsText, confirmDialog } from '../../assets/js/components/ui.js';
import {
  continueList, indentEdit, outdentEdit, findMatches, replaceAll, replaceAt, interpolate, parseFrontMatter, buildToc,
  renderDelay, validateImport, hasNul, editFor, countStats, buildHtmlDocument, guessTitle, SAMPLE,
} from './logic.js';
import {
  loadMarkdownLibs, renderMarkdown, addHeadingIds, highlightCode, handleAnchorClicks, syncHighlightTheme, findHeading,
  hasMermaid, renderMermaidBlocks, mermaidForExport, printScoped,
} from './render.js';

const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const input = $('#me-input'), preview = $('#me-preview'), docEl = $('#me-doc'), panes = $('#me-panes'), msg = $('#me-msg');
    const fmEl = $('#me-fm'), fmText = $('#me-fm-text'), tocWrap = $('#me-toc-wrap'), tocList = $('#me-toc');
    const sep = $('#me-splitter'), spin = $('#me-spin'), staleEl = $('#me-stale'), notice = $('#me-notice'), renderBtn = $('#me-render');
    const findBar = $('#me-find'), fq = $('#me-find-q'), fr = $('#me-find-r'), fcase = $('#me-find-case'), fre = $('#me-find-re'), fcount = $('#me-find-count');
    const fsBtn = $('#me-fullscreen');

    const state = {
      libsOk: false, fileName: ctx.storage.get('fileName', 'document.md'), disposed: false, renderError: false,
      mode: 'split', orient: 'row', split: 50, sync: true, wrap: true, tocOpen: false, fs: 13,
      seq: 0, manual: false, toc: [], srcHeads: [], headEls: [], activeIdx: -1,
      lock: null, noSyncUntil: 0, ver: 0, edTops: null, tabReleased: false, matches: [],
    };
    const disposers = [];
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); disposers.push(() => target.removeEventListener(type, fn, opts)); };

    // toast()/confirm dialogs live outside the fullscreen element and would be invisible there: use the inline box instead.
    const notify = (text, type = 'success') => {
      if (document.fullscreenElement) showMessage(msg, type === 'success' ? 'info' : type, text);
      else toast(text, type);
    };
    const setPressed = (btn, on) => { btn.setAttribute('aria-pressed', String(!!on)); btn.classList.toggle('active', !!on); };

    input.value = ctx.storage.get('draft', null) ?? SAMPLE;
    input.title = 'Tab indents. Press Esc, then Tab, to leave the editor with the keyboard.';

    // ---------- geometry helpers (hidden mirror measures where text offsets sit inside the wrapped textarea) ----------
    let mirror = null;
    function mirrorTops(offsets) {
      if (!input.clientWidth) return null;
      if (!mirror) { mirror = document.createElement('div'); mirror.className = 'me-mirror'; mirror.setAttribute('aria-hidden', 'true'); $('#me-editor-pane').append(mirror); }
      const cs = getComputedStyle(input);
      for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) mirror.style[p] = cs[p];
      mirror.style.boxSizing = 'border-box'; mirror.style.width = `${input.clientWidth}px`;
      mirror.textContent = '';
      const val = input.value, spans = [];
      let last = 0;
      for (const off of offsets) {
        mirror.append(document.createTextNode(val.slice(last, off)));
        const sp = document.createElement('span'); sp.textContent = '​'; mirror.append(sp); spans.push(sp); last = off;
      }
      mirror.append(document.createTextNode(val.slice(last)));
      return spans.map(s => s.offsetTop);
    }
    const edTops = () => {
      if (!state.srcHeads.length || input.value.length > 1.5e6) return null;
      const c = state.edTops;
      if (c && c.ver === state.ver && c.w === input.clientWidth) return c.tops;
      const tops = mirrorTops(state.srcHeads.map(h => h.offset));
      state.edTops = tops && { ver: state.ver, w: input.clientWidth, tops };
      return tops;
    };
    function scrollEditorToOffset(off, margin = 8) {
      const top = mirrorTops([off])?.[0];
      if (top != null) setScroll(input, Math.max(0, top - margin));
    }

    // ---------- scroll sync (feedback-loop safe) ----------
    function setScroll(el, v) {
      v = clamp(v, 0, Math.max(0, el.scrollHeight - el.clientHeight));
      if (Math.abs(el.scrollTop - v) < 1) return;
      el.scrollTop = v;
      state.lock = el === input ? 'editor' : 'preview'; // swallow the scroll event this write causes
      later(() => { state.lock = null; }, 150);
    }
    function anchors() {
      const heads = state.headEls, tops = edTops();
      if (!tops || !heads.length || tops.length !== heads.length) return null;
      const pairs = [[0, 0]];
      tops.forEach((t, i) => { const p = heads[i].offsetTop, last = pairs[pairs.length - 1]; if (t >= last[0] && p >= last[1]) pairs.push([t, p]); });
      pairs.push([Math.max(0, input.scrollHeight - input.clientHeight), Math.max(0, preview.scrollHeight - preview.clientHeight)]);
      return pairs.filter((p, i) => i === 0 || (p[0] >= pairs[i - 1][0] && p[1] >= pairs[i - 1][1]));
    }
    function doSync(which) {
      if (!state.sync || state.mode !== 'split') return;
      const src = which === 'editor' ? input : preview, dst = which === 'editor' ? preview : input;
      const a = anchors();
      let target;
      if (a) target = interpolate(which === 'editor' ? a : a.map(([x, y]) => [y, x]), src.scrollTop); // heading-anchored
      else { const max = src.scrollHeight - src.clientHeight; target = (max > 0 ? src.scrollTop / max : 0) * (dst.scrollHeight - dst.clientHeight); } // proportional
      setScroll(dst, target);
    }
    let pendingSync = null, rafSync = 0;
    function onScroll(which) {
      if (state.lock === which) { state.lock = null; return; }
      if (performance.now() < state.noSyncUntil) return;
      pendingSync = which;
      if (!rafSync) rafSync = requestAnimationFrame(() => { rafSync = 0; const w = pendingSync; pendingSync = null; if (w) { doSync(w); updateActive(); } });
    }
    on(input, 'scroll', () => onScroll('editor'));
    on(preview, 'scroll', () => onScroll('preview'));
    disposers.push(() => cancelAnimationFrame(rafSync));

    // ---------- table of contents ----------
    function buildTocList() {
      tocList.textContent = '';
      if (!state.toc.length) {
        const li = document.createElement('li'); li.className = 'me-toc-empty'; li.textContent = 'No headings yet.'; tocList.append(li); return;
      }
      const min = Math.min(...state.toc.map(t => t.level));
      state.toc.forEach((t, i) => {
        const li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button'; b.className = 'me-toc-link'; b.dataset.i = i; b.textContent = t.text || '(empty heading)';
        b.style.paddingLeft = `${8 + Math.min(t.level - min, 5) * 12}px`;
        li.append(b); tocList.append(li);
      });
      state.activeIdx = -1;
    }
    function updateActive() {
      if (!state.tocOpen || !state.toc.length) return;
      let idx = -1;
      if (state.mode === 'editor') {
        const tops = edTops();
        if (tops && tops.length === state.toc.length) { const y = input.scrollTop + 24; tops.forEach((t, i) => { if (t <= y) idx = i; }); }
      } else {
        const y = preview.scrollTop + 24;
        state.headEls.forEach((h, i) => { if (h.offsetTop <= y) idx = i; });
      }
      if (idx === state.activeIdx) return;
      state.activeIdx = idx;
      tocList.querySelectorAll('.me-toc-link').forEach((b, i) => {
        const act = i === idx; b.classList.toggle('active', act);
        if (act) { b.setAttribute('aria-current', 'location'); if (b.offsetTop < tocList.scrollTop || b.offsetTop + b.offsetHeight > tocList.scrollTop + tocList.clientHeight) tocList.scrollTop = b.offsetTop - tocList.clientHeight / 2; }
        else b.removeAttribute('aria-current');
      });
    }
    function goToHeading(i) {
      const t = state.toc[i]; if (!t) return;
      const toPreview = state.mode !== 'editor', toEditor = state.mode !== 'preview';
      const h = findHeading(docEl, t.id);
      if (toPreview && h) setScroll(preview, h.offsetTop - 8);
      // In split mode with sync on the editor follows the preview; otherwise move it explicitly.
      const sh = state.srcHeads.length === state.toc.length ? state.srcHeads[i] : null;
      if (toEditor && sh && (!toPreview || !state.sync)) scrollEditorToOffset(sh.offset);
      state.activeIdx = -1; updateActive();
    }
    on(tocList, 'click', e => { const b = e.target.closest('.me-toc-link'); if (b) goToHeading(+b.dataset.i); });
    function setToc(open, persist = true) {
      state.tocOpen = !!open; tocWrap.hidden = !open;
      const b = $('#me-toc-btn'); setPressed(b, open); b.setAttribute('aria-expanded', String(!!open));
      if (persist) ctx.storage.set('tocOpen', !!open);
      state.edTops = null; updateActive();
    }

    // ---------- modes / layout ----------
    function setMode(mode, persist = true) {
      if (!['editor', 'split', 'preview'].includes(mode)) mode = 'split';
      state.mode = mode; panes.dataset.mode = mode; if (persist) ctx.storage.set('mode', mode);
      root.querySelectorAll('.chip[data-mode]').forEach(c => { const a = c.dataset.mode === mode; c.classList.toggle('active', a); c.setAttribute('aria-pressed', String(a)); });
      state.edTops = null; state.activeIdx = -1; later(updateActive, 0);
    }
    on(root, 'click', e => { const c = e.target.closest('.chip[data-mode]'); if (c && root.contains(c)) setMode(c.dataset.mode); });

    function setOrient(o) {
      state.orient = o === 'column' ? 'column' : 'row'; panes.dataset.orient = state.orient;
      ctx.storage.set('orient', state.orient); setPressed($('#me-orient'), state.orient === 'column'); updateSepAria(); state.edTops = null;
    }
    function updateSepAria() {
      sep.setAttribute('aria-orientation', getComputedStyle(panes).flexDirection === 'row' ? 'vertical' : 'horizontal');
    }
    function setSplit(pct, persist = true) {
      state.split = clamp(Math.round(pct * 10) / 10, 15, 85);
      panes.style.setProperty('--me-split', state.split); sep.setAttribute('aria-valuenow', String(Math.round(state.split)));
      if (persist) ctx.storage.set('split', state.split);
      state.ver++;
    }
    {
      let dragging = false;
      const pctFrom = e => {
        const r = panes.getBoundingClientRect(), horiz = getComputedStyle(panes).flexDirection === 'row';
        return horiz ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100;
      };
      on(sep, 'pointerdown', e => { if (e.button !== 0) return; dragging = true; sep.setPointerCapture(e.pointerId); sep.classList.add('dragging'); panes.classList.add('dragging-split'); e.preventDefault(); });
      on(sep, 'pointermove', e => { if (dragging) setSplit(pctFrom(e), false); });
      const end = e => { if (!dragging) return; dragging = false; sep.classList.remove('dragging'); panes.classList.remove('dragging-split'); try { sep.releasePointerCapture(e.pointerId); } catch { /* already released */ } ctx.storage.set('split', state.split); };
      on(sep, 'pointerup', end); on(sep, 'pointercancel', end);
      on(sep, 'dblclick', () => setSplit(50));
      on(sep, 'keydown', e => {
        const horiz = getComputedStyle(panes).flexDirection === 'row', step = e.shiftKey ? 10 : 2;
        const dec = horiz ? 'ArrowLeft' : 'ArrowUp', inc = horiz ? 'ArrowRight' : 'ArrowDown';
        if (e.key === dec) setSplit(state.split - step);
        else if (e.key === inc) setSplit(state.split + step);
        else if (e.key === 'Home') setSplit(15);
        else if (e.key === 'End') setSplit(85);
        else if (e.key === 'Enter') setSplit(50);
        else return;
        e.preventDefault();
      });
    }

    function setSync(on_) { state.sync = !!on_; ctx.storage.set('sync', state.sync); setPressed($('#me-sync'), state.sync); }
    function setWrap(on_) {
      state.wrap = !!on_; ctx.storage.set('wrap', state.wrap); setPressed($('#me-wrap'), state.wrap);
      input.classList.toggle('nowrap', !state.wrap); input.setAttribute('wrap', state.wrap ? 'soft' : 'off'); state.ver++; state.edTops = null;
    }
    function setFontSize(px) {
      state.fs = clamp(Math.round(px), 10, 28); ctx.storage.set('fontSize', state.fs);
      input.style.fontSize = `${state.fs}px`; $('#me-fs').textContent = `${state.fs}px`; state.ver++; state.edTops = null;
    }

    // ---------- fullscreen ----------
    const canFullscreen = !!(document.fullscreenEnabled && root.requestFullscreen);
    if (!canFullscreen) fsBtn.hidden = true;
    on(document, 'fullscreenchange', () => {
      const active = document.fullscreenElement === root;
      setPressed(fsBtn, active); fsBtn.lastChild.textContent = active ? ' Exit fullscreen' : ' Fullscreen';
      state.ver++; state.edTops = null;
    });
    disposers.push(() => { if (document.fullscreenElement === root) document.exitFullscreen?.().catch(() => {}); });

    // ---------- preview rendering ----------
    const spinner = on_ => { spin.hidden = !on_; };
    const syncStaleUi = () => { staleEl.hidden = !(state.manual && state.stale); };
    function updateManualUi(len) {
      const manual = renderDelay(len) === null;
      if (manual === state.manual) return;
      state.manual = manual; renderBtn.hidden = !manual;
      notice.hidden = !manual;
      if (manual) notice.textContent = 'Large document (over 1 MB): the preview is not updated while you type. Press Render to refresh it.';
      syncStaleUi();
    }

    async function runRender() {
      const seq = ++state.seq, stale = () => seq !== state.seq || state.disposed;
      const md = input.value;
      state.stale = false; syncStaleUi();
      if (!state.libsOk) {
        docEl.textContent = ''; const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = md; docEl.append(pre);
        fmEl.hidden = true; state.toc = []; state.srcHeads = []; state.headEls = []; buildTocList();
        return;
      }
      const slow = md.length > 50000;
      if (slow) { spinner(true); await nextFrame(); if (stale()) return; }
      try {
        const fm = parseFrontMatter(md);
        const html = renderMarkdown(fm.body);
        const st = preview.scrollTop;
        state.noSyncUntil = performance.now() + 200;
        fmEl.hidden = fm.raw === null; fmText.textContent = fm.raw ?? ''; // front matter: escaped text, never HTML
        docEl.innerHTML = html;
        const toc = addHeadingIds(docEl);
        highlightCode(docEl);
        preview.scrollTop = st;
        const sig = JSON.stringify(toc);
        const changed = sig !== state.tocSig; state.tocSig = sig;
        state.toc = toc; state.headEls = [...docEl.querySelectorAll(HEADINGS)]; state.srcHeads = buildToc(md);
        state.ver++; state.edTops = null;
        if (changed) buildTocList();
        if (state.renderError) { state.renderError = false; showMessage(msg, null); }
        if (hasMermaid(docEl)) {
          spinner(true);
          const r = await renderMermaidBlocks(docEl, { isStale: stale });
          if (stale()) return;
          state.headEls = [...docEl.querySelectorAll(HEADINGS)]; // diagrams change layout, not headings, but keep fresh
          if (r.rendered || r.failed) preview.scrollTop = st;
        }
        updateActive();
      } catch (e) { state.renderError = true; showMessage(msg, 'error', `Could not render Markdown: ${e.message}`); }
      finally { if (!stale()) spinner(false); }
    }
    // Render when the browser is idle (rAF fallback) so typing is never blocked by a pending render.
    let idleHandle = 0;
    const whenIdle = fn => {
      if ('requestIdleCallback' in window) idleHandle = requestIdleCallback(fn, { timeout: 1000 });
      else idleHandle = requestAnimationFrame(fn);
    };
    disposers.push(() => { if ('cancelIdleCallback' in window) cancelIdleCallback(idleHandle); else cancelAnimationFrame(idleHandle); });
    let renderTimer = 0;
    function scheduleRender() {
      clearTimeout(renderTimer);
      const delay = renderDelay(input.value.length);
      updateManualUi(input.value.length);
      if (delay === null) { state.stale = true; syncStaleUi(); return; }
      renderTimer = setTimeout(() => whenIdle(runRender), delay);
    }
    disposers.push(() => clearTimeout(renderTimer));

    let statsTimer = 0;
    const stats = () => {
      const s = countStats(input.value);
      $('#me-stats').textContent = `${s.words} words · ${s.chars} chars · ${s.lines} lines · ${s.minutes ? `~${s.minutes} min read` : '0 min read'}`;
    };
    const scheduleStats = () => { if (input.value.length < 200000) stats(); else { clearTimeout(statsTimer); statsTimer = setTimeout(stats, 250); } };
    disposers.push(() => clearTimeout(statsTimer));

    let saveTimer = 0;
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const ok = ctx.storage.set('draft', input.value);
        $('#me-saved').textContent = ok === false ? 'Draft not saved (storage full or blocked)' : 'Draft saved';
      }, 500);
    };
    disposers.push(() => clearTimeout(saveTimer));

    on(input, 'input', () => {
      state.ver++; state.edTops = null;
      scheduleStats(); scheduleRender(); $('#me-saved').textContent = ''; save();
      if (!findBar.hidden) scheduleFindRefresh();
    });

    // ---------- applying edits (keeps the native undo stack) ----------
    function commit(edit) {
      input.focus();
      input.setSelectionRange(edit.from, edit.to);
      let ok = false;
      try { ok = edit.text === '' ? (edit.from === edit.to || document.execCommand('delete')) : document.execCommand('insertText', false, edit.text); } catch { ok = false; }
      if (!ok) { input.setRangeText(edit.text, edit.from, edit.to, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }
      input.setSelectionRange(edit.selStart, edit.selEnd);
    }
    const applyFormat = action => { const edit = editFor(action, input.value, input.selectionStart, input.selectionEnd); if (edit) commit(edit); };
    on($('.me-format'), 'click', e => { const b = e.target.closest('[data-fmt]'); if (b) applyFormat(b.dataset.fmt); });

    // ---------- find & replace ----------
    const fopts = () => ({ caseSensitive: fcase.getAttribute('aria-pressed') === 'true', regex: fre.getAttribute('aria-pressed') === 'true' });
    let findTimer = 0;
    const scheduleFindRefresh = () => { clearTimeout(findTimer); findTimer = setTimeout(refreshFind, 150); };
    disposers.push(() => clearTimeout(findTimer));
    function refreshFind() {
      const r = findMatches(input.value, fq.value, fopts());
      state.matches = r.matches;
      fq.setAttribute('aria-invalid', r.error ? 'true' : 'false');
      fcount.title = r.error || '';
      if (r.error) fcount.textContent = 'Invalid regex';
      else if (!fq.value) fcount.textContent = '';
      else if (!r.matches.length) fcount.textContent = 'No results';
      else {
        const s = input.selectionStart, cur = r.matches.findIndex(m => m.index === s && m.index + m.length === input.selectionEnd);
        fcount.textContent = cur >= 0 ? `${cur + 1} of ${r.matches.length}` : `${r.matches.length}${r.matches.length >= 10000 ? '+' : ''} found`;
      }
    }
    function gotoMatch(dir) {
      refreshFind();
      const ms = state.matches; if (!ms.length) return false;
      const s = input.selectionStart, e = input.selectionEnd;
      let m;
      if (dir > 0) m = ms.find(x => x.index >= (ms.some(y => y.index === s && y.index + y.length === e) ? e : s)) ?? ms[0];
      else m = [...ms].reverse().find(x => x.index + x.length <= s && x.index < s) ?? ms[ms.length - 1];
      input.focus({ preventScroll: true });
      input.setSelectionRange(m.index, m.index + m.length);
      const top = mirrorTops([m.index])?.[0];
      if (top != null && (top < input.scrollTop || top > input.scrollTop + input.clientHeight - 40)) setScroll(input, Math.max(0, top - input.clientHeight / 3));
      refreshFind();
      return true;
    }
    function openFind() {
      findBar.hidden = false;
      const sel = input.value.slice(input.selectionStart, input.selectionEnd);
      if (sel && !sel.includes('\n')) fq.value = sel;
      fq.focus(); fq.select(); refreshFind(); state.edTops = null; state.ver++;
    }
    function closeFind() { findBar.hidden = true; input.focus(); state.edTops = null; state.ver++; }
    function replaceCurrent() {
      refreshFind();
      const s = input.selectionStart, e = input.selectionEnd;
      const cur = state.matches.find(m => m.index === s && m.index + m.length === e);
      if (!cur) { gotoMatch(1); return; }
      const ed = replaceAt(input.value, fq.value, fr.value, fopts(), cur.index);
      if (!ed) return;
      commit({ ...ed, selStart: ed.from + ed.text.length, selEnd: ed.from + ed.text.length });
      refreshFind(); gotoMatch(1);
    }
    function replaceEverything() {
      const r = replaceAll(input.value, fq.value, fr.value, fopts());
      if (r.error) { fcount.textContent = 'Invalid regex'; return; }
      if (!r.count) { fcount.textContent = 'No results'; return; }
      const caret = Math.min(input.selectionStart, r.text.length);
      commit({ from: 0, to: input.value.length, text: r.text, selStart: caret, selEnd: caret });
      refreshFind(); fcount.textContent = `${r.count} replaced`;
    }
    on(findBar, 'click', e => {
      const b = e.target.closest('[data-find]'); if (!b) return;
      ({ next: () => gotoMatch(1), prev: () => gotoMatch(-1), close: closeFind, replace: replaceCurrent, all: replaceEverything })[b.dataset.find]?.();
    });
    on(fq, 'input', refreshFind); on(fcase, 'click', () => { setPressed(fcase, fcase.getAttribute('aria-pressed') !== 'true'); refreshFind(); });
    on(fre, 'click', () => { setPressed(fre, fre.getAttribute('aria-pressed') !== 'true'); refreshFind(); });
    on(findBar, 'keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      else if (e.key === 'Enter' && (e.target === fq || e.target === fr)) { e.preventDefault(); if (e.target === fr) replaceCurrent(); else gotoMatch(e.shiftKey ? -1 : 1); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); fq.focus(); fq.select(); }
    });

    // ---------- keyboard in the editor ----------
    const unit = () => ctx.indentUnit || '  ';
    function handleTab(shift) {
      const s = input.selectionStart, e = input.selectionEnd, v = input.value;
      if (shift) { const ed = outdentEdit(v, s, e, unit()); if (ed) commit(ed); return; }
      if (v.slice(s, e).includes('\n')) { commit(indentEdit(v, s, e, unit())); return; }
      commit({ from: s, to: e, text: unit(), selStart: s + unit().length, selEnd: s + unit().length });
    }
    on(input, 'blur', () => { state.tabReleased = false; });
    on(input, 'keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (!findBar.hidden) { e.preventDefault(); closeFind(); } else state.tabReleased = true; // Esc releases the Tab trap
        return;
      }
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (!e.shiftKey && k === 'b') { e.preventDefault(); applyFormat('bold'); }
        else if (!e.shiftKey && k === 'i') { e.preventDefault(); applyFormat('italic'); }
        else if (!e.shiftKey && k === 'k') { e.preventDefault(); applyFormat('link'); }
        else if (!e.shiftKey && k === 'f') { e.preventDefault(); openFind(); }
        else if (!e.shiftKey && k === 'g' && fq.value) { e.preventDefault(); gotoMatch(1); }
        return;
      }
      if (e.key === 'F3' && fq.value) { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'Tab' && !e.altKey) {
        if (state.tabReleased) return;
        e.preventDefault(); handleTab(e.shiftKey); return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && input.selectionStart === input.selectionEnd) {
        const ed = continueList(input.value, input.selectionStart);
        if (ed) { e.preventDefault(); commit(ed); }
      }
    });

    // ---------- import ----------
    function replaceDocument(text) {
      if (input.value.length < 200000 && text.length < 200000) commit({ from: 0, to: input.value.length, text, selStart: 0, selEnd: 0 }); // undoable
      else { input.value = text; input.setSelectionRange(0, 0); input.dispatchEvent(new Event('input', { bubbles: true })); }
      input.scrollTop = 0; preview.scrollTop = 0;
    }
    async function openFile(file) {
      if (!file) return;
      const v = validateImport(file);
      if (!v.ok) return showMessage(msg, 'error', v.error);
      try {
        const text = await readFileAsText(file);
        if (hasNul(text)) return showMessage(msg, 'error', `"${file.name}" looks like a binary file.`);
        state.fileName = file.name.replace(/\.(txt|markdown|mdown|mkd)$/i, '.md');
        ctx.storage.set('fileName', state.fileName);
        showMessage(msg, null);
        replaceDocument(text);
        stats(); clearTimeout(renderTimer); updateManualUi(text.length);
        if (!state.manual) runRender(); else { state.stale = true; syncStaleUi(); }
        save();
        notify(/\.txt$/i.test(file.name) ? `Opened ${file.name} (plain text, rendered as Markdown)` : `Opened ${file.name}`, 'success');
      } catch (e) { showMessage(msg, 'error', `Could not read file: ${e.message}`); }
    }
    disposers.push(enableDrop(input, openFile), enableDrop(preview, openFile));

    // ---------- export ----------
    const baseName = () => state.fileName.replace(/\.[^.]+$/, '');
    /** Fresh render, then a cleaned clone of the preview: highlighted code, heading ids, Mermaid as inline SVG. */
    async function snapshot() {
      if (!state.libsOk) { showMessage(msg, 'error', 'HTML output needs the Markdown libraries, which could not be loaded. Check your connection and reload.'); return null; }
      if (!input.value.trim()) { notify('Nothing to export — the editor is empty', 'warn'); return null; }
      await runRender();
      const clone = docEl.cloneNode(true);
      clone.querySelectorAll('a[data-anchor]').forEach(a => a.removeAttribute('data-anchor'));
      mermaidForExport(clone);
      return { html: clone.innerHTML, toc: state.toc };
    }
    $('#me-export-toc').checked = !!ctx.storage.get('exportToc', false);
    on($('#me-export-toc'), 'change', e => ctx.storage.set('exportToc', e.target.checked));

    let printCleanup = null;
    disposers.push(() => printCleanup?.());

    bindActions(root, {
      open: async () => openFile(await pickFile('.md,.markdown,.mdown,.mkd,.txt,text/*')),
      'export-md': () => downloadFile(`${baseName()}.md`, input.value, 'text/markdown;charset=utf-8'),
      'export-html': async () => {
        const s = await snapshot(); if (!s) return;
        const withToc = $('#me-export-toc').checked;
        downloadFile(`${baseName()}.html`, buildHtmlDocument(guessTitle(parseFrontMatter(input.value).body), s.html, { toc: withToc ? s.toc : null }), 'text/html;charset=utf-8');
      },
      'copy-md': () => copyText(input.value, 'Markdown copied'),
      'copy-html': async () => { const s = await snapshot(); if (s) copyText(s.html, 'HTML copied'); },
      'copy-text': async () => {
        if (!state.libsOk) return showMessage(msg, 'error', 'Rendered text needs the Markdown libraries, which could not be loaded.');
        await runRender();
        const text = (docEl.offsetParent ? docEl.innerText : docEl.textContent).trim();
        if (!text) return notify('Nothing to copy — the preview is empty', 'warn');
        copyText(text, 'Rendered text copied');
      },
      print: async () => {
        if (!state.libsOk) return showMessage(msg, 'error', 'Printing needs the rendered preview, which requires the Markdown libraries.');
        if (!input.value.trim()) return notify('Nothing to print — the editor is empty', 'warn');
        await runRender();
        const prev = state.mode;
        if (prev === 'editor') setMode('preview', false); // the preview must be displayed to be printed
        const sel = `.tool-${ctx.toolId} .me-preview`;
        const ancestors = `.tool-${ctx.toolId} .me-body,.tool-${ctx.toolId} .me-panes,.tool-${ctx.toolId} .me-preview-pane{display:block!important;overflow:visible!important;height:auto!important;max-height:none!important}.tool-${ctx.toolId} .me-splitter{display:none!important}`;
        printCleanup?.();
        printCleanup = printScoped(sel, () => { printCleanup = null; if (prev === 'editor') setMode('editor', false); }, ancestors);
      },
      'render-now': () => runRender(),
      clear: async () => {
        if (!input.value) return;
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        if (!await confirmDialog('Clear editor', 'Remove all content? This cannot be undone.', 'Clear')) return;
        replaceDocument(''); state.fileName = 'document.md'; ctx.storage.set('fileName', state.fileName);
        stats(); runRender(); save();
      },
      'toggle-orient': () => setOrient(state.orient === 'row' ? 'column' : 'row'),
      'toggle-sync': () => setSync(!state.sync),
      'toggle-wrap': () => setWrap(!state.wrap),
      'toggle-toc': () => setToc(!state.tocOpen),
      'font-dec': () => setFontSize(state.fs - 1),
      'font-inc': () => setFontSize(state.fs + 1),
      fullscreen: () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else root.requestFullscreen().catch(e => showMessage(msg, 'error', `Fullscreen is not available: ${e.message}`));
      },
    });

    // ---------- init ----------
    setMode(ctx.storage.get('mode', 'split'), false);
    setOrient(ctx.storage.get('orient', 'row'));
    setSplit(Number(ctx.storage.get('split', 50)) || 50, false);
    setSync(ctx.storage.get('sync', true));
    setWrap(ctx.storage.get('wrap', true));
    setFontSize(Number(ctx.storage.get('fontSize', ctx.fontSize || 13)) || 13);
    setToc(ctx.storage.get('tocOpen', false), false);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { state.ver++; state.edTops = null; updateSepAria(); });
      ro.observe(panes); disposers.push(() => ro.disconnect());
    }
    disposers.push(handleAnchorClicks(preview));
    updateManualUi(input.value.length);
    stats();
    runRender(); // plain-text fallback until libs are ready

    // Re-render on theme change so Mermaid diagrams follow light/dark.
    const mo = new MutationObserver(() => { if (hasMermaid(docEl) || docEl.querySelector('.md-mermaid')) scheduleRender(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    disposers.push(() => mo.disconnect());

    // Load libraries lazily (not awaited so the shell can show the tool at once); the editor stays usable if this fails.
    loadMarkdownLibs().then(() => {
      if (state.disposed) return;
      state.libsOk = true;
      disposers.push(syncHighlightTheme());
      runRender();
    }).catch(e => { if (!state.disposed) showMessage(msg, 'error', e.message); });

    return () => {
      state.disposed = true; state.seq++;
      timers.forEach(clearTimeout);
      disposers.forEach(d => { try { d(); } catch { /* ignore */ } });
      mirror?.remove();
    };
  },
};
