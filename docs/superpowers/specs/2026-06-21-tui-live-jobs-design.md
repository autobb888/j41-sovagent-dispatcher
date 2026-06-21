# TUI Live Jobs — Phase 1 Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Component:** `@junction41/dispatcher` terminal dashboard (`src/dashboard.js`)

## Problem

The dispatcher's terminal dashboard (`src/dashboard.js`, ~3047 lines, Inquirer-based) **never talks to the running dispatcher**. It reads the platform REST API, local files, and `docker ps`, but never uses the control socket (`~/.j41/dispatcher/control.sock`) or the read-model builders in `src/control.js`. Consequences:

1. **No live job visibility.** The dispatcher tracks running jobs in `state.active` and exposes them over the socket (`buildJobs`), but the TUI can't show what's running now.
2. **Broken upstream-health tags.** `Status & Health` reads an in-process `Map` from `src/upstream-health.js` that is only populated *inside the dispatcher process*; from the separate TUI process it is always empty → tags show "not checked" forever.
3. **Hardcoded log path.** `View Logs` tails `/tmp/dispatcher.log`, which only exists if the dispatcher was launched via the TUI.
4. **No auto-refresh** on any screen — every screen is a one-shot snapshot that can silently disagree with `ctl status`.

The fix scaffolding already exists: `control.js` exports `sendCommand(cmd)` plus `buildJobs`/`buildStatus`/`buildAgents`/`buildHealthDocument`, and the socket server already handles `status`, `jobs`, `agents`, `resources`, `history`, `earnings`. The TUI simply needs to consume it.

## Goals (Phase 1)

Read-only, client-side only. **No changes to the dispatcher daemon, no new socket commands, no money/refund paths.**

1. Add a **live, auto-refreshing "Live Jobs" screen** (new top menu item) backed by the control socket.
2. **Fix `Status & Health`** to pull live header numbers (uptime/agents/active/queue) from the socket (`status`) so they match `ctl status`, and **stop the misleading upstream-health tag** (the "no health check yet" string can never populate cross-process). NOTE: `resources` does **not** carry upstream-health data and there is no socket/health-doc field for it today, so a *full* upstream-health repair needs a read-model addition in the daemon — that is **deferred to Phase 1.5** (out of this client-side-only phase). Phase 1 removes the false signal rather than faking one.
3. **Fix `View Logs`** to resolve the dispatcher's log location instead of assuming a single hardcoded path (see resolution order below).
4. Isolate the non-blocking render loop into a small, **testable** module that can later be lifted into a full-screen TUI.

## Phasing context

- **Phase 1 (this spec):** live screens within the existing Inquirer menu; isolated `live-screen` component.
- **Phase 2 (future, out of scope):** lift the `live-screen` component into a full-screen Ink/blessed shell (persistent header/footer, panes, vim nav, fuzzy filter).

## Architecture

### New component: `src/tui/live-screen.js`

Isolates the tricky non-blocking render loop, with a **pure render function** separated from the loop and I/O so it is unit-testable.

- `renderActiveJobs(data) → string` — **pure**: job/queue data → screen text. No I/O.
- `runLiveScreen({ fetch, render, intervalMs = 2500, onKey })` — owns the loop:
  - Clears + renders once, then redraws on an interval.
  - Puts `stdin` in raw mode; key handling: `q`/ESC → exit to menu, `r` → force refresh, digit/`enter` → drill into a job.
  - **Always restores `stdin` (raw mode off, listeners removed) on exit or exception via `try/finally`** so it cannot wedge the terminal.
  - Calls the injected `fetch` (so tests inject a fake; production passes a `sendCommand` wrapper).

### Data flow (no daemon changes)

```
Live Jobs screen ─ sendCommand({action:'jobs'})      → buildJobs   → Active Jobs table + queue depth
                 ─ sendCommand({action:'resources'}) → per-job RSS / token usage (drill-down detail)
Status & Health  ─ sendCommand({action:'status'})    → buildStatus → live uptime/agents/active/queue
                 ─ sendCommand({action:'resources'}) → CPU/mem + per-job RSS (NO upstream-health field; see Goals note)
```

Drill-down on a single job reuses the data already returned by `jobs` + `resources`; **no new socket command** is added.

### Menu changes (`src/dashboard.js`)

- Add `Live Jobs` as the first menu item.
- Rewire `Status & Health` data source from disk/in-process reads to `sendCommand`.
- Rewire `View Logs` to resolve the dispatcher log path in priority order: (1) a configured log path if set, (2) the TUI-managed path if the dispatcher was launched via the dashboard, (3) otherwise show an honest message that logs are not being captured to a file (the dispatcher was started with stdout elsewhere), pointing the operator at how to capture them. No fabricated/empty tail.

## Error handling

- `sendCommand` already rejects with a clear error when the socket is absent (`"Dispatcher is not running (no control socket)"`). The live screen catches this and renders a tidy *"dispatcher not running — press q to go back"* state rather than throwing.
- Transient fetch errors during the loop render an inline error line; the loop keeps running so it recovers when the dispatcher returns.
- Raw-mode restore is guaranteed via `try/finally`.
- Existing `promptWithEsc` screens are left untouched.

## Testing (TDD)

`live-screen.js` is the unit under test, with `fetch` (and stdin/timers) injected:

- **Pure render snapshots:** empty list, one running job, paused job, queue depth > 0, dispatcher-down error state.
- **Loop behavior:** with fake timers + fake stdin, assert it refreshes on the interval and stops cleanly on `q` (and restores raw mode).
- **Fetch error:** rejection renders the error line without crashing the loop.

No live socket or Docker is required for tests.

## Out of scope (YAGNI for Phase 1)

- Full-screen Ink/blessed shell → Phase 2.
- Job control actions (pause/resume/cancel) → deferred (require new daemon commands + refund handling; overlaps the P0 hardening sprint).
- Dedicated `events.jsonl` event-stream feed → Phase 1.5 (auto-refresh already provides liveness).
- **Per-job Docker log tail → blocked** on the separate P0 fix to persist Docker container logs to `output.log` (Docker jobs currently stream only to the dispatcher's stdout). Until then, the screen shows an honest *"per-job logs unavailable (Docker logs not yet persisted)"* note instead of faking output.

## Success criteria

- Operator can open the dashboard and see, live and auto-refreshing, every job currently running (agent, short job id, runtime, token usage, paused/workspace flags) plus queue depth — matching `ctl jobs`.
- `Status & Health` numbers match `ctl status`, and upstream-health tags populate when the dispatcher is polling upstreams.
- `View Logs` finds the running dispatcher's log regardless of how it was launched.
- `live-screen.js` has unit tests covering render states and loop start/stop; full suite stays green.
- No changes to `src/cli.js` job/daemon logic; no new socket commands.
