// CV data model: pure functions, no DOM. Template definitions live in templates.js.

let idCounter = 0;
export const newId = () => 'i' + Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 5);

export const SKILL_GROUPS = ['Programming Languages', 'Frameworks & Libraries', 'Databases', 'Cloud & DevOps', 'Tools & Technologies'];

// Section registry. `list` sections hold arrays of entries; `fields` describe the form for one entry.
export const SECTIONS = {
  summary: { label: 'Professional Summary', kind: 'text' },
  skills: { label: 'Technical Skills', kind: 'skills' },
  experience: {
    label: 'Work Experience', kind: 'list', item: 'Position', titleKey: 'position',
    fields: [
      { key: 'position', label: 'Position', type: 'text' },
      { key: 'company', label: 'Company', type: 'text' },
      { key: 'period', label: 'Employment period', type: 'text', placeholder: 'Jan 2021 – Present' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'responsibilities', label: 'Responsibilities', type: 'lines', placeholder: 'One per line' },
      { key: 'achievements', label: 'Key achievements', type: 'lines', placeholder: 'One per line, add metrics' },
      { key: 'tech', label: 'Technologies used', type: 'tags', placeholder: 'Comma separated' },
    ],
  },
  projects: {
    label: 'Projects', kind: 'list', item: 'Project', titleKey: 'name',
    fields: [
      { key: 'name', label: 'Project name', type: 'text' },
      { key: 'description', label: 'Description', type: 'area' },
      { key: 'stack', label: 'Tech stack', type: 'tags', placeholder: 'Comma separated' },
      { key: 'contributions', label: 'Key contributions', type: 'lines', placeholder: 'One per line' },
      { key: 'github', label: 'GitHub URL', type: 'url' },
      { key: 'demo', label: 'Live demo URL', type: 'url' },
    ],
  },
  education: {
    label: 'Education', kind: 'list', item: 'Education', titleKey: 'school',
    fields: [
      { key: 'school', label: 'School', type: 'text' },
      { key: 'degree', label: 'Degree / field', type: 'text' },
      { key: 'period', label: 'Period', type: 'text' },
      { key: 'details', label: 'Details', type: 'area' },
    ],
  },
  certifications: {
    label: 'Certifications', kind: 'list', item: 'Certification', titleKey: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'issuer', label: 'Issuer', type: 'text' },
      { key: 'date', label: 'Date', type: 'text' },
    ],
  },
  languages: {
    label: 'Languages', kind: 'list', item: 'Language', titleKey: 'name',
    fields: [
      { key: 'name', label: 'Language', type: 'text' },
      { key: 'level', label: 'Level', type: 'text', placeholder: 'Native, C1, Fluent…' },
    ],
  },
  awards: {
    label: 'Awards & Achievements', kind: 'list', item: 'Award', titleKey: 'title',
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'issuer', label: 'Issuer', type: 'text' },
      { key: 'date', label: 'Date', type: 'text' },
      { key: 'description', label: 'Description', type: 'area' },
    ],
  },
  publications: {
    label: 'Publications', kind: 'list', item: 'Publication', titleKey: 'title', optional: true,
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'venue', label: 'Venue / publisher', type: 'text' },
      { key: 'date', label: 'Date', type: 'text' },
      { key: 'url', label: 'URL', type: 'url' },
    ],
  },
};
export const SECTION_IDS = Object.keys(SECTIONS);
export const DEFAULT_ORDER = ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages', 'awards', 'publications'];

export const PERSONAL_FIELDS = [
  { key: 'name', label: 'Full name', type: 'text', autocomplete: 'name' },
  { key: 'title', label: 'Headline', type: 'text', placeholder: 'Senior Software Engineer' },
  { key: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'text', autocomplete: 'tel' },
  { key: 'location', label: 'Location', type: 'text' },
  { key: 'github', label: 'GitHub', type: 'url', placeholder: 'github.com/you' },
  { key: 'linkedin', label: 'LinkedIn', type: 'url', placeholder: 'linkedin.com/in/you' },
  { key: 'website', label: 'Website', type: 'url' },
];

export const DEFAULT_SETTINGS = { template: 'standard', color: '', font: '', size: 10, density: 'normal' };
export const FONTS = { '': 'Template default', sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' };
export const FONT_STACKS = {
  sans: '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", "Iowan Old Style", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
};

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : []).map(s => str(s).trim()).filter(Boolean);
const tagList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map(s => str(s).trim()).filter(Boolean);
export { strList, tagList };

export function blankEntry(section) {
  const def = SECTIONS[section];
  const e = { id: newId() };
  for (const f of def.fields) e[f.key] = f.type === 'lines' || f.type === 'tags' ? [] : '';
  return e;
}

export function defaultCV() {
  return {
    v: 1,
    personal: Object.fromEntries(PERSONAL_FIELDS.map(f => [f.key, ''])),
    order: DEFAULT_ORDER.map(id => ({ id, visible: id !== 'publications' })),
    summary: '',
    skills: SKILL_GROUPS.map(label => ({ id: newId(), label, items: [] })),
    experience: [], projects: [], education: [], certifications: [], languages: [], awards: [], publications: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

// Coerce anything (stored data, imported JSON) into a well-formed CV. Never throws.
export function normalize(raw) {
  const cv = defaultCV();
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.personal && typeof r.personal === 'object' ? r.personal : {};
  for (const f of PERSONAL_FIELDS) cv.personal[f.key] = str(p[f.key]).trim();
  cv.summary = str(r.summary);
  if (Array.isArray(r.skills)) {
    cv.skills = r.skills.filter(g => g && typeof g === 'object').map(g => ({ id: str(g.id) || newId(), label: str(g.label), items: tagList(g.items) }));
  }
  for (const id of SECTION_IDS) {
    const def = SECTIONS[id];
    if (def.kind !== 'list') continue;
    cv[id] = (Array.isArray(r[id]) ? r[id] : []).filter(e => e && typeof e === 'object').map(e => {
      const out = { id: str(e.id) || newId() };
      for (const f of def.fields) out[f.key] = f.type === 'lines' ? strList(e[f.key]) : f.type === 'tags' ? tagList(e[f.key]) : str(e[f.key]);
      return out;
    });
  }
  if (Array.isArray(r.order)) {
    const seen = new Set(), order = [];
    for (const o of r.order) {
      const id = typeof o === 'string' ? o : o?.id;
      if (!SECTIONS[id] || seen.has(id)) continue;
      seen.add(id); order.push({ id, visible: typeof o === 'object' ? o.visible !== false : true });
    }
    for (const id of DEFAULT_ORDER) if (!seen.has(id)) order.push({ id, visible: id !== 'publications' });
    cv.order = order;
  }
  const s = r.settings && typeof r.settings === 'object' ? r.settings : {};
  cv.settings = {
    template: str(s.template) || DEFAULT_SETTINGS.template,
    color: /^#[0-9a-f]{6}$/i.test(str(s.color)) ? str(s.color) : '',
    font: str(s.font) in FONT_STACKS ? s.font : '',
    size: Math.min(12, Math.max(8.5, Number(s.size) || DEFAULT_SETTINGS.size)),
    density: ['compact', 'normal', 'relaxed'].includes(s.density) ? s.density : 'normal',
  };
  return cv;
}

export const isUrl = s => /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s.trim());
export const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// Returns [{path, message}] — informational; nothing blocks export.
export function validate(cv) {
  const out = [];
  const p = cv.personal;
  if (!p.name) out.push({ path: 'personal.name', message: 'Add your name' });
  if (p.email && !isEmail(p.email)) out.push({ path: 'personal.email', message: 'Email looks invalid' });
  for (const k of ['github', 'linkedin', 'website']) if (p[k] && !isUrl(p[k])) out.push({ path: 'personal.' + k, message: `${k} URL looks invalid` });
  for (const pr of cv.projects) for (const k of ['github', 'demo']) if (pr[k] && !isUrl(pr[k])) out.push({ path: `projects.${pr.id}.${k}`, message: `"${pr.name || 'Project'}": ${k} URL looks invalid` });
  for (const pb of cv.publications) if (pb.url && !isUrl(pb.url)) out.push({ path: `publications.${pb.id}.url`, message: `"${pb.title || 'Publication'}": URL looks invalid` });
  return out;
}

// Does a section have anything worth printing?
export function sectionHasContent(cv, id) {
  const def = SECTIONS[id];
  if (!def) return false;
  if (def.kind === 'text') return cv[id].trim() !== '';
  if (def.kind === 'skills') return cv.skills.some(g => g.items.length);
  return cv[id].some(e => def.fields.some(f => (Array.isArray(e[f.key]) ? e[f.key].length : str(e[f.key]).trim())));
}

export function exportJSON(cv) {
  return JSON.stringify({ app: 'developer-toolbox/cv-builder', ...cv }, null, 2);
}

// Parse our own JSON or a JSON Resume document. Throws Error with a readable message.
export function importJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('File is not valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unrecognised CV file');
  if (data.basics || data.work) return fromJsonResume(data);
  if (data.personal || data.order || data.experience) return normalize(data);
  throw new Error('Unrecognised CV file');
}

export function fromJsonResume(j) {
  const b = j.basics || {};
  const cv = defaultCV();
  const profile = n => (b.profiles || []).find(p => str(p.network).toLowerCase() === n)?.url || '';
  const loc = b.location ? [b.location.city, b.location.region, b.location.countryCode].filter(Boolean).join(', ') : '';
  Object.assign(cv.personal, { name: str(b.name), title: str(b.label), email: str(b.email), phone: str(b.phone), location: loc, github: str(profile('github')), linkedin: str(profile('linkedin')), website: str(b.url) });
  cv.summary = str(b.summary);
  const range = (a, z) => [str(a), str(z) || (a ? 'Present' : '')].filter(Boolean).join(' – ');
  const skills = (j.skills || []).map(s => ({ id: newId(), label: str(s.name), items: tagList(s.keywords) })).filter(g => g.label || g.items.length);
  if (skills.length) cv.skills = skills;
  cv.experience = (j.work || []).map(w => ({ id: newId(), position: str(w.position), company: str(w.name || w.company), period: range(w.startDate, w.endDate), location: str(w.location), responsibilities: strList(w.summary), achievements: strList(w.highlights), tech: [] }));
  cv.projects = (j.projects || []).map(p => ({ id: newId(), name: str(p.name), description: str(p.description), stack: tagList(p.keywords), contributions: strList(p.highlights), github: '', demo: str(p.url) }));
  cv.education = (j.education || []).map(e => ({ id: newId(), school: str(e.institution), degree: [e.studyType, e.area].filter(Boolean).join(', '), period: range(e.startDate, e.endDate), details: '' }));
  cv.certifications = (j.certificates || []).map(c => ({ id: newId(), name: str(c.name), issuer: str(c.issuer), date: str(c.date) }));
  cv.languages = (j.languages || []).map(l => ({ id: newId(), name: str(l.language), level: str(l.fluency) }));
  cv.awards = (j.awards || []).map(a => ({ id: newId(), title: str(a.title), issuer: str(a.awarder), date: str(a.date), description: str(a.summary) }));
  cv.publications = (j.publications || []).map(p => ({ id: newId(), title: str(p.name), venue: str(p.publisher), date: str(p.releaseDate), url: str(p.url) }));
  if (cv.publications.length) cv.order.find(o => o.id === 'publications').visible = true;
  return normalize(cv);
}

// Sample content used for template thumbnails and "load example". scale: 'short' | 'normal' | 'long'
export function sampleCV(scale = 'normal') {
  const cv = defaultCV();
  Object.assign(cv.personal, { name: 'Alex Morgan', title: 'Senior Software Engineer', email: 'alex.morgan@example.com', phone: '+1 555 010 2030', location: 'Berlin, Germany', github: 'github.com/alexmorgan', linkedin: 'linkedin.com/in/alexmorgan', website: 'alexmorgan.dev' });
  cv.summary = 'Backend-leaning full-stack engineer with 9 years of experience building high-traffic platforms. Led migrations to event-driven architectures, cut cloud spend by 32% and mentored 12 engineers.';
  const sk = ['TypeScript, Go, Python, SQL', 'React, Node.js, Spring Boot, gRPC', 'PostgreSQL, Redis, Kafka, ClickHouse', 'AWS, Kubernetes, Terraform, GitHub Actions', 'Git, Docker, Datadog, Figma'];
  cv.skills.forEach((g, i) => { g.items = tagList(sk[i]); });
  const jobs = [
    ['Staff Engineer', 'Northwind Labs', '2021 – Present', 'Berlin'],
    ['Senior Engineer', 'Pixelforge', '2018 – 2021', 'Remote'],
    ['Software Engineer', 'Initech', '2015 – 2018', 'London'],
  ];
  cv.experience = jobs.slice(0, scale === 'short' ? 1 : 3).map(([position, company, period, location]) => ({
    id: newId(), position, company, period, location,
    responsibilities: ['Designed and owned the payments platform serving 4M monthly users', 'Led a team of 6 engineers across two time zones', 'Introduced contract testing and trunk-based delivery'],
    achievements: ['Reduced p95 latency from 800 ms to 120 ms', 'Cut infrastructure cost by 32% through right-sizing and autoscaling'],
    tech: ['Go', 'PostgreSQL', 'Kafka', 'Kubernetes'],
  }));
  cv.projects = [
    { id: newId(), name: 'Trace Lens', description: 'Open-source distributed tracing explorer with 2.1k GitHub stars.', stack: ['Rust', 'React', 'OpenTelemetry'], contributions: ['Built the query engine and flame-graph UI'], github: 'github.com/alexmorgan/trace-lens', demo: '' },
    { id: newId(), name: 'Ship It CLI', description: 'Zero-config deploy tool used by 300 teams.', stack: ['Go', 'Terraform'], contributions: [], github: '', demo: 'shipit.dev' },
  ];
  cv.education = [{ id: newId(), school: 'Technical University of Munich', degree: 'M.Sc. Computer Science', period: '2013 – 2015', details: 'Thesis on consensus protocols.' }];
  cv.certifications = [{ id: newId(), name: 'AWS Solutions Architect – Professional', issuer: 'Amazon', date: '2022' }, { id: newId(), name: 'CKA', issuer: 'CNCF', date: '2021' }];
  cv.languages = [{ id: newId(), name: 'English', level: 'Native' }, { id: newId(), name: 'German', level: 'C1' }];
  cv.awards = [{ id: newId(), title: 'Engineering Excellence Award', issuer: 'Northwind Labs', date: '2023', description: 'For the platform reliability programme.' }];
  if (scale === 'short') { cv.projects = cv.projects.slice(0, 1); cv.certifications = []; cv.awards = []; cv.experience[0].achievements = cv.experience[0].achievements.slice(0, 1); }
  if (scale === 'long') {
    const base = cv.experience.slice();
    for (let i = 0; i < 4; i++) cv.experience.push({ ...base[i % 3], id: newId(), company: base[i % 3].company + ' ' + (i + 2) });
    const pb = cv.projects.slice();
    for (let i = 0; i < 4; i++) cv.projects.push({ ...pb[i % 2], id: newId(), name: pb[i % 2].name + ' ' + (i + 2) });
  }
  return cv;
}
