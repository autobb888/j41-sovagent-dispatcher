'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-worker-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
const { isGpuRentalJob, startRentalJob, stopRentalJob, shouldTeardownRental } = require('../src/rental-worker');

test('isGpuRentalJob is true only for gpu-rental services', () => {
  assert.equal(isGpuRentalJob({ serviceType: 'gpu-rental' }), true);
  assert.equal(isGpuRentalJob({ serviceId: 's1' }, [{ id: 's1', serviceType: 'gpu-rental' }]), true);
  assert.equal(isGpuRentalJob({ serviceId: 's1' }, [{ id: 's1', serviceType: 'api-endpoint' }]), false);
  assert.equal(isGpuRentalJob({ serviceType: 'agent' }), false);
});

test('startRentalJob acquires + seals and does not invoke startJobContainer', async () => {
  const startedContainers = [];
  const state = { active: new Map(), emitEvent() {} };
  const provider = {
    get capabilities() { return { canSsh: true, canProvision: true, canScaleToZero: true, isElastic: false }; },
    async discover() { return [{ provider: 'home-gpu', usdPerHour: 0, meta: {} }]; },
    async acquire() { return { id: 'home:1', provider: 'home-gpu', state: 'pending', usdPerHour: 0, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 'x' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const { createSupplyController } = require('../src/compute-supply');
  const controller = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0, providers: {} } }, agentConfigs: new Map(), now: () => 1000 });
  const client = {
    async postRentalSecret() {},
    async deliverJob() { return {}; },
    async confirmWorkerAttached() {},
  };
  await startRentalJob({
    state, job: { id: 'job-1', jobHash: 'h', serviceType: 'gpu-rental' },
    agentInfo: { id: 'gpu-1' }, controller, provider, client,
    signDeliver: ({ hash }) => ({ signature: 's', timestamp: 1, hash }),
    startJobContainer: async () => { startedContainers.push('nope'); },
    now: 1000,
  });
  assert.equal(startedContainers.length, 0);
  assert.equal(state.active.get('job-1').kind, 'gpu-rental');
});

test('startRentalJob confirms worker-attached and records leaseId, never a docker job-agent', async () => {
  const attached = [];
  const state = { active: new Map(), available: [{ id: 'gpu-1' }], emitEvent() {} };
  const provider = {
    get capabilities() { return { canSsh: true, canProvision: true, canScaleToZero: true, isElastic: false }; },
    async discover() { return [{ provider: 'home-gpu', usdPerHour: 0, meta: {} }]; },
    async acquire() { return { id: 'home:1', provider: 'home-gpu', state: 'pending', usdPerHour: 0, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 'x' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
  const { createSupplyController } = require('../src/compute-supply');
  const controller = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0, providers: {} } }, agentConfigs: new Map(), now: () => 1000 });
  const client = {
    async postRentalSecret() {},
    async deliverJob() { return {}; },
    async confirmWorkerAttached(jobId) { attached.push(jobId); },
  };
  await startRentalJob({
    state, job: { id: 'job-1', jobHash: 'h', serviceType: 'gpu-rental' },
    agentInfo: { id: 'gpu-1' }, controller, provider, client,
    signDeliver: ({ hash }) => ({ signature: 's', timestamp: 1, hash }),
    now: 1000,
  });
  assert.deepEqual(attached, ['job-1']);
  const rec = state.active.get('job-1');
  assert.equal(rec.kind, 'gpu-rental');
  assert.equal(rec.leaseId, 'home:1');
  assert.equal(rec.agentId, 'gpu-1');
  assert.equal(rec.container, undefined);
  assert.equal(state.available.length, 0);
});

test('cli.js skips LLM preflight for gpu-rental and routes start to startRentalJob', () => {
  const CLI = fs.readFileSync(require.resolve('../src/cli.js'), 'utf8');
  const requested = CLI.slice(CLI.indexOf("case 'job.requested'"), CLI.indexOf("case 'job.started'"));
  assert.match(requested, /isGpuRentalJob/, 'job.requested must detect gpu-rental');
  assert.match(requested, /preflightAllowsAccept/, 'LLM path still preflights');
  const started = CLI.slice(CLI.indexOf("case 'job.started'"), CLI.indexOf("case 'file.uploaded'"));
  assert.match(started, /startRentalJob/, 'job.started must call startRentalJob for rentals');
  assert.match(started, /startJob/, 'LLM startJob remains for non-rental');
  const bounty = CLI.slice(CLI.indexOf("case 'bounty.awarded'"), CLI.indexOf("case 'job.extension_approved'"));
  assert.match(bounty, /isGpuRentalJob|gpu-rental/);
  assert.match(bounty, /skip(?:ping)? startJob|LLM-only/i);
  const pollPart = CLI.slice(0, CLI.indexOf('async function handleWebhookEvent'));
  assert.match(pollPart, /isGpuRentalJob/, 'poll accept must skip LLM preflight for gpu-rental');
  const cancelled = CLI.slice(CLI.indexOf("case 'job.cancelled'"), CLI.indexOf("case 'job.delivery_rejected'"));
  assert.match(cancelled, /kind === 'gpu-rental'/, 'job.cancelled must branch on gpu-rental');
  assert.match(cancelled, /stopRentalJob/, 'job.cancelled must release via stopRentalJob, not container.stop');
  assert.match(CLI, /shouldTeardownRental/, 'cleanup must teardown rentals on terminal/expiry, not skip forever');
});

test('stopRentalJob releases the lease, returns the agent, and never touches container.stop', async () => {
  const released = [];
  const stopped = [];
  const agentInfo = { id: 'gpu-1' };
  const container = { stop: async () => { stopped.push('nope'); } };
  const state = {
    active: new Map([['job-1', {
      kind: 'gpu-rental', leaseId: 'home:1', agentId: 'gpu-1', agentInfo, container,
    }]]),
    available: [],
    retries: new Map(),
    emitEvent() {},
    computeSupply: {
      getLeases() { return [{ id: 'home:1', jobId: 'job-1', state: 'ready' }]; },
      async releaseLease(l) { released.push(l.id); l.state = 'released'; },
    },
  };
  const ok = await stopRentalJob(state, 'job-1');
  assert.equal(ok, true);
  assert.deepEqual(released, ['home:1']);
  assert.equal(stopped.length, 0);
  assert.equal(state.active.has('job-1'), false);
  assert.equal(state.available[0] && state.available[0].id, 'gpu-1');
});

test('shouldTeardownRental yanks on cancel/dispute-terminal or expired/gone lease, not on delivered', () => {
  const lease = { id: 'home:1', jobId: 'job-1', state: 'ready', expiresAt: 5000 };
  const state = {
    computeSupply: { getLeases() { return [lease]; } },
  };
  const active = { kind: 'gpu-rental', leaseId: 'home:1' };
  assert.equal(shouldTeardownRental({ state, jobId: 'job-1', active, job: { status: 'delivered' }, now: 1000 }), false);
  assert.equal(shouldTeardownRental({ state, jobId: 'job-1', active, job: { status: 'completed' }, now: 1000 }), false);
  assert.equal(shouldTeardownRental({ state, jobId: 'job-1', active, job: { status: 'cancelled' }, now: 1000 }), true);
  assert.equal(shouldTeardownRental({ state, jobId: 'job-1', active, job: { status: 'resolved' }, now: 1000 }), true);
  assert.equal(shouldTeardownRental({ state, jobId: 'job-1', active, job: { status: 'in_progress' }, now: 1000 }), false);
  assert.equal(shouldTeardownRental({ state, jobId: 'job-1', active, job: { status: 'in_progress' }, now: 5000 }), true);
  assert.equal(shouldTeardownRental({
    state: { computeSupply: { getLeases() { return []; } } },
    jobId: 'job-1', active, job: { status: 'in_progress' }, now: 1000,
  }), true);
});
