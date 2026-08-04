# Round-4 prep — fix the five standing defects

**Date:** 2026-08-04
**Stack at start:** SDK 2.13.1, dispatcher 2.7.3, MCP 2.2.1 (all published), fleet 9/9
**Goal:** clear the known defects so round 4 produces signal about the *system*, not about bugs we already know.

Source: `docs/testing/2026-07-31-round3-RESULTS.md`, plus today's audits.

---

## Scope decision

**In scope (4):** D1 deletion attestation, D2 startup retry, D3 broker review accepts,
D4 canary lifecycle.

**Deferred (1):** D5 idle-pause/respawn churn. It is bounded (ends on buyer engagement or
the 60-min job timeout), it needs a shared-state design between container and host, and it
may partly be a platform-side pause-propagation question. Fixing it properly is its own
piece of work; fixing it hastily risks a respawn-suppression bug that strands live jobs.
**Explicitly not being done — say so rather than let it look forgotten.**

---

## D1 — deletion attestation never produced on SIGTERM or timeout  ⟵ highest value

**Symptom:** `⚠️ SIGTERM attestation failed: Refusing to sign a J41-protocol-formatted
challenge`. Observed on 100% of abnormally-terminated jobs. The privacy proof that job data
was destroyed is silently absent for `private`/`sovereign` tiers, swallowed by a bare catch.

**Cause:** two shutdown handlers were never migrated off the deprecated flow.

| Path | Line | Flow | Result |
|---|---|---|---|
| normal completion | `job-agent.js:1814` | `generateAttestationPayload` + `signAttestationWith` (JCS JSON) | ✅ |
| **SIGTERM** | `job-agent.js:~1437` | `getDeletionAttestationMessage` → `J41-DELETE-…` | ❌ refused |
| **timeout** | `job-agent.js:~1512` | same deprecated flow | ❌ refused |

The broker's refusal is **correct** — it is the signing-oracle guard
(`sign-broker.js` → `assertNotProtocolMessage`). Do NOT weaken it.

**Fix:** port both handlers to mirror lines 1814–1853. Extract the shared logic into one
local helper so a third caller cannot drift again. Write the local artifact BEFORE
submitting, as the completion path already does, so a submit failure doesn't lose the proof.

**Risk:** low — copying known-good in-file code.
**Proof:** unit test that both shutdown paths call the JCS signer and never
`getDeletionAttestationMessage`; live confirmation via a SIGTERM'd container in round 4.

---

## D2 — a transient startup response permanently kills a job container

**Symptom:** `❌ Fatal error: Invalid job data from API for <id>: missing jobHash or
buyerVerusId`. Five occurrences, both clusters inside `CHAIN_SYNCING` windows. Container
dies; job is left `paused`/`in_progress` with no worker.

**Cause:** `job-agent.js:430` fetches the job with no retry and hard-throws at :431.
`withRetry` (429-aware, exponential) already exists at `job-agent.js:245` and is used
twenty lines earlier for `authenticate()`.

**Fix:**
```js
const fullJob = await withRetry(() => agent.client.getJob(job.id), 'getJob');
```
Keep the validation throw for genuinely-missing fields after retries are exhausted — the
message should then say the data was still incomplete after N attempts.

**Risk:** very low.
**Proof:** unit test — a `getJob` that fails twice then succeeds must not kill the container;
one that always returns incomplete data must still throw.

---

## D3 — broker mode attempts a review accept it structurally cannot do

**Symptom:** `[J41] Unhandled error: Cannot accept review <id>: WIF key and i-address
required`, unhandled, twice per affected job.

**Cause:** the container has no WIF **by design** (broker-mode security model). Identity
writes correctly defer to the host (`On-chain identity update deferred to host Inbox
processor (broker mode)`), but review accepts still attempt in-container.

**Fix:** in broker mode, skip the in-container accept and log at info level that the host
inbox processor owns it — matching the existing identity-update deferral. Do not add a WIF
to the container.

**Risk:** low, but **verify the host actually picks these up** before calling it fixed —
otherwise this converts a loud error into silent non-delivery, which is worse. Confirm the
item remains `pending` so the host sweep collects it.

---

## D4 — canary exhaustion: SovGuard protection silently off since March

**Symptom:** `[CANARY] SovGuard registration failed (non-fatal): Maximum 5 canary tokens per
agent` on every job past an agent's fifth, ever.

**Cause:** `job-agent.js:416` registers on every job start; **nothing ever calls
`deleteCanary()`** (the SDK method exists at `client/index.ts`). Slots are consumed
permanently — agent-5 still holds one from 2026-03-15.

**Fix:**
1. Delete the job's canary on teardown (normal completion, SIGTERM, and timeout), best-effort
   and non-fatal — never let cleanup failure affect the job.
2. One-off operator sweep to purge stale tokens.
3. Keep the "non-fatal" behaviour on registration failure, but log it at **warn** with an
   explicit note that SovGuard-side leak detection is disabled for that job — "non-fatal" is
   true for execution and misleading for security posture.

**Risk:** low. Deleting a canary for a finished job cannot affect a live one.
**Note:** the in-process `checkForCanaryLeak` guard is unaffected and keeps working.

---

## Execution order

1. **D2** (one line, no design questions) — get it in first.
2. **D1** (mechanical port of known-good code, highest impact).
3. **D4** (teardown hook + sweep).
4. **D3** (needs the host-pickup verification, so last).
5. Full dispatcher suite + SDK suite green.
6. **Fable review of all four**, adversarial, before any release.
7. Release + republish chain, restart, then round 4.

## Guardrails, learned today

- No identity-writing changes in this batch — the ordering fix is fresh and unproven under
  the inbox path; do not stack changes onto it.
- Anything touching signing paths gets the guard left intact and the *caller* changed.
- Declare state before the thing that can call into it (today's TDZ).
- Every "fix" needs a test that can actually fail — today's first attempt at one could not.
