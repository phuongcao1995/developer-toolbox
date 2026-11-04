// SQL Formatter - pure logic (no DOM, no dependencies).
//
// Pipeline:  tokenize()  ->  split into statements at ';'  ->  formatStatement() (token-driven layout engine).
// The formatter never inspects source whitespace (only "was there a newline before this comment"), so output
// depends solely on the token stream, which makes it idempotent. Tokens are never changed except for keyword case.

// ---------- vocabulary ----------
const words = s => new Set(s.split(/\s+/).filter(Boolean));

// Words whose letter case may be changed (reserved / structural keywords).
const KEYWORDS = words(`
ADD ALL ALTER AND ANY AS ASC BETWEEN BY CASCADE CASE CHECK COLUMN CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIME
CURRENT_TIMESTAMP DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXISTS FALSE FETCH FOREIGN FROM FULL
GRANT GROUP HAVING IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE ILIKE LIMIT NATURAL NOT NULL OFFSET ON
OR ORDER OUTER OVER PARTITION PRIMARY REFERENCES REPLACE RETURNING REVOKE RIGHT ROLLBACK SELECT SET TABLE THEN TO TOP
TRUE TRUNCATE UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WITH WINDOW RECURSIVE TEMPORARY TEMP IGNORE NULLS FIRST
LAST ROWS ROW RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT ONLY NEXT PERCENT TIES OPERATOR LATERAL APPLY MINUS QUALIFY
CONFLICT DO NOTHING DUPLICATE BEGIN COMMIT TRANSACTION EXPLAIN ANALYZE SIMILAR ESCAPE COLLATE CAST FOR SOME UNKNOWN
AUTO_INCREMENT AUTOINCREMENT RENAME MODIFY CHANGE AFTER BEFORE EACH TRIGGER PROCEDURE FUNCTION RETURNS RETURN DECLARE
`);
// Function names: only recased when directly followed by "(".
const FUNCTIONS = words(`
COUNT SUM AVG MIN MAX COALESCE NULLIF IFNULL ISNULL NVL IIF IF CAST CONVERT CONCAT CONCAT_WS SUBSTRING SUBSTR LEFT RIGHT
LENGTH LEN LOWER UPPER TRIM LTRIM RTRIM REPLACE ROUND FLOOR CEIL CEILING ABS MOD POWER SQRT NOW GETDATE DATE_ADD DATE_SUB
DATEADD DATEDIFF DATE_TRUNC EXTRACT YEAR MONTH DAY HOUR MINUTE SECOND TO_CHAR TO_DATE TO_NUMBER ROW_NUMBER RANK DENSE_RANK
NTILE LAG LEAD FIRST_VALUE LAST_VALUE STRING_AGG GROUP_CONCAT ARRAY_AGG JSON_EXTRACT JSON_OBJECT JSON_ARRAY EXISTS
`);
// Data types: recased in CREATE/ALTER statements, after "::" and inside CAST(... AS type).
const TYPES = words(`
INT INTEGER BIGINT SMALLINT TINYINT MEDIUMINT SERIAL BIGSERIAL BOOLEAN BOOL BIT DECIMAL NUMERIC FLOAT REAL DOUBLE PRECISION
MONEY CHAR VARCHAR NVARCHAR NCHAR TEXT CLOB BLOB BYTEA DATE TIME TIMESTAMP TIMESTAMPTZ DATETIME INTERVAL UUID JSON JSONB XML
ENUM ARRAY UNSIGNED
`);
// A word right after one of these is a (qualified) object name: "INSERT INTO t (a)" keeps a space before "(".
const NAME_KEYWORDS = words('INTO TABLE VIEW INDEX REFERENCES');
// A "(" directly after one of these keywords is spaced; after other words it hugs the name (function call).
const SPACE_BEFORE_PAREN = words(`
IN AND OR NOT ON USING VALUES AS EXISTS WHEN THEN ELSE SELECT FROM WHERE SET UNION ALL ANY SOME BETWEEN LIKE ILIKE IS OVER
WITH HAVING BY CASE INTO DISTINCT EXCEPT INTERSECT RETURNING LIMIT OFFSET JOIN KEY UNIQUE CHECK DEFAULT INDEX CONSTRAINT
PARTITION FILTER RECURSIVE LATERAL APPLY MINUS CONFLICT
`);
// Words after which "-"/"+" are unary (an operand is expected next).
const OPERAND_EXPECTING = words(`
SELECT WHERE AND OR NOT WHEN THEN ELSE BY ON SET VALUES IN BETWEEN LIKE IS HAVING RETURN LIMIT OFFSET CASE DISTINCT ALL ANY
USING EXISTS UNION AS
`);

// ---------- tokenizer ----------
const MULTI_OPS = ['<=>', '->>', '#>>', '!~*', '<>', '<=', '>=', '!=', '||', '::', '->', '=>', ':=', '<<', '>>', '!~', '~*', '&&', '@>', '<@', '#>', '=='];

/**
 * Per-dialect lexical rules.
 *  backslash: backslash escapes inside '...' (and "..." when dqString)   dqString: "..." is a string (not an identifier)
 *  dollar: $$...$$ / $tag$...$tag$ quoting   bracket: [bracket] identifiers   estr: E'..' strings (backslash escapes)
 *  hash: '#' starts a line comment   triple: '''...''' / """...""" strings
 *  keywords: extra words recased as keywords for that dialect.
 */
export const SQL_DIALECTS = {
  standard: { label: 'Standard SQL', backslash: false, dqString: false, dollar: true, bracket: true, estr: true, hash: false, triple: false, keywords: '' },
  postgresql: { label: 'PostgreSQL', backslash: false, dqString: false, dollar: true, bracket: false, estr: true, hash: false, triple: false,
    keywords: 'RETURNING MATERIALIZED CONCURRENTLY LATERAL ILIKE VERBOSE' },
  mysql: { label: 'MySQL / MariaDB', backslash: true, dqString: true, dollar: false, bracket: false, estr: false, hash: true, triple: false,
    keywords: 'STRAIGHT_JOIN SQL_CALC_FOUND_ROWS DELAYED HIGH_PRIORITY LOW_PRIORITY REGEXP RLIKE XOR DIV' },
  sqlserver: { label: 'SQL Server (T-SQL)', backslash: false, dqString: false, dollar: false, bracket: true, estr: false, hash: false, triple: false,
    keywords: 'MERGE OUTPUT NOLOCK PIVOT UNPIVOT CROSS OPENQUERY TRY CATCH THROW EXEC EXECUTE PRINT' },
  sqlite: { label: 'SQLite', backslash: false, dqString: false, dollar: false, bracket: true, estr: false, hash: false, triple: false,
    keywords: 'PRAGMA VACUUM GLOB WITHOUT ROWID' },
  bigquery: { label: 'BigQuery', backslash: true, dqString: true, dollar: false, bracket: false, estr: false, hash: true, triple: true,
    keywords: 'STRUCT UNNEST QUALIFY MERGE' },
  oracle: { label: 'Oracle', backslash: false, dqString: false, dollar: false, bracket: false, estr: false, hash: false, triple: false,
    keywords: 'CONNECT PRIOR START MERGE MINUS ROWNUM DUAL' },
};
const DIALECT_KEYWORDS = Object.fromEntries(Object.entries(SQL_DIALECTS).map(([k, d]) => [k, words(d.keywords)]));
/** Vocabulary helpers shared with the highlighter and the SQL analyser (upper-case word in, boolean out). */
export const isSqlKeyword = (up, dialect = 'standard') => KEYWORDS.has(up) || DIALECT_KEYWORDS[dialectOf(dialect)].has(up);
export const isSqlFunction = up => FUNCTIONS.has(up);
export const isSqlType = up => TYPES.has(up);
const dialectOf = name => SQL_DIALECTS[name] ? name : 'standard';

/** Scan a quoted literal starting at src[i] (the opening quote). Returns {end, closed}. */
function scanQuoted(src, i, quote, backslash = false) {
  let j = i + 1;
  while (j < src.length) {
    if (backslash && src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) { if (src[j + 1] === quote) { j += 2; continue; } return { end: j + 1, closed: true }; }
    j++;
  }
  return { end: src.length, closed: false }; // unterminated: swallow the rest so we never touch it
}

/** BigQuery triple-quoted string ('''...''' or """..."""). */
function scanTriple(src, i, quote, backslash) {
  const close = quote.repeat(3);
  let j = i + 3;
  while (j < src.length) {
    if (backslash && src[j] === '\\') { j += 2; continue; }
    if (src.startsWith(close, j)) return { end: j + 3, closed: true };
    j++;
  }
  return { end: src.length, closed: false };
}

/**
 * Tokenize SQL. Token: {type, text, nl, pos, up?, unterminated?}. `nl` = a line break occurred before the token (or it
 * starts the input). A word directly after '.' is a qualified name part, never a keyword (no `up`).
 * Options: dialect (key of SQL_DIALECTS, default 'standard').
 */
export function tokenize(src, { dialect = 'standard' } = {}) {
  const D = SQL_DIALECTS[dialectOf(dialect)];
  const toks = []; let i = 0, nl = true;
  const n = src.length;
  const push = (type, text, extra) => {
    const t = { type, text, nl, pos: i };
    if (type === 'word' && toks[toks.length - 1]?.text !== '.') t.up = text.toUpperCase();
    if (extra) Object.assign(t, extra);
    toks.push(t); nl = false; i += text.length;
  };
  const quoted = (type, start, r) => push(type, src.slice(start, r.end), r.closed ? null : { unterminated: true });
  while (i < n) {
    const c = src[i], rest2 = src.substr(i, 2);
    if (/\s/.test(c)) { if (c === '\n' || c === '\r') nl = true; i++; continue; }
    if (rest2 === '--') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('lcomment', src.slice(i, j).replace(/\r$/, '')); continue; }
    if (c === '#' && D.hash) { let j = src.indexOf('\n', i); if (j < 0) j = n; push('lcomment', src.slice(i, j).replace(/\r$/, '')); continue; }
    if (rest2 === '/*') { const j = src.indexOf('*/', i + 2); push('bcomment', src.slice(i, j < 0 ? n : j + 2), j < 0 ? { unterminated: true } : null); continue; }
    if (c === "'" || (c === '"' && D.dqString)) {
      const r = D.triple && src.startsWith(c.repeat(3), i) ? scanTriple(src, i, c, D.backslash) : scanQuoted(src, i, c, D.backslash);
      quoted('string', i, r); continue;
    }
    if (c === '"') { quoted('ident', i, scanQuoted(src, i, '"')); continue; }
    if (c === '`') { quoted('ident', i, scanQuoted(src, i, '`')); continue; }
    if (c === '[' && D.bracket) {
      // T-SQL [bracket identifier] only where an operand starts; otherwise it is an array subscript.
      const prev = toks[toks.length - 1];
      const operandBefore = prev && (prev.type === 'ident' || prev.type === 'number' || prev.type === 'string' || prev.text === ')' || prev.text === ']'
        || (prev.type === 'word' && !KEYWORDS.has(prev.up)));
      const m = /^\[[^[\]\n]+\]/.exec(src.slice(i, i + 200));
      if (m && !operandBefore && !/^\[\s*\d+\s*\]$/.test(m[0])) { push('ident', m[0]); continue; }
    }
    if (c === '$') {
      let m = /^\$\d+/.exec(src.slice(i, i + 20));
      if (m) { push('placeholder', m[0]); continue; }
      m = D.dollar && /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 80));
      if (m) { const j = src.indexOf(m[0], i + m[0].length); push('string', src.slice(i, j < 0 ? n : j + m[0].length), j < 0 ? { unterminated: true } : null); continue; }
    }
    // ".5" is a number unless it directly follows a name/closing bracket (then "." is a qualifier dot)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && !/[\w"`\])]/.test(src[i - 1] || ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d+([eE][+-]?\d+)?|\d+\.)/.exec(src.slice(i, i + 60));
      if (m) { push('number', m[0]); continue; }
    }
    if (/[A-Za-z_\u0080-￿]/.test(c) || (c === '#' && /[A-Za-z_]/.test(src[i + 1] || ''))) {
      let j = i + 1; while (j < n && /[\w$#\u0080-￿]/.test(src[j])) j++;
      const w = src.slice(i, j);
      // String prefixes (E'..', N'..', B'..', X'..') must stay glued to their literal.
      if (/^[eEnNbBxX]$/.test(w) && src[j] === "'") {
        const r = scanQuoted(src, j, "'", D.backslash || (D.estr && /[eE]/.test(w)));
        push('string', src.slice(i, r.end), r.closed ? null : { unterminated: true }); continue;
      }
      push('word', w); continue;
    }
    if (c === '@') { const m = /^@@?[\w$#]+/.exec(src.slice(i, i + 80)); if (m) { push('placeholder', m[0]); continue; } }
    if (c === '?') { push('placeholder', '?'); continue; }
    if (c === '%') {
      const m = /^%(\(\w+\))?s/.exec(src.slice(i, i + 40));
      if (m) { push('placeholder', m[0]); continue; }
    }
    if (c === ':' && src[i + 1] !== ':' && /[A-Za-z_]/.test(src[i + 1] || '') && !(toks.length && toks[toks.length - 1].text === ':')) {
      const m = /^:\w+/.exec(src.slice(i, i + 80)); push('placeholder', m[0]); continue;
    }
    const op = MULTI_OPS.find(o => src.startsWith(o, i)) || c;
    push('op', op);
  }
  return toks;
}

/** Human-readable problems found by the tokenizer (unterminated strings / comments), with line and column. */
export function sqlWarnings(sql, opts = {}) {
  const out = [];
  for (const t of tokenize(sql, opts)) {
    if (!t.unterminated) continue;
    const before = sql.slice(0, t.pos).split('\n');
    const what = t.type === 'bcomment' ? 'block comment' : t.type === 'ident' ? 'quoted identifier' : 'string literal';
    out.push(`Unterminated ${what} starting at line ${before.length}, column ${before[before.length - 1].length + 1}: the rest of the input was treated as part of it and left unchanged.`);
  }
  return out;
}

/** Split tokens into statements at ';'. Each: {tokens, terminated}. A trailing comment-only remainder is kept. */
function splitStatements(toks) {
  const out = []; let cur = [];
  for (const t of toks) {
    if (t.type === 'op' && t.text === ';') { out.push({ tokens: cur, terminated: true }); cur = []; }
    else cur.push(t);
  }
  if (cur.length) out.push({ tokens: cur, terminated: false });
  return out;
}

// ---------- layout engine ----------
const CLAUSE_LISTS = new Set(['SELECT', 'SET', 'VALUES', 'ON DUPLICATE KEY UPDATE']); // one item per line
const COND_CLAUSES = new Set(['WHERE', 'HAVING', 'ON', 'QUALIFY']);                  // AND/OR start new lines
const isOperand = t => !!t && (['number', 'string', 'ident', 'placeholder'].includes(t.type) || t.text === ')' || t.text === ']'
  || (t.type === 'word' && !OPERAND_EXPECTING.has(t.up)));

/** Recognise a clause keyword at toks[i]; returns {name, len} or null. `startOk` = a statement may begin here. */
function matchClause(toks, i, f, prev, stmtKind = '') {
  const w = k => (toks[i + k]?.type === 'word' ? toks[i + k].up : null);
  const a = w(0), b = w(1), c = w(2), d = w(3);
  const startOk = f.count === 0 || (prev && prev.text === ')' && f.clause === 'WITH');
  switch (a) {
    case 'SELECT': case 'WHERE': case 'HAVING': case 'LIMIT': case 'OFFSET': case 'RETURNING': case 'WINDOW': case 'QUALIFY': case 'VALUES':
      return { name: a, len: 1 };
    case 'FROM': return prev?.up === 'DISTINCT' ? null : { name: 'FROM', len: 1 }; // IS DISTINCT FROM is an operator
    case 'WITH': return f.count === 0 ? { name: 'WITH', len: 1 } : null;
    case 'SET': return f.count === 0 ? null : { name: 'SET', len: 1 };
    case 'GROUP': case 'ORDER': return b === 'BY' ? { name: `${a} BY`, len: 2 } : null;
    case 'UNION': case 'INTERSECT': case 'EXCEPT': case 'MINUS':
      return { name: a, len: (b === 'ALL' || b === 'DISTINCT') ? 2 : 1 };
    case 'INSERT': return startOk ? { name: 'INSERT', len: 1 } : null;
    case 'REPLACE': return startOk && b === 'INTO' ? { name: 'REPLACE', len: 1 } : null;
    case 'UPDATE': return startOk ? { name: 'UPDATE', len: 1 } : null;
    case 'DELETE': return startOk ? (b === 'FROM' ? { name: 'DELETE FROM', len: 2 } : { name: 'DELETE', len: 1 }) : null;
    case 'ON':
      if (b === 'CONFLICT') return { name: 'ON CONFLICT', len: 2 };
      if (b === 'DUPLICATE' && c === 'KEY' && d === 'UPDATE') return { name: 'ON DUPLICATE KEY UPDATE', len: 4 };
      return f.inJoin ? { name: 'ON', len: 1 } : null;
    case 'USING': return f.inJoin ? { name: 'USING', len: 1 } : null;
    case 'FOR': { // locking clause of a query: FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE
      if (f.count === 0 || !(f.kind === 'sub' || stmtKind === 'SELECT' || stmtKind === 'WITH')) return null;
      if (b === 'UPDATE' || b === 'SHARE') return { name: 'FOR UPDATE', len: 2 };
      if (b === 'KEY' && c === 'SHARE') return { name: 'FOR UPDATE', len: 3 };
      if (b === 'NO' && c === 'KEY' && d === 'UPDATE') return { name: 'FOR UPDATE', len: 4 };
      return null;
    }
    case 'STRAIGHT_JOIN': return { name: 'JOIN', len: 1 };
    case 'CROSS': case 'OUTER': if (b === 'APPLY') return { name: 'JOIN', len: 2 };
    // falls through: CROSS JOIN
    case 'NATURAL': case 'INNER': case 'LEFT': case 'RIGHT': case 'FULL': case 'JOIN': {
      let k = 0;
      if (w(k) === 'NATURAL') k++;
      if (['INNER', 'CROSS', 'LEFT', 'RIGHT', 'FULL'].includes(w(k))) k++;
      if (w(k) === 'OUTER') k++;
      return w(k) === 'JOIN' ? { name: 'JOIN', len: k + 1 } : null; // LEFT( ... ) etc. are plain words
    }
    default: return null;
  }
}

function newFrame(kind, base, closeIndent) {
  return { kind, base, closeIndent, count: 0, clause: '', list: false, itemIndent: base + 1, awaiting: false,
    inJoin: false, cond: false, between: false, topNum: false };
}

function formatStatement(toks, { unit, kwCase, dialect = 'standard', maxWidth = 0, commaFirst = false, funcCase = 'auto' }) {
  const extraKw = DIALECT_KEYWORDS[dialectOf(dialect)];
  let brackets = 0;           // depth of [ ... ] (array literals / subscripts): contents are never recased
  // Next significant (non-comment) token index for each token, computed once (was O(n^2) via slice().find()).
  const nextSigIdx = new Array(toks.length);
  for (let k = toks.length - 1, nxt = -1; k >= 0; k--) {
    nextSigIdx[k] = nxt;
    if (toks[k].type !== 'lcomment' && toks[k].type !== 'bcomment') nxt = k;
  }
  const lines = [];          // finished lines {indent, text}
  let cur = null;            // line being built
  let pending = null;        // indent for the next token's new line (null = continue current line)
  const frames = [newFrame('top', 0, 0)];
  const cases = [];          // open CASE expressions {indent, depth, inline}
  let prev = null, expectName = false, blockUsed = false;
  const first = toks.find(t => t.type === 'word');
  const stmtKind = first?.up || '';
  const isDdl = stmtKind === 'CREATE' || stmtKind === 'ALTER';
  let sawTable = false;
  let carryComma = false;    // comma-first style: the comma waits and is written in front of the next item
  const tabW = unit === '	' ? 4 : unit.length;

  const lineIndent = () => pending ?? cur?.indent ?? 0;
  const put = (text, space) => {
    if (pending !== null || !cur) { if (cur) lines.push(cur); cur = { indent: pending ?? 0, text }; pending = null; }
    else cur.text += (space ? ' ' : '') + text;
  };
  const caseOf = (t, nextIsParen) => {
    if (t.type !== 'word' || brackets > 0 || !t.up) return t.text;
    const up = t.up;
    if (funcCase !== 'auto' && nextIsParen && FUNCTIONS.has(up) && !SPACE_BEFORE_PAREN.has(up) && prev?.text !== '.' && !t.qualifier) {
      return funcCase === 'preserve' ? t.text : funcCase === 'upper' ? up : t.text.toLowerCase();
    }
    if (kwCase === 'preserve') return t.text;
    let isKw = KEYWORDS.has(up) || extraKw.has(up);
    if (!isKw && nextIsParen && FUNCTIONS.has(up)) isKw = true;
    if (!isKw && TYPES.has(up) && (isDdl || prev?.text === '::' || (prev?.up === 'AS' && frames.length > 1))) isKw = true;
    if (!isKw || prev?.text === '.' || t.qualifier) return t.text;
    return kwCase === 'upper' ? up : t.text.toLowerCase();
  };

  // Decide whether a space precedes `t` given the previous significant token.
  const spaceBefore = t => {
    if (!prev || prev.noSpaceAfter) return false;
    if (t.type === 'op' && [')', ']', ',', '.', '::'].includes(t.text)) return false;
    if (t.text === '(') {
      if (prev.type === 'word') return SPACE_BEFORE_PAREN.has(prev.up) || !!prev.nameCtx;
      if (prev.type === 'ident') return !!prev.nameCtx;
      return true;
    }
    if (t.text === '[') return !(prev.type === 'word' || prev.type === 'ident' || prev.text === ')' || prev.text === ']');
    // Adjacent operators must not fuse into another token (e.g. "- -1" must not become a "--" comment).
    return true;
  };
  const guardFuse = t => prev && prev.type === 'op' && t.type === 'op' && !/^[()[\],.;]$/.test(prev.text) && !/^[()[\],.;]$/.test(t.text)
    && prev.text !== '::' && t.text !== '::';

  // Max line width: before a token that follows a comma in an inline list (IN lists, function arguments) or in a
  // plain comma list (GROUP BY a, b, ...), start a continuation line when the token would overflow the width.
  const maybeWrap = (t, text, f) => {
    if (!maxWidth || prev?.text !== ',' || pending !== null || !cur || brackets > 0) return;
    if (f.kind === 'block' || (f.list && f.kind !== 'inline')) return;
    const width = cur.indent * tabW + cur.text.length + 1 + text.length + 1; // +1: the comma or bracket that follows
    if (width > maxWidth) pending = f.kind === 'inline' ? f.closeIndent + 1 : f.base + 1;
  };
  const write = (t, text) => {
    if (carryComma) { text = ', ' + text; carryComma = false; }
    let space = spaceBefore(t) || (!!prev && prev.noSpaceAfter && guardFuse(t));
    if (guardFuse(t) || (prev?.text === '.' && t.type === 'number')) space = true; // keep "." and "1" from fusing into ".1"
    put(text, space);
    prev = t; frames[frames.length - 1].count++;
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const f = frames[frames.length - 1];

    // ----- comments -----
    if (t.type === 'lcomment' || t.type === 'bcomment') {
      if (t.nl) { if (pending === null) pending = cur ? cur.indent : 0; put(t.text, false); }
      else if (cur) cur.text += ' ' + t.text;
      else cur = { indent: 0, text: t.text };
      if (t.type === 'lcomment') pending = pending ?? cur.indent; // nothing may follow a line comment on its line
      continue;
    }

    const up = t.up || null;
    const nextSig = nextSigIdx[i] >= 0 ? toks[nextSigIdx[i]] : undefined;
    if (t.type === 'op') { if (t.text === '[') brackets++; else if (t.text === ']' && brackets > 0) brackets--; }
    const nextIsParen = nextSig?.text === '(';

    // Items of SELECT/SET/VALUES start on their own line, except modifiers like DISTINCT / TOP n.
    if (f.awaiting) {
      const isMod = f.clause === 'SELECT' && ((up && ['DISTINCT', 'ALL', 'DISTINCTROW', 'TOP', 'PERCENT'].includes(up)) || (f.topNum && t.type === 'number'));
      if (isMod) f.topNum = up === 'TOP'; else { pending = f.itemIndent; f.awaiting = false; }
    }

    // ----- name context (for "INSERT INTO t (" spacing) and qualifier detection -----
    if (t.type === 'word' || t.type === 'ident') {
      t.nameCtx = expectName || (prev?.text === '.' && prev.nameCtx);
      expectName = false;
      if (nextSig?.text === '.' && t.type === 'word') t.qualifier = true; // schema.table: never recase
    } else if (t.text === '.') t.nameCtx = prev?.nameCtx;
    if (up && (NAME_KEYWORDS.has(up) || (up === 'EXISTS' && prev?.up === 'NOT') || (up === 'EXISTS' && prev?.up === 'IF') || (up === 'ON' && stmtKind === 'CREATE' && !f.inJoin))) expectName = true;
    if (up === 'TABLE') sawTable = true;

    // ----- clause keywords (only in top-level / subquery frames) -----
    if (up && (f.kind === 'top' || f.kind === 'sub')) {
      const m = matchClause(toks, i, f, prev, stmtKind);
      if (m) {
        const joinLike = m.name === 'JOIN', onLike = m.name === 'ON' || m.name === 'USING';
        pending = onLike ? f.base + 1 : f.base;
        for (let k = 0; k < m.len; k++) {
          const tk = toks[i + k];
          write(tk, m.name === 'FOR UPDATE' && kwCase !== 'preserve' ? (kwCase === 'upper' ? tk.text.toUpperCase() : tk.text.toLowerCase()) : caseOf(tk, false));
        }
        i += m.len - 1;
        f.clause = m.name; f.between = false; f.topNum = false;
        f.cond = COND_CLAUSES.has(m.name);
        if (joinLike) f.inJoin = true; else if (!onLike) f.inJoin = false;
        f.list = CLAUSE_LISTS.has(m.name);
        f.awaiting = f.list;
        // `SET @x = 1` style statements and friends keep working because f.list only affects commas below.
        continue;
      }
    }

    // ----- parentheses -----
    if (t.text === '(' && t.type === 'op') {
      const ci = lineIndent();
      const sub = nextSig?.type === 'word' && ['SELECT', 'WITH', 'VALUES'].includes(nextSig.up);
      const block = !sub && !blockUsed && f.kind === 'top' && frames.length === 1 && stmtKind === 'CREATE' && sawTable && prev && (prev.type === 'word' || prev.type === 'ident');
      maybeWrap(t, '(', f);
      write(t, '(');
      t.noSpaceAfter = true;
      if (sub) { frames.push(newFrame('sub', ci + 1, ci)); pending = ci + 1; }
      else if (block) { blockUsed = true; frames.push(newFrame('block', ci + 1, ci)); pending = ci + 1; }
      else frames.push(newFrame('inline', ci, ci));
      continue;
    }
    if (t.text === ')' && t.type === 'op') {
      if (frames.length > 1) {
        const closed = frames.pop();
        while (cases.length && cases[cases.length - 1].depth > frames.length) cases.pop();
        if (closed.kind !== 'inline') pending = closed.closeIndent;
      }
      write(t, ')');
      continue;
    }
    if (t.text === ',' && t.type === 'op') {
      const breaks = brackets === 0 && (f.kind === 'block' || (f.kind !== 'inline' && (f.list || f.clause === 'WITH')));
      if (commaFirst && breaks) { carryComma = true; prev = t; f.count++; } else write(t, ',');
      if (brackets > 0) { /* comma inside [ ] (array literal): stay on the line */ }
      else if (f.kind === 'block') pending = f.base;
      else if (f.kind !== 'inline') {
        if (f.list) pending = f.itemIndent;
        else if (f.clause === 'WITH') pending = f.base;
      }
      continue;
    }

    // ----- words with layout meaning -----
    if (up) {
      if (up === 'CASE') {
        cases.push({ indent: lineIndent(), depth: frames.length, inline: f.kind === 'inline' });
      } else if ((up === 'WHEN' || up === 'ELSE') && cases.length && cases[cases.length - 1].depth === frames.length && !cases[cases.length - 1].inline) {
        pending = cases[cases.length - 1].indent + 1;
      } else if (up === 'END' && cases.length && cases[cases.length - 1].depth === frames.length) {
        const c = cases.pop();
        if (!c.inline) pending = c.indent;
      } else if (up === 'BETWEEN') f.between = true;
      else if (up === 'AND' && f.between) f.between = false;
      else if ((up === 'AND' || up === 'OR') && f.cond && (f.kind === 'top' || f.kind === 'sub')
        && !(cases.length && cases[cases.length - 1].depth === frames.length)) pending = f.base + 1;
    }

    // ----- operators: unary detection, tight operators -----
    if (t.type === 'op') {
      if (['-', '+', '~', '!'].includes(t.text) && !isOperand(prev)) t.noSpaceAfter = true;   // unary
      if (t.text === '.' || t.text === '::' || t.text === '[') t.noSpaceAfter = true;
    }

    maybeWrap(t, t.text, f);
    write(t, caseOf(t, nextIsParen));
  }
  if (carryComma && cur) cur.text += ',';
  if (cur) lines.push(cur);
  return lines.map(l => (l.text ? unit.repeat(l.indent) + l.text : '')).join('\n');
}

/**
 * Format SQL. Options: indent (string, default two spaces), keywordCase 'upper' | 'lower' | 'preserve',
 * maxWidth (0 = off; else wrap inline comma lists that overflow this width), commaFirst (leading commas in one-per-line lists),
 * functionCase 'auto' (follow keywordCase) | 'upper' | 'lower' | 'preserve' (only names directly followed by "(").
 * Throws nothing for odd input: unknown constructs are laid out as plain tokens.
 */
export function formatSql(sql, { indent = '  ', keywordCase = 'upper', dialect = 'standard', maxWidth = 0, commaFirst = false, functionCase = 'auto' } = {}) {
  if (!sql || !sql.trim()) return '';
  const parts = [];
  for (const s of splitStatements(tokenize(sql, { dialect }))) {
    const body = formatStatement(s.tokens, { unit: indent, kwCase: keywordCase, dialect, maxWidth: Number(maxWidth) || 0, commaFirst: !!commaFirst, funcCase: functionCase });
    const endsWithLineComment = s.tokens.length && s.tokens[s.tokens.length - 1].type === 'lcomment';
    parts.push(body + (s.terminated ? (endsWithLineComment ? '\n;' : ';') : ''));
  }
  return parts.join('\n\n');
}

/** Remove comments (keeping /*! and /*+ block hints and --+ line hints) and collapse whitespace; string literals / quoted names are untouched. */
export function minifySql(sql, { dialect = 'standard' } = {}) {
  const keep = t => t.type === 'bcomment' ? /^\/\*[!+]/.test(t.text) : t.type === 'lcomment' ? /^--\+/.test(t.text) : true;
  const toks = tokenize(sql, { dialect }).filter(keep);
  const wordish = t => ['word', 'number', 'string', 'ident', 'placeholder', 'bcomment'].includes(t.type);
  const structural = t => /^[()[\],.;]$/.test(t.text);
  let out = '', prev = null;
  for (const t of toks) {
    if (prev) {
      if (prev.type === 'lcomment') out += '\n'; // a kept line hint must end its line
      else if (t.type === 'lcomment' || (wordish(prev) && wordish(t)) || (prev.type === 'op' && t.type === 'op' && !structural(prev) && !structural(t))) out += ' ';
    }
    out += t.text; prev = t;
  }
  return out;
}

/** Token stream as "type:text" strings (comments included) - used by tests to prove semantic preservation. */
export function tokenStream(sql, { ignoreCase = false, dialect = 'standard' } = {}) {
  return tokenize(sql, { dialect }).map(t => `${t.type}:${ignoreCase && t.type === 'word' ? t.text.toLowerCase() : t.text}`);
}

export const sqlStats = (sql, opts = {}) => ({ chars: sql.length, lines: sql ? sql.split('\n').length : 0, statements: splitStatements(tokenize(sql, opts)).filter(s => s.tokens.length).length });
