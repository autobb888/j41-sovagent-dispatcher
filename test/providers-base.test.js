'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ComputeProvider } = require('../src/providers/base');

test('base ComputeProvider throws not-implemented for every method', async () => {
  const p = new ComputeProvider();
  await assert.rejects(() => p.discover({}), /not implemented/);
  await assert.rejects(() => p.acquire({}, {}), /not implemented/);
  await assert.rejects(() => p.waitReady({}, { timeoutMs: 1 }), /not implemented/);
  await assert.rejects(() => p.probe({}), /not implemented/);
  await assert.rejects(() => p.release({}), /not implemented/);
  assert.throws(() => p.describeCost({}), /not implemented/);
  assert.throws(() => p.capabilities, /not implemented/);
});
