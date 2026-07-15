'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldPauseOnPoll, pickResumeBatch } = require('../src/reactivation-poll.js');

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

test('pickResumeBatch round-robins across cycles and wraps', () => {
  const q = [{job:{id:'a'}},{job:{id:'b'}},{job:{id:'c'}}];
  let r = pickResumeBatch(q, 0, 2);
  assert.deepStrictEqual(r.batch.map(e=>e.job.id), ['a','b']);
  assert.strictEqual(r.nextCursor, 2);
  r = pickResumeBatch(q, r.nextCursor, 2);           // wraps: c, a
  assert.deepStrictEqual(r.batch.map(e=>e.job.id), ['c','a']);
  assert.strictEqual(r.nextCursor, 1);
});
test('pickResumeBatch handles empty queue', () => {
  assert.deepStrictEqual(pickResumeBatch([], 0, 10), { batch: [], nextCursor: 0 });
});
