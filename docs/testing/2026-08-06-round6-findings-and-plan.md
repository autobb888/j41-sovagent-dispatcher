# Round 6 — combined findings and fix plan

**Date:** 2026-08-06
**Sources:** tester's buyer-seat report (8 items) + dispatcher-side observation during the same run.
**Live:** dispatcher 2.12.2 published; **2.12.1 still running** (restart held while the tester was mid-flight).

The two reports overlap on the two most important findings and each supplies half
the evidence. Neither seat could have closed them alone: the tester could see the
delivered artifact and the buyer UI; the dispatcher seat could see the executor,
the sweep predicates and the ledger.

---

## What the two seats together established

### A. Cancel-with-refund is broken end to end — TWO separate defects, one each side

The tester: *"Disputing an in_progress job before delivery does halt it (→ disputed),
but nothing refunds… the job dead-ended in `disputed`, and the 0.5 stayed with the
agent."*

The dispatcher seat then answered the seller half of the same job (`b09440f5`) with
`refund` at 100% — and found that **agreeing to pay is what removes the job from the
operator's approval queue**:

```
sweep picks it up BEFORE the response (action=pending): true
sweep picks it up AFTER  the response (action=refund) : false
```

So there are two independent holes stacked on one path:

| # | hole | owner |
|---|---|---|
| A1 | No buyer cancel action exists at all (no `/cancel`, no `J41-CANCEL`) | **backend/frontend** |
| A2 | Seller-agreed refunds never entered the approval queue, and no manual route existed (`refunds approve` needs a queued entry; `wallet send` is fleet-internal by design) | **ours — FIXED in 2.12.2** |

A2 also explains the July outage batch needing a bespoke script: seller-agreed
refunds have *never* entered the queue.

**Second bug found while fixing A2:** `buildDisputeRefundEntry` hardcoded
`refundPercent: 100`, so a seller agreeing to a *partial* refund would have had the
full amount queued — paying double. Now honours the agreed percentage, refuses to
queue on a malformed one, and never re-queues a dispute that already carries a
`refund_txid`.

### B. Rework re-delivers the wrong thing — root cause identified

The tester: *"re-delivered a policy-ack stub — 'will provide concrete hazards…' —
rather than the actual reworked content. State machine perfect; rework content
generation looped on the ack."*

That was the missing evidence. From the dispatcher side the state machine was
provably correct — the buyer's real words reached the prompt (`Rework instruction:
"Answer was too generic…"`, not the `'Please rework the delivery.'` fallback) — but
the deliverable could not be inspected (200-char preview, log deleted by
`retention = errors`).

Root cause is the deliverable format, and it is **not rework-specific**:

```js
async finalize() {
  const fullContent = this.conversationLog
    .map(m => `${m.role}: ${m.content}`)      // ← a raw transcript
    .join('\n\n');
```

Every deliverable on this platform is a `user:`/`assistant:` transcript dump, not a
work product. On a first delivery that is merely poor. On a rework it is actively
wrong: the operator's dispute-response message is posted into the same conversation
as an agent turn (chat `[5]`: *"[DISPUTE RESPONSE: REWORK] … Will provide concrete
swamp hazards, a short packing list…"*), so the transcript contains a promise of the
work next to, or instead of, the work.

Note `handleMessage` **does** append the assistant reply (`conversationLog.push({role:'assistant'…})`),
so the LLM answer is not being dropped — it is being buried in a transcript whose
tail the buyer reads as the deliverable.

### C. >10 VRSCTEST tier never auto-verifies — backend

2 and 6 auto-verified in ~1 block; **11 sat unverified through 31 confirmations**
with the payment demonstrably on-chain. Manual `POST /payment {txid}` verified it
instantly. Confirms the suspicion that only the `<2` tier had ever been exercised.
Not ours — but we created the tier listings, so we should report it with the data.

---

## Confirmed from the dispatcher side (closes tester hand-offs)

**First-ever reviews DID land on-chain.** The tester listed these as pending. Both
are written and verified:

| agent | tx | keys | on-chain jobHash |
|---|---|---|---|
| dt3worker1 | `e4c23838` | 14 → **16** | `ad266d0b…` ✓ |
| dt3worker4 | `1a78f8ff` | 14 → **16** | `edf5f366…` ✓ |

Decoded from the raw CMM (hex-encoded — `decodeContentMultimap` does **not** surface
`review.record`, and a string search for the hash will always fail). Both carry real
review text, matching jobHashes and 96-char signatures. **This is the hash160-ordering
first-write case, now proven on two fresh identities.**

**Budget scaling is exact** across the tier range: 0.005 → 3,599 tokens; 2 →
1,440,000; 11 → 7,919,999. Linear over 2,200×, no cap artefacts.

**Concurrency held.** Five containers ran simultaneously with zero crashes, no
attribution collisions, inbox clean throughout, all skip counters at 0.

---

## Additional dispatcher-side findings not visible from the buyer seat

| # | finding | severity |
|---|---|---|
| D1 | **Rework has no token accounting.** No usage logged and `Rework budget basis` never printed — the `_disputePolicy && fullJob.amount` guard was false, so the 30% rework budget never applied. Rework runs unmetered. | medium |
| D2 | **The buyer is never told rework completed.** `resumeJob` puts the response only in the deliverable, never in chat. The buyer asked twice and got silence, then the job auto-completed. | medium |
| D3 | **No refunds screen in the TUI.** Approval is CLI-only; `dashboard.js` contains zero refund handling. | low |
| D4 | **A disputed job's transcript is deleted on clean exit** (`retention = errors`). Disputes are exactly the jobs you want evidence for. | low |
| D5 | `Token usage` is logged once, inside `if (!_isPostDeliveryReconnect)` — never after rework. This is what made B hard to diagnose from logs. | low |

---

## Plan

Ordered by "money or truth first, cosmetics last".

### P1 — Restart onto 2.12.2 *(ready, blocked only on a quiet fleet)*
Makes the A2 fix live. `b09440f5` then appears in `refunds list` as
`SELLER AGREED to refund 100% of 0.5 VRSCTEST — dispute bea9c807, no txid yet`,
and is approvable through the normal report flow. **The buyer stays owed 0.5 until
this happens** — correct, since nothing pays without owner approval.

### P2 — Fix the deliverable format (B)
The highest-value code change, because it affects **every job**, not just rework.

- `finalize()` should return the **work product**, not a transcript. Minimum: the
  last assistant turn(s) since the previous delivery; better: an explicit
  "deliverable" the executor accumulates.
- Rework must deliver **only the reworked content**, not the whole history.
- Keep the operator's dispute-response message **out of the executor's conversation**
  — it is operator↔buyer correspondence, not agent work product.
- Pin with a test that asserts a rework deliverable does *not* contain the
  dispute-response text.

### P3 — Close D1/D2 while in the same code path
- Wire the rework token budget (`_disputePolicy && fullJob.amount` currently false —
  find out why; `fullJob` scope is the suspect) and log usage after rework.
- Post the rework result to chat so the buyer knows it happened.

### P4 — Report C and A1 to backend, with data
- **C:** 11 VRSCTEST job `6f3cd336`, unverified through 31 confirmations, recovered
  instantly by manual `/payment`. Tier boundary is the suspect.
- **A1:** no cancel action exists anywhere in the buyer surface. Ask whether cancel
  is intended to be dispute-based (in which case the resolver must handle
  pre-delivery cancels) or a first-class action.

### P5 — Smaller items
- Point a fleet agent at bounty `0d7a81de` so the tester can close the award step.
- TUI refunds screen (D3), or document that approval is CLI-only.
- Consider `retention = errors+disputes` (D4).

### Not doing
- Manual out-of-band refunds. The queue+approval flow exists; P1 routes this case
  into it. Bespoke scripts are what made the July batch unauditable.

---

## Cross-seat note worth keeping

Three of my own verification attempts on this run produced **false negatives** —
concluding "not on-chain" / "no rework happened" from `getJob().deliveryHash` (wrong
field, it is `delivery.hash`), from a string search against hex-encoded CMM data, and
from a token-usage line that is never emitted post-rework. Each time the data was
fine and the check was wrong.

The tester's artifact-level view corrected the rework question in one line. Where a
finding depends on what the buyer actually receives, the buyer seat is authoritative
and the dispatcher seat should ask rather than infer.
