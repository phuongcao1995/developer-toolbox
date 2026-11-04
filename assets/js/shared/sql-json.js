// Shared SQL -> JSON converter (pure, no DOM). Converts INSERT ... VALUES statements into row objects.
//
//   sqlToJson(sql, { dialect, indent })  -> { ok, json, data, tables, rows, notes[] }  or  { ok:false, error }
//
// Supported: INSERT [IGNORE] [INTO] t [(cols)] VALUES (...), (...);  REPLACE INTO ... VALUES ...
// Values: 'strings' ('' escapes; backslash escapes only in dialects that have them), numbers (negative too), NULL, TRUE/FALSE,
// hex (0xFF / X'FF' kept as strings), and expressions / function calls such as NOW() (kept as their SQL text, with a note).
import { tokenize, SQL_DIALECTS } from '../../../tools/sql-formatter/logic.js';

const SIMPLE_ESC = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a' };

function decodeString(text, backslash) {
  let body = text, prefix = '';
  const m = /^([A-Za-z]?)(['"])/.exec(text);
  if (m) { prefix = m[1]; body = text.slice(m[0].length); }
  const q = m ? m[2] : "'";
  if (body.endsWith(q)) body = body.slice(0, -1);
  const bs = backslash || /^[eE]$/.test(prefix);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === q && body[i + 1] === q) { out += q; i++; }
    else if (bs && c === '\\' && i + 1 < body.length) {
      const d = body[++i];
      if (d in SIMPLE_ESC) out += SIMPLE_ESC[d];
      else if (d === 'x' && /^[0-9a-fA-F]{2}/.test(body.slice(i + 1, i + 3))) { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; }
      else if (d === 'u' && /^[0-9a-fA-F]{4}/.test(body.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
      else out += d; // \' \" \\ \% and unknown escapes: the character itself
    } else out += c;
  }
  return { value: out, prefix: prefix.toUpperCase() };
}

/** Convert one VALUES item (token slice) to a JS value. Returns {value, note?}. */
function convertItem(toks, src, backslash, estrDialect) {
  if (toks.length === 1) {
    const t = toks[0];
    if (t.type === 'string') {
      const d = decodeString(t.text, backslash || (estrDialect && /^[eE]/.test(t.text)));
      if (d.prefix === 'X') return { value: '0x' + d.value, note: 'hex literal kept as a string' };
      if (d.prefix === 'B') return { value: d.value, note: 'bit-string literal kept as a string' };
      return { value: d.value };
    }
    if (t.type === 'number') {
      if (/^0[xX]/.test(t.text)) return { value: t.text, note: 'hex literal kept as a string' };
      const num = Number(t.text);
      if (Number.isFinite(num) && (!/^[+-]?\d+$/.test(t.text) || Number.isSafeInteger(num))) return { value: num };
      return { value: t.text, note: 'number outside the safe range kept as a string to preserve precision' };
    }
    if (t.type === 'word') {
      const u = t.text.toUpperCase();
      if (u === 'NULL') return { value: null };
      if (u === 'TRUE') return { value: true };
      if (u === 'FALSE') return { value: false };
      if (u === 'DEFAULT') return { value: 'DEFAULT', note: 'DEFAULT keyword kept as a string' };
    }
  }
  if (toks.length === 2 && toks[0].type === 'op' && (toks[0].text === '-' || toks[0].text === '+') && toks[1].type === 'number') {
    const num = Number(toks[1].text);
    if (!/^0[xX]/.test(toks[1].text) && Number.isFinite(num) && (!/^\d+$/.test(toks[1].text) || Number.isSafeInteger(num))) return { value: toks[0].text === '-' ? -num : num };
    return { value: toks[0].text + toks[1].text, note: 'number kept as a string to preserve precision' };
  }
  const raw = src.slice(toks[0].pos, toks[toks.length - 1].pos + toks[toks.length - 1].text.length);
  return { value: raw, note: 'SQL expression kept as its text (not evaluated)' };
}

const nameOf = t => {
  const x = t.text;
  if (t.type === 'ident') { const a = x[0]; return a === '[' ? x.slice(1, -1) : x.slice(1, x.endsWith(a) ? -1 : undefined).split(a + a).join(a); }
  return x;
};

export function sqlToJson(sql, { dialect = 'standard', indent = 2 } = {}) {
  try {
    if (typeof sql !== 'string' || !sql.trim()) return { ok: false, error: 'Enter an INSERT ... VALUES statement to convert.' };
    const D = SQL_DIALECTS[dialect] || SQL_DIALECTS.standard;
    const toks = tokenize(sql, { dialect }).filter(t => t.type !== 'lcomment' && t.type !== 'bcomment');
    const stmts = []; let cur = [];
    for (const t of toks) { if (t.type === 'op' && t.text === ';') { if (cur.length) stmts.push(cur); cur = []; } else cur.push(t); }
    if (cur.length) stmts.push(cur);
    if (!stmts.length) return { ok: false, error: 'No SQL statements found.' };

    const tables = new Map(); const notes = []; const noteSet = new Set();
    const note = (msg) => { if (!noteSet.has(msg)) { noteSet.add(msg); notes.push(msg); } };
    const up = (T, i) => (T[i]?.type === 'word' ? T[i].text.toUpperCase() : '');

    for (let si = 0; si < stmts.length; si++) {
      const T = stmts[si];
      const first = up(T, 0);
      if (first !== 'INSERT' && first !== 'REPLACE') {
        return { ok: false, error: `Statement ${si + 1} starts with ${T[0].text.toUpperCase()}: only INSERT ... VALUES statements can be converted to JSON.` };
      }
      let i = 1;
      while (['IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'OR'].includes(up(T, i)) || (up(T, i - 1) === 'OR' && T[i])) i++;
      if (up(T, i) === 'INTO') i++;
      const parts = [];
      while (T[i] && (T[i].type === 'word' || T[i].type === 'ident')) {
        parts.push(nameOf(T[i])); i++;
        if (T[i]?.text === '.' && (T[i + 1]?.type === 'word' || T[i + 1]?.type === 'ident')) i++; else break;
      }
      if (!parts.length) return { ok: false, error: `Statement ${si + 1}: could not find the table name after ${first}.` };
      const table = parts.join('.');
      let cols = null;
      if (T[i]?.text === '(') {
        cols = []; i++;
        while (i < T.length && T[i].text !== ')') {
          if (T[i].text !== ',') { if (T[i].type !== 'word' && T[i].type !== 'ident') return { ok: false, error: `Statement ${si + 1}: unexpected "${T[i].text}" in the column list.` }; cols.push(nameOf(T[i])); }
          i++;
        }
        if (T[i]?.text !== ')') return { ok: false, error: `Statement ${si + 1}: the column list is missing its closing parenthesis.` };
        i++;
      }
      if (up(T, i) === 'SELECT' || up(T, i) === 'WITH') return { ok: false, error: `Statement ${si + 1}: INSERT ... SELECT cannot be converted; only INSERT ... VALUES lists are supported.` };
      if (up(T, i) === 'DEFAULT' && up(T, i + 1) === 'VALUES') return { ok: false, error: `Statement ${si + 1}: INSERT DEFAULT VALUES has no data to convert.` };
      if (up(T, i) !== 'VALUES' && up(T, i) !== 'VALUE') return { ok: false, error: `Statement ${si + 1}: expected VALUES after the table name, found ${T[i] ? '"' + T[i].text + '"' : 'end of statement'}.` };
      i++;
      const rows = tables.get(table) || []; tables.set(table, rows);
      let rowNo = 0;
      for (;;) {
        if (up(T, i) === 'ROW') i++;
        if (T[i]?.text !== '(') return { ok: false, error: `Statement ${si + 1}: expected "(" to start row ${rowNo + 1}${T[i] ? ', found "' + T[i].text + '"' : ''}.` };
        i++;
        const items = []; let itemToks = [], depth = 0, closed = false;
        for (; i < T.length; i++) {
          const t = T[i];
          if (t.type === 'op' && t.text === '(') depth++;
          if (t.type === 'op' && t.text === ')') {
            if (depth === 0) { items.push(itemToks); closed = true; i++; break; }
            depth--;
          }
          if (depth === 0 && t.type === 'op' && t.text === ',') { items.push(itemToks); itemToks = []; continue; }
          itemToks.push(t);
        }
        if (!closed) return { ok: false, error: `Statement ${si + 1}: row ${rowNo + 1} is missing its closing parenthesis.` };
        rowNo++;
        if (items.some(it => !it.length)) return { ok: false, error: `Statement ${si + 1}, row ${rowNo}: empty value in the list.` };
        const keys = cols || items.map((_, k) => `column_${k + 1}`);
        if (!cols) note('No column list in the INSERT: keys were named column_1, column_2, ...');
        if (items.length !== keys.length) return { ok: false, error: `Statement ${si + 1}, row ${rowNo}: ${items.length} value${items.length === 1 ? '' : 's'} but ${keys.length} column${keys.length === 1 ? '' : 's'}.` };
        const obj = {};
        items.forEach((it, k) => {
          const r = convertItem(it, sql, D.backslash, D.estr);
          if (r.note) note(`${keys[k]}: ${r.note}`);
          Object.defineProperty(obj, keys[k], { value: r.value, enumerable: true, writable: true, configurable: true }); // safe even for "__proto__"
        });
        rows.push(obj);
        if (T[i]?.text === ',') { i++; continue; }
        break;
      }
      if (i < T.length) {
        const tail = up(T, i);
        if (tail === 'ON' || tail === 'RETURNING' || tail === 'AS') note(`Statement ${si + 1}: trailing "${tail} ..." clause was ignored.`);
        else return { ok: false, error: `Statement ${si + 1}: unexpected "${T[i].text}" after the VALUES list.` };
      }
    }
    const names = [...tables.keys()];
    const data = names.length === 1 ? tables.get(names[0]) : Object.fromEntries(names.map(n => [n, tables.get(n)]));
    const rowCount = names.reduce((a, n) => a + tables.get(n).length, 0);
    return { ok: true, data, json: JSON.stringify(data, null, indent), tables: names, rows: rowCount, shape: names.length === 1 ? 'array' : 'object', notes };
  } catch (e) {
    return { ok: false, error: `Could not convert this input: ${e && e.message ? e.message : e}` };
  }
}
