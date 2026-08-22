'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-td-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const {
  handleWebhookEvent,
  stopJobContainer,
  stopJobLocal,
  _cleanupCompletedJobs,
} = require('../src/cli.js');

function rentalState({ status = 'in_progress', leaseState = 'ready', expiresAt = 9e15 } = {}) {
  const released = [];
  const stopped = [];
  const startedContainers = [];
  const agentInfo = { id: 'gpu-1', identity: 'gpu-1@', address: 'Rgpu' };
  const container = { stop: async () => { stopped.push('container.stop'); } };
  const lease = { id: 'home:1', jobId: 'job-1', state: leaseState, expiresAt };
  const state = {
    agents: [agentInfo],
    active: new Map([['job-1', {
      kind: 'gpu-rental',
      leaseId: 'home:1',
      agentId: 'gpu-1',
      agentInfo,
      container,
    }]]),
    available: [],
    queue: [],
    seen: new Map(),
    retries: new Map(),
    pendingPayment: new Map(),
    _lastSentStatus: new Map(),
    _lastExtensionCheck: new Map(),
    _pendingWorkspace: new Map(),
    emitEvent() {},
    computeSupply: {
      getLeases() { return [lease]; },
      async releaseLease(l) { released.push(l.id); l.state = 'released'; },
    },
    _testAgentSession: {
      client: {
        async getJob() { return { id: 'job-1', status }; },
      },
    },
  };
  return { state, released, stopped, startedContainers, lease, container };
}

test('stopJobContainer on a gpu-rental releases the lease and does not call container.stop', async () => {
  const { state, released, stopped } = rentalState();
  await stopJobContainer(state, 'job-1');
  assert.deepEqual(released, ['home:1']);
  assert.equal(stopped.length, 0);
  assert.equal(state.active.has('job-1'), false);
  assert.equal(state.available[0] && state.available[0].id, 'gpu-1');
});

test('stopJobLocal on a gpu-rental is the same kind-aware stop (no process.kill)', async () => {
  const { state, released, stopped } = rentalState();
  await stopJobLocal(state, 'job-1');
  assert.deepEqual(released, ['home:1']);
  assert.equal(stopped.length, 0);
  assert.equal(state.active.has('job-1'), false);
});

test('handleWebhookEvent job.cancelled on gpu-rental releases the lease, not container.stop', async () => {
  const { state, released, stopped } = rentalState();
  await handleWebhookEvent(state, 'gpu-1', {
    event: 'job.cancelled',
    data: { jobId: 'job-1' },
  });
  assert.deepEqual(released, ['home:1']);
  assert.equal(stopped.length, 0);
  assert.equal(state.active.has('job-1'), false);
  assert.equal(state.available[0] && state.available[0].id, 'gpu-1');
});

test('cleanup of a delivered gpu-rental with future expiresAt keeps the box (buyer still owns it)', async () => {
  const { state, released, stopped } = rentalState({ status: 'delivered', expiresAt: Date.now() + 60_000 });
  await _cleanupCompletedJobs(state);
  assert.equal(state.active.has('job-1'), true);
  assert.equal(released.length, 0);
  assert.equal(stopped.length, 0);
});

test('cleanup of a cancelled gpu-rental yanks the box without startJobContainer', async () => {
  const { state, released, stopped } = rentalState({ status: 'cancelled', expiresAt: Date.now() + 60_000 });
  await _cleanupCompletedJobs(state);
  assert.equal(state.active.has('job-1'), false);
  assert.deepEqual(released, ['home:1']);
  assert.equal(stopped.length, 0);
});

test('cleanup of a live gpu-rental with an unexpired lease leaves the slot in place', async () => {
  const { state, released } = rentalState({ status: 'in_progress', expiresAt: Date.now() + 60_000 });
  await _cleanupCompletedJobs(state);
  assert.equal(state.active.has('job-1'), true);
  assert.equal(released.length, 0);
});

test('cleanup of a gpu-rental with an expired lease frees the slot', async () => {
  const { state, released } = rentalState({ status: 'in_progress', expiresAt: 1 });
  await _cleanupCompletedJobs(state);
  assert.equal(state.active.has('job-1'), false);
  assert.deepEqual(released, ['home:1']);
});
