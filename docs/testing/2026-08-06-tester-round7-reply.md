# Round 7 reply — test 1 confirmed, test 2 is backend, and a correction you should have

**Date:** 2026-08-06
**Now live:** dispatcher **2.15.0** (`55b3f2b`), job-agent image **`72b2b55e`**

---

## Test 1 — confirmed from our side too

Your timeline is the proof we could not produce ourselves, and it matches ours
exactly. From the dispatcher log:

```
[DisputeReconcile] job 6ff0885b is disputed with no worker — respawning for agent-6
[6ff0885b] Job already accepted (or post-delivery reconnect) — status=disputed
[6ff0885b] [CHAT] Joined room for 6ff0885b (connected but not a member — post-delivery respawn)
[6ff0885b] [DISPUTE] surfaced job 6ff0885b — owner=buyer
```

Every one of those lines is a defect that was live this morning:

1. **The respawn happened at all.** Before 2.14.0 a disputed job with no worker was
   invisible to the entire dispatcher until its deadline lapsed.
2. **It did not re-accept the job** (`status=disputed` → post-delivery path). Without
   that fix it would have called `acceptJob` on a job that cannot be accepted, hit
   the retry wall, and made the dispatcher **queue a refund for a job that had both a
   delivery and an agreed rework**.
3. **"connected but not a member"** — the socket was live and the agent was in no
   room. That is the silent-loss case: `sendMessage` is an ack-less emit, so the
   dispute alert would have vanished with every log line reading healthy.

3,716 chars, complete, all three requested sections. Thank you for the
`workerAttachedAt` observation too — you are right that container death is not
visible from your seat, and the elapsed time is the only proxy you have.

### One correction, because it changes what your test proves

> *"waited ~15 min — well past the 2-min compressed hold; the worker container had exited"*

**The 2-minute hold never took effect.** `J41_DISPUTE_HOLD_MAX_MS` is read by the
job-agent, which runs *inside* the container, but we only set it on the dispatcher
process — so the knob silently did nothing and the worker was on the 6-hour default.
Your log line would have read `Holding this worker open for 360 min`.

The worker had exited because **we killed it manually** at 20:05 to create the
orphan condition, having spotted that the knob was inert. So your test did exercise
the real path — the answer was served by a worker the reconciler respawned after the
original was gone — but the original died by our hand, not by the hold expiring.

Same conclusion, different mechanism, and you should know which. The knob is fixed
and now forwarded into the container.

---

## Test 2 — the `23505` is backend, and you found a real one

We agree with your read: a unique constraint on the disputes table rejects the second
dispute's insert, while the job's status is moved to `disputed` regardless. That
leaves the half-applied state you describe — `disputed` with no dispute record behind
it and no route to a second rework. It is going to backend with your data.

**Multi-cycle rework therefore remains completely unproven.** Neither the second
rework's budget nor `maxReworkCycles` has ever executed. We are not claiming those
work.

### What it exposed on our side, which was ours

A job stuck in `disputed` that can never resolve made our new reconciler respawn a
worker for it **14 times** — once per poll cycle, indefinitely. Retrying forever is
a resource leak that gets worse with fleet size, not resilience.

Fixed in 2.15.0: a job is respawned at most 3 times, after which we give up **loudly**
— one clear operator line naming the job and saying it will not be retried, a `stuck`
counter in the sweep summary, and a `dispute.reconcile_gave_up` event. A stuck job
never starves new work.

Your bug report produced a fix in code you cannot see. That is the second time this
round.

---

## The refund address — our error, not a platform one

You are right, and the mistake was in our brief. We told you to check
`RRZNgctv…` (your R-address). The queue pays the **buyer's VerusID i-address**, which
is where the platform credits job payments in the first place, and that is correct
behaviour — one of the five pre-send safety checks is literally `isIAddress`.

So: payment correct, our instruction wrong. Sorry for the confusion.

---

## Where things stand

| | |
|---|---|
| Refund `b09440f5` | ✅ received, 7 confs — closed |
| T1 slow-dispute rework | ✅ PASS, confirmed both seats |
| T2 multi-cycle rework | ❌ blocked by backend `23505`; our churn fixed |
| T3 bounty `0d7a81de` | ready — say the word and we'll point an agent at it |
| ~30% non-extendable rework budget | still a platform limit, with backend |

`6ff0885b` is left as you found it, and our side now degrades gracefully around it
rather than churning.

**Nothing to re-run right now.** Test 2 needs a backend fix before multi-cycle can be
tested at all. The most useful next thing from your seat is the bounty `/select`
flow, whenever you want it.
