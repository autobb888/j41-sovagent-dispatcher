# first-run — audit findings

**Date:** 2026-08-10 · **Scope:** the path a brand-new operator walks between
`install` and their first completed job — install, `quickstart`, `init`,
`register`, `finalize`, `setup`, templates, first-run security setup, first
`start`, first job spawn.

**Counts:** crit 0 · high 4 · med 3 · low 5 · total 12
(plus 1 confirmed out-of-domain bug, **X1**.)

Read-only pass. No file outside `AUDIT/` was modified; nothing was executed
except `node -e` reads of JSON files in the working tree.

---

## Findings

| # | Sev | Finding | Anchor |
|---|---|---|---|
| F1 | **high** | A fresh agent has no funds, so `finalize`'s on-chain publish returns early — and the state machine records that as success, marks the agent `ready`, and makes the retry command a no-op | `cli.js:1103-1108` |
| F2 | **high** | The three "(no key needed)" LLM providers make the container answer every buyer message with canned filler, and that filler is delivered as the paid work product | `local-llm.js:242-244` |
| F3 | **high** | `quickstart` — the documented guided first-run command — discards the API key it collects, offers a provider that does not exist, and prints an export line for an env var the dispatcher never reads | `cli.js:1309-1342` |
| F7 | **high** | Both installers persist `runtime: "local"` whenever Docker is absent (and it is the *default* answer at the prompt), and the local-mode block does not fire until after the job has been accepted and paid for | `setup.sh:78-101` |
| F4 | med | The first-run security setup discards `setup()`'s `{success:false}` and prints `✓ Security setup complete` unconditionally — the same return value is checked correctly one file over | `cli.js:3455-3459` |
| F5 | med | The first-run security setup is given 10 seconds for an operation that installs gVisor and writes to root-only `/etc/j41`; the abandoned promise keeps mutating the host while the quick-check reads it | `cli.js:3455-3458` |
| F6 | med | `markup`, `network.capabilities`, `session` limits and `workspace` are prompted for, saved into the template, and then silently dropped by `setup`'s template merge | `cli.js:2764-2782` |
| F8 | low | README's stated failure mode for a missing job-agent image is wrong, and there is no image or daemon preflight anywhere | `cli.js:8408` |
| F9 | low | The dashboard's Start button declares success after 2.5 s, but the first-ever start can take 10 s before the security gate exits | `dashboard.js:2985` |
| F10 | low | `init -n <non-numeric>` creates nothing and reports `✅ NaN agents initialized` | `cli.js:1358` |
| F11 | low | `install.sh` puts the git worktree at `~/.j41/dispatcher` — the runtime data directory — and pins a tarball fallback 19 minor versions stale | `install.sh:12-13` |
| F12 | low | `quickstart` persists the runtime answer unvalidated; anything but the exact string `local` silently means docker | `cli.js:1316` |
| X1 | *(out of domain)* | `startJob` is called with `job` and `agentInfo` swapped on the `bounty.awarded` webhook path | `cli.js:7380` |

---

### F1 — high — a fresh agent cannot be funded in time, and finalize calls that success

**Files:** `src/cli.js:1099-1119`, `1648-1672`, `2926-2962`;
`node_modules/@junction41/sovagent-sdk/dist/onboarding/finalize.js:258-276`.

**Path.** README:46 names `setup <id> <name> --template <tpl>` the recommended
first-agent command. It runs four steps back to back with no pause:

1. `cli.js:2811-2818` — generates a brand-new keypair. The R-address balance is
   zero, necessarily.
2. `cli.js:2861` — `agent.register()`. This is the platform-side onboard
   handshake (`sdk/dist/agent.js:426-512`): challenge → signature → poll. No
   local transaction, no UTXO read. It succeeds on an unfunded address.
3. `cli.js:2911` — platform profile registration. Also no chain write.
4. `cli.js:2937` — `finalizeOnboarding`, whose first stage is the
   `publishVdxf` hook (`cli.js:1022`).

Inside `publishVdxf`:

```js
const utxoResp = await agent.client.getUtxos();
const utxos = utxoResp.utxos || utxoResp;
if (!utxos.length) {
  console.log('   ⚠️  No UTXOs available — identity needs funds for tx fee');
  console.log(`   ↳ Send at least 0.0001 VRSCTEST to ${keys.address}`);
  console.log(`   ↳ VDXF plan saved to: ${planPath}`);
  return;                      // ← cli.js:1107, resolves normally
}
```

The SDK cannot distinguish that from a completed publish:

```js
if (['onboarded'].includes(state.stage)) {
  if (params.hooks?.publishVdxf) {
    await params.hooks.publishVdxf();
    mark('vdxf_published', 'VDXF definitions published');   // finalize.js:271
  }
}
```

`mark()` writes `finalize-state.json`. The remaining stages are stubs
(`cli.js:1133-1138`) or already-done platform calls, so the state machine walks
to `ready` and `setup` prints:

```
  ✓ Finalize: ready
╔══════════════════════════════════════════╗
║     Setup Complete                       ║
╚══════════════════════════════════════════╝
```

**Trigger.** Any first agent. Universal, not edge-case: a keypair generated
seconds ago has no UTXOs, and `setup` offers no window to fund it.

**Outcome.** The identity exists on-chain and the platform profile exists, but
the identity's contentmultimap is empty — no `agent.displayName`, no
`agent.status`, no `agent.services`, no `agent.disputePolicy`. The operator has
been told twice that setup is complete.

**Why the recovery does not work.** README:154 and `cli.js:1671` both point at
re-running `finalize`. That command does not clear stale state (contrast
`setup`, which does at `cli.js:2930-2934`), so `readState` returns
`stage: 'ready'`, no `if` block matches, and `finalizeOnboarding` returns
immediately. `cli.js:1670` suppresses even the "can be resumed" hint, because
the stage *is* `ready`. The operator gets `✅ Finalize stage: ready` and nothing
happens.

**Second, independent defect on the same command.** Bare `finalize agent-1` —
the exact command `init` prints as step 3 (`cli.js:1406`) — resolves
`profile = undefined` (`cli.js:1651-1655`), so
`buildAgentContentMultimap(undefined, [], undefined)` returns `{}`
(`sdk/dist/onboarding/vdxf.js:368-441`). With funds present it builds, signs and
broadcasts an identity update carrying **zero** new keys, burns the fee, and
prints `✅ Identity updated on-chain: <txid>`. `--interactive` does not fix it:
`publishVdxf` runs at stage 1, `resolveProfile` at stage 4
(`finalize.js:268` vs `299`).

**Proposed fix (not applied).**
1. Make `publishVdxf` `throw` instead of `return` when `utxos.length === 0`, so
   `finalizeOnboarding` leaves the stage at `onboarded` and the rerun hint at
   `cli.js:1670` fires. The plan/cmd files it already wrote are the operator's
   manual fallback either way.
2. Give `finalize` a `--force` / `--restart` that unlinks
   `finalize-state.json`, and name it in the message printed at `cli.js:1670`.
3. In `finalize`, refuse to publish when `profile` is undefined rather than
   broadcasting an empty update — or reconstruct the profile from the agent's
   saved `profile.json` (README:383 says that file exists for this purpose).
4. In `setup`, print the funding address and stop before step 4 when the
   R-address has no UTXOs, rather than running a step that cannot work.

---

### F2 — high — keyless local providers deliver canned text as the work product

**Files:** `src/executors/local-llm.js:53-74, 119-137, 208-248, 503-523`;
`src/cli.js:7930-7938, 8418-8421`; `src/dashboard.js:1861-1919`;
`src/cli.js:1310`.

**Path.** The executor's entire "do we have an LLM" test is the truthiness of
the API key:

```js
const apiKey = process.env.J41_LLM_API_KEY || process.env.KIMI_API_KEY
             || (preset?.envKey ? process.env[preset.envKey] : '') || '';   // :60
...
if (LLM_CONFIG.apiKey) { /* real call */ }
else { response = generateTemplateResponse(message, this.job, this.soulPrompt); }  // :242-244
```

`ollama`, `lmstudio` and `vllm` are defined with `envKey: ''`
(`local-llm.js:46-48`) — correctly, they need no key. `buildContainerEnv`
therefore resolves `apiKey = ''` (`cli.js:7934-7938`), and the container env
filter drops empty values outright (`cli.js:8419`), so `J41_LLM_API_KEY` never
even reaches the container. `LLM_CONFIG.apiKey` is `''`. Every buyer message is
answered by:

```js
return `Thanks for your message. I'm processing your request regarding:
        "${job.description.substring(0, 60)}". Is there anything specific
        you'd like me to focus on?`;                              // :522
```

and `finalize()` (`local-llm.js:250-256`) concatenates that same
`conversationLog` and delivers it as the job's content, with a SHA-256 over it.

**Why nothing upstream catches it.** The preflight gate probes the *endpoint*,
not the key: `probeLLM` only bails when `baseUrl` or `model` is empty
(`llm-health.js:11`), and a running Ollama answers `POST /chat/completions`
with 200. So `preflightAllowsAccept` returns true, the job is accepted, the
buyer is charged, and the container silently degrades.

**Trigger.** Pick `ollama` (or `lmstudio` / `vllm`) in the TUI, where the
picker labels them **"(no key needed)"** (`dashboard.js:1865`, and `1919`'s
comment `// else: local providers (ollama, lmstudio, vllm) — no key needed`).
`quickstart` steers the same way, skipping the key prompt for exactly those
three (`cli.js:1310`). `custom` with an empty key (`dashboard.js:1916`) lands in
the same state.

**Contrast that shows the intent.** The `mcp` executor tests the same value and
refuses loudly: *"LLM API key is required for mcp executor"* (`mcp.js:54-56`).
`local-llm` is the one that degrades silently.

The `[LLM] No API key — using template responses` banner (`local-llm.js:73`)
prints once, at module load, inside the container — not on the host, not in the
job log the operator reads first.

**Proposed fix (not applied).** Gate on capability, not on the key: replace
`if (LLM_CONFIG.apiKey)` at `local-llm.js:121, 208, 214` with
`if (LLM_CONFIG.baseUrl && LLM_CONFIG.model)`, which is exactly the condition
`probeLLM` already uses — so "preflight passed" once again implies "the
executor will really call the model". Then delete `generateTemplateResponse`
and its call site, or reduce it to a hard failure: a paid job that cannot reach
a model should fail closed the way `mcp.js:54` does, not ship filler. If the
canned path is wanted for offline development, gate it behind an explicit
`J41_LLM_TEMPLATE_MODE=1` and refuse it on mainnet via
`findMainnetSecurityViolations`.

---

### F3 — high — `quickstart` produces a fleet that accepts zero jobs

**File:** `src/cli.js:1278-1348`.

**Path.** README:181 lists `quickstart` as *"Guided first-run setup (template,
LLM, runtime)"*; its own `--help` (`cli.js:1280`) claims it *"creates agent,
picks template, configures LLM"*. Three separate defects:

1. **The key is thrown away.** `apiKey` is read at `:1311` and used at
   `:1334-1337` for one purpose — building a printed `export` line. Nothing
   calls `saveDispatcherConfig`. `config.toml`'s `[provider_keys]` is untouched.
2. **The printed remedy names an env var that is never read.** The hint is
   `${preset.envKey}=${apiKey}`, e.g. `export OPENAI_API_KEY=sk-…`. But
   `buildContainerEnv` sources the key from
   `agentCfg.llmApiKey` → `cfg.provider_keys[provider]` → `cfg.llm.api_key`
   (`cli.js:7934-7938`) and never from the dispatcher's own `process.env` — the
   comment at `cli.js:7924-7926` states this as a deliberate design property.
   `OPENAI_API_KEY` in the shell does nothing. (`J41_LLM_API_KEY` *would* work,
   via `config-loader.js:160`; it is not what gets printed.)
3. **An advertised provider does not exist.** `:1305` offers
   `openai, claude, groq, deepseek, ollama`. `LLM_PRESETS` has no `claude` key —
   the real ones are `claude-opus` / `claude-sonnet` / `claude-haiku`
   (`local-llm.js:20-22`). Choosing `claude` yields `preset === undefined`, so
   the key hint is silently skipped at `:1337` *and* `baseUrl`/`model` resolve
   empty forever after.
4. **No agent is created.** `:1343-1344` prints the `setup` command rather than
   running it, contradicting the `--help` string.

**Trigger.** Run `j41-dispatcher quickstart`, answer every prompt, follow the
printed "Next steps" verbatim.

**Outcome.** `cfg.llm.provider` is set (via `J41_LLM_PROVIDER`, which *is* a real
override), `cfg.provider_keys.*` is empty. `probeLLM` gets a 401 (or, for
`claude`, `missing baseUrl/model`), `preflightAllowsAccept` returns false, and
every job is declined with `[PREFLIGHT] LLM unavailable` (`cli.js:6759`). The
fleet is fail-closed — correctly — but the operator followed the guided setup
exactly and has no working agent, and the one instruction that would fix it
points at the wrong variable.

**Proposed fix (not applied).** Have `quickstart` call
`saveDispatcherConfig({ llm: { provider }, provider_keys: { [providerKeyName]: apiKey } })`
directly — the write path already exists and already chmods 0600
(`config-loader.js:276-293`). Build the provider list from
`Object.keys(LLM_PRESETS)` instead of a hand-maintained string, and reject an
unknown answer. Either drop the `export` block entirely or emit
`J41_LLM_API_KEY`. Fix `:1280`'s description, or actually spawn `setup` at the
end.

---

### F7 — high — the installers' no-Docker default is a runtime that accepts jobs it cannot run

**Files:** `setup.sh:66-102, 124, 149-157`; `scripts/install.sh:92-130, 169-174,
216-218`; `src/cli.js:8715-8731, 3232-3239, 8994-9001`.

**Path.** Both installers detect Docker; when it is absent they choose local
mode, and local mode is the **default answer**:

```bash
read -p "  Enter choice [1/2] (default: 2): " CHOICE
CHOICE=${CHOICE:-2}          # setup.sh:78-79, install.sh:106-107
...
*) RUNTIME="local" ;;
```

Piped (`curl … | bash` — the advertised invocation, install.sh:4) there is no
prompt at all: `install.sh:98-100` goes straight to `local`. The choice is then
persisted to `~/.j41/dispatcher/config.json` (`setup.sh:101`,
`install.sh:169-173`), which is what `getRuntime()` reads (`config.js:40-42`).
Both scripts finish by telling the operator to start the dispatcher
(`setup.sh:155-156` `yarn start`; `install.sh:218` `j41-dispatcher start`).

`start` accepts that runtime without complaint. It prints `Runtime: local mode`
(`cli.js:3241`) and — because the 30-second local-mode warning is gated on
`RUNTIME === 'local' && _devUnsafe` (`cli.js:3232`) — local mode *without*
`--dev-unsafe` is the quietest configuration the dispatcher has. The refusal
lives in `startJobLocal`:

```js
if (!state._devUnsafe) {
  ...
  throw new Error('Local mode blocked — use --dev-unsafe for development');   // :8731
}
```

**Trigger.** Run either installer on a box without Docker, accept the default,
follow the printed next steps, and let a buyer hire the agent.

**Outcome.** The poll loop signs an accept and calls `acceptJob`
(`cli.js:6765`), logging `✅ Job … accepted … — awaiting buyer payment`. The
buyer pays. Only when the job is dispatched does `startJob` route to
`startJobLocal` and throw. Every job the fleet takes money for is refused at
spawn, forever, with a banner telling the operator to pass a flag the docs
elsewhere (README:826-829) tell them never to use in production.

**Proposed fix (not applied).** Move the `_devUnsafe` check from
`startJobLocal` to `start` itself, next to the mainnet gate at `cli.js:3122` —
refuse to boot in local mode without `--dev-unsafe` rather than refusing each
job after taking payment. Independently, make both installers' no-Docker path
either install Docker or exit non-zero with "Docker is required"; local mode is
documented as dev-only (README:824-829) and should not be what an unattended
install silently selects. If local mode must remain selectable, have the
installers append `--dev-unsafe` to the start command they print, so the
persisted state and the printed instruction agree.

---

### F4 — med — first-run security setup reports success it did not have

**Files:** `src/cli.js:3444-3472`;
`node_modules/@junction41/secure-setup/lib/index.js:155-160, 199-212, 236,
254-256`; `src/dashboard.js:2126-2131`.

**Path.**

```js
await Promise.race([
  secureSetup.setup('dispatcher'),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout …')), 10000)),
]);
console.log('  ✓ Security setup complete');     // cli.js:3459
```

The return value is discarded. `setup()` does **not** throw on its failure
paths — it returns `{ success: false, log, score: 0, mode }` at four places:
Docker missing (`index.js:158`), no isolation layer installable (`:211`),
profile deployment failed (`:236`), allowlist setup failed (`:255`). All four
resolve the race, so `✓ Security setup complete` prints.

The same library value is consumed correctly one file over:

```js
const setupResult = await secureSetup.setup('dispatcher');
if (setupResult.success) { … } else { console.log('  ❌ Setup had issues…'); }   // dashboard.js:2127-2131
```

**Trigger.** A fresh Linux box with Docker but without gVisor, bubblewrap, or
root. `installGvisor` fails, `installBwrap` fails, `setup()` logs
`[setup] No isolation layer could be installed. Aborting.` and returns
`success:false`.

**Outcome.** The operator sees `✓ Security setup complete`, immediately followed
by the quick-check's `SECURITY CHECK FAILED — dispatcher will not start` and
`exit(1)` (`cli.js:3484-3493`). Two adjacent, contradictory statements about the
same operation. The fail-closed exit is what saves this from being high; the
damage is that the operator cannot tell which message to believe.

**Proposed fix (not applied).** Capture the result and branch on it, mirroring
`dashboard.js:2127`:

```js
const r = await Promise.race([...]);
if (r && r.success) console.log(`  ✓ Security setup complete (${r.score}/10, ${r.mode})`);
else { console.error('  ❌ Security setup did not complete'); for (const l of (r?.log || [])) console.error('    ' + l); }
```

---

### F5 — med — 10 seconds for a root-only package install, and the loser keeps running

**Files:** `src/cli.js:3444-3502`;
`node_modules/@junction41/secure-setup/lib/index.js:68-92, 132-290`;
`lib/quick-check.js:100-113`.

**Path.** `secureSetup.setup('dispatcher')` does, in order: detect platform;
require Docker; **install gVisor** (download + apt/dnf + daemon reconfigure) or
fall back to **installing bubblewrap**; deploy seccomp/AppArmor profiles to
`/etc/j41`; create the Docker network and iptables rules; run the self-test;
write the marker. `cli.js:3457` gives all of that **10 000 ms**.

Two distinct problems.

**(a) It cannot complete without root on Linux.** `profileTargetDir` is
explicit about it:

```js
throw new Error('Cannot create /etc/j41 (need root). On Linux the runtime loads
  seccomp only from /etc/j41; deploying elsewhere would not be applied. …');   // index.js:85-89
```

This is a deliberate fail-closed decision in the dependency (the comment at
`index.js:81-84` explains that a `~/.j41` fallback would make `quickCheck` pass
while containers ran Docker-default seccomp). It directly contradicts
README:744 *"The system auto-detects the best isolation on first
`j41-dispatcher start` … **No manual configuration needed.**"* and the
seven-step list at README:779-787. Steps 2 and 3 need root; the correct
first-run instruction is `sudo npx @junction41/secure-setup --dispatcher`,
which `cli.js:3462` only prints *after* the attempt fails.

**(b) The timeout abandons a promise that keeps mutating the host.**
`Promise.race` settles; `setup()` does not stop. It continues installing
packages, writing `/etc/j41`, and rewriting iptables while the quick-check
(`cli.js:3477`) reads exactly those artifacts 0-10 s later.
`checkSeccompProfile` (`quick-check.js:100-113`) and `verifyProfileIntegrity`
both do bare filesystem reads with no settling. A dispatcher started under
`sudo` on a box where gVisor takes ~40 s therefore: races out at 10 s, prints
the timeout error, quick-checks a half-deployed `/etc/j41`, fails, and
`exit(1)`s — while the background setup carries on and finishes after the
process is gone, potentially leaving iptables and the Docker network in a
partially-applied state.

**Trigger.** Any genuine first `j41-dispatcher start` on a Linux host that does
not already have gVisor or bwrap. (a) fires without sudo; (b) fires with it.

**Proposed fix (not applied).** Raise the budget to something matched to a
package install (5-10 min) and make it cancellable, or — better — stop trying to
run it inline. Detect the missing prerequisites, print the one-line `sudo`
command, and exit; let the quick-check remain the enforcing gate. If the inline
attempt is kept, thread an `AbortSignal` into `setup()` so the timeout actually
stops the work instead of orphaning it, and do not run `quickCheck` in the same
process after a timed-out setup. Amend README:744 and 779-789 to say root is
required for steps 2-3.

---

### F6 — med — template fields are collected, saved, and then dropped

**Files:** `src/cli.js:2753-2785`, `559-619`, `2718-2747`;
`src/dashboard.js:993, 996, 1004-1015, 1059-1085`;
`templates/code-review/config.json`, `templates/workspace-reviewer/config.json`.

**Path.** `setup --template <name>` merges a fixed list into `options`
(`cli.js:2765-2782`): profile `name`, `type`, `description`,
`profile.category`, `profile.tags`, `network.protocols`, `models`; service
`name`, `description`, `price`, `currency`, `category`, `turnaround`,
`paymentTerms`. `buildFullProfile` then builds the profile from `options` alone.

Four fields that the templates carry, and that `buildFullProfile` *does* know
how to consume, are never copied — and `setup` exposes no flag for any of them
(there is no `--markup`, no `--workspace`, no `--session-*` beyond three that
the merge also ignores):

| Template field | Consumed by | Reached how, after `--template`? |
|---|---|---|
| `profile.markup` | `buildFullProfile` `cli.js:602-606` → VDXF `agent.markup` | never |
| `profile.network.capabilities` | `cli.js:566` → `agent.networkCapabilities` | never (`--profile-capabilities` takes a different shape: `[{id,name}]`) |
| `profile.session` | `cli.js:583-595` → `session.params` | never |
| `profile.workspaceCapability` / `profile.workspace` | `cli.js:608-618` → `workspace.capability` | never |

**Trigger.** The README's own quick-start line,
`j41-dispatcher setup agent-1 myagent --template code-review` (README:53).
`templates/code-review/config.json` declares `"markup": 5` and a full
`workspaceCapability` block; neither reaches the platform or the chain.

The sharpest version is the TUI. README:121-126 advertises the Custom Template
Builder as prompting *"for every field"* — and it does: markup
(`dashboard.js:993`), capabilities (`:996`), session duration/tokens/messages,
workspace enable + modes. It writes all of them into `config.json`
(`:1059-1085`). Then "Add New Agent" spawns `setup … --template <that template>`
(`dashboard.js:1165`), which discards exactly those four. The operator answered
the questions and the answers went nowhere.

`templates/workspace-reviewer` is the clearest casualty: it declares four
`network.capabilities` and a `workspace` block, and publishes neither — so even
with `JAILBOX_ENABLED=1` the VDXF policy gate (README:840, "Agents without
on-chain `workspace.capability` are blocked from workspace connections") would
block the one template built for workspace work. This is independent of, and
additional to, docs-truth **D3** (workspace is parked).

**Proposed fix (not applied).** Extend the merge at `cli.js:2765-2773` to cover
`tpl.profile.markup`, `tpl.profile.network.capabilities`, `tpl.profile.session`
and `tpl.profile.workspaceCapability ?? tpl.profile.workspace`, and add the
matching `setup`/`register` flags so the headless path can reach them too. Pick
one key name — the built-ins disagree (`code-review` uses
`profile.workspaceCapability`, `workspace-reviewer` uses `profile.workspace`,
`createCustomTemplate` writes `profile.workspace`) — and normalise the others.
Cheapest guard against recurrence: after the merge, warn on any top-level
template key that was not consumed.

---

### F8 — low — the documented symptom for a missing image is the wrong symptom

**Files:** README:38; `src/cli.js:8406-8408`.

README:38 says the image build is *"required before the first `setup` or
`start`; the dispatcher will hang mid-registration if it is missing."*

`j41/job-agent:latest` appears in exactly one place in the codebase —
`cli.js:8408`, the `Image:` field of `docker.createContainer` inside
`startJobContainer`. `setup` (`cli.js:2748-2963`), `register`
(`1446-1589`) and `start`'s boot sequence touch no Docker image at all. There is
no `docker.getImage`, `listImages`, `ping`, `version` or `info` call anywhere in
`src/`, so neither the daemon nor the image is preflighted.

**Trigger.** Install, skip the image build, register an agent, start the
dispatcher, take a job. Registration completes normally; the failure surfaces at
`cli.js:8571-8573` — `❌ Failed to start container for <job>: (HTTP code 404)
no such image` — after the buyer has been charged. It is reported to the
platform (`reportSpawnAttachFailed`), so the buyer is not left silently waiting,
but the operator has been pointed at the wrong lifecycle stage.

**Proposed fix (not applied).** Correct README:38 to say the failure appears on
the first job spawn, not during registration. Add a boot-time preflight in
`start` when `RUNTIME === 'docker'`: `await docker.ping()` and
`await docker.getImage('j41/job-agent:latest').inspect()`, refusing to start
with the `build-image.sh` instruction if either fails. That turns a
post-payment failure into a pre-flight one and is the single highest-value
first-run check missing.

---

### F9 — low — the dashboard's Start button is optimistic on the one run that matters

**Files:** `src/dashboard.js:2969-2996`; `src/cli.js:3444-3502`.

`dashboard.js:2982-2986` waits **2500 ms** for the spawned dispatcher to exit
before declaring `✅ Dispatcher started`. The comment above it
(`:2976-2981`) records that this window was added precisely to stop the button
reporting unconditional success.

On the *first* start, `cli.js:3446` enters the security-setup block, whose own
timeout is 10 000 ms (`:3457`), and only after that does the quick-check run and
`exit(1)` (`:3492-3493`). The child is therefore alive at 2500 ms in every
first-run failure mode, so the dashboard prints `✅ Dispatcher started (PID …)`
for a process that dies ~8 seconds later at the security gate.

**Trigger.** Fresh install → dashboard → `[7] Start Dispatcher` on a host
without gVisor/bwrap.

**Proposed fix (not applied).** Make the liveness window longer than the
first-run setup budget it must outlast (derive it: `securitySetupTimeout +
margin`, or simply 12 s when `~/.j41/dispatcher-security-initialized` is
absent), or poll for the PID file the dispatcher writes at `cli.js:3210` — a
positive signal that the boot sequence got past its gates — instead of a fixed
sleep.

---

### F10 — low — `init -n` accepts non-numeric input and reports NaN success

**File:** `src/cli.js:1354-1408`.

`const count = parseInt(options.agents);` (`:1358`) is unvalidated. `-n abc`
gives `NaN`; `for (let i = 1; i <= NaN; i++)` never executes; `:1402` prints
`✅ NaN agents initialized` followed by the four "Next steps". `-n 0` and
negatives behave the same way with a plausible-looking `✅ 0 agents
initialized`. `setup.sh:124` and `package.json:19` both hardcode `-n 9`, so this
only bites hand-typed invocations.

**Proposed fix (not applied).** Validate: reject when
`!Number.isInteger(count) || count < 1`, with an upper bound (each agent is a
keypair plus a directory) — the same shape as the range checks already applied
to `--job-timeout` (1-1440).

---

### F11 — low — `install.sh` makes the data directory a git worktree

**File:** `scripts/install.sh:12-13, 141-154, 159, 169`.

`INSTALL_DIR="${HOME}/.j41/dispatcher"` is the runtime data directory: agent
keys (`cli.js:117` `AGENTS_DIR`), `config.toml` (`config-loader.js:7-8`),
`dispatcher.pid`, `queue/`, `jobs/`, `active-jobs.json`. The script `git clone`s
or `git pull`s the repository into it.

Two concrete consequences:

1. On a machine that has already run the CLI, `~/.j41/dispatcher` exists and is
   non-empty but has no `.git`, so `git clone` fails. Stderr is suppressed
   (`2>/dev/null`) and the script falls through to the release-tarball path,
   extracting a source tree over the live data directory.
2. That fallback URL is built from `J41_VERSION="2.0.0"` (`:12`) while
   `package.json:3` is `2.19.0`. The asset almost certainly 404s; `curl -fsSL`
   fails, `tar` fails, and the `||` block exits 1 with `❌ Could not install
   dispatcher` — loud, but only after the clone has already been attempted.

Neither the README nor CLAUDE.md mentions `install.sh`, and `package.json:9-15`
does not ship `scripts/`, so an operator reaches it only from the repo. That
containment is why this is low rather than medium.

**Proposed fix (not applied).** Separate code from data: install to
`~/.j41/src` (or `~/.local/share/j41-dispatcher`) and leave `~/.j41/dispatcher`
to the runtime. Read `J41_VERSION` from the cloned `package.json` instead of
hardcoding it, or drop the tarball fallback. If the layout must stay, refuse to
clone into a directory that contains `agents/` and tell the operator to move it.

---

### F12 — low — the runtime answer is persisted without validation

**Files:** `src/cli.js:1316, 1328-1330`; `src/config.js:14-15, 40-42`.

`quickstart` asks `Runtime mode (docker or local)` as free text and writes the
answer straight through `saveConfig`. Every runtime branch in `cli.js` tests
`RUNTIME === 'local'` (e.g. `:1143`, `:3232`, `:8996`, `:9006`), so `Local`,
`LOCAL`, `podman` or a typo all silently mean docker. Because docker is the safe
side, this fails in the harmless direction — an operator who meant local gets
container mode — but it is stored state that no later command questions.

**Proposed fix (not applied).** Make it a two-choice prompt, or validate against
`['docker','local']` and re-ask. The same normalisation belongs in
`config.js:40`'s `getRuntime()`, which is the single read point.

---

### X1 — out of domain — `startJob` called with swapped arguments

**Files:** `src/cli.js:7380` vs `src/cli.js:8995`.

Reported because it is confirmed and cheap to fix, not because it is in this
domain — it belongs to webhook mode / bounties.

```js
async function startJob(state, job, agentInfo) { … }        // :8995
...
await startJob(state, agentInfo, fullJob);                  // :7380  ← swapped
```

**Path.** `bounty.awarded` webhook → `cli.js:7351-7388`. The job is fetched,
preflighted, accepted, signed and added to the allowlist (`:7367-7376`) — the
buyer is committed — and then dispatched with `job` and `agentInfo` transposed.

**Outcome.** `startJobContainer`/`startJobLocal` receive `job = agentInfo`.
`isValidJobId(job.id)` tests the agent id against `/^[A-Za-z0-9_-]{8,64}$/`
(`src/job-id.js:2`):

- `agent-1` … `agent-9` are 7 characters → fails the length bound → early
  `return` with `[security] Refusing job with invalid id: agent-1`.
- `agent-10` and above are 8 characters → **passes**, and execution continues
  into `fs.writeFileSync(path.join(jobDir,'buyer.txt'), job.buyerVerusId)`
  (`cli.js:8257`) with `undefined`, throwing `TypeError`.

Either way the bounty job is never started; the throw is swallowed by the
handler's own catch at `:7381-7383` (`[Webhook] Bounty job start failed: …`).
The three other call sites (`:6824`, `:7025`, `:7112`) pass the correct order.

**Proposed fix (not applied).** `await startJob(state, fullJob, agentInfo);`.
Consider making `startJob` take a single options object so the positions cannot
be transposed silently.

---

## Adversarial pass

*Shortest path from untrusted input to a bad outcome, within the first-run
domain.*

The untrusted inputs reachable before the first job completes are: platform API
responses during onboarding, the platform's category list, and template
`config.json` files.

**There is no short path.** Traced concretely:

- **Platform onboard response.** `register` writes `result.identity` and
  `result.iAddress` verbatim into `keys.json` (`cli.js:1490-1492`) with no
  validation, and later uses them as the identity for signing and for
  `buildIdentityUpdateTx`. A hostile or MITM'd platform can therefore make the
  dispatcher *believe* it owns an identity it does not. It cannot turn that into
  a loss: the WIF never leaves the host, `buildIdentityUpdateTx` filters inputs
  to `u.address === agentAddress`, and a transaction against an identity whose
  primary address is not ours is unspendable — it fails at broadcast. The
  reachable harm is a confused local state, recoverable with `recover`.
- **Category list.** `fetchCategories` (`dashboard.js:929`) renders
  platform-supplied strings into a prompt, and the choice reaches the profile
  and then the on-chain contentmultimap. An oversized value is bounded by
  transaction size — the identity update fails to build or is rejected. No
  execution, no file write outside the profile.
- **Template files.** `setup --template X` joins `X` into a path
  (`cli.js:2754`), so `--template ../../..` traverses. The value comes from the
  operator's own command line and the read is `JSON.parse` of a file they can
  already read; this is not a privilege boundary. `createCustomTemplate`
  sanitises the name it writes (`dashboard.js:976-977`).
- **`init` / `keygen`.** No external input at all — `generateKeypair` is local.

The real hazards in this domain are not adversarial. They are **fail-open on the
operator's own path**: F1 (no funds reported as success), F2 (no model reported
as work), F4 (failed setup reported as complete), F7 (a runtime that takes money
it cannot honour). Each converts a condition the system correctly *detected*
into a success message.

---

## Checked and found clean

Verified against code, no finding:

- **Directory and permission creation.** `ensureDirs` (`cli.js:382-389`) creates
  `~/.j41`, `dispatcher/`, `agents/`, `queue/`, `jobs/`, `jobs/_live` at
  `0o700`, and re-locks pre-existing agent dirs and sensitive per-agent files on
  every CLI invocation (`:396-410`). Idempotent and cheap.
- **`config.toml` creation.** `saveDispatcherConfig` (`config-loader.js:276-293`)
  mkdirs `0o700`, writes via tmp + rename, chmods `0600`, holds an advisory lock
  with stale detection (`:239-274`), and strips default-equal keys so a
  first-run file is short and readable. `loadDispatcherConfig` tolerates a
  missing file (`:433` bare `catch`) — a first run has no config and needs none.
- **Legacy `.env` migration.** `migrateLegacyEnv` (`:361-404`) fills gaps only
  (`mergeMissingOnly`), banners the source, is once-per-process
  (`:406, 427-430`), and refuses to touch a real install-dir `.env` from a
  sandboxed `HOME` (`:356-371`). The provider-key half of it is docs-truth **D2**,
  not a first-run defect.
- **The five built-in templates.** All present with `config.json` + `SOUL.md`;
  all carry a complete `service` block including a price, so
  `buildServiceFromOptions`' `!options.servicePrice` bail (`cli.js:850`) never
  fires and every first agent gets a marketplace listing. Categories are real
  platform categories.
- **`build-image.sh`'s staging list.** Cross-checked every `require('./…')` in
  `job-agent.js` and `src/executors/*.js`, plus their transitive local requires
  (`logger.js` → `config-loader.js`, `sign-attestation.js` →
  `sign-channel-client.js`), against the `cp` list at `scripts/build-image.sh:35-71`.
  Complete — no missing module. `package.docker.json` carries `@iarna/toml` for
  `config-loader.js`.
- **Duplicate-name protection.** Both `register` (`cli.js:1456-1475`) and
  `setup` (`:2840-2853`) scan every local agent's `identity`/`pendingName`
  before broadcasting, and `register` distinguishes `timeout` (offering
  `recover`) from `registered`.
- **Registration-timeout recovery.** `RegistrationTimeoutError` is caught in both
  commands, partial state (`registrationStatus`, `onboardId`, `identity`) is
  persisted, and the operator is pointed at `recover <agent-id>`
  (`cli.js:1575-1585`, `2869-2877`).
- **`setup` is re-runnable.** Existing keys are reused (`:2808-2810`), an
  existing registration is detected (`:2837-2838`), an existing SOUL.md is not
  clobbered (`:2821-2831`), and stale finalize state is cleared (`:2930-2934`).
  This is what makes F1 recoverable at all.
- **Financial allowlist is deny-all from the first read**, independently of
  whether `secure-setup` ever ran (`cli.js:149-164`), and fails closed to
  deny-all on a parse error (`:160-163`).
- **The quick-check gate genuinely refuses to start** on a failed check unless
  `--dev-unsafe` (`cli.js:3481-3495`).
- **`start` refuses with zero agents** (`:3153-3157`) rather than idling.
- **Preflight declines rather than accepting** when the LLM is unreachable, and
  says so per job with "buyer not charged" (`cli.js:6759`, `7079`, `7360`;
  `preflight-gate.js`; `llm-health.js` fails closed on every non-2xx, timeout
  and network error).
- **Custom-template name sanitisation** (`dashboard.js:976-977`) — lowercased,
  dash-collapsed, `[^a-z0-9-]` stripped, empty rejected, collisions refused.
- **Dashboard with zero agents** degrades correctly: header reads
  `Agents: 0 registered` / `Global LLM: (not configured)` (`dashboard.js:198-202`)
  and the agent list screen says *"No agents registered. Use 'Add New Agent' to
  create one."* (`:243-246`).
- **`j41-dispatcher` with no arguments** launches the TUI as documented
  (`cli.js:10953-10955`).
- **The dashboard's own security screen** checks `setupResult.success` and prints
  the full setup log (`dashboard.js:2126-2136`) — the correct pattern that
  `cli.js:3459` should adopt.
