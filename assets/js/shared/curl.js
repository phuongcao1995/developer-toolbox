// Pure cURL parser / builder shared by the API Client and the cURL Converter tool. No DOM, no eval.
//
// Request shape (everything optional except url):
//   { method, url, headers: [{key,value,enabled?}] | {name:value}, body: string,
//     bodyType: 'json'|'text'|'form'|'raw'|'multipart', form: [{key,value,file?}],
//     auth: null | {type:'basic',username,password} | {type:'bearer',token} | {type:'apikey',in:'header'|'query',name,value},
//     options: {insecure?, followRedirects?, compressed?} }
//
//   parseCurl(text, {shell:'auto'|'posix'|'cmd'|'powershell'}) -> request + {warnings[]}
//   buildCurl(request, {shell:'posix'|'cmd'|'powershell', pretty})  -> string
//   buildFetch(request, {pretty}) / buildPython(request)             -> string
//   tokenize(text, mode) -> {tokens[], stopped, unterminated, expansions}

const NO_BODY = new Set(['GET', 'HEAD']);

// ---------- helpers ----------
/** UTF-8 safe base64 (works in browsers and Node 16+). */
export function base64Utf8(str) {
  const bytes = new TextEncoder().encode(String(str ?? ''));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** curl --data-urlencode style: everything except unreserved characters is percent-encoded (space -> %20). */
export const urlencodeStrict = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function headerList(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.filter(r => r && r.enabled !== false && String(r.key ?? '').trim() !== '').map(r => ({ key: String(r.key).trim(), value: String(r.value ?? '') }));
  return Object.entries(headers).map(([key, value]) => ({ key, value: String(value ?? '') }));
}
const findHeader = (list, name) => list.find(h => h.key.toLowerCase() === name.toLowerCase());

/** Fold request.auth into explicit headers / URL so a generator only deals with plain data. */
export function resolveRequest(req) {
  const headers = headerList(req.headers);
  let url = String(req.url ?? '');
  const a = req.auth;
  let basic = null;
  if (a && a.type === 'bearer' && a.token && !findHeader(headers, 'authorization')) headers.push({ key: 'Authorization', value: `Bearer ${a.token}` });
  else if (a && a.type === 'basic' && (a.username || a.password)) basic = { username: String(a.username ?? ''), password: String(a.password ?? '') };
  else if (a && a.type === 'apikey' && a.name && a.value !== undefined) {
    if (a.in === 'query') url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(a.name)}=${encodeURIComponent(a.value)}`;
    else headers.push({ key: a.name, value: String(a.value) });
  }
  const method = String(req.method || 'GET').toUpperCase();
  const multipart = req.bodyType === 'multipart';
  const form = multipart && Array.isArray(req.form) ? req.form.map(f => ({ key: String(f.key ?? ''), value: String(f.value ?? '') })) : [];
  const body = multipart ? '' : String(req.body ?? '');
  return { method, url, headers, basic, body, form, multipart, options: req.options || {} };
}

// ---------- tokenizer ----------
function unCaret(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '^') { out += s[i]; continue; }
    if (s[i + 1] === '\n') { i++; continue; }
    if (i + 1 < s.length) { out += s[i + 1]; i++; }
  }
  return out;
}

const ANSI_SIMPLE = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function readAnsiC(s, i) { // i is just after the opening $'  ; returns [string, nextIndex, terminated]
  let out = '', bytes = [];
  const flush = () => { if (bytes.length) { out += new TextDecoder('utf-8').decode(Uint8Array.from(bytes)); bytes = []; } };
  while (i < s.length) {
    const c = s[i];
    if (c === "'") { flush(); return [out, i + 1, true]; }
    if (c !== '\\') { flush(); out += c; i++; continue; }
    const n = s[i + 1];
    if (n === undefined) { i++; continue; }
    let m;
    if ((m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4)))) { bytes.push(parseInt(m[0], 8) & 255); i += 1 + m[0].length; continue; }
    if (n in ANSI_SIMPLE) { flush(); out += ANSI_SIMPLE[n]; i += 2; continue; }
    if (n === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2, i + 4)))) { bytes.push(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
    if ((n === 'u' || n === 'U') && (m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(s.slice(i + 2, i + 10)))) {
      flush(); const cp = parseInt(m[0], 16);
      out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd'; i += 2 + m[0].length; continue;
    }
    if (n === 'c' && s[i + 2]) { flush(); out += String.fromCharCode(s[i + 2].toUpperCase().charCodeAt(0) ^ 64); i += 3; continue; }
    flush(); out += '\\' + n; i += 2;
  }
  flush();
  return [out, i, false];
}

/**
 * Split a shell command line into words. mode: 'posix' | 'cmd' (Windows cmd, ^ escapes) | 'powershell'.
 * Stops at an unquoted | ; && (stopped:true). Shell expansions ($VAR, $(..)) are NOT evaluated (expansions:true).
 */
export function tokenize(input, mode = 'posix') {
  let s = String(input ?? '').replace(/\r\n?/g, '\n');
  if (mode === 'cmd') s = unCaret(s);
  if (mode === 'powershell') s = s.replace(/`\n/g, ' ');
  const tokens = []; let cur = '', has = false, i = 0, stopped = false, unterminated = false, expansions = false;
  const push = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  const POSIX_DQ = new Set(['$', '`', '"', '\\']);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { push(); i++; continue; }
    if (c === '#' && !has) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '|' || c === ';' || (c === '&' && s[i + 1] === '&')) { stopped = true; break; }
    if (c === '\\' && mode === 'posix') {
      if (s[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < s.length) { cur += s[i + 1]; has = true; }
      i += 2; continue;
    }
    if (c === '`' && mode === 'powershell') { if (i + 1 < s.length) { cur += s[i + 1]; has = true; } i += 2; continue; }
    if (c === "'" && mode !== 'cmd') {
      has = true; i++;
      for (;;) {
        const j = s.indexOf("'", i);
        if (j < 0) { cur += s.slice(i); unterminated = true; i = s.length; break; }
        cur += s.slice(i, j); i = j + 1;
        if (mode === 'powershell' && s[i] === "'") { cur += "'"; i++; continue; } // '' is a literal quote in PowerShell
        break;
      }
      continue;
    }
    if (c === '$' && s[i + 1] === "'" && mode === 'posix') {
      const [str, next, ok] = readAnsiC(s, i + 2); cur += str; has = true; i = next; if (!ok) unterminated = true; continue;
    }
    if (c === '"') {
      has = true; i++; let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '"') {
          if (mode === 'powershell' && s[i + 1] === '"') { cur += '"'; i += 2; continue; }
          closed = true; i++; break;
        }
        if (mode === 'posix' && d === '\\') {
          const n = s[i + 1];
          if (n === '\n') { i += 2; continue; }
          if (POSIX_DQ.has(n)) { cur += n; i += 2; continue; }
          cur += d; i++; continue;
        }
        if (mode === 'cmd' && d === '\\' && s[i + 1] === '"') { cur += '"'; i += 2; continue; }
        if (mode === 'powershell' && d === '`' && i + 1 < s.length) {
          const n = s[i + 1]; cur += { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07' }[n] ?? n; i += 2; continue;
        }
        if (d === '$' && /[A-Za-z_{(]/.test(s[i + 1] || '') && mode === 'posix') expansions = true;
        cur += d; i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    if (c === '$' && /[A-Za-z_{(]/.test(s[i + 1] || '') && mode === 'posix') expansions = true;
    cur += c; has = true; i++;
  }
  push();
  return { tokens, stopped, unterminated, expansions };
}

function detectShell(text) {
  if (/\^\r?\n/.test(text) || /\^"/.test(text)) return 'cmd';
  if (/`\r?\n/.test(text) || /^\s*curl\.exe\b/i.test(text)) return 'powershell';
  return 'posix';
}

// ---------- parser ----------
const VALUE_SHORT = new Set(['X', 'H', 'd', 'F', 'u', 'A', 'e', 'b', 'o', 'm', 'x', 'w', 'T', 'c', 'E', 'K', 'r', 'y', 'Y', 'z', 'C', 'U', 'D', 'P', 't', 'Q']);
const BOOL_SHORT = new Set(['I', 'G', 'L', 'k', 's', 'v', 'S', 'i', 'f', 'g', 'N', 'O', 'J', 'R', 'B', 'a', 'j', '0', '1', '2', '3', '4', '6', 'q', 'n', 'Z', 'l', 'p', '#']);
const SHORT_TO_LONG = { X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie', I: 'head', G: 'get', L: 'location', k: 'insecure', s: 'silent', v: 'verbose', S: 'show-error', i: 'include', f: 'fail', o: 'output', m: 'max-time', x: 'proxy', T: 'upload-file', O: 'remote-name', w: 'write-out', c: 'cookie-jar' };
const VALUE_LONG = new Set(['request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'form', 'form-string', 'user', 'user-agent', 'referer', 'cookie', 'url', 'json', 'output', 'max-time', 'connect-timeout', 'proxy', 'proxy-user', 'retry', 'retry-delay', 'write-out', 'upload-file', 'cookie-jar', 'cacert', 'capath', 'cert', 'key', 'resolve', 'max-redirs', 'config', 'oauth2-bearer', 'range', 'limit-rate', 'interface', 'dns-servers', 'connect-to', 'proxy-header', 'url-query', 'aws-sigv4', 'variable', 'expand-data', 'http-version']);
const BOOL_LONG = new Set(['head', 'get', 'location', 'location-trusted', 'insecure', 'silent', 'verbose', 'show-error', 'include', 'fail', 'compressed', 'globoff', 'no-buffer', 'remote-name', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'ipv4', 'ipv6', 'path-as-is', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'no-keepalive', 'tcp-nodelay', 'fail-with-body', 'progress-bar', 'raw', 'anyauth', 'basic', 'digest', 'negotiate', 'ntlm', 'tr-encoding', 'ssl-no-revoke', 'no-progress-meter', 'styled-output', 'parallel', 'proxy-insecure']);
const IGNORED = new Set(['silent', 'verbose', 'show-error', 'include', 'fail', 'globoff', 'no-buffer', 'ipv4', 'ipv6', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'no-keepalive', 'tcp-nodelay', 'progress-bar', 'raw', 'path-as-is', 'tr-encoding', 'no-progress-meter', 'styled-output', 'basic', 'fail-with-body', 'proxy-insecure', 'max-time', 'connect-timeout', 'write-out', 'remote-name', 'output', 'location-trusted', 'cookie-jar', 'retry', 'retry-delay']);
const FORBIDDEN_HEADER = /^(host|origin|referer|cookie|cookie2|user-agent|accept-encoding|accept-charset|connection|content-length|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via|sec-[\w-]+|proxy-[\w-]+)$/i;
/** Headers a browser (fetch) will refuse or silently ignore. */
export const isForbiddenHeader = name => FORBIDDEN_HEADER.test(String(name || '').trim());

function parseFormField(v, literal) {
  const eq = v.indexOf('=');
  if (eq < 0) return { key: v, value: '', file: false, bad: true };
  const key = v.slice(0, eq); let value = v.slice(eq + 1);
  if (literal) return { key, value, file: false };
  if (value.startsWith('@') || value.startsWith('<')) return { key, value: value.slice(1).replace(/;.*$/, ''), file: true };
  if (value.startsWith('"')) { const m = /^"((?:[^"\\]|\\.)*)"/.exec(value); if (m) value = m[1].replace(/\\(["\\])/g, '$1'); }
  else value = value.replace(/;(type|filename|headers|encoder)=[^;]*$/i, '');
  return { key, value, file: false };
}
const jsonLike = s => { try { JSON.parse(s); return true; } catch { return false; } };

/** Parse a curl command. Never throws; problems go to warnings[]. */
export function parseCurl(text, { shell = 'auto' } = {}) {
  const warnings = [];
  const out = { method: 'GET', url: '', headers: [], body: '', bodyType: 'json', form: [], auth: null, options: {}, warnings };
  const src = String(text ?? '').trim().replace(/^\$\s+/, '');
  if (!src) { warnings.push('Nothing to import: the input is empty.'); return out; }
  const mode = shell === 'auto' ? detectShell(src) : shell;
  const tk = tokenize(src, mode);
  if (tk.unterminated) warnings.push('Unterminated quote — the command may be cut off.');
  if (tk.stopped) warnings.push('Everything after an unquoted | ; or && was ignored.');
  if (tk.expansions) warnings.push('Shell variables / command substitutions ($VAR, $(...)) are not expanded; they are kept as literal text.');
  let args = tk.tokens;
  const first = (args[0] || '').toLowerCase();
  if (first === 'curl' || first === 'curl.exe') args = args.slice(1);
  else if (args.length && /^[A-Za-z][\w.-]*$/.test(args[0]) && !args[0].includes('.')) { warnings.push(`Unexpected command "${args[0]}" ignored; expected "curl".`); args = args.slice(1); }

  let explicitMethod = null, head = false, getMode = false, url = null, jsonBody = false;
  const dataParts = [], forms = [], extra = [], unknown = new Set();
  const setHeader = (k, v) => out.headers.push({ key: k, value: v, enabled: true });
  const ct = () => findHeader(out.headers, 'content-type');

  const apply = (name, val) => {
    switch (name) {
      case 'request': explicitMethod = val.toUpperCase(); break;
      case 'header': {
        const i = val.indexOf(':');
        if (i < 0) { if (val.endsWith(';')) setHeader(val.slice(0, -1).trim(), ''); else warnings.push(`Header without ":" skipped: ${val}`); break; }
        const k = val.slice(0, i).trim(), v = val.slice(i + 1).trim();
        if (!k) warnings.push(`Header with empty name skipped: ${val}`);
        else if (v === '') warnings.push(`Header "${k}:" (empty value) removes the header in curl; skipped.`);
        else setHeader(k, v);
        break;
      }
      case 'data': case 'data-raw': case 'data-binary': case 'data-ascii':
        if (name !== 'data-raw' && val.startsWith('@')) { warnings.push(`Reading the body from a file (${val}) is not supported; the body was skipped.`); break; }
        dataParts.push(val); break;
      case 'json': jsonBody = true; dataParts.push(val); break;
      case 'data-urlencode': {
        const eq = val.indexOf('=');
        if (eq < 0 && val.includes('@')) { warnings.push(`--data-urlencode with a file (${val}) is not supported; skipped.`); break; }
        if (eq < 0) { dataParts.push(urlencodeStrict(val)); break; }
        const k = val.slice(0, eq);
        dataParts.push((k ? k + '=' : '') + urlencodeStrict(val.slice(eq + 1)));
        break;
      }
      case 'form': case 'form-string': {
        const f = parseFormField(val, name === 'form-string');
        if (f.bad) { warnings.push(`Malformed form field skipped: ${val}`); break; }
        if (f.file) warnings.push(`Form field "${f.key}" uploads a file (${f.value}); file uploads are not supported — the value was left empty.`);
        forms.push({ key: f.key, value: f.file ? '' : f.value, file: !!f.file });
        break;
      }
      case 'user': {
        const i = val.indexOf(':');
        out.auth = { type: 'basic', username: i < 0 ? val : val.slice(0, i), password: i < 0 ? '' : val.slice(i + 1) };
        if (i < 0) warnings.push('-u without a password: curl would prompt for it; password left empty.');
        break;
      }
      case 'user-agent': setHeader('User-Agent', val); break;
      case 'referer': setHeader('Referer', val); break;
      case 'cookie': if (val.includes('=')) setHeader('Cookie', val); else warnings.push(`-b ${val}: reading cookies from a file is not supported.`); break;
      case 'url': if (url === null) url = val; else extra.push(val); break;
      case 'oauth2-bearer': setHeader('Authorization', `Bearer ${val}`); break;
      case 'head': head = true; break;
      case 'get': getMode = true; break;
      case 'location': out.options.followRedirects = true; break;
      case 'insecure': out.options.insecure = true; warnings.push('-k/--insecure has no effect in a browser; certificate checks cannot be disabled.'); break;
      case 'compressed': out.options.compressed = true; break;
      case 'upload-file': warnings.push(`-T/--upload-file is not supported (${val}).`); break;
      default: if (!IGNORED.has(name)) unknown.add(name);
    }
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { for (const r of args.slice(i + 1)) { if (url === null) url = r; else extra.push(r); } break; }
    if (a.startsWith('--') && a.length > 2) {
      let name = a.slice(2), val = null;
      const eq = name.indexOf('=');
      if (eq > 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (VALUE_LONG.has(name)) {
        if (val === null) { val = args[++i]; if (val === undefined) { warnings.push(`Option --${name} is missing its value.`); break; } }
        apply(name, val);
      } else if (BOOL_LONG.has(name)) apply(name, null);
      else if (name.startsWith('no-') && BOOL_LONG.has(name.slice(3))) { /* negated flag */ } else unknown.add(name);
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (VALUE_SHORT.has(ch)) {
          let val = a.slice(k + 1);
          if (val === '') { val = args[++i]; if (val === undefined) { warnings.push(`Option -${ch} is missing its value.`); break; } }
          apply(SHORT_TO_LONG[ch] || '', val);
          if (!SHORT_TO_LONG[ch]) unknown.add(ch);
          break;
        }
        if (BOOL_SHORT.has(ch)) { if (SHORT_TO_LONG[ch]) apply(SHORT_TO_LONG[ch], null); } else unknown.add(ch);
      }
      continue;
    }
    if (url === null) url = a; else extra.push(a);
  }
  if (unknown.size) warnings.push(`Unsupported options ignored: ${[...unknown].map(n => (n.length === 1 ? '-' : '--') + n).join(', ')}`);
  if (extra.length) warnings.push(`Extra URLs ignored (only the first is used): ${extra.join(' ')}`);

  if (url === null) warnings.push('No URL found in the command.');
  else {
    url = url.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { warnings.push(`URL has no scheme; assumed http:// (${url}).`); url = 'http://' + url.replace(/^\/\//, ''); }
    out.url = url;
  }

  if (jsonBody) {
    if (!ct()) setHeader('Content-Type', 'application/json');
    if (!findHeader(out.headers, 'accept')) setHeader('Accept', 'application/json');
  }

  let body = dataParts.join('&');
  if (getMode && dataParts.length) {
    const h = out.url.indexOf('#');
    const frag = h >= 0 ? out.url.slice(h) : '';
    const base = h >= 0 ? out.url.slice(0, h) : out.url;
    out.url = base + (base.includes('?') ? '&' : '?') + body + frag; body = '';
  }
  if (forms.length) {
    if (ct() && /multipart/i.test(ct().value)) out.headers.splice(out.headers.indexOf(ct()), 1);
    out.form = forms; out.bodyType = 'multipart'; body = '';
    if (dataParts.length) warnings.push('Both -d and -F were given; the -d data was ignored.');
  }
  out.body = body;
  out.method = explicitMethod || (head ? 'HEAD' : body !== '' || forms.length ? 'POST' : 'GET');
  if (head && explicitMethod && explicitMethod !== 'HEAD') warnings.push(`-I ignored because -X ${explicitMethod} was given.`);
  if (NO_BODY.has(out.method) && (body || forms.length)) warnings.push(`${out.method} requests cannot carry a body in browsers; the body will not be sent.`);

  if (!forms.length) {
    const c = ct() && ct().value;
    if (jsonBody || (c && /json/i.test(c))) out.bodyType = 'json';
    else if (c && /x-www-form-urlencoded/i.test(c)) out.bodyType = 'form';
    else if (c && /^\s*text\//i.test(c)) out.bodyType = 'text';
    else if (c) out.bodyType = 'raw';
    else if (body === '') out.bodyType = 'json';
    else if (/^\s*[{[]/.test(body) && jsonLike(body)) { out.bodyType = 'json'; warnings.push('No Content-Type header: curl would send application/x-www-form-urlencoded; the JSON-looking body was treated as JSON.'); }
    else out.bodyType = 'form';
  }
  for (const h of out.headers) if (isForbiddenHeader(h.key)) warnings.push(`Header "${h.key}" is controlled by the browser and is ignored when sending from a web page.`);
  return out;
}

// ---------- builders ----------
const CMD_SAFE = /[a-zA-Z0-9 \t_\-:=+~'/.,?;()*`]/;
function cmdQuote(s) {
  let out = '';
  for (const ch of String(s).replace(/"/g, '\\"')) {
    if (ch === '\n') out += '^\n\n';
    else if (ch === '\r') continue;
    else out += CMD_SAFE.test(ch) ? ch : '^' + ch;
  }
  return '^"' + out + '^"';
}
const QUOTERS = {
  posix: s => `'${String(s).replace(/'/g, `'\\''`)}'`,
  powershell: s => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, c => c + c)}'`,
  cmd: cmdQuote,
};
/** Quote one argument for a shell ('posix' | 'cmd' | 'powershell'). */
export const shellQuote = (s, shell = 'posix') => (QUOTERS[shell] || QUOTERS.posix)(s);

/** Build a curl command line for the given shell. pretty: one option per line with the shell's continuation. */
export function buildCurl(request, { shell = 'posix', pretty = false } = {}) {
  const r = resolveRequest(request || {});
  const sh = QUOTERS[shell] ? shell : 'posix';
  const q = QUOTERS[sh];
  const hasBody = r.multipart ? r.form.length > 0 : r.body !== '';
  const headParts = [sh === 'powershell' ? 'curl.exe' : 'curl'];
  if (r.method === 'HEAD') headParts.push('-I');
  else if (r.method === 'GET' ? hasBody : !(r.method === 'POST' && hasBody)) headParts.push('-X', r.method);
  if (r.options.followRedirects) headParts.push('-L');
  headParts.push(q(r.url));
  const rest = [];
  for (const h of r.headers) {
    if (r.multipart && h.key.toLowerCase() === 'content-type' && /multipart/i.test(h.value)) continue;
    rest.push(`-H ${q(`${h.key}: ${h.value}`)}`);
  }
  if (r.basic) rest.push(`-u ${q(`${r.basic.username}:${r.basic.password}`)}`);
  if (r.multipart) {
    for (const f of r.form) {
      const lit = /^[@<"]/.test(f.value) || /;(type|filename)=/i.test(f.value);
      rest.push(`${lit ? '--form-string' : '-F'} ${q(`${f.key}=${f.value}`)}`);
    }
  } else if (hasBody) rest.push(`--data-raw ${q(r.body)}`);
  const lines = [headParts.join(' '), ...rest];
  if (!pretty) return lines.join(' ');
  return lines.join(sh === 'cmd' ? ' ^\n  ' : sh === 'powershell' ? ' `\n  ' : ' \\\n  ');
}

const jsStr = s => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** JavaScript fetch() snippet (plain text). */
export function buildFetch(request, { pretty = true } = {}) {
  const r = resolveRequest(request || {});
  const headers = r.headers.filter(h => !(r.multipart && h.key.toLowerCase() === 'content-type'));
  if (r.basic) headers.push({ key: 'Authorization', value: 'Basic ' + base64Utf8(`${r.basic.username}:${r.basic.password}`) });
  const hasBody = r.multipart ? r.form.length > 0 : r.body !== '' && !NO_BODY.has(r.method);
  const ind = pretty ? '  ' : '', nl = pretty ? '\n' : ' ';
  let pre = '';
  if (r.multipart && hasBody) pre = 'const form = new FormData();' + nl + r.form.map(f => `form.append(${jsStr(f.key)}, ${jsStr(f.value)});`).join(nl) + nl + nl;
  const lines = [];
  if (r.method !== 'GET') lines.push(`${ind}method: ${jsStr(r.method)}`);
  if (headers.length) lines.push(`${ind}headers: {${nl}${headers.map(h => `${ind}${ind}${jsStr(h.key)}: ${jsStr(h.value)}`).join(',' + nl)}${nl}${ind}}`);
  if (hasBody) lines.push(`${ind}body: ${r.multipart ? 'form' : jsStr(r.body)}`);
  if (r.options.followRedirects === false) lines.push(`${ind}redirect: "manual"`);
  const init = lines.length ? `, {${nl}${lines.join(',' + nl)}${nl}}` : '';
  return `${pre}fetch(${jsStr(r.url)}${init})${nl}${ind}.then(res => res.text())${nl}${ind}.then(console.log)${nl}${ind}.catch(console.error);`;
}

const PY_ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const pyStr = s => '"' + String(s).replace(/[\\"\n\r\t\u0000-\u001f\u007f]/g, c => PY_ESC[c] || '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '"';

/** Python `requests` snippet (plain text). */
export function buildPython(request) {
  const r = resolveRequest(request || {});
  const headers = r.headers.filter(h => !(r.multipart && h.key.toLowerCase() === 'content-type'));
  const args = [pyStr(r.url)];
  if (headers.length) args.push(`headers={\n${headers.map(h => `        ${pyStr(h.key)}: ${pyStr(h.value)},`).join('\n')}\n    }`);
  if (r.basic) args.push(`auth=(${pyStr(r.basic.username)}, ${pyStr(r.basic.password)})`);
  if (r.multipart && r.form.length) args.push(`files={\n${r.form.map(f => `        ${pyStr(f.key)}: (None, ${pyStr(f.value)}),`).join('\n')}\n    }`);
  else if (r.body !== '' && !NO_BODY.has(r.method)) args.push(`data=${pyStr(r.body)}.encode("utf-8")`);
  if (r.options.followRedirects === false) args.push('allow_redirects=False');
  const m = r.method.toLowerCase();
  const call = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m) ? `requests.${m}(` : `requests.request(${pyStr(r.method)},`;
  return `import requests\n\nresponse = ${call}\n${args.map(a => '    ' + a + ',').join('\n')}\n)\n\nprint(response.status_code)\nprint(response.text)\n`;
}
