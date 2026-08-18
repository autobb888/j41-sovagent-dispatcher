/**
 * scripts/pay-jobs.js — the payment backfill script, no longer a bypass (P4, C2).
 *
 * Tests the pure planner: BigInt amounts (never parseFloat), NO invented fee, and
 * unit-level counterparty authorization against the authoritative recipient set.
 */
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planPayJob } = require('../scripts/pay-jobs.js');

test('no stated fee → a single agent output (never a computed 5%)', () => {
  const p = planPayJob({ amount: '10', payment: { address: 'iAGENT' } }, { platformFeeAddress: 'iFEE' });
  assert.equal(p.gate.allowed, true);
  assert.equal(p.outputs.length, 1);
  assert.equal(p.outputs[0].address, 'iAGENT');
  assert.equal(typeof p.outputs[0].amountSats, 'number'); // parseVrscAmount caps at 2^50, exact as Number
  assert.equal(p.outputs[0].amountSats, 1000000000); // 10 VRSC
});

test('stated fee → agent + fee outputs, exact BigInt sats', () => {
  const p = planPayJob({ amount: '10', payment: { address: 'iAGENT', feeAmount: '0.5' } }, { platformFeeAddress: 'iFEE' });
  assert.equal(p.gate.allowed, true);
  assert.equal(p.outputs.length, 2);
  assert.equal(p.outputs[1].address, 'iFEE');
  assert.equal(p.outputs[1].amountSats, 50000000); // 0.5 VRSC
});

test('a fee is stated but no fee address configured → denied (never send an orphan fee)', () => {
  const p = planPayJob({ amount: '10', payment: { address: 'iAGENT', feeAmount: '0.5' } }, { platformFeeAddress: null });
  assert.equal(p.gate.allowed, false);
});

test('destination not in expectedRecipients → whole tx denied (no laundering)', () => {
  const p = planPayJob({ amount: '10', payment: { address: 'iHIJACK' } }, { platformFeeAddress: 'iFEE', expected: ['iAGENT', 'iFEE'] });
  assert.equal(p.gate.allowed, false);
});

test('a non-decimal amount is rejected, not floated', () => {
  const p = planPayJob({ amount: '10.000000001', payment: { address: 'iAGENT' } }, { platformFeeAddress: 'iFEE' });
  assert.equal(p.gate.allowed, false); // >8 decimals: parseVrscAmount refuses
});

test('missing payment address → denied', () => {
  const p = planPayJob({ amount: '10', payment: {} }, { platformFeeAddress: 'iFEE' });
  assert.equal(p.gate.allowed, false);
});
