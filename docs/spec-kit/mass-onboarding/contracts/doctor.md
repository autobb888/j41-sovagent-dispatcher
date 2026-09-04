# Contract — `j41-dispatcher doctor`

CLI table and `--json` are two renderers of `DoctorReport` (`data-model.md`).
The TUI MUST call `runDoctor()` from `src/doctor.js` and MUST NOT reimplement
checks.

Command (Wave 2):

```
j41-dispatcher doctor
j41-dispatcher doctor --json
j41-dispatcher doctor --json --pretty   # optional, same schema
```

Exit codes:

| code | meaning |
|------|---------|
| 0 | `ok === true` (warn/skip allowed) |
| 1 | any `fail`, or doctor itself crashed fail-closed |
| 2 | `--json` requested but stdout would contain a secret (must not happen; if a check would leak, omit the field and fail) |

`--json` writes only to stdout. Human table writes to stdout. Diagnostics that
are not the document go to stderr.

---

## Human table

```
j41-dispatcher doctor

  OS                 darwin 14.6 (arm64)  supported
  Node.js            v22.11.0
  Package            @junction41/dispatcher 2.36.0
  Docker CLI         Docker version 27.x
  Docker daemon      running  (~/.docker/run/docker.sock)
  Docker group       n/a (darwin)
  Job image          j41/job-agent:latest  missing
  Clock              ok  (skew 0.4s)
  Runtime            docker
  LLM                not configured
  Identities         0 local
  Fee tank           n/a
  GPU                skipped (linux NVIDIA chapter)

  ✗ image.job-agent  j41/job-agent:latest is not built
  ⚠ llm              no provider key — labour jobs will be refused at accept
  ⚠ identity         no local agents

Next:
  j41-dispatcher build-image

Copy-paste:
  j41-dispatcher build-image
```

Rules:

- One row per check that is not `skip`, plus a GPU skip summary line on
  darwin/win32 so operators do not go hunting for NVIDIA.
- Icons: `✓` pass, `⚠` warn, `✗` fail. No color-only signal (color is extra).
- Column 1 is `name` (padded), column 2 is `detail`.
- After the table: failed/warned checks restated with `id`, then a single
  `Next:` line (`nextCommand`) and optional `Copy-paste:` block.
- Never print a WIF, API key, or token. `LLM  configured (groq)` is allowed;
  `LLM  gsk_...` is not.
- Do not say “N registered” for local folders. Use identity-stage language
  from `data-model.md`.

JSON mode: no table, no icons, stdout = one JSON document.

---

## JSON schema (`--json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "j41-dispatcher-doctor-report",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "ok", "generatedAt", "version", "os", "checks",
    "identities", "nextCommand", "copyPasteBlock", "gpuOffered"
  ],
  "properties": {
    "ok": { "type": "boolean" },
    "generatedAt": { "type": "string", "format": "date-time" },
    "version": { "type": "string" },
    "os": {
      "type": "object",
      "additionalProperties": false,
      "required": ["platform", "arch", "distro", "osVersion", "supported", "macOSMajor", "wsl", "dockerDesktopWSL2"],
      "properties": {
        "platform": { "enum": ["linux", "darwin", "win32"] },
        "arch": { "type": "string" },
        "distro": { "type": "string" },
        "osVersion": { "type": ["string", "null"] },
        "supported": { "type": "boolean" },
        "macOSMajor": { "type": ["integer", "null"] },
        "wsl": { "type": "boolean" },
        "dockerDesktopWSL2": { "type": ["boolean", "null"] }
      }
    },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "name", "status", "detail", "nextCommand", "copyPasteBlock"],
        "properties": {
          "id": {
            "enum": [
              "os", "node", "package",
              "docker.cli", "docker.daemon", "docker.sock", "docker.group",
              "image.job-agent", "image.gpu-jail",
              "clock", "runtime", "llm", "identity", "fee-tank",
              "gpu.nvidia", "gpu.storage"
            ]
          },
          "name": { "type": "string" },
          "status": { "enum": ["pass", "fail", "warn", "skip"] },
          "detail": { "type": "string", "maxLength": 400 },
          "nextCommand": { "type": ["string", "null"] },
          "copyPasteBlock": { "type": ["string", "null"] }
        }
      }
    },
    "identities": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id", "kind", "stage", "identity", "iAddress",
          "local", "onChain", "finalized", "platformReady", "feeTank"
        ],
        "properties": {
          "id": { "type": "string" },
          "kind": { "enum": ["agent", "compute", "data", "model"] },
          "stage": {
            "enum": ["local-only", "pending", "on-chain", "finalized", "platform-ready"]
          },
          "identity": { "type": ["string", "null"] },
          "iAddress": { "type": ["string", "null"] },
          "local": { "type": "boolean" },
          "onChain": { "type": "boolean" },
          "finalized": { "type": "boolean" },
          "platformReady": { "type": "boolean" },
          "feeTank": {
            "type": ["string", "null"],
            "enum": ["ok", "low", "empty-sweepable", "empty-unfunded", "unregistered", null]
          }
        }
      }
    },
    "nextCommand": { "type": ["string", "null"] },
    "copyPasteBlock": { "type": ["string", "null"] },
    "gpuOffered": { "type": "boolean" }
  }
}
```

TUI consumption:

- Header agent line ← `identities` aggregated, not `getAgents().length`.
- Header runtime line ← check `runtime` (if fail, red, Start disabled).
- Header LLM line ← check `llm`.
- Status & Health “Doctor” section ← same `checks` array, same icons.
- Start enabled only when `ok === true` OR the only fails are not start-blockers
  (none: `ok` is the start gate). TUI Start still cannot pass `--dev-unsafe`.
- Kind picker hides `compute` when `gpuOffered === false`.
- Copy-paste widget (if any) uses `copyPasteBlock`, not ad-hoc strings.

`ctl` / control API: out of Wave 2 unless a follow-up adds `GET /v1/doctor`.
Do not block mass-onboarding on that.

---

## Classification fixtures (must have unit tests)

These are contract tests, not snapshots of prose.

| fixture | expected |
|---------|----------|
| Ubuntu 24.04, node 18.19.1 | `node` fail, `ok` false |
| PATH `j41-dispatcher` reports 2.0.0 | `package` fail, nextCommand scoped yarn add |
| Darwin 22 (macOS 13) | `os` fail, `gpuOffered` false, compute hidden |
| Darwin 23+ , Docker Desktop sock exists | `os` pass, `docker.sock` pass, `gpu.*` skip |
| win32, Docker Desktop Hyper-V (not WSL2) | `os` fail |
| win32, Docker Desktop WSL2 | `os` pass if daemon reachable |
| `docker.listContainers` EACCES | `docker.group` fail, nextCommand `newgrp docker`, NEVER `config --runtime local` |
| `new Docker()` ENOENT on Mac default sock, Desktop sock present | `docker.sock` must probe `~/.docker/run/docker.sock` and pass |
| `config.json` `runtime: local` | `runtime` fail, nextCommand `config --runtime docker` |
| clock skew 65 min | `clock` fail, NTP copy-paste (WSL adds `hwclock`) |
| wallet row 32 writes | `fee-tank` **warn** `low`, detail MUST NOT contain `EMPTY` |
| wallet row 0 feeSats, sweepable > 0 | `fee-tank` fail `empty-sweepable` |
| 5 local keys.json, 0 iAddress | identities all `local-only`; header MUST NOT say `5 registered` |
| linux, docker driver `overlayfs` | `gpu.storage` fail if compute configured; labour `gpuOffered` may still be false |
| darwin doctor JSON | no `gpu.nvidia`/`gpu.storage` as fail; both `skip` |

Injected deps: do not require a live daemon in unit tests. One integration test
in Wave 5 hits a real Docker Desktop / Engine.

---

## CLI wiring

Add in `src/cli.js` next to `status`:

```
program
  .command('doctor')
  .description('Diagnose this machine for dispatcher mass-use (Node, Docker, clock, identity)')
  .option('--json', 'Print DoctorReport JSON')
  .action(...)
```

Implementation: `const { runDoctor, formatDoctorTable } = require('./doctor');`

`status` keeps its live-job counts but **MUST** stop saying
`Agents: ${agents.length} registered`. It should print the identity summary
from `runDoctor()` (or a cheaper `classifyIdentities()` exported by the same
module) plus existing active-job info.

`getActiveJobs` Docker error copy is part of this contract: replace both
`config --runtime local` lines (`src/cli.js:1258` and `1267`) with the
ENOENT/EACCES/daemon classifiers from `doctor`. Same strings as the table.
