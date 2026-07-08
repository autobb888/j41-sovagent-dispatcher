'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');

function tmpMk() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'master-key.json');
}

test('initMasterKey creates a 0600 v:1 file and leaves the pool unlocked', () => {
  const mk = tmpMk();
  ks.lock();
  ks.initMasterKey('pw', mk);
  assert.ok(ks.isUnlocked());
  assert.equal(fs.statSync(mk).mode & 0o777, 0o600);
  const doc = JSON.parse(fs.readFileSync(mk, 'utf8'));
  assert.equal(doc.v, 1);
  assert.equal(doc.kdf.alg, 'scrypt');
  ks.lock();
});

test('initMasterKey refuses to overwrite an existing file', () => {
  const mk = tmpMk();
  ks.initMasterKey('pw', mk); ks.lock();
  assert.throws(() => ks.initMasterKey('pw', mk), /already exists/);
});

test('unlock with the correct passphrase unlocks; getMasterKey returns 32 bytes', () => {
  const mk = tmpMk();
  ks.initMasterKey('correct horse', mk); ks.lock();
  assert.ok(!ks.isUnlocked());
  ks.unlock('correct horse', mk);
  assert.ok(ks.isUnlocked());
  assert.equal(ks.getMasterKey().length, 32);
  ks.lock();
});

test('unlock with a wrong passphrase throws EBADPASS and stays locked', () => {
  const mk = tmpMk();
  ks.initMasterKey('right', mk); ks.lock();
  assert.throws(() => ks.unlock('wrong', mk), (e) => e.code === 'EBADPASS');
  assert.ok(!ks.isUnlocked());
});

test('getMasterKey throws ELOCKED when locked', () => {
  ks.lock();
  assert.throws(() => ks.getMasterKey(), (e) => e.code === 'ELOCKED');
});

test('changePassphrase preserves the master key (old fails, new unlocks)', () => {
  const mk = tmpMk();
  ks.initMasterKey('old', mk);
  const before = Buffer.from(ks.getMasterKey());
  ks.lock();
  ks.changePassphrase('old', 'new', mk);
  assert.throws(() => ks.unlock('old', mk), (e) => e.code === 'EBADPASS');
  ks.unlock('new', mk);
  assert.ok(ks.getMasterKey().equals(before));
  ks.lock();
});

test('initMasterKey + changePassphrase leaves no .tmp file and round-trips with new passphrase', () => {
  const mk = tmpMk();
  ks.lock();
  ks.initMasterKey('first', mk);
  ks.lock();
  // No stale .tmp after initMasterKey
  assert.strictEqual(fs.existsSync(mk + '.tmp'), false);
  ks.changePassphrase('first', 'second', mk);
  // No stale .tmp after changePassphrase
  assert.strictEqual(fs.existsSync(mk + '.tmp'), false);
  // Old passphrase no longer works
  assert.throws(() => ks.unlock('first', mk), (e) => e.code === 'EBADPASS');
  // New passphrase unlocks; master key is 32 bytes
  ks.unlock('second', mk);
  assert.equal(ks.getMasterKey().length, 32);
  ks.lock();
});

test('resolvePassphraseSync prefers systemd credential, then env, else null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-'));
  fs.writeFileSync(path.join(dir, 'j41-keys-passphrase'), 'from-cred\n');
  assert.equal(ks.resolvePassphraseSync({ env: { CREDENTIALS_DIRECTORY: dir, J41_KEYS_PASSPHRASE: 'from-env' } }), 'from-cred');
  assert.equal(ks.resolvePassphraseSync({ env: { J41_KEYS_PASSPHRASE: 'from-env' } }), 'from-env');
  assert.equal(ks.resolvePassphraseSync({ env: {} }), null);
});
