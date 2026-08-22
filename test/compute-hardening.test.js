'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-compute-hard-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');
const { persistLeases, loadLeases } = require('../src/config');

// C2 — a release that throws must NOT mark the lease released; it becomes release-pending
// and the reconcile loop retries it.
test('C2: a failing release keeps the lease as release-pending and retries next tick', async () => {
  let t = 10000;
  let failNext = true;
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, isElastic: true }; },
    async probe() { return { healthy: true }; },
    async release(l) { if (failNext) { failNext = false; throw new Error('VAST_RELEASE_FAILED status=429'); } return { ...l, state: 'released' }; },
  };
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map(), now: () => t });
  ctrl._injectBoundLease({ id: 'vast:r', provider: 'vast', state: 'ready', usdPerHour: 0.3, jobId: 'j1', expiresAt: 4000, meta: {} }, provider, 'a1');
  await ctrl.reconcileTick();
  assert.equal(ctrl.getLeases()[0].state, 'release-pending', 'first release failed → release-pending, NOT released');
  await ctrl.reconcileTick();
  assert.equal(ctrl.getLeases()[0].state, 'released', 'retry succeeded');
});

// C3 — a still-active rental at boot is rehydrated (not wiped) so it can be released later.
test('C3: releaseOrphansOnBoot rehydrates a still-active rental instead of wiping it', async () => {
  persistLeases(new Map([['vast:r', { id: 'vast:r', provider: 'vast', state: 'ready', jobId: 'job-live', providerName: 'cloud', boundAgentId: 'a1', usdPerHour: 0.3, meta: { instanceId: 5 } }]]));
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, providers: { cloud: { type: 'vast', api_key: 'k' } } } }, agentConfigs: new Map() });
  await ctrl.releaseOrphansOnBoot((jobId) => jobId === 'job-live'); // job still active
  assert.equal(ctrl.getLeases().length, 1, 'active rental rehydrated into the controller');
  assert.equal(ctrl.getLeases()[0].jobId, 'job-live');
  assert.ok(loadLeases()['vast:r'], 'and kept in the persisted file (not wiped)');
});

// H2 — an unhealthy job-bound rental is released, NEVER replaced (buyer holds creds for THIS box).
test('H2: a dead job-bound rental is released, not replaced', async () => {
  let acquires = 0;
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, isElastic: true }; },
    async probe() { return { healthy: false }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.3, gpu: {}, meta: {} }]; },
    async acquire() { acquires += 1; return { id: `vast:n${acquires}`, provider: 'vast', state: 'pending', usdPerHour: 0.3, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready' }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 5, providers: {} } }, agentConfigs: new Map() });
  ctrl._injectBoundLease({ id: 'vast:r', provider: 'vast', state: 'ready', usdPerHour: 0.3, jobId: 'j1', meta: {} }, provider, 'a1');
  await ctrl.reconcileTick();
  assert.equal(acquires, 0, 'no replacement acquired for a job-bound rental');
  assert.equal(ctrl.getLeases()[0].state, 'released');
});

// H3 — replacement excludes the dying lease from the ceiling (release-first), so a lease
// priced near the ceiling can still be replaced.
test('H3: replace-on-death frees the dying lease from the ceiling before acquiring', async () => {
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, isElastic: true }; },
    async probe() { return { healthy: false }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.3, gpu: {}, meta: {} }]; },
    async acquire(c) { return { id: 'vast:fresh', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', baseUrl: 'http://fresh/v1' }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const agentConfigs = new Map();
  // ceiling 0.4; dying lease is 0.3 — old(0.3)+new(0.3)=0.6 would exceed, but release-first frees it.
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0.4, providers: {} } }, agentConfigs });
  ctrl._injectBoundLease({ id: 'vast:old', provider: 'vast', state: 'ready', usdPerHour: 0.3, baseUrl: 'http://old/v1', meta: {} }, provider, 'a1');
  ctrl.publishUpstream('a1', { id: 'vast:old', baseUrl: 'http://old/v1' });
  await ctrl.reconcileTick();
  assert.ok(ctrl.getLeases().some((l) => l.id === 'vast:fresh' && l.state === 'ready'), 'replacement succeeded despite the near-ceiling price');
  assert.equal(agentConfigs.get('a1').endpointUrl, 'http://fresh/v1');
});

// H6 — publishing a lease saves and later RESTORES the agent's pre-lease upstream.
test('H6: unpublish restores a pre-existing on-chain upstream instead of nulling it', async () => {
  const agentConfigs = new Map([['a1', { endpointUrl: 'http://on-chain/v1', modelPricing: [{ model: 'x' }] }]]);
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs });
  const provider = { get capabilities() { return { isElastic: false }; }, async probe() { return { healthy: false }; }, async release(l) { return l; } };
  ctrl._injectBoundLease({ id: 'local:x', provider: 'local', state: 'ready', usdPerHour: 0, baseUrl: 'http://lease/v1', meta: {} }, provider, 'a1');
  ctrl.publishUpstream('a1', { id: 'local:x', baseUrl: 'http://lease/v1', private: true });
  assert.equal(agentConfigs.get('a1').endpointUrl, 'http://lease/v1', 'lease upstream published');
  await ctrl.reconcileTick(); // probe unhealthy, non-elastic → degrade → unpublish
  assert.equal(agentConfigs.get('a1').endpointUrl, 'http://on-chain/v1', 'original upstream restored, not nulled');
  assert.deepEqual(agentConfigs.get('a1').modelPricing, [{ model: 'x' }], 'other fields preserved');
});

// H6b — a job-bound rental lease is never published as a proxy upstream.
test('H6b: a rental (job-bound) lease is not published as an inference upstream', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs });
  ctrl.publishUpstream('a1', { id: 'vast:r', baseUrl: 'http://rental/v1', jobId: 'j1' });
  assert.equal(agentConfigs.has('a1'), false, 'a rental box must not become a proxy upstream');
});
