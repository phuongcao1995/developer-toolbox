import { copyText, toast, showMessage, bindActions, debounce, el } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const input = q('input'), msg = q('msg'), result = q('result'), timesBody = q('times');
    let decoded = null;   // last decoded token
    let relCells = [];    // [{cell, item}] live-updated

    const STATE_CLASS = { expired: 'badge-danger', valid: 'badge-success', none: '', notyet: 'badge-warn' };

    /** Update status badge + relative-time cells from the current clock (called every second). */
    function tick() {
      if (!decoded?.payload?.ok) return;
      const ev = L.evaluateTimes(decoded.payload.value, Date.now() / 1000);
      const badge = q('state');
      badge.className = `badge jwt-state ${STATE_CLASS[ev.state]}`;
      badge.textContent = ev.label;
      const exp = ev.items.find(i => i.claim === 'exp');
      q('statetext').textContent = exp?.valid ? exp.relative : ev.state === 'notyet' ? ev.items.find(i => i.claim === 'nbf')?.relative || '' : '';
      ev.items.forEach((it, i) => { if (relCells[i] && it.valid) relCells[i].textContent = it.relative; });
    }

    function render() {
      const token = input.value;
      decoded = L.decodeJwt(token);
      relCells = [];
      if (decoded.empty) { result.hidden = true; showMessage(msg, null); return; }
      if (decoded.errors.length) showMessage(msg, decoded.header?.ok || decoded.payload?.ok ? 'warn' : 'error', decoded.errors.join('\n'));
      else showMessage(msg, null);
      const h = decoded.header, p = decoded.payload;
      if (!h && !p) { result.hidden = true; return; }
      result.hidden = false;
      q('header').textContent = h?.ok ? h.json : `(could not decode)\n${h?.error || ''}${h?.raw ? '\n\nRaw: ' + h.raw : ''}`;
      q('payload').textContent = p?.ok ? p.json : `(could not decode)\n${p?.error || ''}${p?.raw ? '\n\nRaw: ' + p.raw : ''}`;
      q('alg').textContent = decoded.alg || '—';
      q('sig').textContent = decoded.signature || '(empty — unsecured token, "alg": "none")';

      // Time-claim table (built with DOM nodes; claim values may be arbitrary).
      timesBody.replaceChildren();
      const ev = p?.ok ? L.evaluateTimes(p.value, Date.now() / 1000) : { items: [] };
      q('timespanel').hidden = !ev.items.length;
      for (const it of ev.items) {
        if (!it.valid) { timesBody.append(el('tr', {}, el('td', {}, it.claim), el('td', { class: 'bad', colspan: 3 }, it.error))); relCells.push(null); continue; }
        const rel = el('td', { class: 'rel' }, it.relative);
        relCells.push(rel);
        timesBody.append(el('tr', {}, el('td', {}, it.claim), el('td', {}, it.utc), el('td', {}, it.local), rel));
      }
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
    });

    const timer = setInterval(tick, 1000); // keep expiry status live
    render();
    return () => clearInterval(timer);
  },
};
