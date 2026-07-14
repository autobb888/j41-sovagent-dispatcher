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

module.exports = { shouldPauseOnPoll };
