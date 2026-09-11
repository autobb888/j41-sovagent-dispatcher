'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-lan-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';
delete process.env.J41_ALLOW_LAN_RENTAL;

const cfgDir = path.join(TEST_HOME, '.j41', 'dispatcher');
fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(cfgDir, 'config.toml'), `
[compute]
enabled = true

[compute.providers.card0]
type = "home-gpu"
agent_id = "gpu-1"
ssh_hostname = "192.168.1.69"
ssh_tunnel_port = 2222
memory_mb = 8192
disk_gb = 40
`);

const CLI_SRC = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');

test('poll accept calls assertRentalHostPublic / shouldRefuseLanGpuRental before acceptJob and before seen.set', () => {
  const poll = CLI_SRC.slice(CLI_SRC.indexOf("job.status === 'requested'"), CLI_SRC.indexOf('Step 2: Check if ready'));
  assert.match(poll, /shouldRefuseLanGpuRental|assertRentalHostPublic/);
  const gate = Math.min(
    ...['shouldRefuseLanGpuRental', 'assertRentalHostPublic']
      .map((n) => poll.indexOf(n))
      .filter((i) => i >= 0),
  );
  assert.ok(gate >= 0, 'poll requested path must gate LAN before accept');
  assert.ok(gate < poll.indexOf('acceptJob'), 'LAN gate must run before acceptJob');

  const startReady = CLI_SRC.slice(CLI_SRC.indexOf('Ready to go'), CLI_SRC.indexOf('async function handleWebhookEvent'));
  const startGate = Math.min(
    ...['shouldRefuseLanGpuRental', 'assertRentalHostPublic']
      .map((n) => startReady.indexOf(n))
      .filter((i) => i >= 0),
  );
  assert.ok(startGate >= 0, 'poll start path must gate LAN before seen.set');
  assert.ok(startGate < startReady.indexOf('state.seen.set'), 'LAN gate must run before state.seen.set');
});

test('webhook job.accepted / job.requested gates LAN before acceptJob', () => {
  const requested = CLI_SRC.slice(CLI_SRC.indexOf("case 'job.requested'"), CLI_SRC.indexOf("case 'job.started'"));
  assert.match(requested, /shouldRefuseLanGpuRental|assertRentalHostPublic/);
  const gate = Math.min(
    ...['shouldRefuseLanGpuRental', 'assertRentalHostPublic']
      .map((n) => requested.indexOf(n))
      .filter((i) => i >= 0),
  );
  assert.ok(gate >= 0);
  assert.ok(gate < requested.indexOf('acceptJob'), 'webhook LAN gate must run before acceptJob');
});

test('accept-job CLI gates LAN before acceptJob and exits non-zero RENTAL_LAN_HOST', () => {
  const start = CLI_SRC.indexOf(".command('accept-job <agent-id> <job-id>')");
  assert.ok(start > -1);
  const next = CLI_SRC.indexOf('\n  .command(', start + 1);
  const body = CLI_SRC.slice(start, next === -1 ? start + 4000 : next);
  assert.match(body, /assertRentalHostPublic|shouldRefuseLanGpuRental/);
  const gate = Math.min(
    ...['shouldRefuseLanGpuRental', 'assertRentalHostPublic']
      .map((n) => body.indexOf(n))
      .filter((i) => i >= 0),
  );
  assert.ok(gate < body.indexOf('acceptJob'));
  assert.match(body, /RENTAL_LAN_HOST/);
  assert.match(body, /process\.exit\(1\)/);
});

test('startRentalJobWired gates LAN at the top before acquireRentalLease / startRentalJob', () => {
  const wired = CLI_SRC.slice(CLI_SRC.indexOf('async function startRentalJobWired'), CLI_SRC.indexOf('async function startJobOrRental'));
  assert.match(wired, /assertRentalHostPublic|shouldRefuseLanGpuRental/);
  const gate = Math.min(
    ...['shouldRefuseLanGpuRental', 'assertRentalHostPublic']
      .map((n) => wired.indexOf(n))
      .filter((i) => i >= 0),
  );
  const acquire = wired.search(/startRentalJob\(|acquireRentalLease\(/);
  assert.ok(gate >= 0 && acquire > gate, 'LAN gate must be the first thing in startRentalJobWired');
});

test('bounty acceptJob is not LAN-gated unless isGpuRentalJob', () => {
  const bounty = CLI_SRC.slice(CLI_SRC.indexOf("case 'bounty.awarded'"), CLI_SRC.indexOf("case 'job.extension_approved'"));
  const gate = bounty.search(/shouldRefuseLanGpuRental|assertRentalHostPublic/);
  if (gate >= 0) {
    assert.ok(bounty.indexOf('isGpuRentalJob') >= 0);
  }
});

test('complete leftover GPU path uses getRentalAccess + honesty helper; checkmark is gated on warning', () => {
  const start = CLI_SRC.indexOf(".command('complete <buyer-agent-id> <job-id>')");
  const next = CLI_SRC.indexOf('\n  .command(', start + 1);
  const body = CLI_SRC.slice(start, next === -1 ? start + 5000 : next);
  assert.match(body, /getRentalAccess/);
  assert.match(body, /completeRentalHonesty|formatBuyerCompleteOutput/);
  assert.match(body, /COMPLETE_LAN_ONLY|warning/);
  const check = body.indexOf('✅ Job ${job.id} completed');
  assert.ok(check === -1 || /warning/.test(body.slice(Math.max(0, check - 400), check)),
    'checkmark must not print unconditionally on leftover LAN complete');
});

test('job.completed / delivered gpu-rental does not sendToJobAgent', () => {
  const pollCompleted = CLI_SRC.slice(
    CLI_SRC.indexOf("if (currentJob.status === 'completed')"),
    CLI_SRC.indexOf("} else if (currentJob.status === 'disputed')"),
  );
  assert.match(pollCompleted, /kind === 'gpu-rental'/);
  assert.match(pollCompleted, /credentials delivered; jail runs until expiresAt/);

  const webhookCompleted = CLI_SRC.slice(CLI_SRC.indexOf("case 'job.completed':"), CLI_SRC.indexOf("case 'workspace.ready':"));
  assert.match(webhookCompleted, /kind === 'gpu-rental'/);
  assert.match(webhookCompleted, /credentials delivered; jail runs until expiresAt/);

  const webhookDelivered = CLI_SRC.slice(CLI_SRC.indexOf("case 'job.delivered':"), CLI_SRC.indexOf("case 'bounty.awarded':"));
  assert.match(webhookDelivered, /kind === 'gpu-rental'/);
});

const {
  handleWebhookEvent,
  startRentalJobWired,
  pollForJobs,
} = require('../src/cli.js');

function rentalWebhookState({ status = 'requested' } = {}) {
  const accepted = [];
  const acquired = [];
  const agentInfo = { id: 'gpu-1', identity: 'gpu-1@', address: 'Rgpu', iAddress: 'iGpu' };
  const job = {
    id: 'job-lan',
    status,
    jobHash: 'hash',
    buyerVerusId: 'iBuyer',
    serviceType: 'gpu-rental',
    amount: 1,
    currency: 'VRSCTEST',
    payment: { verified: true, status: 'confirmed' },
  };
  const state = {
    agents: [agentInfo],
    active: new Map(),
    seen: new Map(),
    queue: [],
    available: [agentInfo],
    pendingPayment: new Map(),
    retries: new Map(),
    capabilities: new Map([['gpu-1', { services: [{ serviceType: 'gpu-rental' }] }]]),
    emitEvent() {},
    _lastSentStatus: new Map(),
    _pendingWorkspace: new Map(),
    reactivationQueue: [],
    computeSupply: {
      getLeases() { return []; },
      async acquire() { acquired.push('acquire'); throw new Error('should not acquire'); },
    },
    _testAgentSession: {
      client: {
        async getJob() { return job; },
        async getMyJobs() { return { data: [job] }; },
        async acceptJob(...args) { accepted.push(args); return { ok: true }; },
        async getIdentityRaw() { return { identity: { contentmultimap: {} } }; },
      },
    },
  };
  return { state, accepted, acquired, job, agentInfo };
}

test('webhook job.requested does not acceptJob or seen.set on LAN gpu-rental', async () => {
  const { state, accepted } = rentalWebhookState();
  await handleWebhookEvent(state, 'gpu-1', {
    event: 'job.requested',
    data: { jobId: 'job-lan' },
  });
  assert.equal(accepted.length, 0);
  assert.equal(state.seen.has('job-lan'), false);
});

test('startRentalJobWired does not acquireRentalLease on LAN', async () => {
  const { state, acquired, job, agentInfo } = rentalWebhookState({ status: 'accepted' });
  await startRentalJobWired(state, job, agentInfo);
  assert.equal(acquired.length, 0);
  assert.equal(state.active.has('job-lan'), false);
});

test('poll does not acceptJob or seen.set on LAN gpu-rental', async () => {
  const { state, accepted } = rentalWebhookState();
  await pollForJobs(state);
  assert.equal(accepted.length, 0);
  assert.equal(state.seen.has('job-lan'), false);
});
