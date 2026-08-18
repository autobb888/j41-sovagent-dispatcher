'use strict';
const { runProviderContract } = require('./support/provider-contract');
const { VastProvider } = require('../src/providers/vast');

// Scripts a full happy-path lifecycle: bundles -> ask -> running instance -> delete.
function happyFetch() {
  let created = false;
  const j = (body) => ({ status: 200, ok: true, async json() { return body; }, async text() { return JSON.stringify(body); } });
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/bundles')) return j({ offers: [{ id: 5, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.2, rentable: true, rented: false }] });
    if (method === 'PUT' && url.includes('/asks/5')) { created = true; return j({ success: true, new_contract: 555 }); }
    if (method === 'GET' && url.includes('/v1/models')) return j({ data: [] });   // service-level readiness/probe
    if (method === 'GET' && url.includes('/instances')) return j({ instances: created ? [{ id: 555, actual_status: 'running', ssh_host: '1.2.3.4', ssh_port: 22, ports: { '8000/tcp': [{ HostPort: '41000' }] } }] : [] });
    if (method === 'DELETE' && url.includes('/instances/555')) return j({ success: true });
    throw new Error(`unexpected ${method} ${url}`);
  };
}

runProviderContract({
  name: 'vast',
  makeProvider: () => new VastProvider({ id: 'vast:c', api_key: 'k', fetchImpl: happyFetch(), minVramGb: 24, maxUsdPerHour: 1 }),
  spec: {},
});
