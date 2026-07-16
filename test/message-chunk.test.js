'use strict';
// Reply chunking: the platform rejects chat messages > 4000 chars. A long code
// review must be split into ordered <4000-char parts instead of silently lost.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const { chunkMessage, sendChatChunked, CHAT_MAX_LEN } = require('../src/job-agent.js');

test('short text → single chunk, unchanged', () => {
  assert.deepEqual(chunkMessage('hello world'), ['hello world']);
});

test('null/empty → single empty chunk', () => {
  assert.deepEqual(chunkMessage(''), ['']);
  assert.deepEqual(chunkMessage(null), ['']);
});

test('long text → multiple chunks, each within maxLen', () => {
  const long = 'x'.repeat(10000);
  const chunks = chunkMessage(long);
  assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= CHAT_MAX_LEN, `chunk ${c.length} > ${CHAT_MAX_LEN}`);
  // no content lost (hard-split, no whitespace to trim)
  assert.equal(chunks.join('').length, 10000);
});

test('prefers a paragraph boundary near the limit', () => {
  // paragraph break at 3800, then more text — first chunk should end at the break
  const first = 'a'.repeat(3800);
  const second = 'b'.repeat(3000);
  const chunks = chunkMessage(first + '\n\n' + second);
  assert.equal(chunks[0], first, 'first chunk ends at the paragraph break');
  assert.equal(chunks[1], second);
});

test('falls back to word boundary, then hard-cut', () => {
  // one giant token with no break in the second half → hard cut at maxLen
  const chunks = chunkMessage('y'.repeat(5000));
  assert.equal(chunks[0].length, CHAT_MAX_LEN);
  assert.equal(chunks[1].length, 5000 - CHAT_MAX_LEN);
});

test('sendChatChunked: short text → one send, no part marker', async () => {
  const sent = [];
  const agent = { sendChatMessage: async (jid, txt) => sent.push(txt) };
  const n = await sendChatChunked(agent, 'job1', 'a short review');
  assert.equal(n, 1);
  assert.deepEqual(sent, ['a short review']);
});

test('sendChatChunked: long text → ordered parts, each under the 4000 cap, marked', async () => {
  const sent = [];
  const agent = { sendChatMessage: async (jid, txt) => sent.push(txt) };
  const review = 'line\n'.repeat(2000); // ~10000 chars
  const n = await sendChatChunked(agent, 'job1', review);
  assert.ok(n > 1, 'must split');
  assert.equal(sent.length, n);
  sent.forEach((txt, i) => {
    assert.ok(txt.length < 4000, `part ${i + 1} is ${txt.length} chars (must be < 4000)`);
    assert.match(txt, new RegExp(`^\\(part ${i + 1}/${n}\\)`), `part ${i + 1} carries its marker`);
  });
});
