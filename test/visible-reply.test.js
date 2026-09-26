'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buyerVisibleReply } = require('../src/executors/local-llm');

test('reasoning is not the buyer reply', () => {
  const reply = buyerVisibleReply({
    content: '',
    reasoning_content: 'we need answer. system says introduce yourself.',
  });
  assert.equal(reply, 'I could not generate a response.');
});

test('a real content field is the reply', () => {
  const reply = buyerVisibleReply({
    content: 'Store it in the crisper drawer, pong.',
    reasoning_content: 'draft notes',
  });
  assert.equal(reply, 'Store it in the crisper drawer, pong.');
});
