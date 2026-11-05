// SQL Query Analyzer UI. Static analysis only: SQL is never executed or sent anywhere. Untrusted text reaches the DOM via textContent.
import { copyText, downloadFile, toast, pickFile, readFileAsText, showMessage, renderIcons } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { highlightSegments } from '../sql-formatter/highlight.js';
import * as Q from './logic.js';
import { EXAMPLES } from './examples.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TYPE_OF = { kw: 'keyword', fn: 'function', str: 'string', num: 'number', com: 'comment', idn: 'identifier', par: 'property', op: 'operator' };
const TABS = [['structure', 'Structure'], ['joins', 'JOINs'], ['where', 'WHERE'], ['group', 'GROUP BY / HAVING'], ['order', 'ORDER BY / LIMIT'], ['index', 'Indexes'], ['lint', 'Anti-patterns'], ['plan', 'Execution plan'], ['concepts', 'Concepts'], ['export', 'Export']];
const MAX_STORED = 200000;

function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const sv = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); for (const k of kids) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k))); return e; };
const code = t => { const c = h('code'); c.textContent = t; return c; };
const badge = (text, cls = '') => h('span', `badge ${cls}`.trim(), text);
const sevBadge = s => (s === 'warn' ? badge('Warning', 'badge-warn') : badge('Info', 'badge-info'));

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = { dialect: $('#qa-dialect'), example: $('#qa-example'), input: $('#qa-input'), msg: $('#qa-msg'), cards: $('#qa-cards'), tabs: $('#qa-tabs'), pane: $('#qa-pane'), count: $('#qa-count') };
    const store = (k, d) => { try { return ctx.storage.get(k, d) ?? d; } catch { return d; } };
    const save = (k, v) => { try { ctx.storage.set(k, v); } catch { /* storage unavailable */ } };

    for (const [id, d] of Object.entries(Q.SQL_DIALECTS)) els.dialect.append(new Option(d.label, id));
    els.dialect.value = Q.SQL_DIALECTS[store('dialect', 'standard')] ? store('dialect', 'standard') : 'standard';
    for (const ex of EXAMPLES) els.example.append(new Option(ex.label, ex.id));
    let tab = TABS.some(t => t[0] === store('tab', 'structure')) ? store('tab', 'structure') : 'structure';
    let sel = 0, analysis = null, planText = '', planOpt = 0;

    // ---------- editor with SQL highlighting ----------
    const highlighter = text => highlightSegments(text, { dialect: els.dialect.value }).map(s => ({ text: s.text, type: TYPE_OF[s.cls] || 'plain' }));
    const ed = createEditor(els.input, { language: 'sql', highlighter, storage: ctx.storage, storageKey: 'qa-input', fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'], ariaLabel: 'SQL to analyze' });
    const saved = store('sql', '');
    if (typeof saved === 'string' && saved) els.input.value = saved;
    const jump = (offset, length) => { try { ed.select(offset, offset + Math.max(0, length || 0)); } catch { els.input.focus(); } };
    const jumpBtn = (loc, ...kids) => { const b = h('button', 'qa-jump', ...kids); b.type = 'button'; b.title = `Select in the editor (line ${loc.line}, column ${loc.col})`; b.addEventListener('click', () => jump(loc.offset, loc.length)); return b; };
    const copyBtn = (text, label = 'Copy') => { const b = h('button', 'btn btn-sm', label); b.type = 'button'; b.addEventListener('click', () => copyText(text)); return b; };
    const codeBlock = (text, withCopy = true) => { const pre = h('pre', 'qa-code'); pre.textContent = text; return withCopy ? h('div', 'qa-codewrap', pre, copyBtn(text)) : pre; };

    // ---------- analysis ----------
    function run() {
      const sql = els.input.value;
      els.count.textContent = sql ? `${sql.length.toLocaleString()} characters` : '';
      if (sql.length <= MAX_STORED) save('sql', sql); else save('sql', '');
      if (!sql.trim()) { analysis = null; showMessage(els.msg, null); render(); return; }
      analysis = Q.analyzeQuery(sql, { dialect: els.dialect.value });
      if (!analysis.ok) { showMessage(els.msg, 'error', analysis.error); render(); return; }
      showMessage(els.msg, analysis.warnings.length ? 'warn' : null, analysis.warnings.join(' '));
      if (sel >= analysis.statements.length) sel = 0;
      render();
    }
    const runDebounced = ctx.debounce(run, 300);

    // ---------- shell: cards + tabs ----------
    function renderCards() {
      els.cards.replaceChildren();
      if (!analysis || !analysis.ok) return;
      analysis.statements.forEach((s, i) => {
        const warns = s.findings.filter(f => f.severity === 'warn').length;
        const b = h('button', `qa-card${i === sel ? ' active' : ''}`, h('strong', '', `Statement ${i + 1}`), h('span', 'qa-card-meta', `${s.type} - line ${s.line}`),
          h('span', 'qa-card-meta', `${s.base.realTableCount} table${s.base.realTableCount === 1 ? '' : 's'}, complexity ${s.base.complexity.score} (${s.base.complexity.level})`),
          h('span', 'qa-card-badges', warns ? badge(`${warns} warning${warns === 1 ? '' : 's'}`, 'badge-warn') : badge('No warnings', 'badge-success'), s.findings.length - warns ? badge(`${s.findings.length - warns} info`) : null));
        b.type = 'button'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(i === sel));
        b.addEventListener('click', () => { sel = i; render(); jump(s.offset, 0); });
        els.cards.append(b);
      });
    }
    function renderTabs() {
      if (!els.tabs.childElementCount) {
        for (const [id, label] of TABS) {
          const b = h('button', 'tab', label); b.type = 'button'; b.id = `qa-tab-${id}`; b.dataset.tab = id; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'qa-pane');
          b.addEventListener('click', () => { tab = id; save('tab', id); render(); });
          b.addEventListener('keydown', e => {
            const i = TABS.findIndex(t => t[0] === id); const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); tab = TABS[e.key === 'Home' ? 0 : TABS.length - 1][0]; render(); $(`#qa-tab-${tab}`).focus(); }
            else if (k) { e.preventDefault(); tab = TABS[(i + k + TABS.length) % TABS.length][0]; render(); $(`#qa-tab-${tab}`).focus(); }
          });
          els.tabs.append(b);
        }
      }
      for (const b of els.tabs.children) { const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on) els.pane.setAttribute('aria-labelledby', b.id); }
    }
    function render() {
      renderCards(); renderTabs();
      const pane = els.pane; pane.replaceChildren();
      const stmt = analysis && analysis.ok ? analysis.statements[sel] : null;
      const needsSql = !['concepts'].includes(tab);
      if (needsSql && !stmt) { pane.append(h('p', 'qa-muted', analysis && !analysis.ok ? 'Fix the problem above to see the analysis.' : 'Paste SQL on the left (or load an example) to start. Analysis updates as you type.')); if (tab !== 'plan' && tab !== 'export') return; }
      ({ structure: rStructure, joins: rJoins, where: rWhere, group: rGroup, order: rOrder, index: rIndex, lint: rLint, plan: rPlan, concepts: rConcepts, export: rExport })[tab](pane, stmt);
    }
    const heur = pane => pane.append(h('p', 'qa-note', Q.HEURISTIC_NOTE));
    const section = (pane, title) => pane.append(h('h4', '', title));

    // ---------- Structure ----------
    function rStructure(pane, s) {
      if (!s) return;
      const b = s.base;
      pane.append(h('div', 'qa-chips', badge(s.type, 'badge-info'), badge(`line ${s.line}`), badge(`complexity ${b.complexity.score} (${b.complexity.level})`), badge(`${b.subqueries.count} subquer${b.subqueries.count === 1 ? 'y' : 'ies'}`), badge(`${b.unionParts} UNION part${b.unionParts === 1 ? '' : 's'}`),
        ...['where', 'groupBy', 'having', 'orderBy', 'limit', 'distinct'].map(k => badge(`${k === 'groupBy' ? 'GROUP BY' : k === 'orderBy' ? 'ORDER BY' : k.toUpperCase()}: ${b.clauses[k] ? 'yes' : 'no'}`, b.clauses[k] ? 'badge-success' : ''))));
      section(pane, 'Tables and aliases');
      if (!b.tables.length) pane.append(h('p', 'qa-muted', 'No tables referenced.'));
      else { const ul = h('ul', 'qa-list'); for (const t of b.tables) ul.append(h('li', '', jumpBtn(t, code((t.schema ? t.schema + '.' : '') + t.name), t.alias && t.alias !== t.name ? ` as ${t.alias}` : '', h('span', 'qa-sub', `${t.kind === 'derived' ? 'derived table (subquery)' : t.kind} - ${t.role} - line ${t.line}`)))); pane.append(ul); }
      if (b.ctes.length) { section(pane, 'CTEs'); const ul = h('ul', 'qa-list'); for (const c of b.ctes) ul.append(h('li', '', jumpBtn(c, code(c.name)))); pane.append(ul); }
      section(pane, 'Query and subquery tree');
      const byParent = new Map(); s.blocks.forEach(bl => { const k = bl.parent ?? -1; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(bl); });
      const KIND = { root: 'Main query', cte: 'CTE', derived: 'Derived table', scalar: 'Scalar subquery', in: 'IN subquery', exists: 'EXISTS subquery', union: 'UNION part' };
      const tree = (parent) => { const list = byParent.get(parent); if (!list) return null; const ul = h('ul', 'qa-tree'); for (const bl of list) { const li = h('li', '', h('strong', '', KIND[bl.kind] || bl.kind), bl.name ? ` ${bl.name}` : '', bl.alias ? ` (alias ${bl.alias})` : '', bl.setOp ? ` after ${bl.setOp}` : '', bl.clause ? h('span', 'qa-sub', ` in ${bl.clause}`) : '', bl.tables.length ? h('span', 'qa-sub', ` - ${bl.tables.map(t => t.name).join(', ')}`) : ''); const sub = tree(bl.id); if (sub) li.append(sub); ul.append(li); } return ul; };
      pane.append(tree(-1) || h('p', 'qa-muted', 'No blocks.'));
      section(pane, 'Join diagram');
      if (!s.graphs.length) pane.append(h('p', 'qa-muted', 'This statement has no joins.'));
      for (const g of s.graphs) pane.append(h('figure', 'qa-fig', h('figcaption', '', g.title), joinSvg(g), joinTextList(g)));
      heur(pane);
    }
    function joinTextList(g) {
      const ul = h('ul', 'qa-list qa-sr-or-small');
      for (const e of g.edges) { const a = g.nodes.find(n => n.id === e.from), b = g.nodes.find(n => n.id === e.to); ul.append(h('li', '', `${a.label} to ${b.label}: ${e.label}${e.condition ? ' ON ' + e.condition : ''}`)); }
      return ul;
    }
    function joinSvg(g) {
      const n = g.nodes.length, W = 560, Hh = n <= 3 ? 150 : 150 + (n - 3) * 26;
      const cx = W / 2, cy = Hh / 2, R = n === 1 ? 0 : Math.min(W / 2 - 80, Hh / 2 - 30 + (n > 3 ? 40 : 0));
      const pos = new Map();
      g.nodes.forEach((nd, i) => { if (n <= 4) pos.set(nd.id, { x: 70 + (n === 1 ? (W - 140) / 2 : i * ((W - 140) / (n - 1))), y: cy + (i % 2 ? 22 : -22) }); else { const a = (2 * Math.PI * i) / n - Math.PI / 2; pos.set(nd.id, { x: cx + R * 1.45 * Math.cos(a), y: cy + R * Math.sin(a) }); } });
      const svg = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, class: 'qa-svg', role: 'img', 'aria-label': `Join diagram: ${g.nodes.map(x => x.label).join(', ')}` });
      svg.append(sv('title', {}, `Join diagram: ${g.title}`));
      const defs = sv('defs', {}, sv('marker', { id: `qa-arrow-${g.block}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, sv('path', { d: 'M0 0 L10 5 L0 10 z', class: 'qa-arrowhead' })));
      svg.append(defs);
      for (const e of g.edges) {
        const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const pad = 56; const sx = a.x + (dx / len) * Math.min(pad, len / 3), sy = a.y + (dy / len) * 14, ex = b.x - (dx / len) * Math.min(pad, len / 3), ey = b.y - (dy / len) * 14;
        const outer = /LEFT|RIGHT|FULL/.test(e.type), cross = /CROSS|COMMA/.test(e.type);
        svg.append(sv('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: `qa-edge${outer ? ' qa-outer' : ''}${cross ? ' qa-cross' : ''}`, 'marker-end': `url(#qa-arrow-${g.block})` }));
        const mx = (sx + ex) / 2, my = (sy + ey) / 2;
        const label = e.type === 'COMMA' ? 'comma join' : e.label; const tw = label.length * 6.4 + 10;
        svg.append(sv('rect', { x: mx - tw / 2, y: my - 9, width: tw, height: 17, rx: 4, class: 'qa-edge-bg' }), sv('text', { x: mx, y: my + 4, 'text-anchor': 'middle', class: 'qa-edge-label' }, label));
      }
      for (const nd of g.nodes) {
        const p = pos.get(nd.id); const text = nd.label.length > 22 ? nd.label.slice(0, 21) + '...' : nd.label; const w = Math.max(80, text.length * 7 + 18);
        const grp = sv('g', {}, sv('title', {}, nd.label + (nd.kind !== 'table' ? ` (${nd.kind})` : '')), sv('rect', { x: p.x - w / 2, y: p.y - 15, width: w, height: 30, rx: nd.kind === 'table' ? 5 : 15, class: `qa-node qa-node-${nd.kind}` }), sv('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', class: 'qa-node-label' }, text));
        svg.append(grp);
      }
      return svg;
    }

    // ---------- JOINs ----------
    function rJoins(pane, s) {
      if (!s) return;
      if (!s.joinExplanations.length) { pane.append(h('p', 'qa-muted', 'No JOINs in this statement.')); }
      for (const j of s.joinExplanations) {
        const card = h('div', 'qa-item', jumpBtn(j.join, h('strong', '', `${j.type} JOIN ${j.target}`), ' ', j.join.condition ? code(`${j.join.using ? 'USING ' : 'ON '}${j.join.condition}`) : null));
        const ul = h('ul', 'qa-list'); j.lines.forEach(l => ul.append(h('li', '', l))); card.append(ul);
        for (const w of j.warnings) card.append(h('p', 'qa-warn', badge('Warning', 'badge-warn'), ' ', w));
        pane.append(card);
      }
      const cart = s.findings.filter(f => f.id === 'implicit-join');
      for (const f of cart) pane.append(h('p', 'qa-warn', badge('Warning', 'badge-warn'), ' ', jumpBtn(f, f.message, h('span', 'qa-sub', f.suggestion))));
      heur(pane);
    }

    // ---------- WHERE ----------
    function predItem(p) {
      const verdict = p.kind === 'or' ? (p.sameColumn ? badge('OR on one column', 'badge-success') : badge('OR across columns', 'badge-warn')) : p.sargable === true ? badge('Sargable', 'badge-success') : p.sargable === false ? badge('Not sargable', 'badge-warn') : badge('Not a filter on one column');
      const card = h('div', 'qa-item', jumpBtn(p, code(p.text.replace(/\s+/g, ' ')), ' ', verdict, p.kind && p.kind !== 'other' && p.kind !== 'or' ? h('span', 'qa-sub', `kind: ${p.kind}`) : null));
      const ul = h('ul', 'qa-list'); for (const r of p.reasons || []) ul.append(h('li', '', r)); for (const x of p.hints || []) ul.append(h('li', '', h('em', '', 'Hint: '), x));
      if (p.kind === 'or') ul.append(h('li', '', p.sameColumn ? 'All branches test the same column: equivalent to an IN (...) list, which is index-friendly.' : 'Branches test different columns: a single index cannot serve all of them. Consider UNION ALL of separate indexed queries.'));
      if (ul.childElementCount) card.append(ul);
      return card;
    }
    function rWhere(pane, s) {
      if (!s) return;
      pane.append(h('p', 'qa-note', 'A predicate is sargable when the database can use an index to seek to matching rows. Functions or arithmetic on a column, leading wildcards, NOT IN and = NULL usually defeat that.'));
      section(pane, 'WHERE conditions');
      const w = s.predicates.where; if (!w.length) pane.append(h('p', 'qa-muted', s.base.type === 'SELECT' || ['UPDATE', 'DELETE'].includes(s.base.type) ? 'No WHERE clause: all rows are considered.' : 'No WHERE conditions.'));
      w.forEach(p => pane.append(predItem(p)));
      if (s.predicates.on.length) { section(pane, 'JOIN conditions (ON)'); s.predicates.on.forEach(p => pane.append(predItem(p))); }
      heur(pane);
    }

    // ---------- GROUP BY / HAVING ----------
    function rGroup(pane, s) {
      if (!s) return;
      pane.append(h('p', 'qa-note', 'WHERE filters rows before grouping; HAVING filters groups after aggregation. Conditions without aggregates belong in WHERE. Under strict SQL every selected column must be aggregated or listed in GROUP BY.'));
      if (!s.groupBy.length) { pane.append(h('p', 'qa-muted', s.base.clauses.groupBy || s.base.clauses.having ? 'Nothing to report.' : 'No GROUP BY or HAVING in this statement.')); }
      for (const g of s.groupBy) {
        const card = h('div', 'qa-item');
        if (g.group.length) card.append(h('p', '', h('strong', '', 'GROUP BY '), code(g.group.join(', '))));
        for (const x of g.having) card.append(h('p', '', h('strong', '', 'HAVING '), code(x.text), ' ', x.hasAggregate ? badge('uses an aggregate', 'badge-success') : badge('no aggregate: move to WHERE', 'badge-warn')));
        for (const x of g.nonAggregated) card.append(h('p', 'qa-warn', badge('Warning', 'badge-warn'), ' ', code(x), ` is neither aggregated nor in GROUP BY ${g.strict}`));
        pane.append(card);
      }
      heur(pane);
    }

    // ---------- ORDER BY / LIMIT ----------
    function rOrder(pane, s) {
      if (!s) return;
      if (!s.orderLimit.length) pane.append(h('p', 'qa-muted', 'No ORDER BY, LIMIT or OFFSET in this statement.'));
      for (const o of s.orderLimit) {
        const card = h('div', 'qa-item');
        for (const it of o.order) card.append(h('p', '', h('strong', '', 'ORDER BY '), code(it.text.replace(/\s+/g, ' ')), ' ', it.random ? badge('random order: sorts every row', 'badge-warn') : it.expr ? badge('expression: cannot use plain index order', 'badge-warn') : badge('plain column', 'badge-success')));
        if (o.limit) card.append(h('p', '', h('strong', '', 'LIMIT '), code(o.limit), !o.order.length ? h('span', 'qa-warn', ' ', badge('Warning', 'badge-warn'), ' without ORDER BY the returned rows are arbitrary.') : null));
        if (o.offset) card.append(h('p', '', h('strong', '', 'OFFSET '), code(o.offset), ' ', badge('deep pages are slow', 'badge-warn'), h('span', 'qa-sub', 'The database reads and discards every skipped row. Prefer keyset pagination: WHERE id > :last_id ORDER BY id LIMIT n.')));
        pane.append(card);
      }
      heur(pane);
    }

    // ---------- Indexes ----------
    function rIndex(pane, s) {
      pane.append(h('p', 'qa-banner-inline', h('strong', '', 'Heuristic suggestions - verify with EXPLAIN on your database. '), Q.INDEX_NOTE));
      if (!s) return;
      if (!s.indexSuggestions.length) pane.append(h('p', 'qa-muted', 'No candidate index found: the query has no sargable WHERE, JOIN or ORDER BY columns that can be tied to a table.'));
      for (const x of s.indexSuggestions) {
        const card = h('div', 'qa-item', h('p', '', h('strong', '', `${x.schema ? x.schema + '.' : ''}${x.table}`), x.alias ? ` (alias ${x.alias})` : ''));
        if (x.columns.length) {
          const t = h('table', 'table qa-small'); t.append(h('thead', '', h('tr', '', h('th', '', '#'), h('th', '', 'Column'), h('th', '', 'Why'))));
          const tb = h('tbody'); x.columns.forEach((c, i) => tb.append(h('tr', '', h('td', '', String(i + 1)), h('td', '', code(c.name + (c.desc ? ' DESC' : ''))), h('td', '', c.role)))); t.append(tb);
          card.append(h('div', 'table-wrap', t));
        }
        if (x.sql) card.append(codeBlock(x.sql));
        if (x.covering) card.append(h('p', 'qa-sub', `Covering variant (also stores ${x.covering.include.join(', ')} so the query can be answered from the index alone):`), codeBlock(x.covering.sql));
        for (const n of x.notes) card.append(h('p', 'qa-sub', n));
        for (const e of x.extras) { card.append(h('p', '', e.text)); if (e.sql) card.append(codeBlock(e.sql)); }
        pane.append(card);
      }
      if (s.unresolvedColumns.length) pane.append(h('p', 'qa-muted', `Not used because they could not be tied to one table (qualify them with an alias): ${s.unresolvedColumns.join(', ')}.`));
      const d = h('details', 'qa-details', h('summary', '', 'How column order is chosen, covering indexes and selectivity'));
      d.append(h('p', '', 'Columns compared with equality (including join keys, IN lists and IS NULL) go first, then at most one range column, then ORDER BY / GROUP BY columns. Only the leading columns can be used for seeking, so a composite index (a, b) helps filters on a, or on a and b, but generally not on b alone.'),
        h('p', '', 'A covering index contains every column the query reads, so the database can skip the table (index-only scan). Selectivity matters: an index on a column where most rows share one value (a boolean flag) rarely helps on its own. Each extra index also slows writes and uses disk space.'));
      pane.append(d);
    }

    // ---------- Lint ----------
    function rLint(pane, s) {
      if (s) {
        section(pane, `Findings for statement ${s.index + 1}`);
        if (!s.findings.length) pane.append(h('p', 'qa-muted', 'No anti-patterns found by the heuristic rules.'));
        const sorted = [...s.findings].sort((a, b) => (a.severity === b.severity ? a.offset - b.offset : a.severity === 'warn' ? -1 : 1));
        for (const f of sorted) {
          const card = h('div', `qa-item qa-find-${f.severity}`, jumpBtn(f, sevBadge(f.severity), ' ', h('strong', '', f.message), h('span', 'qa-sub', `${f.id} - line ${f.line}, column ${f.col}`)), h('p', '', h('em', '', 'Suggestion: '), f.suggestion));
          if (f.rewrite) { card.append(h('p', 'qa-sub', 'Mechanical rewrite:'), codeBlock(f.rewrite)); }
          pane.append(card);
        }
      }
      const det = h('details', 'qa-details', h('summary', '', 'All lint rules'));
      const ul = h('ul', 'qa-list'); for (const r of Q.allRules()) ul.append(h('li', '', sevBadge(r.severity), ' ', code(r.id), ' ', r.message)); det.append(ul); pane.append(det);
      heur(pane);
    }

    // ---------- Execution plan ----------
    function rPlan(pane, s) {
      pane.append(h('div', 'qa-banner-inline qa-strong', h('strong', '', 'This tool does NOT run queries and cannot produce a real execution plan. '), 'Use the statements below on your own database, then paste the result in the second box to look for red flags.'));
      section(pane, '1. Get a real plan from your database');
      if (!s) { pane.append(h('p', 'qa-muted', 'Enter SQL to generate a ready-to-run EXPLAIN statement.')); }
      else {
        const stmtOk = Q.EXPLAINABLE.has(s.type);
        if (!stmtOk) pane.append(h('p', 'qa-warn', badge('Note', 'badge-warn'), ` ${s.type} statements cannot be explained; pick a SELECT, INSERT, UPDATE or DELETE card.`));
        const pc = Q.planCommands(s.text, analysis.dialect);
        pane.append(h('p', '', `Dialect: ${pc.label}. ${pc.intro}`));
        for (const o of pc.options) {
          const card = h('div', 'qa-item', h('strong', '', o.title));
          if (o.warning) card.append(h('p', 'qa-warn', badge('Executes the query', 'badge-warn'), ' ', o.warning));
          card.append(codeBlock(o.sql), h('p', 'qa-sub', o.note)); pane.append(card);
        }
      }
      section(pane, '2. Paste a plan to look for red flags');
      pane.append(h('p', 'qa-sub', 'Supported: PostgreSQL EXPLAIN text or JSON, MySQL EXPLAIN table (pipe, tab or \\G format). The text stays in your browser.'));
      const ta = h('textarea', 'textarea qa-plan-input'); ta.rows = 8; ta.spellcheck = false; ta.value = planText; ta.placeholder = 'Paste EXPLAIN output here...'; ta.setAttribute('aria-label', 'EXPLAIN output to analyze');
      const out = h('div', 'qa-plan-out'); out.setAttribute('aria-live', 'polite');
      const doPlan = () => { planText = ta.value; renderPlanResult(out, planText); };
      ta.addEventListener('input', doPlan);
      const clear = h('button', 'btn btn-sm', 'Clear plan'); clear.type = 'button'; clear.addEventListener('click', () => { ta.value = ''; doPlan(); ta.focus(); });
      pane.append(ta, h('div', 'qa-row', clear), out);
      doPlan();
    }
    function renderPlanResult(out, text) {
      out.replaceChildren();
      if (!text.trim()) return;
      const plan = Q.parsePlan(text);
      if (!plan.ok) { out.append(h('p', 'qa-warn', badge('Cannot read', 'badge-warn'), ' ', plan.error)); return; }
      out.append(h('p', 'qa-note', Q.PLAN_NOTE));
      out.append(h('ul', 'qa-list', ...Q.summarizePlan(plan).map(l => h('li', '', l))));
      const flags = Q.analyzePlan(plan);
      section(out, `Red flags (${flags.length})`);
      if (!flags.length) out.append(h('p', 'qa-muted', 'No red flags found by the heuristic rules. That does not mean the plan is good.'));
      for (const f of flags) out.append(h('div', `qa-item qa-find-${f.severity}`, sevBadge(f.severity), ' ', h('strong', '', f.title), f.where ? h('span', 'qa-sub', f.where) : null, h('p', '', f.detail)));
      section(out, 'Plan');
      if (plan.format === 'mysql-table') {
        const t = h('table', 'table qa-small'); t.append(h('thead', '', h('tr', '', ...['id', 'select_type', 'table', 'type', 'key', 'rows', 'filtered', 'Extra'].map(c => h('th', '', c)))));
        const tb = h('tbody'); for (const r of plan.rows) tb.append(h('tr', '', ...[r.id, r.selectType, r.table, r.type, r.key, r.rows, r.filtered, r.extra].map(v => h('td', '', v == null ? 'NULL' : String(v))))); t.append(tb);
        out.append(h('div', 'table-wrap', t));
      } else {
        const li = n => { const e = h('li', '', h('strong', '', n.op), n.relation ? ` on ${n.relation}` : '', n.index ? ` using ${n.index}` : '', h('span', 'qa-sub', [n.rows != null ? `est. rows ${n.rows}` : null, n.actualRows != null ? `actual rows ${n.actualRows}` : null, n.loops != null ? `loops ${n.loops}` : null, n.cost != null ? `cost ${n.cost}` : null].filter(Boolean).join(' - '))); if (n.children.length) e.append(h('ul', 'qa-tree', ...n.children.map(li))); return e; };
        out.append(h('ul', 'qa-tree', li(plan.root)));
      }
    }

    // ---------- Concepts ----------
    function venn(kind) {
      const id = `qa-clip-${kind}`;
      const svg = sv('svg', { viewBox: '0 0 120 70', class: 'qa-venn', role: 'img', 'aria-label': `${kind} join: ${kind === 'INNER' ? 'only the overlap' : kind === 'LEFT' ? 'all of A plus the overlap' : kind === 'RIGHT' ? 'overlap plus all of B' : 'everything from A and B'}` });
      svg.append(sv('defs', {}, sv('clipPath', { id }, sv('circle', { cx: 45, cy: 35, r: 26 }))));
      if (kind === 'LEFT' || kind === 'FULL') svg.append(sv('circle', { cx: 45, cy: 35, r: 26, class: 'qa-fill' }));
      if (kind === 'RIGHT' || kind === 'FULL') svg.append(sv('circle', { cx: 75, cy: 35, r: 26, class: 'qa-fill' }));
      if (kind === 'INNER') svg.append(sv('circle', { cx: 75, cy: 35, r: 26, class: 'qa-fill', 'clip-path': `url(#${id})` }));
      svg.append(sv('circle', { cx: 45, cy: 35, r: 26, class: 'qa-ring' }), sv('circle', { cx: 75, cy: 35, r: 26, class: 'qa-ring' }), sv('text', { x: 30, y: 39, class: 'qa-vl' }, 'A'), sv('text', { x: 86, y: 39, class: 'qa-vl' }, 'B'));
      return svg;
    }
    function rConcepts(pane) {
      for (const g of Q.GLOSSARY) {
        const d = h('details', 'qa-details', h('summary', '', g.title), h('p', '', g.body));
        if (g.diagram) { const row = h('div', 'qa-venns'); for (const [, , kind, cap] of g.diagram) row.append(h('figure', 'qa-vfig', venn(kind), h('figcaption', '', `${kind} JOIN: ${cap}`))); d.append(row, h('p', 'qa-sub', 'CROSS JOIN has no overlap shape: every A row is paired with every B row.')); }
        if (g.id === 'joins') d.open = true;
        pane.append(d);
      }
    }

    // ---------- Export ----------
    function rExport(pane) {
      if (!analysis || !analysis.ok) { pane.append(h('p', 'qa-muted', 'Analyse some SQL first.')); return; }
      const md = Q.buildMarkdownReport(analysis), js = Q.buildJsonReport(analysis);
      const row = h('div', 'qa-row');
      const mk = (label, fn) => { const b = h('button', 'btn', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
      row.append(mk('Copy Markdown', () => copyText(md)), mk('Download .md', () => downloadFile('sql-analysis.md', md, 'text/markdown;charset=utf-8')), mk('Copy JSON', () => copyText(js)), mk('Download .json', () => downloadFile('sql-analysis.json', js, 'application/json;charset=utf-8')));
      pane.append(row, h('p', 'qa-sub', 'The report contains your SQL text and the heuristic findings; it is generated locally.'));
      const pre = h('pre', 'qa-code qa-preview'); pre.textContent = md.length > 20000 ? md.slice(0, 20000) + '\n...(preview truncated)' : md; pre.tabIndex = 0; pre.setAttribute('aria-label', 'Markdown report preview'); pane.append(pre);
    }

    // ---------- events ----------
    const on = (t, ev, fn) => { t.addEventListener(ev, fn); return () => t.removeEventListener(ev, fn); };
    const disposers = [
      on(els.input, 'input', runDebounced),
      on(els.dialect, 'change', () => { save('dialect', els.dialect.value); ed.setHighlighter(highlighter); run(); }),
      on(els.example, 'change', () => { const ex = EXAMPLES.find(e => e.id === els.example.value); if (ex) { els.input.value = ex.sql; if (ex.dialect) { els.dialect.value = ex.dialect; save('dialect', ex.dialect); ed.setHighlighter(highlighter); } sel = 0; run(); } els.example.value = ''; }),
      on($('#qa-clear'), 'click', () => { els.input.value = ''; sel = 0; run(); els.input.focus(); }),
      on($('#qa-upload'), 'click', async () => { const f = await pickFile('.sql,.txt,text/plain'); if (!f) return; try { els.input.value = await readFileAsText(f); sel = 0; run(); } catch { showMessage(els.msg, 'error', 'Could not read that file.'); } }),
    ];
    run(); renderIcons(root);
    return () => { runDebounced.cancel?.(); disposers.forEach(d => d()); ed.destroy(); };
  },
};
