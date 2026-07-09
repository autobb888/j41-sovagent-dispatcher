// test/reactivation-persist.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect HOME so we write to a temp dispatcher dir, then load config fresh.
test('persist then load round-trips the queue; missing file → []', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  delete require.cache[require.resolve('../src/config.js')];
  const cfg = require('../src/config.js');
  try {
    assert.deepStrictEqual(cfg.loadReactivationQueue(), []); // no file yet
    const q = [{ job: { id: 'j1', description: 'd', buyerVerusId: 'b' }, agentId: 'agent-5', pausedAt: 1000, pauseTtlMin: 60, readyToRespawn: false }];
    cfg.persistReactivationQueue(q);
    assert.deepStrictEqual(cfg.loadReactivationQueue(), q);
  } finally {
    process.env.HOME = origHome;
    delete require.cache[require.resolve('../src/config.js')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
