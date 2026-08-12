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
  RECONCILE_MISS_SPAN_MS,
  RECONCILE_WEAK_MIN_MISSES,
  RECONCILE_WEAK_SPAN_MS,
  REVERSAL_RECHECK_WINDOW_MS,
  _isTxUnknown,
} = require('../src/deposit-watcher.js');
const { getBalance } = require('../src/credit-meter.js');

/**
 * Drive a full miss run: RECONCILE_MIN_MISSES lookups spread over more than
 * RECONCILE_MISS_SPAN_MS, all past the grace window. Returns the last result.
 */
async function fullMissRun(agentId, client, startAt) {
  const step = Math.ceil(RECONCILE_MISS_SPAN_MS / (RECONCILE_MIN_MISSES - 1)) + 1000;
  let last;
  for (let i = 0; i < RECONCILE_MIN_MISSES; i++) {
    last = await reconcileUnconfirmedDeposits(agentId, client, startAt + i * step);
  }
  return last;
}

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
    getTxStatus: (txid) => txStatus(txid),
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

  const final = await fullMissRun(agentId, client, past);
  assert.equal(final.reversed, 1);
  assert.equal(getBalance(agentId, buyer), 0, 'the unfunded credit is taken back');

  const d = readDeposits(agentId);
  assert.equal(d.processed.some(x => x.txid === txid), false);
  assert.equal(d.reversed.length, 1, 'the reversal is recorded for the operator, not just logged');
  assert.equal(d.reversed[0].txid, txid);

  // And it does not keep reversing — the record is gone from the watch list.
  const again = await fullMissRun(agentId, client, past);
  assert.equal(again.reversed, 0);
  assert.equal(getBalance(agentId, buyer), 0, 'no double clawback');
});

test('three fast misses are NOT enough — the run must span real time', async () => {
  // Three polls is three minutes, which one routine backend deploy window supplies
  // on its own. A deploy is also exactly when the tx-status route is most likely to
  // answer wrongly, so a short run must not be sufficient evidence.
  const agentId = 'agent-fastmiss';
  const buyer = 'buyerFastMiss@';
  const { kp } = await creditZeroConf(agentId, buyer);
  const client = mockClient(kp, buyer, NOT_FOUND);
  const past = Date.now() + RECONCILE_GRACE_MS + 1;

  for (let i = 0; i < RECONCILE_MIN_MISSES + 2; i++) {
    const r = await reconcileUnconfirmedDeposits(agentId, client, past + i * 60_000);
    assert.equal(r.reversed, 0, 'a burst of misses inside the span window proves nothing');
  }
  assert.equal(getBalance(agentId, buyer), SMALL);
});

test('a RESOLVED response we cannot interpret never reverses', async () => {
  // The original code set `seen = null` for an unreadable success response and then
  // fell straight through to the reversal path — so a backend response-shape change
  // would have clawed back every open 0-conf credit on the fleet within three polls.
  // This codebase already documents four separate `{data:}` unwrap gotchas; the
  // shape changing is a when, not an if.
  const shapes = [
    ['empty body', async () => undefined],
    ['empty object', async () => ({})],
    ['stringified count', async () => ({ confirmations: '3' })],
    ['re-wrapped in data', async () => ({ data: { confirmations: 3 } })],
    ['null', async () => null],
  ];
  for (const [label, getTxStatus] of shapes) {
    const agentId = `agent-shape-${label.replace(/\W+/g, '')}`;
    const buyer = `buyerShape${label.replace(/\W+/g, '')}@`;
    const { kp } = await creditZeroConf(agentId, buyer);
    const client = mockClient(kp, buyer, getTxStatus);
    await fullMissRun(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);
    assert.equal(getBalance(agentId, buyer), SMALL, `${label}: must not reverse`);
  }
});

test('a route-level 404 is not evidence that the chain lacks the txid', () => {
  // The SDK surfaces a missing/renamed endpoint as a bare `HTTP 404`, identically
  // for every txid. Matching a bare 404 would reverse the whole fleet's open
  // credits during one deploy window.
  assert.equal(_isTxUnknown(new Error('HTTP 404')), false);
  assert.equal(_isTxUnknown(new Error('Non-JSON response from GET /v1/tx/status/abc (HTTP 404)')), false);
  assert.equal(_isTxUnknown(new Error('404 Not Found')), false);
  assert.equal(_isTxUnknown(new Error('ECONNREFUSED')), false);
  assert.equal(_isTxUnknown(new Error('502 Bad Gateway')), false);

  // Transaction-specific signals do count.
  assert.equal(_isTxUnknown(new Error('404 Transaction not found')), true);
  assert.equal(_isTxUnknown(new Error('No such transaction')), true);
  assert.equal(_isTxUnknown(new Error('{"code":"TX_NOT_FOUND"}')), true);
  assert.equal(_isTxUnknown(new Error('Invalid or non-wallet transaction id')), true);
});

test('a crash mid-reversal completes the bookkeeping without debiting twice', async () => {
  // reverseDeposit writes credit-meters.json; clearing the record writes
  // deposits.json. Two atomic writes, one crash window. The `reversing` stamp is
  // persisted BEFORE the debit so the recovery path knows the money may already
  // have moved — the same shape as markRefundInflight on the refund path.
  const agentId = 'agent-crashmid';
  const buyer = 'buyerCrashMid@';
  const { kp, txid } = await creditZeroConf(agentId, buyer);

  // Simulate the crash: the meter was debited and the stamp persisted, but the
  // record was never removed.
  const { reverseDeposit } = require('../src/credit-meter.js');
  reverseDeposit(agentId, buyer, SMALL, txid);
  const d = readDeposits(agentId);
  const rec = d.processed.find(x => x.txid === txid);
  rec.reversal = 'debited';   // the debit provably ran
  fs.writeFileSync(depositsFile(agentId), JSON.stringify(d));
  assert.equal(getBalance(agentId, buyer), 0);

  const client = mockClient(kp, buyer, NOT_FOUND);
  await reconcileUnconfirmedDeposits(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);

  assert.equal(getBalance(agentId, buyer), 0, 'must NOT debit a second time');
  const after = readDeposits(agentId);
  assert.equal(after.processed.some(x => x.txid === txid), false, 'the record is finally cleared');
  assert.equal(after.reversed.length, 1);
});

test('inside the grace window nothing is reversed, however many misses', async () => {
  // A tx can legitimately take minutes to appear. Reversing early punishes a
  // buyer who paid.
  const agentId = 'agent-grace';
  const buyer = 'buyerGrace@';
  const { kp } = await creditZeroConf(agentId, buyer);
  const client = mockClient(kp, buyer, NOT_FOUND);

  await fullMissRun(agentId, client, Date.now());
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

  const r = await fullMissRun(agentId, client, past);
  assert.equal(r.reversed, 0);
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

  const step = RECONCILE_MISS_SPAN_MS;
  let t = past;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < RECONCILE_MIN_MISSES - 1; i++) {
      await reconcileUnconfirmedDeposits(agentId, missing, (t += step));
    }
    await reconcileUnconfirmedDeposits(agentId, inMempool, (t += step));
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
  await fullMissRun(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);

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

test('a partially-reversed credit whose tx later confirms is RE-CREDITED', () => {
  // Reachable only when a crash lands between the meter debit and the record
  // removal, and the tx — declared unknown to the chain for over 40 minutes — then
  // actually confirms. Vanishingly rare, but the outcome was a buyer charged for a
  // deposit they genuinely funded, which is the one direction that must never stand.
  return (async () => {
    const agentId = 'agent-reversed-then-confirms';
    const buyer = 'buyerReversedThenConfirms@';
    const { kp, txid } = await creditZeroConf(agentId, buyer);

    // Simulate the crash: debited, stamped, record not yet removed.
    const { reverseDeposit } = require('../src/credit-meter.js');
    reverseDeposit(agentId, buyer, SMALL, txid);
    const d = readDeposits(agentId);
    d.processed.find(x => x.txid === txid).reversal = 'debited';
    fs.writeFileSync(depositsFile(agentId), JSON.stringify(d));
    assert.equal(getBalance(agentId, buyer), 0);

    // It confirms after all.
    const client = mockClient(kp, buyer, async () => ({ confirmations: 4 }));
    const r = await reconcileUnconfirmedDeposits(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);

    assert.equal(r.confirmed, 1);
    assert.equal(getBalance(agentId, buyer), SMALL, 'the wrongly-debited credit must come back');
    const after = readDeposits(agentId).processed.find(x => x.txid === txid);
    assert.equal(after.reversal, undefined);
    assert.equal(after.unconfirmed, undefined);
  })();
});

test('an AMBIGUOUS reversal state moves no money and escalates to the operator', () => {
  // `reversal: 'debiting'` means the intent was stamped but we cannot prove the
  // debit ran — the stamp is written BEFORE the debit precisely so a crash is
  // recoverable, which is exactly why it cannot also stand as proof the debit
  // happened. The first version conflated the two: on the confirm path it re-credited
  // unconditionally, so a crash between stamp and debit gave the buyer 2× the
  // deposit; on the unknown path it skipped the debit. Opposite assumptions from one
  // flag.
  //
  // Where we genuinely cannot tell, no money moves and a human is told — the same
  // rule the refund in-flight marker follows.
  return (async () => {
    const agentId = 'agent-ambiguous-reversal';
    const buyer = 'buyerAmbiguous@';
    const { kp, txid } = await creditZeroConf(agentId, buyer);

    const d = readDeposits(agentId);
    d.processed.find(x => x.txid === txid).reversal = 'debiting';
    fs.writeFileSync(depositsFile(agentId), JSON.stringify(d));
    const before = getBalance(agentId, buyer);

    const client = mockClient(kp, buyer, async () => ({ confirmations: 4 }));
    await reconcileUnconfirmedDeposits(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);

    assert.equal(getBalance(agentId, buyer), before, 'no money may move on a guess');
    const after = readDeposits(agentId).processed.find(x => x.txid === txid);
    assert.ok(after.needsOperator, 'the ambiguity must be recorded for a human');
    assert.equal(after.unconfirmed, undefined, 'and it must stop being re-checked forever');
  })();
});

test('the reversal is a two-phase state machine, so a crash is never a guess', () => {
  // Walks the happy path and asserts the record ends up debited-and-finalised.
  return (async () => {
    const agentId = 'agent-twophase';
    const buyer = 'buyerTwoPhase@';
    const { kp, txid } = await creditZeroConf(agentId, buyer);
    const client = mockClient(kp, buyer, NOT_FOUND);
    await fullMissRun(agentId, client, Date.now() + RECONCILE_GRACE_MS + 1);

    assert.equal(getBalance(agentId, buyer), 0, 'debited exactly once');
    const d = readDeposits(agentId);
    assert.equal(d.processed.some(x => x.txid === txid), false, 'record finalised');
    assert.equal(d.reversed.length, 1);
  })();
});

// ── The systemic guard, which did not work (round 4) ────────────────────────
//
// A route-level 404 — a renamed endpoint, a proxy answering during a deploy —
// looks identical to "the chain does not know this txid", for every txid at once.
// The guard meant to tell those apart was written inside the per-record loop, so
// it (a) incremented and PERSISTED a miss before testing, and (b) compared a
// counter still being accumulated against the total, making it true only for the
// last record of each pass. Reproduced in review: three credits, one outage, all
// three buyers clawed back. It is now judged across a completed pass.

test('a fleet-wide identical 404 outage reverses NOBODY, however long it lasts', async () => {
  const agentId = 'agent-systemic';
  const buyers = ['buyerSysA@', 'buyerSysB@', 'buyerSysC@'];
  const kps = [];
  for (const b of buyers) kps.push((await creditZeroConf(agentId, b)).kp);
  for (const b of buyers) assert.equal(getBalance(agentId, b), SMALL);

  // The platform's own documented generic 404 body, identical for every txid.
  const routeDown = mockClient(kps[0], buyers[0], () => {
    const e = new Error('The requested resource does not exist');
    e.code = 'NOT_FOUND';
    e.statusCode = 404;
    throw e;
  });

  // Two and a half hours of it — well past both the grace window and the weak span.
  let t = Date.now() + RECONCILE_GRACE_MS + 1;
  for (let i = 0; i < 12; i++) {
    const r = await reconcileUnconfirmedDeposits(agentId, routeDown, t);
    assert.equal(r.reversed, 0, `pass ${i}: a route fault is not evidence about any transaction`);
    t += 15 * 60 * 1000;
  }
  for (const b of buyers) {
    assert.equal(getBalance(agentId, b), SMALL, `${b} must keep their credit through a route outage`);
  }
});

test('a systemic pass counts NO misses — an outage cannot accumulate its way to a reversal', async () => {
  // The original persisted an incremented miss on every systemic pass, so the
  // guard delayed the clawback rather than preventing it.
  const agentId = 'agent-systemic-counts';
  for (const b of ['buyerCntA@', 'buyerCntB@']) await creditZeroConf(agentId, b);

  const routeDown = mockClient({ address: 'x' }, 'buyerCntA@', () => {
    const e = new Error('HTTP 404'); e.statusCode = 404; throw e;
  });
  const past = Date.now() + RECONCILE_GRACE_MS + 1;
  for (let i = 0; i < 8; i++) await reconcileUnconfirmedDeposits(agentId, routeDown, past + i * 20 * 60 * 1000);

  for (const rec of readDeposits(agentId).processed) {
    assert.ok(!rec.misses, `no miss may be recorded during a systemic fault (got ${rec.misses})`);
  }
});

test('an ISOLATED weak 404 still reverses, on the slower weak schedule', async () => {
  // The guard must not make the feature inert: one dropped tx among healthy peers
  // is exactly the case it exists to catch. Weak evidence, so 6 misses over 2h.
  const agentId = 'agent-isolated-weak';
  const dropped = 'buyerIsoDropped@';
  const healthy = 'buyerIsoHealthy@';
  const d = await creditZeroConf(agentId, dropped);
  const h = await creditZeroConf(agentId, healthy);

  // One txid 404s; the other is happily sitting in the mempool.
  const mixed = mockClient(d.kp, dropped, async (txid) => {
    if (txid === d.txid) { const e = new Error('HTTP 404'); e.statusCode = 404; throw e; }
    return { confirmations: 0 };
  });

  let t = Date.now() + RECONCILE_GRACE_MS + 1;
  for (let i = 0; i < RECONCILE_WEAK_MIN_MISSES; i++) {
    await reconcileUnconfirmedDeposits(agentId, mixed, t);
    t += Math.ceil(RECONCILE_WEAK_SPAN_MS / (RECONCILE_WEAK_MIN_MISSES - 1)) + 1000;
  }

  assert.equal(getBalance(agentId, dropped), 0, 'the isolated dropped tx IS reversed');
  assert.equal(getBalance(agentId, healthy), SMALL, 'its healthy peer is untouched');
});

test('the weak tier is slower than the strong tier — a bare 404 buys more time', async () => {
  // Nothing referenced RECONCILE_WEAK_* before, so deleting the weak downgrade
  // silently demoted every 404 to the 3-miss/10-minute schedule.
  assert.ok(RECONCILE_WEAK_MIN_MISSES > RECONCILE_MIN_MISSES);
  assert.ok(RECONCILE_WEAK_SPAN_MS > RECONCILE_MISS_SPAN_MS);

  const agentId = 'agent-weak-schedule';
  const buyer = 'buyerWeakSched@';
  const { kp } = await creditZeroConf(agentId, buyer);
  const weak404 = mockClient(kp, buyer, () => {
    const e = new Error('HTTP 404'); e.statusCode = 404; throw e;
  });

  // A run that would be more than enough on the STRONG schedule.
  let t = Date.now() + RECONCILE_GRACE_MS + 1;
  for (let i = 0; i < RECONCILE_MIN_MISSES + 1; i++) {
    await reconcileUnconfirmedDeposits(agentId, weak404, t);
    t += RECONCILE_MISS_SPAN_MS;
  }
  assert.equal(getBalance(agentId, buyer), SMALL,
    'weak evidence must not reverse on the strong schedule');
});

test('a reversal the chain later contradicts is RESTORED automatically', async () => {
  // Reversal moves the record out of `processed` into `reversed`, and nothing used
  // to read `reversed` again. So the one case where our judgement is wrong — a
  // route fault mistaken for a dropped tx — was also the one case a buyer could
  // never recover from without an operator noticing. Reproduced in review.
  const agentId = 'agent-restore';
  const buyer = 'buyerRestore@';
  const { kp } = await creditZeroConf(agentId, buyer);

  // Drive a real reversal via an isolated strong signal.
  const gone = mockClient(kp, buyer, NOT_FOUND);
  await fullMissRun(agentId, gone, Date.now() + RECONCILE_GRACE_MS + 1);
  assert.equal(getBalance(agentId, buyer), 0, 'reversed');
  assert.equal(readDeposits(agentId).reversed.length, 1);

  // The tx was on-chain all along; the route was broken.
  const back = mockClient(kp, buyer, async () => ({ confirmations: 7 }));
  const r = await reconcileUnconfirmedDeposits(agentId, back, Date.now() + RECONCILE_GRACE_MS + 2);

  assert.equal(r.restored, 1);
  assert.equal(getBalance(agentId, buyer), SMALL, 'the credit comes back');
  assert.ok(readDeposits(agentId).reversed[0].restoredAt, 'and the restoration is recorded');
});

test('a restoration happens once, not on every subsequent pass', async () => {
  const agentId = 'agent-restore-once';
  const buyer = 'buyerRestoreOnce@';
  const { kp } = await creditZeroConf(agentId, buyer);
  await fullMissRun(agentId, mockClient(kp, buyer, NOT_FOUND), Date.now() + RECONCILE_GRACE_MS + 1);

  const back = mockClient(kp, buyer, async () => ({ confirmations: 7 }));
  const base = Date.now() + RECONCILE_GRACE_MS + 2;
  for (let i = 0; i < 4; i++) await reconcileUnconfirmedDeposits(agentId, back, base + i * 60_000);

  assert.equal(getBalance(agentId, buyer), SMALL, 'exactly one restoration, not four');
});

test('a still-missing transaction does NOT get its reversal undone', async () => {
  const agentId = 'agent-restore-nope';
  const buyer = 'buyerRestoreNope@';
  const { kp } = await creditZeroConf(agentId, buyer);
  await fullMissRun(agentId, mockClient(kp, buyer, NOT_FOUND), Date.now() + RECONCILE_GRACE_MS + 1);

  // Still unknown, and separately: unreachable.
  await reconcileUnconfirmedDeposits(agentId, mockClient(kp, buyer, NOT_FOUND), Date.now() + RECONCILE_GRACE_MS + 2);
  await reconcileUnconfirmedDeposits(agentId, mockClient(kp, buyer, async () => { throw new Error('ECONNREFUSED'); }),
    Date.now() + RECONCILE_GRACE_MS + 3);
  assert.equal(getBalance(agentId, buyer), 0, 'only a positive confirmation may restore');
});

test('restoration is bounded — an ancient reversal is not re-checked forever', async () => {
  const agentId = 'agent-restore-old';
  const buyer = 'buyerRestoreOld@';
  const { kp } = await creditZeroConf(agentId, buyer);
  await fullMissRun(agentId, mockClient(kp, buyer, NOT_FOUND), Date.now() + RECONCILE_GRACE_MS + 1);

  // Age the reversal past the window.
  const d = readDeposits(agentId);
  d.reversed[0].reversedAt = new Date(Date.now() - REVERSAL_RECHECK_WINDOW_MS - 60_000).toISOString();
  fs.writeFileSync(depositsFile(agentId), JSON.stringify(d));

  const back = mockClient(kp, buyer, async () => ({ confirmations: 7 }));
  const r = await reconcileUnconfirmedDeposits(agentId, back, Date.now());
  assert.equal(r.restored, 0, 'outside the window it is an operator matter, not an automatic one');
  assert.equal(getBalance(agentId, buyer), 0);
});

test('restoration also runs on the busy path, not just when nothing is open', async () => {
  // Two call sites reach the recheck: the early return when nothing is open, and
  // the end of a normal pass. Every restoration test above happened to exercise
  // only the first, so deleting the second changed nothing — a mutant survived.
  const agentId = 'agent-restore-busy';
  const reversedBuyer = 'buyerRestoreBusy@';
  const openBuyer = 'buyerStillOpen@';

  const rv = await creditZeroConf(agentId, reversedBuyer);
  await fullMissRun(agentId, mockClient(rv.kp, reversedBuyer, NOT_FOUND), Date.now() + RECONCILE_GRACE_MS + 1);
  assert.equal(getBalance(agentId, reversedBuyer), 0);

  // Now there IS an open record, so the pass does not take the early return.
  const op = await creditZeroConf(agentId, openBuyer);
  const mixed = mockClient(op.kp, openBuyer, async (txid) => {
    if (txid === rv.txid) return { confirmations: 9 };  // the reversal was wrong
    return { confirmations: 0 };                         // the open one is in the mempool
  });

  const r = await reconcileUnconfirmedDeposits(agentId, mixed, Date.now() + RECONCILE_GRACE_MS + 2);
  assert.equal(r.restored, 1, 'the busy path must recheck reversals too');
  assert.equal(getBalance(agentId, reversedBuyer), SMALL);
  assert.equal(getBalance(agentId, openBuyer), SMALL, 'the open credit is untouched');
});

test('a reversed tx merely BACK in the mempool is not restored', async () => {
  // 0-conf is what got it credited in the first place, and being unknown for two
  // hours is what took it away. Reappearing unconfirmed is not stronger evidence
  // than either — it would just start the whole cycle again. Only a block counts.
  const agentId = 'agent-restore-mempool';
  const buyer = 'buyerRestoreMempool@';
  const { kp } = await creditZeroConf(agentId, buyer);
  await fullMissRun(agentId, mockClient(kp, buyer, NOT_FOUND), Date.now() + RECONCILE_GRACE_MS + 1);
  assert.equal(getBalance(agentId, buyer), 0);

  const backInMempool = mockClient(kp, buyer, async () => ({ confirmations: 0 }));
  const r = await reconcileUnconfirmedDeposits(agentId, backInMempool, Date.now() + RECONCILE_GRACE_MS + 2);
  assert.equal(r.restored, 0);
  assert.equal(getBalance(agentId, buyer), 0, 'restoration requires a confirmation, not a sighting');
});
