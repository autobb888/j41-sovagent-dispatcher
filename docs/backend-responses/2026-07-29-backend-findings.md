# Dispatcher findings — review writes, dead-lettering, inbox polling

**Date:** 2026-07-29
**From:** backend (junction41)
**Re:** your correction to "Concurrent 3-Agent Full-Loop Run", plus an independent architecture review of the inbox subsystem

> **Note (dispatcher side, 2026-07-30):** this file now holds the *verbatim* backend
> report as received (source: `docs/backend-reports/2026-07-29-dispatcher-review-write-findings.md`
> in the backend repo). It previously held a condensed paraphrase. Section numbering
> is unchanged, so all citations in `2026-07-30-dispatcher-reply.md` still resolve.

---

## 1. Your Issue-1 correction is right. Verified against the backend DB.

All three of your checkable claims hold. I queried rather than took your word for it:

**The inboxId was misattributed.** `f0e45735` has `recipient_verus_id = i5WpjyEsnU1W93JezQTkL7SqXGHbe2ZZGg` = **DT3 Worker 2**, not worker 7. The original report built its entire per-agent theory on that ID being w7's.

**All three failed identically.** For every agent in the run window:

| Agent | `job_record` | `attestation` | `review` |
|---|---|---|---|
| DT3 Worker 2 | accepted | **accepted** | **pending** |
| DT3 Worker 5 | accepted | **accepted** | **pending** |
| Code Review Bot (w7) | accepted | **accepted** | **pending** |

w7 is `iMRMgHbkr7qjupRUpHLwp86g16UX3Uzzde`; its review is `ce8a421b`, pending exactly like the other two. No agent is singular.

**The attestation/review split is exactly as you described.** The attestation tuple landed on all three; the `review.record` write failed on all three. Two different write paths, one succeeded, one didn't.

Your root cause — the review tx built against a `prevOutput` already spent by the unconfirmed attestation tx — is consistent with everything I can see from this side. The ordering in our inbox confirms the shape: `job_record` was written earlier at completion and succeeded; `attestation` and `review` were emitted together at review submission, and only the second of that pair failed. It isn't that any two writes collide — it's that *those two always arrive as a pair*.

We relayed the original misdiagnosis without checking the attribution. That was ours; one query would have caught it.

---

## 2. What we're building on our side, and why it matters to you

**Today the backend cannot tell whether a review reached the chain, and says it can.**

`src/worker/index.ts:437-441` marks an inbox review `completed` and logs *"indexed on-chain"* when it finds a row in our `reviews` table — a row our own accept handler inserted moments earlier (`src/api/routes/inbox.ts:292`, `verified=false, block_height=0`). It reads our own write and reports it as blockchain confirmation. The optional `txid` you may send is accepted and discarded (`inbox.ts:250, 320`).

So when your dispatcher dead-lettered those three reviews, **nothing on our side would ever have noticed.** They stayed `pending` only because your dead-letter is terminal; had they reached `accepted`, we'd have called them verified.

We're changing `completed` to require actual presence: fetch the seller's identity content, decode `review.record`, match on `job_hash`. Only then does it complete. Stuck items surface in our admin queue.

**Why this is useful to you:** it turns silent write loss into a visible counter. Once it ships, a recurrence of the mempool collision shows up on our side within a poll cycle instead of being discovered by a human reading logs days later. It's also how you'd confirm your sequencing fix actually worked, rather than inferring it from an absence of complaints.

**No wire change, no coordination needed.** We verify by presence rather than by txid deliberately, so this works against dispatchers of any version. You don't have to send us anything new.

Expect this to make things look worse before better: reviews that currently show verified will start showing stuck, because they always were.

---

## 3. Findings that are yours

From an independent architecture review of the inbox subsystem. Ordered by value-for-effort as we'd rank them.

### 3a. Batch per-identity writes into one `updateidentity` — eliminates the collision class

Every review emits **two** inbox items destined for the same identity (`review` + `attestation`), and completion adds a third (`job_record`). Your processor accepts them back-to-back in one cycle (`cli.js:6344-6349`) with no per-identity confirmation gate. That *is* the double-spend, by construction.

`contentmultimap` takes multiple keys in a single update, so all pending keys for one identity can go in one transaction. That fixes the whole class rather than the observed instance — sequencing with confirmation waits also works, but costs a block of latency per item where batching costs none.

**We considered merging the pair on our side and decided against it**, because it would need an SDK allowlist change, a publish, and an operator upgrade cycle, and it would only fix the review pair while `job_record` and anything future would still collide. Batching on your side fixes all of them with no cross-repo coordination. If you'd rather we merged the emit instead, say so — the two items are structurally mergeable (identical recipient, sender, job_hash, signature, expiry; they differ only in `type` and which VDXF key sits in `vdxf_data`), and we'll spec it.

### 3b. Dead-letter state is in-memory and dies with the process

`inbox-deadletter.js:20-21` holds attempts in a Map. A restart silently re-queues everything, which is how the immediate remedy works — but it also means a dead-lettered item is invisible to anyone not reading live logs, and the failure count resets on every deploy.

Persisting attempts and a failed state would make it observable and survivable. It would also let us surface your dead-letters alongside ours.

### 3c. Inbox polling can starve reviews behind notifications — latent, not yet biting

You poll `getInbox('pending', 20)` (`cli.js:6336`) with no pagination, and we return newest-first (`src/db/index.ts:888`). Our informational item types — `job_accepted`, `job_delivered`, `notification` — **never leave `pending`**, because nothing consumes them and nothing expires them. They accumulate.

Today: 345 pending rows platform-wide, 330 already past their `expires_at`. Our busiest agent has 109 pending. Nothing is starved *right now*, but once an agent's informational backlog exceeds 20, a genuine review older than those 20 becomes invisible to your poller with no error anywhere.

**We're fixing our half**: adding a `?type=` filter to `GET /v1/me/inbox`, and calling the `cleanupExpired`/`deleteOld` functions that already exist in our codebase but were never wired up. **Your half:** pass `?type=review,attestation,job_record` (or paginate) so informational volume can't crowd out chain writes. We'll tell you when the filter is live.

### 3d. `fcc0fb82` is a real second bug, three weeks old

```
DEAD-LETTER review fcc0fb82 for agent-5 —
  acceptReview: inbox vdxfData contained no review.* keys after whitelist
```

You flagged it as unrelated, and it is — but it's been pending since **2026-07-08**, not just this run. If SDK `52f8d07` narrowed the allowlist to `review.record`, that's worth confirming against what we actually emit, because we now emit `review.record` *and* `review.attestation` for every review. Worth checking whether the allowlist drops the attestation key silently.

---

## 4. Not asking you for anything

Nothing in sections 1–3 needs a backend change from you, and we're not blocking on any of it. 3a is the one we'd prioritise; 3c needs a small change on your side once our filter lands, and we'll flag it.

Reply on this file or open one in `docs/backend-responses/`.

---

## 5. Addendum — 2026-07-29 (later same day): buyer-side test round

A buyer-side tester ran a fresh 3-agent loop and decoded the on-chain results. Two corrections and two new findings.

### 5.0 Correction to §1: those three reviews DID land — the dead-letter recovered

The three reviews §1 discussed as dead-lettered (`f0e45735`/w2/jobHash `6d87b922…`, `fe619b0b`/w5/`7ad56234…`, `ce8a421b`/w7/`a4ccfe16…`) are now **on-chain and `completed`**. The tester decoded all three byte-exact on the sellers' identities (jobHash, buyer, rating, timestamp, signature all match). Our new §2 verification then confirmed presence and completed all three at 15:46 — logged `Inbox review confirmed present on seller identity`.

So: the `review.record` write path **does** succeed; the dead-letter was **not** terminal — the reviews landed on a later attempt (a manual re-submit, see 5a). Two useful confirmations fall out of this:
- **The §2 verification feature works as designed.** It completed exactly the reviews that were genuinely present, and only those. First pass logged `chainHeightAtCheck=4294967295` — that's `-1` (mempool) as unsigned-32-bit; it completed on mempool presence (intended), and reconfirmed at real height `1167637` a cycle later.
- **§3a/§3b matter more, not less.** These landed only because a human re-submitted. With persistent dead-letter state + auto-retry (§3b), that recovery would have been automatic and the churn in 5a would not exist.

### 5a. Review re-submit is not idempotent — it mints duplicate inbox items and duplicate on-chain writes

Re-POSTing an already-satisfied review created **brand-new** `pending` inbox items (`531f93a0`, `4f3dd49e`, `bb657ec0` — same jobHashes as the originals), which your dispatcher then wrote to the identity again, and which our verifier then also completed. Net: **two `completed` inbox items and two on-chain writes per review.** (Reputation is safe — our `reviews` table has a unique `(agent_verus_id, job_hash)` index, so no double-count — but the identity gets written twice.)

- **Our half (backend):** we'll make `POST /v1/reviews` idempotent on `(agent_verus_id, job_hash)` — return the existing inbox item instead of minting a new one. That removes the duplicate at the source.
- **Your half (defense in depth):** before writing, dedupe by `(recipient identity, job_hash)` — if a `review.record` for that job_hash is already present on the identity, skip the write. Cheap, and it protects against any future path that re-emits.

### 5b. Does the on-chain review write ACCUMULATE history, or overwrite it? (possible reputation-history loss)

This is the one we'd like you to check. The tester observed:
- **w2 and w5:** a **new** VDXF key was added per review (key count 20→21, 19→20). History accumulates. ✅
- **w7:** the review went **under an existing key** (count stayed 13), and a **10-day-old review** that had been under that key (jobHash `fed0564a…`) was **gone**. Latest-wins. ❌

If review records can share/reuse a key and a write replaces the prior content under it, then an agent's on-chain record keeps only the newest review in that slot — and **on-chain reputation silently loses history**, which is the core promise of the whole model.

This is almost certainly the `updateidentity`-REPLACES-contentmultimap hazard: `updateidentity` overwrites the entire contentmultimap, so the writer must **read current content → merge → write the full set**, never write just the new key. A partial write, or a key-allocation scheme that collides two reviews onto one key, produces exactly what w7 shows.

**Ask:** confirm (1) how review VDXF keys are allocated — one key per review, per reviewer, or a fixed slot? — and (2) that the write reads-merges-appends rather than replacing. If you can reproduce w7's history loss, it's a real bug and higher priority than anything in §3. Our side accumulates correctly (one `reviews` row per agent+job); this is purely the on-chain representation, which is yours.

Reply on this file or open one in `docs/backend-responses/`.
