// Shared lightweight code editor: wraps an EXISTING <textarea> in place (same element, same .value / events / native undo)
// and adds a line-number gutter, syntax-highlight overlay, editing helpers, find & replace, toolbar, drag & drop and a
// resizable height. No dependencies; pure logic lives in editor-core.js. Styles: assets/css/editor.css.
//
//   const ed = createEditor(textarea, { language: 'json', storage: ctx.storage, filename: 'data.json' });
//   ... ed.destroy();   // on tool unmount: removes every listener / observer / injected node, restores the textarea in place
//
// Programmatic `textarea.value = x` keeps working: an instance-level accessor refreshes the overlay (removed on destroy).
// Never rewrite the value for edits: helpers go through execCommand('insertText') so the native undo stack survives.
import { el, copyText, downloadFile, toast, pickFile, readFileAsText, confirmDialog, renderIcons } from './ui.js';
import * as C from './editor-core.js';

const DEFAULT_TOOLBAR = ['wrap', 'fontSize', 'find', 'fullscreen'];
const LIMIT_NOTICE = 'Large file: line numbers and highlighting are off';
const BIG_HL = 250000;      // above this the overlay is repainted after a short pause instead of on every frame
const WINDOW_BUFFER = 40;
const instances = new WeakMap();
let uid = 0;

const TOOLS = {
  wrap: { label: 'Wrap long lines', icon: 'wrap-text', glyph: '↵', toggle: true },
  fontSmaller: { label: 'Decrease font size', text: 'A−' },
  fontLarger: { label: 'Increase font size', text: 'A+' },
  find: { label: 'Find and replace (Ctrl+F)', icon: 'search', glyph: '⌕', toggle: true },
  fullscreen: { label: 'Full screen', icon: 'maximize-2', glyph: '⛶', toggle: true },
  copy: { label: 'Copy all text', icon: 'copy', glyph: 'Copy' },
  download: { label: 'Download as a file', icon: 'download', glyph: '↓' },
  upload: { label: 'Upload a text file', icon: 'upload', glyph: '↑' },
  clear: { label: 'Clear the editor', icon: 'trash-2', glyph: '✕' },
};

const read = (storage, key, fallback) => { try { const v = storage?.get?.(key, fallback); return v === undefined || v === null ? fallback : v; } catch { return fallback; } };
const write = (storage, key, value) => { try { storage?.set?.(key, value); } catch { /* storage may be full or blocked */ } };

/**
 * Wrap `textarea` in an editor. Options (all optional):
 * language, highlighter(text)->segments, lineNumbers=true, wrap=false, fontSize, indentUnit, readOnly, toolbar[], storage,
 * storageKey, filename (string | () => string), mime, onChange(value), accept, maxBytes (5 MB), confirmClear, ariaLabel,
 * resizable=true, autoClose, drop=true (accept dropped files), onUpload(file, text).
 */
export function createEditor(textarea, options = {}) {
  if (!(textarea instanceof HTMLTextAreaElement)) throw new TypeError('createEditor needs a <textarea>');
  instances.get(textarea)?.destroy();

  const o = { lineNumbers: true, wrap: false, resizable: true, drop: true, maxBytes: C.LIMITS.uploadBytes, confirmClear: true, ...options };
  const parent = textarea.parentNode;
  const id = ++uid;
  const skey = `ed:${o.storageKey || textarea.id || textarea.dataset?.el || textarea.getAttribute('name') || 'editor'}`;
  const offs = [];
  const on = (target, ev, fn, opt) => { target.addEventListener(ev, fn, opt); offs.push(() => target.removeEventListener(ev, fn, opt)); };
  let destroyed = false;

  // ---------------------------------------------------------------- state
  let cfg = C.languageConfig(o.language);
  let customHighlighter = typeof o.highlighter === 'function' ? o.highlighter : null;
  let highlighter = customHighlighter || C.getHighlighter(o.language);
  let readOnly = !!(o.readOnly ?? textarea.readOnly);
  let wrap = read(o.storage, `${skey}:wrap`, null);
  wrap = typeof wrap === 'boolean' ? wrap : !!o.wrap;
  const cssFs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size')) || 13;
  let fontSize = C.clampFontSize(read(o.storage, `${skey}:fs`, null) ?? o.fontSize ?? cssFs);
  const indentUnit = () => (typeof o.indentUnit === 'string' && o.indentUnit ? o.indentUnit : '  ');
  const forcedMq = typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : null;
  let text = null, starts = null, lines = 1, limited = false, segs = null, segOff = null, hlOn = false, hlFor = null;
  let curWin = null, gutDigits = 0, composing = false, released = false, stale = false;
  let lh = Math.round(fontSize * 1.5), padTop = 8, padLeft = 10, charW = 8, tabSize = 2, sbw = 0, sbh = 0;
  let forcePaint = false, raf = 0, bigTimer = 0, dirty = 0, countTimer = 0, msgTimer = 0, saveTimer = 0;
  const T = 1, S = 2, K = 4, M = 8, R = 16; // dirty flags: text, scroll, caret, metrics, resize

  // ---------------------------------------------------------------- DOM
  const orig = {
    cls: textarea.className, ro: textarea.readOnly, fs: textarea.style.fontSize, describedby: textarea.getAttribute('aria-describedby'),
    label: textarea.getAttribute('aria-label'), spell: textarea.getAttribute('spellcheck'), wrapAttr: textarea.getAttribute('wrap'),
  };
  if (o.ariaLabel) textarea.setAttribute('aria-label', o.ariaLabel);
  textarea.style.removeProperty('font-size'); // the editor owns the font metrics (the overlay must match exactly)
  textarea.classList.add('ed-ta');
  textarea.readOnly = readOnly;

  const gutterInner = el('pre', { class: 'ed-gutter-inner' });
  const gutter = el('div', { class: 'ed-gutter', 'aria-hidden': 'true' }, gutterInner);
  const curLine = el('div', { class: 'ed-curline', 'aria-hidden': 'true' });
  const hlInner = el('pre', { class: 'ed-hl-inner' });
  const hl = el('div', { class: 'ed-hl', 'aria-hidden': 'true' }, hlInner);
  const stage = el('div', { class: 'ed-stage' }, curLine, hl);
  const bodyEl = el('div', { class: 'ed-body' }, gutter, stage);
  const posEl = el('span', { class: 'ed-pos' });
  const noticeEl = el('span', { class: 'ed-notice', role: 'status' });
  const msgEl = el('span', { class: 'ed-msg', role: 'status', 'aria-live': 'polite' });
  const bar = el('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': 'Editor tools' }, posEl, noticeEl, msgEl, el('span', { class: 'ed-spacer' }));
  const hintId = `ed-hint-${id}`;
  const hint = el('span', { class: 'sr-only ed-sr', id: hintId }, readOnly ? 'Read-only text.' : 'Tab inserts indentation. Press Escape, then Tab, to move focus out of the editor.');
  const root = el('div', { class: 'ed' }, bar, bodyEl, hint);
  const mirror = el('div', { class: 'ed-mirror', 'aria-hidden': 'true' });

  parent.insertBefore(root, textarea);
  stage.append(textarea);
  textarea.setAttribute('aria-describedby', [orig.describedby, hintId].filter(Boolean).join(' '));
  root.classList.toggle('ed-readonly', readOnly);
  root.style.setProperty('--ed-tab', String(indentUnit() === '\t' ? 4 : 2));

  // toolbar buttons -----------------------------------------------------------------------------
  const buttons = {};
  const makeButton = (name, spec) => {
    const b = el('button', { class: 'ed-btn', type: 'button', title: spec.label, 'aria-label': spec.label, 'data-ed': name });
    if (spec.icon) b.append(el('i', { 'data-lucide': spec.icon, 'aria-hidden': 'true' }, spec.glyph || ''));
    else b.append(el('span', { class: spec.text ? 'ed-btn-text' : 'ed-btn-glyph', 'aria-hidden': 'true' }, spec.text || spec.glyph));
    if (spec.toggle) b.setAttribute('aria-pressed', 'false');
    buttons[name] = b;
    return b;
  };
  const wanted = Array.isArray(o.toolbar) ? o.toolbar : (readOnly ? [...DEFAULT_TOOLBAR, 'copy', 'download'] : DEFAULT_TOOLBAR);
  const toolbarActions = {
    wrap: () => setWrap(!wrap), fontSmaller: () => setFontSize(fontSize - 1), fontLarger: () => setFontSize(fontSize + 1),
    find: () => (findOpen ? closeFind() : openFind(false)), fullscreen: () => toggleFullscreen(),
    copy: () => copy(), download: () => download(), upload: () => upload(), clear: () => clear(),
  };
  for (const name of wanted.flatMap(n => (n === 'fontSize' ? ['fontSmaller', 'fontLarger'] : [n]))) {
    if (!TOOLS[name]) continue;
    const b = makeButton(name, TOOLS[name]);
    on(b, 'click', toolbarActions[name]);
    bar.append(b);
  }
  if (buttons.upload) buttons.upload.disabled = readOnly;
  if (buttons.clear) buttons.clear.disabled = readOnly;
  if (!wanted.length) bar.classList.add('ed-bar-empty');
  renderIcons(root);

  // resizer ---------------------------------------------------------------------------------------
  const RES_MIN = 120, RES_MAX = 4000, RES_STEP = 24;
  let resizer = null;
  const setHeight = (h, persist = true) => {
    if (h == null) { bodyEl.style.height = ''; bodyEl.style.flex = ''; resizer?.removeAttribute('aria-valuenow'); if (persist) write(o.storage, `${skey}:h`, null); return; }
    const v = C.clampHeight(h, RES_MIN, RES_MAX);
    bodyEl.style.height = `${v}px`; bodyEl.style.flex = 'none';
    resizer?.setAttribute('aria-valuenow', String(v));
    if (persist) { clearTimeout(saveTimer); saveTimer = setTimeout(() => write(o.storage, `${skey}:h`, v), 250); }
  };
  if (o.resizable !== false) {
    resizer = el('div', { class: 'ed-resizer', role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0', title: 'Drag to resize (arrow keys; double-click to reset)',
      'aria-label': 'Resize editor height', 'aria-valuemin': String(RES_MIN), 'aria-valuemax': String(RES_MAX) });
    root.insertBefore(resizer, hint);
    const saved = Number(read(o.storage, `${skey}:h`, 0));
    if (saved >= RES_MIN) setHeight(saved, false);
    let drag = null;
    const curH = () => bodyEl.getBoundingClientRect().height;
    on(resizer, 'pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault(); resizer.setPointerCapture?.(e.pointerId); drag = { y: e.clientY, h: curH() }; resizer.classList.add('active');
    });
    on(resizer, 'pointermove', e => { if (drag) setHeight(drag.h + (e.clientY - drag.y)); });
    const end = e => { if (!drag) return; drag = null; resizer.classList.remove('active'); try { resizer.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ } };
    on(resizer, 'pointerup', end); on(resizer, 'pointercancel', end);
    on(resizer, 'dblclick', () => setHeight(null));
    on(resizer, 'keydown', e => {
      const step = e.shiftKey ? RES_STEP * 4 : RES_STEP;
      let h = null;
      if (e.key === 'ArrowDown') h = curH() + step; else if (e.key === 'ArrowUp') h = curH() - step;
      else if (e.key === 'Home') h = RES_MIN; else if (e.key === 'End') h = Math.round(window.innerHeight * 0.9);
      else if (e.key === 'Enter' || e.key === 'Escape') { setHeight(null); }
      if (h == null) return;
      e.preventDefault(); setHeight(h);
    });
  }

  // ---------------------------------------------------------------- metrics, notices
  function measure() {
    root.style.setProperty('--ed-fs', `${fontSize}px`);
    lh = Math.round(fontSize * 1.5);
    root.style.setProperty('--ed-lh', `${lh}px`);
    const cs = getComputedStyle(textarea);
    padTop = parseFloat(cs.paddingTop) || 0; padLeft = parseFloat(cs.paddingLeft) || 0;
    tabSize = parseInt(cs.tabSize, 10) || 2;
    try {
      const c = (measure.canvas ||= document.createElement('canvas')).getContext('2d');
      c.font = `${cs.fontSize} ${cs.fontFamily}`;
      const w = c.measureText('0'.repeat(20)).width / 20;
      if (w > 0) charW = w;
    } catch { /* keep previous */ }
    curWin = null;
  }
  const say = (message, type = 'info') => {
    if (document.fullscreenElement === root) { // toasts live outside the fullscreen subtree: show the message here instead
      msgEl.textContent = message; clearTimeout(msgTimer); msgTimer = setTimeout(() => { msgEl.textContent = ''; }, 2600);
    } else toast(message, type);
  };

  // ---------------------------------------------------------------- rendering
  function renderSegs(container, list) {
    const frag = document.createDocumentFragment();
    for (const s of list) {
      if (!s.type || s.type === 'plain' || !C.SYNTAX_TYPES.includes(s.type)) { frag.append(document.createTextNode(s.text)); continue; }
      const span = document.createElement('span');
      span.className = `ed-t-${s.type}`; span.textContent = s.text;
      frag.append(span);
    }
    container.replaceChildren(frag);
  }

  /** Recompute everything that depends on the text (line table, feature limits, tokens). */
  function onText(skipTokens = false) {
    const v = textarea.value;
    const changed = v !== text;
    if (changed) { text = v; starts = null; segs = null; segOff = null; curWin = null; hlFor = null; }
    if (changed || starts === null) {
      if (v.length > C.LIMITS.gutterChars) { limited = true; starts = null; lines = 0; }
      else { starts = C.lineStarts(v); lines = starts.length; limited = lines > C.LIMITS.gutterLines; if (limited) starts = null; }
    }
    const forced = !!forcedMq?.matches;
    const wrapTooBig = wrap && v.length > C.LIMITS.highlightWrapChars;
    hlOn = !!highlighter && !limited && !forced && !wrapTooBig;
    noticeEl.textContent = limited ? LIMIT_NOTICE : (highlighter && wrapTooBig ? 'Highlighting is off while wrapping a large file' : '');
    if (hlOn && !skipTokens && (!segs || hlFor !== highlighter)) {
      try {
        segs = highlighter(v); hlFor = highlighter;
        segOff = C.segmentOffsets(segs);
        if (segOff[segs.length] !== v.length) { segs = null; hlOn = false; } // a highlighter that changes the text would misalign the overlay
      } catch (err) { segs = null; hlOn = false; console.warn('editor highlighter failed', err); }
    }
    const gutterOn = o.lineNumbers !== false && !wrap && !limited;
    root.classList.toggle('ed-has-gutter', gutterOn);
    root.classList.toggle('ed-wrap', wrap);
    root.classList.toggle('ed-hl-on', hlOn);
    root.classList.toggle('ed-no-curline', wrap || limited);
    if (gutterOn) {
      const d = Math.max(2, C.gutterDigits(lines));
      if (d !== gutDigits) { gutDigits = d; gutter.style.width = `calc(${d}ch + 20px)`; }
    }
  }

  /** Render the visible window of the gutter / highlight layer and position them (no-wrap), or the whole layer (wrap). */
  function renderWindow(force) {
    if (!text && text !== '') return;
    const st = textarea.scrollTop, sl = textarea.scrollLeft;
    const gutterOn = root.classList.contains('ed-has-gutter');
    if (!wrap && !limited && (gutterOn || hlOn)) {
      const w = C.computeWindow({ scrollTop: st, viewHeight: textarea.clientHeight, lineHeight: lh, padTop, lineCount: lines, buffer: WINDOW_BUFFER });
      if (force || !C.windowCovers(curWin, w.vis0, w.vis1)) {
        curWin = { start: w.start, end: w.end };
        if (gutterOn) gutterInner.textContent = C.gutterText(w.start, w.end);
        if (hlOn && segs) {
          const A = starts[w.start], B = w.end < lines ? starts[w.end] : text.length;
          renderSegs(hlInner, C.sliceSegments(segs, segOff, A, B));
        } else hlInner.textContent = '';
      }
      const y = padTop + curWin.start * lh - st;
      if (gutterOn) gutterInner.style.transform = `translateY(${y}px)`;
      if (hlOn) hlInner.style.transform = `translate(${-sl}px, ${y}px)`;
    } else if (wrap && hlOn && segs) {
      if (force || curWin === null) { renderSegs(hlInner, segs); curWin = { start: 0, end: lines }; }
      hlInner.style.transform = `translateY(${padTop - st}px)`;
    } else if (curWin !== null || hlInner.firstChild || gutterInner.firstChild) {
      hlInner.textContent = ''; gutterInner.textContent = ''; curWin = null;
    }
  }
  const syncScroll = () => {
    if (!curWin) return renderWindow(true);
    renderWindow(false);
    updateCurLine();
  };
  function updateCurLine() {
    if (root.classList.contains('ed-no-curline') || textarea.selectionStart !== textarea.selectionEnd || !starts) { curLine.style.visibility = 'hidden'; return; }
    const line = C.lineIndexAt(starts, textarea.selectionStart);
    curLine.style.visibility = '';
    curLine.style.height = `${lh}px`;
    curLine.style.transform = `translateY(${padTop + line * lh - textarea.scrollTop}px)`;
  }
  function updatePos() {
    let msg = '';
    if (starts && !limited) {
      const p = textarea.selectionStart, line = C.lineIndexAt(starts, p);
      msg = `Ln ${line + 1}, Col ${p - starts[line] + 1}`;
      if (textarea.selectionEnd !== p) msg += ` (${textarea.selectionEnd - p} selected)`;
    }
    if (released && document.activeElement === textarea) msg = `${msg ? msg + ' · ' : ''}Tab now moves focus`;
    if (posEl.textContent !== msg) posEl.textContent = msg;
  }
  function measureScrollbars() {
    const w = textarea.offsetWidth - textarea.clientWidth, h = textarea.offsetHeight - textarea.clientHeight;
    if (w !== sbw) { sbw = w; root.style.setProperty('--ed-sbw', `${w}px`); }
    if (h !== sbh) { sbh = h; root.style.setProperty('--ed-sbh', `${h}px`); }
  }
  function flush() {
    raf = 0;
    if (destroyed) return;
    const d = dirty; dirty = 0;
    if (d & M) measure();
    measureScrollbars();
    if (d & (T | M)) {
      // A huge document is re-tokenised after a short pause; until then the textarea shows its own (uncoloured) text.
      const huge = !forcePaint && (d & T) && !(d & M) && !composing && !!highlighter && textarea.value.length > BIG_HL;
      forcePaint = false;
      if (huge) {
        stale = true; root.classList.add('ed-stale'); clearTimeout(bigTimer);
        bigTimer = setTimeout(() => { forcePaint = true; schedule(T); }, 160);
      } else if (stale) { stale = false; root.classList.remove('ed-stale'); clearTimeout(bigTimer); }
      onText(huge);
      renderWindow(true);
    } else if (d & (S | R)) renderWindow(false);
    if (d & (T | S | K | M | R)) { updateCurLine(); updatePos(); }
    if (findOpen && (d & T)) scheduleCount();
  }
  function schedule(flags) {
    if (destroyed) return;
    dirty |= flags;
    if (!raf) raf = requestAnimationFrame(flush);
  }

  // ---------------------------------------------------------------- applying edits (undo-friendly)
  function applyEdit(raw, { restoreFocus = false } = {}) {
    if (!raw) return false;
    if (raw.caretOnly) { textarea.setSelectionRange(raw.selStart, raw.selEnd); return true; }
    if (readOnly) return false;
    const value = textarea.value;
    const ed = C.trimEdit(value, raw);
    const prev = document.activeElement;
    if (prev !== textarea) textarea.focus({ preventScroll: true });
    if (ed.from === ed.to && ed.text === '') { textarea.setSelectionRange(raw.selStart, raw.selEnd); }
    else {
      textarea.setSelectionRange(ed.from, ed.to);
      let ok = false;
      try { ok = ed.text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, ed.text); } catch { ok = false; }
      if (!ok) { // execCommand unavailable (or refused): setRangeText keeps the value right but loses native undo for this step
        textarea.setSelectionRange(ed.from, ed.to);
        textarea.setRangeText(ed.text, ed.from, ed.to, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      textarea.setSelectionRange(raw.selStart, raw.selEnd);
    }
    if (restoreFocus && prev && prev !== textarea && prev.isConnected) prev.focus({ preventScroll: true });
    schedule(K);
    return true;
  }

  // ---------------------------------------------------------------- reveal / select
  function visualColumn(lineText, upTo) {
    let col = 0;
    for (let i = 0; i < upTo; i++) col = lineText.charCodeAt(i) === 9 ? col + tabSize - (col % tabSize) : col + 1;
    return col;
  }
  function wrapY(pos) {
    if (!mirror.isConnected) root.append(mirror);
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.textContent = `${textarea.value.slice(0, pos)}​`;
    return mirror.offsetHeight - lh;
  }
  /** Scroll so offset `pos` is comfortably visible (textarea selection APIs do not reliably scroll). */
  function reveal(pos) {
    const v = textarea.value;
    let y, x = null;
    if (wrap) y = wrapY(pos);
    else {
      const ls = C.lineStartOf(v, pos);
      y = padTop + C.lineOfOffset(v, pos) * lh;
      const le = v.indexOf('\n', ls);
      x = padLeft + visualColumn(v.slice(ls, le === -1 ? v.length : le), pos - ls) * charW;
    }
    const st = textarea.scrollTop, vh = textarea.clientHeight;
    if (y < st || y + lh * 2 > st + vh) textarea.scrollTop = Math.max(0, y - vh / 3);
    if (x !== null) {
      const sl = textarea.scrollLeft, vw = textarea.clientWidth;
      if (x < sl || x + 40 > sl + vw) textarea.scrollLeft = Math.max(0, x - vw / 3);
    }
    schedule(S);
  }
  function select(a, b, { focus = true } = {}) {
    if (focus) textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(a, b);
    reveal(a);
    schedule(K);
  }

  // ---------------------------------------------------------------- find & replace
  let findOpen = false, replaceOpen = false, matches = [], findError = null, findCapped = false, countStale = true;
  const fOpts = { caseSensitive: false, wholeWord: false, regex: false };
  const qInput = el('input', { class: 'ed-input', type: 'text', 'aria-label': 'Find', placeholder: 'Find', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
  const rInput = el('input', { class: 'ed-input', type: 'text', 'aria-label': 'Replace with', placeholder: 'Replace with', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
  const countEl = el('span', { class: 'ed-count', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const fbtn = (label, text, extra = {}) => el('button', { class: 'ed-btn', type: 'button', title: label, 'aria-label': label, ...extra }, el('span', { class: 'ed-btn-text', 'aria-hidden': 'true' }, text));
  const bCase = fbtn('Match case', 'Aa', { 'aria-pressed': 'false' }), bWord = fbtn('Whole word', 'ab', { 'aria-pressed': 'false' }), bRegex = fbtn('Use regular expression', '.*', { 'aria-pressed': 'false' });
  const bPrev = fbtn('Previous match (Shift+Enter)', '↑'), bNext = fbtn('Next match (Enter)', '↓'), bClose = fbtn('Close find (Esc)', '✕');
  const bToggle = fbtn('Toggle replace', '▸', { 'aria-expanded': 'false' });
  const bRep = el('button', { class: 'ed-btn ed-btn-wide', type: 'button' }, 'Replace');
  const bAll = el('button', { class: 'ed-btn ed-btn-wide', type: 'button' }, 'Replace all');
  const row1 = el('div', { class: 'ed-find-row' }, bToggle, qInput, bCase, bWord, bRegex, countEl, bPrev, bNext, bClose);
  const row2 = el('div', { class: 'ed-find-row ed-replace-row', hidden: true }, el('span', { class: 'ed-find-pad' }), rInput, bRep, bAll);
  const findBar = el('div', { class: 'ed-find', role: 'search', 'aria-label': 'Find and replace', hidden: true }, row1, row2);
  root.insertBefore(findBar, bodyEl);

  const pressed = (b, v) => b.setAttribute('aria-pressed', String(!!v));
  function updateCount() {
    countTimer = 0;
    const q = qInput.value;
    countStale = false;
    if (!q) { matches = []; findError = null; findCapped = false; } else {
      const r = C.findAll(textarea.value, fOpts, q);
      matches = r.matches; findError = r.error; findCapped = r.capped;
    }
    showCount();
  }
  function showCount(suffix = '') {
    const q = qInput.value;
    const cur = matches.length ? C.currentMatchIndex(matches, textarea.selectionStart, textarea.selectionEnd) : -1;
    countEl.textContent = C.describeCount({ query: q, error: findError, total: matches.length, capped: findCapped, current: cur }) + suffix;
    countEl.classList.toggle('ed-bad', !!findError);
    qInput.classList.toggle('ed-invalid', !!findError);
    if (findError) qInput.setAttribute('aria-invalid', 'true'); else qInput.removeAttribute('aria-invalid');
  }
  function scheduleCount() { countStale = true; clearTimeout(countTimer); countTimer = setTimeout(updateCount, 140); }
  function openFind(withReplace) {
    findOpen = true; findBar.hidden = false;
    if (withReplace && !readOnly) setReplaceOpen(true);
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    if (e > s && e - s <= 200) { const sel = textarea.value.slice(s, e); if (!sel.includes('\n')) qInput.value = sel; }
    if (buttons.find) { pressed(buttons.find, true); }
    qInput.focus(); qInput.select();
    updateCount();
  }
  function closeFind() {
    findOpen = false; findBar.hidden = true; clearTimeout(countTimer);
    if (buttons.find) pressed(buttons.find, false);
    if (!destroyed) textarea.focus({ preventScroll: true });
  }
  function setReplaceOpen(v) {
    replaceOpen = !!v && !readOnly; row2.hidden = !replaceOpen;
    bToggle.setAttribute('aria-expanded', String(replaceOpen)); bToggle.firstChild.textContent = replaceOpen ? '▾' : '▸';
  }
  function step(dir, { focusEditor = true } = {}) {
    const q = qInput.value;
    if (!q) { if (!findOpen) openFind(false); else qInput.focus(); return; }
    if (countStale) updateCount();
    if (findError) { showCount(); return; }
    const r = C.stepFind(textarea.value, fOpts, q, { start: textarea.selectionStart, end: textarea.selectionEnd }, dir);
    if (!r) { showCount(); return; }
    select(r.index, r.index + r.length, { focus: focusEditor });
    showCount(r.wrapped ? ' (wrapped)' : '');
  }
  function replaceOne() {
    if (readOnly) return;
    const q = qInput.value;
    if (!q) return;
    if (countStale) updateCount();
    const ed = C.replaceMatchEdit(textarea.value, fOpts, q, rInput.value, textarea.selectionStart, textarea.selectionEnd);
    if (ed) { applyEdit(ed, { restoreFocus: true }); countStale = true; updateCount(); }
    step(1, { focusEditor: false });
  }
  function replaceEverything() {
    if (readOnly) return;
    const q = qInput.value;
    if (!q) return;
    const r = C.replaceAllEdit(textarea.value, fOpts, q, rInput.value);
    if (r.error) { findError = r.error; showCount(); return; }
    if (!r.edit) { countEl.textContent = 'No results'; return; }
    applyEdit({ ...r.edit, selEnd: r.edit.selStart }, { restoreFocus: true });
    updateCount();
    countEl.textContent = `${r.count.toLocaleString('en-US')} replaced`;
  }
  const toggleOpt = (key, btn) => { fOpts[key] = !fOpts[key]; pressed(btn, fOpts[key]); updateCount(); };
  on(bCase, 'click', () => toggleOpt('caseSensitive', bCase));
  on(bWord, 'click', () => toggleOpt('wholeWord', bWord));
  on(bRegex, 'click', () => toggleOpt('regex', bRegex));
  on(bNext, 'click', () => step(1)); on(bPrev, 'click', () => step(-1));
  on(bClose, 'click', closeFind); on(bToggle, 'click', () => setReplaceOpen(!replaceOpen));
  on(bRep, 'click', replaceOne); on(bAll, 'click', replaceEverything);
  on(qInput, 'input', scheduleCount);
  on(findBar, 'keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    else if (e.key === 'Enter' && e.target === qInput) { e.preventDefault(); step(e.shiftKey ? -1 : 1, { focusEditor: false }); }
    else if (e.key === 'Enter' && e.target === rInput) { e.preventDefault(); if (mod) replaceEverything(); else replaceOne(); }
    else if (e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (mod && !e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); setReplaceOpen(true); rInput.focus(); }
    else if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); qInput.focus(); qInput.select(); }
  });

  // ---------------------------------------------------------------- fullscreen
  let fs = false, fsNative = false, fsSaved = null;
  const saveView = () => { fsSaved = { st: textarea.scrollTop, sl: textarea.scrollLeft, s: textarea.selectionStart, e: textarea.selectionEnd, focus: root.contains(document.activeElement) }; };
  const restoreView = () => requestAnimationFrame(() => {
    if (destroyed || !fsSaved) return;
    measureScrollbars(); schedule(M | T | S | K);
    if (fsSaved.focus) { textarea.focus({ preventScroll: true }); try { textarea.setSelectionRange(fsSaved.s, fsSaved.e); } catch { /* ignore */ } }
    textarea.scrollTop = fsSaved.st; textarea.scrollLeft = fsSaved.sl;
    fsSaved = null;
  });
  function applyFsState(on) {
    fs = on;
    root.classList.toggle('ed-fs', on);
    if (buttons.fullscreen) { pressed(buttons.fullscreen, on); const lab = on ? 'Exit full screen (Esc)' : TOOLS.fullscreen.label; buttons.fullscreen.title = lab; buttons.fullscreen.setAttribute('aria-label', lab); }
    document.documentElement.classList.toggle('ed-lock', on && !fsNative);
  }
  function toggleFullscreen(force) {
    const want = force === undefined ? !fs : !!force;
    if (want === fs) return;
    saveView();
    if (want) {
      const api = root.requestFullscreen && document.fullscreenEnabled;
      if (api) {
        root.requestFullscreen().then(() => { fsNative = true; applyFsState(true); restoreView(); }).catch(() => { fsNative = false; applyFsState(true); restoreView(); });
      } else { fsNative = false; applyFsState(true); restoreView(); }
    } else if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    else { fsNative = false; applyFsState(false); restoreView(); }
  }
  on(document, 'fullscreenchange', () => {
    if (document.fullscreenElement === root) { fsNative = true; applyFsState(true); }
    else if (fs && fsNative) { fsNative = false; applyFsState(false); restoreView(); }
  });

  // ---------------------------------------------------------------- toolbar actions
  async function copy() {
    const ok = await copyText(textarea.value);
    if (ok && document.fullscreenElement === root) say('Copied to clipboard');
  }
  function download() {
    const name = (typeof o.filename === 'function' ? o.filename() : o.filename) || 'download.txt';
    const ok = downloadFile(name, textarea.value, o.mime || 'text/plain;charset=utf-8');
    if (!ok && document.fullscreenElement === root) say('Nothing to download', 'warn');
  }
  async function loadFile(file) {
    if (!file || readOnly) return;
    const chk = C.checkTextFile(file, o.maxBytes);
    if (!chk.ok) { say(`${file.name || 'File'}: ${chk.reason}`, 'error'); return; }
    let content;
    try { content = await readFileAsText(file); } catch { say(`Could not read ${file.name || 'the file'}`, 'error'); return; }
    if (C.hasNul(content)) { say(`${file.name || 'File'} looks like a binary file (it contains NUL bytes)`, 'error'); return; }
    setValue(content, { keepUndo: true });
    textarea.setSelectionRange(0, 0); textarea.scrollTop = 0; textarea.scrollLeft = 0;
    schedule(T | S | K);
    o.onUpload?.(file, content);
  }
  async function upload() { if (!readOnly) loadFile(await pickFile(o.accept || '')); }
  async function clear() {
    if (readOnly) return;
    if (textarea.value && o.confirmClear) {
      if (document.fullscreenElement === root) await document.exitFullscreen().catch(() => {}); // the dialog would be hidden behind the fullscreen element
      if (!(await confirmDialog('Clear editor?', 'This removes all of the text. You can undo it with Ctrl+Z straight afterwards.', 'Clear'))) return;
    }
    setValue('', { keepUndo: true });
    focus();
  }

  // ---------------------------------------------------------------- drag & drop (files only: dragging text inside the editor stays native)
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  if (o.drop !== false) {
    on(root, 'dragenter', e => { if (!hasFiles(e) || readOnly) return; e.preventDefault(); dragDepth++; root.classList.add('dragover'); });
    on(root, 'dragover', e => { if (!hasFiles(e) || readOnly) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('dragover'); });
    on(root, 'dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) root.classList.remove('dragover'); });
    on(root, 'drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; root.classList.remove('dragover');
      if (!readOnly) loadFile(e.dataTransfer.files[0]);
    });
  }

  // ---------------------------------------------------------------- keyboard
  const pairs = C.DEFAULT_PAIRS, closers = new Set(Object.values(pairs));
  const autoClose = () => (o.autoClose !== undefined ? !!o.autoClose : cfg.autoClose);
  function onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === 'Escape') {
      if (findOpen) { e.preventDefault(); closeFind(); return; }
      if (fs && !fsNative) { e.preventDefault(); toggleFullscreen(false); }
      released = true; schedule(K); return;
    }
    if (mod && !e.altKey && !e.shiftKey && (k === 'f' || k === 'F')) { e.preventDefault(); openFind(false); return; }
    if (mod && !e.altKey && !e.shiftKey && (k === 'h' || k === 'H')) { e.preventDefault(); openFind(true); return; }
    if (k === 'F3' && !mod) { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (readOnly) return;
    const ta = textarea, s = ta.selectionStart, en = ta.selectionEnd;
    if (k === 'Tab' && !mod && !e.altKey) {
      if (released) return;
      e.preventDefault();
      const ed = C.tabEdit(ta.value, s, en, { shift: e.shiftKey, unit: indentUnit() });
      if (ed) applyEdit(ed);
      return;
    }
    if (k === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const ed = C.enterEdit(ta.value, s, en, { unit: indentUnit(), colon: cfg.colon, tags: cfg.tags });
      if (ed) { e.preventDefault(); applyEdit(ed); }
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && k === '/') {
      const tok = cfg.comment;
      if (!tok) return;
      e.preventDefault(); applyEdit(C.toggleCommentEdit(ta.value, s, en, tok)); return;
    }
    if (mod && e.shiftKey && !e.altKey && (k === 'D' || k === 'd')) { e.preventDefault(); applyEdit(C.duplicateLineEdit(ta.value, s, en)); return; }
    if (mod && e.shiftKey && !e.altKey && (k === 'K' || k === 'k')) { e.preventDefault(); applyEdit(C.deleteLineEdit(ta.value, s, en)); return; }
    if (e.altKey && !mod && !e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault(); applyEdit(C.moveLinesEdit(ta.value, s, en, k === 'ArrowUp' ? -1 : 1)); return;
    }
    if (!mod && !e.altKey && autoClose()) {
      if (k.length === 1 && (pairs[k] !== undefined || closers.has(k))) {
        const ed = C.autoCloseEdit(ta.value, s, en, k, pairs);
        if (ed) { e.preventDefault(); applyEdit(ed); }
      } else if (k === 'Backspace' && s === en) {
        const ed = C.autoCloseBackspace(ta.value, s, en, pairs);
        if (ed) { e.preventDefault(); applyEdit(ed); }
      }
    }
  }
  on(textarea, 'keydown', onKeyDown);
  on(root, 'keydown', e => { // Ctrl+F / Ctrl+H from the toolbar; Esc leaves CSS fullscreen when focus is in the toolbar
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(false); }
    else if (mod && !e.altKey && !e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openFind(true); }
    else if (e.key === 'Escape' && fs && !fsNative) { e.preventDefault(); toggleFullscreen(false); }
  });
  on(textarea, 'blur', () => { released = false; schedule(K); });
  on(textarea, 'focus', () => schedule(K));

  // ---------------------------------------------------------------- events: input, scroll, caret, composition, resize
  on(textarea, 'input', () => { if (composing) { schedule(K); } else schedule(T | K); o.onChange?.(textarea.value); });
  on(textarea, 'scroll', syncScroll, { passive: true });
  for (const ev of ['keyup', 'mouseup', 'select', 'selectionchange', 'touchend']) on(textarea, ev, () => schedule(K));
  on(textarea, 'compositionstart', () => { composing = true; root.classList.add('ed-composing'); });
  on(textarea, 'compositionend', () => { composing = false; root.classList.remove('ed-composing'); schedule(T | K); });
  on(gutter, 'mousedown', e => {
    e.preventDefault();
    if (!starts) return;
    const y = e.clientY - gutter.getBoundingClientRect().top + textarea.scrollTop - padTop;
    const sel = C.lineSelection(textarea.value, C.clamp(Math.floor(y / lh), 0, lines - 1));
    if (sel) { textarea.focus({ preventScroll: true }); textarea.setSelectionRange(sel.start, sel.end); schedule(K); }
  });
  on(gutter, 'wheel', e => { textarea.scrollTop += e.deltaY; textarea.scrollLeft += e.deltaX; }, { passive: true });
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => schedule(R | S | K)); ro.observe(stage); }
  if (forcedMq) { const f = () => schedule(T); forcedMq.addEventListener?.('change', f); offs.push(() => forcedMq.removeEventListener?.('change', f)); }

  // instance-level `value` accessor: programmatic assignments refresh the overlay
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(textarea, 'value', {
    configurable: true, enumerable: true,
    get() { return proto.get.call(textarea); },
    set(v) { proto.set.call(textarea, v); schedule(T | S | K); },
  });

  // ---------------------------------------------------------------- public API
  function getValue() { return textarea.value; }
  /** Replace the whole text. keepUndo: go through execCommand so Ctrl+Z restores the previous text (fires `input`). */
  function setValue(v, { keepUndo = false } = {}) {
    v = String(v ?? '');
    if (keepUndo && !readOnly && !destroyed) {
      const cur = textarea.value;
      if (cur === v) return;
      const prev = document.activeElement;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, cur.length);
      let ok = false;
      try { ok = v === '' ? document.execCommand('delete') : document.execCommand('insertText', false, v); } catch { ok = false; }
      if (!ok || textarea.value !== v) { proto.set.call(textarea, v); textarea.dispatchEvent(new Event('input', { bubbles: true })); }
      if (prev && prev !== textarea && prev.isConnected) prev.focus({ preventScroll: true });
    } else textarea.value = v;
    schedule(T | S | K);
  }
  function focus() { textarea.focus(); }
  function setWrap(v) {
    wrap = !!v;
    if (buttons.wrap) pressed(buttons.wrap, wrap);
    write(o.storage, `${skey}:wrap`, wrap);
    curWin = null; if (wrap) textarea.scrollLeft = 0;
    schedule(T | S | K | M);
  }
  function setFontSize(n, persist = true) {
    fontSize = C.clampFontSize(n);
    if (persist) write(o.storage, `${skey}:fs`, fontSize);
    if (buttons.fontSmaller) buttons.fontSmaller.disabled = fontSize <= C.LIMITS.fontMin;
    if (buttons.fontLarger) buttons.fontLarger.disabled = fontSize >= C.LIMITS.fontMax;
    for (const b of [buttons.fontSmaller, buttons.fontLarger]) if (b) b.title = `${b.getAttribute('aria-label')} (now ${fontSize}px)`;
    schedule(T | S | K | M);
  }
  function setHighlighter(fn) {
    customHighlighter = typeof fn === 'function' ? fn : null;
    highlighter = customHighlighter || C.getHighlighter(cfg.name);
    segs = null; curWin = null; hlFor = null;
    schedule(T | S);
  }
  /** Change the language: comment tokens, auto-indent and (unless a custom highlighter was given) the highlighter. */
  function setLanguage(language) {
    cfg = C.languageConfig(language);
    if (!customHighlighter) highlighter = C.getHighlighter(language);
    segs = null; curWin = null; hlFor = null;
    schedule(T | S);
  }
  function setReadOnly(v) {
    readOnly = !!v; textarea.readOnly = readOnly;
    root.classList.toggle('ed-readonly', readOnly);
    hint.textContent = readOnly ? 'Read-only text.' : 'Tab inserts indentation. Press Escape, then Tab, to move focus out of the editor.';
    if (buttons.upload) buttons.upload.disabled = readOnly;
    if (buttons.clear) buttons.clear.disabled = readOnly;
    if (readOnly) setReplaceOpen(false);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf); clearTimeout(bigTimer); clearTimeout(countTimer); clearTimeout(msgTimer); clearTimeout(saveTimer);
    ro?.disconnect();
    if (fs) {
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      document.documentElement.classList.remove('ed-lock');
    }
    offs.splice(0).forEach(f => f());
    delete textarea.value; // drop the instance accessor; the prototype one takes over again
    const host = root.parentNode;
    if (host) host.insertBefore(textarea, root);
    root.remove(); mirror.remove();
    textarea.className = orig.cls; textarea.readOnly = orig.ro;
    if (orig.fs) textarea.style.fontSize = orig.fs;
    for (const [attr, val] of [['aria-describedby', orig.describedby], ['aria-label', orig.label], ['wrap', orig.wrapAttr]]) {
      if (val === null || val === undefined) textarea.removeAttribute(attr); else textarea.setAttribute(attr, val);
    }
    instances.delete(textarea);
  }

  const api = {
    textarea, root, getValue, setValue, focus, find: () => openFind(false), replace: () => openFind(true), setWrap, setFontSize,
    toggleFullscreen, download, clear, setHighlighter, setLanguage, setReadOnly, destroy, select, reveal,
    get wrap() { return wrap; }, get fontSize() { return fontSize; }, get readOnly() { return readOnly; },
  };
  instances.set(textarea, api);

  // initial paint
  if (buttons.wrap) pressed(buttons.wrap, wrap);
  setFontSize(fontSize, false);
  measure();
  onText(); measureScrollbars(); renderWindow(true); updateCurLine(); updatePos();
  schedule(M | R);
  return api;
}
