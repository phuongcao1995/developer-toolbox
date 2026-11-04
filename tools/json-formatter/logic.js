// Pure JSON helpers (no DOM). Used by tool.js and testable in Node.

/** Convert a UI indent choice ('2' | '4' | 'tab' | raw whitespace string) to a JSON.stringify indent. */
export function indentFrom(choice) {
  if (choice === 'tab' || choice === '\t') return '\t';
  if (choice === '4') return 4;
  if (choice === '2') return 2;
  if (typeof choice === 'string' && /^\s+$/.test(choice)) return choice.includes('\t') ? '\t' : choice.length;
  return 2;
}

/** Map ctx.indentUnit (e.g. "  ", "    ", "\t") to the select value. */
export function choiceFromUnit(unit) {
  if (!unit) return '2';
  if (unit.includes('\t')) return 'tab';
  return unit.length >= 4 ? '4' : '2';
}

/** Translate a character offset into 1-based line/column. */
export function offsetToLineCol(text, pos) {
  const before = text.slice(0, Math.max(0, Math.min(pos, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export const MAX_DEPTH = 2000;
export const DEPTH_MESSAGE = `JSON is nested too deeply (limit ${MAX_DEPTH}) for this operation`;

const isObj = v => v !== null && typeof v === 'object';

/** Single-pass strict JSON scanner (iterative, no recursion). Calls onToken(type, start, end, isKey) for
 *  '{' '}' '[' ']' ',' ':' 'str' 'num' 'lit'. Throws Error {scanError:true, offset} on invalid syntax. */
export function scanJson(text, onToken) {
  const n = text.length, stack = []; // stack of '{' | '['
  let i = 0, state = 'value'; // value | valueOrEnd | keyOrEnd | key | colon | commaOrEnd | done
  const fail = (offset, what) => {
    const e = new Error(offset >= n ? 'Unexpected end of JSON input' : `Unexpected ${what || `token '${text[offset]}'`}`);
    e.scanError = true; e.offset = Math.min(offset, n); throw e;
  };
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const afterValue = () => { state = stack.length ? 'commaOrEnd' : 'done'; };
  for (;;) {
    while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; }
    if (i >= n) { if (state === 'done') return; fail(n); }
    const c = text[i], start = i;
    if (state === 'done') fail(i);
    if (state === 'colon') { if (c !== ':') fail(i); i++; onToken(':', start, i); state = 'value'; continue; }
    if (state === 'commaOrEnd') {
      const top = stack[stack.length - 1];
      if (c === ',') { i++; onToken(',', start, i); state = top === '{' ? 'key' : 'value'; continue; }
      if ((c === '}' && top === '{') || (c === ']' && top === '[')) { i++; stack.pop(); onToken(c, start, i); afterValue(); continue; }
      fail(i);
    }
    if (state === 'keyOrEnd' && c === '}') { i++; stack.pop(); onToken('}', start, i); afterValue(); continue; }
    if (state === 'valueOrEnd' && c === ']') { i++; stack.pop(); onToken(']', start, i); afterValue(); continue; }
    if (state === 'key' || state === 'keyOrEnd') {
      if (c !== '"') fail(i);
      i = scanString(text, i, fail); onToken('str', start, i, true); state = 'colon'; continue;
    }
    // a value is expected
    if (c === '{') { i++; stack.push('{'); onToken('{', start, i); state = 'keyOrEnd'; }
    else if (c === '[') { i++; stack.push('['); onToken('[', start, i); state = 'valueOrEnd'; }
    else if (c === '"') { i = scanString(text, i, fail); onToken('str', start, i, false); afterValue(); }
    else if (c === '-' || (c >= '0' && c <= '9')) {
      NUM.lastIndex = i; const m = NUM.exec(text);
      if (!m) fail(c === '-' ? i + 1 : i);
      i += m[0].length;
      if (i < n && /[0-9.eE+\-]/.test(text[i])) fail(i); // e.g. 01, 1.e5
      onToken('num', start, i); afterValue();
    } else if (text.startsWith('true', i)) { i += 4; onToken('lit', start, i); afterValue(); }
    else if (text.startsWith('false', i)) { i += 5; onToken('lit', start, i); afterValue(); }
    else if (text.startsWith('null', i)) { i += 4; onToken('lit', start, i); afterValue(); }
    else fail(i);
  }
}

function scanString(text, i, fail) {
  const n = text.length;
  i++; // opening quote
  for (;;) {
    if (i >= n) fail(n);
    const c = text.charCodeAt(i);
    if (c === 34) return i + 1;
    if (c < 32) fail(i, 'control character in string');
    if (c === 92) {
      const e = text[i + 1];
      if (e === undefined) fail(n);
      if (e === 'u') {
        for (let k = 2; k < 6; k++) if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) fail(Math.min(i + k, n), 'bad \\u escape');
        i += 6;
      } else if ('"\\/bfnrt'.includes(e)) i += 2;
      else fail(i + 1, `bad escape '\\${e}'`);
    } else i++;
  }
}

/** Short source excerpt around offset with a caret line. */
export function errorSnippet(text, offset) {
  const { line, column } = offsetToLineCol(text, offset);
  const src = (text.split('\n')[line - 1] ?? '').replace(/\r$/, '');
  const from = Math.max(0, column - 1 - 30), to = Math.min(src.length, column - 1 + 30);
  const excerpt = (from > 0 ? '…' : '') + src.slice(from, to).replace(/\t/g, ' ') + (to < src.length ? '…' : '');
  const caretPos = column - 1 - from + (from > 0 ? 1 : 0);
  return `${excerpt}\n${' '.repeat(Math.max(0, caretPos))}^`;
}

/** Parse JSON, returning {ok, value} or {ok:false, message, line, column, offset, snippet}. Position always comes from our own scanner. */
export function parseJson(text) {
  if (!text || !text.trim()) return { ok: false, message: 'Input is empty. Paste or upload some JSON.' };
  try { return { ok: true, value: JSON.parse(text) }; } catch (err) {
    const engine = String(err && err.message || err);
    let offset, msg = engine;
    try { scanJson(text, () => {}); } catch (se) { if (se.scanError) { offset = se.offset; msg = se.message; } }
    if (offset === undefined) {
      // Our scanner accepted it: the engine failed for another reason (e.g. stack depth).
      if (err instanceof RangeError) return { ok: false, message: `The JSON engine could not parse this document (${engine}). It is probably nested too deeply; try Lossless Format/Minify.` };
      return { ok: false, message: engine };
    }
    return scanErrorResult(text, offset, msg);
  }
}

/** Build a parseJson-style error result from a scanner error offset. */
export function scanErrorResult(text, offset, msg) {
  const { line, column } = offsetToLineCol(text, offset);
  return { ok: false, message: `${msg} (line ${line}, column ${column})`, line, column, offset, snippet: errorSnippet(text, offset) };
}

/** Recursively sort object keys (arrays keep order). Iterative, so depth is unlimited. */
export function sortKeys(v) {
  if (!isObj(v)) return v;
  const root = Array.isArray(v) ? [] : {};
  const stack = [[v, root]];
  while (stack.length) {
    const [src, dst] = stack.pop();
    const isArr = Array.isArray(src);
    const keys = isArr ? null : Object.keys(src).sort();
    const len = isArr ? src.length : keys.length;
    for (let i = 0; i < len; i++) {
      const k = isArr ? i : keys[i], c = src[k];
      let nv = c;
      if (isObj(c)) { nv = Array.isArray(c) ? [] : {}; stack.push([c, nv]); }
      if (isArr) dst[i] = nv; else Object.defineProperty(dst, k, { value: nv, enumerable: true, writable: true, configurable: true });
    }
  }
  return root;
}

/** Count nodes / depth for a validation summary (iterative). */
export function stats(value) {
  let nodes = 0, depth = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    nodes++; if (d > depth) depth = d;
    if (isObj(v)) for (const k of Object.keys(v)) stack.push([v[k], d + 1]);
  }
  return { nodes, depth };
}

/** Throw a friendly error when the value is nested deeper than `limit`. */
export function assertDepth(value, limit = MAX_DEPTH) {
  if (stats(value).depth > limit) throw new Error(DEPTH_MESSAGE);
}

export const formatJson = (value, indent = 2) => { assertDepth(value); return JSON.stringify(value, null, indent); };
export const minifyJson = value => { assertDepth(value); return JSON.stringify(value); };

// ---------------- Lossiness detection + lossless re-indent ----------------
/** Canonical "digits e exponent" form of a numeric literal (trailing zeros stripped); '0' for zero. */
function canonNumber(lit) {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lit);
  if (!m) return lit;
  let digits = m[1] + (m[2] || ''), exp = (m[3] ? parseInt(m[3], 10) : 0) - (m[2] ? m[2].length : 0);
  digits = digits.replace(/^0+/, '');
  if (!digits) return '0';
  const t = digits.length; digits = digits.replace(/0+$/, ''); exp += t - digits.length;
  return digits + 'e' + exp;
}

/** Would JSON.parse + JSON.stringify change this number literal's value? Returns null or a reason. */
export function numberLoss(lit) {
  const x = Number(lit);
  if (!Number.isFinite(x)) return 'overflows to Infinity (becomes null)';
  if (x === 0 && canonNumber(lit) !== '0') return 'underflows to 0';
  if (canonNumber(lit) !== canonNumber(x.toExponential())) return 'not exactly representable as a double';
  return null;
}

/** Single-pass scan of valid JSON text: lossy numbers and duplicate keys. Never throws; {ok:false} for invalid text. */
export function analyzeLossiness(text, { maxExamples = 20 } = {}) {
  const numbers = [], dups = [];
  let numberCount = 0, dupCount = 0;
  const frames = []; // {t:'{'|'[', keys:Set|null, idx, key}
  const seg = (f, key) => f.t === '[' ? `[${f.idx}]` : /^[A-Za-z_]\w*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  const pathOf = upto => { let p = '$'; for (let i = 0; i < upto; i++) p += seg(frames[i], frames[i].key); return p; };
  try {
    scanJson(text, (t, s, e, isKey) => {
      const top = frames[frames.length - 1];
      if (t === '{') frames.push({ t, keys: new Set(), idx: 0, key: '' });
      else if (t === '[') frames.push({ t, keys: null, idx: 0, key: '' });
      else if (t === '}' || t === ']') { frames.pop(); const p = frames[frames.length - 1]; if (p && p.t === '[') p.idx++; }
      else if (t === 'str' && isKey) {
        const raw = text.slice(s, e), k = raw.includes('\\') ? JSON.parse(raw) : raw.slice(1, -1);
        if (top.keys.has(k)) { dupCount++; if (dups.length < maxExamples) dups.push({ path: pathOf(frames.length - 1), key: k }); }
        else top.keys.add(k);
        top.key = k;
      } else if (t === 'num' || t === 'str' || t === 'lit') {
        if (t === 'num') {
          const lit = text.slice(s, e), why = numberLoss(lit);
          if (why) {
            numberCount++;
            if (numbers.length < maxExamples) numbers.push({ path: pathOf(frames.length), value: lit.length > 40 ? lit.slice(0, 37) + '...' : lit, reason: why, becomes: Number.isFinite(Number(lit)) ? String(Number(lit)) : 'null' });
          }
        }
        if (top && top.t === '[') top.idx++;
      }
    });
  } catch (e) { if (e.scanError) return { ok: false, numbers: [], dups: [], numberCount: 0, dupCount: 0, lossy: false }; throw e; }
  return { ok: true, numbers, dups, numberCount, dupCount, lossy: numberCount + dupCount > 0 };
}

/** One-line warning text for analyzeLossiness() output ('' when nothing is lossy). */
export function describeLossiness(a, maxShown = 3) {
  if (!a || !a.lossy) return '';
  const parts = [];
  if (a.numberCount) parts.push(`${a.numberCount} number${a.numberCount > 1 ? 's' : ''} lose precision (` +
    a.numbers.slice(0, maxShown).map(x => `${x.path}: ${x.value} becomes ${x.becomes}`).join('; ') + (a.numberCount > maxShown ? '; ...' : '') + ')');
  if (a.dupCount) parts.push(`${a.dupCount} duplicate key${a.dupCount > 1 ? 's are' : ' is'} dropped, last one wins (` +
    a.dups.slice(0, maxShown).map(x => `${x.path}.${x.key}`).join('; ') + (a.dupCount > maxShown ? '; ...' : '') + ')');
  return 'Formatting will change these values: ' + parts.join(' | ') + '.';
}

/** Re-indent/minify JSON text WITHOUT JSON.parse: number literals, string escapes and duplicate keys are kept verbatim.
 *  Validates syntax (throws Error with .offset). Pretty-printing is limited to MAX_DEPTH levels; minify is unlimited. */
export function reformatLossless(text, { indent = 2, minify = false } = {}) {
  const unit = minify ? '' : indent === 'tab' || indent === '\t' ? '\t' : typeof indent === 'number' ? ' '.repeat(indent) : String(indent);
  const out = [];
  let depth = 0, prev = '';
  const nl = d => { if (!minify) out.push('\n' + unit.repeat(d)); };
  scanJson(text, (t, s, e) => {
    const isClose = t === '}' || t === ']', isOpen = t === '{' || t === '[';
    if ((prev === '{' || prev === '[') && !isClose) nl(depth);
    if (isOpen) {
      depth++;
      if (!minify && depth > MAX_DEPTH) { const er = new Error(`JSON is nested too deeply (limit ${MAX_DEPTH}) to pretty-print; use Minify`); er.offset = s; throw er; }
      out.push(t);
    } else if (isClose) {
      depth--;
      if (prev !== '{' && prev !== '[') nl(depth);
      out.push(t);
    } else if (t === ',') { out.push(','); nl(depth); }
    else if (t === ':') out.push(minify ? ':' : ': ');
    else out.push(text.slice(s, e));
    prev = t;
  });
  return out.join('');
}

export const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

// ---------------- XML ----------------
/** Escape text/attribute content. Characters illegal in XML 1.0 (most control chars, lone surrogates, U+FFFE/F) are dropped. */
const xmlEscape = s => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
/** Attribute values additionally keep tab/newline/CR as character references (otherwise XML parsers normalise them to spaces). */
const xmlAttr = s => xmlEscape(s).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

/** Is `key` usable verbatim as an XML element name (no colon; unicode letters allowed; not starting with "xml")? */
export const isXmlName = key => /^[A-Za-z_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][A-Za-z0-9_.\-\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]*$/.test(key) && !/^xml/i.test(key);

/** Legacy helper: force a string into a legal XML name (invalid characters -> "_"). */
export function xmlName(key) {
  let n = String(key).replace(/[^A-Za-z0-9_.\-]/g, '_');
  if (!/^[A-Za-z_]/.test(n)) n = '_' + n;
  if (/^xml/i.test(n)) n = '_' + n;
  return n;
}

/**
 * JSON -> XML.
 *  - arrays become repeated elements named after their key ("item" at the root, and for arrays inside arrays)
 *  - keys that are not valid XML names are written as <item key="original key"> (the key is attribute-escaped)
 *  - null -> <x xsi:nil="true"/> (xmlns:xsi declared on the root element) or, with nullMode 'empty', <x/>
 *  - options: root (default "root"; an invalid name falls back to "root"),
 *    wrapRoot (default true; false + object with exactly one key => that key becomes the root element),
 *    indent (string | number), nullMode ('nil' | 'empty'), declaration (default true)
 */
export function toXml(value, { root = 'root', indent = '  ', wrapRoot = true, nullMode = 'nil', declaration = true } = {}) {
  assertDepth(value);
  const unit = typeof indent === 'number' ? ' '.repeat(indent) : (indent || '');
  const nl = unit ? '\n' : '';
  const out = [];
  let usedNil = false;
  const open = name => isXmlName(name) ? { tag: name, attr: '' } : { tag: 'item', attr: ` key="${xmlAttr(name)}"` };
  function elem(name, v, lvl) {
    const pad = unit.repeat(lvl);
    const { tag, attr } = open(name);
    if (Array.isArray(v)) {
      if (!v.length) { out.push(`${pad}<${tag}${attr}/>`); return; }
      for (const item of v) {
        if (Array.isArray(item)) { // nested array: keep the structure with an explicit wrapper
          if (!item.length) { out.push(`${pad}<${tag}${attr}/>`); continue; }
          out.push(`${pad}<${tag}${attr}>`);
          for (const x of item) elem('item', x, lvl + 1);
          out.push(`${pad}</${tag}>`);
        } else elem(name, item, lvl);
      }
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) { out.push(`${pad}<${tag}${attr}/>`); return; }
      out.push(`${pad}<${tag}${attr}>`);
      for (const k of keys) elem(k, v[k], lvl + 1);
      out.push(`${pad}</${tag}>`);
    } else if (v === null) {
      if (nullMode === 'empty') out.push(`${pad}<${tag}${attr}/>`);
      else { usedNil = true; out.push(`${pad}<${tag}${attr} xsi:nil="true"/>`); }
    } else out.push(`${pad}<${tag}${attr}>${xmlEscape(v)}</${tag}>`);
  }
  let rootTag = isXmlName(root) ? root : 'root';
  const single = !wrapRoot && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1;
  if (single) { const k = Object.keys(value)[0]; elem(k, value[k], 0); }
  else if (Array.isArray(value)) {
    out.push(`<${rootTag}>`);
    for (const item of value) elem('item', item, 1);
    out.push(`</${rootTag}>`);
  } else elem(rootTag, value, 0);
  if (usedNil) {
    // declare the xsi namespace on the first (root) element
    const i = out.findIndex(l => l.startsWith('<'));
    out[i] = out[i].replace(/^<([^\s/>]+)/, '<$1 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  }
  return (declaration ? '<?xml version="1.0" encoding="UTF-8"?>' + nl : '') + out.join(nl);
}

// ---------------- CSV ----------------
/** Escape '.' and '\' in a key so dot-joined paths stay unambiguous. */
const escKey = k => String(k).replace(/[\\.]/g, m => '\\' + m);

/** Flatten nested objects/arrays to dot-keyed primitives: {a:{b:1},c:[2]} -> {'a.b':1,'c.0':2}.
 *  Dots/backslashes inside keys are escaped with a backslash ({'a.b':1} -> {'a\.b':1}) so paths never collide.
 *  Iterative (no recursion). Pass opts.collisions (array) to collect any remaining duplicate paths. */
export function flatten(v, prefix = '', out = {}, opts = {}) {
  const stack = [[v, prefix]];
  while (stack.length) {
    const [val, path] = stack.pop();
    if (val && typeof val === 'object') {
      const keys = Object.keys(val);
      if (!keys.length) { put(path || 'value', Array.isArray(val) ? '[]' : '{}'); continue; }
      for (let i = keys.length - 1; i >= 0; i--) stack.push([val[keys[i]], path ? path + '.' + escKey(keys[i]) : escKey(keys[i])]);
    } else put(path || 'value', val);
  }
  function put(k, x) {
    if (Object.prototype.hasOwnProperty.call(out, k)) opts.collisions?.push(k);
    Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Neutralise spreadsheet formulas: prefix a single quote when a cell starts with = + - @ tab or CR. */
export const guardFormula = s => /^[=+\-@\t\r]/.test(s) ? "'" + s : s;

export function csvCell(v, delimiter = ',', escapeFormulas = false) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (escapeFormulas && typeof v === 'string') s = guardFormula(s);
  return s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ?`"${s.replace(/"/g, '""')}"` : s;
}

/** JSON -> CSV. Accepts array of objects (or primitives) or a single object. Throws Error for unsupported shapes.
 *  Second arg: delimiter string or {delimiter, escapeFormulas, warnings:[]}. */
export function toCsv(value, options = ',') {
  const o = typeof options === 'string' ? { delimiter: options } : (options || {});
  const delimiter = o.delimiter || ',', esc = !!o.escapeFormulas;
  let rows;
  if (Array.isArray(value)) rows = value;
  else if (value && typeof value === 'object') rows = [value];
  else throw new Error('CSV needs an array of objects (or a single object); got a ' + typeOf(value) + '.');
  if (!rows.length) throw new Error('The array is empty, so there is nothing to put in a CSV.');
  const collisions = [];
  const flat = rows.map(r => flatten(r, '', {}, { collisions }));
  if (collisions.length && o.warnings) o.warnings.push(`${collisions.length} column name collision(s) (e.g. "${collisions[0]}"); later values overwrite earlier ones.`);
  const headers = [], seen = new Set();
  for (const f of flat) for (const k of Object.keys(f)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  const line = cells => cells.map(c => csvCell(c, delimiter, esc)).join(delimiter);
  return [line(headers), ...flat.map(f => line(headers.map(h => f[h])))].join('\r\n');
}

// ---------------- YAML ----------------
const YAML_RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
const YAML_NUMBERISH = /^[-+]?(\.\d+|\d[\d_]*(\.\d*)?)([eE][-+]?\d+)?$|^0[xo][0-9a-f]+$|^[-+]?\.(inf|nan)$/i;

/** Quote a string only when YAML would otherwise misread it (booleans, numbers, special chars, whitespace, newlines...). */
export function yamlString(s) {
  const safe = /^[A-Za-z0-9_][A-Za-z0-9_ .\/@()+=\-]*$/.test(s) && !/\s$/.test(s) &&
    !YAML_RESERVED.test(s) && !YAML_NUMBERISH.test(s) && !/^\d{4}-\d\d-\d\d/.test(s);
  return safe ? s : JSON.stringify(s); // JSON double-quoted strings are valid YAML double-quoted scalars
}

const isContainer = v => v && typeof v === 'object' && Object.keys(v).length > 0;

function yamlInline(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return yamlString(v);
  if (typeof v === 'object') return Array.isArray(v) ? '[]' : '{}';
  return Object.is(v, -0) ? '0' : String(v);
}

/** JSON -> YAML (block style). `step` = spaces per nesting level (YAML forbids tabs). */
export function toYaml(value, step = 2) {
  assertDepth(value);
  function block(v, ind) {
    const p = ' '.repeat(ind), lines = [];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isContainer(item)) {
          // Compact "- key: value": nested block is indented by 2 so keys line up after "- ".
          const sub = block(item, ind + 2);
          sub[0] = p + '- ' + sub[0].slice(ind + 2);
          lines.push(...sub);
        } else lines.push(`${p}- ${yamlInline(item)}`);
      }
    } else {
      for (const k of Object.keys(v)) {
        const key = yamlString(k), val = v[k];
        if (isContainer(val)) { lines.push(`${p}${key}:`); lines.push(...block(val, ind + step)); }
        else lines.push(`${p}${key}: ${yamlInline(val)}`);
      }
    }
    return lines;
  }
  if (!isContainer(value)) return yamlInline(value);
  return block(value, 0).join('\n');
}
