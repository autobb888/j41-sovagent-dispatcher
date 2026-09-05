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
