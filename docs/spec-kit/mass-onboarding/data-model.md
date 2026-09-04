# Data model — doctor results and identity stages

Single source of truth: `src/doctor.js` (to be created). CLI table, `--json`,
and TUI header/Doctor/Status are renderers of this document. No second
classifier.

---

## 1. `DoctorReport`

Returned by `runDoctor(opts) → Promise<DoctorReport>`. Pure enough to unit-test
with injected `execSync`, `fetch`, `fs`, `os`, `now`, `homedir`.

```ts
type Status = 'pass' | 'fail' | 'warn' | 'skip';

interface DoctorReport {
  /** false if any check.status === 'fail'. warn/skip do not flip this. */
  ok: boolean;
  generatedAt: string;          // ISO-8601
  version: string;              // dispatcher package version running this doctor
  os: OsInfo;
  checks: DoctorCheck[];
  identities: IdentityRow[];
  /** First failing check's nextCommand, else first warn, else labour next step. */
  nextCommand: string | null;
  /** OS-specific copy-paste for the first failure; never contains secrets. */
  copyPasteBlock: string | null;
  gpuOffered: boolean;          // true only on linux + nvidia-detectable host
}
```

### 1.1 `OsInfo`

```ts
interface OsInfo {
  platform: 'linux' | 'darwin' | 'win32';
  arch: 'x64' | 'arm64' | string;
  /** linux: /etc/os-release ID; darwin: 'macos'; win32: 'windows' | 'wsl2' */
  distro: string;
  /** Human version: '24.04' | '14.6' | '10.0.22631' */
  osVersion: string | null;
  /** Darwin kernel major ≥ 23 (macOS 14+) or linux, or win32+WSL2 Docker Desktop. */
  supported: boolean;
  /** Darwin 22 / macOS 13.x → false. doctor check `os` is fail. */
  macOSMajor: number | null;
  wsl: boolean;                 // true inside WSL even when platform is linux
  dockerDesktopWSL2: boolean | null; // win32/darwin probe; null on bare linux
}
```

Unsupported → `os.supported = false` and check `id: "os"` status `fail`.
Do not invent extra platforms. Unknown `process.platform` is `fail`.

WSL detection: `process.env.WSL_DISTRO_NAME` or `/proc/version` contains
`microsoft`. Inside WSL, `platform` is `linux` and `wsl: true` — treat Docker
as the Linux sock, not the Windows named pipe.

### 1.2 `DoctorCheck`

```ts
interface DoctorCheck {
  id: CheckId;
  name: string;                 // column 1 of the CLI table
  status: Status;
  /** Human, one line, no secrets. */
  detail: string;
  /** Exact next command for THIS check, or null if pass/skip. */
  nextCommand: string | null;
  /** Multi-line copy-paste (newgrp, timedatectl, Docker Desktop URL). */
  copyPasteBlock: string | null;
}
```

`skip` is reserved for checks that do not apply on this OS (GPU on
darwin/win32, AppArmor on non-linux). `skip` is not a failure and is hidden
from the TUI labour header (shown only on a Doctor detail screen under
“GPU chapter — Linux NVIDIA”).

### 1.3 Check IDs (stable contract)

| id | fail when | skip when |
|----|-----------|-----------|
| `os` | macOS ≤13, win32 without Docker Desktop WSL2, unknown platform | — |
| `node` | major < 20 | — |
| `package` | unscoped 2.0.0 on PATH, or no `j41-dispatcher` | — |
| `docker.cli` | `docker` binary missing | — |
| `docker.daemon` | `docker info` fails for reasons other than sock perms | — |
| `docker.sock` | ENOENT on expected sock / pipe | — |
| `docker.group` | EACCES; `id -nG` lacks `docker` | non-linux |
| `image.job-agent` | `j41/job-agent:latest` missing | docker.daemon fail |
| `image.gpu-jail` | missing **and** linux+nvidia | darwin, win32, or no nvidia |
| `clock` | \|local − Date header\| > 30s | API unreachable (then `warn`) |
| `runtime` | `config.json` runtime is `local` | — |
| `llm` | no provider + no key (warn, not fail) | — |
| `identity` | zero local agents (warn); all local-only (warn) | — |
| `fee-tank` | any `empty-*`; `low` is warn | no on-chain agents |
| `gpu.nvidia` | linux and no nvidia runtime **if** compute configured | darwin, win32, labour-only |
| `gpu.storage` | linux compute configured and `!supportsStorageOpt` | darwin, win32, labour-only |

`package` fail text MUST name `@junction41/dispatcher` and MUST NOT leave the
operator on `npm i -g j41-dispatcher` if that still resolves 2.0.0. After the
alias ships, `package` pass requires version ≥ 2.36.0 (or current `latest`).

`runtime` fail `nextCommand` is `j41-dispatcher config --runtime docker` plus
the Docker install block. Never `config --runtime local`.

`clock` compares `Date.parse(response.headers.get('date'))` from
`cfg.platform.api_url` (default `https://api.junction41.io`) against `Date.now()`.
Threshold: **30 seconds**. Verus signed-window is ~300s; 30s is the doctor
fail so NTP is fixed before signatures start failing. WSL extra
`copyPasteBlock`: `sudo hwclock -s` and, from Windows, `wsl --shutdown`.

`fee-tank` uses `src/wallet.js` `buildWalletRow` statuses:

| writes / sats | status | doctor |
|---------------|--------|--------|
| `feeSats <= 0` and sweepable | `empty-sweepable` | fail, next: `wallet sweep <id>` |
| `feeSats <= 0` and nothing to sweep | `empty-unfunded` | fail, next: external fund (no faucet) |
| `0 < writes < 100` | `low` | warn. **Not EMPTY.** 32 writes is low. |
| `writes >= 100` | `ok` | pass |

Floor constant is `DEFAULT_FLOOR_WRITES = 100` (`src/fee-tank.js:39`). Do not
hardcode a second floor in doctor.

### 1.4 Secrets

Forbidden in every string field: WIF, `keys.json` contents, `[provider_keys]`
values, npm tokens, `J41_KEYS_PASSPHRASE`, `RENTAL_SECRETS_KEY`,
`~/.j41/dispatcher/control.token`. `llm` may say `configured` / `missing`.
JSON output is the same document — `--json` is not a leak hatch.

---

## 2. Identity row (local vs on-chain vs finalized)

```ts
type IdentityStage =
  | 'local-only'     // keys.json, no identity name
  | 'pending'        // identity name, no iAddress, or registrationStatus=timeout
  | 'on-chain'       // identity + iAddress
  | 'finalized'      // finalize-state.json stage === 'ready'
  | 'platform-ready'; // start() would put this agent in readyAgents

interface IdentityRow {
  id: string;                   // folder name, e.g. agent-1
  kind: 'agent' | 'compute' | 'data' | 'model';
  stage: IdentityStage;
  identity: string | null;      // name.agentplatform@ — public, not a secret
  iAddress: string | null;
  local: boolean;               // keys.json exists
  onChain: boolean;             // identity + iAddress
  finalized: boolean;           // stage ready
  platformReady: boolean;       // best-effort; false if API down (warn, not fail)
  feeTank: 'ok' | 'low' | 'empty-sweepable' | 'empty-unfunded' | 'unregistered' | null;
}
```

Mapping from files (no new state files):

| Field | Source |
|-------|--------|
| `local` | `~/.j41/dispatcher/agents/<id>/keys.json` exists |
| `identity` | `keys.identity` |
| `iAddress` | `keys.iAddress` |
| `onChain` | both set AND `registrationStatus !== 'timeout'` |
| `finalized` | `finalize-state.json` `stage === 'ready'` (corrupt file → not finalized, warn) |
| `kind` | `parseListingKind(keys.kind)` or `kindFromIdentityName` else `'agent'` |
| `platformReady` | optional live probe; doctor must still work offline |

**Language rules** (CLI, TUI, JSON `name` fields):

- “local” = folder with keys. Never “registered”.
- “on-chain” / “registered on-chain” = `onChain === true`.
- “finalized” = `finalized === true`.
- “ready” / “listed” = `platformReady === true`.

`listRegisteredAgents()` stays as a low-level directory helper (renaming it is
Wave 2 optional). Every user-visible string that currently says
`${n} registered` for that list **MUST** change. Suggested header:

```
Agents: 1 ready, 1 on-chain (not finalized), 3 local-only
```

Zero agents is a **warn** with `nextCommand`:
`j41-dispatcher setup agent-1 <name> --template code-review`
— not `init -n 9`.

---

## 3. `nextCommand` / `copyPasteBlock` selection

Deterministic:

1. If any `fail`, take the first fail in check-id order (table above).
2. Else if any `warn` that blocks first useful work (`llm`, `identity`,
   `image.job-agent` as warn-after-partial), take the first of those.
3. Else labour next step: `j41-dispatcher start` if a platform-ready labour
   agent exists, else `setup`, else `build-image`.

`copyPasteBlock` is OS-switched inside the check, not a second matrix in the
TUI. Examples:

- `docker.group` linux: `newgrp docker` then retry `j41-dispatcher doctor`
- `clock` linux/WSL: `sudo timedatectl set-ntp true`
- `clock` darwin: “set Date & Time to automatic in System Settings”
- `os` macOS ≤13: “macOS 14+ (Sonoma) and Docker Desktop are required”
- `package` 2.0.0: `yarn global add @junction41/dispatcher` (never the unscoped
  name until alias ≥ 2.36.0 is proven)

---

## 4. Persistence

Doctor does **not** write `config.json` or `config.toml`. It is read-only
aside from optional cache of the last report at
`~/.j41/dispatcher/doctor-last.json` (mode 0600, no secrets — same schema).
TUI may show “last doctor: 3m ago” from that file. Cache is advisory; Start
re-runs the live classifier.

Do not persist `runtime: local`. The only writer of runtime in first-run is
the installer (always `docker`) or an explicit `j41-dispatcher config
--runtime`.
