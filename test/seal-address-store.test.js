'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSeed, storeJobKey } = require('../src/seal-address-store');
const { deriveJobAddress, publishBuyerSealAddress, publishSellerSealAddress } = require('../src/seal-address-run');
const { sealChatArmor, openChatArmor } = require('../src/seal-chat');
const { shouldSealDelivery } = require('../src/seal-package');
const { buyerOwnsJob, sellerOwnsJob } = require('../src/hire-pay');

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

test('the seller post carries a different address and not the viewing key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-seal-seller-'));
  const jobId = '7f74d5d3-13c2-49c0-9024-a405ad7319b4';
  const posted = [];
  const result = await publishSellerSealAddress({
    agentDir: dir,
    sellerId: 'iSeller',
    jobId,
    yes: true,
    post: async (addressHex) => {
      posted.push(addressHex);
      return { data: { stored: true } };
    },
  });
  assert.equal(result.role, 'seller');
  assert.equal(result.posted, true);
  assert.equal(result.addressHex.length, 86);
  assert.deepEqual(posted, [result.addressHex]);
  assert.equal('ivk' in result, false);
  assert.equal('ivkHex' in result, false);
  assert.equal(fs.statSync(result.keyFile).mode & 0o777, 0o600);
  const onDisk = JSON.parse(fs.readFileSync(result.keyFile, 'utf8'));
  assert.equal(JSON.stringify(result).includes(onDisk.ivkHex), false);
  const again = await publishSellerSealAddress({
    agentDir: dir,
    sellerId: 'iSeller',
    jobId,
    yes: true,
    post: async () => ({ data: { stored: true } }),
  });
  assert.equal(again.created, false);
  assert.equal(again.addressHex, result.addressHex);
});

test('buyer and seller derivations for one job differ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-seal-role-'));
  const seed = ensureSeed(dir);
  const jobId = '7f74d5d3-13c2-49c0-9024-a405ad7319b4';
  const buyer = await deriveJobAddress(seed, 'iBuyer', jobId, 'buyer');
  const seller = await deriveJobAddress(seed, 'iSeller', jobId, 'seller');
  assert.equal(buyer.addressHex.length, 86);
  assert.equal(seller.addressHex.length, 86);
  assert.notEqual(buyer.addressHex, seller.addressHex);
  buyer.ivk.fill(0);
  seller.ivk.fill(0);
});

test('chat armor opens only with the recipient viewing key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-seal-chat-'));
  const seed = ensureSeed(dir);
  const jobId = '7f74d5d3-13c2-49c0-9024-a405ad7319b4';
  const seller = await deriveJobAddress(seed, 'iSeller', jobId, 'seller');
  const buyer = await deriveJobAddress(seed, 'iBuyer', jobId, 'buyer');
  const armor = await sealChatArmor(seller.addressHex, 'oak crate pong');
  assert.equal(armor.includes('oak crate pong'), false);
  assert.equal(await openChatArmor(armor, seller.ivk), 'oak crate pong');
  await assert.rejects(() => openChatArmor(armor, buyer.ivk), (err) => err.code === 'CHAT_SEAL_UNREADABLE');
  seller.ivk.fill(0);
  buyer.ivk.fill(0);
});

test('seller ownership follows sellerVerusId', () => {
  const keys = { identity: 'pippinwork.agentplatform@', iAddress: 'iR7vcjyjdA1RpynjzBggBt7fHe2wmA4gyN' };
  const job = {
    buyerVerusId: 'iBuyer',
    sellerVerusId: 'iR7vcjyjdA1RpynjzBggBt7fHe2wmA4gyN',
  };
  assert.equal(sellerOwnsJob(keys, job), true);
  assert.equal(buyerOwnsJob(keys, job), false);
  assert.equal(sellerOwnsJob(keys, { sellerVerusId: 'iOther' }), false);
});

test('gpu and data jobs are not sealed', () => {
  const hex = 'ab'.repeat(43);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: hex, serviceType: 'agent' }), true);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: hex, serviceType: 'gpu-rental' }), false);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: hex, datasetTerms: { rows: 1 } }), false);
  assert.equal(shouldSealDelivery({ buyerSealAddressHex: 'cd'.repeat(32) }), false);
});
