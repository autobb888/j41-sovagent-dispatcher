'use strict';
/**
 * M4 — a 0-conf credit that nobody ever went back to check.
 *
 * `requiredConfirmations` returns 0 below 2 VRSC, so a small deposit is credited
 * straight out of the mempool and is immediately spendable on the proxy. That is a
 * deliberate UX call and it matches the platform's own tiering. What was missing is
 * the other half: a mempool transaction can be evicted, replaced, or simply never
 * mined, and the credit was written to `processed` and never revisited. Free proxy
 * usage up to ~2 VRSC per dropped tx, repeatable with a fresh txid each time.
 *
 * The reconciler is biased toward KEEPING the credit — clawing back a legitimate
 * buyer's balance is worse than a delayed clawback. It reverses only on a positive
 * "the chain does not know this txid", repeated, and past the grace deadline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dep-reconcile-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
delete process.env.J41_DEPOSIT_ALLOW_AUTH_ONLY;

const { generateKeypair, signMessage, buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const {
  reportDeposit,
  reconcileUnconfirmedDeposits,
  requiredConfirmations,
  RECONCILE_GRACE_MS,
  RECONCILE_MIN_MISSES,
} = require('../src/deposit-watcher.js');
const { getBalance } = require('../src/credit-meter.js');

const NET = 'verustest';
const SMALL = 1.5; // under the 2 VRSC tier → credited at 0 confirmations

function depositsFile(agentId) {
  return path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
}
function readDeposits(agentId) {
  return JSON.parse(fs.readFileSync(depositsFile(agentId), 'utf8'));
}

/** Client whose getTxStatus behaviour is swapped per phase of a test. */
function mockClient(kp, buyerVerusId, txStatus) {
  return {
    async getIdentityKeys(id) {
      return { iaddress: 'i' + id, name: id, primaryAddresses: [kp.address], minimumSignatures: 1 };
    },
    async verifyPayment() {
      return { verified: true, senderVerified: true, senderVerusId: buyerVerusId, confirmedAmount: SMALL };
    },
    getTxStatus: txStatus,
  };
}

function signedReport(kp, buyerVerusId, sellerVerusId, txid, amount) {
  const report = {
    buyerVerusId, sellerVerusId, txid,
    amount: String(amount),
    nonce: crypto.randomBytes(8).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000),
  };
  report.signature = signMessage(kp.wif, buildDepositReportMessage(report), NET);
  return report;
}

/** Credit a 0-conf deposit and return the context needed to reconcile it. */
async function creditZeroConf(agentId, buyerVerusId) {
  const kp = generateKeypair(NET);
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const client = mockClient(kp, buyerVerusId, async () => ({ confirmations: 0 }));
  const res = await reportDeposit(agentId, client, signedReport(kp, buyerVerusId, 'seller@', txid, SMALL), 'RpayAddr', NET);
  assert.equal(res.credited, true, 'a sub-2-VRSC deposit is credited from the mempool');
  return { kp, txid, buyerVerusId };
}

const NOT_FOUND = () => { const e = new Error('404 Transaction not found'); e.statusCode = 404; throw e; };

test('the 0-conf tier exists — this is the behaviour being reconciled, not removed', () => {
  assert.equal(requiredConfirmations(1.5), 0);
  assert.equal(requiredConfirmations(2), 1);
  assert.equal(requiredConfirmations(50), 6);
});

test('a 0-conf credit is FLAGGED for reconciliation, not silently final', () => {
  // Without the flag there is nothing for any later sweep to find — which is
  // exactly why the exposure was invisible.
  return (async () => {
    const agentId = 'agent-flag';
    const { txid } = await creditZeroConf(agentId, 'buyerFlag@');
    const rec = readDeposits(agentId).processed.find(d => d.txid === txid);
    assert.equal(rec.unconfirmed, true);
    assert.ok(Number.isFinite(rec.creditedAtMs), 'needs a timestamp to age against the grace window');
  })();
});

test('a credit whose tx later confirms is settled and stops being watched', async () => {
  const agentId = 'agent-confirms';
  const buyer = 'buyerConfirms@';
  const { kp, txid } = await creditZeroConf(agentId, buyer);

  const client = mockClient(kp, buyer, async () => ({ confirmations: 3 }));
  const r = await reconcileUnconfirmedDeposits(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);

  assert.deepEqual([r.confirmed, r.reversed], [1, 0]);
  assert.equal(getBalance(agentId, buyer), SMALL, 'a confirmed deposit keeps its credit');
  const rec = readDeposits(agentId).processed.find(d => d.txid === txid);
  assert.equal(rec.unconfirmed, undefined, 'settled records must not be re-checked forever');
  assert.equal(rec.confirmations, 3);
});

test('a dropped tx is reversed once — past grace AND repeatedly unknown', async () => {
  const agentId = 'agent-dropped';
  const buyer = 'buyerDropped@';
  const { kp, txid } = await creditZeroConf(agentId, buyer);
  assert.equal(getBalance(agentId, buyer), SMALL);

  const client = mockClient(kp, buyer, NOT_FOUND);
  const past = Date.now() + RECONCILE_GRACE_MS + 1;

  // Misses accumulate; nothing is reversed until the run is long enough.
  for (let i = 1; i < RECONCILE_MIN_MISSES; i++) {
    const r = await reconcileUnconfirmedDeposits(agentId, client, past);
    assert.equal(r.reversed, 0, `must not reverse on miss ${i} of ${RECONCILE_MIN_MISSES}`);
    assert.equal(getBalance(agentId, buyer), SMALL);
  }

  const final = await reconcileUnconfirmedDeposits(agentId, client, past);
  assert.equal(final.reversed, 1);
  assert.equal(getBalance(agentId, buyer), 0, 'the unfunded credit is taken back');

  const d = readDeposits(agentId);
  assert.equal(d.processed.some(x => x.txid === txid), false);
  assert.equal(d.reversed.length, 1, 'the reversal is recorded for the operator, not just logged');
  assert.equal(d.reversed[0].txid, txid);

  // And it does not keep reversing — the record is gone from the watch list.
  const again = await reconcileUnconfirmedDeposits(agentId, client, past);
  assert.equal(again.reversed, 0);
  assert.equal(getBalance(agentId, buyer), 0, 'no double clawback');
});

test('inside the grace window nothing is reversed, however many misses', async () => {
  // A tx can legitimately take minutes to appear. Reversing early punishes a
  // buyer who paid.
  const agentId = 'agent-grace';
  const buyer = 'buyerGrace@';
  const { kp } = await creditZeroConf(agentId, buyer);
  const client = mockClient(kp, buyer, NOT_FOUND);

  for (let i = 0; i < RECONCILE_MIN_MISSES + 3; i++) {
    await reconcileUnconfirmedDeposits(agentId, client, Date.now());
  }
  assert.equal(getBalance(agentId, buyer), SMALL, 'grace window not elapsed — hands off');
});

test('an unreachable platform never costs a buyer their balance', async () => {
  // "We could not ask" is not "the tx does not exist". A platform outage used to
  // be the most likely reason for a lookup to fail; it must not look like fraud.
  const agentId = 'agent-outage';
  const buyer = 'buyerOutage@';
  const { kp } = await creditZeroConf(agentId, buyer);
  const client = mockClient(kp, buyer, async () => { throw new Error('ECONNREFUSED api.junction41.io'); });
  const past = Date.now() + RECONCILE_GRACE_MS + 1;

  for (let i = 0; i < RECONCILE_MIN_MISSES + 3; i++) {
    const r = await reconcileUnconfirmedDeposits(agentId, client, past);
    assert.equal(r.reversed, 0);
  }
  assert.equal(getBalance(agentId, buyer), SMALL);
});

test('a sighting in the mempool resets the miss run', async () => {
  // Presence is positive evidence the tx exists. An intermittent index that
  // 404s twice then finds it must not accumulate toward a reversal.
  const agentId = 'agent-flaps';
  const buyer = 'buyerFlaps@';
  const { kp } = await creditZeroConf(agentId, buyer);
  const past = Date.now() + RECONCILE_GRACE_MS + 1;

  const missing = mockClient(kp, buyer, NOT_FOUND);
  const inMempool = mockClient(kp, buyer, async () => ({ confirmations: 0 }));

  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < RECONCILE_MIN_MISSES - 1; i++) {
      await reconcileUnconfirmedDeposits(agentId, missing, past);
    }
    await reconcileUnconfirmedDeposits(agentId, inMempool, past);
  }
  assert.equal(getBalance(agentId, buyer), SMALL, 'never reached a full miss run');
});

test('a reversal on an already-spent credit drives the balance negative, not to zero', async () => {
  // Clamping at zero would forgive compute the buyer never paid for and make the
  // exploit free. reserveCredit refuses while balance < cost, so the debt blocks
  // further spending until it is topped up past it.
  const agentId = 'agent-spent';
  const buyer = 'buyerSpent@';
  const { kp } = await creditZeroConf(agentId, buyer);

  const { adjustCredit } = require('../src/credit-meter.js');
  const pricing = [{ model: 'm', inputTokenRate: 0.001, outputTokenRate: 0.001 }];
  adjustCredit(agentId, buyer, 'm', 1000, 400, 0, pricing); // spend 1.4 of the 1.5
  assert.ok(Math.abs(getBalance(agentId, buyer) - 0.1) < 1e-9);

  const client = mockClient(kp, buyer, NOT_FOUND);
  const past = Date.now() + RECONCILE_GRACE_MS + 1;
  for (let i = 0; i < RECONCILE_MIN_MISSES; i++) {
    await reconcileUnconfirmedDeposits(agentId, client, past);
  }

  const bal = getBalance(agentId, buyer);
  assert.ok(bal < 0, `spent-then-reversed must leave a debt, got ${bal}`);
  assert.ok(Math.abs(bal - -1.4) < 1e-9);
});

test('deposits at or above the 2 VRSC tier are never flagged — they waited for a block', async () => {
  const agentId = 'agent-big';
  const buyer = 'buyerBig@';
  const kp = generateKeypair(NET);
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const client = {
    async getIdentityKeys(id) {
      return { iaddress: 'i' + id, name: id, primaryAddresses: [kp.address], minimumSignatures: 1 };
    },
    async verifyPayment() {
      return { verified: true, senderVerified: true, senderVerusId: buyer, confirmedAmount: 5 };
    },
    async getTxStatus() { return { confirmations: 2 }; },
  };
  const res = await reportDeposit(agentId, client, signedReport(kp, buyer, 'seller@', txid, 5), 'RpayAddr', NET);
  assert.equal(res.credited, true);

  const rec = readDeposits(agentId).processed.find(d => d.txid === txid);
  assert.equal(rec.unconfirmed, undefined, 'a confirmed deposit needs no reconciliation');
  const r = await reconcileUnconfirmedDeposits(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);
  assert.deepEqual([r.confirmed, r.reversed, r.waiting], [0, 0, 0]);
});
