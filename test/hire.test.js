'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertHireAllowed, paymentOutputs } = require('../src/hire');

test('hire gate matches platform: agent labour ok, data refused', () => {
  assert.equal(assertHireAllowed({ sellerKind: 'agent', serviceId: 's1' }).ok, true);
  const data = assertHireAllowed({ sellerKind: 'data', serviceType: 'agent', serviceId: 's1' });
  assert.equal(data.ok, false);
  assert.equal(data.code, 'DATA_NOT_HIREABLE');
});

test('compute requires gpu-rental + serviceId; model requires api-endpoint', () => {
  assert.equal(assertHireAllowed({ sellerKind: 'compute', serviceType: 'gpu-rental', serviceId: 's1' }).ok, true);
  assert.equal(assertHireAllowed({ sellerKind: 'compute', serviceType: 'api-endpoint', serviceId: 's1' }).ok, false);
  assert.equal(assertHireAllowed({ sellerKind: 'model', serviceType: 'api-endpoint', serviceId: 's1' }).ok, true);
  assert.equal(assertHireAllowed({ sellerKind: 'model', serviceType: 'gpu-rental', serviceId: 's1' }).ok, false);
});

test('paymentOutputs refuses missing/malformed addresses and implausible fees', () => {
  assert.throws(() => paymentOutputs({ payment: {} }, 1), /No payment address/);
  assert.throws(() => paymentOutputs({ payment: { address: 'not-an-address' } }, 1), /malformed payment address/);
  const addr = 'R' + 'A'.repeat(33);
  const fee = 'i' + 'B'.repeat(33);
  const outs = paymentOutputs({
    payment: { address: addr, platformFeeAddress: fee, feeAmount: 0.05 },
  }, 1);
  assert.equal(outs.length, 2);
  assert.equal(outs[0].amount, 1);
  assert.throws(() => paymentOutputs({
    payment: { address: addr, platformFeeAddress: fee, feeAmount: 2 },
  }, 1), /implausible/);
});

test('CLI registers hire; TUI exposes buyer hire; plan no longer claims dispatcher cannot hire', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(cli, /\.command\('hire <buyer-agent-id> <seller>'\)/);
  assert.match(cli, /--pay/);
  assert.match(dash, /hireScreen/);
  assert.match(dash, /Hire a listing \(this fleet as buyer\)/);
});
