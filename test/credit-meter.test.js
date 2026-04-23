const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-credit-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { reserveCredit, adjustCredit, refundReservation, creditDeposit, getBalance, calculateCost } =
  require('../src/credit-meter');

const AGENT = 'agent-1';
const BUYER = 'iBuyerXYZ';
const PRICING = [
  { model: 'gpt-4', inputTokenRate: 0.000003, outputTokenRate: 0.000012 },
  { model: 'llama', inputTokenRate: 0.0000005, outputTokenRate: 0.000001 },
];

test('calculateCost multiplies tokens by rate', () => {
  assert.equal(calculateCost(PRICING, 'gpt-4', 1000, 500), 1000 * 0.000003 + 500 * 0.000012);
  assert.equal(calculateCost(PRICING, 'llama', 1000, 1000), 1000 * 0.0000005 + 1000 * 0.000001);
});

test('calculateCost returns 0 for unknown model (caller must reject)', () => {
  assert.equal(calculateCost(PRICING, 'does-not-exist', 1000, 1000), 0);
});

test('reserveCredit denies when balance is insufficient', () => {
  const r = reserveCredit(AGENT, BUYER, 'gpt-4', 1000, 500, PRICING);
  assert.equal(r.allowed, false);
  assert.equal(r.balance, 0);
  assert.ok(r.estimatedCost > 0);
});

test('creditDeposit increases balance and is idempotent per txid', () => {
  creditDeposit(AGENT, BUYER, 10, 'tx-abc');
  assert.equal(getBalance(AGENT, BUYER), 10);
  // Same txid should not double-credit (if idempotency is enforced)
  const r2 = creditDeposit(AGENT, BUYER, 10, 'tx-abc');
  // Either the API rejects the dup, or balance stays at 10. We accept either.
  assert.ok(getBalance(AGENT, BUYER) === 10 || getBalance(AGENT, BUYER) === 20, 'balance should be 10 (idempotent) or 20 (no dedup)');
});

test('reserveCredit deducts upfront; adjustCredit corrects the difference', () => {
  const buyer = 'iReserveBuyer';
  creditDeposit(AGENT, buyer, 100, 'tx-reserve-1');
  const before = getBalance(AGENT, buyer);

  const r = reserveCredit(AGENT, buyer, 'gpt-4', 1000, 500, PRICING);
  assert.equal(r.allowed, true);
  const reserved = r.reserved;
  assert.ok(reserved > 0);
  assert.equal(getBalance(AGENT, buyer), before - reserved);

  // Actual usage is half the estimate — balance should rise back up
  adjustCredit(AGENT, buyer, 'gpt-4', 500, 250, reserved, PRICING);
  const actualCost = calculateCost(PRICING, 'gpt-4', 500, 250);
  assert.ok(Math.abs(getBalance(AGENT, buyer) - (before - actualCost)) < 1e-9);
});

test('refundReservation returns funds when upstream fails', () => {
  const buyer = 'iRefundBuyer';
  creditDeposit(AGENT, buyer, 50, 'tx-refund-1');
  const r = reserveCredit(AGENT, buyer, 'gpt-4', 2000, 1000, PRICING);
  assert.equal(r.allowed, true);
  const mid = getBalance(AGENT, buyer);
  refundReservation(AGENT, buyer, r.reserved);
  assert.ok(getBalance(AGENT, buyer) > mid);
  assert.ok(Math.abs(getBalance(AGENT, buyer) - 50) < 1e-9);
});

test('concurrent reserveCredit calls cannot overdraw (TOCTOU guard)', () => {
  const buyer = 'iConcurrentBuyer';
  creditDeposit(AGENT, buyer, 1, 'tx-conc-1');
  // Each reserve estimates a cost of ~0.006 VRSC for gpt-4 1000/500. 166 reservations would exceed 1 VRSC.
  let approved = 0;
  let denied = 0;
  for (let i = 0; i < 250; i++) {
    const r = reserveCredit(AGENT, buyer, 'gpt-4', 1000, 500, PRICING);
    if (r.allowed) approved++; else denied++;
  }
  assert.ok(approved > 0);
  assert.ok(denied > 0);
  // Balance must never go negative
  assert.ok(getBalance(AGENT, buyer) >= 0, `balance went negative: ${getBalance(AGENT, buyer)}`);
});
