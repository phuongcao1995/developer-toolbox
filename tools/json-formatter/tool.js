import { copyText, downloadFile, toast, pickFile, enableDrop, showMessage, initTabs, bindActions, readFileAsText, el, formatBytes, debounce as uiDebounce } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import * as L from './logic.js';
import * as G from './generate.js';
import { createTree } from './tree.js';
import { query as jpQuery, JSONPathError } from '../../assets/js/shared/jsonpath.js';
import { validate as validateSchema, pointerToSegments } from '../../assets/js/shared/json-schema.js';
import { diffJson, toJsonPatch, toText, MARKERS } from '../../assets/js/shared/json-diff.js';
import { jsonToTypeScript } from '../../assets/js/shared/ts-interfaces.js';

const SAMPLE = { name: 'Developer Toolbox', version: 1.2, active: true, tags: ['json', 'xml', 'yaml'], owner: { name: 'Ada', email: 'ada@example.com' }, items: [{ id: 1, label: 'First, item', price: 9.5 }, { id: 2, label: 'Second "quoted"', price: null }] };
const WORKER_THRESHOLD = 1000000; // chars: parse + analysis in a Web Worker above this size
const WARN_SIZE = 10 * 1024 * 1024; // show a size warning above this
const LIST_LIMIT = 500;

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const debounce = ctx.debounce || uiDebounce;
    const input = q('input'), output = q('output'), msg = q('msg'), indentSel = q('indent'), sortCb = q('sort'), losslessCb = q('lossless'), escfCb = q('escf'), lossy = q('lossy'), sizewarn = q('sizewarn');
    indentSel.value = L.choiceFromUnit(ctx.indentUnit);
    // Shared editor on the two text panes (line numbers, JSON highlighting, Tab/Enter helpers, find & replace). Upload / Clear / Copy /
    // Download / drop stay with the tool's own buttons, so the editors only get the view tools.
    const edIn = createEditor(input, { language: 'json', storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false });
    const edOut = createEditor(output, { language: 'json', storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, readOnly: true, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const OUT_LANG = { json: 'json', xml: 'xml', yaml: 'yaml', csv: 'plain' };
    let result = { text: '', ext: 'json', mime: 'application/json', label: 'JSON' };
    let activeTab = 'text';
    const offs = [];

    // Restore last input (skipped when huge to respect storage limits).
    try { const saved = ctx.storage.get('input'); if (saved) input.value = saved; } catch { /* ignore */ }
    const save = () => { try { input.value.length < 500000 ? ctx.storage.set('input', input.value) : ctx.storage.remove('input'); } catch { /* ignore */ } };

    const updateSizeWarn = () => {
      const n = input.value.length;
      sizewarn.hidden = n <= WARN_SIZE;
      if (n > WARN_SIZE) sizewarn.textContent = `Input is ${formatBytes(n)} (over 10 MB). Parsing runs in a background worker, but the page may still be slow or run out of memory; consider splitting the file.`;
    };

    // ---------------------------------------------------------------- parsing (worker for big inputs)
    const busy = q('busy');
    let cancelWorker = null, cache = { text: null, res: null };
    const setBusy = (on, text) => { busy.hidden = !on; if (text) q('busytext').textContent = text; };
    function workerParse(text) {
      return new Promise((resolve, reject) => {
        let w;
        try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch { resolve(null); return; }
        const done = () => { setBusy(false); try { w.terminate(); } catch { /* ignore */ } cancelWorker = null; };
        cancelWorker = () => { done(); reject(Object.assign(new Error('Cancelled'), { cancelled: true })); };
        w.onmessage = e => { done(); resolve(e.data); };
        w.onerror = () => { done(); resolve(null); }; // worker could not start: fall back to the main thread
        w.onmessageerror = () => { done(); resolve(null); };
        setBusy(true, `Parsing ${formatBytes(text.length)} in a background thread...`);
        w.postMessage({ id: 1, text });
      });
    }
    /** Parse the input (cached per text). Resolves { ok, value | message,... , lossy? }. Rejects {cancelled} on Cancel. */
    async function parseInput() {
      const text = input.value;
      if (cache.text === text && cache.res) return cache.res;
      if (cancelWorker) cancelWorker();
      let res = null;
      if (text.length > WORKER_THRESHOLD && typeof Worker !== 'undefined') res = await workerParse(text);
      if (!res) res = L.parseJson(text);
      cache = { text, res };
      return res;
    }
    const lossyNote = (res, text) => {
      if (res.lossy !== undefined) return res.lossy;
      try { return L.describeLossiness(L.analyzeLossiness(text)); } catch { return ''; }
    };

    const setOutput = (text, ext, mime, label) => {
      result = { text, ext, mime, label };
      edOut.setLanguage(OUT_LANG[ext] || 'plain');
      output.value = text; q('fmt').textContent = label;
    };
    const showLossy = res => {
      const note = lossyNote(res, input.value);
      lossy.hidden = !note;
      lossy.textContent = note ? note + ' Tick "Lossless format" to keep them verbatim (Format/Minify only).' : '';
    };
    const fail = r => {
      lossy.hidden = true;
      showMessage(msg, 'error', r.message);
      if (r.snippet) msg.append(el('pre', { class: 'jf-snippet' }, r.snippet));
      if (r.offset != null) {
        input.focus(); input.setSelectionRange(r.offset, Math.min(r.offset + 1, input.value.length));
        // Programmatic selection does not always scroll a textarea: bring the error position into view.
        edIn.reveal(r.offset);
      }
    };
    /** Wrap a UI handler: any exception (RangeError, depth guard, cancel, ...) becomes a visible message. */
    const safe = fn => (...a) => {
      const onErr = e => {
        lossy.hidden = true;
        if (e && e.cancelled) return showMessage(msg, 'info', 'Cancelled.');
        showMessage(msg, 'error', e instanceof RangeError
          ? `Not enough stack for this document (${e.message}). It is probably nested too deeply; try Lossless Minify.` : (e && e.message) || String(e));
      };
      try { const r = fn(...a); if (r && typeof r.catch === 'function') r.catch(onErr); } catch (e) { onErr(e); }
    };
    /** Parse input and run a converter; errors are shown inline. */
    const run = async (fn, ext, mime, label, okMsg) => {
      const r = await parseInput();
      if (!r.ok) return fail(r);
      const v = sortCb.checked ? L.sortKeys(r.value) : r.value;
      setOutput(fn(v), ext, mime, label); showMessage(msg, 'success', okMsg); selectTab('text'); showLossy(r);
    };
    /** Lossless Format/Minify: re-indent the text itself, never through JSON.parse. */
    const runLossless = (minify, indent) => {
      if (!input.value.trim()) return showMessage(msg, 'error', 'Input is empty. Paste or upload some JSON.');
      let out;
      try { out = L.reformatLossless(input.value, { indent, minify }); }
      catch (e) { if (e.scanError) return fail(L.scanErrorResult(input.value, e.offset, e.message)); throw e; }
      setOutput(out, 'json', 'application/json', 'JSON');
      showMessage(msg, 'success', `${minify ? 'Minified' : 'Formatted'} losslessly (number literals and duplicate keys kept verbatim${sortCb.checked ? '; Sort keys ignored' : ''}).`);
      lossy.hidden = true; selectTab('text');
    };

    // ---------------------------------------------------------------- tree
    const treeHost = q('tree');
    const tree = createTree(treeHost, { el, copyText, toast });
    let treeKey = { text: null, sorted: false };
    async function ensureTree() {
      const text = input.value, sorted = sortCb.checked;
      if (treeKey.text === text && treeKey.sorted === sorted && tree.hasData()) return true;
      const r = await parseInput();
      if (!r.ok) {
        tree.setData(undefined); treeKey = { text: null, sorted };
        treeHost.append(el('div', { class: `alert ${text.trim() ? 'alert-error' : 'alert-info'}` }, r.message));
        return false;
      }
      tree.setData(sorted ? L.sortKeys(r.value) : r.value); treeKey = { text, sorted };
      return true;
    }
    const tsearch = q('tsearch'), tcount = q('tcount'), tmode = q('tmode');
    const showCount = r => {
      if (!tsearch.value) { tcount.textContent = ''; return; }
      tcount.textContent = r.count ? `${r.index + 1} / ${r.count}${r.truncated ? '+' : ''}` : 'No matches';
    };
    const doSearch = safe(async () => { if (await ensureTree()) showCount(tree.search(tsearch.value, tmode.value)); else tcount.textContent = ''; });
    const doSearchDebounced = debounce(doSearch, 250);
    tsearch.addEventListener('input', doSearchDebounced);
    tmode.addEventListener('change', () => doSearch());
    tsearch.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); doSearchDebounced.cancel?.();
      const hasData = tree.hasData();
      if (!hasData) return doSearch();
      if (!tsearch.value) return;
      showCount(tree.step(e.shiftKey ? -1 : 1));
    });
    /** Reveal a path (array of segments) in the tree, switching to the Tree tab. */
    const revealInTree = safe(async segs => {
      selectTab('tree');
      if (!(await ensureTree())) return;
      tree.reveal(segs);
    });

    const selectTab = initTabs(root, name => { activeTab = name; if (name === 'tree') safe(ensureTree)(); });

    // ---------------------------------------------------------------- list helper
    /** Fill a <ul> with rows. row = { marker?, kind?, title, detail?, onClick? }. */
    const fillList = (ul, rows, limit = LIST_LIMIT) => {
      ul.replaceChildren();
      for (const r of rows.slice(0, limit)) {
        const inner = [];
        if (r.marker) inner.push(el('span', { class: `jf-marker jf-${r.kind}`, 'aria-hidden': 'true' }, r.marker));
        if (r.kindText) inner.push(el('span', { class: `jf-kind jf-${r.kind}` }, r.kindText));
        inner.push(el('span', { class: 'jf-path' }, r.title));
        if (r.detail) inner.push(el('span', { class: 'jf-detail' }, r.detail));
        const li = el('li', { class: 'jf-row' });
        if (r.onClick) { const b = el('button', { class: 'jf-rowbtn', type: 'button' }, ...inner); b.addEventListener('click', r.onClick); li.append(b); }
        else li.append(el('div', { class: 'jf-rowbtn' }, ...inner));
        ul.append(li);
      }
      if (rows.length > limit) ul.append(el('li', { class: 'jf-row hint' }, `Showing the first ${limit} of ${rows.length}.`));
    };
    const preview = v => { let s; try { s = JSON.stringify(v); } catch { s = String(v); } if (s === undefined) s = String(v); return s.length > 120 ? s.slice(0, 117) + '...' : s; };
    const readJsonBox = (box, what) => {
      const r = L.parseJson(box.value);
      if (!r.ok) throw Object.assign(new Error(`${what}: ${r.message}`), { jsonError: true });
      return r.value;
    };

    // ---------------------------------------------------------------- query tab
    const qexpr = q('qexpr'), qmsg = q('qmsg'), qlist = q('qlist');
    let qresults = [];
    async function runQuery() {
      showMessage(qmsg, null); qlist.replaceChildren(); qresults = [];
      const res = await parseInput();
      if (!res.ok) return showMessage(qmsg, 'error', `Input is not valid JSON: ${res.message}`);
      let out;
      try { out = jpQuery(res.value, qexpr.value.trim()); }
      catch (e) {
        if (e instanceof JSONPathError) { showMessage(qmsg, 'error', `JSONPath error: ${e.message}`); qexpr.focus(); try { qexpr.setSelectionRange(e.position, Math.min(e.position + 1, qexpr.value.length)); } catch { /* ignore */ } return; }
        throw e;
      }
      qresults = out;
      const notes = [];
      if (out.truncated) notes.push('results capped (10,000)');
      if (out.depthLimited) notes.push('recursion depth limit reached');
      showMessage(qmsg, out.truncated || out.depthLimited ? 'warn' : out.length ? 'success' : 'info',
        `${out.length} result${out.length === 1 ? '' : 's'}${notes.length ? ' - ' + notes.join('; ') : ''}`);
      fillList(qlist, out.map(r => ({ title: r.path, detail: preview(r.value), onClick: () => revealInTree(r.segments) })));
    }
    qexpr.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); safe(runQuery)(); } });

    // ---------------------------------------------------------------- schema tab
    const schemaBox = q('schema'), smsg = q('smsg'), serrors = q('serrors'), snc = q('snotchecked');
    try { const s = ctx.storage.get('schema'); if (s) schemaBox.value = s; } catch { /* ignore */ }
    schemaBox.addEventListener('input', () => { try { schemaBox.value.length < 200000 ? ctx.storage.set('schema', schemaBox.value) : ctx.storage.remove('schema'); } catch { /* ignore */ } });
    const loadSchemaFile = async f => { try { schemaBox.value = await readFileAsText(f); schemaBox.dispatchEvent(new Event('input')); showMessage(smsg, 'info', `Loaded ${f.name}`); } catch (e) { showMessage(smsg, 'error', 'Could not read file: ' + e.message); } };
    offs.push(enableDrop(schemaBox, loadSchemaFile));
    async function runSchema() {
      showMessage(smsg, null); serrors.replaceChildren(); snc.hidden = true;
      const sc = L.parseJson(schemaBox.value);
      if (!sc.ok) return showMessage(smsg, 'error', `Schema is not valid JSON: ${sc.message}`);
      const res = await parseInput();
      if (!res.ok) return showMessage(smsg, 'error', `Input is not valid JSON: ${res.message}`);
      const out = validateSchema(sc.value, res.value);
      if (out.valid) showMessage(smsg, out.notChecked.length ? 'warn' : 'success', out.notChecked.length ? 'No errors found in the parts that were checked, but some schema keywords were NOT checked (see below).' : 'OK: the input is valid against the schema.');
      else showMessage(smsg, 'error', `${out.errors.length}${out.truncated ? '+' : ''} validation error${out.errors.length === 1 ? '' : 's'}. Click one to reveal it in the tree.`);
      fillList(serrors, out.errors.map(e => ({ title: e.path || '(root)', kindText: e.keyword, kind: 'changed', detail: e.message, onClick: () => revealInTree(pointerToSegments(e.path)) })));
      if (out.notChecked.length) {
        snc.hidden = false;
        snc.textContent = `Not checked (${out.notChecked.length}): ` + out.notChecked.slice(0, 20).map(n => `${n.keyword} at ${n.path} (${n.reason})`).join('; ') + (out.notChecked.length > 20 ? '; ...' : '');
      }
    }

    // ---------------------------------------------------------------- compare tab
    const ca = q('ca'), cb = q('cb'), cmsg = q('cmsg'), clist = q('clist'), cmode = q('cmode'), ckey = q('ckey'), cactions = q('cactions');
    let lastDiff = null;
    cmode.addEventListener('change', () => { ckey.hidden = cmode.value !== 'key'; });
    const NAMES = { added: 'added', removed: 'removed', changed: 'changed', 'type-changed': 'type changed' };
    function runCompare() {
      showMessage(cmsg, null); clist.replaceChildren(); cactions.hidden = true; lastDiff = null;
      const a = readJsonBox(ca, 'A'), b = readJsonBox(cb, 'B');
      const d = diffJson(a, b, { arrayMode: cmode.value, key: ckey.value.trim() || 'id' });
      lastDiff = d;
      const c = d.counts;
      if (d.equal) return showMessage(cmsg, 'success', 'A and B are identical (object key order is ignored).');
      showMessage(cmsg, d.truncated ? 'warn' : 'info', `${c.added} added, ${c.removed} removed, ${c.changed} changed, ${c['type-changed']} type changed${d.truncated ? ' (stopped at the change limit)' : ''}.`);
      cactions.hidden = false;
      fillList(clist, d.changes.map(ch => ({
        marker: MARKERS[ch.kind], kind: ch.kind, kindText: NAMES[ch.kind], title: ch.path || '(root)',
        detail: ch.kind === 'added' ? preview(ch.after) : ch.kind === 'removed' ? preview(ch.before) : `${preview(ch.before)} → ${preview(ch.after)}`,
      })), 1000);
    }

    // ---------------------------------------------------------------- TypeScript tab
    const tsout = q('tsout'), tsmsg = q('tsmsg'), tsroot = q('tsroot');
    async function runTs() {
      showMessage(tsmsg, null);
      const res = await parseInput();
      if (!res.ok) return showMessage(tsmsg, 'error', `Input is not valid JSON: ${res.message}`);
      tsout.value = jsonToTypeScript(res.value, {
        rootName: tsroot.value.trim() || 'Root', exportKeyword: q('tsexport').checked, readonly: q('tsreadonly').checked,
        optionalFromArrays: q('tsopt').checked, useInterface: q('tskind').value === 'interface',
      });
    }
    for (const n of ['tsroot', 'tskind', 'tsexport', 'tsreadonly', 'tsopt']) q(n).addEventListener('change', () => { if (tsout.value) safe(runTs)(); });

    // ---------------------------------------------------------------- generate tab
    const gtpl = q('gtpl'), gout = q('gout'), gmsg = q('gmsg');
    gtpl.value = JSON.stringify(G.SAMPLE_TEMPLATE, null, 2);
    let genResult = '';
    function runGenerate() {
      showMessage(gmsg, null);
      const seed = q('gseed').value.trim();
      let value;
      if (q('gsrc').value === 'schema') {
        const s = L.parseJson(schemaBox.value);
        if (!s.ok) return showMessage(gmsg, 'error', `Schema tab: ${s.message}`);
        value = G.generateFromSchema(s.value, { seed });
      } else {
        const t = L.parseJson(gtpl.value);
        if (!t.ok) return showMessage(gmsg, 'error', `Template: ${t.message}`);
        value = G.generateFromTemplate(t.value, { seed });
      }
      genResult = JSON.stringify(value, null, L.indentFrom(indentSel.value));
      gout.value = genResult;
      showMessage(gmsg, 'success', `Generated ${formatBytes(genResult.length)}${seed ? ` (seed "${seed}": repeatable)` : ' (random each time; set a seed to repeat)'}.`);
    }

    // ---------------------------------------------------------------- loading
    const afterInputChange = () => {
      updateSizeWarn();
      if (activeTab === 'tree') safe(ensureTree)();
    };
    input.addEventListener('input', () => { save(); updateSizeWarn(); });
    const treeRefresh = debounce(() => { if (activeTab === 'tree' && input.value.length < WORKER_THRESHOLD) safe(ensureTree)(); }, 500);
    input.addEventListener('input', treeRefresh);
    const loadText = (text, name) => { lossy.hidden = true; input.value = text; save(); showMessage(msg, 'info', `Loaded ${name}`); afterInputChange(); };
    const loadFile = async f => { try { loadText(await readFileAsText(f), f.name); } catch (e) { showMessage(msg, 'error', 'Could not read file: ' + e.message); } };

    const handlers = {
      format() { const ind = L.indentFrom(indentSel.value); if (losslessCb.checked) return runLossless(false, ind); return run(v => L.formatJson(v, ind), 'json', 'application/json', 'JSON', 'Formatted successfully.'); },
      minify() { if (losslessCb.checked) return runLossless(true); return run(L.minifyJson, 'json', 'application/json', 'JSON', 'Minified successfully.'); },
      async validate() {
        const r = await parseInput();
        if (!r.ok) return fail(r);
        const s = r.stats || L.stats(r.value);
        showMessage(msg, 'success', `Valid JSON — root is ${L.typeOf(r.value)}, ${s.nodes} values, depth ${s.depth}.`);
        showLossy(r);
      },
      xml() { return run(v => L.toXml(v, { indent: L.indentFrom(indentSel.value) }), 'xml', 'application/xml', 'XML', 'Converted to XML.'); },
      async csv() {
        const warnings = [];
        await run(v => L.toCsv(v, { escapeFormulas: escfCb.checked, warnings }), 'csv', 'text/csv;charset=utf-8', 'CSV', 'Converted to CSV (nested keys flattened with dots; a dot inside a key is written as \\.).');
        if (warnings.length) showMessage(msg, 'warn', warnings.join(' '));
      },
      yaml() { const i = L.indentFrom(indentSel.value); return run(v => L.toYaml(v, typeof i === 'number' ? i : 2), 'yaml', 'text/yaml', 'YAML', 'Converted to YAML.'); },
      copy() { copyText(result.text, `${result.label} copied`); },
      download() { downloadFile(`output.${result.ext}`, result.text, result.mime); },
      use() {
        if (!result.text) return toast('No output yet', 'warn');
        if (result.ext !== 'json') return toast('Only JSON output can be used as input', 'warn');
        input.value = result.text; save(); afterInputChange();
      },
      sample() { input.value = JSON.stringify(SAMPLE, null, L.indentFrom(indentSel.value)); save(); showMessage(msg, null); lossy.hidden = true; afterInputChange(); },
      clear() { input.value = ''; setOutput('', 'json', 'application/json', 'JSON'); tree.setData(undefined); treeKey = { text: null, sorted: false }; showMessage(msg, null); lossy.hidden = true; save(); updateSizeWarn(); input.focus(); },
      async upload() { const f = await pickFile('.json,application/json,.txt'); if (f) loadFile(f); },
      cancel() { if (cancelWorker) cancelWorker(); },
      // tree
      async expand() {
        if (!(await ensureTree())) return;
        const r = await tree.expandAll();
        if (r.limited) toast(`Very large document: expanded the first ${r.nodes} nodes only (long lists show 200 items at a time)`, 'warn');
      },
      collapse() { tree.collapseAll(); },
      tprev() { if (tree.hasData() && tsearch.value) showCount(tree.step(-1)); },
      tnext() { if (tree.hasData() && tsearch.value) showCount(tree.step(1)); },
      // query
      qrun: runQuery,
      qcopy() {
        if (!qresults.length) return toast('Run a query first', 'warn');
        copyText(JSON.stringify(qresults.map(r => ({ path: r.path, value: r.value })), null, 2), 'Results copied');
      },
      // schema
      svalidate: runSchema,
      async supload() { const f = await pickFile('.json,application/json,.txt'); if (f) loadSchemaFile(f); },
      ssample() { schemaBox.value = JSON.stringify(G.SAMPLE_SCHEMA, null, 2); schemaBox.dispatchEvent(new Event('input')); },
      // compare
      crun() { try { runCompare(); } catch (e) { if (e.jsonError) showMessage(cmsg, 'error', e.message); else throw e; } },
      cusea() { ca.value = input.value; },
      cuseb() { cb.value = input.value; },
      cpatch() { if (lastDiff) copyText(JSON.stringify(toJsonPatch(lastDiff.changes), null, 2), 'JSON Patch copied'); },
      ctext() { if (lastDiff) copyText(toText(lastDiff.changes), 'Diff copied'); },
      // typescript
      tsgen: runTs,
      tscopy() { if (!tsout.value) return toast('Generate first', 'warn'); copyText(tsout.value, 'TypeScript copied'); },
      tsdl() { if (!tsout.value) return toast('Generate first', 'warn'); downloadFile(`${(tsroot.value.trim() || 'Root').replace(/[^\w.-]/g, '_')}.d.ts`, tsout.value, 'text/plain;charset=utf-8'); },
      // generate
      ggen: runGenerate,
      gcopy() { if (!genResult) return toast('Generate first', 'warn'); copyText(genResult, 'Generated JSON copied'); },
      guse() { if (!genResult) return toast('Generate first', 'warn'); input.value = genResult; save(); afterInputChange(); toast('Generated JSON is now the input'); },
      gdl() { if (!genResult) return toast('Generate first', 'warn'); downloadFile('generated.json', genResult, 'application/json'); },
    };
    bindActions(root, Object.fromEntries(Object.entries(handlers).map(([k, fn]) => [k, safe(fn)])));

    offs.push(enableDrop(q('inpanel'), loadFile));
    updateSizeWarn();
    return () => {
      offs.forEach(f => f());
      edIn.destroy(); edOut.destroy();
      if (cancelWorker) { try { cancelWorker(); } catch { /* ignore */ } }
      tree.destroy();
    };
  },
};
