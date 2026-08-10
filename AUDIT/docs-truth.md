# AUDIT — docs-truth

**Date:** 2026-08-10 · **Repo:** `j41-sovagent-dispatcher` @ `0ac4307` (v2.19.0)
**Scope:** read-only. No file outside `AUDIT/` was created or modified.

**Domain as scoped.** Does the documentation tell the truth about the code? The
unit of work is a *claim an operator would act on*: a default, a threshold, a
guarantee, a "refuses to", a path, a command, a config key, a menu item. Sources
audited: `README.md` (883 lines, in full), `CLAUDE.md` (222 lines, in full),
`docs/config.toml.example`, `package.json` (as published metadata), and the
operator-facing instruction strings the code itself prints. Companion checklist:
`AUDIT/docs-truth-claims.md` — 118 claims across 11 groups.

Six domain passes ran before this one and each verified the doc claims *inside
its own domain*. Where a claim was already resolved there, this pass records the
status and cites the prior finding rather than re-reporting it — 22 checklist
rows are marked *(prior)*. Everything below is new ground.

---

## Findings

| ID | Sev | Finding | Where |
|---|---|---|---|
| D1 | **high** | The documented install cannot produce a runnable dispatcher — `package.json` `files` omits the build script, the Dockerfile and the docker manifest, so the README's mandatory pre-step is impossible and no job can ever start | `package.json:9-15`; README:38-41, 515-522 |
| D2 | **med** | Three `[provider_keys]` slots are unreachable by any code path, and the `.env` migration routes keys into them; the documented config silently produces an agent that declines every job | `cli.js:7936`, `config-loader.js:31-35,352-357`, `docs/config.toml.example:39-55` |
| D3 | **med** | README advertises Workspace/jailbox as a live default feature — Overview bullet, full section, shipped template — while every entry point refuses by default | README:17, 119, 620-630; `config-loader.js:86`, `cli.js:5439`, `job-agent.js:1405` |
| D4 | **med** | The refusal message tells the operator to set `JAILBOX_ENABLED=true`; both readers require the literal `'1'`, so following the instruction changes nothing and prints the same message | `cli.js:5440`, `job-agent.js:1406` vs `config-loader.js:172,186` |
| D5 | **med** | Four of the twelve documented `/v1/events` types can only fire in webhook mode; in poll mode — the documented default — a monitor built to the published vocabulary never sees a dispute or an extension outcome | README:698-703; `cli.js:7043-7051, 7068, 3878` |
| D6 | **med** | `refunds` is absent from the README, and README:21 says crash recovery "handles refunds" when it only queues them for a manual approval command that is never documented | README:21, 148-191; `cli.js:6525-6538, 10803` |
| D7 | **low** | README's "Dispatcher Settings" points at a TUI screen that is dead code, and at `config.toml` for settings that live in an undocumented second config file | README:387-399; `cli.js:9350`, `config.js:10` |
| D8 | **low** | `ctl inbox` / `ctl inbox-redrive` — the recovery path for stalled on-chain writes — are undocumented in README, and CLAUDE.md instructs the use of one of them | README:171-179; `cli.js:9212`, CLAUDE.md:212 |
| D9 | **low** | The TUI names 24 of the documented 26 VDXF keys; a landed `review.attestation` renders as an unlabelled raw i-address | README:104; `dashboard.js:364-393, 564-574` |
| D10 | **low** | `docs/config.toml.example`, billed as "the full format", omits 13 keys including the whole proxy rate-limit/circuit block, and suggests a provider name that is not a preset | README:414; `docs/config.toml.example` |
| D11 | **low** | README Overview says the financial allowlist auto-adds **seller** addresses on job **creation**; the code adds the **buyer** address on **accept**, as README:818 correctly states | README:19 vs 818; `cli.js:175-188, 7093` |
| D12 | **low** | Documented Docker IPC path is `/tmp/ipc-msg.json`; the file is `/tmp/ipc-msg.jsonl` | README:24; `job-agent.js:790`, `cli.js:4982` |
| D13 | **low** | README's Testing section documents three unshipped scripts with stale counts and never mentions the 105-file suite `yarn test` runs | README:850-861; `package.json:22` |
| D14 | **low** | CLAUDE.md puts `financial-allowlist.json` / `network-allowlist.json` under `~/.j41/dispatcher/`; the real path is `~/.j41/`, and the second file is not written at all | CLAUDE.md:216-217; `cli.js:147` |
| D15 | **low** | CLAUDE.md file-map line counts are stale by 13% and 65% | CLAUDE.md:27-28 |
| D16 | **low** | The npm package description — the first thing a prospective operator reads — says 22 providers / 12 executor frameworks; the code has 25 presets and 6 executors | `package.json:4` |
| D17 | **low** | `IDLE_TIMEOUT_MS` is documented as an ops override of a `config.toml` value; it is neither, and setting it on the dispatcher is inert in both runtimes | README:418, 424, 431; `cli.js:7972, 7927-8014, 8749-8757` |

---

### D1 — high — the documented install cannot produce a runnable dispatcher

**Where.** `package.json:9-15`; `README.md:29-31, 38-41, 515-522, 874`.

**Claim.** README:29-31 gives one install command, `yarn global add
@junction41/dispatcher`. README:38-41 then makes the next step mandatory and
says what happens if you skip it:

> **Build the job-agent image** — required before the first `setup` or `start`;
> the dispatcher will hang mid-registration if it is missing:
> ```
> ./scripts/build-image.sh
> ```

README:519-521 offers the alternative `docker build -f Dockerfile.job-agent -t
j41/job-agent:latest .`, and README:871-875 repeats the script for rebuilds.

**Code path.** `package.json:9-15`:

```json
"files": ["src", "templates", "README.md", "CHANGELOG.md", "LICENSE"]
```

npm's `files` is an allowlist. The published tarball therefore contains no
`scripts/`, no `Dockerfile.job-agent`, and no `package.docker.json`.
`scripts/build-image.sh` needs all three of those to exist — it copies
`$DISPATCHER_DIR/package.docker.json` (`build-image.sh:41`) and
`$DISPATCHER_DIR/Dockerfile.job-agent` (`build-image.sh:72`) into its build
context. So both documented routes to the image are unavailable after the only
documented install.

There is no fallback. `cli.js:8408` hard-codes `Image: 'j41/job-agent:latest'`
into `docker.createContainer`, which does not pull; no `docker pull`, no
registry reference, and no build invocation exists anywhere in `src/`
(`grep -rn "job-agent:latest" src/` → `cli.js:8408`, `control.js:306` (an
`image inspect` for the `/health` version stamp), `job-agent.js:410` (a usage
string)).

`scripts/install.sh` *does* work — it clones the repo (`install.sh:15`
`REPO_URL=…`), so `scripts/` and the Dockerfile are present. It is never
mentioned in the README.

**Trigger.** On a clean machine:

1. `yarn global add @junction41/dispatcher`
2. `./scripts/build-image.sh` → `No such file or directory`. `docker build -f
   Dockerfile.job-agent .` → `unable to prepare context`.
3. `j41-dispatcher setup agent-1 myagent --template code-review`, fund, `start`.
4. First job → `startJobDocker` → `createContainer` fails with
   `No such image: j41/job-agent:latest`.

The dispatcher's own README warns the image is required, so this is not a
disputed premise — the defect is that the published package withholds the means
to build it.

**Severity.** high. It is the first thing a new operator does, it fails at step
2 of the quick start, and the failure it leads to is total (no job can run).
For a soft launch this is the single highest-leverage doc/packaging mismatch.

**Proposed fix (not applied).** Pick one:
- add `"scripts/build-image.sh"`, `"Dockerfile.job-agent"`,
  `"package.docker.json"` to `package.json` `files`, and keep the README as-is;
- or publish `j41/job-agent:<version>` to a registry, document `docker pull`,
  and have `cli.js` fall back to a pull with a clear error naming the tag;
- or make `scripts/install.sh` (the git-clone path) the documented install and
  demote `yarn global add` to "library use only".

Whichever is chosen, `cli.js:8408` should surface a first-class error naming
the missing image and the exact command to produce it, rather than a raw
dockerode 404.

---

### D2 — med — three `[provider_keys]` slots can never be read

**Where.** `cli.js:7936`; `preflight-gate.js:23`; `config-loader.js:31-35` and
`:352-357`; `docs/config.toml.example:39-55`; `README.md:414`.

**Claim.** README:414 — "Provider API keys belong in the `[provider_keys]`
table of `config.toml`… See `docs/config.toml.example` for the full format."
The example (`:42-55`) then lists fourteen slots, among them `anthropic`,
`google` and `xai`.

**Code path.** The key is looked up **by preset name**, not by provider family.
`cli.js:7930-7938`:

```js
const provider = (agentCfg && agentCfg.llmProvider) || cfg.llm.provider || '';
const preset   = LLM_PRESETS[provider];
…
const apiKey = (agentCfg && agentCfg.llmApiKey)
            || (provider && cfg.provider_keys[provider])
            || cfg.llm.api_key || '';
```

`preflight-gate.js:19-25` resolves it identically, by design ("Resolve exactly
as buildContainerEnv does").

`LLM_PRESETS` (`local-llm.js:14-49`) has no key named `anthropic`, `google` or
`xai` — the corresponding presets are `claude-opus|claude-sonnet|claude-haiku`,
`gemini|gemini-flash`, and `grok`. So `provider_keys.anthropic`,
`provider_keys.google` and `provider_keys.xai` are **read by nothing**. In the
other direction, seven preset names have no slot at all: `openai-mini`,
`openai-o3`, the three `claude-*`, both `gemini*`, `grok`, `kimi-nvidia`,
`azure`.

The `.env` migration makes it worse. `config-loader.js:352-357`
(`PROVIDER_KEY_ENV_MAP`) maps `ANTHROPIC_API_KEY → anthropic`,
`GOOGLE_API_KEY → google`, `XAI_API_KEY → xai`, and `:386-388` writes those
into `provider_keys.<family>`. README:16 promises legacy `.env` files are
"auto-migrated on first start"; for these three providers the migration reports
success and lands the key in a dead slot.

The dashboard path is self-consistent and does not hit this:
`dashboard.js:2215` writes `provider_keys[provider]` using the same preset name
the reader uses. Only the hand-edited and migrated paths — both the ones the
README documents — break.

**Trigger.** `~/.j41/dispatcher/config.toml`:

```toml
[llm]
provider = "gemini"
[provider_keys]
google = "AIza…"
```

→ `cfg.provider_keys['gemini']` is undefined → `cfg.llm.api_key` is empty →
`apiKey = ''`. At accept time `preflightAllowsAccept` (`cli.js:7079`) calls
`probeLLM` with `Authorization: Bearer ` → the provider returns 401 →
`probeLLM` returns `ok:false` (`llm-health.js:24`) → the job is declined and
`job.declined_llm_down` is emitted (`cli.js:7082-7083`). The fleet fails
closed — which is the right behaviour and the reason this is med, not high —
but the operator sees "LLM unavailable" while holding a valid key they placed
exactly where the docs told them to.

**Severity.** med. Fail-closed, no money moves, no buyer is charged; but it
silently disables the fleet, the diagnostic points at the wrong subsystem, and
the upgrade path (`.env` migration) walks operators into it.

**Proposed fix (not applied).** Add an explicit `PRESET_KEY_FAMILY` map in
`local-llm.js` (`claude-* → openrouter`, `gemini* → google`, `grok → xai`,
`openai-* → openai`, `kimi-nvidia → nvidia`, …) and resolve the key as
`provider_keys[family(provider)] || provider_keys[provider]`. Reconcile
`PROVIDER_KEY_ENV_MAP` against the same map. Failing that, delete the three
unreachable slots from `DEFAULTS` and the example, and state in both README:414
and the example header that `[provider_keys]` is keyed by **preset name**. A
warning at container build ("provider `gemini` selected, no API key resolved —
checked provider_keys.gemini and llm.api_key") would make the whole class
self-diagnosing.

---

### D3 — med — Workspace is documented as live; it is parked and refuses by default

**Where.** README:17, 119, 620-630, 840; `config-loader.js:86`; `cli.js:5438-5442`;
`job-agent.js:1403-1407`; `JAILBOX_PARKED.md`.

**Claim.** README presents workspace as a working feature in four places:

- Overview:17 — "**Workspace auto-connect** — job-agent polls for workspace
  status and connects jailbox **automatically** (no IPC required in Docker
  mode)."
- The template table:119 — `workspace-reviewer` · "Direct file access code
  review via workspace/connect".
- A dedicated section, README:620-630, describing a five-step lifecycle
  ("**Dispatcher connects** — the job-agent connects via the SDK's
  `WorkspaceClient`") and three handled events.
- Security:840 — "Agents without on-chain `workspace.capability` are blocked
  from workspace connections", which reads as *only* those agents are blocked.

**Code path.** The feature is default-off at three levels:

- `config-loader.js:86` — `jailbox: { enabled: false }`, with the comment
  "PARKED in favour of deliver-and-review… the dispatcher refuses to start a
  jailbox session unless an operator explicitly opts back in".
- Dispatcher gate, `cli.js:5438-5442` — `checkWorkspaceCapability()` returns
  `false` before it looks at the on-chain capability at all:
  ```js
  if (!cfg.jailbox.enabled) {
    console.warn(`[JAILBOX] ${agentId}: jailbox parked — …`);
    return false;
  }
  ```
  so no `workspace_ready` is ever forwarded.
- Container gate, `job-agent.js:1405-1407` — `connectWorkspace()` is described
  in its own comment as "the single funnel every start path… passes through",
  and returns immediately unless `process.env.JAILBOX_ENABLED === '1'`. The
  variable is forwarded only when `cfg.jailbox.enabled` is true
  (`cli.js:7988-7990`), so in Docker mode it is absent.

`JAILBOX_PARKED.md` sits in the repo root and explains all of this. The README
never links it and never uses the word "parked".

**Trigger.** `j41-dispatcher setup agent-1 rev --template workspace-reviewer`;
finalize (which publishes `workspace.capability` on-chain and registers the
service the README's template table advertises); a buyer hires and grants
workspace access. The platform emits `workspace.ready`; the dispatcher logs
`[JAILBOX] agent-1: jailbox parked — set JAILBOX_ENABLED=true to re-enable` and
forwards nothing. The agent has taken payment for a service whose defining
capability cannot execute.

**Severity.** med. No unsafe action — the default is the *safe* one and the
parking rationale is sound. The harm is that the docs sell a capability the
product does not ship, and one of the five built-in templates exists solely to
use it.

**Proposed fix (not applied).** Mark README:620-630 "**Parked — opt-in**", link
`JAILBOX_PARKED.md`, restate Overview:17 and the template row accordingly, and
correct Security:840 to say the jailbox gate blocks all sessions before the
capability check. Either gate `workspace-reviewer` behind `JAILBOX_ENABLED` at
`setup` time or add a warning when it is selected.

---

### D4 — med — the parked-jailbox remedy the code prints does not work

**Where.** `cli.js:5440`; `job-agent.js:1406`; `config-loader.js:172, 186`.

**Claim.** Both refusal sites print the same operator instruction:

```
[JAILBOX] jailbox parked — set JAILBOX_ENABLED=true to re-enable (refusing to start jailbox session)
```

**Code path.** Neither reader accepts `true`.

- Dispatcher side: `config-loader.js:172` registers `JAILBOX_ENABLED` with kind
  `bool1`, and `applyEnvOverrides` at `:186` implements `bool1` as
  `v = raw === '1'`. `JAILBOX_ENABLED=true` therefore sets
  `cfg.jailbox.enabled = false`, and `cli.js:5439` refuses again.
- Container side: `job-agent.js:1405` compares `process.env.JAILBOX_ENABLED !==
  '1'` directly. Even if the value were forwarded, `true` fails the test.

The codebase already knows this hazard and solved it elsewhere:
`config-loader.js:187-198` introduces a word-tolerant `bool` kind specifically
so `J41_FEE_SWEEP=true` cannot silently mean "disabled", with a comment
explaining that `bool1` is "fine for default-off opt-ins" — which is exactly
the reasoning that leaves this message wrong.

**Trigger.** `JAILBOX_ENABLED=true j41-dispatcher start` → identical refusal on
the next `workspace.ready`, no warning that the value was rejected. The
operator has followed the only instruction the system gave them.

**Severity.** med. It is the documented remedy for a documented refusal, it is
printed at the exact moment of failure, and it fails silently. Cheap to fix.

**Proposed fix (not applied).** Change both messages to `JAILBOX_ENABLED=1`, or
switch the `ENV_OVERRIDES` entry to kind `bool` and relax
`job-agent.js:1405` to the same word-tolerant test. Preferably both, so the
instruction and the parser agree in either direction.

---

### D5 — med — four documented event types cannot fire in poll mode

**Where.** README:698-703; `cli.js:7043-7051, 7068-7069, 3878`.

**Claim.** README:698-703 documents `/v1/events` as the polling transport for
headless clients and publishes a vocabulary:

> Event types follow a stable vocabulary: `job.started|delivered|completed`,
> `extension.requested|approved|rejected`, `dispute.filed|resolved`,
> `container.started|died`, `agent.online|offline`.

CLAUDE.md:60 repeats that `emitEvent` is "wired in cli.js at job/container/
extension/agent lifecycle points".

**Code path.** `extension.approved`, `extension.rejected`, `dispute.filed` and
`dispute.resolved` are **never emitted directly**. They exist only as values in
`WEBHOOK_EVENT_MAP` (`cli.js:7043-7051`), applied at `cli.js:7068-7069`:

```js
const evType = WEBHOOK_EVENT_MAP[event] || event;
state.emitEvent?.(evType, { jobId: jobId || null, agentId: agentInfo.id, … });
```

That line lives inside `handleWebhookEvent`, whose only call site in the repo
is the webhook HTTP route (`cli.js:3878`). Poll mode never reaches it.
Exhaustive enumeration of every `emitEvent` literal in `src/` yields 20 types;
`extension.approved`, `extension.rejected`, `dispute.filed`, `dispute.resolved`
are not among them.

The mismatch runs both ways: the feed emits fourteen types the vocabulary does
not name, including every one of the dispute signals poll mode *does* produce
(`dispute.unresolved_agent`, `dispute.surfacing_expired`,
`dispute.reconcile_gave_up`) and both refund-approval signals
(`refund.pending_approval`, `refund.needs_review`) — the latter being the only
programmatic notice that a buyer refund is waiting on a human (see D6).

**Trigger.** Default install (poll mode — README:11 "Poll mode (default)").
A monitor follows README:698-703, polls `/v1/events?since=N`, and watches for
`dispute.filed`. A buyer files a dispute; the dispatcher handles it
(`cli.js:5215-5423` reconciler) and `ctl jobs` / `/health` show it; the event
feed never mentions it. The client concludes there are no disputes.

**Severity.** med. The feed is documented as the integration surface for
"brainbox, a cron script, another orchestrator", and it is silently incomplete
in the default mode for exactly the two categories an operator most wants
pushed at them — money disputes and budget extensions.

**Proposed fix (not applied).** Emit the normalized types from the poll-mode
paths that already detect these transitions (the extension handler at
`cli.js:6594-6633` and the dispute reconciler at `cli.js:5215-5423`), so the
vocabulary holds in both modes. Then publish the full type list — including the
`refund.*`, `inbox.*` and `fee_*` families — rather than a five-item excerpt,
and say which are mode-specific.

---

### D6 — med — `refunds` is undocumented, and README says crash recovery "handles refunds"

**Where.** README:21, 148-191; `cli.js:6525-6538, 10803-10807`.

**Claim.** README:21, in the Overview feature list:

> **Crash recovery** -- detects orphaned jobs on startup, handles
> refunds/cleanup.

The CLI table (README:148-189) lists 30 commands. `refunds` is not one of them,
and the word does not appear anywhere else in the README.

**Code path.** `cli.js:6525-6538`, inside crash recovery:

```js
// ── Step 3: notify owner; entries wait for approval (no auto-send) ──────
// All crash-recovery refunds require owner approval before funds move.
// Use `j41-dispatcher refunds approve <jobId>` to approve and send.
for (const jobId of Object.keys(pendingRefunds)) {
  …
  state.emitEvent?.('refund.pending_approval', { … });
  console.log('  [refund] ⏸️  Queued for owner approval (j41-dispatcher refunds approve): ' + …);
}
```

The refund is written to `pending-refunds.json` and stops there. The command
that completes it exists (`cli.js:10803` — `refunds [action] [job-id]`, actions
`list | approve | reject | unblock`) and is documented only in CLAUDE.md's
prose about `wallet` ("External payouts have their own hardened path
(`refunds` + `financial-allowlist.json`)"), which does not tell an operator
that anything is waiting for them.

The only other notice is the `refund.pending_approval` event — which, per D5,
is not in the published event vocabulary either.

**Trigger.** Dispatcher is killed (OOM, host reboot, `kill -9`) with a job in
flight. On restart, crash recovery queues a refund to the buyer and logs one
line among the startup banner. Nothing else surfaces it: `ctl status` does not
report pending refunds, the README says refunds are "handled", and the command
to send them is undocumented. The buyer's money stays with the seller
indefinitely.

**Severity.** med. A doc omission that ends in an unpaid buyer, on a path the
README explicitly claims is automatic. The mechanism is correct and deliberately
manual — only the documentation is wrong.

**Proposed fix (not applied).** Add `refunds list|approve|reject|unblock` to
the README command table; correct README:21 to "queues buyer refunds for owner
approval (`j41-dispatcher refunds`)"; and surface a pending count in `ctl
status` / `/health` so the state is visible without reading startup logs.

---

### D7 — low — "Dispatcher Settings" points at dead code and the wrong config file

**Where.** README:387-399, 150, 379-385; `cli.js:9350, 9611`, `cli.js:1181-1247, 140`;
`config.js:10`; `dashboard.js:210-234`.

**Claim.** README:389 — "Configurable via interactive menu (**System
Settings**) or `j41-dispatcher config`", for the six-row settings table. The
CLI table's first row (README:150) repeats it: "Interactive TUI menu — run
agents, setup, **system settings**". README's File Paths table (379-385) lists
`config.toml` as the dispatcher's configuration file, and CLAUDE.md:118 states
"Source of truth: `~/.j41/dispatcher/config.toml`".

**Code path.** Two separate problems.

*The screen does not exist.* The reachable TUI is `dashboard.js` — `cli.js:10957`
routes the no-arg case there, and its menu (`dashboard.js:210-234`) has 18 items,
none of which is a settings screen. A `mainMenu()` with `3. System Settings` and
a working editor does exist at `cli.js:9350` / `cli.js:9611`, but
`grep -n mainMenu src/*.js` finds no caller for it — it is unreachable dead
code. (It also hardcodes `Network: verustest` at `cli.js:9619`, which would be
wrong on mainnet if it were reachable.)

*The settings are not in `config.toml`.* `j41-dispatcher config`
(`cli.js:1181-1247`) writes exclusively to `saveConfig()` →
`~/.j41/dispatcher/**config.json**` (`config.js:10, 37`). The values are read
back from the same place: `JOB_TIMEOUT_MS` at `cli.js:140` (`_cfg.jobTimeoutMin`),
and the extension thresholds at `cli.js:6596-6604` (`loadConfig()`). Neither
`job_timeout` nor the extension thresholds has any `config.toml` key —
`config-loader.js:10-86` `DEFAULTS` does not define them. The second config file
is named in CLAUDE.md's data-directory listing as "`config.json` # Runtime
config" and nowhere explained.

(The `--max-concurrent` row of the same table is separately DRIFT: the key it
writes is deliberately not consulted — liveness **L8**, scale **S14**.)

**Trigger.** An operator wants a 4-hour job timeout. They open the dashboard
looking for "System Settings", find nothing across 18 items; they then edit
`config.toml` per README:385 and CLAUDE.md:118, find no such key, and add one —
which is silently ignored. Only `j41-dispatcher config --job-timeout 240`
works. Separately, an operator who backs up "the config file" per the README
loses all six settings.

**Severity.** low. Nothing breaks and a working path exists; the cost is a
wasted search and a possible silent no-op edit.

**Proposed fix (not applied).** Delete the "System Settings" references (and
ideally the dead `mainMenu()`/`showSystemSettings` block, ~300 lines), or add
the screen to `dashboard.js`. Document `~/.j41/dispatcher/config.json` in the
File Paths table with the settings it owns, or migrate those six settings into
`config.toml` `[runtime]` and leave `config.json` as a read-compat shim.

---

### D8 — low — the inbox recovery commands are undocumented

**Where.** README:171-179, 660-669; `cli.js:9212`; `control.js:505-515`;
CLAUDE.md:212.

**Claim.** README documents nine `ctl` subcommands in the CLI table and repeats
nine in the Control Plane section.

**Code path.** `cli.js:9212` advertises eleven: "status, jobs, agents,
resources, earnings, history, providers, **inbox**, **inbox-redrive**,
shutdown, canary", and `control.js:505` / `:508` implement both. `--item` is a
documented-in-`--help` flag for `inbox-redrive` (`cli.js:9214`) whose absence
redrives *every* dead letter — the code comments say so explicitly.

CLAUDE.md:212, in the `update-profile` warning, instructs: "Check `ctl inbox` /
`/health` `pendingWrites` is empty first." That is the correct procedure, and
the README an operator has never defines the command.

**Trigger.** An agent's on-chain writes stall; `inbox-deadletter.js` quarantines
items. `/health` shows dead letters. The operator searches the README for a
recovery command and finds none. The state persists until they read
`--help` or the source.

**Severity.** low. The commands work and `j41-dispatcher ctl --help` lists them;
only the README is short.

**Proposed fix (not applied).** Add `ctl inbox` and `ctl inbox-redrive
[--item <id>]` to both README tables, with the "omit `--item` and it redrives
everything" caveat the source already documents.

---

### D9 — low — the TUI names 24 of the documented 26 VDXF keys

**Where.** README:104, 195-225; `dashboard.js:364-393, 546, 564-574`;
SDK `dist/onboarding/vdxf.js:77-127`; `cli.js:7449`.

**Claim.** README:104 — "**VDXF Keys** — all **26** on-chain keys with values,
`(not set)` for empty ones." README:195-225 then tabulates all 26, and the SDK
confirms the count (16 agent + service.schema + review.record +
review.attestation + 2 bounty + platform.config + session.params + 2 workspace
+ job.record = 26).

**Code path.** `dashboard.js:364-393` `ALL_VDXF_KEYS` — the array the viewer
iterates at `:546` — has **24** entries. Missing: `service.schema`
(`i4D2ifpAG7BYnfJZGVT1Tph7BMkp9qZPyS`) and `review.attestation`
(`i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv`). The parallel `VDXF_KEY_NAMES` map
(`dashboard.js:25-50`) omits the same two, so no name lookup rescues them.

`service.schema` is genuinely platform-only (README:217 says so), so its
absence is harmless. `review.attestation` is not: `cli.js:7449` routes inbox
items of type `attestation`, and the SDK's per-type allowlist
(`inbox/vdxf-gate.js:49-50`) admits exactly `VDXF_KEYS.review.attestation` for
them — the dispatcher writes this key to agent identities in normal operation.

Because it is absent from `knownAddrs` (`dashboard.js:565`), a populated
`review.attestation` falls into the unknown-key branch (`:566-574`) and prints
as a truncated raw i-address — `i76fJX1DreN81CoRVJH...` — with no label. An
empty one is never printed at all, contradicting "`(not set)` for empty ones".

**Trigger.** An agent accepts a review attestation (batch write succeeds,
txid logged). The operator opens dashboard → View Agents → *agent* → VDXF Keys
to confirm it landed, and finds no `review.attestation` row — only an
unexplained hex string in a yellow list at the bottom.

**Severity.** low. Read-only display; the data is on-chain and retrievable via
`inspect` / `getidentity`.

**Proposed fix (not applied).** Add both entries to `ALL_VDXF_KEYS` and
`VDXF_KEY_NAMES` (importing `VDXF_KEYS` from the SDK would make the list
drift-proof), or change README:104 to "24 agent-writable keys".

---

### D10 — low — `docs/config.toml.example` is not "the full format"

**Where.** README:414; `docs/config.toml.example` (97 lines);
`config-loader.js:10-86`.

**Claim.** README:414 — "See `docs/config.toml.example` for the full format."
The file's own header calls itself the config for `~/.j41/dispatcher/config.toml`.

**Code path.** Comparing the example's tables against `DEFAULTS`, thirteen keys
are absent:

- `[platform]` — `signer`
- `[runtime]` — `job_log_retention`, `job_log_max_bytes`, `job_log_max_retained`
- `[proxy]` — `max_output_tokens_cap`, `max_inflight_per_buyer`,
  `credit_low_threshold_vrsc`, `rate_limit_rps`, `rate_limit_burst`,
  `rate_limit_max_buckets`, `circuit_threshold`, `circuit_open_ms`
- `[jailbox]` — `enabled` (the flag D3/D4 turn on)

The eight `[proxy]` omissions are the load-bearing ones: they are the
per-buyer rate limiter and the upstream circuit breaker
(`config-loader.js:47-61`), the exact knobs an API-endpoint seller needs when
a buyer floods them, and they are unreachable from the documented surface
except via the `J41_PROXY_*` env vars.

Two further issues in the same file:

- `:34` — `provider = ""  # openai, claude, gemini, ... (one of LLM_PRESETS
  keys)`. `claude` is **not** an `LLM_PRESETS` key (`local-llm.js:19-21` defines
  `claude-opus`, `claude-sonnet`, `claude-haiku`). Copying the comment yields no
  preset, no baseUrl and no model — the same dead end as D2.
- `:14-15` — `skip_status_check` and `allow_local_upstream` are offered as
  config keys. README:753-754 names only their `J41_*` env forms in the mainnet
  gate, and the gate reads `process.env` exclusively (isolation **I5**), so the
  config-file form the example advertises is invisible to it. The example
  documents a path around a mainnet refusal without saying so.

**Trigger.** An API-endpoint seller reads README:414, opens the example, and
concludes there is no way to change the proxy rate limit. Or: an operator sets
`allow_local_upstream = true` on a dev box per the example's own comment
("only enable on dev boxes"), later promotes the config to mainnet, and the
gate that exists to catch exactly that does not fire.

**Severity.** low on its own (the config still works; `ENV_OVERRIDES` is
correctly cited at README:431 as the authoritative list). The `allow_local_upstream`
half compounds isolation **I5** and should be fixed together with it.

**Proposed fix (not applied).** Generate the example from `DEFAULTS` (a small
script plus a test asserting every `DEFAULTS` leaf appears), fix the `claude`
comment to `claude-sonnet`, and either annotate `skip_status_check` /
`allow_local_upstream` as "testnet only — **not** seen by the mainnet gate" or
remove them from the example until I5 is fixed.

---

### D11 — low — the allowlist Overview bullet contradicts the Security section

**Where.** README:19 vs README:818; `cli.js:175-188, 6772, 7093, 7373`.

**Claim.** README:19 — "**Financial allowlists** — deny-all by default,
auto-adds **seller** addresses on job **creation**, reloads from disk on every
check." README:818 — "**Dynamic lifecycle** — **buyer refund** address added on
job **accept**, removed on complete."

**Code path.** README:818 is right. `cli.js:175-188`:

```js
function addActiveJobToAllowlist(jobId, buyerAddress) { … list.active_jobs.push({ address: buyerAddress, jobId, added: … }) … }
```

and all three call sites pass a buyer address at accept time: `cli.js:6772`
(poll accept), `cli.js:7093` (webhook `job.requested` accept), `cli.js:7373`
(bounty award). Removal is `removeActiveJobFromAllowlist(jobId)` on completion
(`cli.js:8703`). The "reloads from disk on every check" half is correct —
`cli.js:176` re-reads the file per call.

**Trigger.** An operator reading the Overview believes the allowlist governs
where the agent's *earnings* may be sent, and audits it for seller addresses.
It contains buyer refund addresses. Since the allowlist is the deny-all gate on
outbound value, misreading its contents is a real risk to correct operation —
e.g. concluding an empty `active_jobs` array means "no outbound payments
possible" when what it means is "no refunds currently authorized".

**Severity.** low. One sentence, contradicted correctly 800 lines later.

**Proposed fix (not applied).** Change README:19 to "auto-adds the buyer's
refund address on job accept, removes it on completion".

---

### D12 — low — the documented Docker IPC path is wrong

**Where.** README:24; `job-agent.js:790`, `cli.js:4982` (and stale comments at
`cli.js:4970`, `job-agent.js:695`).

**Claim.** README:24 — "**Docker IPC** -- file-based IPC (`/tmp/ipc-msg.json`)
for reconnect/pause/resume in Docker containers."

**Code path.** The file is JSON **Lines** and named accordingly.
`job-agent.js:789-790`:

```js
// Docker mode — poll /tmp/ipc-msg.jsonl for messages from dispatcher (one JSON per line)
const IPC_FILE = '/tmp/ipc-msg.jsonl';
```

and the writer, `cli.js:4982`: `'sh', '-c', 'cat >> /tmp/ipc-msg.jsonl'`. Two
comments still carry the old name (`cli.js:4970`, `job-agent.js:695`), which is
presumably where the README's version came from.

**Trigger.** An operator debugging a stuck pause/resume runs
`docker exec j41-job-<id> cat /tmp/ipc-msg.json` → `No such file or directory`,
and concludes the IPC channel was never written. The format difference matters
too: append-per-line, not a single JSON document (see liveness **L13** for the
read-then-unlink race on the same file).

**Severity.** low.

**Proposed fix (not applied).** Correct README:24 to `/tmp/ipc-msg.jsonl` and
note the line-delimited format; fix the two stale comments.

---

### D13 — low — the Testing section documents unshipped scripts and omits the real suite

**Where.** README:850-861; `package.json:9-15, 21-22`; `scripts/`; `test/`.

**Claim.** README:850-861 is the entire testing story:

```
node scripts/test-create-template.js      # 47 checks
node scripts/test-full-flow.js            # 32 checks
python3 scripts/test-interactive.py       # 24 checks
```

**Code path.** Three problems.

1. `scripts/` is not in `package.json` `files` (D1), so none of these exists
   after the documented install.
2. The counts are stale: static `check(` call sites are 45, 42 and 44
   respectively.
3. The actual suite is never mentioned. `package.json:22` defines
   `test`: `node --check src/*.js src/executors/*.js && node --test
   test/*.test.js`, and `test/` holds **105** test files covering the money,
   keys, isolation, liveness and scale machinery. `scripts/test-interactive.py`
   additionally asserts on a `.env` file (`:294-296`), a config format the
   project migrated away from (README:16).

CLAUDE.md:203-208 has the same gap — it documents `node --check` and two live
API calls as "Testing", and never mentions `node --test`.

**Trigger.** A contributor or a soft-launch verifier follows README:850,
runs one legacy script, sees "45 passed", and believes the project is verified
— having executed none of the 105-file suite that covers the parts that move
money.

**Severity.** low (process, not runtime), but directly relevant to a soft
launch where "did we test it" is the question being asked.

**Proposed fix (not applied).** Lead the Testing section with `yarn test`
(`node --check` + `node --test test/*.test.js`, 105 files), then list the three
legacy scripts as repo-only integration helpers with a note that they are not
in the npm package. Drop the hard-coded check counts or generate them.

---

### D14 — low — CLAUDE.md's allowlist paths are wrong

**Where.** CLAUDE.md:216-217; `cli.js:147`;
`@junction41/secure-setup/lib/setup-allowlist.js:6-9`.

**Claim.** CLAUDE.md's Data Directories block:

```
~/.j41/dispatcher/
  …
  financial-allowlist.json        # Deny-all default
  network-allowlist.json          # DNS/IP allowlist
```

**Code path.** Both live one level up. `cli.js:147`:

```js
const ALLOWLIST_PATH = path.join(os.homedir(), '.j41', 'financial-allowlist.json');
```

and `setup-allowlist.js:6-9` creates it at the same `~/.j41/` path. README:786
and README:815 both state the correct location, so this is a CLAUDE.md-only
error. `network-allowlist.json` is worse than misplaced: it is no longer
written by anything (`setup-network.js:251-252` says so explicitly) and has no
reader in `src/` — isolation **C5/C6**.

**Trigger.** An operator (or an agent working from CLAUDE.md) creates or edits
`~/.j41/dispatcher/financial-allowlist.json` to authorize a payout address. The
dispatcher reads `~/.j41/financial-allowlist.json`, which is unchanged and
deny-all, and the send is refused with no indication that the edited file is
the wrong one.

**Severity.** low. The failure is fail-closed and the README is correct.

**Proposed fix (not applied).** Move both entries out of the
`~/.j41/dispatcher/` block in CLAUDE.md into a `~/.j41/` block, and delete the
`network-allowlist.json` line (or mark it "no longer used — see
isolation C5").

---

### D15 — low — CLAUDE.md file-map line counts are stale

**Where.** CLAUDE.md:27-28.

**Claim.** `src/cli.js` "~9700 lines"; `src/dashboard.js` "~1900 lines".

**Code path.** `wc -l`: `cli.js` is **10958**, `dashboard.js` is **3144** —
13% and 65% understated.

**Trigger.** CLAUDE.md is the orientation document for anyone (human or agent)
working in this repo; a 65% understatement of the TUI's size mis-sets the
expectation for how much of it a change touches, and both numbers are the kind
of detail a reader assumes is checked because it is stated so precisely.

**Severity.** low.

**Proposed fix (not applied).** Round to the nearest thousand ("~11k", "~3k")
so the numbers age gracefully, or drop them.

---

### D16 — low — the npm package description undercounts providers and executors

**Where.** `package.json:4`.

**Claim.** `"description": "Multi-agent orchestration for Junction41 — supports
**22 LLM providers, 12 executor frameworks**, workspace/connect, and on-chain
VDXF identity"`. This string is what npm renders on the package page and in
`npm search` — for most prospective operators it is the first sentence they
read.

**Code path.** `LLM_PRESETS` (`local-llm.js:14-49`) has 25 entries;
README:530 says 25. Executors are 6 (`executors/index.js:34-60`) plus 6
framework aliases (`:21-28`) = 12 accepted names, which is presumably where
"12 executor frameworks" comes from, but README:558-569 presents it as 6 types
and 6 aliases. The description also advertises `workspace/connect`, which is
parked (D3).

**Trigger.** Cosmetic, but it is the published description of a package at
v2.19.0 going into a soft launch, and it disagrees with its own README on the
headline number.

**Severity.** low.

**Proposed fix (not applied).** "…supports 25 LLM provider presets and 6
executor types (12 accepted names)…", and drop or qualify `workspace/connect`
until D3 is resolved.

---

### D17 — low — `IDLE_TIMEOUT_MS` is documented as an ops override and is inert

**Where.** README:416-424, 431; `cli.js:7972`, `cli.js:7927-8014`,
`cli.js:8749-8757`; `job-agent.js:52`; `config-loader.js:100-172`.

**Claim.** README:416-418 heads the table: "**Environment Variables (ops
overrides)** — These env vars override the corresponding `config.toml` value
for CI or one-shot ops." Row 3 is:

> `IDLE_TIMEOUT_MS` | Idle timeout before pause (default: 480000 ms / 8 min —
> deliberately before the backend's 10-min auto-deliver)

README:431 then says "Full override list: `ENV_OVERRIDES` in
`src/config-loader.js`".

**Code path.** There is no corresponding `config.toml` value to override —
`config-loader.js:10-86` `DEFAULTS` has no idle-timeout key — and
`IDLE_TIMEOUT_MS` is absent from `ENV_OVERRIDES` (`config-loader.js:100-172`),
so README:431 and README:424 contradict each other.

More consequentially, the variable is read only inside the worker
(`job-agent.js:52` — `parseInt(process.env.IDLE_TIMEOUT_MS || '480000')`), and
neither env-construction path forwards the dispatcher's own value. The only
writer is per-service lifecycle data, `cli.js:7972`:

```js
if (job.lifecycle?.idleTimeout) env.IDLE_TIMEOUT_MS = String(job.lifecycle.idleTimeout * 60000);
```

Both consumers of that object are explicit allowlists with no `process.env`
spread — Docker at `cli.js:7927-8014` (env built key by key, then filtered at
`cli.js:8418-8421`) and local at `cli.js:8749-8757` (`WHITELISTED_ENV` =
`PATH, HOME, USER, SHELL, LANG, TERM, NODE_ENV, HOSTNAME, TZ, NODE_PATH`, then
overlaid with `buildContainerEnv`'s output). So
`IDLE_TIMEOUT_MS=900000 j41-dispatcher start` reaches no container in either
runtime.

This is the same shape as trust-boundary **T8** (`J41_SCAN_BUYER_CHAT` never
forwarded) — and the codebase has already fixed the identical bug twice, for
`J41_DISPUTE_HOLD_MAX_MS` (`cli.js:7947-7958`, whose comment reads "setting it
on the dispatcher alone did nothing, and the knob silently had no effect") and
`J41_RATE_LIMIT_BACKOFF_MULTIPLIER` (`cli.js:7992-7995`).

**Trigger.** An operator running long research jobs wants a 25-minute idle
window instead of 8. They export `IDLE_TIMEOUT_MS=1500000` per README:424,
restart, and every job still pauses at 8 minutes (or at the service's
`--idle-timeout`, whichever applies). No warning, no log line.

**Severity.** low. The documented per-service knob (`--idle-timeout`, README:406)
does work and is the intended surface; the env var is a phantom.

**Proposed fix (not applied).** Either forward it — the one-line
`...(process.env.IDLE_TIMEOUT_MS ? {…} : {})` pattern already used for
`J41_DISPUTE_HOLD_MAX_MS` at `cli.js:7955` — or remove the row from README's
override table and point at `--idle-timeout` instead. The same edit should
resolve `J41_NO_STATUS_TOGGLE`'s presence in a table headed "override the
corresponding `config.toml` value" when it is deliberately env-only (README:429
says so in its own cell, but the table header contradicts it).

---

## Adversarial pass

The audit template asks for the shortest path from untrusted input to a bad
outcome. For docs-truth the input is not a buyer message — it is **the
operator's trust in a sentence**. The question becomes: *is there a document in
this repo that, followed literally, leaves the system worse off than not
following it?*

Three exist, in descending order of harm.

**1. "Run a second dispatcher against a different subset of agents"
(README:366-370).** Already reported as scale **S1**, and still the worst of
them: the PID handler SIGTERMs the running instance, waits 10 minutes, and
exits 1. An operator responding to a capacity warning by following the only
remedy the docs offer takes their own fleet down. Not re-reported here; noted
because it is the answer to this question.

**2. `allow_local_upstream = true` in `docs/config.toml.example:15`
(D10 + isolation I5).** The comment says "only enable on dev boxes", which
invites exactly the promotion path that defeats it: the mainnet gate reads
`process.env` only (I5), so a config-file value survives promotion to mainnet
invisibly. The README's mainnet-gate list (753) names only the env form, so
nothing in the documentation tells the operator the two forms behave
differently. Compare the fee-sweep documentation (README:250-258), which
handles precisely this env-vs-config asymmetry correctly and even explains why —
the codebase knows how to write this warning and did not here.

**3. `JAILBOX_ENABLED=true` (D4).** Printed by the code, at the moment of
failure, as the fix. It does nothing. This is the shortest path of all — no
document to find, no inference required, and the system itself is the source.

Against those, the *absence* class is milder but broader: `refunds` (D6) and
`ctl inbox-redrive` (D8) are undocumented recovery commands for states the
system does reach, and D1 is an install that cannot complete. None of them
causes a bad action; they cause a correct action never to be taken.

What is **not** here: no documentation instructs the operator to disable a
security control, weaken isolation, expose a port, or hand out a key. Every
`J41_*` escape hatch the README names is named in a section titled "do not set"
or inside the mainnet refusal list (README:746-775), and that list is accurate
against `mainnet-guard.js`. The security documentation errs consistently toward
describing an older, weaker design than the one that shipped (isolation C2/C3/C4)
— stale in the safe direction.

---

## Checked and found clean

Verified against code and found accurate. Listed so a later pass does not
re-walk them.

**Command surface.** All 25 README-listed commands exist with the documented
names and arity (`cli.js` `.command()` sites enumerated in claims B3). No-args
launches the TUI (`cli.js:10956-10958`). `--json` on `ctl` (`cli.js:9215,
9230`). `logs -f` (`cli.js:4551`). `init -n` default 9 (`cli.js:1354`).
`respond-dispute`'s three documented invocations match its flags and its
action validation exactly (`cli.js:9112-9124`).

**Dashboard.** README:61-96 reproduces `dashboard.js:210-234` item for item,
including all four separators, the unlabelled `⚡ Live Jobs` entry and the Quit
row — 18 numbered items as claimed by both README:9 and CLAUDE.md:164. ESC-to-
go-back is real and near-total: 220 `promptWithEsc` call sites, one residual
raw `inquirer.prompt(` (inside the helper itself). Five built-in templates,
each with `config.json` + `SOUL.md`. The custom-template builder prompts for
every field README:121-126 lists, and writes to `templates/<name>/` as claimed.

**VDXF.** The 26-key table (README:199-225) matches the SDK's `VDXF_KEYS`
exactly — names, grouping, and the `agent.disputePolicy` (was `svc.dispute`)
rename. `service.schema` is genuinely platform-only. CLAUDE.md's hash160-sort
requirement and its "SDK 2.13.1 or later" floor hold against the pinned 2.14.1.
CLAUDE.md's claim that `update-profile` is a single transaction that preserves
other keys, and that it is **not** gated by the pending-write check, are both
correct (`cli.js:2341-2464` contains no gate call).

**Configuration numbers.** Every default and range in README's three settings
tables: job timeout 60/1-1440, extension auto-approve true, CPU 80%, RAM 512 MB,
idle-timeout 5-2880/10, pause-ttl 15-10080/60, reactivation-fee 0-1000/0. The
entire budget table (six settings, six env overrides) against
`config-loader.js:73-80` and `ENV_OVERRIDES:132-137`, plus the claim that the
rate is stamped with a container start time (`cli.js:7999-8006`). The
minutes-vs-milliseconds warning at README:258, including its stated rationale,
matches the comment at `config-loader.js:125-127`. `J41_NO_STATUS_TOGGLE` is
env-only exactly as documented and skips both loops (`cli.js:4160, 4295`).

**Providers and executors.** 25 presets, counted. All 19 provider-table rows —
preset name, variant names, default model — checked individually against
`local-llm.js:16-48`, including `azure`/`custom`'s deliberately empty
baseUrl+model. "Claude presets route through OpenRouter" is true of all three.
Six executor types with the documented `J41_EXECUTOR` values and all six
framework aliases (`executors/index.js:21-60`). `local-llm.js` does export
`resolveLLMConfig` as CLAUDE.md requires.

**Control plane and health.** Socket path, `:9843` bind, bearer token at
`~/.j41/dispatcher/control.token` (0600, auto-created), auth enforced before
every route including from localhost, all six `/v1` endpoints with the
documented shapes, `/v1/jobs/:id` 404 semantics, 405 on any non-GET ("read-only
skeleton" as promised), the `{events, cursor}` envelope, the monotonic
file-backed `seq`. `/health` open and unauthenticated on `:9842` with
`/metrics` in Prometheus text. The dotted-path compatibility promise
(`agents.0.status`, `containers.0.state`, `summary.containers_unhealthy`) holds
against `control.js:165, 459-464`, and the code restates the promise at
`control.js:94`. All four documented proxy routes exist at the documented
methods and paths (`webhook-server.js:119, 135, 158, 250`).

**Lifecycle and disputes.** Job-lifecycle steps 1-6 and 8-9. The
post-delivery-container-stays-alive claim and both kill conditions. All five
rows of the webhook-events table, with IPC forwarding as described. All three
workspace event names are handled (the gate above them is D3).

**Overview bullets.** Canary: `J41_CANARY_TOKEN`, HTML-comment injection into
the SOUL prompt, SDK `checkForCanaryLeak`, `registerCanary` — all four halves
(`job-agent.js:67, 337, 492-495, 543-547`). Kimi `<|tool_calls_section_begin|>`
parsing (`local-llm.js:460-466`). UTXO chaining (SDK `agent.js:2208-2289`, used
by the refund path at `cli.js:5834`). SovGuard 429 backoff
(`auth-backoff.js:55`, multiplier forwarded to containers at `cli.js:7992`).
"A fresh install requires no `J41_*` env vars" — `DEFAULTS` is complete and
every override is optional. Financial allowlist "reloads from disk on every
check" (`cli.js:176`).

**CLAUDE.md internals.** All four "API Response Shapes" gotchas verified
against the SDK's actual return statements — `getIdentityRaw` returns the
envelope, `getUtxos` returns `res.data`, `getAgentServices`/`getMyBounties`
return the envelope — and against the consumers that unwrap them. The three
"Key Patterns" claims (`promptWithEsc`, `runCommandAsync`, the
`a.identity && a.iAddress && a.wif` agent filter). `agent-config.json` written
0600 (`dashboard.js:1699`). Both referenced docs exist
(`docs/sovguard-context-integration.md`,
`docs/superpowers/plans/2026-07-29-batched-identity-update.md`). The
`post-bounty` quick-reference invocation matches its three `requiredOption`s.
CHANGELOG's top entry (2.19.0) matches `package.json:3`.

**Security section (the parts not owned by a prior pass).** The mainnet gate's
13-entry list is accurate. The two "legacy opt-outs (do not set)" are both in
that list, as claimed. First-run step 5 creates `~/.j41/financial-allowlist.json`
deny-all (`setup-allowlist.js:27-38`). Local mode is blocked without
`--dev-unsafe` and warns on a 30 s cadence. Local-mode env is a genuine
whitelist with no `process.env` spread. `j41-secure-setup --check|--test
--dispatcher` are real flags on a real binary. The "honest scope" paragraph on
at-rest encryption (README:442) is an accurate statement of the threat model.

---

## Deliberately NOT covered, and why

- **`docs/` beyond `config.toml.example`.** The repo carries ~60 documents under
  `docs/` — testing briefs, backend correspondence, superpowers specs and plans,
  `RELEASE-READINESS.md`, `JAILBOX_PARKED.md`. They are dated working records,
  not operator instructions, and auditing a 2026-07-30 test brief against
  today's code would produce drift that is *correct* — the record is of what was
  true then. Only the three documents README/CLAUDE.md actively point an
  operator at were checked. `docs/RELEASE-READINESS.md` is the one exception
  worth a later look, since it makes present-tense claims about launch
  readiness; it is a self-assessment, and auditing it against the six completed
  domain passes is a different exercise from auditing docs against code.
- **`--help` text beyond the commands a README claim touched.** Commander
  option descriptions are documentation, and D8 turned up one case where
  `--help` is *more* accurate than the README. A systematic `--help`-vs-code
  sweep across ~32 commands and ~150 options is its own pass.
- **The CHANGELOG.** 1659 lines of historical claims. Verified only that its
  top version matches `package.json`. Auditing historical entries against
  current code has the same category error as auditing old test briefs.
- **Claims already resolved by a prior domain pass.** 22 checklist rows are
  marked *(prior)* and cite the finding that owns them — money M1/M3/M7/M10,
  keys K5/D3, isolation C2/C3/C4/C5/C6/I5/I7/I9/I10/I11/D4, trust-boundary T8's
  shape (reused in E20), liveness L1/L2/L8/L9/L10/L12/L17, scale S1/S2/S8/S11/
  S14/C1. This pass restates their status for completeness and does not
  re-derive the analysis.
- **Whether the platform's API behaves as the docs imply.** README:653 points
  at `docs.junction41.io/dispatcher/api-endpoint-proxy`; README:424 asserts a
  backend 10-minute auto-deliver that the 8-minute idle timeout is sized
  against; README:235 asserts the platform auto-delivers on pause-TTL expiry
  (liveness L17 found no dispatcher-side implementation). All three are
  backend-side and marked as such rather than guessed at.
- **Prose quality, tone, structure, or completeness as documentation.** Only
  falsifiable claims are in scope. "The README should have a troubleshooting
  section" is not a finding.
- **Running any code.** Read-only per the audit rules — no tests executed, no
  `node --check`, no docker commands, no network calls, no `npm pack`. D1 rests
  on reading `package.json` `files` against `scripts/build-image.sh`'s own
  `cp` list, not on inspecting a built tarball; that is npm's documented
  `files` semantics (allowlist) and is the one place a verification `npm pack
  --dry-run` would be worth running before acting on the finding. Every
  quantitative statement (25 presets, 26 VDXF keys, 24 TUI keys, 105 test
  files, 220 `promptWithEsc` sites, the three check counts, the two line
  counts) is a count of source, reproducible with `grep`/`wc`.
