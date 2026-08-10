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

test('carries an ENCRYPTED envelope forward when the write omits it', () => {
  // The guard MERGES rather than throwing: readKeysFile({allowLocked:true}) strips key
  // material even when unlocked, so the dashboard's Retry Registration write-backs
  // would otherwise crash the whole TUI on any encrypted pool. Nothing here
  // legitimately clears a key, so preserving it is always the correct read of intent.
  const p = tmpKeys({ v: 2, identity: 'a@', encrypted: { ct: 'deadbeef', iv: 'x' } });
  writeKeysFile(p, { identity: 'a@', registrationStatus: 'retrying' });
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(after.encrypted, { ct: 'deadbeef', iv: 'x' }, 'key material must survive');
  assert.equal(after.registrationStatus, 'retrying', 'and the caller\'s update must apply');
});

test('carries a PLAINTEXT wif forward when the write omits it', () => {
  const p = tmpKeys({ identity: 'a@', wif: 'Uxxxxxxxxxxxxxxxxxxx' });
  writeKeysFile(p, { identity: 'a@', registrationStatus: 'x' });
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(after.wif, 'Uxxxxxxxxxxxxxxxxxxx');
  assert.equal(after.registrationStatus, 'x');
});

test('the carry-forward is announced, so the caller bug stays visible', () => {
  const p = tmpKeys({ identity: 'a@', wif: 'Ukeep' });
  const seen = [];
  const orig = console.warn; console.warn = (...a) => seen.push(a.join(' '));
  try { writeKeysFile(p, { identity: 'a@' }); } finally { console.warn = orig; }
  assert.ok(seen.some(l => /preserving the existing one/.test(l)),
    'a silent merge would hide the call-site defect');
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
