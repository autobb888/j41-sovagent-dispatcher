'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { maskEncryptionIndex, sealIndexError } = require('../src/seal-address-run');

// Historical zip32 indexes that crashed when the high bit was set. These are
// indexes, not job ids. Leg A buyer 673137528 is already below 2^31.
const HIGH_INDEXES = [3458336562, 4101680177, 4010839618];

test('maskEncryptionIndex clears the high bit and leaves a low index unchanged', () => {
  assert.equal(maskEncryptionIndex(673137528), 673137528);
  for (const index of HIGH_INDEXES) {
    const masked = maskEncryptionIndex(index);
    assert.equal(masked, (index >>> 0) & 0x7fffffff);
    assert.ok(masked < 0x80000000);
    assert.notEqual(masked, index);
  }
  assert.equal(maskEncryptionIndex(0), 0);
  assert.equal(maskEncryptionIndex(0x7fffffff), 0x7fffffff);
  assert.equal(maskEncryptionIndex(0x80000000), 0);
});

test('a zip32 rejection is SEAL_INDEX and is not the bare word unreachable', () => {
  const err = sealIndexError();
  assert.equal(err.code, 'SEAL_INDEX');
  assert.notEqual(err.message, 'unreachable');
  assert.equal(/unreachable/.test(err.message), false);
  assert.equal(/seed|viewing key|\bivk\b/i.test(err.message), false);
});

test('deriveJobAddress still masks before the library and still checks 86 hex', () => {
  const src = fs.readFileSync('src/seal-address-run.js', 'utf8');
  const maskAt = src.indexOf('maskEncryptionIndex(');
  const callAt = src.indexOf('lib.z_getEncryptionAddress');
  const checkAt = src.indexOf('addressHex.length !== 86');
  assert.ok(maskAt > 0 && callAt > maskAt && checkAt > callAt);
  assert.match(src, /throw sealIndexError\(\)/);
  assert.match(src, /err\.code = 'SEAL_INDEX'/);
});
