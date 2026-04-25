'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const TOML = require('@iarna/toml');

const CONFIG_DIR = () => path.join(os.homedir(), '.j41', 'dispatcher');
const CONFIG_FILE = () => path.join(CONFIG_DIR(), 'config.toml');

const DEFAULTS = Object.freeze({
  platform: { api_url: 'https://api.junction41.io', network: 'verustest' },
  runtime: {
    max_concurrent: 0,
    keep_containers: false,
    require_finalize: false,
    skip_status_check: false,
    allow_local_upstream: false,
    health_port: 9842,
    webhook_url: '',
  },
  logging: { level: 'info', format: 'text' },
  executor: {
    type: 'local-llm', url: '', auth: '', timeout_ms: 60000,
    mcp_command: '', mcp_url: '', max_tool_rounds: 10,
  },
  llm: { provider: '', model: '', base_url: '', api_key: '' },
  provider_keys: {
    openai: '', anthropic: '', google: '', xai: '', groq: '',
    deepseek: '', mistral: '', together: '', fireworks: '', nvidia: '',
    cohere: '', perplexity: '', openrouter: '', kimi: '',
  },
  debug: { chat: false },
});

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function deepMerge(base, over) {
  const out = deepClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const ENV_OVERRIDES = [
  ['J41_API_URL',            'platform.api_url',         'string'],
  ['J41_NETWORK',            'platform.network',         'string'],
  ['J41_MAX_CONCURRENT',     'runtime.max_concurrent',   'int'],
  ['J41_KEEP_CONTAINERS',    'runtime.keep_containers',  'bool1'],
  ['J41_REQUIRE_FINALIZE',   'runtime.require_finalize', 'bool1'],
  ['J41_SKIP_STATUS_CHECK',  'runtime.skip_status_check','bool1'],
  ['J41_ALLOW_LOCAL_UPSTREAM','runtime.allow_local_upstream','bool1'],
  ['J41_HEALTH_PORT',        'runtime.health_port',      'int'],
  ['J41_WEBHOOK_URL',        'runtime.webhook_url',      'string'],
  ['J41_LOG_LEVEL',          'logging.level',            'string'],
  ['J41_LOG_FORMAT',         'logging.format',           'string'],
  ['J41_EXECUTOR',           'executor.type',            'string'],
  ['J41_EXECUTOR_URL',       'executor.url',             'string'],
  ['J41_EXECUTOR_AUTH',      'executor.auth',            'string'],
  ['J41_EXECUTOR_TIMEOUT',   'executor.timeout_ms',      'int'],
  ['J41_MCP_COMMAND',        'executor.mcp_command',     'string'],
  ['J41_MCP_URL',            'executor.mcp_url',         'string'],
  ['J41_MAX_TOOL_ROUNDS',    'executor.max_tool_rounds', 'int'],
  ['J41_LLM_PROVIDER',       'llm.provider',             'string'],
  ['J41_LLM_MODEL',          'llm.model',                'string'],
  ['J41_LLM_BASE_URL',       'llm.base_url',             'string'],
  ['J41_LLM_API_KEY',        'llm.api_key',              'string'],
  ['J41_DEBUG_CHAT',         'debug.chat',               'bool1'],
];

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyEnvOverrides(cfg) {
  for (const [env, dotted, kind] of ENV_OVERRIDES) {
    const raw = process.env[env];
    if (raw === undefined || raw === '') continue;
    let v;
    if (kind === 'int') { v = parseInt(raw); if (Number.isNaN(v)) continue; }
    else if (kind === 'bool1') v = raw === '1';
    else v = raw;
    setPath(cfg, dotted, v);
  }
  return cfg;
}

function stripDefaults(cur, defaults) {
  const out = {};
  for (const [k, v] of Object.entries(cur)) {
    const dv = defaults[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && dv && typeof dv === 'object') {
      const sub = stripDefaults(v, dv);
      if (Object.keys(sub).length > 0) out[k] = sub;
    } else if (!Object.is(v, dv)) {
      out[k] = v;
    }
  }
  return out;
}

function saveDispatcherConfig(partial) {
  const file = CONFIG_FILE();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing = {};
  try { existing = TOML.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const next = deepMerge(deepMerge(DEFAULTS, existing), partial);
  // Strip default-equal keys to keep file readable:
  const out = stripDefaults(next, DEFAULTS);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, TOML.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function loadDispatcherConfig(opts = {}) {
  const file = CONFIG_FILE();
  let onDisk = {};
  try { onDisk = TOML.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = deepMerge(DEFAULTS, onDisk);
  return applyEnvOverrides(merged);
}

module.exports = { loadDispatcherConfig, saveDispatcherConfig, CONFIG_FILE };
