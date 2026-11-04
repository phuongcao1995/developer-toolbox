// Run: node tests/unit/prettier-playground.test.mjs
import assert from 'node:assert/strict';
import * as L from '../../tools/prettier-playground/logic.js';
let pass = 0;
const test = (n, f) => { try { f(); pass++; } catch (e) { console.error('FAIL', n, '\n  ', e.message); process.exitCode = 1; } };

test('languages and ext mapping', () => {
  for (const [id, l] of Object.entries(L.LANGUAGES)) assert.ok(l.parser && l.plugins.length, id);
  assert.equal(L.LANGUAGES.yaml.parser, 'yaml'); assert.deepEqual(L.LANGUAGES.yaml.plugins, ['yaml']);
  assert.equal(L.LANGUAGES.graphql.parser, 'graphql'); assert.equal(L.LANGUAGES.handlebars.parser, 'glimmer');
  assert.equal(L.LANGUAGES.vue.parser, 'vue'); assert.ok(L.LANGUAGES.vue.plugins.includes('html'));
  assert.equal(L.detectLanguageByName('a.jsonc'), 'jsonc'); assert.equal(L.detectLanguageByName('a.json5'), 'json5');
  assert.equal(L.detectLanguageByName('a.yml'), 'yaml'); assert.equal(L.detectLanguageByName('a.gql'), 'graphql');
  assert.equal(L.detectLanguageByName('a.hbs'), 'handlebars'); assert.equal(L.detectLanguageByName('a.vue'), 'vue');
});
test('sanitize new options', () => {
  const o = L.sanitizeOptions({ quoteProps: 'nope', endOfLine: 'crlf', proseWrap: 'always', bracketSameLine: 1, htmlWhitespaceSensitivity: 'ignore', embeddedLanguageFormatting: 'off' });
  assert.equal(o.quoteProps, 'as-needed'); assert.equal(o.endOfLine, 'crlf'); assert.equal(o.proseWrap, 'always');
  assert.equal(o.bracketSameLine, true); assert.equal(o.htmlWhitespaceSensitivity, 'ignore'); assert.equal(o.embeddedLanguageFormatting, 'off');
  assert.ok(!('objectWrap' in o));
});
test('.prettierrc export/import round-trip', () => {
  const o = L.sanitizeOptions({ semi: false, singleQuote: true, printWidth: 100, tabWidth: 4, jsxSingleQuote: true });
  const { options, ignored } = L.parsePrettierrc(L.toPrettierrc(o));
  assert.deepEqual(options, o); assert.deepEqual(ignored, []);
});
test('.prettierrc import reports unknown/invalid, rejects bad json', () => {
  const r = L.parsePrettierrc('{"$schema":"x","semi":false,"foo":1,"endOfLine":"zzz","overrides":[]}');
  assert.equal(r.options.semi, false); assert.equal(r.options.endOfLine, 'lf');
  assert.equal(r.ignored.length, 3);
  assert.throws(() => L.parsePrettierrc('semi: false'), /Not valid JSON/);
  assert.throws(() => L.parsePrettierrc('[1]'), /JSON object/);
});
test('missing plugin error names plugin, version and URL', () => {
  assert.throws(() => L.resolvePlugins(['yaml'], { prettierPlugins: {} }),
    e => e.cdn && /"yaml"/.test(e.message) && e.message.includes('prettier@3.3.3') && e.message.includes('https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/yaml.js'));
  assert.deepEqual(L.resolvePlugins(['a'], { prettierPlugins: { a: 1 } }), [1]);
});
test('buildFormatOptions carries new options', () => {
  const o = L.buildFormatOptions('yaml', { proseWrap: 'never' }, []);
  assert.equal(o.parser, 'yaml'); assert.equal(o.proseWrap, 'never');
});
console.log(`prettier-playground: ${pass} passed`);
