'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createOrchardDoor } = require('../src/dataset-door');

const docPath = path.join(__dirname, '../templates/orchard-apples.json');
const secret = 'door-test-secret';
const HASH = 'platform-hash';

function job(overrides = {}) {
  return {
    id: 'job-1',
    buyerVerusId: 'russethire.agentplatform@',
    payment: { verified: true },
    reviewWindowExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    datasetTerms: {
      color: 'red',
      kind: '',
      taste: 'sweet',
      q: '',
      hash: HASH,
      canonical: JSON.stringify({ color: 'red', kind: '', taste: 'sweet', q: '' }),
    },
    ...overrides,
  };
}

function doorFor(current) {
  return createOrchardDoor({
    docPath,
    secret,
    verifyMessage: (message, address, signature) => signature === `ok:${message}:${address}`,
    getJob: async () => current,
  });
}

test('the bearer is minted only for a verified job whose review window is open', async () => {
  const paid = doorFor(job());
  const opened = await paid.openGrant({
    jobId: 'job-1',
    timestamp: 1,
    signature: 'ok:J41-DATA-OPEN|Job:job-1|Ts:1|Buyer:russethire.agentplatform@:Rbuyer',
    address: 'Rbuyer',
    buyer: 'russethire.agentplatform@',
    iAddress: 'iBuyer',
  });
  assert.equal(typeof opened.token, 'string');
  assert.equal(JSON.stringify(opened).includes('Fuji'), false);

  const unpaid = doorFor(job({ payment: { verified: false, status: 'confirmed' } }));
  const deniedPay = await unpaid.openGrant({
    jobId: 'job-1', timestamp: 1,
    signature: 'ok:J41-DATA-OPEN|Job:job-1|Ts:1|Buyer:russethire.agentplatform@:Rbuyer',
    address: 'Rbuyer', buyer: 'russethire.agentplatform@',
  });
  assert.equal(deniedPay.error, 'DATA_NOT_PAID');

  const early = doorFor(job({ reviewWindowExpiresAt: null }));
  const deniedWindow = await early.openGrant({
    jobId: 'job-1', timestamp: 1,
    signature: 'ok:J41-DATA-OPEN|Job:job-1|Ts:1|Buyer:russethire.agentplatform@:Rbuyer',
    address: 'Rbuyer', buyer: 'russethire.agentplatform@',
  });
  assert.equal(deniedWindow.error, 'DATA_NOT_PAID');
});

test('rows follow the paid terms and a different filter returns nothing', async () => {
  const door = doorFor(job());
  const { token } = await door.openGrant({
    jobId: 'job-1', timestamp: 1,
    signature: 'ok:J41-DATA-OPEN|Job:job-1|Ts:1|Buyer:russethire.agentplatform@:Rbuyer',
    address: 'Rbuyer', buyer: 'russethire.agentplatform@',
  });
  const rows = await door.rowsForToken(token, new URLSearchParams());
  assert.ok(rows.count >= 1);
  assert.equal(rows.items.every((row) => row.color === 'red' && row.taste === 'sweet'), true);
  assert.equal(rows.items.some((row) => row.kind === 'Fuji'), true);
  assert.equal(rows.items.some((row) => row.kind === 'Granny Smith'), false);

  const other = new URLSearchParams({ color: 'green', taste: 'tart' });
  assert.equal(await door.rowsForToken(token, other), null);
  assert.equal(await door.rowsForToken('not-a-token', new URLSearchParams()), null);
});
