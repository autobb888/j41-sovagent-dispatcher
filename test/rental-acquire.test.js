'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rental-acq-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { createSupplyController } = require('../src/compute-supply');
const { acquireRentalLease } = require('../src/rental-job');

function sshProvider() {
  return {
    get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; },
    async discover(spec) { assert.equal(spec.interruptible, false); return [{ provider: 'vast', usdPerHour: 0.3, gpu: { name: 'A100' }, meta: { askId: 1 } }]; },
    async acquire(c) { return { id: 'vast:r1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, baseUrl: null, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'ready', ssh: { host: '9.9.9.9', port: 22, user: 'root' } }; },
    async release(l) { return { ...l, state: 'released' }; },
  };
}

test('acquireRentalLease pins on-demand, binds the job, sets expiry, returns credentials', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map(), now: () => 1000 });
  const { lease, deliverable } = await acquireRentalLease({
    controller: ctrl, provider: sshProvider(), spec: { minVramGb: 40 }, jobId: 'job-1', agentId: 'agent-1', jobTimeoutMin: 60, now: 1000,
  });
  assert.equal(lease.jobId, 'job-1');
  assert.equal(lease.expiresAt, 1000 + 60 * 60000);
  assert.equal(deliverable.ssh.host, '9.9.9.9');
  assert.match(deliverable.disclosure, /all-or-nothing/i);
  assert.equal(ctrl.getLeases().length, 1);
  assert.equal(ctrl.getLeases()[0].jobId, 'job-1');
});

test('acquireRentalLease refuses a canSsh:false provider (never SSH into a home LAN)', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map() });
  const noSsh = { capabilities: { canSsh: false }, async discover() { return []; } };
  await assert.rejects(() => acquireRentalLease({ controller: ctrl, provider: noSsh, spec: {}, jobId: 'j', agentId: 'a', jobTimeoutMin: 60 }), /RENTAL_NO_SSH/);
});

test('acquireRentalLease respects the spend ceiling', async () => {
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 0.1, providers: {} } }, agentConfigs: new Map() });
  await assert.rejects(() => acquireRentalLease({ controller: ctrl, provider: sshProvider(), spec: {}, jobId: 'j', agentId: 'a', jobTimeoutMin: 60 }), /CEILING_EXCEEDED/);
});

test('M4/C4: a box that fails to come up is released, not delivered as ssh:null', async () => {
  const released = [];
  const provider = {
    get capabilities() { return { canProvision: true, canSsh: true, isElastic: true }; },
    async discover() { return [{ provider: 'vast', usdPerHour: 0.3, gpu: {}, meta: { askId: 1 } }]; },
    async acquire(c) { return { id: 'vast:r1', provider: 'vast', state: 'pending', usdPerHour: c.usdPerHour, ssh: null, meta: {} }; },
    async waitReady(l) { return { ...l, state: 'degraded', ssh: null }; }, // never came up
    async release(l) { released.push(l.id); return { ...l, state: 'released' }; },
  };
  const ctrl = createSupplyController({ cfg: { compute: { enabled: true, max_usd_per_hour: 1, providers: {} } }, agentConfigs: new Map() });
  await assert.rejects(() => acquireRentalLease({ controller: ctrl, provider, spec: {}, jobId: 'j', agentId: 'a', jobTimeoutMin: 60 }), /RENTAL_NOT_READY/);
  assert.ok(released.includes('vast:r1'), 'the failed box was released (no dangling charge)');
});
