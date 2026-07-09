'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.NODE_ENV = 'test';
const { respawnReadyResumes } = require('../src/cli.js');

test('respawns ready resumes oldest-first, respects capacity, dequeues on success', async () => {
  const started = [];
  const state = {
    active: new Map([['busy', {}]]),   // 1 slot used
    reactivationQueue: [
      { job: { id: 'r2' }, agentId: 'a', pausedAt: 2000, pauseTtlMin: 60, readyToRespawn: true },
      { job: { id: 'r1' }, agentId: 'a', pausedAt: 1000, pauseTtlMin: 60, readyToRespawn: true },
      { job: { id: 'notready' }, agentId: 'a', pausedAt: 500, pauseTtlMin: 60, readyToRespawn: false },
    ],
  };
  const deps = {
    startJob: async (st, job) => { started.push(job.id); st.active.set(job.id, {}); },
    findAgentById: () => ({ id: 'a' }),
    maxAgents: 3, // 3 slots total, 1 used → room for 2
  };

  const n = await respawnReadyResumes(state, deps);

  assert.strictEqual(n, 2);
  assert.deepStrictEqual(started, ['r1', 'r2']);              // oldest-first
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'r1')); // dequeued
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'r2'));
  assert.ok(state.reactivationQueue.find(e => e.job.id === 'notready')); // untouched
});

test('does nothing when at capacity', async () => {
  const state = {
    active: new Map([['a', {}], ['b', {}]]),
    reactivationQueue: [{ job: { id: 'r1' }, agentId: 'a', pausedAt: 1, pauseTtlMin: 60, readyToRespawn: true }],
  };
  const n = await respawnReadyResumes(state, { startJob: async () => { throw new Error('should not start'); }, findAgentById: () => ({}), maxAgents: 2 });
  assert.strictEqual(n, 0);
});

// C2 money-safety: startJobContainer swallows its own boot errors (returns without
// adding the job to state.active). The placement check must detect this and re-queue
// the entry so the paid job is not silently dropped.
test('re-queues entry when startJob returns without placing the job in state.active', async () => {
  const state = {
    active: new Map(),
    reactivationQueue: [
      { job: { id: 'r1' }, agentId: 'a', pausedAt: 1000, pauseTtlMin: 60, readyToRespawn: true },
    ],
  };
  const deps = {
    // Simulates startJobContainer swallowing a boot failure: returns normally but
    // never inserts into state.active.
    startJob: async () => { /* no-op — job NOT placed */ },
    findAgentById: () => ({ id: 'a' }),
    maxAgents: 3,
  };

  const n = await respawnReadyResumes(state, deps);

  assert.strictEqual(n, 0, 'count must be 0 — no successful placement');
  assert.strictEqual(state.reactivationQueue.length, 1, 'entry must be re-queued');
  assert.strictEqual(state.reactivationQueue[0].job.id, 'r1');
});
