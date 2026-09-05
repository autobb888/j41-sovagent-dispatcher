'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TESTNET_PLATFORM_SIGNER,
  FEE_TANK_NOT_SIGNER,
  planPlatformSigner,
} = require('../src/platform-signer');

test('fee-tank R is never accepted as the keys-endpoint pin', () => {
  const r = planPlatformSigner({
    apiUrl: 'https://api.junction41.io',
    network: 'verustest',
    signer: FEE_TANK_NOT_SIGNER,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLATFORM_SIGNER_NOT_FEE');
  assert.match(r.message, /KEYS_BAD_SIGNATURE/);
  assert.match(r.message, new RegExp(TESTNET_PLATFORM_SIGNER));
});

test('api.junction41.io on verustest defaults to the live keys-endpoint pin', () => {
  const r = planPlatformSigner({
    apiUrl: 'https://api.junction41.io',
    network: 'verustest',
    signer: '',
  });
  assert.equal(r.ok, true);
  assert.equal(r.defaulted, true);
  assert.equal(r.signer, TESTNET_PLATFORM_SIGNER);
});

test('mainnet refuses an unset pin (no silent default)', () => {
  const r = planPlatformSigner({
    apiUrl: 'https://api.junction41.io',
    network: 'verus',
    signer: '',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLATFORM_SIGNER_REQUIRED');
});

test('explicit pin wins', () => {
  const r = planPlatformSigner({
    apiUrl: 'https://api.junction41.io',
    network: 'verustest',
    signer: 'RexplicitPinAddress000000000000000',
  });
  assert.equal(r.ok, true);
  assert.equal(r.defaulted, false);
  assert.equal(r.signer, 'RexplicitPinAddress000000000000000');
});
