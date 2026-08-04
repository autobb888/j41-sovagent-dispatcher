# Items 3 & 4 verified on-chain — plus a broken `update-profile`, now fixed

> ## ⛔ CORRECTION — 2026-08-04, later the same day. Read this first.
>
> **The root-cause analysis below is INCOMPLETE. There are TWO causes, not one.**
>
> This document frames the action-3 failure as purely "the network stopped accepting it".
> A first correction then swung the other way and called it purely our bug. Both were
> one-sided. Chain history settles it:
>
> **Verus requires `contentmultimap` keys in ascending hash160 order.** It returns them that
> way; our builder copied them into a JS object (insertion order) and then *appended* any new
> key at the end, breaking the ordering. The daemon rejects that with a bare
> `-25 - bad-txns-failed-precheck`, which names nothing. So:
> - **REPLACING** an existing key preserved the order by accident → accepted.
> - **ADDING** a key the identity lacked → rejected.
>
> **1. Ours:** our payload was never canonically ordered.
> **2. Theirs:** the daemon tolerated that for four months, then began enforcing.
>
> Proof it was tolerated — unsorted new-key ADDs that were ACCEPTED on-chain:
> `agent-2` h=997979 (`review.record`, its first) and h=1005598 (`job.record`); `agent-7`
> h=1153049-52; and **`agent-6` h=1170503 / h=1170504 — round 3's own txs `d2f30678` and
> `51b309df`, on 2026-07-31.** First proven rejection is 08-04, so enforcement flipped inside
> h=(1170504, ~1175944).
>
> The action-3 remove failed because `MULTIMAPREMOVE_KEY` is itself a *new* key — the same
> ordering trip, once enforcement was live.
>
> **Ask the backend for their verusd version/upgrade log in that window.** Undocumented
> policy tightening with exact before/after heights is also worth telling the Verus lead.
>
> **Proof:** pre-inserting a new key in sorted position made the otherwise-identical
> transaction succeed (agent-1 tx `68875887`). After fixing the builder to sort, all nine
> agents gained a `disputePolicy` key they had never had, via plain `update-profile`.
>
> **The single-transaction rewrite is still correct** — it is simpler, cheaper, and avoids a
> 20-minute block wait. Only the explanation of *why the old path broke* was wrong.
>
> **Blast radius: the 08-01 → 08-04 window only**, and it self-healed — `TX_REJECTED`
> classifies as `contention`, which never escalates, so those writes retried silently and
> drained once the fix landed. Zero dead-letter events in the ring.
>
> **NOT caused by this bug, checked:** the backend's §4 "reviews accepted but never landed"
> (all that activity predates enforcement, and no accept path acks a rejected broadcast —
> that shape is the 07-29 double-spend already fixed in 2.12.0), and agent-11/url2's
> single-key state (an April onboarding gap; profile was never published).
>
> Fixed in **SDK 2.13.1** — note 2.13.0 shipped *without* it.
>
> Nothing below this banner has been edited; it is left intact as the record of what we
> believed and why. Sections on items 3 and 4 themselves (the on-chain results) remain valid.

**Date:** 2026-08-04
**From:** dispatcher
**Re:** the buyer tester's 23-item report (`2026-08-01-buyer-23-item-results.md`), items 3 and 4
**Stack:** dispatcher 2.7.0, SDK 2.12.1 + the fix below (unreleased at time of writing)

---

## TL;DR

- **Item 3 (mixed profile + review in one tx): PASS.** agent-7, tx `9e890c6d` @ height **1175945**.
- **Item 4 (profile update on a reviewed agent): PASS.** agent-3, tx `b7d49d25` @ height **1175944**.
- Neither lost a contentmultimap key, a current-state review, or a history entry.
- Getting there uncovered a **real dispatcher bug**: `update-profile` could not complete at all.
  It is fixed and live-verified (agent-4, tx `4294bfc8` @ height **1175955**).
- **One ask for the backend:** `POST` broadcast returns a bare `400 TX_REJECTED` with the
  daemon's rejection reason discarded. That turned a one-glance diagnosis into a bisection.

---

## Item 4 — profile/status update on a reviewed agent

**Agent:** dt3worker3 (`iDP6VUHKfd5NwLgFuvdNc8PmRkZT6ayGJN`), 2 reviews in history.
**Change:** `description` VDXF field replaced.
**Transaction:** `b7d49d25` @ height 1175944.

| | Before | After |
|---|---|---|
| contentmultimap keys | 14 | **14** |
| `review.record` present | yes | **yes** |
| reviews in identity history | 2 | **2** |

Both historical jobHashes intact and unchanged:

```
h=1149892  6256c084127762c4
h=1152780  fed0564a62452c35
```

`fed0564a` is the review previously reported as "disappeared from w7". It is on **w3**, it has
always been on w3, and a profile write did not disturb it.

**Verdict: a profile edit does not affect reviews.** Tester can confirm `chainReviewCount`
holds at 2 for dt3worker3.

---

## Item 3 — mixed update in one transaction (profile field + review together)

**Agent:** dt3worker7 (`iMRMgHbkr7qjupRUpHLwp86g16UX3Uzzde`), 4 reviews in history.
**Change:** `description` **and** `review.record` written in a **single** `updateidentity`.
**Transaction:** `9e890c6d` @ height 1175945.

| | Before | After |
|---|---|---|
| contentmultimap keys | 13 | **13** |
| `review.record` present | yes | **yes** |
| reviews in identity history | 4 | **4** |

```
h=1153052  5adae4593d990738
h=1167637  a4ccfe167577b2f2
h=1169129  7b80ec60e0a4d138
h=1169130  ac5092e2730acc6b
```

**Method note, deliberately conservative:** the `review.record` value written was dt3worker7's
**existing** review, not a fabricated one. The point of item 3 is to prove a profile key and a
review key can occupy one transaction without either being lost — that is demonstrated without
minting review data that no buyer signed.

This is not a special mechanism. The inbox path already writes **three** distinct VDXF keys in
one transaction routinely — `job_record` + `attestation` + `review` in tx `51b309df` during our
round-3 run. Item 3 is the same builder with a profile key substituted in.

---

## The bug this surfaced: `update-profile` was completely broken

Both items **failed** on the first attempt, through the CLI:

```
Phase 1: Removing old VDXF values...
❌ Update failed: Transaction rejected by the network
```

Reproduced on **two agents with opposite write histories** — dt3worker6 (8 identity writes that
day) and dt3worker3 (none) — which ruled out a stale-UTXO or per-agent explanation. Funds were
not the issue either (dt3worker3: 10 UTXOs, ~11.99 VRSCTEST).

### Bisection

| Path | Result |
|---|---|
| Two-phase: `contentmultimapremove` (action 3) → wait a block → write | ❌ rejected at phase 1 |
| **Single-transaction `vdxfAdditions` write** | ✅ broadcast, confirmed, verified |

### The remove phase was NOT a mistake — something changed

Worth stating plainly, because our first write-up got this wrong. The two-transaction design
(commit `b399d18`) was deliberate and it **worked** — live-proven on verustest 2026-04-09. Its
stated reason was read-side, not write-side:

> *"removal MUST confirm in an earlier block than the rewrite, otherwise `getidentitycontent`
> aggregation order is wrong."*

So this is not "a path that never worked". It is **a path that the network stopped accepting**,
and we cannot tell why, because the rejection carries no daemon reason (see the ask below).
Whether the daemon, consensus rules, or the platform's broadcast policy changed is open —
**and it is a question for the backend**, since the same action-3 payload presumably still
flows from other clients.

### Why replacement doesn't need the remove phase

`buildIdentityUpdateTx` (SDK `src/identity/update.ts`) copies the identity's **entire existing
contentmultimap forward**, then replaces only the keys named in `vdxfAdditions`:

```js
// copy every existing key
for (const [key, values] of Object.entries(identityData.identity.contentmultimap)) {
  currentCmm[key] = Array.isArray(values) ? [...values] : [values];
}
// then replace ONLY what was passed in
for (const [key, values] of Object.entries(vdxfAdditions)) {
  currentCmm[key] = [...values];
}
```

So replacing a field's value needs one transaction. Untouched keys survive verbatim, and the
key's prior value remains retrievable through `getidentityhistory` — which is the same
replace-with-history-retained semantics the tester documents in items 1, 2 and 20.

### The fix

`removeAndRewriteVdxfFields()` is now a single transaction. `removeTxid` is `null` and
`blocksWaited` is `0`; the CLI no longer prints them, and `--dry-run` now shows the resolved
key→value map instead of a removal payload.

Deleting a key outright (as opposed to replacing its value) is **not solved** by this change.
`buildContentMultimapRemove` is still exported but is now `@deprecated`: its output is the same
action-3 payload the network currently rejects. Under full-state serialization the correct shape
for deletion is to **omit the key** when rebuilding, which `buildIdentityUpdateTx` does not yet
expose. Nothing in the dispatcher needs deletion today, so this is noted rather than built.

Side effects worth stating: the command no longer waits up to 20 minutes for an intermediate
block, and it costs one transaction fee instead of two.

**Inherited trade-off, stated honestly.** Dropping the remove is not free. A consumer that
reads an identity via daemon-side `getidentitycontent`-style **aggregation** — rather than
per-snapshot replace semantics — can now observe the old and new values accumulated under a
key instead of only the new one. Every reader we control is unaffected (`parseFlatEntry` takes
the last entry; history reconstruction is per-snapshot). **If the platform indexer aggregates
that way, tell us** — it would change what a profile edit looks like to you, and it is the one
regression this fix could plausibly cause.

**Live verification of the fixed command** — agent-4, tx `4294bfc8` @ height 1175955, 13 keys
preserved.

### Test coverage

`removeAndRewriteVdxfFields` had **zero tests**, which is how it shipped broken. Six were added
(`test/update-vdxf-fields.test.ts`) covering: exactly one broadcast, no action-3 payload emitted,
unknown field names rejected *before* any network I/O, multiple keys in one transaction, broadcast
rejections surfaced rather than swallowed, and — the important one — an unrelated `review.record`
still present in the serialized transaction after a description-only edit. SDK suite: **384/384**.

The first version of those tests was **worthless and looked fine.** The "never emits an action-3
payload" assertion grepped the raw transaction for the utf8 hex of `MULTIMAPREMOVE_KEY` — but
contentmultimap keys serialize as **hash160**, so that string never appears even in a transaction
that *does* carry the removal. Verified by rebuilding the old remove tx: `utf8 marker present:
false`, `hash160 marker present: true`. The test passed unconditionally. Both assertions now match
on hash160, and the test asserts its own marker is well-formed so it can't silently go vacuous
again. Flagging it because "we added tests" is worth nothing if the tests cannot fail.

---

## Ask for the backend: surface the daemon's rejection reason

The broadcast endpoint returns:

```
statusCode: 400
code      : TX_REJECTED
message   : "Transaction rejected by the network"
own props : ["code","statusCode","name"]
```

No `detail`, `reason`, `data`, or body — the daemon's actual error is discarded. That is the
difference between "the remove payload is malformed" and a half-hour bisection across two agents.

**Request:** include the daemon's `sendrawtransaction` error text (or code) on `TX_REJECTED`.
It is diagnostic gold and costs nothing to pass through.

This is the same shape as two other findings we have open: `/v1/identity/:id/keys` returns
**503 `RPC_UNAVAILABLE`** for an unknown identity (a permanent condition given retry-forever
semantics), and a history window entirely below an identity's creation height returns **404**
instead of `200 + []`. In all three cases the status code loses information the caller needs.

---

## Also observed

**Indexer lag confirmed from our side.** dt3worker3's description is updated on-chain
(tx `b7d49d25`, height 1175944) while the platform still served the previous description
afterwards — consistent with the tester's finding 3 (~30 min convergence). Worth noting that a
meaningful share of that window is ours by design: our inbox writes drain one item per VDXF key
per confirmed block, so a burst of reviews serialises rather than landing together.

---

## Still open on our side

- Items **7** (external review backfill) and **8** (fabricated jobHash tamper test) need a
  **sacrificial identity** — both write permanently to chain, and item 8's pass criterion is an
  indexer log line we cannot read. Item 8 needs joint scheduling with the backend watching.
- Item 7 has become more interesting: dt3worker2 shows **3 distinct jobHashes in decoded
  identity history** but the platform reports **6 total reviews**. Fresh agents reconcile exactly
  (dt3worker6 7/7, dt3worker7 4/4) — only legacy data diverges. **Question for the backend: does
  the chain-derived count backfill pre-deploy history, or accumulate forward only?** Item 7 is
  the experiment that answers it.
- **Item 13 higher tiers:** we will create 3 and 12 **VRSCTEST**-denominated services. Note the
  tension with finding 5 — we are deliberately *not* creating VRSC-labelled services on a
  testnet. Please confirm the confirmation tiers key on the numeric amount, not the currency
  string.
