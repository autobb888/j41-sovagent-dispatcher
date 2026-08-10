'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const TOML = require('@iarna/toml');

const CONFIG_DIR = () => path.join(os.homedir(), '.j41', 'dispatcher');
const CONFIG_FILE = () => path.join(CONFIG_DIR(), 'config.toml');

const DEFAULTS = Object.freeze({
  platform: { api_url: 'https://api.junction41.io', network: 'verustest', signer: '' },
  runtime: {
    max_concurrent: 0,
    keep_containers: false,
    require_finalize: false,
    skip_status_check: false,
    allow_local_upstream: false,
    health_port: 9842,
    control_api_port: 9843,
    webhook_url: '',
    job_log_retention: 'errors',   // 'off' | 'errors' | 'all'
    job_log_max_bytes: 5242880,    // 5 MB per output.log
    job_log_max_retained: 50,      // archived logs kept under jobs/_logs/
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
    // Worst-case reservation (audit H3): the buyer is admitted only if their
    // balance covers the MAX they could consume — estimated_input + the larger
    // of estimated_output and the request's declared max_tokens. A malicious
    // huge max_tokens is bounded by this ceiling so it can't deny service by
    // demanding an absurd reservation; the actual settle refunds back down to
    // real usage.
    max_output_tokens_cap: 200000,
    // Per-buyer in-flight concurrency cap (audit H3): N concurrent requests
    // can't collectively over-commit a thin balance past the single-request
    // worst-case reservation. Exceeding this returns 429.
    max_inflight_per_buyer: 4,
    suggested_topup_vrsc: 10,
    // Credit-low notify threshold (VRSC). When a buyer's balance crosses BELOW
    // this after a request, the dispatcher fires a one-time signed credit-low
    // notify to J41. null = fall back to suggested_topup_vrsc at read time.
    credit_low_threshold_vrsc: null,
    // NEW (2.1.14):
    rate_limit_rps: 10,             // tokens-per-second per buyer
    rate_limit_burst: 30,           // max bucket size per buyer
    rate_limit_max_buckets: 10000,  // LRU cap on # of distinct buyers tracked
    circuit_threshold: 3,           // consecutive_failures before circuit opens
    circuit_open_ms: 30000,         // how long the circuit stays open after tripping
  },
  // S1 — the job-poll interval. 0 = auto (max(60s, agents x 1s)). The README's only
  // scale guidance was "raise the interval or run a second dispatcher", and NEITHER
  // was possible: the interval was computed inline in cli.js with no config or env
  // path, and `start` SIGTERMs the PID in dispatcher.pid — so an operator following
  // the docs took their own fleet down.
  poll: { interval_ms: 0 },
  deposit: { poll_interval_ms: 60000 },
  health: { poll_interval_ms: 60000 },
  webhook: { max_body_bytes: 1048576 },
  retry: { rate_limit_backoff_multiplier: 3 },
  // Token budget enforcement (WP-D4). vrsc_usd_rate is USD per VRSC, set by
  // the operator (0 = unset). The host stamps the rate + a timestamp into
  // each job container's env; unset/stale rates fail closed in the container
  // (jobs run on fallback_token_budget; extensions are never auto-priced).
  budget: {
    vrsc_usd_rate: 0,
    rate_max_age_ms: 86400000,      // rate older than this counts as missing (24h)
    spend_fraction: 0.6,            // share of job value spendable on LLM cost
    fallback_token_budget: 50000,   // budget when rate/model can't price the job
    warning_percent: 80,            // budget % that triggers an extension ask
    extension_wait_ms: 600000,      // exhausted + unapproved this long → deliver partial
  },
  debug: { chat: false },
  // Jailbox (legacy "workspace") — admitting an agent into the buyer's
  // environment. PARKED in favour of deliver-and-review (see JAILBOX_PARKED.md
  // and docs spec 2026-06-12-vdxf-v2-schema-design §3b). Default OFF: the
  // dispatcher refuses to start a jailbox session unless an operator explicitly
  // opts back in with JAILBOX_ENABLED=1. The audit-log / attestation machinery
  // is retained intact regardless of this flag.
  jailbox: { enabled: false },
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
  ['J41_PROXY_MAX_OUTPUT_TOKENS_CAP','proxy.max_output_tokens_cap','int'],
  ['J41_PROXY_MAX_INFLIGHT_PER_BUYER','proxy.max_inflight_per_buyer','int'],
  ['J41_PROXY_SUGGESTED_TOPUP', 'proxy.suggested_topup_vrsc','int'],
  ['J41_PROXY_CREDIT_LOW_THRESHOLD', 'proxy.credit_low_threshold_vrsc','float'],
  ['J41_PROXY_RATE_LIMIT_RPS',         'proxy.rate_limit_rps',         'int'],
  ['J41_PROXY_RATE_LIMIT_BURST',       'proxy.rate_limit_burst',       'int'],
  ['J41_PROXY_RATE_LIMIT_MAX_BUCKETS', 'proxy.rate_limit_max_buckets', 'int'],
  ['J41_PROXY_CIRCUIT_THRESHOLD',      'proxy.circuit_threshold',      'int'],
  ['J41_PROXY_CIRCUIT_OPEN_MS',        'proxy.circuit_open_ms',        'int'],
  ['J41_POLL_INTERVAL_MS',      'poll.interval_ms',         'int'],
  ['J41_DEPOSIT_POLL_INTERVAL', 'deposit.poll_interval_ms', 'int'],
  // `bool` (not bool1) deliberately: this is default-ON, so J41_FEE_SWEEP=true
  // must not silently mean "disabled". See applyEnvOverrides.
  ['J41_FEE_SWEEP',            'fee_sweep.enabled',        'bool'],
  ['J41_FEE_SWEEP_FLOOR',      'fee_sweep.floor_writes',   'int'],
  // _MS suffix is load-bearing: the CLI flag --fee-sweep-interval takes MINUTES.
  // An unsuffixed env var named the same as the flag invites `=30` meaning
  // 30 minutes, which would land as 30ms and clamp to a 1-minute cadence —
  // 30x the intended getUtxos/auth traffic across the whole fleet.
  ['J41_FEE_SWEEP_INTERVAL_MS','fee_sweep.interval_ms',    'int'],
  ['J41_HEALTH_POLL_INTERVAL',  'health.poll_interval_ms',  'int'],
  ['J41_WEBHOOK_MAX_BODY',      'webhook.max_body_bytes',   'int'],
  ['J41_RATE_LIMIT_BACKOFF_MULTIPLIER','retry.rate_limit_backoff_multiplier','int'],
  ['J41_VRSC_USD_RATE',           'budget.vrsc_usd_rate',         'float'],
  ['J41_VRSC_RATE_MAX_AGE_MS',    'budget.rate_max_age_ms',       'int'],
  ['J41_BUDGET_SPEND_FRACTION',   'budget.spend_fraction',        'float'],
  ['J41_FALLBACK_TOKEN_BUDGET',   'budget.fallback_token_budget', 'int'],
  ['J41_BUDGET_WARNING_PERCENT',  'budget.warning_percent',       'int'],
  ['J41_BUDGET_EXTENSION_WAIT_MS','budget.extension_wait_ms',     'int'],
  ['J41_HEALTH_PORT',        'runtime.health_port',      'int'],
  ['J41_CONTROL_API_PORT',   'runtime.control_api_port', 'int'],
  ['J41_WEBHOOK_URL',        'runtime.webhook_url',      'string'],
  ['J41_JOB_LOG_RETENTION',    'runtime.job_log_retention',    'string'],
  ['J41_JOB_LOG_MAX_BYTES',    'runtime.job_log_max_bytes',    'int'],
  ['J41_JOB_LOG_MAX_RETAINED', 'runtime.job_log_max_retained', 'int'],
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
  // Jailbox parked: default-off. Set JAILBOX_ENABLED=1 to re-enable the
  // "agent works inside the buyer's environment" sandbox. Like J41_DEBUG_CHAT,
  // this is read here via cfg.jailbox.enabled (dispatcher gate) AND forwarded
  // into the job-agent container env (buildContainerEnv) so the in-container
  // connectWorkspace() funnel honours it in Docker mode too.
  ['JAILBOX_ENABLED',        'jailbox.enabled',          'bool1'],
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
    else if (kind === 'float') { v = parseFloat(raw); if (!Number.isFinite(v)) continue; }
    else if (kind === 'bool1') v = raw === '1';
    else if (kind === 'bool') {
      // Word-tolerant boolean, for DEFAULT-ON safety features. `bool1` treats
      // anything but '1' as false, so `J41_FEE_SWEEP=true` would SILENTLY DISABLE
      // the fee sweep — the intuitive "enable" value turning a money-safety
      // feature off. bool1 is fine for default-off opt-ins (failing to false is
      // safe there); it is not fine here.
      const s = String(raw).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) v = true;
      else if (['0', 'false', 'no', 'off', 'disabled'].includes(s)) v = false;
      else {
        console.warn(`[Config] ${env}="${raw}" is not a recognised boolean — ignoring (expected true/false)`);
        continue;
      }
    }
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
  // Sandbox guard FIRST: if HOME is /tmp-rooted AND the caller did not supply
  // an explicit envFile, refuse default-path migration entirely. We must never
  // mutate the real install-dir .env from a sandboxed test HOME — whether or
  // not it currently exists — so this is checked before the existence
  // short-circuit, making the guard reliable regardless of the working tree.
  if (!explicitEnvFile && isSandboxedHome()) {
    return { migrated: false, reason: 'sandboxed-home' };
  }
  if (!fs.existsSync(envFile)) return { migrated: false, reason: 'no-env-file' };
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
  // Platform-signer trust anchor (signing-oracle #1): the SDK's witness
  // verification reads J41_PLATFORM_SIGNER from process.env. Persist it via
  // config ([platform] signer) so it survives restarts regardless of how the
  // dispatcher is launched. An explicit env var still wins (set only if unset).
  // The value is a public R-address, not a secret.
  if (result.platform && result.platform.signer && !process.env.J41_PLATFORM_SIGNER) {
    process.env.J41_PLATFORM_SIGNER = result.platform.signer;
  }
  if (useCache) {
    _cachedConfig = result;
    _cachedAt = Date.now();
  }
  return result;
}

/**
 * Read platform.network straight from the on-disk config file, BYPASSING env
 * overrides and defaults. Security-sensitive callers (the mainnet gate) use
 * this so J41_NETWORK env cannot downgrade a mainnet deployment to testnet.
 * @returns {string|null} the file's platform.network, or null if unset/unreadable
 */
function fileConfiguredNetwork() {
  try {
    const onDisk = TOML.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    return (onDisk && onDisk.platform && onDisk.platform.network) || null;
  } catch { return null; }
}

module.exports = { loadDispatcherConfig, saveDispatcherConfig, migrateLegacyEnv, invalidateConfigCache, CONFIG_FILE, _resetMigrationState, fileConfiguredNetwork };
