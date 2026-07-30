# Response to Backend Findings 2026-07-29 — Prioritised Action Plan

> ## ⚠️ CORRECTION — 2026-07-30: §5b is NOT a P1, and NOT data loss
>
> **This plan's original P1 — read-merge-append to preserve review history — is
> retracted. Do not implement it as written.**
>
> Verus `getidentityhistory` returns complete identity snapshots at every update
> height, `contentmultimap` included, so overwriting `review.record` replaces only the
> **current** value while every prior value remains on-chain and retrievable. Latest-wins
> in the live contentmultimap is the intended design.
>
> The investigation's *facts* were right and remain useful: `review.record` /
> `review.attestation` / `job.record` are each ONE fixed i-address, and
> `buildIdentityUpdateTx` replaces a key's array (`update.ts:117-120`). The error was
> concluding that replace ⇒ history destroyed, without checking whether the chain
> retains prior states. It does.
>
> **Consequences for this plan:**
> - The read-merge-append work is **cancelled**. Appending would in fact make things
>   worse: it would grow a single contentmultimap value without bound, straight into
>   the ~5.5KB per-value truncation cliff that `assertContentmultimapValueSizes`
>   exists to guard.
> - **§5a job-hash dedupe survives on its own merits** — it is no longer entangled with
>   an append fix. It prevents redundant identity writes (and their fees) when the
>   backend re-emits a review. Cheap, self-contained, still worth doing.
> - The coordination warning to the backend about their presence-verifier needing to
>   decode array-shaped values is **moot** — nothing is changing to array shape.
> - Re-ranked priorities: §5a dedupe, then §3c type filter (one line, once their filter
>   lands), then §3b persistence (visibility only). No P1 remains.
> - **New, genuinely open item:** reconstructing an agent's review history requires
>   `getidentityhistory`, which nothing currently exposes — not the SDK, not the
>   platform API (`GET /v1/me/identity/raw` is current-state only,
>   `client/index.ts:712-714`). Scope this as a feature if history-reading matters.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one live data-loss bug the backend's report surfaced (§5b: on-chain history is replaced, not appended — CONFIRMED against live chain data), fold the §5a job-hash dedupe into the same fix (it becomes *mandatory* the moment append semantics ship), and stage the two small follow-ups (§3c type filter, §3b dead-letter persistence). §3a is already shipped and live; §3d needs no dispatcher work.

**Tech Stack:** SDK = TypeScript→CJS (`yarn build`, tests `npx tsx --test test/*.test.ts`, currently 350/350). Dispatcher = plain CJS, no build (`node --check src/*.js src/executors/*.js && node --test test/*.test.js`, currently 614/614). SDK is **yarn-linked** into the dispatcher — never `yarn add` in the dispatcher.

**Source report:** `docs/backend-responses/2026-07-29-backend-findings.md`. Reply to backend: `docs/backend-responses/2026-07-30-dispatcher-reply.md`.

---

## Investigation log — what was verified before this plan (2026-07-29)

Every claim below was checked against code or live chain/API data, read-only.

### §5b — CONFIRMED. Real, live, ours. The single highest-severity item.

1. **Key allocation: ONE fixed i-address per record type, not per-review.**
   `VDXF_KEYS.review.record = 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad'` (SDK `src/onboarding/vdxf.ts:67`). Likewise `review.attestation = 'i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv'` (`vdxf.ts:68`) and `job.record = 'iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn'` (`vdxf.ts:90`). Every review on an identity writes the **same** key.

2. **The write REPLACES the key's array.**
   `buildIdentityUpdateTx` (SDK `src/identity/update.ts:117-120`): after copying the existing contentmultimap, `for (const [key, values] of Object.entries(vdxfAdditions)) { currentCmm[key] = [...values]; }` — comment: "replace existing keys, add new ones". The accept paths pass ONLY the new item's value (verbatim `inboxItem.vdxfData`, gated), never the accumulated array. So the second review under `review.record` destroys the first *in current identity state*. The batch code knows this: `acceptInboxBatch` Phase 3 (SDK `src/agent.ts:1643-1647`) defers same-key items to the next cycle *precisely because* "buildIdentityUpdateTx REPLACES a key's array rather than appending" — which means the deferred item replaces the first one a cycle later. The one-item-per-key rule prevented intra-batch clobber but merely staggers the inter-cycle clobber.

3. **Live chain proof (read-only probe, 2026-07-29, block 1168312):**
   - **w7** (`iMRMgHbkr7qjupRUpHLwp86g16UX3Uzzde`): 13 cmm keys; `review.record` holds **exactly one entry**, jobHash `a4ccfe167577b2f2919c53272ea11b65`. The 10-day-old review `fed0564a…` is **absent** from current identity state. Backend's observation confirmed.
   - **w2** (`i5WpjyEsnU1W93JezQTkL7SqXGHbe2ZZGg`): 21 keys; one entry, jobHash `6d87b922…`.
   - **w5** (`iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D`): 20 keys; one entry, jobHash `7ad56234…`.
   - **Reconciliation of the two observations:** w2/w5's "new key added per review (20→21, 19→20)" was a **first-write illusion** — those identities had never carried `review.record` before, so the write *added the key*. w7 already had the key (from `fed0564a…`), so the write *replaced its array* and the count stayed 13. There is no accumulate-vs-replace split between workers; the behavior is uniform latest-wins. The next review on w2/w5 will erase `6d87b922…`/`7ad56234…` too.
   - **Blast radius:** `review.attestation` and `job.record` also hold exactly one entry each on all three workers — attestation history and job history are equally latest-wins. Every completed job's record erases the previous one.

4. **Mitigations on the loss:** prior entries are not cryptographically destroyed — every historical `updateidentity` tx is permanently on-chain, so history is recoverable by walking the identity's tx history. But nothing that reads *current identity state* (`getidentity`, the backend's planned §2 presence-verification, any marketplace UI) can see it. For the product promise ("on-chain reputation"), current-state is what counts. This is a P1.

### §5a — real; partially covered; the missing piece MUST ship with the §5b fix.

- Existing coverage: `valueAlreadyOnChain` (SDK `src/inbox/vdxf-gate.ts:217-231`) short-circuits a write when the item's additions are **byte-identical** (whole-array `JSON.stringify` equality) to what's on-chain under the key. That covers ack-retry rebroadcasts of the *same* item.
- NOT covered: a backend **re-submitted** review carries a fresh timestamp/signature → different bytes → written again. Under today's replace semantics the damage is bounded (same key, near-identical content, one wasted 10,000-sat fee). **Under append semantics the same event would append a duplicate review forever** — shipping §5b without job-hash dedupe converts the backend's non-idempotent re-submit into permanent on-chain duplicate spam. Therefore 5a-dedupe is folded into Task 1, not a separate later item.
- Backend half (idempotent `POST /v1/reviews` on `(agent_verus_id, job_hash)`) is still wanted — ours is defense in depth.

### §3a — CLOSED by shipped code. Verified, no re-planning.

- SDK **2.12.0** (`d219674`): `J41Agent.acceptInboxBatch()` (`src/agent.ts:1580`), shared per-type gate `src/inbox/vdxf-gate.ts`.
- Dispatcher **2.7.0** (`d45a668`): `processInboxForAgent` (`src/cli.js:6344`) — one identity tx per agent per cycle, pending-write confirmation gate (`shouldDeferForPendingWrite`, `src/inbox-deadletter.js:170-181`, evaluated at `cli.js:6363-6391`), contention never burns the dead-letter budget, bounded batch escalation, `/health` inbox block, `ctl inbox` / `ctl inbox-redrive`.
- Live-proven: the three dead-lettered reviews recovered and wrote; per-item independence held (poisoned item rejected alone, healthy item still wrote).
- Their report's citation "cli.js:6344-6349 ... no per-identity confirmation gate" describes the pre-2.7.0 code; those lines are now the gate itself.
- **Their merged-pair offer: DECLINE** (see reply doc). Batching already writes the review+attestation pair in one tx; a merged item whose `vdxf_data` carries both keys would be *rejected by the per-type gate* on every deployed SDK (review allowlist is exactly `[review.record]`, `vdxf-gate.ts:42`) — the attestation key would be dropped with a tampering warning. The offer would create the very silent-drop they hypothesized in §3d.
- One residual their framing surfaced, folded into Task 1: intra-batch key-collision deferral staggers same-key writes across cycles, which is exactly where the §5b replace bites. After append semantics, same-key items can co-exist in one batch and the deferral rule can be relaxed for history keys (optional, Task 1 step 8).

### §3d — corrected diagnosis. No dispatcher work; two backend asks.

- `fcc0fb82-f841-47f2-976b-d6943088326c` fetched live 2026-07-29: it is on **w5 (agent-5)**, type `review`, jobHash `e27f527fb4612c6f5445656d7d339cd1`, created 2026-07-08, **`expiresAt` 2026-07-15 — 14 days past expiry and still `pending`**. Its `vdxfData` keys are `["jobId","rating","message","isPublic"]` — raw JSON field names, not VDXF i-addresses. Legacy item predating backend VDXF pre-formatting.
- Nothing is dropped *silently*: the gate drops nothing here — zero keys survive the allowlist and the accept **throws loudly** (`"no review.* keys after whitelist"`, `vdxf-gate.ts:122-124`), classifies hard, dead-letters after 5 attempts, and is visible in `/health` and `ctl inbox`.
- Their general hypothesis ("allowlist drops the attestation key silently") is **wrong for the current wire format**: review and attestation arrive as **separate inbox items**, each gated against its own type (`review`→`[review.record]`, `attestation`→`[review.attestation]`). Correct-by-design. The only configuration in which a silent-ish drop occurs (loud console error, but the tx still builds) is if both keys were ever put in ONE item's `vdxfData` — i.e. exactly the merged-pair change we are declining.
- Backend asks: (1) enforce `expires_at` (their own §3c `cleanupExpired` wiring covers it) so this permanently-invalid item leaves the pending set; (2) nothing else — no dispatcher change can ever make it valid.

### §3c — real, latent, live-demonstrated. Blocked on backend; dispatcher change is trivial.

- Call site: `agent.client.getInbox('pending', 20)` (dispatcher `src/cli.js:6559`), client-side filter to review/attestation/job_record at `cli.js:6560-6562`. SDK signature: `getInbox(status='pending', limit=20)` (`src/client/index.ts:697-700`) — no type param today.
- Live probe 2026-07-29: agent-5 has **77 pending** items (35 job_request, 26 job_accepted, 11 job_delivered, 4 notification, 1 review); the one review sits at **index 15 of the 20-row newest-first window** — one modest burst of informational items away from invisible. agent-2 has 50+ pending, zero actionable. Confirms their starvation math.
- Root cause is backend-side inbox hygiene (informational types never leave `pending`, expiry unenforced); our fixed `limit 20` is the exposure.

### §3b — assessed: keep in-memory as default posture, add cheap persistence for *visibility*, not behavior.

- Losing the map on restart re-runs at most 5 gate attempts per poisoned item (hard rejects like `fcc0fb82` throw in Phase 1 *before* any tx is built — no fee spent), then re-quarantines. Bounded and cheap. `ctl inbox-redrive` + `/health` already restored operator control and visibility within a process lifetime.
- What's genuinely lost across restarts: failure history (attempt counts, first-failed-at) — an operator diagnosing a flapping deploy sees counters reset. That is a visibility gap, not a correctness gap.
- Verdict: worth doing cheaply (persist on dead-letter transitions, load at sweep init, prune on backend-confirmed non-pending), but strictly after Task 1. If backend expiry enforcement (§3c half) lands first, the population of long-lived poison items goes to ~zero and this drops further in value.

---

## Priorities

| # | Item | Severity | Status | Effort |
|---|---|---|---|---|
| P1 | §5b append-not-replace for history keys + §5a job-hash dedupe (one branch, inseparable) | **Critical — live data loss, core product promise** | needs building (SDK + bump) | ~1.5–2 days incl. live proof |
| P2 | §3c `?type=` filter pass-through | Medium (latent starvation, live-demonstrated) | blocked on backend; ours is <1h | <1h |
| P3 | §3b dead-letter persistence (visibility only) | Low | optional | ~0.5 day |
| — | §3a batching | closed | shipped 2.12.0/2.7.0, live-proven | none |
| — | §3d `fcc0fb82` | n/a | backend action (expire) | none |

## Global Constraints

- **Never widen a per-item allowlist** (52f8d07 property). The append fix changes what happens to values *already on the identity*, never what an inbox item is allowed to write.
- **Never synthesize review/attestation records** — append carries existing on-chain entries forward verbatim (bytes untouched); only the ordering/merge is new.
- **Replace semantics stay the default in `buildIdentityUpdateTx`.** Profile fields (displayName, status, services…) are single-value and MUST replace. History-append is an inbox-accept concern and lives beside the gate, not in the generic tx builder.
- **Fail closed:** an existing on-chain entry that cannot be decoded is preserved verbatim, never dropped. Dedupe only ever skips the NEW entry, never an existing one.
- **No env-var bypasses** (feedback_no_bypass_in_prod).
- SDK tests import `dist/` → `yarn build` before SDK tests; SDK build precedes dispatcher tasks (yarn link).

---

## Task 1: SDK — history-append + job-hash dedupe for inbox accepts (§5b + §5a)

**Failing tests first (TDD):**

- [ ] `test/history-append.test.ts` (new):
  - `mergeOnChainHistory(onChain, additions)` with an existing `review.record` entry A on-chain and new entry B in additions → returns `{ [review.record]: [A, B] }` (A verbatim, byte-identical).
  - Existing UNDECODABLE entry (garbage hex / non-DD object) is preserved verbatim and B still appends after it.
  - New entry whose decoded `jobHash` equals an existing entry's → additions for that key collapse to the on-chain state (no new bytes) and the helper reports `{ deduped: true }` for the item.
  - Same three properties for `review.attestation` and `job.record` keys.
  - Non-history keys (e.g. `agent.displayName`) pass through untouched (replace preserved).
- [ ] `test/accept-batch.test.ts` additions: batch with on-chain A + new item B → the built tx's cmm carries `[A, B]` under `review.record`; a re-submitted duplicate of A (fresh timestamp, same jobHash) lands in `written` with NO broadcast (ack-only), not a second write.
- [ ] `test/accept-review-path.test.ts` addition: single-path `acceptReview` appends rather than replaces (legacy fallback path in dispatchers < 2.7.0 must not clobber either).
- [ ] Existing 350 tests stay green — in particular the pinned gate error strings and the update.ts profile-replace behavior.

**Implementation steps:**

- [ ] 1. New helper in `src/inbox/vdxf-gate.ts` (stays pure — no network/wallet/chain):
      `HISTORY_KEYS = new Set([VDXF_KEYS.review.record, VDXF_KEYS.review.attestation, VDXF_KEYS.job.record])` and
      `mergeOnChainHistory(onChain, additions): { merged, dedupedKeys }` — for each additions key in `HISTORY_KEYS`: decode each existing on-chain entry's DD `objectdata.message` → JSON → `jobHash` (fallback: byte-equality via the existing `JSON.stringify` comparison); if the new entry's jobHash (or bytes) is already present → drop the NEW entry (dedupe); else `merged[key] = [...existingVerbatim, ...newValues]`. Keys not in `HISTORY_KEYS` pass through unchanged.
- [ ] 2. Wire into `acceptInboxBatch` Phase 3 (`agent.ts` ~1643): after the `valueAlreadyOnChain` short-circuit, replace the raw `merged[k] = c.additions[k]` with the helper's output computed against the Phase-2 `onChain` snapshot. An item fully deduped by jobHash → `written` bucket (ack-only), same as the byte-identical short-circuit today.
- [ ] 3. Rework the already-on-chain check for history keys: containment of the NEW entry (by jobHash, fallback bytes) in the on-chain array, not whole-array equality — otherwise the first append makes every later ack-retry rebroadcast. Keep `valueAlreadyOnChain` exported for compat; add `entryAlreadyOnChain`.
- [ ] 4. Wire the same helper into the three single accept paths (`acceptReview` `agent.ts:1422`, `acceptAttestationTuple` `:1485`, `acceptJobRecord` `:1536`) — they already hold `identityData` at that point.
- [ ] 5. Size guard: `assertContentmultimapValueSizes` covers per-value (~5.5KB script-element cliff) and each history entry is its own array element, so per-entry is safe. Add a **loud warning** (not a failure) when a history key's total byte size crosses ~50KB — growth is unbounded by design for now; windowing/archival is a *documented deferred decision* (full history remains recoverable from identity tx history even if a future cap evicts old entries from current state). Do NOT silently evict.
- [ ] 6. Fix the stale `parseFlatEntry` comment (`vdxf.ts`: "updateidentity appends, latest wins" — it does not append; the builder replaces) and add `decodeReviewHistory(cmm)` returning ALL entries under a history key, so SDK consumers stop assuming one entry.
- [ ] 7. (Optional, only if trivial) Relax the batch key-collision deferral for history keys — two reviews for the same agent can now append in one tx. If not trivial, keep deferral: post-fix it is correct (the deferred item appends next cycle).
- [ ] 8. `yarn build`, full suite, version bump **2.13.0**, changelog.

## Task 2: Dispatcher — consume SDK 2.13.0 + integration tests

- [ ] Failing test in `test/inbox-batch.test.js` (or the existing processInboxForAgent suite): fake agent whose `getIdentityRaw` returns a cmm with an existing review entry → after `processInboxForAgent`, the broadcast additions contain both entries; a duplicate-jobHash item never triggers a broadcast.
- [ ] Bump SDK peer requirement, dispatcher version **2.7.1** (or 2.8.0 if the ctl/health surface gains a dedupe counter), `node --check`, full 614+ suite.
- [ ] **Live E2E proof (the ranking evidence for closure):** on a test identity, write review 1 → confirm → write review 2 → probe current identity state shows BOTH jobHashes under `review.record`. Then re-submit review 2 → no new broadcast, ack-only. Record txids in the plan's completion notes.

## Task 3: §3c — type-filter pass-through (BLOCKED on backend filter landing)

- [ ] SDK: `getInbox(status='pending', limit=20, opts?: { type?: string })` (`src/client/index.ts:697`) appending `type` to the querystring when present.
- [ ] Dispatcher `src/cli.js:6559`: `getInbox('pending', 20, { type: 'review,attestation,job_record' })`. KEEP the client-side filter at `cli.js:6560-6562` as belt-and-braces (older backends ignore the param).
- [ ] Test: querystring assertion + dispatcher passes the param.

## Task 4 (optional, last): §3b — persist dead-letter state for visibility

- [ ] Persist `state._inboxFailures` to `~/.j41/dispatcher/inbox-deadletter.json` (0600) on dead-letter transitions and prunes; load in `runInboxSweep` init (`cli.js:6541`). Restart keeps counters/quarantine; `ctl inbox-redrive` still clears. Keep `src/inbox-deadletter.js` pure — persistence lives in the caller.
- [ ] Re-evaluate after backend expiry enforcement ships; drop if the poison population is zero.

## Risks

- **Append + non-idempotent backend re-submits** is the dangerous interaction — that is why Task 1 refuses to split §5b from §5a.
- Backend's §2 presence-verifier must scan ALL entries under `review.record` (array), not the last/only entry — coordinated in the reply doc BEFORE we ship, so their verifier doesn't mark appended-format reviews unverified.
- Concurrent writers (job-agent container, operator `update-profile`) carry the full cmm forward (update.ts:105-110), so they cannot clobber appended history; the dispatcher's own writes stay serialized by the pending-write gate.
