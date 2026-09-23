'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  labourMaxTokens,
  LABOUR_MAX_TOKENS_DEFAULT,
  LABOUR_MAX_TOKENS_CEILING,
  chatChunks,
} = require('../src/executors/local-llm.js');

test('a long reply is split into parts that fit the chat limit, and no text is dropped', () => {
  const wall = `${'alpha beta gamma delta. '.repeat(400)}END`;
  const chunks = chatChunks(wall, 3900 - 24);
  const joined = chunks.join('');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 3900 - 24));
  assert.ok(joined.endsWith('END'));
  assert.ok(joined.length > wall.length - chunks.length);
});

test('labour max_tokens defaults to 1024 and clamps at 2048', () => {
  assert.equal(labourMaxTokens({}), LABOUR_MAX_TOKENS_DEFAULT);
  assert.equal(LABOUR_MAX_TOKENS_DEFAULT, 1024);
  assert.equal(labourMaxTokens({ J41_LLM_MAX_TOKENS: '3000' }), LABOUR_MAX_TOKENS_CEILING);
  assert.equal(LABOUR_MAX_TOKENS_CEILING, 2048);
  assert.equal(labourMaxTokens({ J41_LLM_MAX_TOKENS: '0' }), 1024);
  assert.equal(labourMaxTokens({ J41_LLM_MAX_TOKENS: '512' }), 512);
});
