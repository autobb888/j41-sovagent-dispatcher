'use strict';
const { ComputeProvider } = require('./base');
const { scoreOffers } = require('./vast-offers');

// Vast.ai provider. All HTTP goes through an injectable fetch (llm-health.js idiom),
// so CI drives it with fixtures and never spends a dollar. Error mapping is load-
// bearing: 410 on create = offer evaporated (retry the SEARCH not the create),
// 429 = backoff, 400 = fatal config (bad/missing SSH key).
class VastProvider extends ComputeProvider {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.base = (cfg.base || 'https://cloud.vast.ai/api/v0').replace(/\/$/, '');
    this.fetchImpl = cfg.fetchImpl || globalThis.fetch;
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
      minVramGb: this.cfg.minVramGb, maxUsdPerHour: this.cfg.maxUsdPerHour, minGpuCount: this.cfg.minGpuCount, ...spec,
    });
  }

  async acquire(candidate) {
    const askId = candidate && candidate.meta && candidate.meta.askId;
    const res = await this._req('PUT', `/asks/${askId}/`, {
      price: candidate.usdPerHour, disk: 20, image: this.cfg.image || 'vllm/vllm-openai:latest',
    });
    if (res.status === 410) throw new Error('VAST_OFFER_GONE');
    if (res.status === 429) throw new Error('VAST_RATE_LIMITED');
    if (res.status === 400) throw new Error(`VAST_CONFIG_ERROR ${await res.text()}`);
    if (!res.ok) throw new Error(`VAST_ACQUIRE_FAILED status=${res.status}`);
    const data = await res.json();
    const instanceId = data.new_contract || data.instance_id;
    return {
      id: `vast:${instanceId}`, provider: 'vast', state: 'pending', baseUrl: null, ssh: null,
      gpu: candidate.gpu || null, usdPerHour: candidate.usdPerHour, acquiredAt: Date.now(), expiresAt: null,
      private: false, meta: { instanceId, askId },
    };
  }

  async _instance(instanceId) {
    const res = await this._req('GET', '/instances/');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.instances || []).find((i) => String(i.id) === String(instanceId)) || null;
  }

  async waitReady(lease, { timeoutMs = 300000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const inst = await this._instance(lease.meta.instanceId);
      if (inst && inst.actual_status === 'running' && inst.ssh_host) {
        const hostPort = inst.ports && inst.ports['8000/tcp'] && inst.ports['8000/tcp'][0] && inst.ports['8000/tcp'][0].HostPort;
        const baseUrl = this.cfg.public_url_for
          ? this.cfg.public_url_for(lease)
          : `http://${inst.ssh_host}:${hostPort || 8000}/v1`;
        return { ...lease, state: 'ready', baseUrl, ssh: { host: inst.ssh_host, port: inst.ssh_port, user: 'root' } };
      }
      if (Date.now() > deadline) return { ...lease, state: 'degraded' };
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async probe(lease) {
    const inst = await this._instance(lease.meta.instanceId);
    return { healthy: !!inst && inst.actual_status === 'running', reason: inst ? inst.actual_status : 'instance not found' };
  }

  async release(lease) {
    try {
      const res = await this._req('DELETE', `/instances/${lease.meta.instanceId}/`);
      if (res.status >= 500) throw new Error(`VAST_RELEASE_FAILED status=${res.status}`); // 404 = already gone
    } catch (e) {
      if (!/status=4\d\d/.test(e.message)) throw e; // network error — let caller retry
    }
    return { ...lease, state: 'released' };
  }

  describeCost(lease) { return { usdPerHour: Number(lease.usdPerHour) || 0, source: 'quoted' }; }

  get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; }
}
module.exports = { VastProvider };
