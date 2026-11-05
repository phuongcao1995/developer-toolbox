import { el, copyText, downloadFile, toast, showMessage, initTabs, bindActions, renderIcons, loadScript, formatBytes } from '../../assets/js/components/ui.js';
import { qrcode } from '../../assets/js/vendor/qrcode-generator.min.js';
import * as L from './logic.js';

const JSQR_URL = new URL('../../assets/js/vendor/jsqr.min.js', import.meta.url).href;

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const sig = ctx.signal ? { signal: ctx.signal } : {};
    const val = id => $(id).value;
    let disposed = false;

    // ================================================================ GENERATE
    const presetSel = $('qr-preset'), canvas = $('qr-canvas'), genMsg = $('qr-gen-msg'), warnBox = $('qr-warn'), emptyHint = $('qr-empty'), info = $('qr-info');
    const saved = ctx.storage.get('opts', null);
    if (saved && typeof saved === 'object') {
      if ($('qr-preset').querySelector(`option[value="${saved.preset}"]`)) presetSel.value = saved.preset;
      if (L.EC_LEVELS.includes(saved.ec)) $('qr-ec').value = saved.ec;
      if (Number.isFinite(saved.size)) $('qr-size').value = saved.size;
      if (Number.isFinite(saved.margin)) $('qr-margin').value = saved.margin;
      if (L.isHexColor(saved.fg)) $('qr-fg').value = saved.fg;
      if (L.isHexColor(saved.bg)) $('qr-bg').value = saved.bg;
      $('qr-transparent').checked = !!saved.transparent;
    }
    const clampInt = (id, lo, hi, dflt) => { const n = parseInt(val(id), 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    let current = null; // { matrix, payload, px, opts }

    const formFields = {
      text: () => ({ text: val('qr-text') }),
      url: () => ({ url: val('qr-url') }),
      wifi: () => ({ ssid: val('qr-wifi-ssid'), password: val('qr-wifi-pass'), type: val('qr-wifi-type'), hidden: $('qr-wifi-hidden').checked }),
      vcard: () => ({ firstName: val('qr-v-first'), lastName: val('qr-v-last'), org: val('qr-v-org'), title: val('qr-v-title'), phone: val('qr-v-phone'), email: val('qr-v-email'), url: val('qr-v-url'), street: val('qr-v-street'), city: val('qr-v-city'), region: val('qr-v-region'), postal: val('qr-v-postal'), country: val('qr-v-country'), note: val('qr-v-note') }),
      email: () => ({ to: val('qr-m-to'), subject: val('qr-m-subject'), body: val('qr-m-body') }),
      sms: () => ({ number: val('qr-s-num'), message: val('qr-s-msg') }),
      geo: () => ({ lat: val('qr-g-lat'), lng: val('qr-g-lng') }),
    };
    const showPreset = () => {
      root.querySelectorAll('[data-preset]').forEach(s => { s.hidden = s.dataset.preset !== presetSel.value; });
      $('qr-wifi-pass').disabled = val('qr-wifi-type') === 'nopass';
    };
    const clearOutput = text => {
      current = null; canvas.hidden = true; emptyHint.hidden = false; emptyHint.textContent = text; info.hidden = true; showMessage(warnBox, null);
    };
    function generate() {
      if (disposed) return;
      showPreset();
      ctx.storage.set('opts', { preset: presetSel.value, ec: val('qr-ec'), size: clampInt('qr-size', 64, 2048, 512), margin: clampInt('qr-margin', 0, 16, 4), fg: val('qr-fg'), bg: val('qr-bg'), transparent: $('qr-transparent').checked });
      showMessage(genMsg, null);
      const built = L.buildPayload(presetSel.value, formFields[presetSel.value]());
      if (built.error) return clearOutput(built.error);
      const m = L.makeMatrix(qrcode, built.text, val('qr-ec'));
      if (m.error) { clearOutput('No QR code could be generated.'); return showMessage(genMsg, 'error', m.error); }
      const margin = clampInt('qr-margin', 0, 16, 4), target = clampInt('qr-size', 64, 2048, 512);
      const { scale, units, px, tooSmall } = L.computeScale(m.size, margin, target);
      const fg = val('qr-fg'), bg = val('qr-bg'), transparent = $('qr-transparent').checked;
      canvas.width = px; canvas.height = px; canvas.hidden = false; emptyHint.hidden = true;
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, px, px);
      if (!transparent) { g.fillStyle = bg; g.fillRect(0, 0, px, px); }
      g.fillStyle = fg;
      for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.rows[r][c]) g.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
      current = { matrix: m, payload: built.text, px, margin, fg, bg, transparent };
      info.hidden = false;
      info.textContent = `Version ${m.version} · ${m.size}×${m.size} modules · ${m.mode} · ${m.length.toLocaleString()} ${m.mode === 'Byte' ? 'bytes' : 'chars'} · ${px}px`;
      const warnings = L.checkReadability(fg, bg, margin, transparent).warnings.slice();
      if (built.note) warnings.unshift(built.note);
      if (tooSmall) warnings.push(`The requested size (${target}px) is smaller than the ${units} modules needed; the image is ${px}px (1px per module). Increase the size for a scannable code.`);
      else if (px !== target) warnings.push(`Exported size is ${px}px: the closest whole number of pixels per module (${scale}px) at or below ${target}px, so edges stay sharp.`);
      if (warnings.length) { warnBox.hidden = false; warnBox.className = 'alert alert-warn'; warnBox.replaceChildren(...warnings.map(w => el('div', {}, w))); } else showMessage(warnBox, null);
    }
    const genDebounced = ctx.debounce(generate, 150);
    root.querySelector('[data-panel="gen"]').addEventListener('input', genDebounced, sig);
    root.querySelector('[data-panel="gen"]').addEventListener('change', genDebounced, sig);
    $('qr-wifi-show').addEventListener('change', e => { $('qr-wifi-pass').type = e.target.checked ? 'text' : 'password'; }, sig);
    const canCopyImg = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
    $('qr-copy-png').hidden = !canCopyImg;

    const canvasBlob = () => new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png'));
    const need = () => { if (current) return true; toast('Generate a QR code first', 'warn'); return false; };

    // ================================================================ READ
    const readMsg = $('qr-read-msg'), results = $('qr-results'), imgWrap = $('qr-img-wrap'), imgEl = $('qr-img');
    let detector = null, jsQRFn = null, objUrl = null;
    const initDetector = async () => {
      try {
        if ('BarcodeDetector' in window) {
          const fmts = await window.BarcodeDetector.getSupportedFormats();
          if (fmts.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch { detector = null; }
      $('qr-engine').textContent = detector ? 'Decoder: the browser’s built-in BarcodeDetector (falls back to bundled jsQR if it finds nothing).' : 'Decoder: bundled jsQR (your browser has no native QR detector).';
    };
    const getJsQR = async () => {
      if (jsQRFn) return jsQRFn;
      if (!window.jsQR) await loadScript(JSQR_URL);
      jsQRFn = window.jsQR; if (typeof jsQRFn !== 'function') throw new Error('QR decoder failed to load.');
      return jsQRFn;
    };
    /** Decode all QR codes in a canvas. Returns unique strings. */
    async function decodeCanvas(cv) {
      if (detector) {
        try { const r = await detector.detect(cv); const t = [...new Set(r.map(x => x.rawValue).filter(Boolean))]; if (t.length) return t; } catch { /* use jsQR */ }
      }
      const jsQR = await getJsQR();
      const img = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
      return [...new Set(L.findAllQr(jsQR, img).map(f => f.text))];
    }
    function drawScaled(src, sw, sh, maxDim) {
      const { width, height } = L.scaleToFit(sw, sh, maxDim);
      const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height); g.drawImage(src, 0, 0, width, height);
      return cv;
    }
    const revokeImg = () => { if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; } };
    ctx.onCleanup?.(revokeImg);

    async function loadSource(file) {
      // createImageBitmap honours EXIF orientation; SVG (and anything it rejects) goes through an <img>, never inline.
      let bmp = null, w = 0, h = 0, el2 = null;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = bmp.width; h = bmp.height; }
      catch {
        el2 = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = objUrl; });
        w = el2.naturalWidth; h = el2.naturalHeight;
      }
      return { src: bmp || el2, w, h, close: () => bmp?.close?.() };
    }
    async function scanFile(file) {
      stopCamera();
      showMessage(readMsg, null); results.replaceChildren();
      if (!file) return;
      if (!(file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name))) return showMessage(readMsg, 'error', `"${file.name}" is not an image (type ${file.type || 'unknown'}).`);
      if (file.size > L.MAX_IMAGE_BYTES) return showMessage(readMsg, 'error', `This image is ${formatBytes(file.size)}; the limit is ${formatBytes(L.MAX_IMAGE_BYTES)}.`);
      revokeImg(); objUrl = URL.createObjectURL(file); imgEl.src = objUrl; imgWrap.hidden = false;
      showMessage(readMsg, 'info', 'Scanning…');
      let s;
      try { s = await loadSource(file); } catch { imgWrap.hidden = true; return showMessage(readMsg, 'error', 'This image could not be decoded (unsupported or corrupt file).'); }
      try {
        if (!s.w || !s.h) return showMessage(readMsg, 'error', 'The image has no pixel size (an SVG without width/height cannot be scanned).');
        if (s.w * s.h > 50e6) return showMessage(readMsg, 'error', `The image is ${(s.w * s.h / 1e6).toFixed(0)} megapixels; the limit is 50 MP.`);
        let texts = await decodeCanvas(drawScaled(s.src, s.w, s.h, L.MAX_DECODE_DIM));
        // Very dense or tiny codes in big photos sometimes decode better at a lower resolution.
        if (!texts.length && Math.max(s.w, s.h) > 1200) texts = await decodeCanvas(drawScaled(s.src, s.w, s.h, 1000));
        const note = Math.max(s.w, s.h) > L.MAX_DECODE_DIM ? ` (downscaled from ${s.w}×${s.h} for decoding)` : '';
        showResults(texts, note);
      } catch (e) { showMessage(readMsg, 'error', `Scanning failed: ${e.message}`); }
      finally { s.close(); }
    }
    function showResults(texts, note = '') {
      results.replaceChildren();
      if (!texts.length) return showMessage(readMsg, 'warn', `No QR code found${note}. Try a sharper, larger, well-lit image where the code fills more of the frame.`);
      showMessage(readMsg, 'success', `Found ${texts.length} QR code${texts.length > 1 ? 's' : ''}${note}.`);
      texts.forEach((t, i) => results.append(resultCard(t, texts.length > 1 ? i + 1 : 0)));
    }

    const dl = rows => el('dl', { class: 'qr-dl' }, rows.filter(r => r.value !== '' && r.value != null).flatMap(r => [el('dt', {}, r.label), el('dd', {}, r.node || String(r.value))]));
    function resultCard(text, n) {
      const t = L.detectType(text), p = t.parsed;
      const card = el('div', { class: 'panel qr-card' },
        el('div', { class: 'panel-head' }, el('h3', {}, `${n ? `#${n} ` : ''}${t.label}`),
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(text, 'Copied') }, 'Copy text')));
      const body = el('div', { class: 'panel-body stack' });
      body.append(el('pre', { class: 'code-block qr-raw', tabindex: '0', 'aria-label': 'Decoded text' }, text));
      const warn = msg => body.append(el('div', { class: 'alert alert-warn' }, msg));
      if (t.type === 'url') {
        const u = t.url;
        body.append(dl([{ label: 'Host', value: u.host ? (u.unicodeHost !== u.host ? `${u.host} (shown as ${u.unicodeHost})` : u.host) : '' }, { label: 'Scheme', value: u.scheme }]));
        u.warnings.forEach(warn);
        if (u.linkable) {
          body.append(el('p', { class: 'hint' }, 'Only open links you trust. The destination is:'), el('code', { class: 'qr-url' }, u.href),
            el('p', {}, el('a', { class: 'btn btn-sm', href: u.href, target: '_blank', rel: 'noopener noreferrer' }, 'Open link in a new tab')));
        }
      } else if (t.type === 'wifi') {
        let shown = false;
        const pw = el('span', { class: 'mono' }, p.password ? '•'.repeat(Math.min(12, p.password.length)) : '(none)');
        const tog = el('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Show or hide the password', onclick: () => { shown = !shown; pw.textContent = shown ? p.password : '•'.repeat(Math.min(12, p.password.length)); tog.textContent = shown ? 'Hide' : 'Show'; } }, 'Show');
        const cp = el('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(p.password, 'Password copied') }, 'Copy password');
        body.append(dl([{ label: 'Network (SSID)', value: p.ssid }, { label: 'Security', value: p.security }, { label: 'Hidden', value: p.hidden ? 'yes' : 'no' },
          { label: 'Password', value: 'x', node: el('span', { class: 'row' }, pw, ...(p.password ? [tog, cp] : [])) }]));
      } else if (t.type === 'vcard' || t.type === 'mecard') body.append(dl(p.fields.map(f => ({ label: f.label, value: f.value }))));
      else if (t.type === 'email') body.append(dl([{ label: 'To', value: p.to }, { label: 'Subject', value: p.subject }, { label: 'Message', value: p.body }]));
      else if (t.type === 'sms') body.append(dl([{ label: 'Number', value: p.number }, { label: 'Message', value: p.message }]));
      else if (t.type === 'geo') body.append(dl([{ label: 'Latitude', value: p.lat }, { label: 'Longitude', value: p.lng }]));
      else if (t.type === 'tel') body.append(dl([{ label: 'Number', value: p.number }]));
      else if (t.type === 'otp') warn('This code contains a two-factor secret. Anyone who sees it can generate your login codes; do not share or store it carelessly.');
      card.append(body); return card;
    }

    // ---- camera
    let stream = null, scanTimer = 0, camToken = 0, scanning = false;
    const video = $('qr-video'), camStart = $('qr-cam-start'), camStop = $('qr-cam-stop'), videoWrap = $('qr-video-wrap');
    function stopCamera() {
      camToken++; clearTimeout(scanTimer); scanTimer = 0;
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null; videoWrap.hidden = true; camStop.hidden = true; camStart.hidden = false; camStart.disabled = false;
    }
    ctx.onCleanup?.(() => { disposed = true; stopCamera(); });
    async function startCamera() {
      showMessage(readMsg, null);
      if (!navigator.mediaDevices?.getUserMedia) return showMessage(readMsg, 'error', window.isSecureContext === false ? 'Camera access needs a secure context (HTTPS or localhost).' : 'This browser does not support camera access.');
      stopCamera(); const token = ++camToken; camStart.disabled = true;
      let s;
      try { s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: val('qr-facing') }, width: { ideal: 1280 } } }); }
      catch (e) { camStart.disabled = false; return showMessage(readMsg, 'error', L.friendlyCameraError(e)); }
      if (token !== camToken || disposed) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s; video.srcObject = s; videoWrap.hidden = false; camStop.hidden = false; camStart.hidden = true;
      try { await video.play(); } catch { /* autoplay muted should work */ }
      imgWrap.hidden = true; results.replaceChildren();
      showMessage(readMsg, 'info', 'Point the camera at a QR code…');
      const tick = async () => {
        if (token !== camToken || disposed) return;
        if (!scanning && video.readyState >= 2 && video.videoWidth) {
          scanning = true;
          try {
            const texts = await decodeCanvas(drawScaled(video, video.videoWidth, video.videoHeight, 800));
            if (token === camToken && texts.length) { stopCamera(); showResults(texts); scanning = false; return; }
          } catch (e) { if (token === camToken) { stopCamera(); showMessage(readMsg, 'error', `Scanning failed: ${e.message}`); } scanning = false; return; }
          scanning = false;
        }
        if (token === camToken) scanTimer = setTimeout(tick, 160);
      };
      tick();
    }

    // ---- drop / paste / pick
    const drop = $('qr-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); }, sig);
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'), sig);
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); const f = e.dataTransfer?.files?.[0]; if (f) scanFile(f); }, sig);
    document.addEventListener('paste', e => {
      if (activeTab !== 'read') return;
      const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
      if (f) { e.preventDefault(); scanFile(f); }
    }, sig);

    let activeTab = 'gen';
    initTabs(root, name => { activeTab = name; if (name !== 'read') stopCamera(); });

    bindActions(root, {
      'dl-png': async () => { if (!need()) return; try { downloadFile('qrcode.png', await canvasBlob(), 'image/png'); } catch (e) { toast(e.message, 'error'); } },
      'dl-svg': () => { if (!need()) return; const c = current; downloadFile('qrcode.svg', L.matrixToSvg(c.matrix, { margin: c.margin, size: c.px, fg: c.fg, bg: c.bg, transparent: c.transparent }), 'image/svg+xml'); },
      'copy-png': async () => {
        if (!need()) return;
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob() })]); toast('PNG copied to clipboard', 'success'); }
        catch { toast('Copying images is not allowed here; use Download PNG instead', 'error'); }
      },
      'copy-payload': () => { if (need()) copyText(current.payload, 'Content copied'); },
      'img-pick': () => {
        const input = el('input', { type: 'file', accept: 'image/*' });
        input.addEventListener('change', () => { if (input.files[0]) scanFile(input.files[0]); });
        input.click();
      },
      'cam-start': startCamera,
      'cam-stop': () => { stopCamera(); showMessage(readMsg, null); },
    });
    $('qr-wifi-type').addEventListener('change', showPreset, sig);

    showPreset(); generate(); initDetector(); renderIcons(root);
    return () => { disposed = true; stopCamera(); revokeImg(); };
  },
};
