// Code Image Generator UI. Preview (DOM) and PNG export (canvas) are both driven by the same layout/highlight data.
import { downloadFile, toast, pickFile, enableDrop, readFileAsText, showMessage, withLoading, enableTabIndent,
  escapeHtml, debounce, renderIcons } from '../../assets/js/components/ui.js';
import * as L from './logic.js';
import { renderToCanvas, measureCharWidth, canvasToBlob } from './render.js';
import { SAMPLES } from './samples.js';

export default {
  async mount(root, ctx) {
    const $ = s => root.querySelector(s);
    const els = {
      code: $('#cc-code'), lang: $('#cc-lang'), theme: $('#cc-theme'), winstyle: $('#cc-winstyle'), title: $('#cc-title'),
      gradients: $('#cc-gradients'), solid: $('#cc-solid'), bgcolor: $('#cc-bgcolor'), bghex: $('#cc-bgcolor-hex'),
      padding: $('#cc-padding'), fontsize: $('#cc-fontsize'), radius: $('#cc-radius'), width: $('#cc-width'),
      autowidth: $('#cc-autowidth'), linenums: $('#cc-linenums'), shadow: $('#cc-shadow'), scale: $('#cc-scale'),
      msg: $('#cc-msg'), viewport: $('#cc-viewport'), fit: $('#cc-fit'), stage: $('#cc-stage'), info: $('#cc-info'),
    };
    let disposed = false;
    const measureCanvas = document.createElement('canvas');
    try { await document.fonts?.ready; } catch { /* ignore */ }

    // ----- state -----
    let opts = L.sanitizeOptions(ctx.storage.get('opts', {}));
    els.code.value = ctx.storage.get('code', null) ?? SAMPLES[opts.lang] ?? '';
    els.code.style.fontSize = `${ctx.fontSize}px`;
    enableTabIndent(els.code, '  ');
    for (const [id, l] of Object.entries(L.LANGUAGES)) els.lang.append(new Option(l.label, id));
    for (const [id, t] of Object.entries(L.THEMES)) els.theme.append(new Option(t.label, id));
    for (const g of L.GRADIENTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cc-swatch'; b.dataset.gradient = g.id; b.title = g.name; b.setAttribute('aria-label', `${g.name} gradient`);
      b.style.background = L.gradientCss(g); els.gradients.append(b);
    }

    // ----- control <-> option sync -----
    const outputs = { padding: 'px', fontsize: 'px', radius: 'px', width: 'px' };
    function syncControls() {
      els.lang.value = opts.lang; els.theme.value = opts.theme; els.winstyle.value = opts.windowStyle; els.title.value = opts.title;
      els.bgcolor.value = opts.bgColor; els.bghex.textContent = opts.bgColor;
      els.padding.value = opts.padding; els.fontsize.value = opts.fontSize; els.radius.value = opts.radius; els.width.value = opts.width;
      for (const k of Object.keys(outputs)) root.querySelector(`#cc-${k}-v`).textContent = `${els[k].value}${outputs[k]}`;
      els.autowidth.checked = opts.autoWidth; els.linenums.checked = opts.lineNumbers; els.shadow.checked = opts.shadow; els.scale.value = String(opts.scale);
      els.width.disabled = opts.autoWidth; els.title.disabled = opts.windowStyle === 'none';
      root.querySelectorAll('[data-bg]').forEach(b => b.classList.toggle('active', b.dataset.bg === opts.bgMode));
      root.querySelectorAll('.cc-swatch').forEach(b => { const on = b.dataset.gradient === opts.gradient; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
      els.gradients.hidden = opts.bgMode !== 'gradient'; els.solid.hidden = opts.bgMode !== 'solid';
    }
    const readControls = () => L.sanitizeOptions({
      ...opts, lang: els.lang.value, theme: els.theme.value, windowStyle: els.winstyle.value, title: els.title.value, bgColor: els.bgcolor.value,
      padding: els.padding.value, fontSize: els.fontsize.value, radius: els.radius.value, width: els.width.value,
      autoWidth: els.autowidth.checked, lineNumbers: els.linenums.checked, shadow: els.shadow.checked, scale: els.scale.value,
    });

    // ----- preview rendering -----
    let model = null; // last computed {lines, layout, opts, theme}
    const charWCache = new Map();
    const charWidth = fs => { if (!charWCache.has(fs)) charWCache.set(fs, measureCharWidth(measureCanvas, fs)); return charWCache.get(fs); };

    function buildModel() {
      const lines = L.highlight(els.code.value, opts.lang);
      const layout = L.computeLayout(lines, opts, charWidth(opts.fontSize));
      return { lines, layout, opts, theme: L.THEMES[opts.theme] };
    }
    function stageBackground(o) {
      if (o.bgMode === 'solid') return o.bgColor;
      if (o.bgMode === 'gradient') return L.gradientCss(L.GRADIENTS.find(g => g.id === o.gradient) || L.GRADIENTS[0]);
      return 'none';
    }
    function paintPreview() {
      if (disposed) return;
      model = buildModel();
      const { lines, layout, theme } = model;
      const s = L.shadowSpec(theme), win = layout.win;
      const vars = ['fg', 'ln', ...L.TOKEN_CLASSES].map(k => `--c-${k}:${k === 'fg' ? theme.fg : theme[k]}`).join(';');
      const rows = lines.map((line, i) => {
        const num = opts.lineNumbers ? `<span class="cc-ln" style="display:inline-block;width:${layout.gutter}px">${escapeHtml(L.lineNumberText(i, layout.digits))}</span>` : '';
        const toks = line.map(t => (t.cls === 'plain' ? escapeHtml(t.text) : `<span class="cc-t-${t.cls}">${escapeHtml(t.text)}</span>`)).join('');
        return `<div class="cc-line" style="height:${layout.lineH}px">${num}${toks}</div>`;
      }).join('');
      const dots = layout.titleH ? L.MAC_DOTS.map((c, i) => `<span class="cc-dot" style="left:${14 + i * 20}px;background:${c}"></span>`).join('')
        + (opts.title ? `<div class="cc-title" style="color:${theme.ln}">${escapeHtml(opts.title)}</div>` : '') : '';
      const shadow = `0 0 0 1px ${theme.border}${opts.shadow ? `, 0 ${s.offsetY}px ${s.blur}px ${s.color}` : ''}`;
      els.stage.className = `cc-stage${opts.bgMode === 'none' ? ' cc-transparent' : ''}`;
      els.stage.style.cssText = `width:${layout.stageW}px;height:${layout.stageH}px;${opts.bgMode === 'none' ? '' : `background:${stageBackground(opts)};`}`;
      els.stage.innerHTML = `<div class="cc-win" style="${vars};left:${win.x}px;top:${win.y}px;width:${win.w}px;height:${win.h}px;border-radius:${opts.radius}px;background:${theme.bg};box-shadow:${shadow}">`
        + `${dots}<div class="cc-code" style="left:${layout.codeX}px;top:${layout.codeY}px;font:${opts.fontSize}px/${layout.lineH}px ${L.FONT_STACK}">${rows}</div></div>`;
      fitPreview();
      const size = L.exportSize(layout, opts.scale);
      els.info.textContent = `Preview ${layout.stageW} x ${layout.stageH}px - export at ${opts.scale}x: ${size.w} x ${size.h}px.`;
      showMessage(els.msg, size.error ? 'warn' : null, size.error);
    }
    function fitPreview() {
      if (!model) return;
      const { stageW, stageH } = model.layout;
      const avail = Math.max(120, els.viewport.clientWidth - 26);
      const k = Math.min(1, avail / stageW);
      els.fit.style.width = `${Math.round(stageW * k)}px`; els.fit.style.height = `${Math.round(stageH * k)}px`;
      els.stage.style.transform = k < 1 ? `scale(${k})` : 'none';
    }

    // ----- export -----
    async function makeBlob() {
      const m = buildModel();
      const size = L.exportSize(m.layout, m.opts.scale);
      if (size.error) throw new Error(size.error);
      if (!els.code.value.trim()) throw new Error('Add some code first.');
      const canvas = document.createElement('canvas');
      renderToCanvas(canvas, m, m.opts.scale);
      return canvasToBlob(canvas);
    }
    const fileName = () => L.exportFileName(opts.title, opts.lang, opts.scale);

    async function download(btn) {
      await withLoading(btn, async () => {
        showMessage(els.msg, null);
        try { downloadFile(fileName(), await makeBlob(), 'image/png'); toast('PNG downloaded', 'success'); }
        catch (e) { showMessage(els.msg, 'error', `Export failed: ${e.message}`); }
      });
    }
    async function copyImage(btn) {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        toast('Your browser cannot copy images to the clipboard (needs a secure page and ClipboardItem support). Use Download PNG instead.', 'warn', 5000);
        return;
      }
      await withLoading(btn, async () => {
        showMessage(els.msg, null);
        try {
          // Passing the promise (not the blob) keeps Safari happy: the write must start inside the click gesture.
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': makeBlob() })]);
          toast('Image copied to clipboard', 'success');
        } catch (e) { showMessage(els.msg, 'error', `Could not copy the image: ${e.message || 'clipboard access was denied'}. Try Download PNG instead.`); }
      });
    }

    // ----- events -----
    const saveCode = debounce(() => ctx.storage.set('code', els.code.value), 400);
    const paintSoon = debounce(paintPreview, 50);
    function setOptions(next) {
      const prevExt = L.LANGUAGES[opts.lang].ext;
      opts = next;
      // keep the default "example.<ext>" title in sync with the language
      if (opts.title === '' || opts.title === `example.${prevExt}`) opts.title = `example.${L.LANGUAGES[opts.lang].ext}`;
      ctx.storage.set('opts', opts); syncControls(); paintPreview();
    }
    async function loadFile(file) {
      if (!file) return;
      try {
        els.code.value = await readFileAsText(file);
        const lang = L.detectLanguageByName(file.name);
        saveCode();
        setOptions({ ...opts, lang: lang || opts.lang, title: file.name });
        if (!lang) toast('Unknown file type - keeping the selected language', 'info');
      } catch { showMessage(els.msg, 'error', 'Could not read that file.'); }
    }

    const on = (target, ev, fn) => { target.addEventListener(ev, fn); return () => target.removeEventListener(ev, fn); };
    const controlEls = [els.lang, els.theme, els.winstyle, els.title, els.bgcolor, els.padding, els.fontsize, els.radius, els.width, els.autowidth, els.linenums, els.shadow, els.scale];
    const disposers = [
      ...controlEls.map(c => on(c, c.type === 'range' || c.type === 'text' || c.type === 'color' ? 'input' : 'change', () => setOptions(readControls()))),
      on(els.code, 'input', () => { saveCode(); paintSoon(); }),
      on(els.lang, 'change', () => { /* handled above; if code is still an untouched sample, swap in the new sample */
        const cur = els.code.value.trim();
        if (Object.values(SAMPLES).some(s => s.trim() === cur)) { els.code.value = SAMPLES[els.lang.value] || ''; saveCode(); paintPreview(); }
      }),
      on(root, 'click', e => {
        const bg = e.target.closest('[data-bg]'); if (bg) setOptions({ ...opts, bgMode: bg.dataset.bg });
        const gr = e.target.closest('[data-gradient]'); if (gr) setOptions({ ...opts, bgMode: 'gradient', gradient: gr.dataset.gradient });
      }),
      on($('#cc-sample'), 'click', () => { els.code.value = SAMPLES[opts.lang] || SAMPLES.plain; saveCode(); paintPreview(); }),
      on($('#cc-upload'), 'click', async () => loadFile(await pickFile('.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.html,.htm,.css,.scss,.json,.sql,.sh,.bash,.java,.cs,.go,.rs,.php,.txt'))),
      on($('#cc-clear'), 'click', () => { els.code.value = ''; saveCode(); paintPreview(); els.code.focus(); }),
      on($('#cc-download'), 'click', e => download(e.currentTarget)),
      on($('#cc-copyimg'), 'click', e => copyImage(e.currentTarget)),
      on(window, 'resize', debounce(fitPreview, 80)),
      enableDrop($('#cc-drop'), loadFile),
    ];
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(debounce(fitPreview, 60)); ro.observe(els.viewport); }

    syncControls(); paintPreview(); renderIcons(root);
    return () => { disposed = true; ro?.disconnect(); disposers.forEach(d => d()); };
  },
};
