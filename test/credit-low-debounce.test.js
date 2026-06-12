// Unit tests for the edge-triggered, debounced credit-low detection in
// credit-meter.js (the dispatcher side of the sovcompute credit-low feature).
//
// Contract under test:
//   checkAndFlagLow(agentId, buyerVerusId, balance, threshold) →
//     returns true exactly ONCE per downward crossing (and stamps lowNotifiedAt),
//     false on every subsequent sub-threshold call until re-armed.
//   creditDeposit(...) clears lowNotifiedAt → the next crossing re-fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-credit-low-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { creditDeposit, checkAndFlagLow, getMeter } = require('../src/credit-meter');

const AGENT = 'agent-low';

test('checkAndFlagLow fires once on a downward crossing and sets the flag', () => {
  const buyer = 'iBuyerCross';
  creditDeposit(AGENT, buyer, 10, 'tx-low-1');

  // Above threshold → no fire, no flag.
  assert.equal(checkAndFlagLow(AGENT, buyer, 5.0, 1.0), false);
  assert.equal(getMeter(AGENT, buyer).lowNotifiedAt, undefined);

  // Balance crosses below threshold → fire once, flag stamped.
  assert.equal(checkAndFlagLow(AGENT, buyer, 0.83, 1.0), true);
  assert.ok(getMeter(AGENT, buyer).lowNotifiedAt, 'lowNotifiedAt should be set after the crossing');
});

test('checkAndFlagLow does NOT re-fire while already flagged (debounce)', () => {
  const buyer = 'iBuyerDebounce';
  creditDeposit(AGENT, buyer, 10, 'tx-low-2');

  assert.equal(checkAndFlagLow(AGENT, buyer, 0.5, 1.0), true);   // first crossing
  assert.equal(checkAndFlagLow(AGENT, buyer, 0.4, 1.0), false);  // still low → no re-fire
  assert.equal(checkAndFlagLow(AGENT, buyer, 0.2, 1.0), false);  // still low → no re-fire
});

test('creditDeposit clears lowNotifiedAt so the next crossing re-arms', () => {
  const buyer = 'iBuyerRearm';
  creditDeposit(AGENT, buyer, 10, 'tx-low-3a');

  assert.equal(checkAndFlagLow(AGENT, buyer, 0.5, 1.0), true);   // crossing → flagged
  assert.ok(getMeter(AGENT, buyer).lowNotifiedAt);

  // Top up — flag must clear.
  creditDeposit(AGENT, buyer, 10, 'tx-low-3b');
  assert.equal(getMeter(AGENT, buyer).lowNotifiedAt, undefined, 'creditDeposit must clear the low flag');

  // Next downward crossing re-fires.
  assert.equal(checkAndFlagLow(AGENT, buyer, 0.7, 1.0), true);
});

test('checkAndFlagLow uses strict less-than (balance == threshold is not low)', () => {
  const buyer = 'iBuyerEdge';
  creditDeposit(AGENT, buyer, 10, 'tx-low-4');
  assert.equal(checkAndFlagLow(AGENT, buyer, 1.0, 1.0), false, 'balance == threshold must not fire');
  assert.equal(getMeter(AGENT, buyer).lowNotifiedAt, undefined);
});

test('checkAndFlagLow returns false for a non-positive / non-finite threshold (feature off)', () => {
  const buyer = 'iBuyerNoThreshold';
  creditDeposit(AGENT, buyer, 10, 'tx-low-5');
  assert.equal(checkAndFlagLow(AGENT, buyer, 0.1, 0), false);
  assert.equal(checkAndFlagLow(AGENT, buyer, 0.1, NaN), false);
  assert.equal(getMeter(AGENT, buyer).lowNotifiedAt, undefined);
});
