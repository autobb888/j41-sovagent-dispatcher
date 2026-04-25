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

test('env vars override TOML values', withTmpHome(async () => {
  const { loadDispatcherConfig } = require('../src/config-loader.js');
  process.env.J41_API_URL = 'https://staging.example';
  process.env.J41_NETWORK = 'verus';
  process.env.J41_KEEP_CONTAINERS = '1';
  try {
    const cfg = loadDispatcherConfig({ skipMigration: true });
    assert.strictEqual(cfg.platform.api_url, 'https://staging.example');
    assert.strictEqual(cfg.platform.network, 'verus');
    assert.strictEqual(cfg.runtime.keep_containers, true);
  } finally {
    delete process.env.J41_API_URL;
    delete process.env.J41_NETWORK;
    delete process.env.J41_KEEP_CONTAINERS;
  }
}));

test('saveDispatcherConfig writes 0600 + round-trips', withTmpHome(async (t, tmp) => {
  const { loadDispatcherConfig, saveDispatcherConfig, CONFIG_FILE } = require('../src/config-loader.js');
  saveDispatcherConfig({ platform: { network: 'verus' }, llm: { provider: 'groq' } });
  const stat = fs.statSync(CONFIG_FILE());
  assert.strictEqual(stat.mode & 0o777, 0o600);
  const cfg = loadDispatcherConfig({ skipMigration: true });
  assert.strictEqual(cfg.platform.network, 'verus');
  assert.strictEqual(cfg.llm.provider, 'groq');
  // Defaults still present for unmodified keys:
  assert.strictEqual(cfg.platform.api_url, 'https://api.junction41.io');
}));
