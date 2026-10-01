'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRefreshEarnings, EARNINGS_TTL_MS } = require('../src/control');
test('earnings refresh after 60 seconds', () => {
  assert.equal(EARNINGS_TTL_MS, 60000);
  assert.equal(shouldRefreshEarnings(null, 1000, EARNINGS_TTL_MS), true);
  assert.equal(shouldRefreshEarnings(1000, 60999, EARNINGS_TTL_MS), false);
  assert.equal(shouldRefreshEarnings(1000, 61000, EARNINGS_TTL_MS), true);
});
