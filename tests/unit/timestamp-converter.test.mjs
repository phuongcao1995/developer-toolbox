// Run: node tests/unit/timestamp-converter.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/timestamp-converter/logic.js';
let pass = 0;
const test = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };

test('seconds / ms / us / ns exact', () => {
  assert.equal(L.unixToDate('1700000000', 's').ms, 1700000000000);
  const r = L.unixToDate('1700000000123456789', 'ns');
  assert.equal(r.ns, 1700000000123456789n); assert.equal(r.us, 1700000000123456n); assert.equal(r.ms, 1700000000123);
  assert.equal(L.isoFromNs(r.ns), '2023-11-14T22:13:20.123456789Z');
  assert.equal(L.unixToDate('1700000000.5', 's').ns, 1700000000500000000n);
});
test('negative values floor correctly', () => {
  const r = L.unixToDate('-1.5', 's'); assert.equal(r.ms, -1500); assert.equal(L.isoFromNs(r.ns), '1969-12-31T23:59:58.500000000Z');
  assert.equal(L.unixToDate('-1', 'ms').ms, -1);
});
test('auto detect units', () => {
  assert.equal(L.unixToDate('1700000000000').unit, 'ms');
  assert.equal(L.unixToDate('1700000000000000').unit, 'us');
  assert.equal(L.unixToDate('1700000000000000000').unit, 'ns');
});
test('ambiguity hint 1e8..1e11 only in auto', () => {
  assert.deepEqual(L.unixToDate('1700000000').ambiguity, { assumed: 's', alternative: 'ms' });
  assert.equal(L.unixToDate('1700000000', 'ms').ambiguity, null);
  assert.equal(L.unixToDate('1700000000000').ambiguity, null);
  assert.equal(L.unixToDate('99999999').ambiguity, null);
});
test('range & bad input', () => {
  assert.throws(() => L.unixToDate('99999999999999999999', 's'), /after year 9999/);
  assert.throws(() => L.unixToDate('-99999999999999999999', 's'), /before year 0001/);
  assert.throws(() => L.unixToDate('12abc'), /Not a number/);
});
test('iso + zone parse still works', () => {
  assert.equal(L.parseIso('2023-11-14T22:13:20Z').seconds, 1700000000);
  assert.equal(L.fieldsToUnix({ year: 2023, month: 11, day: 14, hour: 17, minute: 13, second: 20 }, 'America/New_York').seconds, 1700000000);
});
console.log(`timestamp-converter: ${pass} passed`);
