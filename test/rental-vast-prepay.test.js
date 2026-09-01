'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-vast-prepay-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
const { assertPaidBeforePaidProvision, acquireRentalLease } = require('../src/rental-job');
const { startRentalJob } = require('../src/rental-worker');

const vastLike = { capabilities: { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true } };
const homeLike = { capabilities: { canProvision: true, canSsh: true, canScaleToZero: true, isElastic: false } };

test('Vast acquire refused until payment_verified', () => {
  assert.throws(
    () => assertPaidBeforePaidProvision({ job: { payment: { verified: false } }, provider: vastLike }),
    /VAST_PREPAY_REQUIRED/,
  );
  assert.doesNotThrow(() => assertPaidBeforePaidProvision({ job: { payment: { verified: true } }, provider: vastLike }));
});

test('home-gpu may acquire without payment_verified (no outbound USD)', () => {
  assert.doesNotThrow(() => assertPaidBeforePaidProvision({ job: { payment: { verified: false } }, provider: homeLike }));
});

test('Vast postpay ack allows acquire before pay (Alice risk)', () => {
  assert.doesNotThrow(() => assertPaidBeforePaidProvision({
    job: { payment: { verified: false } }, provider: vastLike, ackPostpayVastRisk: true,
  }));
});

test('startRentalJob gates Vast before acquireRentalLease', async () => {
  let acquired = 0;
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async discover() { acquired += 1; return [{ provider: 'vast', usdPerHour: 0.3, gpu: {}, meta: { askId: 1 } }]; },
    async acquire(c) { acquired += 1; return { id: 'vast:r1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, ssh: null, meta: {} }; },
    async waitReady(l) { acquired += 1; return { ...l, state: 'ready', ssh: { host: '9.9.9.9', port: 22, user: 'root', privateKey: 'k' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const { createSupplyController } = require('../src/compute-supply');
  const controller = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } },
    agentConfigs: new Map(),
    now: () => 1000,
  });
  const state = { active: new Map(), emitEvent() {} };
  const client = { async postRentalSecret() {}, async deliverJob() { return {}; } };
  await assert.rejects(
    () => startRentalJob({
      state,
      job: { id: 'job-1', serviceType: 'gpu-rental', payment: { verified: false } },
      agentInfo: { id: 'gpu-1' },
      controller,
      provider,
      client,
      signDeliver: ({ hash }) => ({ signature: 's', timestamp: 1, hash }),
      now: 1000,
    }),
    /VAST_PREPAY_REQUIRED/,
  );
  assert.equal(acquired, 0, 'must not discover/acquire a Vast box before payment_verified');
});

test('startRentalJob injects ackPostpayVastRisk and may acquire unpaid Vast', async () => {
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.3, gpu: {}, meta: { askId: 1 } }]; },
    async acquire(c) { return { id: 'vast:r1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', ssh: { host: '9.9.9.9', port: 22, user: 'root', privateKey: 'k' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const { createSupplyController } = require('../src/compute-supply');
  const controller = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } },
    agentConfigs: new Map(),
    now: () => 1000,
  });
  const state = { active: new Map(), emitEvent() {} };
  const client = { async postRentalSecret() {}, async deliverJob() { return {}; } };
  const { lease } = await startRentalJob({
    state,
    job: { id: 'job-ack', serviceType: 'gpu-rental', payment: { verified: false } },
    agentInfo: { id: 'gpu-1' },
    controller,
    provider,
    client,
    ackPostpayVastRisk: true,
    signDeliver: ({ hash }) => ({ signature: 's', timestamp: 1, hash }),
    now: 1000,
  });
  assert.equal(lease.id, 'vast:r1');
  assert.equal(state.active.get('job-ack').kind, 'gpu-rental');
});

test('acquireRentalLease waitReady is SSH-ready (readyFor: ssh)', async () => {
  let seen;
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.3, gpu: {}, meta: { askId: 1 } }]; },
    async acquire(c) { return { id: 'vast:r1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, ssh: null, meta: {} }; },
    async waitReady(l, opts) { seen = opts; return { ...l, state: 'ready', ssh: { host: '9.9.9.9', port: 22, user: 'root', privateKey: 'k' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const { createSupplyController } = require('../src/compute-supply');
  const ctrl = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } },
    agentConfigs: new Map(),
    now: () => 1000,
  });
  await acquireRentalLease({
    controller: ctrl, provider, spec: {}, jobId: 'job-1', agentId: 'agent-1', jobTimeoutMin: 60, now: 1000,
  });
  assert.equal(seen && seen.readyFor, 'ssh');
});

test('startRentalJobWired reads rentalAckPostpayVastRisk from agent-config', () => {
  const cli = fs.readFileSync(require.resolve('../src/cli.js'), 'utf8');
  const wired = cli.slice(cli.indexOf('async function startRentalJobWired'), cli.indexOf('async function startJobOrRental'));
  assert.match(wired, /rentalAckPostpayVastRisk/);
  assert.match(wired, /loadAgentConfig/);
  assert.match(wired, /ackPostpayVastRisk/);
});

test('rental acquire on default-interruptible Vast omits bid price and seals a renter privateKey', async () => {
  const { VastProvider } = require('../src/providers/vast');
  const { createSupplyController } = require('../src/compute-supply');
  const log = [];
  let created = false;
  const fetchImpl = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    log.push({ method, url, body });
    if (method === 'GET' && String(url).includes('/bundles')) {
      return {
        status: 200, ok: true,
        async json() {
          return { offers: [{ id: 7, gpu_name: 'RTX 3090', num_gpus: 1, gpu_ram: 24576, dph_total: 0.22, rentable: true, rented: false }] };
        },
        async text() { return ''; },
      };
    }
    if (method === 'PUT' && String(url).includes('/asks/7')) {
      created = true;
      return { status: 200, ok: true, async json() { return { success: true, new_contract: 42 }; }, async text() { return ''; } };
    }
    if (method === 'GET' && String(url).includes('/instances')) {
      return {
        status: 200, ok: true,
        async json() {
          return {
            instances: created ? [{
              id: 42, actual_status: 'running', ssh_host: '9.9.9.9', ssh_port: 22,
              ports: { '8000/tcp': [{ HostPort: '41000' }] },
            }] : [],
          };
        },
        async text() { return ''; },
      };
    }
    throw new Error(`no fake route for ${method} ${url}`);
  };
  const provider = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl }); // interruptible defaults true
  const ctrl = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } },
    agentConfigs: new Map(),
    now: () => 1000,
  });
  const { lease, deliverable } = await acquireRentalLease({
    controller: ctrl, provider, spec: {}, jobId: 'job-1', agentId: 'agent-1', jobTimeoutMin: 60, now: 1000,
  });
  const put = log.find((l) => l.method === 'PUT');
  assert.equal(put.body.price, undefined, 'Cat-1 rental must not bid an interruptible price');
  assert.notEqual(put.body.image, 'vllm/vllm-openai:latest');
  assert.match(String(put.body.image), /pytorch|cuda/i);
  assert.match(put.body.onstart, /ssh-ed25519 /, 'renter pubkey is injected on PUT /asks via onstart');
  assert.equal(lease.meta.interruptible, false);
  assert.ok(deliverable.ssh.privateKey);
  assert.match(deliverable.ssh.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(deliverable.ssh.host, '9.9.9.9');
  assert.equal(deliverable.ssh.user, 'root');
});

test('reconcileTick does not release a job-bound Vast rental when /models is down', async () => {
  const { VastProvider } = require('../src/providers/vast');
  const { createSupplyController } = require('../src/compute-supply');
  let deleted = 0;
  const fetchImpl = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'DELETE') {
      deleted += 1;
      return { status: 200, ok: true, async json() { return {}; }, async text() { return '{}'; } };
    }
    if (method === 'GET' && String(url).includes('/instances')) {
      return {
        status: 200, ok: true,
        async json() {
          return {
            instances: [{
              id: 42, actual_status: 'running', ssh_host: '9.9.9.9', ssh_port: 22,
              ports: { '8000/tcp': [{ HostPort: '41000' }] },
            }],
          };
        },
        async text() { return ''; },
      };
    }
    if (method === 'GET' && String(url).includes('/models')) {
      return { status: 500, ok: false, async json() { return {}; }, async text() { return ''; } };
    }
    throw new Error(`no fake route for ${method} ${url}`);
  };
  const provider = new VastProvider({ id: 'vast:t', api_key: 'k', fetchImpl });
  const lease = {
    id: 'vast:42', provider: 'vast', state: 'ready', jobId: 'job-1',
    usdPerHour: 0.2, ssh: { host: '9.9.9.9', port: 22, user: 'root' },
    meta: { instanceId: 42 }, baseUrl: 'http://9.9.9.9:41000/v1',
  };
  const health = await provider.probe(lease);
  assert.equal(health.healthy, true, 'running + ssh_host + /models 500 is healthy when jobId is set');

  const ctrl = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } },
    agentConfigs: new Map(),
    now: () => 1000,
  });
  ctrl._injectBoundLease(lease, provider, 'agent-1');
  await ctrl.reconcileTick();
  const leases = ctrl.getLeases();
  assert.equal(deleted, 0, 'reconcile must not DELETE a live Cat-1 rental');
  assert.equal(leases.length, 1);
  assert.equal(leases[0].id, 'vast:42');
  assert.equal(leases[0].state, 'ready');
});
