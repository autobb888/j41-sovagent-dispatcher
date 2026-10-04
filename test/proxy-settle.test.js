'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { completionText, settleTokenCounts } = require('../src/proxy-settle');

test('an unusable completion is not billed, and a real one keeps its usage', () => {
  const bangs = JSON.stringify({ choices: [{ message: { content: '!!!!!!!!!!!!' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  assert.equal(completionText(bangs), '!!!!!!!!!!!!');
  const reversed = settleTokenCounts({
    statusOk: true, sawOutput: true, inputTok: 10, outputTok: 4, reserveOutput: 2000, text: completionText(bangs),
  });
  assert.deepEqual(reversed, { inputTok: 0, outputTok: 0, reason: 'unusable' });

  const pong = settleTokenCounts({
    statusOk: true, sawOutput: true, inputTok: 8, outputTok: 1, reserveOutput: 2000, text: 'pong',
  });
  assert.equal(pong.reason, 'usage');
  assert.equal(pong.outputTok, 1);

  const failed = settleTokenCounts({ statusOk: false, sawOutput: true, inputTok: 8, outputTok: 20, text: 'pong' });
  assert.equal(failed.reason, 'upstream-error');
  assert.equal(failed.outputTok, 0);

  const silent = settleTokenCounts({ statusOk: true, sawOutput: false, inputTok: 8, outputTok: 0, reserveOutput: 500, text: 'a real sentence here' });
  assert.equal(silent.reason, 'no-usage');
  assert.equal(silent.outputTok, 500);
});

test('stream frames are read as the assistant text', () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"!!!!"}}]}',
    'data: {"choices":[{"delta":{"content":"!!!!!!!!"}}]}',
    'data: [DONE]',
  ].join('\n');
  assert.equal(completionText(raw), '!!!!!!!!!!!!');
});
