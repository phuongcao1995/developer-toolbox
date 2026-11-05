// Pure XML logic (no DOM): a strict well-formedness scanner that builds a lightweight tree, a formatter/minifier,
// XML <-> JSON converters and XPath-string helpers. Never resolves external resources and refuses entity-expansion bombs.

export const DEFAULTS = {
  maxEntityDecls: 10,        // DOCTYPE ENTITY declarations allowed (billion-laughs guard)
  maxEntityExpansion: 10_000_000, // total characters all entity references may expand to
  maxDepth: 2000,
};

const NAME_START = '[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}]';
const NAME_CHAR = '[:A-Z_a-z\\-.0-9\\u00B7\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u203F\\u2040\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}]';
const NAME_SRC = `${NAME_START}${NAME_CHAR}*`;
export const isXmlName = s => new RegExp(`^${NAME_SRC}$`, 'u').test(s);
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const WS = ' \t\r\n';
const isWs = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const PREDEFINED = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

// ---------------------------------------------------------------- positions
export function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13 && text.charCodeAt(i + 1) !== 10) starts.push(i + 1);
  }
  return starts;
}
/** 1-based { line, column } for an offset, using precomputed line starts. */
export function positionAt(starts, offset, bom = false) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  let column = offset - starts[lo] + 1;
  if (bom && lo === 0 && offset > 0) column -= 1;
  return { line: lo + 1, column };
}
export const formatError = e => `Line ${e.line}, column ${e.column}: ${e.message}`;
const describeChar = ch => {
  if (ch === undefined) return 'end of input';
  const cp = ch.codePointAt(0);
  if (cp < 32 || cp === 127) return `control character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  return `'${ch}'`;
};

class Fail { constructor(message, offset) { this.message = message; this.offset = offset; } }

const validXmlChar = cp => cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);

// ---------------------------------------------------------------- scanner
/**
 * Parse XML. Returns { ok:true, doc, stats, namespaces, warnings, entities } or { ok:false, error:{message,offset,line,column} }.
 * doc = { children:[node], root, decl, doctype, lineStarts, bom }. Nodes (all carry `offset`):
 *   element {type:'element', name, prefix, local, ns, attrs:[{name,raw,quote,offset}], children, selfClosing, parent, depth}
 *   text {type:'text', value}   cdata {type:'cdata', value}   comment {type:'comment', value}   pi {type:'pi', target, data}
 *   decl / doctype nodes also appear in doc.children.
 */
export function parse(input, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const text = String(input ?? '');
  const bom = text.charCodeAt(0) === 0xFEFF;
  const start = bom ? 1 : 0;
  const n = text.length;
  const lineStarts = lineStartsOf(text);
  const failResult = f => ({ ok: false, error: { message: f.message, offset: f.offset, ...positionAt(lineStarts, Math.min(f.offset, n), bom) } });
  try {
    return scan(text, n, start, bom, lineStarts, o);
  } catch (e) {
    if (e instanceof Fail) return failResult(e);
    throw e;
  }
}

function scan(text, n, start, bom, lineStarts, o) {
  const fail = (message, offset) => { throw new Fail(message, offset); };
  const nameRe = new RegExp(NAME_SRC, 'uy');
  const readName = at => { nameRe.lastIndex = at; const m = nameRe.exec(text); return m ? m[0] : null; };
  const skipWs = at => { while (at < n && isWs(text[at])) at++; return at; };
  const lineOf = off => positionAt(lineStarts, off, bom);
  const where = off => { const p = lineOf(off); return `line ${p.line}, column ${p.column}`; };

  const bad = text.slice(start).search(BAD_CHARS);
  if (bad !== -1) { const at = start + bad; fail(`Invalid character U+${text.charCodeAt(at).toString(16).toUpperCase().padStart(4, '0')} (control characters are not allowed in XML)`, at); }

  const doc = { children: [], root: null, decl: null, doctype: null, lineStarts, bom };
  const stats = { elements: 0, attributes: 0, textNodes: 0, comments: 0, cdata: 0, pis: 0, maxDepth: 0, entityDecls: 0 };
  const names = new Set();
  const namespaces = [];
  const warnings = [];
  const entities = new Map(); // declared internal general entities: name -> literal value
  let hasExternalSubset = false, standalone = false, expansion = 0;

  const checkRefs = (seg, base) => {
    let i = seg.indexOf('&');
    while (i !== -1) {
      const m = /^&(?:#([0-9]+)|#x([0-9a-fA-F]+)|([^;&<>\s"'=]+));/.exec(seg.slice(i, i + 80));
      const at = base + i;
      if (!m) fail("Invalid entity reference: a bare '&' must be written as &amp; (valid references look like &lt; &#65; &#x41; or &name;)", at);
      if (m[1] !== undefined || m[2] !== undefined) {
        const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
        if (!validXmlChar(cp)) fail(`Character reference ${m[0]} refers to a character that is not allowed in XML`, at);
      } else {
        const nm = m[3];
        if (!isXmlName(nm)) fail(`Invalid entity reference ${m[0]}`, at);
        if (!PREDEFINED.has(nm)) {
          if (entities.has(nm)) {
            expansion += entities.get(nm).length;
            if (expansion > o.maxEntityExpansion) fail('Entity references expand to more than 10 million characters; refused to avoid an entity-expansion attack', at);
          } else if (hasExternalSubset && !standalone) {
            if (!warnings.some(w => w.includes(`&${nm};`))) warnings.push(`Entity &${nm}; is not declared in the internal subset; it may be declared in the external DTD, which is never loaded.`);
          } else fail(`Entity &${nm}; is not declared (only &lt; &gt; &amp; &quot; &apos; and numeric references are predefined; declare others in a DOCTYPE)`, at);
        }
      }
      i = seg.indexOf('&', i + m[0].length);
    }
  };

  const parseDecl = (at, endAt) => {
    // at points at "<?xml"; body is text between and endAt ("?>")
    const body = text.slice(at + 5, endAt);
    if (body && !isWs(body[0])) fail("Malformed XML declaration (expected whitespace after '<?xml')", at);
    const re = /\s+([A-Za-z]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
    const decl = { version: null, encoding: null, standalone: null, offset: at, type: 'decl' };
    let p = 0, order = [];
    for (;;) {
      re.lastIndex = p; const m = re.exec(body);
      if (!m) break;
      const val = m[3] ?? m[4];
      if (!['version', 'encoding', 'standalone'].includes(m[1])) fail(`Unknown XML declaration attribute '${m[1]}'`, at);
      if (decl[m[1]] !== null) fail(`Duplicate XML declaration attribute '${m[1]}'`, at);
      decl[m[1]] = val; order.push(m[1]); p = re.lastIndex;
    }
    if (body.slice(p).trim() !== '') fail('Malformed XML declaration (expected version="1.0" encoding="..." standalone="yes|no")', at);
    if (decl.version === null) fail('The XML declaration must have a version attribute', at);
    if (order[0] !== 'version') fail("In the XML declaration 'version' must come first", at);
    if (!/^1\.[0-9]+$/.test(decl.version)) fail(`Unsupported XML version '${decl.version}' (expected 1.0 or 1.1)`, at);
    if (order.includes('standalone') && order.includes('encoding') && order.indexOf('standalone') < order.indexOf('encoding')) fail("In the XML declaration 'encoding' must come before 'standalone'", at);
    if (decl.encoding !== null && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(decl.encoding)) fail(`Invalid encoding name '${decl.encoding}' in the XML declaration`, at);
    if (decl.standalone !== null && decl.standalone !== 'yes' && decl.standalone !== 'no') fail(`standalone must be "yes" or "no", not "${decl.standalone}"`, at);
    if (decl.encoding && !/^(utf-?8|utf-?16|us-ascii)$/i.test(decl.encoding)) warnings.push(`The declaration says encoding="${decl.encoding}". The text here is Unicode, so the declaration is kept but you must save the file in that encoding yourself.`);
    if (decl.encoding && /^utf-?16$/i.test(decl.encoding)) warnings.push('encoding="UTF-16" is declared; make sure the file is actually saved as UTF-16 (most tools write UTF-8).');
    standalone = decl.standalone === 'yes';
    return decl;
  };

  const parseDoctype = at => {
    let k = at + 9;
    if (!isWs(text[k])) fail("Expected whitespace after '<!DOCTYPE'", at);
    k = skipWs(k);
    const name = readName(k);
    if (!name) fail('Invalid DOCTYPE name', k);
    k = skipWs(k + name.length);
    let publicId = null, systemId = null;
    const lit = () => {
      const q = text[k];
      if (q !== '"' && q !== "'") fail('Expected a quoted literal in the DOCTYPE', k);
      const e = text.indexOf(q, k + 1);
      if (e === -1) fail('Unterminated literal in the DOCTYPE', k);
      const v = text.slice(k + 1, e); k = skipWs(e + 1); return v;
    };
    if (text.startsWith('SYSTEM', k)) { k = skipWs(k + 6); systemId = lit(); hasExternalSubset = true; }
    else if (text.startsWith('PUBLIC', k)) { k = skipWs(k + 6); publicId = lit(); systemId = lit(); hasExternalSubset = true; }
    let subset = null, subsetAt = 0;
    if (text[k] === '[') {
      subsetAt = k + 1;
      let j = k + 1, q = null;
      for (; j < n; j++) {
        const c = text[j];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '<' && text.startsWith('<!--', j)) { const e = text.indexOf('-->', j + 4); if (e === -1) fail('Unterminated comment in the DOCTYPE', j); j = e + 2; continue; }
        if (c === '<' && text.startsWith('<?', j)) { const e = text.indexOf('?>', j + 2); if (e === -1) fail('Unterminated processing instruction in the DOCTYPE', j); j = e + 1; continue; }
        if (c === ']') break;
      }
      if (j >= n) fail('Unterminated DOCTYPE internal subset (missing "]")', k);
      subset = text.slice(subsetAt, j);
      k = skipWs(j + 1);
    }
    if (text[k] !== '>') fail(`Malformed DOCTYPE: expected '>' but found ${describeChar(text[k])}`, k);
    if (subset !== null) parseSubset(subset, subsetAt);
    return { type: 'doctype', name, publicId, systemId, subset, raw: text.slice(at, k + 1), offset: at, end: k + 1 };
  };

  const parseSubset = (sub, base) => {
    let j = 0;
    while (j < sub.length) {
      j = (() => { let p = j; while (p < sub.length && isWs(sub[p])) p++; return p; })();
      if (j >= sub.length) break;
      if (sub.startsWith('<!--', j)) { j = sub.indexOf('-->', j + 4) + 3; continue; }
      if (sub.startsWith('<?', j)) { j = sub.indexOf('?>', j + 2) + 2; continue; }
      if (sub[j] === '%') { const e = sub.indexOf(';', j); if (e === -1) fail('Malformed parameter entity reference in the DOCTYPE', base + j); j = e + 1; continue; }
      if (sub[j] !== '<' || sub[j + 1] !== '!') fail(`Unexpected content in the DOCTYPE internal subset: ${describeChar(sub[j])}`, base + j);
      let q = null, e = j + 2;
      for (; e < sub.length; e++) { const c = sub[e]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
      if (e >= sub.length) fail('Unterminated declaration in the DOCTYPE', base + j);
      const decl = sub.slice(j, e + 1);
      if (/^<!ENTITY\b/.test(decl)) {
        stats.entityDecls++;
        if (stats.entityDecls > o.maxEntityDecls) fail(`The DOCTYPE declares more than ${o.maxEntityDecls} entities. Refused to avoid entity-expansion ("billion laughs") attacks.`, base + j);
        const m = /^<!ENTITY\s+(%\s+)?([^\s]+)\s+([\s\S]*)>$/.exec(decl);
        if (!m) fail('Malformed ENTITY declaration', base + j);
        const rest = m[3].trim(), ename = m[2];
        if (/^(SYSTEM|PUBLIC)\b/.test(rest)) fail(`External entity '${ename}' refused: external resources (SYSTEM/PUBLIC) are never loaded. This protects against XXE attacks.`, base + j);
        const lm = /^("([^"]*)"|'([^']*)')\s*$/.exec(rest);
        if (!lm) fail(`Malformed ENTITY declaration for '${ename}'`, base + j);
        const val = lm[2] ?? lm[3];
        if (/&(?!#)[^;\s]*;/.test(val) || /%[^;\s]+;/.test(val)) fail(`Entity '${ename}' refers to another entity. Nested entity expansion is refused (billion-laughs protection); use a literal value or a character reference.`, base + j);
        if (!m[1] && !entities.has(ename)) entities.set(ename, val.replace(/&#(?:x([0-9a-fA-F]+)|([0-9]+));/g, (_, h, d) => { const cp = h ? parseInt(h, 16) : parseInt(d, 10); return validXmlChar(cp) ? String.fromCodePoint(cp) : ''; }));
      }
      j = e + 1;
    }
  };

  // ---- main loop
  const stack = [];
  const scopes = [Object.create(null)];
  scopes[0]['$xml'] = XML_NS;
  let rootSeen = false, i = start;
  const container = () => (stack.length ? stack[stack.length - 1].children : doc.children);
  const first = start;
  const add = nd => { nd.parent = stack.length ? stack[stack.length - 1] : null; container().push(nd); };

  while (i < n) {
    if (text[i] !== '<') {
      let j = text.indexOf('<', i); if (j === -1) j = n;
      const seg = text.slice(i, j);
      if (!stack.length) {
        let k = 0; while (k < seg.length && isWs(seg[k])) k++;
        if (k < seg.length) fail(rootSeen ? 'Content is not allowed after the root element (only comments, processing instructions and whitespace may follow it)' : 'Text is not allowed before the root element; the document must start with markup', i + k);
      } else {
        const cd = seg.indexOf(']]>');
        if (cd !== -1) fail("The sequence ']]>' is not allowed in text content (write ]]&gt;)", i + cd);
        checkRefs(seg, i);
        add({ type: 'text', value: seg, offset: i });
        if (/[^ \t\r\n]/.test(seg)) stats.textNodes++;
      }
      i = j; continue;
    }
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e === -1) fail('Unterminated comment (missing "-->")', i);
      const body = text.slice(i + 4, e);
      const dd = body.indexOf('--');
      if (dd !== -1) fail("The string '--' is not allowed inside comments", i + 4 + dd);
      if (body.endsWith('-')) fail("A comment cannot end with '--->'", i + 4 + body.length - 1);
      add({ type: 'comment', value: body, offset: i }); stats.comments++;
      i = e + 3; continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('CDATA sections are only allowed inside the root element', i);
      const e = text.indexOf(']]>', i + 9);
      if (e === -1) fail('Unterminated CDATA section (missing "]]>")', i);
      add({ type: 'cdata', value: text.slice(i + 9, e), offset: i }); stats.cdata++;
      i = e + 3; continue;
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2);
      if (e === -1) fail('Unterminated processing instruction (missing "?>")', i);
      const target = readName(i + 2);
      if (!target || target.indexOf(':') !== -1) fail('Invalid processing instruction target name', i + 2);
      if (target.toLowerCase() === 'xml') {
        if (target !== 'xml' || i !== first) fail(target === 'xml' && i !== first ? 'The XML declaration must be at the very start of the document (no whitespace or text before it)' : "'xml' is a reserved processing instruction name", i);
        const decl = parseDecl(i, e);
        doc.decl = decl; doc.children.push(decl);
      } else {
        const after = text[i + 2 + target.length];
        if (i + 2 + target.length < e && !isWs(after)) fail('Expected whitespace after the processing instruction target', i + 2 + target.length);
        add({ type: 'pi', target, data: text.slice(i + 2 + target.length, e).replace(/^[ \t\r\n]+/, ''), offset: i }); stats.pis++;
      }
      i = e + 2; continue;
    }
    if (text.startsWith('<!DOCTYPE', i)) {
      if (stack.length || rootSeen) fail('The DOCTYPE must appear before the root element', i);
      if (doc.doctype) fail('Only one DOCTYPE declaration is allowed', i);
      const d = parseDoctype(i); doc.doctype = d; doc.children.push(d);
      i = d.end; continue;
    }
    if (text[i + 1] === '!') fail("Invalid markup '<!': expected a comment (<!--), CDATA section (<![CDATA[) or DOCTYPE", i);
    if (text[i + 1] === '/') {
      const name = readName(i + 2);
      if (!name) fail(`Invalid closing tag: expected an element name after '</' but found ${describeChar(text[i + 2])}`, i + 2);
      const k = skipWs(i + 2 + name.length);
      if (text[k] !== '>') fail(`Malformed closing tag </${name}>: expected '>' but found ${describeChar(text[k])}`, k);
      if (!stack.length) fail(`Unexpected closing tag </${name}>; there is no open element to close`, i);
      const top = stack[stack.length - 1];
      if (top.name !== name) fail(`Closing tag </${name}> does not match the opening tag <${top.name}> (opened at ${where(top.offset)})`, i);
      stack.pop(); scopes.pop();
      i = k + 1; continue;
    }
    // start tag
    const name = readName(i + 1);
    if (!name) {
      const nx = text[i + 1];
      fail(nx === undefined || isWs(nx) || nx === '=' ? "A '<' must be escaped as &lt; in text content (or start a valid tag)" : `Invalid element name after '<': found ${describeChar(nx)}`, i + 1 > n - 1 ? i : i + 1);
    }
    let k = i + 1 + name.length;
    const attrs = [], seen = new Set();
    let selfClosing = false;
    for (;;) {
      const before = k; k = skipWs(k);
      if (k >= n) fail(`Unterminated start tag <${name}> (missing '>')`, i);
      const c = text[k];
      if (c === '>') { k++; break; }
      if (c === '/') { if (text[k + 1] !== '>') fail(`Malformed tag <${name}>: '/' must be followed by '>'`, k); k += 2; selfClosing = true; break; }
      if (k === before) fail(`Attributes must be separated by whitespace (in <${name}>)`, k);
      const an = readName(k);
      if (!an) fail(`Invalid attribute name in <${name}>: found ${describeChar(c)}`, k);
      const aStart = k;
      k = skipWs(k + an.length);
      if (text[k] !== '=') fail(`Attribute '${an}' in <${name}> has no value (expected =)`, aStart);
      k = skipWs(k + 1);
      const q = text[k];
      if (q !== '"' && q !== "'") fail(`The value of attribute '${an}' must be quoted ("..." or '...')`, k);
      const e = text.indexOf(q, k + 1);
      if (e === -1) fail(`Unterminated value for attribute '${an}' (missing closing ${q})`, k);
      const raw = text.slice(k + 1, e);
      const lt = raw.indexOf('<');
      if (lt !== -1) fail(`'<' is not allowed in attribute values (attribute '${an}'); write &lt;`, k + 1 + lt);
      checkRefs(raw, k + 1);
      if (seen.has(an)) fail(`Duplicate attribute '${an}' in <${name}>`, aStart);
      seen.add(an);
      attrs.push({ name: an, raw, quote: q, offset: aStart });
      k = e + 1;
    }
    if (!stack.length) {
      if (rootSeen) fail(`Only one root element is allowed (found a second root element <${name}>)`, i);
      rootSeen = true;
    }
    if (stack.length + 1 > o.maxDepth) fail(`Elements are nested more than ${o.maxDepth} levels deep`, i);
    // namespaces
    const scope = Object.create(scopes[scopes.length - 1]);
    for (const a of attrs) {
      if (a.name === 'xmlns') { scope['$'] = a.raw; namespaces.push({ prefix: '', uri: a.raw, element: name, offset: i }); }
      else if (a.name.startsWith('xmlns:')) {
        const p = a.name.slice(6);
        if (p === 'xmlns') fail("The prefix 'xmlns' cannot be declared", a.offset);
        if (p === 'xml' && a.raw !== XML_NS) fail("The prefix 'xml' can only be bound to " + XML_NS, a.offset);
        if (a.raw === '') fail(`Namespace prefix '${p}' cannot be bound to an empty URI`, a.offset);
        if (p.includes(':')) fail(`Invalid namespace prefix '${p}'`, a.offset);
        scope['$' + p] = a.raw; namespaces.push({ prefix: p, uri: a.raw, element: name, offset: i });
      }
    }
    const qn = (qname, at) => {
      const ci = qname.indexOf(':');
      if (ci === -1) return { prefix: '', local: qname };
      if (ci === 0 || ci === qname.length - 1 || qname.indexOf(':', ci + 1) !== -1) fail(`Invalid qualified name '${qname}' (a name may contain at most one ':' between two non-empty parts)`, at);
      return { prefix: qname.slice(0, ci), local: qname.slice(ci + 1) };
    };
    const q = qn(name, i + 1);
    let ns = '';
    if (q.prefix) {
      const u = scope['$' + q.prefix];
      if (u === undefined) fail(`Namespace prefix '${q.prefix}' is not declared (add xmlns:${q.prefix}="...")`, i + 1);
      ns = u;
    } else ns = scope['$'] ?? '';
    for (const a of attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      const aq = qn(a.name, a.offset);
      if (aq.prefix && scope['$' + aq.prefix] === undefined) fail(`Namespace prefix '${aq.prefix}' (attribute '${a.name}') is not declared`, a.offset);
    }
    const node = { type: 'element', name, prefix: q.prefix, local: q.local, ns, attrs, children: [], selfClosing, offset: i, parent: stack.length ? stack[stack.length - 1] : null, depth: stack.length + 1 };
    container().push(node);
    if (!stack.length) doc.root = node;
    stats.elements++; stats.attributes += attrs.length; names.add(name);
    if (node.depth > stats.maxDepth) stats.maxDepth = node.depth;
    if (!selfClosing) { stack.push(node); scopes.push(scope); }
    i = k;
  }

  if (stack.length) { const top = stack[stack.length - 1]; fail(`Unclosed element <${top.name}> (opened at ${where(top.offset)}); the document ended before it was closed`, top.offset); }
  if (!rootSeen) fail(text.slice(start).trim() === '' ? 'The document is empty' : 'No root element found', n);
  stats.uniqueNames = names.size;
  return { ok: true, doc, stats, namespaces, warnings, entities };
}

// ---------------------------------------------------------------- serialisation
const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
export const escapeXmlText = escText;
export const escapeXmlAttr = escAttr;

export function declString(d) {
  if (!d) return '';
  let s = `<?xml version="${d.version}"`;
  if (d.encoding) s += ` encoding="${d.encoding}"`;
  if (d.standalone) s += ` standalone="${d.standalone}"`;
  return s + '?>';
}

const isBlank = s => !/[^ \t\r\n]/.test(s);
const xmlSpace = node => { const a = node.attrs.find(x => x.name === 'xml:space'); return a ? a.raw : null; };

export const FORMAT_DEFAULTS = { mode: 'pretty', indent: '  ', wrap: 'never', selfClosing: 'keep', stripComments: false, trimText: true, keepDeclaration: true };

/** Serialise a parsed doc. Options: mode 'pretty'|'minify', indent, wrap 'never'|'always'|<max line width>, selfClosing 'keep'|'collapse'|'expand', stripComments, trimText. */
export function serialize(doc, options = {}) {
  const o = { ...FORMAT_DEFAULTS, ...options };
  const pretty = o.mode === 'pretty';
  const out = [];
  const ind = d => o.indent.repeat(d);
  const wrapLimit = typeof o.wrap === 'number' ? o.wrap : null;

  const attrText = a => `${a.name}=${a.quote || '"'}${a.raw}${a.quote || '"'}`;
  const openTag = (node, depth, empty) => {
    const end = empty ? '/>' : '>';
    const single = `<${node.name}${node.attrs.map(a => ' ' + attrText(a)).join('')}`;
    if (pretty && node.attrs.length > 1 && (o.wrap === 'always' || (wrapLimit && ind(depth).length + single.length + end.length > wrapLimit))) {
      return `<${node.name}` + node.attrs.map(a => `\n${ind(depth + 1)}${attrText(a)}`).join('') + end;
    }
    return single + end;
  };
  const emptyForm = (node, depth) => {
    const self = o.selfClosing === 'collapse' || (o.selfClosing !== 'expand' && node.selfClosing);
    return self ? openTag(node, depth, true) : openTag(node, depth, false) + `</${node.name}>`;
  };

  const inline = (node, depth) => { // exact content, no formatting, used for mixed content and xml:space="preserve"
    switch (node.type) {
      case 'text': out.push(node.value); break;
      case 'cdata': out.push(`<![CDATA[${node.value}]]>`); break;
      case 'comment': if (!o.stripComments) out.push(`<!--${node.value}-->`); break;
      case 'pi': out.push(`<?${node.target}${node.data ? ' ' + node.data : ''}?>`); break;
      case 'element': {
        if (node.children.length === 0 && o.selfClosing !== 'expand' && (o.selfClosing === 'collapse' || node.selfClosing)) { out.push(`<${node.name}${node.attrs.map(a => ' ' + attrText(a)).join('')}/>`); break; }
        out.push(`<${node.name}${node.attrs.map(a => ' ' + attrText(a)).join('')}>`);
        for (const c of node.children) inline(c, depth + 1);
        out.push(`</${node.name}>`);
      }
    }
  };

  const element = (node, depth, preserve) => {
    const sp = xmlSpace(node);
    const pres = sp === 'preserve' ? true : sp === 'default' ? false : preserve;
    const kids = node.children;
    if (kids.length === 0) { out.push(emptyForm(node, depth)); return; }
    if (pres) { inline(node, depth); return; }
    let hasEl = false, hasText = false;
    for (const c of kids) {
      if (c.type === 'element') hasEl = true;
      else if (c.type === 'cdata' || (c.type === 'text' && !isBlank(c.value))) hasText = true;
    }
    if (hasEl && hasText) { inline(node, depth); return; }
    if (!hasEl) {
      // text-only (plus comments/PIs): inline, trimming the outer whitespace
      const live = o.stripComments ? kids.filter(c => c.type !== 'comment') : kids;
      if (live.length === 0 || (o.trimText && live.every(c => c.type === 'text') && isBlank(live.map(c => c.value).join('')))) { out.push(emptyForm(node, depth)); return; }
      out.push(openTag(node, depth, false));
      live.forEach((c, idx) => {
        if (c.type === 'text' && o.trimText) {
          let v = c.value;
          if (idx === 0) v = v.replace(/^[ \t\r\n]+/, '');
          if (idx === live.length - 1) v = v.replace(/[ \t\r\n]+$/, '');
          out.push(v);
        } else inline(c, depth + 1);
      });
      out.push(`</${node.name}>`);
      return;
    }
    // element-only content
    const live = kids.filter(c => !(c.type === 'text') && !(o.stripComments && c.type === 'comment'));
    if (live.length === 0) { out.push(emptyForm(node, depth)); return; }
    out.push(openTag(node, depth, false));
    for (const c of live) {
      if (pretty) out.push('\n', ind(depth + 1));
      if (c.type === 'element') element(c, depth + 1, pres); else inline(c, depth + 1);
    }
    if (pretty) out.push('\n', ind(depth));
    out.push(`</${node.name}>`);
  };

  let firstTop = true;
  for (const c of doc.children) {
    if (c.type === 'text') continue;
    if (c.type === 'decl' && !o.keepDeclaration) continue;
    if (c.type === 'comment' && o.stripComments) continue;
    if (!firstTop && pretty) out.push('\n');
    firstTop = false;
    if (c.type === 'decl') out.push(declString(c));
    else if (c.type === 'doctype') out.push(pretty ? c.raw : c.raw.replace(/\s*\n\s*/g, ' '));
    else if (c.type === 'element') element(c, 0, false);
    else inline(c, 0);
  }
  if (pretty) out.push('\n');
  return out.join('');
}

/** Parse + serialise in one step. Returns { ok, text, stats, ... } or { ok:false, error }. */
export function formatXml(text, options = {}) {
  const r = parse(text, options.limits);
  if (!r.ok) return r;
  return { ok: true, text: serialize(r.doc, { ...options, mode: 'pretty' }), stats: r.stats, namespaces: r.namespaces, warnings: r.warnings };
}
export function minifyXml(text, options = {}) {
  const r = parse(text, options.limits);
  if (!r.ok) return r;
  return { ok: true, text: serialize(r.doc, { ...options, mode: 'minify' }), stats: r.stats, namespaces: r.namespaces, warnings: r.warnings };
}

// ---------------------------------------------------------------- entities & conversion helpers
export function decodeEntities(s, entities) {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z_:][^;&\s]*));/g, (m, h, d, nm) => {
    if (nm !== undefined) {
      if (nm === 'lt') return '<'; if (nm === 'gt') return '>'; if (nm === 'amp') return '&'; if (nm === 'quot') return '"'; if (nm === 'apos') return "'";
      return entities && entities.has(nm) ? entities.get(nm) : m;
    }
    const cp = h ? parseInt(h, 16) : parseInt(d, 10);
    return validXmlChar(cp) ? String.fromCodePoint(cp) : m;
  });
}

const NUM_RE = /^-?(0|[1-9]\d{0,14})(\.\d{1,15})?([eE][+-]?\d{1,3})?$/;
function coerce(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (NUM_RE.test(s)) { const v = Number(s); if (Number.isFinite(v) && String(v) === s) return v; }
  return s;
}

export const JSON_DEFAULTS = { attrPrefix: '@', textKey: '#text', forceArray: false, coerce: false, trimText: true, rootName: 'root', declaration: true, indent: '  ', wrap: 'never' };

/** XML text or a parse result -> JS value: { rootName: ... } with @attributes, #text and arrays for repeated children. */
export function xmlToObject(doc, entities, options = {}) {
  const o = { ...JSON_DEFAULTS, ...options };
  const typed = s => (o.coerce ? coerce(s) : s);
  const conv = node => {
    const obj = Object.create(null);
    let hasContent = false, hasEl = false;
    const pieces = [];
    for (const a of node.attrs) { obj[o.attrPrefix + a.name] = decodeEntities(a.raw, entities); hasContent = true; }
    for (const c of node.children) {
      if (c.type === 'text') pieces.push(decodeEntities(c.value, entities));
      else if (c.type === 'cdata') pieces.push(c.value);
      else if (c.type === 'element') {
        hasEl = true; hasContent = true;
        const v = conv(c);
        if (!(c.name in obj)) obj[c.name] = o.forceArray ? [v] : v;
        else if (Array.isArray(obj[c.name])) obj[c.name].push(v);
        else obj[c.name] = [obj[c.name], v];
      }
    }
    let txt = hasEl ? pieces.map(s => s.trim()).filter(Boolean).join(' ') : pieces.join('');
    if (o.trimText || hasEl) txt = txt.trim();
    if (!hasContent) return txt !== '' ? typed(txt) : null;
    if (txt !== '') obj[o.textKey] = typed(txt);
    return obj;
  };
  const out = Object.create(null);
  out[doc.root.name] = conv(doc.root);
  return out;
}

export function xmlToJson(text, options = {}) {
  const o = { ...JSON_DEFAULTS, ...options };
  const r = parse(text, options.limits);
  if (!r.ok) return r;
  const value = xmlToObject(r.doc, r.entities, o);
  return { ok: true, text: JSON.stringify(value, null, o.indent === '\t' ? '\t' : o.indent.length), stats: r.stats, warnings: r.warnings };
}

export function sanitizeName(key, warnings) {
  let s = String(key);
  if (isXmlName(s) && !/^xml/i.test(s)) return s;
  let t = s.replace(new RegExp(`[^${NAME_CHAR.slice(1, -1)}]`, 'gu'), '_');
  if (!t || !new RegExp(`^${NAME_START}`, 'u').test(t)) t = '_' + t;
  if (/^xml/i.test(t) && !isXmlName(t)) t = '_' + t;
  if (warnings && t !== s) warnings.push(`Key "${s}" is not a valid XML name; used <${t}>.`);
  return t;
}
const cleanText = (s, warnings) => {
  const t = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  if (t !== String(s) && warnings && !warnings.includes('Control characters that XML cannot represent were removed.')) warnings.push('Control characters that XML cannot represent were removed.');
  return t;
};

/** Offset of the first syntax error in a JSON text (-1 if none found). Used to give line/column for JSON.parse failures. */
export function jsonErrorOffset(text) {
  let i = 0; const n = text.length;
  const ws = () => { while (i < n && ' \t\r\n'.includes(text[i])) i++; };
  const bad = () => { throw i; };
  const value = d => {
    if (d > 1500) bad();
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); if (text[i] !== '"') bad(); str(); ws();
        if (text[i] !== ':') bad(); i++; value(d + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        bad();
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(d + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        bad();
      }
    } else if (c === '"') str();
    else {
      const m = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!m) bad(); i += m[0].length;
    }
  };
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
  try { value(0); ws(); if (i < n) return i; return -1; } catch (e) { return typeof e === 'number' ? e : 0; }
}

/** JSON text (or value) -> XML text. Keys starting with attrPrefix become attributes, textKey becomes text, arrays repeat the element. */
export function jsonToXml(input, options = {}) {
  const o = { ...JSON_DEFAULTS, ...options };
  let value = input;
  if (typeof input === 'string') {
    if (input.trim() === '') return { ok: false, error: { message: 'The input is empty. Paste JSON to convert.', line: 1, column: 1 } };
    try { value = JSON.parse(input); } catch (e) {
      let line = 1, column = 1;
      const m = /position (\d+)/.exec(e.message);
      const off = m ? Number(m[1]) : jsonErrorOffset(input);
      if (off >= 0) { const p = positionAt(lineStartsOf(input), off); line = p.line; column = p.column; }
      return { ok: false, error: { message: `Invalid JSON: ${e.message}`, line, column } };
    }
  }
  const warnings = [];
  const mkEl = (name, attrs, children) => ({ type: 'element', name, attrs, children, selfClosing: children.length === 0, offset: 0 });
  const prim = v => cleanText(typeof v === 'string' ? v : String(v), warnings);
  const build = (key, v, depth, list) => {
    if (depth > 500) throw new Error('JSON is nested too deeply to convert');
    if (Array.isArray(v)) { for (const item of v) build(key, item, depth + 1, list); return; }
    const name = sanitizeName(key, warnings);
    if (v === null || v === undefined) { list.push(mkEl(name, [], [])); return; }
    if (typeof v !== 'object') { const s = prim(v); list.push(mkEl(name, [], s === '' ? [] : [{ type: 'text', value: escText(s) }])); return; }
    const attrs = [], children = [];
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (o.attrPrefix && k.startsWith(o.attrPrefix) && k.length > o.attrPrefix.length) {
        const an = k.slice(o.attrPrefix.length);
        const s = val !== null && typeof val === 'object' ? JSON.stringify(val) : prim(val ?? '');
        const isNs = an === 'xmlns' || an.startsWith('xmlns:') || an === 'xml:space' || an === 'xml:lang';
        attrs.push({ name: isNs ? an : sanitizeName(an, warnings), raw: escAttr(s), quote: '"' });
      } else if (k === o.textKey) {
        const s = prim(val ?? ''); if (s !== '') children.push({ type: 'text', value: escText(s) });
      } else build(k, val, depth + 1, children);
    }
    list.push(mkEl(name, attrs, children));
  };
  let roots = [];
  try {
    const isPlain = value !== null && typeof value === 'object' && !Array.isArray(value);
    const keys = isPlain ? Object.keys(value) : [];
    if (isPlain && keys.length === 1 && !(o.attrPrefix && keys[0].startsWith(o.attrPrefix)) && keys[0] !== o.textKey && !Array.isArray(value[keys[0]])) {
      build(keys[0], value[keys[0]], 0, roots);
    } else if (Array.isArray(value)) {
      const kids = []; for (const item of value) build('item', item, 1, kids);
      roots = [mkEl(sanitizeName(o.rootName, warnings), [], kids)];
    } else build(o.rootName, value, 0, roots);
  } catch (e) { return { ok: false, error: { message: e.message, line: 1, column: 1 } }; }
  const doc = { children: [], root: roots[0] };
  if (o.declaration) doc.children.push({ type: 'decl', version: '1.0', encoding: 'UTF-8', standalone: null });
  doc.children.push(roots[0]);
  return { ok: true, text: serialize(doc, { mode: 'pretty', indent: o.indent, wrap: o.wrap, selfClosing: 'collapse', trimText: false }), warnings };
}

// ---------------------------------------------------------------- tree / XPath helpers
/** XPath (1.0) of an element node of our tree; works with namespaces by using name()/local-name() tests. */
export function xpathOf(node) {
  const steps = [];
  for (let cur = node; cur && cur.type === 'element'; cur = cur.parent) {
    const key = cur.prefix ? `*[name()='${cur.name}']` : cur.ns ? `*[local-name()='${cur.local}']` : cur.name;
    let idx = 1, total = 1;
    const sibs = cur.parent ? cur.parent.children : null;
    if (sibs) {
      total = 0; idx = 0;
      for (const s of sibs) {
        if (s.type !== 'element') continue;
        const k = s.prefix ? `*[name()='${s.name}']` : s.ns ? `*[local-name()='${s.local}']` : s.name;
        if (k === key) { total++; if (s === cur) idx = total; }
      }
    }
    steps.push(total > 1 ? `${key}[${idx}]` : key);
  }
  return '/' + steps.reverse().join('/');
}
export function xpathOfAttr(node, attrName) { return `${xpathOf(node)}/@${attrName}`; }

/** Short one-line label for a tree node (used by the tree explorer and search). */
export function nodeLabel(node, entities) {
  switch (node.type) {
    case 'element': return node.name;
    case 'text': return decodeEntities(node.value, entities).trim().replace(/\s+/g, ' ');
    case 'cdata': return node.value.trim().replace(/\s+/g, ' ');
    case 'comment': return node.value.trim().replace(/\s+/g, ' ');
    case 'pi': return `${node.target} ${node.data}`.trim();
    default: return '';
  }
}

/** Find nodes matching `query` (case-insensitive) in element names, attribute names/values and text. Capped. */
export function searchTree(root, query, entities, cap = 500) {
  const q = String(query || '').toLowerCase();
  const hits = [];
  if (!q) return hits;
  const stack = [root];
  while (stack.length && hits.length < cap) {
    const node = stack.pop();
    if (node.type === 'element') {
      let why = null;
      if (node.name.toLowerCase().includes(q)) why = 'name';
      else {
        const a = node.attrs.find(x => x.name.toLowerCase().includes(q) || decodeEntities(x.raw, entities).toLowerCase().includes(q));
        if (a) why = `@${a.name}`;
      }
      if (why) hits.push({ node, why });
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    } else if ((node.type === 'text' || node.type === 'cdata') && nodeLabel(node, entities).toLowerCase().includes(q)) hits.push({ node, why: 'text' });
    else if (node.type === 'comment' && node.value.toLowerCase().includes(q)) hits.push({ node, why: 'comment' });
  }
  return hits;
}

export function sizeStats(before, after) {
  const enc = new TextEncoder();
  const b = enc.encode(before).length, a = enc.encode(after).length;
  return { before: b, after: a, saved: b - a, percent: b ? ((b - a) / b) * 100 : 0 };
}

export const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- A small catalog -->
<catalog xmlns="urn:example:books" xmlns:meta="urn:example:meta" updated="2024-05-01">
<book id="bk101" meta:lang="en"><author>Gambardella, Matthew</author><title>XML Developer's Guide</title>
<price currency="USD">44.95</price><description><![CDATA[An in-depth look at <XML> & friends.]]></description></book>
<book id="bk102" meta:lang="fr"><author>Müller, Zoë</author><title>Café &amp; Données</title><price currency="EUR">5.95</price><empty/></book>
<note>Mixed <b>content</b> stays <i>inline</i>.</note>
</catalog>
`;

// ---------------------------------------------------------------- worker-friendly entry point
/** Plain-data summary of a successful parse (safe to post across a worker boundary). */
export function summarize(r) {
  const d = r.doc;
  return {
    stats: r.stats,
    warnings: r.warnings,
    decl: d.decl ? { version: d.decl.version, encoding: d.decl.encoding, standalone: d.decl.standalone } : null,
    doctype: d.doctype ? { name: d.doctype.name, publicId: d.doctype.publicId, systemId: d.doctype.systemId } : null,
    root: d.root.name,
    bom: d.bom,
    namespaces: r.namespaces.map(ns => ({ prefix: ns.prefix, uri: ns.uri, element: ns.element, ...positionAt(d.lineStarts, ns.offset, d.bom) })),
  };
}

/** op: 'validate' | 'format' | 'minify' | 'toJson' | 'fromJson'. Returns { ok, text?, info?, warnings?, error? } (plain data). */
export function runOp(op, text, options = {}) {
  if (op === 'fromJson') return jsonToXml(text, options);
  const r = parse(text, options.limits);
  if (!r.ok) return { ok: false, error: r.error };
  const info = summarize(r);
  if (op === 'validate') return { ok: true, info, warnings: r.warnings };
  if (op === 'format') return { ok: true, info, warnings: r.warnings, text: serialize(r.doc, { ...options, mode: 'pretty' }) };
  if (op === 'minify') return { ok: true, info, warnings: r.warnings, text: serialize(r.doc, { ...options, mode: 'minify' }) };
  if (op === 'toJson') {
    const v = xmlToObject(r.doc, r.entities, { ...JSON_DEFAULTS, ...options });
    const ind = options.indent === '\t' ? '\t' : (options.indent || '  ').length;
    return { ok: true, info, warnings: r.warnings, text: JSON.stringify(v, null, ind) };
  }
  throw new Error(`Unknown operation '${op}'`);
}
