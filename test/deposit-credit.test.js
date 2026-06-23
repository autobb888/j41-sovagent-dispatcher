const { test } = require('node:test'); const assert = require('node:assert/strict');
const { clampCredit } = require('../src/deposit-credit.js');
test('clampCredit takes min(expected, confirmed); falls back when confirmed missing/NaN', () => {
  assert.equal(clampCredit(10, 10), 10);
  assert.equal(clampCredit(10, 8), 8);
  assert.equal(clampCredit(10, undefined), 10);
  assert.equal(clampCredit(10, NaN), 10);
  assert.equal(clampCredit(10, null), 10);
  assert.equal(clampCredit(10, -5), 0);   // negative confirmed must never debit
  assert.equal(clampCredit(10, -0.001), 0);
});
