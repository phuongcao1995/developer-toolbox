// Sample-data generator (pure, no DOM, no eval). Two sources:
//   generateFromSchema(schema, {seed, maxNodes})   - realistic JSON honouring a JSON Schema subset
//   generateFromTemplate(templateText|value, {seed, maxNodes}) - template DSL (see below)
// Seeded mode (seed !== undefined/'') is fully deterministic (mulberry32 PRNG; NOT cryptographic).
//
// Template DSL: any JSON. A string value made only of one placeholder keeps the generated type
//   "{{int(1,100)}}" -> 42 (number), "{{bool}}" -> true, "{{name}}" -> "Ada Lovelace".
// Placeholders inside longer strings are interpolated ("user-{{int(1,9)}}@x.io").
//   {{name}} {{firstName}} {{lastName}} {{email}} {{uuid}} {{int(a,b)}} {{float(a,b)}} {{bool}} {{date}} {{datetime}}
//   {{pick(a,b,c)}} {{lorem(n)}} {{phone}} {{city}} {{country}} {{url}} {{ipv4}} {{word}}
// An array whose FIRST element is an object with "$repeat": n repeats that element n times (each expanded
// independently; the "$repeat" key is removed; the remaining elements are kept).
// Schema mode honours: type (incl. arrays), enum, const, min/max (+exclusive), multipleOf, minLength/maxLength, format,
// required, nested objects, arrays (minItems..maxItems, tuple items, uniqueItems best effort), oneOf/anyOf (first branch),
// allOf (shallow merge), local $ref. `pattern` is NOT honoured (a regex cannot be generated from) - the generated
// string may not match it.

export const MAX_NODES = 100000;
export const MAX_REPEAT = 10000;

export function hashSeed(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** mulberry32: returns () => float in [0,1). */
export function makeRng(seed) {
  let a = (seed === undefined || seed === null || seed === '' ? Math.floor(Math.random() * 2 ** 32) : hashSeed(seed)) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim', 'Hedy', 'Edsger', 'Katherine', 'Guido', 'Anita'];
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Berners', 'Lamarr', 'Dijkstra', 'Johnson', 'Rossum', 'Borg'];
const CITIES = ['Paris', 'Hanoi', 'Berlin', 'Tokyo', 'Lima', 'Oslo', 'Cairo', 'Austin', 'Seoul', 'Madrid', 'Toronto', 'Sydney'];
const COUNTRIES = ['France', 'Vietnam', 'Germany', 'Japan', 'Peru', 'Norway', 'Egypt', 'USA', 'Korea', 'Spain', 'Canada', 'Australia'];
const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud'];
const DOMAINS = ['example.com', 'example.org', 'mail.test', 'demo.dev'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const setProp = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

class Gen {
  constructor(opts = {}) {
    this.rng = makeRng(opts.seed);
    this.maxNodes = opts.maxNodes ?? MAX_NODES;
    this.nodes = 0;
  }
  tick(n = 1) { this.nodes += n; if (this.nodes > this.maxNodes) throw new Error(`Generated data exceeds the ${this.maxNodes} node limit; lower the repeat counts / array sizes.`); }
  int(a, b) { if (a > b) [a, b] = [b, a]; return a + Math.floor(this.rng() * (b - a + 1)); }
  float(a, b, dp = 2) { if (a > b) [a, b] = [b, a]; return Number((a + this.rng() * (b - a)).toFixed(dp)); }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  bool() { return this.rng() < 0.5; }
  uuid() {
    const h = n => Array.from({ length: n }, () => Math.floor(this.rng() * 16).toString(16)).join('');
    return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[Math.floor(this.rng() * 4)]}${h(3)}-${h(12)}`;
  }
  name() { return `${this.pick(FIRST)} ${this.pick(LAST)}`; }
  email() { return `${this.pick(FIRST)}.${this.pick(LAST)}${this.int(1, 99)}@${this.pick(DOMAINS)}`.toLowerCase(); }
  date() { return new Date(Date.UTC(2020, 0, 1) + this.int(0, 365 * 6) * 86400000).toISOString().slice(0, 10); }
  datetime() { return new Date(Date.UTC(2020, 0, 1) + this.int(0, 365 * 6 * 86400) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  lorem(n) { const w = Array.from({ length: Math.max(1, n) }, () => this.pick(WORDS)); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return w.join(' ') + '.'; }
  ipv4() { return [this.int(1, 223), this.int(0, 255), this.int(0, 255), this.int(1, 254)].join('.'); }
  phone() { return `+1-${this.int(200, 999)}-${this.int(200, 999)}-${String(this.int(0, 9999)).padStart(4, '0')}`; }
  url() { return `https://${this.pick(DOMAINS)}/${this.pick(WORDS)}/${this.int(1, 999)}`; }

  /** Evaluate one placeholder body (the text inside {{ }}). Returns a typed value. */
  placeholder(body) {
    const m = /^\s*([A-Za-z]+)\s*(?:\(([^)]*)\))?\s*$/.exec(body);
    if (!m) throw new Error(`Invalid placeholder {{${body}}}`);
    const name = m[1], args = m[2] === undefined ? [] : m[2].split(',').map(s => s.trim());
    const num = (s, d) => { if (s === undefined || s === '') return d; const n = Number(s); if (!Number.isFinite(n)) throw new Error(`Bad number "${s}" in {{${body}}}`); return n; };
    switch (name) {
      case 'name': return this.name();
      case 'firstName': return this.pick(FIRST);
      case 'lastName': return this.pick(LAST);
      case 'email': return this.email();
      case 'uuid': return this.uuid();
      case 'int': return this.int(Math.trunc(num(args[0], 0)), Math.trunc(num(args[1], 100)));
      case 'float': return this.float(num(args[0], 0), num(args[1], 1));
      case 'bool': return this.bool();
      case 'date': return this.date();
      case 'datetime': return this.datetime();
      case 'pick': if (!args.length || (args.length === 1 && args[0] === '')) throw new Error('{{pick()}} needs at least one option'); return this.pick(args);
      case 'lorem': return this.lorem(Math.min(500, Math.max(1, Math.trunc(num(args[0], 5)))));
      case 'phone': return this.phone();
      case 'city': return this.pick(CITIES);
      case 'country': return this.pick(COUNTRIES);
      case 'url': return this.url();
      case 'ipv4': return this.ipv4();
      case 'word': return this.pick(WORDS);
      default: throw new Error(`Unknown placeholder {{${body}}}`);
    }
  }
  string(s) {
    const whole = /^\s*\{\{([^{}]*)\}\}\s*$/.exec(s);
    if (whole) return this.placeholder(whole[1]);
    return s.replace(/\{\{([^{}]*)\}\}/g, (_, b) => String(this.placeholder(b)));
  }
  template(v, depth = 0) {
    this.tick();
    if (depth > 500) throw new Error('Template is nested too deeply');
    if (typeof v === 'string') return this.string(v);
    if (Array.isArray(v)) {
      const first = v[0];
      if (first && typeof first === 'object' && !Array.isArray(first) && own(first, '$repeat')) {
        const n = first.$repeat;
        if (!Number.isInteger(n) || n < 0 || n > MAX_REPEAT) throw new Error(`"$repeat" must be an integer between 0 and ${MAX_REPEAT}`);
        const proto = {};
        for (const k of Object.keys(first)) if (k !== '$repeat') setProp(proto, k, first[k]);
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.template(proto, depth + 1));
        for (let i = 1; i < v.length; i++) out.push(this.template(v[i], depth + 1));
        return out;
      }
      return v.map(x => this.template(x, depth + 1));
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) setProp(out, k, this.template(v[k], depth + 1));
      return out;
    }
    return v;
  }

  // ---------------- schema based
  resolve(s, root) {
    let seen = 0;
    while (s && typeof s === 'object' && typeof s.$ref === 'string' && seen++ < 50) {
      if (!s.$ref.startsWith('#')) return {};
      let cur = root;
      const parts = s.$ref === '#' ? [] : s.$ref.slice(2).split('/').map(x => decodeURIComponent(x).replace(/~1/g, '/').replace(/~0/g, '~'));
      for (const p of parts) cur = cur && typeof cur === 'object' ? cur[p] : undefined;
      if (cur === undefined) return {};
      const rest = {};
      for (const k of Object.keys(s)) if (k !== '$ref') rest[k] = s[k];
      s = Object.keys(rest).length && cur && typeof cur === 'object' ? { ...cur, ...rest } : cur;
    }
    return s;
  }
  fromSchema(schema, root = schema, depth = 0, name = '') {
    this.tick();
    let s = this.resolve(schema, root);
    if (s === true || s === undefined || s === null || typeof s !== 'object') return this.pick([null, 'sample', 1, true]);
    if (Array.isArray(s)) return null;
    if (Array.isArray(s.allOf)) { // shallow merge
      const merged = { ...s }; delete merged.allOf;
      for (const sub of s.allOf) {
        const r = this.resolve(sub, root);
        if (!r || typeof r !== 'object') continue;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'properties' || k === 'patternProperties') merged[k] = { ...(merged[k] || {}), ...v };
          else if (k === 'required') merged.required = [...(merged.required || []), ...v];
          else if (merged[k] === undefined) merged[k] = v;
        }
      }
      s = merged;
    }
    if (s.const !== undefined) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return this.pick(s.enum);
    for (const k of ['oneOf', 'anyOf']) {
      if (Array.isArray(s[k]) && s[k].length) {
        const base = {};
        for (const x of Object.keys(s)) if (x !== k) base[x] = s[x];
        const branch = this.resolve(s[k][0], root);
        return this.fromSchema(branch && typeof branch === 'object' ? { ...base, ...branch } : base, root, depth + 1, name);
      }
    }
    let type = s.type;
    if (Array.isArray(type)) type = type.find(t => t !== 'null') || type[0];
    if (!type) type = s.properties ? 'object' : s.items || s.prefixItems ? 'array' : (s.minimum !== undefined || s.maximum !== undefined) ? 'number' : 'string';
    switch (type) {
      case 'null': return null;
      case 'boolean': return this.bool();
      case 'integer': case 'number': return this.number(s, type === 'integer', name);
      case 'string': return this.str(s, name);
      case 'array': {
        const min = Math.max(0, s.minItems ?? 0), max = Math.max(min, s.maxItems ?? Math.max(min, 3));
        let n = depth > 6 ? min : this.int(Math.max(min, Math.min(1, max)), Math.max(min, Math.min(max, min + 3, 5)));
        const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
        const rest = tuple ? (Array.isArray(s.items) ? s.additionalItems : s.items) : s.items;
        if (tuple) n = Math.max(n, Math.min(tuple.length, max));
        n = Math.min(n, 1000);
        const out = [];
        for (let i = 0; i < n; i++) {
          const item = tuple && i < tuple.length ? tuple[i] : rest;
          let tries = 0, v;
          do { v = this.fromSchema(item === undefined ? {} : item, root, depth + 1, name); tries++; }
          while (s.uniqueItems && tries < 10 && out.some(x => JSON.stringify(x) === JSON.stringify(v)));
          out.push(v);
        }
        return out;
      }
      case 'object': {
        const out = {}, req = new Set(Array.isArray(s.required) ? s.required : []);
        const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
        for (const k of Object.keys(props)) {
          if (!req.has(k) && (depth > 6 || this.rng() < 0.2)) continue;
          setProp(out, k, this.fromSchema(props[k], root, depth + 1, k));
        }
        for (const k of req) if (!own(out, k)) setProp(out, k, this.fromSchema({}, root, depth + 1, k));
        const minP = s.minProperties ?? 0;
        for (let i = 0; Object.keys(out).length < minP && i < 100; i++) out['extra' + i] = this.fromSchema(s.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : {}, root, depth + 1);
        return out;
      }
      default: return null;
    }
  }
  number(s, integer, name) {
    let lo = s.minimum ?? (typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + (integer ? 1 : 0.01) : undefined);
    let hi = s.maximum ?? (typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum - (integer ? 1 : 0.01) : undefined);
    if (lo === undefined && hi === undefined) { lo = 0; hi = /price|amount|total/i.test(name) ? 1000 : 100; }
    else if (lo === undefined) lo = hi - 100;
    else if (hi === undefined) hi = lo + 100;
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
      const a = Math.ceil(lo / s.multipleOf), b = Math.floor(hi / s.multipleOf);
      if (a <= b) return Number((this.int(a, b) * s.multipleOf).toPrecision(12));
    }
    return integer ? this.int(Math.ceil(lo), Math.max(Math.ceil(lo), Math.floor(hi))) : this.float(lo, hi);
  }
  str(s, name) {
    let v;
    switch (s.format) {
      case 'email': v = this.email(); break;
      case 'uuid': v = this.uuid(); break;
      case 'date': v = this.date(); break;
      case 'date-time': v = this.datetime(); break;
      case 'uri': case 'url': v = this.url(); break;
      case 'ipv4': v = this.ipv4(); break;
      case 'ipv6': v = Array.from({ length: 8 }, () => this.int(0, 65535).toString(16)).join(':'); break;
      default:
        if (/e-?mail/i.test(name)) v = this.email();
        else if (/(^|_)name$|^name/i.test(name)) v = this.name();
        else if (/city/i.test(name)) v = this.pick(CITIES);
        else if (/country/i.test(name)) v = this.pick(COUNTRIES);
        else if (/phone/i.test(name)) v = this.phone();
        else if (/url|link|website/i.test(name)) v = this.url();
        else v = this.lorem(this.int(2, 4)).replace(/\.$/, '');
    }
    const min = s.minLength ?? 0, max = s.maxLength ?? Infinity;
    if (v.length > max) v = v.slice(0, max);
    while (v.length < min) v += this.pick(WORDS)[0];
    return v;
  }
}

export function generateFromTemplate(template, opts = {}) {
  const v = typeof template === 'string' ? JSON.parse(template) : template;
  return new Gen(opts).template(v);
}
export function generateFromSchema(schema, opts = {}) {
  const s = typeof schema === 'string' ? JSON.parse(schema) : schema;
  return new Gen(opts).fromSchema(s);
}

export const SAMPLE_TEMPLATE = {
  users: [{ $repeat: 3, id: '{{uuid}}', name: '{{name}}', email: '{{email}}', age: '{{int(18,65)}}', score: '{{float(0,1)}}', active: '{{bool}}', joined: '{{date}}', role: '{{pick(admin,editor,viewer)}}', bio: '{{lorem(6)}}' }],
};

export const SAMPLE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['id', 'email', 'age'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 18, maximum: 99 },
    status: { enum: ['active', 'pending', 'disabled'] },
    tags: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 3, maxLength: 8 } },
    address: { type: 'object', required: ['city'], properties: { city: { type: 'string' }, zip: { type: 'string', maxLength: 5 } } },
  },
};
