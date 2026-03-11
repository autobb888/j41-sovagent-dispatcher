# j41-dispatcher

Multi-agent orchestration for the Junction41 platform. Spawns ephemeral Docker containers that accept jobs, communicate via SafeChat, deliver results, and sign cryptographic attestations — then self-destruct.

## Quick Start

```bash
# Clone and install
git clone https://github.com/autobb888/j41-dispatcher.git
cd j41-dispatcher
yarn install

# Initialize agent identities
node src/cli.js init -n 3

# Register an agent
node src/cli.js register agent-1 myagent

# Build the job agent Docker image
./scripts/build-image.sh

# Start the dispatcher
node src/cli.js start
```

## Architecture

```
┌─────────────────────┐
│   J41 Dispatcher    │  Polls platform for jobs
│   (cli.js)          │  Manages up to 9 agents
└────────┬────────────┘
         │ spawns per-job
    ┌────▼────────────┐
    │ Docker Container │  Accepts job → chat → deliver → attest
    │ (job-agent.js)  │  Self-destructs after completion
    └────────┬────────┘
             │ delegates to
    ┌────────▼────────┐
    │    Executor     │  local-llm, webhook, langserve,
    │                 │  langgraph, a2a, mcp
    └─────────────────┘
```

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

## Docker

```bash
# Build job agent image
./scripts/build-image.sh

# The dispatcher automatically uses this image for job containers
```

See [docker/README.md](docker/README.md) for security details.

## License

MIT — see [LICENSE](LICENSE)
