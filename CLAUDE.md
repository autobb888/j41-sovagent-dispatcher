# CLAUDE.md — @junction41/dispatcher

## What This Is

Multi-agent orchestration for the Junction41 sovereign AI agent marketplace. Manages a pool of Verus blockchain-registered AI agents that accept jobs, chat with buyers, deliver work, and get paid in VRSC. Published as `@junction41/dispatcher` on npm.

## Quick Reference

```bash
yarn global add @junction41/dispatcher
j41-dispatcher dashboard          # Interactive TUI (21-item menu)
j41-dispatcher build-image        # Build the job-agent image (required once before `start`)
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
| `src/cli.js` | Commander.js CLI — all commands (`setup`, `register`, `finalize`, `start`, `update-profile`, `post-bounty`, `wallet`, etc.). ~9700 lines. |
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
| `src/fee-tank.js` | **Fee-tank sweep.** Job payments land at the agent's **i-address**; identity-update fees are payable only from its **R-address**, so the R-address only ever drains and the agent silently stops being able to write on-chain. `planFeeSweep()` (pure) decides when to sweep; `executeFeeSweep()` broadcasts i→R. **Self-funding by construction** — it pays its own fee out of the swept inputs, so it works at a zero R-balance, which is exactly when it's needed. Refuses R-address inputs. Wired as `checkFeeTanks()` in cli.js on its own 30-min timer. |
| `src/wallet.js` | **Fleet wallet decisions.** Operator-side counterpart of `fee-tank.js`, behind the `wallet` CLI command. `parseVrscAmount` (decimal-string → satoshis with BigInt — **never** `parseFloat(x) * 1e8`), `formatVrsc`, `buildWalletRow`/`summarizeFleet` (fleet table), `planManualSweep` (no floor gate — the operator asked; keeps the pending + dust gates), `planFleetSend` (reserve floor, self-send, pending), `executeSend` (R→R; refuses every input that is not the source R-address, address-less included — the mirror of `executeFeeSweep`'s refusal of R-inputs). Pure, no fs/network/SDK/clock; nothing throws. |
| `src/config.js` | Runtime detection, config persistence. |
| `src/deposit-watcher.js` | **Deposits + the 0-conf reconciler.** Buyer-signed deposit reports, on-chain verification, the credit/reversal/restore state machine, and the `listDepositAnomalies` read model. Credits under 2 VRSC land from the mempool, so this file also claws them back when a funding tx never confirms — behind a caught-up-node gate and a block-denominated grace. |
| `src/credit-meter.js` | Per-buyer prepaid VRSC balances for api-endpoint access. All mutations run under a synchronous cross-process lock; deposit-side writers fail closed, the proxy settle path fails open. |
| `src/file-lock.js` | Shared inter-process lock discipline (liveness-not-age staleness, gated steal, atomic `link()` publication, token-verified release). Consumed by deposits and the credit meter. Deliberately NOT wired into `acquireSendLock`. |
| `src/control.js` | IPC control socket for `j41-dispatcher ctl status/jobs/agents`, plus the open `/health` + `/metrics` HTTP server on `:9842`. Exports the shared **read-model builders** (`buildStatus`/`buildJobs`/`buildJob`/`buildAgents`/`buildEarnings`/`buildHealthDocument`) consumed by both the socket and the control API. |
| `src/control-api.js` | **Headless control API (WP-D1/D2).** Token-gated HTTP surface on `:9843` (`GET /v1/status\|agents\|jobs\|jobs/:id\|earnings\|events`). Bearer token at `~/.j41/dispatcher/control.token` (0600, auto-created). File-backed event ring buffer (`events.jsonl`, monotonic `seq`, survives restart). `state.emitEvent(type, data)` is wired in cli.js at job/container/extension/agent lifecycle points. |
| `src/webhook-server.js` | HTTP webhook receiver for event-driven mode. |
| `src/keygen.js` | Verus keypair generation. |
| `src/sign-attestation.js` | Privacy deletion attestation signing. |
| `src/logger.js` | Structured logging. |

### Fee Tank (agents paying their own gas)

Two addresses that never meet unless something moves funds between them:

- **Payments credit the i-address** — paying the VerusID `name.agentplatform@` resolves there.
- **Fees debit the R-address only** — `buildIdentityUpdateTx` filters inputs to `u.address === agentAddress`, correctly: an identity output's script can't be signed by that path.

So the R-address is a strictly-draining tank at 0.0001/write. When it empties the agent goes silent on-chain — no reviews, attestations or job records — while holding unswept earnings. The failure surfaces as `No spendable R-address UTXOs for fee`, which `inbox-deadletter.js` classifies as **`transient`** (never counted, never dead-lettered — it is not the item's fault).

The sweep is **on by default**. Disable or tune it:

```bash
j41-dispatcher start --no-fee-sweep              # off
j41-dispatcher start --fee-sweep-floor 250       # sweep below 250 writes (default 100)
j41-dispatcher start --fee-sweep-interval 10     # check every 10 min (default 30)
```

Or in `config.toml` / env (`J41_FEE_SWEEP`, `J41_FEE_SWEEP_FLOOR`, `J41_FEE_SWEEP_INTERVAL_MS`):

```toml
[fee_sweep]
enabled = true
floor_writes = 100
interval_ms = 1800000
```

Precedence is CLI flag > config/env > default. An agent that has **never earned** cannot self-fund — it logs `FEE TANK EMPTY and nothing to sweep — fund <R-addr> externally` and needs an operator transfer.

#### `wallet` — the operator's surface on the same problem

```bash
j41-dispatcher wallet                      # = wallet list — fleet table (READ-ONLY, the default is the safe verb)
j41-dispatcher wallet show agent-6         # addresses, per-UTXO breakdown, pending stamp
j41-dispatcher wallet sweep agent-6        # manual i→R sweep (works at a zero tank — fee comes out of the swept inputs)
j41-dispatcher wallet sweep --all          # every registered agent; per-agent failures do not stop the loop
j41-dispatcher wallet send agent-2 agent-11 1.0   # R→R between FLEET AGENTS
```

Rules that are enforced in code, not just documented:

- **`send` destinations are fleet agent-ids, never raw addresses.** The id resolves to that agent's own R-address from its `keys.json`; a typed address is refused. External payouts have their own hardened path (`refunds` + `financial-allowlist.json`). Agent-ids match **exactly** — no prefix resolution, unlike `refunds`' job-ids.
- **Mainnet** (`IS_MAINNET`, sticky): `send` refuses `--yes` and requires the operator to **retype the exact amount**; `sweep` keeps plain y/N because a sweep's destination is derived from the agent's own keys, so funds cannot leave the agent.
- **Reserve floor:** a `send` leaving the source below `fee_sweep.floor_writes` (default 100 writes) is refused without `--allow-drain` — refilling one tank by draining another just moves the outage.
- **Pending stamp** at `~/.j41/dispatcher/agents/<id>/wallet-pending.json` (0600, `{txid, at, kind}`) is written after every broadcast and consulted before the next; younger than 30 min blocks unless `--force`. A malformed stamp **fails closed**. Same hazard as the inbox pending-write gate: the platform serves the *confirmed* UTXO view.
- **`--dry-run`** builds and signs (so signing errors surface) but never broadcasts, and says so: a successful build proves nothing about acceptance.
- Balances for an agent that could not be queried render as `—`, **never `0`** — "we never looked" and "we looked and it is empty" prescribe opposite actions.

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

**⚠️ contentmultimap keys must be hash160-sorted** or the daemon rejects with a bare `-25 bad-txns-failed-precheck`. Fixed in **SDK 2.13.1** — requires that version or later. Our payloads were never canonical, but the daemon only began enforcing between 2026-07-31 and 08-04; in that window no identity could gain a new VDXF key. If an on-chain write "silently never landed", suspect this, and note `TX_REJECTED` classifies as `contention` in `inbox-deadletter.js`, which never escalates — so it retries forever, invisibly.

**Single transaction.** `buildIdentityUpdateTx()` copies the identity's entire existing contentmultimap forward and replaces only the keys it is given, so a profile edit is one write and every other key — including `review.record` — survives untouched. Prior values stay retrievable via `getidentityhistory`.

SDK function: `removeAndRewriteVdxfFields()` (name kept for compatibility; no longer removes anything). CLI: `j41-dispatcher update-profile <agent-id> --field value`.

**Do NOT reintroduce the old two-transaction remove+rewrite.** It is unnecessary — a single write replaces a key's value, and per wiki.autobb.app `contentmultimapremove` operations process *before* additions **in the same transaction**, so even a genuine removal never needed two blocks.

Why it "stopped working" on 2026-08-04: the action-3 payload writes `MULTIMAPREMOVE_KEY`, a **new key** on those identities, so it tripped the hash160-ordering bug above once the daemon began enforcing. Both halves are real — our payload was never canonical, and enforcement changed. **A SORTED action-3 remove may well be accepted now; that has not been retested.** Verified fixed live: agent-3 `b7d49d25`, agent-7 `9e890c6d` (profile + review in ONE tx), agent-4 `4294bfc8` via the CLI, and all 9 agents gaining a `disputePolicy` key after the ordering fix.

**Not gated.** `update-profile` does NOT route through the inbox pending-write confirmation gate. Running it while an inbox identity tx for the same agent is unconfirmed can double-spend the same `prevOutput`. Check `ctl inbox` / `/health` `pendingWrites` is empty first.

**Critical**: `buildIdentityUpdateTx()` filters out `MULTIMAPREMOVE_KEY` from existing CMM to prevent stale removal entries persisting on-chain.

### Dashboard Menu Structure

21 numbered items plus an unlabelled "⚡ Live Jobs" entry and a Quit option (verified against `src/dashboard.js` `choices` array 2026-08-14):

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
[8]  Stop Dispatcher                  (resell your LLM, metered)
[9]  View Logs                     ── Money ──
                                  [19] Wallet & Fee Tanks
                                  [20] Refunds Queue
                                  [21] Deposits
```

[20] and [21] show a count when something is waiting on a human, and those
counts also print above the menu — refunds are held until approved and deposit
anomalies until settled, so both sit silently owed otherwise.

**The job image is a hard prerequisite.** `start` refuses without it rather than
failing after a buyer has paid. Build with `j41-dispatcher build-image`, which
resolves the bundled script from the module's own location — never tell a
globally-installed user to run `./scripts/build-image.sh`, they have no such
path.

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
  agents/<id>/deposits.json       # Deposit ledger: processed, pending, reversed, creditedTxids
  agents/<id>/deposits.lock       # Per-agent deposit lock (see file-lock.js)
  agents/<id>/credit-meters.json  # Per-buyer prepaid balances (0600)
  config.json                     # Runtime config
  dispatcher.pid                  # PID file
  financial-allowlist.json        # Deny-all default
  network-allowlist.json          # DNS/IP allowlist
  queue/                          # Job queue
  jobs/                           # Job artifacts
```
