import { copyText, downloadFile, toast, pickFile, enableDrop, showMessage, initTabs, bindActions, readFileAsText, enableTabIndent, el } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

const SAMPLE = { name: 'Developer Toolbox', version: 1.2, active: true, tags: ['json', 'xml', 'yaml'], owner: { name: 'Ada', email: 'ada@example.com' }, items: [{ id: 1, label: 'First, item', price: 9.5 }, { id: 2, label: 'Second "quoted"', price: null }] };

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const input = q('input'), output = q('output'), msg = q('msg'), tree = q('tree'), indentSel = q('indent'), sortCb = q('sort');
    indentSel.value = L.choiceFromUnit(ctx.indentUnit);
    enableTabIndent(input, ctx.indentUnit);
    let result = { text: '', ext: 'json', mime: 'application/json', label: 'JSON' };
    let activeTab = 'text';

    // Restore last input (skipped when huge to respect storage limits).
    try { const saved = ctx.storage.get('input'); if (saved) input.value = saved; } catch { /* ignore */ }
    const save = () => { try { input.value.length < 500000 ? ctx.storage.set('input', input.value) : ctx.storage.remove('input'); } catch { /* ignore */ } };
    input.addEventListener('input', save);

    const setOutput = (text, ext, mime, label) => {
      result = { text, ext, mime, label };
      output.value = text; q('fmt').textContent = label;
    };
    const fail = r => {
      showMessage(msg, 'error', r.message);
      if (r.offset != null) { input.focus(); input.setSelectionRange(r.offset, Math.min(r.offset + 1, input.value.length)); }
    };
    /** Parse input and run a converter; errors are shown inline. */
    const run = (fn, ext, mime, label, okMsg) => {
      const r = L.parseJson(input.value);
      if (!r.ok) return fail(r);
      const v = sortCb.checked ? L.sortKeys(r.value) : r.value;
      try { setOutput(fn(v), ext, mime, label); showMessage(msg, 'success', okMsg); selectTab('text'); }
      catch (e) { showMessage(msg, 'error', e.message); }
    };

    const selectTab = initTabs(root, name => { activeTab = name; q('treetools').hidden = name !== 'tree'; if (name === 'tree') renderTree(); });

    // ---- Tree view (DOM nodes only; values go through textContent) ----
    function renderTree() {
      tree.replaceChildren();
      const r = L.parseJson(input.value);
      if (!r.ok) { tree.append(el('div', { class: 'alert alert-error' }, r.message)); return; }
      tree.append(node(null, sortCb.checked ? L.sortKeys(r.value) : r.value, true));
    }
    const leaf = v => { const t = L.typeOf(v); return el('span', { class: `jt-${t}` }, t === 'string' ? JSON.stringify(v) : String(v)); };
    function node(key, v, isRoot) {
      const wrap = el('div', { class: 'jt-node' }), row = el('div', { class: 'jt-row' });
      const keyEl = key === null ? [] : [el('span', { class: 'jt-key' }, typeof key === 'number' ? String(key) : JSON.stringify(key)), ':'];
      const isObj = v && typeof v === 'object';
      if (!isObj || !Object.keys(v).length) {
        row.append(el('span', { class: 'jt-spacer' }), ...keyEl, isObj ? el('span', { class: 'jt-meta' }, Array.isArray(v) ? '[]' : '{}') : leaf(v));
        wrap.append(row); return wrap;
      }
      const isArr = Array.isArray(v), keys = Object.keys(v);
      const toggle = el('button', { class: 'jt-toggle', 'aria-expanded': 'false', 'aria-label': 'Toggle' }, '▶');
      row.append(toggle, ...keyEl, el('span', { class: 'jt-meta' }, isArr ? `[ ${keys.length} ]` : `{ ${keys.length} }`));
      const kids = el('div', { class: 'jt-children', hidden: true });
      let built = false; // children are created lazily on first expand
      const set = open => {
        if (open && !built) { built = true; keys.forEach(k => kids.append(node(isArr ? Number(k) : k, v[k], false))); }
        kids.hidden = !open; toggle.setAttribute('aria-expanded', open); toggle.textContent = open ? '▼' : '▶';
      };
      toggle.addEventListener('click', () => set(kids.hidden));
      row.addEventListener('dblclick', () => set(kids.hidden));
      wrap.append(row, kids);
      if (isRoot) set(true);
      return wrap;
    }
    const expandAll = () => {
      let t, guard = 0;
      while ((t = tree.querySelector('.jt-toggle[aria-expanded="false"]')) && guard++ < 20000) t.click();
      if (guard >= 20000) toast('Very large document: expanded the first 20,000 nodes only', 'warn');
    };
    const collapseAll = () => tree.querySelectorAll('.jt-toggle[aria-expanded="true"]').forEach((t, i) => { if (i > 0) t.click(); });

    const loadText = (text, name) => { input.value = text; save(); showMessage(msg, 'info', `Loaded ${name}`); if (activeTab === 'tree') renderTree(); };
    const loadFile = async f => { try { loadText(await readFileAsText(f), f.name); } catch (e) { showMessage(msg, 'error', 'Could not read file: ' + e.message); } };

    bindActions(root, {
      format() { const ind = L.indentFrom(indentSel.value); run(v => L.formatJson(v, ind), 'json', 'application/json', 'JSON', 'Formatted successfully.'); },
      minify() { run(L.minifyJson, 'json', 'application/json', 'JSON', 'Minified successfully.'); },
      validate() {
        const r = L.parseJson(input.value);
        if (!r.ok) return fail(r);
        const s = L.stats(r.value);
        showMessage(msg, 'success', `Valid JSON — root is ${L.typeOf(r.value)}, ${s.nodes} values, depth ${s.depth}.`);
      },
      xml() { run(v => L.toXml(v, { indent: L.indentFrom(indentSel.value) }), 'xml', 'application/xml', 'XML', 'Converted to XML.'); },
      csv() { run(v => L.toCsv(v), 'csv', 'text/csv;charset=utf-8', 'CSV', 'Converted to CSV (nested keys flattened with dots).'); },
      yaml() { const i = L.indentFrom(indentSel.value); run(v => L.toYaml(v, typeof i === 'number' ? i : 2), 'yaml', 'text/yaml', 'YAML', 'Converted to YAML.'); },
      copy() { copyText(result.text, `${result.label} copied`); },
      download() { downloadFile(`output.${result.ext}`, result.text, result.mime); },
      use() {
        if (!result.text) return toast('No output yet', 'warn');
        if (result.ext !== 'json') return toast('Only JSON output can be used as input', 'warn');
        input.value = result.text; save(); if (activeTab === 'tree') renderTree();
      },
      sample() { input.value = JSON.stringify(SAMPLE, null, L.indentFrom(indentSel.value)); save(); showMessage(msg, null); if (activeTab === 'tree') renderTree(); },
      clear() { input.value = ''; setOutput('', 'json', 'application/json', 'JSON'); tree.replaceChildren(); showMessage(msg, null); save(); input.focus(); },
      async upload() { const f = await pickFile('.json,application/json,.txt'); if (f) loadFile(f); },
      expand: expandAll,
      collapse: collapseAll,
    });

    const offDrop = enableDrop(q('inpanel'), loadFile);
    return () => offDrop();
  },
};
