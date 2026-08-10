# liveness — claims checklist

Every claim the README / CLAUDE.md makes that an operator would act on in this
domain: a default, a guarantee, a "refuses to", a threshold, a deadline, a
recovery promise.

**Domain as scoped.** Does the dispatcher keep making progress, and does it stop
cleanly? Loops that must keep turning (poll, inbox, fee-tank, cleanup), work that
must not stall (a job, a paused session, an open dispute, a queued job), processes
that must start and stop (PID handoff, drain, watchdogs), and the signals an
operator watches to know any of it is true (`/health`, `ctl`, skip counters).
Explicitly *not* whether the work is correct, safe, or paid for — those are the
money / keys / isolation / trust-boundary passes.

Legend: **VERIFIED** (code does what's claimed) · **DRIFT** (code differs — how)
· **MISSING** (no implementation found) · **UNVERIFIED** (could not determine).

---

## A. Overview claims (README 7-25)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| A1 | "Manages **unlimited concurrent agent workers** (configurable via `--max-concurrent`)" (README:7) | **DRIFT** | Default is *not* unlimited: `resolveCapacity({configMax: cfg.runtime.max_concurrent, estimate: _autoMax})` (`cli.js:136-139`) auto-follows a conservative hardware estimate (`hardware-sizing.js:14-27`) unless `config.toml` `runtime.max_concurrent > 0`. Separately, `--max-concurrent` is a `config` flag, not a `start` flag, and the value it writes is never read — see **L8**. |
| A2 | Poll mode: "Staggered 500ms between agents, with the interval scaling as `max(60s, agents x 1s)`" (README:11-12) | **VERIFIED** | Stagger `cli.js:6695`; interval `cli.js:3956`. |
| A3 | "**PID file** -- prevents duplicate dispatcher processes. New instance auto-kills previous." (README:15) | **DRIFT** | It no longer auto-kills. `cli.js:3183-3205` sends SIGTERM, then **waits up to 10 min** (`J41_STOP_WAIT_MS`, default `10*60*1000`), then **refuses to start** (`process.exit(1)`). The "prevents duplicates" half is stronger than documented; the "auto-kills" half is false. See **L12**. |
| A4 | "**Workspace auto-connect** -- job-agent polls for workspace status … (no IPC required in Docker mode)" (README:17) | **VERIFIED** | `job-agent.js:1270-1303`, 15 s self-rescheduling poller, stops only on connect or job end. |
| A5 | "**SovGuard 429 handling** -- … longer backoff on rate limits" (README:20) | **VERIFIED** | `auth-backoff.js:55` (429 retryable), `:77-84` honours `Retry-After`, `:117-122` exponential + ±25 % jitter, capped 5 min. Wired at `cli.js:4806-4841`. |
| A6 | "**Crash recovery** -- detects orphaned jobs on startup, handles refunds/cleanup" (README:21) | **VERIFIED** | `handleCrashRecovery` `cli.js:6398-6545`. Refunds are queued `pending_approval`, not auto-sent (`:6526-6538`) — a deliberate gate, documented under `refunds approve`. |
| A7 | "**Graceful drain shutdown** -- delivers in-progress jobs, submits attestations, and marks agents offline on Ctrl+C or SIGTERM" (README:22) | **VERIFIED** | `cli.js:4218-4391`, signal wiring `:4393-4394`. Qualified: the "marks agents offline" step can be cut short — see **L1**. |
| A8 | "**Docker IPC** -- file-based IPC (`/tmp/ipc-msg.json`)" (README:24) | **DRIFT** (cosmetic) | The path is `/tmp/ipc-msg.jsonl` (`job-agent.js:790`, writer `cli.js:4982`). One-JSON-per-line, not a single object. |
| A9 | "the dispatcher will hang mid-registration if [the job-agent image] is missing" (README:38) | **UNVERIFIED** | Not traced. `docker.createContainer` with a missing image rejects rather than hangs (`cli.js:8406`, caught at `:8571`); the registration path was not walked. Documented as a warning, so no operator harm either way. |

## B. Job lifecycle claims (README 227-237, 391-408, 424)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| B1 | "**Idle timeout** -- After configurable minutes of inactivity, the agent pauses the session (frees agent slot)" (README:234) | **VERIFIED** | Container: `job-agent.js:1307-1351` (10 s check against `IDLE_TIMEOUT_MS`), calls `pauseJob`. Dispatcher: local mode via `job_idle` IPC (`cli.js:8819-8825`); Docker mode via the poll fallback `shouldPauseOnPoll` (`reactivation-poll.js:21-28`, called `cli.js:6888-6893`) → `moveJobToReactivationQueue` frees the container. |
| B2 | "**Resume / TTL** -- Buyer can resume; **if pause TTL expires, the agent auto-delivers results**" (README:235) | **DRIFT / MISSING** | Resume is implemented (`cli.js:6870-6884`, `:6909-6934`, `:7302-7316`). Auto-deliver on TTL is not: `sweepExpiredQueue` (`cli.js:5409-5423`) only removes the queue entry and logs "platform auto-cancels/refunds". The `ttl_expired` IPC handler exists in the worker (`job-agent.js:745-749`) but **nothing in the repo sends that message** — grep for `ttl_expired` returns the handler and one comment. Also unreachable by construction: the container was destroyed at pause. See **L17**. |
| B3 | "Job timeout \| `--job-timeout` \| 60 \| Minutes per job (1-1440)" (README:395) | **VERIFIED** | `cli.js:140` (`jobTimeoutMin \|\| 60`), range check `cli.js:1216-1219`, forwarded to the container as `JOB_TIMEOUT_MS` (`cli.js:7950`), enforced container-side `job-agent.js:51,1762` and dispatcher-side at `+60 s` (`cli.js:8565`, `:8908`). |
| B4 | "`IDLE_TIMEOUT_MS` … default: 480000 ms / 8 min — deliberately before the backend's 10-min auto-deliver" (README:424) | **VERIFIED** | `job-agent.js:52`. Per-job override from `job.lifecycle.idleTimeout` at `cli.js:7972`. |
| B5 | "Max concurrent \| `--max-concurrent` \| unlimited" (README:394) | **DRIFT** | See A1 and **L8**. |
| B6 | "`--idle-timeout` 5-2880 min, default 10" / "`--pause-ttl` 15-10080 min, default 60" (README:406-407) | **VERIFIED** (partial) | The dispatcher-side default is honoured: `pauseTtlMin: job.lifecycle?.pauseTTL \|\| 60` (`cli.js:8879-8880`, `moveJobToReactivationQueue` `:5005`). The 5-2880 / 15-10080 *ranges* are service-registration validation and were not walked — platform-side. |
| B7 | "Extension … `extension_wait_ms` (default 600000) … **Not approved in time** → the session ends and delivers the partial work" (README:459-464, 481) | **VERIFIED** | `job-agent.js:57` (default), budget watchdog `job-agent.js:1357-1374` re-asks then `resolveSession('budget-exhausted')`. Plumbed `cli.js:8013`. |

## C. Scale / loop-health claims (README 324-373)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | "When a cycle overruns, the next one is skipped by the reentrancy guard" (README:361) | **VERIFIED** | Poll `cli.js:6661,6678-6690,7034-7036`; fee tank `cli.js:7714-7724,7824-7826`; inbox `cli.js:7834-7843`. |
| C2 | "a `[Poll]` / `[FeeTank]` warning naming the count" (README:363-364) | **VERIFIED** | `cli.js:6687`, `cli.js:7719`. |
| C3 | "`poll_cycles_skipped` / `fee_tank_cycles_skipped` in `/health`" (README:364) | **VERIFIED** | Written `cli.js:6686`, `cli.js:7718`; read `control.js:480-481`. Non-finite values coerce to 0 (`scale-observability.test.js:44-53`). |
| C4 | "Skipped cycles do **not** mark the daemon unhealthy" (README:372) | **VERIFIED** | `control.js:445-449` — `status` is driven by `containersUnhealthy`, dead letters and platform status only. |
| C5 | "Fee-tank checks … one API call per agent, against a 30-minute interval" (README:326-336) | **VERIFIED** | One `getUtxos` per agent (`cli.js:7734`), default interval `30 * 60000` (`cli.js:3419`), floor 60 s (`:3416`). |
| C6 | "a dispatcher restarted BECAUSE an agent ran dry should not stay dry for another 30 minutes" — a sweep runs shortly after start | **VERIFIED** | `cli.js:3978`, `setTimeout(…, 15000)`. |
| C7 | "run a second dispatcher against a different subset … needs `J41_HEALTH_PORT`, `J41_CONTROL_API_PORT` and `J41_EGRESS_PROXY_PORT` set to free values" (README:367-370) | **VERIFIED** (partial) | All three are overridable (`config-loader.js` `ENV_OVERRIDES`; egress bind `cli.js:4138-4149`, health bind `control.js:123`, control API `cli.js:4127-4129`). Not verified: whether the *PID file* permits it — `cli.js:3163-3209` is a single fixed path and would SIGTERM the sibling. Flagged, not reported: running two dispatchers is contrary to the rest of the design. |

## D. Health / control-plane claims (README 190-193, 655-717)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| D1 | "Health endpoint … **available whenever the dispatcher is running**" (README:193) | **DRIFT** | `startControlServer` (which binds `/health`, `control.js:123) is called at `cli.js:4114` — after the mainnet gate, the passphrase prompt, per-agent platform-status checks, capability load, dispute-policy load, security quick-check, refund drain, crash recovery and a full initial `pollForJobs`. None of that is bounded. See **L10**. Also `control.js:132-143`: after 10 failed binds it runs the rest of its life with no `/health` and says so. |
| D2 | "field **paths** are versioned API … `agents.0.status`, `containers.0.state`, `summary.containers_unhealthy`" (README:711-717) | **VERIFIED** | `control.js:391-416,459-485`. |
| D3 | "`above:0` on `summary.containers_unhealthy` is the canonical 'tell me when anything is wrong' watch" (README:716-717) | **DRIFT** | The counter is fed by `state._containerCrashes`, which in Docker mode is incremented at exactly one site (`cli.js:9089-9090`) reachable only from a branch that `AutoRemove` makes near-unreachable. See **L2**. |
| D4 | Health degrades on dead-lettered inbox items and on platform-inactive agents (README implied; `control.js:434-449`) | **VERIFIED** | `control.js:445-448`, gated on `state.startupComplete` (`cli.js:4403`). |
| D5 | "`auth_backoff_agents` … an outage looks identical to a hang without this" (`control.js:466-474`) | **VERIFIED** | `control.js:469-474` via `summarizeAuthBackoff`. |
| D6 | "`/v1/events` … file-backed ring buffer with a monotonic `seq` that survives restart" (README:698-701) | **VERIFIED** | `control-api.js:83-128` — re-seeds `seq` from `events.jsonl` on start, caps the ring, falls back to in-memory on write failure. |
| D7 | "`ctl shutdown` — trigger graceful shutdown from another terminal" (README:175, 667) | **VERIFIED** | `control.js:519` → `cli.js:4115` → `requestShutdown`. Refuses (exits 1) before `readyForShutdown` (`cli.js:4102-4110`). |
| D8 | "`ctl earnings` — per-agent VRSC earnings" / "`GET /v1/earnings` (hits the platform)" (README:664, 695) | **DRIFT** | Implemented (`control.js` `buildEarnings`), but the socket client imposes a hard 5 s deadline (`control.js:691-694`) on a routine that makes **2 serial platform calls per agent**. See **L11**. |

## E. Graceful-shutdown claims (README 719-728)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| E1 | "1. Stops accepting new jobs" | **VERIFIED** | `state.shuttingDown = true` (`cli.js:4274`) is read by `pollForJobs` (`cli.js:6671-6677`). |
| E2 | "2. Sends `shutdown` IPC to all active job-agents" | **VERIFIED** | `cli.js:4282-4288`. Delivery is best-effort in Docker mode — see **L13**. |
| E3 | "3. Each job-agent delivers current work, notifies the buyer, submits attestation" | **VERIFIED** | `job-agent.js:750-763` (session + post-delivery waiter), SIGTERM path `job-agent.js:1621-1663`. |
| E4 | "4. **Waits up to 30s for clean exit, then SIGTERM -> SIGKILL**" | **DRIFT** | There is no 30 s wait and no SIGKILL escalation. The drain runs to `drainTimeoutMs = (drainTimeoutMin \|\| jobTimeoutMin*2) * 60000` = **120 min** by default (`cli.js:4342-4343`), polling every 10 s (`:4359-4390`). The only 30 s constant is `HARD_EXIT_MS` (`cli.js:4253`), a **stall** detector that the drain interval re-kicks every 10 s (`:4363`) so it never fires during a healthy drain. On drain timeout the process exits **leaving containers running** (`:4379-4388`). See **L9**. |
| E5 | "5. Marks all agents offline on platform" | **VERIFIED**, qualified | `cli.js:4297-4332`. The loop can be cut short by the stall watchdog before the marker that makes it recoverable is written — see **L1**. |
| E6 | "6. Clears active-jobs.json and exits" | **VERIFIED** | `cli.js:4346-4354` (no active jobs) and `:4366-4377` (clean drain). Deliberately **not** cleared on drain timeout (`:4382`) so crash recovery refunds. |
| E7 | "Press Ctrl+C again for emergency exit" (`cli.js:4291`) | **VERIFIED** | `cli.js:4219-4223`. |
| E8 | `J41_NO_STATUS_TOGGLE=1` "skips the startup activate-all and shutdown deactivate-all loops … **Env-only by design**" (README:429) | **VERIFIED** | Read at `cli.js:4160` and `:4295`, from `process.env` only; absent from `ENV_OVERRIDES`. |

## F. CLAUDE.md claims

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| F1 | "Inbox accepts are BATCHED — one identity transaction per agent per poll cycle" | **VERIFIED** | `checkPendingInbox`/`runInboxSweep` `cli.js:7830-7846+`, reentrancy-guarded, 500 ms stagger (`:7857`). |
| F2 | "`TX_REJECTED` classifies as `contention` in `inbox-deadletter.js`, which never escalates — **so it retries forever, invisibly**" | **DRIFT** (stale doc, fixed in code) | `inbox-deadletter.js:201-216` now classifies on the daemon's `error.detail`: contention patterns → `contention`, `failed-precheck`/oversize/scriptpubkey/version → `hard`, **any other named reason → `hard`**. Only a detail-less rejection (older platform) still returns `contention`. The warning in CLAUDE.md now overstates the risk. |
| F3 | "the fee-tank sweep … wired as `checkFeeTanks()` in cli.js on its own 30-min timer" | **VERIFIED** | `cli.js:3974`. |
| F4 | "`update-profile` does NOT route through the inbox pending-write confirmation gate … Check `ctl inbox` / `/health` `pendingWrites` is empty first" | **VERIFIED** | Gate is `shouldDeferForPendingWrite` (`inbox-deadletter.js:273-284`), consulted only inside the inbox sweep. **The same hole exists on an automatic path this pass found**: shutdown's on-chain deactivate (`cli.js:4322-4324`) — see **L7**. |
| F5 | "`No spendable R-address UTXOs for fee` … classifies as **`transient`** (never counted, never dead-lettered)" | **VERIFIED** | `inbox-deadletter.js:161-166,198`. Consequence for liveness: such an item retries every cycle indefinitely, by design, and surfaces via `_agentErrors` / `fee_tanks_empty` rather than a dead letter. |
| F6 | "Recovery/classification helpers live in `src/inbox-deadletter.js`"; dead-letter after 5 consecutive *hard* failures | **VERIFIED** | `inbox-deadletter.js:26,39-57`; batch escalation counts only `hard` (`:309-333`). |

## G. Implicit guarantees the code itself asserts (in-code contracts an operator inherits)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| G1 | "Never let shutdown be best-effort" — shutdown MUST terminate the process (`cli.js:4226-4252`) | **VERIFIED** | Watchdog `cli.js:4253-4264`, `onShutdownFailed` `:4096-4100`, second-signal exit `:4219-4223`. Its *budget* is the defect — **L1**. |
| G2 | "Its own stall detector guarantees it exits, so waiting is bounded" (`cli.js:3182`) — the successor's 10-min wait is safe because the predecessor cannot hang | **VERIFIED**, with a caveat | True (G1), but a healthy 120-min drain is *not* a stall, so the successor's 10-min wait expires and it refuses to start (`cli.js:3196-3203`). Documented in the error text, not in the README. |
| G3 | Dispute hold: "the hard job timeout below defers while this is in the future … bounded (`J41_DISPUTE_HOLD_MAX_MS`, 6h default), so this cannot extend forever" (`job-agent.js:161-170,1687-1697`) | **DRIFT** | True container-side. The **dispatcher-side** timer (`cli.js:8558-8565`) has no equivalent deferral and kills the container at `JOB_TIMEOUT_MS + 60 s` regardless. See **L3**. |
| G4 | "Give up loudly instead" — `MAX_RECONCILE_ATTEMPTS_PER_JOB = 3`, "it will not be retried until the dispatcher restarts" (`cli.js:5229-5238,5352-5363`) | **VERIFIED**, and that is the problem | `state._reconcileAttempts` is never decremented or cleared on a *successful* respawn (`cli.js:5377`), so the cap counts lifetime respawns, not consecutive failures. See **L14**. |
| G5 | "C2: startJobContainer swallows its own boot failures … Verify placement explicitly so a silently-dropped boot doesn't lose the paid job" (`cli.js:5045-5053`) | **VERIFIED** | `respawnReadyResumes` re-queues when `state.active` did not gain the job. The *first-spawn* path (`cli.js:6819-6825`) has no equivalent check — but it also has no queue entry to lose, and `startJobContainer`'s catch returns the agent to the pool (`:8571-8581`). |
| G6 | "I4: OOM valve — guard every spawn path, not just respawns" (`cli.js:7016-7019`) | **VERIFIED** | `hasMemoryHeadroom` on the queue drain (`:7017`) and on respawn (`:5036`). **Not** on the first-spawn path at `:6819-6824` — a job discovered under capacity spawns without a memory check. Noted, not reported: `MAX_AGENTS` is already memory-derived (`hardware-sizing.js:24`). |
| G7 | "Guard all interval callbacks against unhandled rejections (async setInterval callbacks that throw will crash Node v20+)" (`cli.js:3551-3561`) | **VERIFIED**, with two exceptions | `safeInterval` is used for Poll, Inbox, FeeTank, ProfileSync, Cleanup, RefundDrain, DisputeSweep, SafetyPoll. Bare `setInterval(async …)` remains at `cli.js:3519-3543` (capability retry — body is internally try/caught) and the sync-only reporters at `:3236`, `:4055`. Backstopped by `process.on('unhandledRejection')` at `:4061-4063`. |
| G8 | "a departing dispatcher [must not delete] its successor's pid file" (`cli.js:3211-3221`) | **VERIFIED** | Ownership check before unlink. |
| G9 | Egress proxy bind failure is fatal — "refusing to start (jobs would have no egress path)" (`cli.js:4146-4149`) | **VERIFIED** | `process.exit(1)`. |
| G10 | `state.available` tracks genuinely-idle agents (implied by `/health` `agents_available` and the queue drain's `state.available.length > 0` guard) | **DRIFT** | The pool admits duplicates when one agent runs two jobs. See **L15**. |

---

## Tally

**44 claims** — 28 VERIFIED · 11 DRIFT (A1, A3, A8, B2, B5, D1, D3, D8, E4, F2, G3, G10 — B2 is DRIFT+MISSING and is counted once) · 1 MISSING (B2's auto-deliver half) · 2 UNVERIFIED (A9, and the B6 range validation, both platform-side or cosmetic).

Two VERIFIED entries are qualified in place: **A7/E5** (the shutdown drain is implemented as documented, but the deactivate loop it depends on can be cut short → L1) and **G4** (the reconcile cap works exactly as written, and that is what strands a long-running dispute → L14).
