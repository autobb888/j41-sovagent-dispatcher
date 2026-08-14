'use strict';
/**
 * Deposit crash-consistency and dedup-durability (M4 chunk 1).
 *
 * Three defects that all live on `main` today, independent of whether the 0-conf
 * reconciler ever lands. Each one ends with the SAME buyer's deposit credited
 * twice, which is money out of the seller's pocket.
 *
 *  D7  The credit paths mint the meter credit BEFORE persisting the `processed`
 *      dedup record. Anything that stops the save — a crash, ENOSPC, a full
 *      disk — leaves a credited meter and no record of it, so the next attempt
 *      credits again. The reversal path in the M4 branch has a two-phase
 *      intent protocol for exactly this reason; the credit paths never got one.
 *      NOT capped by the 2 VRSC tier: this is the 6-confirmation, >10 VRSC path
 *      too, which makes it the largest single exposure in the file.
 *
 *  D3  `reportDeposit`'s under-confirmed branch saves the `deposits` snapshot it
 *      loaded BEFORE its verifyPayment/getTxStatus awaits. A commit that landed
 *      during those awaits is overwritten — including that txid's dedup entry.
 *      The credit path re-loads fresh for precisely this reason (see its "audit
 *      M4" comment); the pending path was never given the same treatment.
 *
 *  D4  `processed.slice(-1000)` is both the audit log and the dedup ledger. Trim
 *      the log and you silently trim the dedup, so a txid older than 1000
 *      deposits can be re-reported and credited a second time.
 *
 * On D4 and the "restart" helper: within one process the in-memory claim set
 * (`_claimsInProgress`) masks D4, because a committed claim is deliberately
 * never released. The exposure needs a fresh process — routine here, given the
 * daily maintenance restarts and deploys. `restartModule()` models that by
 * dropping the module from require.cache, the same trick the M4 branch's own
 * tests use via `_forgetClaimForTest`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Sandbox HOME BEFORE requiring app modules so meter/deposit files land in /tmp.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dep-crash-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
delete process.env.J41_DEPOSIT_ALLOW_AUTH_ONLY;

const { generateKeypair, signMessage, buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { getBalance } = require('../src/credit-meter.js');

const NET = 'verustest';

const WATCHER = require.resolve('../src/deposit-watcher.js');

/** Re-require deposit-watcher with empty module state — models a process restart. */
function restartModule() {
  delete require.cache[WATCHER];
  return require('../src/deposit-watcher.js');
}

function depositsFile(agentId) {
  return path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
}

function readDeposits(agentId) {
  try { return JSON.parse(fs.readFileSync(depositsFile(agentId), 'utf8')); } catch { return null; }
}

function writeDeposits(agentId, data) {
  const p = depositsFile(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Fail the NEXT save of deposits.json, and only that one.
 *
 * Targets `renameSync` because that is the commit point of saveDeposits'
 * tmp→rename. Scoped to deposits.json by destination path so the credit meter's
 * own save (same tmp→rename idiom) still succeeds — which is the whole point:
 * the money moves and the record of it does not.
 */
function failNextDepositSave() {
  const realRename = fs.renameSync;
  let armed = true;
  fs.renameSync = (from, to, ...rest) => {
    if (armed && String(to).endsWith('deposits.json')) {
      armed = false;
      throw Object.assign(new Error('ENOSPC: simulated crash before the dedup record was durable'), { code: 'ENOSPC' });
    }
    return realRename(from, to, ...rest);
  };
  return () => { fs.renameSync = realRename; };
}

function mockClient(buyerKp, buyerVerusId, { confirmations = 10, onGetTxStatus } = {}) {
  return {
    async getIdentityKeys(id) {
      return { iaddress: 'i' + id, name: id, primaryAddresses: [buyerKp.address], minimumSignatures: 1 };
    },
    async verifyPayment() {
      return { verified: true, senderVerified: true, senderVerusId: buyerVerusId };
    },
    async getTxStatus() {
      if (onGetTxStatus) await onGetTxStatus();
      return { confirmations };
    },
  };
}

function signedReport(kp, buyerVerusId, sellerVerusId, txid, amount) {
  const report = {
    buyerVerusId,
    sellerVerusId,
    txid,
    amount: String(amount),
    nonce: crypto.randomBytes(8).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000),
  };
  report.signature = signMessage(kp.wif, buildDepositReportMessage(report), NET);
  return report;
}

// ── D7 — credit before persist ──────────────────────────────────────────────

test('D7: a crash between crediting and persisting does not double-credit on retry (report path)', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-d7a@';
  const agentId = 'agent-d7-report';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 50; // >10 VRSC: the 6-confirmation tier. This defect is NOT tier-capped.

  const { reportDeposit } = restartModule();
  const client = mockClient(kp, buyerVerusId);

  const restore = failNextDepositSave();
  let first;
  try {
    first = await reportDeposit(agentId, client, signedReport(kp, buyerVerusId, 'seller@', txid, amount), 'RpayAddr', NET);
  } finally {
    restore();
  }
  assert.equal(first.credited, false, 'the save failed, so the call must not report success');

  // The buyer either got nothing (credit deferred until the record is durable)
  // or got exactly one credit that a later retry must not repeat. Both are
  // acceptable; two credits are not.
  const afterCrash = getBalance(agentId, buyerVerusId);

  // Retry the same deposit, exactly as a buyer or the poller would.
  const retry = await reportDeposit(agentId, client, signedReport(kp, buyerVerusId, 'seller@', txid, amount), 'RpayAddr', NET);

  const finalBalance = getBalance(agentId, buyerVerusId);
  assert.equal(finalBalance, amount,
    `one deposit of ${amount} must credit exactly ${amount}; got ${finalBalance} ` +
    `(${afterCrash} after the crash, retry credited=${retry.credited}) — the meter moved before the dedup record was durable`);
});

test('D7: a crash between crediting and persisting does not double-credit on the next poll (poller path)', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-d7b@';
  const agentId = 'agent-d7-poll';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 5; // 1-confirmation tier

  const { reportDeposit, pollPendingDeposits } = restartModule();

  // Land it in `pending` first by reporting while unconfirmed.
  const pendRes = await reportDeposit(agentId, mockClient(kp, buyerVerusId, { confirmations: 0 }),
    signedReport(kp, buyerVerusId, 'seller@', txid, amount), 'RpayAddr', NET);
  assert.equal(pendRes.credited, false);
  assert.equal(readDeposits(agentId).pending.length, 1, 'deposit should be parked in pending');

  // Now it confirms. The poller credits the meter, then the save crashes.
  const confirmed = mockClient(kp, buyerVerusId, { confirmations: 10 });
  const restore = failNextDepositSave();
  try {
    await pollPendingDeposits(agentId, confirmed);
  } finally {
    restore();
  }

  // Next poll tick — the entry is still pending, so it runs again.
  await pollPendingDeposits(agentId, confirmed);

  const finalBalance = getBalance(agentId, buyerVerusId);
  assert.equal(finalBalance, amount,
    `one deposit of ${amount} must credit exactly ${amount}; got ${finalBalance} — ` +
    'the poller credited before its dedup record was durable and the retry credited again');
});

// ── D3 — the pending-path stale save ────────────────────────────────────────

test('D3: the pending-path save must not clobber a commit that landed during its awaits', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-d3@';
  const agentId = 'agent-d3';
  const txPending = 'tx_' + crypto.randomBytes(8).toString('hex');
  const txConcurrent = 'tx_' + crypto.randomBytes(8).toString('hex');

  const { reportDeposit } = restartModule();

  // Seed a real deposits.json so the stale snapshot has something to overwrite.
  writeDeposits(agentId, { processed: [], pending: [] });

  // While reportDeposit is awaiting, a concurrent path (the poller, another
  // report) durably commits txConcurrent to `processed`.
  const client = mockClient(kp, buyerVerusId, {
    confirmations: 0, // forces the under-confirmed / pending branch
    onGetTxStatus: async () => {
      const d = readDeposits(agentId);
      d.processed.push({
        txid: txConcurrent,
        buyerVerusId,
        amount: 7,
        confirmations: 12,
        creditedAt: new Date().toISOString(),
      });
      writeDeposits(agentId, d);
    },
  });

  const res = await reportDeposit(agentId, client, signedReport(kp, buyerVerusId, 'seller@', txPending, 5), 'RpayAddr', NET);
  assert.equal(res.credited, false, 'under-confirmed deposit parks in pending');

  const after = readDeposits(agentId);
  assert.ok(after.pending.some((d) => d.txid === txPending), 'the reported deposit should be parked in pending');
  assert.ok(after.processed.some((d) => d.txid === txConcurrent),
    'the concurrently-committed dedup entry was erased by the stale snapshot — ' +
    'that txid can now be re-reported and credited a second time');
});

test('a normal credit leaves a settled record, not a permanent mid-credit flag', async () => {
  // The intent flag is what tells an operator "a human must look". If the happy
  // path never cleared it, every record would say that and the signal would be
  // worth nothing — the write-only-ledger failure this whole effort is about.
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-settle@';
  const agentId = 'agent-settle';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');

  const { reportDeposit } = restartModule();
  const res = await reportDeposit(agentId, mockClient(kp, buyerVerusId),
    signedReport(kp, buyerVerusId, 'seller@', txid, 6), 'RpayAddr', NET);
  assert.equal(res.credited, true);

  const rec = readDeposits(agentId).processed.find((d) => d.txid === txid);
  assert.ok(rec, 'the deposit should be recorded');
  assert.equal(rec.crediting, undefined, 'a settled credit must not stay flagged mid-credit');
  assert.ok(rec.creditedAt, 'a settled credit must carry creditedAt');
  assert.equal(getBalance(agentId, buyerVerusId), 6);
});

// ── D4 — the trim eats the dedup ledger ─────────────────────────────────────

test('D4: trimming the processed log must not drop a txid out of the dedup ledger', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-d4@';
  const agentId = 'agent-d4';
  const oldTxid = 'tx_old_' + crypto.randomBytes(6).toString('hex');
  const amount = 4;

  // Seed exactly 1000 processed records, oldest first, with our target at the head.
  const processed = [{
    txid: oldTxid,
    buyerVerusId,
    amount,
    confirmations: 9,
    creditedAt: new Date(Date.now() - 90 * 86400_000).toISOString(),
  }];
  for (let i = 1; i < 1000; i++) {
    processed.push({
      txid: `tx_filler_${i}`,
      buyerVerusId: 'someone-else@',
      amount: 1,
      confirmations: 9,
      creditedAt: new Date(Date.now() - (90 - i * 0.05) * 86400_000).toISOString(),
    });
  }
  writeDeposits(agentId, { processed, pending: [] });

  // One more deposit pushes the ledger to 1001 and triggers the trim.
  const { reportDeposit } = restartModule();
  const client = mockClient(kp, buyerVerusId);
  const fresh = await reportDeposit(agentId, client,
    signedReport(kp, buyerVerusId, 'seller@', 'tx_' + crypto.randomBytes(8).toString('hex'), 1), 'RpayAddr', NET);
  assert.equal(fresh.credited, true, 'the new deposit should credit normally');

  // Restart, so the in-memory claim set no longer masks a missing dedup entry.
  const { reportDeposit: reportAfterRestart } = restartModule();
  const balanceBefore = getBalance(agentId, buyerVerusId);

  const replay = await reportAfterRestart(agentId, client,
    signedReport(kp, buyerVerusId, 'seller@', oldTxid, amount), 'RpayAddr', NET);

  assert.equal(replay.credited, false,
    'a deposit already credited 1000 deposits ago was credited again — the trim ' +
    'evicted its dedup entry along with its audit record');
  assert.equal(getBalance(agentId, buyerVerusId), balanceBefore,
    'balance must not move when an already-credited txid is re-reported');
});

test('the audit trim must not discard an unresolved mid-credit record', async () => {
  // A `crediting` record is an open money question: the meter may or may not
  // have moved, and only a human can settle it. Trimming it for size would
  // erase the sole evidence that anyone needs to look — so open records are
  // exempt from the cap even when that pushes the log one over.
  const agentId = 'agent-trim-exempt';

  // All three open states, at the head of the log where the trim bites first.
  // `unconfirmed` matters as much as `crediting`: trimming a credit the
  // reconciler is still tracking silently retires it, and the claw-back can
  // never happen. `needsOperator` is the only record of a balance a human must
  // check. None of them may be dropped for size.
  const openTxids = { crediting: 'tx_stuck_c', unconfirmed: 'tx_stuck_u', needsOperator: 'tx_stuck_n' };
  const processed = [
    { txid: openTxids.crediting, buyerVerusId: 'buyer-stuck@', amount: 2, crediting: true, intentAt: new Date(Date.now() - 30 * 86400_000).toISOString() },
    { txid: openTxids.unconfirmed, buyerVerusId: 'buyer-open@', amount: 1.5, confirmations: 0, unconfirmed: true, creditedAtMs: Date.now() - 3600_000, misses: 2 },
    { txid: openTxids.needsOperator, buyerVerusId: 'buyer-amb@', amount: 1, confirmations: 3, needsOperator: 'balance may be off' },
  ];
  const stuckTxid = openTxids.crediting;
  for (let i = 1; i < 1000; i++) {
    processed.push({
      txid: `tx_pad_${i}`,
      buyerVerusId: 'someone-else@',
      amount: 1,
      confirmations: 9,
      creditedAt: new Date().toISOString(),
    });
  }
  writeDeposits(agentId, { processed, pending: [], creditedTxids: processed.map((r) => r.txid) });

  // One more credit pushes the log over the cap and triggers the trim.
  const kp = generateKeypair(NET);
  const { reportDeposit } = restartModule();
  const res = await reportDeposit(agentId, mockClient(kp, 'buyer-new@'),
    signedReport(kp, 'buyer-new@', 'seller@', 'tx_' + crypto.randomBytes(8).toString('hex'), 3), 'RpayAddr', NET);
  assert.equal(res.credited, true);

  const after = readDeposits(agentId);
  assert.ok(after.processed.some((d) => d.txid === stuckTxid && d.crediting),
    'the unresolved mid-credit record was trimmed away — the only evidence that a ' +
    'buyer\'s balance may be wrong is now gone');
  assert.ok(after.processed.some((d) => d.txid === openTxids.unconfirmed && d.unconfirmed),
    'an open 0-conf credit was trimmed away — the reconciler can never claw it back now');
  assert.ok(after.processed.some((d) => d.txid === openTxids.needsOperator && d.needsOperator),
    'a record flagged for operator review was trimmed away');
});

test('a meter write that fails after the intent is recorded reports honestly', async () => {
  // The fail-closed choice here is deliberate: the txid is already in the dedup
  // ledger, so nothing retries it, and the buyer is under-credited until a human
  // acts. That is the right direction — but only if the caller is told what
  // actually happened instead of a generic verification error.
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-meterfail@';
  const agentId = 'agent-meterfail';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');

  const { reportDeposit } = restartModule();

  const realRename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (String(to).endsWith('credit-meters.json')) throw new Error('EIO: meter write failed');
    return realRename(from, to, ...rest);
  };
  let res;
  try {
    res = await reportDeposit(agentId, mockClient(kp, buyerVerusId),
      signedReport(kp, buyerVerusId, 'seller@', txid, 8), 'RpayAddr', NET);
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(res.credited, false);
  assert.equal(res.code, 'CREDIT_WRITE_FAILED',
    `expected a distinct code naming the real failure, got ${JSON.stringify(res)}`);
  assert.equal(getBalance(agentId, buyerVerusId), 0, 'no credit should have landed');

  const rec = readDeposits(agentId).processed.find((d) => d.txid === txid);
  assert.ok(rec && rec.crediting, 'the deposit must stay flagged mid-credit for a human');
});
