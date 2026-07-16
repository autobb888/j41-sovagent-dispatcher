# Worker Budget / Partial-Delivery / Poll-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Flat-rate models get a realistic token budget; a genuinely-exhausted budget delivers the accumulated work instead of stalling; the poll fallback provably re-delivers stored buyer messages regardless of score.

**Architecture:** All changes run INSIDE the job container. Pure budget math in `src/token-budget.js`; executor/worker behavior in `src/executors/base.js`, `src/executors/local-llm.js`, `src/job-agent.js`; poll in `src/message-poll.js`. Reference spec: `docs/superpowers/specs/2026-07-16-worker-budget-delivery-poll-design.md`.

**Tech:** Node CJS, `node --test`. **Live testing needs an image rebuild** (no new files, so no Dockerfile/build-image.sh edits — just rebuild).

## Global Constraints

- Fail-closed pricing preserved: unknown model on a METERED provider (openai/anthropic/…) still prices conservatively (o3). Only self-hosted-class providers get the self-hosted-70b fallback.
- Partial delivery uses the EXISTING `finalize()`→`deliverJob` path and fires EXACTLY ONCE per job.
- Poll must not reprocess (dedup via `markIfNew` stays authoritative) and must not touch refund/accept/money logic.
- `node --check` every changed file; keep the full suite green (currently 489 pass).

---

### Task 1: Provider-aware budget pricing (`src/token-budget.js`)

**Files:** Modify `src/token-budget.js`; Test `test/token-budget-provider.test.js` (new).

**Interfaces:**
- Produces: `unknownModelCost(env) → costEntry`, `SELF_HOSTED_CLASS_PROVIDERS` (Set), `isSelfHostedProvider(providerRaw, env) → bool`.
- Both budget derivations (the `getModelCost(model) || mostExpensiveModelCost()` at ~line 161 AND ~line 198) use `unknownModelCost(env)` instead of `mostExpensiveModelCost()`.

**Read first:** lines 58–172 and 190–210 of `src/token-budget.js` (both fallback sites, `mostExpensiveModelCost`, `initialTokenBudget`, and the second function that also falls back at ~198).

- [ ] **Step 1: Write failing tests** (`test/token-budget-provider.test.js`)

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const tb = require('../src/token-budget.js');

// isSelfHostedProvider
test('kimi-nvidia is self-hosted class', () => {
  assert.equal(tb.isSelfHostedProvider('kimi-nvidia', {}), true);
});
test('openai is NOT self-hosted class', () => {
  assert.equal(tb.isSelfHostedProvider('openai', {}), false);
});
test('J41_SELF_HOSTED_PROVIDERS env override adds a provider', () => {
  assert.equal(tb.isSelfHostedProvider('mycloud', { J41_SELF_HOSTED_PROVIDERS: 'mycloud,foo' }), true);
});

// unknownModelCost picks self-hosted-70b for a self-hosted provider, o3 otherwise
test('unknownModelCost → self-hosted-70b for kimi-nvidia', () => {
  const c = tb.unknownModelCost({ J41_LLM_PROVIDER: 'kimi-nvidia' });
  assert.equal(c.model, 'self-hosted-70b');
});
test('unknownModelCost → most-expensive (o3) for openai', () => {
  const c = tb.unknownModelCost({ J41_LLM_PROVIDER: 'openai' });
  assert.equal(c.model, 'o3');
});

// initialTokenBudget: unknown model + self-hosted provider ≫ conservative
test('unknown model on kimi-nvidia yields a much larger budget than on openai', () => {
  const args = { model: 'openai/gpt-oss-120b', amountVrsc: 0.5, spendFraction: 0.5 };
  const selfHosted = tb.initialTokenBudget(args, { J41_LLM_PROVIDER: 'kimi-nvidia' });
  const metered   = tb.initialTokenBudget(args, { J41_LLM_PROVIDER: 'openai' });
  assert.match(selfHosted.basis, /priced-selfhosted:self-hosted-70b/);
  assert.match(metered.basis, /priced-conservative:o3/);
  assert.ok(selfHosted.tokens > metered.tokens * 5, `expected ≫ budget: ${selfHosted.tokens} vs ${metered.tokens}`);
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test test/token-budget-provider.test.js`).
- [ ] **Step 3: Implement** in `src/token-budget.js`:
  - Add near the top-level helpers:
    ```js
    const SELF_HOSTED_CLASS_PROVIDERS = new Set([
      'kimi-nvidia', 'ollama', 'vllm', 'localai', 'lmstudio', 'text-generation-webui', 'self-hosted',
    ]);
    function isSelfHostedProvider(providerRaw, env = process.env) {
      const p = String(providerRaw || '').trim().toLowerCase();
      if (!p) return false;
      if (SELF_HOSTED_CLASS_PROVIDERS.has(p)) return true;
      const extra = String(env.J41_SELF_HOSTED_PROVIDERS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      return extra.includes(p);
    }
    function unknownModelCost(env = process.env) {
      if (isSelfHostedProvider(env.J41_LLM_PROVIDER, env)) {
        const table = loadCostTable();
        const sh = table.find(m => m.model === 'self-hosted-70b');
        if (sh) return sh;
      }
      return mostExpensiveModelCost();
    }
    ```
  - At BOTH fallback sites (~161 and ~198), replace `getModelCost(model) || mostExpensiveModelCost()` with `getModelCost(model) || unknownModelCost(env)`.
  - Update the `basis` tag so the self-hosted path is visible: compute `const selfHosted = !knownModel && isSelfHostedProvider(env.J41_LLM_PROVIDER, env);` and set `basis: knownModel ? \`priced:${entry.model}\` : (selfHosted ? \`priced-selfhosted:${entry.model}\` : \`priced-conservative:${entry.model}\`)`. Apply at both derivation sites.
  - Export `unknownModelCost`, `isSelfHostedProvider`, `SELF_HOSTED_CLASS_PROVIDERS` in module.exports.
- [ ] **Step 4: Run — expect PASS**; `node --check src/token-budget.js`; full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(budget): provider-aware unknown-model pricing (self-hosted class → self-hosted-70b)"`

---

### Task 2: Deliver partial work on budget exhaustion (`base.js` + `local-llm.js` + `job-agent.js`)

**Files:** Modify `src/executors/base.js`, `src/executors/local-llm.js`, `src/job-agent.js`; Test `test/budget-partial-delivery.test.js` (new).

**Read first:** `base.js` lines 30–85 (the `_exhaustedAt`/`isBudgetExhausted`/`budgetExhaustedMessage` block), `local-llm.js` lines 210–230 and 265–335 (the three `isBudgetExhausted` gates), and `job-agent.js` around the message-handling loop + `finalize()`/`deliverJob` (~line 520) + `resolveSession` (~967–982).

**Interfaces:**
- `base.js` produces: `shouldDeliverOnBudget() → bool` (true once, the first time exhausted & not yet delivered), `markBudgetDelivered()`, internal `_budgetDelivered` flag.
- The worker calls `shouldDeliverOnBudget()` after handling a message; if true → deliver accumulated work once + end session.

- [ ] **Step 1: Write failing tests** (`test/budget-partial-delivery.test.js`) using a stub executor:
  - `shouldDeliverOnBudget()` returns true the first time when exhausted, false thereafter (after `markBudgetDelivered`).
  - Simulate the worker's post-message hook: when the executor is exhausted-and-should-deliver, `deliverJob` is called EXACTLY ONCE with the accumulated `conversationLog` content (NOT the canned "budget reached" string), and the session-end path runs once. A second exhausted message does NOT deliver again.
  - `finalize()` content excludes any repeated canned budget line (i.e. the canned line is not appended to `conversationLog` on exhaustion).

  *(Test the extracted helpers + a small worker-side `handleBudgetDelivery(executor, deps)` function you extract from job-agent.js, with `deps = { deliver, endSession }` stubs — do NOT try to boot the whole container.)*

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement:**
  - `base.js`: add `_budgetDelivered=false`; `shouldDeliverOnBudget()` → `this.isBudgetExhausted() && !this._budgetDelivered`; `markBudgetDelivered()` → sets it. Keep `budgetExhaustedMessage()` for the single status line.
  - `local-llm.js`: at the exhaustion gates (218, 273, 327), do NOT push the canned message onto `conversationLog`. Return the single status string for the immediate reply, but leave `conversationLog` = the real accumulated work.
  - `job-agent.js`: extract `handleBudgetDelivery(executor, { deliver, endSession })` — if `executor.shouldDeliverOnBudget()`: `executor.markBudgetDelivered()`, `const out = await executor.finalize()`, `await deliver(out)` (the existing `deliverJob` call, wrapped), `await endSession('budget-exhausted')`. Call it once after each handled message. Export it for tests.
- [ ] **Step 4: Run — expect PASS**; `node --check` the three files; full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(budget): deliver accumulated work on budget exhaustion instead of stalling"`

---

### Task 3: Poll overlap-window + debug logging (`job-agent.js` + `message-poll.js`)

**Files:** Modify `src/job-agent.js` (the `_msgPoll` interval ~813–826); optionally `src/message-poll.js` (confirm score-agnostic); Test `test/poll-overlap.test.js` (new).

**Read first:** `job-agent.js` lines 805–830 (the poll setup + cursor advance), `message-poll.js` full.

**Interfaces:**
- Produces: a pure helper `nextPollSince(highWaterIso, overlapMs) → string` computing the overlap-window `since` from the high-water mark, exported for tests.

- [ ] **Step 1: Write failing tests** (`test/poll-overlap.test.js`):
  - `nextPollSince`: given a high-water `createdAt` in backend space-format, returns a `since` that is `overlapMs` earlier, still in backend space-format (space separator, no `Z`).
  - `selectBuyerMessages` still returns a message regardless of its `safetyScore` (score-agnostic) — a `{safetyScore:0.4}` buyer message is included.
  - Simulate two poll rounds over a message list where a buyer message's `createdAt` is just below the high-water mark: with the overlap window it is re-included in the fetch set, and a `markIfNew`-style dedup (pass a Set) makes the second observation a no-op (assert it isn't double-counted).

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement:**
  - Add `nextPollSince(highWaterIso, overlapMs)` (pure): parse the space-format timestamp to ms, subtract `overlapMs`, re-emit space-format (`toISOString().replace('T',' ').replace('Z','')`). Guard against unparseable input (return the input unchanged).
  - In the poll: track a separate `_pollHighWater` (max observed `createdAt`); each tick query `since = nextPollSince(_pollHighWater, OVERLAP_MS)` with `OVERLAP_MS = 60000`. Keep advancing `_pollHighWater` to the max observed `createdAt`. `markIfNew` in `processBuyerMessage` still guarantees single processing.
  - Add debug logging gated by `env.J41_DEBUG_POLL === '1'` (default off): per tick, log fetched count and for each buyer message `id`/`createdAt`/`safetyScore`/new-or-dup.
  - `message-poll.js`: no functional change; add a one-line comment that filtering is intentionally score-agnostic.
- [ ] **Step 4: Run — expect PASS**; `node --check`; full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(poll): overlap-window re-delivery + debug logging for stored buyer messages"`

---

## Post-build (controller): image rebuild + live repro
After all tasks + review: rebuild the job-agent image (`DOCKER_BUILDKIT=1 J41_USE_LOCAL_SDK=1 J41_SDK_DIR=../j41-sovagent-sdk ./scripts/build-image.sh`), restart the dispatcher, hire, send a real code-review + a `0.4`-scoring message, and confirm: (a) budget no longer starves, (b) exhaustion delivers partial, (c) `J41_DEBUG_POLL=1` shows the poll fetching+delivering the flagged message.

## Self-Review (author)
- Coverage: Fix 1 = Task 1; Fix 2 = Task 2; Fix 3 = Task 3. ✓
- Fail-closed preserved (Task 1 keeps o3 for metered providers). ✓
- Deliver-once guard (Task 2 `_budgetDelivered`). ✓
- Dedup authoritative (Task 3 relies on `markIfNew`; overlap is safe). ✓
- All targets are existing packaged files → rebuild only, no packaging edits. ✓
