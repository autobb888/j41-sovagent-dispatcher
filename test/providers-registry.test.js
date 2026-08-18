'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerProvider, createProvider, listProviderTypes } = require('../src/providers');
const { FakeProvider } = require('./support/fake-provider');

test('registry creates a registered provider and rejects unknown types', () => {
  registerProvider('fake', (cfg) => new FakeProvider(cfg));
  const p = createProvider('fake', { id: 'fake:1' });
  assert.equal(p.constructor.name, 'FakeProvider');
  assert.ok(listProviderTypes().includes('fake'));
  assert.throws(() => createProvider('nope', {}), /unknown compute provider: nope/);
});

