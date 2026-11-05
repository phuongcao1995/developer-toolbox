import { el, copyText, downloadFile, toast, showMessage, initTabs, bindActions, renderIcons, readFileAsText } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const sig = ctx.signal ? { signal: ctx.signal } : {};
    const enc = new TextEncoder();

    // ---------------------------------------------------------------- options
    const algoBoxes = [...root.querySelectorAll('#fh-algos input')];
    const fmtSel = $('fh-format'), hmacBox = $('fh-hmac'), keyKind = $('fh-key-kind'), keyInput = $('fh-key'), expectedIn = $('fh-expected');
    const msgBox = $('fh-msg');
    const saved = ctx.storage.get('opts', null);
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.algos)) algoBoxes.forEach(b => { b.checked = saved.algos.includes(b.value); });
      if (['hex', 'HEX', 'base64'].includes(saved.format)) fmtSel.value = saved.format;
      if (saved.keyKind === 'hex') keyKind.value = 'hex';
      hmacBox.checked = !!saved.hmac;
    }
    $('fh-hmac-fields').hidden = !hmacBox.checked;
    const persist = () => ctx.storage.set('opts', { algos: selectedAlgos(), format: fmtSel.value, hmac: hmacBox.checked, keyKind: keyKind.value });
    const selectedAlgos = () => algoBoxes.filter(b => b.checked).map(b => b.value);

    let expected = null; // parseExpectedHash result or null
    const parseExpected = () => { expected = expectedIn.value.trim() ? L.parseExpectedHash(expectedIn.value) : null; };
    /** Algorithms to compute: the ticked ones plus the one detected from the expected hash (auto-ticked). */
    const algosToRun = () => {
      if (expected?.algos?.length === 1) { const b = algoBoxes.find(x => x.value === expected.algos[0]); if (b && !b.checked) { b.checked = true; persist(); } }
      return L.ALGOS.filter(a => selectedAlgos().includes(a));
    };
    /** Returns { key } (Uint8Array|null) or { error }. */
    const readKey = () => {
      if (!hmacBox.checked) return { key: null };
      try { return { key: L.parseKey(keyInput.value, keyKind.value) }; } catch (e) { return { error: e.message }; }
    };

    // ---------------------------------------------------------------- worker / in-thread runner
    let worker = null, workerFailed = typeof Worker === 'undefined', cur = null, cancelFlag = false, jobSeq = 0;
    const getWorker = () => {
      if (workerFailed) return null;
      if (worker) return worker;
      try {
        const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        w.onmessage = e => {
          const m = e.data; if (!cur || m.id !== cur.id) return;
          if (m.type === 'progress') cur.onProgress(m.done, m.total);
          else if (m.type === 'done') { const c = cur; cur = null; c.resolve({ digests: m.digests, method: m.method, ms: m.ms }); }
          else if (m.type === 'error') { const c = cur; cur = null; c.reject(m.cancelled ? Object.assign(new Error('Cancelled'), { name: 'AbortError' }) : new Error(m.message)); }
        };
        w.onerror = ev => { // worker could not start (blocked module worker, file:// ...) -> run in this thread instead
          ev.preventDefault?.();
          workerFailed = true; try { w.terminate(); } catch { /* ignore */ } worker = null;
          const c = cur; cur = null; if (c) c.fallback();
        };
        worker = w; return w;
      } catch { workerFailed = true; return null; }
    };
    const inThread = (file, algos, key, onProgress) => {
      const t0 = performance.now();
      return L.hashBlob(file, { algos, key, onProgress, isCancelled: () => cancelFlag }).then(r => ({ ...r, ms: performance.now() - t0 }));
    };
    /** Hash one File. Resolves { digests, method, ms }; rejects with AbortError on cancel. */
    const runHash = (file, algos, key, onProgress) => new Promise((resolve, reject) => {
      if (cancelFlag) return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      const w = getWorker();
      const fallback = () => inThread(file, algos, key, onProgress).then(resolve, reject);
      if (!w) return fallback();
      const id = ++jobSeq;
      cur = { id, onProgress, resolve, reject, fallback };
      try { w.postMessage({ type: 'hash', id, file, algos, key }); } catch { cur = null; workerFailed = true; fallback(); }
    });
    const cancelAll = () => {
      cancelFlag = true; queue.length = 0;
      if (worker) { worker.terminate(); worker = null; }
      if (cur) { const c = cur; cur = null; c.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); }
    };
    ctx.onCleanup?.(() => { cancelAll(); });

    // ---------------------------------------------------------------- progress UI
    const progBox = $('fh-progress'), bar = $('fh-bar'), progLabel = $('fh-progress-label');
    const showProgress = (label, pct) => { progBox.hidden = false; bar.value = pct; progLabel.textContent = label; };
    const hideProgress = () => { progBox.hidden = true; };
    const progressReporter = (prefix, size) => {
      const t0 = performance.now();
      return (done, total) => {
        const pct = total ? Math.min(100, done / total * 100) : 100;
        const tp = L.formatThroughput(done, performance.now() - t0);
        showProgress(`${prefix} ${pct.toFixed(0)}% (${L.sizeLabel(done)} of ${L.sizeLabel(total || size)})${tp && done ? ` – ${tp}` : ''}`, pct);
      };
    };

    // ---------------------------------------------------------------- result rendering
    const fmt = () => fmtSel.value;
    const rowStatus = (algo, digest) => {
      if (!expected?.hex || !expected.algos?.includes(algo)) return null;
      return L.constantTimeEqual(L.toHex(digest), expected.hex);
    };
    function buildRows(item, algos) {
      const dl = el('div', { class: 'fh-rows' });
      for (const algo of algos) {
        const d = item.digests?.[algo]; if (!d) continue;
        const text = L.formatDigest(d, fmt());
        const st = rowStatus(algo, d);
        const status = st == null ? null : el('span', { class: `badge ${st ? 'badge-success' : 'badge-danger'} fh-status`, role: 'status' }, st ? '✓ Match' : '✗ Does not match');
        dl.append(el('div', { class: 'fh-row' },
          el('span', { class: 'fh-algo' }, ctx_hmacLabel(algo)),
          el('code', { class: 'fh-hash', tabindex: '0', 'aria-label': `${algo} of ${item.name}` }, text),
          status,
          el('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Copy ${algo} of ${item.name}`, onclick: () => copyText(text, `${algo} copied`) }, 'Copy')));
      }
      return dl;
    }
    const ctx_hmacLabel = algo => (lastHmac ? `HMAC-${algo}` : algo);
    let lastHmac = false; // whether the displayed results were computed with a key

    // ---------------------------------------------------------------- TEXT tab
    const textIn = $('fh-text'), textOut = $('fh-text-results'), textInfo = $('fh-text-info');
    let textItem = null, textToken = 0;
    async function computeText() {
      const token = ++textToken;
      showMessage(msgBox, null);
      const algos = algosToRun();
      if (!algos.length) { textItem = null; renderText(); showMessage(msgBox, 'warn', 'Select at least one algorithm.'); return; }
      const k = readKey(); if (k.error) { textItem = null; renderText(); showMessage(msgBox, 'error', `HMAC key: ${k.error}`); return; }
      const bytes = enc.encode(textIn.value);
      if (bytes.length > L.TEXT_MAX_BYTES) { textItem = null; renderText(); showMessage(msgBox, 'error', `Text is ${L.sizeLabel(bytes.length)}; the text box is limited to ${L.sizeLabel(L.TEXT_MAX_BYTES)}. Use the Files tab for large inputs.`); return; }
      try {
        const digests = await L.hashBytes(bytes, algos, k.key);
        if (token !== textToken) return;
        lastHmac = !!k.key;
        textItem = { name: 'Text input', size: bytes.length, digests, algos };
      } catch (e) { if (token === textToken) { textItem = null; showMessage(msgBox, 'error', `Hashing failed: ${e.message}`); } }
      renderText();
    }
    const computeTextDebounced = ctx.debounce(computeText, 200);
    function renderText() {
      textOut.replaceChildren();
      const n = enc.encode(textIn.value).length;
      textInfo.textContent = textIn.value ? `${n.toLocaleString()} bytes (UTF-8), ${[...textIn.value].length.toLocaleString()} characters` : 'Empty input – the hashes below are those of the empty string.';
      if (textItem) textOut.append(buildRows(textItem, textItem.algos));
      updateExpectedInfo(); refreshExport();
    }

    // ---------------------------------------------------------------- FILES tab
    const files = []; let fileSeq = 0; const queue = []; let running = false;
    const fileOut = $('fh-file-results'), filesInfo = $('fh-files-info');
    const tab = () => root.querySelector('[data-tab].active')?.dataset.tab;

    function addFiles(list, target) {
      const arr = [...list]; if (!arr.length) return;
      showMessage(msgBox, null);
      const add = target === 'verify' ? vfiles : files;
      for (const f of arr) add.push({ id: ++fileSeq, file: f, name: f.name, size: f.size, status: 'idle', digests: null });
      if (target === 'verify') { renderVerifyFiles(); return; }
      const k = readKey();
      if (k.error) { showMessage(msgBox, 'error', `HMAC key: ${k.error}`); renderFiles(); return; }
      const algos = algosToRun(); if (!algos.length) { showMessage(msgBox, 'warn', 'Select at least one algorithm, then press Hash files.'); renderFiles(); return; }
      enqueue(files.filter(f => f.status === 'idle'), algos, k.key);
    }
    function enqueue(items, algos, key) {
      cancelFlag = false;
      for (const it of items) { it.status = 'queued'; it.digests = null; it.msg = ''; queue.push({ it, algos, key, hmac: !!key }); }
      renderFiles(); runQueue();
    }
    async function runQueue() {
      if (running) return; running = true; cancelFlag = false;
      let doneCount = 0;
      try {
        while (queue.length) {
          const job = queue.shift(), it = job.it;
          if (!files.includes(it)) continue;
          it.status = 'hashing'; renderFiles();
          const prefix = `${it.name}${queue.length || doneCount ? ` (file ${doneCount + 1} of ${doneCount + 1 + queue.length})` : ''}:`;
          showProgress(`${prefix} starting…`, 0);
          try {
            const r = await runHash(it.file, job.algos, job.key, progressReporter(prefix, it.size));
            it.status = 'done'; it.digests = r.digests; it.ms = r.ms; it.method = r.method; it.algos = job.algos; it.hmac = job.hmac;
            lastHmac = job.hmac;
          } catch (e) {
            if (e?.name === 'AbortError') { it.status = 'cancelled'; it.msg = 'Cancelled.'; }
            else { it.status = 'error'; it.msg = e?.name === 'NotReadableError' ? 'Could not read this file (it may have been moved, deleted or is locked).' : `Hashing failed: ${e?.message || e}`; }
          }
          doneCount++; renderFiles();
        }
      } finally {
        running = false; hideProgress();
        for (const it of files) if (it.status === 'queued') { it.status = 'cancelled'; it.msg = 'Cancelled.'; }
        renderFiles();
        const done = files.filter(f => f.status === 'done').length;
        if (done) showMessage(msgBox, 'success', `Hashed ${done} file${done > 1 ? 's' : ''}.`);
      }
    }
    function renderFiles() {
      fileOut.replaceChildren();
      const total = files.reduce((s, f) => s + f.size, 0);
      filesInfo.textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''}, ${L.sizeLabel(total)} total` : 'No files selected.';
      for (const it of files) {
        const head = el('div', { class: 'fh-card-head' },
          el('strong', { class: 'fh-name' }, it.name),
          el('span', { class: 'badge' }, L.sizeLabel(it.size)),
          it.status === 'done' ? el('span', { class: 'badge badge-info' }, `${L.formatDuration(it.ms)} · ${L.formatThroughput(it.size, it.ms) || '–'} · ${it.method === 'incremental' ? 'pure JS, streamed' : 'WebCrypto'}`) : null,
          it.status === 'queued' ? el('span', { class: 'badge' }, 'Queued') : null,
          it.status === 'hashing' ? el('span', { class: 'badge badge-info' }, 'Hashing…') : null,
          el('button', { class: 'btn btn-sm btn-ghost fh-remove', type: 'button', 'aria-label': `Remove ${it.name}`, disabled: it.status === 'hashing' ? '' : null,
            onclick: () => { const i = files.indexOf(it); if (i >= 0) files.splice(i, 1); const q = queue.findIndex(j => j.it === it); if (q >= 0) queue.splice(q, 1); renderFiles(); } }, 'Remove'));
        const card = el('div', { class: 'panel fh-card' }, head);
        const body = el('div', { class: 'panel-body' });
        if (it.status === 'done') { const prev = lastHmac; lastHmac = !!it.hmac; body.append(buildRows(it, it.algos)); lastHmac = prev; }
        else if (it.msg) body.append(el('p', { class: it.status === 'error' ? 'fh-err' : 'hint' }, it.msg));
        else body.append(el('p', { class: 'hint' }, it.status === 'idle' ? 'Press “Hash files”.' : 'Waiting…'));
        card.append(body); fileOut.append(card);
      }
      updateIdentical(); updateExpectedInfo(); refreshExport();
    }
    function updateIdentical() {
      const box = $('fh-identical'), done = files.filter(f => f.status === 'done');
      if (done.length < 2) { box.hidden = true; return; }
      const algo = [...L.ALGOS].reverse().find(a => done.every(f => f.digests[a]));
      if (!algo) { box.hidden = true; return; }
      const groups = L.groupIdentical(done, algo), dups = groups.filter(g => g.names.length > 1);
      let type, text;
      if (groups.length === 1) { type = 'success'; text = `✓ All ${done.length} files are identical (same ${algo}).`; }
      else if (!dups.length) { type = 'warn'; text = `✗ All ${done.length} files differ (compared by ${algo}).`; }
      else { type = 'info'; text = `Identical by ${algo}: ${dups.map(g => g.names.join(' = ')).join('; ')}. ${groups.length} distinct hashes in total.`; }
      box.hidden = false; box.className = `alert alert-${type} fh-gap`; box.textContent = text;
    }

    // ---------------------------------------------------------------- expected-hash summary
    function updateExpectedInfo() {
      const info = $('fh-expected-info');
      if (!expected) { info.textContent = ''; info.className = 'hint'; return; }
      if (expected.error) { info.textContent = expected.error; info.className = 'hint fh-err'; return; }
      let t = `Detected ${expected.algos.join(' or ')} (${expected.format}).`;
      const items = tab() === 'files' ? files.filter(f => f.status === 'done') : tab() === 'text' && textItem ? [textItem] : [];
      if (items.length) {
        const hits = items.filter(it => expected.algos.some(a => it.digests?.[a] && L.constantTimeEqual(L.toHex(it.digests[a]), expected.hex)));
        const comparable = items.filter(it => expected.algos.some(a => it.digests?.[a]));
        if (!comparable.length) t += ' Select that algorithm and hash again to compare.';
        else if (hits.length) t += ` ✓ MATCH: ${hits.map(h => h.name).join(', ')}.`;
        else t += ' ✗ MISMATCH: none of the results equal the expected hash.';
        info.className = 'hint ' + (hits.length ? 'fh-ok' : comparable.length ? 'fh-err' : '');
      } else { t += ' It will be compared with the results.'; info.className = 'hint'; }
      info.textContent = t;
    }

    // ---------------------------------------------------------------- export
    const sumSel = $('fh-sum-algo');
    const exportItems = () => tab() === 'files' ? files.filter(f => f.status === 'done') : tab() === 'text' && textItem ? [textItem] : [];
    const exportAlgos = items => L.ALGOS.filter(a => items.some(i => i.digests?.[a]));
    function refreshExport() {
      const items = exportItems(), algos = exportAlgos(items);
      $('fh-export').hidden = !items.length || tab() === 'verify';
      const prev = sumSel.value;
      sumSel.replaceChildren(...algos.map(a => el('option', { value: a }, a)));
      sumSel.value = algos.includes(prev) ? prev : (algos.includes('SHA-256') ? 'SHA-256' : algos[0] || '');
    }
    function exportData() {
      const items = exportItems(); if (!items.length) { toast('Nothing to export yet', 'warn'); return null; }
      return { items, algos: exportAlgos(items) };
    }
    const hmacExtra = () => ({ hmac: lastHmac });

    // ---------------------------------------------------------------- VERIFY tab
    const vfiles = [];
    const vSummary = $('fh-v-summary'), vOut = $('fh-v-results');
    function renderVerifyFiles() {
      const t = $('fh-v-files-info');
      t.textContent = vfiles.length ? `${vfiles.length} file${vfiles.length > 1 ? 's' : ''} selected (${L.sizeLabel(vfiles.reduce((s, f) => s + f.size, 0))}): ${vfiles.slice(0, 6).map(f => f.name).join(', ')}${vfiles.length > 6 ? '…' : ''}` : 'No files selected. Files are matched by name (directory parts are ignored).';
    }
    async function runVerify() {
      showMessage(msgBox, null); vSummary.hidden = true; vOut.replaceChildren();
      if (running) return showMessage(msgBox, 'warn', 'Another hashing job is still running. Wait for it to finish or press Cancel.');
      const parsed = L.parseChecksumFile($('fh-v-text').value);
      if (!parsed.entries.length) return showMessage(msgBox, 'error', parsed.errors.length ? `No valid checksum lines found (${parsed.errors.length} line(s) not understood, first: line ${parsed.errors[0].line}).` : 'Paste the contents of a checksum file first (lines like "hash  filename").');
      if (!vfiles.length) return showMessage(msgBox, 'error', 'Choose or drop the files you want to verify.');
      const names = vfiles.map(f => f.name);
      const byFile = new Map();
      parsed.entries.forEach(e => { const i = L.matchFileName(e.name, names); e.fileIdx = i; if (i >= 0) (byFile.get(i) || byFile.set(i, []).get(i)).push(e); });
      running = true; cancelFlag = false; const actual = new Map(); let n = 0, failedRead = null;
      try {
        for (const [i, ents] of byFile) {
          const algos = [...new Set(ents.map(e => e.algos[0]))]; n++;
          const prefix = `${vfiles[i].name} (${n} of ${byFile.size}):`;
          try { actual.set(i, (await runHash(vfiles[i].file, algos, null, progressReporter(prefix, vfiles[i].size))).digests); }
          catch (e) { if (e?.name === 'AbortError') throw e; (failedRead ||= []).push(`${vfiles[i].name}: ${e?.message || e}`); }
        }
      } catch (e) { running = false; hideProgress(); return showMessage(msgBox, 'warn', 'Verification cancelled.'); }
      running = false; hideProgress();
      let ok = 0, bad = 0, missing = 0;
      const table = el('table', { class: 'fh-table' },
        el('thead', {}, el('tr', {}, ['Result', 'File', 'Algorithm', 'Details'].map(h => el('th', { scope: 'col' }, h)))));
      const tb = el('tbody');
      for (const e of parsed.entries) {
        let badge, detail = '';
        if (e.fileIdx < 0) { missing++; badge = el('span', { class: 'badge badge-warn' }, '? Missing'); detail = 'No selected file has this name.'; }
        else {
          const d = actual.get(e.fileIdx)?.[e.algos[0]];
          if (!d) { bad++; badge = el('span', { class: 'badge badge-danger' }, '✗ Unreadable'); detail = 'The file could not be read.'; }
          else if (L.constantTimeEqual(L.toHex(d), e.hash)) { ok++; badge = el('span', { class: 'badge badge-success' }, '✓ OK'); detail = 'Hash matches.'; }
          else { bad++; badge = el('span', { class: 'badge badge-danger' }, '✗ FAILED'); detail = `Expected ${e.hash}, got ${L.toHex(d)}.`; }
        }
        tb.append(el('tr', {}, el('td', {}, badge), el('td', { class: 'fh-cell-name' }, e.name), el('td', {}, e.algos[0]), el('td', { class: 'fh-cell-detail' }, detail)));
      }
      table.append(tb); vOut.append(el('div', { class: 'fh-table-wrap' }, table));
      const listed = new Set(parsed.entries.map(e => e.fileIdx));
      const unlisted = vfiles.filter((_, i) => !listed.has(i)).map(f => f.name);
      if (unlisted.length) vOut.append(el('p', { class: 'hint fh-gap' }, `Selected files not listed in the checksum file: ${unlisted.join(', ')}`));
      if (parsed.errors.length) vOut.append(el('p', { class: 'hint' }, `Ignored ${parsed.errors.length} line(s) that are not valid checksum lines (e.g. line ${parsed.errors[0].line}).`));
      if (failedRead) vOut.append(el('p', { class: 'fh-err' }, failedRead.join('; ')));
      const type = bad ? 'error' : missing ? 'warn' : 'success';
      const summary = `${ok} OK, ${bad} failed, ${missing} missing of ${parsed.entries.length} listed file${parsed.entries.length > 1 ? 's' : ''}.`;
      vSummary.hidden = false; vSummary.className = `alert alert-${type} fh-gap`; vSummary.textContent = `${bad ? '✗ ' : missing ? '! ' : '✓ '}${summary}`;
      runQueue();
    }

    // ---------------------------------------------------------------- picking / dropping
    const pickFiles = (target) => {
      const input = el('input', { type: 'file', multiple: '' });
      input.addEventListener('change', () => { addFiles(input.files, target); });
      input.click();
    };
    const wireDrop = (zone, target) => {
      const on = e => { e.preventDefault(); zone.classList.add('dragover'); };
      const off = () => zone.classList.remove('dragover');
      zone.addEventListener('dragover', on, sig); zone.addEventListener('dragleave', off, sig);
      zone.addEventListener('drop', e => {
        e.preventDefault(); off();
        const fl = [...(e.dataTransfer?.files || [])];
        if (!fl.length) return;
        // Directories show up as zero-size entries with no type; hashing them would fail with a confusing error.
        addFiles(fl, target);
      }, sig);
    };
    wireDrop($('fh-drop'), 'files'); wireDrop($('fh-v-drop'), 'verify');

    // ---------------------------------------------------------------- events
    textIn.addEventListener('input', computeTextDebounced, sig);
    const optionsChanged = () => {
      persist(); parseExpected(); lastHmac = hmacBox.checked;
      if (tab() === 'text') computeText(); else { renderFiles(); if (files.some(f => f.status === 'done')) showMessage(msgBox, 'info', 'Options changed. Press “Hash files” to recompute with the new algorithms/key; the output format updates immediately.'); }
    };
    algoBoxes.forEach(b => b.addEventListener('change', optionsChanged, sig));
    fmtSel.addEventListener('change', () => { persist(); renderText(); renderFiles(); }, sig);
    hmacBox.addEventListener('change', () => { $('fh-hmac-fields').hidden = !hmacBox.checked; optionsChanged(); }, sig);
    keyKind.addEventListener('change', optionsChanged, sig);
    keyInput.addEventListener('input', () => { if (tab() === 'text') computeTextDebounced(); }, sig);
    $('fh-key-show').addEventListener('change', e => { keyInput.type = e.target.checked ? 'text' : 'password'; }, sig);
    expectedIn.addEventListener('input', () => { parseExpected(); if (expected?.algos?.length === 1 && tab() === 'text') computeTextDebounced(); renderText(); renderFiles(); }, sig);

    const select = initTabs(root, name => { showMessage(msgBox, null); updateExpectedInfo(); refreshExport(); if (name === 'text') computeText(); });

    bindActions(root, {
      'expected-clear': () => { expectedIn.value = ''; parseExpected(); renderText(); renderFiles(); expectedIn.focus(); },
      'cancel': () => { cancelAll(); toast('Cancelled', 'info'); },
      'files-pick': () => pickFiles('files'),
      'files-hash': () => {
        showMessage(msgBox, null);
        if (!files.length) return showMessage(msgBox, 'error', 'Choose or drop at least one file first.');
        const k = readKey(); if (k.error) return showMessage(msgBox, 'error', `HMAC key: ${k.error}`);
        const algos = algosToRun(); if (!algos.length) return showMessage(msgBox, 'warn', 'Select at least one algorithm.');
        if (running) return showMessage(msgBox, 'warn', 'Hashing is already running.');
        enqueue(files.filter(f => f.status !== 'hashing'), algos, k.key);
      },
      'files-clear': () => { cancelAll(); files.length = 0; renderFiles(); showMessage(msgBox, null); },
      'v-pick': () => pickFiles('verify'),
      'v-clear-files': () => { vfiles.length = 0; renderVerifyFiles(); vOut.replaceChildren(); vSummary.hidden = true; },
      'v-clear-text': () => { $('fh-v-text').value = ''; vOut.replaceChildren(); vSummary.hidden = true; },
      'v-load': async () => {
        const input = el('input', { type: 'file', accept: '.txt,.md5,.sha1,.sha256,.sha384,.sha512,.sum,.sums,.checksum,text/plain,*/*' });
        input.addEventListener('change', async () => {
          const f = input.files[0]; if (!f) return;
          if (f.size > 5 * 1048576) return showMessage(msgBox, 'error', `That file is ${L.sizeLabel(f.size)}; checksum files are small text files (limit 5 MB).`);
          try { $('fh-v-text').value = await readFileAsText(f); showMessage(msgBox, 'success', `Loaded ${f.name}.`); } catch { showMessage(msgBox, 'error', 'Could not read that file as text.'); }
        });
        input.click();
      },
      'v-run': runVerify,
      'copy-text': () => { const d = exportData(); if (d) copyText(L.resultsToText(d.items, d.algos, fmt()), 'Results copied'); },
      'copy-json': () => { const d = exportData(); if (d) copyText(L.resultsToJson(d.items, d.algos, fmt(), hmacExtra()), 'JSON copied'); },
      'dl-json': () => { const d = exportData(); if (d) downloadFile('hashes.json', L.resultsToJson(d.items, d.algos, fmt(), hmacExtra()), 'application/json'); },
      'dl-sum': () => {
        const d = exportData(); if (!d) return;
        const algo = sumSel.value; if (!algo) return;
        const rows = d.items.filter(i => i.digests?.[algo]).map(i => ({ hex: L.toHex(i.digests[algo]), name: i.name === 'Text input' && tab() === 'text' ? '-' : i.name }));
        if (!rows.length) return toast(`No ${algo} results to export`, 'warn');
        downloadFile(`checksums.${L.checksumExtension(algo)}`, L.formatChecksumFile(rows), 'text/plain;charset=utf-8');
      },
    });

    parseExpected(); renderFiles(); renderVerifyFiles(); computeText();
    renderIcons(root);
    return () => { cancelAll(); };
  },
};
