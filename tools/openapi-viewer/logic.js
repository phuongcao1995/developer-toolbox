// Pure OpenAPI / Swagger logic (no DOM): parsing, local $ref resolution, normalisation, schema trees, example payloads,
// lint, usage analysis, Markdown + standalone-HTML export. Remote $refs are never fetched. YAML parsing uses an injected js-yaml.

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
export const LIMITS = { maxDepth: 12, maxTreeNodes: 4000, maxExampleDepth: 8 };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const entries = o => (isObj(o) ? Object.keys(o).map(k => [k, o[k]]) : []);

// ---------------------------------------------------------------- parsing
export function jsonErrorOffset(text) {
  let i = 0; const n = text.length;
  const ws = () => { while (i < n && ' \t\r\n'.includes(text[i])) i++; };
  const bad = () => { throw i; };
  const str = () => {
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c < ' ') bad();
      if (c === '\\') { i++; const e = text[i]; if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) bad(); i += 5; continue; } if (!'"\\/bfnrt'.includes(e || '')) bad(); }
      i++;
    }
    bad();
  };
  const value = d => {
    if (d > 1500) bad();
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws(); if (text[i] === '}') { i++; return; }
      for (;;) { ws(); if (text[i] !== '"') bad(); str(); ws(); if (text[i] !== ':') bad(); i++; value(d + 1); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return; } bad(); }
    } else if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(d + 1); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return; } bad(); }
    } else if (c === '"') str();
    else { const m = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(text.slice(i, i + 400)); if (!m) bad(); i += m[0].length; }
  };
  try { value(0); ws(); return i < n ? i : -1; } catch (e) { return typeof e === 'number' ? e : 0; }
}
function lineCol(text, offset) {
  let line = 1, last = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i + 1; }
  return { line, column: offset - last + 1 };
}

/** Parse JSON or YAML text. `yaml` is js-yaml (required for YAML input). -> { ok, spec, format } | { ok:false, error:{message,line,column} } */
export function parseSpec(text, yaml) {
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!src.trim()) return { ok: false, error: { message: 'The input is empty. Paste an OpenAPI or Swagger document.', line: 1, column: 1 } };
  if (/^\s*[{[]/.test(src)) {
    try { return finish(JSON.parse(src), 'json'); } catch (e) {
      const m = /position (\d+)/.exec(e.message); const off = m ? Number(m[1]) : jsonErrorOffset(src);
      return { ok: false, error: { message: `Invalid JSON: ${e.message.split('\n')[0].slice(0, 160)}`, ...lineCol(src, Math.max(0, off)) } };
    }
  }
  if (!yaml) return { ok: false, error: { message: 'The YAML parser is not available.', line: 1, column: 1 } };
  try { return finish(yaml.load(src, { schema: yaml.DEFAULT_SCHEMA }), 'yaml'); } catch (e) {
    return { ok: false, error: { message: `Invalid YAML: ${e.reason || e.message}`, line: e.mark ? e.mark.line + 1 : 1, column: e.mark ? e.mark.column + 1 : 1 } };
  }
  function finish(spec, format) {
    if (!isObj(spec)) return { ok: false, error: { message: 'The document is not an object (expected an OpenAPI/Swagger document).', line: 1, column: 1 } };
    const v = detectVersion(spec);
    if (!v.kind) return { ok: false, error: { message: 'This does not look like an OpenAPI or Swagger document: the top-level "openapi" or "swagger" version field is missing.', line: 1, column: 1 } };
    return { ok: true, spec, format, ...v };
  }
}
export function detectVersion(spec) {
  if (isObj(spec) && typeof spec.swagger === 'string' && /^2\./.test(spec.swagger)) return { kind: 'swagger2', version: spec.swagger };
  if (isObj(spec) && typeof spec.openapi === 'string' && /^3\.\d/.test(spec.openapi)) return { kind: 'openapi3', version: spec.openapi };
  if (isObj(spec) && (spec.swagger || spec.openapi)) return { kind: null, version: String(spec.swagger || spec.openapi) };
  return { kind: null, version: null };
}

// ---------------------------------------------------------------- $ref resolution (local only)
export function decodePointerSegment(s) { let d = s; try { d = decodeURIComponent(s); } catch { /* keep */ } return d.replace(/~1/g, '/').replace(/~0/g, '~'); }
export function encodePointerSegment(s) { return String(s).replace(/~/g, '~0').replace(/\//g, '~1'); }
export function resolvePointer(root, ref) {
  if (typeof ref !== 'string') return { ok: false, error: 'invalid $ref' };
  if (!ref.startsWith('#')) return { ok: false, remote: true, error: 'remote reference (not fetched)' };
  if (ref === '#') return { ok: true, value: root };
  if (!ref.startsWith('#/')) return { ok: false, error: 'unsupported reference syntax' };
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    const seg = decodePointerSegment(raw);
    if (cur !== null && typeof cur === 'object' && hasOwn(cur, seg)) cur = cur[seg];
    else return { ok: false, error: 'target not found' };
  }
  return { ok: true, value: cur };
}
export const refName = ref => decodePointerSegment(String(ref).split('/').pop() || ref);

/** Follow $ref chains. -> { value, ref, error?, unresolved? }; sibling keywords next to $ref are merged over the target. */
export function deref(root, node) {
  const seen = new Set(); let cur = node, first = null;
  while (isObj(cur) && typeof cur.$ref === 'string') {
    const r = cur.$ref;
    if (seen.has(r) || seen.size > 20) return { value: null, ref: r, error: 'circular reference chain', unresolved: true };
    seen.add(r);
    const res = resolvePointer(root, r);
    if (!res.ok) return { value: null, ref: r, error: res.error, unresolved: true, remote: !!res.remote };
    first ??= r;
    const sib = { ...cur }; delete sib.$ref;
    cur = Object.keys(sib).length && isObj(res.value) ? { ...res.value, ...sib } : res.value;
  }
  return { value: cur, ref: first };
}

// ---------------------------------------------------------------- schema trees
const CONSTRAINTS = [['minimum', 'min'], ['maximum', 'max'], ['exclusiveMinimum', 'exclusive min'], ['exclusiveMaximum', 'exclusive max'], ['multipleOf', 'multiple of'],
  ['minLength', 'min length'], ['maxLength', 'max length'], ['pattern', 'pattern'], ['minItems', 'min items'], ['maxItems', 'max items'], ['uniqueItems', 'unique items'],
  ['minProperties', 'min properties'], ['maxProperties', 'max properties']];

function inferType(s) {
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) return s.type.filter(t => t !== 'null')[0] || 'null';
  if (s.properties || s.additionalProperties !== undefined) return 'object';
  if (s.items || s.prefixItems) return 'array';
  if (s.enum) return undefined;
  return undefined;
}

/**
 * Build a display tree for a schema. Node: { name, required, ref, type, format, nullable, description, enum, default, example, constraints[],
 * properties:[node], items, additional, variants:{kind,list,discriminator}, circular, unresolved, truncated, readOnly, writeOnly, deprecated }.
 * allOf is merged into one node (properties and required combined); oneOf/anyOf become variants.
 */
export function buildSchemaTree(root, schema, opts = {}) {
  const o = { maxDepth: LIMITS.maxDepth, maxNodes: LIMITS.maxTreeNodes, ...opts };
  const st = { count: 0, refs: [], objs: [] };
  return tree(root, schema, opts.name, !!opts.required, st, 0, o);
}

function tree(root, schema, name, required, st, depth, o) {
  const node = { name, required };
  if (st.count++ > o.maxNodes) { node.truncated = true; node.type = 'object'; return node; }
  const d = deref(root, schema);
  if (d.ref) node.ref = refName(d.ref);
  if (d.unresolved) { node.unresolved = d.error; node.refFull = d.ref; node.type = refName(d.ref); return node; }
  const s = d.value;
  if (s === true || s === undefined || s === null) { node.type = 'any'; return node; }
  if (s === false) { node.type = 'never'; return node; }
  if (!isObj(s)) { node.type = 'any'; return node; }
  if ((d.ref && st.refs.includes(d.ref)) || st.objs.includes(s)) { node.circular = true; node.type = inferType(s) || 'object'; return node; }
  if (depth >= o.maxDepth) { node.truncated = true; node.type = inferType(s) || 'object'; return node; }
  st.refs.push(d.ref || null); st.objs.push(s);
  try { fill(root, node, s, st, depth, o); } finally { st.refs.pop(); st.objs.pop(); }
  return node;
}

function fill(root, node, s, st, depth, o) {
  const t = inferType(s);
  node.type = t;
  node.nullable = s.nullable === true || s['x-nullable'] === true || (Array.isArray(s.type) && s.type.includes('null'));
  if (typeof s.format === 'string') node.format = s.format;
  if (typeof s.title === 'string') node.title = s.title;
  if (typeof s.description === 'string') node.description = s.description;
  if (Array.isArray(s.enum)) node.enum = s.enum;
  if (hasOwn(s, 'const')) { node.const = s.const; node.enum ??= [s.const]; }
  if (hasOwn(s, 'default')) node.default = s.default;
  if (hasOwn(s, 'example')) node.example = s.example; else if (Array.isArray(s.examples) && s.examples.length) node.example = s.examples[0];
  if (s.readOnly) node.readOnly = true; if (s.writeOnly) node.writeOnly = true; if (s.deprecated) node.deprecated = true;
  node.constraints = CONSTRAINTS.filter(([k]) => hasOwn(s, k) && s[k] !== undefined).map(([k, label]) => `${label}: ${typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k])}`);
  const req = new Set(Array.isArray(s.required) ? s.required.filter(x => typeof x === 'string') : []);
  const props = new Map();
  const addProps = (obj, reqSet) => { for (const [k, v] of entries(obj)) props.set(k, tree(root, v, k, reqSet.has(k), st, depth + 1, o)); };
  addProps(s.properties, req);
  if (Array.isArray(s.allOf)) {
    node.merged = [];
    for (const sub of s.allOf) {
      const sn = tree(root, sub, undefined, false, st, depth + 1, o);
      node.merged.push(sn.ref || sn.type || 'schema');
      if (sn.unresolved || sn.circular) { node.mergeIssues = [...(node.mergeIssues || []), sn.ref || 'schema']; continue; }
      for (const p of sn.properties || []) { const had = props.get(p.name); props.set(p.name, had ? { ...p, required: p.required || had.required } : p); }
      for (const p of props.values()) if (sn.requiredNames?.includes(p.name)) p.required = true;
      node.requiredNames = [...new Set([...(node.requiredNames || []), ...(sn.requiredNames || [])])];
      if (!node.type && sn.type) node.type = sn.type;
      if (!node.description && sn.description) node.description = sn.description;
      if (sn.items && !node.items) node.items = sn.items;
      if (sn.variants && !node.variants) node.variants = sn.variants;
      if (sn.enum && !node.enum) node.enum = sn.enum;
      if (sn.nullable) node.nullable = true;
      if (sn.additional !== undefined && node.additional === undefined) node.additional = sn.additional;
      if (sn.constraints?.length) node.constraints = [...new Set([...node.constraints, ...sn.constraints])];
    }
    if (!node.type && props.size) node.type = 'object';
  }
  node.requiredNames = [...new Set([...(node.requiredNames || []), ...req])];
  for (const p of props.values()) if (node.requiredNames.includes(p.name)) p.required = true;
  if (props.size) node.properties = [...props.values()];
  if (s.items !== undefined && !node.items) node.items = tree(root, Array.isArray(s.items) ? s.items[0] : s.items, undefined, false, st, depth + 1, o);
  if (Array.isArray(s.prefixItems) && !node.items) node.items = tree(root, s.prefixItems[0], undefined, false, st, depth + 1, o);
  if (s.additionalProperties !== undefined) node.additional = isObj(s.additionalProperties) ? tree(root, s.additionalProperties, undefined, false, st, depth + 1, o) : s.additionalProperties;
  for (const kind of ['oneOf', 'anyOf']) {
    if (Array.isArray(s[kind]) && !node.variants) {
      node.variants = { kind, list: s[kind].map(v => tree(root, v, undefined, false, st, depth + 1, o)) };
      if (isObj(s.discriminator) && typeof s.discriminator.propertyName === 'string') node.variants.discriminator = s.discriminator.propertyName;
    }
  }
  if (!node.type && node.variants) node.type = undefined;
}

export function typeLabel(n) {
  if (!n) return 'any';
  if (n.unresolved) return `${n.type} (unresolved)`;
  let base;
  if (n.type === 'array') base = `${n.items ? typeLabel(n.items) : 'any'}[]`;
  else if (n.variants && !n.type) base = n.variants.list.map(typeLabel).join(' | ');
  else if (n.ref && (n.type === 'object' || !n.type)) base = n.ref;
  else base = n.type || (n.enum ? 'enum' : 'any');
  if (n.format && n.type !== 'array') base += ` <${n.format}>`;
  if (n.nullable) base += ' | null';
  return base;
}

/** Flatten a tree into rows [{path, type, required, description, notes}] (depth-limited) for tables / Markdown. */
export function flattenSchema(node, maxDepth = 6) {
  const rows = [];
  const walk = (n, path, depth) => {
    if (!n || depth > maxDepth) return;
    const notes = [];
    if (n.enum) notes.push(`enum: ${n.enum.map(v => JSON.stringify(v)).join(', ')}`);
    if (n.default !== undefined) notes.push(`default: ${JSON.stringify(n.default)}`);
    if (n.constraints?.length) notes.push(...n.constraints);
    if (n.readOnly) notes.push('read-only'); if (n.writeOnly) notes.push('write-only'); if (n.deprecated) notes.push('deprecated');
    if (n.circular) notes.push('recursive reference');
    if (path !== '') rows.push({ path, type: typeLabel(n), required: !!n.required, description: n.description || '', notes });
    else if (!n.properties && !n.items) rows.push({ path: '(value)', type: typeLabel(n), required: false, description: n.description || '', notes });
    if (n.circular || n.unresolved) return;
    for (const p of n.properties || []) walk(p, path ? `${path}.${p.name}` : p.name, depth + 1);
    if (n.items && (n.items.properties || n.items.items)) walk(n.items, `${path || '(items)'}[]`, depth + 1);
    if (n.variants) n.variants.list.forEach((v, i) => { rows.push({ path: `${path || '(value)'} ⟨${n.variants.kind} #${i + 1}⟩`, type: typeLabel(v), required: false, description: v.description || '', notes: [] }); for (const p of v.properties || []) walk(p, `${path || ''}${path ? '.' : ''}${p.name}`, depth + 2); });
  };
  walk(node, '', 0);
  return rows;
}

// ---------------------------------------------------------------- example payloads
const FORMAT_EXAMPLES = {
  'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', time: '00:00:00Z', email: 'user@example.com', uuid: '00000000-0000-4000-8000-000000000000',
  uri: 'https://example.com', url: 'https://example.com', 'uri-reference': '/path', hostname: 'example.com', ipv4: '192.0.2.1', ipv6: '2001:db8::1',
  byte: 'ZXhhbXBsZQ==', binary: '<binary>', password: '********', int32: 0, int64: 0, float: 0, double: 0, duration: 'P1D', regex: '^[a-z]+$',
};
/** Deterministic example value for a schema: example > default > enum[0] > const > generated from type/format. */
export function exampleFor(root, schema, depth = 0, stack = []) {
  if (depth > LIMITS.maxExampleDepth) return null;
  const d = deref(root, schema);
  if (d.unresolved) return null;
  const s = d.value;
  if (!isObj(s)) return s === true || s === undefined ? {} : null;
  if (d.ref && stack.includes(d.ref)) return null;
  if (stack.includes(s)) return null;
  const next = [...stack, d.ref || s];
  if (hasOwn(s, 'example')) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (hasOwn(s, 'default')) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (hasOwn(s, 'const')) return s.const;
  if (Array.isArray(s.allOf)) {
    let merged = {}, any = false, scalar;
    for (const sub of [{ ...s, allOf: undefined }, ...s.allOf]) {
      const v = exampleFor(root, sub, depth + 1, next);
      if (isObj(v)) { merged = { ...merged, ...v }; any = true; } else if (v !== null && v !== undefined && !any) scalar = v;
    }
    return any ? merged : scalar ?? null;
  }
  for (const k of ['oneOf', 'anyOf']) if (Array.isArray(s[k]) && s[k].length) return exampleFor(root, s[k][0], depth + 1, next);
  const t = inferType(s);
  switch (t) {
    case 'object': {
      const out = {};
      for (const [k, v] of entries(s.properties)) { const ev = exampleFor(root, v, depth + 1, next); out[k] = ev; }
      if (!Object.keys(out).length && isObj(s.additionalProperties)) out.key = exampleFor(root, s.additionalProperties, depth + 1, next);
      return out;
    }
    case 'array': {
      const item = s.items !== undefined ? exampleFor(root, Array.isArray(s.items) ? s.items[0] : s.items, depth + 1, next) : null;
      return item === null && s.items === undefined ? [] : [item];
    }
    case 'integer': case 'number': {
      let v = typeof FORMAT_EXAMPLES[s.format] === 'number' ? FORMAT_EXAMPLES[s.format] : 0;
      const lo = typeof s.minimum === 'number' ? s.minimum + (s.exclusiveMinimum === true ? 1 : 0) : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : null;
      const hi = typeof s.maximum === 'number' ? s.maximum : null;
      if (lo !== null && v < lo) v = lo; if (hi !== null && v > hi) v = hi;
      return v;
    }
    case 'boolean': return true;
    case 'null': return null;
    case 'string': {
      let v = typeof FORMAT_EXAMPLES[s.format] === 'string' ? FORMAT_EXAMPLES[s.format] : 'string';
      if (typeof s.minLength === 'number' && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) v = v.slice(0, s.maxLength);
      return v;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- normalisation
function mimeContent(root, content) {
  return entries(content).map(([mime, m]) => {
    const media = deref(root, m).value;
    const mm = isObj(media) ? media : {};
    const examples = entries(mm.examples).map(([n, e]) => { const ex = deref(root, e).value; return { name: n, summary: isObj(ex) ? ex.summary : undefined, value: isObj(ex) ? ex.value : undefined }; }).filter(e => e.value !== undefined);
    return { mime, schema: mm.schema, example: hasOwn(mm, 'example') ? mm.example : examples[0]?.value, hasExample: hasOwn(mm, 'example') || examples.length > 0, examples };
  });
}
function paramSchema(p) {
  if (p.schema) return p.schema;
  const s = {};
  for (const k of ['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'collectionFormat', 'minItems', 'maxItems']) if (hasOwn(p, k)) s[k] = p[k];
  return s;
}
function normParam(root, raw) {
  const d = deref(root, raw);
  if (d.unresolved || !isObj(d.value)) return { name: refName(d.ref || 'parameter'), in: '?', required: false, unresolved: d.error || 'invalid parameter', schema: {}, ref: d.ref };
  const p = d.value;
  const schema = paramSchema(p);
  const tn = buildSchemaTree(root, schema);
  return { name: String(p.name ?? ''), in: String(p.in ?? ''), required: p.required === true || p.in === 'path', description: p.description || '', deprecated: p.deprecated === true,
    schema, type: typeLabel(tn), default: schema.default, enum: schema.enum, example: hasOwn(p, 'example') ? p.example : undefined, style: p.style, explode: p.explode, ref: d.ref ? refName(d.ref) : undefined, allowEmptyValue: p.allowEmptyValue };
}
function normSecurity(list) {
  if (!Array.isArray(list)) return null;
  return list.map(req => entries(req).map(([name, scopes]) => ({ name, scopes: Array.isArray(scopes) ? scopes : [] })));
}

function normOp(root, kind, method, path, item, op, model) {
  const swagger = model.kind === 'swagger2';
  const params = new Map();
  for (const raw of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
    const p = normParam(root, raw); params.set(`${p.in}:${p.name}`, p);
  }
  let parameters = [...params.values()], requestBody = null;
  if (swagger) {
    const consumes = op.consumes || root.consumes || ['application/json'];
    const body = parameters.find(p => p.in === 'body'); const form = parameters.filter(p => p.in === 'formData');
    const rawBody = (Array.isArray(op.parameters) ? op.parameters : []).concat(Array.isArray(item.parameters) ? item.parameters : []).map(r => deref(root, r).value).find(p => isObj(p) && p.in === 'body');
    if (body && rawBody) requestBody = { description: rawBody.description || '', required: rawBody.required === true, content: consumes.map(mime => ({ mime, schema: rawBody.schema, examples: [], hasExample: false })) };
    else if (form.length) {
      const schema = { type: 'object', properties: Object.fromEntries(form.map(f => [f.name, { ...f.schema, description: f.description }])), required: form.filter(f => f.required).map(f => f.name) };
      requestBody = { description: '', required: form.some(f => f.required), content: [{ mime: consumes.find(m => /form|multipart/.test(m)) || 'application/x-www-form-urlencoded', schema, examples: [], hasExample: false }] };
    }
    parameters = parameters.filter(p => p.in !== 'body' && p.in !== 'formData');
  } else if (op.requestBody) {
    const d = deref(root, op.requestBody);
    if (d.unresolved || !isObj(d.value)) requestBody = { description: '', required: false, content: [], unresolved: d.error };
    else requestBody = { description: d.value.description || '', required: d.value.required === true, content: mimeContent(root, d.value.content), ref: d.ref ? refName(d.ref) : undefined };
  }
  const produces = op.produces || root.produces || ['application/json'];
  const responses = entries(op.responses).map(([code, raw]) => {
    const d = deref(root, raw);
    if (d.unresolved || !isObj(d.value)) return { code: String(code), description: '', content: [], headers: [], unresolved: d.error };
    const r = d.value;
    let content;
    if (swagger) content = r.schema ? produces.map(mime => ({ mime, schema: r.schema, example: r.examples?.[mime], hasExample: !!(r.examples && hasOwn(r.examples, mime)), examples: [] })) : [];
    else content = mimeContent(root, r.content);
    const headers = entries(r.headers).map(([name, h]) => { const hh = deref(root, h).value || {}; const sch = hh.schema || paramSchema(hh); return { name, description: hh.description || '', type: typeLabel(buildSchemaTree(root, sch)) }; });
    return { code: String(code), description: r.description || '', content, headers, ref: d.ref ? refName(d.ref) : undefined };
  });
  const secRaw = hasOwn(op, 'security') ? op.security : root.security;
  return {
    key: `${kind === 'webhook' ? 'webhook' : method}:${path}`, kind, method: method.toUpperCase(), path, operationId: typeof op.operationId === 'string' ? op.operationId : '',
    summary: op.summary || '', description: op.description || '', tags: Array.isArray(op.tags) ? op.tags.map(String) : [], deprecated: op.deprecated === true,
    parameters, requestBody, responses, security: normSecurity(secRaw), securityInherited: !hasOwn(op, 'security'), externalDocs: op.externalDocs, servers: Array.isArray(op.servers) ? op.servers : null,
  };
}

function schemeDetails(s) {
  if (!isObj(s)) return {};
  const out = { type: s.type, description: s.description || '' };
  if (s.type === 'apiKey') { out.in = s.in; out.keyName = s.name; }
  if (s.type === 'http') { out.scheme = s.scheme; out.bearerFormat = s.bearerFormat; }
  if (s.type === 'basic') { out.type = 'http'; out.scheme = 'basic'; }
  if (s.type === 'openIdConnect') out.url = s.openIdConnectUrl;
  if (s.type === 'oauth2') {
    out.flows = s.flows ? entries(s.flows).map(([n, f]) => ({ name: n, authorizationUrl: f.authorizationUrl, tokenUrl: f.tokenUrl, refreshUrl: f.refreshUrl, scopes: entries(f.scopes).map(([k, v]) => ({ name: k, description: v })) }))
      : [{ name: s.flow, authorizationUrl: s.authorizationUrl, tokenUrl: s.tokenUrl, scopes: entries(s.scopes).map(([k, v]) => ({ name: k, description: v })) }];
  }
  return out;
}

/** Normalise a parsed spec into a flat, UI-friendly model. */
export function normalize(spec) {
  const v = detectVersion(spec);
  if (!v.kind) throw new Error('Unsupported document: expected "openapi: 3.x" or "swagger: 2.0".');
  const model = { kind: v.kind, version: v.version, spec };
  const info = isObj(spec.info) ? spec.info : {};
  model.info = { title: info.title || '(untitled)', version: info.version || '', summary: info.summary || '', description: info.description || '', termsOfService: info.termsOfService, contact: info.contact, license: info.license };
  if (v.kind === 'swagger2') {
    const schemes = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes : ['https'];
    model.servers = spec.host ? schemes.map(s => ({ url: `${s}://${spec.host}${spec.basePath || ''}`, description: '' })) : [{ url: spec.basePath || '/', description: 'Relative to the host that serves the document' }];
  } else model.servers = (Array.isArray(spec.servers) ? spec.servers : []).filter(isObj).map(s => ({ url: String(s.url ?? ''), description: s.description || '', variables: entries(s.variables).map(([k, x]) => ({ name: k, default: x?.default, enum: x?.enum, description: x?.description })) }));
  const schemesRaw = v.kind === 'swagger2' ? spec.securityDefinitions : spec.components?.securitySchemes;
  model.securitySchemes = entries(schemesRaw).map(([name, s]) => ({ name, ...schemeDetails(deref(spec, s).value) }));
  model.security = normSecurity(spec.security) || [];
  model.tags = (Array.isArray(spec.tags) ? spec.tags : []).filter(isObj).map(t => ({ name: String(t.name), description: t.description || '' }));
  model.operations = []; model.webhooks = [];
  for (const [path, rawItem] of entries(spec.paths)) {
    const d = deref(spec, rawItem); const item = isObj(d.value) ? d.value : {};
    for (const m of METHODS) if (isObj(item[m])) model.operations.push(normOp(spec, 'path', m, path, item, item[m], model));
  }
  for (const [name, rawItem] of entries(spec.webhooks)) {
    const d = deref(spec, rawItem); const item = isObj(d.value) ? d.value : {};
    for (const m of METHODS) if (isObj(item[m])) model.webhooks.push(normOp(spec, 'webhook', m, name, item, item[m], model));
  }
  const defs = v.kind === 'swagger2' ? spec.definitions : spec.components?.schemas;
  model.schemas = entries(defs).map(([name, schema]) => ({ name, schema, pointer: `#/${v.kind === 'swagger2' ? 'definitions' : 'components/schemas'}/${encodePointerSegment(name)}` }));
  model.externalDocs = spec.externalDocs;
  const tagSet = new Set(); for (const op of [...model.operations, ...model.webhooks]) for (const t of op.tags) tagSet.add(t);
  model.stats = { operations: model.operations.length, webhooks: model.webhooks.length, paths: Object.keys(isObj(spec.paths) ? spec.paths : {}).length, schemas: model.schemas.length, tags: new Set([...model.tags.map(t => t.name), ...tagSet]).size, securitySchemes: model.securitySchemes.length };
  return model;
}

/** Operations grouped by tag in declared-tag order ('' => "default"). -> [{ name, description, ops }] */
export function groupByTag(model, ops = model.operations) {
  const groups = new Map();
  for (const t of model.tags) groups.set(t.name, { name: t.name, description: t.description, ops: [] });
  for (const op of ops) {
    const names = op.tags.length ? op.tags : ['default'];
    for (const n of names) { if (!groups.has(n)) groups.set(n, { name: n, description: '', ops: [] }); groups.get(n).ops.push(op); }
  }
  return [...groups.values()].filter(g => g.ops.length);
}

/** Filter operations: query matches path, method, summary, operationId, tags; options { methods:Set, tag, deprecated }. */
export function filterOperations(ops, query = '', { methods, tag, deprecated } = {}) {
  const q = String(query).trim().toLowerCase();
  return ops.filter(op => {
    if (methods && methods.size && !methods.has(op.method)) return false;
    if (tag && !(op.tags.length ? op.tags : ['default']).includes(tag)) return false;
    if (deprecated && !op.deprecated) return false;
    if (!q) return true;
    return op.path.toLowerCase().includes(q) || op.method.toLowerCase().includes(q) || op.summary.toLowerCase().includes(q) || op.operationId.toLowerCase().includes(q) || op.tags.some(t => t.toLowerCase().includes(q)) || (op.method.toLowerCase() + ' ' + op.path.toLowerCase()).includes(q);
  });
}

// ---------------------------------------------------------------- reference walking, usage, lint
const SKIP_KEYS = new Set(['example', 'default', 'enum', 'const', 'x-examples']);
/** All $ref strings in a node (iterative; skips example/default data). -> [{ ref, path:[...] }] */
export function collectRefs(node, basePath = []) {
  const out = []; const stack = [{ n: node, k: null, p: null }];
  const pathOf = e => { const a = []; for (let x = e; x && x.k !== null; x = x.p) a.push(x.k); return [...basePath, ...a.reverse()]; };
  while (stack.length) {
    const e = stack.pop(); const n = e.n;
    if (n === null || typeof n !== 'object') continue;
    if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) if (n[i] !== null && typeof n[i] === 'object') stack.push({ n: n[i], k: i, p: e }); continue; }
    if (typeof n.$ref === 'string') out.push({ ref: n.$ref, path: pathOf(e) });
    for (const k of Object.keys(n)) {
      if (SKIP_KEYS.has(k) || k === '$ref') continue;
      const v = n[k]; if (v === null || typeof v !== 'object') continue;
      if (k === 'value' && e.p && e.p.k === 'examples' && !(e.p.p && e.p.p.k === 'properties')) continue;
      stack.push({ n: v, k, p: e });
    }
  }
  return out;
}
const schemaOfRef = ref => { const m = /^#\/(?:components\/schemas|definitions)\/([^/]+)/.exec(ref); return m ? decodePointerSegment(m[1]) : null; };

/** schemaName -> sorted list of referrers ("schema Pet", "GET /pets", "components/parameters/X"). */
export function computeUsage(spec) {
  const usage = new Map(); const add = (name, who) => { if (!usage.has(name)) usage.set(name, new Set()); usage.get(name).add(who); };
  const scan = (node, who, self) => { for (const { ref } of collectRefs(node)) { const s = schemaOfRef(ref); if (s && s !== self) add(s, who); } };
  const swagger = isObj(spec) && !!spec.swagger;
  for (const [n, s] of entries(swagger ? spec.definitions : spec.components?.schemas)) scan(s, `schema ${n}`, n);
  if (swagger) { for (const g of ['parameters', 'responses']) for (const [n, v] of entries(spec[g])) scan(v, `${g}/${n}`, null); }
  else for (const g of ['parameters', 'responses', 'requestBodies', 'headers', 'examples', 'callbacks', 'pathItems']) for (const [n, v] of entries(spec.components?.[g])) scan(v, `components/${g}/${n}`, null);
  for (const grp of ['paths', 'webhooks']) {
    for (const [p, item] of entries(spec[grp])) {
      if (!isObj(item)) continue;
      scan(item.parameters, `${p} (path parameters)`, null);
      for (const m of METHODS) if (isObj(item[m])) scan(item[m], `${m.toUpperCase()} ${p}`, null);
    }
  }
  const out = new Map(); for (const [k, v] of usage) out.set(k, [...v].sort());
  return out;
}

const pathParamsOf = path => [...String(path).matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

/** Lint a spec. -> [{ level:'error'|'warn'|'info', code, message, where }] */
export function lintSpec(spec) {
  const f = []; const add = (level, code, message, where = '') => f.push({ level, code, message, where });
  const v = detectVersion(spec);
  if (!v.kind) { add('error', 'version', 'Missing or unsupported "openapi" / "swagger" version field.'); return f; }
  if (!isObj(spec.info)) add('error', 'info', 'The "info" object is required.');
  else { if (!spec.info.title) add('error', 'info-title', 'info.title is required.', 'info'); if (!spec.info.version) add('error', 'info-version', 'info.version is required.', 'info'); }
  if (v.kind === 'openapi3' && !Array.isArray(spec.servers) && !isObj(spec.webhooks)) add('info', 'servers', 'No "servers" defined; clients will assume the document URL ("/").');
  if (!isObj(spec.paths) && !isObj(spec.webhooks) && !isObj(spec.components)) add('error', 'paths', 'The document has no "paths", "webhooks" or "components".');
  // refs
  const seenBad = new Set();
  for (const { ref, path } of collectRefs(spec)) {
    const r = resolvePointer(spec, ref);
    if (r.ok) continue;
    const key = `${ref}|${path.join('/')}`; if (seenBad.has(key)) continue; seenBad.add(key);
    if (r.remote) add('warn', 'remote-ref', `Remote $ref "${ref}" is not fetched by this viewer and is reported as unresolved.`, `#/${path.map(encodePointerSegment).join('/')}`);
    else add('error', 'undefined-ref', `$ref "${ref}" cannot be resolved (${r.error}).`, `#/${path.map(encodePointerSegment).join('/')}`);
  }
  // operations
  const ids = new Map(); const definedSchemes = new Set(entries(v.kind === 'swagger2' ? spec.securityDefinitions : spec.components?.securitySchemes).map(([k]) => k));
  const declaredTags = new Set((Array.isArray(spec.tags) ? spec.tags : []).map(t => t?.name));
  const reqSchemes = (list, where) => { if (Array.isArray(list)) for (const req of list) for (const name of Object.keys(req || {})) if (!definedSchemes.has(name)) add('error', 'undefined-security', `Security requirement "${name}" is not defined in ${v.kind === 'swagger2' ? 'securityDefinitions' : 'components.securitySchemes'}.`, where); };
  reqSchemes(spec.security, 'security');
  for (const grp of ['paths', 'webhooks']) {
    for (const [path, rawItem] of entries(spec[grp])) {
      if (grp === 'paths' && !path.startsWith('/')) add('error', 'path-slash', `Path "${path}" must start with "/".`, `paths.${path}`);
      const item = deref(spec, rawItem).value; if (!isObj(item)) continue;
      const params = pathParamsOf(path);
      const dupPath = new Set();
      for (const m of METHODS) {
        const op = item[m]; if (!isObj(op)) continue;
        const where = `${m.toUpperCase()} ${path}`;
        if (op.operationId) { if (ids.has(op.operationId)) add('error', 'duplicate-operationId', `operationId "${op.operationId}" is used by both ${ids.get(op.operationId)} and ${where}.`, where); else ids.set(op.operationId, where); }
        else add('warn', 'missing-operationId', 'Operation has no operationId (needed by most code generators).', where);
        if (!op.summary && !op.description) add('info', 'missing-summary', 'Operation has neither summary nor description.', where);
        if (!isObj(op.responses) || !Object.keys(op.responses).length) add('error', 'missing-responses', 'Operation has no responses.', where);
        else if (!Object.keys(op.responses).some(c => /^2/.test(c) || c === 'default' || c === '2XX')) add('warn', 'no-success-response', 'No 2xx (success) or default response is documented.', where);
        if (Array.isArray(op.tags)) for (const t of op.tags) if (declaredTags.size && !declaredTags.has(t)) add('info', 'undeclared-tag', `Tag "${t}" is not declared in the top-level "tags" list.`, where);
        const all = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])].map(p => deref(spec, p).value).filter(isObj);
        const seen = new Set();
        for (const p of all) { const k = `${p.in}:${p.name}`; if (seen.has(k) && !dupPath.has(k)) add('warn', 'duplicate-parameter', `Parameter "${p.name}" (${p.in}) is declared more than once.`, where); seen.add(k); }
        const declaredPath = all.filter(p => p.in === 'path');
        for (const name of params) if (!declaredPath.some(p => p.name === name)) add('error', 'undeclared-path-param', `Path parameter {${name}} is in the URL template but not declared in parameters.`, where);
        for (const p of declaredPath) { if (!params.includes(p.name)) add('warn', 'unused-path-param', `Path parameter "${p.name}" is declared but not in the path template.`, where); if (p.required !== true) add('error', 'path-param-required', `Path parameter "${p.name}" must have required: true.`, where); }
        if (v.kind === 'swagger2' && all.filter(p => p.in === 'body').length > 1) add('error', 'multiple-body', 'More than one body parameter is declared.', where);
        if (['get', 'head', 'delete'].includes(m) && (op.requestBody || all.some(p => p.in === 'body'))) add('warn', 'body-on-get', `${m.toUpperCase()} operations should not have a request body.`, where);
        reqSchemes(op.security, where);
      }
    }
  }
  // unused schemas
  const usage = computeUsage(spec);
  for (const [name] of entries(v.kind === 'swagger2' ? spec.definitions : spec.components?.schemas)) if (!usage.has(name)) add('info', 'unused-schema', `Schema "${name}" is never referenced.`, `#/${v.kind === 'swagger2' ? 'definitions' : 'components/schemas'}/${encodePointerSegment(name)}`);
  const order = { error: 0, warn: 1, info: 2 };
  f.sort((a, b) => order[a.level] - order[b.level]);
  return f;
}

// ---------------------------------------------------------------- mini markdown (safe: AST only)
const SAFE_URL = /^(https?:|mailto:)/i;
export function parseInline(text) {
  const out = []; let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', text: buf }); buf = ''; } };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if (text[i] === '`' && (m = /^`([^`\n]+)`/.exec(rest))) { flush(); out.push({ t: 'code', text: m[1] }); i += m[0].length; }
    else if ((m = /^\*\*([^*\n]+)\*\*/.exec(rest)) || (m = /^__([^_\n]+)__/.exec(rest))) { flush(); out.push({ t: 'strong', text: m[1] }); i += m[0].length; }
    else if ((m = /^\*([^*\s][^*\n]*)\*/.exec(rest)) || ((i === 0 || /\W/.test(text[i - 1])) && (m = /^_([^_\s][^_\n]*)_(?!\w)/.exec(rest)))) { flush(); out.push({ t: 'em', text: m[1] }); i += m[0].length; }
    else if (text[i] === '[' && (m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) { flush(); out.push(SAFE_URL.test(m[2]) ? { t: 'link', text: m[1], href: m[2] } : { t: 'text', text: m[1] }); i += m[0].length; }
    else if ((m = /^https?:\/\/[^\s<>)\]]+/.exec(rest))) { flush(); out.push({ t: 'link', text: m[0], href: m[0] }); i += m[0].length; }
    else { buf += text[i]; i++; }
  }
  flush();
  return out;
}
/** Markdown subset -> blocks: {t:'p'|'h'|'ul'|'ol'|'code'|'quote', ...}. Raw HTML is never interpreted. */
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n'); const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^\s*(```|~~~)\s*(\S*)/.exec(line))) {
      const fence = m[1], buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++; blocks.push({ t: 'code', lang: m[2], text: buf.join('\n') }); continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { blocks.push({ t: 'h', level: m[1].length, inlines: parseInline(m[2].trim()) }); i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(parseInline(lines[i++].replace(/^\s*[-*+]\s+/, ''))); blocks.push({ t: 'ul', items }); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(parseInline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))); blocks.push({ t: 'ol', items }); continue; }
    if (/^\s*>\s?/.test(line)) { const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); blocks.push({ t: 'quote', inlines: parseInline(buf.join(' ')) }); continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*(```|~~~)|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>)/.test(lines[i])) buf.push(lines[i++].trim());
    blocks.push({ t: 'p', inlines: parseInline(buf.join(' ')) });
  }
  return blocks;
}

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inlineHtml = list => list.map(n => n.t === 'code' ? `<code>${escapeHtml(n.text)}</code>` : n.t === 'strong' ? `<strong>${escapeHtml(n.text)}</strong>` : n.t === 'em' ? `<em>${escapeHtml(n.text)}</em>`
  : n.t === 'link' ? `<a href="${escapeHtml(n.href)}" rel="noopener noreferrer nofollow">${escapeHtml(n.text)}</a>` : escapeHtml(n.text)).join('');
export function markdownToHtml(src) {
  return parseMarkdown(src).map(b => b.t === 'p' ? `<p>${inlineHtml(b.inlines)}</p>` : b.t === 'h' ? `<h${Math.min(6, b.level + 3)}>${inlineHtml(b.inlines)}</h${Math.min(6, b.level + 3)}>`
    : b.t === 'ul' ? `<ul>${b.items.map(i => `<li>${inlineHtml(i)}</li>`).join('')}</ul>` : b.t === 'ol' ? `<ol>${b.items.map(i => `<li>${inlineHtml(i)}</li>`).join('')}</ol>`
    : b.t === 'quote' ? `<blockquote>${inlineHtml(b.inlines)}</blockquote>` : `<pre><code>${escapeHtml(b.text)}</code></pre>`).join('\n');
}

// ---------------------------------------------------------------- export: Markdown
const mdCell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const json = v => JSON.stringify(v, null, 2);
function opExamples(model, content) { // -> [{ mime, text }]
  const out = [];
  for (const c of content) {
    let v = c.hasExample ? c.example : c.schema ? exampleFor(model.spec, c.schema) : undefined;
    if (v === undefined) continue;
    out.push({ mime: c.mime, text: typeof v === 'string' && !/json/.test(c.mime) ? v : json(v) });
  }
  return out;
}
function securityText(model, op) {
  if (op.security === null) return null;
  if (!op.security.length) return 'None';
  return op.security.map(req => req.length ? req.map(r => r.name + (r.scopes.length ? ` (${r.scopes.join(', ')})` : '')).join(' + ') : 'None (optional)').join(' or ');
}

export function toMarkdown(model) {
  const L = []; const spec = model.spec;
  L.push(`# ${model.info.title}${model.info.version ? ` (${model.info.version})` : ''}`, '');
  L.push(`*${model.kind === 'swagger2' ? 'Swagger' : 'OpenAPI'} ${model.version}*`, '');
  if (model.info.summary) L.push(model.info.summary, '');
  if (model.info.description) L.push(model.info.description, '');
  if (model.servers.length) { L.push('## Servers', ''); for (const s of model.servers) L.push(`- \`${s.url}\`${s.description ? ` - ${s.description}` : ''}`); L.push(''); }
  if (model.securitySchemes.length) {
    L.push('## Security', '');
    for (const s of model.securitySchemes) L.push(`- **${s.name}**: ${[s.type, s.scheme, s.in && `in ${s.in}`, s.keyName ? `name \`${s.keyName}\`` : ''].filter(Boolean).join(', ')}${s.description ? ` - ${s.description.replace(/\n/g, ' ')}` : ''}`);
    L.push('');
  }
  const section = (heading, ops) => {
    for (const g of groupByTag(model, ops)) {
      L.push(`## ${heading ? heading + ': ' : ''}${g.name}`, ''); if (g.description) L.push(g.description, '');
      for (const op of g.ops) {
        L.push(`### \`${op.method} ${op.path}\`${op.summary ? ` - ${op.summary}` : ''}${op.deprecated ? ' (deprecated)' : ''}`, '');
        if (op.operationId) L.push(`Operation ID: \`${op.operationId}\``, '');
        if (op.description) L.push(op.description, '');
        const sec = securityText(model, op); if (sec) L.push(`**Security:** ${sec}`, '');
        if (op.parameters.length) {
          L.push('**Parameters**', '', '| Name | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |');
          for (const p of op.parameters) L.push(`| \`${mdCell(p.name)}\` | ${p.in} | ${mdCell(p.type)}${p.enum ? ` (${mdCell(p.enum.join(', '))})` : ''} | ${p.required ? 'yes' : 'no'} | ${mdCell(p.description)}${p.default !== undefined ? ` Default: \`${mdCell(JSON.stringify(p.default))}\`` : ''} |`);
          L.push('');
        }
        if (op.requestBody) {
          L.push(`**Request body**${op.requestBody.required ? ' (required)' : ''}${op.requestBody.description ? `: ${op.requestBody.description}` : ''}`, '');
          for (const c of op.requestBody.content) schemaBlock(L, model, c);
        }
        if (op.responses.length) {
          L.push('**Responses**', '');
          for (const r of op.responses) {
            L.push(`- \`${r.code}\` ${r.description}`.trimEnd());
            for (const h of r.headers) L.push(`  - header \`${h.name}\` (${h.type}) ${h.description}`.trimEnd());
          }
          L.push('');
          for (const r of op.responses) for (const c of r.content) { L.push(`Response \`${r.code}\``, ''); schemaBlock(L, model, c); }
        }
      }
    }
  };
  section('', model.operations);
  if (model.webhooks.length) section('Webhook', model.webhooks);
  if (model.schemas.length) {
    L.push('## Schemas', '');
    for (const s of model.schemas) {
      const t = buildSchemaTree(spec, { $ref: s.pointer });
      L.push(`### ${s.name}`, ''); if (t.description) L.push(t.description, '');
      const rows = flattenSchema({ ...t, ref: undefined }, 6);
      if (rows.length) { L.push('| Property | Type | Required | Description |', '| --- | --- | --- | --- |'); for (const r of rows) L.push(`| \`${mdCell(r.path)}\` | ${mdCell(r.type)} | ${r.required ? 'yes' : 'no'} | ${mdCell([r.description, ...r.notes].filter(Boolean).join('; '))} |`); L.push(''); }
    }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
function schemaBlock(L, model, c) {
  L.push(`Content type: \`${c.mime}\``, '');
  if (c.schema) {
    const t = buildSchemaTree(model.spec, c.schema);
    const rows = flattenSchema(t, 5);
    if (rows.length) { L.push('| Field | Type | Required | Description |', '| --- | --- | --- | --- |'); for (const r of rows) L.push(`| \`${mdCell(r.path)}\` | ${mdCell(r.type)} | ${r.required ? 'yes' : 'no'} | ${mdCell([r.description, ...r.notes].filter(Boolean).join('; '))} |`); L.push(''); }
  }
  const ex = opExamples(model, [c])[0];
  if (ex) L.push('```' + (/json/.test(ex.mime) ? 'json' : ''), ex.text, '```', '');
}

// ---------------------------------------------------------------- export: standalone HTML
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
export const HTML_CSS = `:root{--bg:#fff;--fg:#1a2030;--mut:#5b6577;--bd:#dfe3ea;--sf:#f1f3f6;--pri:#3a58e8;--ok:#0f7453;--wr:#8f5400;--er:#c62d3d}
@media (prefers-color-scheme:dark){:root{--bg:#0e1118;--fg:#e6e9f0;--mut:#9aa4b8;--bd:#272f3f;--sf:#1b212d;--pri:#8aa0ff;--ok:#3dd29b;--wr:#f0b24a;--er:#ff7080}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-wrap:wrap}
nav{flex:0 0 260px;max-width:100%;padding:20px;border-right:1px solid var(--bd);position:sticky;top:0;align-self:flex-start;max-height:100vh;overflow:auto;font-size:13px}
nav h2{font-size:12px;text-transform:uppercase;color:var(--mut);margin:14px 0 4px}nav a{display:block;color:var(--fg);text-decoration:none;padding:2px 0;overflow-wrap:anywhere}nav a:hover{color:var(--pri)}
main{flex:1 1 560px;min-width:0;padding:24px 28px;max-width:980px}h1{margin-top:0}h2{border-bottom:1px solid var(--bd);padding-bottom:6px;margin-top:36px}
.op{border:1px solid var(--bd);border-radius:10px;margin:16px 0;padding:14px 16px}.op h3{margin:0 0 6px;font-size:16px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.m{display:inline-block;min-width:64px;text-align:center;padding:1px 8px;border-radius:6px;font:700 12px ui-monospace,Menlo,Consolas,monospace;color:#fff;background:#555}
.m-get{background:#1d6fb8}.m-post{background:#0f7453}.m-put{background:#8f5400}.m-delete{background:#c62d3d}.m-patch{background:#7a3fb8}
.path{font-family:ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}.dep{text-decoration:line-through;opacity:.7}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:13px;display:block;overflow-x:auto}th,td{border:1px solid var(--bd);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--sf)}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}pre{background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;overflow:auto}
.mut{color:var(--mut)}.tag{display:inline-block;background:var(--sf);border-radius:99px;padding:0 8px;font-size:12px;margin-right:4px}a{color:var(--pri)}
@media (max-width:760px){nav{flex-basis:100%;position:static;max-height:none;border-right:0;border-bottom:1px solid var(--bd)}main{padding:16px}}
@media print{nav{display:none}.op{break-inside:avoid}}`;

function htmlTable(head, rows) { return `<table><thead><tr>${head.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`; }
function htmlSchema(model, c) {
  let h = `<p class="mut">Content type: <code>${escapeHtml(c.mime)}</code></p>`;
  if (c.schema) {
    const rows = flattenSchema(buildSchemaTree(model.spec, c.schema), 5);
    if (rows.length) h += htmlTable(['Field', 'Type', 'Required', 'Description'], rows.map(r => [`<code>${escapeHtml(r.path)}</code>`, escapeHtml(r.type), r.required ? 'yes' : 'no', escapeHtml([r.description, ...r.notes].filter(Boolean).join('; '))]));
  }
  const ex = opExamples(model, [c])[0]; if (ex) h += `<pre><code>${escapeHtml(ex.text)}</code></pre>`;
  return h;
}
/** Self-contained HTML document: no scripts, no external requests; everything escaped. */
export function toHtml(model) {
  const used = new Set(); const uid = base => { let s = slug(base), n = 1; while (used.has(s)) s = `${slug(base)}-${++n}`; used.add(s); return s; };
  const nav = [], body = [];
  body.push(`<h1>${escapeHtml(model.info.title)} <small class="mut">${escapeHtml(model.info.version)}</small></h1>`, `<p class="mut">${model.kind === 'swagger2' ? 'Swagger' : 'OpenAPI'} ${escapeHtml(model.version)}</p>`);
  if (model.info.summary) body.push(`<p>${escapeHtml(model.info.summary)}</p>`);
  if (model.info.description) body.push(markdownToHtml(model.info.description));
  if (model.servers.length) body.push('<h2 id="servers">Servers</h2><ul>' + model.servers.map(s => `<li><code>${escapeHtml(s.url)}</code>${s.description ? ` - ${escapeHtml(s.description)}` : ''}</li>`).join('') + '</ul>');
  if (model.securitySchemes.length) body.push('<h2 id="security">Security</h2><ul>' + model.securitySchemes.map(s => `<li><strong>${escapeHtml(s.name)}</strong>: ${escapeHtml([s.type, s.scheme, s.in && `in ${s.in}`].filter(Boolean).join(', '))}${s.description ? ` - ${escapeHtml(s.description)}` : ''}</li>`).join('') + '</ul>');
  const emit = (label, ops) => {
    for (const g of groupByTag(model, ops)) {
      const gid = uid(`${label}${g.name}`); nav.push(`<h2>${escapeHtml(label + g.name)}</h2>`);
      body.push(`<h2 id="${gid}">${escapeHtml(label + g.name)}</h2>`); if (g.description) body.push(`<p class="mut">${escapeHtml(g.description)}</p>`);
      for (const op of g.ops) {
        const id = uid(`${op.method}-${op.path}`); nav.push(`<a href="#${id}"><code>${escapeHtml(op.method)}</code> ${escapeHtml(op.path)}</a>`);
        let h = `<section class="op" id="${id}"><h3><span class="m m-${escapeHtml(op.method.toLowerCase())}">${escapeHtml(op.method)}</span> <span class="path${op.deprecated ? ' dep' : ''}">${escapeHtml(op.path)}</span> <span class="mut">${escapeHtml(op.summary)}</span></h3>`;
        if (op.deprecated) h += '<p><strong>Deprecated</strong></p>';
        if (op.operationId) h += `<p class="mut">Operation ID: <code>${escapeHtml(op.operationId)}</code></p>`;
        if (op.description) h += markdownToHtml(op.description);
        const sec = securityText(model, op); if (sec) h += `<p><strong>Security:</strong> ${escapeHtml(sec)}</p>`;
        if (op.parameters.length) h += '<h4>Parameters</h4>' + htmlTable(['Name', 'In', 'Type', 'Required', 'Description'], op.parameters.map(p => [`<code>${escapeHtml(p.name)}</code>`, escapeHtml(p.in), escapeHtml(p.type + (p.enum ? ` (${p.enum.join(', ')})` : '')), p.required ? 'yes' : 'no', escapeHtml(p.description + (p.default !== undefined ? ` Default: ${JSON.stringify(p.default)}` : ''))]));
        if (op.requestBody) { h += `<h4>Request body${op.requestBody.required ? ' (required)' : ''}</h4>`; if (op.requestBody.description) h += `<p>${escapeHtml(op.requestBody.description)}</p>`; for (const c of op.requestBody.content) h += htmlSchema(model, c); }
        if (op.responses.length) { h += '<h4>Responses</h4>'; for (const r of op.responses) { h += `<p><strong><code>${escapeHtml(r.code)}</code></strong> ${escapeHtml(r.description)}</p>`; for (const c of r.content) h += htmlSchema(model, c); } }
        body.push(h + '</section>');
      }
    }
  };
  emit('', model.operations); if (model.webhooks.length) emit('Webhook: ', model.webhooks);
  if (model.schemas.length) {
    body.push('<h2 id="schemas">Schemas</h2>'); nav.push('<h2>Schemas</h2>');
    for (const s of model.schemas) {
      const id = uid(`schema-${s.name}`); nav.push(`<a href="#${id}">${escapeHtml(s.name)}</a>`);
      const t = buildSchemaTree(model.spec, { $ref: s.pointer }); const rows = flattenSchema({ ...t, ref: undefined }, 6);
      body.push(`<section class="op" id="${id}"><h3>${escapeHtml(s.name)}</h3>${t.description ? `<p>${escapeHtml(t.description)}</p>` : ''}${rows.length ? htmlTable(['Property', 'Type', 'Required', 'Description'], rows.map(r => [`<code>${escapeHtml(r.path)}</code>`, escapeHtml(r.type), r.required ? 'yes' : 'no', escapeHtml([r.description, ...r.notes].filter(Boolean).join('; '))])) : ''}</section>`);
    }
  }
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(model.info.title)} - API documentation</title><style>${HTML_CSS}</style></head>\n<body><nav aria-label="Contents"><strong>${escapeHtml(model.info.title)}</strong>${model.servers.length ? '<a href="#servers">Servers</a>' : ''}${model.securitySchemes.length ? '<a href="#security">Security</a>' : ''}${nav.join('')}</nav><main>${body.join('\n')}</main></body></html>\n`;
}

// ---------------------------------------------------------------- small helpers used by the UI
/** Validate a user-entered spec URL (http/https only, no embedded credentials). */
export function validateSpecUrl(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { return { ok: false, error: 'Enter a full URL such as https://example.com/openapi.json' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http:// and https:// URLs are allowed.' };
  if (u.username || u.password) return { ok: false, error: 'URLs with embedded credentials are not accepted.' };
  return { ok: true, url: u.href };
}
/** Example payload text for a media-type entry. -> { text, source:'spec'|'generated', mime, name? }[] (named examples first). */
export function exampleTexts(spec, c) {
  const fmt = v => (typeof v === 'string' && !/json/.test(c.mime) ? v : JSON.stringify(v, null, 2));
  const out = [];
  if (c.examples && c.examples.length) for (const e of c.examples) out.push({ text: fmt(e.value), source: 'spec', name: e.name });
  else if (c.hasExample) out.push({ text: fmt(c.example), source: 'spec' });
  if (!out.length && c.schema) { const v = exampleFor(spec, c.schema); if (v !== undefined) out.push({ text: fmt(v), source: 'generated' }); }
  return out;
}
/** Only http(s) links are ever made clickable. */
export const safeHref = h => (typeof h === 'string' && /^https?:\/\//i.test(h) ? h : null);
