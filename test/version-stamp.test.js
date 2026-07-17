'use strict';
// /health must carry a provable stamp of which code is running: dispatcher
// version+commit, node, and the job-agent image digest it spawns.
const { test } = require('node:test');
const assert = require('node:assert');
const { getVersionStamp, buildHealthDocument } = require('../src/control.js');

test('getVersionStamp exposes dispatcher/commit/node/jobAgentImage', () => {
  const v = getVersionStamp();
  for (const k of ['dispatcher', 'commit', 'node', 'jobAgentImage']) {
    assert.ok(k in v, `stamp missing ${k}`);
    assert.equal(typeof v[k], 'string', `${k} must be a string`);
  }
  assert.equal(v.node, process.version);
});

test('buildHealthDocument includes the version stamp', () => {
  const state = {
    agents: [], active: new Map(), queue: [], available: [], seen: new Set(),
    _containerCrashes: new Map(), _agentErrors: new Map(),
  };
  const health = buildHealthDocument(state, Date.now() - 1000);
  assert.ok(health.version, 'health doc must carry version');
  assert.ok('jobAgentImage' in health.version, 'version must name the job-agent image');
  assert.ok('commit' in health.version, 'version must carry the dispatcher commit');
});
