# Task 6 Report — Preflight LLM Health Gate

## Status: DONE

## Files changed

- `src/preflight-gate.js` — new module: `resolveAgentLLMConfig`, `shouldAcceptGivenHealth`, `preflightAllowsAccept`
- `src/cli.js` — require added at top, `llmHealth: new Map()` in state, gates at all 3 accept sites, `preflightAllowsAccept` added to NODE_ENV=test exports
- `test/preflight-gate.test.js` — 7 unit tests

## Accept sites: gated vs skipped

### Gated (all three)

**Site 1 — poll-mode primary accept (~5366 post-edit)**
`job.status === 'requested' && !pending?.accepted` block. Pre-payment: the buyer has NOT yet paid; signing `acceptJob` here is the commitment that triggers the payment request. Gate fires before `client.acceptJob`. On failure, `continue` skips to the next job, leaving it in `requested` state for another agent or timeout.

**Site 2 — webhook `job.requested` handler (~5680 post-edit)**
Triggered by a platform webhook event when a buyer posts a job. Semantically identical to Site 1 — pre-payment accept in webhook mode. `agentInfo` is available from the `handleWebhookEvent` function parameter. Gate fires before `client.acceptJob`. On failure, `return` exits the event handler, leaving the job in `requested` state.

**Site 3 — webhook `bounty.awarded` handler (~5957 post-edit)**
Triggered when a bounty is awarded to this agent. Although bounty funds are in escrow, this `acceptJob` call commits our agent to the work and moves the job forward. If our LLM is down we cannot deliver, and the buyer would need to open a dispute to recover funds. Gating here prevents that scenario. On failure, `return` exits the event handler.

### Skipped sites

None — all three `client.acceptJob` call sites are pre-payment or pre-commitment accepts. There is no site that re-accepts an already-in-progress/paid job.

## Config flag

`preflight_llm_check` read as `cfg.preflight?.llm_check === false` (default **on** when unset). No change to `config-loader.js` DEFAULTS required — the `?.` guard handles the missing key cleanly.

## Implementation notes

- `resolveAgentLLMConfig` mirrors `buildContainerEnv` resolution order exactly: `agentCfg.llmApiKey` → `cfg.provider_keys[provider]` → `cfg.llm.api_key`; `agentCfg.llmModel` → `cfg.llm.model` → `preset.model`; `agentCfg.llmBaseUrl` → `cfg.llm.base_url` → `preset.baseUrl`.
- Returns `null` for any executor that is not `local-llm` (webhook, mcp, a2a, langgraph, langserve, framework aliases).
- `preflightAllowsAccept` only caches `ok:true` results (30 s TTL). A down result is never cached as pass — the next accept always re-probes.
- `state.llmHealth` is lazily initialised inside `preflightAllowsAccept` if missing; also added to the state constructor in cli.js for clarity.
- `local-llm.js` is required lazily inside `resolveAgentLLMConfig` (matching the pattern in `buildContainerEnv`) to avoid triggering its module-level side effects on every require.

## node --check

`node --check src/cli.js` → OK

## Test summary

**New (`test/preflight-gate.test.js`):** 7 pass, 0 fail
**Full suite (`node --test test/*.js`):** 470 pass, 0 fail (baseline was 463)

## Concerns

None.
