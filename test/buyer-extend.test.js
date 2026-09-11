'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isGpuRentalJob,
  assertExtendOpen,
  runBuyerExtend,
} = require('../src/buyer-extend');
const { dualPayTxids } = require('../src/hire-pay');

const BUYER = {
  identity: 'alice.agentplatform@',
  iAddress: 'iAliceBuyer',
  address: 'Ralice',
  wif: 'WIF-MUST-NOT-PRINT',
};
const PAY_ADDR = `R${'A'.repeat(33)}`;
const FEE_ADDR = `i${'B'.repeat(33)}`;

const LABOUR = {
  id: 'job-labour-1',
  jobHash: 'labhash',
  buyerVerusId: 'alice.agentplatform@',
  sellerVerusId: 'bob.agentplatform@',
  status: 'in_progress',
  serviceType: 'agent',
  amount: 1,
  payment: { address: PAY_ADDR, platformFeeAddress: FEE_ADDR, feeAmount: 0.05, verified: true },
};

const GPU = {
  id: 'job-gpu-1',
  jobHash: 'gpuhash',
  buyerVerusId: 'alice.agentplatform@',
  sellerVerusId: 'gpu.sovcompute@',
  status: 'in_progress',
  serviceType: 'gpu-rental',
  amount: 5,
  payment: { address: PAY_ADDR, platformFeeAddress: FEE_ADDR, feeAmount: 0.25, verified: true },
};

function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => { t += Number(ms) || 0; },
  };
}

function mockClient(job, { extensionId = 'ext-1' } = {}) {
  const calls = [];
  return {
    calls,
    getJob: async () => job,
    requestExtension: async (jobId, amount, reason) => {
      calls.push({ fn: 'requestExtension', jobId, amount, reason, at: calls.length });
      return { id: extensionId, jobId, amount, reason, status: 'pending' };
    },
    payExtension: async (jobId, extensionId, agentTxid, feeTxid) => {
      calls.push({ fn: 'payExtension', jobId, extensionId, agentTxid, feeTxid, at: calls.length });
      return { id: extensionId, status: 'paid' };
    },
  };
}

test('labour delivered is EXTEND_NOT_OPEN and never calls requestExtension', async () => {
  const client = mockClient({ ...LABOUR, status: 'delivered' });
  const r = await runBuyerExtend({
    client,
    keys: BUYER,
    jobId: LABOUR.id,
    amount: 1,
    pay: true,
    yes: true,
    sendMultiPayment: async () => { throw new Error('must not pay'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXTEND_NOT_OPEN');
  assert.equal(client.calls.length, 0);
  assert.equal(client.calls.some((c) => c.fn === 'requestExtension'), false);
});

test('labour paused/in_progress is open; completed/cancelled are not', () => {
  assert.equal(assertExtendOpen({ ...LABOUR, status: 'in_progress' }).ok, true);
  assert.equal(assertExtendOpen({ ...LABOUR, status: 'paused' }).ok, true);
  assert.equal(assertExtendOpen({ ...LABOUR, status: 'delivered' }).ok, false);
  assert.equal(assertExtendOpen({ ...LABOUR, status: 'delivered' }).code, 'EXTEND_NOT_OPEN');
  assert.equal(assertExtendOpen({ ...LABOUR, status: 'completed' }).ok, false);
  assert.equal(assertExtendOpen({ ...LABOUR, status: 'requested' }).ok, false);
});

test('GPU Cat-1 delivered is open (payment extends the lease); labour delivered is not', () => {
  assert.equal(isGpuRentalJob(GPU), true);
  assert.equal(isGpuRentalJob(LABOUR), false);
  const deliveredGpu = assertExtendOpen({ ...GPU, status: 'delivered' });
  assert.equal(deliveredGpu.ok, true);
  assert.equal(deliveredGpu.gpu, true);
  assert.equal(assertExtendOpen({ ...GPU, status: 'in_progress' }).ok, true);
  assert.equal(assertExtendOpen({ ...GPU, status: 'paused' }).ok, true);
  assert.equal(assertExtendOpen({ ...GPU, status: 'completed' }).ok, false);
});

test('GPU path calls requestExtension then payExtension', async () => {
  const client = mockClient({ ...GPU, status: 'delivered' });
  const sent = [];
  const stamps = [];
  const r = await runBuyerExtend({
    client,
    keys: BUYER,
    jobId: GPU.id,
    amount: 5,
    reason: 'another hour',
    pay: true,
    yes: true,
    pending: null,
    now: 1_000_000,
    sendMultiPayment: async (outputs) => {
      sent.push(outputs);
      return 'txid-combined';
    },
    savePending: (rec) => { stamps.push(rec); },
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.extensionId, 'ext-1');
  assert.equal(r.txid, 'txid-combined');
  const req = client.calls.find((c) => c.fn === 'requestExtension');
  const pay = client.calls.find((c) => c.fn === 'payExtension');
  assert.ok(req, 'GPU extend must call requestExtension');
  assert.ok(pay, 'GPU extend must call payExtension');
  assert.ok(req.at < pay.at, 'requestExtension must run before payExtension');
  assert.equal(req.jobId, GPU.id);
  assert.equal(req.amount, 5);
  assert.equal(req.reason, 'another hour');
  assert.equal(pay.jobId, GPU.id);
  assert.equal(pay.extensionId, 'ext-1');
  assert.equal(pay.agentTxid, 'txid-combined');
  assert.equal(pay.feeTxid, 'txid-combined');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 2, 'dual outputs when feeAmount is present');
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].kind, 'extension');
  assert.equal(stamps[0].txid, 'txid-combined');
  assert.equal(JSON.stringify(r).includes(BUYER.wif), false, 'never print WIFs');
});

test('PAY_PENDING blocks before requestExtension so no unpaid leftover', async () => {
  const client = mockClient(GPU);
  const r = await runBuyerExtend({
    client,
    keys: BUYER,
    jobId: GPU.id,
    amount: 5,
    pay: true,
    yes: true,
    force: false,
    pending: { txid: 'old', at: 1_000_000, kind: 'hire-pay' },
    now: 1_000_000 + 60_000,
    sendMultiPayment: async () => { throw new Error('must not pay'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PAY_PENDING');
  assert.equal(client.calls.length, 0);
});

test('not the buyer never requests an extension', async () => {
  const client = mockClient(LABOUR);
  const r = await runBuyerExtend({
    client,
    keys: { identity: 'eve.agentplatform@', iAddress: 'iEve', address: 'Reve', wif: 'WIF' },
    jobId: LABOUR.id,
    amount: 1,
    pay: true,
    yes: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PAY_NOT_BUYER');
  assert.equal(client.calls.length, 0);
});

test('--no-pay requests but does not send or payExtension', async () => {
  const client = mockClient({ ...LABOUR, status: 'in_progress' });
  let sent = 0;
  const r = await runBuyerExtend({
    client,
    keys: BUYER,
    jobId: LABOUR.id,
    amount: 1,
    pay: false,
    yes: true,
    sendMultiPayment: async () => { sent += 1; return 'x'; },
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(client.calls.map((c) => c.fn).join(','), 'requestExtension');
  assert.equal(sent, 0);
});

test('dualPayTxids maps a combined sendMultiPayment onto agent+fee', () => {
  const one = dualPayTxids([{ address: PAY_ADDR, amount: 1 }], 'txid-a');
  assert.equal(one.agentTxid, 'txid-a');
  assert.equal(one.feeTxid, undefined);
  const two = dualPayTxids(
    [{ address: PAY_ADDR, amount: 1 }, { address: FEE_ADDR, amount: 0.05 }],
    'txid-b',
  );
  assert.equal(two.agentTxid, 'txid-b');
  assert.equal(two.feeTxid, 'txid-b');
});

test('--wait after broadcast polls waitUnlink; timeout is exit-0', async () => {
  const client = mockClient(GPU);
  const clock = fakeClock();
  const r = await runBuyerExtend({
    client,
    keys: BUYER,
    jobId: GPU.id,
    amount: 5,
    pay: true,
    wait: true,
    yes: true,
    pending: null,
    now: clock.now,
    sleep: clock.sleep,
    sendMultiPayment: async () => 'txid-wait',
    savePending: () => {},
    waitUnlink: async () => ({ cleared: false, pending: { txid: 'txid-wait', at: clock.now() } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.pending, true);
  assert.equal(r.txid, 'txid-wait');
});

test('CLI extend is a thin rind over buyer-extend; --pay default on', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /\.command\('extend <buyer-agent-id> <job-id>'\)/);
  const start = cli.indexOf(".command('extend <buyer-agent-id> <job-id>')");
  assert.ok(start > -1);
  const next = cli.indexOf(".command('access <buyer-agent-id> <seller>')", start);
  const extendSrc = cli.slice(start, next > -1 ? next : start + 2500);
  assert.match(extendSrc, /require\('\.\/buyer-extend'\)/);
  assert.match(extendSrc, /runBuyerExtend/);
  assert.match(extendSrc, /\.requiredOption\('--amount/);
  assert.match(extendSrc, /\.option\('--reason/);
  assert.match(extendSrc, /\.option\('--pay'/);
  assert.match(extendSrc, /\.option\('--wait'/);
  assert.match(extendSrc, /\.option\('--yes'/);
  assert.match(extendSrc, /\.option\('--json'/);
  assert.match(extendSrc, /true/);
  assert.match(extendSrc, /PAY_WAIT_TIMEOUT/);
  assert.match(extendSrc, /waitWalletPendingUnlink/);
  assert.doesNotMatch(extendSrc, /sendMultiPayment\(/, 'broadcast belongs in buyer-extend.js, not cli.js');
  assert.doesNotMatch(extendSrc, /keys\.wif/, 'never print WIFs');
});
