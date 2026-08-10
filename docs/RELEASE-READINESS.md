# Dispatcher — release readiness

**Date:** 2026-08-10 (rewritten after eight domain audits)
**Assessed build:** 2.20.0, 955 tests, 9-agent fleet on VRSCTEST
**Verdict: NOT shippable. Eight parallel audits returned ~106 findings — 1 critical,
17 high. Four are fixed. The previous verdict on this page ("shippable to a pilot
operator") was wrong and is retracted.**

---

## Why the previous verdict was wrong

The 2026-08-09 assessment looked at five operator-surface blockers I had found by
following live testing, fixed them, and called the product close. Eight targeted audits
then found **twenty times** as many issues, including one that destroys private keys and
one that makes the documented install impossible. My assessment was not wrong in what it
said — it was wrong in how little it had looked at. Live testing finds what testers
happen to do; it does not find what nobody has tried.

Three of the audit findings landed on claims I had personally made:

- **L3** — I fixed the container-side dispute clock in 2.17.1 and reported the hold
  working. There was a **fourth** clock in the dispatcher that killed the worker anyway.
  My own memory note said there were three.
- **X1** — Fable flagged the `startJob` argument swap on 2026-08-06. I passed it on as
  "not verified by me" and never came back to it. It was real, and every
  bounty-awarded job was silently never started.
- **D1** — I published sixteen releases without ever checking that the tarball could
  produce a working install.

## Fixed in 2.20.0

| # | Sev | Finding |
|---|---|---|
| K1 | **crit** | `writeKeysFile` could drop a plaintext key-less file over encrypted key material — WIF gone, no backup. Guarded in the primitive. Only fires after `encrypt-keys`, i.e. the hardening we recommend created the exposure |
| D1 | high | `scripts/`, `Dockerfile.job-agent`, `package.docker.json` were missing from the npm tarball while the README makes building the image mandatory |
| L3 | high | Fourth clock: the dispatcher's own `JOB_TIMEOUT_MS+60s` killed workers holding an open dispute |
| X1 | high | `bounty.awarded` called `startJob` with swapped arguments; awarded jobs never started |

## Open — 13 high, triaged

**Fail-open on the operator's own path (first-run).** F1 `setup` reports success with an
empty on-chain identity and the documented recovery is a no-op. F2 `ollama`/`lmstudio`/
`vllm` resolve an empty key, so template filler is delivered and hashed as the paid work
product. F3 `quickstart` prints an env var the container never reads. F7 both installers
default to `local` runtime without Docker and accept paid jobs before refusing them.
**These make a first install produce a dispatcher that takes money and returns nothing.**

**Money.** M1 the streaming proxy bills the full worst-case reservation when the upstream
returns 503 — status code is never consulted before billing. M2 the non-streaming path
never got the same hardening and under-bills instead.

**Isolation.** I1 `Content-Disposition` filename is unsanitised and lands in the host
broker's watch dir — a forged `executeOnChain` drains the fee tank. I2 resume rewrites
`description.txt` following symlinks, giving an arbitrary host-path overwrite.

**Liveness.** L1 the shutdown stall watchdog budgets 30 s against a ~93 s SDK worst case
and writes the restore marker only after the whole loop. L2 `AutoRemove: true` races the
inspect poller, so Docker container crashes are invisible — `containers_unhealthy`, the
README's canonical alarm, is pinned at 0 in the production runtime.

**Scale.** S1 the documented scale remedy takes the operator's own fleet down. S2 the
poll cycle is ~3 round trips per agent, not one, so the published table is wrong from
N=31. S3 `/j41/deposit/report` does outbound work before the signature check with no
rate limit. S4/S5 two costs with no steady state.

**Keys.** K2 `init` never calls the unlock guard, so new agents land plaintext on an
encrypted pool.

## The pattern worth acting on

Four separate audits independently reported the same shape: **a control that already
exists in this codebase, correctly implemented, simply not applied at a second site.**
`O_NOFOLLOW` on the read path but not the write. Nonce-after-verify on one route but not
its neighbour. A scan on arrival but not on re-entry. A rate limit on one webhook route
but not the adjacent one. That is not a knowledge gap; it is a review gap, and it is
cheap to close with a checklist of "where else does this pattern appear".

## Recommendation

**Do not ship.** Next batch, in order: the four first-run fail-opens (F1/F2/F3/F7),
because they are what a new operator hits in the first ten minutes; then M1/M2 and
I1/I2; then L1/L2 and K2. Scale and docs-truth after, since they mislead rather than
break.

The full reports are in `AUDIT/`, with per-domain claim checklists.

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
