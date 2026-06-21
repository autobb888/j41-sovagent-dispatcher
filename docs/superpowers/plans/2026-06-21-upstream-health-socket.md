# Upstream-Health over the Control Socket (Phase 1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the dispatcher's in-process upstream-health map over the local control socket and re-enable accurate `[healthy …]` / `[DOWN …]` tags in the Status and Services dashboard screens.

**Architecture:** A pure read-model `buildUpstreamHealth(state)` + a new `upstream_health` socket action in `src/control.js` (reads the same-process `getHealth` map). A new pure formatter `src/tui/health-tag.js`. `src/dashboard.js` fetches the map once per screen and renders tags via the formatter. Local Unix socket only — not the network HTTP API. Read-only.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict`, existing `control.js` Unix-socket control plane, `upstream-health.js` poller.

**Spec:** `docs/superpowers/specs/2026-06-21-upstream-health-socket-design.md`

---

## File Structure

- **Modify** `src/control.js` — add `buildUpstreamHealth(state)` read-model, an `upstream_health` socket case, and the export. One responsibility: serialize the live health map.
- **Create** `test/control-upstream-health.test.js` — unit tests for `buildUpstreamHealth`.
- **Create** `src/tui/health-tag.js` — pure `formatUpstreamHealthTag(h, now)`. One responsibility: format one health entry as a tag.
- **Create** `test/health-tag.test.js` — unit tests for the formatter.
- **Modify** `src/dashboard.js` — add `fetchUpstreamHealth()` helper + render tags in Status and Services screens.

No daemon job-lifecycle code is touched. No changes to `src/cli.js` or the HTTP control API.

---

## Task 1: `buildUpstreamHealth` read-model + `upstream_health` socket action

**Files:**
- Modify: `src/control.js` (add function before `buildHealthDocument` ~line 249; add case after `case 'agents'` ~line 313; add to `module.exports` ~line 488)
- Test: `test/control-upstream-health.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/control-upstream-health.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUpstreamHealth } = require('../src/control');
const { _setHealth, _reset } = require('../src/upstream-health');

const stateWith = (ids) => ({ agents: ids.map((id) => ({ id })) });

test('buildUpstreamHealth: healthy, down, and never-checked agents', () => {
  _reset();
  _setHealth('agent-1', { healthy: true, status: 200 });
  _setHealth('agent-2', { healthy: false, error: 'ECONNREFUSED' });
  const out = buildUpstreamHealth(stateWith(['agent-1', 'agent-2', 'agent-3']));
  assert.equal(out['agent-1'].healthy, true);
  assert.equal(out['agent-2'].healthy, false);
  assert.equal(out['agent-2'].error, 'ECONNREFUSED');
  assert.equal(out['agent-3'], null); // never probed → null
  _reset();
});

test('buildUpstreamHealth: empty agents → empty object', () => {
  _reset();
  assert.deepEqual(buildUpstreamHealth({ agents: [] }), {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/control-upstream-health.test.js`
Expected: FAIL — `buildUpstreamHealth` is not a function (not yet exported).

- [ ] **Step 3: Add the read-model function**

In `src/control.js`, immediately ABOVE the line `function buildHealthDocument(state, startedAt) {` (and above its JSDoc block starting with `/**` at ~line 240), insert:

```js
/**
 * Per-agent upstream-health snapshot for the local control socket.
 * Reads the in-process poller map (same process). null = never probed.
 * @param {object} state - dispatcher state with an `agents` array
 * @returns {Object<string, object|null>} agentId → health entry or null
 */
function buildUpstreamHealth(state) {
  const { getHealth } = require('./upstream-health.js');
  const out = {};
  for (const a of state.agents) {
    out[a.id] = getHealth(a.id) || null;
  }
  return out;
}

```

- [ ] **Step 4: Add the socket action**

In `src/control.js`, in `handleCommand`'s `switch (action)`, immediately AFTER:

```js
    case 'agents':
      return buildAgents(state);
```

insert:

```js
    case 'upstream_health':
      return buildUpstreamHealth(state);
```

- [ ] **Step 5: Export it**

In `src/control.js`, in `module.exports = { ... }`, add `buildUpstreamHealth,` next to the other builders (e.g. after `buildAgents,`):

```js
  buildAgents,
  buildUpstreamHealth,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/control-upstream-health.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 7: Lint + commit**

Run: `node --check src/control.js`
Expected: no output, exit 0.

```bash
git add src/control.js test/control-upstream-health.test.js
git commit -m "feat(control): expose upstream-health over the control socket"
```

---

## Task 2: pure `formatUpstreamHealthTag`

**Files:**
- Create: `src/tui/health-tag.js`
- Test: `test/health-tag.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/health-tag.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUpstreamHealthTag } = require('../src/tui/health-tag');
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('formatUpstreamHealthTag: null/undefined → empty string', () => {
  assert.equal(formatUpstreamHealthTag(null, 1000), '');
  assert.equal(formatUpstreamHealthTag(undefined, 1000), '');
});

test('formatUpstreamHealthTag: healthy shows age in seconds', () => {
  const out = plain(formatUpstreamHealthTag({ healthy: true, lastCheck: 1000 }, 5000));
  assert.match(out, /\[healthy 4s ago\]/);
});

test('formatUpstreamHealthTag: down with error', () => {
  const out = plain(formatUpstreamHealthTag({ healthy: false, error: 'ECONNREFUSED' }, 5000));
  assert.match(out, /\[DOWN — ECONNREFUSED\]/);
});

test('formatUpstreamHealthTag: down with no error falls back to status', () => {
  const out = plain(formatUpstreamHealthTag({ healthy: false, status: 503 }, 5000));
  assert.match(out, /\[DOWN — status 503\]/);
});

test('formatUpstreamHealthTag: healthy without lastCheck does not throw', () => {
  assert.doesNotThrow(() => formatUpstreamHealthTag({ healthy: true }, 5000));
  assert.match(plain(formatUpstreamHealthTag({ healthy: true }, 5000)), /\[healthy\]/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/health-tag.test.js`
Expected: FAIL — `Cannot find module '../src/tui/health-tag'`.

- [ ] **Step 3: Write the implementation**

Create `src/tui/health-tag.js`:

```js
'use strict';

const GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';

/**
 * Format one upstream-health entry as a colored dashboard tag.
 * Pure: deterministic given (h, now). Treats null/undefined alike (no data → no tag).
 * @param {object|null|undefined} h - a health entry from buildUpstreamHealth, or null/undefined
 * @param {number} now - current epoch ms (injected for testability)
 * @returns {string} '' when there is no data, otherwise a leading-space tag
 */
function formatUpstreamHealthTag(h, now) {
  if (h == null) return '';
  if (h.healthy) {
    if (h.lastCheck == null) return `  ${GREEN}[healthy]${RESET}`;
    const ageS = Math.round((now - h.lastCheck) / 1000);
    return `  ${GREEN}[healthy ${ageS}s ago]${RESET}`;
  }
  const reason = h.error || `status ${h.status}`;
  return `  ${RED}[DOWN — ${reason}]${RESET}`;
}

module.exports = { formatUpstreamHealthTag };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/health-tag.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Lint + commit**

Run: `node --check src/tui/health-tag.js`
Expected: no output, exit 0.

```bash
git add src/tui/health-tag.js test/health-tag.test.js
git commit -m "feat(tui): pure formatUpstreamHealthTag"
```

---

## Task 3: Wire the tags into the dashboard

**Files:**
- Modify: `src/dashboard.js` (require ~line 19; new helper above `statusScreen`; Status section ~833-840; Services section ~1232-1238)

- [ ] **Step 1: Add the require**

In `src/dashboard.js`, immediately AFTER the line:

```js
const { renderActiveJobs, runLiveScreen } = require('./tui/live-screen.js');
```

insert:

```js
const { formatUpstreamHealthTag } = require('./tui/health-tag.js');
```

- [ ] **Step 2: Add the `fetchUpstreamHealth` helper**

In `src/dashboard.js`, immediately ABOVE the line `function resolveDispatcherLogPath() {`, insert:

```js
// Fetch the per-agent upstream-health map from the running dispatcher.
// Returns {} if the dispatcher isn't running (so callers render no tag).
async function fetchUpstreamHealth() {
  try { return await sendCommand({ action: 'upstream_health' }); }
  catch { return {}; }
}

```

- [ ] **Step 3: Wire the Status screen**

In `src/dashboard.js`, in `statusScreen`, find:

```js
    let totalDeposited = 0, totalSpent = 0, totalActiveKeys = 0;
    for (const a of apiAgents) {
```

and replace with:

```js
    let totalDeposited = 0, totalSpent = 0, totalActiveKeys = 0;
    const healthMap = await fetchUpstreamHealth();
    for (const a of apiAgents) {
```

Then find:

```js
      // Upstream health is tracked in-process by the dispatcher and is not yet
      // exposed over the control socket (Phase 1.5). Show no tag rather than a
      // misleading "no health check yet".
      const healthTag = '';
```

and replace with:

```js
      const healthTag = formatUpstreamHealthTag(healthMap[a.id], Date.now());
```

- [ ] **Step 4: Wire the Services screen**

In `src/dashboard.js`, in `configureServicesScreen`, find:

```js
    if (list.length > 0) {
      for (let i = 0; i < list.length; i++) {
```

and replace with:

```js
    if (list.length > 0) {
      const healthMap = await fetchUpstreamHealth();
      for (let i = 0; i < list.length; i++) {
```

Then find:

```js
        // Upstream health isn't exposed over the control socket yet (Phase 1.5);
        // omit the tag rather than always showing a misleading "not checked".
        const healthTag = '';
```

and replace with:

```js
        const healthTag = isApi ? formatUpstreamHealthTag(healthMap[agentId], Date.now()) : '';
```

- [ ] **Step 5: Syntax-check**

Run: `node --check src/dashboard.js`
Expected: no output, exit 0.

- [ ] **Step 6: Verify requires + formatter resolve, non-interactively**

Run: `node -e "const {formatUpstreamHealthTag}=require('./src/tui/health-tag.js'); const {sendCommand}=require('./src/control.js'); console.log(typeof formatUpstreamHealthTag, typeof sendCommand); console.log(JSON.stringify(formatUpstreamHealthTag({healthy:false,error:'x'},Date.now())))"`
Expected: `function function` then a JSON string containing `[DOWN — x]`.

- [ ] **Step 7: Confirm the wiring edits are present**

Run: `grep -n "fetchUpstreamHealth\|formatUpstreamHealthTag" src/dashboard.js`
Expected: the require, the helper definition, and one use in each of the Status and Services screens (≥4 matches total).

- [ ] **Step 8: Commit**

```bash
git add src/dashboard.js
git commit -m "feat(tui): render live upstream-health tags in Status and Services screens"
```

NOTE: the live end-to-end check (the new `upstream_health` socket action actually returning data) requires restarting the running dispatcher and is performed in Task 4 by the controller — do not attempt to restart the dispatcher from this task.

---

## Task 4: Full suite, lint, and live verification (controller-run)

**Files:** none (verification only). The dispatcher restart is operational and is performed by the controller, not a subagent.

- [ ] **Step 1: Full suite + lint**

Run: `npm test`
Expected: lint clean, all tests pass. Count = previous 174 + 2 (Task 1) + 5 (Task 2) = **181**, 0 fail.

Run: `node --check src/control.js src/tui/health-tag.js src/dashboard.js`
Expected: no output, exit 0.

- [ ] **Step 2: Restart the dispatcher to load the new socket action**

The running dispatcher does not have the `upstream_health` action until restarted. From the repo dir:

Run: `J41_NO_STATUS_TOGGLE=1 J41_SIGNING_BROKER=1 node src/cli.js start > /tmp/j41-dispatcher.log 2>&1 &`
Wait for `✅ Dispatcher running` in `/tmp/j41-dispatcher.log`.

- [ ] **Step 3: Verify the live socket action**

Run: `node src/cli.js ctl status` (confirm dispatcher up), then:
`node -e "const {sendCommand}=require('./src/control.js'); sendCommand({action:'upstream_health'}).then(m=>console.log(JSON.stringify(m,null,2)))"`
Expected: a JSON object keyed by agent id; api-endpoint agents that have been probed show `{healthy,...,lastCheck}`, others show `null`. No error.

- [ ] **Step 4: Render-path spot check**

Run: `node -e "const {sendCommand}=require('./src/control.js'); const {formatUpstreamHealthTag}=require('./src/tui/health-tag.js'); sendCommand({action:'upstream_health'}).then(m=>{for(const id in m){console.log(id, JSON.stringify(formatUpstreamHealthTag(m[id], Date.now())))}})"`
Expected: each agent prints its tag string (empty for never-probed, `[healthy Ns ago]` / `[DOWN — …]` otherwise). No throw.

---

## Notes for the implementer

- Tasks 1–3 are subagent work. Task 4 is controller-run (it restarts the live dispatcher — a subagent must NOT do this).
- Do NOT modify `src/cli.js` or the HTTP control API (`src/control-api.js`). This change is local-socket only and read-only.
- `_setHealth`/`_reset` are exported from `src/upstream-health.js` specifically for tests; use `_reset()` between cases so tests don't leak state.
- The formatter treats `null` and `undefined` identically (`h == null`) so a missing agent key renders no tag.
