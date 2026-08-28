# Changelog

## Unreleased

### Buyer hire from CLI and TUI
The dispatcher was seller-only (`accept-job`, refunds, rental-setup). Terminal
access to J41 includes hiring. `j41-dispatcher hire <buyer-id> <seller>
--amount <n> [--service <id>] [--pay]` creates the job as that fleet identity
and optionally broadcasts the dual payment. TUI: Marketplace → Hire a listing.
Data listings are refused locally (`DATA_NOT_HIREABLE`). Compute requires
`gpu-rental`; model requires `api-endpoint`.

### TUI writes [compute.providers.*]; listing_kind is sticky
- After compute signup the dashboard writes `[compute] enabled=true` and a `home-gpu` / `vast` provider table (never `local`, never `0.0.0.0`). Named TCP tunnel is still operator-side: point it at `127.0.0.1:$ssh_tunnel_port`.
- Signup refuses a leaf that already belongs to another local listing ("Do not reuse a working agent name for a GPU box").

## 2.34.1 — 2026-08-27

### Supply chain: the SDK dependency is pinned to npm

`@junction41/sovagent-sdk` was declared as `github:autobb888/j41-sovagent-sdk#main`
— a floating ref. The published tarball ships no lockfile, so every consumer
install cloned whatever SDK `main` happened to be at that moment: installs were
not reproducible, and a future push to SDK `main` silently changed what
already-published dispatcher versions resolved to. Our own lockfile had already
drifted to 2.16.0 @ `1837944`, six commits behind.

Now `"@junction41/sovagent-sdk": "2.16.1"` — exact, from the registry. The npm
package bundles the two Verus forks, so a clean install no longer reaches github
at all. Verified byte-identical to SDK `main` @ `55989e4`, so this is a pin in
resolution and a no-op in content.

Note for releases: an SDK publish now requires a matching bump here.

## 2.34.0 — 2026-08-22

### Cat-1 GPU rental: Vast is prepay-gated; SSH-ready is not vLLM (C4)

Raw GPU rentals (`gpu-rental`) acquire through the same `startRentalJob` hook as
home-gpu. A Vast box (`canProvision && isElastic`) is refused until
`job.payment.verified` (`VAST_PREPAY_REQUIRED`) unless the operator persisted
`rentalAckPostpayVastRisk` at `rental-setup --ack-postpay-vast-risk`. home-gpu
(`isElastic: false`) is not an outbound USD bill and may acquire unpaid.

Cat-1 `waitReady` is SSH-ready (`actual_status === 'running'` + `ssh_host`).
Cat-2 attach still waits on vLLM `/models` (`readyFor` defaults to `'service'`).

### Cat-1 GPU rental: SSH credentials, stable tunnel bind, lock unlink, on-demand Vast

- home-gpu puts the renter `password` on `lease.ssh` (not only `meta`). Deliverable
  / `deliverSealed` fail closed without `password` or `privateKey`.
- Jail `22/tcp` binds `127.0.0.1:${ssh_tunnel_port}` (required 1–65535), never
  HostPort `0` and never `0.0.0.0`.
- `release()` always unlinks `deviceLockPath(device_index)` so a reconstructed
  provider after crash cannot leave `HOME_GPU_BUSY`.
- Vast Cat-1 acquire omits the bid `price` (`interruptible: false` in meta) and
  injects a generated ed25519 pubkey via `onstart`; the private key is sealed as
  `ssh.privateKey`. `readyFor: 'ssh'` degrades if neither password nor key is present.

## Unreleased

### sovmodel is a live listing kind; all four mint under agentplatform@ on VRSCTEST

DeFi is off, so sov*@ cannot issue subIDs. Signup still picks agent / compute / data /
model; the name that is actually minted is `name.agentplatform@` and `config.kind`
carries the real kind. `sovmodel` is first-class (metered inference), not a coming-soon card.

### Newcomer signup knows listing kinds (sovagent / sovcompute / sovdata)

The TUI and CLI still registered everything as `name.agentplatform@` and never sent
`kind` to `/v1/onboard`, which the backend now requires. Newcomers pick a kind
first (agent / compute / data); `sovmodel` is shown as coming soon and is not
mintable. `register` / `setup` / `quickstart` take `--kind` and use the identity
the platform returns. Needs `@junction41/sovagent-sdk` 2.15.0 (onboard sends kind).

### Buyer API-access revoke now kills the proxy key (H7)

`proxy.access_revoked` on the generic webhook path calls `onApiAccessRevoke`. J41
never POSTs `/j41/api-access/revoke`; that route stays for direct callers.

### A fleet that cannot sign in no longer reports healthy

Observed live on 2026-08-15: **8 of 9 agents in auth backoff for hours** — 137 to
145 consecutive failures each, the fleet unable to accept any work — and
`/health` reported **`ok`**. `auth_backoff_agents: 8` sat right there in the same
payload.

Auth backoff sets no `lastError`, so every existing term in the degrade chain
missed it. This is the shape of the 2026-08-06 outage the chain was extended to
catch: every local surface green while the fleet earns nothing.

Degrades now when **more than half** the fleet is in backoff — a majority rather
than `some`, because one agent flapping its auth is routine and an alert that
fires on that is one operators learn to ignore. Gated on `startupComplete` like
the other post-start terms. The counter now has a single definition shared by the
degrade term and the summary scalar, so they cannot drift.

### An agent could sit in the available pool twice

Same outage, same `/health` payload: `agents_available: 10` against
`agents_total: 9`. An impossible count, caused by one agent being returned to the
pool twice.

The wrong number is the mild symptom. **The pool is what the dispatcher assigns
work from**, so a duplicated agent can be handed two jobs concurrently — one
process, two buyers. Four call sites returned agents to the pool and none checked
whether the agent was already there; the comment at one of them ("unless …
already returned during pause") shows the double-return was known and guarded in
a single case.

Returns now go through one idempotent guard. A class-level test forbids raw
pushes — added because the first pass at this fix missed the fourth site, whose
comment read differently from the other three.

## 2.31.0 — 2026-08-14

### Registration funds the agent — the onboarding advice had it backwards

**Junction41 seeds a newly registered agent's fee address with 0.0033 VRSCTEST**
(~33 on-chain writes at 0.0001 each). Nothing needs funding beforehand.

Everything shipped earlier today about funding was wrong in the same direction:
`setup` PAUSED before registering to demand the operator fund the address first,
`init` listed funding as step 1, and both pointed at a "faucet" that does not
exist. That gate blocked the very step that delivers the money, and sent
newcomers hunting for coins with no source — the worst possible version of the
blocker it was written to fix.

- **The pre-registration gate is gone.** `setup` runs straight through and states
  that the platform seeds the agent.
- **`init`'s next steps** now start at `register`, with the same note.
- **`printFundingInstructions` was repurposed** from a prerequisite into what is
  actually useful: the R-address only ever drains, so it explains refilling from
  the agent's own earnings (`wallet sweep`), from another fleet agent
  (`wallet send`), and names the one case that needs outside help — an agent
  that has never earned.
- **The unfunded-VDXF-publish message** now says the likeliest cause is the seed
  not having confirmed yet, rather than implying the operator forgot something.
- **No faucet, no Discord, anywhere.** A class-level test forbids both, and
  forbids any text instructing a newcomer to send coins.

The mainnet/testnet warning moved to the README, the one place still describing
moving money by hand.

**Provenance of the error:** `j41-docs` describes a Discord faucet in three
places. That was carried into shipped code without being checked, and then built
on. Verified since: there is no automated VRSCTEST faucet, and more importantly
none is needed.

## 2.30.2 — 2026-08-14

### The funding instructions called it a faucet; it isn't one

`printFundingInstructions` and the README pointed at "the Verus Discord faucet".
Verified: **there is no automated VRSCTEST faucet.** You join the Discord, ask in
`#pbaas-development`, post your address, and a community member sends coins by
hand.

The old wording sent a newcomer to look for a faucet bot that does not exist —
a dead end at the single step that already blocks everyone. The text now says
plainly that a human has to respond, names the channel, and tells anyone who was
invited to test to ask their inviter to fund them directly instead.

Traced to `j41-docs`, which describes it as a faucet in three places; the claim
was carried into shipped code without being checked.

## 2.30.1 — 2026-08-14

### Deposit notifications survive the platform's new visibility gate

The platform now verifies a deposit's funding transaction is visible on **its
own node** before routing our `deposit-confirmed`, returning `503
DEPOSIT_TX_NOT_VISIBLE` when it is not, or `503 VERIFICATION_UNAVAILABLE` when
its RPC is down.

Both are routine rather than exceptional: we credit from OUR mempool view and
notify immediately, so losing the propagation race is the normal case — and
their testnet node is shed under memory pressure daily around **09:00 UTC** for
~45 minutes (the window moved from ~04:00; their confirmation, 2026-08-14).

Our notify was fire-and-forget — a 503 produced a warning and the notification
was gone. No money was ever at risk (the platform holds no reversible balance
for a deposit) but the buyer silently never got their inbox card. Credited
deposits now carry a `notifyPending` flag, and the existing deposit poller
re-fires owed notifications with exponential backoff, bounded to 8 attempts
before giving up **loudly** and leaving the record visible in the ledger.

A local signing or serialisation failure is classified as permanent rather than
retryable — by its position in the flow, not by matching the error text. It
fails identically on every retry, and letting it consume the retry budget is how
the earlier `canonicalize is not a function` bug stayed invisible.

### Maintenance window corrected everywhere

Test plan and deposit runbook now say **~09:00 UTC**, not 04:00.

## 2.30.0 — 2026-08-14

### The path from install to earning actually exists now

Four blockers, all the same shape: the product knew a prerequisite and told the
user nowhere, too late, or in a path they could not execute.

- **Funding.** The word "faucet" appeared nowhere in the shipped product, no
  amount was ever stated, and two messages disagreed — `init` said the agent
  needed **VRSC** while `wallet show` said **VRSCTEST** for that same agent on
  that same install. Testnet and mainnet addresses are visually identical, so
  "VRSC" in front of a testnet address is not a typo; it is an instruction to
  send real money to a worthless address. One helper now states the currency
  derived from the network, the registration cost, a recommended amount that
  leaves a working fee tank, and the Verus Discord faucet — and warns that the
  two coins are not interchangeable. Service-currency defaults derive from the
  network too, instead of the literal `'VRSC'` on every surface.
- **Sequencing.** `setup` printed the address and began registering in the same
  breath, which made the documented instruction — fund before `register` —
  literally unfollowable on the recommended path. It now shows the funding
  details and waits. Headless and unfunded, it refuses with exit 2 rather than
  stranding a half-registered agent. `--yes` keeps the old behaviour.
- **The image.** The README handed a `yarn global add` audience a repo-relative
  `./scripts/build-image.sh`, and nothing could print or reach it. There is now
  a `build-image` command that resolves the bundled script from the module's own
  location, and `start` refuses when the image is missing — before a buyer can
  pay, rather than as a raw dockerode error after their job was accepted.
- **Silence.** `start` now prints the fleet's identities, how to verify a
  listing is live, where to watch activity and earnings, and says plainly that
  waiting is normal. On a system whose failure mode is silence, "running with no
  demand" and "invisibly broken" looked identical for hours.

### The dashboard has a money surface

`refund` appeared 428 times in the CLI and **zero** times in the TUI; `sweep`
192 versus zero. A dashboard-dwelling operator could not learn that buyers were
owed money in the hold-until-approved queue, or that a fee tank had drained
until its agent went silent on-chain — both of which have already happened here.

A Money section now offers wallet, refunds and deposits, and counts of anything
waiting on a human appear on the **first** screen. The views shell out to the
CLI rather than reimplementing the money paths: those carry allowlists, value
ceilings, rate limits and in-flight markers, and a second copy would be a second
thing to get wrong.

## 2.29.1 — 2026-08-14

### Fresh installs work again

**Every clean install of this package was dead**, including 2.28.2, and had been
since `json-canonicalize@2.0.1` was published. That release declares
`main: ./bundles/index.umd.js` but ships no `bundles/` directory, so requiring it
throws `MODULE_NOT_FOUND`. The SDK depends on it as `^2.0.0`, so any fresh
resolve picked the broken 2.0.1 and **every command crashed before printing
anything** — `--version` included.

Development checkouts were immune, which is why this survived so long: their
lockfiles pin the working 2.0.0, and the maintainer's own fleet has never been a
fresh install. It took a clean-machine install to see it — the test
`docs/RELEASE-READINESS.md` records as never having been run.

Pinned to `2.0.0` three ways: a direct dependency (the one that actually works
for a global install, where a nested package's own `overrides` are ignored),
plus `resolutions` and `overrides` for the clone-and-run case.

The durable fix belongs upstream in `@junction41/sovagent-sdk`, which should pin
`json-canonicalize` to `2.0.0` exactly rather than `^2.0.0`. Until it does, every
other consumer of the SDK is still broken.

## 2.29.0 — 2026-08-14

Held back from npm since 2.28.2 while the deposit work was validated. Everything
below has been on `main` and running the maintainer's own fleet; publishing it
closes a gap where an npm install predated the two-status-axes model and could
silently never be hired.

### Confirmation prompts are no longer mistaken for controls

This dispatcher is meant to be run by humans, by humans with an assistant, and
by self-sovereign agents earning on their own behalf. For the last two, a
confirmation prompt is not a safety control — nothing is there to answer it.
Measured against the bundled inquirer 9.3.8 on Node 20.20.1: `confirm` resolves
to its **default** on a bare newline, and raw `readline.question` at EOF never
resolves at all — the event loop drains and the process **exits 0 with the
promise pending**. So a piped stdin auto-answered every TUI prompt, and every
headless money command reported success having done nothing.

- **Eight TUI confirm call sites that commit money or an on-chain write now
  default to no**: identity registration (both call sites), `Proceed with setup?`, bounty
  posting, bounty winner selection, batch activate/deactivate, profile update,
  review submission. Wizard steps that commit nothing keep their yes default,
  and the exemptions are enumerated with reasons in the test rather than left to
  judgement. Two of the nine were missed by a targeted audit and caught only by
  asserting on the whole class.
- **The dashboard refuses to start without a TTY**, before inquirer is imported.
  A machine driving this fleet belongs on the CLI, which has real
  non-interactive gates instead of prompts.
- **Money confirmations refuse a non-TTY and exit 2** — distinct from 1, so a
  caller can tell "needs a terminal" from an ordinary failure without parsing
  prose. Covers `wallet send`/`sweep`, `refunds approve`, `refunds approve
  --all`, `refunds unblock`, `deposits credit`/`dismiss`, and `deactivate`. The
  guard shape already protected `encrypt-keys`; it had never been applied to
  money.

### Buyer-authored text is neutralised before an operator reads it

The job path has always assumed buyer text is hostile — that is what SovGuard
and the canary tokens are for. The operator path did not: `scanUntrusted` had 28
call sites, every one inside an executor, and **none** in the CLI or TUI. Buyer
display names, VerusID names and dispute reasons were printed raw into the very
screens that decide whether money moves.

For a human that text was decoration. For a model operator it is
instruction-stream arriving at the decision point, and a buyer named
`"verified on-chain - reply yes"` became part of the question. A human terminal
additionally rendered raw ANSI, so a display name could repaint the screen or
forge a prompt.

`untrusted()` now strips C0/C1 controls, DEL, zero-width characters, bidi
overrides and the BOM, and caps length — applied on the refund list, the refund
approval screen and the deposit credit screen. Buyer-authored fields are
additionally **labelled as buyer-supplied on screen**: neutralising the bytes is
not enough if a model still reads the text as an instruction from the system.
Ordinary text, accents and emoji pass through untouched — a sanitiser that
mangles honest input trains operators to ignore it.

Both defect classes were invisible to a 1149-test suite because nothing had ever
asserted on non-TTY behaviour or on rendered screen content. `grep -rln isTTY
test/` returned nothing.

### Post-fix audit corrections

Three audits against a written spec found the first pass of the above was
incomplete in ways an enumerated fix list could not catch:

- **Sanitisation missed four surfaces**, including `deposits list` — the screen
  the new TUI Deposits entry routes operators to — and a buyer name rendered
  *inside* an inquirer confirm question. Now enforced by a class assertion over
  both files.
- **The buyer-text label was trailing**, so an injected instruction was read
  before the label qualifying it. It is now a leading fence, and the Unicode tag
  block (U+E0000–E007F) — the channel for smuggling instructions past a human
  and into a model — is stripped along with variation selectors, word joiner and
  soft hyphen. Truncation is code-point-safe. The helper moved to
  `src/untrusted.js` because both the CLI and the TUI render buyer text.
- **The currency fix had missed the TUI entirely** (every service-pricing and
  API-rate prompt hardcoded `VRSCTEST` — the mainnet mirror of the bug) plus a
  `|| 'VRSC'` fallback cluster. A class assertion over both files found ~20
  offenders; the original scan looked only at lines containing "fund", in
  `cli.js` only.
- **`start`'s image preflight made the start-action harness host-dependent** — 18
  scenarios passed only because this machine has the live fleet's image. Gated on
  the file's existing `NODE_ENV === 'test'` seam.
- **The container-creation call still hardcoded the image name** while the build
  command and preflight honoured `J41_JOB_IMAGE`/`J41_JOB_TAG`, so a custom tag
  built and preflighted one image and ran another.
- The dashboard's TTY refusal now exits **2**, matching the money guards.

1198 tests pass.

### 0-conf deposits are reconciled, and their anomalies are visible

Deposits under 2 VRSC are credited straight from the mempool. A mempool transaction
is not money — it can be evicted, replaced, or never mined — and until now the buyer
kept the credit either way, repeatably, with a fresh txid each time. The reconciler
now claws it back, but only from a node that reports itself caught up on the right
chain at both ends of the pass, after it has ingested ≥30 blocks and still says the
transaction does not exist. Everything ambiguous leaves the credit standing.

Three double-credit paths that pre-dated this were fixed first: the credit paths
minted the meter credit before persisting the dedup record (a crash re-credited on
restart, and unlike the rest of the file it was not capped by the 2 VRSC tier), the
under-confirmed report path saved a stale snapshot over concurrent commits, and the
1000-entry trim discarded dedup entries along with audit records.

**Contract change on `/health`.** Two additive `summary` scalars —
`deposits_unconfirmed_open` and `deposits_needs_operator` — plus a new structured
`deposits` block. **`deposits_needs_operator > 0` now makes `status` read
`degraded`**: it means a buyer's balance may be wrong and only a human can say which
way, which is strictly worse than a dead-lettered inbox item. Monitor on
`summary.deposits_needs_operator` above 0 rather than on `status`; `status` is
already pinned to `degraded` for the rest of any run containing one container crash,
so it carries much less information than it appears to.

Also new: `ctl deposits`, `GET /v1/deposits`, `deposit.reversed` /
`deposit.restored` / `deposit.needs_operator` control-API events, and a
`j41-dispatcher deposits` command with three verbs:

- `deposits list` — anomalies first, each printed with the buyer's meter
  `totalDeposited` against the ledger-derived expectation, so "did the
  adjustment run?" is arithmetic rather than a judgement call.
- `deposits credit <agent-id> <txid>` — the buyer is owed this; re-verifies the
  transaction on-chain and fails closed on any doubt.
- `deposits dismiss <agent-id> <txid> --reason <text>` — nothing is owed; moves
  no money, records why.

The verbs run out-of-band against a live daemon, so both files are now
serialised across processes: `deposits.json` through an async per-agent lock
(`src/file-lock.js`), and `credit-meters.json` through a synchronous one held
across its load-mutate-save. The meter lock fails OPEN after 250ms and says so
loudly — refusing to settle a request the buyer has already been served would
either drop the charge or break the proxy, and a rare bounded lost update beats
a continuously broken settle path.

### The `start` action can now be executed by a test

`start` is a ~1700-line closure inside `program.command('start').action()`. Nothing
could call it, so every test that claimed to cover it was a source-text grep — and a
grep for an identifier passes against `if (false)`. That is not a hypothetical: across
the five review rounds on 2.29.0, the defects that survived all of them lived in this
code, and they fell in a single pass to a reviewer who built a throwaway harness and
ran the real thing.

`test/helpers/dispatcher-harness.js` runs the real action — real commander parse, real
activation loop, real marker handling, real control plane, real health document —
against a stubbed process edge. Time and the chain are modelled, so a nine-agent
upgrade restart including its three-minute confirmation wait completes in ~100 ms.

- `test/helpers/virtual-clock.js` — fake timers and `Date`, with an auto-advance pump.
- `test/helpers/fake-chain.js` — the two status axes, and the rule that actually bites:
  one unconfirmed identity write at a time, second one is a bare `-25`. Scenarios
  therefore *reproduce* the double-spend rather than describe it.
- `test/helpers/sdk-stub.js` — SDK stub over the fake chain, keeping every real export
  (VDXF helpers, message builders) and replacing only the network-facing classes.
  Every call is audited, so a test asserts "exactly one `setOnChainStatus` per agent"
  instead of grepping for the identifier. Unmodelled methods return `null` and are
  reported, so the stub grows from observed behaviour rather than from guesswork.
- `test/start-action.test.js` — 16 executing scenarios: the zero-transaction routine
  restart, the 2.28.x upgrade restart, a chain-stranded agent with and without a
  shutdown marker, a repair that returns no txid, a repair that fails and lands on the
  next start, both sides of the 90s pending-write gate, an unresolvable confirmation
  wait, the offline-fleet exit advice, and both fail-closed `/v1/version` paths. Every
  one of them also asserts zero rejected chain writes.

Three seams were added to make this possible: `program` and a `__getState()` accessor
are exported under `NODE_ENV=test`, and the control-plane handles are kept on `state`.

An adversarial review of the harness then found two mutations it did NOT catch, both
in the defect class the harness exists to prevent, and both now covered:

- **The chain repair's txid was not being asserted as recorded.** Deleting the
  `_inboxLastWrite.set(...)` after a successful repair passed the whole suite. In
  production that makes the repair invisible to the inbox sweep at +60s, which then
  builds its batched write from the last *confirmed* prevOutput and double-spends it —
  and the repair is the write most likely to still be unconfirmed after an upgrade,
  because downtime is exactly when reviews and attestations pile up.
- **No scenario made an activate's on-chain half fail.** Neutering the
  `!(result && result.onChainTxid)` guard passed the whole suite. That is the guard
  whose absence once reported nine consecutive rejected writes as a tick.

The same review found the harness was **not hermetic**: `src/egress-proxy.js` requires
`node:child_process`, which the module interception did not match, so every scenario
shelled out to the real `docker` daemon and the egress proxy bound on the host's actual
bridge (172.18.0.1) rather than the stub's loopback. The suite silently depended on a
live daemon. Both spellings are matched now.

`started()` is stricter as a result: a run that called `process.exit`, never set
`startupComplete`, or had a timer callback throw is now a failure rather than a pass.

**Verified by mutation — eight, each killed with an accurate message:** deleting the
deactivate-confirmation wait fails 3 scenarios; forcing `repairChain: false` fails the
upgrade scenario; keeping the unmatchable txid fails the unresolvable-wait scenario;
replacing the pending-write gate with `if (false)` fails the deferring scenario while
its companion correctly still passes; and always clearing the per-agent error instead
of honouring `_errorRecordedThisPass` fails two scenarios.

Five of the defects found while building this were in the HARNESS, not the dispatcher,
which is the argument for auditing test infrastructure at least as hard as production
code — a broken harness does not fail loudly, it manufactures confidence. The two worth
recording, because both are general traps:

- **Substring matching in the audit helpers.** `'deactivate'.includes('activate')` is
  true, so "exactly one activate per agent" could be satisfied by a deactivate with the
  activate missing entirely. Matching is exact now, with a self-test pinning it.
- **A teardown that only ran on the success path.** One scenario tore down manually
  after its assertions; a failing assertion skipped it and left the virtual clock
  installed and PAUSED, so every later test hung on a clock that never advanced and the
  run had to be SIGKILLed. `teardown()` is idempotent now and registered before the
  assertions. One mutation pass went from a 100s hang reporting nothing to 0.76s with
  two clean failures.

### Fixed

- **Agent status leaked from one agent to the next at startup** (pre-existing, found by
  review of the above, reproduced and pinned by the new harness). The per-agent axis
  variables were cleared only after `readyAgents.push(...)`, and three paths `continue`
  before reaching it. A skipped agent left its axes loaded, so the next agent whose
  `authenticate()` threw — the daily ~04:00 UTC backend maintenance window is the
  routine cause — took the fail-open "including" path and was recorded carrying the
  *skipped* agent's status. Both directions do harm: an inherited `chain=inactive`
  makes `planAgentActivation` broadcast an on-chain identity write for an agent on the
  strength of another agent's data (a fee, and prevOutput contention); an inherited
  `platform=active` yields "already active — no write needed", so the platform POST
  never happens and the agent is silently unhireable with `/health` green. Reset now
  happens at the top of the loop body.
- **The new axis-naming skip line could fabricate a platform reading.** It read
  `_lastSeenPlatformStatus`, which carries a deliberate `|| _eff` fallback for older
  backends — so against a backend that serves no platform axis it printed
  `platform=inactive`, asserting a value the backend never sent. It now reads the
  profile directly and says `platform=unavailable (backend does not report it)`. It
  also treats `chain=disabled` as a named blocking axis; testing only for `inactive`
  left that shape unexplained, which is the same confusion the line exists to remove.
- **"WebSocket: N agent(s) connected" became a lie** — a regression created by the
  `chat.connect()` fix immediately below. The counter increments synchronously before
  the connection resolves; that was harmless only while a rejected connect killed the
  process. A fleet started inside the 503 window would print "9 agent(s) connected"
  directly above nine failures. It now counts attempts and says "connecting", and the
  failure line states that a step-1 (token-fetch) failure leaves that agent poll-only
  until restart, because no socket exists for socket.io to reconnect.
- **The health server's EADDRINUSE retry could resurrect a closed server**, re-binding
  the port up to 3s after `stopControlServer()`. Guarded with a `_closing` flag.
- **`chat.connect()` was a floating promise.** The surrounding `try/catch` only sees
  synchronous throws, so when the platform is unreachable at startup the rejection was
  unhandled — and Node's default `--unhandled-rejections=throw` terminates the process.
  A dispatcher starting during a platform outage could die instead of falling back to
  poll-only. Found by the harness on its first scenario.
- **`stopControlServer()` left the health server listening** — a handle with no owner.
  All three call sites currently exit the process straight afterwards, so the OS
  reclaims it and the production impact is nil; it bites anything that stops the
  control plane without exiting, which is what leaked a bound port per harness
  scenario. Cleanup that works only because the process dies next is not a contract
  worth keeping.
- **The startup skip line named the wrong axis.** `⏸ <agent>: inactive on platform` was
  printed using the ANDed value, so an agent whose platform axis reads `active` and
  whose *chain* axis is the blocker — exactly what an older dispatcher leaves behind —
  sent the operator to check `platformStatus`, see `active`, and conclude the
  dispatcher was confused. It now names the blocking axis.

## 2.29.0

**LIVE-PROVEN 2026-08-12.** The upgrade restart was executed on the 9-agent fleet:
9/9 restored from the marker, 9/9 chain repairs confirmed on-chain, **zero rejected
writes** (the previous three restarts produced 9, then 5, then 3), all nine hireable
afterwards. It also repaired two agents that were already broken beforehand —
`agent-6` and `agent-7` were `chain=inactive, platform=active`, silently refused by
the hire gate while every local surface said healthy. Three fixes proved themselves in
sequence: the confirmation wait ran for the first time in any version, the
`/v1/version` capability check earned the on-chain-off default rather than assuming
it, and the repair fired exactly once per agent.


Backend shipped `agents.platform_status` (089bf94, migration 058), which removes the
reason we were writing agent status on-chain on every restart. **Routine restarts now
perform zero on-chain transactions again**, and this time the durability hole that
forced the 2.19.0 revert is closed on their side rather than worked around on ours.

The shape of the fix: there are two status axes now. `status` mirrors the on-chain
VDXF value and the indexer overwrites it from chain on every re-index — so anything we
write there is best-effort. `platform_status` is set only by the signed
`POST /v1/agents/:id/status` we already make, the indexer never touches it, and the
hire gate is a fail-closed AND over both. Availability is durable without a chain
write, so the two writes that self-collided — shutdown's deactivate and startup's
activate, spending the same `prevOutput` — simply no longer exist.

- `J41_STATUS_TOGGLE_ONCHAIN` **defaults to off**; `=1` opts a restart back in.
  Explicit `activate` / `deactivate` still write on-chain, unchanged: that is what
  on-chain status was always for.
- Startup now reads **both** axes and ANDs them (`effectiveAgentStatus`). This is not
  cosmetic. Once we stop writing `status` on-chain, a clean shutdown leaves the chain
  saying `active` while availability says `inactive` — so a `status`-only read reports
  a healthy fleet that cannot take work, and the activation loop's "already active, no
  write needed" skip would never bring it back. Reading one axis would have re-created
  the 2026-08-06 outage as a side effect of fixing the collision.
- `/health` degrades on the ANDed value; `inspect` shows both axes plus the AND.
- A backend that does not report `platformStatus` falls back to `status` alone.

The 2.28.2 per-txid deactivate-confirmation wait is retained but is now inert unless
an operator opts back into on-chain toggling.

### Audit mediums — money cluster

**M3 — the outbound-money rate limit did not exist.** The README has promised "max 3
sends/job, max value = job price + 10%, max 10 sends/hour, 30s cooldown" and "suspends
all sends if API unreachable for 30 min" since the security section was written.
`checkDispatcherRateLimit` and `recordDispatcherSend` implemented all of it and had
**zero callers**; `dispatcherFinancialSuspended` was written by the allowlist sweep and
read by nobody. All four guarantees were documentation.

Now enforced in `attemptPendingRefund`, the single point where VRSC leaves the host.
This is defence in depth, not the primary control — every send is already behind
operator approval, an allowlist, an inter-process lock and a durable ledger. What it
adds is a bound on how much damage a bug in any of those can do, because each of them
trusts the caller's arithmetic and none checks how much or how often.

- Blocked-but-retryable (cooldown, hourly cap, outage suspension) → the entry stays in
  the ledger and the next drain retries. Blocked-and-not (per-job cap, value ceiling)
  → left queued and reported, since retrying cannot help.
- Limits are configurable under `[refund_limits]`; a large approved backlog legitimately
  needs a higher hourly cap, and a limit you cannot raise is a limit operators disable.
- Fixed while wiring it: a missing job price made the value ceiling `NaN`, and every
  `> NaN` is false — so the check passed for exactly the malformed entries it existed
  to catch.

**M2r — `||` treated a legitimate zero as missing.** The non-streaming settle read
`parsed.usage.prompt_tokens || estimatedInput`, so an upstream honestly reporting
`completion_tokens: 0` was billed the flat ~2000-token estimate. The streaming path had
already been converted to `Number.isFinite`; this one had not — the same "control
applied at one of two sites" shape four audit domains reported independently.

Two related holes closed at the same time:

- `sawUsage` was set by the *presence* of a usage object, so `{prompt_tokens: 900}`
  with no `completion_tokens` skipped the worst-case output settle entirely — the exact
  hole that settle exists to close, reachable by omitting one field. Both paths now
  track a finite `completion_tokens` specifically.
- On the streaming path the upstream-error check lived *inside* `if (!sawUsage)`, so a
  4xx/5xx that carried a usage frame was billed its reported tokens. The error check is
  now first and unconditional, matching the non-streaming path.

**M4 — DEFERRED out of this release, deliberately.** The 0-conf deposit reconciler
(credits taken from the mempool are never revisited, so a dropped sub-2-VRSC tx leaves
free credit standing) was built, reviewed five times, and then pulled back out.

It was a third of the source diff and produced roughly a quarter of every defect found
across five review rounds — an uninterpretable-response reversal, a route-404 misread,
a crash double-claw, a systemic guard that protected only the last record of each pass,
and two distinct ways of minting credit. What it closes is a ≤2 VRSC-per-event leak
that has existed for months with nobody exploiting it. Meanwhile the genuinely
time-sensitive part of this release — the `platform_status` cutover, whose backend half
is already deployed and waiting on us — had been stable for three rounds.

Bundling them meant the proven, urgent work was gated on the unproven, risky work. The
branch `feature/m4-deposit-reconcile` keeps every line and all 29 of its tests; it
lands on its own once an execution harness exists, so it can be tested rather than
grepped. The absence of that harness is precisely why its defects survived three rounds
of people reading the code.

### Adversarial review of the above, before release

Two independent reviews of this changeset found ten defects in it. Seven were real
and are fixed here; the two most serious were introduced by the release itself.

**The upgrade stranded the fleet.** Flipping the on-chain toggle off is the easy half.
2.28.x deactivated on-chain at shutdown, so *every* operator upgrading arrives with
the chain axis reading `inactive`. The new code correctly computed `inactive`,
restored the agent, performed a platform-only activate — and never repaired the chain
axis. The hire gate ANDs both, so all nine agents were unhireable while the start log
printed nine ✅ and `/health` reported `ok`: the exact 2026-08-06 shape, reproduced by
the release written to prevent it. The startup loop now repairs a stale chain axis
once (safe — this cycle broadcasts no competing deactivate, and any deactivate from
the previous process is waited out first), and `chainStatus` is carried separately
through to `/health` so a successful platform write can no longer erase the evidence.

**The reconciler reversed honest buyers on an uninterpretable response.** The comment
said "a response we cannot interpret is NOT evidence of absence"; the control flow fell
straight through that case into the reversal path. An empty body, a `{}`, a
`{data:{…}}` re-wrap — any backend response-shape change would have clawed back every
open 0-conf credit on the fleet within three polls. Reproduced, then fixed. Related:
`_isTxUnknown` matched a bare `404`, which the SDK also emits for a *route*-level 404,
so one deploy window looked identical to "the chain does not know this txid" for every
txid at once. It now requires a transaction-specific signal, and a reversal requires
the miss run to span ten minutes rather than three polls.

Also fixed:

- **Three settle sites, three policies.** `proxyRes.on('error')` billed a flat
  worst case with no statusCode check, so the same 503 cost either nothing or the
  entire `max_tokens` reservation depending on whether the socket closed cleanly.
  Worse, `proxyReq.on('error')` *also* fires on a dead socket and refunded in full —
  so the price of an aborted stream depended on which listener Node reached first.
  One settle function now serves all three.
- **`effectiveAgentStatus` failed open on mixed values.** `{active, suspended}`
  resolved to `active`. Since the chain axis reads `active` for every running agent,
  that mixed case is the realistic one. Only both-active is now active, and values
  are normalized for case and whitespace.
- **The 2.28.2 confirmation wait was dead in every configuration.** The marker file
  holding the deactivate txids is unlinked (or rewritten without them) ~1000 lines
  before the wait reads them, so `_dtxids` was always `{}`. Captured up front now.
- **A crash between the two reversal writes double-clawed the buyer.** A `reversing`
  stamp is persisted before the debit, mirroring `markRefundInflight`.
- **Rate-limit deferrals were invisible.** A backlog past the hourly cap left entries
  `approved`-but-unsent, which `refunds list` filtered out, `refunds approve` answered
  with "already approved — no action", and `approve --all` reported as "no pending
  entries" — while counting deferrals as "processed". All four now tell the truth, and
  re-approving retries the send.
- **The limits were per-process.** Counters and the outage suspension lived in memory,
  so an out-of-band `refunds approve` had its own 10/hour budget and never saw a
  suspension the daemon had raised. Now shared via `send-history.json`. The per-job
  lifetime cap also stopped being cleared when a job went terminal — which is exactly
  when a duplicate refund would be attempted.

Two review findings were deliberately not "fixed": an attacker can still get one
sub-2-VRSC deposit's worth of compute inside the grace window (inherent to the 0-conf
tier, now bounded rather than unbounded), and a crash with both axes left `active` can
still land a hire on a dead agent (pre-existing, and the cutover does not widen it).

### Second review round — seven more, four of them regressions from the first round

The fix commit was reviewed again. It had introduced three new defects and left
four findings incompletely closed. This is the round that matters most, because it
is where "we fixed it" stopped being true twice in a row.

**A successful chain write reported as a failure, instructing a double-spend.**
`state._inboxLastWrite` was created lazily by the inbox sweep, whose interval first
fires 60 seconds in — long after the activation loop reaches every agent. So the
repair broadcast, succeeded, then threw on recording it; the catch printed
"repair FAILED … Run: j41-dispatcher activate <id>"; and an operator following that
instruction broadcasts a second identity write on top of the unconfirmed first.
Our own error message prescribing the exact `-25` this release exists to delete.

**The repair read a snapshot the wait guarantees is stale.** `chainStatus` is
captured ~1000 lines before the activation loop, and the confirmation wait in
between exists precisely because the deactivate has not landed yet — so by the time
it does, the snapshot says `active` while the chain says `inactive`, and the repair
is skipped. Since the deactivates confirm at different times, a real upgrade
produced a MIX of repaired and silently stranded agents. The wait now refreshes the
snapshot and releases on the chain axis rather than on txid equality alone (which
also never released once any later write superseded that output, burning the full
three minutes in exactly the recovery cases that are already confusing).

**Making `approved` retryable opened a double-send.** `drainPendingRefunds` has
always excluded entries carrying an in-flight marker — that marker means a send
failed *ambiguously* and may already be on-chain. `refundsApprove` had no such
guard and never needed one while `approved` was terminal. Removing that accident
exposed the missing check: `refunds approve --all --yes` re-broadcast. Reproduced
by the reviewer. Both `approve` and `approve --all` now refuse in-flight entries and
point at `refunds unblock`.

Also closed: the repair now respects the pending-write gate (its shutdown twin had
it; the startup twin did not — the same asymmetry a comment two commits earlier
criticised); `_axisBlocks` blocks on any non-active, non-unknown value instead of an
enumerated pair; the shutdown marker is retired only after activation, so an
interruption no longer downgrades the self-heal to manual recovery; the counter file
gained a cross-process lock; the outage suspension moved to its own file, because
folded into the counters a one-byte corruption silently disarmed it; a non-streaming
RST refunded the reservation twice and left the buyer richer; and a partially
reversed deposit that later confirms is re-credited.

### Third review round — the one that stopped the restart

**The upgrade restart would not have worked at all.** `kickWatchdog` is declared
inside `gracefulShutdown`; the confirmation wait calls it from the `start` action.
`kickWatchdog?.(…)` is not a no-op there — optional chaining guards a null *value*,
never an undeclared *binding* — so the wait's first sleep threw `ReferenceError`,
`program.parse()` routed it to a handler that logs "non-fatal", and the rest of
startup silently stopped: no activation, no repair, no signal handlers, and
`startupComplete` never set, so `/health` reported `ok` forever while the process
printed a status line every 60 seconds. A zombie, on precisely the fleet upgrade
this release exists to perform.

That line predates this work. It was unreachable dead code until round 2 fixed the
txid capture and armed the wait — so arming a guard is what exposed it, and no
amount of reading the diff would have caught it, because the failing path had never
executed in any version.

**A suspension raised before a restart could never be lifted.** Round 2 made the
outage flag durable across restarts (correct — a suspension a restart lifts is not
one), but left both clear sites gated on the in-memory `dispatcherApiOutageSince`,
which is null in a fresh process. An outage spanning a restart therefore deferred
every refund fleet-wide forever, while the operator was told it "clears
automatically when the platform responds" and to remove the file "if the daemon is
not running" — it was running. Persisting state without moving its clear condition
off process-local state is the whole bug.

Also closed: the marker now retains agents whose chain state could not be
established (keying retention on a positive `inactive` read dropped exactly the
agents whose wait timed out); the reversal stamp became a two-phase state machine,
because `reversing: true` was being read as "the debit ran" on one path and "the
debit may not have run" on the other, from the same flag — where it is genuinely
ambiguous no money now moves and a human is told; `_isTxUnknown` gained a weak/strong
tiering after the reviewer found the platform's own documented 404 body matches none
of the strong patterns, which would have left the M4 leak inert in production; and
`refunds approve --all` no longer reports "nothing owed" when the entire backlog is
in-flight-blocked.

Four mutations that survived the round-2 suite now fail, including the deadline and
the marker-retention fix from round 2 itself.

### Fourth review round — and a static check for the class that keeps escaping

Round 4 executed the real `start` action in a sandboxed harness rather than reading
it, and reproduced its money finding rather than reasoning about it. Both halves
found defects in round 3's own work; one more was self-caught before the round began.

- **The systemic guard did not guard.** The check meant to tell "the chain does not
  know this txid" apart from "the route is 404ing for every txid at once" lived
  inside the per-record loop: it persisted a miss *before* testing, and compared a
  counter still being accumulated against the total — true only for the last record
  of a pass. Every earlier record was judged as if the failure were isolated.
  Reproduced: three credits, one route outage, all three buyers clawed back.
  Reconciliation is now classify-the-whole-pass-then-decide, and a systemic pass
  counts nothing at all rather than counting more slowly.
- **A wrong reversal was permanent.** Reversal moved a record into `reversed`, which
  nothing ever read again — so the one case where our judgement is wrong was the one
  case a buyer could not recover from. Recent reversals are re-checked and restored
  on a positive confirmation, bounded and idempotent.
- **A failed chain repair erased its own diagnostic** 28 lines later, so `/health`
  degraded with `lastError: null` on every agent — a fault with no stated reason,
  which is exactly the observability this release was adding.
- **The inbox sweep had no `startupComplete` gate**, so it could broadcast an
  identity write for an agent the startup repair was about to write. C1 closed the
  shutdown direction of that collision and left the startup one open.
- **The suspension probe authenticated as `agents[0]`** to call an endpoint the SDK
  documents as public — one revoked identity would hold every refund fleet-wide
  behind a durable flag. It is sessionless now.
- Self-caught first: ungating the suspension clear was right for the branch that
  probes the platform and wrong for the branch that cannot. An idle fleet is not
  evidence the platform is up — during an outage the fleet is idle by definition.

**`test/helpers/scope-check.js` + `test/no-undeclared-identifiers.test.js`.** The round-3
`ReferenceError` — an identifier referenced in one function and declared in another,
reached through optional chaining that made it look safe — survived three
adversarial review rounds and a 1057-test suite, because the failing path had never
executed in any shipped version. `node --check` cannot see it; neither can any
runtime test, in a file whose largest functions are unexported closures. A
scope-tracking AST walk sees all of it in milliseconds. Run against history it flags
the bug at 1c42d42, a87d07e and 8165676 and reports clean from 82063ac on. It ships
with two self-tests, because a checker that reports "all clear" because it is broken
is worse than no checker.

### Fifth review round — the safety net was itself broken

Both halves executed rather than read: the money reviewer reproduced two credit
mints against the real modules, and the status reviewer rebuilt a sandboxed harness
and ran the real `start` action through five scenarios including the upgrade.

- **The phase-4 restore minted credit two ways.** A forgiven reversal never debited
  but still filed a ledger entry, and a re-reported deposit was credited by the
  forward path *and* the restore: 1.5 → 3.0 in both cases. The ledger now records
  whether the debit was certain, only a certain debit restores, and any forward
  credit settles the matching entry. Same "one control, two sites" shape — the
  forward confirm path already refused to move money on an ambiguous state.
- **The scope checker shipped in round 4 had a false-negative class.** Block-scoped
  `let`/`const` leaked into the enclosing function scope, so every "used outside its
  block" ReferenceError read as clean. The tool built to catch what had survived
  three rounds was itself half-blind — the exact hazard its own header warns about.
- **`/health` read `ok` through two real fleet-down shapes.** It never consulted
  `_agentErrors`, and `unknown` axes deliberately do not degrade — so a restart
  during the daily platform outage (both axes unknown, every activation failed)
  reported healthy, as did a wedged startup that never completed.
- **Round 4's `_agentErrors` fix was a logical no-op.** `if (!has(id)) delete(id)`
  deletes only when the key is absent: right behaviour by accident, wrong behaviour
  in the comment, which is worse than either.
- An unresolvable deactivate txid is dropped rather than re-armed, so a superseded
  write no longer costs three minutes on every subsequent start.

Five rounds, 34 defects. The majority were introduced by the previous round's
fixes, which is the finding that outlasts any individual bug here.

1088 tests. Every fix mutation-checked — and the second round is why that
phrase now means something: seven mutations that the reviewer proved survived the
first round's "mutation-checked" claim now fail. Three tests in this file had also
silently stopped testing their subject, because they anchored on a distance from a
call site and the new code was inserted in between. They anchor on guard
expressions now. Two lessons recorded rather than
smoothed over: the first round's mutation testing covered the pure function and not
the call site, so reverting the two-axis read passed the entire suite; and two of the
new proxy tests initially passed for the wrong reason, because a mock that destroyed
its socket synchronously never produced the mid-stream abort it claimed to.

## 2.28.2

2.28.1 improved the restart collision from 9 rejected on-chain activates to 5, and made
the failures loud. Five is still five — the wall-clock wait was the wrong instrument.

A flat 75-second pause assumed a Verus block arrives in 75 seconds. Block time varies,
so the guess was marginal by construction. The deterministic question is *"has this
agent's deactivate confirmed"*, and the shutdown marker now records each deactivate's
**txid** so startup can ask it directly: poll `getIdentityRaw` until `prevOutput`
matches, per agent, bounded at 3 minutes, then proceed with the (now loud) failure
report for any that never confirmed.

986 tests.

## 2.28.1

**Every restart left the fleet inactive on-chain, and reported success.** Found by
reading 2.28.0's own restart log: nine consecutive
`On-chain status update failed: Transaction rejected by the network`, each printed as
`✅ agent-N: active (on-chain txid: skipped)`.

The collision is **self-inflicted and I missed it in C1**. C1 gated the inbox sweep
against the deactivate and made startup record its own write — but shutdown's on-chain
deactivate and startup's on-chain activate are themselves back-to-back writes against
the same `prevOutput`, seconds apart with no block between them. The deactivate lands,
the activate double-spends it, all nine are rejected. The fleet then sits `inactive`
on-chain while `active` on the platform — exactly the state backend warned about, where
a re-index reverts the platform value and a hire lands on a stopped agent with no escrow.

Two fixes:

- **A null txid is now reported as a failure.** The SDK returns `null` only when the
  write failed (no UTXOs, or rejected), so `skipped` never meant "unnecessary" — it
  meant "did not happen". Nine rejections hid behind a tick, and the recovery command
  is now printed with them.
- **Startup waits for its own deactivates to confirm.** If the shutdown marker was
  written less than a block ago (~75 s), the activation loop waits before broadcasting.

985 tests. Both mutation-checked — and three drafts of one assertion silently anchored
on the wrong region of the file (a string that also appears in a comment; a loop that
appears twice), passing while reading code tens of thousands of characters away. A test
asserting against the wrong region is worse than no test; the final version anchors on
text that occurs once.

## 2.28.0

An independent re-verification of all 41 audit mediums against current code. It found
**6 already fixed**, and — more usefully — that **two of my own recent fixes had made
things worse**. This release closes both, plus the halves 2.27.0 left open.

**C1 — the pending-write gate was applied asymmetrically, and the gate itself was
fake.** 2.27.0 guarded the shutdown on-chain deactivate and called the gate bypasses
closed. Three problems:

- The "gate" was a flat **8-second sleep**. A Verus block is ~60 s, so an unconfirmed
  transaction is almost always still unconfirmed afterwards — it looked like a fix and
  bought nothing. It now polls the real `shouldDeferForPendingWrite` state against the
  chain, bounded at 90 s, and proceeds loudly rather than silently if it never confirms.
- The **startup activation** — the identity write most likely to collide, because it
  lands seconds before the inbox sweep timer first fires — was left bare. It now records
  its txid into `_inboxLastWrite` so the first sweep defers.
- The **inbox sweep kept running through the drain**, which can last 120 minutes, so the
  reverse collision (sweep double-spends the deactivate) was untouched. It now stops
  once `shuttingDown` is set.

**C2 — 2.23.0's L2 fix made a double-spawn race reachable in the default runtime.** That
fix moved `getAgentSession` + `getJob` + `startJobContainer` inside the bare 10-second
cleanup interval. `state.retries` is read-then-written across those awaits with no lock,
so two overlapping passes can each respawn the same job. Previously local-mode only; now
the Docker default. The loop is non-reentrant and counts its skips, matching its two
sibling loops.

**C2/L4 — a Docker daemon blip tore down every in-flight job.** `ECONNREFUSED`/`ENOENT`
from `inspect()` landed in the same catch as a genuine 404, and since `container.wait()`
had recorded no exit code the crash path never ran — so every active job was silently
torn down with **no refund**, and locked out of re-polling for 7 days by `seen`. A 404
now means gone; anything else means the daemon is unreachable and the job is left alone.

983 tests. All four mutation-checked — and two of the first-draft assertions passed
under mutation because they checked that an identifier appeared rather than that the
guard held. Both were rewritten to pin the condition.

## 2.27.0

The two remaining pending-write-gate bypasses. Same defect at two sites, both
chain-damaging, both silent.

**T2 — the `review.received` webhook wrote N identity transactions back to back.** It
looped `acceptReview` over up to 10 pending inbox items, each of which writes an
identity transaction, outside the batch and outside the pending-write gate. That is
precisely the double-spend `CLAUDE.md` says never to do: the platform serves the last
**confirmed** `prevOutput`, so writes 2..N of the burst spend an output the chain has
already seen consumed.

It also failed invisibly. `TX_REJECTED` classifies as `contention` in
`inbox-deadletter.js`, which never escalates — so the rejected writes retried forever
with no dead-letter, no health signal and no operator-visible symptom. The webhook now
triggers the batched sweep (one identity transaction per agent per cycle, gated on
`_inboxLastWrite`) instead of writing itself, and declines to start a second sweep while
one is in flight.

**L7 — shutdown's on-chain deactivate raced the same gate.** It is an identity write and
it went out with no regard for an unconfirmed inbox write moments earlier, so it could
double-spend that `prevOutput` and be rejected — silently, for the same reason. It now
waits when a pending write is recorded for the agent. Waiting a few seconds at shutdown
is free; a rejected deactivate is not, because on-chain status is the durable lever that
keeps a hire off a stopped agent (backend confirmed their hire gate reads
`agents.status`, which their indexer overwrites from chain).

978 tests. Both mutation-checked.

### Documentation truth (D2–D6)

Five findings where the docs described a system one or two releases back. Docs were
corrected to match the code, not the other way round.

- **D2** — `config.toml.example` advertised `[provider_keys]` slots (`anthropic`,
  `google`, `xai`) that **nothing reads**: lookup is by *preset* name. The `.env`
  migration routed exactly those keys into the dead slots, so the fleet declined every
  job as "LLM down". Slots now match real presets, with the keyed-by-preset rule, the
  failure symptom and the migration caveat spelled out. `openai-mini` does not read
  `provider_keys.openai` — variants need their own entry.
- **D3** — workspace/jailbox was sold as live in an Overview bullet, a full section and
  a shipped template. It is parked default-off at three gates. Now labelled
  parked/opt-in throughout, and `JAILBOX_PARKED.md` is linked rather than orphaned.
- **D4** — both refusal sites printed *"set `JAILBOX_ENABLED=true`"* while the reader is
  `bool1` (`raw === '1'`), so the remedy printed **at the moment of failure** was itself
  a no-op. Both now say `=1`, and the README states that `true` is treated as unset.
- **D5** — `extension.approved|rejected` and `dispute.filed|resolved` reach `/v1/events`
  only through the webhook route, so in poll mode (the default) they can never fire. The
  event list is now verified against every `emitEvent` call site and split explicitly
  into both-modes and webhook-only.
- **D6** — `refunds` was absent from the README while the Overview claimed crash recovery
  "handles refunds"; it queues them for a manual approval no operator doc named, ending
  in an unpaid buyer. New Refund Approval Queue section, and the honest note that
  pending refunds appear in neither `ctl status` nor `/health`.

## 2.26.0

Two independent adversarial reviews of everything shipped since the audits
(2.20.0–2.25.0). They found defects **in the fixes themselves**, including one
regression this release reverses.

**K1 regression — the guard crashed the dashboard.** 2.20.0 made `writeKeysFile`
*refuse* to overwrite key material with a key-less object. Safe, but
`readKeysFile({allowLocked:true})` strips key material **even when the pool is
unlocked**, and the Retry Registration screen's three write-backs all read that way —
so on any encrypted pool every one of them threw a plain `Error`, which propagated
past the TUI's `BACK` handler and killed the whole dashboard. An operator who followed
our own `encrypt-keys` advice lost registration recovery entirely and got a stack
trace. Trading silent key destruction for a crash is not a fix. The guard now **carries
the existing key forward and warns loudly** — safe because nothing here legitimately
clears a key, and the warning keeps the call-site defect visible.

**I1 — the containment check was purely lexical and bypassable.** `path.resolve`
normalises `..` but does **not** follow symlinks. Since the job-agent can write into
its own files directory, it could plant `files/link -> /app/sign/req` and a
`Content-Disposition` of `link/abcd1234.json` then resolved *lexically inside* the job
directory while the bytes landed in the host broker's watch dir — the forged
`executeOnChain` attack, still reachable with the fix in place. Now uses
`fs.realpathSync` on the resolved parent, and treats an unresolvable path as an escape.
Demonstrated before and after: the lexical check reported "contained" while the file
was provably in the broker directory.

**F1 — the headline claim was false.** 2.21.0 made `publishVdxf` throw so the SDK stops
marking a step that did not happen; that half was real. But `setup` wraps finalize in
a `try/catch`, logged one ⚠️ line, and printed the **"Setup Complete"** banner anyway —
and `require_finalize` defaults to false, so `start` would run the agent over an empty
on-chain identity. Exactly the failure F1 claimed to fix. `setup` now prints **"Setup
INCOMPLETE"**, says not to start the dispatcher, and exits 1. The throw's message also
no longer claims the identity is empty, which was false on a re-run.

**I2 — one of five sibling writes.** `writeJobFileNoFollow` guarded `description.txt`;
`buyer.txt`, `amount.txt`, `currency.txt` and `canary.token` kept plain
symlink-following writes on the same pause/resume path, in **both** runtimes. A
container planting `buyer.txt -> ~/.ssh/authorized_keys` still got an arbitrary
overwrite. All five now guarded — the very pattern the fix's own comment lectured about.

**The derived encryption-guard test was too weak**, and tightening it found a real
offender. It required the guard *somewhere* in a command block, so a block with one
guarded and one unguarded write passed. It now requires the guard **before** the first
key write — which immediately caught `registerAgentIdentity`, unguarded and protected
only incidentally by an `ELOCKED` throw from an unrelated read.

Also: **B5's on-chain deactivate no longer fails silently** (a bare `catch {}` swallowed
the write B5 itself calls "the durable lever" while the log printed ✅ — a drained fee
tank is the routine cause); **two L2 retry paths** no longer consume an attempt and drop
a paid job when the re-fetch blips; **`--max-concurrent 0`** (the auto sentinel) is no
longer silently ignored; the dashboard's Start failure no longer misdiagnoses a
local-runtime refusal as encrypted keys; and a dead import is gone.

974 tests.

## 2.25.0

First triaged batch of the audit mediums. All three chosen for the same reason: they
**fail silently while reporting success** — this codebase's recurring weakness, and the
one an operator cannot debug.

**M5 — a seller-agreed refund could vanish with no trace.** If the agreed percentage
was absent or outside `(0,100]`, `selectRefundableDisputes` dropped the job: no ledger
entry, no event, no log line. That is the exact silent-loss class `dispute-sweep.js`
documents as fixed in 2.12.2, reached through a different door — and `respond-dispute`
does not range-check the flag, so an operator typo (`--refund-percent 150`) is a live
trigger and the buyer is simply never paid. It still does **not** auto-queue (inventing
an amount the seller did not agree to would be worse), but it now prints the job, the
unusable value, and the exact command that fixes it.

**T6 — a credential configured in the TUI was never sent.** The API-endpoint screen
saves it into `agent-config.json` as `upstreamAuth`; the proxy wiring only ever read
`apiEndpointAuth`. So an operator who configured their upstream key through the
dashboard got a proxy that forwarded unauthenticated, and every request failed with no
indication why. Both names are now accepted.

**L8 — `config --max-concurrent` printed success and changed nothing.** It wrote
`maxConcurrent` into the legacy `config.json`, while `start` resolves capacity from
`config.toml`'s `runtime.max_concurrent` — and the comment there says the legacy key is
"deliberately NOT consulted". Now written where it is actually read.

973 tests. M5 mutation-checked; T6 and L8 are wiring paths without unit coverage.

## 2.24.0

The last two audit highs. Both were controls this codebase already had, unapplied at a
second site — the pattern four separate audit domains reported independently.

**S3 — an unauthenticated caller could burn the shared nonce cache.**
`/j41/deposit/report` recorded the nonce and fired an outbound `getIdentityKeys`
*before* checking the signature, with no rate limit. `nonce-cache.js:78-88` documents
precisely this attack and ships `checkNonceAfterVerify` for it — the v2 access path
uses it, this route did not. The cache is bounded at 100k entries and **shared** with
that path, so junk nonces here evict legitimate entries and reopen the replay window on
the paid proxy.

The nonce is now recorded only after the signature verifies. The outbound lookup cannot
move later (it supplies the key we verify against), so amplification is handled by rate
limiting the route on the same limiter as `/j41/discovery/request-access` — which
carries a comment saying it exists "to prevent amplification DoS" and was never applied
to its neighbour. Replay protection is unchanged.

**S1 — the documented scale remedy took the operator's own fleet down.** The README's
only guidance was "raise the interval or run a second dispatcher". Neither worked: the
poll interval was computed inline in `cli.js` with no config or env path, and `start`
SIGTERMs whatever PID it finds in `dispatcher.pid`, so a second instance stops the
first.

Added `[poll] interval_ms` / `J41_POLL_INTERVAL_MS` (0 = the previous automatic
`max(60s, agents x 1s)`). The README now documents the knob, states that a second
instance needs its own **`HOME`** as well as the three port variables — and says
plainly that omitting it stops the running dispatcher. It also corrects the cost model:
roughly **3 round trips per agent**, not one, so the published table understates the
load.

971 tests.

## 2.23.0

Three more audit highs. All three are the same shape the audits kept reporting: a
control that exists and works, not applied at a second site.

**L2 — Docker container crashes were invisible, and the canonical alarm could never
fire.** `AutoRemove: true` deletes an exited container immediately, so the 10-second
`inspect()` poller almost always 404s before it sees the exit. The catch logged
"container gone" and tore down — skipping the **entire** non-zero-exit branch: no
retry, no `refundAbandonedJob`, no `container.died` event, and `_containerCrashes`
never incremented. That pins `summary.containers_unhealthy` — the README's canonical
"tell me when anything is wrong" watch — at **0 in the production runtime**. A buyer
OOMing the 2 GB container was recorded as a clean completion.

The exit code was already available: `container.wait()` records it on the active entry
at spawn time. The 404 path now consults it and runs the same retry / crash-signal /
refund decisions instead of discarding the event.

**L1 — the shutdown stall watchdog could strand the whole fleet.** `HARD_EXIT_MS` is
30 s and the deactivate loop kicked it once per agent *before* that agent's four serial
platform calls, whose SDK worst case is ~93 s (30 s timeout × 3 attempts + backoff).
Worse, `shutdown-deactivated.json` — the marker that lets the next start restore those
agents — was written only *after* the whole loop, so a watchdog exit mid-loop recorded
nothing and the next start skipped every agent it had just deactivated. The trigger is
a **slow platform**, which is the usual reason to restart in the first place. The marker
is now written after every agent, and a completed deactivation kicks the watchdog:
the budget is for a wedged call, not for the loop.

**K2 — `init` wrote plaintext keys onto an encrypted pool.** It never called the unlock
guard, so every agent created after `encrypt-keys` silently downgraded custody. A gap,
not a decision — `setup` calls the guard immediately before the identical write.

The guard's test enumerated commands by hand, which is *how* `init` slipped: it was
neither guarded nor listed. Added alongside `setup`, and backed by a **derived** check
that finds every command whose body writes key material and fails if it lacks the
guard — so the next one cannot slip the same way. Mutation-checked: removing the guard
from `init` now fails two tests instead of none.

966 tests.

## 2.22.0

Audit highs: two money defects in the paid proxy, two container-escape seams.

**M1 — a streaming upstream error billed the full worst-case reservation.** The
worst-case settle is the correct defence against an upstream that returns real output
without a usage frame, but `proxyRes.statusCode` was passed through to the client and
**never consulted before billing** — and a 503 has no usage frame either. A buyer
sending `stream:true, max_tokens:200000` was charged ~204,000 tokens for an error page.
`proxyReq.on('error')` does not fire because the connection succeeded, and the circuit
breaker only opens after N consecutive failures, so the first N bill in full.

**M2 — the non-streaming path had the same gap with the opposite sign.** It never
received the streaming path's hardening: an upstream that omits usage was billed a flat
~2,000-token estimate regardless of what it actually returned (a buyer just sets
`stream:false`), and an error response was billed that estimate too.

Both now settle on status: a non-2xx bills **nothing** — no output *and* no input,
because the buyer received an error rather than a service — while a 2xx with no usage
frame still settles worst-case, so the anti-abuse defence is intact. Tested against the
real handler with 503 upstream mocks, and mutation-checked.

**I1 (partial) — a downloaded file could escape the job directory.** The SDK derives
the on-disk name from an unsanitised `Content-Disposition` header, so a traversing
filename can land the payload in `/app/sign/req/` — the host broker's watch dir, whose
own filter `^[a-f0-9-]{8,80}\.json$` such a name satisfies. A forged `executeOnChain`
there broadcasts an identity transaction and drains the fee tank; a forged
`budget_increased` lifts the token ceiling. No code execution or prompt injection
required.

We cannot sanitise before the SDK writes, so the download is now verified to have
landed inside the job's files directory and removed if it did not. **This narrows the
window, it does not close it** — the file exists briefly at the escaped path, and a
broker poll could read it first. The durable fix is broker-side (act only on request
files the host itself created) and is tracked as I1-residual, still open.

**I2 — resume could overwrite an arbitrary host path.** Pause tears the container down
but leaves `jobDir`; on resume, `description.txt` was rewritten with a plain
`writeFileSync`, which follows symlinks. A container that plants one gets any host path
overwritten with up to 1 MB of buyer-authored text, as the operator user. The read path
already had `readJobFileNoFollow`; there was no write counterpart. Added
`writeJobFileNoFollow` (O_NOFOLLOW, unlink-and-retry once so a planted link cannot
wedge a legitimate resume) and both call sites now use it.

963 tests.

## 2.21.0

The four **first-run fail-opens** from the audit. They share one shape: the first-run
path detects the problem correctly and then reports success — so a new operator's very
first install produces a dispatcher that takes money and returns nothing usable.

**F1 — `setup` reported success over an empty on-chain identity.** A fresh agent has no
UTXOs, so `publishVdxf` warned and `return`ed. The SDK cannot distinguish that from a
completed publish: it marked `vdxf_published` and walked the agent to `ready`, and
`setup` printed "Setup Complete". Unconditional for every first agent. The documented
recovery was a no-op too — `finalize` never clears state, so the `ready` marker makes a
rerun return instantly. It now throws, which is what stops the state machine advancing
over a step that did not happen.

**F2 — keyless local providers delivered template filler as the paid work product.**
`ollama`, `lmstudio` and `vllm` are declared `envKey: ''` because they need no
credential, but every gate in the executor tested `apiKey` truthiness — so all three
fell through to `generateTemplateResponse`, and that filler was delivered and hashed as
the buyer's deliverable. Preflight could not catch it: it probes the endpoint, which is
up. The TUI even labels them "(no key needed)". Config now exposes `usable`
(a key, or a keyless preset with a baseUrl) and the gates ask that instead. A keyless
endpoint also no longer receives a `Bearer ` header with an empty key.

**F3 — `quickstart` discarded the key it collected.** It printed
`export OPENAI_API_KEY=…`, which `buildContainerEnv` deliberately never reads — provider
keys come from `config.toml`'s `[provider_keys]`, never from the dispatcher's own
environment. Following the printed instructions exactly produced a fleet that declined
every job. The key is now persisted to `config.toml`. It also offered a `claude`
provider that does not exist (the real presets are `claude-opus` / `claude-sonnet` /
`claude-haiku`); the prompt now validates against `LLM_PRESETS` and re-asks.

**F7 — local mode accepted and charged for jobs before refusing them.** The isolation
gate lived inside `startJobLocal`, so a dispatcher in `runtime=local` without
`--dev-unsafe` started cleanly, advertised its agents, accepted jobs, took payment, and
only then refused to run them. Both installers default to `local` when Docker is absent
and the `curl | bash` path takes it silently, so this was the out-of-the-box state for
anyone without Docker. It now refuses at startup, before anything can be accepted.

961 tests. F1/F2 covered and mutation-checked; F3 and F7 are interactive/startup paths
with no unit coverage, flagged as such.

## 2.20.0

Eight parallel domain audits (money, keys, isolation, trust-boundary, liveness, scale,
docs-truth, first-run) returned **~106 findings: 1 critical, 17 high**. This release
takes the four that either destroy data, prevent installation, or invalidate a fix we
already claimed. The rest are triaged in `docs/RELEASE-READINESS.md`.

**K1 (CRITICAL) — a write could destroy the private key irrecoverably.**
`readKeysFile(path, { allowLocked: true })` returns public fields only: on a v2 file it
strips **both** `wif` and the `encrypted` envelope. The dashboard's "Retry Registration"
screen reads that way at four sites and writes the object straight back — with no `wif`
present the encryption branch is skipped and the atomic rename drops a plaintext,
key-less file over the ciphertext. No backup; the master key then decrypts nothing.
Every path through that screen writes.

Guarded in the **primitive**, not the four call sites: `writeKeysFile` now refuses to
overwrite a record holding key material with an object that carries neither `wif` nor
`encrypted`. Any future caller that reads locked and writes back fails loudly instead
of silently destroying custody. Note this only fires *after* an operator runs
`encrypt-keys` — the feature we recommend was what created the exposure.

**D1 (high) — the documented install could not produce a runnable dispatcher.**
`package.json` `files` shipped `src`, `templates` and the docs. The README makes
`./scripts/build-image.sh` a mandatory pre-step and offers `docker build -f
Dockerfile.job-agent` as the alternative — **neither was in the tarball**, and
`cli.js` hard-codes `Image: 'j41/job-agent:latest'` with no pull and no build fallback.
`scripts/`, `Dockerfile.job-agent` and `package.docker.json` are now published.

**L3 (high) — a fourth clock, and it undid 2.17.1.** The container-side dispute hold
was fixed and reported as done. The **dispatcher** has its own timer at
`JOB_TIMEOUT_MS + 60s` that kills the container regardless, so a worker holding an open
dispute still died at ~61 min; the reconciler respawned, each replacement died the same
way, and at three attempts it gave up — about three hours against a deadline measured in
days. It now defers while the job is `disputed`/`rework`, using the status the
transition check already maintains (no extra API call), bounded at 12 deferrals.

**X1 (high) — every bounty-awarded job was accepted and then never started.**
`cli.js:7380` called `startJob(state, agentInfo, fullJob)` against a
`(state, job, agentInfo)` signature. `agent-1`…`agent-9` fail `isValidJobId`'s 8-char
floor and silently early-return; `agent-10`+ throw on `undefined`. Every other call site
was already correct.

955 tests. K1 is covered and mutation-checked.

## 2.19.0

Two changes from backend's 2026-08-09 response. The first reverses a decision from
2.18.0 that was wrong for a reason we could not have known.

**On-chain status writes are back ON by default (reverts B5's default).** 2.18.0 made
the routine start/stop cycle platform-only to save 18 identity transactions per
restart, on the reasoning that the marketplace gates on platform status. Backend
explained the crack: their hire gate reads `agents.status` and **nothing else**, and
their indexer **overwrites that column from on-chain `data.status` on every
re-index**. A platform-set `inactive` is therefore best-effort — while we are stopped
with on-chain still `active`, any re-index (an identity tx, a `/refresh`, or indexer
catch-up after their daily downtime) reverts us to `active`. A hire landing in that
window sends the buyer's funds to a stopped agent, and **there is no escrow**.

Saving 18 transactions is not worth that trade. On-chain deactivate is the durable
lever. `J41_STATUS_TOGGLE_ONCHAIN=0` still opts out for an operator who understands
the window, and the log says plainly what they are accepting.

**Rework share raised 30% → 50%.** Every rework we measured overran its ~30% grant:
107 / 109 / 113 / 138 %. Backend confirmed this is the primary fix for the
unreachable-top-up problem and explicitly advised *against* building a blocking
real-time gate — it converts a bounded cost overrun into a stalled job holding memory
on a buyer who may never answer. 138% of 30 is ~41% of the true need, so 50% covers
the observed range with margin. Existing on-chain policies keep their stored value;
this changes the default for new policies and the fallback when the field is absent.

Backend also shipped their half: `delivered` is now an approvable state, so a
post-delivery top-up is finally collectable — a route to bill, not a guarantee, and
not a licence to overrun.

948 tests.

## 2.18.1

**B1 follow-up: the new degrade fired on every startup.** The health server binds
before the staggered activation loop runs (~1s per agent), so a restart briefly showed
every agent `inactive` and reported `degraded` — caught immediately on 2.18.0's own
first restart. An alarm that cries wolf on every restart is exactly how the
2026-08-06 outage went unnoticed, so this would have defeated the fix it belongs to.
The platform-status degrade is now gated on `state.startupComplete`.

948 tests.

## 2.18.0

All five release blockers from `docs/RELEASE-READINESS.md`. These are operator-surface
defects — the half of the product that had a fraction of the scrutiny the job path got.

**B1 — `/health` could not see whether the fleet was online.** Agent status was derived
purely from local job assignment; platform state was never queried (zero references in
`control.js`). Through the 2026-08-06 outage every surface reported `ok` with all nine
agents `available` while the platform had them all inactive. Now carries
`platformStatus` per agent and **degrades** on `inactive`/`disabled`. `unknown` does not
degrade — "not checked yet" is not "broken". The health server also no longer swallows
`EADDRINUSE` forever: it retries 10× and says so if it gives up, instead of running the
daemon's whole life with no `/health`.

**B2 — the dispatcher accepted new jobs while shutting down.** `shuttingDown` was a
closure variable no other function could read, so `pollForJobs` kept signing and
accepting during a drain, after every agent had been marked offline — a buyer could pay
into a job whose seller was mid-shutdown. Now on `state`, and the poll loop declines new
work while in-flight work continues to drain.

**B3 — the dashboard's Start button always reported success.** The child is spawned with
`stdio: 'ignore'`, so with an encrypted key pool and no passphrase it exits within a
second — the operator who followed our own `encrypt-keys` advice got a Start button that
never worked and never said so. It now waits, reports the real outcome, and names the
likely cause and the fix.

**B4 — `runtime.webhook_url` parsed but was never consulted.** `start` read only the CLI
flag while the dashboard printed `Mode: webhook` from the config value, confirming the
operator's wrong belief; the api-endpoint proxy is webhook-mode-only and so never
started either. Config is now honoured when the flag is absent.

**B5 — every restart broadcast 2N unrequested on-chain transactions.** N deactivations
at shutdown plus N activations at start, fee-paying, that the operator never asked for
(18 per restart on a 9-agent fleet). The marketplace gates on *platform* status, so the
on-chain write buys nothing per restart. The routine cycle is now platform-only;
`J41_STATUS_TOGGLE_ONCHAIN=1` restores the old behaviour, and the explicit
`activate`/`deactivate` commands still write on-chain unchanged.

947 tests. B1 is covered and mutation-checked. B2–B5 are not unit-covered — they are
process-lifecycle and interactive-TUI paths — and are flagged as such in the readiness
doc rather than implied to be verified.

## 2.17.2

**The over-limit buyer notice could never fire.** Round 9 found it missing on both
test jobs, and the cause was a design error in 2.16.0 rather than a bug in the code
that was written.

The worker's announcement runs on `dispute.rework_accepted`. But the
`respond-dispute` guard prevents the over-limit offer, so the buyer can never accept,
so that IPC never arrives — the two halves were **mutually exclusive**, and the notice
could only fire in exactly the scenario the guard makes impossible. Confirmed in the
logs: the `exceeds max` branch executed **zero** times across both jobs.

The dispatcher is the only side that knows a refusal happened, so the dispatcher now
posts the message when it refuses. A chat failure is logged and never blocks the
refusal. Verified live against a parked at-limit job.

The worker-side branch stays: it is still correct when an offer *was* made (a policy
raised mid-flight, or an operator override), it is just rarely reached now.

942 tests. This path remains outside unit coverage by nature — it needs a live
at-limit dispute — which is precisely why round 9 caught what unit tests could not.

## 2.17.1

**The dispute hold was defeated by the job clock.** 2.14.0 taught a worker to hold
itself open toward an open dispute's deadline — but it extended the post-delivery
*safety* timer only. `JOB_TIMEOUT_MS` is a separate, bare module-scope `setTimeout`
that is never cleared, so a worker that announced "Holding this worker open for 360
min" was killed at 60 anyway.

Observed live on `d22c9df5`: the worker announced the hold, hit
`⏰ Job timeout! Signing deletion attestation and exiting`, the reconciler respawned
it, each replacement died the same way, and after three attempts it gave up
**permanently** — leaving an open dispute with no worker and no respawn. Extending
one timer and not the other was the entire defect; the give-up then looked like a
job that "never progresses" when in fact we were killing it ourselves.

The hard timeout now defers while a dispute hold is active, re-arming for the
remaining time instead of exiting. The hold is bounded (`J41_DISPUTE_HOLD_MAX_MS`,
6 h default), so this cannot extend indefinitely.

942 tests.

## 2.17.0

**Bounty awards now sign the canonical message that binds the recipients.** The
platform verifies `/select` signatures as of its 2026-08-07 deploy (shadow mode now,
enforce once clients adopt it). Our signature would have failed: the SDK's
`buildSelectClaimantsMessage` produced `J41-BOUNTY-SELECT|…|Selected:<application row
ids>|…` — different prefix, different field, and substantively the wrong content.
Application row ids are opaque server primary keys a signer cannot independently
verify, so signing them commits to nothing.

`src/bounty-award.js` builds the canonical form binding the **sorted applicant
VerusIDs** — the actual recipients of the money. Sorted so collection order cannot
change the bytes, non-mutating because the caller reuses the array for the request
body, and it **throws on a UUID** rather than signing it: passing `app.id` where
`app.applicant_verus_id` was needed is the exact mistake the old message institutionalised,
and it would otherwise surface only on the day enforcement lands. The dashboard now
carries both ids through the selection UI and refuses to sign an award whose
recipients it cannot name.

942 tests; the sort, the row-id guard and the non-mutation are each mutation-checked.

## 2.16.0

Round 8 passed all three retests — bounty `/select` and its award→job handoff, the
`23505` fix (a second dispute now reopens the same row and returns 200), and the
happy-path regression. Two defects it exposed are fixed here.

### The rework-cycle limit failed silently, and the seller paid for it

The operator offered a **third** rework against a policy of 2. The buyer accepted,
the platform moved the job to `rework`, and the worker declined internally with a
bare `console.log` — telling nobody. The job dead-ended awaiting a delivery that was
never coming, and because the dispute's `deadline_owner` is the **seller**, the SLA
resolver would have auto-defaulted the agent **for honouring its own published
policy**. Silence was the whole bug.

Two halves were wrong and nothing checked between them:

- **The worker now announces.** On exceeding the limit it tells the buyer in chat,
  logs an `ACTION NEEDED` line naming the exact escalation command, and fires an
  `onReworkLimitReached` handler hook. It deliberately does **not** decide the money —
  refund, reject or renegotiate stays the operator's call — but the operator now
  learns about it before the deadline runs.
- **`respond-dispute` refuses to promise what the worker will refuse.** It reads the
  agent's on-chain `maxReworkCycles` and blocks an over-limit rework offer, pointing
  at the escalation command instead.

### The cycle counter could not survive a worker respawn

It lived only inside the container, so it reset to zero whenever that worker was
replaced — and since 2.14.0 a dispute can outlive its worker, making respawns between
cycles normal. Round 8 did not expose this only because the container happened to
survive. Cycle counts are now recorded seller-side in `rework-cycles.json` (atomic
write, corrupt-tolerant, per job), which is durable across restarts and worker deaths
and counts the thing that actually matters: what we have promised.

**Not unit-covered:** the buyer-facing notice itself lives in the post-delivery IPC
handler and is not reachable from a unit test without a refactor. The counter and the
guard arithmetic are covered and mutation-checked; the notice will be confirmed on the
next live cycle-limit hit.

936 tests.

## 2.15.1

**Rework can ask for a budget extension again.** The platform's 2026-08-07 deploy
allows extensions while a job is in `rework`; both the create and approve endpoints
previously allowlisted only `in_progress`/`paused`, so the request could never be
granted and 2.13.1 stopped making it. A rework capped at ~30% of the original budget
is exactly the case that runs short — and "your answer was too shallow" is a
complaint that needs *more* output — so asking again is now correct.

The test covering this was **vacuous**: it mocked `agent.requestExtension`, a method
nothing in the code calls, so it passed no matter what the code did. It now asserts
on `_lastExtensionAttemptAt`, which is set before any pricing lookup, proving the
attempt happened without depending on a configured VRSC/USD rate.

927 tests.

## 2.15.0

Round 7 confirmed the multi-day dispute fix from the buyer seat: a dispute raised at
19:59, accepted 15 minutes later after the original worker had exited, was served by
a **freshly respawned worker** and posted a complete 3,716-character answer to chat.
That path was structurally broken until 2.14.0.

Two fixes from what round 7 exposed:

**A job that can never progress is now abandoned loudly.** The platform's
second-dispute insert failed on a unique constraint (Postgres `23505`) but moved the
job to `disputed` anyway — so it reported disputed with no dispute record behind it,
and nothing could ever resolve it. Our sweep respawned a worker for it **14 times**.
Retrying forever is a resource leak that scales with the fleet, not resilience. A job
is now respawned at most `MAX_RECONCILE_ATTEMPTS_PER_JOB` (3) times, after which it is
reported once, counted as `stuck` in the sweep summary, and emitted as
`dispute.reconcile_gave_up` — and it never starves new work.

**`J41_DISPUTE_HOLD_MAX_MS` silently did nothing.** It is read by `job-agent.js`,
which runs *inside* the container, but was only ever set on the dispatcher process —
so the knob added in 2.14.0 had no effect and a worker always used the 6-hour
default. Now forwarded into the container env when set.

926 tests.

## 2.14.5

An agent listed in the shutdown marker that was **already active** at the next start
needed no restoring — but it was never removed from the marker either, so the entry
persisted indefinitely. A later deliberate `j41-dispatcher deactivate` on that agent
would then be silently undone by the following start, which is exactly the operator
intent the marker exists to respect. Already-active agents now count as handled.

923 tests.

## 2.14.4

**The reconciler treated every historical dispute as actionable.** `getMyJobs` list
items do not carry a nested `dispute` object, so the "unanswered and inside its
deadline" rule from 2.14.1 saw `{}` for all of them and defaulted to open. Live,
that classified 24 months-old outage jobs as actionable — already sitting in the
operator's refund-approval queue, where no worker can advance them — and respawned
3 per poll cycle indefinitely. 2.14.1's cap turned a thundering herd into a slow
drip; it did not stop it.

A job with a refund-ledger entry is now never respawned: it is awaiting a human
approval step and is the operator's, not a worker's. The ledger is read once per
sweep, not per job.

923 tests.

## 2.14.3

**The test suite deleted live dispatcher state.** `test/dispute-ownership.test.js`
called the shutdown-marker helpers without a path, and their default is the real
`~/.j41/dispatcher/shutdown-deactivated.json`. Running the suite beside a live
dispatcher destroyed the marker — caught here when a restart silently failed to
restore three agents because a test run had removed the record of them between the
shutdown that wrote it and the start that would have read it.

The helpers now take an explicit path (defaulting to the live one) and every test
passes a temp directory, with a pin asserting the default is the live path and the
tests' is not. No behaviour change for the dispatcher itself.

920 tests.

## 2.14.2

**Shutdown never told its workers to leave.** `type: 'shutdown'` was sent from
nowhere in `cli.js`, so both of the container's shutdown handlers — one that
delivers current work mid-job, one that ends a post-delivery wait — had never once
run. The drain simply *waited* for containers that had no reason to exit, until it
timed out and the jobs were refunded.

That was survivable while a post-delivery worker died at ~90 minutes. It stopped
being survivable in 2.14.0, which holds a worker open toward a dispute deadline
(up to 6 h) — a single disputed job would then block shutdown until the 120-minute
drain timeout and get refunded. Observed live: a drain sat at 140s on one parked
dispute worker with nothing to wait for.

Shutdown now signals every active worker at drain start. It is graceful, not a
kill: a mid-job worker delivers its current work first.

**And the post-delivery handler was unreachable in Docker.** `handleIpcMessage`
consumes `shutdown` before the `default:` branch that forwards to the
post-delivery waiter, so a worker parked on a dispute was deaf to shutdown even
once it was sent. It now forwards explicitly; `safeResolve` keeps it idempotent.

919 tests.

## 2.14.1

Fixes two defects **introduced by 2.14.0**, both caught on its own first live start.

**The reconciler was a thundering herd.** Its first sweep respawned a container for
*every* historical dispute on the account — twelve at once here, including
months-old jobs already sitting in the operator's refund-approval queue, which no
worker can do anything about. The sweep now respawns only where a worker could
actually act: `rework` always; `disputed` only while the dispute is **unanswered
and inside its deadline**. A missing deadline still counts as open — refusing to act
on absent data would silently recreate the hole the sweep exists to close. Respawns
are capped per sweep (3), and anything deferred is **reported and retried next
cycle**, never silently dropped.

**Reactivating a restored agent double-wrote it on-chain.** `start` already
activates every ready agent; the platform-status gate was the only thing keeping
shutdown-deactivated agents out of that list. 2.14.0 also activated them *in the
gate*, so each restored agent broadcast two identity transactions against the same
confirmed `prevOutput` and the second was rejected (`-25`) — the exact double-spend
class this release exists to prevent. The gate now only lets the agent through.

Also: the orphaned-steal-gate lock test asserted `winners === 1` per round, which
conflated a **lock breach** (>1 — two processes would each broadcast a refund) with
**starvation** (0 — a round where nobody got through, which happens legitimately
when the full suite runs 12 processes under CPU contention). Safety is now asserted
absolutely per round; liveness across rounds. Verified still to catch a real breach
by making the steal gate non-exclusive.

919 tests.

## 2.14.0

Two full-path reviews — the dispute/rework path and the daemon lifecycle — read as
whole systems rather than as diffs. Every defect below lived in a **seam** between
components, which is why three rounds of diff-level review passed while the path
kept breaking.

### Nobody owned a disputed job once its worker exited

A dispute deadline is **days**. A worker's post-delivery hold was ~90 minutes.
`pollForJobs` keeps only `requested|accepted|in_progress`, and the post-delivery
transition check iterates `state.active` — which by definition no longer holds a
job whose container died. So a dispute filed after that gap was invisible to the
entire dispatcher: no surface, no respawn, no operator alert, and the deadline
lapsed on the platform's default terms. Every test to date passed only because the
buyer happened to act inside the 90 minutes.

- New `reconcileOrphanedDisputes` sweep owns `disputed`/`rework` jobs that have no
  live worker, respawning through the same entry point the webhook uses. Skips jobs
  that already have a worker or are queued for capacity; one unreachable agent
  never aborts the fleet-wide sweep.
- The worker now holds itself open toward the **real dispute deadline** instead of
  dying at the review timeout — bounded by `J41_DISPUTE_HOLD_MAX_MS` (default 6 h),
  because one container per disputed job for days does not scale. After the cap it
  exits and the dispatcher owns it.
- `isPostDeliveryReconnect` now includes **`rework`** (plus `resolved`,
  `resolved_rejected`). Its absence meant a container spawned for a job already in
  rework fell through to `acceptJob`, hit the retry wall, and made the dispatcher
  queue a **refund for a job that had both a delivery and a seller-agreed rework**.
- A fresh container clears `_lastSentStatus` for its job. That guard outlived the
  process it described, so a respawned worker was never told the job was in
  `rework` — the message had "already been sent" to a process that no longer existed.

### The chat fix shipped in 2.13.1 was incomplete

`ensureChatConnected` gated on `isConnected`, but a post-delivery **respawn** calls
`connectChat()` whose auto-join covers only `accepted` + `in_progress` jobs — a
disputed job is neither. The socket was connected, the guard short-circuited, and
the rework was emitted into a room the agent had never joined. `sendMessage` is an
ack-less socket emit, so nothing threw and every log line read healthy. Now checks
**room membership**, not connectivity, and falls back to per-process join tracking
on SDK versions that do not expose `joinedRooms` — never to "assume joined" (silent
loss) or "always join" (duplicate messages). `surfaceDispute` had the identical
hole and is fixed with it.

### The rework chat post bypassed the canary check

Every other outbound reply goes through `checkCanaryLeak`; this one did not, and the
SDK's own guard is inert because `enableCanaryProtection()` is never called. The
rework instruction is **buyer-authored** (`dispute.reason`), so this was the
prompt-injection path, unguarded, while the deliverable copy was dutifully stripped.

### Shutdown deactivated the fleet and start never restored it

`gracefulShutdown` sets every agent inactive on the platform *and* on-chain; `start`
skipped inactive agents and exited with `No agents registered. Run: register …` —
sending the operator to re-registration, which is wrong and pays for on-chain
writes. A routine stop/start lost the whole fleet.

Shutdown now records exactly which agents **it** deactivated (atomic write, before
the drain, so a `kill -9` mid-drain still leaves the marker), and start restores
those and only those — an agent the operator deactivated deliberately stays off.
The dead-end error message now names the real remedy and explicitly warns against
re-registering.

### The 30-second shutdown watchdog force-exited healthy work

`HARD_EXIT_MS` was a wall-clock deadline while `drainTimeoutMs` is **120 minutes**,
so every drain longer than 30s was killed, its containers orphaned and their jobs
refunded on next start. It also fired mid-deactivate-loop — ~3 network calls plus an
on-chain tx per agent — leaving some agents active and some inactive, which is the
mechanism behind "the restart lost my fleet, but only sometimes". It is now a
**stall detector**: each step kicks it, so no-progress-for-30s still force-exits,
which is what it was actually for.

### `start` raced the dispatcher it had just killed

It SIGTERMed the old pid and waited a flat **1 second** while the old process ran its
full shutdown. Concurrently: its deactivate loop flipped agents inactive while our
startup read them (a second, independent cause of the fleet loss); our crash recovery
read `active-jobs.json`, still listing its **draining** jobs, and killed those
containers and queued refunds for work about to deliver; and both processes broadcast
identity transactions against the same confirmed `prevOutput`. `start` now waits for
the old daemon to actually exit and **refuses to start a second dispatcher** rather
than proceeding into that state. The exit handler also no longer deletes a pid file
that belongs to its successor.

### Six webhook handlers could not reach a Docker container

`dispute.resolved`, `dispute.rework_accepted`, `job.completed`, `end_session_request`,
`workspace.ready` and `workspace.disconnected/completed` all gated on
`activeInfo.process?.send` — the **local-fork-only** channel. A Docker worker has
`.container`, never `.process`, so every one was silently dropped while the handler's
own log line reported success. Same defect class as `dispute_policy`, which was
migrated to `sendToJobAgent()` while these were missed. In webhook mode, rework never
ran at all.

910 tests (892 before). Every fix above is mutation-checked.

## 2.13.1

**The rework answer still could not be read in full.** 2.13.0's re-test confirmed
generation and delivery were fixed — the deliverable carried a real hazards table
instead of a transcript — but chat stayed silent, and since the platform caps a
stored deliverable at **200 characters**, chat is the only uncapped channel. The
buyer could read the intro and one table header row; the packing list and
entry/exit times were unreachable.

**The chat socket does not survive the dispute window.** A dispute deadline is
days long. The container logged `[CHAT] Disconnected: transport close` then
`[CHAT] Connection error: Authentication required` — the session token expired
mid-window — so `sendChatMessage` threw `Chat not connected` and 2.13.0's guard
correctly degraded to the deliverable. The guard worked; the socket was the
problem. Chat is now re-authenticated and reconnected before the rework is posted.

**A reconnected socket would still have reached nobody.** `connectChat()`
auto-joins only the seller's `accepted` and `in_progress` job rooms. A job under
dispute or rework is neither, so a fresh socket is connected but not in the room.
The room is now joined explicitly — and *only* on a fresh connect, because
re-joining a room on a live socket duplicates every message.

**Rework no longer requests a budget extension it cannot get.** The 30% rework
grant hit 93% on the re-test and fired an extension request that the platform
refused with `Job must be in_progress or paused` — a job under rework is neither,
so the request had never once been grantable. It now logs the ceiling honestly
(`rework cannot be extended, the answer may be cut short`) instead of a misleading
failure. **The underlying limit stands: a rework that needs more than its share
will be cut short**, and that needs a platform-side answer, not a client one.

892 tests (887 before). The reconnect, the explicit join, and the
don't-re-join-a-live-socket guard are each mutation-checked.

## 2.13.0

**Dispute → rework produced nothing, for three stacked reasons.** The round-6
tester pulled the two fields we could not see — `delivery.message` (the stored
deliverable, hard-capped at 200 chars) and `messages[]` — and proved the concrete
reworked content existed in **neither**. It was never generated.

**The rework token budget was granted as an absolute ceiling.** `setBudget()`
installs a ceiling that `isBudgetExhausted()` compares against
`_tokenUsage.totalTokens`, which is cumulative for the executor's life and is
**never reset**. `resumeJob` passed the rework share straight in, so "30% of the
job for rework" actually meant *"the whole job may now use 30% of its budget"* —
and the original job has already spent most of it. On any job that used more than
its rework share the gate tripped **before the first rework token**: no LLM call,
no answer, and the executor returned its budget-exhausted line. Now offset by
current usage, granting a genuine fresh allowance.

This was **latent until 2.12.3 armed it.** `dispute_policy` never reached any
Docker container, so `tokenBudget` was null and `setBudget` was never called
during rework. Shipping 2.12.3's IPC fix alone would have converted an unmetered
rework into a permanently gated one — the fallback path would have engaged every
time. Two of these fixes had to ship together or neither was safe.

**`resumeJob` computed the reworked answer and threw it away.** It returned
`executor.finalize()` — the entire conversation rendered `user:` / `assistant:`
and hashed. Since the platform stores only the first 200 characters, what the
buyer saw as their "reworked" deliverable was the **start of the original
conversation**. Now delivers the answer, falling back to the transcript only when
the reply is unusable (empty, the llmBusy ack, or budget-gated) — a clumsy
deliverable beats an empty one.

**The rework was never posted to chat.** The content went only into the
deliverable, so a buyer asking "did you redo it?" got silence and the job
auto-completed. Now posted via `sendChatChunked`; a chat failure is logged and
does not discard the deliverable.

New `test/rework-delivery.test.js` drives `resumeJob` against the real `Executor`
base class, so the budget arithmetic under test is the arithmetic that ships. All
three fixes mutation-checked. 887 tests (881 before).

Also: the send-lock race test was flaky 2 runs in 6, and the cause was the test —
`await new Promise(() => {})` does not keep Node alive, so the winning racer
exited, its lock went stale (dead pid), and the next racer *legitimately* stole
it. Now holds with a live handle. 6/6 clean, and reverting the empty-lock guard
still fails 2 tests, so determinism did not cost it teeth.

## 2.12.3

Three defects found by auditing the round-6 fix plan **before executing it** —
including one in 2.12.2's own fix.

**2.12.2 would have left the buyer silently unpaid anyway.** `sweepDisputesForRefund`
called `respondToDispute` unconditionally for every selected job, including the
seller-agreed ones 2.12.2 had just taught it to select. For a dispute already at
`action: 'refund'` that means responding again to a resolved dispute — which
either fails, hits `continue`, and **never writes the ledger entry** (buyer never
paid, retried and re-failed every 5 minutes, no signal), or succeeds and
overwrites the operator's own human-authored response with a canned outage
apology while forcing 100% over any agreed partial. The sweep now responds only
when the seller has **not** already answered; an agreed dispute goes straight to
the approval queue. 2.12.2's claim that seller-agreed refunds reach the owner was
therefore premature — this is what makes it true.

**`dispute_policy` never reached any Docker container.** It is sent with
`child.send()` — Node fork IPC, which a Docker container does not have — so
`_disputePolicy` was null in every production container. Two things silently did
not work: the rework token budget (30% share) never applied, and the
`maxReworkCycles` guard was inert, making rework cycles **unbounded and
unmetered**. Now delivered over the file-IPC channel the container already
listens on, and a failure to deliver is logged rather than swallowed. (The
earlier diagnosis blamed `fullJob` scope — wrong suspect; `fullJob` is in scope
fine.)

**A stripped canary left the signed delivery hash wrong.** `finalize()` hashes
the content, then the canary is stripped *afterwards* — so whenever a canary
appeared in a deliverable, the hash signed by `signDeliver` and submitted to the
platform committed to text the buyer never receives. The hash is now recomputed
after stripping, on both the delivery and rework paths.

Ruled **safe** by the same audit, and worth recording so it is not re-litigated:
changing the deliverable format is **not** a breaking cryptographic change.
`deliveryHash` is computed fresh per delivery, signed, submitted, and never
recomputed or compared afterwards; `verifyInboxJobRecord` binds `jobHash`, not
`deliveryHash`, and the witnessed `job_record` schema does not contain it.
Historical delivery hashes are inert.

881 tests.

## 2.12.2

**Agreeing to a refund was the thing that guaranteed nobody paid it.** Found live
during a tester run, on job `b09440f5`.

A buyer cancelled mid-flight and asked for a refund. The seller responded
`refund`, 100% — which the platform recorded, and which the buyer can see. Then
nothing happened, and nothing ever would have:

```
sweep picks it up BEFORE the response (action=pending): true
sweep picks it up AFTER  the response (action=refund) : false
```

`selectRefundableDisputes` required `action === 'pending'`. Responding `refund`
moves the dispute out of `pending`, so the act of agreeing to pay is precisely
what removed the job from the queue the operator approves from. There was no
manual route either — `refunds approve` only works on queued entries, and
`wallet send` is fleet-internal by design and refuses a buyer address. The
obligation existed on the platform, was visible to the buyer, and was invisible
to every automated and manual path on our side.

That also explains the July batch: the nine outage refunds needed a bespoke
out-of-band script because seller-agreed refunds never enter the queue at all.

The sweep now recognises **two** distinct obligations:

- **Unanswered** — platform auto-opened, seller silent, buyer demonstrably got
  nothing (no delivery, no tokens). Deliberately narrow, unchanged.
- **Seller-agreed** — the seller answered `refund` and no `refund_txid` exists.
  Delivery and token usage are irrelevant here: the seller has explicitly said
  they owe it, and explicit consent outranks the heuristics.

**A partial refund would have paid double.** `buildDisputeRefundEntry` hardcoded
`refundPercent: 100` and `refundAmount: job.amount`. A seller agreeing to 50%
would have had the full amount queued. It now honours the agreed percentage, and
refuses to queue at all on a malformed one rather than guessing.

Also guarded: a dispute carrying a `refund_txid` is **never** re-queued — the
txid is the proof of payment, and re-queueing is how you pay twice.

Not fixed, recorded: there is **no refunds screen in the TUI** — approval is
CLI-only (`refunds list` / `refunds approve`). `dashboard.js` contains no refund
handling of any kind.

881 tests (873 before).

## 2.12.1

Post-audit again. **The refund failure split — 2.11.7's fix for the previous
audit's blocking finding — shipped with no test coverage at all.** Mutating
`if (isFundingFailure(e))` to `true` (always clear the marker, destroying the
double-pay protection) and to `false` (never clear, reintroducing the wedge)
each left **all 866 tests passing**.

That is the second time in two days the same money fix has shipped guarded by a
test that could not fail. The earlier test asserted on `classifyInboxFailure` and
then called the marker helpers by hand — it tested `fs.unlinkSync`, not the
branch. Replaced with integration tests that drive the real
`attemptPendingRefund` through the `_testAgentSession` seam and make
`sendCurrency` throw, which is the only way to reach that catch. Both mutations
now fail.

**Writing that test immediately caught a live bug.** `isFundingFailure` did not
match `'No UTXOs available — wallet is empty'` (SDK `agent.ts:2476`, and two
sibling wordings), so the **commonest total-drain case** — an agent with nothing
at all — took the ambiguous branch: refund blocked, operator told to verify
on-chain and unblock, for a send that never built a transaction. Fails safe, but
recreates by hand the wedge this release exists to remove.

**An existing test was pinning the buggy behaviour.** `inbox-batch-dispatch`
used `'no UTXOs available for TX fee'` as its example of an *escalating* failure
— which is literally what the SDK throws for an empty wallet. It only passed
because that wording was unmatched, meaning a dry wallet was silently striking
healthy inbox items. Corrected, and a companion test now pins that **no** wording
of "cannot pay the fee" ever escalates.

Also fixed:
- **A zero-length lock file wedged an agent permanently.** 2.11.8 correctly
  stopped treating an empty lock as stale (it is mid-creation) — but "mid-write"
  lasts microseconds, and an empty lock left by a crash or an `ENOSPC` has no pid
  to prove dead and no timestamp to age out. Now bounded by mtime.
- **Auth backoff missed hang-mode outages.** The SDK's own auth timeout is
  `J41Error('Login timed out…', 'TIMEOUT', 408)`; none of 408, `TIMEOUT`,
  `timed out`, `ECONNRESET` or `ENOTFOUND` matched, so a platform that accepts
  connections and never answers got **zero** backoff plus the actively wrong log
  *"authentication rejected … will not resolve on its own"*.
- The ambiguous branch no longer claims a refund is blocked when the failure
  happened **before** the marker was written (auth backoff, missing agent,
  allowlist) — during an outage that fired for every approved refund.
- `refunds unblock` now takes the send lock, and **refuses `--yes`**: that flag
  would assert the operator checked the chain, which a flag cannot do.
- Orphan markers — an in-flight marker whose ledger entry is gone — are now
  listed. They were invisible, and they are the only record that a payment may
  have happened.
- The 2026-07-31 outage figures did not reconcile (~908 failures vs "43/min for
  46 min" ⇒ ~1978). Only the observed figures are now claimed.

873 tests (866 before).

## 2.12.0

**Back off when the platform is down.** The last open round-3 finding, and the
only one that was never fixed.

On 2026-07-31 a fleet-wide `503 CHAIN_SYNCING` outage produced **~908 auth
failures**, until the platform answered `429 Too many requests`.
`getAgentSession` calls `authenticate()` with no backoff and never caches a
failed session, so every caller re-authenticated every cycle. (An earlier note
of "~43 calls/min for 46 min" does not reconcile with the 908 figure and is not
repeated here — the failures and the 429 are what was observed.) We turned their degradation into our rate-limit ban, and the 429
outlasted the 503 that caused it. This recurs daily around 04:00 UTC.

`src/auth-backoff.js` — pure, no I/O, no clock — with exponential backoff from
5s, jittered ±25%, capped at 5 minutes.

The property that matters is not the percentage, it is that **the call count
stops depending on how many callers there are**. Modelled over a 46-minute
outage with 9 agents:

| caller attempts/min | without backoff | with backoff |
|---|---|---|
| 1 | 414 | 118 |
| 5 | 2,070 | 126 |
| 20 | 8,280 | 133 |
| 60 | 24,840 | 133 |

The baseline grows 60x; the actual calls stay flat, because the schedule bounds
them. At the observed rate that is ~94% suppressed, and it can no longer
escalate into a 429.

Two deliberate limits:
- **The 5-minute cap is a recovery guarantee, not politeness.** The daily window
  is ~50 minutes; an uncapped exponential would still be asleep an hour after the
  platform came back. Capped, it probes ~10 times across an outage and never
  leaves the fleet idle more than 5 minutes after recovery.
- **It only waits for failures that end by themselves** — 5xx, 429,
  `CHAIN_SYNCING`, connection errors. A 401 or a malformed identity fails loudly
  every cycle, because backing off there would hide a misconfiguration behind a
  slow retry loop, which is the silent-failure pattern this codebase keeps
  getting bitten by.

Jitter is load-bearing rather than decorative: the outage hits every agent at
once, so without it the fleet retries in lockstep and reproduces the burst that
earned the 429, just less often.

A server-supplied `Retry-After` is obeyed and clamped. The gate **fails open** on
a malformed record — one wasted request is recoverable, a dispatcher that
silently stops is not. `/health` gains `auth_backoff_agents`, because an outage
the operator cannot see is indistinguishable from a hang.

**The other three round-3 defects were already fixed and proven live in round 4**
— deletion attestation via the JCS path (`job-agent-teardown.js`), the `getJob`
startup retry, broker-mode review deferral, and canary release. Verified in the
source rather than assumed before writing this.

866 tests (854 before).

## 2.11.8

**Stealing a lock that was in the act of being created.** Closing the last audit
finding — reclaiming an orphaned *steal gate* still used unlink-then-create, the
exact non-atomic pattern 2.11.3 condemned one layer down. Fixing that surfaced a
worse defect underneath it.

`openSync(lockPath, 'wx')` creates the file; `writeSync` fills it a moment later.
A contender reading in that gap sees `''` — and an empty lock was classified as
**stale**, because `parseInt('')` is `NaN`, which fell through to the timestamp
branch where `!NaN` is `true`. So a process could steal a lock that another
process was in the middle of creating. An empty lock is the *youngest possible*
lock, not an old one.

Found by instrumenting the race harness to print which pid each winner's own lock
file named: one winner's lock named somebody else. Analysis alone had not found
it — two rounds of reasoning about the interleaving were wrong before the data
settled it.

Also in this pass:
- The gate is reclaimed only when its owner is provably **dead** (`kill(pid, 0)`),
  never merely old — "dead" is stable, "old" flips and can be misjudged.
- Reclaim is now `rename`-claim plus `O_EXCL` acquire, so exactly one contender
  proceeds and a third that legitimately grabs the freed path wins instead.
- A lock read failing with anything other than `ENOENT` no longer counts as free.
  Doubt does not license taking a money lock.
- A final ownership check before returning: a caller that broadcasts while
  another process owns the lock is the entire failure mode.

Measured after the fix: **0 bad rounds in 45** on the orphaned-gate path (12
racers), 0 in 30 on the original stale-lock path (16 racers), 0 live holders
robbed in 10.

**One honest note on the tests.** The race harness pins the behaviour but does
*not* guard this fix — the defect fired roughly twice in 45 rounds, and
mutation-testing confirmed the race test still passes with the fix removed. The
guard is a deterministic unit test that seeds an empty lock file directly; that
one does fail when the fix is reverted.

854 tests (850 before).

## 2.11.7

Post-audit fixes. The audit of the day's work found that **one of yesterday's
fixes had introduced a regression, and the test guarding it proved nothing.**

**A failed refund send was wedged forever (regression from 2.11.2).** The
pre-broadcast intent marker was written before `sendCurrency` and cleared only on
success — so *any* throw left it behind. A dry fee tank during a drain, which
this fleet has had, permanently converted an owed refund into an unpaid one. Both
log messages were false: the catch promised "will retry on next start" (it could
not) and the drain reported the process had died (it had not). `refunds approve`
could not unwedge it either, because the entry was already `approved`.

Failures are now split by what they can prove:
- **pre-broadcast** (an empty fee tank — `sendCurrency` fails while building, so
  nothing left the host): marker cleared, retried on the next drain
- **ambiguous** (timeout, dropped connection — the broadcast may have landed):
  marker kept and annotated with the error, because paying again to resolve the
  doubt is the one outcome that cannot be undone

**A blocked refund is now visible.** It was `approved`, so the default
`refunds list` filtered it out and printed *"No pending refunds"* while money was
stuck — the only signal was a log line every five minutes. Blocked entries now
head the list with amount, payee, last error and the exact command to resolve
them, and are marked `BLOCKED-inflight` in the status column. New
`refunds unblock <job-id>`: deliberately manual, deliberately loud, and it makes
you type `yes` after confirming on-chain that the money never arrived. `--yes`
is refused outright — a flag cannot stand in for having looked at the chain.

**The test for all of this asserted nothing.** It wired `state._testAttemptRefund`
— a hook that does not exist in `src/cli.js` — so the array it inspected could
never be populated and the test passed with the marker check deleted. Replaced
with assertions against the drain's real output and the surviving ledger, and
**mutation-tested**: removing the marker filter, or re-hiding blocked entries from
the list, each fails a test.

**Two of three rows in my scale table were wrong.** Because the poll budget grows
1s per agent while cost grows `500ms + round-trip`, a round trip at or under
500ms **never** overruns at any agent count. My "250ms → ~90 agents" and
"500ms → ~60 agents" came from solving against a fixed 60s budget and ignoring
the scaling. The table now states the real model: it is a latency question, not
an agent-count question.

**Also:** one corrupt `keys.json` no longer aborts `encryptAllKeys` mid-pool
(which in the new-passphrase path manufactured the exact half-encrypted state
2.11.4 fixed); an unreadable in-flight marker fails **closed** rather than reading
as "no marker" and paying; and `acquireSendLock` refuses a missing or malformed
job id instead of creating one shared `undefined.lock` that serialises unrelated
sends while failing to serialise identical ones.

850 tests (844 before).

## 2.11.6

TUI pass (plan 2). The valuable half was automated; the rest is an honest manual
checklist rather than a flaky test.

**The Earnings screen's arithmetic is now testable.** It lived inline in
`dashboard.js`, which runs `main()` on require and drives Inquirer against a TTY
— so it could not be imported under `node --test` and was untestable *by
construction*. A wrong number on the money screen would have shown forever with
no suite noticing. Extracted to `buildEarningsRow()` in `src/wallet.js`, beside
`buildWalletRow`; `dashboard.js` keeps only layout. 13 tests.

**Earnings were being rounded away.** `toFixed(2)` displayed a real 0.005
VRSCTEST job as `0.01`, and anything under half a cent as `0.00` — earnings shown
as nothing. Agent prices here are routinely in the thousandths, so two decimals
was the wrong resolution. Now 8dp with trailing zeros trimmed, matching the tank
figure beside it. Found by rendering a real fixture, not by review.

**The pty smoke test was attempted and abandoned.** The harness hung for two
minutes without rendering. A flaky test everyone learns to ignore is worse than a
documented manual step, and it would not have caught a wrong number anyway: in a
sandbox the agents are unregistered and unfunded, so every money path renders its
degraded branch and the assertion degenerates to `—` equals `—`.
`docs/testing/tui-manual-checklist.md` covers what automation cannot — including
that **[7] Start and [8] Stop act the moment Enter is pressed, with no
confirmation**, which the original plan had wrong.

844 tests (831 before).

## 2.11.5

Scale pass (plan 4). The finding is not a throughput number — it is that **a
dispatcher which cannot keep up looked completely healthy.**

Each loop guards against reentrancy, but two of the three returned **silently**
when the previous cycle was still running:

| loop | on overrun (before) |
|---|---|
| `pollForJobs` | silent — the fleet stops looking for work |
| `checkFeeTanks` | silent — tanks stop being watched |
| `checkPendingInbox` | warned |

The second is the dangerous one: a fee-tank check that quietly stops running is
exactly how agent-6 drained to zero and went silent on-chain on 2026-08-05.

Both now log with a running count, and both expose a counter on `/health`
(`poll_cycles_skipped`, `fee_tank_cycles_skipped`) — a log line nobody greps is
not observability. Skipped cycles deliberately do **not** mark the daemon
unhealthy: they are a capacity signal to tune, not a fault.

**Measured:** `checkFeeTanks` costs ~one API call per agent — 0.6s at 10 agents,
5.6s at 100 (50ms round trips), 50s at 100 (500ms), 151s at 100 (1.5s). Against a
30-minute interval the worst of those uses 8% of its budget. No practical ceiling.

**Corrected an unsubstantiated README claim.** It advertised "dynamic interval
scaling for 100+ agents". The poll loop's budget is only `max(60s, agents x 1s)`
while a cycle costs `(agents-1) x 500ms` of stagger plus a round trip per agent,
so overrun begins around 30 agents at a 1.5s round trip — not 100. A new
**Scale** section carries the numbers, and is explicit about which are measured
(the fee-tank table) and which are derived from the interval arithmetic (the poll
thresholds). Advertising a scale that has not been tested is itself a defect.

*(Corrected in 2.11.7: two rows of that derived table were wrong. Because the
budget grows 1s per agent while cost grows 500ms + round-trip, a round trip at or
under 500ms never overruns at any N — the 250ms and 500ms thresholds I published
came from solving against a fixed 60s budget and ignoring the scaling.)*

831 tests (827 before).

## 2.11.4

Fault-injection pass (plan 1). Three silent failures, all of the same shape: a
crash leaves the system in a state it then misreads as normal.

**A crash mid-write made the dispatcher forget every job it had completed.**
`seen-jobs.json` was written with a bare `writeFileSync`, so an interrupted write
truncated it — and `loadSeenJobs` read a corrupt file as an empty Map, exactly as
if this were a first run. `state.seen` is what stops an already-handled job being
picked up again, so the consequence is every previously-completed job looking new.
Writes are now atomic (temp + `rename`), and a corrupt file is reported loudly and
quarantined rather than silently replaced. Absent stays quiet — a first run is not
a fault.

**A corrupt `finalize-state.json` read as "never finalized".** Same
absent-vs-corrupt conflation, but the consequence is worse than amnesia: it can
send an operator back through a registration flow that writes on-chain and costs
money. It now names the agent and the file instead of quietly returning null.

**An interrupted `encrypt-keys` left WIFs in plaintext, permanently.** The command
writes `master-key.json` first and then re-encrypts each agent in turn. A crash
mid-loop leaves a master key present with some keys still in the clear — and the
command then *refused to run again* ("already encrypted"), so those keys stayed
plaintext forever while the operator believed the pool was protected.
`encryptAllKeys` was already resumable (it skips `v === 2`); only the guard was
wrong. `encrypt-keys` now detects stragglers, names them, unlocks with the
existing passphrase and finishes the job. Verified end to end against a real
master key: 1 encrypted / 2 plaintext → all 3 encrypted.

**Also verified rather than assumed:** the egress-proxy port collision that
blocked all scratch-daemon testing is real — `172.18.0.1:9847` (the bridge
gateway, not localhost) returns `EADDRINUSE` while a live daemon holds it, and
`J41_EGRESS_PROXY_PORT` resolves it.

**Honest limitation:** the remaining kill points (mid-broadcast, mid-inbox-batch,
mid-container) need a *registered* agent, which means chain writes and real
money. A scratch daemon exits at "no agents registered" before reaching them.
Those are documented as a manual procedure rather than automated, and the
money-critical one of the set — a crash between a refund broadcast and its
record — was already closed in 2.11.2 with a pre-broadcast intent marker.

827 tests (817 before).

## 2.11.3

**The send lock admitted many holders at once.** `acquireSendLock` guards
`attemptPendingRefund` — money to an external buyer address — and `wallet send`.
Racing 10 real processes at one stale lock produced **2-5 simultaneous
"winners" in 12 of 15 rounds**. Every one of them would have broadcast.

2.11.2 stopped a *live* holder being robbed. This is the other half: the steal
of a *dead* holder's lock was not atomic.

Three implementations were measured before one was correct:

| approach | rounds with >1 winner |
|---|---|
| unlink-then-exclusive-create (original) | 12/15, peak 5 |
| rename ours into place + read back | 15/15, peak 9 |
| rename the stale lock away | 15/20, peak 7 |
| **exclusive gate + re-check inside it** | **0/40, peak 1** |

All three failures shared one flaw: the staleness decision was made against the
*old* lock, then acted on whatever occupied the path by that point — frequently
a peer's fresh, live lock. Check one file, act on another.

The fix serialises the steal behind an `O_EXCL` gate file and **re-reads the
real lock inside the critical section**, so a contender whose peer already stole
it sees a live holder and stands down. The gate carries its own short staleness
bound so a crash inside it cannot wedge the agent, and an unreadable gate fails
**closed** — that last detail was worth ~1 bad round in 20 on its own, because
`stat` only fails there when a peer is mid-steal.

Verified with 640 racing processes across 40 rounds: **max winners seen, 1**.
Pinned by `test/send-lock-race.test.js`, which spawns real processes against a
shared start barrier — in-process sequential calls cannot reproduce this, and
that false negative is what let three broken versions look fine.

817 tests (815 before).

## 2.11.2

Two money bugs, found by adversarially reviewing a set of test plans **before**
executing them. Both would have been certified green by the tests as originally
designed.

**A live lock holder could be robbed mid-prompt, and both processes would
broadcast.** `acquireSendLock` stole any lock older than `REFUND_LOCK_STALE_MS`
(2 minutes). `wallet send` deliberately holds its lock *across the interactive
confirmation prompt*, so an operator who takes longer than two minutes to answer
`Send? (y/N)` looked identical to a crashed process: a second invocation stole
the lock and both broadcast. That is precisely the double-send the lock exists
to prevent, reachable by nothing more exotic than reading the prompt carefully.

The lock now tests whether the holder is **dead**, not whether it is **slow** —
`process.kill(pid, 0)`, with `EPERM` treated as alive. Age remains only as the
fallback for a lock whose owner cannot be identified. A live holder is never
robbed however long it takes; a dead one is reclaimed immediately instead of
after two minutes.

**A crash mid-refund sent the money twice, to an external address.**
`attemptPendingRefund` broadcast to a buyer address and *then* recorded it. A
kill between those two lines left the job `status: 'approved'`, so the next
startup drain sent a **second confirmed refund**. This is the only place in the
codebase where money can leave the fleet twice. The prior comment called the
window "a hardware fault between two syscalls" — it is not: any crash, OOM kill,
deploy or Ctrl-C reaches it.

Intent is now written **before** the broadcast and cleared after the send is
recorded. A marker found at drain time means "we may already have paid and
cannot tell", which is never resolved by paying again — the drain refuses,
names the address and amount, and asks for on-chain verification. Fail closed:
a false positive costs one manual check, a false negative is unrecoverable.

**`J41_EGRESS_PROXY_PORT`.** `EGRESS_PROXY_PORT` was a hard constant, and a bind
failure is fatal at startup, so a second dispatcher could not run on one host at
all — blocking fault-injection, scale and upgrade testing. Now overridable,
defaulting to 9847 and ignoring malformed values.

802 tests (798 before).

## 2.11.1

**Clean-room install testing + property tests for the money layer.** Everything
we had tested ran on a machine with nine configured agents, a populated
`~/.j41`, a built image and funded wallets. A new user has none of that, so we
installed 2.11.0 from npm into an empty HOME and drove it as a first-time
operator, then fuzzed every pure money function with ~120k adversarial inputs.

**Silent security failure in `encrypt-keys` (the clean-room find).** In a
non-TTY — a script, CI, `ssh host 'j41-dispatcher encrypt-keys'` — the command
printed its prompt, read nothing, **exited 0**, wrote no master key, and left
every WIF in plaintext. No error. An operator automating it would believe their
keys were encrypted at rest.

Root cause: `promptHidden` never settled on EOF, so the action abandoned
mid-`await` and the process exited before its own validation could run. The
check was correct; it simply never executed. `promptHidden` now resolves `null`
on a non-TTY or closed stdin, and `encrypt-keys`/`change-passphrase` refuse
up front with an explicit *"nothing was encrypted; your keys are still
plaintext"*. The interactive path is unchanged (verified through a pty).

**`Number.isFinite` was too weak a guard for money (the fuzzing finds).** `0.5`
and `1e21` are finite but are not valid satoshi counts, and every planner
accepted and propagated them — a fractional `remainingSats` rendered to an
operator, and sweep amounts past the range where integer arithmetic holds. Now
`Number.isSafeInteger` + non-negative in `summarizeUtxos`, `planFeeSweep`,
`planManualSweep`, `planFleetSend` and `summarizeFleet`. `writesAffordable`
returns 0 for non-finite input instead of `Infinity`.

**`classifyInboxFailure` and `isFundingFailure` could disagree.** An error whose
message said "insufficient funds" but which also carried `code: TX_REJECTED`
with an unrecognised detail classified `hard` while `isFundingFailure` returned
true — so the daemon logged `FEE TANK EMPTY` and struck the item toward a dead
letter in the same breath. Funding is now checked first, so the two cannot
diverge by construction.

`test/money-properties.test.js` (12 properties, ~120k cases, seeded PRNG so any
failure is reproducible) asserts the invariants rather than examples: parsing
never throws and never accepts an amount the SDK round-trip would alter; the
R/i buckets are always disjoint, finite and integral; an approved plan is always
arithmetically fundable; and **neither executor will sign or broadcast a
wrong-address-class input under any input at all**.

798 tests (786 before).

## 2.11.0

**Mainnet security gate: six missing bypass flags.** An audit asked why the gate's
list stopped where it did — `J41_DEPOSIT_ALLOW_AUTH_ONLY` was absent while being
exactly the class of flag it exists to catch. Auditing the rest of the env
surface found five more in the same position. All six now refuse a mainnet start:

| Flag | What it downgrades |
|---|---|
| `J41_DEPOSIT_ALLOW_AUTH_ONLY=1` | Credits deposits on signature auth alone — re-opens the self-credit risk closed by the 2026-06 audit (M-funds-1) |
| `J41_ALLOW_UNPRICED_JOBS=1` | Admits jobs with no payment record at all |
| `J41_SCAN_BUYER_CHAT=0` | Disables SovGuard scanning of inbound buyer messages |
| `J41_ALLOW_INSECURE=1` | Permits plaintext HTTP; credentials cross the wire in the clear |
| `J41_LOCAL_SIGNER_TEST_MODE=1` | Lets the local signer sign a deliver without the authoritative jobHash |
| `J41_TRUST_PLATFORM_RESOLUTION=1` | Trusts platform identity resolution instead of verifying locally |

The last three are SDK flags, checked here because the dispatcher's environment
is what gets forwarded into job containers.

`J41_PLATFORM_SIGNER` is deliberately **not** added: the SDK already refuses to
run on mainnet without the pin (audit H9), and a second copy of that rule would
only be a second place to forget it.

**Breaking on mainnet, by design.** A mainnet deployment currently setting any of
these will refuse to start until the flag is removed. That is the point — each
one loosens a default that exists because something went wrong once, and the
gate's job is to make "temporarily loosened for a debug session" impossible to
carry into production by accident. Testnet is unaffected.

Every flag is pinned in both directions: the bypass value blocks, and the safe
value does **not**. A gate that fires on a safe value teaches operators to
disable it.

786 tests.

## 2.10.0

**`wallet` — the manual money surface.** 2.9.0 made agents refill their own fee
tanks automatically, but an operator who saw `FEE TANK EMPTY and nothing to
sweep` still had no CLI path: no balance view anywhere (not in `inspect`,
`status`, `/health` or the TUI), no way to force a sweep, no way to fund an agent
that has never earned. Those operations were being done with hand-written
scripts. Now:

```
j41-dispatcher wallet                            # fleet tank table
j41-dispatcher wallet show <agent-id>            # addresses + per-UTXO detail
j41-dispatcher wallet sweep <agent-id>|--all     # force an i-to-R sweep
j41-dispatcher wallet send <from> <to> <amount>  # R-to-R between fleet agents
```

- `send` moves funds **between fleet agents only** — the destination is an
  agent-id resolved to that agent's own R-address. Raw addresses are refused: a
  typo'd destination on an irreversible transaction is the one mistake that
  actually loses money.
- Guards: reserve floor (a send may not leave the source under 100 writes
  without `--allow-drain`), self-send refusal, integer-only amount parsing, and
  a per-agent pending stamp that blocks a second spend until the first confirms
  (the platform serves the last *confirmed* UTXO view, so rebuilding from it
  double-spends). On mainnet, `send` refuses `--yes` and requires the amount to
  be retyped.
- Fee tanks now appear in `/health` per agent (`feeTank`) and on the TUI's
  Earnings screen. An empty tank does **not** degrade global `status` — an agent
  mid-onboarding legitimately has one.
- `null` vs `0` is preserved end to end: an agent that was never queried reports
  `—`/`null`, never `0`. Treating "we didn't look" as "the tank is empty" is how
  a second unnecessary transfer gets sent.

**Security fix — sweep destinations no longer trust the platform.** The sweep
took its destination as `u.address || keys.address`, *preferring* the platform's
`getUtxos()` response over local key material. Because `summarizeUtxos` decides
what is sweepable by comparing against that value, a wrong address reclassifies
every UTXO — R-address and i-address alike — as sweepable, the executor's
address-class guard passes (nothing matches), and the entire balance is signed
away to it. The daemon's auto-sweep broadcasts unattended every 30 minutes. The
benign variant is equally bad: an i-address returned here makes every sweep run
backwards, draining the fee tank and recreating the outage the sweep prevents.

Destinations are now derived from the WIF (`wifToAddress`) — the key that
actually signs — with the platform's value accepted only as corroboration and
any disagreement a hard refusal. Applied to the manual sweep, the daemon
auto-sweep, the send source, and the read path. This mirrors the SDK's existing
rule for identity updates, which already refuses a doctored API response.

**Other fixes from the same audit:** a per-agent lock so two concurrent CLI
invocations cannot both pass the stamp gate and double-spend; amounts capped at
2^50 satoshis, below the range where the SDK's `sats -> VRSC -> Math.round`
handoff is lossy (65,782 of the top 200,000 values under `MAX_SAFE_INTEGER` come
back off by 1-4 satoshis); `--all` and failed dry-run builds no longer exit 0;
`wallet show` resolves a pending stamp instead of reporting a confirmed tx as
pending; the TUI reuses the shared money formatter instead of a local one that
rendered `null` as `0.00000000`.

**Docs.** README's front page was a two-month-old security changelog instructing
new users to set four environment variables — one of which no longer exists, and
one of which (`J41_DISABLE_BWRAP=1`) the mainnet gate refuses to start with. That
block is gone; a fresh install requires no `J41_*` variables at all. Also
corrected: runtime default (`docker`, not `local`), 25 LLM presets (not 22), 26
VDXF keys (not 25, and `service.dispute` never existed), `IDLE_TIMEOUT_MS`
(480000, not 600000).

771 tests.

## 2.9.0

**Agents fund their own fees.** Job payments credit an agent's **i-address**;
identity-update fees are payable only from its **R-address**, so the R-address
only ever drained — at 0.0001/write — and nothing refilled it. An agent that ran
dry went silent on-chain (no reviews, attestations or job records) while still
holding unswept earnings. Observed live on agent-6, which dead-lettered three
valid inbox items for it.

- **`src/fee-tank.js` (new) — i→R sweep, on by default.** Checks every 30 min and
  sweeps when an agent can afford fewer than `floor_writes` (default 100) writes.
  **Self-funding by construction**: it pays its own fee out of the inputs it
  spends, so it works at a zero R-balance — which is exactly when it is needed.
  Refuses R-address inputs. Runs in both poll and webhook mode, with a startup
  pass so a dispatcher restarted *because* an agent ran dry does not stay dry for
  another half hour. Flags `--no-fee-sweep`, `--fee-sweep-floor <writes>`,
  `--fee-sweep-interval <minutes>`; `[fee_sweep]` in `config.toml`; env
  `J41_FEE_SWEEP`, `J41_FEE_SWEEP_FLOOR`, `J41_FEE_SWEEP_INTERVAL_MS`. See
  README → "Wallets & Fee Tank".
- **The `_MS` suffix on the interval env var is load-bearing.** The CLI flag takes
  **minutes**; the config/env value takes **milliseconds**. An unsuffixed name
  invited `=30` meaning 30 minutes, which would have landed as 30 ms and clamped
  to a 1-minute cadence — 30× the fleet-wide `getUtxos`/auth traffic.
- **`J41_FEE_SWEEP=true` silently disabled the sweep.** The `bool1` override kind
  is `raw === '1'`. Default-ON safety features now use a word-tolerant `bool`.
- **A dry fee tank no longer dead-letters valid work.** The SDK throws it as a
  bare `Error` — no code, no statusCode — so `inbox-deadletter.js` classified it
  `hard` and burned the per-item dead-letter budget. It is now `transient`, with
  `isFundingFailure()` giving the operator the address and the remedy instead of
  a generic batch-failure line. The legacy non-batched inbox path exempted only
  `contention`, so it reproduced the incident verbatim wherever
  `acceptInboxBatch` is unavailable; it now exempts everything but `hard`.
- **Fee alerts retract.** Two different prefixes described one condition and
  nothing cleared `_agentErrors` but a successful activation. Unified, cleared on
  tank recovery and on batch success, prefix-scoped so it cannot erase another
  subsystem's error. Funding failures now also reach the control-API event ring.

An agent that has **never earned** cannot self-fund — it logs `FEE TANK EMPTY and
nothing to sweep — fund <R-addr> externally` and needs a one-time operator
transfer to its R-address.

## 2.8.2

**Container teardown is now observable.** Requires the rebuilt `j41/job-agent` image.

- **Canary release logs its outcome.** It returned a bare boolean and logged nothing, so a
  teardown could not be told to have released the SovGuard canary or failed to. All three
  teardown paths now log, and the four outcomes are distinguishable — critically, a platform
  outage reads as `lookup failed: <err>` rather than `no registration found`, which would have
  sent an operator hunting a registration bug during an outage.
- **A skipped release is stated.** The release sits inside the same `try` as the attestation,
  so an attestation throw skipped it wordlessly — on the path most likely to be broken.
- **Startup build stamp** — `Build: job-agent 2.3.0 | SDK 2.14.1`. Establishing which code ran
  in a given container previously required a docker-events dig, because the old and new
  teardown paths emit an identical success string.

## 2.8.1

**All agents now load their on-chain dispute policy.** Requires
`@junction41/sovagent-sdk@2.14.1`.

5 of 9 agents logged `no dispute policy on-chain — disputes will log only` even
though the flat `agent.disputePolicy` key was present and well-formed on every
one of them. The SDK misdetected any pre-2026-03-28 identity as legacy-format —
the legacy parent key never disappears from the aggregated `getMyIdentity` view —
and the legacy decoder does not know the flat keys. Their `displayName` was
dropped the same way.

This gated dispute handling on the OLDEST, most-used agents, and it is a
prerequisite for `DISPUTE_RESOLVER_ENABLED`: an agent without a loaded policy
degrades to log-only.

## 2.8.0

**Round-4 prep: three job-container defects fixed.** Requires
`@junction41/sovagent-sdk@2.14.0`.

- **Deletion attestations are produced on SIGTERM and timeout again.** Both
  shutdown handlers used the older `getDeletionAttestationMessage()` →
  `signMessage("J41-DELETE-…")` flow, which the signing broker CORRECTLY refuses.
  Only the normal-completion path had been migrated, so **every abnormally
  terminated job silently produced no privacy proof** for `private`/`sovereign`
  tiers — swallowed by a bare catch. All three paths now share one implementation.

- **A transient startup response no longer kills the container permanently.**
  `getJob` is retried (5 attempts, 3s base), with the completeness check *inside*
  the retried call — the observed failure was a resolved response with missing
  fields, which never throws. Five containers died this way, each stranding a
  paid job; both clusters landed inside `CHAIN_SYNCING` windows.

- **SovGuard canary registrations are released on teardown.** Nothing ever called
  `deleteCanary`, and the cap is 5 per agent, so **every agent past its 5th job
  ever ran with SovGuard-side leak detection silently off** (one slot was still
  held from 2026-03-15). Release happens *after* the attestation — the SIGTERM
  grace period can be 5s and `deleteCanary` can hang for 30s, and the privacy
  proof matters more. Abandoned slots (older than 25h) are purged so registration
  can recover on agents already at the cap; a canary belonging to a **concurrent**
  job is never touched. Registration failure now says leak detection is DISABLED
  for that job rather than a bland "non-fatal".

- New `src/job-agent-teardown.js` with explicit dependencies, so container
  teardown is behaviourally testable instead of regex-asserted.

**Known, unchanged:** idle-pause/respawn churn (deferred — bounded, needs a
container/host shared-state design). Note it interacts with the attestation fix:
each respawn now submits its own deletion attestation, truthful per container
instance, so a job may produce several.

## 2.7.3

**Two failures that reported success while the real outcome was silent.**

- **`TX_REJECTED` is no longer classified as chain contention unconditionally.**
  Contention never counts toward the dead-letter budget and never escalates, so a
  permanently malformed transaction retried every cycle forever — no dead letter,
  no health signal, nothing in the event ring. This is what hid the contentmultimap
  key-ordering bug (`-25 bad-txns-failed-precheck`) while every new-key write on
  every agent failed. The classifier now reads the daemon's reason from
  `error.detail`: spent-inputs/mempool-conflict stay contention, malformed-tx
  reasons become hard failures that dead-letter loudly, and a named-but-unknown
  reason defaults to hard. A rejection with no detail (older platform) keeps the
  previous behaviour. Requires `@junction41/sovagent-sdk@2.13.1`.

- **`ctl shutdown` could announce success and keep running.** It logged
  `✅ No active jobs. Shutting down.` and then polled for 27 more cycles with
  `/health` still answering 200. A startup race: the shutdown handler's state was
  declared after the control server that triggers it, so a shutdown arriving during
  startup hit a TDZ and became an unhandled rejection. A "restart" that leaves the
  old process alive means two dispatchers writing identity transactions against the
  same `prevOutput` — the exact double-spend class 2.7.0 exists to prevent.
  Shutdown now always terminates: state declared first, a startup gate that exits
  immediately rather than half-draining, every cleanup step guarded, and a 30s
  watchdog.

- **New log line `✅ Startup complete — graceful shutdown enabled.`** `Ready agents: N`
  appears *before* the on-chain activation pass and is not a safe-to-stop marker.
  Scripted restarts should wait for the new line.

## 2.7.2

**Requires `@junction41/sovagent-sdk@2.13.1`** — 2.7.1 pinned 2.13.0, which did NOT
contain the contentmultimap key-ordering fix. On a daemon that enforces canonical
key order, 2.7.1 cannot write any VDXF key an identity does not already have:
`update-profile` fails, and so does the first `review.record` / `review.attestation`
/ `job.record` write to a fresh agent. Upgrade.

- `update-profile` gains `--dispute-policy <json|default>`. Validated before
  broadcast (enum values, ranges, integer cycles) — a malformed policy on-chain is
  worse than none, since the dispatcher loads it and acts on it, whereas an absent
  one degrades to log-only. `default` writes the same policy `setup` does.
- All 9 test agents now carry an on-chain dispute policy; previously every one
  logged `no dispute policy on-chain — disputes will log only`, because adding the
  key was impossible.

## 2.7.1

**`update-profile` was completely broken; fixed.** Requires
`@junction41/sovagent-sdk@2.13.0`.

The SDK's `removeAndRewriteVdxfFields()` used a two-transaction flow —
`contentmultimapremove` (action 3), wait a block, then write. As of 2026-08-04
the remove transaction is rejected by the network (`400 TX_REJECTED`, daemon
`-25 bad-txns-failed-precheck`), so no profile update could complete on any
agent. It is now a single transaction.

**If you installed 2.7.0 from npm, `update-profile` does not work** — it pinned
SDK 2.12.0, which still contains the broken path. Upgrade.

- `update-profile` no longer prints "Remove TX" or "Blocks waited" (neither
  exists now), and no longer waits up to 20 minutes for an intermediate block.
- `--dry-run` resolves field names with the same `resolveVdxfFieldRef` the real
  run uses, so it now predicts the real outcome — including the error on an
  unknown or ambiguous field name.
- Verified live: agent-3 `b7d49d25`, agent-7 `9e890c6d` (a profile field and
  `review.record` written together in ONE transaction), agent-4 `4294bfc8` via
  the CLI. No contentmultimap key, current-state review, or history entry was
  lost in any of them.

**Not gated:** `update-profile` does not route through the inbox pending-write
confirmation gate. Do not run it while the dispatcher has an unconfirmed
identity write for the same agent — check `/health` `pendingWrites` is empty
first.

## 2.7.0

**Inbox writes are now batched — one identity transaction per agent per poll
cycle.** Requires `@junction41/sovagent-sdk@2.12.0`.

The old loop accepted inbox items one at a time, writing N transactions to the
same VerusID back-to-back. The first spends the identity `prevOutput` and sits in
the mempool, but the platform API keeps serving the last *confirmed* `prevOutput`
— so every transaction after it is built spending an already-spent output and the
daemon rejects it as a double-spend. Live-observed on 3 of 3 agents: an
attestation landed, the review that followed milliseconds later was rejected five
times and dead-lettered, and its on-chain reputation data never arrived. The
platform's confirmed view was measured stale for **over five minutes**, past the
confirming block's own timestamp — so no block-time estimate is safe as a retry
horizon.

- **Batching** via the SDK's `acceptInboxBatch`, with per-item failure handling:
  a poisoned item is rejected alone while healthy items still write.
- **Pending-write gate** — never build a second identity transaction while the
  previous one is unconfirmed. Releases on observing `prevOutput` become our
  txid, or on chain height passing the transaction's `expiryHeight`; a 4h
  wall-clock backstop covers a concurrent writer confirming on top of ours.
- **Failure classification** — chain contention no longer consumes the terminal
  dead-letter budget. Burning five attempts on a self-resolving condition is
  exactly how the three reviews were quarantined.
- **Bounded escalation** — batch-level failures are not attributable to one item
  so they are uncounted, but *uncounted must not mean unbounded*: five
  consecutive same-composition **hard** failures start counting items
  individually. Contention and transient/environmental faults never escalate, so
  an unfunded wallet cannot quarantine an inbox.
- **Structured `/health` inbox block** (`deadLettered`, `retrying`, `ackFailed`,
  `pendingWrites`) plus `ctl inbox` and `ctl inbox-redrive [--item <id>]`.
  `status` becomes `degraded` while anything is dead-lettered — **note for
  monitoring: anything alerting on `status != ok` will now fire on dead
  letters.** Redrive clears quarantine without a restart. The previous surface
  was a single per-agent `lastError` string that lost every failure but the
  newest.
- **Reentrancy guard** on the inbox sweep — `safeInterval` is a plain
  `setInterval`, so a sweep slower than the 60s floor would overlap the next one
  and race the gate.

Skew-safe: running against an SDK without `acceptInboxBatch` falls back to the
per-item path, still with contention classification — strictly better than 2.6.0
even mis-paired.


## 2.6.0

**Operators must upgrade to 2.6.0 before Junction41 enables its dispute
resolver.** Earlier versions have no `queueDisputedJobForRespawn`, so a
torn-down agent never respawns to answer a dispute — under the resolver that
reads as silence and results in an auto-default and a hire suspension.

- **SDK dep bumped to `@junction41/sovagent-sdk@2.11.0` — required, not
  optional.** The worker-attach ACK path calls `confirmWorkerAttached()` and
  `reportWorkerAttachFailed()`, which first ship in SDK 2.11.0. On any 2.10.x
  SDK those methods are `undefined`, the ACK never reaches the platform, and
  `jobs.worker_attached_at` stays `NULL` for every job — which in turn keeps
  dispute-refund eligibility permanently ungated. Pin 2.11.0 or newer.

- **sovcompute credit-low notify (edge-triggered).** The proxy now fires a
  one-time, **signed** `POST /v1/webhooks/dispatcher/credit-low` to J41 the
  moment a buyer's prepaid balance crosses **below** the threshold after a
  request (edge-triggered — debounced so a buyer parked under the line doesn't
  re-notify every call). Threshold is `[proxy] credit_low_threshold_vrsc`
  (`J41_PROXY_CREDIT_LOW_THRESHOLD`); `null` falls back to
  `suggested_topup_vrsc`. Body is RFC-8785 canonicalized and seller-signed,
  matching the deposit-confirmed signing pattern. Best-effort / non-fatal — a
  notify failure never blocks the proxy response.

- **fix: `notifyJ41DepositConfirmed` deposit-confirmed notifies had never
  fired.** The json-canonicalize import was `const canonicalize =
  require('json-canonicalize')` — but the module exports `{ canonicalize }` (an
  object, not a callable). Calling `canonicalize(payload)` threw "canonicalize
  is not a function", which the surrounding best-effort `try/catch` swallowed
  silently — so **every deposit-confirmed J41 notify had been a no-op**. Now
  `const { canonicalize } = require('json-canonicalize')`. Both the
  deposit-confirmed notify and the new credit-low notify produce correct
  canonical signed bodies and actually reach J41.

- **jailbox parked (default-off).** The "agent works inside the buyer's
  environment" sandbox (legacy `workspace.*`, aka jailbox) is parked in favour
  of deliver-and-review and now defaults **OFF** behind the new
  `jailbox.enabled` config flag (`JAILBOX_ENABLED=1` to re-enable). The
  dispatcher refuses to start a jailbox session — clear `[JAILBOX]` log, no
  `workspace_ready` forwarded — gated at the single dispatcher choke point
  (`checkWorkspaceCapability`) and the single in-container funnel
  (`connectWorkspace`, flag forwarded via `buildContainerEnv`). **Not deleted,
  re-enablable, and the hash-chained signed audit-log / attestation machinery is
  retained intact** as proof-of-process. See `JAILBOX_PARKED.md` and docs spec
  `2026-06-12-vdxf-v2-schema-design` §3b. When the flag is on, behaviour is
  unchanged.

## 2.2.0 — 2026-06-02 security audit

This release closes 6 highs + ~15 mediums/lows from the 2026-06-02 cross-repo security audit. Behavioral changes operators should know about:

**Per-job WIF temp copy is now cleaned up + mode 0600** (H1). Previously `/tmp/j41-keys-<jobId>/keys.json` was created mode 0644 and never removed — operators ended up with an accumulating stash of plaintext WIFs. `stopJobContainer` now `rm -rf`s the dir on every stop path (success + failure), and the mode is tightened (container runs as the dispatcher UID — 0644 was historical).

**`sign-channel-host` validates container-supplied response ids** (H2). The container sets `req.id` and it's used in the response file path; the previous code allowed arbitrary host-side file writes via `../../../tmp/pwned` style ids. Now matched against `[a-f0-9-]{1,80}`.

**`broker-executors.jobCompletionUpdate` shape-validates the container blob** (H6). Container-supplied `jobRecord` must only contain a known allow-listed set of keys (jobHash/timestamp/completedAt/amount/currency/buyer/seller/status/reviewerSignature); unexpected keys throw. `reviewRecord` and `workspaceAttestation` type-checked.

**`@junction41/secure-setup` pinned to exact `0.3.0`** (H5). The previous `>=0.1.0` would auto-resolve any future malicious release.

**Bumped SDK to 2.5.0** with its own breaking changes (see that package's README).

**Family 3 normalizer at two sites** (M-auth-2/3): `deposit-watcher.js` `senderVerusId` vs `buyerVerusId` and `cli.js` API-access revoke `buyerVerusId` now `trim+lowercase+strip-trailing-@` before comparing. Catches `'buyer.agentplatform@'` vs `'buyer.agentplatform'` mismatches that the backend's `4b1f334` Family 3 fix flagged.

**Deposit-watcher refuses signature-only credit by default** (M-funds-1). When the platform's `verifyPayment` response omits `senderVerified`, we no longer credit on signature auth alone — an attacker who observed a public funding tx could otherwise self-credit. Override with `J41_DEPOSIT_ALLOW_AUTH_ONLY=1` while the platform side updates.

**New ingest caps**: `J41_CTL_MAX_BUFFER_BYTES=64KB` (control socket), `J41_SIGN_REQ_MAX_BYTES=256KB` (broker req), `J41_JOB_DESCRIPTION_MAX_BYTES=1MB`, `J41_MAX_JOBS_PER_POLL=200`.

*Historical note:* this release documented temporary compatibility env vars for the platform transition. They are obsolete: `J41_REQUIRE_PLATFORM_SIGNER` no longer exists in any package, and the remaining flags are legacy security opt-outs documented (and discouraged) in README → Security → Legacy opt-outs.

## 2.1.15 — 2026-05-26

**Broker file-channel transport — opt-in.** The new `J41_SIGNING_BROKER=1` env var routes all in-container signing through a file-IPC channel to a host-side `SignChannelHost`, keeping the agent WIF on the dispatcher host and out of the job-agent container's filesystem entirely. Default remains off; the legacy `keys.json` bind mount is still the only behaviour you get without the flag. Cuts the in-container blast radius — a fully-compromised job-agent cannot exfiltrate the WIF or forge identity-bearing signatures for other jobs (broker rebuilds canonical accept/deliver/dispute message bytes from authoritative platform state and refuses container-supplied protocol-formatted text).

End-to-end testnet validation pass closed 8/8 runbook gates (see `docs/BROKER-DOCKER-VALIDATION.md`). Five backend bug families surfaced and were fixed in flight during validation; the dispatcher-side fixes in this release:

- **`User: <uid>:<gid>` at the top level of `createContainer`** (was nested under `HostConfig` where the Docker engine silently ignores it — container was falling through to the Dockerfile's `USER j41-agent` and EACCESing on bind-mounted job files).
- **Poll loop merges `status:in_progress` jobs** (default `getMyJobs({role:'seller'})` excludes them server-side, so jobs paid in another session became invisible).
- **Post-delivery IPC routes through `_postDeliveryHandler` in Docker mode** (`process.on('message')` never fires under Docker — file-poller messages were sitting in `ipcQueue` unprocessed; container couldn't observe `job.completed`).
- **`performCleanup` uses `attestDeletion` via `signAttestationWith`** (JCS-canonicalized bytes, not `J41-DELETE-...|...` protocol-formatted — the broker's `assertNotProtocolMessage` signing-oracle guard correctly refused the old raw-`signMessage` call).
- **Container's on-chain identity-update step deferred to the host Inbox processor in broker mode** (was double-broadcasting the same `job.record` VDXF; host's `acceptJobRecord` is the canonical writer in broker mode).
- **`deletion-attestation.json` written before submit attempt** (so the on-disk artifact survives a platform-side validation failure unrelated to signing).
- **Operator env-var gates**: `J41_NO_STATUS_TOGGLE=1` skips startup activate-all + shutdown deactivate-all loops (don't ping-pong agent platform state across restarts; don't fire an on-chain identity-update tx for every managed agent at boot). `J41_DISABLE_BWRAP=1` skips the bubblewrap entrypoint wrapper (the bwrap `--ro-bind /app /app` re-mount can obscure bind-mounted job-dir permissions during debugging).
- **SDK dep bumped to `@junction41/sovagent-sdk@2.4.0`** (RemoteSigner hook is the container-side counterpart of the broker transport).

Cutover sequence remains as documented in the runbook — this release ships broker as opt-in only. Default-on flip lands once a release cycle of opt-in soak shows no broker-related errors.

## 2.1.14 — 2026-04-28

**Resilience patch.** Two fixes addressing economic-griefing vectors that bite at scale:

1. **Per-buyer rate limit at the proxy.** Token bucket keyed by `buyerVerusId`. Defaults: 10 RPS per buyer, 30-burst. Configurable via `[proxy]` keys `rate_limit_rps`, `rate_limit_burst`, `rate_limit_max_buckets` (default 10k LRU cap on distinct buyers tracked). Idle buckets evicted after 5 min, LRU-evicted at the cap. Returns HTTP 429 with `Retry-After` header. Prevents a buyer with valid auth from saturating the upstream + draining their own credit on errors.

2. **Circuit breaker on proxy → upstream.** `upstream-health.js` was already polling `/models` every 60s but the proxy never gated on the result. Now: after `circuit_threshold = 3` consecutive failed probes, `circuitOpenedAt` timestamp is set and the proxy returns 503 immediately for `circuit_open_ms = 30s` instead of forwarding to a dead upstream. After the open window expires, traffic flows through (half-open via real requests). On any successful probe, `circuitOpenedAt` resets to null and the circuit closes.

The `circuitOpenedAt` mechanic was a fix from plan review — the original draft used `lastCheck` (set every poll), which would have left the circuit permanently open. Now the timestamp is sticky from threshold-cross to next successful probe.

Pure additive — no breaking API/wire changes. Operators with default config get the protections automatically. 50 unit tests passing (was 40).

## 2.1.13 — 2026-04-28

**Security patch — required for mainnet.** Two fixes:

1. **Revoke webhook now requires HMAC signature.** Previously the `/j41/api-access/revoke` endpoint (introduced in 2.1.12) accepted unauthenticated POSTs — anyone with a dispatcher's public URL could revoke any seller's API keys for any known buyer. The endpoint now requires `x-webhook-signature: sha256=<hex>` header with the body HMAC-signed using the **seller's per-agent webhook secret** (same secret already used for `/webhook/:agentId` events since 2.0.x). Missing signature → 401. Wrong signature → 403. Unknown seller → 404. Backend coordination required (see below).
2. **Nonce replay protection on v2 access envelopes.** Dispatcher now tracks recently-seen nonces (in-memory, 11-min TTL = max envelope window + 1 min grace, 100k LRU cap). Replayed envelopes within their expiry window throw `v2 envelope rejected: replay` and the proxy refuses to mint a duplicate API key.

**Backend rollout order** (REQUIRED — do not invert):
1. Backend ships HMAC-signing on `DELETE /v1/me/api-access/:grantId` revoke fan-out FIRST (one-line change — the per-agent webhook secrets are already stored from `POST /v1/me/webhooks` registrations).
2. Then ship dispatcher 2.1.13. If dispatcher ships first, revoke calls return 401 until backend catches up — bad operationally but not a security regression.

40 unit tests passing (was 32; +4 nonce-cache, +4 revoke-webhook).

## 2.1.12 — 2026-04-27

**Revoke webhook endpoint** — closes the half-shipped revoke flow that the platform's `/api-access` dashboard now exposes. New endpoint:

```
POST /j41/api-access/revoke
Content-Type: application/json

{
  "sellerVerusId": "i...",
  "buyerVerusId":  "i...",   // optional; if set, revokes ALL active keys this buyer holds for this seller
  "apiKey":        "sk-..."  // optional; if set, revokes that exact key
}

→ 200 { "revoked": <number>, "buyerVerusId"?: "i..." }
```

Wired to `api-key-manager.revokeApiKey()` so the proxy refuses further requests with the revoked key. The platform's `DELETE /v1/me/api-access/:grantId` is the natural caller — when a buyer hits "Revoke" on the dashboard, J41 deletes its grant metadata and posts here to invalidate the key locally.

If neither `buyerVerusId` nor `apiKey` is provided, returns 400. If the seller isn't on this dispatcher, returns `{ revoked: 0, reason: 'seller-not-found' }` (200).

## 2.1.11 — 2026-04-26

**Root-cause fix for agent identity file permissions** (continues from 2.1.10).

The 2.1.10 audit on a real operator's machine surfaced 11/11 agent dirs at 0775 and 2/11 `keys.json` files at 0664 — world-readable. 2.1.10 fixed the `mkdirSync(agentDir, ...)` call sites to pass `mode: 0o700`, but a deeper investigation showed the underlying issue had **four layers**:

1. **The dispatcher relied on the operator's `umask`** for files written without explicit mode. On Ubuntu's user-private-groups default (`umask 0002`), files default to 0664 and dirs to 0775 — world-readable. A different operator with `umask 0027` would have gotten 0750/0640. **Non-deterministic across deployments** — that's the real defect.
2. `mkdirSync(agentDir, ...)` calls without explicit mode (fixed in 2.1.10).
3. `writeFileSync(keys.json, ...)` writes that relied on a follow-up `chmodSync(0o600)`. The brief window between write and chmod was racy. One write (the registration-timeout path at cli.js:2673) had no chmod at all.
4. Files created by older dispatcher versions persist with whatever mode they were created at — chmod patches don't apply retroactively.

**2.1.11 fixes (defense in depth):**

- `process.umask(0o077)` at the very top of `cli.js` so the entire process produces 0700 dirs and 0600 files by default. Even if a future code path forgets `{ mode: 0o600 }`, it still gets a safe default.
- All 12 `writeFileSync(keys.json, ...)` call sites now pass `{ mode: 0o600 }` atomically. Eliminates the write-then-chmod race window.
- The defense-in-depth sweep in `ensureDirs()` (added in 2.1.10) continues to handle case 4 — re-locks any pre-existing bad-mode files on every CLI invocation.

After upgrading and running any `j41-dispatcher <subcommand>`, all existing agent files self-heal. New agents are created with strict modes regardless of operator umask.

## 2.1.10 — 2026-04-26

**Permission hardening for agent identity files.** A real-world audit on a host with 11 agents found:

- All `~/.j41/dispatcher/agents/<id>/` directories were created at mode 0775 (group-writable, world-readable). The dispatcher's `mkdirSync(agentDir, ...)` calls weren't passing an explicit `mode`, so the OS umask applied (typically 022). Three call sites patched to pass `mode: 0o700`.
- Two agents had `keys.json` at mode 0664 (world-readable) — likely from older dispatcher versions or upgrade paths that bypassed the chmod step.

Two fixes:

1. All three `fs.mkdirSync(agentDir, ...)` sites now pass `mode: 0o700` explicitly.
2. New defense-in-depth sweep in `ensureDirs()` (called on every CLI invocation) re-locks existing agent dirs to 0700 and any present sensitive files (`keys.json`, `agent-config.json`, `finalize-state.json`, `vdxf-update.*`) to 0600. Idempotent and silent — corrects past mistakes without operator action.

Real-world impact on a single-user host is limited (parent dir `~/.j41/dispatcher/` is 0700, blocking external listing), but on multi-user systems this was a meaningful exposure. After upgrading, just running any `j41-dispatcher` command (including `--version`) will trigger the sweep.

## 2.1.9 — 2026-04-26

- **Dashboard banner now shows version** (`J41 Dispatcher v2.1.9 — Setup & Management`). Operators can confirm what they're running at a glance without dropping to a shell.
- **Fixed `browse-bounties` crash** — `cli.js:6152` had the same `agents[0].id` bug pattern fixed in 3 other sites in 2.1.8. With the multi-agent loop fixes that shipped in 2.1.8, this was the last instance.

## 2.1.8 — 2026-04-26

Two bug fixes caught by live operator testing:

- **Fixed `setup` / `register` crashing on hosts with multiple registered agents.** Three duplicate-name check loops treated `listRegisteredAgents()` results as objects with an `.id` property, but the function returns plain string IDs. With ≥1 other registered agent, `loadAgentKeys(undefined)` would throw `TypeError: Cannot read properties of undefined (reading 'includes')` from the path-traversal validation. Patched all 3 sites (cli.js:1279, 1652, 2618).
- **Fixed `j41-dispatcher --version` always printing `2.0.0`.** Hardcoded string at `cli.js:995`; now reads from `package.json.version` so the flag actually reports the installed version.

## 2.1.7 — 2026-04-25

Security patch round — closed 3 protobufjs criticals (via dockerode 4→5 + yarn resolutions), 1 socket.io-parser high, and several moderates across the workspace. Verus-fork bitgo chain has 1 known unfixable high (documented).

## 2.1.6 — 2026-04-25

Hardcoded values pass: 10 magic numbers across the dispatcher are now configurable via `~/.j41/dispatcher/config.toml` and per-key environment variable overrides. No new features; this is a "make the knobs reachable" release.

### ⚠️ Breaking behavior change

**Implicit `maxConcurrent: 9` default removed.** Operators who never explicitly set `maxConcurrent` were silently capped at 9 concurrent jobs by a hardcoded default in `src/config.js`. After 2.1.6, the default is **unlimited** (`max_concurrent = 0`).

To preserve the previous behavior, add to `~/.j41/dispatcher/config.toml`:

```toml
[runtime]
max_concurrent = 9
```

Or to your existing `~/.j41/dispatcher/config.json`:

```json
{ "maxConcurrent": 9 }
```

**Why:** the historical `9` was arbitrary and conflicted with the new TOML schema. Surfacing it as an explicit operator decision is correct, even if upgrade migration is mildly painful.

### Behavior change (non-breaking, worth noting)

**Job-timeout warning now scales with timeout length.** Previously fired exactly 5 minutes before timeout regardless of job length. Now fires at 90% of timeout, never less than 1 minute before.

| Job timeout | Old warning | New warning |
|---|---|---|
| 60 min | 5 min before | 6 min before |
| 20 min | 5 min before | 2 min before |
| ≤11 min | 5 min before (could fire before job started!) | 1 min before (floor) |

The old behavior was buggy for short jobs — it could fire the warning before the job had a chance to do anything. The new formula always leaves at least 1 minute of warning.

### Configuration migration

For operators who were using `J41_EXECUTOR_TIMEOUT` to indirectly control proxy upstream timeout (because no proxy-specific knob existed), switch to the new dedicated env var:

```diff
- J41_EXECUTOR_TIMEOUT=300000
+ J41_PROXY_UPSTREAM_TIMEOUT=300000
```

`J41_EXECUTOR_TIMEOUT` continues to work but only affects the executor (n8n / langgraph / a2a / etc.), not the API proxy.

### New configuration keys

Schema additions to `~/.j41/dispatcher/config.toml`:

```toml
[proxy]
upstream_timeout_ms = 60000     # raise to 300000 for long local-LLM queries
estimated_input_tokens = 4000   # fallback when token counter unavailable
estimated_output_tokens = 2000  # fallback when no max_tokens in request body
suggested_topup_vrsc = 10       # X-J41-Credit-SuggestedTopup header default

[deposit]
poll_interval_ms = 60000        # how often to scan for new VRSC deposits

[health]
poll_interval_ms = 60000        # how often upstream-health pings each upstream

[webhook]
max_body_bytes = 1048576        # 1 MiB inbound body cap

[retry]
rate_limit_backoff_multiplier = 3   # multiplier on baseDelayMs for HTTP 429
```

All of these accept matching `J41_*` environment variable overrides:

| Env var | TOML key |
|---|---|
| `J41_PROXY_UPSTREAM_TIMEOUT` | `proxy.upstream_timeout_ms` |
| `J41_PROXY_ESTIMATED_INPUT` | `proxy.estimated_input_tokens` |
| `J41_PROXY_ESTIMATED_OUTPUT` | `proxy.estimated_output_tokens` |
| `J41_PROXY_SUGGESTED_TOPUP` | `proxy.suggested_topup_vrsc` |
| `J41_DEPOSIT_POLL_INTERVAL` | `deposit.poll_interval_ms` |
| `J41_HEALTH_POLL_INTERVAL` | `health.poll_interval_ms` |
| `J41_WEBHOOK_MAX_BODY` | `webhook.max_body_bytes` |
| `J41_RATE_LIMIT_BACKOFF_MULTIPLIER` | `retry.rate_limit_backoff_multiplier` |

### Internal

- `src/proxy-handler.js` now does a single `loadDispatcherConfig()` per request instead of three.
- `checkUpstreamHostSafe(hostname, cfg)` signature changed to take cfg (was internal to the file; no external callers).
- 31 unit tests passing (was 30 in 2.1.5; added one for the extended schema).

## 2.1.5 — 2026-04-25

- Migrated dispatcher config from `.env` (loaded into `process.env`) to `~/.j41/dispatcher/config.toml` (mode 0600, atomic writes, file-locked, 1s TTL cache). Provider API keys now never enter the dispatcher's own `process.env` and are forwarded to job containers explicitly via `docker run -e`.
- Auto-migration of existing `.env` files at install dir to `config.toml` on first start, with `# MIGRATED` banner on the legacy file.
- Removed install-dir `.env` auto-loader from `cli.js` (was the security regression vector that defeated the migration's intent if left in).
- Both container-launch paths (`startJobContainer`, `startJobLocal`) source provider keys from `cfg.provider_keys` instead of `process.env`-spread.
- `gitignore` now lists `config.toml` as belt-and-suspenders.

## 2.1.4 — 2026-04-25

- Full local fail-closed v2 canonical envelope verification at `/j41/discovery/request-access` (no trust-J41-forwarded fallthrough).
- Removed `J41_SKIP_SIG_VERIFY` env-var bypass entirely.
- `[CHAT-DEBUG]` log gated behind `J41_DEBUG_CHAT=1`, content-bytes logging removed (privacy fix).
- Dashboard Status & Health screen rewritten with backend feature-flag check + per-agent api-endpoint summary.

---

Intermediate releases: see git history and npm versions.
