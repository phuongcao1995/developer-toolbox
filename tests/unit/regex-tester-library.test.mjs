// Run: node tests/unit/regex-tester-library.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/regex-tester/logic.js';
import * as B from '../../tools/regex-tester/library.js';

let pass = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });

test('library has at least 40 well-formed entries with unique ids', () => {
  assert.ok(B.LIBRARY.length >= 40, `only ${B.LIBRARY.length}`);
  const ids = new Set();
  for (const e of B.LIBRARY) {
    for (const k of ['id', 'category', 'name', 'pattern', 'flags', 'description', 'sample', 'limitations']) assert.equal(typeof e[k], 'string', `${e.id}.${k}`);
    assert.ok(e.id && e.name && e.pattern && e.sample && e.limitations, e.id);
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`); ids.add(e.id);
  }
});
test('every entry compiles with its flags and matches its own sample', () => {
  for (const e of B.LIBRARY) {
    const b = L.buildRegex(e.pattern, e.flags);
    assert.ok(b.ok, `${e.id}: ${b.error}`);
    const r = L.findMatches(b.regex, e.sample);
    // a zero-length-only result (e.g. csv final empty match) does not count: need a non-empty match, except for zero-width entries
    assert.ok(r.matches.length >= 1, `${e.id}: no match in sample`);
    if (e.id !== 'camel-boundary') assert.ok(r.matches.some(m => m.text !== ''), `${e.id}: only empty matches`);
  }
});
test('library patterns are not flagged by the ReDoS heuristic', () => {
  for (const e of B.LIBRARY) assert.equal(L.riskWarning(e.pattern, e.flags), null, e.id);
});
test('library patterns run through the job runner and respect the u/v exclusion', () => {
  for (const e of B.LIBRARY) {
    assert.ok(!(e.flags.includes('u') && e.flags.includes('v')), e.id);
    assert.ok(L.runJob({ pattern: e.pattern, flags: e.flags, text: e.sample }).ok, e.id);
  }
});
test('required topics are present and caveats are stated', () => {
  const need = ['email', 'url', 'ipv4', 'ipv6', 'uuid', 'iso-date', 'us-date', 'eu-date', 'time-24h', 'phone-e164', 'phone-us', 'hex-color', 'slug', 'semver', 'domain', 'mac', 'port', 'username', 'password', 'trim', 'html-tag', 'md-link', 'integer', 'decimal', 'currency', 'git-hash', 'jwt', 'file-ext', 'csv-field', 'log-level', 'cc-like'];
  for (const id of need) assert.ok(B.LIBRARY.some(e => e.id === id), id);
  assert.match(B.LIBRARY.find(e => e.id === 'email').limitations, /RFC 5322/);
  assert.match(B.LIBRARY.find(e => e.id === 'cc-like').limitations, /Luhn/);
  assert.match(B.LIBRARY.find(e => e.id === 'ipv6').limitations, /[Bb]est effort/);
});
test('specific entries behave', () => {
  const m = (id, text) => { const e = B.LIBRARY.find(x => x.id === id); return L.findMatches(new RegExp(e.pattern, e.flags.includes('g') ? e.flags : e.flags + 'g'), text).matches.map(x => x.text); };
  assert.deepEqual(m('ipv4', '1.2.3.4 256.1.1.1'), ['1.2.3.4']);
  assert.deepEqual(m('port', '65535 65536'), ['65535']);
  assert.deepEqual(m('hex-color', '#fff #ggg'), ['#fff']);
  assert.deepEqual(m('mac', '00:1A:2B:3C:4D:5E'), ['00:1A:2B:3C:4D:5E']);
  assert.deepEqual(m('slug', 'ok-slug\nBad_Slug'), ['ok-slug']);
  assert.deepEqual(m('phone-e164', '+14155552671'), ['+14155552671']);
});
test('filterLibrary: text, category, combined', () => {
  assert.ok(B.filterLibrary(B.LIBRARY, 'uuid').some(e => e.id === 'uuid'));
  assert.equal(B.filterLibrary(B.LIBRARY, '', 'Network').every(e => e.category === 'Network'), true);
  assert.equal(B.filterLibrary(B.LIBRARY, 'zzzz-nothing').length, 0);
  assert.equal(B.filterLibrary(B.LIBRARY, '', 'All').length, B.LIBRARY.length);
  assert.ok(B.libraryCategories(B.LIBRARY).includes('Validation'));
});
test('cheat sheet covers the required groups and every token is non-empty', () => {
  const titles = B.CHEATSHEET.map(s => s.title.toLowerCase()).join('|');
  for (const w of ['anchors', 'character classes', 'quantifiers', 'groups', 'lookaround', 'flags', 'unicode property', 'replacement']) assert.ok(titles.includes(w), w);
  for (const s of B.CHEATSHEET) for (const i of s.items) assert.ok(i.token && i.desc, s.title);
  assert.ok(B.filterCheatsheet(B.CHEATSHEET, 'lookbehind').length >= 1);
  assert.equal(B.filterCheatsheet(B.CHEATSHEET, 'qqqqzzz').length, 0);
  assert.equal(B.filterCheatsheet(B.CHEATSHEET, '').length, B.CHEATSHEET.length);
});
test('cheat sheet inserts compile when used on their own (tokens that are valid standalone)', () => {
  for (const t of ['\\d', '\\w', '[a-z]', '(?:)', '(?<name>)', '()', '(?=)', '(?!)', '\\p{L}']) assert.ok(L.buildRegex(t, 'u').ok, t);
});

// ---- saved patterns ----
test('makeSaved / sanitizeSaved validate fields', () => {
  const s = B.makeSaved({ name: '  Mine ', pattern: 'a+', flags: 'gg', notes: 'n' });
  assert.equal(s.name, 'Mine'); assert.equal(s.flags, 'g'); assert.ok(s.id);
  assert.equal(B.makeSaved({ name: '', pattern: 'a', flags: '' }), null);
  assert.equal(B.makeSaved({ name: 'x', pattern: 'a', flags: 'gz' }), null);
  assert.equal(B.sanitizeSaved(null), null); assert.equal(B.sanitizeSaved([]), null); assert.equal(B.sanitizeSaved({ name: 'a', pattern: 5, flags: '' }), null);
});
test('validateSavedList drops junk, de-duplicates ids and caps size', () => {
  const { items, dropped } = B.validateSavedList([{ id: 'a', name: 'A', pattern: 'x', flags: '' }, { id: 'a', name: 'B', pattern: 'y', flags: 'i' }, 5, { name: 'bad' }, null]);
  assert.equal(items.length, 2); assert.equal(dropped, 3); assert.notEqual(items[0].id, items[1].id);
  assert.deepEqual(B.validateSavedList('nope'), { items: [], dropped: 0 });
  const many = Array.from({ length: B.SAVED_LIMIT + 5 }, (_, i) => ({ name: 'n' + i, pattern: 'a', flags: '' }));
  assert.equal(B.validateSavedList(many).items.length, B.SAVED_LIMIT);
});
test('export / import round trip and error reporting', () => {
  const a = B.makeSaved({ name: 'A', pattern: '\\d+', flags: 'g', notes: 'note', sample: 'a1' });
  const json = B.serializeSaved([a]);
  assert.equal(JSON.parse(json).format, 'developer-toolbox-regex-patterns');
  const back = B.parseSavedExport(json);
  assert.ok(back.ok); assert.equal(back.items[0].pattern, '\\d+'); assert.equal(back.items[0].notes, 'note');
  assert.equal(B.parseSavedExport('{').ok, false);
  assert.equal(B.parseSavedExport('{"x":1}').ok, false);
  assert.equal(B.parseSavedExport('[{"name":"x"}]').ok, false);
  assert.ok(B.parseSavedExport('[{"name":"x","pattern":"a","flags":""}]').ok);
});
test('mergeSaved renames clashing names', () => {
  const a = B.makeSaved({ name: 'A', pattern: 'a', flags: '' });
  const merged = B.mergeSaved([a], [B.makeSaved({ name: 'a', pattern: 'b', flags: '' })]);
  assert.equal(merged.length, 2); assert.equal(merged[1].name, 'a (2)'); assert.notEqual(merged[0].id, merged[1].id);
});

for (const { name, fn } of queue) {
  try { await fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}
console.log(`regex-tester-library: ${pass}/${queue.length} passed`);
