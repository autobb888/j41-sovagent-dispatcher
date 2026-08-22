'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-vattach-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

// The vast provider table carries fetchImpl straight through to VastProvider
// (its constructor reads cfg.fetchImpl) — no registry hacks needed.
function happyFetch() {
  let created = false;
  const j = (b) => ({ status: 200, ok: true, async json() { return b; }, async text() { return JSON.stringify(b); } });
  return async (url, opts = {}) => {
    const m = (opts.method || 'GET').toUpperCase();
    if (m === 'GET' && url.includes('/bundles')) return j({ offers: [{ id: 5, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.2, rentable: true, rented: false }] });
    if (m === 'PUT' && url.includes('/asks/5')) { created = true; return j({ success: true, new_contract: 555 }); }
    if (m === 'GET' && url.includes('/instances')) return j({ instances: created ? [{ id: 555, actual_status: 'running', ssh_host: '1.2.3.4', ssh_port: 22, ports: { '8000/tcp': [{ HostPort: '41000' }] } }] : [] });
    return j({ success: true });
  };
}

function cfg(max) {
  return { compute: { enabled: true, max_usd_per_hour: max, providers: {
    cloud: { type: 'vast', agent_id: 'agent-1', api_key: 'k', min_vram_gb: 24, fetchImpl: happyFetch() },
  } } };
}

test('vast attach is a no-op when the ceiling is 0', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: cfg(0), agentConfigs });
  await ctrl.attachVastLeases();
  assert.equal(ctrl.getLeases().length, 0);
  assert.equal(agentConfigs.size, 0);
});

test('vast attach provisions one lease under a positive ceiling and publishes its upstream', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: cfg(1), agentConfigs });
  await ctrl.attachVastLeases();
  const leases = ctrl.getLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].state, 'ready');
  assert.equal(leases[0].usdPerHour, 0.2);
  assert.equal(agentConfigs.get('agent-1').endpointUrl, 'http://1.2.3.4:41000/v1');
});

test('attachVastLeases skips a vast provider whose agent slot is gpu-rental', async () => {
  const agentConfigs = new Map([['gpu-1', { rental: true, serviceType: 'gpu-rental' }]]);
  let acquired = 0;
  const inner = happyFetch();
  const fetchImpl = async (url, opts = {}) => {
    const m = (opts.method || 'GET').toUpperCase();
    if (m === 'PUT' && String(url).includes('/asks')) acquired += 1;
    return inner(url, opts);
  };
  const ctrl = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {
      cloud: { type: 'vast', agent_id: 'gpu-1', api_key: 'k', min_vram_gb: 24, fetchImpl },
    } } },
    agentConfigs,
  });
  await ctrl.attachVastLeases();
  assert.equal(acquired, 0);
  assert.equal(ctrl.getLeases().length, 0);
});

test('attachVastLeases still provisions vast for a Cat-2 api-endpoint agent', async () => {
  const agentConfigs = new Map([['agent-1', { serviceType: 'api-endpoint' }]]);
  const ctrl = createSupplyController({ cfg: cfg(1), agentConfigs });
  await ctrl.attachVastLeases();
  assert.ok(ctrl.getLeases().length >= 1);
  assert.equal(ctrl.getLeases()[0].state, 'ready');
});
