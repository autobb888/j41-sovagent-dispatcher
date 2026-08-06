'use strict';
// Task 4: Refund ledger status model — drain gating + submitRefundTxid on dispute refunds.
// Verifies:
//   (1) pending_approval entries are NOT sent by drainPendingRefunds
//   (2) approved entries ARE sent; submitRefundTxid called when disputeId set;
//       entry.status becomes 'refunded' with entry.refundTxid set
//   (3) a second drain does NOT re-send (de-dup via markJobRefunded)
//
// Sandbox HOME before requiring cli.js so PENDING_REFUNDS_PATH, REFUNDED_JOBS_PATH,
// and ALLOWLIST_PATH all resolve inside the temp dir — consistent with the pattern
// used by atomic-ledger-writes.test.js and deposit-double-credit.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-refund-queue-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

// Create necessary directories
const j41Dir = path.join(TEST_HOME, '.j41');
const dispDir = path.join(j41Dir, 'dispatcher');
fs.mkdirSync(dispDir, { recursive: true });

// Seed the financial allowlist with the test buyer address so the allowlist
// check inside attemptPendingRefund does not block the refund.
const allowlistPath = path.join(j41Dir, 'financial-allowlist.json');
fs.writeFileSync(allowlistPath, JSON.stringify({
  permanent: [{ address: 'iBuyerTest', added: '2026-01-01T00:00:00.000Z' }],
  operator: [],
  active_jobs: [],
}, null, 2));

// Now require cli.js — PENDING_REFUNDS_PATH etc. evaluate to TEST_HOME paths.
const { drainPendingRefunds, attemptPendingRefund } = require('../src/cli.js');

const PENDING_REFUNDS_PATH = path.join(dispDir, 'pending-refunds.json');

// Minimal state with the test agent session seam.
function makeState(overrides = {}) {
  return {
    agents: [{ id: 'agent-1', identity: 'test@', iAddress: 'iTest', wif: 'wif-test' }],
    agentSessions: new Map(),
    ...overrides,
  };
}

// ── Test 1: pending_approval entries are skipped by drain ────────────────────

test('drainPendingRefunds does NOT send entries with status pending_approval', async () => {
  const sendCalls = [];
  const session = {
    sendCurrency: async (addr, amt) => { sendCalls.push({ addr, amt }); return 'TXID-PA'; },
    client: {
      submitRefundTxid: async () => {},
      sendChatMessage: async () => {},
    },
  };
  const state = makeState({ _testAgentSession: session });

  const ledger = {
    'job-pending-1': {
      status: 'pending_approval',
      agentInfoId: 'agent-1',
      buyerAddress: 'iBuyerTest',
      orphan: { currency: 'VRSC' },
      refundAmount: 3,
      refundPercent: 100,
    },
  };
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify(ledger, null, 2));

  await drainPendingRefunds(state);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called for pending_approval');

  // Entry must remain in the ledger untouched.
  const remaining = JSON.parse(fs.readFileSync(PENDING_REFUNDS_PATH, 'utf8'));
  assert.ok(remaining['job-pending-1'], 'pending_approval entry must remain in ledger');
  assert.equal(remaining['job-pending-1'].status, 'pending_approval', 'status unchanged');
});

// ── Test 2: approved entry IS sent; dispute closes; status → refunded ────────

test('drainPendingRefunds sends approved entry and calls submitRefundTxid when disputeId set', async () => {
  const sendCalls = [];
  const submitCalls = [];
  const session = {
    sendCurrency: async (addr, amt) => { sendCalls.push({ addr, amt }); return 'TXID-APPROVED'; },
    client: {
      submitRefundTxid: async (jId, txid) => { submitCalls.push({ jId, txid }); },
      sendChatMessage: async () => {},
    },
  };
  const state = makeState({ _testAgentSession: session });

  const ledger = {
    'job-approved-1': {
      status: 'approved',
      agentInfoId: 'agent-1',
      buyerAddress: 'iBuyerTest',
      disputeId: 'disp-001',
      orphan: { currency: 'VRSC' },
      refundAmount: 5,
      refundPercent: 100,
    },
  };
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify(ledger, null, 2));

  await drainPendingRefunds(state);

  // sendCurrency must have been called once
  assert.equal(sendCalls.length, 1, 'sendCurrency called once for approved entry');
  assert.equal(sendCalls[0].addr, 'iBuyerTest');
  assert.equal(sendCalls[0].amt, 5);

  // submitRefundTxid must have been called because disputeId is set
  assert.equal(submitCalls.length, 1, 'submitRefundTxid called because disputeId is present');
  assert.equal(submitCalls[0].jId, 'job-approved-1');
  assert.equal(submitCalls[0].txid, 'TXID-APPROVED');

  // Entry is removed from ledger on success
  const remaining = JSON.parse(fs.readFileSync(PENDING_REFUNDS_PATH, 'utf8'));
  assert.equal(Object.keys(remaining).length, 0, 'entry removed from ledger after successful send');
});

// ── Test 3: attemptPendingRefund sets status/refundTxid on the entry object ──

test('attemptPendingRefund sets status:refunded and refundTxid on the entry', async () => {
  const submitCalls = [];
  const session = {
    sendCurrency: async () => 'TXID-DIRECT',
    client: {
      submitRefundTxid: async (jId, txid) => { submitCalls.push({ jId, txid }); },
      sendChatMessage: async () => {},
    },
  };
  const state = makeState({ _testAgentSession: session });

  const entry = {
    status: 'approved',
    agentInfoId: 'agent-1',
    buyerAddress: 'iBuyerTest',
    disputeId: 'disp-002',
    orphan: { currency: 'VRSC' },
    refundAmount: 7,
    refundPercent: 100,
  };

  // Write ledger so the internal txid-persist read-modify-write can find the entry.
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ 'job-direct-1': entry }, null, 2));

  const ok = await attemptPendingRefund(state, 'job-direct-1', entry);

  assert.equal(ok, true, 'attemptPendingRefund returns true on success');
  assert.equal(entry.status, 'refunded', 'entry.status must be refunded');
  assert.equal(entry.refundTxid, 'TXID-DIRECT', 'entry.refundTxid must match sent txid');
  assert.equal(submitCalls.length, 1, 'submitRefundTxid called once');
  assert.equal(submitCalls[0].txid, 'TXID-DIRECT');
});

// ── Test 4: no submitRefundTxid when disputeId is absent ─────────────────────

test('attemptPendingRefund does NOT call submitRefundTxid when disputeId is absent', async () => {
  const submitCalls = [];
  const session = {
    sendCurrency: async () => 'TXID-NODISPUTE',
    client: {
      submitRefundTxid: async (jId, txid) => { submitCalls.push({ jId, txid }); },
      sendChatMessage: async () => {},
    },
  };
  const state = makeState({ _testAgentSession: session });

  const entry = {
    status: 'approved',
    agentInfoId: 'agent-1',
    buyerAddress: 'iBuyerTest',
    // no disputeId
    orphan: { currency: 'VRSC' },
    refundAmount: 2,
    refundPercent: 50,
  };

  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ 'job-nodispute-1': entry }, null, 2));

  const ok = await attemptPendingRefund(state, 'job-nodispute-1', entry);

  assert.equal(ok, true);
  assert.equal(submitCalls.length, 0, 'submitRefundTxid must NOT be called without disputeId');
  assert.equal(entry.status, 'refunded');
  assert.equal(entry.refundTxid, 'TXID-NODISPUTE');
});

// ── Test 5: second drain does NOT re-send (de-dup via markJobRefunded) ───────

test('second drainPendingRefunds does NOT re-send an already-refunded job', async () => {
  // 'job-approved-1' was marked refunded in Test 2. Write it back to the ledger
  // with status:'approved' and drain again — the de-dup guard in attemptPendingRefund
  // (loadRefundedJobs().has(jobId)) must short-circuit without calling sendCurrency.
  const sendCalls = [];
  const session = {
    sendCurrency: async () => { sendCalls.push(1); return 'TXID-RESEND'; },
    client: {
      submitRefundTxid: async () => {},
      sendChatMessage: async () => {},
    },
  };
  const state = makeState({ _testAgentSession: session });

  // Restore the entry as if the drain hadn't run yet.
  const ledger = {
    'job-approved-1': {
      status: 'approved',
      agentInfoId: 'agent-1',
      buyerAddress: 'iBuyerTest',
      disputeId: 'disp-001',
      orphan: { currency: 'VRSC' },
      refundAmount: 5,
      refundPercent: 100,
    },
  };
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify(ledger, null, 2));

  await drainPendingRefunds(state);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called for already-refunded job');

  // Entry is removed from ledger (de-dup path returns true → drain clears it)
  const remaining = JSON.parse(fs.readFileSync(PENDING_REFUNDS_PATH, 'utf8'));
  assert.equal(Object.keys(remaining).length, 0, 'de-duped entry is cleared from ledger');
});

// ---------------------------------------------------------------------------
// The refund failure split — the branch that decides whether money can be paid
// twice. It shipped in 2.11.7 with NO coverage: an audit mutated
// `if (isFundingFailure(e))` to both `true` and `false` and all 866 tests
// passed. `true` destroys the double-pay protection; `false` reintroduces the
// permanent wedge 2.11.7 was written to fix. Neither was caught.
//
// The earlier attempt asserted on classifyInboxFailure and then called the
// marker helpers by hand — it tested fs.unlinkSync, not the branch. These drive
// the real attemptPendingRefund through the _testAgentSession seam and make
// sendCurrency throw, which is the only way to reach the catch.
// ---------------------------------------------------------------------------

// attemptPendingRefund is imported at the top of this file.
const { clearRefundInflight, readRefundInflight } = require('../src/cli.js');

function refundEntry(over = {}) {
  return {
    status: 'approved',
    agentInfoId: 'agent-1',
    buyerAddress: 'iBuyerTest',
    orphan: { currency: 'VRSC' },
    refundAmount: 3,
    refundPercent: 100,
    ...over,
  };
}

/** Run one refund attempt whose send throws `err`; return the marker afterwards. */
async function attemptWithSendError(jobId, err) {
  clearRefundInflight(jobId);
  const session = {
    sendCurrency: async () => { throw err; },
    client: { submitRefundTxid: async () => {}, sendChatMessage: async () => {} },
  };
  const state = makeState({ _testAgentSession: session });
  const ok = await attemptPendingRefund(state, jobId, refundEntry(), PENDING_REFUNDS_PATH);
  return { ok, marker: readRefundInflight(jobId) };
}

test('PRE-BROADCAST failure clears the marker, so the refund is retried', async () => {
  // Nothing left the host — a dry tank fails while building the transaction.
  // Keeping the marker here is the 2.11.2 bug: an owed refund never paid.
  for (const msg of [
    'No spendable UTXOs on RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51',
    'Insufficient funds: need 310000000 sat, have 0 sat',
    'No UTXOs available — wallet is empty',
  ]) {
    const { ok, marker } = await attemptWithSendError('job-pre-' + msg.length, new Error(msg));
    assert.equal(ok, false, 'the attempt failed');
    assert.equal(marker, null, `marker must be CLEARED for a pre-broadcast failure: ${msg}`);
  }
});

test('AMBIGUOUS failure keeps the marker, so the refund is never paid twice', async () => {
  // The broadcast may have landed. Paying again to resolve the doubt is the one
  // outcome that cannot be undone.
  for (const err of [
    new Error('socket hang up'),
    new Error('request timed out after 30000ms'),
    Object.assign(new Error('gateway timeout'), { statusCode: 504 }),
  ]) {
    const jobId = 'job-amb-' + err.message.length;
    const { ok, marker } = await attemptWithSendError(jobId, err);
    assert.equal(ok, false);
    assert.ok(marker, `marker must be KEPT for an ambiguous failure: ${err.message}`);
    assert.equal(marker.lastError, err.message, 'and annotated with why');
    assert.equal(marker.buyerAddress, 'iBuyerTest', 'original payee preserved');
    assert.equal(marker.amount, 3, 'original amount preserved');
    clearRefundInflight(jobId);
  }
});

test('a successful send leaves no marker behind', async () => {
  clearRefundInflight('job-ok');
  const session = {
    sendCurrency: async () => 'TXID-OK',
    client: { submitRefundTxid: async () => {}, sendChatMessage: async () => {} },
  };
  const state = makeState({ _testAgentSession: session });
  const ok = await attemptPendingRefund(state, 'job-ok', refundEntry(), PENDING_REFUNDS_PATH);
  assert.equal(ok, true);
  assert.equal(readRefundInflight('job-ok'), null, 'the marker must not outlive a successful send');
});
