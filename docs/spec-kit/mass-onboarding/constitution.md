# Constitution — Dispatcher mass-use onboarding

Non-negotiable constraints. Implementation that violates an article is a bug,
not a trade-off. This constitution governs the installer, `doctor`, TUI, npm
alias, docs, and first-run labour path. GPU rental is a Linux-host chapter; it
does not rewrite these rules.

Status: **ratified for mass-onboarding design (2026-09-04)**. Product code is
still `@junction41/dispatcher@2.36.0`. These articles are the target; they are
not yet true of `scripts/install.sh` or `src/dashboard.js`.

---

## I. Security defaults stay the production defaults

- Docker runtime is the only mass-use runtime. Local process mode is
  development-only and requires an explicit `--dev-unsafe` on `start`.
- The installer, TUI Start, and any non-interactive `curl | bash` path **MUST
  NOT** write `runtime: "local"` into `~/.j41/dispatcher/config.json`.
- TUI Start **MUST NOT** grow a `--dev-unsafe` switch. The dashboard cannot pass
  that flag today (`src/dashboard.js` ~3927–3936); keep it that way.
- `start` already refuses local mode without `--dev-unsafe` before any job is
  accepted (`src/cli.js` 4320–4330). That gate stays. Installers must not
  produce the state it refuses.
- Mainnet security gate, spend-policy `approval = "always"`, signing broker
  default-on, and fail-closed keystore unlock are out of scope to weaken.

## II. No silent local runtime

- Missing Docker is a **fail**, not a prompt whose default is local, and not a
  silent `RUNTIME=local` when stdin is not a TTY.
- Current bug to kill: `scripts/install.sh` 97–100 (piped install → local) and
  `setup.sh` 93–96 (same). Replacement: print a copy-paste Docker install block
  and exit non-zero.
- `getActiveJobs` **MUST NOT** tell the operator `config --runtime local` on
  Docker `ENOENT`, `EACCES`, or any other dockerode error (`src/cli.js`
  1256–1268). Distinguish sock-missing from permission-denied; never prescribe
  zero isolation.

## III. Never `apt install nodejs` (or distro Node as the path)

- `engines.node` is `>=20.0.0` (`package.json` 61–63). Ubuntu 24.04 apt
  `nodejs` is 18.19.1. Debian 12 apt Node is 18 unless backports. Distro Node
  is how a two-liner dies on a stock box.
- Installer Node bootstrap order:
  1. already-valid `node` (≥20) on PATH
  2. nvm (`nvm install 22`)
  3. official Node tarball → `~/.local/node` (Linux only)
  4. fail with a copy-paste block pointing at https://nodejs.org/
- **MUST NOT** `apt-get install nodejs`, `dnf install nodejs`,
  `pacman -S nodejs`, or nodesource `setup_22.x | sudo bash` as the mass-use
  path. Current `install.sh` 40–47 does exactly that — delete those branches.
- Homebrew `node@22` / `node` is acceptable on Darwin **if** the resulting
  binary is ≥20. Homebrew `docker` is the CLI only and **MUST NOT** be
  installed as “the daemon”.

## IV. GPU is Linux NVIDIA only

- Labour (kind `agent`) is the download on every supported OS. Cat-1
  `gpu-rental` is a Linux host chapter, not first-run.
- `HOME_GPU_NO_DISK_QUOTA` stays fail-closed (`src/docker-host.js`
  `supportsStorageOpt`: overlay2 + XFS `prjquota`/`pquota`, or btrfs/zfs).
  Docker 29 default `overlayfs` (containerd snapshotter) cannot cap `disk_gb`.
  Do not weaken the gate. Do not auto-reconfigure the daemon’s data-root.
- TUI **MUST NOT** offer kind `compute` (or rental-setup / compute-provider
  screens) when `process.platform` is `darwin` or `win32`. Doctor GPU checks
  are `skip` on those platforms, never `fail` for “no NVIDIA”.
- Do not mint `sovdata` / `sovmodel` as first-run listings. Kind rails: labour
  needs an LLM; data is browse-only; model needs `api-setup` + a public URL.

## V. No secrets in doctor or TUI

- `doctor` (CLI table, `--json`, TUI Doctor/Status) **MUST NOT** print WIFs,
  npm tokens, provider API keys, keystore passphrases, `RENTAL_SECRETS_KEY`,
  or control-API tokens.
- Presence may be reported (`llm.configured = true`, `keystore.encrypted =
  true`). Values must not appear in `detail`, `nextCommand`, `copyPasteBlock`,
  or JSON.
- Redact anything matching `sk-`, `gsk_`, `Uw`, `wif`, `npm_`, bearer tokens.
- TUI already forwards provider keys into job containers only; doctor must not
  become a second place those strings leak.

## VI. npm `files` list is the product

- What is not in `package.json` `files` does not exist for `yarn global add`.
- Today the list is `src`, `templates`, `scripts`, `Dockerfile.job-agent`,
  `Dockerfile.gpu-jail`, `package.docker.json`, `README.md`, `CHANGELOG.md`,
  `LICENSE` (`package.json` 8–18). It omits `docs/`, `docs/config.toml.example`,
  and `JAILBOX_PARKED.md` (README still links the last).
- First-run docs that README or `doctor.copyPasteBlock` name **MUST** ship in
  the tarball. A GPU quota helper script, if documented, **MUST** ship in
  `scripts/` (already in `files`).
- `npm pack` + a scratch `HOME` is the code gate. npm publish of the scoped
  package and the unscoped alias may wait on a key; pack must not.

## VII. Fail closed

- Unsupported OS (macOS ≤13, Windows without Docker Desktop WSL2, unknown
  `process.platform`) → doctor `fail`, installer exit non-zero. No “try local
  mode”. No “it might work”.
- Clock skew beyond the signed-window safety margin → doctor `fail` with NTP
  copy-paste, not “platform down”.
- Missing job-agent image → `start` already refuses before accept. Doctor
  reports the same fact with `j41-dispatcher build-image`.
- Unreadable / malformed state files stay fail-closed (`loadFinalizeState`
  already refuses to treat corrupt `finalize-state.json` as “never finalized”).
- `supportsStorageOpt` returns false on unknown drivers, unreadable `mount`,
  and Docker 29 `overlayfs`. Keep that. Add an explicit `overlayfs` unit test;
  do not add a success path for it.

## VIII. One doctor module, two surfaces

- `src/doctor.js` is the only classifier. CLI `j41-dispatcher doctor` and the
  TUI header / Doctor / Status screens **MUST** consume it. Duplicating OS
  sniffing in `dashboard.js` is a bug.
- Words mean one thing: “registered” is on-chain identity, not a local
  `keys.json`. `listRegisteredAgents()` today returns directory names
  (`src/cli.js` 487–492); `status` and the TUI header print that count as
  “registered” (6269, dashboard 276). That language is a lie. Fix both in the
  same wave.

## IX. Honesty over warmth

- Copy-paste blocks name the next command that actually works on this OS.
- Docker group lag is `newgrp docker` / new terminal, not “Docker is broken”.
- Sock `ENOENT` vs `EACCES` vs daemon-not-running are three failures.
- 32 fee-tank writes is **LOW**, not EMPTY. Floor is 100 writes
  (`src/fee-tank.js` `DEFAULT_FLOOR_WRITES`). EMPTY is `feeSats <= 0`.
- `inspect` “No services registered” after a live gpu-rental is a classifier
  bug (VDXF snapshot vs marketplace services). Do not teach it in doctor.

## X. Labour is first useful work; GPU is a chapter

- First-run success: Node ≥20, Docker reachable, one labour listing
  (`setup` + LLM + `build-image` job-agent + `start` polling).
- Do not default `init -n 9`. `setup <id> <name> --template <tpl>` is the
  one-command pipeline. `init -n 9` remains for operators who want a pool.
- `build-image` on the labour path builds `j41/job-agent`. `j41/gpu-jail` is
  required only on the Linux GPU chapter (or `--gpu`). Do not spend first-run
  minutes building a jail image the host cannot use.

---

Amendments require an explicit product decision in this directory. Silent
exceptions in installer flags or TUI confirm-defaults are not amendments.
