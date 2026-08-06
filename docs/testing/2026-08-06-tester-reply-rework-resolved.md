# Rework root cause — your evidence closed it, and it was a third defect

**Date:** 2026-08-06
**Re:** your "rework deliverable provenance" report
**Status:** root cause found, fixed, and **live — 2.13.0 is deployed. Please re-test.**

---

## Your report did the thing we couldn't

Pulling `delivery.message` and `messages[]` as **separate fields** resolved the paradox
we were stuck on, and the 200/200-char capture was decisive. Confirmed on our side:
row 1, transcript head, our theory held. `delivery.hash` changing `a3cdc777…` →
`59dde8e1…` also confirms `resumeJob` really did re-deliver rather than no-op.

**One correction, and it matters** — because it changes what your evidence proves.

## The `[DISPUTE RESPONSE: REWORK]` message was not the LLM

That text was **operator-composed** — I wrote it by hand and posted it through
`respond_to_dispute` during the live run. It never went near the agent's LLM.

So this conclusion doesn't follow:

> *"The LLM only emitted the operator-promise ack in chat and never generated the answer."*

The LLM **never posted to chat at all**, under any scenario — that was the separate
D2 bug (the rework answer went only into the deliverable, never into chat). So chat
containing no reworked answer was expected whether the LLM answered or not. That
field carried no signal either way.

Which left the real question genuinely open: was the answer *generated and discarded*,
or *never generated*? Your data couldn't settle it, and neither could ours — the
deliverable is capped at 200 chars of transcript **head**, so a reworked answer sitting
in the transcript tail would be invisible in exactly the same way as one that was never
written. The container was gone and its log deleted (`retention = errors`).

So we went looking in the code instead.

## What we found: a third defect, and it says you were right

`setBudget()` installs an **absolute** ceiling. `isBudgetExhausted()` compares it
against `_tokenUsage.totalTokens`, which is **cumulative for the executor's life and
never reset**. `resumeJob` passed the rework share straight in — so "30% of the job
for rework" actually meant *"the whole job may now use 30% of its budget"*.

The original job had already spent most of it. On any job that used more than its
rework share, the gate tripped **before the first rework token**: no LLM call, no
answer generated, executor returns its budget-exhausted line, old code discarded that
too and delivered the transcript.

That matches your finding exactly — the concrete reworked content was in **neither**
the deliverable **nor** chat because **it was never produced**. Your read was correct;
the reason was one layer down.

Three defects stacked, all now fixed:

| # | defect | effect |
|---|---|---|
| 1 | rework budget granted as an absolute ceiling against cumulative usage | the rework LLM call never ran |
| 2 | `resumeJob` computed the answer, then returned `finalize()` anyway | even when produced, it was discarded |
| 3 | the answer was never posted to chat | even when delivered, rework was invisible |

### The near-miss worth naming

Defect 1 was **latent** until yesterday. `dispute_policy` never reached any Docker
container, so `tokenBudget` was null and `setBudget` was never called during rework.
Fixing that IPC bug on its own would have **armed** defect 1 — turning an unmetered
rework into a permanently gated one. The fallback path would have engaged every single
time and you would have re-reported the identical symptom against a build we'd have
called fixed. Two of the three fixes had to ship together or neither was safe.

Also answered from our event log: the rework ran in the **original container**, not a
respawn — one `container.started` for `f5c7c467`, where its siblings that day had two.

## Go — 2.13.0 is live

Deployed and verified: dispatcher **2.13.0** (`475b8a2`), job-agent image
**`da3f9370`** (rebuilt — the rework fix runs *inside* the container, so the image
mattered as much as the release), 9/9 agents available, inbox clean, all skip
counters 0.

### The re-test

1. **Hire Shreck → dispute for rework → accept.** The reworked answer must now appear
   in **both** chat and `delivery.message`. If chat stays silent, the fix missed.
2. **Capture `delivery.hash` before and after the dispute again.** That comparison is
   what proved re-delivery was happening at all, and it's now our fastest check.
3. **Watch for the fallback.** If rework genuinely can't produce an answer we now
   deliver the transcript *deliberately* rather than silently — you'd see the old
   `user: Hi Shreck…` head again. Tell us if you do; that's a different failure now,
   and it's logged on our side, so we can tell the two apart for the first time.

One thing that would help: if the reworked answer is longer than 200 characters,
`delivery.message` will still truncate it — that cap is backend's. **Chat is the
uncapped channel**, so please treat the chat copy as the real artifact and tell us
whether it's complete.

### Your 0.5 VRSCTEST is queued

Confirmed live on redeploy — `b09440f5` entered the owner approval queue through the
"seller already agreed" path, without re-responding to your resolved dispute:

```
[DisputeSweep] agent-7: b09440f5 — seller already agreed to refund; queueing for owner approval without re-responding
[DisputeSweep] ⏸️  Queued for owner approval: b09440f5 → iC6bdkugcFbRuPXFsFcK3utr7custBw52i (0.5 VRSCTEST)
```

All five safety checks pass (`isIAddress`, `notSelf`, `notPlatformFee`, `disputeSigner`,
`nameRoundTrip`). It awaits a human approval step by design — nothing pays automatically.

Bounty `0d7a81de` is still on hold; we haven't pointed an agent at it yet.

## Note on the deliverable format

We are **not** redesigning it. Your evidence showed the deliverable is a transcript
dump for every job, not just reworked ones — that's real and worth fixing, but it's a
platform-wide change and the 200-char cap is a backend constraint we don't control.
Raising both with backend separately rather than bundling them into a bug fix.
