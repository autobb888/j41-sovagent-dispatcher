# Agent Operational Integrity — Money-Safety Core (A + D + C) — Design

**Date:** 2026-07-16
**Status:** design — awaiting owner review before writing-plans
**Network context:** VRSCTEST (testnet), but this ships to mainnet — treat all money paths as real.

## Problem (what actually happened)

The DeepSeek-v4-pro LLM provider went down. During the outage:

1. Agents kept advertising `online: true` and **accepted paid jobs** they could not perform.
2. Every job delivered nothing (`delivery: null`, `tokenUsage: null`) — the executor's fallback string round-tripped so the transport *looked* healthy.
3. At the pause-TTL the platform **auto-opened a dispute** to protect the buyer — but the dispute waits on the **seller** to respond, and the seller is a down automated agent, so it deadlocked at `action: pending` (no deadline, no escalation, no arbiter on the platform side).
4. Net: **9 paid jobs, 0 delivered, buyer out 4.5 VRSCTEST**, held by our agents, until a human resolved each dispute by hand (2026-07-16).

The platform-side gaps (dispute deadline, auto-close on no-response, escalation/arbiter, platform-fee refundability) are the **buyer/backend team's** scope. This design is the **dispatcher (seller) side**: never take a job we can't do, and when we've been paid for nothing, get the money back to the buyer — under owner control.

## Goal

Make an agent's advertised availability mean **"can actually serve,"** and make **"paid-but-undelivered"** self-heal into an owner-approved refund — so an LLM outage can never again silently take money for nothing.

## Scope

This spec is the **money-safety core**, built first per owner decision:

- **Pillar A — Preflight LLM gate:** probe the agent's LLM before the dispatcher signs `acceptJob`; if it can't serve, don't accept (buyer is never charged).
- **Pillar C — Seller-side dispute auto-refund sweep:** periodically (and on LLM recovery) find disputes we caused (undelivered, no tokens) and **auto-respond `refund 100%`**, then enqueue the refund **send** for owner approval.
- **Pillar D — CLI manual-approve refund queue:** all outbound refund **sends** wait in a durable queue with a "why" report; the owner approves via `j41-dispatcher refunds …`; a notification seam (events.jsonl now, Telegram/Discord later) announces new items.

**Deferred to a follow-up spec (Pillar B — Liveness Monitor):** the ~5-min periodic health probe that flips the platform `online` flag and (tiered) deactivates the agent on-chain (VDXF) after a sustained outage, reactivating on recovery. Pillar A already gates the money path per-accept; B is the "advertise truthfully between jobs" layer and rides on the same `probeLLM` primitive built here.

## Global Constraints

- **CJS, no build step.** All files plain `.js`; validate with `node --check`. Tests: `node --test test/*.js`.
- **Owner-approval gate applies to outbound refund SENDS only.** Dispute *responses* (`respondToDispute`) and (future) on-chain deactivation are NOT gated — only money leaving a wallet is.
- **No double-send, ever.** The refund ledger records the send txid *before* the platform-submit step; `markJobRefunded`/`loadRefundedJobs` de-dup gates every send; the drain loop and the CLI approve command must never both send the same entry.
- **Fail closed.** A probe that errors or times out counts as **down** (don't accept). A refund whose buyer address can't be established is **not** auto-sent.
- **Reuse, don't reinvent.** Build on the existing `pending-refunds.json` ledger, `attemptPendingRefund`, `drainPendingRefunds`, `getAgentSession`, `safeInterval`, financial allowlist, and `state.emitEvent`.
- **Refund destination is verified, never guessed.** Send to the buyer's **i-address**, established by `resolveRefundTarget` (below) which must pass every check or the refund is held as `needs_review` and never sent. Owner approval is the authorization; on approve, that verified address is added to the financial allowlist with an audit line.
- **Refund amount = job amount × refundPercent.** The platform fee (separate address) is the platform's to refund, never the agent's.

## Architecture

Everything runs in the **long-running dispatcher process** (`src/cli.js`), which already holds authenticated `J41Agent` instances per agent (`getAgentSession`, `cli.js:4303`) able to call `sendCurrency`, `respondToDispute`, `submitRefundTxid`, and `acceptJob` directly (no sign-broker needed for these). The CLI `refunds` subcommands run as separate one-shot invocations that operate on the shared on-disk ledger and construct their own agent session to send.

```
accept loop (cli.js ~5054)                 liveness/sweep intervals (safeInterval)
  │                                           │
  ├─ probeLLM(resolveAgentLLMConfig(agent))   ├─ sweepDisputesForRefund(state)   [5 min + on recovery]
  │     down? → skip acceptJob, emit event    │     getMyJobs(disputed) → getDispute
  │     up?   → acceptJob (existing)           │     refundable? → respondToDispute(refund,100%)
  │                                            │                   → enqueue ledger {status:'pending_approval', reason}
  │                                            │                   → emit 'refund.pending_approval'  (notifyOwner seam)
  │                                            │
pending-refunds.json  ◄──────────────────────┘
  │  entries now carry: status, reason, disputeId, enqueuedAt, approvedAt
  │
  ├─ drainPendingRefunds(state)  [5 min]  → sends ONLY status==='approved' (retry of approved-but-unsent)
  │
  └─ CLI: j41-dispatcher refunds list | approve <jobId> | reject <jobId>
             approve → allowlist-add buyer (audited) → attemptPendingRefund → submitRefundTxid → status 'refunded'
```

## File Structure

**New files**

- `src/llm-health.js` — `probeLLM(llmConfig, opts)`; pure of dispatcher state, unit-testable with a fetch stub.
- `src/dispute-sweep.js` — `selectRefundableDisputes(jobs, disputeByJobId)` and `buildDisputeRefundEntry(job, dispute, agentInfoId, target)`; pure selection/shape logic, no I/O.
- `src/refund-target.js` — `resolveRefundTarget(job, dispute, ctx)` → the verified refund destination + all checks; the single source of truth for "where does the money go." Pure given its `ctx` (self-address set, platform-fee address, optional name resolver).
- `test/llm-health.test.js`, `test/dispute-sweep.test.js`, `test/refund-queue.test.js`, `test/refund-target.test.js`.

**Modified files**

- `src/cli.js`
  - add `resolveAgentLLMConfig(agentInfo)` (extract the model/provider/key resolution that `buildContainerEnv` does at `cli.js:5842`, reused by probe + future B).
  - accept path (~`cli.js:5054`, before `acceptJob` at `5064`): insert preflight probe.
  - `attemptPendingRefund` (`cli.js:4654`): honor `entry.status`; after send, if `entry.disputeId`, call `submitRefundTxid`; set `status:'refunded'`.
  - `drainPendingRefunds` (`cli.js` around `3755` interval): process only `status==='approved'`; leave `pending_approval` untouched.
  - crash-recovery enqueue (`buildAbandonedJobRefund` consumer): enqueue with `status:'pending_approval'` + `reason:'crash-recovery: job abandoned after docker launch retries'`.
  - new `sweepDisputesForRefund(state)` + register it on a `safeInterval` (5 min) and call once at boot after refund drain.
  - new Commander commands: `refunds`, `refunds list`, `refunds approve <job-id>`, `refunds reject <job-id>`.
- `src/refund.js` — extend the entry builder so ledger records carry `status`, `reason`, `disputeId`, `enqueuedAt` (keep `buildAbandonedJobRefund` back-compatible: default `status:'pending_approval'`).

## Components

### Refund-target resolution & verification (shared — the address gate)

**This is the single most safety-critical function in the build.** A refund's destination is established here and nowhere else; both the auto-enqueue (C) and the approve-send (D) go through it, and a refund is **never** sent unless it is marked `confident`.

**`resolveRefundTarget(job, dispute, ctx)` → `{ address, displayName, checks, confident }`** (`src/refund-target.js`, pure)

`ctx = { selfAddresses: Set<string>, platformFeeAddress: string|null, resolveName?: (iaddr)=>{name,iaddress} }`

Resolution:
- **Primary target = `job.buyerVerusId`** (the buyer's identity i-address). This is the destination — we send to the raw i-address, **never** to a friendly name (name→address resolution is the platform-trust step the SDK's H2 audit flags; we avoid it for the send).

Checks (each is a boolean in `checks`; **all required-true for `confident`**):
- `isIAddress` — `address` is a syntactically valid i-address (SDK `isIAddress`).
- `disputeSigner` *(dispute refunds only)* — `dispute.raised_by === address`. The buyer **signed** the dispute as `raised_by`, so equality here is cryptographic proof we are paying the identity that actually raised the claim. This is the strongest check; when a dispute exists it is **mandatory**.
- `notSelf` — `address` is not in `ctx.selfAddresses` (none of our agents' R-/i-addresses). Never refund to ourselves.
- `notPlatformFee` — `address !== ctx.platformFeeAddress`.
- `nameRoundTrip` *(advisory unless `resolveName` present)* — if a resolver is given, `resolveName(address)` returns a friendly name and resolving that name back yields the same i-address. Stored as `displayName` for the owner's eyeball check; a mismatch sets the check false.

`confident = isIAddress && notSelf && notPlatformFee && (dispute ? disputeSigner : true) && (nameRoundTrip !== false)`.

Behavior on `!confident`: the caller must **not** send. C enqueues the entry with `status:'needs_review'` (not `pending_approval`) and records the failing checks in `reason`; D's `approve` refuses to send a `needs_review` entry and prints exactly which check failed. Fail closed — a mismatch is a stop, not a warning.

The `refunds list` report and the approval prompt render `displayName`, `address`, and every check as ✓/✗ so the owner confirms the human-readable buyer **and** sees the cryptographic basis before any money moves.

> Note: the 9 manual refunds on 2026-07-16 already satisfied `disputeSigner` (every `dispute.raised_by` == `job.buyerVerusId` == the sent address). This function makes that check mandatory and machine-enforced.

### Pillar A — Preflight LLM gate

**`probeLLM(llmConfig, { timeoutMs = 5000 })` → `{ ok, latencyMs, status, error }`** (`src/llm-health.js`)

- `llmConfig` shape = `{ baseUrl, model, apiKey, customHeaders }` (same shape `resolveLLMConfig` returns, `local-llm.js:53`).
- POST `${baseUrl}/chat/completions` with `{ model, messages:[{role:'user',content:'ping'}], max_tokens: 1, temperature: 0 }`, headers = `customHeaders` or `Authorization: Bearer ${apiKey}`, aborted at `timeoutMs`.
- `ok` iff HTTP 2xx. Any non-2xx, network error, or timeout → `ok:false` with `status`/`error` populated. **Fail closed.**
- No SDK dependency; uses global `fetch` (same as the executor).

**`resolveAgentLLMConfig(agentInfo)` → `{ baseUrl, model, apiKey, customHeaders }`** (`src/cli.js`)

- Reads `loadAgentConfig(agentInfo.id)` (per-agent `llmProvider`/`llmModel`/`llmApiKey`) falling back to global `config.toml` `[llm]` and `[provider_keys]`, resolving `baseUrl`/`headers` from `LLM_PRESETS[provider]`. This mirrors what `buildContainerEnv` computes for the container; extract the shared resolution so the probe and the container agree on exactly which endpoint/model/key.
- **Only meaningful for `local-llm` executors.** For non-LLM executors (`webhook`, `a2a`, `mcp`, etc.) return `null` → preflight is **skipped** (those have their own health story; not in this spec).

**Accept-path hook** (`src/cli.js` ~`5054`, before the `acceptJob` at `5064`)

- Guard by a config flag `preflight_llm_check` (default **on**). When on and the agent is `local-llm`:
  - `const cfg = resolveAgentLLMConfig(agentInfo); const health = cfg ? await probeLLM(cfg) : { ok: true, skipped: true };`
  - if `!health.ok`: **do not sign/accept.** Log `[PREFLIGHT] LLM unavailable for <agent.id> (<status/error>) — declining job <jobId>, buyer not charged`. `state.emitEvent('job.declined_llm_down', { jobId, agentId, status: health.status })` and `state.emitEvent('agent.llm_down', { agentId, error })`. `continue` (job stays `requested` for another agent / times out).
- Short-circuit cache: keep `state.llmHealth = Map(agentId → { ok, at })`; if a probe within the last **30 s** returned `ok`, reuse it (accepts can burst). A `down` result is **not** cached as a pass — re-probe. This bounds probe cost without letting a stale "up" mask a fresh outage for more than 30 s.

### Pillar C — Seller-side dispute auto-refund sweep

**`selectRefundableDisputes(jobs, disputeByJobId)` → `Job[]`** (`src/dispute-sweep.js`, pure)

- Keep a job iff: `job.status === 'disputed'` AND its dispute exists with `action === 'pending'` AND `job.delivery == null` AND (`job.tokenUsage == null` OR no positive token count). These are jobs we were paid for and demonstrably did nothing on. Anything with a delivery or token usage is **excluded** (could be a legitimate quality dispute — not ours to auto-refund).

**`buildDisputeRefundEntry(job, dispute, agentInfoId, target)` → ledger entry** (`src/dispute-sweep.js`, pure) — `target` is the `resolveRefundTarget` result; the entry's destination is `target.address` (verified), and `status` is `'pending_approval'` only when `target.confident`, else `'needs_review'`.

```js
{
  agentInfoId,
  orphan: { jobAmount: Number(job.amount), buyerPayAddress: target.address,
            currency: job.currency || 'VRSCTEST', agentInfoId },
  refundAmount: Number(job.amount),           // 100%
  refundPercent: 100,
  buyerAddress: target.address,               // VERIFIED i-address (== dispute.raised_by)
  buyerDisplayName: target.displayName || null,
  addressChecks: target.checks,               // rendered in the report
  disputeId: dispute.id,
  status: target.confident ? 'pending_approval' : 'needs_review',
  reason: target.confident
    ? `LLM outage: paid ${job.amount} ${job.currency}, delivery:null, tokenUsage:null — dispute ${dispute.id} auto-opened by platform`
    : `ADDRESS UNVERIFIED — failing checks: ${Object.entries(target.checks).filter(([,v])=>v===false).map(([k])=>k).join(',')}`,
  enqueuedAt: /* caller-stamped ISO string */,
}
```

**`sweepDisputesForRefund(state)`** (`src/cli.js`, on `safeInterval` 5 min + once after boot drain + invoked on LLM-recovery transition)

- Build `ctx` once: `selfAddresses` = every agent's R-/i-address from `state.agents`; `platformFeeAddress` from config/known fee address; `resolveName` wraps `agent.client.resolveNames`.
- For each `state.agents`: `agent = await getAgentSession(...)`; `jobs = await agent.client.getMyJobs({ role:'seller', status:'disputed' })`; for each, `getDispute(jobId)` (tolerate 404 "no dispute"); `selectRefundableDisputes`.
- For each refundable job **not already in the ledger and not already refunded**:
  1. `target = resolveRefundTarget(job, dispute, ctx)`.
  2. `await agent.respondToDispute(jobId, { action:'refund', refundPercent:100, message: OUTAGE_APOLOGY })` — **not owner-gated** (honest acknowledgement; commits us to refund, no money moves yet). On failure, log and skip enqueue (retry next sweep). `OUTAGE_APOLOGY` is the standard-string constant defined in the plan.
  3. `entry = buildDisputeRefundEntry(job, dispute, agentInfoId, target)`; write into `pending-refunds.json`.
  4. `state.emitEvent(entry.status === 'needs_review' ? 'refund.needs_review' : 'refund.pending_approval', { jobId, agentId, amount, buyerAddress: target.address, displayName: target.displayName, reason: entry.reason })` + loud console line (the `notifyOwner` seam). A `needs_review` entry is a **red** line — the address didn't verify.
- Idempotent: `isRefundAlreadyHandled` (ledger or refunded-set) short-circuits; a dispute already `action:'refund'` with a `refund_txid` is skipped.

### Pillar D — CLI manual-approve refund queue

**Ledger entry status lifecycle** (`pending-refunds.json`, keyed by jobId):
`pending_approval` → (owner) `approved` → (send ok) `refunded`  |  (owner) `rejected`.
`needs_review` (address unverified) is a terminal-until-owner state: it is **never** sendable by `approve`; the owner must `reject` it or fix the underlying data. It never becomes `approved` automatically.

**`drainPendingRefunds` change:** iterate only entries with `status === 'approved'` (retry of approved-but-unsent, e.g. an RPC blip after approval). `pending_approval` and `rejected` are ignored by the daemon. This is the **one behavior change to existing crash-recovery**: those refunds no longer auto-send — they wait for `refunds approve`. (Flagged for owner confirmation below.)

**`attemptPendingRefund` change:** after the existing allowlist check + `agent.sendCurrency` + `markJobRefunded`, if `entry.disputeId` is present, `await agent.client.submitRefundTxid(jobId, txid)` so the dispute closes on-platform (as the manual cleanup did). Set `entry.status = 'refunded'`, record `entry.refundTxid` and `refundedAt`. Send txid is persisted **before** submit (existing ordering) — no double-send.

**Commands** (Commander, pattern per `cli.js:2574`):

- `j41-dispatcher refunds list [--all]` — table of `pending_approval` entries (default) or all: jobId, agent, amount+currency, buyer, age, reason.
- `j41-dispatcher refunds approve <job-id> [--yes]` — load entry; **refuse** if `status === 'needs_review'` (print the failing checks and stop). **Re-verify at approve time**: re-fetch the job + dispute and re-run `resolveRefundTarget`; if it is not `confident` OR its `address` differs from the stored `entry.buyerAddress`, abort and flag `needs_review` (never send a target that changed since enqueue). Then add the verified address to the financial allowlist with an audit log line (`[refund] owner-approved allowlist add <addr> for job <id>`); set `status:'approved'`, `approvedAt`; immediately run `attemptPendingRefund`; on success flag `refunded`; print the txid. Without `--yes`, print the why-report — including `displayName`, `address`, and every check ✓/✗ — and require an interactive confirm.
- `j41-dispatcher refunds approve --all` — approve every `pending_approval` entry (still audited per-entry).
- `j41-dispatcher refunds reject <job-id> --reason "<text>"` — set `status:'rejected'`, keep the entry for audit, log; **no send, no allowlist change.**

**Notification seam:** `state.emitEvent('refund.pending_approval', …)` writes to `events.jsonl` (queryable at control-API `GET /v1/events?since=N`). A future Telegram/Discord bridge is just a subscriber of that feed — no core change needed. For now the daemon also prints a loud, greppable console line.

## Data Flow

1. **Job arrives** → accept loop → `probeLLM` → up: accept (unchanged); down: decline, emit, buyer uncharged.
2. **Outage slips through / pre-existing disputes** → 5-min `sweepDisputesForRefund` → auto `respondToDispute(refund,100%)` + enqueue `pending_approval` + emit.
3. **Owner** runs `refunds list` (or gets a future TG ping) → `refunds approve <id>` → allowlist-add + send + `submitRefundTxid` → dispute `resolved`, buyer paid.
4. **RPC blip after approval** → next `drainPendingRefunds` retries the `approved`-but-unsent entry (de-dup guarantees single send).

## Error Handling

- Probe error/timeout → **down** (fail closed; don't accept).
- `respondToDispute` failure in sweep → skip enqueue, log, retry next sweep (no partial state — we only enqueue after the response commits).
- `sendCurrency` failure on approve → entry stays `approved`, txid unset; drain retries; owner sees it still listed.
- `submitRefundTxid` failure after a successful send → txid persisted, `status` stays `approved` with `refundTxid` set; a targeted retry re-submits without re-sending (guard on `refundTxid` present).
- Missing buyer address → entry not created (sweep logs a warning); never guess a destination.
- Corrupt ledger → treated as empty by `loadPendingRefunds` (existing behavior); entries are re-derivable by the next sweep.

## Testing

- `llm-health.test.js`: stubbed fetch → 200 ⇒ `ok:true`; 500/network-throw/abort ⇒ `ok:false`; asserts timeout is honored and body is minimal (`max_tokens:1`).
- `dispute-sweep.test.js`: `selectRefundableDisputes` includes only `disputed + pending + delivery null + no tokens`; excludes delivered / token-bearing / non-pending. `buildDisputeRefundEntry` produces the exact shape, 100%, buyer i-address, `pending_approval`.
- `refund-target.test.js`: `resolveRefundTarget` → `confident:true` only when `isIAddress` + `notSelf` + `notPlatformFee` + (dispute ⇒ `raised_by===address`); `confident:false` (and which check) when the address is a self-address, the platform-fee address, a non-i-address, or `dispute.raised_by` mismatches; `displayName` populated from the resolver and `nameRoundTrip:false` on a bad round-trip. This is the highest-priority test file.
- `refund-queue.test.js`: `drainPendingRefunds` sends `approved` only, skips `pending_approval`/`needs_review`/`rejected`; `attemptPendingRefund` calls `submitRefundTxid` iff `disputeId`; de-dup blocks a second send for a refunded job; approve adds the buyer to the allowlist; **approve refuses a `needs_review` entry**; **approve re-verifies and aborts if the re-resolved target differs from the stored address**.
- Preflight accept-path: unit-test the decision (`probeLLM` stub down ⇒ acceptJob not called, `job.declined_llm_down` emitted) via the existing accept-path test seams.
- `node --check` all changed files.

## Owner Decisions (confirmed 2026-07-16)

1. **Crash-recovery refunds gate too** ✅ — all outbound refunds (dispute-sweep AND crash-recovery) route through the approval queue as `pending_approval`; `drainPendingRefunds` no longer auto-sends new refunds, it only retries `approved`-but-unsent.
2. **`refunds approve --all` included** ✅ — batch approval, still audited + address-re-verified per entry.
3. **Preflight default on** ✅ — `preflight_llm_check` config flag (default on) for all `local-llm` agents.
4. **Refund-address correctness is a hard gate** ✅ (owner: "this we cannot get wrong") — `resolveRefundTarget` verifies every destination; `disputeSigner` (`dispute.raised_by === address`) is the mandatory cryptographic check for dispute refunds; unverifiable refunds are held `needs_review` and never sent; approve re-verifies at send time. Send target is the verified i-address; the friendly name is displayed + round-trip-checked for the owner's confirmation, not used as the send destination.
