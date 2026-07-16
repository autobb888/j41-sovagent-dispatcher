'use strict';
// Task 5: Owner-facing refunds CLI handler unit tests.
// Verifies:
//   (1) refundsApprove refuses a needs_review entry (no send)
//   (2) refundsApprove on pending_approval dispute entry with confident target → sends, status=refunded
//   (3) refundsApprove aborts (no send, →needs_review) when re-resolved target not confident/address changed
//   (4) refundsApprove approves crash-recovery entry with R-address buyer (no i-address requirement)
//   (5) refundsApprove aborts crash-recovery entry whose buyerAddress is a self-address
//   (6) refundsReject sets status:rejected — no send
//   (7) refundsList returns pending_approval+needs_review by default; all with {all:true}
//
// Uses a sandbox HOME so PENDING_REFUNDS_PATH, REFUNDED_JOBS_PATH, and ALLOWLIST_PATH
// all resolve inside the temp dir (same isolation pattern as refund-queue.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-refund-cli-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const j41Dir = path.join(TEST_HOME, '.j41');
const dispDir = path.join(j41Dir, 'dispatcher');
fs.mkdirSync(dispDir, { recursive: true });

const { refundsList, refundsApprove, refundsReject, refundsApproveAll } = require('../src/cli.js');

// Valid Verus i-addresses (from refund-target.test.js)
const BUYER_I = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';
const SELF_I  = 'iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D'; // agent's iAddress → always in selfAddresses
const BUYER_R = 'RBUYER000000000000000000000000000000'; // R-address for crash-recovery test (non-self)

function makeLedgerPath(suffix) {
  return path.join(dispDir, `test-ledger-${suffix}.json`);
}

function resetAllowlist() {
  const p = path.join(j41Dir, 'financial-allowlist.json');
  fs.writeFileSync(p, JSON.stringify({ permanent: [], operator: [], active_jobs: [] }, null, 2));
}

function makeState(sessionOverrides = {}) {
  return {
    agents: [{
      id: 'agent-1',
      identity: 'test@',
      iAddress: SELF_I,
      address: 'RSELFAGENTADDRESSXXXXXXXXXXXXXXXXXX',
      wif: 'wif-test',
    }],
    agentSessions: new Map(),
    _testAgentSession: {
      sendCurrency: sessionOverrides.sendCurrency || (async () => 'TXID'),
      client: {
        getJob: sessionOverrides.getJob ||
          (async (jid) => ({ id: jid, buyerVerusId: BUYER_I, amount: 1.0, currency: 'VRSCTEST' })),
        getDispute: sessionOverrides.getDispute ||
          (async () => ({ id: 'dispute-1', raised_by: BUYER_I, action: 'pending' })),
        submitRefundTxid: async () => {},
        resolveNames: sessionOverrides.resolveNames || (async () => []),
        sendChatMessage: async () => {},
      },
    },
  };
}

function makeDisputeEntry(overrides = {}) {
  return {
    agentInfoId: 'agent-1',
    orphan: { currency: 'VRSCTEST', buyerPayAddress: BUYER_I },
    refundAmount: 1.0,
    refundPercent: 100,
    buyerAddress: BUYER_I,
    disputeId: 'dispute-1',
    status: 'pending_approval',
    enqueuedAt: new Date().toISOString(),
    reason: 'dispute: undelivered job',
    ...overrides,
  };
}

function makeCrashEntry(buyerAddress, overrides = {}) {
  return {
    agentInfoId: 'agent-1',
    orphan: { currency: 'VRSCTEST' },
    refundAmount: 0.5,
    refundPercent: 100,
    buyerAddress,
    // Deliberately NO disputeId — crash-recovery path
    status: 'pending_approval',
    enqueuedAt: new Date().toISOString(),
    reason: 'crash-recovery: job interrupted',
    ...overrides,
  };
}

// ── Test 1: needs_review entry is refused (no send) ──────────────────────────

test('refundsApprove refuses needs_review entry — sendCurrency NOT called', async () => {
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async () => { sendCalls.push(1); return 'TXID'; },
  });
  const ledgerPath = makeLedgerPath('t1');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t1': makeDisputeEntry({ status: 'needs_review' }),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t1', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called for needs_review');
  assert.equal(result.status, 'needs_review', 'status must remain needs_review');
});

// ── Test 2: pending_approval dispute entry with confident target → sends ─────

test('refundsApprove approves dispute entry with confident re-verified target — sends, status=refunded', async () => {
  resetAllowlist();
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async (addr, amt) => { sendCalls.push({ addr, amt }); return 'TXID-T2'; },
    getJob: async (jid) => ({ id: jid, buyerVerusId: BUYER_I, amount: 1.0, currency: 'VRSCTEST' }),
    getDispute: async () => ({ id: 'dispute-1', raised_by: BUYER_I, action: 'pending' }),
    resolveNames: async () => [],
  });
  const ledgerPath = makeLedgerPath('t2');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t2': makeDisputeEntry(),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t2', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 1, 'sendCurrency called once');
  assert.equal(sendCalls[0].addr, BUYER_I);
  assert.equal(result.status, 'refunded', 'status must be refunded after successful send');
});

// ── Test 3: re-resolved target not confident → abort, no send, needs_review ──

test('refundsApprove aborts when re-resolved target is not confident — no send, status=needs_review', async () => {
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async () => { sendCalls.push(1); return 'TXID'; },
    // Re-fetch returns SELF_I as buyerVerusId — isIAddress passes but notSelf fails
    // (SELF_I is the agent's own iAddress → in selfAddresses → not confident)
    getJob: async (jid) => ({ id: jid, buyerVerusId: SELF_I, amount: 1.0, currency: 'VRSCTEST' }),
    getDispute: async () => ({ id: 'dispute-1', raised_by: SELF_I, action: 'pending' }),
    resolveNames: async () => [],
  });
  const ledgerPath = makeLedgerPath('t3');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t3': makeDisputeEntry({ buyerAddress: BUYER_I }), // stored as BUYER_I; re-resolved to SELF_I
  }, null, 2));

  const result = await refundsApprove(state, 'job-t3', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called');
  assert.equal(result.status, 'needs_review', 'status must be needs_review after abort');
});

// ── Test 4: crash-recovery R-address (not self, not fee) → sends ─────────────

test('refundsApprove approves crash-recovery entry with R-address buyer — no i-address requirement', async () => {
  resetAllowlist();
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async (addr) => { sendCalls.push(addr); return 'TXID-T4'; },
  });
  const ledgerPath = makeLedgerPath('t4');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t4': makeCrashEntry(BUYER_R),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t4', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 1, 'sendCurrency must be called for valid crash-recovery entry');
  assert.equal(sendCalls[0], BUYER_R, 'must send to the stored R-address');
  assert.equal(result.status, 'refunded', 'status must be refunded');
});

// ── Test 5: crash-recovery entry with self-address → aborts ──────────────────

test('refundsApprove aborts crash-recovery entry whose buyerAddress is a self-address — no send', async () => {
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async () => { sendCalls.push(1); return 'TXID'; },
  });
  const ledgerPath = makeLedgerPath('t5');
  // buyerAddress = SELF_I (the agent's own iAddress — in selfAddresses)
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t5': makeCrashEntry(SELF_I),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t5', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called for self-address');
  assert.equal(result.status, 'needs_review', 'status must be needs_review after abort');
  assert.ok(result.addressChecks && result.addressChecks.notSelf === false, 'notSelf check must record failure');
});

// ── Test 6: reject sets status:rejected, no send ──────────────────────────────

test('refundsReject sets status:rejected — no send, reason persisted', () => {
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async () => { sendCalls.push(1); return 'TXID'; },
  });
  const ledgerPath = makeLedgerPath('t6');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t6': makeDisputeEntry(),
  }, null, 2));

  const result = refundsReject(state, 'job-t6', { reason: 'owner says no' }, ledgerPath);

  assert.equal(result.status, 'rejected', 'status must be rejected');
  assert.equal(result.rejectedReason, 'owner says no', 'rejectedReason must be stored');
  assert.equal(sendCalls.length, 0, 'no send on reject');

  const persisted = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(persisted['job-t6'].status, 'rejected', 'rejection must be persisted to ledger');
});

// ── Test 7: refundsList filters correctly ─────────────────────────────────────

test('refundsList returns pending_approval+needs_review by default; all:true returns everything', () => {
  const state = makeState();
  const ledgerPath = makeLedgerPath('t7');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-pa':  makeDisputeEntry({ status: 'pending_approval' }),
    'job-nr':  makeDisputeEntry({ status: 'needs_review' }),
    'job-ref': makeDisputeEntry({ status: 'refunded' }),
    'job-rej': makeDisputeEntry({ status: 'rejected' }),
  }, null, 2));

  const defaultResult = refundsList(state, {}, ledgerPath);
  assert.equal(defaultResult.length, 2, 'default: only pending_approval + needs_review');
  assert.ok(
    defaultResult.every(e => e.status === 'pending_approval' || e.status === 'needs_review'),
    'default result must contain only pending_approval and needs_review'
  );

  const allResult = refundsList(state, { all: true }, ledgerPath);
  assert.equal(allResult.length, 4, 'all:true must return all 4 entries');
});

// A third valid i-address, not the agent's self address — used for the
// "confident but address changed since enqueue" abort branch.
const OTHER_I = 'iDP6VUHKfd5NwLgFuvdNc8PmRkZT6ayGJN';

// ── Test 8: dispute target re-resolves CONFIDENT but to a DIFFERENT address ───
// The money-safety branch: re-fetch yields a fully-verified (isIAddress, notSelf,
// dispute-signer-matched) address that is NOT the stored buyerAddress. Must abort.
test('refundsApprove aborts when re-resolved target is confident but address changed', async () => {
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async () => { sendCalls.push(1); return 'TXID'; },
    // getJob now returns OTHER_I; dispute signed by OTHER_I ⇒ resolveRefundTarget
    // is CONFIDENT for OTHER_I, but the ledger stored BUYER_I → address mismatch.
    getJob: async (jid) => ({ id: jid, buyerVerusId: OTHER_I, amount: 1.0, currency: 'VRSCTEST' }),
    getDispute: async () => ({ id: 'dispute-1', raised_by: OTHER_I, action: 'pending' }),
    resolveNames: async () => [],
  });
  const ledgerPath = makeLedgerPath('t8');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t8': makeDisputeEntry({ buyerAddress: BUYER_I }),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t8', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 0, 'must NOT send when the verified address differs from the stored one');
  assert.equal(result.status, 'needs_review', 'address-change must downgrade to needs_review');
});

// ── Test 9: approveAll sends only pending_approval, re-verifies each, skips others ──
test('refundsApproveAll approves only pending_approval entries, skips needs_review/rejected', async () => {
  resetAllowlist();
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async (addr) => { sendCalls.push(addr); return 'TXID-ALL'; },
  });
  const ledgerPath = makeLedgerPath('t9');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-pa':  makeDisputeEntry({ status: 'pending_approval' }), // confident (BUYER_I) → should send
    'job-nr':  makeDisputeEntry({ status: 'needs_review' }),     // must be skipped
    'job-rej': makeDisputeEntry({ status: 'rejected' }),         // must be skipped
  }, null, 2));

  await refundsApproveAll(state, { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 1, 'exactly one send — only the pending_approval entry');
  assert.equal(sendCalls[0], BUYER_I);
  const led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(led['job-pa'].status, 'refunded', 'pending_approval entry refunded');
  assert.equal(led['job-nr'].status, 'needs_review', 'needs_review left untouched');
  assert.equal(led['job-rej'].status, 'rejected', 'rejected left untouched');
});
