# Round 4b — prove the container fixes, then the dispute mechanism, then flip the flag

> ## STATUS as of 2026-08-05 06:35 UTC
>
> | Phase | Result |
> |---|---|
> | 0 preconditions | ✅ **PASS** |
> | 1 container fixes | ⏳ **NEEDS THE TESTER** — requires a buyer to hire and then let a job idle out |
> | **2 manual dispute response** | ✅ **PASS — the gate is cleared** |
> | 3 flip the flag | **Ready**, pending two answers from backend (below) |
> | 4 verify | not started |
>
> **Phase 2 succeeded on the live dispute for job `0ac21f76`** — the first time a dispute
> response has ever gone through. Details in the Phase 2 section.

**Date:** 2026-08-05
**Live:** dispatcher 2.8.1, SDK 2.14.1, job-agent image `f3b83fee` (rebuilt, SDK 2.14.1 inside)
**Fleet:** 9/9 available, inbox empty, 9/9 dispute policies loaded
**Window:** the daily auth outage (~04:00-05:30 UTC) has already passed for today — roughly
21 hours of clean runway. No time pressure; the next window is 2026-08-06 ~04:00 UTC.

---

## Why this plan exists

I previously reported "`respondToDispute`: 0 successes, 10 failures" as a blocker on
`DISPUTE_RESOLVER_ENABLED`. **That was the wrong measurement.** Those ten were the
*refund sweep* failing during an outage — a different code path with a different purpose.

Tonight's dispute made the distinction concrete: `selectRefundableDisputes` deliberately
**excluded** job `0ac21f76` because it had a real delivery and 730 tokens. That sweep only
auto-refunds paid-and-got-nothing. It behaved correctly.

Quality disputes are the *resolver's* job. So the honest position is:

- The **mechanism** (seller signs and submits a dispute response) has never been proven.
- The **automation** (resolver decides and triggers it) cannot be tested with the flag off.

Those are separable, and the first can be proven manually **right now**. That is what makes
flipping the flag a small step rather than a leap.

---

## Phase 0 — preconditions (2 min)

```bash
curl -s http://127.0.0.1:9842/health | jq '{v:.version.dispatcher, img:.version.jobAgentImage, inbox}'
```
- dispatcher **2.8.1**, image **f3b83fee…**, all inbox buckets **0**
- `date -u` — abort if within 45 min of 04:00 UTC

---

## Phase 1 — prove the container fixes (unblocked by the rebuild)

Everything here was untestable until the image was rebuilt; the old one had SDK 2.10.0/2.12.0
and none of these fixes.

**1a. Deletion attestation on SIGTERM.** Hire any agent, then let the job idle past 10 min so
the container is SIGTERM'd.
- **PASS:** `✅ Deletion attestation submitted (deletion-attestation-sigterm.json)`
- **FAIL:** `Refusing to sign a J41-protocol-formatted challenge` — the port did not take.
- Failed on **100%** of abnormal terminations before today.

**1b. Canary registers and releases.** Same job.
- **PASS:** `[CANARY] Registered with SovGuard`, then a release on teardown. No
  `Maximum ... canary tokens` (backend raised the cap to 32).
- **FAIL:** registration warns that leak detection is DISABLED.

**1c. Broker review deferral.** Any job that receives a review.
- **PASS:** `left pending for the host inbox processor (broker mode)`
- **FAIL:** `[J41] Unhandled error: Cannot accept review …` — that is the old SDK.

**1d. `getJob` retry** — opportunistic. `[RETRY] getJob attempt N/5` only appears if the
platform hiccups. Do not force it.

---

## Phase 2 — prove the dispute MECHANISM manually  ⟵ the real gate

There is a live dispute already open, which is the ideal first case:

```
job     0ac21f76-436a-4ebe-9c19-0a7fac4d387a   (agent-6, 0.005 VRSCTEST)
dispute 41d723fa-73b9-438e-956c-686a3fb92ac5   action=pending
reason  "the swamp tale was too short and off-topic. Requesting rework or partial refund."
```

Respond as the seller, using the agent's own on-chain policy (`defaultAction: rework`):

```bash
node src/cli.js respond-dispute 0ac21f76-436a-4ebe-9c19-0a7fac4d387a \
  --agent agent-6 \
  --action rework \
  --rework-cost 0 \
  --message "Rework offered at no additional cost per on-chain dispute policy (defaultAction=rework)."
```

**Deliberately `rework`, not `refund`** — it matches the policy the resolver would apply and
moves no money, so a mechanism test cannot become a money incident.

- **PASS:** command succeeds; `getDispute` shows `action` moved off `pending`; the buyer sees
  the response.
- **FAIL:** capture the full error including `error.detail`. A signature or state-machine
  error here is a genuine blocker and the flag should NOT be flipped.

**This is the step that has never succeeded.** If it passes, the resolver is automating a
proven mechanism.

### ✅ RESULT — PASS (2026-08-05 06:35 UTC)

Ran exactly the command above. State before → after:

| field | before | after |
|---|---|---|
| `action` | `pending` | **`rework`** |
| `deadline_owner` | `seller` | **`buyer`** |
| `rework_cost` | — | `0` |
| seller response | none | full statement recorded |
| `refund_txid` / `refund_owed` | null | **null — no money moved** |
| `outcome` | `pending` | `pending` |
| `resolved_at` | null | null |

Everything the state machine should do, it did: the signed seller response was accepted, the
action matches the agent's on-chain policy, **the deadline passed to the buyer**, and funds
were untouched. `outcome` and `resolved_at` stay pending because the buyer must now accept or
reject the rework — correct, not a stall.

**The dispute-response mechanism is proven.** The resolver would be automating this, not
something unproven.

**Retracting an earlier blocker:** I previously cited "`respondToDispute`: 0 successes, 10
failures" against flipping the flag. Those ten were the *refund sweep* failing during the
04:00 outage — a different path with a different job (auto-refunding paid-and-got-nothing).
That measurement never said anything about dispute responses. It does now, and it passes.

---

## Phase 3 — flip `DISPUTE_RESOLVER_ENABLED` (backend, operator call)

**Phase 2 has passed, so this is unblocked from our side.**

**Before flipping, get two answers from backend:**
1. With `defaultAction: rework`, can the resolver **move funds**, or only offer rework? If it
   can refund on a rework policy, say so explicitly first.
2. Is it per-seller or global? Prefer **per-seller**, starting with **agent-6** alone.

**Then:** flip it, and file **exactly one** new quality dispute as the observed first case.
Do not batch.

- **PASS:** the resolver responds within a sweep cycle, the action matches the on-chain policy
  (`rework`), and no funds move unexpectedly.
- **WATCH:** any refund. Cross-check the amount against the job and the policy's
  `maxRefundPercent: 100`.

**Rollback:** backend un-flips. Our side needs no change — the policy stays on-chain and
inert, which is exactly the state we were in this morning.

---

## Phase 4 — verify and record

```bash
# dispute resolved as expected
node -e "…getDispute(jobId)…"        # action, resolution, amounts
# no money moved unexpectedly
node src/cli.js refunds list          # approval queue must not have grown
# nothing broke elsewhere
curl -s http://127.0.0.1:9842/health | jq '.inbox, .status'
```

Record the outcome in `docs/testing/` and tell backend either way.

---

## Order and timing

| Phase | Time | Blocking? |
|---|---|---|
| 0 preconditions | 2 min | — |
| 1 container fixes | ~15 min (10 of it waiting for the idle timeout) | no — independent of the flag |
| **2 manual dispute response** | ~5 min | **YES — gates phase 3** |
| 3 flip + one observed case | ~10 min | needs backend |
| 4 verify | 5 min | — |

Phases 1 and 2 are independent; run 2 first if time is short, since it is the gate.

## What would make me say stop

- Phase 2 fails on anything other than a transient network error.
- Phase 1a still shows the broker refusal — that would mean the image did not take, and it
  would put the deletion-attestation claim in the backend report in doubt.
- We are inside 45 minutes of 04:00 UTC. Every prior dispute failure happened in that window,
  and a failure there tells us nothing.
