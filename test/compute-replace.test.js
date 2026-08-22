'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-replace-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

function deadThenFresh() {
  let n = 0;
  return {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async probe() { return { healthy: false }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.2, gpu: {}, meta: { askId: 1 } }]; },
    async acquire(c) { n += 1; return { id: `vast:new${n}`, provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, private: false, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', baseUrl: 'http://fresh/v1' }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
}

test('a dead elastic lease is replaced once per tick and the new upstream is published', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs });
  ctrl._injectBoundLease(
    { id: 'vast:old', provider: 'vast', state: 'ready', usdPerHour: 0.2, baseUrl: 'http://old/v1', private: false, meta: {} },
    deadThenFresh(), 'agent-1',
  );
  await ctrl.reconcileTick();
  const leases = ctrl.getLeases();
  assert.equal(leases.length, 1, 'the dead lease is gone, exactly one fresh lease remains (no same-tick loop)');
  assert.ok(leases[0].id.startsWith('vast:new') && leases[0].state === 'ready', 'a fresh ready lease replaced the dead one');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, 'http://fresh/v1');
});

test('replacement blocked by the ceiling degrades in place', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0.1, providers: {} } }, agentConfigs });
  const oldLease = { id: 'vast:old', provider: 'vast', state: 'ready', usdPerHour: 0.2, baseUrl: 'http://old/v1', private: false, meta: {} };
  ctrl._injectBoundLease(oldLease, deadThenFresh(), 'agent-1');
  ctrl.publishUpstream('agent-1', oldLease); // it was serving before it died
  await ctrl.reconcileTick();
  const leases = ctrl.getLeases();
  assert.equal(leases[0].state, 'degraded', 'over-ceiling replacement falls back to degrade');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, null);
});
