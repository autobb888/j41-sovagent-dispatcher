'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('networkCurrency lives on wallet.js and does not load the deposit watcher', () => {
  const { networkCurrency } = require('../src/wallet.js');
  assert.equal(networkCurrency('verus'), 'VRSC');
  assert.equal(networkCurrency('verustest'), 'VRSCTEST');
  const loaded = Object.keys(require.cache).some((key) => key.endsWith(`${require('path').sep}deposit-watcher.js`));
  assert.equal(loaded, false);
});
