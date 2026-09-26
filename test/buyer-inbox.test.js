'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  actionableItems,
  preferWatched,
  selectInboxWriteSet,
  drainMessage,
  drainBuyerInbox,
} = require('../src/buyer-inbox.js');

const job = (id, hash) => ({ id, type: 'job_record', jobHash: hash, status: 'pending' });
const review = (id, hash) => ({ id, type: 'review', jobHash: hash, status: 'pending' });

function scripted({ pages, batches, now }) {
  let page = 0;
  const calls = [];
  const clock = { t: now == null ? 0 : now };
  return {
    calls,
    clock,
    async fetchPending() {
      const rows = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return { data: rows };
    },
    async processOnce(items) {
      calls.push(items.map((it) => it.id));
      if (typeof batches === 'function') return batches(items, calls.length);
      const next = batches.shift();
      return next || { acked: [], deferred: [], alreadyDone: [] };
    },
    async sleep(ms) { clock.t += ms; },
    now() { return clock.t; },
  };
}

test('actionable items drop expired and informational rows', () => {
  const rows = actionableItems({
    data: [
      job('j1', 'h1'),
      { id: 'n1', type: 'notification', status: 'pending' },
      { id: 'e1', type: 'review', status: 'expired', jobHash: 'h1' },
      review('r1', 'h1'),
    ],
  });
  assert.deepEqual(rows.map((it) => it.id), ['j1', 'r1']);
});

test('preferWatched puts this job ahead of older packets', () => {
  const ordered = preferWatched(
    [job('old', 'old-hash'), job('new', 'new-hash'), review('rev', 'new-hash')],
    { jobHash: 'new-hash' },
  );
  assert.deepEqual(ordered.map((it) => it.id), ['new', 'rev', 'old']);
});

test('a write set is one live row of each key', () => {
  const dead = new Set(['old-job']);
  const selected = selectInboxWriteSet([
    job('old-job', 'h0'),
    job('new-job', 'h1'),
    review('rev', 'h1'),
    { id: 'note', type: 'notification' },
  ], (id) => dead.has(id));
  assert.deepEqual(selected.chosen.map((it) => it.id), ['new-job', 'rev']);
  assert.deepEqual(selected.quarantined, ['old-job']);
});

test('a quarantined inbox stops instead of polling', async () => {
  const s = scripted({
    pages: [[job('q1', 'h1')]],
    batches: [{ nothingWritable: true, quarantined: ['q1'] }],
  });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 60000, confirmTimeoutMs: 0, buyerId: 'mac',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUYER_INBOX_QUARANTINED');
  assert.deepEqual(result.quarantined, ['q1']);
  assert.match(drainMessage(result), /q1/);
  assert.equal(s.calls.length, 1);
});

test('empty inbox is success and does not write', async () => {
  const s = scripted({ pages: [[]], batches: [] });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 0, confirmTimeoutMs: 0, buyerId: 'buyer',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'BUYER_INBOX_EMPTY');
  assert.equal(s.calls.length, 0);
  assert.match(drainMessage(result), /no pending/);
});

test('one batch publishes and waits until the identity write is confirmed', async () => {
  const s = scripted({
    pages: [[job('j1', 'h1')], []],
    batches: [
      { txid: 'tx1', acked: ['j1'] },
      { deferredAgent: true },
      { empty: true },
    ],
  });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 0, confirmTimeoutMs: 60000, intervalMs: 1000, buyerId: 'mac',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'BUYER_INBOX_PUBLISHED');
  assert.equal(result.accepted.job_record, 1);
  assert.deepEqual(result.txids, ['tx1']);
  assert.deepEqual(s.calls[0], ['j1']);
  assert.deepEqual(s.calls[1], []);
  assert.deepEqual(s.calls[2], []);
  assert.ok(s.clock.t >= 1000);
});

test('unconfirmed identity write is not success', async () => {
  const s = scripted({
    pages: [[job('j1', 'h1')], []],
    batches: [{ txid: 'tx1', acked: ['j1'] }, { deferredAgent: true }],
  });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 0, confirmTimeoutMs: 0, buyerId: 'mac',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUYER_INBOX_UNCONFIRMED');
  assert.match(drainMessage(result), /not confirmed/);
});

test('watched job returns once its copies are gone, and reports the rest', async () => {
  const s = scripted({
    pages: [
      [job('new', 'new-hash'), job('old', 'old-hash')],
      [job('old', 'old-hash')],
    ],
    batches: [{ txid: 'tx9', acked: ['new'] }, { empty: true }],
  });
  const result = await drainBuyerInbox({
    ...s,
    timeoutMs: 5000,
    confirmTimeoutMs: 0,
    watch: { jobHash: 'new-hash', types: ['job_record'], required: true },
    buyerId: 'mac',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'BUYER_INBOX_PUBLISHED');
  assert.equal(result.pending, 1);
  assert.deepEqual(s.calls[0], ['new', 'old']);
  assert.match(drainMessage(result), /inbox mac --yes/);
});

test('a missing copy is waiting, not an empty inbox', async () => {
  const s = scripted({ pages: [[]], batches: [] });
  const result = await drainBuyerInbox({
    ...s,
    timeoutMs: 0,
    confirmTimeoutMs: 0,
    watch: { jobHash: 'missing', types: ['review', 'attestation'] },
    buyerId: 'mac',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUYER_INBOX_WAITING');
  assert.match(drainMessage(result), /seller accept copies the review/);
});

test('a dry fee tank stops the publish', async () => {
  const s = scripted({
    pages: [[review('r1', 'h1')]],
    batches: [{ stop: true, code: 'BUYER_INBOX_FUNDS', message: 'FEE TANK EMPTY' }],
  });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 1000, confirmTimeoutMs: 0, buyerId: 'mac',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUYER_INBOX_FUNDS');
  assert.equal(drainMessage(result), 'FEE TANK EMPTY');
});

test('backlog drain stops when a later page is empty', async () => {
  const s = scripted({
    pages: [
      [job('a', 'ha'), review('b', 'hb')],
      [review('b', 'hb')],
      [],
    ],
    batches: [
      { txid: 'txa', acked: ['a', 'b'] },
      { empty: true },
    ],
  });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 10000, intervalMs: 1000, confirmTimeoutMs: 0, buyerId: 'mac',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'BUYER_INBOX_PUBLISHED');
  assert.equal(result.accepted.job_record, 1);
  assert.equal(result.accepted.review, 1);
  assert.equal(result.pending, 0);
});

test('the buyer review and complete commands publish the inbox', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '../src/cli.js'), 'utf8');
  const review = src.slice(src.indexOf(".command('review "), src.indexOf(".command('review-session"));
  const complete = src.slice(src.indexOf(".command('complete "), src.indexOf(".command('review "));
  assert.match(review, /publishBuyerContentMaps/);
  assert.match(complete, /publishBuyerContentMaps/);
  assert.match(src, /\.command\('inbox <buyer-agent-id>'\)/);
  assert.doesNotMatch(fs.readFileSync(require('path').join(__dirname, '../src/buyer-inbox.js'), 'utf8'), /buildIdentityUpdateTx/);
});

test('inbox, complete, and review refuse a bad keys pin before verifyWitness', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '../src/cli.js'), 'utf8');
  const boot = src.slice(src.indexOf('const J41_API_URL'), src.indexOf('const IS_MAINNET'));
  assert.match(boot, /applyPlatformSigner\(planPlatformSigner\(/);
  assert.match(boot, /cfg\.platform && cfg\.platform\.signer/);
  const publish = src.slice(src.indexOf('async function publishBuyerContentMaps'), src.indexOf('async function readlineAsk'));
  assert.ok(publish.indexOf('if (!signerPlan.ok)') < publish.indexOf('verifyWitness'));
  const inbox = src.slice(src.indexOf(".command('inbox <buyer-agent-id>')"), src.indexOf(".command('extend "));
  const complete = src.slice(src.indexOf(".command('complete "), src.indexOf(".command('review "));
  const review = src.slice(src.indexOf(".command('review "), src.indexOf(".command('review-session"));
  for (const body of [inbox, complete, review]) {
    const gate = body.indexOf('refuseUnsignedPlatform(options)');
    const write = body.indexOf('publishBuyerContentMaps');
    assert.ok(gate > -1 && write > gate);
  }
});

test('timeout with rows still pending is not success', async () => {
  const s = scripted({
    pages: [[job('a', 'ha')]],
    batches: [{ deferredAgent: true }],
  });
  const result = await drainBuyerInbox({
    ...s, timeoutMs: 1000, intervalMs: 1000, confirmTimeoutMs: 0, maxCycles: 5, buyerId: 'mac',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUYER_INBOX_PENDING');
});
