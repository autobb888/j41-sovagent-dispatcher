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
function recordInboxFailure(failures, itemId, errorMessage, maxAttempts = MAX_INBOX_ATTEMPTS, meta = null) {
  const prev = failures.get(itemId) || { attempts: 0, deadLettered: false };
  const attempts = prev.attempts + 1;
  const deadLettered = prev.deadLettered || attempts >= maxAttempts;
  const justDeadLettered = deadLettered && !prev.deadLettered;
  // `meta` (agentId / type / firstFailedAt) is optional and additive so the
  // structured /health surface can name the agent and item type. Existing
  // 3-arg callers are unaffected; earlier meta is preserved when a later call
  // omits it. maxAttempts stays the 4th positional arg for the same reason.
  failures.set(itemId, {
    attempts,
    deadLettered,
    lastError: String(errorMessage || '').slice(0, 300),
    agentId: (meta && meta.agentId) || prev.agentId || null,
    type: (meta && meta.type) || prev.type || null,
    firstFailedAt: prev.firstFailedAt || (meta && meta.firstFailedAt) || null,
  });
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

// ---------------------------------------------------------------------------
// Failure classification
//
// The bug this exists for: an attestation write enters the mempool, the platform
// keeps serving the last *confirmed* prevOutput, and the next write for the same
// identity is built spending an already-spent output → "Transaction rejected by
// the network". That is chain CONTENTION — it resolves itself once the earlier tx
// confirms, so it must never consume the terminal dead-letter budget. Burning 5
// attempts on it is exactly how three reviews got quarantined.
//
// Verified live: the platform's confirmed view stayed stale for >=5 minutes, past
// the confirming block's own timestamp. So the retry horizon has to be "until
// prevOutput actually advances", never a block-time estimate.
// ---------------------------------------------------------------------------

/** Substrings that identify a chain-contention broadcast rejection. */
const CONTENTION_PATTERNS = [
  'transaction rejected by the network',
  'already spent',
  'missing inputs',
  'bad-txns-inputs',
  'txn-mempool-conflict',
];

const TRANSIENT_PATTERNS = [
  'socket hang up', 'timed out', 'timeout', 'econnreset', 'econnrefused',
  'enotfound', 'etimedout', 'network', 'fetch failed', 'temporarily unavailable',
];

/**
 * Classify a failure as 'contention' | 'transient' | 'hard'.
 *
 * - contention → self-resolving; never counted, never escalated.
 * - transient  → environmental; not counted, but CAN escalate if it repeats
 *                forever (see recordBatchFailure) so nothing spins unbounded.
 * - hard       → item's own fault (bad shape, bad signature); counted normally.
 *
 * Defaults to 'hard' on anything unrecognised: a misclassified hard error merely
 * dead-letters an item loudly, while a misclassified transient could retry
 * forever — the pathology this module exists to stop.
 */
function classifyInboxFailure(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  if (code === 'TX_REJECTED') return 'contention';

  const msg = String((err && err.message) || err || '').toLowerCase();
  if (CONTENTION_PATTERNS.some(p => msg.includes(p))) return 'contention';

  const sc = err && typeof err === 'object' ? err.statusCode : undefined;
  if (typeof sc === 'number') {
    if (sc === 429 || sc >= 500) return 'transient';
    if (sc >= 400) return 'hard'; // 4xx: retrying cannot help
  }
  if (TRANSIENT_PATTERNS.some(p => msg.includes(p))) return 'transient';
  return 'hard';
}

// ---------------------------------------------------------------------------
// Pending-write gate
// ---------------------------------------------------------------------------

/** Wall-clock backstop. NOT an expiry estimate — see shouldDeferForPendingWrite. */
const PENDING_WRITE_BACKSTOP_MS = 4 * 60 * 60 * 1000; // 4h > the ~3h20m 200-block window

/**
 * Decide whether to skip an agent this cycle because its last identity write is
 * still unconfirmed. Building a second tx while the first is in the mempool is
 * precisely the double-spend this whole change exists to prevent.
 *
 * Release conditions, in order:
 *  1. `confirmed` — the platform now serves OUR txid as prevOutput. The only
 *     positive signal, and the one that actually matters.
 *  2. `expired`   — chain height passed the tx's expiryHeight, so it can never
 *     confirm. Height-based on purpose: IDENTITY_EXPIRY_DELTA is 200 blocks
 *     (~3h20m at ~60s), so a 30-minute wall-clock release would resume into a
 *     still-valid mempool tx and rebuild the double-spend.
 *  3. `backstop`  — liveness escape for the case where another writer (a job-agent
 *     container, or an operator update-profile) confirmed on top of ours, so the
 *     txid match can never fire and we would otherwise defer forever.
 *
 * Pure: caller supplies chain height and clock.
 */
function shouldDeferForPendingWrite(lastWrite, prevOutputTxid, chainHeight, now, backstopMs = PENDING_WRITE_BACKSTOP_MS) {
  if (!lastWrite || !lastWrite.txid) return { defer: false, reason: 'no-pending-write' };
  if (prevOutputTxid && prevOutputTxid === lastWrite.txid) return { defer: false, reason: 'confirmed' };
  if (typeof lastWrite.expiryHeight === 'number' && typeof chainHeight === 'number'
      && chainHeight > lastWrite.expiryHeight) {
    return { defer: false, reason: 'expired' };
  }
  if (typeof lastWrite.at === 'number' && (now - lastWrite.at) >= backstopMs) {
    return { defer: false, reason: 'backstop' };
  }
  return { defer: true, reason: 'awaiting-confirmation' };
}

// ---------------------------------------------------------------------------
// Bounded batch-failure counter
//
// Batch-level failures are not attributable to any single item, so they are not
// counted against per-item budgets. But "uncounted" must not mean "unbounded":
// an unfunded wallet, or a merged set that fails for a reason bisection cannot
// pin on one item, would otherwise retry forever — the same ~10,000-spins
// pathology this module was written to stop. Contention is the one exception:
// it is genuinely self-resolving, so it never escalates.
// ---------------------------------------------------------------------------

const MAX_BATCH_FAILURES = 5;

/** Order-independent identity of a batch's item set. */
function batchCompositionKey(itemIds) {
  return [...itemIds].sort().join(',');
}

/**
 * Record a batch-level failure. Returns { consecutive, escalate }.
 * `escalate` means the caller should split the batch or start counting the
 * included items individually so they can eventually dead-letter.
 */
function recordBatchFailure(batchFailures, agentId, itemIds, classification, maxFailures = MAX_BATCH_FAILURES) {
  const compositionKey = batchCompositionKey(itemIds);
  const prev = batchFailures.get(agentId);
  const consecutive = prev && prev.compositionKey === compositionKey ? prev.consecutive + 1 : 1;
  batchFailures.set(agentId, { compositionKey, consecutive, classification });
  // Contention resolves on its own once the earlier tx confirms — never escalate.
  const escalate = classification !== 'contention' && consecutive >= maxFailures;
  return { consecutive, escalate };
}

/** A successful batch clears the agent's consecutive-failure record. */
function clearBatchFailure(batchFailures, agentId) {
  batchFailures.delete(agentId);
}

// ---------------------------------------------------------------------------
// Recovery + surfacing
// ---------------------------------------------------------------------------

/**
 * Clear dead-letter quarantine so items are retried, without a process restart.
 * Grants a FRESH full budget rather than a single retry. Operator-initiated
 * (`ctl inbox-redrive`); nothing calls this automatically.
 * Returns how many records were cleared.
 */
function redriveDeadLetters(failures, itemId) {
  let n = 0;
  for (const [id, rec] of [...failures.entries()]) {
    if (itemId && id !== itemId) continue;
    if (rec && rec.deadLettered) { failures.delete(id); n++; }
  }
  return n;
}

/**
 * Split the failure map into dead-lettered vs still-retrying, for /health and
 * `ctl inbox`. The pre-existing surface was a single overwritable per-agent
 * lastError string, which silently lost every failure but the newest.
 */
function listInboxFailures(failures) {
  const deadLettered = [];
  const retrying = [];
  for (const [itemId, rec] of failures.entries()) {
    const row = {
      itemId,
      agentId: (rec && rec.agentId) || null,
      type: (rec && rec.type) || null,
      attempts: (rec && rec.attempts) || 0,
      lastError: (rec && rec.lastError) || null,
      firstFailedAt: (rec && rec.firstFailedAt) || null,
    };
    (rec && rec.deadLettered ? deadLettered : retrying).push(row);
  }
  return { deadLettered, retrying };
}

module.exports = {
  MAX_INBOX_ATTEMPTS,
  MAX_BATCH_FAILURES,
  PENDING_WRITE_BACKSTOP_MS,
  isDeadLettered,
  recordInboxFailure,
  clearInboxFailure,
  pruneInboxFailures,
  classifyInboxFailure,
  shouldDeferForPendingWrite,
  batchCompositionKey,
  recordBatchFailure,
  clearBatchFailure,
  redriveDeadLetters,
  listInboxFailures,
};
