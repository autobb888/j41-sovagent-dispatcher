# S5 — Compute-Provider Seam + Local Listings + Live Upstream — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a compute-provider abstraction (`ComputeProvider` + registry + `local` provider), a `compute-supply` controller that owns lease lifecycle and can mutate the proxy's upstream at runtime, and a per-lease private-upstream allowance — all behind `[compute] enabled=false` so default behaviour is byte-for-byte unchanged.

**Architecture:** A new `src/providers/` directory owning the lease lifecycle behind one interface with **lease semantics** (acquire the right to direct traffic at capacity for a bounded period). A new `src/compute-supply.js` owning desired-vs-actual lease state and publishing upstream changes into the **existing** `agentConfigs` Map that `handleProxyRequest` already reads per-request (`proxy-handler.js:254`, `cli.js:4058`). No money moves; no external API is called; `local` is the only provider (S6 adds `vast`).

**Tech Stack:** Node.js CommonJS (`'use strict'`, `require`/`module.exports`), `node:test` + `node:assert/strict` runner, `@iarna/toml` config, no new dependencies.

**Spec:** `junction41/docs/superpowers/specs/2026-08-18-sovereign-supply-integration-design.md` (§6.2) + the folded roadmap `scratchpad/20260818gpucomputeproviders.md` (§4, §6). This plan is 2.32.0 of that roadmap, re-based onto dispatcher `main@99ba724` (the roadmap's `f6651cb`/`cli.js:4436` line refs are stale; use the refs in this plan).

## Global Constraints

- **CommonJS only.** `'use strict';` at top; `require(...)`; `module.exports = {...}`. No ESM `import`.
- **Test runner:** `node --test test/*.test.js`. Tests use `require('node:test')` + `require('node:assert/strict')`. For any test that touches `~/.j41`, isolate HOME first: `const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(),'j41-...')); process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;` **before** requiring the module under test (idiom from `test/atomic-ledger-writes.test.js:13-17`).
- **`node --check` must pass** on every new/edited `src/*.js` (`package.json` test script runs it first).
- **Persistence idiom:** anything written under `~/.j41/dispatcher/` uses `tmp→rename` (`config.js:66-68`): `fs.writeFileSync(p+'.tmp', ...); fs.renameSync(p+'.tmp', p);`.
- **`[compute] enabled=false` ⇒ byte-for-byte current behaviour.** This is the rollback switch and is tested as such (Task 10). No compute code runs, `agentConfigs` is untouched, when disabled.
- **No provider special-casing in shared code.** Callers branch on `provider.capabilities.*`, never on `provider === 'local'`.
- **No money path.** S5 calls no external API and moves no VRSC; do NOT touch `spend-policy.js`.
- **Lease object shape (canonical, used across all tasks):**
  ```js
  {
    id:'local:workshop', provider:'local', state:'pending'|'ready'|'degraded'|'released',
    baseUrl:'http://192.168.1.50:8000/v1', ssh:null,
    gpu:{name:'RTX 4090',vramGb:24,count:1}, usdPerHour:0.08,
    acquiredAt:1755500000000, expiresAt:null, private:true, meta:{}
  }
  ```

---

### Task 1: `ComputeProvider` base + typedefs

**Files:**
- Create: `src/providers/base.js`
- Test: `test/providers-base.test.js`

**Interfaces:**
- Produces: `class ComputeProvider` with async methods `discover(spec)`, `acquire(candidate,spec)`, `waitReady(lease,{timeoutMs})`, `probe(lease)`, `release(lease)`, sync `describeCost(lease)`, and a getter `capabilities`. Base implementations all throw `Error('not implemented')`. JSDoc typedefs `Lease`, `Candidate`, `HealthReport`.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ComputeProvider } = require('../src/providers/base');

test('base ComputeProvider throws not-implemented for every method', async () => {
  const p = new ComputeProvider();
  await assert.rejects(() => p.discover({}), /not implemented/);
  await assert.rejects(() => p.acquire({}, {}), /not implemented/);
  await assert.rejects(() => p.waitReady({}, { timeoutMs: 1 }), /not implemented/);
  await assert.rejects(() => p.probe({}), /not implemented/);
  await assert.rejects(() => p.release({}), /not implemented/);
  assert.throws(() => p.describeCost({}), /not implemented/);
  assert.throws(() => p.capabilities, /not implemented/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-base.test.js`
Expected: FAIL — cannot find module `../src/providers/base`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
/**
 * @typedef {Object} Lease
 * @property {string} id  @property {string} provider
 * @property {'pending'|'ready'|'degraded'|'released'} state
 * @property {string|null} baseUrl  @property {{host:string,port:number,user:string}|null} ssh
 * @property {{name:string,vramGb:number,count:number}|null} gpu
 * @property {number} usdPerHour  @property {number} acquiredAt  @property {number|null} expiresAt
 * @property {boolean} private  @property {Object} meta
 *
 * @typedef {Object} Candidate @property {string} provider @property {Object} meta
 * @typedef {Object} HealthReport @property {boolean} healthy @property {string} [reason]
 */
class ComputeProvider {
  /** @returns {Promise<Candidate[]>} */
  async discover(_spec) { throw new Error('not implemented'); }
  /** @returns {Promise<Lease>} */
  async acquire(_candidate, _spec) { throw new Error('not implemented'); }
  /** @returns {Promise<Lease>} */
  async waitReady(_lease, _opts) { throw new Error('not implemented'); }
  /** @returns {Promise<HealthReport>} */
  async probe(_lease) { throw new Error('not implemented'); }
  /** MUST be idempotent — called from crash recovery. @returns {Promise<Lease>} */
  async release(_lease) { throw new Error('not implemented'); }
  /** @returns {{usdPerHour:number,source:'quoted'|'declared'}} */
  describeCost(_lease) { throw new Error('not implemented'); }
  /** @returns {{canProvision:boolean,canSsh:boolean,canScaleToZero:boolean,isElastic:boolean}} */
  get capabilities() { throw new Error('not implemented'); }
}
module.exports = { ComputeProvider };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-base.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/base.js test/providers-base.test.js
git commit -m "feat(compute): ComputeProvider base interface + lease typedefs (S5 T1)"
```

---

### Task 2: Provider registry + FakeProvider test double

**Files:**
- Create: `src/providers/index.js`
- Create: `test/support/fake-provider.js`
- Test: `test/providers-registry.test.js`

**Interfaces:**
- Consumes: `ComputeProvider` from Task 1.
- Produces: `registerProvider(type, factory)`, `createProvider(type, cfg)` (throws `unknown compute provider: <type>` on miss), `listProviderTypes()`. `FakeProvider` — a spend-nothing in-memory provider used by the contract suite and later tasks.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerProvider, createProvider, listProviderTypes } = require('../src/providers');
const { FakeProvider } = require('./support/fake-provider');

test('registry creates a registered provider and rejects unknown types', () => {
  registerProvider('fake', (cfg) => new FakeProvider(cfg));
  const p = createProvider('fake', { id: 'fake:1' });
  assert.equal(p.constructor.name, 'FakeProvider');
  assert.ok(listProviderTypes().includes('fake'));
  assert.throws(() => createProvider('nope', {}), /unknown compute provider: nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-registry.test.js`
Expected: FAIL — cannot find module `../src/providers`.

- [ ] **Step 3: Write minimal implementation**

`test/support/fake-provider.js`:
```js
'use strict';
const { ComputeProvider } = require('../../src/providers/base');
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
```

`src/providers/index.js`:
```js
'use strict';
const registry = new Map();
function registerProvider(type, factory) { registry.set(type, factory); }
function createProvider(type, cfg) {
  const f = registry.get(type);
  if (!f) throw new Error(`unknown compute provider: ${type}`);
  return f(cfg);
}
function listProviderTypes() { return [...registry.keys()]; }
// Built-in providers register themselves on require (local added in Task 4).
module.exports = { registerProvider, createProvider, listProviderTypes };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-registry.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/index.js test/support/fake-provider.js test/providers-registry.test.js
git commit -m "feat(compute): provider registry + FakeProvider double (S5 T2)"
```

---

### Task 3: Shared provider-contract suite

**Files:**
- Create: `test/support/provider-contract.js` (exports `runProviderContract`)
- Test: `test/provider-contract.test.js` (runs the suite against `FakeProvider`)

**Interfaces:**
- Consumes: a `makeProvider()` factory + an optional `spec`.
- Produces: `runProviderContract({ name, makeProvider, spec })` — registers a `node:test` `describe`/`test` block asserting the lease lifecycle contract. Task 4 reuses it for `local`; S6 reuses it for `vast`.

- [ ] **Step 1: Write the failing test**

`test/provider-contract.test.js`:
```js
'use strict';
const { runProviderContract } = require('./support/provider-contract');
const { FakeProvider } = require('./support/fake-provider');
runProviderContract({ name: 'fake', makeProvider: () => new FakeProvider({ id: 'fake:1' }), spec: {} });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/provider-contract.test.js`
Expected: FAIL — cannot find module `./support/provider-contract`.

- [ ] **Step 3: Write minimal implementation**

`test/support/provider-contract.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function runProviderContract({ name, makeProvider, spec = {} }) {
  test(`[contract:${name}] discover→acquire→waitReady→probe→release`, async () => {
    const p = makeProvider();
    const cands = await p.discover(spec);
    assert.ok(Array.isArray(cands) && cands.length >= 1, 'discover returns >=1 candidate');

    let lease = await p.acquire(cands[0], spec);
    assert.equal(typeof lease.id, 'string');
    assert.equal(lease.provider, name === 'fake' ? 'fake' : lease.provider);
    assert.ok(['pending', 'ready'].includes(lease.state));

    lease = await p.waitReady(lease, { timeoutMs: 2000 });
    assert.equal(lease.state, 'ready', 'waitReady yields state=ready');
    assert.ok(lease.baseUrl, 'waitReady populates baseUrl');

    const health = await p.probe(lease);
    assert.equal(typeof health.healthy, 'boolean');

    const cost = p.describeCost(lease);
    assert.equal(typeof cost.usdPerHour, 'number');
    assert.ok(['quoted', 'declared'].includes(cost.source));
  });

  test(`[contract:${name}] release is idempotent`, async () => {
    const p = makeProvider();
    const lease = await p.acquire((await p.discover(spec))[0], spec);
    const r1 = await p.release(lease);
    assert.equal(r1.state, 'released');
    const r2 = await p.release(r1); // second call must not throw
    assert.equal(r2.state, 'released');
  });

  test(`[contract:${name}] capabilities shape`, () => {
    const caps = makeProvider().capabilities;
    for (const k of ['canProvision', 'canSsh', 'canScaleToZero', 'isElastic']) {
      assert.equal(typeof caps[k], 'boolean', `capabilities.${k} is boolean`);
    }
  });
}
module.exports = { runProviderContract };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/provider-contract.test.js`
Expected: PASS (3 contract tests against FakeProvider).

- [ ] **Step 5: Commit**

```bash
git add test/support/provider-contract.js test/provider-contract.test.js
git commit -m "test(compute): shared provider-contract suite (S5 T3)"
```

---

### Task 4: `local` provider (BYO hardware)

**Files:**
- Create: `src/providers/local.js`
- Modify: `src/providers/index.js` (self-register `local`)
- Test: `test/providers-local.test.js`

**Interfaces:**
- Consumes: `ComputeProvider` (T1), `registerProvider` (T2), `runProviderContract` (T3).
- Produces: `class LocalProvider extends ComputeProvider`. Config shape: `{ id, base_url, usd_per_hour, gpu, vram_gb, gpu_count, allow_private_upstream }`. `waitReady` polls `GET {base_url}/v1/models` until 200 or timeout. `probe` does the same healthcheck. `acquire`/`release` are in-memory state flips (no network, no destroy). `capabilities = {canProvision:false, canSsh:false, canScaleToZero:false, isElastic:false}`.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { LocalProvider } = require('../src/providers/local');
const { runProviderContract } = require('./support/provider-contract');

// A stub vLLM that answers GET /v1/models with 200.
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

// Reuse the shared contract against a live stub.
const stubReady = startStub();
runProviderContract({
  name: 'local',
  makeProvider: () => {
    // stubReady is resolved synchronously-enough for the sync contract calls that
    // don't hit the network; waitReady/probe await the shared promise's port.
    return new LocalProvider({ id: 'local:c', base_url: 'http://127.0.0.1:0/v1', usd_per_hour: 0.05, __stubReady: stubReady });
  },
  spec: {},
});
```

> Note: the contract's `waitReady`/`probe` need a live endpoint. Implement `LocalProvider` so that when `cfg.__stubReady` (a Promise resolving `{port}`) is present, `waitReady`/`probe` rewrite `base_url`'s port to the stub's before probing. This keeps the shared contract usable without a real GPU. (Test-only shim; documented in code.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers-local.test.js`
Expected: FAIL — cannot find module `../src/providers/local`.

- [ ] **Step 3: Write minimal implementation**

`src/providers/local.js`:
```js
'use strict';
const http = require('http');
const https = require('https');
const { ComputeProvider } = require('./base');

function getStatus(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => { res.resume(); finish(res.statusCode); });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(0); });
    req.on('error', () => finish(0));
  });
}

class LocalProvider extends ComputeProvider {
  constructor(cfg = {}) { super(); this.cfg = cfg; }
  async _baseUrl() {
    if (this.cfg.__stubReady) { const { port } = await this.cfg.__stubReady; const u = new URL(this.cfg.base_url); u.port = String(port); u.hostname = '127.0.0.1'; return u.toString().replace(/\/$/, ''); }
    return this.cfg.base_url;
  }
  async discover() {
    return [{ provider: 'local', meta: { id: this.cfg.id, base_url: this.cfg.base_url } }];
  }
  async acquire() {
    return { id: this.cfg.id, provider: 'local', state: 'pending', baseUrl: null, ssh: null,
      gpu: { name: this.cfg.gpu || null, vramGb: this.cfg.vram_gb || null, count: this.cfg.gpu_count || 1 },
      usdPerHour: Number(this.cfg.usd_per_hour) || 0, acquiredAt: Date.now(), expiresAt: null,
      private: !!this.cfg.allow_private_upstream, meta: {} };
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
```

Add to `src/providers/index.js` (bottom, before `module.exports`):
```js
const { LocalProvider } = require('./local');
registerProvider('local', (cfg) => new LocalProvider(cfg));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers-local.test.js`
Expected: PASS (unit tests + the 3 shared-contract tests for `local`).

- [ ] **Step 5: Commit**

```bash
git add src/providers/local.js src/providers/index.js test/providers-local.test.js
git commit -m "feat(compute): local BYO-hardware provider, passes shared contract (S5 T4)"
```

---

### Task 5: `[compute]` config schema

**Files:**
- Modify: `src/config-loader.js` (DEFAULTS + ENV_OVERRIDES)
- Test: `test/compute-config.test.js`

**Interfaces:**
- Produces: `cfg.compute = { enabled:false, default_provider:'local', reconcile_ms:60000, max_usd_per_hour:0 }` by default, plus `cfg.compute.providers` = a passthrough map of `[compute.providers.<name>]` tables from the TOML. ENV overrides: `J41_COMPUTE_ENABLED` (bool), `J41_COMPUTE_MAX_USD_PER_HOUR` (float), `J41_COMPUTE_RECONCILE_MS` (int).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TOML = require('@iarna/toml');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-compute-cfg-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });
const cfgPath = path.join(TEST_HOME, '.j41', 'dispatcher', 'config.toml');

const { loadDispatcherConfig } = require('../src/config-loader');

test('compute defaults are present and disabled', () => {
  fs.writeFileSync(cfgPath, '');
  const cfg = loadDispatcherConfig();
  assert.equal(cfg.compute.enabled, false);
  assert.equal(cfg.compute.default_provider, 'local');
  assert.equal(cfg.compute.max_usd_per_hour, 0);
  assert.deepEqual(cfg.compute.providers, {});
});

test('a [compute.providers.*] table is parsed through', () => {
  fs.writeFileSync(cfgPath, TOML.stringify({
    compute: { enabled: true, providers: { workshop: { type: 'local', base_url: 'http://192.168.1.50:8000/v1', usd_per_hour: 0.08, allow_private_upstream: true } } },
  }));
  const cfg = loadDispatcherConfig();
  assert.equal(cfg.compute.enabled, true);
  assert.equal(cfg.compute.providers.workshop.type, 'local');
  assert.equal(cfg.compute.providers.workshop.allow_private_upstream, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/compute-config.test.js`
Expected: FAIL — `cfg.compute` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/config-loader.js` `DEFAULTS` (after the `budget` block), add:
```js
  // S5 — compute-provider seam. enabled=false ⇒ byte-for-byte current behaviour.
  // `providers` is a passthrough map of [compute.providers.<name>] tables, validated
  // by compute-supply (not here), so operators can add providers without a code change.
  compute: { enabled: false, default_provider: 'local', reconcile_ms: 60000, max_usd_per_hour: 0, providers: {} },
```
Find where DEFAULTS is deep-merged with the parsed TOML in `loadDispatcherConfig`. The merge must **preserve unknown keys under `compute.providers`** (they are dynamic). If the existing merge already spreads parsed sections over defaults (it does for `provider_keys`), `compute.providers` passes through the same way. Add a guard after the merge so the field is always an object:
```js
  if (!merged.compute || typeof merged.compute !== 'object') merged.compute = { ...DEFAULTS.compute };
  if (!merged.compute.providers || typeof merged.compute.providers !== 'object') merged.compute.providers = {};
```
Add ENV_OVERRIDES rows:
```js
  ['J41_COMPUTE_ENABLED',          'compute.enabled',          'bool'],
  ['J41_COMPUTE_MAX_USD_PER_HOUR', 'compute.max_usd_per_hour', 'float'],
  ['J41_COMPUTE_RECONCILE_MS',     'compute.reconcile_ms',     'int'],
```
(If the override applier lacks a `'bool'` kind, add one mirroring the existing `'int'`/`'float'` handling: `v === 'true' || v === '1'`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/compute-config.test.js`
Expected: PASS. Also run `node --test test/*.test.js` to confirm no existing config test regressed.

- [ ] **Step 5: Commit**

```bash
git add src/config-loader.js test/compute-config.test.js
git commit -m "feat(compute): [compute] + [compute.providers.*] config schema (S5 T5)"
```

---

### Task 6: Lease persistence (`leases.json`, atomic)

**Files:**
- Modify: `src/config.js` (add `LEASES_PATH`, `persistLeases`, `loadLeases`)
- Test: `test/leases-persistence.test.js`

**Interfaces:**
- Consumes: the `DISPATCHER_DIR` + tmp→rename idiom already in `config.js`.
- Produces: `LEASES_PATH`; `persistLeases(map)` where `map` is a `Map<leaseId,Lease>` → writes an object `{ [leaseId]: Lease }` atomically; `loadLeases()` → returns a plain object (`{}` if absent/corrupt).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-leases-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { persistLeases, loadLeases, LEASES_PATH } = require('../src/config');

test('leases round-trip atomically with no orphaned .tmp', () => {
  const m = new Map([['local:workshop', { id: 'local:workshop', provider: 'local', state: 'ready', baseUrl: 'http://x/v1', private: true }]]);
  persistLeases(m);
  assert.equal(fs.existsSync(LEASES_PATH + '.tmp'), false);
  const loaded = loadLeases();
  assert.equal(loaded['local:workshop'].state, 'ready');
  assert.equal(loaded['local:workshop'].private, true);
});

test('loadLeases returns {} when the file is absent', () => {
  fs.rmSync(LEASES_PATH, { force: true });
  assert.deepEqual(loadLeases(), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/leases-persistence.test.js`
Expected: FAIL — `persistLeases` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/config.js`, alongside `ACTIVE_JOBS_PATH`:
```js
const LEASES_PATH = path.join(DISPATCHER_DIR, 'leases.json');

function persistLeases(map) {
  try {
    fs.mkdirSync(DISPATCHER_DIR, { recursive: true });
    const obj = map instanceof Map ? Object.fromEntries(map) : (map || {});
    const tmp = LEASES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, LEASES_PATH); // atomic replace (same idiom as persistActiveJobs)
  } catch (e) { /* best-effort; caller logs */ throw e; }
}

function loadLeases() {
  try {
    if (!fs.existsSync(LEASES_PATH)) return {};
    return JSON.parse(fs.readFileSync(LEASES_PATH, 'utf8')) || {};
  } catch { return {}; }
}
```
Add all three to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/leases-persistence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/leases-persistence.test.js
git commit -m "feat(compute): atomic leases.json persistence (S5 T6)"
```

---

### Task 7: `compute-supply` controller — store, reconcile, upstream publisher

**Files:**
- Create: `src/compute-supply.js`
- Test: `test/compute-supply.test.js`

**Interfaces:**
- Consumes: `createProvider` (T2), `persistLeases`/`loadLeases` (T6), the live `agentConfigs` Map (T9 supplies the real one; tests supply a fake).
- Produces: `createSupplyController({ cfg, agentConfigs, now })` returning:
  - `async attachLocalLeases()` — for each `[compute.providers.<name>]` with `type:'local'`, acquire+waitReady a lease and **publish** its `baseUrl`+`private` into the agent's `agentConfigs` entry keyed by the provider config's `agent_id`.
  - `async reconcileTick()` — probe every non-released lease; a failed probe flips `state='degraded'`; persist after.
  - `async releaseOrphansOnBoot()` — load persisted leases; release any whose state is terminal-eligible; persist.
  - `getLeases()` — array snapshot.
  - `publishUpstream(agentId, lease)` — sets `agentConfigs.get(agentId)` `.endpointUrl=lease.baseUrl` and `.allowPrivate=lease.private` (creating the entry if missing).

- [ ] **Step 1: Write the failing test**

```js
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

test('attachLocalLeases publishes lease baseUrl + private into agentConfigs', async () => {
  const { srv, port } = await startStub(true);
  try {
    const agentConfigs = new Map();
    const cfg = { compute: { enabled: true, reconcile_ms: 1000, providers: {
      workshop: { type: 'local', agent_id: 'agent-1', base_url: `http://127.0.0.1:${port}/v1`, usd_per_hour: 0.08, allow_private_upstream: true },
    } } };
    const ctrl = createSupplyController({ cfg, agentConfigs });
    await ctrl.attachLocalLeases();
    const entry = agentConfigs.get('agent-1');
    assert.equal(entry.endpointUrl, `http://127.0.0.1:${port}/v1`);
    assert.equal(entry.allowPrivate, true);
    assert.equal(ctrl.getLeases()[0].state, 'ready');
  } finally { srv.close(); }
});

test('reconcileTick marks a dead lease degraded within one tick', async () => {
  const { srv, port } = await startStub(true);
  const agentConfigs = new Map();
  const cfg = { compute: { enabled: true, reconcile_ms: 1000, providers: {
    workshop: { type: 'local', agent_id: 'agent-1', base_url: `http://127.0.0.1:${port}/v1`, usd_per_hour: 0.08, allow_private_upstream: true },
  } } };
  const ctrl = createSupplyController({ cfg, agentConfigs });
  await ctrl.attachLocalLeases();
  assert.equal(ctrl.getLeases()[0].state, 'ready');
  srv.close(); // kill the box
  await ctrl.reconcileTick();
  assert.equal(ctrl.getLeases()[0].state, 'degraded');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/compute-supply.test.js`
Expected: FAIL — cannot find module `../src/compute-supply`.

- [ ] **Step 3: Write minimal implementation**

`src/compute-supply.js`:
```js
'use strict';
const { createProvider } = require('./providers');
const { persistLeases, loadLeases } = require('./config');

function createSupplyController({ cfg, agentConfigs, now = Date.now }) {
  const leases = new Map();   // leaseId -> lease
  const bindings = new Map(); // leaseId -> agentId
  const providers = new Map();// providerName -> { provider, agentId, pcfg }

  const compute = (cfg && cfg.compute) || {};
  const provCfgs = compute.providers || {};

  function persist() { try { persistLeases(leases); } catch { /* logged by caller */ } }

  function publishUpstream(agentId, lease) {
    if (!agentId) return;
    const cur = agentConfigs.get(agentId) || {};
    agentConfigs.set(agentId, { ...cur, endpointUrl: lease.baseUrl, allowPrivate: !!lease.private });
  }

  async function attachLocalLeases() {
    for (const [name, pcfg] of Object.entries(provCfgs)) {
      if (pcfg.type !== 'local') continue; // S6 handles vast
      const provider = createProvider('local', { id: `local:${name}`, ...pcfg });
      providers.set(name, { provider, agentId: pcfg.agent_id, pcfg });
      const cands = await provider.discover({});
      let lease = await provider.acquire(cands[0], {});
      lease = await provider.waitReady(lease, { timeoutMs: 60000 });
      leases.set(lease.id, lease);
      bindings.set(lease.id, pcfg.agent_id);
      publishUpstream(pcfg.agent_id, lease);
    }
    persist();
  }

  async function reconcileTick() {
    for (const [id, lease] of leases) {
      if (lease.state === 'released') continue;
      const binding = providers.get(id.replace(/^local:/, ''));
      const provider = binding ? binding.provider : createProvider(lease.provider, { id, base_url: lease.baseUrl });
      const health = await provider.probe(lease);
      const next = { ...lease, state: health.healthy ? 'ready' : 'degraded' };
      leases.set(id, next);
      if (health.healthy) publishUpstream(bindings.get(id), next);
    }
    persist();
  }

  async function releaseOrphansOnBoot() {
    const persisted = loadLeases();
    for (const [id, lease] of Object.entries(persisted)) {
      if (lease.state && lease.state !== 'released') {
        const provider = createProvider(lease.provider, { id, base_url: lease.baseUrl });
        try { await provider.release(lease); } catch { /* idempotent; ignore */ }
      }
    }
    persistLeases(new Map());
  }

  function getLeases() { return [...leases.values()]; }

  return { attachLocalLeases, reconcileTick, releaseOrphansOnBoot, getLeases, publishUpstream };
}
module.exports = { createSupplyController };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/compute-supply.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute-supply.js test/compute-supply.test.js
git commit -m "feat(compute): compute-supply controller (attach/reconcile/publish) (S5 T7)"
```

---

### Task 8: Per-lease private-upstream allowance in the SSRF guard

**Files:**
- Modify: `src/proxy-handler.js` (`checkUpstreamHostSafe` signature + call site + export; `handleProxyRequest` passes `config.allowPrivate`)
- Test: `test/proxy-private-upstream.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `checkUpstreamHostSafe(hostname, cfg, allowPrivate=false)` — a private/loopback host is permitted when `allowPrivate === true` **without** `cfg.runtime.allow_local_upstream`. Exported for testing. `handleProxyRequest` passes the per-agent `config.allowPrivate` at the existing call site (currently `proxy-handler.js:400`).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkUpstreamHostSafe } = require('../src/proxy-handler');

const cfgGuardOn = { runtime: { allow_local_upstream: false } };

test('private IP is rejected by default (guard intact)', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', cfgGuardOn);
  assert.equal(r.safe, false);
});

test('private IP is permitted with per-lease allowPrivate, WITHOUT the global flag', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', cfgGuardOn, true);
  assert.equal(r.safe, true);
});

test('public IP is unaffected by allowPrivate', async () => {
  const r = await checkUpstreamHostSafe('1.1.1.1', cfgGuardOn, false);
  assert.equal(r.safe, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/proxy-private-upstream.test.js`
Expected: FAIL — `checkUpstreamHostSafe` is not exported (and does not accept the 3rd arg).

- [ ] **Step 3: Write minimal implementation**

Edit `checkUpstreamHostSafe` (`proxy-handler.js:186`):
```js
async function checkUpstreamHostSafe(hostname, cfg, allowPrivate = false) {
  if (cfg.runtime.allow_local_upstream || allowPrivate) return { safe: true, resolvedIp: null };
```
Edit the call site (currently ~`:400`) so the per-agent allowance is passed:
```js
  const safety = await checkUpstreamHostSafe(upstreamUrl.hostname, cfg, config.allowPrivate === true);
```
Add `checkUpstreamHostSafe` to `module.exports` (`proxy-handler.js:726`).

> Note: `config` is the `agentConfigs.get(agentId)` entry (`proxy-handler.js:254`); Task 7's `publishUpstream` sets `.allowPrivate` on it, so a private-address home GPU is reachable **without** flipping `runtime.allow_local_upstream` fleet-wide.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/proxy-private-upstream.test.js`
Expected: PASS. Then run the full suite `node --test test/*.test.js` — the existing proxy tests must still pass (the new arg is optional/defaulted).

- [ ] **Step 5: Commit**

```bash
git add src/proxy-handler.js test/proxy-private-upstream.test.js
git commit -m "feat(compute): per-lease private-upstream allowance in SSRF guard (S5 T8)"
```

---

### Task 9: Wire `compute-supply` into boot behind `[compute] enabled`

**Files:**
- Modify: `src/cli.js` (after `proxyContext` is built, ~`:4058`)
- Test: `test/compute-wiring.test.js` (tests the extracted helper, not the whole CLI boot)

**Interfaces:**
- Consumes: `createSupplyController` (T7), the real `agentConfigs` Map (`cli.js:4019/4058`), `loadDispatcherConfig`.
- Produces: an exported helper `maybeStartComputeSupply({ cfg, agentConfigs })` in `src/compute-supply.js` that returns `null` when `cfg.compute.enabled !== true` (the rollback switch) and otherwise builds the controller, runs `releaseOrphansOnBoot()` then `attachLocalLeases()`, starts a `setInterval(reconcileTick, cfg.compute.reconcile_ms)` (unref'd), and returns the controller. `cli.js` calls it once, right after `proxyContext = { agentConfigs, ... }`.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-wire-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { maybeStartComputeSupply } = require('../src/compute-supply');

test('disabled compute is a no-op: returns null, agentConfigs untouched', async () => {
  const agentConfigs = new Map([['agent-1', { endpointUrl: 'http://on-chain/v1' }]]);
  const ctrl = await maybeStartComputeSupply({ cfg: { compute: { enabled: false, providers: {} } }, agentConfigs });
  assert.equal(ctrl, null);
  assert.equal(agentConfigs.get('agent-1').endpointUrl, 'http://on-chain/v1');
  assert.equal(agentConfigs.size, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/compute-wiring.test.js`
Expected: FAIL — `maybeStartComputeSupply` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/compute-supply.js`:
```js
async function maybeStartComputeSupply({ cfg, agentConfigs }) {
  if (!cfg || !cfg.compute || cfg.compute.enabled !== true) return null; // rollback switch
  const ctrl = createSupplyController({ cfg, agentConfigs });
  try { await ctrl.releaseOrphansOnBoot(); } catch (e) { /* boot best-effort */ }
  await ctrl.attachLocalLeases();
  const ms = Number(cfg.compute.reconcile_ms) || 60000;
  const timer = setInterval(() => { ctrl.reconcileTick().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  ctrl._timer = timer;
  return ctrl;
}
module.exports = { createSupplyController, maybeStartComputeSupply };
```
In `src/cli.js`, immediately after the `proxyContext = { agentConfigs, ... }` assignment (~`:4058`), add:
```js
        // S5 — compute-supply owns lease lifecycle and mutates agentConfigs upstreams
        // at runtime. No-op unless [compute] enabled=true.
        try {
          const { maybeStartComputeSupply } = require('./compute-supply');
          proxyContext.computeSupply = await maybeStartComputeSupply({ cfg: cfgForHealth, agentConfigs });
        } catch (e) { console.error('compute-supply start failed:', e.message); }
```
(Use whichever loaded-config variable is in scope there — `cfgForHealth` is used a few lines down at `:4241`; if it is not yet defined at this point, call `loadDispatcherConfig()`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/compute-wiring.test.js`
Then `node --check src/cli.js` (syntax) and the full suite `node --test test/*.test.js`.
Expected: PASS; no existing test regresses (disabled = unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/compute-supply.js src/cli.js test/compute-wiring.test.js
git commit -m "feat(compute): wire compute-supply into boot behind [compute] enabled (S5 T9)"
```

---

### Task 10: Operability — `leases` control + API, `compute` subcommands, docs, rollback proof

**Files:**
- Modify: `src/control-api.js` (add `GET /v1/leases`)
- Modify: `src/control.js` (add a `leases` command)
- Modify: `src/cli.js` (add `compute list|probe` subcommands — `attach`/`detach` are config-driven, so `list`/`probe` are the read surface for S5; provisioning `attach` lands in S6)
- Modify: `docs/config.toml.example` (document `[compute]` + `[compute.providers.workshop]`)
- Test: `test/compute-control.test.js`

**Interfaces:**
- Consumes: a controller handle exposed to the control server. Simplest seam: `compute-supply` keeps a module-level `let current = null` set by `maybeStartComputeSupply`, with `getCurrentController()`; `control-api` reads it.
- Produces: `GET /v1/leases` → `{ leases: Lease[] }` (empty array when compute disabled). CLI `compute list` prints the same.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-ctl-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const supply = require('../src/compute-supply');

test('getCurrentController is null until compute starts; leases snapshot is []', () => {
  assert.equal(supply.getCurrentController(), null);
});

test('after a disabled start, controller stays null (rollback proof)', async () => {
  const r = await supply.maybeStartComputeSupply({ cfg: { compute: { enabled: false, providers: {} } }, agentConfigs: new Map() });
  assert.equal(r, null);
  assert.equal(supply.getCurrentController(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/compute-control.test.js`
Expected: FAIL — `getCurrentController` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/compute-supply.js`: add `let current = null;`, set `current = ctrl;` inside `maybeStartComputeSupply` (before returning), set `current = null` when it returns null, and export `getCurrentController: () => current`.

In `src/control-api.js`, add a route alongside the existing ones:
```js
  if (req.method === 'GET' && url.pathname === '/v1/leases') {
    const { getCurrentController } = require('./compute-supply');
    const ctrl = getCurrentController();
    return sendJson(res, 200, { leases: ctrl ? ctrl.getLeases() : [] });
  }
```
(Match the file's actual `sendJson`/response helper and routing style.)

In `src/control.js`, add a `leases` subcommand that GETs `/v1/leases` from the control API and prints the rows (mirror an existing read command like `status`).

In `src/cli.js`, add a `compute` command dispatching `list` (calls the control API `/v1/leases`) and `probe` (forces one `reconcileTick` via the control API or prints per-lease probe results). Mirror the existing subcommand dispatch pattern.

In `docs/config.toml.example`, append:
```toml
# ── Compute-provider seam (S5). Disabled by default; enabling changes nothing
#    until at least one [compute.providers.*] is declared. ──
[compute]
enabled          = false      # master switch; false = today's behaviour exactly
default_provider = "local"
reconcile_ms     = 60000
max_usd_per_hour = 0.0        # fleet ceiling (S6/Vast). 0 = no paid provisioning

# A GPU you already own. `agent_id` binds the lease to an existing api-endpoint agent
# so its proxy upstream is served from this box. allow_private_upstream is scoped to
# THIS provider — it does NOT disable the SSRF guard fleet-wide.
[compute.providers.workshop]
type                   = "local"
agent_id               = "your-agent-id"
base_url               = "http://192.168.1.50:8000/v1"
usd_per_hour           = 0.08
gpu                    = "RTX 4090"
vram_gb                = 24
gpu_count              = 1
allow_private_upstream = true
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/compute-control.test.js`
Then the FULL suite `node --test test/*.test.js` and `node --check src/*.js src/executors/*.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/control-api.js src/control.js src/cli.js src/compute-supply.js docs/config.toml.example test/compute-control.test.js
git commit -m "feat(compute): leases control/API + compute subcommands + config docs (S5 T10)"
```

---

## Self-Review

**Spec coverage (§6.2 / roadmap 2.32.0 "Done when"):**
- Local GPU at a private address listed + sold + billed without `runtime.allow_local_upstream` → Tasks 4 (local), 7 (publish upstream), 8 (per-lease allowance). ✓
- Killing vLLM marks the lease `degraded` within one reconcile tick, proxy returns clean 5xx → Task 7 (reconcileTick degrade) + existing proxy `502 Seller endpoint not configured`/upstream-health path. ✓ (A degraded lease keeps the last baseUrl; the proxy's existing upstream-health/circuit breaker returns 5xx on a dead upstream. Confirm during execution that a `degraded` lease does not keep publishing — `reconcileTick` only re-publishes on healthy.)
- `provider-contract.test.js` passes against `local` and a `FakeProvider` → Tasks 3, 4. ✓
- With `enabled=false`, full existing suite unchanged → Tasks 9, 10 (rollback proofs) + run `node --test test/*.test.js` at T9/T10. ✓
- Registry (Map, not switch) → Task 2. ✓
- Persisted lease file, atomic, crash-recovery release → Tasks 6, 7 (`releaseOrphansOnBoot`). ✓
- Config `[compute]` + `[compute.providers.*]` + ENV → Task 5. ✓

**Placeholder scan:** none — every task carries runnable test + impl code. Two explicitly-flagged execution-time confirmations (the config-merge passthrough in T5; the in-scope config var in T9) are noted inline, not left as TODO.

**Type consistency:** `Lease` shape identical across T1 typedef, T4 `acquire`, T6 persistence, T7 controller. `capabilities` keys `{canProvision,canSsh,canScaleToZero,isElastic}` identical in T1/T2/T4. `checkUpstreamHostSafe(hostname,cfg,allowPrivate)` signature consistent T8. `publishUpstream` sets `.endpointUrl`+`.allowPrivate`, the exact fields `handleProxyRequest` (T8) reads. `agentConfigs` is the same Map object across T7/T9 and `cli.js:4058`.

**Out of scope (later slices, per spec §13):** paid provisioning / `vast` (S6), Cat-1 raw-GPU-as-job + SSH refusal + spend ceiling (S7), time/GPU-unit metering (later), on-chain publish of compute Offers (S1/platform). S5 spends nothing and calls no external API.
