# Dispatcher Lifecycle Robustness — Design

**Date:** 2026-07-14
**Status:** Proposal — for review before planning
**Repo:** `j41-sovagent-dispatcher`
**Origin:** Live reactivation E2E (2026-07-14, dispatcher `9ab8b87`, image `d70a0dfa1f7d`). The run surfaced two
launch-critical robustness bugs. Both share one theme: **the dispatcher assumes ideal conditions (chain synced at
boot, webhook mode) and degrades badly otherwise** — unacceptable for a "anyone in the world can download and run"
product.

---

## Bug 1 — Reactivation pause never frees the container (Docker + Poll mode)

### Problem
The reactivation feature's promise is: *on pause, free the container so an operator can oversubscribe*. Proven **not
to hold** in the default production config (Docker/gVisor + Poll mode). Job `8c8e6738` resumed, respawned correctly,
re-idled, `Session paused` at 18:28 — but its container held `Active: 1/7` until the **60-min job timeout** (19:18).
It was never freed.

Root cause — three pause→free triggers exist, none fire in Docker+Poll:
- `job_idle` IPC (`job-agent.js:844` `process.send`) — **local mode only**; `process.send` is undefined inside a
  Docker container, so the signal is silently dropped. The dispatcher's `child.on('message')` handler
  (`cli.js:6609`) only receives from child processes, not containers.
- `job.paused` webhook (`cli.js:5533` → `moveJobToReactivationQueue` at 5550) — **webhook mode only**.
- The active-jobs poll loop detects the **resume** direction (`cli.js:5141`, `in_progress && paused`) but has **no
  pause-direction branch**.

Resume→respawn itself works (proven). Only the pause→free and the queued-job→resume signals are missing in poll mode.
The queued-resume gap was already noted as deferred in the reactivation plan; same root cause.

### Fix
Add the missing poll-mode detectors, keep the webhook handlers for operators who have a URL.

1. **Poll pause detection.** In the active-jobs poll loop (alongside the resume branch at `cli.js:5141`), when the
   already-fetched `currentJob.status === 'paused'` and the job is in `state.active`, not already `paused`, and not
   `_pausing` → `await moveJobToReactivationQueue(state, jobId)`. Reuses the status already fetched this cycle (no
   extra API call). `moveJobToReactivationQueue` already carries the `_pausing` synchronous guard + money-safe
   enqueue-before-teardown ordering, so it is safe to call from the poll path.

2. **Poll queued-resume detection.** Queued jobs live in `state.reactivationQueue`, not `state.active`, so the active
   poll never checks them. Add a **throttled, batched** sweep: each cycle, take up to `RESUME_POLL_BATCH` (default 10)
   queued entries (round-robin across cycles so all get checked over time), fetch each job's platform status, and when
   it is `in_progress` → `rq.markReady(...)` + `respawnReadyResumes(state)`. Batching keeps it scale-safe at 100+
   queued jobs. Respawn already guards on `state.active.has` (no double-spawn) and capacity (`MAX_AGENTS`).

3. **Webhook path unchanged.** `job.paused` / `job.resumed` handlers stay as the instant path. When webhooks are
   active, the poll detectors are near-no-ops (status already reconciled) — no double action (guards are idempotent).

### Design decisions
- Poll pause detection piggybacks on the existing per-job status fetch — zero added API cost.
- Queued-resume is batched (round-robin, N/cycle) rather than polling every queued job every cycle — scale-aware.
- Webhooks remain the fast path; poll is the works-everywhere fallback. No behavior change when webhooks drive events.

---

## Bug 2 — Capability load never self-heals after a boot-time failure

### Problem
`cli.js:3231-3350`. At startup the dispatcher loads each agent's on-chain capabilities (VDXF decode → services,
workspace, dispute policy, markup → `state.capabilities`). When the **chain is catching up** (common on testnet; it
hit this run), every agent's fetch throws `Sign-in temporarily unavailable while the chain catches up` and is stored
as `{ workspace:false, services:[], profile:null, _fetchFailed:true }`.

The retry loop (`cli.js:3334`) is a near-no-op: it only calls `getAgentServices` sniffing for an **api-endpoint**; for
normal agents it does nothing — it never re-runs the capability load, never stores capabilities, never clears
`_fetchFailed`. The code comment admits it: *"Operator must restart dispatcher once detected."* Result: agents stay
**capability-less until a manual restart** (37 empty retries over 3h in the live log). A tester who booted during
chain-sync and waited ~10 min (2 retry cycles) sees the dispatcher never finish starting up.

### Fix
Make capability loading self-heal — no manual restart.

1. **Extract** the per-agent capability-load body (the `for` loop over `readyAgents` at `cli.js:3233-3322`) into a
   reusable `async loadAgentCapabilities(state, agentInfo)` that: fetches VDXF, decodes, computes
   `workspace/services/profile`, stores into `state.capabilities`, and — on success — ensures `_fetchFailed` is unset.
   On throw it stores the `_fetchFailed:true` placeholder (current behavior). Returns `true` on success.

2. **Boot load** calls it for all agents (unchanged behavior, same log lines).

3. **Self-healing retry.** Replace the api-endpoint-only retry with a timer that re-runs `loadAgentCapabilities` for
   every still-`_fetchFailed` agent. On each pass, drop the agents that now succeed. **Stop the timer when none remain
   failed.** Interval **60s** (chain-catchup recovers in minutes; 5-min was far too slow). Also reload the dispute
   policy/markup for healed agents (currently loaded once at boot, `cli.js:3353`).

4. **api-endpoint case preserved.** If a healed agent turns out to expose an api-endpoint and the proxy is not
   running, keep the existing *"restart dispatcher to activate proxy"* notice (proxy hot-start is out of scope). The
   capabilities themselves still reload so the agent is otherwise fully functional.

5. **Bounded + fail-safe.** Never crash on capability failure; agents remain able to take basic jobs (proven — chat
   worked with empty capabilities). If still failing after a long cap (e.g. 30 min), log loudly once and keep the
   dispatcher running (degraded, not dead).

### Design decisions
- Interval 60s (was 5min) to match chain-catchup recovery timescale.
- Self-heal is idempotent — re-running the load overwrites `state.capabilities` cleanly.
- No restart required for the common (non-api-endpoint) case; api-endpoint proxy hot-activation is explicitly deferred.

---

## Testing

**Unit (`node --test`):**
- Bug 2: a `loadAgentCapabilities` seam whose fetch fails then succeeds → the retry stores capabilities, clears
  `_fetchFailed`, and stops the timer once all agents are healed. (Inject a fake agent-session/client.)
- Bug 1: poll pause detection calls `moveJobToReactivationQueue` exactly once when a job's status flips to `paused`
  (and not when already paused/`_pausing`); queued-resume sweep respawns when a queued job's status flips to
  `in_progress`; batching caps calls per cycle and round-robins.

**Live E2E (the real proof, re-run after build):**
1. Boot the dispatcher during (or right after) a chain-sync → capabilities **self-heal within ~1-2 min, no restart**;
   agent capability lines appear.
2. Hire a chat job → send a message (real LLM output) → idle ~10 min → **container freed** (`Active` drops, no crash)
   → resume → **respawn + history reload**.

## Global constraints
- CJS, no build step; `node --check src/*.js` + `node --test test/*.js`. No new runtime dependency.
- **Money-safe:** reuse `moveJobToReactivationQueue` (enqueue-before-teardown), `respawnReadyResumes`
  (capacity-gated, `state.active.has` guard); no double-refund, no double-spawn.
- **Fail-safe:** a capability-load failure must never crash the dispatcher; agents stay functional for basic jobs.
- **Works in BOTH modes:** poll (the fallback these fixes add) and webhook (unchanged instant path). No behavior change
  when webhooks are active and the chain is synced at boot.
- Reuse existing mechanics — this is orchestration hardening around `moveJobToReactivationQueue` /
  `respawnReadyResumes` / the capability loader, not a rewrite.

## Deferred (explicitly out of scope)
- api-endpoint proxy **hot-activation** without restart (keep the restart notice).
- Exponential backoff / jitter on the capability retry (fixed 60s is sufficient for launch).
- Per-queued-job resume webhooks vs poll reconciliation edge cases beyond the batched sweep.
