'use strict';
/**
 * Deposit double-credit TOCTOU (audit M4).
 *
 * The per-report nonce only dedups IDENTICAL reports. Two differently-nonced
 * reports for the SAME txid can race: both load deposits, both pass the
 * `processed.some(d => d.txid === txid)` check, both await verifyPayment /
 * getTxStatus, and both creditDeposit → the deposit is credited TWICE.
 *
 * Fix: txid is the idempotency key, claimed atomically BEFORE the awaits, so
 * two concurrent same-txid reports credit exactly ONCE. A report racing the
 * poller for the same txid must also not double-credit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Sandbox HOME BEFORE requiring app modules so meter/deposit files land in /tmp.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dep-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
// Disable the legacy auth-only opt-in path so behaviour is deterministic; our
// mock client returns explicit sender verification anyway.
delete process.env.J41_DEPOSIT_ALLOW_AUTH_ONLY;

const { generateKeypair, signMessage, buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const { reportDeposit, pollPendingDeposits } = require('../src/deposit-watcher.js');
const { getBalance } = require('../src/credit-meter.js');

const NET = 'verustest';

// Mock client that:
//  - resolves the buyer identity to its address (for signature auth),
//  - confirms payment + sender, with an awaited microtask delay to force the race,
//  - returns a confirmations count high enough to credit immediately.
function raceClient(buyerKp, buyerVerusId, { delayMs = 5, confirmations = 10 } = {}) {
  return {
    async getIdentityKeys(id) {
      return { iaddress: 'i' + id, name: id, primaryAddresses: [buyerKp.address], minimumSignatures: 1 };
    },
    async verifyPayment() {
      await new Promise((r) => setTimeout(r, delayMs));
      return { verified: true, senderVerified: true, senderVerusId: buyerVerusId };
    },
    async getTxStatus() {
      await new Promise((r) => setTimeout(r, delayMs));
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

test('two differently-nonced reports for the same txid credit ONCE', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer@';
  const sellerVerusId = 'seller@';
  const agentId = 'agent-m4-race';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 5;
  const client = raceClient(kp, buyerVerusId);

  // Two distinct reports (distinct nonces) for the SAME txid, fired concurrently.
  const r1 = signedReport(kp, buyerVerusId, sellerVerusId, txid, amount);
  const r2 = signedReport(kp, buyerVerusId, sellerVerusId, txid, amount);

  const [res1, res2] = await Promise.all([
    reportDeposit(agentId, client, r1, 'RpayAddr', NET),
    reportDeposit(agentId, client, r2, 'RpayAddr', NET),
  ]);

  // Exactly one should report credited:true; the other must be a no-op.
  const creditedCount = [res1, res2].filter((r) => r.credited).length;
  assert.equal(creditedCount, 1, `exactly one report should credit; got ${creditedCount} (${JSON.stringify([res1, res2])})`);

  // Balance must reflect a SINGLE credit, not double.
  assert.equal(getBalance(agentId, buyerVerusId), amount,
    `balance must be a single credit (${amount}); got ${getBalance(agentId, buyerVerusId)}`);
});

test('a report racing the poller for the same txid does not double-credit', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer2@';
  const sellerVerusId = 'seller@';
  const agentId = 'agent-m4-poll-race';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 3;

  // First: report it while it's still UNconfirmed so it lands in `pending`.
  const unconfirmedClient = raceClient(kp, buyerVerusId, { confirmations: 0 });
  const r = signedReport(kp, buyerVerusId, sellerVerusId, txid, amount);
  const pendRes = await reportDeposit(agentId, unconfirmedClient, r, 'RpayAddr', NET);
  assert.equal(pendRes.credited, false); // pending, not yet credited

  // Now the tx confirms. The poller AND a fresh report both see it confirmed and
  // race to credit. Use a client that now returns enough confirmations.
  const confirmedClient = raceClient(kp, buyerVerusId, { confirmations: 10 });
  const r2 = signedReport(kp, buyerVerusId, sellerVerusId, txid, amount);

  await Promise.all([
    pollPendingDeposits(agentId, confirmedClient),
    reportDeposit(agentId, confirmedClient, r2, 'RpayAddr', NET),
  ]);

  assert.equal(getBalance(agentId, buyerVerusId), amount,
    `poller+report race must credit once (${amount}); got ${getBalance(agentId, buyerVerusId)}`);
});
