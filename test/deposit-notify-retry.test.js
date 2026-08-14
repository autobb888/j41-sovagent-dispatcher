'use strict';
/**
 * Deposit-notify retry (backend reply 2026-08-14, item A1).
 *
 * The platform now verifies the funding transaction is visible on ITS OWN node
 * before routing a `deposit-confirmed`, and returns 503 when it is not:
 * `DEPOSIT_TX_NOT_VISIBLE` (never broadcast, or not yet propagated to their
 * node) or `VERIFICATION_UNAVAILABLE` (their RPC is down).
 *
 * Both are routine, not exceptional. We credit from OUR mempool view and notify
 * immediately, so losing the propagation race is the NORMAL case; and their
 * testnet node is shed under memory pressure daily around 09:00 UTC for ~45
 * minutes.
 *
 * Our notify used to be fire-and-forget: a 503 produced a `console.warn` and the
 * notification was gone. No money is at risk either way — the platform holds no
 * reversible balance for a deposit — but the buyer silently never gets the inbox
 * card. The backend's note asked us to "retry across, or re-fire after, that
 * window". These tests hold us to it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

// The module resolves AGENTS_DIR once at load, so HOME must be set BEFORE the
// require — the same pattern every other deposit test file uses. Each test gets
// its own agent id instead of its own home.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-notify-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

let agentSeq = 0;

function depositsPath(agentId) {
  return path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
}

/** Seed a fresh agent's ledger and return [agentId, filePath]. */
function seed(processed) {
  const agentId = `agent-${++agentSeq}`;
  const p = depositsPath(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ processed, pending: [], reversed: [], creditedTxids: [] }));
  return [agentId, p];
}

async function withHome(fn) { return fn(TEST_HOME); }

// A REAL testnet key: notifyJ41DepositConfirmed signs before it fetches, so a
// placeholder WIF would fail locally and never exercise the HTTP classification
// these tests exist to check.
const { generateKeypair } = require('../src/keygen.js');
const CTX = { sellerWif: generateKeypair('verustest').wif, sellerVerusId: 'seller@', network: 'verustest' };

test('a LOCAL signing failure is permanent, not a retryable outage', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId, p] = seed([
      { txid: '9'.repeat(64), buyerVerusId: 'b@', amount: 1, notifyPending: true },
    ]);
    // A bad WIF fails identically forever; letting it eat the retry budget
    // would hide a local defect behind an apparent platform outage.
    await dw.retryPendingNotifies(agentId, { ...CTX, sellerWif: 'not-a-wif' }, Date.now());
    const after = JSON.parse(fs.readFileSync(p, 'utf8')).processed[0];
    assert.equal(after.notifyGaveUp, 'rejected');
  });
});

test('a retryable failure is re-fired rather than dropped', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId, p] = seed([
      { txid: 'a'.repeat(64), buyerVerusId: 'buyer@', amount: 1, notifyPending: true },
    ]);

    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls += 1; return { ok: false, status: 503, text: async () => 'DEPOSIT_TX_NOT_VISIBLE' }; };
    try {
      const r = await dw.retryPendingNotifies(agentId, CTX, Date.now());
      assert.equal(r.attempted, 1);
      assert.equal(r.ok, 0);
    } finally { global.fetch = realFetch; }

    assert.equal(calls, 1, 'the owed notify must actually be re-sent');
    const after = JSON.parse(fs.readFileSync(p, 'utf8')).processed[0];
    assert.equal(after.notifyPending, true, 'still owed after a 503');
    assert.equal(after.notifyAttempts, 1);
    assert.ok(after.notifyNextAt > Date.now(), 'backoff must be scheduled, not immediate');
  });
});

test('a successful re-fire clears the debt', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId, p] = seed([
      { txid: 'b'.repeat(64), buyerVerusId: 'buyer@', amount: 1, notifyPending: true, notifyAttempts: 3 },
    ]);

    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
    try {
      const r = await dw.retryPendingNotifies(agentId, CTX, Date.now());
      assert.equal(r.ok, 1);
    } finally { global.fetch = realFetch; }

    const after = JSON.parse(fs.readFileSync(p, 'utf8')).processed[0];
    assert.ok(!after.notifyPending, 'debt cleared');
    assert.ok(!after.notifyAttempts, 'attempt counter cleared');
  });
});

test('backoff is respected — a not-yet-due notify is not re-sent', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const now = Date.now();
    const [agentId] = seed([
      { txid: 'c'.repeat(64), buyerVerusId: 'b@', amount: 1, notifyPending: true, notifyAttempts: 1, notifyNextAt: now + 600000 },
    ]);
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls += 1; return { ok: true, status: 200, text: async () => '' }; };
    try {
      const r = await dw.retryPendingNotifies(agentId, CTX, now);
      assert.equal(r.attempted, 0);
    } finally { global.fetch = realFetch; }
    assert.equal(calls, 0, 'must not hammer the platform inside the backoff');
  });
});

test('retry is BOUNDED — it gives up loudly rather than spinning forever', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId, p] = seed([
      {
        txid: 'd'.repeat(64), buyerVerusId: 'b@', amount: 1,
        notifyPending: true, notifyAttempts: dw.NOTIFY_MAX_ATTEMPTS - 1,
      },
    ]);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
    try {
      await dw.retryPendingNotifies(agentId, CTX, Date.now());
    } finally { global.fetch = realFetch; }

    const after = JSON.parse(fs.readFileSync(p, 'utf8')).processed[0];
    assert.equal(after.notifyPending, false);
    assert.equal(after.notifyGaveUp, 'exhausted');
    // It must stay in the ledger, visible, not be deleted.
    assert.equal(after.txid, 'd'.repeat(64));
  });
});

test('a permanent rejection is not retried', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId, p] = seed([
      { txid: 'e'.repeat(64), buyerVerusId: 'b@', amount: 1, notifyPending: true },
    ]);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad txid' });
    try {
      await dw.retryPendingNotifies(agentId, CTX, Date.now());
    } finally { global.fetch = realFetch; }

    const after = JSON.parse(fs.readFileSync(p, 'utf8')).processed[0];
    assert.equal(after.notifyPending, false);
    assert.equal(after.notifyGaveUp, 'rejected',
      'a 400 means the platform will never accept it — retrying is pointless load');
  });
});

test('a network failure counts as retryable, not permanent', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId, p] = seed([
      { txid: 'f'.repeat(64), buyerVerusId: 'b@', amount: 1, notifyPending: true },
    ]);
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      await dw.retryPendingNotifies(agentId, CTX, Date.now());
    } finally { global.fetch = realFetch; }

    const after = JSON.parse(fs.readFileSync(p, 'utf8')).processed[0];
    assert.equal(after.notifyPending, true, 'the platform being unreachable is not a rejection');
  });
});

test('a given-up notify is never resurrected', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    const [agentId] = seed([
      { txid: 'a'.repeat(64), buyerVerusId: 'b@', amount: 1, notifyPending: false, notifyGaveUp: 'exhausted' },
    ]);
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls += 1; return { ok: true, status: 200, text: async () => '' }; };
    try {
      const r = await dw.retryPendingNotifies(agentId, CTX, Date.now());
      assert.equal(r.attempted, 0);
    } finally { global.fetch = realFetch; }
    assert.equal(calls, 0);
  });
});

test('retryPendingNotifies never throws on a missing or corrupt ledger', async () => {
  await withHome(async (home) => {
    const dw = require('../src/deposit-watcher.js');
    // No file at all.
    await assert.doesNotReject(() => dw.retryPendingNotifies('ghost-agent', CTX, Date.now()));
    // Corrupt file.
    const p = depositsPath('corrupt-agent');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ not json');
    await assert.doesNotReject(() => dw.retryPendingNotifies('corrupt-agent', CTX, Date.now()));
    // No context (agent has no notify context registered).
    await assert.doesNotReject(() => dw.retryPendingNotifies('corrupt-agent', null, Date.now()));
  });
});
