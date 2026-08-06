'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.NODE_ENV = 'test';

const { processInboxForAgent } = require('../src/cli.js');
const { isDeadLettered, recordInboxFailure, MAX_BATCH_FAILURES } = require('../src/inbox-deadletter.js');

const AGENT = { id: 'agent-1', identity: 'a.agentplatform@', wif: 'w', iAddress: 'i1' };

function makeState() {
  return {
    _inboxFailures: new Map(),
    _inboxLastWrite: new Map(),
    _inboxBatchFailures: new Map(),
    _agentErrors: new Map(),
    events: [],
    emitEvent(type, data) { this.events.push({ type, data }); },
  };
}

/** Agent stub. `batch` is what acceptInboxBatch resolves to (or throws). */
function makeAgent(batch, opts = {}) {
  const calls = { batchArgs: [], legacy: [] };
  const agent = {
    client: {
      getIdentityRaw: async () => ({ data: { prevOutput: { txid: opts.prevOutTxid || 'confirmed-tx' } } }),
      getChainInfo: async () => ({ blockHeight: opts.blockHeight || 1000 }),
    },
  };
  if (!opts.noBatchSupport) {
    agent.acceptInboxBatch = async (items) => {
      calls.batchArgs.push(items);
      if (typeof batch === 'function') return batch(items);
      if (batch instanceof Error) throw batch;
      return batch;
    };
  }
  agent.acceptReview = async (id) => { calls.legacy.push(id); };
  agent.acceptAttestationTuple = async (id) => { calls.legacy.push(id); };
  agent.acceptJobRecord = async (id) => { calls.legacy.push(id); };
  return { agent, calls };
}

const emptyResult = () => ({ txid: null, written: [], acked: [], ackFailed: [], rejected: [], deferred: [], alreadyDone: [] });
const item = (id, type = 'review') => ({ id, type });
const DEPS = { verifyInboxJobRecord: async () => ({}), verifyWitness: () => true, network: 'verustest', now: () => 1000 };

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

test('sends all pending items to the SDK in ONE batch call', async () => {
  const state = makeState();
  const { agent, calls } = makeAgent({ ...emptyResult(), txid: 'tx1', acked: ['r1', 'a1'] });
  await processInboxForAgent(agent, AGENT, [item('r1'), item('a1', 'attestation')], state, DEPS);
  assert.strictEqual(calls.batchArgs.length, 1, 'exactly one batch call');
  assert.deepEqual(calls.batchArgs[0].map(i => i.id).sort(), ['a1', 'r1']);
});

test('records the broadcast txid as the agent pending write', async () => {
  const state = makeState();
  const { agent } = makeAgent({ ...emptyResult(), txid: 'tx1', acked: ['r1'] });
  await processInboxForAgent(agent, AGENT, [item('r1')], state, { ...DEPS, expiryHeight: 1200 });
  const lw = state._inboxLastWrite.get('agent-1');
  assert.ok(lw, 'pending write recorded');
  assert.strictEqual(lw.txid, 'tx1');
});

test('excludes dead-lettered items from the batch', async () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'bad', 'boom');
  const { agent, calls } = makeAgent({ ...emptyResult(), txid: 'tx1', acked: ['ok'] });
  await processInboxForAgent(agent, AGENT, [item('bad'), item('ok')], state, DEPS);
  assert.deepEqual(calls.batchArgs[0].map(i => i.id), ['ok']);
});

test('does not call the SDK at all when every item is dead-lettered', async () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'bad', 'boom');
  const { agent, calls } = makeAgent(emptyResult());
  await processInboxForAgent(agent, AGENT, [item('bad')], state, DEPS);
  assert.strictEqual(calls.batchArgs.length, 0);
});

// ---------------------------------------------------------------------------
// Result-bucket mapping — the core retry semantics
// ---------------------------------------------------------------------------

test('acked and alreadyDone clear any prior failure record', async () => {
  const state = makeState();
  recordInboxFailure(state._inboxFailures, 'r1', 'earlier blip');
  recordInboxFailure(state._inboxFailures, 'r2', 'earlier blip');
  const { agent } = makeAgent({ ...emptyResult(), txid: 't', acked: ['r1'], alreadyDone: ['r2'] });
  await processInboxForAgent(agent, AGENT, [item('r1'), item('r2')], state, DEPS);
  assert.strictEqual(state._inboxFailures.has('r1'), false);
  assert.strictEqual(state._inboxFailures.has('r2'), false);
});

test('rejected items are counted and eventually dead-letter', async () => {
  const state = makeState();
  const { agent } = makeAgent({ ...emptyResult(), rejected: [{ id: 'bad', type: 'review', error: 'poison' }] });
  for (let i = 0; i < 5; i++) {
    await processInboxForAgent(agent, AGENT, [item('bad')], state, DEPS);
  }
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'bad'), true);
});

test('deferred and ackFailed are neither counted nor cleared', async () => {
  const state = makeState();
  const { agent } = makeAgent({
    ...emptyResult(), txid: 't',
    deferred: [{ id: 'd1', type: 'review', reason: 'key-collision' }],
    ackFailed: [{ id: 'f1', error: 'timeout' }],
  });
  for (let i = 0; i < 10; i++) {
    await processInboxForAgent(agent, AGENT, [item('d1'), item('f1')], state, DEPS);
  }
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'd1'), false, 'deferred must never dead-letter');
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'f1'), false, 'ackFailed must never dead-letter');
});

test('a deferred item writes on a later cycle', async () => {
  const state = makeState();
  let cycle = 0;
  const { agent } = makeAgent(() => {
    cycle++;
    return cycle === 1
      ? { ...emptyResult(), txid: 't1', acked: ['r1'], deferred: [{ id: 'r2', type: 'review', reason: 'key-collision' }] }
      : { ...emptyResult(), txid: 't2', acked: ['r2'] };
  });
  await processInboxForAgent(agent, AGENT, [item('r1'), item('r2')], state, DEPS);
  state._inboxLastWrite.clear(); // simulate the write confirming between cycles
  await processInboxForAgent(agent, AGENT, [item('r2')], state, DEPS);
  assert.strictEqual(state._inboxFailures.has('r2'), false, 'deferred item eventually succeeds cleanly');
});

// ---------------------------------------------------------------------------
// Batch-level failures — uncounted, but bounded
// ---------------------------------------------------------------------------

test('contention never counts against any item and never escalates', async () => {
  const state = makeState();
  const err = new Error('Transaction rejected by the network');
  const { agent } = makeAgent(err);
  for (let i = 0; i < MAX_BATCH_FAILURES * 2; i++) {
    await processInboxForAgent(agent, AGENT, [item('r1')], state, DEPS);
  }
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'r1'), false);
  assert.strictEqual(state._inboxFailures.has('r1'), false, 'contention must not even start a count');
});

test('repeated non-contention batch failures escalate to per-item counting', async () => {
  // The example must be an error that is genuinely the ITEM's fault. This test
  // used to use 'no UTXOs available for TX fee' — which is literally what the
  // SDK throws for an empty wallet (agent.ts:1380), i.e. an environmental
  // failure that must NEVER escalate. It only passed because FUNDING_PATTERNS
  // did not yet recognise that wording, so a dry wallet was silently striking
  // healthy items. See the companion test below.
  const state = makeState();
  const err = new Error('inbox vdxfData contained no review.* keys');
  const { agent } = makeAgent(err);
  for (let i = 0; i < MAX_BATCH_FAILURES + 5; i++) {
    await processInboxForAgent(agent, AGENT, [item('r1')], state, DEPS);
  }
  assert.ok(state._inboxFailures.has('r1'), 'after escalation the item starts counting so it cannot spin forever');
});

test('a DRY WALLET never escalates, however many cycles it fails', async () => {
  // The property the previous test was accidentally contradicting. Every wording
  // the SDK can produce for "cannot pay the fee" is environmental: not the
  // item's fault, identical for every item on that agent, and resolved by
  // funding the address. Striking items for it is the 2026-08-05 incident.
  for (const msg of [
    'No spendable R-address UTXOs for fee. Fund RWoe... with at least 0.0001 VRSC.',
    'No UTXOs available for TX fee',
    'No UTXOs available — wallet is empty',
    'No spendable UTXOs on RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51',
    'Insufficient funds: need 310000000 satoshis, have 0',
  ]) {
    const state = makeState();
    const { agent } = makeAgent(new Error(msg));
    for (let i = 0; i < MAX_BATCH_FAILURES + 5; i++) {
      await processInboxForAgent(agent, AGENT, [item('r1')], state, DEPS);
    }
    assert.strictEqual(state._inboxFailures.has('r1'), false,
      `a dry wallet must not strike the item: ${msg}`);
    assert.strictEqual(isDeadLettered(state._inboxFailures, 'r1'), false, msg);
  }
});

test('a batch-level failure sets the agent error surface', async () => {
  const state = makeState();
  const { agent } = makeAgent(new Error('Transaction rejected by the network'));
  await processInboxForAgent(agent, AGENT, [item('r1')], state, DEPS);
  assert.match(String(state._agentErrors.get('agent-1')), /contention|rejected/i);
});

// ---------------------------------------------------------------------------
// Pending-write gate
// ---------------------------------------------------------------------------

test('defers the whole agent while its last write is unconfirmed', async () => {
  const state = makeState();
  state._inboxLastWrite.set('agent-1', { txid: 'pending-tx', at: 1000, expiryHeight: 5000 });
  const { agent, calls } = makeAgent(emptyResult(), { prevOutTxid: 'some-older-tx', blockHeight: 1000 });
  await processInboxForAgent(agent, AGENT, [item('r1')], state, { ...DEPS, now: () => 1000 });
  assert.strictEqual(calls.batchArgs.length, 0, 'must not build a second tx while the first is unconfirmed');
  assert.strictEqual(state._inboxFailures.has('r1'), false, 'deferring must not count against the item');
});

test('proceeds once the pending write is confirmed, and clears the gate', async () => {
  const state = makeState();
  state._inboxLastWrite.set('agent-1', { txid: 'my-tx', at: 1000, expiryHeight: 5000 });
  const { agent, calls } = makeAgent({ ...emptyResult(), txid: 'next', acked: ['r1'] }, { prevOutTxid: 'my-tx' });
  await processInboxForAgent(agent, AGENT, [item('r1')], state, DEPS);
  assert.strictEqual(calls.batchArgs.length, 1);
});

// ---------------------------------------------------------------------------
// job_record pre-gate classification
// ---------------------------------------------------------------------------

test('a job_record verification failure counts against the item', async () => {
  const state = makeState();
  const { agent } = makeAgent(emptyResult());
  const deps = { ...DEPS, verifyInboxJobRecord: async () => { throw new Error('witness mismatch'); } };
  for (let i = 0; i < 5; i++) {
    await processInboxForAgent(agent, AGENT, [item('j1', 'job_record')], state, deps);
  }
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'j1'), true);
});

test('a job_record NETWORK failure does NOT count (else API blips dead-letter healthy items)', async () => {
  const state = makeState();
  const { agent } = makeAgent(emptyResult());
  const deps = { ...DEPS, verifyInboxJobRecord: async () => { throw Object.assign(new Error('gateway timeout'), { statusCode: 504 }); } };
  for (let i = 0; i < 10; i++) {
    await processInboxForAgent(agent, AGENT, [item('j1', 'job_record')], state, deps);
  }
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'j1'), false);
});

test('a job_record skip excludes it from the batch without counting', async () => {
  const state = makeState();
  const { agent, calls } = makeAgent({ ...emptyResult(), txid: 't', acked: ['r1'] });
  const deps = { ...DEPS, verifyInboxJobRecord: async () => ({ skip: true, reason: 'not witnessable yet' }) };
  await processInboxForAgent(agent, AGENT, [item('j1', 'job_record'), item('r1')], state, deps);
  assert.deepEqual(calls.batchArgs[0].map(i => i.id), ['r1']);
  assert.strictEqual(state._inboxFailures.has('j1'), false);
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

test('falls back to the legacy per-item path when the SDK lacks acceptInboxBatch', async () => {
  const state = makeState();
  const { agent, calls } = makeAgent(null, { noBatchSupport: true });
  await processInboxForAgent(agent, AGENT, [item('r1'), item('a1', 'attestation')], state, DEPS);
  assert.deepEqual(calls.legacy.sort(), ['a1', 'r1'], 'old SDK still processes items one at a time');
});

test('legacy path still classifies contention as uncounted', async () => {
  const state = makeState();
  const { agent } = makeAgent(null, { noBatchSupport: true });
  agent.acceptReview = async () => { throw new Error('Transaction rejected by the network'); };
  for (let i = 0; i < 10; i++) {
    await processInboxForAgent(agent, AGENT, [item('r1')], state, DEPS);
  }
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'r1'), false,
    'even on an old SDK, contention must not burn the budget');
});
