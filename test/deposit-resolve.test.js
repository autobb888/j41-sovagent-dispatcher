'use strict';
/**
 * M4 chunk 4 — the operator's two verbs.
 *
 * `needsOperator` means "a buyer's balance may be wrong and only a human can say
 * which way". Both verbs close such an entry: `credit` decides the buyer is owed
 * the amount and applies it; `dismiss` decides nothing is owed and records why.
 *
 * `credit` moves real money, so it re-verifies the transaction on-chain and
 * fails closed on any doubt. It also has to put the txid back into the dedup
 * ledger: a reversal deliberately takes it OUT so a buyer whose payment did
 * confirm can re-report it, and once we have credited by hand a re-report must
 * not credit it again. That coupling is the whole reason this is not a
 * three-line flag edit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-depresolve-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const {
  creditDepositAnomaly, dismissDepositAnomaly, reconcileMeterAgainstLedger,
  listDepositAnomaliesForAgent, _settleReversedForTxid,
} = require('../src/deposit-watcher.js');
const { creditDeposit, getBalance, getMeter } = require('../src/credit-meter.js');

function writeDeposits(agentId, data) {
  const p = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function readDeposits(agentId) {
  return JSON.parse(fs.readFileSync(path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json'), 'utf8'));
}

const client = (confirmations) => ({
  async getTxStatus() {
    if (confirmations instanceof Error) throw confirmations;
    return { confirmations };
  },
});

let seq = 0;
function seedReversedAnomaly({ amount = 1.5, buyer = 'buyer@' } = {}) {
  const agentId = `agent-res-${++seq}`;
  const txid = `tx_res_${seq}`;
  writeDeposits(agentId, {
    processed: [], pending: [], creditedTxids: [],
    reversed: [{
      txid, buyerVerusId: buyer, amount,
      reversedAt: new Date().toISOString(), debited: false,
      needsOperator: 'reversed without a certain debit, and the tx later confirmed',
    }],
  });
  return { agentId, txid, buyer, amount };
}

// ── credit ──────────────────────────────────────────────────────────────────

test('credit refuses when the transaction is not confirmed', async () => {
  const { agentId, txid, buyer } = seedReversedAnomaly();
  const res = await creditDepositAnomaly(agentId, txid, { client: client(0) });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOT_CONFIRMED');
  assert.equal(getBalance(agentId, buyer), 0, 'no money may move on an unconfirmed tx');
  assert.equal(listDepositAnomaliesForAgent(agentId).needsOperator.length, 1, 'and the entry stays open');
});

test('credit refuses when the transaction cannot be checked at all', async () => {
  const { agentId, txid, buyer } = seedReversedAnomaly();
  const res = await creditDepositAnomaly(agentId, txid, { client: client(new Error('platform unreachable')) });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'VERIFY_FAILED');
  assert.equal(getBalance(agentId, buyer), 0, 'an unreachable platform is not permission to move money');
});

test('credit applies the amount, closes the entry, and blocks a later re-report', async () => {
  const { agentId, txid, buyer, amount } = seedReversedAnomaly();
  const res = await creditDepositAnomaly(agentId, txid, { client: client(3) });
  assert.equal(res.ok, true);
  assert.equal(getBalance(agentId, buyer), amount);

  const d = readDeposits(agentId);
  const entry = d.reversed.find((r) => r.txid === txid);
  assert.equal(entry.needsOperator, undefined, 'the flag is cleared');
  assert.ok(entry.resolvedAt && entry.resolution, 'and an audit stamp replaces it');
  assert.ok(d.processed.some((r) => r.txid === txid),
    'the txid must return to `processed` or a re-report credits it a second time');
  assert.ok(d.creditedTxids.includes(txid), 'and to the dedup ledger');
  assert.equal(listDepositAnomaliesForAgent(agentId).needsOperator.length, 0);
});

test('credit is not repeatable', async () => {
  const { agentId, txid, buyer, amount } = seedReversedAnomaly();
  await creditDepositAnomaly(agentId, txid, { client: client(3) });
  const again = await creditDepositAnomaly(agentId, txid, { client: client(3) });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NOT_FOUND');
  assert.equal(getBalance(agentId, buyer), amount, 'the balance moved exactly once');
});

test('credit resolves an anomaly living on a processed record too', async () => {
  const agentId = 'agent-res-processed';
  const txid = 'tx_res_p';
  writeDeposits(agentId, {
    processed: [{
      txid, buyerVerusId: 'bp@', amount: 2, confirmations: 3,
      needsOperator: "reversal state 'debiting' when the tx confirmed",
    }],
    pending: [], reversed: [], creditedTxids: [txid],
  });
  const res = await creditDepositAnomaly(agentId, txid, { client: client(4) });
  assert.equal(res.ok, true);
  assert.equal(getBalance(agentId, 'bp@'), 2);
  const rec = readDeposits(agentId).processed.find((r) => r.txid === txid);
  assert.equal(rec.needsOperator, undefined);
  assert.ok(rec.resolvedAt);
});

// ── dismiss ─────────────────────────────────────────────────────────────────

test('dismiss requires a reason and moves no money', async () => {
  const { agentId, txid, buyer } = seedReversedAnomaly();
  const bad = await dismissDepositAnomaly(agentId, txid, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'REASON_REQUIRED');

  const res = await dismissDepositAnomaly(agentId, txid, { reason: 'buyer was never charged' });
  assert.equal(res.ok, true);
  assert.equal(getBalance(agentId, buyer), 0, 'dismissal is a bookkeeping decision, not a payment');
  const entry = readDeposits(agentId).reversed.find((r) => r.txid === txid);
  assert.equal(entry.needsOperator, undefined);
  assert.match(entry.resolution, /buyer was never charged/);
  assert.equal(listDepositAnomaliesForAgent(agentId).needsOperator.length, 0);
});

test('dismiss does not put the txid back in the dedup ledger', async () => {
  // Nothing was credited, so a buyer who CAN prove the payment must still be
  // able to re-report it through the normal path.
  const { agentId, txid } = seedReversedAnomaly();
  await dismissDepositAnomaly(agentId, txid, { reason: 'no debit ever ran' });
  assert.ok(!readDeposits(agentId).creditedTxids.includes(txid));
});

// ── the auto-settle path must not leave a stale flag ────────────────────────

test('settling a reversal automatically also clears its operator flag', async () => {
  // Otherwise `deposits list` keeps printing a settled entry as actionable, with
  // the resolution command next to it, and an operator following the tool's own
  // instruction credits a buyer who has already been made whole.
  const d = {
    processed: [], pending: [], creditedTxids: [],
    reversed: [{
      txid: 'tx_settle', buyerVerusId: 'bs@', amount: 1,
      reversedAt: new Date().toISOString(), debited: false,
      needsOperator: 'reversed without a certain debit',
    }],
  };
  _settleReversedForTxid(d, 'tx_settle', 'credited afresh');
  assert.equal(d.reversed[0].needsOperator, undefined, 'a settled entry is not actionable');
  assert.ok(d.reversed[0].resolvedAt);
  assert.ok(d.reversed[0].restoredAt);
});

// ── the arithmetic that makes the decision decidable ────────────────────────

test('meter-vs-ledger reconciliation says which way the balance is wrong', async () => {
  // The flags say "check the meter against the chain". The chain half is easy;
  // the meter half is not, because the meter keeps no journal and its balance
  // moves with every proxied request. totalDeposited is the one figure only
  // deposits and reversals touch.
  const agentId = 'agent-recon';
  writeDeposits(agentId, {
    processed: [
      { txid: 't1', buyerVerusId: 'br@', amount: 5, confirmations: 6, creditedAt: new Date().toISOString() },
      { txid: 't2', buyerVerusId: 'br@', amount: 3, confirmations: 6, creditedAt: new Date().toISOString() },
    ],
    pending: [],
    reversed: [{ txid: 't2', buyerVerusId: 'br@', amount: 3, reversedAt: new Date().toISOString(), debited: true }],
    creditedTxids: ['t1', 't2'],
  });
  creditDeposit(agentId, 'br@', 8, 't1'); // meter thinks 8 deposited; ledger says 5 net

  const m = reconcileMeterAgainstLedger(agentId, 'br@');
  assert.equal(m.expectedTotalDeposited, 5, '5 credited + 3 credited − 3 debited');
  assert.equal(m.actualTotalDeposited, 8);
  assert.equal(m.delta, 3, 'the meter is 3 VRSC ahead — the reversal debit never ran');
  assert.ok(getMeter(agentId, 'br@'));
});

test('reconciliation reports a missing meter rather than inventing a zero', async () => {
  const agentId = 'agent-recon-none';
  writeDeposits(agentId, { processed: [], pending: [], reversed: [], creditedTxids: [] });
  const m = reconcileMeterAgainstLedger(agentId, 'nobody@');
  assert.equal(m.actualTotalDeposited, null, '"never looked" and "looked and it is zero" prescribe opposite actions');
  assert.equal(m.delta, null);
});

// ── the state a crash leaves, and whether anyone can see or settle it ───────

test('a record stuck mid-credit becomes an operator question, and is resolvable', async () => {
  // chunk 1 creates this state on a crash and described it as reading "a human
  // must check". Nothing read it: it was counted only among open 0-conf credits
  // (which deliberately do not degrade health), never listed as needing an
  // operator, and both verbs returned NOT_FOUND for it. It is also the ONE state
  // not bounded by the 2 VRSC tier — this is the 6-confirmation >10 VRSC path.
  const { STUCK_CREDITING_MS } = require('../src/deposit-watcher.js');
  const agentId = 'agent-stuck';
  const txid = 'tx_stuck_big';
  writeDeposits(agentId, {
    processed: [{
      txid, buyerVerusId: 'whale@', amount: 25, confirmations: 6,
      crediting: true, intentAt: new Date(Date.now() - STUCK_CREDITING_MS - 60_000).toISOString(),
    }],
    pending: [], reversed: [], creditedTxids: [txid],
  });

  const listed = listDepositAnomaliesForAgent(agentId).needsOperator;
  assert.equal(listed.length, 1, 'a 25 VRSC deposit stuck mid-credit must be visible to a human');
  assert.match(listed[0].reason, /never finalized/);

  const res = await creditDepositAnomaly(agentId, txid, { client: client(6) });
  assert.equal(res.ok, true, 'and settleable — otherwise the fix is hand-editing JSON');
  assert.equal(getBalance(agentId, 'whale@'), 25);
  assert.equal(listDepositAnomaliesForAgent(agentId).needsOperator.length, 0);
});

test('a credit intent still in flight is NOT reported as stuck', async () => {
  const agentId = 'agent-inflight';
  writeDeposits(agentId, {
    processed: [{
      txid: 'tx_inflight', buyerVerusId: 'b@', amount: 1,
      crediting: true, intentAt: new Date().toISOString(),
    }],
    pending: [], reversed: [], creditedTxids: ['tx_inflight'],
  });
  assert.equal(listDepositAnomaliesForAgent(agentId).needsOperator.length, 0,
    'a slow credit must not be mistaken for a crashed one');
});

test('an interrupted operator credit refuses to run again blind', async () => {
  // The verb a human retries is the one that most needs an intent protocol: a
  // crash between the meter write and the record write leaves the anomaly open
  // and un-deduped, and the natural response to a command that died is to run
  // it again.
  const { agentId, txid, buyer, amount } = seedReversedAnomaly();
  const realRename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (String(to).endsWith('credit-meters.json')) throw new Error('EIO: killed mid-credit');
    return realRename(from, to, ...rest);
  };
  try {
    await creditDepositAnomaly(agentId, txid, { client: client(3) }).catch(() => {});
  } finally {
    fs.renameSync = realRename;
  }

  const retry = await creditDepositAnomaly(agentId, txid, { client: client(3) });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'RESOLVE_INTERRUPTED',
    `a blind retry is how one credit becomes two; got ${JSON.stringify(retry)}`);
  assert.match(retry.message, /totalDeposited/, 'and it must say how to decide');
  assert.equal(getBalance(agentId, buyer), 0, `nothing landed; amount was ${amount}`);
});
