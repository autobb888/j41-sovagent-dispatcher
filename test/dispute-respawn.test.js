'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { queueDisputedJobForRespawn } = require('../src/cli.js');

function baseState() {
  return {
    active: new Map(),
    reactivationQueue: [],
    agents: [{ id: 'agent-1', iAddress: 'iSeller111', identity: 'seller.agentplatform@' }],
    emitted: [],
    emitEvent(type, data) { this.emitted.push({ type, data }); },
  };
}

test('live job forwards dispute.filed via sendToJobAgent (not process.send)', async () => {
  const state = baseState();
  const info = { agentInfo: { id: 'agent-1' } };
  state.active.set('job-live', info);
  const sent = [];
  const r = await queueDisputedJobForRespawn(state, 'job-live', {
    reason: 'bad work',
    sendToJobAgent: (i, m) => { sent.push({ i, m }); return true; },
  });
  assert.equal(r.forwarded, true);
  assert.equal(sent[0].m.type, 'dispute.filed');
  assert.equal(sent[0].m.data.reason, 'bad work');
  assert.equal(state.reactivationQueue.length, 0);
});

test('torn-down job resolves seller, enqueues ready entry, respawns', async () => {
  const state = baseState();
  let respawned = 0;
  const r = await queueDisputedJobForRespawn(state, 'job-gone', {
    agentId: 'agent-1',
    getJob: async () => ({ id: 'job-gone', sellerVerusId: 'iSeller111' }),
    respawnReadyResumes: async () => { respawned++; },
    persistReactivationQueue: () => {},
  });
  assert.equal(r.respawned, true);
  assert.equal(state.reactivationQueue.length, 1);
  const e = state.reactivationQueue[0];
  assert.equal(e.job.id, 'job-gone');
  assert.equal(e.agentId, 'agent-1');
  assert.equal(e.readyToRespawn, true);
  assert.equal(e.dispute, true);
  assert.equal(respawned, 1);
});

test('unresolvable seller emits event and does NOT enqueue', async () => {
  const state = baseState();
  const r = await queueDisputedJobForRespawn(state, 'job-orphan', {
    agentId: 'agent-1',
    getJob: async () => ({ id: 'job-orphan', sellerVerusId: 'iUnknownSeller' }),
    respawnReadyResumes: async () => { throw new Error('must not respawn'); },
    persistReactivationQueue: () => {},
  });
  assert.equal(r.unresolved, true);
  assert.equal(state.reactivationQueue.length, 0);
  assert.ok(state.emitted.find(e => e.type === 'dispute.unresolved_agent'));
});

// B3: when platform returns a job with NO recognized seller field (ownerId only,
// not sellerVerusId/seller/agentVerusId), the function must resolve via the
// provided agentInfo rather than silently dropping as unresolved.
test('B3: job with no known seller field resolves via agentInfo (not unresolved)', async () => {
  const state = baseState();
  let respawned = 0;
  const r = await queueDisputedJobForRespawn(state, 'job-x', {
    agentId: 'agent-1',
    // Job has no sellerVerusId/seller/agentVerusId — only ownerId (unknown field)
    getJob: async () => ({ id: 'job-x', ownerId: 'iSeller111' }),
    respawnReadyResumes: async () => { respawned++; },
    persistReactivationQueue: () => {},
  });
  assert.equal(r.respawned, true, 'should resolve via agentInfo, not drop as unresolved');
  assert.equal(state.reactivationQueue.length, 1);
  assert.equal(state.reactivationQueue[0].agentId, 'agent-1');
  assert.equal(state.reactivationQueue[0].dispute, true);
  assert.equal(state.reactivationQueue[0].readyToRespawn, true);
  assert.equal(respawned, 1);
});

// B3: confirmed agentInfo-present but demonstrably mismatched seller still returns unresolved
// (regression guard — the "unresolvable seller" case must NOT be swallowed by agentInfo fallback).
test('B3: agentInfo present but mismatched sellerId is still unresolved (regression guard)', async () => {
  const state = baseState();
  // seller field present, but names a different address than agent-1's iAddress
  const r = await queueDisputedJobForRespawn(state, 'job-mismatch', {
    agentId: 'agent-1',
    getJob: async () => ({ id: 'job-mismatch', sellerVerusId: 'iUnknownSeller' }),
    respawnReadyResumes: async () => { throw new Error('must not respawn'); },
    persistReactivationQueue: () => {},
  });
  assert.equal(r.unresolved, true);
  assert.equal(state.reactivationQueue.length, 0);
  assert.ok(state.emitted.find(e => e.type === 'dispute.unresolved_agent'));
});
