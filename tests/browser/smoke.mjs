// Mounts every registered tool in real Chrome, in two configurations (desktop/light and 375 px mobile/dark), and checks:
//   - no console errors or uncaught exceptions, no failed resource loads
//   - no visible error panel, tool icon rendered, non-trivial content
//   - no horizontal page overflow (mobile) and no unlabelled form controls
// then switches rapidly between tools to look for race conditions.
//   node tests/browser/smoke.mjs            (needs a static server, see harness.mjs)
// Exit code is non-zero when anything is found.
import { start, toolIds } from './harness.mjs';

const ids = toolIds();
const h = await start();
const { ev, sleep, send } = h;
const modes = [
  { name: 'desktop-light', width: 1280, height: 800, dark: false, mobile: false },
  { name: 'mobile-dark', width: 375, height: 800, dark: true, mobile: true },
];
const probe = `(() => {
  const root = document.querySelector('.tool-root'), de = document.documentElement;
  const unlabeled = [...root.querySelectorAll('input:not([type=hidden]):not([type=file]),select,textarea')].filter(e => {
    if (e.closest('[hidden]') || (e.offsetParent === null && getComputedStyle(e).position !== 'fixed')) return false;
    if (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title) return false;
    if (e.id && document.querySelector('label[for="' + e.id + '"]')) return false;
    if (e.closest('label')) return false;
    if (e.disabled && e.closest('.md-preview,#me-preview,#mv-article')) return false; // task-list checkboxes in rendered Markdown
    return true;
  }).length;
  return { visibleError: [...root.querySelectorAll('.alert-error')].some(e => e.offsetParent !== null),
           hOverflow: de.scrollWidth > innerWidth + 1, icon: !!document.querySelector('.tool-head-icon svg'), len: root.innerHTML.length, unlabeled };
})()`;

const findings = [];
for (const m of modes) {
  await send('Emulation.setDeviceMetricsOverride', { width: m.width, height: m.height, deviceScaleFactor: 1, mobile: m.mobile });
  await ev(`localStorage.setItem('devtoolbox:settings', JSON.stringify({ theme: ${JSON.stringify(m.dark ? 'dark' : 'light')} })); document.documentElement.dataset.theme = ${JSON.stringify(m.dark ? 'dark' : 'light')}`);
  for (const id of ids) {
    const before = h.errors.length;
    await ev(`location.hash = '#/tool/${id}'`); await sleep(1500);
    const r = await ev(probe);
    const problems = [];
    if (r.visibleError) problems.push('visible error panel');
    if (r.hOverflow) problems.push('horizontal overflow');
    if (!r.icon) problems.push('tool icon missing');
    if (r.len < 200) problems.push('tool content missing');
    if (r.unlabeled) problems.push(`${r.unlabeled} unlabelled control(s)`);
    for (const e of h.errors.slice(before)) problems.push(e.slice(0, 160));
    if (problems.length) findings.push(`${m.name} ${id}: ${problems.join('; ')}`);
  }
}

// Rapid tool switching: exercises mount tokens, cleanups and cancelled loads.
const stressBefore = h.errors.length;
for (let i = 0; i < 3; i++) for (const id of ids.slice(0, 12)) { await ev(`location.hash = '#/tool/${id}'`); await sleep(50); }
await sleep(1500);
for (const e of h.errors.slice(stressBefore)) findings.push('stress: ' + e.slice(0, 160));

console.log(`${ids.length} tools x ${modes.length} configurations + rapid-switch stress`);
if (findings.length) { console.log('FINDINGS:'); findings.forEach(f => console.log('  - ' + f)); } else console.log('No findings.');
h.finish();
process.exit(findings.length ? 1 : 0);
