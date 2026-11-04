// Small dialog helpers on top of the shared openModal (which mounts outside the tool root, so content is wrapped in
// .tool-api-client to keep the tool's scoped CSS working).
import { el as h, openModal } from '../../assets/js/components/ui.js';

export { h };

/** Open a dialog. body: Node|Node[]; actions: [{label, primary, danger, onClick}] (return false from onClick to keep it open). */
export function dialog({ title, body, actions = [{ label: 'Close' }], wide = false, onClose }) {
  const wrap = h('div', { class: 'tool-api-client ac-dlg' }, ...[].concat(body));
  const m = openModal({ title, body: wrap, actions, onClose });
  if (wide) m.modal.style.maxWidth = 'min(920px, 100%)';
  return { ...m, body: wrap };
}

/** Ask for a line of text. Resolves with the trimmed text, or null when cancelled. */
export function askText({ title, label, value = '', confirmLabel = 'OK', hint = '' }) {
  return new Promise(resolve => {
    let result = null;
    const input = h('input', { class: 'input', type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false', maxlength: '200' });
    input.value = value;
    const err = h('div', { class: 'alert alert-error', hidden: true, role: 'alert' });
    const d = dialog({
      title, onClose: () => resolve(result),
      body: [h('label', { class: 'ac-field' }, label, input), hint ? h('p', { class: 'hint' }, hint) : null, err],
      actions: [{ label: 'Cancel' }, {
        label: confirmLabel, primary: true,
        onClick: () => {
          const v = input.value.trim();
          if (!v) { err.hidden = false; err.textContent = 'Enter a name.'; input.focus(); return false; }
          result = v;
        },
      }],
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); d.modal.querySelector('.modal-foot .btn-primary')?.click(); } });
    queueMicrotask(() => { input.focus(); input.select(); });
  });
}

/** Checkbox with a label (returns { label, input }). */
export function checkbox(text, checked = false) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  return { label: h('label', { class: 'ac-check' }, input, ' ', text), input };
}
