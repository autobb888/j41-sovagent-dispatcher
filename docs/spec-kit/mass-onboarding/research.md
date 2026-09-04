# Research — current code facts (verified 2026-09-04)

Grounding for the mass-onboarding spec. Line numbers are from
`j41-sovagent-dispatcher` at `@junction41/dispatcher@2.36.0` (git `main`
`53c0a34` as of the tester-box clone). Do not treat this file as the
implementation plan — see `plan.md`.

Related trees (patterns, not copy-paste):

- Jailbox platforms: `j41-jailbox/PLATFORMS.md`
- Jailbox doctor: `j41-jailbox/src/doctor.ts`
- Jailbox Docker bind/socket: `j41-jailbox/src/docker.ts`
- secure-setup detect: `j41-secure-setup/lib/detect-platform.js`

---

## 1. Package identity

| Fact | Location |
|------|----------|
| Name `@junction41/dispatcher`, version `2.36.0` | `package.json:2-3` |
| Bin `j41-dispatcher` → `src/cli.js` | `package.json:5-7` |
| `engines.node` `>=20.0.0` | `package.json:61-63` |
| `files` = `src`, `templates`, `scripts`, `Dockerfile.job-agent`, `Dockerfile.gpu-jail`, `package.docker.json`, `README.md`, `CHANGELOG.md`, `LICENSE` | `package.json:8-18` |
| `files` omits `docs/`, `docs/config.toml.example`, `JAILBOX_PARKED.md` | same vs README link at `README.md:17` |
| Repo URL live: `git+https://github.com/autobb888/j41-sovagent-dispatcher.git` | `package.json:28-32` |
| Optional dep `@junction41/secure-setup` `0.3.0` | `package.json:50-52` |
| CJS, no build step | `CLAUDE.md:27` |

Unscoped npm trap (product fact, not in this repo): `j41-dispatcher@2.0.0` is
still what `npm i -g j41-dispatcher` installs. Frozen / deprecated 2026-04-08.
Scoped `@junction41/dispatcher@2.36.0` is `latest`. Alias publish needs an
npmjs token; that is a human gate, not a code gate.

---

## 2. Installer — 404 repo, silent local, apt Node

Canonical script: `scripts/install.sh` (also `setup.sh` at repo root).

```14:14:scripts/install.sh
REPO_URL="https://github.com/junction41/j41-sovagent-dispatcher"
```

That GitHub org/repo 404s. Live clone is `autobb888/j41-sovagent-dispatcher`.
`J41_VERSION="latest"` (`install.sh:12`) then
`$REPO_URL/releases/download/v${J41_VERSION}/…` (`install.sh:149`) is not a tag.

Silent local runtime when piped (the advertised `curl | bash` path):

```97:100:scripts/install.sh
    if [ ! -t 0 ]; then
        RUNTIME="local"
        echo "  → Non-interactive mode: using local process mode"
```

Interactive default is also local (`install.sh:106-107`, choice default `2`).
Persisted to **`config.json`**, not `config.toml`:

```169:173:scripts/install.sh
cat > "${HOME}/.j41/dispatcher/config.json" << EOJSON
{
  "runtime": "${RUNTIME}"
}
EOJSON
```

Node bootstrap still falls through to apt/dnf (`install.sh:40-47`) and
nodesource `setup_22.x`. Ubuntu 24.04 apt `nodejs` is 18.19.1 — below
`engines.node`. Next-step banner still says `init -n 9` (`install.sh:216`).

`setup.sh` is the same trap plus it **runs** `init -n 9` (`setup.sh:124`) and
defaults local on non-TTY (`setup.sh:93-96`).

`start` already knows this is the worst ordering and documents it:

```4311:4330:src/cli.js
    // F7 — refuse local mode HERE, before a single job is accepted.
    //
    // The gate existed only inside `startJobLocal` ...
    // Both installers default to `runtime=local` when Docker is absent — and the
    // `curl | bash` path takes that default silently
    if (RUNTIME === 'local' && !_devUnsafe) {
      console.error('\n❌ Refusing to start: runtime is "local", which gives containers ZERO isolation.');
      ...
      process.exit(1);
    }
```

TUI Start cannot pass `--dev-unsafe` (`src/dashboard.js:3927-3936`), so a
dashboard-spawned dispatcher is permanently dead in the installer-produced
state.

---

## 3. Docker connection is naive `new Docker()`

```123:131:src/cli.js
let Docker, docker;
if (RUNTIME === 'docker') {
  try {
    Docker = require('dockerode');
    docker = new Docker();
  } catch {
    // dockerode not available — will fail at runtime if docker commands are used
  }
}
```

Crash-recovery repeats it (`src/cli.js:8548-8549`). dockerode default:

- Linux: `/var/run/docker.sock`
- Darwin: often **not** `/var/run/docker.sock`. Docker Desktop uses
  `~/.docker/run/docker.sock`. Colima: `~/.colima/default/docker.sock`.
- win32: named pipe `//./pipe/docker_engine` (docker-modem auto-selects)

Jailbox already documents this (`j41-jailbox/PLATFORMS.md:67-69`) and translates
Windows bind sources (`j41-jailbox/src/docker.ts:60-72`). Dispatcher does not
probe `DOCKER_HOST` or Desktop sock paths. `getActiveJobs` then lies:

```1256:1268:src/cli.js
  if (!docker) {
    console.error('❌ Docker runtime selected but Docker is not available.');
    console.error('   Install Docker or switch to local mode: j41-dispatcher config --runtime local');
    return Promise.resolve([]);
  }
  return docker.listContainers().then(containers => {
    ...
  }).catch(e => {
    console.error(`❌ Docker error: ${e.message}`);
    console.error('   Install Docker or switch to local mode: j41-dispatcher config --runtime local');
    return [];
  });
```

`ENOENT`, `EACCES`, daemon-down, and Desktop-sock-on-Mac are the same sentence.

---

## 4. `build-image` requires bash

```4104:4109:src/cli.js
function spawnImageBuildScript(script) {
  return new Promise((resolve) => {
    const child = require('child_process').spawn('bash', [script], {
      cwd: path.dirname(path.dirname(script)),
      stdio: 'inherit',
    });
```

`scripts/build-image.sh` is a bash script that copies a `.build-temp` context
and `docker build`s `Dockerfile.job-agent`. Win32 Node has no `bash` unless
Git-Bash/WSL is on PATH. This is why Wave 3 replaces the spawn with a
Node-driven builder (`src/build-image.js`) using `dockerode` or `docker` CLI.

`build-image` always builds **both** `j41/job-agent` and `j41/gpu-jail`
(`src/cli.js:4138-4165`). Labour first-run does not need the jail image.

---

## 5. TUI header, Start, logs

Header treats local folders as registered:

```276:279:src/dashboard.js
  console.log(`\n  Agents: ${agents.length} registered`);
  console.log(`  Dispatcher: ${status.running ? `running (PID ${status.pid})` : 'stopped'}`);
  console.log(`  Runtime: ${config.runtime || 'docker'}`);
  console.log(`  Global LLM: ${cfg.llm.provider || '(not configured)'}`);
```

`getAgents()` is `readdir` of `agents/*/keys.json` (`src/dashboard.js:84-96`).
Same lie as CLI `status`:

```487:492:src/cli.js
function listRegisteredAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter(name => {
    const keysPath = path.join(AGENTS_DIR, name, 'keys.json');
    return fs.existsSync(keysPath);
  });
}
```

```6268:6270:src/cli.js
    const finalized = agents.filter(a => isFinalizedReady(a)).length;
    console.log(`Agents: ${agents.length} registered`);
    console.log(`Finalized ready: ${finalized}/${agents.length}`);
```

`isFinalizedReady` is `finalize-state.json` `stage === 'ready'` (`cli.js:514-517`).
That line is honest; the word “registered” on the line above is not.

Start logs to a world-writable tmp path:

```3903:3907:src/dashboard.js
          const child = spawn(process.execPath, [process.argv[1], 'start'], {
            detached: true,
            stdio: ['ignore', fs.openSync('/tmp/dispatcher.log', 'a'), fs.openSync('/tmp/dispatcher.log', 'a')],
          });
```

`resolveDispatcherLogPath` prefers `cfg.runtime.log_file` then
`/tmp/dispatcher.log` (`dashboard.js:867-877`). `config-loader.js` DEFAULTS
have **no** `runtime.log_file` key (`src/config-loader.js:12-23`). Docs example
`~/.j41/dispatcher/logs/dispatcher.log` (`j41-docs/docs/dispatcher/setup.md:79`)
is not what the TUI writes.

Sign-up TUI offers `compute` / `data` / `model` on every OS
(`src/dashboard.js:1258-1263`). No `process.platform` guard.

Fee-tank TUI banner says EMPTY for `needsFunding`
(`dashboard.js:293-297`), and `needsFunding` is only
`snap.reason === 'needs-external-funding'` (`cli.js:10149`). That is the empty
unfunded case. A tank at 32 writes is `low` in `buildWalletRow`
(`src/wallet.js:194-195`) and must not be labeled EMPTY. Floor is 100 writes
(`src/fee-tank.js:39`).

---

## 6. Identity stages (already in code, poorly named)

| Stage | Evidence | Code |
|-------|----------|------|
| Local only | `agents/<id>/keys.json` exists | `listRegisteredAgents`, `getAgents` |
| Named / pending | `keys.identity` set, no `iAddress`, or `registrationStatus === 'timeout'` | `cli.js:1908-1914`, `3242` |
| On-chain | `keys.identity` + `keys.iAddress` | `cli.js:1909`, `3612` |
| Finalized | `finalize-state.json` `stage === 'ready'` | `isFinalizedReady` 514-517 |
| Platform-ready | `start` loop: on-chain + active status (not in `_unregisteredAgents`) | `cli.js:4451-4646` |

`start` with every local id unregistered already `process.exit(1)` and prints
`register` not `activate-all` (`cli.js:4623-4645`). Keep that. Doctor should
classify the same way so the TUI does not say “5 registered” for five `init`
folders.

`inspect` “No services registered” (`cli.js:3459-3461`) is the VDXF/platform
services array, not marketplace gpu-rental. A live Cat-1 listing can still
print this. Doctor must not reuse that string for identity stage.

---

## 7. GPU host gate (do not weaken)

```28:60:src/docker-host.js
function supportsStorageOpt(...) {
  ...
  if (SIZE_CAPABLE_DRIVERS.has(driver)) { // btrfs, zfs
    ok = true;
  } else if (driver === 'overlay2') {
    ...
    ok = XFS_PROJECT_QUOTA_RE.test(mounts); // \b(?:pquota|prjquota)\b
  } else {
    ok = false;
  }
}
```

`assertHomeGpuHostReady` throws `HOME_GPU_NO_DISK_QUOTA` with
“Nothing was accepted and no buyer can pay into this fleet.”
(`docker-host.js:100-114`). Tests refuse `vfs` / `aufs` / `overlay`
(`test/docker-host.test.js:102-107`). Driver name `overlayfs` (Docker 29
containerd snapshotter) is **not** in that list but falls through to `ok =
false`. Add an explicit `overlayfs` assertion in Wave 4; do not add a success
path.

NVIDIA runtime: `assertNvidiaRuntime` (`docker-host.js:73-88`).
AppArmor is Linux-only (`cli.js:10452-10464`). There is **no** `src/jail.js`
in this repo (a prior note claimed there was). Platform branching to reuse:

- `src/docker-host.js` (GPU host)
- `src/cli.js` AppArmor / seccomp
- jailbox `src/docker.ts` (sock, bind translation, non-root user)
- secure-setup `detectPlatform` (currently wrong on win32)

---

## 8. secure-setup win32 hole

```79:95:j41-secure-setup/lib/detect-platform.js
export async function detectPlatform() {
  const platform = os.platform(); // e.g. 'linux', 'darwin'
  ...
  const distro = platform === 'linux' ? readLinuxDistro() : 'macos';
  ...
  return {
    os: platform,
    ...
    distro,
```

JSDoc says `os: 'linux'|'darwin'` (`detect-platform.js:71`). Tests assert
`os` is only those two (`j41-secure-setup/test/detect-platform.test.js:16-21`).
On `win32`, `os` is the raw `win32` but `distro` is hardcoded `'macos'`.
`probeDocker` only checks Desktop VM on `darwin` (`detect-platform.js:37-47`).
Wave 1/2 needs a real `win32` branch: WSL2 vs Hyper-V, no KVM, no gVisor
install.

Dispatcher `start` calls `secureSetup.quickCheck('dispatcher')` and fail-closes
unless `--dev-unsafe` (`cli.js:4789-4810`).

---

## 9. Docs drift (j41-docs)

| Claim | File | Truth |
|-------|------|-------|
| Node.js 18+ | `j41-docs/docs/getting-started/dispatcher-quickstart.md:13`, `j41-docs/docs/dispatcher/setup.md:17` | `engines.node >=20` |
| 3 pre-registered VerusIDs + hand-pasted WIFs | dispatcher-quickstart.md:14-16 | `setup` mints + platform seeds 0.0033 |
| Verus daemon required | `j41-docs/docs/getting-started/sovagent-quickstart.md:14` | Dispatcher talks to `api.junction41.io`; no local `verusd` |
| Clone URL | setup.md uses `autobb888` (correct) | installer still has 404 org |

README first-run (`README.md:37-66`) is closer to truth: Node 20, Docker,
`build-image`, no coins before register, `setup` not `init -n 9`. Installer
and j41-docs contradict it.

---

## 10. Jailbox pattern (learn, do not clone)

`j41-jailbox/PLATFORMS.md`:

- One npm package, no per-OS artifacts. Runtime branches on `process.platform`.
- macOS / Windows: Docker Desktop **Linux-container mode**. Wall 1 is the VM.
- `j41-jailbox doctor` checks Node, Docker CLI, daemon, non-root, image, kernel
  wall (`j41-jailbox/src/doctor.ts`). Status is `pass | fail | warn`.
- Docker sock auto-select; Windows bind paths rewritten to `//c/...`.
- gVisor is Linux-only; `--insecure` is explicit.

Dispatcher doctor should follow that shape (one module, pass/fail/warn, OS
matrix) but add package-version, clock skew, identity stages, fee-tank
low-vs-empty, and GPU-skip on darwin/win32. Jailbox Node check is `>=18`
(`doctor.ts:26`) — dispatcher must check `>=20`.

---

## 11. What does **not** exist today

- `j41-dispatcher doctor` — no command, no `src/doctor.js`.
- `scripts/install.ps1`.
- Clock-skew check against API `Date` header.
- `DOCKER_HOST` / Desktop sock probing.
- npm alias package for unscoped `j41-dispatcher`.
- TUI platform filter for kind `compute`.
- Node-driven image build (bash-only).
- Log path `~/.j41/dispatcher/dispatcher.log` as the Start default.

---

## 12. Implications for the plan

1. Rewrite `install.sh`; do not patch the 404 clone. Mass-use install is
   Node bootstrap + `yarn global add @junction41/dispatcher`, not `git clone`.
2. Add `src/doctor.js` before trusting any TUI copy. Wave 2 is one PR for CLI
   + TUI honesty.
3. Replace `spawn('bash', …)` before claiming Windows.
4. Keep `supportsStorageOpt` fail-closed; ship a quota script + docs, do not
   flip the gate.
5. `npm pack` + scratch HOME is the merge gate even when alias publish waits.
