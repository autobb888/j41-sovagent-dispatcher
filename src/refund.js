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

module.exports = { shouldRefundOrphan, isRefundAlreadyHandled, FINISHED_STATUSES };
