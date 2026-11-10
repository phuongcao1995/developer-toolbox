/**
 * Folio — .docx importer.
 *
 * Reads the Office Open XML package with JSZip and converts the main document
 * part into editable HTML. Supported:
 *   - paragraphs, headings (Heading 1–6, Title), quotes
 *   - run formatting: bold, italic, underline, strikethrough, colour,
 *     highlight / shading, font family, font size, superscript / subscript
 *   - paragraph alignment, indentation, spacing and line spacing
 *   - bulleted / numbered lists (nested, via numbering.xml)
 *   - tables (merged cells, cell shading, borderless tables)
 *   - inline and floating images (PNG, JPEG, GIF, BMP, SVG)
 *   - hyperlinks (relationship links, anchors and HYPERLINK fields)
 *   - page breaks, page size, orientation and margins
 *
 * Anything else (headers/footers, footnotes, comments, text boxes, charts,
 * equations …) is skipped and reported to the user as a warning, never
 * silently dropped.
 *
 * If this parser throws on an unusual file, importDocxWithFallback() retries
 * with mammoth.js, which is more forgiving but keeps less formatting.
 */
(function (Folio) {
  'use strict';

  const u = Folio.util;
  const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';

  /** Error with a message suitable for showing to the user. */
  class ImportError extends Error {
    constructor(message, detail) {
      super(message);
      this.name = 'ImportError';
      this.detail = detail || null;
      this.userFacing = true;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Small XML helpers (namespace-tolerant)                                 */
  /* ---------------------------------------------------------------------- */
  const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
  const kid = (el, name) => {
    if (!el) return null;
    for (const c of el.children) if (c.localName === name) return c;
    return null;
  };
  const desc = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);

  function attr(el, name) {
    if (!el) return null;
    let v = el.getAttributeNS(NS_W, name);
    if (v === null || v === '') v = el.getAttribute('w:' + name);
    return v === '' ? null : v;
  }
  function relAttr(el, name) {
    if (!el) return null;
    return el.getAttributeNS(NS_R, name) || el.getAttribute('r:' + name) || null;
  }
  /** OOXML boolean ("on/off") property: present without val means true. */
  function onOff(el) {
    if (!el) return undefined;
    const v = attr(el, 'val');
    if (v === null) return true;
    return !['false', '0', 'off', 'none'].includes(v.toLowerCase());
  }
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  function parseXml(text, partName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new ImportError(`The file is damaged: the part "${partName}" is not valid XML.`, err.textContent);
    return doc;
  }

  /** Remove keys whose value is undefined so Object.assign doesn't clobber. */
  function clean(obj) {
    const out = {};
    for (const k in obj) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Property parsers                                                       */
  /* ---------------------------------------------------------------------- */
  function parseRPr(rPr, theme) {
    const f = {};
    if (!rPr) return f;
    const b = kid(rPr, 'b'); if (b) f.bold = onOff(b);
    const i = kid(rPr, 'i'); if (i) f.italic = onOff(i);
    const uEl = kid(rPr, 'u');
    if (uEl) { const v = (attr(uEl, 'val') || 'single').toLowerCase(); f.underline = !['none', '0', 'false'].includes(v); }
    const st = kid(rPr, 'strike'), dst = kid(rPr, 'dstrike');
    if (st || dst) f.strike = !!(onOff(st) || onOff(dst));
    const col = attr(kid(rPr, 'color'), 'val');
    if (col && /^[0-9a-f]{6}$/i.test(col)) f.color = col.toUpperCase();
    const hl = attr(kid(rPr, 'highlight'), 'val');
    if (hl) f.highlight = hl === 'none' ? null : (u.HIGHLIGHTS[hl] || null);
    const shd = kid(rPr, 'shd');
    if (shd) { const fill = attr(shd, 'fill'); if (fill && /^[0-9a-f]{6}$/i.test(fill)) f.shading = fill.toUpperCase(); }
    const sz = num(attr(kid(rPr, 'sz'), 'val')); if (sz) f.size = sz / 2;
    const fonts = kid(rPr, 'rFonts');
    if (fonts) {
      let name = attr(fonts, 'ascii') || attr(fonts, 'hAnsi');
      const themeRef = attr(fonts, 'asciiTheme') || attr(fonts, 'hAnsiTheme');
      if (!name && themeRef && theme) name = themeRef.startsWith('major') ? theme.major : theme.minor;
      if (name) f.font = name;
    }
    const va = attr(kid(rPr, 'vertAlign'), 'val');
    if (va === 'superscript') f.vert = 'super';
    else if (va === 'subscript') f.vert = 'sub';
    else if (va === 'baseline') f.vert = null;
    const vanish = kid(rPr, 'vanish'); if (vanish) f.hidden = onOff(vanish);
    const caps = kid(rPr, 'caps'); if (caps) f.caps = onOff(caps);
    const rStyle = attr(kid(rPr, 'rStyle'), 'val'); if (rStyle) f.rStyle = rStyle;
    return f;
  }

  const JC = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', lowKashida: 'justify', mediumKashida: 'justify', highKashida: 'justify', thaiDistribute: 'justify' };

  function parsePPr(pPr) {
    const p = {};
    if (!pPr) return p;
    const style = attr(kid(pPr, 'pStyle'), 'val'); if (style) p.styleId = style;
    const jc = attr(kid(pPr, 'jc'), 'val'); if (jc && JC[jc]) p.align = JC[jc];
    const ind = kid(pPr, 'ind');
    if (ind) {
      const left = num(attr(ind, 'left') ?? attr(ind, 'start'));
      if (left !== null) p.indLeft = u.twipsToPt(left);
      const right = num(attr(ind, 'right') ?? attr(ind, 'end'));
      if (right !== null) p.indRight = u.twipsToPt(right);
      const first = num(attr(ind, 'firstLine')); const hang = num(attr(ind, 'hanging'));
      if (hang !== null) p.firstLine = -u.twipsToPt(hang);
      else if (first !== null) p.firstLine = u.twipsToPt(first);
    }
    const sp = kid(pPr, 'spacing');
    if (sp) {
      const before = num(attr(sp, 'before')); if (before !== null) p.spaceBefore = u.twipsToPt(before);
      const after = num(attr(sp, 'after')); if (after !== null) p.spaceAfter = u.twipsToPt(after);
      const line = num(attr(sp, 'line'));
      if (line !== null && line > 0) {
        const rule = attr(sp, 'lineRule') || 'auto';
        p.line = rule === 'auto' ? { type: 'auto', value: Math.round((line / 240) * 100) / 100 } : { type: rule, pt: u.twipsToPt(line) };
      }
    }
    const numPr = kid(pPr, 'numPr');
    if (numPr) {
      const id = attr(kid(numPr, 'numId'), 'val'); if (id !== null) p.numId = id;
      const lvl = num(attr(kid(numPr, 'ilvl'), 'val')); if (lvl !== null) p.ilvl = lvl;
    }
    const pbb = kid(pPr, 'pageBreakBefore'); if (pbb) p.pageBreakBefore = onOff(pbb);
    return p;
  }

  /** Classify table/cell borders: 'some' (visible), 'none', or null (unspecified). */
  function parseBorders(el) {
    if (!el) return null;
    const sides = Array.from(el.children);
    if (!sides.length) return null;
    return sides.some((s) => !['nil', 'none'].includes((attr(s, 'val') || '').toLowerCase())) ? 'some' : 'none';
  }

  function parseHyperlinkInstr(instr) {
    if (!instr) return null;
    const m = instr.match(/^\s*HYPERLINK\b(.*)$/i);
    if (!m) return null;
    const rest = m[1];
    const anchor = rest.match(/\\l\s+"([^"]*)"/i);
    if (anchor) return '#' + anchor[1];
    const target = rest.match(/"([^"]*)"/) || rest.match(/\s(\S+)/);
    return target ? target[1] : null;
  }

  /** Only allow link schemes that are safe to place in the editor. */
  function safeHref(href) {
    if (!href) return null;
    const h = href.trim();
    if (/^(https?:|mailto:|tel:|ftp:|#)/i.test(h)) return h;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(h)) return 'https://' + h;
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Package readers: styles, numbering, theme, relationships               */
  /* ---------------------------------------------------------------------- */
  function parseTheme(doc) {
    const latin = (font) => (font ? attr(kid(font, 'latin'), 'typeface') || kid(font, 'latin')?.getAttribute('typeface') : null);
    return { major: latin(desc(doc, 'majorFont')), minor: latin(desc(doc, 'minorFont')) };
  }

  function parseStyles(doc, theme) {
    const out = { byId: {}, defaultPara: null, docDefaults: { rPr: {}, pPr: {} } };
    if (!doc) return out;
    const root = doc.documentElement;
    const dd = kid(root, 'docDefaults');
    if (dd) {
      out.docDefaults.rPr = parseRPr(kid(kid(dd, 'rPrDefault'), 'rPr'), theme);
      out.docDefaults.pPr = parsePPr(kid(kid(dd, 'pPrDefault'), 'pPr'));
    }
    for (const s of kids(root, 'style')) {
      const id = attr(s, 'styleId');
      if (!id) continue;
      const style = {
        id,
        type: attr(s, 'type') || 'paragraph',
        name: attr(kid(s, 'name'), 'val') || id,
        basedOn: attr(kid(s, 'basedOn'), 'val'),
        rPr: parseRPr(kid(s, 'rPr'), theme),
        pPr: parsePPr(kid(s, 'pPr')),
        borders: parseBorders(kid(kid(s, 'tblPr'), 'tblBorders'))
      };
      out.byId[id] = style;
      const isDefault = ['1', 'true', 'on'].includes((attr(s, 'default') || '').toLowerCase());
      if (isDefault && style.type === 'paragraph') out.defaultPara = id;
    }
    return out;
  }

  const OL_TYPES = { decimal: '1', decimalZero: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

  function parseNumbering(doc) {
    const abstracts = {}, nums = {};
    if (doc) {
      const root = doc.documentElement;
      for (const a of kids(root, 'abstractNum')) {
        const levels = {};
        for (const l of kids(a, 'lvl')) {
          const ind = kid(kid(l, 'pPr'), 'ind');
          levels[num(attr(l, 'ilvl')) || 0] = {
            fmt: attr(kid(l, 'numFmt'), 'val') || 'decimal',
            start: num(attr(kid(l, 'start'), 'val')) ?? 1,
            indLeft: num(attr(ind, 'left') ?? attr(ind, 'start'))
          };
        }
        abstracts[attr(a, 'abstractNumId')] = levels;
      }
      for (const n of kids(root, 'num')) {
        const overrides = {};
        for (const o of kids(n, 'lvlOverride')) {
          const s = num(attr(kid(o, 'startOverride'), 'val'));
          if (s !== null) overrides[num(attr(o, 'ilvl')) || 0] = s;
        }
        nums[attr(n, 'numId')] = { abstractId: attr(kid(n, 'abstractNumId'), 'val'), overrides };
      }
    }
    return {
      has: (id) => !!(nums[id] && abstracts[nums[id].abstractId]),
      level(id, ilvl) {
        const n = nums[id];
        const levels = abstracts[n.abstractId];
        const lvl = levels[ilvl] || levels[0] || { fmt: 'decimal', start: 1 };
        const start = n.overrides[ilvl] ?? lvl.start;
        // Visual depth: Word nests lists by indentation, which is what the
        // reader sees, so use it (falling back to the level number).
        const depth = lvl.indLeft !== null && lvl.indLeft !== undefined ? lvl.indLeft : (ilvl + 1) * 720;
        if (lvl.fmt === 'bullet') return { kind: 'ul', start, depth };
        if (lvl.fmt === 'none') return { kind: 'none', start, depth };
        return { kind: 'ol', type: OL_TYPES[lvl.fmt] || '1', start, depth };
      }
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Converter                                                              */
  /* ---------------------------------------------------------------------- */
  /** "PAGE" / "NUMPAGES" from a field instruction (these become live field chips); null for any other field. */
  function fieldName(instr) {
    const m = /^\s*(PAGE|NUMPAGES)\b/i.exec(instr || '');
    return m ? m[1].toUpperCase() : null;
  }

  const WARNINGS = {
    headerVariants: 'Different first-page or odd/even headers and footers were not imported; the default header and footer are used.',
    footnotes: 'Endnotes were not imported.',
    comments: 'Comments were removed.',
    textBoxes: 'Text inside text boxes was not imported.',
    shapes: 'Charts, shapes and SmartArt graphics were not imported.',
    equations: 'Equations were not imported.',
    trackedChanges: 'Tracked changes were accepted (insertions kept, deletions removed).',
    floatingImages: 'Floating images were placed inline with the text.',
    unsupportedImages: 'Images in formats browsers cannot display (EMF, WMF, TIFF) were omitted.',
    missingImages: 'Some images were missing from the file or linked externally and were omitted.',
    embeddedObjects: 'Embedded objects (e.g. spreadsheets) were replaced by their preview image, or omitted.',
    sections: 'The document has several sections; the whole document now uses the last section\u2019s page setup.',
    altChunk: 'Embedded HTML or RTF fragments were not imported.',
    columns: 'Multi-column layout was converted to a single column.'
  };

  class Converter {
    constructor(pkg) {
      Object.assign(this, pkg); // zip, rels, styles, numbering, theme
      this.warnings = new Set();
      this.imageJobs = [];
      this.fields = [];          // complex field stack (spans paragraphs)
      this.counters = {};        // list numbering counters per numId
      this.memoKind = {};
      this.memoR = {};
      this.memoP = {};
      this.sectionCount = 0;
    }

    warn(key) { this.warnings.add(key); }

    /* ---------- style resolution (follows basedOn chains) ---------- */
    resolve(id, key, memo, seen = new Set()) {
      if (!id || seen.has(id)) return {};
      if (memo[id]) return memo[id];
      seen.add(id);
      const s = this.styles.byId[id];
      if (!s) return {};
      const merged = Object.assign({}, this.resolve(s.basedOn, key, memo, seen), clean(s[key]));
      memo[id] = merged;
      return merged;
    }
    resolveR(id) { return this.resolve(id, 'rPr', this.memoR); }
    resolveP(id) {
      const p = Object.assign({}, this.resolve(id, 'pPr', this.memoP));
      delete p.styleId;
      return p;
    }

    /** Map a paragraph style to an HTML block tag. */
    blockKind(id) {
      if (!id) return 'p';
      if (this.memoKind[id]) return this.memoKind[id];
      let kind = 'p';
      const seen = new Set();
      let cur = id;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const s = this.styles.byId[cur];
        const name = (s ? s.name : cur).toLowerCase().replace(/\s+/g, ' ').trim();
        const h = name.match(/^heading ?([1-6])$/);
        if (h) { kind = 'h' + h[1]; break; }
        if (name === 'title') { kind = 'title'; break; }
        if (name === 'subtitle') { kind = 'subtitle'; break; }
        if (name === 'quote' || name === 'intense quote') { kind = 'blockquote'; break; }
        cur = s ? s.basedOn : null;
      }
      this.memoKind[id] = kind;
      return kind;
    }

    tableBorders(styleId) {
      const seen = new Set();
      let cur = styleId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const s = this.styles.byId[cur];
        if (!s) break;
        if (s.borders) return s.borders;
        cur = s.basedOn;
      }
      return null;
    }

    /* ---------- document defaults (font, size, spacing) ---------- */
    computeDefaults() {
      const hasStyles = Object.keys(this.styles.byId).length > 0;
      const r = Object.assign({}, this.styles.docDefaults.rPr, this.resolveR(this.styles.defaultPara));
      const p = Object.assign({}, this.styles.docDefaults.pPr, this.resolveP(this.styles.defaultPara));
      this.defaults = {
        fontFamily: r.font || (this.theme && this.theme.minor) || 'Calibri',
        fontSizePt: r.size || (hasStyles ? 10 : 11),
        spaceAfterPt: p.spaceAfter ?? 0,
        spaceBeforePt: p.spaceBefore ?? 0,
        lineHeight: p.line && p.line.type === 'auto' ? p.line.value : 1
      };
      this.paraDefaults = p;
    }

    /**
     * Some writers (e.g. LibreOffice) put the font, size and spacing on every
     * run/paragraph instead of in the document defaults. Adopting the dominant
     * values as defaults keeps the HTML clean and the export compact. Only
     * values that cover more than half the body text are adopted.
     */
    adoptDominantDefaults(body) {
      const runVotes = {}, paraVotes = {};
      let totalChars = 0, totalParas = 0;
      for (const p of body.getElementsByTagNameNS('*', 'p')) {
        const direct = parsePPr(kid(p, 'pPr'));
        const styleId = direct.styleId || this.styles.defaultPara;
        if (this.blockKind(styleId) !== 'p') continue;
        const eff = Object.assign({}, this.paraDefaults, this.resolveP(styleId), clean(direct));
        let inCell = false;
        for (let a = p.parentElement; a && a !== body; a = a.parentElement) if (a.localName === 'tc') { inCell = true; break; }
        if (!inCell && (!eff.numId || eff.numId === '0')) {
          const key = (eff.spaceAfter ?? 0) + '|' + (eff.line && eff.line.type === 'auto' ? eff.line.value : '');
          paraVotes[key] = (paraVotes[key] || 0) + 1;
          totalParas++;
        }
        const base = Object.assign({}, this.styles.docDefaults.rPr, this.resolveR(styleId));
        for (const r of p.getElementsByTagNameNS('*', 'r')) {
          const len = Array.from(r.getElementsByTagNameNS('*', 't')).reduce((n, t) => n + t.textContent.length, 0);
          if (!len) continue;
          const d = parseRPr(kid(r, 'rPr'), this.theme);
          const cs = d.rStyle ? this.resolveR(d.rStyle) : {};
          const f = Object.assign({}, base, clean(cs), clean(d));
          const key = (f.font || this.defaults.fontFamily) + '|' + (f.size || this.defaults.fontSizePt);
          runVotes[key] = (runVotes[key] || 0) + len;
          totalChars += len;
        }
      }
      const winner = (votes, total) => {
        let best = null, n = 0;
        for (const k in votes) if (votes[k] > n) { best = k; n = votes[k]; }
        return best && n > total / 2 ? best : null;
      };
      const run = winner(runVotes, totalChars);
      if (run) {
        const [font, size] = run.split('|');
        this.defaults.fontFamily = font;
        this.defaults.fontSizePt = parseFloat(size);
      }
      const para = winner(paraVotes, totalParas);
      if (para) {
        const [after, line] = para.split('|');
        this.defaults.spaceAfterPt = parseFloat(after);
        if (line) this.defaults.lineHeight = parseFloat(line);
      }
    }

    /* ---------- entry point ---------- */
    async convert(doc) {
      this.computeDefaults();
      const body = kid(doc.documentElement, 'body');
      if (!body) throw new ImportError('The document has no body content. The file may be damaged.');
      this.adoptDominantDefaults(body);

      const frag = document.createDocumentFragment();
      this.blocks(body, { container: frag, listStack: [] });

      // Page setup from the final section properties.
      const sect = kid(body, 'sectPr');
      if (this.sectionCount > 0) this.warn('sections');
      const page = this.pageSetup(sect);
      const header = await this.headerFooter(sect, 'header');
      const footer = await this.headerFooter(sect, 'footer');

      // Some features live in other parts; detect them so we can tell the user.
      const allSect = doc.getElementsByTagNameNS('*', 'sectPr');
      for (const s of allSect) {
        const cols = num(attr(kid(s, 'cols'), 'num'));
        if (cols && cols > 1) this.warn('columns');
      }

      await Promise.all(this.imageJobs);

      if (!frag.firstChild) frag.appendChild(this.emptyParagraph());
      return {
        fragment: frag,
        page,
        header,
        footer,
        defaults: this.defaults,
        warnings: Array.from(this.warnings).map((k) => WARNINGS[k]).filter(Boolean)
      };
    }

    pageSetup(sect) {
      const pg = kid(sect, 'pgSz');
      const mar = kid(sect, 'pgMar');
      const w = num(attr(pg, 'w')) || 12240;
      const h = num(attr(pg, 'h')) || 15840;
      return {
        widthTw: w,
        heightTw: h,
        margins: {
          top: Math.abs(num(attr(mar, 'top')) ?? 1440),
          right: num(attr(mar, 'right')) ?? 1440,
          bottom: Math.abs(num(attr(mar, 'bottom')) ?? 1440),
          left: num(attr(mar, 'left')) ?? 1440
        },
        headerTw: num(attr(mar, 'header')) ?? 720,
        footerTw: num(attr(mar, 'footer')) ?? 720
      };
    }

    /**
     * The default header or footer of the final section as a fragment (or null). The part has its own relationships
     * (for pictures and links), so they are swapped in while it is converted.
     */
    async headerFooter(sect, kind) {
      if (!sect) return null;
      const refs = Array.from(sect.children).filter((c) => c.localName === kind + 'Reference');
      if (!refs.length) return null;
      const def = refs.find((r) => (attr(r, 'type') || 'default') === 'default');
      if (!def || refs.length > 1 || kid(sect, 'titlePg')) this.warn('headerVariants');
      if (!def) return null;
      const rel = this.rels[relAttr(def, 'id')];
      const file = rel && rel.path ? this.zip.file(rel.path) : null;
      if (!file) return null;
      const root = parseXml(await file.async('string'), rel.path).documentElement;
      const baseDir = rel.path.includes('/') ? rel.path.slice(0, rel.path.lastIndexOf('/') + 1) : '';
      const relsFile = this.zip.file(baseDir + '_rels/' + rel.path.slice(baseDir.length) + '.rels');
      const partRels = relsFile ? parseRels(parseXml(await relsFile.async('string'), baseDir + '_rels'), baseDir) : {};
      const savedRels = this.rels, savedFields = this.fields;
      this.rels = partRels;
      this.fields = [];
      try {
        const frag = document.createDocumentFragment();
        this.blocks(root, { container: frag, listStack: [] });
        return frag;
      } finally {
        this.rels = savedRels;
        this.fields = savedFields;
      }
    }

    emptyParagraph() {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      return p;
    }

    /* ---------- block level ---------- */
    blocks(parent, ctx) {
      for (const c of parent.children) {
        switch (c.localName) {
          case 'p': this.paragraph(c, ctx); break;
          case 'tbl': ctx.listStack = []; this.table(c, ctx); break;
          case 'sdt': { const sc = kid(c, 'sdtContent'); if (sc) this.blocks(sc, ctx); break; }
          case 'customXml': this.blocks(c, ctx); break;
          case 'altChunk': this.warn('altChunk'); break;
          default: break; // sectPr, bookmarks, proofErr …
        }
      }
    }

    paragraph(p, ctx) {
      const pPrEl = kid(p, 'pPr');
      const direct = parsePPr(pPrEl);
      if (pPrEl && kid(pPrEl, 'sectPr')) this.sectionCount++;
      const styleId = direct.styleId || this.styles.defaultPara;
      const kind = this.blockKind(styleId);
      const isHeading = kind[0] === 'h';
      const eff = Object.assign({}, this.paraDefaults, this.resolveP(styleId), clean(direct));
      // Headings and quotes use the app's own styles, so their style-level
      // run formatting is not copied onto every run.
      const baseRun = kind !== 'p' ? {} : Object.assign({}, this.styles.docDefaults.rPr, this.resolveR(styleId));

      // Collect inline content.
      const segs = [];
      this.inHeading = isHeading;
      this.collectInline(p, baseRun, segs, null);

      // Page breaks: placed before or after the paragraph block.
      let breakBefore = !!eff.pageBreakBefore, breakAfter = false;
      const pbIndex = segs.findIndex((s) => s.type === 'pagebreak');
      if (pbIndex >= 0) {
        const before = segs.slice(0, pbIndex).some((s) => s.type !== 'text' || s.text.trim() !== '');
        if (before) breakAfter = true; else breakBefore = true;
      }
      const content = segs.filter((s) => s.type !== 'pagebreak');
      const onlyBreak = pbIndex >= 0 && !content.some((s) => s.type !== 'text' || s.text !== '');

      if (breakBefore) { ctx.listStack = []; ctx.container.appendChild(this.pageBreakEl()); }
      if (onlyBreak) return;

      // Lists (headings keep their heading role even if numbered).
      let el;
      const numId = eff.numId;
      const listable = !isHeading && numId && numId !== '0' && this.numbering.has(numId);
      const level = listable ? this.numbering.level(numId, eff.ilvl || 0) : null;
      if (level && level.kind !== 'none') {
        el = document.createElement('li');
        this.placeListItem(el, level, numId, eff.ilvl || 0, ctx);
      } else {
        ctx.listStack = [];
        el = document.createElement(kind === 'title' || kind === 'subtitle' ? 'p' : kind);
        if (kind === 'title' || kind === 'subtitle') el.className = kind;
        ctx.container.appendChild(el);
      }

      this.applyParagraphStyle(el, eff, direct, kind, el.tagName === 'LI', !!ctx.inTable);
      this.renderSegments(el, content);
      if (!el.firstChild || !el.textContent && !el.querySelector('img, br')) {
        el.textContent = '';
        el.appendChild(document.createElement('br'));
      }
      if (breakAfter) { ctx.listStack = []; ctx.container.appendChild(this.pageBreakEl()); }
    }

    pageBreakEl() {
      const hr = document.createElement('hr');
      hr.className = 'page-break';
      return hr;
    }

    applyParagraphStyle(el, eff, direct, kind, isListItem, inTable) {
      const d = this.defaults;
      if (eff.align && eff.align !== 'left') el.style.textAlign = eff.align;
      if (isListItem) return; // list geometry is controlled by the list itself
      const src = kind[0] === 'h' ? direct : eff; // headings use app heading styles
      if (src.indLeft && kind !== 'blockquote') el.style.marginLeft = src.indLeft + 'pt';
      if (src.indRight && kind !== 'blockquote') el.style.marginRight = src.indRight + 'pt';
      if (src.firstLine) el.style.textIndent = src.firstLine + 'pt';
      if (kind !== 'p') return;
      // Missing values mean Word's built-in defaults (0 pt spacing, single line).
      const after = eff.spaceAfter ?? 0, before = eff.spaceBefore ?? 0;
      const line = eff.line || { type: 'auto', value: 1 };
      if (!inTable && after !== d.spaceAfterPt) el.style.marginBottom = after + 'pt';
      if (!inTable && before !== d.spaceBeforePt) el.style.marginTop = before + 'pt';
      if (line.type === 'auto') { if (line.value !== d.lineHeight) el.style.lineHeight = String(line.value); }
      else el.style.lineHeight = line.pt + 'pt';
    }

    /** Insert an <li> into the correct (possibly nested) list. */
    placeListItem(li, level, numId, ilvl, ctx) {
      const st = ctx.listStack;
      const key = level.depth;
      while (st.length && st[st.length - 1].key > key) st.pop();
      let top = st[st.length - 1];
      if (top && top.key === key && (top.kind !== level.kind || top.numId !== numId || top.type !== level.type)) {
        st.pop();
        top = st[st.length - 1];
      }

      // Numbering counters per list definition, so interrupted lists continue.
      const counters = this.counters[numId] || (this.counters[numId] = []);
      const n = counters[ilvl] === undefined ? level.start : counters[ilvl] + 1;
      counters[ilvl] = n;
      counters.length = ilvl + 1; // reset deeper levels

      if (!top || top.key < key) {
        const list = document.createElement(level.kind);
        if (level.kind === 'ol') {
          if (level.type && level.type !== '1') list.setAttribute('type', level.type);
          if (n !== 1) list.setAttribute('start', String(n));
        }
        const parent = top ? (top.lastLi || top.list) : ctx.container;
        parent.appendChild(list);
        top = { list, key, kind: level.kind, type: level.type, numId, lastLi: null };
        st.push(top);
      }
      top.list.appendChild(li);
      top.lastLi = li;
    }

    /* ---------- inline level ---------- */
    collectInline(node, base, segs, link) {
      for (const c of node.children) {
        switch (c.localName) {
          case 'r': this.run(c, base, segs, link); break;
          case 'hyperlink': {
            let href = null;
            const rid = relAttr(c, 'id');
            if (rid && this.rels[rid]) href = this.rels[rid].target;
            else if (attr(c, 'anchor')) href = '#' + attr(c, 'anchor');
            this.collectInline(c, base, segs, href || link);
            break;
          }
          case 'ins': case 'moveTo': this.warn('trackedChanges'); this.collectInline(c, base, segs, link); break;
          case 'del': case 'moveFrom': this.warn('trackedChanges'); break;
          case 'smartTag': case 'customXml': case 'dir': case 'bdo': this.collectInline(c, base, segs, link); break;
          case 'sdt': { const sc = kid(c, 'sdtContent'); if (sc) this.collectInline(sc, base, segs, link); break; }
          case 'fldSimple': {
            const name = fieldName(attr(c, 'instr'));
            if (name) {
              const run = kid(c, 'r');
              segs.push({ type: 'field', name, fmt: run ? Object.assign({}, base, clean(parseRPr(kid(run, 'rPr'), this.theme))) : base });
            } else this.collectInline(c, base, segs, parseHyperlinkInstr(attr(c, 'instr')) || link);
            break;
          }
          case 'oMath': case 'oMathPara': this.warn('equations'); break;
          case 'commentRangeStart': this.warn('comments'); break;
          default: break;
        }
      }
    }

    inFieldInstruction() { return this.fields.some((f) => !f.result); }
    fieldLink() {
      for (let i = this.fields.length - 1; i >= 0; i--) if (this.fields[i].link) return this.fields[i].link;
      return null;
    }

    run(r, base, segs, link) {
      const direct = parseRPr(kid(r, 'rPr'), this.theme);
      let charStyle = {};
      if (direct.rStyle) {
        const st = this.styles.byId[direct.rStyle];
        // Hyperlink character style is rendered by the <a> element itself.
        if (st && st.name.toLowerCase() !== 'hyperlink') charStyle = this.resolveR(direct.rStyle);
      }
      const fmt = Object.assign({}, base, clean(charStyle), clean(direct));
      delete fmt.rStyle;
      if (fmt.hidden) return;
      for (const c of r.children) this.runChild(c, fmt, segs, link);
    }

    runChild(c, fmt, segs, link) {
      const name = c.localName;
      // Complex fields: skip instruction text, keep the displayed result.
      if (name === 'fldChar') {
        const t = attr(c, 'fldCharType');
        if (t === 'begin') this.fields.push({ instr: '', result: false, link: null, suppress: false });
        else if (t === 'separate' && this.fields.length) {
          const f = this.fields[this.fields.length - 1];
          f.result = true;
          f.link = parseHyperlinkInstr(f.instr);
          const name = fieldName(f.instr);
          if (name) { f.suppress = true; segs.push({ type: 'field', name, fmt }); } // the cached number is replaced by a live field
        } else if (t === 'end') {
          const f = this.fields.pop();
          const name = f && !f.result ? fieldName(f.instr) : null;
          if (name) segs.push({ type: 'field', name, fmt });
        }
        return;
      }
      if (name === 'instrText') {
        if (this.fields.length) this.fields[this.fields.length - 1].instr += c.textContent;
        return;
      }
      if (this.inFieldInstruction() || this.fields.some((f) => f.suppress)) return;
      const href = link || this.fieldLink();
      const text = (t) => {
        const s = fmt.caps ? t.toUpperCase() : t;
        segs.push({ type: 'text', text: s, fmt, link: href });
      };

      switch (name) {
        case 't': text(c.textContent); break;
        case 'tab': case 'ptab': text('\t'); break;
        case 'br': {
          const type = attr(c, 'type');
          if (type === 'page') segs.push({ type: 'pagebreak' });
          else segs.push({ type: 'br', link: href });
          break;
        }
        case 'cr': segs.push({ type: 'br', link: href }); break;
        case 'noBreakHyphen': text('\u2011'); break;
        case 'sym': {
          const code = parseInt(attr(c, 'char') || '', 16);
          if (code) text(String.fromCharCode(code >= 0xF000 ? code - 0xF000 : code));
          break;
        }
        case 'drawing': this.drawing(c, segs, href); break;
        case 'pict': this.vmlPicture(c, segs, href); break;
        case 'object': this.warn('embeddedObjects'); this.vmlPicture(c, segs, href); break;
        case 'AlternateContent': {
          const choice = kid(c, 'Choice'), fallback = kid(c, 'Fallback');
          let target = choice;
          if (!(choice && desc(choice, 'blip')) && fallback) target = fallback;
          if (choice && desc(choice, 'txbxContent')) this.warn('textBoxes');
          if (target) for (const cc of target.children) this.runChild(cc, fmt, segs, link);
          break;
        }
        case 'footnoteReference': {
          const note = this.footnotes && this.footnotes[attr(c, 'id')];
          if (note) segs.push({ type: 'footnote', text: note }); else this.warn('footnotes');
          break;
        }
        case 'endnoteReference': this.warn('footnotes'); break;
        case 'commentReference': this.warn('comments'); break;
        default: break; // rPr, lastRenderedPageBreak, softHyphen …
      }
    }

    drawing(d, segs, href) {
      if (desc(d, 'txbxContent')) this.warn('textBoxes');
      const blip = desc(d, 'blip');
      if (!blip) { this.warn('shapes'); return; }
      const rid = relAttr(blip, 'embed');
      if (!rid) { this.warn('missingImages'); return; }
      if (d.getElementsByTagNameNS(NS_WP, 'anchor').length) this.warn('floatingImages');
      const ext = desc(d, 'extent');
      const cx = num(ext && ext.getAttribute('cx'));
      const cy = num(ext && ext.getAttribute('cy'));
      const docPr = desc(d, 'docPr');
      segs.push({
        type: 'image', rid, link: href,
        w: cx ? Math.round(cx / u.EMU_PER_PX) : null,
        h: cy ? Math.round(cy / u.EMU_PER_PX) : null,
        alt: docPr ? (docPr.getAttribute('descr') || docPr.getAttribute('title') || '') : ''
      });
    }

    /** Legacy VML pictures (<w:pict><v:shape><v:imagedata r:id>). */
    vmlPicture(el, segs, href) {
      if (desc(el, 'txbxContent')) { this.warn('textBoxes'); }
      const img = desc(el, 'imagedata');
      if (!img) { if (!desc(el, 'txbxContent')) this.warn('shapes'); return; }
      const rid = relAttr(img, 'id');
      if (!rid) { this.warn('missingImages'); return; }
      const shape = desc(el, 'shape');
      const style = (shape && shape.getAttribute('style')) || '';
      const size = (prop) => {
        const m = style.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([\\d.]+)(pt|px|in)?'));
        if (!m) return null;
        const v = parseFloat(m[1]);
        return Math.round(m[2] === 'px' ? v : m[2] === 'in' ? v * 96 : v / 0.75);
      };
      segs.push({ type: 'image', rid, link: href, w: size('width'), h: size('height'), alt: '' });
    }

    /* ---------- rendering of collected segments ---------- */
    fmtKey(f) {
      return [f.bold, f.italic, f.underline, f.strike, f.color, f.highlight, f.shading, f.size, f.font, f.vert].join('|');
    }

    renderSegments(el, segs) {
      // Merge adjacent text segments with identical formatting (Word splits
      // runs for spell-check and revision tracking; HTML doesn't need that).
      const merged = [];
      for (const s of segs) {
        const prev = merged[merged.length - 1];
        if (s.type === 'text' && prev && prev.type === 'text' && prev.link === s.link && this.fmtKey(prev.fmt) === this.fmtKey(s.fmt)) {
          prev.text += s.text;
        } else merged.push(Object.assign({}, s));
      }

      let container = el, curLink = null;
      for (const s of merged) {
        if (s.type === 'text' && s.text === '') continue;
        const link = safeHref(s.link);
        if (link !== curLink) {
          curLink = link;
          if (link) {
            const a = document.createElement('a');
            a.setAttribute('href', link);
            el.appendChild(a);
            container = a;
          } else container = el;
        }
        if (s.type === 'text') container.appendChild(this.formattedText(s.text, s.fmt));
        else if (s.type === 'br') container.appendChild(document.createElement('br'));
        else if (s.type === 'field') container.appendChild(this.fieldEl(s));
        else if (s.type === 'footnote') {
          const fn = document.createElement('span');
          fn.className = 'fn';
          fn.setAttribute('data-note', s.text);
          fn.setAttribute('contenteditable', 'false');
          fn.textContent = '1';
          container.appendChild(fn);
        }
        else if (s.type === 'image') {
          const img = this.imageEl(s);
          if (img) container.appendChild(img);
        }
      }
    }

    /** A page-number field: shown as a small chip, saved back as a real Word field. */
    fieldEl(s) {
      const span = document.createElement('span');
      span.className = 'fld';
      span.setAttribute('data-field', s.name);
      span.setAttribute('contenteditable', 'false');
      span.appendChild(this.formattedText('1', s.fmt || {}));
      return span;
    }

    formattedText(text, f) {
      let node = document.createTextNode(text);
      const wrap = (tag) => { const e = document.createElement(tag); e.appendChild(node); node = e; };
      if (f.vert === 'super') wrap('sup');
      if (f.vert === 'sub') wrap('sub');
      if (f.strike) wrap('s');
      if (f.underline) wrap('u');
      if (f.italic) wrap('i');
      if (f.bold) wrap('b');

      const d = this.defaults;
      const css = [];
      if (f.font && f.font.toLowerCase() !== d.fontFamily.toLowerCase()) css.push('font-family: ' + u.fontStack(f.font));
      if (f.size && f.size !== d.fontSizePt) css.push('font-size: ' + f.size + 'pt');
      if (f.color) css.push('color: #' + f.color);
      const bg = f.highlight !== undefined ? f.highlight : f.shading;
      if (bg) css.push('background-color: #' + bg);
      if (this.inHeading && f.bold === false) css.push('font-weight: normal');
      if (this.inHeading && f.italic === false) css.push('font-style: normal');
      if (css.length) {
        const span = document.createElement('span');
        span.setAttribute('style', css.join('; '));
        span.appendChild(node);
        node = span;
      }
      return node;
    }

    imageEl(s) {
      const rel = this.rels[s.rid];
      if (!rel || rel.external) { this.warn('missingImages'); return null; }
      const file = this.zip.file(rel.path);
      if (!file) { this.warn('missingImages'); return null; }
      const ext = rel.path.split('.').pop().toLowerCase();
      if (['emf', 'wmf', 'tif', 'tiff', 'wdp', 'jxr'].includes(ext)) { this.warn('unsupportedImages'); return null; }

      const img = document.createElement('img');
      if (s.w) img.setAttribute('width', String(s.w));
      if (s.h) img.setAttribute('height', String(s.h));
      img.alt = s.alt || '';
      this.imageJobs.push(file.async('uint8array').then((bytes) => {
        const mime = u.sniffImage(bytes) || (ext === 'svg' ? 'image/svg+xml' : null);
        if (!mime) { img.remove(); this.warn('unsupportedImages'); return; }
        img.src = u.trackObjectUrl(URL.createObjectURL(new Blob([bytes], { type: mime })));
      }));
      return img;
    }

    /* ---------- tables ---------- */
    table(tbl, ctx) {
      const table = document.createElement('table');
      const tblPr = kid(tbl, 'tblPr');
      let borders = parseBorders(kid(tblPr, 'tblBorders'));
      if (!borders) borders = this.tableBorders(attr(kid(tblPr, 'tblStyle'), 'val'));
      if (borders !== 'some') table.classList.add('borderless');

      const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => num(attr(g, 'w')) || 0);
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);

      const unwrap = (el, name) => {
        const out = [];
        for (const c of el.children) {
          if (c.localName === name) out.push(c);
          else if (c.localName === 'sdt' || c.localName === 'customXml') {
            const inner = c.localName === 'sdt' ? kid(c, 'sdtContent') : c;
            if (inner) out.push(...unwrap(inner, name));
          }
        }
        return out;
      };

      const vTop = {}; // grid column -> <td> that started a vertical merge
      for (const tr of unwrap(tbl, 'tr')) {
        const row = document.createElement('tr');
        let col = num(attr(kid(kid(tr, 'trPr'), 'gridBefore'), 'val')) || 0;
        for (const tc of unwrap(tr, 'tc')) {
          const tcPr = kid(tc, 'tcPr');
          const span = num(attr(kid(tcPr, 'gridSpan'), 'val')) || 1;
          const vm = kid(tcPr, 'vMerge');
          const vmVal = vm ? (attr(vm, 'val') || 'continue') : null;
          if (vmVal === 'continue' && vTop[col]) {
            vTop[col].rowSpan += 1;
            col += span;
            continue;
          }
          const td = document.createElement('td');
          if (span > 1) td.colSpan = span;
          if (vmVal === 'restart') vTop[col] = td; else delete vTop[col];

          let widthTw = 0;
          for (let i = col; i < col + span; i++) widthTw += grid[i] || 0;
          if (!widthTw) {
            const tcW = kid(tcPr, 'tcW');
            if (tcW && (attr(tcW, 'type') || 'dxa') === 'dxa') widthTw = num(attr(tcW, 'w')) || 0;
          }
          if (widthTw) td.style.width = u.twipsToPt(widthTw) + 'pt';
          const fill = attr(kid(tcPr, 'shd'), 'fill');
          if (fill && /^[0-9a-f]{6}$/i.test(fill)) td.style.backgroundColor = '#' + fill.toUpperCase();

          this.blocks(tc, { container: td, listStack: [], inTable: true });
          if (!td.firstChild) td.appendChild(this.emptyParagraph());
          row.appendChild(td);
          col += span;
        }
        if (row.children.length) tbody.appendChild(row);
      }
      if (tbody.children.length) ctx.container.appendChild(table);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Package loading                                                        */
  /* ---------------------------------------------------------------------- */
  function resolvePath(baseDir, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (baseDir + target).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.' && p !== '') out.push(p);
    }
    return out.join('/');
  }

  function parseRels(doc, baseDir) {
    const rels = {};
    if (!doc) return rels;
    for (const r of doc.getElementsByTagNameNS('*', 'Relationship')) {
      const target = r.getAttribute('Target') || '';
      const external = (r.getAttribute('TargetMode') || '').toLowerCase() === 'external';
      rels[r.getAttribute('Id')] = {
        type: r.getAttribute('Type') || '',
        target,
        external,
        path: external ? null : resolvePath(baseDir, target)
      };
    }
    return rels;
  }

  /**
   * Convert a .docx ArrayBuffer to editable HTML.
   * @returns {Promise<{fragment:DocumentFragment, page:object, defaults:object, warnings:string[]}>}
   */
  async function importDocx(buffer) {
    if (typeof JSZip === 'undefined') {
      throw new ImportError('The .docx reader library (JSZip) did not load. Check your internet connection and reload the page.');
    }
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch (e) {
      throw new ImportError('This file is not a valid .docx document. It may be damaged or incompletely downloaded.', e.message);
    }
    const readText = async (path) => { const f = zip.file(path); return f ? f.async('string') : null; };
    const readXml = async (path) => { const t = await readText(path); return t ? parseXml(t, path) : null; };

    // Locate the main document part through the package relationships.
    let mainPath = 'word/document.xml';
    const pkgRels = parseRels(await readXml('_rels/.rels'), '');
    for (const id in pkgRels) {
      if (/\/officeDocument$/.test(pkgRels[id].type)) { mainPath = pkgRels[id].path; break; }
    }
    const mainXml = await readText(mainPath);
    if (!mainXml) {
      if (zip.file('xl/workbook.xml')) throw new ImportError('This is an Excel spreadsheet, not a Word document.');
      if (zip.file('ppt/presentation.xml')) throw new ImportError('This is a PowerPoint presentation, not a Word document.');
      if (zip.file('content.xml')) throw new ImportError('This is an OpenDocument (.odt) file. Save it as .docx in LibreOffice or Word, then open it here.');
      throw new ImportError('This ZIP file does not contain a Word document.');
    }
    const doc = parseXml(mainXml, mainPath);
    if (doc.documentElement.namespaceURI && doc.documentElement.namespaceURI !== NS_W && /purl\.oclc\.org/.test(doc.documentElement.namespaceURI)) {
      throw new ImportError('This document uses the "Strict Open XML" format, which Folio does not support. In Word, use File › Save As › "Word Document (.docx)".');
    }

    const baseDir = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
    const relsPath = baseDir + '_rels/' + mainPath.slice(baseDir.length) + '.rels';
    const rels = parseRels(await readXml(relsPath), baseDir);
    const partOf = (suffix) => { for (const id in rels) if (rels[id].type.endsWith(suffix) && rels[id].path) return rels[id].path; return null; };

    const themePath = partOf('/theme');
    const theme = themePath ? parseTheme(await readXml(themePath)) : null;
    const stylesPath = partOf('/styles');
    const styles = parseStyles(stylesPath ? await readXml(stylesPath) : null, theme);
    const numberingPath = partOf('/numbering');
    const numbering = parseNumbering(numberingPath ? await readXml(numberingPath) : null);

    // Footnote texts: plain text per note (id -> text); Folio shows them as numbered notes under the document.
    const footnotes = {};
    const notesPath = partOf('/footnotes');
    if (notesPath && zip.file(notesPath)) {
      const nd = await readXml(notesPath);
      for (const fnEl of Array.from(nd.getElementsByTagNameNS('*', 'footnote'))) {
        const type = attr(fnEl, 'type');
        if (type && type !== 'normal') continue;
        const text = kids(fnEl, 'p').map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).join(' ').replace(/\s+/g, ' ').trim();
        if (text) footnotes[attr(fnEl, 'id')] = text;
      }
    }
    const conv = new Converter({ zip, rels, styles, numbering, theme, footnotes });
    const result = await conv.convert(doc);
    if (!Object.keys(footnotes).length && partOf('/footnotes') && doc.getElementsByTagNameNS('*', 'footnoteReference').length) {
      if (!result.warnings.includes(WARNINGS.footnotes)) result.warnings.push(WARNINGS.footnotes);
    }
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* Fallback: mammoth.js (semantic import, fewer formatting details)       */
  /* ---------------------------------------------------------------------- */
  /* mammoth is only the fallback importer (about 640 KB), so it is fetched the first time it is needed. */
  let mammothLoad = null;
  function loadMammoth() {
    if (typeof mammoth !== 'undefined') return Promise.resolve();
    if (!mammothLoad) {
      mammothLoad = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'vendor/mammoth.browser.min.js';
        s.onload = resolve; s.onerror = resolve; // a failure is reported by the check below
        document.head.appendChild(s);
      });
    }
    return mammothLoad;
  }
  async function importWithMammoth(buffer) {
    await loadMammoth();
    if (typeof mammoth === 'undefined') throw new ImportError('The fallback .docx reader (mammoth.js) did not load.');
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      styleMap: ["p[style-name='Quote'] => blockquote:fresh", "p[style-name='Title'] => h1:fresh"],
      convertImage: mammoth.images.imgElement((image) =>
        image.read('base64').then((data) => ({ src: 'data:' + image.contentType + ';base64,' + data })))
    });
    const tpl = document.createElement('template');
    tpl.innerHTML = result.value || '<p><br></p>';
    // Swap large data: URLs for blob: URLs to keep undo snapshots small.
    tpl.content.querySelectorAll('img[src^="data:"]').forEach((img) => {
      const blob = u.dataUrlToBlob(img.getAttribute('src'));
      if (blob) img.src = u.trackObjectUrl(URL.createObjectURL(blob));
    });
    return {
      fragment: tpl.content,
      page: null,
      defaults: null,
      warnings: ['This file was imported in simplified mode: text, headings, lists, tables, images and links were kept, but fonts, colours, sizes and alignment were not.']
    };
  }

  /** Import with Folio's parser, falling back to mammoth on unexpected errors. */
  async function importDocxWithFallback(buffer) {
    try {
      return await importDocx(buffer);
    } catch (e) {
      if (e.userFacing) throw e; // a clear diagnosis already (invalid zip, wrong type …)
      console.warn('Folio importer failed, trying mammoth fallback:', e);
      try {
        return await importWithMammoth(buffer);
      } catch (e2) {
        throw new ImportError('This document could not be read. It may be damaged or use features Folio does not support.', (e.stack || e.message) + '\n\nFallback: ' + (e2.message || e2));
      }
    }
  }

  Folio.ImportError = ImportError;
  Folio.importDocx = importDocx;
  Folio.importDocxWithFallback = importDocxWithFallback;
})(window.Folio = window.Folio || {});
