import { copyText, downloadFile, showMessage, bindActions, el, escapeHtml, renderIcons } from '../../assets/js/components/ui.js';
import { generateMany, formatUuid, parseCount, inspectUuid, NIL_UUID, MAX_UUID, SEPARATORS } from './logic.js';

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const msg = $('uuid-msg');
    let canonical = []; // lowercase hyphenated UUIDs; display formatting is applied on render

    // Restore saved options.
    const saved = ctx.storage.get('opts', {}) || {};
    const ids = { upper: 'uuid-upper', hyphens: 'uuid-hyphens', braces: 'uuid-braces', urn: 'uuid-urn' };
    for (const [k, id] of Object.entries(ids)) if (typeof saved[k] === 'boolean') $(id).checked = saved[k];
    if (saved.sep && SEPARATORS[saved.sep]) $('uuid-sep').value = saved.sep;
    if (saved.count) $('uuid-count').value = saved.count;
    if (saved.version === '4' || saved.version === '7') $('uuid-version').value = saved.version;

    const fmtOpts = () => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, $(id).checked]));
    const formatted = () => canonical.map(u => formatUuid(u, fmtOpts()));
    const joined = () => formatted().join(SEPARATORS[$('uuid-sep').value]);
    const persist = () => ctx.storage.set('opts', { ...fmtOpts(), sep: $('uuid-sep').value, count: $('uuid-count').value, version: $('uuid-version').value });

    function render() {
      const list = $('uuid-list'), items = formatted();
      $('uuid-total').textContent = items.length;
      if (!items.length) { list.innerHTML = '<p class="hint uuid-pad">Nothing generated yet.</p>'; return; }
      // Same number of rows already shown (display-option change): only update the text of the changed rows.
      const codes = list.querySelectorAll('.uuid-item code');
      if (codes.length === items.length) { codes.forEach((c, i) => { if (c.textContent !== items[i]) c.textContent = items[i]; }); return; }
      const frag = document.createDocumentFragment();
      items.forEach((u, i) => frag.append(el('div', { class: 'uuid-item' },
        el('span', { class: 'uuid-idx' }, String(i + 1)), el('code', {}, u),
        el('button', { class: 'btn btn-sm btn-ghost', 'data-action': 'copy-one', 'data-i': i, 'aria-label': `Copy UUID ${i + 1}`, title: 'Copy', html: '<i data-lucide="copy"></i>' }))));
      list.replaceChildren(frag);
      renderIcons(list);
    }

    // Changing display options re-formats existing results without regenerating them.
    Object.values(ids).forEach(id => $(id).addEventListener('change', () => { persist(); render(); }));
    $('uuid-sep').addEventListener('change', persist);
    $('uuid-count').addEventListener('change', persist);
    $('uuid-version').addEventListener('change', persist);

    const generate = () => {
      showMessage(msg, null);
      try {
        const n = parseCount($('uuid-count').value);
        canonical = generateMany(n, {}, undefined, { version: Number($('uuid-version').value) }); // canonical form
        persist(); render();
      } catch (e) { showMessage(msg, 'error', e.message); }
    };

    // ---------- inspector ----------
    const inspect = () => {
      const out = $('uuid-inspect-out'), v = $('uuid-inspect').value;
      if (!v.trim()) { out.hidden = true; return; }
      const r = inspectUuid(v);
      out.hidden = false;
      if (!r.valid) { out.className = 'alert alert-error'; out.textContent = r.message; return; }
      out.className = 'alert alert-success';
      const rows = [['Canonical', r.canonical], ['Version', r.version == null ? (r.versionName || '-') : `${r.version}${r.versionName ? ' - ' + r.versionName : ' (non-standard)'}`], ['Variant', r.variant]];
      if (r.timestamp) rows.push(['Embedded timestamp (UTC)', r.timestamp.iso], ['Unix milliseconds', String(r.timestamp.ms)]);
      out.innerHTML = '<strong>Valid UUID</strong><dl class="uuid-kv">' + rows.map(([k, x]) => `<dt>${k}</dt><dd>${escapeHtml(x)}</dd>`).join('') + '</dl>';
    };
    $('uuid-inspect').addEventListener('input', inspect);

    bindActions(root, {
      generate,
      nil: () => { showMessage(msg, null); canonical = [NIL_UUID]; render(); },
      max: () => { showMessage(msg, null); canonical = [MAX_UUID]; render(); },
      'copy-all': () => copyText(joined(), `Copied ${canonical.length} UUID${canonical.length === 1 ? '' : 's'}`),
      download: () => downloadFile('uuids.txt', joined()),
      clear: () => { canonical = []; showMessage(msg, null); render(); },
      'copy-one': (e, b) => copyText(formatted()[Number(b.dataset.i)]),
      'inspect-clear': () => { $('uuid-inspect').value = ''; inspect(); },
    });

    generate();
    renderIcons(root);
    return () => {};
  },
};
