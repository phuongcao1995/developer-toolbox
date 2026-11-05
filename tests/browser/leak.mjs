// Memory-leak and duplicate-listener check for tool switching.
// For every tool: visit it, return to the dashboard, force GC, measure DOM nodes / event listeners / documents (visit 1);
// visit twice more and measure again (visit 3). A leak GROWS with every visit; a one-off cache does not.
//   node tests/browser/leak.mjs             (needs a static server, see harness.mjs)
//
// Important: the console is cleared after every visit. Chrome logs the verbose warning
// "[DOM] Password field is not contained in a form" for the password inputs in Saltbox, QR, File Hash and cURL,
// and the console keeps a live reference to each node, which looks like a leak in the DOM counters but is not
// application code (verified with heap snapshots). Clearing the console removes that artefact.
import { start, toolIds } from './harness.mjs';

const ids = toolIds();
const h = await start();
const { ev, sleep, send } = h;
const measure = async () => {
  await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage'); await send('HeapProfiler.collectGarbage');
  const c = (await send('Memory.getDOMCounters')).result, heap = (await send('Runtime.getHeapUsage')).result;
  return { nodes: c.nodes, listeners: c.jsEventListeners, docs: c.documents, heapKB: Math.round(heap.usedSize / 1024) };
};
const visit = async id => {
  await ev(`location.hash = '#/tool/${id}'`); await sleep(1400);
  await ev("location.hash = '#/'"); await sleep(500);
  await send('Runtime.discardConsoleEntries'); await send('Log.clear');
};
await ev("location.hash = '#/'"); await sleep(800);
const base = await measure();
const rows = [];
for (const id of ids) {
  await visit(id); const a = await measure();
  await visit(id); await visit(id); const b = await measure();
  rows.push({ id, nodes: b.nodes - a.nodes, listeners: b.listeners - a.listeners, docs: b.docs - a.docs, heapKB: b.heapKB - a.heapKB });
}
const final = await measure();
console.log('dashboard baseline         :', JSON.stringify(base));
console.log('after every tool 3x        :', JSON.stringify(final));
console.log('\ngrowth between visit 1 and visit 3 of each tool');
console.log('tool'.padEnd(26), 'nodes'.padStart(7), 'listeners'.padStart(10), 'docs'.padStart(6), 'heapKB'.padStart(8));
for (const r of rows) console.log(r.id.padEnd(26), String(r.nodes).padStart(7), String(r.listeners).padStart(10), String(r.docs).padStart(6), String(r.heapKB).padStart(8));
const leaking = rows.filter(r => r.nodes > 50 || r.listeners > 20 || r.docs > 0 || r.heapKB > 1500);
console.log('\nleaking tools:', leaking.length ? leaking.map(r => r.id).join(', ') : 'none');
h.finish();
process.exit(leaking.length ? 1 : 0);
