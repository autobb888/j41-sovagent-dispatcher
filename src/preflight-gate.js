'use strict';
const { loadDispatcherConfig } = require('./config-loader.js');
const { probeLLM } = require('./llm-health.js');

const LLM_EXECUTOR_TYPE = 'local-llm';
const PROBE_CACHE_TTL_MS = 30 * 1000;

// Resolve the LLM config from ALREADY-LOADED agent and dispatcher configs.
// Returns null if the resolved executor is not local-llm (skip preflight).
// Callers (cli.js) own config loading; preflight-gate.js does NOT load configs itself.
function resolveAgentLLMConfig(agentCfg, dispatcherCfg) {
  const executor = agentCfg.executor || dispatcherCfg.executor.type || LLM_EXECUTOR_TYPE;
  if (executor !== LLM_EXECUTOR_TYPE) return null;

  // Resolve exactly as buildContainerEnv does (per-agent > global cfg > preset)
  const { LLM_PRESETS } = require('./executors/local-llm.js');
  const provider = agentCfg.llmProvider || dispatcherCfg.llm.provider || '';
  const preset = LLM_PRESETS[provider];
  const baseUrl = agentCfg.llmBaseUrl || dispatcherCfg.llm.base_url || (preset && preset.baseUrl) || '';
  const model = agentCfg.llmModel || dispatcherCfg.llm.model || (preset && preset.model) || '';
  const apiKey =
    agentCfg.llmApiKey ||
    (provider && dispatcherCfg.provider_keys[provider]) ||
    dispatcherCfg.llm.api_key ||
    '';
  const customHeaders = preset && preset.headers ? preset.headers(apiKey) : null;

  return { baseUrl, model, apiKey, customHeaders };
}

function shouldAcceptGivenHealth(cfg, health) {
  if (cfg === null) return { accept: true, reason: 'skipped (non-local-llm)' };
  if (health.ok) return { accept: true, reason: 'LLM healthy' };
  const reason = health.error
    ? `${health.status != null ? health.status + ': ' : ''}${health.error}`
    : `http ${health.status}`;
  return { accept: false, reason };
}

// preflightAllowsAccept receives already-loaded agentCfg and dispatcherCfg from
// the caller (cli.js), which owns loadAgentConfig / loadDispatcherConfig.
// deps.probeLLM may be injected for tests; otherwise the real probeLLM is used.
async function preflightAllowsAccept(state, agentInfo, agentCfg, dispatcherCfg, deps = {}) {
  if (dispatcherCfg.preflight && dispatcherCfg.preflight.llm_check === false) return true;

  const llmCfg = resolveAgentLLMConfig(agentCfg, dispatcherCfg);
  if (llmCfg === null) return true;

  if (!state.llmHealth) state.llmHealth = new Map();
  const cached = state.llmHealth.get(agentInfo.id);
  if (cached && cached.ok && (Date.now() - cached.at) < PROBE_CACHE_TTL_MS) {
    return true;
  }

  const probe = deps.probeLLM || probeLLM;
  const health = await probe(llmCfg);
  if (health.ok) {
    state.llmHealth.set(agentInfo.id, { ok: true, at: Date.now() });
  } else {
    state.emitEvent?.('agent.llm_down', {
      agentId: agentInfo.id,
      status: health.status,
      error: health.error,
    });
  }

  return health.ok;
}

module.exports = { resolveAgentLLMConfig, shouldAcceptGivenHealth, preflightAllowsAccept };
