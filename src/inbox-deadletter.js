'use strict';
/**
 * Dead-letter tracking for inbox accepts (reviews + job records).
 *
 * The daemon polls each agent's pending inbox every reviewInterval (>=60s) and
 * calls acceptReview / acceptJobRecord on every item. Before this, a failing
 * item was re-attempted every single cycle with no memory — a single poisoned
 * review (wrong on-chain shape, unverifiable signature) spun ~10,000 times over
 * days and then vanished silently at expiry. The accept itself is correct to
 * refuse a bad item; the defect was retrying it forever and invisibly.
 *
 * This bounds retries: after MAX_INBOX_ATTEMPTS consecutive failures an item is
 * quarantined — skipped on every later cycle, logged loudly exactly once, and
 * surfaced to the agent health document. It does NOT recover the item (a review
 * with a bad signature is unrecoverable); it makes the next backend regression
 * fail fast and loud instead of grinding invisibly.
 *
 * Pure functions over a caller-owned Map so the decision logic is unit-testable
 * without a daemon, a network, or a wallet. The Map lives on daemon `state`
 * (state._inboxFailures) alongside the other health maps and dies with the
 * process — a restart is a deliberate clean retry.
 */

// Matches the backend review-verification worker's cap (MAX_VERIFICATION_ATTEMPTS)
// so the two sides give up at the same point rather than one spinning past the other.
const MAX_INBOX_ATTEMPTS = 5;

/** True if this item has already been quarantined and must not be retried. */
function isDeadLettered(failures, itemId) {
  const rec = failures.get(itemId);
  return !!(rec && rec.deadLettered);
}

/**
 * Record one failed attempt and decide whether the item is now dead-lettered.
 * Returns { attempts, deadLettered, justDeadLettered } — justDeadLettered is
 * true only on the transition, so the caller logs/alerts exactly once.
 */
function recordInboxFailure(failures, itemId, errorMessage, maxAttempts = MAX_INBOX_ATTEMPTS) {
  const prev = failures.get(itemId) || { attempts: 0, deadLettered: false };
  const attempts = prev.attempts + 1;
  const deadLettered = prev.deadLettered || attempts >= maxAttempts;
  const justDeadLettered = deadLettered && !prev.deadLettered;
  failures.set(itemId, { attempts, deadLettered, lastError: String(errorMessage || '').slice(0, 300) });
  return { attempts, deadLettered, justDeadLettered };
}

/** A successful accept clears any prior failure record for that item. */
function clearInboxFailure(failures, itemId) {
  failures.delete(itemId);
}

/**
 * Drop tracking for items no longer pending on the backend (accepted or expired),
 * so the Map cannot grow without bound. Only prunes when `completeView` is true —
 * i.e. every agent polled successfully this cycle — otherwise a dead-lettered item
 * belonging to a momentarily-unreachable agent would be wrongly forgotten and reset
 * to zero attempts on the agent's next recovery. Returns the count pruned.
 */
function pruneInboxFailures(failures, seenIds, completeView) {
  if (!completeView) return 0;
  let pruned = 0;
  for (const id of [...failures.keys()]) {
    if (!seenIds.has(id)) {
      failures.delete(id);
      pruned++;
    }
  }
  return pruned;
}

module.exports = {
  MAX_INBOX_ATTEMPTS,
  isDeadLettered,
  recordInboxFailure,
  clearInboxFailure,
  pruneInboxFailures,
};
