# Testing brief — batched inbox writes (dispatcher 2.7.0 / SDK 2.12.0)

**Date:** 2026-07-29
**Status:** DEPLOYED and running — dispatcher 2.7.0 commit `d45a668`, image `30959521`,
SDK 2.12.0. Both repos pushed. Needs the two-item batch proof (see §1).
**Scope for you:** the on-chain **inbox write path** (reviews, attestations, job records). Nothing else changed.

---

## What was broken

Accepting inbox items one at a time wrote **N separate identity transactions** to the
same VerusID back-to-back. The first spends the identity `prevOutput` and sits in the
mempool, but the platform API keeps serving the last **confirmed** `prevOutput` — so
every transaction after it is built spending an output already spent, and the daemon
rejects it as a double-spend.

Live-observed 2026-07-29 on 3 of 3 agents, no counterexamples:

```
[Inbox] Processing attestation 9d29e003
[J41]   Attestation written on-chain: 12f9f69b...   <- enters mempool
[Inbox] Processing review f0e45735                  <- same identity, immediately
[J41]   Failed to accept review f0e45735: Transaction rejected by the network
```

The 5-attempt retry budget elapsed before the platform's view caught up, then
dead-letter became terminal. Net effect: **review/reputation data silently failed to
reach the chain.**

Two facts that matter for how you test:

1. The three affected reviews (`f0e45735` agent-2, `fe619b0b` agent-5, `ce8a421b`
   agent-7) were never destroyed — they stayed `pending` on the platform, and the
   2026-07-29 restart re-queued and wrote them. See §2. (An earlier backend memo
   described them as "permanently lost"; that was wrong and has been corrected.)
2. The platform's confirmed view stayed stale for **>=5 minutes**, past the confirming
   block's own timestamp. Proven by a byte-identical txid rebroadcast 70s after the
   block. So do not assume "one block" is long enough for anything to settle.

## What changed

**SDK 2.12.0** — new `J41Agent.acceptInboxBatch()`: merges an agent's pending items
into **one** identity transaction. Per-type VDXF allowlists moved into one shared gate
module (security property, see below).

**Dispatcher 2.7.0** — the poll loop now batches, plus:
- a **pending-write gate**: never build a second identity tx while the previous one is
  unconfirmed
- **failure classification**: chain contention no longer burns the dead-letter budget
- **bounded escalation**: nothing can retry forever
- **structured `/health` inbox block** + `ctl inbox` / `ctl inbox-redrive`

---

## What to test

### 1. The core fix — one transaction, multiple items
Get an agent to have **two or more pending inbox items at once** (easiest: complete a
job so an attestation *and* a review are both queued). Then:

- **PASS:** exactly ONE `Broadcasting identity update transaction` / one txid for that
  agent in that cycle, and every item accepted. Look for
  `[Inbox] ✅ Inbox batch written on-chain (2 item(s)): <txid>`.
- **FAIL:** two txids, or `Transaction rejected by the network`.

Then verify on-chain that **both** values actually landed (`contentmultimap` grew by the
right number of keys) — not just that the log looked happy.

### 2. Recovery of the three quarantined reviews — ✅ ALREADY PROVEN
Done on the 2026-07-29 09:0x restart. All three wrote on-chain:
agent-2 `30661cb2`, agent-5 `55f511cc`, agent-7 `ca1d4d3b`. `deadLettered` is now empty.

Also proven in that run, against real data rather than a stub: agent-5 had **2 pending
items**, the poisoned `fcc0fb82` was rejected **alone**, and the healthy item still
wrote — the per-item independence invariant holding live.

Nothing further needed here; re-verify only if you restart again.

**Known exception — do not treat as a failure:** `fcc0fb82` (agent-5) is a **legacy
2026-07-08 malformed item** whose `vdxfData` uses raw JSON field names instead of VDXF
i-addresses. It is permanently invalid, no transaction is ever built, and it will
re-dead-letter after every restart until the backend rejects/expires it. Expect exactly
one dead letter, and only that one.

### 3. The new health surface
`curl -s http://127.0.0.1:9842/health | jq .inbox` should show
`{deadLettered, retrying, ackFailed, pendingWrites}`.

- `status` becomes **`degraded`** whenever anything is dead-lettered. This is
  intentional — flag it to anyone alerting on `status != ok`.
- `pendingWrites` should appear briefly during a write and **clear** once confirmed. If
  an entry lingers with an ever-growing `ageMs`, that is a bug — report it.

### 4. `ctl inbox-redrive`
`j41-dispatcher ctl inbox-redrive` clears quarantine without a restart and grants a
fresh full budget. `--item <id>` targets one. Verify a redriven item is genuinely
retried, not just removed from the list.

### 5. Regression — the normal single-item path
Most cycles have exactly one pending item. Confirm that still works unchanged; the
batch path must not have made the common case worse.

---

## Where it is most likely to break

Ranked by my judgement of risk, highest first.

1. **Ack with no txid.** If an item's value is already on-chain and only the backend ack
   is outstanding, we skip the broadcast and ack with **`txid: undefined`**. Every path
   before this change always passed a txid. **We have not confirmed the backend accepts
   this.** If it 400s, that item stalls permanently — and it will NOT be
   `ALREADY_PROCESSED`, so the terminal-success branch cannot rescue it. Watch for
   repeated entries under `/health.inbox.ackFailed`. **This is the single most likely
   live failure.**

2. **~~The pending-write gate depending on the backstop.~~ FIXED before deploy.**
   Review found `expiryHeight` was never reaching the gate, so height-based release was
   dead code and only a 4h wall-clock backstop applied. SDK 2.12.0 now returns
   `expiryHeight` on `InboxBatchResult` and the dispatcher stores it. Still worth
   watching the symptom — `[Inbox] ⏸ <agent>: last identity write <txid> not yet
   confirmed — deferring this cycle` repeating for hours — since the backstop remains
   the fallback when a concurrent writer confirms on top of ours.

3. **`valueAlreadyOnChain` false negatives.** The already-on-chain short-circuit compares
   via `JSON.stringify`. For DataDescriptor **objects** the daemon's decode round-trip
   may never compare equal, so the short-circuit may silently never fire. It cannot
   cause data loss (it can only fail to skip a write), but it would mean an
   idempotent rebroadcast per cycle at 10,000 sats for a stuck-ack item. Symptom:
   repeated identical writes for an item that is already on-chain.

4. **Escalation dead-lettering healthy items.** If a batch fails non-contention 5 times
   with the same items, every item in it starts counting and can eventually dead-letter.
   Intended (nothing may spin forever), but if it fires because of an **environmental**
   fault, healthy items get quarantined. Symptom: `batch failed 5x with the same items —
   escalating to per-item counting`. Report the preceding error if you see this.

5. **Multi-agent concurrency.** The gate is per agent. Several agents writing in the same
   cycle is expected and fine — but worth watching that one agent deferring does not
   block others.

---

## Invariants that must NOT regress (security)

Please sanity-check these; a break here is worse than the original bug.

- **An item's VDXF keys are gated against its OWN type before merging.** A `review` item
  must never write the attestation key, and vice versa. SDK commit `52f8d07` exists
  because an audit caught exactly that. Batching merges additions from several items, so
  if you ever see an on-chain key that does not belong to the item type that wrote it,
  stop and report immediately.
- **One poisoned item must never block healthy ones.** A bad item should be rejected
  alone while the rest of the batch still writes.
- **Nothing retries forever.** Every failure path is either counted (→ dead-letter) or
  bounded (→ escalation). Contention is the sole exception and is expected to
  self-resolve within minutes.

---

## Reference

- Unit tests: SDK **350/350**, dispatcher **614/614** — all green.
- Design + audit history: `docs/superpowers/plans/2026-07-29-batched-identity-update.md`.
- Backend-facing correction memo (includes the misdiagnosis this run corrected):
  `../../docs/backend-reports/2026-07-29-issue1-correction.md`.
- Live log (session-scoped — copy it out if you need it to survive):
  `/tmp/claude-1000/-home-mainn-dispatchertest3/bde9e6e4-e39f-4600-b331-d9889160ce2a/scratchpad/dispatcher-0729c.log`
- Quick watch:
  `tail -f <that log> | grep -E "Inbox batch written|item\(s\) accepted|DEAD-LETTER|Transaction rejected|ack failed|deferred|escalating"`

### One bug the live run caught that unit tests did not
A TDZ `ReferenceError` (`Cannot access 'verifyWitness' before initialization`) broke the
inbox sweep for every agent with an **empty** inbox. Fixed in `d45a668`. It escaped
because the tests drive `processInboxForAgent` directly and never `checkPendingInbox` —
**the sweep-level wiring is still untested** (`getAgentSession` is not injectable). If
you see per-agent `[Inbox] Error checking <agent>` lines, that layer is the suspect.

**Unit tests prove the logic; they cannot prove the chain behaves.** The mempool/confirmed
`prevOutput` timing is stubbed in tests and real only in production. That is what this
E2E run is for.
