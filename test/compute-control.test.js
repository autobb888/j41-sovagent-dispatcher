'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-ctl-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const supply = require('../src/compute-supply');
const { handleCommand } = require('../src/control');

test('ctl "leases" returns an empty list when compute is off', async () => {
  const r = await handleCommand({ action: 'leases' }, {}, {}, 0);
  assert.deepEqual(r.leases, []);
});

test('after a disabled start the controller stays null (rollback proof)', async () => {
  const res = await supply.maybeStartComputeSupply({ cfg: { compute: { enabled: false, providers: {} } }, agentConfigs: new Map() });
  assert.equal(res, null);
  assert.equal(supply.getCurrentController(), null);
});
