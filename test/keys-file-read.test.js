'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readKeysFile, writeKeysFile } = require('../src/keys-file.js');

test('readKeysFile returns the plaintext object round-tripped through writeKeysFile', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-')), 'keys.json');
  const obj = { wif: 'Uabc', identity: 'a.platform@', iAddress: 'i123', network: 'verustest' };
  writeKeysFile(p, obj);
  assert.deepStrictEqual(readKeysFile(p), obj);
});

test('readKeysFile accepts an allowLocked option without changing plaintext behavior', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-')), 'keys.json');
  const obj = { wif: 'Uxyz', identity: 'b.platform@' };
  writeKeysFile(p, obj);
  assert.deepStrictEqual(readKeysFile(p, { allowLocked: true }), obj);
});
