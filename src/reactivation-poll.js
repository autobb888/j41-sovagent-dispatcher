'use strict';
// Pure predicates for poll-mode reactivation decisions.
// Task 4 will add pickResumeBatch here.

/**
 * Returns true iff the active job has been paused on the platform but the local
 * activeInfo entry hasn't been torn down yet (i.e. the container is still running
 * and no webhook / IPC pause was received — Docker+Poll mode gap).
 *
 * Guards:
 *   - activeInfo must exist (job is actually in state.active)
 *   - currentJob.status must be 'paused' on the platform
 *   - activeInfo.paused must NOT already be true (would be a no-op / double-free)
 *   - activeInfo._pausing must NOT be true (mid-teardown — moveJobToReactivationQueue
 *     sets this before stopping the container; prevents double-invocation)
 *
 * @param {{ status: string } | null | undefined} currentJob  Live job record from platform poll.
 * @param {{ paused?: boolean, _pausing?: boolean } | null | undefined} activeInfo  Entry from state.active.
 * @returns {boolean}
 */
function shouldPauseOnPoll(currentJob, activeInfo) {
  return (
    !!activeInfo &&
    currentJob?.status === 'paused' &&
    !activeInfo.paused &&
    !activeInfo._pausing
  );
}

/**
 * Round-robin slice of `queue` for the resume sweep. Starting at `cursor`,
 * picks `min(batchSize, queue.length)` entries (wrapping), and returns the
 * next cursor position (also wrapped).
 *
 * @param {Array<{job:{id:string}, agentId:string, readyToRespawn?:boolean}>} queue
 * @param {number} cursor  Current position in the queue.
 * @param {number} batchSize  Max entries per sweep.
 * @returns {{ batch: Array, nextCursor: number }}
 */
function pickResumeBatch(queue, cursor, batchSize) {
  if (!queue || queue.length === 0) return { batch: [], nextCursor: 0 };
  const n = Math.min(batchSize, queue.length);
  const batch = [];
  let i = cursor % queue.length;
  for (let k = 0; k < n; k++) {
    batch.push(queue[i]);
    i = (i + 1) % queue.length;
  }
  return { batch, nextCursor: i };
}

module.exports = { shouldPauseOnPoll, pickResumeBatch };
