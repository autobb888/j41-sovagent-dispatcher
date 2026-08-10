# first-run — claims checklist

Domain: **the path a brand-new operator walks between `install` and their first
completed job.** Every claim below is something an operator would *act on*: a
documented command, a stated precondition, a default, a "the dispatcher
automatically…", a stated failure mode.

Sources enumerated in full for this domain:

- `README.md` — Overview (1-26), Install (27-31), Quick Start (33-56),
  Add New Agent + SOUL editor (109-143), CLI command table rows reachable on a
  first run (150-190), Runtime Modes + image build (505-529), Agent Templates
  (571-580), Three-Wall Isolation (732-745), First-Run Security Setup (777-790),
  Network Lockdown (804-812), Financial Allowlists (813-821), Local Mode
  (822-830), Security Self-Test (843-849).
- `CLAUDE.md` — Quick Reference block, "Testing", "Data Directories".
- Operator-facing strings the code itself prints on the first-run path:
  `cli.js` `quickstart` / `init` / `register` / `finalize` / `setup` / `start`,
  `dashboard.js` `addAgentScreen` / `securityScreen` / Start button.
- `setup.sh`, `scripts/install.sh`, `scripts/build-image.sh` (repo-only
  installers; not shipped in the npm package).

**61 claims — 32 VERIFIED · 26 DRIFT · 3 MISSING · 0 UNVERIFIED.**
9 rows are marked *(prior)*.

Status key: **VERIFIED** (code does what is claimed) · **DRIFT** (code differs —
how is stated) · **MISSING** (no implementation found) · **UNVERIFIED**.
Rows marked *(prior)* are owned by an earlier domain pass; status restated, not
re-derived.

---

## A. Install and preconditions

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| A1 | `yarn global add @junction41/dispatcher` is the install | README:29-31 | **DRIFT** *(prior D1)* | `package.json:9-15` `files` omits `scripts/`, `Dockerfile.job-agent`, `package.docker.json`, `setup.sh`. The globally-installed tree cannot build the image the same page says is mandatory. |
| A2 | Docker must be installed; verify with `docker --version` | README:37 | **VERIFIED** | `cli.js:93-103` selects dockerode when `runtime=docker`; every job path needs it. No daemon reachability check exists anywhere (`docker.ping`/`version`/`info` absent) — see A4/F8. |
| A3 | `./scripts/build-image.sh` is required before the first `setup` or `start` | README:38-41 | **DRIFT** | Two errors. (a) The script is not in the published package (A1). (b) "before the first `setup`" is false — `setup` (`cli.js:2748-2963`) performs keygen + SDK/platform calls only and never touches Docker. |
| A4 | "the dispatcher will hang mid-registration if it is missing" | README:38 | **DRIFT** | → **F8**. The image is referenced at exactly one site, `cli.js:8408` (`Image: 'j41/job-agent:latest'`), inside `startJobContainer`. Registration never reaches it. The real symptom is a spawn failure on the first *job*. |
| A5 | Registration writes to chain and costs a fee; fund the displayed address before the `register` step can complete | README:42 | **DRIFT** | → **F1**. `register` (`cli.js:1487`) calls `agent.register()`, which is the platform-side onboard handshake (`sdk/dist/agent.js:426-512`) — challenge, signature, poll. No local transaction, no UTXO read, no balance check. Funds are first genuinely required at `publishVdxf` (`cli.js:1099-1119`). |
| A6 | A fresh install requires **no** `J41_*` environment variables | README:44 | **VERIFIED** | `config-loader.js:10-87` supplies every default; `ENV_OVERRIDES` (103-173) are all optional. |
| A7 | "Every security default is already the strict one" | README:44 | **VERIFIED** *(prior — isolation C2-C6, I5/I7/I9/I10)* | Defaults verified by the isolation pass. F4/F5 below concern whether first-run *setup completes*, not what the defaults are. |
| A8 | Recommended first-agent path: `setup <id> <name> --template <tpl>` — "the single-command pipeline (init + register + finalize)" | README:46 | **DRIFT** | → **F1**. The four steps exist (`cli.js:2805`, `2834`, `2884`, `2927`) but step 4's on-chain half is a guaranteed no-op on a fresh agent, and it reports success. |
| A9 | `init -n 9` bulk-generates a pool; default N is 9 | README:46, 152 | **VERIFIED** | `cli.js:1354` `.option('-n, --agents <number>', …, '9')`. Non-numeric input is unguarded → **F10**. |
| A10 | The three quick-start commands exist as written | README:49-55 | **VERIFIED** | `dashboard` `cli.js:3103`; `setup` `2716`; `start` `3109`. |
| A11 | `engines.node >= 20.0.0` | package.json:52-54 | **VERIFIED**, with a caveat *(prior I11)* | `require()` of the ESM-only `@junction41/secure-setup` (`cli.js:108`; dep `package.json:5 "type":"module"`) needs Node ≥ 20.19. Below that the whole security gate disappears silently. |

## B. `quickstart` — the guided first-run command

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| B1 | `quickstart` = "Guided first-run setup (template, LLM, runtime)" | README:181 | **DRIFT** | → **F3**. It collects four answers, persists exactly one (runtime), and prints shell instructions for the rest. |
| B2 | `quickstart` "creates agent, picks template, configures LLM" | `cli.js:1280` (`--help` text) | **DRIFT** | → **F3**. No agent is created (`cli.js:1281-1348` contains no keygen and no `setup` invocation); the template answer is only echoed back inside a suggested command line. |
| B3 | The runtime answer is persisted | — | **VERIFIED**, unvalidated | `cli.js:1328-1330` → `config.js:35-38` writes `config.json`. Any string is accepted → **F12**. |
| B4 | "Popular LLM providers: openai, claude, groq, deepseek, ollama" | `cli.js:1305` | **DRIFT** | → **F3**. `claude` is not a key of `LLM_PRESETS` (`local-llm.js:14-51`; the real keys are `claude-opus`/`claude-sonnet`/`claude-haiku`). Selecting it yields empty `baseUrl`/`model`. |
| B5 | The API key the operator types is stored somewhere usable | implied by `cli.js:1311` | **MISSING** | → **F3**. `apiKey` is used only at `cli.js:1334-1337` to build a printed `export` line; nothing is written to `config.toml`. |
| B6 | The printed `export <PRESET_ENV_KEY>=<key>` line works | `cli.js:1337,1342` | **DRIFT** | → **F3**. `buildContainerEnv` (`cli.js:7934-7938`) resolves the key from `agentCfg.llmApiKey` → `cfg.provider_keys[provider]` → `cfg.llm.api_key`, never from the dispatcher's `process.env`. `OPENAI_API_KEY` in the operator's shell is never read. (`J41_LLM_API_KEY` *would* work — `config-loader.js:160`.) |

## C. `init` / `register` / `finalize` / `setup` / templates

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| C1 | `init` generates keys + SOUL.md per agent | README:152 | **VERIFIED** | `cli.js:1374-1400`; dir `0o700` (1383), `writeKeysFile` for `keys.json`. |
| C2 | `init` is idempotent — existing agents are skipped | — | **VERIFIED** | `cli.js:1378-1381`. |
| C3 | `register` is interactive when `--profile-name` is absent | README:153 | **VERIFIED** | `cli.js:1506-1516`. |
| C4 | `register` refuses a name already claimed by another local agent | — | **VERIFIED** | `cli.js:1456-1475`, with a `recover` hint on `timeout`. |
| C5 | A timed-out registration saves partial state and points at `recover` | — | **VERIFIED** | `cli.js:1575-1585`; `setup` mirrors it at `2869-2877`. |
| C6 | `finalize <agent-id>` "publishes VDXF on-chain and registers service listing" | README:154 | **DRIFT** | → **F1**. Bare `finalize agent-1` resolves `profile = undefined` (`cli.js:1651-1655`); `buildAgentContentMultimap(undefined, [], undefined)` returns `{}` (`sdk/dist/onboarding/vdxf.js:368-441`), so the identity update carries **zero** new keys and still prints `✅ Identity updated on-chain`. `--interactive` does not help: `publishVdxf` runs at finalize stage 1, `resolveProfile` at stage 4 (`sdk/dist/onboarding/finalize.js:268,299`). |
| C7 | "Finalization can be resumed by rerunning this command" | `cli.js:1671` | **DRIFT** | → **F1**. Only printed when `stage !== 'ready'`, and the no-funds path *reaches* `ready`. `finalize` never clears stale state, so the rerun is a no-op. |
| C8 | `setup` = one-command init + register + finalize | README:155 | **DRIFT** | → **F1**. |
| C9 | `setup --template <name>` merges the template into the profile | README:53, `cli.js:2718` | **DRIFT** | → **F6**. The merge (`cli.js:2764-2782`) copies 7 profile fields and 7 service fields; `markup`, `network.capabilities`, `session`, `workspace`/`workspaceCapability` are silently dropped, and `setup` exposes no flag for any of them (`cli.js:2718-2747`). |
| C10 | `setup` copies the template's SOUL.md | — | **VERIFIED** | `cli.js:2821-2823`, guarded on the agent not already having one. |
| C11 | `setup` deletes stale finalize state so finalize runs fresh | — | **VERIFIED** | `cli.js:2930-2934`. This is the *only* way to retry a `ready`-marked finalize. |
| C12 | 5 built-in templates: general-assistant, code-review, data-analyst, character-roleplay, workspace-reviewer | README:113-119, 571 | **VERIFIED** | All five exist under `templates/` with both `config.json` and `SOUL.md`; all five carry a complete `service` block with a price, so `buildServiceFromOptions` (`cli.js:849-850`) does not bail. |
| C13 | Custom templates are "saved to `templates/<name>/` and reusable" | README:128 | **VERIFIED** *(prior — docs-truth C7)* | `dashboard.js:1099-1104`; written into the installed package tree. |
| C14 | The Custom Template Builder "prompts for every field" — workspace, session limits, markup, capabilities | README:121-126 | **DRIFT** | → **F6**. It does prompt (`dashboard.js:993,996,1004-1015`) and does persist (`1059-1085`), and `setup` then discards exactly those four. |
| C15 | Template name input is sanitised | — | **VERIFIED** | `dashboard.js:976-977` lowercases, dash-collapses, strips `[^a-z0-9-]`, rejects empty. No traversal. |
| C16 | The dashboard's "Add New Agent" runs the same `setup` pipeline | README:109-119 | **VERIFIED** | `dashboard.js:1165` spawns `setup <id> <name> --template <tpl>`. Inherits F1 and F6 wholesale; `exitCode === 0` (1166) is reached even when steps 3 and 4 both printed warnings (`cli.js:2922-2924`, `2946-2948`). |

## D. First-run security setup

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| D1 | "auto-detects the best isolation on first `j41-dispatcher start` … **No manual configuration needed**" | README:744 | **DRIFT** | → **F5**. On Linux `profileTargetDir` throws unless it can `mkdir /etc/j41` (`secure-setup/lib/index.js:72-91`), and the deliberate design decision there is *"Require root instead"*. |
| D2 | Step 1 — detects platform (Linux/macOS, KVM) | README:781 | **VERIFIED** | `secure-setup/lib/index.js:145` `detectPlatform()`. |
| D3 | Step 2 — installs gVisor (if KVM) or bubblewrap | README:782 | **DRIFT** | → **F5**. Package installs needing root, inside a **10-second** `Promise.race` (`cli.js:3455-3458`). |
| D4 | Step 3 — deploys seccomp + AppArmor profiles | README:783 | **DRIFT** | → **F5**. Root-only `/etc/j41`, no fallback by design. |
| D5 | Step 4 — creates the `j41-isolated` Docker network | README:784 | **VERIFIED (delegated)** *(prior — isolation C1)* | `secure-setup/lib/setup-network.js:214+`; failure is non-fatal there (`index.js:242-247`), and `cli.js:8099-8111` falls back to `bridge` with a warning. |
| D6 | Step 5 — creates `~/.j41/financial-allowlist.json` (deny-all) | README:785 | **VERIFIED** | Belt and braces: `secure-setup/lib/index.js:249-256` **and** `cli.js:149-164` self-creates `{permanent:[],operator:[],active_jobs:[]}` on first read. |
| D7 | Step 6 — creates `~/.j41/network-allowlist.json` | README:786 | **MISSING** *(prior — docs-truth D14)* | No writer in `src/`; no reader either. |
| D8 | Step 7 — runs the self-test | README:787 | **VERIFIED** | `secure-setup/lib/index.js:266-272`, inside `setup()`. |
| D9 | "Subsequent starts skip setup and run a quick-check instead" | README:789 | **VERIFIED**, with a caveat | `cli.js:3445-3446` gates on bare `fs.existsSync(~/.j41/dispatcher-security-initialized)`. The library ships a hardened `isInitialized()` that additionally requires a parseable body and a < 90-day timestamp (`index.js:103-122`) — the dispatcher does not call it. Contained by `~/.j41` being `0700`; recorded, not reported. |
| D10 | The dispatcher reports whether first-run setup worked | `cli.js:3459` | **DRIFT** | → **F4**. `setup()`'s `{success:false}` returns are discarded; `✓ Security setup complete` is unconditional. `dashboard.js:2127` checks the same value correctly. |
| D11 | A failed quick-check refuses to start (unless `--dev-unsafe`) | README:789 implied, `cli.js:3484` | **VERIFIED** | `cli.js:3481-3495`, `process.exit(1)`. Genuinely fail-closed. |
| D12 | `secure-setup` absent ⇒ features are skipped, not faked | README:846-848 | **VERIFIED**, with prior caveat *(I11)* | `cli.js:106-111`, `3465-3470`; the quick-check block (3475) is skipped entirely, so the isolation gate silently vanishes. |

## E. First start and first job

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| E1 | Local mode is "blocked by default — requires `--dev-unsafe`" | README:826 | **VERIFIED**, but late | `cli.js:8718-8731`. The gate is in `startJobLocal`, i.e. *after* the job was accepted and signed for (`cli.js:6765-6766`) → **F7**. |
| E2 | Local mode "prints warning every 30 seconds when active" | README:827 | **DRIFT (safe direction)** | `cli.js:3232-3239` requires `RUNTIME==='local' && _devUnsafe`. Local mode *without* `--dev-unsafe` — the state `setup.sh` produces — is the silent one. |
| E3 | Local mode "cannot register agents for public jobs on the platform" | README:829 | **MISSING** | Neither `register` (`cli.js:1446-1589`) nor `setup` (`2748-2963`) reads `RUNTIME`. Nothing prevents a full on-chain registration under `runtime=local`. |
| E4 | `start` refuses with no agents | — | **VERIFIED** | `cli.js:3153-3157`. |
| E5 | PID file prevents duplicate dispatchers; new instance stops the previous one | README:15 | **VERIFIED** *(prior — liveness)* | `cli.js:3162-3221`; refuses rather than racing if the old one will not die. |
| E6 | Containers run from the pre-built `j41/job-agent:latest` | README:516-522 | **VERIFIED**, no preflight | Single reference `cli.js:8408`. No `listImages`/`getImage`/`ping` anywhere in `src/` → **F8**. |
| E7 | The dashboard's Start button reports what actually happened (an explicit 2026 fix, `dashboard.js:2976-2981`) | `dashboard.js:2982-2996` | **DRIFT on the first run only** | → **F9**. The liveness window is 2500 ms; the first-ever start spends up to 10 000 ms in security setup before the quick-check can `exit(1)`. |
| E8 | Every job gets a canary token | README:831-833 | **VERIFIED** *(prior — trust-boundary)* | `cli.js:7949`. |
| E9 | An agent with no LLM configured declines rather than accepting | implied by README:44 "fail-closed" posture | **VERIFIED** | `preflight-gate.js:44-68` + `llm-health.js:11`; the decline is logged per job (`cli.js:6759`). `start` itself prints nothing about LLM readiness — recorded, not reported (the dashboard header does, `dashboard.js:201`). |
| E10 | A keyless-by-design provider (ollama / lmstudio / vllm) works without an API key — "(no key needed)" | `dashboard.js:1865,1919`; `cli.js:1310` | **DRIFT** | → **F2**. Preflight passes (the endpoint is live) and the container then answers every buyer message from `generateTemplateResponse` (`local-llm.js:242-244`). |

## F. Repo-only installers

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| F1c | `setup.sh` is a "One-Shot … Installs everything needed and configures runtime mode" | setup.sh:3-4 | **DRIFT** | → **F7**. Its no-Docker default is `local`, which the dispatcher then refuses to run jobs in. |
| F2c | `install.sh` is a one-line `curl \| bash` install | install.sh:4 | **DRIFT** | → **F7**, **F11**. Non-interactive ⇒ `RUNTIME=local` (install.sh:98-100). |
| F3c | `install.sh` installs the dispatcher to `$INSTALL_DIR` | install.sh:13 | **DRIFT** | → **F11**. `INSTALL_DIR=~/.j41/dispatcher` **is** the runtime data directory (`cli.js:114`, `config-loader.js:7`). |
| F4c | `install.sh`'s release-tarball fallback | install.sh:149 | **DRIFT** | → **F11**. `J41_VERSION="2.0.0"` (install.sh:12) vs `package.json:3` `2.19.0`. |
| F5c | `build-image.sh` stages everything the container needs | scripts/build-image.sh:35-71 | **VERIFIED** | Cross-checked every `require('./…')` in `job-agent.js` and `src/executors/*.js` and their transitive local requires against the `cp` list — complete. `package.docker.json` carries `@iarna/toml` for `config-loader.js`. |
| F6c | `yarn cli register …` / `yarn start` are the next steps | setup.sh:149-156 | **DRIFT** | → **F7**. Under the runtime `setup.sh` just persisted, `yarn start` accepts jobs it can never run. |

---

## Recorded, not reported

- **D9's marker check.** The dispatcher's bare `existsSync` vs the library's
  hardened `isInitialized()`. The suppression vector the library defends against
  (a co-tenant `touch`ing the marker) is closed here by `~/.j41` being `0o700`
  (`cli.js:385`). Worth aligning; not a finding.
- **`secure-setup`'s own error string.** `lib/index.js:88` tells a *dispatcher*
  operator to run `sudo npx @junction41/secure-setup --jailbox`. Wrong product
  flag, printed on our first-run path — but the fix is in the dependency, and
  `cli.js:3462` immediately prints the correct `--dispatcher` form after it.
- **`start` prints no LLM readiness line** (E9). The information exists in the
  dashboard header and in the per-job decline log. A one-line summary at startup
  would shorten the "why is nothing happening" loop, but nothing is *wrong*.
- **`/tmp/dispatcher.log`** (`dashboard.js:2972`) — predictable path in a shared
  directory, opened `'a'` with no `O_NOFOLLOW`. Already owned by scale **S15**
  (unrotated growth); same file, same fix (move under `~/.j41/dispatcher/`).
- **`.build-temp` is created in `$PWD`, not the repo root** (`build-image.sh:37`),
  so running the script by absolute path from `$HOME` creates and `rm -rf`s
  `~/.build-temp`. Only ever that one name; cosmetic.

## Out of domain — found incidentally, reported anyway

`cli.js:7380` calls `startJob(state, agentInfo, fullJob)`; the signature is
`startJob(state, job, agentInfo)` (`cli.js:8995`). See **X1** in `first-run.md`.
