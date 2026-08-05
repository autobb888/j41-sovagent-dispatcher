# Round 4 results — every container fix proven live, dispute mechanism proven, resolver ready

**Date:** 2026-08-05
**Stack:** dispatcher **2.8.2**, SDK **2.14.1**, MCP **2.2.3**, job-agent image `01c1bcd2`
(all on npm, deps pinned).
**Verdict:** all Phase-1 and Phase-2 objectives **PASS**. Phase 3 (`DISPUTE_RESOLVER_ENABLED`)
is ready and needs two answers from backend.

> **⚠️ Round 4 also surfaced a live incident, after the tests above passed.** Three agents ran
> their fee wallets to zero and stopped being able to write on-chain, and three valid inbox
> items were wrongly quarantined as a result. Both the classifier bug and the agents were fixed
> during the round — nothing was lost — and the remaining work is one scheduled sweep. Full
> account in **"The fee-tank incident"** at the end. No result above is affected; all of them
> landed on-chain before the wallets ran dry.

---

## Results

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | Fresh agent's **first-ever** review | ✅ **PASS** | url2 cmm keys **2 → 5**, tx `32db7ec4` @ h=1176568 |
| 1a | Deletion attestation on SIGTERM | ✅ **PASS** | job `80f50b01`, 06:54:42, no broker refusal |
| 1b | Canary **register** | ✅ **PASS** | `[CANARY] Registered with SovGuard`, no cap error |
| 1b | Canary **release** | ✅ **PASS** | `[CANARY] ✅ released 7551063e-…` |
| 1c | Broker review deferral | ✅ **PASS** | review landed via host sweep, no unhandled error |
| 1d | `getJob` retry | — | not exercised; no platform hiccup, correctly not forced |
| 2 | Dispute response **mechanism** | ✅ **PASS** | dispute `41d723fa`: `pending → rework`, **no funds moved** |
| 3 | Flip the resolver | **ready** | two questions below |

Six real deliveries with genuine LLM output. Zero broadcast rejections. Three items did
dead-letter late in the round, for a wallet-funding reason unrelated to any test — see the
incident section.

---

## 1 — first-ever review on a near-empty identity

This is the one that mattered. Until 2026-08-04, **no identity could gain a VDXF key it did
not already have** (contentmultimap keys must be hash160-sorted; our builder appended). That
was fixed and proven via `update-profile`, but **never through the inbox path**, which is
where reviews are written.

`url2` had 2 contentmultimap keys and had never received a review:

```
before  2 keys, no review.record / attestation / job.record
after   5 keys — ALL THREE added in ONE tx 32db7ec4 @ height 1176568
        reviews in history 0 → 1  (788cf507, rating 5)
```

No `-25 bad-txns-failed-precheck`. The ordering fix covers the inbox write path.

---

## 1a/1b — the teardown sequence, in order

Job `737c7f14`, complete teardown:

```
Build: job-agent 2.3.0 | SDK 2.14.1
[CANARY] Registered with SovGuard
Deletion attestation signed — submitted=true
[CANARY] ✅ released 7551063e-68c7-4d86-9a27-597e1671a4a3
🗑️  Job data cleaned up (attestation + log preserved)
```

Three design decisions confirmed at once: **attestation before release** (the privacy proof
outranks canary hygiene inside a 5 s SIGTERM grace), `submitted=true` distinguishing
signed-and-submitted from signed-only, and the release naming the exact id it freed — the
slot class that had been leaking since March.

**Before this release:** deletion attestations failed on **100 %** of abnormally-terminated
jobs (the broker correctly refused a `J41-DELETE-…` protocol string), and canary
registrations were never released, so every agent past its 5th job **ever** ran with
SovGuard-side leak detection silently off.

---

## 2 — dispute mechanism proven, and an earlier claim of ours retracted

Responded as seller to the live dispute on job `0ac21f76`, using the agent's own on-chain
policy:

| field | before | after |
|---|---|---|
| `action` | `pending` | **`rework`** |
| `deadline_owner` | `seller` | **`buyer`** |
| `refund_txid` / `refund_owed` | null | **null — no money moved** |
| `outcome` / `resolved_at` | pending / null | pending / null (buyer must accept) |

Deliberately `rework`, not `refund`, so a mechanism test could not become a money incident.

**Retraction.** We previously cited "`respondToDispute`: 0 successes, 10 failures" as a
blocker on the resolver. Those ten were the **refund sweep** failing during the 04:00 outage —
a different path with a different job. It never measured dispute responses.

That distinction was made concrete this round: `selectRefundableDisputes` **correctly
excluded** job `0ac21f76` because it had a real delivery and 730 tokens. That sweep only
auto-refunds paid-and-got-nothing, and it declined exactly as designed. The money-safety guard
works.

---

## Two questions before you flip `DISPUTE_RESOLVER_ENABLED`

Our side is ready: 9/9 agents carry an on-chain dispute policy (`defaultAction: rework`),
surfacing works, and the response mechanism is now proven.

1. **With `defaultAction: rework`, can the resolver move funds, or only offer rework?** If it
   can refund on a rework policy, say so explicitly before flipping.
2. **Per-seller or global?** We'd prefer per-seller, starting with **agent-6** alone.

Then flip it and file **exactly one** quality dispute as an observed first case — not a batch.
Rollback is your un-flip; nothing changes on our side, the policy just goes inert again.

---

## Also for backend

**Confirmation tiers are now reachable.** Everything we listed was ≤0.5 VRSCTEST, so only the
`<2` tier had ever been exercised. Added, all VRSCTEST, all active:

| agent | price | tier |
|---|---|---|
| agent-1 | 2 VRSCTEST | lower bound of 2–10 |
| agent-4 | 6 VRSCTEST | mid 2–10 |
| agent-3 | 11 VRSCTEST | >10 |

A buyer needs ~19 VRSCTEST to exercise all three. Two of those agents have no `review.record`
yet, so one job there proves both the tier and a first-ever key write.

**Still open on your side, unchanged:** `fcc0fb82` expiry (we believe your janitor already
drained it — our 330-row figure was stale, apologies), and confirming the `?type=` filter
deploy.

**Carried buyer finding:** currency-label inconsistency in the signed `J41-JOB` payload —
url2/dt3worker2/5 sign `VRSC` while dt3worker6/7 sign `VRSCTEST` for identical VRSCTEST jobs.
Our service listings are now uniformly VRSCTEST, so if the signed payload still disagrees, the
label is not coming from the service record. Worth confirming provenance in the hire flow.

---

## What we fixed mid-round, and what it cost

Round 4 started against a **6-day-stale container image** with SDK 2.10.0 pinned, so none of
the container fixes were live — the first three SIGTERM attestation failures of the round were
testing undeployed code. Rebuilt mid-round.

Two things came out of that worth keeping:

- The first rebuild produced an image **without** the new teardown module: the Dockerfile
  `COPY`s source files explicitly, not by wildcard, so staging the file was not enough. It
  would have crashed every container with `MODULE_NOT_FOUND`. Caught by inspecting the built
  image rather than trusting a green build.
- Establishing *which* code produced a teardown line took a docker-events dig, because the old
  and new paths emit an **identical** success string — and our first proof of it was invalid
  (the image we inspected was tagged 17 minutes after the container died). Every container now
  prints `Build: job-agent <ver> | SDK <ver>` at startup, so that question is a one-line answer.

Both are the same lesson as the canary release itself: **a step that can fail invisibly will
eventually fail invisibly.**

---

## The fee-tank incident (found after the tests passed)

Late in the round agent-6 began failing every inbox batch:

```
No spendable R-address UTXOs for fee.
Fund RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51 with at least 0.0001 VRSC.
```

It repeated, escalated, and quarantined three **valid** items — an attestation, a review and a
job_record. Fleet survey:

| agent | fee tank (R-addr) | writes left | stranded at i-addr |
|---|---|---|---|
| agent-1…5 | 9–24 VRSCTEST | 90 000–238 000 | — |
| **agent-7** | 0.008 VRSCTEST | **~80** | 3.0 VRSCTEST |
| **agent-6** | **0** | **0 — dead** | 0.135 VRSCTEST |
| **url2** | **0** | **0 — dead** | 0.5 VRSCTEST |
| **agent-11** | **0** | **0 — never funded** | 0 |

### Two separate problems

**1. A dry fee tank was misclassified as the item's fault (ours, fixed).**
The SDK throws this as a bare `Error` — no `code`, no `statusCode`, no match in
`TRANSIENT_PATTERNS` — so `classifyInboxFailure` hit its `hard` default, counted it against the
per-item budget, and dead-lettered three items that had nothing wrong with them. The irony is
that `recordBatchFailure`'s own comment already specified the correct behaviour — it names
*"an unfunded wallet"* as environmental and says such failures *"surface as a persistent
degraded-health signal instead"*. The escalation logic honoured that; the classifier never
agreed with it.

Fixed: funding failures now classify `transient` (never counted, never escalated) and log
`💸 <agent>: FEE WALLET EMPTY — N item(s) stalled, none struck` naming the address, rather than
disappearing into a generic batch-failure line. 4 regression tests; suite 642/642.

**2. Nothing moves earnings into the fee tank (a missing operation, not a protocol limit).**

agent-6's i-address held **27 UTXOs of exactly 0.00500000 VRSCTEST** — its job price, 27 times
over. Job payments land at the **i-address**, because paying the VerusID
`dt3worker6.agentplatform@` resolves there.

Fees, however, can only be paid from the **R-address**. `buildIdentityUpdateTx` filters its
inputs to `u.address === agentAddress`, and that filter is *correct*: an identity output carries
a different script and the identity-update path has no way to sign it.

So the R-address only ever drains — 0.0001 per review, attestation or job record — while every
payment lands somewhere it is never drawn from. Eventually it hits zero and the agent goes
silent on-chain.

**But the funds are not stranded.** `buildPayment` *can* spend i-address inputs: the platform
returns each UTXO's `script`, and the builder passes it to `addInput`. Proven live this round —
three sweeps broadcast and accepted:

| agent | swept i → R | txid | result |
|---|---|---|---|
| agent-6 | 0.1349 VRSCTEST | `4e4f3bf7` | confirmed in 1 block → **1 349 writes** |
| url2 | 0.4999 VRSCTEST | `6b93ec62` | **4 999 writes** |
| agent-7 | — | — | not run (see below) |

So the gap is narrow and cheap to close: **no scheduled i→R sweep exists.** An agent that earns
can already fund itself; nothing tells it to.

*(Three revisions on my side before this held up, each overturned by evidence rather than
argument: first "the wallet is just unfunded"; then "initial funding in the wrong pocket",
trusting `getMyEarnings` — which reports 0.05 across 10 **completed** jobs and badly undercounts
the 27 payments that actually arrived; then "structurally unspendable". That last one came from
grepping a single line of `payment.ts`'s header, `- R-address (P2PKH) inputs and outputs`, and
reading it as the whole statement. It is the first bullet of three; the next two say
`- i-address (P2ID / identity) inputs and outputs` and `- Mixed inputs`. The file documented the
capability correctly and I quoted a third of it. A broadcast settled what my reading had not.)*

### What this needs

### Resolved during the round

agent-6 and url2 were swept from their own earnings and `ctl inbox-redrive` released the three
quarantined items. All three landed on-chain together in batch tx
`345022a43e6068d7bb9e7ee0a2a372eb221c16e839d70a294dccb0e84cce7774`. **Nothing was lost** —
`deadLettered 0`, `retrying 0`, health back to `ok`.

### Still outstanding

- **agent-7** — ~80 writes left, 3.0 VRSCTEST sweepable from its own i-address. Same one-line
  sweep; not yet run.
- **agent-11** — zero at *both* addresses. It has never earned, so it cannot self-fund; it needs
  an external transfer before it can be used for anything.
- **The fix:** a scheduled i→R sweep, triggered on a fee-tank floor (e.g. below ~100 writes) or
  after N deliveries. That makes every earning agent self-sustaining and removes this failure
  mode permanently. Worth pairing with a fee-tank field in `/health` so the floor is observable
  rather than inferred from a batch failure.
- **Minor, for backend:** `getAgentPaymentAddress` returns `{address: "RWoe…" (R), iAddress:
  "i9j8…"}`, advertising the R-address while payments actually arrive at the i-address. Harmless
  now that sweeping is known to work, but the two fields disagree about where money goes.

**For the tester:** `agent-11` was listed in the round-4 brief as a "never had a review" target
for test 1. It has **zero** balance and could never have completed that test — if you had
picked it instead of url2, test 1 would have failed for a reason with nothing to do with the
ordering fix. url2 passed it and then went dry on that very write.
