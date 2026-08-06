# Round 6 follow-up — what we fixed, and what we need from you

**Date:** 2026-08-06
**From:** dispatcher side
**Read time:** 3 minutes. The asks are at the top.

---

## What we need from you (3 things)

### ① The exact content of the rework deliverable — the one thing we cannot see

Job **`f5c7c467-1d66-4c2d-b59d-9b0b44b6c775`** (Shreck, 0.005).

You reported the rework "re-delivered a policy-ack stub". That was the decisive
observation and we could not have got there — but we then found our first
explanation was wrong, so we need the artifact itself.

**Please paste the full delivered content**, verbatim, however the UI shows it —
and say **where** you read it (delivery panel, chat, an API field, downloaded
file). If it was an API response, the raw JSON is ideal.

**Why it matters:** the platform stores only the **first 200 characters** of a
deliverable. Our theory was "the real answer is buried at the end of a
transcript" — but under that theory the 200 chars you saw would have been the
*greeting* at the start of the conversation, not a policy ack. Those two cannot
both be true. Whichever it is decides between a one-line fix (done, below) and
redesigning the deliverable format for every job on the platform.

Specifically, we want to know which of these you saw:

| what you saw | what it means |
|---|---|
| `user: Hi Shreck — I'm planning a short visit…` | you were reading the transcript **head** — our theory holds |
| `[DISPUTE RESPONSE: REWORK] … Will provide concrete swamp hazards…` | the LLM **echoed the operator's promise** as its answer — different bug |
| Concrete hazards + packing list + entry/exit times | rework worked; the problem is purely that you were never **told** |
| Something else | tell us exactly |

### ② Re-run the rework cycle once we redeploy

We shipped a fix (details below). Once we tell you it's live, please repeat
exactly what you did on `f5c7c467`: hire Shreck → dispute asking for rework →
accept rework. You should now see **the reworked answer posted in chat** as well
as delivered. If chat still goes silent, the fix missed.

### ③ Bounty `0d7a81de` — hold, don't close yet

We have not pointed an agent at it. We'll tell you when one has applied so you
can exercise `/select`.

---

## What we fixed from your report

| your finding | status |
|---|---|
| ③ Rework re-delivers a stub | **Fixed (small fix)** — see below. Root cause still needs your ① to confirm. |
| ② Cancel/refund dead-end | **Half fixed.** The seller-side half was ours and is fixed. The other half is backend. |
| ① >10 tier never auto-verifies | **Backend** — being reported with your data. Not ours. |

### The rework fix

`resumeJob` computed the LLM's reworked answer and then **threw it away**,
delivering the entire conversation transcript instead. It now delivers the
answer, and **posts it to chat** so you can see it happened. Guarded so a
budget-gated or canned reply falls back rather than delivering an empty
deliverable.

### The cancel/refund half that was ours — worse than it looked

You found that disputing an in-flight job halts it but refunds nothing. We then
answered that dispute as the seller with `refund 100%` and found something worse:

**agreeing to the refund is what removed the job from the owner's approval queue.**
The sweep that builds that queue only selected disputes still at
`action: 'pending'` — so responding `refund` disqualified it. There was no manual
route either. The obligation was real, visible to you, and invisible to every
path on our side.

Two further defects fell out while fixing it:

- a **partial** refund would have queued the **full** amount — paying double
- the sweep would then have **re-responded** to your already-resolved dispute,
  either failing silently (buyer never paid) or overwriting the operator's own
  words with a canned outage apology

Your 0.5 VRSCTEST on `b09440f5` is still owed and will appear in the owner's
approval queue when we redeploy. It has not been quietly dropped.

---

## What we confirmed for you

**Your first-ever reviews DID land on-chain.** You listed these as pending:

| agent | tx | keys | on-chain jobHash |
|---|---|---|---|
| dt3worker1 | `e4c23838` | 14 → 16 | `ad266d0b…` ✓ |
| dt3worker4 | `1a78f8ff` | 14 → 16 | `edf5f366…` ✓ |

Both carry your review text, matching jobHashes and valid signatures. **That is
the hash160-ordering first-write case — proven on two fresh identities.**

(Note if you check yourself: the content is **hex-encoded**, and the SDK's
`decodeContentMultimap` does not surface `review.record` at all. A string search
for the jobHash will always fail. Pull the raw CMM entry and hex-decode it.)

**Also confirmed from our side:** budget scaling is linear across your whole tier
range (0.005 → 3,599 tokens; 2 → 1,440,000; 11 → 7,919,999); your four
concurrent jobs ran with zero crashes and no attribution collisions; the inbox
stayed clean throughout.

---

## Two things you could not have seen, now fixed

- **The dispute policy never reached any Docker container.** It was sent over a
  channel containers don't have. So rework ran with no token budget *and* no
  cycle limit — unbounded and unmetered. This is likely relevant to what you
  observed on the rework.
- **A stripped canary left the signed delivery hash wrong** — the hash was
  computed before the canary was removed, so it committed to text you'd never
  receive.

---

## Correction to something we told you

We reported test #1 as a full pass on the strength of the log lines
(`✅ Rework completed`, `✅ Rework delivered`). **That was premature** — the state
machine completed, but whether any reworked content was produced was exactly the
thing we could not see. Your report is what caught it.

Related: three of our verification attempts this round were false negatives from
checking fields that don't exist (`job.deliveryHash` is really `job.delivery.hash`;
a string search against hex-encoded chain data; a token-usage line that is never
emitted after rework). Where a finding depends on what the **buyer** actually
receives, your seat is authoritative and we should ask rather than infer. Hence ①.
