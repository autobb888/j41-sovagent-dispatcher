'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-supply-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

function startStub(ok = true) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(req.url === '/v1/models' && ok ? 200 : 500); res.end('{}'); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function makeCfg(port) {
  return { compute: { enabled: true, reconcile_ms: 1000, providers: {
    workshop: { type: 'local', agent_id: 'agent-1', base_url: `http://127.0.0.1:${port}/v1`, usd_per_hour: 0.08, allow_private_upstream: true },
  } } };
}

test('attachLocalLeases publishes lease baseUrl + private into agentConfigs', async () => {
  const { srv, port } = await startStub(true);
  try {
    const agentConfigs = new Map();
    const ctrl = createSupplyController({ cfg: makeCfg(port), agentConfigs });
    await ctrl.attachLocalLeases();
    const entry = agentConfigs.get('agent-1');
    assert.equal(entry.endpointUrl, `http://127.0.0.1:${port}/v1`);
    assert.equal(entry.allowPrivate, true);
    assert.equal(ctrl.getLeases()[0].state, 'ready');
  } finally { srv.close(); }
});

test('reconcileTick marks a dead lease degraded and clears its upstream within one tick', async () => {
  const { srv, port } = await startStub(true);
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: makeCfg(port), agentConfigs });
  await ctrl.attachLocalLeases();
  assert.equal(ctrl.getLeases()[0].state, 'ready');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, `http://127.0.0.1:${port}/v1`);

  await new Promise((r) => srv.close(r)); // kill the box, wait for the socket to close
  await ctrl.reconcileTick();

  assert.equal(ctrl.getLeases()[0].state, 'degraded');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, null, 'degraded lease clears upstream for a clean 502');
});

test('releaseOrphansOnBoot releases persisted non-terminal leases then clears the file', async () => {
  const { persistLeases, loadLeases } = require('../src/config');
  persistLeases(new Map([['local:workshop', { id: 'local:workshop', provider: 'local', state: 'ready', baseUrl: 'http://127.0.0.1:1/v1' }]]));
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, providers: {} } }, agentConfigs: new Map() });
  await ctrl.releaseOrphansOnBoot();
  assert.deepEqual(loadLeases(), {}, 'lease file cleared after boot release');
});
