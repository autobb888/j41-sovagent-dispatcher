const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTmpHome(fn) {
  return async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-cfg-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmp;
    try { await fn(t, tmp); } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

test('loadDispatcherConfig returns defaults when file missing', withTmpHome(async () => {
  const { loadDispatcherConfig } = require('../src/config-loader.js');
  const cfg = loadDispatcherConfig({ skipMigration: true });
  assert.strictEqual(cfg.platform.api_url, 'https://api.junction41.io');
  assert.strictEqual(cfg.platform.network, 'verustest');
  assert.strictEqual(cfg.runtime.health_port, 9842);
  assert.strictEqual(cfg.logging.level, 'info');
}));
