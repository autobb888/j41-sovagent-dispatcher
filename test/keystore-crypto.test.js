'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ks = require('../src/keystore.js');

test('deriveKek is deterministic for a fixed salt and 32 bytes long', () => {
  const salt = Buffer.alloc(16, 7);
  const a = ks.deriveKek('hunter2', { ...ks.SCRYPT_PARAMS, salt });
  const b = ks.deriveKek('hunter2', { ...ks.SCRYPT_PARAMS, salt });
  assert.equal(a.length, 32);
  assert.ok(a.equals(b));
});

test('deriveKek differs for a different passphrase', () => {
  const salt = Buffer.alloc(16, 7);
  const a = ks.deriveKek('hunter2', { ...ks.SCRYPT_PARAMS, salt });
  const b = ks.deriveKek('hunter3', { ...ks.SCRYPT_PARAMS, salt });
  assert.ok(!a.equals(b));
});

test('encryptSecret/decryptSecret round-trip', () => {
  const mk = ks.createMasterKey();
  const pt = Buffer.from(JSON.stringify({ wif: 'Uabc123' }), 'utf8');
  const env = ks.encryptSecret(mk, pt);
  assert.equal(env.alg, 'aes-256-gcm');
  assert.ok(ks.decryptSecret(mk, env).equals(pt));
});

test('decryptSecret throws on a wrong key (tag mismatch)', () => {
  const env = ks.encryptSecret(ks.createMasterKey(), Buffer.from('x'));
  assert.throws(() => ks.decryptSecret(ks.createMasterKey(), env));
});

test('decryptSecret throws on tampered ciphertext', () => {
  const mk = ks.createMasterKey();
  const env = ks.encryptSecret(mk, Buffer.from('hello'));
  const bad = Buffer.from(env.ct, 'base64'); bad[0] ^= 0xff;
  assert.throws(() => ks.decryptSecret(mk, { ...env, ct: bad.toString('base64') }));
});

test('wrapMasterKey/unwrapMasterKey round-trip', () => {
  const kek = crypto.randomBytes(32);
  const mk = ks.createMasterKey();
  assert.ok(ks.unwrapMasterKey(ks.wrapMasterKey(mk, kek), kek).equals(mk));
});
