// test/sign-broker.test.js
// The broker is a CONSTRAINED signer: a compromised container cannot inflate
// the amount, sign for another job, or sign an arbitrary message.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { generateKeypair, verifyMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { buildAcceptMessage } = require('@junction41/sovagent-sdk/dist/signing/messages.js');
const { buildBrokeredMessage, signBrokeredRequest } = require('../src/sign-broker.js');

const NET = 'verustest';
const JOB = { id: 'job-1', jobHash: 'a'.repeat(64), buyerVerusId: 'buyer@', amount: 5, currency: 'VRSCTEST' };
const NOW = 1_700_000_000;

test('accept: amount comes from the authoritative job, NOT the request', () => {
  // Compromised container tries to inflate the amount 10x via the request.
  const { message } = buildBrokeredMessage(JOB, { type: 'accept', jobId: 'job-1', amount: 50, buyerVerusId: 'attacker@' }, NOW);
  // The signed message must reflect the REAL job amount + buyer, ignoring the request.
  assert.strictEqual(message, buildAcceptMessage({ jobHash: JOB.jobHash, buyerVerusId: 'buyer@', amount: 5, currency: 'VRSCTEST', timestamp: NOW }));
  assert.ok(message.includes('Amt:5 VRSCTEST'));
  assert.ok(!message.includes('Amt:50'));
  assert.ok(!message.includes('attacker@'));
});

test('rejects signing for a different job', () => {
  assert.throws(() => buildBrokeredMessage(JOB, { type: 'accept', jobId: 'job-OTHER' }, NOW), (e) => e.code === 'JOB_MISMATCH');
});

test('rejects unknown / arbitrary message types (no oracle)', () => {
  for (const type of ['payment', 'identity_update', 'raw', 'arbitrary', 'J41-DEPOSIT-REPORT']) {
    assert.throws(() => buildBrokeredMessage(JOB, { type, jobId: 'job-1' }, NOW), (e) => e.code === 'UNSUPPORTED_TYPE');
  }
});

test('deliver: requires a well-formed delivery hash; binds to authoritative jobHash', () => {
  const good = crypto.randomBytes(32).toString('hex');
  const { message } = buildBrokeredMessage(JOB, { type: 'deliver', jobId: 'job-1', deliveryHash: good }, NOW);
  assert.ok(message.startsWith(`J41-DELIVER|Job:${JOB.jobHash}|Delivery:${good}|`));
  assert.throws(() => buildBrokeredMessage(JOB, { type: 'deliver', jobId: 'job-1', deliveryHash: 'not-a-hash' }, NOW), (e) => e.code === 'BAD_DELIVERY_HASH');
});

test('dispute_respond: only allow-listed actions', () => {
  for (const action of ['refund', 'rework', 'rejected']) {
    assert.ok(buildBrokeredMessage(JOB, { type: 'dispute_respond', jobId: 'job-1', action }, NOW).message.includes(`Action:${action}`));
  }
  assert.throws(() => buildBrokeredMessage(JOB, { type: 'dispute_respond', jobId: 'job-1', action: 'drain' }, NOW), (e) => e.code === 'BAD_ACTION');
});

test('signBrokeredRequest produces a signature valid for the agent, over the brokered message', () => {
  const kp = generateKeypair(NET);
  const res = signBrokeredRequest({ job: JOB, request: { type: 'accept', jobId: 'job-1', amount: 999 }, wif: kp.wif, network: NET, now: NOW });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.timestamp, NOW);
  // Signature verifies against the agent's address over the BROKER-built message (real amount).
  assert.ok(verifyMessage(res.message, kp.address, res.signature, NET));
  assert.ok(res.message.includes('Amt:5 VRSCTEST'));
});

test('signBrokeredRequest returns a policy error (not a throw) on violation', () => {
  const kp = generateKeypair(NET);
  const res = signBrokeredRequest({ job: JOB, request: { type: 'payment', jobId: 'job-1' }, wif: kp.wif, network: NET, now: NOW });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'UNSUPPORTED_TYPE');
});
