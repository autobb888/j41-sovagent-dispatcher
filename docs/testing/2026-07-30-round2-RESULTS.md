# Round 2 results — batched inbox writes: PROVEN LIVE

**Date:** 2026-07-30
**Stack:** dispatcher 2.7.0 (`a4eded2`), SDK 2.12.1, image `30959521` — both published to npm.
**Verdict:** every claim proven on-chain. No bugs found this round. Nothing to fix.

---

## What was proven

| Claim | Evidence |
|---|---|
| **Multi-item batch → ONE tx** | `Inbox batch written on-chain (3 item(s)): d1ccda06…`, and `(2 item(s)): 5aca76cb…` |
| **Attestation + review in ONE tx** (the brief's pass criterion) | `5aca76cb` — cycle 3 opened with exactly the 2 deferred items (`ee32d2dc` attestation, `ca06df1d` review) and wrote both together |
| **Same-key collision defers, never clobbers** | 3 deferrals (`e99c94ae` job_record, `ee32d2dc` attestation, `ca06df1d` review) |
| **Deferred item writes next cycle** | `e99c94ae` deferred cycle 1 → written cycle 2, no dead-letter |
| **No contention / no rejections** | zero `Transaction rejected by the network` all run |
| **History reconstruction** | 33 snapshots, 4 reviews decoded on agent-7 |
| **Per-agent isolation** | agent-5's dead-letter did not block agent-7's writes |

### Cycle-by-cycle (agent-7)

| Cycle | Pending | Written | Deferred |
|---|---|---|---|
| 1 | 2 | 1 (`642ef9e7`) | `e99c94ae` (job_record) |
| 2 | 5 | **3** (`d1ccda06`) | `ee32d2dc` (attestation), `ca06df1d` (review) |
| 3 | 2 | **2** (`5aca76cb`) | — |

Nothing clobbered, nothing lost, nothing dead-lettered except the known bad item.

### On-chain verification (not just logs)

agent-7 review history, baseline 2 → **4 after the run**:

```
h=1153052  5adae4593d99   baseline
h=1167637  a4ccfe167577   baseline
h=1169129  7b80ec60e0a4   NEW
h=1169130  ac5092e2730a   NEW
```

Current state holds only `ac5092e2` (latest-wins, by design); **history recovers all four**.
This proves the §5b reconstruction thesis on data written by *this release*.

**`1169129` and `1169130` are consecutive blocks.** Under the pre-2.7.0 code the second
would have been a guaranteed double-spend rejection. The pending-write gate sequenced them.

---

## The pass criterion WAS met — correcting an earlier reading of this run

An earlier version of this document claimed the attestation+review pair "still lands in
consecutive transactions" and never merged. **That was wrong.** Re-reading the log line by
line:

```
1684  [Inbox] agent-7: 5 pending item(s)
1690  [Inbox] ⏭ attestation ee32d2dc deferred (uncounted): key-collision
1691  [Inbox] ⏭ review      ca06df1d deferred (uncounted): key-collision
1692  [Inbox] ✅ agent-7: 3 item(s) accepted in tx d1ccda06
...
1708  [Inbox] agent-7: 2 pending item(s)
1714  [Inbox] ✅ agent-7: 2 item(s) accepted in tx 5aca76cb
```

`ee32d2dc` and `ca06df1d` appear exactly once each in the whole log — deferred at cycle 2.
Cycle 3 then opened with exactly **2** pending and wrote **2 items in one transaction**.
Those two items can only be that attestation and that review. So:

- **`5aca76cb` is one attestation + one review in a single `updateidentity`.** ✅
- Batching of three mixed items is separately proven by `d1ccda06`. ✅

What defers is a **same-key** second item within one cycle (two reviews, two attestations),
not the attestation/review pair — those occupy different VDXF keys and merge cleanly. The
collision rule is *why*: one item per VDXF key per batch, because `buildIdentityUpdateTx`
replaces a key's array rather than appending.

**Remaining honest limit:** the log does not record jobHashes on those lines, so we cannot
prove the merged attestation and review came from the *same* review event rather than two
different jobs. The brief's criterion — an agent holding both types at once, written in one
tx — is met either way.

---

## Expected, not bugs

- **`fcc0fb82`** climbed to dead-letter as documented — legacy 2026-07-08 item with raw
  JSON field names instead of VDXF keys. Needs backend expiry; no dispatcher change can
  consume it.
- **`[CANARY] Maximum 5 canary tokens per agent`** on every container — pre-existing,
  unrelated to this release. Canary protection is not registering on new jobs. Worth
  clearing separately.

---

## Third misattribution closed

`fed0564a` — which the backend's tester reported as a 10-day-old review that "disappeared"
from w7 — **is on agent-3, present and intact.** Verified in the baseline sweep and
unchanged throughout the run.

That is the third cross-agent misattribution in this exchange:
1. `f0e45735` reported as w7's → actually w2's
2. `fed0564a` reported as lost from w7 → actually on agent-3, never lost
3. (§1's whole per-agent theory rested on #1)

Two false bug reports came from that mapping. Worth raising with them — not as blame, but
because it has now cost two investigation cycles.
