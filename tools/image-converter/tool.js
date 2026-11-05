import { el, toast, downloadFile, showMessage, bindActions, renderIcons } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import { convertSource, UserError } from './render.js';

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const sig = ctx.signal ? { signal: ctx.signal } : {};
    const msgBox = $('ic-msg'), list = $('ic-list');
    let disposed = false;

    // ---------------------------------------------------------------- format support detection
    const supported = { png: true, jpeg: true, webp: false, avif: false };
    const formatSel = $('ic-format');
    const buildFormatSelect = () => {
      const prev = formatSel.value;
      formatSel.replaceChildren(el('option', { value: 'same' }, 'Same as input (compress only)'),
        ...Object.entries(L.FORMATS).filter(([k]) => supported[k]).map(([k, f]) => el('option', { value: k }, f.label)));
      formatSel.value = [...formatSel.options].some(o => o.value === prev) ? prev : 'same';
      refreshControls();
    };
    const probe = mime => new Promise(res => {
      try { const c = document.createElement('canvas'); c.width = c.height = 1; c.toBlob(b => res(!!b && b.type === mime), mime, 0.8); } catch { res(false); }
    });
    Promise.all([probe('image/webp'), probe('image/avif')]).then(([w, a]) => {
      supported.webp = w; supported.avif = a;
      const keep = formatSel.value; buildFormatSelect();
      if ([...formatSel.options].some(o => o.value === keep)) formatSel.value = keep;
      refreshControls();
    });

    // ---------------------------------------------------------------- options
    const saved = ctx.storage.get('opts', null) || {};
    const setIf = (id, v) => { if (v !== undefined && v !== null) { const n = $(id); if (n.type === 'checkbox') n.checked = !!v; else n.value = v; } };
    ['ic-quality', 'ic-resize', 'ic-percent', 'ic-width', 'ic-height', 'ic-fit', 'ic-template'].forEach(id => setIf(id, saved[id]));
    if (typeof saved['ic-noup'] === 'boolean') $('ic-noup').checked = saved['ic-noup'];
    if (typeof saved['ic-flatten'] === 'boolean') $('ic-flatten').checked = saved['ic-flatten'];
    if (/^#[0-9a-f]{6}$/i.test(saved['ic-bg'] || '')) $('ic-bg').value = saved['ic-bg'];
    buildFormatSelect();
    if (typeof saved.format === 'string' && [...formatSel.options].some(o => o.value === saved.format)) formatSel.value = saved.format;
    const persist = () => {
      const o = { format: formatSel.value };
      ['ic-quality', 'ic-resize', 'ic-percent', 'ic-width', 'ic-height', 'ic-fit', 'ic-template', 'ic-bg'].forEach(id => { o[id] = $(id).value; });
      o['ic-noup'] = $('ic-noup').checked; o['ic-flatten'] = $('ic-flatten').checked;
      ctx.storage.set('opts', o);
    };
    function refreshControls() {
      const mode = $('ic-resize').value;
      root.querySelectorAll('[data-for]').forEach(n => { n.hidden = !n.dataset.for.split(' ').includes(mode); });
      $('ic-width-label').textContent = mode === 'max' ? 'Max dimension (px)' : 'Width (px)';
      const fmt = formatSel.value, lossy = fmt === 'same' || L.FORMATS[fmt]?.lossy;
      $('ic-quality').disabled = !lossy;
      $('ic-quality-out').textContent = $('ic-quality').value + (lossy ? '' : ' (PNG is lossless)');
    }
    const readOpts = () => ({
      format: formatSel.value, quality: L.clampQuality($('ic-quality').value), flatten: $('ic-flatten').checked, bg: $('ic-bg').value, template: $('ic-template').value,
      resize: { mode: $('ic-resize').value, percent: $('ic-percent').value, width: $('ic-width').value, height: $('ic-height').value, fit: $('ic-fit').value, noUpscale: $('ic-noup').checked },
    });
    let dirty = false;
    const onOpt = () => {
      refreshControls(); persist();
      if (items.some(i => i.status === 'done')) { dirty = true; showMessage(msgBox, 'info', 'Settings changed. Press “Convert” to apply them to the images below.'); }
    };
    root.querySelectorAll('.ic-settings input, .ic-settings select').forEach(n => { n.addEventListener('change', onOpt, sig); n.addEventListener('input', () => { if (n.id === 'ic-quality') { refreshControls(); } }, sig); });

    // ---------------------------------------------------------------- items
    const items = []; let seq = 0;
    const urls = new Set();
    const mkUrl = blob => { const u = URL.createObjectURL(blob); urls.add(u); return u; };
    const rmUrl = u => { if (u && urls.has(u)) { URL.revokeObjectURL(u); urls.delete(u); } };
    const freeResult = it => { if (it.res) { rmUrl(it.res.url); it.res = null; } };
    ctx.onCleanup?.(() => { disposed = true; cancelAll(); urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); });

    async function addFiles(fileList) {
      const files = [...fileList]; if (!files.length) return;
      showMessage(msgBox, null);
      const fresh = [];
      for (const f of files) {
        const it = { id: ++seq, file: f, name: f.name || 'pasted-image', size: f.size, status: 'queued', msg: '', warn: [], srcUrl: null, srcW: 0, srcH: 0, res: null, mime: f.type || '' };
        const lim = L.checkInputLimits(f.size);
        if (lim) { it.status = 'error'; it.msg = lim; }
        else {
          try {
            const head = new Uint8Array(await f.slice(0, 4 * 1024 * 1024).arrayBuffer());
            const sniff = L.sniffType(head); if (sniff) it.mime = sniff;
            if (!sniff && !f.type.startsWith('image/')) { it.status = 'error'; it.msg = 'This does not look like an image file.'; }
            else if (L.isAnimated(head)) it.warn.push('Animated image: only the first frame is converted.');
            if (it.mime === 'image/x-icon') it.warn.push('ICO icons are decoded by the browser if possible; only the largest/first image is used.');
          } catch { it.status = 'error'; it.msg = 'Could not read this file.'; }
          if (it.status !== 'error') it.srcUrl = mkUrl(f);
        }
        items.push(it); if (it.status === 'queued') fresh.push(it);
      }
      render();
      if (fresh.length) startBatch(fresh);
    }

    // ---------------------------------------------------------------- conversion
    let worker = null, workerBroken = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined', pendingJob = null, cancelFlag = false, running = false, jobId = 0;
    const getWorker = () => {
      if (workerBroken) return null; if (worker) return worker;
      try {
        const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        w.onmessage = e => { const m = e.data; if (m.ready || !pendingJob || m.id !== pendingJob.id) return; const p = pendingJob; pendingJob = null; p.resolve(m); };
        w.onerror = ev => { ev.preventDefault?.(); workerBroken = true; try { w.terminate(); } catch { /* */ } worker = null; const p = pendingJob; pendingJob = null; p?.resolve({ ok: false, code: 'decode', message: 'worker failed' }); };
        worker = w; return w;
      } catch { workerBroken = true; return null; }
    };
    const abort = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    function cancelAll() {
      cancelFlag = true;
      if (worker) { worker.terminate(); worker = null; }
      if (pendingJob) { const p = pendingJob; pendingJob = null; p.resolve({ ok: false, code: 'cancel' }); }
    }

    const sameMime = mime => {
      const k = L.mimeToFormatKey(mime); return k && supported[k] ? L.FORMATS[k].mime : 'image/png';
    };
    async function decodeInThread(it) {
      if (it.mime !== 'image/svg+xml') {
        try { const b = await createImageBitmap(it.file, { imageOrientation: 'from-image' }); return { source: b, w: b.width, h: b.height, close: () => b.close() }; } catch { /* try <img> */ }
      }
      // <img> only: scripts inside an SVG never run in an image context.
      const blob = it.mime === 'image/svg+xml' && it.file.type !== 'image/svg+xml' ? new Blob([it.file], { type: 'image/svg+xml' }) : it.file;
      const u = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new UserError('The browser could not decode this image (unsupported format or corrupt file).')); i.src = u; });
        return { source: img, w: img.naturalWidth, h: img.naturalHeight, close() {} };
      } finally { URL.revokeObjectURL(u); }
    }
    async function convertOne(it, o) {
      const vector = it.mime === 'image/svg+xml';
      const mime = o.format === 'same' ? sameMime(it.mime) : L.FORMATS[o.format].mime;
      const lossy = mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/avif';
      const job = { resize: o.resize, vector, mime, quality: lossy ? o.quality : undefined, fill: mime === 'image/jpeg' || o.flatten ? o.bg : null };
      let r = null;
      if (!vector) {
        const w = getWorker();
        if (w) {
          r = await new Promise(resolve => { const id = ++jobId; pendingJob = { id, resolve }; try { w.postMessage({ id, file: it.file, o: job }); } catch { pendingJob = null; resolve({ ok: false, code: 'decode' }); } });
          if (r.code === 'cancel' || cancelFlag) throw abort();
          if (!r.ok && r.code !== 'decode') throw new UserError(r.message);
          if (!r.ok) r = null; // worker cannot decode this one (or is unavailable): use the page thread
        }
      }
      if (!r) {
        const d = await decodeInThread(it);
        try {
          if (!d.w || !d.h) throw new UserError('The image has no pixel size (an SVG without width/height or viewBox cannot be rasterised).');
          if (!vector) { const lim = L.checkInputLimits(it.size, d.w, d.h); if (lim) throw new UserError(lim); }
          const out = await convertSource(d.source, d.w, d.h, job);
          r = { ok: true, blob: out.blob, srcW: d.w, srcH: d.h, layout: out.layout };
        } finally { d.close(); }
      }
      it.srcW = r.srcW; it.srcH = r.srcH;
      let blob = r.blob, outMime = blob.type || mime, note = '';
      if (outMime !== mime) note = `Your browser cannot encode ${L.mimeToFormatKey(mime) ? L.FORMATS[L.mimeToFormatKey(mime)].label : mime}; the result was saved as ${L.mimeToExt(outMime).toUpperCase()} instead.`;
      let keptOriginal = false;
      if (o.format === 'same' && o.resize.mode === 'none' && blob.size >= it.size && it.mime === outMime) { blob = it.file; keptOriginal = true; note = 'Re-encoding would not make this file smaller, so the original was kept (metadata unchanged).'; }
      else if (o.format === 'same' && mime !== it.mime && it.mime !== 'image/png') note ||= `${it.mime.replace('image/', '').toUpperCase()} is not an available output format here; saved as ${L.mimeToExt(outMime).toUpperCase()}.`;
      const ext = L.mimeToExt(outMime), w = keptOriginal ? it.srcW : r.layout.outW, h = keptOriginal ? it.srcH : r.layout.outH;
      return { blob, url: mkUrl(blob), w, h, mime: outMime, ext, note: [note, ...(r.layout.notes || [])].filter(Boolean).join(' '), kept: keptOriginal };
    }

    const progBox = $('ic-progress'), bar = $('ic-bar'), progLabel = $('ic-progress-label');
    async function startBatch(batch) {
      if (running) { batch.forEach(i => { i.status = 'queued'; }); pendingBatches.push(batch); return; }
      running = true; cancelFlag = false; dirty = false; showMessage(msgBox, null);
      $('ic-cancel').hidden = false; $('ic-convert').disabled = true;
      const o = readOpts();
      let n = 0;
      try {
        for (const it of batch) {
          if (cancelFlag || disposed) { it.status = 'cancelled'; it.msg = 'Cancelled.'; continue; }
          if (!items.includes(it)) continue;
          it.status = 'converting'; it.msg = ''; freeResult(it); render();
          progBox.hidden = false; bar.value = (n / batch.length) * 100; progLabel.textContent = `${n + 1} of ${batch.length}: ${it.name}`;
          try { it.res = await convertOne(it, o); it.status = 'done'; it.res.name = ''; }
          catch (e) {
            if (e?.name === 'AbortError') { it.status = 'cancelled'; it.msg = 'Cancelled.'; }
            else { it.status = 'error'; it.msg = e instanceof UserError ? e.message : (e?.name === 'EncodingError' || /memory|allocation/i.test(e?.message || '') ? 'The image is too large for this browser to process.' : `Conversion failed: ${e?.message || e}`); }
          }
          n++; bar.value = (n / batch.length) * 100;
        }
        for (const it of batch) if (it.status === 'queued' || it.status === 'converting') { it.status = 'cancelled'; it.msg = 'Cancelled.'; }
        nameResults(o);
      } finally {
        running = false; progBox.hidden = true; $('ic-cancel').hidden = true; $('ic-convert').disabled = false; render();
        const done = items.filter(i => i.status === 'done').length;
        if (cancelFlag) showMessage(msgBox, 'warn', `Cancelled. ${done} image${done === 1 ? '' : 's'} finished.`);
        else if (done) showMessage(msgBox, 'success', `Converted ${done} image${done === 1 ? '' : 's'}.`);
        const next = pendingBatches.shift(); if (next && !disposed) { cancelFlag = false; startBatch(next.filter(i => items.includes(i))); }
      }
    }
    const pendingBatches = [];
    function nameResults(o) {
      const done = items.filter(i => i.res);
      const names = L.uniqueNames(done.map((it, i) => L.applyTemplate(o.template, { name: it.name, w: it.res.w, h: it.res.h, ext: it.res.ext, index: i + 1 })));
      done.forEach((it, i) => { it.res.name = names[i]; });
    }

    // ---------------------------------------------------------------- rendering
    function render() {
      list.replaceChildren();
      const done = items.filter(i => i.status === 'done');
      const totIn = done.reduce((s, i) => s + i.size, 0), totOut = done.reduce((s, i) => s + i.res.blob.size, 0);
      $('ic-summary').textContent = items.length ? `${items.length} image${items.length > 1 ? 's' : ''}${done.length ? ` · ${L.formatSize(totIn)} → ${L.formatSize(totOut)} (${L.savings(totIn, totOut).text})` : ''}` : '';
      $('ic-zip').disabled = done.length < 2; $('ic-convert').disabled = running || !items.length;
      for (const it of items) {
        const r = it.res;
        const thumb = (url, alt) => el('div', { class: 'ic-thumb' }, url ? el('img', { src: url, alt, loading: 'lazy' }) : el('span', { class: 'hint' }, '–'));
        const status = { queued: 'Queued', converting: 'Converting…', cancelled: 'Cancelled', error: 'Error', done: 'Done' }[it.status];
        const meta = el('div', { class: 'ic-meta' },
          el('strong', { class: 'ic-name' }, it.name),
          el('div', { class: 'hint' }, `Original: ${it.srcW ? `${it.srcW}×${it.srcH} · ` : ''}${L.formatSize(it.size)} · ${it.mime.replace('image/', '').toUpperCase() || '?'}`),
          r ? el('div', {}, `Result: ${r.w}×${r.h} · ${L.formatSize(r.blob.size)} · ${r.ext.toUpperCase()} · `, el('span', { class: `badge ${L.savings(it.size, r.blob.size).pct >= 0.05 ? 'badge-success' : 'badge-warn'}` }, L.savings(it.size, r.blob.size).text)) : el('div', { class: it.status === 'error' ? 'ic-err' : 'hint' }, it.status === 'error' ? it.msg : status + (it.msg ? ` – ${it.msg}` : '')),
          r ? el('div', { class: 'hint' }, `Saved as ${r.name}`) : null,
          r?.note ? el('div', { class: 'ic-note' }, r.note) : null,
          ...it.warn.map(w => el('div', { class: 'ic-note' }, w)));
        const actions = el('div', { class: 'ic-actions' },
          r ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => downloadFile(r.name, r.blob, r.mime) }, 'Download') : null,
          r ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openCompare(it) }, 'Compare') : null,
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Remove ${it.name}`, disabled: it.status === 'converting' ? '' : null, onclick: () => removeItem(it) }, 'Remove'));
        list.append(el('div', { class: 'panel ic-row' }, thumb(it.srcUrl, `Original ${it.name}`), thumb(r?.url, `Converted ${it.name}`), meta, actions));
      }
    }
    function removeItem(it) {
      const i = items.indexOf(it); if (i < 0) return;
      items.splice(i, 1); rmUrl(it.srcUrl); freeResult(it); if (cmpItem === it) closeCompare(); render();
    }

    // ---------------------------------------------------------------- compare
    let cmpItem = null;
    const cmp = $('ic-compare'), range = $('ic-cmp-range');
    const setPos = () => { $('ic-cmp-after').style.clipPath = `inset(0 0 0 ${range.value}%)`; };
    function openCompare(it) {
      cmpItem = it; cmp.hidden = false;
      $('ic-cmp-before').src = it.srcUrl; $('ic-cmp-after').src = it.res.url;
      $('ic-cmp').style.aspectRatio = `${it.srcW || 1} / ${it.srcH || 1}`;
      $('ic-compare-title').textContent = `Compare: ${it.name}`; setPos();
      cmp.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); range.focus({ preventScroll: true });
    }
    function closeCompare() { cmpItem = null; cmp.hidden = true; $('ic-cmp-before').removeAttribute('src'); $('ic-cmp-after').removeAttribute('src'); }
    range.addEventListener('input', setPos, sig);

    // ---------------------------------------------------------------- ZIP
    async function downloadZip() {
      const done = items.filter(i => i.status === 'done'); if (!done.length) return toast('Nothing converted yet', 'warn');
      const total = done.reduce((s, i) => s + i.res.blob.size, 0);
      if (total > L.MAX_ZIP_BYTES) return showMessage(msgBox, 'error', `The converted images total ${L.formatSize(total)}, more than the ${L.formatSize(L.MAX_ZIP_BYTES)} a ZIP can be built in the browser. Download them individually.`);
      $('ic-zip').disabled = true;
      try {
        const names = L.uniqueNames(done.map(i => i.res.name));
        const entries = []; for (let k = 0; k < done.length; k++) entries.push({ name: names[k], data: new Uint8Array(await done[k].res.blob.arrayBuffer()) });
        downloadFile('converted-images.zip', new Blob(L.zipParts(entries), { type: 'application/zip' }), 'application/zip');
      } catch (e) { showMessage(msgBox, 'error', `Could not build the ZIP: ${e.message}`); }
      finally { $('ic-zip').disabled = false; }
    }

    // ---------------------------------------------------------------- input wiring
    const drop = $('ic-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); }, sig);
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'), sig);
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); addFiles(e.dataTransfer?.files || []); }, sig);
    document.addEventListener('paste', e => {
      const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const fl = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (!fl.length) return;
      e.preventDefault(); addFiles(fl.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${L.mimeToExt(f.type)}`, { type: f.type }))));
    }, sig);

    bindActions(root, {
      pick: () => { const inp = el('input', { type: 'file', accept: 'image/*,.svg,.avif', multiple: '' }); inp.addEventListener('change', () => addFiles(inp.files)); inp.click(); },
      convert: () => {
        if (!items.length) return showMessage(msgBox, 'error', 'Add some images first.');
        const batch = items.filter(i => i.status !== 'converting' && !(i.status === 'error' && !i.srcUrl)); if (!batch.length) return showMessage(msgBox, 'error', 'None of the added files can be converted.');
        startBatch(batch);
      },
      cancel: () => { pendingBatches.length = 0; cancelAll(); },
      zip: downloadZip,
      clear: () => { cancelAll(); pendingBatches.length = 0; items.forEach(i => { rmUrl(i.srcUrl); freeResult(i); }); items.length = 0; closeCompare(); showMessage(msgBox, null); render(); },
      'compare-close': closeCompare,
    });

    refreshControls(); render(); renderIcons(root);
    return () => { disposed = true; cancelAll(); urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };
  },
};
