'use strict';
// C1 guard test: a fresh Executor has a falsy job sentinel (undefined), so the
// guard `if (executor && !executor.job)` fires on a respawned dispute container
// that skipped processJob(). After init() sets this.job, a second call is skipped.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Executor } = require('../src/executors/base.js');

// Minimal concrete executor for testing the guard logic without needing
// LLM credentials or Docker.
class MockExecutor extends Executor {
  async init(job, agent, soulPrompt, opts = {}) {
    this.job = job;
    this.agent = agent;
    this.soulPrompt = soulPrompt;
    this._initCalls = (this._initCalls || 0) + 1;
  }
  async handleMessage() { return ''; }
  async finalize() { return { content: '', hash: '' }; }
}

test('C1: fresh Executor has falsy job (guard fires)', () => {
  const executor = new MockExecutor();
  // Sentinel must be falsy before init() — this is what the guard checks.
  assert.ok(!executor.job, 'executor.job should be falsy before init()');
});

test('C1: after init(), executor.job is truthy (guard skips on second call)', async () => {
  const executor = new MockExecutor();
  const fakeJob = { id: 'test-job', description: 'test', amount: 1, currency: 'VRSCTEST' };
  await executor.init(fakeJob, {}, 'soul');
  assert.ok(executor.job, 'executor.job should be truthy after init()');
  assert.equal(executor.job.id, 'test-job');
});

test('C1: guard fires exactly once — second call with truthy job skips init()', async () => {
  const executor = new MockExecutor();
  const fakeJob = { id: 'job-guard', description: 'test', amount: 1, currency: 'VRSCTEST' };

  // Simulate the guard logic from job-agent.js waitForPostDelivery
  if (executor && !executor.job) {
    await executor.init(fakeJob, {}, 'soul', { isReconnect: true });
  }
  assert.equal(executor._initCalls, 1, 'init called once when job was null');

  // Second pass (e.g., a second rework): executor.job is now truthy → guard skips
  if (executor && !executor.job) {
    await executor.init(fakeJob, {}, 'soul', { isReconnect: true });
  }
  assert.equal(executor._initCalls, 1, 'init NOT called a second time — guard correctly skips');
});
