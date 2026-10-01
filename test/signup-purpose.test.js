'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signupStopsAtIdentity } = require('../src/dashboard');

test('hire signup stops at the identity', () => {
  assert.equal(signupStopsAtIdentity('hire'), true);
  assert.equal(signupStopsAtIdentity('sell'), false);
});
