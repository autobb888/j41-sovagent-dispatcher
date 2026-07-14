'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stillFailed } = require('../src/capability-retry.js');

test('stillFailed returns only agents whose capabilities are marked _fetchFailed', () => {
  const state = { capabilities: new Map([
    ['a', { _fetchFailed: true }],
    ['b', { services: [] }],        // healed
    ['c', { _fetchFailed: true }],
  ]) };
  const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(stillFailed(state, agents).map(x => x.id), ['a', 'c']);
});

test('stillFailed is empty when all healed → caller can stop the timer', () => {
  const state = { capabilities: new Map([['a', { services: [] }]]) };
  assert.strictEqual(stillFailed(state, [{ id: 'a' }]).length, 0);
});
