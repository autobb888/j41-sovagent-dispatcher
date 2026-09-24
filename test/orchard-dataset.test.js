'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { publicOrchardCard } = require('../src/orchard-dataset');

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../templates/orchard-apples.json'), 'utf8'));

test('the public card is only the hire steps, even if the file still has rows', () => {
  const out = publicOrchardCard();
  const blob = JSON.stringify(out);
  assert.match(out.hire, /j41-dispatcher hire/);
  assert.match(out.hire, /pippinapples\.agentplatform@/);
  assert.match(out.hire, /--color/);
  assert.equal(out.hire.includes('--description'), false);
  assert.equal(blob.includes('"<filter>"'), false);
  assert.equal(out.items, undefined);
  assert.equal(out.query, undefined);
  assert.equal(blob.includes('Red Delicious'), false);
  assert.equal(blob.includes(doc.items[0].kind), false);
});
