# Final Review Fixes Report

## FIX 1 — Cross-process double-send lock
- Added `REFUND_LOCKS_DIR = path.join(DISPATCHER_DIR, 'refund-locks')` constant.
- Added `acquireSendLock(jobId)` / `releaseSendLock(jobId)` helpers (exported under `NODE_ENV=test`).
- Wrapped `attemptPendingRefund` entire body in the lock (acquires before `loadRefundedJobs` de-dup check, releases in `finally`).
- Stale threshold: 120 000 ms; lock file format: `${pid}:${Date.now()}`.

## FIX 2 — `refunds approve` confirmation prompt
- Added `opts.confirmFn` gate to `refundsApprove`: called after re-verify passes, before `addToRefundAllowlist`/send, only when `!opts.yes`. Returns `false` → abort, status stays `pending_approval`.
- Commander `refunds approve` wrapper: when `!options.yes`, passes a `confirmFn` that prints the why-report (jobId, amount, buyerAddress, displayName, per-check ✓/✗, reason) then prompts `y/N` on stdin.
- `refunds approve --all`: when `!yes`, shows count + total + list of jobIds/addresses, prompts once; on yes calls `refundsApproveAll(state, { yes: true })`.
- Removed dead `"Use --yes to confirm"` hint.

## FIX 3 — Per-item ledger save in sweep
- `sweepDisputesForRefund`: moved `savePendingRefunds(ledger)` inside the per-job loop, right after `ledger[jobId] = entry`. Removed the `ledgerDirty` flag.

## Tests
- `test/refund-lock.test.js` (5 new): acquire succeeds, second acquire returns false, stale lock stolen, release removes file, release idempotent.
- `test/refund-cli.test.js` (+3 new, tests 10-12): confirmFn false → no send/pending_approval; confirmFn true → sends/refunded; yes=true/no confirmFn → sends.
- `test/dispute-sweep-wiring.test.js` (+1 new, test 6): ledger FILE persisted immediately after single-item sweep.
