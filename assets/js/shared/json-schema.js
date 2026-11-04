// JSON Schema validator: documented SUBSET of draft-07 / 2019-09 / 2020-12. Pure ES module, no dependencies.
//
// Implemented keywords:
//   type (string | array of types, "integer" included), enum, const,
//   properties, required, additionalProperties (bool | schema), patternProperties, propertyNames,
//   minProperties, maxProperties, dependentRequired, dependencies (array form), dependentSchemas,
//   items (schema | tuple array), prefixItems, additionalItems, minItems, maxItems, uniqueItems,
//   contains (+ minContains / maxContains),
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum (number or draft-04 boolean form), multipleOf,
//   minLength, maxLength, pattern,
//   format: email, uri, date, date-time, uuid, ipv4, ipv6 (best-effort; other formats reported "not checked"),
//   allOf, anyOf, oneOf, not, if / then / else,
//   $ref to local pointers ("#", "#/definitions/x", "#/$defs/x") with cycle protection,
//   boolean schemas (true / false).
// Ignored annotations: title, description, default, examples, $schema, $id, $comment, definitions, $defs, deprecated,
//   readOnly, writeOnly, contentMediaType (annotation only).
// NOT checked (reported in result.notChecked, never silently passed): $dynamicRef, $dynamicAnchor, $recursiveRef,
//   $recursiveAnchor, $anchor, unevaluatedProperties, unevaluatedItems, contentSchema, contentEncoding, $vocabulary,
//   remote / non-local $ref, unknown formats, and any other unknown keyword (except "x-" extensions).
// Regex `pattern` uses the JavaScript regex engine (ECMA-262), which is what the spec recommends. A pathological
// pattern can be slow (no ReDoS protection).

export const MAX_ERRORS = 1000;
export const MAX_DEPTH = 200;

const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$schema', '$id', 'id', '$comment', 'definitions', '$defs',
  'deprecated', 'readOnly', 'writeOnly', 'contentMediaType']);
const IMPLEMENTED = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'dependentRequired', 'dependencies', 'dependentSchemas', 'items', 'prefixItems', 'additionalItems',
  'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref']);
const UNSUPPORTED = new Set(['$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$anchor', 'unevaluatedProperties',
  'unevaluatedItems', 'contentSchema', 'contentEncoding', '$vocabulary']);

const own = Object.prototype.hasOwnProperty;
const isObj = v => v !== null && typeof v === 'object';
const isPlain = v => isObj(v) && !Array.isArray(v);

export const jsonType = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
const matchesType = (t, v) => {
  const jt = jsonType(v);
  return t === jt || (t === 'number' && jt === 'integer') || (t === 'integer' && typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v));
};

/** Structural JSON equality (key-order independent). Depth-limited. */
export function deepEqual(a, b, d = 0) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (!isObj(a) || !isObj(b) || d > 500) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], d + 1)) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!own.call(b, k) || !deepEqual(a[k], b[k], d + 1)) return false;
  return true;
}

// ---------------- formats
const daysIn = (y, m) => [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const mo = +m[2];
  return mo >= 1 && mo <= 12 && +m[3] >= 1 && +m[3] <= daysIn(+m[1], mo);
}
function isDateTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m || !isDate(m[1])) return false;
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 60) return false;
  const tz = /([+-])(\d{2}):(\d{2})$/.exec(m[6]);
  return !tz || (+tz[2] <= 23 && +tz[3] <= 59);
}
function isIPv4(s) {
  const p = s.split('.');
  return p.length === 4 && p.every(x => /^(0|[1-9]\d{0,2})$/.test(x) && +x <= 255);
}
function isIPv6(s) {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.includes(':::')) return false;
  const dbl = s.split('::');
  if (dbl.length > 2) return false;
  let groups = 0;
  const count = part => {
    if (part === '') return 0;
    const g = part.split(':');
    let n = 0;
    for (let i = 0; i < g.length; i++) {
      if (g[i].includes('.')) { if (i !== g.length - 1 || !isIPv4(g[i])) return -1; n += 2; }
      else if (/^[0-9a-fA-F]{1,4}$/.test(g[i])) n++;
      else return -1;
    }
    return n;
  };
  for (const part of dbl) { const c = count(part); if (c < 0) return false; groups += c; }
  return dbl.length === 2 ? groups <= 7 : groups === 8;
}
const FORMATS = {
  email: s => /^[^\s@"(),:;<>\[\\\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s) && s.length <= 254,
  uri: s => /^[A-Za-z][A-Za-z0-9+.\-]*:[^\s]*$/.test(s),
  date: isDate,
  'date-time': isDateTime,
  uuid: s => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s),
  ipv4: isIPv4,
  ipv6: isIPv6,
};
export const SUPPORTED_FORMATS = Object.keys(FORMATS);

// ---------------- helpers
const escPtr = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
/** JSON pointer (RFC 6901) -> array of segments (strings). '' -> []. */
export function pointerToSegments(ptr) {
  if (!ptr) return [];
  return ptr.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function resolveRef(ref, rootSchema) {
  if (ref === '#' || ref === '#/') return rootSchema;
  if (!ref.startsWith('#/')) return undefined;
  let cur = rootSchema;
  for (const raw of ref.slice(2).split('/')) {
    let seg;
    try { seg = decodeURIComponent(raw); } catch { return undefined; }
    seg = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) { if (!/^\d+$/.test(seg) || +seg >= cur.length) return undefined; cur = cur[+seg]; }
    else if (isPlain(cur) && own.call(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/**
 * Validate `data` against `schema`.
 * @returns {{valid:boolean, errors:{path:string, keyword:string, message:string, schemaPath:string}[],
 *            notChecked:{keyword:string, path:string, reason:string}[], truncated:boolean}}
 * `path` is a JSON pointer into the data ('' = root). `valid` is false when there are errors; check
 * `notChecked` to see which parts of the schema could NOT be verified.
 */
export function validate(schema, data) {
  const errors = [], notChecked = [], seenNC = new Set(), regexCache = new Map();
  let truncated = false;
  const rootSchema = schema;

  const addNC = (keyword, spath, reason) => {
    const k = keyword + '@' + spath;
    if (seenNC.has(k)) return;
    seenNC.add(k); notChecked.push({ keyword, path: spath, reason });
  };
  const getRegex = p => {
    if (regexCache.has(p)) return regexCache.get(p);
    let re;
    try { re = new RegExp(p, 'u'); } catch { try { re = new RegExp(p); } catch (e) { re = { error: e.message }; } }
    regexCache.set(p, re); return re;
  };

  /** Core. Pushes errors onto `errs`. Returns nothing. */
  function check(s, v, path, spath, errs, depth, active) {
    if (errs.length >= MAX_ERRORS) { truncated = true; return; }
    const err = (keyword, message, p = path) => { if (errs.length < MAX_ERRORS) errs.push({ path: p, keyword, message, schemaPath: spath + '/' + keyword }); else truncated = true; };
    if (s === true || s === undefined) return;
    if (s === false) { err('false schema', 'Schema is "false": no value is allowed here'); return; }
    if (!isPlain(s)) { addNC('schema', spath, 'schema is not an object or boolean'); return; }
    if (depth > MAX_DEPTH) { err('depth', `Schema nesting exceeds ${MAX_DEPTH}`); return; }
    const sub = (ss, vv, p, sp, e = errs, key = active) => check(ss, vv, p, sp, e, depth + 1, key);

    for (const k of Object.keys(s)) {
      if (UNSUPPORTED.has(k)) addNC(k, spath, 'keyword is not supported by this validator');
      else if (!IMPLEMENTED.has(k) && !ANNOTATIONS.has(k) && !k.startsWith('x-')) addNC(k, spath, 'unknown keyword');
    }

    // $ref (siblings are honoured, 2019-09+ behaviour)
    if (typeof s.$ref === 'string') {
      const target = resolveRef(s.$ref, rootSchema);
      if (target === undefined) addNC('$ref', spath, s.$ref.startsWith('#') ? `unresolvable local reference ${s.$ref}` : `remote reference ${s.$ref} is not supported`);
      else {
        const key = s.$ref + '@' + path;
        if (active.has(key)) err('$ref', `Circular $ref ${s.$ref} (schema refers to itself without consuming data)`);
        else { const next = new Set(active); next.add(key); sub(target, v, path, spath + '/$ref', errs, next); }
      }
    } else if (s.$ref !== undefined) addNC('$ref', spath, '$ref is not a string');

    const jt = jsonType(v);

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some(t => matchesType(t, v))) err('type', `Expected ${types.join(' or ')} but got ${jt}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some(x => deepEqual(x, v))) err('enum', `Value must be one of: ${s.enum.map(x => JSON.stringify(x)).join(', ').slice(0, 200)}`);
    if (own.call(s, 'const') && !deepEqual(s.const, v)) err('const', `Value must equal ${JSON.stringify(s.const)?.slice(0, 200)}`);

    // numbers
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number') {
        if (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum) err('minimum', `Must be ${s.exclusiveMinimum === true ? '>' : '>='} ${s.minimum}`);
      }
      if (typeof s.maximum === 'number') {
        if (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum) err('maximum', `Must be ${s.exclusiveMaximum === true ? '<' : '<='} ${s.maximum}`);
      }
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) err('exclusiveMinimum', `Must be > ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) err('exclusiveMaximum', `Must be < ${s.exclusiveMaximum}`);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
        const q = v / s.multipleOf;
        if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) err('multipleOf', `Must be a multiple of ${s.multipleOf}`);
      }
    }

    // strings
    if (typeof v === 'string') {
      const len = [...v].length;
      if (typeof s.minLength === 'number' && len < s.minLength) err('minLength', `Must be at least ${s.minLength} characters (got ${len})`);
      if (typeof s.maxLength === 'number' && len > s.maxLength) err('maxLength', `Must be at most ${s.maxLength} characters (got ${len})`);
      if (typeof s.pattern === 'string') {
        const re = getRegex(s.pattern);
        if (re.error) err('pattern', `Invalid regular expression /${s.pattern}/: ${re.error}`);
        else if (!re.test(v)) err('pattern', `Must match pattern /${s.pattern}/`);
      }
      if (typeof s.format === 'string') {
        const f = FORMATS[s.format];
        if (!f) addNC('format', spath, `format "${s.format}" is not checked`);
        else if (!f(v)) err('format', `Must be a valid ${s.format}`);
      }
    } else if (typeof s.format === 'string' && !FORMATS[s.format]) addNC('format', spath, `format "${s.format}" is not checked`);

    // arrays
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) err('minItems', `Must have at least ${s.minItems} items (has ${v.length})`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) err('maxItems', `Must have at most ${s.maxItems} items (has ${v.length})`);
      if (s.uniqueItems === true) {
        const seen = new Map();
        outer: for (let i = 0; i < v.length; i++) {
          const key = isObj(v[i]) ? null : typeof v[i] + ':' + String(v[i]);
          if (key !== null) { if (seen.has(key)) { err('uniqueItems', `Items ${seen.get(key)} and ${i} are equal`, path + '/' + i); break; } seen.set(key, i); continue; }
          for (let j = 0; j < i; j++) if (isObj(v[j]) && deepEqual(v[j], v[i])) { err('uniqueItems', `Items ${j} and ${i} are equal`, path + '/' + i); break outer; }
        }
      }
      let tupleLen = 0;
      const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
      if (tuple) {
        tupleLen = tuple.length;
        const base = Array.isArray(s.prefixItems) ? 'prefixItems' : 'items';
        for (let i = 0; i < Math.min(tuple.length, v.length); i++) sub(tuple[i], v[i], `${path}/${i}`, `${spath}/${base}/${i}`);
      }
      const restSchema = Array.isArray(s.prefixItems) ? s.items : Array.isArray(s.items) ? s.additionalItems : s.items;
      const restKw = Array.isArray(s.prefixItems) ? 'items' : Array.isArray(s.items) ? 'additionalItems' : 'items';
      if (restSchema !== undefined) for (let i = tupleLen; i < v.length; i++) {
        if (errs.length >= MAX_ERRORS) { truncated = true; break; }
        if (restSchema === false) err(restKw, `Item ${i} is not allowed (no additional items)`, `${path}/${i}`);
        else sub(restSchema, v[i], `${path}/${i}`, `${spath}/${restKw}`);
      }
      if (own.call(s, 'contains')) {
        let n = 0;
        for (let i = 0; i < v.length; i++) { const t = []; sub(s.contains, v[i], `${path}/${i}`, `${spath}/contains`, t); if (!t.length) n++; }
        const min = typeof s.minContains === 'number' ? s.minContains : 1;
        if (n < min) err('contains', min === 1 && s.minContains === undefined ? 'Array must contain at least one item matching the "contains" schema' : `Array must contain at least ${min} matching items (found ${n})`);
        if (typeof s.maxContains === 'number' && n > s.maxContains) err('maxContains', `Array must contain at most ${s.maxContains} matching items (found ${n})`);
      }
    }

    // objects
    if (isPlain(v)) {
      const keys = Object.keys(v);
      if (typeof s.minProperties === 'number' && keys.length < s.minProperties) err('minProperties', `Must have at least ${s.minProperties} properties`);
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) err('maxProperties', `Must have at most ${s.maxProperties} properties`);
      if (Array.isArray(s.required)) for (const r of s.required) if (!own.call(v, r)) err('required', `Missing required property "${r}"`);
      const dep = (name, req) => { if (own.call(v, name)) for (const r of req) if (!own.call(v, r)) err('dependentRequired', `Property "${name}" requires "${r}"`); };
      if (isPlain(s.dependentRequired)) for (const [k, req] of Object.entries(s.dependentRequired)) if (Array.isArray(req)) dep(k, req);
      if (isPlain(s.dependencies)) for (const [k, d] of Object.entries(s.dependencies)) {
        if (Array.isArray(d)) dep(k, d); else if (own.call(v, k)) sub(d, v, path, `${spath}/dependencies/${escPtr(k)}`);
      }
      if (isPlain(s.dependentSchemas)) for (const [k, d] of Object.entries(s.dependentSchemas)) if (own.call(v, k)) sub(d, v, path, `${spath}/dependentSchemas/${escPtr(k)}`);
      const patterns = isPlain(s.patternProperties) ? Object.keys(s.patternProperties).map(p => [p, getRegex(p)]) : [];
      for (const [p, re] of patterns) if (re.error) err('patternProperties', `Invalid regular expression /${p}/: ${re.error}`);
      for (const k of keys) {
        if (errs.length >= MAX_ERRORS) { truncated = true; break; }
        const kp = `${path}/${escPtr(k)}`;
        let matched = false;
        if (isPlain(s.properties) && own.call(s.properties, k)) { matched = true; sub(s.properties[k], v[k], kp, `${spath}/properties/${escPtr(k)}`); }
        for (const [p, re] of patterns) if (!re.error && re.test(k)) { matched = true; sub(s.patternProperties[p], v[k], kp, `${spath}/patternProperties/${escPtr(p)}`); }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) err('additionalProperties', `Property "${k}" is not allowed`, kp);
          else sub(s.additionalProperties, v[k], kp, `${spath}/additionalProperties`);
        }
        if (own.call(s, 'propertyNames')) { const t = []; sub(s.propertyNames, k, kp, `${spath}/propertyNames`, t); if (t.length) err('propertyNames', `Property name "${k}" is invalid: ${t[0].message}`, kp); }
      }
    }

    // combinators
    if (Array.isArray(s.allOf)) s.allOf.forEach((x, i) => sub(x, v, path, `${spath}/allOf/${i}`));
    if (Array.isArray(s.anyOf)) {
      let ok = false; const all = [];
      s.anyOf.forEach((x, i) => { if (ok) return; const t = []; sub(x, v, path, `${spath}/anyOf/${i}`, t); if (!t.length) ok = true; else all.push(...t); });
      if (!ok && s.anyOf.length) err('anyOf', `Value matches none of the ${s.anyOf.length} anyOf schemas` + (all[0] ? ` (e.g. ${all[0].message})` : ''));
    }
    if (Array.isArray(s.oneOf)) {
      let n = 0;
      s.oneOf.forEach((x, i) => { const t = []; sub(x, v, path, `${spath}/oneOf/${i}`, t); if (!t.length) n++; });
      if (n !== 1) err('oneOf', n === 0 ? `Value matches none of the ${s.oneOf.length} oneOf schemas` : `Value matches ${n} oneOf schemas, exactly one is required`);
    }
    if (own.call(s, 'not')) { const t = []; sub(s.not, v, path, `${spath}/not`, t); if (!t.length) err('not', 'Value must not match the "not" schema'); }
    if (own.call(s, 'if')) {
      const t = []; sub(s.if, v, path, `${spath}/if`, t);
      if (!t.length) { if (own.call(s, 'then')) sub(s.then, v, path, `${spath}/then`); }
      else if (own.call(s, 'else')) sub(s.else, v, path, `${spath}/else`);
    }
  }

  check(schema, data, '', '#', errors, 0, new Set());
  return { valid: errors.length === 0, errors, notChecked, truncated };
}

export default validate;
