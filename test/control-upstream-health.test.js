const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUpstreamHealth } = require('../src/control');
const { _setHealth, _reset } = require('../src/upstream-health');

const stateWith = (ids) => ({ agents: ids.map((id) => ({ id })) });

test('buildUpstreamHealth: healthy, down, and never-checked agents', () => {
  _reset();
  _setHealth('agent-1', { healthy: true, status: 200 });
  _setHealth('agent-2', { healthy: false, error: 'ECONNREFUSED' });
  const out = buildUpstreamHealth(stateWith(['agent-1', 'agent-2', 'agent-3']));
  assert.equal(out['agent-1'].healthy, true);
  assert.equal(out['agent-2'].healthy, false);
  assert.equal(out['agent-2'].error, 'ECONNREFUSED');
  assert.equal(out['agent-3'], null); // never probed → null
  _reset();
});

test('buildUpstreamHealth: empty agents → empty object', () => {
  _reset();
  assert.deepEqual(buildUpstreamHealth({ agents: [] }), {});
});
