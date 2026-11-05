// Run: node tests/unit/qr-code.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { qrcode } from '../../assets/js/vendor/qrcode-generator.min.js';
import * as Q from '../../tools/qr-code/logic.js';

const jsQR = createRequire(import.meta.url)('../../assets/js/vendor/jsqr.min.js');
let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const decodeMatrix = (m, scale = 5) => jsQR(...(({ data, width, height }) => [data, width, height])(Q.matrixToRgba(m, scale, 4)));
const roundTrip = (text, ec = 'M') => {
  const m = Q.makeMatrix(qrcode, text, ec); assert.ok(!m.error, m.error);
  const r = decodeMatrix(m); assert.ok(r, `jsQR found nothing for ${JSON.stringify(text.slice(0, 20))} (v${m.version})`);
  return { m, text: r.data };
};

test('HELLO WORLD at Q is version 1 (21x21), alphanumeric mode, finder patterns present', () => {
  const m = Q.makeMatrix(qrcode, 'HELLO WORLD', 'Q');
  assert.equal(m.size, 21); assert.equal(m.version, 1); assert.equal(m.mode, 'Alphanumeric');
  for (const [r0, c0] of [[0, 0], [0, 14], [14, 0]]) { // 7x7 finder: dark ring, light ring, 3x3 dark core
    assert.ok(m.rows[r0][c0 + 3] && m.rows[r0 + 3][c0] && m.rows[r0 + 6][c0 + 6]);
    assert.ok(!m.rows[r0 + 1][c0 + 1] && !m.rows[r0 + 1][c0 + 5]);
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) assert.ok(m.rows[r0 + r][c0 + c]);
  }
  assert.ok(m.rows[13][8], 'dark module present'); // always-dark module at (4V+9, 8)
});
test('round trip ASCII at every EC level', () => {
  for (const ec of Q.EC_LEVELS) assert.equal(roundTrip('Hello, QR! 12345 abc', ec).text, 'Hello, QR! 12345 abc');
});
test('round trip UTF-8: accents, CJK, emoji', () => {
  for (const s of ['héllo wörld', '日本語のテキスト', 'smile 😀 party 🎉', 'Ünïcödé — “quotes” €']) assert.equal(roundTrip(s).text, s);
});
test('round trip numeric and alphanumeric modes', () => {
  const a = roundTrip('0123456789012345'); assert.equal(a.m.mode, 'Numeric'); assert.equal(a.text, '0123456789012345');
  const b = roundTrip('HTTPS://EXAMPLE.COM/ABC-1'); assert.equal(b.m.mode, 'Alphanumeric'); assert.equal(b.text, 'HTTPS://EXAMPLE.COM/ABC-1');
});
test('round trip URL, Wi-Fi, vCard payloads and larger versions', () => {
  const url = 'https://example.com/path?q=a%20b&x=1#frag'; assert.equal(roundTrip(url).text, url);
  const w = Q.buildWifi({ ssid: 'My;Net:"1"', password: 'pa,ss\\word;1', type: 'WPA' }).text; assert.equal(roundTrip(w, 'Q').text, w);
  const v = Q.buildVcard({ firstName: 'Ada', lastName: 'Lovelace', phone: '+44 1', email: 'ada@example.com', note: 'x;y,z\nline2' }).text; assert.equal(roundTrip(v).text, v);
  const big = 'lorem ipsum '.repeat(60); const r = roundTrip(big, 'L'); assert.equal(r.text, big); assert.ok(r.m.version > 10);
});
test('multiple QR codes in one image are all found', () => {
  const a = Q.makeMatrix(qrcode, 'first code', 'M'), b = Q.makeMatrix(qrcode, 'second code, longer text 😀', 'M');
  const W = 600, H = 300;
  const img = Q.matrixToRgba(a, 5, 4, W, H, 10, 20);
  const img2 = Q.matrixToRgba(b, 5, 4, W, H, 320, 20);
  for (let i = 0; i < img.data.length; i += 4) if (img2.data[i] === 0) img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; // union (both are dark-on-white)
  const found = Q.findAllQr(jsQR, img);
  assert.deepEqual(found.map(f => f.text).sort(), ['first code', 'second code, longer text 😀'].sort());
});
test('findAllQr returns [] for a blank image', () => {
  assert.deepEqual(Q.findAllQr(jsQR, { data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 }), []);
});
test('capacity errors are explained with numbers and EC advice', () => {
  const m = Q.makeMatrix(qrcode, 'x'.repeat(2400), 'H'); assert.match(m.error, /2,400 bytes/); assert.match(m.error, /1,273/); assert.match(m.error, /L would fit/);
  const ok = Q.makeMatrix(qrcode, 'x'.repeat(2331), 'M'); assert.ok(!ok.error); assert.equal(ok.version, 40);
  const e = Q.makeMatrix(qrcode, '😀'.repeat(800), 'L'); assert.match(e.error, /3,200 bytes/);
  assert.ok(Q.makeMatrix(qrcode, '', 'M').error); assert.ok(Q.makeMatrix(qrcode, 'a', 'Z').error);
});
test('max-capacity numeric payload encodes', () => {
  const m = Q.makeMatrix(qrcode, '7'.repeat(7089), 'L'); assert.ok(!m.error, m.error); assert.equal(m.size, 177);
});
test('mode detection', () => {
  assert.equal(Q.detectMode('123'), 'Numeric'); assert.equal(Q.detectMode('AB 1-$%*+./:'), 'Alphanumeric'); assert.equal(Q.detectMode('abc'), 'Byte'); assert.equal(Q.detectMode('é'), 'Byte');
});
test('SVG output: structure, dark module count, colours, no external refs, transparent', () => {
  const m = Q.makeMatrix(qrcode, 'SVG test', 'M');
  const svg = Q.matrixToSvg(m, { margin: 2, size: 300, fg: '#112233', bg: '#ffeedd' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
  assert.ok(svg.includes(`viewBox="0 0 ${m.size + 4} ${m.size + 4}"`)); assert.ok(svg.includes('fill="#112233"') && svg.includes('fill="#ffeedd"'));
  assert.ok(!/href|<image|<script|http:\/\/(?!www\.w3\.org)/.test(svg));
  const d = /d="([^"]*)"/.exec(svg)[1]; let dark = 0; for (const mm of d.matchAll(/h(\d+)v1h-\1z/g)) dark += Number(mm[1]);
  assert.equal(dark, m.rows.flat().filter(Boolean).length);
  assert.ok(!Q.matrixToSvg(m, { transparent: true }).includes('<rect'));
  assert.throws(() => Q.matrixToSvg(m, { fg: 'red' }));
});
test('computeScale gives integer scale and flags too-small sizes', () => {
  assert.deepEqual(Q.computeScale(21, 4, 290), { scale: 10, units: 29, px: 290, tooSmall: false });
  assert.equal(Q.computeScale(21, 4, 300).px, 290); assert.equal(Q.computeScale(177, 4, 100).tooSmall, true); assert.equal(Q.computeScale(177, 4, 100).scale, 1);
});
test('contrast and readability warnings', () => {
  assert.equal(Math.round(Q.contrastRatio('#000000', '#ffffff')), 21); assert.equal(Q.contrastRatio('#777777', '#777777'), 1);
  assert.deepEqual(Q.checkReadability('#000000', '#ffffff', 4).warnings, []);
  assert.ok(Q.checkReadability('#ffffff', '#000000', 4).warnings.some(w => /inverted/.test(w)));
  assert.ok(Q.checkReadability('#888888', '#999999', 4).warnings.some(w => /very low/.test(w)));
  assert.ok(Q.checkReadability('#000000', '#ffffff', 1).warnings.some(w => /quiet zone/.test(w)));
  assert.ok(Q.checkReadability('#000000', '#ffffff', 4, true).warnings.some(w => /transparent/.test(w)));
  assert.ok(Q.isHexColor('#a1B2c3')); assert.ok(!Q.isHexColor('#abc')); assert.ok(!Q.isHexColor('red'));
});
test('buildWifi escaping, security types, errors', () => {
  assert.equal(Q.buildWifi({ ssid: 'Home', password: 'secret123' }).text, 'WIFI:T:WPA;S:Home;P:secret123;;');
  assert.equal(Q.buildWifi({ ssid: 'a;b,c:d"e\\f', password: 'p;q:r,s"t\\u', type: 'WEP' }).text, 'WIFI:T:WEP;S:a\\;b\\,c\\:d\\"e\\\\f;P:p\\;q\\:r\\,s\\"t\\\\u;;');
  assert.equal(Q.buildWifi({ ssid: 'Open', type: 'nopass', hidden: true }).text, 'WIFI:T:nopass;S:Open;H:true;;');
  assert.equal(Q.buildWifi({ ssid: '1234', password: 'abcdef12' }).text, 'WIFI:T:WPA;S:"1234";P:"abcdef12";;');
  assert.ok(Q.buildWifi({ ssid: '' }).error); assert.ok(Q.buildWifi({ ssid: 'x', password: '' }).error); assert.ok(Q.buildWifi({ ssid: 'x', password: 'short' }).error);
});
test('parseWifi inverts buildWifi for tricky values', () => {
  for (const o of [{ ssid: 'My;Net:"1"', password: 'pa,ss\\word;1', type: 'WPA' }, { ssid: '日本 😀', password: 'пароль-12345', type: 'WPA' }, { ssid: '1234', password: 'abcdef12', type: 'WPA' }, { ssid: 'Open', type: 'nopass', hidden: true }]) {
    const p = Q.parseWifi(Q.buildWifi(o).text);
    assert.equal(p.ssid, o.ssid); assert.equal(p.password, o.password || ''); assert.equal(p.security, o.type); assert.equal(p.hidden, !!o.hidden);
  }
  assert.equal(Q.parseWifi('WIFI:S:x;T:WPA;P:y;;').password, 'y'); assert.equal(Q.parseWifi('not wifi'), null); assert.equal(Q.parseWifi('WIFI:T:WPA;;'), null);
});
test('buildVcard escaping and parseVcard', () => {
  const t = Q.buildVcard({ firstName: 'A;B', lastName: 'C,D', org: 'Acme\\Co', phone: '123', email: 'a@b.co', url: 'https://x.y', street: '1 Main', city: 'Town', postal: '999', note: 'l1\nl2' }).text;
  assert.ok(t.startsWith('BEGIN:VCARD\nVERSION:3.0\nN:C\\,D;A\\;B;;;\nFN:A\\;B C\\,D')); assert.ok(t.endsWith('END:VCARD')); assert.ok(t.includes('NOTE:l1\\nl2')); assert.ok(t.includes('ORG:Acme\\\\Co'));
  const p = Q.parseVcard(t); const get = l => p.fields.find(f => f.label.startsWith(l))?.value;
  assert.equal(get('Name'), 'A;B C,D'); assert.equal(get('Organisation'), 'Acme\\Co'); assert.equal(get('Phone'), '123'); assert.equal(get('Note'), 'l1\nl2'); assert.equal(get('Address'), '1 Main, Town, 999');
  assert.ok(Q.buildVcard({}).error); assert.equal(Q.parseVcard('hello'), null);
  assert.equal(Q.parseVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nEND:VCARD').fields[0].value, 'Jane Doe');
});
test('MECARD parse', () => {
  const p = Q.parseMecard('MECARD:N:Doe,John;TEL:123;EMAIL:j@d.co;NOTE:a\\;b;;');
  assert.deepEqual(p.fields, [{ label: 'Name', value: 'John Doe' }, { label: 'Phone', value: '123' }, { label: 'Email', value: 'j@d.co' }, { label: 'Note', value: 'a;b' }]);
});
test('email/SMS/geo/url builders', () => {
  assert.equal(Q.buildEmail({ to: 'a@b.co', subject: 'Hi there & you', body: 'Line1\nLine2 é' }).text, 'mailto:a@b.co?subject=Hi%20there%20%26%20you&body=Line1%0ALine2%20%C3%A9');
  assert.equal(Q.buildEmail({ to: 'a@b.co' }).text, 'mailto:a@b.co'); assert.ok(Q.buildEmail({ to: 'nope' }).error); assert.ok(Q.buildEmail({}).error);
  assert.equal(Q.buildSms({ number: '+1 (555) 123-4567', message: 'Hello: world' }).text, 'SMSTO:+15551234567:Hello: world'); assert.ok(Q.buildSms({ number: 'abc' }).error); assert.ok(Q.buildSms({}).error);
  assert.equal(Q.buildGeo({ lat: '48.8584', lng: '2.2945' }).text, 'geo:48.8584,2.2945'); assert.ok(Q.buildGeo({ lat: '91', lng: '0' }).error); assert.ok(Q.buildGeo({ lat: '0', lng: '181' }).error); assert.ok(Q.buildGeo({ lat: '', lng: '1' }).error); assert.ok(Q.buildGeo({ lat: 'x', lng: '1' }).error);
  assert.deepEqual(Q.buildUrl('example.com/a'), { text: 'https://example.com/a', note: 'No scheme given, so https:// was added.' });
  assert.deepEqual(Q.buildUrl('http://x.y'), { text: 'http://x.y' }); assert.equal(Q.buildUrl('localhost:3000/x').text, 'https://localhost:3000/x'); assert.ok(Q.buildUrl(' ').error);
  assert.equal(Q.buildPayload('text', { text: 'ünï' }).text, 'ünï'); assert.ok(Q.buildPayload('text', {}).error); assert.ok(Q.buildPayload('zzz').error);
});
test('parse mailto/sms/geo', () => {
  assert.deepEqual(Q.parseMailto('mailto:a@b.co?subject=Hi%20there&body=x%0Ay'), { to: 'a@b.co', subject: 'Hi there', body: 'x\ny', cc: '' });
  assert.deepEqual(Q.parseSms('SMSTO:+15551234567:Hello: world'), { number: '+15551234567', message: 'Hello: world' });
  assert.deepEqual(Q.parseSms('sms:+155?body=Hi%20you'), { number: '+155', message: 'Hi you' });
  assert.deepEqual(Q.parseGeo('geo:48.85,2.29'), { lat: 48.85, lng: 2.29 }); assert.equal(Q.parseGeo('geo:95,0'), null);
});
test('punycode decode (RFC 3492 / IDNA samples)', () => {
  assert.equal(Q.punycodeDecode('bcher-kva'), 'bücher'); assert.equal(Q.punycodeDecode('mnchen-3ya'), 'münchen'); assert.equal(Q.punycodeDecode('e1afmkfd'), 'пример');
  assert.equal(Q.hostToUnicode('xn--bcher-kva.example.com'), 'bücher.example.com'); assert.equal(Q.hostToUnicode('plain.com'), 'plain.com');
  assert.throws(() => Q.punycodeDecode('!!'));
});
test('analyzeUrl: safe, punycode lookalike, credentials, ip, javascript:, http, port', () => {
  const ok = Q.analyzeUrl('https://example.com/a?b=1'); assert.equal(ok.linkable, true); assert.deepEqual(ok.warnings, []); assert.equal(ok.href, 'https://example.com/a?b=1');
  const pc = Q.analyzeUrl('https://xn--80ak6aa92e.com/'); assert.ok(pc.warnings.some(w => /punycode/.test(w))); assert.ok(/[^\x00-\x7f]/.test(pc.unicodeHost));
  const uni = Q.analyzeUrl('https://bücher.example/'); assert.ok(uni.warnings.some(w => /punycode/.test(w)));
  assert.ok(Q.analyzeUrl('https://google.com@evil.test/').warnings.some(w => /username/.test(w))); assert.equal(Q.analyzeUrl('https://google.com@evil.test/').host, 'evil.test');
  assert.ok(Q.analyzeUrl('http://192.168.1.1/x').warnings.some(w => /IP address/.test(w))); assert.ok(Q.analyzeUrl('http://example.com').warnings.some(w => /not encrypted/.test(w)));
  assert.ok(Q.analyzeUrl('https://example.com:8443/').warnings.some(w => /port/.test(w)));
  for (const s of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://x.y/z']) { const a = Q.analyzeUrl(s); assert.equal(a.linkable, false, s); assert.ok(a.warnings.length); }
  assert.equal(Q.analyzeUrl('not a url'), null); assert.equal(Q.analyzeUrl('https://exa mple.com'), null);
});
test('detectType', () => {
  const t = s => Q.detectType(s).type;
  assert.equal(t('WIFI:T:WPA;S:x;P:y;;'), 'wifi'); assert.equal(t('BEGIN:VCARD\nFN:A\nEND:VCARD'), 'vcard'); assert.equal(t('MECARD:N:A,B;;'), 'mecard');
  assert.equal(t('mailto:a@b.co'), 'email'); assert.equal(t('SMSTO:123:hi'), 'sms'); assert.equal(t('geo:1,2'), 'geo'); assert.equal(t('tel:+123'), 'tel');
  assert.equal(t('otpauth://totp/x?secret=ABC'), 'otp'); assert.equal(t('https://example.com'), 'url'); assert.equal(t('javascript:alert(1)'), 'url');
  assert.equal(t('hello world'), 'text'); assert.equal(t(''), 'text'); assert.equal(Q.detectType('javascript:alert(1)').url.linkable, false);
});
test('scaleToFit and friendlyCameraError', () => {
  assert.deepEqual(Q.scaleToFit(8000, 4000, 2000), { width: 2000, height: 1000, scale: 0.25 }); assert.deepEqual(Q.scaleToFit(100, 50, 2000), { width: 100, height: 50, scale: 1 });
  assert.match(Q.friendlyCameraError({ name: 'NotAllowedError' }), /denied/); assert.match(Q.friendlyCameraError({ name: 'NotFoundError' }), /No camera/);
  assert.match(Q.friendlyCameraError({ name: 'NotReadableError' }), /in use/); assert.match(Q.friendlyCameraError({ name: 'SecurityError' }), /HTTPS/); assert.match(Q.friendlyCameraError({ message: 'boom' }), /boom/);
});
test('vendored libs are the genuine npm builds (identifying markers)', () => {
  assert.equal(typeof jsQR, 'function'); assert.equal(typeof qrcode, 'function'); assert.equal(typeof qrcode.stringToBytes, 'function');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL', name, '\n ', e.message); }
}
console.log(`qr-code: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
