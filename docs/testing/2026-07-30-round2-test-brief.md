# Test brief — round 2 (dispatcher 2.7.0 / SDK 2.12.1)

**Date:** 2026-07-30
**Live now:** dispatcher 2.7.0 commit `a4eded2`, SDK 2.12.1, image `30959521`. Both published to npm.
**Read time:** 2 minutes. This is deliberately short — round 1's brief covers background.

---

## The one thing that matters

**Get an agent to hold an attestation AND a review at the same time.**

That pair is the entire bug. Everything else in this release is scaffolding around it.
Complete a job and submit a review — the platform emits both items together, to the same
identity, which is exactly the collision.

- **PASS:** `[J41] ✅ Inbox batch written on-chain (2 item(s)): <txid>` — **one** txid,
  both items accepted.
- **FAIL:** two txids for that agent in one cycle, or `Transaction rejected by the network`.

Then confirm on-chain that **both** keys are actually present, not just that the log looked
happy.

**Why this is still open:** round 1 never produced it. Every live batch so far was a single
item, and the three recovered reviews each landed in their own transaction. The merge is
proven by unit tests and has never run against real traffic.

---

## Four smaller things, if the run allows

1. **Duplicate review → no second write.** Re-submit a review that already landed. Expect
   **no new transaction** and no fee — the item should be acked without a broadcast.
   (New in 2.12.1: dedupe by jobHash, not just byte-identical match.)

2. **`ctl inbox` / `ctl inbox-redrive`.** Never exercised live. `ctl inbox` should show
   `{deadLettered, retrying, ackFailed, pendingWrites}`. If anything is dead-lettered,
   `ctl inbox-redrive --item <id>` should genuinely retry it, not just clear the list.

3. **`pendingWrites` clears.** Watch `/health` during a write: an entry should appear and
   then **disappear** once confirmed. An entry with an ever-growing `ageMs` is a bug —
   report it.

4. **Nothing regressed on the single-item path.** Most cycles have one item. It must still
   work exactly as before.

---

## Expected, not bugs

- **`fcc0fb82` will dead-letter again.** Legacy malformed item from 2026-07-08 — raw JSON
  field names instead of VDXF keys. Permanently invalid until the backend expires it.
  Exactly one dead letter is correct.
- **`status` flips to `degraded`** whenever anything is dead-lettered. Intentional. It will
  trip anything alerting on `status != ok`.
- **`?type=` filter has no visible effect yet.** We send it; the backend has merged but not
  deployed it. Unknown params are ignored, so this is a no-op until their deploy.

---

## Where I'd expect breakage

Ranked. Round 1's top risk (txid-less ack) is now **resolved** — the backend confirmed
`400 ALREADY_PROCESSED` is terminal success and we handle it.

1. **Two items merging for real.** The whole point, and the only thing unit tests can't
   prove. Watch for one txid, not two.
2. **jobHash dedupe misfiring** — if it wrongly considers a *new* review already-present, a
   genuine review silently never writes. Symptom: a review acked with no transaction and no
   on-chain record. This would be the worst outcome in this release; check any acked review
   actually landed.
3. **Unknown-identity returns 502, not 404.** Confirmed live, backend contract mismatch.
   Only affects identity-history reads, which nothing in the job flow uses yet.
4. **Sweep-level wiring.** `checkPendingInbox` has no unit test (`getAgentSession` isn't
   injectable) — this is how round 1's TDZ bug escaped. Any `[Inbox] Error checking <agent>`
   line points here.

---

## Already proven, don't re-test

- Batching mechanics, per-item independence (a poisoned item rejected alone while a healthy
  one still wrote) — round 1, live.
- Dead-letter recovery — all three reviews wrote.
- `workerAttachedAt` populating — three agents, survives the full job lifecycle.
- Identity history reconstruction — verified directly against 30 real snapshots on w7;
  recovered a review absent from current state.

---

## Reference

- Log: `/tmp/claude-1000/-home-mainn-dispatchertest3/bde9e6e4-e39f-4600-b331-d9889160ce2a/scratchpad/dispatcher-0730.log`
- Watch:
  `tail -f <log> | grep -E "Inbox batch written|item\(s\) accepted|DEAD-LETTER|Transaction rejected|ack failed|deferred|escalating|Error checking"`
- Health: `curl -s http://127.0.0.1:9842/health | jq .inbox`
- Round 1 brief: `docs/testing/2026-07-29-batched-inbox-testing-brief.md`

Unit tests: SDK 370/370, dispatcher 614/614.
