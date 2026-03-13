# j41-dispatcher

Multi-agent orchestration for the Junction41 platform. Spawns ephemeral workers that accept jobs, communicate via SafeChat, deliver results, and sign cryptographic attestations — then self-destruct.

Supports two runtime modes:

- **Docker** — each job runs in an isolated container (production default)
- **Local** — each job runs as a child process, no Docker required (development / lightweight hosts)

## Quick Start

```bash
# Clone and install (one-shot — installs Node.js, yarn, detects Docker)
git clone https://github.com/autobb888/j41-dispatcher.git
cd j41-dispatcher
./setup.sh

# Initialize agent identities
node src/cli.js init -n 3

# Register an agent
node src/cli.js register agent-1 myagent

# Start the dispatcher
node src/cli.js start
```

`setup.sh` handles everything: installs Node.js and yarn if missing, runs `yarn install`, detects whether Docker is available, and prompts you to choose a runtime mode (`docker` or `local`). No manual dependency management needed.

## Architecture

```
┌─────────────────────┐
│   J41 Dispatcher    │  Polls platform for jobs
│   (cli.js)          │  Manages up to 9 agents
└────────┬────────────┘
         │ spawns per-job
         │
    ┌────▼────────────────────────────────────────┐
    │  Runtime: Docker          OR   Local         │
    │  ┌───────────────────┐   ┌────────────────┐ │
    │  │ Docker Container  │   │ Child Process  │ │
    │  │ (job-agent.js)    │   │ (job-agent.js) │ │
    │  │ Full isolation    │   │ No Docker req. │ │
    │  └────────┬──────────┘   └───────┬────────┘ │
    └───────────┼──────────────────────┼──────────┘
                │ delegates to         │
           ┌────▼──────────────────────▼────┐
           │          Executor              │
           │  local-llm, webhook, langserve,│
           │  langgraph, a2a, mcp           │
           └────────────────────────────────┘
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `./setup.sh` | One-shot setup — installs deps, detects Docker, picks runtime |
| `node src/cli.js config` | View current runtime mode |
| `node src/cli.js config --runtime docker\|local` | Switch runtime mode |
| `node src/cli.js init -n N` | Generate N agent identities (max 9) |
| `node src/cli.js register agent-1 myagent` | Register an agent with the platform |
| `node src/cli.js start` | Start the dispatcher |
| `node src/cli.js status` | Show agent and job status |
| `node src/cli.js privacy` | Show privacy attestation info |

## Runtime Modes

### Docker (default when Docker is available)

Each job runs inside an ephemeral container built from `docker/Dockerfile`. Provides full process and filesystem isolation.

```bash
# Build the job agent image (only needed for Docker mode)
./scripts/build-image.sh

# Switch to Docker mode
node src/cli.js config --runtime docker
```

### Local (no Docker needed)

Each job runs as a Node.js child process on the host. Useful for development, CI, or hosts where Docker is unavailable.

```bash
# Switch to local mode
node src/cli.js config --runtime local
```

No image build step required — the dispatcher forks `job-agent.js` directly.

## Executor Types

| Type | Description | Use Case |
|------|-------------|----------|
| `local-llm` | Direct LLM API calls | Simple Q&A agents |
| `webhook` | POST to REST endpoint | n8n, custom backends |
| `langserve` | LangChain Runnables | Stateless chains |
| `langgraph` | LangGraph Platform | Stateful agents |
| `a2a` | Google A2A protocol | Inter-agent communication |
| `mcp` | Model Context Protocol | Tool-using agents |

## Configuration

Copy `.env.example` to `.env` and set your API keys. Per-agent configuration goes in `~/.j41/dispatcher/agents/agent-N/agent-config.json`.

## SDK Dependency

The dispatcher depends on `@j41/sovagent-sdk`. During development it is referenced as a local path (`file:../j41-sovagent-sdk`). The published package will use `@j41/sovagent-sdk@^1.0.0`.

## License

MIT — see [LICENSE](LICENSE)
