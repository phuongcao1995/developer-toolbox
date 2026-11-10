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

  /* ---------- Lookup, text, date, statistics and logical functions ---------- */

  const rangeArg = (node, ctx) => { const v = evalNode(node, ctx); return isRange(v) ? v : null; };
  const cellRef = (sheet, r, c) => ({ isRange: true, sheet, r1: r, c1: c, r2: r, c2: c });
  const wildcardRegExp = (s, flags) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', flags);
  const exactEq = (a, b) => a !== null && b !== null && typeof a === typeof b && compareValues(a, b) === 0;
  const secondsOf = (serial) => Math.round((serial - Math.floor(serial)) * 86400);
  const utcDate = (serial) => U.serialToDate(Math.floor(serial));
  const serialOf = (y, m, d) => Math.round(U.dateToSerial(new Date(Date.UTC(y, m, d))));
  const clean15 = (x) => parseFloat(x.toPrecision(15));

  /** Values of a one-row or one-column range, cut off at the used area so whole-column lookups stay fast. */
  function vectorOf(range, ctx) {
    const b = ctx.boundRange(range.sheet, range);
    const out = [];
    if (range.c1 === range.c2) for (let r = range.r1; r <= Math.max(range.r1, b.r2); r++) out.push(ctx.getValue(range.sheet, r, range.c1));
    else for (let c = range.c1; c <= Math.max(range.c1, b.c2); c++) out.push(ctx.getValue(range.sheet, range.r1, c));
    return out;
  }

  /** Position of `key` in `values`: mode 0 exact (text wildcards allowed), 1 largest value <= key, -1 smallest value >= key. */
  function findPosition(key, values, mode) {
    if (mode === 0) {
      if (typeof key === 'string' && /[*?]/.test(key)) { const re = wildcardRegExp(key, 'is'); return values.findIndex((v) => typeof v === 'string' && re.test(v)); }
      return values.findIndex((v) => exactEq(v, key));
    }
    let best = -1;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || typeof v !== typeof key) continue;
      const c = compareValues(v, key);
      if (mode === 1 ? c <= 0 : c >= 0) best = i; else break;
    }
    return best;
  }

  /** Walks the cells of equally sized criteria ranges. visit(rowOffset, colOffset) is called for every cell that passes every test. */
  function eachMatch(pairs, ctx, visit) {
    const first = pairs[0].range;
    const h = first.r2 - first.r1 + 1; const w = first.c2 - first.c1 + 1;
    let usedRows = 0; let usedCols = 0;
    for (const p of pairs) {
      if (p.range.r2 - p.range.r1 + 1 !== h || p.range.c2 - p.range.c1 + 1 !== w) return err('#VALUE!');
      const b = ctx.boundRange(p.range.sheet, p.range);
      usedRows = Math.max(usedRows, b.r2 - p.range.r1 + 1); usedCols = Math.max(usedCols, b.c2 - p.range.c1 + 1);
    }
    usedRows = Math.min(h, Math.max(usedRows, 0)); usedCols = Math.min(w, Math.max(usedCols, 0));
    for (let i = 0; i < usedRows; i++) {
      for (let j = 0; j < usedCols; j++) {
        if (pairs.every((p) => p.test(ctx.getValue(p.range.sheet, p.range.r1 + i, p.range.c1 + j)))) visit(i, j);
      }
    }
    return null;
  }

  /** COUNTIFS / SUMIFS / AVERAGEIFS / MAXIFS / MINIFS. For the sum-style functions the first argument is the value range. */
  function multiCriteria(args, ctx, kind) {
    const withValues = kind !== 'count';
    const rest = withValues ? args.slice(1) : args;
    if (rest.length < 2 || rest.length % 2 !== 0) return err('#VALUE!');
    const pairs = [];
    for (let i = 0; i < rest.length; i += 2) {
      const range = rangeArg(rest[i], ctx);
      const crit = scalar(rest[i + 1], ctx);
      if (!range) return err('#VALUE!');
      if (isError(crit)) return crit;
      pairs.push({ range, test: buildCriterion(crit) });
    }
    let target = null;
    if (withValues) {
      target = rangeArg(args[0], ctx);
      if (!target) return err('#VALUE!');
      const r = pairs[0].range;
      if (target.r2 - target.r1 !== r.r2 - r.r1 || target.c2 - target.c1 !== r.c2 - r.c1) return err('#VALUE!');
    }
    let count = 0; let sum = 0; let max = -Infinity; let min = Infinity;
    const failure = eachMatch(pairs, ctx, (i, j) => {
      if (!withValues) { count++; return; }
      const v = ctx.getValue(target.sheet, target.r1 + i, target.c1 + j);
      if (typeof v !== 'number') return;
      count++; sum += v; if (v > max) max = v; if (v < min) min = v;
    });
    if (failure) return failure;
    switch (kind) {
      case 'count': return count;
      case 'sum': return sum;
      case 'average': return count === 0 ? err('#DIV/0!') : sum / count;
      case 'max': return count === 0 ? 0 : max;
      default: return count === 0 ? 0 : min;
    }
  }

  function lookupTable(args, ctx, vertical) {
    const key = scalar(args[0], ctx);
    const table = rangeArg(args[1], ctx);
    const index = num(args[2], ctx);
    if (isError(key)) return key;
    if (!table) return err('#VALUE!');
    if (isError(index)) return index;
    const approx = args[3] ? toBool(scalar(args[3], ctx)) : true;
    if (isError(approx)) return approx;
    const i = Math.trunc(index);
    const size = vertical ? table.c2 - table.c1 + 1 : table.r2 - table.r1 + 1;
    if (i < 1) return err('#VALUE!');
    if (i > size) return err('#REF!');
    const keys = vertical ? vectorOf({ ...table, c2: table.c1 }, ctx) : vectorOf({ ...table, r2: table.r1 }, ctx);
    const pos = findPosition(key, keys, approx ? 1 : 0);
    if (pos < 0) return err('#N/A');
    const v = vertical ? ctx.getValue(table.sheet, table.r1 + pos, table.c1 + i - 1) : ctx.getValue(table.sheet, table.r1 + i - 1, table.c1 + pos);
    return v === null ? 0 : v;
  }

  function statistic(args, ctx, sample, root) {
    const n = collectNumbers(args, ctx);
    if (isError(n)) return n;
    if (n.length < (sample ? 2 : 1)) return err('#DIV/0!');
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    const variance = n.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (sample ? n.length - 1 : n.length);
    return root ? Math.sqrt(variance) : variance;
  }

  function monthStart(serial, months) {
    const d = utcDate(serial);
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
    return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12, day: d.getUTCDate() };
  }

  const roundTo = (fn) => argCount(1, 2, (args, ctx) => {
    const x = num(args[0], ctx); const s = args[1] ? num(args[1], ctx) : 1;
    if (guard(x, s)) return guard(x, s);
    if (s === 0) return 0;
    if (x > 0 && s < 0) return err('#NUM!');
    return clean15(fn(clean15(x / s)) * s);
  });

  Object.assign(FUNCTIONS, {
    /* lookup and reference */
    VLOOKUP: argCount(3, 4, (args, ctx) => lookupTable(args, ctx, true)),
    HLOOKUP: argCount(3, 4, (args, ctx) => lookupTable(args, ctx, false)),
    MATCH: argCount(2, 3, (args, ctx) => {
      const key = scalar(args[0], ctx); const range = rangeArg(args[1], ctx);
      const type = args[2] ? num(args[2], ctx) : 1;
      if (isError(key)) return key;
      if (!range) return err('#VALUE!');
      if (isError(type)) return type;
      const pos = findPosition(key, vectorOf(range, ctx), type === 0 ? 0 : type > 0 ? 1 : -1);
      return pos < 0 ? err('#N/A') : pos + 1;
    }),
    INDEX: argCount(2, 3, (args, ctx) => {
      const range = rangeArg(args[0], ctx);
      if (!range) return err('#VALUE!');
      let r = num(args[1], ctx); let c = args[2] ? num(args[2], ctx) : null;
      if (guard(r, c)) return guard(r, c);
      const rows = range.r2 - range.r1 + 1; const cols = range.c2 - range.c1 + 1;
      if (c === null) { if (rows === 1 && cols > 1) { c = r; r = 1; } else c = cols === 1 ? 1 : 0; }
      r = Math.trunc(r); c = Math.trunc(c);
      if (r < 0 || c < 0 || r > rows || c > cols) return err('#REF!');
      if (r === 0 || c === 0) {
        return { isRange: true, sheet: range.sheet, r1: r === 0 ? range.r1 : range.r1 + r - 1, r2: r === 0 ? range.r2 : range.r1 + r - 1, c1: c === 0 ? range.c1 : range.c1 + c - 1, c2: c === 0 ? range.c2 : range.c1 + c - 1 };
      }
      const v = ctx.getValue(range.sheet, range.r1 + r - 1, range.c1 + c - 1);
      return v === null ? 0 : v;
    }),
    XLOOKUP: argCount(3, 6, (args, ctx) => {
      const key = scalar(args[0], ctx); const where = rangeArg(args[1], ctx); const result = rangeArg(args[2], ctx);
      const mode = args[4] && args[4].type !== 'missing' ? num(args[4], ctx) : 0;
      const direction = args[5] && args[5].type !== 'missing' ? num(args[5], ctx) : 1;
      if (isError(key)) return key;
      if (!where || !result) return err('#VALUE!');
      if (guard(mode, direction)) return guard(mode, direction);
      const vertical = where.c1 === where.c2;
      const keys = vectorOf(where, ctx);
      let pos;
      const order = direction < 0 ? keys.map((_, i) => keys.length - 1 - i) : keys.map((_, i) => i);
      if (mode === 0 || mode === 2) {
        const re = mode === 2 && typeof key === 'string' ? wildcardRegExp(key, 'is') : null;
        pos = order.find((i) => (re ? typeof keys[i] === 'string' && re.test(keys[i]) : exactEq(keys[i], key)));
      } else {
        // exact match wins; otherwise the nearest smaller (mode -1) or larger (mode 1) value
        pos = order.find((i) => exactEq(keys[i], key));
        if (pos === undefined) {
          for (const i of order) {
            const v = keys[i];
            if (v === null || typeof v !== typeof key) continue;
            const c = compareValues(v, key);
            if (mode === -1 ? c < 0 : c > 0) {
              if (pos === undefined || (mode === -1 ? compareValues(v, keys[pos]) > 0 : compareValues(v, keys[pos]) < 0)) pos = i;
            }
          }
        }
      }
      if (pos === undefined) return args[3] && args[3].type !== 'missing' ? scalar(args[3], ctx) : err('#N/A');
      const rows = result.r2 - result.r1 + 1; const cols = result.c2 - result.c1 + 1;
      if (vertical ? rows < pos + 1 : cols < pos + 1) return err('#REF!');
      if (vertical) {
        if (cols === 1) { const v = ctx.getValue(result.sheet, result.r1 + pos, result.c1); return v === null ? 0 : v; }
        return { isRange: true, sheet: result.sheet, r1: result.r1 + pos, r2: result.r1 + pos, c1: result.c1, c2: result.c2 };
      }
      if (rows === 1) { const v = ctx.getValue(result.sheet, result.r1, result.c1 + pos); return v === null ? 0 : v; }
      return { isRange: true, sheet: result.sheet, r1: result.r1, r2: result.r2, c1: result.c1 + pos, c2: result.c1 + pos };
    }),
    CHOOSE: (args, ctx) => {
      if (args.length < 2) return err('#VALUE!');
      const i = num(args[0], ctx);
      if (isError(i)) return i;
      const k = Math.trunc(i);
      return k < 1 || k >= args.length ? err('#VALUE!') : evalNode(args[k], ctx);
    },
    ROW: argCount(0, 1, (args, ctx) => {
      if (!args.length) return ctx.row === undefined ? err('#VALUE!') : ctx.row + 1;
      const r = rangeArg(args[0], ctx);
      return r ? r.r1 + 1 : err('#VALUE!');
    }),
    COLUMN: argCount(0, 1, (args, ctx) => {
      if (!args.length) return ctx.col === undefined ? err('#VALUE!') : ctx.col + 1;
      const r = rangeArg(args[0], ctx);
      return r ? r.c1 + 1 : err('#VALUE!');
    }),
    ROWS: argCount(1, 1, (args, ctx) => { const r = rangeArg(args[0], ctx); return r ? r.r2 - r.r1 + 1 : err('#VALUE!'); }),
    COLUMNS: argCount(1, 1, (args, ctx) => { const r = rangeArg(args[0], ctx); return r ? r.c2 - r.c1 + 1 : err('#VALUE!'); }),

    /* conditional aggregates with several criteria */
    COUNTIFS: (args, ctx) => multiCriteria(args, ctx, 'count'),
    SUMIFS: (args, ctx) => multiCriteria(args, ctx, 'sum'),
    AVERAGEIFS: (args, ctx) => multiCriteria(args, ctx, 'average'),
    MAXIFS: (args, ctx) => multiCriteria(args, ctx, 'max'),
    MINIFS: (args, ctx) => multiCriteria(args, ctx, 'min'),
    SUMPRODUCT: (args, ctx) => {
      const ranges = args.map((a) => rangeArg(a, ctx));
      if (!ranges.length || ranges.some((r) => !r)) return err('#VALUE!');
      const h = ranges[0].r2 - ranges[0].r1 + 1; const w = ranges[0].c2 - ranges[0].c1 + 1;
      if (ranges.some((r) => r.r2 - r.r1 + 1 !== h || r.c2 - r.c1 + 1 !== w)) return err('#VALUE!');
      const rows = Math.min(h, Math.max(...ranges.map((r) => ctx.boundRange(r.sheet, r).r2 - r.r1 + 1), 0));
      const cols = Math.min(w, Math.max(...ranges.map((r) => ctx.boundRange(r.sheet, r).c2 - r.c1 + 1), 0));
      let total = 0;
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          let p = 1;
          for (const r of ranges) { const v = ctx.getValue(r.sheet, r.r1 + i, r.c1 + j); if (isError(v)) return v; p *= typeof v === 'number' ? v : 0; }
          total += p;
        }
      }
      return total;
    },

    /* statistics and maths */
    MEDIAN: numericFn((n) => {
      if (!n.length) return err('#NUM!');
      const s = [...n].sort((a, b) => a - b); const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }),
    LARGE: argCount(2, 2, (args, ctx) => {
      const n = collectNumbers([args[0]], ctx); const k = num(args[1], ctx);
      if (guard(n, k)) return guard(n, k);
      const i = Math.trunc(k);
      return i < 1 || i > n.length ? err('#NUM!') : [...n].sort((a, b) => b - a)[i - 1];
    }),
    SMALL: argCount(2, 2, (args, ctx) => {
      const n = collectNumbers([args[0]], ctx); const k = num(args[1], ctx);
      if (guard(n, k)) return guard(n, k);
      const i = Math.trunc(k);
      return i < 1 || i > n.length ? err('#NUM!') : [...n].sort((a, b) => a - b)[i - 1];
    }),
    RANK: argCount(2, 3, (args, ctx) => {
      const x = num(args[0], ctx); const n = collectNumbers([args[1]], ctx); const asc = args[2] ? num(args[2], ctx) : 0;
      if (guard(x, n, asc)) return guard(x, n, asc);
      if (!n.includes(x)) return err('#N/A');
      return 1 + n.filter((v) => (asc ? v < x : v > x)).length;
    }),
    STDEV: (args, ctx) => statistic(args, ctx, true, true),
    'STDEV.S': (args, ctx) => statistic(args, ctx, true, true),
    'STDEV.P': (args, ctx) => statistic(args, ctx, false, true),
    VAR: (args, ctx) => statistic(args, ctx, true, false),
    'VAR.S': (args, ctx) => statistic(args, ctx, true, false),
    'VAR.P': (args, ctx) => statistic(args, ctx, false, false),
    CEILING: roundTo(Math.ceil),
    FLOOR: roundTo(Math.floor),
    TRUNC: argCount(1, 2, (args, ctx) => {
      const x = num(args[0], ctx); const d = args[1] ? num(args[1], ctx) : 0;
      if (guard(x, d)) return guard(x, d);
      const f = Math.pow(10, Math.trunc(d));
      return Math.trunc(clean15(x * f)) / f;
    }),
    SIGN: argCount(1, 1, (args, ctx) => { const x = num(args[0], ctx); return guard(x) || Math.sign(x); }),
    EXP: argCount(1, 1, (args, ctx) => { const x = num(args[0], ctx); if (guard(x)) return x; const r = Math.exp(x); return Number.isFinite(r) ? r : err('#NUM!'); }),
    LN: argCount(1, 1, (args, ctx) => { const x = num(args[0], ctx); return guard(x) || (x <= 0 ? err('#NUM!') : Math.log(x)); }),
    LOG10: argCount(1, 1, (args, ctx) => { const x = num(args[0], ctx); return guard(x) || (x <= 0 ? err('#NUM!') : Math.log10(x)); }),
    LOG: argCount(1, 2, (args, ctx) => {
      const x = num(args[0], ctx); const b = args[1] ? num(args[1], ctx) : 10;
      if (guard(x, b)) return guard(x, b);
      return x <= 0 || b <= 0 || b === 1 ? err('#NUM!') : Math.log(x) / Math.log(b);
    }),

    /* logical and information */
    IFS: (args, ctx) => {
      if (args.length < 2 || args.length % 2) return err('#VALUE!');
      for (let i = 0; i < args.length; i += 2) {
        const c = toBool(scalar(args[i], ctx));
        if (isError(c)) return c;
        if (c) return scalar(args[i + 1], ctx);
      }
      return err('#N/A');
    },
    SWITCH: (args, ctx) => {
      if (args.length < 3) return err('#VALUE!');
      const v = scalar(args[0], ctx);
      if (isError(v)) return v;
      let i = 1;
      for (; i + 1 < args.length; i += 2) {
        const c = scalar(args[i], ctx);
        if (isError(c)) return c;
        if (compareValues(v, c) === 0 && typeof v === typeof c) return scalar(args[i + 1], ctx);
      }
      return i < args.length ? scalar(args[i], ctx) : err('#N/A');
    },
    XOR: (args, ctx) => logical(args, ctx, (vals) => vals.filter(Boolean).length % 2 === 1),
    TRUE: argCount(0, 0, () => true),
    FALSE: argCount(0, 0, () => false),
    IFNA: argCount(2, 2, (args, ctx) => {
      const v = scalar(args[0], ctx);
      return isError(v) && v.error === '#N/A' ? scalar(args[1], ctx) : v;
    }),
    ISNA: argCount(1, 1, (args, ctx) => { const v = scalar(args[0], ctx); return isError(v) && v.error === '#N/A'; }),
    ISLOGICAL: argCount(1, 1, (args, ctx) => typeof scalar(args[0], ctx) === 'boolean'),
    ISNONTEXT: argCount(1, 1, (args, ctx) => typeof scalar(args[0], ctx) !== 'string'),

    /* text */
    FIND: argCount(2, 3, (args, ctx) => {
      const f = text(args[0], ctx); const w = text(args[1], ctx); const s = args[2] ? num(args[2], ctx) : 1;
      if (guard(f, w, s)) return guard(f, w, s);
      if (s < 1 || s > w.length + 1) return err('#VALUE!');
      const i = w.indexOf(f, Math.trunc(s) - 1);
      return i < 0 ? err('#VALUE!') : i + 1;
    }),
    SEARCH: argCount(2, 3, (args, ctx) => {
      const f = text(args[0], ctx); const w = text(args[1], ctx); const s = args[2] ? num(args[2], ctx) : 1;
      if (guard(f, w, s)) return guard(f, w, s);
      if (s < 1 || s > w.length + 1) return err('#VALUE!');
      const re = new RegExp(f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'is');
      const m = re.exec(w.slice(Math.trunc(s) - 1));
      return m ? m.index + Math.trunc(s) : err('#VALUE!');
    }),
    SUBSTITUTE: argCount(3, 4, (args, ctx) => {
      const t = text(args[0], ctx); const oldT = text(args[1], ctx); const newT = text(args[2], ctx);
      const n = args[3] ? num(args[3], ctx) : null;
      if (guard(t, oldT, newT, n)) return guard(t, oldT, newT, n);
      if (oldT === '') return t;
      if (n === null) return t.split(oldT).join(newT);
      if (n < 1) return err('#VALUE!');
      let at = -1;
      for (let k = 0; k < Math.trunc(n); k++) { at = t.indexOf(oldT, at + 1); if (at < 0) return t; }
      return t.slice(0, at) + newT + t.slice(at + oldT.length);
    }),
    REPLACE: argCount(4, 4, (args, ctx) => {
      const t = text(args[0], ctx); const s = num(args[1], ctx); const n = num(args[2], ctx); const r = text(args[3], ctx);
      if (guard(t, s, n, r)) return guard(t, s, n, r);
      if (s < 1 || n < 0) return err('#VALUE!');
      return t.slice(0, Math.trunc(s) - 1) + r + t.slice(Math.trunc(s) - 1 + Math.trunc(n));
    }),
    TEXTJOIN: (args, ctx) => {
      if (args.length < 3) return err('#VALUE!');
      const delim = text(args[0], ctx); const skip = toBool(scalar(args[1], ctx));
      if (guard(delim, skip)) return guard(delim, skip);
      const parts = [];
      for (const node of args.slice(2)) {
        const v = evalNode(node, ctx);
        const items = [];
        if (isRange(v)) {
          const b = ctx.boundRange(v.sheet, v);
          for (let r = v.r1; r <= b.r2; r++) for (let c = v.c1; c <= b.c2; c++) items.push(ctx.getValue(v.sheet, r, c));
        } else items.push(v);
        for (const it of items) {
          if (isError(it)) return it;
          const s = toText(it);
          if (!(skip && s === '')) parts.push(s);
        }
      }
      const out = parts.join(delim);
      return out.length > 32767 ? err('#VALUE!') : out;
    },
    REPT: argCount(2, 2, (args, ctx) => {
      const t = text(args[0], ctx); const n = num(args[1], ctx);
      if (guard(t, n)) return guard(t, n);
      if (n < 0 || t.length * Math.trunc(n) > 32767) return err('#VALUE!');
      return t.repeat(Math.trunc(n));
    }),
    PROPER: argCount(1, 1, (args, ctx) => {
      const t = text(args[0], ctx);
      return guard(t) || t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    }),
    EXACT: argCount(2, 2, (args, ctx) => { const a = text(args[0], ctx); const b = text(args[1], ctx); return guard(a, b) || a === b; }),
    CHAR: argCount(1, 1, (args, ctx) => { const n = num(args[0], ctx); return guard(n) || (n < 1 || n > 255 ? err('#VALUE!') : String.fromCharCode(Math.trunc(n))); }),
    CODE: argCount(1, 1, (args, ctx) => { const t = text(args[0], ctx); return guard(t) || (t === '' ? err('#VALUE!') : t.charCodeAt(0)); }),
    CLEAN: argCount(1, 1, (args, ctx) => { const t = text(args[0], ctx); return guard(t) || t.replace(/[\u0000-\u001f]/g, ''); }),

    /* dates and times */
    DATE: argCount(3, 3, (args, ctx) => {
      let y = num(args[0], ctx); const m = num(args[1], ctx); const d = num(args[2], ctx);
      if (guard(y, m, d)) return guard(y, m, d);
      y = Math.trunc(y);
      if (y >= 0 && y < 1900) y += 1900;
      if (y < 1900 || y > 9999) return err('#NUM!');
      return serialOf(y, Math.trunc(m) - 1, Math.trunc(d));
    }),
    YEAR: argCount(1, 1, (args, ctx) => { const s = num(args[0], ctx); return guard(s) || (s < 0 ? err('#NUM!') : utcDate(s).getUTCFullYear()); }),
    MONTH: argCount(1, 1, (args, ctx) => { const s = num(args[0], ctx); return guard(s) || (s < 0 ? err('#NUM!') : utcDate(s).getUTCMonth() + 1); }),
    DAY: argCount(1, 1, (args, ctx) => { const s = num(args[0], ctx); return guard(s) || (s < 0 ? err('#NUM!') : utcDate(s).getUTCDate()); }),
    WEEKDAY: argCount(1, 2, (args, ctx) => {
      const s = num(args[0], ctx); const t = args[1] ? num(args[1], ctx) : 1;
      if (guard(s, t)) return guard(s, t);
      const d = utcDate(s).getUTCDay();
      if (t === 1) return d + 1;
      if (t === 2) return ((d + 6) % 7) + 1;
      if (t === 3) return (d + 6) % 7;
      return err('#NUM!');
    }),
    EDATE: argCount(2, 2, (args, ctx) => {
      const s = num(args[0], ctx); const m = num(args[1], ctx);
      if (guard(s, m)) return guard(s, m);
      const t = monthStart(s, Math.trunc(m));
      return serialOf(t.year, t.month, Math.min(t.day, new Date(Date.UTC(t.year, t.month + 1, 0)).getUTCDate()));
    }),
    EOMONTH: argCount(2, 2, (args, ctx) => {
      const s = num(args[0], ctx); const m = num(args[1], ctx);
      if (guard(s, m)) return guard(s, m);
      const t = monthStart(s, Math.trunc(m));
      return serialOf(t.year, t.month + 1, 0);
    }),
    DAYS: argCount(2, 2, (args, ctx) => { const e = num(args[0], ctx); const s = num(args[1], ctx); return guard(e, s) || Math.floor(e) - Math.floor(s); }),
    DATEDIF: argCount(3, 3, (args, ctx) => {
      const s = num(args[0], ctx); const e = num(args[1], ctx); const unit = text(args[2], ctx).toUpperCase();
      if (guard(s, e, unit)) return guard(s, e, unit);
      if (Math.floor(s) > Math.floor(e)) return err('#NUM!');
      const a = utcDate(s); const b = utcDate(e);
      let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
      if (b.getUTCDate() < a.getUTCDate()) months--;
      switch (unit) {
        case 'Y': return Math.floor(months / 12);
        case 'M': return months;
        case 'D': return Math.floor(e) - Math.floor(s);
        case 'YM': return months % 12;
        case 'MD': { const diff = b.getUTCDate() - a.getUTCDate(); return diff >= 0 ? diff : diff + new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate(); }
        case 'YD': {
          let from = Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
          if (from > b.getTime()) from = Date.UTC(b.getUTCFullYear() - 1, a.getUTCMonth(), a.getUTCDate());
          return Math.round((b.getTime() - from) / 86400000);
        }
        default: return err('#NUM!');
      }
    }),
    DATEVALUE: argCount(1, 1, (args, ctx) => {
      const t = text(args[0], ctx);
      if (guard(t)) return t;
      const p = U.parseUserInput(t.trim());
      return typeof p.value === 'number' && p.numFmt && U.isDateFormat(p.numFmt) ? Math.floor(p.value) : err('#VALUE!');
    }),
    HOUR: argCount(1, 1, (args, ctx) => { const s = num(args[0], ctx); return guard(s) || Math.floor(secondsOf(s) / 3600) % 24; }),
    MINUTE: argCount(1, 1, (args, ctx) => { const s = num(args[0], ctx); return guard(s) || Math.floor(secondsOf(s) / 60) % 60; }),
    SECOND: argCount(1, 1, (args, ctx) => { const s = num(args[0], ctx); return guard(s) || secondsOf(s) % 60; }),
    TIME: argCount(3, 3, (args, ctx) => {
      const h = num(args[0], ctx); const m = num(args[1], ctx); const s = num(args[2], ctx);
      if (guard(h, m, s)) return guard(h, m, s);
      const total = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
      return total < 0 ? err('#NUM!') : (total % 86400) / 86400;
    }),
  });

  /** A cell given one of these formulas gets a matching number format, as in Excel (e.g. =DATE(2024,5,1) shows a date, not 45413). */
  const RESULT_FORMATS = { DATE: 'yyyy-mm-dd', TODAY: 'yyyy-mm-dd', EDATE: 'yyyy-mm-dd', EOMONTH: 'yyyy-mm-dd', DATEVALUE: 'yyyy-mm-dd', NOW: 'yyyy-mm-dd hh:mm', TIME: 'hh:mm:ss' };
  function inferResultFormat(formula) {
    const m = /^\s*([A-Za-z.]+)\s*\(/.exec(formula);
    return (m && RESULT_FORMATS[m[1].toUpperCase()]) || null;
  }

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

  /* ---------- Helpers for editing formulas (point-and-click references, F4, function suggestions) ---------- */

  /** References inside formula text that is being typed (with its leading "="). Returns [] when it cannot be tokenised yet. */
  function findReferences(text) {
    if (!text.startsWith('=')) return [];
    try {
      return tokenize(text.slice(1)).filter((t) => t.type === 'ref').map((t) => ({ start: t.start + 1, end: t.end + 1, ref: t }));
    } catch (e) {
      return [];
    }
  }

  /** Excel's F4: A1 -> $A$1 -> A$1 -> $A1 -> A1 for the reference under the caret. Returns { text, selStart, selEnd } or null. */
  function cycleReference(text, caretStart, caretEnd) {
    const hit = findReferences(text).find((r) => r.ref.kind !== 'cols' && r.ref.kind !== 'rows' && caretStart >= r.start && caretEnd <= r.end);
    if (!hit) return null;
    const ref = { ...hit.ref, abs: { ...hit.ref.abs } };
    const a = ref.abs;
    const state = a.r1 && a.c1 ? 1 : a.r1 ? 2 : a.c1 ? 3 : 0; // 0 relative, 1 both fixed, 2 row fixed, 3 column fixed
    const next = (state + 1) % 4;
    const fixRow = next === 1 || next === 2; const fixCol = next === 1 || next === 3;
    a.r1 = fixRow; a.c1 = fixCol;
    if (ref.kind === 'area') { a.r2 = fixRow; a.c2 = fixCol; }
    const replacement = refToText(ref);
    return { text: text.slice(0, hit.start) + replacement + text.slice(hit.end), selStart: hit.start, selEnd: hit.start + replacement.length };
  }

  /** True when a cell reference could be typed (or pointed at) at the caret: right after "=", "(", ",", ";" or an operator. */
  function canInsertReference(text, caret) {
    if (!text.startsWith('=') || caret < 1) return false;
    const before = text.slice(0, caret).trimEnd();
    return before.length > 0 && /[=(,;+\-*/^&<>]$/.test(before);
  }

  /** The function name being typed at the caret, e.g. "=SU|" -> { prefix: 'SU', start: 1, end: 3 }, or null. */
  function functionPrefixAt(text, caret) {
    if (!text.startsWith('=')) return null;
    let start = caret;
    while (start > 1 && /[A-Za-z0-9_.]/.test(text[start - 1])) start--;
    const word = text.slice(start, caret);
    if (!word || !/^[A-Za-z]/.test(word) || /^[A-Za-z]{1,3}\d+$/.test(word)) return null;
    if (!canInsertReference(text, start) && start !== 1) return null;
    if (text[caret] === '(') return null; // the name is complete
    return { prefix: word, start, end: caret };
  }

  function suggestFunctions(prefix, limit) {
    const up = prefix.toUpperCase();
    return Object.keys(FUNCTIONS).filter((n) => n.startsWith(up)).sort().slice(0, limit || 8);
  }

  SheetApp.formula = {
    ERRORS, FUNCTION_NAMES: Object.keys(FUNCTIONS).sort(),
    FormulaSyntaxError, UnsupportedError,
    evaluate, checkSyntax, isError, compareValues, toText,
    findUnsupportedFunctions, shiftFormula, adjustForStructureChange,
    renameSheetInFormula, removeSheetFromFormula, quoteSheetName, inferResultFormat,
    findReferences, cycleReference, canInsertReference, functionPrefixAt, suggestFunctions,
  };
})(typeof window !== 'undefined' ? window : globalThis);
