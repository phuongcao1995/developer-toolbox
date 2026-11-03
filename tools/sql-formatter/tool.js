// SQL Formatter UI. All formatting logic is in logic.js (own tokenizer + layout engine, no CDN).
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, enableTabIndent, formatBytes, renderIcons } from '../../assets/js/components/ui.js';
import { formatSql, minifySql, sqlStats } from './logic.js';
import { EXAMPLES } from './examples.js';

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      indent: $('#sf-indent'), kcase: $('#sf-case'), example: $('#sf-example'), input: $('#sf-input'), output: $('#sf-output'),
      msg: $('#sf-msg'), stats: $('#sf-stats'),
    };
    els.indent.value = ctx.indentUnit === '\t' ? 'tab' : ctx.indentUnit.length === 4 ? '4' : '2';
    els.kcase.value = ctx.storage.get('case', 'upper');
    els.input.style.fontSize = els.output.style.fontSize = `${ctx.fontSize}px`;
    enableTabIndent(els.input, ctx.indentUnit);
    for (const ex of EXAMPLES) els.example.append(new Option(ex.label, ex.id));

    const indentUnit = () => (els.indent.value === 'tab' ? '\t' : ' '.repeat(Number(els.indent.value)));
    const clearResult = () => { els.output.value = ''; els.stats.replaceChildren(); };
    const setStats = (label, before, after) => {
      els.stats.replaceChildren();
      const st = sqlStats(after);
      const items = [[label, 'badge badge-info'], [`${st.statements} statement${st.statements === 1 ? '' : 's'}`, 'badge'], [`${st.lines} lines`, 'badge'],
        [`${formatBytes(before.length)} → ${formatBytes(after.length)}`, 'badge']];
      for (const [text, cls] of items) { const b = document.createElement('span'); b.className = cls; b.textContent = text; els.stats.append(b); }
    };

    function run(mode) {
      const sql = els.input.value;
      showMessage(els.msg, null);
      if (!sql.trim()) { showMessage(els.msg, 'warn', 'Enter or upload some SQL first.'); clearResult(); return; }
      try {
        const out = mode === 'format' ? formatSql(sql, { indent: indentUnit(), keywordCase: els.kcase.value }) : minifySql(sql);
        els.output.value = out;
        setStats(mode === 'format' ? 'Formatted' : 'Minified', sql, out);
      } catch (e) { clearResult(); showMessage(els.msg, 'error', `Could not process the SQL: ${e.message}`); }
    }

    async function loadFile(file) {
      if (!file) return;
      try { els.input.value = await readFileAsText(file); clearResult(); showMessage(els.msg, null); }
      catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const disposers = [
      on($('#sf-format'), 'click', () => run('format')),
      on($('#sf-minify'), 'click', () => run('minify')),
      on(els.kcase, 'change', () => ctx.storage.set('case', els.kcase.value)),
      on(els.example, 'change', () => {
        const ex = EXAMPLES.find(e => e.id === els.example.value);
        if (ex) { els.input.value = ex.sql; run('format'); }
        els.example.value = '';
      }),
      on($('#sf-upload'), 'click', async () => loadFile(await pickFile('.sql,.txt,text/plain'))),
      on($('#sf-clear'), 'click', () => { els.input.value = ''; clearResult(); showMessage(els.msg, null); els.input.focus(); }),
      on($('#sf-copy'), 'click', () => copyText(els.output.value)),
      on($('#sf-download'), 'click', () => downloadFile('query.sql', els.output.value, 'application/sql;charset=utf-8')),
      on($('#sf-swap'), 'click', () => {
        if (!els.output.value) { toast('Nothing to move - run Format or Minify first', 'warn'); return; }
        els.input.value = els.output.value; clearResult(); showMessage(els.msg, null);
      }),
      on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run('format'); }),
      enableDrop($('#sf-drop'), loadFile),
    ];
    renderIcons(root);
    return () => disposers.forEach(d => d());
  },
};
