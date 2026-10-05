'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const contract = require('../src/buyer-contract');

test('json mode keeps one object on stdout and sends banners to stderr', () => {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = console.error;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  console.error = (...args) => { err.push(args.map(String).join(' ')); };
  try {
    contract.installBuyerJsonMode();
    console.log('[J41] ✅ Authenticated');
    console.log(JSON.stringify({ ok: true, jobId: 'keep' }, null, 2));
    contract.emitBuyerJson({ ok: false, code: 'NOPE', message: 'no' });
  } finally {
    contract.restoreBuyerJsonMode();
    process.stdout.write = origOut;
    console.error = origErr;
  }
  assert.match(err.join('\n'), /\[J41\] ✅ Authenticated/);
  const docs = out.join('').trim().split('\n}\n').map((part, i, all) => (i < all.length - 1 ? `${part}\n}` : part));
  const parsed = out.join('').trim().split(/(?<=\})\n(?=\{)/).map((chunk) => JSON.parse(chunk));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].jobId, 'keep');
  assert.equal(parsed[0].contractVersion, undefined);
  assert.equal(parsed[1].contractVersion, 1);
  assert.equal(parsed[1].code, 'NOPE');
  assert.equal(docs.length > 0, true);
});

test('a witnessed record keeps the signature height and the canonical record', () => {
  const view = contract.presentWitness({
    record: { jobHash: 'abc', buyerVerusId: 'buyer@', completedAt: '2026-10-05T00:00:00.000Z' },
    witness: { signatureHeight: 42, signedByName: 'agentplatform@', signature: 'sig', signedBy: 'iAddr' },
  });
  assert.equal(view.signatureHeight, 42);
  assert.equal(view.signedByName, 'agentplatform@');
  assert.equal(view.record.buyerVerusId, 'buyer@');
  assert.equal(view.signature, 'sig');
});

test('publish view names each written item and leaves identity height unknown', () => {
  const view = contract.publishView({
    jobId: '11111111-1111-4111-8111-111111111111',
    jobHash: 'hash',
    result: {
      ok: true,
      code: 'BUYER_INBOX_PUBLISHED',
      txids: ['tx'],
      accepted: { job_record: 1, review: 0, attestation: 0 },
      items: [{ type: 'job_record', txid: 'tx', jobHash: 'hash' }],
    },
  });
  assert.equal(view.txid, 'tx');
  assert.equal(view.items[0].jobId, '11111111-1111-4111-8111-111111111111');
  assert.equal(view.items[0].jobHash, 'hash');
  assert.equal(view.items[0].identityHeight, null);
});

test('complete retry returns the stored receipt and does not require another publish', () => {
  const stored = { publish: { txid: 'old' } };
  const again = contract.decideCompleteReceipt({
    already: true,
    shielded: false,
    publish: { ok: true, code: 'BUYER_INBOX_EMPTY', txid: null },
    stored,
  });
  assert.equal(again.ok, true);
  assert.equal(again.code, 'COMPLETE_ALREADY');
  assert.equal(again.useStored, true);
  assert.equal(again.exitCode, 0);
  const fresh = contract.decideCompleteReceipt({
    already: false,
    shielded: false,
    publish: { ok: true, code: 'BUYER_INBOX_PUBLISHED', txid: 'new' },
    stored: null,
  });
  assert.equal(fresh.code, 'COMPLETE_PUBLISHED');
  assert.equal(fresh.save, true);
  const missed = contract.decideCompleteReceipt({
    already: false,
    shielded: false,
    publish: { ok: true, code: 'BUYER_INBOX_EMPTY', txid: null },
    stored: null,
  });
  assert.equal(missed.ok, false);
  assert.equal(missed.exitCode, 1);
});

test('a receipt file stays inside the buyer folder and round-trips', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-receipt-'));
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const file = contract.writeReceipt(root, 'agent-3', jobId, {
    ok: true,
    code: 'COMPLETE_PUBLISHED',
    jobId,
    jobHash: 'abc',
    publish: { txid: 'tx1' },
  });
  assert.equal(file, path.join(root, 'agent-3', 'receipts', `${jobId}.json`));
  const read = contract.readReceipt(root, 'agent-3', jobId);
  assert.equal(read.publish.txid, 'tx1');
  assert.equal(read.contractVersion, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => contract.receiptPath(root, '..', jobId), (err) => err.code === 'RECEIPT_BUYER');
  assert.throws(() => contract.receiptPath(root, 'agent-3', '../x'), (err) => err.code === 'RECEIPT_JOB');
  fs.rmSync(root, { recursive: true, force: true });
});
