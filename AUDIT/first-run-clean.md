# first-run-clean — audit findings

**Date:** 2026-09-15 · **HEAD:** `5ca8776` · **Scope:** brand-new operator
on a clean GitHub clone of this integrate tree, plus the documented
`curl | bash` / `npm i -g` doors, through doctor → `build-image` → first
agent → first `start`. The 12 first-run PRs on this branch are in scope.

Read-only. No file outside `AUDIT/` was modified. Dispatcher was not
started. `setup` was not run (mints on-chain). `~/.j41-orchard-backup-*`
was not touched. Observed live this session is cited only where the same
path is in source.

**Counts:** crit 0 · high 1 · med 1 · low 1 · **total 3**

Claims: `AUDIT/first-run-clean-claims.md` — 48 claims,
38 VERIFIED · 8 DRIFT · 0 MISSING · 2 UNVERIFIED.

---

## Findings

| # | Sev | Finding | Anchor |
|---|---|---|---|
| FRC1 | **high** | Documented install (`curl \| bash`, `npm i -g j41-dispatcher`, `npm i -g @junction41/dispatcher`) still delivers published **2.37.3 = `1a340d8`**, which does **not** contain this branch. That tarball still has F4/F5 `Promise.race` + lying ✓, F9 2.5s Start success, and no process-entry Node 20 / start clock gates. HEAD did not bump `package.json` version, so a republish of `2.37.3` cannot replace it. | `package.json:3`; `scripts/install.sh:15-16,212-219`; `packages/j41-dispatcher-alias/package.json:21`; git `1a340d8` vs `5ca8776` |
| FRC2 | med | A GH clone has no `j41-dispatcher` on PATH. README, doctor Next, `identityNext`, `build-image` "Next:", and `INDEXER_LAG_HINT` all print `j41-dispatcher …`. Doctor never probes PATH (`pathBinaryVersion` defaults to this package's version). | `src/doctor.js:489,311-316,943,958-962`; `src/cli.js:5534`; `src/indexer-lag.js:4`; README:35-44,81-82 |
| FRC3 | low | F6 residual: Custom Template Builder still persists `network.capabilities`, and `setup --template` still drops them. markup / workspace / session **do** merge. | `src/dashboard.js:1223,1293-1295`; `src/cli.js:737,663,729-774` |

---

### FRC1 — high — the advertised install is still npm 2.37.3 without this branch

**Files:** `package.json:3,64-66`; `scripts/install.sh:4-8,15-16,212-219,272-288`;
`packages/j41-dispatcher-alias/package.json:2,21`; `README.md:33-44`;
release commit `1a340d8` (`2026-09-05`).

**Path.** README Install, in order:

```bash
curl -fsSL https://raw.githubusercontent.com/autobb888/j41-sovagent-dispatcher/main/scripts/install.sh | bash
# or, with Node 20+ already:
npm install -g j41-dispatcher
# or: npm install -g @junction41/dispatcher
```

This tree's `install.sh` does what its header says — user-prefix npm, no
git clone, no `runtime=local` (`install.sh:212-219`):

```bash
PKG="@junction41/dispatcher"
PKG_VER="${J41_DISPATCHER_VERSION:-}"
npm install -g --prefix "$HOME/.local" "$spec"
```

Unscoped `j41-dispatcher@2.37.3` is a thin alias whose only dependency is
`"@junction41/dispatcher": "2.37.3"`.

HEAD `package.json` is still `"version": "2.37.3"`. The **published**
2.37.3 is release `1a340d8` (CHANGELOG 2026-09-05). First-run gates on
this branch landed **2026-09-14**, after that tag:

| Gate | `1a340d8` (npm 2.37.3) | `5ca8776` (this clone) |
|---|---|---|
| Node &lt; 20 `process.exit(1)` | absent | `cli.js:16-20`, `dashboard.js:7-11` |
| ESM `ERR_REQUIRE_ESM` split | absent | `cli.js:165-167` |
| `setup()` 10s `Promise.race` + `✓ Security setup complete` | `cli.js:5166-5170` | gone; branches on `{success}` |
| `quickCheck` timeout fail-closed | `Promise.race` | `cli.js:6245-6291` + `clearTimeout` |
| `probeClock` on `start`, 30s, no `--dev-unsafe` bypass | absent | `cli.js:5763-5778` |
| Dashboard Start = `[Health]` after seek | `setTimeout(2500)` at `dashboard.js:4014` | `tui/start-ready.js` 60s |
| F6 markup/workspace/session merge | absent | `cli.js:729-774` |
| `init -n` 1–100 | absent (`NaN` path) | `cli.js:1689-1694` |

`git diff --stat 1a340d8 HEAD` on those files: `src/cli.js` +1733/−…,
new `src/tui/start-ready.js`, `package.json` version **unchanged**.

**Trigger.** Any of: README `curl | bash`; `npm i -g @junction41/dispatcher`;
`npm i -g j41-dispatcher`; re-running this tree's `install.sh` without
`J41_DISPATCHER_VERSION` pointing at an unpublished tarball.

**Outcome.** The operator who follows the documented door never runs the
gates this pass just verified. They get F4 (lying ✓ then
`SECURITY CHECK FAILED`), F5 (abandoned `setup()` mutates `/etc/j41` after
10s), F9 (TUI Start green after 2.5s while first-run security is still
running), MO5 (Node 18 engines-warning then silent security skip), MO6
(skewed clock → "challenge expired" with no NTP hint). That is the
shortest path to a lying ✓, and on F9 it is specifically a lying
"dispatcher started" while the child may still `exit(1)`.

A GH clone of **this** tree that is then driven with `node src/cli.js …`
does have the gates (see FRC2). The advertised install does not.

**Why a republish of `2.37.3` is not a fix.** npm will refuse to replace
an already-published 2.37.3. HEAD must bump.

**Proposed fix (not applied).**
1. Bump `@junction41/dispatcher` and `j41-dispatcher` alias to **2.38.0**
   (or 2.37.4 if the bar is patch). Publish both.
2. Point README `curl` at a tag, or pin `install.sh`
   `J41_DISPATCHER_VERSION` default to that version.
3. Do not ship `curl | bash` against `main` until `main` **is** this
   branch.

---

### FRC2 — med — clone doctor / README copy-paste `j41-dispatcher` which is not on PATH

**Files:** `src/doctor.js:173,311-316,355-367,489,557-565,688,943,958-962`;
`src/cli.js:5534,4770-4778`; `src/indexer-lag.js:3-4`; `README.md:35-44,76-82`.

**Path.** Clean clone of this repo. `yarn` / `npm i` puts the bin at
`node_modules/.bin/j41-dispatcher`, not on `$PATH`. README never
documents `git clone`; every command it prints is the global bin.

Doctor, which **is** the clone walk's first command (observed:
`node src/cli.js doctor`):

```js
pathBinaryVersion: opts.pathBinaryVersion != null
  ? opts.pathBinaryVersion
  : opts.packageVersion || PKG.version,          // doctor.js:489
```

No `execSync('j41-dispatcher --version')`, no `command -v`. Package check
**passes** (`@junction41/dispatcher 2.37.3`). `formatDoctorTable` header
is the literal string `j41-dispatcher doctor`. After images are missing,
`pickNext` emits:

```
Next:
  j41-dispatcher build-image
```

(`doctor.js:686-689`, observed live). After `node src/cli.js build-image`
succeeds, doctor exit 0, Next is `j41-dispatcher setup agent-1 <name>
--template code-review` (`identityNext` `:314`). Same prefix on
`build-image`'s own "Next: j41-dispatcher start" (`cli.js:5534`) and on
indexer-lag (`indexer-lag.js:4`).

TUI Start from `node src/cli.js dashboard` **does** work: spawn is
`process.execPath` + `process.argv[1]` + `'start'` (`dashboard.js:4137`),
so it re-enters `cli.js` without needing PATH.

**Trigger.** Clone this tree; run doctor the only way that works
(`node src/cli.js doctor` / `npx --no-install`); copy the Next line into
a new shell.

**Outcome.** `command not found: j41-dispatcher`. Not a paid job, not a
lying ✓ — a brick on every copy-paste surface the clone walk produces.
An operator who "fixes" it with README `npm i -g j41-dispatcher` then
hits **FRC1**.

**Proposed fix (not applied).**
1. If `process.argv[1]` is this `src/cli.js` (or `node_modules/.bin` is
   not on PATH), print Next as `node src/cli.js …` / `npx --no-install
   j41-dispatcher …`.
2. Add a doctor check that execs `j41-dispatcher --version` (timeout
   2s). Missing / wrong binary → fail, Next = scoped `npm i -g
   @junction41/dispatcher@<this version>` **or** `export PATH=…/node_modules/.bin:$PATH`.
3. Stop defaulting `pathBinaryVersion` to `packageVersion`.

---

### FRC3 — low — custom-template `network.capabilities` still dropped (F6 residual)

**Files:** `src/dashboard.js:1223,1287-1313`; `src/cli.js:729-774,662-666`.

**Path.** Original F6 (med, 2026-08-10) was markup + `network.capabilities`
+ session + workspace. HEAD merge (`cli.js:729-774`) copies markup,
`workspaceCapability`/`workspace`, session duration/token/message, and
`network.protocols`. Tests pin those (`test/template-merge.test.js`).

The Custom Template Builder still prompts for capabilities and writes
them (`dashboard.js:1223,1293-1295`):

```js
network: {
  capabilities: profileCapabilities.split(',').map(…),
  protocols: profileProtocols,
},
```

`mergeTemplateIntoOptions` has no `tpl.profile.network.capabilities` arm.
`buildFullProfile` then sets `network.capabilities` from
`options.profileCapabilities || []` — empty unless the operator passed
`--profile-capabilities` (JSON array of `{id,name}` objects, a different
shape from the builder's string list).

**Trigger.** TUI "create a custom template", fill Capabilities, `setup
--template <that name>`.

**Outcome.** On-chain `network.capabilities` is `[]`. Not a paid-job
failure. markup / workspace / session from the same template **do** land.

**Proposed fix (not applied).** Copy `tpl.profile.network.capabilities`
into `options.profileCapabilities` (normalise strings → `{id,name}`),
and add a `template-merge.test.js` row so F6 cannot regress a fourth
field.

---

## Prior IDs — still load-bearing vs fixed on HEAD

Do **not** treat first-run / mass-onboarding / onboarding-2-leftovers
DONE as "skip". Re-derived against `5ca8776`:

| ID | Sev then | HEAD | Notes |
|---|---|---|---|
| **F1** | high | **FIXED** | `publishVdxf` throws on 0 UTXOs (`cli.js:1316-1320`). `setup` prints `Setup INCOMPLETE` and exit 1 (`:4924-4937`). Bare `finalize` throws if no profile (`:1216-1229`); loads `profile.json`. |
| **F2** | high | **FIXED** | `usable = apiKey \|\| (keyless && baseUrl)` (`local-llm.js:75`). Preflight fail-closed (`preflight-gate.js`, `llm-health.js:11`). Canned `generateTemplateResponse` only when `!usable` — not on the ollama "no key needed" path. |
| **F3** | high | **FIXED** | `quickstart` writes `[provider_keys]` (`cli.js:1644-1650`); offers `claude-sonnet`; does not invent `export OPENAI_API_KEY`. |
| **F4** | med | **FIXED on HEAD · LIVE on npm 2.37.3** | → **FRC1**. HEAD: `cli.js:6221-6225`. |
| **F5** | med | **FIXED on HEAD · LIVE on npm 2.37.3** | → **FRC1**. No `Promise.race` on `setup()`. |
| **F6** | med | **FIXED for markup/workspace/session · residual capabilities** | → **FRC3**. |
| **F7** | high | **FIXED** | `start` refuses `runtime=local` without `--dev-unsafe` (`cli.js:5698-5708`) **before** accept. Installer no longer writes local. `setup.sh` is a deprecation wrapper. |
| **F8** | low | **FIXED** | Image preflight `cli.js:5725-5734`. README no longer claims "hang mid-registration". |
| **F9** | low | **FIXED on HEAD · LIVE on npm 2.37.3** | → **FRC1**. HEAD: seek + `[Health]` (`dashboard.js:4131-4149`, `tui/start-ready.js`). |
| **F10** | low | **FIXED** | `init -n` `/^\d+$/` 1–100 (`cli.js:1689-1694`). |
| **F11** | low | **FIXED** | `install.sh` npm user-prefix; does not clone into `~/.j41/dispatcher`. |
| **F12** | low | **FIXED** | `persistableRuntime` (`config.js:54-57`). |
| **MO1** | high | **FIXED** | No 404 clone / `vlatest` tarball. |
| **MO2** | high | **FIXED installer half.** Residual: `config --runtime local` still silent (`cli.js:1440-1446`). Start-gate contains it (brick, not paid-job). Not re-opened. |
| **MO5** | med | **FIXED on HEAD · LIVE on npm 2.37.3** | `cli.js:16-20` + `dashboard.js:7-11` + ESM split `cli.js:165-167`. |
| **MO6** | med | **FIXED on HEAD · LIVE on npm 2.37.3** | `probeClock` 8s abort, 30s fail, start refuses, `--dev-unsafe` does not bypass (`cli.js:5763-5778`). |
| **MO4** | med | **FIXED** (not re-litigated) | TUI log is `~/.j41/dispatcher/dispatcher.log`. |
| **O2-1 / O2-2** | med/low | **FIXED** | Canary symlink not start-only; empty dest dir replaced. |

X1 (bounty `startJob` argument swap) is still out of domain.

---

## 12 PR focus items — verdict on HEAD

| Item | Verdict |
|---|---|
| Node 20 gate at `cli.js` umask + `dashboard.js`; ESM require split | **VERIFIED.** `cli.js:14,16-20,161-175`; `dashboard.js:7-11`. |
| doctor Next: missing images → `build-image`; after images, 0 identities → `setup agent-1 --template code-review` | **VERIFIED.** Observed live matches `doctor.js:686-689,748-751,311-316,925`. Identity is warn → doctor exit 0. |
| GH clone: `j41-dispatcher` NOT on PATH; README/doctor still print it | **DRIFT** → **FRC2**. |
| `install.sh` / curl\|bash / `npm i -g` still install npm 2.37.3 WITHOUT this branch | **DRIFT** → **FRC1**. |
| First-run security: no 10s `Promise.race`; `sudo HOME="$HOME" npx @junction41/secure-setup --dispatcher`; quickCheck timeout fail-closed | **VERIFIED** on HEAD (`cli.js:6202-6291`). Live on npm 2.37.3 as F4/F5. |
| Dashboard Start: seek-to-end `[Health]` line, not PID/2.5s | **VERIFIED** on HEAD. Live on npm 2.37.3 as F9. |
| `probeClock` 8s abort, 30s skew fail, `--dev-unsafe` does not bypass | **VERIFIED** (`doctor.js:13,429,441-446`; `cli.js:5763-5778`). |
| `init -n /^\d+$/` 1–100; quickstart runtime `docker\|local` | **VERIFIED**. |
| F6 template merge markup/workspace/session | **VERIFIED.** Capabilities residual → **FRC3**. |
| Do not claim auto-install gVisor without sudo | **VERIFIED.** README:1100-1108. |
| Fresh clone doctor does not create `~/.j41` | **VERIFIED.** Doctor does not call `ensureDirs`. |
| `LoginGraceTime 60` in rebuilt jail image | **VERIFIED.** `Dockerfile.gpu-jail:31`. gpu-jail G5 fixed; not a first-run-clean finding. |

---

## Adversarial pass

Question: shortest path from a brand-new operator following README to a
**paid job they cannot deliver**, or a **lying ✓**.

### 1. Follow README Install (not the clone) — this is the hit

`curl | bash` or `npm i -g @junction41/dispatcher` → published 2.37.3
(`1a340d8`) → **FRC1**.

- First `start`: 10s `Promise.race` on `setup()`, then `✓ Security setup
  complete` regardless of `{success:false}` (F4). Abandoned promise keeps
  installing gVisor / writing `/etc/j41` (F5).
- TUI Start: 2.5s timer resolves `{ok:true}` (F9) while that first-run
  block is still running — **lying "Dispatcher started"**.
- Node 18: engines warning only; `require('@junction41/secure-setup')`
  fails ESM and is swallowed — security gate gone (MO5 / I11).
- Clock skew: signed login dies as "challenge expired" with no NTP copy
  (MO6).

On **this** tree those four are fixed. The operator who does what README
says never runs this tree.

### 2. Clean GH clone of HEAD, copy doctor Next — brick, not a paid job

Observed live, matches source: images missing → Next `j41-dispatcher
build-image` (not on PATH) → **FRC2**. If they then `npm i -g` to "fix
PATH", they fall into (1).

If they keep using `node src/cli.js …`:

- doctor does not mkdir `~/.j41`.
- `build-image` works (argv is this tree).
- doctor exit 0, Next setup — honest warn, not a ✓ for "you have an agent".
- `setup` mints; 0 UTXOs after seed lag → **throws**, `Setup INCOMPLETE`,
  exit 1 (F1 fixed). Retry is `setup` again (state unlinked).
- `start` without images: refuse, nothing accepted (F8).
- `start` `runtime=local`: refuse (F7). TUI cannot pass `--dev-unsafe`.
- `start` skew &gt; 30s: refuse; `--dev-unsafe` does not help (MO6).
- `start` not root, no marker: prints sudo, does **not** print ✓, then
  `quickCheck` fail-closed (network-allowlist / seccomp / `j41-isolated`
  are `fail` in secure-setup 0.3.0 until sudo). No Health line → TUI
  Start reports exit / timeout, not success.
- No LLM: doctor warns after a labour identity exists; `preflightAllowsAccept`
  declines the job (F2). Buyer is not charged for canned filler.

No paid-undeliverable path found **on HEAD** once the operator is
actually executing this tree.

### 3. Lying ✓ on HEAD that was checked and is not a finding

- Doctor exit 0 with 0 identities: identity is **warn**, Next is setup.
  Machine is ready; fleet is not. Honest.
- `build-image` "Next: j41-dispatcher start" with 0 agents: `start`
  then `❌ No agents found`. Honest fail, plus FRC2 PATH.
- `setup` platform-profile non-indexer warning still continues to
  finalize (`planOnboardingAfterProfile` only stops on indexer lag).
  `start` later prints "has a profile but no service — buyers cannot
  hire it" (`cli.js:5801`). Recorded, not reported — no payment.
- Harness `start-security.test.js` "marker absent, not root →
  startupComplete" uses a stub `quickCheck` that **passes**. Production
  `quickCheck` fail-closes. Not a production lie.

### 4. Out of scope for this pass

Buyer/job/LLM input cannot reach `publishVdxf`, doctor Next, or the
npm version pin. Isolation/keys/money internals except where they are
the first-run gate (F2 preflight, F7 local refuse, F8 image refuse).

---

## Checked and found clean (HEAD)

- `process.umask(0o077)` before any write.
- Doctor Next ordering: docker fail &gt; image fail &gt; identity warn.
- Doctor does not recommend local runtime.
- Installer checksum-pinned Node 22.19.0; missing Docker is exit 1.
- `setup.sh` no longer persists `runtime=local`.
- First-run `setup()` only as root+TTY; sudo line uses `HOME="$HOME"`.
- `quickCheck` timeout is fail-closed; leftover timer cleared.
- Health line is after security gates; TUI seeks before spawn.
- `probeClock` 8s / 30s; start refuse; `--dev-unsafe` does not bypass.
- `init -n` 1–100; quickstart `persistableRuntime`.
- F1 throw; F2 `usable`; F3 key persisted to `config.toml`.
- Jail Dockerfile `LoginGraceTime 60` (G5).
- README First-Run Security no longer claims auto gVisor.

---

## Deliberately NOT covered, and why

- **Publishing 2.38.0 / alias bump.** Finding FRC1 is that it has not
  happened; this pass does not do it.
- **Whether `api.junction41.io` actually seeds 0.0033 VRSCTEST.**
  Claim I2 UNVERIFIED. Dispatcher no longer blocks register on a faucet.
- **`recover` full body, 26-field interactive onboarding, Cat-2
  `api-setup`.** Not the stock labour clone walk.
- **Windows `install.ps1` ACL / ExecutionPolicy.** Not this clone walk.
- **Re-opening isolation I11** beyond the ESM split already verified:
  `MODULE_NOT_FOUND` still skips the security gate (optionalDependency).
  Same as 2026-08-10; not new.
- **Running doctor / start / setup / docker build.** Read-only.
  Observed-live doctor Next / no `~/.j41` / LoginGraceTime 60 are
  cited where source matches; not re-executed here.
- **Appending `AUDIT/state.md`.** Procedure forbids it.

---

## Shape of the domain

On **this clone**, the first-run path finally does the thing the 2026-08-10
pass asked for: it detects the problem and **does not** report success.
F1 throws. F4 branches. F5 does not race. F7/F8/MO6 refuse to boot. F9
waits for `[Health]`. Doctor Next for a clone with Docker and no images
is `build-image`; after images, `setup agent-1 --template code-review`.

The remaining launch bug is the **door**. README, `install.sh`, and the
unscoped alias still hand the operator **published 2.37.3**, whose
`cli.js` still contains the 10s `Promise.race` and the 2.5s Start lie.
HEAD's version was not bumped, so even "just publish this" is blocked.
The clone walk that *does* contain the gates then prints a binary that
is not on PATH (FRC2), and the README-shaped fix for that PATH error
is FRC1 again.
