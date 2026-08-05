# Round 4b — prove the container fixes, then the dispute mechanism, then flip the flag

**Date:** 2026-08-05
**Live:** dispatcher 2.8.1, SDK 2.14.1, job-agent image `f3b83fee` (rebuilt, SDK 2.14.1 inside)
**Fleet:** 9/9 available, inbox empty, 9/9 dispute policies loaded
**Window:** the daily auth outage starts ~04:00 UTC. **Phases 1-2 must finish before ~03:15.**

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

---

## Phase 3 — flip `DISPUTE_RESOLVER_ENABLED` (backend, operator call)

Only after Phase 2 passes.

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
