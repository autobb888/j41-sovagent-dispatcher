# Batched Identity Update (Inbox Approach D) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the inbox processor from double-spending the identity `prevOutput` by batching ALL of an agent's pending inbox items (review / attestation / job_record) into ONE `updateidentity` transaction per poll cycle — plus recovery (chain contention never burns the dead-letter budget) and alerting (structured, non-lossy dead-letter surface).

**Architecture:** A new pure SDK gate module (`src/inbox/vdxf-gate.ts`) becomes the single source of truth for the per-type VDXF allowlists (the 52f8d07 security property); the three existing `accept*` methods and a new `J41Agent.acceptInboxBatch()` all call it. The batch method validates each item independently, merges healthy items into one `vdxfAdditions` map (one item per VDXF key per batch), builds/signs/broadcasts one tx via the existing `buildIdentityUpdateTx()` (`src/identity/update.ts:71`), then acks each item individually with the shared txid. The dispatcher rewrites `checkPendingInbox`'s per-agent loop around the batch call, adds a per-agent pending-write confirmation gate (never build a second tx while the last one is unconfirmed), classifies batch-level failures as contention/environmental (never counted per item), and surfaces the failure map through `/health` and two new control commands (`inbox`, `inbox-redrive`).

**Tech Stack:** SDK = TypeScript→CJS (`yarn build`, tests `npx tsx --test test/*.test.ts`, currently 312/312). Dispatcher = plain CJS, no build (`node --check src/*.js src/executors/*.js && node --test test/*.test.js`, currently 550/550). SDK is **yarn-linked** into the dispatcher's `node_modules` — never run `yarn add` in the dispatcher.

**Bug being fixed (established fact):** Within one poll cycle the dispatcher writes attestation then review to the same VerusID. The attestation tx spends the identity's `prevOutput` (`update.ts:196-198`) and sits in the mempool; the platform API still serves the last *confirmed* `prevOutput`, so the review tx is built spending an already-spent output → "Transaction rejected by the network". 5 retries × ~60s elapse before the platform's view catches up, then the item dead-letters terminally (`cli.js:6354-6361`). Three reviews failed to reach the chain in one live run.

**Independently verified 2026-07-29 — two corrections to the above:**
1. **Not "permanently lost."** All three reviews remain `pending` in the platform inbox; the dead-letter map is process-lifetime, so a restart re-queues them. Recoverable, not destroyed.
2. **The stale window outlasts the block — this is load-bearing for the retry design.** The platform was still serving the pre-attestation `prevOutput` at 01:44:10, 70+s after the confirming block's timestamp (01:42:59, height 1,166,824 — note: 1166825 quoted elsewhere is off by one). Proof: a second attestation broadcast at 01:44:10 produced a **byte-identical txid** to the 01:39 one; under RFC6979 deterministic signing that means identical inputs, i.e. the same stale prevOutput and fee UTXO. Observed staleness **≥5 minutes**, likely backend indexer lag rather than chain timing. **Therefore the retry/gate horizon must key on observing `prevOutput` actually advance — never on an assumed block time.** The v2 height-based gate expiry is necessary but NOT sufficient on its own: `blockHeight > expiryHeight` is the *outer* bound; the *inner* release condition must remain the observed txid match.
3. Also: `buildIdentityUpdateTx` spends the identity `prevOutput` **and** the largest R-address UTXO (greedy `selectUtxos`, `update.ts:47-64`), so the rejected tx double-spent the fee UTXO too — two independent double-spends, not one.
4. Scope note: the 4th failing item `fcc0fb82` is a **legacy 2026-07-08 malformed item** (raw JSON field names instead of VDXF i-addresses) — permanently invalid, no tx is ever built, and it will re-dead-letter after every restart. Batching neither can nor should fix it; it needs backend-side rejection/expiry. Do not treat it as a success criterion for this work.

## Revision log — v2, after adversarial audit (2026-07-29)

v1 was audited by an independent reviewer and returned **NEEDS REVISION**. Citations, the security/gate refactor, the same-key deferral, the size arithmetic, and the compat/fallback story all verified sound. The failure-handling design did not. Changes in v2:

| # | Severity | Fix |
|---|---|---|
| 1 | **Critical** | **Build-stage blame bisection + bounded batch-failure counter.** v1 claimed batch-level throws were never item-attributable. False: `contentmultimapValueByteSize` `JSON.stringify`-fallbacks over any object (`vdxf.ts:197-215`) and never validates structure, so a malformed value under a *correctly allowlisted* key passes the gate and the size check, then throws at `Identity.fromJson` (`update.ts:139-140`) — as an uncounted batch-level throw. That item would (i) retry forever and (ii) permanently block every healthy item for that agent. Now: solo-rebuild bisection attributes blame → `rejected`; non-contention batch failures are bounded and escalate. |
| 2 | Important | **Already-on-chain short-circuit + `ackFailed` surfacing.** Ack retries are idempotent in value but not in cost — each rebroadcast pays 10,000 sats (`update.ts:15`), and `ackFailed` items appeared in no health surface. |
| 3 | Important | **Height-based gate expiry.** v1's "expired at tip+200 ≈ 30 min" was wrong arithmetic — 200 blocks ≈ 3h20m — so a 30-min release would double-spend a still-valid mempool tx. Plus explicit other-writer handling. |
| 4 | Important | **job_record transient classification.** Network flakes in the pre-gate were counted, so 5 API blips could dead-letter a healthy item — and that falsified the "still dead-lettered ⇒ genuinely poisoned" claim. |
| — | Minor | `Object.create(null)` for the merged map; valid base58 test fixture; `_inboxSweepRunning` reentrancy guard; stale `pendingWrites` cleared even when an agent has no pending items; `state.emitEvent` integration; `_inboxLastWrite` restart-loss noted; cross-repo contract test; live E2E proof step; deferred-item-eventually-writes test. |
| — | ~~Blocking~~ ✅ | Backend ack contract **answered 2026-07-29** — and it partially refuted the assumption. Re-accept returns `400 ALREADY_PROCESSED`, so it must be treated as **terminal success**; the original design would have parked lost-response items in `ackFailed` forever. See Design step 7. |

## Global Constraints

- **Never widen a per-item allowlist.** `acceptReview` admits exactly `[VDXF_KEYS.review.record]` (`agent.ts:1420`), `acceptAttestationTuple` exactly `[VDXF_KEYS.review.attestation]` (`agent.ts:1516`), `acceptJobRecord` exactly `Object.values(VDXF_KEYS.job)` (`agent.ts:1589`). SDK commit `52f8d07` ("lock acceptReview allowlist to review.record") exists because an audit found the review path admitting the attestation key. The batch path enforces each item's own gate BEFORE merging; a cross-namespace key never rides in on another item's type.
- **Per-item independence.** One poisoned item must never fail the batch. Validation is per item; bad items are dropped (rejected) and dead-lettered individually while healthy items still write.
- **Fail-closed error-message compatibility.** Existing SDK tests pin the gate error strings (`test/accept-review-path.test.ts:51,64,78,110`; `test/accept-attestation.test.ts:32,42`). The refactored gate must emit byte-compatible messages.
- **`{ skip: true }` semantics reused, not duplicated:** "transient — neither counted nor cleared" (`cli.js:6351`). Batch `deferred` / `ackFailed` / batch-level throws all map onto that semantic.
- **Dead-letter module stays pure.** `src/inbox-deadletter.js` is pure functions over a caller-owned Map — no daemon/network/wallet. All new recovery helpers keep that property.
- **No env-var bypass switches** (per project rule feedback_no_bypass_in_prod): recovery is achieved by classification + confirmation gating, never by disabling verification.
- **SDK tests import `dist/`** (see `test/accept-review-path.test.ts:6`) → `yarn build` before running SDK tests. Dispatcher consumes `require('@junction41/sovagent-sdk/dist/index.js')` through the symlink, so SDK `yarn build` must precede dispatcher tasks.
- Fee note: one batched tx pays ONE fee (10000 sats, `update.ts:15`) instead of N — batching is also cheaper.

---

## Design

### New SDK surface (v2.12.0)

**1. Pure gate module — `src/inbox/vdxf-gate.ts` (new file)**

```ts
export type InboxAcceptType = 'review' | 'attestation' | 'job_record';

/** The exact per-type allowlist (i-address set). Single source of truth. */
export function inboxAllowlistForType(type: InboxAcceptType): ReadonlySet<string>;

/**
 * Validate one inbox item's vdxfData against ITS OWN type gate and return the
 * vdxfAdditions map for that item alone. Throws on: unsupported type, empty
 * after whitelist, or missing vdxfData for a type that must not synthesize
 * (review, attestation). job_record keeps its synthesis fallback
 * (verbatim port of agent.ts:1607-1618).
 * `label` prefixes error/log messages, e.g. "acceptReview r1".
 */
export function buildInboxVdxfAdditions(
  type: InboxAcceptType,
  inboxItem: { vdxfData?: Record<string, unknown> | null; senderVerusId?: string; jobHash?: string; [k: string]: unknown },
  label: string,
): Record<string, unknown[]>;

/** Sum of contentmultimapValueByteSize over all values in an additions map. */
export function additionsByteSize(additions: Record<string, unknown[]>): number;

/** Conservative total-additions budget per batch tx (see Constraint 3). */
export const MAX_BATCH_ADDITION_BYTES = 15000;
```

The three existing accept methods (`agent.ts:1384`, `:1492`, `:1561`) are refactored to call `buildInboxVdxfAdditions` — their behavior and error strings are pinned by existing tests, which is the regression proof that 52f8d07 is preserved.

**2. Batch method — `J41Agent.acceptInboxBatch()` (in `src/agent.ts`, after `acceptJobRecord` ~line 1641)**

```ts
export interface InboxBatchItemRef { id: string; type: 'review' | 'attestation' | 'job_record'; }

export interface InboxBatchResult {
  txid: string | null;                                      // null when nothing was mergeable
  written: InboxBatchItemRef[];                             // items whose additions are in the broadcast tx
  acked: string[];                                          // inbox ids successfully acked to the backend
  ackFailed: Array<{ id: string; error: string }>;          // written on-chain but backend ack failed (transient)
  rejected: Array<{ id: string; type: string; error: string }>; // hard per-item failures (poisoned) — caller dead-letters
  deferred: Array<{ id: string; type: string; reason: string }>; // transient (key-collision, size-budget, fetch flake)
  alreadyDone: string[];                                    // status !== 'pending' on fetch
}

async acceptInboxBatch(
  items: InboxBatchItemRef[],
  opts?: { maxAdditionBytes?: number },
): Promise<InboxBatchResult>
```

Contract:
1. For each item: `getInboxItem(id)`; a fetch throw → `deferred` (`getInboxItem failed: …`); `status !== 'pending'` → `alreadyDone`.
2. `buildInboxVdxfAdditions(type, item, ...)` in try/catch → throw = `rejected` (hard, poisoned). Then `assertContentmultimapValueSizes(additions)` (`vdxf.ts:218`) per item → throw = `rejected` (a >5000-byte value can never fit; per `vdxf.ts:194` it would silently truncate on-chain).
3. Merge rule — **one item per VDXF key per batch**: if any of the item's keys is already merged → `deferred: 'key-collision'`. Rationale: `buildIdentityUpdateTx` REPLACES existing CMM keys with the additions array (`update.ts:117-120`, comment "replace existing keys, add new ones"); two same-key items merged naively would clobber each other inside one tx — the same silent loss this plan exists to fix. Deferring the second item to the next cycle reproduces today's serial replace-per-write on-chain end state exactly.
4. Running total via `additionsByteSize`; exceeding `maxAdditionBytes` → `deferred: 'size-budget'`.
5. If nothing merged → return with `txid: null` and NO chain/identity calls.
6. ONE `getIdentityRaw()` + `getUtxos()` + `getChainInfo()`.

   **6a. Already-on-chain short-circuit (AUDIT FIX 2).** Before building, compare each merged item's additions against the just-fetched `identityData.identity.contentmultimap`. If an item's value is already present on-chain under its key, move it to `written` WITHOUT including it in the tx — it only needs its backend ack. If *every* item short-circuits, skip the build and broadcast entirely (`txid: null`, but `written` non-empty) and go straight to step 7. This makes ack-retry free and is what stops a persistently-failing ack from rebroadcasting identical data forever at 10,000 sats/tx (`update.ts:15`).

   **6b. Build with blame bisection (AUDIT FIX 1 — the disqualifying one).** `buildIdentityUpdateTx({ ...merged })` in try/catch. Per-item validation does NOT prove a value can serialize: `contentmultimapValueByteSize` (`vdxf.ts:197-215`) falls back to `JSON.stringify(value)` for any object, so a malformed DataDescriptor / non-hex garbage under a *correctly allowlisted* key passes both the gate and the size check, then throws inside `Identity.fromJson` / `IdentityScript.fromIdentity` (`update.ts:139-140`).

   On a build throw, **bisect to attribute blame**: rebuild each included item's additions *alone* (offline, deterministic, no broadcast, no network — cheap). Any item whose solo build throws → `rejected` (hard/poisoned, caller dead-letters it individually). Rebuild the batch from the survivors and continue. If every item builds alone but the merged set does not, the fault is genuinely batch-scoped → throw.

   Without this, a single gate-passing/build-breaking item is an uncounted batch-level throw that (i) retries forever — the exact pathology `inbox-deadletter.js:7-10` exists to stop — and (ii) takes every healthy item for that agent down with it, permanently, with no dead-letter, no redrive, and no restart recovery. That is the original silent-data-loss bug reintroduced and made worse, and it violates the Global Constraint "one poisoned item must never fail the batch."

   **6c. Broadcast.** ONE `broadcast()`. Missing `prevOutput` / no UTXOs / broadcast failures **throw** (batch-level). See "Bounded batch-failure counter" below — batch-level throws are uncounted but NOT unbounded.
7. Per written item: `acceptInboxItem(id, txid)` (`client/index.ts:708`) individually in try/catch → success = `acked` + emit the existing per-type event (`review:accepted` / `attestation:accepted` / `job_record:accepted`, same `{ inboxId, txid }` payloads as `agent.ts:1476`, `:1550`, `:1636`); failure = `ackFailed` (item stays `pending` on the backend and re-appears next cycle; with 6a the re-attempt costs no chain write). **`ackFailed` is transient and uncounted, but it MUST be surfaced** — see alerting, Fix 2.

   **✅ BACKEND CONTRACT — ANSWERED 2026-07-29 (was BLOCKING). Partially refutes the earlier assumption; read carefully.**

   The ack handler does two **non-atomic** steps: (1) flip `status` → `accepted`, then (2) best-effort insert the cached review row.

   - Fails *before* the status UPDATE commits (validation / the UPDATE itself) → item **stays `pending`** → safe to retry. ✅ as assumed.
   - UPDATE commits, then the review-row insert throws → the error is caught and logged, **the handler still returns 200** → item is accepted, no retry needed. Once the UPDATE commits, the item is accepted regardless of what follows; the insert never rolls the status back.

   **⚠️ Re-accept is NOT idempotent in the "returns success" sense.** Re-accepting an already-accepted item returns **`400 ALREADY_PROCESSED`** (backend `inbox.ts:265`). It is *safe* — no double status flip, no duplicate review (unique index on `(agent_verus_id, job_hash)`) — but **our code MUST treat `400 ALREADY_PROCESSED` as terminal SUCCESS, not a retryable failure.**

   **Design consequences (binding on Task 2):**
   1. In the per-item ack try/catch, a `400 ALREADY_PROCESSED` goes to **`acked`**, never to `ackFailed`. Without this, the realistic case "server committed the UPDATE but the response was lost in transit" would park the item in `ackFailed` forever — and with the 6a short-circuit suppressing the rebroadcast, it would never resolve. This is a genuine infinite-stall bug that the original design would have shipped.
   2. Match on the **machine code** `ALREADY_PROCESSED`, not on the human message. Treat *any* other 4xx as hard.
   3. The authoritative "accept succeeded" signal is **`status === 'accepted'`**, NOT the presence of a cached review row.
   4. **Do not rely on re-accept to backfill a missing review row.** A crash between the two steps leaves `accepted` + no cached row, and re-accept (400) cannot repair it. That is not a correctness hole: the row is only a visibility cache, the real review is on-chain, the worker verifies against `getIdentityContent` rather than the DB row, and the indexer backfills. Guarantee the review via the on-chain write + indexer, never via re-accept.

### Dispatcher call flow (rewrite of the per-agent body of `checkPendingInbox`, `cli.js:6324-6380`)

Per agent, after fetching `pending` (unchanged filter, `cli.js:6337-6339`):

1. **Pending-write gate** (new): if `state._inboxLastWrite` (new Map, `agentId → { txid, at, expiryHeight }`) has an entry, fetch `agent.client.getIdentityRaw()` and call the pure helper `shouldDeferForPendingWrite(lastWrite, prevOutputTxid, chainHeight, now)`. While the last broadcast txid ≠ current confirmed `prevOutput.txid` → skip this agent's items entirely this cycle (transient, nothing counted). On match → confirmed, clear gate, proceed.

   **Expiry is height-based, not a wall-clock guess (AUDIT FIX 3).** Store the `expiryHeight` used at build time (`IDENTITY_EXPIRY_DELTA = 200`, `update.ts:18`) and release the gate once `getChainInfo().blockHeight > expiryHeight` — at which point the tx is *provably* dead rather than merely slow. The earlier draft justified a 30-minute release as "expired at tip+200"; that arithmetic was wrong — 200 blocks at ~60s Verus blocks is **~3h20m, not 30 min**, so a 30-min release would resume straight into a still-valid mempool tx and double-spend it. Keep a wall-clock backstop (30 min) ONLY as a liveness escape for the case below, and label it honestly as a bounded contention-loop window, not as expiry.

   **Other-writer case:** if a different writer (job-agent container auto-accept `agent.ts:1139-1147`, or an operator `update-profile`) confirms on top of our tx, `prevOutput.txid` will never equal ours and the txid match can never fire. The wall-clock backstop covers this; on release, log it distinctly (`pending-write gate released by backstop — likely a concurrent writer`) so it is diagnosable rather than silent.

   **Restart:** `_inboxLastWrite` lives in process memory and is lost on restart. Benign — the first post-restart cycle may hit contention once and self-heals via classification. Noted so it is not mistaken for a bug.
2. **Feature-detect**: if `typeof agent.acceptInboxBatch !== 'function'` (dispatcher running against SDK ≤2.11.0) → legacy per-item loop via the existing `dispatchInboxAccept` (`cli.js:6289`), now with `classifyInboxFailure` so contention no longer counts. `dispatchInboxAccept` and its tests are kept.
3. **Batched path**: build the batch list = pending items that are not dead-lettered; `job_record` items first run `verifyInboxJobRecord` (`src/inbox-job-record.js:222`) — its `{skip:true}` (409/NOT_WITNESSABLE, `inbox-job-record.js:269-271`) excludes the item this cycle (uncounted, uncleared); its throw dead-letter-counts that item only. Then one `agent.acceptInboxBatch(batch)` call and map the result:
   - `res.txid` → `state._inboxLastWrite.set(agentId, { txid, at })`
   - `acked` + `alreadyDone` → `clearInboxFailure`
   - `ackFailed` + `deferred` → nothing (the `{skip:true}` semantic: neither counted nor cleared)
   - `rejected` → `recordInboxFailure(..., { agentId, type })` (unchanged 5-attempt budget → dead-letter)
   - batch-level throw → `classifyInboxFailure(e)`; log + set `state._agentErrors`; not counted against any individual item's dead-letter budget, **but bounded** — see below.

   **Bounded batch-failure counter (AUDIT FIX 1, second half).** "Uncounted" must not mean "unbounded." Track `state._inboxBatchFailures: agentId → { compositionKey, consecutive }`, where `compositionKey` is the sorted item-id set of the attempted batch. On a batch-level throw with the SAME composition, increment; a different composition or any success resets. Behaviour by class:
   - `contention` → never escalates (waiting for confirmation is correct and self-resolving).
   - non-contention (unfunded wallet, API down, or a merged-set build failure that survived bisection) → after `MAX_BATCH_FAILURES = 5` consecutive identical-composition failures, escalate: attempt a **cross-cycle bisection** by splitting the batch composition in half on the next cycle; if a singleton composition still fails non-contention 5 times, count that item via `recordInboxFailure` so it can dead-letter.

   This preserves the useful property (a transient environmental fault never poisons the retry budget) while restoring the guarantee `inbox-deadletter.js` was written for: nothing can spin forever, and one item can never permanently block an agent's other items.

   **job_record pre-gate classification (AUDIT FIX 4).** `verifyInboxJobRecord` (`inbox-job-record.js:222-283`) treats only 409/`NOT_WITNESSABLE` as `{skip}`; a plain network failure in `getJobWitness`/`getJobByHash` currently **throws** and would be counted — so five API blips could dead-letter a perfectly healthy job_record, while the identical flake for a review inside the batch is `deferred` (uncounted). That asymmetry also falsifies the constraint-6 claim that "anything still dead-lettered is genuinely poisoned." Fix: in the pre-gate catch, run `classifyInboxFailure` — network/5xx/timeout → treat as skip (uncounted); only genuine verification failures (bad witness, cross-check mismatch, decode error) count. Same treatment for a dispatcher-side `getInboxItem` flake on a job_record.

### Explicit decisions on the 7 constraints

1. **Allowlist gates (52f8d07):** enforced per item inside `buildInboxVdxfAdditions` — the ONLY place allowlists live after the refactor, called by all three single accepts AND the batch, so the paths cannot drift. An attestation key arriving on a `review` item is dropped/rejected exactly as today; it can never enter the merged map under the review item's identity because merging happens strictly after the per-item gate. Regression-pinned by the untouched `test/accept-review-path.test.ts` + `test/accept-attestation.test.ts` plus new batch tests asserting a poisoned item's keys never reach `buildIdentityUpdateTx`.
2. **No all-or-nothing coupling:** per-item validation → `rejected` (drops the item, keeps the batch). **Corrected after audit:** the earlier claim that batch-scoped failures are "by construction not attributable to any single item" was FALSE for the build stage — a gate-passing item can still break `Identity.fromJson` (`update.ts:139-140`) because the size check `JSON.stringify`-fallbacks over any object (`vdxf.ts:197-215`) and never validates structure. Build failures are therefore attributed by **solo-rebuild bisection** (step 6b) and become `rejected` like any other per-item fault. Only identity-fetch / UTXO / broadcast failures remain genuinely batch-scoped, and those are bounded by the batch-failure counter rather than retried forever.
3. **Size:** per-value cliff stays guarded by `assertContentmultimapValueSizes` (checked per item pre-merge → oversized value = `rejected`, plus the existing builder-level check at `update.ts:115` as backstop). Total: the one-item-per-key rule structurally caps a batch at 3 distinct keys today (`review.record`, `review.attestation`, `job.record` — `VDXF_KEYS.job` has only `record`, `vdxf.ts:87-89`), i.e. ≤15000 bytes of additions; `MAX_BATCH_ADDITION_BYTES = 15000` is an explicit belt-and-braces invariant (configurable via `opts` for tests), and overflow items are **deferred to the next cycle** (split-across-cycles), never dropped. *Open question flagged in Risks: the true total identity-script ceiling beyond the per-value 5.5KB cliff is not derivable from this codebase; the conservative budget + ≤3 keys keeps us far below any plausible limit.*
4. **Backend accept semantics:** each `accept*` today does write-then-`acceptInboxItem(inboxId, txid)` (`agent.ts:1473`, `:1548`, `:1633`). Batched: one broadcast, then one `acceptInboxItem(id, sharedTxid)` per written item. If the tx broadcasts but an ack fails: the item remains `pending` (status only changes on a successful ack), reappears next cycle, is re-batched — the rewrite is an idempotent same-value replace (`update.ts:117-120`) — and re-acked; meanwhile the pending-write gate prevents any premature second tx. `ackFailed` is transient (uncounted). *Verified from the SDK/client side only; the backend contract that a failed ack leaves the item `pending` is assumed — flagged in Risks.*
5. **`{skip:true}` contract:** reused as-is. `verifyInboxJobRecord`'s skip excludes the item pre-batch exactly as `dispatchInboxAccept` treats it today (`cli.js:6312-6314`, `:6351`); batch `deferred`/`ackFailed` and batch-level contention map to the same "neither counted nor cleared" behavior. No parallel mechanism is introduced.
6. **Dead-letter module purity:** all additions (`classifyInboxFailure`, `redriveDeadLetters`, `listInboxFailures`, `shouldDeferForPendingWrite`, meta-carrying `recordInboxFailure`) are pure functions over caller-owned data. Existing tests in `test/inbox-deadletter.test.js` pass unchanged (meta is an optional 5th arg). **Already dead-lettered items recover via**: (a) restart (existing contract — Map dies with process, `inbox-deadletter.js:20-21`), or (b) new `j41-dispatcher ctl inbox-redrive [--item <id>]`, which deletes dead-letter records (fresh 5-attempt budget) without a restart. After this fix, contention never reaches the dead-letter counter — redrive is deliberate operator action, not automatic. **Corrected after audit:** do NOT claim "anything still dead-lettered is genuinely poisoned." That is only true once AUDIT FIX 4 lands (job_record network flakes are classified as transient rather than counted). Even then a dead-lettered item may be *environmentally* stuck rather than malformed — e.g. an item escalated by the bounded batch-failure counter. The `ctl inbox-redrive` help text must say "clears quarantine and grants a fresh 5-attempt budget", not "for poisoned items only".
7. **Item types:** all three handled. `job_record`'s pre-write gate stays in the dispatcher (it needs `getJobWitness` + `verifyWitness` + network policy — `inbox-job-record.js:222-283`) and runs before batching; the SDK batch never weakens it because a job_record item is simply not passed to the batch until the gate passes.

### Alerting design (Constraint from scope item 3)

- `recordInboxFailure` records gain `agentId`, `type`, `firstFailedAt` (optional meta; backward compatible).
- `buildHealthDocument` (`control.js:297`) gains a top-level `inbox` block:
  ```json
  "inbox": {
    "deadLettered": [ { "itemId": "...", "agentId": "agent-1", "type": "review", "attempts": 5, "lastError": "...", "firstFailedAt": 1753... } ],
    "retrying":     [ ...same shape with attempts < 5... ],
    "ackFailed":    [ { "itemId": "...", "agentId": "agent-1", "type": "review", "txid": "12f9...", "consecutive": 3, "lastError": "..." } ],
    "pendingWrites": [ { "agentId": "agent-1", "txid": "12f9...", "ageMs": 61000, "expiryHeight": 1167025 } ]
  }
  ```
  and `status` becomes `degraded` when `deadLettered.length > 0` (matching the existing crash-based degradation at `control.js:322-325`). The per-agent single `lastError` string (`control.js:307`) is kept for back-compat but is no longer the only surface.
- **`ackFailed` surfacing (AUDIT FIX 2).** `ackFailed` items live in neither `_inboxFailures` nor the dead-letter map, so under the earlier draft a persistently-unackable item was invisible — only a `console.warn`. Track consecutive ack failures per item (`state._inboxAckFailures`) and surface them here. Combined with the 6a already-on-chain short-circuit, a stuck ack now costs no chain writes AND is visible.
- **Stale `pendingWrites` (AUDIT FIX, minor).** `_inboxLastWrite` must be cleared/refreshed even when an agent has `pending.length === 0`, otherwise an agent whose batch confirmed and whose inbox then emptied shows a "pending write" with ever-growing `ageMs` forever. `control.js:92-96` documents health paths as versioned monitor-room API, so a permanently-stale field is a real defect, not cosmetic. Evaluate the gate once per cycle per agent regardless of pending count.
- **`state.emitEvent` integration (AUDIT FIX, minor).** The dispatcher already has a durable event surface (control-api `events.jsonl` ring buffer, wired at lifecycle points per CLAUDE.md). Emit on: dead-letter transition (`inbox.dead_lettered`), pending-write gate release by backstop (`inbox.pending_write_expired`), and batch-failure escalation (`inbox.batch_escalated`). `/health` is a snapshot; these give history.
- Control socket (`handleCommand`, `control.js:350`) gains `inbox` (returns the structured block) and `inbox-redrive` (mutates `state._inboxFailures` via the pure helper, returns `{ redriven: n }`); `ctl` command (`cli.js:7596`) gains pretty-printers and an `--item <id>` option.

---

## File Structure

**SDK (`/home/mainn/dispatchertest3/j41-sovagent-sdk`) — land first:**
- Create: `src/inbox/vdxf-gate.ts` — pure per-type gate + size budget (Task 1)
- Modify: `src/agent.ts` — refactor 3 accept methods onto the gate (Task 1); add `acceptInboxBatch` + result types (Task 2)
- Modify: `src/index.ts` — export the new module + method types (Tasks 1–2; "every new function must be added here" per SDK CLAUDE.md)
- Tests: `test/inbox-vdxf-gate.test.ts`, `test/accept-inbox-batch.test.ts`

**Dispatcher (`/home/mainn/dispatchertest3/j41-sovagent-dispatcher`) — after SDK builds:**
- Modify: `src/inbox-deadletter.js` — classify/redrive/list/gate helpers + meta (Task 3)
- Modify: `src/cli.js` — `state._inboxLastWrite` init (near `:3164`), `processInboxForAgent` + `checkPendingInbox` rewrite (`:6324-6380`), test exports (`:8291`), `ctl` additions (`:7596`) (Tasks 4–5)
- Modify: `src/control.js` — health `inbox` block + 2 command cases (Task 5)
- Tests: `test/inbox-recovery.test.js`, `test/inbox-batch-dispatch.test.js`, `test/inbox-health-surface.test.js`; existing `test/inbox-deadletter.test.js`, `test/inbox-attestation-routing.test.js`, `test/inbox-job-record.test.js` stay green untouched

---

## Task 1: SDK — pure VDXF gate module + refactor the three accept methods onto it

**Files:**
- Create: `src/inbox/vdxf-gate.ts`
- Modify: `src/agent.ts:1411-1453` (acceptReview), `:1513-1539` (acceptAttestationTuple), `:1585-1618` (acceptJobRecord)
- Modify: `src/index.ts`
- Test: `test/inbox-vdxf-gate.test.ts`

**Interfaces:**
- Consumes: `VDXF_KEYS`, `makeSubDD`, `contentmultimapValueByteSize` from `src/onboarding/vdxf.ts` (`:41`, `:134`, `:197`).
- Produces: `inboxAllowlistForType(type)`, `buildInboxVdxfAdditions(type, inboxItem, label)`, `additionsByteSize(additions)`, `MAX_BATCH_ADDITION_BYTES` — consumed by Task 2 and re-exported from `src/index.ts`.

- [ ] **Step 1: Write the failing test** — `test/inbox-vdxf-gate.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { buildInboxVdxfAdditions, inboxAllowlistForType, additionsByteSize, MAX_BATCH_ADDITION_BYTES } =
  require('../dist/inbox/vdxf-gate.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

const REVIEW = VDXF_KEYS.review.record;           // iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad
const ATTEST = VDXF_KEYS.review.attestation;      // i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv
const JOBREC = VDXF_KEYS.job.record;              // iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn
const PAYADDR = VDXF_KEYS.agent.payAddress;       // iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD

describe('inbox vdxf-gate', () => {
  it('allowlists are exact per type (52f8d07 invariant)', () => {
    assert.deepEqual([...inboxAllowlistForType('review')], [REVIEW]);
    assert.deepEqual([...inboxAllowlistForType('attestation')], [ATTEST]);
    assert.deepEqual([...inboxAllowlistForType('job_record')], [JOBREC]);
  });

  it('review: passes through review.record, wraps non-array values', () => {
    const out = buildInboxVdxfAdditions('review', { vdxfData: { [REVIEW]: 'deadbeef' } }, 'acceptReview r1');
    assert.deepEqual(out, { [REVIEW]: ['deadbeef'] });
  });

  it('review: drops payAddress and throws when nothing remains (message-compatible with H8 tests)', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: { [PAYADDR]: 'attacker' } }, 'acceptReview r2'),
      /contained no review\.\* keys after whitelist/,
    );
  });

  it('review: attestation key must NOT pass the review gate', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: { [ATTEST]: ['x'] } }, 'acceptReview r3'),
      /contained no review\.\* keys after whitelist/,
    );
  });

  it('review + attestation: null vdxfData refuses to synthesize (message-compatible)', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: null }, 'acceptReview r4'),
      /has no VDXF review\.record — refusing to synthesize/,
    );
    assert.throws(
      () => buildInboxVdxfAdditions('attestation', { vdxfData: {} }, 'acceptAttestationTuple a1'),
      /has no VDXF review\.attestation — refusing to synthesize/,
    );
  });

  it('attestation: review.record must NOT pass the attestation gate', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('attestation', { vdxfData: { [REVIEW]: ['x'] } }, 'acceptAttestationTuple a2'),
      /contained no review\.attestation keys after whitelist/,
    );
  });

  it('job_record: synthesis fallback builds a makeSubDD job.record from item fields', () => {
    const out = buildInboxVdxfAdditions(
      'job_record',
      { vdxfData: null, senderVerusId: 'buyer.vrsc@', jobHash: 'jh1', amount: 2, currency: 'VRSCTEST' },
      'acceptJobRecord j1',
    );
    const entries = out[JOBREC];
    assert.equal(entries.length, 1);
    const dd = (entries[0] as any)['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'] ?? Object.values(entries[0] as any)[0];
    const rec = JSON.parse((dd as any).objectdata.message);
    assert.equal(rec.buyer, 'buyer.vrsc@');
    assert.equal(rec.jobHash, 'jh1');
    assert.equal(rec.amount, 2);
    assert.equal(typeof rec.timestamp, 'number');
  });

  it('unsupported type throws', () => {
    assert.throws(() => buildInboxVdxfAdditions('bounty' as any, { vdxfData: {} }, 'x'), /unsupported inbox type/);
  });

  it('additionsByteSize sums value payload bytes; budget constant is 15000', () => {
    assert.equal(MAX_BATCH_ADDITION_BYTES, 15000);
    const size = additionsByteSize({ [REVIEW]: ['deadbeef'] }); // 8 hex chars = 4 bytes
    assert.equal(size, 4);
  });
});
```

Note on the synthesis assertion: the sub-DD wrapper key is `DATA_DESCRIPTOR_KEY` (see `makeSubDD`, `vdxf.ts:134-144`) — the test reads it via `Object.values(...)[0]` fallback so it doesn't hard-code the i-address; if `DATA_DESCRIPTOR_KEY` is exported from `dist/onboarding/vdxf.js`, prefer importing it and indexing directly.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-sdk && yarn build && npx tsx --test test/inbox-vdxf-gate.test.ts`
Expected: FAIL — `Cannot find module '../dist/inbox/vdxf-gate.js'`.

- [ ] **Step 3: Implement `src/inbox/vdxf-gate.ts`**

```typescript
/**
 * Per-type VDXF allowlist gate for inbox accepts — the single source of truth.
 *
 * SECURITY (audit 2026-06-02 H8 / commit 52f8d07): each inbox item type may
 * write EXACTLY its own namespace to the on-chain identity. A compromised
 * platform inbox must never smuggle e.g. agent.payAddress through any accept
 * path. Both the single-item accept methods and acceptInboxBatch call this;
 * the gates are enforced per item BEFORE any batching/merging.
 */
import { VDXF_KEYS, makeSubDD, contentmultimapValueByteSize } from '../onboarding/vdxf.js';

export type InboxAcceptType = 'review' | 'attestation' | 'job_record';

interface GateSpec {
  allowed: ReadonlySet<string>;
  namespaceLabel: string;  // used in "contained no <X> keys after whitelist"
  missingLabel: string;    // used in "has no VDXF <X> — refusing to synthesize"
  canSynthesize: boolean;
}

const GATES: Record<InboxAcceptType, GateSpec> = {
  review: {
    allowed: new Set([VDXF_KEYS.review.record]),
    namespaceLabel: 'review.*',
    missingLabel: 'review.record',
    canSynthesize: false,
  },
  attestation: {
    allowed: new Set([VDXF_KEYS.review.attestation]),
    namespaceLabel: 'review.attestation',
    missingLabel: 'review.attestation',
    canSynthesize: false,
  },
  job_record: {
    allowed: new Set(Object.values(VDXF_KEYS.job)),
    namespaceLabel: 'job.*',
    missingLabel: 'job.record',
    canSynthesize: true,
  },
};

export function inboxAllowlistForType(type: InboxAcceptType): ReadonlySet<string> {
  const gate = GATES[type];
  if (!gate) throw new Error(`unsupported inbox type '${type}'`);
  return gate.allowed;
}

export interface InboxItemLike {
  vdxfData?: Record<string, unknown> | null;
  senderVerusId?: string;
  jobHash?: string;
  [k: string]: unknown;
}

export function buildInboxVdxfAdditions(
  type: InboxAcceptType,
  inboxItem: InboxItemLike,
  label: string,
): Record<string, unknown[]> {
  const gate = GATES[type];
  if (!gate) throw new Error(`${label}: unsupported inbox type '${type}'`);

  const vdxfAdditions: Record<string, unknown[]> = {};
  const vdxfData = inboxItem.vdxfData;

  if (vdxfData && Object.keys(vdxfData).length > 0) {
    for (const [key, value] of Object.entries(vdxfData)) {
      if (value == null) continue;
      if (!gate.allowed.has(key)) {
        console.error(
          `[J41] ${label}: dropping unexpected VDXF key ${key} ` +
          `(not in ${gate.namespaceLabel} namespace) — possible platform tampering`,
        );
        continue;
      }
      vdxfAdditions[key] = Array.isArray(value) ? value : [value];
    }
    if (Object.keys(vdxfAdditions).length === 0) {
      throw new Error(`${label}: inbox vdxfData contained no ${gate.namespaceLabel} keys after whitelist`);
    }
    return vdxfAdditions;
  }

  if (!gate.canSynthesize) {
    throw new Error(
      `${label}: inbox item has no VDXF ${gate.missingLabel} — ` +
      `refusing to synthesize one (would produce an unverifiable on-chain record)`,
    );
  }

  // job_record synthesis fallback — verbatim port of agent.ts:1607-1618.
  const jobRecord: Record<string, unknown> = { timestamp: Math.floor(Date.now() / 1000) };
  if (inboxItem.senderVerusId) jobRecord.buyer = inboxItem.senderVerusId;
  if (inboxItem.jobHash) jobRecord.jobHash = inboxItem.jobHash;
  if ((inboxItem as any).amount != null) jobRecord.amount = (inboxItem as any).amount;
  if ((inboxItem as any).currency) jobRecord.currency = (inboxItem as any).currency;
  if ((inboxItem as any).completedAt) jobRecord.completedAt = (inboxItem as any).completedAt;
  return { [VDXF_KEYS.job.record]: [makeSubDD(VDXF_KEYS.job.record, JSON.stringify(jobRecord))] };
}

/** Total on-chain payload bytes of an additions map (per-value sizes summed). */
export function additionsByteSize(additions: Record<string, unknown[]>): number {
  let total = 0;
  for (const values of Object.values(additions)) {
    for (const v of values) total += contentmultimapValueByteSize(v);
  }
  return total;
}

/**
 * Conservative total-additions budget per batched identity tx. The per-value
 * cliff (~5.5KB silent truncation) is guarded by assertContentmultimapValueSizes;
 * this bounds the SUM. With one item per key and 3 inbox-writable keys the sum
 * is structurally ≤ 3 × 5000; the constant is a belt-and-braces invariant that
 * also covers future key growth. Items over budget are deferred, never dropped.
 */
export const MAX_BATCH_ADDITION_BYTES = 15000;
```

- [ ] **Step 4: Refactor the three accept methods onto the gate.**

In `src/agent.ts` add the import (near the existing `./onboarding/vdxf.js` import):

```typescript
import { buildInboxVdxfAdditions } from './inbox/vdxf-gate.js';
```

`acceptReview` — replace lines 1411-1453 (from `const reviewKeys = VDXF_KEYS.review;` through the closing of the synthesize-refusal `else` block) with:

```typescript
      // 3. Per-type allowlist gate (audit H8 / 52f8d07) — single source of
      // truth shared with acceptInboxBatch. See src/inbox/vdxf-gate.ts.
      const vdxfAdditions = buildInboxVdxfAdditions('review', inboxItem, `acceptReview ${inboxId}`);
```

`acceptAttestationTuple` — replace lines 1513-1539 (the `vdxfAdditions` declaration through the synthesize-refusal `else`) with:

```typescript
      const vdxfAdditions = buildInboxVdxfAdditions('attestation', inboxItem, `acceptAttestationTuple ${inboxId}`);
```

`acceptJobRecord` — replace lines 1585-1618 (the `vdxfAdditions` declaration through the synthesis fallback) with:

```typescript
      const vdxfAdditions = buildInboxVdxfAdditions('job_record', inboxItem, `acceptJobRecord ${inboxId}`);
```

(If `VDXF_KEYS` / `makeSubDD` become unused in `agent.ts` after this, remove only if `npx tsc --noEmit` confirms no other use — `agent.ts` uses them elsewhere, e.g. registration.)

In `src/index.ts` add:

```typescript
export {
  buildInboxVdxfAdditions,
  inboxAllowlistForType,
  additionsByteSize,
  MAX_BATCH_ADDITION_BYTES,
  type InboxAcceptType,
} from './inbox/vdxf-gate.js';
```

- [ ] **Step 5: Verify — new tests pass AND the pinned gate tests still pass (the 52f8d07 regression proof)**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-sdk && npx tsc --noEmit && yarn build && npx tsx --test test/inbox-vdxf-gate.test.ts test/accept-review-path.test.ts test/accept-attestation.test.ts`
Expected: all PASS (accept-review-path pins `/contained no review\.\* keys after whitelist/`, `/has no VDXF review\.record — refusing to synthesize/`, and the attestation-key-dropped case at `test/accept-review-path.test.ts:103-112`; accept-attestation pins its two messages at `:32,42`).

Then the full suite: `yarn test` → 312 + 9 new = expect 321 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-sdk
git add src/inbox/vdxf-gate.ts src/agent.ts src/index.ts test/inbox-vdxf-gate.test.ts
git commit -m "refactor(sdk): extract per-type inbox VDXF allowlist gate (single source of truth, 52f8d07 preserved)"
```

---

## Task 2: SDK — `J41Agent.acceptInboxBatch()`

**Files:**
- Modify: `src/agent.ts` (new method after `acceptJobRecord`, ~line 1641; new exported interfaces near the top-level exports)
- Modify: `src/index.ts` (export the two result types)
- Test: `test/accept-inbox-batch.test.ts`

**Interfaces:**
- Consumes: `buildInboxVdxfAdditions`, `additionsByteSize`, `MAX_BATCH_ADDITION_BYTES` (Task 1); `buildIdentityUpdateTx` (`update.ts:71`), `assertContentmultimapValueSizes` (`vdxf.ts:218`), `computeExpiryHeight` (`agent.ts:47`), `IDENTITY_EXPIRY_DELTA` (`update.ts:18`) — all already imported/available in `agent.ts`.
- Produces: `agent.acceptInboxBatch(items, opts?) → Promise<InboxBatchResult>` with the exact result shape in the Design section — Task 4 consumes it verbatim.

- [ ] **Step 1: Write the failing test** — `test/accept-inbox-batch.test.ts` (mock-client pattern copied from `test/accept-review-path.test.ts:17-41`):

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

const REVIEW = VDXF_KEYS.review.record;
const ATTEST = VDXF_KEYS.review.attestation;
const PAYADDR = VDXF_KEYS.agent.payAddress;

// inboxItems: Record<id, item-detail>. Sentinel at buildIdentityUpdateTx stage is
// approximated by intercepting broadcast (batch builds a REAL signed tx offline —
// same as accept-review-path's approach of stubbing only the client).
function makeAgent(inboxItems: Record<string, any>, opts: { failAckFor?: string[]; failBroadcast?: string } = {}) {
  const kp = generateKeypair('verustest');
  const agent = new J41Agent({
    apiUrl: 'https://api.example.com',
    wif: kp.wif,
    iAddress: 'iAgentTestAddr000000000000000000000',
    identityName: 'batchtest.agentplatform@',
  });
  const calls = { broadcast: 0, acks: [] as any[], builtCmm: null as any };
  agent.client.getInboxItem = async (id: string) => {
    if (!(id in inboxItems)) throw new Error(`404 no such item ${id}`);
    return { data: inboxItems[id] };
  };
  agent.client.getIdentityRaw = async () => ({
    data: {
      identity: {
        version: 3, flags: 0, minimumsignatures: 1,
        primaryaddresses: [kp.address],
        parent: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
        name: 'batchtest', contentmap: {}, contentmultimap: {},
        revocationauthority: 'iAgentTestAddr000000000000000000000',
        recoveryauthority: 'iAgentTestAddr000000000000000000000',
        systemid: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
      },
      prevOutput: { txid: 'aa'.repeat(32), vout: 0, scriptHex: '76a914' + '00'.repeat(20) + '88ac', value: 0 },
      blockHeight: 100, txid: 'aa'.repeat(32),
    },
  });
  agent.client.getUtxos = async () => ({
    utxos: [{ txid: 'bb'.repeat(32), vout: 0, outputIndex: 0, satoshis: 100000, address: kp.address }],
  });
  agent.client.getChainInfo = async () => ({ blockHeight: 100 });
  agent.client.broadcast = async () => {
    calls.broadcast++;
    if (opts.failBroadcast) throw new Error(opts.failBroadcast);
    return { txid: 'feedc0de'.repeat(8) };
  };
  agent.client.acceptInboxItem = async (id: string, txid: string) => {
    if (opts.failAckFor?.includes(id)) throw new Error(`ack boom ${id}`);
    calls.acks.push({ id, txid });
    return { data: { success: true, status: 'accepted' } };
  };
  return { agent, calls, kp };
}

const rev = (id: string, key = REVIEW) => ({
  id, status: 'pending', senderVerusId: 'buyer.vrsc@', jobHash: `jh-${id}`,
  vdxfData: { [key]: ['deadbeef'] },
});
const att = (id: string) => ({
  id, status: 'pending', senderVerusId: 'buyer.vrsc@', jobHash: `jh-${id}`,
  vdxfData: { [ATTEST]: ['cafebabe'] },
});

describe('acceptInboxBatch', () => {
  it('batches review + attestation into ONE broadcast and acks both with the same txid', async () => {
    const { agent, calls } = makeAgent({ r1: rev('r1'), a1: att('a1') });
    const res = await agent.acceptInboxBatch([{ id: 'a1', type: 'attestation' }, { id: 'r1', type: 'review' }]);
    assert.equal(calls.broadcast, 1, 'exactly one identity update tx');
    assert.equal(res.txid, 'feedc0de'.repeat(8));
    assert.deepEqual(res.acked.sort(), ['a1', 'r1']);
    assert.equal(calls.acks.length, 2);
    assert.ok(calls.acks.every((a: any) => a.txid === res.txid), 'both acks carry the shared txid');
    assert.deepEqual(res.rejected, []);
    assert.deepEqual(res.deferred, []);
  });

  it('poisoned item is rejected individually; the healthy item still writes (no all-or-nothing)', async () => {
    // r-bad carries ONLY a payAddress key — the H8 gate must reject it without
    // sinking a1. This is the single most important assertion in the plan.
    const { agent, calls } = makeAgent({ rbad: rev('rbad', PAYADDR), a1: att('a1') });
    const res = await agent.acceptInboxBatch([{ id: 'rbad', type: 'review' }, { id: 'a1', type: 'attestation' }]);
    assert.equal(calls.broadcast, 1);
    assert.deepEqual(res.acked, ['a1']);
    assert.equal(res.rejected.length, 1);
    assert.equal(res.rejected[0].id, 'rbad');
    assert.match(res.rejected[0].error, /contained no review\.\* keys after whitelist/);
  });

  it('cross-namespace smuggling: attestation key on a review item never reaches the tx', async () => {
    const { agent, calls } = makeAgent({ r1: rev('r1', ATTEST) });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.equal(calls.broadcast, 0, 'nothing mergeable — no tx at all');
    assert.equal(res.txid, null);
    assert.equal(res.rejected[0].id, 'r1');
  });

  it('same-key collision defers the second item (preserves replace-per-write semantics)', async () => {
    const { agent, calls } = makeAgent({ r1: rev('r1'), r2: rev('r2') });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'r2', type: 'review' }]);
    assert.equal(calls.broadcast, 1);
    assert.deepEqual(res.acked, ['r1']);
    assert.deepEqual(res.deferred, [{ id: 'r2', type: 'review', reason: 'key-collision' }]);
  });

  it('size budget defers, does not drop', async () => {
    const { agent } = makeAgent({ r1: rev('r1'), a1: att('a1') });
    const res = await agent.acceptInboxBatch(
      [{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }],
      { maxAdditionBytes: 5 }, // r1 = 4 bytes fits; a1 would exceed
    );
    assert.deepEqual(res.acked, ['r1']);
    assert.deepEqual(res.deferred, [{ id: 'a1', type: 'attestation', reason: 'size-budget' }]);
  });

  it('ack failure is reported per item, does not throw, and the other ack still lands', async () => {
    const { agent } = makeAgent({ r1: rev('r1'), a1: att('a1') }, { failAckFor: ['r1'] });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }]);
    assert.equal(res.txid, 'feedc0de'.repeat(8));
    assert.deepEqual(res.acked, ['a1']);
    assert.equal(res.ackFailed.length, 1);
    assert.equal(res.ackFailed[0].id, 'r1');
    assert.match(res.ackFailed[0].error, /ack boom/);
  });

  it('non-pending items are alreadyDone; getInboxItem failure defers; neither reaches the tx', async () => {
    const { agent, calls } = makeAgent({ r1: { ...rev('r1'), status: 'accepted' } });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'ghost', type: 'review' }]);
    assert.equal(calls.broadcast, 0);
    assert.deepEqual(res.alreadyDone, ['r1']);
    assert.equal(res.deferred.length, 1);
    assert.equal(res.deferred[0].id, 'ghost');
    assert.match(res.deferred[0].reason, /getInboxItem failed/);
  });

  it('broadcast failure throws (batch-level) and NO items are acked', async () => {
    const { agent, calls } = makeAgent({ r1: rev('r1') }, { failBroadcast: 'Transaction rejected by the network' });
    await assert.rejects(
      agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]),
      /Transaction rejected by the network/,
    );
    assert.equal(calls.acks.length, 0, 'never ack an item whose tx did not broadcast');
  });

  it('emits the existing per-type events with { inboxId, txid }', async () => {
    const { agent } = makeAgent({ r1: rev('r1'), a1: att('a1') });
    const events: any[] = [];
    agent.on('review:accepted', (e: any) => events.push(['review', e]));
    agent.on('attestation:accepted', (e: any) => events.push(['attestation', e]));
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }]);
    assert.equal(events.length, 2);
    assert.ok(events.every(([, e]) => e.txid === res.txid && typeof e.inboxId === 'string'));
  });
});
```

> **Fixture note:** unlike `accept-review-path.test.ts` (which aborts at a `getChainInfo` sentinel before tx build), these tests run `buildIdentityUpdateTx` for real, so the mocked `getIdentityRaw` must satisfy its checks: `prevOutput` present (`update.ts:89`), signing key ∈ `primaryaddresses` (`update.ts:153-156` — hence `primaryaddresses: [kp.address]`), spendable R-address UTXO (`update.ts:165-168`). If `Identity.fromJson` (`update.ts:139`) rejects any placeholder field (e.g. the parent/authority i-addresses), adjust the fixture to a shape `Identity.fromJson` accepts — determine empirically at Step 2; the assertions above do not depend on the fixture details.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-sdk && yarn build && npx tsx --test test/accept-inbox-batch.test.ts`
Expected: FAIL — `agent.acceptInboxBatch is not a function`. (If instead fixture errors appear after implementation in Step 4, fix the fixture per the note, not the assertions.)

- [ ] **Step 3: Implement** — in `src/agent.ts`, imports:

```typescript
import { buildInboxVdxfAdditions, additionsByteSize, MAX_BATCH_ADDITION_BYTES, type InboxAcceptType } from './inbox/vdxf-gate.js';
import { assertContentmultimapValueSizes } from './onboarding/vdxf.js'; // if not already imported
```

Exported types (top level of `agent.ts`):

```typescript
export interface InboxBatchItemRef { id: string; type: InboxAcceptType; }

export interface InboxBatchResult {
  txid: string | null;
  written: InboxBatchItemRef[];
  acked: string[];
  ackFailed: Array<{ id: string; error: string }>;
  rejected: Array<{ id: string; type: string; error: string }>;
  deferred: Array<{ id: string; type: string; reason: string }>;
  alreadyDone: string[];
}
```

Method (after `acceptJobRecord`, ~line 1641):

```typescript
  /**
   * Accept MANY pending inbox items in ONE updateidentity transaction.
   *
   * Why: each identity update spends the identity's prevOutput. Two accepts in
   * one poll cycle double-spend the same confirmed prevOutput (the second tx is
   * "rejected by the network" until the first confirms). Batching means at most
   * one identity write per agent per cycle.
   *
   * Per-item independence: every item is validated by its OWN type gate
   * (vdxf-gate.ts — the 52f8d07 allowlists) BEFORE merging; poisoned items go
   * to `rejected` without sinking the batch. One item per VDXF key per batch
   * (buildIdentityUpdateTx REPLACES keys — update.ts:117-120); collisions and
   * size-budget overflow go to `deferred` for the next cycle.
   *
   * Batch-level failures (identity fetch, no UTXOs, build, broadcast) THROW —
   * they are environmental, not item-specific; callers must not count them
   * against per-item retry budgets.
   */
  async acceptInboxBatch(
    items: InboxBatchItemRef[],
    opts: { maxAdditionBytes?: number } = {},
  ): Promise<InboxBatchResult> {
    if (!this.wif || !this.iAddress) {
      throw new Error('Cannot accept inbox batch: WIF key and i-address required');
    }
    const maxBytes = opts.maxAdditionBytes ?? MAX_BATCH_ADDITION_BYTES;
    const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const result: InboxBatchResult = {
      txid: null, written: [], acked: [], ackFailed: [], rejected: [], deferred: [], alreadyDone: [],
    };

    const merged: Record<string, unknown[]> = {};
    const included: InboxBatchItemRef[] = [];
    let totalBytes = 0;

    for (const ref of items) {
      let inboxItem;
      try {
        ({ data: inboxItem } = await this._client.getInboxItem(ref.id));
      } catch (err) {
        result.deferred.push({ id: ref.id, type: ref.type, reason: `getInboxItem failed: ${errMsg(err)}` });
        continue;
      }
      if (inboxItem.status !== 'pending') {
        console.log(`[J41] Inbox item ${ref.id} already ${inboxItem.status}, skipping`);
        result.alreadyDone.push(ref.id);
        continue;
      }

      let additions: Record<string, unknown[]>;
      try {
        additions = buildInboxVdxfAdditions(ref.type, inboxItem, `acceptInboxBatch ${ref.id}`);
        assertContentmultimapValueSizes(additions); // oversize single value can NEVER fit → hard
      } catch (err) {
        result.rejected.push({ id: ref.id, type: ref.type, error: errMsg(err) });
        continue;
      }

      if (Object.keys(additions).some((k) => k in merged)) {
        result.deferred.push({ id: ref.id, type: ref.type, reason: 'key-collision' });
        continue;
      }
      const bytes = additionsByteSize(additions);
      if (totalBytes + bytes > maxBytes) {
        result.deferred.push({ id: ref.id, type: ref.type, reason: 'size-budget' });
        continue;
      }

      for (const [k, v] of Object.entries(additions)) merged[k] = v;
      totalBytes += bytes;
      included.push(ref);
    }

    if (included.length === 0) return result;

    const [{ data: identityData }, utxoData] = await Promise.all([
      this._client.getIdentityRaw(),
      this._client.getUtxos(),
    ]);
    if (!identityData.prevOutput) {
      throw new Error('Cannot accept inbox batch: identity previous output not found — identity may not be on-chain yet');
    }
    if (!utxoData.utxos || utxoData.utxos.length === 0) {
      throw new Error('Cannot accept inbox batch: no UTXOs available for TX fee — fund the agent wallet');
    }

    console.log(`[J41] Building batched identity update (${included.length} inbox item(s), ${Object.keys(merged).length} VDXF key(s))...`);
    const { blockHeight: _tip } = await this._client.getChainInfo();
    const signedTxHex = buildIdentityUpdateTx({
      wif: this.wif,
      identityData,
      utxos: utxoData.utxos,
      vdxfAdditions: merged,
      network: this.networkType,
      expiryHeight: computeExpiryHeight(_tip, IDENTITY_EXPIRY_DELTA),
    });

    const broadcastResult = await this._client.broadcast(signedTxHex);
    result.txid = broadcastResult.txid;
    result.written = included;
    console.log(`[J41] ✅ Inbox batch written on-chain: ${broadcastResult.txid} (${included.length} item(s))`);

    for (const ref of included) {
      try {
        await this._client.acceptInboxItem(ref.id, broadcastResult.txid);
        result.acked.push(ref.id);
        const evt = ref.type === 'review' ? 'review:accepted'
          : ref.type === 'attestation' ? 'attestation:accepted'
          : 'job_record:accepted';
        this.emit(evt, { inboxId: ref.id, txid: broadcastResult.txid });
      } catch (err) {
        result.ackFailed.push({ id: ref.id, error: errMsg(err) });
        console.error(`[J41] Inbox batch: on-chain write succeeded but backend ack failed for ${ref.id}: ${errMsg(err)} — item stays pending and will re-run`);
      }
    }
    return result;
  }
```

In `src/index.ts`, extend the agent export line (`src/index.ts:9`) to also export `type InboxBatchItemRef, type InboxBatchResult`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-sdk && npx tsc --noEmit && yarn build && npx tsx --test test/accept-inbox-batch.test.ts`
Expected: 9 tests PASS. Then full suite `yarn test` → expect 330 pass (321 + 9), 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-sdk
git add src/agent.ts src/index.ts test/accept-inbox-batch.test.ts
git commit -m "feat(sdk): acceptInboxBatch — one identity update tx for all pending inbox items"
```

---

## Task 3: Dispatcher — recovery + redrive + surfacing helpers in `src/inbox-deadletter.js`

**Files:**
- Modify: `src/inbox-deadletter.js`
- Test: `test/inbox-recovery.test.js` (new; `test/inbox-deadletter.test.js` stays untouched and must stay green)

**Interfaces:**
- Produces (all pure, consumed by Tasks 4–5):
  - `classifyInboxFailure(err) → 'contention' | 'hard'`
  - `recordInboxFailure(failures, itemId, errorMessage, maxAttempts?, meta?)` — meta `{ agentId, type }` stored on the record (back-compat: existing 3/4-arg callers unchanged)
  - `redriveDeadLetters(failures, itemId = null) → number`
  - `listInboxFailures(failures) → { deadLettered: [...], retrying: [...] }`
  - `shouldDeferForPendingWrite(lastWrite, currentPrevTxid, now, maxWaitMs?) → { defer, confirmed, expired, reason? }`
  - `PENDING_WRITE_MAX_WAIT_MS = 30 * 60 * 1000`

- [ ] **Step 1: Write the failing test** — `test/inbox-recovery.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_INBOX_ATTEMPTS,
  recordInboxFailure,
  classifyInboxFailure,
  redriveDeadLetters,
  listInboxFailures,
  shouldDeferForPendingWrite,
  PENDING_WRITE_MAX_WAIT_MS,
} = require('../src/inbox-deadletter.js');

test('classify: the observed mempool double-spend rejection is contention', () => {
  assert.equal(classifyInboxFailure(new Error('Transaction rejected by the network')), 'contention');
  assert.equal(classifyInboxFailure(new Error('transaction REJECTED by the network (code -26)')), 'contention');
});

test('classify: everything else is hard (fail-closed default)', () => {
  assert.equal(classifyInboxFailure(new Error('inbox vdxfData contained no review.* keys after whitelist')), 'hard');
  assert.equal(classifyInboxFailure(new Error('no UTXOs available for TX fee')), 'hard');
  assert.equal(classifyInboxFailure(null), 'hard');
  assert.equal(classifyInboxFailure('string error'), 'hard');
});

test('recordInboxFailure stores optional meta and keeps it across attempts', () => {
  const failures = new Map();
  recordInboxFailure(failures, 'i1', 'boom', undefined, { agentId: 'agent-1', type: 'review' });
  recordInboxFailure(failures, 'i1', 'boom2'); // meta omitted on later attempt — must persist
  const rec = failures.get('i1');
  assert.equal(rec.attempts, 2);
  assert.equal(rec.agentId, 'agent-1');
  assert.equal(rec.type, 'review');
  assert.equal(typeof rec.firstFailedAt, 'number');
});

test('recordInboxFailure without meta is unchanged (back-compat)', () => {
  const failures = new Map();
  const r = recordInboxFailure(failures, 'i2', 'x');
  assert.deepEqual({ attempts: r.attempts, deadLettered: r.deadLettered, justDeadLettered: r.justDeadLettered },
    { attempts: 1, deadLettered: false, justDeadLettered: false });
});

test('redrive clears only dead-lettered entries; attempts restart fresh', () => {
  const failures = new Map();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) recordInboxFailure(failures, 'dead', 'e');
  recordInboxFailure(failures, 'retrying', 'e');
  assert.equal(redriveDeadLetters(failures), 1);          // clears 'dead' only
  assert.equal(failures.has('dead'), false);
  assert.equal(failures.get('retrying').attempts, 1);     // untouched
  const r = recordInboxFailure(failures, 'dead', 'again');
  assert.equal(r.attempts, 1);                            // fresh budget
});

test('redrive by specific id: 1 when dead-lettered, 0 otherwise', () => {
  const failures = new Map();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) recordInboxFailure(failures, 'dead', 'e');
  recordInboxFailure(failures, 'live', 'e');
  assert.equal(redriveDeadLetters(failures, 'live'), 0);
  assert.equal(redriveDeadLetters(failures, 'nope'), 0);
  assert.equal(redriveDeadLetters(failures, 'dead'), 1);
});

test('listInboxFailures splits retrying vs deadLettered, non-lossy', () => {
  const failures = new Map();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) recordInboxFailure(failures, 'd1', 'sig bad', undefined, { agentId: 'a1', type: 'review' });
  recordInboxFailure(failures, 'r1', 'flake', undefined, { agentId: 'a2', type: 'job_record' });
  const view = listInboxFailures(failures);
  assert.equal(view.deadLettered.length, 1);
  assert.equal(view.retrying.length, 1);
  assert.deepEqual(
    { itemId: view.deadLettered[0].itemId, agentId: view.deadLettered[0].agentId, type: view.deadLettered[0].type, attempts: view.deadLettered[0].attempts },
    { itemId: 'd1', agentId: 'a1', type: 'review', attempts: MAX_INBOX_ATTEMPTS },
  );
  assert.equal(view.deadLettered[0].lastError, 'sig bad');
});

test('pending-write gate: defer while unconfirmed, confirm on prevOutput match, expire after maxWait', () => {
  const now = 1_000_000;
  const lw = { txid: 'newtx', at: now - 60_000 };
  assert.equal(shouldDeferForPendingWrite(null, 'x', now).defer, false);
  const defer = shouldDeferForPendingWrite(lw, 'oldtx', now);
  assert.equal(defer.defer, true);
  const confirmed = shouldDeferForPendingWrite(lw, 'newtx', now);
  assert.deepEqual({ defer: confirmed.defer, confirmed: confirmed.confirmed }, { defer: false, confirmed: true });
  const expired = shouldDeferForPendingWrite(lw, 'oldtx', now + PENDING_WRITE_MAX_WAIT_MS);
  assert.deepEqual({ defer: expired.defer, expired: expired.expired }, { defer: false, expired: true });
});

test('pending-write gate: unknown current state (null prevTxid) defers conservatively', () => {
  const r = shouldDeferForPendingWrite({ txid: 't', at: 0 }, null, 1000);
  assert.equal(r.defer, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && node --test test/inbox-recovery.test.js`
Expected: FAIL — `classifyInboxFailure is not a function` (undefined export).

- [ ] **Step 3: Implement** — in `src/inbox-deadletter.js`:

Replace `recordInboxFailure` (`:39-46`) with:

```javascript
function recordInboxFailure(failures, itemId, errorMessage, maxAttempts = MAX_INBOX_ATTEMPTS, meta = null) {
  const prev = failures.get(itemId) || { attempts: 0, deadLettered: false };
  const attempts = prev.attempts + 1;
  const deadLettered = prev.deadLettered || attempts >= maxAttempts;
  const justDeadLettered = deadLettered && !prev.deadLettered;
  const rec = {
    attempts,
    deadLettered,
    lastError: String(errorMessage || '').slice(0, 300),
    firstFailedAt: prev.firstFailedAt || Date.now(),
    agentId: (meta && meta.agentId) || prev.agentId || null,
    type: (meta && meta.type) || prev.type || null,
  };
  failures.set(itemId, rec);
  return { attempts, deadLettered, justDeadLettered };
}
```

Append before `module.exports`:

```javascript
// ── Recovery / surfacing (2026-07-29 batched-identity-update) ────────────────

// Chain-contention detection. The ONLY live-observed signature of the
// mempool double-spend (second identity tx built against a prevOutput already
// spent by an unconfirmed tx) is the backend broadcast error
// "Transaction rejected by the network". Contention is transient by
// definition — it self-heals when the first tx confirms — so it must never
// burn the dead-letter budget. Fail-closed: anything unrecognized is 'hard'.
// (Open question tracked in the plan: backend does not expose a stable
// machine code for this yet — pattern-match the message until it does.)
const CONTENTION_PATTERNS = [/rejected by the network/i];

function classifyInboxFailure(err) {
  const msg = String((err && err.message) || err || '');
  return CONTENTION_PATTERNS.some((re) => re.test(msg)) ? 'contention' : 'hard';
}

/**
 * Operator redrive: delete dead-letter records so the item(s) get a fresh
 * retry budget WITHOUT a dispatcher restart. itemId=null redrives all.
 * Never touches still-retrying records. Returns the count redriven.
 */
function redriveDeadLetters(failures, itemId = null) {
  let n = 0;
  for (const [id, rec] of [...failures.entries()]) {
    if (!rec.deadLettered) continue;
    if (itemId && id !== itemId) continue;
    failures.delete(id);
    n++;
  }
  return n;
}

/** Non-lossy structured view for /health and `ctl inbox`. */
function listInboxFailures(failures) {
  const deadLettered = [];
  const retrying = [];
  for (const [itemId, rec] of failures.entries()) {
    const entry = {
      itemId,
      agentId: rec.agentId || null,
      type: rec.type || null,
      attempts: rec.attempts,
      lastError: rec.lastError || null,
      firstFailedAt: rec.firstFailedAt || null,
    };
    (rec.deadLettered ? deadLettered : retrying).push(entry);
  }
  return { deadLettered, retrying };
}

// After a batch broadcast, the platform keeps serving the last CONFIRMED
// prevOutput until the tx mines. Building another identity tx before then is
// a guaranteed double-spend. Gate: defer the agent's inbox work until the
// confirmed prevOutput.txid equals our last broadcast txid. Expiry stops a
// never-confirming tx (expiryHeight = tip+200) from wedging the agent forever.
const PENDING_WRITE_MAX_WAIT_MS = 30 * 60 * 1000;

function shouldDeferForPendingWrite(lastWrite, currentPrevTxid, now, maxWaitMs = PENDING_WRITE_MAX_WAIT_MS) {
  if (!lastWrite || !lastWrite.txid) return { defer: false, confirmed: false, expired: false };
  if (currentPrevTxid === lastWrite.txid) return { defer: false, confirmed: true, expired: false };
  if (now - lastWrite.at >= maxWaitMs) return { defer: false, confirmed: false, expired: true };
  return {
    defer: true, confirmed: false, expired: false,
    reason: currentPrevTxid
      ? `identity tx ${lastWrite.txid} unconfirmed (confirmed prevOutput still ${currentPrevTxid})`
      : `identity state unavailable — assuming ${lastWrite.txid} unconfirmed`,
  };
}
```

Extend `module.exports` with the five new names + `PENDING_WRITE_MAX_WAIT_MS`.

- [ ] **Step 4: Run to verify it passes (including the untouched legacy suite)**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && node --check src/inbox-deadletter.js && node --test test/inbox-recovery.test.js test/inbox-deadletter.test.js`
Expected: 10 new + 6 legacy tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher
git add src/inbox-deadletter.js test/inbox-recovery.test.js
git commit -m "feat(dispatcher): inbox recovery primitives — contention classifier, redrive, structured failure view, pending-write gate"
```

---

## Task 4: Dispatcher — `processInboxForAgent` + `checkPendingInbox` rewrite (batch orchestration)

**Files:**
- Modify: `src/cli.js` — `_inboxLastWrite` init next to `_inboxFailures` (`:3164`); new `processInboxForAgent` + `noteInboxFailure` above `checkPendingInbox` (`:6324`); rewrite the per-agent body of `checkPendingInbox`; extend test exports (`:8291`)
- Test: `test/inbox-batch-dispatch.test.js` (new); `test/inbox-attestation-routing.test.js` + `test/inbox-job-record.test.js` stay green (legacy path + gate untouched)

**Interfaces:**
- Consumes: Task 2's `agent.acceptInboxBatch(items) → InboxBatchResult` (exact shape from Task 2 Step 3); Task 3's helpers; existing `dispatchInboxAccept` (`cli.js:6289`, kept as the legacy fallback), `verifyInboxJobRecord` (`inbox-job-record.js:222`), `getAgentSession` test seam `state._testAgentSession` (`cli.js:4318`).
- Produces: `processInboxForAgent(agent, agentInfo, pending, state, deps)` exported for tests; `state._inboxLastWrite: Map<agentId, { txid, at }>` consumed by Task 5's health surface.

- [ ] **Step 1: Write the failing test** — `test/inbox-batch-dispatch.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { processInboxForAgent } = require('../src/cli.js');
const { MAX_INBOX_ATTEMPTS, recordInboxFailure } = require('../src/inbox-deadletter.js');

function makeState() {
  return { _inboxFailures: new Map(), _inboxLastWrite: new Map(), _agentErrors: new Map(), agentSessions: new Map() };
}
const agentInfo = { id: 'agent-1', identity: 'a1@', iAddress: 'iA1', wif: 'w' };
const deps = { verifyInboxJobRecord: async () => undefined, verifyWitness: async () => ({ verified: true }), network: 'verustest' };

function batchAgent(result, { onBatch, prevTxid = 'confirmed-tx' } = {}) {
  return {
    calls: { batches: [], identityRaw: 0 },
    acceptInboxBatch: async function (items) { this.calls.batches.push(items); if (onBatch) return onBatch(items); return result; },
    client: {
      getIdentityRaw: async function () { return { data: { prevOutput: { txid: prevTxid } } }; },
      getInboxItem: async () => ({ data: { vdxfData: {}, jobDetails: { id: 'job-1' } } }),
      getJobWitness: async () => ({ record: {}, witness: {} }),
    },
  };
}
const emptyResult = (over = {}) => ({ txid: null, written: [], acked: [], ackFailed: [], rejected: [], deferred: [], alreadyDone: [], ...over });

test('batched path: one acceptInboxBatch call with all eligible items; acked items are cleared; txid recorded in _inboxLastWrite', async () => {
  const state = makeState();
  recordInboxFailure(state._inboxFailures, 'r1', 'earlier flake'); // prior failure must clear on success
  const agent = batchAgent(emptyResult({ txid: 'tx-1', written: [{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }], acked: ['r1', 'a1'] }));
  await processInboxForAgent(agent, agentInfo, [{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }], state, deps);
  assert.equal(agent.calls.batches.length, 1);
  assert.deepEqual(agent.calls.batches[0], [{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }]);
  assert.equal(state._inboxFailures.has('r1'), false);
  assert.deepEqual(state._inboxLastWrite.get('agent-1').txid, 'tx-1');
});

test('rejected items are dead-letter-counted with meta; deferred and ackFailed are neither counted nor cleared', async () => {
  const state = makeState();
  recordInboxFailure(state._inboxFailures, 'ack1', 'prior');
  const agent = batchAgent(emptyResult({
    txid: 'tx-2',
    written: [{ id: 'ack1', type: 'review' }],
    acked: [],
    ackFailed: [{ id: 'ack1', error: 'ack boom' }],
    rejected: [{ id: 'bad1', type: 'review', error: 'contained no review.* keys after whitelist' }],
    deferred: [{ id: 'd1', type: 'review', reason: 'key-collision' }],
  }));
  await processInboxForAgent(agent, agentInfo,
    [{ id: 'ack1', type: 'review' }, { id: 'bad1', type: 'review' }, { id: 'd1', type: 'review' }], state, deps);
  const bad = state._inboxFailures.get('bad1');
  assert.equal(bad.attempts, 1);
  assert.equal(bad.agentId, 'agent-1');
  assert.equal(bad.type, 'review');
  assert.equal(state._inboxFailures.get('ack1').attempts, 1, 'ackFailed not counted');
  assert.equal(state._inboxFailures.has('d1'), false, 'deferred not counted');
});

test('batch-level contention throw: nothing counted, lastError set, no crash', async () => {
  const state = makeState();
  const agent = batchAgent(null, { onBatch: () => { throw new Error('Transaction rejected by the network'); } });
  await processInboxForAgent(agent, agentInfo, [{ id: 'r1', type: 'review' }], state, deps);
  assert.equal(state._inboxFailures.size, 0, 'contention must not burn retry budget');
  assert.match(state._agentErrors.get('agent-1'), /contention/);
});

test('batch-level environmental throw (no UTXOs): also not counted per item', async () => {
  const state = makeState();
  const agent = batchAgent(null, { onBatch: () => { throw new Error('no UTXOs available for TX fee — fund the agent wallet'); } });
  await processInboxForAgent(agent, agentInfo, [{ id: 'r1', type: 'review' }], state, deps);
  assert.equal(state._inboxFailures.size, 0);
  assert.match(state._agentErrors.get('agent-1'), /inbox batch/);
});

test('pending-write gate: unconfirmed last write defers the whole agent (no batch call)', async () => {
  const state = makeState();
  state._inboxLastWrite.set('agent-1', { txid: 'tx-unconfirmed', at: Date.now() });
  const agent = batchAgent(emptyResult(), { prevTxid: 'some-older-tx' });
  await processInboxForAgent(agent, agentInfo, [{ id: 'r1', type: 'review' }], state, deps);
  assert.equal(agent.calls.batches.length, 0);
  assert.equal(state._inboxLastWrite.has('agent-1'), true, 'gate persists until confirmed/expired');
});

test('pending-write gate: confirmed prevOutput clears the gate and processing proceeds', async () => {
  const state = makeState();
  state._inboxLastWrite.set('agent-1', { txid: 'tx-confirmed', at: Date.now() - 61000 });
  const agent = batchAgent(emptyResult({ txid: 'tx-next', written: [{ id: 'r1', type: 'review' }], acked: ['r1'] }), { prevTxid: 'tx-confirmed' });
  await processInboxForAgent(agent, agentInfo, [{ id: 'r1', type: 'review' }], state, deps);
  assert.equal(agent.calls.batches.length, 1);
  assert.equal(state._inboxLastWrite.get('agent-1').txid, 'tx-next');
});

test('dead-lettered items are excluded from the batch', async () => {
  const state = makeState();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) recordInboxFailure(state._inboxFailures, 'dead1', 'poison');
  const agent = batchAgent(emptyResult({ txid: 't', written: [{ id: 'r1', type: 'review' }], acked: ['r1'] }));
  await processInboxForAgent(agent, agentInfo, [{ id: 'dead1', type: 'review' }, { id: 'r1', type: 'review' }], state, deps);
  assert.deepEqual(agent.calls.batches[0], [{ id: 'r1', type: 'review' }]);
});

test('job_record verify-gate skip excludes item (uncounted, uncleared); verify-gate throw counts that item only', async () => {
  const state = makeState();
  const agent = batchAgent(emptyResult({ txid: 't', written: [{ id: 'r1', type: 'review' }], acked: ['r1'] }));
  const gateDeps = {
    ...deps,
    verifyInboxJobRecord: async ({ inboxItemDetail }) =>
      inboxItemDetail.jobDetails.id === 'skip-me' ? { skip: true, reason: '409' } : (() => { throw new Error('cross-check FAILED'); })(),
  };
  agent.client.getInboxItem = async (id) => ({ data: { vdxfData: {}, jobDetails: { id: id === 'j-skip' ? 'skip-me' : 'throw-me' } } });
  await processInboxForAgent(agent, agentInfo,
    [{ id: 'j-skip', type: 'job_record' }, { id: 'j-throw', type: 'job_record' }, { id: 'r1', type: 'review' }], state, gateDeps);
  assert.deepEqual(agent.calls.batches[0], [{ id: 'r1', type: 'review' }], 'both job_records excluded from batch');
  assert.equal(state._inboxFailures.has('j-skip'), false);
  assert.equal(state._inboxFailures.get('j-throw').attempts, 1);
});

test('legacy fallback (SDK without acceptInboxBatch): per-item dispatch; contention error is not counted', async () => {
  const state = makeState();
  let calls = 0;
  const legacyAgent = {
    acceptReview: async () => { calls++; throw new Error('Transaction rejected by the network'); },
    client: { getInboxItem: async () => ({ data: { vdxfData: {} } }), getJobWitness: async () => ({}) },
  };
  await processInboxForAgent(legacyAgent, agentInfo, [{ id: 'r1', type: 'review' }], state, deps);
  assert.equal(calls, 1);
  assert.equal(state._inboxFailures.size, 0, 'contention uncounted on legacy path too');
});

test('legacy fallback: hard error still counts (existing behavior preserved)', async () => {
  const state = makeState();
  const legacyAgent = {
    acceptReview: async () => { throw new Error('contained no review.* keys after whitelist'); },
    client: { getInboxItem: async () => ({ data: { vdxfData: {} } }), getJobWitness: async () => ({}) },
  };
  await processInboxForAgent(legacyAgent, agentInfo, [{ id: 'r1', type: 'review' }], state, deps);
  assert.equal(state._inboxFailures.get('r1').attempts, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && node --test test/inbox-batch-dispatch.test.js`
Expected: FAIL — `processInboxForAgent is not a function` (not exported).

- [ ] **Step 3: Implement** — in `src/cli.js`:

(a) At state init (`:3164`, next to `_inboxFailures`):

```javascript
      _inboxLastWrite: new Map(), // agentId -> { txid, at } — last inbox batch broadcast awaiting confirmation (double-spend gate)
```

(b) Extend the `inbox-deadletter.js` require (`:23-30`) with `classifyInboxFailure`, `shouldDeferForPendingWrite`.

(c) Insert above `checkPendingInbox` (after `dispatchInboxAccept`, `:6321`):

```javascript
// Shared failure bookkeeping: count + log + (on the transition) dead-letter loudly.
function noteInboxFailure(state, agentInfo, item, err) {
  const dl = recordInboxFailure(state._inboxFailures, item.id, err.message, undefined,
    { agentId: agentInfo.id, type: item.type });
  if (dl.justDeadLettered) {
    console.error(
      `[Inbox] ☠️  DEAD-LETTER ${item.type} ${item.id.substring(0, 8)} for ${agentInfo.id} ` +
      `after ${dl.attempts} attempts — quarantined. Redrive with: j41-dispatcher ctl inbox-redrive --item ${item.id}. Last error: ${err.message}`,
    );
    state._agentErrors.set(agentInfo.id,
      `inbox ${item.type} ${item.id.substring(0, 8)} dead-lettered (${dl.attempts}x): ${String(err.message).slice(0, 100)}`);
  } else {
    console.error(`[Inbox] ❌ Failed to process ${item.type} ${item.id.substring(0, 8)} (attempt ${dl.attempts}/${MAX_INBOX_ATTEMPTS}): ${err.message}`);
  }
}

// Process ONE agent's pending inbox items. Approach D (2026-07-29): all items
// go into ONE identity-update tx via agent.acceptInboxBatch, because each
// update spends the identity prevOutput and the platform serves only the last
// CONFIRMED prevOutput — two writes per cycle are a guaranteed mempool
// double-spend ("Transaction rejected by the network").
// Exported for tests. Throws never (all failure modes are contained here).
async function processInboxForAgent(agent, agentInfo, pending, state, deps) {
  const now = Date.now();

  // ── Pending-write confirmation gate ──
  const lastWrite = state._inboxLastWrite.get(agentInfo.id);
  if (lastWrite) {
    let prevTxid = null;
    try {
      const { data: idData } = await agent.client.getIdentityRaw();
      prevTxid = (idData && idData.prevOutput && idData.prevOutput.txid) || null;
    } catch { /* unknown state → gate defers conservatively */ }
    const gate = shouldDeferForPendingWrite(lastWrite, prevTxid, now);
    if (gate.defer) {
      console.log(`[Inbox] ⏳ ${agentInfo.id}: last identity tx ${lastWrite.txid.substring(0, 8)} unconfirmed — deferring ${pending.length} item(s) this cycle`);
      return;
    }
    state._inboxLastWrite.delete(agentInfo.id);
    if (gate.expired) {
      console.warn(`[Inbox] ⚠️ pending-write gate for ${agentInfo.id} expired unconfirmed (tx ${lastWrite.txid.substring(0, 8)}) — resuming`);
    }
  }

  // ── Legacy fallback: SDK ≤2.11.0 without acceptInboxBatch ──
  if (typeof agent.acceptInboxBatch !== 'function') {
    for (const item of pending) {
      if (isDeadLettered(state._inboxFailures, item.id)) continue;
      try {
        const r = await dispatchInboxAccept(agent, item, deps);
        if (r && r.skip) continue; // transient — neither counted nor cleared
        clearInboxFailure(state._inboxFailures, item.id);
      } catch (e) {
        if (classifyInboxFailure(e) === 'contention') {
          console.error(`[Inbox] ⏳ ${item.type} ${item.id.substring(0, 8)}: chain contention (${e.message}) — transient, not counted`);
          continue;
        }
        noteInboxFailure(state, agentInfo, item, e);
      }
    }
    return;
  }

  // ── Batched path ──
  const batch = [];
  for (const item of pending) {
    if (isDeadLettered(state._inboxFailures, item.id)) continue;
    if (item.type === 'job_record') {
      // Fail-closed pre-write gate stays dispatcher-side (needs witness + network policy).
      try {
        const { data: inboxItemDetail } = await agent.client.getInboxItem(item.id);
        const gateResult = await deps.verifyInboxJobRecord({
          inboxItemDetail,
          getJobWitness: (jobId) => agent.client.getJobWitness(jobId),
          verifyWitness: deps.verifyWitness,
          client: agent.client,
          network: deps.network,
        });
        if (gateResult && gateResult.skip) {
          console.log(`[Inbox] ⏭ Skipping job_record ${item.id} (transient): ${gateResult.reason}`);
          continue; // transient — neither counted nor cleared
        }
      } catch (e) {
        noteInboxFailure(state, agentInfo, item, e);
        continue;
      }
    }
    batch.push({ id: item.id, type: item.type });
  }
  if (batch.length === 0) return;

  let res;
  try {
    res = await agent.acceptInboxBatch(batch);
  } catch (e) {
    // Batch-level failures are environmental (contention, unfunded wallet, API
    // down) — by construction not item-specific, so NEVER counted per item.
    const kind = classifyInboxFailure(e);
    console.error(`[Inbox] ❌ batch for ${agentInfo.id} failed (${kind}): ${e.message}` +
      (kind === 'contention' ? ' — retrying after confirmation' : ' — will retry next cycle'));
    state._agentErrors.set(agentInfo.id, `inbox batch failed (${kind}): ${String(e.message).slice(0, 100)}`);
    return;
  }

  if (res.txid) {
    state._inboxLastWrite.set(agentInfo.id, { txid: res.txid, at: now });
    console.log(`[Inbox] ✅ ${agentInfo.id}: batch tx ${res.txid.substring(0, 8)} — ${res.acked.length} accepted, ${res.ackFailed.length} ack-failed, ${res.rejected.length} rejected, ${res.deferred.length} deferred`);
  }
  for (const id of res.acked) clearInboxFailure(state._inboxFailures, id);
  for (const id of res.alreadyDone) clearInboxFailure(state._inboxFailures, id);
  for (const f of res.ackFailed) {
    console.warn(`[Inbox] ⚠️ on-chain write ok but backend ack failed for ${f.id} — stays pending, re-runs next cycle: ${f.error}`);
  }
  for (const r of res.rejected) noteInboxFailure(state, agentInfo, { id: r.id, type: r.type }, new Error(r.error));
  for (const d of res.deferred) console.log(`[Inbox] ⏭ deferred ${d.type} ${d.id.substring(0, 8)} (${d.reason})`);
}
```

(d) In `checkPendingInbox` (`:6324-6380`): keep the outer agent loop, defensive `_inboxFailures` init (add the same for `_inboxLastWrite`), pending fetch/filter, `seenInboxIds` collection and final `pruneInboxFailures` exactly as they are; replace the inner `for (const item of pending) { ... }` block (`:6344-6366`) with:

```javascript
      for (const item of pending) seenInboxIds.add(item.id);
      const { verifyWitness } = require('@junction41/sovagent-sdk/dist/index.js');
      await processInboxForAgent(agent, agentInfo, pending, state, {
        verifyInboxJobRecord, verifyWitness, network: J41_NETWORK,
      });
```

Also add `if (!state._inboxLastWrite) state._inboxLastWrite = new Map();` next to the existing defensive init (`:6325`).

(e) Add `processInboxForAgent` and `noteInboxFailure` to the test-gated `module.exports` (`:8291`).

- [ ] **Step 4: Run to verify**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && node --check src/cli.js && node --test test/inbox-batch-dispatch.test.js test/inbox-attestation-routing.test.js test/inbox-job-record.test.js test/inbox-deadletter.test.js test/inbox-recovery.test.js`
Expected: all PASS (11 new + all existing inbox tests — `dispatchInboxAccept` is untouched so its routing tests stay valid as the legacy-path contract).

- [ ] **Step 5: Commit**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher
git add src/cli.js test/inbox-batch-dispatch.test.js
git commit -m "feat(dispatcher): batch all inbox items into one identity tx per agent per cycle (Approach D) + pending-write gate + contention recovery"
```

---

## Task 5: Dispatcher — structured alerting: `/health` inbox block + `ctl inbox` / `ctl inbox-redrive`

**Files:**
- Modify: `src/control.js` — `buildHealthDocument` (`:297-346`) + `handleCommand` (`:350`)
- Modify: `src/cli.js` — `ctl` command (`:7596-7605`): `--item` option, description, pretty-printers
- Test: `test/inbox-health-surface.test.js` (new); `test/version-stamp.test.js` + `test/control-api.test.js` must stay green

**Interfaces:**
- Consumes: `listInboxFailures`, `redriveDeadLetters` (Task 3); `state._inboxFailures`, `state._inboxLastWrite` (Task 4).
- Produces: health doc `inbox` block (shape in Design section); control actions `inbox` → `{ deadLettered, retrying, pendingWrites }`, `inbox-redrive` (`cmd.itemId` optional) → `{ redriven }`.

- [ ] **Step 1: Write the failing test** — `test/inbox-health-surface.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthDocument, handleCommand } = require('../src/control.js');
const { MAX_INBOX_ATTEMPTS, recordInboxFailure } = require('../src/inbox-deadletter.js');

function makeState() {
  return {
    agents: [], active: new Map(), queue: [], available: [], seen: new Map(),
    _agentErrors: new Map(), _containerCrashes: new Map(),
    _inboxFailures: new Map(), _inboxLastWrite: new Map(),
  };
}

test('health document surfaces dead-lettered items structurally (non-lossy) and degrades status', () => {
  const state = makeState();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) {
    recordInboxFailure(state._inboxFailures, 'item-a', 'bad sig', undefined, { agentId: 'agent-1', type: 'review' });
  }
  recordInboxFailure(state._inboxFailures, 'item-b', 'flake', undefined, { agentId: 'agent-2', type: 'job_record' });
  state._inboxLastWrite.set('agent-1', { txid: 'tx-9', at: Date.now() - 5000 });

  const doc = buildHealthDocument(state, Date.now() - 1000);
  assert.equal(doc.status, 'degraded', 'dead letters degrade health');
  assert.equal(doc.inbox.deadLettered.length, 1);
  assert.deepEqual(
    { itemId: doc.inbox.deadLettered[0].itemId, agentId: doc.inbox.deadLettered[0].agentId, type: doc.inbox.deadLettered[0].type, attempts: doc.inbox.deadLettered[0].attempts, lastError: doc.inbox.deadLettered[0].lastError },
    { itemId: 'item-a', agentId: 'agent-1', type: 'review', attempts: MAX_INBOX_ATTEMPTS, lastError: 'bad sig' },
  );
  assert.equal(doc.inbox.retrying.length, 1);
  assert.equal(doc.inbox.pendingWrites.length, 1);
  assert.equal(doc.inbox.pendingWrites[0].agentId, 'agent-1');
  assert.equal(doc.inbox.pendingWrites[0].txid, 'tx-9');
  assert.equal(typeof doc.inbox.pendingWrites[0].ageMs, 'number');
});

test('health document with no inbox failures: status ok, empty arrays, and tolerates missing maps', () => {
  const doc = buildHealthDocument(makeState(), Date.now());
  assert.equal(doc.status, 'ok');
  assert.deepEqual(doc.inbox, { deadLettered: [], retrying: [], pendingWrites: [] });
  const legacyState = makeState();
  delete legacyState._inboxFailures;
  delete legacyState._inboxLastWrite;
  assert.deepEqual(buildHealthDocument(legacyState, Date.now()).inbox,
    { deadLettered: [], retrying: [], pendingWrites: [] });
});

test("ctl 'inbox' returns the structured view; 'inbox-redrive' clears dead letters and reports the count", async () => {
  const state = makeState();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) {
    recordInboxFailure(state._inboxFailures, 'dead-1', 'poison', undefined, { agentId: 'agent-1', type: 'attestation' });
  }
  const view = await handleCommand({ action: 'inbox' }, state, {}, Date.now());
  assert.equal(view.deadLettered.length, 1);
  const r = await handleCommand({ action: 'inbox-redrive' }, state, {}, Date.now());
  assert.deepEqual(r, { redriven: 1 });
  assert.equal(state._inboxFailures.size, 0);
});

test("'inbox-redrive' with itemId targets one item only", async () => {
  const state = makeState();
  for (const id of ['d1', 'd2']) {
    for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) recordInboxFailure(state._inboxFailures, id, 'p');
  }
  const r = await handleCommand({ action: 'inbox-redrive', itemId: 'd1' }, state, {}, Date.now());
  assert.deepEqual(r, { redriven: 1 });
  assert.equal(state._inboxFailures.has('d2'), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && node --test test/inbox-health-surface.test.js`
Expected: FAIL — `doc.inbox` is `undefined`.

- [ ] **Step 3: Implement** — in `src/control.js`:

Add at the top (module scope, alongside the other requires):

```javascript
const { listInboxFailures, redriveDeadLetters } = require('./inbox-deadletter.js');
```

In `buildHealthDocument` (`:297`), before the `return`:

```javascript
  // Structured inbox failure surface (2026-07-29): the single overwritable
  // per-agent lastError string is lossy — this is the authoritative view.
  const inboxView = listInboxFailures(state._inboxFailures || new Map());
  const pendingWrites = [...(state._inboxLastWrite || new Map()).entries()]
    .map(([agentId, w]) => ({ agentId, txid: w.txid, ageMs: Date.now() - w.at }));
```

Change the `status` line (`:322`) to:

```javascript
    status: (containersUnhealthy > 0 || inboxView.deadLettered.length > 0) ? 'degraded' : 'ok',
```

Add to the returned object (next to `containers`):

```javascript
    inbox: { deadLettered: inboxView.deadLettered, retrying: inboxView.retrying, pendingWrites },
```

In `handleCommand` (`:350`), add cases:

```javascript
    case 'inbox': {
      const view = listInboxFailures(state._inboxFailures || new Map());
      const pendingWrites = [...(state._inboxLastWrite || new Map()).entries()]
        .map(([agentId, w]) => ({ agentId, txid: w.txid, ageMs: Date.now() - w.at }));
      return { ...view, pendingWrites };
    }

    case 'inbox-redrive': {
      const n = redriveDeadLetters(state._inboxFailures || new Map(), cmd.itemId || null);
      return { redriven: n };
    }
```

In `src/cli.js` `ctl` command (`:7596-7605`): append `, inbox, inbox-redrive` to the `.description(...)` string; add `.option('--item <id>', 'Inbox item ID (for inbox-redrive)')`; after the `if (options.agent)` line add `if (options.item) cmd.itemId = options.item;`; and add pretty-print cases:

```javascript
        case 'inbox': {
          const dl = result.deadLettered || [];
          const rt = result.retrying || [];
          console.log(`\nInbox failures: ${dl.length} dead-lettered, ${rt.length} retrying\n`);
          for (const e of dl) console.log(`  ☠️  ${e.type || '?'} ${e.itemId}  agent=${e.agentId || '?'}  attempts=${e.attempts}  ${e.lastError}`);
          for (const e of rt) console.log(`  🔁 ${e.type || '?'} ${e.itemId}  agent=${e.agentId || '?'}  attempts=${e.attempts}  ${e.lastError}`);
          for (const w of (result.pendingWrites || [])) console.log(`  ⏳ ${w.agentId}: awaiting confirmation of ${w.txid} (${Math.round(w.ageMs / 1000)}s)`);
          console.log('');
          break;
        }
        case 'inbox-redrive':
          console.log(`\nRedriven ${result.redriven} dead-lettered item(s) — they get a fresh ${5} attempts on the next poll.\n`);
          break;
```

- [ ] **Step 4: Run to verify**

Run: `cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && node --check src/control.js src/cli.js && node --test test/inbox-health-surface.test.js test/version-stamp.test.js test/control-api.test.js`
Expected: 4 new tests PASS; existing control/version tests PASS (they assert presence of fields, not absence of new ones — verified: `test/control-api.test.js:205,226` and `test/version-stamp.test.js:17` check specific keys only; if any asserts full-object equality, extend the expectation rather than weakening the new surface).

- [ ] **Step 5: Commit**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher
git add src/control.js src/cli.js test/inbox-health-surface.test.js
git commit -m "feat(dispatcher): structured inbox failure surface in /health + ctl inbox / inbox-redrive"
```

---

## Task 6: Versions, full-suite verification, docs

**Files:**
- Modify: SDK `package.json` (`"version": "2.11.0"` → `"2.12.0"`)
- Modify: dispatcher `package.json` (`"version": "2.6.0"` → `"2.7.0"`; dep `"@junction41/sovagent-sdk": "2.11.0"` → `"2.12.0"` at line 38 — **edit the JSON by hand, never `yarn add`**, which would clobber the local symlink)
- Modify: both `CLAUDE.md` files — add one line each: SDK File Map row for `src/inbox/vdxf-gate.ts`; dispatcher Key Patterns note "inbox accepts are batched — one identity tx per agent per cycle (`processInboxForAgent`), see `docs/superpowers/plans/2026-07-29-batched-identity-update.md`"

- [ ] **Step 1: Bump versions + docs as above** (hand-edits; no code).

- [ ] **Step 2: Full verification, both repos, in order**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-sdk && npx tsc --noEmit && yarn build && yarn test
# Expected: ~336 pass, 0 fail (312 baseline + 9 Task 1 + 9 Task 2 + 6 audit-fix tests)
cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && yarn test
# Expected: ~583 pass, 0 fail (550 baseline + 10 Task 3 + 11 Task 4 + 4 Task 5 + 8 audit-fix tests)
```

(Exact new-test counts: reconcile against what actually landed; the invariant is 0 fail and every new file's tests present.)

### AUDIT REVISION — additional REQUIRED tests (v2)

These exist specifically because v1's design could not fail on them. Each must fail before its fix and pass after.

**SDK (`test/accept-inbox-batch.test.ts`):**
- [ ] `gate-passing item that breaks tx build is bisected out — healthy items still write` — craft an item whose value passes the allowlist AND `assertContentmultimapValueSizes` but breaks `Identity.fromJson`. Assert: culprit in `rejected`, healthy item in `written`, exactly ONE broadcast. **This is the single most important new test in the plan** — it is the Critical finding.
- [ ] `all items build alone but merged set fails → batch-level throw` (bisection finds no culprit, does not falsely blame).
- [ ] `item whose value is already on-chain short-circuits — no broadcast, still acked` (Fix 2).
- [ ] `batch where every item short-circuits performs no chain write at all` (`txid: null`, `written` non-empty).

**Dispatcher (`test/inbox-recovery.test.js` / `test/inbox-batch-dispatch.test.js`):**
- [ ] `shouldDeferForPendingWrite releases on blockHeight > expiryHeight, not on wall clock` (Fix 3).
- [ ] `pending-write gate released by wall-clock backstop logs the concurrent-writer case distinctly` (Fix 3).
- [ ] `N consecutive identical-composition non-contention batch failures escalate` (Fix 1, bounded) — and the paired negative: `repeated contention failures never escalate`.
- [ ] `job_record pre-gate network error is uncounted; verification error is counted` (Fix 4).
- [ ] `deferred item writes on a later cycle` (multi-cycle; missing from v1 entirely).
- [ ] `pendingWrites is cleared for an agent with zero pending items` (stale-field fix).
- [ ] `repeated ackFailed for one item surfaces in /health inbox.ackFailed` (Fix 2 visibility).

**Cross-repo contract test (new, `test/sdk-batch-contract.test.js`):**
- [ ] Import the linked `dist/`, assert `acceptInboxBatch` exists and its result object exposes every key `processInboxForAgent` consumes (`txid, written, acked, ackFailed, rejected, deferred, alreadyDone`). Every other dispatcher test stubs the SDK, so shape drift is otherwise undetectable.

- [ ] **Step 3: Live E2E proof** (project practice — every recent feature was live-proven, not just unit-tested). After deploy: queue two inbox items for one agent, confirm in the dispatcher log that ONE identity tx is broadcast and BOTH items are acked, and verify on-chain that both values landed. Confirm `ctl inbox` shows an empty `deadLettered`. v1 ended at committed code with only a "check after deploy" note in risk 9 — that is not a proof step.

- [ ] **Step 3: Commit**

```bash
cd /home/mainn/dispatchertest3/j41-sovagent-sdk && git add package.json CLAUDE.md && git commit -m "chore(sdk): 2.12.0 — acceptInboxBatch + inbox vdxf-gate"
cd /home/mainn/dispatchertest3/j41-sovagent-dispatcher && git add package.json CLAUDE.md && git commit -m "chore(dispatcher): 2.7.0 — batched inbox identity updates; require SDK 2.12.0"
```

---

## Ordering & backward compatibility

- **Hard ordering:** Task 1 → Task 2 (SDK, each ending with `yarn build`) → Tasks 3–5 (dispatcher) → Task 6. The dispatcher consumes the SDK through the yarn-link symlink at `dist/`, so an un-built SDK makes dispatcher Tasks 4–5 fail at require time.
- **SDK bump:** yes, a **minor** bump 2.11.0 → 2.12.0 is required — new public API (`acceptInboxBatch`, `InboxBatchResult`, vdxf-gate exports), no breaking changes (the three accept methods keep identical signatures, behavior, and error strings).
- **Dispatcher bump:** 2.6.0 → 2.7.0 with the exact-pin dependency raised to `2.12.0`. Because the pin is exact (dispatcher `package.json:38`), this is a **coordinated republish**: publish SDK 2.12.0 first, then dispatcher 2.7.0. (Publishing itself is a separate operator step per project practice — this plan ends at committed, fully-tested code.)
- **Skew safety:** dispatcher 2.7.0 running against SDK 2.11.0 (or any SDK missing the method) feature-detects and falls back to the legacy per-item path *with* contention classification — strictly better than today even mis-paired. Dispatcher 2.6.0 against SDK 2.12.0 is untouched (old code path, refactored accepts behave identically).

## Risks / what could go wrong

1. **Contention classifier is a string match.** "Transaction rejected by the network" is the backend's message (it appears nowhere in SDK or dispatcher source — it arrives via `J41Error.message` from `POST /v1/tx/broadcast`, `client/index.ts:369,1918`). If the backend rewords it, contention degrades to 'hard' and burns retry budget again — but the batching + pending-write gate mean contention should now be nearly unreachable, so the classifier is defense-in-depth, not the primary fix. **Open question for the backend (user owns both sides): expose a stable machine code (e.g. `code: 'TX_REJECTED'`) on broadcast rejections and note the daemon's underlying reject reason; then extend `classifyInboxFailure` to check `err.code` first.**
2. **`prevOutput.txid` as the confirmation signal.** The gate assumes the platform's `getIdentityRaw().data.prevOutput.txid` becomes our broadcast txid once it confirms (it must — the tx spends `prevOutput` and creates the new identity output, `update.ts:180-198`). If another writer touches the identity in between (see risk 4), the txid match can never fire; the wall-clock backstop releases the gate and logs it distinctly — bounded delay, no loss. **Revised after audit:** gate release is now primarily height-based (`blockHeight > expiryHeight`), not a 30-minute wall-clock guess. The original "expired at tip+200 ≈ 30 min" justification was wrong — 200 blocks at ~60s is ~3h20m — and releasing at 30 min would have resumed into a still-valid mempool tx and double-spent it.
3. **Backend ack contract — ✅ RESOLVED 2026-07-29, see the full answer in Design step 7.** Outcome: the "stays pending on failure" half holds *only* for pre-commit failures; re-accept returns **`400 ALREADY_PROCESSED`** and must be treated as terminal success. Original text follows for context. The plan assumed a failed/never-sent `acceptInboxItem` leaves the item `pending` and re-served by `getInbox('pending', 20)`; the recovery path (rewrite-same-value + re-ack) depends on it. Verified only from the SDK client side. **Open question: confirm backend keeps an inbox item `pending` after an on-chain write whose ack never arrived, and that re-accepting with the same/different txid is idempotent.**
4. **Concurrent identity writers.** (a) The SDK's own chat handler auto-accepts reviews on `review:received` (`agent.ts:1139-1147`) — job-agent containers run their own `J41Agent` with `connectChat()`, so a container can write a review mid-job while the dispatcher daemon batches. This race predates this plan; batching narrows but does not eliminate it. Mitigations already in the design: `alreadyDone` handling, contention classification, pending-write gate expiry. **Open question / candidate follow-up: suppress SDK auto-accept when a dispatcher manages the inbox (e.g. a `J41AgentConfig` flag), out of scope here.** (b) Operator CLI writes (`update-profile`, `set-status`) share the same identity — same mitigations apply.
5. **On-chain accumulation semantics.** `buildIdentityUpdateTx` REPLACES a key's value array (`update.ts:117-120`), so every review accept replaces the previous `review.record` on-chain — whether the platform pre-formats `vdxfData` as the full accumulated array or just the newest record is not determinable from this codebase (`test/accept-review-path.test.ts` fixtures show a single record). The one-item-per-key rule deliberately preserves whatever the current semantic is; do NOT "improve" it to concatenation here — that would change on-chain shape and could break platform-side decoding. **Open question for the backend: document whether `vdxfData` for reviews carries accumulated history.**
6. **Batch test fixtures build a real signed tx.** `accept-inbox-batch.test.ts` exercises `Identity.fromJson`/`IdentityScript` with placeholder identity fields; if `verus-typescript-primitives` rejects a placeholder (e.g. address checksum), the fixture — not the design — needs adjusting (Task 2 note). Budget a little iteration time there.
7. **Behavior change: environmental failures no longer dead-letter *immediately*.** Today five "no UTXOs" cycles quarantine an item; after this plan environmental faults retry loudly (surfaced in `/health.inbox.retrying` per-item, or `_agentErrors` when batch-level) **but are bounded** by the batch-failure counter — after `MAX_BATCH_FAILURES` consecutive identical-composition failures they escalate to cross-cycle bisection and ultimately to a counted, dead-letterable item. **Revised after audit:** the earlier draft said these "retry forever with loud logs", which reintroduced precisely the unbounded-spin pathology `inbox-deadletter.js:7-10` exists to prevent. Operators should still expect an unfunded wallet to read as a persistent degraded-health signal before it escalates.
8. **Health `status: degraded` on dead letters.** Any 200-checking consumer is unaffected (`control.js:96-98` always returns 200); anything alerting on `status !== 'ok'` will now fire on dead letters — that is the point of scope item 3, but flag it in release notes.
9. **The three already-lost reviews** are unrecoverable by this code if they have expired backend-side (`InboxItem.expiresAt`, `client/index.ts:2147`); if still `pending`, they will be picked up on the first post-deploy cycle (fresh process = empty failure map). Check `ctl inbox` + backend inbox state after deploy.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-batched-identity-update.md`. Execute with superpowers:subagent-driven-development (fresh subagent per task, review between tasks) or superpowers:executing-plans (inline with checkpoints). SDK tasks must complete (including `yarn build`) before dispatcher tasks start.
