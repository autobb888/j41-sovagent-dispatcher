'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionTokenFromHeader } = require('../src/session-token');

const UUID = '11111111-1111-4111-8111-111111111111';

test('grant stores the id after the colon, which is what the review posts', () => {
  assert.equal(sessionTokenFromHeader(`j41macbuyer.agentplatform@:${UUID}`), UUID);
  assert.equal(sessionTokenFromHeader(UUID), UUID);
});
