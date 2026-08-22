'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VDXF_KEYS } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
const {
  loadBuyerAllowlist, buyerMatchesAllowlist, decideAutoAccept,
  addBuyerAllowlistEntry, removeBuyerAllowlistEntry,
  readChainSalesStatus, resolveAllowlistEntries, clearAllowlistResolveCache,
} = require('../src/buyer-allowlist');

test('active without preferAllowlist auto-accepts strangers (floodgate)', () => {
  assert.equal(decideAutoAccept({ chainStatus: 'active', allowlist: ['iOnly'], buyerVerusId: 'iStranger' }).action, 'accept');
  assert.equal(decideAutoAccept({ chainStatus: null, allowlist: ['iOnly'], buyerVerusId: 'iStranger' }).action, 'accept');
});

test('active + preferAllowlist defers a stranger when an allowlisted sibling is waiting', () => {
  const r = decideAutoAccept({
    chainStatus: 'active', preferAllowlist: true, allowlist: ['iFriend'],
    buyerVerusId: 'iStranger', hasAllowlistedSibling: true,
  });
  assert.equal(r.action, 'defer');
});

test('active + preferAllowlist accepts a stranger when no friend is waiting', () => {
  const r = decideAutoAccept({
    chainStatus: 'active', preferAllowlist: true, allowlist: ['iFriend'],
    buyerVerusId: 'iStranger', hasAllowlistedSibling: false,
  });
  assert.equal(r.action, 'accept');
});

test('invite + empty allowlist accepts nobody', () => {
  const r = decideAutoAccept({ chainStatus: 'invite', allowlist: [], buyerVerusId: 'iFriend' });
  assert.equal(r.action, 'hold');
  assert.match(r.reason, /empty allowlist/);
});

test('invite + allowlist matches i-address and name', () => {
  assert.equal(decideAutoAccept({
    chainStatus: 'invite', allowlist: ['iFriendaddr'], buyerVerusId: 'iFriendaddr',
  }).action, 'accept');
  assert.equal(decideAutoAccept({
    chainStatus: 'invite',
    allowlist: ['bob.agentplatform@'],
    buyerVerusId: 'iX',
    names: ['bob.agentplatform@'],
  }).action, 'accept');
  assert.equal(decideAutoAccept({
    chainStatus: 'invite', allowlist: ['bob.agentplatform@'], buyerVerusId: 'iStranger',
  }).action, 'hold');
});

test('inactive never auto-accepts', () => {
  assert.equal(decideAutoAccept({ chainStatus: 'inactive', allowlist: ['iX'], buyerVerusId: 'iX' }).action, 'hold');
});

test('loadBuyerAllowlist trims and drops empties; missing is []', () => {
  assert.deepEqual(loadBuyerAllowlist(null), []);
  assert.deepEqual(loadBuyerAllowlist({}), []);
  assert.deepEqual(loadBuyerAllowlist({ buyerAllowlist: ['  a@  ', '', 'b@'] }), ['a@', 'b@']);
});

test('add/removeBuyerAllowlistEntry mutate a config object copy', () => {
  let cfg = addBuyerAllowlistEntry({}, 'bob.agentplatform@');
  assert.deepEqual(cfg.buyerAllowlist, ['bob.agentplatform@']);
  cfg = addBuyerAllowlistEntry(cfg, 'bob.agentplatform@');
  assert.deepEqual(cfg.buyerAllowlist, ['bob.agentplatform@']);
  cfg = removeBuyerAllowlistEntry(cfg, 'bob.agentplatform@');
  assert.deepEqual(cfg.buyerAllowlist, []);
});

test('resolveAllowlistEntries resolves names via getIdentity; decideAutoAccept uses resolved', async () => {
  clearAllowlistResolveCache();
  const iAlready = 'iFriendaddrXXXXXXXXXXXXXXXXXXXX1'; // length-gated i-address shape
  const getIdentity = async (name) => {
    if (name === 'bob.agentplatform@') return { identity: { identityaddress: 'iBob' } };
    throw new Error('unknown');
  };
  const resolved = await resolveAllowlistEntries(['bob.agentplatform@', iAlready], getIdentity);
  assert.deepEqual(resolved, ['iBob', iAlready]);
  // Caller feeds resolved i-addrs (and/or raw allowlist) into decideAutoAccept.
  assert.equal(decideAutoAccept({
    chainStatus: 'invite',
    allowlist: resolved,
    buyerVerusId: 'iBob',
    resolved: ['iBob'],
  }).action, 'accept');
  assert.equal(buyerMatchesAllowlist('iBob', resolved, { resolved: ['iBob'] }), true);
});

test('readChainSalesStatus reads VDXF agent.status from contentmultimap (invite)', () => {
  const key = VDXF_KEYS.agent.status;
  assert.equal(key, 'iLy373iaKafmRCY43ahty4m8aLQx32y8Fh');
  assert.equal(readChainSalesStatus({
    contentmultimap: { [key]: 'invite' },
  }), 'invite');
  assert.equal(readChainSalesStatus({
    identity: { contentmultimap: { [key]: [{ message: 'active' }] } },
  }), 'active');
  assert.equal(readChainSalesStatus({ contentmultimap: {} }), null);
});
