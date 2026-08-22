'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VastProvider } = require('../src/providers/vast');

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const r = routes.find((x) => x.method === method && x.match(url));
    if (!r) throw new Error(`no fake route for ${method} ${url}`);
    return { status: r.status, ok: r.status < 400, async json() { return r.body; }, async text() { return JSON.stringify(r.body); } };
  };
}

test('discover returns scored candidates from /bundles/', async () => {
  const fetchImpl = fakeFetch([
    { method: 'GET', match: (u) => u.includes('/bundles'), status: 200, body: { offers: [
      { id: 7, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.22, rentable: true, rented: false },
    ] } },
  ]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl, minVramGb: 24, maxUsdPerHour: 1 });
  const cands = await p.discover({});
  assert.equal(cands.length, 1);
  assert.equal(cands[0].meta.askId, 7);
});

test('acquire maps 410 to VAST_OFFER_GONE (retry search, not create)', async () => {
  const fetchImpl = fakeFetch([{ method: 'PUT', match: (u) => u.includes('/asks/7'), status: 410, body: {} }]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  await assert.rejects(() => p.acquire({ provider: 'vast', usdPerHour: 0.22, gpu: {}, meta: { askId: 7 } }, {}), /VAST_OFFER_GONE/);
});

test('acquire maps 400 to a fatal VAST_CONFIG_ERROR', async () => {
  const fetchImpl = fakeFetch([{ method: 'PUT', match: (u) => u.includes('/asks/7'), status: 400, body: { error: 'no ssh key' } }]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  await assert.rejects(() => p.acquire({ provider: 'vast', usdPerHour: 0.22, gpu: {}, meta: { askId: 7 } }, {}), /VAST_CONFIG_ERROR/);
});

test('release treats 404 as success (idempotent)', async () => {
  const fetchImpl = fakeFetch([{ method: 'DELETE', match: (u) => u.includes('/instances/99'), status: 404, body: {} }]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  const r = await p.release({ id: 'vast:99', provider: 'vast', meta: { instanceId: 99 }, state: 'ready' });
  assert.equal(r.state, 'released');
});

test('capabilities: elastic + provisionable + ssh', () => {
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl: async () => ({}) });
  assert.deepEqual(p.capabilities, { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true });
});

test('vast waitReady({ readyFor: "ssh" }) succeeds without /models', async () => {
  const fetchImpl = fakeFetch([
    {
      method: 'GET',
      match: (u) => u.includes('/instances'),
      status: 200,
      body: {
        instances: [{
          id: 42,
          actual_status: 'running',
          ssh_host: '9.9.9.9',
          ssh_port: 22,
          ports: { '8000/tcp': [{ HostPort: '41000' }] },
        }],
      },
    },
    { method: 'GET', match: (u) => u.includes('/models'), status: 500, body: {} },
  ]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  const pending = { id: 'vast:42', provider: 'vast', state: 'pending', ssh: null, meta: { instanceId: 42 } };

  const sshReady = await p.waitReady(pending, { timeoutMs: 1000, readyFor: 'ssh' });
  assert.equal(sshReady.state, 'ready');
  assert.equal(sshReady.ssh && sshReady.ssh.host, '9.9.9.9');

  const service = await p.waitReady(pending, { timeoutMs: 20 });
  assert.equal(service.state, 'degraded');
  assert.equal(service.ssh, null);
});
