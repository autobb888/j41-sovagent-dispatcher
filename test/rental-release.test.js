'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-rel-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');
const { persistLeases, loadLeases } = require('../src/config');

function relProvider(released) {
  return {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async probe() { return { healthy: true }; },
    async release(l) { released.push(l.id); return { ...l, state: 'released' }; },
  };
}

test('reconcileTick releases a rental lease past its expiry and clears its upstream', async () => {
  let t = 5000;
  const released = [];
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs, now: () => t });
  const lease = { id: 'vast:r', provider: 'vast', state: 'ready', usdPerHour: 0.3, baseUrl: 'http://r/v1', jobId: 'job-1', expiresAt: 4000, private: false, meta: {} };
  ctrl._injectBoundLease(lease, relProvider(released), 'agent-1');
  ctrl.publishUpstream('agent-1', lease);
  await ctrl.reconcileTick();
  assert.ok(released.includes('vast:r'), 'expired rental was released');
  assert.equal(ctrl.getLeases().find((l) => l.id === 'vast:r').state, 'released');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, null);
});

test('a not-yet-expired rental is NOT released', async () => {
  const released = [];
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map(), now: () => 3000 });
  const lease = { id: 'vast:r', provider: 'vast', state: 'ready', usdPerHour: 0.3, baseUrl: 'http://r/v1', jobId: 'job-1', expiresAt: 4000, private: false, meta: {} };
  ctrl._injectBoundLease(lease, relProvider(released), 'agent-1');
  await ctrl.reconcileTick();
  assert.equal(released.length, 0, 'still within the window');
  assert.equal(ctrl.getLeases()[0].state, 'ready');
});

test('releaseOrphansOnBoot releases a persisted rental whose job is no longer active', async () => {
  persistLeases(new Map([['vast:r', { id: 'vast:r', provider: 'vast', state: 'ready', jobId: 'job-dead', baseUrl: 'http://x/v1' }]]));
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, providers: {} } }, agentConfigs: new Map() });
  await ctrl.releaseOrphansOnBoot(() => false);
  assert.deepEqual(loadLeases(), {});
});
