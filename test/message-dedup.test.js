'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { markIfNew } = require('../src/message-dedup.js');
test('markIfNew is true once per id, false on repeat', () => {
  const s = new Set();
  assert.strictEqual(markIfNew(s, 'a'), true);
  assert.strictEqual(markIfNew(s, 'a'), false);
  assert.strictEqual(markIfNew(s, 'b'), true);
});
test('markIfNew evicts oldest beyond cap (bounded)', () => {
  const s = new Set();
  for (let i = 0; i < 5; i++) markIfNew(s, 'id' + i, 3);
  assert.ok(s.size <= 3, 'set stays capped');
  assert.strictEqual(markIfNew(s, 'id4', 3), false, 'recent id still deduped');
});
