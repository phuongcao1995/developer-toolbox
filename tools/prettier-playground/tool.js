// Prettier Playground UI. Prettier 3 (standalone build + per-language plugins) is loaded lazily from jsDelivr.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, withLoading,
  loadScript, debounce, renderIcons } from '../../assets/js/components/ui.js';
import { createEditor } from '../../assets/js/components/editor.js';
import { createSplit } from '../../assets/js/components/split.js';
import * as L from './logic.js';
import { SAMPLES } from './samples.js';


export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      lang: $('#pp-lang'), input: $('#pp-input'), output: $('#pp-output'), msg: $('#pp-msg'), status: $('#pp-status'), format: $('#pp-format'),
      tabWidth: $('#pp-tabwidth'), printWidth: $('#pp-printwidth'), trailing: $('#pp-trailing'), arrow: $('#pp-arrow'),
      useTabs: $('#pp-usetabs'), semi: $('#pp-semi'), single: $('#pp-single'), bracket: $('#pp-bracket'), live: $('#pp-live'),
      quoteProps: $('#pp-quoteprops'), eol: $('#pp-eol'), prose: $('#pp-prose'), bracketSame: $('#pp-bracketsame'), jsxSingle: $('#pp-jsxsingle'),
      htmlWs: $('#pp-htmlws'), embedded: $('#pp-embedded'),
    };
    for (const [id, l] of Object.entries(L.LANGUAGES)) els.lang.append(new Option(l.label, id));
    els.lang.value = ctx.storage.get('lang', 'javascript');
    if (!L.LANGUAGES[els.lang.value]) els.lang.value = 'javascript';
    // Shared editor (gutter, highlighting for json/css/html/js-family, Tab/Enter helpers, find & replace). The tool keeps its own
    // Upload/Clear/Copy/Download buttons and drop zone, so the editors only get the view tools.
    const EDITOR_LANG = { javascript: 'javascript', jsx: 'javascript', typescript: 'typescript', tsx: 'typescript', css: 'css', scss: 'scss', less: 'less', html: 'html', vue: 'html',
      json: 'json', jsonc: 'jsonc', json5: 'jsonc', yaml: 'yaml', graphql: 'graphql', markdown: 'markdown' };
    const edLang = () => EDITOR_LANG[els.lang.value] || 'plain';
    const edOpts = { language: edLang(), storage: ctx.storage, fontSize: ctx.fontSize, indentUnit: ctx.indentUnit, drop: false };
    const edIn = createEditor(els.input, edOpts);
    const edOut = createEditor(els.output, { ...edOpts, readOnly: true, toolbar: ['wrap', 'fontSize', 'find', 'fullscreen'] });
    const split = createSplit($('.pp-panels'), { direction: 'horizontal', storage: ctx.storage, storageKey: 'panels', labels: ['input', 'output'] });
    const syncLang = () => { edIn.setLanguage(edLang()); edOut.setLanguage(edLang()); };
    let disposed = false;

    // ----- options <-> form -----
    const readOptions = () => L.sanitizeOptions({
      tabWidth: els.tabWidth.value, printWidth: els.printWidth.value, trailingComma: els.trailing.value, arrowParens: els.arrow.value,
      useTabs: els.useTabs.checked, semi: els.semi.checked, singleQuote: els.single.checked, bracketSpacing: els.bracket.checked,
      quoteProps: els.quoteProps.value, endOfLine: els.eol.value, proseWrap: els.prose.value, bracketSameLine: els.bracketSame.checked,
      jsxSingleQuote: els.jsxSingle.checked, htmlWhitespaceSensitivity: els.htmlWs.value, embeddedLanguageFormatting: els.embedded.value,
    });
    const writeOptions = o => {
      els.tabWidth.value = String(o.tabWidth); els.printWidth.value = o.printWidth; els.trailing.value = o.trailingComma; els.arrow.value = o.arrowParens;
      els.useTabs.checked = o.useTabs; els.semi.checked = o.semi; els.single.checked = o.singleQuote; els.bracket.checked = o.bracketSpacing;
      els.quoteProps.value = o.quoteProps; els.eol.value = o.endOfLine; els.prose.value = o.proseWrap; els.bracketSame.checked = o.bracketSameLine;
      els.jsxSingle.checked = o.jsxSingleQuote; els.htmlWs.value = o.htmlWhitespaceSensitivity; els.embedded.value = o.embeddedLanguageFormatting;
    };
    const stored = ctx.storage.get('options', null);
    writeOptions(stored ? L.sanitizeOptions(stored) : L.defaultsFromIndent(ctx.indentUnit));
    if (!els.tabWidth.querySelector(`option[value="${els.tabWidth.value}"]`)) els.tabWidth.append(new Option(els.tabWidth.value, els.tabWidth.value));
    els.tabWidth.value = String(readOptions().tabWidth);
    els.live.checked = ctx.storage.get('live', false) === true; // 'format as I type' is remembered

    // ----- lazy Prettier loading -----
    let corePromise = null; const pluginPromises = {};
    const fail = (what, url, e) => Object.assign(new Error(`Could not load ${what} (prettier@${L.PRETTIER_VERSION}) from ${url}: ${e.message || 'network error'}. This tool needs internet access to jsDelivr the first time it formats a language.`), { cdn: true });
    const loadCore = () => (corePromise ||= loadScript(`${L.CDN_BASE}standalone.js`).catch(e => { corePromise = null; throw fail('Prettier core "standalone.js"', `${L.CDN_BASE}standalone.js`, e); }));
    const loadPlugin = name => (pluginPromises[name] ||= loadScript(L.pluginUrl(name)).catch(e => { delete pluginPromises[name]; throw fail(`plugin "${name}"`, L.pluginUrl(name), e); }));
    async function loadFor(langId) {
      await loadCore();
      await Promise.all(L.LANGUAGES[langId].plugins.map(loadPlugin));
      if (!window.prettier?.format) throw Object.assign(new Error(`Prettier core "standalone.js" (prettier@${L.PRETTIER_VERSION}) loaded from ${L.CDN_BASE}standalone.js but did not define window.prettier.`), { cdn: true });
      return L.resolvePlugins(L.LANGUAGES[langId].plugins, window);
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
          // Keep the last good output visible; the error is shown separately above.
          els.status.textContent = els.output.value ? 'The output below is from the last successful format, not from the current input.' : '';
          showMessage(els.msg, 'error', e.cdn ? e.message : L.describeError(e));
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
        if (l) { els.lang.value = l; ctx.storage.set('lang', l); syncLang(); } else toast('Unknown file type - keeping the selected language', 'info');
        els.output.value = ''; showMessage(els.msg, null);
        if (els.live.checked) format({ silent: true });
      } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const optionInputs = [els.tabWidth, els.printWidth, els.trailing, els.arrow, els.useTabs, els.semi, els.single, els.bracket,
      els.quoteProps, els.eol, els.prose, els.bracketSame, els.jsxSingle, els.htmlWs, els.embedded];
    const disposers = [
      on(els.format, 'click', () => format()),
      on(els.live, 'change', () => ctx.storage.set('live', els.live.checked)),
      on(els.lang, 'change', () => { ctx.storage.set('lang', els.lang.value); syncLang(); if (els.live.checked) format({ silent: true }); }),
      ...optionInputs.map(i => on(i, 'change', () => { ctx.storage.set('options', readOptions()); if (els.live.checked) format({ silent: true }); })),
      on(els.input, 'input', liveFormat),
      on($('#pp-sample'), 'click', () => { els.input.value = SAMPLES[els.lang.value] || ''; format(); }),
      on($('#pp-reset'), 'click', () => { const o = L.defaultsFromIndent(ctx.indentUnit); writeOptions(o); ctx.storage.set('options', o); toast('Options reset', 'success'); }),
      on($('#pp-export-rc'), 'click', () => downloadFile('.prettierrc', L.toPrettierrc(readOptions()), 'application/json;charset=utf-8')),
      on($('#pp-import-rc'), 'click', async () => {
        const f = await pickFile('.json,.prettierrc,application/json,text/plain');
        if (!f) return;
        try {
          const { options, ignored } = L.parsePrettierrc(await readFileAsText(f));
          writeOptions(options); ctx.storage.set('options', options);
          showMessage(els.msg, ignored.length ? 'warn' : 'info', ignored.length ? `Imported .prettierrc. Ignored: ${ignored.join(', ')}.` : 'Imported .prettierrc.');
          if (els.live.checked) format({ silent: true });
        } catch (e) { showMessage(els.msg, 'error', e.message); }
      }),
      on($('#pp-upload'), 'click', async () => loadFile(await pickFile('.js,.mjs,.cjs,.jsx,.ts,.tsx,.mts,.cts,.css,.scss,.less,.html,.htm,.vue,.json,.jsonc,.json5,.yaml,.yml,.graphql,.gql,.hbs,.handlebars,.md,.markdown,.txt'))),
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
    return () => { disposed = true; runId++; disposers.forEach(d => d()); split.destroy(); edIn.destroy(); edOut.destroy(); };
  },
};
