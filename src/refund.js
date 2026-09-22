'use strict';
const FINISHED_STATUSES = ['completed', 'resolved', 'resolved_rejected', 'cancelled', 'delivered'];
/** Should an orphaned job be refunded on crash recovery? Only if NOT in a terminal state. */
function shouldRefundOrphan(job, finishedStatuses = FINISHED_STATUSES) {
  if (!job || typeof job.status !== 'string') return false;
  return !finishedStatuses.includes(job.status);
}
/**
 * Idempotency gate for crash-recovery refunds. Returns true if this jobId has
 * already been paid OR is already queued in the durable ledger — i.e. it must
 * NOT be (re)queued/sent again. `refundedJobs` is a Set of paid jobIds;
 * `pendingRefunds` is the ledger object keyed by jobId.
 */
function isRefundAlreadyHandled(jobId, refundedJobs, pendingRefunds) {
  if (refundedJobs && typeof refundedJobs.has === 'function' && refundedJobs.has(jobId)) return true;
  if (pendingRefunds && Object.prototype.hasOwnProperty.call(pendingRefunds, jobId)) return true;
  return false;
}

/**
 * Build the pending-refunds ledger record for a PAID job that was ABANDONED after
 * exhausting its docker launch retries (cleanupCompletedJobs). Produces the exact
 * record shape handleCrashRecovery enqueues so the shared attemptPendingRefund /
 * drainPendingRefunds machinery pays it out unchanged.
 *
 * Returns null (no refund owed) when:
 *   - the job is already paid, or already queued in the durable ledger (idempotency)
 *   - the job recorded no payment: no positive amount, or no buyer address
 *   - the computed refund amount is not > 0
 *
 * @param {object} job           active-job entry with the crash-recovery fields
 *                               persistActiveJobs stores: jobAmount, buyerPayAddress,
 *                               currency, agentInfoId.
 * @param {string} jobId
 * @param {number} refundPercent policy.systemCrashRefund (defaults to 100).
 * @param {Set}    refundedJobs  set of already-paid jobIds.
 * @param {object} pendingLedger current pending-refunds ledger (keyed by jobId).
 */
function buildAbandonedJobRefund(job, jobId, refundPercent, refundedJobs, pendingLedger) {
  if (!job) return null;
  // Idempotency: never (re)queue a job already paid or already in the ledger.
  if (isRefundAlreadyHandled(jobId, refundedJobs, pendingLedger)) return null;

  const jobAmount = Number(job.jobAmount) || 0;
  const buyerAddress = job.buyerPayAddress || null;
  // Only PAID jobs get refunds: a job with no recorded amount/address must not
  // generate one.
  if (!(jobAmount > 0) || !buyerAddress) return null;

  const pct = Number.isFinite(refundPercent) ? refundPercent : 100;
  const refundAmount = jobAmount * (pct / 100);
  if (!(refundAmount > 0)) return null;

  return {
    agentInfoId: job.agentInfoId || null,
    // Slim, JSON-serializable orphan (the ledger is persisted to disk). Mirrors the
    // fields persistActiveJobs writes; attemptPendingRefund reads orphan.currency.
    orphan: {
      jobAmount,
      buyerPayAddress: buyerAddress,
      currency: job.currency || 'VRSC',
      agentInfoId: job.agentInfoId || null,
    },
    refundAmount,
    refundPercent: pct,
    buyerAddress,
    status: 'pending_approval',
    reason: 'crash-recovery: paid job abandoned after docker launch retries',
  };
}

/**
 * What crash recovery should do with one active-jobs row.
 *
 * `clear`  — terminal, or already not owed a refund. Drop the active row.
 * `refund` — write `record` (pending_approval, or needs_review when the pay
 *            address was never stored). Drop the active row; the ledger has it.
 * `keep`   — paid-or-unknown and we still cannot file a ledger row. The active
 *            row stays. Wiping it is how a restart used to lose the buyer.
 *
 * A missing pay address with a buyer identity is needs_review, not a silent drop.
 * refunds approve refuses needs_review, so this does not send.
 */
function classifyCrashOrphan({ orphan, currentJob, fetchFailed = false, refundPercent = 100 } = {}) {
  if (currentJob && !shouldRefundOrphan(currentJob)) return { action: 'clear' };

  const jobAmount = Number(orphan && orphan.jobAmount) || Number(currentJob && currentJob.amount) || 0;
  const buyerAddress = (orphan && orphan.buyerPayAddress)
    || (currentJob && (currentJob.buyerPayAddress || (currentJob.buyer && currentJob.buyer.payAddress)))
    || null;
  const buyerVerusId = (orphan && orphan.buyerVerusId)
    || (currentJob && currentJob.buyerVerusId)
    || null;
  const currency = (orphan && orphan.currency) || (currentJob && currentJob.currency) || 'VRSC';
  const agentInfoId = (orphan && orphan.agentInfoId) || null;

  if (!(jobAmount > 0)) {
    if (fetchFailed || !currentJob) return { action: 'keep' };
    return { action: 'clear' };
  }

  const pct = Number.isFinite(Number(refundPercent)) ? Number(refundPercent) : 100;
  const refundAmount = jobAmount * (pct / 100);
  if (!(refundAmount > 0)) return { action: 'keep' };

  const record = {
    agentInfoId,
    orphan: {
      jobAmount,
      buyerPayAddress: buyerAddress,
      buyerVerusId,
      currency,
      agentInfoId,
    },
    refundAmount,
    refundPercent: pct,
    buyerAddress: buyerAddress || null,
  };

  if (buyerAddress) {
    record.status = 'pending_approval';
    record.reason = 'crash-recovery: job interrupted (dispatcher restart) — undelivered paid job';
    return { action: 'refund', record };
  }
  if (buyerVerusId) {
    record.status = 'needs_review';
    record.reason = 'crash-recovery: paid job has no pay address — needs_review, not sent';
    return { action: 'refund', record };
  }
  return { action: 'keep' };
}

/** Move a needs_review crash row to pending_approval once a pay address is known. */
function promoteNeedsReview(entry, payAddress) {
  if (!entry || entry.status !== 'needs_review' || !payAddress) return null;
  const orphan = Object.assign({}, entry.orphan, { buyerPayAddress: payAddress });
  return Object.assign({}, entry, {
    status: 'pending_approval',
    buyerAddress: payAddress,
    orphan,
    reason: 'crash-recovery: pay address found on a later read — pending approval, not sent',
  });
}

module.exports = {
  shouldRefundOrphan,
  isRefundAlreadyHandled,
  buildAbandonedJobRefund,
  classifyCrashOrphan,
  promoteNeedsReview,
  FINISHED_STATUSES,
};
