'use strict';
// Money-path regression (2026-07-13): a paid docker job that deterministically
// crashes is retried MAX_RETRIES times then ABANDONED. stopJobContainer frees the
// agent and deletes the job from active-jobs.json BEFORE handleCrashRecovery could
// ever refund it — so the buyer's payment used to get stuck with no delivery and no
// refund. buildAbandonedJobRefund() is the pure record-builder that routes such a
// job into the same durable pending-refunds ledger crash-recovery uses. It must:
//   (a) produce a correct refund record for a PAID abandoned job,
//   (b) produce NONE for an unpaid job (no amount / no buyer address),
//   (c) produce NONE for a job already refunded OR already queued (idempotency).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAbandonedJobRefund } = require('../src/refund.js');

// The crash-recovery fields persistActiveJobs stores on an active-job entry.
const paidJob = {
  jobAmount: 4,
  buyerPayAddress: 'iBuyerAddr',
  currency: 'VRSCTEST',
  agentInfoId: 'agent-1',
};

test('(a) a PAID abandoned job produces a correct refund record', () => {
  const record = buildAbandonedJobRefund(paidJob, 'job-1', 100, new Set(), {});
  assert.ok(record, 'record produced');
  assert.equal(record.agentInfoId, 'agent-1');
  assert.equal(record.refundPercent, 100);
  assert.equal(record.refundAmount, 4, 'full amount at 100%');
  assert.equal(record.buyerAddress, 'iBuyerAddr');
  // orphan is slim + JSON-serializable (the ledger is written to disk) and carries
  // the currency attemptPendingRefund logs.
  assert.equal(record.orphan.currency, 'VRSCTEST');
  assert.equal(record.orphan.buyerPayAddress, 'iBuyerAddr');
  assert.equal(record.orphan.jobAmount, 4);
  // Shape matches the record handleCrashRecovery enqueues.
  assert.deepEqual(
    Object.keys(record).sort(),
    ['agentInfoId', 'buyerAddress', 'orphan', 'refundAmount', 'refundPercent'],
  );
  // A partial policy percentage scales the amount.
  const partial = buildAbandonedJobRefund(paidJob, 'job-1', 50, new Set(), {});
  assert.equal(partial.refundAmount, 2, '50% policy halves the refund');
});

test('(b) an UNPAID abandoned job produces no refund record', () => {
  // No amount recorded.
  assert.equal(
    buildAbandonedJobRefund({ ...paidJob, jobAmount: 0 }, 'job-2', 100, new Set(), {}),
    null,
    'zero amount → no refund',
  );
  assert.equal(
    buildAbandonedJobRefund({ ...paidJob, jobAmount: null }, 'job-2', 100, new Set(), {}),
    null,
    'null amount → no refund',
  );
  // Amount but no buyer address to pay.
  assert.equal(
    buildAbandonedJobRefund({ ...paidJob, buyerPayAddress: null }, 'job-2', 100, new Set(), {}),
    null,
    'no buyer address → no refund',
  );
  // No job at all.
  assert.equal(buildAbandonedJobRefund(null, 'job-2', 100, new Set(), {}), null);
});

test('(c) an already-refunded OR already-queued job produces no refund record', () => {
  // Already paid (in the refunded-jobs ledger).
  assert.equal(
    buildAbandonedJobRefund(paidJob, 'job-3', 100, new Set(['job-3']), {}),
    null,
    'already-refunded → no double refund',
  );
  // Already queued in the durable pending-refunds ledger.
  assert.equal(
    buildAbandonedJobRefund(paidJob, 'job-3', 100, new Set(), { 'job-3': { refundAmount: 4 } }),
    null,
    'already-queued → no duplicate enqueue',
  );
});

test('refundPercent defaults to 100 when not a finite number', () => {
  const record = buildAbandonedJobRefund(paidJob, 'job-4', undefined, new Set(), {});
  assert.equal(record.refundPercent, 100);
  assert.equal(record.refundAmount, 4);
});
