'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { sweepExpiredQueue, hasMemoryHeadroom } = require('../src/cli.js');

test('sweep removes only expired queued jobs (no dispatcher refund)', async () => {
  const now = 100 * 60000;
  const state = {
    reactivationQueue: [
      { job: { id: 'fresh' }, agentId: 'a', pausedAt: 90 * 60000, pauseTtlMin: 60, readyToRespawn: false },
      { job: { id: 'stale' }, agentId: 'a', pausedAt: 20 * 60000, pauseTtlMin: 60, readyToRespawn: false },
    ],
  };
  const deps = { now: () => now };
  const out = await sweepExpiredQueue(state, deps);
  assert.deepStrictEqual(out, ['stale']);
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'stale'));
  assert.ok(state.reactivationQueue.find(e => e.job.id === 'fresh'));
});

test('hasMemoryHeadroom gates spawns when free RAM is tight', () => {
  const GB = 1024 * 1024 * 1024;
  assert.strictEqual(hasMemoryHeadroom(5 * GB, 2 * GB), true);   // 5 > 2 + 0.5 margin
  assert.strictEqual(hasMemoryHeadroom(2 * GB, 2 * GB), false);  // 2 < 2.5
});
