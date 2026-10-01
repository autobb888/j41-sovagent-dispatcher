'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  planReputationTallyAdditions, acceptReputationTallyItem,
  splitInboxBatch, tallyWriteShouldCountItem, writeReputationTallyAdditions,
} = require('../src/reputation-tally-inbox');
const { selectInboxWriteSet, BUYER_INBOX_TYPES } = require('../src/buyer-inbox');
const { classifyInboxFailure } = require('../src/inbox-deadletter');

const note = JSON.parse(fs.readFileSync(
  '/home/bigbox/code/junction41/src/validation/vdxf-keys.tally-note.json', 'utf8'));
const keys = { tally: note.tally.vdxfid, prose: note.prose.vdxfid };

function hex(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('hex');
}

test('additions are the inbox hex and do not grow a buyer', async () => {
  const tallyHex = hex({
    schemaVersion: 1, sellerVerusId: 'iSeller', jobsReviewed: 1, ratingSum: 5, ratingCount: 1,
    ratingCounts: [0, 0, 0, 0, 1], epochId: '2026-10-01', asOf: '2026-10-01T00:00:00.000Z',
  });
  const proseHex = hex({ sellerVerusId: 'iSeller', epochId: '2026-10-01', entries: [{ text: 'opted in' }] });
  const bad = hex({ jobsReviewed: 1, buyer: 'iBuyer' });
  const additions = planReputationTallyAdditions({
    vdxfData: { [keys.tally]: tallyHex, [keys.prose]: proseHex, iNotATallyKey: 'ff' },
  }, keys);
  assert.deepEqual(additions[keys.tally], [tallyHex]);
  assert.deepEqual(additions[keys.prose], [proseHex]);
  assert.equal(additions.iNotATallyKey, undefined);
  await assert.rejects(() => acceptReputationTallyItem({
    type: 'reputation_tally',
    vdxfData: { [keys.tally]: bad },
  }, { keys, writeIdentityAdditions: async () => {} }));
  const written = [];
  const result = await acceptReputationTallyItem({
    type: 'reputation_tally',
    vdxfData: { [keys.tally]: tallyHex },
  }, { keys, writeIdentityAdditions: async (a) => { written.push(a); } });
  assert.equal(result.accepted, true);
  assert.equal(written.length, 1);
  assert.equal(written[0][keys.prose], undefined);
});

test('buyer write set still ignores reputation_tally; seller types include it', () => {
  const pending = [
    { id: 'b', type: 'job_record' },
    { id: 't', type: 'reputation_tally' },
  ];
  assert.deepEqual(selectInboxWriteSet(pending, () => false).chosen.map((it) => it.id), ['b']);
  assert.ok(BUYER_INBOX_TYPES.includes('job_record'));
  assert.equal(BUYER_INBOX_TYPES.includes('reputation_tally'), false);
  const sellerTypes = ['review', 'attestation', 'job_record', 'reputation_tally'];
  assert.deepEqual(
    selectInboxWriteSet(pending, () => false, sellerTypes).chosen.map((it) => it.id),
    ['b', 't'],
  );
});

test('cli wires the branch without being booted', () => {
  const cli = fs.readFileSync('src/cli.js', 'utf8');
  assert.match(cli, /item\.type === 'reputation_tally'/);
  assert.match(cli, /acceptReputationTallyItem\(item, deps\)/);
  assert.match(cli, /INBOX_ACTIONABLE_TYPES = \['review', 'attestation', 'job_record', 'reputation_tally'\]/);
  assert.match(cli, /selectInboxWriteSet\(pending, \(id\) => isDeadLettered\(state\._inboxFailures, id\), INBOX_ACTIONABLE_TYPES\)/);
  const dash = fs.readFileSync('src/dashboard.js', 'utf8');
  assert.ok(dash.includes(note.tally.vdxfid));
  assert.ok(dash.includes(note.prose.vdxfid));
  assert.ok(dash.includes('review.tally'));
  assert.ok(dash.includes('review.prose'));
  const tallySrc = fs.readFileSync('src/reputation-tally-inbox.js', 'utf8');
  assert.ok(tallySrc.includes(note.tally.vdxfid));
  assert.ok(tallySrc.includes(note.prose.vdxfid));
  assert.equal(tallySrc.includes('/home/bigbox/code/junction41'), false);
  assert.equal(tallySrc.includes('agentplatform::reputation.tally'), false);

  const branchAt = cli.indexOf("if (it.type === 'reputation_tally')");
  const continueAt = cli.indexOf('continue;', branchAt);
  const pushAt = cli.indexOf('batch.push({ id: it.id, type: it.type });', branchAt);
  assert.ok(branchAt > 0 && continueAt > branchAt && pushAt > continueAt);
  const branch = cli.slice(branchAt, continueAt);
  assert.equal(branch.includes('batch.push'), false);
  assert.match(branch, /tallyPlanned\.push/);
  assert.match(branch, /planReputationTallyAdditions/);
  assert.match(branch, /iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad/);

  const splitAt = cli.indexOf('splitInboxBatch(batch)');
  const chainAt = cli.indexOf('batch = split.chain');
  const acceptAt = cli.indexOf('agent.acceptInboxBatch(batch)');
  assert.ok(splitAt > branchAt && chainAt > splitAt && acceptAt > chainAt);

  const writerHits = cli.split('writeIdentityAdditions: reputationTallyWriter(agent, agentInfo)').length - 1;
  assert.equal(writerHits, 2);
  const buyerAt = cli.indexOf("fetchPending: async () => agent.client.getInbox('pending', 20, BUYER_INBOX_TYPES)");
  assert.ok(buyerAt > 0);
  assert.equal(cli.slice(buyerAt, buyerAt + 700).includes('writeIdentityAdditions'), false);
});

test('splitInboxBatch keeps reputation_tally out of the chain batch', () => {
  const split = splitInboxBatch([
    { id: 'review-1', type: 'review' },
    { id: 'tally-1', type: 'reputation_tally' },
    { id: 'attest-1', type: 'attestation' },
  ]);
  assert.deepEqual(split.chain.map((it) => it.id), ['review-1', 'attest-1']);
  assert.deepEqual(split.tally.map((it) => it.type), ['reputation_tally']);
});

function tallyClient(over = {}) {
  return {
    getIdentityRaw: async () => ({ data: { identity: { contentmultimap: {} } } }),
    getUtxos: async () => { throw new Error('getUtxos should not run'); },
    broadcast: async () => { throw new Error('broadcast should not run'); },
    acceptInboxItem: async () => {},
    getChainInfo: async () => ({ blockHeight: 100 }),
    ...over,
  };
}

test('the same hex already on the identity is acked and not rebroadcast', async () => {
  const tallyHex = 'aa';
  const calls = { utxos: 0, broadcast: 0, ack: [] };
  const result = await writeReputationTallyAdditions(
    { [keys.tally]: [tallyHex] },
    { id: 'tally-already', type: 'reputation_tally' },
    {
      client: tallyClient({
        getIdentityRaw: async () => ({
          data: { identity: { contentmultimap: { [keys.tally]: [tallyHex] } } },
        }),
        getUtxos: async () => { calls.utxos += 1; return { utxos: [] }; },
        broadcast: async () => { calls.broadcast += 1; return { txid: 'should-not' }; },
        acceptInboxItem: async (id, txid) => { calls.ack.push({ id, txid }); },
      }),
      valueAlreadyOnChain: (onChain, key, values) => JSON.stringify(onChain[key]) === JSON.stringify(values),
      deferBroadcast: true,
    },
  );
  assert.equal(result.alreadyOnChain, true);
  assert.equal(result.broadcast, false);
  assert.equal(result.accepted, true);
  assert.equal(calls.utxos, 0);
  assert.equal(calls.broadcast, 0);
  assert.deepEqual(calls.ack, [{ id: 'tally-already', txid: undefined }]);
});

test('a new tally is built, broadcast, and acked with the txid', async () => {
  const additions = { [keys.tally]: ['bb'] };
  let built = null;
  const acks = [];
  const result = await writeReputationTallyAdditions(additions, { id: 'tally-new', type: 'reputation_tally' }, {
    client: tallyClient({
      getUtxos: async () => ({ utxos: [{ txid: '22'.repeat(32), vout: 0, satoshis: 1 }] }),
      broadcast: async (signed) => {
        assert.equal(signed, 'signed-hex');
        return { txid: 'cafebabe' };
      },
      acceptInboxItem: async (id, txid) => { acks.push({ id, txid }); },
    }),
    valueAlreadyOnChain: () => false,
    buildIdentityUpdateTx: (args) => {
      built = args;
      return 'signed-hex';
    },
    computeExpiryHeight: (tip, delta) => tip + delta,
    expiryDelta: 20,
    wif: 'test-wif-not-logged',
    network: 'VRSCTEST',
  });
  assert.equal(result.broadcast, true);
  assert.equal(result.txid, 'cafebabe');
  assert.equal(result.expiryHeight, 120);
  assert.equal(built.vdxfAdditions, additions);
  assert.equal(built.wif, 'test-wif-not-logged');
  assert.deepEqual(acks, [{ id: 'tally-new', txid: 'cafebabe' }]);
});

test('an empty wallet is transient and does not count as an item fault', async () => {
  await assert.rejects(() => writeReputationTallyAdditions(
    { [keys.tally]: ['cc'] },
    { id: 'tally-dry', type: 'reputation_tally' },
    {
      client: tallyClient({
        getUtxos: async () => ({ utxos: [] }),
      }),
      valueAlreadyOnChain: () => false,
    },
  ), /No UTXOs available/);
  const err = new Error('No UTXOs available — wallet is empty or all outputs are unconfirmed');
  assert.equal(classifyInboxFailure(err), 'transient');
  assert.equal(tallyWriteShouldCountItem('transient', { escalate: true }), false);
  assert.equal(tallyWriteShouldCountItem('hard', { escalate: false }), false);
  assert.equal(tallyWriteShouldCountItem('hard', { escalate: true }), true);
});

test('a tally-byte build failure is an item fault when an empty update still builds', async () => {
  await assert.rejects(() => writeReputationTallyAdditions(
    { [keys.tally]: ['dd'] },
    { id: 'tally-bad', type: 'reputation_tally' },
    {
      client: tallyClient({
        getUtxos: async () => ({ utxos: [{ txid: '33'.repeat(32), vout: 0, satoshis: 1 }] }),
      }),
      valueAlreadyOnChain: () => false,
      buildIdentityUpdateTx: (args) => {
        const added = args.vdxfAdditions && Object.keys(args.vdxfAdditions).length > 0;
        if (added) throw new Error('bad tally bytes');
        return 'empty-ok';
      },
      computeExpiryHeight: () => 1,
      expiryDelta: 1,
    },
  ), (err) => {
    assert.equal(err.code, 'TALLY_TX_BUILD');
    assert.match(err.message, /tx build failed: bad tally bytes/);
    return true;
  });
});

test('a build failure that also rejects an empty update stays environmental', async () => {
  await assert.rejects(() => writeReputationTallyAdditions(
    { [keys.tally]: ['ee'] },
    { id: 'tally-env', type: 'reputation_tally' },
    {
      client: tallyClient({
        getUtxos: async () => ({ utxos: [{ txid: '44'.repeat(32), vout: 0, satoshis: 1 }] }),
      }),
      valueAlreadyOnChain: () => false,
      buildIdentityUpdateTx: () => { throw new Error('socket hang up'); },
      computeExpiryHeight: () => 1,
      expiryDelta: 1,
    },
  ), (err) => {
    assert.equal(err.code, undefined);
    assert.match(err.message, /socket hang up/);
    assert.equal(classifyInboxFailure(err), 'transient');
    assert.equal(tallyWriteShouldCountItem(classifyInboxFailure(err), { escalate: false }), false);
    return true;
  });
});

test('deferBroadcast skips a second identity tx when the hex is not already posted', async () => {
  const result = await writeReputationTallyAdditions(
    { [keys.tally]: ['ff'] },
    { id: 'tally-defer', type: 'reputation_tally' },
    {
      client: tallyClient(),
      valueAlreadyOnChain: () => false,
      deferBroadcast: true,
    },
  );
  assert.deepEqual(result, { deferred: true, reason: 'identity batch this cycle' });
});
