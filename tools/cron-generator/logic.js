// Pure cron parsing / explaining / scheduling logic (5-field standard cron, no DOM).

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Field specs. `max` is the highest accepted input value; `top` the highest real value
 * (day-of-week accepts 7 as an alias of 0). `names` maps abbreviations to numbers.
 */
export const FIELDS = [
  { key: 'minute', label: 'Minute', min: 0, max: 59, top: 59, unit: 'minute' },
  { key: 'hour', label: 'Hour', min: 0, max: 23, top: 23, unit: 'hour' },
  { key: 'dom', label: 'Day of month', min: 1, max: 31, top: 31, unit: 'day-of-month', plural: 'days' },
  { key: 'month', label: 'Month', min: 1, max: 12, top: 12, unit: 'month', names: Object.fromEntries(MONTHS.map((n, i) => [n, i + 1])) },
  { key: 'dow', label: 'Day of week', min: 0, max: 7, top: 6, unit: 'day-of-week', plural: 'days of the week', names: Object.fromEntries(DAYS.map((n, i) => [n, i])) },
];

export const ALIASES = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

/** Parse one numeric/named token; throws Error with a precise message. */
function parseValue(tok, spec) {
  let v;
  if (/^\d+$/.test(tok)) v = Number(tok);
  else if (spec.names && spec.names[tok.toUpperCase()] !== undefined) v = spec.names[tok.toUpperCase()];
  else {
    const hint = spec.names ? `a number ${spec.min}-${spec.max} or a name like ${Object.keys(spec.names).slice(0, 3).join('/')}` : `a number ${spec.min}-${spec.max}`;
    throw new Error(`"${tok}" is not a valid ${spec.label.toLowerCase()} value (expected ${hint}).`);
  }
  if (v < spec.min || v > spec.max) throw new Error(`${v} is out of range for ${spec.label.toLowerCase()} (allowed ${spec.min}-${spec.max}).`);
  return v;
}

/**
 * Parse a single field (e.g. "*\/5", "1-5", "MON,WED", "10-30/5").
 * Returns { text, values (sorted unique, dow 7 -> 0), items, star (starts with "*") }.
 * Throws Error with a field-specific message.
 */
export function parseField(text, spec) {
  if (text === '') throw new Error('is empty.');
  const set = new Set(), items = [];
  for (const raw of text.split(',')) {
    if (raw === '') throw new Error('contains an empty list item (check for a stray comma).');
    const [base, stepTxt, extra] = raw.split('/');
    if (extra !== undefined) throw new Error(`"${raw}" has more than one "/" step.`);
    let step = 1;
    if (stepTxt !== undefined) {
      if (!/^\d+$/.test(stepTxt)) throw new Error(`step "${stepTxt}" in "${raw}" must be a positive whole number.`);
      step = Number(stepTxt);
      if (step < 1) throw new Error(`step in "${raw}" must be at least 1.`);
      if (step > spec.top - spec.min + 1) throw new Error(`step ${step} in "${raw}" is larger than the field range (${spec.min}-${spec.top}).`);
    }
    let lo, hi, type;
    if (base === '*') { lo = spec.min; hi = spec.top; type = 'star'; }
    else if (base.includes('-')) {
      const parts = base.split('-');
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') throw new Error(`range "${base}" is malformed (use start-end, e.g. 1-5).`);
      lo = parseValue(parts[0], spec); hi = parseValue(parts[1], spec); type = 'range';
      if (lo > hi) throw new Error(`range "${base}" is backwards: start ${lo} is greater than end ${hi}.`);
    } else {
      lo = parseValue(base, spec); type = 'single';
      hi = stepTxt !== undefined ? spec.top : lo; // "5/10" means 5-max/10
    }
    for (let v = lo; v <= hi; v += step) set.add(spec.key === 'dow' && v === 7 ? 0 : v);
    items.push({ type, lo, hi, step, hasStep: stepTxt !== undefined });
  }
  return { text, values: [...set].sort((a, b) => a - b), items, star: text.startsWith('*') };
}

/**
 * Parse a full expression. Returns
 *  { ok:true, expr, fields:{minute,hour,dom,month,dow}, alias } or
 *  { ok:false, errors:[{field, message}] } (every bad field is reported).
 */
export function parseCron(input) {
  let expr = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!expr) return { ok: false, errors: [{ field: null, message: 'Enter a cron expression (5 fields: minute hour day-of-month month day-of-week).' }] };
  let alias = null;
  if (expr.startsWith('@')) {
    const a = ALIASES[expr.toLowerCase()];
    if (!a) return { ok: false, errors: [{ field: null, message: `Unknown alias "${expr}". Supported: ${Object.keys(ALIASES).join(', ')}.` }] };
    alias = expr; expr = a;
  }
  const parts = expr.split(' ');
  if (parts.length !== 5) {
    const extra = parts.length === 6 ? ' (6-field cron with seconds is not supported; remove the seconds field)' : '';
    return { ok: false, errors: [{ field: null, message: `Expected 5 fields (minute hour day-of-month month day-of-week) but found ${parts.length}${extra}.` }] };
  }
  const fields = {}, errors = [];
  FIELDS.forEach((spec, i) => {
    try { fields[spec.key] = parseField(parts[i], spec); }
    catch (e) { errors.push({ field: spec.key, message: `${spec.label} field: ${e.message}` }); }
  });
  return errors.length ? { ok: false, errors } : { ok: true, expr, fields, alias };
}

// ---------------------------------------------------------------- explanation

const pad = n => String(n).padStart(2, '0');
const joinAnd = arr => arr.length <= 1 ? (arr[0] ?? '') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

/** Compress sorted values into runs; runs of 3+ become "a through b". */
function formatValues(values, fmt = String) {
  const parts = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    if (j - i >= 2) parts.push(`${fmt(values[i])} through ${fmt(values[j])}`);
    else for (let k = i; k <= j; k++) parts.push(fmt(values[k]));
    i = j + 1;
  }
  return joinAnd(parts);
}

/** "Every 15 minutes" style description for a single stepped item, else null. */
function stepPhrase(f, spec, fmt = String) {
  if (f.items.length !== 1 || !f.items[0].hasStep || f.items[0].step === 1) return null;
  const { type, lo, hi, step } = f.items[0];
  const unit = spec.plural || spec.unit + 's';
  if (type === 'star') return `every ${step} ${unit}`;
  return `every ${step} ${unit} from ${fmt(lo)} through ${fmt(hi)}`;
}

const total = spec => spec.top - spec.min + 1;
const isAll = (f, spec) => f.values.length === total(spec);

/** Human-readable explanation of a parsed expression (result of parseCron with ok:true). */
export function explain(parsed) {
  const { minute: mi, hour: hr, dom, month, dow } = parsed.fields;
  const [sMin, sHr, sDom, sMonth, sDow] = FIELDS;
  const hh = h => pad(h);
  const minAll = isAll(mi, sMin), hrAll = isAll(hr, sHr);
  const minStep = stepPhrase(mi, sMin), hrStep = stepPhrase(hr, sHr, hh);
  const minSingle = mi.values.length === 1 && !minStep;

  // "between 09:00 and 17:59" windows for hour sets made of contiguous runs
  const hourWindows = () => {
    const runs = []; const v = hr.values;
    for (let i = 0; i < v.length;) {
      let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
      runs.push(`between ${hh(v[i])}:00 and ${hh(v[j])}:59`); i = j + 1;
    }
    return joinAnd(runs);
  };
  const hourPart = () => hrStep ? `past ${hrStep}` : hourWindows();

  let time;
  if (minAll && hrAll) time = 'Every minute';
  else if (minSingle && hrAll) time = mi.values[0] === 0 ? 'Every hour' : `At minute ${mi.values[0]} past every hour`;
  else if (minSingle && hr.values.length * 1 <= 6 && !hrStep) time = 'At ' + joinAnd(hr.values.map(h => `${hh(h)}:${pad(mi.values[0])}`));
  else if (minSingle && hrStep && mi.values[0] === 0) time = hrStep[0].toUpperCase() + hrStep.slice(1);
  else if (minSingle) time = `At minute ${mi.values[0]} past ${hrStep || (hr.values.length > 1 ? 'hours ' : 'hour ') + formatValues(hr.values)}`;
  else {
    const minDesc = minAll ? 'Every minute'
      : minStep ? 'Every' + minStep.slice(5) // "every 15 minutes" -> "Every 15 minutes"
        : `At minute${mi.values.length > 1 ? 's' : ''} ${formatValues(mi.values)}`;
    time = hrAll ? (minAll || minStep ? minDesc : `${minDesc} past every hour`) : `${minDesc}, ${hourPart()}`;
  }

  // Day part: standard cron ORs day-of-month and day-of-week when both are restricted (neither begins with "*").
  const domAll = isAll(dom, sDom), dowAll = isAll(dow, sDow);
  const domTxt = domAll ? '' : (stepPhrase(dom, sDom) || `day-of-month ${formatValues(dom.values)}`);
  const dowTxt = dowAll ? '' : (stepPhrase(dow, sDow, d => DAY_NAMES[d]) || formatValues(dow.values, d => DAY_NAMES[d]));
  let date = '';
  if (domTxt && dowTxt) date = `on ${domTxt} ${!dom.star && !dow.star ? 'or' : 'and'} on ${dowTxt}`;
  else if (domTxt) date = `on ${domTxt}`;
  else if (dowTxt) date = `on ${dowTxt}`;

  const monthTxt = isAll(month, sMonth) ? '' : 'in ' + (stepPhrase(month, sMonth, m => MONTH_NAMES[m - 1]) || formatValues(month.values, m => MONTH_NAMES[m - 1]));
  return [time, date, monthTxt].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- scheduling

/** Does a day (dom 1-31, dow 0-6) satisfy the day fields under Vixie-cron semantics? */
function dayMatches(f, d, wd) {
  const a = f.dom.values.includes(d), b = f.dow.values.includes(wd);
  // If either field starts with "*" both must match (AND); otherwise either may match (OR).
  return (f.dom.star || f.dow.star) ? (a && b) : (a || b);
}

/**
 * Next run times strictly after `from`.
 * opts: { count=10, utc=false, horizonYears=10 }.
 * Skips whole months/days/hours that cannot match instead of scanning every minute.
 * Returns { runs: Date[], exhausted: boolean } (exhausted = fewer than `count` found within the horizon).
 */
export function nextRuns(parsed, from = new Date(), { count = 10, utc = false, horizonYears = 10 } = {}) {
  const f = parsed.fields;
  const get = d => utc
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() }
    : { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), wd: d.getDay() };
  // Date constructor normalises overflow (month 13, day 32, hour 24...).
  const make = (y, mo, d, h, mi) => utc ? new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0)) : new Date(y, mo - 1, d, h, mi, 0, 0);
  const nextIn = (vals, x) => vals.find(v => v >= x);

  let t = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  const limit = from.getTime() + horizonYears * 366 * 86400000;
  const runs = []; let lastKey = '';
  let guard = 0;
  while (runs.length < count && t.getTime() <= limit && guard++ < 200000) {
    const p = get(t);
    let next = null;
    if (!f.month.values.includes(p.mo)) {
      const m = nextIn(f.month.values, p.mo);
      next = m !== undefined ? make(p.y, m, 1, 0, 0) : make(p.y + 1, f.month.values[0], 1, 0, 0);
    } else if (!dayMatches(f, p.d, p.wd)) {
      next = make(p.y, p.mo, p.d + 1, 0, 0);
    } else if (!f.hour.values.includes(p.h)) {
      const h = nextIn(f.hour.values, p.h);
      next = h !== undefined ? make(p.y, p.mo, p.d, h, 0) : make(p.y, p.mo, p.d + 1, 0, 0);
    } else if (!f.minute.values.includes(p.mi)) {
      const m = nextIn(f.minute.values, p.mi);
      next = m !== undefined ? make(p.y, p.mo, p.d, p.h, m) : make(p.y, p.mo, p.d, p.h + 1, 0);
    } else {
      const key = `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}`;
      if (key !== lastKey) runs.push(new Date(t)); // key check avoids a double run in repeated DST hours
      lastKey = key;
      next = new Date(t.getTime() + 60000);
    }
    // Guarantee forward progress (DST gaps can normalise a candidate backwards).
    t = next.getTime() > t.getTime() ? next : new Date(t.getTime() + 60000);
  }
  return { runs, exhausted: runs.length < count };
}

/** Format a run time as e.g. "Mon, 06 Jan 2025, 09:00 GMT+1" (local) or "... UTC". */
export function formatRun(date, utc = false) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'short', ...(utc ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

// ---------------------------------------------------------------- builder helpers

/**
 * Describe how a field's text maps to a builder mode:
 * { mode:'every'|'specific'|'range'|'step', values, from, to, step, start }.
 */
export function detectMode(f, spec) {
  const out = { mode: 'specific', values: f.values.slice(), from: spec.min, to: spec.top, step: 5, start: spec.min };
  if (isAll(f, spec) && f.items.every(i => !i.hasStep || i.step === 1)) { out.mode = 'every'; return out; }
  if (f.items.length === 1) {
    const it = f.items[0];
    if (it.hasStep && it.step > 1 && (it.type === 'star' || it.type === 'single' || (it.type === 'range' && it.hi === spec.top))) {
      return { ...out, mode: 'step', step: it.step, start: it.lo };
    }
    if (it.type === 'range' && !it.hasStep) return { ...out, mode: 'range', from: it.lo, to: it.hi };
  }
  return out;
}

/** Compose field text from builder state; throws Error for invalid input. */
export function composeField(state, spec) {
  switch (state.mode) {
    case 'every': return '*';
    case 'specific': {
      const v = [...new Set(state.values)].sort((a, b) => a - b);
      return v.length === 0 || v.length === total(spec) ? '*' : v.join(',');
    }
    case 'range':
      if (state.from > state.to) throw new Error(`${spec.label}: range start must not exceed the end.`);
      return `${state.from}-${state.to}`;
    case 'step':
      if (!(state.step >= 1)) throw new Error(`${spec.label}: step must be at least 1.`);
      return state.start === spec.min ? `*/${state.step}` : `${state.start}-${spec.top}/${state.step}`;
    default: throw new Error('Unknown mode');
  }
}

export const PRESETS = [
  ['Every minute', '* * * * *'],
  ['Every 5 minutes', '*/5 * * * *'],
  ['Every 15 minutes', '*/15 * * * *'],
  ['Every hour', '0 * * * *'],
  ['Every 6 hours', '0 */6 * * *'],
  ['Daily at midnight', '0 0 * * *'],
  ['Daily at 09:30', '30 9 * * *'],
  ['Weekdays at 09:00', '0 9 * * 1-5'],
  ['Weekends at 10:00', '0 10 * * 6,0'],
  ['Mondays at 08:00', '0 8 * * MON'],
  ['Business hours, every 30 min', '*/30 9-17 * * 1-5'],
  ['1st of month', '0 0 1 * *'],
  ['Quarterly', '0 0 1 1,4,7,10 *'],
  ['Every year (Jan 1)', '@yearly'],
];
