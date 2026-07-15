'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selectBuyerMessages } = require('../src/message-poll.js');
const BUYER = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';
test('keeps only buyer messages, oldest-first', () => {
  const msgs = [
    { id: 'm2', senderVerusId: BUYER,     content: 'second',   createdAt: '2026-07-15T00:00:02Z' },
    { id: 'a1', senderVerusId: 'iAgentX', content: 'my reply', createdAt: '2026-07-15T00:00:01Z' },
    { id: 'm1', senderVerusId: BUYER,     content: 'first',    createdAt: '2026-07-15T00:00:00Z' },
  ];
  const out = selectBuyerMessages(msgs, BUYER);
  assert.deepStrictEqual(out.map(m => m.id), ['m1', 'm2']); // agent's own dropped, sorted asc
});
test('empty / missing input is safe', () => {
  assert.deepStrictEqual(selectBuyerMessages([], BUYER), []);
  assert.deepStrictEqual(selectBuyerMessages(undefined, BUYER), []);
});
