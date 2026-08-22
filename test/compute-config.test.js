'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const TOML = require('@iarna/toml');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-compute-cfg-'));
process.env.HOME = TEST_HOME; os.homedir = () => TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });
const cfgPath = path.join(TEST_HOME, '.j41', 'dispatcher', 'config.toml');

const { loadDispatcherConfig } = require('../src/config-loader');

test('compute defaults are present and disabled', () => {
  fs.writeFileSync(cfgPath, '');
  const cfg = loadDispatcherConfig({ useCache: false });
  assert.equal(cfg.compute.enabled, false);
  assert.equal(cfg.compute.default_provider, 'local');
  assert.equal(cfg.compute.max_usd_per_hour, 0);
  assert.deepEqual(cfg.compute.providers, {});
});

test('a [compute.providers.*] table is parsed through', () => {
  fs.writeFileSync(cfgPath, TOML.stringify({
    compute: { enabled: true, providers: { workshop: { type: 'local', base_url: 'http://192.168.1.50:8000/v1', usd_per_hour: 0.08, allow_private_upstream: true } } },
  }));
  const cfg = loadDispatcherConfig({ useCache: false });
  assert.equal(cfg.compute.enabled, true);
  assert.equal(cfg.compute.providers.workshop.type, 'local');
  assert.equal(cfg.compute.providers.workshop.allow_private_upstream, true);
  assert.equal(cfg.compute.providers.workshop.base_url, 'http://192.168.1.50:8000/v1');
});

test('a [compute.providers.*] vast table is parsed through with the fleet ceiling', () => {
  fs.writeFileSync(cfgPath, TOML.stringify({
    compute: { enabled: true, max_usd_per_hour: 0.5, providers: { cloud: { type: 'vast', api_key: 'k', agent_id: 'a1', min_vram_gb: 24 } } },
  }));
  const cfg = loadDispatcherConfig({ useCache: false });
  assert.equal(cfg.compute.providers.cloud.type, 'vast');
  assert.equal(cfg.compute.max_usd_per_hour, 0.5);
  assert.equal(cfg.compute.providers.cloud.min_vram_gb, 24);
});

test('J41_COMPUTE_ENABLED env override flips enabled', () => {
  fs.writeFileSync(cfgPath, '');
  process.env.J41_COMPUTE_ENABLED = 'true';
  try {
    const cfg = loadDispatcherConfig({ useCache: false });
    assert.equal(cfg.compute.enabled, true);
  } finally { delete process.env.J41_COMPUTE_ENABLED; }
});
