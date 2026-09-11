'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  cancelBuyerJob,
  disputeBuyerJob,
  acceptBuyerRework,
  inspectBuyerJob,
} = require('../src/buyer-dispute');

const BUYER = {
  identity: 'alice.agentplatform@',
  iAddress: 'iAliceBuyer',
  address: 'Ralice',
  wif: 'WIF-MUST-NOT-PRINT',
};
const JOB = {
  id: 'job-labour-1',
  jobHash: 'abc123def4567890ffff',
  buyerVerusId: 'alice.agentplatform@',
  sellerVerusId: 'bob.agentplatform@',
  status: 'requested',
};

function stringifyNoWif(value) {
  return JSON.stringify(value);
}

test('dispute source contains buildDisputeMessage and disputeJob', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/buyer-dispute.js'), 'utf8');
  assert.match(src, /buildDisputeMessage/);
  assert.match(src, /disputeJob/);
  assert.match(src, /sovagent-sdk\/dist\//);
  assert.match(src, /J41-DISPUTE\|/);
});

test('cancel on delivered is CANCEL_NOT_REQUESTED and never calls cancelJob', async () => {
  let called = 0;
  const r = await cancelBuyerJob({
    client: {
      getJob: async () => ({ ...JOB, status: 'delivered' }),
      cancelJob: async () => { called += 1; return { ...JOB, status: 'cancelled' }; },
    },
    keys: BUYER,
    jobId: JOB.id,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CANCEL_NOT_REQUESTED');
  assert.equal(r.status, 'delivered');
  assert.equal(called, 0);
});

test('cancel on requested calls cancelJob', async () => {
  const calls = [];
  const r = await cancelBuyerJob({
    client: {
      getJob: async () => JOB,
      cancelJob: async (jobId) => {
        calls.push(jobId);
        return { ...JOB, status: 'cancelled' };
      },
    },
    keys: BUYER,
    jobId: JOB.id,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [JOB.id]);
  assert.equal(r.status, 'cancelled');
  assert.equal(stringifyNoWif(r).includes(BUYER.wif), false);
});

test('cancel of a stranger job never calls cancelJob', async () => {
  let called = 0;
  const r = await cancelBuyerJob({
    client: {
      getJob: async () => JOB,
      cancelJob: async () => { called += 1; },
    },
    keys: { identity: 'eve.agentplatform@', iAddress: 'iEve', address: 'Reve', wif: 'WIF' },
    jobId: JOB.id,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PAY_NOT_BUYER');
  assert.equal(called, 0);
});

test('dispute signs J41-DISPUTE| and calls disputeJob(jobId, reason, signature, timestamp)', async () => {
  const signed = [];
  const sent = [];
  const reason = 'delivery incomplete';
  const r = await disputeBuyerJob({
    client: {
      getJob: async () => ({ ...JOB, status: 'delivered' }),
      disputeJob: async function disputeJob(jobId, why, signature, timestamp) {
        sent.push({ jobId, why, signature, timestamp, argc: arguments.length });
        return { ...JOB, status: 'disputed' };
      },
    },
    keys: BUYER,
    jobId: JOB.id,
    reason,
    network: 'verustest',
    now: 1_700_000_111,
    signMessage: (wif, message, network) => {
      signed.push({ message, network, wifLen: String(wif || '').length });
      return 'sig-from-buyer-wif';
    },
    buildDisputeMessage: (jobHash, why, ts) => `J41-DISPUTE|Job:${jobHash}|Reason:${why}|Ts:${ts}|I am raising a dispute on this job.`,
  });
  assert.equal(r.ok, true);
  assert.equal(signed.length, 1);
  assert.ok(signed[0].message.startsWith('J41-DISPUTE|'));
  assert.match(signed[0].message, /^J41-DISPUTE\|Job:abc123def4567890ffff\|Reason:delivery incomplete\|Ts:1700000111\|/);
  assert.equal(signed[0].network, 'verustest');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jobId, JOB.id);
  assert.equal(sent[0].why, reason);
  assert.equal(sent[0].argc, 4);
  assert.equal(sent[0].signature, 'sig-from-buyer-wif');
  assert.equal(sent[0].timestamp, 1_700_000_111);
  assert.equal(stringifyNoWif(r).includes(BUYER.wif), false);
});

test('unsigned / non-J41-DISPUTE payload is never sent', async () => {
  const sent = [];
  const r = await disputeBuyerJob({
    client: {
      getJob: async () => ({ ...JOB, status: 'delivered' }),
      disputeJob: async (...args) => { sent.push(args); },
    },
    keys: BUYER,
    jobId: JOB.id,
    reason: 'bad',
    signMessage: () => 'sig',
    buildDisputeMessage: () => 'not-a-j41-prefix',
    now: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DISPUTE_UNSIGNED');
  assert.equal(sent.length, 0);
});

test('empty reason never calls disputeJob', async () => {
  let called = 0;
  const r = await disputeBuyerJob({
    client: {
      getJob: async () => ({ ...JOB, status: 'delivered' }),
      disputeJob: async () => { called += 1; },
    },
    keys: BUYER,
    jobId: JOB.id,
    reason: '   ',
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DISPUTE_NO_REASON');
  assert.equal(called, 0);
});

test('rework-accept signs and calls acceptRework with timestamp + signature', async () => {
  const sent = [];
  const r = await acceptBuyerRework({
    client: {
      getJob: async () => ({ ...JOB, status: 'disputed', dispute: { action: 'rework' } }),
      acceptRework: async (jobId, opts) => {
        sent.push({ jobId, opts });
        return { status: 'rework' };
      },
    },
    keys: BUYER,
    jobId: JOB.id,
    network: 'verustest',
    now: 1_700_000_222,
    signMessage: (wif, message) => {
      assert.ok(message.startsWith('J41-REWORK-ACCEPT|'));
      assert.equal(stringifyNoWif({ wif }).includes('WIF-MUST-NOT-PRINT'), true);
      return 'rework-sig';
    },
    buildReworkAcceptMessage: ({ jobHash, timestamp }) => `J41-REWORK-ACCEPT|Job:${jobHash.slice(0, 16)}|Ts:${timestamp}`,
  });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jobId, JOB.id);
  assert.equal(sent[0].opts.signature, 'rework-sig');
  assert.equal(sent[0].opts.timestamp, 1_700_000_222);
  assert.equal(stringifyNoWif(r).includes(BUYER.wif), false);
});

test('inspect prints job.status, dispute action, refund_txid when present', async () => {
  const r = await inspectBuyerJob({
    client: {
      getJob: async () => ({ ...JOB, status: 'disputed', dispute: { action: 'refund' } }),
      getDispute: async () => ({
        action: 'refund',
        refund_txid: 'tx-refund-abc',
        response: { action: 'refund' },
      }),
    },
    keys: BUYER,
    jobId: JOB.id,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'disputed');
  assert.equal(r.disputeAction, 'refund');
  assert.equal(r.refundTxid, 'tx-refund-abc');
  assert.equal(stringifyNoWif(r).includes(BUYER.wif), false);
});

test('CLI cancel/dispute/rework-accept are a thin rind over buyer-dispute', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /\.command\('cancel <buyer-agent-id> <job-id>'\)/);
  assert.match(cli, /\.command\('dispute <buyer-agent-id> <job-id>'\)/);
  assert.match(cli, /\.command\('rework-accept <buyer-agent-id> <job-id>'\)/);

  const cancelStart = cli.indexOf(".command('cancel <buyer-agent-id> <job-id>')");
  const disputeStart = cli.indexOf(".command('dispute <buyer-agent-id> <job-id>')");
  const reworkStart = cli.indexOf(".command('rework-accept <buyer-agent-id> <job-id>')");
  const accessStart = cli.indexOf(".command('access <buyer-agent-id> <seller>')");
  assert.ok(cancelStart > -1 && disputeStart > -1 && reworkStart > -1);

  const rind = cli.slice(cancelStart, accessStart > cancelStart ? accessStart : cancelStart + 4000);
  assert.match(rind, /require\('\.\/buyer-dispute'\)/);
  assert.match(rind, /cancelBuyerJob/);
  assert.match(rind, /disputeBuyerJob/);
  assert.match(rind, /acceptBuyerRework/);
  assert.match(rind, /\.requiredOption\('--reason/);
  assert.match(rind, /sovagent-sdk\/dist\//);
  assert.doesNotMatch(rind, /client\.cancelJob\(/);
  assert.doesNotMatch(rind, /client\.disputeJob\(/);
  assert.doesNotMatch(rind, /console\.(log|error|info).*wif/i);
});

test('CLI inspect of a job prints status / dispute / refund_txid', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const inspectStart = cli.indexOf(".command('inspect <agent-id>");
  assert.ok(inspectStart > -1, 'inspect command missing');
  const next = cli.indexOf(".command('", inspectStart + 10);
  const inspectSrc = cli.slice(inspectStart, next > -1 ? next : inspectStart + 8000);
  assert.match(inspectSrc, /inspectBuyerJob/);
  assert.match(inspectSrc, /refund_txid/);
  assert.match(inspectSrc, /disputeAction|dispute/);
});
