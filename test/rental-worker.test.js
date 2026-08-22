'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-worker-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
const { isGpuRentalJob, startRentalJob } = require('../src/rental-worker');

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
    state, job: { id: 'job-1', jobHash: 'h', serviceType: 'gpu-rental', timeoutMin: 60 },
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
    state, job: { id: 'job-1', jobHash: 'h', serviceType: 'gpu-rental', timeoutMin: 60 },
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
  assert.match(CLI, /kind === 'gpu-rental'/, 'cleanup must not treat a rental as a missing docker container');
});
