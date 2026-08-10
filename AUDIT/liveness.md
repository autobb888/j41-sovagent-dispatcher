# liveness — soft-launch audit

**Date:** 2026-08-10 · **Scope:** does the dispatcher keep making progress, and
does it stop cleanly · **Method:** read-only, static trace to `file:line`

**Counts:** crit 0 · high 3 · med 8 · low 6 · **total 17**

Claims checklist: `AUDIT/liveness-claims.md` (44 claims, 28 VERIFIED / 11 DRIFT /
1 MISSING / 2 UNVERIFIED).

---

## Findings

| # | Sev | Finding | Anchor |
|---|---|---|---|
| L1 | high | Shutdown's 30 s stall watchdog is shorter than one agent's worst-case deactivation, and the "restore me next start" marker is written only after the whole loop — a forced exit leaves the fleet inactive and unrecoverable | `cli.js:4253` |
| L2 | high | In Docker mode a crashed container is indistinguishable from a clean exit: `AutoRemove` deletes it before the 10 s poller looks, so no retry, no abandoned-job refund, no `container.died`, and `containers_unhealthy` — the documented canonical watch — can never fire | `cli.js:9101` |
| L3 | high | The dispatcher's per-job timeout kills a worker that is holding an open dispute, defeating the container-side hold; the reconciler burns its 3 respawns in ~3 h and then abandons the job until the daemon restarts | `cli.js:8558` |
| L4 | med | Any `container.inspect()` error is treated as "container gone" — a Docker daemon restart tears down every in-flight job, frees the agents, deletes the job dirs, issues no refund, and the 7-day `seen` entry stops them ever being re-picked | `cli.js:9101` |
| L5 | med | Jobs queued at capacity are recorded in the persisted `seen` set but the queue itself is memory-only — a restart drops them permanently for 7 days | `cli.js:6816` |
| L6 | med | The queue drain pops an arbitrary available agent and ignores the job's `assignedAgent`, so a queued job can be started under an agent that is not its seller | `cli.js:7022` |
| L7 | med | Shutdown's on-chain deactivate writes an identity tx outside the inbox batch and outside the pending-write gate, and swallows the rejection — the agent stays `active` on-chain while reporting offline | `cli.js:4322` |
| L8 | med | `config --max-concurrent` writes a value nothing reads; `config --show` prints it back, confirming a cap the daemon does not apply | `cli.js:1210` |
| L9 | med | README promises shutdown "waits up to 30s … then SIGTERM -> SIGKILL"; the real drain runs up to 120 min with no kill escalation, so default systemd `TimeoutStopSec` SIGKILLs the dispatcher and orphans its containers | `cli.js:4343` |
| L10 | med | `/health` and the `ctl` socket bind only after an unbounded startup sequence — during a platform slowdown the process runs for minutes with monitoring reading "down" and no way to stop it cleanly | `cli.js:4114` |
| L11 | med | `ctl earnings` makes two serial platform calls per agent against a hard 5 s client deadline — it fails on any real fleet | `control.js:691` |
| L12 | low | README's "New instance auto-kills previous" is false: `start` waits up to 10 min for the predecessor and then refuses to start | `cli.js:3185` |
| L13 | low | The Docker IPC file is read then unlinked non-atomically; a message written in that window is deleted unread, and there is no ack or retry | `job-agent.js:794` |
| L14 | low | `_reconcileAttempts` counts lifetime respawns, never consecutive failures — a dispute that legitimately needs a 4th worker over its multi-day window is abandoned | `cli.js:5377` |
| L15 | low | `state.available` accumulates duplicate entries when one agent runs two jobs, inflating `agents_available` and letting the drain hand the same agent out twice | `cli.js:8685` |
| L16 | low | `sendCommand`'s 5 s timeout is never cleared or unref'd, so every `ctl` invocation lingers ~5 s after printing | `control.js:691` |
| L17 | low | Pause-TTL expiry silently drops the queue entry; the documented "the agent auto-delivers results" has no sender for its `ttl_expired` IPC and no worker left to receive it | `cli.js:5417` |

---

### L1 — high — shutdown's stall watchdog can strand the whole fleet inactive

**Where:** `src/cli.js:4253` (`HARD_EXIT_MS = 30000`), `:4255-4264` (`kickWatchdog`),
`:4297-4332` (deactivate loop), `:4336` (`writeShutdownDeactivated`).

**Path.** `gracefulShutdown` arms a *stall* detector: 30 s with no `kickWatchdog`
call means "genuinely stuck → `process.exit(1)`". The deactivate loop kicks it
**once per agent, before** that agent's work (`:4305`). That agent's work is
`getAgentSession` → `client.setAgentStatus` → `agent.setOnChainStatus('inactive')`
→ `client.refreshAgent` — four platform round trips, serially, with no
intermediate kick.

The SDK gives each of those a 30 s timeout and **3 attempts** with 1 s/2 s
exponential backoff (`node_modules/@junction41/sovagent-sdk/dist/client/index.js:22-23`,
`:80`, `:163-189`). A single request's worst case is therefore
`30 + 1 + 30 + 2 + 30 ≈ 93 s` — already past the 30 s budget before the second
call in the agent's sequence.

`_deactivatedByShutdown` is accumulated in memory inside the loop (`:4318`) and
persisted **only after the loop finishes** (`:4336`). A watchdog exit mid-loop
therefore writes nothing.

Next `start` reads the (absent) marker (`:3274`), finds those agents `inactive`
on the platform, and takes the `else` branch at `:3321-3325` — "`inactive` on
platform — skipping". If that covers every agent, startup dies at `:3356-3366`
with "No agents available to poll". The comment at `:4244-4247` names this exact
outcome — "the mechanism behind *the restart lost my fleet, but only sometimes*"
— as the thing the stall detector was supposed to stop being.

**Trigger.** Any shutdown while the platform is slow rather than down. Slow is
the common case: a degraded/hang-mode platform is *why* an operator restarts, and
`auth-backoff` deliberately does **not** cover already-authenticated calls
(sessions are cached 10 min, `cli.js:4735`), so `setAgentStatus` gets the full
93 s. One slow agent is enough — the fleet-loss is proportional to how far down
the list the exit lands. The `kickWatchdog('start')` at `:4264` is also exposed:
the shutdown-IPC loop above it (`:4282-4288`) uses `execFileSync` with a 5 s
timeout per active job (`:4983`) and never kicks, so ≥7 wedged containers blow
the budget before the deactivate loop begins.

**Severity.** high. Fleet-wide, silent, and it lands on the operator as a
re-registration prompt for agents that are merely offline.

**Proposed fix (not applied).**
1. Persist incrementally: move `writeShutdownDeactivated(_deactivatedByShutdown)`
   *inside* the loop, after each successful `setAgentStatus`. The file is a
   tmp+rename atomic write (`:5200-5209`) and the list is tiny, so per-agent cost
   is negligible and any exit point leaves a correct marker.
2. Kick the watchdog between the calls within one agent, not just between agents
   — or raise `HARD_EXIT_MS` above the SDK's 93 s single-request worst case.
3. Consider constructing the shutdown-path `J41Agent` with a shorter
   `timeout`/`maxRetries`: a shutdown is not the moment to retry three times.

---

### L2 — high — Docker-mode container crashes are invisible

**Where:** `src/cli.js:8363` (`AutoRemove: !keepContainers`), `:9046-9104`
(`cleanupCompletedJobs`, Docker branch), `:9055-9098` (retry + abandoned-refund),
`:9101-9104` (catch-all), `src/control.js:415-422,464`
(`summary.containers_unhealthy`).

**Path.** Containers are created with `AutoRemove: true` (default —
`keep_containers` is `false`, `config-loader.js:14`). The only liveness check on
a running job is `container.inspect()` inside `cleanupCompletedJobs`, on a 10 s
interval (`cli.js:4044`).

When a container exits, the daemon removes it within milliseconds. The next
`inspect()` — up to 10 s later — throws *no such container*, which lands in the
catch at `:9101`:

```js
} catch (e) {
  console.log(`🗑️  Container for job ${jobId} gone`);
  await stopJobContainer(state, jobId);
}
```

Everything downstream of a **non-zero** exit therefore never runs:

- the retry ladder at `:9055-9078` (`MAX_RETRIES = 2`, `cli.js:141`);
- `refundAbandonedJob` at `:9094` — the whole point of which is that
  `stopJobContainer` deletes the job from `active-jobs.json` before crash
  recovery could ever see it (`cli.js:6547-6556`). Its pure builder is
  well-tested (`test/abandoned-job-refund.test.js`); its only Docker caller is
  behind this branch;
- `state._containerCrashes` (`:9089-9090`) and the `container.died` event
  (`:9092`).

`_containerCrashes` is the sole input to `summary.containers_unhealthy`
(`control.js:419-422`). Its other writer, `cli.js:8809-8814`, is the **local**
(`--dev-unsafe`) child-process path. So in the production runtime the counter is
pinned at 0, and README:716-717's "`above:0` on `summary.containers_unhealthy` is
the canonical *tell me when anything is wrong* watch" watches nothing.

Meanwhile the job is already in the persisted `seen` set (`:8498-8499`) with a
7-day TTL (`cli.js:142,526-539`), so `pollForJobs` skips it forever
(`:6734-6736`). The agent is returned to the pool (`:8685`) and the job dir is
deleted (`:8678-8681`). A paid job the container crashed on is simply gone.

**Trigger.** Any non-zero container exit. Concretely, from untrusted input: the
container is capped at 2 GB with `OomScoreAdj: 1000` (`cli.js:8364,8380`), so a
buyer whose files/conversation push the worker over the limit gets it OOM-killed
(exit 137) — and the dispatcher records a clean completion.

**Note.** The exit code is *already available* at the catch: `container.wait()`
at `:8531-8533` stamps `activeEntry._exitCode` on exit, and `archiveJobLog` at
`:8677` reads it two lines below the catch. The retry/refund decision simply does
not consult it. (Caveat: `wait()` is attached inside the `try` that begins with
`await container.logs(...)` at `:8511`, so a log-stream failure leaves
`_exitCode` undefined.)

**Severity.** high. Silent loss of a paid job plus a permanently blind health
watch, in the default runtime.

**Proposed fix (not applied).** In the catch, distinguish *removed* from
*unreachable* (see L4), and on "removed" route through the existing exit-code
logic rather than straight to teardown:

```js
} catch (e) {
  if (!isNoSuchContainer(e)) { /* L4: daemon unreachable — skip this cycle */ continue; }
  const code = active._exitCode;                 // set by container.wait()
  if (code === undefined) { /* unknown: treat as crash, not as success */ }
  ... same retry / refundAbandonedJob / _containerCrashes path as :9055-9098 ...
}
```
Attach `container.wait()` outside the log-streaming `try` so `_exitCode` is
populated even when log streaming fails. Optionally set `AutoRemove: false` and
remove explicitly in `stopJobContainer`, which makes the exit status readable at
leisure and is what the `keep_containers` debug path already does.

---

### L3 — high — the dispatcher kills workers that are holding an open dispute

**Where:** `src/cli.js:8558-8565` (Docker) and `:8902-8908` (local) — the per-job
timer; `src/job-agent.js:161-170,1687-1697` (the container-side dispute hold);
`src/cli.js:5238,5352-5363` (the reconciler's give-up cap).

**Path.** The container's own hard timeout was fixed to defer while a dispute is
being held:

```js
const remaining = _disputeHoldUntilMs - Date.now();
if (remaining > 0) { … setTimeout(_hardTimeout, remaining + 1000); return; }   // job-agent.js:1691-1697
```
bounded by `J41_DISPUTE_HOLD_MAX_MS`, 6 h default (`job-agent.js:1935-1939`), and
set from the real dispute deadline (`:1961-1977`).

The dispatcher has a *second, independent* timer:

```js
const _timeoutTimer = setTimeout(async () => { … await stopJobContainer(state, job.id); },
                                 JOB_TIMEOUT_MS + 60000);                        // cli.js:8558-8565
```
It has no dispute awareness. `_timeoutTimer` is only ever created and cleared
(`:8569`, `:8691`, `:8912`, `:8974`) — never extended. At 61 minutes it calls
`container.stop()`, the worker takes SIGTERM (`job-agent.js:1621`), signs its
attestation and exits 130 — mid-hold, having told the operator it was holding for
360 min.

The comment at `job-agent.js:161-169` describes precisely the resulting loop and
believes it fixed: *"The reconciler respawned it, each replacement died the same
way, and after three attempts it gave up permanently — leaving a live dispute
with no worker and no respawn."* The fix covered one of the two timers.

The loop closes as follows. The dead worker leaves `state.active`;
`reconcileOrphanedDisputes` (`cli.js:5310-5398`, run from every poll cycle at
`:6904`) sees a `disputed` job with no worker and respawns via
`queueDisputedJobForRespawn` → `respawnReadyResumes` → `startJob` →
`startJobContainer` → **a fresh 61-minute timer**. `attempts.set(job.id,
priorAttempts + 1)` at `:5377`. After `MAX_RECONCILE_ATTEMPTS_PER_JOB = 3`
(`:5238`) — roughly three hours — `:5352-5363` gives up loudly and, per its own
message, *"will not be retried until the dispatcher restarts."* A dispute
deadline is days.

**Trigger.** Buyer-initiated and routine: file a dispute on any job whose
container has been up for more than a few minutes. Default `jobTimeoutMin` is 60.

**Severity.** high. Buyer-triggered, ends in a dispute lapsing on the platform's
default terms with no seller representation.

**Proposed fix (not applied).** Give the dispatcher timer the same deferral the
container has. On the `disputed` / `rework` transition in the post-delivery loop
(`cli.js:6853-6861`) — and on the dispute respawn path — clear `_timeoutTimer`
and re-arm it for the hold window the worker reported (or for
`J41_DISPUTE_HOLD_MAX_MS + grace`, which the container already bounds). Cheapest
correct version: have the worker echo its `_disputeHoldUntilMs` back over IPC and
have `stopJobContainer`'s timer callback re-arm rather than kill while that
stamp is in the future. Separately, reset `attempts` on a respawn that succeeds
(L14) so the cap counts consecutive failures rather than lifetime respawns.

---

### L4 — med — a Docker daemon blip tears down every in-flight job

**Where:** `src/cli.js:9046-9048` (`container.inspect()`), `:9101-9104` (catch).

**Path.** The catch is unconditional on the error:

```js
const container = docker.getContainer(`j41-job-${jobId}`);
const info = await container.inspect();      // :9048
…
} catch (e) {
  console.log(`🗑️  Container for job ${jobId} gone`);   // :9102
  await stopJobContainer(state, jobId);
}
```
`inspect()` throws for *no such container* (the intended case) and equally for
`connect ENOENT /var/run/docker.sock`, `ECONNRESET`, `EACCES`, or a socket
timeout. `stopJobContainer` itself discriminates 404 from other errors
(`:8637-8641`); this caller does not.

Because `cleanupCompletedJobs` iterates the whole of `state.active` every 10 s
(`cli.js:4044`), one unreachable daemon means **every** active job is declared
gone in a single pass: agents pushed back to the pool (`:8685`), job directories
`rmSync`'d (`:8678-8681`), `active-jobs.json` rewritten empty (`:8694`), signing
channels destroyed (`:8650`), egress tokens revoked (`:8659`). No refund is
queued — that path is only reachable via the non-zero-exit branch (L2) — and
`state.seen` still holds each job for 7 days, so `pollForJobs` will not re-pick
them (`:6734-6736`). The containers themselves may well still be running.

**Trigger.** `systemctl restart docker`, a Docker Desktop update, `dockerd`
reloading a daemon.json, or the socket being momentarily unavailable — a routine
host maintenance action.

**Severity.** med. Requires a host event rather than untrusted input, but the
blast radius is every paid job in flight and there is no recovery path.

**Proposed fix (not applied).** Classify the error before acting. Treat only a
404 / `no such container` as "gone"; on any other error log once and `continue`
— leaving the entry in `state.active` so the next 10 s pass retries. Optionally
add a consecutive-failure counter that, after N cycles of an unreachable daemon,
marks the dispatcher `degraded` in `/health` instead of silently reaping.

---

### L5 — med — jobs queued at capacity do not survive a restart

**Where:** `src/cli.js:6816-6821`, `:7015-7033`, `src/config.js` (no queue
persistence), `cli.js:142` (`SEEN_JOBS_TTL_MS`).

**Path.** When the pool is full:

```js
state.seen.set(job.id, Date.now());
saveSeenJobs(state.seen);                                          // :6816-6817  ← durable
…
if (state.active.size >= MAX_AGENTS) {
  queueInsertByPriority(state.queue, { ...job, assignedAgent: agentInfo });   // :6821  ← memory only
}
```
`state.seen` is written to disk and reloaded at boot (`loadSeenJobs`, `:3380`).
`state.queue` is a plain array (`:3379`) with no persistence anywhere — unlike
`state.reactivationQueue`, which has `persistReactivationQueue` /
`loadReactivationQueue` (`config.js:85-105`) precisely because paused jobs must
survive a bounce.

So a restart while jobs are queued loses them, and the restored `seen` set makes
`pollForJobs` skip them for the full 7-day TTL (`:6734-6736`, pruning at
`:526-539`). `handleCrashRecovery` cannot help either: queued jobs were never in
`active-jobs.json`.

**Trigger.** Restart (including the graceful one, and including the automatic
one an operator does to clear an unrelated problem) while `state.queue` is
non-empty — i.e. whenever the fleet is at capacity, which is when a restart is
most likely.

**Severity.** med. Paid jobs stall indefinitely with no signal; queue depth is
reported (`summary.jobs_queued`) but its disappearance is not.

**Proposed fix (not applied).** Either (a) persist `state.queue` alongside
`active-jobs.json` with the same tmp+rename pattern and reload it at boot, or
(b) do not mark a job `seen` until it actually starts — move the
`state.seen.set` / `saveSeenJobs` pair inside the `else` branch at `:6822-6825`
and into `startJob*`, which already sets it (`:8498`, `:8894`). (b) is smaller
and makes the queue self-healing from the platform on the next poll.

---

### L6 — med — the queue drain assigns the wrong agent

**Where:** `src/cli.js:6821` and `:7108` (enqueue with `assignedAgent`), `:7021-7025`
(drain).

**Path.**

```js
const queuedJob = state.queue.shift();
const agent = state.available.pop();          // :7022  ← arbitrary
await startJob(state, queuedJob, agent);      // :7025
```
`assignedAgent` is written at both enqueue sites and **read nowhere** — a
repo-wide grep returns only those two writes. `startJob` (`:8995-9001`) and both
spawn paths take `agentInfo` on trust; nothing checks it against the job's
seller. Contrast `respawnReadyResumes`, which correctly resolves
`findAgent(entry.agentId)` (`:5032,5044`), and `queueDisputedJobForRespawn`,
which explicitly refuses a mismatched seller (`:5107-5114`).

The resulting container is launched with agent B's identity, WIF-less broker
(`:8348`) and SOUL.md for a job whose seller is agent A. It cannot deliver.

**Trigger.** Any queued job in a multi-agent fleet where the agent that freed up
is not the one the job was queued for — the normal case once the pool is full.

**Severity.** med. Needs ≥2 agents and a full pool; deterministic once there.

**Proposed fix (not applied).** Drain by matching, not by popping:

```js
const idx = state.available.findIndex(a => a.id === queuedJob.assignedAgent?.id);
if (idx === -1) break;                    // that agent is still busy — leave it queued
const agent = state.available.splice(idx, 1)[0];
```
and skip (rather than shift) queue entries whose agent is unavailable, so one
blocked job does not block the rest.

---

### L7 — med — shutdown's on-chain deactivate bypasses the batch and the pending-write gate

**Where:** `src/cli.js:4322-4324`; the gate `src/inbox-deadletter.js:273-284`
consulted only inside the inbox sweep; the inbox timer `cli.js:3964`.

**Path.** During shutdown, per agent:

```js
if (process.env.J41_STATUS_TOGGLE_ONCHAIN !== '0') {
  try { await agent.setOnChainStatus('inactive'); } catch {}      // :4322-4324
}
```
This is an identity transaction. Nothing stops `checkPendingInbox` running
concurrently — `runInboxSweep` (`:7846`) has a reentrancy guard but **no
`state.shuttingDown` check**, and its 60 s timer (`:3964`) keeps firing through
the entire drain (up to 120 min). The inbox sweep's own protection,
`shouldDeferForPendingWrite`, keys off `state._inboxLastWrite`, which the
shutdown write never populates — so the gate is blind to it, and the shutdown
write never consults the gate. This is the hazard CLAUDE.md documents for
`update-profile`, on an automatic path, and a sibling of trust-boundary **T2**
(the `review.received` webhook).

When the two collide, the second transaction spends an already-spent
`prevOutput` and the daemon rejects it. The `catch {}` at `:4323` is empty, so
the failure is not logged, not counted, and not reflected in
`_deactivatedByShutdown` (which was already pushed at `:4318` on the *platform*
call succeeding). The agent reports `inactive` on the platform while remaining
`active` on-chain.

That is exactly the state the code at `:4170-4178` says must not happen: *"their
indexer OVERWRITES that column from on-chain `data.status` on every re-index …
A hire landing in that window sends the buyer's funds to a down agent, and there
is NO ESCROW."*

**Trigger.** Shut down within ~one confirmation of an inbox batch write, on an
agent with pending review/job-record items. The inbox sweep runs every 60 s.

**Severity.** med. Narrow window, but it lands on the failure mode the on-chain
toggle exists to prevent, and it is silent.

**Proposed fix (not applied).** (1) Have `pollForJobs`'s `state.shuttingDown`
short-circuit apply to `checkPendingInbox` too, or stop the inbox timer at the
top of `gracefulShutdown`. (2) Make the shutdown write go through the same
`shouldDeferForPendingWrite` check and record its txid into `_inboxLastWrite`.
(3) At minimum, replace `catch {}` with a logged failure and drop the agent from
`_deactivatedByShutdown` when the on-chain half fails, so the next start knows
its on-chain status is wrong.

---

### L8 — med — `config --max-concurrent` is a no-op that reports success

**Where:** `src/cli.js:1184` (flag), `:1204-1212` (writes `config.maxConcurrent`),
`:1260` (prints it back), `:134-139` (what the daemon actually reads);
`src/cli.js:9618,9632-9633` (the same value in the interactive System Settings
screen).

**Path.** `j41-dispatcher config --max-concurrent 3` validates the number, sets
`config.maxConcurrent = 3`, calls `saveConfig` (→ `~/.j41/dispatcher/config.json`)
and prints "✅ Configuration updated" followed by "Max concurrent: 3".

The daemon reads a different key from a different file, and says so:

```js
// A stale legacy config.json `maxConcurrent` is deliberately NOT consulted here —
// it must not act as a phantom override the owner never chose.
const _cap = resolveCapacity({ configMax: cfg.runtime.max_concurrent, estimate: _autoMax });   // :134-137
```
`cfg` is `config.toml`; `_cfg = loadConfig()` (config.json) is used only for
`jobTimeoutMin` at `:140`. So the flag writes into a file the capacity resolver
ignores by design, and both display sites (`:1260`, `:9618`) read it back,
confirming the operator's belief.

README:394 documents the setting as `--max-concurrent`, default "unlimited"; the
real default is the hardware estimate and the real knob is
`config.toml [runtime] max_concurrent` / `J41_MAX_CONCURRENT`.

**Trigger.** An operator capping concurrency — typically after an OOM or CPU
contention, i.e. while the box is already unhealthy.

**Severity.** med. No corruption, but a capacity control that silently does
nothing during an incident is worse than an absent one.

**Proposed fix (not applied).** Have the `config` command write
`runtime.max_concurrent` into `config.toml` (the documented source of truth), or
delete the flag and the two display lines and point at `config.toml`. Whichever
is chosen, `config --show` must print the value the daemon will actually use —
ideally by calling `resolveCapacity` and labelling it `(auto)` / `(owner override)`
the way `start` does at `:3243`.

---

### L9 — med — documented 30 s shutdown vs a real 120-minute drain

**Where:** `README.md:719-728` vs `src/cli.js:4253` (`HARD_EXIT_MS`),
`:4342-4343` (`drainTimeoutMs`), `:4359-4390` (drain loop), `:4379-4388`
(timeout exit).

**Path.** README step 4 says *"Waits up to 30s for clean exit, then SIGTERM ->
SIGKILL."* Neither half exists:

- The wait is `drainTimeoutMs = (cfg.drainTimeoutMin || (cfg.jobTimeoutMin || 60) * 2) * 60 * 1000`
  — **120 minutes** on defaults (`config.js:16,21`).
- The 30 s constant is `HARD_EXIT_MS`, a *stall* detector explicitly documented
  as "not a deadline" (`:4238-4252`), and the drain interval re-kicks it every
  10 s (`:4363`), so it never fires during a progressing drain.
- On drain timeout the process exits (`:4388`) **without stopping the remaining
  containers** — deliberately, so crash recovery refunds them. Nothing SIGKILLs
  anything.

Operationally this inverts the operator's expectation. A systemd unit with the
default `TimeoutStopSec=90s` will SIGKILL the dispatcher 90 s into a drain that
was going to take up to two hours; the containers survive as orphans, the
`process.on('exit')` PID-file unlink (`:3215-3221`) does not run under SIGKILL,
and the next `start` refunds jobs that were about to deliver. A `docker stop`
(10 s) or a Kubernetes `terminationGracePeriodSeconds` default (30 s) does the
same.

**Trigger.** Any managed restart of a dispatcher with active jobs.

**Severity.** med. Documentation drift, but the operator acts on it when writing
the unit file, and the consequence is orphaned containers plus unnecessary
refunds.

**Proposed fix (not applied).** Correct README §Graceful Shutdown to state the
real bound (`drain_timeout_min`, default `2 × job_timeout_min`), state that
`HARD_EXIT_MS` is a stall detector, and add the systemd guidance the number
implies (`TimeoutStopSec=` ≥ the drain bound, or `infinity` given G1 guarantees
termination). Optionally have the drain-timeout branch stop its remaining
containers before exiting, so a timed-out drain does not leave orphans.

---

### L10 — med — `/health` and `ctl` bind only after an unbounded startup

**Where:** `src/cli.js:4112-4117` (`startControlServer`), `src/control.js:123`
(`/health` listen), against everything at `cli.js:3117-4110`.

**Path.** Before the health server binds, `start` runs, serially and with no
overall bound:

| step | line | bound |
|---|---|---|
| passphrase prompt (encrypted pools) | `:3142-3151` | interactive |
| per-agent `authenticate()` + `getAgent()` — **no** auth-backoff (raw `J41Agent`) | `:3277-3343` | up to ~93 s × 2 × N |
| security quick-check | `:3475-3502` | 10 s |
| capability load, 2 s stagger per agent | `:3506-3510` | 2 s × N + network |
| dispute policy per agent | `:3548` | network × N |
| webhook registration / WS connect per agent | `:3584-3620` / `:3913-3948` | network × N |
| `drainPendingRefunds({startup:true})` | `:4066` | network |
| `handleCrashRecovery` | `:4077` | network + docker per orphan |
| **full initial `pollForJobs`** — incl. accepting jobs and starting containers | `:4080` | unbounded |

Only then does `startControlServer` bind `:9842`. On a nine-agent fleet against a
slow platform this is minutes; in hang-mode (SDK 30 s × 3 retries per call) it is
tens of minutes. Throughout, monitoring polling `/health` reads connection-refused
— indistinguishable from "the dispatcher is down" — and `ctl status` / `ctl
shutdown` are unavailable, so the operator's only lever is `kill`.

`control.js:126-143` shows the intent was the opposite: the health bind retries
EADDRINUSE ten times specifically so monitoring is never left reading the *old*
process's numbers.

**Trigger.** Every start; severity scales with fleet size and platform latency.

**Severity.** med. No data loss, but the observability surface is absent exactly
when an operator is watching a restart.

**Proposed fix (not applied).** Bind the health server first thing in the `start`
action (immediately after the mainnet gate), serving a `status: "starting"`
document with a `phase` field, and let `startControlServer` adopt it. That also
makes `readyForShutdown`'s startup guard (`:4102-4110`) reachable through `ctl`
rather than only through signals.

---

### L11 — med — `ctl earnings` cannot complete on a real fleet

**Where:** `src/control.js:691-694` (client deadline), `buildEarnings` in
`src/control.js`, `README.md:664,695`.

**Path.** `sendCommand` rejects unconditionally after 5 s:

```js
setTimeout(() => { client.destroy(); reject(new Error('Control plane timeout (5s)')); }, 5000);
```
`buildEarnings` loops every agent and issues **two serial** platform calls each
(`getMyJobs({status:'completed'})`, `getMyJobs({status:'delivered'})`), plus
`getAgentSession` (which may re-authenticate on a >10-min-old session,
`cli.js:4797`). At nine agents that is 18+ sequential round trips: ~4.5 s at a
250 ms round trip, over the deadline at anything slower.

The failure is misleading — it reads as "the dispatcher is not responding" when
the dispatcher is fine and still executing the query. `GET /v1/earnings` has no
such client deadline, so the two documented surfaces behave differently.

**Trigger.** `ctl earnings` on ≥~8 agents, or fewer at >300 ms platform latency.

**Severity.** med. Ops-surface only; no state is harmed (the server-side loop
completes into a destroyed socket).

**Proposed fix (not applied).** Make the deadline per-command — a long one for
`earnings`/`history`, 5 s for the rest — or make it configurable and report the
elapsed time in the error. Independently, parallelise `buildEarnings` per agent
with a bounded concurrency, and consider caching it (earnings do not change
between polls).

---

### L12 — low — README's PID-file behaviour is the opposite of the code's

**Where:** `README.md:15` vs `src/cli.js:3183-3205`.

README: *"**PID file** -- prevents duplicate dispatcher processes. New instance
auto-kills previous."*

Code: SIGTERM the old PID, then poll every 500 ms for up to
`J41_STOP_WAIT_MS` (default `10 * 60 * 1000`), and if it is still alive:

```js
console.error(`\n❌ Previous dispatcher (PID ${oldPid}) did not exit within ${…} min.`);
…
console.error('   Refusing to start a second dispatcher against the same agents.');
process.exit(1);                                                        // :3203
```
The change is correct and well-argued (`:3170-3182`) — but an operator whose
restart script reads the README expects it to return quickly and always succeed.
In practice `start` can block for 10 minutes and then exit non-zero, which is
exactly what happens when the predecessor is in a legitimate drain (L9: up to
120 min). The 10-min wait is not documented anywhere outside the error text.

**Severity.** low. Loud and non-destructive, but it will surprise restart
automation.

**Proposed fix (not applied).** Update README:15 to describe SIGTERM + bounded
wait + refuse, name `J41_STOP_WAIT_MS`, and cross-reference the drain bound so
the two numbers are read together.

---

### L13 — low — the Docker IPC file can silently drop a message

**Where:** `src/job-agent.js:791-808` (reader), `src/cli.js:4977-4986` (writer).

**Path.** Reader, every 2 s:

```js
const raw = fs.readFileSync(IPC_FILE, 'utf8').trim();
fs.unlinkSync(IPC_FILE);        // consume immediately          // :794-795
```
Writer:

```js
execFileSync('docker', ['exec','-i', id, 'sh','-c','cat >> /tmp/ipc-msg.jsonl'],
            { input: msgJson + '\n', timeout: 5000, … });        // :4980-4983
```
Read and unlink are two syscalls. An append landing between them is deleted
unread. There is no ack, no sequence number and no retry — `sendToJobAgent`
returns `true` as long as `docker exec` exited 0.

The messages at risk are the control-plane ones: `shutdown`, `reconnect`,
`dispute.filed`, `dispute.rework_accepted`, `end_session_request`,
`budget_increased`. A lost `shutdown` is the concrete case: `gracefulShutdown`
broadcasts it to every active job at once (`cli.js:4282-4288`), so all writes
land in the same instant; a worker that misses it runs to its own timeout while
the dispatcher waits out `drainTimeoutMs` (bounded, but up to 120 min).

Most transitions have a poll-mode re-send (`_lastSentStatus` only advances on
send, `cli.js:6847-6868`), which limits the damage — but `shutdown` is sent
exactly once.

**Trigger.** Race window of a few hundred microseconds per 2 s tick, per job;
raised by concurrent broadcasts.

**Severity.** low. Rare, and every consequence is bounded by a timeout.

**Proposed fix (not applied).** Rename-then-read: `fs.renameSync(IPC_FILE,
IPC_FILE + '.consuming')` (atomic within a filesystem) and read the renamed file,
so an append that loses the race lands in a fresh `ipc-msg.jsonl` and is picked
up next tick. Re-send `shutdown` on each drain tick until the container exits.

---

### L14 — low — the reconcile cap counts lifetime respawns, not failures

**Where:** `src/cli.js:5238` (`MAX_RECONCILE_ATTEMPTS_PER_JOB = 3`), `:5314-5315`
(the map), `:5351-5363` (give-up), `:5377` (increment).

**Path.** `attempts.set(job.id, priorAttempts + 1)` fires on every respawn.
Nothing ever decrements it, clears it on a *successful* respawn, or ages it —
`state._reconcileAttempts` is a plain `Map` on daemon state with no pruning. So
the counter measures "how many workers have we ever spawned for this job", not
"how many consecutive times has spawning failed to help", which is what the
comment at `:5229-5238` describes.

For a genuinely stuck job (the round-7 Postgres-23505 case the comment cites)
that is the right behaviour. For a legitimately long dispute — deadline days
away — it means the fourth worker is refused, permanently, with the message *"it
will not be retried until the dispatcher restarts."* L3 makes that certain by
forcing a respawn every 61 minutes.

**Severity.** low **on its own** (a dispute rarely needs four workers if the
worker is not being killed); it is the second half of L3's failure and should be
fixed with it.

**Proposed fix (not applied).** Clear the entry when a respawn produces a live
worker (`state.active.has(job.id)` after `queueFn` returns `respawned`), so the
cap counts consecutive failures. Optionally age entries out with the job's
dispute deadline, and prune the map at job teardown alongside
`pruneExtensionChecks` (`:8698`).

---

### L15 — low — duplicate entries accumulate in the available pool

**Where:** `src/cli.js:8502` / `:8896` (remove on start — `filter`),
`:8685` / `:8967` (return on stop — `push`), `:6819` (the capacity check that
permits two jobs per agent).

**Path.** `pollForJobs` deliberately checks *all* agents, "an agent with an
active job can still have new jobs queued for it" (`:6659-6660`), and the
capacity check before spawning is global, not per-agent:

```js
if (state.active.size >= MAX_AGENTS) { …queue… } else { await startJob(state, job, agentInfo); }   // :6819-6824
```
So agent-1 can hold two concurrent jobs. Removal from the pool is idempotent
(`filter` by id); return is not (`push`). Sequence: job A starts (agent-1
filtered out), job B starts (filter is a no-op), job A ends (`push` → pool holds
agent-1 once), job B ends (`push` → pool holds agent-1 **twice**).

Consequences: `summary.agents_available` and `ctl status` over-report idle
capacity, and can exceed `agents_total`; the queue drain's `state.available.length > 0`
guard (`:7015`) is satisfied by a phantom, and `state.available.pop()` (`:7022`)
can hand the same agent to two queued jobs in one pass — compounding L6.

**Trigger.** Two jobs for the same agent completing in sequence. Routine on a
single-agent-heavy fleet.

**Severity.** low. Accounting drift with no direct loss, but it degrades the
scheduler's inputs and the `/health` numbers an operator trusts.

**Proposed fix (not applied).** Make the return idempotent:

```js
if (!state.available.some(a => a.id === active.agentInfo.id)) state.available.push(active.agentInfo);
```
at `:8685` and `:8967` (and at the failure paths `:8580`, `:8917`, `:7029`).
Better: derive `available` from `state.agents` minus the agent ids in
`state.active` rather than maintaining it as a mutable list.

---

### L16 — low — every `ctl` command lingers ~5 s after printing

**Where:** `src/control.js:691-694`; caller `src/cli.js:9216-9232` (and
`:9909-9910`).

**Path.** `sendCommand` arms `setTimeout(…, 5000)` and never clears it on the
success path; it is not `unref()`'d. After `resolve()` and `client.end()`, that
timer is the only handle keeping the event loop alive, and the `ctl` action does
not `process.exit()` on success. So the command prints its output and the process
sits for the remainder of the 5 s before the timer fires (destroying an already-
closed socket and rejecting an already-settled promise, both no-ops) and exits.

**Trigger.** Every `ctl` invocation. Visible immediately; costly for anything
polling `ctl status` on a loop or in a shell-based monitor.

**Severity.** low.

**Proposed fix (not applied).** Keep the timer handle, `clearTimeout` it in both
the resolve and error paths (or `.unref()` it), which also removes the need for
callers to exit explicitly.

---

### L17 — low — pause-TTL expiry has no auto-deliver

**Where:** `src/cli.js:5409-5423` (`sweepExpiredQueue`), `src/job-agent.js:745-749`
(the `ttl_expired` handler), `README.md:235`.

**Path.** README:235: *"Resume / TTL -- Buyer can resume; **if pause TTL expires,
the agent auto-delivers results**."* On expiry the dispatcher does:

```js
console.log(`[TTL] queued job … exceeded pause_ttl (${e.pauseTtlMin}min) — removed from reactivation queue (platform auto-cancels/refunds)`);
rq.removeJob(state.reactivationQueue, e.job.id);                   // :5417-5419
```
No delivery, no worker, no IPC. The worker-side handler for `ttl_expired`
(`job-agent.js:745-749`) is dead code: a repo-wide grep finds the handler and one
unrelated comment, and no sender. It is unreachable in principle anyway —
`moveJobToReactivationQueue` destroyed the container at pause (`cli.js:5015-5020`),
so there is nobody left to deliver.

The job is also still in the persisted `seen` set, so it is never re-polled.

**Trigger.** A buyer who pauses and does not resume within `pause_ttl` (default
60 min).

**Severity.** low, and partly platform-dependent — README:424 says the backend
auto-delivers at 10 min of idle, and the log line asserts the platform
auto-cancels/refunds. Neither was verified backend-side. What is certain is that
*the dispatcher* does not do what README:235 says it does.

**Proposed fix (not applied).** Either correct README:235 to describe the actual
handoff ("the platform auto-cancels/refunds; the dispatcher drops the queue
entry") and delete the dead `ttl_expired` handler, or — if seller-side delivery of
partial work is wanted — have `sweepExpiredQueue` respawn a worker with a
`ttl_expired` seed instead of dropping the entry. Confirm the platform side
before choosing.

---

## Adversarial pass — shortest path from untrusted input to a liveness failure

Untrusted producers considered: the buyer (chat, uploads, dispute actions,
pause/resume), the platform API (job records, statuses, webhooks), the LLM, and
the container itself.

**1. Buyer → OOM → silent job loss (shortest path, ~1 step).**
The container is capped at `Memory: 2GB` with `OomScoreAdj: 1000`
(`cli.js:8364,8380`), and buyer file uploads are uncapped into the bind mount
(isolation **I7**). A conversation or upload set that pushes the worker over 2 GB
gets it OOM-killed (exit 137). `AutoRemove` deletes the container; the 10 s
poller 404s; the catch at `cli.js:9102` declares it "gone". Result: agent
returned to the pool, job dir deleted, job dropped from `active-jobs.json`, **no
refund**, **no `container.died`**, `containers_unhealthy` still 0, and the job
locked out of re-pickup by the 7-day `seen` TTL. That is **L2**, reachable in one
buyer action with no privilege and no protocol abuse.

**2. Buyer → dispute → worker starvation (~2 steps, ~3 hours to permanence).**
File a dispute on a job whose container has been up a few minutes. The worker
announces a hold of up to 360 min (`job-agent.js:1974-1976`); the dispatcher
kills it at 61 min (`cli.js:8565`). The reconciler respawns; each replacement
dies the same way; at three respawns it gives up "until the dispatcher restarts"
(`cli.js:5356-5359`). The dispute then lapses on the platform's default terms
with no seller present. That is **L3** + **L14**. Cost to the buyer: one dispute
filing.

**3. Platform (slow, not down) → shutdown → fleet loss (~1 step, operator-triggered).**
A degraded platform makes each SDK call take up to 93 s. The operator restarts —
the natural response. The deactivate loop blows the 30 s stall budget mid-fleet,
`process.exit(1)` fires before `writeShutdownDeactivated`, and the next start
skips every already-deactivated agent as "inactive on platform". **L1.** The
trigger is a *slow* platform, not a down one, so `auth-backoff` (which only
covers `authenticate`) never engages.

**4. Buyer volume → poll-cycle wedge → fleet-wide blindness (degradation, not a
stall).** `pollForJobs` is one serial function that also contains the
post-delivery transition check, the extension check, the workspace check, the
dispute reconciler and the queue drain (`cli.js:6841-7033`). Every one of those
does per-agent or per-active-job platform calls with no concurrency. Under a slow
platform the cycle can exceed its `max(60s, N*1s)` budget by a wide margin; the
reentrancy guard then skips subsequent cycles (`:6678-6689`). This is *documented*
(README:358-373) and counted (`poll_cycles_skipped`), and it deliberately does
not degrade health. Worth naming as a shape rather than a finding: **one slow
job's `getJob` delays dispute detection for every other job**, because they share
a cycle. No finding raised — the behaviour matches the documentation.

**5. Container → host liveness.** Nothing found. The container cannot extend its
own deadline (both timers are host-side, `cli.js:8558` and `job-agent.js:1762`),
cannot reach the control plane (`127.0.0.1` binds, `control.js:123`,
`control-api.js`), and its one host-side write channel with a liveness effect is
the IPC file, which it can only *delete* messages from (**L13**, and isolation
**I8** covers the write side). `PidsLimit: 64`, `CpuQuota` and `Memory` bound its
resource pressure on the host.

**6. Platform → response-size DoS.** Covered and closed: jobs per poll capped at
200 (`cli.js:6711-6717`), SDK response bodies capped at 8 MB
(`sovagent-sdk/dist/client/index.js:110-131`), webhook bodies capped with
slow-loris timeouts and a connection cap (`webhook-server.js:106-116,288-310`).

---

## Checked and found clean

These were traced and no finding was raised.

**Loop protection**
- Reentrancy guards on all three long loops — poll (`cli.js:6678-6690`, released
  in `finally` at `:7034-7036`), fee tank (`:7714-7724`, `finally` `:7824-7826`),
  inbox (`:7834-7843`). Each releases on the throw path.
- Skip counters wired end to end: written `:6686`/`:7718`, read
  `control.js:480-481`, non-finite-coerced, tested (`test/scale-observability.test.js`).
- `safeInterval` wraps every async interval callback in try/catch
  (`cli.js:3553-3561`) — the Node ≥20 "async setInterval throw crashes the
  process" hazard — with `process.on('unhandledRejection')` as a backstop
  (`:4061-4063`).
- Timers that must not hold the loop open are `unref()`'d: allowlist sweep
  (`:334`), capability retry (`:3544`), health rebind (`control.js:135`), signing
  channel poller (`sign-channel-host.js:146`), deposit watcher
  (`deposit-watcher.js:427`), upstream health (`upstream-health.js:100`), job-agent
  message poll (`job-agent.js:1232`).
- Every outbound HTTP path has a deadline: SDK 30 s (`client/index.js:22,80`),
  executors `EXECUTOR_TIMEOUT` via `AbortController` (webhook/langserve/langgraph/
  a2a/mcp), local-llm 60 s (`executors/local-llm.js:368,412`), LLM probe 5 s
  (`llm-health.js:9-16`), deposit watcher 10 s. No unbounded `fetch` found.

**Backoff and outage handling**
- `auth-backoff.js` in full: narrow retryable classification (401/403 explicitly
  *not* retryable, `:47-51`), `Retry-After` honoured and clamped (`:77-84`),
  exponential from 5 s capped at 5 min with ±25 % jitter (`:117-122`), fails
  **open** on a malformed record (`:143-151`) so a bookkeeping bug cannot park the
  fleet, and surfaces on `/health` as `auth_backoff_agents` (`control.js:469-474`).
- Log-flood suppression on repeated auth failure (`cli.js:4831-4833`) without
  suppressing non-retryable ones (`:4834-4837`).
- SDK retry ladder is bounded (3 attempts) and does not retry `AbortError`
  (`client/index.js:72`), so a timeout does not multiply into a hang.

**Bounded retries / no infinite loops**
- Inbox dead-letter: 5 consecutive *hard* failures quarantine an item
  (`inbox-deadletter.js:26,39-57`); contention and transient never count
  (`:190-233`); batch escalation counts only `hard` (`:309-333`); operator redrive
  grants a fresh budget (`:350-357`); the failure map is pruned only on a complete
  view (`:71-81`).
- Pending-write gate has three release conditions including a 4 h liveness
  backstop for the "someone else confirmed on top of ours" case
  (`inbox-deadletter.js:273-284`) — a deliberate escape from deferring forever.
- Dispute reconciler caps respawns per sweep (`cli.js:5227`) and reports what it
  deferred rather than truncating silently (`:5392-5395`); `shouldReconcileJob`
  refuses to respawn for jobs already in the operator refund queue, already
  answered, or past deadline (`:5256-5288`).
- `respawnReadyResumes` re-queues and `break`s on failure rather than spinning
  (`:5048-5060`).
- `state.seen` is TTL-pruned at 7 days on a 60 s timer (`:526-539`, `:4057`);
  `_lastExtensionCheck` is pruned per job (`:8620-8624`); nonce cache
  (`nonce-cache.js:32`) and proxy rate limiter (`proxy-rate-limiter.js:24`) sweep
  themselves.
- `MAX_RETRIES = 2` on job spawn, with a terminal-status re-check before each
  retry so a delivered job is never re-run (`:9027-9031`, `:9070-9074`).

**Shutdown correctness (beyond L1/L7/L9)**
- `shuttingDown` / `readyForShutdown` are declared before the control plane binds,
  with the TDZ failure that motivated it documented (`:4082-4110`).
- `gracefulShutdown` rejections are caught by every caller via `onShutdownFailed`,
  which exits rather than leaving a half-stopped dispatcher polling (`:4096-4100`).
- Second signal → emergency exit (`:4219-4223`).
- Cleanup steps are individually `safely()`-wrapped so one failure cannot strand
  the process (`:4266-4270`).
- `state.shuttingDown` is visible to `pollForJobs`, which stops accepting new work
  while continuing to service in-flight jobs (`:6671-6677`) — the B2 fix, verified.
- `_deactivatedByShutdown` / `shutdown-deactivated.json` restores only agents *we*
  turned off, never ones the operator deactivated deliberately (`:5177-5213`,
  `:3302-3325`), and the marker is cleared only when every entry has been dealt
  with (`:3345-3354`).
- PID file is unlinked only if it is still ours (`:3211-3221`).
- Keystore is zeroized on exit (`:4406`).

**Crash recovery**
- Orphan refunds are idempotent across three ledgers — `active-jobs.json`,
  `pending-refunds.json`, `refunded-jobs.json` — with merge-never-overwrite
  semantics (`:6413-6420`, `:6517-6523`) and `shouldRefundOrphan` refusing to
  refund a `delivered` job (`:6460-6466`).
- All state files use tmp+rename atomic writes: `active-jobs.json`
  (`config.js:59-71`), reactivation queue (`config.js:85-94`), seen jobs
  (`cli.js:507-521`), pending/refunded ledgers (`cli.js:5476-5485,5502-5510`),
  rework cycles (`:5152-5165`), shutdown marker (`:5200-5209`).
- Startup live-log sweep deliberately preserves logs for jobs still in
  `active-jobs.json` so the operator can diagnose the crash (`:3423-3442`).
- Paused jobs are enqueued and persisted **before** the container is touched, so a
  crash at any point leaves them recoverable (`:4999-5020`).

**Capacity and resource valves**
- `hasMemoryHeadroom` gates the respawn path (`:5036`) and the queue drain
  (`:7017`); `computeMaxAgents` is conservative (15 % or 2 GB host reserve,
  `hardware-sizing.js:21-26`) and warns when an owner override exceeds it
  (`:3254-3256`).
- Per-job log output is capped (`makeCappedLogWriter`, `job-log.js`) and archives
  are pruned to `job_log_max_retained` (`:8606-8609`).
- Job-log streams are drained with a 1 s `unref()`'d escape so a wedged stream
  never blocks teardown (`:8665-8672`, `:8947-8954`).
- Webhook server: `headersTimeout` 30 s, `requestTimeout` 60 s, idle 120 s,
  `maxConnections` 512, body cap, and it **responds before** processing the event
  (`webhook-server.js:112-116,359-368`).
- Egress proxy bind failure is fatal rather than silently jobless (`:4146-4149`).

**Observability**
- `/health` degrades on dead-lettered inbox items and platform-inactive agents,
  gated on `startupComplete` so a restart does not cry wolf (`control.js:434-449`,
  `cli.js:4403`).
- `_agentErrors` is cleared by the subsystem that set it — the fee tank retracts
  its own stale alert on recovery and only its own (`cli.js:7794-7797`).
- Fee-tank observations are recorded for *every* outcome including the two that
  `continue`, so "nothing wrong" and "stuck" are distinguishable
  (`cli.js:7760-7771`).
- `/v1/events` re-seeds `seq` from disk so a polling client's cursor survives a
  bounce, and falls back to the in-memory ring if the disk write fails
  (`control-api.js:83-128`).
- Capability-load failures self-heal on a 60 s retry rather than requiring a
  restart, and stop the timer when the fleet is healed (`cli.js:3513-3545`).

---

## Cross-references to earlier passes

- **L2 / L4** end in an unpaid buyer. `AUDIT/money.md` covers the refund ledger
  itself; this pass reports only that the Docker-mode path into it is
  near-unreachable.
- **L7** is the same class as trust-boundary **T2** (`review.received` webhook
  writes outside the batch and the gate) and as CLAUDE.md's documented
  `update-profile` hazard. Three sites, one missing gate.
- **L2**'s OOM trigger leans on isolation **I7** (uncapped buyer uploads into the
  bind mount).
- **L13** is the liveness half of isolation **I8** (unauthenticated IPC file);
  I8 covers what the container can write, L13 what it can delete.
