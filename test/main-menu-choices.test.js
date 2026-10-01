'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mainMenuChoices } = require('../src/dashboard');

test('the top menu includes the existing job commands', () => {
  const values = mainMenuChoices().map((c) => c.value);
  for (const value of ['complete', 'review', 'artifacts', 'data_setup', 'sales_mode']) {
    assert.ok(values.includes(value), value);
  }
  // This branch has no seal-chat, z-address, pay-shielded, or seal-open commands.
  for (const value of ['seal_chat', 'z_address', 'pay_shielded', 'seal_open']) {
    assert.equal(values.includes(value), false, value);
  }
});
