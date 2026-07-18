'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { isPostDeliveryReconnect } = require('../src/job-agent.js');

test('delivered and disputed are post-delivery reconnects', () => {
  assert.equal(isPostDeliveryReconnect('delivered'), true);
  assert.equal(isPostDeliveryReconnect('disputed'), true);
});
test('accepted/in_progress/paused are not', () => {
  for (const s of ['accepted', 'in_progress', 'paused', 'completed', undefined]) {
    assert.equal(isPostDeliveryReconnect(s), false, `${s} must not be a reconnect`);
  }
});
