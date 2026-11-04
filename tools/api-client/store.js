// Pure data model for collections, environments and variable substitution (no DOM, no storage access).
import { METHODS, BODY_TYPES, normalizeAuth, REDACTED } from './logic.js';

export const SCHEMA_VERSION = 1;
export const LIMITS = { nodes: 5000, depth: 10, name: 200, body: 1024 * 1024, vars: 500 };
export const STORAGE_WARN_BYTES = 3.5 * 1024 * 1024; // localStorage is typically capped near 5 MB
export const EXPORT_APP = 'developer-toolbox-api-client';

const str = (v, max = 1e7) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// ---------- requests ----------
const rows = a => (Array.isArray(a) ? a.filter(isObj).slice(0, 500).map(r => ({ key: str(r.key, 2000), value: str(r.value, LIMITS.body), enabled: r.enabled !== false })) : []);

export const blankRequest = () => ({ method: 'GET', url: '', params: [], headers: [], bodyType: 'json', body: '', auth: { type: 'none' }, settings: {} });

/** Sanitize a saved request (from storage, import or an older version). Always returns a complete object. */
export function normalizeRequest(r) {
  r = isObj(r) ? r : {};
  const s = isObj(r.settings) ? r.settings : {};
  const settings = {};
  if (['include', 'same-origin', 'omit'].includes(s.credentials)) settings.credentials = s.credentials;
  if (['follow', 'manual'].includes(s.redirect)) settings.redirect = s.redirect;
  if (['cors', 'no-cors', 'same-origin'].includes(s.mode)) settings.mode = s.mode;
  if (Number.isFinite(Number(s.timeout)) && Number(s.timeout) > 0) settings.timeout = Math.min(300, Math.round(Number(s.timeout)));
  return {
    method: METHODS.includes(String(r.method).toUpperCase()) ? String(r.method).toUpperCase() : 'GET',
    url: str(r.url, 20000), params: rows(r.params), headers: rows(r.headers),
    bodyType: BODY_TYPES.includes(r.bodyType) ? r.bodyType : 'json', body: str(r.body, LIMITS.body),
    auth: normalizeAuth(r.auth), settings,
  };
}

// ---------- collection tree ----------
// tree: [ {type:'collection', id, name, items:[ {type:'folder', id, name, items:[...]} | {type:'request', id, name, request} ]} ]
export const isContainer = n => n && (n.type === 'collection' || n.type === 'folder');

function normNode(n, depth, ctx) {
  if (!isObj(n) || ctx.count >= LIMITS.nodes) { ctx.dropped++; return null; }
  if (depth > LIMITS.depth) { ctx.dropped++; return null; }
  ctx.count++;
  const name = str(n.name, LIMITS.name).trim() || 'Untitled';
  const id = typeof n.id === 'string' && n.id && !ctx.ids.has(n.id) ? n.id : uid();
  ctx.ids.add(id);
  if (n.type === 'request') return { type: 'request', id, name, request: normalizeRequest(n.request) };
  if (n.type === 'folder' || n.type === 'collection') {
    const node = { type: depth === 0 ? 'collection' : 'folder', id, name, items: [] };
    for (const c of Array.isArray(n.items) ? n.items : []) { const x = normNode(c, depth + 1, ctx); if (x) node.items.push(x); }
    return node;
  }
  ctx.dropped++; return null;
}

/** Validate a tree. Returns { tree, dropped } — invalid nodes are dropped and counted, never thrown. */
export function normalizeTree(raw) {
  const ctx = { count: 0, dropped: 0, ids: new Set() };
  const tree = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const x = normNode({ ...(isObj(c) ? c : {}), type: 'collection' }, 0, ctx);
    if (x) tree.push(x);
  }
  return { tree, dropped: ctx.dropped };
}

/** Parse what is stored under the "collections" key. readOnly=true when written by a newer schema (so we never overwrite it). */
export function parseStored(raw) {
  if (raw == null) return { tree: [], readOnly: false, warnings: [] };
  if (!isObj(raw) || typeof raw.v !== 'number') return { tree: [], readOnly: true, warnings: ['Saved collections have an unrecognised format; they were left untouched and are read-only this session.'] };
  if (raw.v > SCHEMA_VERSION) return { tree: normalizeTree(raw.collections).tree, readOnly: true, warnings: [`Saved collections were written by a newer version (schema ${raw.v}); they are shown read-only to avoid data loss.`] };
  const { tree, dropped } = normalizeTree(raw.collections);
  return { tree, readOnly: false, warnings: dropped ? [`${dropped} invalid saved item${dropped === 1 ? '' : 's'} could not be loaded.`] : [] };
}
export const serializeStore = tree => ({ v: SCHEMA_VERSION, collections: tree });

/** Size of the serialized payload in bytes (UTF-8) and whether it is close to the storage quota. */
export function storageSize(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return { bytes, warn: bytes >= STORAGE_WARN_BYTES };
}

export function walk(tree, fn) {
  const rec = (list, parent, depth) => { list.forEach((n, i) => { fn(n, parent, i, depth); if (isContainer(n)) rec(n.items, n, depth + 1); }); };
  rec(tree, null, 0);
}
export function findNode(tree, id) {
  let hit = null;
  const rec = (list, parent) => {
    for (let i = 0; i < list.length && !hit; i++) {
      if (list[i].id === id) hit = { node: list[i], list, index: i, parent };
      else if (isContainer(list[i])) rec(list[i].items, list[i]);
    }
  };
  rec(tree, null);
  return hit;
}
export function countNodes(tree) { let n = 0; walk(tree, () => n++); return n; }
export function countRequests(tree) { let n = 0; walk(tree, x => { if (x.type === 'request') n++; }); return n; }
const depthOf = (tree, id) => { let d = -1; walk(tree, (n, _p, _i, depth) => { if (n.id === id) d = depth; }); return d; };
const subtreeHeight = n => (isContainer(n) ? 1 + Math.max(0, ...n.items.map(subtreeHeight)) : 0);

/** Add a collection (parentId null) or a folder. Returns the node or null (too deep / unknown parent / quota). */
export function addContainer(tree, parentId, name) {
  if (countNodes(tree) >= LIMITS.nodes) return null;
  const node = { type: parentId == null ? 'collection' : 'folder', id: uid(), name: str(name, LIMITS.name).trim() || (parentId == null ? 'New collection' : 'New folder'), items: [] };
  if (parentId == null) { tree.push(node); return node; }
  const p = findNode(tree, parentId);
  if (!p || !isContainer(p.node) || depthOf(tree, parentId) + 1 > LIMITS.depth) return null;
  p.node.items.push(node); return node;
}
export function addRequest(tree, parentId, name, request) {
  const p = findNode(tree, parentId);
  if (!p || !isContainer(p.node) || countNodes(tree) >= LIMITS.nodes) return null;
  const node = { type: 'request', id: uid(), name: str(name, LIMITS.name).trim() || 'Untitled request', request: normalizeRequest(request) };
  p.node.items.push(node); return node;
}
/** Replace a saved request's content (Save). */
export function updateRequest(tree, id, request) {
  const h = findNode(tree, id);
  if (!h || h.node.type !== 'request') return false;
  h.node.request = normalizeRequest(request); return true;
}
export function renameNode(tree, id, name) {
  const h = findNode(tree, id), n = str(name, LIMITS.name).trim();
  if (!h || !n) return false;
  h.node.name = n; return true;
}
export function deleteNode(tree, id) {
  const h = findNode(tree, id);
  if (!h) return false;
  h.list.splice(h.index, 1); return true;
}
function cloneFresh(n) {
  const c = { ...n, id: uid() };
  if (n.type === 'request') c.request = JSON.parse(JSON.stringify(n.request));
  else c.items = n.items.map(cloneFresh);
  return c;
}
/** Duplicate a node right after the original (deep copy with new ids). */
export function duplicateNode(tree, id) {
  const h = findNode(tree, id);
  if (!h || countNodes(tree) + 1 > LIMITS.nodes) return null;
  const c = cloneFresh(h.node); c.name = `${h.node.name} (copy)`.slice(0, LIMITS.name);
  h.list.splice(h.index + 1, 0, c); return c;
}
/** Move a node into container targetId (null = top level, collections only) at index (default: end). */
export function moveNode(tree, id, targetId, index) {
  const h = findNode(tree, id);
  if (!h) return false;
  let list;
  if (targetId == null) { if (h.node.type !== 'collection') return false; list = tree; }
  else {
    const t = findNode(tree, targetId);
    if (!t || !isContainer(t.node) || h.node.type === 'collection') return false;
    if (id === targetId || (isContainer(h.node) && findNode([h.node], targetId))) return false; // not into itself / a descendant
    if (depthOf(tree, targetId) + 1 + subtreeHeight(h.node) > LIMITS.depth + 1) return false;
    list = t.node.items;
  }
  h.list.splice(h.index, 1);
  const at = index == null ? list.length : Math.max(0, Math.min(list.length, index));
  list.splice(at, 0, h.node); return true;
}
/** Reorder within the same parent (keyboard "move up/down"). */
export function shiftNode(tree, id, delta) {
  const h = findNode(tree, id);
  if (!h) return false;
  const to = h.index + delta;
  if (to < 0 || to >= h.list.length) return false;
  h.list.splice(h.index, 1); h.list.splice(to, 0, h.node); return true;
}
/** Every container a node may be moved into (for the "Move to…" dialog). */
export function moveTargets(tree, id) {
  const h = findNode(tree, id), out = [];
  if (!h || h.node.type === 'collection') return out;
  walk(tree, (n, _p, _i, depth) => {
    if (!isContainer(n) || n.id === id || (isContainer(h.node) && findNode([h.node], n.id))) return;
    if (depth + 1 + subtreeHeight(h.node) > LIMITS.depth + 1) return;
    out.push({ id: n.id, name: n.name, depth });
  });
  return out;
}
export function pathOf(tree, id) {
  const names = [];
  const rec = (list) => {
    for (const n of list) {
      if (n.id === id) { names.push(n.name); return true; }
      if (isContainer(n) && rec(n.items)) { names.unshift(n.name); return true; }
    }
    return false;
  };
  return rec(tree) ? names : [];
}

/** Collection export envelope (requests only hold {{placeholders}}, never resolved secrets). */
export function exportCollection(tree, id) {
  const h = findNode(tree, id);
  if (!h || h.node.type !== 'collection') return null;
  return { app: EXPORT_APP, v: SCHEMA_VERSION, kind: 'collection', exportedAt: new Date().toISOString(), collection: JSON.parse(JSON.stringify(h.node)) };
}
/** Validate an exported collection envelope; returns { ok, collection (fresh ids) | error }. */
export function importCollectionEnvelope(obj) {
  if (!isObj(obj)) return { ok: false, error: 'Not a collection export (expected a JSON object).' };
  if (obj.app !== EXPORT_APP || obj.kind !== 'collection') return { ok: false, error: 'This JSON is not a Developer Toolbox collection export. For Postman files use "Import Postman".' };
  if (typeof obj.v !== 'number' || obj.v > SCHEMA_VERSION) return { ok: false, error: `Unsupported export version ${String(obj.v)}.` };
  const { tree, dropped } = normalizeTree([obj.collection]);
  if (!tree.length) return { ok: false, error: 'The export contains no valid collection.' };
  const fresh = cloneFresh(tree[0]);
  return { ok: true, collection: fresh, dropped };
}

// ---------- environments ----------
export const blankVar = () => ({ key: '', value: '', secret: false, enabled: true });
const varRows = a => (Array.isArray(a) ? a.filter(isObj).slice(0, LIMITS.vars).map(r => ({ key: str(r.key, 200).trim(), value: str(r.value, 100000), secret: !!r.secret, enabled: r.enabled !== false })) : []);

/** Sanitize the environments store: { v, globals:[var], envs:[{id,name,vars}], activeId }. */
export function normalizeEnvs(raw) {
  const out = { v: 1, globals: [], envs: [], activeId: null };
  if (!isObj(raw)) return out;
  out.globals = varRows(raw.globals);
  const ids = new Set();
  for (const e of Array.isArray(raw.envs) ? raw.envs.slice(0, 100) : []) {
    if (!isObj(e)) continue;
    let id = typeof e.id === 'string' && e.id && !ids.has(e.id) ? e.id : uid(); ids.add(id);
    out.envs.push({ id, name: str(e.name, LIMITS.name).trim() || 'Environment', vars: varRows(e.vars) });
  }
  out.activeId = out.envs.some(e => e.id === raw.activeId) ? raw.activeId : null;
  return out;
}
/** Environment export. Secret values are blanked unless includeSecrets. */
export function exportEnvs(state, { includeSecrets = false, envId = null } = {}) {
  const strip = v => ({ key: v.key, value: v.secret && !includeSecrets ? '' : v.value, secret: v.secret, enabled: v.enabled });
  const envs = state.envs.filter(e => !envId || e.id === envId).map(e => ({ id: e.id, name: e.name, vars: e.vars.map(strip) }));
  return { app: EXPORT_APP, v: 1, kind: 'environments', secretsIncluded: !!includeSecrets, globals: envId ? [] : state.globals.map(strip), envs };
}
export function importEnvsEnvelope(obj) {
  if (!isObj(obj) || obj.app !== EXPORT_APP || obj.kind !== 'environments') return { ok: false, error: 'This JSON is not a Developer Toolbox environment export.' };
  const n = normalizeEnvs({ globals: obj.globals, envs: (obj.envs || []).map(e => ({ ...e, id: uid() })) });
  return { ok: true, globals: n.globals, envs: n.envs };
}
/** Map of name -> {value, secret} (environment overrides globals; disabled and unnamed rows skipped). */
export function buildVarMap(globals, env) {
  const m = Object.create(null);
  for (const v of [...(globals || []), ...((env && env.vars) || [])]) if (v.enabled !== false && v.key) m[v.key] = { value: v.value, secret: !!v.secret };
  return m;
}

// ---------- substitution ----------
const VAR_RE = /\{\{\s*([^{}\s]+?)\s*\}\}/g;
const HAS_VAR = /\{\{\s*[^{}\s]+?\s*\}\}/;
export const DYNAMIC_VARS = ['$uuid', '$timestamp', '$isoTimestamp', '$randomInt'];

function randomUuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Value of a dynamic variable, or undefined when name is not dynamic. opts: {now: ms, rng: ()=>[0,1), uuid: ()=>string}. */
export function dynamicValue(name, opts = {}) {
  const now = opts.now ?? Date.now();
  switch (name) {
    case '$uuid': case '$guid': return (opts.uuid || randomUuid)();
    case '$timestamp': return String(Math.floor(now / 1000));
    case '$isoTimestamp': return new Date(now).toISOString();
    case '$randomInt': return String(Math.floor((opts.rng || Math.random)() * 1001));
    default: return undefined;
  }
}
/** All variable names referenced in text (excluding dynamic ones when skipDynamic). */
export function findVars(text, { skipDynamic = false } = {}) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(VAR_RE)) if (!(skipDynamic && dynamicValue(m[1]) !== undefined)) out.add(m[1]);
  return [...out];
}
/**
 * Replace {{name}} in text. vars = buildVarMap(...). Unresolved placeholders are left as typed and reported in `missing`.
 * Values may themselves contain {{other}} (resolved up to 5 levels; cycles stop there).
 */
export function substitute(text, vars, opts = {}) {
  const missing = new Set(); let usedSecret = false;
  let cur = String(text ?? '');
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    cur = cur.replace(VAR_RE, (whole, name) => {
      const d = dynamicValue(name, opts);
      if (d !== undefined) { changed = true; return d; }
      const v = vars && vars[name];
      if (v === undefined || !Object.prototype.hasOwnProperty.call(vars, name)) { missing.add(name); return whole; }
      if (v.secret) usedSecret = true;
      changed = true; return v.value;
    });
    if (!changed || !HAS_VAR.test(cur)) break;
  }
  return { text: cur, missing: [...missing], usedSecret };
}
/** Substitute through every user-visible field of a request: url, params, headers, body, form, auth. */
export function substituteRequest(req, vars, opts = {}) {
  const missing = new Set(); let usedSecret = false;
  const s = t => { const r = substitute(t, vars, opts); r.missing.forEach(m => missing.add(m)); usedSecret ||= r.usedSecret; return r.text; };
  const mapRows = list => (list || []).map(r => ({ ...r, key: s(r.key), value: s(r.value) }));
  const out = { ...req, url: s(req.url), params: mapRows(req.params), headers: mapRows(req.headers), body: s(req.body) };
  if (req.form) out.form = mapRows(req.form);
  if (req.auth) out.auth = Object.fromEntries(Object.entries(req.auth).map(([k, v]) => [k, typeof v === 'string' && k !== 'type' && k !== 'in' ? s(v) : v]));
  return { request: out, missing: [...missing], usedSecret };
}
/** Show a variable value in the UI: secrets are masked. */
export const maskValue = (v, secret) => (secret && v ? '•'.repeat(Math.min(12, Math.max(6, v.length))) : v);
export { REDACTED };
