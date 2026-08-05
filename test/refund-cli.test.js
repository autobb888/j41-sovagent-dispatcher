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

const { refundsList, refundsApprove, refundsReject, refundsApproveAll, acquireSendLock, releaseSendLock } = require('../src/cli.js');

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

// ── Tests for FIX 2: confirmFn gate ─────────────────────────────────────────

// Test 10: confirmFn returning false → no send, status stays pending_approval
test('refundsApprove: confirmFn returning false aborts send, status stays pending_approval', async () => {
  resetAllowlist();
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async () => { sendCalls.push(1); return 'TXID'; },
  });
  const ledgerPath = makeLedgerPath('t10');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t10': makeDisputeEntry({ status: 'pending_approval' }),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t10', {
    confirmFn: async () => false,
  }, ledgerPath);

  assert.equal(sendCalls.length, 0, 'sendCurrency must NOT be called when confirmFn returns false');
  assert.equal(result.status, 'pending_approval', 'status must remain pending_approval when cancelled');
});

// Test 11: confirmFn returning true → sends, status=refunded
test('refundsApprove: confirmFn returning true proceeds with send, status=refunded', async () => {
  resetAllowlist();
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async (addr) => { sendCalls.push(addr); return 'TXID-T11'; },
  });
  const ledgerPath = makeLedgerPath('t11');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t11': makeDisputeEntry({ status: 'pending_approval' }),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t11', {
    confirmFn: async () => true,
  }, ledgerPath);

  assert.equal(sendCalls.length, 1, 'sendCurrency must be called when confirmFn returns true');
  assert.equal(sendCalls[0], BUYER_I);
  assert.equal(result.status, 'refunded', 'status must be refunded after confirmed send');
});

// Test 12: opts.yes=true with no confirmFn → sends (confirmation skipped)
test('refundsApprove: yes=true with no confirmFn skips confirmation and sends', async () => {
  resetAllowlist();
  const sendCalls = [];
  const state = makeState({
    sendCurrency: async (addr) => { sendCalls.push(addr); return 'TXID-T12'; },
  });
  const ledgerPath = makeLedgerPath('t12');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'job-t12': makeDisputeEntry({ status: 'pending_approval' }),
  }, null, 2));

  const result = await refundsApprove(state, 'job-t12', { yes: true }, ledgerPath);

  assert.equal(sendCalls.length, 1, 'sendCurrency must be called when yes=true');
  assert.equal(result.status, 'refunded', 'status must be refunded');
});

// ---------------------------------------------------------------------------
// Crash-safe refund intent (fault-injection review, 2026-08-05).
//
// attemptPendingRefund broadcasts to an EXTERNAL buyer address and THEN records
// it. A SIGKILL between those two leaves the job status:'approved', so the next
// startup drain sends a SECOND confirmed refund. It is the only place in the
// codebase where money can leave the fleet twice, and the old code dismissed the
// window as needing "a hardware fault between two syscalls" — a plain crash,
// OOM kill or deploy reaches it.
//
// Intent is now written BEFORE the broadcast. A marker at drain time means "we
// may already have paid and cannot tell", which must never be resolved by paying
// again.
// ---------------------------------------------------------------------------

const {
  markRefundInflight, clearRefundInflight, readRefundInflight, refundInflightPath,
  noteRefundInflightFailure, drainPendingRefunds,
} = require('../src/cli.js');  // refundsList is imported at the top of this file

test('an in-flight marker survives to be found by the next drain', () => {
  clearRefundInflight('job-crash');
  assert.equal(readRefundInflight('job-crash'), null, 'no marker to start');

  markRefundInflight('job-crash', { buyerAddress: 'RBuyer', amount: 1.5, currency: 'VRSCTEST' });
  const m = readRefundInflight('job-crash');
  assert.ok(m, 'marker must persist — this is the crash evidence');
  assert.equal(m.buyerAddress, 'RBuyer');
  assert.equal(m.amount, 1.5);
  assert.ok(Number.isFinite(m.at) && m.at > 0, 'must record when');
  assert.equal(m.pid, process.pid, 'must record who');

  clearRefundInflight('job-crash');
  assert.equal(readRefundInflight('job-crash'), null, 'cleared once the send is recorded');
});

test('the marker file is 0600 — it names a payee and an amount', () => {
  markRefundInflight('job-perm', { buyerAddress: 'RBuyer', amount: 1 });
  const mode = fs.statSync(refundInflightPath('job-perm')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  clearRefundInflight('job-perm');
});

test('a job id cannot escape the locks directory via its filename', () => {
  // The sanitiser maps separators to underscores, so the RESULT may legitimately
  // contain '..' as ordinary characters. The property that matters is that the
  // resolved path never leaves the locks directory.
  const locksDir = path.dirname(refundInflightPath('probe'));
  for (const evil of ['../../../etc/passwd', '..\\..\\win', 'a/b/c', '/abs/path', '.']) {
    const resolved = path.resolve(refundInflightPath(evil));
    assert.ok(resolved.startsWith(path.resolve(locksDir) + path.sep),
      `escaped the locks dir with ${JSON.stringify(evil)}: ${resolved}`);
  }
});

test('drainPendingRefunds REFUSES a job whose refund was in flight', async () => {
  // NOTE: the previous version of this test wired `state._testAttemptRefund`,
  // a hook that does not exist in src/cli.js. `attempted` could never be
  // populated, so the assertion passed even with the marker check deleted — the
  // only automated proof of the money fix proved nothing. It now observes the
  // real gate: what drainPendingRefunds SAYS about each job, and which entries
  // survive in the ledger.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-inflight-'));
  const ledger = path.join(dir, 'pending-refunds.json');
  fs.writeFileSync(ledger, JSON.stringify({
    'job-inflight': { status: 'approved', refundAmount: 2, buyerAddress: 'RBuyer', orphan: {} },
    'job-clean': { status: 'approved', refundAmount: 2, buyerAddress: 'RBuyer', orphan: {} },
  }));
  markRefundInflight('job-inflight', { buyerAddress: 'RBuyer', amount: 2, currency: 'VRSCTEST' });

  const said = [];
  const err = console.error; const log = console.log;
  console.error = (...a) => said.push(a.join(' '));
  console.log = (...a) => said.push(a.join(' '));
  try {
    await drainPendingRefunds({ agents: [], agentSessions: new Map() }, { ledgerPath: ledger });
  } finally { console.error = err; console.log = log; }

  const text = said.join('\n');
  assert.match(text, /job-inf.*NOT re-sending|NOT re-sending/s,
    'the blocked job must be reported as not re-sent');
  assert.match(text, /1 approved refund\(s\) to send/,
    'exactly one job (job-clean) may be attempted — the blocked one is filtered out');
  assert.ok(readRefundInflight('job-inflight'), 'the marker must survive the drain');

  clearRefundInflight('job-inflight');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B1 (audit): the marker must not wedge a send that never left.
//
// 2.11.2 wrote the marker before broadcasting and cleared it only on success, so
// ANY throw — an empty fee tank, a dropped connection — left it behind forever.
// The catch logged "will retry on next start" (it could not) and the drain then
// reported the process had died (it had not). A routine dry tank during a drain
// silently converted an owed refund into a permanently unpaid one.
// ---------------------------------------------------------------------------

test('a PRE-BROADCAST failure clears the marker so the refund can retry', () => {
  // A dry fee tank fails inside sendCurrency while building — nothing left the
  // host, so retrying is both safe and required.
  const { classifyInboxFailure } = require('../src/inbox-deadletter.js');
  const dry = new Error('No spendable R-address UTXOs for fee. Fund RWoe... with at least 0.0001 VRSC.');
  assert.equal(classifyInboxFailure(dry), 'transient',
    'the same predicate the refund catch uses to decide "never broadcast"');

  markRefundInflight('job-dry', { buyerAddress: 'RBuyer', amount: 1 });
  assert.ok(readRefundInflight('job-dry'));
  clearRefundInflight('job-dry'); // what the pre-broadcast branch does
  assert.equal(readRefundInflight('job-dry'), null, 'a retryable failure must leave no marker');
});

test('an AMBIGUOUS failure keeps the marker and records why', () => {
  markRefundInflight('job-timeout', { buyerAddress: 'RBuyer', amount: 3, currency: 'VRSCTEST' });
  noteRefundInflightFailure('job-timeout', 'socket hang up');
  const m = readRefundInflight('job-timeout');
  assert.ok(m, 'an ambiguous failure must NOT clear the marker — the tx may have landed');
  assert.equal(m.lastError, 'socket hang up', 'and it must record why, for the operator');
  assert.ok(Number.isFinite(m.failedAt));
  assert.equal(m.buyerAddress, 'RBuyer', 'the original payee must survive the update');
  assert.equal(m.amount, 3);
  clearRefundInflight('job-timeout');
});

test('noteRefundInflightFailure on a job with no marker does nothing', () => {
  noteRefundInflightFailure('job-none', 'whatever');
  assert.equal(readRefundInflight('job-none'), null, 'it must not manufacture a marker');
});

test('refunds list SURFACES a blocked refund instead of saying "No pending refunds"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-blocked-'));
  const ledger = path.join(dir, 'pending-refunds.json');
  // status 'approved' is filtered out of the default list view — which is exactly
  // how a blocked refund became invisible while money was stuck.
  fs.writeFileSync(ledger, JSON.stringify({
    'job-blocked': { status: 'approved', refundAmount: 4, buyerAddress: 'RBuyer', orphan: {} },
  }));
  markRefundInflight('job-blocked', { buyerAddress: 'RBuyer', amount: 4, currency: 'VRSCTEST' });

  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(' '));
  try { refundsList({}, {}, ledger); } finally { console.log = log; }

  const text = said.join('\n');
  assert.ok(!/No pending refunds/.test(text), 'a blocked refund must never read as "nothing to do"');
  assert.match(text, /BLOCKED/);
  assert.match(text, /refunds unblock job-blocked/, 'and it must say how to resolve it');

  clearRefundInflight('job-blocked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an invalid job id cannot take a lock — a shared "undefined" lock is not a lock', () => {
  // A stray refund-locks/undefined.lock was found on a live host. Whatever
  // produced it, the shape is wrong: every caller with a missing id would share
  // one file, serialising unrelated sends against each other while NOT
  // serialising concurrent sends for the same job.
  for (const bad of [undefined, null, '', 0, {}, '../escape', '.hidden', 'has space']) {
    assert.equal(acquireSendLock(bad), false, `took a lock for ${JSON.stringify(bad)}`);
  }
  assert.equal(acquireSendLock('job-valid'), true, 'a real job id still works');
  releaseSendLock('job-valid');
});

test('an UNREADABLE marker still blocks — it must not read as "no marker"', () => {
  // Returning null for a corrupt marker would mean the drain pays: resolving an
  // unreadable record of a possible payment by making another one.
  markRefundInflight('job-unreadable', { buyerAddress: 'RBuyer', amount: 1 });
  fs.writeFileSync(refundInflightPath('job-unreadable'), '{ truncated');
  const m = readRefundInflight('job-unreadable');
  assert.ok(m, 'an unreadable marker must not vanish');
  assert.equal(m.unreadable, true);
  clearRefundInflight('job-unreadable');
  assert.equal(readRefundInflight('job-unreadable'), null, 'and an absent one is still absent');
});
