'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { selectRefundableDisputes, buildDisputeRefundEntry, hasPositiveTokens } = require('../src/dispute-sweep.js');

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

// Exclusion-logic locks (Task 3 review, Minor): guard against a refactor that
// silently auto-refunds delivered/token-bearing work.
test('hasPositiveTokens: {total:0} and null are no-tokens; {input:5} is positive', () => {
  assert.equal(hasPositiveTokens({ total: 0 }), false);
  assert.equal(hasPositiveTokens(null), false);
  assert.equal(hasPositiveTokens(undefined), false);
  assert.equal(hasPositiveTokens({ input: 5 }), true);
  assert.equal(hasPositiveTokens({ total: 42 }), true);
});

test('excludes a job with a non-null empty delivery object', () => {
  const out = selectRefundableDisputes([{ ...undelivered, delivery: {} }], { j1: disp });
  assert.equal(out.length, 0);
});

test('excludes a job whose only token field is a positive input count', () => {
  const out = selectRefundableDisputes([{ ...undelivered, tokenUsage: { input: 5 } }], { j1: disp });
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// Seller-agreed refunds must reach the operator's approval queue.
//
// Found live on job b09440f5 (2026-08-06): responding `refund` to a dispute
// sets action:'refund' on the platform — which is exactly what disqualified the
// job from the `action === 'pending'` filter. Agreeing to pay was the thing
// that guaranteed nobody was ever asked to pay. The buyer saw refund_percent:100
// while no queue entry, no prompt and no automated path existed anywhere.
// ---------------------------------------------------------------------------

const job = (over = {}) => ({
  id: 'j1', status: 'disputed', delivery: null, tokenUsage: null,
  amount: 0.5, currency: 'VRSCTEST', ...over,
});
const target = { address: 'iBuyer', confident: true, checks: {} };

test('a seller-agreed refund IS queued for approval', () => {
  const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action: 'refund', refund_percent: 100 } });
  assert.equal(sel.length, 1, 'the seller said they owe it — it must reach the queue');
});

test('a seller-agreed refund is queued even when the job WAS delivered', () => {
  // Explicit consent outranks the heuristics: the unanswered path skips
  // delivered jobs because it is guessing, but here the seller has decided.
  const sel = selectRefundableDisputes(
    [job({ delivery: { hash: 'abc' }, tokenUsage: { totalTokens: 900 } })],
    { j1: { id: 'd', action: 'refund', refund_percent: 100 } });
  assert.equal(sel.length, 1);
});

test('a refund that was already PAID is never re-queued', () => {
  // The txid is the proof of payment. Re-queueing would pay twice.
  for (const tx of ['abc123', 'deadbeef']) {
    const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action: 'refund', refund_percent: 100, refund_txid: tx } });
    assert.equal(sel.length, 0, `already paid (${tx}) must not re-queue`);
  }
});

test('rework and rejected responses do NOT queue money', () => {
  for (const action of ['rework', 'rejected']) {
    const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action } });
    assert.equal(sel.length, 0, `${action} owes nothing`);
  }
});

test('a malformed refund_percent does not queue a guess', () => {
  for (const p of [null, undefined, 0, -5, 101, NaN, 'half', {}]) {
    const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action: 'refund', refund_percent: p } });
    assert.equal(sel.length, 0, `refund_percent=${JSON.stringify(p)} must not queue`);
  }
});

test('a PARTIAL refund queues the agreed amount, not the whole job', () => {
  // The builder used to hardcode 100. A seller agreeing to 50% would have had
  // the full amount queued — paying double what they owed.
  const e = buildDisputeRefundEntry(job(), { id: 'd', action: 'refund', refund_percent: 50 }, 'agent-7', target, 'now');
  assert.equal(e.refundPercent, 50);
  assert.equal(e.refundAmount, 0.25, 'half of 0.5, not 0.5');
  assert.match(e.reason, /SELLER AGREED/);
});

test('the unanswered path still implies 100% and still requires "got nothing"', () => {
  const e = buildDisputeRefundEntry(job(), { id: 'd', action: 'pending' }, 'agent-7', target, 'now');
  assert.equal(e.refundPercent, 100);
  assert.equal(e.refundAmount, 0.5);
  // and it must still refuse a delivered job
  assert.equal(selectRefundableDisputes([job({ delivery: { hash: 'x' } })], { j1: { id: 'd', action: 'pending' } }).length, 0);
  assert.equal(selectRefundableDisputes([job({ tokenUsage: { totalTokens: 5 } })], { j1: { id: 'd', action: 'pending' } }).length, 0);
});

test('an unverified buyer address still routes to needs_review, not auto-approval', () => {
  const e = buildDisputeRefundEntry(job(), { id: 'd', action: 'refund', refund_percent: 100 }, 'agent-7',
    { address: 'iBuyer', confident: false, checks: { isIAddress: false } }, 'now');
  assert.equal(e.status, 'needs_review');
  assert.match(e.reason, /ADDRESS UNVERIFIED/);
});
