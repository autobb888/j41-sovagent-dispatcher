'use strict';
/**
 * Seller deposit sender match: buyer spends from primary R, claim is VerusID
 * (i-address). Platform verifyPayment may return sender_mismatch /
 * senderVerified:false; dispatcher must accept vin ∈ primaryAddresses ∪ {i-address}.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dep-sender-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
delete process.env.J41_DEPOSIT_ALLOW_AUTH_ONLY;

const { generateKeypair, signMessage, buildDepositReportMessage } = require('@junction41/sovagent-sdk/dist/index.js');
const {
  reportDeposit,
  senderMatchesBuyer,
} = require('../src/deposit-watcher.js');
const { getBalance } = require('../src/credit-meter.js');

const NET = 'verustest';
const BUYER_I = 'iDdjzshBuyerIdentity00000000000000';
const PRIMARY_R = 'REbuyerPrimary0000000000000000001';
const STRANGER_R = 'Rstranger000000000000000000000001';
const PAY_ADDR = 'iSellerPayAddress0000000000000000';

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

function baseClient(kp, buyerVerusId, { verifyPayment, confirmations = 10 } = {}) {
  return {
    async getIdentityKeys(id) {
      assert.equal(id, buyerVerusId);
      return {
        iaddress: BUYER_I,
        name: id,
        primaryAddresses: [kp.address, PRIMARY_R],
        minimumSignatures: 1,
      };
    },
    verifyPayment,
    async getTxStatus() {
      return { confirmations };
    },
  };
}

test('senderMatchesBuyer accepts primary R and buyer i-address', () => {
  const keys = { primaryAddresses: [PRIMARY_R], iaddress: BUYER_I };
  assert.equal(senderMatchesBuyer({ vinAddress: PRIMARY_R, buyerVerusId: 'buyer@', keys }), true);
  assert.equal(senderMatchesBuyer({ vinAddress: BUYER_I, buyerVerusId: 'buyer@', keys }), true);
  assert.equal(senderMatchesBuyer({ vinAddress: STRANGER_R, buyerVerusId: 'buyer@', keys }), false);
  assert.equal(senderMatchesBuyer({ vinAddress: PRIMARY_R.toLowerCase(), buyerVerusId: 'buyer@', keys }), false);
});

test('primary R of claiming VerusID is not SENDER_MISMATCH', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'j41grokbuyer.agentplatform@';
  const sellerVerusId = 'seller@';
  const agentId = 'agent-sender-primary-r';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 0.05;

  let verifyCalls = 0;
  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment(params) {
      verifyCalls += 1;
      assert.equal(params.expectedSender, buyerVerusId);
      assert.equal(params.expectedAddress, PAY_ADDR);
      assert.equal(params.expectedAmount, amount);
      // Live Mac shape: amount/address ok; platform treats vin R ≠ claim i-address.
      return {
        verified: false,
        reason: 'sender_mismatch',
        senderVerified: false,
        senderAddress: PRIMARY_R,
        confirmedAmount: amount,
        actualAmount: amount,
      };
    },
  });

  const report = signedReport(kp, buyerVerusId, sellerVerusId, txid, amount);
  const res = await reportDeposit(agentId, client, report, PAY_ADDR, NET);

  assert.notEqual(res.code, 'SENDER_MISMATCH', `must not be SENDER_MISMATCH: ${JSON.stringify(res)}`);
  assert.equal(res.credited, true, `expected credited:true, got ${JSON.stringify(res)}`);
  assert.equal(getBalance(agentId, buyerVerusId), amount);
  assert.equal(verifyCalls, 1);
});

test('unrelated R stays SENDER_MISMATCH', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-stranger-vin@';
  const sellerVerusId = 'seller@';
  const agentId = 'agent-sender-stranger-r';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 1;

  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment() {
      return {
        verified: false,
        reason: 'sender_mismatch',
        senderVerified: false,
        senderAddress: STRANGER_R,
        confirmedAmount: amount,
        actualAmount: amount,
      };
    },
  });

  const report = signedReport(kp, buyerVerusId, sellerVerusId, txid, amount);
  const res = await reportDeposit(agentId, client, report, PAY_ADDR, NET);

  assert.equal(res.credited, false);
  assert.equal(res.code, 'SENDER_MISMATCH');
  assert.equal(getBalance(agentId, buyerVerusId), 0);
});

test('senderVerified false with primary R vin credits (verified true path)', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-sv-false@';
  const agentId = 'agent-sender-sv-false';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 1;

  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment() {
      return {
        verified: true,
        reason: null,
        senderVerified: false,
        senderAddress: PRIMARY_R,
        confirmedAmount: amount,
        actualAmount: amount,
      };
    },
  });

  const res = await reportDeposit(
    agentId, client,
    signedReport(kp, buyerVerusId, 'seller@', txid, amount),
    PAY_ADDR, NET,
  );
  assert.equal(res.credited, true, JSON.stringify(res));
  assert.notEqual(res.code, 'SENDER_MISMATCH');
});

test('amount failure is not rescued by primary R match', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-amount-fail@';
  const agentId = 'agent-sender-amount-fail';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 5;

  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment() {
      return {
        verified: false,
        reason: 'amount_too_low',
        senderAddress: PRIMARY_R,
        confirmedAmount: 1,
        actualAmount: 1,
      };
    },
  });

  const res = await reportDeposit(
    agentId, client,
    signedReport(kp, buyerVerusId, 'seller@', txid, amount),
    PAY_ADDR, NET,
  );
  assert.equal(res.credited, false);
  assert.notEqual(res.code, 'SENDER_MISMATCH');
  assert.match(res.message || '', /amount_too_low/);
  assert.equal(getBalance(agentId, buyerVerusId), 0);
});

test('no-vin retry amount_too_low is not SENDER_MISMATCH', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'buyer-novin-amount@';
  const agentId = 'agent-sender-novin-amount';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 5;
  const expectedSenders = [];

  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment(params) {
      expectedSenders.push(params.expectedSender);
      if (params.expectedSender === buyerVerusId) {
        // First pass: sender_mismatch, no vin field → triggers primary-R retry.
        return {
          verified: false,
          reason: 'sender_mismatch',
          senderVerified: false,
          confirmedAmount: 1,
          actualAmount: 1,
        };
      }
      // Retry with first primary R: amount fails — must surface that, not SENDER_MISMATCH.
      assert.equal(params.expectedSender, kp.address);
      return {
        verified: false,
        reason: 'amount_too_low',
        confirmedAmount: 1,
        actualAmount: 1,
      };
    },
  });

  const res = await reportDeposit(
    agentId, client,
    signedReport(kp, buyerVerusId, 'seller@', txid, amount),
    PAY_ADDR, NET,
  );
  assert.equal(res.credited, false);
  assert.notEqual(res.code, 'SENDER_MISMATCH', JSON.stringify(res));
  assert.match(res.message || '', /amount_too_low/);
  assert.deepEqual(expectedSenders, [buyerVerusId, kp.address]);
  assert.equal(getBalance(agentId, buyerVerusId), 0);
});

test('verified true + senderVerified true + disagreeing senderVerusId still credits primary R vin (live Mac)', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'j41grokbuyer.agentplatform@';
  const agentId = 'agent-sender-live-mac';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 0.05;

  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment() {
      return {
        verified: true,
        senderVerified: true,
        senderVerusId: 'not-the-buyer.agentplatform@',
        senderAddress: PRIMARY_R,
        confirmedAmount: amount,
        actualAmount: amount,
      };
    },
  });

  const res = await reportDeposit(
    agentId, client,
    signedReport(kp, buyerVerusId, 'duskseek.agentplatform@', txid, amount),
    PAY_ADDR, NET,
  );
  assert.equal(res.credited, true, JSON.stringify(res));
  assert.notEqual(res.code, 'SENDER_MISMATCH');
  assert.equal(getBalance(agentId, buyerVerusId), amount);
});

test('verified true + senderVerified true + stranger vin stays SENDER_MISMATCH', async () => {
  const kp = generateKeypair(NET);
  const buyerVerusId = 'j41grokbuyer.agentplatform@';
  const agentId = 'agent-sender-live-stranger';
  const txid = 'tx_' + crypto.randomBytes(8).toString('hex');
  const amount = 0.05;

  const client = baseClient(kp, buyerVerusId, {
    async verifyPayment() {
      return {
        verified: true,
        senderVerified: true,
        senderVerusId: 'not-the-buyer.agentplatform@',
        senderAddress: STRANGER_R,
        confirmedAmount: amount,
        actualAmount: amount,
      };
    },
  });

  const res = await reportDeposit(
    agentId, client,
    signedReport(kp, buyerVerusId, 'duskseek.agentplatform@', txid, amount),
    PAY_ADDR, NET,
  );
  assert.equal(res.credited, false);
  assert.equal(res.code, 'SENDER_MISMATCH');
  assert.match(res.message || '', /does not match the claiming buyer/);
  assert.equal(getBalance(agentId, buyerVerusId), 0);
});
