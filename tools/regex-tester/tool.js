import { copyText, toast, pickFile, enableDrop, showMessage, initTabs, bindActions, readFileAsText, debounce, el } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

export default {
  mount(root, ctx) {
    const q = n => root.querySelector(`[data-el="${n}"]`);
    const patternEl = q('pattern'), textEl = q('text'), mirror = q('mirror'), replEl = q('repl');
    const flagBtns = [...root.querySelectorAll('[data-flag]')];
    let forceRun = false;       // user chose to run a pattern flagged as risky
    let lastKey = '';           // pattern+flags of the previous run (to reset forceRun)
    let lastResult = '';        // replace output, for copy

    // ---- State restore ----
    const first = L.EXAMPLES[0];
    const saved = k => { try { return ctx.storage.get(k); } catch { return undefined; } };
    patternEl.value = saved('pattern') ?? first.pattern;
    textEl.value = saved('text') ?? first.text;
    replEl.value = saved('repl') ?? '';
    setFlags(saved('flags') ?? first.flags);
    const persist = () => { try { ctx.storage.set('pattern', patternEl.value); ctx.storage.set('flags', getFlags()); ctx.storage.set('text', textEl.value.slice(0, 200000)); ctx.storage.set('repl', replEl.value); } catch { /* ignore */ } };

    function getFlags() { return flagBtns.filter(b => b.classList.contains('active')).map(b => b.dataset.flag).join(''); }
    function setFlags(str) { flagBtns.forEach(b => { const on = str.includes(b.dataset.flag); b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); }); }

    const selectTab = initTabs(root);

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

    function renderMatches(matches) {
      const body = q('matchbody');
      body.replaceChildren();
      q('matchwrap').hidden = !matches.length;
      q('nomatch').hidden = matches.length > 0;
      matches.forEach((m, i) => {
        const groups = el('td', {});
        m.groups.forEach(g => groups.append(el('span', { class: 'rt-g' }, el('b', {}, `$${g.n}`), ': ', g.value === undefined ? el('span', { class: 'faint' }, 'undefined') : g.value)));
        if (m.named) for (const [k, v] of Object.entries(m.named)) groups.append(el('span', { class: 'rt-g' }, el('b', {}, `<${k}>`), ': ', v === undefined ? el('span', { class: 'faint' }, 'undefined') : v));
        if (!groups.childNodes.length) groups.append(el('span', { class: 'faint' }, '—'));
        body.append(el('tr', {},
          el('td', {}, String(i + 1)),
          el('td', {}, m.end === m.index ? `${m.index}` : `${m.index}–${m.end}`),
          el('td', {}, m.text === '' ? el('span', { class: 'faint' }, '(empty match)') : m.text),
          groups));
      });
    }

    function renderExplain(pattern, flags) {
      const box = q('explain');
      box.replaceChildren();
      q('noexplain').hidden = pattern !== '';
      if (!pattern) return;
      for (const t of L.explain(pattern, flags)) {
        box.append(el('div', { class: `rt-x k-${t.kind}`, style: `margin-left:${Math.min(t.depth, 8) * 16}px` }, el('code', {}, t.token || '∅'), el('span', {}, t.desc)));
      }
    }

    function renderReplace(re, text) {
      const err = q('replerr');
      if (!re) { lastResult = text; q('result').textContent = text; showMessage(err, null); return; }
      const r = L.replaceAll(re, text, replEl.value);
      if (!r.ok) { showMessage(err, 'error', r.error); return; }
      showMessage(err, null); lastResult = r.result; q('result').textContent = r.result;
    }

    function update() {
      const pattern = patternEl.value, flags = getFlags(), text = textEl.value;
      const key = pattern + '/' + flags;
      if (key !== lastKey) { forceRun = false; lastKey = key; }
      persist();
      renderExplain(pattern, flags);
      const built = L.buildRegex(pattern, flags);
      const risk = built.ok ? L.riskWarning(pattern) : null;
      const err = q('error'), limit = q('limit');
      showMessage(err, built.ok || built.empty ? null : 'error', built.error);
      q('risk').hidden = !(risk && !forceRun);
      if (risk && !forceRun) q('risktext').textContent = risk + ' Matching is paused until you click "Run anyway".';
      showMessage(limit, null);

      if (!built.ok || (risk && !forceRun)) { // nothing to match with
        renderMirror(text, []); renderMatches([]);
        q('summary').textContent = built.ok ? 'paused' : built.empty ? '0 matches' : 'invalid';
        renderReplace(null, text);
        return;
      }
      const { matches, truncated, reason } = L.findMatches(built.regex, text);
      renderMirror(text, matches);
      renderMatches(matches);
      q('summary').textContent = `${matches.length}${truncated ? '+' : ''} match${matches.length === 1 ? '' : 'es'}`;
      if (truncated) showMessage(limit, 'info', `${reason} Refine the pattern to see the rest.`);
      renderReplace(built.regex, text);
    }
    const updateSoon = debounce(update, 80);

    // ---- Events ----
    patternEl.addEventListener('input', updateSoon);
    textEl.addEventListener('input', updateSoon);
    replEl.addEventListener('input', updateSoon);
    flagBtns.forEach(b => b.addEventListener('click', () => { b.classList.toggle('active'); b.setAttribute('aria-pressed', b.classList.contains('active')); update(); }));

    // Examples list
    const exBox = q('examples');
    L.EXAMPLES.forEach(ex => exBox.append(el('button', { class: 'rt-ex', onclick: () => {
      patternEl.value = ex.pattern; textEl.value = ex.text; setFlags(ex.flags);
      selectTab('matches'); update(); toast(`Loaded: ${ex.name}`, 'success', 1500);
    } }, el('strong', {}, ex.name), el('code', {}, L.toLiteral(ex.pattern, ex.flags)))));

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
      clear() { patternEl.value = ''; update(); patternEl.focus(); },
      'clear-text'() { textEl.value = ''; update(); textEl.focus(); },
      async upload() { const f = await pickFile('.txt,.log,.csv,.json,text/*'); if (f) loadFile(f); },
      'copy-result'() { copyText(lastResult, 'Result copied'); },
      'run-anyway'() { forceRun = true; update(); },
    });
    const offDrop = enableDrop(textEl.closest('.panel'), loadFile);

    update();
    return () => offDrop();
  },
};
