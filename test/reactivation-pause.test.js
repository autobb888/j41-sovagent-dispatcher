'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { moveJobToReactivationQueue } = require('../src/cli.js');

function fakeState() {
  return {
    active: new Map(),
    reactivationQueue: [],
    available: [],
  };
}
function fakeContainer() {
  const calls = [];
  return { calls, stop: async () => calls.push('stop'), remove: async () => calls.push('remove') };
}

test('pause stops+removes the container, frees the slot, enqueues', async () => {
  const state = fakeState();
  const container = fakeContainer();
  state.active.set('j1', { agentId: 'agent-5', container, startedAt: 1, pauseTtlMin: 60 });

  const ok = await moveJobToReactivationQueue(state, 'j1', { persist: false });

  assert.strictEqual(ok, true);
  assert.deepStrictEqual(container.calls, ['stop', 'remove']);
  assert.strictEqual(state.active.has('j1'), false);       // slot freed
  assert.strictEqual(state.reactivationQueue.length, 1);
  assert.strictEqual(state.reactivationQueue[0].job.id, 'j1');
  assert.strictEqual(state.reactivationQueue[0].readyToRespawn, false);
});

test('pause kills the child process in local mode, frees the slot, enqueues', async () => {
  const state = fakeState();
  const killed = [];
  state.active.set('j2', { agentId: 'agent-5', process: { kill: () => killed.push('kill') }, startedAt: 1, pauseTtlMin: 60 });
  const ok = await moveJobToReactivationQueue(state, 'j2', { persist: false });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(killed, ['kill']);
  assert.strictEqual(state.active.has('j2'), false);
  assert.strictEqual(state.reactivationQueue.length, 1);
});

test('pause on an unknown job is a no-op returning false', async () => {
  const state = fakeState();
  assert.strictEqual(await moveJobToReactivationQueue(state, 'ghost', { persist: false }), false);
});
