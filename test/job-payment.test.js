'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { jobPaymentReady } = require('../src/job-payment');

test('accepted unpaid is not ready; in_progress and verified are', () => {
  assert.equal(jobPaymentReady({ status: 'accepted', payment: { verified: false } }), false);
  assert.equal(jobPaymentReady({ status: 'accepted' }), false);
  assert.equal(jobPaymentReady({ status: 'requested', payment: { verified: false } }), false);
  assert.equal(jobPaymentReady({ status: 'in_progress' }), true);
  assert.equal(jobPaymentReady({ status: 'accepted', payment: { verified: true } }), true);
  assert.equal(jobPaymentReady({ status: 'accepted', payment: { status: 'confirmed' } }), true);
  assert.equal(jobPaymentReady({ status: 'accepted', payment: { status: 'completed' } }), true);
  assert.equal(jobPaymentReady({ status: 'accepted' }, { allowUnpriced: true }), true);
  assert.equal(jobPaymentReady({ status: 'accepted', payment: { verified: false } }, { allowUnpriced: true }), false);
});

test('cli startJobOrRental and webhook job.started gate on jobPaymentReady', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /jobPaymentReady/);
  const startFn = cli.slice(cli.indexOf('async function startJobOrRental'), cli.indexOf('async function startJobOrRental') + 900);
  assert.match(startFn, /jobPaymentReady/);
  const webhookStart = cli.slice(cli.indexOf("case 'job.started'"), cli.indexOf("case 'file.uploaded'"));
  assert.match(webhookStart, /jobPaymentReady/);
});

test('start logs when a saved profile has no service', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /has a profile but no service — buyers cannot hire it/);
  assert.match(cli, /retryRegisterWithJ41/);
});
