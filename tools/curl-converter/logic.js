// cURL Converter logic: analysis, masking, form -> request and code generators. Pure ES module, no DOM, no network.
// Parsing / cURL building / fetch / requests come from the shared module (assets/js/shared/curl.js).
import { parseCurl, buildCurl, buildFetch, buildPython, resolveRequest, base64Utf8, shellQuote, isForbiddenHeader, urlencodeStrict } from '../../assets/js/shared/curl.js';

export { parseCurl, buildCurl, buildFetch, buildPython, resolveRequest, base64Utf8, shellQuote, isForbiddenHeader, urlencodeStrict };

export const MASK = '••••••••';
export const BOUNDARY = '----DeveloperToolboxFormBoundary7MA4YWxk';

// =============================================================== URL helpers
const decodeSafe = s => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

/** Split a URL into parts; query keeps order and duplicates. valid=false when the URL cannot be parsed. */
export function parseUrl(url) {
  const raw = String(url ?? '').trim();
  const out = { raw, valid: false, scheme: '', username: '', password: '', hostname: '', port: '', host: '', path: '/', search: '', hash: '', query: [] };
  let u;
  try { u = new URL(raw); } catch { return out; }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return out;
  out.valid = true; out.scheme = u.protocol.replace(':', ''); out.username = decodeSafe(u.username); out.password = decodeSafe(u.password);
  out.hostname = u.hostname; out.port = u.port; out.host = u.host;
  const noHash = raw.split('#')[0];
  const qi = noHash.indexOf('?');
  out.hash = u.hash; out.path = (u.pathname || '/'); out.search = qi >= 0 ? noHash.slice(qi) : '';
  if (qi >= 0) {
    for (const part of noHash.slice(qi + 1).split('&')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      out.query.push(eq < 0 ? { key: decodeSafe(part), value: '', raw: part } : { key: decodeSafe(part.slice(0, eq)), value: decodeSafe(part.slice(eq + 1)), raw: part });
    }
  }
  return out;
}
const defaultPort = scheme => (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '');
/** request-target for an HTTP/1.1 request line: path + query */
const requestTarget = p => (p.path || '/') + p.search;

// =============================================================== masking
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-goog-api-key|private-token|x-token|x-secret)$|token|secret|passw|api[-_]?key|credential/i;
const SENSITIVE_PARAM = /^(api[-_]?key|apikey|key|token|access[-_]?token|id[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|pwd|sig|signature|auth|authorization|session|sessionid|code)$/i;
export const isSensitiveHeader = name => SENSITIVE_HEADER.test(String(name ?? '').trim());
export const isSensitiveParam = name => SENSITIVE_PARAM.test(String(name ?? '').trim());

/** Mask a header value but keep enough structure to read it (scheme, cookie names). */
export function maskHeaderValue(name, value) {
  const v = String(value ?? ''), n = String(name ?? '').toLowerCase();
  if (v === '') return v;
  if (n === 'authorization' || n === 'proxy-authorization') {
    const m = /^(\S+)\s+(.+)$/.exec(v);
    return m ? `${m[1]} ${MASK}` : MASK;
  }
  if (n === 'cookie') return v.split(/;\s*/).map(p => { const i = p.indexOf('='); return i < 0 ? p : `${p.slice(0, i)}=${MASK}`; }).join('; ');
  if (n === 'set-cookie') { const i = v.indexOf('='); return i < 0 ? MASK : `${v.slice(0, i)}=${MASK}`; }
  return MASK;
}
/** URL with sensitive query values and a userinfo password masked. */
export function maskUrl(url) {
  let s = String(url ?? '');
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@\s]*?):([^@/?#\s]*)@/i, `$1:${MASK}@`);
  return s.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, k, v) => (isSensitiveParam(decodeSafe(k)) && v !== '' ? `${sep}${k}=${MASK}` : m));
}
/** Copy of a request where every secret is replaced by bullets (for display only). */
export function maskRequest(req) {
  const r = { ...req };
  r.headers = (Array.isArray(req.headers) ? req.headers : Object.entries(req.headers || {}).map(([key, value]) => ({ key, value }))).map(h => (isSensitiveHeader(h.key) ? { ...h, value: maskHeaderValue(h.key, h.value) } : h));
  r.url = maskUrl(req.url);
  if (req.auth) {
    const a = { ...req.auth };
    if (a.type === 'basic') a.password = a.password ? MASK : '';
    else if (a.type === 'bearer') a.token = MASK;
    else if (a.type === 'apikey') a.value = MASK;
    r.auth = a;
  }
  return r;
}
export function hasSecrets(req) {
  const h = (Array.isArray(req.headers) ? req.headers : Object.entries(req.headers || {}).map(([key, value]) => ({ key, value }))).some(x => isSensitiveHeader(x.key) && String(x.value) !== '');
  return h || !!req.auth || maskUrl(req.url) !== String(req.url ?? '');
}

// =============================================================== analysis (parsed view)
const jsonLike = s => { try { return JSON.parse(s); } catch { return undefined; } };
function formPairs(body) {
  if (body === '') return [];
  if (/[\s]/.test(body.replace(/\s+$/, '')) && !/=/.test(body)) return null;
  const out = [];
  for (const part of body.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    out.push(eq < 0 ? { key: decodeSafe(part), value: '' } : { key: decodeSafe(part.slice(0, eq)), value: decodeSafe(part.slice(eq + 1)) });
  }
  return out;
}
const headerValue = (r, name) => r.headers.find(h => h.key.toLowerCase() === name)?.value;
const isJsonType = ct => /json/i.test(ct || '');

/** Everything the "Parsed request" tab shows. `reveal=false` masks secrets in the returned strings. */
export function analyze(request, { reveal = false } = {}) {
  const req = request || {};
  const r = resolveRequest(req);
  const shown = reveal ? r : resolveRequest(maskRequest(req));
  const p = parseUrl(r.url), ps = reveal ? p : parseUrl(maskUrl(r.url));
  const out = { method: r.method, url: shown.url, urlParts: null, query: [], headers: [], body: null, auth: null, flags: [], warnings: [...(req.warnings || [])] };
  if (p.valid) {
    out.urlParts = { scheme: p.scheme, host: p.hostname, port: p.port || `${defaultPort(p.scheme)} (default)`, path: p.path, hash: p.hash, userinfo: p.username ? (reveal ? `${p.username}:${p.password}` : `${p.username}:${MASK}`) : '' };
    out.query = ps.query.map(q => ({ key: q.key, value: q.value, sensitive: isSensitiveParam(q.key) }));
  } else out.warnings.push('The URL could not be parsed (it needs a scheme such as https://).');
  out.headers = r.headers.map((h, i) => ({ key: h.key, value: reveal || !isSensitiveHeader(h.key) ? h.value : shown.headers[i].value, sensitive: isSensitiveHeader(h.key), forbidden: isForbiddenHeader(h.key) }));
  // auth summary
  const authH = r.headers.find(h => h.key.toLowerCase() === 'authorization');
  if (r.basic) out.auth = { type: 'Basic', detail: `user "${r.basic.username}", password ${reveal ? JSON.stringify(r.basic.password) : (r.basic.password ? MASK : '(empty)')}` };
  else if (authH) {
    const m = /^(\S+)\s+(.*)$/.exec(authH.value);
    if (m && /^basic$/i.test(m[1])) {
      let user = '';
      try { const dec = atob(m[2].trim()); const bytes = Uint8Array.from(dec, c => c.charCodeAt(0)); const txt = new TextDecoder().decode(bytes); const i = txt.indexOf(':'); user = i < 0 ? txt : txt.slice(0, i); out.auth = { type: 'Basic', detail: `user "${user}", password ${reveal ? JSON.stringify(i < 0 ? '' : txt.slice(i + 1)) : MASK}` }; } catch { out.auth = { type: 'Basic', detail: 'credentials (could not be decoded)' }; }
    } else if (m && /^bearer$/i.test(m[1])) out.auth = { type: 'Bearer', detail: reveal ? m[2] : `token ${MASK}${/^[\w-]+\.[\w-]+\.[\w-]*$/.test(m[2]) ? ' (looks like a JWT)' : ''}` };
    else out.auth = { type: m ? m[1] : 'Custom', detail: reveal ? authH.value : maskHeaderValue('authorization', authH.value) };
  }
  const apiKey = r.headers.find(h => /^(x-api-key|api-key|apikey|x-auth-token)$/i.test(h.key));
  if (!out.auth && apiKey) out.auth = { type: 'API key', detail: `header ${apiKey.key}: ${reveal ? apiKey.value : MASK}` };
  const qkey = out.query.find(q => q.sensitive && /^(api[-_]?key|apikey|key|access[-_]?token|token)$/i.test(q.key));
  if (!out.auth && qkey) out.auth = { type: 'API key', detail: `query parameter ${qkey.key}` };
  // body
  const ct = headerValue(r, 'content-type') || '';
  if (r.multipart) out.body = { kind: 'multipart', fields: r.form.map(f => ({ key: f.key, value: f.value })) };
  else if (r.body !== '') {
    const parsed = isJsonType(ct) || /^\s*[{[]/.test(r.body) ? jsonLike(r.body) : undefined;
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) out.body = { kind: 'json', pretty: JSON.stringify(parsed, null, 2), raw: shown.body };
    else if (isJsonType(ct)) { out.body = { kind: 'text', raw: shown.body }; out.warnings.push('Content-Type says JSON but the body is not valid JSON.'); }
    else if (/x-www-form-urlencoded/i.test(ct) || (req.bodyType === 'form' && !ct)) { const f = formPairs(r.body); out.body = f ? { kind: 'form', fields: f.map(x => ({ ...x, sensitive: isSensitiveParam(x.key) })), raw: r.body } : { kind: 'text', raw: r.body }; if (out.body.kind === 'form' && !reveal) out.body.fields = out.body.fields.map(x => (x.sensitive && x.value ? { ...x, value: MASK } : x)); }
    else out.body = { kind: 'text', raw: r.body };
    out.body.bytes = new TextEncoder().encode(r.body).length;
    if (out.body.kind !== 'json' && !reveal && /(["']?(password|secret|token|api[-_]?key)["']?\s*[:=])/i.test(r.body)) out.warnings.push('The body may contain secrets; it is shown as is.');
  }
  const o = r.options || {};
  if (o.followRedirects) out.flags.push('Follow redirects (-L)');
  if (o.insecure) out.flags.push('Skip TLS verification (-k)');
  if (o.compressed) out.flags.push('Compressed response (--compressed)');
  return out;
}

// =============================================================== small string escapers
export const jsStr = s => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const phpStr = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const PY_ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
export const pyStr = s => '"' + String(s).replace(/[\\"\n\r\t\u0000-\u001f\u007f]/g, c => PY_ESC[c] || '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '"';
/** Go: interpreted string literal. */
export function goStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (c === 0xfeff || (c >= 0xd800 && c <= 0xdfff)) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}
/** Go string expression: a raw (backtick) literal when that is safe and readable, otherwise an interpreted one. */
const goText = s => { const t = String(s); return /["\\\n]/.test(t) && !/[`\r\u0000-\u0008\u000b-\u001f\u007f﻿]/.test(t) && !/[\ud800-\udfff]/.test(t.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')) ? '`' + t + '`' : goStr(t); };
/** resolveRequest + curl semantics: an explicit Authorization header wins over -u. */
function resolved(request) {
  const r = resolveRequest(request || {});
  if (r.basic && r.headers.some(h => h.key.toLowerCase() === 'authorization')) r.basic = null;
  return r;
}
const NO_BODY = new Set(['GET', 'HEAD']);
const hasBodyOf = r => (r.multipart ? r.form.length > 0 : r.body !== '');
const headersNoMultipartCt = r => r.headers.filter(h => !(r.multipart && h.key.toLowerCase() === 'content-type' && /multipart/i.test(h.value)));
const hdrIs = (h, n) => h.key.toLowerCase() === n;
const basicHeader = r => ({ key: 'Authorization', value: 'Basic ' + base64Utf8(`${r.basic.username}:${r.basic.password}`) });
/** Parse a JSON body into a literal only if it survives a round trip without losing precision. */
function jsonLiteralOk(body) {
  const v = jsonLike(body);
  if (v === undefined || v === null || typeof v !== 'object') return undefined;
  if (/\d{16,}|\d[eE][+-]?\d{3,}/.test(body)) return undefined;
  return v;
}
const indentBlock = (text, pad) => text.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n');
const objKey = k => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : jsStr(k));

// =============================================================== generators
/** axios (Node / browser). */
export function buildAxios(request) {
  const r = resolved(request);
  const headers = headersNoMultipartCt(r);
  const pre = [];
  const props = [`  method: ${jsStr(r.method.toLowerCase())}`, `  url: ${jsStr(r.url)}`];
  if (r.multipart && r.form.length) {
    pre.push('const form = new FormData();', ...r.form.map(f => `form.append(${jsStr(f.key)}, ${jsStr(f.value)});`), '');
  }
  if (headers.length) props.push(`  headers: {\n${headers.map(h => `    ${objKey(h.key)}: ${jsStr(h.value)}`).join(',\n')}\n  }`);
  if (r.basic) props.push(`  auth: {\n    username: ${jsStr(r.basic.username)},\n    password: ${jsStr(r.basic.password)}\n  }`);
  if (r.multipart && r.form.length) props.push('  data: form');
  else if (r.body !== '') {
    const lit = isJsonType(headers.find(h => hdrIs(h, 'content-type'))?.value) ? jsonLiteralOk(r.body) : undefined;
    props.push(`  data: ${lit !== undefined ? indentBlock(JSON.stringify(lit, null, 2), '  ') : jsStr(r.body)}`);
  }
  if (r.options.followRedirects === false) props.push('  maxRedirects: 0');
  if (r.options.insecure) { pre.unshift("import https from 'node:https';"); props.push('  httpsAgent: new https.Agent({ rejectUnauthorized: false })'); }
  const imports = ["import axios from 'axios';"];
  if (r.options.insecure) imports.push(pre.shift());
  return `${imports.join('\n')}\n\n${pre.length ? pre.join('\n') + '\n' : ''}const response = await axios({\n${props.join(',\n')}\n});\n\nconsole.log(response.status);\nconsole.log(response.data);\n`;
}

/** Go net/http. */
export function buildGo(request) {
  const r = resolved(request);
  const headers = headersNoMultipartCt(r);
  const imports = new Set(['fmt', 'io', 'net/http']);
  const body = [];
  let bodyArg = 'nil';
  if (r.multipart && r.form.length) {
    imports.add('bytes'); imports.add('mime/multipart');
    body.push('\tvar buf bytes.Buffer', '\tmw := multipart.NewWriter(&buf)', ...r.form.map(f => `\tmw.WriteField(${goStr(f.key)}, ${goStr(f.value)})`), '\tmw.Close()', '');
    bodyArg = '&buf';
  } else if (r.body !== '') { imports.add('strings'); body.push(`\tpayload := strings.NewReader(${goText(r.body)})`, ''); bodyArg = 'payload'; }
  const lines = [];
  lines.push(`\treq, err := http.NewRequest(${goStr(r.method)}, ${goStr(r.url)}, ${bodyArg})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
  for (const h of headers) {
    if (h.key.toLowerCase() === 'host') lines.push(`\treq.Host = ${goStr(h.value)}`);
    else lines.push(`\treq.Header.Set(${goStr(h.key)}, ${goStr(h.value)})`);
  }
  if (r.multipart && r.form.length) lines.push('\treq.Header.Set("Content-Type", mw.FormDataContentType())');
  if (r.basic) lines.push(`\treq.SetBasicAuth(${goStr(r.basic.username)}, ${goStr(r.basic.password)})`);
  let client = '\tclient := &http.Client{}';
  if (r.options.insecure) {
    imports.add('crypto/tls');
    client = '\tclient := &http.Client{\n\t\tTransport: &http.Transport{\n\t\t\tTLSClientConfig: &tls.Config{InsecureSkipVerify: true},\n\t\t},\n\t}';
  }
  if (r.options.followRedirects === false) client = client.replace('&http.Client{}', '&http.Client{\n\t\tCheckRedirect: func(req *http.Request, via []*http.Request) error {\n\t\t\treturn http.ErrUseLastResponse\n\t\t},\n\t}');
  const imp = [...imports].sort();
  return `package main\n\nimport (\n${imp.map(i => `\t"${i}"`).join('\n')}\n)\n\nfunc main() {\n${body.join('\n')}${body.length ? '\n' : ''}${lines.join('\n')}\n\n${client}\n\tresp, err := client.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer resp.Body.Close()\n\n\tdata, err := io.ReadAll(resp.Body)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tfmt.Println(resp.StatusCode)\n\tfmt.Println(string(data))\n}\n`;
}

/** PHP cURL extension. */
export function buildPhp(request) {
  const r = resolved(request);
  const headers = headersNoMultipartCt(r);
  const opts = [`    CURLOPT_URL => ${phpStr(r.url)}`, '    CURLOPT_RETURNTRANSFER => true'];
  if (r.method === 'HEAD') opts.push('    CURLOPT_NOBODY => true');
  else if (r.method === 'POST' && hasBodyOf(r)) opts.push('    CURLOPT_POST => true');
  else if (r.method !== 'GET') opts.push(`    CURLOPT_CUSTOMREQUEST => ${phpStr(r.method)}`);
  if (headers.length) opts.push(`    CURLOPT_HTTPHEADER => [\n${headers.map(h => `        ${phpStr(`${h.key}: ${h.value}`)},`).join('\n')}\n    ]`);
  if (r.multipart && r.form.length) opts.push(`    CURLOPT_POSTFIELDS => [\n${r.form.map(f => `        ${phpStr(f.key)} => ${phpStr(f.value)},`).join('\n')}\n    ]`);
  else if (r.body !== '') opts.push(`    CURLOPT_POSTFIELDS => ${phpStr(r.body)}`);
  if (r.basic) opts.push(`    CURLOPT_USERPWD => ${phpStr(`${r.basic.username}:${r.basic.password}`)}`);
  if (r.options.followRedirects) opts.push('    CURLOPT_FOLLOWLOCATION => true');
  if (r.options.insecure) opts.push('    CURLOPT_SSL_VERIFYPEER => false', '    CURLOPT_SSL_VERIFYHOST => 0');
  if (r.options.compressed) opts.push("    CURLOPT_ENCODING => ''");
  return `<?php\n\n$ch = curl_init();\ncurl_setopt_array($ch, [\n${opts.join(',\n')},\n]);\n\n$response = curl_exec($ch);\nif ($response === false) {\n    echo 'cURL error: ' . curl_error($ch);\n} else {\n    echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\\n" . $response;\n}\ncurl_close($ch);\n`;
}

/** Node.js built-in http / https. */
export function buildNode(request) {
  const r = resolved(request);
  const p = parseUrl(r.url);
  const mod = p.valid && p.scheme === 'http' ? 'http' : 'https';
  const headers = headersNoMultipartCt(r);
  if (r.basic) headers.push(basicHeader(r));
  const lines = [`const ${mod} = require('node:${mod}');`, ''];
  lines.push(`const url = new URL(${jsStr(r.url)});`);
  let bodyExpr = null;
  if (r.multipart && r.form.length) {
    lines.push(`const boundary = ${jsStr(BOUNDARY)};`);
    lines.push('const body = [', ...r.form.map(f => `  \`--\${boundary}\\r\\nContent-Disposition: form-data; name=\${JSON.stringify(${jsStr(f.key)})}\\r\\n\\r\\n\${${jsStr(f.value)}}\\r\\n\`,`), '  `--${boundary}--\\r\\n`,', "].join('');");
    headers.push({ key: 'Content-Type', value: 'multipart/form-data; boundary=${boundary}', template: true });
    bodyExpr = 'body';
  } else if (r.body !== '') { lines.push(`const body = ${jsStr(r.body)};`); bodyExpr = 'body'; }
  if (bodyExpr && !headers.some(h => hdrIs(h, 'content-length'))) headers.push({ key: 'Content-Length', value: '', dynamic: true });
  const hl = headers.map(h => `    ${objKey(h.key)}: ${h.dynamic ? 'Buffer.byteLength(body)' : h.template ? '`' + h.value + '`' : jsStr(h.value)}`);
  const optLines = [`  method: ${jsStr(r.method)}`];
  if (hl.length) optLines.push(`  headers: {\n${hl.join(',\n')}\n  }`);
  if (r.options.insecure) optLines.push('  rejectUnauthorized: false');
  lines.push('', `const req = ${mod}.request(url, {\n${optLines.join(',\n')}\n}, (res) => {`, '  const chunks = [];', "  res.on('data', (c) => chunks.push(c));", "  res.on('end', () => {", '    console.log(res.statusCode);', "    console.log(Buffer.concat(chunks).toString('utf8'));", '  });', '});', '', "req.on('error', console.error);");
  if (bodyExpr) lines.push('req.write(body);');
  lines.push('req.end();');
  if (r.options.followRedirects) lines.push('', '// Note: node:http does not follow redirects; handle res.headers.location yourself (curl -L was used).');
  return lines.join('\n') + '\n';
}

/** HTTPie command line. */
export function buildHttpie(request) {
  const r = resolved(request);
  const q = s => shellQuote(s, 'posix');
  const qs = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : q(s));
  const flags = [];
  let items = [];
  const headers = headersNoMultipartCt(r);
  const ct = headers.find(h => hdrIs(h, 'content-type'));
  let bodyPart = [];
  if (r.multipart && r.form.length) { flags.push('--multipart'); items = r.form.map(f => qs(`${f.key.replace(/([=:@\\])/g, '\\$1')}=${f.value}`)); }
  else if (r.body !== '' && ct && /x-www-form-urlencoded/i.test(ct.value) && formPairs(r.body) && formPairs(r.body).length && !/[\n\r]/.test(r.body)) {
    flags.push('--form'); items = formPairs(r.body).map(f => qs(`${f.key.replace(/([=:@\\])/g, '\\$1')}=${f.value}`));
  } else if (r.body !== '') bodyPart = ['--raw', q(r.body)];
  const hItems = headers.filter(h => !((flags.includes('--form')) && hdrIs(h, 'content-type'))).map(h => (h.value === '' ? qs(`${h.key};`) : qs(`${h.key}:${h.value}`)));
  if (r.basic) flags.push('-a', q(`${r.basic.username}:${r.basic.password}`));
  if (r.options.followRedirects) flags.push('--follow');
  if (r.options.insecure) flags.push('--verify=no');
  return ['http', ...flags, ...bodyPart, r.method, qs(r.url), ...hItems, ...items].join(' ');
}

/** PowerShell Invoke-RestMethod. */
export function buildPowerShell(request) {
  const r = resolved(request);
  const q = s => shellQuote(s, 'powershell');
  const lines = [];
  const headers = headersNoMultipartCt(r);
  if (r.basic) headers.push(basicHeader(r));
  let contentType = null, userAgent = null;
  const map = new Map();
  for (const h of headers) {
    const k = h.key.toLowerCase();
    if (k === 'content-type' && !contentType) { contentType = h.value; continue; }
    if (k === 'user-agent' && !userAgent) { userAgent = h.value; continue; }
    const key = [...map.keys()].find(x => x.toLowerCase() === k);
    if (key) map.set(key, `${map.get(key)}, ${h.value}`); else map.set(h.key, h.value);
  }
  if (map.size) lines.push('$headers = @{', ...[...map].map(([k, v]) => `    ${q(k)} = ${q(v)}`), '}');
  if (r.multipart && r.form.length) lines.push('# -Form requires PowerShell 7 or later', '$form = @{', ...r.form.map(f => `    ${q(f.key)} = ${q(f.value)}`), '}');
  else if (r.body !== '') lines.push(`$body = ${q(r.body)}`);
  const STD = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options', TRACE: 'Trace' };
  const args = [`-Uri ${q(r.url)}`, STD[r.method] ? `-Method ${STD[r.method]}` : `-CustomMethod ${q(r.method)}`];
  if (map.size) args.push('-Headers $headers');
  if (contentType && !r.multipart) args.push(`-ContentType ${q(contentType)}`);
  if (userAgent) args.push(`-UserAgent ${q(userAgent)}`);
  if (r.multipart && r.form.length) args.push('-Form $form');
  else if (r.body !== '') args.push('-Body $body');
  if (r.options.insecure) args.push('-SkipCertificateCheck');
  if (r.options.followRedirects === false) args.push('-MaximumRedirection 0');
  lines.push('', `Invoke-RestMethod ${args.join(' `\n    ')}`);
  return lines.join('\n').replace(/^\n/, '') + '\n';
}

/** Raw HTTP/1.1 request text. eol: '\n' (display) or '\r\n' (wire format). */
export function buildRawHttp(request, { eol = '\n' } = {}) {
  const r = resolved(request);
  const p = parseUrl(r.url);
  const headers = headersNoMultipartCt(r);
  if (r.basic) headers.push(basicHeader(r));
  const out = [];
  const target = p.valid ? requestTarget(p) : r.url;
  out.push(`${r.method} ${target} HTTP/1.1`);
  if (p.valid && !headers.some(h => hdrIs(h, 'host'))) out.push(`Host: ${p.hostname}${p.port && p.port !== defaultPort(p.scheme) ? ':' + p.port : ''}`);
  let body = '';
  if (r.multipart && r.form.length) {
    body = r.form.map(f => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.key.replace(/["\r\n]/g, c => (c === '"' ? '%22' : c === '\r' ? '%0D' : '%0A'))}"\r\n\r\n${f.value}\r\n`).join('') + `--${BOUNDARY}--\r\n`;
    headers.push({ key: 'Content-Type', value: `multipart/form-data; boundary=${BOUNDARY}` });
  } else body = r.body;
  for (const h of headers) out.push(`${h.key}: ${h.value}`);
  if (body !== '' && !headers.some(h => hdrIs(h, 'content-length') || hdrIs(h, 'transfer-encoding'))) out.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
  const head = out.join(eol) + eol + eol;
  return body === '' ? head : head + (eol === '\n' ? body.replace(/\r\n/g, '\n') : body);
}

/** curl with the extra flags the shared builder does not emit (-k, --compressed). */
export function buildCurlFull(request, { shell = 'posix', pretty = false } = {}) {
  const r = resolved(request);
  let s = buildCurl(request, { shell, pretty });
  const extra = [];
  if (r.options.compressed) extra.push('--compressed');
  if (r.options.insecure) extra.push('-k');
  if (extra.length) s = s.replace(/^(curl(?:\.exe)?)/, `$1 ${extra.join(' ')}`);
  return s;
}

export const TARGETS = [
  { id: 'fetch', label: 'JavaScript (fetch)', lang: 'javascript', ext: 'js', build: buildFetch },
  { id: 'axios', label: 'JavaScript (axios)', lang: 'javascript', ext: 'js', build: buildAxios },
  { id: 'node', label: 'Node.js (http / https)', lang: 'javascript', ext: 'js', build: buildNode },
  { id: 'python', label: 'Python (requests)', lang: 'python', ext: 'py', build: buildPython },
  { id: 'go', label: 'Go (net/http)', lang: 'plain', ext: 'go', build: buildGo },
  { id: 'php', label: 'PHP (cURL)', lang: 'plain', ext: 'php', build: buildPhp },
  { id: 'httpie', label: 'HTTPie', lang: 'shell', ext: 'sh', build: buildHttpie },
  { id: 'powershell', label: 'PowerShell (Invoke-RestMethod)', lang: 'plain', ext: 'ps1', build: buildPowerShell },
  { id: 'http', label: 'Raw HTTP request', lang: 'plain', ext: 'http', build: buildRawHttp },
  { id: 'curl-posix', label: 'cURL (bash)', lang: 'shell', ext: 'sh', build: r => buildCurlFull(r, { shell: 'posix', pretty: true }) },
  { id: 'curl-cmd', label: 'cURL (Windows cmd)', lang: 'plain', ext: 'cmd', build: r => buildCurlFull(r, { shell: 'cmd', pretty: true }) },
  { id: 'curl-powershell', label: 'cURL (PowerShell)', lang: 'plain', ext: 'ps1', build: r => buildCurlFull(r, { shell: 'powershell', pretty: true }) },
];
export const generate = (id, request, options) => { const t = TARGETS.find(x => x.id === id); if (!t) throw new Error(`Unknown target ${id}`); return t.build(request, options); };

// =============================================================== form -> request
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export { METHODS };

/**
 * form = { method, url, params:[{key,value}], headers:[{key,value}], bodyType:'none'|'json'|'text'|'form'|'multipart'|'raw', body, fields:[{key,value}],
 *          auth:{type:'none'|'basic'|'bearer'|'apikey', username, password, token, in:'header'|'query', name, value}, options:{followRedirects, insecure, compressed} }
 * -> { request, errors[], warnings[] }
 */
export function requestFromForm(form = {}) {
  const errors = [], warnings = [];
  const method = String(form.method || 'GET').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]*$/.test(method)) errors.push('The method must be letters only, for example GET or POST.');
  let url = String(form.url ?? '').trim();
  if (!url) errors.push('Enter a URL.');
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { warnings.push('The URL has no scheme; https:// was assumed.'); url = 'https://' + url.replace(/^\/\//, ''); }
  const params = (form.params || []).filter(p => p && String(p.key ?? '').trim() !== '');
  if (params.length && url) {
    const hash = url.indexOf('#'); const base = hash >= 0 ? url.slice(0, hash) : url, frag = hash >= 0 ? url.slice(hash) : '';
    url = base + (base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?') + params.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`).join('&') + frag;
  }
  if (url && !errors.length) { if (!parseUrl(url).valid) errors.push('The URL is not valid.'); }
  const headers = [];
  for (const h of form.headers || []) {
    const key = String(h?.key ?? '').trim(); if (!key) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) { errors.push(`"${key}" is not a valid header name.`); continue; }
    if (/[\r\n]/.test(String(h.value ?? ''))) { errors.push(`The value of header "${key}" contains a line break.`); continue; }
    headers.push({ key, value: String(h.value ?? '').trim(), enabled: true });
  }
  const has = n => headers.some(h => h.key.toLowerCase() === n);
  const bodyType = form.bodyType || 'none';
  const req = { method, url, headers, body: '', bodyType: 'json', form: [], auth: null, options: { ...(form.options || {}) } };
  const fields = (form.fields || []).filter(f => f && String(f.key ?? '').trim() !== '');
  if (bodyType === 'json') {
    req.body = String(form.body ?? ''); req.bodyType = 'json';
    if (req.body.trim() !== '' && jsonLike(req.body) === undefined) warnings.push('The JSON body is not valid JSON; it is sent as typed.');
    if (!has('content-type')) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
  } else if (bodyType === 'text' || bodyType === 'raw') {
    req.body = String(form.body ?? ''); req.bodyType = bodyType === 'raw' ? 'raw' : 'text';
    if (bodyType === 'text' && !has('content-type') && req.body !== '') headers.push({ key: 'Content-Type', value: 'text/plain', enabled: true });
  } else if (bodyType === 'form') {
    req.body = fields.map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value ?? '')}`).join('&'); req.bodyType = 'form';
    if (!has('content-type') && req.body !== '') headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
  } else if (bodyType === 'multipart') {
    req.bodyType = 'multipart'; req.form = fields.map(f => ({ key: String(f.key), value: String(f.value ?? '') }));
  }
  if ((METHODS.includes(method) && (method === 'GET' || method === 'HEAD')) && (req.body !== '' || req.form.length)) warnings.push(`${method} requests normally have no body; curl will send it anyway with -X ${method}.`);
  const a = form.auth || { type: 'none' };
  if (a.type === 'basic') { if (a.username || a.password) req.auth = { type: 'basic', username: String(a.username ?? ''), password: String(a.password ?? '') }; else warnings.push('Basic auth was selected but no username or password was entered.'); }
  else if (a.type === 'bearer') { if (a.token) req.auth = { type: 'bearer', token: String(a.token) }; else warnings.push('Bearer auth was selected but the token is empty.'); }
  else if (a.type === 'apikey') { if (a.name) req.auth = { type: 'apikey', in: a.in === 'query' ? 'query' : 'header', name: String(a.name), value: String(a.value ?? '') }; else warnings.push('API key auth was selected but the name is empty.'); }
  return { request: req, errors, warnings };
}
