# Dispatcher reply — §5b closed, history endpoint integrated, batching live-proven

> **Read order note (added 2026-08-04, at push time).** This was written 2026-07-30 and is
> being published now, after your 2026-08-04 response. Several items in it have since been
> overtaken by events and need no action:
> - The `getidentityhistory` section is **satisfied** — you shipped it, we integrated it, and
>   it is verified working.
> - Idempotent `POST /v1/reviews` is **shipped** — your tester confirmed it (their item 6).
> - The `/keys` 503 and the below-creation-height 404 are **both fixed** in `7ffd3fb`; we
>   re-probed and they pass.
>
> What is still live from this document: §3d (`fcc0fb82` needs expiring), §3c
> (`cleanupExpired` / `deleteOld` still unwired — 330 expired-but-pending rows), the
> declined merged-pair offer, and the §3a batching evidence. Everything else is context.

**Date:** 2026-07-30
**From:** dispatcher
**Re:** your findings of 2026-07-29 (`2026-07-29-backend-findings.md`), including the §5 addendum

Everything below is grounded in code we read, or in live chain/API data we fetched
read-only on 2026-07-29 and 2026-07-30. Where something is ours we say so; where it's
yours, likewise.

**First, your §1.** You re-queried rather than taking our correction on trust, and you
owned the relayed misdiagnosis without being asked. That's the right instinct and it saved
us both time — thank you. It's also directly relevant to §5b below, so we've flagged the
attribution pattern once, factually, and left it there.

---

## TL;DR — what actually needs doing

| # | Item | Owner | State |
|---|---|---|---|
| 1 | §5b review-history loss | — | **Not a bug, and nothing was lost even apparently.** `fed0564a` was never on w7 — it is on **w3**, intact. Details below. |
| 2 | `getidentityhistory` endpoint | you → done | **Shipped by you, integrated by us.** SDK 2.12.1 on npm, verified against your live endpoint. Two small contract questions remain. |
| 3 | §3a batching + confirmation gate | us | **Shipped and live-proven** — dispatcher 2.7.0 / SDK 2.12.1. Round-2 evidence below. |
| 4 | §3a merged-pair emit | — | **Declined, with thanks** — it would break the deployed per-type gates. Keep emitting two items. |
| 5 | §5a on-chain dedupe by job_hash | us | **Shipped** in SDK 2.12.1 (unit-proven; not yet hit by live traffic). |
| 6 | §5a idempotent `POST /v1/reviews` | you | Requested — still open. |
| 7 | §3c `?type=` filter | you | Merged, not deployed. **We already send it** — no-op until your deploy. |
| 8 | §3c `cleanupExpired` / `deleteOld` | you | Requested — still open, and it's the root cause, not the symptom. |
| 9 | §3d `fcc0fb82` | you | Legacy pre-VDXF item on **w5**, expired 07-15, re-dead-lettered during round 2. Please expire it. |
| 10 | §2 presence verifier | you → done | Shipped and working. No change needed; our array-shape warning is **withdrawn**. |
| 11 | `/v1/identity/:id/keys` → 503 on unknown identity | you | New, small. See the last section. |
| 12 | History window below an identity's creation height → 404 | you | New, small. See the last section. |

---

## §5b — closed. Not data loss, and the observation itself was a misattribution.

Both your questions, answered plainly, then the part that matters.

**(1) How are review VDXF keys allocated?** One fixed key per record *type*, never one per
review. `review.record` is the single i-address `iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad`
(SDK `src/onboarding/vdxf.ts`). Same for `review.attestation` and `job.record`.

**(2) Read-merge-append, or replace?** Replace. `buildIdentityUpdateTx` copies the existing
contentmultimap then does `currentCmm[key] = [...values]` (SDK `src/identity/update.ts`).
The accept paths pass only the new item's `vdxfData`, so the key's prior array is replaced.

### So current state holds one review per agent — uniformly, not just on w7

Your tester read w2 and w5 as "accumulating" because their *total key count* grew (20→21,
19→20) — but that was `review.record` being **new** on those identities. Nothing
accumulated under it. w7 already had the key, so its count stayed at 13. Same behaviour
everywhere; there is no per-agent difference to explain.

### `fed0564a` was never on w7. It is on w3, and it is still there.

This is the part we'd ask you to carry back to your tester. We ran a full history decode
across all four agents today:

```
w2  i5Wpjy…  100 snapshots (975250..1167637)   3 reviews
w3  iDP6VU…   60 snapshots (975250..1152780)   2 reviews  ← fed0564a62452c35 @ h=1152780, rating 5
w5  iP7b8u…   70 snapshots (977111..1167637)   2 reviews
w7  iMRMgH…   33 snapshots (1009251..1169130)  4 reviews  ← 5adae459, a4ccfe16, 7b80ec60, ac5092e2
```

`fed0564a…` appears **nowhere in w7's history at any height**, and is present and intact on
w3 today. What w7's history actually shows being overwritten is its own earlier review
`5adae459` (h=1153052), replaced by `a4ccfe16` — and that one is fully recoverable too.

So there was never any loss to explain, not even apparently. **§5b is closed; no fix is
required on either side.**

### The attribution pattern — raised once, not as blame

This is the third cross-agent misattribution in this exchange: `f0e45735` reported as w7's
when it was w2's (your §1), `fed0564a` reported as lost from w7 when it is w3's and intact,
and §1's whole per-agent theory resting on the first. It has cost two investigation cycles
and nearly cost more — see immediately below. Worth a check against `recipient_verus_id`
before a per-agent claim goes out. That's the whole of it; no hard feelings on our side,
and we made a worse mistake in the same window.

### We nearly shipped a harmful "fix", and you should know why

Our first draft accepted §5b as our P1 data-loss bug and planned a read-merge-append fix for
SDK 2.13.0. The facts we'd verified were right — single fixed key, replace semantics — but
we concluded "history destroyed" without checking whether the chain retains prior states.
It does.

Shipping that would have been actively harmful: appending every review into one
contentmultimap value drives it straight at the ~5.5KB per-value truncation cliff that
`assertContentmultimapValueSizes` exists to guard, where values are silently truncated
on-chain with no RPC error. We would have manufactured the exact data loss we thought we
were fixing. The append change is **cancelled**; nothing is moving to array shape.

---

## The history endpoint — received, verified, integrated. Thank you.

You shipped this between our draft and this reply, so an earlier version of this document
asked you to build it. Disregard that; it's here and it works.

Verified live today, authenticated as `dt3worker7.agentplatform@`:

```
GET /v1/me/identity/history              → 200, 33 snapshots
GET /v1/identity/:iaddr/history          → 200, 33 snapshots
  snapshot keys: identity, blockhash, height, output
  oldest-first: 1009251 → 1169130
  identity.contentmultimap present and unmodified on every snapshot
  heightStart/heightEnd honoured
```

Against the four requirements we'd drafted: chronological oldest-first with height — **met**;
contentmultimap present and unmodified — **met**; height ranges honoured — **met** (one edge
case below); `txproofs` — not needed. You chose the `height` field name and a thin
passthrough, which is exactly right. Our client accepts either `height` or `blockheight`.

**Integrated and published:** SDK **2.12.1** on npm — `J41Client.getIdentityHistory()`,
`extractVdxfHistory()`, `decodeReviewHistory()`. 370/370 green. The decode above is that
code running against your endpoint.

`decodeReviewHistory` deduplicates by `jobHash` keeping the **earliest** height — deliberate,
because your review re-submit isn't yet idempotent (§5a), so the same review can appear more
than once and the first write is the one that happened. An undecodable entry is skipped
rather than aborting, so one malformed legacy value can't cost an agent its whole history.

### Two contract questions we couldn't answer by probing

1. **Known identity with zero updates → 200 + `[]`?** We had no such identity to test. This
   one matters: our client treats 404 as "this platform cannot serve history", so if an
   empty history 404s we can't distinguish "no reviews" from "endpoint missing".
2. **Are `heightStart` / `heightEnd` inclusive at both ends?** We'll page on whatever you
   confirm.

### Auth posture — one question, sharpened

The `:identityOrIAddr` path returns **401 unauthenticated**, so you've made it authenticated
rather than public. That's a reasonable call and we're not asking you to change it. The
question it leaves: **can an authenticated *buyer* read a *seller's* history?** Reputation is
read by buyers about sellers, so if the endpoint only serves the identity reading itself, the
verifiable-reputation path doesn't close. We've built against both postures — just tell us
which it is.

---

## §3a — shipped, and round-2 live-proven

- **SDK 2.12.1**: `J41Agent.acceptInboxBatch()` merges all of an agent's pending
  review/attestation/job_record items into **one** `updateidentity` tx, each item gated
  against its own type allowlist before merging, with per-item failure buckets
  (rejected / deferred / ackFailed / alreadyDone).
- **Dispatcher 2.7.0**: `processInboxForAgent` orchestrates the batch, plus a **per-identity
  pending-write confirmation gate** — no second identity tx is built until the platform
  serves our last txid as `prevOutput`, or the tx provably expired by chain height. Chain
  contention never burns the dead-letter budget. Dead-letter state is surfaced structurally
  in `/health` and via `ctl inbox` / `ctl inbox-redrive`.

**Round 2, live:**

| Evidence | |
|---|---|
| 3 items in one tx | `d1ccda06` |
| **1 attestation + 1 review in one tx** | `5aca76cb` — the exact pair from your §3a |
| Consecutive blocks sequenced by the gate | 1169129 / 1169130 — under the old code the second was a guaranteed double-spend rejection |
| Network rejections | **zero**, all run |
| Deferral correctness | `e99c94ae` deferred one cycle, written the next, never dead-lettered |

One design note so the behaviour isn't mistaken for a defect later: when two items share the
**same** VDXF key in one cycle (two reviews, two attestations), the second **defers to the
next cycle** rather than merging — because `buildIdentityUpdateTx` replaces a key's array
rather than appending, so merging them would silently drop one. Different keys — an
attestation and a review — merge cleanly, as `5aca76cb` shows. So expect an occasional pair
of consecutive transactions; that's the gate doing its job, not contention.

On round 1: your three dead-lettered reviews recovered and wrote. Our restart cleared the
process-lifetime dead-letter map and re-queued them, and the batch path landed them —
consistent with your §5.0. Your manual re-submits from §5a were in flight the same
afternoon, so we won't claim which write won for each item.

Your citation "`cli.js:6344-6349` … no per-identity confirmation gate" described the
pre-2.7.0 code; that logic now lives in `processInboxForAgent`.

### Your merged-pair offer: thank you, but please don't

Two reasons, one of them hard:

1. **It would break every deployed SDK's security gate.** Inbox accepts allowlist an item's
   `vdxf_data` against its own type: `review` admits exactly `[review.record]`, `attestation`
   exactly `[review.attestation]` (SDK `src/inbox/vdxf-gate.ts` — this is the 52f8d07 audit
   property). A merged item carrying both keys under one type would have its second key
   **dropped** by every 2.12.0-and-earlier dispatcher — creating precisely the silent-drop
   scenario you hypothesised in §3d. We won't widen an allowlist to accommodate it.
2. **It buys nothing now.** Batching already writes the pair, plus any job_record, in one
   transaction with one fee.

Keep emitting the two items exactly as you do today.

---

## §3d — corrected diagnosis. Not what you thought, and not w7's.

We fetched `fcc0fb82` live:

- It is on **w5** (dt3worker5), not w7. Type `review`, jobHash `e27f527f…`, created
  2026-07-08, **expired 2026-07-15 — and still `pending`.** It re-dead-lettered during our
  round-2 run, as expected.
- Its `vdxfData` keys are `["jobId","rating","message","isPublic"]` — **raw JSON field names,
  not VDXF i-addresses.** It predates your VDXF pre-formatting. Every key fails the
  allowlist, so the accept throws loudly before any transaction is built, classifies as a
  hard failure, and dead-letters after 5 attempts.
- **Your hypothesis — "the allowlist drops the attestation key silently" — is wrong**, for
  this item and for the current wire format generally. Review and attestation arrive as
  separate inbox items, each gated against its own type. Nothing in the normal path drops a
  key silently: same-item cross-namespace keys are dropped with a loud tampering warning, and
  the attestation key never appears inside a `review` item today. (The one change that *would*
  create that drop is the merged pair — see above.)

**Ask:** this item is permanently invalid; no dispatcher change can ever make it valid.
Enforce `expires_at` (your `cleanupExpired` wiring from §3c covers it) or cancel it outright.
Nothing needed on the format — everything emitted since the VDXF pre-formatting change gates
cleanly.

---

## §5a — agreed on both halves

**Yours:** yes please, make `POST /v1/reviews` idempotent on `(agent_verus_id, job_hash)`.
That removes the duplicate at source. Still open.

**Ours: shipped** in SDK 2.12.1. We previously said this would ship *fused* to the §5b append
fix; that fix is cancelled, so the entanglement is gone and dedupe stands on its own merit —
it avoids a redundant identity write and its 10,000-sat fee whenever a review is re-emitted.

We already had a partial mechanism, `valueAlreadyOnChain`, which compares whole values via
`JSON.stringify` and so catches a byte-identical re-emit but not one differing in any field
while carrying the same `job_hash`. `jobHashAlreadyOnChain` is the stronger form and is now
in the batch path.

Honest limit: round 2 produced no duplicate-review event, so this is unit-proven, not yet
exercised by live traffic.

---

## §3c — confirmed live, and our half is already shipped

Live probe: w5 had 77 pending items (35 job_request, 26 job_accepted, 11 job_delivered,
4 notification, 1 review); the one actionable review sat at index 15 of our 20-row
newest-first window — one burst of informational traffic from invisible. w2: 50+ pending,
zero actionable. Your starvation maths checks out.

- **Ours: shipped.** Dispatcher 2.7.0 already sends
  `?type=review,attestation,job_record` on every poll. Unknown params are ignored, so it's a
  no-op until your deploy. Please confirm the param name and comma-separated format match
  what you merged, and tell us when it's live.
- **Yours: please also wire `cleanupExpired` / `deleteOld`.** 330 expired-but-pending rows
  platform-wide is the actual root cause; the filter treats the symptom. It also disposes of
  `fcc0fb82`.

---

## §3b — noted; keeping restart-as-clean-retry, persistence for visibility only

A restart costs at most 5 no-fee gate attempts per poisoned item before re-quarantine, and
`ctl inbox-redrive` + `/health` already give operators control and visibility within a
process lifetime. We'll likely persist the failure map cheaply so attempt history survives
deploys, but it's visibility rather than correctness — and if your expiry enforcement lands
first, the long-lived-poison population this would track goes to roughly zero.

---

## §2 — your verifier shipped and worked. Nothing needed from us.

Your §5.0 shows it completed exactly the three genuinely-present reviews and only those,
logging `Inbox review confirmed present on seller identity`. Verify-by-presence was the right
call — our ack txid is best-effort and you were right not to trust your own insert.

**Our earlier array-shape warning is withdrawn** — the append change is cancelled, so nothing
is moving to array shape and no coordination is needed.

One behavioural note, not a defect: because it checks *current* state, it will confirm the
newest review and correctly fail to find one since overwritten under the same key. That's
the designed latest-wins behaviour. If you ever want to verify a *historical* review, the
history endpoint you just shipped does it — that's what our decode above uses.

---

## Two new, small findings from probing your identity endpoints

Both found while verifying the history endpoint. Neither is urgent.

**1. History window entirely below an identity's creation height returns 404.**

On a known identity (w7, 33 updates spanning 1009251–1169130):

| Window | Result |
|---|---|
| none / full range | 200, 33 snapshots |
| `1160000-1160001` (mid-range, no updates) | 200 + `[]` ✅ |
| `2000000-2000001` (future) | 200 + `[]` ✅ |
| **`1-2` (below creation height)** | **404 `NOT_FOUND` "Identity not found"** |

Empty windows are handled correctly everywhere except below the identity's birth, where the
daemon resolves the identity at that height and it didn't exist yet. Our client maps every
404 on this path to `IDENTITY_HISTORY_UNAVAILABLE`, so a client **paging backwards** can't
distinguish "paged past the identity's birth" from "this platform doesn't serve history".

**Ask:** return 200 + `[]` like every other empty window, or a distinct error code. Low
severity — forward paging works fine.

**2. `/v1/identity/:id/keys` returns 503 for an unknown identity.**

| Endpoint, unknown identity | Actual |
|---|---|
| `/v1/identity/:id/history` | 404 `NOT_FOUND` ✅ |
| `/v1/agents/:id` | 404 `NOT_FOUND` ✅ |
| **`/v1/identity/:id/keys`** | **503 `RPC_UNAVAILABLE` "verus RPC unavailable"** |

503 means "upstream is broken, retry", so a client will retry forever on a permanently
unknown identity — and it's indistinguishable from a genuine Verus outage, which is the case
we actually need to detect and back off from. **Ask:** 404 for unknown identity, and reserve
503 for a real RPC failure.

---

## Version reference

| | Version | Commit | Tests |
|---|---|---|---|
| `@junction41/sovagent-sdk` | **2.12.1** (npm) | `7b527e4` | 370/370 |
| `@junction41/dispatcher` | **2.7.0** (npm) | `a4eded2` | 614/614 |
