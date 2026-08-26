# CLI/TUI new-user robustness audit — findings

**STATUS 2026-08-25: all 11 blockers (B1–B11) fixed, code-reviewed, and the
full suite is genuinely green — 1515/1515, twice in a row.** See `git diff`
on `src/cli.js`, `src/dashboard.js`, `README.md`, `CLAUDE.md`. Regression
coverage: `test/audit-2026-08-25-fixes.test.js` (20 tests, all passing).

**The 3 "pre-existing" failures reported earlier were not left as-is —**
they were properly fixed once the user pushed back on leaving them
unaddressed:
- Two, in `test/onboarding-path.test.js`, depended on `moneyScreen(inquirer,
  title, cliArgs, footer)` — a dead function (defined, never called; the
  actual money screens are `walletScreen`/`refundsScreen`/`depositsScreen`,
  rewritten as fuller interactive screens at some earlier commit, orphaning
  `moneyScreen`). Deleted the dead function and rewrote both tests to assert
  the same properties (shells out via the CLI; the unconditional entry call
  in each real screen is read-only) against the code that actually runs.
- Two, in `test/friend-boot-docs.test.js`, anchored on TUI text
  ("Do these in order before start", "Skipped. Next is still rental-setup,
  not start", `message: 'Run rental-setup now?'`) that no longer exists
  anywhere in `dashboard.js` — stale from an even earlier compute-signup
  wizard redesign, unrelated to this session's changes (confirmed via `git
  stash` against the pre-session baseline: already failing before any of
  this work). Rewrote both against the current wizard chain
  (`computeProviderScreen` → `rentalSetupScreen`), preserving the original
  intent: a compute listing can't be signed up straight into `start`, and
  declining the provider-write step says so and stops rather than silently
  proceeding.

A 4th test, in `sign-channel-precreate.test.js`, is a known
full-suite-CPU-contention flake (passes in isolation, unrelated to any file
touched here) — not a fix target, that one's a timing property of the full
suite, not a defect.

**Code review (`/code-review`) found 4 issues in the fix, all corrected:**
1. The B1 fix's `finalize` fallback-to-saved-profile branch took
   `services = saved.services` unconditionally, so `finalize <id>
   --service-name X --service-price 5` silently dropped those flags whenever
   `profile.json` already existed (the normal post-`register` case) — a real
   regression the fix itself introduced. Fixed: flags now win when given.
2. The B3 fix duplicated the ~24-line resolve-to-i-address block between
   `add` and `remove`. Extracted into a shared `resolveAllowlistIdentity()`
   helper so a future fix to one applies to both.
3. The new `agents/<id>/profile.json` file wasn't added to CLAUDE.md's Data
   Directories inventory. Added.
4. `refunds reject`'s new recap printed `entry.refundAmount` with no
   fallback (would show "undefined" before a destructive confirm if a ledger
   entry were malformed) — inherited from copying the `approve` recap's
   pattern, but the safer `refundsList` convention (`?? '?'`) exists
   elsewhere in the same file. Fixed to use it.

Fixing #2 required updating one pre-existing test
(`test/invite-accept-gate.test.js`) whose source-slice window no longer
covered the resolution logic once it moved into the shared helper.

The "Confusing / should fix" and single-agent auto-fill items below are
**not yet fixed** — the owner scoped this pass to the 11 blockers only.

**Date:** 2026-08-25
**Trigger:** pre-launch request to audit every CLI/TUI section for missing
auto-fill and first-timer intuitiveness. `main` @ `7e12d47`, dispatcher
`2.34.0`.
**Method:** seven parallel agents, each reading full command handlers (not
grepping) across `src/cli.js` (13,246 lines, 37 top-level commands) and
`src/dashboard.js` (3,912-line TUI). Grouped: onboarding/identity, fleet
lifecycle, compute/GPU-rental, `start`, key-management/status, money/dispute,
TUI menu tree.

Two things to hold in mind reading this: (1) money commands (`wallet`,
`refunds`, `deposits`, `post-bounty`) got a real hardening pass at some point —
`requireInteractiveConfirm`, `untrusted()` sanitization, mainnet retype-gates
are all present and good. The findings below are mostly the *gaps* in that
otherwise-solid pattern, or places it never reached. (2) `allowlist`,
`sales-mode`, and the compute/GPU-rental commands are new in the last two
weeks and were effectively unaudited before this pass.

---

## BLOCKERS — fix before letting a stranger in

### B1 — `register` → `finalize` silently publishes an empty profile
`register <agent-id> <name>` collects a full profile (services, pricing,
model) via `interactiveProfileSetup` (cli.js:673) or headless flags, but never
persists it to `agents/<id>/profile.json` — it's used once for the initial
broadcast and discarded (cli.js:1646-1650). The README's own documented next
step, bare `finalize <agent-id>` with no flags, then runs with `profile ===
undefined`. The SDK's `buildAgentContentMultimap` returns `{}` when `profile`
is falsy (`sovagent-sdk/src/onboarding/vdxf.ts:344`), so **no on-chain fields
are written at all** — yet `finalize` still prints `✅ Identity updated
on-chain: <txid>` and `✅ Finalize stage: ready` (cli.js:1183), spending a real
tx fee to publish nothing. A stranger following the README literally ends up
with an agent that *looks* finalized and has no on-chain profile.
Fix shape: persist the profile `register` already collected (the dashboard's
"Edit Profile" flow already knows how, cli.js:11456-11469); `finalize` should
load it, or refuse/warn loudly rather than report success when there's none.

### B2 — GPU rental defaults to free, and the guided wizard never asks
`rental-setup <agent-id> --price <vrsc>` **defaults `--price` to `'0'`**
(cli.js:3536). The dashboard's own guided wizard for this exact flow
(`computeProviderScreen` → `rentalSetupScreen`, dashboard.js:1338-1347,
2144-2172) never collects or forwards a price at all. Neither does the
README's "Friend boot" recipe (README.md:839). A first-timer following either
the official TUI wizard or the README verbatim ends up with a live,
on-chain-registered GPU rental listing priced at 0 VRSC, and nothing anywhere
warns them. On success the command also never echoes back the price it
registered, so even someone who *did* pass `--price` gets no confirmation.

### B3 — `allowlist remove` silently leaves the buyer allowlisted
`allowlist <id> add <name>` writes **two** separate entries when a name
resolves — the raw pasted name string *and* the resolved i-address
(cli.js:2516, 2534). `remove` matches by exact string equality only
(`identitiesEqual`, no name↔i-address resolution) — so `allowlist <id> remove
bob.agentplatform@` strips the name entry, prints "✅ Removed
bob.agentplatform@ from allowlist," and **leaves the i-address entry live**.
The buyer can still auto-accept. This is a security control silently not
doing what its own success message claims.

### B4 — `decrypt-keys`: no confirm before permanent plaintext, crashes headless
The single most consequential of the three key commands (permanently writes
every agent's WIF back to plaintext on disk) has **no "are you sure"** gate at
all — just the correct passphrase. It's also the one key command with no
upfront TTY guard (`encrypt-keys` and `change-passphrase` both have one): run
non-interactively with no `J41_KEYS_PASSPHRASE` set, `resolvePassphrase`
throws `ENOPASS` inside an un-`try/catch`'d async handler with no
`unhandledRejection` handler in scope (that handler is only registered inside
`start`'s closure) → raw Node stack trace instead of a clean error.

### B5 — `respond-dispute` and `refunds reject` fire with zero confirmation
Every other fund/buyer-affecting decision in the money-command surface
(`post-bounty`, `wallet send/sweep`, `refunds approve/unblock`, `deposits
credit/dismiss`) prints a full recap and requires an explicit y/N.
`respond-dispute <jobId>` (cli.js:11176-11181) and `refunds reject
<job-id>` (cli.js:12966-12969) both call straight through to the SDK/backend
with **no recap, no confirmation**. `respond-dispute`'s `--refund-percent`
also has no client-side bounds check — a typo (`100` vs `10`) goes straight to
chain. This reads as the hardening pass simply not having reached these two
commands, not a new bug class.

### B6 — TUI `jobsScreen` called with a missing argument, breaks dispute response
`agentDetailScreen` calls `jobsScreen(inquirer, secretKeys)` — two arguments —
but `jobsScreen`'s signature is `jobsScreen(inquirer, keys, agentId)`
(dashboard.js:467 vs. 818). `agentId` is `undefined` for the rest of that
screen's life. The two downstream actions reachable from it — "Accept stacked
job" and "**Respond to a dispute**" — both run with an undefined agent-id.
This is the only path in the TUI to handle a live dispute/refund from the Jobs
view, and it's broken.

### B7 — TUI API-endpoint registration confirms `default: true`
`apiEndpointSetupScreen`'s final "Apply this configuration?" confirm defaults
to `true` (dashboard.js:3505) before calling `agent.registerService(...)` — a
real on-chain write that publicly lists a paid API endpoint. This directly
violates the file's own documented convention (dashboard.js:194-199: "any
confirm that commits money or an on-chain write MUST use `default: false`"),
and is inconsistent with sibling confirms in the same file that correctly use
`default: false` (lines 2662, 2701). A bare Enter at the end of the wizard
silently publishes a paid service.

### B8 — TUI dispute-response screen has no confirm at all
`respondDisputeScreen` (dashboard.js:2331-2360) calls `runDispatcherCli(args)`
directly with no confirm step whatsoever, compounding B5/B6 on the CLI side —
there is no checkpoint anywhere in the stack for this action.

### B9 — `start` after `init` (skipping register/finalize) gives the wrong fix-it instruction
`listRegisteredAgents()` only checks that `keys.json` exists, not that the
agent was ever registered on-chain. A newcomer who runs `init` then jumps to
`start` (nothing in `start --help` says `register`/`finalize` are
prerequisites) hits every agent being skipped as "not registered" with no
fix-it command attached (cli.js:4046-4050, unlike the parallel "inactive"
branch which does append one at 4130-4131). The aggregate error then fires the
wrong branch — since `keys.json` exists for all agents, it says "N registered,
none active" and tells the user to run `activate-all`, which does nothing
useful because there's no on-chain identity yet. The correct instruction
(`register <agent-id> <name>`) is never shown.

### B10 — `start` crashes raw on a private-LAN LLM endpoint
`validateExecutorUrl` runs un-wrapped in `start`'s action body, before the
`unhandledRejection` handler is registered 1,000 lines later (cli.js:5002). It
`throw`s on any non-HTTPS/non-localhost host — exactly what a self-hosted LAN
LLM (Ollama/vLLM on `192.168.x.x`) looks like. Result: an unhandled rejection
crash with a raw stack trace for a legitimate, privacy-conscious setup.

### B11 — `setup`/`quickstart`/`register`/`finalize --interactive` hang with no TTY
Four separate interactive-prompt paths — `setup`'s walkthrough (triggered
whenever `--profile-name` is missing, **not** gated on an `--interactive`
flag, cli.js:3273-3283), `quickstart` (cli.js:1356-1360), `register`'s
`interactiveProfileSetup` (cli.js:673), and `finalize --interactive`'s
SDK-side `defaultPrompt` — all use raw `readline`/prompt calls with **no TTY
guard**, unlike `requireInteractiveConfirm` (cli.js:12739) which the money
commands use everywhere. Run any of these headlessly (CI, `docker run`
without `-it`, piped stdin) and the process hangs indefinitely with no error,
no timeout, no exit code. These are also the exact three prompts a first-timer
following the README is most likely to hit first.

---

## Confusing / should fix (not launch-blocking, but real friction)

- **Single-agent auto-fill, everywhere.** `deactivate`, `activate`,
  `allowlist`, `sales-mode`, `accept-job`, `update-profile`, `inspect`,
  `api-setup`, `rental-setup`, `respond-dispute`, `post-bounty`, `my-bounties`,
  `wallet show`/`sweep`, `deposits credit`/`dismiss`, and ~8 TUI agent-picker
  screens all force typing/selecting an agent-id even when exactly one agent
  is registered — the overwhelmingly common case for a brand-new user's first
  session. `list-bounties` already auto-selects the sole registered agent for
  read access — the inconsistency is within the same file. This is the
  single highest-frequency pattern in the whole audit.
- **"Agent not found" never lists the valid ids**, even though every command
  hitting this error has already loaded the agent-directory listing.
- `activate-all`/`deactivate-all` have **no confirmation at all**, while
  single-agent `deactivate` requires a typed y/N + preview box — the
  fleet-wide, more destructive action is less guarded than the single-agent
  one.
- `sales-mode open/invite` ("the floodgate" per its own description) and
  `update-profile` broadcast on-chain writes with no confirmation.
- `sales-mode`/`update-profile` both have an unguarded "don't run while a
  write is unconfirmed" hazard documented only in a code comment — the
  dispatcher's own control API already exposes `pendingWrites` and isn't
  queried before either command fires.
- `change-passphrase` force-retypes the *current* passphrase even though
  `decrypt-keys` one command above it already knows how to resolve it from
  `J41_KEYS_PASSPHRASE`/systemd credential.
- `api-setup`: model list must be hand-typed (`name:in:out`) even though the
  dashboard already knows how to auto-discover via `/v1/models`; `--rpm`/
  `--tpm` use `parseInt` with no `NaN` check, silently writing/registering
  bad data.
- Inconsistent `--json` support: `config`, `status`, `logs`, `privacy`,
  `set-authorities`, `check-authorities`, `allowlist`, `sales-mode` have none;
  siblings (`wallet`, `refunds`, `deposits`, `ctl status`, `inspect`,
  `list-bounties`) do.
- `logs --agent <id>` is a **dead flag** — declared but never read in the
  handler.
- `status` on zero agents gives no pointer to `register`/`setup`/`finalize` —
  exactly the moment a stranger most needs the next step named.
- TUI empty-agent-list screen tells the user to click "Add New Agent" — that
  label doesn't exist in the current menu (renamed to "Sign up — register a
  listing").
- TUI Refunds/Deposits/Respond-dispute require retyping a job-id/txid by hand
  from a list just printed above, instead of picking from it — a
  transcription slip feeds directly into a money action.
- `ctl shutdown` has no confirmation, despite the fleet not auto-reactivating
  on restart (a first-timer trying to "restart cleanly" silently takes the
  whole fleet offline until they remember `activate-all`).
- `start` never checks LLM-provider reachability at boot — the banner says
  "fleet is live" even with a bad API key; the only check is lazy, per-job,
  buried in scrolling logs, indistinguishable from "no demand yet" for
  potentially days.
- `start` never prints which network it's running on (mainnet vs testnet)
  despite already knowing (`IS_MAINNET`), even though it gates a security
  check on the same value a few lines earlier.
- `accept-job` never shows the fetched job (buyer, price, description) before
  signing the accept — no chance to review what's being agreed to.
- `build-image`: `build-jail-image.sh` has no docker-installed check while
  `build-image.sh` does — inconsistent error quality for the identical
  failure mode.

## Working well (verified, not just assumed)

- Money-command hardening (`wallet`, `refunds` approve/unblock, `deposits`,
  `post-bounty`) is genuinely solid: TTY guards, full recap screens,
  `untrusted()`-sanitized buyer text, mainnet retype-the-amount gates, no bare
  `default:true` confirms.
- TUI money-surface parity is fixed — Wallet/Refunds/Deposits are all present
  on the main menu with live attention counters (a previous audit found zero
  money actions in the TUI).
- The previously-flagged ~460-line dead `mainMenu` is gone.
- `recover`, `providers`, `inspect` are clean — no missing-autofill or
  confirmation issues found.
- `rental-setup`'s docker/nvidia/disk-quota/jail-image preflight
  (`assertHomeGpuHostReady`) is thorough and fails closed with actionable
  error codes — the one part of the compute flow that's well done.
- `start`'s "silence after boot" problem from a prior audit is fixed — it now
  prints the agent list, an `inspect` pointer, `ctl status`/`ctl earnings`
  pointers, and sets the expectation that quiet is normal.

---

## Suggested sequencing

B1–B11 are all independent single-command fixes (no shared refactor needed).
B1, B2, B3 are the three that produce a *wrong on-chain/public state while
reporting success* — highest priority. B4–B8 are missing-confirmation gaps
against an established pattern already used correctly elsewhere in the same
files, so each fix is small and has a template to copy. B9–B11 are onboarding
error-message/TTY-guard fixes, same shape as B4.

The "confusing" list's single-agent auto-fill item touches the largest number
of call sites (~20+) but each is a small, uniform change (`resolveAgentId`
helper: use the sole registered agent if exactly one exists, else require the
flag) — worth doing as one pass across both files rather than piecemeal.
