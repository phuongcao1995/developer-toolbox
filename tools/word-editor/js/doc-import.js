/**
 * Folio — legacy .doc (Word 97–2003 binary) importer.
 *
 * WHY TEXT ONLY: the .doc format stores formatting in binary property tables
 * (CHPX/PAPX/STSH), drawings in an Escher stream and tables as paragraph
 * marks with special properties. Rebuilding all of that reliably in a browser
 * is a large project of its own. What *can* be done reliably is reading the
 * document text through the "piece table", which is what this module does.
 *
 * Steps:
 *   1. Open the OLE compound file (via the CFB library).
 *   2. Read the File Information Block (FIB) from the "WordDocument" stream.
 *   3. Read the piece table (Clx) from the "0Table" or "1Table" stream.
 *   4. Decode each text piece (CP-1252 or UTF-16LE) and clean control chars.
 *
 * The result is plain paragraphs. The user is told clearly that formatting,
 * tables and images were not imported, and how to get a full-fidelity .docx.
 */
(function (Folio) {
  'use strict';

  const ImportError = Folio.ImportError;

  function readStream(cfb, name) {
    const entry = CFB.find(cfb, name) || CFB.find(cfb, '/' + name) || CFB.find(cfb, 'Root Entry/' + name);
    if (!entry || !entry.content) return null;
    const c = entry.content;
    return c instanceof Uint8Array ? c : new Uint8Array(c);
  }

  /** Inspect an OLE file and decide whether it is a Word document we can read. */
  function classifyOle(cfb) {
    if (readStream(cfb, 'EncryptedPackage')) return 'encrypted-ooxml';
    if (readStream(cfb, 'WordDocument')) return 'word';
    if (readStream(cfb, 'Workbook') || readStream(cfb, 'Book')) return 'excel';
    if (readStream(cfb, 'PowerPoint Document')) return 'powerpoint';
    return 'other';
  }

  function parseCfb(bytes) {
    if (typeof CFB === 'undefined') {
      throw new ImportError('The .doc reader library (CFB) did not load. Check your internet connection and reload the page.');
    }
    try {
      return CFB.read(bytes, { type: 'array' });
    } catch (e) {
      throw new ImportError('This .doc file is damaged and cannot be read.', e.message);
    }
  }

  /**
   * Extract the main-document text of a Word 97–2003 file.
   * @param {Uint8Array} bytes
   * @returns {string} text with \n between paragraphs
   */
  function extractText(cfb) {
    const wd = readStream(cfb, 'WordDocument');
    const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (wd.length < 0x01AA) throw new ImportError('This .doc file is damaged (the document header is truncated).');

    const wIdent = dv.getUint16(0, true);
    if (wIdent !== 0xA5EC) throw new ImportError('This file is not a Word 97–2003 document (unexpected header).');
    const nFib = dv.getUint16(2, true);
    if (nFib < 0x00C1) {
      throw new ImportError('This is a Word 6.0/95 document, which Folio cannot read. Open it in Word or LibreOffice and save it as .docx.');
    }
    const flags = dv.getUint16(0x0A, true);
    if (flags & 0x0100) throw new ImportError('This document is password-protected. Remove the password in Word, then open it here.');
    const tableName = (flags & 0x0200) ? '1Table' : '0Table';
    const table = readStream(cfb, tableName);
    if (!table) throw new ImportError('This .doc file is damaged (its "' + tableName + '" stream is missing).');

    const ccpText = dv.getInt32(0x004C, true);  // characters in the main document
    const fcClx = dv.getUint32(0x01A2, true);   // offset of the piece table in the table stream
    const lcbClx = dv.getUint32(0x01A6, true);
    if (!lcbClx || fcClx + lcbClx > table.length) throw new ImportError('This .doc file is damaged (invalid piece table).');

    const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    let pos = fcClx;
    const end = fcClx + lcbClx;
    // Skip any Prc (property modifier) entries that precede the Pcdt.
    while (pos < end && table[pos] === 0x01) {
      const cb = tv.getUint16(pos + 1, true);
      pos += 3 + cb;
    }
    if (table[pos] !== 0x02) throw new ImportError('This .doc file is damaged (piece table not found).');
    const lcb = tv.getUint32(pos + 1, true);
    pos += 5;
    const n = (lcb - 4) / 12;
    if (!Number.isInteger(n) || n <= 0) throw new ImportError('This .doc file is damaged (invalid piece count).');

    const cps = [];
    for (let i = 0; i <= n; i++) cps.push(tv.getInt32(pos + i * 4, true));
    const pcdBase = pos + (n + 1) * 4;

    const cp1252 = new TextDecoder('windows-1252');
    const utf16 = new TextDecoder('utf-16le');
    let text = '';
    for (let i = 0; i < n && text.length < ccpText; i++) {
      const fcRaw = tv.getUint32(pcdBase + i * 8 + 2, true);
      const compressed = (fcRaw & 0x40000000) !== 0;
      let count = cps[i + 1] - cps[i];
      if (count <= 0) continue;
      count = Math.min(count, ccpText - text.length);
      if (compressed) {
        const off = (fcRaw & 0x3FFFFFFF) / 2;
        text += cp1252.decode(wd.subarray(off, off + count));
      } else {
        const off = fcRaw;
        text += utf16.decode(wd.subarray(off, off + count * 2));
      }
    }
    return cleanText(text);
  }

  /** Replace Word's control characters with plain-text equivalents. */
  function cleanText(raw) {
    let out = '';
    let depth = 0;            // field nesting
    const showing = [];       // per field: are we in the result part?
    for (const ch of raw) {
      const c = ch.charCodeAt(0);
      if (c === 0x13) { depth++; showing.push(false); continue; }        // field begin
      if (c === 0x14) { if (depth) showing[depth - 1] = true; continue; } // field separator
      if (c === 0x15) { if (depth) { depth--; showing.pop(); } continue; } // field end
      if (depth && !showing[depth - 1]) continue;                          // field instruction text
      switch (c) {
        case 0x0D: out += '\n'; break;          // paragraph mark
        case 0x07: out += '\t'; break;          // table cell / row mark
        case 0x0B: out += '\u2028'; break;      // manual line break
        case 0x0C: out += '\f'; break;          // page / section break
        case 0x1E: out += '\u2011'; break;      // non-breaking hyphen
        case 0x1F: break;                       // optional hyphen
        case 0x01: case 0x08: case 0x02: case 0x05: break; // pictures, drawings, notes, annotations
        default:
          if (c >= 0x20 || c === 0x09) out += ch;
      }
    }
    return out;
  }

  /** Build editor HTML from the extracted text. */
  function textToFragment(text) {
    const frag = document.createDocumentFragment();
    const addPara = (line) => {
      const p = document.createElement('p');
      const parts = line.replace(/\t+$/, '').split('\u2028');
      parts.forEach((part, i) => {
        if (i) p.appendChild(document.createElement('br'));
        if (part) p.appendChild(document.createTextNode(part));
      });
      if (!p.firstChild) p.appendChild(document.createElement('br'));
      frag.appendChild(p);
    };
    const pages = text.replace(/\n$/, '').split('\f');
    pages.forEach((pageText, i) => {
      if (i) { const hr = document.createElement('hr'); hr.className = 'page-break'; frag.appendChild(hr); }
      pageText.split('\n').forEach((line, j, arr) => {
        if (i && j === 0 && line === '' && arr.length > 1) return;
        addPara(line);
      });
    });
    if (!frag.firstChild) addPara('');
    return frag;
  }

  /**
   * Import a binary .doc file as plain text.
   * @param {Uint8Array} bytes
   */
  function importDoc(bytes) {
    const cfb = parseCfb(bytes);
    const kind = classifyOle(cfb);
    if (kind === 'encrypted-ooxml') throw new ImportError('This document is password-protected. Remove the password in Word (File › Info › Protect Document), then open it here.');
    if (kind === 'excel') throw new ImportError('This is an Excel 97–2003 spreadsheet, not a Word document.');
    if (kind === 'powerpoint') throw new ImportError('This is a PowerPoint 97–2003 presentation, not a Word document.');
    if (kind !== 'word') throw new ImportError('This file is not a Word document.');
    const text = extractText(cfb);
    return {
      fragment: textToFragment(text),
      page: null,
      defaults: null,
      textOnly: true,
      warnings: [
        'Legacy .doc files are imported as plain text: the words and paragraph breaks are kept, but formatting, tables, images, headers and footnotes are not.',
        'For a complete import, open the file in Word, LibreOffice or Google Docs, save it as .docx, and open that file here. Saving from Folio always produces a .docx.'
      ]
    };
  }

  Folio.importDoc = importDoc;
  Folio.classifyOle = (bytes) => classifyOle(parseCfb(bytes));
})(window.Folio = window.Folio || {});
