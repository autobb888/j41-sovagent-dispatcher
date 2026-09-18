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
  const rentalSeen = startReady.indexOf('state.seen.set', startGate);
  assert.ok(rentalSeen > startGate, 'LAN gate must run before the rental state.seen.set');
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
  const start = CLI_SRC.indexOf('async function runBuyerComplete');
  assert.ok(start > -1, 'complete leftover lives in runBuyerComplete');
  const next = CLI_SRC.indexOf('\nprogram', start + 1);
  const body = CLI_SRC.slice(start, next === -1 ? start + 5000 : next);
  assert.match(body, /getRentalAccess/);
  assert.match(body, /leftoverCompleteHonesty|completeRentalHonesty|formatBuyerCompleteOutput/);
  assert.doesNotMatch(body, /job\.serviceType === 'gpu-rental'/);
  assert.doesNotMatch(body, /job\.kind === 'compute'/);
  const cmd = CLI_SRC.indexOf(".command('complete <buyer-agent-id> <job-id>')");
  assert.ok(cmd > start, 'complete command must call runBuyerComplete');
  const cmdNext = CLI_SRC.indexOf('\n  .command(', cmd + 1);
  const cmdBody = CLI_SRC.slice(cmd, cmdNext === -1 ? cmd + 2000 : cmdNext);
  assert.match(cmdBody, /runBuyerComplete/);
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
  runBuyerComplete,
} = require('../src/cli.js');

// Real WIF so signMessage succeeds; a missing LAN accept gate must then
// reach acceptJob. Dummy/invalid wif would throw inside signMessage and
// hide a missing gate (accepted.length stays 0 for the wrong reason).
const { generateKeypair } = require('@junction41/sovagent-sdk/dist/index.js');
const GPU_KEYS = generateKeypair('verustest');

function rentalWebhookState({ status = 'requested' } = {}) {
  const accepted = [];
  const acquired = [];
  const agentInfo = {
    id: 'gpu-1',
    identity: 'gpu-1@',
    address: 'Rgpu',
    iAddress: 'iGpu',
    wif: GPU_KEYS.wif,
  };
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

test('webhook job.requested does acceptJob when J41_ALLOW_LAN_RENTAL=1 (fixture can reach accept)', async () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  process.env.J41_ALLOW_LAN_RENTAL = '1';
  try {
    const { state, accepted } = rentalWebhookState();
    await handleWebhookEvent(state, 'gpu-1', {
      event: 'job.requested',
      data: { jobId: 'job-lan' },
    });
    assert.equal(accepted.length, 1, 'override must reach acceptJob so a missing LAN gate cannot hide behind signMessage');
  } finally {
    if (prev === undefined) delete process.env.J41_ALLOW_LAN_RENTAL;
    else process.env.J41_ALLOW_LAN_RENTAL = prev;
  }
});

test('complete leftover getJob without serviceType still honesty-checks LAN getRentalAccess', async () => {
  const logs = [];
  const origLog = console.log;
  const origExit = process.exit;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  process.exit = (code) => { throw new Error(`unexpected exit ${code}: ${logs.join('\n')}`); };
  const keys = {
    identity: 'buyer.agentplatform@',
    iAddress: 'iBuyer',
    address: 'Rbuyer',
    wif: 'x',
  };
  // SDK Job has serviceId, not serviceType/kind. buyerVerusId is only for buyerOwnsJob.
  const job = { id: 'e70731db-leftover', status: 'delivered', serviceId: 'svc-gpu-1', buyerVerusId: 'buyer.agentplatform@' };
  const agent = {
    async completeJob() { return { status: 'completed' }; },
    client: {
      async getJob() { return job; },
      async getRentalAccess() {
        return { ssh: { host: '192.168.1.69', port: 2222, password: 's3cret' } };
      },
      async getJobWitness() { return null; },
    },
  };
  try {
    await runBuyerComplete(keys, agent, job.id, { yes: true });
    const human = logs.join('\n');
    assert.doesNotMatch(human, /✅ Job .* completed/);
    assert.match(human, /RFC1918/);
    assert.doesNotMatch(human, /SSH ready/i);

    logs.length = 0;
    await runBuyerComplete(keys, agent, job.id, { yes: true, json: true });
    const raw = logs.join('\n');
    assert.doesNotMatch(raw, /✅ Job .* completed/);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.warning, 'COMPLETE_LAN_ONLY');
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
});
