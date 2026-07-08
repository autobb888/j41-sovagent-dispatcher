'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');
const { readKeysFile, writeKeysFile } = require('../src/keys-file.js');

function tmpKeys() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-')), 'keys.json');
}
const OBJ = { wif: 'Usecret123', identity: 'a.platform@', iAddress: 'i9', network: 'verustest' };

test('unlocked write produces a v2 envelope with public fields in the clear', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys();
  writeKeysFile(p, OBJ);
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.v, 2);
  assert.equal(onDisk.identity, 'a.platform@');
  assert.equal(onDisk.wif, undefined);
  assert.ok(onDisk.encrypted && onDisk.encrypted.alg === 'aes-256-gcm');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  ks.lock();
});

test('v2 round-trips when unlocked (wif recovered, no envelope markers leak)', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys();
  writeKeysFile(p, OBJ);
  assert.deepStrictEqual(readKeysFile(p), OBJ);
  ks.lock();
});

test('v2 read while locked throws ELOCKED by default (no path registered, no lazy unlock)', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  assert.throws(() => readKeysFile(p), (e) => e.code === 'ELOCKED');
});

test('v2 read while locked with allowLocked returns public fields only', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  const pub = readKeysFile(p, { allowLocked: true });
  assert.equal(pub.identity, 'a.platform@');
  assert.equal(pub.iAddress, 'i9');
  assert.equal(pub.wif, undefined);
  assert.equal(pub.v, undefined);
  assert.equal(pub.encrypted, undefined);
});

test('locked write (no unlock) stays plaintext v1', () => {
  ks.lock();
  const p = tmpKeys();
  writeKeysFile(p, OBJ);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), OBJ);
});

test('allowLocked returns public fields only even when the keystore is unlocked', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('pw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  try {
    assert.ok(ks.isUnlocked()); // still unlocked after write
    const pub = readKeysFile(p, { allowLocked: true });
    assert.equal(pub.wif, undefined);
    assert.equal(pub.identity, 'a.platform@');
    assert.equal(pub.v, undefined);
    assert.equal(pub.encrypted, undefined);
  } finally {
    ks.lock();
  }
});

test('v2 read lazy-unlocks from J41_KEYS_PASSPHRASE when a master-key path is registered', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('envpw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  ks.setMasterKeyPath(mk);
  process.env.J41_KEYS_PASSPHRASE = 'envpw';
  try {
    assert.deepStrictEqual(readKeysFile(p), OBJ); // lazy-unlocks then decrypts
    assert.ok(ks.isUnlocked());
  } finally {
    delete process.env.J41_KEYS_PASSPHRASE;
    ks.setMasterKeyPath(null);
    ks.lock();
  }
});

test('fresh-agent write on encrypted pool stores wif encrypted (v2) and readKeysFile recovers it', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock();
  ks.initMasterKey('pw', mk);
  const p = tmpKeys();
  try {
    writeKeysFile(p, { wif: 'Ufresh', address: 'Rfresh', network: 'verustest' });
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    // On-disk: v2, wif absent, encrypted envelope present
    assert.equal(onDisk.v, 2);
    assert.equal(onDisk.wif, undefined);
    assert.ok(onDisk.encrypted && onDisk.encrypted.alg === 'aes-256-gcm');
    // Round-trip: readKeysFile recovers the wif
    const recovered = readKeysFile(p);
    assert.equal(recovered.wif, 'Ufresh');
    assert.equal(recovered.address, 'Rfresh');
    assert.equal(recovered.network, 'verustest');
  } finally {
    ks.lock();
  }
});

test('lazy unlock with a wrong J41_KEYS_PASSPHRASE surfaces EBADPASS', () => {
  const mk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ke-mk-')), 'master-key.json');
  ks.lock(); ks.initMasterKey('rightpw', mk);
  const p = tmpKeys(); writeKeysFile(p, OBJ);
  ks.lock();
  ks.setMasterKeyPath(mk);
  process.env.J41_KEYS_PASSPHRASE = 'wrongpw';
  try {
    assert.throws(() => readKeysFile(p), (e) => e.code === 'EBADPASS');
  } finally {
    delete process.env.J41_KEYS_PASSPHRASE;
    ks.setMasterKeyPath(null);
    ks.lock();
  }
});
