'use strict';
/**
 * M3 wiring — the limiter must actually sit in front of the broadcast.
 *
 * The finding was never "the limiter is wrong". It was that
 * `checkDispatcherRateLimit` and `recordDispatcherSend` had ZERO callers, so the
 * README's four documented money guarantees were fiction. A unit test of the
 * limiter's decisions would have passed against the broken build unchanged — the
 * defect lived entirely in the absence of a call.
 *
 * So these tests drive `attemptPendingRefund` (the one place VRSC leaves the host)
 * and assert on `sendCurrency`: was it reached, and was the ledger entry preserved.
 *
 * HOME is sandboxed before requiring cli.js so the ledger/allowlist paths resolve
 * inside the temp dir — same pattern as refund-queue.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-refund-rl-wiring-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const j41Dir = path.join(TEST_HOME, '.j41');
const dispDir = path.join(j41Dir, 'dispatcher');
fs.mkdirSync(dispDir, { recursive: true });

fs.writeFileSync(path.join(j41Dir, 'financial-allowlist.json'), JSON.stringify({
  permanent: [{ address: 'iBuyerTest', added: '2026-01-01T00:00:00.000Z' }],
  operator: [],
  active_jobs: [],
}, null, 2));

const {
  attemptPendingRefund,
  _resetDispatcherRateLimit,
  recordDispatcherSend,
} = require('../src/cli.js');

const PENDING_REFUNDS_PATH = path.join(dispDir, 'pending-refunds.json');
const REFUNDED_JOBS_PATH = path.join(dispDir, 'refunded-jobs.json');

function makeState(session) {
  return {
    agents: [{ id: 'agent-1', identity: 'test@', iAddress: 'iTest', wif: 'wif-test' }],
    agentSessions: new Map(),
    _testAgentSession: session,
  };
}

function makeSession(sendCalls) {
  return {
    sendCurrency: async (addr, amt) => { sendCalls.push({ addr, amt }); return `TXID-${sendCalls.length}`; },
    client: { submitRefundTxid: async () => {}, sendChatMessage: async () => {} },
  };
}

function entryFor(amount, jobAmount) {
  return {
    status: 'approved',
    agentInfoId: 'agent-1',
    buyerAddress: 'iBuyerTest',
    orphan: { currency: 'VRSC', jobAmount },
    refundAmount: amount,
    refundPercent: 100,
  };
}

/** Each test gets a clean ledger + refunded-jobs set + limiter state. */
function reset(suspended = false) {
  fs.writeFileSync(PENDING_REFUNDS_PATH, '{}');
  fs.writeFileSync(REFUNDED_JOBS_PATH, '[]');
  _resetDispatcherRateLimit(suspended);
}

test('the happy path still sends — the limiter is not simply blocking everything', async () => {
  reset();
  const sendCalls = [];
  const jobId = 'job-wiring-ok';
  const entry = entryFor(1.0, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));

  const ok = await attemptPendingRefund(makeState(makeSession(sendCalls)), jobId, entry);
  assert.equal(ok, true);
  assert.equal(sendCalls.length, 1, 'a first, in-limit refund must broadcast');
});

test('an API-outage suspension stops the broadcast and keeps the entry', async () => {
  // This is the guarantee the README calls "fail-closed sweep". The sweep set the
  // flag; nothing read it; refunds went out through a total platform outage.
  reset(true);
  const sendCalls = [];
  const jobId = 'job-wiring-suspended';
  const entry = entryFor(1.0, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));

  const ok = await attemptPendingRefund(makeState(makeSession(sendCalls)), jobId, entry);
  assert.equal(sendCalls.length, 0, 'NOTHING may broadcast while financial ops are suspended');
  assert.equal(ok, false, 'returning true would drop the entry from the ledger — the refund is still owed');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(PENDING_REFUNDS_PATH, 'utf8'))), [jobId]);
});

test('the value ceiling stops a refund larger than the job price + 10%', async () => {
  reset();
  const sendCalls = [];
  const jobId = 'job-wiring-overvalue';
  // A 1.0 VRSC job trying to refund 5.0 — the arithmetic-bug case the durable
  // ledger and the allowlist both wave through, because neither checks amount.
  const entry = entryFor(5.0, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));

  const ok = await attemptPendingRefund(makeState(makeSession(sendCalls)), jobId, entry);
  assert.equal(sendCalls.length, 0, 'an over-value refund must never reach sendCurrency');
  assert.equal(ok, false);
});

test('the per-job cap stops a 4th send for the same job', async () => {
  reset();
  const sendCalls = [];
  const jobId = 'job-wiring-fourth';
  for (let i = 0; i < 3; i++) recordDispatcherSend(jobId, 0.001);
  const entry = entryFor(0.001, 100);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));

  const ok = await attemptPendingRefund(makeState(makeSession(sendCalls)), jobId, entry);
  assert.equal(sendCalls.length, 0);
  assert.equal(ok, false);
});

test('a successful send is COUNTED — the hourly budget actually depletes', async () => {
  // recordDispatcherSend existed and was called by nobody, so the counters stayed
  // empty forever and every limit above was unreachable even once wired.
  reset();
  const sendCalls = [];
  const state = makeState(makeSession(sendCalls));

  // Ten distinct jobs, each in-limit on its own. The 11th must hit the fleet-wide cap.
  for (let i = 0; i < 10; i++) {
    const jobId = `job-wiring-count-${i}`;
    const entry = entryFor(0.01, 1.0);
    fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));
    await attemptPendingRefund(state, jobId, entry);
  }
  assert.equal(sendCalls.length, 10, 'the first ten are all within every limit');

  const jobId = 'job-wiring-count-11';
  const entry = entryFor(0.01, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));
  const ok = await attemptPendingRefund(state, jobId, entry);
  assert.equal(sendCalls.length, 10, 'the 11th send in an hour must be deferred');
  assert.equal(ok, false, 'deferred, not dropped — it stays queued for the next drain');
});

test('a send that fails to BUILD does not consume the hourly budget', async () => {
  // A dry fee tank is the routine failure and nothing left the host. Counting it
  // would let a run of empty-tank failures lock out the refunds that follow.
  reset();
  const jobId = 'job-wiring-drytank';
  const entry = entryFor(0.01, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));

  const failing = {
    sendCurrency: async () => { throw new Error('No spendable R-address UTXOs for fee'); },
    client: { submitRefundTxid: async () => {}, sendChatMessage: async () => {} },
  };
  await attemptPendingRefund(makeState(failing), jobId, entry);

  // Nine more failures, then a working session must still be allowed through.
  for (let i = 0; i < 9; i++) {
    const jid = `job-wiring-drytank-${i}`;
    const e = entryFor(0.01, 1.0);
    fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jid]: e }));
    await attemptPendingRefund(makeState(failing), jid, e);
  }

  const sendCalls = [];
  const jid = 'job-wiring-drytank-after';
  const e = entryFor(0.01, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jid]: e }));
  await attemptPendingRefund(makeState(makeSession(sendCalls)), jid, e);
  assert.equal(sendCalls.length, 1, 'ten failed builds must not have spent the hourly budget');
});

// ── Task 3 / C3: the funnel wiring and its ordering invariants ──
const { readRefundInflight, loadSendHistory } = require('../src/cli.js');

test('C3: a successful refund clears the inflight marker and COUNTS via recordSendOutcome', async () => {
  reset();
  const sendCalls = [];
  const jobId = 'job-c3-ok';
  const entry = entryFor(1.0, 1.0);
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));
  const before = loadSendHistory().global.length;

  const ok = await attemptPendingRefund(makeState(makeSession(sendCalls)), jobId, entry);
  assert.equal(ok, true);
  assert.equal(sendCalls.length, 1);
  assert.ok(!readRefundInflight(jobId), 'inflight marker must be cleared after a recorded send');
  assert.equal(loadSendHistory().global.length, before + 1, 'recordSendOutcome must count the send');
});

test('C3: a terminally-denied refund leaves NO inflight marker (nothing was sent)', async () => {
  reset();
  const sendCalls = [];
  const jobId = 'job-c3-deny';
  const entry = entryFor(5.0, 1.0); // over-value → terminal deny, entry kept
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));

  const ok = await attemptPendingRefund(makeState(makeSession(sendCalls)), jobId, entry);
  assert.equal(ok, false);
  assert.equal(sendCalls.length, 0);
  assert.ok(!readRefundInflight(jobId), 'a send that never happened must not leave a marker');
});

// ── The double-send that making `approved` retryable opened up ───────────────
//
// Found by adversarial review, with a working repro. `drainPendingRefunds` has
// always excluded entries carrying an in-flight marker (`!readRefundInflight(id)`),
// because that marker means a send failed AMBIGUOUSLY — a timeout or a dropped
// connection mid-broadcast — so the transaction may already be on-chain. Paying
// again to resolve that doubt is the one outcome nobody can undo.
//
// `refundsApprove` had no such guard. It did not need one while `approved` was a
// terminal state that returned early. Making it retryable (so rate-limit deferrals
// could be retried) removed that accident and exposed the missing check: an
// ambiguous failure leaves status `approved`, the job never reaches
// refunded-jobs.json, and the send lock has no live holder — so every remaining
// gate passes and `refunds approve --all --yes` re-broadcasts.

const { refundsApprove, refundsApproveAll, markRefundInflight } = require('../src/cli.js');

test('approve REFUSES an entry with an unresolved in-flight send', async () => {
  reset();
  const sendCalls = [];
  const jobId = 'job-inflight-single';
  const entry = { ...entryFor(1.0, 1.0), status: 'approved' };
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({ [jobId]: entry }));
  markRefundInflight(jobId, { buyerAddress: 'iBuyerTest', amount: 1.0, currency: 'VRSC' });

  await refundsApprove(makeState(makeSession(sendCalls)), jobId, { yes: true }, PENDING_REFUNDS_PATH);
  assert.equal(sendCalls.length, 0,
    'a send that may already be on-chain must never be re-broadcast by an approve');
});

test('approve --all SKIPS in-flight entries and says so', async () => {
  reset();
  const sendCalls = [];
  const safeId = 'job-inflight-safe';
  const riskyId = 'job-inflight-risky';
  fs.writeFileSync(PENDING_REFUNDS_PATH, JSON.stringify({
    [safeId]: { ...entryFor(1.0, 1.0), status: 'approved' },
    [riskyId]: { ...entryFor(1.0, 1.0), status: 'approved' },
  }));
  markRefundInflight(riskyId, { buyerAddress: 'iBuyerTest', amount: 1.0, currency: 'VRSC' });

  await refundsApproveAll(makeState(makeSession(sendCalls)), { yes: true }, PENDING_REFUNDS_PATH);

  assert.equal(sendCalls.length, 1, 'exactly the non-inflight entry may send');
  const refunded = JSON.parse(fs.readFileSync(REFUNDED_JOBS_PATH, 'utf8'));
  assert.ok(refunded.includes(safeId), 'the safe entry was paid');
  assert.ok(!refunded.includes(riskyId), 'the ambiguous entry was NOT paid');
});
