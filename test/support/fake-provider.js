'use strict';
const { ComputeProvider } = require('../../src/providers/base');

// A spend-nothing, in-memory provider used by the shared contract suite and by
// compute-supply tests. Every method is a pure state flip; no network, no cost.
class FakeProvider extends ComputeProvider {
  constructor(cfg = {}) { super(); this.cfg = cfg; this._ready = true; this._released = 0; }
  async discover() { return [{ provider: 'fake', meta: {} }]; }
  async acquire() {
    return { id: this.cfg.id || 'fake:1', provider: 'fake', state: 'pending',
      baseUrl: 'http://fake.local/v1', ssh: null, gpu: null, usdPerHour: 0,
      acquiredAt: 0, expiresAt: null, private: false, meta: {} };
  }
  async waitReady(lease) { return { ...lease, state: 'ready' }; }
  async probe() { return { healthy: this._ready }; }
  async release(lease) { this._released++; return { ...lease, state: 'released' }; }
  describeCost() { return { usdPerHour: 0, source: 'declared' }; }
  get capabilities() { return { canProvision: true, canSsh: false, canScaleToZero: true, isElastic: true }; }
}
module.exports = { FakeProvider };
