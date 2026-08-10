# docs-truth — claims checklist

Domain: **does the documentation tell the truth about the code?** Every row is a
claim an operator would *act on* from `README.md`, `CLAUDE.md`, or a file those
two point at (`docs/config.toml.example`), plus the operator-facing instruction
text the code itself prints.

Status vocabulary: **VERIFIED** (code does what's claimed) / **DRIFT** (code
differs — how is stated) / **MISSING** (no implementation) / **UNVERIFIED**
(could not determine).

Rows marked *(prior)* were already resolved by an earlier domain pass; they are
recorded here for completeness and **not** re-reported as findings. Findings
opened by this pass are tagged **→ D<n>**.

---

## A. Install, first run, build

| # | Claim | Status | Evidence |
|---|---|---|---|
| A1 | `yarn global add @junction41/dispatcher` installs the dispatcher (README:29-31) | VERIFIED | `package.json:2,6-8` — name `@junction41/dispatcher`, bin `j41-dispatcher` → `src/cli.js` |
| A2 | "Build the job-agent image — **required** before the first `setup` or `start`" via `./scripts/build-image.sh` (README:38-41) | **DRIFT → D1** | `package.json:9-15` `files` = `src`, `templates`, `README.md`, `CHANGELOG.md`, `LICENSE`. `scripts/` is not shipped, so the file does not exist after the documented install |
| A3 | Alternative: `docker build -f Dockerfile.job-agent -t j41/job-agent:latest .` (README:521) | **DRIFT → D1** | `Dockerfile.job-agent` and `package.docker.json` are also outside `files`. `scripts/build-image.sh:41,72` needs both |
| A4 | The dispatcher runs jobs from a pre-baked local image | VERIFIED | `cli.js:8408` `Image: 'j41/job-agent:latest'`; no pull and no build fallback anywhere in `src/` |
| A5 | "A fresh install requires **no** `J41_*` environment variables" (README:44) | VERIFIED | `config-loader.js:10-86` `DEFAULTS` is complete and frozen; every `ENV_OVERRIDES` entry is optional (`config-loader.js:183-186` skips undefined/empty) |
| A6 | Recommended first agent: `setup <id> <name> --template <tpl>` = init + register + finalize (README:46) | VERIFIED | `cli.js:2716` `setup <agent-id> <identity-name>`; `--template` at `cli.js:2754` |
| A7 | `init -n 9` default (README:152) | VERIFIED | `cli.js:1354` `.option('-n, --agents <number>', …, '9')` |
| A8 | Registration writes to the Verus chain and needs a funded address (README:42) | VERIFIED | `cli.js:1411-1500` register path; `keygen.js` prints the R-address to fund |
| A9 | SDK dev symlink: `ln -s /path/to/j41-sovagent-sdk/dist node_modules/@junction41/sovagent-sdk/dist` "symlink the entire package" (README:865-869) | DRIFT (cosmetic) | The prose says "entire package", the command symlinks `dist` only. Also fails if `dist/` already exists (creates `dist/dist`). Recorded, not reported |
| A10 | `scripts/install.sh` / `setup.sh` are the git-clone install path | VERIFIED (undocumented) | Both exist and clone the repo; **neither is mentioned in README**. Feeds D1's proposed fix |

## B. CLI command surface (README:144-193)

| # | Claim | Status | Evidence |
|---|---|---|---|
| B1 | No args → interactive TUI menu | VERIFIED | `cli.js:10956-10958` — `process.argv.length <= 2` → `require('./dashboard.js')` |
| B2 | No-args menu offers "system settings" (README:150) | **MISSING → D7** | The reachable TUI is `dashboard.js`; its `choices` array (`dashboard.js:210-234`) has no settings screen. `cli.js:9350 mainMenu()` (which does have `showSystemSettings`, `cli.js:9611`) has **no caller** — dead code |
| B3 | `dashboard`, `init`, `register`, `finalize`, `setup`, `inspect`, `recover`, `activate`, `deactivate`, `activate-all`, `deactivate-all`, `start`, `status`, `logs`, `config`, `api-setup`, `quickstart`, `providers`, `privacy`, `encrypt-keys`, `decrypt-keys`, `change-passphrase`, `set-authorities`, `check-authorities`, `respond-dispute` all exist | VERIFIED | `cli.js` `.command(...)` at 3103, 1352, 1412, 1593, 2716, 2466, 1677, 2093, 1981, 2164, 2232, 3109, 4506, 4550, 1181, 3003, 1279, 2967, 4685, 4413, 4474, 4487, 1880, 1932, 9110 |
| B4 | `wallet` / `wallet show` / `wallet sweep` / `wallet send` (README:167-170) | VERIFIED *(prior — money)* | `cli.js:10698` |
| B5 | `ctl status\|jobs\|agents\|resources\|shutdown\|canary\|earnings\|providers\|history` (README:171-179) | VERIFIED | `cli.js:9211`; server side `control.js:493-635` |
| B6 | The `ctl` surface is fully documented | **DRIFT → D8** | `cli.js:9212` also advertises `inbox` and `inbox-redrive` (`control.js:505,508`). Neither appears in README. CLAUDE.md:212 instructs `ctl inbox` as a pre-check for `update-profile` — a command the README never defines |
| B7 | The README command table is the complete scripted/headless surface ("All commands are also available directly", README:146) | **DRIFT → D6/D8** | Absent: `refunds` (`cli.js:10803`), `update-profile` (`cli.js:2341`), `post-bounty` (`cli.js:9650`), `list-bounties` (`cli.js:9690`), `my-bounties` (`cli.js:9743`) |
| B8 | "Crash recovery — detects orphaned jobs on startup, **handles refunds**/cleanup" (README:21) | **DRIFT → D6** | `cli.js:6525-6538`: "All crash-recovery refunds require owner approval before funds move… Use `j41-dispatcher refunds approve`". Refunds are *queued*, not handled; the command that completes them is undocumented |
| B9 | `logs [job-id]`, `-f` for follow (README:165) | VERIFIED | `cli.js:4550-4553` — `-f, --follow`, plus `-n/--lines` and `--agent` (undocumented but harmless) |
| B10 | `--json` works with `ctl` commands (README:191) | VERIFIED | `cli.js:9215` `.option('--json', …)`, `cli.js:9230-9233` short-circuits to raw JSON |
| B11 | `respond-dispute` flags `--agent --action --refund-percent --rework-cost --message` (README:592-608) | VERIFIED | `cli.js:9112-9116`; action validated to `refund\|rework\|rejected` at `cli.js:9121` |
| B12 | `config` flags: `--runtime --max-concurrent --job-timeout --extension-auto-approve --extension-max-cpu --extension-min-free-mb --show` | VERIFIED | `cli.js:1182-1189` |
| B13 | Health `http://127.0.0.1:9842/health` + `/metrics` "available **whenever** the dispatcher is running" (README:193) | DRIFT *(prior — liveness L10)* | Binds only after an unbounded startup sequence |

## C. TUI / dashboard (README:57-142)

| # | Claim | Status | Evidence |
|---|---|---|---|
| C1 | 18 numbered items + `⚡ Live Jobs` + Quit, with the exact separators shown | VERIFIED | `dashboard.js:210-234` matches README:72-95 item for item, including `── Dispatcher ──`, `── Tools ──`, `── Agents ──`, `── Marketplace ──` |
| C2 | CLAUDE.md's condensed menu block (CLAUDE.md:166-178) | VERIFIED | Same array; CLAUDE.md's two-column rendering omits three separators but the item set and numbering are right |
| C3 | Arrow keys, Enter, **ESC to go back from any screen** (README:98) | VERIFIED | `dashboard.js` uses `promptWithEsc` 220×; exactly one raw `inquirer.prompt(` remains (inside `promptWithEsc` itself) |
| C4 | View Agents → "**VDXF Keys** — all **26** on-chain keys with values, `(not set)` for empty ones" (README:104) | **DRIFT → D9** | `dashboard.js:364-393` `ALL_VDXF_KEYS` has **24** entries — `service.schema` and `review.attestation` are absent. An absent one is never printed as `(not set)`; a *present* `review.attestation` falls into the unknown-key branch (`dashboard.js:564-574`) and renders as a truncated raw i-address with no name |
| C5 | 5 built-in templates: general-assistant, code-review, data-analyst, character-roleplay, workspace-reviewer (README:113-119) | VERIFIED | `templates/` contains exactly those five, each with `config.json` + `SOUL.md` |
| C6 | Custom Template Builder prompts profile/workspace/session/service/SOUL fields | VERIFIED | `dashboard.js:968-1110` (`createCustomTemplate`) |
| C7 | "Templates are saved to `templates/<name>/` and reusable for future agents" (README:128) | VERIFIED (caveat) | `dashboard.js:1100` writes to `path.join(__dirname,'..','templates',tplName)` — inside the **installed package**, so a package upgrade replaces the directory. Path is as documented; durability caveat recorded, not reported |
| C8 | SOUL.md editor reachable from Create Custom Template and View Agents → SOUL.md → Edit (README:142) | VERIFIED | `dashboard.js:658` (`Edit SOUL.md`), `dashboard.js:1024-1051` (builder + preview) |
| C9 | Dashboard header shows agents / dispatcher PID / runtime / global LLM / executor (README:66-70) | VERIFIED | `dashboard.js:190-209` |

## D. VDXF profile (README:195-225)

| # | Claim | Status | Evidence |
|---|---|---|---|
| D1c | Exactly 26 flat keys, no parent-group wrapping | VERIFIED | SDK `dist/onboarding/vdxf.js:77-127`: 16 agent + 1 service + 2 review + 2 bounty + 1 platform + 1 session + 2 workspace + 1 job = 26 |
| D2c | The numbered table's key names and i-addresses | VERIFIED | Every name in README:201-225 appears in `VDXF_KEYS` with the same grouping; `agent.disputePolicy` carries the SDK's own `(was svc.dispute)` comment, matching README:216 |
| D3c | `service.schema` is platform-only ("agents don't write") | VERIFIED | SDK comment `vdxf.js:96`; no `src/` write path references it |
| D4c | `review.attestation` "populated when a review attestation is accepted" | VERIFIED | `cli.js:7449` handles `item.type === 'attestation'`; SDK `inbox/vdxf-gate.js:49-50` allowlists exactly `VDXF_KEYS.review.attestation` for that type |
| D5c | CLAUDE.md: contentmultimap keys must be hash160-sorted; fixed in **SDK 2.13.1**, "requires that version or later" | VERIFIED | `package.json:39` pins `@junction41/sovagent-sdk` at `2.14.1` |
| D6c | CLAUDE.md: `update-profile` is a single transaction and preserves other keys | VERIFIED | `cli.js:2341` → SDK `removeAndRewriteVdxfFields`; consistent with the SDK's copy-forward `buildIdentityUpdateTx` |
| D7c | CLAUDE.md: `update-profile` is **not** gated by the inbox pending-write check | VERIFIED | `cli.js:2341-2464` contains no `checkPendingInbox` / pending-write call; the gate is only in `processInboxForAgent` (`cli.js:7494+`) |

## E. Configuration (README:375-485)

| # | Claim | Status | Evidence |
|---|---|---|---|
| E1 | File-paths table: `agents/<id>/keys.json`, `SOUL.md`, `profile.json`, `webhook-config.json`, `config.toml` (0600) | VERIFIED | `cli.js:117-122`, `config-loader.js:8`; `config-loader.js` writes 0600 |
| E2 | `config.toml` is the config file an operator edits (README:385,412-414; CLAUDE.md:118) | **DRIFT → D7** | A second, undocumented config exists: `~/.j41/dispatcher/config.json` (`config.js:10`). `j41-dispatcher config` writes **only** there (`cli.js:1200-1247`), and `JOB_TIMEOUT_MS` (`cli.js:140`) and the extension thresholds (`cli.js:6603-6604`) read **only** there. Neither has a `config.toml` key |
| E3 | Dispatcher Settings are "configurable via interactive menu (System Settings)" (README:389) | **MISSING → D7** | See B2 — that screen is unreachable dead code |
| E4 | Job timeout default 60, range 1-1440 | VERIFIED | `cli.js:1214-1221`, default at `cli.js:140` |
| E5 | Extension auto-approve default true | VERIFIED | `cli.js:6598` (`=== false` disables), `cli.js:1224-1227` |
| E6 | CPU threshold default 80 — "reject extensions if load avg > this % of cores" | VERIFIED | `cli.js:6603,6610` — `loadavg()[0] < cpuCount * (pct/100)`. Code additionally clamps the flag to 10-100 (`cli.js:1230-1234`), undocumented |
| E7 | RAM threshold default 512 MB | VERIFIED | `cli.js:6604,6612`; flag clamped 64-65536 (`cli.js:1239-1243`) |
| E8 | Max concurrent default "unlimited", set via `--max-concurrent` | DRIFT *(prior — liveness L8, scale S14)* | Hardware-derived cap; the `config.json` key the flag writes is deliberately not consulted (`cli.js:129-137`) |
| E9 | Extensions are auto-approved on capacity | DRIFT *(prior — scale S11)* | Also rejected whenever the queue is non-empty or the pool is full |
| E10 | Runtime `docker` (default) or `local` | VERIFIED | `cli.js:1196-1201` |
| E11 | Service lifecycle: `--idle-timeout` 5-2880, default 10 | VERIFIED | `cli.js:914`, validated `cli.js:888-889` |
| E12 | `--pause-ttl` 15-10080, default 60 | VERIFIED | `cli.js:915`, validated `cli.js:891` |
| E13 | `--reactivation-fee` 0-1000, default 0 | VERIFIED | `cli.js:916`, validated `cli.js:892-893` |
| E14 | Provider API keys belong in `[provider_keys]` and are never read from the dispatcher's env | VERIFIED *(prior — keys D3)* | `cli.js:7934-7938`; local-mode env is an explicit whitelist (`cli.js:8749-8757`) |
| E15 | `[provider_keys]` has a working slot per provider (`docs/config.toml.example:39-55`, `config-loader.js:31-35`) | **DRIFT → D2** | The lookup is `cfg.provider_keys[provider]` keyed by **preset name** (`cli.js:7936`, `preflight-gate.js:23`). No preset is named `anthropic`, `google` or `xai` — those three slots are unreachable. Seven preset names (`openai-mini`, `openai-o3`, `claude-*`, `gemini*`, `grok`, `kimi-nvidia`, `azure`) have no slot |
| E16 | Legacy `.env` files are auto-migrated on first start (README:16) | DRIFT (partial) → **D2** | `config-loader.js:386-388` migrates via `PROVIDER_KEY_ENV_MAP`, which maps `ANTHROPIC_API_KEY`→`anthropic`, `GOOGLE_API_KEY`→`google`, `XAI_API_KEY`→`xai` — the three unreachable slots. Migration "succeeds" and the key is never read |
| E17 | `docs/config.toml.example` shows "the full format" (README:414) | **DRIFT → D10** | Omits 13 `DEFAULTS` keys: `runtime.job_log_retention\|job_log_max_bytes\|job_log_max_retained`, `platform.signer`, `proxy.max_output_tokens_cap\|max_inflight_per_buyer\|credit_low_threshold_vrsc\|rate_limit_rps\|rate_limit_burst\|rate_limit_max_buckets\|circuit_threshold\|circuit_open_ms`, and the whole `[jailbox]` table |
| E18 | `docs/config.toml.example:34` suggests `provider = "openai, claude, gemini, …"` | **DRIFT → D10** | `claude` is not a `LLM_PRESETS` key (`local-llm.js:19-21` — only `claude-opus\|sonnet\|haiku`); it resolves to no preset |
| E19 | Env-var table: `J41_API_URL`, `J41_MAX_CONCURRENT`, `J41_REQUIRE_FINALIZE`, `J41_FEE_SWEEP*` | VERIFIED | `config-loader.js:100-107,123-129` |
| E20 | `IDLE_TIMEOUT_MS` is an ops override "for CI or one-shot ops" that overrides the corresponding `config.toml` value (README:418,424) | **DRIFT → D17** | Not in `ENV_OVERRIDES` and has no `config.toml` key. The container gets `IDLE_TIMEOUT_MS` **only** from the per-service `job.lifecycle.idleTimeout` (`cli.js:7972`). Both env constructions are explicit allowlists with no `process.env` spread (`cli.js:7927-8014` Docker, `cli.js:8749-8757` local), so setting it on the dispatcher is inert in both modes. Same shape as trust-boundary **T8** |
| E21 | The 480000 ms / 8 min default itself | VERIFIED | `job-agent.js:52` |
| E22 | `J41_NO_STATUS_TOGGLE` is env-only by design and skips both loops | VERIFIED | `cli.js:4160-4161` (startup), `cli.js:4295-4299` (shutdown); absent from `ENV_OVERRIDES` as claimed |
| E23 | "Full override list: `ENV_OVERRIDES` in `src/config-loader.js`" (README:431) | DRIFT (minor) | True as a pointer, but the table above it lists `IDLE_TIMEOUT_MS` and `J41_NO_STATUS_TOGGLE`, neither of which is in `ENV_OVERRIDES`. Folded into D17 |
| E24 | Budget table: `vrsc_usd_rate` 0, `rate_max_age_ms` 86400000, `spend_fraction` 0.6, `fallback_token_budget` 50000, `warning_percent` 80, `extension_wait_ms` 600000, with the six `J41_*` overrides | VERIFIED | `config-loader.js:73-80`, `ENV_OVERRIDES` 132-137 |
| E25 | "The rate is stamped into each job container's environment with the container start time" | VERIFIED | `cli.js:7999-8006` writes `J41_VRSC_USD_RATE` + `J41_VRSC_USD_RATE_AT` |
| E26 | "there are no inline exchange rates or per-token cost constants anywhere else" | VERIFIED *(prior — money)* | All conversion via `token-budget.js` |
| E27 | Operator-set rate is re-stamped per container so `rate_max_age_ms` never fires | DRIFT *(prior — money M7)* | `cli.js:8000` stamps `Date.now()` |
| E28 | Unattended passphrase precedence: env var, then systemd credential (README:435-438) | DRIFT *(prior — keys K5)* | Precedence is the reverse |
| E29 | At-rest encryption is opt-in, AES-GCM from a passphrase-derived master key | VERIFIED *(prior — keys)* | `keystore.js` |
| E30 | "Honest scope" paragraph on at-rest encryption (README:442) | VERIFIED | Accurate description of the threat model |

## F. Providers, executors, templates (README:530-579)

| # | Claim | Status | Evidence |
|---|---|---|---|
| F1 | 25 LLM presets | VERIFIED | `local-llm.js:14-49` — exactly 25 keys |
| F2 | Every row of the provider table (preset name, variants, default model) | VERIFIED | Checked one by one against `local-llm.js:16-48`; all 19 rows correct including `azure`/`custom`'s empty baseUrl+model |
| F3 | "Claude presets route through OpenRouter" | VERIFIED | `local-llm.js:19-21` all three use `https://openrouter.ai/api/v1` |
| F4 | Env vars `J41_LLM_PROVIDER\|BASE_URL\|API_KEY\|MODEL` override config | VERIFIED | `config-loader.js:157-160` |
| F5 | Six executor types with the stated `J41_EXECUTOR` values | VERIFIED | `executors/index.js:34-60` |
| F6 | Framework aliases `crewai\|autogen\|dify\|flowise\|haystack\|n8n` → `webhook` | VERIFIED | `executors/index.js:21-28` |
| F7 | CLAUDE.md: "`local-llm.js` exports must include `resolveLLMConfig`" | VERIFIED | `local-llm.js:525` |
| F8 | `--template code-review\|general-assistant\|data-analyst` (README:573-577) | VERIFIED | `templates/` + `cli.js:2754-2757` |
| F9 | npm package description: "22 LLM providers, 12 executor frameworks" | **DRIFT → D16** | `package.json:4` vs 25 presets and 6 executors (+6 aliases) |

## G. Wallets, fee tank, scale (README:239-373)

| # | Claim | Status | Evidence |
|---|---|---|---|
| G1 | Two addresses; payments credit the i-address, fees debit the R-address | VERIFIED *(prior — money)* | `fee-tank.js` |
| G2 | Sweep on by default, 30 min, floor 100 writes, self-funding, refuses R-inputs | VERIFIED *(prior — money)* | `fee-tank.js` |
| G3 | Flag/config/env precedence table + minutes-vs-ms warning | VERIFIED *(prior — money)*; `--fee-sweep-floor 0` discarded | money **M10** |
| G4 | `wallet` guards: agent-ids only, mainnet retype, reserve floor, pending stamp, `--dry-run`, `null` vs `0` | VERIFIED *(prior — money)* | `wallet.js` |
| G5 | Fee-tank scale table labelled "measured" | UNVERIFIED *(prior — scale C1)* | No harness in the repo produces it |
| G6 | Poll-loop arithmetic and the "≤500 ms never overruns" table | DRIFT *(prior — scale S2)* | Cycle costs ~3× the published arithmetic |
| G7 | "Raise the interval or run a second dispatcher" (README:366-370) | MISSING *(prior — scale S1)* | No interval knob; the second-instance path SIGTERMs the live one |
| G8 | Skipped cycles are reported as `poll_cycles_skipped` / `fee_tank_cycles_skipped` in `/health` | VERIFIED *(prior — scale)*; inbox sweep has no counter | scale **S8** |

## H. Control plane, health, events, proxy (README:632-717)

| # | Claim | Status | Evidence |
|---|---|---|---|
| H1 | Unix socket at `~/.j41/dispatcher/control.sock` | VERIFIED | `control.js` |
| H2 | Control API on `127.0.0.1:9843`, bearer token at `~/.j41/dispatcher/control.token` (0600), auto-created | VERIFIED *(prior — keys/trust)* | `control-api.js:34-75,205` |
| H3 | Every `/v1/*` requires the token, even from localhost | VERIFIED | `control-api.js:171-175` — auth checked before every route |
| H4 | Endpoints `/v1/status\|agents\|jobs\|jobs/:id\|earnings\|events`; `/v1/jobs/:id` 404s if not running | VERIFIED | `control-api.js:177-197` |
| H5 | v1 is read-only; write endpoints "land in later increments" | VERIFIED | `control-api.js:165-167` — 405 on any non-GET |
| H6 | `/v1/events` returns `{ events: [...], cursor: N }`; `seq` monotonic and survives restart | VERIFIED | `control-api.js:125-129`, file-backed ring |
| H7 | Event vocabulary: `job.started\|delivered\|completed`, `extension.requested\|approved\|rejected`, `dispute.filed\|resolved`, `container.started\|died`, `agent.online\|offline` (README:701-703) | **DRIFT → D5** | `extension.approved`, `extension.rejected`, `dispute.filed`, `dispute.resolved` exist **only** via `WEBHOOK_EVENT_MAP` (`cli.js:7043-7051`) applied in `handleWebhookEvent` (`cli.js:7068`), whose only caller is the webhook route (`cli.js:3878`). In poll mode — the documented default — they never fire. Conversely the feed emits 14 types the vocabulary does not name: `job.accepted`, `job.declined_llm_down`, `agent.llm_down`, `refund.pending_approval`, `refund.needs_review` (`cli.js:6077`, emitted via a variable), `dispute.unresolved_agent`, `dispute.surfacing_expired`, `dispute.reconcile_gave_up`, `fee_tank_empty`, `fee_sweep`, `inbox.dead_lettered`, `inbox.batch_escalated`, `inbox.pending_write_expired` |
| H8 | `/health` on `:9842` stays open + unauthenticated; `/metrics` is Prometheus text | VERIFIED | `control.js:90-146` |
| H9 | Health field **paths** are versioned API — `agents.0.status`, `containers.0.state`, `summary.containers_unhealthy` | VERIFIED | `control.js:165,459,464`; the compatibility promise is restated in-code at `control.js:94` |
| H10 | `summary.containers_unhealthy` `above:0` is the canonical alarm | VERIFIED *(prior — liveness)*; can never fire in Docker mode | liveness **L2** |
| H11 | Proxy routes `POST /j41/discovery/request-access`, `POST /j41/proxy/v1/*`, `POST /j41/deposit/report`, `GET /j41/health` | VERIFIED | `webhook-server.js:119,135,158,250` |
| H12 | Undocumented fourth POST route `/j41/api-access/revoke` | DRIFT (omission) | `webhook-server.js:198`. Recorded, not reported — it is J41→dispatcher, not operator-facing |
| H13 | "Verification is fully local and fail-closed… No bypass env var exists in the codebase" | VERIFIED *(prior — trust-boundary)* | `proxy-handler.js` envelope v1+v2 |
| H14 | Credit metering reservation pattern; streaming `usage` parsed line-by-line | VERIFIED *(prior — money)*; upstream-error settle bills the full reservation | money **M1/M2** |
| H15 | `docs.junction41.io/dispatcher/api-endpoint-proxy` (README:653) | UNVERIFIED | External URL; read-only pass makes no network calls |

## I. Lifecycle, disputes, workspace (README:227-237, 581-630)

| # | Claim | Status | Evidence |
|---|---|---|---|
| I1 | Job lifecycle steps 1-6, 8-9 | VERIFIED | `cli.js:6659-7037` (poll), `job-agent.js` chat/file/idle paths |
| I2 | Step 7: "if pause TTL expires, the agent **auto-delivers** results" | MISSING *(prior — liveness L17)* | Expiry drops the queue entry; no sender, no worker |
| I3 | Post-delivery container stays alive through the review window; killed on `job.completed` or `job.dispute.resolved` | VERIFIED | `cli.js:7191-7224`; `job-agent.js:1920-2030` `waitForPostDelivery` |
| I4 | Webhook event table (5 rows: dispute filed/responded/resolved/rework_accepted, job.completed) | VERIFIED | `cli.js:7176-7224` — all five cases present, IPC forwarding as described |
| I5 | Workspace lifecycle: `workspace.ready` → dispatcher connects → tool calls → path validation → completion | **DRIFT → D3** | Every entry point refuses by default: `cli.js:5439-5442` (`cfg.jailbox.enabled` false, `config-loader.js:86`) and `job-agent.js:1405-1407` (`process.env.JAILBOX_ENABLED !== '1'`). README never mentions parking; `JAILBOX_PARKED.md` exists in the repo and is never linked |
| I6 | Overview: "Workspace auto-connect — job-agent polls… and connects jailbox **automatically**" (README:17) | **DRIFT → D3** | Same gate |
| I7 | `workspace-reviewer` template offers "direct file access code review via workspace/connect" (README:119) | **DRIFT → D3** | Ships and registers, but the capability it advertises can never be exercised at defaults |
| I8 | Events handled: `workspace.ready`, `workspace.disconnected`, `workspace.completed` | VERIFIED | `cli.js:7225,7255-7256` |
| I9 | "VDXF policy enforcement: agents without on-chain `workspace.capability` are blocked" (README:840) | VERIFIED (incomplete) → **D3** | `cli.js:5438-5453`. True, but the jailbox gate above it blocks *all* agents first |
| I10 | Docker-mode workspace connect bypasses the on-chain capability gate | DRIFT *(prior — isolation I10)* | Inert while parked |

## J. Security section (README:730-848)

| # | Claim | Status | Evidence |
|---|---|---|---|
| J1 | Three-wall isolation diagram | DRIFT *(prior — isolation I3)* | Two walls in practice |
| J2 | Security scores 10/10 gVisor, 8/10 bwrap, 4/10 Docker-only, 0/10 local | DRIFT *(prior — isolation I4)* | Score ignores network posture |
| J3 | Mainnet gate refuses 13 named env vars | VERIFIED *(prior — isolation)*; reads `process.env` only | isolation **I5** |
| J4 | `docs/config.toml.example:14-15` offers `skip_status_check` / `allow_local_upstream` as config keys | **DRIFT → D10** | The mainnet gate names only the `J41_*` env forms and reads `process.env` (isolation I5), so the config-file form the example advertises is invisible to it |
| J5 | First-run step 5: creates `~/.j41/financial-allowlist.json` (deny-all) | VERIFIED | `secure-setup/lib/setup-allowlist.js:9,27-38`; `cli.js:147` reads the same path |
| J6 | First-run step 6: creates `~/.j41/network-allowlist.json` | MISSING *(prior — isolation C6)* | `setup-network.js:251-252` — no longer written |
| J7 | "Configure allowed endpoints in `~/.j41/network-allowlist.json`" | MISSING *(prior — isolation C5)* | No reader in `src/` |
| J8 | "Internal bridge with ICC disabled" | DRIFT *(prior — isolation C2)* | Deliberately not `--internal` |
| J9 | "iptables allowlist: only `api.junction41.io` + LLM endpoints" | DRIFT *(prior — isolation C3)* | Default-deny + proxy-only |
| J10 | "DNS pinned and re-resolved every 5 minutes" | MISSING *(prior — isolation C4)* | `resolveAndPinDNS` no longer resolves and has no caller |
| J11 | Container hardening list (`CapDrop ALL`, `ReadonlyRootfs`, tmpfs, seccomp, AppArmor, `PidsLimit 64`, `OomScoreAdj 1000`, no-new-privileges) | VERIFIED *(prior — isolation)* | `cli.js:8355-8390` |
| J12 | `StorageOpt: {size:'1G'}` — max disk | DRIFT *(prior — isolation I7)* | Silently dropped on most hosts |
| J13 | Financial allowlist: "auto-adds **seller** addresses on **job creation**" (README:19) | **DRIFT → D11** | `cli.js:175-188` `addActiveJobToAllowlist(jobId, buyerAddress)`, called with `buyerPayAddr` on **accept** (`cli.js:6772, 7093, 7373`). README:818 states it correctly — the two lines contradict each other |
| J14 | Allowlist "reloads from disk on every check" | VERIFIED | `cli.js:176` — `loadFinancialAllowlist()` re-reads per call |
| J15 | Rate limiting: 3 sends/job, price+10%, 10 sends/hour, 30 s cooldown; fail-closed sweep | DRIFT *(prior — money M3)* | Implemented but no callers |
| J16 | Mandatory canary: `J41_CANARY_TOKEN`, injected as an HTML comment, always enabled, registered with SovGuard | VERIFIED | `job-agent.js:67,492-495,543-547` |
| J17 | Canary blocks outbound messages and strips from delivery | VERIFIED *(prior — isolation)*; strip is literal while detection is evasion-resistant | isolation **I9** |
| J18 | Local mode blocked without `--dev-unsafe`, warns every 30 s | VERIFIED | `cli.js:8718-8735` |
| J19 | Local mode "cannot register agents for public jobs" | UNVERIFIED *(prior — isolation D4)* | No dispatcher-side enforcement found |
| J20 | Env isolation: local mode whitelists only necessary env vars | VERIFIED | `cli.js:8749-8757` |
| J21 | `j41-secure-setup --check\|--test --dispatcher` | VERIFIED | `@junction41/secure-setup/bin/j41-secure-setup.js:91-96`; the binary is an **optionalDependency** (`package.json:45-47`) — see isolation **I11** |
| J22 | Legacy opt-outs `J41_DEPOSIT_ALLOW_AUTH_ONLY` / `J41_TRUST_PLATFORM_RESOLUTION` "both are refused outright on mainnet" | VERIFIED | Both appear in the mainnet gate list (`mainnet-guard.js`) |

## K. Overview bullets and CLAUDE.md-specific claims

| # | Claim | Status | Evidence |
|---|---|---|---|
| K1 | "PID file — New instance auto-kills previous" (README:15) | DRIFT *(prior — liveness L12)* | SIGTERM + 10-min wait + refuse |
| K2 | "UTXO chaining — multiple payments per block without waiting for confirmations" (README:18) | VERIFIED (SDK-provided) | SDK `dist/agent.js:2208-2289` tracks spent UTXOs + unconfirmed change; the dispatcher's refund path uses it (`cli.js:5834` `agent.sendCurrency`) |
| K3 | "SovGuard 429 handling — surfaces upgrade URLs, longer backoff" (README:20) | VERIFIED | `auth-backoff.js:55`; `retry.rate_limit_backoff_multiplier` forwarded to the container (`cli.js:7992`) |
| K4 | "Graceful drain shutdown… waits up to 30 s, then SIGTERM → SIGKILL" (README:22, 719-728) | DRIFT *(prior — liveness L1, L9)* | 120-min drain, no kill escalation |
| K5 | "Docker IPC — file-based IPC (`/tmp/ipc-msg.json`)" (README:24) | **DRIFT → D12** | The file is `/tmp/ipc-msg.jsonl` — `job-agent.js:790`, `cli.js:4982`. `cli.js:4970` and `job-agent.js:695` carry the same stale `.json` in comments |
| K6 | "Kimi K2.5 tool call parsing — handles `<\|tool_calls_section_begin\|>`" (README:25) | VERIFIED | `local-llm.js:460-466` |
| K7 | "On-chain job records — auto-processes `job_record` and `review` inbox items" (README:23) | VERIFIED (understated) | `cli.js:7494` — `INBOX_ACTIONABLE_TYPES = ['review','attestation','job_record']`; `attestation` is a third type the README omits |
| K8 | CLAUDE.md file map: `cli.js` "~9700 lines", `dashboard.js` "~1900 lines" | **DRIFT → D15** | Actual 10958 and 3144 |
| K9 | CLAUDE.md data dirs place `financial-allowlist.json` / `network-allowlist.json` under `~/.j41/dispatcher/` | **DRIFT → D14** | Real path is `~/.j41/` (`cli.js:147`, `setup-allowlist.js:9`); `network-allowlist.json` is not written at all |
| K10 | CLAUDE.md data dirs list `config.json`, `dispatcher.pid`, `queue/`, `jobs/`, `agents/<id>/{keys,agent-config,finalize-state}.json`, `SOUL.md` | VERIFIED | `config.js:10`, `cli.js:117-123` |
| K11 | CLAUDE.md: `agent-config.json` written with `mode: 0o600` | VERIFIED | `dashboard.js:1699`, `cli.js:3044+` |
| K12 | CLAUDE.md API response shapes: `getIdentityRaw()` → `{data:{…}}`; `getUtxos()` → `{utxos,address,iAddress}`; `getAgentServices()`/`getMyBounties()` → `{data:[…]}` | VERIFIED | SDK `client/index.js:610-612` (returns the envelope), `:274-278` (returns `res.data`), `:836-838`, `:1402+`; consumers unwrap accordingly (`cli.js:7524` destructures `{data: idRaw}`) |
| K13 | CLAUDE.md: dashboard prompts always use `promptWithEsc`; long commands use `runCommandAsync()`; agents filtered with `.filter(a => a.identity && a.iAddress && a.wif)` | VERIFIED | 220 `promptWithEsc` call sites; helpers present |
| K14 | CLAUDE.md: `sovguard-context.js` wraps `scanContext` from SDK ≥ 2.6.0; local-llm + mcp scan through it | VERIFIED *(prior — trust-boundary)* | SDK pinned 2.14.1 |
| K15 | CLAUDE.md: inbox accepts are batched, one identity tx per agent per cycle; see `docs/superpowers/plans/2026-07-29-batched-identity-update.md` | VERIFIED | `cli.js:7494+`; the referenced doc exists |
| K16 | CLAUDE.md: `docs/sovguard-context-integration.md` | VERIFIED | Exists |
| K17 | CLAUDE.md quick reference: `dashboard`, `setup … --template`, `start`, `inspect`, `update-profile --display-name`, `post-bounty --title --amount --description` | VERIFIED | `cli.js:9652-9654` — `--title`, `--description`, `--amount` are all `requiredOption` |
| K18 | CLAUDE.md testing: `node --check src/*.js src/executors/*.js` | VERIFIED | `package.json:21` `lint` script |
| K19 | README Testing section: 3 scripts with "47 checks", "32 checks", "24 checks" | **DRIFT → D13** | Static `check(` call counts are 45 / 42 / 44; the scripts are not in `package.json` `files`; and the real suite (`package.json:22` → `node --check … && node --test test/*.test.js`, **105** test files under `test/`) is never mentioned |
| K20 | Log message: "set `JAILBOX_ENABLED=true` to re-enable" (`cli.js:5440`, `job-agent.js:1406`) | **DRIFT → D4** | Both readers require the literal `'1'`: `config-loader.js:172` uses kind `bool1` (`raw === '1'`, `config-loader.js:186`) and `job-agent.js:1405` compares `!== '1'`. `=true` leaves the feature off with no diagnostic |

---

**Totals:** 118 claims — 74 VERIFIED · 30 DRIFT · 8 MISSING · 3 UNVERIFIED
(H15 external URL, J19 *(prior)*, G5 *(prior)*) · 3 recorded-not-reported
(A9, C7, H12).
