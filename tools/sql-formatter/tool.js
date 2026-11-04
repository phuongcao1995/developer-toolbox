// SQL Formatter UI. Logic: logic.js (tokenizer + layout engine), highlight.js, and the shared pure modules
// assets/js/shared/sql-analyzer.js and sql-json.js. No CDN, no eval; untrusted text only reaches the DOM through textContent.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, enableTabIndent, formatBytes, renderIcons } from '../../assets/js/components/ui.js';
import { formatSql, minifySql, sqlStats, sqlWarnings, SQL_DIALECTS } from './logic.js';
import { renderHighlight, HIGHLIGHT_LIMIT } from './highlight.js';
import { analyzeSql, explainSql, HEURISTIC_NOTE } from '../../assets/js/shared/sql-analyzer.js';
import { sqlToJson } from '../../assets/js/shared/sql-json.js';
import { EXAMPLES } from './examples.js';

const TABS = ['format', 'analyze', 'explain', 'json'];
const RUN_LABEL = { analyze: 'Analyze', explain: 'Explain', json: 'Convert to JSON' };
const OUT_TITLE = { format: 'Result', analyze: 'Analysis', explain: 'Explanation', json: 'JSON' };

/** Tiny safe element builder: strings become text nodes. */
function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      dialect: $('#sf-dialect'), indent: $('#sf-indent'), kcase: $('#sf-case'), fncase: $('#sf-fncase'), width: $('#sf-width'), commaFirst: $('#sf-commafirst'),
      example: $('#sf-example'), input: $('#sf-input'), hl: $('#sf-hl'), editor: $('.sf-editor'), msg: $('#sf-msg'), stats: $('#sf-stats'),
      run: $('#sf-run'), runLabel: $('#sf-run-label'), format: $('#sf-format'), minify: $('#sf-minify'), fmtOptions: $('#sf-fmt-options'),
      swap: $('#sf-swap'), dlLabel: $('#sf-dl-label'), outTitle: $('#sf-out-title'), result: $('#sf-result'),
      hintFormat: $('#sf-hint-format'), hintHeur: $('#sf-hint-heuristic'), hintJson: $('#sf-hint-json'),
      panes: { format: $('#sf-out-format'), analyze: $('#sf-out-analyze'), explain: $('#sf-out-explain'), json: $('#sf-out-json') },
      tabs: [...root.querySelectorAll('.sf-tabs [role="tab"]')],
    };
    const store = (k, d) => { try { return ctx.storage.get(k, d); } catch { return d; } };
    els.indent.value = ctx.indentUnit === '\t' ? 'tab' : ctx.indentUnit.length === 4 ? '4' : '2';
    els.kcase.value = store('case', 'upper');
    els.fncase.value = ['auto', 'upper', 'lower', 'preserve'].includes(store('fncase', 'auto')) ? store('fncase', 'auto') : 'auto';
    els.width.value = ['0', '80', '100', '120'].includes(String(store('width', '0'))) ? String(store('width', '0')) : '0';
    els.commaFirst.checked = !!store('commaFirst', false);
    for (const [id, d] of Object.entries(SQL_DIALECTS)) els.dialect.append(new Option(d.label, id));
    els.dialect.value = SQL_DIALECTS[store('dialect', 'standard')] ? store('dialect', 'standard') : 'standard';
    root.querySelector('.sf').style.setProperty('--editor-font-size', `${ctx.fontSize}px`);
    enableTabIndent(els.input, ctx.indentUnit);
    for (const ex of EXAMPLES) els.example.append(new Option(ex.label, ex.id));

    // plain-text results used by Copy / Download (never read back from highlighted DOM)
    const out = { format: '', analyze: '', explain: '', json: '' };
    const FILES = { format: ['query.sql', 'application/sql;charset=utf-8', 'Download .sql'], analyze: ['analysis.json', 'application/json;charset=utf-8', 'Download .json'],
      explain: ['explanation.txt', 'text/plain;charset=utf-8', 'Download .txt'], json: ['rows.json', 'application/json;charset=utf-8', 'Download .json'] };
    let tab = TABS.includes(store('tab', 'format')) ? store('tab', 'format') : 'format';

    const indentUnit = () => (els.indent.value === 'tab' ? '\t' : ' '.repeat(Number(els.indent.value)));
    const dialect = () => els.dialect.value;

    // ---------- input highlight overlay ----------
    let composing = false, raf = 0;
    const paintInput = () => {
      raf = 0;
      if (composing) return;
      const v = els.input.value;
      const big = v.length > HIGHLIGHT_LIMIT;
      els.editor.classList.toggle('sf-plain', big);
      if (big) { els.hl.replaceChildren(); return; }
      renderHighlight(els.hl, v, { dialect: dialect(), trailingNewline: true });
      syncScroll();
    };
    const syncScroll = () => { els.hl.scrollTop = els.input.scrollTop; els.hl.scrollLeft = els.input.scrollLeft; };
    const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(paintInput); };
    const setInput = v => { els.input.value = v; paintInput(); };

    // ---------- helpers ----------
    const setStats = (label, before, after) => {
      els.stats.replaceChildren();
      const st = sqlStats(after, { dialect: dialect() });
      for (const [text, cls] of [[label, 'badge badge-info'], [`${st.statements} statement${st.statements === 1 ? '' : 's'}`, 'badge'], [`${st.lines} lines`, 'badge'],
        [`${formatBytes(before.length)} → ${formatBytes(after.length)}`, 'badge']]) els.stats.append(h('span', cls, text));
    };
    const clearAll = () => {
      out.format = out.analyze = out.explain = out.json = '';
      els.panes.format.replaceChildren(); els.panes.json.replaceChildren(); els.panes.analyze.replaceChildren(); els.panes.explain.replaceChildren();
      els.stats.replaceChildren();
    };
    const needInput = () => {
      if (els.input.value.trim()) return false;
      showMessage(els.msg, 'warn', 'Enter or upload some SQL first.'); return true;
    };

    function jump(offset, length) {
      const ta = els.input;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(offset, offset + Math.max(0, length));
      const cs = getComputedStyle(ta);
      const lineH = parseFloat(cs.lineHeight) || ctx.fontSize * 1.5;
      const before = ta.value.slice(0, offset);
      const line = before.split('\n').length - 1;
      const col = offset - (before.lastIndexOf('\n') + 1);
      const c = document.createElement('canvas').getContext('2d');
      c.font = cs.font;
      const cw = (c && c.measureText('M').width) || ctx.fontSize * 0.6;
      const top = line * lineH, left = col * cw;
      if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lineH * 2) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
      if (left < ta.scrollLeft || left + length * cw > ta.scrollLeft + ta.clientWidth - 20) ta.scrollLeft = Math.max(0, left - ta.clientWidth / 3);
      syncScroll();
    }
    const jumpButton = (loc, ...kids) => {
      const b = h('button', 'sf-jump', ...kids);
      b.type = 'button';
      b.title = `Select in the input (line ${loc.line}, column ${loc.col})`;
      b.addEventListener('click', () => jump(loc.offset, loc.length));
      return b;
    };
    const li = (cls, node) => { const e = h('li', cls); e.append(node); return e; };
    const section = (parent, title, items, emptyText) => {
      parent.append(h('h4', '', title));
      if (!items.length) { parent.append(h('p', 'sf-muted', emptyText || 'None')); return; }
      const ul = h('ul', 'sf-list'); items.forEach(i => ul.append(i)); parent.append(ul);
    };
    const mono = t => h('code', '', t);
    const sub = t => h('span', 'sf-sub', t);

    // ---------- Format ----------
    function runFormat(mode) {
      if (needInput()) { clearAll(); return; }
      showMessage(els.msg, null);
      const sql = els.input.value;
      try {
        const d = dialect();
        const res = mode === 'format'
          ? formatSql(sql, { indent: indentUnit(), keywordCase: els.kcase.value, dialect: d, maxWidth: Number(els.width.value), commaFirst: els.commaFirst.checked, functionCase: els.fncase.value })
          : minifySql(sql, { dialect: d });
        out.format = res;
        renderHighlight(els.panes.format, res, { dialect: d });
        setStats(mode === 'format' ? 'Formatted' : 'Minified', sql, res);
        const warns = sqlWarnings(sql, { dialect: d });
        if (warns.length) showMessage(els.msg, 'warn', warns.join(' ') + ' Check the dialect setting if this is unexpected.');
      } catch (e) { out.format = ''; els.panes.format.replaceChildren(); showMessage(els.msg, 'error', `Could not process the SQL: ${e.message}`); }
    }

    // ---------- Analyze ----------
    function runAnalyze() {
      const pane = els.panes.analyze; pane.replaceChildren(); out.analyze = '';
      if (needInput()) return;
      showMessage(els.msg, null);
      const r = analyzeSql(els.input.value, { dialect: dialect() });
      if (!r.ok) { showMessage(els.msg, 'error', r.error); return; }
      if (r.warnings.length) showMessage(els.msg, 'warn', r.warnings.join(' '));
      out.analyze = JSON.stringify({ note: HEURISTIC_NOTE, ...r }, null, 2);
      const sum = h('div', 'sf-chips');
      for (const [t, c] of [[`${r.summary.statements} statement${r.summary.statements === 1 ? '' : 's'}`, 'badge badge-info'], [`${r.summary.tables.length} table${r.summary.tables.length === 1 ? '' : 's'}`, 'badge'],
        [`${r.summary.warnings} warning${r.summary.warnings === 1 ? '' : 's'}`, r.summary.warnings ? 'badge badge-warn' : 'badge badge-success'], [`${r.summary.findings - r.summary.warnings} info`, 'badge']]) sum.append(h('span', c, t));
      pane.append(sum);
      for (const s of r.statements) {
        const head = h('div', 'sf-stmt', h('h3', '', `Statement ${s.index + 1}`));
        head.append(h('span', 'badge badge-info', s.type), h('span', 'badge', `line ${s.line}`), h('span', `badge ${s.complexity.level === 'high' ? 'badge-warn' : ''}`, `complexity ${s.complexity.score} (${s.complexity.level})`));
        if (s.startsWith === 'WITH') head.append(h('span', 'badge', 'WITH'));
        head.title = `Complexity = ${s.complexity.formula}`;
        pane.append(head);
        if (s.object) pane.append(h('p', 'sf-muted', `Object: ${s.object.kind}${s.object.name ? ' ' + s.object.name : ''}`));
        section(pane, 'Tables', s.tables.map(t => li('', jumpButton(t, mono((t.schema ? t.schema + '.' : '') + t.name), t.alias ? ` as ${t.alias}` : '', sub(`${t.kind}${t.kind === 'derived' ? ' (subquery)' : ''} · ${t.role} · line ${t.line}`)))), 'No tables referenced.');
        if (s.ctes.length) section(pane, 'CTEs', s.ctes.map(c => li('', jumpButton(c, mono(c.name)))));
        section(pane, 'Joins', s.joins.map(j => li('', jumpButton(j, mono(`${j.type} JOIN ${j.table || '(subquery)'}${j.alias ? ' ' + j.alias : ''}`),
          j.condition ? sub(`${j.using ? 'USING ' : 'ON '}${j.condition}`) : sub('no condition'), j.flags.length ? sub(`flags: ${j.flags.join(', ')}`) : null))), 'No joins.');
        section(pane, 'Columns referenced (best effort)', [...s.stars.map(c => li('', jumpButton(c, mono(`${c.qualifier ? c.qualifier + '.' : ''}*`), sub('all columns')))),
          ...s.columns.map(c => li('', jumpButton(c, mono((c.qualifier ? c.qualifier + '.' : '') + c.name), sub(`${c.table ? 'table ' + c.table + (c.inferred ? ' (inferred)' : '') + ' · ' : ''}${c.clauses.join(', ')}`))))], 'No columns found.');
        const chips = h('div', 'sf-chips');
        const flag = (label, on) => chips.append(h('span', on ? 'badge badge-success' : 'badge', `${label}: ${on ? 'yes' : 'no'}`));
        flag('WHERE', s.clauses.where); flag('GROUP BY', s.clauses.groupBy); flag('HAVING', s.clauses.having); flag('ORDER BY', s.clauses.orderBy); flag('LIMIT', s.clauses.limit); flag('DISTINCT', s.clauses.distinct);
        chips.append(h('span', 'badge', `subqueries: ${s.subqueries.count} (max depth ${s.subqueries.maxDepth})`), h('span', 'badge', `UNION parts: ${s.unionParts}`));
        pane.append(h('h4', '', 'Clauses and structure'), chips);
        if (s.aggregates.length || s.windowFunctions.length) {
          section(pane, 'Functions', [...s.aggregates.map(a => li('', jumpButton(a.loc, mono(a.name), sub(`aggregate × ${a.count}`)))),
            ...s.windowFunctions.map(w => li('', jumpButton(w, mono(w.name), sub('window function'))))]);
        }
        if (s.parameters.length) section(pane, 'Parameters', s.parameters.map(p => li('', jumpButton(p, mono(p.text), sub(p.kind)))));
        section(pane, 'Lint hints (heuristic)', s.findings.map(f => li(`sf-find-${f.severity}`, jumpButton(f, h('span', `badge ${f.severity === 'warn' ? 'badge-warn' : 'badge-info'}`, f.severity), ' ', f.message,
          sub(`Suggestion: ${f.suggestion}`), sub(`${f.id} · line ${f.line}, column ${f.col}`)))), 'No hints raised.');
      }
      pane.append(h('p', 'sf-note', HEURISTIC_NOTE));
    }

    // ---------- Explain ----------
    function runExplain() {
      const pane = els.panes.explain; pane.replaceChildren(); out.explain = '';
      if (needInput()) return;
      showMessage(els.msg, null);
      const r = explainSql(els.input.value, { dialect: dialect() });
      if (!r.ok) { showMessage(els.msg, 'error', r.error); return; }
      let text = `${HEURISTIC_NOTE}\n`;
      for (const s of r.statements) {
        pane.append(h('div', 'sf-stmt', h('h3', '', `Statement ${s.index + 1}`), h('span', 'badge badge-info', s.type), h('span', 'badge', `line ${s.line}`)));
        text += `\nStatement ${s.index + 1} (${s.type})\n`;
        if (s.orderNote) { pane.append(h('p', 'sf-note', s.orderNote)); text += `${s.orderNote}\n`; }
        const ol = h('ol', 'sf-steps');
        for (const st of s.steps) { ol.append(h('li', '', h('span', 'badge badge-info', st.clause), st.text)); text += `${st.n}. [${st.clause}] ${st.text}\n`; }
        pane.append(ol);
        pane.append(h('h4', '', 'Index hints (heuristic)'), h('p', 'sf-muted', s.indexHints.note));
        text += `\nIndex hints (heuristic): ${s.indexHints.note}\n`;
        if (s.indexHints.columns.length) {
          const ul = h('ul', 'sf-list');
          for (const c of s.indexHints.columns) { ul.append(li('', h('span', 'sf-static', mono(c.column), sub(`${c.table ? 'table ' + c.table + ' · ' : ''}used in ${c.usage.join(', ')}`)))); text += `- ${c.column} (${c.usage.join(', ')})\n`; }
          pane.append(ul);
        } else { pane.append(h('p', 'sf-muted', 'No columns found in WHERE / JOIN / ORDER BY / GROUP BY.')); text += '- none found\n'; }
      }
      out.explain = text;
    }

    // ---------- To JSON ----------
    function runJson() {
      const pane = els.panes.json; pane.replaceChildren(); out.json = '';
      if (needInput()) return;
      showMessage(els.msg, null);
      const r = sqlToJson(els.input.value, { dialect: dialect(), indent: ctx.indentUnit === '\t' ? '\t' : ctx.indentUnit.length });
      if (!r.ok) { showMessage(els.msg, 'error', r.error); return; }
      out.json = r.json;
      pane.textContent = r.json;
      els.stats.replaceChildren(h('span', 'badge badge-info', `${r.rows} row${r.rows === 1 ? '' : 's'}`), h('span', 'badge', `${r.tables.length} table${r.tables.length === 1 ? '' : 's'}`), h('span', 'badge', r.shape === 'array' ? 'JSON array' : 'object by table'));
      if (r.notes.length) showMessage(els.msg, 'info', `Notes: ${r.notes.join('; ')}.`);
    }

    // ---------- tabs ----------
    const RUN = { analyze: runAnalyze, explain: runExplain, json: runJson };
    function activate(name, { run = true, focus = false } = {}) {
      if (!TABS.includes(name)) name = 'format';
      tab = name;
      try { ctx.storage.set('tab', name); } catch { /* storage unavailable */ }
      showMessage(els.msg, null);
      els.tabs.forEach(b => {
        const on = b.dataset.tab === name;
        b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
        if (on) { els.result.setAttribute('aria-labelledby', b.id); if (focus) b.focus(); }
      });
      for (const k of TABS) els.panes[k].hidden = k !== name;
      const isFmt = name === 'format';
      els.fmtOptions.hidden = !isFmt; els.format.hidden = !isFmt; els.minify.hidden = !isFmt; els.swap.hidden = !isFmt;
      els.run.hidden = isFmt; els.runLabel.textContent = RUN_LABEL[name] || '';
      els.hintFormat.hidden = !isFmt; els.hintHeur.hidden = !(name === 'analyze' || name === 'explain'); els.hintJson.hidden = name !== 'json';
      els.outTitle.textContent = OUT_TITLE[name]; els.dlLabel.textContent = FILES[name][2];
      if (run && els.input.value.trim()) { if (isFmt) { if (!out.format) runFormat('format'); } else RUN[name](); }
    }
    const rerunDebounced = ctx.debounce(() => { if (tab !== 'format' && els.input.value.trim()) RUN[tab](); }, 300);

    async function loadFile(file) {
      if (!file) return;
      try { setInput(await readFileAsText(file)); clearAll(); showMessage(els.msg, null); if (tab !== 'format') RUN[tab](); }
      catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const rerunFormatIfShown = () => { if (tab === 'format' && out.format) runFormat('format'); };
    const disposers = [
      on(els.format, 'click', () => runFormat('format')),
      on(els.minify, 'click', () => runFormat('minify')),
      on(els.run, 'click', () => RUN[tab] && RUN[tab]()),
      on(els.kcase, 'change', () => { ctx.storage.set('case', els.kcase.value); rerunFormatIfShown(); }),
      on(els.fncase, 'change', () => { ctx.storage.set('fncase', els.fncase.value); rerunFormatIfShown(); }),
      on(els.width, 'change', () => { ctx.storage.set('width', els.width.value); rerunFormatIfShown(); }),
      on(els.commaFirst, 'change', () => { ctx.storage.set('commaFirst', els.commaFirst.checked); rerunFormatIfShown(); }),
      on(els.indent, 'change', rerunFormatIfShown),
      on(els.dialect, 'change', () => {
        ctx.storage.set('dialect', els.dialect.value); paintInput();
        if (els.input.value.trim()) { if (tab === 'format') { if (out.format) runFormat('format'); } else RUN[tab](); }
      }),
      on(els.example, 'change', () => {
        const ex = EXAMPLES.find(e => e.id === els.example.value);
        if (ex) { setInput(ex.sql); if (tab === 'format') runFormat('format'); else RUN[tab](); }
        els.example.value = '';
      }),
      on(els.input, 'input', () => { schedulePaint(); rerunDebounced(); }),
      on(els.input, 'scroll', syncScroll),
      on(els.input, 'compositionstart', () => { composing = true; els.editor.classList.add('sf-composing'); }),
      on(els.input, 'compositionend', () => { composing = false; els.editor.classList.remove('sf-composing'); paintInput(); }),
      on($('#sf-upload'), 'click', async () => loadFile(await pickFile('.sql,.txt,text/plain'))),
      on($('#sf-clear'), 'click', () => { setInput(''); clearAll(); showMessage(els.msg, null); els.input.focus(); }),
      on($('#sf-copy'), 'click', () => copyText(out[tab])),
      on($('#sf-download'), 'click', () => downloadFile(FILES[tab][0], out[tab], FILES[tab][1])),
      on(els.swap, 'click', () => {
        if (!out.format) { toast('Nothing to move - run Format or Minify first', 'warn'); return; }
        setInput(out.format); out.format = ''; els.panes.format.replaceChildren(); els.stats.replaceChildren(); showMessage(els.msg, null);
      }),
      on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { if (tab === 'format') runFormat('format'); else RUN[tab](); } }),
      enableDrop($('#sf-drop'), loadFile),
      ...els.tabs.map((b, idx) => [
        on(b, 'click', () => activate(b.dataset.tab)),
        on(b, 'keydown', e => {
          const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); activate(TABS[e.key === 'Home' ? 0 : TABS.length - 1], { focus: true }); }
          else if (k) { e.preventDefault(); activate(TABS[(idx + k + TABS.length) % TABS.length], { focus: true }); }
        }),
      ]).flat(),
    ];
    paintInput();
    activate(tab, { run: false });
    renderIcons(root);
    return () => { if (raf) cancelAnimationFrame(raf); disposers.forEach(d => d()); };
  },
};
