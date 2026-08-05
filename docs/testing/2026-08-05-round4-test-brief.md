# Round 4 — test brief

**Date:** 2026-08-05
**Live now:** dispatcher **2.8.1** (`35e3891`), SDK **2.14.1**, MCP **2.2.2** — all on npm.
**Fleet:** 9/9 available, inbox empty, **9/9 dispute policies loaded** (first time ever).
**Runway:** the platform's daily auth outage starts ~04:00 UTC and lasts 50–90 min. **Do not
start a run after ~03:00 UTC** — round 3's wave was swallowed by it and produced no signal.

Read time: 3 minutes.

---

## The three that matter

Everything else is secondary. These are paths that have **never been proven**.

### 1. A fresh agent's FIRST-EVER review  ⟵ highest value

**Why:** until today, no identity could gain a VDXF key it did not already have (contentmultimap
keys must be hash160-sorted; our builder appended). We proved the fix via `update-profile` and
`disputePolicy`, but **never through the inbox path**, which is where reviews are written.

**Targets — these have NEVER had a review** (no `review.record` key at all):

| agent | cmm keys | service |
|---|---|---|
| **agent-11** (`url.agentplatform@`) | 2 | Data Analysis @ 0.5 VRSCTEST |
| **url2** (`url2.agentplatform@`) | 2 | Data Analysis @ 0.5 VRSCTEST |
| agent-4 | 14 | AI Code Review and Development @ 0.5 VRSCTEST |
| agent-1 | 14 | Code Review and Analysis @ 0.5 VRSCTEST |

**Prefer agent-11 or url2** — 2 keys means the write adds a key to a nearly-empty map, the
purest form of the test.

- **PASS:** `[Inbox] ✅ <agent>: N item(s) accepted in tx <txid>`, and `review.record` present
  on that identity afterwards. Key count goes up.
- **FAIL:** `Transaction rejected by the network` with `detail: "-25 - bad-txns-failed-precheck"`
  — that is the ordering bug, and it would mean the fix does not cover the inbox path.

### 2. A dispute, auto-responded successfully

**Why:** `respondToDispute` has **0 successes and 10 failures ever** — every attempt was during
an outage. This is the last gate on `DISPUTE_RESOLVER_ENABLED`; the policy side is now done.

Open a genuine dispute on a delivered job and let the sweep handle it.

- **PASS:** the sweep responds without error and the dispute moves off `disputed`.
- **FAIL / INTERESTING:** any `respondToDispute failed` line — capture the full error.

### 3. A SIGTERM'd container produces a deletion attestation

**Why:** until today this failed on **100%** of abnormally-terminated jobs — both shutdown
handlers used a signing flow the broker correctly refuses, so the privacy proof was silently
absent for `private`/`sovereign` tiers.

Easiest trigger: let a job sit idle past 10 minutes (it pauses and the container is SIGTERM'd).

- **PASS:** `✅ SIGTERM attestation submitted`, and `deletion-attestation-sigterm.json` in the
  job dir.
- **FAIL:** `⚠️ SIGTERM attestation failed: Refusing to sign a J41-protocol-formatted challenge`
  — that means the port did not take.

---

## Secondary, if the run allows

4. **Canary release.** Backend raised the cap to 32 (`CANARY_MAX_PER_AGENT`), so registration
   should now succeed. Expect `[CANARY] Registered with SovGuard` and **no**
   `Maximum ... canary tokens`. On teardown the registration should be released.
5. **Broker review deferral.** Expect `left pending for the host inbox processor (broker mode)`
   instead of `[J41] Unhandled error: Cannot accept review …`. The host sweep should then write
   it — that part already worked, this only removes the noise.
6. **Duplicate-review dedupe.** Re-submit a review that already landed: expect **no new
   transaction and no fee**. Still only unit-proven.
7. **A job with a real conversation.** Most jobs so far had **zero** buyer messages, so the
   executor path is barely exercised. Send several messages before ending the session.

---

## Expected, not bugs

- **`Transaction rejected by the network` right after startup** — `activate-all` and the startup
  activation pass both write the same identities outside the pending-write gate. Platform status
  is already `active`; harmless.
- **`status: degraded`** if anything ever dead-letters. Intentional.
- **Several deletion attestations for one job** if it pauses and respawns — backend confirmed
  `POST /v1/me/attestations` is idempotent on `(agent, job, container)`, so one row per
  container instance is truthful by design.

## Where I'd expect breakage

Ranked.

1. **The first-ever review write (test 1).** The only thing that proves the ordering fix on the
   inbox path. Everything else about that fix is already proven.
2. **Teardown ordering under a short kill window.** Attestation then canary release are two
   sequential network calls inside a 5s SIGTERM grace. Ordering is correct (proof first), but
   only a live kill shows whether both fit.
3. **`getJob` retry.** Only visible if the platform degrades mid-run. If you see
   `[RETRY] getJob attempt N/5`, that is the fix working — a container that would previously
   have died.
4. **Dispute auto-respond (test 2).** Never once succeeded.

## Reference

- Log: `/tmp/claude-1000/-home-mainn-dispatchertest3/bde9e6e4-e39f-4600-b331-d9889160ce2a/scratchpad/dispatcher-0730.log`
- Watch:
  `tail -f <log> | grep -E "item\(s\) accepted|Transaction rejected|DEAD-LETTER|attestation|CANARY|respondToDispute|left pending for the host|RETRY"`
- Health: `curl -s http://127.0.0.1:9842/health | jq '.inbox, .version'`

Tests: SDK 393/393, dispatcher 637/637.
