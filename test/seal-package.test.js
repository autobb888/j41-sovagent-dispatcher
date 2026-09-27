'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStoredZip, readStoredZip } = require('../src/delivery-package');
const { sealOuterZip, INNER_CAP } = require('../src/seal-package');

test('sealOuterZip uploads README.txt and seal.bin, not answer.txt', async () => {
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const { pathToFileURL } = require('url');
  const { z_getEncryptionAddress } = await import(pathToFileURL(require('path').join(__dirname, '../src/vendor/veruszsupportlib/index.mjs')).href);
  const keys = z_getEncryptionAddress({
    seed: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    fromId: new Uint8Array(20).fill(2),
    toId: new Uint8Array(20).fill(3),
    encryptionIndex: 0,
    returnSecret: false,
  });
  assert.equal(keys.spendingKey, null);
  const addressHex = Buffer.from(keys.address).toString('hex');
  const inner = buildStoredZip([{ name: 'answer.txt', data: Buffer.from('the answer') }]);
  const pkg = await sealOuterZip(inner, addressHex);
  assert.equal(pkg.sealed, true);
  assert.equal(pkg.upload, true);
  assert.equal(pkg.tooBig, false);
  assert.ok(pkg.body.length < INNER_CAP);
  const names = readStoredZip(pkg.body).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['README.txt', 'seal.bin']);
  assert.equal(pkg.body.includes(Buffer.from('the answer')), false);
});
