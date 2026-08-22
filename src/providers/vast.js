'use strict';
const { ComputeProvider } = require('./base');
const { scoreOffers } = require('./vast-offers');

// Vast.ai provider. All HTTP goes through an injectable fetch (llm-health.js idiom),
// so CI drives it with fixtures and never spends a dollar.
//
// Money-safety invariants (hardened after adversarial review):
//   - release() marks a lease released ONLY on 404/410/2xx. Any other status (401 from
//     a mis-keyed provider, 429, 5xx) THROWS so the caller keeps retrying — a box wrongly
//     marked released bills forever.
//   - Cat-1 rentals are on-demand: when interruptible=false, acquire() omits the bid
//     `price`, so the instance can't be reclaimed mid-hour.
//   - probe() is service-level (a running instance with a dead vLLM is NOT healthy).
class VastProvider extends ComputeProvider {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.base = (cfg.base || 'https://cloud.vast.ai/api/v0').replace(/\/$/, '');
    this.fetchImpl = cfg.fetchImpl || globalThis.fetch;
    // Config tables are snake_case ([compute.providers.*]); accept camelCase too.
    this.minVramGb = cfg.min_vram_gb ?? cfg.minVramGb;
    this.maxUsdPerHour = cfg.max_usd_per_hour ?? cfg.maxUsdPerHour;
    this.minGpuCount = cfg.min_gpu_count ?? cfg.minGpuCount;
    this.interruptible = cfg.interruptible !== undefined ? cfg.interruptible : true;
    this.image = cfg.image || 'vllm/vllm-openai:latest';
    this.diskGb = Number(cfg.disk_gb) || 40;
    this.onstart = cfg.onstart || null; // vLLM launch command (model arg etc.)
  }

  async _req(method, path, body) {
    return this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.api_key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async discover(spec = {}) {
    const res = await this._req('GET', '/bundles/');
    if (!res.ok) throw new Error(`VAST_DISCOVER_FAILED status=${res.status}`);
    const data = await res.json();
    return scoreOffers(data.offers || [], {
      minVramGb: this.minVramGb, maxUsdPerHour: this.maxUsdPerHour, minGpuCount: this.minGpuCount,
      interruptible: this.interruptible, ...spec,
    });
  }

  async acquire(candidate) {
    const askId = candidate && candidate.meta && candidate.meta.askId;
    const body = { disk: this.diskGb, image: this.image };
    if (this.onstart) body.onstart = this.onstart;
    // On-demand (interruptible=false) omits the bid price; a bid price makes the
    // instance interruptible and reclaimable — never for a Cat-1 rental.
    if (this.interruptible) body.price = candidate.usdPerHour;
    const res = await this._req('PUT', `/asks/${askId}/`, body);
    if (res.status === 410) throw new Error('VAST_OFFER_GONE');
    if (res.status === 429) throw new Error('VAST_RATE_LIMITED');
    if (res.status === 400) throw new Error(`VAST_CONFIG_ERROR ${await res.text()}`);
    if (!res.ok) throw new Error(`VAST_ACQUIRE_FAILED status=${res.status}`);
    const data = await res.json();
    const instanceId = data.new_contract || data.instance_id;
    return {
      id: `vast:${instanceId}`, provider: 'vast', state: 'pending', baseUrl: null, ssh: null,
      gpu: candidate.gpu || null, usdPerHour: candidate.usdPerHour, acquiredAt: Date.now(), expiresAt: null,
      private: false, meta: { instanceId, askId, interruptible: this.interruptible },
    };
  }

  async _instance(instanceId) {
    const res = await this._req('GET', '/instances/');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.instances || []).find((i) => String(i.id) === String(instanceId)) || null;
  }

  _baseUrlFor(inst, lease) {
    const hostPort = inst.ports && inst.ports['8000/tcp'] && inst.ports['8000/tcp'][0] && inst.ports['8000/tcp'][0].HostPort;
    return this.cfg.public_url_for ? this.cfg.public_url_for(lease) : `http://${inst.ssh_host}:${hostPort || 8000}/v1`;
  }

  async waitReady(lease, { timeoutMs = 300000, readyFor = 'service' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const inst = await this._instance(lease.meta.instanceId);
      if (inst && inst.actual_status === 'running' && inst.ssh_host) {
        const baseUrl = this._baseUrlFor(inst, lease);
        const ssh = { host: inst.ssh_host, port: inst.ssh_port, user: 'root' };
        // Cat-1 rental: SSH-ready only. Do not wait on vLLM /models.
        if (readyFor === 'ssh') {
          return { ...lease, state: 'ready', baseUrl, ssh };
        }
        // Cat-2 attach: the instance is up AND vLLM answers /models.
        if (await this._serviceUp(baseUrl)) {
          return { ...lease, state: 'ready', baseUrl, ssh };
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...lease, state: 'degraded' };
      await new Promise((r) => setTimeout(r, Math.min(5000, remaining)));
    }
  }

  async _serviceUp(baseUrl) {
    try { const res = await this.fetchImpl(baseUrl + '/models', { method: 'GET' }); return res.status === 200; }
    catch { return false; }
  }

  async probe(lease) {
    const inst = await this._instance(lease.meta.instanceId);
    if (!inst || inst.actual_status !== 'running') {
      return { healthy: false, reason: inst ? inst.actual_status : 'instance not found' };
    }
    // A running instance whose vLLM has crashed is NOT healthy — probe the endpoint.
    const base = lease.baseUrl || this._baseUrlFor(inst, lease);
    const up = await this._serviceUp(base);
    return { healthy: up, reason: up ? undefined : 'models endpoint not serving' };
  }

  async release(lease) {
    const res = await this._req('DELETE', `/instances/${lease.meta.instanceId}/`);
    // Idempotent success ONLY on already-gone (404/410) or a real 2xx. Any other
    // status — 401 (mis-keyed), 403, 429, 5xx — means the box may still be billing:
    // THROW so the reconcile/boot loop keeps the lease and retries. Network errors
    // from fetchImpl propagate for the same reason.
    if (res.status === 404 || res.status === 410 || (res.status >= 200 && res.status < 300)) {
      return { ...lease, state: 'released' };
    }
    throw new Error(`VAST_RELEASE_FAILED status=${res.status}`);
  }

  describeCost(lease) { return { usdPerHour: Number(lease.usdPerHour) || 0, source: 'quoted' }; }

  get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; }
}
module.exports = { VastProvider };
