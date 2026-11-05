/**
 * Folio — application controller.
 *
 * Wires the UI to the modules:
 *   File actions   new / open / save (.docx) / print
 *   Toolbar        formatting commands → Folio.Editor
 *   Popovers       colour palettes, line spacing, table, page layout
 *   Page view      page size & margins, estimated page boundaries, zoom
 *   Status bar     page estimate, word & character counts
 */
(function (Folio) {
  'use strict';

  const u = Folio.util;
  const ui = Folio.ui;
  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------------- */
  /* Constants                                                              */
  /* ---------------------------------------------------------------------- */
  const PAPER = { letter: [12240, 15840], a4: [11906, 16838], legal: [12240, 20160] };
  const MARGINS = {
    normal: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    narrow: { top: 720, right: 720, bottom: 720, left: 720 },
    moderate: { top: 1440, right: 1080, bottom: 1440, left: 1080 },
    wide: { top: 1440, right: 2880, bottom: 1440, left: 2880 }
  };
  const DEFAULTS = { fontFamily: 'Calibri', fontSizePt: 11, spaceAfterPt: 8, spaceBeforePt: 0, lineHeight: 1.15 };
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const FORE_COLORS = ['000000', '404040', '7F7F7F', 'A6A6A6', 'D9D9D9', 'FFFFFF', '1F3A60', '2350A0', '0070C0', '00B0F0',
    'C00000', 'FF0000', 'E36C09', 'FFC000', 'FFFF00', '92D050', '00B050', '007A5E', '7030A0', 'C0399F'];
  const HIGHLIGHT_NAMES = { yellow: 'Yellow', green: 'Bright green', cyan: 'Turquoise', magenta: 'Pink', blue: 'Blue', red: 'Red',
    darkBlue: 'Dark blue', darkCyan: 'Teal', darkGreen: 'Green', darkMagenta: 'Violet', darkRed: 'Dark red',
    darkYellow: 'Dark yellow', darkGray: 'Gray 50%', lightGray: 'Gray 25%', black: 'Black' };

  const defaultPage = () => ({ widthTw: PAPER.letter[0], heightTw: PAPER.letter[1], margins: Object.assign({}, MARGINS.normal) });

  const state = {
    page: defaultPage(),
    defaults: Object.assign({}, DEFAULTS),
    dirty: false,
    zoom: 1,
    autoZoom: true,
    markers: [],
    fromDoc: false
  };
  let editor, finder;

  /* ---------------------------------------------------------------------- */
  /* Start-up                                                               */
  /* ---------------------------------------------------------------------- */
  function init() {
    editor = new Folio.Editor($('editor'), {
      onChange: onContentChange,
      getZoom: () => state.zoom,
      contentWidthPt: () => u.twipsToPt(state.page.widthTw - state.page.margins.left - state.page.margins.right),
      onSelectionState: onSelectionState
    });
    editor.init();
    finder = new Folio.FindReplace(editor);

    buildPalettes();
    buildGridPicker();
    bindFileActions();
    bindToolbar();
    bindPopovers();
    bindLayout();
    bindZoom();
    bindDragDrop();
    bindShortcuts();

    new ResizeObserver(() => sizeStack()).observe($('page'));
    window.addEventListener('resize', u.debounce(() => { if (state.autoZoom) fitZoom(); }, 100));
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    checkLibraries();
    newDocument(true);
  }

  function checkLibraries() {
    const missing = [];
    if (typeof JSZip === 'undefined') missing.push('JSZip (needed to open and save .docx)');
    if (typeof CFB === 'undefined') missing.push('CFB (needed to read legacy .doc)');
    if (missing.length) {
      ui.notice(`<strong>Some libraries failed to load from the CDN:</strong> ${missing.join(', ')}. ` +
        'You can still type, but opening and saving files won\u2019t work. Check your internet connection and reload the page.', 'error');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Document state                                                         */
  /* ---------------------------------------------------------------------- */
  function setStatus(dirty, label) {
    state.dirty = dirty;
    $('saveState').textContent = dirty ? 'Unsaved changes' : label;
    $('saveState').classList.toggle('is-dirty', dirty);
    document.title = (dirty ? '• ' : '') + ($('docName').value || 'Untitled document') + ' — Folio';
  }

  function onContentChange() {
    if (!state.dirty) setStatus(true);
    schedulePages();
    scheduleCounts();
  }

  async function confirmDiscard() {
    if (!state.dirty) return true;
    return ui.confirm('Discard unsaved changes?',
      `Your edits to \u201C${u.escapeHtml($('docName').value)}\u201D haven\u2019t been saved as a .docx yet. If you continue, they will be lost.`,
      'Discard changes', true);
  }

  async function newDocument(skipConfirm) {
    if (!skipConfirm && !(await confirmDiscard())) return;
    u.revokeObjectUrls();
    state.page = defaultPage();
    state.defaults = Object.assign({}, DEFAULTS);
    state.fromDoc = false;
    $('docName').value = 'Untitled document';
    applyDefaults();
    applyPage();
    editor.setContent('<p><br></p>');
    ui.hideNotice();
    setStatus(false, 'New document');
    updatePages();
    updateCounts();
  }

  /* ---------------------------------------------------------------------- */
  /* Opening files                                                          */
  /* ---------------------------------------------------------------------- */
  async function openFile(file) {
    if (!file) return;
    if (!(await confirmDiscard())) return;
    const name = file.name;
    const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    if (!['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot'].includes(ext)) {
      ui.error('Unsupported file type', `\u201C${u.escapeHtml(name)}\u201D isn\u2019t a Word document. Folio opens <strong>.docx</strong> files, and <strong>.doc</strong> files as plain text.`);
      return;
    }
    if (file.size === 0) { ui.error(`Couldn\u2019t open \u201C${u.escapeHtml(name)}\u201D`, 'The file is empty (0 bytes).'); return; }
    if (file.size > MAX_FILE_BYTES) {
      ui.error(`Couldn\u2019t open \u201C${u.escapeHtml(name)}\u201D`, `The file is ${u.formatBytes(file.size)}. Folio opens files up to ${u.formatBytes(MAX_FILE_BYTES)}.`);
      return;
    }

    setBusy(true, 'Opening\u2026');
    const previousUrls = u.detachObjectUrls();
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const kind = u.sniffFormat(bytes);
      let result;
      if (kind === 'zip') result = await Folio.importDocxWithFallback(buffer);
      else if (kind === 'ole') result = Folio.importDoc(bytes);
      else if (kind === 'rtf') throw new Folio.ImportError(`This file is in Rich Text Format (RTF), even though its name ends in .${ext}. Open it in Word or LibreOffice and save it as .docx.`);
      else if (kind === 'markup') throw new Folio.ImportError('This file is a web page or Word XML file saved with a Word extension. Open it in Word or LibreOffice and save it as .docx.');
      else throw new Folio.ImportError(`This file is not a Word document, or it is damaged. Its contents don\u2019t match the .${ext} format.`);

      loadResult(result, name);
      previousUrls.forEach((url) => URL.revokeObjectURL(url));
    } catch (e) {
      u.attachObjectUrls(previousUrls);
      if (!e.userFacing) console.error(e);
      const title = `Couldn\u2019t open \u201C${u.escapeHtml(name)}\u201D`;
      if (e.userFacing) ui.error(title, e.message, e.detail);
      else ui.error(title, 'An unexpected error occurred while reading the file. It may be damaged or use features Folio doesn\u2019t support.', e.stack || String(e));
    } finally {
      setBusy(false);
    }
  }

  function loadResult(result, name) {
    state.page = result.page || defaultPage();
    state.defaults = result.defaults ? Object.assign({}, DEFAULTS, result.defaults) : Object.assign({}, DEFAULTS);
    state.fromDoc = !!result.textOnly;
    $('docName').value = name.replace(/\.(docx|docm|dotx|dotm|doc|dot)$/i, '');
    applyDefaults();
    applyPage();
    editor.setContent(result.fragment);
    setStatus(false, 'Opened from file');
    updatePages();
    updateCounts();
    if (result.warnings && result.warnings.length) {
      ui.notice(`<strong>Opened \u201C${u.escapeHtml(name)}\u201D.</strong> Some content was changed or left out:` +
        '<ul>' + result.warnings.map((w) => `<li>${u.escapeHtml(w)}</li>`).join('') + '</ul>', result.textOnly ? 'warn' : 'info');
    } else {
      ui.hideNotice();
      ui.toast(`Opened \u201C${name}\u201D`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Saving                                                                 */
  /* ---------------------------------------------------------------------- */
  async function saveDocx() {
    editor.history.flush();
    setBusy(true, 'Saving\u2026');
    try {
      const title = $('docName').value.trim() || 'Untitled document';
      const { blob, warnings } = await Folio.exportDocx($('editor'), { page: state.page, defaults: state.defaults, title });
      const fileName = u.safeFileName(title, '.docx');
      download(blob, fileName);
      setStatus(false, 'Downloaded as .docx');
      const notes = warnings.slice();
      if (state.fromDoc) notes.push('This document was opened from a .doc file and has been saved as .docx (Folio cannot write the legacy .doc format).');
      if (notes.length) ui.notice(`<strong>Saved \u201C${u.escapeHtml(fileName)}\u201D.</strong><ul>${notes.map((w) => `<li>${u.escapeHtml(w)}</li>`).join('')}</ul>`, 'info');
      else ui.toast(`Saved \u201C${fileName}\u201D to your downloads`);
    } catch (e) {
      console.error(e);
      ui.error('Couldn\u2019t save the document', u.escapeHtml(e.message || 'An unexpected error occurred while creating the .docx file.'), e.stack);
    } finally {
      setBusy(false);
    }
  }

  function download(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function setBusy(on, label) {
    document.body.classList.toggle('is-busy', on);
    if (on && label) $('saveState').textContent = label;
    else if (!on) setStatus(state.dirty, $('saveState').textContent);
  }

  /* ---------------------------------------------------------------------- */
  /* Page setup                                                             */
  /* ---------------------------------------------------------------------- */
  const px = (tw) => u.twipsToPx(tw);

  function applyDefaults() {
    const d = state.defaults, ed = $('editor');
    ed.style.setProperty('--doc-font', u.fontStack(d.fontFamily));
    ed.style.setProperty('--doc-size', d.fontSizePt + 'pt');
    ed.style.setProperty('--doc-space-after', d.spaceAfterPt + 'pt');
    ed.style.setProperty('--doc-line', String(d.lineHeight));
  }

  function applyPage() {
    const p = state.page, m = p.margins, page = $('page');
    page.style.width = px(p.widthTw) + 'px';
    page.style.minHeight = px(p.heightTw) + 'px';
    page.style.padding = `${px(m.top)}px ${px(m.right)}px ${px(m.bottom)}px ${px(m.left)}px`;

    // Reflect in the layout menu.
    const portrait = p.widthTw <= p.heightTw;
    const [sw, sh] = portrait ? [p.widthTw, p.heightTw] : [p.heightTw, p.widthTw];
    const paper = Object.keys(PAPER).find((k) => Math.abs(PAPER[k][0] - sw) < 30 && Math.abs(PAPER[k][1] - sh) < 30) || 'custom';
    $('paperSize').value = paper;
    $('orientation').value = portrait ? 'portrait' : 'landscape';
    const marg = Object.keys(MARGINS).find((k) => {
      const mm = MARGINS[k];
      return ['top', 'right', 'bottom', 'left'].every((s) => Math.abs(mm[s] - m[s]) < 30);
    }) || 'custom';
    $('marginPreset').value = marg;
    const inch = (tw) => (tw / 1440).toFixed(2).replace(/\.?0+$/, '');
    $('statPaper').textContent = paper === 'custom'
      ? `${inch(p.widthTw)} × ${inch(p.heightTw)} in`
      : $('paperSize').selectedOptions[0].textContent.replace(/\s*\(.*\)/, '') + (portrait ? '' : ', landscape');

    // Printing uses the same page size and margins.
    let style = $('printPageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'printPageStyle'; document.head.appendChild(style); }
    style.textContent = `@page { size: ${p.widthTw / 1440}in ${p.heightTw / 1440}in; margin: ${m.top / 1440}in ${m.right / 1440}in ${m.bottom / 1440}in ${m.left / 1440}in; }`;

    if (state.autoZoom) fitZoom(); else setZoom(state.zoom);
    updatePages();
  }

  function bindLayout() {
    const update = () => {
      const paper = $('paperSize').value, orient = $('orientation').value, marg = $('marginPreset').value;
      let w = state.page.widthTw, h = state.page.heightTw;
      if (PAPER[paper]) [w, h] = PAPER[paper];
      else if (w > h) [w, h] = [h, w];
      if (orient === 'landscape') [w, h] = [h, w];
      state.page.widthTw = w;
      state.page.heightTw = h;
      if (MARGINS[marg]) state.page.margins = Object.assign({}, MARGINS[marg]);
      applyPage();
      onContentChange();
    };
    ['paperSize', 'orientation', 'marginPreset'].forEach((id) => $(id).addEventListener('change', update));
  }

  /* ---------------------------------------------------------------------- */
  /* Page boundaries (estimated)                                            */
  /* ---------------------------------------------------------------------- */
  /*
   * The editor is one continuous flow, so page breaks are *estimated*: the
   * printable height per page is laid over the content, and manual page breaks
   * start a new page. Word's real layout (widow control, keep-with-next, exact
   * font metrics) can differ slightly.
   */
  const schedulePages = u.debounce(() => updatePages(), 150);

  function updatePages() {
    const p = state.page, ed = $('editor');
    const area = px(p.heightTw - p.margins.top - p.margins.bottom);
    ed.style.minHeight = '';
    const edTop = ed.getBoundingClientRect().top;
    const z = state.zoom;
    const contentH = ed.offsetHeight;
    const breaks = Array.from(ed.querySelectorAll('hr.page-break')).map((hr) => (hr.getBoundingClientRect().bottom - edTop) / z);

    const markers = [];
    let y = 0, pages = 0;
    const bounds = breaks.concat([contentH]);
    bounds.forEach((b, i) => {
      const manual = i < breaks.length;
      const n = Math.max(1, Math.ceil((b - y) / area - 0.001));
      for (let k = 1; k < n; k++) markers.push({ y: y + k * area, manual: false });
      pages += n;
      if (manual) markers.push({ y: b, manual: true });
      if (!manual) ed.style.minHeight = (y + n * area) + 'px'; // fill the last page
      y = b;
    });
    state.markers = markers;
    state.pageCount = pages;

    const layer = $('pageMarkers');
    layer.innerHTML = '';
    markers.forEach((mk, i) => {
      const el = document.createElement('div');
      el.className = 'page-marker' + (mk.manual ? ' is-manual' : '');
      el.style.top = (px(p.margins.top) + mk.y) + 'px';
      el.innerHTML = `<span>Page ${i + 2}</span>`;
      layer.appendChild(el);
    });
    updateCaretPage();
    sizeStack();
  }

  function updateCaretPage() {
    let page = 1;
    const r = editor && editor.currentRange();
    if (r) {
      const rects = r.getClientRects();
      const rect = rects.length ? rects[0] : (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement).getBoundingClientRect();
      const y = (rect.top - $('editor').getBoundingClientRect().top) / state.zoom;
      page = 1 + state.markers.filter((m) => m.y <= y + 1).length;
    }
    const total = state.pageCount || 1;
    $('statPages').textContent = `Page ${Math.min(page, total)} of ${total}`;
    $('statPages').title = 'Page boundaries are estimated; Word may break pages slightly differently.';
  }

  const scheduleCounts = u.debounce(() => updateCounts(), 300);
  function updateCounts() {
    const text = $('editor').innerText || '';
    const words = (text.match(/[^\s\u00A0]+/g) || []).length;
    const chars = text.replace(/\n/g, '').length;
    $('statWords').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    $('statChars').textContent = `${chars.toLocaleString()} characters`;
  }

  function onSelectionState(s) {
    updateCaretPage();
    const tools = $('tableTools');
    const ctx = s.inTable ? editor.tableContext() : null;
    tools.classList.toggle('is-disabled', !ctx);
    tools.querySelectorAll('button').forEach((b) => {
      b.disabled = !ctx || (ctx.merged && b.dataset.table !== 'deleteTable');
    });
    $('tableToolsNote').textContent = !ctx ? 'Place the cursor in a table to edit its rows and columns.'
      : ctx.merged ? 'This table has merged cells, so only \u201CDelete table\u201D is available.' : '';
  }

  /* ---------------------------------------------------------------------- */
  /* Zoom                                                                   */
  /* ---------------------------------------------------------------------- */
  function setZoom(z) {
    state.zoom = Math.round(z * 100) / 100;
    $('page').style.transform = state.zoom === 1 ? '' : `scale(${state.zoom})`;
    $('zoomValue').textContent = Math.round(state.zoom * 100) + '%';
    sizeStack();
    editor && editor.positionResizer();
  }

  /** The page is scaled with a transform, so its wrapper is sized explicitly. */
  function sizeStack() {
    const page = $('page'), stack = $('pageStack');
    stack.style.width = page.offsetWidth * state.zoom + 'px';
    stack.style.height = page.offsetHeight * state.zoom + 'px';
  }

  function fitZoom() {
    const avail = $('workspace').clientWidth - 32;
    const z = Math.min(1, avail / px(state.page.widthTw));
    setZoom(Math.max(0.3, z));
  }

  function bindZoom() {
    const step = (dir) => {
      state.autoZoom = false;
      const cur = state.zoom;
      const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.001) : ZOOM_STEPS.slice().reverse().find((s) => s < cur - 0.001);
      if (next) setZoom(next);
      updatePages();
    };
    $('zoomIn').addEventListener('click', () => step(1));
    $('zoomOut').addEventListener('click', () => step(-1));
    $('zoomValue').addEventListener('click', () => { state.autoZoom = true; fitZoom(); updatePages(); });
  }

  /* ---------------------------------------------------------------------- */
  /* File actions, toolbar, popovers                                        */
  /* ---------------------------------------------------------------------- */
  function bindFileActions() {
    const actions = {
      new: () => newDocument(false),
      open: () => $('fileInput').click(),
      save: () => saveDocx(),
      print: () => { editor.history.flush(); window.print(); }
    };
    document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.action]()));
    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      openFile(f);
    });
    $('docName').addEventListener('input', () => setStatus(state.dirty, $('saveState').textContent));
    $('docName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.restoreSelection(); } });
  }

  function bindToolbar() {
    const toolbar = $('toolbar');
    // Buttons must not steal the editor's selection.
    toolbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cmd]');
      if (!btn || btn.disabled) return;
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'undo': editor.undo(); break;
        case 'redo': editor.redo(); break;
        case 'indent': editor.indent(1); break;
        case 'outdent': editor.indent(-1); break;
        case 'link': editor.linkDialog(); break;
        case 'image': $('imageInput').click(); break;
        case 'pageBreak': editor.insertPageBreak(); break;
        case 'find': finder.open(false); break;
        case 'foreColor': editor.applyColor('fore', currentColors.fore); break;
        case 'hiliteColor': editor.applyColor('back', currentColors.back); break;
        default: editor.exec(cmd);
      }
    });
    $('imageInput').addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      e.target.value = '';
      editor.insertImageFiles(files);
    });
    $('blockStyle').addEventListener('change', (e) => editor.applyBlockStyle(e.target.value));
    $('fontFamily').addEventListener('change', (e) => editor.applyFont(e.target.value));
    const size = $('fontSize');
    const applySize = () => {
      const v = parseFloat(size.value);
      if (!isFinite(v) || v < 1 || v > 400) {
        ui.toast('Enter a font size between 1 and 400 points.');
        editor.updateState();
        return;
      }
      editor.applyFontSize(v);
    };
    size.addEventListener('change', applySize);
    size.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); size.blur(); } });
    size.addEventListener('focus', () => size.select());
  }

  const currentColors = { fore: '#C00000', back: '#FFFF00' };

  function buildPalettes() {
    const fore = document.querySelector('.swatches[data-target="fore"]');
    FORE_COLORS.forEach((hex) => fore.appendChild(swatch('#' + hex, '#' + hex, 'fore')));
    const back = document.querySelector('.swatches[data-target="back"]');
    Object.entries(HIGHLIGHT_NAMES).forEach(([key, label]) => back.appendChild(swatch('#' + u.HIGHLIGHTS[key], label, 'back')));
    $('foreBar').style.background = currentColors.fore;
    $('backBar').style.background = currentColors.back;

    document.querySelectorAll('[data-color-value]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.closest('#forePalette') ? 'fore' : 'back';
      pickColor(kind, b.dataset.colorValue, false);
    }));
    document.querySelectorAll('input[data-custom]').forEach((inp) => inp.addEventListener('change', () => pickColor(inp.dataset.custom, inp.value, true)));
  }

  function swatch(color, label, kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = color;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => pickColor(kind, color, true));
    return b;
  }

  function pickColor(kind, color, remember) {
    if (remember) {
      currentColors[kind] = color;
      $(kind === 'fore' ? 'foreBar' : 'backBar').style.background = color;
    }
    closePopovers();
    editor.applyColor(kind, color);
  }

  function buildGridPicker() {
    const grid = $('gridPicker');
    const label = $('gridLabel');
    for (let r = 1; r <= 8; r++) {
      for (let c = 1; c <= 10; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.setAttribute('aria-label', `${r} by ${c} table`);
        grid.appendChild(cell);
      }
    }
    grid.addEventListener('mouseover', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const R = +t.dataset.r, C = +t.dataset.c;
      grid.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', +b.dataset.r <= R && +b.dataset.c <= C));
      label.textContent = `Insert ${R} × ${C} table`;
    });
    grid.addEventListener('mouseleave', () => {
      grid.querySelectorAll('.is-on').forEach((b) => b.classList.remove('is-on'));
      label.textContent = 'Insert table';
    });
    grid.addEventListener('mousedown', (e) => e.preventDefault());
    grid.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      closePopovers();
      editor.insertTable(+t.dataset.r, +t.dataset.c);
    });
    $('tblInsert').addEventListener('click', () => {
      const r = parseInt($('tblRows').value, 10), c = parseInt($('tblCols').value, 10);
      if (!(r >= 1 && r <= 100 && c >= 1 && c <= 20)) { ui.toast('Use 1–100 rows and 1–20 columns.'); return; }
      closePopovers();
      editor.insertTable(r, c);
    });
    document.querySelectorAll('[data-table]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { closePopovers(); editor.tableAction(b.dataset.table); });
    });
  }

  let openPopover = null;
  function bindPopovers() {
    document.querySelectorAll('[data-popover]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = $(btn.dataset.popover);
        if (openPopover === pop) { closePopovers(); return; }
        closePopovers();
        if (btn.dataset.popover === 'tableMenu') onSelectionState({ inTable: !!editor.closestInEditor('td,th') });
        pop.hidden = false;
        const r = btn.getBoundingClientRect();
        const w = pop.offsetWidth;
        pop.style.top = r.bottom + 6 + 'px';
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        btn.setAttribute('aria-expanded', 'true');
        openPopover = pop;
        openPopover.trigger = btn;
      });
    });
    document.querySelectorAll('[data-spacing]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { closePopovers(); editor.applyLineSpacing(parseFloat(b.dataset.spacing)); });
    });
    document.addEventListener('mousedown', (e) => {
      if (openPopover && !openPopover.contains(e.target) && !e.target.closest('[data-popover]')) closePopovers();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPopover) { closePopovers(); editor.restoreSelection(); } });
  }

  function closePopovers() {
    if (!openPopover) return;
    openPopover.hidden = true;
    if (openPopover.trigger) openPopover.trigger.setAttribute('aria-expanded', 'false');
    openPopover = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Drag & drop and keyboard shortcuts                                     */
  /* ---------------------------------------------------------------------- */
  function bindDragDrop() {
    const ws = $('workspace');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    ws.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('dropHint').hidden = false; });
    ws.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('dropHint').hidden = true; });
    ws.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    ws.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('dropHint').hidden = true;
      const files = Array.from(e.dataTransfer.files);
      const images = files.filter((f) => f.type.startsWith('image/'));
      if (images.length) {
        // Drop images where the pointer is.
        const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
        if (r && editor.inEditor(r.startContainer)) {
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(r);
          editor.savedRange = r.cloneRange();
        }
        editor.insertImageFiles(images);
      } else if (files[0]) openFile(files[0]);
    });
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 's' && !e.altKey) { e.preventDefault(); saveDocx(); }
      else if (k === 'o' && !e.altKey) { e.preventDefault(); $('fileInput').click(); }
      else if (k === 'f' && !e.altKey) { e.preventDefault(); finder.open(false); }
      else if (k === 'h' && !e.altKey) { e.preventDefault(); finder.open(true); }
      else if (k === 'n' && e.altKey) { e.preventDefault(); newDocument(false); }
    });
  }

  // Expose for tests and debugging.
  Folio.app = { state, openFile, saveDocx, newDocument, get editor() { return editor; } };

  document.addEventListener('DOMContentLoaded', init);
})(window.Folio = window.Folio || {});
