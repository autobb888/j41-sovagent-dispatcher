'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { dispatchInboxAccept } = require('../src/cli.js');

function spyAgent() {
  const calls = { review: [], job: [], attestation: [] };
  return {
    calls,
    acceptReview: async (id) => { calls.review.push(id); },
    acceptJobRecord: async (id) => { calls.job.push(id); },
    acceptAttestationTuple: async (id) => { calls.attestation.push(id); },
    client: { getInboxItem: async () => ({ data: { vdxfData: {} } }), getJobWitness: async () => ({}) },
  };
}
const deps = { verifyInboxJobRecord: async () => undefined, verifyWitness: async () => ({ verified: true }), network: 'verustest' };

test('attestation item routes to acceptAttestationTuple only', async () => {
  const agent = spyAgent();
  const r = await dispatchInboxAccept(agent, { id: 'x1', type: 'attestation' }, deps);
  assert.deepEqual(agent.calls.attestation, ['x1']);
  assert.deepEqual(agent.calls.review, []);
  assert.deepEqual(agent.calls.job, []);
  assert.equal(r.accepted, true);
});

test('review still routes to acceptReview', async () => {
  const agent = spyAgent();
  await dispatchInboxAccept(agent, { id: 'x2', type: 'review' }, deps);
  assert.deepEqual(agent.calls.review, ['x2']);
  assert.deepEqual(agent.calls.attestation, []);
});

test('job_record transient skip does not accept', async () => {
  const agent = spyAgent();
  const skipDeps = { ...deps, verifyInboxJobRecord: async () => ({ skip: true, reason: 'not yet' }) };
  const r = await dispatchInboxAccept(agent, { id: 'x3', type: 'job_record' }, skipDeps);
  assert.equal(r.skip, true);
  assert.deepEqual(agent.calls.job, []);
});

test('unknown type is a no-op', async () => {
  const agent = spyAgent();
  const r = await dispatchInboxAccept(agent, { id: 'x4', type: 'weird' }, deps);
  assert.equal(r.accepted, false);
});
