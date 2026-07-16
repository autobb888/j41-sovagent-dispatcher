'use strict';
// Task 7 wiring tests: sweepDisputesForRefund orchestration.
// Verifies:
//   (1) Refundable dispute (confident target) → respondToDispute called, ledger gains
//       pending_approval entry with correct buyerAddress, refund.pending_approval emitted.
//   (2) Unverified target (raised_by ≠ buyerVerusId → disputeSigner:false) → respondToDispute
//       STILL called, entry status is needs_review, refund.needs_review emitted, no send.
//   (3) Idempotency: second sweep run does NOT re-call respondToDispute or duplicate ledger entry.
//
// Uses sandbox HOME so PENDING_REFUNDS_PATH resolves inside the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dispute-sweep-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const j41Dir = path.join(TEST_HOME, '.j41');
const dispDir = path.join(j41Dir, 'dispatcher');
fs.mkdirSync(dispDir, { recursive: true });

const { sweepDisputesForRefund, OUTAGE_APOLOGY } = require('../src/cli.js');

// Valid Verus i-addresses (same as refund-target.test.js and refund-cli.test.js)
const BUYER_I = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';
const SELF_I  = 'iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D';

const LEDGER_PATH = path.join(dispDir, 'pending-refunds.json');

function clearLedger() {
  if (fs.existsSync(LEDGER_PATH)) fs.unlinkSync(LEDGER_PATH);
}

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return {};
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

function makeUndeliveredJob(overrides = {}) {
  return {
    id: 'job-dispute-1',
    status: 'disputed',
    buyerVerusId: BUYER_I,
    amount: 2.5,
    currency: 'VRSCTEST',
    delivery: null,
    tokenUsage: null,
    ...overrides,
  };
}

function makeConfidentDispute() {
  return { id: 'dispute-d1', raised_by: BUYER_I, action: 'pending' };
}

function makeUnverifiedDispute() {
  // raised_by = SELF_I but job.buyerVerusId = BUYER_I → disputeSigner check fails → not confident
  return { id: 'dispute-d2', raised_by: SELF_I, action: 'pending' };
}

function makeState({ job, dispute, respondCalls, events }) {
  return {
    agents: [{
      id: 'agent-5',
      identity: 'testagent@',
      iAddress: SELF_I,
      address: 'RSELFADDRXXXXXXXXXXXXXXXXXXXXXX',
      wif: 'wif-test',
    }],
    agentSessions: new Map(),
    emitEvent: (t, d) => events.push({ t, d }),
    _testAgentSession: {
      respondToDispute: async (jobId, opts) => {
        respondCalls.push({ jobId, opts });
      },
      client: {
        getMyJobs: async () => ({ data: [job] }),
        getDispute: async () => dispute,
        resolveNames: async () => [],
      },
    },
  };
}

// ── Test 1: Confident target → pending_approval entry, event emitted ──────────

test('sweepDisputesForRefund: confident target → respondToDispute called, pending_approval entry, event emitted', async () => {
  clearLedger();
  const respondCalls = [];
  const events = [];
  const job = makeUndeliveredJob();
  const dispute = makeConfidentDispute();
  const state = makeState({ job, dispute, respondCalls, events });

  await sweepDisputesForRefund(state);

  // respondToDispute called with correct args
  assert.equal(respondCalls.length, 1, 'respondToDispute must be called once');
  assert.equal(respondCalls[0].jobId, 'job-dispute-1');
  assert.deepEqual(respondCalls[0].opts, {
    action: 'refund',
    refundPercent: 100,
    message: OUTAGE_APOLOGY,
  });

  // Ledger entry exists with correct shape
  const ledger = readLedger();
  assert.ok(ledger['job-dispute-1'], 'ledger must have an entry for job-dispute-1');
  const entry = ledger['job-dispute-1'];
  assert.equal(entry.status, 'pending_approval', 'entry status must be pending_approval');
  assert.equal(entry.buyerAddress, BUYER_I, 'buyerAddress must be BUYER_I');
  assert.equal(entry.refundPercent, 100);
  assert.equal(entry.agentInfoId, 'agent-5');
  assert.ok(entry.disputeId, 'entry must have a disputeId');

  // Event emitted
  assert.equal(events.length, 1, 'exactly one event emitted');
  assert.equal(events[0].t, 'refund.pending_approval');
  assert.equal(events[0].d.jobId, 'job-dispute-1');
  assert.equal(events[0].d.buyerAddress, BUYER_I);
});

// ── Test 2: Unverified target → needs_review, respondToDispute still called ──

test('sweepDisputesForRefund: unverified target (raised_by≠buyerVerusId) → respondToDispute called, needs_review, refund.needs_review emitted', async () => {
  clearLedger();
  const respondCalls = [];
  const events = [];
  const job = makeUndeliveredJob({ id: 'job-dispute-2' });
  const dispute = makeUnverifiedDispute();
  const state = makeState({ job, dispute, respondCalls, events });

  await sweepDisputesForRefund(state);

  // respondToDispute still called even for unverified target
  assert.equal(respondCalls.length, 1, 'respondToDispute must still be called for unverified target');
  assert.equal(respondCalls[0].opts.action, 'refund');
  assert.equal(respondCalls[0].opts.refundPercent, 100);
  assert.equal(respondCalls[0].opts.message, OUTAGE_APOLOGY);

  // Entry status is needs_review
  const ledger = readLedger();
  assert.ok(ledger['job-dispute-2'], 'ledger must have entry for job-dispute-2');
  const entry = ledger['job-dispute-2'];
  assert.equal(entry.status, 'needs_review', 'status must be needs_review for unverified target');
  assert.notEqual(entry.status, 'approved', 'status must NOT be approved');
  assert.notEqual(entry.status, 'refunded', 'status must NOT be refunded');

  // refund.needs_review emitted
  assert.equal(events.length, 1, 'exactly one event');
  assert.equal(events[0].t, 'refund.needs_review', 'event type must be refund.needs_review');
  assert.equal(events[0].d.jobId, 'job-dispute-2');
});

// ── Test 3: Idempotency — second sweep skips already-enqueued job ─────────────

test('sweepDisputesForRefund: idempotent — second run does not re-call respondToDispute or duplicate entry', async () => {
  clearLedger();
  const respondCalls = [];
  const events = [];
  const job = makeUndeliveredJob({ id: 'job-dispute-3' });
  const dispute = makeConfidentDispute();
  const state = makeState({ job, dispute, respondCalls, events });

  // First sweep
  await sweepDisputesForRefund(state);
  assert.equal(respondCalls.length, 1, 'first sweep: respondToDispute called once');
  const ledgerAfterFirst = readLedger();
  assert.ok(ledgerAfterFirst['job-dispute-3'], 'entry must exist after first sweep');

  // Second sweep with same state
  await sweepDisputesForRefund(state);
  assert.equal(respondCalls.length, 1, 'second sweep: respondToDispute must NOT be called again');
  assert.equal(events.length, 1, 'no additional events on second sweep');

  const ledgerAfterSecond = readLedger();
  const keys = Object.keys(ledgerAfterSecond).filter(k => k === 'job-dispute-3');
  assert.equal(keys.length, 1, 'ledger must have exactly one entry for job-dispute-3');
});
