import { copyText, downloadFile, pickFile, readFileAsText, confirmDialog, toast, bindActions, renderIcons } from '../../assets/js/components/ui.js';
import { textStats, formatDuration, applyTransform, suggestFileName } from './logic.js';

export default {
  mount(root, ctx) {
    const $ = id => root.querySelector('#' + id);
    const wrap = $('tp-wrap'), area = $('tp-area');
    const prefs = ctx.storage.get('prefs', {}) || {};
    let focus = false, saveTimer = 0;

    area.value = String(ctx.storage.get('text', '') ?? '');
    $('tp-font').value = ['sans', 'serif', 'mono'].includes(prefs.font) ? prefs.font : 'sans';
    $('tp-size').value = [...$('tp-size').options].some(o => o.value === String(prefs.size)) ? String(prefs.size) : '18';
    $('tp-narrow').checked = !!prefs.narrow;
    $('tp-spell').checked = prefs.spell !== false;

    const applyPrefs = () => {
      wrap.dataset.font = $('tp-font').value;
      area.style.fontSize = $('tp-size').value + 'px';
      wrap.classList.toggle('tp-narrow', $('tp-narrow').checked);
      area.spellcheck = $('tp-spell').checked;
    };
    const savePrefs = () => {
      applyPrefs();
      ctx.storage.set('prefs', { bar: !wrap.classList.contains('tp-bar-hidden'), font: $('tp-font').value, size: $('tp-size').value, narrow: $('tp-narrow').checked, spell: $('tp-spell').checked });
    };
    ['tp-font', 'tp-size', 'tp-narrow', 'tp-spell'].forEach(id => $(id).addEventListener('change', savePrefs));
    applyPrefs();

    const stats = () => {
      const s = textStats(area.value);
      const n = (v, w) => `${v.toLocaleString()} ${w}${v === 1 ? '' : 's'}`;
      $('tp-s-words').textContent = n(s.words, 'word');
      $('tp-s-chars').textContent = n(s.chars, 'character');
      $('tp-s-lines').textContent = n(s.lines, 'line');
      $('tp-s-read').textContent = `${formatDuration(s.readMinutes)} read`;
    };
    const saveNow = () => {
      clearTimeout(saveTimer); saveTimer = 0;
      const ok = ctx.storage.set('text', area.value);
      $('tp-saved').textContent = ok ? 'Saved locally' : 'Could not save (browser storage is full or blocked)';
    };
    area.addEventListener('input', () => {
      stats(); $('tp-saved').textContent = 'Saving…';
      clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400);
    });
    // Flush a pending save when leaving the tool.
    ctx.onCleanup(() => { if (saveTimer) saveNow(); });

    // Replace the range [a, b) with `text`, keeping the browser's native undo stack when possible.
    const replaceRange = (a, b, text) => {
      area.focus(); area.setSelectionRange(a, b);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch { /* unsupported */ }
      if (!ok) { area.setRangeText(text, a, b, 'end'); area.dispatchEvent(new Event('input', { bubbles: true })); }
    };

    $('tp-transform').addEventListener('change', e => {
      const name = e.target.value; e.target.value = '';
      if (!name) return;
      const a = area.selectionStart, b = area.selectionEnd;
      const r = applyTransform(name, area.value, a, b);
      if (r.text === area.value) return;
      if (a === b) replaceRange(0, area.value.length, r.text);
      else { replaceRange(a, b, r.text.slice(a, r.selEnd)); area.setSelectionRange(r.selStart, r.selEnd); }
    });

    const setBar = open => {
      wrap.classList.toggle('tp-bar-hidden', !open);
      const t = $('tp-toggle');
      t.setAttribute('aria-expanded', String(open));
      t.innerHTML = `<i data-lucide="${open ? 'chevron-up' : 'chevron-down'}"></i> <span>${open ? 'Hide toolbar' : 'Show toolbar'}</span>`;
      renderIcons(t);
    };
    setBar(prefs.bar !== false);

    const setFocus = on => {
      focus = on;
      wrap.classList.toggle('tp-focus', on);
      const btn = root.querySelector('[data-action="focus"]');
      btn.setAttribute('aria-pressed', String(on));
      btn.innerHTML = `<i data-lucide="${on ? 'minimize' : 'maximize'}"></i> ${on ? 'Exit focus' : 'Focus mode'}`;
      renderIcons(btn); area.focus();
    };
    const onKey = e => { if (e.key === 'Escape' && focus) setFocus(false); };
    document.addEventListener('keydown', onKey);
    ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

    bindActions(root, {
      copy: () => area.value ? copyText(area.value, 'Text copied') : toast('Nothing to copy', 'info'),
      download: () => area.value ? downloadFile(suggestFileName(area.value), area.value) : toast('Nothing to download', 'info'),
      open: async () => {
        const f = await pickFile('.txt,.md,.text,.log,.csv,.json,text/*'); if (!f) return;
        const text = await readFileAsText(f);
        if (area.value && !(await confirmDialog('Replace text?', 'Opening a file replaces the current text. You can undo with Ctrl+Z.', 'Replace'))) return;
        replaceRange(0, area.value.length, text);
      },
      clear: async () => {
        if (!area.value) return;
        if (await confirmDialog('Clear text?', 'This removes all text from the pad. You can undo with Ctrl+Z until you leave this page.', 'Clear')) replaceRange(0, area.value.length, '');
      },
      focus: () => setFocus(!focus),
      'toggle-bar': () => { setBar(wrap.classList.contains('tp-bar-hidden')); savePrefs(); },
    });

    stats(); renderIcons(root);
    return () => {};
  },
};
