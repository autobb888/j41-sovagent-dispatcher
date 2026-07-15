# Dispatcher Lifecycle Robustness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make reactivation pause/resume work in Docker+Poll mode, and make capability-load self-heal after a
boot-time (chain-sync) failure — both without manual restart, both working in poll AND webhook mode.

**Architecture:** Extract the pieces into unit-testable seams (pure decision helpers + reusable I/O loaders), wire the
new poll-loop detectors and the self-healing retry around the existing money-safe primitives
(`moveJobToReactivationQueue`, `respawnReadyResumes`).

**Tech Stack:** CJS, no build step. `node --check src/*.js`, `node --test test/*.js`. No new deps.

## Global Constraints
- No new runtime dependency; Node built-ins + existing helpers only.
- Money-safe: reuse `moveJobToReactivationQueue` (enqueue-before-teardown, `_pausing` guard) and
  `respawnReadyResumes` (capacity-gated, `state.active.has` guard). No double-refund, no double-spawn.
- Fail-safe: a capability-load failure must NEVER crash the dispatcher; agents stay able to take basic jobs.
- Works in BOTH modes: poll (new fallback) and webhook (unchanged instant path). No behavior change when webhooks are
  active and the chain is synced at boot.
- Behavior-preserving extraction: the boot capability-load must log and store exactly as before.
- `cli.js` test exports live behind `if (process.env.NODE_ENV === 'test')` at the bottom (~line 7520). Add new
  testable symbols there.

---

### Task 1: Extract capability + dispute-policy loaders into reusable functions

**Files:**
- Modify: `src/cli.js` — extract the boot-load `for` bodies (~3233-3322 capability; ~3353-3372 dispute policy) into
  `async function loadAgentCapabilities(state, agentInfo)` and `async function loadAgentDisputePolicy(state, agentInfo)`.
- Modify: `src/cli.js` test-exports block (~7520) — add both functions.
- Test: `test/capability-loader.test.js` (new).

**Interfaces:**
- Produces:
  - `async loadAgentCapabilities(state, agentInfo): Promise<boolean>` — runs the existing per-agent capability fetch
    (VDXF decode → `workspace/services/profile`), stores into `state.capabilities.set(agentInfo.id, {...})`. On success
    the stored object has NO `_fetchFailed`. On throw, stores `{ workspace:false, services:[], profile:null,
    _fetchFailed:true }` and returns `false`. Returns `true` on success.
  - `async loadAgentDisputePolicy(state, agentInfo): Promise<void>` — the existing dispute-policy/markup load
    (`getMyIdentity` → `decodeContentMultimap` → `state.disputePolicy`/`state.agentMarkup`). Never throws (logs on error).
  - Both resolve the session via the existing `getAgentSession(state, agentInfo)`.

- [ ] **Step 1: Write the failing test**

`test/capability-loader.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.NODE_ENV = 'test';
const { loadAgentCapabilities } = require('../src/cli.js');

// Minimal state + agentInfo; stub getAgentSession via state._testSession hook (see Task 1 note).
function mkState(session) {
  return {
    capabilities: new Map(),
    disputePolicy: new Map(),
    agentMarkup: new Map(),
    agentSessions: new Map(),
    _testAgentSession: session, // test seam consumed by getAgentSession when NODE_ENV==='test'
  };
}

test('loadAgentCapabilities stores capabilities and leaves no _fetchFailed on success', async () => {
  const session = {
    client: {
      getAgentServices: async () => ({ data: [] }),
      getMyIdentity: async () => ({ contentmultimap: {} }),
    },
  };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-x', iAddress: 'iX', identity: 'x@' });
  assert.strictEqual(ok, true);
  const cap = state.capabilities.get('agent-x');
  assert.ok(cap, 'capabilities stored');
  assert.notStrictEqual(cap._fetchFailed, true, 'no _fetchFailed on success');
});

test('loadAgentCapabilities marks _fetchFailed on fetch error and returns false', async () => {
  const session = { client: {
    getAgentServices: async () => { throw new Error('Sign-in temporarily unavailable while the chain catches up'); },
    getMyIdentity: async () => ({ contentmultimap: {} }),
  } };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-y', iAddress: 'iY', identity: 'y@' });
  assert.strictEqual(ok, false);
  assert.strictEqual(state.capabilities.get('agent-y')._fetchFailed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test node --test test/capability-loader.test.js`
Expected: FAIL — `loadAgentCapabilities` not exported / not a function.

- [ ] **Step 3: Add a test seam to `getAgentSession`**

In `getAgentSession(state, agentInfo)`, at the very top add:
```js
if (process.env.NODE_ENV === 'test' && state._testAgentSession) return state._testAgentSession;
```
This lets tests inject a fake session without real auth. (One line; no production effect.)

- [ ] **Step 4: Extract the two loaders (behavior-preserving)**

Move the body of the boot capability `for` loop (currently ~`src/cli.js:3236-3321`, the `try { ... } catch (e) { ...
_fetchFailed ... }`) verbatim into `async function loadAgentCapabilities(state, agentInfo) { ... return true/false }`.
Keep every log line and the `state.capabilities.set(...)` calls identical. Return `true` at the end of the success
path, `false` in the catch. Move the `decodeContentMultimap` require to module scope or inside the fn.

Move the dispute-policy `for` body (~`3354-3371`) into `async function loadAgentDisputePolicy(state, agentInfo)`.

Rewrite the two boot loops to call them:
```js
for (let i = 0; i < readyAgents.length; i++) {
  if (i > 0) await new Promise(r => setTimeout(r, 2000));
  await loadAgentCapabilities(state, readyAgents[i]);
}
// ... (retry block stays for now — replaced in Task 2) ...
for (const agentInfo of readyAgents) await loadAgentDisputePolicy(state, agentInfo);
```

- [ ] **Step 5: Export for test** — add `loadAgentCapabilities, loadAgentDisputePolicy` to the `module.exports` under
  the `NODE_ENV === 'test'` block (~7520).

- [ ] **Step 6: Run tests + syntax**

Run: `node --check src/cli.js && NODE_ENV=test node --test test/capability-loader.test.js`
Expected: PASS (2/2). Then `node --test test/*.js` — full suite still green.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "refactor(capabilities): extract loadAgentCapabilities + loadAgentDisputePolicy"`

---

### Task 2: Self-healing capability retry (replace the api-endpoint-only no-op)

**Files:**
- Modify: `src/cli.js` — replace the retry block (~3325-3350).
- Add: `src/capability-retry.js` (new, pure helper) + export.
- Test: `test/capability-retry.test.js` (new).

**Interfaces:**
- Consumes: `loadAgentCapabilities`, `loadAgentDisputePolicy` (Task 1).
- Produces: `stillFailed(state, agents): agentInfo[]` — the subset whose `state.capabilities.get(id)?._fetchFailed`
  is true. Pure.

- [ ] **Step 1: Write the failing test**

`test/capability-retry.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stillFailed } = require('../src/capability-retry.js');

test('stillFailed returns only agents whose capabilities are marked _fetchFailed', () => {
  const state = { capabilities: new Map([
    ['a', { _fetchFailed: true }],
    ['b', { services: [] }],        // healed
    ['c', { _fetchFailed: true }],
  ]) };
  const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(stillFailed(state, agents).map(x => x.id), ['a', 'c']);
});

test('stillFailed is empty when all healed → caller can stop the timer', () => {
  const state = { capabilities: new Map([['a', { services: [] }]]) };
  assert.strictEqual(stillFailed(state, [{ id: 'a' }]).length, 0);
});
```

- [ ] **Step 2: Run → fail** (`node --test test/capability-retry.test.js` — module missing).

- [ ] **Step 3: Implement `src/capability-retry.js`**
```js
'use strict';
// Pure selector: which agents still need a capability retry. Caller stops the
// retry timer when this returns empty.
function stillFailed(state, agents) {
  return agents.filter(a => state.capabilities.get(a.id)?._fetchFailed === true);
}
module.exports = { stillFailed };
```

- [ ] **Step 4: Rewrite the retry block in `cli.js`** (replace ~3325-3350):
```js
const { stillFailed } = require('./capability-retry.js');
let failedAgents = stillFailed(state, readyAgents);
if (failedAgents.length > 0) {
  console.log(`  ⚠  ${failedAgents.length} agent(s) failed capability fetch — self-healing retry every 60s`);
  const retryTimer = setInterval(async () => {
    const pending = stillFailed(state, readyAgents);
    if (pending.length === 0) { clearInterval(retryTimer); return; }
    console.log(`[Capabilities] Retrying ${pending.length} agent(s)...`);
    for (const agentInfo of pending) {
      const ok = await loadAgentCapabilities(state, agentInfo);   // re-runs full load, clears _fetchFailed on success
      if (ok) {
        await loadAgentDisputePolicy(state, agentInfo);
        console.log(`[Capabilities] ✓ ${agentInfo.id} healed`);
      }
    }
    if (stillFailed(state, readyAgents).length === 0) {
      console.log('[Capabilities] ✅ all agents healed');
      clearInterval(retryTimer);
    }
  }, 60 * 1000);
  retryTimer.unref();
}
```
(Preserve the api-endpoint "restart to activate proxy" notice **only** if the proxy is not already running: after a
heal, if the agent now exposes an api-endpoint and `!state.proxyHandler`/equivalent, log the existing notice. Keep it
minimal — capabilities reload regardless.)

- [ ] **Step 5: Run tests + syntax** — `node --check src/cli.js src/capability-retry.js && node --test test/*.js` → green.

- [ ] **Step 6: Commit** — `feat(capabilities): self-healing retry — reload full capabilities, stop when healed`

---

### Task 3: Poll-mode pause detection (free the container on pause)

**Files:**
- Add: `src/reactivation-poll.js` (new, pure predicates) + export.
- Modify: `src/cli.js` — in the active-jobs poll loop, next to the resume branch (~5141).
- Test: `test/reactivation-poll.test.js` (new).

**Interfaces:**
- Produces: `shouldPauseOnPoll(currentJob, activeInfo): boolean` — true iff `currentJob.status === 'paused'` and
  `activeInfo` exists and `!activeInfo.paused` and `!activeInfo._pausing`.

- [ ] **Step 1: Write the failing test**

`test/reactivation-poll.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldPauseOnPoll } = require('../src/reactivation-poll.js');

test('pauses a live, un-paused active job when platform status is paused', () => {
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, { paused: false }), true);
});
test('does NOT re-pause an already-paused or mid-teardown job', () => {
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, { paused: true }), false);
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, { paused: false, _pausing: true }), false);
});
test('ignores non-paused statuses and missing activeInfo', () => {
  assert.strictEqual(shouldPauseOnPoll({ status: 'in_progress' }, { paused: false }), false);
  assert.strictEqual(shouldPauseOnPoll({ status: 'paused' }, null), false);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `src/reactivation-poll.js`** (start the file; Task 4 adds to it):
```js
'use strict';
function shouldPauseOnPoll(currentJob, activeInfo) {
  return !!activeInfo && currentJob?.status === 'paused' && !activeInfo.paused && !activeInfo._pausing;
}
module.exports = { shouldPauseOnPoll };
```

- [ ] **Step 4: Wire into the poll loop** — in `cli.js`, immediately AFTER the resume branch (`if (currentJob.status
  === 'in_progress' && activeInfo.paused) { ... }` at ~5141), add:
```js
// Poll-mode fallback: detect in_progress → paused (pause happened without a
// webhook / without a working job_idle IPC in Docker). Free the container.
const { shouldPauseOnPoll } = require('./reactivation-poll.js');
if (shouldPauseOnPoll(currentJob, activeInfo)) {
  console.log(`[Poll] Job ${jobId.substring(0, 8)} paused (platform) — freeing container`);
  await moveJobToReactivationQueue(state, jobId);
  state._lastSentStatus.set(jobId, currentJob.status);
}
```
(Require at top of file is fine too; inline require matches the resume branch's style.)

- [ ] **Step 5: Run tests + syntax** → green (`node --test test/*.js`).

- [ ] **Step 6: Commit** — `fix(reactivation): poll-mode pause detection frees the container (Docker+Poll)`

---

### Task 4: Poll-mode queued-resume (batched, scale-safe)

**Files:**
- Modify: `src/reactivation-poll.js` — add `pickResumeBatch`.
- Modify: `src/cli.js` — add a queued-resume sweep in the poll cycle (after the active-jobs loop) + a
  `state._resumeCursor` field on the state object where it's created (~3142).
- Test: `test/reactivation-poll.test.js` (extend).

**Interfaces:**
- Consumes: `rq.markReady`, `respawnReadyResumes`, `getAgentSession`.
- Produces: `pickResumeBatch(queue, cursor, batchSize): { batch, nextCursor }` — round-robin slice of `queue`
  (array of entries with `.job.id`), starting at `cursor`, length `min(batchSize, queue.length)`; `nextCursor` wraps.

- [ ] **Step 1: Write the failing test** (append to `test/reactivation-poll.test.js`):
```js
const { pickResumeBatch } = require('../src/reactivation-poll.js');
test('pickResumeBatch round-robins across cycles and wraps', () => {
  const q = [{job:{id:'a'}},{job:{id:'b'}},{job:{id:'c'}}];
  let r = pickResumeBatch(q, 0, 2);
  assert.deepStrictEqual(r.batch.map(e=>e.job.id), ['a','b']);
  assert.strictEqual(r.nextCursor, 2);
  r = pickResumeBatch(q, r.nextCursor, 2);           // wraps: c, a
  assert.deepStrictEqual(r.batch.map(e=>e.job.id), ['c','a']);
  assert.strictEqual(r.nextCursor, 1);
});
test('pickResumeBatch handles empty queue', () => {
  assert.deepStrictEqual(pickResumeBatch([], 0, 10), { batch: [], nextCursor: 0 });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `pickResumeBatch`** in `src/reactivation-poll.js`:
```js
function pickResumeBatch(queue, cursor, batchSize) {
  if (!queue || queue.length === 0) return { batch: [], nextCursor: 0 };
  const n = Math.min(batchSize, queue.length);
  const batch = [];
  let i = cursor % queue.length;
  for (let k = 0; k < n; k++) { batch.push(queue[i]); i = (i + 1) % queue.length; }
  return { batch, nextCursor: i };
}
module.exports = { shouldPauseOnPoll, pickResumeBatch };
```

- [ ] **Step 4: Add `state._resumeCursor = 0;`** where `state` is built (~3142, alongside `_inboxFailures`).

- [ ] **Step 5: Wire the sweep** — after the active-jobs poll loop finishes (a sensible spot: right after the loop at
  ~5158, before the extension-poll loop), add:
```js
// Poll-mode fallback: resume queued (container-freed) jobs whose platform status
// returned to in_progress — the webhook (job.resumed) path may be absent in poll
// mode. Batched round-robin so 100 queued jobs don't hammer the platform.
const RESUME_POLL_BATCH = 10;
if (state.reactivationQueue.length > 0 && state.active.size < MAX_AGENTS) {
  const { pickResumeBatch } = require('./reactivation-poll.js');
  const { batch, nextCursor } = pickResumeBatch(state.reactivationQueue, state._resumeCursor || 0, RESUME_POLL_BATCH);
  state._resumeCursor = nextCursor;
  for (const entry of batch) {
    const jobId = entry.job.id;
    if (entry.readyToRespawn) continue; // already flagged
    try {
      const agentInfo = state.agents.find(a => a.id === entry.agentId);
      if (!agentInfo) continue;
      const session = await getAgentSession(state, agentInfo);
      const full = await session.client.getJob(jobId);
      if (full?.status === 'in_progress') {
        console.log(`[Poll] Queued job ${jobId.substring(0, 8)} resumed (platform) — respawning`);
        if (rq.markReady(state.reactivationQueue, jobId)) {
          persistReactivationQueue(state.reactivationQueue);
          await respawnReadyResumes(state);
        }
      }
    } catch { /* transient — retried next sweep */ }
  }
}
```

- [ ] **Step 6: Run tests + syntax** — `node --check src/*.js && node --test test/*.js` → green.

- [ ] **Step 7: Commit** — `fix(reactivation): poll-mode queued-resume (batched) respawns freed jobs`

---

## Post-build
After all four tasks: whole-branch review, then **live E2E re-run** (boot during/after chain-sync → capabilities
self-heal, no restart → hire → 10-min idle → container frees → resume → respawn + history reload), then rebuild image
+ relaunch.
