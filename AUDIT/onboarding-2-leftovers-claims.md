# Claims — onboarding-2 leftovers (2026-09-04)

Spec: `docs/superpowers/specs/2026-09-04-onboarding-2-leftovers-design.md`
Tester: ONBOARDING-TEST-2.0.md (2.37.0 retest)

| # | Claim | Surface | Verdict | Notes |
| --- | --- | --- | --- | --- |
| A1 | Below floor + remaining writes + nothing to sweep is `below-floor-unfunded`, not `needs-external-funding` | `fee-tank.js:151-159` `planFeeSweep` | **VERIFIED** | EMPTY only when `feeSats < txFeeSats` (cannot afford one write). 32×FEE_SATS → LOW. |
| A2 | Start logs `FEE TANK LOW` for that reason and does **not** set `_agentErrors` | `cli.js:10146-10154` | **VERIFIED** | Retracts a stale EMPTY prefix. |
| A3 | Doctor auto-loads `fee-tank-status.json` when `feeTankRows` is omitted | `doctor.js:247-256,307-310` | **VERIFIED** | TUI `runDoctor({ llm, … })` omits rows → auto-load. CLI `doctorLiveInputs()` same. |
| A4 | Doctor detail for 32 writes is `low`, must not contain EMPTY | `doctor.js:268-269` + `test/doctor.test.js` | **VERIFIED** | |
| A5 | `/health` must not degrade from a LOW tank | `cli.js:10146-10154` + `control.js:548` lastError term | **VERIFIED** for LOW (no lastError). EMPTY lastError still degrades after `startupComplete` — pre-existing, not this pass. |
| B1 | CLI `start` opens `~/.j41/dispatcher/dispatcher.log` (`0600`, `O_NOFOLLOW`) | `dispatcher-log.js:24-36` called from `cli.js:4213` | **VERIFIED** | Skipped when `NODE_ENV=test`. |
| B2 | If stdout is already that inode (TUI spawn), do not tee | `dispatcher-log.js:15-21,41-43` | **VERIFIED** | |
| B3 | Otherwise tee stdout+stderr and keep the terminal | `dispatcher-log.js:44-55` | **VERIFIED** | |
| C1 | Before first-run secure-setup, resolve `job-agent.js` from this package | `job-agent-path.js:12-26` `__dirname/job-agent.js` | **VERIFIED** | Running CLI is the scoped package even under the alias. |
| C2 | If secure-setup search paths miss, symlink `$(npm prefix -g)/lib/node_modules/@junction41/dispatcher` → package root | `job-agent-path.js` + `cli.js` start + `scripts/postinstall.js` + alias `bin/postinstall.js` + TUI `securityScreen` | **VERIFIED** | O2-1: not start-only. Empty dest dir and dangling symlink are replaced. |
| C3 | Never overwrite a real directory | `job-agent-path.js:74-78` | **VERIFIED** | Empty dest dir also refused (`dest-exists`). |
| D1 | `hire` fail paths exit 1 for local keys without identity | `cli.js:2816-2820` `test/hire-json.test.js` | **VERIFIED** | Tester’s exit 0 was **not** reproduced; fail() was already exit 1. `process.exitCode=1` added. Missing `--amount` also non-zero. |
| D2 | Success and “Cancelled.” stay exit 0 | `cli.js` confirmHire `process.exit(0)` | **VERIFIED** | Untouched. |
| E1 | `ubuntu:24.04` guest without Node/Docker: Node v22.19.0 at `~/.local/node`, exit 1, no `runtime=local` | `test/install-container-smoke.test.js` | **VERIFIED** | Ran this host: pass ~26s. `J41_SKIP_NPM=1` — npm i -g **not** exercised in the guest. |
| F1 | Start banner is identity summary, not `Registered agents: N` | `cli.js:4437` | **VERIFIED** | |
| G1 | Must not regress local `--dev-unsafe` refuse-before-accept, TUI cannot pass it, job-image preflight, `HOME_GPU_NO_DISK_QUOTA` | no edits to those gates | **VERIFIED** | Untouched this pass. |
