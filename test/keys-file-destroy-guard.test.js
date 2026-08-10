/**
 * K1 (critical) — a write must never destroy the private key.
 *
 * `readKeysFile(path, { allowLocked: true })` returns public fields only: on a v2
 * (encrypted) file it strips BOTH `wif` and the `encrypted` envelope. The dashboard's
 * "Retry Registration" screen reads that way at four sites and writes the object
 * straight back — and with no `wif` present the encryption branch is skipped, so the
 * atomic rename drops a plaintext key-less file over the ciphertext. The WIF is gone,
 * there is no backup, and the master key decrypts nothing.
 *
 * The guard lives in the primitive, not the call sites, so any future caller that
 * reads locked and writes back fails loudly instead of silently destroying custody.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeKeysFile } = require('../src/keys-file.js');

function tmpKeys(content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-keys-'));
  const p = path.join(d, 'keys.json');
  fs.writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}

test('refuses to overwrite an ENCRYPTED record with a key-less object', () => {
  const p = tmpKeys({ v: 2, identity: 'a@', encrypted: { ct: 'deadbeef', iv: 'x' } });
  assert.throws(
    () => writeKeysFile(p, { identity: 'a@', registrationStatus: 'retrying' }),
    /destroy the private key/,
  );
  // and the ciphertext is still there, untouched
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(after.encrypted, 'the encrypted envelope must survive the refusal');
});

test('refuses to overwrite a PLAINTEXT wif with a key-less object', () => {
  const p = tmpKeys({ identity: 'a@', wif: 'Uxxxxxxxxxxxxxxxxxxx' });
  assert.throws(() => writeKeysFile(p, { identity: 'a@' }), /destroy the private key/);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).wif, 'Uxxxxxxxxxxxxxxxxxxx');
});

test('a legitimate write carrying the wif still succeeds', () => {
  const p = tmpKeys({ identity: 'a@', wif: 'Uold' });
  writeKeysFile(p, { identity: 'a@', wif: 'Unew', registrationStatus: 'done' });
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(after.wif, 'Unew');
  assert.equal(after.registrationStatus, 'done');
});

test('a write that carries the encrypted envelope forward still succeeds', () => {
  const p = tmpKeys({ v: 2, identity: 'a@', encrypted: { ct: 'aa' } });
  writeKeysFile(p, { v: 2, identity: 'a@', encrypted: { ct: 'bb' }, note: 'x' });
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).encrypted.ct, 'bb');
});

test('a brand-new file (nothing to destroy) writes freely', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-keys-'));
  const p = path.join(d, 'keys.json');
  writeKeysFile(p, { identity: 'new@', pendingName: 'x' });
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).identity, 'new@');
});

test('a file with no key material is not protected — nothing to lose', () => {
  const p = tmpKeys({ identity: 'a@', registrationStatus: 'pending' });
  writeKeysFile(p, { identity: 'a@', registrationStatus: 'retrying' });
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).registrationStatus, 'retrying');
});

test('a corrupt existing file does not block a legitimate write', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-keys-'));
  const p = path.join(d, 'keys.json');
  fs.writeFileSync(p, '{ not json');
  writeKeysFile(p, { identity: 'a@', wif: 'U1' });
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).wif, 'U1');
});
