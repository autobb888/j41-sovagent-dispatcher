# Tasks — PR / wave map

Code gate for every wave: tests + `npm pack` + scratch `HOME`. npm publish of
scoped latest and the unscoped alias may wait 1–2 days for a key; that wait
does **not** block merging.

Do not start Wave 3 until Wave 2 classifiers exist — TUI copy is the same PR
as CLI doctor, not a follow-up.

---

## Wave 0 — npm + docs

**Goal:** stop sending people to 2.0.0 and Node 18. No behaviour change in
`start` yet.

**PR 0.1 — docs honesty (j41-docs + dispatcher README)**

- [ ] README install snippet: only `yarn global add @junction41/dispatcher`
      (or alias if 0.2 landed). Repo URL `autobb888`. Next step `doctor` once
      Wave 2 exists; until then `setup` + `build-image` + `start`.
- [ ] Drop `init -n 9` from first-run (keep as advanced).
- [ ] `j41-docs/docs/getting-started/dispatcher-quickstart.md`: Node **20+**,
      no “3 pre-registered VerusIDs” + pasted WIFs as the path; point at
      `setup`.
- [ ] `j41-docs/docs/dispatcher/setup.md`: Node 20+, clone URL already
      autobb888 — keep; add two-liner when Wave 1 URL is stable.
- [ ] `j41-docs/docs/getting-started/sovagent-quickstart.md`: dispatcher path
      must not require a local Verus daemon.
- [ ] If alias publish is blocked: grep both repos for `yarn global add
      j41-dispatcher` / `npm i -g j41-dispatcher` and delete those lines the
      same day.

**PR 0.2 — unscoped alias package**

- [ ] Add `packages/j41-dispatcher-alias/` (`name: j41-dispatcher`, dep
      `@junction41/dispatcher` same version, bin re-export, postinstall
      EEXIST/shadow warning).
- [ ] `npm pack` the alias; scratch prefix; `j41-dispatcher --version` ≥ 2.36.0.
- [ ] Publish when the human has a working npmjs token. **Human gate.**
- [ ] If ownership fails: close PR 0.2, finish the grep in 0.1, do not leave
      a half-alias.

**PR 0.3 — `package.json` `files`**

- [ ] Include `docs/config.toml.example`, `JAILBOX_PARKED.md`.
- [ ] Confirm `scripts/` still includes build scripts.
- [ ] `npm pack` and assert those paths exist in the tarball.
- [ ] Do not pack `docs/spec-kit/`.

**Exit:** a stranger with Node ≥20 can `yarn global add @junction41/dispatcher`
and not hit 2.0.0 docs. Stock Ubuntu still cannot npm until Wave 1.

---

## Wave 1 — installer

**Goal:** stock Ubuntu 24.04 two-liner works; no silent local; no apt Node.

**PR 1.1 — rewrite `scripts/install.sh`**

- [ ] Delete `REPO_URL` clone and `releases/download/v${J41_VERSION}`.
- [ ] Node: existing ≥20, else nvm 22, else official tarball → `~/.local/node`.
- [ ] **Delete** apt/dnf/nodesource/brew-docker branches (`install.sh` 40–50
      and Docker-local fallback 97–129).
- [ ] Docker missing: Linux `get.docker.com` + group + `newgrp` message, or
      exit 1. Darwin: Docker Desktop URL, exit 1 if daemon down. Never write
      `runtime=local`.
- [ ] macOS ≤13: fail closed (kernel major < 23).
- [ ] `yarn global add @junction41/dispatcher` (honour `J41_DISPATCHER_VERSION`
      for tests).
- [ ] Next-step banner: `j41-dispatcher doctor` (stub message ok if Wave 2
      not merged; prefer merging 1.1 after 2.1 or print `setup` until doctor
      exists). **Decision:** land 2.1 before 1.1 *or* print both `doctor` and
      `setup` so a missing command is not the only next step. Prefer **Wave 2
      before Wave 1 merge** if they cannot ship the same day.
- [ ] `setup.sh` becomes a wrapper/deprecation, no `init -n 9`.

**PR 1.2 — `scripts/install.ps1`**

- [ ] Node 22, yarn, Docker Desktop WSL2 check, yarn global add, doctor next.
- [ ] Hyper-V-only: exit 1 with WSL2 copy-paste.

**PR 1.3 — secure-setup `win32`** (can be parallel; other repo)

- [ ] `detect-platform.js`: stop `distro = 'macos'` on non-linux.
- [ ] Tests allow `os === 'win32'`.
- [ ] No gVisor install on win32/darwin.

**PR 1.4 — installer smoke (labour)**

- [ ] Ubuntu 24.04 VM: two-liner, `node -v` ≥20, no apt nodejs 18 as the bin,
      `j41-dispatcher --version`, no `runtime: local` in `config.json`.
- [ ] Document the raw.githubusercontent.com URL in README once the script is
      on `main`.

**Exit:** curl | bash on stock 24.04 gets a dispatcher bin without local mode.

---

## Wave 2 — doctor + TUI honesty

**Goal:** one classifier; CLI and TUI tell the same story. This is the
honesty wave; do not split CLI vs TUI.

**PR 2.1 — `src/doctor.js` + `src/docker-connect.js` + CLI**

- [ ] Implement `DoctorReport` (`data-model.md`) and table/JSON
      (`contracts/doctor.md`).
- [ ] `j41-dispatcher doctor` / `--json`.
- [ ] Fixtures in `test/doctor.test.js` (2.0.0, node 18, macOS 13, EACCES,
      clock 65m, 32 writes LOW, overlayfs skip on darwin).
- [ ] `getActiveJobs` 1256–1268: remove `config --runtime local`; use
      ENOENT/EACCES/daemon classes.
- [ ] `status` 6268–6270: identity stages, not “N registered”.
- [ ] Source-scan test: CLI+dashboard must not contain
      `config --runtime local` as advice.
- [ ] Replace `new Docker()` (127, 8549) with `resolveDockerHandle()`.

**PR 2.2 — TUI consumes doctor (same merge as 2.1 if possible)**

- [ ] Header: identity summary; no `Agents: ${n} registered`.
- [ ] Status & Health: doctor table.
- [ ] Start: disable/explain from `report.ok` / `runtime` fail; still no
      `--dev-unsafe`.
- [ ] Kind list: hide `compute` when `!gpuOffered`.
- [ ] Fee tank banner: EMPTY only for empty-*; LOW for writes < 100.
- [ ] Test: `test/dashboard-security-menu.test.js` / friend-boot style scan
      for `Agents: .* registered` and EMPTY-on-low.

**Exit:** `doctor --json` schema-stable; TUI header cannot call local folders
“registered”.

---

## Wave 3 — labour first useful work

**Goal:** setup + LLM + job-agent image + start log path. Windows can
`build-image` without bash.

**PR 3.1 — Node-driven `src/build-image.js`**

- [ ] `build-image` spawns `docker`, not `bash`.
- [ ] Default: `j41/job-agent` only. `--gpu` builds `j41/gpu-jail`.
- [ ] `scripts/build-image.sh` wraps `node src/cli.js build-image`.
- [ ] Tests: argv assertion; labour does not require jail image for exit 0.

**PR 3.2 — TUI Start log path**

- [ ] `~/.j41/dispatcher/dispatcher.log` (0600/0700).
- [ ] `resolveDispatcherLogPath` prefers it; `/tmp/dispatcher.log` legacy tail.
- [ ] View Logs honest if neither exists.

**PR 3.3 — labour copy**

- [ ] Installer/docs/TUI first-run: one `setup --template`, LLM screen,
      `build-image`, `start`.
- [ ] Keep `start` unregistered-fleet exit 1 (`cli.js:4623-4645`).
- [ ] Preflight LLM warn in doctor already; no change to fail-closed accept
      gate.

**Exit:** scratch HOME + packed tarball can doctor → (mocked) setup →
build-image job-agent on a machine with Docker and no bash-as-docker-builder.

---

## Wave 4 — GPU Linux-only

**Goal:** do not offer compute on darwin/win32; do not weaken quota; ship the
quota helper.

**PR 4.1 — TUI/CLI GPU chapter**

- [ ] Confirm `gpuOffered` false on darwin/win32 (Wave 2) and CLI
      `rental-setup` prints the Linux chapter pointer on those OS.
- [ ] `image.gpu-jail` skip unless linux+nvidia or `--gpu`.
- [ ] `test/docker-host.test.js`: explicit `driver: 'overlayfs'` → false.
- [ ] Do **not** change `supportsStorageOpt` success paths.

**PR 4.2 — quota script + docs (Linux)**

- [ ] Ship `scripts/enable-docker-disk-quota.sh` (operator-run, sudo, data-root
      move). Document; do not run from installer.
- [ ] GPU chapter in j41-docs: NTP, nvidia-container-toolkit,
      overlay2 + XFS prjquota + `containerd-snapshotter: false`.
- [ ] Distro matrix: GPU cell verified only where we have run it (Ubuntu
      24.04). Other distros: unverified.

**Exit:** Mac/Windows TUI cannot sign up compute. Linux overlayfs still
fail-closed.

---

## Wave 5 — acceptance matrix

**Goal:** prove the stories on real boxes. Tester kit stays in `~/j41-testkit`.
Never copy `~/.j41` between machines.

| Cell | Expect |
|------|--------|
| Ubuntu 24.04 stock VM, two-liner | doctor pass or docker.group fail with newgrp; never local |
| Ubuntu 24.04 apt nodejs 18 present | installer still yields node ≥20 for dispatcher |
| Ubuntu 22.04 | same labour path |
| Debian 12 / Fedora / Arch | nvm/tarball; no invented packages; record `doctor --json` |
| macOS 14+ Docker Desktop | labour doctor pass; compute hidden; sock Desktop path |
| macOS 14 brew docker only | daemon fail, Desktop copy-paste |
| macOS ≤13 | installer + doctor fail closed |
| Windows 11 Docker Desktop WSL2 | install.ps1 + doctor; build-image without bash |
| Windows Hyper-V Docker | os fail |
| WSL2 clock skew | clock fail + hwclock hint |
| PATH bin 2.0.0 | package fail, scoped nextCommand |
| linux overlayfs + compute | HOME_GPU_NO_DISK_QUOTA |
| `npm pack` scratch HOME | doctor --json works offline for os/node/package |

- [ ] Checklists live in `docs/testing/` (not packed) and this file.
- [ ] Capture `doctor --json` per cell (redact nothing because there must be
      no secrets).
- [ ] Labour smoke: `setup` + LLM dummy + `start` refuses or runs without
      taking a job in local mode.

**Exit:** Wave 5 sign-off is human. Code is done when Wave 4 merged and
Ubuntu 24.04 + one Darwin 14 + one Win11 WSL2 cell are recorded.

---

## Suggested merge order (if serial)

```
0.1 docs ─┬─ 0.2 alias (token)
          └─ 0.3 files
2.1+2.2 doctor+TUI
3.1 build-image + 3.2 log path
1.1+1.2 installer (uses doctor in banner)
4.1+4.2 GPU chapter
5 matrix
1.3 secure-setup win32 (parallel anytime after 0)
```

If the installer must ship before doctor, banner both `doctor` and `setup`
and follow with Wave 2 immediately — do not let TUI keep the old lies.

---

## Explicitly not scheduled

- Auto `daemon.json` rewrite
- `init -n 9` as default
- TUI `--dev-unsafe`
- sovdata/sovmodel first-run
- Native Hyper-V support
- Colima/OrbStack installer default
