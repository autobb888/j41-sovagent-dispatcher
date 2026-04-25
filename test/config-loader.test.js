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

test('migrateLegacyEnv reads install-dir .env into config.toml', withTmpHome(async (t, tmp) => {
  const { migrateLegacyEnv, loadDispatcherConfig, CONFIG_FILE } = require('../src/config-loader.js');
  // Stage a fake .env in a sandbox install dir
  const fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-repo-'));
  const envFile = path.join(fakeRepoDir, '.env');
  fs.writeFileSync(envFile,
    `J41_API_URL=https://staging.example\n` +
    `J41_NETWORK=verus\n` +
    `J41_LLM_PROVIDER=groq\n` +
    `OPENAI_API_KEY=sk-test-1234\n` +
    `# a comment\n`
  );
  const result = migrateLegacyEnv({ envFile });
  assert.ok(result.migrated);
  assert.ok(fs.existsSync(CONFIG_FILE()));
  const cfg = loadDispatcherConfig({ skipMigration: true });
  assert.strictEqual(cfg.platform.api_url, 'https://staging.example');
  assert.strictEqual(cfg.platform.network, 'verus');
  assert.strictEqual(cfg.llm.provider, 'groq');
  assert.strictEqual(cfg.provider_keys.openai, 'sk-test-1234');
  // Banner added to .env
  const after = fs.readFileSync(envFile, 'utf8');
  assert.ok(after.startsWith('# MIGRATED'));
  fs.rmSync(fakeRepoDir, { recursive: true, force: true });
}));

test('loadDispatcherConfig auto-runs migration on first call', withTmpHome(async (t, tmp) => {
  const { loadDispatcherConfig, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  const fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-repo-'));
  fs.writeFileSync(path.join(fakeRepoDir, '.env'), 'J41_NETWORK=verus\n');
  const cfg = loadDispatcherConfig({ legacyEnvFile: path.join(fakeRepoDir, '.env') });
  assert.strictEqual(cfg.platform.network, 'verus');
  fs.rmSync(fakeRepoDir, { recursive: true, force: true });
}));

test('migrateLegacyEnv merges into existing config.toml without overwriting', withTmpHome(async (t, tmp) => {
  const { migrateLegacyEnv, saveDispatcherConfig, loadDispatcherConfig, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  // Operator already has config.toml with a custom api_url
  saveDispatcherConfig({ platform: { api_url: 'https://existing.example' } });
  // .env contains a different api_url AND a provider key the operator hasn't set yet
  const fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-repo-'));
  const envFile = path.join(fakeRepoDir, '.env');
  fs.writeFileSync(envFile,
    `J41_API_URL=https://from-env.example\nOPENAI_API_KEY=sk-from-env\n`
  );
  migrateLegacyEnv({ envFile });
  const cfg = loadDispatcherConfig({ skipMigration: true });
  // existing wins
  assert.strictEqual(cfg.platform.api_url, 'https://existing.example');
  // new key gets pulled in
  assert.strictEqual(cfg.provider_keys.openai, 'sk-from-env');
  fs.rmSync(fakeRepoDir, { recursive: true, force: true });
}));

test('loadDispatcherConfig caches within TTL; saveDispatcherConfig invalidates', withTmpHome(async () => {
  const { loadDispatcherConfig, saveDispatcherConfig, invalidateConfigCache, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  invalidateConfigCache();
  // First (no-opts) load primes the cache
  const a = loadDispatcherConfig();
  // Mutate disk directly behind the cache's back; cached load should NOT see it
  saveDispatcherConfig({ platform: { network: 'verus' } });
  // saveDispatcherConfig invalidated the cache, so next load reflects the write
  const b = loadDispatcherConfig();
  assert.strictEqual(b.platform.network, 'verus');
  // A second immediate load should be cache-served (same reference)
  const c = loadDispatcherConfig();
  assert.strictEqual(c, b, 'second call within TTL returns cached object');
  // Initial load returned defaults, post-save load reflects the change
  assert.strictEqual(a.platform.network, 'verustest');
}));

test('opts-bearing loadDispatcherConfig bypasses cache', withTmpHome(async () => {
  const { loadDispatcherConfig, saveDispatcherConfig, invalidateConfigCache, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  invalidateConfigCache();
  saveDispatcherConfig({ platform: { network: 'verus' } });
  // No-opts call populates cache
  const cached = loadDispatcherConfig();
  assert.strictEqual(cached.platform.network, 'verus');
  // skipMigration:true is opts → bypass cache; verify it still reads disk fresh
  const fresh = loadDispatcherConfig({ skipMigration: true });
  assert.strictEqual(fresh.platform.network, 'verus');
  // Different object (not cache-served)
  assert.notStrictEqual(fresh, cached);
}));

test('extended schema sections load with defaults', withTmpHome(async () => {
  const { loadDispatcherConfig, _resetMigrationState, invalidateConfigCache } = require('../src/config-loader.js');
  _resetMigrationState();
  invalidateConfigCache();
  const cfg = loadDispatcherConfig({ skipMigration: true });
  assert.strictEqual(cfg.proxy.upstream_timeout_ms, 60000);
  assert.strictEqual(cfg.proxy.estimated_input_tokens, 4000);
  assert.strictEqual(cfg.proxy.estimated_output_tokens, 2000);
  assert.strictEqual(cfg.proxy.suggested_topup_vrsc, 10);
  assert.strictEqual(cfg.deposit.poll_interval_ms, 60000);
  assert.strictEqual(cfg.health.poll_interval_ms, 60000);
  assert.strictEqual(cfg.webhook.max_body_bytes, 1048576);
  assert.strictEqual(cfg.retry.rate_limit_backoff_multiplier, 3);
}));

test('saveDispatcherConfig recovers from a stale lock file', withTmpHome(async () => {
  const { saveDispatcherConfig, CONFIG_FILE, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  const dir = path.dirname(CONFIG_FILE());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockFile = CONFIG_FILE() + '.lock';
  fs.writeFileSync(lockFile, '99999');
  // Backdate it 60s so stale-lock cleanup fires
  const past = (Date.now() / 1000) - 60;
  fs.utimesSync(lockFile, past, past);
  // Should succeed (clears stale lock, takes lock, writes, releases)
  const result = saveDispatcherConfig({ platform: { network: 'verus' } });
  assert.ok(result.endsWith('config.toml'));
  // Lock file is gone after the write
  assert.strictEqual(fs.existsSync(lockFile), false);
}));
