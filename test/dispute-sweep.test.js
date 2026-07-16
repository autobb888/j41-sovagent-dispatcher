'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { selectRefundableDisputes, buildDisputeRefundEntry } = require('../src/dispute-sweep.js');

const disp = { id: 'd1', action: 'pending', raised_by: 'iBUY' };
const undelivered = { id: 'j1', status: 'disputed', delivery: null, tokenUsage: null, amount: 0.5, currency: 'VRSCTEST', buyerVerusId: 'iBUY' };

test('selects undelivered + pending + no-tokens', () => {
  const out = selectRefundableDisputes([undelivered], { j1: disp });
  assert.equal(out.length, 1);
});
test('excludes delivered jobs', () => {
  const out = selectRefundableDisputes([{ ...undelivered, delivery: { hash: 'abc' } }], { j1: disp });
  assert.equal(out.length, 0);
});
test('excludes jobs with token usage', () => {
  const out = selectRefundableDisputes([{ ...undelivered, tokenUsage: { total: 42 } }], { j1: disp });
  assert.equal(out.length, 0);
});
test('excludes non-pending disputes', () => {
  const out = selectRefundableDisputes([undelivered], { j1: { ...disp, action: 'refund' } });
  assert.equal(out.length, 0);
});
test('excludes jobs with no dispute record', () => {
  assert.equal(selectRefundableDisputes([undelivered], {}).length, 0);
});
test('buildDisputeRefundEntry: confident target => pending_approval, verified address', () => {
  const target = { address: 'iBUY', displayName: 'buyer@', checks: { isIAddress: true }, confident: true };
  const e = buildDisputeRefundEntry(undelivered, disp, 'agent-5', target, '2026-07-16T00:00:00Z');
  assert.equal(e.status, 'pending_approval');
  assert.equal(e.buyerAddress, 'iBUY');
  assert.equal(e.refundAmount, 0.5);
  assert.equal(e.refundPercent, 100);
  assert.equal(e.disputeId, 'd1');
  assert.equal(e.orphan.buyerPayAddress, 'iBUY');
});
test('buildDisputeRefundEntry: unconfident target => needs_review with failing checks in reason', () => {
  const target = { address: 'iBUY', displayName: null, checks: { disputeSigner: false, isIAddress: true }, confident: false };
  const e = buildDisputeRefundEntry(undelivered, disp, 'agent-5', target, '2026-07-16T00:00:00Z');
  assert.equal(e.status, 'needs_review');
  assert.match(e.reason, /disputeSigner/);
});
