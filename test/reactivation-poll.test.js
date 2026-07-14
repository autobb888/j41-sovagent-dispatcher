'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldPauseOnPoll } = require('../src/reactivation-poll.js');

test('pauses a live, un-paused active job when platform status is paused', () => {
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, { paused: false }), true);
});
test('does NOT re-pause an already-paused or mid-teardown job', () => {
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, { paused: true }), false);
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, { paused: false, _pausing: true }), false);
});
test('ignores non-paused statuses and missing activeInfo', () => {
  assert.strictEqual(shouldPauseOnPoll({ status: 'in_progress' }, { paused: false }), false);
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, null), false);
});
