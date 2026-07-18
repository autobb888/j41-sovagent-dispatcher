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

// B2: expired dispute entries emit dispute.surfacing_expired and do NOT log the
// false "platform auto-cancels/refunds" message.
test('B2: expired dispute entry emits dispute.surfacing_expired event', async () => {
  const now = 100 * 60000;
  const emitted = [];
  const state = {
    reactivationQueue: [
      { job: { id: 'dispute-job-abc123' }, agentId: 'a', pausedAt: 10 * 60000, pauseTtlMin: 60, readyToRespawn: true, dispute: true },
    ],
    emitEvent(type, data) { emitted.push({ type, data }); },
  };
  const deps = { now: () => now };
  const out = await sweepExpiredQueue(state, deps);
  assert.deepStrictEqual(out, ['dispute-job-abc123']);
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'dispute-job-abc123'), 'entry removed');
  assert.ok(emitted.find(e => e.type === 'dispute.surfacing_expired' && e.data.jobId === 'dispute-job-abc123'), 'dispute.surfacing_expired emitted');
});

test('B2: expired non-dispute entry does NOT emit dispute.surfacing_expired', async () => {
  const now = 100 * 60000;
  const emitted = [];
  const state = {
    reactivationQueue: [
      { job: { id: 'normal-job-xyz' }, agentId: 'a', pausedAt: 10 * 60000, pauseTtlMin: 60, readyToRespawn: false },
    ],
    emitEvent(type, data) { emitted.push({ type, data }); },
  };
  const deps = { now: () => now };
  const out = await sweepExpiredQueue(state, deps);
  assert.deepStrictEqual(out, ['normal-job-xyz']);
  assert.ok(!emitted.find(e => e.type === 'dispute.surfacing_expired'), 'no dispute event for normal entry');
});

test('hasMemoryHeadroom gates spawns when free RAM is tight', () => {
  const GB = 1024 * 1024 * 1024;
  assert.strictEqual(hasMemoryHeadroom(5 * GB, 2 * GB), true);   // 5 > 2 + 0.5 margin
  assert.strictEqual(hasMemoryHeadroom(2 * GB, 2 * GB), false);  // 2 < 2.5
});
