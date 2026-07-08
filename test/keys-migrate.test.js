'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ks = require('../src/keystore.js');
const { writeKeysFile } = require('../src/keys-file.js');
const mig = require('../src/keys-migrate.js');

function makePool() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const agentsDir = path.join(root, 'agents');
  for (const id of ['a1', 'a2']) {
    fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
    ks.lock(); // ensure plaintext write
    writeKeysFile(path.join(agentsDir, id, 'keys.json'), { wif: `wif-${id}`, identity: `${id}@`, network: 'verustest' });
  }
  return { root, agentsDir, mk: path.join(root, 'master-key.json') };
}

test('encrypt then decrypt round-trips every WIF and removes/adds envelopes', () => {
  const { agentsDir, mk } = makePool();
  ks.lock(); ks.initMasterKey('pw', mk);
  assert.equal(mig.encryptAllKeys(agentsDir), 2);
  // On disk both are v2 now.
  for (const id of ['a1', 'a2']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentsDir, id, 'keys.json'), 'utf8')).v, 2);
  }
  // decryptAllKeys leaves the keystore locked and files plaintext.
  assert.equal(mig.decryptAllKeys(agentsDir), 2);
  assert.ok(!ks.isUnlocked());
  for (const id of ['a1', 'a2']) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(agentsDir, id, 'keys.json'), 'utf8'));
    assert.equal(onDisk.v, undefined);
    assert.equal(onDisk.wif, `wif-${id}`);
  }
});

test('encryptAllKeys skips files already encrypted', () => {
  const { agentsDir, mk } = makePool();
  ks.lock(); ks.initMasterKey('pw', mk);
  assert.equal(mig.encryptAllKeys(agentsDir), 2);
  assert.equal(mig.encryptAllKeys(agentsDir), 0); // idempotent
  ks.lock();
});
