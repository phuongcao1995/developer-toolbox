/*
 * dialogs.js — modal dialogs (native <dialog>), toasts, context menus and the busy overlay.
 * All text is inserted with textContent.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const { el } = SheetApp.utils;

  let restoreFocus = null;

  /**
   * Opens a modal. build(body, close) fills the body and may return a submit handler:
   * submit() -> value to resolve with, or { error } to keep the dialog open.
   */
  function open({ title, build, submitText, cancelText, danger, wide, hideCancel }) {
    return new Promise((resolve) => {
      restoreFocus = document.activeElement;
      const dialog = el('dialog', { class: 'dialog' + (wide ? ' wide' : ''), 'aria-labelledby': 'dlg-title' });
      const form = el('form', { method: 'dialog', novalidate: true });
      const body = el('div', { class: 'dialog-body' });
      const error = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        dialog.close();
        dialog.remove();
        const previous = restoreFocus;
        resolve(value);
        // Restore focus after the page stops being inert, unless the caller already moved it.
        // Chromium only makes the page interactive again at the next rendering step, so focus made
        // during close can be "stuck" (reported, but not receiving input). Redo it on the next frame.
        requestAnimationFrame(() => setTimeout(() => {
          const current = document.activeElement;
          if (!current || current === document.body) {
            if (previous && previous.isConnected) previous.focus({ preventScroll: true });
          } else if (!current.closest('.is-editing') && !current.closest('dialog')) {
            current.blur();
            current.focus({ preventScroll: true });
          }
        }, 0));
      };
      const submit = build(body, close) || (() => true);
      const actions = el('div', { class: 'dialog-actions' }, [
        hideCancel ? null : el('button', { type: 'button', class: 'btn', text: cancelText || 'Cancel', onclick: () => close(null) }),
        submitText ? el('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: submitText }) : null,
      ]);
      form.append(el('h2', { id: 'dlg-title', class: 'dialog-title', text: title }), body, error, actions);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const result = await submit();
        if (result && result.error) {
          error.textContent = result.error;
          error.hidden = false;
          return;
        }
        close(result);
      });
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();
      const first = body.querySelector('input:not([type=hidden]), select, textarea') || actions.querySelector('.btn-primary, .btn-danger, .btn');
      if (first) first.focus();
    });
  }

  function paragraphs(texts) {
    return [].concat(texts || []).filter(Boolean).map((t) => el('p', { text: t }));
  }

  function warningList(items) {
    if (!items || !items.length) return null;
    return el('ul', { class: 'warning-list' }, items.map((t) => el('li', { text: t })));
  }

  function confirm({ title, message, items, confirmText, cancelText, danger }) {
    return open({
      title, submitText: confirmText || 'OK', cancelText, danger,
      build: (body) => { body.append(...paragraphs(message), warningList(items) || ''); return () => true; },
    }).then(Boolean);
  }

  function alert({ title, message, items }) {
    return open({
      title, submitText: 'OK', hideCancel: true,
      build: (body) => { body.append(...paragraphs(message), warningList(items) || ''); return () => true; },
    });
  }

  function prompt({ title, label, value, submitText, validate }) {
    return open({
      title, submitText: submitText || 'OK',
      build: (body) => {
        const input = el('input', { type: 'text', class: 'input', value: value || '', 'aria-label': label });
        body.append(field(label, input));
        setTimeout(() => input.select(), 0);
        return () => {
          const problem = validate ? validate(input.value) : null;
          return problem ? { error: problem } : input.value;
        };
      },
    });
  }

  /** Labelled form control. */
  function field(label, control, hint) {
    const id = control.id || 'f-' + Math.random().toString(36).slice(2, 9);
    control.id = id;
    return el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      control,
      hint ? el('small', { class: 'hint', text: hint }) : null,
    ]);
  }

  function select(options, value) {
    const node = el('select', { class: 'input' }, options.map(([v, label]) => el('option', { value: v, text: label })));
    if (value !== undefined) node.value = value;
    return node;
  }

  function checkbox(label, checked) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!checked;
    return { input, node: el('label', { class: 'check' }, [input, el('span', { text: label })]) };
  }

  /* ---------- Toasts ---------- */

  function toast(message, type, timeout) {
    const region = document.getElementById('toasts');
    if (!region) return;
    const node = el('div', { class: 'toast ' + (type || 'info'), role: type === 'error' ? 'alert' : 'status' }, [
      el('span', { text: message }),
      el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', text: '×', onclick: () => node.remove() }),
    ]);
    region.append(node);
    while (region.children.length > 4) region.firstChild.remove();
    setTimeout(() => node.remove(), timeout || (type === 'error' ? 8000 : 4000));
  }

  /* ---------- Context menu ---------- */

  function menu(x, y, items) {
    closeMenu();
    const list = el('div', { class: 'menu', role: 'menu' });
    const buttons = [];
    for (const item of items) {
      if (item === '-') { list.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
      const btn = el('button', {
        type: 'button', class: 'menu-item', role: 'menuitem', disabled: item.disabled,
        onclick: () => { closeMenu(); item.action(); },
      }, [el('span', { text: item.label }), item.shortcut ? el('kbd', { text: item.shortcut }) : null]);
      buttons.push(btn);
      list.append(btn);
    }
    document.body.append(list);
    const rect = list.getBoundingClientRect();
    list.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    list.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
    const enabled = buttons.filter((b) => !b.disabled);
    if (enabled[0]) enabled[0].focus();
    list.addEventListener('keydown', (e) => {
      const i = enabled.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); enabled[(i + 1) % enabled.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); enabled[(i - 1 + enabled.length) % enabled.length].focus(); }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); restoreFocus && restoreFocus.focus(); }
    });
    restoreFocus = document.activeElement === document.body ? restoreFocus : document.activeElement;
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    function outside(e) { if (!list.contains(e.target)) closeMenu(); }
    list.cleanup = () => document.removeEventListener('pointerdown', outside);
  }

  function closeMenu() {
    document.querySelectorAll('.menu').forEach((m) => { if (m.cleanup) m.cleanup(); m.remove(); });
  }

  /* ---------- Busy overlay ---------- */

  function setBusy(message) {
    const overlay = document.getElementById('busy');
    if (!overlay) return;
    overlay.querySelector('.busy-text').textContent = message || '';
    overlay.hidden = !message;
    document.body.setAttribute('aria-busy', message ? 'true' : 'false');
  }

  SheetApp.dialogs = { open, confirm, alert, prompt, field, select, checkbox, warningList, toast, menu, closeMenu, setBusy };
})(typeof window !== 'undefined' ? window : globalThis);
