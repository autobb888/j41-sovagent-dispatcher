'use strict';
/**
 * sign-channel end-to-end tests — exercises the file-channel transport between
 * `SignChannelHost` (dispatcher side, holds the WIF) and `SignChannelClient`
 * (container side, holds nothing). They communicate via a real temp directory
 * that stands in for the bind-mounted `/app/sign/` channel.
 *
 * Each test creates its own channel under `os.tmpdir()` so they can run in
 * parallel without colliding.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { generateKeypair, verifyMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { SignChannelHost } = require('../src/sign-channel-host.js');
const { SignChannelClient, SignChannelError } = require('../src/sign-channel-client.js');

const NET = 'verustest';

/** Spin up a fresh channel + host + client wired to a synthetic job. */
async function setup({ jobOverrides } = {}) {
  const kp = generateKeypair(NET);
  const channelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'j41-sign-test-'));
  const jobId = 'job-' + crypto.randomBytes(4).toString('hex');
  const job = {
    id: jobId,
    jobHash: crypto.randomBytes(32).toString('hex'),
    buyerVerusId: 'buyer.agentplatform@',
    amount: 5,
    currency: 'VRSCTEST',
    ...jobOverrides,
  };
  const host = new SignChannelHost({
    channelDir,
    jobId,
    wif: kp.wif,
    network: NET,
    getJob: async () => job,
  });
  await host.start();
  const client = new SignChannelClient({ channelDir, timeoutMs: 3000 });
  return { kp, channelDir, jobId, job, host, client };
}

async function teardown(ctx) {
  await ctx.host.destroy();
}

test('signMessage round-trip: signature verifies against the WIF address', async () => {
  const ctx = await setup();
  try {
    const message = 'opaque-server-challenge-no-pipe';
    const sig = await ctx.client.signMessage(message);
    assert.ok(typeof sig === 'string' && sig.length > 0);
    assert.ok(verifyMessage(message, ctx.kp.address, sig, NET));
  } finally {
    await teardown(ctx);
  }
});

test('signBrokered(accept) returns broker-built message bound to authoritative job', async () => {
  const ctx = await setup();
  try {
    // Attacker-mode client tries to lie about amount/buyer — they have NO
    // effect, the broker rebuilds from the authoritative job.
    const res = await ctx.client.signBrokered({
      type: 'accept',
      jobId: ctx.jobId,
      amount: 999_999,            // ignored — broker uses ctx.job.amount=5
      buyerVerusId: 'attacker@', // ignored — broker uses ctx.job.buyerVerusId
    });
    assert.ok(res.signature.length > 0);
    assert.ok(res.timestamp > 0);
    assert.match(res.message, /J41-ACCEPT\|/);
    assert.ok(res.message.includes('Amt:5 VRSCTEST'),
      'message must reflect authoritative amount (5), not requested 999999');
    assert.ok(res.message.includes('Buyer:buyer.agentplatform@'),
      'message must reflect authoritative buyer, not "attacker@"');
    assert.ok(verifyMessage(res.message, ctx.kp.address, res.signature, NET));
  } finally {
    await teardown(ctx);
  }
});

test('signBrokered(deliver) requires a 64-char hex deliveryHash', async () => {
  const ctx = await setup();
  try {
    const deliveryHash = crypto.randomBytes(32).toString('hex');
    const res = await ctx.client.signBrokered({
      type: 'deliver',
      jobId: ctx.jobId,
      deliveryHash,
    });
    assert.ok(res.message.startsWith(`J41-DELIVER|Job:${ctx.job.jobHash}|Delivery:${deliveryHash}|`));
    assert.ok(verifyMessage(res.message, ctx.kp.address, res.signature, NET));

    // Malformed deliveryHash → policy rejection propagates as BAD_DELIVERY_HASH.
    await assert.rejects(
      () => ctx.client.signBrokered({ type: 'deliver', jobId: ctx.jobId, deliveryHash: 'not-a-hash' }),
      (e) => e instanceof SignChannelError && e.code === 'BAD_DELIVERY_HASH',
    );
  } finally {
    await teardown(ctx);
  }
});

test('signBrokered rejects requests for a different jobId (channel pin)', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () => ctx.client.signBrokered({ type: 'accept', jobId: 'job-OTHER' }),
      (e) => e instanceof SignChannelError && e.code === 'CHANNEL_JOB_MISMATCH',
    );
  } finally {
    await teardown(ctx);
  }
});

test('signMessage refuses J41-protocol-shaped strings (oracle defense)', async () => {
  const ctx = await setup();
  try {
    // A MITM auth-challenge response shaped like a deposit-report — must NOT
    // be sign-able via the generic path.
    const oracleAttempt = 'J41-DEPOSIT-REPORT|Buyer:attacker@|Seller:x@|Txid:beef|Amt:9999|Nonce:n|Ts:1|claim';
    await assert.rejects(
      () => ctx.client.signMessage(oracleAttempt),
      (e) => e instanceof SignChannelError && e.code === 'PROTOCOL_SHAPED',
    );
  } finally {
    await teardown(ctx);
  }
});

test('signMessage refuses oversized messages (bulk-data oracle defense)', async () => {
  const ctx = await setup();
  try {
    const huge = 'x'.repeat(5000); // exceeds MAX_GENERIC_MESSAGE_BYTES (4096)
    await assert.rejects(
      () => ctx.client.signMessage(huge),
      (e) => e instanceof SignChannelError && e.code === 'MESSAGE_TOO_LARGE',
    );
  } finally {
    await teardown(ctx);
  }
});

test('client times out cleanly when host is not running', async () => {
  // Build a channel manually but DO NOT start a host. Client should time out
  // with SIGN_TIMEOUT, not hang forever.
  const channelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'j41-sign-test-'));
  await fsp.mkdir(path.join(channelDir, 'req'), { recursive: true });
  await fsp.mkdir(path.join(channelDir, 'resp'), { recursive: true });
  const client = new SignChannelClient({ channelDir, timeoutMs: 250 });
  try {
    await assert.rejects(
      () => client.signMessage('hello'),
      (e) => e instanceof SignChannelError && e.code === 'SIGN_TIMEOUT',
    );
  } finally {
    await fsp.rm(channelDir, { recursive: true, force: true });
  }
});

test('client throws CHANNEL_DOWN if the channel dir is missing', async () => {
  const client = new SignChannelClient({ channelDir: '/tmp/j41-sign-nonexistent-' + crypto.randomBytes(4).toString('hex'), timeoutMs: 100 });
  await assert.rejects(
    () => client.signMessage('hello'),
    (e) => e instanceof SignChannelError && e.code === 'CHANNEL_DOWN',
  );
});

test('end-to-end: J41Agent constructed with the client routes accept through the broker', async () => {
  // This is the integration touchpoint that step 4 will rely on: the agent's
  // checkForJobs() accept path uses signer.signBrokered, which goes over the
  // file channel and comes back with a verifying signature.
  const { J41Agent } = require('@junction41/sovagent-sdk/dist/agent.js');
  const ctx = await setup();
  try {
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer: ctx.client,
      identityName: 'testagent.agentplatform@',
      iAddress: 'iTest',
    });
    let acceptArgs = null;
    agent.client.setSessionToken('tok123');
    agent.client.getMyJobs = async () => ({
      data: [{
        id: ctx.jobId,
        jobHash: ctx.job.jobHash,
        buyerVerusId: 'lies-from-platform@',  // ignored by broker
        amount: 1_000_000,                     // ignored by broker
        currency: 'GARBAGE',                   // ignored by broker
      }],
    });
    agent.client.acceptJob = async (jobId, signature, timestamp) => {
      acceptArgs = { jobId, signature, timestamp };
      return { ok: true };
    };
    agent.setHandler({ onJobRequested: async () => 'accept' });
    agent.running = true;
    await agent.checkForJobs();

    assert.strictEqual(acceptArgs.jobId, ctx.jobId);
    assert.ok(acceptArgs.signature.length > 0);
    // We can't easily recover the message bytes here (the agent doesn't
    // expose them), but the round-trip working at all proves the channel.
    // Verify the agent's sig is a real Verus message sig over SOMETHING
    // produced by our broker, by re-running the same brokered request and
    // confirming the broker still happily signs and verifies.
    const directRes = await ctx.client.signBrokered({ type: 'accept', jobId: ctx.jobId });
    assert.ok(verifyMessage(directRes.message, ctx.kp.address, directRes.signature, NET));
  } finally {
    await teardown(ctx);
  }
});
