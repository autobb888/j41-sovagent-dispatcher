'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { paymentOutputs, assertPaysJobAddress, identityReceivingAddresses, loadSellerRecipientSet } = require('../src/hire');
const { buildMultiPayment, buildP2IDScript, generateKeypair } = require('@junction41/sovagent-sdk/dist/index.js');

const I_ADDRESS = 'iR7vcjyjdA1RpynjzBggBt7fHe2wmA4gyN';
const PRIMARY_R = 'RFzAZGqmJRwYQz3Y7FwYJVD5mnNGZXRDY6';

test('paymentOutputs and the pay guard keep job.payment.address', () => {
  const job = { payment: { address: I_ADDRESS } };
  const outputs = paymentOutputs(job, 0.05);
  assert.equal(outputs[0].address, I_ADDRESS);
  assert.equal(assertPaysJobAddress(outputs, job), outputs);
  assert.throws(
    () => assertPaysJobAddress([{ address: PRIMARY_R, amount: 0.05 }], job),
    /PAY_ADDRESS_MISMATCH: seller output is not job\.payment\.address/,
  );
  assert.throws(() => assertPaysJobAddress(outputs, { payment: {} }), /PAY_ADDRESS_MISMATCH/);
});

test('both pay paths assert the job address immediately before sendMultiPayment', () => {
  const cli = fs.readFileSync('src/cli.js', 'utf8');
  const sites = [];
  let from = 0;
  while (from < cli.length) {
    const at = cli.indexOf('agent.sendMultiPayment(outputs)', from);
    if (at < 0) break;
    sites.push(at);
    from = at + 1;
  }
  assert.equal(sites.length, 2);
  for (const at of sites) {
    const window = cli.slice(Math.max(0, at - 500), at);
    assert.match(window, /assertPaysJobAddress\(outputs, job\)/);
  }
});

test('identityReceivingAddresses keeps the i-address and every primary R, and drops z', () => {
  const second = 'RSecondPrimary111111111111111111111';
  const list = identityReceivingAddresses({
    iaddress: I_ADDRESS,
    primaryAddresses: [PRIMARY_R, second, 'zs1secret'],
  }, [I_ADDRESS, 'zs1extra', PRIMARY_R]);
  assert.deepEqual(list, [I_ADDRESS, PRIMARY_R, second]);
});

test('a failed identity lookup keeps the addresses already resolved', async () => {
  const client = { getIdentityKeys: async () => { throw new Error('down'); } };
  const list = await loadSellerRecipientSet(client, I_ADDRESS, [PRIMARY_R, I_ADDRESS, 'zs1nope']);
  assert.deepEqual(list, [PRIMARY_R, I_ADDRESS]);
});

test('seller identity keys add every primary R to the spend-gate list', async () => {
  const second = 'RSecondPrimary111111111111111111111';
  const client = {
    getIdentityKeys: async (id) => {
      assert.equal(id, I_ADDRESS);
      return { iaddress: I_ADDRESS, primaryAddresses: [PRIMARY_R, second, 'zs1secret'] };
    },
  };
  const list = await loadSellerRecipientSet(client, I_ADDRESS, [PRIMARY_R]);
  assert.deepEqual(list, [I_ADDRESS, PRIMARY_R, second]);
});

test('autonomous pay asks for the seller identity, not the logged-in raw identity', () => {
  const cli = fs.readFileSync('src/cli.js', 'utf8');
  const extend = fs.readFileSync('src/buyer-extend.js', 'utf8');
  assert.equal(cli.split('loadSellerRecipientSet(').length - 1, 2);
  assert.equal(extend.split('loadSellerRecipientSet(').length - 1, 1);
  const hireAt = cli.indexOf("command('hire <buyer-agent-id> <seller>')");
  const payAt = cli.indexOf("command('pay <buyer-agent-id> <job-id>')");
  assert.ok(hireAt > -1 && payAt > hireAt);
  const hirePay = cli.slice(hireAt, payAt);
  assert.equal(hirePay.includes('loadSellerRecipientSet('), true);
  assert.equal(hirePay.includes('getIdentityRaw('), false);
});

test('an i-address payment script matches buildP2IDScript and is not P2PKH', () => {
  const kp = generateKeypair('verustest');
  const p2id = buildP2IDScript(I_ADDRESS);
  assert.equal(p2id.length, 36);
  const raw = buildMultiPayment({
    wif: kp.wif,
    outputs: [{ address: I_ADDRESS, amount: 0.05 }],
    utxos: [{ txid: '11'.repeat(32), vout: 0, satoshis: 100000000 }],
    network: 'verustest',
    changeAddress: kp.address,
  });
  assert.equal(typeof raw, 'string');
  assert.ok(raw.includes(p2id.toString('hex')));
  const idHash = p2id.subarray(p2id.length - 21, p2id.length - 1);
  assert.equal(idHash.length, 20);
  const p2pkh = `76a914${idHash.toString('hex')}88ac`;
  assert.equal(raw.includes(p2pkh), false);
  assert.equal(p2id[p2id.length - 1], 0x75);
});
