// Saltbox UI wiring (ported from the standalone Saltbox app). All cryptography lives in
// ./logic.js + ./lib; this file only reads inputs, calls them, and renders results or errors.
// Nothing typed into the tool is stored or sent anywhere.
import { S } from './logic.js';

export default {
  mount(root) {
  const disposers = [];
  const $ = (sel, scope = root) => scope.querySelector(sel);
  const $$ = (sel, scope = root) => Array.from(scope.querySelectorAll(sel));

  const CONFIRM_CLEAR_CHARS = 5000;
  const MAX_IMPORT_BYTES = 10 * 1024 * 1024;   // text import
  const MAX_HASH_FILE_BYTES = 512 * 1024 * 1024;
  const LIVE_ENCODE_LIMIT = 1024 * 1024;

  // ================================================================ helpers

  function messageOf(err) {
    return (err && err.message) || String(err);
  }

  function setStatus(el, kind, message) {
    if (!el) return;
    el.classList.remove('is-ok', 'is-error', 'is-warn');
    if (kind && message) el.classList.add(`is-${kind}`);
    el.textContent = message || '';
  }

  function statusFor(el) {
    const panel = el.closest('.sb-tool');
    return panel ? $('.status', panel) : null;
  }

  function radioValue(name) {
    const checked = $(`input[name="${name}"]:checked`);
    return checked ? checked.value : null;
  }

  function setRadio(name, value) {
    const input = $(`input[name="${name}"][value="${value}"]`);
    if (input && !input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function isOutputBox(el) {
    return el.tagName === 'OUTPUT' || el.classList.contains('hexview');
  }

  /** Reads the copyable value of an input, textarea, or rendered output. */
  function readValue(el) {
    if (isOutputBox(el)) return el.dataset.value || '';
    return 'value' in el ? el.value : el.textContent;
  }

  /** Renders hex as alternating byte pairs (copy still yields plain hex). */
  function renderHex(el, hex) {
    el.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < hex.length; i += 2) {
      const span = document.createElement('span');
      span.className = 'b';
      span.textContent = hex.slice(i, i + 2);
      frag.appendChild(span);
    }
    el.appendChild(frag);
    el.dataset.value = hex;
  }

  function renderPlain(el, text) {
    el.textContent = text;
    el.dataset.value = text;
  }

  function clearOutput(el) {
    el.textContent = '';
    delete el.dataset.value;
  }

  function countText(text) {
    const chars = Array.from(text).length; // code points, not UTF-16 units
    const bytes = S.encoding.utf8Encode(text).length;
    return `${chars.toLocaleString('en-US')} character${chars === 1 ? '' : 's'}, ${bytes.toLocaleString('en-US')} byte${bytes === 1 ? '' : 's'}`;
  }

  function parseWholeNumber(input, label) {
    const raw = String(input.value).trim();
    const n = Number(raw);
    if (!raw || !Number.isInteger(n)) {
      input.setAttribute('aria-invalid', 'true');
      throw new Error(`${label} must be a whole number.`);
    }
    input.removeAttribute('aria-invalid');
    return n;
  }

  /** Disables a button while an async task runs. */
  async function withBusy(button, busyLabel, task) {
    const label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyLabel;
    try {
      return await task();
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
  }

  async function copyText(text) {
    if (!text) throw new Error('Nothing to copy yet.');
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Copy failed. Select the text and copy it manually.');
  }

  function downloadText(text, filename, type = 'text/plain') {
    if (!text) throw new Error('Nothing to download yet.');
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function flashLabel(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;
    clearTimeout(Number(button.dataset.timer));
    button.dataset.timer = String(setTimeout(() => {
      button.textContent = original;
      delete button.dataset.label;
    }, 1500));
  }

  // ================================================================ shared utilities

  function setupUtilities() {
    // Copy
    $$('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        const status = statusFor(button);
        try {
          await copyText(readValue($(button.dataset.copy)));
          flashLabel(button, 'Copied');
          setStatus(status, null, '');
        } catch (err) {
          setStatus(status, 'error', messageOf(err));
        }
      });
    });

    // Download
    $$('[data-download]').forEach((button) => {
      button.addEventListener('click', () => {
        const status = statusFor(button);
        try {
          const filename = button.dataset.filename || 'result.txt';
          downloadText(readValue($(button.dataset.download)), filename, filename.endsWith('.json') ? 'application/json' : 'text/plain');
        } catch (err) {
          setStatus(status, 'error', messageOf(err));
        }
      });
    });

    // Clear (asks first when a lot of text would be lost)
    $$('[data-clear]').forEach((button) => {
      button.addEventListener('click', () => {
        const targets = button.dataset.clear.split(',').map((s) => $(s.trim())).filter(Boolean);
        const total = targets.reduce((n, el) => n + (el.type === 'file' ? 0 : readValue(el).length), 0);
        if (total > CONFIRM_CLEAR_CHARS && !window.confirm(`Clear ${total.toLocaleString('en-US')} characters of input and output?`)) return;
        targets.forEach((el) => {
          if (el.tagName === 'DL') el.textContent = '';
          else if (isOutputBox(el)) clearOutput(el);
          else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const panel = button.closest('.sb-tool');
        $$('.result', panel).forEach((r) => setStatus(r, null, ''));
        setStatus($(button.dataset.status), null, '');
      });
    });

    // Show / hide secrets
    $$('[data-toggle-visibility]').forEach((button) => {
      button.addEventListener('click', () => {
        const input = $(button.dataset.toggleVisibility);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.textContent = show ? 'Hide' : 'Show';
        button.setAttribute('aria-pressed', String(show));
      });
    });

    // Import a text file into a textarea
    const picker = $('.sb-import-picker');
    let importTarget = null;
    $$('[data-import]').forEach((button) => {
      button.addEventListener('click', () => {
        importTarget = $(button.dataset.import);
        picker.value = '';
        picker.click();
      });
    });
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file || !importTarget) return;
      const status = statusFor(importTarget);
      try {
        if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is larger than 10 MB. Import a smaller text file.');
        importTarget.value = await file.text();
        importTarget.dispatchEvent(new Event('input', { bubbles: true }));
        setStatus(status, 'ok', `Imported ${file.name}.`);
      } catch (err) {
        setStatus(status, 'error', messageOf(err));
      } finally {
        picker.value = '';
      }
    });

    // Ctrl/Cmd + Enter runs the panel's main action
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      const panel = e.target.closest && e.target.closest('.sb-tool');
      const primary = panel && $('.btn-primary', panel);
      if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
    });

    // Drop typed secrets when the page is hidden or put in the back/forward cache.
    const wipeSecrets = () => {
      // Also clear plaintext, ciphertext and outputs, which can hold secrets or recoverable data.
      ['#hash-input', '#enc-input', '#enc-output', '#kc-input', '#kc-output', '#gen-output', '#code-input', '#code-output'].forEach((sel) => {
        const el = $(sel); if (el) el.value = '';
      });
      ['#hash-output', '#pw-output'].forEach((sel) => { const el = $(sel); if (el) clearOutput(el); });
      const fileEl = $('#hash-file'); if (fileEl) fileEl.value = '';
      // Secret fields can be switched to type="text" by the Show button, so match them by their toggle too.
      $$('[data-toggle-visibility]').forEach((btn) => { const el = $(btn.dataset.toggleVisibility); if (el) el.value = ''; });
      $$('input[type="password"]').forEach((el) => { el.value = ''; });
    };
    window.addEventListener('pagehide', wipeSecrets);
    disposers.push(() => { window.removeEventListener('pagehide', wipeSecrets); wipeSecrets(); });
  }


  // ================================================================ hash generator

  function setupHash() {
    const alg = $('#hash-alg');
    const input = $('#hash-input');
    const fileInput = $('#hash-file');
    const output = $('#hash-output');
    const outputMeta = $('#hash-output-meta');
    const status = $('#hash-status');
    const compareResult = $('#hash-compare-result');
    const runButton = $('#hash-run');

    function updateAlgorithmInfo() {
      const info = S.hash.getAlgorithm(alg.value);
      $('#hash-note-title').textContent = alg.value;
      $('#hash-note').textContent = info.note;
      $('#hash-legacy-warning').hidden = !info.legacy;
    }

    function updateSource() {
      const fileMode = radioValue('hash-source') === 'file';
      $('#hash-text-group').hidden = fileMode;
      $('#hash-file-group').hidden = !fileMode;
      $('#hash-import').hidden = fileMode;
      clearOutput(output);
      outputMeta.textContent = '';
      setStatus(compareResult, null, '');
    }

    let hashAbort = null;
    const isChunkedMd5 = () => radioValue('hash-source') === 'file' && alg.value === 'MD5';
    /** MD5 of the chosen file in 8 MB slices with a progress bar and Cancel. */
    async function md5OfFile() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) throw new Error('Choose a file to hash.');
      if (file.size > MAX_HASH_FILE_BYTES) throw new Error('Files over 512 MB are not supported in the browser.');
      const bar = $('#hash-progress'), text = $('#hash-progress-text'), cancel = $('#hash-cancel');
      hashAbort = new AbortController();
      $('#hash-progress-wrap').hidden = false; cancel.hidden = false; bar.value = 0;
      try {
        const digest = await S.hash.md5Blob(file, {
          signal: hashAbort.signal,
          onProgress: (done, total) => {
            const pct = total ? Math.round((done / total) * 100) : 100;
            bar.value = pct; text.textContent = `${pct}% (${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} bytes)`;
          },
        });
        return { digest, label: file.name, size: file.size };
      } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('Hashing cancelled.');
        throw err;
      } finally {
        hashAbort = null; $('#hash-progress-wrap').hidden = true; cancel.hidden = true;
      }
    }

    async function getInputBytes() {
      if (radioValue('hash-source') === 'file') {
        const file = fileInput.files && fileInput.files[0];
        if (!file) throw new Error('Choose a file to hash.');
        if (file.size > MAX_HASH_FILE_BYTES) throw new Error('Files over 512 MB are not supported in the browser.');
        return { bytes: new Uint8Array(await file.arrayBuffer()), label: file.name };
      }
      return { bytes: S.encoding.utf8Encode(input.value), label: null };
    }

    async function run() {
      setStatus(status, null, '');
      setStatus(compareResult, null, '');
      try {
        await withBusy(runButton, 'Hashing…', async () => {
          let digest, label, size;
          if (isChunkedMd5()) ({ digest, label, size } = await md5OfFile());
          else {
            const { bytes, label: l } = await getInputBytes();
            digest = await S.hash.hashBytes(alg.value, bytes); label = l; size = bytes.length;
          }
          renderHex(output, S.encoding.bytesToHex(digest));
          outputMeta.textContent = `${digest.length * 8} bits, ${digest.length * 2} hex characters`;
          if (label) setStatus(status, 'ok', `Hashed ${label} (${size.toLocaleString('en-US')} bytes).`);
        });
      } catch (err) {
        clearOutput(output);
        outputMeta.textContent = '';
        setStatus(status, 'error', messageOf(err));
      }
    }

    async function compare() {
      setStatus(compareResult, null, '');
      try {
        let r;
        if (isChunkedMd5()) { const f = await md5OfFile(); r = S.hash.compareToActual('MD5', f.digest, $('#hash-compare-input').value); }
        else { const { bytes } = await getInputBytes(); r = await S.hash.compareDigest(alg.value, bytes, $('#hash-compare-input').value); }
        renderHex(output, r.actualHex);
        outputMeta.textContent = `${r.algorithmBits} bits, ${r.algorithmBits / 4} hex characters`;
        if (r.match) {
          setStatus(compareResult, 'ok', `Match. The input produces this ${alg.value} hash.`);
        } else if (!r.lengthMatches) {
          const guess = r.likelyAlgorithms.length ? ` It looks like ${r.likelyAlgorithms.join(' or ')}; try selecting that algorithm.` : '';
          setStatus(compareResult, 'error', `No match. The expected hash is ${r.expectedBits} bits, but ${alg.value} produces ${r.algorithmBits} bits.${guess}`);
        } else {
          setStatus(compareResult, 'error', `No match. The input does not produce this ${alg.value} hash.`);
        }
      } catch (err) {
        setStatus(compareResult, 'error', messageOf(err));
      }
    }

    alg.addEventListener('change', () => {
      updateAlgorithmInfo();
      setStatus(compareResult, null, '');
      if (output.dataset.value) run(); // keep the visible hash in sync with the selection
    });
    $$('input[name="hash-source"]').forEach((r) => r.addEventListener('change', updateSource));
    input.addEventListener('input', () => { $('#hash-input-meta').textContent = countText(input.value); });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      $('#hash-file-meta').textContent = file
        ? `${file.name}, ${file.size.toLocaleString('en-US')} bytes. Read in this tab, never uploaded.`
        : 'The file is read in this tab and never uploaded.';
      clearOutput(output);
      outputMeta.textContent = '';
    });
    $$('[data-sample]').forEach((b) => b.addEventListener('click', () => {
      setRadio('hash-source', 'text');
      input.value = b.dataset.sample;
      input.dispatchEvent(new Event('input'));
      run();
    }));
    runButton.addEventListener('click', run);
    $('#hash-cancel').addEventListener('click', () => { if (hashAbort) hashAbort.abort(); });
    disposers.push(() => { if (hashAbort) hashAbort.abort(); });
    $('#hash-compare-run').addEventListener('click', compare);
    $('#hash-compare-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') compare(); });

    updateAlgorithmInfo();
  }

  // ================================================================ password hashing

  function setupPassword() {
    const alg = $('#pw-alg');
    const iterations = $('#pw-iterations');
    const salt = $('#pw-salt');
    const saltFormat = $('#pw-salt-format');
    const saltLength = $('#pw-salt-length');
    const length = $('#pw-length');
    const outEncoding = $('#pw-encoding');
    const output = $('#pw-output');
    const params = $('#pw-params');
    const phc = $('#pw-phc');
    const status = $('#pw-status');
    const runButton = $('#pw-run');
    const warning = $('#pw-param-warning');
    let lastResult = null;
    saltFormat.dataset.previous = saltFormat.value;

    function decodeSalt() {
      const value = salt.value;
      if (!value) return null;
      try {
        return S.encoding.decodeToBytes(saltFormat.value === 'utf8' ? value : value.trim(), saltFormat.value);
      } catch (_) {
        const name = { hex: 'hex', base64: 'Base64', utf8: 'text' }[saltFormat.value];
        throw new Error(`The salt is not valid ${name}. Change the salt format or generate a new salt.`);
      }
    }

    function updateWarning() {
      let saltBytes = null;
      try { const b = decodeSalt(); saltBytes = b ? b.length : null; } catch (_) { saltBytes = null; }
      const warnings = S.password.assessParams({
        hash: alg.value,
        iterations: Number(iterations.value),
        saltLength: saltBytes,
      });
      const slow = S.password.slowWarning(Number(iterations.value));
      if (slow) warnings.push(slow);
      warning.hidden = warnings.length === 0;
      warning.textContent = warnings.join(' ');
    }

    function generateSalt() {
      if (saltFormat.value === 'utf8') {
        saltFormat.value = 'hex';
        saltFormat.dataset.previous = 'hex';
      }
      salt.value = S.encoding.encodeBytes(S.generator.randomBytes(Number(saltLength.value)), saltFormat.value);
      updateWarning();
    }

    function render(result) {
      const encoded = S.encoding.encodeBytes(result.derived, outEncoding.value);
      if (outEncoding.value === 'hex') renderHex(output, encoded);
      else renderPlain(output, encoded);
      $('#pw-output-meta').textContent = `${result.derived.length} bytes, derived in ${Math.round(result.elapsedMs).toLocaleString('en-US')} ms`;

      const saltText = saltFormat.value === 'utf8' ? salt.value : S.encoding.encodeBytes(result.salt, saltFormat.value);
      const rows = [
        ['Algorithm', `PBKDF2-HMAC-${result.hash}`],
        ['Iterations', result.iterations.toLocaleString('en-US')],
        [`Salt (${saltFormat.options[saltFormat.selectedIndex].text.toLowerCase()})`, saltText],
        ['Salt length', `${result.salt.length} bytes`],
        ['Output length', `${result.length} bytes`],
      ];
      params.textContent = '';
      rows.forEach(([k, v]) => {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        params.append(dt, dd);
      });
      phc.value = result.encoded;
    }

    async function run() {
      setStatus(status, null, '');
      try {
        const password = $('#pw-password').value;
        if (!password) throw new Error('Enter a password to hash.');
        const iter = parseWholeNumber(iterations, 'Iterations');
        let saltBytes = decodeSalt();
        if (!saltBytes) {
          generateSalt();
          saltBytes = decodeSalt();
        }
        await withBusy(runButton, 'Hashing…', async () => {
          lastResult = await S.password.hashPassword(password, {
            hash: alg.value, iterations: iter, salt: saltBytes, length: Number(length.value),
          });
          render(lastResult);
        });
        const warnings = S.password.assessParams({ hash: alg.value, iterations: iter, saltLength: saltBytes.length });
        if (warnings.length) setStatus(status, 'warn', 'Hashed with weak settings. See the warning above.');
        else setStatus(status, 'ok', 'Hashed. Store the storage string; it contains the salt and parameters.');
      } catch (err) {
        setStatus(status, 'error', messageOf(err));
      }
    }

    alg.addEventListener('change', () => {
      const preset = S.password.PRESETS[alg.value];
      iterations.value = preset.recommendedIterations;
      length.value = String(preset.defaultLength);
      updateWarning();
    });
    iterations.addEventListener('input', () => { iterations.removeAttribute('aria-invalid'); updateWarning(); });
    salt.addEventListener('input', updateWarning);
    saltFormat.addEventListener('change', () => {
      // Convert an existing salt to the new format when possible.
      const previous = saltFormat.dataset.previous;
      if (salt.value && previous !== saltFormat.value) {
        try {
          const bytes = S.encoding.decodeToBytes(salt.value, previous);
          salt.value = saltFormat.value === 'utf8' ? S.encoding.utf8Decode(bytes) : S.encoding.encodeBytes(bytes, saltFormat.value);
        } catch (_) { /* leave as typed; validated on hash */ }
      }
      saltFormat.dataset.previous = saltFormat.value;
      updateWarning();
    });
    outEncoding.addEventListener('change', () => { if (lastResult && output.dataset.value) render(lastResult); });
    $('#pw-salt-generate').addEventListener('click', generateSalt);
    runButton.addEventListener('click', run);
    params.addEventListener('input', () => { lastResult = null; }); // fired by Clear

    $('#pw-export').addEventListener('click', () => {
      try {
        if (!lastResult || !output.dataset.value) throw new Error('Hash a password first.');
        const data = {
          algorithm: 'PBKDF2',
          hash: lastResult.hash,
          iterations: lastResult.iterations,
          salt: { encoding: 'base64', value: S.encoding.bytesToBase64(lastResult.salt) },
          derivedKey: { encoding: 'base64', value: S.encoding.bytesToBase64(lastResult.derived), length: lastResult.length },
          phc: lastResult.encoded,
        };
        downloadText(JSON.stringify(data, null, 2), 'password-hash.json', 'application/json');
      } catch (err) {
        setStatus(status, 'error', messageOf(err));
      }
    });

    const verifyButton = $('#pw-verify-run');
    const verifyResult = $('#pw-verify-result');
    verifyButton.addEventListener('click', async () => {
      setStatus(verifyResult, null, '');
      try {
        await withBusy(verifyButton, 'Checking…', async () => {
          const ok = await S.password.verifyPassword($('#pw-verify-password').value, $('#pw-verify-encoded').value);
          setStatus(verifyResult, ok ? 'ok' : 'error', ok ? 'Password matches.' : 'Password does not match.');
        });
      } catch (err) {
        setStatus(verifyResult, 'error', messageOf(err));
      }
    });

    updateWarning();
  }

  // ================================================================ encrypt / decrypt

  function setupEncrypt() {
    const input = $('#enc-input');
    const output = $('#enc-output');
    const status = $('#enc-status');
    const runButton = $('#enc-run');
    const keyInput = $('#enc-key');
    const iterations = $('#enc-iterations');
    const kdfHash = $('#enc-kdf-hash');
    const warning = $('#enc-param-warning');

    const isEncrypt = () => radioValue('enc-mode') === 'encrypt';
    const usesPassword = () => radioValue('enc-keysource') === 'password';

    function updateWarning() {
      const warnings = S.password.assessParams({ hash: kdfHash.value, iterations: Number(iterations.value), saltLength: null });
      const slow = S.password.slowWarning(Number(iterations.value));
      if (slow) warnings.push(slow);
      warning.hidden = !(isEncrypt() && usesPassword() && warnings.length);
      warning.textContent = warnings.join(' ');
    }

    function updateMode() {
      const encrypting = isEncrypt();
      $$('.encrypt-only', $('[data-panel="encrypt"]')).forEach((el) => { el.hidden = !encrypting; });
      $('#enc-input-label').textContent = encrypting ? 'Plain text' : 'Encrypted data (JSON)';
      $('#enc-output-label').textContent = encrypting ? 'Encrypted data' : 'Decrypted text';
      input.classList.toggle('mono', !encrypting);
      output.classList.toggle('mono', encrypting);
      input.placeholder = encrypting ? 'Text to encrypt' : 'Paste the JSON block produced by Encrypt';
      runButton.textContent = encrypting ? 'Encrypt' : 'Decrypt';
      $('#enc-download').dataset.filename = encrypting ? 'encrypted.json' : 'decrypted.txt';
      $('#enc-swap').textContent = encrypting ? 'Use as input and switch to Decrypt' : 'Use as input and switch to Encrypt';
      updateWarning();
    }

    function updateKeySource() {
      $('#enc-password-group').hidden = !usesPassword();
      $('#enc-key-group').hidden = usesPassword();
      updateWarning();
    }

    function updateKeyMeta() {
      const meta = $('#enc-key-meta');
      if (!keyInput.value.trim()) { meta.textContent = ''; return; }
      try {
        meta.textContent = `${S.encryption.parseKey(keyInput.value).length * 8}-bit key`;
        meta.classList.remove('is-error');
      } catch (_) {
        meta.textContent = 'Not a 128- or 256-bit key';
        meta.classList.add('is-error');
      }
    }

    async function run() {
      setStatus(status, null, '');
      try {
        if (isEncrypt()) {
          const options = {
            mode: usesPassword() ? 'password' : 'key',
            encoding: $('#enc-encoding').value,
            hash: kdfHash.value,
          };
          if (usesPassword()) {
            options.password = $('#enc-password').value;
            options.iterations = parseWholeNumber(iterations, 'Iterations');
          } else {
            options.keyBytes = S.encryption.parseKey(keyInput.value);
          }
          await withBusy(runButton, 'Encrypting…', async () => {
            const envelope = await S.encryption.encryptText(input.value, options);
            output.value = S.encryption.serializeEnvelope(envelope);
          });
          S.core.wipe(options.keyBytes);
          setStatus(status, 'ok', 'Encrypted with a new random IV. Keep your password or key: without it this data cannot be recovered.');
        } else {
          // Read the envelope first so the right credential field is shown.
          const { envelope } = S.encryption.parseEnvelope(input.value);
          const needed = envelope.mode;
          if ((needed === 'password') !== usesPassword()) {
            setRadio('enc-keysource', needed);
          }
          const credentials = {};
          if (needed === 'password') {
            credentials.password = $('#enc-password').value;
            if (!credentials.password) throw new Error('This data was encrypted with a password. Enter it, then decrypt again.');
          } else {
            if (!keyInput.value.trim()) throw new Error('This data was encrypted with a raw key. Enter the key, then decrypt again.');
            credentials.keyBytes = S.encryption.parseKey(keyInput.value);
          }
          await withBusy(runButton, 'Decrypting…', async () => {
            output.value = await S.encryption.decryptText(input.value, credentials);
          });
          S.core.wipe(credentials.keyBytes);
          setStatus(status, 'ok', 'Decrypted and verified: the data has not been modified.');
        }
      } catch (err) {
        output.value = '';
        setStatus(status, 'error', messageOf(err));
      }
    }

    $$('input[name="enc-mode"]').forEach((r) => r.addEventListener('change', () => {
      output.value = '';
      setStatus(status, null, '');
      updateMode();
    }));
    $$('input[name="enc-keysource"]').forEach((r) => r.addEventListener('change', updateKeySource));
    iterations.addEventListener('input', () => { iterations.removeAttribute('aria-invalid'); updateWarning(); });
    kdfHash.addEventListener('change', () => {
      iterations.value = S.password.PRESETS[kdfHash.value].recommendedIterations;
      updateWarning();
    });
    keyInput.addEventListener('input', updateKeyMeta);
    input.addEventListener('input', () => { $('#enc-input-meta').textContent = input.value ? countText(input.value) : ''; });

    $('#enc-key-generate').addEventListener('click', () => {
      const key = S.encryption.generateKey(256);
      keyInput.value = S.encoding.bytesToHex(key);
      S.core.wipe(key);
      keyInput.type = 'text';
      const toggle = $('[data-toggle-visibility="#enc-key"]');
      toggle.textContent = 'Hide';
      toggle.setAttribute('aria-pressed', 'true');
      updateKeyMeta();
      setStatus(status, 'warn', 'New key generated. Save it somewhere safe: data encrypted with it cannot be decrypted without it.');
    });

    $('#enc-swap').addEventListener('click', () => {
      if (!output.value) { setStatus(status, 'error', 'Nothing to move yet. Run Encrypt or Decrypt first.'); return; }
      const result = output.value;
      setRadio('enc-mode', isEncrypt() ? 'decrypt' : 'encrypt');
      input.value = result;
      input.dispatchEvent(new Event('input'));
      setStatus(status, null, '');
    });

    runButton.addEventListener('click', run);
    updateMode();
    updateKeySource();
  }

  // ================================================================ encrypt with key (CryptoJS-compatible)

  function setupKeyCipher() {
    const input = $('#kc-input');
    const output = $('#kc-output');
    const status = $('#kc-status');
    const runButton = $('#kc-run');
    const isEncrypt = () => radioValue('kc-mode') === 'encrypt';

    function updateMode() {
      const encrypting = isEncrypt();
      $('#kc-input-label').textContent = encrypting ? 'Plain text' : 'Encrypted text (Base64)';
      $('#kc-output-label').textContent = encrypting ? 'Encrypted text' : 'Decrypted text';
      input.classList.toggle('mono', !encrypting);
      output.classList.toggle('mono', encrypting);
      input.placeholder = encrypting ? 'Text to encrypt' : 'Paste text such as U2FsdGVkX1…';
      runButton.textContent = encrypting ? 'Encrypt' : 'Decrypt';
      $('#kc-download').dataset.filename = encrypting ? 'encrypted.txt' : 'decrypted.txt';
      $('#kc-swap').textContent = encrypting ? 'Use as input and switch to Decrypt' : 'Use as input and switch to Encrypt';
    }

    async function run() {
      setStatus(status, null, '');
      try {
        const key = $('#kc-key').value;
        const encrypting = isEncrypt();
        await withBusy(runButton, encrypting ? 'Encrypting…' : 'Decrypting…', async () => {
          output.value = encrypting
            ? await S.keycipher.encryptWithKey(input.value, key)
            : await S.keycipher.decryptWithKey(input.value, key);
        });
        setStatus(status, 'ok', encrypting
          ? 'Encrypted with a new random salt. Keep your key: without it this text cannot be recovered.'
          : 'Decrypted. This format cannot prove the text is unmodified, so check the result.');
      } catch (err) {
        output.value = '';
        setStatus(status, 'error', messageOf(err));
      }
    }

    $$('input[name="kc-mode"]').forEach((r) => r.addEventListener('change', () => {
      output.value = '';
      setStatus(status, null, '');
      updateMode();
    }));
    input.addEventListener('input', () => { $('#kc-input-meta').textContent = input.value ? countText(input.value) : ''; });
    $('#kc-swap').addEventListener('click', () => {
      if (!output.value) { setStatus(status, 'error', 'Nothing to move yet. Run Encrypt or Decrypt first.'); return; }
      const result = output.value;
      setRadio('kc-mode', isEncrypt() ? 'decrypt' : 'encrypt');
      input.value = result;
      input.dispatchEvent(new Event('input'));
      setStatus(status, null, '');
    });
    runButton.addEventListener('click', run);
    updateMode();
  }

  // ================================================================ generator

  function setupGenerator() {
    const type = $('#gen-type');
    const lengthInput = $('#gen-length');
    const lengthSelect = $('#gen-length-select');
    const count = $('#gen-count');
    const output = $('#gen-output');
    const status = $('#gen-status');

    function updateType() {
      const def = S.generator.TYPES[type.value];
      const fixed = !!def.fixed;
      $('#gen-length-group').hidden = fixed;
      $('#gen-length-select-group').hidden = !fixed;
      if (fixed) {
        lengthSelect.textContent = '';
        def.fixed.forEach((n) => {
          const opt = document.createElement('option');
          opt.value = String(n);
          opt.textContent = def.unit === 'bits' ? `${n} bits (${n / 8} bytes)` : `${n} bytes (${n * 8} bits)`;
          lengthSelect.appendChild(opt);
        });
        lengthSelect.value = String(def.defaultLength);
        $('#gen-length-hint').textContent = '';
      } else {
        lengthInput.min = def.min;
        lengthInput.max = def.max;
        lengthInput.value = def.defaultLength;
        $('#gen-length-label').textContent = `Length (${def.unit})`;
        $('#gen-length-hint').textContent = `Between ${def.min} and ${def.max.toLocaleString('en-US')} ${def.unit}.`;
      }
      $('#gen-encoding-group').hidden = !def.encodings;
      $('#gen-symbols-group').hidden = type.value !== 'password';
      $('#gen-note-title').textContent = def.label;
      $('#gen-note').textContent = def.note;
    }

    function run() {
      setStatus(status, null, '');
      try {
        const def = S.generator.TYPES[type.value];
        const length = def.fixed ? Number(lengthSelect.value) : parseWholeNumber(lengthInput, 'Length');
        const n = parseWholeNumber(count, 'Count');
        const { values, entropyBits } = S.generator.generate(type.value, {
          length, count: n, encoding: $('#gen-encoding').value, symbols: $('#gen-symbols').checked,
        });
        output.value = values.join('\n');
        $('#gen-output-meta').textContent = `${Math.floor(entropyBits).toLocaleString('en-US')} bits of randomness each`;
        if (type.value === 'salt' && length < 16) setStatus(status, 'warn', 'Salts shorter than 16 bytes are not recommended.');
        else if (type.value === 'password' && entropyBits < 80) setStatus(status, 'warn', 'Under 80 bits of randomness. Use a longer password for anything important.');
      } catch (err) {
        setStatus(status, 'error', messageOf(err));
      }
    }

    type.addEventListener('change', () => { updateType(); output.value = ''; $('#gen-output-meta').textContent = ''; setStatus(status, null, ''); });
    lengthInput.addEventListener('input', () => lengthInput.removeAttribute('aria-invalid'));
    count.addEventListener('input', () => count.removeAttribute('aria-invalid'));
    $('#gen-run').addEventListener('click', run);
    output.addEventListener('input', () => { if (!output.value) $('#gen-output-meta').textContent = ''; });
    updateType();
  }

  // ================================================================ encode / decode

  function setupEncode() {
    const format = $('#code-format');
    const input = $('#code-input');
    const output = $('#code-output');
    const status = $('#code-status');

    const NAMES = {
      base64: 'Base64', base64url: 'Base64URL', hex: 'Hex', url: 'URL-encoded', binary: 'Binary', bytes: 'Byte values',
    };
    const NOTES = {
      base64: 'Represents bytes with 64 printable characters (A–Z, a–z, 0–9, + and /), padded with =. Output is about a third larger than the input.',
      base64url: 'Base64 with - and _ instead of + and /, and no padding, so it is safe in URLs and file names. Decoding also accepts standard Base64.',
      hex: 'Each byte becomes two characters from 0–9 and a–f. Decoding ignores spaces, colons and a leading 0x.',
      url: 'Percent-encodes every character except A–Z, a–z, 0–9 and - _ . ! ~ * \' ( ), like encodeURIComponent. A + is not treated as a space when decoding.',
      binary: 'Each UTF-8 byte is written as eight bits, separated by spaces. Decoding ignores whitespace.',
      bytes: 'Lists each UTF-8 byte as a decimal number from 0 to 255, separated by spaces. Useful for seeing how characters are stored.',
    };

    const direction = () => radioValue('code-direction');

    function updateLabels() {
      const name = NAMES[format.value];
      const encoding = direction() === 'encode';
      $('#code-input-label').textContent = encoding ? 'Text' : name;
      $('#code-output-label').textContent = encoding ? name : 'Text';
      input.classList.toggle('mono', !encoding);
      output.classList.toggle('mono', encoding);
      $('#code-run').textContent = encoding ? 'Encode' : 'Decode';
      $('#code-note-title').textContent = format.options[format.selectedIndex].text;
      $('#code-note').textContent = NOTES[format.value];
    }

    function run({ quiet = false } = {}) {
      try {
        output.value = S.encoding.transformText(format.value, direction(), input.value);
        setStatus(status, null, '');
      } catch (err) {
        output.value = '';
        setStatus(status, quiet ? 'warn' : 'error', messageOf(err));
      }
    }

    function liveRun() {
      $('#code-input-meta').textContent = input.value ? countText(input.value) : '';
      if (input.value.length <= LIVE_ENCODE_LIMIT) run({ quiet: true });
    }

    format.addEventListener('change', () => { updateLabels(); liveRun(); });
    $$('input[name="code-direction"]').forEach((r) => r.addEventListener('change', () => { updateLabels(); liveRun(); }));
    input.addEventListener('input', liveRun);
    $('#code-run').addEventListener('click', () => run());
    $('#code-swap').addEventListener('click', () => {
      const previousOutput = output.value;
      setRadio('code-direction', direction() === 'encode' ? 'decode' : 'encode');
      input.value = previousOutput;
      input.dispatchEvent(new Event('input'));
    });
    updateLabels();
  }

  // ================================================================ environment & tabs

  const webCryptoReady = !!(window.isSecureContext && window.crypto && window.crypto.subtle);

  function setupEnvironment() {
    if (webCryptoReady) return;
    $('#sb-insecure-banner').hidden = false;
    ['#pw-run', '#pw-verify-run', '#enc-run', '#kc-run'].forEach((sel) => { $(sel).disabled = true; });
  }

  function setupTabs() {
    const tabs = $$('[data-tab]');
    const panels = $$('[data-panel]');
    const uid = Math.random().toString(36).slice(2, 7);
    tabs.forEach((t) => { t.id = t.id || `sb-tab-${uid}-${t.dataset.tab}`; });
    panels.forEach((p) => {
      const t = tabs.find((x) => x.dataset.tab === p.dataset.panel);
      p.setAttribute('role', 'tabpanel');
      p.id = p.id || `sb-panel-${uid}-${p.dataset.panel}`;
      if (t) { p.setAttribute('aria-labelledby', t.id); t.setAttribute('aria-controls', p.id); }
    });
    function activate(tab, focus) {
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      if (focus) tab.focus();
    }
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => activate(tab, false));
      tab.addEventListener('keydown', (e) => {
        let target = null;
        if (e.key === 'ArrowRight') target = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') target = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') target = tabs[0];
        else if (e.key === 'End') target = tabs[tabs.length - 1];
        if (target) { e.preventDefault(); activate(target, true); }
      });
    });
    activate(tabs[0], false);
  }

  setupEnvironment();
  setupTabs();
  setupUtilities();
  setupHash();
  setupPassword();
  setupEncrypt();
  setupKeyCipher();
  setupGenerator();
  setupEncode();
  return () => disposers.forEach((d) => d());
  },
};
