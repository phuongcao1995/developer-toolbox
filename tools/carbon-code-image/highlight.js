// Small dependency-free syntax highlighter (pure, no DOM).
// highlight(code, lang) -> array of lines, each an array of {text, cls}. Both the live preview and the PNG renderer
// consume this same structure, which is what keeps the exported image identical to the preview.
//
// Token classes: kw str com num fn type lit attr tag var prop op plain

const set = s => new Set(s.split(/\s+/).filter(Boolean));

// ----- shared rules -----
const WS = { re: /\s+/y, cls: 'plain' };
const NUM = { re: /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[uUiIfF]\d{1,3}|[fFdDlLnuUsz]{1,2})?)/y, cls: 'num' };
const PUNCT = { re: /[{}()[\];,.]/y, cls: 'op' };
const OPS = { re: /[=+\-*/%<>!&|^~?:@\\]+/y, cls: 'op' };
const dq = { re: /"(?:\\[\s\S]|[^"\\\n])*(?:"|(?=\n)|$)/y, cls: 'str' };
const sq = { re: /'(?:\\[\s\S]|[^'\\\n])*(?:'|(?=\n)|$)/y, cls: 'str' };
const tpl = { re: /`(?:\\[\s\S]|[^`\\])*(?:`|$)/y, cls: 'str' };
const cLineComment = { re: /\/\/[^\n]*/y, cls: 'com' };
const cBlockComment = { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'com' };
const hashComment = { re: /#[^\n]*/y, cls: 'com' };

/** Identifier rule: classify a word as keyword / literal / type / function call / plain. */
function ident({ keywords = '', literals = '', types = '', ci = false, capType = true, start = /[A-Za-z_$\u00a1-\uffff][\w$\u00a1-\uffff]*/y }) {
  const K = set(keywords), Lt = set(literals), T = set(types);
  return {
    re: start,
    cls: (w, code, end) => {
      const key = ci ? w.toLowerCase() : w;
      if (K.has(key)) return 'kw';
      if (Lt.has(key)) return 'lit';
      if (T.has(key)) return 'type';
      if (/^[ \t]*\(/.test(code.slice(end, end + 40))) return 'fn';
      if (capType && /^[A-Z][\w$]*$/.test(w) && /[a-z]/.test(w)) return 'type';
      return 'plain';
    },
  };
}

const JS_KW = `break case catch class const continue debugger default delete do else export extends finally for function if import in
instanceof let new of return super switch this throw try typeof var void while with yield async await static get set from as type
interface enum implements namespace declare readonly public private protected abstract keyof is module require`;
const JS_LIT = 'true false null undefined NaN Infinity';
const TS_TYPES = 'string number boolean any void never unknown object symbol bigint';

const LANGS = {
  plain: { label: 'Plain text', ext: 'txt', rules: [] },
  javascript: { label: 'JavaScript', ext: 'js', rules: [cLineComment, cBlockComment, dq, sq, tpl, WS, ident({ keywords: JS_KW, literals: JS_LIT }), NUM, PUNCT, OPS] },
  typescript: { label: 'TypeScript', ext: 'ts', rules: [cLineComment, cBlockComment, dq, sq, tpl, WS, ident({ keywords: JS_KW, literals: JS_LIT, types: TS_TYPES }), NUM, PUNCT, OPS] },
  python: {
    label: 'Python', ext: 'py',
    rules: [hashComment,
      { re: /[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\\n])*(?:"|(?=\n)|$)|'(?:\\[\s\S]|[^'\\\n])*(?:'|(?=\n)|$))/y, cls: 'str' },
      WS, { re: /@[A-Za-z_][\w.]*/y, cls: 'attr' },
      ident({ keywords: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
        literals: 'True False None self cls', types: 'int str float bool list dict set tuple bytes object' }), NUM, PUNCT, OPS],
  },
  html: {
    label: 'HTML', ext: 'html',
    rules: [{ re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'com' }, { re: /<!DOCTYPE[^>]*>/iy, cls: 'kw' }, { re: /<\/?[A-Za-z][\w:-]*/y, cls: 'tag' }, { re: /\/?>/y, cls: 'tag' },
      dq, sq, WS, { re: /[A-Za-z_:@#][\w:.-]*(?=\s*=)/y, cls: 'attr' }, { re: /&[#\w]+;/y, cls: 'lit' }, { re: /=/y, cls: 'op' }, { re: /[^\s<>"'=&]+/y, cls: 'plain' }],
  },
  css: {
    label: 'CSS', ext: 'css',
    rules: [cBlockComment, dq, sq, WS, { re: /@[\w-]+/y, cls: 'kw' }, { re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'num' },
      { re: /-?(?:\d*\.\d+|\d+)(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|s|ms|deg|fr|pt|cm|mm|in)?/y, cls: 'num' },
      { re: /[.#][A-Za-z_][\w-]*/y, cls: 'type' },
      { re: /--[\w-]+/y, cls: 'var' },
      // property name: a word followed by ":" that ends in ";" or "}" before any "{" (so selectors like a:hover don't match)
      { re: /[A-Za-z-][\w-]*(?=\s*:\s*[^;{}]*[;}])/y, cls: 'attr' },
      { re: /::?[A-Za-z-]+/y, cls: (m, c, e, prev) => (prev === 'attr' ? null : 'kw') },
      { re: /[A-Za-z_-][\w-]*(?=\()/y, cls: 'fn' }, { re: /!important/y, cls: 'kw' }, { re: /[A-Za-z_-][\w-]*/y, cls: 'plain' }, PUNCT, OPS],
  },
  json: {
    label: 'JSON', ext: 'json',
    rules: [{ re: /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y, cls: 'prop' }, dq, WS, { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, cls: 'num' },
      { re: /\b(?:true|false|null)\b/y, cls: 'lit' }, PUNCT, OPS],
  },
  sql: {
    label: 'SQL', ext: 'sql',
    rules: [{ re: /--[^\n]*/y, cls: 'com' }, cBlockComment, sq, { re: /"(?:[^"]|"")*"|`[^`]*`/y, cls: 'prop' }, WS,
      ident({ ci: true, capType: false, literals: 'true false null',
        keywords: `select from where and or not in is as on join inner left right full outer cross natural group by order having limit offset union all distinct
insert into values update set delete create table alter drop index view primary key foreign references default unique check constraint
case when then else end exists between like ilike asc desc with recursive over partition returning begin commit rollback if cascade add column`,
        types: 'int integer bigint smallint serial boolean bool decimal numeric float real double varchar char text date time timestamp timestamptz json jsonb uuid blob' }), NUM, PUNCT, OPS],
  },
  bash: {
    label: 'Bash', ext: 'sh',
    rules: [hashComment, dq, sq, WS, { re: /\$(?:\{[^}\n]*\}|\(\(?|[A-Za-z_]\w*|[0-9@#?$!*-])/y, cls: 'var' },
      { re: /--?[A-Za-z][\w-]*/y, cls: 'attr' },
      ident({ capType: false, start: /[A-Za-z_][\w.-]*/y,
        keywords: 'if then else elif fi for while until do done case esac in function select return exit break continue local export readonly declare unset source alias time',
        types: `echo cd ls cat grep sed awk curl wget git npm npx node python python3 pip docker make mkdir rm cp mv chmod chown sudo apt apt-get brew tar ssh scp kill ps find xargs
head tail sort uniq wc touch printf read test tee yarn pnpm cargo go java mvn gradle kubectl` }), NUM, PUNCT, OPS],
  },
  java: {
    label: 'Java', ext: 'java',
    rules: [cLineComment, cBlockComment, { re: /"""[\s\S]*?(?:"""|$)/y, cls: 'str' }, dq, sq, WS, { re: /@[A-Za-z_]\w*/y, cls: 'attr' },
      ident({ literals: 'true false null this super', types: 'int long short byte char float double boolean void var String Object',
        keywords: `abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface
native new package private protected public return static strictfp switch synchronized throw throws transient try volatile while record sealed permits yield` }), NUM, PUNCT, OPS],
  },
  csharp: {
    label: 'C#', ext: 'cs',
    rules: [cLineComment, cBlockComment, { re: /[$@]{1,2}"(?:""|\\[\s\S]|[^"\\])*(?:"|$)/y, cls: 'str' }, dq, sq, WS, { re: /#[a-z]+[^\n]*/y, cls: 'attr' },
      ident({ literals: 'true false null this base', types: 'int long short byte char float double decimal bool void var string object dynamic uint ulong sbyte ushort',
        keywords: `abstract as async await break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if
implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct
switch throw try typeof unchecked unsafe using virtual volatile while get set init record yield where select from let` }), NUM, PUNCT, OPS],
  },
  go: {
    label: 'Go', ext: 'go',
    rules: [cLineComment, cBlockComment, { re: /`[^`]*(?:`|$)/y, cls: 'str' }, dq, sq, WS,
      ident({ literals: 'true false nil iota', types: 'int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 string bool byte rune error any complex64 complex128',
        keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var' }), NUM, PUNCT, OPS],
  },
  rust: {
    label: 'Rust', ext: 'rs',
    rules: [cLineComment, cBlockComment, { re: /r#*"[\s\S]*?(?:"#*|$)/y, cls: 'str' }, dq, { re: /b?'(?:\\.[^']*|[^'\\\n])'/y, cls: 'str' },
      { re: /'[A-Za-z_]\w*/y, cls: 'var' }, WS, { re: /#!?\[[^\]\n]*\]/y, cls: 'attr' }, { re: /[A-Za-z_]\w*!/y, cls: 'fn' },
      ident({ literals: 'true false None Some Ok Err self Self', types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box',
        keywords: `as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type
unsafe use where while union` }), NUM, PUNCT, OPS],
  },
  php: {
    label: 'PHP', ext: 'php',
    rules: [cLineComment, cBlockComment, hashComment, dq, sq, WS, { re: /<\?php|<\?=|\?>/y, cls: 'kw' }, { re: /\$[A-Za-z_]\w*/y, cls: 'var' },
      ident({ literals: 'true false null TRUE FALSE NULL', types: 'int float string bool array object mixed void callable iterable self parent static',
        keywords: `abstract and as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile
extends final finally fn for foreach function global if implements include include_once instanceof insteadof interface isset list namespace new or print private protected
public require require_once return static switch throw trait try unset use var while xor yield match readonly enum` }), NUM, PUNCT, OPS],
  },
};

export const LANGUAGES = Object.fromEntries(Object.entries(LANGS).map(([id, l]) => [id, { label: l.label, ext: l.ext }]));

const EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', html: 'html', htm: 'html',
  css: 'css', scss: 'css', json: 'json', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', java: 'java', cs: 'csharp', go: 'go', rs: 'rust', php: 'php', txt: 'plain' };
export const detectLanguageByName = (name = '') => EXT[String(name).toLowerCase().split('.').pop()] || null;

// Sticky copies of each rule are built once per language.
const compiled = new Map();
function rulesFor(lang) {
  if (!compiled.has(lang)) compiled.set(lang, (LANGS[lang] || LANGS.plain).rules.map(r => ({ cls: r.cls, re: new RegExp(r.re.source, r.re.flags.includes('y') ? r.re.flags : r.re.flags + 'y') })));
  return compiled.get(lang);
}

/** Replace tabs with spaces (aligned to tab stops) and normalise line endings so every glyph is one monospace cell. */
export function normalizeCode(code, tabSize = 4) {
  return String(code ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    let out = '';
    for (const ch of line) out += ch === '\t' ? ' '.repeat(tabSize - (out.length % tabSize)) : ch;
    return out;
  }).join('\n');
}

/** Tokenize into a flat list of {text, cls}; adjacent tokens of the same class are merged. */
export function tokenize(code, lang) {
  const rules = rulesFor(lang), toks = [];
  const push = (text, cls) => { const last = toks[toks.length - 1]; if (last && last.cls === cls) last.text += text; else toks.push({ text, cls }); };
  let i = 0;
  while (i < code.length) {
    let hit = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (!m || !m[0].length) continue;
      const cls = typeof r.cls === 'function' ? r.cls(m[0], code, i + m[0].length, toks[toks.length - 1]?.cls) : r.cls;
      if (cls === null) continue;
      push(m[0], cls); i += m[0].length; hit = true; break;
    }
    if (!hit) { push(code[i], 'plain'); i++; }
  }
  return toks;
}

/** Highlight code into lines of tokens (multi-line tokens such as block comments are split at newlines). */
export function highlight(code, lang = 'plain') {
  const lines = [[]];
  for (const t of tokenize(normalizeCode(code), lang)) {
    const parts = t.text.split('\n');
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ text: p, cls: t.cls });
    });
  }
  return lines;
}
