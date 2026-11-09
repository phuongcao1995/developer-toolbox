// End-to-end check of the Test Case Manager through the real UI: CRUD, filtering, import (CSV with errors and duplicates, JSON, XLSX), export.
//   node tests/browser/test-case-manager.mjs      (needs a static server, see harness.mjs)
import { createRequire } from 'node:module';
import { start } from './harness.mjs';
import { ROOT } from './harness.mjs';

const XLSX = createRequire(import.meta.url)('../../assets/js/vendor/xlsx.full.min.js');
const h = await start();
const { ev, sleep, errors } = h;
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };
const q = sel => `document.querySelector(${JSON.stringify(sel)})`;
const click = sel => ev(`(${q(sel)}).click(), true`);
const wait = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(100); } return false; };
const rows = () => ev(`document.querySelectorAll('.tcm-table tbody tr').length`);
const ids = () => ev(`[...document.querySelectorAll('.tcm-table tbody tr')].map(r => r.dataset.id).join(',')`);
const setVal = (sel, v) => ev(`(() => { const e = ${q(sel)}; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

// capture downloads instead of saving them
const installCapture = () => ev(`(() => { window.__dl = []; const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) { const n = this.download; fetch(this.href).then(r => r.arrayBuffer()).then(b => window.__dl.push({ name: n, bytes: [...new Uint8Array(b)] })); } else orig.call(this); }; return true; })()`);
const lastDownload = async () => { await sleep(300); return ev(`(() => { const d = window.__dl.at(-1); return d ? JSON.stringify({ name: d.name, head: d.bytes.slice(0, 4), text: d.bytes.length < 400000 ? new TextDecoder().decode(new Uint8Array(d.bytes)) : '' , size: d.bytes.length }) : null; })()`).then(s => (s ? JSON.parse(s) : null)); };

const dropFile = (name, mime, content) => ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${content.base64 ? `Uint8Array.from(atob(${JSON.stringify(content.base64)}), c => c.charCodeAt(0))` : JSON.stringify(content)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
  document.querySelector('.tcm-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);

try {
  await ev(`new Promise(r => { const q = indexedDB.deleteDatabase('devtoolbox-test-cases'); q.onsuccess = q.onerror = q.onblocked = () => r(true); })`);
  await ev(`location.hash = '#/tool/test-case-manager'`);
  check('tool opens with an empty state', await wait(`!!${q('.tcm-empty')}`));
  await installCapture();

  // ---- add
  await click('[data-action="add"]');
  check('add dialog opens', await wait(`!!${q('.tcm-modal #tcm-f-title')}`));
  await click('.tcm-modal button.btn-primary');
  check('empty title is rejected inline', (await ev(q('#tcm-e-title') + '.textContent')) === 'Title is required.' && await ev(`!!${q('.tcm-modal')}`));
  await setVal('#tcm-f-title', 'Login works');
  await click('.tcm-add-step'); await click('.tcm-add-step');
  await ev(`(() => { const t = document.querySelectorAll('.tcm-step textarea'); t[0].value = 'Open page'; t[0].dispatchEvent(new Event('input')); t[1].value = 'Sign in'; t[1].dispatchEvent(new Event('input')); return true; })()`);
  await setVal('#tcm-f-priority', 'High'); await setVal('#tcm-f-expected', 'Dashboard shows');
  await click('.tcm-modal button.btn-primary');
  check('test case added with generated ID', await wait(`document.querySelectorAll('.tcm-table tbody tr').length === 1`) && (await ids()) === 'TC-001');

  // ---- duplicate, edit, status, delete
  await click('tr[data-id="TC-001"] [data-action="duplicate"]');
  check('duplicate creates TC-002', await wait(`document.querySelectorAll('.tcm-table tbody tr').length === 2`) && (await ids()) === 'TC-001,TC-002');
  await click('tr[data-id="TC-002"] [data-action="edit"]');
  await wait(`!!${q('.tcm-modal #tcm-f-id')}`);
  await setVal('#tcm-f-id', 'tc-001');
  await click('.tcm-modal button.btn-primary');
  check('duplicate ID is rejected case-insensitively', /already used/.test(await ev(q('#tcm-e-id') + '.textContent')));
  await setVal('#tcm-f-id', 'LOGIN-9'); await setVal('#tcm-f-title', 'Logout works');
  await click('.tcm-modal button.btn-primary');
  check('ID and title can be edited', await wait(`!!${q('tr[data-id="LOGIN-9"]')}`) && (await ev(`document.querySelectorAll('.tcm-table tbody tr').length`)) === 2);
  await setVal('tr[data-id="LOGIN-9"] [data-status]', 'Fail');
  check('inline status change', await wait(`${q('tr[data-id="LOGIN-9"] [data-status]')}.value === 'Fail'`));
  await setVal('#tcm-status', 'Fail');
  check('status filter', await wait(`document.querySelectorAll('.tcm-table tbody tr').length === 1`));
  await click('[data-action="export"]');
  check('export defaults to the filtered scope', await wait(`!!${q('input[name="tcm-scope"][value="filtered"]:checked')}`));
  await click('.tcm-modal .tcm-foot .btn:not(.btn-primary)');
  await setVal('#tcm-status', '');
  await setVal('#tcm-q', 'login works');
  check('search matches title', await wait(`document.querySelectorAll('.tcm-table tbody tr').length === 1`) && (await ids()) === 'TC-001');
  await setVal('#tcm-q', '');
  await click('[data-action="sort"][data-key="title"]');
  check('sort by title', await wait(`document.querySelector('.tcm-table tbody tr').dataset.id === 'TC-001'`));
  await click('[data-action="sort"][data-key="title"]');
  check('sort descending', await wait(`document.querySelector('.tcm-table tbody tr').dataset.id === 'LOGIN-9'`));

  // ---- import CSV with errors and duplicates
  await click('[data-action="import"]');
  await wait(`!!${q('.tcm-drop')}`);
  const csv = 'Test Case ID,Summary,Steps,Status,Priority\nTC-001,Dup of existing,"1. a\n2. b",pass,high\nTC-100,Good one,"1. x",Not Run,Low\n,No id,,blocked,critical\nTC-101,,,,\nTC-102,Bad priority,,Pass,Urgent\nTC-100,Repeated in file,,,\n';
  await dropFile('import.csv', 'text/csv', csv);
  check('preview shows after dropping a CSV', await wait(`!!${q('.tcm-preview table')}`));
  const prev = await ev(`document.querySelector('.tcm-modal').innerText`);
  check('preview reports rows, errors and duplicates', /6\s*rows/i.test(prev) && /2\s*with errors/i.test(prev) && /2\s*duplicate IDs/i.test(prev), prev.slice(0, 300));
  check('errors name the row and column', /Title[\s\S]*Title is required/.test(prev) && /Priority[\s\S]*Urgent/.test(prev) && /\n6\s/.test(prev) && /\n7\s/.test(prev)); // TC-101 and TC-102 sit on lines 6 and 7 (the quoted multi-line cell on line 2 spans two lines)
  check('columns auto-mapped (Summary -> Title)', await ev(`${q('#tcm-m-title')}.selectedOptions[0].textContent`) === 'Summary');
  await setVal('#tcm-dup', 'new');
  await click('.tcm-modal .tcm-foot .btn-primary');
  check('import summary appears', await wait(`!!${q('.tcm-modal .tcm-stats')} && /Imported/.test(document.querySelector('.tcm-modal').innerText)`));
  const sum = await ev(`document.querySelector('.tcm-modal .tcm-stats').innerText.replace(/\\s+/g, ' ')`);
  // valid rows: TC-001 dup(existing) -> new ID, TC-100, no-id, TC-100 repeat -> new ID = 4 added; 2 failed
  check('summary: 4 added, 2 failed', /6\s*total/.test(sum) && /4\s*added/.test(sum) && /2\s*failed/.test(sum), sum);
  await click('.tcm-modal .tcm-foot .btn-primary');
  check('list updated after import', await wait(`document.querySelectorAll('.tcm-table tbody tr').length === 6`), await ids());
  const all = await ids();
  check('overwrite/skip untouched; IDs unique', new Set(all.split(',').map(s => s.toLowerCase())).size === 6, all);

  // ---- overwrite mode via JSON
  await click('[data-action="import"]'); await wait(`!!${q('.tcm-drop')}`);
  await dropFile('cases.json', 'application/json', JSON.stringify({ testCases: [{ id: 'tc-100', title: 'Overwritten title', steps: ['s1', 's2'], status: 'Pass', priority: 'Critical' }] }));
  await wait(`!!${q('.tcm-preview, .tcm-more')}`);
  await setVal('#tcm-dup', 'overwrite');
  await click('.tcm-modal .tcm-foot .btn-primary');
  await wait(`!!${q('.tcm-modal .tcm-stats')}`);
  const sum2 = await ev(`document.querySelector('.tcm-modal .tcm-stats').innerText.replace(/\\s+/g, ' ')`);
  check('JSON overwrite: 1 overwritten', /1\s*overwritten/.test(sum2), sum2);
  await click('.tcm-modal .tcm-foot .btn-primary');
  check('overwritten case keeps its ID and gets new data', await wait(`${q('tr[data-id="TC-100"] .tcm-link')}?.textContent === 'Overwritten title'`) && (await rows()) === 6);

  // ---- XLSX import
  const ws = XLSX.utils.aoa_to_sheet([['ID', 'Title', 'Priority', 'Status', 'Test Steps'], ['X-1', 'From Excel', 'Low', 'Pass', '1. one\n2. two'], ['X-2', 'Second', 'medium', 'Blocked', '']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cases');
  await click('[data-action="import"]'); await wait(`!!${q('.tcm-drop')}`);
  await dropFile('book.xlsx', 'application/octet-stream', { base64: Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })).toString('base64') });
  check('xlsx preview (library loads on demand)', await wait(`!!${q('.tcm-preview')} && /Sheet “Cases”/.test(document.querySelector('.tcm-modal').innerText)`, 15000));
  await click('.tcm-modal .tcm-foot .btn-primary');
  await wait(`!!${q('.tcm-modal .tcm-stats')}`); await click('.tcm-modal .tcm-foot .btn-primary');
  check('xlsx rows imported', await wait(`!!${q('tr[data-id="X-1"]')} && !!${q('tr[data-id="X-2"]')}`));

  // ---- bad files
  await click('[data-action="import"]'); await wait(`!!${q('.tcm-drop')}`);
  await dropFile('broken.json', 'application/json', '{oops');
  check('invalid JSON shows an error and stays on step 1', await wait(`/Invalid JSON/.test(document.querySelector('.tcm-modal .alert-error')?.textContent || '') && !!${q('.tcm-drop')}`));
  await dropFile('notes.pdf', 'application/pdf', 'x');
  check('unsupported type is rejected', await wait(`/Unsupported file type/.test(document.querySelector('.tcm-modal .alert-error')?.textContent || '')`));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(`!${q('.tcm-modal')}`);

  // ---- bulk and export
  await ev(`(() => { const a = document.querySelector('#tcm-all'); a.click(); return true; })()`);
  check('select all matching', await wait(`!${q('#tcm-bulk')}.hidden && /8 selected/.test(document.querySelector('#tcm-selected').textContent)`));
  await setVal('#tcm-bulk-status', 'Blocked');
  check('bulk status', await wait(`[...document.querySelectorAll('[data-status]')].every(s => s.value === 'Blocked')`));
  await ev(`document.querySelector('tr[data-id="X-1"] [data-select]').click(), true`);
  await click('[data-action="export-selected"]');
  await wait(`!!${q('.tcm-modal #tcm-x-format')}`);
  check('export selected defaults to Selected (7)', await ev(`/Selected \\(7\\)/.test(document.querySelector('.tcm-scope').innerText)`));
  await setVal('#tcm-x-format', 'csv'); await click('.tcm-modal .tcm-foot .btn-primary');
  await wait(`!${q('.tcm-modal')}`);
  const csvOut = await lastDownload();
  check('CSV export: timestamped name, BOM, header, 7 rows', /^test-cases_\d{8}-\d{6}\.csv$/.test(csvOut?.name) && csvOut.head[0] === 0xEF && /^\uFEFF?Test Case ID,Title,/.test(csvOut.text) && csvOut.text.trim().split(/\r\n/).length >= 8, JSON.stringify(csvOut).slice(0, 200));
  await click('[data-action="export"]'); await wait(`!!${q('.tcm-modal #tcm-x-format')}`);
  await ev(`document.querySelector('input[name="tcm-scope"][value="all"]').click(), true`);
  await setVal('#tcm-x-format', 'json'); await click('.tcm-modal .tcm-foot .btn-primary'); await wait(`!${q('.tcm-modal')}`);
  const jsonOut = await lastDownload();
  const parsed = jsonOut ? JSON.parse(jsonOut.text) : null;
  check('JSON export: all 8 with step arrays', parsed?.count === 8 && Array.isArray(parsed.testCases.find(c => c.id === 'TC-100')?.steps) && parsed.testCases.find(c => c.id === 'TC-100').steps.length === 2, jsonOut?.text?.slice(0, 200));
  await click('[data-action="export"]'); await wait(`!!${q('.tcm-modal #tcm-x-format')}`);
  await ev(`document.querySelector('input[name="tcm-scope"][value="all"]').click(), true`);
  await setVal('#tcm-x-format', 'xlsx'); await click('.tcm-modal .tcm-foot .btn-primary'); await wait(`!${q('.tcm-modal')}`, 15000);
  const xOut = await lastDownload();
  check('XLSX export is a real workbook', /\.xlsx$/.test(xOut?.name) && xOut.head[0] === 0x50 && xOut.head[1] === 0x4b && xOut.size > 3000, JSON.stringify(xOut)?.slice(0, 150));

  // ---- delete
  await ev(`document.querySelector('[data-action="clear-selection"]').click(), true`);
  await click('tr[data-id="X-2"] [data-action="delete"]');
  await wait(`!!${q('.modal-foot .btn-danger')}`); await click('.modal-foot .btn-danger');
  check('delete with confirmation', await wait(`!${q('tr[data-id="X-2"]')}`) && (await rows()) === 7);

  // ---- persistence across reload
  await ev(`location.reload()`); await sleep(1500);
  check('data persists after reload (IndexedDB)', await wait(`document.querySelectorAll('.tcm-table tbody tr').length === 7`));
  check('no console errors or exceptions', errors.length === 0, errors.join(' | ').slice(0, 400));
} catch (e) { failed++; console.log('FAIL  script error', e.stack || e); }
finally { h.finish(); }
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
