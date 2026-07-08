'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('security screen offers WIF encryption actions', () => {
  const idx = DASH.indexOf('async function securityScreen');
  assert.ok(idx > -1);
  const block = DASH.slice(idx, idx + 3000);
  assert.match(block, /encrypt-keys/, 'no encrypt-keys action in security screen');
  assert.match(block, /change-passphrase/, 'no change-passphrase action in security screen');
});
