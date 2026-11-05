/**
 * Folio — small UI helpers: modal dialogs, toasts and the notice banner.
 * Uses the native <dialog> element so focus trapping and Esc work for free.
 */
(function (Folio) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {};

  /**
   * Show a modal dialog.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string|Node} [opts.body]    HTML string or DOM node
   * @param {Array<{label:string,value:string,primary?:boolean,danger?:boolean}>} [opts.actions]
   * @param {function(HTMLFormElement):any} [opts.collect] reads form values when the primary action is used
   * @returns {Promise<{action:string, values:any}>}
   */
  ui.modal = function (opts) {
    const dialog = $('modal');
    const form = $('modalForm');
    $('modalTitle').textContent = opts.title || '';
    const body = $('modalBody');
    body.innerHTML = '';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    const actions = $('modalActions');
    actions.innerHTML = '';
    const list = opts.actions || [{ label: 'OK', value: 'ok', primary: true }];
    list.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.value = a.value;
      b.textContent = a.label;
      b.className = 'btn' + (a.primary ? ' btn--primary' : '') + (a.danger ? ' btn--danger' : '');
      // Secondary buttons must not trigger native form validation.
      if (!a.primary) b.formNoValidate = true;
      actions.appendChild(b);
    });

    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        const action = dialog.returnValue || 'cancel';
        const values = opts.collect && action !== 'cancel' ? opts.collect(form) : null;
        resolve({ action, values });
      };
      dialog.returnValue = '';
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      const focusTarget = body.querySelector('input, select, textarea') || actions.querySelector('.btn--primary');
      if (focusTarget) setTimeout(() => focusTarget.focus(), 0);
    });
  };

  /** Simple confirmation; resolves true when the primary action is chosen. */
  ui.confirm = async function (title, message, okLabel = 'Continue', danger = false) {
    const res = await ui.modal({
      title,
      body: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: okLabel, value: 'ok', primary: true, danger }
      ]
    });
    return res.action === 'ok';
  };

  /** Error dialog with a headline and optional technical detail. */
  ui.error = function (title, message, detail) {
    const u = Folio.util;
    let html = `<p>${message}</p>`;
    if (detail) html += `<details class="error-detail"><summary>Technical details</summary><pre>${u.escapeHtml(detail)}</pre></details>`;
    return ui.modal({ title, body: html, actions: [{ label: 'OK', value: 'ok', primary: true }] });
  };

  /* ---------------------------------------------------------------------- */
  /* Toasts                                                                  */
  /* ---------------------------------------------------------------------- */
  let toastTimer = null;
  ui.toast = function (message, ms = 2600) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('is-visible');
      setTimeout(() => { t.hidden = true; }, 200);
    }, ms);
  };

  /* ---------------------------------------------------------------------- */
  /* Notice banner (persistent until dismissed)                              */
  /* ---------------------------------------------------------------------- */
  ui.notice = function (html, kind = 'info') {
    const n = $('notice');
    $('noticeBody').innerHTML = html;
    n.dataset.kind = kind;
    n.hidden = false;
  };
  ui.hideNotice = function () { $('notice').hidden = true; };

  document.addEventListener('DOMContentLoaded', () => {
    $('noticeClose').addEventListener('click', ui.hideNotice);
  });

  Folio.ui = ui;
})(window.Folio = window.Folio || {});
