import { copyText, toast, pickFile, enableDrop, showMessage, initTabs, bindActions, readFileAsText, downloadFile, confirmDialog, debounce, el } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import * as LIB from './library.js';
import { EXPORTERS } from './exporters.js';
import { createRunner } from './runner.js';

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const patternEl = q('pattern'), textEl = q('text'), mirror = q('mirror'), replEl = q('repl');
    const flagBtns = [...root.querySelectorAll('[data-flag]')];
    flagBtns.filter(b => !L.supportsFlag(b.dataset.flag)).forEach(b => { b.disabled = true; b.hidden = true; }); // e.g. "v" on older browsers
    let dismissedRisk = null;   // pattern whose risk warning the user dismissed
    let lastResult = '';        // replace output, for copy
    let runId = 0;              // guards against out-of-order async results
    let currentTab = 'matches';
    let ready = false;
    let lastSplit = [], lastJson = '', lastExport = '';
    let loadedSample = null;    // sample text last loaded from the library / examples (safe to overwrite without asking)
    const runner = createRunner();

    // ---- State restore ----
    const first = L.EXAMPLES[0];
    const saved = (k, d) => { try { return ctx.storage.get(k, d); } catch { return d; } };
    patternEl.value = saved('pattern') ?? first.pattern;
    textEl.value = saved('text') ?? first.text;
    replEl.value = saved('repl') ?? '';
    setFlags(saved('flags') ?? first.flags);
    const persist = () => {
      try {
        ctx.storage.set('pattern', patternEl.value); ctx.storage.set('flags', getFlags()); ctx.storage.set('repl', replEl.value);
        ctx.storage.set('export', exportSel.value);
        if (textEl.value.length <= 200000) ctx.storage.set('text', textEl.value); // very large text is not persisted
      } catch { /* ignore */ }
    };
    const persistSoon = debounce(persist, 500);

    function getFlags() { return flagBtns.filter(b => b.classList.contains('active')).map(b => b.dataset.flag).join(''); }
    function setFlags(str) { flagBtns.forEach(b => { const on = !b.disabled && str.includes(b.dataset.flag); b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); }); }

    const selectTab = initTabs(root, name => { currentTab = name; if (ready && name === 'split') update(); });

    /** Select a range of an input and focus it (used by findings, explanation tokens and groups). */
    function selectRange(input, start, end) {
      if (start === undefined) return;
      input.focus();
      try { input.setSelectionRange(start, end); } catch { /* ignore */ }
    }

    // ---- Rendering ----
    function renderMirror(text, matches) {
      const frag = document.createDocumentFragment();
      for (const s of L.segmentText(text, matches)) {
        if (s.match === null) frag.append(document.createTextNode(s.text));
        else if (s.empty) frag.append(el('span', { class: 'rt-zero' }));
        else frag.append(el('mark', { class: `rt-m rt-m${s.match % 2}` }, s.text));
      }
      frag.append(document.createTextNode('​')); // keeps a trailing newline's empty line the same height as in the textarea
      mirror.replaceChildren(frag);
    }

    const span = r => (r ? ` [${r[0]}–${r[1]}]` : '');
    const undef = () => el('span', { class: 'faint' }, 'undefined');

    function renderMatches(matches) {
      const body = q('matchbody');
      body.replaceChildren();
      q('matchwrap').hidden = !matches.length;
      q('nomatch').hidden = matches.length > 0;
      matches.forEach((m, i) => {
        const groups = el('td', {});
        m.groups.forEach(g => groups.append(el('span', { class: 'rt-g' }, el('b', {}, `$${g.n}`), span(m.indices && m.indices[g.n]), ': ', g.value === undefined ? undef() : g.value)));
        if (m.named) for (const [k, v] of Object.entries(m.named)) groups.append(el('span', { class: 'rt-g' }, el('b', {}, `<${k}>`), span(m.namedIndices && m.namedIndices[k]), ': ', v === undefined ? undef() : v));
        if (!groups.childNodes.length) groups.append(el('span', { class: 'faint' }, '—'));
        const select = () => selectRange(textEl, m.index, m.end);
        body.append(el('tr', { class: 'rt-row', tabindex: '0', title: 'Select this match in the test string', onclick: select, onkeydown: e => { if (e.key === 'Enter') select(); } },
          el('td', {}, String(i + 1)),
          el('td', {}, m.end === m.index ? `${m.index}` : `${m.index}–${m.end}`),
          el('td', {}, m.text === '' ? el('span', { class: 'faint' }, '(empty match)') : m.text),
          groups));
      });
    }

    function renderExplain(pattern, flags) {
      const box = q('explain'), ruler = q('ruler'), groupsBox = q('groups');
      box.replaceChildren(); ruler.replaceChildren(); groupsBox.replaceChildren();
      q('noexplain').hidden = pattern !== '';
      if (!pattern) return;
      const toks = L.explain(pattern, flags);
      const pairs = [];
      const hl = (i, on) => { pairs[i].forEach(n => n.classList.toggle('hl', on)); };
      toks.forEach((t, i) => {
        const act = () => selectRange(patternEl, t.start, t.end);
        const row = el('div', { class: `rt-x k-${t.kind}`, tabindex: '0', role: 'button', style: `margin-left:${Math.min(t.depth, 8) * 16}px`, title: 'Select this part in the pattern', onclick: act,
          onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } } }, el('code', {}, t.token || '∅'), el('span', {}, t.desc));
        const nodes = [row];
        if (t.token) { const r = el('span', { class: `rt-tk k-${t.kind}`, onclick: act }, t.token); ruler.append(r); nodes.push(r); }
        pairs.push(nodes);
        for (const n of nodes) {
          n.addEventListener('mouseenter', () => hl(i, true)); n.addEventListener('mouseleave', () => hl(i, false));
        }
        row.addEventListener('focus', () => hl(i, true)); row.addEventListener('blur', () => hl(i, false));
        box.append(row);
      });
      const spans = L.groupSpans(pattern, flags);
      if (spans.length) {
        groupsBox.append(el('h4', { class: 'rt-h' }, 'Groups'));
        for (const g of spans) {
          const src = pattern.slice(g.start, g.end);
          const label = g.n ? `$${g.n}${g.name ? ` <${g.name}>` : ''}` : g.kind;
          groupsBox.append(el('button', { class: 'rt-group', title: 'Select this group in the pattern', onclick: () => selectRange(patternEl, g.start, g.end) },
            el('b', {}, label), el('code', {}, src.length > 70 ? src.slice(0, 67) + '…' : src)));
        }
      }
    }

    function renderReplace(res, text) {
      const err = q('replerr');
      if (!res) { lastResult = text; q('result').textContent = text; showMessage(err, null); return; }
      if (!res.ok) { showMessage(err, 'error', res.error); return; }
      showMessage(err, null); lastResult = res.result; q('result').textContent = res.result;
    }

    function renderReplDetail(diff) {
      const body = q('repldetail'); body.replaceChildren();
      const items = diff ? diff.items : [];
      q('repldetail-wrap').hidden = !items.length; q('repldetail-empty').hidden = items.length > 0;
      items.forEach((it, i) => body.append(el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, String(it.index)),
        el('td', {}, it.original === '' ? el('span', { class: 'faint' }, '(empty)') : it.original),
        el('td', {}, it.replacement === '' ? el('span', { class: 'faint' }, '(empty)') : it.replacement))));
      const more = q('repldetail-more');
      more.hidden = !(diff && diff.total > items.length);
      if (!more.hidden) more.textContent = `Showing the first ${items.length} of ${diff.total} replacements.`;
    }

    function renderSplit(res) {
      const list = q('splitlist'); list.replaceChildren();
      showMessage(q('spliterr'), res && !res.ok ? 'error' : null, res && res.error);
      lastSplit = res && res.ok ? res.parts : [];
      const shown = lastSplit.slice(0, 1000);
      shown.forEach(p => list.append(el('li', {}, p === '' ? el('span', { class: 'faint' }, '(empty string)') : el('code', {}, p))));
      q('splitcount').textContent = `${lastSplit.length} piece${lastSplit.length === 1 ? '' : 's'}${lastSplit.length > shown.length ? ` (first ${shown.length} shown)` : ''}`;
    }

    function renderJson(matches) {
      lastJson = matches.length ? JSON.stringify(L.matchesToJson(matches), null, 2) : '[]';
      q('jsonout').textContent = lastJson;
    }

    let findings = [];
    function renderLint(pattern, flags) {
      findings = L.lintRegex(pattern, flags);
      const list = q('findings'); list.replaceChildren();
      q('nomistakes').hidden = findings.length > 0 || pattern === '';
      q('nomistakes').textContent = 'No problems found.';
      q('mistakestab').textContent = findings.length ? `Mistakes (${findings.length})` : 'Mistakes';
      findings.forEach(f => {
        const has = f.start !== undefined;
        const act = () => selectRange(patternEl, f.start, f.end);
        list.append(el('li', { class: `rt-finding sev-${f.severity}` },
          el('button', { class: 'rt-finding-btn', disabled: !has, title: has ? 'Select the related part of the pattern' : 'Applies to the whole pattern', onclick: act },
            el('span', { class: `badge ${f.severity === 'error' ? 'badge-danger' : f.severity === 'warning' ? 'badge-warn' : 'badge-info'}` }, f.severity),
            el('span', { class: 'rt-finding-text' }, el('span', {}, f.message), el('span', { class: 'faint' }, `Suggestion: ${f.suggestion}`)))));
      });
    }

    /** Heuristic ReDoS warning: shown, dismissible, never blocks matching. */
    function renderRisk(pattern, flags, valid) {
      const risk = valid ? L.riskWarning(pattern, flags) : null;
      const show = !!risk && (dismissedRisk !== pattern || runner.usingFallback);
      q('risk').hidden = !show;
      if (show) {
        q('risktext').textContent = risk + (runner.usingFallback ? ' Web Workers are unavailable here, so matching runs on the page and cannot be stopped.' : ' Matching still runs, but is stopped automatically if it takes too long.');
      }
      q('dismissrisk').hidden = runner.usingFallback;
    }

    // ---- Code export ----
    const exportSel = q('exportsel');
    EXPORTERS.forEach(e => exportSel.append(el('option', { value: e.id }, e.label)));
    const savedExport = saved('export');
    exportSel.value = EXPORTERS.some(e => e.id === savedExport) ? savedExport : 'javascript';
    function renderExport(pattern, flags) {
      const warn = q('exportwarn');
      if (pattern === '') { lastExport = ''; q('exportcode').textContent = ''; showMessage(warn, null); return; }
      const ex = EXPORTERS.find(e => e.id === exportSel.value) || EXPORTERS[0];
      const r = ex.build(pattern, flags);
      lastExport = r.code; q('exportcode').textContent = r.code;
      const text = [...r.warnings, ...r.notes].join(' ');
      showMessage(warn, text ? (r.warnings.length ? 'warn' : 'info') : null, text);
    }

    function clearOutputs() { renderMatches([]); renderSplit(null); renderJson([]); renderReplDetail(null); }

    async function update() {
      const pattern = patternEl.value, flags = getFlags(), text = textEl.value;
      const my = ++runId;
      persistSoon();
      renderExplain(pattern, flags);
      renderLint(pattern, flags);
      renderExport(pattern, flags);
      const built = L.buildRegex(pattern, flags);
      const err = q('error'), limit = q('limit');
      showMessage(err, built.ok || built.empty ? null : 'error', built.error);
      showMessage(limit, null);
      renderRisk(pattern, flags, built.ok);

      if (!built.ok) { // nothing to match with
        renderMirror(text, []); clearOutputs();
        q('summary').textContent = built.empty ? '0 matches' : 'invalid';
        renderReplace(null, text);
        return;
      }
      const slow = setTimeout(() => { if (my === runId) q('summary').textContent = 'matching…'; }, 150);
      const r = await runner.run({ pattern, flags, text, replacement: replEl.value, mode: currentTab === 'split' ? 'split' : 'replace', splitLimit: q('splitlimit').value });
      clearTimeout(slow);
      if (my !== runId || r.cancelled) return;
      renderRisk(pattern, flags, true);
      if (r.timedOut) {
        const msg = `Pattern took too long and was stopped (more than ${r.timeoutMs} ms). It probably backtracks catastrophically on this text. Simplify the pattern, avoid nested quantifiers, or shorten the text.`;
        renderMirror(text, []); clearOutputs();
        q('summary').textContent = 'stopped';
        showMessage(err, 'error', msg);
        lastResult = text; q('result').textContent = text; showMessage(q('replerr'), 'error', msg);
        return;
      }
      if (!r.ok) { showMessage(err, 'error', r.error); renderMirror(text, []); clearOutputs(); q('summary').textContent = 'invalid'; renderReplace(null, text); return; }
      renderMirror(text, r.matches);
      renderMatches(r.matches);
      renderJson(r.matches);
      renderReplDetail(r.diff);
      if (currentTab === 'split' || r.split) renderSplit(r.split || { ok: true, parts: [] });
      q('summary').textContent = `${r.matches.length}${r.truncated ? '+' : ''} match${r.matches.length === 1 ? '' : 'es'}`;
      if (r.truncated) showMessage(limit, 'info', `${r.reason} Refine the pattern to see the rest.`);
      renderReplace(r.replace, text);
    }
    const updateSoon = debounce(update, 80);

    // ---- Loading patterns (examples, library, saved) ----
    const knownSamples = new Set([...L.EXAMPLES.map(e => e.text), ...LIB.LIBRARY.map(e => e.sample), '']);
    async function loadPattern({ pattern, flags, sample, name }) {
      const cur = textEl.value;
      const sampleKnown = cur.trim() === '' || knownSamples.has(cur) || cur === loadedSample || (sample !== undefined && cur === sample);
      if (sample !== undefined && !sampleKnown && !(await confirmDialog('Replace test text?', 'Loading this pattern will replace the text currently in the test string. Continue?', 'Replace'))) return;
      patternEl.value = pattern; setFlags(flags);
      if (sample !== undefined) { textEl.value = sample; loadedSample = sample; }
      selectTab('matches'); update(); toast(`Loaded: ${name}`, 'success', 1500);
    }

    // Examples list
    const exBox = q('examples');
    L.EXAMPLES.forEach(ex => exBox.append(el('button', { class: 'rt-ex', onclick: () => loadPattern({ pattern: ex.pattern, flags: ex.flags, sample: ex.text, name: ex.name }) },
      el('strong', {}, ex.name), el('code', {}, L.toLiteral(ex.pattern, ex.flags)))));

    // ---- Library ----
    const libSearch = q('libsearch'), libCat = q('libcat');
    libCat.append(el('option', { value: '' }, 'All categories'));
    LIB.libraryCategories(LIB.LIBRARY).forEach(c => libCat.append(el('option', { value: c }, c)));
    function renderLibrary() {
      const items = LIB.filterLibrary(LIB.LIBRARY, libSearch.value, libCat.value);
      q('libcount').textContent = `${items.length} of ${LIB.LIBRARY.length} patterns`;
      q('library').replaceChildren(...items.map(e => el('article', { class: 'rt-card' },
        el('div', { class: 'rt-card-head' }, el('strong', {}, e.name), el('span', { class: 'badge' }, e.category), el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm', 'aria-label': `Load ${e.name}`, onclick: () => loadPattern({ pattern: e.pattern, flags: e.flags, sample: e.sample, name: e.name }) }, 'Load')),
        el('p', {}, e.description),
        el('code', { class: 'rt-card-code' }, L.toLiteral(e.pattern, e.flags)),
        el('p', { class: 'rt-limit-note' }, el('b', {}, 'Limitations: '), e.limitations))));
      if (!items.length) q('library').append(el('div', { class: 'hint' }, 'No library pattern matches your search.'));
    }
    libSearch.addEventListener('input', renderLibrary); libCat.addEventListener('change', renderLibrary);
    renderLibrary();

    // ---- Saved patterns ----
    let mine = [];
    { const v = LIB.validateSavedList(saved('saved', [])); mine = v.items; if (v.dropped) showMessage(q('savedmsg'), 'info', `${v.dropped} invalid saved pattern${v.dropped === 1 ? ' was' : 's were'} ignored.`); }
    const persistMine = () => { try { ctx.storage.set('saved', mine); } catch { toast('Could not save (storage unavailable or full)', 'error'); } };
    function renderSaved() {
      const box = q('saved');
      if (!mine.length) { box.replaceChildren(el('div', { class: 'hint' }, 'Nothing saved yet. Enter a name above and press "Save my pattern".')); return; }
      box.replaceChildren(...mine.map(s => {
        const title = el('strong', {}, s.name);
        const rename = () => {
          const input = el('input', { class: 'input', value: s.name, maxlength: '80', 'aria-label': 'New name' });
          let done = false;
          const finish = ok => {
            if (done) return; done = true;
            const v = input.value.trim();
            if (ok && v && v !== s.name) { s.name = v.slice(0, 80); persistMine(); }
            renderSaved();
          };
          input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
          input.addEventListener('blur', () => finish(true));
          title.replaceWith(input); input.focus(); input.select();
        };
        return el('article', { class: 'rt-card' },
          el('div', { class: 'rt-card-head' }, title, el('span', { class: 'spacer' }),
            el('button', { class: 'btn btn-sm', onclick: () => loadPattern({ pattern: s.pattern, flags: s.flags, sample: s.sample || undefined, name: s.name }) }, 'Load'),
            el('button', { class: 'btn btn-sm', onclick: rename }, 'Rename'),
            el('button', { class: 'btn btn-sm btn-danger', onclick: async () => { if (await confirmDialog('Delete saved pattern?', `Delete "${s.name}"? This cannot be undone.`, 'Delete')) { mine = mine.filter(x => x !== s); persistMine(); renderSaved(); } } }, 'Delete')),
          el('code', { class: 'rt-card-code' }, L.toLiteral(s.pattern, s.flags)),
          s.notes ? el('p', {}, s.notes) : null);
      }));
    }
    renderSaved();

    // ---- Cheat sheet ----
    const chSearch = q('chsearch');
    function insertAt(input, text) {
      const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
      input.setRangeText(text, s, e, 'end');
      if (text.length > 2 && text.startsWith('(') && text.endsWith(')')) { const p = s + text.length - 1; input.setSelectionRange(p, p); }
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function useCheat(item, section) {
      if (section.title === 'Flags') {
        const b = flagBtns.find(x => x.dataset.flag === item.token);
        if (!b || b.disabled) return toast(`The "${item.token}" flag is not supported by this browser`, 'warn');
        b.click(); toast(`Flag ${item.token} ${b.classList.contains('active') ? 'on' : 'off'}`, 'info', 1200); return;
      }
      if (section.replacement) { insertAt(replEl, item.insert ?? item.token); toast('Inserted into the Replace field', 'info', 1200); return; }
      insertAt(patternEl, item.insert ?? item.token);
    }
    function renderCheat() {
      const query = chSearch.value;
      const secs = LIB.filterCheatsheet(LIB.CHEATSHEET, query);
      const frag = secs.map((s, i) => {
        const d = el('details', { class: 'rt-sec', open: query || i < 2 ? '' : null }, el('summary', {}, s.title),
          el('div', { class: 'rt-cheat' }, s.items.map(it => el('button', { class: 'rt-chit', title: 'Insert into the pattern', onclick: () => useCheat(it, s) }, el('code', {}, it.token), el('span', {}, it.desc)))));
        return d;
      });
      q('cheat').replaceChildren(...frag);
      if (!secs.length) q('cheat').append(el('div', { class: 'hint' }, 'Nothing in the cheat sheet matches.'));
    }
    chSearch.addEventListener('input', renderCheat);
    renderCheat();

    // ---- Events ----
    patternEl.addEventListener('input', updateSoon);
    textEl.addEventListener('input', updateSoon);
    replEl.addEventListener('input', updateSoon);
    q('splitlimit').addEventListener('input', updateSoon);
    exportSel.addEventListener('change', () => { renderExport(patternEl.value, getFlags()); persistSoon(); });
    flagBtns.forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('active');
      setFlags(L.resolveFlagConflict(getFlags(), b.dataset.flag)); // u and v are mutually exclusive
      update();
    }));

    const loadFile = async f => {
      if (f.size > 2 * 1024 * 1024) return toast('File is larger than 2 MB', 'error');
      try { textEl.value = await readFileAsText(f); update(); toast(`Loaded ${f.name}`, 'success'); } catch (e) { toast('Could not read file: ' + e.message, 'error'); }
    };

    bindActions(root, {
      'copy-literal'() {
        const b = L.buildRegex(patternEl.value, getFlags());
        if (!b.ok) return toast(b.empty ? 'Nothing to copy' : 'Fix the pattern first', 'warn');
        copyText(L.toLiteral(patternEl.value, getFlags()), 'Pattern copied');
      },
      'copy-export'() { if (!lastExport) return toast('Enter a pattern first', 'warn'); copyText(lastExport, 'Code copied'); },
      clear() { patternEl.value = ''; update(); patternEl.focus(); },
      'clear-text'() { textEl.value = ''; update(); textEl.focus(); },
      async upload() { const f = await pickFile('.txt,.log,.csv,.json,text/*'); if (f) loadFile(f); },
      'copy-result'() { copyText(lastResult, 'Result copied'); },
      'copy-split'() { if (!lastSplit.length) return toast('Nothing to copy', 'warn'); copyText(JSON.stringify(lastSplit, null, 2), 'Pieces copied'); },
      'copy-json'() { copyText(lastJson, 'JSON copied'); },
      'download-json'() { downloadFile('regex-matches.json', lastJson, 'application/json'); },
      'dismiss-risk'() { dismissedRisk = patternEl.value; renderRisk(patternEl.value, getFlags(), true); },
      'save-pattern'() {
        const name = q('savename').value.trim();
        if (!patternEl.value) return toast('Enter a pattern first', 'warn');
        if (!name) { q('savename').focus(); return toast('Give the pattern a name', 'warn'); }
        const s = LIB.makeSaved({ name, pattern: patternEl.value, flags: getFlags(), notes: q('savenotes').value, sample: textEl.value });
        if (!s) return toast('The pattern could not be saved', 'error');
        if (mine.length >= LIB.SAVED_LIMIT) return toast(`You can keep at most ${LIB.SAVED_LIMIT} saved patterns`, 'warn');
        mine.unshift(s); persistMine(); renderSaved();
        q('savename').value = ''; q('savenotes').value = '';
        toast(textEl.value.length > 20000 ? 'Saved (test text was cut to 20,000 characters)' : 'Pattern saved', 'success');
      },
      'export-saved'() { if (!mine.length) return toast('Nothing to export', 'warn'); downloadFile('regex-patterns.json', LIB.serializeSaved(mine), 'application/json'); },
      async 'import-saved'() {
        const f = await pickFile('.json,application/json'); if (!f) return;
        if (f.size > 1024 * 1024) return toast('File is larger than 1 MB', 'error');
        let res;
        try { res = LIB.parseSavedExport(await readFileAsText(f)); } catch (e) { return toast('Could not read file: ' + e.message, 'error'); }
        if (!res.ok) { showMessage(q('savedmsg'), 'error', res.error); return; }
        const before = mine.length;
        mine = LIB.mergeSaved(mine, res.items); persistMine(); renderSaved();
        const added = mine.length - before;
        showMessage(q('savedmsg'), 'info', `Imported ${added} pattern${added === 1 ? '' : 's'}${res.dropped ? `; ${res.dropped} invalid entr${res.dropped === 1 ? 'y was' : 'ies were'} ignored` : ''}${added < res.items.length ? '; the limit of ' + LIB.SAVED_LIMIT + ' was reached' : ''}.`);
      },
    });
    const offDrop = enableDrop(textEl.closest('.panel'), loadFile);

    update();
    ready = true;
    return () => { runId++; runner.dispose(); offDrop(); persist(); };
  },
};
