// Prettier Playground UI. Prettier 3 (standalone build + per-language plugins) is loaded lazily from jsDelivr.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, withLoading, enableTabIndent,
  loadScript, debounce, renderIcons } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import { SAMPLES } from './samples.js';

const CDN_ERROR = 'Prettier could not be loaded from the CDN. This tool needs internet access (jsDelivr) the first time it formats a language.';

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      lang: $('#pp-lang'), input: $('#pp-input'), output: $('#pp-output'), msg: $('#pp-msg'), status: $('#pp-status'), format: $('#pp-format'),
      tabWidth: $('#pp-tabwidth'), printWidth: $('#pp-printwidth'), trailing: $('#pp-trailing'), arrow: $('#pp-arrow'),
      useTabs: $('#pp-usetabs'), semi: $('#pp-semi'), single: $('#pp-single'), bracket: $('#pp-bracket'), live: $('#pp-live'),
    };
    for (const [id, l] of Object.entries(L.LANGUAGES)) els.lang.append(new Option(l.label, id));
    els.lang.value = ctx.storage.get('lang', 'javascript');
    if (!L.LANGUAGES[els.lang.value]) els.lang.value = 'javascript';
    els.input.style.fontSize = els.output.style.fontSize = `${ctx.fontSize}px`;
    enableTabIndent(els.input, ctx.indentUnit);
    let disposed = false;

    // ----- options <-> form -----
    const readOptions = () => L.sanitizeOptions({
      tabWidth: els.tabWidth.value, printWidth: els.printWidth.value, trailingComma: els.trailing.value, arrowParens: els.arrow.value,
      useTabs: els.useTabs.checked, semi: els.semi.checked, singleQuote: els.single.checked, bracketSpacing: els.bracket.checked,
    });
    const writeOptions = o => {
      els.tabWidth.value = String(o.tabWidth); els.printWidth.value = o.printWidth; els.trailing.value = o.trailingComma; els.arrow.value = o.arrowParens;
      els.useTabs.checked = o.useTabs; els.semi.checked = o.semi; els.single.checked = o.singleQuote; els.bracket.checked = o.bracketSpacing;
    };
    const stored = ctx.storage.get('options', null);
    writeOptions(stored ? L.sanitizeOptions(stored) : L.defaultsFromIndent(ctx.indentUnit));
    if (!els.tabWidth.querySelector(`option[value="${els.tabWidth.value}"]`)) els.tabWidth.append(new Option(els.tabWidth.value, els.tabWidth.value));
    els.tabWidth.value = String(readOptions().tabWidth);

    // ----- lazy Prettier loading -----
    let corePromise = null; const pluginPromises = {};
    const loadCore = () => (corePromise ||= loadScript(`${L.CDN_BASE}standalone.js`).catch(e => { corePromise = null; throw e; }));
    const loadPlugin = name => (pluginPromises[name] ||= loadScript(`${L.CDN_BASE}plugins/${name}.js`).catch(e => { delete pluginPromises[name]; throw e; }));
    async function loadFor(langId) {
      try {
        await loadCore();
        await Promise.all(L.LANGUAGES[langId].plugins.map(loadPlugin));
      } catch (e) { throw Object.assign(new Error(CDN_ERROR), { cdn: true, detail: e.message }); }
      if (!window.prettier?.format) throw Object.assign(new Error(CDN_ERROR), { cdn: true });
      return L.LANGUAGES[langId].plugins.map(n => window.prettierPlugins?.[n]).filter(Boolean);
    }

    // ----- formatting -----
    let runId = 0;
    async function format({ silent = false } = {}) {
      const code = els.input.value, langId = els.lang.value, id = ++runId;
      if (!silent) showMessage(els.msg, null);
      if (!code.trim()) {
        els.output.value = ''; els.status.textContent = '';
        if (!silent) showMessage(els.msg, 'warn', 'Enter or upload some code first.');
        return;
      }
      const job = async () => {
        const first = !window.prettier;
        if (first) els.status.textContent = 'Loading Prettier…';
        try {
          const plugins = await loadFor(langId);
          if (id !== runId || disposed) return;
          const t0 = performance.now();
          const out = await window.prettier.format(code, L.buildFormatOptions(langId, readOptions(), plugins));
          if (id !== runId || disposed) return;
          els.output.value = out;
          showMessage(els.msg, null);
          els.status.textContent = `Formatted ${L.LANGUAGES[langId].label} with Prettier ${L.PRETTIER_VERSION} in ${Math.round(performance.now() - t0)} ms.`;
        } catch (e) {
          if (id !== runId || disposed) return;
          els.status.textContent = '';
          if (e.cdn) showMessage(els.msg, 'error', e.message);
          else { els.output.value = ''; showMessage(els.msg, 'error', L.describeError(e)); }
        }
      };
      if (silent) await job(); else await withLoading(els.format, job);
    }
    const liveFormat = debounce(() => { if (els.live.checked) format({ silent: true }); }, 400);

    async function loadFile(file) {
      if (!file) return;
      try {
        els.input.value = await readFileAsText(file);
        const l = L.detectLanguageByName(file.name);
        if (l) { els.lang.value = l; ctx.storage.set('lang', l); } else toast('Unknown file type - keeping the selected language', 'info');
        els.output.value = ''; showMessage(els.msg, null);
        if (els.live.checked) format({ silent: true });
      } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const optionInputs = [els.tabWidth, els.printWidth, els.trailing, els.arrow, els.useTabs, els.semi, els.single, els.bracket];
    const disposers = [
      on(els.format, 'click', () => format()),
      on(els.lang, 'change', () => { ctx.storage.set('lang', els.lang.value); if (els.live.checked) format({ silent: true }); }),
      ...optionInputs.map(i => on(i, 'change', () => { ctx.storage.set('options', readOptions()); if (els.live.checked) format({ silent: true }); })),
      on(els.input, 'input', liveFormat),
      on($('#pp-sample'), 'click', () => { els.input.value = SAMPLES[els.lang.value] || ''; format(); }),
      on($('#pp-reset'), 'click', () => { const o = L.defaultsFromIndent(ctx.indentUnit); writeOptions(o); ctx.storage.set('options', o); toast('Options reset', 'success'); }),
      on($('#pp-upload'), 'click', async () => loadFile(await pickFile('.js,.mjs,.cjs,.jsx,.ts,.tsx,.mts,.cts,.css,.scss,.less,.html,.htm,.vue,.json,.md,.markdown,.txt'))),
      on($('#pp-clear'), 'click', () => { runId++; els.input.value = ''; els.output.value = ''; els.status.textContent = ''; showMessage(els.msg, null); els.input.focus(); }),
      on($('#pp-copy'), 'click', () => copyText(els.output.value)),
      on($('#pp-download'), 'click', () => {
        const l = L.LANGUAGES[els.lang.value];
        downloadFile(`formatted.${l.ext}`, els.output.value, `${l.mime};charset=utf-8`);
      }),
      on($('#pp-swap'), 'click', () => {
        if (!els.output.value) { toast('Nothing to move - format something first', 'warn'); return; }
        els.input.value = els.output.value; els.output.value = ''; showMessage(els.msg, null);
      }),
      on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') format(); }),
      enableDrop($('#pp-drop'), loadFile),
    ];
    renderIcons(root);
    return () => { disposed = true; runId++; disposers.forEach(d => d()); };
  },
};
