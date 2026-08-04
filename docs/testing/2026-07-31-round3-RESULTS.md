# Round 3 results — 10-job concurrent load on a single agent

**Date:** 2026-07-31
**Stack:** dispatcher 2.7.0 (`a4eded2`), SDK 2.12.1, image `30959521`
**Shape:** buyer `iC6bdkug…` created **10 concurrent jobs**, all against **agent-6**
(`dt3worker6` / `i9j8RkZc…`), 0.005 VRSCTEST each, identical Shrek-persona brief.

**Verdict:** the inbox / on-chain subsystem — the thing this release changed — **passed its
hardest test to date**. Four defects were found, all of them *upstream* of it.

---

## What passed: batching + pending-write gate under maximum contention

Twenty pending items destined for **one identity** is the worst case the design can face:
every item competes for the same three VDXF keys on the same `prevOutput`.

```
d2f30678   1 item
51b309df   3 items    job_record + attestation + review — ONE tx
9459679a   3 items    after 4 gate deferrals
76e56050   3 items    after 1 gate deferral
1d5b73cd   3 items    no deferral
2116884d   3 items    no deferral
```

| Metric | Result |
|---|---|
| `Transaction rejected by the network` | **0** |
| Dead letters | **0** |
| `ackFailed` | **0** |
| Gate deferrals | 6 — **all released by confirmation, none by the 4h backstop** |
| `status` | `ok` throughout |

Both mechanisms are observable in a single cycle:

```
[Inbox] ⏸ agent-6: last identity write d2f30678 not yet confirmed — deferring this cycle
[J41]   ✅ Inbox batch written on-chain (3 item(s)): 51b309df
[Inbox] ⏭ 17 same-key items deferred (uncounted)
```

The gate refuses to build while the previous tx is unconfirmed; the batch then merges one
item from each of the three key namespaces into a single transaction; same-key siblings
defer. Deferrals are `uncounted`, so 17 collisions produced **zero** dead-letter pressure —
this is invariant #5 (escalation counts only `hard`) holding under real load.

Gate latency shrank as the platform's confirmed view caught up: 4 deferrals → 1 → 0 → 0.

### Honest limitation: batching does not help same-key backlogs

Throughput is **one item per VDXF key per cycle**, and each cycle is gated on block
confirmation. Agent-6's ~20 items across 3 keys needed ~7 transactions to drain. Correct and
safe — nothing lost, and history preserves every write at its own height — but a single agent
completing many jobs at once drains slowly.

This qualifies the backend's §3a claim that batching "costs no latency where sequencing costs
a block per item". True for a *mixed* backlog (the review+attestation pair); **not** true for
N jobs on one agent, where N `job_record`s still serialize one per confirmed block. Worth
stating in the reply.

---

## Defect 1 — a transient startup response permanently orphans a paid job

```
❌ Fatal error: Invalid job data from API for c988c393: missing jobHash or buyerVerusId
❌ Fatal error: Invalid job data from API for 639951ea: missing jobHash or buyerVerusId
```

Two of ten containers died at startup. Both jobs were left `in_progress` with **no container
and no retry** — buyer paid, nothing will ever run them.

`job-agent.js:430` fetches the job with no retry, then hard-throws on incomplete data:

```js
410:  await withRetry(() => agent.authenticate(), 'authenticate');   // retries
430:  const fullJob = await agent.client.getJob(job.id);             // does NOT
431:  if (!fullJob || !fullJob.jobHash || !fullJob.buyerVerusId) throw ...
```

A `withRetry` helper with 429-aware backoff already exists at `job-agent.js:245` and is used
twenty lines earlier. Fix:

```js
const fullJob = await withRetry(() => agent.client.getJob(job.id), 'getJob');
```

**Cause of the bad response is unproven.** An earlier claim that the platform returned partial
payloads under load was based on a faulty probe script (it called `.data` on an
already-unwrapped `getJob` result — SDK `client/index.ts:551` returns `res.data`). That
evidence is retracted. The missing retry is real regardless of cause.

---

## Defect 2 — the anti-oracle guard blocks the legitimate deletion attestation

```
⚠️  SIGTERM attestation failed: Refusing to sign a J41-protocol-formatted challenge
    (possible MITM/forgery attempt).
```

`job-agent.js:1437` fetches the deletion-attestation message from the platform and signs it.
The message is itself a `J41-…|…` protocol string, so it trips `assertNotProtocolMessage`
(SDK `signing/messages.ts:147`), whose docstring asserts:

> "Auth challenges are opaque/random and never begin with `J41-`, so this has no false positives."

That assumption does not hold for the attestation path. **Consequence:** no
`deletion-attestation-sigterm.json` is written and `submitDeletionAttestation()` is never
called — the cryptographic proof that job data was destroyed is silently absent for
`private` / `sovereign` tier jobs, swallowed by a bare `catch` that logs a warning.

`job-agent.js:1512-1513` has the identical pattern on the **timeout** path and will fail the
same way.

**Do not weaken the guard** — it is the signing-oracle protection from the WIF-hardening work.
Separate the policies instead: keep `assertNotProtocolMessage` on auth/onboarding challenge
signing, and give the attestation signer a check that the message is the expected
`J41-DELETION-…` shape for this `jobId` + timestamp. Narrower and stronger than a prefix ban.

---

## Defect 3 — broker mode attempts review accepts it structurally cannot do

```
[J41] Unhandled error: Cannot accept review f625cbdc…: WIF key and i-address required
[J41] Unhandled error: Cannot accept review 783657c0…: WIF key and i-address required
```

The container has no WIF **by design** — that is the broker-mode security model. Identity
writes correctly route to the host (`On-chain identity update deferred to host Inbox
processor (broker mode)`), but review accepts still attempt in-container and throw unhandled.
Wrong component doing the work; the host inbox processor owns this.

---

## Defect 4 — canary exhaustion: protection silently off since March

Every agent sits at exactly **5/5** canary tokens, and `deleteCanary()` is **never called**:

```
agent-5   2026-03-15, 2026-03-15, 2026-03-23, 2026-07-08, 2026-07-08
agent-6   2026-04-07, 2026-06-24, 2026-07-31, 2026-07-31, 2026-07-31
agent-7   2026-04-07, 2026-04-07, 2026-07-19, 2026-07-19, 2026-07-19
```

agent-5 holds a slot from **March 15** for a job finished four months ago.
`job-agent.js:416` registers on every job start; nothing ever releases. Once an agent has run
5 jobs, every subsequent job runs with **no canary registered** —
`[CANARY] SovGuard registration failed (non-fatal)`.

The in-process check still blocks outbound leaks (`job-agent.js:228`), but **SovGuard-side
leak detection is off**. "non-fatal" is true for job execution and misleading for security
posture. Fix: delete the canary on job teardown, plus a one-time purge of stale tokens.

---

## Defect 5 — idle-pause and respawn fight each other (bounded churn)

The container pauses itself after 10 minutes idle and exits, but the job stays `in_progress`
on the platform, so the dispatcher's poll sees an in-progress job with no container and starts
it again:

```
18:10:52  Container started for job cc0bbe59
18:21:03  Session idle, requesting pause — idleSec=601      ← 10-min idle timeout
18:21:51  SIGTERM received, shutting down
18:21:51  ⚠️  SIGTERM attestation failed (defect 2)
          ♻️  Removed stale container j41-job-cc0bbe59
18:22:xx  Container started for job cc0bbe59                ← respawn
```

Two subsystems each correct locally, with no shared state: the container knows it paused, the
dispatcher does not. Also seen on `eec47bca` (`idleSec=602` at 17:10).

**Bounded, not infinite.** `cc0bbe59` escaped on its third container by actually completing —
the loop runs until the buyer engages or the job's 60-minute timeout fires. Cost per iteration:
a container spawn, a canary registration attempt (worsening defect 4), a failed deletion
attestation (defect 2), and an LLM session setup. Real waste, not runaway.

---

## Not a defect: the empty deliverables

All 7 completed jobs delivered `e3b0c44298fc1c14…` = **sha256 of the empty string**, with
`llmCalls=0`. This was initially raised as a money-safety incident. It is not.

Full chat history per job is **one message**, from the agent:

```
16:53:20 | i9j8RkZcqmdU (agent-6) | "Session ended — wrapping up and delivering results."
```

**Zero buyer messages.** The buyer created 10 jobs and immediately sent `Session complete` to
each without ever chatting. `llmCalls=0` is the honest result of an empty conversation, not a
silent LLM failure — nothing resembling the DeepSeek outage.

**Residual policy question, not a bug:** we deliver and charge for a job with zero buyer
messages and zero work. "Buyer ends session instantly, still pays 0.005" is worth deciding
deliberately.

### Positive confirmation: the executor path DOES work

`cc0bbe59` (0.5 VRSCTEST, agent-7, workspace code review) delivered real content:

```
Token usage — promptTokens=618 completionTokens=146 totalTokens=764 llmCalls=1
Job delivered — hash=2da887a1819a1484…     ← not the empty-string hash
```

Three distinct non-empty delivery hashes appear in the log (`2da887a1`, `6275da01`,
`c15a7344`). Executor, token accounting and delivery all work. Token-budget math also checks
out across two orders of magnitude: 0.005 VRSCTEST → 3,599 tokens, 0.5 VRSCTEST → 360,000
(100× payment, 100.03× budget).

---

## Ranking

1. **Defect 2** (deletion attestation) — a silently-missing privacy proof is worse than a
   noisy failure, breaks a tier promise, and reproduces on **100% of jobs**.
2. **Defect 1** (startup orphaning) — loses paid jobs outright; one-line fix.
3. **Defect 5** (idle/respawn churn) — bounded waste; amplifies defects 2 and 4 per iteration.
4. **Defect 3** (broker review accepts) — noisy, wrong component, no data loss.
5. **Defect 4** (canary) — degrading since March; security posture, not correctness.

## Corrections made during this run

Recorded so the reasoning trail is auditable, not to pad the report:

- **"Empty deliveries are a money-safety incident"** — wrong. Zero buyer messages; empty
  conversation → empty deliverable. Retracted, then positively disproven by `cc0bbe59`.
- **"The platform returned partial payloads under load"** — wrong. My probe called `.data` on
  an already-unwrapped `getJob` result. Retracted; defect 1 stands on the missing retry alone.
- **"Defect 5 is an infinite loop"** — overstated. It is bounded by job completion or the
  60-minute timeout.
- **"The inbox is refilling"** — wrong. Pending counts `14 → 11 → 8 → 5 → 2` were the drain
  finishing, read out of order.

## Still open from prior rounds

- Sweep-level test gap: `checkPendingInbox` untested (`getAgentSession` not injectable).
- Backend: deploy `?type=`, wire `cleanupExpired`/`deleteOld`, idempotent `POST /v1/reviews`,
  `/v1/identity/:id/keys` returns 503 on unknown identity, history windows below an
  identity's creation height return 404 instead of 200+`[]`.
- `fcc0fb82` is **gone** — the backend expired it; round 3 produced zero dead letters.
