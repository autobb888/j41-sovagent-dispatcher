'use strict';
// Task 6: Preflight LLM health gate unit tests.
// Verifies:
//   (1) resolveAgentLLMConfig: local-llm agent with kimi-nvidia preset → correct baseUrl/model/apiKey
//   (2) resolveAgentLLMConfig: webhook agent → null (skip preflight)
//   (3) resolveAgentLLMConfig: empty agentCfg falls back to global executor type
//   (4) resolveAgentLLMConfig: legacy keys.json executor=webhook (no agent-config.json) → null
//   (5) shouldAcceptGivenHealth: null cfg → accept=true, reason='skipped (non-local-llm)'
//   (6) shouldAcceptGivenHealth: ok=true → accept=true, reason='LLM healthy'
//   (7) shouldAcceptGivenHealth: ok=false → accept=false with error reason
//   (8) preflightAllowsAccept: ok probe is cached within 30s TTL (probe called once)
//   (9) preflightAllowsAccept: down result is NOT cached — re-probed on next call, both false
//
// resolveAgentLLMConfig now takes (agentCfg, dispatcherCfg) objects directly —
// no sandbox HOME setup needed; all config is passed by the caller (cli.js).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { resolveAgentLLMConfig, shouldAcceptGivenHealth, preflightAllowsAccept } = require('../src/preflight-gate.js');

// kimi-nvidia preset values (from src/executors/local-llm.js LLM_PRESETS)
const KIMI_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// Minimal valid dispatcherCfg for tests that don't care about global values
const BASE_DISPATCHER_CFG = { executor: { type: 'local-llm' }, llm: {}, provider_keys: {} };

// ── resolveAgentLLMConfig ─────────────────────────────────────────────────────

test('resolveAgentLLMConfig: local-llm agent with kimi-nvidia preset', (t) => {
  const agentCfg = {
    executor: 'local-llm',
    llmProvider: 'kimi-nvidia',
    llmModel: 'deepseek-ai/deepseek-v4-flash',
    llmApiKey: 'test-kimi-key',
  };
  const result = resolveAgentLLMConfig(agentCfg, BASE_DISPATCHER_CFG);

  assert.notEqual(result, null, 'should return a config object for local-llm executor');
  assert.equal(result.baseUrl, KIMI_NVIDIA_BASE_URL, 'baseUrl from kimi-nvidia preset');
  assert.equal(result.model, 'deepseek-ai/deepseek-v4-flash', 'model from agent override');
  assert.equal(result.apiKey, 'test-kimi-key', 'apiKey from agent llmApiKey');
  assert.equal(result.customHeaders, null, 'kimi-nvidia has no custom headers function');
});

test('resolveAgentLLMConfig: webhook agent → null', (t) => {
  const agentCfg = { executor: 'webhook', executorUrl: 'https://example.com/webhook' };
  const result = resolveAgentLLMConfig(agentCfg, BASE_DISPATCHER_CFG);
  assert.equal(result, null, 'should return null for non-local-llm executor');
});

test('resolveAgentLLMConfig: empty agentCfg falls back to global executor (local-llm default) → not null', (t) => {
  // No agent-config.json → loadAgentConfig returns {} → executor falls back to dispatcherCfg
  const result = resolveAgentLLMConfig({}, { executor: { type: 'local-llm' }, llm: {}, provider_keys: {} });
  assert.notEqual(result, null, 'default executor is local-llm → returns config (possibly empty)');
  assert.equal(typeof result, 'object');
});

test('resolveAgentLLMConfig: legacy keys.json executor=webhook → null', (t) => {
  // loadAgentConfig falls back to keys.json when no agent-config.json exists.
  // A keys.json with executor:'webhook' yields agentCfg containing executor='webhook'.
  // Preflight must return null (skip LLM check) for these legacy webhook agents.
  const agentCfg = { executor: 'webhook', executorUrl: 'https://example.com/webhook' };
  const dispatcherCfg = { executor: { type: 'local-llm' }, llm: {}, provider_keys: {} };
  const result = resolveAgentLLMConfig(agentCfg, dispatcherCfg);
  assert.equal(result, null, 'legacy keys.json executor=webhook → null (skip LLM preflight)');
});

test('resolveAgentLLMConfig: global executor type webhook (no agentCfg override) → null', (t) => {
  const result = resolveAgentLLMConfig({}, { executor: { type: 'webhook' }, llm: {}, provider_keys: {} });
  assert.equal(result, null, 'global webhook executor → null');
});

// ── shouldAcceptGivenHealth ───────────────────────────────────────────────────

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

// ── preflightAllowsAccept ─────────────────────────────────────────────────────

test('preflightAllowsAccept: ok probe is cached within 30s TTL (probe called once)', async (t) => {
  let probeCount = 0;
  const stubProbe = async () => {
    probeCount++;
    return { ok: true, status: 200, latencyMs: 50, error: null };
  };

  const state = {};
  const agentInfo = { id: 'llm-agent-cache-ok' };
  const agentCfg = {
    executor: 'local-llm',
    llmProvider: 'kimi-nvidia',
    llmModel: 'deepseek-ai/deepseek-v4-flash',
    llmApiKey: 'test-key',
  };
  const dispatcherCfg = { executor: { type: 'local-llm' }, llm: {}, provider_keys: {} };

  const r1 = await preflightAllowsAccept(state, agentInfo, agentCfg, dispatcherCfg, { probeLLM: stubProbe });
  const r2 = await preflightAllowsAccept(state, agentInfo, agentCfg, dispatcherCfg, { probeLLM: stubProbe });

  assert.equal(r1, true, 'first call: LLM OK → accept');
  assert.equal(r2, true, 'second call: cached → accept');
  assert.equal(probeCount, 1, 'second call within TTL must use cache — probe not called again');
});

test('preflightAllowsAccept: down result is NOT cached — re-probed on next call, both return false', async (t) => {
  let probeCount = 0;
  const stubProbe = async () => {
    probeCount++;
    return { ok: false, status: 503, latencyMs: 100, error: 'Service Unavailable' };
  };

  const state = {};
  const agentInfo = { id: 'llm-agent-down' };
  const agentCfg = {
    executor: 'local-llm',
    llmProvider: 'kimi-nvidia',
    llmModel: 'deepseek-ai/deepseek-v4-flash',
    llmApiKey: 'test-key',
  };
  const dispatcherCfg = { executor: { type: 'local-llm' }, llm: {}, provider_keys: {} };

  const r1 = await preflightAllowsAccept(state, agentInfo, agentCfg, dispatcherCfg, { probeLLM: stubProbe });
  const r2 = await preflightAllowsAccept(state, agentInfo, agentCfg, dispatcherCfg, { probeLLM: stubProbe });

  assert.equal(r1, false, 'first call: LLM DOWN → decline');
  assert.equal(r2, false, 'second call: still DOWN → decline');
  assert.equal(probeCount, 2, 'down result must not be cached — probe called again on second call');
});
