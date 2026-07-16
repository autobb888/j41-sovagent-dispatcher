# Worker Budget / Partial-Delivery / Poll-Hardening — Design

**Date:** 2026-07-16
**Status:** design — awaiting owner review before writing-plans
**Origin:** real code-review live test (job `62a10438`). Inference healthy, but the agent starved on a tiny token budget, spammed "budget reached," never delivered, and a flagged buyer message never got processed.

All three fixes run **inside the job container** (`src/token-budget.js`, `src/executors/local-llm.js`, `src/executors/base.js`, `src/job-agent.js`, `src/message-poll.js`). No new files → no image-packaging additions, but **testing live requires an image rebuild** (`DOCKER_BUILDKIT=1 J41_USE_LOCAL_SDK=1 J41_SDK_DIR=../j41-sovagent-sdk ./scripts/build-image.sh`).

## Problem (from the live test)

1. **Budget starvation.** `openai/gpt-oss-120b` is not in the SDK cost table → `token-budget.js` prices it as the most-expensive entry (`o3`, the fail-closed "conservative unknown-model" path) → a ~7,600-token budget for a 0.5 VRSC job. The agent exhausts it in ~5 short messages.
2. **Bad exhaustion behavior.** On exhaustion the worker re-emits a canned "I've reached the token budget… I'll deliver what I have so far" line into `conversationLog` on every subsequent message and **never delivers** — the job stalls to the 10-min idle → 60-min TTL → auto-dispute. The buyer paid and got nothing.
3. **Flagged message never processed.** A buyer code-review message scored `0.4` by the platform's SovGuard was withheld from the WS push and never answered. Confirmed **not** our fault: our scanner does not strip the content (tested), and neither the poll (`selectBuyerMessages`) nor `processBuyerMessage` filter by score. `getChatMessages` DOES return it, so our poll *should* have rescued it — but didn't. Root cause not reproducible from code alone → harden the poll defensively + reproduce live.

## Goal

An agent on a flat-rate model gets a realistic budget; when a budget genuinely runs out it **delivers the work it has** instead of stalling; and the poll fallback provably re-delivers any stored buyer message it hasn't yet processed, regardless of score.

## Global Constraints

- CJS, no build step for the source; validate `node --check`; tests `node --test test/*.js`.
- **Fail-closed pricing preserved:** an unknown model on a *metered* provider (openai/anthropic/…) still prices conservatively (o3). Only *flat-rate/self-hosted-class* providers get the generous self-hosted fallback. Never grant an unbounded/invented budget.
- Partial delivery must use the EXISTING deliver path (`finalize()` → `deliverJob`) and fire **once** (no repeated deliveries).
- Poll hardening must not reprocess messages (dedup via `markIfNew` stays authoritative) and must not send money or change any refund/accept logic.
- Worker-side only; no dispatcher control-plane changes.

## Components

### Fix 1 — Provider-aware budget pricing (`src/token-budget.js`)

**Current (lines 132–172):** `initialTokenBudget({model, amountVrsc, spendFraction}, env)` → `entry = getModelCost(model) || mostExpensiveModelCost()`; unknown model ⇒ `mostExpensiveModelCost()` (o3) ⇒ `basis: 'priced-conservative:o3'`.

**Change:** when the model is unknown, choose the fallback cost by **provider class**, read from `env.J41_LLM_PROVIDER`:
- New `SELF_HOSTED_CLASS_PROVIDERS` set: `kimi-nvidia`, `ollama`, `vllm`, `localai`, `lmstudio`, `text-generation-webui`, `self-hosted` (extendable; also honor an env override `J41_SELF_HOSTED_PROVIDERS` = comma list).
- New helper `unknownModelCost(env)`: if `normalizeProvider(env.J41_LLM_PROVIDER)` ∈ the self-hosted set → return the `self-hosted-70b` table entry; else → `mostExpensiveModelCost()` (unchanged conservative behavior).
- `initialTokenBudget`: `const entry = getModelCost(model) || unknownModelCost(env);`. `knownModel` stays `!!getModelCost(model)`; add a third basis tag so ops can see it: `basis: knownModel ? 'priced:'+entry.model : (selfHosted ? 'priced-selfhosted:'+entry.model : 'priced-conservative:'+entry.model)`.
- `self-hosted-70b` is in `LLM_COSTS` (in 0.0005 / out 0.0005) → for a 0.5 VRSC job this yields a budget ~20× the o3 result — enough for a real code review.

Pure and unit-testable via the injected `env`.

### Fix 2 — Deliver partial work on budget exhaustion (`local-llm.js` + `base.js` + `job-agent.js`)

**Current (`local-llm.js` ~218–223):** on `isBudgetExhausted()`, sets `response = budgetExhaustedMessage()`, pushes it to `conversationLog`, returns — every message.

**Change:** the executor signals exhaustion once; the worker delivers accumulated work and ends the session:
- `base.js`: add a one-shot flag `_budgetDelivered` and a method `shouldDeliverOnBudget()` → true the first time `isBudgetExhausted()` is seen and not yet delivered. Keep `budgetExhaustedMessage()` but do NOT append it to `conversationLog` repeatedly.
- `local-llm.js handleMessage`: when exhausted and not yet delivered — return a single honest status string (`"Token budget reached — delivering the work completed so far."`) WITHOUT pushing a canned line onto `conversationLog`, and set a flag the worker reads.
- `job-agent.js`: after a handled message, if the executor reports budget-exhausted-and-should-deliver, run the normal completion path once: `finalize()` (serializes the real accumulated `conversationLog` — the actual work, not the canned line) → `deliverJob(...)` → end session (`resolveSession('budget-exhausted')`). Guard so it happens exactly once.
- Net: the buyer receives the partial work as a real delivery instead of an infinite "budget reached" loop, and the job moves to `delivered` (buyer can accept/dispute) instead of stalling to TTL.

*(If the backend later ships a budget-approval path, a follow-up can insert an approval wait before delivering; out of scope here — no approval endpoint exists today.)*

### Fix 3 — Poll re-delivers stored messages (overlap window + debug) (`job-agent.js` poll + `message-poll.js`)

**Current poll (`job-agent.js` ~813–826):** `since = _lastPolledIso`; after each fetch, advances `_lastPolledIso` to the max `createdAt` of ALL returned messages. Risk: a buyer message that becomes visible in `getChatMessages` slightly late (e.g. withheld from WS, stored a beat later) can fall *before* an already-advanced cursor and never be fetched.

**Change (defensive, dedup-guarded):**
- Poll with a small **overlap window**: query `since = (cursorTime − OVERLAP_MS)` (OVERLAP_MS ≈ 60_000), so each poll re-examines the last minute. `markIfNew` already makes reprocessing a no-op, so overlap is safe and guarantees a late-appearing message is seen.
- Advance the cursor only to the max `createdAt` **actually observed**, but keep the overlap on the next query (store the raw high-water mark separately from the query `since`).
- Add debug logging (gated by `J41_DEBUG_POLL=1`, default off): per poll, log fetched count + for each buyer message its `id`, `createdAt`, `safetyScore`, and whether `markIfNew` treated it as new or dup. This is what the live repro reads to confirm the flagged message is fetched and delivered.
- `selectBuyerMessages` stays score-agnostic (correct); no change beyond confirming it.
- **Live repro plan:** rebuild image, hire, send a `0.4`-scoring code-review message, watch the debug log show the poll fetching it and `processBuyerMessage` delivering it to the executor. That confirms the fix and pins whether any residual drop is purely platform-side.

## Data Flow

1. Job accepted → `initialTokenBudget` now sees `provider=kimi-nvidia`, model unknown → self-hosted-70b basis → realistic budget → agent completes normal jobs without exhausting.
2. If a job DOES exhaust the (now-larger) budget → worker delivers accumulated work once + ends session → job `delivered`.
3. Any stored buyer message (incl. score>0) the WS didn't push → poll's overlap window fetches it within ≤ (poll interval) → `processBuyerMessage` (dedup) → executor → reply.

## Testing

- `token-budget` tests: unknown model + `env.J41_LLM_PROVIDER='kimi-nvidia'` ⇒ basis `priced-selfhosted:self-hosted-70b`, tokens ≫ the o3 result; unknown model + `provider='openai'` ⇒ still `priced-conservative:o3` (fail-closed preserved); known model unchanged; `J41_SELF_HOSTED_PROVIDERS` override respected.
- Partial-delivery tests: a stub executor reporting exhausted-and-should-deliver triggers exactly one `deliverJob` with the accumulated content (not the canned line) and one session end; a second exhausted message does NOT deliver again.
- Poll tests: `selectBuyerMessages` unchanged (score-agnostic); the overlap-window `since` computation re-includes a message whose `createdAt` is just below the high-water mark, and `markIfNew` prevents a double-process.
- `node --check` all changed files; full suite stays green.

## Owner Decisions (confirmed 2026-07-16)
1. **Poll:** defensive hardening + live repro ✅
2. **Pricing:** map flat-rate/self-hosted-class providers' unknown models to `self-hosted-70b` ✅ (provider-aware, keeps fail-closed for metered providers)

## Deferred / not-ours (see `docs/backend-reports/2026-07-16-real-code-review-triage-backend-frontend.md`)
SovGuard false-positive scoring + silent-drop (platform), budget-approval endpoint/UI (platform/frontend), Post-a-Bounty React #31 (frontend), 0-priced service (platform), search param + challenge expiry (frontend/auth).
