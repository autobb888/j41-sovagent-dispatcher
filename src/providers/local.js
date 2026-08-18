'use strict';
const http = require('http');
const https = require('https');
const { ComputeProvider } = require('./base');

// GET a URL and resolve its status code (0 on any error/timeout). Body is drained.
function getStatus(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let lib;
    try { lib = url.startsWith('https:') ? https : http; } catch { return finish(0); }
    let req;
    try { req = lib.get(url, (res) => { res.resume(); finish(res.statusCode); }); }
    catch { return finish(0); }
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(0); });
    req.on('error', () => finish(0));
  });
}

// A GPU the operator already owns. No marketplace, no provisioning, no destroy —
// acquire/release are pure state flips. Every triviality here is a design check that
// the ComputeProvider interface does not secretly assume a cloud (spec §6.2 / plan T4).
class LocalProvider extends ComputeProvider {
  constructor(cfg = {}) { super(); this.cfg = cfg; }

  // Test-only shim: when cfg.__stubReady (a Promise<{port}>) is present, target a
  // local stub server instead of the declared box, so the shared contract suite can
  // exercise waitReady/probe without a real GPU. Never set in production config.
  async _baseUrl() {
    if (this.cfg.__stubReady) {
      const { port } = await this.cfg.__stubReady;
      const u = new URL(this.cfg.base_url);
      u.hostname = '127.0.0.1'; u.port = String(port);
      return u.toString().replace(/\/$/, '');
    }
    return this.cfg.base_url;
  }

  async discover() {
    return [{ provider: 'local', meta: { id: this.cfg.id, base_url: this.cfg.base_url } }];
  }

  async acquire() {
    return {
      id: this.cfg.id, provider: 'local', state: 'pending', baseUrl: null, ssh: null,
      gpu: { name: this.cfg.gpu || null, vramGb: this.cfg.vram_gb || null, count: this.cfg.gpu_count || 1 },
      usdPerHour: Number(this.cfg.usd_per_hour) || 0, acquiredAt: Date.now(), expiresAt: null,
      private: !!this.cfg.allow_private_upstream, meta: {},
    };
  }

  async waitReady(lease, { timeoutMs = 60000 } = {}) {
    const base = await this._baseUrl();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await getStatus(base + '/models', 3000);
      if (status === 200) return { ...lease, state: 'ready', baseUrl: base };
      if (Date.now() > deadline) return { ...lease, state: 'degraded', baseUrl: base };
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async probe(lease) {
    const base = lease.baseUrl || (await this._baseUrl());
    const status = await getStatus(base + '/models', 3000);
    return { healthy: status === 200, reason: status === 200 ? undefined : `models endpoint returned ${status}` };
  }

  async release(lease) { return { ...lease, state: 'released' }; } // no destroy; idempotent

  describeCost(lease) { return { usdPerHour: Number(lease.usdPerHour) || 0, source: 'declared' }; }

  get capabilities() { return { canProvision: false, canSsh: false, canScaleToZero: false, isElastic: false }; }
}
module.exports = { LocalProvider };
