// Run from repo root: node tests/unit/cron-generator.test.mjs
process.env.TZ = 'America/New_York'; // DST cases below rely on a zone with DST (set before any Date is used)
import assert from 'node:assert/strict';
import { parseCron, parseField, explain, nextRuns, composeField, FIELDS } from '../../tools/cron-generator/logic.js';

let pass = 0;
const t = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };
const dow = text => parseField(text, FIELDS[4]).values;
const ok = expr => { const p = parseCron(expr); assert.ok(p.ok, JSON.stringify(p.errors)); return p; };

t('dow 7 normalises to 0 everywhere', () => {
  assert.deepEqual(dow('7'), [0]);
  assert.deepEqual(dow('5-7'), [0, 5, 6]);
  assert.deepEqual(dow('7/2'), [0]);
  assert.deepEqual(dow('5/2'), [0, 5]);
  assert.deepEqual(dow('0,7'), [0]);
  assert.deepEqual(dow('1-7'), [0, 1, 2, 3, 4, 5, 6]);
});
t('*/2 unaffected', () => assert.deepEqual(dow('*/2'), [0, 2, 4, 6]));
t('other fields unaffected', () => {
  assert.deepEqual(parseField('*/20', FIELDS[0]).values, [0, 20, 40]);
  assert.deepEqual(parseField('31/2', FIELDS[2]).values, [31]);
  assert.deepEqual(parseField('1-10/3', FIELDS[1]).values, [1, 4, 7, 10]);
});
t('range errors still reported', () => {
  assert.throws(() => dow('8'), /out of range/);
  assert.throws(() => dow('6-5'), /backwards/);
});
t('explain never prints undefined', () => {
  for (const e of ['0 0 * * 7', '0 0 * * 7/2', '0 0 * * 5-7', '0 0 * * 5/2', '0 0 * * */2', '*/5 * * * 1-7', '0 0 1 1 7', '@weekly']) {
    const s = explain(ok(e));
    assert.ok(!/undefined|NaN/.test(s), `${e} -> ${s}`);
  }
  assert.match(explain(ok('0 0 * * 7')), /Sunday/);
});
t('Quartz extensions rejected with clear message', () => {
  for (const e of ['0 0 L * *', '0 0 15W * *', '0 0 ? * MON', '0 0 * * 5#2', '0 0 * * 5L', '0 0 LW * *']) {
    const p = parseCron(e);
    assert.equal(p.ok, false, e);
    assert.match(p.errors[0].message, /Quartz.*not supported.*5-field/s, e);
  }
});
t('names containing L/W are still fine', () => {
  ok('0 0 * JUL WED'); ok('0 0 * * MON-WED'); ok('0 0 * JAN-JUL *');
});
t('6/7 field expressions give a clear message', () => {
  for (const e of ['0 0 0 * * *', '0 0 0 * * * 2030']) {
    const p = parseCron(e);
    assert.equal(p.ok, false);
    assert.match(p.errors[0].message, /not supported.*5-field Vixie/s);
  }
  assert.match(parseCron('* * * *').errors[0].message, /Expected 5 fields/);
});
t('parseCron results never yield empty value sets', () => {
  for (const e of ['* * * * 7/2', '* * 31/5 * *', '0 0 * * 7']) for (const f of Object.values(ok(e).fields)) assert.ok(f.values.length > 0);
});
t('nextRuns: Sunday via 7 works', () => {
  const p = ok('0 9 * * 7');
  const { runs } = nextRuns(p, new Date('2025-01-01T00:00:00Z'), { count: 3, utc: true });
  assert.deepEqual(runs.map(d => d.getUTCDay()), [0, 0, 0]);
});
t('DST fall-back: sub-hourly jobs keep running in the repeated hour', () => {
  // 2025-11-02 01:00-01:59 occurs twice in New York.
  const from = new Date('2025-11-02T04:30:00Z'); // 00:30 EDT
  const { runs } = nextRuns(ok('*/15 * * * *'), from, { count: 12 });
  const keys = runs.map(d => d.toISOString());
  assert.equal(new Set(keys).size, 12);
  const gaps = runs.slice(1).map((d, i) => d - runs[i]);
  assert.ok(gaps.every(g => g === 15 * 60000), 'every 15 real minutes, none dropped: ' + gaps.join());
});
t('DST fall-back: fixed-time job runs once in the repeated hour', () => {
  const from = new Date('2025-11-02T04:00:00Z');
  const { runs } = nextRuns(ok('30 1 * * *'), from, { count: 2 });
  assert.equal(runs[0].toISOString(), '2025-11-02T05:30:00.000Z');
  assert.equal(runs[1].getDate(), 3); // next day, not the repeated 01:30 EST
});
t('regular scheduling unchanged', () => {
  const { runs } = nextRuns(ok('0 9 * * 1-5'), new Date('2025-01-03T20:00:00Z'), { count: 3, utc: true });
  assert.deepEqual(runs.map(d => d.toISOString()), ['2025-01-06T09:00:00.000Z', '2025-01-07T09:00:00.000Z', '2025-01-08T09:00:00.000Z']);
});
// 2025-03-09: New York clocks jump 02:00 EST -> 03:00 EDT (07:00Z); 02:00-02:59 does not exist.
const iso = r => r.runs.map(d => d.toISOString());
t('DST spring-forward: fixed-time job in the skipped hour runs once at the first valid instant after the gap', () => {
  const r = nextRuns(ok('30 2 * * *'), new Date('2025-03-09T05:00:00Z'), { count: 3 });
  assert.deepEqual(iso(r), ['2025-03-09T07:00:00.000Z', '2025-03-10T06:30:00.000Z', '2025-03-11T06:30:00.000Z']);
});
t('DST spring-forward: wildcard jobs get no catch-up run', () => {
  const r = nextRuns(ok('*/30 2 * * *'), new Date('2025-03-09T05:00:00Z'), { count: 2 });
  assert.equal(iso(r)[0], '2025-03-10T06:00:00.000Z');
  const h = nextRuns(ok('0 * * * *'), new Date('2025-03-09T05:30:00Z'), { count: 3 });
  assert.deepEqual(iso(h), ['2025-03-09T06:00:00.000Z', '2025-03-09T07:00:00.000Z', '2025-03-09T08:00:00.000Z']);
});
t('DST spring-forward: job after the gap and merged duplicates', () => {
  assert.equal(iso(nextRuns(ok('0 3 * * *'), new Date('2025-03-09T05:00:00Z'), { count: 1 }))[0], '2025-03-09T07:00:00.000Z');
  assert.deepEqual(iso(nextRuns(ok('0 2,3 * * *'), new Date('2025-03-09T05:00:00Z'), { count: 2 })), ['2025-03-09T07:00:00.000Z', '2025-03-10T06:00:00.000Z']);
  assert.deepEqual(iso(nextRuns(ok('30 2,3 * * *'), new Date('2025-03-09T05:00:00Z'), { count: 2 })), ['2025-03-09T07:00:00.000Z', '2025-03-09T07:30:00.000Z']);
});
t('DST spring-forward: day filters respected and other days unaffected', () => {
  assert.equal(iso(nextRuns(ok('30 2 * * 1'), new Date('2025-03-09T05:00:00Z'), { count: 1 }))[0], '2025-03-10T06:30:00.000Z'); // Monday, not the Sunday gap
  assert.equal(iso(nextRuns(ok('30 2 9 3 *'), new Date('2025-03-01T00:00:00Z'), { count: 1 }))[0], '2025-03-09T07:00:00.000Z');
  assert.deepEqual(iso(nextRuns(ok('30 2 * * *'), new Date('2025-03-01T05:00:00Z'), { count: 2 })), ['2025-03-01T07:30:00.000Z', '2025-03-02T07:30:00.000Z']);
});
t('UTC mode has no DST handling', () => {
  assert.equal(iso(nextRuns(ok('30 2 * * *'), new Date('2025-03-09T00:00:00Z'), { count: 1, utc: true }))[0], '2025-03-09T02:30:00.000Z');
});
t('builder: specific with no values is an error, not silently *', () => {
  assert.throws(() => composeField({ mode: 'specific', values: [] }, FIELDS[0]), /tick at least one value/);
  assert.equal(composeField({ mode: 'specific', values: [5, 1] }, FIELDS[0]), '1,5');
  assert.equal(composeField({ mode: 'every' }, FIELDS[0]), '*');
});
console.log(`${pass} tests passed`);
