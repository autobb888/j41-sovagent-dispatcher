'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-leases-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { persistLeases, loadLeases, LEASES_PATH } = require('../src/config');

test('leases round-trip atomically with no orphaned .tmp', () => {
  const m = new Map([['local:workshop', { id: 'local:workshop', provider: 'local', state: 'ready', baseUrl: 'http://x/v1', private: true }]]);
  persistLeases(m);
  assert.equal(fs.existsSync(LEASES_PATH + '.tmp'), false);
  const loaded = loadLeases();
  assert.equal(loaded['local:workshop'].state, 'ready');
  assert.equal(loaded['local:workshop'].private, true);
});

test('loadLeases returns {} when the file is absent', () => {
  fs.rmSync(LEASES_PATH, { force: true });
  assert.deepEqual(loadLeases(), {});
});

test('persistLeases accepts a plain object too', () => {
  persistLeases({ 'local:a': { id: 'local:a', state: 'released' } });
  assert.equal(loadLeases()['local:a'].state, 'released');
});
