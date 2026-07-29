# CLAUDE.md — @junction41/dispatcher

## What This Is

Multi-agent orchestration for the Junction41 sovereign AI agent marketplace. Manages a pool of Verus blockchain-registered AI agents that accept jobs, chat with buyers, deliver work, and get paid in VRSC. Published as `@junction41/dispatcher` on npm.

## Quick Reference

```bash
yarn global add @junction41/dispatcher
j41-dispatcher dashboard          # Interactive TUI (18-item menu)
j41-dispatcher setup agent-1 myname --template code-review
j41-dispatcher start              # Listen for jobs
j41-dispatcher inspect agent-1    # Full agent state dump
j41-dispatcher update-profile agent-1 --display-name "New Name"
j41-dispatcher post-bounty agent-1 --title "Fix API" --amount 5 --description "..."
```

## Architecture

**CJS (no build step)** — all files are plain `.js`. Validate with `node --check src/*.js src/executors/*.js`.

### File Map

| File | Purpose |
|------|---------|
| `src/cli.js` | Commander.js CLI — all commands (`setup`, `register`, `finalize`, `start`, `update-profile`, `post-bounty`, etc.). ~5400 lines. |
| `src/dashboard.js` | Interactive TUI (Inquirer v9, ESM dynamic import). Menu screens, agent management, bounties. ~1900 lines. |
| `src/job-agent.js` | Ephemeral job runtime — runs INSIDE Docker containers. Handles chat, workspace, canary, delivery, attestation. |
| `src/executors/index.js` | Executor factory — `createExecutor()` based on `J41_EXECUTOR` env var. |
| `src/executors/base.js` | Abstract `Executor` class — `init()`, `handleMessage()`, `finalize()`, `cleanup()`, token budget tracking. |
| `src/executors/local-llm.js` | Direct LLM API executor. `LLM_PRESETS` (25 providers), `resolveLLMConfig()`. **Exports must include `resolveLLMConfig`.** |
| `src/executors/webhook.js` | REST POST executor for n8n, CrewAI, Dify, Flowise, etc. |
| `src/executors/langgraph.js` | LangGraph Platform (threads + runs). |
| `src/executors/langserve.js` | LangChain Runnables `/invoke`. |
| `src/executors/a2a.js` | Google Agent-to-Agent (JSON-RPC 2.0). |
| `src/executors/mcp.js` | MCP server + LLM agent loop. Uses `resolveLLMConfig()` from local-llm.js. |
| `src/sovguard-context.js` | **Prompt-injection guard.** `scanUntrusted(text, source)` wraps the vendored `scanContext` from `@junction41/sovagent-sdk` (≥2.6.0). local-llm.js + mcp.js scan job descriptions + tool results through it (source-trust; strips/quarantines injections, never muzzles `user`). See `docs/sovguard-context-integration.md`. |
| `src/token-budget.js` | **Token budget math (WP-D4).** The ONE VRSC↔USD↔tokens conversion point: model-id normalization to the SDK pricing table, rate staleness checks, initial-budget derivation, extension pricing from observed input:output ratio. All paths fail closed (fallback budget, null price) — never unlimited, never invented numbers. job-agent.js enforces via `setBudget`/`isBudgetExhausted`; executors gate every LLM call. |
| `src/config.js` | Runtime detection, config persistence. |
| `src/control.js` | IPC control socket for `j41-dispatcher ctl status/jobs/agents`, plus the open `/health` + `/metrics` HTTP server on `:9842`. Exports the shared **read-model builders** (`buildStatus`/`buildJobs`/`buildJob`/`buildAgents`/`buildEarnings`/`buildHealthDocument`) consumed by both the socket and the control API. |
| `src/control-api.js` | **Headless control API (WP-D1/D2).** Token-gated HTTP surface on `:9843` (`GET /v1/status\|agents\|jobs\|jobs/:id\|earnings\|events`). Bearer token at `~/.j41/dispatcher/control.token` (0600, auto-created). File-backed event ring buffer (`events.jsonl`, monotonic `seq`, survives restart). `state.emitEvent(type, data)` is wired in cli.js at job/container/extension/agent lifecycle points. |
| `src/webhook-server.js` | HTTP webhook receiver for event-driven mode. |
| `src/keygen.js` | Verus keypair generation. |
| `src/sign-attestation.js` | Privacy deletion attestation signing. |
| `src/logger.js` | Structured logging. |

### Configuration

Source of truth: `~/.j41/dispatcher/config.toml` (mode 0600). Loaded once at process start by `loadDispatcherConfig()` in `src/config-loader.js`.

- Provider API keys (`OpenAI`, `Anthropic`, etc.) live under `[provider_keys]`. They are NEVER read from the dispatcher's `process.env`. They are forwarded explicitly to job containers via `docker run -e` per-job.
- Runtime knobs (log level, max concurrent, etc.) accept env-var overrides per `ENV_OVERRIDES` in `config-loader.js` for ops convenience (CI, one-shot ops). The TOML file remains the source of truth.
- Legacy `.env` files at the install dir are auto-migrated to `config.toml` on first load and marked with a `# MIGRATED` banner.

To edit: `j41-dispatcher dashboard` → "[3] Configure Agent Executor" / "[4] Configure Global LLM Default", or hand-edit `~/.j41/dispatcher/config.toml`.

### Executor Types

| Type | Env Var | Description |
|------|---------|-------------|
| `local-llm` | `J41_EXECUTOR=local-llm` (default) | Any OpenAI-compatible LLM — 25 provider presets |
| `webhook` | `J41_EXECUTOR=webhook` | REST POST to n8n, CrewAI, Dify, Flowise, Zapier, custom |
| `langserve` | `J41_EXECUTOR=langserve` | LangChain Runnables via `/invoke` |
| `langgraph` | `J41_EXECUTOR=langgraph` | LangGraph Platform (stateful threads + runs) |
| `a2a` | `J41_EXECUTOR=a2a` | Google Agent-to-Agent (JSON-RPC 2.0) |
| `mcp` | `J41_EXECUTOR=mcp` | MCP server + LLM tool-calling loop |

Framework aliases route to `webhook`: `crewai`, `autogen`, `dify`, `flowise`, `haystack`, `n8n`.

### Per-Agent Config

Each agent can override the global executor via `~/.j41/dispatcher/agents/<id>/agent-config.json`:

```json
{
  "executor": "webhook",
  "executorUrl": "https://my-n8n.com/webhook/xxx",
  "llmProvider": "groq",
  "llmApiKey": "gsk_..."
}
```

Read by `getExecutorEnvVars()` in cli.js, passed as Docker container env vars.

### LLM Provider Presets (25)

Defined in `src/executors/local-llm.js` → `LLM_PRESETS`. Each preset has `baseUrl`, `model`, `envKey`, optional `headers` function.

**Claude presets route through OpenRouter** — Anthropic's native API uses `/messages`, not `/chat/completions`. All executors call `${baseUrl}/chat/completions`.

### Canary Token System

- `job-agent.js`: reads `J41_CANARY_TOKEN` env var, injects into SOUL.md prompt as HTML comment
- Uses SDK's `checkForCanaryLeak()` (evasion-resistant: strips zero-width Unicode, NFKC normalize)
- Blocks outbound messages containing canary, strips from delivery content
- Registers with SovGuard via `client.registerCanary()`

### VDXF Update (On-Chain Profile Editing)

Two-transaction process required by Verus daemon:
1. Remove old values via `contentmultimapremove` (action 3)
2. **Wait for block confirmation** (must be in earlier block)
3. Write new values

SDK function: `removeAndRewriteVdxfFields()`. CLI: `j41-dispatcher update-profile <agent-id> --field value`.

**Critical**: `buildIdentityUpdateTx()` filters out `MULTIMAPREMOVE_KEY` from existing CMM to prevent stale removal entries persisting on-chain.

### Dashboard Menu Structure

18 numbered items plus an unlabelled "⚡ Live Jobs" entry and a Quit option (verified against `src/dashboard.js` `choices` array):

```
[1]  View Agents                 [10] Status & Health
[2]  Add New Agent               [11] Inspect Agent (on-chain)
[3]  Configure Agent Executor    [12] Check Inbox
[4]  Configure Global LLM Default[13] Earnings Summary
[5]  Configure Services          [14] Docker Containers
[6]  Security Setup              [15] Activate All Agents
  ── Dispatcher ──               [16] Deactivate All Agents
⚡    Live Jobs (auto-refresh)    [17] Bounties
[7]  Start Dispatcher            [18] API Endpoint Setup
[8]  Stop Dispatcher                  (sell GPU/compute)
[9]  View Logs
```

### Key Patterns

- **Inbox accepts are BATCHED** — one identity transaction per agent per poll cycle (`processInboxForAgent` in `src/cli.js`). Never write two identity txs for the same VerusID back-to-back: the platform serves the last *confirmed* `prevOutput`, so the second double-spends. Recovery/classification helpers live in `src/inbox-deadletter.js`. See `docs/superpowers/plans/2026-07-29-batched-identity-update.md`.

- **SDK imports**: Always `require('@junction41/sovagent-sdk/dist/...')` inside action handlers (lazy, not top-level)
- **Dashboard prompts**: Always `promptWithEsc(inquirer, [...])` — supports ESC-to-go-back
- **Long-running commands**: Use `runCommandAsync()` (async spawn, no timeout, Ctrl+C returns to menu)
- **Agent filtering**: When using agents for API calls, filter with `.filter(a => a.identity && a.iAddress && a.wif)` — unregistered agents cause "Identity name required" errors
- **Categories**: Fetched from platform API via `fetchCategories()` → `pickCategory()`. Session-cached.
- **File permissions**: `agent-config.json` written with `mode: 0o600` (contains API keys)

### API Response Shapes (gotchas)

- `client.getIdentityRaw()` returns `{ data: { identity, prevOutput, blockHeight, txid } }` — unwrap `.data`
- `client.getUtxos()` returns `{ utxos: [...], address, iAddress }` — unwrap `.utxos`
- `client.getAgentServices()` returns `{ data: [...] }` — unwrap `.data`
- `client.getMyBounties()` returns `{ data: [...] }` — unwrap `.data`

### Testing

```bash
node --check src/*.js src/executors/*.js    # Syntax check (no build step)
j41-dispatcher inspect agent-1              # Live API integration test
j41-dispatcher update-profile agent-1 --display-name "Test" --dry-run  # Preview without broadcast
```

### Data Directories

```
~/.j41/dispatcher/
  agents/<id>/keys.json           # WIF, identity, iAddress (0600)
  agents/<id>/SOUL.md             # Agent personality
  agents/<id>/agent-config.json   # Per-agent executor config (0600)
  agents/<id>/finalize-state.json # Onboarding progress
  config.json                     # Runtime config
  dispatcher.pid                  # PID file
  financial-allowlist.json        # Deny-all default
  network-allowlist.json          # DNS/IP allowlist
  queue/                          # Job queue
  jobs/                           # Job artifacts
```
