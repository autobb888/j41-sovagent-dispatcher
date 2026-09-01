'use strict';
// Cat-1 rental duration + mid-session extension.
//
// The bug these guard: `startRentalJob` used to read the rental period from
// `job.timeoutMin` — a field the backend has never had and the SDK has never sent — so
// every rental was leased for the 60-minute fallback while `rental-setup` advertised the
// seller's configured `job_timeout_min`. The old tests could not catch it because every
// one of them PASSED `job.timeoutMin: 60` themselves. Nothing here may invent that field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-ext-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { rentalExtensionGrant } = require('../src/rental-job');
const { startRentalJob, decideRentalExtension, applyRentalExtension } = require('../src/rental-worker');
const { createSupplyController } = require('../src/compute-supply');

const NOW = 1_000_000;
const MIN = 60_000;

function stubProvider() {
  return {
    get capabilities() { return { canSsh: true, canProvision: true, canScaleToZero: true, isElastic: false }; },
    async discover() { return [{ provider: 'home-gpu', usdPerHour: 0, meta: {} }]; },
    async acquire() { return { id: 'home:1', provider: 'home-gpu', state: 'pending', usdPerHour: 0, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 'secretpw' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
}

// Boot a rental exactly as the live path does — no invented job fields.
async function bootRental({ jobTimeoutMin, amount = 2, now = NOW } = {}) {
  const sealed = [];
  const state = { active: new Map(), emitEvent() {} };
  const controller = createSupplyController({
    cfg: { compute: { enabled: true, max_usd_per_hour: 0, providers: {} } },
    agentConfigs: new Map(),
    now: () => now,
  });
  const client = {
    async postRentalSecret(_jobId, body) { sealed.push(body); },
    async deliverJob() { return {}; },
    async confirmWorkerAttached() {},
  };
  await startRentalJob({
    state,
    job: { id: 'job-1', jobHash: 'h', serviceType: 'gpu-rental', amount },
    agentInfo: { id: 'gpu-1' },
    controller, provider: stubProvider(), client,
    signDeliver: ({ hash }) => ({ signature: 's', timestamp: 1, hash }),
    jobTimeoutMin,
    now,
  });
  state.computeSupply = controller;
  const lease = controller.getLeases().find((l) => l.jobId === 'job-1');
  return { state, controller, lease, deliverable: sealed[0] };
}

test('the lease honours the SELLER-CONFIGURED period, not a hardcoded hour', async () => {
  const { lease, deliverable } = await bootRental({ jobTimeoutMin: 180 });
  assert.equal(lease.expiresAt, NOW + 180 * MIN, 'a 180-minute rental must expire 180 minutes out');
  assert.equal(lease.rentalPeriodMin, 180);
  assert.match(deliverable.disclosure, /up to 180 minutes/);
});

test('the period falls back to 60 minutes only when the caller supplies none', async () => {
  const { lease } = await bootRental({});
  assert.equal(lease.expiresAt, NOW + 60 * MIN);
});

test('the period price is captured from the job amount at hire', async () => {
  const { lease } = await bootRental({ jobTimeoutMin: 60, amount: 2.5 });
  assert.equal(lease.rentalPeriodAmount, 2.5);
});

test('rentalExtensionGrant sells whole periods only and fails closed without a price', () => {
  assert.deepEqual(rentalExtensionGrant({ amount: 2, periodAmount: 2, periodMin: 60 }), { periods: 1, minutes: 60, ms: 60 * MIN });
  assert.deepEqual(rentalExtensionGrant({ amount: 6, periodAmount: 2, periodMin: 60 }), { periods: 3, minutes: 180, ms: 180 * MIN });
  // Under one period buys nothing — no pro-rata, matching the disclosed term.
  assert.equal(rentalExtensionGrant({ amount: 1.9, periodAmount: 2, periodMin: 60 }), null);
  // Decimal dust must not swallow a legitimate whole period.
  assert.deepEqual(rentalExtensionGrant({ amount: 0.1 + 0.2, periodAmount: 0.3, periodMin: 30 }), { periods: 1, minutes: 30, ms: 30 * MIN });
  // No price = no honest exchange rate.
  assert.equal(rentalExtensionGrant({ amount: 5, periodAmount: 0, periodMin: 60 }), null);
  assert.equal(rentalExtensionGrant({ amount: 5, periodAmount: null, periodMin: 60 }), null);
});

test('decideRentalExtension refuses before payment when the money buys nothing', async () => {
  const { lease } = await bootRental({ jobTimeoutMin: 60, amount: 2 });
  assert.equal(decideRentalExtension({ lease, amount: 2, now: NOW }).approve, true);
  const short = decideRentalExtension({ lease, amount: 1, now: NOW });
  assert.equal(short.approve, false);
  assert.match(short.reason, /at least one whole period/);
});

test('decideRentalExtension refuses a box that is gone or already expired', async () => {
  const { lease } = await bootRental({ jobTimeoutMin: 60, amount: 2 });
  assert.equal(decideRentalExtension({ lease: null, amount: 2, now: NOW }).approve, false);
  assert.equal(decideRentalExtension({ lease: { ...lease, state: 'released' }, amount: 2, now: NOW }).approve, false);
  const expired = decideRentalExtension({ lease, amount: 2, now: lease.expiresAt + 1 });
  assert.equal(expired.approve, false);
  assert.match(expired.reason, /already expired/);
});

test('a PAID extension pushes the lease expiry out, and is idempotent by extension id', async () => {
  const { state, controller, lease } = await bootRental({ jobTimeoutMin: 60, amount: 2 });
  const first = applyRentalExtension({ state, jobId: 'job-1', extensionId: 'ext-a', amount: 2, now: NOW });
  assert.equal(first.extended, true);
  assert.equal(first.changed, true);
  assert.equal(first.minutes, 60);
  assert.equal(first.expiresAt, lease.expiresAt + 60 * MIN, 'extension adds to the time already held');

  // The webhook and the poll fallback both deliver the same paid extension by design.
  const replay = applyRentalExtension({ state, jobId: 'job-1', extensionId: 'ext-a', amount: 2, now: NOW });
  assert.equal(replay.extended, true);
  assert.equal(replay.changed, false, 'a replayed extension must not buy a second hour');
  assert.equal(controller.getLeases().find((l) => l.jobId === 'job-1').expiresAt, lease.expiresAt + 60 * MIN);

  // A different extension is a different purchase.
  const second = applyRentalExtension({ state, jobId: 'job-1', extensionId: 'ext-b', amount: 4, now: NOW });
  assert.equal(second.changed, true);
  assert.equal(second.minutes, 120);
  assert.equal(second.expiresAt, lease.expiresAt + 180 * MIN);
});

test('an extension cannot resurrect an expired lease', async () => {
  const { state, lease } = await bootRental({ jobTimeoutMin: 60, amount: 2 });
  const r = applyRentalExtension({ state, jobId: 'job-1', extensionId: 'ext-late', amount: 2, now: lease.expiresAt + 1 });
  assert.equal(r.extended, false);
});

// ── Wiring. Every assertion below dies if its line is deleted from cli.js. ────────
const CLI = fs.readFileSync(require.resolve('../src/cli.js'), 'utf8');

test('cli.js passes the configured period into the rental lease', () => {
  const wired = CLI.slice(CLI.indexOf('async function startRentalJobWired'), CLI.indexOf('async function startJobOrRental'));
  assert.match(wired, /jobTimeoutMin:\s*cfgNow\.jobTimeoutMin/, 'the seller config must reach startRentalJob or rentals silently revert to 60 minutes');
});

test('cli.js applies a paid rental extension to the lease from BOTH delivery paths', () => {
  assert.match(CLI, /case 'job\.extension_paid':/, 'the paid webhook must be handled');
  const webhookCase = CLI.slice(CLI.indexOf("case 'job.extension_paid':"), CLI.indexOf("case 'job.extension_rejected':"));
  assert.match(webhookCase, /applyRentalExtension\(/);
  const poll = CLI.slice(CLI.indexOf('Poll-mode fallback: check for pending extension'), CLI.indexOf('Sweep queued reactivation entries'));
  assert.match(poll, /status === 'paid'/, 'the poll fallback must cover a dropped webhook — the box dies at expiry otherwise');
  assert.match(poll, /applyRentalExtension\(/);
});

test('cli.js decides rental extensions on the lease, not on host CPU/RAM', () => {
  const handler = CLI.slice(CLI.indexOf('async function handleExtensionRequest'), CLI.indexOf('Insert a job into the priority queue'));
  const rentalBranch = handler.indexOf("kind === 'gpu-rental'");
  const cpuGate = handler.indexOf('extensionMaxCpuPercent');
  assert.ok(rentalBranch > 0, 'rental jobs need their own decision');
  assert.ok(cpuGate > rentalBranch, 'the rental branch must return before the host-capacity gate');
  assert.match(handler.slice(rentalBranch, cpuGate), /decideRentalExtension\(/);
});
