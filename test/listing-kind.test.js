'use strict';
/**
 * All four kinds are live. VRSCTEST DeFi is off, so advertised names mint
 * under agentplatform@; kind is stored separately (keys.json / config.kind).
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
  listingsCollide,
  LISTING_KINDS,
} = require('../src/listing-kind.js');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('parseListingKind accepts agent, compute, data, model', () => {
  assert.equal(parseListingKind('agent'), 'agent');
  assert.equal(parseListingKind('compute'), 'compute');
  assert.equal(parseListingKind('data'), 'data');
  assert.equal(parseListingKind('model'), 'model');
  assert.equal(parseListingKind('sovcompute'), null);
});

test('advertisedIdentity mints under agentplatform@ for every kind (DeFi off)', () => {
  assert.equal(advertisedIdentity('alice', 'agent'), 'alice.agentplatform@');
  assert.equal(advertisedIdentity('gpu1', 'compute'), 'gpu1.agentplatform@');
  assert.equal(advertisedIdentity('corpus', 'data'), 'corpus.agentplatform@');
  assert.equal(advertisedIdentity('kimi', 'model'), 'kimi.agentplatform@');
});

test('sov suffixes still decode when DeFi later turns on', () => {
  assert.equal(kindFromIdentityName('old.agentplatform@'), 'agent');
  assert.equal(kindFromIdentityName('gpu1.sovcompute@'), 'compute');
  assert.equal(kindFromIdentityName('kimi.sovmodel@'), 'model');
  assert.equal(leafFromIdentity('kimi.agentplatform@'), 'kimi');
});

test('same leaf collides across kinds because there is only one parent', () => {
  assert.equal(listingsCollide('alice.agentplatform@', 'alice', 'model'), true);
  assert.equal(listingsCollide('bob.agentplatform@', 'alice', 'model'), false);
});

test('local listing id prefix follows kind including model', () => {
  assert.equal(listingIdPrefix('model'), 'model');
});

test('LISTING_KINDS includes model', () => {
  assert.deepEqual([...LISTING_KINDS], ['agent', 'compute', 'data', 'model']);
});

test('register and setup CLI accept --kind', () => {
  assert.match(CLI, /\.option\('--kind <kind>'/);
  assert.match(CLI, /register\(identityName,\s*J41_NETWORK,\s*\{\s*kind/);
  assert.match(CLI, /agent, compute, data, or model/);
});

test('CLI hire exists so the dispatcher is not seller-only', () => {
  assert.match(CLI, /\.command\('hire <buyer-agent-id> <seller>'\)/);
  assert.match(CLI, /assertHireAllowed/);
});

test('TUI signup offers model as a live kind under agentplatform@', () => {
  assert.match(DASH, /What are you listing/);
  assert.match(DASH, /agentplatform@/);
  assert.match(DASH, /value: 'model'/);
  assert.equal(/coming soon/i.test(DASH), false);
  assert.match(DASH, /--kind/);
});

test('TUI refuses to reuse a working agent name for a GPU box', () => {
  assert.match(DASH, /listingsCollide/);
  assert.match(DASH, /Do not reuse a working agent name for a GPU box/);
});
