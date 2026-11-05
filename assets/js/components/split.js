// Generic resizable two-panel splitter for input/output layouts. The container's two element children become the panes;
// a role="separator" handle is inserted between them. Styles: assets/css/editor.css (.split*). Math: editor-core.js.
//
//   const split = createSplit(container, { direction: 'horizontal', ratio: 0.5, min: 160, storage: ctx.storage, storageKey: 'split', labels: ['Input', 'Output'] });
//   ... split.destroy();
//
// `vertical` (one panel above the other) needs a container with a definite height (for example style="height:70vh").
import { el } from './ui.js';
import { clampRatio, ratioFromPointer, stepRatio, ratioToPercent } from './editor-core.js';

let uid = 0;

export function createSplit(container, options = {}) {
  const o = { direction: 'horizontal', ratio: 0.5, min: 160, stackBelow: 720, labels: ['first', 'second'], ...options };
  const horizontal = o.direction !== 'vertical';
  const panes = [...container.children].filter(n => n.nodeType === 1 && !n.classList.contains('split-handle')).slice(0, 2);
  if (panes.length < 2) throw new Error('createSplit needs a container with two child elements');
  const KEY = o.storageKey ? `split:${o.storageKey}` : null;
  const HANDLE = () => parseFloat(getComputedStyle(container).getPropertyValue('--split-handle')) || 8;
  const offs = [];
  const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); offs.push(() => t.removeEventListener(ev, fn, opt)); };
  const size = () => (horizontal ? container.clientWidth : container.clientHeight);

  const orig = { cls: container.className, paneCls: panes.map(p => p.className), paneId: panes.map(p => p.id), ratioVar: container.style.getPropertyValue('--split-ratio') };
  container.classList.add('split', horizontal ? 'split-horizontal' : 'split-vertical');
  panes.forEach(p => p.classList.add('split-pane'));
  panes[0].id ||= `split-pane-${++uid}`;
  const handle = el('div', { class: 'split-handle', role: 'separator', tabindex: '0', 'aria-orientation': horizontal ? 'vertical' : 'horizontal', 'aria-controls': panes[0].id,
    'aria-label': `Resize the ${o.labels[0]} and ${o.labels[1]} panels`, title: 'Drag to resize (arrow keys; Shift = larger steps; double-click to reset)', 'aria-valuemin': '0', 'aria-valuemax': '100' });
  container.insertBefore(handle, panes[1]);

  let stored = null;
  if (KEY) { try { stored = Number(o.storage?.get?.(KEY, null)); } catch { stored = null; } }
  let ratio = Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : o.ratio;
  let stacked = false, timer = 0;

  const apply = (r, persist = false) => {
    ratio = clampRatio(r, size() || 1000, o.min, HANDLE());
    container.style.setProperty('--split-ratio', String(ratio));
    const bounds = [clampRatio(0, size() || 1000, o.min, HANDLE()), clampRatio(1, size() || 1000, o.min, HANDLE())];
    handle.setAttribute('aria-valuenow', String(ratioToPercent(ratio)));
    handle.setAttribute('aria-valuemin', String(ratioToPercent(bounds[0]))); handle.setAttribute('aria-valuemax', String(ratioToPercent(bounds[1])));
    handle.setAttribute('aria-valuetext', `${ratioToPercent(ratio)}% / ${100 - ratioToPercent(ratio)}%`);
    if (persist && KEY) { clearTimeout(timer); timer = setTimeout(() => { try { o.storage?.set?.(KEY, ratio); } catch { /* ignore */ } }, 200); }
  };
  const reflow = () => {
    const narrow = container.clientWidth > 0 && container.clientWidth < o.stackBelow;
    if (narrow !== stacked) { stacked = narrow; container.classList.toggle('split-stacked', narrow); handle.hidden = narrow; }
    if (!stacked) apply(ratio);
  };

  let drag = null;
  on(handle, 'pointerdown', e => {
    if (stacked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); handle.setPointerCapture?.(e.pointerId); handle.classList.add('active');
    const rect = container.getBoundingClientRect();
    drag = { start: horizontal ? rect.left : rect.top, size: horizontal ? rect.width : rect.height };
  });
  on(handle, 'pointermove', e => {
    if (!drag) return;
    apply(ratioFromPointer(horizontal ? e.clientX : e.clientY, drag.start, drag.size, HANDLE()), true);
  });
  const end = e => { if (!drag) return; drag = null; handle.classList.remove('active'); try { handle.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ } };
  on(handle, 'pointerup', end); on(handle, 'pointercancel', end);
  on(handle, 'dblclick', () => apply(o.ratio, true));
  on(handle, 'keydown', e => {
    const dec = horizontal ? 'ArrowLeft' : 'ArrowUp', inc = horizontal ? 'ArrowRight' : 'ArrowDown';
    const px = e.shiftKey ? 64 : 16;
    let next = null;
    if (e.key === dec) next = stepRatio(ratio, -px, size(), HANDLE());
    else if (e.key === inc) next = stepRatio(ratio, px, size(), HANDLE());
    else if (e.key === 'Home') next = 0; else if (e.key === 'End') next = 1;
    else if (e.key === 'Enter') next = o.ratio;
    if (next === null) return;
    e.preventDefault(); apply(next, true);
  });

  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(reflow); ro.observe(container); }
  apply(ratio);
  reflow();

  return {
    handle, panes,
    get ratio() { return ratio; },
    get stacked() { return stacked; },
    setRatio: r => apply(r, true),
    reset: () => apply(o.ratio, true),
    destroy() {
      clearTimeout(timer); ro?.disconnect(); offs.splice(0).forEach(f => f());
      handle.remove();
      container.className = orig.cls; panes.forEach((p, i) => { p.className = orig.paneCls[i]; if (!orig.paneId[i]) p.removeAttribute('id'); });
      if (orig.ratioVar) container.style.setProperty('--split-ratio', orig.ratioVar); else container.style.removeProperty('--split-ratio');
    },
  };
}
