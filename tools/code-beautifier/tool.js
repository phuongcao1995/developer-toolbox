// Code Beautifier UI. Formatting uses js-beautify (lazy CDN); JSON + minifiers come from logic.js.
import { copyText, downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, withLoading,
  enableTabIndent, loadScript, formatBytes, renderIcons } from '../../assets/js/components/ui.js';
import * as L from './logic.js';

const BEAUTIFY_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.15.1/';
// html_beautify needs the css/js beautifiers loaded first (it formats inline <style>/<script>).
const LIBS = { js: ['beautify.min.js'], css: ['beautify-css.min.js'], html: ['beautify.min.js', 'beautify-css.min.js', 'beautify-html.min.js'], json: [] };
const MINIFY_NOTES = {
  html: 'HTML minify removes comments and collapses whitespace between tags (<pre>/<textarea> are untouched; inline <script>/<style> are minified too). It does not remove optional tags or shorten attributes.',
  css: 'CSS minify removes comments (except /*! banners), unnecessary whitespace and the last ; of each block. It does not merge rules or shorten values.',
  js: 'JavaScript minify only strips comments and whitespace (newlines are kept where automatic semicolon insertion could matter). It does not rename variables or compress code like Terser.',
  json: 'JSON minify removes all insignificant whitespace; the document is validated first.',
};

export default {
  mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      lang: $('#cb-lang'), indent: $('#cb-indent'), preserve: $('#cb-preserve'), input: $('#cb-input'), output: $('#cb-output'),
      msg: $('#cb-msg'), stats: $('#cb-stats'), note: $('#cb-note'), beautify: $('#cb-beautify'), minify: $('#cb-minify'),
    };
    els.indent.value = L.indentChoiceFromUnit(ctx.indentUnit);
    els.lang.value = ctx.storage.get('lang', 'js');
    els.input.style.fontSize = els.output.style.fontSize = `${ctx.fontSize}px`;
    enableTabIndent(els.input, ctx.indentUnit);

    const lang = () => els.lang.value;
    const updateNote = () => {
      els.note.textContent = `Beautify uses ${lang() === 'json' ? 'a built-in JSON formatter' : 'js-beautify (loaded from a CDN on first use)'}. Minify: ${MINIFY_NOTES[lang()]}`;
    };
    const setStats = (before, after, label) => {
      const s = L.sizeStats(before, after);
      els.stats.replaceChildren();
      const items = [[label, 'badge badge-info'], [`Before: ${formatBytes(s.before)} (${s.before} B)`, 'badge'],
        [`After: ${formatBytes(s.after)} (${s.after} B)`, 'badge'],
        [`${Math.abs(s.percent).toFixed(1)}% ${s.saved >= 0 ? 'saved' : 'larger'}`, `badge ${s.saved >= 0 ? 'badge-success' : 'badge-warn'}`]];
      for (const [text, cls] of items) {
        const b = document.createElement('span'); b.className = cls; b.textContent = text; els.stats.append(b);
      }
    };
    const clearResult = () => { els.output.value = ''; els.stats.replaceChildren(); };

    async function loadLibs(l) {
      try { for (const f of LIBS[l]) await loadScript(BEAUTIFY_BASE + f); }
      catch (e) { throw new Error(`The js-beautify library could not be loaded (${e.message}) Beautifying ${L.LANGUAGES[l].label} needs internet access; JSON formatting and all minifiers work offline.`); }
    }
    async function beautify(code, l) {
      const choice = els.indent.value, opts = L.beautifyOptions(choice, { preserveBlank: els.preserve.checked });
      if (l === 'json') return L.formatJson(code, L.indentUnitFromChoice(choice));
      await loadLibs(l);
      const fn = { js: window.js_beautify, css: window.css_beautify, html: window.html_beautify }[l];
      if (typeof fn !== 'function') throw new Error('js-beautify loaded but its API is unavailable.');
      return fn(code, l === 'html' ? { ...opts, indent_inner_html: true } : opts);
    }

    async function run(mode) {
      const code = els.input.value, l = lang();
      showMessage(els.msg, null);
      if (!code.trim()) { showMessage(els.msg, 'warn', 'Enter or upload some code first.'); clearResult(); return; }
      await withLoading(mode === 'beautify' ? els.beautify : els.minify, async () => {
        try {
          const result = mode === 'beautify' ? await beautify(code, l) : L.minify(l, code);
          els.output.value = result;
          setStats(code, result, mode === 'beautify' ? 'Beautified' : 'Minified');
          if (mode === 'minify' && l === 'js') showMessage(els.msg, 'info', 'This is a whitespace/comment stripper only. Test the result before shipping.');
        } catch (e) { clearResult(); showMessage(els.msg, 'error', e.message); }
      });
    }

    async function loadFile(file) {
      if (!file) return;
      try {
        els.input.value = await readFileAsText(file);
        const l = L.detectLanguageByName(file.name);
        if (l) { els.lang.value = l; ctx.storage.set('lang', l); updateNote(); } else toast('Unknown file type - keeping the selected language', 'info');
        clearResult(); showMessage(els.msg, null);
      } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const disposers = [
      on(els.beautify, 'click', () => run('beautify')),
      on(els.minify, 'click', () => run('minify')),
      on(els.lang, 'change', () => { ctx.storage.set('lang', lang()); updateNote(); }),
      on($('#cb-upload'), 'click', async () => loadFile(await pickFile('.html,.htm,.css,.scss,.less,.js,.mjs,.cjs,.jsx,.json,.vue,.txt'))),
      on($('#cb-clear'), 'click', () => { els.input.value = ''; clearResult(); showMessage(els.msg, null); els.input.focus(); }),
      on($('#cb-copy'), 'click', () => copyText(els.output.value)),
      on($('#cb-download'), 'click', () => {
        const { ext, mime } = L.LANGUAGES[lang()];
        downloadFile(`output.${ext}`, els.output.value, `${mime};charset=utf-8`);
      }),
      on($('#cb-swap'), 'click', () => {
        if (!els.output.value) { toast('Nothing to move - run Beautify or Minify first', 'warn'); return; }
        els.input.value = els.output.value; clearResult(); showMessage(els.msg, null);
      }),
      // Auto-detect the language when pasting into an empty editor.
      on(els.input, 'paste', e => {
        if (els.input.value.trim()) return;
        const l = L.detectLanguageByContent(e.clipboardData?.getData('text') || '');
        if (l) { els.lang.value = l; updateNote(); }
      }),
      on(root, 'keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run('beautify'); }),
      enableDrop($('#cb-drop'), loadFile),
    ];
    updateNote(); renderIcons(root);
    return () => disposers.forEach(d => d());
  },
};
