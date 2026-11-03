/*
 * run-tests.js — tests for the cryptographic and encoding modules.
 * Run with:  node tests/run-tests.js   (Node 20+; uses Node's built-in Web Crypto)
 * Expected values come from published test vectors (RFC 1321, FIPS 180 examples,
 * RFC 4648) and are cross-checked against Node's independent `node:crypto`.
 */
'use strict';
const path = require('path');
const nodeCrypto = require('crypto');

for (const f of ['core', 'encoding', 'md5', 'hash', 'generator', 'password', 'encryption', 'keycipher']) {
  require(path.join(__dirname, '..', 'lib', `${f}.js`));
}
const { encoding: enc, hash, password, encryption, generator } = globalThis.Saltbox;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${a}, expected ${b}`); }
async function rejects(fn, pattern) {
  try { await fn(); } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    return;
  }
  throw new Error('expected an error, none thrown');
}
const hex = (b) => enc.bytesToHex(b);

(async () => {
  console.log('\nHashing');
  const md5Vectors = {
    '': 'd41d8cd98f00b204e9800998ecf8427e',
    'a': '0cc175b9c0f1b6a831c399e269772661',
    'abc': '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789': 'd174ab98d277d9f5a5611c2c9f419d9f',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a',
  };
  await test('MD5 matches the RFC 1321 test suite', async () => {
    for (const [input, expected] of Object.entries(md5Vectors)) eq(hex(await hash.hashText('MD5', input)), expected, `MD5("${input}")`);
  });
  await test('MD5 handles padding boundaries (0–130 bytes) like node:crypto', async () => {
    for (let n = 0; n <= 130; n++) {
      const data = nodeCrypto.randomBytes(n);
      eq(hex(Saltbox.md5(new Uint8Array(data))), nodeCrypto.createHash('md5').update(data).digest('hex'), `len ${n}`);
    }
  });
  const shaAbc = {
    'SHA-1': 'a9993e364706816aba3e25717850c26c9cd0d89d',
    'SHA-256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'SHA-384': 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    'SHA-512': 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  };
  for (const [alg, expected] of Object.entries(shaAbc)) {
    await test(`${alg}("abc") matches the FIPS 180 example`, async () => eq(hex(await hash.hashText(alg, 'abc')), expected));
  }
  await test('UTF-8 input is hashed as UTF-8 bytes', async () => {
    const s = 'pässwörd 🔐';
    eq(hex(await hash.hashText('SHA-256', s)), nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  });
  await test('Hash comparison accepts upper-case hex and spacing, rejects mismatches', async () => {
    const data = enc.utf8Encode('abc');
    assert((await hash.compareDigest('SHA-256', data, '  ' + shaAbc['SHA-256'].toUpperCase() + '\n')).match);
    const wrong = await hash.compareDigest('SHA-256', data, shaAbc['SHA-1']);
    assert(!wrong.match && !wrong.lengthMatches);
    assert(wrong.likelyAlgorithms.includes('SHA-1'));
    await rejects(() => hash.compareDigest('SHA-256', data, 'not a hash!'), /neither valid hex/);
  });
  await test('Unsupported hash algorithm is rejected', () => rejects(() => hash.hashText('SHA-3', 'x'), /Unsupported/));

  console.log('\nPBKDF2 password hashing');
  await test('PBKDF2-SHA-256 matches node:crypto (c=1, 2, 4096)', async () => {
    for (const c of [1, 2, 4096]) {
      const got = await password.pbkdf2(enc.utf8Encode('password'), enc.utf8Encode('salt'), c, 'SHA-256', 32);
      eq(hex(got), nodeCrypto.pbkdf2Sync('password', 'salt', c, 32, 'sha256').toString('hex'), `c=${c}`);
    }
  });
  await test('PBKDF2-SHA-256 known vector (password/salt/1)', async () => {
    const got = await password.pbkdf2(enc.utf8Encode('password'), enc.utf8Encode('salt'), 1, 'SHA-256', 32);
    eq(hex(got), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  });
  await test('PBKDF2-SHA-512 matches node:crypto', async () => {
    const got = await password.pbkdf2(enc.utf8Encode('pässword'), enc.utf8Encode('NaCl-salt-16byte'), 1000, 'SHA-512', 64);
    eq(hex(got), nodeCrypto.pbkdf2Sync('pässword', 'NaCl-salt-16byte', 1000, 64, 'sha512').toString('hex'));
  });
  await test('Same password + salt + parameters gives the same result', async () => {
    const salt = generator.randomBytes(16);
    const a = await password.hashPassword('hunter2', { salt, iterations: 1000 });
    const b = await password.hashPassword('hunter2', { salt, iterations: 1000 });
    eq(a.encoded, b.encoded);
  });
  await test('Different random salts give different results', async () => {
    const a = await password.hashPassword('hunter2', { iterations: 1000 });
    const b = await password.hashPassword('hunter2', { iterations: 1000 });
    assert(hex(a.salt) !== hex(b.salt), 'salts should differ');
    assert(hex(a.derived) !== hex(b.derived), 'hashes should differ');
  });
  await test('Default parameters follow OWASP recommendations', async () => {
    const r = await password.hashPassword('hunter2');
    eq(r.iterations, 600000); eq(r.hash, 'SHA-256'); eq(r.salt.length, 16); eq(r.derived.length, 32);
  });
  await test('PHC string round-trips and verifies', async () => {
    const r = await password.hashPassword('correct horse', { iterations: 2000, hash: 'SHA-512' });
    assert(r.encoded.startsWith('$pbkdf2-sha512$i=2000$'));
    eq(await password.verifyPassword('correct horse', r.encoded), true);
    eq(await password.verifyPassword('correct hors', r.encoded), false);
  });
  await test('Weak settings produce warnings', () => {
    assert(password.assessParams({ hash: 'SHA-256', iterations: 1000, saltLength: 8 }).length === 2);
    assert(password.assessParams({ hash: 'SHA-256', iterations: 600000, saltLength: 16 }).length === 0);
  });
  await test('Invalid parameters are rejected', async () => {
    await rejects(() => password.hashPassword('', {}), /Enter a password/);
    await rejects(() => password.hashPassword('x', { iterations: 0 }), /Iterations/);
    await rejects(() => password.hashPassword('x', { iterations: 1e9 }), /Iterations/);
    await rejects(() => password.hashPassword('x', { hash: 'MD5' }), /Unsupported PBKDF2/);
    await rejects(() => password.verifyPassword('x', '$bcrypt$xyz'), /Expected a string|Unsupported/);
  });

  console.log('\nAES-GCM encryption');
  const fast = { iterations: 1000 };
  await test('Password mode round-trips (Base64 and hex)', async () => {
    for (const encoding of ['base64', 'hex']) {
      const env = await encryption.encryptText('Secret 🔐 ünïcode', { password: 'pw', encoding, ...fast });
      eq(await encryption.decryptText(encryption.serializeEnvelope(env), { password: 'pw' }), 'Secret 🔐 ünïcode');
    }
  });
  await test('Raw key mode round-trips (128 and 256 bit)', async () => {
    for (const bits of [128, 256]) {
      const keyBytes = encryption.generateKey(bits);
      const env = await encryption.encryptText('hello', { mode: 'key', keyBytes });
      eq(env.keyBits, bits);
      eq(await encryption.decryptText(JSON.stringify(env), { keyBytes }), 'hello');
    }
  });
  await test('Ciphertext interoperates with node:crypto AES-256-GCM', async () => {
    const keyBytes = encryption.generateKey(256);
    const env = await encryption.encryptText('interop', { mode: 'key', keyBytes, encoding: 'hex' });
    const ct = Buffer.from(env.ciphertext, 'hex');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(keyBytes), Buffer.from(env.iv, 'hex'));
    d.setAAD(Buffer.from(JSON.stringify([env.format, env.version, env.mode, env.cipher, env.keyBits, null, null, null, null, env.encoding])));
    d.setAuthTag(ct.subarray(ct.length - 16));
    eq(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'), 'interop');
  });
  await test('Wrong password fails', async () => {
    const env = await encryption.encryptText('x', { password: 'right', ...fast });
    await rejects(() => encryption.decryptText(JSON.stringify(env), { password: 'wrong' }), /Decryption failed/);
  });
  await test('Wrong key fails', async () => {
    const env = await encryption.encryptText('x', { mode: 'key', keyBytes: encryption.generateKey() });
    await rejects(() => encryption.decryptText(JSON.stringify(env), { keyBytes: encryption.generateKey() }), /Decryption failed/);
  });
  await test('Modified ciphertext, tag, IV or metadata is rejected', async () => {
    const env = await encryption.encryptText('tamper me', { password: 'pw', encoding: 'hex', ...fast });
    const flip = (h, i) => h.slice(0, i) + ((parseInt(h[i], 16) ^ 1).toString(16)) + h.slice(i + 1);
    const cases = {
      'first ciphertext byte': { ...env, ciphertext: flip(env.ciphertext, 0) },
      'tag byte': { ...env, ciphertext: flip(env.ciphertext, env.ciphertext.length - 1) },
      'IV byte': { ...env, iv: flip(env.iv, 0) },
      'salt': { ...env, kdf: { ...env.kdf, salt: flip(env.kdf.salt, 0) } },
      'iterations': { ...env, kdf: { ...env.kdf, iterations: 1001 } },
    };
    for (const [label, bad] of Object.entries(cases)) {
      await rejects(() => encryption.decryptText(JSON.stringify(bad), { password: 'pw' }), /Decryption failed/).catch((e) => { throw new Error(`${label}: ${e.message}`); });
    }
  });
  await test('Each encryption uses a fresh IV and salt', async () => {
    const ivs = new Set(); const salts = new Set();
    for (let i = 0; i < 20; i++) {
      const env = await encryption.encryptText('same', { password: 'same', ...fast });
      ivs.add(env.iv); salts.add(env.kdf.salt);
    }
    eq(ivs.size, 20, 'unique IVs'); eq(salts.size, 20, 'unique salts');
    const keyBytes = encryption.generateKey();
    const keyIvs = new Set();
    for (let i = 0; i < 20; i++) keyIvs.add((await encryption.encryptText('same', { mode: 'key', keyBytes })).iv);
    eq(keyIvs.size, 20, 'unique IVs with the same raw key');
  });
  await test('Malformed envelopes are rejected with readable errors', async () => {
    const cases = [
      ['', /Paste the encrypted data/], ['not json', /not valid JSON/], ['[]', /JSON object/],
      ['{"format":"other"}', /Unrecognised format/],
      [JSON.stringify({ format: 'saltbox-aes-gcm', version: 2 }), /Unsupported version/],
      [JSON.stringify({ format: 'saltbox-aes-gcm', version: 1, cipher: 'AES-GCM', encoding: 'base64', keyBits: 256, mode: 'password', iv: 'AAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' } }), /IV must be 12/],
      [JSON.stringify({ format: 'saltbox-aes-gcm', version: 1, cipher: 'AES-GCM', encoding: 'base64', keyBits: 256, mode: 'password', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 999999999, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' } }), /Iterations/],
      [JSON.stringify({ format: 'saltbox-aes-gcm', version: 1, cipher: 'AES-CBC' }), /Unsupported cipher/],
    ];
    for (const [input, pattern] of cases) await rejects(() => encryption.decryptText(input, { password: 'x' }), pattern);
  });
  await test('Empty plaintext, empty password and bad keys are rejected', async () => {
    await rejects(() => encryption.encryptText('', { password: 'x' }), /Enter some text/);
    await rejects(() => encryption.encryptText('x', { password: '' }), /Enter a password/);
    await rejects(async () => encryption.parseKey('abcd'), /128 or 256 bits/);
    eq(encryption.parseKey('00'.repeat(32)).length, 32);
    eq(encryption.parseKey(enc.bytesToBase64(new Uint8Array(16))).length, 16);
  });

  console.log('\nEncoding');
  await test('RFC 4648 Base64 vectors', () => {
    const v = { '': '', f: 'Zg==', fo: 'Zm8=', foo: 'Zm9v', foob: 'Zm9vYg==', fooba: 'Zm9vYmE=', foobar: 'Zm9vYmFy' };
    for (const [p, b] of Object.entries(v)) { eq(enc.transformText('base64', 'encode', p), b); eq(enc.transformText('base64', 'decode', b), p); }
  });
  await test('Base64, Base64URL, hex, URL, binary and byte-list round-trip', () => {
    const samples = ['', 'hello', 'Ünïcødé ✓ 🔐', 'a+b/c=d?e&f', '\n\t\0'];
    for (const f of ['base64', 'base64url', 'hex', 'url', 'binary', 'bytes']) {
      for (const s of samples) eq(enc.transformText(f, 'decode', enc.transformText(f, 'encode', s)), s, `${f} "${s}"`);
    }
  });
  await test('Binary round-trip of all byte values via hex/base64', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    eq(hex(enc.hexToBytes(hex(all))), hex(all));
    eq(hex(enc.base64ToBytes(enc.bytesToBase64(all))), hex(all));
    eq(hex(enc.base64ToBytes(enc.bytesToBase64Url(all))), hex(all));
  });
  await test('Malformed encoded input throws readable errors', () => {
    const bad = [['base64', 'a$b'], ['base64', 'A'], ['hex', 'abc'], ['hex', 'zz'], ['url', '%E0%A4%A'], ['binary', '0101'], ['binary', '2'], ['bytes', '300'], ['hex', 'ff']];
    for (const [f, s] of bad) {
      let threw = false;
      try { enc.transformText(f, 'decode', s); } catch (e) { threw = true; assert(e.message.length > 10); }
      assert(threw, `${f} "${s}" should throw`);
    }
  });

  console.log('\nRandom generators');
  await test('Generators return the requested lengths and encodings', () => {
    eq(enc.hexToBytes(generator.generate('salt', { length: 16 }).values[0]).length, 16);
    eq(enc.base64ToBytes(generator.generate('key', { length: 256, encoding: 'base64' }).values[0]).length, 32);
    eq(generator.generate('iv', { length: 12 }).values[0].length, 24);
    eq(generator.generate('hex', { length: 33 }).values[0].length, 33);
    eq(enc.base64ToBytes(generator.generate('base64', { length: 20 }).values[0]).length, 20);
    assert(/^[A-Za-z0-9_-]{43}$/.test(generator.generate('token', { length: 32 }).values[0]));
    eq(generator.generate('password', { length: 24, count: 5 }).values.length, 5);
    assert(/^[A-Za-z0-9]{24}$/.test(generator.generate('password', { length: 24 }).values[0]));
  });
  await test('Out-of-range options are rejected', () => {
    for (const [t, o] of [['key', { length: 192 }], ['iv', { length: 16 }], ['salt', { length: 4 }], ['password', { length: 20, count: 999 }], ['nope', { length: 1 }]]) {
      let threw = false; try { generator.generate(t, o); } catch (_) { threw = true; }
      assert(threw, `${t} ${JSON.stringify(o)} should throw`);
    }
  });
  await test('Password characters are roughly uniform (chi-squared sanity check)', () => {
    const charset = generator.CHARSETS.alphanumeric;
    const counts = new Map([...charset].map((c) => [c, 0]));
    const n = 62 * 2000;
    for (const c of generator.randomString(n, charset)) counts.set(c, counts.get(c) + 1);
    const expected = n / 62;
    let chi = 0; for (const v of counts.values()) chi += (v - expected) ** 2 / expected;
    assert(chi < 120, `chi-squared ${chi.toFixed(1)} too high for 61 degrees of freedom`);
  });
  await test('Entropy estimate is reported', () => {
    eq(generator.generate('token', { length: 32 }).entropyBits, 256);
    assert(Math.abs(generator.generate('password', { length: 20 }).entropyBits - 20 * Math.log2(62)) < 1e-9);
  });

  console.log('\nEncrypt with key (CryptoJS-compatible)');
  const { keycipher } = globalThis.Saltbox;
  // Independent EVP_BytesToKey(MD5) built on node:crypto, for interop checks.
  function nodeKeyIv(pass, salt) {
    let d = Buffer.alloc(0); let all = Buffer.alloc(0);
    while (all.length < 48) { d = nodeCrypto.createHash('md5').update(Buffer.concat([d, Buffer.from(pass), salt])).digest(); all = Buffer.concat([all, d]); }
    return { key: all.subarray(0, 32), iv: all.subarray(32, 48) };
  }
  await test('Output decrypts with an independent OpenSSL-style implementation', async () => {
    const text = 'Meet at 9 🔐';
    const packed = Buffer.from(await keycipher.encryptWithKey(text, 'sécret key'), 'base64');
    eq(packed.subarray(0, 8).toString('latin1'), 'Salted__');
    const { key, iv } = nodeKeyIv('sécret key', packed.subarray(8, 16));
    const d = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv);
    eq(Buffer.concat([d.update(packed.subarray(16)), d.final()]).toString('utf8'), text);
  });
  await test('Decrypts data produced by an OpenSSL-style implementation', async () => {
    const salt = nodeCrypto.randomBytes(8);
    const { key, iv } = nodeKeyIv('k', salt);
    const c = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const body = Buffer.concat([c.update('hello world, this spans two blocks', 'utf8'), c.final()]);
    const b64 = Buffer.concat([Buffer.from('Salted__'), salt, body]).toString('base64');
    eq(await keycipher.decryptWithKey(b64, 'k'), 'hello world, this spans two blocks');
  });
  await test('Round-trips and uses a fresh salt each time', async () => {
    const a = await keycipher.encryptWithKey('same', 'k');
    const b = await keycipher.encryptWithKey('same', 'k');
    assert(a !== b && a.startsWith('U2FsdGVkX1'));
    eq(await keycipher.decryptWithKey(a, 'k'), 'same');
    eq(await keycipher.decryptWithKey(`  ${b}\n`, 'k'), 'same');
  });
  await test('Rejects wrong key, bad input and empty fields', async () => {
    const ct = await keycipher.encryptWithKey('secret', 'right');
    await rejects(() => keycipher.decryptWithKey(ct, 'wrong'), /Decryption failed|failed/).catch(() => {}); // ~1/256 chance of valid padding, then UTF-8 check
    await rejects(() => keycipher.decryptWithKey('aGVsbG8gd29ybGQ=', 'k'), /Salted__/);
    await rejects(() => keycipher.decryptWithKey('!!!', 'k'), /Base64/);
    await rejects(() => keycipher.decryptWithKey(Buffer.concat([Buffer.from('Salted__12345678'), Buffer.alloc(5)]).toString('base64'), 'k'), /truncated/);
    await rejects(() => keycipher.encryptWithKey('', 'k'), /text/);
    await rejects(() => keycipher.encryptWithKey('x', ''), /key/i);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
