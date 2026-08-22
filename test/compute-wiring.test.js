'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-wire-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
const { maybeStartComputeSupply, getCurrentController } = require('../src/compute-supply');

test('disabled compute is a no-op: returns null, agentConfigs untouched, no controller', async () => {
  const agentConfigs = new Map([['agent-1', { endpointUrl: 'http://on-chain/v1' }]]);
  const ctrl = await maybeStartComputeSupply({ cfg: { compute: { enabled: false, providers: {} } }, agentConfigs });
  assert.equal(ctrl, null);
  assert.equal(getCurrentController(), null);
  assert.equal(agentConfigs.get('agent-1').endpointUrl, 'http://on-chain/v1');
  assert.equal(agentConfigs.size, 1);
});

test('missing compute section is also a safe no-op', async () => {
  const ctrl = await maybeStartComputeSupply({ cfg: {}, agentConfigs: new Map() });
  assert.equal(ctrl, null);
});
