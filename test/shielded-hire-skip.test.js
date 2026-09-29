'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isShieldedHire } = require('../src/shielded-hire-skip');

test('only a shielded payment kind skips the public job record', () => {
  assert.equal(isShieldedHire({ payment: { kind: 'shielded' } }), true);
  assert.equal(isShieldedHire({ payment: { kind: 'transparent' } }), false);
  assert.equal(isShieldedHire({ payment: {} }), false);
  assert.equal(isShieldedHire(null), false);
});
