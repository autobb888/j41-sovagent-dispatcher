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
  assert.match(cli, /\.command\('review-session <buyer-agent-id> <seller>'\)/);
  assert.match(cli, /REVIEW_SESSION_UNSUPPORTED/);
  assert.match(cli, /submitBuyerApiSessionReview/);
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

test('pay --wait polls resolveWalletPending AFTER broadcast, not only before', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('pay <buyer-agent-id> <job-id>')");
  const end = cli.indexOf(".command('complete <buyer-agent-id> <job-id>')", start);
  const paySrc = cli.slice(start, end);
  const save = paySrc.indexOf('saveWalletPending(');
  assert.ok(save > -1, 'pay must stamp wallet-pending.json after broadcast');
  const waitAfter = paySrc.indexOf('waitWalletPendingUnlink(', save);
  assert.ok(waitAfter > save, 'pay --wait must poll the NEW tx after saveWalletPending');
  assert.match(paySrc.slice(waitAfter), /PAY_WAIT_TIMEOUT/);
  assert.match(paySrc.slice(waitAfter), /pending:\s*stillPending/);
});

test('hire --pay --wait also waits after broadcast; planHirePayment stays before createJob', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('hire <buyer-agent-id> <seller>')");
  const end = cli.indexOf(".command('buyers')", start);
  const hireSrc = cli.slice(start, end);
  const plan = hireSrc.indexOf('planHirePayment(');
  const create = hireSrc.indexOf('createJob(');
  const save = hireSrc.indexOf('saveWalletPending(');
  assert.ok(plan > -1 && plan < create, 'PAY_PENDING gate stays before createJob');
  assert.ok(save > create, 'stamp is after create+broadcast');
  const waitAfter = hireSrc.indexOf('waitWalletPendingUnlink(', save);
  assert.ok(waitAfter > save, 'hire --pay --wait must poll the NEW tx after saveWalletPending');
  assert.match(hireSrc, /PAY_WAIT_TIMEOUT/);
});

test('extend source plans hire payment BEFORE sendMultiPayment', () => {
  const ext = fs.readFileSync(path.join(__dirname, '../src/buyer-extend.js'), 'utf8');
  const plan = ext.indexOf('planHirePayment(');
  const send = ext.indexOf('sendMultiPayment(');
  assert.ok(plan > -1, 'extend no longer calls planHirePayment');
  assert.ok(send > -1, 'extend no longer calls sendMultiPayment');
  assert.ok(plan < send, 'planHirePayment must run BEFORE sendMultiPayment');
  assert.match(ext, /kind:\s*'extension'/);
  assert.match(ext, /payExtension\(/);
  assert.match(ext, /requestExtension\(/);
  const req = ext.indexOf('requestExtension(');
  const pay = ext.indexOf('payExtension(');
  assert.ok(req > -1 && pay > -1 && req < pay, 'requestExtension then payExtension');
});
