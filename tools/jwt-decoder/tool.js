import { copyText, toast, showMessage, bindActions, debounce, el } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import { verifyJwt, checkClaims, algFamily, FAMILY_NEEDS, CLAIMS_DISCLAIMER } from './verify.js';

const TIME_CLAIMS = new Set(['exp', 'iat', 'nbf', 'auth_time']);
const SEV_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' };
const SEV_CLASS = { critical: 'alert-error', warning: 'alert-warn', info: 'alert-info' };

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const input = q('input'), msg = q('msg'), result = q('result'), claimsBody = q('times'), hdrBody = q('hdrclaims');
    let decoded = null;   // last decoded token
    let relCells = [];    // [{cell, claim}] live-updated

    const STATE_CLASS = { expired: 'badge-danger', soon: 'badge-warn', valid: 'badge-success', none: '', notyet: 'badge-warn', invalid: 'badge-warn' };
    const val = v => { let s; try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); } return s.length > 300 ? s.slice(0, 300) + '…' : s; };

    /** Update status badge, countdown and relative-time cells from the current clock (called every second). */
    function tick() {
      if (!decoded?.payload?.ok) return;
      const ev = L.evaluateTimes(decoded.payload.value, Date.now() / 1000);
      const badge = q('state');
      badge.className = `badge jwt-state ${STATE_CLASS[ev.state] ?? ''}`;
      badge.textContent = ev.label;
      const exp = ev.items.find(i => i.claim === 'exp');
      const nbf = ev.items.find(i => i.claim === 'nbf');
      let text = '';
      if (ev.state === 'notyet' && nbf?.valid) text = `valid from ${L.formatCountdown(nbf.delta)} from now`;
      else if (exp?.valid) text = exp.delta > 0 ? `expires in ${L.formatCountdown(exp.delta)}` : `expired ${L.formatDuration(exp.delta)} ago`;
      q('statetext').textContent = text;
      relCells.forEach(({ cell, claim }) => { const it = ev.items.find(i => i.claim === claim); if (it?.valid) cell.textContent = it.relative; });
    }

    function renderWarnings(h, p) {
      const box = q('warnings');
      box.replaceChildren();
      const list = L.securityWarnings(h?.ok ? h.value : null, p?.ok ? p.value : null, decoded.signature, Date.now() / 1000);
      if (decoded.whitespaceStripped) list.push({ severity: 'warning', message: 'Whitespace or line breaks inside the pasted token were removed before decoding. A real token never contains them - check that it was copied correctly.' });
      const order = { critical: 0, warning: 1, info: 2 };
      list.sort((a, b) => order[a.severity] - order[b.severity]);
      box.hidden = !list.length;
      for (const w of list) {
        box.append(el('li', { class: `alert ${SEV_CLASS[w.severity]} jwt-warn` }, el('strong', {}, SEV_LABEL[w.severity] + ': '), w.message));
      }
    }

    function renderClaims(body, obj, withTimes) {
      body.replaceChildren();
      const entries = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj) : [];
      const evItems = withTimes ? L.evaluateTimes(obj, Date.now() / 1000).items : [];
      for (const [k, v] of entries) {
        const desc = L.claimDescription(k);
        const it = withTimes && TIME_CLAIMS.has(k) ? evItems.find(i => i.claim === k) : null;
        let valueCell;
        if (it?.valid) {
          const rel = el('span', { class: 'rel' }, it.relative);
          relCells.push({ cell: rel, claim: k });
          valueCell = el('td', { class: 'mono-cell' }, el('div', {}, it.utc), el('div', { class: 'faint' }, it.local), rel);
        } else if (it) valueCell = el('td', { class: 'bad' }, it.error);
        else valueCell = el('td', { class: 'mono-cell' }, val(v));
        body.append(el('tr', {}, el('td', { class: 'claim-name' }, k), valueCell, el('td', { class: 'claim-desc' }, desc || '—')));
      }
      return entries.length;
    }

    // ---------- verify signature (keys live only in this textarea; nothing is persisted) ----------
    const keyBox = q('verify-key'), keyEnc = q('verify-enc'), vRes = q('verify-result'), vDisc = q('verify-disclaimer');
    const SECRET_CLEAR = () => { keyBox.value = ''; };
    let verifyRun = 0;
    function resetVerify() {
      verifyRun++; vRes.hidden = true; vRes.textContent = ''; vDisc.hidden = true;
      const badge = q('verified'); badge.className = 'badge badge-danger jwt-unverified'; badge.textContent = 'Signature NOT verified';
      const claimsRes = q('claims-result'); claimsRes.hidden = true; claimsRes.replaceChildren();
      const fam = algFamily(decoded?.alg);
      keyEnc.closest('.field').hidden = fam !== 'HS';
      q('verify-need').textContent = decoded?.alg
        ? `This token uses ${decoded.alg}: it needs ${FAMILY_NEEDS[fam] || 'a key of a supported type (unsupported algorithm)'}.` + (decoded.alg.toLowerCase() === 'none' ? ' alg "none" is never valid.' : '')
        : '';
    }
    async function runVerify() {
      if (!decoded || decoded.empty) return;
      const id = ++verifyRun;
      vRes.hidden = false; vRes.className = 'alert alert-info'; vRes.textContent = 'Verifying…';
      const r = await verifyJwt(decoded.token, { text: keyBox.value, secretEncoding: keyEnc.value });
      if (id !== verifyRun) return; // token changed meanwhile
      const label = r.status === 'valid' ? 'Signature valid' : r.status === 'invalid' ? 'Signature invalid' : 'Could not verify';
      vRes.className = `alert ${r.status === 'valid' ? 'alert-success' : r.status === 'invalid' ? 'alert-error' : 'alert-warn'}`;
      vRes.replaceChildren(el('strong', {}, label + ': '), r.reason, ...(r.warnings || []).flatMap(w => [el('br'), 'Note: ' + w]));
      vDisc.hidden = false; vDisc.textContent = CLAIMS_DISCLAIMER;
      const badge = q('verified');
      if (r.status === 'valid') { badge.className = 'badge badge-success jwt-unverified'; badge.textContent = 'Signature valid (claims not validated)'; }
      else { badge.className = 'badge badge-danger jwt-unverified'; badge.textContent = r.status === 'invalid' ? 'Signature INVALID' : 'Signature NOT verified'; }
    }
    function runClaims() {
      const box = q('claims-result'); box.replaceChildren(); box.hidden = false;
      if (!decoded?.payload?.ok) { box.append(el('li', { class: 'alert alert-warn jwt-warn' }, 'The payload could not be decoded, so there are no claims to check.')); return; }
      const r = checkClaims(decoded.payload.value, Date.now() / 1000, { iss: q('claims-iss').value, aud: q('claims-aud').value });
      for (const it of r.items) {
        box.append(el('li', { class: `alert ${it.status === 'ok' ? 'alert-success' : it.status === 'fail' ? 'alert-error' : 'alert-info'} jwt-warn` },
          el('strong', {}, `${it.claim}: ${it.status === 'ok' ? 'OK' : it.status === 'fail' ? 'FAILED' : 'not checked'}. `), it.message));
      }
    }

    function render() {
      const prevToken = decoded?.token;
      decoded = L.decodeJwt(input.value);
      if (decoded.token !== prevToken) resetVerify();
      relCells = [];
      if (decoded.empty) { result.hidden = true; showMessage(msg, null); return; }
      if (decoded.errors.length) showMessage(msg, decoded.header?.ok || decoded.payload?.ok ? 'warn' : 'error', decoded.errors.join('\n'));
      else showMessage(msg, null);
      const h = decoded.header, p = decoded.payload;
      if (!h && !p) { result.hidden = true; return; }
      result.hidden = false;
      q('header').textContent = h?.ok ? h.json : `(could not decode)\n${h?.error || ''}${h?.raw ? '\n\nRaw: ' + h.raw : ''}`;
      q('payload').textContent = p?.ok ? p.json : `(could not decode)\n${p?.error || ''}${p?.raw ? '\n\nRaw: ' + p.raw : ''}`;
      const algVal = h?.ok && h.value && typeof h.value === 'object' ? h.value.alg : undefined;
      q('alg').textContent = decoded.alg || (algVal !== undefined ? `invalid (${val(algVal)})` : '—');
      q('sig').textContent = decoded.signature || '(empty — unsecured token, "alg": "none")';

      renderWarnings(h, p);
      const hn = h?.ok ? renderClaims(hdrBody, h.value, false) : 0;
      q('hdrpanel').hidden = !hn;
      const pn = p?.ok ? renderClaims(claimsBody, p.value, true) : 0;
      q('timespanel').hidden = !pn;
      if (!p?.ok) { const b = q('state'); b.className = 'badge jwt-state'; b.textContent = 'Payload unreadable'; q('statetext').textContent = ''; }
      else tick();
    }

    const renderSoon = debounce(render, 120);
    input.addEventListener('input', renderSoon);

    bindActions(root, {
      sample() { input.value = L.sampleToken(); render(); },
      clear() { input.value = ''; render(); input.focus(); },
      async paste() {
        try { input.value = await navigator.clipboard.readText(); render(); }
        catch { toast('Clipboard access was blocked — paste with Ctrl+V instead', 'warn'); input.focus(); }
      },
      'copy-header'() { if (decoded?.header?.ok) copyText(decoded.header.json, 'Header copied'); else toast('No decoded header', 'warn'); },
      'copy-payload'() { if (decoded?.payload?.ok) copyText(decoded.payload.json, 'Payload copied'); else toast('No decoded payload', 'warn'); },
      'copy-sig'() { copyText(decoded?.signature || '', 'Signature copied'); },
      verify: runVerify,
      'verify-clear'() { SECRET_CLEAR(); resetVerify(); },
      'claims-check': runClaims,
    });

    const timer = setInterval(tick, 1000); // keep expiry countdown live
    // Secrets are wiped when the page is hidden/unloaded or the tool is closed.
    const wipe = () => { SECRET_CLEAR(); };
    window.addEventListener('pagehide', wipe);
    const stop = () => { clearInterval(timer); window.removeEventListener('pagehide', wipe); wipe(); };
    ctx.onCleanup?.(stop);
    render();
    return stop; // idempotent; harmless if the shell also runs onCleanup
  },
};
