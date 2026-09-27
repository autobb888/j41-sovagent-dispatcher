'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const utxolib = require('@bitgo/utxo-lib');
const {
  accountFile,
  readStoredAccount,
  writeStoredAccount,
  outputScriptFor,
  paramsMatch,
  lightwalletdTarget,
} = require('../src/shield-live');

test('the account file is mode 0600 and is not replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-shield-'));
  const file = accountFile(dir, 'labour-1');
  writeStoredAccount(file, { seedHex: 'ab'.repeat(64), birthdayHeight: 10 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = readStoredAccount(file);
  assert.equal(stored.seedHex, 'ab'.repeat(64));
  assert.equal(stored.birthdayHeight, 10);
  assert.throws(() => writeStoredAccount(file, { seedHex: 'cd'.repeat(64), birthdayHeight: 11 }));
  assert.equal(readStoredAccount(file).seedHex, 'ab'.repeat(64));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('coin type 1 in the account file is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-shield-'));
  const file = accountFile(dir, 'labour-1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    coinType: 1,
    account: 0,
    seedHex: 'ab'.repeat(64),
    birthdayHeight: 1,
  }), { mode: 0o600 });
  assert.equal(readStoredAccount(file).invalid, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the output script is the P2PKH of the R-address', () => {
  const key = utxolib.ECPair.makeRandom({ network: utxolib.networks.verustest });
  const address = utxolib.address.fromOutputScript(
    utxolib.address.toOutputScript(key.getAddress(), utxolib.networks.verustest),
    utxolib.networks.verustest,
  );
  assert.equal(outputScriptFor(address, 'verustest'), utxolib.address.toOutputScript(address, utxolib.networks.verustest).toString('hex'));
});

test('a parameter directory with the wrong hash is not usable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-shield-'));
  fs.writeFileSync(path.join(dir, 'sapling-spend.params'), 'nope');
  fs.writeFileSync(path.join(dir, 'sapling-output.params'), 'nope');
  assert.equal(paramsMatch(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lightwalletd URL keeps its host and the plaintext bit', () => {
  assert.deepEqual(lightwalletdTarget('light.example:9067'), { address: 'light.example:9067', insecure: false });
  assert.deepEqual(lightwalletdTarget('http://127.0.0.1:9067'), { address: '127.0.0.1:9067', insecure: true });
  assert.equal(lightwalletdTarget(''), null);
});
