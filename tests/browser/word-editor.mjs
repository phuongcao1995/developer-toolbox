// Browser check of the standalone Word editor (tools/word-editor/, "Folio"): headers, footers and page-number fields round trip.
//   BASE=http://localhost:8090/ node tests/browser/word-editor.mjs      (needs a static server, see harness.mjs)
import { createRequire } from 'node:module';
import { start } from './harness.mjs';

const JSZip = createRequire(import.meta.url)('../../tools/word-editor/vendor/jszip.min.js');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A small .docx with a header (text + simple PAGE field), a footer (complex PAGE / NUMPAGES fields) and body text. */
async function sampleDocx({ headerRefType = 'default', titlePg = false } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.file('_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  zip.file('word/document.xml', `${HEAD}<w:document ${W}><w:body><w:p><w:r><w:t>Body text</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="${headerRefType}" r:id="rId10"/><w:footerReference w:type="default" r:id="rId11"/>${titlePg ? '<w:titlePg/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="567" w:footer="454" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/header1.xml', `${HEAD}<w:hdr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">ACME Report </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p></w:hdr>`);
  zip.file('word/footer1.xml', `${HEAD}<w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`);
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

const h = await start();
const { ev, sleep, send, errors } = h;
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };
const open = (b64, name) => ev(`(async () => { const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)); await Folio.app.openFile(new File([bin], ${JSON.stringify(name)}, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })); return true; })()`);
const text = (id) => ev(`document.getElementById('${id}').textContent`);
/** Exports the current document and returns the zip entries as { path: text } (binary parts as their size). */
const exportParts = () => ev(`(async () => { const { blob } = await Folio.exportDocx(document.getElementById('editor'), { page: Folio.app.state.page, defaults: Folio.app.state.defaults, title: 't', header: Folio.headerFooter.header, footer: Folio.headerFooter.footer });
  const zip = await JSZip.loadAsync(blob); const out = {}; for (const n of Object.keys(zip.files).filter((k) => !zip.files[k].dir)) out[n] = /\\.(xml|rels)$/.test(n) ? await zip.file(n).async('string') : (await zip.file(n).async('uint8array')).length; return JSON.stringify(out); })()`).then(JSON.parse);

try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // a headless page is otherwise never focused, so focus events would not fire
  await send('Page.navigate', { url: h.base + 'tools/word-editor/index.html' }); await sleep(1500);
  check('editor loads', (await ev(`typeof Folio !== 'undefined' && !!Folio.headerFooter`)) === true);

  // ---- a document without headers saves without header parts
  await ev(`(document.getElementById('editor').innerHTML = '<p>Hello</p>', true)`);
  let parts = await exportParts();
  check('no header/footer parts when both are empty', !parts['word/header1.xml'] && !parts['word/footer1.xml'] && !/headerReference|footerReference/.test(parts['word/document.xml']));

  // ---- import
  await open(await sampleDocx(), 'sample.docx'); await sleep(500);
  check('header text is shown', (await text('pageHeader')).startsWith('ACME Report'), await text('pageHeader'));
  check('header keeps its page-number field as a chip', (await ev(`document.querySelectorAll('#pageHeader .fld[data-field="PAGE"]').length`)) === 1);
  check('the cached field value is replaced by the chip', !(await text('pageHeader')).includes('7'));
  check('footer fields (complex PAGE and NUMPAGES) become chips', (await ev(`[...document.querySelectorAll('#pageFooter .fld')].map((n) => n.dataset.field).join(',')`)) === 'PAGE,NUMPAGES');
  check('footer text around the fields is kept', (await text('pageFooter')).replace(/\d+/g, '#') === 'Page # of #', await text('pageFooter'));
  check('body is separate from header and footer', (await text('editor')) === 'Body text');
  check('header/footer distances come from the file', (await ev(`Folio.app.state.page.headerTw + ',' + Folio.app.state.page.footerTw`)) === '567,454');
  check('no warning about dropped headers', !(await ev(`document.getElementById('notice').textContent`)).includes('Headers and footers'));

  // ---- export round trip
  parts = await exportParts();
  const doc = parts['word/document.xml'];
  check('sectPr references the header and footer', /<w:headerReference w:type="default" r:id="rId\d+"\/>/.test(doc) && /<w:footerReference w:type="default" r:id="rId\d+"\/>/.test(doc));
  check('references come before the page size (schema order)', doc.indexOf('headerReference') < doc.indexOf('<w:pgSz'));
  check('header and footer distances are written back', /w:header="567" w:footer="454"/.test(doc));
  check('header part has the text, bold and a PAGE field', /ACME Report/.test(parts['word/header1.xml']) && /<w:b\/>/.test(parts['word/header1.xml']) && /<w:fldSimple w:instr=" PAGE ">/.test(parts['word/header1.xml']));
  check('footer part has PAGE and NUMPAGES fields', /w:instr=" PAGE "/.test(parts['word/footer1.xml']) && /w:instr=" NUMPAGES "/.test(parts['word/footer1.xml']));
  check('content types and relationships are registered', /header1\.xml/.test(parts['[Content_Types].xml']) && /footer1\.xml/.test(parts['[Content_Types].xml']) && /relationships\/header" Target="header1\.xml"/.test(parts['word/_rels/document.xml.rels']) && /relationships\/footer" Target="footer1\.xml"/.test(parts['word/_rels/document.xml.rels']));
  const re = await ev(`(async () => { const { blob } = await Folio.exportDocx(document.getElementById('editor'), { page: Folio.app.state.page, defaults: Folio.app.state.defaults, title: 't', header: Folio.headerFooter.header, footer: Folio.headerFooter.footer });
    const r = await Folio.importDocx(await blob.arrayBuffer()); const d = document.createElement('div'); d.append(r.header); const f = document.createElement('div'); f.append(r.footer); return JSON.stringify([d.textContent, d.querySelectorAll('.fld').length, f.querySelectorAll('.fld').length, r.page.headerTw]); })()`);
  check('re-opening the saved file gives the same header and footer', re === '["ACME Report 1",1,2,567]', re);

  // ---- editing
  await ev(`(Folio.headerFooter.header.focus(), true)`); await sleep(150);
  check('the mini toolbar appears while the header has focus', (await ev(`!document.getElementById('hfBar').hidden`)) === true);
  await ev(`(Folio.headerFooter.footer.innerHTML = '', Folio.headerFooter.footer.focus(), true)`); await sleep(100);
  await send('Input.insertText', { text: 'Confidential - ' }); await sleep(100);
  await ev(`(document.querySelector('#hfBar [data-hf="PAGE"]').click(), true)`); await sleep(100);
  check('Page # inserts a field chip in the footer', (await ev(`document.querySelectorAll('#pageFooter .fld[data-field="PAGE"]').length`)) === 1 && (await text('pageFooter')).startsWith('Confidential -'));
  check('typing in the footer marks the document as changed', (await ev(`document.getElementById('saveState').textContent`)) === 'Unsaved changes');
  await ev(`(document.querySelector('#hfBar [data-hf="justifyCenter"]').click(), true)`); await sleep(100);
  parts = await exportParts();
  check('an edited footer is saved (text, field, centred)', /Confidential/.test(parts['word/footer1.xml']) && /w:instr=" PAGE "/.test(parts['word/footer1.xml']) && /<w:jc w:val="center"\/>/.test(parts['word/footer1.xml']), parts['word/footer1.xml'].slice(-400));

  // ---- paste is reduced to plain text
  await ev(`(() => { const hd = Folio.headerFooter.header; hd.innerHTML = ''; hd.focus(); const dt = new DataTransfer(); dt.setData('text/html', '<b onclick="alert(1)">Bold</b><script>1</script>'); dt.setData('text/plain', 'Plain pasted'); hd.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`); await sleep(150);
  check('pasted content becomes plain text', (await text('pageHeader')) === 'Plain pasted' && (await ev(`!Folio.headerFooter.header.querySelector('b, script, [onclick]')`)) === true);

  // ---- clearing and new document
  await ev(`(document.querySelector('#hfBar [data-hf="clear"]').click(), true)`); await sleep(100);
  check('Clear empties the region (placeholder shows again)', (await ev(`Folio.headerFooter.header.innerHTML`)) === '');
  await ev(`(Folio.app.newDocument(true), true)`); await sleep(300);
  check('a new document has empty header and footer', (await text('pageHeader')) === '' && (await text('pageFooter')) === '');

  // ---- images in a header survive
  await open(await sampleDocx(), 'again.docx'); await sleep(400);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await ev(`(() => { const hd = Folio.headerFooter.header; const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0)); const img = document.createElement('img'); img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); img.width = 40; img.height = 40; hd.prepend(img); return true; })()`); await sleep(300);
  parts = await exportParts();
  check('a picture in the header is saved as media with its own relationship', typeof parts['word/media/image1.png'] === 'number' && /media\/image1\.png/.test(parts['word/_rels/header1.xml.rels'] || '') && /r:embed="rId1"/.test(parts['word/header1.xml']), Object.keys(parts).join(','));
  const re2 = await ev(`(async () => { const { blob } = await Folio.exportDocx(document.getElementById('editor'), { page: Folio.app.state.page, defaults: Folio.app.state.defaults, title: 't', header: Folio.headerFooter.header, footer: Folio.headerFooter.footer });
    const r = await Folio.importDocx(await blob.arrayBuffer()); const d = document.createElement('div'); d.append(r.header); return d.querySelectorAll('img').length; })()`);
  check('the header picture is read back', re2 === 1, String(re2));

  // ---- header variants are reported, not silently dropped
  await open(await sampleDocx({ titlePg: true }), 'variants.docx'); await sleep(400);
  check('different-first-page headers produce a warning', (await ev(`document.getElementById('notice').textContent`)).includes('first-page'));

  // ---- the bundled sample documents still open and save
  for (const name of ['sample.docx', 'sample-libreoffice.docx', 'sample.doc']) {
    const r = await ev(`(async () => { const res = await fetch('samples/${name}'); const file = new File([await res.arrayBuffer()], '${name}'); await Folio.app.openFile(file);
      const { blob } = await Folio.exportDocx(document.getElementById('editor'), { page: Folio.app.state.page, defaults: Folio.app.state.defaults, title: 't', header: Folio.headerFooter.header, footer: Folio.headerFooter.footer });
      return JSON.stringify([document.getElementById('editor').textContent.length > 20, blob.size > 1000]); })()`);
    check(`${name} opens and saves`, r === '[true,true]', String(r));
  }

  // ---- text tools: super/subscript, change case, symbols, horizontal line, format painter, plain paste
  await ev(`(Folio.app.newDocument(true), true)`); await sleep(300);
  const setBody = (html) => ev(`(Folio.app.editor.setContent(${JSON.stringify(html)}), true)`);
  /** Selects text between two offsets of the first text node of the first element matching `sel`. */
  const selectText = (sel, a, b) => ev(`(() => { const n = document.querySelector('#editor ${sel}'); const t = document.createTreeWalker(n, NodeFilter.SHOW_TEXT).nextNode(); const r = document.createRange(); r.setStart(t, ${a}); r.setEnd(t, ${b}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  const bodyHtml = () => ev(`document.getElementById('editor').innerHTML`);
  const exportBody = async () => (await exportParts())['word/document.xml'];

  await setBody('<p>E = mc2 and H2O</p>');
  await selectText('p', 6, 7);
  await ev(`(document.querySelector('[data-cmd="superscript"]').click(), true)`); await sleep(100);
  check('superscript button raises the selection', /<sup>2<\/sup>|vertical-align: super[^>]*>2</.test(await bodyHtml()), await bodyHtml());
  check('superscript is saved as vertAlign', /w:vertAlign w:val="superscript"/.test(await exportBody()));
  await selectText('p', 0, 1);
  await ev(`(document.querySelector('[data-cmd="subscript"]').click(), true)`); await sleep(100);
  check('subscript is saved as vertAlign', /w:vertAlign w:val="subscript"/.test(await exportBody()));

  const caseTest = async (mode, html, a, b, expected) => {
    await setBody(html); await selectText('p', a, b);
    await ev(`(Folio.app.editor.changeCase('${mode}'), true)`); await sleep(50);
    const got = await ev(`document.querySelector('#editor p').textContent`);
    check(`change case: ${mode} (${expected})`, got === expected, got);
  };
  await caseTest('upper', '<p>hello world</p>', 0, 11, 'HELLO WORLD');
  await caseTest('lower', '<p>HELLO World</p>', 0, 11, 'hello world');
  await caseTest('title', "<p>the QUICK brown fox's tail</p>", 0, 26, "The Quick Brown Fox's Tail");
  await caseTest('sentence', '<p>HELLO there. how ARE you? fine</p>', 0, 30, 'Hello there. How are you? Fine');
  await caseTest('toggle', '<p>Hello</p>', 0, 5, 'hELLO');
  await caseTest('upper', '<p>one two three</p>', 5, 5, 'one TWO three'); // caret in a word
  await caseTest('sentence', '<p>Done. keep this part</p>', 6, 20, 'Done. Keep this part'); // selection starts a new sentence
  await caseTest('lower', '<p>Straße ÉCOLE</p>', 0, 12, 'straße école');
  await setBody('<p>one <b>TWO</b> three</p>');
  await ev(`(() => { const p = document.querySelector('#editor p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); Folio.app.editor.changeCase('title'); return true; })()`); await sleep(50);
  check('change case keeps formatting across nodes', (await bodyHtml()).includes('<b>Two</b>') && (await ev(`document.querySelector('#editor p').textContent`)) === 'One Two Three', await bodyHtml());

  await setBody('<p>Price: </p>');
  await ev(`(() => { const p = document.querySelector('#editor p'); const t = p.firstChild; const r = document.createRange(); r.setStart(t, t.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  await ev(`(document.querySelector('[data-popover="specialMenu"]').click(), true)`); await sleep(100);
  check('the symbol menu opens with a grid of symbols', (await ev(`document.querySelectorAll('#symbolGrid button').length`)) >= 30);
  await ev(`(document.querySelector('#symbolGrid [data-symbol="\\u20AC"]').click(), true)`); await sleep(100);
  check('a symbol is inserted at the caret', (await ev(`document.querySelector('#editor p').textContent`)) === 'Price: €');
  await ev(`(document.querySelector('[data-popover="specialMenu"]').click(), document.querySelector('#specialMenu [data-special="line"]').click(), true)`); await sleep(100);
  check('Horizontal line inserts an <hr>', (await ev(`document.querySelectorAll('#editor hr:not(.page-break)').length`)) === 1);
  check('the horizontal line is saved as a bordered paragraph', /<w:pBdr><w:bottom /.test(await exportBody()));
  await ev(`(document.querySelector('[data-popover="specialMenu"]').click(), document.querySelector('#specialMenu [data-special="date"]').click(), true)`); await sleep(100);
  check("Today's date is inserted", /\b20\d\d\b/.test(await ev(`document.getElementById('editor').textContent`)));

  await setBody('<p><b style="color:#c00000">Fancy</b> plain words</p>');
  await ev(`(() => { const t = document.querySelector('#editor b').firstChild; const r = document.createRange(); r.setStart(t, 2); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  await ev(`(document.querySelector('[data-cmd="formatPainter"]').click(), true)`); await sleep(100);
  check('format painter button shows it is active', (await ev(`document.querySelector('[data-cmd="formatPainter"]').getAttribute('aria-pressed')`)) === 'true');
  await ev(`(() => { const t = document.querySelector('#editor p').lastChild; const r = document.createRange(); r.setStart(t, 1); r.setEnd(t, 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`); await sleep(300);
  const painted = await ev(`(() => { const n = [...document.querySelectorAll('#editor b, #editor span')].find((x) => x.textContent === 'plain' && !x.children.length); if (!n) return 'none'; const cs = getComputedStyle(n); return [parseInt(cs.fontWeight, 10) >= 600, cs.color].join(','); })()`);
  check('format painter copies bold and colour onto the selection', painted === 'true,rgb(192, 0, 0)', painted + ' ' + await bodyHtml());
  check('format painter switches itself off', (await ev(`document.querySelector('[data-cmd="formatPainter"]').getAttribute('aria-pressed')`)) === 'false');

  await setBody('<p>Start </p>');
  await ev(`(() => { const t = document.querySelector('#editor p').firstChild; const r = document.createRange(); r.setStart(t, t.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const ed = document.getElementById('editor'); ed.focus();
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    const dt = new DataTransfer(); dt.setData('text/html', '<b style="color:red">Rich</b>'); dt.setData('text/plain', 'Plain'); ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`); await sleep(200);
  check('Ctrl+Shift+V pastes plain text only', (await ev(`document.querySelector('#editor p').textContent`)) === 'Start Plain' && (await ev(`!document.querySelector('#editor b')`)) === true, await bodyHtml());

  // ---- Paragraph dialog
  await setBody('<p>First paragraph</p><p>Second paragraph</p>');
  await selectText('p', 2, 4);
  await ev(`(document.querySelector('[data-cmd="paragraph"]').click(), true)`); await sleep(300);
  check('Paragraph dialog opens', (await ev(`!!document.querySelector('#modal[open] input[name="left"]')`)) === true);
  const fill = (name, value) => ev(`(() => { const f = document.querySelector('#modal [name="${name}"]'); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await fill('left', '0.5'); await fill('right', '0.25'); await fill('special', 'hanging'); await fill('by', '0.25');
  await fill('before', '6'); await fill('after', '12'); await fill('line', '1.5');
  await ev(`(document.querySelector('#modal button[value="ok"]').click(), true)`); await sleep(300);
  const metrics = (expr) => `(() => { const el = ${expr}; const c = getComputedStyle(el); return [c.marginLeft, c.marginRight, c.textIndent, c.marginTop, c.marginBottom].map((v) => Math.round(parseFloat(v) * 0.75)).join(',') + ',' + el.style.lineHeight; })()`;
  const styled = await ev(metrics(`document.querySelector('#editor p')`));
  check('the settings are applied as paragraph styles', styled === '36,18,-18,6,12,1.5', styled);
  check('only the selected paragraph changed', (await ev(`document.querySelectorAll('#editor p')[1].getAttribute('style')`)) === null || !/margin-left/.test(await ev(`document.querySelectorAll('#editor p')[1].getAttribute('style') || ''`)));
  const docXml = await exportBody();
  check('indents, hanging and spacing are saved to the .docx', /<w:spacing w:before="120" w:after="240" w:line="360" w:lineRule="auto"\/>/.test(docXml) && /<w:ind w:left="720" w:right="360" w:hanging="360"\/>/.test(docXml), docXml.slice(docXml.indexOf('<w:body>'), docXml.indexOf('<w:body>') + 500));
  const back = await ev(`(async () => { const { blob } = await Folio.exportDocx(document.getElementById('editor'), { page: Folio.app.state.page, defaults: Folio.app.state.defaults, title: 't' }); const r = await Folio.importDocx(await blob.arrayBuffer()); const d = document.createElement('div'); d.append(r.fragment); const p = d.querySelector('p'); return [p.style.marginLeft, p.style.marginRight, p.style.textIndent].join(','); })()`);
  check('a saved paragraph reads back with the same indents', back === '36pt,18pt,-18pt', back);
  await selectText('p', 2, 4);
  await ev(`(document.querySelector('[data-cmd="paragraph"]').click(), true)`); await sleep(300);
  check('the dialog is filled in from the paragraph', (await ev(`document.querySelector('#modal [name="left"]').value`)) === '0.5' && (await ev(`document.querySelector('#modal [name="special"]').value`)) === 'hanging' && (await ev(`document.querySelector('#modal [name="line"]').value`)) === '1.5');
  await ev(`(document.querySelector('#modal button[value="cancel"]').click(), true)`); await sleep(200);
  check('Cancel leaves the paragraph alone', (await ev(metrics(`document.querySelector('#editor p')`))) === '36,18,-18,6,12,1.5');

  // ---- W2: styles gallery, table tools, footnotes, table of contents
  const roundTrip = (inner) => ev(`(async () => { const { blob } = await Folio.exportDocx(document.getElementById('editor'), { page: Folio.app.state.page, defaults: Folio.app.state.defaults, title: 't' }); const r = await Folio.importDocx(await blob.arrayBuffer()); const d = document.createElement('div'); d.append(r.fragment); return ${inner}; })()`);
  const click = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}).click(), true)`);
  await ev(`(Folio.app.newDocument(true), true)`); await sleep(300);
  await setBody('<p>My Title</p><p>A subtitle</p><p>Body text</p>');
  await selectText('p', 0, 3);
  await ev(`(() => { const s = document.getElementById('blockStyle'); s.value = 'title'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await sleep(150);
  check('Title style makes a paragraph with class title', (await ev(`document.querySelector('#editor p.title') && document.querySelector('#editor p.title').textContent`)) === 'My Title', await bodyHtml());
  await selectText('p:nth-of-type(2)', 0, 3);
  await ev(`(() => { const s = document.getElementById('blockStyle'); s.value = 'subtitle'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await sleep(150);
  check('Subtitle style works', (await ev(`!!document.querySelector('#editor p.subtitle')`)) === true);
  const stx = await exportBody();
  check('Title and Subtitle are saved as Word styles', /<w:pStyle w:val="Title"\/>/.test(stx) && /<w:pStyle w:val="Subtitle"\/>/.test(stx));
  check('they read back as Title and Subtitle', (await roundTrip(`d.querySelectorAll('p.title').length + ',' + d.querySelectorAll('p.subtitle').length`)) === '1,1');
  await selectText('p.title', 0, 3);
  await sleep(150);
  check('the style box shows the current style', (await ev(`document.getElementById('blockStyle').value`)) === 'title');
  await ev(`(() => { const s = document.getElementById('blockStyle'); s.value = 'p'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await sleep(150);
  check('switching back to Normal removes the class', (await ev(`document.querySelectorAll('#editor p.title').length`)) === 0 && !/class=/.test((await bodyHtml()).split('</p>')[0]));

  // table tools
  await setBody('<p>x</p>');
  await ev(`(Folio.app.editor.insertTable(3, 3), true)`); await sleep(200);
  const cellText = (i, t) => ev(`(() => { const c = document.querySelectorAll('#editor td')[${i}]; c.querySelector('p').textContent = ${JSON.stringify(t)}; return true; })()`);
  await cellText(0, 'A'); await cellText(1, 'B'); await cellText(3, 'D');
  const selectCells = (i, j) => ev(`(() => { const t = document.querySelectorAll('#editor td'); const r = document.createRange(); r.setStart(t[${i}].querySelector('p'), 0); r.setEnd(t[${j}].querySelector('p'), 1); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  await selectCells(0, 1);
  await ev(`(Folio.app.editor.tableAction('mergeCells'), true)`); await sleep(150);
  check('Merge cells joins two cells in a row (colspan 2, text kept)', (await ev(`(() => { const c = document.querySelector('#editor td'); return c.colSpan + ':' + c.textContent; })()`)) === '2:AB', await bodyHtml());
  check('the table now has 8 cells', (await ev(`document.querySelectorAll('#editor td').length`)) === 8);
  const mx = await exportBody();
  check('the merge is saved as gridSpan', /<w:gridSpan w:val="2"\/>/.test(mx));
  await ev(`(Folio.app.editor.restoreSelection(), true)`);
  await selectText('td', 0, 1);
  await ev(`(Folio.app.editor.tableAction('splitCell'), true)`); await sleep(150);
  check('Split cell restores nine cells', (await ev(`document.querySelectorAll('#editor td').length`)) === 9 && (await ev(`document.querySelector('#editor td').colSpan`)) === 1);
  // vertical merge of first column, rows 1-2
  await selectCells(0, 3);
  await ev(`(Folio.app.editor.tableAction('mergeCells'), true)`); await sleep(150);
  check('Merge cells works down a column (rowspan 2)', (await ev(`document.querySelector('#editor td').rowSpan`)) === 2 && (await ev(`document.querySelectorAll('#editor td').length`)) === 8);
  check('a vertical merge is saved as vMerge', /<w:vMerge w:val="restart"\/>/.test(await exportBody()) && /<w:vMerge\/>/.test(await exportBody()));
  await selectText('td', 0, 1);
  await ev(`(Folio.app.editor.tableAction('splitCell'), true)`); await sleep(150);
  check('splitting a vertical merge restores the grid', (await ev(`document.querySelectorAll('#editor td').length`)) === 9 && (await ev(`[...document.querySelectorAll('#editor tr')].map((r) => r.cells.length).join(',')`)) === '3,3,3');

  await selectText('td', 0, 1);
  await ev(`(Folio.app.editor.tableAction('shade:#ffcc00'), true)`); await sleep(100);
  check('Shade cell sets the background', (await ev(`document.querySelector('#editor td').style.backgroundColor`)) !== '');
  check('the shading is saved', /w:fill="FFCC00"/i.test(await exportBody()));
  await ev(`(Folio.app.editor.tableAction('headerRow'), true)`); await sleep(100);
  check('Header row turns the first row into header cells', (await ev(`document.querySelectorAll('#editor tr:first-child th').length`)) === 3);
  await ev(`(Folio.app.editor.tableAction('headerRow'), true)`); await sleep(100);
  check('...and back', (await ev(`document.querySelectorAll('#editor th').length`)) === 0);
  await ev(`(Folio.app.editor.tableAction('borders'), true)`); await sleep(100);
  check('Borders off marks the table borderless and saves nil borders', (await ev(`document.querySelector('#editor table').classList.contains('borderless')`)) === true && /<w:top w:val="nil"\/>/.test(await exportBody()));
  await ev(`(Folio.app.editor.undo ? Folio.app.editor.undo() : 0, true)`); await sleep(100);

  // footnotes
  await setBody('<p>Alpha beta gamma</p><p>Second paragraph</p>');
  await ev(`(() => { const t = document.querySelector('#editor p').firstChild; const r = document.createRange(); r.setStart(t, 5); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  await click('[data-cmd="footnote"]'); await sleep(300);
  check('the footnote dialog opens', (await ev(`!!document.querySelector('#modal[open] textarea[name="note"]')`)) === true);
  await ev(`(() => { const t = document.querySelector('#modal textarea[name="note"]'); t.value = 'See the appendix.'; return true; })()`);
  await click('#modal button[value="ok"]'); await sleep(300);
  check('a numbered marker is inserted', (await ev(`document.querySelectorAll('#editor span.fn').length`)) === 1 && (await ev(`document.querySelector('#editor span.fn').textContent`)) === '1');
  check('the note is listed under the document', (await ev(`document.getElementById('footnoteList').hidden`)) === false && (await ev(`document.querySelector('#footnoteList li').textContent`)) === 'See the appendix.');
  // second footnote before the first one in reading order
  await ev(`(() => { const t = document.querySelector('#editor p').firstChild; const r = document.createRange(); r.setStart(t, 1); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  await click('[data-cmd="footnote"]'); await sleep(300);
  await ev(`(() => { document.querySelector('#modal textarea[name="note"]').value = 'First in the text'; return true; })()`);
  await click('#modal button[value="ok"]'); await sleep(300);
  check('footnotes are renumbered in reading order', (await ev(`[...document.querySelectorAll('#footnoteList li')].map((l) => l.textContent).join('|')`)) === 'First in the text|See the appendix.', await roundTrip(`d.innerHTML`));
  const fx = await exportParts();
  check('footnotes are saved as a real footnotes part', typeof fx['word/footnotes.xml'] === 'string' && (fx['word/footnotes.xml'].match(/<w:footnote w:id="\d+">/g) || []).length === 2 && /See the appendix\./.test(fx['word/footnotes.xml']));
  check('the body references them', (fx['word/document.xml'].match(/<w:footnoteReference /g) || []).length === 2 && /footnotes\.xml/.test(fx['[Content_Types].xml']) && /relationships\/footnotes/.test(fx['word/_rels/document.xml.rels']));
  check('footnotes read back from the .docx', (await roundTrip(`[...d.querySelectorAll('span.fn')].map((n) => n.getAttribute('data-note')).join('|')`)) === 'First in the text|See the appendix.', await roundTrip(`d.innerHTML`));
  await ev(`(document.querySelector('#editor span.fn').click(), true)`); await sleep(300);
  check('clicking a marker opens its note', (await ev(`document.querySelector('#modal textarea[name="note"]').value`)) === 'First in the text');
  await ev(`(() => { document.querySelector('#modal textarea[name="note"]').value = 'Edited note'; return true; })()`);
  await click('#modal button[value="ok"]'); await sleep(300);
  check('editing updates the list', (await ev(`document.querySelector('#footnoteList li').textContent`)) === 'Edited note');
  await ev(`(document.querySelector('#editor span.fn').click(), true)`); await sleep(300);
  await click('#modal button[value="delete"]'); await sleep(300);
  check('deleting removes the marker and renumbers', (await ev(`document.querySelectorAll('#editor span.fn').length`)) === 1 && (await ev(`document.querySelector('#editor span.fn').textContent`)) === '1' && (await ev(`document.querySelectorAll('#footnoteList li').length`)) === 1);
  await ev(`(Folio.app.editor.undo(), true)`); await sleep(200);
  check('undo brings the footnote back', (await ev(`document.querySelectorAll('#editor span.fn').length`)) === 2 && (await ev(`document.querySelectorAll('#footnoteList li').length`)) === 2);
  await setBody('<p>No notes</p>');
  await ev(`(Folio.references.refresh(), true)`);
  check('the list hides when there are no footnotes', (await ev(`document.getElementById('footnoteList').hidden`)) === true);

  // table of contents
  await setBody('<h1>Intro</h1><p>text</p><h2>Details</h2><p>more</p><h3>Deep</h3><h1>End</h1>');
  await ev(`(() => { const t = document.querySelector('#editor p').firstChild; const r = document.createRange(); r.setStart(t, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.getElementById('editor').focus(); return true; })()`);
  await click('[data-cmd="toc"]'); await sleep(300);
  check('the table of contents lists the headings', (await ev(`[...document.querySelectorAll('#editor .toc a')].map((a) => a.textContent).join('|')`)) === 'Intro|Details|Deep|End', await bodyHtml());
  check('headings got link targets', (await ev(`[...document.querySelectorAll('#editor h1, #editor h2, #editor h3')].every((h) => /^toc-\\d+$/.test(h.id))`)) === true);
  check('entries are indented by level', (await ev(`document.querySelector('#editor .toc-2').style.marginLeft`)) === '18pt');
  const tx = await exportBody();
  check('the TOC is saved with links and bookmarks', /<w:hyperlink w:anchor="toc-1"/.test(tx) && /<w:bookmarkStart w:id="\d+" w:name="toc-1"\/>/.test(tx));
  await ev(`(() => { const h = document.createElement('h2'); h.textContent = 'Added later'; document.querySelector('#editor').insertBefore(h, document.querySelector('#editor h1:last-of-type')); return true; })()`);
  await click('[data-cmd="toc"]'); await sleep(300);
  check('updating rebuilds the list without a second TOC', (await ev(`document.querySelectorAll('#editor .toc').length`)) === 1 && (await ev(`document.querySelectorAll('#editor .toc a').length`)) === 5);
  const tocBack = await roundTrip(`d.querySelectorAll('a[href^="#"]').length`);
  check("the TOC links survive a save and reopen", tocBack === 5, String(tocBack));

  const real = errors.filter((e) => !/favicon\.ico/.test(e));
  check('no console errors', real.length === 0, real.join(' | ').slice(0, 300));
} catch (e) { failed++; console.log('FAIL  script error', e.stack || e); }
finally { h.finish(); }
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
