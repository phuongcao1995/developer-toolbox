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

function scanQuoted(src, i, quote, backslash = false) { // returns index after the closing quote (or end of input)
  let j = i + 1;
  while (j < src.length) {
    if (backslash && src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) { if (src[j + 1] === quote) { j += 2; continue; } return j + 1; }
    j++;
  }
  return src.length; // unterminated: swallow the rest so we never touch it
}

/** Tokenize SQL. Token: {type, text, nl, up?}. `nl` = a line break occurred before the token (or it starts the input). */
export function tokenize(src) {
  const toks = []; let i = 0, nl = true;
  const n = src.length;
  const push = (type, text) => { const t = { type, text, nl }; if (type === 'word') t.up = text.toUpperCase(); toks.push(t); nl = false; i += text.length; };
  while (i < n) {
    const c = src[i], rest2 = src.substr(i, 2);
    if (/\s/.test(c)) { if (c === '\n' || c === '\r') nl = true; i++; continue; }
    if (rest2 === '--') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('lcomment', src.slice(i, j).replace(/\r$/, '')); continue; }
    if (rest2 === '/*') { const j = src.indexOf('*/', i + 2); push('bcomment', src.slice(i, j < 0 ? n : j + 2)); continue; }
    if (c === "'") { push('string', src.slice(i, scanQuoted(src, i, "'"))); continue; }
    if (c === '"') { push('ident', src.slice(i, scanQuoted(src, i, '"'))); continue; }
    if (c === '`') { push('ident', src.slice(i, scanQuoted(src, i, '`'))); continue; }
    if (c === '[') {
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
      m = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 80));
      if (m) { const j = src.indexOf(m[0], i + m[0].length); push('string', src.slice(i, j < 0 ? n : j + m[0].length)); continue; }
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
      if (/^[eEnNbBxX]$/.test(w) && src[j] === "'") { push('string', src.slice(i, scanQuoted(src, j, "'", /[eE]/.test(w)))); continue; }
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
function matchClause(toks, i, f, prev) {
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

function formatStatement(toks, { unit, kwCase }) {
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

  const lineIndent = () => pending ?? cur?.indent ?? 0;
  const put = (text, space) => {
    if (pending !== null || !cur) { if (cur) lines.push(cur); cur = { indent: pending ?? 0, text }; pending = null; }
    else cur.text += (space ? ' ' : '') + text;
  };
  const caseOf = (t, nextIsParen) => {
    if (kwCase === 'preserve' || t.type !== 'word') return t.text;
    const up = t.up;
    let isKw = KEYWORDS.has(up);
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

  const write = (t, text) => {
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
    const nextSig = toks.slice(i + 1).find(x => x.type !== 'lcomment' && x.type !== 'bcomment');
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
      const m = matchClause(toks, i, f, prev);
      if (m) {
        const joinLike = m.name === 'JOIN', onLike = m.name === 'ON' || m.name === 'USING';
        pending = onLike ? f.base + 1 : f.base;
        for (let k = 0; k < m.len; k++) {
          const tk = toks[i + k];
          write(tk, caseOf(tk, false));
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
      write(t, ',');
      if (f.kind === 'block') pending = f.base;
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

    write(t, caseOf(t, nextIsParen));
  }
  if (cur) lines.push(cur);
  return lines.map(l => (l.text ? unit.repeat(l.indent) + l.text : '')).join('\n');
}

/**
 * Format SQL. Options: indent (string, default two spaces), keywordCase 'upper' | 'lower' | 'preserve'.
 * Throws nothing for odd input: unknown constructs are laid out as plain tokens.
 */
export function formatSql(sql, { indent = '  ', keywordCase = 'upper' } = {}) {
  if (!sql || !sql.trim()) return '';
  const parts = [];
  for (const s of splitStatements(tokenize(sql))) {
    const body = formatStatement(s.tokens, { unit: indent, kwCase: keywordCase });
    const endsWithLineComment = s.tokens.length && s.tokens[s.tokens.length - 1].type === 'lcomment';
    parts.push(body + (s.terminated ? (endsWithLineComment ? '\n;' : ';') : ''));
  }
  return parts.join('\n\n');
}

/** Remove comments (keeping /*! and /*+ hints) and collapse whitespace; string literals / quoted names are untouched. */
export function minifySql(sql) {
  const toks = tokenize(sql).filter(t => !(t.type === 'lcomment' || (t.type === 'bcomment' && !/^\/\*[!+]/.test(t.text))));
  const wordish = t => ['word', 'number', 'string', 'ident', 'placeholder', 'bcomment'].includes(t.type);
  const structural = t => /^[()[\],.;]$/.test(t.text);
  let out = '', prev = null;
  for (const t of toks) {
    if (prev) {
      const needSpace = (wordish(prev) && wordish(t))
        || (prev.type === 'op' && t.type === 'op' && !structural(prev) && !structural(t));
      if (needSpace) out += ' ';
    }
    out += t.text; prev = t;
  }
  return out;
}

/** Token stream as "type:text" strings (comments included) - used by tests to prove semantic preservation. */
export function tokenStream(sql, { ignoreCase = false } = {}) {
  return tokenize(sql).map(t => `${t.type}:${ignoreCase && t.type === 'word' ? t.text.toLowerCase() : t.text}`);
}

export const sqlStats = sql => ({ chars: sql.length, lines: sql ? sql.split('\n').length : 0, statements: splitStatements(tokenize(sql)).filter(s => s.tokens.length).length });
