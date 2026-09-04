# mass-onboarding — claims checklist

Domain: **the path a stock user on Ubuntu/Debian/Fedora/RHEL, macOS 14+, or
Windows 10/11+WSL2 walks to a running labour dispatcher** — install, Node,
Docker, `doctor`, dashboard, `setup`, first `start`. GPU Cat-1 is in scope only
as a host chapter that must stay fail-closed (Linux NVIDIA + disk quota).

A claim is anything an operator would act on: a documented command, a default,
a "refuses to", a platform matrix, a proposed installer behaviour.

Sources enumerated for this domain:

- `README.md` — Install (27-31), Quick Start / Before you begin (33-67),
  Runtime Modes + Local Mode (593-617, 1114-1121), First-Run Security Setup
  (1066-1078), Friend boot / Storage (831-909).
- `CLAUDE.md` — Quick Reference (`yarn global add`, `build-image`, `setup`,
  `start`), "The job image is a hard prerequisite."
- `package.json` — name, bin, `files`, `engines`, `repository`.
- Operator-facing strings: `scripts/install.sh`, `setup.sh`, `src/cli.js`
  (`config`, `quickstart`, `init`, `build-image`, `start` local-mode gate,
  docker errors, `getActiveJobs`), `src/dashboard.js` (header, Start, logs,
  fee-tank EMPTY), `src/docker-host.js`, `src/mainnet-guard.js`,
  `src/config.js`, `j41-secure-setup/lib/detect-platform.js` + `lib/index.js`
  + `lib/quick-check.js`.
- The **proposed mass-use plan** (installer-first + npm alias; Node 22 via nvm
  or official tarball to `~/.local`; never silent `runtime=local`; doctor + TUI
  share `src/doctor.js`; GPU quota script Linux-only documented sudo).

**first-run (2026-08-10) is DONE.** F1–F12 are not re-opened. Rows that rest on
them are marked *(prior F#)* with current-code status restated.

**70 claims — 28 VERIFIED · 24 DRIFT · 14 MISSING · 4 UNVERIFIED.**
11 rows are *(prior)*.

Status key: **VERIFIED** (code does what is claimed) · **DRIFT** (code differs
— how is stated) · **MISSING** (no implementation found) · **UNVERIFIED**.

---

## A. Documented install (what README/CLAUDE.md tell a newcomer today)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| A1 | `yarn global add @junction41/dispatcher` installs the current dispatcher | README:29-31, CLAUDE.md:9 | **VERIFIED** | `package.json:2,6-8` — name `@junction41/dispatcher` @ `2.36.0`, bin `j41-dispatcher` → `src/cli.js`. Live npm `latest` is this package (operator note 2026-09-02). |
| A2 | The published tarball contains `scripts/`, `Dockerfile.job-agent`, `Dockerfile.gpu-jail`, `package.docker.json` so `build-image` works after a global add | README:38-41; CLAUDE.md:200-203 | **VERIFIED** *(prior D1, now fixed)* | `package.json:9-18` `files` now includes all four. D1's "documented install cannot build the image" is no longer true of the allowlist. |
| A3 | `engines.node >= 20.0.0` | `package.json:61-63` | **VERIFIED**, advisory only | npm/yarn warn; nothing in `src/cli.js` reads `process.version` before running. Ubuntu 24.04 `apt nodejs` is 18. → **MO5**. Isolation **I11** is the silent-ESM half of the same door. |
| A4 | Node 20+ and Docker are required; there is no mode that works without Docker | README:37 | **VERIFIED** as the *runtime* contract | `start` refuses `runtime=local` without `--dev-unsafe` (`cli.js:4320-4330`) and refuses without the job image (`cli.js:4347-4356`). The *installers* still persist `runtime=local` when Docker is absent — *(prior F7, installer half live)*. |
| A5 | `j41-dispatcher build-image` is the image-build command; do not tell a global-add user to run `./scripts/build-image.sh` | README:40, 608; CLAUDE.md:200-203 | **VERIFIED** as a CLI | `cli.js:4122-4166` resolves `scripts/build-image.sh` from `__dirname`. Implementation is still `spawn('bash', [script])` (`cli.js:4106`) → **MO8**. |
| A6 | `start` refuses without the job-agent image rather than failing after a buyer has paid | README:38; CLAUDE.md:200-201 | **VERIFIED** *(prior F8, now fixed)* | `cli.js:4347-4356`. Misdiagnosis when the failure is EACCES, not a missing image → **MO2**. |
| A7 | A fresh install needs no `J41_*` env vars; every security default is already the strict one | README:56 | **VERIFIED** | `config-loader.js` DEFAULTS; mainnet gate `src/mainnet-guard.js:27-73`. First-run *setup completing* is F4/F5, not the defaults. |
| A8 | Recommended first-agent path is `setup <id> <name> --template <tpl>`, not `init -n 9` | README:58 | **DRIFT** vs the installers | README is correct. `install.sh:217` and `setup.sh:124` still print / run `init -n 9`. Plan says do not default this. |
| A9 | Junction41 seeds a newly registered agent's fee address with 0.0033 VRSCTEST; the operator does not need coins first | README:42-45 | **VERIFIED** as copy | `cli.js:233-242` `printFundingInstructions(..., { seeded: true })`; `setup` no longer pauses for funds (`cli.js:3601-3609`). F1's throw-on-empty-UTXO is still in `publishVdxf` (`cli.js:1185-1206`) for the seed-not-yet-confirmed case — *(prior F1, fail-closed half fixed)*. |
| A10 | `j41-dispatcher dashboard` / `setup` / `start` exist as written | README:61-66 | **VERIFIED** | `cli.js:4060-4063`, `3478`, `4170`. |
| A11 | The package `repository` URL is the live git remote | `package.json:29-32` | **VERIFIED** | `git+https://github.com/autobb888/j41-sovagent-dispatcher.git`. `install.sh:14` still clones `github.com/junction41/j41-sovagent-dispatcher` → **MO1**. |
| A12 | Unscoped `j41-dispatcher` is not the install | implied by README:29-31 | **DRIFT** (live trap, not a code bug) | Live test 2026-09-02..04: `npm i -g j41-dispatcher` installs frozen `j41-dispatcher@2.0.0` (deprecated 2026-04-08). Plan's alias is the proposed safety net. |

---

## B. Proposed installer (`curl\|bash install.sh` / `install.ps1`)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| B1 | `curl -fsSL …/install.sh \| bash` is a supported one-line install (Linux/Mac) | `install.sh:3-4`; proposed plan | **DRIFT** | The file exists and ships in the npm tarball (`package.json:12` `scripts`). It cannot complete: clone URL 404s, tarball is `v${J41_VERSION}` with `J41_VERSION=latest` (`install.sh:12-14,147-152`). → **MO1**. README does not mention it. |
| B2 | `install.ps1` exists for Windows (`irm \| iex`) | proposed plan | **MISSING** | No `install.ps1` (or any `.ps1`) under the dispatcher tree. |
| B3 | Installer never writes `runtime=local` unless explicit `--dev-unsafe` | proposed plan | **DRIFT** *(prior F7, installer half)* | `install.sh:98-100` (non-interactive / piped stdin → local, no prompt); `install.sh:106-107` (interactive default choice `2` = local); `setup.sh:94-96` same silent default. Writes `~/.j41/dispatcher/config.json` (`install.sh:169-173`) overwriting any previous object. `start` now refuses that state (`cli.js:4320-4330`) — the *accept-then-refuse* half of F7 is fixed. |
| B4 | Installer does not `init -n 9` | proposed plan; README:58 | **DRIFT** | `install.sh:217` prints `j41-dispatcher init -n 9` as step 1. `setup.sh:124` actually runs it and then greps WIFs out of `keys.json` (`setup.sh:130-135`) to print addresses. |
| B5 | Node 22 is installed via nvm or official tarball to `~/.local`; never `apt nodejs` | proposed plan | **DRIFT** | `install.sh:31-47` tries nvm, then **does** `curl …/setup_22.x \| sudo -E bash -` + `apt-get install nodejs` / `dnf`. No official tarball-to-`~/.local` path. nvm installer is version-pinned (`v0.39.7`) but not checksummed → **MO9**. |
| B6 | `npm i -g @junction41/dispatcher` uses a user prefix | proposed plan | **MISSING** | `install.sh` clones a git tree and `yarn install`s in `~/.j41/dispatcher`, then `ln -sf …/src/cli.js ~/.local/bin/j41-dispatcher` (`install.sh:193-201`). No `npm i -g`, no prefix config. |
| B7 | Code is not installed into the runtime data directory | implied; *(prior F11)* | **DRIFT** *(prior F11, containment gone)* | `INSTALL_DIR="${HOME}/.j41/dispatcher"` (`install.sh:13`) is `AGENTS_DIR` / `config.toml` / `dispatcher.pid` (`config.js:9-10`). `package.json:12` now ships `scripts/`, so F11's "not in the tarball" containment is gone. |
| B8 | Installer refuses to run as root | proposed plan (user vs sudo) | **MISSING** | No `EUID` / `id -u` check. `curl \| sudo bash` writes `/root/.j41` and root's shell rc (`install.sh:199-201`). Isolation **I12** is the runtime half. |
| B9 | Installer does not hide that `docker` group is root-equivalent | proposed plan | **DRIFT** | `install.sh:114-117` runs `curl get.docker.com \| sh` then `sudo usermod -aG docker "$USER"` and prints only "log out and back in for Docker group permissions". No "this is root-equivalent via `docker.sock`" warning. |
| B10 | Node/nvm/Docker payloads are URL-pinned and checksummed | proposed plan | **MISSING** | nvm URL is version-pinned, not hashed (`install.sh:36`). NodeSource, `get.docker.com`, GitHub clone/tarball: no `sha256sum`. `J41_VERSION=latest` cannot be a GitHub release tag (`install.sh:12,149`). |
| B11 | Installer writes only `~/.j41` config/PATH it documents, and does not rewrite `daemon.json` | proposed plan | **VERIFIED** as current (no daemon.json) / **DRIFT** as PATH | `install.sh:169-173` writes `config.json` `{runtime}` only (destructive overwrite of other keys). `install.sh:198-201` appends `PATH` to `.zshrc` if present else `.bashrc`, with no idempotency guard. No `daemon.json` rewrite in current scripts — GPU quota script is plan-only (group H). |
| B12 | `setup.sh` is not a mass-use path | README does not mention it | **VERIFIED** as undocumented | Repo-root `setup.sh` is **not** in `package.json` `files`. Same silent-local + `init -n 9` defects as `install.sh`. |

---

## C. Node, PATH, npm alias

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| C1 | CLI refuses to run on Node < 20 | `package.json:61-63`; README:37 | **MISSING** | No `process.version` gate in `src/cli.js`. `control.js:324` stamps the version on `/health` after start. → **MO5**. |
| C2 | Republished unscoped `j41-dispatcher` is an alias of `@junction41/dispatcher` @ current | proposed plan | **MISSING** | Live: unscoped `@2.0.0` only. No alias publish in this repo. |
| C3 | `j41-dispatcher` bin cannot be taken by a stale or malicious unscoped package once the operator has the scoped install | proposed plan | **UNVERIFIED** (npm-registry behaviour) / **DRIFT** today | Today `npm i -g j41-dispatcher` after the scoped install can overwrite the same bin name on a writable prefix (live trap). After an alias publish, takeover requires losing the npm account. Out of scope for token handling; noted in the plan threat model. |
| C4 | `yarn global add` needs a writable prefix and Node ≥ 20 | implied by A1 | **VERIFIED** as a prerequisite, not enforced | No installer creates the prefix. Ubuntu stock Node 18 + apt yarn is the live failure the plan exists to fix. |

---

## D. Docker detection, local mode, `start` gate

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| D1 | Local mode is blocked by default; requires `--dev-unsafe` | README:1114-1120 | **VERIFIED** at start | `cli.js:4174`, `4311-4330` (refuse-before-accept), `11140-11154` (second gate inside `startJobLocal`), 30s warning timer `cli.js:4386-4392`. |
| D2 | `--dev-unsafe` is refused on mainnet | README:1042; `mainnet-guard.js` | **VERIFIED** | `mainnet-guard.js:33`; `cli.js:4193-4215` with `devUnsafe: !!options.devUnsafe`. |
| D3 | Dashboard Start cannot pass `--dev-unsafe` | proposed plan; F7 follow-up comment | **VERIFIED** (by design) | `dashboard.js:3904-3906` spawns `[process.argv[1], 'start']` with no extra args. On local runtime the button diagnoses this (`dashboard.js:3926-3936`). |
| D4 | Docker detect distinguishes ENOENT (not installed) from EACCES (installed, no permission) | proposed plan | **MISSING** → **MO2** | `install.sh:79-90`: `command -v docker` then `docker info`; any failure → `DOCKER_AVAILABLE=false`. `jobImageExists` (`cli.js:4073-4080`) catch-all → "image is not built". `getActiveJobs` (`cli.js:1256-1268`) one message for missing dockerode *and* daemon errors. `startJobContainer` (`cli.js:10611-10614`) same. |
| D5 | Docker errors never recommend `config --runtime local` as a production fix | proposed plan; README:37 | **DRIFT** | `cli.js:1258, 1267` print `Install Docker or switch to local mode: j41-dispatcher config --runtime local`. `config --runtime local` (`cli.js:1293-1299`) accepts with no warning that `start` will then exit 1. |
| D6 | `getRuntime()` defaults to `docker` when no config exists | `config.js:16-17,41-42` | **VERIFIED** | DEFAULTS `runtime: 'docker'`. Installers are what persist `local`. Dead `showSystemSettings` (`cli.js:12270, 12284`) still displays/defaults `'local'` — unreachable from the TUI menu (docs-truth D7). |
| D7 | `quickstart` runtime answer is validated | — | **DRIFT** *(prior F12)* | `cli.js:1468, 1483-1485` still free-text; anything but exact `'local'` means docker at the `=== 'local'` tests. Default prompt is now `'docker'` (safer than F12's era). |

---

## E. `build-image`

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| E1 | `build-image` builds job-agent **and** `j41/gpu-jail` | README:38-40, 838; CLAUDE.md:12 | **VERIFIED** | `cli.js:4138-4165`. Skip-if-exists unless `--force`. |
| E2 | `build-image` is implemented in Node, not bash | proposed plan | **DRIFT** → **MO8** | `cli.js:4104-4118` `spawn('bash', [script])`. Scripts themselves are bash (`scripts/build-image.sh:1`, `build-jail-image.sh`). Windows without Git Bash/`bash.exe` cannot run the documented command. |
| E3 | Missing Docker is reported as Docker-missing, not as a generic script failure | proposed plan | **DRIFT** | `build-image.sh:24-27` does `command -v docker` (ENOENT of the binary only). Permission / daemon-down fall through to `docker build` and surface as `cli.js:4147-4149` "Docker must be installed and running, and your user able to reach it." — closer than `jobImageExists`, still no EACCES vs ENOENT. |
| E4 | Image presence is checked with `docker image inspect`, never a throw | `cli.js:4072` | **VERIFIED** as never-throw | And that is why EACCES becomes "not built" → **MO2**. |

---

## F. doctor, TUI honesty, logs, fee tank

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| F1 | `j41-dispatcher doctor` exists and shares implementation with the TUI | proposed plan | **MISSING** | No `doctor` command in `cli.js` `.command(` list. No `src/doctor.js`. Jailbox's `src/doctor.ts` is a different product. |
| F2 | doctor / status must not print secrets (WIF, passphrase, provider keys) | proposed plan | **VERIFIED** on the surfaces that exist | `inspect` local block (`cli.js:3238-3242`) copies address/identity/iAddress/network/status, not `wif`. Dashboard header does not print keys. `quickCheck` (`quick-check.js`) reports paths and pass/fail, not file contents. Plan's new `doctor` must keep this. |
| F3 | doctor / TUI must not recommend local mode as production | proposed plan | **DRIFT** | No doctor. `getActiveJobs` does recommend local (D5). Dashboard Start on local runtime tells the operator to install Docker **or** `start --dev-unsafe` (`dashboard.js:3934-3936`) — the second arm is correctly labelled development-only. |
| F4 | Dashboard header "Agents: N registered" means identities registered on the platform | README:78, 84 | **DRIFT** → **MO7** | `dashboard.js:276` uses `getAgents().length`. `getAgents` (`dashboard.js:84-87`) is "has `keys.json`". Status screen two menus down does it correctly: `Registered: ${registered.length} (total local: ${agents.length})` (`dashboard.js:956-958`). CLI `status` (`cli.js:6269`) same overcount via `listRegisteredAgents` (`cli.js:487-492`). |
| F5 | Header warns when a fee tank is EMPTY | CLAUDE.md:87; dashboard copy | **VERIFIED** | `dashboard.js:293-297` reads `fee-tank-status.json` and prints the red EMPTY line pointing at `[19]`. |
| F6 | Start button success means the dispatcher is up | implied by `dashboard.js:3922-3923` | **DRIFT** *(prior F9)* | 2.5 s liveness window (`dashboard.js:3916-3919`) is still shorter than first-run security's 10 s timeout (`cli.js:4772`). First start can print success while the child is still inside `secureSetup.setup`. |
| F7 | Dispatcher logs are at a user-owned, non-world path; View Logs works on every supported OS | proposed plan; dashboard [9] | **DRIFT** → **MO4** | Start opens `/tmp/dispatcher.log` (`dashboard.js:3906`). View Logs `spawn('tail', …)` (`dashboard.js:3993`). `resolveDispatcherLogPath` (`dashboard.js:867-877`) prefers `cfg.runtime.log_file` then `/tmp/dispatcher.log`. Scale **S15** owns rotation; this pass owns the path / Windows / tmp-precreate. `cli.js:14` `umask(0o077)` makes a *fresh* file 0600; a precreated 0666 `/tmp/dispatcher.log` is appended as-is. |
| F8 | TUI "Start Dispatcher" is reachable and is the mass-use start | README:92; CLAUDE.md:186 | **VERIFIED** | Menu `[7]`. Spawn is `node <cli> start` (`dashboard.js:3904`). |

---

## G. First-run security setup / platform matrix

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| G1 | On first start the dispatcher detects platform (Linux/macOS, KVM), installs gVisor or bwrap, deploys profiles, creates `j41-isolated`, writes the financial allowlist, pins egress, runs self-test | README:1066-1076 | **DRIFT** *(prior F4, F5, I4, I11)* | `cli.js:4759-4817` calls `secureSetup.setup('dispatcher')` with a 10 s `Promise.race`. `{success:false}` is not checked — `✓ Security setup complete` is unconditional on a non-throw (F4, now at `cli.js:4774`). Timeout abandons a still-running setup (F5). Marker is `existsSync` of `~/.j41/dispatcher-security-initialized` (`cli.js:4760`), not library `isInitialized()`. |
| G2 | Subsequent starts skip setup and run a quick-check | README:1078 | **VERIFIED**, with the same caveat as first-run D9 | Bare `existsSync`. Library `isInitialized()` (`j41-secure-setup/lib/index.js:104-123`) requires JSON `timestamp` and < 90 days; `setup()` writes `date`, not `timestamp` (`index.js:278-286`) — so `isInitialized()` is always false after a successful setup. Harmless today because the dispatcher does not call it; a shared `doctor` that did would loop first-run forever. Plan MUST-FIX. |
| G3 | Non-Linux is labelled and handled as macOS | procedure; `detect-platform.js` | **DRIFT** → **MO3** | `detect-platform.js:83`: `distro = platform === 'linux' ? readLinuxDistro() : 'macos'`. `os` is the raw `os.platform()` (`:89`), so win32 returns `{ os: 'win32', distro: 'macos' }`. `probeDocker` only sets `dockerDesktopVM` when `platform === 'darwin'` (`:37-47`). `setup()` else-branch (`index.js:215-224`) is the macOS Docker-Desktop-VM path — win32 always `{success:false}` "not active on macOS". `quick-check.js:18-26` profile dir: linux → `/etc/j41`, else `~/.j41` (win32 gets the macOS dir). AppArmor/iptables checks skip only on `darwin`, so win32 attempts `sudo iptables`. |
| G4 | macOS ≤ 13 (out of Docker Desktop support) fails closed | proposed plan | **MISSING** | No `sw_vers` / Darwin version check anywhere in dispatcher or `detect-platform.js`. Failure mode today is "Docker not running" / quick-check fail, not an EOL message. |
| G5 | Windows 10/11+WSL2 is a supported install | proposed plan | **MISSING** | No WSL detection, no `install.ps1`, `build-image` needs bash (**MO8**), TUI logs need `tail` and `/tmp` (**MO4**), secure-setup takes the macOS branch (**MO3**). |
| G6 | First-run security sudo for apparmor/iptables does not hang the dispatcher | README:1068-1076 vs `cli.js:4769` comment | **DRIFT** *(prior F5)* | 10 s timeout exists specifically because "sudo may be required". On timeout the dispatcher continues; quick-check then reads a half-applied host. Isolation **I4**: `warn` (missing iptables) does not fail `passed` (`quick-check.js:331` is fail-only). Score 8/10 + bwrap is a documented live outcome. |
| G7 | `@junction41/secure-setup` is optional; missing it is non-fatal | `package.json:50-52` optionalDependencies | **VERIFIED** | `cli.js:135-138` require/catch; `cli.js:4780-4785` warns and continues. Below Node 20.19 the require throws (ESM) and the whole gate vanishes — *(prior I11)*. |

---

## H. GPU quota / Docker storage (host chapter, not mass labour)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| H1 | Cat-1 GPU stays Linux NVIDIA only | CLAUDE.md:29; README:831-845; proposed plan | **VERIFIED** | `docker-host.js:63-88` `assertDockerReachable` + `assertNvidiaRuntime`. `assertHomeGpuHostReady` (`:100-127`) also demands a jail image and `supportsStorageOpt`. Wired from `start` when `homeGpuConfigured` (`cli.js:4362-4382`). |
| H2 | `HOME_GPU_NO_DISK_QUOTA` is fail-closed; overlayfs/ext4 cannot cap `disk_gb` | README:882-909; `docker-host.js`; plan "do not relax" | **VERIFIED** | `supportsStorageOpt` (`docker-host.js:28-60`): `overlay2` only with `\b(pquota\|prjquota)\b` (not `pqnoenforce`); `btrfs`/`zfs` native; **any other driver including Docker 29 `overlayfs` → false**. No quota-bypass flag in this file. |
| H3 | A GPU quota script rewrites `daemon.json`, moves data-root, sets `containerd-snapshotter` false, as Linux-only documented sudo with explicit operator consent | proposed plan | **MISSING** | No such script in `scripts/`. README:906-909 documents the *manual* data-root move and says it requires restarting the daemon. Plan threat model owns the destructive shape. |
| H4 | Labour `start` does not require StorageOpt-capable storage | implied (GPU is the host chapter) | **VERIFIED** | `supportsStorageOpt` is only pulled in on the home-gpu start gate (`cli.js:4364`) and jail create (`cli.js:10742`). A stock overlay2+ext4 Ubuntu box can run labour. |

---

## I. Clock / signed API

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| I1 | Signed platform auth works with a correct local clock | live test 2026-09-02..04 (65 min skew killed signed API) | **VERIFIED** as a dependency, **MISSING** as a preflight → **MO6** | SDK `_loginImpl` (`sovagent-sdk/dist/agent.js:349-356`) throws `Auth challenge already expired — clock skew or stale response` if `expiresAt < Date.now()`. Canonical envelopes: `CLOCK_SKEW_MS = 300_000` (`canonical.js:28,149-153`). Webhook timestamp window default 300 s (`webhook/verify.js:49-57`). Dispatcher `start` never compares host time to an API `Date` header. |
| I2 | An NTP attacker cannot replay forever or indefinitely claim "platform down" | procedure | **VERIFIED** as bounded, **MISSING** as operator signal | Replay window is 5 minutes on envelopes and webhooks. A 65 min forward skew fails *login* (looks like platform/auth failure). No doctor/start line that says "your clock is wrong". |

---

## J. Plan-only surfaces that do not exist yet

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| J1 | `src/doctor.js` is the shared oracle for CLI `doctor` and the TUI health screen | proposed plan | **MISSING** | — |
| J2 | Windows `install.ps1` sets execution policy safely and does not `iex` unsigned remote script without a pin | proposed plan | **MISSING** | — |
| J3 | Windows named-pipe ACLs for `docker_engine` are explained, not hidden | proposed plan | **UNVERIFIED** | dockerode default npipe is not configured in-tree; no installer text. |
| J4 | Publishing npm tokens are not handled by these scripts | procedure (out of scope) | **VERIFIED** N/A | No npm token paths in `install.sh` / `setup.sh` / CLI start. Operator note only. |

---

## K. Claims checked and deliberately not turned into findings

| # | Claim | Why not a finding |
|---|---|---|
| K1 | `start` refuse-before-accept on local without `--dev-unsafe` | Fixed since F7. Verified at `cli.js:4320-4330`. |
| K2 | Dashboard Start cannot pass `--dev-unsafe` | Intentional. Local runtime is diagnosed, not silently spawned unsafe. |
| K3 | `HOME_GPU_NO_DISK_QUOTA` fail-closed including Docker 29 `overlayfs` | Intentional. Driver `overlayfs` ≠ `overlay2` → `supportsStorageOpt === false`. |
| K4 | Mainnet gate lists `--dev-unsafe` | `mainnet-guard.js:33`. I5's config.toml hatches are now passed as `cfg.runtime` (`cli.js:4199-4203`). |
| K5 | Fee-tank EMPTY on the first TUI screen | `dashboard.js:293-297`. |
| K6 | `package.json` `files` includes the build inputs | D1 fixed. |
| K7 | F1 throw on empty UTXOs | `cli.js:1185-1206`. Still relevant to labour `setup` if the seed is unconfirmed; not re-opened. |
| K8 | F3 quickstart now writes `[provider_keys]` | `cli.js:1487-1502`. Not re-opened. |
| K9 | Publishing / npm 2FA / tokens | Out of scope per procedure. |
