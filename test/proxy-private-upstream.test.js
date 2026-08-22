'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkUpstreamHostSafe } = require('../src/proxy-handler');

const cfgGuardOn = { runtime: { allow_local_upstream: false } };

test('private IP is rejected by default (guard intact)', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', cfgGuardOn);
  assert.equal(r.safe, false);
});

test('private IP is permitted with per-lease allowPrivate, WITHOUT the global flag', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', cfgGuardOn, true);
  assert.equal(r.safe, true);
});

test('public IP is unaffected by allowPrivate=false', async () => {
  const r = await checkUpstreamHostSafe('1.1.1.1', cfgGuardOn, false);
  assert.equal(r.safe, true);
});

test('the global flag still opens the guard (unchanged)', async () => {
  const r = await checkUpstreamHostSafe('192.168.1.50', { runtime: { allow_local_upstream: true } });
  assert.equal(r.safe, true);
});
