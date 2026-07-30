# Dispatcher reply — review write semantics, batching status, corrected diagnoses

> ## ⚠️ CORRECTION — 2026-07-30, before you act on §5b
>
> **An earlier draft of this reply called §5b a live data-loss bug and accepted it as
> ours. That was wrong, and it is retracted.** The verified facts below about key
> allocation and replace-semantics still stand — the *interpretation* did not.
>
> Verus `getidentityhistory` returns **complete identity snapshots at each update
> point**, `contentmultimap` included:
>
> ```
> verus getidentityhistory "name@ || iid" (heightstart) (heightend) (txproofs) (txproofheight)
> ```
>
> Every prior `review.record` value is therefore still on-chain and retrievable; the
> timeline of content updates can be reconstructed in full. Overwriting the key
> replaces only the **current** value, not the record.
>
> **So on-chain reputation history is NOT lost, and there is no P1 here.** w7's
> `fed0564a…` review is recoverable at its original block height. What w7 showed is
> the designed behaviour, not a defect.
>
> The one thing that IS worth aligning on: **reading history requires
> `getidentityhistory`, and nothing exposes it today** — not the SDK, not the platform
> API (only `GET /v1/me/identity/raw`, which returns current state only,
> `client/index.ts:744-745`). Any consumer that reconstructs an agent's full review
> history needs that endpoint. That is a feature gap to scope, not a bug to fix.
>
> **The superseded sections have been rewritten in place** — §5b, the §2 coordination
> note, §5a's delivery vehicle, and the summary table now all state the corrected
> position. Nothing below still asks you to build array-shaped or to wait on a 2.13.0.
> The §3a, §3c and §3d conclusions were never affected.

**Date:** 2026-07-30
**From:** dispatcher
**Re:** your findings of 2026-07-29 (`2026-07-29-backend-findings.md`)

Everything below is grounded in code we read or live chain/API data we fetched read-only on 2026-07-29. Where something is our bug we say so; where it's yours, likewise.

---

## §5b — answered definitively. It is NOT data loss, and NOT a bug.

Both your questions, plainly:

### (1) How are review VDXF keys allocated?

**One fixed key per record *type*, never one per review.** `review.record` is the single
i-address `iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad` (SDK `src/onboarding/vdxf.ts:67`). Same
for `review.attestation` and `job.record`.

### (2) Read-merge-append, or replace?

**Replace.** `buildIdentityUpdateTx` copies the existing contentmultimap and then does
`currentCmm[key] = [...values]` (SDK `src/identity/update.ts:117-119`) — the accept paths
pass only the new item's `vdxfData`, so the key's prior array is replaced, not extended.

### So your tester's observation was real — but the conclusion doesn't follow

We verified live at block 1168312: **w2, w5 and w7 each hold exactly ONE `review.record`
entry.** Uniform. Your "w2/w5 accumulate (20→21, 19→20)" reading was the *total key
count* growing because `review.record` was new on those two identities; nothing
accumulated under it. w7 already had the key, so its count stayed at 13 and the prior
review was replaced. Same behaviour everywhere.

**But no history is lost.** Verus retains a complete identity snapshot at every update
height, contentmultimap included:

```
verus getidentityhistory "name@ || iid" (heightstart) (heightend) (txproofs) (txproofheight)
```

w7's `fed0564a…` review is still on-chain and recoverable at its original height.
Latest-wins in the live map is the design, not a defect. **There is no P1 here and no
fix is required.**

### We got this wrong first, and it's worth saying why

Our initial answer accepted §5b as our data-loss bug and planned a read-merge-append fix
for SDK 2.13.0. That was wrong on the interpretation, not the facts — we confirmed
single-fixed-key and replace-semantics, then concluded "history destroyed" without
checking whether the chain retains prior states. It does.

Shipping that fix would have been actively harmful: appending every review into one
contentmultimap value drives it straight at the ~5.5KB per-value truncation cliff that
`assertContentmultimapValueSizes` exists to guard, where values are silently truncated
on-chain with no RPC error. We'd have manufactured the exact data loss we thought we
were fixing.

### Your §2 verifier: no change needed, earlier warning WITHDRAWN

We previously told you to build your presence-verifier array-shaped and to coordinate
before our 2.13.0. **Disregard that — the append change is cancelled and nothing is
moving to array shape.** Your verifier is correct as designed; ship it whenever you like,
no coordination with us required.

One behavioural note, not a defect: because it checks *current* state, it will confirm
the newest review and correctly fail to find one that has since been overwritten. If you
ever want to verify a *historical* review, that needs the endpoint requested at the end
of this document.


## §3a — already shipped, deployed, and live-proven. Your report predates it by hours.

- **SDK 2.12.0** (commit `d219674`): `J41Agent.acceptInboxBatch()` — all of an agent's pending review/attestation/job_record items merged into **one** `updateidentity` tx, each item gated against its own type allowlist before merging, per-item failure buckets (rejected/deferred/ackFailed/alreadyDone).
- **Dispatcher 2.7.0** (release commit `16829ad`, plus fix `d45a668`): `processInboxForAgent` orchestrates the batch, plus a **per-identity pending-write confirmation gate** — no second identity tx is built until the platform serves our last txid as `prevOutput` (or the tx provably expired by chain height). Chain contention never burns the dead-letter budget; batch-level failures are bounded with escalation; dead-letter state is surfaced structurally in `/health` and via `ctl inbox` / `ctl inbox-redrive`.
- Live-proven the same day: your three dead-lettered reviews (`f0e45735`/w2, `fe619b0b`/w5, `ce8a421b`/w7) recovered and wrote (the deploy's restart cleared the process-lifetime dead-letter map, re-queued them, and the batch path landed them — consistent with your §5.0 observation, though your parallel manual re-submits from §5a were in flight the same afternoon, so we won't claim which write won for each item), and per-item independence held: a poisoned item was rejected alone while a healthy one still wrote.
- Your citation "`cli.js:6344-6349` ... no per-identity confirmation gate" described the pre-2.7.0 code; those lines are now the gate.

### Your merged-pair offer: **thank you, but please don't.**

Two reasons, one of them hard:

1. **It would break every deployed SDK's security gate.** Inbox accepts allowlist an item's `vdxf_data` against its own type: `review` admits exactly `[review.record]`, `attestation` exactly `[review.attestation]` (SDK `src/inbox/vdxf-gate.ts:40-47`; this is the 52f8d07 audit property). A merged item carrying both keys under one type would have its second key **dropped** by every 2.12.0-and-earlier dispatcher — creating precisely the silent-drop scenario you hypothesized in §3d. We will not widen an allowlist to accommodate it.
2. **It buys nothing anymore.** Batching already writes the pair (plus any job_record) in one transaction with one fee. Same end state, no wire change, already deployed.

Keep emitting the two items exactly as you do now.

---

## §3d — corrected diagnosis. Not what you thought, and not w7's.

We fetched `fcc0fb82` live. Facts:

- It is on **w5** (dt3worker5), not w7. Type `review`, jobHash `e27f527f…`, created 2026-07-08, **expired 2026-07-15 — and still `pending` 14 days later.**
- Its `vdxfData` keys are `["jobId","rating","message","isPublic"]` — **raw JSON field names, not VDXF i-addresses**. It predates your VDXF pre-formatting. Every key fails the allowlist, so the accept throws loudly ("no review.* keys after whitelist") before any transaction is built, classifies as a hard failure, and dead-letters after 5 attempts. It is visible in our `/health` and `ctl inbox`.
- **Your hypothesis — "the allowlist drops the attestation key silently" — is wrong for this item and for the current wire format in general.** Review and attestation arrive as separate inbox items, each gated against its own type. Nothing in the normal path drops a key silently: same-item cross-namespace keys are dropped with a loud tampering warning, and the attestation key never appears inside a `review` item today. (The one change that WOULD create that drop is the merged pair — see above.)

**Asks (yours):**
1. This item is permanently invalid — no dispatcher change can ever make it valid. Enforce `expires_at` (your own `cleanupExpired` wiring from §3c covers it) or cancel it outright.
2. No action needed on the format — everything you've emitted since the VDXF pre-formatting change gates cleanly.

---

## §5a — agreed on both halves; ours stands on its own merits

**Your half:** yes please, make `POST /v1/reviews` idempotent on
`(agent_verus_id, job_hash)`. That removes the duplicate at source.

**Our half:** agreed, and worth doing regardless. Earlier we said this would ship *fused*
to the §5b append fix because appending without dedupe would turn your re-submits into
permanent on-chain duplicates. That fix is cancelled, so the entanglement is gone —
dedupe now stands alone on its own merit: it avoids a redundant identity write and its
10,000-sat fee whenever a review is re-emitted.

Note we already have a partial mechanism: `valueAlreadyOnChain` (SDK
`src/inbox/vdxf-gate.ts`) short-circuits the broadcast when an item's value is already
present. It compares whole values via `JSON.stringify`, so it catches a byte-identical
re-emit but not a re-emit that differs in any field while carrying the same `job_hash`.
A `job_hash`-keyed check is the stronger form and is what we'll add.

## §3c — confirmed live, and we want your filter

Live probe: w5 has 77 pending items (35 job_request, 26 job_accepted, 11 job_delivered, 4 notification, 1 review); the one actionable review sits at index 15 of our 20-row newest-first window — one burst of informational traffic from invisible. w2: 50+ pending, zero actionable. Your starvation math checks out.

- When your `?type=` filter lands, our change is one line at the poll site (`getInbox('pending', 20)` → `type=review,attestation,job_record`) plus a small SDK client param. Ready within the day; tell us the exact param name/format when it's merged.
- Please also wire `cleanupExpired`/`deleteOld` — 330 expired-but-pending rows platform-wide is the actual root cause; the filter treats the symptom. It also disposes of `fcc0fb82`.

## §3b — noted; we're keeping restart-as-clean-retry, adding persistence for visibility only

A restart costs at most 5 no-fee gate attempts per poisoned item before re-quarantine, and `ctl inbox-redrive` + `/health` already give operators control and visibility within a process lifetime. We'll likely persist the failure map cheaply so attempt history survives deploys, but it's deliberately behind the §5b fix — and if your expiry enforcement lands first, the long-lived-poison population this would track goes to ~zero.

## §2 — good change, nothing needed from us

Verify-by-presence is the right call (our ack txid is best-effort and you're right not to trust your own insert). **Ship it as designed — no coordination with us needed.**

One behavioural note, not a defect: because it checks *current* state, it will confirm the newest review and will correctly fail to find one that has since been overwritten by a later review under the same key. That's the designed latest-wins behaviour (see §5b), not a race. Verifying a *historical* review needs the `getidentityhistory` endpoint requested at the end of this document.

---

## Summary of who owns what

| Item | Owner | Status |
|---|---|---|
| §5b history semantics | — | **not a bug** — replace is by design; history retained and recoverable via `getidentityhistory`. Append fix **cancelled** |
| §5a on-chain dedupe by job_hash | us | planned, stands alone (no longer fused to §5b) |
| §5a idempotent POST /v1/reviews | you | requested |
| §3a batching + confirmation gate | us | **shipped** — SDK 2.12.0 `d219674`, dispatcher 2.7.0 (`16829ad`, + fix `d45a668`), deployed |
| §3a merged-pair emit | — | **declined** — would break the deployed per-type gates |
| §3c `?type=` filter + expiry enforcement | you | requested; our 1-line consumer ready when it lands |
| §3d `fcc0fb82` | you | legacy pre-VDXF item on w5, expired 07-15 — please expire/cancel |
| **`getidentityhistory` endpoint** | **you** | **requested — see the end of this document. The one thing we are asking for.** |
| §2 presence verifier | you | **no change needed** — our array-shape warning is withdrawn; ship it freely |

---

# REQUEST: expose `getidentityhistory` via the platform API

**Priority: this is the one thing in this exchange we're actually asking you for.**

## Why

Your §5b question — "does the on-chain review write accumulate history, or overwrite
it?" — has a two-part answer:

1. **The current contentmultimap overwrites.** `review.record` is ONE fixed i-address
   (`iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad`), not one key per review, and
   `buildIdentityUpdateTx` replaces that key's array on every write. We verified live at
   block 1168312: **all three agents hold exactly one `review.record` entry** — w2, w5
   and w7 alike. Your tester's "w2/w5 accumulate (20→21, 19→20)" reading was the *total
   key count* growing because `review.record` was new on those identities; nothing
   accumulated under it. The behaviour is uniform latest-wins. Same for
   `review.attestation` and `job.record`.

2. **But no history is lost.** Verus retains a complete identity snapshot at every
   update height, contentmultimap included:

   ```
   verus getidentityhistory "name@ || iid" (heightstart) (heightend) (txproofs) (txproofheight)
   ```

   w7's `fed0564a…` review is still on-chain and recoverable at its original height.
   Latest-wins in the live map is the design, not a defect.

**We were initially wrong about this and want to be explicit:** an earlier draft of this
reply accepted §5b as our P1 data-loss bug. It isn't one, and we very nearly shipped a
read-merge-append "fix" that would have grown a single contentmultimap value straight
into the ~5.5KB per-value truncation cliff — making things materially worse.

## The actual gap

**Nothing exposes `getidentityhistory`.** Not the SDK, and not your API —
`GET /v1/me/identity/raw` returns current state only (`client/index.ts:744`). So today
an agent's on-chain review history is *retained but unreadable* through any supported
path. That undercuts the verifiable-reputation promise just as effectively as losing it
would, and it is the real substance behind your §5b concern.

We can't reach the daemon ourselves — the dispatcher is deliberately daemonless.

## Proposed contract

Two paths, matching your existing identity conventions:

```
GET /v1/me/identity/history?heightStart=&heightEnd=
GET /v1/identity/:identityOrIAddr/history?heightStart=&heightEnd=
```

The `:identityOrIAddr` form matters more than the `me` form: **reputation is read by
buyers about sellers**, so it should not require authenticating as the identity being
read. We'd expect it public or buyer-authenticated, same posture as the existing agent
read endpoints.

Response — a thin passthrough is ideal; please don't reshape:

```json
{ "data": { "history": [
  { "height": 1166824,
    "identity": { "contentmultimap": { "iLbUN8TF…": ["<hex(JSON) review>"] }, "…": "…" } }
] } }
```

Requirements, in priority order:
1. **Chronological, oldest-first**, with the block height on each entry.
2. **`contentmultimap` present and unmodified** on every snapshot. This is the whole
   payload — a snapshot without it is useless to us.
3. **Height range params honoured**, so a long-lived identity can be paged rather than
   returned whole.
4. `txproofs` optional; we don't need it initially.

### Status codes and edge cases — please pin these, they decide our client behaviour

| Case | Expected | Why it matters |
|---|---|---|
| Known identity, **zero updates** | **200** + `{"data":{"history":[]}}` | Must NOT be 404. Our client treats 404 as "this platform cannot serve history"; if an empty history 404s we cannot tell "no reviews" from "endpoint missing". |
| **Unknown** identity | 404 | Fine — but see above, it is indistinguishable from endpoint-absent, so we never read a 404 as "this agent has no reviews". |
| Endpoint not deployed | 404 | What we degrade against today. |
| `heightStart` / `heightEnd` | **inclusive** both ends, matching the daemon | Please confirm; we'll page on it. |
| Out-of-range height window | 200 + empty array | Not an error. |

**Auth posture — please choose and tell us:** we suggest the `:identityOrIAddr` path be
public or buyer-authenticated (same posture as your existing agent read endpoints),
because reputation is read by buyers *about* sellers. The `me` path can stay
seller-authenticated. We've built against both; you pick.

**On "thin passthrough" vs our example:** our sample shows `"height"`, but the daemon's
native field is `blockheight`. Pass through whichever the daemon gives you — **do not
reshape it for us.** Our client accepts either (`identity/history.ts:45-49`).

## What we've already built against it

Implemented in the SDK and green (367/367), **not yet published** — commit `b3f0330`, still unreleased at 2.12.0. Ready the day your endpoint lands:

- `J41Client.getIdentityHistory({ identity?, heightStart?, heightEnd? })` — calls
  exactly the paths above. Treats 404 as **"history unavailable"**, never as
  "no history", so it degrades safely against a backend without the endpoint.
- `extractVdxfHistory(snapshots, key)` — walks snapshots oldest-first, collapsing
  consecutive duplicates (an update that changed some *other* key leaves this one
  unchanged; that's one historical entry, not two).
- `decodeReviewHistory(snapshots)` — decodes every historical review, deduplicated by
  `jobHash` keeping the **earliest** height. Deliberate: your review re-submit is not
  idempotent (your §5a), so the same review can appear more than once — the first write
  is the one that happened. An undecodable entry is skipped rather than aborting, so one
  malformed legacy value can't cost an agent its whole verifiable history.

The decode half is pure and fully tested now; only the fetch needs you.

## Two notes that affect your side

- **Your §2 presence-verifier is correct as designed and needs no change.** We are NOT
  moving to array-shaped values — the append fix is cancelled. Our earlier warning about
  needing to decode multiple entries is withdrawn.
- **Your §2 verifier checks current state**, so it will correctly confirm the *newest*
  review and correctly fail to find an older one that has since been overwritten. That's
  expected, not a bug — but if you ever want to verify a historical review, you'll need
  this same endpoint. Another reason it's worth having.
