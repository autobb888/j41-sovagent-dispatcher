'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-lease-sec-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { persistLeases, loadLeases, redactLeaseSecrets } = require('../src/config');

test('redactLeaseSecrets drops password and privateKey but keeps containerId', () => {
  const out = redactLeaseSecrets({
    id: 'home:1', state: 'ready', jobId: 'j',
    ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 's3cret' },
    meta: { password: 's3cret', containerId: 'ctr', device_index: 0 },
  });
  assert.equal(out.meta.containerId, 'ctr');
  assert.equal(out.ssh.password, undefined);
  assert.equal(out.meta.password, undefined);
  assert.equal(out.ssh.host, 'gpu.example.com');
});

test('persistLeases does not write secrets and is 0600', () => {
  persistLeases(new Map([['home:1', {
    id: 'home:1', ssh: { password: 's3cret', privateKey: 'BEGIN' },
    meta: { sshPrivateKey: 'BEGIN', containerId: 'c' },
  }]]));
  const file = path.join(TEST_HOME, '.j41', 'dispatcher', 'leases.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /s3cret|BEGIN/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
