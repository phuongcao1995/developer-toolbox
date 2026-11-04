// Pure glue between the request editor and the network: variable substitution + auth + body -> fetch pieces,
// snippet requests for the cURL/fetch/Python builders, import detection and secret stripping. No DOM, no storage.
import {
  buildRequest, applyAuth, validateUrl, normalizeAuth, formToLines, paramsFromText, redactAuth, redactUrl, redactBody,
  isSensitiveHeader, isVariableOnly, METHODS, restoreRows,
} from './logic.js';
import {
  substituteRequest, normalizeRequest, blankRequest, importCollectionEnvelope, importEnvsEnvelope, normalizeEnvs, uid, EXPORT_APP,
} from './store.js';
import { importCollection, importEnvironment, IMPORT_LIMITS } from './postman.js';

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Resolve a draft request ({method,url,params,headers,bodyType,body,auth,settings}) into what fetch needs.
 * vars = buildVarMap(...). Returns { ok, error?, missing[], usedSecret, method, url, headers (object), body, formFields, auth, settings }.
 * `missing` is reported even when ok is false so the UI can offer "Send anyway".
 */
export function composeRequest(draft, { vars = {}, dyn = {} } = {}) {
  const { request: r, missing, usedSecret } = substituteRequest(draft, vars, dyn);
  const fail = error => ({ ok: false, error, missing, usedSecret });
  const built = buildRequest({ method: r.method, headers: r.headers, body: r.body, bodyType: r.bodyType });
  if (!built.ok) return fail(built.error);
  const a = applyAuth(r.auth, { url: r.url, headers: r.headers });
  const headers = { ...built.headers };
  if (a.header) headers[a.header.key] = a.header.value;
  const v = validateUrl(a.url);
  if (!v.ok) return fail(v.error);
  return {
    ok: true, missing, usedSecret, method: r.method, url: a.url, headers, body: built.body, formFields: built.formFields || null,
    autoContentType: built.autoContentType, auth: a, settings: draft.settings || {},
  };
}

/** Request shape understood by assets/js/shared/curl.js builders (buildCurl / buildFetch / buildPython). */
export function snippetRequest(c) {
  return {
    method: c.method, url: c.url,
    headers: Object.entries(c.headers).map(([key, value]) => ({ key, value })),
    body: c.body ?? '', bodyType: c.formFields ? 'multipart' : 'raw',
    form: (c.formFields || []).map(([key, value]) => ({ key, value })),
    options: { followRedirects: (c.settings && c.settings.redirect) !== 'manual' },
  };
}

/**
 * What the Auth tab will add, for the masked preview. -> { state: 'none'|'incomplete'|'header'|'query'|'skipped', name?, value?, missing[] }
 */
export function previewAuth(draft, { vars = {}, dyn = {} } = {}) {
  const { request, missing } = substituteRequest({ url: draft.url || '', headers: draft.headers || [], params: [], body: '', auth: draft.auth }, vars, dyn);
  const n = normalizeAuth(request.auth);
  if (n.type === 'none') return { state: 'none', missing };
  const a = applyAuth(n, { url: request.url, headers: request.headers });
  if (a.header) return { state: 'header', name: a.header.key, value: a.header.value, missing };
  if (a.skipped) return { state: 'skipped', name: n.type === 'apikey' ? n.name : 'Authorization', missing };
  if (a.url !== request.url) return { state: 'query', name: n.name, value: n.value, missing };
  return { state: 'incomplete', missing };
}

/** Mask the secret part of a displayed value: "Bearer abc" -> "Bearer ••••••". */
export function maskDisplay(value) {
  const s = String(value ?? '');
  const m = /^(\S+\s)(.+)$/.exec(s);
  const dots = n => '•'.repeat(Math.min(12, Math.max(6, n)));
  return m ? m[1] + dots(m[2].length) : dots(s.length);
}

// ---------- cURL import ----------
/** Turn parseCurl() output into a saved-request-shaped draft. -> { draft, warnings[] } */
export function draftFromCurl(parsed) {
  const warnings = [...(parsed.warnings || [])];
  const d = blankRequest();
  const m = String(parsed.method || 'GET').toUpperCase();
  if (METHODS.includes(m)) d.method = m; else warnings.push(`Method ${m} is not supported by this tool; GET was used.`);
  d.url = String(parsed.url || '');
  d.params = paramsFromText(d.url);
  d.headers = (parsed.headers || []).map(h => ({ key: String(h.key), value: String(h.value ?? ''), enabled: h.enabled !== false }));
  d.bodyType = parsed.bodyType || 'json';
  d.body = d.bodyType === 'multipart' ? formToLines(parsed.form) : String(parsed.body || '');
  if (d.bodyType === 'multipart' && (parsed.form || []).some(f => f.file)) warnings.push('File fields (-F name=@file) cannot be read from a web page; they were imported as plain text values.');
  d.auth = normalizeAuth(parsed.auth);
  return { draft: normalizeRequest(d), warnings };
}

// ---------- history -> draft ----------
/** Draft + notes for restoring a history entry (redacted values come back empty). */
export function draftFromHistory(h) {
  const notes = [];
  const auth = normalizeAuth(h.auth);
  const d = normalizeRequest({ method: h.method, url: h.url, params: restoreRows(h.params), headers: restoreRows(h.headers), bodyType: h.bodyType, body: h.body, auth, settings: {} });
  if ((h.headers || []).some(r => r.redacted) || auth.redacted) notes.push('sensitive values were not saved: re-enter them');
  if (h.bodyTruncated) notes.push('the saved body was cut at 64 KB');
  return { draft: d, notes };
}

// ---------- import / export of files ----------
const slug = s => String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';
export const fileSlug = slug;

/** Detect what kind of JSON a file is. -> { ok, kind, value } | { ok:false, error } */
export function classifyImport(text) {
  const s = String(text ?? '');
  if (!s.trim()) return { ok: false, error: 'Nothing to import: the text is empty.' };
  if (s.length > IMPORT_LIMITS.bytes) return { ok: false, error: `The file is too large (limit ${IMPORT_LIMITS.bytes / 1048576} MB).` };
  let v;
  try { v = JSON.parse(s); } catch (e) { return { ok: false, error: `Not valid JSON: ${e.message}` }; }
  if (!isObj(v)) return { ok: false, error: 'Expected a JSON object (a collection or environment export).' };
  if (v.app === EXPORT_APP) {
    if (v.kind === 'collection') return { ok: true, kind: 'dt-collection', value: v };
    if (v.kind === 'environments') return { ok: true, kind: 'dt-envs', value: v };
    if (v.kind === 'history') return { ok: false, error: 'History exports are for reference only and cannot be imported.' };
    return { ok: false, error: `Unknown export kind "${String(v.kind)}".` };
  }
  if (isObj(v.info) && Array.isArray(v.item)) return { ok: true, kind: 'postman-collection', value: v };
  if (Array.isArray(v.values)) return { ok: true, kind: 'postman-env', value: v };
  if (Array.isArray(v.requests) || v.order) return { ok: false, error: 'This looks like a Postman collection v1 file, which is not supported. Re-export it from Postman as "Collection v2.1".' };
  return { ok: false, error: 'Unrecognised file. Expected a Developer Toolbox export, a Postman v2.1 collection or a Postman environment.' };
}

/**
 * Convert an import file into data to merge.
 * -> { ok, kind, collections:[node], envs:[{id,name,vars}], globals:[var], warnings[], summary } | { ok:false, error }
 */
export function runImport(text) {
  const c = classifyImport(text);
  if (!c.ok) return c;
  const out = { ok: true, kind: c.kind, collections: [], envs: [], globals: [], warnings: [], summary: '' };
  if (c.kind === 'dt-collection') {
    const r = importCollectionEnvelope(c.value);
    if (!r.ok) return r;
    out.collections.push(r.collection);
    if (r.dropped) out.warnings.push(`${r.dropped} invalid item${r.dropped === 1 ? '' : 's'} in the file were skipped.`);
    out.summary = `Imported collection "${r.collection.name}".`;
  } else if (c.kind === 'dt-envs') {
    const r = importEnvsEnvelope(c.value);
    if (!r.ok) return r;
    out.envs = r.envs; out.globals = r.globals;
    if (c.value.secretsIncluded === false) out.warnings.push('Secret values were not included in this export; fill them in.');
    out.summary = `Imported ${r.envs.length} environment${r.envs.length === 1 ? '' : 's'}${r.globals.length ? ` and ${r.globals.length} global variable${r.globals.length === 1 ? '' : 's'}` : ''}.`;
  } else if (c.kind === 'postman-collection') {
    const r = importCollection(c.value);
    if (!r.ok) return r;
    out.collections.push(r.collection); out.warnings.push(...r.warnings);
    if (r.variables.length) {
      out.envs = normalizeEnvs({ envs: [{ name: `${r.collection.name} (variables)`, vars: r.variables }] }).envs;
      out.warnings.push(`The collection's ${r.variables.length} variable${r.variables.length === 1 ? '' : 's'} were added as a new environment.`);
    }
    out.summary = `Imported "${r.collection.name}": ${r.stats.requests} request${r.stats.requests === 1 ? '' : 's'}, ${r.stats.folders} folder${r.stats.folders === 1 ? '' : 's'}.`;
  } else {
    const r = importEnvironment(c.value);
    if (!r.ok) return r;
    out.warnings.push(...r.warnings);
    if (r.isGlobals) { out.globals = r.environment.vars; out.summary = `Imported ${r.environment.vars.length} global variable${r.environment.vars.length === 1 ? '' : 's'}.`; }
    else { out.envs = normalizeEnvs({ envs: [r.environment] }).envs; out.summary = `Imported environment "${r.environment.name}" (${r.environment.vars.length} variable${r.environment.vars.length === 1 ? '' : 's'}).`; }
  }
  return out;
}

/** Merge imported envs/globals into an environments store. Existing global keys are kept. -> { state, skippedGlobals } */
export function mergeEnvs(state, { envs = [], globals = [] }) {
  const have = new Set(state.globals.map(g => g.key));
  const add = globals.filter(g => !have.has(g.key));
  const names = new Set(state.envs.map(e => e.name));
  const fresh = envs.map(e => {
    let name = e.name, n = 2;
    while (names.has(name)) name = `${e.name} (${n++})`;
    names.add(name);
    return { ...e, id: e.id || uid(), name };
  });
  return {
    state: { ...state, globals: [...state.globals, ...add], envs: [...state.envs, ...fresh] },
    skippedGlobals: globals.length - add.length,
  };
}

/** Deep copy of a collection/folder/request node with secrets removed (used when exporting without "include secrets"). */
export function stripSecrets(node) {
  const strip = n => {
    if (n.type !== 'request') return { ...n, items: n.items.map(strip) };
    const r = n.request;
    const headers = (r.headers || []).map(h => (isSensitiveHeader(h.key) && h.value !== '' && !isVariableOnly(h.value) ? { ...h, value: '' } : { ...h }));
    const params = (r.params || []).map(p => {
      const probe = `x?${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`;
      return redactUrl(probe) !== probe && !isVariableOnly(p.value) ? { ...p, value: '' } : { ...p };
    });
    const auth = redactAuth(r.auth, false);
    return { ...n, request: { ...r, url: redactUrl(r.url).replace(/%5Bredacted%5D/gi, ''), params, headers, auth, body: redactBody(r.body).replace(/"\[redacted\]"/g, '""') } };
  };
  return strip(JSON.parse(JSON.stringify(node)));
}

/** Count of secret-looking things stripSecrets() would remove (for the export dialog hint). */
export function countSecrets(node) {
  let n = 0;
  const rec = x => {
    if (x.type !== 'request') return x.items.forEach(rec);
    const r = x.request;
    if (normalizeAuth(r.auth).type !== 'none') n++;
    n += (r.headers || []).filter(h => isSensitiveHeader(h.key) && h.value !== '' && !isVariableOnly(h.value)).length;
  };
  rec(node);
  return n;
}
