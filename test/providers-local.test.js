'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { LocalProvider } = require('../src/providers/local');
const { runProviderContract } = require('./support/provider-contract');

// A stub vLLM that answers GET /v1/models with 200. Caller closes it.
function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); }
      else { res.writeHead(404); res.end(); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('local: capabilities are all false (BYO box)', () => {
  const p = new LocalProvider({ id: 'local:x', base_url: 'http://127.0.0.1:1/v1', usd_per_hour: 0.08 });
  assert.deepEqual(p.capabilities, { canProvision: false, canSsh: false, canScaleToZero: false, isElastic: false });
});

test('local: waitReady resolves when /v1/models answers 200; describeCost is declared', async () => {
  const { srv, port } = await startStub();
  try {
    const p = new LocalProvider({ id: 'local:x', base_url: `http://127.0.0.1:${port}/v1`, usd_per_hour: 0.08, allow_private_upstream: true });
    let lease = await p.acquire((await p.discover())[0], {});
    lease = await p.waitReady(lease, { timeoutMs: 2000 });
    assert.equal(lease.state, 'ready');
    assert.equal(lease.baseUrl, `http://127.0.0.1:${port}/v1`);
    assert.equal(lease.private, true);
    assert.deepEqual(p.describeCost(lease), { usdPerHour: 0.08, source: 'declared' });
    assert.equal((await p.probe(lease)).healthy, true);
  } finally { srv.close(); }
});

test('local: probe reports unhealthy when the box is down', async () => {
  const p = new LocalProvider({ id: 'local:x', base_url: 'http://127.0.0.1:1/v1', usd_per_hour: 0.08 });
  const lease = await p.acquire((await p.discover())[0], {});
  assert.equal((await p.probe(lease)).healthy, false);
});

// Reuse the shared contract against a live stub. unref so the process still exits.
const stubReady = new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200); res.end('{"data":[]}'); }
    else { res.writeHead(404); res.end(); }
  });
  srv.listen(0, '127.0.0.1', () => { srv.unref(); resolve({ port: srv.address().port }); });
});

runProviderContract({
  name: 'local',
  makeProvider: () => new LocalProvider({ id: 'local:c', base_url: 'http://127.0.0.1:0/v1', usd_per_hour: 0.05, allow_private_upstream: true, __stubReady: stubReady }),
  spec: {},
});
