import { copyText, downloadFile, toast, showMessage, bindActions, pickFile, enableDrop, readFileAsText, debounce, escapeHtml, formatBytes } from '../../assets/js/components/ui.js';
import { computeDiff, buildRows, toUnifiedText } from './logic.js';

const MAX_FILE = 5 * 1024 * 1024;

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const a = $('#df-a'), b = $('#df-b'), out = $('#df-output'), msg = $('#df-msg');
    const optWs = $('#df-ws'), optCase = $('#df-case'), optAuto = $('#df-auto');
    const names = { a: 'original', b: 'modified' };
    let view = ctx.storage.get('view', 'side');
    let current = null; // last diff result

    const opts = () => ({ ignoreWhitespace: optWs.checked, ignoreCase: optCase.checked });

    // ---------- rendering ----------
    const segHtml = (text, segs) => {
      if (!segs) return escapeHtml(text);
      return segs.map(s => s.changed ? `<span class="w">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)).join('');
    };
    const sideHtml = rows => `<table class="df side"><colgroup><col style="width:46px"><col><col style="width:46px"><col></colgroup><tbody>${rows.map(r => {
      // Left and right cells are styled independently so a paired change shows red | green.
      const left = r.left ? `<td class="no">${r.left.no}</td><td class="txt ${r.left.type === '-' ? 'del-c' : ''}">${segHtml(r.left.text, r.left.segs)}</td>` : '<td class="no"></td><td class="txt empty-cell"></td>';
      const right = r.right ? `<td class="no">${r.right.no}</td><td class="txt ${r.right.type === '+' ? 'add-c' : ''}">${segHtml(r.right.text, r.right.segs)}</td>` : '<td class="no"></td><td class="txt empty-cell"></td>';
      return `<tr>${left}${right}</tr>`;
    }).join('')}</tbody></table>`;

    const unifiedHtml = rows => `<table class="df uni"><colgroup><col style="width:46px"><col style="width:46px"><col style="width:18px"><col></colgroup><tbody>${rows.map(r => {
      const cls = r.type === '+' ? 'add' : r.type === '-' ? 'del' : '';
      const eof = r.noEol ? ' <span class="eof">⏎ no newline at end of file</span>' : '';
      return `<tr class="${cls}"><td class="no">${r.aNo ?? ''}</td><td class="no">${r.bNo ?? ''}</td><td class="sign">${r.type === '=' ? '' : r.type}</td><td class="txt">${segHtml(r.text, r.segs)}${eof}</td></tr>`;
    }).join('')}</tbody></table>`;

    function render() {
      root.querySelectorAll('[data-view]').forEach(c => c.classList.toggle('active', c.dataset.view === view));
      if (!current) return;
      if (current.identical) {
        out.innerHTML = '<div class="empty"><p>The two texts are identical' + (opts().ignoreWhitespace || opts().ignoreCase ? ' (with the selected options).' : '.') + '</p></div>';
        return;
      }
      const rows = buildRows(current.ops, opts());
      out.innerHTML = view === 'side' ? sideHtml(rows.side) : unifiedHtml(rows.unified);
    }

    // ---------- compare ----------
    function compare() {
      showMessage(msg, null);
      $('#df-a-count').textContent = counts(a.value);
      $('#df-b-count').textContent = counts(b.value);
      if (!a.value && !b.value) {
        current = null; setStats(0, 0);
        out.innerHTML = '<div class="empty">Enter text on both sides to see the differences.</div>';
        return;
      }
      current = computeDiff(a.value, b.value, opts());
      setStats(current.stats.added, current.stats.removed);
      if (current.approximate) showMessage(msg, 'info', 'The texts are very different, so the result is a simplified (replace-all) diff rather than a minimal one.');
      render();
    }
    const counts = t => t ? `${t.split(/\r\n|\r|\n/).length} lines · ${formatBytes(new Blob([t]).size)}` : '';
    const setStats = (add, rem) => { $('#df-added').textContent = `+${add}`; $('#df-removed').textContent = `−${rem}`; };
    const auto = debounce(() => { if (optAuto.checked) compare(); else { $('#df-a-count').textContent = counts(a.value); $('#df-b-count').textContent = counts(b.value); } }, 300);

    // ---------- files ----------
    async function loadInto(side, file) {
      if (!file) return;
      if (file.size > MAX_FILE) return showMessage(msg, 'error', `"${file.name}" is larger than 5 MB.`);
      try {
        const text = await readFileAsText(file);
        if (text.includes('\u0000')) return showMessage(msg, 'error', `"${file.name}" looks like a binary file, not text.`);
        (side === 'a' ? a : b).value = text; names[side] = file.name;
        showMessage(msg, null); compare();
      } catch (e) { showMessage(msg, 'error', `Could not read file: ${e.message}`); }
    }

    // ---------- actions ----------
    const unifiedText = () => {
      if (!current) return '';
      if (current.identical) return '';
      return toUnifiedText(current.ops, { aName: names.a, bName: names.b });
    };
    bindActions(root, {
      compare,
      swap: () => { [a.value, b.value] = [b.value, a.value]; [names.a, names.b] = [names.b, names.a]; compare(); },
      clear: () => { a.value = b.value = ''; names.a = 'original'; names.b = 'modified'; showMessage(msg, null); compare(); },
      'upload-a': async () => loadInto('a', await pickFile()),
      'upload-b': async () => loadInto('b', await pickFile()),
      copy: () => {
        if (!current) return toast('Nothing to copy — compare some text first', 'warn');
        if (current.identical) return toast('The texts are identical — no diff to copy', 'info');
        copyText(unifiedText(), 'Unified diff copied');
      },
      download: () => {
        if (!current) return toast('Nothing to download — compare some text first', 'warn');
        if (current.identical) return toast('The texts are identical — no diff to download', 'info');
        downloadFile('changes.diff', unifiedText());
      },
    });
    root.querySelectorAll('[data-view]').forEach(c => c.addEventListener('click', () => { view = c.dataset.view; ctx.storage.set('view', view); render(); }));
    [a, b].forEach(t => t.addEventListener('input', auto));
    [optWs, optCase].forEach(o => o.addEventListener('change', compare));
    optAuto.addEventListener('change', () => { if (optAuto.checked) compare(); });
    const drops = [enableDrop(a, f => loadInto('a', f)), enableDrop(b, f => loadInto('b', f))];

    render();
    return () => drops.forEach(d => d());
  },
};
