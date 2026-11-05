/*
 * formula.js — a small, safe formula engine.
 * Formulas are tokenised and parsed into an AST and interpreted; nothing is ever passed to eval().
 * Unknown functions are reported as unsupported rather than computed incorrectly.
 */
(function (root) {
  'use strict';
  const SheetApp = (root.SheetApp = root.SheetApp || {});
  const U = SheetApp.utils;

  const ERRORS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#CIRC!'];

  function err(code) { return { error: code }; }
  function isError(v) { return v !== null && typeof v === 'object' && typeof v.error === 'string'; }
  function isRange(v) { return v !== null && typeof v === 'object' && v.isRange === true; }

  class FormulaSyntaxError extends Error {}
  class UnsupportedError extends Error {
    constructor(message, feature) { super(message); this.feature = feature; }
  }

  /* ---------- Tokeniser ---------- */

  const SHEET = "(?:'((?:[^']|'')+)'|([A-Za-z_\\u00C0-\\uFFFF][\\w.\\u00C0-\\uFFFF]*))!";
  const CELL = '(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})';
  const COLS = '(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})';
  const ROWS = '(\\$?)(\\d{1,7}):(\\$?)(\\d{1,7})';
  const REF_RE = new RegExp('(?:' + SHEET + ')?(?:' + CELL + '(?::' + CELL + ')?|' + COLS + '|' + ROWS + ')(?![\\w(!.\\u00C0-\\uFFFF])', 'y');
  const IDENT_RE = /[A-Za-z_\u00C0-\uFFFF][\w.\u00C0-\uFFFF]*/y;
  const NUMBER_RE = /(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/y;
  const ERROR_RE = /#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|CIRC!)/iy;

  function buildRefToken(m, start, end) {
    const sheetName = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] !== undefined ? m[2] : null);
    const ref = { type: 'ref', sheetName, start, end };
    if (m[6] !== undefined) {
      ref.c1 = U.lettersToCol(m[4]); ref.r1 = Number(m[6]) - 1;
      ref.abs = { c1: !!m[3], r1: !!m[5], c2: !!m[3], r2: !!m[5] };
      if (m[10] !== undefined) {
        ref.kind = 'area';
        ref.c2 = U.lettersToCol(m[8]); ref.r2 = Number(m[10]) - 1;
        ref.abs.c2 = !!m[7]; ref.abs.r2 = !!m[9];
      } else {
        ref.kind = 'cell'; ref.c2 = ref.c1; ref.r2 = ref.r1;
      }
    } else if (m[12] !== undefined) {
      ref.kind = 'cols';
      ref.c1 = U.lettersToCol(m[12]); ref.c2 = U.lettersToCol(m[14]);
      ref.r1 = 0; ref.r2 = U.MAX_ROWS - 1;
      ref.abs = { c1: !!m[11], c2: !!m[13], r1: true, r2: true };
    } else {
      ref.kind = 'rows';
      ref.r1 = Number(m[16]) - 1; ref.r2 = Number(m[18]) - 1;
      ref.c1 = 0; ref.c2 = U.MAX_COLS - 1;
      ref.abs = { r1: !!m[15], r2: !!m[17], c1: true, c2: true };
    }
    if (ref.r1 < 0 || ref.r2 < 0) return null;
    return ref;
  }

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    const match = (re) => { re.lastIndex = i; return re.exec(src); };
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      const start = i;
      if (ch === '"') {
        let s = '';
        i++;
        for (;;) {
          if (i >= src.length) throw new FormulaSyntaxError('A text value is missing its closing quote.');
          if (src[i] === '"') {
            if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
            i++; break;
          }
          s += src[i++];
        }
        tokens.push({ type: 'str', value: s, start, end: i });
        continue;
      }
      if (ch === '#') {
        const m = match(ERROR_RE);
        if (!m) throw new FormulaSyntaxError('Unknown error value at position ' + (i + 1) + '.');
        i += m[0].length;
        tokens.push({ type: 'err', value: m[0].toUpperCase(), start, end: i });
        continue;
      }
      let m = match(REF_RE);
      if (m) {
        const ref = buildRefToken(m, start, start + m[0].length);
        if (ref) { i += m[0].length; tokens.push(ref); continue; }
      }
      m = match(NUMBER_RE);
      if (m) {
        i += m[0].length;
        tokens.push({ type: 'num', value: Number(m[0]), start, end: i });
        continue;
      }
      m = match(IDENT_RE);
      if (m) {
        i += m[0].length;
        let j = i;
        while (j < src.length && /\s/.test(src[j])) j++;
        const upper = m[0].toUpperCase();
        if (src[j] === '(') tokens.push({ type: 'func', value: upper.replace(/^_XLFN\.|^_XLWS\./, ''), start, end: i });
        else if (upper === 'TRUE' || upper === 'FALSE') tokens.push({ type: 'bool', value: upper === 'TRUE', start, end: i });
        else tokens.push({ type: 'name', value: m[0], start, end: i });
        continue;
      }
      const two = src.substr(i, 2);
      if (two === '<>' || two === '<=' || two === '>=') { i += 2; tokens.push({ type: 'op', value: two, start, end: i }); continue; }
      if ('+-*/^&=<>%'.includes(ch)) { i++; tokens.push({ type: 'op', value: ch, start, end: i }); continue; }
      if (ch === '(' || ch === ')') { i++; tokens.push({ type: ch, start, end: i }); continue; }
      if (ch === ',' || ch === ';') { i++; tokens.push({ type: ',', start, end: i }); continue; }
      if (ch === '{') throw new UnsupportedError('Array constants ({…}) are not supported.', 'array constant');
      throw new FormulaSyntaxError('Unexpected character "' + ch + '" at position ' + (i + 1) + '.');
    }
    return tokens;
  }

  // ---------- Parser. Precedence, low to high: comparison, &, + -, * /, ^, unary, % ----------

  function parse(src) {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const isOp = (...ops) => peek() && peek().type === 'op' && ops.includes(peek().value);

    function binaryLevel(next, ops) {
      return function () {
        let left = next();
        while (isOp(...ops)) {
          const op = tokens[pos++].value;
          left = { type: 'binary', op, left, right: next() };
        }
        return left;
      };
    }

    function parsePrimary() {
      const t = tokens[pos++];
      if (!t) throw new FormulaSyntaxError('The formula ends unexpectedly.');
      switch (t.type) {
        case 'num': return { type: 'num', value: t.value };
        case 'str': return { type: 'str', value: t.value };
        case 'bool': return { type: 'bool', value: t.value };
        case 'err': return { type: 'err', value: t.value };
        case 'ref': return { type: 'ref', ref: t };
        case 'name': throw new UnsupportedError('Named ranges such as "' + t.value + '" are not supported.', 'name ' + t.value);
        case '(': {
          const inner = parseComparison();
          if (!peek() || peek().type !== ')') throw new FormulaSyntaxError('A closing parenthesis is missing.');
          pos++;
          return inner;
        }
        case 'func': {
          pos++; // the '('
          const args = [];
          if (peek() && peek().type === ')') { pos++; return { type: 'call', name: t.value, args }; }
          for (;;) {
            if (peek() && (peek().type === ',' || peek().type === ')')) args.push({ type: 'missing' });
            else args.push(parseComparison());
            const sep = tokens[pos++];
            if (!sep) throw new FormulaSyntaxError('A closing parenthesis is missing for ' + t.value + '.');
            if (sep.type === ')') break;
            if (sep.type !== ',') throw new FormulaSyntaxError('Expected a comma or ")" in ' + t.value + '.');
          }
          return { type: 'call', name: t.value, args };
        }
        default:
          throw new FormulaSyntaxError('Unexpected "' + src.slice(t.start, t.end) + '" at position ' + (t.start + 1) + '.');
      }
    }

    function parsePercent() {
      let node = parsePrimary();
      while (isOp('%')) { pos++; node = { type: 'percent', arg: node }; }
      return node;
    }
    function parseUnary() {
      if (isOp('-', '+')) {
        const op = tokens[pos++].value;
        return { type: 'unary', op, arg: parseUnary() };
      }
      return parsePercent();
    }
    const parsePower = binaryLevel(parseUnary, ['^']);
    const parseMul = binaryLevel(parsePower, ['*', '/']);
    const parseAdd = binaryLevel(parseMul, ['+', '-']);
    const parseConcat = binaryLevel(parseAdd, ['&']);
    const parseComparison = binaryLevel(parseConcat, ['=', '<>', '<', '>', '<=', '>=']);

    const ast = parseComparison();
    if (pos < tokens.length) {
      const t = tokens[pos];
      throw new FormulaSyntaxError('Unexpected "' + src.slice(t.start, t.end) + '" at position ' + (t.start + 1) + '.');
    }
    return ast;
  }

  const astCache = new Map();
  function parseCached(src) {
    let entry = astCache.get(src);
    if (!entry) {
      try { entry = { ast: parse(src) }; } catch (e) { entry = { failure: e }; }
      if (astCache.size > 20000) astCache.clear();
      astCache.set(src, entry);
    }
    if (entry.failure) throw entry.failure;
    return entry.ast;
  }

  /** Validates a formula typed by the user. Returns null when OK or a message. */
  function checkSyntax(src) {
    try { parse(src); return null; } catch (e) {
      if (e instanceof UnsupportedError) return 'This formula uses syntax the editor cannot read yet: ' + e.message;
      return e.message;
    }
  }

  /* ---------- Coercion helpers ---------- */

  function toNumber(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isError(v)) return v;
    const n = U.parseNumber(String(v));
    return n === null ? err('#VALUE!') : n;
  }

  function toText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return U.formatGeneralNumber(v);
    return String(v);
  }

  function toBool(v) {
    if (v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (isError(v)) return v;
    const u = String(v).toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return err('#VALUE!');
  }

  const TYPE_RANK = { number: 0, string: 1, boolean: 2 };

  /** Excel-style ordering: numbers < text < booleans; text is case-insensitive. */
  function compareValues(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    const ra = TYPE_RANK[typeof a];
    const rb = TYPE_RANK[typeof b];
    if (ra !== rb) return ra - rb;
    if (typeof a === 'string') {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function roundHalfAway(x, digits) {
    const f = Math.pow(10, digits);
    const scaled = parseFloat((Math.abs(x) * f).toPrecision(15));
    return (Math.sign(x) * Math.round(scaled)) / f;
  }

  /* ---------- Evaluator ---------- */

  /**
   * ctx must provide:
   *   sheetIndex, resolveSheet(name) -> index | -1,
   *   getValue(sheetIndex, row, col) -> value,
   *   getRangeCells(sheetIndex, range) -> { area, cells: [{row, col, value}] } (non-empty cells only)
   */
  function evaluate(src, ctx) {
    const ast = parseCached(src);
    const v = evalNode(ast, ctx);
    return isRange(v) ? rangeToScalar(v, ctx) : v;
  }

  function refToRange(ref, ctx) {
    let sheet = ctx.sheetIndex;
    if (ref.sheetName !== null) {
      sheet = ctx.resolveSheet(ref.sheetName);
      if (sheet < 0) return err('#REF!');
    }
    return { isRange: true, sheet, r1: Math.min(ref.r1, ref.r2), c1: Math.min(ref.c1, ref.c2), r2: Math.max(ref.r1, ref.r2), c2: Math.max(ref.c1, ref.c2) };
  }

  function rangeToScalar(range, ctx) {
    if (range.r1 === range.r2 && range.c1 === range.c2) return ctx.getValue(range.sheet, range.r1, range.c1);
    return err('#VALUE!');
  }

  function scalar(node, ctx) {
    const v = evalNode(node, ctx);
    return isRange(v) ? rangeToScalar(v, ctx) : v;
  }

  function evalNode(node, ctx) {
    switch (node.type) {
      case 'num': case 'str': case 'bool': return node.value;
      case 'err': return err(node.value);
      case 'missing': return null;
      case 'ref': return refToRange(node.ref, ctx);
      case 'percent': {
        const n = toNumber(scalar(node.arg, ctx));
        return isError(n) ? n : n / 100;
      }
      case 'unary': {
        const n = toNumber(scalar(node.arg, ctx));
        if (isError(n)) return n;
        return node.op === '-' ? -n : n;
      }
      case 'binary': return evalBinary(node, ctx);
      case 'call': return callFunction(node, ctx);
      default: throw new UnsupportedError('Unknown expression.', 'expression');
    }
  }

  function evalBinary(node, ctx) {
    const a = scalar(node.left, ctx);
    if (isError(a)) return a;
    const b = scalar(node.right, ctx);
    if (isError(b)) return b;
    switch (node.op) {
      case '&': return toText(a) + toText(b);
      case '=': return compareValues(a, b) === 0;
      case '<>': return compareValues(a, b) !== 0;
      case '<': return compareValues(a, b) < 0;
      case '>': return compareValues(a, b) > 0;
      case '<=': return compareValues(a, b) <= 0;
      case '>=': return compareValues(a, b) >= 0;
      default: break;
    }
    const x = toNumber(a);
    if (isError(x)) return x;
    const y = toNumber(b);
    if (isError(y)) return y;
    let r;
    switch (node.op) {
      case '+': r = x + y; break;
      case '-': r = x - y; break;
      case '*': r = x * y; break;
      case '/': if (y === 0) return err('#DIV/0!'); r = x / y; break;
      case '^': r = Math.pow(x, y); break;
      default: throw new UnsupportedError('Unknown operator ' + node.op, 'operator');
    }
    return Number.isFinite(r) ? r : err('#NUM!');
  }

  /* ---------- Functions ---------- */

  /** Collects numbers like SUM does: ranges contribute numbers only; direct values are coerced. */
  function collectNumbers(args, ctx) {
    const out = [];
    for (const node of args) {
      const v = evalNode(node, ctx);
      if (isRange(v)) {
        for (const cell of ctx.getRangeCells(v.sheet, v).cells) {
          if (isError(cell.value)) return cell.value;
          if (typeof cell.value === 'number') out.push(cell.value);
        }
      } else {
        if (v === null) continue;
        const n = toNumber(v);
        if (isError(n)) return n;
        out.push(n);
      }
    }
    return out;
  }

  function numericFn(reducer) {
    return (args, ctx) => {
      const nums = collectNumbers(args, ctx);
      return isError(nums) ? nums : reducer(nums);
    };
  }

  function argCount(min, max, fn) {
    return (args, ctx) => (args.length < min || args.length > max ? err('#VALUE!') : fn(args, ctx));
  }

  function num(node, ctx) { return toNumber(scalar(node, ctx)); }
  function text(node, ctx) {
    const v = scalar(node, ctx);
    return isError(v) ? v : toText(v);
  }
  function guard(...values) { return values.find(isError); }

  /** COUNTIF-style criteria: ">5", "<>x", "a*", 10, TRUE. */
  function buildCriterion(c) {
    if (typeof c === 'number' || typeof c === 'boolean') return (v) => compareValues(v, c) === 0 && typeof v === typeof c;
    const s = c === null ? '' : String(c);
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(s);
    const op = m[1] || '=';
    const operandText = m[2];
    const n = U.parseNumber(operandText);
    const operand = n !== null ? n : operandText;
    if (typeof operand === 'string' && (op === '=' || op === '<>') && /[*?]/.test(operand)) {
      const pattern = new RegExp('^' + operand.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
      return (v) => (typeof v === 'string' && pattern.test(v)) === (op === '=');
    }
    return (v) => {
      if (operand === '' && op === '=') return v === null || v === '';
      if (operand === '' && op === '<>') return v !== null && v !== '';
      if (typeof operand === 'number' && typeof v !== 'number') return op === '<>';
      if (typeof operand === 'string' && typeof v !== 'string') return op === '<>';
      const cmp = compareValues(v, operand);
      switch (op) {
        case '=': return cmp === 0;
        case '<>': return cmp !== 0;
        case '<': return cmp < 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        default: return cmp >= 0;
      }
    };
  }

  function conditionalAggregate(args, ctx, kind) {
    const range = evalNode(args[0], ctx);
    if (!isRange(range)) return err('#VALUE!');
    const criterion = scalar(args[1], ctx);
    if (isError(criterion)) return criterion;
    const test = buildCriterion(criterion);
    let target = range;
    if (args[2]) {
      target = evalNode(args[2], ctx);
      if (!isRange(target)) return err('#VALUE!');
    }
    let count = 0;
    let sum = 0;
    const visit = (row, col, value) => {
      if (!test(value)) return;
      count++;
      if (kind !== 'count') {
        const tv = ctx.getValue(target.sheet, target.r1 + (row - range.r1), target.c1 + (col - range.c1));
        if (typeof tv === 'number') sum += tv;
      }
    };
    const matchesEmpty = test(null);
    if (matchesEmpty) {
      const bounded = ctx.boundRange(range.sheet, range);
      for (let r = bounded.r1; r <= bounded.r2; r++) for (let c = bounded.c1; c <= bounded.c2; c++) visit(r, c, ctx.getValue(range.sheet, r, c));
    } else {
      for (const cell of ctx.getRangeCells(range.sheet, range).cells) visit(cell.row, cell.col, cell.value);
    }
    if (kind === 'count') return count;
    if (kind === 'sum') return sum;
    return count === 0 ? err('#DIV/0!') : sum / count;
  }

  const FUNCTIONS = {
    SUM: numericFn((n) => n.reduce((a, b) => a + b, 0)),
    PRODUCT: numericFn((n) => n.reduce((a, b) => a * b, 1)),
    AVERAGE: numericFn((n) => (n.length ? n.reduce((a, b) => a + b, 0) / n.length : err('#DIV/0!'))),
    MIN: numericFn((n) => (n.length ? Math.min(...n) : 0)),
    MAX: numericFn((n) => (n.length ? Math.max(...n) : 0)),
    COUNT: (args, ctx) => {
      let count = 0;
      for (const node of args) {
        const v = evalNode(node, ctx);
        if (isRange(v)) count += ctx.getRangeCells(v.sheet, v).cells.filter((c) => typeof c.value === 'number').length;
        else if (typeof v === 'number' || (typeof v === 'string' && U.parseNumber(v) !== null) || typeof v === 'boolean') count++;
      }
      return count;
    },
    COUNTA: (args, ctx) => {
      let count = 0;
      for (const node of args) {
        const v = evalNode(node, ctx);
        if (isRange(v)) count += ctx.getRangeCells(v.sheet, v).cells.filter((c) => c.value !== null && c.value !== '').length;
        else if (node.type !== 'missing') count++;
      }
      return count;
    },
    COUNTBLANK: argCount(1, 1, (args, ctx) => {
      const v = evalNode(args[0], ctx);
      if (!isRange(v)) return err('#VALUE!');
      const info = ctx.getRangeCells(v.sheet, v);
      return info.area - info.cells.filter((c) => c.value !== '').length;
    }),
    COUNTIF: argCount(2, 2, (args, ctx) => conditionalAggregate(args, ctx, 'count')),
    SUMIF: argCount(2, 3, (args, ctx) => conditionalAggregate(args, ctx, 'sum')),
    AVERAGEIF: argCount(2, 3, (args, ctx) => conditionalAggregate(args, ctx, 'average')),
    IF: argCount(1, 3, (args, ctx) => {
      const cond = toBool(scalar(args[0], ctx));
      if (isError(cond)) return cond;
      if (cond) return args[1] ? scalar(args[1], ctx) : true;
      return args[2] ? scalar(args[2], ctx) : false;
    }),
    IFERROR: argCount(2, 2, (args, ctx) => {
      const v = scalar(args[0], ctx);
      return isError(v) ? scalar(args[1], ctx) : v;
    }),
    AND: (args, ctx) => logical(args, ctx, (vals) => vals.every(Boolean)),
    OR: (args, ctx) => logical(args, ctx, (vals) => vals.some(Boolean)),
    NOT: argCount(1, 1, (args, ctx) => {
      const b = toBool(scalar(args[0], ctx));
      return isError(b) ? b : !b;
    }),
    ROUND: argCount(2, 2, (args, ctx) => {
      const x = num(args[0], ctx); const d = num(args[1], ctx);
      return guard(x, d) || roundHalfAway(x, Math.trunc(d));
    }),
    ROUNDUP: argCount(2, 2, (args, ctx) => {
      const x = num(args[0], ctx); const d = num(args[1], ctx);
      if (guard(x, d)) return guard(x, d);
      const f = Math.pow(10, Math.trunc(d));
      return (Math.sign(x) * Math.ceil(parseFloat((Math.abs(x) * f).toPrecision(15)))) / f;
    }),
    ROUNDDOWN: argCount(2, 2, (args, ctx) => {
      const x = num(args[0], ctx); const d = num(args[1], ctx);
      if (guard(x, d)) return guard(x, d);
      const f = Math.pow(10, Math.trunc(d));
      return (Math.sign(x) * Math.floor(parseFloat((Math.abs(x) * f).toPrecision(15)))) / f;
    }),
    INT: argCount(1, 1, (args, ctx) => { const x = num(args[0], ctx); return guard(x) || Math.floor(x); }),
    ABS: argCount(1, 1, (args, ctx) => { const x = num(args[0], ctx); return guard(x) || Math.abs(x); }),
    SQRT: argCount(1, 1, (args, ctx) => {
      const x = num(args[0], ctx);
      return guard(x) || (x < 0 ? err('#NUM!') : Math.sqrt(x));
    }),
    MOD: argCount(2, 2, (args, ctx) => {
      const x = num(args[0], ctx); const y = num(args[1], ctx);
      if (guard(x, y)) return guard(x, y);
      if (y === 0) return err('#DIV/0!');
      return x - y * Math.floor(x / y);
    }),
    POWER: argCount(2, 2, (args, ctx) => {
      const x = num(args[0], ctx); const y = num(args[1], ctx);
      if (guard(x, y)) return guard(x, y);
      const r = Math.pow(x, y);
      return Number.isFinite(r) ? r : err('#NUM!');
    }),
    PI: argCount(0, 0, () => Math.PI),
    CONCATENATE: (args, ctx) => {
      const parts = args.map((a) => text(a, ctx));
      return guard(...parts) || parts.join('');
    },
    CONCAT: (args, ctx) => {
      let out = '';
      for (const node of args) {
        const v = evalNode(node, ctx);
        if (isRange(v)) {
          const bounded = ctx.boundRange(v.sheet, v);
          for (let r = bounded.r1; r <= bounded.r2; r++) for (let c = bounded.c1; c <= bounded.c2; c++) {
            const cv = ctx.getValue(v.sheet, r, c);
            if (isError(cv)) return cv;
            out += toText(cv);
          }
        } else {
          if (isError(v)) return v;
          out += toText(v);
        }
      }
      return out;
    },
    LEN: argCount(1, 1, (args, ctx) => { const t = text(args[0], ctx); return guard(t) || t.length; }),
    UPPER: argCount(1, 1, (args, ctx) => { const t = text(args[0], ctx); return guard(t) || t.toUpperCase(); }),
    LOWER: argCount(1, 1, (args, ctx) => { const t = text(args[0], ctx); return guard(t) || t.toLowerCase(); }),
    TRIM: argCount(1, 1, (args, ctx) => { const t = text(args[0], ctx); return guard(t) || t.trim().replace(/ {2,}/g, ' '); }),
    LEFT: argCount(1, 2, (args, ctx) => {
      const t = text(args[0], ctx); const n = args[1] ? num(args[1], ctx) : 1;
      if (guard(t, n)) return guard(t, n);
      return n < 0 ? err('#VALUE!') : t.slice(0, Math.trunc(n));
    }),
    RIGHT: argCount(1, 2, (args, ctx) => {
      const t = text(args[0], ctx); const n = args[1] ? num(args[1], ctx) : 1;
      if (guard(t, n)) return guard(t, n);
      if (n < 0) return err('#VALUE!');
      return Math.trunc(n) === 0 ? '' : t.slice(-Math.trunc(n));
    }),
    MID: argCount(3, 3, (args, ctx) => {
      const t = text(args[0], ctx); const s = num(args[1], ctx); const n = num(args[2], ctx);
      if (guard(t, s, n)) return guard(t, s, n);
      if (s < 1 || n < 0) return err('#VALUE!');
      return t.substr(Math.trunc(s) - 1, Math.trunc(n));
    }),
    VALUE: argCount(1, 1, (args, ctx) => {
      const v = scalar(args[0], ctx);
      if (typeof v === 'number') return v;
      return toNumber(v === null ? '' : v);
    }),
    TEXT: argCount(2, 2, (args, ctx) => {
      const v = num(args[0], ctx); const f = text(args[1], ctx);
      return guard(v, f) || U.formatNumber(v, f);
    }),
    ISBLANK: argCount(1, 1, (args, ctx) => scalar(args[0], ctx) === null),
    ISNUMBER: argCount(1, 1, (args, ctx) => typeof scalar(args[0], ctx) === 'number'),
    ISTEXT: argCount(1, 1, (args, ctx) => typeof scalar(args[0], ctx) === 'string'),
    ISERROR: argCount(1, 1, (args, ctx) => isError(scalar(args[0], ctx))),
    TODAY: argCount(0, 0, () => {
      const now = new Date();
      return Math.floor(U.dateToSerial(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))));
    }),
    NOW: argCount(0, 0, () => {
      const now = new Date();
      return U.dateToSerial(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds())));
    }),
  };

  function logical(args, ctx, reduce) {
    const vals = [];
    for (const node of args) {
      const v = evalNode(node, ctx);
      if (isRange(v)) {
        for (const cell of ctx.getRangeCells(v.sheet, v).cells) {
          if (isError(cell.value)) return cell.value;
          if (typeof cell.value === 'boolean' || typeof cell.value === 'number') vals.push(Boolean(cell.value));
        }
      } else {
        const b = toBool(v);
        if (isError(b)) return b;
        vals.push(b);
      }
    }
    return vals.length ? reduce(vals) : err('#VALUE!');
  }

  function callFunction(node, ctx) {
    const fn = FUNCTIONS[node.name];
    if (!fn) throw new UnsupportedError(node.name + ' is not supported by this editor.', node.name);
    return fn(node.args, ctx);
  }

  /** Lists function names that the editor cannot calculate (used for warnings). */
  function findUnsupportedFunctions(src) {
    try {
      return tokenize(src).filter((t) => t.type === 'func' && !FUNCTIONS[t.value]).map((t) => t.value);
    } catch (e) {
      return [];
    }
  }

  /* ---------- Reference rewriting ---------- */

  function quoteSheetName(name) {
    const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(TRUE|FALSE)$/i.test(name);
    return plain ? name : "'" + name.replace(/'/g, "''") + "'";
  }

  function refToText(ref) {
    const prefix = ref.sheetName !== null ? quoteSheetName(ref.sheetName) + '!' : '';
    const d = (flag) => (flag ? '$' : '');
    const cell = (r, c, ar, ac) => d(ac) + U.colToLetters(c) + d(ar) + (r + 1);
    switch (ref.kind) {
      case 'cell': return prefix + cell(ref.r1, ref.c1, ref.abs.r1, ref.abs.c1);
      case 'area': return prefix + cell(ref.r1, ref.c1, ref.abs.r1, ref.abs.c1) + ':' + cell(ref.r2, ref.c2, ref.abs.r2, ref.abs.c2);
      case 'cols': return prefix + d(ref.abs.c1) + U.colToLetters(ref.c1) + ':' + d(ref.abs.c2) + U.colToLetters(ref.c2);
      default: return prefix + d(ref.abs.r1) + (ref.r1 + 1) + ':' + d(ref.abs.r2) + (ref.r2 + 1);
    }
  }

  /**
   * Rewrites every reference in a formula. mapRef receives a copy of each ref and
   * returns the new ref, or null to turn it into #REF!. Returns null if the formula can't be tokenised.
   */
  function transformReferences(formula, mapRef) {
    let tokens;
    try { tokens = tokenize(formula); } catch (e) { return null; }
    let out = '';
    let pos = 0;
    for (const t of tokens) {
      if (t.type !== 'ref') continue;
      const mapped = mapRef({ ...t, abs: { ...t.abs } });
      out += formula.slice(pos, t.start) + (mapped ? refToText(mapped) : '#REF!');
      pos = t.end;
    }
    return out + formula.slice(pos);
  }

  /** Moves relative references by (dRow, dCol), as when copying a formula. */
  function shiftFormula(formula, dRow, dCol) {
    if (!dRow && !dCol) return formula;
    const result = transformReferences(formula, (ref) => {
      if (ref.kind !== 'cols') {
        if (!ref.abs.r1) ref.r1 += dRow;
        if (!ref.abs.r2) ref.r2 += dRow;
      }
      if (ref.kind !== 'rows') {
        if (!ref.abs.c1) ref.c1 += dCol;
        if (!ref.abs.c2) ref.c2 += dCol;
      }
      const ok = ref.r1 >= 0 && ref.r2 >= 0 && ref.c1 >= 0 && ref.c2 >= 0 && ref.r2 < U.MAX_ROWS && ref.c2 < U.MAX_COLS;
      return ok ? ref : null;
    });
    return result === null ? formula : result;
  }

  /** Adjusts references after rows/columns are inserted (count > 0) or deleted (count < 0). */
  function adjustForStructureChange(formula, formulaSheetName, targetSheetName, axis, at, count) {
    const target = targetSheetName.toLowerCase();
    const result = transformReferences(formula, (ref) => {
      const sheet = (ref.sheetName !== null ? ref.sheetName : formulaSheetName).toLowerCase();
      if (sheet !== target) return ref;
      if ((axis === 'row' && ref.kind === 'cols') || (axis === 'col' && ref.kind === 'rows')) return ref;
      const k1 = axis === 'row' ? 'r1' : 'c1';
      const k2 = axis === 'row' ? 'r2' : 'c2';
      if (count > 0) {
        if (ref[k1] >= at) ref[k1] += count;
        if (ref[k2] >= at) ref[k2] += count;
        return ref;
      }
      const n = -count;
      const end = at + n - 1;
      const a = ref[k1];
      const b = ref[k2];
      if (a >= at && b <= end) return null;
      ref[k1] = a > end ? a - n : a >= at ? at : a;
      ref[k2] = b > end ? b - n : b >= at ? at - 1 : b;
      return ref[k2] < ref[k1] ? null : ref;
    });
    return result === null ? formula : result;
  }

  function renameSheetInFormula(formula, oldName, newName) {
    const old = oldName.toLowerCase();
    const result = transformReferences(formula, (ref) => {
      if (ref.sheetName !== null && ref.sheetName.toLowerCase() === old) ref.sheetName = newName;
      return ref;
    });
    return result === null ? formula : result;
  }

  function removeSheetFromFormula(formula, sheetName) {
    const name = sheetName.toLowerCase();
    const result = transformReferences(formula, (ref) => (ref.sheetName !== null && ref.sheetName.toLowerCase() === name ? null : ref));
    return result === null ? formula : result;
  }

  SheetApp.formula = {
    ERRORS, FUNCTION_NAMES: Object.keys(FUNCTIONS).sort(),
    FormulaSyntaxError, UnsupportedError,
    evaluate, checkSyntax, isError, compareValues, toText,
    findUnsupportedFunctions, shiftFormula, adjustForStructureChange,
    renameSheetInFormula, removeSheetFromFormula, quoteSheetName,
  };
})(typeof window !== 'undefined' ? window : globalThis);
