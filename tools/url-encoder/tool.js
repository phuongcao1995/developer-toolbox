import { copyText, downloadFile, pickFile, readFileAsText, showMessage, initTabs, bindActions,
  escapeHtml, renderIcons, el } from '../../assets/js/components/ui.js';
import { encodeComponent, decodeComponent, encodeFull, decodeFull, parseUrl, buildUrl, buildQuery, parseQuery } from './logic.js';

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);

    // ---------- Encode / Decode ----------
    const inp = $('urlenc-in'), out = $('urlenc-out'), msg = $('urlenc-msg');
    const mode = () => $('urlenc-mode').value;
    const form = () => mode() === 'component' && $('urlenc-form').checked;
    const syncForm = () => { $('urlenc-form-wrap').style.display = mode() === 'component' ? '' : 'none'; };
    $('urlenc-mode').addEventListener('change', syncForm);
    const run = (fn, src, dest) => {
      showMessage(msg, null);
      if (!src.value) return showMessage(msg, 'error', 'Input is empty.');
      try { dest.value = fn(src.value); }
      catch (e) { showMessage(msg, 'error', e.message); }
    };

    // ---------- Parser ----------
    let base = null;   // parsed fields of the last parse
    let params = [];   // editable rows {key,value,hasEq}
    const uMsg = $('urlenc-url-msg');

    const builtUrl = () => buildUrl(base, params, { spaceAsPlus: $('urlenc-plus').checked });

    const renderFields = fields => {
      const rows = [['protocol', fields.protocol], ['username', fields.username], ['password', fields.password],
        ['hostname', fields.hostname], ['port', fields.port], ['origin', fields.origin],
        ['pathname', fields.pathname], ['search', fields.search], ['hash', fields.hash]];
      $('urlenc-fields').innerHTML = rows.map(([k, v], i) =>
        `<tr><td><code>${k}</code></td>` +
        (v ? `<td class="urlenc-val">${escapeHtml(v)}</td>` : '<td class="urlenc-val urlenc-empty">(empty)</td>') +
        `<td class="urlenc-act"><button class="btn btn-sm btn-ghost" data-action="copy-field" data-i="${i}" aria-label="Copy ${k}"${v ? '' : ' disabled'}><i data-lucide="copy"></i></button></td></tr>`).join('');
      $('urlenc-fields')._rows = rows;
      renderIcons($('urlenc-fields'));
    };
    const refreshBuilt = () => {
      if (!base) return;
      const url = builtUrl();
      $('urlenc-built').textContent = url;
      // Re-derive the read-only component table from the rebuilt URL so pathname/search/hash stay accurate.
      const re = parseUrl(url);
      if (re.ok) renderFields(re.fields);
    };
    const renderParams = () => {
      const tb = $('urlenc-params');
      tb.replaceChildren(...params.map((p, i) => {
        const key = el('input', { class: 'input', value: p.key, 'aria-label': 'Key', spellcheck: 'false' });
        const val = el('input', { class: 'input', value: p.value, 'aria-label': 'Value', spellcheck: 'false' });
        const tr = el('tr', { class: p.malformed ? 'urlenc-bad' : '', title: p.malformed ? 'Contained a malformed % sequence; shown raw' : '' },
          el('td', {}, key), el('td', {}, val),
          el('td', { class: 'urlenc-act' },
            el('button', { class: 'btn btn-sm btn-ghost', 'aria-label': 'Remove parameter', 'data-action': 'del-param', 'data-i': i, html: '<i data-lucide="trash-2"></i>' })));
        key.addEventListener('input', () => { p.key = key.value; refreshBuilt(); });
        val.addEventListener('input', () => { p.value = val.value; p.hasEq = true; refreshBuilt(); });
        return tr;
      }));
      $('urlenc-count').textContent = params.length;
      $('urlenc-params-empty').hidden = params.length > 0;
      renderIcons(tb);
    };
    const parse = (assumeHttps = false) => {
      showMessage(uMsg, null);
      const r = parseUrl($('urlenc-url').value, { assumeHttps });
      if (!r.ok) {
        $('urlenc-parsed').hidden = true; base = null;
        showMessage(uMsg, 'error', r.error);
        if (r.canAssumeHttps) {
          const btn = el('button', { class: 'btn btn-sm', style: 'margin-left:8px', 'data-action': 'assume-https' }, 'Assume https://');
          uMsg.append(' ', btn);
        }
        return;
      }
      if (r.assumedHttps) {
        $('urlenc-url').value = r.fields.href;
        showMessage(uMsg, 'info', 'No protocol found, so https:// was assumed.');
      }
      base = r.fields; params = r.params;
      $('urlenc-plus').checked = /\+/.test(r.fields.search);
      $('urlenc-parsed').hidden = false;
      renderFields(r.fields); renderParams();
      $('urlenc-built').textContent = builtUrl();
    };
    // Parse live (debounced via rAF-free simple timer) as the user types.
    let timer = null;
    $('urlenc-url').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { if ($('urlenc-url').value.trim()) parse(); }, 350); });
    $('urlenc-url').addEventListener('keydown', e => { if (e.key === 'Enter') parse(); });
    $('urlenc-plus').addEventListener('change', refreshBuilt);

    bindActions(root, {
      encode: () => run(s => mode() === 'full' ? encodeFull(s) : encodeComponent(s, { form: form() }), inp, out),
      decode: () => run(s => mode() === 'full' ? decodeFull(s) : decodeComponent(s, { form: form() }), inp, out),
      swap: () => { [inp.value, out.value] = [out.value, inp.value]; showMessage(msg, null); },
      clear: () => { inp.value = ''; out.value = ''; showMessage(msg, null); },
      'copy-in': () => copyText(inp.value),
      'copy-out': () => copyText(out.value),
      download: () => downloadFile('url-encoded.txt', out.value),
      open: async () => { const f = await pickFile('.txt,text/*'); if (f) { try { inp.value = (await readFileAsText(f)).trim(); } catch (e) { showMessage(msg, 'error', e.message); } } },

      parse: () => parse(),
      'assume-https': () => parse(true),
      'url-sample': () => { $('urlenc-url').value = 'https://user:p%40ss@example.com:8080/a%20b/c?q=hello+world&tag=a&tag=b&empty=&flag#section-2'; parse(); },
      'url-clear': () => { $('urlenc-url').value = ''; $('urlenc-parsed').hidden = true; base = null; params = []; showMessage(uMsg, null); },
      'copy-field': (e, b) => copyText($('urlenc-fields')._rows[Number(b.dataset.i)][1]),
      'add-param': () => {
        if (!base) return showMessage(uMsg, 'error', 'Parse a URL first.');
        params.push({ key: '', value: '', hasEq: true }); renderParams(); refreshBuilt();
        $('urlenc-params').lastElementChild?.querySelector('input')?.focus();
      },
      'del-param': (e, b) => { params.splice(Number(b.dataset.i), 1); renderParams(); refreshBuilt(); },
      'copy-built': () => copyText($('urlenc-built').textContent),
      'use-built': () => { $('urlenc-url').value = $('urlenc-built').textContent; parse(); },
    });

    syncForm();
    initTabs(root);
    renderIcons(root);
    return () => clearTimeout(timer);
  },
};
