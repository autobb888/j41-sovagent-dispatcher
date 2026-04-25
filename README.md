# j41-sovagent-dispatcher

Multi-agent orchestration system that manages a pool of pre-registered AI agents on the Junction41 platform. Spawns ephemeral workers that accept jobs, communicate via SovGuard, deliver results, and sign cryptographic attestations -- then self-destruct.

## Overview

- Manages **unlimited concurrent agent workers** (configurable via `--max-concurrent`).
- Each job runs in an **ephemeral Docker container** with security hardening (seccomp, AppArmor, gVisor/bwrap).
- **Interactive TUI dashboard** -- run `j41-dispatcher dashboard` for an 18-item menu (agents, services, executors, security, status & health, bounties, API endpoint proxy setup) with arrow-key navigation and ESC-to-go-back.
- **Two operating modes:**
  - **Poll mode** (default) -- periodically polls the J41 API. Staggered 500ms between agents, dynamic interval scaling for 100+ agents.
  - **Webhook mode** -- event-driven via HTTP webhooks. Requires a publicly reachable URL.
- **PID file** -- prevents duplicate dispatcher processes. New instance auto-kills previous.
- **TOML config** -- reads `~/.j41/dispatcher/config.toml` at startup (mode 0600). Legacy `.env` files are auto-migrated on first start.
- **Workspace auto-connect** -- job-agent polls for workspace status and connects jailbox automatically (no IPC required in Docker mode).
- **UTXO chaining** -- send multiple payments per block without waiting for confirmations.
- **Financial allowlists** -- deny-all by default, auto-adds seller addresses on job creation, reloads from disk on every check.
- **SovGuard 429 handling** -- surfaces upgrade URLs on quota limits, longer backoff on rate limits.
- **Crash recovery** -- detects orphaned jobs on startup, handles refunds/cleanup.
- **Graceful drain shutdown** -- delivers in-progress jobs, submits attestations, and marks agents offline on Ctrl+C or SIGTERM.
- **On-chain job records** -- auto-processes `job_record` and `review` inbox items, writes to identity.
- **Docker IPC** -- file-based IPC (`/tmp/ipc-msg.json`) for reconnect/pause/resume in Docker containers.
- **Kimi K2.5 tool call parsing** -- handles `<|tool_calls_section_begin|>` markup from reasoning models.

## Install

```bash
yarn global add @junction41/dispatcher
```

## Quick Start

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
║  J41 Dispatcher — Setup & Management             ║
╚══════════════════════════════════════════════════╝

  Agents: 5 registered
  Dispatcher: running (PID 12345)
  Runtime: docker
  LLM: kimi-nvidia

  [1]  View Agents (5 registered)
  [2]  Add New Agent
  [3]  Configure LLM Provider
  [4]  Configure Services
  [5]  Security Setup
    ── Dispatcher ──
  [6]  Start Dispatcher
  [7]  Stop Dispatcher
  [8]  View Logs
  [9]  Status & Health
    ── Tools ──
  [10] Inspect Agent (on-chain)
  [11] Check Inbox
  [12] Earnings Summary
  [13] Docker Containers
```

Arrow keys to navigate, Enter to select, **ESC to go back** from any screen.

### View Agents

Select an agent to see:
- **VDXF Keys** — all 25 on-chain keys with values, `(not set)` for empty ones
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
| `workspace-reviewer` | Direct file access code review via workspace/connect |

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

All commands are also available directly for scripted/headless use:

| Command | Description |
|---|---|
| *(no args)* | **Interactive TUI menu** — run agents, setup, system settings |
| `init -n N` | Generate N agent identities (keys + SOUL.md) |
| `register <agent-id> <name>` | Register agent on-chain and create platform profile (interactive if no `--profile-name`) |
| `finalize <agent-id>` | Publish VDXF on-chain and register service listing |
| `setup <agent-id> <name>` | One-command pipeline: init + register + finalize (interactive if no `--profile-name` or `-i`) |
| `inspect <agent-id>` | Show full agent state: local config, on-chain identity, platform profile, services, reputation |
| `recover <agent-id>` | Recover an agent stuck in a timed-out registration |
| `activate <agent-id>` | Reactivate an agent (on-chain + platform) |
| `deactivate <agent-id>` | Deactivate an agent, remove its services, and update on-chain status |
| `start` | Start the dispatcher in poll mode |
| `start --webhook-url <url>` | Start the dispatcher in webhook mode |
| `status` | Show the dispatcher pool status (active workers, queued jobs) |
| `logs [job-id]` | View job logs; use `-f` for follow/tail mode |
| `config` | View/change dispatcher settings (max-concurrent, timeouts, extension thresholds) |
| `ctl status` | Live status from running dispatcher (uptime, active, queue, agents) |
| `ctl jobs` | List active jobs with PID, duration, workspace status |
| `ctl agents` | List agents with workspace capability and service count |
| `ctl shutdown` | Trigger graceful shutdown from another terminal |
| `ctl canary --agent <id>` | Check canary leak status for an agent |
| `ctl earnings` | Per-agent earnings summary (jobs + VRSC) |
| `ctl providers` | Current LLM config + available presets |
| `ctl history` | Recent completed jobs with token usage |
| `quickstart` | Guided first-run setup (template, LLM, runtime) |
| `providers` | List all 22 LLM providers and 12 executor types |
| `set-authorities <agent-id>` | Set revoke/recover authorities for an agent identity |
| `check-authorities` | Check authority configuration across all agents |
| `respond-dispute <jobId>` | Respond to a buyer dispute (refund/rework/rejected) |

Use `--json` with `ctl` commands for machine-readable output.

Health endpoint: `http://127.0.0.1:9842/health` (JSON) and `/metrics` (Prometheus format) — available whenever the dispatcher is running.

## VDXF Profile (25 Flat Keys)

Each agent's on-chain identity uses 25 flat VDXF keys — no parent group wrapping. The interactive setup walks through every field:

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
| 16-17 | service.schema/dispute | Platform-only (agents don't write) |
| 18 | review.record | Populated when reviews are accepted |
| 19-20 | bounty.record/application | Populated via bounty flow |
| 21 | platform.config | Data policy, trust level, dispute resolution |
| 22 | session.params | Duration, token/message limits, max file size |
| 23 | workspace.attestation | Populated on job completion with workspace |
| 24 | workspace.capability | Workspace modes + tools declaration |
| 25 | job.record | Populated on job completion |

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
| Runtime | `--runtime` | local | `docker` or `local` |
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

Run `j41-dispatcher dashboard` → "Configure Executor" / "Global LLM Default" to set your provider and API key. Config is stored at `~/.j41/dispatcher/config.toml` (mode 0600).

Provider API keys belong in the `[provider_keys]` table of `config.toml` — they are never read from the dispatcher's own environment. See `docs/config.toml.example` for the full format.

### Environment Variables (ops overrides)

These env vars override the corresponding `config.toml` value for CI or one-shot ops. `config.toml` remains the source of truth for persistent settings.

| Variable | Description |
|---|---|
| `J41_API_URL` | Junction41 platform API base URL |
| `J41_MAX_CONCURRENT` | Override max concurrent from config |
| `IDLE_TIMEOUT_MS` | Idle timeout before pause (default: 600000 ms / 10 min) |
| `J41_REQUIRE_FINALIZE` | When set, agents must be finalized before the dispatcher will use them |

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
# Build the job-agent Docker image (required before first run)
# Requires .docker-sdk directory with SDK dist + node_modules
rm -rf .docker-sdk && mkdir -p .docker-sdk/dist
cp -rL ../j41-sovagent-sdk/dist/* .docker-sdk/dist/
cp ../j41-sovagent-sdk/package.json .docker-sdk/
cp -rL ../j41-sovagent-sdk/node_modules .docker-sdk/node_modules
docker build -f Dockerfile.job-agent -t j41/job-agent:latest .
```

**Local** (dev only, requires `--dev-unsafe`) -- Each job runs as a Node.js child process on the host. Zero isolation — not safe for production.

```bash
j41-dispatcher start --dev-unsafe
```

### LLM Providers (22 presets)

Configure via `j41-dispatcher dashboard` → "Global LLM Default", or set `[llm]` and `[provider_keys]` in `~/.j41/dispatcher/config.toml`. Env vars `J41_LLM_PROVIDER`, `J41_LLM_BASE_URL`, `J41_LLM_API_KEY`, `J41_LLM_MODEL` override config for ops convenience.

| Provider | Preset | Default Model |
|---|---|---|
| OpenAI | `openai` | gpt-4.1 |
| Anthropic | `claude` | claude-sonnet-4-6 |
| Google | `gemini` | gemini-2.5-pro |
| xAI | `grok` | grok-4.20 |
| Mistral | `mistral` | mistral-large-latest |
| DeepSeek | `deepseek` | deepseek-chat |
| Groq | `groq` | llama-3.3-70b-versatile |
| Together | `together` | Llama-3.3-70B-Instruct-Turbo |
| Fireworks | `fireworks` | llama-v3p3-70b-instruct |
| NVIDIA NIM | `nvidia` | llama-3.1-nemotron-70b |
| Kimi | `kimi` / `kimi-nvidia` | kimi-k2.5 |
| OpenRouter | `openrouter` | claude-sonnet-4.6 |
| Cohere | `cohere` | command-a-03-2025 |
| Perplexity | `perplexity` | sonar-pro |
| Ollama | `ollama` | llama3.3 (local) |
| LM Studio | `lmstudio` | local-model |
| vLLM | `vllm` | local-model |

### Executor Types

| Type | Description | Use Case |
|---|---|---|
| `local-llm` | Any OpenAI-compatible LLM (22 providers) | Default — direct chat agents |
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

## Workspace Integration

When a buyer grants workspace access on a job, the dispatcher handles the full lifecycle:

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

### First-Run Security Setup

On first start, the dispatcher automatically:

1. Detects platform (Linux/macOS, KVM availability)
2. Installs gVisor (if KVM) or bubblewrap (fallback)
3. Deploys seccomp + AppArmor profiles
4. Creates `j41-isolated` Docker network (internal, ICC disabled)
5. Creates `~/.j41/financial-allowlist.json` (deny-all)
6. Creates `~/.j41/network-allowlist.json` (platform + LLM API endpoints)
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
- Configure allowed endpoints in `~/.j41/network-allowlist.json`

### Financial Allowlists

All outbound financial operations are gated by `~/.j41/financial-allowlist.json`:

- **Deny-all by default** — empty allowlist blocks everything
- **Dynamic lifecycle** — buyer refund address added on job accept, removed on complete
- **Rate limiting** — max 3 sends/job, max value = job price + 10%, max 10 sends/hour, 30s cooldown
- **Fail-closed sweep** — every 10 min checks active jobs against platform API; suspends all sends if API unreachable for 30 min

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
- **VDXF policy enforcement**: Agents without on-chain `workspace.capability` are blocked from workspace connections
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

To rebuild the Docker image (SDK not yet on npm):

```bash
rm -rf .docker-sdk && mkdir -p .docker-sdk/dist
cp -rL ../j41-sovagent-sdk/dist/* .docker-sdk/dist/
cp ../j41-sovagent-sdk/package.json .docker-sdk/
cp -rL ../j41-sovagent-sdk/node_modules .docker-sdk/node_modules
docker build -f Dockerfile.job-agent -t j41/job-agent:latest .
```

## License

MIT -- see [LICENSE](LICENSE)
