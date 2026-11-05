// Pure HTML entity encode / decode (no DOM, no dependencies). Follows the WHATWG "character reference" rules:
//  - named references with ";" always decode; the legacy set also decodes without ";" (&amp &lt &copy ...), longest prefix wins
//  - in ATTRIBUTE context a legacy name without ";" followed by "=" or an alphanumeric is left alone
//  - numeric references (decimal / hex, ";" optional) outside Unicode, surrogates and 0 become U+FFFD,
//    0x80-0x9F are remapped through windows-1252 (&#128; -> euro sign)

// ---------------------------------------------------------------- entity table
const LATIN1_LOW = ('nbsp|No-break space;iexcl|Inverted exclamation mark;cent|Cent sign;pound|Pound sign;curren|Currency sign;yen|Yen sign;brvbar|Broken bar;' +
  'sect|Section sign;uml|Diaeresis;copy|Copyright sign;ordf|Feminine ordinal indicator;laquo|Left double angle quote;not|Not sign;shy|Soft hyphen;' +
  'reg|Registered sign;macr|Macron;deg|Degree sign;plusmn|Plus-minus sign;sup2|Superscript two;sup3|Superscript three;acute|Acute accent;' +
  'micro|Micro sign;para|Pilcrow (paragraph sign);middot|Middle dot;cedil|Cedilla;sup1|Superscript one;ordm|Masculine ordinal indicator;' +
  'raquo|Right double angle quote;frac14|One quarter;frac12|One half;frac34|Three quarters;iquest|Inverted question mark').split(';').map(s => s.split('|'));

const LATIN1_HIGH = ('Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc ' +
  'Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml ' +
  'igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');

const ACCENTS = { grave: 'grave accent', acute: 'acute accent', circ: 'circumflex', tilde: 'tilde', uml: 'diaeresis', ring: 'ring above', cedil: 'cedilla', slash: 'stroke' };
const SPECIAL_LATIN = { AElig: 'Latin capital letter AE', aelig: 'Latin small letter ae', ETH: 'Latin capital letter eth', eth: 'Latin small letter eth',
  THORN: 'Latin capital letter thorn', thorn: 'Latin small letter thorn', szlig: 'Latin small letter sharp s (German eszett)', times: 'Multiplication sign',
  divide: 'Division sign', yuml: 'Latin small letter y with diaeresis' };
function latinDesc(name) {
  if (SPECIAL_LATIN[name]) return SPECIAL_LATIN[name];
  const m = /^([A-Za-z])(grave|acute|circ|tilde|uml|ring|cedil|slash)$/.exec(name);
  if (!m) return name;
  return `Latin ${m[1] === m[1].toUpperCase() ? 'capital' : 'small'} letter ${m[1]} with ${ACCENTS[m[2]]}`;
}

const GREEK = [
  ['Alpha', 913], ['Beta', 914], ['Gamma', 915], ['Delta', 916], ['Epsilon', 917], ['Zeta', 918], ['Eta', 919], ['Theta', 920], ['Iota', 921], ['Kappa', 922],
  ['Lambda', 923], ['Mu', 924], ['Nu', 925], ['Xi', 926], ['Omicron', 927], ['Pi', 928], ['Rho', 929], ['Sigma', 931], ['Tau', 932], ['Upsilon', 933],
  ['Phi', 934], ['Chi', 935], ['Psi', 936], ['Omega', 937],
  ['alpha', 945], ['beta', 946], ['gamma', 947], ['delta', 948], ['epsilon', 949], ['zeta', 950], ['eta', 951], ['theta', 952], ['iota', 953], ['kappa', 954],
  ['lambda', 955], ['mu', 956], ['nu', 957], ['xi', 958], ['omicron', 959], ['pi', 960], ['rho', 961], ['sigmaf', 962], ['sigma', 963], ['tau', 964],
  ['upsilon', 965], ['phi', 966], ['chi', 967], ['psi', 968], ['omega', 969],
];

// name codepoint description  (one per line; description may contain spaces)
const OTHER = `quot 34 Quotation mark
amp 38 Ampersand
apos 39 Apostrophe (HTML5 / XML; not in HTML 4)
lt 60 Less-than sign
gt 62 Greater-than sign
OElig 338 Latin capital ligature OE
oelig 339 Latin small ligature oe
Scaron 352 Latin capital letter S with caron
scaron 353 Latin small letter s with caron
Yuml 376 Latin capital letter Y with diaeresis
fnof 402 Latin small letter f with hook (function, florin)
circ 710 Modifier letter circumflex accent
tilde 732 Small tilde
thetasym 977 Greek theta symbol
upsih 978 Greek upsilon with hook symbol
piv 982 Greek pi symbol
ensp 8194 En space
emsp 8195 Em space
thinsp 8201 Thin space
zwnj 8204 Zero width non-joiner
zwj 8205 Zero width joiner
lrm 8206 Left-to-right mark
rlm 8207 Right-to-left mark
ndash 8211 En dash
mdash 8212 Em dash
lsquo 8216 Left single quotation mark
rsquo 8217 Right single quotation mark
sbquo 8218 Single low-9 quotation mark
ldquo 8220 Left double quotation mark
rdquo 8221 Right double quotation mark
bdquo 8222 Double low-9 quotation mark
dagger 8224 Dagger
Dagger 8225 Double dagger
bull 8226 Bullet
hellip 8230 Horizontal ellipsis
permil 8240 Per mille sign
prime 8242 Prime (minutes, feet)
Prime 8243 Double prime (seconds, inches)
lsaquo 8249 Single left-pointing angle quotation mark
rsaquo 8250 Single right-pointing angle quotation mark
oline 8254 Overline
frasl 8260 Fraction slash
euro 8364 Euro sign
image 8465 Black-letter capital I (imaginary part)
weierp 8472 Script capital P (power set)
real 8476 Black-letter capital R (real part)
trade 8482 Trade mark sign
alefsym 8501 Alef symbol
larr 8592 Leftwards arrow
uarr 8593 Upwards arrow
rarr 8594 Rightwards arrow
darr 8595 Downwards arrow
harr 8596 Left right arrow
crarr 8629 Downwards arrow with corner leftwards (carriage return)
lArr 8656 Leftwards double arrow
uArr 8657 Upwards double arrow
rArr 8658 Rightwards double arrow (implies)
dArr 8659 Downwards double arrow
hArr 8660 Left right double arrow (if and only if)
forall 8704 For all
part 8706 Partial differential
exist 8707 There exists
empty 8709 Empty set
nabla 8711 Nabla (backward difference)
isin 8712 Element of
notin 8713 Not an element of
ni 8715 Contains as member
prod 8719 N-ary product
sum 8721 N-ary summation
minus 8722 Minus sign
lowast 8727 Asterisk operator
radic 8730 Square root
prop 8733 Proportional to
infin 8734 Infinity
ang 8736 Angle
and 8743 Logical and
or 8744 Logical or
cap 8745 Intersection
cup 8746 Union
int 8747 Integral
there4 8756 Therefore
sim 8764 Tilde operator
cong 8773 Approximately equal to
asymp 8776 Almost equal to
ne 8800 Not equal to
equiv 8801 Identical to
le 8804 Less-than or equal to
ge 8805 Greater-than or equal to
sub 8834 Subset of
sup 8835 Superset of
nsub 8836 Not a subset of
sube 8838 Subset of or equal to
supe 8839 Superset of or equal to
oplus 8853 Circled plus
otimes 8855 Circled times
perp 8869 Up tack (perpendicular)
sdot 8901 Dot operator
lceil 8968 Left ceiling
rceil 8969 Right ceiling
lfloor 8970 Left floor
rfloor 8971 Right floor
lang 10216 Mathematical left angle bracket
rang 10217 Mathematical right angle bracket
loz 9674 Lozenge
spades 9824 Black spade suit
clubs 9827 Black club suit
hearts 9829 Black heart suit
diams 9830 Black diamond suit
hyphen 8208 Hyphen
dash 8208 Hyphen (alias)
check 10003 Check mark
cross 10007 Ballot X
star 9734 White star
starf 9733 Black star
phone 9742 Black telephone
female 9792 Female sign
male 9794 Male sign
sung 9834 Eighth note
flat 9837 Music flat sign
natural 9838 Music natural sign
sharp 9839 Music sharp sign
numsp 8199 Figure space
puncsp 8200 Punctuation space
hairsp 8202 Hair space
excl 33 Exclamation mark
num 35 Number sign
dollar 36 Dollar sign
percnt 37 Percent sign
lpar 40 Left parenthesis
rpar 41 Right parenthesis
ast 42 Asterisk
plus 43 Plus sign
comma 44 Comma
period 46 Full stop
sol 47 Solidus (slash)
colon 58 Colon
semi 59 Semicolon
equals 61 Equals sign
quest 63 Question mark
commat 64 Commercial at
lsqb 91 Left square bracket
bsol 92 Reverse solidus (backslash)
rsqb 93 Right square bracket
Hat 94 Circumflex accent (caret)
lowbar 95 Low line (underscore)
grave 96 Grave accent
lcub 123 Left curly bracket
verbar 124 Vertical line
rcub 125 Right curly bracket
Tab 9 Character tabulation
NewLine 10 Line feed
hbar 8463 Planck constant over two pi
ell 8467 Script small l
ohm 937 Ohm sign (alias of Omega)
half 189 One half (alias of frac12)
centerdot 183 Middle dot (alias of middot)
bigstar 9733 Black star (alias of starf)
checkmark 10003 Check mark (alias of check)
copysr 8471 Sound recording copyright
incare 8453 Care of
NotEqual 8800 Not equal to (alias of ne)
AMP 38 Ampersand (uppercase alias)
LT 60 Less-than sign (uppercase alias)
GT 62 Greater-than sign (uppercase alias)
QUOT 34 Quotation mark (uppercase alias)
COPY 169 Copyright sign (uppercase alias)
REG 174 Registered sign (uppercase alias)`;

/** Names that are aliases of another entity (never chosen when encoding). */
const ALIASES = new Set(['dash', 'ohm', 'half', 'centerdot', 'bigstar', 'checkmark', 'NotEqual', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG', 'Tab', 'NewLine', 'sung']);
/** Names the HTML parser also accepts WITHOUT a trailing semicolon. */
export const LEGACY_NAMES = new Set([...LATIN1_LOW.map(r => r[0]), ...LATIN1_HIGH, 'amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);
const LEGACY_MAX = Math.max(...[...LEGACY_NAMES].map(n => n.length));

export function categoryOf(cp) {
  if (cp < 128) return cp < 32 || cp === 127 ? 'Whitespace & control' : 'ASCII & punctuation';
  if (cp < 256) return 'Latin-1';
  if ((cp >= 8192 && cp <= 8207) || cp === 8199) return 'Spaces & marks';
  if (cp >= 880 && cp <= 1023) return 'Greek';
  if (cp < 880 || (cp >= 7680 && cp <= 7935)) return 'Latin extended & modifiers';
  if (cp >= 8208 && cp <= 8303) return 'Punctuation';
  if (cp >= 8352 && cp <= 8399) return 'Currency';
  if (cp >= 8592 && cp <= 8703 || cp === 8629) return 'Arrows';
  if (cp >= 8704 && cp <= 8959) return 'Math';
  if (cp >= 8960 && cp <= 9215 || (cp >= 10216 && cp <= 10217)) return 'Math';
  if (cp >= 9632 && cp <= 10175) return 'Symbols';
  return 'Symbols';
}
export const CATEGORIES = ['Latin-1', 'Greek', 'Math', 'Arrows', 'Punctuation', 'Currency', 'Spaces & marks', 'Symbols', 'ASCII & punctuation', 'Whitespace & control', 'Latin extended & modifiers'];

/** [{ name, cp, char, desc, legacy, alias, category }] sorted by code point then name. */
export const ENTITIES = (() => {
  const list = [], seen = new Set();
  const add = (name, cp, desc) => {
    if (seen.has(name)) return;
    seen.add(name);
    list.push({ name, cp, char: String.fromCodePoint(cp), desc, legacy: LEGACY_NAMES.has(name), alias: ALIASES.has(name), category: categoryOf(cp) });
  };
  LATIN1_LOW.forEach(([n, d], i) => add(n, 160 + i, d));
  LATIN1_HIGH.forEach((n, i) => add(n, 192 + i, latinDesc(n)));
  GREEK.forEach(([n, cp]) => add(n, cp, `Greek ${n === 'sigmaf' ? 'small letter final sigma' : `${n[0] === n[0].toUpperCase() ? 'capital' : 'small'} letter ${n.toLowerCase()}`}`));
  for (const line of OTHER.split('\n')) {
    const m = /^(\S+) (\d+) (.+)$/.exec(line);
    add(m[1], +m[2], m[3]);
  }
  return list.sort((a, b) => a.cp - b.cp || (a.alias - b.alias) || a.name.localeCompare(b.name));
})();

/** name -> character. */
export const NAMED = (() => { const m = new Map(); for (const e of ENTITIES) m.set(e.name, e.char); return m; })();
// character -> preferred name (first non-alias wins; plain ASCII only for the special characters)
const NAME_OF = (() => {
  const m = new Map();
  for (const e of ENTITIES) {
    if (e.alias || m.has(e.char)) continue;
    if (e.cp < 128 && !'&<>"'.includes(e.char)) continue;
    m.set(e.char, e.name);
  }
  m.set('‐', 'hyphen');
  return m;
})();
export const nameOfChar = ch => NAME_OF.get(ch) || null;

// ---------------------------------------------------------------- numeric references
const C1 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];

/** Resolve a numeric reference to {cp, invalid, remapped}. */
export function resolveNumeric(cp) {
  if (!(cp > 0) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return { cp: 0xFFFD, invalid: true, remapped: false };
  if (cp >= 0x80 && cp <= 0x9F) { const r = C1[cp - 0x80]; return { cp: r, invalid: false, remapped: r !== cp }; }
  return { cp, invalid: false, remapped: false };
}

// ---------------------------------------------------------------- decode
const REF = /&(?:#([xX])([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g;
const ALNUM = /[A-Za-z0-9]/;

/**
 * Decode character references. Returns { text, stats } where stats counts what happened:
 * { named, decimal, hex, invalid, remapped, legacy (named without ';'), unknown (&name; not in the table), ambiguous (left alone in attribute context) }.
 * options.context: 'text' (default) | 'attribute'.
 */
export function decodeDetailed(input, { context = 'text' } = {}) {
  const s = String(input ?? '');
  const stats = { named: 0, decimal: 0, hex: 0, invalid: 0, remapped: 0, legacy: 0, unknown: 0, ambiguous: 0 };
  if (!s.includes('&')) return { text: s, stats };
  const attr = context === 'attribute';
  REF.lastIndex = 0;
  const text = s.replace(REF, (m, x, hexDigits, decDigits, name, semi, offset) => {
    if (name === undefined) {
      const hex = x !== undefined, digits = hex ? hexDigits : decDigits;
      const trimmed = digits.replace(/^0+/, '');
      const cp = trimmed.length > 8 ? 0x110000 : (trimmed === '' ? 0 : parseInt(trimmed, hex ? 16 : 10));
      const r = resolveNumeric(cp);
      stats[hex ? 'hex' : 'decimal']++;
      if (r.invalid) stats.invalid++;
      if (r.remapped) stats.remapped++;
      return String.fromCodePoint(r.cp);
    }
    if (semi && NAMED.has(name)) { stats.named++; return NAMED.get(name); }
    // longest legacy prefix, e.g. "&notit;" -> "not" + "it;"
    for (let len = Math.min(name.length, LEGACY_MAX); len >= 2; len--) {
      const p = name.slice(0, len);
      if (!LEGACY_NAMES.has(p)) continue;
      const rest = name.slice(len);
      if (attr) {
        const next = rest !== '' ? rest[0] : (semi ? ';' : s[offset + m.length] || '');
        if (rest !== '' || (!semi && (next === '=' || ALNUM.test(next)))) { stats.ambiguous++; return m; }
      }
      stats.named++; stats.legacy++;
      return NAMED.get(p) + rest + semi;
    }
    if (semi) stats.unknown++;
    return m;
  });
  return { text, stats };
}
export const decode = (input, options) => decodeDetailed(input, options).text;

/** True if text still contains something decode() would change. */
export const hasEntities = (text, options) => { const r = decodeDetailed(text, options); return r.text !== String(text ?? ''); };

/** Heuristics for "this was probably encoded twice" (&amp;lt; &amp;#39; ...). */
export function detectDoubleEncoded(text) {
  const s = String(text ?? '');
  const double = (s.match(/&amp;(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g) || []).length;
  const once = decode(s);
  const nested = once !== s && hasEntities(once);
  return { count: double, doubleEncoded: double > 0, decodesAgain: nested };
}

/** Decode repeatedly until stable (max `passes`). Returns { text, passes }. */
export function decodeRepeatedly(input, { context = 'text', passes = 5 } = {}) {
  let cur = String(input ?? ''), n = 0;
  while (n < passes) { const next = decode(cur, { context }); if (next === cur) break; cur = next; n++; }
  return { text: cur, passes: n };
}

// ---------------------------------------------------------------- encode
const SAFE_SETS = {
  default: new Set(['&', '<', '>', '"', "'"]),
  text: new Set(['&', '<', '>']),
  attribute: new Set(['&', '<', '>', '"', "'", '`']),
};
const EXISTING = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|([A-Za-z][A-Za-z0-9]*));/y;

/**
 * Encode text.
 *   scope:        'special' (only the characters of the safe set), 'nonascii' (special + every non-ASCII char), 'all' (everything)
 *   safe:         'default' (& < > " ') | 'text' (& < >) | 'attribute' (& < > " ' `)
 *   preferNamed:  use &name; when the character has one (&#39; is used for the apostrophe: &apos; is not HTML 4)
 *   numeric:      'decimal' | 'hex'  (form of numeric references)
 *   hexCase:      'upper' | 'lower'
 *   keepExisting: leave already-valid references alone instead of re-encoding their "&" (makes encoding idempotent)
 * Code points are processed whole (an emoji is ONE reference). Lone surrogates become U+FFFD. The C1 controls U+0080-U+009F are
 * kept literally because a numeric reference to them would decode to a windows-1252 character. NUL is kept literally too.
 * Returns { text, stats } via encodeDetailed; encode() returns only the text.
 */
export function encodeDetailed(input, options = {}) {
  const o = { scope: 'nonascii', safe: 'default', preferNamed: true, numeric: 'decimal', hexCase: 'upper', keepExisting: false, ...options };
  const s = String(input ?? '');
  const safe = SAFE_SETS[o.safe] || SAFE_SETS.default;
  const stats = { named: 0, decimal: 0, hex: 0, literal: 0, kept: 0, loneSurrogates: 0, astral: 0, c1Kept: 0 };
  const numRef = cp => {
    if (o.numeric === 'hex') { stats.hex++; const h = cp.toString(16); return `&#x${o.hexCase === 'lower' ? h : h.toUpperCase()};`; }
    stats.decimal++; return `&#${cp};`;
  };
  let out = '';
  for (let i = 0; i < s.length;) {
    let cp = s.codePointAt(i);
    const len = cp > 0xFFFF ? 2 : 1;
    const ch = s.slice(i, i + len);
    if (cp >= 0xD800 && cp <= 0xDFFF) { stats.loneSurrogates++; cp = 0xFFFD; i += 1; out += o.scope === 'special' ? '�' : numRef(0xFFFD); continue; }
    if (cp === 0x26 && o.keepExisting) {
      EXISTING.lastIndex = i;
      const m = EXISTING.exec(s);
      if (m && (m[1] === undefined || NAMED.has(m[1]))) { out += m[0]; i += m[0].length; stats.kept++; continue; }
    }
    i += len;
    if (cp > 0xFFFF) stats.astral++;
    let encode;
    if (safe.has(ch)) encode = true;
    else if (o.scope === 'all') encode = true;
    else if (o.scope === 'nonascii') encode = cp > 127;
    else encode = false;
    if (!encode) { out += ch; stats.literal++; continue; }
    if (cp === 0 || (cp >= 0x80 && cp <= 0x9F && C1[cp - 0x80] !== cp)) { out += ch; stats.c1Kept++; continue; }
    const named = o.preferNamed ? nameOfChar(ch) : null;
    if (named) { out += `&${named};`; stats.named++; continue; }
    out += cp === 39 && o.preferNamed ? (stats.decimal++, '&#39;') : numRef(cp);
  }
  return { text: out, stats };
}
export const encode = (input, options) => encodeDetailed(input, options).text;

// ---------------------------------------------------------------- helpers for the UI
/** Reference text for an entity in the given style: 'name' | 'decimal' | 'hex'. */
export function entityText(entity, style = 'name') {
  if (style === 'decimal') return `&#${entity.cp};`;
  if (style === 'hex') return `&#x${entity.cp.toString(16).toUpperCase()};`;
  return `&${entity.name};`;
}
export const codePointLabel = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

/** Filter the table. query matches the name, the character, "169" / "U+00A9" / "#x A9" or the description. */
export function searchEntities(query, category = '') {
  const q = String(query ?? '').trim();
  let list = ENTITIES;
  if (category) list = list.filter(e => e.category === category);
  if (!q) return list;
  const low = q.toLowerCase().replace(/^&|;$/g, '');
  let cp = null;
  let m;
  if ((m = /^(?:u\+|0x|#x|x)([0-9a-f]+)$/i.exec(low))) cp = parseInt(m[1], 16);
  else if ((m = /^#?(\d+)$/.exec(low))) cp = parseInt(m[1], 10);
  const chars = [...q];
  return list.filter(e => e.name.toLowerCase().includes(low) || e.desc.toLowerCase().includes(low) || (cp !== null && e.cp === cp) ||
    (chars.length === 1 && e.char === chars[0]));
}

const INVISIBLE = { ' ': '␣', '​': '·', '‌': '·', '‍': '·', ' ': '·', ' ': '·', ' ': '·',
  '­': '·', '‎': '←', '‏': '→', '\t': '→\t' };
/** Make invisible characters visible for a plain-text preview (the text itself is still shown with textContent). */
export function visualizeInvisible(text) {
  return String(text ?? '').replace(/[ ​-‏   ­\t]/g, c => INVISIBLE[c] ?? c)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, c => String.fromCharCode(0x2400 + (c.charCodeAt(0) === 127 ? 0x21 : c.charCodeAt(0))));
}

export function textStats(text) {
  const s = String(text ?? '');
  let codePoints = 0, astral = 0, nonAscii = 0;
  for (const ch of s) { codePoints++; const cp = ch.codePointAt(0); if (cp > 0xFFFF) astral++; if (cp > 127) nonAscii++; }
  return { chars: s.length, codePoints, astral, nonAscii, bytes: new TextEncoder().encode(s).length };
}
