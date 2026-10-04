'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
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

function doorFor(current, file = docPath, opts = {}) {
  return createOrchardDoor({
    docPath: file,
    maxBytes: opts.maxBytes,
    secret,
    verifyMessage: (message, address, signature) => signature === `ok:${message}:${address}`,
    getJob: async () => current,
  });
}

async function openToken(door) {
  return door.openGrant({
    jobId: 'job-1', timestamp: 1,
    signature: 'ok:J41-DATA-OPEN|Job:job-1|Ts:1|Buyer:russethire.agentplatform@:Rbuyer',
    address: 'Rbuyer', buyer: 'russethire.agentplatform@',
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

test('dataset open returns at most 100 rows and reads the file once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-door-'));
  const file = path.join(dir, 'apples.json');
  try {
    const matching = [];
    for (let i = 0; i < 101; i += 1) {
      matching.push({ kind: `Row ${i}`, color: 'red', taste: 'sweet' });
    }
    fs.writeFileSync(file, JSON.stringify({ items: matching }));
    const door = doorFor(job(), file);
    const { token } = await door.openGrant({
      jobId: 'job-1', timestamp: 1,
      signature: 'ok:J41-DATA-OPEN|Job:job-1|Ts:1|Buyer:russethire.agentplatform@:Rbuyer',
      address: 'Rbuyer', buyer: 'russethire.agentplatform@',
    });
    const rows = await door.rowsForToken(token, new URLSearchParams());
    assert.equal(rows.items.length, 100);
    assert.equal(rows.truncated, true);
    assert.equal(rows.count, 101);
    fs.writeFileSync(file, '[]');
    const again = await door.rowsForToken(token, new URLSearchParams());
    assert.equal(again.items.length, 100);
    assert.equal(again.truncated, true);
    assert.equal(again.count, 101);
    const page2 = await door.rowsForToken(token, new URLSearchParams({ offset: '100' }));
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].kind, 'Row 100');
    assert.equal(page2.truncated, false);
    assert.equal(page2.nextOffset, null);
    assert.equal(page2.count, 101);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a line-oriented file pages without loading every row into one response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-jsonl-'));
  const file = path.join(dir, 'rows.jsonl');
  try {
    const lines = [];
    for (let i = 0; i < 250; i += 1) {
      const color = i === 3 ? 'green' : 'red';
      lines.push(JSON.stringify({ kind: `Row ${i}`, color, taste: 'sweet' }));
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const door = doorFor(job(), file);
    const { token } = await openToken(door);
    const page = await door.rowsForToken(token, new URLSearchParams({ offset: '200' }));
    assert.equal(page.count, 249);
    assert.equal(page.items.length, 49);
    assert.equal(page.items[0].kind, 'Row 201');
    assert.equal(page.truncated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a JSON document over the size cap is refused instead of parsed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-big-'));
  const file = path.join(dir, 'big.json');
  try {
    fs.writeFileSync(file, `{${'x'.repeat(80)}`);
    const door = doorFor(job(), file, { maxBytes: 40 });
    const { token } = await openToken(door);
    const rows = await door.rowsForToken(token, new URLSearchParams());
    assert.equal(rows.error, 'DATASET_TOO_LARGE');
    assert.equal(rows.maxBytes, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
