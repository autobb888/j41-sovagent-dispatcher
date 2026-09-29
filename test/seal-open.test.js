'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStoredZip } = require('../src/delivery-package');
const { sealOuterZip } = require('../src/seal-package');
const { storeJobKey } = require('../src/seal-address-store');
const { openSealedPackage } = require('../src/seal-open');

test('seal-open writes the inner answer and does not return the viewing key', async () => {
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const { pathToFileURL } = require('url');
  const { z_getEncryptionAddress } = await import(pathToFileURL(path.join(__dirname, '../src/vendor/veruszsupportlib/index.mjs')).href);
  const keys = z_getEncryptionAddress({
    seed: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    fromId: new Uint8Array(20).fill(2),
    toId: new Uint8Array(20).fill(3),
    encryptionIndex: 0,
    returnSecret: false,
  });
  const addressHex = Buffer.from(keys.address).toString('hex');
  const ivk = Buffer.from(keys.ivk);
  const jobId = '7f74d5d3-13c2-49c0-9024-a405ad7319b4';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-open-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  storeJobKey(dir, jobId, addressHex, ivk);
  const inner = buildStoredZip([{ name: 'answer.txt', data: Buffer.from('the maple sentence') }]);
  const pkg = await sealOuterZip(inner, addressHex);
  const entries = require('../src/delivery-package').readStoredZip(pkg.body);
  fs.writeFileSync(path.join(out, 'seal.bin'), entries.find((entry) => entry.name === 'seal.bin').data);
  const result = await openSealedPackage({ agentDir: dir, jobId, outDir: out });
  assert.equal(result.code, 'SEAL_OPENED');
  assert.deepEqual(result.files, ['answer.txt']);
  assert.equal(fs.readFileSync(path.join(out, 'answer.txt'), 'utf8'), 'the maple sentence');
  assert.equal(fs.existsSync(path.join(out, 'inner.zip')), true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `seal-${jobId}.json`), 'utf8'));
  assert.equal(JSON.stringify(result).includes(onDisk.ivkHex), false);
});
