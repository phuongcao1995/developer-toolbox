// End-to-end check of the CV Builder through the real UI, including real PDF output via Chrome's printer.
//   node tests/browser/cv-builder.mjs      (needs a static server, see harness.mjs)
// Set CV_SHOTS=<dir> to also save a PNG preview of every template.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { start } from './harness.mjs';

const h = await start();
const { ev, send, sleep, errors } = h;
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); };
const q = sel => `document.querySelector(${JSON.stringify(sel)})`;
const wait = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(100); } return false; };
const setVal = (sel, v) => ev(`(() => { const e = ${q(sel)}; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

// Counts pages of a PDF buffer (base64) by counting /Type /Page objects.
const pdfPages = b64 => (Buffer.from(b64, 'base64').toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
async function pdfOf(html) {
  await ev(`(() => { document.body.innerHTML = ''; return true; })()`);
  const tree = await send('Page.getFrameTree');
  await send('Page.setDocumentContent', { frameId: tree.result.frameTree.frame.id, html });
  await sleep(300);
  const r = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
  return r.result.data;
}

try {
  await ev(`location.hash = '#/tool/cv-builder'`);
  check('tool opens', await wait(`!!${q('#cvb-paper .cv')}`));
  check('shows example preview when empty', await ev(`!${q('#cvb-example')}.hidden`));
  check('no console errors on load', errors.filter(e => !/favicon/.test(e)).length === 0, errors.join(' | '));

  // typing updates the live preview and autosaves
  await ev(`(${q('details[data-key="personal"]')}).open = true`);
  await setVal('#cvb-p-name', 'Ada <b>Lovelace</b>');
  await setVal('#cvb-p-title', 'Staff Engineer');
  await setVal('#cvb-p-email', 'ada@example.com');
  check('preview updates live and escapes HTML', await wait(`${q('#cvb-paper .cv-name')}.textContent === 'Ada <b>Lovelace</b>' && !${q('#cvb-paper .cv-name b')}`));
  check('example banner hides once content exists', await wait(`${q('#cvb-example')}.hidden === true`));
  await sleep(600);
  check('autosaves to storage', await ev(`!!localStorage.getItem('devtoolbox:tool:cv-builder:index')`));

  // add an experience entry
  await ev(`(${q('details[data-key="experience"]')}).open = true; ${q('details[data-key="experience"] .cvb-list > button')}.click(); true`);
  check('add experience entry', await wait(`!!${q('details[data-key="experience"] .cvb-item input')}`));
  const itemInput = async key => ev(`(() => { const i = [...document.querySelectorAll('details[data-key="experience"] .cvb-item [id$="-${key}"]')][0]; return i ? i.id : null; })()`);
  await setVal('#' + await itemInput('position'), 'Principal Engineer');
  await setVal('#' + await itemInput('company'), 'Analytical Engines Ltd');
  await setVal('#' + await itemInput('achievements'), 'Cut latency 40%\nShipped v2');
  check('experience renders with achievements', await wait(`${q('#cvb-paper [data-section="experience"]')}?.textContent.includes('Analytical Engines') && document.querySelectorAll('#cvb-paper [data-section="experience"] li').length === 2`));

  // reorder: move experience up above skills
  await ev(`(() => { const c = ${q('details[data-key="experience"]')}; c.querySelector('summary .cvb-card-tools button[aria-label^="Move Work Experience up"]').click(); return true; })()`);
  check('reorder changes the preview order', await wait(`(() => { const s = [...document.querySelectorAll('#cvb-paper [data-section]')].map(e => e.dataset.section); return s[0] === 'experience'; })()`), await ev(`[...document.querySelectorAll('#cvb-paper [data-section]')].map(e => e.dataset.section).join()`));

  // template gallery
  await ev(`${q('[data-action="templates"]')}.click(); true`);
  check('gallery lists 14 templates', await wait(`document.querySelectorAll('.cvb-tcard').length === 14`));
  check('gallery thumbnails rendered', await ev(`document.querySelectorAll('.cvb-thumb-in .cv').length === 14`));
  await ev(`[...document.querySelectorAll('.cvb-chiprow')][0].querySelectorAll('button')[4].click(); true`); // Advanced
  check('level filter works', await wait(`document.querySelectorAll('.cvb-tcard').length === 3`));
  await ev(`document.querySelector('.cvb-tcard').click(); true`);
  check('choosing a template switches preview and keeps content', await wait(`!!${q('#cvb-paper .cv-t-executive')} && ${q('#cvb-paper')}.textContent.includes('Principal Engineer')`));

  // customisation
  await ev(`${q('#cvb-style summary')}.click(); true`);
  await setVal('#cvb-color', '#ff0000');
  check('accent colour applies', await wait(`${q('#cvb-paper .cv')}.style.getPropertyValue('--accent') === '#ff0000'`));

  // versions
  await ev(`${q('[data-action="ver-dup"]')}.click(); true`);
  check('duplicate creates a second version', await wait(`document.querySelectorAll('#cvb-version option').length === 2`));
  check('duplicate keeps the content', await ev(`${q('#cvb-paper .cv-name')}.textContent.startsWith('Ada')`));

  // reload persistence
  await sleep(600);
  await ev(`location.reload()`); await sleep(2000);
  await ev(`location.hash = '#/tool/cv-builder'`);
  check('survives reload', await wait(`!!${q('#cvb-paper .cv-name')} && ${q('#cvb-paper .cv-name')}.textContent.startsWith('Ada') && document.querySelectorAll('#cvb-version option').length === 2`));

  // layout checks at phone width
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  check('no horizontal overflow at 375px', await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), await ev(`document.documentElement.scrollWidth`));
  await ev(`${q('[data-action="view-preview"]')}.click(); true`); await sleep(300);
  check('preview fits phone width', await ev(`${q('#cvb-sizer')}.getBoundingClientRect().width <= window.innerWidth`));
  await send('Emulation.clearDeviceMetricsOverride');

  // PDF output for every template: short and long content, via the real renderer
  const mod = `await import('/tools/cv-builder/export.js')`;
  const samples = `await import('/tools/cv-builder/model.js')`;
  const tpls = await ev(`(async () => (await import('/tools/cv-builder/templates.js')).TEMPLATES.map(t => t.id))()`);
  const shots = process.env.CV_SHOTS; if (shots) mkdirSync(shots, { recursive: true });
  const build = (id, scale) => ev(`(async () => { const m = ${samples}; const e = ${mod}; const cv = m.sampleCV(${JSON.stringify(scale)}); cv.settings.template = ${JSON.stringify(id)}; return e.buildDocument(cv); })()`);
  const results = [];
  for (const id of tpls) {
    const short = pdfPages(await pdfOf(await build(id, 'short')));
    const longPdf = await pdfOf(await build(id, 'long'));
    const long = pdfPages(longPdf);
    results.push(`${id}: short=${short} long=${long}`);
    if (shots) {
      writeFileSync(join(shots, `${id}-long.pdf`), Buffer.from(longPdf, 'base64'));
      const shortHtml = await build(id, 'normal'); await pdfOf(shortHtml);
      const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(shots, `${id}.png`), Buffer.from(png.result.data, 'base64'));
    }
    check(`${id}: short CV is 1 page, long CV flows to 2-4 pages`, short === 1 && long >= 2 && long <= 4, `short=${short} long=${long}`);
  }
  console.log(results.join('\n'));
} catch (e) { failed++; console.log('FAIL  exception', e.stack || e); }

const realErrors = errors.filter(e => !/favicon/.test(e));
check('no console errors during the run', realErrors.length === 0, realErrors.join(' | '));
h.finish();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll CV Builder browser checks passed');
process.exit(failed ? 1 : 0);
