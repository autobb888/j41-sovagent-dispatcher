const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTmpHome(fn) {
  return async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-cli-test-'));
    const origHome = process.env.HOME;
    const origNodeEnv = process.env.NODE_ENV;
    process.env.HOME = tmp;
    process.env.NODE_ENV = 'test';
    try { await fn(t, tmp); } finally {
      process.env.HOME = origHome;
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

test('buildContainerEnv sources provider key from cfg, not process.env', withTmpHome(async () => {
  const { saveDispatcherConfig, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  saveDispatcherConfig({
    platform: { api_url: 'https://api.test', network: 'verus' },
    llm: { provider: 'openai', model: 'gpt-4.1' },
    provider_keys: { openai: 'sk-from-toml' },
  });
  delete process.env.OPENAI_API_KEY;
  delete require.cache[require.resolve('../src/cli.js')];
  const { buildContainerEnv } = require('../src/cli.js');
  const env = buildContainerEnv(
    { id: 'job-1', lifecycle: {} },
    { id: 'agent-1', identity: 'test@' },
    null,
    'canary-token-xxx',
    '/tmp/jobdir',
    '/tmp/keys.json'
  );
  assert.strictEqual(env.OPENAI_API_KEY, 'sk-from-toml', 'preset.envKey populated from cfg.provider_keys');
  assert.strictEqual(env.J41_LLM_API_KEY, 'sk-from-toml', 'generic J41_LLM_API_KEY also populated');
  assert.strictEqual(env.J41_LLM_PROVIDER, 'openai');
  assert.strictEqual(process.env.OPENAI_API_KEY, undefined, 'dispatcher process.env stays clean');
}));
