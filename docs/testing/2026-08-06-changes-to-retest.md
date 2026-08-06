# Dispatcher changes to retest — 2.11.0 → 2.12.0

**For:** the tester
**Date:** 2026-08-06
**Live now:** dispatcher **2.12.0** (`22170da`), SDK 2.14.1, MCP 2.2.3 — all on npm.
**Nine releases** since the round-5 brief. 10 source files changed, 9 test files
added, 866 tests (669 before).

This is the **list of what changed**, so you can retest each one. A prioritised
walkthrough with exact commands is the companion doc:
`2026-08-06-round6-test-script.md`.

**Nothing here is a new feature except two commands.** Everything else is a bug
that was already shipped and is now fixed — so the question for each row is
"did the fix work, and did it break the thing next to it".

---

## Behaviour you will notice immediately

| # | Change | Retest by |
|---|---|---|
| 1 | **`refunds list` now shows BLOCKED refunds first.** Previously a blocked refund was `approved`, which the default filter hid — so the list said "No pending refunds" while money was stuck. | `j41-dispatcher refunds list` on a normal fleet: unchanged output. Script step 2 fabricates a blocked one. |
| 2 | **New: `refunds unblock <job-id>`.** Human override for a refund whose send outcome is unknown. Requires typing `yes`; `--yes` is refused. | Script step 2. |
| 3 | **Earnings screen shows real precision.** `0.005` used to display as `0.01`, and anything under half a cent as `0.00` — earnings shown as nothing. | Dashboard → **[13] Earnings Summary**; compare against `j41-dispatcher wallet`. |
| 4 | **`/health` has three new counters:** `auth_backoff_agents`, `poll_cycles_skipped`, `fee_tank_cycles_skipped`. | `curl -s localhost:9842/health \| jq .summary` — all `0` on a healthy fleet. |
| 5 | **New log lines:** `[Auth] … Backing off Ns`, `[Poll] previous cycle still running`, `[FeeTank] previous check still running`. | Only appear under stress/outage. Their absence on a healthy fleet is correct. |

---

## Money paths — retest with the most care

| # | What was broken | What changed | Regression risk to watch |
|---|---|---|---|
| 6 | **A failed refund send wedged forever.** The pre-broadcast marker was cleared only on success, so *any* throw — an empty fee tank, a dropped connection — left it behind. The log promised "will retry on next start"; it could not. A routine dry tank turned an owed refund into a permanently unpaid one. | Failures split: **pre-broadcast** (funding failure — nothing left the host) clears the marker and retries; **ambiguous** (timeout, dropped connection) keeps it and records the error. | The dangerous direction is the *other* way: a refund paid **twice**. If you ever see two refunds for one job, stop and report immediately. |
| 7 | **The send lock admitted several holders at once.** 10 processes racing one stale lock produced 2–5 "winners" in 12 of 15 rounds. Each would have broadcast. | Rewritten three times before it was right: liveness check, then an exclusive gate, then the real cause — a lock file is **created empty and filled a moment later**, and empty was being read as "stale", so a lock could be stolen *while being created*. | Two terminals, same agent, `wallet send`. Second must refuse. **Leave the first at its prompt for over two minutes** — a slow human must not look like a crashed process. |
| 8 | **A live lock holder was robbed after 120s.** `wallet send` holds its lock across the confirmation prompt, so an operator who read carefully lost it to a second invocation. | The lock now tests whether the holder is **dead** (`kill(pid,0)`), not whether it is **old**. | As above — the >2-minute prompt case is the test. |
| 9 | **Money planners accepted nonsense numbers.** `0.5` and `1e21` are finite but not valid satoshi counts; a fractional `remainingSats` was being shown to operators. | `Number.isSafeInteger` throughout `summarizeUtxos`, both planners and `summarizeFleet`. | Any fractional or absurd figure in `wallet`, `wallet show` or the Earnings screen. |
| 10 | **`classifyInboxFailure` and `isFundingFailure` could disagree** — the daemon logged `FEE TANK EMPTY` *and* struck the item toward a dead letter in the same breath. | Funding is checked first, so they cannot diverge. | A dry tank must produce **zero** dead letters. `deadLettered` stays 0 in `/health`. |

---

## Security

| # | What was broken | What changed | Retest by |
|---|---|---|---|
| 11 | **`encrypt-keys` in a non-TTY exited 0 having encrypted nothing** — prompt printed, nothing read, every WIF left in plaintext, no error. Scripted key encryption silently did not happen. | Refuses with exit 1 and says explicitly that the keys are **still plaintext**. | Script step 4a. `HOME=$SB j41-dispatcher encrypt-keys < /dev/null` |
| 12 | **An interrupted `encrypt-keys` left WIFs plaintext permanently** — master key present, some keys still clear, and the command then refused to run again ("already encrypted"). | Detects stragglers by name, unlocks with the existing passphrase, finishes the job. | Script step 4c. |
| 13 | **One corrupt `keys.json` aborted the whole pool mid-loop**, which in the new-passphrase path manufactured the very half-encrypted state above. | Skips and warns; the rest of the pool completes. | Put a truncated `keys.json` in a scratch pool and re-run. |
| 14 | **Six bypass flags were missing from the mainnet gate** (2.11.0, carried from the round-5 brief). | `J41_DEPOSIT_ALLOW_AUTH_ONLY`, `J41_ALLOW_UNPRICED_JOBS`, `J41_SCAN_BUYER_CHAT=0`, `J41_ALLOW_INSECURE`, `J41_LOCAL_SIGNER_TEST_MODE`, `J41_TRUST_PLATFORM_RESOLUTION` now refuse a **mainnet** start. | Pure function — testable without touching mainnet. Script step 9 of the round-5 brief. |

---

## Resilience

| # | What was broken | What changed | Retest by |
|---|---|---|---|
| 15 | **No backoff on `503 CHAIN_SYNCING`.** Every caller re-authenticated every cycle — ~908 failures in the 2026-07-31 outage, until the platform returned `429`. The ban outlasted the outage. | Exponential from 5s, jittered ±25%, capped at 5 min. Only waits for failures that end by themselves — a **401 still fails loudly every cycle**. | **Script step 1 — time-bound.** The outage recurs around 04:00 UTC. This is the only change proven solely in simulation. |
| 16 | **A crash mid-write made the dispatcher forget every completed job.** `seen-jobs.json` was written non-atomically; a truncated file read as *empty*, which is indistinguishable from a first run — so every completed job looked new. | Atomic temp+rename. A corrupt file is reported and quarantined as `.corrupt.<ts>`; **absent stays silent**, because a first run is not a fault. | `kill -9` the daemon during a busy period, restart, confirm no re-processing and no `.corrupt.*` file. |
| 17 | **A corrupt `finalize-state.json` read as "never finalized"** — which can send an operator back through a registration flow that writes on-chain and costs money. | Names the agent and the file instead of returning null in silence. | Truncate one in a scratch HOME; it must warn, not stay quiet. |
| 18 | **Two of three loops went silent when they fell behind.** `pollForJobs` and `checkFeeTanks` returned with no log — the fleet stopped looking for work and tanks stopped being watched, while everything reported healthy. | Both warn with a running count and expose a `/health` counter. Skips deliberately do **not** flip `status` to degraded — they are a capacity signal, not a fault. | `--fee-sweep-floor 200000` to force sweeps, or a high agent count. Counters must rise; `status` must stay `ok`. |
| 19 | **A second dispatcher could not run on one host** — `EGRESS_PROXY_PORT` was a hard constant and a bind failure is fatal. | `J41_EGRESS_PROXY_PORT` (default 9847). Needed with `J41_HEALTH_PORT`, `J41_CONTROL_API_PORT` **and a separate `HOME`**. | Start a scratch daemon alongside the live one. |

---

## Documentation corrected (worth a read, not a test)

| # | Was | Now |
|---|---|---|
| 20 | README claimed **"dynamic interval scaling for 100+ agents"** | A **Scale** section with measured fee-tank figures and a *derived* poll table. The real model: a round trip **≤500 ms never overruns at any agent count**; it is a latency question, not an agent-count question. |
| 21 | No upgrade guidance | `docs/testing/upgrade-checklist.md` (2.8.x → 2.11.x), including the `J41_FEE_SWEEP_INTERVAL` → `_INTERVAL_MS` rename, now silently ignored under the old name. |
| 22 | TUI had no coverage of any kind | `docs/testing/tui-manual-checklist.md`. Leads with: **[7] Start and [8] Stop act the moment you press Enter — no confirmation step.** |

---

## Not changed, still true from earlier rounds

- The **fee-tank sweep** (2.9.0) has still **never fired unattended** — every tank is
  above the floor, so we have only seen it decline to act. Script step 6.
- **Never-earned agents** (`agent-8`, `agent-template-test`, `agent-test-1`) are zero at
  both addresses and cannot self-fund. Day-one operator path, still unexercised.
  Script step 5.
- `DISPUTE_RESOLVER_ENABLED` is still waiting on two answers from backend.

## Where I expect breakage, ranked

1. **The Earnings screen** — the only surface with zero automated coverage, by
   construction (`dashboard.js` needs a TTY and cannot be imported by the runner).
2. **Auth backoff under a real outage** — simulation only.
3. **`refunds unblock`** — new, money-adjacent, unit-tested only.
4. **The sweep firing unattended** — proven manually and in units; the daemon's own
   path has only ever declined.
5. **The `wallet` daemon-busy check** — has never run live; the pid file was absent in
   every test. A spurious *"another wallet command is spending"* is that.

## If something looks wrong

Include: the command, the full output, `curl -s localhost:9842/health | jq .summary`,
and anything named `*.corrupt.*` or `*.inflight.json` under `~/.j41/dispatcher/`.

**Stop immediately and report** if you ever see two refunds for one job, or two
`wallet` commands both broadcasting for the same agent. Everything else can wait
for the write-up.
