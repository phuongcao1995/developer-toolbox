// Run: node tests/unit/uuid-generator.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as L from '../../tools/uuid-generator/logic.js';
import { searchStatus, countByCategory, STATUS_CODES } from '../../tools/http-status-reference/data.js';
let pass = 0;
const test = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };

test('v7 layout (RFC 9562 5.7)', () => {
  const ms = 0x017f22e279b0; // example timestamp from RFC 9562 A.6
  const u = L.uuidV7FromParts(ms, 0xcc3, new Uint8Array([0x18, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f]));
  assert.equal(u, '017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('v7 variant bits forced even for bad rand_b', () => {
  const u = L.uuidV7FromParts(1, 0, new Uint8Array(8).fill(0xff));
  assert.equal(u[19], 'b');
});
test('v7 monotonic within one millisecond and across clock rollback', () => {
  const next = L.createV7Generator(webcrypto, () => 1700000000000);
  const ids = Array.from({ length: 5000 }, next);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], `order at ${i}`);
  assert.equal(new Set(ids).size, ids.length);
  let t = 5000; const g = L.createV7Generator(webcrypto, () => t);
  const a = g(); t = 4000; const b = g(); // clock went backwards
  assert.ok(b > a);
});
test('v7 increases across milliseconds', () => {
  let t = 1000; const g = L.createV7Generator(webcrypto, () => t);
  const a = g(); t = 1001; const b = g(); assert.ok(b > a);
  assert.equal(L.v7Timestamp(b).ms, 1001);
});
test('generateMany v7 sorted, v4 unchanged', () => {
  const v7 = L.generateMany(100, {}, webcrypto, { version: 7 });
  assert.deepEqual([...v7].sort(), v7);
  assert.equal(L.inspectUuid(v7[0]).version, 7);
  assert.match(L.generateMany(1, {}, webcrypto)[0], /^[0-9a-f-]{36}$/);
  assert.equal(L.inspectUuid(L.generateMany(1, {}, webcrypto)[0]).version, 4);
});
test('inspector shows v7 timestamp; nil/max constants', () => {
  const r = L.inspectUuid('017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
  assert.equal(r.timestamp.ms, 0x017f22e279b0); assert.equal(r.timestamp.iso, '2022-02-22T19:22:22.000Z');
  assert.equal(L.inspectUuid(L.MAX_UUID).max, true); assert.equal(L.inspectUuid(L.NIL_UUID).nil, true);
  assert.equal(L.inspectUuid(L.MAX_UUID).timestamp, null);
  assert.equal(L.inspectUuid(L.generateMany(1, {}, webcrypto)[0]).timestamp, null);
});
test('http: "4xx" search count equals the 4xx chip count', () => {
  const c = countByCategory();
  assert.equal(searchStatus('4xx', 'all').length, c['4xx']);
  assert.equal(searchStatus('', '4xx').length, c['4xx']);
  assert.equal(searchStatus('5xx', 'all').length, c['5xx']);
  assert.equal(c.unofficial, STATUS_CODES.filter(s => s.unofficial).length);
  assert.equal(['1xx', '2xx', '3xx', '4xx', '5xx'].reduce((n, k) => n + c[k], 0), STATUS_CODES.length);
});
console.log(`uuid-generator/http-status: ${pass} passed`);
