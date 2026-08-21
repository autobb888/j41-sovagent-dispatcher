'use strict';
/**
 * Newcomer signup must pick a listing kind and never invent .agentplatform@
 * as the only parent. The platform mints under sovagent@ / sovcompute@ /
 * sovdata@ (or under agentplatform@ with config.kind while namespaces are
 * flags:0). The advertised name is kind-scoped; the server identity is truth.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseListingKind,
  advertisedIdentity,
  leafFromIdentity,
  kindFromIdentityName,
  listingIdPrefix,
  LISTING_KINDS,
} = require('../src/listing-kind.js');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('parseListingKind accepts agent, compute, data and rejects model', () => {
  assert.equal(parseListingKind('agent'), 'agent');
  assert.equal(parseListingKind('compute'), 'compute');
  assert.equal(parseListingKind('data'), 'data');
  assert.equal(parseListingKind('model'), null);
  assert.equal(parseListingKind('sovcompute'), null);
});

test('advertisedIdentity uses kind parents, not a hardcoded agentplatform@', () => {
  assert.equal(advertisedIdentity('alice', 'agent'), 'alice.sovagent@');
  assert.equal(advertisedIdentity('gpu1', 'compute'), 'gpu1.sovcompute@');
  assert.equal(advertisedIdentity('corpus', 'data'), 'corpus.sovdata@');
});

test('legacy and new parents both round-trip to a kind and a leaf', () => {
  assert.equal(kindFromIdentityName('old.agentplatform@'), 'agent');
  assert.equal(kindFromIdentityName('gpu1.sovcompute@'), 'compute');
  assert.equal(leafFromIdentity('gpu1.sovcompute@'), 'gpu1');
  assert.equal(leafFromIdentity('old.agentplatform@'), 'old');
});

test('local listing id prefix follows kind', () => {
  assert.equal(listingIdPrefix('agent'), 'agent');
  assert.equal(listingIdPrefix('compute'), 'compute');
  assert.equal(listingIdPrefix('data'), 'data');
});

test('sovmodel is not a mintable listing kind', () => {
  assert.deepEqual([...LISTING_KINDS], ['agent', 'compute', 'data']);
});

test('register and setup CLI accept --kind', () => {
  assert.match(CLI, /\.option\('--kind <kind>'/);
  assert.match(CLI, /register\(identityName,\s*J41_NETWORK,\s*\{\s*kind/);
});

test('TUI signup asks for a listing kind before the name', () => {
  assert.match(DASH, /What are you listing/);
  assert.match(DASH, /sovcompute@/);
  assert.match(DASH, /sovdata@/);
  assert.match(DASH, /coming soon/i);
  assert.match(DASH, /--kind/);
});
