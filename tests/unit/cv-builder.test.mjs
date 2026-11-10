// Run: node tests/unit/cv-builder.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { defaultCV, normalize, validate, sampleCV, sectionHasContent, importJSON, exportJSON, fromJsonResume, SECTIONS, DEFAULT_ORDER, blankEntry } from '../../tools/cv-builder/model.js';
import { renderCV, renderText, safeHref, visibleSections } from '../../tools/cv-builder/render.js';
import { TEMPLATES, getTemplate, LEVELS, STYLES, cssFor } from '../../tools/cv-builder/templates.js';
import { createStore } from '../../tools/cv-builder/store.js';
import { buildDocument, fileBase } from '../../tools/cv-builder/export.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const memStorage = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; }, remove: k => m.delete(k) }; };

test('default CV has every developer section and skill group', () => {
  const cv = defaultCV();
  assert.deepEqual(cv.order.map(o => o.id), DEFAULT_ORDER);
  assert.equal(cv.skills.length, 5);
  assert.equal(cv.order.find(o => o.id === 'publications').visible, false);
});

test('normalize repairs garbage and never throws', () => {
  for (const bad of [null, undefined, 5, 'x', [], { personal: 3, experience: 'no', order: 'no', settings: { size: 'big', color: 'red', font: 'comic' } }]) {
    const cv = normalize(bad);
    assert.ok(Array.isArray(cv.experience));
    assert.equal(cv.order.length, DEFAULT_ORDER.length);
    assert.equal(cv.settings.color, '');
    assert.equal(cv.settings.font, '');
    assert.ok(cv.settings.size >= 8.5 && cv.settings.size <= 12);
  }
});

test('normalize coerces entry fields and keeps order', () => {
  const cv = normalize({ order: [{ id: 'projects', visible: true }, 'summary', { id: 'bogus' }, { id: 'projects' }], experience: [{ position: 'Dev', responsibilities: 'a\n\n b ', tech: 'Go, Rust,, ' }] });
  assert.deepEqual(cv.order.slice(0, 2).map(o => o.id), ['projects', 'summary']);
  assert.equal(new Set(cv.order.map(o => o.id)).size, DEFAULT_ORDER.length);
  assert.deepEqual(cv.experience[0].responsibilities, ['a', 'b']);
  assert.deepEqual(cv.experience[0].tech, ['Go', 'Rust']);
});

test('validate flags bad email and urls but not empty optional fields', () => {
  const cv = sampleCV();
  assert.deepEqual(validate(cv), []);
  cv.personal.email = 'nope'; cv.personal.github = 'not a url';
  const paths = validate(cv).map(i => i.path);
  assert.ok(paths.includes('personal.email') && paths.includes('personal.github'));
  assert.ok(validate(defaultCV()).some(i => i.path === 'personal.name'));
});

test('empty sections are omitted from the rendering', () => {
  const cv = defaultCV();
  cv.personal.name = 'Jo';
  assert.deepEqual(visibleSections(cv), []);
  const html = renderCV(cv, 'standard');
  assert.ok(!html.includes('cv-sec'));
  cv.summary = 'Hi';
  assert.deepEqual(visibleSections(cv), ['summary']);
  cv.order.find(o => o.id === 'summary').visible = false;
  assert.deepEqual(visibleSections(cv), []);
});

test('section order drives render order', () => {
  const cv = sampleCV();
  cv.order = [{ id: 'education', visible: true }, ...cv.order.filter(o => o.id !== 'education')];
  const html = renderCV(cv, 'standard');
  assert.ok(html.indexOf('data-section="education"') < html.indexOf('data-section="experience"'));
});

test('user text is escaped everywhere', () => {
  const cv = sampleCV();
  const evil = '<img src=x onerror=alert(1)>';
  cv.personal.name = evil; cv.summary = evil; cv.experience[0].company = evil; cv.experience[0].tech = [evil]; cv.skills[0].items = [evil];
  cv.projects[0].name = evil; cv.education[0].school = evil; cv.certifications[0].name = evil;
  for (const t of TEMPLATES) {
    const html = renderCV(cv, t.id);
    assert.ok(!html.includes('<img'), t.id);
  }
});

test('links only allow http(s) and mailto', () => {
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref('data:text/html,x'), '');
  assert.equal(safeHref('github.com/a'), 'https://github.com/a');
  assert.equal(safeHref('http://x.dev'), 'http://x.dev');
  assert.equal(safeHref('mailto:a@b.co'), 'mailto:a@b.co');
  const cv = sampleCV(); cv.projects[0].github = 'javascript:alert(1)';
  assert.ok(!/href="javascript/i.test(renderCV(cv, 'standard')));
});

test('template catalogue is complete and distinct', () => {
  assert.ok(TEMPLATES.length >= 10 && TEMPLATES.length <= 20);
  assert.equal(new Set(TEMPLATES.map(t => t.id)).size, TEMPLATES.length);
  assert.equal(new Set(TEMPLATES.map(t => t.css)).size, TEMPLATES.length);
  for (const l of LEVELS) assert.ok(TEMPLATES.some(t => t.level === l.id), 'level ' + l.id);
  for (const s of STYLES) assert.ok(TEMPLATES.some(t => t.style === s), 'style ' + s);
  for (const t of TEMPLATES) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.accent), t.id);
    assert.ok(['single', 'side'].includes(t.layout), t.id);
    assert.ok(t.css.includes(`.cv-t-${t.id}`) && !t.css.includes('&'), t.id);
  }
  assert.equal(getTemplate('nope').id, TEMPLATES[0].id);
  for (const s of ['Standard', 'Formal', 'Professional']) assert.ok(TEMPLATES.some(t => t.style === s && t.ats) || s === 'Professional', s);
});

test('every template renders short, normal, long and empty content', () => {
  for (const t of TEMPLATES) {
    for (const data of [sampleCV('short'), sampleCV(), sampleCV('long'), defaultCV()]) {
      const html = renderCV(data, t.id);
      assert.ok(html.startsWith(`<article class="cv cv-t-${t.id}`), t.id);
      assert.ok(html.endsWith('</article>'));
    }
  }
});

test('switching template keeps all content', () => {
  const cv = sampleCV();
  const before = JSON.stringify(cv);
  const texts = TEMPLATES.map(t => renderCV(cv, t.id).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ?[,·—] ?/g, ' ').replace(/\s+/g, ' '));
  assert.equal(JSON.stringify(cv), before);
  for (const x of texts) for (const needle of ['Alex Morgan', 'Northwind Labs', 'Trace Lens', 'Technical University of Munich', 'Engineering Excellence Award', 'Kubernetes']) assert.ok(x.includes(needle), needle);
});

test('accent colour, font and size come from settings', () => {
  const cv = sampleCV(); cv.settings = { ...cv.settings, color: '#ff0000', font: 'mono', size: 11, density: 'compact' };
  const html = renderCV(cv, 'formal');
  assert.ok(html.includes('--accent:#ff0000') && html.includes('--font:ui-monospace') && html.includes('--fs:11pt'));
});

test('plain text export contains the essentials', () => {
  const t = renderText(sampleCV());
  assert.ok(t.startsWith('Alex Morgan'));
  assert.ok(t.includes('WORK EXPERIENCE') && t.includes('TECHNICAL SKILLS') && t.includes('Technologies: Go'));
  assert.ok(!t.includes('PUBLICATIONS'));
});

test('JSON round trip and JSON Resume import', () => {
  const cv = sampleCV();
  assert.deepEqual(importJSON(exportJSON(cv)), normalize(cv));
  const jr = importJSON(JSON.stringify({ basics: { name: 'Sam', label: 'Dev', email: 's@x.io', profiles: [{ network: 'GitHub', url: 'https://github.com/sam' }], location: { city: 'Oslo' } }, work: [{ name: 'Acme', position: 'Eng', startDate: '2020', highlights: ['Shipped'] }], skills: [{ name: 'Languages', keywords: ['Go'] }], publications: [{ name: 'Paper' }] }));
  assert.equal(jr.personal.name, 'Sam'); assert.equal(jr.personal.github, 'https://github.com/sam');
  assert.equal(jr.experience[0].period, '2020 – Present'); assert.deepEqual(jr.experience[0].achievements, ['Shipped']);
  assert.equal(jr.skills[0].items[0], 'Go');
  assert.equal(jr.order.find(o => o.id === 'publications').visible, true);
  assert.throws(() => importJSON('{nope'), /valid JSON/);
  assert.throws(() => importJSON('[]'), /Unrecognised/);
  assert.throws(() => importJSON('{"a":1}'), /Unrecognised/);
});

test('sectionHasContent and blankEntry agree', () => {
  const cv = defaultCV();
  for (const id of Object.keys(SECTIONS)) assert.equal(sectionHasContent(cv, id), false, id);
  const e = blankEntry('experience'); assert.ok(e.id && Array.isArray(e.tech));
  cv.experience.push(e); assert.equal(sectionHasContent(cv, 'experience'), false);
  e.company = 'X'; assert.equal(sectionHasContent(cv, 'experience'), true);
});

test('store keeps multiple versions', () => {
  const st = memStorage();
  const s = createStore(st);
  assert.equal(s.list().length, 1);
  const cv = s.load(); cv.personal.name = 'A'; assert.ok(s.save(cv));
  const dup = s.duplicate();
  assert.equal(s.list().length, 2); assert.equal(s.active, dup);
  assert.equal(s.load().personal.name, 'A');
  s.rename(dup, 'Backend'); assert.equal(s.list().find(v => v.id === dup).name, 'Backend');
  const again = createStore(st);
  assert.equal(again.active, dup); assert.equal(again.list().length, 2);
  assert.ok(s.remove(dup)); assert.equal(s.list().length, 1); assert.equal(s.remove(s.active), false);
});

test('store survives corrupt storage', () => {
  const st = memStorage(); st.set('index', { active: 'zzz', list: [{ id: 'a', name: 'X' }, null] }); st.set('cv:a', 'junk');
  const s = createStore(st);
  assert.equal(s.active, 'a'); assert.ok(Array.isArray(s.load().experience));
});

test('print document is A4 with zero margins and escapes the title', () => {
  const cv = sampleCV(); cv.personal.name = '<b>x</b>';
  const html = buildDocument(cv);
  assert.ok(html.includes('size:A4') && html.includes('margin:0'));
  assert.ok(html.includes('<title>&lt;b&gt;x&lt;/b&gt;'));
  assert.equal(fileBase({ personal: { name: 'Nguyễn Văn A' } }), 'Nguyễn_Văn_A_CV');
  assert.equal(fileBase({ personal: { name: '' } }), 'CV_CV');
});

test('css is scoped to .cv', () => {
  for (const t of TEMPLATES) for (const rule of cssFor(t.id).split('}')) {
    const sel = rule.split('{')[0].trim();
    if (!sel || sel.startsWith('@')) continue;
    for (const part of sel.split(',')) assert.ok(/^\s*(\.cv|html|body)/.test(part), `${t.id}: ${part.trim()}`);
  }
});

console.log(`cv-builder: ${pass} tests passed`);
