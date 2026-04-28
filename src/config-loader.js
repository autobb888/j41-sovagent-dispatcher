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
  proxy: {
    upstream_timeout_ms: 60000,
    estimated_input_tokens: 4000,
    estimated_output_tokens: 2000,
    suggested_topup_vrsc: 10,
    // NEW (2.1.14):
    rate_limit_rps: 10,             // tokens-per-second per buyer
    rate_limit_burst: 30,           // max bucket size per buyer
    rate_limit_max_buckets: 10000,  // LRU cap on # of distinct buyers tracked
  },
  deposit: { poll_interval_ms: 60000 },
  health: { poll_interval_ms: 60000 },
  webhook: { max_body_bytes: 1048576 },
  retry: { rate_limit_backoff_multiplier: 3 },
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
  ['J41_PROXY_UPSTREAM_TIMEOUT','proxy.upstream_timeout_ms','int'],
  ['J41_PROXY_ESTIMATED_INPUT', 'proxy.estimated_input_tokens','int'],
  ['J41_PROXY_ESTIMATED_OUTPUT','proxy.estimated_output_tokens','int'],
  ['J41_PROXY_SUGGESTED_TOPUP', 'proxy.suggested_topup_vrsc','int'],
  ['J41_PROXY_RATE_LIMIT_RPS',         'proxy.rate_limit_rps',         'int'],
  ['J41_PROXY_RATE_LIMIT_BURST',       'proxy.rate_limit_burst',       'int'],
  ['J41_PROXY_RATE_LIMIT_MAX_BUCKETS', 'proxy.rate_limit_max_buckets', 'int'],
  ['J41_DEPOSIT_POLL_INTERVAL', 'deposit.poll_interval_ms', 'int'],
  ['J41_HEALTH_POLL_INTERVAL',  'health.poll_interval_ms',  'int'],
  ['J41_WEBHOOK_MAX_BODY',      'webhook.max_body_bytes',   'int'],
  ['J41_RATE_LIMIT_BACKOFF_MULTIPLIER','retry.rate_limit_backoff_multiplier','int'],
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
  // J41_DEBUG_CHAT has a dual-read pattern by design: the dispatcher reads
  // it via cfg.debug.chat (here) to decide whether to inject J41_DEBUG_CHAT=1
  // into job containers (see buildContainerEnv in cli.js); job-agent.js then
  // reads process.env.J41_DEBUG_CHAT directly inside the container, since
  // process.env is the only Docker→process channel. Both reads are correct.
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

// Sync sleep using Atomics.wait — used in the file-lock retry loop.
function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

// Advisory file lock around the read-modify-write cycle in saveDispatcherConfig.
// Two simultaneous dashboards racing a write could otherwise produce a torn
// merge (each reads the pre-write state, A's write lands, then B's write
// overwrites with B's view that doesn't include A's changes). The lock makes
// concurrent saves serial, so each one merges over the other's committed state.
// Stale-lock detection (>30s old) protects against a writer that crashed mid-save.
function withConfigLock(fn) {
  const lockFile = CONFIG_FILE() + '.lock';
  const dir = path.dirname(lockFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const STALE_MS = 30_000;
  const TIMEOUT_MS = 10_000;
  const start = Date.now();
  let fd;
  while (true) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock cleanup
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          try { fs.unlinkSync(lockFile); } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error(`config.toml lock timeout after ${TIMEOUT_MS}ms (${lockFile})`);
      }
      sleepSync(50);
    }
  }
  try {
    try { fs.writeSync(fd, String(process.pid)); } catch {}
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function saveDispatcherConfig(partial) {
  const file = CONFIG_FILE();
  return withConfigLock(() => {
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
    invalidateConfigCache();
    return file;
  });
}

// --- Migration helpers ---

const ENV_TO_TOML = Object.fromEntries(ENV_OVERRIDES.map(([env, dotted, kind]) => [env, { dotted, kind }]));

const PROVIDER_KEY_ENV_MAP = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GOOGLE_API_KEY: 'google',
  XAI_API_KEY: 'xai',
  GROQ_API_KEY: 'groq',
  DEEPSEEK_API_KEY: 'deepseek',
  MISTRAL_API_KEY: 'mistral',
  TOGETHER_API_KEY: 'together',
  FIREWORKS_API_KEY: 'fireworks',
  NVIDIA_API_KEY: 'nvidia',
  COHERE_API_KEY: 'cohere',
  PERPLEXITY_API_KEY: 'perplexity',
  OPENROUTER_API_KEY: 'openrouter',
  KIMI_API_KEY: 'kimi',
};

const MIGRATION_BANNER = [
  '# MIGRATED — values from this file have been moved to:',
  '#   ~/.j41/dispatcher/config.toml',
  '# This file is no longer read by the dispatcher and is safe to delete',
  '# after verifying config.toml has the expected values.',
  '#',
].join('\n');

function parseDotEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}

// Like deepMerge, but `over` only writes keys that aren't already present
// (or are empty string) in `base`. Used so an existing config.toml wins.
function mergeMissingOnly(base, over) {
  const out = deepClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeMissingOnly(out[k] && typeof out[k] === 'object' ? out[k] : {}, v);
    } else if (out[k] === undefined || out[k] === '' || out[k] === null) {
      out[k] = v;
    }
  }
  return out;
}

// Detect a sandboxed HOME (test runs that override HOME=/tmp/...). In that mode,
// CONFIG_FILE() resolves under the sandbox but the default envFile resolves to
// the REAL install-dir .env. Without this guard, a sandboxed test could banner
// the real .env while writing config.toml to the sandbox — leaving the real
// dispatcher in a broken state (banner says migrated, but no config.toml exists
// in the real HOME). Refuse migration in that scenario unless the caller passes
// an explicit envFile (in which case they're testing the migration itself and
// know what they're doing).
function isSandboxedHome() {
  const home = os.homedir();
  return home.startsWith('/tmp/') || home.startsWith('/var/tmp/') || home.startsWith('/private/tmp/');
}

function migrateLegacyEnv(opts = {}) {
  const explicitEnvFile = !!opts.envFile;
  const envFile = opts.envFile || path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return { migrated: false, reason: 'no-env-file' };
  // Sandbox guard: if HOME is /tmp-rooted AND the caller did not supply an
  // explicit envFile, refuse to mutate whichever .env we'd default to (almost
  // certainly the real install-dir one, which is exactly the cross-boundary
  // pattern we want to avoid).
  if (!explicitEnvFile && isSandboxedHome()) {
    return { migrated: false, reason: 'sandboxed-home' };
  }
  const text = fs.readFileSync(envFile, 'utf8');
  if (text.startsWith('# MIGRATED')) return { migrated: false, reason: 'already-migrated' };

  // Build the partial from .env contents
  const parsed = parseDotEnv(text);
  const partial = {};
  for (const [envName, val] of Object.entries(parsed)) {
    if (!val) continue;
    const map = ENV_TO_TOML[envName];
    if (map) {
      let v = val;
      if (map.kind === 'int') v = parseInt(val);
      else if (map.kind === 'bool1') v = val === '1' || val === 'true';
      setPath(partial, map.dotted, v);
    } else if (PROVIDER_KEY_ENV_MAP[envName]) {
      setPath(partial, `provider_keys.${PROVIDER_KEY_ENV_MAP[envName]}`, val);
    }
  }
  if (Object.keys(partial).length === 0) {
    fs.writeFileSync(envFile, MIGRATION_BANNER + '\n' + text);
    return { migrated: false, reason: 'no-recognized-keys' };
  }

  // If config.toml already exists, merge — but only fill gaps; don't overwrite
  // values the operator has already set in the new file.
  let existing = {};
  try { existing = TOML.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); } catch {}
  const merged = mergeMissingOnly(existing, partial);
  saveDispatcherConfig(merged);
  fs.writeFileSync(envFile, MIGRATION_BANNER + '\n' + text);
  return { migrated: true, target: CONFIG_FILE() };
}

let migrationAttempted = false;

function _resetMigrationState() { migrationAttempted = false; }

// In-process cache for hot-path readers (proxy-handler runs this per-request).
// 1s TTL is a deliberate compromise: short enough that an operator hand-editing
// config.toml sees changes within a second, long enough that a heavy proxy
// load isn't paying TOML-parse cost on every request. saveDispatcherConfig
// invalidates the cache automatically so dashboard writes are visible
// immediately. Tests pass opts to bypass cache entirely.
const CACHE_TTL_MS = 1000;
let _cachedConfig = null;
let _cachedAt = 0;

function invalidateConfigCache() { _cachedConfig = null; _cachedAt = 0; }

function loadDispatcherConfig(opts = {}) {
  const useCache = Object.keys(opts).length === 0;
  if (useCache && _cachedConfig && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
    return _cachedConfig;
  }
  if (!opts.skipMigration && !migrationAttempted) {
    migrationAttempted = true;
    try { migrateLegacyEnv({ envFile: opts.legacyEnvFile }); } catch {}
  }
  const file = CONFIG_FILE();
  let onDisk = {};
  try { onDisk = TOML.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = deepMerge(DEFAULTS, onDisk);
  const result = applyEnvOverrides(merged);
  if (useCache) {
    _cachedConfig = result;
    _cachedAt = Date.now();
  }
  return result;
}

module.exports = { loadDispatcherConfig, saveDispatcherConfig, migrateLegacyEnv, invalidateConfigCache, CONFIG_FILE, _resetMigrationState };
