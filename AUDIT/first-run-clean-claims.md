# first-run-clean — claims checklist

**Date:** 2026-09-15 · **HEAD:** `5ca8776` · **Domain:** the 2026-09-15
clean GitHub clone walk — install / doctor / build-image / first agent /
first `start` — after the 12 first-run PRs landed on this integrate branch.

This is a **new** domain. Prior first-run (2026-08-10), mass-onboarding
(2026-09-04), and onboarding-2-leftovers (2026-09-04) are cited as prior IDs,
not skipped.

Sources enumerated:

- `README.md` — Install (27-46), Quick Start / Before you begin (49-83),
  CLI table rows for `doctor` / `setup` / `start` / `build-image` /
  `quickstart` / `init`, Runtime Modes (615-638), First-Run Security Setup
  (1100-1111), Local Mode (1147-1154), Security Self-Test (1168-1173).
- `CLAUDE.md` — Quick Reference block.
- `scripts/install.sh` header (1-8) and main (249-292).
- Operator-facing strings: `src/doctor.js` `formatDoctorTable` / `pickNext` /
  `identityNext`; `src/cli.js` `quickstart` / `init` / `setup` / `start` /
  `build-image`; `src/dashboard.js` Start button; `src/tui/start-ready.js`.

Status key: **VERIFIED** (HEAD does what is claimed) · **DRIFT** (HEAD
differs — how is stated) · **MISSING** (no implementation found) ·
**UNVERIFIED**. Rows marked *(prior)* restate an earlier pass; status is
re-derived against HEAD, not copied blindly.

**48 claims — 38 VERIFIED · 8 DRIFT · 0 MISSING · 2 UNVERIFIED.**

---

## A. Install, clone, PATH, published version

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| A1 | `curl …/main/scripts/install.sh \| bash` is the stock install | README:33-36 | **DRIFT** → **FRC1** | `install.sh:212-219` runs `npm install -g --prefix ~/.local @junction41/dispatcher` with no commit pin. Registry `@junction41/dispatcher@2.37.3` is release `1a340d8` (2026-09-05). HEAD `5ca8776` is still `"version": "2.37.3"` (`package.json:3`) but is **not** that tarball — Node 20 gate, F4/F5 rewrite, probeClock, F6 merge, F9 Health-seek are all after `1a340d8`. |
| A2 | `npm install -g j41-dispatcher` or `@junction41/dispatcher` installs this product | README:39-44 | **DRIFT** → **FRC1** | Unscoped alias `packages/j41-dispatcher-alias/package.json:21` depends on `"@junction41/dispatcher": "2.37.3"`. Same published tarball as A1. |
| A3 | Installer does not clone git and does not write a process-mode runtime | `install.sh:6-8` | **VERIFIED** | Header matches body: `npm_user_install` only; no `git clone`; no `config.json` `runtime=` write. Missing Docker prints a copy-paste block and `exit 1` (`install.sh:226-269`). |
| A4 | Installer Node pin is 22 with checksums; distro nodejs is refused | `install.sh:12-14,57-117`; README:29 | **VERIFIED** | `NODE_PIN="22.19.0"` + `sha256sum -c`; `node_major >= 20` short-circuits; Ubuntu apt 18 never selected. |
| A5 | A GH clone has `j41-dispatcher` on PATH after following README | implied by every README/doctor Next line | **DRIFT** → **FRC2** | README Install never says `git clone`. A clone of this tree does not put `j41-dispatcher` on PATH. `doctor.js:489` sets `pathBinaryVersion` to `packageVersion` and never execs `j41-dispatcher --version`. `formatDoctorTable` (`:943,960`) and `identityNext` (`:314`) always print `j41-dispatcher …`. Observed live: clone doctor Next is `j41-dispatcher build-image`. |
| A6 | `doctor` is read-only — no `~/.j41` created | observed live; `doctor.js` header "Read-only" | **VERIFIED** | `cli.js:7809-7818` doctor action does not call `ensureDirs()`. `loadDispatcherConfig()` (`config-loader.js:468-494`) reads; `mkdirSync` is only on save (`:326`). Observed live: no `~/.j41` after clone doctor. |
| A7 | `setup.sh` is the one-shot installer | leftover from F7 | **VERIFIED (safe)** | `setup.sh:1-10` is a deprecation wrapper that `exec`s `scripts/install.sh`. |

## B. Doctor Next (images → build-image; then 0 identities → setup)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| B1 | Missing `j41/job-agent:latest` → Next `j41-dispatcher build-image` | observed; `doctor.js:686-689` | **VERIFIED** | `hasImage('job-agent')` fail sets `nextCommand: 'j41-dispatcher build-image'`. `pickNext` (`:355-367`) takes `fails[0]` before identity warn. Check order puts `image.job-agent` before `identity`. Observed live. |
| B2 | After images exist, 0 identities, doctor exit 0, Next is `setup agent-1 --template code-review` | observed; `doctor.js:748-751,311-316,925` | **VERIFIED** | Identity is `warn` not `fail`. `ok = checks.every(c => c.status !== 'fail')` (`:925`) → exit 0 (`cli.js:7817`). `identityNext([])` is `j41-dispatcher setup agent-1 <name> --template code-review`. Observed live. |
| B3 | Doctor never recommends `config --runtime local` | `doctor.js:3-4,722-726` | **VERIFIED** | `runtime === 'local'` is a **fail** whose Next is `config --runtime docker`. |
| B4 | Docker EACCES is "new terminal / newgrp docker", not "no Docker" | `doctor.js:622-631` | **VERIFIED** | `docker.group` fail, `docker.daemon` pass, Next `newgrp docker`. |
| B5 | `build-image` builds job-agent **and** gpu-jail | README:54-57,224; CLAUDE.md Quick Reference | **VERIFIED** | `cli.js:5490-5534`. Jail skip-if-exists unless `--force`. |
| B6 | `start` refuses without the job-agent image | README:54; CLAUDE.md | **VERIFIED** | `cli.js:5725-5734` `process.exit(1)` before accept. `NODE_ENV=test` seam only. |

## C. Node 20 gate and ESM split

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| C1 | CLI refuses Node &lt; 20 at process entry (before commander) | README:29; `cli.js:16-20` | **VERIFIED** *(prior MO5, now fixed in HEAD)* | `process.umask(0o077)` then `nodeMajor(process.version) < 20` → `process.exit(1)`. Ubuntu apt 18 cannot reach any command. |
| C2 | Dashboard has the same Node 20 gate | `dashboard.js:7-11` | **VERIFIED** | Identical message and exit. Reached via `cli.js:5430-5432` / no-args `15604-15606` after the CLI gate, and also if `node src/dashboard.js` is invoked directly. |
| C3 | `ERR_REQUIRE_ESM` for `@junction41/secure-setup` is fail-closed, not a silent skip | `cli.js:161-175` | **VERIFIED** | `ERR_REQUIRE_ESM` / `ERR_REQUIRE_ASYNC_MODULE` → "Node 20.19+ required" `process.exit(1)`. `MODULE_NOT_FOUND` still skips (optionalDependency). Other load errors exit 1. |
| C4 | `engines.node >= 20.0.0` is the only Node gate on the published tarball | `package.json:64-66`; `1a340d8` | **DRIFT** → **FRC1** | Published 2.37.3 has the engines field and **no** `cli.js` `nodeMajor` exit (git show `1a340d8:src/cli.js` has no `nodeMajor`). |

## D. First-run security

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| D1 | First `start` does **not** auto-install gVisor / bubblewrap / `/etc/j41` | README:1100-1108 | **VERIFIED** | `cli.js:6202-6243`: `setup()` only if `secureSetup && getuid()===0 && stdin.isTTY`. Else prints `sudo HOME="$HOME" npx @junction41/secure-setup --dispatcher`. No `Promise.race`. |
| D2 | `setup()` `{success:false}` is not reported as ✓ | README; F4 | **VERIFIED** *(prior F4, fixed in HEAD)* | `cli.js:6221-6225` branches on `setupResult.success`. String `✓ Security setup complete` is absent (`test/start-security.test.js:27-38`). Live on npm 2.37.3 (`1a340d8:src/cli.js:5166-5170` still `Promise.race` + unconditional ✓). |
| D3 | There is no 10s race that abandons `setup()` while it keeps mutating the host | F5 | **VERIFIED** *(prior F5, fixed in HEAD)* | No `Promise.race` in the Task 18 block. Root+TTY awaits `setup()` fully (`test/start-security.test.js:82-102` 15s success). |
| D4 | Hung / timed-out `quickCheck` is a failure (fail-closed) | README:1111 | **VERIFIED** | `cli.js:6245-6291`: 10s timer resolves `null`, `checkFailed` if error / !result / !passed, then `process.exit(1)` unless `--dev-unsafe`. `clearTimeout` in `finally`. Not `Promise.race`. |
| D5 | `--dev-unsafe` can continue past a failed quick-check | README:1102-1103; `cli.js:6288-6291` | **VERIFIED** | Clock fail is **not** in this bypass (see F2). |
| D6 | TUI `[6] Security Setup` honours `{success:false}` | `dashboard.js:3218-3226` | **VERIFIED** | Same branch as before F4; unchanged. |
| D7 | "No manual configuration needed" / auto-detects isolation on first start | leftover README:744 from F5 | **VERIFIED (removed)** | Current README:1100-1108 states the opposite. Seven-step auto-install list is gone. |

## E. Dashboard Start

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| E1 | Start success is this child's `[Health]` line after a log seek, then GET 200 — not PID / 2.5s | `dashboard.js:4131-4149`; `tui/start-ready.js` | **VERIFIED** *(prior F9, fixed in HEAD)* | `seekLogEnd` **before** spawn. `waitForDispatcherReady` 60s, `HEALTH_LINE_RE`. Timeout prints "do not assume it is up". Published 2.37.3 still `setTimeout(…, 2500)` (`1a340d8:src/dashboard.js:4014`). |
| E2 | `[Health]` is printed after the security gates | `control.js:131-132`; `cli.js:6202` then `7058-7060` | **VERIFIED** | Identity banner is before gates (`cli.js:5796`); Health bind is after quickCheck. Comment at `dashboard.js:4133` matches. |
| E3 | TUI Start cannot pass `--dev-unsafe` | `dashboard.js:4137` | **VERIFIED** | `spawn(process.execPath, [process.argv[1], 'start'])`. Local runtime → child exits, TUI names it (`:4159-4167`). |

## F. Clock

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| F1c | `probeClock` aborts the API HEAD at 8s | `doctor.js:429` | **VERIFIED** | `AbortSignal.timeout(8000)`. Unreachable API is `warn`, not `fail` (`:420-432`). |
| F2c | Skew &gt; 30s is `fail`; `start` refuses; `--dev-unsafe` does not bypass | `doctor.js:13,441-446`; `cli.js:5763-5778` | **VERIFIED** *(prior MO6, fixed in HEAD)* | `CLOCK_SKEW_MS = 30 * 1000`. `start` `process.exit(1)` on `clock.status === 'fail'` with `ntpBlock`. Comment: `--dev-unsafe does not bypass a fail`. `NODE_ENV=test` skips the live HEAD. |

## G. `init` / `quickstart`

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| G1 | `init -n` must be an integer 1–100 | F10 | **VERIFIED** *(prior F10, fixed)* | `cli.js:1689-1694` `/^\d+$/` then `1..100` else exit 1. Non-numeric no longer prints `NaN agents`. |
| G2 | `quickstart` runtime is only `docker` or `local` | F12 | **VERIFIED** *(prior F12, fixed)* | `persistableRuntime` (`config.js:54-57`) returns `null` otherwise; `cli.js:1615-1619` exit 1. Default prompt is `docker`. |
| G3 | `quickstart` persists the API key where the dispatcher reads it | F3 | **VERIFIED** *(prior F3, fixed)* | `saveDispatcherConfig({ llm: { provider }, provider_keys: { [provider]: apiKey } })` (`cli.js:1644-1650`). Offers `claude-sonnet` not `claude` (`:1588-1594`). Does not create an agent (Next is `setup`); `--help` no longer claims it does. |
| G4 | `config --runtime local` warns that this is ZERO isolation | leftover MO2 | **DRIFT** *(prior MO2 residual)* | `cli.js:1440-1446` accepts `local` with no warning, then `✅ Configuration updated`. Contained by the start-gate (`:5698-5708`) — brick, not a paid job. |

## H. Template merge (F6)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| H1 | `setup --template code-review` merges `markup` and `workspaceCapability` | F6; `templates/code-review/config.json` | **VERIFIED** | `mergeTemplateIntoOptions` (`cli.js:729-774`) + `buildFullProfile`. `test/template-merge.test.js:28-37`. |
| H2 | Template `session.duration` is seconds (no `* 60`) | F6 | **VERIFIED** | `cli.js:757-759`; test `:40-47`. CLI `--session-duration` still minutes via `parseSessionMinutes`. |
| H3 | Custom-template `network.capabilities` survive `setup --template` | original F6; `dashboard.js:1293-1295` | **DRIFT** → **FRC3** | Builder writes `profile.network.capabilities`. Merge copies `network.protocols` (`cli.js:737`) and never `network.capabilities`. `buildFullProfile` then uses `options.profileCapabilities \|\| []` (`:663`). markup / workspace / session **do** merge. |

## I. Prior F1 / F2 / F7 / F8 (re-verified, not re-opened)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| I1 | `publishVdxf` no-UTXO is not recorded as success | F1 | **VERIFIED** *(fixed)* | `cli.js:1300-1320` **throws**. `setup` catches, prints `Setup INCOMPLETE`, `process.exit(1)` (`:4919-4937`). Deletes stale finalize state first (`:4903-4907`). |
| I2 | Junction41 seeds 0.0033 VRSCTEST at registration; operator need not faucet first | README:58-61 | **UNVERIFIED** | Dispatcher prints the claim (`cli.js:4770-4778`, `printFundingInstructions`). Whether the platform actually seeds is `api.junction41.io`. Code no longer pauses for a faucet before `register`. |
| I3 | Keyless ollama/lmstudio/vllm call the model, not canned filler | F2 | **VERIFIED** *(fixed)* | `local-llm.js:63-76` `usable = apiKey \|\| (keyless && baseUrl)`. `generateTemplateResponse` only when `!usable` (`:264-265`). Host preflight (`preflight-gate.js` + `llm-health.js:11`) refuses accept when `baseUrl`/`model` missing or probe not 2xx. |
| I4 | Local runtime without `--dev-unsafe` refuses to **start** (not after payment) | F7 | **VERIFIED** *(fixed)* | `cli.js:5689-5708`. Installer no longer writes `runtime=local`. |
| I5 | Bare `finalize` with no profile does not broadcast an empty CMM | F1 second defect | **VERIFIED** *(fixed)* | `cli.js:1216-1229` throws if `!profile`. `finalize` loads `profile.json` (`:2047-2057`). |

## J. gVisor / isolation claims on first-run docs

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| J1 | Docs do not claim auto-install gVisor without sudo | README:8,623,1065-1108 | **VERIFIED** | Overview: "gVisor applies only if `secure-setup` / `runsc` is present". First-run section: does **not** install; needs `sudo HOME="$HOME" npx …`. |
| J2 | Jail image `LoginGraceTime 60` (not 0) | observed live rebuild; `Dockerfile.gpu-jail` | **VERIFIED** *(gpu-jail G5 fixed; out of domain except `build-image`)* | `Dockerfile.gpu-jail:31` `'LoginGraceTime 60'`. `test/jail-image-gate.test.js:21-22`. |
| J3 | Local mode "cannot register agents for public jobs" | README:1154 | **UNVERIFIED** *(prior first-run E3 / isolation D4)* | `setup` / `register` still do not read `RUNTIME`. If real, it is platform-side. Not re-opened. |
