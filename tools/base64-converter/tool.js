import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, readFileAsArrayBuffer,
  showMessage, initTabs, bindActions, withLoading, formatBytes, renderIcons } from '../../assets/js/components/ui.js';
import { encodeText, encodeBytes, decodeText, decodeToBytes, detectMime, extForMime, toDataUri,
  imgSnippet, cssSnippet, SIZE_WARN_BYTES } from './logic.js';

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const disposers = [];

    // ---------- TEXT ----------
    const tIn = $('b64-text-in'), tOut = $('b64-text-out'), tMsg = $('b64-text-msg');
    const textOpts = () => ({ urlSafe: $('b64-urlsafe').checked, wrap: Number($('b64-wrap').value) });
    const stats = () => {
      $('b64-text-stats').textContent = `Text: ${new TextEncoder().encode(tIn.value).length} bytes (UTF-8) | Base64: ${tOut.value.replace(/\s/g, '').length} chars`;
    };
    const textEncode = () => {
      showMessage(tMsg, null);
      tOut.value = encodeText(tIn.value, textOpts());
      stats();
    };
    const textDecode = () => {
      showMessage(tMsg, null);
      if (!tOut.value.trim()) return showMessage(tMsg, 'error', 'Paste some Base64 in the right-hand box first.');
      try { tIn.value = decodeText(tOut.value); stats(); }
      catch (e) { showMessage(tMsg, 'error', e.message); }
    };
    // Re-encode live when options change and there is text on the left.
    const reencode = () => { if (tIn.value) textEncode(); };
    $('b64-urlsafe').addEventListener('change', reencode);
    $('b64-wrap').addEventListener('change', reencode);

    // ---------- IMAGE ----------
    let img = null; // { dataUri, b64, mime, name, size, w, h }
    const iMsg = $('b64-img-msg');
    const refreshImgOutput = () => {
      if (!img) return;
      $('b64-img-result').value = $('b64-img-raw').checked ? img.b64 : img.dataUri;
      $('b64-snip-img').textContent = imgSnippet(img.dataUri);
      $('b64-snip-css').textContent = cssSnippet(img.dataUri);
    };
    const resetImg = () => {
      img = null;
      $('b64-img-preview').innerHTML = '<span class="hint">No image yet.</span>';
      $('b64-img-info').hidden = true;
      $('b64-img-out').hidden = true; $('b64-img-snips').hidden = true;
      showMessage(iMsg, null);
    };
    /** Validate by actually decoding the image in the browser, then show everything. */
    const showImage = (dataUri, b64, mime, name, size) => new Promise(resolve => {
      const el = new Image();
      el.onload = () => {
        img = { dataUri, b64, mime, name, size, w: el.naturalWidth, h: el.naturalHeight };
        const prev = $('b64-img-preview'); prev.replaceChildren(el);
        el.alt = name || 'preview';
        const info = $('b64-img-info');
        info.hidden = false; info.textContent = `${img.w}x${img.h} | ${mime} | ${formatBytes(size)}`;
        $('b64-img-out').hidden = false; $('b64-img-snips').hidden = false;
        refreshImgOutput();
        showMessage(iMsg, 'success', `Image loaded: ${img.w} x ${img.h}px, ${formatBytes(size)}, Base64 length ${b64.length.toLocaleString()} chars.`);
        resolve(true);
      };
      el.onerror = () => { resetImg(); showMessage(iMsg, 'error', 'The data could not be decoded as an image. It is either not an image or it is corrupted.'); resolve(false); };
      el.src = dataUri;
    });
    const loadImageFile = async file => {
      if (!file.type.startsWith('image/')) return showMessage(iMsg, 'error', `"${file.name}" is not an image (type: ${file.type || 'unknown'}). Use the File tab for other files.`);
      try {
        const buf = new Uint8Array(await readFileAsArrayBuffer(file));
        const mime = file.type || detectMime(buf) || 'image/png';
        const b64 = encodeBytes(buf);
        $('b64-img-paste').value = '';
        await showImage(toDataUri(b64, mime), b64, mime, file.name, file.size);
        if (file.size > SIZE_WARN_BYTES) toast('Large image: output will be very long', 'warn');
      } catch (e) { showMessage(iMsg, 'error', 'Could not read file: ' + e.message); }
    };
    const loadImagePaste = async () => {
      const text = $('b64-img-paste').value;
      if (!text.trim()) return showMessage(iMsg, 'error', 'Paste a Base64 string or data URI first.');
      try {
        const { bytes, mime: declared } = decodeToBytes(text);
        const sniffed = detectMime(bytes);
        const mime = (declared && declared.startsWith('image/')) ? declared : sniffed;
        if (!mime || !mime.startsWith('image/')) {
          return showMessage(iMsg, 'error', declared && !declared.startsWith('image/')
            ? `The data: URI declares "${declared}", which is not an image.`
            : 'Could not recognise an image type from the data (no valid image header found).');
        }
        const b64 = encodeBytes(bytes);
        await showImage(toDataUri(b64, mime), b64, mime, 'image', bytes.length);
      } catch (e) { showMessage(iMsg, 'error', e.message); }
    };
    $('b64-img-raw').addEventListener('change', refreshImgOutput);
    disposers.push(enableDrop($('b64-img-drop'), loadImageFile));

    // ---------- FILE ----------
    let fileB64 = '', fileMime = '';
    const fMsg = $('b64-file-msg');
    const refreshFileOut = () => {
      $('b64-file-out').value = fileB64 ? ($('b64-file-uri').checked ? toDataUri(fileB64, fileMime) : fileB64) : '';
    };
    const loadFile = file => withLoading(null, async () => {
      showMessage(fMsg, null);
      if (file.size > SIZE_WARN_BYTES) showMessage(fMsg, 'warn', `Large file (${formatBytes(file.size)}). Encoding may be slow and the page may become sluggish.`);
      try {
        const buf = new Uint8Array(await readFileAsArrayBuffer(file));
        fileB64 = encodeBytes(buf); // chunked internally
        fileMime = file.type || detectMime(buf) || 'application/octet-stream';
        refreshFileOut();
        const info = $('b64-file-info'); info.hidden = false;
        info.textContent = `${file.name} | ${formatBytes(file.size)} -> ${formatBytes(fileB64.length)}`;
        // Pre-fill the reverse form with this file's details for convenience.
        $('b64-file-name').value = file.name; $('b64-file-mime').value = fileMime;
      } catch (e) { showMessage(fMsg, 'error', 'Could not read or encode the file: ' + e.message); }
    });
    $('b64-file-uri').addEventListener('change', refreshFileOut);
    disposers.push(enableDrop($('b64-file-drop'), loadFile));
    const fileInInfo = () => {
      const t = $('b64-file-in').value;
      if (!t.trim()) { $('b64-file-in-info').textContent = ''; return; }
      try {
        const { bytes, mime } = decodeToBytes(t);
        const m = mime || detectMime(bytes);
        $('b64-file-in-info').textContent = `Valid Base64: ${formatBytes(bytes.length)}${m ? ', detected ' + m : ''}`;
        if (m && !$('b64-file-mime').value) $('b64-file-mime').value = m;
      } catch { $('b64-file-in-info').textContent = ''; }
    };
    $('b64-file-in').addEventListener('change', fileInInfo);

    // ---------- actions ----------
    bindActions(root, {
      'text-encode': textEncode,
      'text-decode': textDecode,
      'text-swap': () => { [tIn.value, tOut.value] = [tOut.value, tIn.value]; showMessage(tMsg, null); stats(); },
      'text-sample': () => { tIn.value = 'Hello, Wörld! 你好，世界 😀 — Base64 ✓'; textEncode(); },
      'text-clear': () => { tIn.value = ''; tOut.value = ''; showMessage(tMsg, null); stats(); },
      'text-open': async () => {
        const f = await pickFile('.txt,text/*,.json,.csv,.md');
        if (f) { try { tIn.value = await readFileAsText(f); textEncode(); } catch (e) { showMessage(tMsg, 'error', e.message); } }
      },
      'text-copy-in': () => copyText(tIn.value),
      'text-copy-out': () => copyText(tOut.value),
      'text-download': () => downloadFile('base64.txt', tOut.value),

      'img-pick': async () => { const f = await pickFile('image/*'); if (f) loadImageFile(f); },
      'img-load': loadImagePaste,
      'img-clear': () => { $('b64-img-paste').value = ''; resetImg(); },
      'img-copy': () => copyText($('b64-img-result').value),
      'img-download-txt': () => downloadFile('image-base64.txt', $('b64-img-result').value),
      'img-copy-img': () => copyText($('b64-snip-img').textContent),
      'img-copy-css': () => copyText($('b64-snip-css').textContent),
      'img-download': () => {
        if (!img) return showMessage(iMsg, 'error', 'Load an image first.');
        const { bytes } = decodeToBytes(img.b64);
        const base = (img.name || 'image').replace(/\.[^.]+$/, '') || 'image';
        downloadFile(`${base}.${extForMime(img.mime)}`, new Blob([bytes], { type: img.mime }));
      },

      'file-pick': async () => { const f = await pickFile(); if (f) loadFile(f); },
      'file-copy': () => copyText($('b64-file-out').value),
      'file-download-txt': () => downloadFile('file-base64.txt', $('b64-file-out').value),
      'file-clear': () => { fileB64 = ''; $('b64-file-out').value = ''; $('b64-file-info').hidden = true; showMessage(fMsg, null); },
      'file-save': () => {
        const box = $('b64-file-in-msg'); showMessage(box, null);
        const text = $('b64-file-in').value;
        if (!text.trim()) return showMessage(box, 'error', 'Paste Base64 first.');
        try {
          const { bytes, mime } = decodeToBytes(text);
          const type = $('b64-file-mime').value.trim() || mime || detectMime(bytes) || 'application/octet-stream';
          let name = $('b64-file-name').value.trim().replace(/[\\/:*?"<>|]/g, '_') || 'download';
          if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.' + extForMime(type);
          downloadFile(name, new Blob([bytes], { type }));
          showMessage(box, 'success', `Downloaded ${name} (${formatBytes(bytes.length)}).`);
        } catch (e) { showMessage(box, 'error', e.message); }
      },
      'file-in-clear': () => { $('b64-file-in').value = ''; $('b64-file-in-info').textContent = ''; showMessage($('b64-file-in-msg'), null); },
    });

    initTabs(root);
    renderIcons(root);
    stats();
    return () => disposers.forEach(d => d());
  },
};
