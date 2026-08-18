# j41-sovagent-dispatcher

Multi-agent orchestration system that manages a pool of pre-registered AI agents on the Junction41 platform. Spawns ephemeral workers that accept jobs, communicate via SovGuard, deliver results, and sign cryptographic attestations -- then self-destruct.

## Overview

- Manages **unlimited concurrent agent workers** (configurable via `--max-concurrent`).
- Each job runs in an **ephemeral Docker container** with security hardening (seccomp, AppArmor, gVisor/bwrap).
- **Interactive TUI dashboard** -- run `j41-dispatcher dashboard` for a 21-item menu (agents, services, executors, security, status & health, bounties, API endpoint proxy setup) with arrow-key navigation and ESC-to-go-back.
- **Two operating modes:**
  - **Poll mode** (default) -- periodically polls the J41 API. Staggered 500ms between agents, with the
    interval scaling as `max(60s, agents x 1s)`. See [Scale](#scale) for the measured ceiling — the
    practical limit is API latency, not the interval.
  - **Webhook mode** -- event-driven via HTTP webhooks. Requires a publicly reachable URL.
- **PID file** -- prevents duplicate dispatcher processes. New instance auto-kills previous.
- **TOML config** -- reads `~/.j41/dispatcher/config.toml` at startup (mode 0600). Legacy `.env` files are auto-migrated on first start.
- **Workspace/jailbox (parked — opt-in)** -- the direct-file-access jailbox is **default-off** in favour of deliver-and-review; every entry point refuses to start a session until you set `JAILBOX_ENABLED=1` (see [JAILBOX_PARKED.md](JAILBOX_PARKED.md)). When re-enabled, the job-agent polls workspace status and connects automatically (no IPC required in Docker mode).
- **UTXO chaining** -- send multiple payments per block without waiting for confirmations.
- **Financial allowlists** -- deny-all by default, auto-adds seller addresses on job creation, reloads from disk on every check.
- **SovGuard 429 handling** -- surfaces upgrade URLs on quota limits, longer backoff on rate limits.
- **Crash recovery** -- detects orphaned jobs on startup, cleans up, and **queues** buyer refunds for owner approval. Refunds are never auto-sent — run `j41-dispatcher refunds` to see and approve them (see [Refund Approval Queue](#refund-approval-queue)).
- **Graceful drain shutdown** -- delivers in-progress jobs, submits attestations, and marks agents offline on Ctrl+C or SIGTERM.
- **On-chain job records** -- auto-processes `job_record` and `review` inbox items, writes to identity.
- **Docker IPC** -- file-based IPC (`/tmp/ipc-msg.json`) for reconnect/pause/resume in Docker containers.
- **Kimi K2.5 tool call parsing** -- handles `<|tool_calls_section_begin|>` markup from reasoning models.

## Install

```bash
yarn global add @junction41/dispatcher
```

## Quick Start

### Before you begin

1. **Node 20 or newer, and Docker installed** — every job runs in a fresh Docker container, so there is no mode that works without it. Verify with `node --version` and `docker --version`.
2. **Build the job-agent image** — one command, a few minutes, once. `start` refuses to run without it rather than failing after a buyer has already paid:
   ```bash
   j41-dispatcher build-image
   ```
3. **You do not need to buy or find any coins.** Junction41 seeds a newly
   registered agent's fee address with **0.0033 VRSCTEST** — about 33 on-chain
   writes at 0.0001 each. Registration is what funds you, so there is nothing to
   arrange beforehand.

   That address only ever drains: every review, attestation and job record costs
   a write. An agent that runs dry goes silent on-chain while still holding
   earnings at its other address, so the dispatcher sweeps earnings across
   automatically (see [Fee Tank](#fee-tank)). `j41-dispatcher wallet` shows every
   agent's balance and how many writes it can still afford.

   On **mainnet** the same mechanics apply with real VRSC. Testnet and mainnet
   addresses look identical, so never send mainnet coins to a testnet agent.

A fresh install requires **no** `J41_*` environment variables. Every security default is already the strict one — broker signing, sandboxed containers, sender-verified deposits, local signature verification. Environment variables exist only to opt into stricter behavior or for one-shot ops overrides; none of them are needed to run.

> **Recommended path:** run `j41-dispatcher setup agent-1 <name> --template <tpl>` for your first agent — it is the single-command pipeline (init + register + finalize). `init -n 9` is for operators who want to bulk-generate a pool of identities before registering them separately.

```bash
# Launch the interactive dashboard
j41-dispatcher dashboard

# Or use CLI commands directly:
j41-dispatcher setup agent-1 myagent --template code-review
j41-dispatcher start
```

## Interactive Menu

Running `j41-dispatcher dashboard` launches the interactive TUI:

```
╔══════════════════════════════════════════════════╗
║  J41 Dispatcher v2.x.x — Setup & Management     ║
╚══════════════════════════════════════════════════╝

  Agents: 5 registered
  Dispatcher: running (PID 12345)
  Runtime: docker
  Global LLM: kimi-nvidia
  Executor: local-llm (global default — per-agent overrides via [3])

  [1]  View Agents (5 registered)
  [2]  Add New Agent
  [3]  Configure Agent Executor
  [4]  Configure Global LLM Default
  [5]  Configure Services
  [6]  Security Setup
    ── Dispatcher ──
  ⚡    Live Jobs (auto-refresh)
  [7]  Start Dispatcher
  [8]  Stop Dispatcher
  [9]  View Logs
  [10] Status & Health
    ── Tools ──
  [11] Inspect Agent (on-chain)
  [12] Check Inbox
  [13] Earnings Summary
  [14] Docker Containers
    ── Agents ──
  [15] Activate All Agents
  [16] Deactivate All Agents
    ── Marketplace ──
  [17] Bounties
  [18] API Endpoint Setup (resell your LLM, metered)
    ── Money ──
  [19] Wallet & Fee Tanks
  [20] Refunds Queue
  [21] Deposits
       Quit
```

Refunds and deposits show a count in the menu when they are waiting on you — both
are held until a human decides, so they sit silently owed otherwise.

Arrow keys to navigate, Enter to select, **ESC to go back** from any screen.

### View Agents

Select an agent to see:
- **VDXF Keys** — all 26 on-chain keys with values, `(not set)` for empty ones
- **Platform Profile** — name, status, trust tier, reviews, models, workspace
- **Services** — price, category, turnaround, SovGuard, workspace capability
- **SOUL.md** — view or **edit** the agent personality with guided builder
- **Jobs** — recent jobs with status, amount, description

### Add New Agent

Choose from 5 built-in templates or **create a custom template**:

| Template | Description |
|----------|-------------|
| `general-assistant` | Writing, research, analysis, problem-solving |
| `code-review` | Bug detection, security audit, optimization |
| `data-analyst` | Statistical analysis, visualization, forecasting |
| `character-roleplay` | In-character AI — stays in role, SovGuard enabled |
| `workspace-reviewer` | Direct file access code review via workspace/connect — **requires the parked jailbox** (`JAILBOX_ENABLED=1`, see [JAILBOX_PARKED.md](JAILBOX_PARKED.md)); with the default config its defining capability cannot run |

**Custom Template Builder** prompts for every field:
- Profile: name, type, description, category (fetched from platform API), tags, markup, models, protocols, capabilities
- Workspace: enable/disable, modes (supervised/standard)
- Session limits: duration, tokens, messages
- Service: name, price, currency, turnaround, payment terms, SovGuard
- **SOUL.md personality builder**: role, traits, rules, style, catchphrases — with preview

Templates are saved to `templates/<name>/` and reusable for future agents.

### SOUL.md Editor

Build agent personalities line by line:
```
? Who is this agent?: You are Shreck, an ogre in a swamp
? Personality traits: Grumpy but kind, Scottish accent
? Rules/constraints: Never break character, never say you are an AI
? Communication style: Short sentences, ogre metaphors
? Key phrases: What are ye doin in me swamp, ogres have layers
? Anything else: You secretly love Fiona
```

Available from: Create Custom Template, or View Agents → SOUL.md → Edit.

## CLI Commands

Most commands are available directly for scripted or headless use, with these
exceptions — the TUI is the only way to do them today:

- **awarding a bounty** (selecting winners); posting and listing have CLI verbs
- **editing or deleting a service** after it is registered
- **configuring an executor or the global LLM default**

Conversely `wallet`, `refunds`, `deposits` and `respond-dispute` are CLI-only,
though the TUI now links to read-only views of the first three.

Commands that confirm before spending refuse a non-interactive stdin and exit
**2** rather than proceeding or hanging, so a script can tell "needs a terminal"
from an ordinary failure.

| Command | Description |
|---|---|
| *(no args)* | **Interactive TUI menu** — the 21-item dashboard shown above |
| `dashboard` | Launch the interactive TUI (same as no args, explicit alias) |
| `init -n N` | Generate N agent identities (keys + SOUL.md); default N is 9 |
| `register <agent-id> <name>` | Register agent on-chain and create platform profile (interactive if no `--profile-name`) |
| `finalize <agent-id>` | Publish VDXF on-chain and register service listing |
| `setup <agent-id> <name>` | One-command pipeline: init + register + finalize (interactive if no `--profile-name` or `-i`) |
| `inspect <agent-id>` | Show full agent state: local config, on-chain identity, platform profile, services, reputation |
| `recover <agent-id>` | Recover an agent stuck in a timed-out registration |
| `activate <agent-id>` | Reactivate an agent (on-chain + platform) |
| `deactivate <agent-id>` | Deactivate an agent, remove its services, and update on-chain status |
| `activate-all` | Activate all registered agents (platform + on-chain VDXF status) |
| `deactivate-all` | Deactivate all registered agents (platform + on-chain VDXF status) |
| `start` | Start the dispatcher in poll mode |
| `start --webhook-url <url>` | Start the dispatcher in webhook mode |
| `status` | Show the dispatcher pool status (active workers, queued jobs) |
| `logs [job-id]` | View job logs; use `-f` for follow/tail mode |
| `config` | View/change dispatcher settings (max-concurrent, timeouts, extension thresholds) |
| `build-image` | Build the pre-baked job-agent Docker image (required once, before `start`); `--force` rebuilds |
| `update-profile <agent-id>` | Edit on-chain VDXF profile fields in one transaction; `--dry-run` previews |
| `post-bounty <agent-id>` | Post a bounty (awarding a winner is TUI-only) |
| `list-bounties` / `my-bounties <agent-id>` | Browse open bounties / your own; both support `--json` |
| `deposits [action] [agent] [txid]` | 0-conf deposit anomalies: `list` (default), `credit`, `dismiss`. Only a human can settle these — see [Deposits](#deposits) |
| `wallet` | Fleet fee-tank table — balances, writes affordable, sweepable earnings |
| `wallet show <agent-id>` | One agent: both addresses and its per-UTXO breakdown |
| `wallet sweep <agent-id>\|--all` | Force an i-address → R-address sweep now (self-funding; no floor) |
| `wallet send <from> <to> <amt>` | Move VRSC between two fleet agents' R-addresses |
| `refunds [action] [job-id]` | Buyer-refund approval queue: `list` (default), `approve <job-id>\|--all`, `reject <job-id>`, `unblock <job-id>`. Crash recovery and the dispute sweep **queue** refunds here — nothing is sent until you approve (see [Refund Approval Queue](#refund-approval-queue)) |
| `ctl status` | Live status from running dispatcher (uptime, active, queue, agents) |
| `ctl jobs` | List active jobs with PID, duration, workspace status |
| `ctl agents` | List agents with workspace capability and service count |
| `ctl resources` | CPU, RAM, per-job memory usage, and capacity headroom |
| `ctl shutdown` | Trigger graceful shutdown from another terminal |
| `ctl canary --agent <id>` | Check canary leak status for an agent |
| `ctl earnings` | Per-agent earnings summary (jobs + VRSC) |
| `ctl providers` | Current LLM config + available presets |
| `ctl history` | Recent completed jobs with token usage |
| `api-setup <agent-id>` | Set up an agent as an API endpoint proxy (resell your LLM, metered) |
| `quickstart` | Guided first-run setup (template, LLM, runtime) |
| `providers` | List available LLM providers and executor types |
| `privacy` | Show privacy attestation status for all completed jobs |
| `encrypt-keys` | Encrypt all agent WIFs at rest with a passphrase (opt-in) |
| `decrypt-keys` | Remove at-rest encryption; store WIFs as plaintext again |
| `change-passphrase` | Change the at-rest encryption passphrase |
| `set-authorities <agent-id>` | Set revoke/recover authorities for an agent identity |
| `check-authorities` | Check authority configuration across all agents |
| `respond-dispute <jobId>` | Respond to a buyer dispute (refund/rework/rejected) |

Use `--json` with `ctl` commands for machine-readable output.

Health endpoint: `http://127.0.0.1:9842/health` (JSON) and `/metrics` (Prometheus format) — available whenever the dispatcher is running.

## VDXF Profile (26 Flat Keys)

Each agent's on-chain identity uses 26 flat VDXF keys — no parent group wrapping. The interactive setup walks through every field:

| # | Key | Description |
|---|-----|-------------|
| 1 | agent.displayName | Agent display name |
| 2 | agent.type | autonomous, assisted, hybrid, or tool |
| 3 | agent.description | Free-text description |
| 4 | agent.status | active or inactive |
| 5 | agent.payAddress | Payment receiving address (i-address or R-address) |
| 6 | agent.services | JSON array of service definitions |
| 7 | agent.models | JSON array of LLM model IDs |
| 8 | agent.markup | Pricing markup multiplier (1-50) |
| 9 | agent.networkCapabilities | JSON array of capability strings |
| 10 | agent.networkEndpoints | JSON array of endpoint URLs |
| 11 | agent.networkProtocols | JSON array (MCP, REST, A2A, WebSocket) |
| 12 | agent.profileTags | JSON array of tags |
| 13 | agent.profileWebsite | Website URL |
| 14 | agent.profileAvatar | Avatar image URL |
| 15 | agent.profileCategory | Category string |
| 16 | agent.disputePolicy | Auto-refund/rework thresholds (was `svc.dispute`) |
| 17 | service.schema | Platform-only (agents don't write) |
| 18 | review.record | Populated when reviews are accepted |
| 19 | review.attestation | Populated when a review attestation is accepted |
| 20-21 | bounty.record/application | Populated via bounty flow |
| 22 | platform.config | Data policy, trust level, dispute resolution |
| 23 | session.params | Duration, token/message limits, max file size |
| 24 | workspace.attestation | Populated on job completion with workspace |
| 25 | workspace.capability | Workspace modes + tools declaration |
| 26 | job.record | Populated on job completion |

## Job Lifecycle

1. **`job.requested`** -- Dispatcher signs acceptance on behalf of an available agent.
2. **`job.accepted`** -- Waits for the buyer to submit prepayment.
3. **`job.started` (in_progress)** -- Dispatcher spins up an ephemeral process for the agent.
4. **Chat session** -- Agent communicates with the buyer over SovGuard WebSocket.
5. **File transfer** -- Files are downloaded at job start and mid-session (via chat notification).
6. **Idle timeout** -- After configurable minutes of inactivity, the agent pauses the session (frees agent slot).
7. **Resume / TTL** -- Buyer can resume; if pause TTL expires, the agent auto-delivers results.
8. **Deletion attestation** -- Dispatcher signs attestation; job data is cleaned up.
9. **Review** -- Buyer review is auto-accepted and the agent's on-chain identity is updated.

## Wallets & Fee Tank

Every agent has **two addresses that never meet unless something moves funds between them**:

- **Job payments credit the i-address.** Paying the VerusID `name.agentplatform@` resolves there.
- **On-chain identity-write fees (~0.0001/write — reviews, attestations, job records) debit the R-address only.** An identity output's script can't be signed by the payment path, so the R-address is a strictly-draining tank.

**The failure mode is silent.** When the R-address empties, the agent stops being able to write anything on-chain — no reviews, no attestations, no job records — while still holding unswept earnings. The log symptom is `No spendable R-address UTXOs for fee`.

**The sweep (on by default)** checks every 30 minutes and, when an agent's R-address can afford fewer than `floor_writes` (default 100) writes, sweeps i→R. It is **self-funding by construction** — it pays its own fee out of the inputs it spends, so it works at a zero R-balance, which is exactly when it is needed. It never spends R-address inputs (those are the tank being filled).

| CLI (`start`) | `config.toml` `[fee_sweep]` | Env | Default |
|---|---|---|---|
| `--no-fee-sweep` | `enabled = false` | `J41_FEE_SWEEP=0` | enabled |
| `--fee-sweep-floor <writes>` | `floor_writes` | `J41_FEE_SWEEP_FLOOR` | 100 |
| `--fee-sweep-interval <minutes>` | `interval_ms` | `J41_FEE_SWEEP_INTERVAL_MS` | 30 min |

Precedence is CLI flag > config/env > default.

> **Unit warning:** the CLI flag takes **minutes**; the config/env values take **milliseconds** (`_ms`/`_MS`). The asymmetry is deliberate — an unsuffixed env var sharing the flag's name invites `=30` meaning 30 minutes, which would land as 30 ms.

**Bootstrap caveat:** an agent that has **never earned** cannot self-fund. It logs `FEE TANK EMPTY and nothing to sweep — fund <R-addr> externally`, and the operator must send VRSC to the R-address once.

### The `wallet` command

The automatic sweep handles the common case. `wallet` is the manual surface for
everything else — seeing where the money is, forcing a sweep, and topping up an agent
that cannot self-fund.

```bash
j41-dispatcher wallet                              # fleet table (default action: list)
j41-dispatcher wallet --json                       # same, machine-readable
j41-dispatcher wallet show agent-6                 # both addresses + per-UTXO breakdown
j41-dispatcher wallet sweep agent-6                # force an i→R sweep now
j41-dispatcher wallet sweep --all                  # every agent with a sweepable balance
j41-dispatcher wallet send agent-2 agent-11 1.0    # R→R top-up between fleet agents
```

### Getting your earnings out of the fleet

`wallet send` deliberately refuses external addresses — every destination
resolves to another fleet agent's own key, so a typo cannot send your earnings
to a stranger. That safety has a consequence worth stating plainly: **there is
no withdraw command.** Money leaves the fleet by importing the agent's key into
a wallet you control.

1. Sweep earnings from the i-address to the spendable R-address:
   `j41-dispatcher wallet sweep <agent-id>`
2. Read the WIF (private key) for that agent:
   `~/.j41/dispatcher/agents/<agent-id>/keys.json` → the `wif` field.
   If your keystore is encrypted, unlock it first (`j41-dispatcher decrypt-keys`,
   or supply `J41_KEYS_PASSPHRASE`).
3. Import that WIF into Verus Desktop / Verus Mobile, or any wallet that accepts
   a WIF on the same network, and send from there.

**That WIF is the agent's whole identity, not just its money.** Anyone holding
it can sign as your agent — publish profile changes, submit reviews, and spend
the balance. Import it into a wallet you control, never paste it anywhere else,
and prefer moving the coins out over leaving the key imported somewhere.

On `verustest` the coins are test coins with no market value; this matters on
mainnet.

```
Fleet Wallet — verustest (https://api.junction41.io)

  AGENT      IDENTITY          FEE TANK   WRITES   SWEEPABLE  STATUS
  agent-2    dt3worker2@    22.86010000   228601  17.99990000  ok
  agent-6    dt3worker6@     0.13480000     1348   0.00000000  ok
  agent-8    (not registered)        —        —           —    unregistered — never queried; fund RS8Q… externally

  Fleet: 67.68760000 VRSCTEST in tanks (676876 writes) / 37.50990000 sweepable
  — means never queried, NOT zero. Those totals exclude it.
```

A sweep is **self-funding**: it pays its own fee out of the inputs it moves, so it works
at a zero R-address balance — which is exactly when you need it. Unlike the automatic
sweep it applies **no floor**, because you asked for it explicitly.

`send` moves funds **between fleet agents only**. The destination is an agent-id, resolved
to that agent's own R-address; raw addresses are refused on purpose, since a typo'd
destination on an irreversible transaction is the one mistake that actually loses money.

| Flag | Effect |
|---|---|
| `--json` | Satoshis as integers, never floats. `null` (not `0`) for agents never queried. |
| `--dry-run` | Plans and builds, never broadcasts. **A successful build proves nothing** — the signer will happily sign what the daemon rejects. |
| `--yes` | Skips confirmation. Refused for `send` on mainnet. |
| `--all` | `sweep` only — every agent with a sweepable balance; one failure doesn't stop the rest. |
| `--allow-drain` | `send` only — permits leaving the source below its write reserve. |
| `--force` | Overrides the pending-transaction guard. |

**Guards.** `send` refuses a raw address, a self-send, an unparseable amount, and any
amount that would leave the source below a 100-write reserve (draining one tank to fill
another just moves the outage). On **mainnet**, `send` refuses `--yes` and makes you retype
the exact amount.

**The pending guard.** After any broadcast the CLI stamps
`~/.j41/dispatcher/agents/<id>/wallet-pending.json` (mode 0600) and refuses further spends
for that agent until the transaction confirms. This matters because the platform serves the
**last confirmed** UTXO view: for a minute or more after a broadcast it still shows the
spent outputs as unspent, and rebuilding from that view double-spends them. The stamp
clears automatically once the transaction confirms, and fails closed on any doubt — if the
status lookup errors, the guard holds. Override with `--force` only if you know the
transaction is dead.

> `null` vs `0` is deliberate throughout. `0` means "we queried and the tank is empty";
> `—`/`null` means "this agent has no identity, so we never queried". Treating the second as
> the first is how an operator sends a second unnecessary transfer.

## Scale

**Fee-tank checks scale comfortably — measured.** `checkFeeTanks` costs roughly
one API call per agent, against a 30-minute interval:

| agents | round trip | cycle time |
|---|---|---|
| 10 | 50 ms | 0.6 s |
| 100 | 50 ms | 5.6 s |
| 100 | 500 ms | 50 s |
| 100 | 1.5 s | 151 s |

Even the worst of those uses 8% of its interval. No practical ceiling.

**The poll loop is the constraint, and it depends on latency rather than agent
count — derived from the interval arithmetic, not measured end to end.** Its
budget is `max(60s, agents x 1s)`; a cycle costs `(agents-1) x 500ms` of stagger
plus one round trip per agent.

Above 60 agents the budget grows by 1s per agent while the cost grows by
`500ms + round-trip`, so **a round trip at or under 500ms never overruns, at any
agent count**:

| round trip | behaviour |
|---|---|
| 250 ms | never overruns (~75% of budget, flat) |
| 500 ms | never overruns, but ~99% of budget — no headroom for jitter |
| 750 ms | overruns from ~49 agents |
| 1 s | overruns from ~41 agents |
| 1.5 s | overruns from ~31 agents |

So the question is not "how many agents can I run" but "how slow is my API". If
your round trip is under half a second, agent count is not your limit.

Treat these as arithmetic, not measurements. The reliable signal is the skip
counter below, which reports the condition directly whatever your latency is.

When a cycle overruns, the next one is skipped by the reentrancy guard. That is
safe but it means the fleet is looking for work less often than it appears to be,
so it is reported rather than hidden: a `[Poll]` / `[FeeTank]` warning naming the
count, and `poll_cycles_skipped` / `fee_tank_cycles_skipped` in `/health`.

**If you see skipped cycles**, you have more agents than the interval allows at
your API latency. Raise the interval:

```bash
J41_POLL_INTERVAL_MS=180000 j41-dispatcher start   # or [poll] interval_ms in config.toml
```

The default is automatic — `max(60s, agents x 1s)` — and setting the knob overrides it.
Note the real cost is roughly **3 round trips per agent**, not one: the cycle also runs
the dispute reconciler and three per-active-job passes. At 500 ms latency a 30-agent
fleet is already near its budget, so prefer measuring `poll_cycles_skipped` over
trusting the table above.

Running a **second dispatcher** on the same host is possible but needs more than the
three port variables: it also needs its own `HOME` (or `J41_DIR`), because
`dispatcher.pid`, the control socket and the whole `~/.j41/dispatcher` state directory
are shared otherwise — and `start` SIGTERMs whatever PID it finds in `dispatcher.pid`.
**Starting a second instance without a separate HOME will stop the first one.** Set
`J41_HEALTH_PORT`, `J41_CONTROL_API_PORT`, `J41_EGRESS_PROXY_PORT` *and* `HOME`.

Skipped cycles do **not** mark the daemon unhealthy — they are a capacity signal
to tune, not a fault.

## Configuration

### File Paths

| Path | Purpose |
|---|---|
| `~/.j41/dispatcher/agents/agent-N/keys.json` | Agent keypair (public + private) |
| `~/.j41/dispatcher/agents/agent-N/SOUL.md` | Agent personality / system prompt |
| `~/.j41/dispatcher/agents/agent-N/profile.json` | Saved VDXF profile (from interactive setup) |
| `~/.j41/dispatcher/agents/agent-N/webhook-config.json` | Webhook secret for this agent |
| `~/.j41/dispatcher/config.toml` | Dispatcher config — LLM provider keys, runtime knobs, executor settings (mode 0600) |

### Dispatcher Settings

Configurable via interactive menu (System Settings) or `j41-dispatcher config`:

| Setting | Flag | Default | Description |
|---|---|---|---|
| Runtime | `--runtime` | docker | `docker` or `local` |
| Max concurrent | `--max-concurrent` | unlimited | Agent slots (operator chooses) |
| Job timeout | `--job-timeout` | 60 | Minutes per job (1-1440) |
| Extension auto-approve | `--extension-auto-approve` | true | Auto-approve session extensions |
| CPU threshold | `--extension-max-cpu` | 80 | Reject extensions if load avg > this % of cores |
| RAM threshold | `--extension-min-free-mb` | 512 | Reject extensions if free RAM below this (MB) |

### Service Lifecycle Fields

Per-service settings passed during registration:

| Field | Range | Default | Description |
|---|---|---|---|
| `--idle-timeout` | 5-2880 min | 10 | Minutes before agent goes idle |
| `--pause-ttl` | 15-10080 min | 60 | Minutes paused before auto-cancel |
| `--reactivation-fee` | 0-1000 | 0 | Cost to wake an idle agent |

### Provider & LLM Keys

Run `j41-dispatcher dashboard` → "[3] Configure Agent Executor" / "[4] Configure Global LLM Default" to set your provider and API key. Config is stored at `~/.j41/dispatcher/config.toml` (mode 0600).

Provider API keys belong in the `[provider_keys]` table of `config.toml` — they are never read from the dispatcher's own environment. See `docs/config.toml.example` for the format.

**`[provider_keys]` is keyed by the exact preset name** you set in `[llm] provider` (or a per-agent `llmProvider`) — not by provider company. `provider = "gemini"` reads `provider_keys.gemini`; the `claude-*` presets read `provider_keys.claude-sonnet` etc. (an OpenRouter key, since Claude presets route through OpenRouter). A key stored under any other name — including `anthropic`, `google`, or `xai` — is read by **nothing**; the resolver falls back to `llm.api_key` and, if that is empty too, the preflight LLM probe fails auth and agents decline every job as "LLM unavailable" while you hold a valid key. Variant presets each need their own entry (`openai-mini` does not read `provider_keys.openai`), or use `llm.api_key` as the shared fallback.

> **`.env` migration caveat:** the legacy auto-migration maps `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` and `XAI_API_KEY` into `provider_keys.anthropic|google|xai` — slots no preset reads. After migrating, move those values to the preset name you actually use (`claude-*` → an OpenRouter key under the preset name, `gemini`/`gemini-flash` → the Google key, `grok` → the xAI key).

### Environment Variables (ops overrides)

These env vars override the corresponding `config.toml` value for CI or one-shot ops. `config.toml` remains the source of truth for persistent settings.

| Variable | Description |
|---|---|
| `J41_API_URL` | Junction41 platform API base URL |
| `J41_MAX_CONCURRENT` | Override max concurrent from config |
| `IDLE_TIMEOUT_MS` | Idle timeout before pause (default: 480000 ms / 8 min — deliberately before the backend's 10-min auto-deliver) |
| `J41_REQUIRE_FINALIZE` | When set, agents must be finalized before the dispatcher will use them |
| `J41_FEE_SWEEP` | Enable/disable the i→R fee-tank sweep (default: enabled) — see [Wallets & Fee Tank](#wallets--fee-tank) |
| `J41_FEE_SWEEP_FLOOR` | Sweep when an agent can afford fewer than this many on-chain writes (default: 100) |
| `J41_FEE_SWEEP_INTERVAL_MS` | Fee-tank check interval in **milliseconds** (default: 1800000 / 30 min). The CLI flag takes minutes |
| `J41_NO_STATUS_TOGGLE` | `=1` skips the startup activate-all and shutdown deactivate-all loops, leaving platform state as-is. **Env-only by design** — a per-run flag, deliberately not persistable in `config.toml`, since a persisted value would permanently stop a dispatcher from activating or deactivating its agents |

Full override list: `ENV_OVERRIDES` in `src/config-loader.js`.

### Unattended / Production Operation

By default, `start` and any key-dependent command (register, activate, etc.) will prompt interactively for a passphrase if at-rest encryption is enabled. In a headless environment, provide the passphrase non-interactively via one of these methods (checked in order):

1. **Env var:** `J41_KEYS_PASSPHRASE=<passphrase> j41-dispatcher start`
2. **systemd credential:** load a credential named `j41-keys-passphrase` (e.g., `LoadCredential=j41-keys-passphrase:/run/secrets/j41-passphrase` in the unit file)

At-rest encryption is **opt-in** — run `j41-dispatcher encrypt-keys` to enable it. It wraps all agent WIFs with AES-GCM derived from a passphrase-based master key.

**Honest scope:** at-rest encryption protects against a stolen disk image or backup leaking your agent private keys. It does **not** protect against a live-compromised host (the running process holds the decrypted keys in memory). If your threat model includes a live host compromise, treat key isolation (separate signing oracle, HSM) as a separate problem.

### Token Budget Enforcement (WP-D4)

Every job runs with a **finite token budget**, derived at session start from the
job's VRSC payment via the SDK pricing calculator and enforced before every LLM
call (`local-llm` and `mcp` executors). The flow:

1. **Budget set at start** — `job amount (VRSC) × vrsc_usd_rate × spend_fraction`,
   converted to tokens for the agent's actual model. If the exchange rate is
   missing/stale or the model isn't in the pricing table, the
   **conservative fallback budget** applies — a job can never run unmetered.
2. **Warning at `warning_percent`** (default 80%) — the job-agent requests a
   budget extension, priced from the job's actual model and the session's
   *observed* input:output token ratio. With no usable exchange rate the
   dispatcher will **not** auto-request money (fail closed; it logs instead).
3. **Exhausted** — generation pauses (the buyer gets an honest status message,
   tool loops stop mid-task), and the session waits up to `extension_wait_ms`
   (default 10 min) for the buyer to approve.
4. **Approved** → `budget_increased` reaches the container (fork *and* Docker
   modes) and generation resumes; the warning re-arms so a second overrun asks
   again. **Not approved in time** → the session ends and delivers the partial
   work with an honest status — never a silent token burn.

Cumulative usage (`promptTokens`, `completionTokens`, `llmCalls`, plus the
extension request/grant log) is recorded in the on-chain job record and the
`deletion-attestation.json` sidecar, so the buyer can audit what extension
requests were based on. (Embedding usage inside the *signed* attestation
payload requires an SDK/backend schema change — tracked for the platform side.)

Config (`config.toml` `[budget]`, env overrides in parentheses):

| Setting | Default | Description |
|---|---|---|
| `vrsc_usd_rate` (`J41_VRSC_USD_RATE`) | 0 (unset) | USD per VRSC. **Set this** — unset means fallback budgets and no auto-priced extensions |
| `rate_max_age_ms` (`J41_VRSC_RATE_MAX_AGE_MS`) | 86400000 | Rate older than this counts as missing (fail closed) |
| `spend_fraction` (`J41_BUDGET_SPEND_FRACTION`) | 0.6 | Share of job value spendable on LLM cost |
| `fallback_token_budget` (`J41_FALLBACK_TOKEN_BUDGET`) | 50000 | Budget when the job can't be priced |
| `warning_percent` (`J41_BUDGET_WARNING_PERCENT`) | 80 | Budget % that triggers an extension request |
| `extension_wait_ms` (`J41_BUDGET_EXTENSION_WAIT_MS`) | 600000 | Wait for approval before delivering partial work |

The rate is stamped into each job container's environment with the container
start time; all conversions go through `src/token-budget.js` — there are no
inline exchange rates or per-token cost constants anywhere else.

## Architecture

```
                          Junction41 Platform
                                |
              +-----------------+-----------------+
              |                                   |
         Poll / Webhook                     SovGuard WS
              |                                   |
    +---------v---------+              +----------v----------+
    |    Dispatcher      |              |   Agent Worker N    |
    |  (orchestrator)    +--spawns----->|  (ephemeral process)|
    |  up to N workers   |              |  chat + file I/O    |
    +--------------------+              +---------------------+
```

The dispatcher maintains a pool of registered agents. When a job arrives, it assigns the job to an idle agent, starts a worker process, and monitors it through completion. Each worker is isolated and stateless -- once the job finishes, the process exits and its data is cleaned up after deletion attestation.

### Runtime Modes

**Docker** (default) -- Each job runs inside an ephemeral container with security hardening:
- Seccomp + AppArmor profiles via `@junction41/secure-setup`
- gVisor runtime (if KVM available) or bubblewrap fallback
- `CapDrop: ALL`, `ReadonlyRootfs: true`, `PidsLimit: 64`
- `j41-isolated` Docker network (ICC disabled)
- Container runs as host UID (no root-owned files)
- Security score: 10/10 (gVisor), 8/10 (bwrap), 4/10 (Docker only)

```bash
# Build the job-agent Docker image (required before first run).
# The SDK (@junction41/sovagent-sdk) is installed from npm during the build —
# no local SDK staging required.
j41-dispatcher build-image
# …or directly:
docker build -f Dockerfile.job-agent -t j41/job-agent:latest .
```

**Local** (dev only, requires `--dev-unsafe`) -- Each job runs as a Node.js child process on the host. Zero isolation — not safe for production.

```bash
j41-dispatcher start --dev-unsafe
```

### LLM Providers (25 presets)

Configure via `j41-dispatcher dashboard` → "Global LLM Default", or set `[llm]` and `[provider_keys]` in `~/.j41/dispatcher/config.toml` (`[provider_keys]` entries are keyed by the exact **preset** name — see [Provider & LLM Keys](#provider--llm-keys)). Env vars `J41_LLM_PROVIDER`, `J41_LLM_BASE_URL`, `J41_LLM_API_KEY`, `J41_LLM_MODEL` override config for ops convenience.

| Provider | Preset | Variants | Default Model |
|---|---|---|---|
| OpenAI | `openai` | `openai-mini`, `openai-o3` | gpt-4.1 |
| Anthropic (via OpenRouter) | `claude-sonnet` | `claude-opus`, `claude-haiku` | anthropic/claude-sonnet-4-6 |
| Google | `gemini` | `gemini-flash` | gemini-2.5-pro |
| xAI | `grok` | — | grok-4 |
| Mistral | `mistral` | — | mistral-large-latest |
| DeepSeek | `deepseek` | — | deepseek-chat |
| Cohere | `cohere` | — | command-a-03-2025 |
| Perplexity | `perplexity` | — | sonar-pro |
| Groq | `groq` | — | llama-3.3-70b-versatile |
| Together | `together` | — | meta-llama/Llama-3.3-70B-Instruct-Turbo |
| Fireworks | `fireworks` | — | accounts/fireworks/models/llama-v3p3-70b-instruct |
| Azure OpenAI | `azure` | — | (set base URL + model yourself) |
| NVIDIA NIM | `nvidia` | — | nvidia/llama-3.1-nemotron-70b-instruct |
| Kimi | `kimi` | `kimi-nvidia` | kimi-k2.5 |
| OpenRouter | `openrouter` | — | anthropic/claude-sonnet-4-6 |
| Ollama | `ollama` | — | llama3.3 (local) |
| LM Studio | `lmstudio` | — | local-model |
| vLLM | `vllm` | — | local-model |
| Any OpenAI-compatible | `custom` | — | (set base URL + model yourself) |

**Claude presets route through OpenRouter** — Anthropic's native API uses `/messages`, not the `/chat/completions` path every executor calls.

### Executor Types

| Type | Description | Use Case |
|---|---|---|
| `local-llm` | Any OpenAI-compatible LLM (25 presets) | Default — direct chat agents |
| `webhook` | POST to REST endpoint | n8n, CrewAI, AutoGen, Dify, Flowise, Haystack |
| `langserve` | LangChain Runnables via /invoke | Stateless chains |
| `langgraph` | LangGraph Platform threads | Stateful agents |
| `a2a` | Google A2A protocol | Inter-agent communication |
| `mcp` | MCP server + LLM agent loop | Tool-using agents |

Framework aliases: `crewai`, `autogen`, `dify`, `flowise`, `haystack`, `n8n` all route to the `webhook` executor.

### Agent Templates

```bash
j41-dispatcher setup agent-1 myagent --template code-review
j41-dispatcher setup agent-2 myagent2 --template general-assistant
j41-dispatcher setup agent-3 myagent3 --template data-analyst
```

Templates include SOUL.md, profile config, service listing, and recommended pricing.

## Dispute Resolution

### Post-Delivery Container Lifecycle

After an agent delivers work, the container **stays alive** through the review window. The buyer can accept, let it expire (auto-complete), or file a dispute. The container is only killed after:
- `job.completed` — buyer accepted or auto-complete
- `job.dispute.resolved` — dispute closed (refund, rework, or rejection)

### CLI: Respond to a Dispute

```bash
j41-dispatcher respond-dispute <jobId> \
  --agent <agentId> \
  --action refund \
  --refund-percent 50 \
  --message "Partial refund for incomplete work"

j41-dispatcher respond-dispute <jobId> \
  --agent <agentId> \
  --action rework \
  --rework-cost 0 \
  --message "I will redo the work"

j41-dispatcher respond-dispute <jobId> \
  --agent <agentId> \
  --action rejected \
  --message "Work was delivered as specified"
```

### Webhook Events

| Event | Action |
|-------|--------|
| `job.dispute.filed` | Forwarded to job-agent via IPC |
| `job.dispute.responded` | Logged |
| `job.dispute.resolved` | Forwarded to job-agent → triggers cleanup |
| `job.dispute.rework_accepted` | Forwarded to job-agent → re-enters chat |
| `job.completed` | Forwarded to job-agent → triggers cleanup |

## Refund Approval Queue

Refunds to buyers are **never sent automatically**. Two paths queue them into a
durable ledger (`~/.j41/dispatcher/pending-refunds.json`) and stop there until
the owner approves:

- **Crash recovery** — jobs found orphaned at startup (paid but never delivered).
- **The dispute sweep** — disputes where the agent has agreed to a refund.

Each queued entry emits `refund.pending_approval` on the `/v1/events` feed
(`refund.needs_review` when the buyer address could not be verified) and logs
one line at startup. **Nothing else surfaces the queue** — pending refunds do
not currently appear in `ctl status` or `/health` — so check
`j41-dispatcher refunds` after any crash or dispute. Until an entry is
approved, the buyer has not been paid.

**Every outbound send passes one spend-policy gate** (`src/spend-policy.js`):
counterparty authorization (the allowlist for refunds; the job record for
payments), per-job / value-ceiling / hourly / cooldown rate limits, and a
compiled **hard ceiling** (`×2.0` of job price, 10 sends/job, 100/hour, 1000 VRSC
per tx) that a hand-edited `refund_limits` config **cannot widen** — anything
above is clamped and, on mainnet, refuses startup. Every gate decision and
broadcast outcome is appended to `~/.j41/spend-ledger.jsonl`. Approval mode is
`spend_policy.approval = "always"` (the default): external sends are owner-approved,
with no auto-approve path.

```bash
j41-dispatcher refunds                    # list pending (default action)
j41-dispatcher refunds list --all         # include refunded/rejected entries too
j41-dispatcher refunds approve <job-id>   # re-verify the buyer address, then send
j41-dispatcher refunds approve --all      # approve every pending_approval entry
j41-dispatcher refunds reject <job-id> --reason "text"
j41-dispatcher refunds unblock <job-id>   # clear an in-flight marker — only after
                                          # confirming on-chain the send did NOT arrive
```

Job-ids may be typed as unambiguous prefixes from `refunds list` output.
`approve` re-verifies the buyer address before sending and **refuses**
`needs_review` entries — fix the underlying data or `reject` them. Sends go
through the same hardened outbound-value path as everything else
(`~/.j41/financial-allowlist.json`).

## Deposit Anomalies

Deposits under 2 VRSC are credited from the mempool at 0 confirmations, and a
reconciler claws the credit back if the funding transaction never lands. Most of
that is automatic. Two states are not, because only a human can settle them: a
reversal that could not prove it ever debited the buyer, and a credit whose
process died between recording the intent and moving the money.

Those are counted in `/health` as `summary.deposits_needs_operator` — **alert on
that above 0, not on `status`**, which any container crash pins to `degraded` for
the rest of the run. Also exported as `j41_deposits_needs_operator` on `/metrics`.

```bash
j41-dispatcher deposits list                          # anomalies first, then open credits
j41-dispatcher deposits credit <agent-id> <txid>      # the buyer IS owed it
j41-dispatcher deposits dismiss <agent-id> <txid> --reason "..."   # nothing is owed
```

`list` reads disk directly, so it works whether or not the daemon is running, and
prints the buyer's meter `totalDeposited` against the ledger-derived expectation —
that number is what tells you whether the adjustment actually ran. `credit`
re-verifies the transaction on-chain and refuses on any doubt. Both take the
per-agent deposit lock, so they are safe to run against a live daemon.

Turn the reconciler off with `J41_DEPOSIT_RECONCILE=false` (or
`[deposit] reconcile_enabled = false`); raise or lower its fleet-wide hourly
reversal cap with `J41_DEPOSIT_REVERSAL_BUDGET`. Both take effect on restart.

## Workspace Integration

> **Parked — opt-in.** The workspace/jailbox path ("agent works inside the
> buyer's environment") is **default-off** in favour of deliver-and-review —
> see [JAILBOX_PARKED.md](JAILBOX_PARKED.md) for the rationale. Three gates
> refuse it until you opt back in: `[jailbox] enabled` in `config.toml`
> (default `false`), the dispatcher-side `checkWorkspaceCapability()` gate,
> and the in-container `connectWorkspace()` funnel. Re-enable with
> `JAILBOX_ENABLED=1` (the env override accepts **only the literal `1`** —
> `JAILBOX_ENABLED=true` is treated as unset) or `[jailbox] enabled = true`.
> Everything below describes behaviour **after** re-enabling.

When a buyer grants workspace access on a job and the jailbox is re-enabled, the dispatcher handles the full lifecycle:

1. **`workspace.ready`** — Platform notifies that a workspace session is available
2. **Dispatcher connects** — The job-agent connects via the SDK's `WorkspaceClient`
3. **Tool calls** — The executor (local-llm, mcp, etc.) can read/write files in the buyer's project
4. **Path validation** — All file paths are validated to prevent traversal attacks (`..`, absolute paths)
5. **Completion** — Agent signals done, buyer accepts, platform signs attestation

Workspace events handled: `workspace.ready`, `workspace.disconnected`, `workspace.completed`

## API Endpoint Proxy

Sell raw OpenAI-compatible inference time on your LLM server (local GPU, OpenRouter reseller, anything API-compatible) the same way you'd sell job-shaped work. Buyers pay-per-token, the dispatcher meters usage in VRSC, and J41 brokers discovery + access without ever seeing your upstream API key.

**Set up via TUI:** `j41-dispatcher dashboard` → `[18] API Endpoint Setup` walks through agent selection, upstream URL, model pricing, public URL (cloudflared tunnel auto-detected), and platform registration.

**Or scripted:** `j41-dispatcher api-setup <agent-id> --upstream-url <url> --model 'kimi-k2:1:4' --public-url <url>` — see `j41-dispatcher api-setup --help`.

**Routes the dispatcher exposes** (when at least one api-endpoint agent is registered):

| Route | Purpose |
|---|---|
| `POST /j41/discovery/request-access` | ECDH key exchange — J41 forwards from `/v1/proxy/access/:sellerVerusId`. Mints API key + encrypted envelope. |
| `POST /j41/proxy/v1/*` | OpenAI-compatible proxy. Validates bearer key, checks credit, forwards upstream, meters response. Adds `X-J41-Session`, `X-J41-Credit-Remaining`, `X-J41-Model` headers. |
| `POST /j41/deposit/report` | Buyer reports an on-chain VRSC deposit; dispatcher verifies via verusd RPC and credits the meter. |
| `GET /j41/health` | Liveness — `{service, version, status, agents, proxy}`. |

**Verification is fully local and fail-closed.** Both v1 (pipe-format) and v2 (canonical) envelopes are verified against the buyer's VerusID using `bitcoinjs-message`. v2 resolves primary R-addresses via the public `/v1/identity/:idOrName/keys` endpoint and enforces the `minimumSignatures` threshold. No bypass env var exists in the codebase.

**Credit metering** uses the reservation pattern: estimated cost is deducted upfront, the actual cost (computed from the upstream's `usage` response) corrects the reservation after the request completes. Streaming responses parse `usage` line-by-line via `JSON.parse` so nested fields like `completion_tokens_details` survive. Models not in the seller's `modelPricing` are rejected with a 400 listing the supported set.

Two settle rules are worth knowing because they are deliberate, not defaults:

- **A non-2xx upstream bills nothing** — not the reservation, not the estimate — on both the streaming and non-streaming paths, whether or not the error response happens to carry a `usage` block, and whether or not the stream ended cleanly. The buyer received an error, not tokens.
- **An unknown output count settles at the declared worst case** (`max_tokens`, bounded by `proxy.max_output_tokens_cap`), not at the flat estimate, so an upstream that ignores `stream_options.include_usage` cannot serve a large completion cheaply. A *reported* `completion_tokens: 0` is real data and bills zero — "reported none" and "reported nothing" are different facts.
- **A stream that aborts mid-response bills only what a usage frame proved**, and nothing for output if none arrived. The worst-case settle above is an anti-abuse measure against an upstream withholding its usage count; an abort is a fault the buyer cannot cause, so it is the one case where the worst case does not apply.


See [docs.junction41.io/dispatcher/api-endpoint-proxy](https://docs.junction41.io/dispatcher/api-endpoint-proxy) for the full buyer/seller flow and SDK helpers.

## Control Plane

The dispatcher exposes a Unix domain socket at `~/.j41/dispatcher/control.sock` for live management:

```bash
j41-dispatcher ctl status          # uptime, active jobs, queue, agents
j41-dispatcher ctl jobs            # active jobs with PID, duration, tokens
j41-dispatcher ctl agents          # agent list with workspace + services
j41-dispatcher ctl resources       # CPU, RAM, per-job memory, capacity headroom
j41-dispatcher ctl earnings        # per-agent VRSC earnings
j41-dispatcher ctl history         # recent completed jobs with token usage
j41-dispatcher ctl providers       # current LLM + available presets
j41-dispatcher ctl shutdown        # graceful shutdown
j41-dispatcher ctl canary --agent agent-2  # check canary status
j41-dispatcher ctl status --json   # machine-readable output
```

### Headless Control API (WP-D1/D2)

The same read model is exposed as a versioned HTTP API on `127.0.0.1:9843`
(`control_api_port`), so *any* client — brainbox, a cron script, another
orchestrator — can drive a dispatcher without the TUI. The `ctl` socket and the
HTTP API share one set of read-model builders, so they never drift.

Because this daemon moves money, **every `/v1/*` endpoint requires a bearer
token**, even from localhost. The token is auto-created at
`~/.j41/dispatcher/control.token` (mode 0600) on first start; same-user access
is trivial, other-user access is impossible.

```bash
TOKEN=$(cat ~/.j41/dispatcher/control.token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9843/v1/status
```

| Endpoint | Returns |
|---|---|
| `GET /v1/status` | uptime, pool, queue depth |
| `GET /v1/agents` | registered agents + busy/available state |
| `GET /v1/jobs` | active jobs + queue depth |
| `GET /v1/jobs/:id` | one active job's detail (404 if not running) |
| `GET /v1/earnings` | per-agent VRSC rollups (hits the platform) |
| `GET /v1/events?since=N` | monotonic event feed (polling transport) |

**Events** (`/v1/events`) are a file-backed ring buffer with a monotonic `seq`
that survives restart, so a polling client's `since` cursor stays valid across a
bounce. The response is `{ events: [...], cursor: N }`; poll with the last
`cursor` as `since`.

Event types emitted in **both modes** (poll and webhook):

- `job.accepted|started|delivered|completed|declined_llm_down`
- `extension.requested`
- `container.started|died`
- `agent.online|offline|llm_down`
- `dispute.unresolved_agent|surfacing_expired|reconcile_gave_up`
- `refund.pending_approval|needs_review` — a buyer refund is waiting on
  `j41-dispatcher refunds approve`; see [Refund Approval Queue](#refund-approval-queue)
- `inbox.dead_lettered|pending_write_expired|batch_escalated`
- `fee_tank_empty`, `fee_sweep`

**Webhook mode only:** `extension.approved|rejected` and
`dispute.filed|resolved|responded|rework_accepted` are normalized from inbound
platform webhooks and can therefore only fire when the dispatcher runs with a
webhook URL. **In poll mode — the default — these types never appear**: a
monitor watching `dispute.filed` will never see a dispute. In poll mode, watch
the `dispute.*` and `refund.*` types listed above instead, and use `ctl jobs` /
`/health` for job-level dispute state.

> Write endpoints (`POST /v1/agents/:id/activate`, offerings, dispute responses,
> and the buyer-side `/v1/hire/*`) land in later increments. This is the
> read-only skeleton plus the event/health surface.

### Health document — a compatibility promise

`GET /health` on `:9842` stays **open and unauthenticated** for monitor-room
probes. Its field **paths** are versioned API: the monitor room extracts dotted
paths (`agents.0.status`, `containers.0.state`, `summary.containers_unhealthy`)
and a renamed field breaks those watches silently — **treat a renamed health
field like a removed endpoint.** The numeric rollups under `summary` are
designed so `above:0` on `summary.containers_unhealthy` is the canonical
"tell me when anything is wrong" watch. `GET /metrics` remains Prometheus-text.

## Graceful Shutdown

On `SIGINT` (Ctrl+C), `SIGTERM`, or `ctl shutdown`:

1. Stops accepting new jobs
2. Sends `shutdown` IPC to all active job-agents
3. Each job-agent delivers current work, notifies the buyer, submits attestation
4. Waits up to 30s for clean exit, then SIGTERM -> SIGKILL
5. Marks all agents offline on platform
6. Clears active-jobs.json and exits

## Security

### Three-Wall Isolation

Every agent container runs inside three concentric security walls:

```
Host (WIF, keys — never enter the container)
 +-- Wall 1: gVisor (user-space kernel, Linux) or Docker Desktop VM (macOS)
      +-- Wall 2: Docker (seccomp, AppArmor, cap-drop ALL, read-only rootfs)
           +-- Wall 3: Bubblewrap (VPS fallback — minimal fs view, no network)
                +-- Agent (session token only — no keys, no crypto awareness)
```

The system auto-detects the best isolation on first `j41-dispatcher start` via `@junction41/secure-setup`. No manual configuration needed.

### Mainnet security gate

On mainnet (`platform.network = 'verus'`) the dispatcher refuses to start if any of these are set — they are testnet/debug escape hatches, not configuration:

- `J41_SIGNING_BROKER=0` — broker signing disabled; the host-side signing broker is mandatory so the agent WIF never enters the job container
- `--dev-unsafe` — local mode with zero container isolation
- `J41_DISABLE_BWRAP=1` — disables the bwrap entrypoint sandbox
- `J41_ALLOW_LOCAL_UPSTREAM=1` — disables SSRF protection on the proxy
- `J41_SKIP_STATUS_CHECK=1` — skips agent platform-status checks
- `J41_ALLOW_LEGACY_REVOKE=1` — accepts replayable legacy revoke webhooks
- `J41_WITNESS_VERIFY=off` — disables platform-witness verification of on-chain job records
- `J41_ALLOW_UNPRICED_JOBS=1` — admits jobs with no payment record at all
- `J41_SCAN_BUYER_CHAT=0` — disables SovGuard scanning of inbound buyer messages
- `J41_ALLOW_INSECURE=1` — permits plaintext HTTP; credentials cross the wire in the clear
- `J41_LOCAL_SIGNER_TEST_MODE=1` — lets the local signer sign a deliver without the authoritative jobHash
- `J41_TRUST_PLATFORM_RESOLUTION=1` — trusts platform identity resolution instead of verifying locally

`J41_PLATFORM_SIGNER` is not in this list because the SDK already refuses to run on mainnet without it.

The mainnet check is sticky — `J41_NETWORK` cannot downgrade a mainnet config file to testnet to dodge the gate.

### Legacy opt-outs (do not set)

These exist for platform-transition compatibility only. Each one downgrades a security
default. The dispatcher never requires them, and **both are refused outright on mainnet**
by the gate above — they are usable on testnet and nowhere else.

- `J41_TRUST_PLATFORM_RESOLUTION=1` (SDK flag) — trusts platform-supplied identity resolution instead of verifying locally. Legacy behavior; default is local verification. Do not set.

### First-Run Security Setup

On first start, the dispatcher automatically:

1. Detects platform (Linux/macOS, KVM availability)
2. Installs gVisor (if KVM) or bubblewrap (fallback)
3. Deploys seccomp + AppArmor profiles
4. Creates `j41-isolated` Docker network (internal, ICC disabled)
5. Creates `~/.j41/financial-allowlist.json` (deny-all)
6. Pins the egress allowlist (platform + LLM API endpoints) for the CONNECT proxy
7. Runs self-test

Subsequent starts skip setup and run a quick-check instead.

### Container Hardening

Agent containers run with:

- `CapDrop: ['ALL']` — zero Linux capabilities
- `ReadonlyRootfs: true` with tmpfs `/tmp` (noexec, nosuid)
- Custom seccomp profile (~80 allowed syscalls, blocks ptrace/mount/reboot/keyctl/bpf)
- AppArmor confinement (Linux)
- `PidsLimit: 64` — fork bomb protection
- `StorageOpt: { size: '1G' }` — max disk
- `OomScoreAdj: 1000` — first to die under memory pressure
- `no-new-privileges` — no privilege escalation

### Network Lockdown

Dispatcher containers use the `j41-isolated` Docker network:

- Internal bridge with ICC disabled (no inter-container communication)
- iptables allowlist: only `api.junction41.io` + configured LLM provider endpoints
- DNS pinned and re-resolved every 5 minutes
- Egress is allowlisted per job by `src/egress-proxy.js` (host:port from the operator's configured upstreams, with a DNS-rebind re-check on the resolved address). `~/.j41/network-allowlist.json` is legacy: `@junction41/secure-setup` no longer writes it and the dispatcher never reads it — editing that file changes nothing. Extra hosts go through `J41_ALLOWLIST_EXTRA`.

### Financial Allowlists

All outbound financial operations are gated by `~/.j41/financial-allowlist.json`:

- **Deny-all by default** — empty allowlist blocks everything
- **Dynamic lifecycle** — buyer refund address added on job accept, removed on complete
- **Rate limiting** — max 3 sends/job, max value = job price + 10%, max 10 sends/hour, 30s cooldown. Enforced in `attemptPendingRefund`, the single point where VRSC leaves the host. Tune under `[refund_limits]` in `config.toml` (or `J41_REFUND_MAX_SENDS_PER_HOUR` etc.) — raise the hourly cap before draining a large approved backlog.
- **The counters are fleet-wide, not per-process** — they live in `~/.j41/dispatcher/send-history.json`, so a one-shot `refunds approve` run alongside the daemon shares one budget with it rather than getting a second one, the per-job cap survives a restart, and an outage suspension raised by the daemon's sweep stops sends from every process.
- **Fail-closed sweep** — every 10 min checks active jobs against platform API; suspends all sends if API unreachable for 30 min

A refund blocked by the hourly cap, the cooldown or the outage suspension is **deferred, not dropped** — it stays in the ledger and the next drain retries it. One blocked by the per-job cap or the value ceiling is left queued and reported, because retrying cannot fix it; clear it with `refunds reject <jobId>` after checking the chain.

### Local Mode

Local mode (`RUNTIME=local`) runs agents as bare processes with zero isolation.

- **Blocked by default** — requires `--dev-unsafe` flag
- Prints warning every 30 seconds when active
- Security score: 0/10
- Cannot register agents for public jobs on the platform

### Mandatory Canary Tokens

Every job automatically gets a canary token injected via `J41_CANARY_TOKEN` env var. If the token appears in agent output, it indicates prompt injection. Canary checking is always enabled.

### Existing Protections

- **Env isolation**: Local mode whitelists only necessary env vars
- **SSRF protection**: Executor URLs validated against private IP ranges
- **Path traversal**: Workspace file operations reject `..` and absolute paths
- **VDXF policy enforcement**: with the jailbox re-enabled, agents without on-chain `workspace.capability` are blocked from workspace connections. With the default (parked) config the jailbox gate blocks **all** workspace sessions before the capability check runs — see [JAILBOX_PARKED.md](JAILBOX_PARKED.md)
- **Key file safety**: Temp keys file permissions set to `0o600` (owner-read only)

### Security Self-Test

```bash
j41-secure-setup --check --dispatcher   # quick config validation
j41-secure-setup --test --dispatcher    # full test (spawns containers, attempts escapes)
```

## Testing

```bash
# Unit test: template creation (47 checks)
node scripts/test-create-template.js

# Unit test: full agent setup flow (32 checks)
node scripts/test-full-flow.js [agent-id] [identity-name]

# Interactive TUI test (24 checks, requires pexpect)
python3 scripts/test-interactive.py
```

## SDK Dependency

The dispatcher depends on `@junction41/sovagent-sdk`. During development, symlink the entire package:

```bash
ln -s /path/to/j41-sovagent-sdk/dist node_modules/@junction41/sovagent-sdk/dist
```

To rebuild the Docker image (SDK is installed from npm during the build):

```bash
j41-dispatcher build-image
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT -- see [LICENSE](LICENSE)
