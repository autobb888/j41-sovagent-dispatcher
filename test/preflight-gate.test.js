'use strict';
// Task 6: Preflight LLM health gate unit tests.
// Verifies:
//   (1) resolveAgentLLMConfig: local-llm agent with kimi-nvidia preset → correct baseUrl/model/apiKey
//   (2) resolveAgentLLMConfig: webhook agent → null (skip preflight)
//   (3) shouldAcceptGivenHealth: null cfg → accept=true, reason='skipped (non-local-llm)'
//   (4) shouldAcceptGivenHealth: ok=true → accept=true, reason='LLM healthy'
//   (5) shouldAcceptGivenHealth: ok=false → accept=false with error reason
//
// Uses a sandbox HOME so loadDispatcherConfig() and _loadAgentConfig() both
// resolve under the temp dir (same isolation pattern as refund-cli.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-preflight-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

// Create agent dirs in sandbox
const agentsDir = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents');

function writeAgentConfig(agentId, config) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-config.json'), JSON.stringify(config), { mode: 0o600 });
}

// Set up test agent configs before requiring the module
writeAgentConfig('llm-agent-1', {
  executor: 'local-llm',
  llmProvider: 'kimi-nvidia',
  llmModel: 'deepseek-ai/deepseek-v4-flash',
  llmApiKey: 'test-kimi-key',
});

writeAgentConfig('webhook-agent-1', {
  executor: 'webhook',
  executorUrl: 'https://example.com/webhook',
});

const { resolveAgentLLMConfig, shouldAcceptGivenHealth } = require('../src/preflight-gate.js');

// kimi-nvidia preset values (from src/executors/local-llm.js LLM_PRESETS)
const KIMI_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

test('resolveAgentLLMConfig: local-llm agent with kimi-nvidia preset', (t) => {
  const agentInfo = { id: 'llm-agent-1' };
  const result = resolveAgentLLMConfig(agentInfo);

  assert.notEqual(result, null, 'should return a config object for local-llm executor');
  assert.equal(result.baseUrl, KIMI_NVIDIA_BASE_URL, 'baseUrl from kimi-nvidia preset');
  assert.equal(result.model, 'deepseek-ai/deepseek-v4-flash', 'model from agent override');
  assert.equal(result.apiKey, 'test-kimi-key', 'apiKey from agent llmApiKey');
  assert.equal(result.customHeaders, null, 'kimi-nvidia has no custom headers function');
});

test('resolveAgentLLMConfig: webhook agent → null', (t) => {
  const agentInfo = { id: 'webhook-agent-1' };
  const result = resolveAgentLLMConfig(agentInfo);
  assert.equal(result, null, 'should return null for non-local-llm executor');
});

test('resolveAgentLLMConfig: unknown agent (no config file) uses global executor default → local-llm', (t) => {
  // No agent-config.json → falls back to global cfg.executor.type which defaults to 'local-llm'
  // With no global LLM config either, baseUrl/model/apiKey will be empty but executor IS local-llm
  const agentInfo = { id: 'unconfigured-agent' };
  const result = resolveAgentLLMConfig(agentInfo);
  // Default executor is local-llm, so result is not null (but baseUrl/model/apiKey are empty)
  assert.notEqual(result, null, 'default executor is local-llm → returns config (possibly empty)');
  assert.equal(typeof result, 'object');
});

test('shouldAcceptGivenHealth: null cfg → skipped (non-local-llm)', (t) => {
  const result = shouldAcceptGivenHealth(null, { ok: false, status: 503, error: 'some error' });
  assert.equal(result.accept, true);
  assert.equal(result.reason, 'skipped (non-local-llm)');
});

test('shouldAcceptGivenHealth: health.ok=true → accept', (t) => {
  const cfg = { baseUrl: 'https://api.example.com/v1', model: 'test', apiKey: 'k', customHeaders: null };
  const result = shouldAcceptGivenHealth(cfg, { ok: true, latencyMs: 120, status: 200, error: null });
  assert.equal(result.accept, true);
  assert.equal(result.reason, 'LLM healthy');
});

test('shouldAcceptGivenHealth: health.ok=false with http status → reject with reason', (t) => {
  const cfg = { baseUrl: 'https://api.example.com/v1', model: 'test', apiKey: 'k', customHeaders: null };
  const result = shouldAcceptGivenHealth(cfg, { ok: false, latencyMs: 30, status: 503, error: 'http 503' });
  assert.equal(result.accept, false);
  assert.match(result.reason, /503/, 'reason should include status code');
});

test('shouldAcceptGivenHealth: health.ok=false with network error → reject with error message', (t) => {
  const cfg = { baseUrl: 'https://api.example.com/v1', model: 'test', apiKey: 'k', customHeaders: null };
  const result = shouldAcceptGivenHealth(cfg, { ok: false, latencyMs: 5001, status: null, error: 'fetch failed' });
  assert.equal(result.accept, false);
  assert.match(result.reason, /fetch failed/, 'reason should include error message');
});
