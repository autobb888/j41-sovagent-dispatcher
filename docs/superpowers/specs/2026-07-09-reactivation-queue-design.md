# Reactivation Queue — Design

**Date:** 2026-07-09
**Status:** Approved for planning
**Repo:** `j41-sovagent-dispatcher`
**Origin:** Live E2E job #5 (2026-07-09) proved the WebSocket fix, then surfaced the pause lifecycle. Fix A stopped the paused-delivery crash (worker never delivers a paused job). This spec is **Part B**: make pause **reclaim resources** so the dispatcher can oversubscribe far past its container count. See dispatcher memory `project_e2e_bugs_0708` and `project_next_reactivation_queue`.

---

## Problem

Today a paused job **keeps its container alive at full allocation** (`2GB / 1 CPU`, `cli.js:5959-5960`). Pause only sets a logical flag (`activeInfo.paused = true`) and pulls the agent from the pool; the `"unthrottling"` log messages (`cli.js:4953`, `5330`) name a resource-reduction that **was never implemented**. So every paused job holds a real container + RAM + one of the `MAX_AGENTS` slots. An operator running "100 agents for sale" cannot oversubscribe: 100 mostly-idle jobs would need 100 live containers.

## Goal

On pause, **free the container entirely** (0 CPU, 0 RAM, slot released) and move the job to a **persisted reactivation queue**. On resume, **respawn a fresh, stateless worker** for the job, gated by the existing capacity limit. Paused jobs then cost ~nothing, so the operator can accept far more concurrent jobs than they have container slots.

## Key decisions (settled in brainstorming)

- **Stateless respawn (A).** Conversation/job state lives platform-side; a fresh worker reloads it on boot (re-auth, `connectChat`, reload messages). Killing + respawning the container loses nothing. *This is the linchpin — the plan must verify the respawned worker fully reloads context.*
- **Free + queue + respawn (Y).** Not throttle-in-place. Kill on pause; respawn on resume. (A future "throttle tier" for instant resume of recently-paused jobs is a clean add-on — explicitly out of scope here.)
- **`MAX_AGENTS` is the capacity gate, auto-sized from hardware (conservative).** Resumed and new jobs draw from the same slot budget. When `max_concurrent` is unset/`0`, the dispatcher **derives** it from the box instead of defaulting to unlimited (unlimited × 2GB OOMs a stranger's machine — unacceptable for a download-and-run product): `max = floor((os.totalmem() − hostReserve) / perContainerMem)`, also bounded by `os.cpus().length − coreReserve`. Conservative reserve (generous host headroom) is the default; an explicit operator `max_concurrent` overrides but **warns** if it exceeds the safe estimate. Per-container size stays `2GB / 1 CPU` for launch.
- **Resumed jobs get slot priority** over new jobs from `state.queue`.
- **Full-box resume waits in the priority queue** (no reserved headroom). A `reserve_resume_slots` knob is a later tunable, out of scope.
- **`pause_ttl` keeps running while queued;** expiry auto-cancels/refunds exactly as today, just applied to a queued job.
- **The reactivation queue is persisted** and **restored** (not refunded) across dispatcher restarts.

## Components

### `state.reactivationQueue` (new)
An ordered collection of paused jobs not consuming a slot. Each entry carries what a respawn needs: `jobId`, `agentId` (which agent owns it), `pausedAt`, `pauseTtlMin`, and a `readyToRespawn` flag (set when the buyer resumes). Lives alongside `state.active` / `state.queue`; persisted to disk (mirror `persistActiveJobs` → a sibling `reactivation-queue.json` via `config.js`).

### Pause handler — free + enqueue
Extends the existing `job_idle` IPC path (worker → dispatcher on confirmed pause). Today it sets `activeInfo.paused = true`. New behavior:
1. **Kill the container** for the job and **remove it from `state.active`** → a slot frees.
2. **Push the job onto `state.reactivationQueue`** (`readyToRespawn: false`), persist.
3. **Fill the freed slot** from the schedulers (below).

The worker side (Fix A) already stays alive-and-paused; here the dispatcher instead tears it down. The worker's container exit must be treated as expected (paused → freed), not a crash/refund.

### Resume handler — mark ready
Extends the existing resume detectors — `job.resumed` webhook (`cli.js:5329`) and poll `paused→in_progress` (`cli.js:4952`). Today they send a `reconnect` IPC to the live container. New behavior (container is gone):
1. Find the job in `state.reactivationQueue`; set `readyToRespawn: true`, persist.
2. Signal the scheduler to place it as soon as a slot is free.
   (If the job is not found — e.g. already respawned or TTL-cancelled — ignore idempotently.)

### Scheduler — priority slot fill
A single place that runs whenever a slot may have freed (container exit, pause-kill, job completion). While `state.active.size < MAX_AGENTS`:
1. If any `reactivationQueue` entry has `readyToRespawn: true` → take the **oldest such** (FIFO among ready resumes) and **respawn** it.
2. Else if `state.queue` (new jobs) is non-empty → take the next new job and start it (existing path).
3. Else stop.
Resumed-ready jobs are always preferred over new jobs.

### Respawn / re-adoption — reuse `startJob`
Respawn calls the existing `startJob(state, job, agentInfo)` / `startJobContainer` with the job's current platform state (`fullJob.status === 'in_progress'` after resume). `processJob`'s existing reconnect mode (`job-agent.js:466`) drives a **stateless reload**: re-auth, `connectChat`, re-fetch messages/context. Buyer sees a brief *"waking your agent up…"* beat.
**Requirement (verify in plan):** the respawned worker reloads the full conversation so the buyer continues seamlessly. If the current reconnect path does not fully reload chat history for a from-cold container, closing that gap is part of the work.

### Persistence + restart
`reactivation-queue.json` is written on every mutation (enqueue, mark-ready, dequeue) and loaded at startup. On restart, queued jobs are **restored to `state.reactivationQueue`** (still paused, awaiting resume) — they are **excluded from the crash-recovery refund sweep** (`cli.js:4561`), which must continue to refund only genuinely-orphaned *active* jobs.

### Hardware auto-sizing + OOM safety valve (launch scope)
Reuses the hardware read already present in `control.js:360-363` (`os.cpus()`/`os.totalmem()`/`os.freemem()`).
- **Startup auto-size:** if `config.runtime.max_concurrent` is unset/`0`, compute the conservative `MAX_AGENTS` (above) instead of `Infinity`. Print one clear first-run line: `Detected <RAM> / <cores> → capacity <N> agents (2GB each, <reserve> host reserve). Override with max_concurrent in config.` so a non-expert operator immediately understands what their machine will do.
- **Runtime safety valve:** before every spawn/respawn, if `os.freemem()` < `perContainerMem + margin`, do **not** spawn — leave the job queued and retry next scheduler pass. Defense-in-depth against OOM when other host processes consume RAM; the count gate stays primary.

### `pause_ttl` while queued
The existing TTL check (`cli.js:4987`) is extended to scan `state.reactivationQueue`: for each entry, if `now - pausedAt >= pauseTtlMin` → auto-cancel/refund and remove from the queue (same platform semantics as today). A queued job that exceeds its TTL never respawns.

## Data flow

**Pause:** worker idle → `pauseJob` → platform `paused` → worker `job_idle` IPC → dispatcher kills container, removes from `state.active`, pushes to `reactivationQueue`, persists → scheduler fills the freed slot.

**Resume:** buyer reactivates → `job.resumed` webhook / poll `paused→in_progress` → dispatcher sets `readyToRespawn` → scheduler, on a free slot, respawns via `startJob` → fresh worker re-auths + reloads context → conversation continues.

**TTL expiry while queued:** TTL sweep finds an over-age queued job → auto-cancel/refund → remove from queue (no respawn).

**Restart:** startup loads `reactivation-queue.json` → entries restored to `reactivationQueue` (paused); crash-recovery refunds only orphaned active jobs, never queued ones.

## Error handling

- **Respawn fails** (container won't boot): retry up to the existing `MAX_RETRIES`; on exhaustion, leave the job in the queue (still `readyToRespawn`) for the next scheduler pass and log — do not silently drop or double-refund. (Reuse existing job-start failure handling.)
- **Resume for an unknown/absent job**: idempotent no-op (already respawned, completed, or TTL-cancelled).
- **Double resume signals** (webhook + poll): setting `readyToRespawn` is idempotent; the scheduler respawns once (guard on `state.active.has(jobId)`).
- **Kill/exit race**: the worker container exiting after a pause-kill is expected; it must not trigger the crash-recovery refund path for a job that is in `reactivationQueue`.

## Testing

- **Pause frees a slot:** simulate a `job_idle` for an active job → assert container killed, job removed from `state.active`, present in `reactivationQueue`, `state.active.size` decremented.
- **Priority scheduling:** with a `readyToRespawn` resume and a new job both waiting and one free slot → assert the resumed job is placed first.
- **Capacity gate:** at `state.active.size === MAX_AGENTS`, a ready resume waits; on a container exit, it is placed.
- **TTL while queued:** a queued job past `pauseTtlMin` → asserted auto-cancelled/refunded and removed, never respawned.
- **Persistence/restart:** enqueue → simulate restart (reload) → queue restored; crash-recovery refund sweep does **not** refund queued jobs.
- **Idempotent resume:** duplicate resume signals → exactly one respawn.
- **Stateless respawn (integration/live):** pause a real chat job, resume it, assert the respawned worker reconnects and continues the same conversation (the live proof; unit tests cover the scheduling/queue logic).

## Deferred — later layers (explicitly NOT in this launch)
Keep the launch tight; these come after people are using it:
- A `dispatcher doctor` / `resources` command (detected hardware, capacity, live usage, queue depth). Observability, not launch-blocking.
- Configurable per-container size (`container_memory_mb`/`container_cpus`) + `balanced`/`aggressive` auto-size profiles. Ship conservative + fixed 2GB/1CPU first.
- Reserved resume headroom (`reserve_resume_slots`), a throttle-in-place tier for instant resume of recently-paused jobs, and per-agent heterogeneous resource profiles.
- CPU/RAM watermarks as a *primary* gate (the count + freemem valve suffices at fixed sizing).

## Global constraints

- **No new runtime dependency** — Node built-ins + existing `dockerode`/`config.js` helpers only.
- **Reuse existing mechanics** — `startJob`/`startJobContainer` for respawn, `persistActiveJobs`-style persistence, the existing pause/resume detectors and TTL loop. This is orchestration around them, not a rewrite.
- **Capacity is `MAX_AGENTS`** (`config.runtime.max_concurrent`); `0` stays unlimited. No watermarks.
- **Fail safe on money:** a queued paid job is never lost — persisted across restart, TTL-refunded on expiry, never double-refunded. Crash recovery refunds only orphaned *active* jobs.
- **Stateless respawn** — the respawned worker reloads all conversation/job state from the platform; the container holds nothing durable.
- **No behavior change when `max_concurrent` is unlimited and nothing pauses** — the new paths are only exercised on pause/resume.
- CJS, no build step; `node --check` + `node --test` (dispatcher suite currently green at 350).
