// Run: node tests/unit/json-schema.test.mjs
import assert from 'node:assert/strict';
import { validate, pointerToSegments, deepEqual } from '../../assets/js/shared/json-schema.js';

let pass = 0;
const test = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };
const ok = (s, d) => { const r = validate(s, d); assert.equal(r.valid, true, JSON.stringify(r.errors)); return r; };
const bad = (s, d, keyword, path) => {
  const r = validate(s, d);
  assert.equal(r.valid, false, 'expected invalid: ' + JSON.stringify(d));
  const e = r.errors.find(x => x.keyword === keyword && (path === undefined || x.path === path));
  assert.ok(e, `no ${keyword} error at ${path} in ${JSON.stringify(r.errors)}`);
  assert.equal(typeof e.message, 'string');
  return r;
};

test('type: single, array of types, integer', () => {
  ok({ type: 'string' }, 'a'); bad({ type: 'string' }, 1, 'type', '');
  ok({ type: ['string', 'null'] }, null); bad({ type: ['string', 'null'] }, 1, 'type');
  ok({ type: 'integer' }, 3); ok({ type: 'integer' }, 3.0); bad({ type: 'integer' }, 3.5, 'type');
  ok({ type: 'number' }, 3); bad({ type: 'number' }, '3', 'type');
  ok({ type: 'array' }, []); bad({ type: 'object' }, [], 'type'); ok({ type: 'boolean' }, false); ok({ type: 'null' }, null);
});
test('enum and const (deep equality, key order independent)', () => {
  ok({ enum: [1, 'a', { x: [1, 2], y: 1 }] }, { y: 1, x: [1, 2] });
  bad({ enum: [1, 2] }, 3, 'enum');
  ok({ const: { a: 1 } }, { a: 1 }); bad({ const: { a: 1 } }, { a: 2 }, 'const');
  assert.equal(deepEqual([1, { a: 2 }], [1, { a: 2 }]), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
});
test('object keywords: properties, required, additionalProperties', () => {
  const s = { properties: { a: { type: 'integer' }, b: { type: 'string' } }, required: ['a'], additionalProperties: false };
  ok(s, { a: 1 }); ok(s, { a: 1, b: 'x' });
  bad(s, { b: 'x' }, 'required', '');
  bad(s, { a: 'x' }, 'type', '/a');
  bad(s, { a: 1, c: 2 }, 'additionalProperties', '/c');
  ok({ additionalProperties: { type: 'number' } }, { x: 1 }); bad({ additionalProperties: { type: 'number' } }, { x: 's' }, 'type', '/x');
});
test('patternProperties, propertyNames, min/maxProperties, dependentRequired', () => {
  const s = { patternProperties: { '^x-': { type: 'number' } }, additionalProperties: false };
  ok(s, { 'x-a': 1 }); bad(s, { 'x-a': 's' }, 'type', '/x-a'); bad(s, { y: 1 }, 'additionalProperties', '/y');
  bad({ propertyNames: { pattern: '^[a-z]+$' } }, { Ab: 1 }, 'propertyNames');
  bad({ minProperties: 2 }, { a: 1 }, 'minProperties'); bad({ maxProperties: 1 }, { a: 1, b: 2 }, 'maxProperties');
  bad({ dependentRequired: { a: ['b'] } }, { a: 1 }, 'dependentRequired'); ok({ dependentRequired: { a: ['b'] } }, { c: 1 });
  bad({ dependencies: { a: ['b'] } }, { a: 1 }, 'dependentRequired');
  bad({ dependentSchemas: { a: { required: ['z'] } } }, { a: 1 }, 'required');
});
test('JSON pointer escaping in error paths', () => {
  const r = bad({ properties: { 'a/b': { type: 'string' }, 'm~n': { type: 'string' } } }, { 'a/b': 1, 'm~n': 2 }, 'type', '/a~1b');
  assert.ok(r.errors.some(e => e.path === '/m~0n'));
  assert.deepEqual(pointerToSegments('/a~1b/0/m~0n'), ['a/b', '0', 'm~n']);
  assert.deepEqual(pointerToSegments(''), []);
});
test('arrays: items schema, tuple, prefixItems, additionalItems', () => {
  bad({ items: { type: 'number' } }, [1, 'a'], 'type', '/1');
  const tuple = { items: [{ type: 'number' }, { type: 'string' }], additionalItems: false };
  ok(tuple, [1, 'a']); bad(tuple, ['a', 'a'], 'type', '/0'); bad(tuple, [1, 'a', 3], 'additionalItems', undefined);
  const pre = { prefixItems: [{ type: 'number' }], items: { type: 'string' } };
  ok(pre, [1, 'a', 'b']); bad(pre, [1, 2], 'type', '/1');
  ok({ prefixItems: [{ type: 'number' }] }, [1, 'anything']);
});
test('minItems, maxItems, uniqueItems, contains, minContains/maxContains', () => {
  bad({ minItems: 2 }, [1], 'minItems'); bad({ maxItems: 1 }, [1, 2], 'maxItems');
  ok({ uniqueItems: true }, [1, '1', { a: 1 }, { a: 2 }]);
  bad({ uniqueItems: true }, [1, 2, 1], 'uniqueItems'); bad({ uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }], 'uniqueItems');
  ok({ contains: { type: 'string' } }, [1, 'a']); bad({ contains: { type: 'string' } }, [1, 2], 'contains');
  bad({ contains: { type: 'string' }, minContains: 2 }, ['a', 1], 'contains');
  bad({ contains: { type: 'string' }, maxContains: 1 }, ['a', 'b'], 'maxContains');
});
test('numbers: min/max/exclusive/multipleOf', () => {
  bad({ minimum: 5 }, 4, 'minimum'); ok({ minimum: 5 }, 5);
  bad({ maximum: 5 }, 6, 'maximum'); ok({ maximum: 5 }, 5);
  bad({ exclusiveMinimum: 5 }, 5, 'exclusiveMinimum'); ok({ exclusiveMinimum: 5 }, 5.1);
  bad({ exclusiveMaximum: 5 }, 5, 'exclusiveMaximum');
  bad({ minimum: 5, exclusiveMinimum: true }, 5, 'minimum'); // draft-04 boolean form
  ok({ multipleOf: 0.1 }, 0.3); ok({ multipleOf: 5 }, 15); bad({ multipleOf: 5 }, 12, 'multipleOf');
  ok({ minimum: 5 }, 'not a number'); // keyword applies to numbers only
});
test('strings: length (code points), pattern', () => {
  bad({ minLength: 3 }, 'ab', 'minLength'); bad({ maxLength: 2 }, 'abc', 'maxLength');
  ok({ maxLength: 1 }, '\u{1F600}'); // one code point
  ok({ pattern: '^a+$' }, 'aaa'); bad({ pattern: '^a+$' }, 'ab', 'pattern');
});
test('invalid regex in pattern is reported, not thrown', () => {
  const r = validate({ pattern: '(' }, 'x');
  assert.equal(r.valid, false);
  assert.match(r.errors[0].message, /Invalid regular expression/);
  const r2 = validate({ patternProperties: { '[': {} } }, { a: 1 });
  assert.ok(r2.errors.some(e => /Invalid regular expression/.test(e.message)));
});
test('formats', () => {
  const f = (format, good, badv) => { ok({ format }, good); bad({ format }, badv, 'format'); };
  f('email', 'a.b@example.com', 'not-an-email'); f('email', 'x+y@sub.example.org', 'a@b');
  f('uri', 'https://example.com/a?b=1', 'no scheme'); f('date', '2024-02-29', '2023-02-29'); f('date', '2024-12-31', '2024-13-01');
  f('date-time', '2024-05-01T12:30:00Z', '2024-05-01 12:30'); f('date-time', '2024-05-01T12:30:00.123+02:00', '2024-05-01T25:00:00Z');
  f('uuid', '123e4567-e89b-12d3-a456-426614174000', '123e4567'); f('ipv4', '192.168.0.1', '256.1.1.1'); f('ipv4', '0.0.0.0', '1.2.3');
  f('ipv6', '2001:db8::1', '2001:::1'); f('ipv6', '::1', '12345::1'); ok({ format: 'ipv6' }, '::ffff:192.0.2.1'); ok({ format: 'email' }, 5); // non-strings ignored
});
test('allOf / anyOf / oneOf / not', () => {
  const all = { allOf: [{ type: 'number' }, { minimum: 3 }] }; ok(all, 5); bad(all, 1, 'minimum');
  const any = { anyOf: [{ type: 'string' }, { type: 'number' }] }; ok(any, 1); bad(any, null, 'anyOf');
  const one = { oneOf: [{ type: 'number' }, { minimum: 3 }] }; ok(one, 'a'.length === 1 ? 2 : 0);
  bad(one, 5, 'oneOf'); // matches both
  bad({ oneOf: [{ type: 'string' }, { type: 'array' }] }, 1, 'oneOf'); // matches none
  bad({ not: { type: 'string' } }, 'a', 'not'); ok({ not: { type: 'string' } }, 1);
});
test('if / then / else', () => {
  const s = { if: { properties: { k: { const: 'a' } }, required: ['k'] }, then: { required: ['x'] }, else: { required: ['y'] } };
  ok(s, { k: 'a', x: 1 }); bad(s, { k: 'a' }, 'required'); ok(s, { k: 'b', y: 1 }); bad(s, { k: 'b' }, 'required');
  ok({ if: { type: 'string' }, then: { minLength: 2 } }, 5);
});
test('boolean schemas', () => {
  ok(true, 1); bad(false, 1, 'false schema'); ok({ properties: { a: true } }, { a: 1 }); bad({ properties: { a: false } }, { a: 1 }, 'false schema', '/a');
});
test('$ref: definitions, $defs, nested, root recursion', () => {
  const s = { definitions: { pos: { type: 'integer', minimum: 1 } }, properties: { a: { $ref: '#/definitions/pos' } } };
  ok(s, { a: 2 }); bad(s, { a: 0 }, 'minimum', '/a'); bad(s, { a: 'x' }, 'type', '/a');
  const d = { $defs: { s: { type: 'string' } }, items: { $ref: '#/$defs/s' } }; ok(d, ['a']); bad(d, [1], 'type', '/0');
  const tree = { type: 'object', properties: { v: { type: 'number' }, kids: { type: 'array', items: { $ref: '#' } } } };
  ok(tree, { v: 1, kids: [{ v: 2, kids: [] }] }); bad(tree, { kids: [{ v: 'x' }] }, 'type', '/kids/0/v');
  const esc = { definitions: { 'a/b': { type: 'string' } }, $ref: '#/definitions/a~1b' }; ok(esc, 'x'); bad(esc, 1, 'type');
});
test('$ref cycles are detected, not infinite', () => {
  const r = validate({ $ref: '#' }, 1);
  assert.equal(r.valid, false); assert.match(r.errors[0].message, /Circular/);
  const r2 = validate({ definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/a' } }, $ref: '#/definitions/a' }, 1);
  assert.equal(r2.valid, false);
  const r3 = validate({ allOf: [{ $ref: '#' }] }, 1);
  assert.equal(r3.valid, false);
});
test('unresolvable and remote $ref are reported as not checked', () => {
  const r = validate({ properties: { a: { $ref: 'https://example.com/s.json' }, b: { $ref: '#/definitions/missing' } } }, { a: 1, b: 2 });
  assert.equal(r.valid, true);
  assert.equal(r.notChecked.filter(n => n.keyword === '$ref').length, 2);
  assert.ok(r.notChecked.some(n => /remote/.test(n.reason)) && r.notChecked.some(n => /unresolvable/.test(n.reason)));
});
test('unsupported keywords and unknown formats are never silently passed', () => {
  const r = validate({ properties: { a: { $dynamicRef: '#x', unevaluatedProperties: false, format: 'hostname' } }, $anchor: 'top', madeUp: 1, 'x-ext': 2 }, { a: 1 });
  const kws = r.notChecked.map(n => n.keyword).sort();
  for (const k of ['$dynamicRef', 'unevaluatedProperties', '$anchor', 'madeUp', 'format']) assert.ok(kws.includes(k), k);
  assert.ok(!kws.includes('x-ext'));
  const f = validate({ format: 'hostname' }, 'a_b');
  assert.equal(f.valid, true); assert.equal(f.notChecked[0].keyword, 'format');
  assert.equal(validate({ title: 'T', description: 'D', default: 1, examples: [1], $schema: 'x', $id: 'y', $comment: 'c' }, 1).notChecked.length, 0);
});
test('error shape and schemaPath', () => {
  const r = validate({ properties: { a: { type: 'string' } } }, { a: 1 });
  assert.deepEqual(Object.keys(r.errors[0]).sort(), ['keyword', 'message', 'path', 'schemaPath']);
  assert.equal(r.errors[0].schemaPath, '#/properties/a/type');
});
test('error cap and robustness', () => {
  const r = validate({ items: { type: 'string' } }, Array.from({ length: 5000 }, () => 1));
  assert.equal(r.errors.length, 1000); assert.equal(r.truncated, true);
  assert.equal(validate(5, 1).valid, true); // non-object schema: reported, no crash
  assert.ok(validate(5, 1).notChecked.length > 0);
  let s = { type: 'string' }; for (let i = 0; i < 500; i++) s = { allOf: [s] };
  assert.equal(validate(s, 1).valid, false); // depth guard produces an error instead of overflow
});

console.log(`json-schema: ${pass} passed`);
