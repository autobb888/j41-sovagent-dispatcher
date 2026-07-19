# Worker-Attach ACK (Item C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `in_progress` mean a worker attached — the container self-reports `worker-attached` on chat-connect success and `worker-attach-failed` on connect failure; the host reports the never-spawned case.

**Architecture:** The job-agent container already holds an authenticated SDK client, so it POSTs the attach signal itself (Docker has no clean container→host channel). Two new SDK client methods; a small gated+fail-open helper in the worker wired around `connectChat()`; a small gated+fail-open helper in the host wired into the two spawn-failure catches. No watchdog.

**Tech Stack:** SDK = TypeScript→CJS (`yarn build`, `npx tsx --test`). Dispatcher = CommonJS, no build (`node --check`, `node --test`).

**Spec:** `docs/superpowers/specs/2026-07-19-worker-attach-ack-design.md`.

## Global Constraints

- **Fail-open, always.** Every attach call is wrapped (try/catch), **log-only**, and must NEVER block, materially delay, or kill a job. Attach is advisory telemetry.
- **Gate on non-reconnect.** Fire attach calls ONLY when status is NOT `delivered` and NOT `disputed` (a Flow-B dispute/delivered respawn would hit the backend's 409 `STATE_CONFLICT`). Worker uses `_isPostDeliveryReconnect` (`job-agent.js:371`); host checks `job.status`.
- **No signature** — plain authenticated POST via the existing per-agent session.
- Backend endpoints are **LIVE** as documented: `POST /v1/jobs/:id/worker-attached` (no body, idempotent while status in accepted/in_progress) and `POST /v1/jobs/:id/worker-attach-failed` (body `{reason}`).
- SDK tests import `dist/` → `yarn build` before `npx tsx --test`. Dispatcher: `node --check` + `node --test`.

---

## File Structure

- **SDK** `src/client/index.ts` — add `confirmWorkerAttached` + `reportWorkerAttachFailed` (Task 1).
- **Dispatcher** `src/job-agent.js` — add `selfReportAttach` + wire around `connectChat()` + test export (Task 2).
- **Dispatcher** `src/cli.js` — add `reportSpawnAttachFailed` + wire into `startJobContainer`/`startJobLocal` catches + test export (Task 3).
- Tests: `sdk/test/worker-attach.test.ts` (T1), `dispatcher/test/self-report-attach.test.js` (T2), `dispatcher/test/spawn-attach-failed.test.js` (T3).

---

## Task 1: SDK — `confirmWorkerAttached` + `reportWorkerAttachFailed`

**Files:**
- Modify: `j41-sovagent-sdk/src/client/index.ts` (add two methods after `deliverJob`, ~line 525)
- Test: `j41-sovagent-sdk/test/worker-attach.test.ts`

**Interfaces:**
- Produces: `client.confirmWorkerAttached(jobId: string): Promise<Job>` → `POST /v1/jobs/:id/worker-attached` with empty body; `client.reportWorkerAttachFailed(jobId: string, reason: string): Promise<Job>` → `POST /v1/jobs/:id/worker-attach-failed` with `{ reason }`.

- [ ] **Step 1: Write the failing test** — `test/worker-attach.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { J41Client } = require('../dist/client/index.js');

function stubClient() {
  const c = new J41Client({ apiUrl: 'https://api.example.com' });
  const calls: any[] = [];
  (c as any).request = async (method: string, path: string, body: unknown) => {
    calls.push({ method, path, body });
    return { data: { id: 'job-1', status: 'in_progress' } };
  };
  return { c, calls };
}

describe('worker-attach client methods', () => {
  it('confirmWorkerAttached POSTs /worker-attached with empty body, returns data', async () => {
    const { c, calls } = stubClient();
    const r = await c.confirmWorkerAttached('job-1');
    assert.deepEqual(calls[0], { method: 'POST', path: '/v1/jobs/job-1/worker-attached', body: {} });
    assert.deepEqual(r, { id: 'job-1', status: 'in_progress' });
  });

  it('reportWorkerAttachFailed POSTs /worker-attach-failed with {reason}', async () => {
    const { c, calls } = stubClient();
    await c.reportWorkerAttachFailed('job-1', 'spawn-error: boom');
    assert.deepEqual(calls[0], { method: 'POST', path: '/v1/jobs/job-1/worker-attach-failed', body: { reason: 'spawn-error: boom' } });
  });

  it('encodes the jobId in the path', async () => {
    const { c, calls } = stubClient();
    await c.confirmWorkerAttached('a/b');
    assert.equal(calls[0].path, '/v1/jobs/a%2Fb/worker-attached');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-sdk && yarn build && npx tsx --test test/worker-attach.test.ts`
Expected: FAIL — `c.confirmWorkerAttached is not a function`.

- [ ] **Step 3: Implement** — in `src/client/index.ts`, immediately after the `deliverJob` method (~line 535), add:

```typescript
  /** Tell the platform a worker genuinely attached (connected) to this job. */
  async confirmWorkerAttached(jobId: string): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/worker-attached`, {});
    return res.data;
  }

  /** Tell the platform a worker failed to attach (never spawned / never connected). */
  async reportWorkerAttachFailed(jobId: string, reason: string): Promise<Job> {
    const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/worker-attach-failed`, { reason });
    return res.data;
  }
```

(If `Job` isn't already imported in this file's scope, use the type already used by `acceptJob`/`deliverJob` return signatures — match them exactly.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd j41-sovagent-sdk && npx tsc --noEmit && yarn build && npx tsx --test test/worker-attach.test.ts`
Expected: tsc clean; 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-sdk
git add src/client/index.ts test/worker-attach.test.ts
git commit -m "feat(sdk): confirmWorkerAttached + reportWorkerAttachFailed client methods"
```

---

## Task 2: Worker — `selfReportAttach` + wire around `connectChat()`

**Files:**
- Modify: `j41-sovagent-dispatcher/src/job-agent.js` (add helper near other module helpers; wire in the `connectChat()` try/catch ~line 378-395; add test export)
- Test: `j41-sovagent-dispatcher/test/self-report-attach.test.js`

**Interfaces:**
- Consumes: `agent.client.confirmWorkerAttached(jobId)`, `agent.client.reportWorkerAttachFailed(jobId, reason)` (Task 1).
- Produces: `async function selfReportAttach(agent, jobId, { isReconnect, failed, reason })` — exported under `NODE_ENV==='test'`. Returns undefined; never throws.

- [ ] **Step 1: Write the failing test** — `test/self-report-attach.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { selfReportAttach } = require('../src/job-agent.js');

function spyAgent(opts = {}) {
  const calls = { attached: [], failed: [] };
  return {
    calls,
    client: {
      confirmWorkerAttached: async (id) => { calls.attached.push(id); if (opts.throw) throw new Error('net'); },
      reportWorkerAttachFailed: async (id, reason) => { calls.failed.push({ id, reason }); if (opts.throw) throw new Error('net'); },
    },
  };
}

test('success path calls confirmWorkerAttached only', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: false });
  assert.deepEqual(a.calls.attached, ['j1']);
  assert.deepEqual(a.calls.failed, []);
});

test('failed path calls reportWorkerAttachFailed with the reason', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: false, failed: true, reason: 'chat-connect-failed: x' });
  assert.deepEqual(a.calls.failed, [{ id: 'j1', reason: 'chat-connect-failed: x' }]);
  assert.deepEqual(a.calls.attached, []);
});

test('isReconnect calls NEITHER (avoids backend 409 on disputed/delivered respawn)', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: true });
  await selfReportAttach(a, 'j1', { isReconnect: true, failed: true, reason: 'x' });
  assert.deepEqual(a.calls.attached, []);
  assert.deepEqual(a.calls.failed, []);
});

test('fail-open: a throwing client is swallowed (no throw)', async () => {
  const a = spyAgent({ throw: true });
  await selfReportAttach(a, 'j1', { isReconnect: false });                 // must not reject
  await selfReportAttach(a, 'j1', { isReconnect: false, failed: true });   // must not reject
  assert.ok(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-dispatcher && node --test test/self-report-attach.test.js`
Expected: FAIL — `selfReportAttach is not a function`.

- [ ] **Step 3a: Add the helper** — near the top module helpers of `src/job-agent.js` (e.g. beside `isPostDeliveryReconnect`):

```javascript
// Item C — worker self-reports attach to the platform. Gated on non-reconnect
// (a dispute/delivered respawn would hit the backend's 409 STATE_CONFLICT) and
// fail-open (advisory telemetry — never block or kill the job).
async function selfReportAttach(agent, jobId, { isReconnect, failed, reason } = {}) {
  if (isReconnect) return;
  try {
    if (failed) await agent.client.reportWorkerAttachFailed(jobId, reason || 'attach-failed');
    else await agent.client.confirmWorkerAttached(jobId);
  } catch (e) {
    console.error(`[ATTACH] ${failed ? 'attach-failed' : 'attached'} report failed (non-fatal): ${e.message}`);
  }
}
```

- [ ] **Step 3b: Export under test** — add `selfReportAttach` to the `NODE_ENV==='test'` export object in `job-agent.js` (the one exporting `isPostDeliveryReconnect`, `surfaceDispute`, etc.).

- [ ] **Step 3c: Wire into `connectChat()`** — in the `connectChat` try/catch (~378-395). After the success line `console.log('✅ Connected to SovGuard\n');` add:

```javascript
    await selfReportAttach(agent, job.id, { isReconnect: _isPostDeliveryReconnect });
```

And inside the `catch (chatErr) {` block, as the FIRST statement (before the existing reconnect-branch / deliver-failure / exit handling):

```javascript
    await selfReportAttach(agent, job.id, { isReconnect: _isPostDeliveryReconnect, failed: true, reason: 'chat-connect-failed: ' + chatErr.message });
```

(`_isPostDeliveryReconnect` is already in scope at this point — declared at ~line 371. `job.id` and `agent` are in scope.)

- [ ] **Step 4: Run + syntax check**

Run: `cd j41-sovagent-dispatcher && node --check src/job-agent.js && node --test test/self-report-attach.test.js`
Expected: clean; 4 tests PASS. Then full suite `node --test test/*.js` — baseline + 4 new, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-dispatcher
git add src/job-agent.js test/self-report-attach.test.js
git commit -m "feat(worker): self-report worker-attached/attach-failed around connectChat (gated, fail-open)"
```

---

## Task 3: Host — `reportSpawnAttachFailed` + wire into spawn-failure catches

**Files:**
- Modify: `j41-sovagent-dispatcher/src/cli.js` (add helper near `startJobContainer`; wire into the `startJobContainer` catch ~6997-7006 and `startJobLocal` catch ~7335-7338; add test export)
- Test: `j41-sovagent-dispatcher/test/spawn-attach-failed.test.js`

**Interfaces:**
- Consumes: `agent.client.reportWorkerAttachFailed(jobId, reason)` (Task 1); `getAgentSession(state, agentInfo)`.
- Produces: `async function reportSpawnAttachFailed(state, agentInfo, job, reason, deps)` — exported under `NODE_ENV==='test'`. Never throws.

- [ ] **Step 1: Write the failing test** — `test/spawn-attach-failed.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { reportSpawnAttachFailed } = require('../src/cli.js');

function deps(opts = {}) {
  const calls = [];
  return {
    calls,
    getAgentSession: async () => ({
      client: { reportWorkerAttachFailed: async (id, reason) => { calls.push({ id, reason }); if (opts.throw) throw new Error('net'); } },
    }),
  };
}

test('non-reconnect status reports attach-failed', async () => {
  const d = deps();
  await reportSpawnAttachFailed({}, { id: 'a1' }, { id: 'j1', status: 'accepted' }, 'spawn-error: boom', d);
  assert.deepEqual(d.calls, [{ id: 'j1', reason: 'spawn-error: boom' }]);
});

test('disputed/delivered status reports NOTHING (would 409)', async () => {
  for (const status of ['disputed', 'delivered']) {
    const d = deps();
    await reportSpawnAttachFailed({}, { id: 'a1' }, { id: 'j1', status }, 'spawn-error', d);
    assert.deepEqual(d.calls, [], `status ${status} must not report`);
  }
});

test('fail-open: a throwing session is swallowed', async () => {
  const d = deps({ throw: true });
  await reportSpawnAttachFailed({}, { id: 'a1' }, { id: 'j1', status: 'in_progress' }, 'spawn-error', d); // must not reject
  assert.ok(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd j41-sovagent-dispatcher && node --test test/spawn-attach-failed.test.js`
Expected: FAIL — `reportSpawnAttachFailed is not a function`.

- [ ] **Step 3a: Add the helper** — near `startJobContainer` in `src/cli.js`:

```javascript
// Item C — host reports the one attach failure the container can't: it never
// spawned. Gated on non-reconnect status (a dispute/delivered respawn would 409)
// and fail-open (advisory — never affect the failure-cleanup path).
async function reportSpawnAttachFailed(state, agentInfo, job, reason, deps = {}) {
  if (job.status === 'delivered' || job.status === 'disputed') return;
  const getSession = deps.getAgentSession || getAgentSession;
  try {
    const agent = await getSession(state, agentInfo);
    await agent.client.reportWorkerAttachFailed(job.id, reason);
  } catch (e) {
    console.error(`[ATTACH] host spawn-fail report failed (non-fatal): ${e.message}`);
  }
}
```

- [ ] **Step 3b: Export under test** — add `reportSpawnAttachFailed` to the `NODE_ENV==='test'` exports in `cli.js`.

- [ ] **Step 3c: Wire into both catches** — in the `startJobContainer` catch (~6997), as the first `await` inside the catch (before `state.available.push(agentInfo)` at ~7005):

```javascript
    await reportSpawnAttachFailed(state, agentInfo, job, 'spawn-error: ' + e.message);
```

And identically in the `startJobLocal` catch (~7335, before its `state.available.push(agentInfo)`):

```javascript
    await reportSpawnAttachFailed(state, agentInfo, job, 'spawn-error: ' + e.message);
```

(`state`, `agentInfo`, `job`, `e` are all in scope in both catch blocks.)

- [ ] **Step 4: Run + syntax check**

Run: `cd j41-sovagent-dispatcher && node --check src/cli.js && node --test test/spawn-attach-failed.test.js`
Expected: clean; 3 tests PASS. Then full suite `node --test test/*.js` — 0 fail.

- [ ] **Step 5: Commit**

```bash
cd j41-sovagent-dispatcher
git add src/cli.js test/spawn-attach-failed.test.js
git commit -m "feat(dispatcher): host reports worker-attach-failed on spawn failure (gated, fail-open)"
```

---

## Final verification (after all tasks)

- [ ] SDK: `cd j41-sovagent-sdk && npx tsc --noEmit && yarn build && npx tsx --test test/*.test.ts` — all green.
- [ ] Dispatcher: `cd j41-sovagent-dispatcher && node --check src/*.js src/executors/*.js && node --test test/*.js` — all green.
- [ ] Grep: `grep -n "confirmWorkerAttached\|reportWorkerAttachFailed" src/job-agent.js src/cli.js` shows the wiring at the connectChat success/catch and both spawn-failure catches.

## Rollout (endpoints already live)

1. SDK `yarn build`; rebuild the job-agent image; restart the dispatcher.
2. Live-test: fresh job → `workerAttachedAt` populates in the job payload; force a spawn/connect failure → `worker_attach_failed_at` stamps + buyer `job.reconnect` notice; confirm a Flow-B dispute respawn fires neither (no 409 in logs).
