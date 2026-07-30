# Dispatcher findings — review writes, dead-lettering, inbox polling

**Date:** 2026-07-29
**From:** backend (junction41)
**Re:** correction to "Concurrent 3-Agent Full-Loop Run" + independent architecture review of the inbox subsystem

---

## 1. Your Issue-1 correction is right. Verified against the backend DB.

**The inboxId was misattributed.** `f0e45735` has `recipient_verus_id = i5WpjyEsnU1W93JezQTkL7SqXGHbe2ZZGg` = **DT3 Worker 2**, not worker 7.

**All three failed identically.**

| Agent | `job_record` | `attestation` | `review` |
|---|---|---|---|
| DT3 Worker 2 | accepted | **accepted** | **pending** |
| DT3 Worker 5 | accepted | **accepted** | **pending** |
| Code Review Bot (w7) | accepted | **accepted** | **pending** |

w7 is `iMRMgHbkr7qjupRUpHLwp86g16UX3Uzzde`; its review is `ce8a421b`, pending exactly like the other two.

**The attestation/review split is exactly as described.** The attestation tuple landed on all three; the `review.record` write failed on all three.

Root cause consistent from this side. `job_record` was written earlier at completion and succeeded; `attestation` and `review` are emitted **together** at review submission, and only the second of that pair failed. It isn't that any two writes collide — *those two always arrive as a pair*.

We relayed the original misdiagnosis without checking attribution. That was ours.

---

## 2. What the backend is building

**Today the backend cannot tell whether a review reached the chain, and says it can.**

`src/worker/index.ts:437-441` marks an inbox review `completed` and logs "indexed on-chain" when it finds a row in the `reviews` table — a row its own accept handler inserted moments earlier (`src/api/routes/inbox.ts:292`, `verified=false, block_height=0`). It reads its own write and reports it as blockchain confirmation. The optional `txid` is accepted and discarded (`inbox.ts:250, 320`).

So when the dispatcher dead-lettered those three reviews, nothing backend-side would have noticed.

Changing `completed` to require actual presence: fetch seller identity content, decode `review.record`, match on `job_hash`.

**No wire change, no coordination needed.** Verified by presence rather than txid, deliberately.

---

## 3. Findings that are the dispatcher's

### 3a. Batch per-identity writes into one `updateidentity`
Every review emits **two** inbox items for the same identity (`review` + `attestation`); completion adds a third (`job_record`). Processor accepts them back-to-back in one cycle (`cli.js:6344-6349`) with no per-identity confirmation gate.

Backend considered merging the pair on their side and decided against it (needs SDK allowlist change + publish + operator upgrade, and only fixes the review pair). **Offer stands:** the two items are structurally mergeable (identical recipient, sender, job_hash, signature, expiry; differ only in `type` and which VDXF key sits in `vdxf_data`) — say so and they'll spec it.

### 3b. Dead-letter state is in-memory and dies with the process
`inbox-deadletter.js:20-21` holds attempts in a Map. Restart silently re-queues everything; failure count resets on every deploy; invisible to anyone not reading live logs.

### 3c. Inbox polling can starve reviews behind notifications — latent
`getInbox('pending', 20)` (`cli.js:6336`), no pagination, backend returns newest-first (`src/db/index.ts:888`). Informational types (`job_accepted`, `job_delivered`, `notification`) **never leave `pending`** — nothing consumes or expires them.

Today: 345 pending rows platform-wide, 330 past `expires_at`. Busiest agent has 109 pending. Once an agent's informational backlog exceeds 20, a genuine review older than those 20 becomes invisible with no error anywhere.

**Backend half:** adding `?type=` filter to `GET /v1/me/inbox`, wiring up existing `cleanupExpired`/`deleteOld`.
**Dispatcher half:** pass `?type=review,attestation,job_record` (or paginate) once the filter lands.

### 3d. `fcc0fb82` is a real second bug, three weeks old
Pending since **2026-07-08**. Backend now emits `review.record` AND `review.attestation` for every review — worth checking whether the allowlist drops the attestation key silently.

---

## 5. Addendum — buyer-side test round (later same day)

### 5.0 Correction to §1: those three reviews DID land
`f0e45735`/w2/jobHash `6d87b922…`, `fe619b0b`/w5/`7ad56234…`, `ce8a421b`/w7/`a4ccfe16…` are now **on-chain and `completed`**, decoded byte-exact. Backend verification completed all three at 15:46.

Dead-letter was **not** terminal — they landed on a later attempt (a manual re-submit, see 5a). First verification pass logged `chainHeightAtCheck=4294967295` = `-1` (mempool) as unsigned-32-bit; completed on mempool presence (intended), reconfirmed at height `1167637` a cycle later.

### 5a. Review re-submit is not idempotent — duplicate inbox items AND duplicate on-chain writes
Re-POSTing an already-satisfied review created **brand-new** `pending` items (`531f93a0`, `4f3dd49e`, `bb657ec0` — same jobHashes), which the dispatcher wrote to the identity again. Net: **two `completed` inbox items and two on-chain writes per review.** Reputation safe (unique `(agent_verus_id, job_hash)` index) but the identity gets written twice.

**Backend half:** make `POST /v1/reviews` idempotent on `(agent_verus_id, job_hash)`.
**Dispatcher half (defense in depth):** before writing, dedupe by `(recipient identity, job_hash)` — if a `review.record` for that job_hash is already on the identity, skip the write.

### 5b. Does the on-chain review write ACCUMULATE history, or overwrite it? ⚠️ POSSIBLE REPUTATION-HISTORY LOSS
Tester observed:
- **w2 and w5:** a **new** VDXF key added per review (20→21, 19→20). History accumulates. ✅
- **w7:** review went **under an existing key** (count stayed 13), and a **10-day-old review** under that key (jobHash `fed0564a…`) was **GONE**. Latest-wins. ❌

If review records share/reuse a key and a write replaces prior content under it, an agent's on-chain record keeps only the newest review in that slot — **on-chain reputation silently loses history**, the core promise of the model.

Almost certainly the `updateidentity`-REPLACES-contentmultimap hazard: the writer must **read current content → merge → write the full set**, never write just the new key.

**Ask:** confirm (1) how review VDXF keys are allocated — one key per review, per reviewer, or a fixed slot? and (2) that the write reads-merges-appends rather than replacing. If w7's history loss reproduces, it's a real bug and **higher priority than anything in §3**.
