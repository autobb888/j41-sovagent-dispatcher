# Reactivation Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On pause, free the job's container and enqueue it; on resume, respawn a fresh stateless worker gated by a hardware-auto-sized capacity — so the dispatcher can oversubscribe far past its container count.

**Architecture:** Two new pure, unit-tested modules (`reactivation-queue.js` for the queue operations, `hardware-sizing.js` for conservative capacity math) plus persistence helpers in `config.js`, then wiring in `cli.js` that reuses the existing spawn path (`startJob`), the existing scheduler drain loop (`cli.js:5054`), the two pause detectors (`cli.js:5347`, `6381`), the two resume detectors (`cli.js:4952/4958`, `5337`), and the pause_ttl sweep (`cli.js:4987`).

**Tech Stack:** Node.js CJS (no build step), `node:test` + `node:assert`, `dockerode` (already a dep), existing `src/config.js` persistence helpers.

## Global Constraints

- **No new runtime dependency** — Node built-ins + existing `dockerode`/`config.js` only.
- **Reuse existing mechanics** — `startJob`/`startJobContainer` for respawn, `persistActiveJobs`-style persistence, the existing pause/resume detectors and the `cli.js:5054` drain loop, the `cli.js:4987` TTL loop. Orchestration, not a rewrite.
- **Capacity is `MAX_AGENTS`** (`config.runtime.max_concurrent`); when unset/`0`, auto-derive it conservatively from hardware instead of `Infinity`. Per-container size stays `2GB / 1 CPU`.
- **Fail safe on money** — a queued paid job is never lost: persisted across restart, TTL-refunded on expiry, never double-refunded. Crash recovery refunds only orphaned *active* jobs, never queued ones.
- **Stateless respawn** — the respawned worker reloads all conversation/job state from the platform; the container holds nothing durable.
- **Resumed jobs get slot priority** over new jobs; full box → wait in queue (no reserved headroom this launch).
- **Verify:** `node --check` on every changed file; `node --test test/*.test.js` stays green (currently 350 passing).

---

### Task 1: Hardware auto-sizing module

**Files:**
- Create: `src/hardware-sizing.js`
- Test: `test/hardware-sizing.test.js`

**Interfaces:**
- Produces: `computeMaxAgents({ totalMemBytes, cpuCount, perContainerMemBytes?, hostReserveBytes?, coreReserve? }) → number` (integer ≥ 1); `capacityLine({ totalMemBytes, cpuCount, maxAgents, perContainerMemBytes, hostReserveBytes }) → string`; `DEFAULTS` object.

- [ ] **Step 1: Write the failing test**

```javascript
// test/hardware-sizing.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeMaxAgents, capacityLine, DEFAULTS } = require('../src/hardware-sizing.js');

const GB = 1024 * 1024 * 1024;

test('memory is the binding constraint on a RAM-poor box', () => {
  // 8GB, 8 cores, 2GB/container, reserve = max(2GB, 15% of 8GB=1.2GB)=2GB
  // memBound = floor((8-2)/2) = 3 ; cpuBound = 8-1 = 7 ; min = 3
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 8 * GB, cpuCount: 8 }), 3);
});

test('cpu is the binding constraint on a RAM-rich box', () => {
  // 128GB, 4 cores. memBound huge; cpuBound = 4-1 = 3
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 128 * GB, cpuCount: 4 }), 3);
});

test('never returns below 1 even on a tiny box', () => {
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 2 * GB, cpuCount: 1 }), 1);
});

test('conservative reserve is at least 15% of total on large boxes', () => {
  // 256GB, 64 cores: reserve=max(2GB, 38.4GB)=38.4GB; memBound=floor((256-38.4)/2)=108; cpuBound=63; min=63
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 256 * GB, cpuCount: 64 }), 63);
});

test('explicit per-container size changes the memory bound', () => {
  // 8GB, 8 cores, 1GB/container: reserve 2GB; memBound=floor(6/1)=6; cpuBound=7; min=6
  assert.strictEqual(computeMaxAgents({ totalMemBytes: 8 * GB, cpuCount: 8, perContainerMemBytes: GB }), 6);
});

test('capacityLine is human-readable and states the override', () => {
  const line = capacityLine({ totalMemBytes: 8 * GB, cpuCount: 8, maxAgents: 3, perContainerMemBytes: 2 * GB, hostReserveBytes: 2 * GB });
  assert.match(line, /8 GB/);
  assert.match(line, /8 cores/);
  assert.match(line, /3 agents/);
  assert.match(line, /max_concurrent/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/hardware-sizing.test.js`
Expected: FAIL — `Cannot find module '../src/hardware-sizing.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/hardware-sizing.js
'use strict';
// Conservative capacity math for a download-and-run product: never OOM a
// stranger's machine. Pure functions (no os.* calls here) so they're testable;
// cli.js passes in os.totalmem()/os.cpus().length.

const GB = 1024 * 1024 * 1024;
const DEFAULTS = {
  perContainerMemBytes: 2 * GB, // matches cli.js container Memory (5959)
  coreReserve: 1,               // leave a core for host + dispatcher + egress/signer hosts
  minHostReserveBytes: 2 * GB,  // absolute floor for host headroom
  hostReserveFraction: 0.15,    // …or 15% of total, whichever is larger (conservative)
};

function computeMaxAgents({
  totalMemBytes,
  cpuCount,
  perContainerMemBytes = DEFAULTS.perContainerMemBytes,
  hostReserveBytes,
  coreReserve = DEFAULTS.coreReserve,
} = {}) {
  const reserve = hostReserveBytes != null
    ? hostReserveBytes
    : Math.max(DEFAULTS.minHostReserveBytes, Math.floor(totalMemBytes * DEFAULTS.hostReserveFraction));
  const memBound = Math.floor((totalMemBytes - reserve) / perContainerMemBytes);
  const cpuBound = cpuCount - coreReserve;
  return Math.max(1, Math.min(memBound, cpuBound));
}

function capacityLine({ totalMemBytes, cpuCount, maxAgents, perContainerMemBytes, hostReserveBytes }) {
  const gb = (b) => `${Math.round(b / GB)} GB`;
  return `Detected ${gb(totalMemBytes)} / ${cpuCount} cores → capacity ${maxAgents} agents `
    + `(${gb(perContainerMemBytes)} each, ${gb(hostReserveBytes)} host reserve). `
    + `Override with max_concurrent in config.`;
}

module.exports = { computeMaxAgents, capacityLine, DEFAULTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/hardware-sizing.test.js`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add src/hardware-sizing.js test/hardware-sizing.test.js
git commit -m "feat(sizing): conservative hardware capacity math"
```

---

### Task 2: Wire auto-sizing into MAX_AGENTS + first-run line

**Files:**
- Modify: `src/cli.js:81-83` (MAX_AGENTS definition), and the `start` command banner (near `cli.js:3039`, `Max concurrent:` print)

**Interfaces:**
- Consumes: `computeMaxAgents`, `capacityLine`, `DEFAULTS` from Task 1.
- Produces: `MAX_AGENTS` is a finite auto-derived integer when `max_concurrent` is unset/`0` (was `Infinity`).

- [ ] **Step 1: Add the require and replace the MAX_AGENTS definition**

Replace `src/cli.js:81-83`:

```javascript
// was:
// const MAX_AGENTS = cfg.runtime.max_concurrent > 0
//   ? cfg.runtime.max_concurrent
//   : (_cfg.maxConcurrent ? parseInt(_cfg.maxConcurrent) : Infinity);

const os = require('os'); // if not already required at top of cli.js — check first, do not double-declare
const { computeMaxAgents, capacityLine, DEFAULTS: SIZING_DEFAULTS } = require('./hardware-sizing.js');

const _explicitMax = cfg.runtime.max_concurrent > 0
  ? cfg.runtime.max_concurrent
  : (_cfg.maxConcurrent ? parseInt(_cfg.maxConcurrent) : 0);
const _autoMax = computeMaxAgents({ totalMemBytes: os.totalmem(), cpuCount: os.cpus().length });
const MAX_AGENTS = _explicitMax > 0 ? _explicitMax : _autoMax;
const MAX_AGENTS_AUTO = _explicitMax <= 0; // true when we derived it
```

Note: `cli.js` may already `require('os')` — grep first (`grep -n "require('os')" src/cli.js`); if present, do not add a second declaration, just add the `hardware-sizing` require.

- [ ] **Step 2: Print the first-run capacity line in the `start` banner**

Near `cli.js:3039` (`console.log(`Max concurrent: ...`)`), add immediately after it:

```javascript
    if (MAX_AGENTS_AUTO) {
      console.log(capacityLine({
        totalMemBytes: os.totalmem(),
        cpuCount: os.cpus().length,
        maxAgents: MAX_AGENTS,
        perContainerMemBytes: SIZING_DEFAULTS.perContainerMemBytes,
        hostReserveBytes: Math.max(SIZING_DEFAULTS.minHostReserveBytes, Math.floor(os.totalmem() * SIZING_DEFAULTS.hostReserveFraction)),
      }));
    } else if (_autoMax < _explicitMax) {
      console.log(`⚠️  max_concurrent=${_explicitMax} exceeds the safe estimate for this box (${_autoMax}); you may OOM under load.`);
    }
```

- [ ] **Step 3: Verify syntax + suite**

Run: `node --check src/cli.js && node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: syntax ok; full suite still green (350+).

- [ ] **Step 4: Manual smoke — capacity line prints**

Run: `node -e "const {computeMaxAgents,capacityLine,DEFAULTS}=require('./src/hardware-sizing.js');const os=require('os');const m=computeMaxAgents({totalMemBytes:os.totalmem(),cpuCount:os.cpus().length});console.log(capacityLine({totalMemBytes:os.totalmem(),cpuCount:os.cpus().length,maxAgents:m,perContainerMemBytes:DEFAULTS.perContainerMemBytes,hostReserveBytes:Math.max(DEFAULTS.minHostReserveBytes,Math.floor(os.totalmem()*DEFAULTS.hostReserveFraction))}))"`
Expected: a line like `Detected 32 GB / 8 cores → capacity 12 agents (2 GB each, 5 GB host reserve). Override with max_concurrent in config.`

- [ ] **Step 5: Commit**

```bash
git add src/cli.js
git commit -m "feat(cli): auto-size MAX_AGENTS from hardware when max_concurrent unset"
```

---

### Task 3: Reactivation-queue module (pure operations)

**Files:**
- Create: `src/reactivation-queue.js`
- Test: `test/reactivation-queue.test.js`

**Interfaces:**
- Entry shape: `{ job, agentId, pausedAt /*ms*/, pauseTtlMin, readyToRespawn }` where `job` is the plain job object (`{ id, description, buyerVerusId, ... }`).
- Produces: `enqueue(q, entry) → q`; `has(q, jobId) → boolean`; `markReady(q, jobId) → boolean`; `nextReady(q) → entry|null`; `removeJob(q, jobId) → q`; `findExpired(q, nowMs) → entry[]`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/reactivation-queue.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rq = require('../src/reactivation-queue.js');

const entry = (id, pausedAt, ready = false, pauseTtlMin = 60) =>
  ({ job: { id, description: 'd', buyerVerusId: 'b' }, agentId: 'agent-5', pausedAt, pauseTtlMin, readyToRespawn: ready });

test('enqueue adds once; has reflects membership; no duplicate by job.id', () => {
  let q = [];
  q = rq.enqueue(q, entry('j1', 1000));
  q = rq.enqueue(q, entry('j1', 2000)); // duplicate id — ignored
  assert.strictEqual(q.length, 1);
  assert.ok(rq.has(q, 'j1'));
  assert.ok(!rq.has(q, 'jX'));
});

test('markReady flips the flag and returns found', () => {
  let q = rq.enqueue([], entry('j1', 1000));
  assert.strictEqual(rq.markReady(q, 'j1'), true);
  assert.strictEqual(q[0].readyToRespawn, true);
  assert.strictEqual(rq.markReady(q, 'nope'), false);
});

test('nextReady returns the oldest ready entry, null if none ready', () => {
  let q = [];
  q = rq.enqueue(q, entry('old', 1000, true));
  q = rq.enqueue(q, entry('new', 5000, true));
  q = rq.enqueue(q, entry('notready', 500, false));
  assert.strictEqual(rq.nextReady(q).job.id, 'old');
  const q2 = [entry('a', 1, false)];
  assert.strictEqual(rq.nextReady(q2), null);
});

test('removeJob drops the entry', () => {
  let q = rq.enqueue([], entry('j1', 1000));
  q = rq.removeJob(q, 'j1');
  assert.strictEqual(q.length, 0);
});

test('findExpired returns entries past pauseTtlMin from pausedAt', () => {
  const now = 100 * 60000; // 100 min in ms
  let q = [];
  q = rq.enqueue(q, entry('fresh', 90 * 60000, false, 60));   // aged 10 min < 60 → not expired
  q = rq.enqueue(q, entry('stale', 30 * 60000, false, 60));   // aged 70 min >= 60 → expired
  const exp = rq.findExpired(q, now);
  assert.deepStrictEqual(exp.map(e => e.job.id), ['stale']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reactivation-queue.test.js`
Expected: FAIL — `Cannot find module '../src/reactivation-queue.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/reactivation-queue.js
'use strict';
// Pure operations over an array of reactivation entries. No I/O, no docker.
// Persistence is handled by config.js; scheduling/respawn by cli.js.

function has(q, jobId) { return q.some(e => e.job.id === jobId); }

function enqueue(q, entry) {
  if (has(q, entry.job.id)) return q;
  q.push(entry);
  return q;
}

function markReady(q, jobId) {
  const e = q.find(x => x.job.id === jobId);
  if (!e) return false;
  e.readyToRespawn = true;
  return true;
}

function nextReady(q) {
  const ready = q.filter(e => e.readyToRespawn);
  if (ready.length === 0) return null;
  return ready.reduce((a, b) => (b.pausedAt < a.pausedAt ? b : a));
}

function removeJob(q, jobId) {
  const i = q.findIndex(e => e.job.id === jobId);
  if (i >= 0) q.splice(i, 1);
  return q;
}

function findExpired(q, nowMs) {
  return q.filter(e => nowMs - e.pausedAt >= e.pauseTtlMin * 60000);
}

module.exports = { has, enqueue, markReady, nextReady, removeJob, findExpired };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/reactivation-queue.test.js`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/reactivation-queue.js test/reactivation-queue.test.js
git commit -m "feat(queue): pure reactivation-queue operations"
```

---

### Task 4: Persistence helpers in config.js

**Files:**
- Modify: `src/config.js` (add path + two functions, export them; mirror `persistActiveJobs`/`loadActiveJobs` at `config.js:43-82`)
- Test: `test/reactivation-persist.test.js`

**Interfaces:**
- Consumes: entry shape from Task 3.
- Produces: `persistReactivationQueue(arr)`; `loadReactivationQueue() → arr` (returns `[]` when the file is absent or corrupt).

- [ ] **Step 1: Write the failing test**

```javascript
// test/reactivation-persist.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect HOME so we write to a temp dispatcher dir, then load config fresh.
test('persist then load round-trips the queue; missing file → []', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  delete require.cache[require.resolve('../src/config.js')];
  const cfg = require('../src/config.js');
  try {
    assert.deepStrictEqual(cfg.loadReactivationQueue(), []); // no file yet
    const q = [{ job: { id: 'j1', description: 'd', buyerVerusId: 'b' }, agentId: 'agent-5', pausedAt: 1000, pauseTtlMin: 60, readyToRespawn: false }];
    cfg.persistReactivationQueue(q);
    assert.deepStrictEqual(cfg.loadReactivationQueue(), q);
  } finally {
    process.env.HOME = origHome;
    delete require.cache[require.resolve('../src/config.js')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reactivation-persist.test.js`
Expected: FAIL — `cfg.loadReactivationQueue is not a function`

- [ ] **Step 3: Implement — mirror the active-jobs helpers**

In `src/config.js`, after `ACTIVE_JOBS_PATH` (line 11) add:

```javascript
const REACTIVATION_QUEUE_PATH = path.join(DISPATCHER_DIR, 'reactivation-queue.json');
```

After `loadActiveJobs` (before `module.exports`) add:

```javascript
function persistReactivationQueue(arr) {
  try {
    fs.mkdirSync(DISPATCHER_DIR, { recursive: true });
    const tmp = REACTIVATION_QUEUE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr || [], null, 2));
    fs.renameSync(tmp, REACTIVATION_QUEUE_PATH); // atomic replace
  } catch (e) {
    console.error(`[config] Failed to persist reactivation queue: ${e.message}`);
  }
}

function loadReactivationQueue() {
  try {
    if (!fs.existsSync(REACTIVATION_QUEUE_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(REACTIVATION_QUEUE_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error(`[config] Failed to load reactivation queue (starting empty): ${e.message}`);
    return [];
  }
}
```

Add both to `module.exports` (alongside `persistActiveJobs, loadActiveJobs`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/reactivation-persist.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/reactivation-persist.test.js
git commit -m "feat(config): persist/load reactivation queue (atomic)"
```

---

### Task 5: Pause → free container + enqueue

**Files:**
- Modify: `src/cli.js` — state init (`~3100`), the two pause detectors (`5347` webhook `job.paused`, `6381` worker `job_idle` IPC), and add a `moveJobToReactivationQueue` function. Export it for testing.
- Test: `test/reactivation-pause.test.js`

**Interfaces:**
- Consumes: `rq.enqueue`, `persistReactivationQueue`, entry shape.
- Produces: `moveJobToReactivationQueue(state, jobId, { persist = true } = {}) → Promise<boolean>` — stops+removes the container, deletes from `state.active`, pushes an entry to `state.reactivationQueue`, persists. Returns false if the job isn't active.

- [ ] **Step 1: Write the failing test (stubbed container + state)**

```javascript
// test/reactivation-pause.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { moveJobToReactivationQueue } = require('../src/cli.js');

function fakeState() {
  return {
    active: new Map(),
    reactivationQueue: [],
    available: [],
  };
}
function fakeContainer() {
  const calls = [];
  return { calls, stop: async () => calls.push('stop'), remove: async () => calls.push('remove') };
}

test('pause stops+removes the container, frees the slot, enqueues', async () => {
  const state = fakeState();
  const container = fakeContainer();
  state.active.set('j1', { agentId: 'agent-5', container, startedAt: 1, pauseTtlMin: 60 });

  const ok = await moveJobToReactivationQueue(state, 'j1', { persist: false });

  assert.strictEqual(ok, true);
  assert.deepStrictEqual(container.calls, ['stop', 'remove']);
  assert.strictEqual(state.active.has('j1'), false);       // slot freed
  assert.strictEqual(state.reactivationQueue.length, 1);
  assert.strictEqual(state.reactivationQueue[0].job.id, 'j1');
  assert.strictEqual(state.reactivationQueue[0].readyToRespawn, false);
});

test('pause on an unknown job is a no-op returning false', async () => {
  const state = fakeState();
  assert.strictEqual(await moveJobToReactivationQueue(state, 'ghost', { persist: false }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reactivation-pause.test.js`
Expected: FAIL — `moveJobToReactivationQueue is not a function` (or cli.js does not export it yet)

- [ ] **Step 3: Implement the function + wire the two pause sites**

Add `reactivationQueue: []` to the `state` object literal (`cli.js:~3100`, alongside `active: new Map()`).

Add near the other job-lifecycle helpers (e.g. after `sendToJobAgent`, `cli.js:~4365`):

```javascript
const rq = require('./reactivation-queue.js');
const { persistReactivationQueue, loadReactivationQueue } = require('./config.js'); // add to existing config require

// Free a paused job's container and move it to the reactivation queue. The
// container is torn down (0 CPU/RAM/slot); the job waits in the queue until the
// buyer resumes (respawn) or pause_ttl expires (refund). Reuses the job's
// stored info from state.active.
async function moveJobToReactivationQueue(state, jobId, { persist = true } = {}) {
  const info = state.active.get(jobId);
  if (!info) return false;
  try {
    if (info.container) {
      await info.container.stop().catch(() => {});
      await info.container.remove().catch(() => {});
    }
  } catch { /* best-effort teardown; state is platform-side */ }
  state.active.delete(jobId);
  rq.enqueue(state.reactivationQueue, {
    job: info.job || { id: jobId },
    agentId: info.agentId,
    pausedAt: Date.now(),
    pauseTtlMin: info.pauseTtlMin || 60,
    readyToRespawn: false,
  });
  if (persist) {
    persistReactivationQueue(state.reactivationQueue);
    persistActiveJobs(state.active);
  }
  console.log(`[Reactivation] Job ${jobId.substring(0, 8)} paused → container freed, queued (active=${state.active.size}/${MAX_AGENTS}, queued=${state.reactivationQueue.length})`);
  return true;
}
```

Ensure `module.exports` at the bottom of `cli.js` includes `moveJobToReactivationQueue` (follow the existing export style — cli.js already exports helpers for `cli-*.test.js`).

At the webhook pause site (`cli.js:5347-5348`), replace:
```javascript
        pauseInfo.paused = true;
        pauseInfo.pausedAt = Date.now();
```
with:
```javascript
        await moveJobToReactivationQueue(state, jobId);
```
(Confirm the enclosing function is `async`; the webhook handler is. `pauseInfo` was `state.active.get(jobId)` — the new call re-fetches by id.)

At the worker-IPC pause site (`cli.js:6381-6386`), replace the `info.paused = true; info.pausedAt = Date.now();` block with:
```javascript
      if (msg?.type === 'job_idle') {
        await moveJobToReactivationQueue(state, msg.jobId);
      }
```
(If the enclosing callback is not `async`, wrap: `moveJobToReactivationQueue(state, msg.jobId).catch(e => console.error('[Reactivation] pause failed:', e.message));`.)

**Store `job` + `pauseTtlMin` on the active entry so the queue entry is complete.** At the point active entries are created in `startJobContainer`/`startJob` (`state.active.set(job.id, { agentId, container, startedAt, retries })`), add `job` and `pauseTtlMin: (job.pauseTtlMin || service.pauseTtl || 60)` to that object. Grep `state.active.set(` to find every creation site and add both fields consistently.

- [ ] **Step 4: Run test + full suite**

Run: `node --check src/cli.js && node --test test/reactivation-pause.test.js && node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: pause test PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/reactivation-pause.test.js
git commit -m "feat(cli): free container + enqueue on pause"
```

---

### Task 6: Resume → mark ready + priority respawn in the scheduler

**Files:**
- Modify: `src/cli.js` — the two resume detectors (poll `4952/4958`, webhook `5337`), and the scheduler drain loop (`5054`). Add a `respawnReadyResumes(state)` step and export it.
- Test: `test/reactivation-schedule.test.js`

**Interfaces:**
- Consumes: `rq.nextReady`, `rq.markReady`, `rq.removeJob`, `startJob`, entry shape.
- Produces: `respawnReadyResumes(state, deps) → Promise<number>` — while `state.active.size < MAX_AGENTS`, respawns the oldest ready entry via `deps.startJob`, returns count respawned. `deps` = `{ startJob, findAgentById }` (injected for testability; cli.js passes its real functions).

- [ ] **Step 1: Write the failing test (inject a fake startJob)**

```javascript
// test/reactivation-schedule.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { respawnReadyResumes } = require('../src/cli.js');

test('respawns ready resumes oldest-first, respects capacity, dequeues on success', async () => {
  const started = [];
  const state = {
    active: new Map([['busy', {}]]),   // 1 slot used
    reactivationQueue: [
      { job: { id: 'r2' }, agentId: 'a', pausedAt: 2000, pauseTtlMin: 60, readyToRespawn: true },
      { job: { id: 'r1' }, agentId: 'a', pausedAt: 1000, pauseTtlMin: 60, readyToRespawn: true },
      { job: { id: 'notready' }, agentId: 'a', pausedAt: 500, pauseTtlMin: 60, readyToRespawn: false },
    ],
  };
  const deps = {
    startJob: async (st, job) => { started.push(job.id); st.active.set(job.id, {}); },
    findAgentById: () => ({ id: 'a' }),
    maxAgents: 3, // 3 slots total, 1 used → room for 2
  };

  const n = await respawnReadyResumes(state, deps);

  assert.strictEqual(n, 2);
  assert.deepStrictEqual(started, ['r1', 'r2']);              // oldest-first
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'r1')); // dequeued
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'r2'));
  assert.ok(state.reactivationQueue.find(e => e.job.id === 'notready')); // untouched
});

test('does nothing when at capacity', async () => {
  const state = {
    active: new Map([['a', {}], ['b', {}]]),
    reactivationQueue: [{ job: { id: 'r1' }, agentId: 'a', pausedAt: 1, pauseTtlMin: 60, readyToRespawn: true }],
  };
  const n = await respawnReadyResumes(state, { startJob: async () => { throw new Error('should not start'); }, findAgentById: () => ({}), maxAgents: 2 });
  assert.strictEqual(n, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reactivation-schedule.test.js`
Expected: FAIL — `respawnReadyResumes is not a function`

- [ ] **Step 3: Implement respawnReadyResumes + wire resume sites + scheduler**

Add (near `moveJobToReactivationQueue`):

```javascript
// Respawn buyer-resumed jobs from the reactivation queue, oldest-first, until
// capacity is reached. deps.maxAgents defaults to the module MAX_AGENTS; injected
// in tests. Reuses the normal startJob spawn path — the fresh worker reloads all
// state from the platform (stateless respawn).
async function respawnReadyResumes(state, deps = {}) {
  const startJobFn = deps.startJob || startJob;
  const findAgent = deps.findAgentById || ((id) => state.available.find(a => a.id === id) || { id });
  const cap = deps.maxAgents != null ? deps.maxAgents : MAX_AGENTS;
  let count = 0;
  while (state.active.size < cap) {
    const entry = rq.nextReady(state.reactivationQueue);
    if (!entry) break;
    rq.removeJob(state.reactivationQueue, entry.job.id);
    try {
      await startJobFn(state, entry.job, findAgent(entry.agentId));
      count++;
    } catch (e) {
      console.error(`[Reactivation] Respawn failed for ${entry.job.id.substring(0, 8)}: ${e.message} — re-queuing`);
      rq.enqueue(state.reactivationQueue, entry); // leave ready for the next pass
      break; // avoid a tight failure loop
    }
  }
  if (count > 0) persistReactivationQueue(state.reactivationQueue);
  return count;
}
```

Export `respawnReadyResumes` from `cli.js`.

At **both** resume detectors — poll (`cli.js:4952-4959`, the `paused → in_progress` block) and webhook `job.resumed` (`cli.js:5329-5337`) — replace the `sendToJobAgent(..., { type: 'reconnect', jobId })` call (the container is gone) with:
```javascript
        if (rq.markReady(state.reactivationQueue, jobId)) {
          persistReactivationQueue(state.reactivationQueue);
          await respawnReadyResumes(state);
        }
```
Keep the existing `activeInfo`/`resumeInfo.paused = false` cleanup only where the job is still in `state.active` (legacy in-flight) — but since Task 5 removes paused jobs from `state.active`, the normal path is the queue. If `state.active.has(jobId)` (a job that never got queued), keep the old reconnect IPC as a fallback.

In the scheduler drain loop (`cli.js:5054`, `while (state.queue.length > 0 && state.active.size < MAX_AGENTS ...)`), call `await respawnReadyResumes(state);` **immediately before** the loop so resumes claim slots first, then new jobs fill the rest.

- [ ] **Step 4: Run test + suite**

Run: `node --check src/cli.js && node --test test/reactivation-schedule.test.js && node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: schedule test PASS; suite green.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/reactivation-schedule.test.js
git commit -m "feat(cli): resume marks ready + priority respawn in scheduler"
```

---

### Task 7: pause_ttl sweep of the queue + freemem safety valve + restart restore

**Files:**
- Modify: `src/cli.js` — extend the TTL loop (`4987`), add a freemem guard in the respawn/spawn path, load the queue at startup, exclude queued jobs from the crash-recovery refund sweep (`4561`).
- Test: `test/reactivation-ttl.test.js`

**Interfaces:**
- Consumes: `rq.findExpired`, `rq.removeJob`, `loadReactivationQueue`, `os.freemem`.
- Produces: `sweepExpiredQueue(state, deps) → Promise<string[]>` (refunded jobIds); `hasMemoryHeadroom(freeBytes, perContainerBytes, marginBytes?) → boolean`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/reactivation-ttl.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sweepExpiredQueue, hasMemoryHeadroom } = require('../src/cli.js');

test('sweep refunds + removes only expired queued jobs', async () => {
  const now = 100 * 60000;
  const refunded = [];
  const state = {
    reactivationQueue: [
      { job: { id: 'fresh' }, agentId: 'a', pausedAt: 90 * 60000, pauseTtlMin: 60, readyToRespawn: false },
      { job: { id: 'stale' }, agentId: 'a', pausedAt: 20 * 60000, pauseTtlMin: 60, readyToRespawn: false },
    ],
  };
  const deps = { now: () => now, refundJob: async (id) => refunded.push(id) };
  const out = await sweepExpiredQueue(state, deps);
  assert.deepStrictEqual(out, ['stale']);
  assert.deepStrictEqual(refunded, ['stale']);
  assert.ok(!state.reactivationQueue.find(e => e.job.id === 'stale'));
  assert.ok(state.reactivationQueue.find(e => e.job.id === 'fresh'));
});

test('hasMemoryHeadroom gates spawns when free RAM is tight', () => {
  const GB = 1024 * 1024 * 1024;
  assert.strictEqual(hasMemoryHeadroom(5 * GB, 2 * GB), true);   // 5 > 2 + 0.5 margin
  assert.strictEqual(hasMemoryHeadroom(2 * GB, 2 * GB), false);  // 2 < 2.5
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reactivation-ttl.test.js`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Add:

```javascript
const REACTIVATION_MEM_MARGIN_BYTES = 512 * 1024 * 1024; // 0.5GB host margin

function hasMemoryHeadroom(freeBytes, perContainerBytes, marginBytes = REACTIVATION_MEM_MARGIN_BYTES) {
  return freeBytes >= perContainerBytes + marginBytes;
}

// Refund + drop queued jobs whose pause_ttl has elapsed. deps.refundJob(jobId) is
// the existing cancel/refund path; deps.now() is injectable for tests.
async function sweepExpiredQueue(state, deps = {}) {
  const now = (deps.now || Date.now)();
  const refundJob = deps.refundJob || (async (id) => { /* wired to the real cancel/refund path */ });
  const expired = rq.findExpired(state.reactivationQueue, now);
  const done = [];
  for (const e of expired) {
    try { await refundJob(e.job.id); done.push(e.job.id); }
    catch (err) { console.error(`[Reactivation] TTL refund failed for ${e.job.id.substring(0,8)}: ${err.message}`); continue; }
    rq.removeJob(state.reactivationQueue, e.job.id);
  }
  if (done.length) persistReactivationQueue(state.reactivationQueue);
  return done;
}
```

Export both. Wire:
- In the TTL interval (`cli.js:4987` area — the loop that checks `info.paused`/`pausedAt` against `pause_ttl`), after the existing active-job TTL check add `await sweepExpiredQueue(state, { refundJob: (id) => <existing cancel+refund fn>(state, id) });`. Use the same refund/cancel function the active-job TTL path already calls (grep near 4991 `auto-delivering`/refund).
- In `respawnReadyResumes` (Task 6) and `startJobContainer`, before spawning add: `if (!hasMemoryHeadroom(os.freemem(), SIZING_DEFAULTS.perContainerMemBytes)) { console.warn('[Reactivation] Low free memory — deferring spawn'); break/return; }` (in the respawn loop, `break` to leave jobs queued; in the new-job path, re-queue).
- At startup (in the `start` command setup, where `loadActiveJobs()` is called), add `state.reactivationQueue = loadReactivationQueue();` and log `if (state.reactivationQueue.length) console.log(\`[Reactivation] Restored ${state.reactivationQueue.length} paused job(s) from disk\`);`.
- In the crash-recovery sweep (`cli.js:4561` `handleCrashRecovery`), **skip any jobId present in `state.reactivationQueue`** when deciding what to refund — queued jobs are intentionally paused, not orphaned. Add a guard: `if (rq.has(state.reactivationQueue, jobId)) continue;`.

- [ ] **Step 4: Run test + full suite + syntax**

Run: `node --check src/cli.js && node --test test/reactivation-ttl.test.js && node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: ttl test PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/reactivation-ttl.test.js
git commit -m "feat(cli): queue pause_ttl sweep, freemem valve, restart restore"
```

---

### Task 8: Stateless-respawn verification (the linchpin)

**Files:**
- Inspect/verify: `src/job-agent.js` reconnect path (`~392`, `~466`, `processJob` reconnect mode) — confirm a **from-cold** worker reloads full chat history/context (not just re-auth). Modify only if a gap is found.
- Test: extend an existing job-agent-oriented test or add `test/respawn-context-reload.test.js` for any helper touched.

**Interfaces:**
- Consumes: nothing new. This task confirms the spec's stateless-respawn requirement holds and closes any gap.

- [ ] **Step 1: Trace the reload path**

Read `job-agent.js` around the `'reconnect'` IPC handler (`~392`) and `processJob`'s reconnect branch (`job.status = fullJob.status`, `~466`). Determine: on a **fresh container boot** for an `in_progress` job, does the worker (a) re-auth, (b) `connectChat`, and (c) **re-fetch prior messages / conversation context** so the buyer continues seamlessly? A respawn is a cold boot, not an in-process `reconnect` — verify the cold path reloads history, not just the socket.

- [ ] **Step 2: Document findings in the task report**

If the cold-boot path already reloads context (e.g. the SDK `connectChat` replays history, or the worker fetches messages on start), record the evidence (file:line) and mark verified — no code change.

If there is a gap (cold worker starts an empty conversation), add the minimal reload: on boot for an already-`in_progress` job, fetch prior messages via the SDK (`agent.getMessages(jobId)` or equivalent — grep the SDK/client for the message-history call) and seed the executor/context before accepting new turns. Show the exact code in the report and implement it.

- [ ] **Step 3: Test the touched helper (only if code changed)**

If a reload helper was added, unit-test it with a stubbed client returning a fixed message list; assert the context is seeded. If no change, add a short assertion or skip with a documented rationale.

- [ ] **Step 4: Verify**

Run: `node --check src/job-agent.js && node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: syntax ok; suite green.

- [ ] **Step 5: Commit (only if changed)**

```bash
git add src/job-agent.js test/respawn-context-reload.test.js
git commit -m "fix(worker): reload conversation context on cold respawn"
```

---

## Self-Review

**1. Spec coverage:**
- Free container + enqueue on pause → Task 5 ✅
- Persisted reactivation queue → Task 4 (+ restore Task 7) ✅
- Resume marks ready + respawn → Task 6 ✅
- Resumed-first priority + capacity gate (MAX_AGENTS) → Task 6 (respawn before new-job drain; `active.size < cap`) ✅
- Full-box waits in queue → Task 6 (loop stops at capacity) ✅
- pause_ttl while queued → Task 7 (`sweepExpiredQueue`) ✅
- Conservative hardware auto-size + first-run line → Tasks 1-2 ✅
- freemem OOM safety valve → Task 7 ✅
- Restart restore, not refund → Task 7 (load + crash-recovery exclusion) ✅
- Stateless respawn reloads context → Task 8 ✅
- No new dependency; reuse startJob/persistence/detectors → all tasks (Node built-ins + dockerode) ✅

**2. Placeholder scan:** Tasks 5-7 contain a few "grep the exact site / use the existing refund fn" directives where the exact enclosing function name must be confirmed against live code (e.g. the active-job refund fn near `4991`, the `state.active.set` sites). These are unavoidable seams in a 6k-line file; each names the anchor line and the concrete change. Not TBD placeholders — the code to write is shown; only the insertion point is confirmed at implementation.

**3. Type consistency:** entry shape `{ job, agentId, pausedAt, pauseTtlMin, readyToRespawn }` is identical across Tasks 3-7. `respawnReadyResumes(state, deps)`, `moveJobToReactivationQueue(state, jobId, opts)`, `sweepExpiredQueue(state, deps)`, `hasMemoryHeadroom(free, per, margin)` signatures match between their definitions and tests. `computeMaxAgents`/`capacityLine` params match Task 1 ↔ Task 2.

**Ordering note for the executor:** Tasks 1→2→3→4 are cleanly independent-then-consumed; Tasks 5→6→7 build on each other in `cli.js` and must run in order; Task 8 is verification and can run last (or in parallel with 5-7 since it's read-mostly).
