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

/** Parse JSON, returning {ok, value} or {ok:false, message, line?, column?, offset?}. Extracts location from engine messages. */
export function parseJson(text) {
  if (!text || !text.trim()) return { ok: false, message: 'Input is empty. Paste or upload some JSON.' };
  try { return { ok: true, value: JSON.parse(text) }; } catch (err) {
    const msg = String(err.message || err);
    let line, column, offset;
    let m;
    if ((m = msg.match(/line (\d+) column (\d+)/i))) { line = +m[1]; column = +m[2]; }
    else if ((m = msg.match(/position (\d+)/i))) { offset = +m[1]; ({ line, column } = offsetToLineCol(text, offset)); }
    else if (/end of (JSON )?input|unexpected end/i.test(msg)) { offset = text.length; ({ line, column } = offsetToLineCol(text, offset)); }
    if (line && offset === undefined) {
      const ls = text.split('\n'); offset = ls.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0) + column - 1;
    }
    const where = line ? ` (line ${line}, column ${column})` : '';
    return { ok: false, message: msg.replace(/\s*\(line \d+ column \d+\)/, '') + where, line, column, offset };
  }
}

/** Recursively sort object keys (arrays keep order). */
export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

export const formatJson = (value, indent = 2) => JSON.stringify(value, null, indent);
export const minifyJson = value => JSON.stringify(value);

/** Count nodes / depth for a validation summary. */
export function stats(value) {
  let nodes = 0, depth = 0;
  (function walk(v, d) {
    nodes++; depth = Math.max(depth, d);
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], d + 1);
  })(value, 1);
  return { nodes, depth };
}

export const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

// ---------------- XML ----------------
const xmlEscape = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // control chars are illegal in XML 1.0
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Make a legal XML element name. */
export function xmlName(key) {
  let n = String(key).replace(/[^A-Za-z0-9_.\-]/g, '_');
  if (!/^[A-Za-z_]/.test(n)) n = '_' + n;
  if (/^xml/i.test(n)) n = '_' + n;
  return n;
}

/** JSON -> XML. Arrays become repeated elements named after their key (or "item" at the root). */
export function toXml(value, { root = 'root', indent = '  ' } = {}) {
  const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  function elem(name, v, lvl) {
    const pad = unit.repeat(lvl);
    const nm = xmlName(name);
    const keyAttr = nm !== name ? ` name="${xmlEscape(name)}"` : '';
    if (Array.isArray(v)) {
      // One element per item with the same tag; empty array -> empty element.
      if (!v.length) { out.push(`${pad}<${nm}${keyAttr}/>`); return; }
      for (const item of v) elem(name, item, lvl);
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) { out.push(`${pad}<${nm}${keyAttr}/>`); return; }
      out.push(`${pad}<${nm}${keyAttr}>`);
      for (const k of keys) elem(k, v[k], lvl + 1);
      out.push(`${pad}</${nm}>`);
    } else if (v === null) out.push(`${pad}<${nm}${keyAttr} nil="true"/>`);
    else out.push(`${pad}<${nm}${keyAttr}>${xmlEscape(v)}</${nm}>`);
  }
  if (Array.isArray(value)) {
    out.push(`<${root}>`);
    for (const item of value) elem('item', item, 1);
    out.push(`</${root}>`);
  } else elem(root, value, 0);
  return out.join('\n');
}

// ---------------- CSV ----------------
/** Flatten nested objects/arrays to dot-keyed primitives: {a:{b:1},c:[2]} -> {'a.b':1,'c.0':2}. */
export function flatten(v, prefix = '', out = {}) {
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) { out[prefix || 'value'] = Array.isArray(v) ? '[]' : '{}'; return out; }
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix || 'value'] = v;
  return out;
}

export function csvCell(v, delimiter = ',') {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** JSON -> CSV. Accepts array of objects (or primitives) or a single object. Throws Error for unsupported shapes. */
export function toCsv(value, delimiter = ',') {
  let rows;
  if (Array.isArray(value)) rows = value;
  else if (value && typeof value === 'object') rows = [value];
  else throw new Error('CSV needs an array of objects (or a single object); got a ' + typeOf(value) + '.');
  if (!rows.length) throw new Error('The array is empty, so there is nothing to put in a CSV.');
  const flat = rows.map(r => flatten(r));
  const headers = [], seen = new Set();
  for (const f of flat) for (const k of Object.keys(f)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  const line = cells => cells.map(c => csvCell(c, delimiter)).join(delimiter);
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
