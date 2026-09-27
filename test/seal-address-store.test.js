'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSeed, storeJobKey } = require('../src/seal-address-store');
const { publishBuyerSealAddress } = require('../src/seal-address-run');
const { shouldSealDelivery } = require('../src/seal-package');

test('a seal key file is created once and the public result has no viewing key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-seal-'));
  const seed = ensureSeed(dir);
  assert.equal(seed.length, 32);
  assert.equal(ensureSeed(dir).equals(seed), true);
  assert.equal(fs.statSync(path.join(dir, 'seal-seed.json')).mode & 0o777, 0o600);
  const ivk = Buffer.alloc(32, 7);
  const address = 'ab'.repeat(43);
  const jobId = 'fc161e1a-b7cf-44db-aed4-a7462f2a90dc';
  const first = storeJobKey(dir, jobId, address, ivk);
  assert.equal(first.created, true);
  assert.equal(first.addressHex, address);
  assert.equal('ivk' in first, false);
  assert.equal('ivkHex' in first, false);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  const again = storeJobKey(dir, jobId, 'cd'.repeat(43), Buffer.alloc(32, 9));
  assert.equal(again.created, false);
  assert.equal(again.addressHex, address);
  const onDisk = JSON.parse(fs.readFileSync(first.path, 'utf8'));
  assert.equal(onDisk.ivkHex, ivk.toString('hex'));
});

test('the posted result carries the address and not the viewing key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-seal-'));
  const jobId = 'fc161e1a-b7cf-44db-aed4-a7462f2a90dc';
  const result = await publishBuyerSealAddress({
    agentDir: dir,
    buyerId: 'iBuyer',
    jobId,
    yes: true,
    post: async () => ({ data: { stored: true } }),
  });
  assert.equal(result.posted, true);
  assert.equal(result.addressHex.length, 86);
  assert.equal('ivk' in result, false);
  assert.equal('ivkHex' in result, false);
  const onDisk = JSON.parse(fs.readFileSync(result.keyFile, 'utf8'));
  assert.equal(JSON.stringify(result).includes(onDisk.ivkHex), false);
});

test('gpu and data jobs are not sealed', () => {
  const hex = 'ab'.repeat(43);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: hex, serviceType: 'agent' }), true);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: hex, serviceType: 'gpu-rental' }), false);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: hex, datasetTerms: { rows: 1 } }), false);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: 'cd'.repeat(32) }), false);
});
