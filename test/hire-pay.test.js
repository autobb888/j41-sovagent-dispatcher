'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { planHirePayment } = require('../src/hire-pay');

test('planHirePayment refuses an in-flight stamp and --force passes', () => {
  const now = 1_000_000;
  const blocked = planHirePayment({
    pending: { txid: 'abc', at: now - 60_000, kind: 'hire-pay' },
    now,
    force: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'PAY_PENDING');
  const forced = planHirePayment({
    pending: { txid: 'abc', at: now - 60_000, kind: 'hire-pay' },
    now,
    force: true,
  });
  assert.equal(forced.ok, true);
  const clear = planHirePayment({ pending: null, now, force: false });
  assert.equal(clear.ok, true);
  const malformed = planHirePayment({ pending: { at: null }, now, force: false });
  assert.equal(malformed.ok, false);
});

test('hire create-only copy does not say Pay later with --pay; CLI has pay complete review', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.doesNotMatch(cli, /Pay later with --pay/);
  assert.match(cli, /planHirePayment/);
  assert.match(cli, /saveWalletPending/);
  assert.match(cli, /\.command\('pay <buyer-agent-id> <job-id>'\)/);
  assert.match(cli, /\.command\('complete <buyer-agent-id> <job-id>'\)/);
  assert.match(cli, /\.command\('review <buyer-agent-id> <job-id>'\)/);
  assert.match(cli, /REVIEW_NOT_CANONICAL/);
});

test('hire --pay gates wallet-pending BEFORE createJob (no unpaid leftover on PAY_PENDING)', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('hire <buyer-agent-id> <seller>')");
  const end = cli.indexOf(".command('buyers')", start);
  const hireSrc = cli.slice(start, end);
  const plan = hireSrc.indexOf('planHirePayment(');
  const create = hireSrc.indexOf('createJob(');
  assert.ok(plan > -1, 'hire no longer calls planHirePayment');
  assert.ok(create > -1, 'hire no longer calls createJob');
  assert.ok(plan < create, 'planHirePayment must run BEFORE createJob so PAY_PENDING cannot mint an unpaid job');
  assert.match(hireSrc, /\.option\('--wait'/);
  const afterCreate = hireSrc.slice(create);
  assert.doesNotMatch(afterCreate, /planHirePayment\(/,
    'a second planHirePayment after createJob reintroduces the leftover-job bug');
});
