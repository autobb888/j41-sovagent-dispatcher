# Upstream-Health over the Control Socket (Phase 1.5) — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Component:** `@junction41/dispatcher` — control socket (`src/control.js`) + terminal dashboard (`src/dashboard.js`)
**Follows:** `2026-06-21-tui-live-jobs-design.md` (Phase 1)

## Problem

Phase 1 removed the dashboard's upstream-health tags (`[healthy …]` / `[no health check yet]`) from the Status and Services screens because they read an in-process `Map` in `src/upstream-health.js` that is only populated inside the dispatcher process — from the separate dashboard process it was always empty, so the tag was permanently misleading. The tags were dropped rather than faked.

The data itself is real and useful: the dispatcher runs `startHealthPoller` which probes each api-endpoint agent's upstream and records `{ healthy, lastCheck, status?, error?, consecutive_failures, circuitOpenedAt }` per agent. We just need to expose it across the process boundary so the dashboard can render accurate tags.

## Goal (Phase 1.5)

Expose the dispatcher's upstream-health map over the **local control socket** and re-enable accurate health tags in the Status and Services screens.

Out of scope: per-job Docker log tail and the Docker log-persistence P0 fix (a separate piece); the network HTTP control API (`:9843`) is **not** touched.

## Security

- The new data is served **only over the Unix domain control socket** (`~/.j41/dispatcher/control.sock`), which is local and filesystem-permission-scoped to the operator's user — the same surface that already serves `jobs`, `agents`, `resources` (job ids, PIDs, agent identities, RSS). We are **not** adding it to the token-gated network HTTP control API on `:9843`, so there is no new remote exposure.
- The payload contains operational health only — `healthy`, `lastCheck`, HTTP `status`, a fetch `error` string, and circuit-breaker counters. **No secrets** (no WIFs, keys, tokens, or buyer data). The `error` string may include the operator's own upstream host; that is information the operator already owns and is consistent with existing socket payloads.
- Read-only: no new mutating commands; the handler only reads the in-process map.

## Architecture

### A. Daemon: `src/control.js`

- New pure read-model `buildUpstreamHealth(state)`:
  - `const { getHealth } = require('./upstream-health.js')` (lazy require inside the function or top-of-file, matching existing style).
  - Returns `{ [agentId]: getHealth(agentId) || null }` for every `agent` in `state.agents` (`null` = never probed).
- New socket action: `case 'upstream_health': return buildUpstreamHealth(state);` in the command handler.
- Add `buildUpstreamHealth` to `module.exports` (for unit testing).
- Same process as the poller, so the handler reads the live `_health` map directly — no state plumbing.

### B. TUI: new `src/tui/health-tag.js` + `src/dashboard.js`

- New **pure** module `src/tui/health-tag.js`:
  - `formatUpstreamHealthTag(h, now)` → string:
    - `h == null` → `''` (never checked / not applicable → render no tag).
    - `h.healthy === true` → `  [healthy <ageS>s ago]` (green), where `ageS = Math.round((now - h.lastCheck)/1000)`.
    - `h.healthy === false` → `  [DOWN — <h.error || 'status ' + h.status>]` (red).
  - Pure: no I/O, deterministic given `(h, now)`. Single responsibility (used by two screens), kept out of `live-screen.js`.
- `src/dashboard.js`:
  - Add a helper `fetchUpstreamHealth()` → `sendCommand({ action: 'upstream_health' }).catch(() => ({}))` (empty map on error / dispatcher down).
  - **Status screen** (`statusScreen`): in the API-Proxy section, fetch the map once, then for each api-endpoint agent render `formatUpstreamHealthTag(map[a.id], Date.now())` in place of the current empty `healthTag`.
  - **Services screen** (`configureServicesScreen`): fetch the map once, then for each api-endpoint service render `formatUpstreamHealthTag(map[agentId], Date.now())` in place of the current empty `healthTag`.

### C. Data flow

```
dashboard ─ sendCommand({action:'upstream_health'}) → buildUpstreamHealth(state)
          → { agentId: { healthy, lastCheck, status?, error?, circuitOpenedAt, consecutive_failures } | null }
          → formatUpstreamHealthTag(map[id], Date.now())   (pure)  → tag string
```

## Error handling

- Dispatcher down → `sendCommand` rejects → `fetchUpstreamHealth` catch → `{}` → every lookup is `undefined` → `formatUpstreamHealthTag(undefined, …)` returns `''` (treat `undefined` like `null`). No crash. The Status screen's existing live-header already reports "Dispatcher not running".
- A malformed/missing `lastCheck` must not throw; the formatter guards it (if `lastCheck` missing, omit the age or show `?`).

## Testing (TDD)

- **`buildUpstreamHealth` (`test/control-upstream-health.test.js` or extend existing control test):** use the exported `_setHealth(agentId, result)` from `upstream-health.js` to populate the live map, build with a synthetic `state.agents`, and assert: healthy agent → entry with `healthy:true`; down agent → `healthy:false` + error/status; never-checked agent → `null`. Real, no mocks. Call `_reset()` between cases.
- **`health-tag.js` (`test/health-tag.test.js`):** pure formatter with injected `now`:
  - `null`/`undefined` → `''`.
  - healthy + `lastCheck = now - 4000` → matches `/healthy 4s ago/`.
  - down + `error:'ECONNREFUSED'` → matches `/DOWN — ECONNREFUSED/`.
  - down + no error, `status:503` → matches `/DOWN — status 503/`.
  - missing `lastCheck` on a healthy entry → does not throw.
- **Dashboard wiring:** non-interactive — after restarting the dispatcher, `node -e` calling `sendCommand({action:'upstream_health'})` returns a map; and a render-path check feeding it through `formatUpstreamHealthTag`.

## Operational note

The dispatcher must be **restarted** (with `J41_NO_STATUS_TOGGLE=1 J41_SIGNING_BROKER=1`) to pick up the new socket action; done at the verification step.

## Success criteria

- `sendCommand({action:'upstream_health'})` returns a per-agent health map from a running dispatcher.
- Status and Services screens show accurate `[healthy Ns ago]` / `[DOWN — …]` tags for api-endpoint agents, and no tag (not a misleading one) for never-checked agents.
- New unit tests for `buildUpstreamHealth` and `formatUpstreamHealthTag` pass; full suite stays green.
- No changes to the HTTP control API (`:9843`); no new mutating commands; no secrets exposed.
