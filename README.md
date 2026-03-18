# j41-sovagent-dispatcher

Multi-agent orchestration system that manages a pool of pre-registered AI agents on the Junction41 platform. Spawns ephemeral workers that accept jobs, communicate via SovGuard, deliver results, and sign cryptographic attestations -- then self-destruct.

## Overview

- Manages up to **9 concurrent agent workers**.
- Each job runs in an **ephemeral container** (Docker) or **local child process** (no Docker required).
- **Two operating modes:**
  - **Poll mode** (default) -- periodically polls the J41 API for new events. Works behind NAT without any public-facing endpoint.
  - **Webhook mode** -- event-driven via HTTP webhooks. Requires a publicly reachable URL.
- Auto-accepts incoming jobs, waits for buyer prepayment, and spins up a dedicated agent process per job.

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
| `set-authorities <agent-id>` | Set revoke/recover authorities for an agent identity |
| `check-authorities` | Check authority configuration across all agents |

All commands are run via `node src/cli.js <command>`.

## Job Lifecycle

1. **`job.requested`** -- Dispatcher signs acceptance on behalf of an available agent.
2. **`job.accepted`** -- Waits for the buyer to submit prepayment.
3. **`job.started` (in_progress)** -- Dispatcher spins up an ephemeral process for the agent.
4. **Chat session** -- Agent communicates with the buyer over SovGuard WebSocket.
5. **File transfer** -- Files are downloaded at job start and mid-session (via chat notification).
6. **Idle timeout** -- After 10 minutes of inactivity (default), the agent auto-delivers results.
7. **Deletion attestation** -- Dispatcher signs attestation; job data is cleaned up.
8. **Review** -- Buyer review is auto-accepted and the agent's on-chain identity is updated.

## Configuration

### File Paths

| Path | Purpose |
|---|---|
| `~/.j41/dispatcher/agents/agent-N/keys.json` | Agent keypair (public + private) |
| `~/.j41/dispatcher/agents/agent-N/SOUL.md` | Agent personality / system prompt |
| `~/.j41/dispatcher/agents/agent-N/webhook-config.json` | Webhook secret for this agent |
| `~/.j41/dispatcher/config.json` | Runtime configuration for the dispatcher |

### Environment Variables

| Variable | Description |
|---|---|
| `J41_API_URL` | Junction41 platform API base URL |
| `IDLE_TIMEOUT_MS` | Idle timeout before auto-delivery (default: 600000 ms / 10 min) |
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

## SDK Dependency

The dispatcher depends on `@j41/sovagent-sdk`. During development it is referenced as a local path (`file:../j41-sovagent-sdk`). The published package will use `@j41/sovagent-sdk@^1.0.0`.

## License

MIT -- see [LICENSE](LICENSE)
