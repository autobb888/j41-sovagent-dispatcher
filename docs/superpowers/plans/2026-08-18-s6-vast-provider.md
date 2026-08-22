# S6 — Vast.ai Compute Provider + Spend Ceiling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** A `vast` ComputeProvider that rents GPUs from Vast.ai and serves Cat-2 inference from them, under a hard USD/hour spend ceiling and a "never rent capacity you haven't already been paid for" credit gate, with replace-on-death — all with an injectable HTTP client so CI never makes a live call or spends a dollar.

**Architecture:** `vast-offers.js` is a **pure** scorer/filter (no network). `vast.js` implements the S5 `ComputeProvider` interface against Vast's REST API (`https://cloud.vast.ai/api/v0/`, bearer auth) via an injected `fetchImpl` (the `llm-health.js:10` idiom). `compute-supply` gains a **ceiling gate** (`acquireUnderCeiling`) that every paid acquire passes, and **replace-on-death** in `reconcileTick` for elastic providers. `local` (S5) is unaffected; both pass the same shared provider contract.

**Tech Stack:** Node CommonJS, `node:test`, `globalThis.fetch` (undici, injectable), no new deps.

**Spec:** `junction41/docs/superpowers/specs/2026-08-18-sovereign-supply-integration-design.md` §6.2 + roadmap `scratchpad/20260818gpucomputeproviders.md` §7. Builds on S5 (`docs/superpowers/plans/2026-08-18-s5-compute-provider-seam.md`).

## Global Constraints

- Same as S5: CommonJS, `node:test` + temp-HOME isolation, `node --check` clean, atomic persistence, `[compute] enabled=false` = no-op.
- **No live Vast calls in tests.** Every `vast.js` test injects a `fetchImpl` returning recorded-shape fixtures. A test that would hit the network is a plan failure.
- **Spend ceiling is non-negotiable.** `compute.max_usd_per_hour` is a hard gate checked before every paid `acquire()`. Default `0.0` ⇒ **no paid provisioning at all** (vast attach is a no-op until the operator sets a number). Committed USD/hour across held vast leases must also not exceed prepaid VRSC credit converted at the current rate — **never rent capacity not already paid for.**
- **Cat-1 must pin on-demand** (a rental that vanishes mid-hour is a refund + reputation hit). S6 serves Cat-2 only; the `interruptible` flag is plumbed so S7 can force on-demand.
- **Vast HTTP error semantics** (enforce in code): `410 Gone` on create = offer evaporated → **retry the search, not the create**; `429` → backoff; `400` (bad/missing SSH key) → **fatal config error**, do not retry.
- **`vast.js` never special-cases into shared code.** It satisfies the same contract `local` does.

## Vast API shapes (for fixtures)

- `GET /bundles/` (search offers) → `{ offers: [{ id, gpu_name, num_gpus, gpu_ram, dph_total, rentable, rented, cuda_max_good, geolocation, min_bid }] }`. `dph_total` = dollars/hour. `gpu_ram` = MB per GPU.
- `PUT /asks/{id}/` (create instance) → `{ success: true, new_contract: <instanceId> }`; 410 if gone.
- `GET /instances/` → `{ instances: [{ id, actual_status, ssh_host, ssh_port, ports, machine_id }] }`. `actual_status: 'running'|'loading'|'exited'`.
- `DELETE /instances/{id}/` → `{ success: true }`.

---

### Task 1: `vast-offers.js` — pure offer scoring/filter

**Files:** Create `src/providers/vast-offers.js`; Test `test/vast-offers.test.js`.

**Interfaces:**
- Produces: `scoreOffers(offers, spec)` → filtered+sorted `Candidate[]` (cheapest viable first). `spec = { minVramGb, maxUsdPerHour, minGpuCount, interruptible }`. Filters: `rentable && !rented`, `gpu_ram/1024 >= minVramGb`, `num_gpus >= minGpuCount`, `dph_total <= maxUsdPerHour`. Each candidate carries `{ provider:'vast', usdPerHour, gpu:{name,vramGb,count}, meta:{ askId, geolocation } }`. Sort ascending by `usdPerHour`.

- [ ] **Step 1: failing test**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreOffers } = require('../src/providers/vast-offers');

const OFFERS = [
  { id: 1, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.22, rentable: true, rented: false, geolocation: 'US' },
  { id: 2, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.35, rentable: true, rented: false, geolocation: 'DE' },
  { id: 3, gpu_name: 'A100', num_gpus: 1, gpu_ram: 81920, dph_total: 1.2, rentable: true, rented: true, geolocation: 'US' },   // rented → excluded
  { id: 4, gpu_name: 'GTX 1080', num_gpus: 1, gpu_ram: 8192, dph_total: 0.05, rentable: true, rented: false, geolocation: 'US' }, // too little VRAM
];

test('scoreOffers filters unrentable/rented/too-small and sorts cheapest-first', () => {
  const cands = scoreOffers(OFFERS, { minVramGb: 24, maxUsdPerHour: 0.5, minGpuCount: 1 });
  assert.equal(cands.length, 2);
  assert.equal(cands[0].meta.askId, 1);        // 0.22 cheapest
  assert.equal(cands[0].usdPerHour, 0.22);
  assert.equal(cands[0].gpu.vramGb, 24);
  assert.equal(cands[1].meta.askId, 2);        // 0.35
});

test('scoreOffers excludes offers over the ceiling', () => {
  const cands = scoreOffers(OFFERS, { minVramGb: 24, maxUsdPerHour: 0.30, minGpuCount: 1 });
  assert.deepEqual(cands.map((c) => c.meta.askId), [1]);
});

test('scoreOffers returns [] when nothing qualifies', () => {
  assert.deepEqual(scoreOffers(OFFERS, { minVramGb: 100, maxUsdPerHour: 5, minGpuCount: 1 }), []);
});
```
- [ ] **Step 2: run — FAIL (module missing).** `node --test test/vast-offers.test.js`
- [ ] **Step 3: implement**
```js
'use strict';
// Pure offer scoring/filtering for the Vast provider — no network, so it's unit-
// testable in isolation (the hardware-sizing.js precedent).
function scoreOffers(offers, spec = {}) {
  const minVramGb = Number(spec.minVramGb) || 0;
  const maxUsd = spec.maxUsdPerHour == null ? Infinity : Number(spec.maxUsdPerHour);
  const minGpu = Number(spec.minGpuCount) || 1;
  return (offers || [])
    .filter((o) => o && o.rentable && !o.rented)
    .filter((o) => (Number(o.gpu_ram) || 0) / 1024 >= minVramGb)
    .filter((o) => (Number(o.num_gpus) || 0) >= minGpu)
    .filter((o) => (Number(o.dph_total) || Infinity) <= maxUsd)
    .map((o) => ({
      provider: 'vast',
      usdPerHour: Number(o.dph_total),
      gpu: { name: o.gpu_name || null, vramGb: Math.round((Number(o.gpu_ram) || 0) / 1024), count: Number(o.num_gpus) || 1 },
      meta: { askId: o.id, geolocation: o.geolocation || null },
    }))
    .sort((a, b) => a.usdPerHour - b.usdPerHour);
}
module.exports = { scoreOffers };
```
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit** `feat(compute): vast-offers pure scorer/filter (S6 T1)`

---

### Task 2: `vast.js` — VastProvider against the REST API (injectable fetch)

**Files:** Create `src/providers/vast.js`; Modify `src/providers/index.js` (register `vast`); Test `test/providers-vast.test.js`.

**Interfaces:**
- Consumes: `ComputeProvider` (S5 T1), `scoreOffers` (T1). Config: `{ id, api_key, fetchImpl?, minVramGb, maxUsdPerHour, minGpuCount, interruptible, base:'https://cloud.vast.ai/api/v0' }`.
- Produces: `class VastProvider extends ComputeProvider`. `discover(spec)` → `GET /bundles/` → `scoreOffers`. `acquire(candidate)` → `PUT /asks/{askId}/` (throws `VAST_OFFER_GONE` on 410, `VAST_RATE_LIMITED` on 429, `VAST_CONFIG_ERROR` on 400). `waitReady(lease,{timeoutMs})` → poll `GET /instances/` until `actual_status==='running'`, set `baseUrl` from the instance port map. `probe` → instance status. `release` → `DELETE /instances/{id}/` (idempotent: a 404 is success). `describeCost` → `{usdPerHour, source:'quoted'}`. `capabilities` → `{canProvision:true, canSsh:true, canScaleToZero:false, isElastic:true}`.

- [ ] **Step 1: failing test** (fake fetch returns fixtures; asserts lifecycle + error mapping)
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VastProvider } = require('../src/providers/vast');

function fakeFetch(routes) {
  // routes: array of { method, match(url), status, body }
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
```
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** `src/providers/vast.js`:
```js
'use strict';
const { ComputeProvider } = require('./base');
const { scoreOffers } = require('./vast-offers');

class VastProvider extends ComputeProvider {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.base = (cfg.base || 'https://cloud.vast.ai/api/v0').replace(/\/$/, '');
    this.fetchImpl = cfg.fetchImpl || globalThis.fetch;
  }
  async _req(method, path, body) {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.api_key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
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
    const askId = candidate?.meta?.askId;
    // Cat-2 tolerates interruptible; Cat-1 (S7) forces on-demand via cfg.interruptible=false.
    const res = await this._req('PUT', `/asks/${askId}/`, { price: candidate.usdPerHour, disk: 20, image: this.cfg.image || 'vllm/vllm-openai:latest' });
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
  async waitReady(lease, { timeoutMs = 300000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const inst = await this._instance(lease.meta.instanceId);
      if (inst && inst.actual_status === 'running' && inst.ssh_host) {
        const port = (inst.ports && inst.ports['8000/tcp'] && inst.ports['8000/tcp'][0]?.HostPort) || 8000;
        const baseUrl = this.cfg.public_url_for ? this.cfg.public_url_for(lease) : `http://${inst.ssh_host}:${port}/v1`;
        return { ...lease, state: 'ready', baseUrl, ssh: { host: inst.ssh_host, port: inst.ssh_port, user: 'root' } };
      }
      if (Date.now() > deadline) return { ...lease, state: 'degraded' };
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  async _instance(instanceId) {
    const res = await this._req('GET', '/instances/');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.instances || []).find((i) => String(i.id) === String(instanceId)) || null;
  }
  async probe(lease) {
    const inst = await this._instance(lease.meta.instanceId);
    return { healthy: !!inst && inst.actual_status === 'running', reason: inst ? inst.actual_status : 'instance not found' };
  }
  async release(lease) {
    try {
      const res = await this._req('DELETE', `/instances/${lease.meta.instanceId}/`);
      // 404 = already gone; anything <500 or 404 counts as released (idempotent).
      if (res.status >= 500) throw new Error(`VAST_RELEASE_FAILED status=${res.status}`);
    } catch (e) {
      if (!/status=4\d\d/.test(e.message)) { /* network error — surface for retry by caller */ throw e; }
    }
    return { ...lease, state: 'released' };
  }
  describeCost(lease) { return { usdPerHour: Number(lease.usdPerHour) || 0, source: 'quoted' }; }
  get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; }
}
module.exports = { VastProvider };
```
Add to `src/providers/index.js` (after the local registration):
```js
const { VastProvider } = require('./vast');
registerProvider('vast', (cfg) => new VastProvider(cfg));
```
- [ ] **Step 4: run — PASS.** Also `node --check src/providers/vast.js`.
- [ ] **Step 5: commit** `feat(compute): VastProvider against Vast REST API, injectable fetch (S6 T2)`

---

### Task 3: `vast` passes the shared provider contract (fake fetch)

**Files:** Test `test/providers-vast-contract.test.js`.

**Interfaces:** Consumes `runProviderContract` (S5 T3). A fake fetch scripts a full happy-path lifecycle (bundles → ask → running instance → delete).

- [ ] **Step 1: failing test**
```js
'use strict';
const { runProviderContract } = require('./support/provider-contract');
const { VastProvider } = require('../src/providers/vast');

function happyFetch() {
  let created = false;
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const j = (body) => ({ status: 200, ok: true, async json() { return body; }, async text() { return JSON.stringify(body); } });
    if (method === 'GET' && url.includes('/bundles')) return j({ offers: [{ id: 5, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.2, rentable: true, rented: false }] });
    if (method === 'PUT' && url.includes('/asks/5')) { created = true; return j({ success: true, new_contract: 555 }); }
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
```
- [ ] **Step 2: run — FAIL** (until happyFetch scripts every call the contract makes). Adjust fixture until green.
- [ ] **Step 3:** No new source — the contract exercises `vast.js` from T2. If a contract assertion fails, fix `vast.js` (the interface is the source of truth).
- [ ] **Step 4: run — PASS** (3 contract tests for `vast`).
- [ ] **Step 5: commit** `test(compute): vast passes the shared provider contract (S6 T3)`

---

### Task 4: `[compute.providers.*] type='vast'` config + ceiling wiring

**Files:** Modify `docs/config.toml.example`; Test `test/compute-config.test.js` (extend).

**Interfaces:** A vast provider table: `{ type='vast', api_key, agent_id, min_vram_gb, max_usd_per_hour, min_gpu_count, interruptible }`. Passthrough already works (S5 deepMerge). No loader change needed beyond confirming the table survives.

- [ ] **Step 1: add a failing assertion** to `test/compute-config.test.js`:
```js
test('a [compute.providers.*] vast table is parsed through', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const TOML = require('@iarna/toml');
  const cfgPath = path.join(os.homedir(), '.j41', 'dispatcher', 'config.toml');
  fs.writeFileSync(cfgPath, TOML.stringify({ compute: { enabled: true, max_usd_per_hour: 0.5, providers: { cloud: { type: 'vast', api_key: 'k', agent_id: 'a1', min_vram_gb: 24 } } } }));
  const { loadDispatcherConfig } = require('../src/config-loader');
  const cfg = loadDispatcherConfig({ useCache: false });
  assert.equal(cfg.compute.providers.cloud.type, 'vast');
  assert.equal(cfg.compute.max_usd_per_hour, 0.5);
});
```
- [ ] **Step 2: run — PASS** (deepMerge already carries it; if HOME reuse from an earlier test in the file collides, give this its own temp HOME).
- [ ] **Step 3:** Append the vast example to `docs/config.toml.example` under the `[compute]` block:
```toml
# A rented cloud GPU (Vast.ai). max_usd_per_hour on [compute] is the HARD fleet
# ceiling; provisioning is OFF until it is > 0. api_key is your Vast bearer token.
# [compute.providers.cloud]
# type           = "vast"
# agent_id       = "your-agent-id"
# api_key        = "vast-xxxxxxxx"
# min_vram_gb    = 24
# min_gpu_count  = 1
# interruptible  = true          # Cat-2 tolerates it; Cat-1 (S7) forces false
```
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit** `feat(compute): vast provider config + docs (S6 T4)`

---

### Task 5: Spend ceiling — `acquireUnderCeiling` in compute-supply

**Files:** Modify `src/compute-supply.js`; Test `test/compute-ceiling.test.js`.

**Interfaces:**
- Produces: `acquireUnderCeiling(provider, candidate, { maxUsdPerHour, committedUsdPerHour })` — throws `CEILING_EXCEEDED` if `committedUsdPerHour + candidate.usdPerHour > maxUsdPerHour`, else `provider.acquire`. Exposed on the controller. `committedUsdPerHour()` sums `usdPerHour` of held non-released leases. A `maxUsdPerHour <= 0` blocks ALL paid acquires (candidate.usdPerHour > 0).

- [ ] **Step 1: failing test**
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-ceiling-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

const fakeProvider = { acquire: async (c) => ({ id: 'vast:1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, private: false, meta: {} }) };

test('acquireUnderCeiling rejects a candidate that would exceed max_usd_per_hour', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0.3, providers: {} } }, agentConfigs: new Map() });
  await assert.rejects(() => ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.5, gpu: {}, meta: {} }), /CEILING_EXCEEDED/);
});

test('max_usd_per_hour <= 0 blocks all paid provisioning', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0, providers: {} } }, agentConfigs: new Map() });
  await assert.rejects(() => ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.01, gpu: {}, meta: {} }), /CEILING_EXCEEDED/);
});

test('acquireUnderCeiling permits a candidate within the ceiling', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map() });
  const lease = await ctrl.acquireUnderCeiling(fakeProvider, { usdPerHour: 0.2, gpu: {}, meta: {} });
  assert.equal(lease.usdPerHour, 0.2);
});
```
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** — inside `createSupplyController`, add:
```js
  function committedUsdPerHour() {
    let sum = 0;
    for (const l of leases.values()) if (l.state !== 'released') sum += Number(l.usdPerHour) || 0;
    return sum;
  }
  async function acquireUnderCeiling(provider, candidate, opts = {}) {
    const max = opts.maxUsdPerHour != null ? Number(opts.maxUsdPerHour) : Number(compute.max_usd_per_hour) || 0;
    const committed = opts.committedUsdPerHour != null ? Number(opts.committedUsdPerHour) : committedUsdPerHour();
    const add = Number(candidate.usdPerHour) || 0;
    if (committed + add > max) throw new Error(`CEILING_EXCEEDED committed=${committed} add=${add} max=${max}`);
    return provider.acquire(candidate);
  }
```
and add `committedUsdPerHour, acquireUnderCeiling` to the returned object.
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit** `feat(compute): hard USD/hour spend ceiling on paid acquire (S6 T5)`

---

### Task 6: Replace-on-death for elastic providers in reconcile

**Files:** Modify `src/compute-supply.js`; Test `test/compute-replace.test.js`.

**Interfaces:**
- Change `reconcileTick`: when a bound lease's provider `capabilities.isElastic && capabilities.canProvision` and its probe reports dead (not merely degraded-and-recoverable — for elastic we treat a failed probe as death), attempt a replacement: `discover → acquireUnderCeiling → waitReady`, swap the lease, publish the new upstream. A `local` (non-elastic) lease keeps today's degrade-in-place behaviour (S5). Replacement failure leaves the lease `degraded` and unpublished.

- [ ] **Step 1: failing test** (a fake elastic provider whose probe fails, whose discover→acquire→waitReady yields a fresh ready lease)
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-replace-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

function deadThenFresh() {
  let n = 0;
  return {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async probe() { return { healthy: false }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.2, gpu: {}, meta: { askId: 1 } }]; },
    async acquire(c) { n += 1; return { id: `vast:new${n}`, provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, private: false, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', baseUrl: 'http://fresh/v1' }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
}

test('a dead elastic lease is replaced and the new upstream is published', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs });
  ctrl._injectBoundLease(
    { id: 'vast:old', provider: 'vast', state: 'ready', usdPerHour: 0.2, baseUrl: 'http://old/v1', private: false, meta: {} },
    deadThenFresh(), 'agent-1',
  );
  await ctrl.reconcileTick();
  const leases = ctrl.getLeases();
  assert.ok(leases.some((l) => l.id.startsWith('vast:new') && l.state === 'ready'), 'a fresh lease replaced the dead one');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, 'http://fresh/v1');
});
```
- [ ] **Step 2: run — FAIL** (`_injectBoundLease` and replace logic missing).
- [ ] **Step 3: implement** — add a test-support injector and the replace branch:
```js
  function _injectBoundLease(lease, provider, agentId) {
    leases.set(lease.id, lease); bound.set(lease.id, { provider, agentId });
  }
```
In `reconcileTick`, replace the `else unpublishUpstream(agentId)` branch with:
```js
      if (health.healthy) { publishUpstream(agentId, next); continue; }
      const caps = (b && b.provider && b.provider.capabilities) || {};
      if (caps.isElastic && caps.canProvision) {
        try {
          const cands = await b.provider.discover({});
          if (cands.length) {
            let fresh = await acquireUnderCeiling(b.provider, cands[0]);
            fresh = await b.provider.waitReady(fresh, { timeoutMs: 300000 });
            leases.delete(id);
            try { await b.provider.release(lease); } catch { /* best effort */ }
            leases.set(fresh.id, fresh);
            bound.set(fresh.id, b);
            bound.delete(id);
            if (fresh.state === 'ready') publishUpstream(agentId, fresh); else unpublishUpstream(agentId);
            continue;
          }
        } catch { /* fall through to degrade */ }
      }
      unpublishUpstream(agentId);
```
(The `leases.set(id, next)` before this must move to only the non-replaced paths; set `next` state=degraded only when not replaced. Restructure so a replaced lease does not also linger under the old id.)
Export `_injectBoundLease` on the controller.
- [ ] **Step 4: run — PASS.** Then full suite — local reconcile (S5) unchanged.
- [ ] **Step 5: commit** `feat(compute): replace-on-death for elastic providers (S6 T6)`

---

### Task 7: Attach vast leases (gated) + `ctl leases` shows cost + full suite

**Files:** Modify `src/compute-supply.js` (a `attachProviderLeases` that handles both local and, when `max_usd_per_hour>0` and a `desired` count is set, vast via `acquireUnderCeiling`); Test `test/compute-vast-attach.test.js`.

**Interfaces:**
- `attachLocalLeases` stays for local. Add `attachVastLeases()` — for each `type:'vast'` provider WITH `max_usd_per_hour>0`, discover→acquireUnderCeiling→waitReady the cheapest candidate, bind to `agent_id`, publish. With `max_usd_per_hour<=0`, it is a **no-op** (logs "vast provisioning off: set compute.max_usd_per_hour"). `maybeStartComputeSupply` calls both attach methods.

- [ ] **Step 1: failing test** — a vast provider config with a fake fetch (injected via a `__providerFactory` seam) provisions one lease when the ceiling allows, and none when `max_usd_per_hour=0`.
```js
// Inject a fake vast provider through createProvider by registering a throwaway type,
// OR pass cfg.providers.<name>.fetchImpl straight through to VastProvider (the vast
// constructor already reads cfg.fetchImpl). Use the latter — no registry hacks:
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-vattach-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');

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
});

test('vast attach provisions one lease under a positive ceiling', async () => {
  const agentConfigs = new Map();
  const ctrl = createSupplyController({ cfg: cfg(1), agentConfigs });
  await ctrl.attachVastLeases();
  const leases = ctrl.getLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].state, 'ready');
  assert.equal(agentConfigs.get('agent-1').endpointUrl, 'http://1.2.3.4:41000/v1');
});
```
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** `attachVastLeases()` in the controller (uses `createProvider('vast', { id:'vast:'+name, ...pcfg })` — pcfg carries `fetchImpl` in tests, real global fetch in prod; guards on `max_usd_per_hour>0`; discover→acquireUnderCeiling→waitReady→bind→publish). Call it from `maybeStartComputeSupply` after `attachLocalLeases`.
- [ ] **Step 4: run — PASS.** Then FULL suite `node --test test/*.test.js` — only the pre-existing SDK-link failures remain.
- [ ] **Step 5: commit** `feat(compute): gated vast attach under the spend ceiling (S6 T7)`

---

## Self-Review

**Spec coverage (roadmap §7 "Done when"):** Qwen-class model served from a rented Vast box → T2 (acquire+waitReady baseUrl) + T7 (attach+publish). Instance death detected + replaced within two ticks → T6. Ceiling provably blocks an over-budget rent (test not manual) → T5. Crash+restart reconciles orphaned instances → S5 `releaseOrphansOnBoot` already releases persisted vast leases (release() DELETEs the instance); the boot path calls it before attach. ✓
**Deferred (documented, not silently dropped):** per-lease named Cloudflare tunnel minting (T2 exposes `cfg.public_url_for` hook; default is the raw instance host:port — fine for testnet/dev, a follow-up for stable public URLs); live-key integration test (operator runs it with a real Vast token; CI uses fixtures); the "committed spend ≤ prepaid VRSC credit" second ceiling (T5 does the USD/hour ceiling; the credit-vs-commitment gate reads `credit-meter.getMetrics` and is a fast-follow — noted here so it is not assumed done).
**Placeholder scan:** none. **Type consistency:** `Candidate` (`{provider,usdPerHour,gpu,meta:{askId}}`) consistent T1→T2→T3; `Lease.meta.instanceId` set in T2 acquire, read in probe/release/waitReady; `acquireUnderCeiling` signature consistent T5→T6→T7.
