'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadDispatcherConfig } = require('./config-loader.js');
const { probeLLM } = require('./llm-health.js');

const LLM_EXECUTOR_TYPE = 'local-llm';
const PROBE_CACHE_TTL_MS = 30 * 1000;

function _loadAgentConfig(agentId) {
  const agentsDir = path.join(os.homedir(), '.j41', 'dispatcher', 'agents');
  let config = {};
  try {
    const configPath = path.join(agentsDir, agentId, 'agent-config.json');
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    // No config
  }
  return config;
}

function resolveAgentLLMConfig(agentInfo) {
  const cfg = loadDispatcherConfig();
  const agentCfg = _loadAgentConfig(agentInfo.id);

  const executor = agentCfg.executor || cfg.executor.type || LLM_EXECUTOR_TYPE;
  if (executor !== LLM_EXECUTOR_TYPE) return null;

  // Resolve exactly as buildContainerEnv does (per-agent > global cfg > preset)
  const { LLM_PRESETS } = require('./executors/local-llm.js');
  const provider = agentCfg.llmProvider || cfg.llm.provider || '';
  const preset = LLM_PRESETS[provider];
  const baseUrl = agentCfg.llmBaseUrl || cfg.llm.base_url || (preset && preset.baseUrl) || '';
  const model = agentCfg.llmModel || cfg.llm.model || (preset && preset.model) || '';
  const apiKey =
    agentCfg.llmApiKey ||
    (provider && cfg.provider_keys[provider]) ||
    cfg.llm.api_key ||
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

async function preflightAllowsAccept(state, agentInfo) {
  const cfg = loadDispatcherConfig();
  if (cfg.preflight && cfg.preflight.llm_check === false) return true;

  const llmCfg = resolveAgentLLMConfig(agentInfo);
  if (llmCfg === null) return true;

  if (!state.llmHealth) state.llmHealth = new Map();
  const cached = state.llmHealth.get(agentInfo.id);
  if (cached && cached.ok && (Date.now() - cached.at) < PROBE_CACHE_TTL_MS) {
    return true;
  }

  const health = await probeLLM(llmCfg);
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
