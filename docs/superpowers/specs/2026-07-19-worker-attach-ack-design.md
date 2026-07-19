# Worker-Attach ACK (Item C) — Design

**Date:** 2026-07-19
**Repos:** `j41-sovagent-sdk` (TypeScript) + `j41-sovagent-dispatcher` (CommonJS)
**Branch:** `feature/worker-attach-ack` (off dispatcher `main` + SDK `main`, both post-A/B)
**Source:** 2026-07-17 work-request Item C + dispatcher backend report 2026-07-19 + backend response 2026-07-19.

## Goal

Make `in_progress` mean a worker actually attached. When the dispatcher spawns a worker, tell the platform when the worker genuinely connects (`worker-attached`) and when it fails to (`worker-attach-failed`), so a container that never boots or never connects no longer silently sits `in_progress` with no worker (the retro's #1 systemic issue; the `workerAttachedAt: null` artifact seen in Flow-B testing).

## The chosen shape: container self-reports

The job-agent **container already holds an authenticated SDK client** (it uses it for accept/deliver/getJob/chat). Docker containers have no clean IPC channel back to the host (the host only *follows the container log stream*), so instead of routing an attach signal host-ward, **the container self-reports directly**:

- Container's `connectChat()` **succeeds** → container calls `confirmWorkerAttached(jobId)`.
- Container's `connectChat()` **fails** (but the process is alive) → container calls `reportWorkerAttachFailed(jobId, reason)` before it exits.
- Container **never spawns** (host `startJobContainer`/`startJobLocal` catch) → the **host** calls `reportWorkerAttachFailed(jobId, reason)` (the only case the container can't report).

No host watchdog: the container reports its own connect success/failure; the host reports spawn-failure; a container that spawns and hangs forever without connecting or crashing (rare) reads correctly as `worker_attached_at = null` and is reaped by the existing job-timeout kill.

## Backend contract (LIVE — build to it as-is)

Both endpoints are deployed on `api.junction41.io` (migration 051: `jobs.worker_attached_at`, `jobs.worker_attach_failed_at`).

- **`POST /v1/jobs/:id/worker-attached`** — `requireAuth` + ownership (caller must be `job.seller_verus_id`, else 403). **No body parsed** (`attached_at` server-stamped `NOW()`). **Idempotent while status IN ('accepted','in_progress')**; other states → **409 `STATE_CONFLICT`**. No signature.
- **`POST /v1/jobs/:id/worker-attach-failed`** — same auth/ownership. Body `{ reason }` (backend adding a `worker_attach_failed_reason` column; until then the reason is harmlessly discarded). Stamps `worker_attach_failed_at`, notifies the buyer (`job.reconnect`), logs. **Does not** change status / reassign / refund.
- No `awaiting_worker` status — attach state is derived: `worker_attached_at IS NULL` = "assigned, no worker yet". Nothing gates on these yet (recorded + surfaced as `workerAttachedAt` in the job payload); business-logic consumption is a future product layer.

## Global constraints (bind every task)

- **Fail-open on the signal, always.** Every attach call is wrapped (try/catch or `.catch`), **log-only**, and must NEVER block, delay materially, or kill a working job. Attach is advisory telemetry to the platform, not a gate on the work.
- **Gate every attach call on non-reconnect.** Fire `worker-attached`/`worker-attach-failed` ONLY when the job is a fresh/resumed *work* attach — status NOT in `{delivered, disputed}`. A Flow-B dispute/delivered respawn must NOT fire either call (it would hit the backend's `STATE_CONFLICT` 409). The worker already has `_isPostDeliveryReconnect` (Item B, `job-agent.js:371`); the host checks `job.status` directly. (A resumed `in_progress` job legitimately re-fires `worker-attached` → backend 200 idempotent, harmless.)
- **No signature / no broker primitive** — plain authenticated POST via the existing per-agent session.
- **No backend changes required** to ship our half (endpoints live). The `worker_attach_failed_reason` column is a backend follow-up; we send `{reason}` regardless.
- **Out of scope:** the 90s host watchdog; any business-logic consumption of the timestamps; money-safety "paid + never-attached → refund-eligible" resolver wiring (deferred product decision); the in-place `reconnect` IPC path (the fresh/resumed respawn runs `main()` from the top, which covers attach).
- SDK: `npx tsc --noEmit`, `yarn build`, `npx tsx --test`. Dispatcher: `node --check`, `node --test`.

## Components

### 1. SDK — two client methods (`src/client/index.ts`, near `acceptJob`/`deliverJob` ~517-535)

```ts
async confirmWorkerAttached(jobId: string): Promise<Job> {
  const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/worker-attached`, {});
  return res.data;
}
async reportWorkerAttachFailed(jobId: string, reason: string): Promise<Job> {
  const res = await this.request<{ data: Job }>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/worker-attach-failed`, { reason });
  return res.data;
}
```

### 2. Worker self-report (`src/job-agent.js`, the `connectChat()` block ~381-395)

A small testable helper, gated + fail-open, called from the try/catch around `connectChat()`:

```js
// Exported under NODE_ENV==='test'. isReconnect = _isPostDeliveryReconnect.
async function selfReportAttach(agent, jobId, { isReconnect, failed, reason } = {}) {
  if (isReconnect) return;                       // never attach on a dispute/delivered respawn (backend 409)
  try {
    if (failed) await agent.client.reportWorkerAttachFailed(jobId, reason || 'attach-failed');
    else        await agent.client.confirmWorkerAttached(jobId);
  } catch (e) { console.error(`[ATTACH] ${failed ? 'attach-failed' : 'attached'} report failed (non-fatal): ${e.message}`); }
}
```

Wiring:
- After `await agent.connectChat(); console.log('✅ Connected to SovGuard')` → `await selfReportAttach(agent, job.id, { isReconnect: _isPostDeliveryReconnect });`
- In the `connectChat` catch, before the existing deliver-failure/exit path → `await selfReportAttach(agent, job.id, { isReconnect: _isPostDeliveryReconnect, failed: true, reason: 'chat-connect-failed: ' + chatErr.message });`

### 3. Host spawn-failure report (`src/cli.js`, `startJobContainer` catch ~6997 + `startJobLocal` catch ~7335)

A small testable helper, gated on `job.status` + fail-open:

```js
// Exported under NODE_ENV==='test'.
async function reportSpawnAttachFailed(state, agentInfo, job, reason, deps = {}) {
  if (job.status === 'delivered' || job.status === 'disputed') return;  // respawn: would 409
  const getSession = deps.getAgentSession || getAgentSession;
  try {
    const agent = await getSession(state, agentInfo);
    await agent.client.reportWorkerAttachFailed(job.id, reason);
  } catch (e) { console.error(`[ATTACH] host spawn-fail report failed (non-fatal): ${e.message}`); }
}
```

Wiring: in each catch, before `state.available.push(agentInfo)`:
`await reportSpawnAttachFailed(state, agentInfo, job, 'spawn-error: ' + e.message);`

## Data flow

- **Fresh hire:** startJob → container spawns → `connectChat` ok → `confirmWorkerAttached` → `worker_attached_at` stamped (visible as `workerAttachedAt`). connectChat fails → `reportWorkerAttachFailed('chat-connect-failed')` → container exits. Container never spawns → host `reportSpawnAttachFailed('spawn-error')`.
- **Resumed `in_progress` respawn:** new container runs `main()` → `connectChat` ok → `confirmWorkerAttached` → backend 200 idempotent (timestamp refreshed).
- **Dispute/delivered respawn (Flow B):** `_isPostDeliveryReconnect === true` → `selfReportAttach` returns immediately; host `reportSpawnAttachFailed` short-circuits on `job.status` → **no attach call, no 409**.

## Testing

- SDK (`test/worker-attach.test.ts`): `confirmWorkerAttached` POSTs `/worker-attached` with `{}` and returns `res.data`; `reportWorkerAttachFailed` POSTs `/worker-attach-failed` with `{reason}`. Stub `client.request`, assert method+path+body.
- Worker (`test/self-report-attach.test.js`): `selfReportAttach` — success path calls `confirmWorkerAttached` only; `failed` path calls `reportWorkerAttachFailed` with the reason; `isReconnect:true` calls **neither**; a throwing client is swallowed (fail-open, no throw).
- Host (`test/spawn-attach-failed.test.js`): `reportSpawnAttachFailed` — non-reconnect status calls `reportWorkerAttachFailed` via injected session; `delivered`/`disputed` status calls neither; a throwing session is swallowed (fail-open).

## Rollout

1. Land C on the branch; unit tests both repos.
2. SDK `yarn build`; rebuild the job-agent image; restart the dispatcher (endpoints are already live — no backend deploy needed).
3. Live-test: fresh job → confirm `workerAttachedAt` populates in the job payload; force a spawn/connect failure → confirm `worker_attach_failed_at` stamps + buyer `job.reconnect` notice. Confirm a Flow-B dispute respawn fires **neither** (no 409 in logs).
4. (Deferred) tell backend to wire `worker_attach_failed_at` into the resolver fact-gating if we want paid-but-never-attached to become refund-eligible.
