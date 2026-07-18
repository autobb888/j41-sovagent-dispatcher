# Sovereign Attestation Tuple + Dispute Respawn-with-Deadline — Design

**Date:** 2026-07-18
**Repos:** `j41-sovagent-sdk` (TypeScript) + `j41-sovagent-dispatcher` (CommonJS)
**Branch:** `feature/attestation-and-dispute-respawn` (off dispatcher `main@591ce71`; SDK `main@fc7946f`)
**Source:** Junction41 backend work-request 2026-07-17 (items A + B; item C = worker-attach ACK deferred to a second increment).

## Goal

Two additive, fail-closed changes so the agent's reputation is tamper-proof and disputes are never silently dropped:

- **A —** on job completion, the agent carries a compact **buyer-signed attestation tuple** on its own VerusID.
- **B —** a dispute filed against a job whose container has already torn down **respawns a worker** that surfaces the dispute + its deadline to the operator, instead of dropping the event.

## Non-goals (explicit)

- **Item C** (worker-attach ACK / `confirmWorkerAttached`) — separate second increment, not this branch.
- **The backend dispute resolver** — built + flag-gated OFF (`DISPUTE_RESOLVER_ENABLED`) on the backend; we deploy B *in concert* with it but do not build it.
- **Dispatcher-side auto-response to a dispute** — decided: **surface-only, human has final say** (see Decision 3). No auto-respond in this branch; a clean seam is left for future agent-autonomous policy.
- **The 72h-deadline-expiry outcome** (operator's "50/50 auto-return?" idea) — that is the backend resolver's decision, still undecided, latent behind the flag. Out of scope here.
- **No new signing primitive.** The tuple's `signature` is the buyer's existing `signmessage` completion signature; `msgHash` is computed by the backend and carried in the inbox item. We only *carry* and *verify*, never sign.

## Global constraints (bind every task)

- **Attestation VDXF key is final/immutable:** `agentplatform::review.attestation` → `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv` (published on testnet, tx `d8f57a4b…`). Use this exact i-address; do not derive a new one.
- **On-chain write is raw hex, NOT DataDescriptor-wrapped.** Agents write the attestation tuple as a raw-hex contentmultimap value under the key (unlike `job.record`/`review.record` which use `makeSubDD`). This is what keeps it ~150 bytes and must stay **under the 5,500-byte contentmultimap truncation limit**. The exact raw-hex encoding must match the backend report `2026-07-18-review-attestation-vdxf-key.md` byte-for-byte — treated as a "cannot get wrong" gate (like refund-address correctness).
- **Accept path is namespace-allowlisted to the single attestation key.** A hostile inbox item must never be able to write arbitrary VDXF onto the agent's identity. Mirror the `review.*`/`job.*` gates (`agent.ts:1420/1518`).
- **Fail closed everywhere.** Verification failure → refuse to write (never synthesize, never write unverified). Mirror `acceptReview` / `verifyInboxJobRecord`.
- **No env-var kill switches for verification.** Consistent with prior hardening.
- Dispatcher is CJS, no build step — validate with `node --check`, test with `node --test test/*.js`. SDK is TS — `npx tsc --noEmit`, `yarn build`, `npx tsx --test test/*.test.ts`.
- Build to the backend contract now (endpoints built but **not yet deployed**); unit-test fully; live-test end-to-end after the backend deploys migration 051 + rebuilds.

---

## Item A — Publish the compact attestation tuple on completion

### Tuple

```
{ jobHash, buyer, rating, timestamp, msgHash, signature }
```

- `signature` — buyer's existing completion `signmessage` signature (already produced + verified today).
- `msgHash` — sha256 of the review message text; computed by the backend, carried in the inbox item. The message text stays off-chain, pinned by this hash.
- Serialized as raw hex under `VDXF_KEYS.review.attestation`; ~150 bytes; < 5,500-byte truncation limit.

### Data flow (broker mode — primary)

1. Buyer completes the job + leaves a review → backend creates an **inbox item** `type: 'attestation'` carrying the tuple fields incl. `msgHash` and the buyer signature (`vdxfData` may carry a pre-formatted raw-hex payload, or the fields to assemble).
2. Dispatcher host `checkPendingInbox()` polls, sees `type === 'attestation'`, runs `verifyInboxAttestation()` (buyer-sig + field cross-check against the authoritative job/review), and on pass calls `agent.acceptAttestationTuple(inboxId)`.
3. `acceptAttestationTuple` writes the raw-hex tuple under `review.attestation` onto the agent's own identity (WIF-only), broadcasts, and marks the inbox item accepted.

Legacy WIF mode (no broker): `performCleanup()` assembles the tuple locally and includes it in `buildJobCompletionAdditions()` alongside `reviewRecord`. Broker/inbox is the primary path.

### SDK changes

| File | Change |
|---|---|
| `src/onboarding/vdxf.ts:66` | Add `attestation: 'i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv'` to `VDXF_KEYS.review` → `{ record, attestation }`. |
| `src/onboarding/vdxf.ts:838` `buildJobCompletionAdditions()` | Add optional `attestationTuple` param; when present, append it under `VDXF_KEYS.review.attestation` as a **raw-hex** value (NOT `makeSubDD`). New helper `encodeAttestationRawHex(tuple)` — exact encoding pinned to the backend report. |
| `src/agent.ts:~1490` | New `acceptAttestationTuple(inboxId)` mirroring `acceptJobRecord`: WIF+iAddress gated, **namespace-allowlisted to `review.attestation` only**, witness/verify-gated, refuses to synthesize if the inbox item lacks the required signed fields (fail-closed). Emits `'attestation:accepted'`. |
| `src/index.ts` | Export any new public helper. |
| inbox-item type | Extend the inbox-item TS type to carry `msgHash` + attestation fields. |

### Dispatcher changes

| File | Change |
|---|---|
| `src/job-agent.js:1715` `performCleanup()` | Build `attestationTuple` next to `reviewRecord` (legacy-WIF path); pass to `buildJobCompletionAdditions`. Broker mode continues to defer to inbox. |
| `src/inbox-attestation.js` (new) | `verifyInboxAttestation({ inboxItemDetail, ... })` mirroring `verifyInboxJobRecord`: verify buyer signature over the tuple, cross-check `jobHash`/`buyer`/`rating`/`msgHash` against the authoritative job + review, network-gate. Return contract: void on success, `{skip,reason}` transient, throw on hard failure. |
| `src/cli.js:6222` `checkPendingInbox()` | Filter: add `|| item.type === 'attestation'`. Branch: `verifyInboxAttestation()` → on pass `agent.acceptAttestationTuple(item.id)`. Reuse dead-letter tracking. |

### Security invariant (A)

The only VDXF key `acceptAttestationTuple` may write is `review.attestation`. Verification gates the buyer signature and cross-checks every field against authoritative platform state before any on-chain write. No verification → no write.

### Tests (A)

- SDK: `encodeAttestationRawHex` produces the exact bytes for a known tuple (golden vector from backend report); size < 5,500 B; round-trips. `acceptAttestationTuple` rejects a wrong-namespace item, rejects missing `msgHash`/`signature`, rejects a bad buyer sig (fail-closed).
- Dispatcher: `verifyInboxAttestation` passes a good item, `{skip}` on transient (job not yet witnessable), throws on field mismatch / bad sig / wrong network. `checkPendingInbox` routes `type==='attestation'` to the verify+accept path and dead-letters on repeated failure.

---

## Item B — Surface a dispute to the agent with a deadline

### The gap (root cause, from code mapping)

- Webhook `job.disputed` handler (`cli.js:5961`) and poll `disputed`-status detection (`cli.js:5640`) both only act when `state.active.get(jobId)` exists. If the container already tore down (post-delivery safety timeout, completion teardown, dispatcher restart, pause), the event is **dropped**.
- A naive "respawn like resume" does **not** work: a worker spawned for an already-delivered/disputed job hits `job-agent.js:600` ("not in a deliverable state → exit cleanly") and **never reaches `waitForPostDelivery`**, where dispute IPC is handled.
- `moveJobToReactivationQueue` (`cli.js:4487`) requires a live `state.active` entry, which a torn-down job lacks.
- `agent.setHandler` (`job-agent.js:411`) wires only `onSessionEnding`; `onJobDisputed` is dead code.
- Today's post-delivery dispute path (`job-agent.js:1526`) *silently* auto-responds per VDXF policy.

### Design

**Dispatcher — new `queueDisputedJobForRespawn(state, jobId, deadline)`:**
- **Live container** (`state.active.has(jobId)`): forward `dispute.filed` IPC **including `deadline`** to the running container (today's behavior + the deadline). The worker's `waitForPostDelivery` handles it.
- **Torn-down** (no active entry): fetch the job (`getJob`), resolve the local `agentId` by matching the job's seller i-address against `state.agents`, synthesize a reactivation entry `{ job, agentId, pausedAt: now, pauseTtlMin, readyToRespawn: true, dispute: { deadline } }`, enqueue + persist, then `respawnReadyResumes(state)`. Fail loudly (log + emit) if the seller can't be resolved to a local agent — never silently drop.
- Wire into **both** `cli.js:5961` (webhook) and `cli.js:5640` (poll), replacing the silent drop.

**Worker (`job-agent.js`) — status-driven post-delivery reconnect:**
- At startup, after `getJob`, if `fullJob.status ∈ {delivered, disputed}` (or the reactivation entry carried a `dispute` marker, surfaced via env/IPC): **skip work + delivery**, connect chat, and enter `waitForPostDelivery` directly (a post-delivery *reconnect*, mirroring the `in_progress` reconnect at line 810). This closes the line-600 drop.
- On entering dispute handling: fetch authoritative dispute via `agent.client.getDispute(job.id)` → `{ reason, deadline_at, whoseMove }`; fire the now-wired `onJobDisputed(job, reason, deadline)` handler; surface to the operator via `sendChatMessage` (reason + human-readable deadline). Emit a control-API event (`dispute.surfaced`) so the future Discord/TG owner-notification seam and future agent-autonomy can hook in.
- **No auto-response** (Decision 3). The VDXF silent auto-policy block is replaced by the surface path. Leave a clearly-marked extension point where a future policy engine would decide.

**SDK:**
- `src/jobs/types.ts:55` — extend `onJobDisputed?(job, reason, deadline)` (third param, Unix ms or ISO from `deadline_at`).
- `src/client/index.ts:1650` `getDispute` / `DisputeDetail` — confirm/extend the type to carry `deadline_at` + `whoseMove` (backend added these).
- Wire `onJobDisputed` in the dispatcher's `agent.setHandler` (`job-agent.js:411`).

### Deployment coupling (B)

B pairs with the backend resolver. Backend gives a **72h deadline + durable `createNotification`**, so an operator can always respond manually even before B lands; B makes the agent *act on* the notification (surface it where the operator sees it). Enable `DISPUTE_RESOLVER_ENABLED` only in concert with B deployed.

### Tests (B)

- Dispatcher: `queueDisputedJobForRespawn` — live path forwards IPC with deadline; torn-down path resolves agentId, enqueues a ready entry, and calls respawn; unresolvable seller logs+emits and does not enqueue a broken entry. Both webhook + poll call sites route through it.
- Worker: startup with `status: 'disputed'` skips work/delivery and enters post-delivery reconnect (unit-level via the exported flow guards); `onJobDisputed` fires with `(job, reason, deadline)`; surface message contains the deadline; no `respondToDispute` is called (surface-only).
- SDK: `onJobDisputed` type accepts the deadline arg; `getDispute` returns `deadline_at`/`whoseMove`.

---

## Decisions (locked)

1. **Branch/sequencing:** money-safety merged to `main` first (done, `591ce71`); A+B on a fresh branch; C is a later increment.
2. **Attestation key:** final/immutable `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv`; raw-hex write; encoding pinned to backend report.
3. **Dispute auto-response:** surface-only, human has final say, for now. Clean seam for future agent-autonomous policy. Deadline-expiry outcome is backend's call, out of scope.
4. **Testability:** build-to-contract now, live-test after backend deploy.

## Open coordination items (with backend / operator)

- Exact **raw-hex encoding** of the attestation tuple — need the golden vector from `2026-07-18-review-attestation-vdxf-key.md` to pin the SDK encoder + dispatcher verifier byte-for-byte.
- Confirm the **inbox `attestation` item shape** (field names, whether `vdxfData` is pre-formatted raw-hex or fields to assemble, where `msgHash`/buyer-sig live).
- Confirm `DisputeDetail` JSON keys (`deadline_at`, `whoseMove`) as returned by `GET /v1/jobs/:id/dispute`.

## Rollout

1. Land A+B on the branch; full unit tests both repos.
2. Backend deploys migration 051 + rebuild → endpoints live.
3. Live-test: real job → completion → attestation tuple on agent's ID (A); real dispute after container teardown → respawn → surfaced to operator with deadline (B).
4. Republish SDK; rebuild job-agent image; restart dispatcher.
5. Enable `DISPUTE_RESOLVER_ENABLED` in concert (operator's call, after the settlement product decision).
