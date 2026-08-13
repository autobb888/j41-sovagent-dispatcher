# Dispatcher — release readiness

**Date:** 2026-08-13
**Assessed build:** 2.29.0 (`fe0abb0`), 1066 tests, live on a 9-agent VRSCTEST fleet
**Verdict: shippable to npm for the paths that have been exercised. The operator
lifecycle is still the one gate that has never been walked end to end.**

---

## What changed since the last assessment (2.24.0)

The `platform_status` cutover shipped and was **proven on the live fleet on
2026-08-12**. Backend deployed migration 058 (hire gate ANDs `status` and
`platform_status`; the indexer never writes the latter), so the dispatcher stopped
writing agent status on-chain for routine restarts.

The upgrade restart, executed:

| | result |
|---|---|
| agents restored from the shutdown marker | 9/9 |
| chain-axis repairs, one per agent | 9/9, all confirmed |
| **rejected on-chain writes** | **0** (previous three restarts: 9, then 5, then 3) |
| both axes active afterwards | 9/9 hireable |

It also repaired two agents that were **already broken before the restart**:
`agent-6` and `agent-7` were `chain=inactive, platform=active`, so the hire gate was
silently refusing them while every local surface said healthy — `agent-7` reported
`lastError: None`. That is the exact failure mode this release exists to remove, found
and fixed in production.

Also shipped: **M3** (the outbound-refund rate limit, which had been documented for
months with zero callers — none of the four guarantees existed), **M2r** (proxy
billing: a real `completion_tokens: 0` no longer bills a flat estimate, errors bill
nothing on both paths, and the three settle sites now share one policy), and a static
scope checker.

**Deferred deliberately: M4**, the 0-conf deposit reconciler, on
`feature/m4-deposit-reconcile`. See "Why M4 was cut" below.

## What is proven versus merely tested

**Proven live:** the upgrade restart; the chain repair; the confirmation wait (dead
code in every prior version); the `/v1/version` capability check; dispute → rework →
re-delivery; orphaned-dispute respawn; refund escalation end-to-end; bounty `/select`
under signature enforcement; fee-tank sweep.

**Tested, not yet exercised in production:** the refund rate limiter's blocking paths
(no backlog has hit the hourly cap since it was wired); the proxy settle changes (they
only fire on upstream misbehaviour); the wedged-startup `/health` degrade.

**Neither:** see the gate below.

## The gate that still has not moved

The full operator lifecycle — **clean install → register → encrypt keys → start from
the dashboard → take a job → restart mid-job → confirm the fleet returns** — has still
never been run start to finish by anyone. We have now done the restart half on a
warm fleet, which is real progress and is the half that was scariest. The install and
first-run half remains untested since the four first-run highs were fixed in 2.21.0.

Until someone walks it on a clean machine, "a new operator can run this" is an
assertion.

## Why M4 was cut, and what it needs before it lands

M4 was a third of the release's source diff and produced roughly a quarter of every
defect found across five adversarial review rounds: an uninterpretable-response
reversal, a route-404 misread, a crash double-claw, a systemic guard that protected
only the last record of each pass, and two distinct ways of minting credit. What it
closes is a ≤2 VRSC-per-event leak that has existed for months with nobody exploiting
it, while the genuinely time-sensitive cutover had been stable for three rounds.
Bundling them meant the proven urgent work was gated on the unproven risky work.

Blocking items on that branch:

1. **Node-lag false positives.** Backend confirmed `TX_NOT_FOUND` is tx-specific and
   distinguishable from a route 404 — but it reflects *that node's current view*. A
   node behind the tip reports it for a transaction that really landed. Node-down is a
   safe 502; node-lag is a 404 that would claw back a paying buyer. The reversal path
   must require a caught-up node, not just the grace window.
2. **`needsOperator` and the `reversed` ledger are write-only.** Nothing reads them —
   not `/health`, not the control API, not the dashboard, not any CLI command. Every
   ambiguous-money path in that branch escalates to a console line.
3. **No execution harness.** Its defects survived three rounds of people reading the
   code and fell in one pass to a reviewer who built a harness and ran it. That harness
   should exist before M4 re-lands.

## What five review rounds actually taught

34 defects across five adversarial rounds, and **the majority were introduced by the
previous round's fixes.** That is the finding that outlasts any individual bug:

- **Fix the class, not the instance.** A guard that protected only the last record of
  a pass. A restore that assumed a reversal meant a debit. A traversal check that was
  lexical when it needed `realpath`.
- **Execute the fix; do not just write it.** Three separate defects were lines
  referencing state that did not exist (`_inboxLastWrite`, `state.startedAt`,
  a `has()`-guarded `delete()`), none of which had ever been run.
- **Source-text assertions are theatre.** Tests that grep for an identifier pass
  against `if (false)`. Pin the guard expression, and pin it to a unique anchor —
  three tests in one file silently stopped testing their subject when new code was
  inserted between their anchor and their target.
- **Chunk by concern.** Four concerns in one release is why each round's fixes landed
  on top of each other.

## Known-open, not blocking

| # | Finding | Why it can wait |
|---|---|---|
| N1 | `performCleanup` writes the job record from a snapshot taken at container start | Broker mode (the default) defers to the host inbox processor and is immune |
| N2 | `_budgetGateHit` only reset on `_agentLoop` entry | Latent until the jailbox is re-enabled. **Will bite the day it is.** |
| N3 | Fork mode double-handles post-delivery IPC | `--dev-unsafe` gated, but dev then differs from prod |
| N4 | `events.jsonl` has no single-writer guard | Only reachable during a contested restart |
| N5 | pid-file reuse: SIGTERM sent without verifying the pid | Environmental |
| N6 | File-IPC read-then-unlink race | Milliseconds wide; retry now possible |
| N7 | Rate-limit check reads `send-history.json` outside its lock | Bounded overshoot (~2 concurrent processes); the durable no-double-pay guarantee is elsewhere |

## Recommendation

Publish 2.29.0. Then walk the operator lifecycle on a clean machine — that is the
remaining gate and it has been outstanding for the whole cycle. M4 lands after the
harness exists and its two blocking items are closed.

---

## Superseded assessment (2026-08-09) — kept for the record

## The one-paragraph version

Everything a *buyer* touches has been rebuilt and proven live over rounds 6–9: hire,
deliver, dispute, multi-cycle rework, refunds, bounties. Money paths are conservative
by construction — nothing pays without owner approval, and every guard we relaxed was
relaxed deliberately. **The weak half is everything an *operator* touches**: starting,
stopping, restarting, and knowing whether the thing is alive. That surface has had a
fraction of the scrutiny and it is where a new user meets the product first. Five
defects there were found and are now fixed (2.18.0/2.18.1) — but four of them have no
automated coverage, so they are "observed working once", not proven. They were the
difference between "works for us" and "someone else can run this".

## What is solid — verified live, not just unit-tested

| Area | Evidence |
|---|---|
| Dispute → rework → re-delivery | Cycles 1–2 proven on 3 separate jobs, full answers in chat |
| Orphaned dispute (worker died) | Reconciler respawns; proven with a deliberately killed worker |
| Over-limit rework | Guard refuses the offer; buyer is told; `NO_REWORK_OFFER` confirmed by tester |
| Refund escalation | respond → sweep queues → operator approves → paid, twice, receipts confirmed |
| Bounty `/select` | Canonical signature verified under `enforce`; award→job handoff works |
| Fleet restart | `Reactivated 9/9`, marker cleared, no manual step |
| Crash-safety of state files | Atomic writes, corrupt-vs-absent distinguished, quarantine |
| Money conservatism | 20 refunds sat queued for weeks without a single unapproved send |

948 tests. Every fix this cycle was mutation-checked where a unit test could reach it —
which, as noted below, is not everywhere.

## Blockers — ALL FIXED in 2.18.0 / 2.18.1 (kept for the record)

Stated below in the present tense as originally written, describing the defect each fix
addressed. Ordered by what breaks first for someone who is not us.

### B1 — `/health` cannot see whether the fleet is actually online
`src/control.js` derives agent status purely from local job assignment; platform
active/inactive is never queried. **Zero** references. During the 2026-08-06 fleet
outage every surface reported `status: ok` with all agents `available` while the
platform considered all nine inactive. A monitoring endpoint that stays green through
a total outage is worse than no endpoint. *Also:* the health server swallows
`EADDRINUSE` with an empty handler and never retries, so after a contested restart the
daemon can run its whole life with no `/health` at all.

### B2 — the dispatcher keeps accepting jobs while shutting down
`shuttingDown` is a closure variable never placed on `state`; no interval reads it.
`pollForJobs` will sign and `acceptJob` during a drain, after every agent has been
marked offline. A buyer can pay into a job whose seller is mid-shutdown. **Money can
be stranded**, which is why this outranks the cosmetic items.

### B3 — the dashboard's Start button lies, and always lies for hardened installs
It reports `✅ Dispatcher started (PID …)` with no liveness check. The child is spawned
with `stdio: ['ignore', …]`, so with an encrypted key pool and no passphrase in env it
exits within a second — and the operator who followed our own `encrypt-keys` hardening
advice gets a Start button that never works and never says so.

### B4 — `runtime.webhook_url` parses but is never consulted
`start` reads only the `--webhook-url` CLI flag. Meanwhile the dashboard prints
`Mode: webhook` from the config value. So config.toml — which we document as the source
of truth — silently does nothing, while the UI confirms the operator's wrong belief.
The api-endpoint proxy is webhook-mode-only, so it silently never starts either.

### B5 — every restart broadcasts 2N unrequested on-chain transactions
Shutdown deactivates N agents on-chain; start reactivates N. There is no
"already in this state" check, so a routine stop/start of a 9-agent fleet is 18
identity transactions the operator never asked for, each costing fees. Compounding:
the inbox pending-write gate is an in-memory Map, so a fast restart can double-spend a
`prevOutput` against an unconfirmed tx.

## Known-open, not blocking

| # | Finding | Why it can wait |
|---|---|---|
| N1 | `performCleanup` writes the on-chain job record from a `fullJob` snapshot taken at container start — empty completion signature, `hasReview:false` | Broker mode (our default) defers to the host inbox processor and is immune |
| N2 | `_budgetGateHit` is only reset on `_agentLoop` entry; post-delivery reworks take the plain path, so a stale `true` discards a good rework | Latent — needs the jailbox re-enabled to arm. **Will bite the day it is.** |
| N3 | Fork mode double-handles post-delivery IPC (rework runs twice) | `--dev-unsafe` gated. But it means dev behaves differently from prod, which is how three rounds of seam bugs survived |
| N4 | `events.jsonl` has no single-writer guard; overlapping daemons mint duplicate `seq` | Only reachable during a contested restart, which B-fixes make rarer |
| N5 | pid-file reuse: `SIGTERM` sent without verifying the pid is still a dispatcher | Environmental; needs pid recycling to hit |
| N6 | File-IPC read-then-unlink race can drop a message | Milliseconds wide; `_lastSentStatus` clearing now allows a retry |

## Not ours, tracked with backend

- Budget top-up approve+pay is unreachable — awaiting their choice of fix.
- Rework share undersized: 107 / 109 / 113 / 138 % overruns measured.
- `jobHash` 16-hex on bounty jobs vs 32 on hires; we recommended 32.

## What "production" needs beyond the blockers

1. **An upgrade path that is not "stop, hope, start".** We restarted ~12 times this
   cycle and found two distinct fleet-loss bugs doing it. B1 and B5 are both restart
   defects; fixing them is most of this.
2. **A smoke test an operator can run after install** — one command that proves
   registration, chat, a delivery and a fee tank, without needing a buyer.
3. **Honest first-run docs.** The README was corrected once already this cycle for
   overstating scale claims; the `encrypt-keys` → broken-Start interaction (B3) is
   exactly the kind of thing a new operator hits in the first hour.

## What still stands

Fixing the blockers did not make the remaining risks disappear, and two are worth
stating plainly before anyone calls this done:

1. **B2–B5 have no automated coverage.** They are process-lifecycle and interactive-TUI
   paths. B1 is covered and mutation-checked; the other four were verified by hand on a
   live restart. Every defect that reached production this cycle lived in exactly this
   kind of un-unit-testable path, so treat them as "observed working once", not "proven".
2. **The operator lifecycle has still never been run end to end by anyone.** Clean
   install → register → encrypt keys → start from the dashboard → take a job → restart
   mid-job → confirm the fleet returns. That sequence is the actual release gate and it
   remains outstanding.
3. The six known-open non-blockers above are unchanged. **N2** (`_budgetGateHit` never
   reset outside `_agentLoop`) will bite the day the jailbox is re-enabled.
4. One test remains intermittently flaky under full-suite CPU contention — the
   12-process send-lock race. It has never produced a `LOCK BREACH` (the assertion that
   would indicate a real double-holder); the failures are the starvation mode. Worth
   fixing so it stops masking a genuine regression one day.

## What the batch actually changed, live

- `/health` now degrades on an inactive fleet, and reported `ok` correctly through a
  full restart window — the false-alarm case caught on 2.18.0's own first restart and
  fixed in 2.18.1.
- A restart now performs **0 on-chain transactions**, down from 18 on a 9-agent fleet.

## Recommendation

**Fix B1–B5 as one batch, then re-run the operator lifecycle end to end** — install
clean, register, encrypt keys, start from the dashboard, take a job, restart mid-job,
confirm the fleet returns. That sequence has never been run start-to-finish by anyone,
which is precisely why it keeps producing defects.

Estimated: B1–B5 are each small and independent. The re-run is the expensive part and
the part that matters.
