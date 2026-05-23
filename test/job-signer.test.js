'use strict';
/**
 * job-signer tests — verify the unified JobSigner surface that `job-agent.js`
 * uses inside containers. Both modes (local-WIF and broker-channel) must
 * expose the same API; the only difference is where the bytes physically get
 * signed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { generateKeypair, verifyMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { buildAcceptMessage } = require('@junction41/sovagent-sdk/dist/signing/messages.js');
const { createJobSigner, createLocalSigner, createBrokerSigner } = require('../src/job-signer.js');
const { SignChannelHost } = require('../src/sign-channel-host.js');
const { SignChannelClient } = require('../src/sign-channel-client.js');

const NET = 'verustest';

test('local mode: signAccept builds + signs the canonical accept message in-process', async () => {
  const kp = generateKeypair(NET);
  const signer = createLocalSigner({ wif: kp.wif, network: NET });
  assert.strictEqual(signer.mode, 'local');

  const res = await signer.signAccept({
    jobId: 'job-1',
    jobHash: 'a'.repeat(64),
    buyerVerusId: 'buyer.agentplatform@',
    amount: 5,
    currency: 'VRSCTEST',
  });
  // The local signer builds the canonical message itself (using jobHash/buyer/
  // amount/currency from the caller — they're not authoritative in local mode).
  const expected = buildAcceptMessage({
    jobHash: 'a'.repeat(64),
    buyerVerusId: 'buyer.agentplatform@',
    amount: 5,
    currency: 'VRSCTEST',
    timestamp: res.timestamp,
  });
  assert.strictEqual(res.message, expected);
  assert.ok(verifyMessage(res.message, kp.address, res.signature, NET));
});

test('local mode: signMessage signs arbitrary text', async () => {
  const kp = generateKeypair(NET);
  const signer = createLocalSigner({ wif: kp.wif, network: NET });
  const sig = await signer.signMessage('opaque-challenge-no-pipe');
  assert.ok(verifyMessage('opaque-challenge-no-pipe', kp.address, sig, NET));
});

test('local mode: executeOnChain throws (broker-only)', async () => {
  const signer = createLocalSigner({ wif: 'irrelevant', network: NET });
  await assert.rejects(
    () => signer.executeOnChain('jobCompletionUpdate', {}),
    /broker mode/,
  );
});

test('broker mode: signAccept sends only {type, jobId} to broker (no amount/buyer leakage)', async () => {
  const kp = generateKeypair(NET);
  const channelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'j41-jobsigner-'));
  const job = { id: 'job-X', jobHash: 'b'.repeat(64), buyerVerusId: 'buyer@', amount: 5, currency: 'VRSCTEST' };
  const host = new SignChannelHost({
    channelDir, jobId: job.id, wif: kp.wif, network: NET,
    getJob: async () => job,
  });
  await host.start();
  const client = new SignChannelClient({ channelDir, timeoutMs: 3000 });
  const signer = createBrokerSigner({ channelClient: client });
  assert.strictEqual(signer.mode, 'broker');

  try {
    // Caller passes "wrong" amount/buyer — broker rebuilds from authoritative job
    const res = await signer.signAccept({
      jobId: 'job-X',
      jobHash: 'a'.repeat(64),         // ignored by broker
      buyerVerusId: 'attacker@',      // ignored by broker
      amount: 999_999,                // ignored by broker
      currency: 'GARBAGE',            // ignored by broker
    });
    assert.ok(res.message.includes('Amt:5 VRSCTEST'), 'broker rebuilds amount/currency from authoritative job');
    assert.ok(res.message.includes('Buyer:buyer@'), 'broker rebuilds buyer from authoritative job');
    assert.ok(res.message.includes(`Job:${job.jobHash}`), 'broker rebuilds jobHash from authoritative job');
    assert.ok(verifyMessage(res.message, kp.address, res.signature, NET));
  } finally {
    await host.destroy();
  }
});

test('broker mode: executeOnChain delegates to host-side executor', async () => {
  const kp = generateKeypair(NET);
  const channelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'j41-jobsigner-'));
  const job = { id: 'job-X', jobHash: 'c'.repeat(64) };
  let receivedCtx = null;
  const host = new SignChannelHost({
    channelDir, jobId: job.id, wif: kp.wif, network: NET,
    getJob: async () => job,
    executors: {
      myExecutor: async (params, ctx) => {
        receivedCtx = ctx;
        return { ok: true, echo: params.value };
      },
    },
  });
  await host.start();
  const client = new SignChannelClient({ channelDir, timeoutMs: 3000 });
  const signer = createBrokerSigner({ channelClient: client });

  try {
    const result = await signer.executeOnChain('myExecutor', { value: 42 });
    assert.deepStrictEqual(result, { ok: true, echo: 42 });
    assert.strictEqual(receivedCtx.wif, kp.wif, 'host-side ctx carries WIF, client never sees it');
  } finally {
    await host.destroy();
  }
});

test('createJobSigner picks local when J41_SIGNING_BROKER is unset', () => {
  const signer = createJobSigner({ wif: 'fake-wif', network: NET, brokerEnabled: false });
  assert.strictEqual(signer.mode, 'local');
});

test('createJobSigner throws if broker enabled without a channelClient', () => {
  assert.throws(
    () => createJobSigner({ wif: 'fake', network: NET, brokerEnabled: true }),
    /no channelClient supplied/,
  );
});

test('createJobSigner picks broker when J41_SIGNING_BROKER=1', async () => {
  const channelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'j41-jobsigner-'));
  await fs.mkdir(path.join(channelDir, 'req'), { recursive: true });
  await fs.mkdir(path.join(channelDir, 'resp'), { recursive: true });
  const client = new SignChannelClient({ channelDir, timeoutMs: 100 });
  const signer = createJobSigner({ wif: 'unused', network: NET, channelClient: client, brokerEnabled: true });
  assert.strictEqual(signer.mode, 'broker');
});
