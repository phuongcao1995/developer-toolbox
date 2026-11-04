// Pure Postman Collection v2.1 / Environment converters (no DOM, no storage). Scripts are never executed — they are counted and skipped.
import { splitUrl, paramsFromText, applyParamsToUrl, parseFormLines, normalizeAuth } from './logic.js';
import { normalizeTree, uid, blankRequest, normalizeRequest, LIMITS } from './store.js';

export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
export const IMPORT_LIMITS = { bytes: 25 * 1024 * 1024, requests: 5000, depth: LIMITS.depth };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const S = v => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = error => ({ ok: false, error });

function parseInput(input, what) {
  if (typeof input === 'string') {
    if (input.length > IMPORT_LIMITS.bytes) return { error: `The file is too large (${(input.length / 1048576).toFixed(1)} MB > ${IMPORT_LIMITS.bytes / 1048576} MB limit).` };
    if (!input.trim()) return { error: `The ${what} file is empty.` };
    try { return { value: JSON.parse(input) }; } catch (e) { return { error: `Not valid JSON: ${e.message}` }; }
  }
  return { value: input };
}

// Postman dynamic variables -> ours
const DYN_MAP = { $guid: '$uuid', $randomUUID: '$uuid', $timestamp: '$timestamp', $isoTimestamp: '$isoTimestamp', $randomInt: '$randomInt', $uuid: '$uuid' };
function mapVars(text, unsupported) {
  return String(text).replace(/\{\{\s*(\$[A-Za-z]+)\s*\}\}/g, (m, name) => {
    if (DYN_MAP[name]) return `{{${DYN_MAP[name]}}}`;
    unsupported.add(name); return m;
  });
}
const encodeKeepVars = s => String(s).split(/(\{\{[^{}]+\}\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join('');
const kvArray = a => {
  if (Array.isArray(a)) return Object.fromEntries(a.filter(isObj).map(x => [S(x.key), x.value]));
  return isObj(a) ? a : {};
};

function convertUrl(u) {
  if (typeof u === 'string') return { raw: u, query: null };
  if (!isObj(u)) return { raw: '', query: null };
  let raw = S(u.raw);
  const query = Array.isArray(u.query) ? u.query.filter(isObj).map(q => ({ key: S(q.key), value: S(q.value), enabled: !q.disabled })) : null;
  if (!raw) {
    const host = Array.isArray(u.host) ? u.host.join('.') : S(u.host);
    const path = Array.isArray(u.path) ? u.path.map(S).join('/') : S(u.path);
    raw = `${u.protocol ? S(u.protocol) + '://' : ''}${host}${u.port ? ':' + S(u.port) : ''}${path ? '/' + path.replace(/^\//, '') : ''}`;
  }
  return { raw, query };
}

function convertAuth(a, warnings) {
  if (a === undefined || a === null) return undefined; // inherit
  if (!isObj(a) || !a.type) return undefined;
  const t = a.type;
  if (t === 'noauth') return { type: 'none' };
  const f = kvArray(a[t]);
  if (t === 'bearer') return normalizeAuth({ type: 'bearer', token: S(f.token), prefix: 'Bearer' });
  if (t === 'basic') return normalizeAuth({ type: 'basic', username: S(f.username), password: S(f.password) });
  if (t === 'apikey') return normalizeAuth({ type: 'apikey', name: S(f.key), value: S(f.value), in: f.in === 'query' ? 'query' : 'header' });
  warnings.add(`Auth type "${t}" is not supported; those requests were imported without authentication.`);
  return { type: 'none' };
}

const countScripts = events => (Array.isArray(events) ? events.filter(e => isObj(e) && isObj(e.script) && (Array.isArray(e.script.exec) ? e.script.exec.some(l => S(l).trim()) : S(e.script.exec).trim())).length : 0);
const CT_FOR = { xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };

function convertRequest(item, inheritedAuth, ctx) {
  const rq = isObj(item.request) ? item.request : (typeof item.request === 'string' ? { url: item.request } : {});
  const req = blankRequest();
  req.method = S(rq.method).toUpperCase() || 'GET';
  const { raw, query } = convertUrl(rq.url);
  const base = splitUrl(raw);
  const params = query || paramsFromText(raw);
  req.params = params.map(p => ({ key: p.key, value: p.value, enabled: p.enabled !== false }));
  req.url = applyParamsToUrl(base.base + base.hash, req.params);
  // headers
  const hdrs = Array.isArray(rq.header) ? rq.header.filter(isObj) : [];
  req.headers = hdrs.map(h => ({ key: S(h.key), value: S(h.value), enabled: !h.disabled }));
  if (typeof rq.header === 'string') req.headers = rq.header.split(/\r?\n/).filter(l => l.includes(':')).map(l => ({ key: l.slice(0, l.indexOf(':')).trim(), value: l.slice(l.indexOf(':') + 1).trim(), enabled: true }));
  const hasCT = () => req.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type');
  const ctValue = () => (req.headers.find(h => h.enabled && h.key.toLowerCase() === 'content-type') || {}).value || '';
  // body
  const b = rq.body;
  if (isObj(b) && b.mode) {
    if (b.mode === 'raw') {
      req.body = S(b.raw);
      const lang = S(b.options?.raw?.language).toLowerCase();
      if (lang === 'json' || /json/i.test(ctValue())) req.bodyType = 'json';
      else if (!lang || lang === 'text') req.bodyType = 'text';
      else { req.bodyType = 'raw'; if (!hasCT() && CT_FOR[lang]) req.headers.push({ key: 'Content-Type', value: CT_FOR[lang], enabled: true }); }
    } else if (b.mode === 'urlencoded') {
      const rowsIn = Array.isArray(b.urlencoded) ? b.urlencoded.filter(isObj) : [];
      const active = rowsIn.filter(r => !r.disabled && S(r.key));
      if (active.length < rowsIn.length) ctx.warnings.add('Disabled urlencoded body fields were dropped.');
      req.bodyType = 'form'; req.body = active.map(r => `${encodeKeepVars(S(r.key))}=${encodeKeepVars(S(r.value))}`).join('&');
    } else if (b.mode === 'formdata') {
      const rowsIn = Array.isArray(b.formdata) ? b.formdata.filter(isObj) : [];
      const files = rowsIn.filter(r => r.type === 'file');
      if (files.length) ctx.warnings.add(`${files.length} form-data file field${files.length === 1 ? '' : 's'} skipped (file uploads are not supported).`);
      const text = rowsIn.filter(r => r.type !== 'file' && !r.disabled && S(r.key));
      req.bodyType = 'multipart'; req.body = text.map(r => `${S(r.key)}=${S(r.value).replace(/\r?\n/g, ' ')}`).join('\n');
      for (let i = req.headers.length - 1; i >= 0; i--) if (/^content-type$/i.test(req.headers[i].key) && /multipart/i.test(req.headers[i].value)) req.headers.splice(i, 1);
    } else if (b.mode === 'graphql') {
      const g = isObj(b.graphql) ? b.graphql : {};
      let vars = {};
      if (S(g.variables).trim()) { try { vars = JSON.parse(S(g.variables)); } catch { ctx.warnings.add('A GraphQL variables block was not valid JSON and was sent as an empty object.'); } }
      req.bodyType = 'json'; req.body = JSON.stringify({ query: S(g.query), variables: vars }, null, 2);
    } else {
      ctx.warnings.add(`Body mode "${b.mode}" (binary/file) is not supported; the body was skipped.`);
    }
  }
  // auth
  const own = convertAuth(rq.auth, ctx.warnings);
  req.auth = own || inheritedAuth || { type: 'none' };
  // variables in dynamic names
  const m = t => mapVars(t, ctx.unsupportedDyn);
  req.url = m(req.url); req.body = m(req.body);
  req.params = req.params.map(p => ({ ...p, key: m(p.key), value: m(p.value) }));
  req.headers = req.headers.map(h => ({ ...h, key: m(h.key), value: m(h.value) }));
  req.auth = Object.fromEntries(Object.entries(req.auth).map(([k, v]) => [k, typeof v === 'string' ? m(v) : v]));
  ctx.scripts += countScripts(item.event);
  return normalizeRequest(req);
}

/**
 * Import a Postman Collection v2.1 (object or JSON text).
 * -> { ok, collection (store tree node), variables:[{key,value,secret,enabled}], warnings[], stats:{requests,folders,scripts} } | { ok:false, error }
 */
export function importCollection(input, limits = {}) {
  const lim = { ...IMPORT_LIMITS, ...limits };
  const p = parseInput(input, 'collection');
  if (p.error) return fail(p.error);
  const c = p.value;
  if (!isObj(c)) return fail('Not a Postman collection: expected a JSON object.');
  if (Array.isArray(c.values) && (c._postman_variable_scope || c.name)) return fail('This looks like a Postman environment file. Use "Import environment" instead.');
  if (!isObj(c.info)) {
    if (Array.isArray(c.requests) || c.order) return fail('This is a Postman collection v1 file, which is not supported. Re-export it from Postman as "Collection v2.1".');
    return fail('Not a Postman collection: the "info" section is missing.');
  }
  const schema = S(c.info.schema);
  const warnings = new Set();
  if (/collection\/v1/.test(schema)) return fail('Postman collection v1 is not supported. Re-export it from Postman as "Collection v2.1".');
  if (!schema) warnings.add('The collection has no schema URL; assuming Postman v2.1.');
  else if (/v2\.0/.test(schema)) warnings.add('This is a v2.0 collection; it was imported on a best-effort basis.');
  else if (!/v2\.1/.test(schema)) return fail(`Unrecognised collection schema: ${schema}`);
  if (!Array.isArray(c.item)) return fail('Not a valid Postman collection: the "item" list is missing.');

  const ctx = { warnings, scripts: countScripts(c.event), unsupportedDyn: new Set(), requests: 0, folders: 0 };
  const varsOut = [];
  const addVars = list => { for (const v of Array.isArray(list) ? list : []) if (isObj(v) && S(v.key) && varsOut.length < LIMITS.vars) varsOut.push({ key: S(v.key), value: S(v.value), secret: v.type === 'secret', enabled: v.disabled !== true }); };
  addVars(c.variable);
  const rootAuth = convertAuth(c.auth, warnings);

  let tooBig = null;
  const walkItems = (items, inherited, depth) => {
    const out = [];
    for (const it of items) {
      if (tooBig) break;
      if (!isObj(it)) continue;
      const name = S(it.name).trim() || 'Untitled';
      if (Array.isArray(it.item)) {
        if (depth + 1 > lim.depth) { tooBig = `Folders are nested more than ${lim.depth} levels deep.`; break; }
        ctx.folders++; ctx.scripts += countScripts(it.event); addVars(it.variable);
        const a = convertAuth(it.auth, warnings) || inherited;
        out.push({ type: 'folder', id: uid(), name, items: walkItems(it.item, a, depth + 1) });
      } else if (it.request !== undefined) {
        if (++ctx.requests > lim.requests) { tooBig = `The collection has more than ${lim.requests} requests (too large to import safely).`; break; }
        out.push({ type: 'request', id: uid(), name, request: convertRequest(it, inherited, ctx) });
      }
    }
    return out;
  };
  const items = walkItems(c.item, rootAuth, 1);
  if (tooBig) return fail(tooBig);
  const { tree } = normalizeTree([{ type: 'collection', id: uid(), name: S(c.info.name).trim() || 'Imported collection', items }]);
  if (!tree.length) return fail('The collection could not be imported.');
  if (ctx.scripts) warnings.add(`${ctx.scripts} pre-request/test script${ctx.scripts === 1 ? '' : 's'} skipped — scripting is not supported (it cannot be sandboxed safely). Use {{variables}} and dynamic variables instead.`);
  if (ctx.unsupportedDyn.size) warnings.add(`Unsupported dynamic variables left as-is: ${[...ctx.unsupportedDyn].join(', ')}. Supported: {{$uuid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}.`);
  return ok({ collection: tree[0], variables: varsOut, warnings: [...warnings], stats: { requests: ctx.requests, folders: ctx.folders, scripts: ctx.scripts } });
}

/** Import a Postman environment (or globals) file -> { ok, environment:{name, vars}, isGlobals, warnings } */
export function importEnvironment(input) {
  const p = parseInput(input, 'environment');
  if (p.error) return fail(p.error);
  const e = p.value;
  if (!isObj(e)) return fail('Not a Postman environment: expected a JSON object.');
  if (isObj(e.info) && Array.isArray(e.item)) return fail('This is a collection, not an environment. Use "Import Postman" for collections.');
  if (!Array.isArray(e.values)) return fail('Not a Postman environment: the "values" list is missing.');
  const warnings = [];
  if (e.values.length > LIMITS.vars) warnings.push(`Only the first ${LIMITS.vars} variables were imported.`);
  const vars = e.values.filter(v => isObj(v) && S(v.key)).slice(0, LIMITS.vars).map(v => ({ key: S(v.key), value: S(v.value), secret: v.type === 'secret', enabled: v.enabled !== false }));
  const dyn = new Set();
  for (const v of vars) v.value = mapVars(v.value, dyn);
  if (vars.some(v => v.secret && v.value === '')) warnings.push('Secret variables are empty in Postman exports; fill them in manually.');
  return ok({ environment: { name: S(e.name).trim() || 'Imported environment', vars }, isGlobals: e._postman_variable_scope === 'globals', warnings });
}

// ---------- export ----------
function splitForExport(raw) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(raw);
  let protocol, hostport, path;
  if (m) { protocol = m[1]; hostport = m[2]; path = m[3]; }
  else { const mm = /^([^/?#]*)([^?#]*)/.exec(raw); hostport = mm[1]; path = mm[2]; }
  const pm = /^(.*):(\d+)$/.exec(hostport);
  const host = (pm ? pm[1] : hostport).split('.').filter(Boolean);
  const out = { raw };
  if (protocol) out.protocol = protocol;
  out.host = host;
  if (pm) out.port = pm[2];
  out.path = path.split('/').filter(Boolean);
  return out;
}
const kv = (key, value, type = 'string') => ({ key, value, type });

function exportAuth(a) {
  const n = normalizeAuth(a);
  if (n.type === 'none') return undefined;
  if (n.type === 'bearer' && (n.prefix || 'Bearer') === 'Bearer') return { type: 'bearer', bearer: [kv('token', n.token)] };
  if (n.type === 'bearer') return { type: 'apikey', apikey: [kv('key', 'Authorization'), kv('value', `${n.prefix} ${n.token}`), kv('in', 'header')] };
  if (n.type === 'basic') return { type: 'basic', basic: [kv('username', n.username), kv('password', n.password)] };
  if (n.type === 'apikey') return { type: 'apikey', apikey: [kv('key', n.name), kv('value', n.value), kv('in', n.in)] };
  return { type: 'apikey', apikey: [kv('key', 'Authorization'), kv('value', `${n.prefix ? n.prefix + ' ' : ''}${n.credential}`), kv('in', 'header')] };
}
const AUTH_FIELDS = ['token', 'password', 'value', 'credential'];

function exportRequest(r, { includeSecrets }) {
  const rq = normalizeRequest(r);
  const auth = includeSecrets ? rq.auth : { ...rq.auth, ...Object.fromEntries(AUTH_FIELDS.filter(f => typeof rq.auth[f] === 'string' && !/^\s*(?:\w+\s+)?(?:\{\{[^{}]+\}\}\s*)+$/.test(rq.auth[f])).map(f => [f, ''])) };
  const url = splitForExport(splitUrl(rq.url).base + splitUrl(rq.url).hash);
  url.raw = rq.url;
  const q = rq.params.filter(p => p.key || p.value);
  if (q.length) url.query = q.map(p => ({ key: p.key, value: p.value, ...(p.enabled ? {} : { disabled: true }) }));
  const out = { method: rq.method, header: rq.headers.filter(h => h.key).map(h => ({ key: h.key, value: h.value, type: 'text', ...(h.enabled ? {} : { disabled: true }) })), url };
  if (rq.body !== '') {
    if (rq.bodyType === 'form') {
      const parts = /[\r\n]/.test(rq.body.trim()) ? rq.body.split(/\r?\n/).filter(Boolean).map(l => { const i = l.indexOf('='); return [i < 0 ? l : l.slice(0, i), i < 0 ? '' : l.slice(i + 1)]; })
        : rq.body.split('&').filter(Boolean).map(l => { const i = l.indexOf('='); const d = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } }; return [d(i < 0 ? l : l.slice(0, i)), d(i < 0 ? '' : l.slice(i + 1))]; });
      out.body = { mode: 'urlencoded', urlencoded: parts.map(([k, v]) => ({ key: k, value: v, type: 'text' })) };
    } else if (rq.bodyType === 'multipart') {
      out.body = { mode: 'formdata', formdata: parseFormLines(rq.body).map(([k, v]) => ({ key: k, value: v, type: 'text' })) };
    } else {
      out.body = { mode: 'raw', raw: rq.body, options: { raw: { language: rq.bodyType === 'json' ? 'json' : 'text' } } };
    }
  }
  const a = exportAuth(auth);
  if (a) out.auth = a;
  return out;
}

function exportItems(items, opts) {
  return items.map(n => (n.type === 'request' ? { name: n.name, request: exportRequest(n.request, opts), response: [] } : { name: n.name, item: exportItems(n.items, opts) }));
}

/**
 * Export a store collection node to a Postman v2.1 object. Secrets in auth are blanked unless includeSecrets.
 * opts.variables: [{key,value,secret}] added as collection variables (secret values blanked unless includeSecrets).
 */
export function exportCollection(node, { includeSecrets = false, variables = [] } = {}) {
  if (!node || node.type !== 'collection') throw new Error('exportCollection expects a collection node');
  const out = {
    info: { _postman_id: uid(), name: node.name, schema: POSTMAN_SCHEMA },
    item: exportItems(node.items, { includeSecrets }),
  };
  const vars = variables.filter(v => v.key && v.enabled !== false).map(v => ({ key: v.key, value: v.secret && !includeSecrets ? '' : v.value, type: 'default', ...(v.secret ? { type: 'secret' } : {}) }));
  if (vars.length) out.variable = vars;
  return out;
}

/** Export one environment as a Postman environment file. */
export function exportEnvironment(env, { includeSecrets = false } = {}) {
  return {
    id: uid(), name: env.name,
    values: env.vars.filter(v => v.key).map(v => ({ key: v.key, value: v.secret && !includeSecrets ? '' : v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled !== false })),
    _postman_variable_scope: 'environment', _postman_exported_using: 'Developer Toolbox',
  };
}
