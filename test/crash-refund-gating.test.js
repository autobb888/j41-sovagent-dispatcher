'use strict';
// Money-safety regression: crash-recovery refunds (refundAbandonedJob + handleCrashRecovery)
// must NOT auto-send. All outbound refunds require owner approval via the CLI
// (`j41-dispatcher refunds approve <jobId>`). Entries land in the durable ledger
// with status:'pending_approval' and stay there until explicitly approved.
//
// This test drives refundAbandonedJob directly and asserts:
//   (a) sendCurrency is NEVER called
//   (b) the ledger entry is written with status:'pending_approval'
//   (c) the entry persists in the ledger (not deleted after the call)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-crash-refund-gate-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const j41Dir = path.join(TEST_HOME, '.j41');
const dispDir = path.join(j41Dir, 'dispatcher');
fs.mkdirSync(dispDir, { recursive: true });

// Seed allowlist so the address check inside attemptPendingRefund doesn't trip
// (we assert sendCurrency is never reached, but keeping the test hermetic).
const allowlistPath = path.join(j41Dir, 'financial-allowlist.json');
fs.writeFileSync(allowlistPath, JSON.stringify({
  permanent: [{ address: 'iBuyerCrash', added: '2026-01-01T00:00:00.000Z' }],
  operator: [],
  active_jobs: [],
}, null, 2));

const { refundAbandonedJob } = require('../src/cli.js');

const PENDING_REFUNDS_PATH = path.join(dispDir, 'pending-refunds.json');

// A paid active-job entry as stored by persistActiveJobs.
const activePaidJob = {
  jobAmount: 6,
  buyerPayAddress: 'iBuyerCrash',
  currency: 'VRSCTEST',
  agentInfoId: 'agent-crash-1',
};

test('refundAbandonedJob does NOT call sendCurrency', async () => {
  const sendCalls = [];
  const state = {
    agents: [{ id: 'agent-crash-1', identity: 'test@', iAddress: 'iCrash', wif: 'wif-crash' }],
    agentSessions: new Map(),
    _testAgentSession: {
      sendCurrency: async (addr, amt) => {
        sendCalls.push({ addr, amt });
        throw new Error('MUST NOT SEND during crash recovery');
      },
      client: {
        submitRefundTxid: async () => {},
        sendChatMessage: async () => {},
      },
    },
  };

  // Ensure ledger starts empty for this job.
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({}, null, 2));

  await refundAbandonedJob(state, 'job-crash-1', activePaidJob);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called for crash-recovery refund');
});

test('refundAbandonedJob writes ledger entry with status:pending_approval', async () => {
  const state = {
    agents: [{ id: 'agent-crash-1', identity: 'test@', iAddress: 'iCrash', wif: 'wif-crash' }],
    agentSessions: new Map(),
    _testAgentSession: {
      sendCurrency: async () => { throw new Error('MUST NOT SEND'); },
      client: { submitRefundTxid: async () => {}, sendChatMessage: async () => {} },
    },
  };

  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({}, null, 2));

  await refundAbandonedJob(state, 'job-crash-2', activePaidJob);

  const ledger = JSON.parse(fs.readFileSync(PENDING_REFUNDS_PATH, 'utf8'));
  assert.ok(ledger['job-crash-2'], 'entry must exist in ledger');
  assert.equal(ledger['job-crash-2'].status, 'pending_approval', 'status must be pending_approval');
  assert.equal(typeof ledger['job-crash-2'].reason, 'string', 'reason must be present');
  assert.equal(ledger['job-crash-2'].buyerAddress, 'iBuyerCrash');
  assert.equal(ledger['job-crash-2'].refundAmount, 6);
});

test('refundAbandonedJob entry remains in ledger (not auto-deleted)', async () => {
  const state = {
    agents: [{ id: 'agent-crash-1', identity: 'test@', iAddress: 'iCrash', wif: 'wif-crash' }],
    agentSessions: new Map(),
    _testAgentSession: {
      sendCurrency: async () => { throw new Error('MUST NOT SEND'); },
      client: { submitRefundTxid: async () => {}, sendChatMessage: async () => {} },
    },
  };

  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({}, null, 2));

  await refundAbandonedJob(state, 'job-crash-3', activePaidJob);

  const ledger = JSON.parse(fs.readFileSync(PENDING_REFUNDS_PATH, 'utf8'));
  assert.ok(ledger['job-crash-3'], 'entry must persist in ledger — awaiting approval, not auto-deleted');
});
