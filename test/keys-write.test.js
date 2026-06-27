'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeKeysFile } = require('../src/keys-file.js');

test('writeKeysFile always writes 0600', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-')), 'keys.json');
  writeKeysFile(p, { wif: 'x' });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('writeKeysFile writes valid JSON', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-')), 'keys.json');
  const obj = { wif: 'test123', identity: 'agent.platform@' };
  writeKeysFile(p, obj);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(parsed, obj);
});

test('writeKeysFile enforces 0600 even if file pre-exists with looser perms', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-')), 'keys.json');
  fs.writeFileSync(p, '{}', { mode: 0o644 });
  writeKeysFile(p, { wif: 'y' });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});
