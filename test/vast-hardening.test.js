'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VastProvider } = require('../src/providers/vast');

function recordingFetch(routes, log) {
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (log) log.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    const r = routes.find((x) => x.method === method && x.match(url));
    if (!r) throw new Error(`no fake route for ${method} ${url}`);
    return { status: r.status, ok: r.status < 400, async json() { return r.body || {}; }, async text() { return JSON.stringify(r.body || {}); } };
  };
}

// H1 — snake_case config keys must drive the offer filter.
test('H1: snake_case min_vram_gb / max_usd_per_hour / min_gpu_count filter offers', async () => {
  const fetchImpl = recordingFetch([
    { method: 'GET', match: (u) => u.includes('/bundles'), status: 200, body: { offers: [
      { id: 1, gpu_name: 'GTX1080', num_gpus: 1, gpu_ram: 8192, dph_total: 0.05, rentable: true, rented: false },  // too little VRAM
      { id: 2, gpu_name: 'A100', num_gpus: 1, gpu_ram: 81920, dph_total: 0.9, rentable: true, rented: false },      // over price
      { id: 3, gpu_name: 'RTX3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.22, rentable: true, rented: false },  // ok
    ] } },
  ]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl, min_vram_gb: 24, max_usd_per_hour: 0.5, min_gpu_count: 1 });
  const cands = await p.discover({});
  assert.deepEqual(cands.map((c) => c.meta.askId), [3], 'only the 24GB, sub-$0.50 offer survives');
});

// C5 — on-demand (interruptible:false) must NOT send a bid price on create.
test('C5: interruptible:false creates on-demand (no bid price in the PUT body)', async () => {
  const log = [];
  const fetchImpl = recordingFetch([{ method: 'PUT', match: (u) => u.includes('/asks/7'), status: 200, body: { success: true, new_contract: 1 } }], log);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl, interruptible: false });
  const lease = await p.acquire({ provider: 'vast', usdPerHour: 0.22, gpu: {}, meta: { askId: 7 } });
  const put = log.find((l) => l.method === 'PUT');
  assert.equal(put.body.price, undefined, 'on-demand create must not carry a bid price');
  assert.equal(lease.meta.interruptible, false);
});

test('C5: candidate.meta.interruptible false omits bid price even when cfg.interruptible is true', async () => {
  const log = [];
  const fetchImpl = recordingFetch([{ method: 'PUT', match: (u) => u.includes('/asks/7'), status: 200, body: { success: true, new_contract: 1 } }], log);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl }); // default interruptible true
  const lease = await p.acquire({ provider: 'vast', usdPerHour: 0.22, gpu: {}, meta: { askId: 7, interruptible: false } }, { jobId: 'job-1' });
  const put = log.find((l) => l.method === 'PUT');
  assert.equal(put.body.price, undefined, 'rental acquire must not bid');
  assert.equal(lease.meta.interruptible, false);
  assert.ok(lease.meta.sshPrivateKey);
  assert.match(put.body.onstart, /ssh-ed25519 /);
});

test('C5: interruptible:true does send a bid price', async () => {
  const log = [];
  const fetchImpl = recordingFetch([{ method: 'PUT', match: (u) => u.includes('/asks/7'), status: 200, body: { success: true, new_contract: 1 } }], log);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl, interruptible: true });
  await p.acquire({ provider: 'vast', usdPerHour: 0.22, gpu: {}, meta: { askId: 7 } });
  assert.equal(log.find((l) => l.method === 'PUT').body.price, 0.22);
});

// C1/C2 — release() must NOT treat auth/rate-limit failures as "gone".
test('C1/C2: release throws on 401 (never silently marks a billing box released)', async () => {
  const fetchImpl = recordingFetch([{ method: 'DELETE', match: (u) => u.includes('/instances/9'), status: 401, body: {} }]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  await assert.rejects(() => p.release({ id: 'vast:9', provider: 'vast', meta: { instanceId: 9 }, state: 'ready' }), /VAST_RELEASE_FAILED/);
});

test('C1/C2: release throws on 429 too', async () => {
  const fetchImpl = recordingFetch([{ method: 'DELETE', match: (u) => u.includes('/instances/9'), status: 429, body: {} }]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  await assert.rejects(() => p.release({ id: 'vast:9', provider: 'vast', meta: { instanceId: 9 }, state: 'ready' }), /VAST_RELEASE_FAILED/);
});

test('release still treats 404/410 as idempotent success', async () => {
  for (const status of [404, 410, 200]) {
    const fetchImpl = recordingFetch([{ method: 'DELETE', match: (u) => u.includes('/instances/9'), status, body: {} }]);
    const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
    const r = await p.release({ id: 'vast:9', provider: 'vast', meta: { instanceId: 9 }, state: 'ready' });
    assert.equal(r.state, 'released', `status ${status} is idempotent success`);
  }
});

// M2 — a running instance with a dead vLLM must probe unhealthy.
test('M2: probe is service-level — running instance but /models down = unhealthy', async () => {
  const fetchImpl = recordingFetch([
    { method: 'GET', match: (u) => u.includes('/instances'), status: 200, body: { instances: [{ id: 5, actual_status: 'running', ssh_host: '1.2.3.4', ssh_port: 22, ports: { '8000/tcp': [{ HostPort: '41000' }] } }] } },
    { method: 'GET', match: (u) => u.includes(':41000/v1/models') || u.includes('/v1/models'), status: 503, body: {} },
  ]);
  const p = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  const health = await p.probe({ id: 'vast:5', provider: 'vast', meta: { instanceId: 5 }, baseUrl: 'http://1.2.3.4:41000/v1' });
  assert.equal(health.healthy, false, 'instance running but vLLM 503 => unhealthy');
});
