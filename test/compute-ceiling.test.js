'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-ceiling-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

const fakeProvider = { acquire: async (c) => ({ id: 'vast:1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, private: false, meta: {} }) };

test('acquireUnderCeiling rejects a candidate that would exceed max_usd_per_hour', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0.3, providers: {} } }, agentConfigs: new Map() });
  await assert.rejects(() => ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.5, gpu: {}, meta: {} }), /CEILING_EXCEEDED/);
});

test('max_usd_per_hour <= 0 blocks all paid provisioning', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0, providers: {} } }, agentConfigs: new Map() });
  await assert.rejects(() => ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.01, gpu: {}, meta: {} }), /CEILING_EXCEEDED/);
});

test('acquireUnderCeiling permits a candidate within the ceiling', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map() });
  const lease = await ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.2, gpu: {}, meta: {} });
  assert.equal(lease.usdPerHour, 0.2);
});

test('committed leases count against the ceiling', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0.5, providers: {} } }, agentConfigs: new Map() });
  ctrl._injectBoundLease({ id: 'vast:held', provider: 'vast', state: 'ready', usdPerHour: 0.4, meta: {} }, fakeProvider, 'a1');
  await assert.rejects(() => ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.2, gpu: {}, meta: {} }), /CEILING_EXCEEDED/);
});
