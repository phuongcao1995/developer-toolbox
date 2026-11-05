/**
 * Folio — .docx exporter.
 *
 * Walks the editor's DOM and writes a WordprocessingML package with JSZip:
 *
 *   [Content_Types].xml
 *   _rels/.rels
 *   docProps/core.xml, docProps/app.xml
 *   word/document.xml        body content + page setup (sectPr)
 *   word/styles.xml          Normal, Heading 1–6, Quote, Hyperlink
 *   word/numbering.xml       one list definition per top-level list
 *   word/settings.xml
 *   word/_rels/document.xml.rels
 *   word/media/imageN.*      embedded pictures
 *
 * Element order inside rPr / pPr / tcPr follows the ECMA-376 schema, because
 * Microsoft Word reports files with out-of-order properties as corrupt.
 */
(function (Folio) {
  'use strict';

  const u = Folio.util;
  const esc = u.escapeXml;

  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI',
    'TABLE', 'HR', 'ADDRESS', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'FIGURE', 'FIGCAPTION', 'CENTER',
    'DL', 'DT', 'DD', 'NAV', 'ASIDE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'IFRAME',
    'OBJECT', 'EMBED', 'NOSCRIPT', 'svg', 'CANVAS', 'VIDEO', 'AUDIO', 'COLGROUP', 'COL']);

  const isBlock = (n) => n.nodeType === 1 && BLOCK_TAGS.has(n.tagName);
  const hasBlockChild = (el) => Array.from(el.children).some(isBlock);

  const NS_DOC = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

  // Heading geometry shared with css/document.css (keep the two in sync).
  const HEADINGS = [
    { size: 20, before: 18, after: 6 },
    { size: 16, before: 14, after: 4 },
    { size: 14, before: 12, after: 4 },
    { size: 12, before: 10, after: 2 },
    { size: 11, before: 10, after: 2 },
    { size: 11, before: 10, after: 2 }
  ];
  const HEADING_COLOR = '1F3A60';

  const FONT_KEYWORDS = { 'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36 };
  const FONT_TAG_SIZES = [null, 8, 10, 12, 14, 18, 24, 36];
  const OL_FORMATS = { '1': 'decimal', a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman' };
  const LEVEL_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];
  const BULLETS = ['\u2022', '\u25E6', '\u25AA'];

  class DocxWriter {
    /**
     * @param {object} opts
     * @param {object} opts.page     { widthTw, heightTw, margins:{top,right,bottom,left} } in twips
     * @param {object} opts.defaults { fontFamily, fontSizePt, spaceAfterPt, lineHeight }
     * @param {string} opts.title
     */
    constructor(opts) {
      this.page = opts.page;
      this.defaults = opts.defaults;
      this.title = opts.title || 'Document';
      this.rels = [];
      this.nextRel = 4;     // rId1–3 are reserved for styles, numbering, settings
      this.media = [];
      this.abstractNums = [];
      this.nextDocPr = 1;
      this.warnings = new Set();
      this.contentWidthTw = this.page.widthTw - this.page.margins.left - this.page.margins.right;
    }

    addRel(type, target, external) {
      const id = 'rId' + this.nextRel++;
      this.rels.push({ id, type: REL + type, target, external });
      return id;
    }

    /* ================================================================== */
    /* Block level                                                        */
    /* ================================================================== */
    async blocks(node, ctx) {
      let xml = '';
      let inline = [];
      const flush = async () => {
        if (!inline.length) return;
        const meaningful = inline.some((n) => n.nodeType === 1 || n.data.replace(/[\s\u200B]/g, '') !== '');
        if (meaningful) xml += await this.paragraph(inline, ctx.blockEl, ctx);
        inline = [];
      };
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && SKIP_TAGS.has(child.tagName)) continue;
        if (isBlock(child)) {
          await flush();
          xml += await this.block(child, ctx);
        } else if (child.nodeType === 1 || child.nodeType === 3) {
          inline.push(child);
        }
      }
      await flush();
      return xml;
    }

    async block(el, ctx) {
      const tag = el.tagName;
      if (tag === 'UL' || tag === 'OL') return this.list(el, ctx);
      if (tag === 'TABLE') return this.table(el, ctx);
      if (tag === 'HR') {
        if (el.classList.contains('page-break')) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
        return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
      }
      if (['THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION'].includes(tag)) return this.blocks(el, ctx);

      const sub = Object.assign({}, ctx, { blockEl: el });
      const h = tag.match(/^H([1-6])$/);
      if (h) sub.style = 'Heading' + h[1];
      else if (tag === 'BLOCKQUOTE') sub.style = 'Quote';
      if (tag === 'PRE') sub.baseFmt = Object.assign({}, ctx.baseFmt, { font: 'Courier New' });
      if (tag === 'DT') sub.baseFmt = Object.assign({}, ctx.baseFmt, { bold: true });
      const align = this.alignOf(el);
      if (align) sub.align = align;

      if (hasBlockChild(el)) return this.blocks(el, sub);
      return this.paragraph(Array.from(el.childNodes), el, sub);
    }

    alignOf(el) {
      const a = (el.style && el.style.textAlign) || el.getAttribute('align') || (el.tagName === 'CENTER' ? 'center' : '');
      return a ? a.toLowerCase() : null;
    }

    /* ---------- paragraph ---------- */
    async paragraph(nodes, el, ctx) {
      let fmt = Object.assign({}, ctx.baseFmt || {});
      if (el && el.style) fmt = this.fmtFromStyle(el, fmt);
      let runs = '';
      const pctx = Object.assign({}, ctx, { paraRoot: el });
      for (const n of nodes) runs += await this.inline(n, fmt, pctx);
      return '<w:p>' + this.pPr(el, ctx) + runs + '</w:p>';
    }

    pPr(el, ctx) {
      let x = '';
      if (ctx.style) x += `<w:pStyle w:val="${ctx.style}"/>`;
      let listIndent = null;
      if (ctx.list) {
        if (!ctx.list.used) {
          x += `<w:numPr><w:ilvl w:val="${ctx.list.ilvl}"/><w:numId w:val="${ctx.list.numId}"/></w:numPr>`;
          ctx.list.used = true;
        } else {
          listIndent = 720 * (ctx.list.ilvl + 1); // continuation paragraph inside a list item
        }
      }

      const st = el && el.style ? el.style : null;
      const base = this.defaults.fontSizePt;
      // Spacing
      let before = null, after = null, line = null, rule = 'auto';
      if (st) {
        if (st.marginTop) { const v = u.cssLengthToPt(st.marginTop, base); if (v !== null) before = u.ptToTwips(Math.max(0, v)); }
        if (st.marginBottom) { const v = u.cssLengthToPt(st.marginBottom, base); if (v !== null) after = u.ptToTwips(Math.max(0, v)); }
        const lh = st.lineHeight;
        if (lh && lh !== 'normal') {
          if (/^[\d.]+$/.test(lh)) line = Math.round(parseFloat(lh) * 240);
          else if (/%$/.test(lh)) line = Math.round(parseFloat(lh) / 100 * 240);
          else { const v = u.cssLengthToPt(lh, base); if (v !== null) { line = u.ptToTwips(v); rule = 'atLeast'; } }
        }
      }
      if (after === null && (ctx.list || ctx.inTable)) after = 0;
      if (before !== null || after !== null || line !== null) {
        x += '<w:spacing' + (before !== null ? ` w:before="${before}"` : '') + (after !== null ? ` w:after="${after}"` : '') +
          (line !== null ? ` w:line="${line}" w:lineRule="${rule}"` : '') + '/>';
      }

      // Indentation (lists take their geometry from numbering.xml)
      let left = listIndent, first = null;
      if (st && !ctx.list) {
        if (st.marginLeft) { const v = u.cssLengthToPt(st.marginLeft, base); if (v) left = u.ptToTwips(v); }
        if (st.textIndent) { const v = u.cssLengthToPt(st.textIndent, base); if (v) first = u.ptToTwips(v); }
      }
      if (left !== null || first !== null) {
        x += '<w:ind' + (left !== null ? ` w:left="${Math.max(0, left)}"` : '') +
          (first !== null ? (first >= 0 ? ` w:firstLine="${first}"` : ` w:hanging="${-first}"`) : '') + '/>';
      }

      // Alignment (inherited from ancestors such as <div style="text-align:center">)
      const align = (el && this.alignOf(el)) || ctx.align;
      const jc = { center: 'center', right: 'right', end: 'right', justify: 'both' }[align];
      if (jc) x += `<w:jc w:val="${jc}"/>`;

      return x ? '<w:pPr>' + x + '</w:pPr>' : '';
    }

    /* ================================================================== */
    /* Inline level                                                       */
    /* ================================================================== */
    async inline(n, fmt, ctx) {
      if (n.nodeType === 3) return this.textRun(n.data, fmt, ctx);
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) return '';
      const tag = n.tagName;
      if (tag === 'BR') {
        if (ctx.paraRoot && this.isTrailingBr(n, ctx.paraRoot)) return '';
        return '<w:r>' + this.rPr(fmt, !!ctx.link) + '<w:br/></w:r>';
      }
      if (tag === 'IMG') return this.imageRun(n, ctx);
      if (tag === 'A' && n.getAttribute('href') && !ctx.link) {
        const href = n.getAttribute('href').trim();
        const sub = Object.assign({}, ctx, { link: href });
        const f2 = this.fmtFromElement(n, fmt);
        let inner = '';
        for (const c of n.childNodes) inner += await this.inline(c, f2, sub);
        if (!inner) return '';
        if (href.startsWith('#')) return `<w:hyperlink w:anchor="${esc(href.slice(1))}" w:history="1">${inner}</w:hyperlink>`;
        if (/^(javascript|data|vbscript):/i.test(href)) return inner;
        const rid = this.addRel('hyperlink', href, true);
        return `<w:hyperlink r:id="${rid}" w:history="1">${inner}</w:hyperlink>`;
      }
      const f2 = this.fmtFromElement(n, fmt);
      let out = '';
      for (const c of n.childNodes) out += await this.inline(c, f2, ctx);
      return out;
    }

    /** A <br> that only exists to keep an empty line visible in the editor. */
    isTrailingBr(br, root) {
      const r = document.createRange();
      r.setStartAfter(br);
      r.setEnd(root, root.childNodes.length);
      if (r.toString().replace(/\u200B/g, '').length) return false;
      return !r.cloneContents().querySelector('img, br');
    }

    textRun(text, fmt, ctx) {
      const t = text.replace(/[\u200B\uFEFF]/g, '').replace(/\r\n?/g, '\n');
      if (!t) return '';
      let content = '';
      for (const part of t.split(/(\t|\n)/)) {
        if (part === '\t') content += '<w:tab/>';
        else if (part === '\n') content += '<w:br/>';
        else if (part) content += `<w:t xml:space="preserve">${esc(part)}</w:t>`;
      }
      return content ? '<w:r>' + this.rPr(fmt, !!ctx.link) + content + '</w:r>' : '';
    }

    /* ---------- formatting extraction ---------- */
    fmtFromElement(el, parent) {
      const f = Object.assign({}, parent);
      switch (el.tagName) {
        case 'B': case 'STRONG': f.bold = true; break;
        case 'I': case 'EM': case 'CITE': case 'DFN': case 'VAR': f.italic = true; break;
        case 'U': case 'INS': f.underline = true; break;
        case 'S': case 'STRIKE': case 'DEL': f.strike = true; break;
        case 'SUP': f.vert = 'super'; break;
        case 'SUB': f.vert = 'sub'; break;
        case 'MARK': f.bg = 'FFFF00'; break;
        case 'CODE': case 'KBD': case 'SAMP': case 'TT': f.font = 'Courier New'; break;
        case 'TH': f.bold = true; break;
        case 'FONT': {
          const c = u.colorToHex(el.getAttribute('color')); if (c) f.color = c;
          const face = u.firstFontFamily(el.getAttribute('face')); if (face) f.font = face;
          const sz = parseInt(el.getAttribute('size'), 10); if (FONT_TAG_SIZES[sz]) f.size = FONT_TAG_SIZES[sz];
          break;
        }
        default: break;
      }
      return this.fmtFromStyle(el, f);
    }

    fmtFromStyle(el, f) {
      const s = el.style;
      if (!s || !s.length) return f;
      f = Object.assign({}, f);
      if (s.fontWeight) { const w = s.fontWeight; f.bold = w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 600; }
      if (s.fontStyle) f.italic = s.fontStyle === 'italic' || s.fontStyle === 'oblique';
      const deco = s.textDecorationLine || s.textDecoration || '';
      if (deco.includes('underline')) f.underline = true;
      if (deco.includes('line-through')) f.strike = true;
      if (s.color) { const c = u.colorToHex(s.color); if (c) f.color = c; }
      if (s.backgroundColor) f.bg = u.colorToHex(s.backgroundColor);
      if (s.fontSize) {
        const kw = FONT_KEYWORDS[s.fontSize];
        const pt = kw || u.cssLengthToPt(s.fontSize, f.size || this.defaults.fontSizePt);
        if (pt && pt > 0) f.size = u.roundHalf(Math.min(pt, 1638));
      }
      if (s.fontFamily) { const fam = u.firstFontFamily(s.fontFamily); if (fam) f.font = fam; }
      if (s.verticalAlign === 'super' || s.verticalAlign === 'sub') f.vert = s.verticalAlign;
      else if (s.verticalAlign === 'baseline') f.vert = null;
      return f;
    }

    /** Run properties, in schema order. */
    rPr(f, isLink) {
      const d = this.defaults;
      let x = '';
      if (isLink) x += '<w:rStyle w:val="Hyperlink"/>';
      if (f.font && f.font.toLowerCase() !== d.fontFamily.toLowerCase()) {
        const n = esc(f.font);
        x += `<w:rFonts w:ascii="${n}" w:hAnsi="${n}" w:eastAsia="${n}" w:cs="${n}"/>`;
      }
      if (f.bold === true) x += '<w:b/><w:bCs/>';
      else if (f.bold === false) x += '<w:b w:val="0"/><w:bCs w:val="0"/>';
      if (f.italic === true) x += '<w:i/><w:iCs/>';
      else if (f.italic === false) x += '<w:i w:val="0"/><w:iCs w:val="0"/>';
      if (f.strike) x += '<w:strike/>';
      if (f.color) x += `<w:color w:val="${f.color}"/>`;
      if (f.size && f.size !== d.fontSizePt) { const hp = Math.round(f.size * 2); x += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`; }
      const hl = f.bg ? u.highlightNameForHex(f.bg) : null;
      if (hl) x += `<w:highlight w:val="${hl}"/>`;
      if (f.underline) x += '<w:u w:val="single"/>';
      if (f.bg && !hl) x += `<w:shd w:val="clear" w:color="auto" w:fill="${f.bg}"/>`;
      if (f.vert === 'super') x += '<w:vertAlign w:val="superscript"/>';
      else if (f.vert === 'sub') x += '<w:vertAlign w:val="subscript"/>';
      return x ? '<w:rPr>' + x + '</w:rPr>' : '';
    }

    /* ================================================================== */
    /* Lists                                                              */
    /* ================================================================== */
    async list(listEl, ctx) {
      const ilvl = ctx.list ? Math.min(ctx.list.ilvl + 1, 8) : 0;
      const numId = ctx.list ? ctx.list.numId : this.createNumbering(listEl);
      let xml = '';
      for (const child of listEl.childNodes) {
        if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
          // Chrome nests lists as siblings of <li> when indenting.
          xml += await this.list(child, Object.assign({}, ctx, { list: { numId, ilvl, used: true } }));
          continue;
        }
        if (child.nodeType === 3 && !child.data.trim()) continue;
        const item = child.nodeType === 1 && child.tagName === 'LI' ? child : null;
        const sub = Object.assign({}, ctx, { blockEl: item, list: { numId, ilvl, used: false }, style: null, align: null });
        if (item) {
          const a = this.alignOf(item); if (a) sub.align = a;
          let x = hasBlockChild(item) ? await this.blocks(item, sub) : await this.paragraph(Array.from(item.childNodes), item, sub);
          if (!sub.list.used) x = '<w:p>' + this.pPr(null, sub) + '</w:p>' + x; // empty item
          xml += x;
        } else {
          xml += await this.paragraph([child], null, sub);
        }
      }
      return xml;
    }

    /** Create an abstract numbering definition matching this list's nesting. */
    createNumbering(listEl) {
      const specs = [];
      const scan = (list, depth) => {
        if (depth > 8) return;
        if (!specs[depth]) {
          specs[depth] = {
            bullet: list.tagName === 'UL',
            type: list.getAttribute('type'),
            start: depth === 0 ? (parseInt(list.getAttribute('start'), 10) || 1) : 1
          };
        }
        for (const c of list.children) {
          if (c.tagName === 'UL' || c.tagName === 'OL') scan(c, depth + 1);
          else if (c.tagName === 'LI') for (const cc of c.querySelectorAll(':scope > ul, :scope > ol')) scan(cc, depth + 1);
        }
      };
      scan(listEl, 0);
      const topBullet = specs[0].bullet;
      let levels = '';
      for (let d = 0; d < 9; d++) {
        const s = specs[d] || { bullet: topBullet, type: null, start: 1 };
        const fmt = s.bullet ? 'bullet' : (OL_FORMATS[s.type] || LEVEL_FORMATS[d % 3]);
        const text = s.bullet ? BULLETS[d % 3] : `%${d + 1}.`;
        levels += `<w:lvl w:ilvl="${d}"><w:start w:val="${s.start}"/><w:numFmt w:val="${fmt}"/>` +
          `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${720 * (d + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
      }
      const id = this.abstractNums.length;
      this.abstractNums.push(`<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`);
      return id + 1; // numId (1-based)
    }

    numberingXml() {
      const nums = this.abstractNums.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`).join('');
      return XML_HEAD + `<w:numbering ${NS_W}>${this.abstractNums.join('')}${nums}</w:numbering>`;
    }

    /* ================================================================== */
    /* Tables                                                             */
    /* ================================================================== */
    async table(tableEl, ctx) {
      const rows = Array.from(tableEl.rows).filter((r) => r.closest('table') === tableEl);
      if (!rows.length) return '';

      // Build an occupancy grid so rowspan / colspan map onto Word's grid model.
      const grid = [];
      rows.forEach((row, r) => {
        grid[r] = grid[r] || [];
        let c = 0;
        for (const cell of row.cells) {
          while (grid[r][c]) c++;
          const rs = Math.max(1, cell.rowSpan || 1), cs = Math.max(1, cell.colSpan || 1);
          for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
            grid[r + dr] = grid[r + dr] || [];
            for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = { cell, r0: r, c0: c, cs };
          }
          c += cs;
        }
      });
      const ncols = Math.max(...grid.map((g) => g.length));
      if (!ncols) return '';

      // Column widths: explicit cell widths where available, the rest shared.
      const avail = ctx.widthTw || this.contentWidthTw;
      const widths = new Array(ncols).fill(null);
      for (let c = 0; c < ncols; c++) {
        for (const g of grid) {
          const slot = g[c];
          if (slot && slot.cs === 1 && slot.cell.style.width) {
            const pt = u.cssLengthToPt(slot.cell.style.width, this.defaults.fontSizePt);
            if (pt) { widths[c] = u.ptToTwips(pt); break; }
          }
        }
      }
      const known = widths.reduce((s, w) => s + (w || 0), 0);
      const unknown = widths.filter((w) => w === null).length;
      const share = unknown ? Math.max(360, Math.floor((avail - known) / unknown)) : 0;
      for (let c = 0; c < ncols; c++) if (widths[c] === null) widths[c] = share;
      let total = widths.reduce((s, w) => s + w, 0);
      // Only shrink tables whose widths we invented; explicit widths are kept.
      if (total > avail && unknown) { const k = avail / total; for (let c = 0; c < ncols; c++) widths[c] = Math.floor(widths[c] * k); total = widths.reduce((s, w) => s + w, 0); }

      const borderless = tableEl.classList.contains('borderless');
      const side = (n) => borderless ? `<w:${n} w:val="nil"/>` : `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
      let xml = '<w:tbl><w:tblPr>' +
        `<w:tblW w:w="${total}" w:type="dxa"/>` +
        '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side).join('') + '</w:tblBorders>' +
        '<w:tblLayout w:type="fixed"/>' +
        '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
        '</w:tblPr><w:tblGrid>' + widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';

      for (let r = 0; r < grid.length; r++) {
        xml += '<w:tr>';
        let c = 0;
        while (c < ncols) {
          const slot = grid[r][c];
          if (!slot) { // ragged row: pad with an empty cell
            xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
            c++;
            continue;
          }
          const span = slot.cs;
          const w = widths.slice(c, c + span).reduce((s, x) => s + x, 0);
          const cell = slot.cell;
          const isOrigin = slot.r0 === r;
          let tcPr = `<w:tcW w:w="${w}" w:type="dxa"/>`;
          if (span > 1) tcPr += `<w:gridSpan w:val="${span}"/>`;
          if ((cell.rowSpan || 1) > 1) tcPr += isOrigin ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
          const fill = u.colorToHex(cell.style.backgroundColor);
          if (fill) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;

          let content = '<w:p/>';
          if (isOrigin) {
            const sub = Object.assign({}, ctx, {
              blockEl: cell, list: null, style: null, align: this.alignOf(cell), inTable: true, widthTw: w,
              baseFmt: cell.tagName === 'TH' ? Object.assign({}, ctx.baseFmt, { bold: true }) : ctx.baseFmt
            });
            content = await this.blocks(cell, sub);
            // A table cell must end with a paragraph.
            if (!content || content.endsWith('</w:tbl>')) content += '<w:p/>';
          }
          xml += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${content}</w:tc>`;
          c += span;
        }
        xml += '</w:tr>';
      }
      return xml + '</w:tbl>';
    }

    /* ================================================================== */
    /* Images                                                             */
    /* ================================================================== */
    async imageRun(img, ctx) {
      const src = img.getAttribute('src');
      if (!src) return '';
      let bytes, mime;
      try {
        let blob;
        if (src.startsWith('data:')) blob = u.dataUrlToBlob(src);
        else {
          const res = await fetch(img.src);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          blob = await res.blob();
        }
        bytes = new Uint8Array(await blob.arrayBuffer());
        mime = u.sniffImage(bytes);
        if (!mime || mime === 'image/bmp') { bytes = await this.rasterize(img); mime = 'image/png'; }
      } catch (e) {
        this.warnings.add(/^https?:/i.test(src)
          ? 'An image linked from another website could not be saved. Download it and insert it from your computer instead.'
          : 'An image could not be saved (' + (e.message || 'unknown error') + ').');
        return '';
      }

      // Size in pixels, clamped to the available width, aspect from the image itself.
      const maxW = u.twipsToPx(ctx.widthTw || this.contentWidthTw);
      const attrW = parseFloat(img.getAttribute('width')) || 0;
      const attrH = parseFloat(img.getAttribute('height')) || 0;
      const natW = img.naturalWidth || attrW || 100;
      const natH = img.naturalHeight || attrH || 100;
      let w = attrW || natW;
      let h = img.naturalWidth ? w * (natH / natW) : (attrH || natH);
      if (w > maxW) { h = h * (maxW / w); w = maxW; }
      const cx = Math.max(1, Math.round(w * u.EMU_PER_PX));
      const cy = Math.max(1, Math.round(h * u.EMU_PER_PX));

      const ext = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' }[mime];
      const name = `image${this.media.length + 1}.${ext}`;
      this.media.push({ name, bytes });
      const rid = this.addRel('image', 'media/' + name, false);
      const id = this.nextDocPr++;
      const alt = esc(img.getAttribute('alt') || '');
      const drawing =
        `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
        `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
        `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
        `</a:graphicData></a:graphic></wp:inline></w:drawing>`;
      return '<w:r>' + (ctx.link ? '<w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>' : '') + drawing + '</w:r>';
    }

    /** Convert formats Word handles poorly (SVG, WebP, BMP) to PNG via canvas. */
    rasterize(img) {
      return new Promise((resolve, reject) => {
        const w = img.naturalWidth || parseInt(img.getAttribute('width'), 10) || 300;
        const h = img.naturalHeight || parseInt(img.getAttribute('height'), 10) || 150;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        try {
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob(async (b) => {
            if (!b) return reject(new Error('conversion failed'));
            resolve(new Uint8Array(await b.arrayBuffer()));
          }, 'image/png');
        } catch (e) { reject(e); }
      });
    }

    /* ================================================================== */
    /* Package parts                                                      */
    /* ================================================================== */
    stylesXml() {
      const d = this.defaults;
      const f = esc(d.fontFamily);
      const sz = Math.round(d.fontSizePt * 2);
      const after = u.ptToTwips(d.spaceAfterPt);
      const line = Math.round(d.lineHeight * 240);
      let headings = '';
      HEADINGS.forEach((h, i) => {
        const n = i + 1;
        headings += `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
          `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
          `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${h.before * 20}" w:after="${h.after * 20}" w:line="276" w:lineRule="auto"/><w:outlineLvl w:val="${i}"/></w:pPr>` +
          `<w:rPr><w:b/><w:bCs/>${n === 4 ? '<w:i/><w:iCs/>' : ''}<w:color w:val="${HEADING_COLOR}"/><w:sz w:val="${h.size * 2}"/><w:szCs w:val="${h.size * 2}"/></w:rPr></w:style>`;
      });
      return XML_HEAD + `<w:styles ${NS_W}>` +
        `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>` +
        `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
        `<w:pPrDefault><w:pPr><w:spacing w:after="${after}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
        `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
        `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>` +
        `<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
        headings +
        `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>` +
        `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="9AA5B1"/></w:pBdr><w:spacing w:before="120" w:after="120"/><w:ind w:left="720" w:right="720"/></w:pPr>` +
        `<w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>` +
        `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
        `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
        `</w:styles>`;
    }

    settingsXml() {
      return XML_HEAD + `<w:settings ${NS_W}><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>` +
        `<w:characterSpacingControl w:val="doNotCompress"/><w:compat>` +
        `<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>` +
        `</w:compat></w:settings>`;
    }

    sectPr() {
      const p = this.page, m = p.margins;
      const orient = p.widthTw > p.heightTw ? ' w:orient="landscape"' : '';
      return `<w:sectPr><w:pgSz w:w="${p.widthTw}" w:h="${p.heightTw}"${orient}/>` +
        `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
    }

    async build(root) {
      let body = await this.blocks(root, { blockEl: null, list: null, style: null, baseFmt: {} });
      if (!body || body.endsWith('</w:tbl>')) body += '<w:p/>';
      const documentXml = XML_HEAD + `<w:document ${NS_DOC}><w:body>${body}${this.sectPr()}</w:body></w:document>`;

      const zip = new JSZip();
      const hasMedia = this.media.length > 0;
      zip.file('[Content_Types].xml', XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        (hasMedia ? '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>' : '') +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>');
      zip.file('_rels/.rels', XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}officeDocument" Target="word/document.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        `<Relationship Id="rId3" Type="${REL}extended-properties" Target="docProps/app.xml"/>` +
        '</Relationships>');
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      zip.file('docProps/core.xml', XML_HEAD +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${esc(this.title)}</dc:title><dc:creator>Folio</dc:creator><cp:lastModifiedBy>Folio</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
        '</cp:coreProperties>');
      zip.file('docProps/app.xml', XML_HEAD +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Folio</Application></Properties>');
      zip.file('word/document.xml', documentXml);
      zip.file('word/styles.xml', this.stylesXml());
      zip.file('word/numbering.xml', this.numberingXml());
      zip.file('word/settings.xml', this.settingsXml());
      zip.file('word/_rels/document.xml.rels', XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}settings" Target="settings.xml"/>` +
        this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
        '</Relationships>');
      for (const m of this.media) zip.file('word/media/' + m.name, m.bytes);

      const blob = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });
      return { blob, warnings: Array.from(this.warnings) };
    }
  }

  /**
   * Export the editor content as a .docx Blob.
   * @param {HTMLElement} root editor element
   * @param {{page:object, defaults:object, title:string}} opts
   */
  Folio.exportDocx = async function (root, opts) {
    if (typeof JSZip === 'undefined') {
      throw new Error('The .docx writer library (JSZip) did not load. Check your internet connection and reload the page.');
    }
    return new DocxWriter(opts).build(root);
  };
})(window.Folio = window.Folio || {});
