# Sovereign Attestation Tuple + Dispute Respawn-with-Deadline — Design

**Date:** 2026-07-18 (rev 2 — corrected to the backend's actual review.record passthrough model)
**Repos:** `j41-sovagent-sdk` (TypeScript) + `j41-sovagent-dispatcher` (CommonJS)
**Branch:** `feature/attestation-and-dispute-respawn` (off dispatcher `main@591ce71`; SDK `main@fc7946f`)
**Source:** Junction41 backend work-request 2026-07-17 (items A + B; item C = worker-attach ACK deferred to a second increment) + backend owner corrections 2026-07-18.

## Goal

Two additive, fail-closed changes so the agent's reputation is tamper-proof and disputes are never silently dropped:

- **A —** on job completion, the agent carries a compact **buyer-signed attestation tuple** on its own VerusID.
- **B —** a dispute filed against a job whose container has already torn down **respawns a worker** that surfaces the dispute + its deadline to the operator, instead of dropping the event.

## Non-goals (explicit)

- **Item C** (worker-attach ACK / `confirmWorkerAttached`) — separate second increment, not this branch.
- **The backend dispute resolver** — built + flag-gated OFF (`DISPUTE_RESOLVER_ENABLED`) on the backend; we deploy B *in concert* with it but do not build it.
- **Dispatcher-side auto-response to a dispute** — decided: **surface-only, human has final say**. No auto-respond in this branch; a clearly-marked seam is left for future agent-autonomous policy. The 72h-deadline-expiry outcome (operator's "50/50 auto-return?" musing) is the backend resolver's call, still undecided, out of scope here.
- **No tuple serialization on our side.** The backend formats `vdxf_data` (opaque hex); the dispatcher/SDK only carry it. No new signing primitive, no encoder, no on-chain byte-layout logic on our side.

## The corrected model (read this first)

The existing `review.record` pipeline is **backend-formats → dispatcher passes through**, NOT SDK-builds:

- The backend emits an inbox item with `vdxf_data` pre-built (its `generateVdxfData` / `encodeVdxfValue` = `Buffer.from(JSON.stringify(value)).toString('hex')`, plain `JSON.stringify`, not canonical).
- The SDK's `acceptReview(inboxId)` fetches the item, **allowlists** the key to the `review.*` namespace, and writes the **opaque hex** to the agent's identity. It refuses to synthesize if `vdxfData` is absent (fail-closed).

**Attestation is the same pattern with a different allowlisted key.** `acceptAttestationTuple` is a clone of `acceptReview` allowlisting only `review.attestation`. We never build, serialize, or verify the tuple bytes — the backend owns them; the buyer's signature inside the tuple self-polices forgery (a forged tuple's signature simply won't verify for any off-chain reader, and it's written to the agent's *own* id, so it's worthless — no dispatcher-side witness gate needed, exactly like `review.record`).

## Global constraints (bind every task)

- **Attestation VDXF key is final/immutable:** `agentplatform::review.attestation` → `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv` (published on testnet, tx `d8f57a4b…`). Add it to `VDXF_KEYS.review`; use this exact i-address.
- **Opaque passthrough.** Our side treats the tuple hex as opaque. Do NOT build/encode/verify it. `acceptAttestationTuple` = `acceptReview` clone. Key order in the tuple is NOT load-bearing (the signature covers the reconstructed `J41-COMPLETE` string; `msgHash` covers the review text; neither depends on JSON byte layout).
- **Accept path is namespace-allowlisted to the single attestation key.** A hostile inbox item must never write any key other than `review.attestation` onto the agent's identity. Mirror the `review.*` allowlist (`agent.ts:1420`) but restrict the set to `[VDXF_KEYS.review.attestation]`.
- **Fail closed.** Refuse to synthesize if `vdxfData` is absent (mirror `acceptReview`, `agent.ts:1449`). WIF+iAddress required.
- **No env-var kill switches for verification.** Consistent with prior hardening.
- Dispatcher is CJS, no build step — validate with `node --check`, test with `node --test test/*.js`. SDK is TS — `npx tsc --noEmit`, `yarn build`, `npx tsx --test test/*.test.ts`.
- Build to the backend contract now (endpoints built but **not yet deployed**); unit-test fully; live-test end-to-end after the backend deploys migration 051 + rebuilds.

---

## Item A — Carry the compact attestation tuple on completion

### Tuple (backend-owned, opaque to us)

`{ jobHash, buyer, rating, timestamp, msgHash, signature }` — `buyer` = buyer i-address; `rating` = number; `timestamp` = epoch the buyer signed; `msgHash` = sha256-hex of the review text (backend computes); `signature` = buyer's completion (`J41-COMPLETE`) signature. Serialized backend-side as `hex(JSON.stringify(tuple))`; ~150 B; < 5,500-byte truncation limit. **We never touch these bytes.**

### Inbox item shape (backend-emitted)

```
{ type: 'attestation',
  recipient_verus_id: '<agent i-address>',
  vdxf_data: JSON.stringify({ "i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv": "<hex>" }) }
```

The inner value is a **bare hex string** (not an array). `acceptReview`'s `Array.isArray(value) ? value : [value]` normalization (`agent.ts:1435`) already handles this — cloning it is automatically correct. The client's inbox layer normalizes `vdxf_data` (snake, JSON string) → `vdxfData` (object) the same way it does for `review` items (type-agnostic — confirm in Task).

### Data flow

Buyer completes job + leaves review → backend emits `type:'attestation'` inbox item (opaque hex) → dispatcher `checkPendingInbox()` sees `type==='attestation'` → `agent.acceptAttestationTuple(item.id)` → allowlist `review.attestation` + write opaque hex to agent identity + `acceptInboxItem`. **Accepted directly like `review`, NOT witness-gated like `job_record`.**

### SDK changes

| File | Change |
|---|---|
| `src/onboarding/vdxf.ts:66` | Add `attestation: 'i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv'` to `VDXF_KEYS.review` → `{ record, attestation }`. |
| `src/agent.ts` (after `acceptReview`, ~1485) | New `acceptAttestationTuple(inboxId)`: byte-identical to `acceptReview` except the allowlist set is `new Set([VDXF_KEYS.review.attestation])` and log/emit strings say "attestation" (`emit('attestation:accepted', …)`). Refuses to synthesize if no `vdxfData`. |
| `src/index.ts` | No new export needed (method on `J41Agent`); confirm `J41Agent` is exported (it is). |

**No change to `buildJobCompletionAdditions`, no `encodeAttestationRawHex`, no `performCleanup` attestation build.** Those were the wrong (SDK-serializes) model.

### Dispatcher changes

| File | Change |
|---|---|
| `src/cli.js` `checkPendingInbox()` (~6234 filter, ~6251 branch) | Filter: add `|| item.type === 'attestation'`. Branch: `else if (item.type === 'attestation') { await agent.acceptAttestationTuple(item.id); }` — direct accept like `review` (no `verifyInboxJobRecord`). Reuse the existing dead-letter tracking (`recordInboxFailure`/`clearInboxFailure`). |

### Security invariant (A)

The only VDXF key `acceptAttestationTuple` may write is `review.attestation`; any other key in `vdxfData` is dropped with a tamper warning (mirrors `agent.ts:1428`). No `vdxfData` → refuse to write. The agent writes only to its own identity; a forged tuple is signature-invalid and worthless.

### Tests (A)

- SDK (`test/accept-attestation.test.ts`): `acceptAttestationTuple` with a good pre-formatted item writes the `review.attestation` key (assert the value passed to a stubbed `buildIdentityUpdateTx`); **drops a non-`review.attestation` key** (e.g. `agent.payAddress`) with the tamper path and throws "no review.attestation keys after whitelist"; **throws** (refuse-to-synthesize) when `vdxfData` is absent; skips when item status ≠ `pending`.
- Dispatcher (`test/inbox-attestation-routing.test.js`): `checkPendingInbox` routes a `type:'attestation'` item to `acceptAttestationTuple` (injected stub) and NOT to `acceptReview`/`acceptJobRecord`; a throw increments the dead-letter counter.

---

## Item B — Surface a dispute to the agent with a deadline

### The gap (root cause, from code mapping)

- Webhook `job.disputed` handler (`cli.js:5961`) forwards only via `activeJob.process.send` — **doesn't reach Docker containers at all**, and drops entirely if no active entry. Poll detection (`cli.js:5650`) uses `sendToJobAgent` but only iterates `state.active`.
- A respawned worker for an already-delivered/disputed job hits `job-agent.js:600` ("not in a deliverable state → exit cleanly") and **never reaches `waitForPostDelivery`**, where dispute IPC is handled.
- `moveJobToReactivationQueue` (`cli.js:4487`) requires a live `state.active` entry a torn-down job lacks.
- `agent.setHandler` (`job-agent.js:411`) wires only `onSessionEnding`; `onJobDisputed` is dead code.
- The post-delivery dispute path (`job-agent.js:1526`) *silently* auto-responds per VDXF policy.

### Design

**Dispatcher — new `queueDisputedJobForRespawn(state, jobId)`** (no deadline param — the worker fetches the authoritative deadline itself):
- **Live** (`state.active.has(jobId)`): `sendToJobAgent(info, { type: 'dispute.filed', data: { jobId, reason } })` (handles both local + Docker). This replaces the webhook's broken `process.send`.
- **Torn-down** (no active entry): `getJob(jobId)`; resolve the local `agentId` by matching the job's seller i-address against `state.agents`; if unresolved, **log + `emitEvent('dispute.unresolved_agent', …)` and return** (never enqueue a broken entry). Else `rq.enqueue(state.reactivationQueue, { job, agentId, pausedAt: Date.now(), pauseTtlMin: <default>, readyToRespawn: true, dispute: true })`, persist, `await respawnReadyResumes(state)`.
- Wire into **both** the webhook handler (`cli.js:5961`, replacing the `process.send` block) and poll detection (`cli.js:5650`, replacing the inline `sendToJobAgent`).

**Worker (`job-agent.js`) — status-driven post-delivery reconnect + surface:**
- Startup: after `getJob`, if `fullJob.status ∈ {'delivered','disputed'}` → **skip work + delivery**, connect chat, and enter `waitForPostDelivery` directly (post-delivery *reconnect*, mirroring the `in_progress` reconnect at line 810). Closes the line-600 drop.
- New helper `surfaceDispute(job, agent)`: `const d = await agent.client.getDispute(job.id)` → read `d.deadline_at`, `d.deadline_owner`; fire `agent.handler.onJobDisputed(freshJob, d.reason, d.deadline_at)`; `agent.sendChatMessage(job.id, <operator-facing text with reason + human deadline + whose move>)`; emit a `dispute.surfaced` marker (log line the operator/control-API can see). Called (a) on startup when status is `disputed`, and (b) from the `dispute.filed` IPC handler.
- `dispute.filed` handler (`job-agent.js:1526`): replace the body with `await surfaceDispute(job, agent)`. **Remove** the silent VDXF auto-policy block; leave a one-line comment marking where a future agent-autonomous policy engine would decide (surface-only, human final say).
- `agent.setHandler` (`job-agent.js:411`): add `onJobDisputed: async (dJob, reason, deadline) => { … }` — logs + is the escape hatch (kept thin; surfacing happens in `surfaceDispute`).

**SDK:**
- `src/jobs/types.ts:56` — extend `onJobDisputed?(job, reason, deadline?)` (third param: `deadline_at` ISO string | undefined).
- `src/client/index.ts:2626` `DisputeDetail` — add `deadline_at?: string | null; deadline_owner?: 'seller' | 'buyer' | null; deadline_passed?: boolean;`. (`getDispute` already returns `res.dispute` unchanged.)

### Deployment coupling (B)

B pairs with the backend resolver. Backend gives a **72h deadline + durable `createNotification`**, so an operator can always respond manually even before B lands; B makes the agent *act on* the notification (surface it where the operator sees it). Enable `DISPUTE_RESOLVER_ENABLED` only in concert with B deployed.

### Tests (B)

- Dispatcher (`test/dispute-respawn.test.js`): `queueDisputedJobForRespawn` — live path calls `sendToJobAgent` with `dispute.filed`; torn-down path resolves agentId, enqueues a `readyToRespawn:true` entry, calls `respawnReadyResumes` (injected stubs); unresolvable seller emits `dispute.unresolved_agent` and does NOT enqueue. Both webhook + poll call sites route through it (assert via a spy).
- Worker: `surfaceDispute` (exported under NODE_ENV=test) fetches `getDispute`, fires `onJobDisputed(job, reason, deadline_at)`, sends a chat message containing the deadline, and calls no `respondToDispute` (surface-only). Startup with `status:'disputed'` routes into the post-delivery reconnect (flow-guard unit).
- SDK (`test/dispute-deadline-type.test.ts`): `DisputeDetail` accepts the three new fields; `onJobDisputed` type accepts `(job, reason, deadline)`.

---

## Decisions (locked)

1. **Branch/sequencing:** money-safety merged to `main` (`591ce71`); A+B on a fresh branch; C is a later increment.
2. **Attestation:** opaque passthrough, `acceptAttestationTuple` = `acceptReview` clone allowlisting `review.attestation` (`i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv`). Backend owns bytes.
3. **Dispute auto-response:** surface-only, human has final say. Silent VDXF auto-policy removed; seam left for future autonomy. Deadline-expiry outcome is backend's call.
4. **Deadline source:** worker fetches `getDispute` (authoritative); dispatcher does not plumb the deadline via IPC.
5. **Testability:** build-to-contract now, live-test after backend deploy.

## Resolved coordination facts (from backend owner, 2026-07-18)

- Tuple serialization is backend-owned & opaque: `hex(JSON.stringify({jobHash, buyer, rating, timestamp, msgHash, signature}))`, plain (non-canonical) `JSON.stringify`, key order not load-bearing.
- Inbox item: `{ type:'attestation', recipient_verus_id, vdxf_data: JSON.stringify({ "i76fJX1…": "<hex>" }) }`; inner value a bare hex string (acceptReview normalization handles it).
- `GET /v1/jobs/:id/dispute`: `deadline_at` (ISO|null), `deadline_owner` (`seller|buyer|null`), `deadline_passed` (bool), both top-level and inside the dispute object; countdown is client-side (`deadline_at − now`).

## Rollout

1. Land A+B on the branch; full unit tests both repos.
2. Backend deploys migration 051 + rebuild → endpoints live.
3. Live-test: real job → completion → attestation tuple on agent's ID (A); real dispute after container teardown → respawn → surfaced to operator with deadline (B).
4. Republish SDK; rebuild job-agent image; restart dispatcher.
5. Enable `DISPUTE_RESOLVER_ENABLED` in concert (operator's call, after the settlement product decision).
