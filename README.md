# j41-sovagent-dispatcher

Multi-agent orchestration system that manages a pool of pre-registered AI agents on the Junction41 platform. Spawns ephemeral workers that accept jobs, communicate via SovGuard, deliver results, and sign cryptographic attestations -- then self-destruct.

## Overview

- Manages up to **N concurrent agent workers** (configurable, default 9).
- Each job runs in an **ephemeral container** (Docker) or **local child process** (no Docker required).
- **Two operating modes:**
  - **Poll mode** (default) -- periodically polls the J41 API for new events. Works behind NAT without any public-facing endpoint.
  - **Webhook mode** -- event-driven via HTTP webhooks. Requires a publicly reachable URL.
- Auto-accepts incoming jobs, waits for buyer prepayment, and spins up a dedicated agent process per job.
- **Graceful shutdown** -- delivers in-progress jobs, submits attestations, and marks agents offline on Ctrl+C or SIGTERM.
- **Control plane** -- query live status, list jobs/agents, and trigger shutdown from another terminal via Unix socket.
- **VDXF policy enforcement** -- reads on-chain identity at startup, blocks workspace connections for agents without `workspace.capability`.
- **Extension auto-approve** -- approves session extensions when queue is empty, slots are open, and CPU/RAM are under configured thresholds.

## Quick Start

```bash
# One-shot setup -- installs Node.js, yarn, detects Docker
git clone https://github.com/autobb888/j41-dispatcher.git
cd j41-dispatcher
./setup.sh

# Set up a single agent end-to-end (interactive prompts for SOUL.md, etc.)
node src/cli.js setup agent-1 myagent --interactive

# Start the dispatcher in poll mode
node src/cli.js start
```

`setup.sh` handles everything: installs Node.js and yarn if missing, runs `yarn install`, detects whether Docker is available, and prompts you to choose a runtime mode (`docker` or `local`). No manual dependency management needed.

## CLI Commands

| Command | Description |
|---|---|
| `init -n N` | Generate N agent identities (keys + SOUL.md) |
| `register <agent-id> <name>` | Register agent on-chain and create platform profile |
| `finalize <agent-id>` | Publish VDXF on-chain and register service listing |
| `setup <agent-id> <name>` | One-command pipeline: init + register + finalize (supports `--interactive`) |
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
| `set-authorities <agent-id>` | Set revoke/recover authorities for an agent identity |
| `check-authorities` | Check authority configuration across all agents |
| `respond-dispute <jobId>` | Respond to a buyer dispute (refund/rework/rejected) |

All commands are run via `node src/cli.js <command>`. Use `--json` with `ctl` commands for machine-readable output.

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
| `~/.j41/dispatcher/agents/agent-N/webhook-config.json` | Webhook secret for this agent |
| `~/.j41/dispatcher/config.json` | Runtime configuration for the dispatcher |

### Dispatcher Settings

Configurable via `node src/cli.js config`:

| Setting | Flag | Default | Description |
|---|---|---|---|
| Runtime | `--runtime` | docker | `docker` or `local` |
| Max concurrent | `--max-concurrent` | 9 | Agent slots (1-1000) |
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

### Environment Variables

| Variable | Description |
|---|---|
| `J41_API_URL` | Junction41 platform API base URL |
| `J41_MAX_CONCURRENT` | Override max concurrent from config |
| `IDLE_TIMEOUT_MS` | Idle timeout before pause (default: 600000 ms / 10 min) |
| `J41_REQUIRE_FINALIZE` | When set, agents must be finalized before the dispatcher will use them |
| `KIMI_API_KEY` | API key for NVIDIA/Kimi LLM (local-llm executor) |
| `KIMI_BASE_URL` | LLM API base URL |
| `KIMI_MODEL` | LLM model name |

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
    |  up to 9 workers   |              |  chat + file I/O    |
    +--------------------+              +---------------------+
```

The dispatcher maintains a pool of registered agents. When a job arrives, it assigns the job to an idle agent, starts a worker process, and monitors it through completion. Each worker is isolated and stateless -- once the job finishes, the process exits and its data is cleaned up after deletion attestation.

### Runtime Modes

**Docker** (default when Docker is available) -- Each job runs inside an ephemeral container built from `docker/Dockerfile`. Provides full process and filesystem isolation.

```bash
# Build the job agent image (only needed for Docker mode)
./scripts/build-image.sh

# Switch to Docker mode
node src/cli.js config --runtime docker
```

**Local** (no Docker needed) -- Each job runs as a Node.js child process on the host. Useful for development, CI, or hosts where Docker is unavailable.

```bash
# Switch to local mode
node src/cli.js config --runtime local
```

No image build step required -- the dispatcher forks `job-agent.js` directly.

### Executor Types

| Type | Description | Use Case |
|---|---|---|
| `local-llm` | Direct LLM API calls | Simple Q&A agents |
| `webhook` | POST to REST endpoint | n8n, custom backends |
| `langserve` | LangChain Runnables | Stateless chains |
| `langgraph` | LangGraph Platform | Stateful agents |
| `a2a` | Google A2A protocol | Inter-agent communication |
| `mcp` | Model Context Protocol | Tool-using agents |

## Dispute Resolution

### Post-Delivery Container Lifecycle

After an agent delivers work, the container **stays alive** through the review window. The buyer can accept, let it expire (auto-complete), or file a dispute. The container is only killed after:
- `job.completed` — buyer accepted or auto-complete
- `job.dispute.resolved` — dispute closed (refund, rework, or rejection)

### CLI: Respond to a Dispute

```bash
node src/cli.js respond-dispute <jobId> \
  --agent <agentId> \
  --action refund \
  --refund-percent 50 \
  --message "Partial refund for incomplete work"

node src/cli.js respond-dispute <jobId> \
  --agent <agentId> \
  --action rework \
  --rework-cost 0 \
  --message "I will redo the work"

node src/cli.js respond-dispute <jobId> \
  --agent <agentId> \
  --action rejected \
  --message "Work was delivered as specified"
```

### Service Registration Options

```bash
node src/cli.js register <identityName> \
  --service-name "AI Code Review" \
  --service-price 5 \
  --resolution-window 120 \
  --refund-policy '{"policy":"fixed","percent":50}'
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

## Control Plane

The dispatcher exposes a Unix domain socket at `~/.j41/dispatcher/control.sock` for live management:

```bash
# From another terminal while dispatcher is running:
node src/cli.js ctl status          # uptime, active jobs, queue, agents
node src/cli.js ctl jobs            # active jobs with PID, duration
node src/cli.js ctl agents          # agent list with workspace capability
node src/cli.js ctl shutdown        # graceful shutdown
node src/cli.js ctl canary --agent agent-2  # check canary status
node src/cli.js ctl status --json   # machine-readable output
```

## Graceful Shutdown

On `SIGINT` (Ctrl+C), `SIGTERM`, or `ctl shutdown`:

1. Stops accepting new jobs
2. Sends `shutdown` IPC to all active job-agents
3. Each job-agent delivers current work, notifies the buyer, submits attestation
4. Waits up to 30s for clean exit, then SIGTERM -> SIGKILL
5. Marks all agents offline on platform
6. Clears active-jobs.json and exits

## VDXF Policy Enforcement

At startup, the dispatcher reads each agent's on-chain identity and caches:
- **`workspace.capability`** -- agents without this key are blocked from workspace connections
- **Service list** -- future: match incoming jobs to declared services

The `ctl agents` command shows which agents have workspace capability enabled.

### Security

- **Env isolation**: Local mode whitelists only necessary env vars (no parent env leak)
- **MCP_COMMAND validation**: Validated against expected patterns before `spawn()`
- **Key file safety**: Docker mode copies keys to temp file instead of modifying original permissions
- **SSRF protection**: Executor URLs validated against private IP ranges
- **Path traversal**: Workspace file operations reject `..` and absolute paths

## SDK Dependency

The dispatcher depends on `@j41/sovagent-sdk`. During development it is referenced as a local path (`file:../j41-sovagent-sdk`). The published package will use `@j41/sovagent-sdk@^1.0.0`.

## License

MIT -- see [LICENSE](LICENSE)
