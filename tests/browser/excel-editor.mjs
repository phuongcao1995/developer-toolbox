// Browser check of the standalone Sheet Editor (tools/excel-editor/): autofill with the real fill handle, Ctrl+D, new formulas.
//   BASE=http://localhost:8090/ node tests/browser/excel-editor.mjs      (needs a static server, see harness.mjs)
import { start } from './harness.mjs';

const h = await start();
const { ev, sleep, send, errors } = h;
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };
const app = 'SheetApp.app';
const shown = (r, c) => ev(`${app}.wb.getDisplay(${app}.wb.activeIndex, ${r}, ${c}).text`);
const input = (r, c) => ev(`${app}.wb.getInputText(${app}.wb.activeIndex, ${r}, ${c})`);
const set = (r, c, text) => ev(`(${app}.wb.setCellInput(${app}.wb.activeIndex, ${r}, ${c}, ${JSON.stringify(text)}), true)`);
const select = (r1, c1, r2, c2) => ev(`(${app}.grid.select({ row: ${r1}, col: ${c1} }, { row: ${r2}, col: ${c2} }), true)`);
/** Stage-relative centre of a cell, converted to page coordinates. */
const cellPoint = (r, c, corner = false) => ev(`(() => { const g = ${app}.grid; const rect = g.rangeStageRect({ r1: ${r}, c1: ${c}, r2: ${r}, c2: ${c} }); const b = g.stage.getBoundingClientRect();
  return JSON.stringify({ x: b.left + rect.x + (${corner} ? rect.w : rect.w / 2), y: b.top + rect.y + (${corner} ? rect.h : rect.h / 2) }); })()`).then(JSON.parse);
const mouse = (type, p) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
const drag = async (from, to) => { await mouse('mouseMoved', from); await mouse('mousePressed', from); await mouse('mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }); await mouse('mouseMoved', to); await sleep(80); await mouse('mouseReleased', to); await sleep(150); };
const key = async (k, ctrl) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: ctrl ? 2 : 0 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: ctrl ? 2 : 0 });
  await sleep(100);
};

try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: h.base + 'tools/excel-editor/index.html' }); await sleep(1500);
  check('editor loads', (await ev(`typeof ${app} === 'object' && !!${app}.wb`)) === true);

  // ---- fill handle: numeric series downwards
  await set(0, 0, '1'); await set(1, 0, '2');
  await select(0, 0, 1, 0); await sleep(100);
  check('fill handle is drawn on the selection', (await ev(`document.querySelectorAll('.fill-handle').length`)) === 1);
  const from = await cellPoint(1, 0, true), to = await cellPoint(5, 0);
  check('pointer over the handle shows a crosshair', (await mouse('mouseMoved', from), await sleep(50), await ev(`${app}.grid.stage.style.cursor`)) === 'crosshair');
  await drag(from, to);
  const col = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((r) => shown(r, 0)));
  check('dragging the handle continues the series (1, 2 -> 3, 4, 5, 6)', col.join(',') === '1,2,3,4,5,6,', col.join(','));
  check('the filled range is selected', (await ev(`JSON.stringify(${app}.grid.getSelection().range)`)) === JSON.stringify({ r1: 0, c1: 0, r2: 5, c2: 0 }));

  // ---- one undo step undoes the whole fill
  await ev(`(${app}.undo(), true)`);
  check('undo removes the whole fill in one step', (await shown(2, 0)) === '' && (await shown(1, 0)) === '2' && (await shown(5, 0)) === '');

  // ---- horizontal fill of text and formulas
  await set(10, 0, 'Mon'); await set(11, 0, '=A1+10');
  await select(10, 0, 11, 0);
  await drag(await cellPoint(11, 0, true), await cellPoint(11, 3));
  check('weekday names continue to the right', (await Promise.all([1, 2, 3].map((c) => shown(10, c)))).join(',') === 'Tue,Wed,Thu');
  check('formulas shift when filled right (=A1+10 -> =B1+10)', (await input(11, 1)) === '=B1+10' && (await input(11, 3)) === '=D1+10');

  // ---- Ctrl+D
  await set(20, 0, 'x'); await set(20, 1, '5'); await select(20, 0, 23, 1);
  await key('d', true);
  const filled = await Promise.all([20, 21, 22, 23].map((r) => shown(r, 0)));
  check('Ctrl+D copies the first row down', filled.join(',') === 'x,x,x,x' && (await shown(23, 1)) === '5', filled.join(','));
  await set(30, 0, '=1+1'); await select(31, 0, 31, 0); await key('d', true);
  check('Ctrl+D on one cell copies the cell above', (await input(31, 0)) === '=1+1');
  await set(40, 0, 'left'); await select(40, 0, 40, 2); await key('r', true);
  check('Ctrl+R copies the first column right', (await shown(40, 2)) === 'left');

  // ---- new functions typed into cells
  await set(50, 0, 'Ann'); await set(50, 1, '80'); await set(51, 0, 'Bob'); await set(51, 1, '95');
  await set(52, 0, '=VLOOKUP("Bob",A51:B52,2,FALSE)');
  await set(53, 0, '=SUMIFS(B51:B52,A51:A52,"Ann")');
  await set(54, 0, '=INDEX(B51:B52,MATCH("Bob",A51:A52,0))');
  await set(55, 0, '=DATE(2024,5,1)');
  await set(56, 0, '=TEXTJOIN(", ",TRUE,A51:A52)');
  await set(57, 0, '=XLOOKUP("Ann",A51:A52,B51:B52,"none")');
  await set(58, 0, '=ROW()+COLUMN()');
  const out = await Promise.all([52, 53, 54, 55, 56, 57, 58].map((r) => shown(r, 0)));
  check('VLOOKUP, SUMIFS, INDEX/MATCH', out[0] === '95' && out[1] === '80' && out[2] === '95', out.join('|'));
  check('=DATE shows as a date, not a serial number', out[3] === '2024-05-01', out[3]);
  check('TEXTJOIN, XLOOKUP, ROW()+COLUMN()', out[4] === 'Ann, Bob' && out[5] === '80' && out[6] === '60', out.join('|'));
  check('no formula is flagged as unsupported', (await ev(`${app}.wb.getDisplay(0, 52, 0).warning || ''`)) === '');
  // ---- formula editing: point-and-click references, colour boxes, F4, function suggestions
  const pressKey = async (name, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: vk });
    await sleep(100);
  };
  const type = async (text) => { await send('Input.insertText', { text }); await sleep(100); };
  const editorText = () => ev(`${app}.grid.editing ? ${app}.grid.editing.text : null`);
  await ev(`(${app}.grid.scroller.scrollTop = 0, ${app}.grid.scroller.scrollLeft = 0, true)`); await sleep(150); // keep the cells away from the edges, which auto-scroll while dragging
  await set(15, 6, '5'); await set(15, 7, '7');
  await select(15, 8, 15, 8); await ev(`(${app}.grid.focus(), true)`);
  await type('=SUM(');
  await drag(await cellPoint(15, 6), await cellPoint(15, 7));
  check('dragging over cells while typing a formula inserts the range', (await editorText()) === '=SUM(G16:H16', await editorText());
  check('the referenced cells get a coloured box', (await ev(`document.querySelectorAll('.ref-box').length`)) === 1);
  await type(')'); await pressKey('Enter', 13);
  check('the formula commits and calculates', (await shown(15, 8)) === '12' && (await input(15, 8)) === '=SUM(G16:H16)');

  await select(16, 8, 16, 8); await type('=');
  await mouse('mouseMoved', await cellPoint(15, 6)); await mouse('mousePressed', await cellPoint(15, 6)); await mouse('mouseReleased', await cellPoint(15, 6)); await sleep(100);
  await type('+');
  await mouse('mouseMoved', await cellPoint(15, 7)); await mouse('mousePressed', await cellPoint(15, 7)); await mouse('mouseReleased', await cellPoint(15, 7)); await sleep(100);
  check('clicking single cells inserts each address', (await editorText()) === '=G16+H16', await editorText());
  await pressKey('F4', 115);
  check('F4 makes the reference under the caret absolute', (await editorText()) === '=G16+$H$16', await editorText());
  await pressKey('F4', 115);
  check('F4 again fixes only the row', (await editorText()) === '=G16+H$16', await editorText());
  await pressKey('Enter', 13);
  check('absolute reference is stored', (await input(16, 8)) === '=G16+H$16' && (await shown(16, 8)) === '12');

  await select(17, 8, 17, 8); await type('=7+'); await mouse('mouseMoved', await cellPoint(15, 6)); await mouse('mousePressed', await cellPoint(15, 6)); await mouse('mouseReleased', await cellPoint(15, 6)); await sleep(100);
  await type('1'); // typing after a pointed reference continues normally
  check('typing after a pointed reference works', (await editorText()) === '=7+G161', await editorText());
  await pressKey('Escape', 27);
  check('Escape cancels the edit', (await ev(`${app}.grid.isEditing()`)) === false && (await input(17, 8)) === '');

  await select(18, 8, 18, 8); await type('=VLO');
  check('typing a function name shows suggestions', (await ev(`(() => { const l = document.querySelector('.fn-suggest'); return !!l && !l.hidden && l.textContent.includes('VLOOKUP'); })()`)) === true);
  await pressKey('Tab', 9);
  check('Tab accepts the suggestion and opens the bracket', (await editorText()) === '=VLOOKUP(', await editorText());
  check('suggestions close after accepting', (await ev(`document.querySelector('.fn-suggest').hidden`)) === true);
  await pressKey('Escape', 27);
  await select(19, 8, 19, 8); await type('=1+2'); await mouse('mouseMoved', await cellPoint(15, 6)); await mouse('mousePressed', await cellPoint(15, 6)); await mouse('mouseReleased', await cellPoint(15, 6)); await sleep(150);
  check('clicking a cell where no reference fits commits the formula, as in Excel', (await input(19, 8)) === '=1+2' && (await ev(`${app}.grid.isEditing()`)) === false);

  // ---- hide / show, paste special, format painter, tab colour, Ctrl+;
  await ev(`(${app}.grid.scroller.scrollTop = 0, ${app}.grid.scroller.scrollLeft = 0, true)`); await sleep(100);
  await set(70, 0, 'a'); await set(70, 1, 'b'); await set(70, 2, 'c'); await set(71, 0, '2'); await set(71, 1, '=A72*3');
  await ev(`(${app}.wb.setHidden(${app}.wb.activeIndex, 'col', [1], true), ${app}.grid.layout(), true)`);
  const headers = await ev(`[...document.querySelectorAll('.hdr.col')].map((n) => n.textContent.trim()).slice(0, 4).join(',')`);
  check('a hidden column disappears from the headers', headers === 'A,C,D,E', headers);
  await select(70, 0, 70, 0); await key('ArrowRight'.charAt(0) === 'A' ? 'ArrowRight' : 'x');
  check('arrow keys skip hidden columns', (await ev(`${app}.grid.getSelection().active.col`)) === 2);
  const FM = 'SheetApp.fileManager';
  const roundTrip = await ev(`(async () => { const blob = await ${FM}.writeXlsx(${app}.wb); const info = await ${FM}.inspectFile(new File([blob], 't.xlsx')); const wb2 = (await ${FM}.loadWorkbook(info)).workbook; return JSON.stringify([...wb2.sheets[0].hiddenCols]); })()`);
  check('hidden columns survive saving to .xlsx and reopening', roundTrip === '[1]', roundTrip);
  const xlsRound = await ev(`(async () => { const blob = ${FM}.writeXls(${app}.wb); const info = await ${FM}.inspectFile(new File([blob], 't.xls')); const wb2 = (await ${FM}.loadWorkbook(info)).workbook; return JSON.stringify([...wb2.sheets[0].hiddenCols]); })()`);
  check('hidden columns survive saving to .xls and reopening', xlsRound === '[1]', xlsRound);
  await ev(`(${app}.wb.setHidden(${app}.wb.activeIndex, 'col', [1], false), ${app}.grid.layout(), true)`);

  await select(71, 1, 71, 1); await ev(`(${app}.grid.focus(), true)`);
  await ev(`(() => { const g = ${app}.grid; g.clipboard = { data: ${app}.wb.copyRange(${app}.wb.activeIndex, g.getSelection().range), isCut: false, sheetId: g.sheet.id }; return true; })()`);
  await select(73, 0, 73, 0); await ev(`(${app}.grid.pasteSpecial('values'), true)`);
  check('paste values only: the result, not the formula', (await input(73, 0)) === '6', await input(73, 0));

  await ev(`(${app}.wb.updateStyle(${app}.wb.activeIndex, [{ r1: 70, c1: 0, r2: 70, c2: 0 }], (st) => { st.font = { bold: true }; }, 'bold'), true)`);
  await select(70, 0, 70, 0);
  await ev(`(document.querySelector('[data-action="format-painter"]').click(), true)`); await sleep(100);
  check('format painter button shows it is active', (await ev(`document.querySelector('[data-action="format-painter"]').getAttribute('aria-pressed')`)) === 'true');
  await ev(`(${app}.grid.scroller.scrollTop = ${app}.grid.rowAxis.offset(66), true)`); await sleep(150);
  const pt = await cellPoint(75, 2);
  await mouse('mouseMoved', pt); await mouse('mousePressed', pt); await mouse('mouseReleased', pt); await sleep(300);
  check('format painter copies the formatting onto the next selection', (await ev(`JSON.stringify(${app}.wb.activeSheet.getCell(75, 2) && ${app}.wb.activeSheet.getCell(75, 2).style.font)`)) === '{"bold":true}');
  check('format painter switches itself off', (await ev(`document.querySelector('[data-action="format-painter"]').getAttribute('aria-pressed')`)) === 'false');

  await ev(`(${app}.wb.setTabColor(0, '#ff8800'), true)`); await sleep(100);
  check('the sheet tab shows its colour', (await ev(`document.querySelector('#tabs .tab').style.borderBottom`)).includes('rgb(255, 136, 0)'));
  const tabFile = await ev(`(async () => { const blob = await ${FM}.writeXlsx(${app}.wb); const info = await ${FM}.inspectFile(new File([blob], 't.xlsx')); const wb2 = (await ${FM}.loadWorkbook(info)).workbook; return JSON.stringify(wb2.sheets[0].extras.tabColor); })()`);
  check('the tab colour is saved in the .xlsx', tabFile === '{"argb":"FFFF8800"}', tabFile);

  await select(80, 0, 80, 0); await ev(`(${app}.grid.focus(), true)`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ';', code: 'Semicolon', windowsVirtualKeyCode: 186, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ';', code: 'Semicolon', windowsVirtualKeyCode: 186, modifiers: 2 }); await sleep(150);
  const today = new Date(); const serialNow = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000 + 25569);
  check('Ctrl+; enters today\'s date as a date', (await ev(`${app}.wb.activeSheet.getCell(80, 0).value`)) === serialNow && (await ev(`${app}.wb.activeSheet.getCell(80, 0).style.numFmt`)) === 'yyyy-mm-dd');

  // ---- conditional formatting through the real menus
  await ev(`(${app}.wb.addSheet(), ${app}.wb.setActive(${app}.wb.sheets.length - 1), true)`); await sleep(200);
  for (let i = 0; i < 6; i++) await set(i, 0, String([5, 15, 25, 15, 3, 40][i]));
  await select(0, 0, 5, 0);
  const menuClick = async (btnAction, label) => {
    await ev(`(document.querySelector('[data-action="${btnAction}"]').click(), true)`); await sleep(150);
    return ev(`(() => { const b = [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
  };
  const dlgSet = (sel, v) => ev(`(() => { const f = document.querySelector('dialog ${sel}'); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check('the Rules menu opens', (await menuClick('cf-menu', 'Highlight cells')) === true); await sleep(250);
  check('the Highlight cells dialog opens', (await ev(`!!document.querySelector('dialog[open]')`)) === true);
  const fields = await ev(`[...document.querySelectorAll('dialog input.input, dialog select')].length`);
  await ev(`(() => { const d = document.querySelector('dialog'); const sels = d.querySelectorAll('select'); sels[0].value = 'greaterThan'; sels[0].dispatchEvent(new Event('change')); const ins = d.querySelectorAll('input.input'); ins[0].value = '10'; return true; })()`);
  await ev(`(document.querySelector('dialog button[type="submit"], dialog .btn-primary').click(), true)`); await sleep(300);
  const bgs = await ev(`JSON.stringify([0,1,2,3,4,5].map((r) => { const f = SheetApp.condfmt.lookup(${app}.wb, ${app}.wb.activeIndex); const s = f && f(r, 0); return s ? s.background : null; }))`);
  check('the rule colours only cells over 10', bgs === JSON.stringify([null, '#FFC7CE', '#FFC7CE', '#FFC7CE', null, '#FFC7CE']), bgs + ' fields=' + fields);
  const painted = await ev(`[...document.querySelectorAll('.cell')].filter((n) => n.style.background && n.textContent === '15').length`);
  check('the grid draws the coloured cells', painted === 2, String(painted));
  const cfFile = await ev(`(async () => { const blob = await ${FM}.writeXlsx(${app}.wb); const info = await ${FM}.inspectFile(new File([blob], 't.xlsx')); const wb2 = (await ${FM}.loadWorkbook(info)).workbook; const s = wb2.sheets[wb2.sheets.length - 1]; return JSON.stringify(SheetApp.condfmt.listRules(wb2, wb2.sheets.length - 1).map((r) => r.text)) + '|' + (SheetApp.condfmt.lookup(wb2, wb2.sheets.length - 1)(1, 0) || {}).background; })()`);
  check('the rule survives saving and reopening the .xlsx', cfFile === '["Cell value is greater than 10"]|#FFC7CE', cfFile);
  await select(0, 0, 5, 0);
  check('Colour scale menu item works', (await menuClick('cf-menu', 'Colour scale: white – blue')) === true); await sleep(200);
  check('a scale adds a second rule', (await ev(`SheetApp.condfmt.listRules(${app}.wb, ${app}.wb.activeIndex).length`)) === 2);
  check('Clear rules from selection removes them', (await menuClick('cf-menu', 'Clear rules from selection')) === true && (await ev(`SheetApp.condfmt.listRules(${app}.wb, ${app}.wb.activeIndex).length`)) === 0);

  // ---- remove duplicates and text to columns through the Data menu
  await ev(`(${app}.wb.addSheet(), ${app}.wb.setActive(${app}.wb.sheets.length - 1), true)`); await sleep(200);
  ['Name', 'a', 'A', 'b'].forEach((t, i) => set(i, 0, t));
  await select(0, 0, 3, 0); await sleep(100);
  check('Remove duplicate rows… opens', (await menuClick('data-menu', 'Remove duplicate rows')) === true); await sleep(250);
  await ev(`(document.querySelector('dialog button[type="submit"], dialog .btn-primary').click(), true)`); await sleep(300);
  check('duplicates are removed (header kept)', [await shown(0, 0), await shown(1, 0), await shown(2, 0), await shown(3, 0)].join(',') === 'Name,a,b,', [await shown(0, 0), await shown(1, 0), await shown(2, 0), await shown(3, 0)].join(','));
  await set(10, 0, 'x;y;z'); await select(10, 0, 10, 0);
  check('Text to columns… opens', (await menuClick('data-menu', 'Text to columns')) === true); await sleep(250);
  await ev(`(() => { const s = document.querySelector('dialog select'); s.value = ';'; s.dispatchEvent(new Event('change')); return true; })()`);
  await ev(`(document.querySelector('dialog button[type="submit"], dialog .btn-primary').click(), true)`); await sleep(300);
  check('text is split across columns', [await shown(10, 0), await shown(10, 1), await shown(10, 2)].join(',') === 'x,y,z');

  const real = errors.filter((e) => !/favicon\.ico/.test(e)); // the standalone page has no favicon
  check('no console errors', real.length === 0, real.join(' | ').slice(0, 300));
} catch (e) { failed++; console.log('FAIL  script error', e.stack || e); }
finally { h.finish(); }
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
