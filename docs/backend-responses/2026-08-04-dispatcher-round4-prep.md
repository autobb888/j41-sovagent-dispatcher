# Dispatcher — round-4 prep, plus three things only you can confirm

**Date:** 2026-08-04
**From:** dispatcher
**Re:** your response of 2026-08-04, and what we fixed before the next test round
**Shipped:** SDK **2.14.0**, dispatcher **2.8.0**, MCP server **2.2.2** (all on npm, deps pinned)

---

## 1. Your §3 fixes: all verified live, thank you

| Ask | Result |
|---|---|
| `TX_REJECTED` carries the daemon reason | ✅ `"detail":"-25 - bad-txns-failed-precheck"` |
| `/v1/identity/:id/keys` unknown → 404 | ✅ (was 503) |
| history window below creation height → `200 + []` | ✅ (was 404) |
| truly unknown identity history → 404 | ✅ |

**The `detail` field immediately paid for itself twice** — see §2 and §4. It needed SDK
**2.13.1** to be visible at all: `J41Error` was discarding every field except
message/code/statusCode, so your fix reached the wire but never reached a caller. That was
ours, now fixed.

(For your line-level review: 2.13.0 was published without the key-ordering fix and is
superseded — treat **2.13.1** as the first usable release in that line, and 2.14.0 as
current.)

---

## 2. Correction: our "the network stopped accepting action-3" claim was half wrong

Our 08-04 report said the two-transaction `contentmultimapremove` flow was "a path the
network stopped accepting". A first correction then swung the other way and called it purely
our bug. **Both were one-sided. There are two causes.**

**Ours:** we never serialized `contentmultimap` keys in canonical **hash160 order**. Verus
returns them sorted; we copied them into a JS object (insertion order) and appended new keys
at the end. Replacing a key preserved order by accident; adding one broke it.

**Yours (or the daemon's):** that was **tolerated for four months**. Identity history proves
unsorted new-key ADDs were *accepted* as late as 2026-07-31:

```
agent-2  h=997979    review.record     ~04-02   (its FIRST review)
agent-2  h=1005598   job.record        ~04-08
agent-2  h=1012635   MULTIMAPREMOVE    April    (the action-3 removes were themselves unsorted)
agent-7  h=1153049-52  job.record + attestation + review   ~07-19
agent-6  h=1170503   job.record        07-31    ← our round-3 tx d2f30678
agent-6  h=1170504   attestation + review  07-31 ← our round-3 tx 51b309df
```

First proven rejection: **2026-08-04**. So enforcement changed inside
h=(1170504, ~1175944) — 08-01 → 08-04, overlapping your daily ~04:00 UTC maintenance.

**Ask:** what changed in your verusd between 07-31 and 08-04 — version, upgrade, or mempool
policy? This is also worth passing to the Verus lead: undocumented policy tightening with
exact before/after heights is unusually precise data.

Fixed in SDK 2.13.1 (`buildIdentityUpdateTx` now sorts). Effect while it was broken: **no
identity could gain a VDXF key it did not already have.** That is why every agent logged
`no dispute policy on-chain` — the key could not be added. All nine now carry one.

---

## 3. Your §4 (dt3worker2: "3–4 reviews accepted but never landed") — not what you think

Two problems with the inference, and one thing worth your attention.

**(a) "5 with `block_height=0` ⇒ never landed" contradicts your own model.** You say the
indexer "accumulates forward, does not backfill". dt3worker2's two oldest on-chain reviews —
`9e0e4dec` @997979 (~April) and `d4af5f66` @1147196 (~07-14) — **predate the chain indexer**,
so they must read `block_height=0` while having been on-chain the whole time.

**(b) `verified` is signature verification, not chain presence** — your own tester's items
11–12 show `verified=true` set at submit while `chainReviewCount` was still 0.

**Our on-chain set for dt3worker2 is exactly three:**
```
9e0e4dec  h=997979
d4af5f66  h=1147196
6d87b922  h=1167637
```
**Ask:** send the six rows as `{jobHash, status, created_at, accepted_at, txid, verified}` and
we will diff them against these. Counts alone cannot resolve it.

**(c) It is also not the ordering bug.** All that activity predates enforcement, and no accept
path ever acks a rejected broadcast — `acceptInboxItem` runs only *after* a successful
`broadcast` in all four accept paths. The shape you are describing is the 2026-07-29 serial
double-spend, which we fixed in 2.12.0.

---

## 4. What we fixed on our side before round 4

- **Deletion attestations were absent on 100% of abnormally-terminated jobs.** Both shutdown
  handlers used the old `getDeletionAttestationMessage` → `J41-DELETE-…` flow, which our
  signing broker correctly refuses. Only the completion path had been migrated. Fixed — all
  three paths now sign JCS-canonical JSON.
- **A transient `getJob` response killed containers permanently** (5 jobs, both clusters
  inside `CHAIN_SYNCING` windows). Now retried, with the completeness check inside the retry.
- **SovGuard canary registrations were never released**, so every agent past its 5th job ever
  ran with SovGuard-side leak detection off. Now released on teardown, with abandoned slots
  reclaimed.
- **Broker-mode containers no longer attempt review accepts** they cannot sign; the host
  inbox sweep owns those, as it already did in practice.
- **`TX_REJECTED` is no longer classified as chain contention unconditionally** — it now reads
  your `error.detail`. Contention never escalates, so a *permanently* malformed transaction
  used to retry forever with no dead letter and no signal. That is what hid the ordering bug
  for days.
- **`ctl shutdown` could report success and keep running.** A restart that leaves the old
  process alive means two dispatchers writing identity transactions against the same
  `prevOutput` — the exact double-spend class we fixed in 2.7.0.

---

## 5. Three things only you can confirm

1. **Duplicate deletion attestations per job.** A container that is idle-paused and respawned
   now submits a deletion attestation per instance — truthful for each `containerId`, but a
   single `jobId` may produce several `POST /v1/me/attestations`. **Does your side dedupe,
   overwrite, or append?** If duplicates are a problem, say so and we will gate submission on
   terminal state rather than guess your semantics.

2. **`POST /v1/me/attestations` vs the per-job `POST /v1/jobs/:id/attestations`.** Our
   shutdown paths previously used the per-job endpoint — though it never actually worked,
   since signing failed first — and now use the same endpoint the completion path has always
   used. **Do your coverage/refund and privacy-tier checks treat them identically?**

3. **`GET /v1/me/canary` token visibility.** We resolve a canary's id by matching its `token`,
   because the `registerCanary` response is typed `{ status }` and has no id. **If that
   endpoint ever masks or hashes tokens, our release path becomes a permanent silent no-op.**
   Confirm tokens are returned as stored.

Also worth flagging: the **5-canary-per-agent cap** is below our concurrency. Round 3 ran 10
concurrent jobs on one agent, so jobs 6–10 necessarily run without SovGuard-side leak
detection. We are not working around that — is the cap raiseable, or should it scale with an
agent's concurrency?

---

## 6. Still open on your side, from earlier

- `cleanupExpired` / `deleteOld` still unwired (330 expired-but-pending rows).
- `fcc0fb82` — legacy pre-VDXF item on w5, expired 2026-07-15, still `pending`.
- The `?type=` inbox filter: we send it on every poll; confirm it is deployed.
- Flip `DISPUTE_RESOLVER_ENABLED` when you are ready — **all nine agents now have an on-chain
  dispute policy**, which they never did before today, because adding the key was impossible.
