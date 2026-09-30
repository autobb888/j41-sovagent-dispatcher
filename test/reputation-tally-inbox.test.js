'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { planReputationTallyAdditions, acceptReputationTallyItem } = require('../src/reputation-tally-inbox');
const { selectInboxWriteSet, BUYER_INBOX_TYPES } = require('../src/buyer-inbox');

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
});
