// Shared UI helpers used by the shell and by every tool.
import { ICONS } from '../icons.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Hyperscript-lite: el('div', {class:'x', onclick}, child|string...) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    // ARIA states are strings, not HTML boolean attributes: aria-pressed={true} must read "true" (an empty value is treated as unset
    // by assistive technology) and aria-pressed={false} must read "false", not be omitted.
    if (typeof v === 'boolean' && k.startsWith('aria-')) { node.setAttribute(k, String(v)); continue; }
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
}

/** Debounced wrapper. The result has .cancel() (drop a pending call) and .flush() (run it now). */
let debounceScope = null;
/** Shell hook: debounces created while a scope is set are collected so they can be cancelled on unmount. */
export const setDebounceScope = scope => { debounceScope = scope; };
export const debounce = (fn, ms = 200) => {
  let t = null, last = [];
  const d = (...a) => { last = a; clearTimeout(t); t = setTimeout(() => { t = null; fn(...last); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = () => { if (t != null) { clearTimeout(t); t = null; fn(...last); } };
  debounceScope?.push(d);
  return d;
};

/** Replace every icon placeholder (an <i> with a data-lucide attribute) inside `root` with its inline SVG (icons live in assets/js/icons.js; no CDN). */
const SVG_NS = 'http://www.w3.org/2000/svg', iconTemplates = new Map(), warned = new Set();
function iconTemplate(name) {
  let t = iconTemplates.get(name);
  if (t === undefined) {
    const inner = ICONS[name];
    if (inner) {
      t = document.createElementNS(SVG_NS, 'svg');
      for (const [k, v] of Object.entries({ xmlns: SVG_NS, width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) t.setAttribute(k, v);
      t.innerHTML = inner;
    } else t = null;
    iconTemplates.set(name, t);
  }
  return t;
}
export function renderIcons(root = document) {
  for (const i of root.querySelectorAll('i[data-lucide]')) {
    const name = i.getAttribute('data-lucide'), tpl = iconTemplate(name);
    if (!tpl) { if (!warned.has(name)) { warned.add(name); console.warn(`Unknown icon "${name}" (run node scripts/build-icons.mjs)`); } continue; }
    const svg = tpl.cloneNode(true);
    svg.setAttribute('class', `lucide lucide-${name}${i.className ? ' ' + i.className : ''}`);
    for (const a of i.attributes) if (a.name !== 'data-lucide' && a.name !== 'class') svg.setAttribute(a.name, a.value);
    i.replaceWith(svg);
  }
}
export const icon = (name, cls = '') => `<i data-lucide="${escapeHtml(name)}" class="${cls}"></i>`;

// ---------- Toasts ----------
export function toast(message, type = 'info', ms = 2600) {
  let host = $('#toast-host');
  if (!host) { host = el('div', { id: 'toast-host', 'aria-live': 'polite' }); document.body.append(host); }
  const node = el('div', { class: `toast toast-${type}`, role: 'status' }, message);
  host.append(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 250); }, ms);
}

// ---------- Clipboard / files ----------
export async function copyText(text, label = 'Copied to clipboard') {
  if (text === '' || text == null) { toast('Nothing to copy', 'warn'); return false; }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { // fallback for insecure contexts
      const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(label, 'success'); return true;
  } catch { toast('Copy failed — your browser blocked clipboard access', 'error'); return false; }
}

/** Trigger a browser download. `content` may be string, Blob or ArrayBuffer. */
export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  if (content === '' || content == null) { toast('Nothing to download', 'warn'); return false; }
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export const readFileAsText = file => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(file);
});
export const readFileAsDataURL = file => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file);
});
export const readFileAsArrayBuffer = file => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file);
});

/** Open a file picker and resolve with the chosen File (or null if cancelled). */
export function pickFile(accept = '') {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Make `target` accept dropped files; calls onFile(File). Returns a disposer. */
export function enableDrop(target, onFile) {
  const on = (e) => { e.preventDefault(); target.classList.add('dragover'); };
  const off = () => target.classList.remove('dragover');
  const drop = (e) => { e.preventDefault(); off(); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); };
  target.addEventListener('dragover', on); target.addEventListener('dragleave', off); target.addEventListener('drop', drop);
  return () => { target.removeEventListener('dragover', on); target.removeEventListener('dragleave', off); target.removeEventListener('drop', drop); };
}

// ---------- Async / loading ----------
/** Disable a button and show a spinner while `fn` runs. */
export async function withLoading(btn, fn) {
  btn?.classList.add('loading'); if (btn) btn.disabled = true;
  try { return await fn(); } finally { btn?.classList.remove('loading'); if (btn) btn.disabled = false; }
}

const scriptCache = new Map();
/** Load a classic <script> from a CDN once. Rejects if it cannot be loaded (e.g. offline). */
export function loadScript(src, integrity) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((res, rej) => {
      const s = el('script', { src, ...(integrity ? { integrity, crossorigin: 'anonymous' } : {}) });
      s.onload = res; s.onerror = () => { scriptCache.delete(src); rej(new Error(`Could not load ${src} — check your internet connection.`)); };
      document.head.append(s);
    }));
  }
  return scriptCache.get(src);
}
export function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href }));
}

// ---------- Small widgets ----------
/** Show/hide an inline message box: showMessage(box, 'error'|'success'|'info'|'warn', text) / showMessage(box, null). */
export function showMessage(box, type, text) {
  if (!box) return;
  if (!type || !text) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false; box.className = `alert alert-${type}`; box.textContent = text;
  box.setAttribute('role', type === 'error' ? 'alert' : 'status');
}

/** Wire tab buttons ([data-tab]) to panels ([data-panel]) inside root. */
export function initTabs(root, onChange) {
  const tabs = $$('[data-tab]', root), panels = $$('[data-panel]', root);
  const uid = Math.random().toString(36).slice(2, 7);
  tabs[0]?.parentElement?.setAttribute('role', 'tablist');
  tabs.forEach(t => { t.setAttribute('role', 'tab'); t.id ||= `tab-${uid}-${t.dataset.tab}`; });
  panels.forEach(p => {
    p.setAttribute('role', 'tabpanel');
    const t = tabs.find(x => x.dataset.tab === p.dataset.panel);
    if (t) { p.id ||= `panel-${uid}-${p.dataset.panel}`; p.setAttribute('aria-labelledby', t.id); t.setAttribute('aria-controls', p.id); }
  });
  const select = name => {
    tabs.forEach(t => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
    panels.forEach(p => { p.hidden = p.dataset.panel !== name; });
    onChange?.(name);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t.dataset.tab));
    t.addEventListener('keydown', e => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : step ? (i + step + tabs.length) % tabs.length : null;
      if (to == null) return;
      e.preventDefault(); tabs[to].focus(); select(tabs[to].dataset.tab);
    });
  });
  if (tabs[0]) select(tabs.find(t => t.classList.contains('active'))?.dataset.tab || tabs[0].dataset.tab);
  return select;
}

/** Wire elements with data-action="name" inside root to handlers {name(event, el)}. */
export function bindActions(root, handlers) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b || !root.contains(b)) return;
    const h = handlers[b.dataset.action];
    if (h) h(e, b);
  });
}

/** Tab key inserts the configured indent in code textareas. */
export function enableTabIndent(textarea, indentUnit = '  ') {
  let released = false; // Esc releases the Tab trap so keyboard users can leave the field
  textarea.addEventListener('blur', () => { released = false; });
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Escape') { released = true; return; }
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || released) return;
    e.preventDefault();
    // execCommand keeps the native undo stack; fall back to setRangeText where unsupported.
    let ok = false;
    try { ok = document.execCommand('insertText', false, indentUnit); } catch { /* fall through */ }
    if (!ok) {
      textarea.setRangeText(indentUnit, textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

export const formatBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;

// ---------- Modal ----------
export function openModal({ title, body, actions = [], onClose }) {
  const overlay = el('div', { class: 'modal-overlay' });
  const opener = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); if (opener?.isConnected) opener.focus?.(); };
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])';
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return; // focus trap
    const f = [...overlay.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1], inside = overlay.contains(document.activeElement);
    if (!inside || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'modal-head' }, el('h3', {}, title), el('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', onclick: close }, '✕')),
    el('div', { class: 'modal-body' }, body),
    actions.length ? el('div', { class: 'modal-foot' }, actions.map(a =>
      el('button', { class: `btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''}`, onclick: () => { if (a.onClick?.() !== false) close(); } }, a.label))) : null);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  overlay.append(modal); document.body.append(overlay); document.addEventListener('keydown', onKey);
  queueMicrotask(() => { if (!overlay.contains(document.activeElement)) (modal.querySelector(`.modal-body :is(input,select,textarea,button,a[href])`) || modal.querySelector(FOCUSABLE))?.focus(); });
  return { close, modal };
}
export const confirmDialog = (title, message, confirmLabel = 'Confirm') => new Promise(res => {
  let result = false;
  openModal({ title, body: el('p', {}, message), onClose: () => res(result),
    actions: [{ label: 'Cancel' }, { label: confirmLabel, danger: true, onClick: () => { result = true; } }] });
});
