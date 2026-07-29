'use strict';
/**
 * Cross-repo contract test.
 *
 * Every other dispatcher test stubs `acceptInboxBatch`, so if the SDK changed the
 * shape of its result nothing here would notice until production. This is the one
 * test that imports the REAL linked SDK dist and asserts the contract the
 * dispatcher's processInboxForAgent actually consumes.
 *
 * If this fails after an SDK bump, the dispatcher's result-bucket handling is
 * reading fields that no longer exist — check src/cli.js processInboxForAgent.
 */
const test = require('node:test');
const assert = require('node:assert');

const SDK = require('@junction41/sovagent-sdk/dist/index.js');
const { J41Agent } = require('@junction41/sovagent-sdk/dist/agent.js');

test('the linked SDK exposes acceptInboxBatch', () => {
  assert.strictEqual(typeof J41Agent.prototype.acceptInboxBatch, 'function',
    'dispatcher batching requires SDK >= 2.12.0');
});

test('the linked SDK still exposes the worker-attach ACK methods', () => {
  // Guards against a regression in the other direction — these were the reason
  // for the 2.11.0 republish and the dispatcher calls them on every job.
  const { J41Client } = SDK;
  assert.strictEqual(typeof J41Client.prototype.confirmWorkerAttached, 'function');
  assert.strictEqual(typeof J41Client.prototype.reportWorkerAttachFailed, 'function');
});

test('the gate helpers the dispatcher reasons about are exported', () => {
  for (const fn of ['inboxAllowlistForType', 'buildInboxVdxfAdditions', 'isAlreadyProcessed', 'valueAlreadyOnChain']) {
    assert.strictEqual(typeof SDK[fn], 'function', `${fn} must be exported`);
  }
});

test('InboxBatchResult carries every field processInboxForAgent consumes', async () => {
  // Drive a real (empty) batch through the real method — no network, no wallet.
  const { generateKeypair } = require('@junction41/sovagent-sdk/dist/identity/keypair.js');
  const kp = generateKeypair('verustest');
  const agent = new J41Agent({
    apiUrl: 'https://api.example.invalid', wif: kp.wif,
    iAddress: 'iContractTest0000000000000000000000', identityName: 'contract.agentplatform@',
  });
  const res = await agent.acceptInboxBatch([]);

  // These are exactly the fields src/cli.js reads off the result.
  for (const key of ['txid', 'expiryHeight', 'written', 'acked', 'ackFailed', 'rejected', 'deferred', 'alreadyDone']) {
    assert.ok(key in res, `InboxBatchResult must expose '${key}' — processInboxForAgent reads it`);
  }
  assert.ok(Array.isArray(res.written));
  assert.ok(Array.isArray(res.acked));
  assert.ok(Array.isArray(res.ackFailed));
  assert.ok(Array.isArray(res.rejected));
  assert.ok(Array.isArray(res.deferred));
  assert.ok(Array.isArray(res.alreadyDone));
  assert.strictEqual(res.txid, null, 'an empty batch performs no chain write');
  assert.strictEqual(res.expiryHeight, null);
});

test('the per-type allowlists are exactly one key each (52f8d07 invariant, live SDK)', () => {
  const { inboxAllowlistForType } = SDK;
  assert.strictEqual([...inboxAllowlistForType('review')].length, 1);
  assert.strictEqual([...inboxAllowlistForType('attestation')].length, 1);
  // review and attestation must never share a key
  const [rev] = [...inboxAllowlistForType('review')];
  const [att] = [...inboxAllowlistForType('attestation')];
  assert.notStrictEqual(rev, att);
});
