'use strict';
const FINISHED_STATUSES = ['completed', 'resolved', 'resolved_rejected', 'cancelled', 'delivered'];
/** Should an orphaned job be refunded on crash recovery? Only if NOT in a terminal state. */
function shouldRefundOrphan(job, finishedStatuses = FINISHED_STATUSES) {
  if (!job || typeof job.status !== 'string') return false;
  return !finishedStatuses.includes(job.status);
}
module.exports = { shouldRefundOrphan, FINISHED_STATUSES };
