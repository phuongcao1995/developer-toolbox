// Run: node tests/unit/color-converter.test.mjs   (from the project root)
import assert from 'node:assert/strict';
import * as L from '../../tools/color-converter/logic.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const P = s => { const r = L.parseColor(s); assert.ok(r.ok, `${s}: ${r.error}`); return r.color; };
const F = (s, id, o) => L.formatColor(P(s), id, o);
const near = (a, b, t = 0.002, msg = '') => assert.ok(Math.abs(a - b) <= t, `${msg} ${a} vs ${b}`);
const rgb255 = c => { const k = L.to255(c); return [k.r, k.g, k.b]; };

// ---------- parsing: hex ----------
test('hex 6 with/without #', () => { assert.deepEqual(rgb255(P('#3a58e8')), [58, 88, 232]); assert.deepEqual(rgb255(P('3a58e8')), [58, 88, 232]); });
test('hex 3', () => assert.deepEqual(rgb255(P('#f80')), [255, 136, 0]));
test('hex 4 alpha', () => { const c = P('#f808'); assert.deepEqual(rgb255(c), [255, 136, 0]); near(c.a, 0x88 / 255, 1e-9); });
test('hex 8 alpha', () => near(P('#ff000080').a, 128 / 255, 1e-9));
test('hex uppercase', () => assert.deepEqual(rgb255(P('#FFAA00')), [255, 170, 0]));
test('hex surrounding whitespace and semicolon', () => assert.deepEqual(rgb255(P('  #fff; ')), [255, 255, 255]));
test('hex invalid lengths', () => { for (const s of ['#12', '#12345', '#1234567', '#ggg', '#12345678f']) assert.equal(L.parseColor(s).ok, false, s); });
test('empty input', () => { assert.equal(L.parseColor('').ok, false); assert.equal(L.parseColor(null).ok, false); assert.match(L.parseColor('   ').error, /Enter/); });

// ---------- parsing: functions ----------
test('rgb comma and space', () => { assert.deepEqual(rgb255(P('rgb(255, 0, 0)')), [255, 0, 0]); assert.deepEqual(rgb255(P('rgb(255 0 0)')), [255, 0, 0]); });
test('rgba legacy alpha and slash alpha', () => { near(P('rgba(0,0,0,0.5)').a, 0.5, 1e-9); near(P('rgb(0 0 0 / 50%)').a, 0.5, 1e-9); });
test('rgb percentages', () => assert.deepEqual(rgb255(P('rgb(100% 50% 0%)')), [255, 128, 0]));
test('rgb clamps and warns', () => { const r = L.parseColor('rgb(300 -5 0)'); assert.deepEqual(rgb255(r.color), [255, 0, 0]); assert.ok(r.warnings.length); });
test('rgb none keyword', () => assert.deepEqual(rgb255(P('rgb(none 128 none)')), [0, 128, 0]));
test('rgb wrong arg count', () => assert.match(L.parseColor('rgb(1 2)').error, /3 values/));
test('rgb garbage value', () => assert.equal(L.parseColor('rgb(a b c)').ok, false));
test('case-insensitive function names', () => assert.deepEqual(rgb255(P('RGB(255 0 0)')), [255, 0, 0]));
test('hsl basic', () => assert.deepEqual(rgb255(P('hsl(120 100% 50%)')), [0, 255, 0]));
test('hsl legacy commas + hsla', () => { assert.deepEqual(rgb255(P('hsl(240, 100%, 50%)')), [0, 0, 255]); near(P('hsla(0, 100%, 50%, 0.25)').a, 0.25, 1e-9); });
test('hsl hue units', () => { for (const h of ['0.5turn', '180deg', '200grad', '3.14159265rad']) assert.deepEqual(rgb255(P(`hsl(${h} 100% 50%)`)), rgb255(P('hsl(180 100% 50%)')), h); });
test('hsl negative and >360 hue wrap', () => { assert.deepEqual(rgb255(P('hsl(-120 100% 50%)')), [0, 0, 255]); assert.deepEqual(rgb255(P('hsl(480 100% 50%)')), [0, 255, 0]); });
test('hwb', () => { assert.deepEqual(rgb255(P('hwb(0 0% 0%)')), [255, 0, 0]); assert.deepEqual(rgb255(P('hwb(0 50% 50%)')), [128, 128, 128]); assert.deepEqual(rgb255(P('hwb(120 20% 20%)')), [51, 204, 51]); });
test('lab red', () => { const c = P('lab(54.29 80.8 69.89)'); assert.deepEqual(rgb255(c), [255, 0, 0]); });
test('lch red', () => assert.deepEqual(rgb255(P('lch(54.29 106.84 40.86)')), [255, 0, 0]));
test('oklab / oklch red', () => { assert.deepEqual(rgb255(P('oklab(0.628 0.2249 0.1258)')), [255, 0, 0]); assert.deepEqual(rgb255(P('oklch(0.628 0.2577 29.23)')), [255, 0, 0]); });
test('oklch percentage lightness', () => assert.deepEqual(rgb255(P('oklch(100% 0 0)')), [255, 255, 255]));
test('lab percent', () => assert.deepEqual(rgb255(P('lab(100% 0 0)')), [255, 255, 255]));
test('color srgb', () => assert.deepEqual(rgb255(P('color(srgb 1 0.5 0)')), [255, 128, 0]));
test('color srgb-linear', () => assert.deepEqual(rgb255(P('color(srgb-linear 1 1 1)')), [255, 255, 255]));
test('color display-p3 white', () => assert.deepEqual(rgb255(P('color(display-p3 1 1 1)')), [255, 255, 255]));
test('color display-p3 red is out of sRGB gamut', () => { const r = L.parseColor('color(display-p3 1 0 0)'); assert.equal(r.inGamut, false); assert.deepEqual(rgb255(r.color), [255, 0, 0]); });
test('color unknown space', () => assert.match(L.parseColor('color(rec2020 1 0 0)').error, /not supported/));
test('color with alpha', () => near(P('color(srgb 1 0 0 / 0.4)').a, 0.4, 1e-9));
test('cmyk percent and fraction', () => { assert.deepEqual(rgb255(P('cmyk(0% 100% 100% 0%)')), [255, 0, 0]); assert.deepEqual(rgb255(P('cmyk(0, 1, 1, 0)')), [255, 0, 0]); assert.deepEqual(rgb255(P('cmyk(0 100 100 0)')), [255, 0, 0]); });
test('named colours incl. case and transparent', () => { assert.deepEqual(rgb255(P('RebeccaPurple')), [102, 51, 153]); assert.equal(P('transparent').a, 0); });
test('currentColor and unknown function rejected', () => { assert.equal(L.parseColor('currentColor').ok, false); assert.equal(L.parseColor('foo(1 2 3)').ok, false); });
test('non colour text', () => assert.equal(L.parseColor('hello world').ok, false));
test('invalid alpha', () => assert.equal(L.parseColor('rgb(0 0 0 / abc)').ok, false));
test('very long input rejected', () => assert.equal(L.parseColor('#' + 'a'.repeat(500)).ok, false));
test('Unicode input rejected cleanly', () => assert.equal(L.parseColor('красный').ok, false));
test('alpha clamped', () => assert.equal(P('rgb(0 0 0 / 3)').a, 1));

// ---------- named colours ----------
test('148 named colours, all valid and 6 hex digits', () => {
  const names = Object.keys(L.NAMED_COLORS);
  assert.equal(names.length, 148);
  for (const n of names) assert.match(L.NAMED_COLORS[n], /^[0-9a-f]{6}$/, n);
});
test('named colours parse to their hex', () => { for (const [n, h] of Object.entries(L.NAMED_COLORS)) assert.equal(F(n, 'hex'), '#' + h, n); });
test('nearestName exact and approximate', () => {
  assert.equal(L.nearestName(P('#ff0000')).name, 'red'); assert.equal(L.nearestName(P('#ff0000')).exact, true);
  const n = L.nearestName(P('#fe0101')); assert.equal(n.name, 'red'); assert.equal(n.exact, false);
  assert.equal(L.nearestName(P('#808080')).name, 'gray');
});

// ---------- conversion values ----------
test('#ff0000 -> hsl(0 100% 50%)', () => assert.equal(F('#ff0000', 'hsl'), 'hsl(0 100% 50%)'));
test('#ff0000 -> oklch(0.628 0.2577 29.23)', () => assert.equal(F('#ff0000', 'oklch'), 'oklch(0.628 0.2577 29.23)'));
test('#ff0000 -> oklab', () => assert.equal(F('#ff0000', 'oklab'), 'oklab(0.628 0.2249 0.1258)'));
test('#ff0000 -> lab (D50)', () => assert.equal(F('#ff0000', 'lab'), 'lab(54.29 80.8 69.89)'));
test('#ff0000 -> lch (D50)', () => assert.equal(F('#ff0000', 'lch'), 'lch(54.29 106.84 40.86)'));
test('#ff0000 -> display-p3', () => assert.equal(F('#ff0000', 'p3'), 'color(display-p3 0.9175 0.2003 0.1386)'));
test('#ff0000 -> cmyk/hwb/hsv', () => { assert.equal(F('#ff0000', 'cmyk'), 'cmyk(0% 100% 100% 0%)'); assert.equal(F('#ff0000', 'hwb'), 'hwb(0 0% 0%)'); assert.equal(F('#ff0000', 'hsv'), 'hsv(0 100% 100%)'); });
test('white and black', () => {
  assert.equal(F('#fff', 'lab'), 'lab(100 0 0)'); assert.equal(F('#fff', 'oklab'), 'oklab(1 0 0)'); assert.equal(F('#fff', 'hsl'), 'hsl(0 0% 100%)');
  assert.equal(F('#000', 'oklch'), 'oklch(0 0 0)'); assert.equal(F('#000', 'cmyk'), 'cmyk(0% 0% 0% 100%)'); assert.equal(F('black', 'lab'), 'lab(0 0 0)');
});
test('#00ff00 and #0000ff oklch hues', () => { assert.equal(F('#00ff00', 'oklch'), 'oklch(0.866 0.2948 142.5)'); assert.match(F('#0000ff', 'oklch'), /^oklch\(0\.452 0\.3132 264\.05\)$/); });
test('#3a58e8 hsl/rgb', () => { assert.equal(F('#3a58e8', 'hsl'), 'hsl(230 79% 57%)'); assert.equal(F('#3a58e8', 'rgb'), 'rgb(58 88 232)'); });
test('gray lab is neutral; D50 white matches CSS', () => { const l = L.srgbToLab(P('#808080')); near(l.a, 0, 0.01); near(l.b, 0, 0.01); near(l.l, 53.585, 0.01); });
test('Bradford D65->D50 maps white to white', () => { const v = L.srgbToXyzD50(P('#fff')); near(v[0], L.WHITE_D50[0], 1e-6); near(v[1], 1, 1e-6); near(v[2], L.WHITE_D50[2], 1e-6); });
test('sRGB XYZ D65 of red', () => { const v = L.srgbToXyz(P('#f00')); near(v[0], 0.4124, 1e-3); near(v[1], 0.2126, 1e-3); near(v[2], 0.0193, 1e-3); });
test('transfer function round trip', () => { for (const x of [0, 0.002, 0.04, 0.5, 1]) near(L.linearToSrgb(L.srgbToLinear(x)), x, 1e-12); near(L.srgbToLinear(0.5), 0.2140, 1e-3); });
test('round trips for many colours through every space', () => {
  const samples = ['#3a58e8', '#ff8800', '#12ab34', '#fedcba', '#010101', '#fefefe', '#808080', '#c62d3d'];
  for (const s of samples) {
    const c = P(s);
    const back = [L.labToSrgb(L.srgbToLab(c)), L.lchToSrgb(L.srgbToLch(c)), L.oklabToSrgb(L.srgbToOklab(c)), L.oklchToSrgb(L.srgbToOklch(c)),
      L.hslToSrgb(L.srgbToHsl(c)), L.hwbToSrgb(L.srgbToHwb(c)), L.hsvToSrgb(L.srgbToHsv(c)), L.cmykToSrgb(L.srgbToCmyk(c)), L.displayP3ToSrgb(L.srgbToDisplayP3(c))];
    back.forEach((b, i) => assert.deepEqual(rgb255(b), rgb255(c), `${s} space #${i}`));
  }
});
test('hex round trip over a sweep', () => { for (let i = 0; i < 256; i += 15) for (let j = 0; j < 256; j += 51) { const h = L.formatHex(L.from255(i, j, 255 - i)); assert.deepEqual(rgb255(P(h)), [i, j, 255 - i]); } });
test('gamut flag', () => { assert.equal(L.parseColor('oklch(0.7 0.4 150)').inGamut, false); assert.equal(L.parseColor('#abc').inGamut, undefined); assert.equal(L.parseColor('rgb(1 2 3)').inGamut, true); });
test('out of gamut keeps oklch precision, clamps hex', () => { const c = P('oklch(0.7 0.4 150)'); assert.match(L.formatColor(c, 'oklch'), /^oklch\(0\.7 0\.4 150\)$/); assert.match(L.formatColor(c, 'hex'), /^#[0-9a-f]{6}$/); });
test('rgbToXyzMatrix white (1,1,1) maps to the white point', () => {
  const m = L.rgbToXyzMatrix([[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], [0.3127, 0.3290]);
  near(m[0][0] + m[0][1] + m[0][2], L.WHITE_D65[0], 1e-9); near(m[1][0] + m[1][1] + m[1][2], 1, 1e-9);
});

// ---------- formatting options ----------
test('hex alpha and case/short', () => {
  assert.equal(F('#ff000080', 'hex'), '#ff000080'); assert.equal(F('#abcdef', 'hex', { hexCase: 'upper' }), '#ABCDEF');
  assert.equal(F('#aabbcc', 'hex', { hexShort: true }), '#abc'); assert.equal(F('#aabbcd', 'hex', { hexShort: true }), '#aabbcd');
  assert.equal(F('#aabbcc88', 'hex', { hexShort: true }), '#abc8'); assert.equal(F('#aabbcc7f', 'hex', { hexShort: true }), '#aabbcc7f');
});
test('hex8 always has alpha', () => assert.equal(F('#ff0000', 'hex8'), '#ff0000ff'));
test('rgb with alpha, modern and legacy', () => {
  assert.equal(F('rgb(1 2 3 / 0.5)', 'rgb'), 'rgb(1 2 3 / 0.5)'); assert.equal(F('rgb(1 2 3 / 0.5)', 'rgb', { syntax: 'legacy' }), 'rgba(1, 2, 3, 0.5)');
  assert.equal(F('#fff', 'rgb', { syntax: 'legacy' }), 'rgb(255, 255, 255)'); assert.equal(F('hsl(10 20% 30% / 0.5)', 'hsl', { syntax: 'legacy' }), 'hsla(10, 20%, 30%, 0.5)');
});
test('rounding options', () => {
  assert.equal(F('#3a58e8', 'hsl', { rounding: 2 }), 'hsl(229.57 78.65% 57.06%)'.replace('229.57', L.roundTo(L.srgbToHsl(P('#3a58e8')).h, 2).toString()).replace('78.65', String(L.roundTo(L.srgbToHsl(P('#3a58e8')).s * 100, 2))).replace('57.06', String(L.roundTo(L.srgbToHsl(P('#3a58e8')).l * 100, 2))));
  assert.equal(F('rgb(10.4 20.6 30 / 0.12345)', 'rgb', { rounding: 'compact' }), 'rgb(10 21 30 / 0.123)');
  assert.equal(F('rgb(10.4 20.6 30)', 'rgb', { rounding: 1 }), 'rgb(10.4 20.6 30)');
  assert.equal(F('#ff0000', 'oklab', { rounding: 'full' }).split(' ').length, 3);
  assert.equal(F('#ff0000', 'oklch', { rounding: 0 }), 'oklch(1 0 29)');
});
test('precision clamps bad values', () => { assert.equal(L.precision({ rounding: 99 }, 'rgb'), 6); assert.equal(L.precision({ rounding: 'x' }, 'rgb'), 0); assert.equal(L.precision({}, 'oklchC'), 4); });
test('roundTo avoids -0 and float noise', () => { assert.equal(L.roundTo(-0.0001, 2), 0); assert.equal(Object.is(L.roundTo(-0.0001, 2), -0), false); assert.equal(L.roundTo(1.005, 2), 1.01); });
test('formatAll returns all ids with labels', () => { const all = L.formatAll(P('#f00')); assert.equal(all.length, L.FORMAT_IDS.length); assert.ok(all.every(r => r.label && r.value)); });
test('formatColor unknown id throws', () => assert.throws(() => L.formatColor(P('#f00'), 'nope'), /Unknown/));
test('android ARGB', () => assert.equal(F('#ff000080', 'android'), '#80ff0000  (0x80FF0000)'));
test('output re-parses to the same colour (all CSS formats)', () => {
  const c = P('#3a58e8');
  for (const id of ['hex', 'rgb', 'hsl', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'srgb', 'p3', 'cmyk']) {
    const back = L.parseColor(L.formatColor(c, id, { rounding: 'full' }));
    assert.ok(back.ok, id);
    for (const [x, y] of [[back.color.r, c.r], [back.color.g, c.g], [back.color.b, c.b]]) near(x, y, 0.02, id);
  }
});

// ---------- contrast ----------
test('white/black 21:1', () => { near(L.contrastRatio(P('#000'), P('#fff')), 21, 1e-9); assert.equal(L.formatRatio(21), '21.00:1'); });
test('#767676 on white = 4.54:1', () => assert.equal(L.formatRatio(L.contrastRatio(P('#767676'), P('#fff'))), '4.54:1'));
test('#777777 on white fails AA normal', () => { const r = L.contrastRatio(P('#777'), P('#fff')); assert.equal(L.formatRatio(r), '4.47:1'); assert.equal(L.wcagChecks(r).find(x => x.id === 'aa-normal').pass, false); });
test('same colour is 1:1', () => near(L.contrastRatio(P('#abc'), P('#abc')), 1, 1e-12));
test('ratio is symmetric', () => near(L.contrastRatio(P('#123456'), P('#fedcba')), L.contrastRatio(P('#fedcba'), P('#123456')), 1e-12));
test('formatRatio truncates rather than rounds up', () => { assert.equal(L.formatRatio(4.499), '4.49:1'); assert.equal(L.formatRatio(4.5), '4.50:1'); assert.equal(L.formatRatio(2.9999), '2.99:1'); });
test('wcagChecks thresholds', () => {
  const g = r => Object.fromEntries(L.wcagChecks(r).map(x => [x.id, x.pass]));
  assert.deepEqual(g(3), { 'aa-normal': false, 'aa-large': true, 'aaa-normal': false, 'aaa-large': false, ui: true });
  assert.deepEqual(g(4.5), { 'aa-normal': true, 'aa-large': true, 'aaa-normal': false, 'aaa-large': true, ui: true });
  assert.deepEqual(g(7), { 'aa-normal': true, 'aa-large': true, 'aaa-normal': true, 'aaa-large': true, ui: true });
  assert.equal(g(2.99)['aa-large'], false);
});
test('translucent foreground is composited', () => { const r = L.contrastRatio(P('rgb(0 0 0 / 0.5)'), P('#fff')); assert.ok(r > 3 && r < 6); near(r, L.contrastRatio(P('#808080'), P('#fff')), 0.05); });
test('luminance of white/black', () => { near(L.relativeLuminance(P('#fff')), 1, 1e-9); near(L.relativeLuminance(P('#000')), 0, 1e-9); near(L.relativeLuminance(P('#f00')), 0.2126, 1e-9); });
test('APCA black on white ~ Lc 106, white on black negative', () => { near(L.apcaLc(P('#000'), P('#fff')), 106.04, 0.05); assert.ok(L.apcaLc(P('#fff'), P('#000')) < -100); assert.equal(L.apcaLc(P('#888'), P('#888')), 0); });
test('suggestForeground reaches target', () => {
  const s = L.suggestForeground(P('#999'), P('#fff'), 4.5);
  assert.ok(s.ratio >= 4.5); assert.ok(!s.unchanged);
  const s7 = L.suggestForeground(P('#999'), P('#fff'), 7); assert.ok(s7.ratio >= 7);
});
test('suggestForeground unchanged when already passing', () => assert.equal(L.suggestForeground(P('#000'), P('#fff'), 4.5).unchanged, true));
test('suggestForeground on mid-grey background can go either way', () => { const s = L.suggestForeground(P('#777'), P('#777'), 3); assert.ok(s && s.ratio >= 3); });
test('suggestForeground impossible target returns null', () => assert.equal(L.suggestForeground(P('#777'), P('#777'), 30), null));

// ---------- colour blindness ----------
test('CVD matrices rows sum to 1 (white/gray preserved)', () => {
  for (const [k, d] of Object.entries(L.CVD)) for (const row of d.m) near(row.reduce((a, b) => a + b, 0), 1, 0.001, k);
  for (const t of Object.keys(L.CVD)) { assert.deepEqual(rgb255(L.simulateCvd(P('#fff'), t)), [255, 255, 255], t); const g = rgb255(L.simulateCvd(P('#808080'), t)); g.forEach(v => near(v, 128, 2, t)); }
});
test('protanopia/deuteranopia shift red and green close together', () => {
  const r = rgb255(L.simulateCvd(P('#f00'), 'deuteranopia')), g = rgb255(L.simulateCvd(P('#0f0'), 'deuteranopia'));
  assert.ok(Math.abs(r[0] - g[0]) < 200 && r[0] < 200);
  assert.ok(rgb255(L.simulateCvd(P('#f00'), 'protanopia'))[0] < 120);
});
test('tritanopia changes blue; achromatopsia is gray', () => {
  assert.notDeepEqual(rgb255(L.simulateCvd(P('#00f'), 'tritanopia')), [0, 0, 255]);
  const a = rgb255(L.simulateCvd(P('#3a58e8'), 'achromatopsia')); assert.ok(a[0] === a[1] && a[1] === a[2]);
});
test('simulateCvd keeps alpha and rejects unknown type', () => { near(L.simulateCvd(P('rgb(255 0 0 / 0.3)'), 'protanopia').a, 0.3, 1e-9); assert.throws(() => L.simulateCvd(P('#f00'), 'x')); });

// ---------- palettes ----------
const hexes = list => list.map(e => L.formatHex(e.color));
test('complementary of red is cyan', () => assert.deepEqual(hexes(L.harmony(P('#ff0000'), 'complementary')), ['#ff0000', '#00ffff']));
test('triadic of red', () => assert.deepEqual(hexes(L.harmony(P('#ff0000'), 'triadic')), ['#ff0000', '#00ff00', '#0000ff']));
test('tetradic has four, split has three, analogous three', () => { assert.equal(L.harmony(P('#f00'), 'tetradic').length, 4); assert.equal(L.harmony(P('#f00'), 'split').length, 3); assert.equal(L.harmony(P('#f00'), 'analogous').length, 3); });
test('analogous of red', () => assert.deepEqual(hexes(L.harmony(P('#ff0000'), 'analogous')), ['#ff0080', '#ff0000', '#ff8000']));
test('harmony unknown scheme throws', () => assert.throws(() => L.harmony(P('#f00'), 'zzz')));
test('harmony of gray stays gray', () => assert.deepEqual(hexes(L.harmony(P('#808080'), 'triadic')), ['#808080', '#808080', '#808080']));
test('monochromatic spans light to dark, same hue', () => {
  const m = L.monochromatic(P('#3a58e8'), 5); assert.equal(m.length, 5);
  const ls = m.map(e => L.srgbToHsl(e.color).l); for (let i = 1; i < ls.length; i++) assert.ok(ls[i] < ls[i - 1]);
  near(ls[0], 0.9, 0.01); near(ls[4], 0.1, 0.01);
});
test('tints go lighter, shades darker', () => {
  const t = L.tints(P('#3a58e8'), 4), s = L.shades(P('#3a58e8'), 4);
  const lum = e => L.relativeLuminance(e.color);
  for (let i = 1; i < 4; i++) { assert.ok(lum(t[i]) > lum(t[i - 1])); assert.ok(lum(s[i]) < lum(s[i - 1])); }
  assert.ok(lum(t[0]) > L.relativeLuminance(P('#3a58e8'))); assert.notEqual(L.formatHex(t[3].color), '#ffffff');
});
test('counts are clamped', () => { assert.equal(L.tints(P('#f00'), 999).length, 20); assert.equal(L.monochromatic(P('#f00'), 1).length, 2); assert.equal(L.shades(P('#f00'), 0).length, 1); });
test('material scale 50..900 with base at 500', () => {
  const s = L.materialScale(P('#3a58e8')); assert.deepEqual(s.map(e => e.name), ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']);
  assert.equal(L.formatHex(s[5].color), '#3a58e8');
  const ls = s.map(e => L.srgbToHsl(e.color).l); for (let i = 1; i < ls.length; i++) assert.ok(ls[i] < ls[i - 1]);
});
test('material scale on white/black stays valid', () => { for (const c of ['#fff', '#000']) for (const e of L.materialScale(P(c))) assert.match(L.formatHex(e.color), /^#[0-9a-f]{6}$/); });
test('gradient endpoints and count (srgb)', () => {
  const g = L.gradient(P('#000'), P('#fff'), 5); assert.equal(g.length, 5);
  assert.deepEqual(hexes(g), ['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff']);
});
test('gradient oklab differs from srgb midpoint but has same ends', () => {
  const a = L.gradient(P('#ff0000'), P('#0000ff'), 3, 'srgb'), b = L.gradient(P('#ff0000'), P('#0000ff'), 3, 'oklab');
  assert.equal(L.formatHex(a[0].color), L.formatHex(b[0].color)); assert.equal(L.formatHex(a[2].color), L.formatHex(b[2].color));
  assert.notEqual(L.formatHex(a[1].color), L.formatHex(b[1].color));
});
test('gradient interpolates alpha and clamps steps', () => { const g = L.gradient(P('rgb(0 0 0 / 0)'), P('#000'), 3); near(g[1].color.a, 0.5, 1e-9); assert.equal(L.gradient(P('#000'), P('#fff'), 1).length, 2); assert.equal(L.gradient(P('#000'), P('#fff'), 500).length, 50); });

// ---------- export ----------
const pal = [{ name: '500', color: P('#3a58e8') }, { name: '600', color: P('#2f48cc') }];
test('export css', () => assert.equal(L.exportPalette(pal, 'css', { prefix: 'Brand' }), ':root {\n  --brand-500: #3a58e8;\n  --brand-600: #2f48cc;\n}'));
test('export scss', () => assert.equal(L.exportPalette(pal, 'scss', { prefix: 'brand' }), '$brand-500: #3a58e8;\n$brand-600: #2f48cc;'));
test('export json is valid JSON', () => assert.deepEqual(JSON.parse(L.exportPalette(pal, 'json', { prefix: 'brand' })), { brand: { 500: '#3a58e8', 600: '#2f48cc' } }));
test('export tailwind numeric scale is grouped', () => { const t = L.exportPalette(pal, 'tailwind', { prefix: 'brand' }); assert.ok(t.includes("'brand': {") && t.includes("500: '#3a58e8',")); });
test('export tailwind non-numeric names are flat', () => assert.ok(L.exportPalette([{ name: 'base', color: P('#f00') }], 'tailwind', { prefix: 'x' }).includes("'x-base': '#ff0000'")));
test('export uppercase and alpha hex', () => assert.ok(L.exportPalette([{ name: 'a', color: P('#ff000080') }], 'css', { hexCase: 'upper' }).includes('#FF000080')));
test('export de-duplicates names and slugs odd ones', () => { const o = L.exportPalette([{ name: 'A b!', color: P('#f00') }, { name: 'a-b', color: P('#0f0') }], 'css'); assert.ok(o.includes('--color-a-b:') && o.includes('--color-a-b-x:')); });
test('export unknown format throws; empty list ok', () => { assert.throws(() => L.exportPalette(pal, 'xml')); assert.equal(L.exportPalette([], 'scss'), ''); });
test('slug', () => { assert.equal(L.slug('  Hello World!! '), 'hello-world'); assert.equal(L.slug(''), 'color'); assert.equal(L.slug('日本'), 'color'); });

// ---------- batch ----------
test('parseMany mixed lines', () => {
  const r = L.parseMany('#ff0000\n\nrgb(0 255 0)\nnot a colour\r\nhsl(240 100% 50%)\n');
  assert.equal(r.rows.length, 4); assert.deepEqual(r.rows.map(x => x.ok), [true, true, false, true]);
  assert.equal(r.rows[1].hex, '#00ff00'); assert.equal(r.rows[3].hex, '#0000ff'); assert.ok(r.rows[2].error); assert.equal(r.rows[2].line, 3);
});
test('parseMany empty and truncation', () => {
  assert.equal(L.parseMany('').rows.length, 0); assert.equal(L.parseMany(null).rows.length, 0);
  const big = L.parseMany(Array(1500).fill('#fff').join('\n')); assert.equal(big.rows.length, 1000); assert.equal(big.truncated, true); assert.equal(big.total, 1500);
});
test('parseMany honours format options', () => assert.equal(L.parseMany('#ff0000', { hexCase: 'upper', syntax: 'legacy' }).rows[0].rgb, 'rgb(255, 0, 0)'));
test('batchToCsv quotes properly', () => {
  const csv = L.batchToCsv(L.parseMany('#f00\nrgb(1, 2, 3)\nbad,"x').rows);
  const lines = csv.split('\n'); assert.equal(lines[0], 'input,status,hex,rgb,hsl,oklch,error');
  assert.ok(lines[2].startsWith('"rgb(1, 2, 3)",ok')); assert.ok(csv.includes('"bad,""x"'));
});

console.log(`color-converter: ${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
