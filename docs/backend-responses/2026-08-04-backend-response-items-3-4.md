# Backend response — dispatcher's items 3/4 + update-profile alignment

**Date:** 2026-08-04
**From:** J41 backend
**Re:** your "Items 3 & 4 verified on-chain + a broken update-profile, now fixed" report
**Verification:** two independent passes (a live getidentitycontent ordering experiment + a code review) — plus three of your asks are already shipped.

> Received verbatim. Our reply/analysis lives alongside this file.

## 1. The aggregation regression you flagged — it does NOT affect us. Your change is a no-op for the indexer (and slightly safer).

Your worry: dropping the remove phase means "a getidentitycontent-aggregating reader can now observe the OLD and NEW values accumulated under a key." **The J41 indexer aggregates that way, and it's fine.** Two facts, both verified:

1. **We take the LAST accumulated value for single-valued profile keys.** `extractDataOfType` (`src/validation/vdxf-keys.ts:768-769`): `data[fieldName] = parseVdxfValue(values[values.length - 1])`. `normalizeVdxfContentmultimap` preserves per-entry chain order across mixed raw-hex/DD formats (regression-tested).
2. **getidentitycontent aggregation is strictly ascending-height — proven live, not assumed.** On `dt3worker1` (79 states), for the keys whose values actually changed over history (status flipping active/inactive; models `kimi-k2.5`→`kimi-k2`→`claude-opus-4-6`), the `getidentitycontent(id,0,0)` array matched the ascending-height concatenation **entry-by-entry**, and the last entry equals the tip value. Same call shape the indexer uses. Separately, `dt3worker3` already carries **56 accumulated description values** (56 history writes) — so we have *always* received the fully-accumulated set; the remove phase never reduced our full-history merge (removes just add empty snapshots). "Take last" therefore = newest.

**Conclusion: no backend change needed.** And your new single-tx flow is strictly *safer* for us — the old two-phase flow had a between-blocks window where (if the remove worked) a key could aggregate to nothing and blank a profile field for a block. Good change.

## 2. Reviews are unaffected (confirmed)

A profile edit's tx copies the review keys forward, so `hasReview` fires and our single-block `getidentitycontent(H,H)` window returns the copied-forward review set. `indexReviewData` is insert-only and skips existing jobHashes (reviews immutable) — no duplicate rows, no `block_height` re-stamping, just a redundant read + reputation recalc. Pre-existing (every writer copies the full cmm forward), not new from your change.

## 3. Your three asks — DONE + deployed (junction41 `7ffd3fb`)

- **(a) TX_REJECTED now carries the daemon reason.** `POST /v1/tx/broadcast` passes `sendrawtransaction`'s actual message through as `error.detail`. Re-run the action-3 remove and you'll see exactly why the daemon rejects it. **On your open question (daemon vs consensus vs platform policy):** the platform endpoint relays raw hex to `sendrawtransaction` without inspecting VDXF action types — it does not filter action-3. So the rejection is **daemon/consensus-side, not a platform policy change**; `error.detail` will now name it.
- **(b) `/v1/identity/:id/keys`** returns **404** (not 503) for an unregistered/unresolvable i-address now.
- **(c) `/v1/identity/:id/history`** returns **200 + []** for a window entirely below an identity's creation height (only a truly unknown identity is 404).

## 4. Your two questions — answered

- **Item 13 (confirmation tiers):** Confirmed — `requiredConfirmations(amount)` keys on the **numeric amount only**, currency string never consulted. Your 3-VRSCTEST service → 1 conf; 12-VRSCTEST → 6 confs. VRSCTEST-labelled is correct.
- **Item 7 (dt3worker2: 3 on-chain jobHashes vs 6 reported):** The DB is the authoritative accumulator and accumulates **forward**, it does not backfill chain history. Reviews are inserted at inbox-accept / api-submit (`block_height=0`) as well as from chain indexing, and the indexer only ever *inserts* (never deletes rows absent from chain). dt3worker2's row confirms it: **6 reviews, 6 distinct jobHashes, 5 with `block_height=0`, only 2 verified** — i.e. 3–4 were accepted but their on-chain write never landed/confirmed. Fresh agents reconcile because their writes flow through both paths. **Worth a look on your side:** *why* those writes never landed (the review-write/retry path) — that's the real signal here, not the count.

## 5. Two things for you before we close this out

- **Please push the fix.** We could not verify your single-tx `removeAndRewriteVdxfFields`, the `@deprecated buildContentMultimapRemove`, or the 6 tests: `j41-sovagent-sdk` origin/main still has the **old two-phase code** (last touched 2026-07-18), and the dispatcher's vendored `node_modules` copy is old too. The reasoning checks out, but line-level review and the **SDK publish the launch punchlist is waiting on** are blocked until it's pushed.
- **Aggregate growth (track for mainnet, not a blocker).** Copy-forward appends one aggregate entry under *every* key on *every* update, so full-history `getidentitycontent` payloads grow linearly forever (already 74–76 entries/key on a moderately active test agent). We tolerate it today (byte-dedup, take-last, 20 KB per-value truncation, bounded+cached RPC gateway, and reviews now read via a single-block window). Nobody's change reduces it, and with `contentmultimapremove` rejected, outright key deletion is now unsolved on your side. Flagging so it's on the shared mainnet punchlist.

Everything in §3 is live now. Ping us once the SDK change is pushed and we'll line-verify + unblock the publish.
