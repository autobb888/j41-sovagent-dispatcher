# mass-onboarding — audit findings

**Date:** 2026-09-04 · **Scope:** stock-user install through first labour
`setup` / dashboard / `start` on Ubuntu/Debian/Fedora/RHEL, macOS 14+,
Windows 10/11+WSL2. The **proposed** installer-first + npm-alias plan is in
scope, not only current code. GPU Cat-1 is a host chapter (fail-closed).

Read-only pass. No file outside `AUDIT/` was modified. Nothing was executed
except static reads. first-run F1–F12 are **not** re-opened; cited as prior
where the installer/TUI plan still trips them.

**Counts:** crit 0 · high 2 · med 5 · low 2 · **total 9**

Claims checklist: `AUDIT/mass-onboarding-claims.md` (70 claims, 11 groups) —
28 VERIFIED · 24 DRIFT · 14 MISSING · 4 UNVERIFIED.

---

## Findings

| # | Sev | Finding | Anchor |
|---|---|---|---|
| MO1 | **high** | The shipped `install.sh` cannot install current dispatcher: it clones a 404 GitHub URL into the runtime data dir and falls through to a `vlatest` tarball that is not a release | `scripts/install.sh:12-14,141-154` |
| MO2 | **high** | Docker EACCES (installed, not in the group / named-pipe denied) is collapsed into "no Docker" / "image not built" / "switch to local" — the installer then silently writes `runtime=local`, and `config --runtime local` still has no warning | `cli.js:4073-4080,1256-1268`; `install.sh:79-100` |
| MO3 | med | `secure-setup` labels every non-Linux distro `macos` and runs the macOS Docker-Desktop branch; win32 never gets a Windows path | `j41-secure-setup/lib/detect-platform.js:83,37-47`; `lib/index.js:215-224` |
| MO4 | med | Dashboard Start/logs hardcode `/tmp/dispatcher.log` and `tail -f`; Windows throws, `/tmp` is a precreate/symlink race on a shared host | `dashboard.js:3904-3906,867-877,3992-3993` |
| MO5 | med | CLI never refuses Node < 20; Ubuntu apt Node 18 installs the package with an engines warning and then loses the security gate silently | `package.json:61-63`; `cli.js:135-138` |
| MO6 | med | `start` has no clock preflight; a 65 min skew fails signed login as "challenge expired" with no "fix your clock" signal | SDK `agent.js:349-356`; `canonical.js:28` |
| MO7 | low | TUI header "Agents: N registered" counts every local `keys.json`, including `init`-only identities that are not on the platform | `dashboard.js:276,84-87` |
| MO8 | low | `build-image` is `spawn('bash', [script])`; the plan's Windows mass path cannot run the documented command | `cli.js:4104-4118` |
| MO9 | med | `install.sh` pipes unsigned nvm / NodeSource / get.docker.com installers to bash with no checksums, and will `sudo usermod -aG docker` without saying that is root-equivalent | `install.sh:36,42,46,114-117` |

---

### MO1 — high — shipped `install.sh` cannot produce `@junction41/dispatcher@2.36.0`

**Files:** `scripts/install.sh:12-14,141-154,169-173,193-201,216-218`;
`package.json:9-18,29-32`.

**Path.** `package.json:12` now lists `scripts/` in `files`, so
`scripts/install.sh` ships in the npm tarball (this is the D1 fix). The
script's own header is `curl -fsSL https://.../install.sh | bash`. The
proposed mass-use plan makes that the primary Linux/Mac path.

What it does:

1. `REPO_URL="https://github.com/junction41/j41-sovagent-dispatcher"`
   (`install.sh:14`). `package.json:29-32` repository is
   `github.com/autobb888/j41-sovagent-dispatcher`. Live: the `junction41/`
   URL 404s (operator note 2026-09-02..04).
2. `git clone "$REPO_URL" "$INSTALL_DIR"` with `INSTALL_DIR="${HOME}/.j41/dispatcher"`
   — the runtime data directory (`config.js:9`, `AGENTS_DIR`, `config.toml`,
   `dispatcher.pid`). Stderr swallowed (`2>/dev/null`).
3. On clone failure, `curl -fsSL "$REPO_URL/releases/download/v${J41_VERSION}/j41-dispatcher-${J41_VERSION}.tar.gz"`
   with `J41_VERSION="latest"` → GitHub path `.../vlatest/j41-dispatcher-latest.tar.gz`.
   That is not a tag and not how GitHub "latest" works.
4. Both arms fail → `❌ Could not install dispatcher` / exit 1.

**Trigger.** Any of: the plan's `curl | bash`; running the script from a
global install (`$(npm root -g)/@junction41/dispatcher/scripts/install.sh`);
re-running it on a box that already has `~/.j41/dispatcher/agents/` (no
`.git` → clone fails → tarball extract would have unpacked a source tree
*over* live keys if the URL ever worked — prior **F11**).

**Why this is not F11 re-opened.** F11 (low, 2026-08-10) was "clones into
the data dir and pins tarball `2.0.0` while the package is `2.19.0`",
contained by `files` omitting `scripts/` and README not mentioning the
script. Two things changed: (1) `files` now ships the script, so the
containment is gone; (2) the pin was changed to `latest`, which is still
not a release, and the clone URL was never updated to `autobb888`. The
data-dir collision is still F11; the 404 + `vlatest` + npm-shipping is new.

**Outcome.** The installer the plan wants to put in front of every stock
user cannot install. The documented `yarn global add @junction41/dispatcher`
path is a different door and still works — that is why this is high, not
crit.

**Proposed fix (not applied).**
1. Point `REPO_URL` at `autobb888/j41-sovagent-dispatcher` **or, better,
   stop cloning**: `npm i -g @junction41/dispatcher` into a user prefix.
2. Install code to `~/.local/share/j41-dispatcher` (or npm's prefix), never
   `~/.j41/dispatcher`.
3. Drop the GitHub-release tarball, or pin a real tag and a sha256.
4. Do not print `init -n 9`; next step is `doctor` then `dashboard` / one
   `setup` (README:58).

---

### MO2 — high — Docker EACCES is not a distinct state; remedies push `runtime=local`

**Files:** `src/cli.js:4073-4080, 4347-4356, 1256-1268, 10611-10614,
1293-1299`; `scripts/install.sh:79-130, 169-173`;
`src/dashboard.js:3926-3936`.

**Path — `start`.** Before any job is accepted, `start` requires the
job-agent image (`cli.js:4347`):

```js
function jobImageExists() {
  try {
    require('child_process').execSync(`docker image inspect ${JOB_IMAGE}`, …);
    return true;
  } catch { return false; }
}
```

`docker image inspect` returns EACCES/EPERM when the binary exists but
`/var/run/docker.sock` is not usable (user not in `docker` group, or the
session has not `newgrp`'d). The catch swallows the code. The operator is
told the image is not built and to run `j41-dispatcher build-image` — which
then fails with the generic "Docker must be installed and running, and your
user able to reach it" (`cli.js:4147-4149`). The image may already be there.

**Path — installer.** `install.sh:79-90`:

- `command -v docker` missing → `DOCKER_AVAILABLE=false`
- `docker info` failing for *any* reason (daemon down **or** EACCES) →
  `DOCKER_AVAILABLE=false`

Piped stdin (`curl | bash` → `[ ! -t 0 ]`) then sets `RUNTIME="local"` with
no prompt (`install.sh:98-100`) and overwrites
`~/.j41/dispatcher/config.json` with `{ "runtime": "local" }`
(`install.sh:169-173`). That is the live half of **F7**. `start` now
refuse-before-accept (`cli.js:4320-4330`) so money is not taken — but the
operator's first `start` / dashboard Start is a brick, and the TUI cannot
pass `--dev-unsafe` (`dashboard.js:3904-3906, 3927-3936`).

**Path — `status` / dockerode errors.** `getActiveJobs` (`cli.js:1256-1268`)
prints, for both "dockerode did not load" and any `listContainers` throw:

```
Install Docker or switch to local mode: j41-dispatcher config --runtime local
```

`config --runtime local` (`cli.js:1293-1299`) accepts `local` with no
warning that `start` will then exit 1. Following the printed remedy is how
a user with a working Docker install (minus group membership) *creates*
the F7 state by hand.

**Trigger.** Fresh Ubuntu: `apt install docker.io`, user not in `docker`
group, or still in the pre-`usermod` login session. Extremely common.
Same shape on Windows if the `docker_engine` named pipe ACL denies the
user — dockerode will throw; current code has no npipe-specific message.

**Privilege.** `install.sh:115-117` `sudo usermod -aG docker "$USER"` is
root-equivalent via `docker.sock`. The only follow-up is "you may need to
log out and back in". The installer must not hide this (procedure). It
does.

**Proposed fix (not applied).**
1. Classify docker reachability: ENOENT (binary missing) / EACCES|EPERM
   (installed, not permitted) / daemon-down / ok. Three different messages,
   three different remedies. EACCES: `sudo usermod -aG docker $USER` then
   `newgrp docker` / log out — and a one-line "members of `docker` can
   become root via the socket".
2. `jobImageExists` / `build-image` / `getActiveJobs` / `startJobContainer`
   must not share one string. Never recommend `config --runtime local` as
   a fix.
3. `config --runtime local` should print the same refuse-before-accept
   warning `start` uses, and refuse to persist it without `--dev-unsafe`
   (or a typed confirmation).
4. Installer: if Docker is present but not reachable, **stop**. Do not
   write `runtime=local`. Do not treat a missing TTY as consent.

---

### MO3 — med — win32 is labelled `macos` and takes the Docker Desktop VM path

**Files:** `j41-secure-setup/lib/detect-platform.js:37-47,79-95`;
`lib/index.js:163-224`; `lib/quick-check.js:18-26,123-125,186-187,283-285`.

**Path.** First `start` → `secureSetup.setup('dispatcher')`
(`cli.js:4771`). `detectPlatform()`:

```js
const distro = platform === 'linux' ? readLinuxDistro() : 'macos';
// os: platform   → win32 stays 'win32'
// distro         → 'macos'
```

`probeDocker` only inspects `OperatingSystem` for `platform === 'darwin'`,
so `dockerDesktopVM` is always false on win32. `setup()` then:

```js
if (platform.os === 'linux') { /* gVisor / bwrap */ }
else {
  // "macOS: verify Docker Desktop VM"
  if (!platform.dockerDesktopVM) {
    return { success: false, … };  // "does not appear to be active on macOS"
  }
}
```

Dispatcher discards `{success:false}` and prints `✓ Security setup complete`
(prior **F4**, now `cli.js:4774`). `quickCheck` then: profile dir is
`~/.j41` (the macOS path — not linux); AppArmor and iptables checks skip
*only* on `darwin`, so win32 runs `sudo iptables -L J41_AGENT_OUT`.

**Trigger.** Windows 10/11, with or without WSL2, running `j41-dispatcher
start` with `@junction41/secure-setup` installed. The proposed plan lists
this OS as in-scope.

**Outcome.** First-run security cannot succeed on Windows. The operator is
told they are on macOS. Combined with MO4/MO8, the Windows mass path is
not a docs gap — the libraries actively mis-detect.

**Proposed fix (not applied).** `detectPlatform` must return
`os: 'win32' | 'linux' | 'darwin'` and a distro that is not `'macos'` on
win32. `setup()` / `quickCheck` need an explicit win32 branch: skip
gVisor/bwrap/iptables/AppArmor, require Docker Desktop or WSL2 engine,
fail closed with a Windows-specific message. Do not enter the macOS VM
arm unless `os === 'darwin'`.

---

### MO4 — med — TUI logs are `/tmp/dispatcher.log` + `tail`; Windows-broken, tmp-racy

**Files:** `src/dashboard.js:867-877, 3904-3923, 3979-4000`.
Scale **S15** already reported the unrotated 20 MB/day growth; not
re-derived. This is the path / OS / tmp-precreate half the procedure
named.

**Path.** Menu `[7] Start Dispatcher`:

```js
spawn(process.execPath, [process.argv[1], 'start'], {
  detached: true,
  stdio: ['ignore',
    fs.openSync('/tmp/dispatcher.log', 'a'),
    fs.openSync('/tmp/dispatcher.log', 'a')],
});
```

No try/catch around `openSync`. On Windows, `/tmp/...` is `C:\tmp\...`
which typically does not exist → throw → TUI dies. Menu `[9] View Logs`
`spawn('tail', ['-f', '-n', '40', logPath])` — `tail` is not a Windows
command.

`cli.js:14` sets `umask(0o077)` before `require('./dashboard.js')`, so a
*fresh* file is 0600. If another local user precreates
`/tmp/dispatcher.log` as 0666 (or a symlink) before first Start, the
dashboard appends to that inode: log leak (job descriptions, API errors)
and log injection. `/tmp` is 1777 sticky; this is the classic
shared-host tmp race, not a remote attacker.

**Trigger.** (a) Windows dashboard Start. (b) Multi-user Linux box, race
on `/tmp/dispatcher.log`.

**Proposed fix (not applied).** Default log file
`~/.j41/dispatcher/dispatcher.log` (0700 dir, 0600 file, `O_NOFOLLOW` /
`wx` exclusive create). View Logs: read the file in Node (or `Get-Content
-Wait` on win32), never `tail`. Keep `cfg.runtime.log_file` as override.
Do not create anything under `/tmp`.

---

### MO5 — med — no runtime Node gate; Ubuntu apt Node 18 walks in

**Files:** `package.json:61-63`; `src/cli.js:105-138`; isolation **I11**.

**Path.** README:37 and `engines.node: ">=20.0.0"` tell the operator they
need Node 20. npm/yarn treat `engines` as a warning unless
`engine-strict` is set. There is no `process.version` check at CLI
entry. On Ubuntu 24.04, `apt install nodejs` is 18.x (live test
2026-09-02..04). `yarn global add @junction41/dispatcher` succeeds.

Then `cli.js:135-138`:

```js
try { secureSetup = require('@junction41/secure-setup'); }
catch { /* security features will be skipped */ }
```

`@junction41/secure-setup` is ESM (`"type":"module"`). Node 18 / Node
< 20.19 throws on that `require`. The catch swallows it. First-run
security and the quick-check never run. Isolation **I11** reported the
silent-gate half; this pass reports the missing *door*: the CLI does not
refuse the Node the distro actually ships, which is why the plan's "never
apt nodejs / install 22 via nvm or official tarball" is load-bearing.

**Trigger.** Stock Ubuntu/Debian, apt Node, documented `yarn global add`.

**Proposed fix (not applied).** At the top of `cli.js` (and the dashboard
entry), if `Number(process.versions.node.split('.')[0]) < 20` (and for
secure-setup, `< 20.19`), print the two supported installs (nvm 22,
official tarball to `~/.local`) and `process.exit(1)`. Installer must
never call `apt-get install nodejs` (`install.sh:40-43` currently does).

---

### MO6 — med — no clock preflight; skew looks like "platform down"

**Files:** `@junction41/sovagent-sdk/dist/agent.js:349-356`;
`dist/crypto/canonical.js:28,149-153`; `dist/webhook/verify.js:49-57`.
No dispatcher caller.

**Path.** Every `setup` / `register` / `start` authentication goes through
`J41Agent._loginImpl`. If the challenge's `expiresAt` is already in the
past vs `Date.now()`, it throws `Auth challenge already expired — clock
skew or stale response`. Canonical v1 envelopes allow ±300 s
(`CLOCK_SKEW_MS`). Webhook HMAC-with-timestamp, same 300 s default.

Live test 2026-09-02..04: **65 min** host skew killed signed API. That is
13× the window. The dispatcher never reads an API `Date` header, never
asks NTP, never prints "your clock is 65 minutes off". The operator's
working theory becomes "Junction41 is down".

**Replay / NTP influence (procedure).** An attacker who can move the host
clock (typically already local admin, or a malicious DHCP/NTP on a
captive network) can:

- **Forward skew ≫ 5 min:** login and signed job accept/deliver fail
  closed. Availability, not theft. Looks like platform outage.
- **Backward skew within 5 min:** a captured envelope/webhook that was
  still inside the window can verify again. The 5 min bound is real; this
  is not unbounded replay.
- **Job-message timestamps** (`cli.js` / `job-signer.js`
  `Math.floor(Date.now()/1000)` bound into `J41-ACCEPT|…|Ts:`) are
  verified by the *platform*. Platform-side window is not in this repo
  (UNVERIFIED). Dispatcher cannot widen it.

**Trigger.** Host NTP disabled, VM paused, Windows "set time automatically"
off, travel without timezone update. 65 min is a typical "forgot to
enable NTP" delta, not an edge case.

**Proposed fix (not applied).** `doctor` and `start` (before login):
`GET ${apiUrl}/v1/version` (or any cheap endpoint), compare `Date`
header to `Date.now()`. If `|delta| > 60s`, print the offset and refuse
to start (or warn hard above 30 s). Do not "fix" the clock from the
installer. Do not enlarge `CLOCK_SKEW_MS`.

---

### MO7 — low — header "registered" counts unregistered local identities

**Files:** `src/dashboard.js:276, 84-87, 956-958`; `src/cli.js:487-492,
6269`.

**Path.** `getAgents()` is `readdir(AGENTS_DIR)` filtered on `keys.json`.
`mainMenu` prints `Agents: ${agents.length} registered`. Two screens down,
status does it correctly: `agents.filter(a => a.identity)` as
`Registered` vs `total local`. CLI `status` uses `listRegisteredAgents()`,
which is the same keys.json filter, then `Agents: N registered`.

**Trigger.** README:58's *non*-recommended path, which `install.sh:217`
and `setup.sh:124` still push: `init -n 9` then open the dashboard. Nine
unregistered keypairs render as "9 registered".

**Outcome.** Operator thinks they are listed. They are not. Confusing, not
unsafe. The correct split already exists 680 lines below.

**Proposed fix (not applied).** Use the status-screen split on the header
and in CLI `status`. `listRegisteredAgents` is misnamed; don't use it as
a platform-registered count.

---

### MO8 — low — `build-image` spawns bash

**Files:** `src/cli.js:4096-4118, 4122-4166`; `scripts/build-image.sh:1`;
`scripts/build-jail-image.sh`.

**Path.** The command CLAUDE.md and README tell a global-add user to run
resolves the bundled script and then:

```js
spawn('bash', [script], { cwd: path.dirname(path.dirname(script)), stdio: 'inherit' })
```

`error` is caught and printed (`cli.js:4113-4117`). On Windows without
Git Bash / WSL `bash.exe`, that is `ENOENT` for `bash` — a dead end after
`yarn global add` otherwise succeeded.

**Trigger.** Plan's Windows 10/11 mass path, or a locked-down Linux with
no `bash` (rare).

**Proposed fix (not applied).** Drive `docker build` from Node
(`dockerode` or `spawn(process.env.ComSpec or 'docker', …)` with
`shell: false`). Keep the shell scripts as a repo-checkout convenience,
not as the only implementation.

---

### MO9 — med — installer supply chain: unsigned pipes, docker group, no checksums

**Files:** `scripts/install.sh:26-55, 114-117, 198-201`.

**Path.** As user (or as root — no EUID check):

| Step | Command | Pin | Checksum |
|---|---|---|---|
| nvm | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh \| bash` | version in URL | none (`2>/dev/null`) |
| Node | `nvm install 22` *or* NodeSource `setup_22.x \| sudo -E bash -` then apt/dnf | major 22 | none |
| Docker (choice 1 / missing) | `curl -fsSL https://get.docker.com \| sh` then `sudo usermod -aG docker "$USER"` | none | none |
| dispatcher | `git clone` 404 URL / `vlatest` tarball | `latest` | none |

`curl | bash` of the installer itself is the plan's primary path. MITM of
GitHub raw / get.docker.com / NodeSource, or a compromised tag, becomes
root (NodeSource and get.docker.com already `sudo`) and then docker-group
root-equivalent.

PATH: `install.sh:198-201` appends `export PATH="$HOME/.local/bin:$PATH"`
to `.zshrc` if it exists else `.bashrc`, every run, no duplicate guard.

**Trigger.** The plan's `curl | bash`. Interactive "install Docker".
`curl | sudo bash` (script does not refuse).

**Proposed fix (not applied).**
1. Refuse `EUID=0`. Print "run as your user; the script will sudo for
   specific steps".
2. nvm: keep the version pin, add the published sha256 and
   `shasum -a 256 -c`. Official Node tarball to `~/.local` with the
   nodejs.org SHA256SUMS, never NodeSource, never apt `nodejs`.
3. Docker: do not run `get.docker.com` from this script. Detect, explain
   ENOENT vs EACCES, point at distro docs. If you must add the user to
   `docker`, say it is root-equivalent and require a typed `yes`.
4. Dispatcher: `npm i -g @junction41/dispatcher` (integrity is npm's
   sha512 in the lockless global install — still better than an unpinned
   tarball). Do not `git clone` into `~/.j41/dispatcher`.

---

## Prior findings still load-bearing for this plan (not re-opened)

| Prior | Sev then | Why the plan still trips it |
|---|---|---|
| **F7** installer half | high | `install.sh:98-100` / `setup.sh:94-96` still silent `runtime=local`. Start-gate *is* fixed (`cli.js:4320-4330`); dashboard Start cannot pass `--dev-unsafe`. |
| **F4** | med | `cli.js:4770-4774` still prints `✓ Security setup complete` without reading `{success:false}`. |
| **F5** | med | 10 s `Promise.race` still abandons `setup()` while it mutates the host (sudo/apparmor/iptables hang → continue → 8/10 bwrap). |
| **F9** | low | 2.5 s Start liveness vs 10 s first-run security. |
| **F10** | low | `init -n <non-numeric>` still `parseInt` → `✅ NaN agents initialized` (`cli.js:1531,1576`). Plan must not default `init -n 9` anyway. |
| **F11** | low | Data-dir clone. Containment (not in `files`) is gone; remaining collision folded into **MO1**. |
| **F12** | low | `quickstart` still persists runtime unvalidated; default is now `docker`. |
| **I4** | med | quick-check `passed` ignores `warn`; missing iptables is `warn`. |
| **I11** | low | ESM `require` catch; pairs with **MO5**. |
| **I12** | low | No refuse-root on the dispatcher itself. Pairs with **MO9** missing EUID check. |
| **S15** | low | Unrotated log; path/OS half is **MO4**. |
| **D1** | high | **Fixed** (`files` includes scripts + Dockerfiles). Side effect: `install.sh` now ships (**MO1**). |

F1 (throw on empty UTXOs), F3 (quickstart now writes `[provider_keys]`),
F8 (image preflight) are **fixed** on current `main` and are not plan
blockers beyond "don't regress".

---

## Plan-specific threat model

The proposed approach: `curl | bash install.sh` (Linux/Mac) + `install.ps1`
(Windows); Node 22 via nvm or official tarball to `~/.local`; `npm i -g
@junction41/dispatcher` user prefix; never silent `runtime=local`; docker
ENOENT vs EACCES; doctor + TUI share `src/doctor.js`; republish unscoped
`j41-dispatcher` as alias; `build-image` via Node; GPU quota script
Linux-only documented sudo.

Adversarial question: shortest path from untrusted input (installer URL,
npm contents, daemon.json rewrite, Node tarball, GitHub raw, `irm | iex`,
sudo prompt, NTP, overlay2 data-root move) to a bad outcome.

### MUST-FIX-BEFORE-SHIP

1. **Do not ship current `install.sh` as the mass path.** MO1 (404 /
   `vlatest` / data-dir) + F7 silent local + MO9 unsigned pipes. Rewrite
   or replace: npm global add into a user prefix, refuse root, refuse to
   write `runtime=local`, do not `init -n 9`, do not clone into
   `~/.j41/dispatcher`.
2. **Pin and checksum every payload the installer executes.** nvm
   install.sh sha256, Node tarball against nodejs.org SHA256SUMS. No
   NodeSource. No `get.docker.com | sh` from this script. `curl | bash`
   of *our* install.sh is acceptable only if the URL is a tagged,
   checksum-printed one-liner (`curl … | shasum -c` / `sha256sum` line in
   the README) or a commit-pinned raw URL whose hash is in the docs.
3. **Docker diagnosis (MO2) before any config write.** ENOENT / EACCES /
   daemon-down / ok. Never recommend local as production. Disclose
   `docker.sock` = root. `config --runtime local` must warn or require
   `--dev-unsafe`.
4. **CLI Node gate (MO5).** Refuse < 20 at process start, not via
   `engines` warning. Installer never `apt install nodejs`.
5. **npm alias `j41-dispatcher` → current `@junction41/dispatcher`.**
   Live trap is `npm i -g j41-dispatcher` → frozen 2.0.0. Alias is the
   safety net, not the primary. Keep 2.0.0 deprecated. Same `bin` name is
   the point; publish as a thin wrapper / `npm alias` that cannot lag
   `latest`. Token handling out of scope.
6. **`src/doctor.js` as the oracle**, used by CLI `doctor` *and* TUI
   health. Must: Node version, Docker ENOENT vs EACCES, image present,
   clock vs API `Date` (MO6), runtime ≠ local (or local + `--dev-unsafe`
   called out as dev-only), fee-tank EMPTY (already on the header),
   **must not** print WIF / passphrase / provider keys (inspect's local
   subset is the model), **must not** recommend local as production.
   If doctor calls `isInitialized()`, fix the `date` vs `timestamp`
   marker mismatch (`secure-setup` `index.js:110` vs `:278-286`) or it
   will report uninitialized forever.
7. **`build-image` in Node (MO8).** Plan already says this; it is a
   Windows ship gate.
8. **TUI log path (MO4).** `~/.j41/dispatcher/dispatcher.log`, no `tail`,
   no `/tmp`.
9. **win32 ≠ macos (MO3).** Explicit Windows/WSL2 branch or fail closed
   with "use WSL2" — do not run the macOS VM arm.
10. **macOS ≤ 13 fail closed.** `sw_vers` / Darwin check; Docker Desktop
    EOL is not "docker info failed".
11. **First-run security F4/F5.** Honour `{success:false}`; do not
    10 s-timeout a sudo that keeps mutating `/etc/j41`. Hang is better
    than `✓` plus a half-applied host. Continuing at 8/10 bwrap is
    isolation I4; for mass-onboarding, doctor must show the real walls,
    not the banner.
12. **GPU quota script (plan-new, currently MISSING).** Linux-only.
    Print the current `data-root` and `daemon.json`. Require a typed
    `DESTROY-DOCKER-STORAGE` (or similar) before rewrite. Backup
    `daemon.json`. Do not hide `containerd-snapshotter: false` (this
    *disables* Docker 29's default overlayfs — labour keeps working;
    GPU becomes cappable). Never auto-move `/var/lib/docker` without
    that consent. Do not relax `HOME_GPU_NO_DISK_QUOTA`.
13. **`install.ps1`:** do not document `irm \| iex` without a checksum /
    Authenticode story. Prefer `winget`/nvm-windows + `npm i -g` inside
    WSL2, where Linux `install.sh` applies. Named-pipe ACL: same
    disclosure as docker.sock (Administrator-equivalent). ExecutionPolicy
    RemoteSigned is the user's call; the script must not silently
    `-Bypass`.

### Accept-risk

| Risk | Why accept |
|---|---|
| `curl \| bash` of a **pinned, checksummed** install.sh | Same shape as rustup/nvm. Residual MITM of the *checksum publication* (README / GitHub release) is the project-account compromise case, which also covers npm. |
| `docker` group = root | Inherent in Docker's design. Disclose (MUST-FIX #3); do not try to "fix" with rootless in v1 of the mass path. |
| `CLOCK_SKEW_MS = 5 min` | Standard Stripe-style window. Do not enlarge. Detect large skew (MUST-FIX #6); bounded replay inside 5 min is the cost of signed envelopes. An NTP attacker who can hold the clock inside that window is already on the box or the LAN. |
| overlay2+ext4 cannot cap `disk_gb` | Docker limitation. Fail-closed for Cat-1 is correct. Labour does not need it (claim H4). |
| npm alias account takeover | If the unscoped name is ours, 2FA/publish tokens are the control; procedure says out of scope. Stale 2.0.0 is worse than an alias we own. |
| Official Node tarball to `~/.local` | Trust nodejs.org + SHA256SUMS. Prefer over nvm's second-hop installer if both are offered. |
| WSL2 as the real Windows runtime | Docker Desktop on native Windows is a second engine with npipe ACLs. Shipping "Windows = WSL2 Ubuntu" and failing closed outside it is an acceptable cut; document it. |
| First-run sudo for AppArmor/iptables | Some walls need root. Doctor should say "not applied (no sudo)" rather than timeout-and-continue. Optional walls staying optional is isolation I4; don't paper over it with a `✓`. |

### Explicitly not a ship gate (checked clean for this domain)

- `start` refuse-before-accept without `--dev-unsafe` (`cli.js:4320-4330`).
- Dashboard Start **cannot** pass `--dev-unsafe` (keep).
- Mainnet gate includes `--dev-unsafe` and now sees `cfg.runtime`
  hatches (`mainnet-guard.js:33-36`, `cli.js:4199-4203`).
- `HOME_GPU_NO_DISK_QUOTA` fail-closed, including Docker 29 `overlayfs`
  (`docker-host.js:28-60`). Do not relax.
- Job-image preflight before accept (`cli.js:4347-4356`).
- Fee-tank EMPTY on the first TUI screen (`dashboard.js:293-297`).
- `inspect` local dump does not print WIF (`cli.js:3238-3242`).
- `package.json` `files` includes build inputs (D1 fixed).
- Labour `start` does not require XFS/prjquota.
- No `daemon.json` rewrite in current tree (good; keep it opt-in).

---

## Adversarial pass (shortest paths in this domain)

Untrusted inputs for *mass-onboarding* are not buyer chat; they are the
install channel, the package, the host clock, and the Docker daemon.

1. **`curl | bash` a 404 / MITM installer (MO1, MO9).** Today the clone
   URL 404s so the script fails closed by accident. Once pointed at a
   live repo without checksums, the pipe is root-capable (NodeSource,
   get.docker.com, `usermod docker`). Shortest *successful* bad outcome
   after a URL fix that does not add pins.

2. **`npm i -g j41-dispatcher` (unscoped).** Live: frozen 2.0.0, which
   predates the F7 start-gate, the image preflight, and the current
   broker defaults. Operator thinks they installed Junction41. Plan
   alias is the fix; until then the README scoped name is the only
   honest door.

3. **Docker group without disclosure, then a malicious container later.**
   Not an onboarding bug by itself; hiding it in `usermod` + "log out"
   is. Folded into MO2/MO9.

4. **EACCES → `config --runtime local` → dashboard Start dead (MO2).**
   No money taken (F7 start-gate holds). Soft-launch failure: "I
   installed Docker and it still won't start."

5. **NTP / clock (MO6).** 65 min forward: cannot log in, cannot `setup`.
   Looks like platform outage. Replay only inside 5 min.

6. **GPU quota script (plan, not current code).** Rewrite `daemon.json` +
   move `/var/lib/docker` without a consent phrase: data-loss of every
   container/image on the box. Must not be implicit in `install.sh`.

7. **`/tmp/dispatcher.log` precreate (MO4).** Local co-tenant reads job
   text. Not remote.

8. **win32 → macos branch (MO3).** First-run security lies; iptables
   sudo prompts on a machine that has none. Combined with bash-less
   `build-image`, Windows native is a dead product until WSL2-or-fail.

No path was found from installer input to WIF exfiltration in *current*
code: `inspect` does not print it, dashboard Start does not pass it,
`install.sh` grepping `keys.json` for `"address"` (`setup.sh:131`) does
not print `wif`. `setup.sh` is not in the npm tarball. Keep doctor on
that side of the line.

---

## Checked and found clean (this domain)

- `start` local-mode gate fires **before** PID file / accept / poll
  (`cli.js:4311-4330`). Second gate inside `startJobLocal` (`:11140-11154`).
- `--dev-unsafe` on mainnet is a hard violation (`mainnet-guard.js:33`).
- Dashboard Start spawn args are `['start']` only — cannot smuggle
  `--dev-unsafe` from the TUI.
- 30 s local-mode warning timer when `--dev-unsafe` is actually set
  (`cli.js:4386-4392`).
- Job image and home-gpu jail image preflight on `start`
  (`cli.js:4347-4382`).
- `getRuntime()` default is `docker` when `config.json` is absent
  (`config.js:16,41-42`).
- `supportsStorageOpt` fail-closed for non-overlay2 / non-pquota,
  including Docker 29 `overlayfs`; labour does not consult it.
- `assertHomeGpuHostReady` still requires NVIDIA runtime + disk quota +
  jail image.
- Fee-tank EMPTY banner on the TUI first screen.
- `inspect` local JSON/text omits WIF.
- `printFundingInstructions({seeded:true})` no longer sends newcomers to
  a faucet; `setup` does not pause for coins (`cli.js:3601-3609`).
- F1 empty-UTXO path **throws** (`cli.js:1185-1206`).
- F3 quickstart persists `[provider_keys]` (`cli.js:1487-1502`).
- `package.json` `repository` URL matches the live remote (`autobb888`).
- No current script rewrites `/etc/docker/daemon.json`.
- `umask(0o077)` at CLI entry (`cli.js:14`) — defense-in-depth for new
  files, not a substitute for MO4's exclusive create.

---

## Deliberately NOT covered, and why

- **Re-opening F1–F12 as new IDs.** Procedure. Status restated in the
  prior table and in claims *(prior)* rows.
- **Money, keys, isolation internals, trust-boundary, liveness, scale**
  except where an onboarding surface is the trigger (MO4 vs S15, MO5 vs
  I11, MO2 vs F7).
- **`recover`, interactive 26-field onboarding, `api-setup` / Cat-2.**
  Not the stock labour first-run. Same cut as first-run.
- **npm publish tokens, 2FA, provenance.** Operator note only.
- **Whether GitHub `junction41/j41-sovagent-dispatcher` 404s right now.**
  Code URL disagrees with `package.json` `repository`; live test already
  recorded the 404. Not re-fetched in this pass.
- **Unscoped `2.0.0` tarball contents** (does it still accept-then-refuse?).
  Live that it *installs*; internals of 2.0.0 are a frozen package, not
  this tree. Plan alias makes it irrelevant.
- **Windows named-pipe ACL matrix, ExecutionPolicy defaults.** No
  `install.ps1` to read. UNVERIFIED / MISSING in claims J2–J3.
- **Platform-side auth window** on `J41-ACCEPT` timestamps. SDK client
  sends `Date.now()/1000`; the verifier is `api.junction41.io`.
- **Running any code.** No `npm pack`, no `node --check`, no docker, no
  network. Every finding traces to a file:line and a reachable path.
