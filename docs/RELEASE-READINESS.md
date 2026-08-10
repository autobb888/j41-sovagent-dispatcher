# Dispatcher — release readiness

**Date:** 2026-08-10 (updated — all audit highs closed)
**Assessed build:** 2.24.0, 971 tests, 9-agent fleet on VRSCTEST
**Verdict: still NOT shippable, but for a different reason than a week ago.** The
1 critical and all 17 high findings from the eight domain audits are fixed. What blocks
release now is coverage, not known defects: ~40 mediums are untriaged, one high is only
partially fixed, and the full operator lifecycle has never been run end to end.

---

## What changed since the audits

| Rel | Findings closed |
|---|---|
| 2.20.0 | **K1 (crit)** key destruction · **D1** unrunnable npm install · **L3** 4th dispute clock · **X1** bounty arg swap |
| 2.21.0 | **F1/F2/F3/F7** the four first-run fail-opens |
| 2.22.0 | **M1/M2** proxy billed for upstream errors · **I1 (partial)** file traversal · **I2** symlink write |
| 2.23.0 | **L2** invisible container crashes · **L1** shutdown fleet-strand · **K2** `init` key downgrade |
| 2.24.0 | **S3** deposit nonce/rate-limit · **S1** the scale remedy that killed your fleet |

Two of these are worth remembering beyond the fix:

- **L2** means `summary.containers_unhealthy` — the README's canonical "tell me when
  anything is wrong" watch — had **never been able to fire** in the Docker runtime. It
  now reports, and the live fleet immediately went `degraded` on real crashes that were
  previously discarded.
- **K1** only fired *after* an operator ran `encrypt-keys`. The hardening we recommend
  was what created the exposure.

## Still open, ranked

**I1-residual (high, partial).** A downloaded file is verified to have landed inside
the job directory and removed if it escaped — but it exists briefly at the escaped path
first, and a broker poll could read it. The durable fix is broker-side: act only on
request files the host itself created. **This is the one genuinely unfinished high.**

**~40 mediums, untriaged.** Distribution: trust-boundary 7, liveness 8, scale 7,
isolation 5, docs-truth 5, money 3, keys 2, first-run 3. Triage is the next task.

**~45 lows.** Mostly documentation drift.

## The gate that has not moved

The full operator lifecycle — clean install → register → encrypt keys → dashboard start
→ take a job → restart mid-job → confirm the fleet returns — **has still never been run
start to finish by anyone.** Two audits (first-run, docs-truth) found four highs in
exactly that path, including an install that could not produce a runnable dispatcher.
Until someone walks it on a clean machine, "shippable" is an assertion, not a finding.

## What the audits taught, worth keeping

Four independent domains reported the same defect shape: **a control that exists in
this codebase, correctly implemented, simply not applied at a second site.**
`O_NOFOLLOW` on the read path but not the write. `checkNonceAfterVerify` on one route
but not its neighbour — with the attack documented in the same file. A rate limit
whose comment says it prevents amplification DoS, on one of two adjacent routes. A
scan on arrival but not on re-entry.

Every one of those was cheap to fix once named. The cheap systemic defence is a
"where else does this pattern appear?" pass whenever a control is added — which is now
encoded as a derived test for the encryption guard, and should be for the others.

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
