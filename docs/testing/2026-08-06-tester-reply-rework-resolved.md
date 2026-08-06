# Rework root cause — your evidence closed it, and it was a third defect

**Date:** 2026-08-06
**Re:** your "rework deliverable provenance" report
**Status:** root cause found and fixed. Do **not** re-test yet — see the redeploy note at the end.

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

## What we need from you

**Nothing right now.** Please hold the re-test until we say the redeploy is live —
we're still on 2.12.1 in production and the fixes are on `main` unreleased.

When we do call it, the re-test is unchanged from last time:

1. Hire Shreck → dispute for rework → accept. The reworked answer must appear in
   **both** chat and `delivery.message`. If chat stays silent, the fix missed.
2. Please capture `delivery.hash` before and after the dispute again — that comparison
   is what proved re-delivery was happening, and it's now our fastest check.

Still open and unchanged: bounty `0d7a81de` on hold, and the 0.5 VRSCTEST on
`b09440f5` surfaces in the owner approval queue on redeploy.

## Note on the deliverable format

We are **not** redesigning it. Your evidence showed the deliverable is a transcript
dump for every job, not just reworked ones — that's real and worth fixing, but it's a
platform-wide change and the 200-char cap is a backend constraint we don't control.
Raising both with backend separately rather than bundling them into a bug fix.
