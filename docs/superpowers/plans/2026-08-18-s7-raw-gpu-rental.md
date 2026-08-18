# S7 — Raw GPU Access (Cat-1 rental-as-job) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Sell hourly raw-GPU access as a job whose deliverable is SSH credentials — reusing the existing per-job money path (E1), with lease release **driven by the compute-supply reconcile loop + boot recovery** so it survives timeout, crash, dispute, and SIGKILL. No new billing engine.

**Architecture:** `src/rental-job.js` holds the pure guards + the rental-lease acquisition (canSsh required, on-demand pinned, credentials formatted with the all-or-nothing disclosure). `compute-supply` gains **job-bound leases** with an `expiresAt`; `reconcileTick` releases any lease past expiry, and `releaseOrphansOnBoot` releases any job-bound lease whose job is no longer active. `rental-setup <agent-id>` registers a `gpu-rental` service and refuses to co-exist with an `api-endpoint` service (separate slots). **Release is never threaded into the live job loop** — the reconcile loop owns it, which is what makes "release survives everything" true.

**Tech Stack:** Node CommonJS, `node:test`, builds on S5+S6.

**Spec:** `junction41/docs/superpowers/specs/2026-08-18-sovereign-supply-integration-design.md` §6.2 + roadmap §8 (2.34.0).

## Global Constraints

- Same as S5/S6. `[compute] enabled=false` = no-op. No live external calls in tests.
- **canSsh:false providers are refused** (never hand a stranger SSH into a home LAN — `local` returns canSsh:false). Hard block, config-time + acquire-time.
- **Cat-1 pins on-demand** — a rental that vanishes mid-hour is a refund + reputation hit. `acquireRentalLease` passes `interruptible:false` in the spec.
- **Separate agent slots per category** — `rental-setup` refuses on an agent that already has an `api-endpoint` service, and vice-versa (mixed-service `_isApiEndpoint` hazard, spec §11.17).
- **All-or-nothing expiry disclosed** in the generated service description.
- **DEFERRED, flagged (money path — needs owner review):** wiring a rental *job* to actually execute in the live worker loop and deliver the credentials to the buyer. S7 ships the seller-side infrastructure + guards + release safety; the worker-execution hook is a small, reviewed follow-up. `acquireRentalLease` returns the exact `{lease, deliverable}` that hook will hand to the job-delivery path.

---

### Task 1: Guards + deliverable formatter (pure)

**Files:** Create `src/rental-job.js`; Test `test/rental-guards.test.js`.

**Interfaces:**
- `assertRentalEligibleAgent(services)` — throws `RENTAL_SLOT_CONFLICT` if any `services[i].serviceType === 'api-endpoint'`.
- `assertApiEligibleAgent(services)` — throws `API_SLOT_CONFLICT` if any `serviceType === 'gpu-rental'` (the reverse guard for api-setup, exported for symmetry).
- `assertProviderCanSsh(provider)` — throws `RENTAL_NO_SSH` if `!provider.capabilities.canSsh`.
- `formatRentalDeliverable(lease, { jobTimeoutMin })` → `{ ssh, expiresAt, disclosure }` where `disclosure` states the all-or-nothing, no-pro-rata term.

- [ ] **Step 1: failing test**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRentalEligibleAgent, assertApiEligibleAgent, assertProviderCanSsh, formatRentalDeliverable } = require('../src/rental-job');

test('assertRentalEligibleAgent rejects an agent that already has an api-endpoint service', () => {
  assert.throws(() => assertRentalEligibleAgent([{ serviceType: 'api-endpoint' }]), /RENTAL_SLOT_CONFLICT/);
  assert.doesNotThrow(() => assertRentalEligibleAgent([{ serviceType: 'gpu-rental' }]));
  assert.doesNotThrow(() => assertRentalEligibleAgent([]));
});

test('assertApiEligibleAgent rejects an agent that already has a gpu-rental service', () => {
  assert.throws(() => assertApiEligibleAgent([{ serviceType: 'gpu-rental' }]), /API_SLOT_CONFLICT/);
});

test('assertProviderCanSsh hard-blocks a provider that cannot offer SSH', () => {
  assert.throws(() => assertProviderCanSsh({ capabilities: { canSsh: false } }), /RENTAL_NO_SSH/);
  assert.doesNotThrow(() => assertProviderCanSsh({ capabilities: { canSsh: true } }));
});

test('formatRentalDeliverable carries ssh, expiry, and the all-or-nothing disclosure', () => {
  const d = formatRentalDeliverable({ ssh: { host: '1.2.3.4', port: 22, user: 'root' }, expiresAt: 1755500000000 }, { jobTimeoutMin: 60 });
  assert.equal(d.ssh.host, '1.2.3.4');
  assert.equal(d.expiresAt, 1755500000000);
  assert.match(d.disclosure, /no pro-rata|all-or-nothing|not refundable/i);
});
```
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** `src/rental-job.js`:
```js
'use strict';
function assertRentalEligibleAgent(services = []) {
  if ((services || []).some((s) => s && s.serviceType === 'api-endpoint')) {
    throw new Error('RENTAL_SLOT_CONFLICT: this agent has an api-endpoint service; rentals need a separate agent slot');
  }
}
function assertApiEligibleAgent(services = []) {
  if ((services || []).some((s) => s && s.serviceType === 'gpu-rental')) {
    throw new Error('API_SLOT_CONFLICT: this agent has a gpu-rental service; api endpoints need a separate agent slot');
  }
}
function assertProviderCanSsh(provider) {
  if (!provider || !provider.capabilities || !provider.capabilities.canSsh) {
    throw new Error('RENTAL_NO_SSH: provider cannot offer SSH access (a home/local box is never rented bare-metal)');
  }
}
function formatRentalDeliverable(lease, { jobTimeoutMin } = {}) {
  return {
    ssh: lease.ssh,
    expiresAt: lease.expiresAt,
    disclosure: `This rental runs for up to ${jobTimeoutMin || 60} minutes. Billing is all-or-nothing: `
      + 'there is no pro-rata refund for unused time and the box is released at expiry.',
  };
}
module.exports = { assertRentalEligibleAgent, assertApiEligibleAgent, assertProviderCanSsh, formatRentalDeliverable };
```
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit** `feat(compute): rental guards + deliverable formatter (S7 T1)`

---

### Task 2: `acquireRentalLease` — canSsh + on-demand + job-bound

**Files:** Modify `src/rental-job.js`; Modify `src/compute-supply.js` (job-bound binding); Test `test/rental-acquire.test.js`.

**Interfaces:**
- `compute-supply`: `bindJobLease(lease, provider, agentId, jobId)` — like `_injectBoundLease` but records `jobId` on the lease and in `bound`.
- `rental-job`: `acquireRentalLease({ controller, provider, spec, jobId, agentId, jobTimeoutMin, now })` — `assertProviderCanSsh`; `controller.acquireUnderCeiling(provider, cand)` on the cheapest `discover({ ...spec, interruptible:false })` candidate; `waitReady`; set `lease.jobId`, `lease.expiresAt = now + jobTimeoutMin*60000`; `controller.bindJobLease(...)`; return `{ lease, deliverable: formatRentalDeliverable(lease,{jobTimeoutMin}) }`.

- [ ] **Step 1: failing test** (ssh-capable fake provider)
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-acq-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');
const { acquireRentalLease } = require('../src/rental-job');

function sshProvider() {
  return {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async discover(spec) { assert.equal(spec.interruptible, false); return [{ provider: 'vast', usdPerHour: 0.3, gpu: { name: 'A100' }, meta: { askId: 1 } }]; },
    async acquire(c) { return { id: 'vast:r1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', ssh: { host: '9.9.9.9', port: 22, user: 'root' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
}

test('acquireRentalLease pins on-demand, binds the job, sets expiry, and returns credentials', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map(), now: () => 1000 });
  const { lease, deliverable } = await acquireRentalLease({
    controller: ctrl, provider: sshProvider(), spec: { minVramGb: 40 }, jobId: 'job-1', agentId: 'agent-1', jobTimeoutMin: 60, now: 1000,
  });
  assert.equal(lease.jobId, 'job-1');
  assert.equal(lease.expiresAt, 1000 + 60 * 60000);
  assert.equal(deliverable.ssh.host, '9.9.9.9');
  assert.equal(ctrl.getLeases().length, 1);
});

test('acquireRentalLease refuses a canSsh:false provider', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map() });
  const noSsh = { capabilities: { canSsh: false }, async discover() { return []; } };
  await assert.rejects(() => acquireRentalLease({ controller: ctrl, provider: noSsh, spec: {}, jobId: 'j', agentId: 'a', jobTimeoutMin: 60 }), /RENTAL_NO_SSH/);
});
```
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** In `compute-supply.js`, add inside the controller:
```js
  function bindJobLease(lease, provider, agentId, jobId) {
    const l = { ...lease, jobId };
    leases.set(l.id, l);
    bound.set(l.id, { provider, agentId, jobId });
    return l;
  }
```
and export it. In `rental-job.js`:
```js
async function acquireRentalLease({ controller, provider, spec = {}, jobId, agentId, jobTimeoutMin = 60, now = Date.now() }) {
  assertProviderCanSsh(provider);
  const cands = await provider.discover({ ...spec, interruptible: false }); // Cat-1 on-demand only
  if (!cands.length) throw new Error('RENTAL_NO_CAPACITY: no on-demand offer matched the spec');
  let lease = await controller.acquireUnderCeiling(provider, cands[0]);
  lease = await provider.waitReady(lease, { timeoutMs: 300000 });
  lease = { ...lease, jobId, expiresAt: now + jobTimeoutMin * 60000 };
  controller.bindJobLease(lease, provider, agentId, jobId);
  return { lease, deliverable: formatRentalDeliverable(lease, { jobTimeoutMin }) };
}
```
Add `acquireRentalLease` to `rental-job.js` exports.
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit** `feat(compute): acquireRentalLease — on-demand, job-bound, canSsh-gated (S7 T2)`

---

### Task 3: Release safety — expiry in reconcile + terminal-job on boot

**Files:** Modify `src/compute-supply.js`; Test `test/rental-release.test.js`.

**Interfaces:**
- `reconcileTick`: at the top of the per-lease loop, if `lease.expiresAt && now() > lease.expiresAt`, release + unbind + unpublish + `continue` (rental expiry).
- `releaseOrphansOnBoot(isJobActive)`: optional predicate; additionally release any job-bound persisted lease whose `!isJobActive(lease.jobId)`. Default predicate reads `loadActiveJobs()` keys.

- [ ] **Step 1: failing test**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-rel-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');
const { persistLeases, loadLeases } = require('../src/config');

function relProvider(released) {
  return { get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async probe() { return { healthy: true }; }, async release(l) { released.push(l.id); return { ...l, state: 'released' }; } };
}

test('reconcileTick releases a rental lease past its expiry', async () => {
  let t = 5000;
  const released = [];
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs, now: () => t });
  const lease = { id: 'vast:r', provider: 'vast', state: 'ready', usdPerHour: 0.3, baseUrl: 'http://r/v1', jobId: 'job-1', expiresAt: 4000, private: false, meta: {} };
  ctrl._injectBoundLease(lease, relProvider(released), 'agent-1');
  ctrl.publishUpstream('agent-1', lease);
  await ctrl.reconcileTick();
  assert.ok(released.includes('vast:r'), 'expired rental was released');
  assert.equal(ctrl.getLeases().find((l) => l.id === 'vast:r')?.state, 'released');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, null);
});

test('releaseOrphansOnBoot releases a persisted rental lease whose job is no longer active', async () => {
  persistLeases(new Map([['vast:r', { id: 'vast:r', provider: 'vast', state: 'ready', jobId: 'job-dead', baseUrl: 'http://x/v1' }]]));
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, providers: {} } }, agentConfigs: new Map() });
  await ctrl.releaseOrphansOnBoot(() => false); // no job is active
  assert.deepEqual(loadLeases(), {});
});
```
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** In `reconcileTick`, immediately after `if (lease.state === 'released') continue;` add:
```js
      if (lease.expiresAt && now() > lease.expiresAt) {
        const bx = bound.get(id);
        const prov = bx ? bx.provider : createProvider(lease.provider, { id, base_url: lease.baseUrl });
        try { await prov.release(lease); } catch { /* idempotent */ }
        leases.set(id, { ...lease, state: 'released' });
        unpublishUpstream(bx ? bx.agentId : null);
        continue;
      }
```
(Ensure `now` is the injected `now` function — the controller already receives `now = Date.now`; call `now()`.) In `releaseOrphansOnBoot`, accept `isJobActive` and also release job-bound terminal leases:
```js
  async function releaseOrphansOnBoot(isJobActive) {
    const activeSet = typeof isJobActive === 'function' ? null : new Set(Object.keys(loadActiveJobs()));
    const active = isJobActive || ((jobId) => activeSet.has(jobId));
    const persisted = loadLeases();
    for (const [id, lease] of Object.entries(persisted)) {
      const terminalJob = lease.jobId && !active(lease.jobId);
      if ((lease && lease.state && lease.state !== 'released') && (terminalJob || !lease.jobId)) {
        try { await createProvider(lease.provider, { id, base_url: lease.baseUrl }).release(lease); }
        catch { /* idempotent */ }
      }
    }
    persistLeases(new Map());
  }
```
Add `const { loadLeases, persistLeases, loadActiveJobs } = require('./config');` (extend the existing require).
- [ ] **Step 4: run — PASS.** Then full suite (S5/S6 reconcile behaviour unchanged for non-expiring leases).
- [ ] **Step 5: commit** `feat(compute): rental release on expiry + terminal-job boot recovery (S7 T3)`

---

### Task 4: `rental-setup <agent-id>` command (config-level)

**Files:** Modify `src/cli.js` (add the command near `api-setup`); Modify `docs/config.toml.example` (note the rental service); Test `test/rental-setup-guard.test.js` (tests the guard the command uses).

**Interfaces:** `rental-setup` loads the agent's services, runs `assertRentalEligibleAgent`, and registers a `serviceType:'gpu-rental'` service with the all-or-nothing disclosure in its description. The command is thin; the tested logic is the guard.

- [ ] **Step 1: failing test**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRentalEligibleAgent } = require('../src/rental-job');

test('rental-setup guard blocks mixing rental onto an api-endpoint agent', () => {
  assert.throws(() => assertRentalEligibleAgent([{ serviceType: 'api-endpoint', name: 'inference' }]), /RENTAL_SLOT_CONFLICT/);
});
test('rental-setup guard allows a clean agent', () => {
  assert.doesNotThrow(() => assertRentalEligibleAgent([{ serviceType: 'chat' }]));
});
```
- [ ] **Step 2: run — PASS immediately** (guard exists from T1; this test pins the command's contract). If it passes first run, that is expected — the command wiring below has no separate unit test (it is CLI glue over the tested guard).
- [ ] **Step 3: implement the command** in `cli.js` (mirror `api-setup <agent-id>` at :3125). Minimal shape:
```js
program
  .command('rental-setup <agent-id>')
  .description('Register a raw-GPU rental (Cat-1) service on an agent. All-or-nothing hourly billing; requires an SSH-capable compute provider.')
  .option('--price <vrsc>', 'Price per rental window (VRSC)')
  .action(async (agentId, options) => {
    const { assertRentalEligibleAgent } = require('./rental-job');
    // ... load the agent + its existing services (mirror api-setup's agent load) ...
    try { assertRentalEligibleAgent(existingServices); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    // ... register serviceType:'gpu-rental' with description incl. the disclosure ...
    console.log('✅ Rental service registered. Remember: a rental job delivers SSH credentials and the box is released at jobTimeoutMin.');
  });
```
(Follow `api-setup`'s exact agent-load + service-registration mechanics; keep the on-chain/service write identical to how api-setup persists, swapping serviceType and the description.)
- [ ] **Step 4: run** the guard test + `node --check src/cli.js`.
- [ ] **Step 5: commit** `feat(compute): rental-setup command + separate-slot guard (S7 T4)`

---

## Self-Review

**Spec coverage (roadmap §8 hard requirements):** (1) release survives everything → T3 (reconcile expiry + boot terminal-job release, reconcile loop owns release, not the job loop). (2) canSsh:false refused → T1/T2. (3) separate agent slots → T1 guards + T4 command. (4) all-or-nothing disclosed → T1 formatter + T4 description. On-demand pin → T2 (`interruptible:false`, asserted in the test). ✓
**Explicitly deferred + flagged (owner review):** the live worker-loop hook that runs a rental *job*, calls `acquireRentalLease`, and hands `deliverable` to the buyer via the job-delivery path — a money-path change kept out of this plan on purpose. `acquireRentalLease` already returns exactly what that hook needs.
**Type consistency:** `lease.jobId`/`lease.expiresAt` set in T2, read in T3; `deliverable` shape from T1 formatter used by T2; `acquireUnderCeiling`/`bindJobLease` on the controller from S6/T2.
