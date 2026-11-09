// Test Case Manager: data model, validation, ID generation, filtering/sorting, column mapping and import planning.
// Pure functions only (no DOM, no storage), so everything here is unit-tested in Node.

export const STATUSES = ['Not Run', 'Pass', 'Fail', 'Blocked'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
export const DEFAULT_STATUS = 'Not Run';
export const DEFAULT_PRIORITY = 'Medium';
export const ID_PREFIX = 'TC-';
export const MAX_FIELD_LENGTH = 32000; // Excel's cell limit is 32767 characters
export const MAX_ID_LENGTH = 64;

/** Field definitions. `label` is the column name used in exports; `aliases` are accepted import header names (normalised, see headerKey). */
export const FIELDS = [
  { key: 'id', label: 'Test Case ID', aliases: ['id', 'testcaseid', 'tcid', 'caseid', 'testid', 'testcasenumber', 'tcnumber', 'number', 'no'] },
  { key: 'title', label: 'Title', required: true, aliases: ['title', 'testcasetitle', 'testcasename', 'testname', 'name', 'summary', 'testcase'] },
  { key: 'description', label: 'Description', aliases: ['description', 'objective', 'desc', 'details', 'purpose'] },
  { key: 'preconditions', label: 'Preconditions', aliases: ['preconditions', 'precondition', 'prerequisites', 'prerequisite', 'setup'] },
  { key: 'steps', label: 'Test Steps', aliases: ['teststeps', 'steps', 'step', 'procedure', 'testprocedure', 'actions'] },
  { key: 'expected', label: 'Expected Results', aliases: ['expectedresults', 'expectedresult', 'expected', 'expectedoutcome', 'expectedbehavior', 'expectedbehaviour'] },
  { key: 'actual', label: 'Actual Results', aliases: ['actualresults', 'actualresult', 'actual', 'actualoutcome'] },
  { key: 'status', label: 'Status', aliases: ['status', 'teststatus', 'executionstatus', 'result'] },
  { key: 'priority', label: 'Priority', aliases: ['priority', 'prio', 'severity'] },
  { key: 'testData', label: 'Test Data', aliases: ['testdata', 'data', 'inputdata'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'comment', 'remarks'] },
];
export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));
const TEXT_FIELDS = ['title', 'description', 'preconditions', 'expected', 'actual', 'testData', 'notes'];

// ------------------------------------------------------------------ small helpers

/** Case-insensitive, whitespace-trimmed key used to compare IDs. */
export const idKey = id => String(id ?? '').trim().toLowerCase();

/** Normalise a header / JSON key: lower-case alphanumerics only ("Test Case ID", "test_case_id" and "testCaseId" all match). */
export const headerKey = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const compareNatural = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

const STATUS_SYNONYMS = {
  passed: 'Pass', success: 'Pass', ok: 'Pass', failed: 'Fail', failure: 'Fail', blocked: 'Blocked',
  notrun: 'Not Run', norun: 'Not Run', notexecuted: 'Not Run', untested: 'Not Run', unexecuted: 'Not Run', todo: 'Not Run', pending: 'Not Run',
};

/** Canonical status, or null when the value is not recognised. Empty input gives the default. */
export function normalizeStatus(v) {
  const s = String(v ?? '').trim();
  if (!s) return DEFAULT_STATUS;
  const k = headerKey(s);
  return STATUSES.find(x => headerKey(x) === k) || STATUS_SYNONYMS[k] || null;
}
/** Canonical priority, or null when the value is not recognised. Empty input gives the default. */
export function normalizePriority(v) {
  const s = String(v ?? '').trim();
  if (!s) return DEFAULT_PRIORITY;
  const k = headerKey(s);
  return PRIORITIES.find(x => headerKey(x) === k) || null;
}

// ------------------------------------------------------------------ test steps

/** Steps as one text block: "1. first\n2. second". A step that spans several lines keeps its extra lines unnumbered. */
export const stepsToText = steps => (steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');

/**
 * Inverse of stepsToText. Numbered lines ("1." or "1)") start a step; other lines continue the current step.
 * With no numbering at all, every non-empty line is its own step.
 */
export function parseSteps(value) {
  if (Array.isArray(value)) {
    return value.map(s => (s && typeof s === 'object' ? String(s.action ?? s.step ?? s.description ?? s.name ?? '') : String(s ?? '')).trim()).filter(Boolean);
  }
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const numbered = /^\s*\d+\s*[.)]\s+/;
  if (!lines.some(l => numbered.test(l))) return lines.map(l => l.trim()).filter(Boolean);
  const steps = [];
  for (const l of lines) {
    if (numbered.test(l)) steps.push(l.replace(numbered, '').trimEnd());
    else if (steps.length) steps[steps.length - 1] += '\n' + l.trimEnd();
    else if (l.trim()) steps.push(l.trim());
  }
  return steps.map(s => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ model

const cleanText = v => (v == null ? '' : String(v).replace(/\r\n?/g, '\n'));

/** Build a complete, well-typed test case from loose input. Does not validate. */
export function makeCase(input = {}, now = new Date().toISOString()) {
  const c = {
    id: String(input.id ?? '').trim(),
    title: '', description: '', preconditions: '', steps: parseSteps(input.steps), expected: '', actual: '',
    status: normalizeStatus(input.status) || DEFAULT_STATUS,
    priority: normalizePriority(input.priority) || DEFAULT_PRIORITY,
    testData: '', notes: '',
    createdAt: input.createdAt || now, updatedAt: input.updatedAt || now,
  };
  for (const k of TEXT_FIELDS) c[k] = cleanText(input[k]).trim();
  return c;
}

/** Problems with one case: [{ field, message }]. `others` (optional) are the other cases, used to check that the ID is unique. */
export function validateCase(c, others = null) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!String(c.title ?? '').trim()) add('title', 'Title is required.');
  const id = String(c.id ?? '').trim();
  if (!id) add('id', 'ID is required.');
  else if (id.length > MAX_ID_LENGTH) add('id', `ID must be at most ${MAX_ID_LENGTH} characters.`);
  else if (/[\u0000-\u001f]/.test(id)) add('id', 'ID cannot contain control characters.');
  else if (others && others.some(o => idKey(o.id) === idKey(id))) add('id', `ID "${id}" is already used.`);
  if (!STATUSES.includes(c.status)) add('status', `Status must be one of ${STATUSES.join(', ')}.`);
  if (!PRIORITIES.includes(c.priority)) add('priority', `Priority must be one of ${PRIORITIES.join(', ')}.`);
  for (const k of TEXT_FIELDS) if (String(c[k] ?? '').length > MAX_FIELD_LENGTH) add(k, `${FIELD_BY_KEY[k].label} is longer than ${MAX_FIELD_LENGTH} characters.`);
  if ((c.steps || []).some(s => String(s).length > MAX_FIELD_LENGTH)) add('steps', `A step is longer than ${MAX_FIELD_LENGTH} characters.`);
  return errors;
}

/** Next free "TC-001"-style ID, given the IDs already used: an iterable of IDs, or a Set of idKey() values. Case-insensitive. */
export function nextId(usedIds, prefix = ID_PREFIX) {
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '(\\d+)$', 'i');
  const used = usedIds instanceof Set ? usedIds : new Set([...usedIds].map(idKey));
  let max = 0;
  for (const id of used) { const m = re.exec(String(id)); if (m) max = Math.max(max, Number(m[1])); }
  let n = max + 1, id;
  do { id = prefix + String(n++).padStart(3, '0'); } while (used.has(idKey(id)));
  return id;
}

/** Copy of a case for "Duplicate": new ID, "(copy)" title, back to Not Run with no actual result. */
export function duplicateCase(c, usedIds, now = new Date().toISOString()) {
  return { ...c, steps: [...c.steps], id: nextId(usedIds), title: `${c.title} (copy)`, status: DEFAULT_STATUS, actual: '', createdAt: now, updatedAt: now };
}

// ------------------------------------------------------------------ filter / sort

export function filterCases(cases, { q = '', status = '', priority = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return cases.filter(c => {
    if (status && c.status !== status) return false;
    if (priority && c.priority !== priority) return false;
    if (!needle) return true;
    return [c.id, c.title, c.description, c.preconditions, c.steps.join(' '), c.expected, c.actual, c.testData, c.notes].some(v => v.toLowerCase().includes(needle));
  });
}

export const SORT_KEYS = ['id', 'title', 'priority', 'status'];

/** Sorted copy. Priority sorts Critical first when ascending; status in workflow order. Ties fall back to ID. */
export function sortCases(cases, { key = 'id', dir = 'asc' } = {}) {
  const sign = dir === 'desc' ? -1 : 1;
  const rank = {
    priority: c => PRIORITIES.length - PRIORITIES.indexOf(c.priority),
    status: c => STATUSES.indexOf(c.status),
  }[key];
  const cmp = rank ? (a, b) => rank(a) - rank(b) : (a, b) => compareNatural(a[key], b[key]);
  return [...cases].sort((a, b) => sign * cmp(a, b) || compareNatural(a.id, b.id));
}

// ------------------------------------------------------------------ import: column mapping and records

/** Guess which column feeds each field. Returns { fieldKey: columnIndex }, -1 when nothing matched. Each column is used once. */
export function autoMap(headers) {
  const keys = headers.map(headerKey), taken = new Set(), map = {};
  for (const f of FIELDS) {
    // Earlier aliases are the stronger matches, so look for them in order.
    let idx = -1;
    for (const a of [headerKey(f.label), ...f.aliases]) {
      idx = keys.findIndex((k, i) => k === a && !taken.has(i));
      if (idx >= 0) break;
    }
    map[f.key] = idx;
    if (idx >= 0) taken.add(idx);
  }
  return map;
}

const FORMULA_ESCAPE = /^'(?=[=+\-@\t\r])/; // exports prefix such cells with ' to stop spreadsheets running them; undo that on import

function cellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Turn parsed table rows into import records using a column mapping.
 * Returns [{ row, case, errors: [{ field, column, message }], hasId }]; `row` is the row number to show the user.
 * Rows where every mapped cell is blank are dropped.
 */
export function buildRecords(headers, rows, rowNumbers, mapping, now = new Date().toISOString()) {
  const records = [];
  rows.forEach((cells, i) => {
    const get = key => (mapping[key] >= 0 ? cells[mapping[key]] : undefined);
    const fields = {};
    let any = false;
    for (const f of FIELDS) {
      const raw = get(f.key);
      if (f.key === 'steps') { fields.steps = Array.isArray(raw) ? raw : cellToString(raw).replace(FORMULA_ESCAPE, ''); if (parseSteps(fields.steps).length) any = true; continue; }
      const s = cellToString(raw).replace(FORMULA_ESCAPE, '');
      fields[f.key] = s;
      if (s.trim()) any = true;
    }
    if (!any) return;
    const row = rowNumbers[i] ?? i + 2;
    const errors = [];
    const colName = key => (mapping[key] >= 0 ? String(headers[mapping[key]] ?? FIELD_BY_KEY[key].label) : FIELD_BY_KEY[key].label);
    const status = normalizeStatus(fields.status), priority = normalizePriority(fields.priority);
    if (status === null) errors.push({ field: 'status', column: colName('status'), message: `"${fields.status.trim()}" is not a valid status (${STATUSES.join(', ')}).` });
    if (priority === null) errors.push({ field: 'priority', column: colName('priority'), message: `"${fields.priority.trim()}" is not a valid priority (${PRIORITIES.join(', ')}).` });
    const c = makeCase({ ...fields, status: status ?? DEFAULT_STATUS, priority: priority ?? DEFAULT_PRIORITY }, now);
    const hasId = c.id !== '';
    for (const e of validateCase(hasId ? c : { ...c, id: 'auto' })) {
      if (e.field === 'status' || e.field === 'priority') continue;
      errors.push({ field: e.field, column: colName(e.field), message: e.message });
    }
    records.push({ row, case: c, errors, hasId });
  });
  return records;
}

// ------------------------------------------------------------------ import: duplicates and plan

export const DUP_MODES = [
  { value: 'skip', label: 'Skip duplicates' },
  { value: 'overwrite', label: 'Overwrite existing' },
  { value: 'new', label: 'Generate new IDs' },
];

/**
 * Mark each record with `dup`: 'existing' (ID already stored), 'file' (ID repeated earlier in this file) or null.
 * Invalid records are never duplicates. Mutates and returns the records.
 */
export function markDuplicates(records, existing) {
  const stored = new Set(existing.map(c => idKey(c.id)));
  const seen = new Set();
  for (const r of records) {
    r.dup = null;
    if (r.errors.length || !r.hasId) continue;
    const k = idKey(r.case.id);
    if (stored.has(k)) r.dup = 'existing'; else if (seen.has(k)) r.dup = 'file';
    seen.add(k);
  }
  return records;
}

/**
 * Decide what an import does. Pure: returns { put, summary, failures, skippedRows } and leaves `existing` alone.
 *  - `put` is the list of cases to write (new ones, plus overwritten ones, which keep the stored ID and creation date).
 *  - summary = { total, added, overwritten, skipped, failed }.
 * Records without an ID, and (in 'new' mode) duplicates, get fresh IDs that avoid every ID in the store and in the file.
 */
export function planImport(records, existing, mode = 'skip', now = new Date().toISOString()) {
  markDuplicates(records, existing);
  const byKey = new Map(existing.map(c => [idKey(c.id), c]));
  const used = new Set(byKey.keys());
  for (const r of records) if (!r.errors.length && r.hasId) used.add(idKey(r.case.id));
  const out = new Map(); // idKey -> case to write; insertion order preserved
  const failures = [], skippedRows = [];
  const summary = { total: records.length, added: 0, overwritten: 0, skipped: 0, failed: 0 };
  const fresh = () => { const id = nextId(used); used.add(idKey(id)); return id; };

  for (const r of records) {
    if (r.errors.length) { summary.failed++; failures.push({ row: r.row, errors: r.errors }); continue; }
    let c = { ...r.case, createdAt: now, updatedAt: now };
    if (!r.hasId) { c.id = fresh(); out.set(idKey(c.id), c); summary.added++; continue; }
    if (!r.dup) { out.set(idKey(c.id), c); summary.added++; continue; }
    if (mode === 'skip') { summary.skipped++; skippedRows.push(r.row); continue; }
    if (mode === 'new') { c.id = fresh(); out.set(idKey(c.id), c); summary.added++; continue; }
    // overwrite: keep the stored ID spelling and creation date; a later row for the same ID wins over an earlier one
    const k = idKey(c.id), prev = out.get(k) || byKey.get(k);
    c = { ...c, id: prev.id, createdAt: prev.createdAt };
    out.set(k, c);
    summary.overwritten++;
  }
  return { put: [...out.values()], summary, failures, skippedRows };
}

/** Apply a plan to an in-memory list (the store does the same on disk). */
export function applyPlan(existing, put) {
  const map = new Map(existing.map(c => [idKey(c.id), c]));
  for (const c of put) map.set(idKey(c.id), c);
  return [...map.values()];
}
