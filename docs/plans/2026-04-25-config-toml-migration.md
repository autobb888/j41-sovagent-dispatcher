# Dispatcher Config Migration: `.env` → `~/.j41/dispatcher/config.toml`

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move dispatcher process config (and provider API keys in particular) from a shell-style `.env` at the install dir into a structured TOML file at `~/.j41/dispatcher/config.toml` (mode 0600), so secrets stop entering `process.env` (and therefore stop being inheritable by every child process the dispatcher spawns), while preserving env-var override for ops convenience.

**Architecture:** A single `loadDispatcherConfig()` helper returns a deeply-merged view: built-in defaults ← `config.toml` on disk ← optional `process.env.X` runtime override (per-key, ops convenience only). Secrets like `OPENAI_API_KEY` are read from the file directly when needed and forwarded *explicitly* to spawned Docker containers — they never live in the dispatcher's own `process.env`. A first-run migration reads any pre-existing `.env` at the dispatcher install dir and rewrites its values into `config.toml`, leaving the old `.env` in place with a banner comment so the operator knows it's been superseded.

**Tech Stack:**
- `@iarna/toml` (~80KB, zero-dep, well-maintained TOML parser/stringifier)
- Node `fs` with explicit `mode: 0o600`
- Existing `node:test` runner (already in `package.json` test script)

**Scope boundaries:**
- IN scope: `cli.js`, `dashboard.js`, `control.js`, `deposit-watcher.js`, `proxy-handler.js`, `logger.js` — these run in the dispatcher's *host* process.
- OUT of scope: `job-agent.js`, `executors/*.js`, `sign-attestation.js` — these run **inside Docker job containers**, where `process.env` is the only ingress channel (Docker sets it via `-e`). The dispatcher will continue injecting per-job env vars when launching containers, but will read those values from `config.toml` (or per-agent `agent-config.json`) instead of inheriting them from its own env.
- OUT of scope: `~/.j41/dispatcher/config.json` (runtime state — already 0600, machine-edited, different concern).
- OUT of scope: `~/.j41/dispatcher/agents/<id>/keys.json` (already 0600, already correct location). WIFs are already not in `.env`.

---

## File Structure

```
src/
  config-loader.js           # NEW: loadDispatcherConfig, saveDispatcherConfig, migrateLegacyEnv
test/
  config-loader.test.js      # NEW: defaults, round-trip, env-override, migration
docs/
  config.toml.example        # NEW: documented sample with all keys
```

**Modified:**
- `package.json` — add `@iarna/toml`; bump version `2.1.4` → `2.1.5`
- `src/cli.js` — replace ~12 `process.env.J41_*` reads with `cfg.X`
- `src/dashboard.js` — remove `loadEnv()`, replace ~10 callers, rewrite "Configure Provider" write path to TOML
- `src/control.js`, `src/deposit-watcher.js`, `src/proxy-handler.js`, `src/logger.js` — replace 1–3 env reads each
- `CLAUDE.md` — new "Configuration" section
- `.env.example` — add a deprecation banner; keep file so operators upgrading aren't surprised
- `README.md` — update install/configure section

**File responsibility split:**
- `config-loader.js`: pure config concerns. No SDK calls. Exports `loadDispatcherConfig()`, `saveDispatcherConfig(partial)`, `getProviderApiKey(cfg, provider)`, `migrateLegacyEnv()`. Single-purpose, single-import.
- Callers: import `loadDispatcherConfig()` once near top of file, use returned object. No more scattered `process.env.X` reads in dispatcher-process code.

---

## TOML schema (locked)

```toml
# ~/.j41/dispatcher/config.toml
# Mode 0600. Edited by `j41-dispatcher dashboard` or by hand.
# Process env vars (J41_API_URL, etc.) override per-key for ops convenience.

[platform]
api_url = "https://api.junction41.io"
network = "verustest"

[runtime]
max_concurrent = 0          # 0 = unlimited
keep_containers = false
require_finalize = false
skip_status_check = false
allow_local_upstream = false
health_port = 9842
webhook_url = ""            # public webhook URL for event-driven mode (cloudflared etc.)

[logging]
level = "info"              # debug, info, warn, error
format = "text"             # text, json

[executor]
type = "local-llm"          # local-llm, webhook, langgraph, langserve, a2a, mcp
url = ""
auth = ""
timeout_ms = 60000
mcp_command = ""
mcp_url = ""
max_tool_rounds = 10

[llm]
provider = ""               # openai, claude, gemini, ... (one of LLM_PRESETS keys)
model = ""
base_url = ""               # override preset.baseUrl
api_key = ""                # override preset.envKey lookup

[provider_keys]
# Set the key for your active provider. Read by dispatcher when spawning
# job containers — never enters dispatcher's own process.env.
openai = ""
anthropic = ""
google = ""
xai = ""
groq = ""
deepseek = ""
mistral = ""
together = ""
fireworks = ""
nvidia = ""
cohere = ""
perplexity = ""
openrouter = ""
kimi = ""

[debug]
chat = false                # gates [chat] event log (was J41_DEBUG_CHAT=1)
```

---

## Env-var override matrix (locked)

These env vars override the corresponding TOML keys at runtime (CI / one-shot ops). The TOML file remains the source of truth — the override is read on each call to `loadDispatcherConfig()`.

| Env var | TOML path |
|---|---|
| `J41_API_URL` | `platform.api_url` |
| `J41_NETWORK` | `platform.network` |
| `J41_MAX_CONCURRENT` | `runtime.max_concurrent` |
| `J41_KEEP_CONTAINERS` | `runtime.keep_containers` (`'1'` → true) |
| `J41_REQUIRE_FINALIZE` | `runtime.require_finalize` (`'1'` → true) |
| `J41_SKIP_STATUS_CHECK` | `runtime.skip_status_check` (`'1'` → true) |
| `J41_ALLOW_LOCAL_UPSTREAM` | `runtime.allow_local_upstream` (`'1'` → true) |
| `J41_HEALTH_PORT` | `runtime.health_port` |
| `J41_WEBHOOK_URL` | `runtime.webhook_url` |
| `J41_LOG_LEVEL` | `logging.level` |
| `J41_LOG_FORMAT` | `logging.format` |
| `J41_EXECUTOR` | `executor.type` |
| `J41_EXECUTOR_URL` | `executor.url` |
| `J41_EXECUTOR_AUTH` | `executor.auth` |
| `J41_EXECUTOR_TIMEOUT` | `executor.timeout_ms` |
| `J41_MCP_COMMAND` | `executor.mcp_command` |
| `J41_MCP_URL` | `executor.mcp_url` |
| `J41_MAX_TOOL_ROUNDS` | `executor.max_tool_rounds` |
| `J41_LLM_PROVIDER` | `llm.provider` |
| `J41_LLM_MODEL` | `llm.model` |
| `J41_LLM_BASE_URL` | `llm.base_url` |
| `J41_LLM_API_KEY` | `llm.api_key` |
| `J41_DEBUG_CHAT` | `debug.chat` (`'1'` → true) |

**Provider keys** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are NOT environment-overridable in dispatcher process for security. Operators set them via `dashboard` or by editing `config.toml` directly. (Container-side, the dispatcher injects `${PRESET.envKey}=${cfg.provider_keys.X}` per-job.)

---

## Build sequence

Tasks 1–3 build the loader in isolation (no callsite changes). Tasks 4–7 wire each consumer file. Task 8 verifies E2E. Tasks 1–3 must be done in order; 4–7 are mostly independent (only the dashboard rewrite is large).

---

### Task 1: Add TOML dependency + config-loader skeleton

**Files:**
- Create: `src/config-loader.js`
- Create: `test/config-loader.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add `@iarna/toml` to dependencies and bump version**

```bash
yarn add @iarna/toml
```

Then edit `package.json` version: `"2.1.4"` → `"2.1.5"`.

Verify:
```bash
node -e "console.log(require('@iarna/toml').stringify({a:1}))"
```
Expected: `a = 1` followed by newline.

- [ ] **Step 2: Write the failing test for default load**

Create `test/config-loader.test.js`:

```js
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
```

Run: `node --test test/config-loader.test.js`
Expected: FAIL — `Cannot find module '../src/config-loader.js'`.

- [ ] **Step 3: Create `src/config-loader.js` minimal skeleton**

```js
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

function loadDispatcherConfig(opts = {}) {
  const file = CONFIG_FILE();
  let onDisk = {};
  try { onDisk = TOML.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return deepMerge(DEFAULTS, onDisk);
}

module.exports = { loadDispatcherConfig, CONFIG_FILE };
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `node --test test/config-loader.test.js`
Expected: PASS — 1/1.

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock src/config-loader.js test/config-loader.test.js
git commit -m "feat(config): scaffold TOML config-loader with defaults"
```

---

### Task 2: Implement env-var overrides + save round-trip

**Files:**
- Modify: `src/config-loader.js`
- Modify: `test/config-loader.test.js`

- [ ] **Step 1: Write failing test for env override**

Append to `test/config-loader.test.js`:

```js
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
```

Run: `node --test test/config-loader.test.js`
Expected: FAIL — env override not honored, `saveDispatcherConfig` undefined.

- [ ] **Step 2: Implement override map + save in `config-loader.js`**

Add inside `config-loader.js` before `loadDispatcherConfig`:

```js
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
```

Update `loadDispatcherConfig`:

```js
function loadDispatcherConfig(opts = {}) {
  const file = CONFIG_FILE();
  let onDisk = {};
  try { onDisk = TOML.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = deepMerge(DEFAULTS, onDisk);
  return applyEnvOverrides(merged);
}
```

Add `saveDispatcherConfig`:

```js
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

module.exports = { loadDispatcherConfig, saveDispatcherConfig, CONFIG_FILE };
```

- [ ] **Step 3: Run tests**

Run: `node --test test/config-loader.test.js`
Expected: PASS — 3/3.

- [ ] **Step 4: Commit**

```bash
git add src/config-loader.js test/config-loader.test.js
git commit -m "feat(config): env-var overrides + atomic save with 0600"
```

---

### Task 3: Implement legacy `.env` migration

**Files:**
- Modify: `src/config-loader.js`
- Modify: `test/config-loader.test.js`

- [ ] **Step 1: Write failing test**

Append to `test/config-loader.test.js`:

```js
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
```

Run: `node --test test/config-loader.test.js`
Expected: FAIL — `migrateLegacyEnv is not a function`.

- [ ] **Step 2: Implement migration**

Add to `config-loader.js`:

```js
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
  `#   ~/.j41/dispatcher/config.toml`,
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

function migrateLegacyEnv(opts = {}) {
  const envFile = opts.envFile || path.resolve(__dirname, '..', '.env');
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
```

Update `loadDispatcherConfig` to auto-migrate on first call:

```js
let migrationAttempted = false;
function loadDispatcherConfig(opts = {}) {
  if (!opts.skipMigration && !migrationAttempted) {
    migrationAttempted = true;
    try { migrateLegacyEnv({ envFile: opts.legacyEnvFile }); } catch {}
  }
  const file = CONFIG_FILE();
  let onDisk = {};
  try { onDisk = TOML.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = deepMerge(DEFAULTS, onDisk);
  return applyEnvOverrides(merged);
}

// Test-only reset
function _resetMigrationState() { migrationAttempted = false; }

module.exports = { loadDispatcherConfig, saveDispatcherConfig, migrateLegacyEnv, CONFIG_FILE, _resetMigrationState };
```

Update each test that loads config to call `_resetMigrationState()` in setup so the singleton flag doesn't leak across tests.

- [ ] **Step 3: Run tests**

Run: `node --test test/config-loader.test.js`
Expected: PASS — 6/6.

- [ ] **Step 4: Commit**

```bash
git add src/config-loader.js test/config-loader.test.js
git commit -m "feat(config): migrate legacy .env into config.toml on first load"
```

---

### Task 4: Wire `cli.js` to config-loader (incl. removing the install-dir auto-loader)

**Files:**
- Modify: `src/cli.js`

⚠️ **Two security-critical changes** are bundled here:
- **Step 1 (CRITICAL)** removes the install-dir `.env` → `process.env` auto-loader that currently sits at lines 9–23. If we leave it in, every provider key in the operator's old `.env` continues to be loaded into `process.env` at startup, defeating the entire point of this migration.
- **Step 5 (CRITICAL)** rewrites both container-launch paths to source provider keys from `cfg.provider_keys` instead of inheriting from `process.env`. After Step 1, `process.env.OPENAI_API_KEY` is empty by design; without Step 5, the container also gets nothing.

The reads to replace (line numbers from current `2.1.4`):

| Line | Current | Replacement |
|---|---|---|
| 9–23 | install-dir `.env` auto-loader (writes into `process.env`) | **DELETE** — replaced by `loadDispatcherConfig()` |
| 61 | `process.env.J41_API_URL \|\| 'https://api.junction41.io'` | `cfg.platform.api_url` |
| 62 | `process.env.J41_NETWORK \|\| 'verustest'` | `cfg.platform.network` |
| 64 | `process.env.J41_MAX_CONCURRENT ? parseInt(...) : ...` | `cfg.runtime.max_concurrent > 0 ? cfg.runtime.max_concurrent : (_cfg.maxConcurrent ? parseInt(_cfg.maxConcurrent) : Infinity)` |
| 2855 | `process.env.J41_API_URL \|\| ...` | `cfg.platform.api_url` |
| 2859 | `process.env.J41_NETWORK \|\| ...` | `cfg.platform.network` |
| 2947 | `process.env.J41_KEEP_CONTAINERS === '1'` | `cfg.runtime.keep_containers` |
| 2952 | `validateExecutorUrl(process.env.J41_EXECUTOR_URL, ...)` | `validateExecutorUrl(cfg.executor.url, ...)` |
| 2953 | `validateExecutorUrl(process.env.J41_MCP_URL, ...)` | `validateExecutorUrl(cfg.executor.mcp_url, ...)` |
| 2954 | `validateExecutorUrl(process.env.KIMI_BASE_URL, ...)` | `validateExecutorUrl(cfg.llm.base_url, 'llm.base_url')` (Kimi preset's base URL is `cfg.llm.base_url` after migration; see Step 5 for container-side wiring) |
| 2957 | `process.env.J41_REQUIRE_FINALIZE === '1'` | `cfg.runtime.require_finalize` |
| 2958 | `process.env.J41_SKIP_STATUS_CHECK === '1'` | `cfg.runtime.skip_status_check` |
| 5063 | `process.env.J41_KEEP_CONTAINERS === '1'` (`keepContainers`) | `cfg.runtime.keep_containers` |
| 5083–5089 | `...['…OPENAI_API_KEY','KIMI_BASE_URL',…].filter(k => process.env[k]).map(k => '${k}=${process.env[k]}')` | replaced by `buildContainerEnv()` (Step 5) |
| 5221, 5487 | `process.env.J41_KEEP_CONTAINERS !== '1'` | `!cfg.runtime.keep_containers` |
| 5316–5332 | `OPTIONAL_PASSTHROUGH` loop in `startJobLocal` | replaced by `buildContainerEnv()` (Step 5) |

- [ ] **Step 1 (CRITICAL): Delete the install-dir `.env` auto-loader**

Remove lines 9–23 of `cli.js` entirely (the comment `// Auto-load .env from project root...` through the closing `}` of the `if (require('fs').existsSync(_envPath))` block). Replace with a single import + load:

```js
const { loadDispatcherConfig } = require('./config-loader.js');
const cfg = loadDispatcherConfig();
```

(The `loadDispatcherConfig()` call internally migrates any pre-existing install-dir `.env` to `~/.j41/dispatcher/config.toml` on first run, then returns the merged config. Provider keys from the old `.env` end up in `cfg.provider_keys`, never in `process.env`.)

Verify after edit:

```bash
grep -n "_envPath\|Auto-load .env" src/cli.js
```
Expected: no matches.

- [ ] **Step 2: Replace top-level constants**

```js
const J41_API_URL = cfg.platform.api_url;
const J41_NETWORK = cfg.platform.network;
const MAX_AGENTS = cfg.runtime.max_concurrent > 0
  ? cfg.runtime.max_concurrent
  : (_cfg.maxConcurrent ? parseInt(_cfg.maxConcurrent) : Infinity);
```

- [ ] **Step 3: Replace remaining `process.env.J41_*` and `process.env.KIMI_*` reads**

Use grep to find each:

```bash
grep -n "process\.env\.J41\|process\.env\.KIMI" src/cli.js
```

Replace each per the table above. **Leave alone** the non-J41 system facts: `process.env.HOME`, `process.env.USER`, `process.env.HOSTNAME`, `process.env.npm_config_prefix`. These are not config — they're inherited environment.

- [ ] **Step 4: Add `buildContainerEnv()` helper**

Add near `getExecutorEnvVars()` (around line 4877):

```js
// Build the env vars passed to a job container. Sources provider keys from
// cfg.provider_keys (NOT process.env), so the dispatcher process can run
// without provider keys in its own environment.
function buildContainerEnv(job, agentInfo, agentCfg, canaryToken, jobDir, keysPath) {
  const { LLM_PRESETS } = require('./executors/local-llm.js');
  // Per-agent override > global cfg
  const provider = (agentCfg && agentCfg.llmProvider) || cfg.llm.provider || '';
  const preset = LLM_PRESETS[provider];
  const baseUrl = (agentCfg && agentCfg.llmBaseUrl) || cfg.llm.base_url || (preset && preset.baseUrl) || '';
  const model = (agentCfg && agentCfg.llmModel) || cfg.llm.model || (preset && preset.model) || '';
  const apiKey =
    (agentCfg && agentCfg.llmApiKey) ||
    (provider && cfg.provider_keys[provider]) ||
    cfg.llm.api_key ||
    '';

  const env = {
    J41_API_URL: cfg.platform.api_url,
    J41_NETWORK: cfg.platform.network,
    J41_AGENT_ID: agentInfo.id,
    J41_IDENTITY: agentInfo.identity,
    J41_JOB_ID: job.id,
    J41_JOB_DIR: jobDir,
    J41_KEYS_FILE: keysPath,
    J41_SOUL_FILE: require('path').join(require('path').dirname(keysPath), 'SOUL.md'),
    J41_CANARY_TOKEN: canaryToken,
    JOB_TIMEOUT_MS: String(JOB_TIMEOUT_MS),
    J41_EXECUTOR: (agentCfg && agentCfg.executor) || cfg.executor.type,
    J41_LLM_PROVIDER: provider,
    J41_LLM_BASE_URL: baseUrl,
    J41_LLM_MODEL: model,
    J41_LLM_API_KEY: apiKey,
  };

  // Also populate the preset-specific env-key (e.g. OPENAI_API_KEY) for
  // executors that look it up by preset.envKey rather than the generic name.
  if (preset && preset.envKey && apiKey) {
    env[preset.envKey] = apiKey;
  }

  // Per-job lifecycle from service config (not from cfg)
  if (job.lifecycle?.idleTimeout) env.IDLE_TIMEOUT_MS = String(job.lifecycle.idleTimeout * 60000);
  if (job.lifecycle?.pauseTTL) env.PAUSE_TTL_MS = String(job.lifecycle.pauseTTL * 60000);

  // Optional MCP / executor-specific
  if (cfg.executor.mcp_command) env.J41_MCP_COMMAND = cfg.executor.mcp_command;
  if (cfg.executor.mcp_url)     env.J41_MCP_URL = cfg.executor.mcp_url;
  if (cfg.executor.auth)        env.J41_EXECUTOR_AUTH = cfg.executor.auth;
  if (cfg.executor.timeout_ms)  env.J41_EXECUTOR_TIMEOUT = String(cfg.executor.timeout_ms);
  if (cfg.executor.url)         env.J41_EXECUTOR_URL = cfg.executor.url;

  if (cfg.debug.chat) env.J41_DEBUG_CHAT = '1';

  return env;
}
```

- [ ] **Step 5 (CRITICAL): Replace both container-launch env-build paths**

**Path A — Docker container** (`startJobContainer`, around line 5075–5092):

Replace the entire `Env: [...]` array with:

```js
Env: Object.entries(buildContainerEnv(job, agentInfo, loadAgentConfig(agentInfo.id), canaryToken, jobDir, tmpKeysPath))
       .filter(([, v]) => v !== undefined && v !== '')
       .map(([k, v]) => `${k}=${v}`)
       .concat(getExecutorEnvVars(agentInfo).filter(s => !s.startsWith('J41_LLM_'))),
```

The `getExecutorEnvVars` concat preserves per-agent webhook/langgraph URLs that aren't covered by `buildContainerEnv` (those live entirely in per-agent config).

**Path B — Local mode** (`startJobLocal`, around line 5316–5332):

Delete the `OPTIONAL_PASSTHROUGH` array and its loop. Replace with:

```js
const containerEnv = buildContainerEnv(job, agentInfo, loadAgentConfig(agentInfo.id), canaryToken, jobDir, keysPath);
for (const [k, v] of Object.entries(containerEnv)) {
  if (v !== undefined && v !== '') env[k] = String(v);
}
const executorVars = getExecutorEnvVars(agentInfo);
for (const s of executorVars) {
  const eq = s.indexOf('=');
  if (eq > 0 && !s.startsWith('J41_LLM_')) env[s.slice(0, eq)] = s.slice(eq + 1);
}
```

(`loadAgentConfig` already exists in cli.js — search for its definition to confirm.)

- [ ] **Step 6: Verify both container paths no longer leak from `process.env`**

```bash
grep -n "process\.env\[" src/cli.js
```
Expected: only matches inside `WHITELISTED_ENV` loop and `getuid`/`getgid` lookups — no provider-key spreads.

```bash
grep -n "OPENAI_API_KEY\|ANTHROPIC_API_KEY\|GROQ_API_KEY" src/cli.js
```
Expected: no matches in cli.js (all moved to `buildContainerEnv()` via preset.envKey).

- [ ] **Step 7: Lint check**

```bash
node --check src/cli.js
```
Expected: no output (success).

- [ ] **Step 8: Commit**

```bash
git add src/cli.js
git commit -m "feat(config): wire cli.js to config-loader, remove .env auto-loader, source container env from cfg"
```

---

### Task 5: Wire `dashboard.js` to config-loader

**Files:**
- Modify: `src/dashboard.js`

This is the biggest single edit because the dashboard *writes* config in addition to reading it.

- [ ] **Step 1: Replace `loadEnv()` definition**

Around line 53–62, replace:

```js
function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}
```

With:

```js
const { loadDispatcherConfig, saveDispatcherConfig } = require('./config-loader.js');
function loadCfg() { return loadDispatcherConfig(); }
```

Also remove `const ENV_FILE = ...` constant.

- [ ] **Step 2: Replace each `loadEnv()` callsite**

Each callsite reads `env.J41_*` keys. Map them to the new config shape:

| Old | New |
|---|---|
| `loadEnv().J41_API_URL` | `loadCfg().platform.api_url` |
| `env.J41_WEBHOOK_URL` | `loadCfg().runtime.webhook_url` (add this key to schema) |
| `env.J41_LLM_PROVIDER` | `loadCfg().llm.provider` |
| `env[preset.envKey]` (looking up provider key by env name) | `loadCfg().provider_keys[providerName]` (look up by lower-case name; build a small helper `getProviderApiKey(cfg, presetName)`) |

Add `getProviderApiKey` to `config-loader.js`:

```js
function getProviderApiKey(cfg, presetName) {
  return cfg.provider_keys[presetName] || cfg.llm.api_key || '';
}
```

Add `runtime.webhook_url = ""` to DEFAULTS schema in `config-loader.js`, plus the env override `J41_WEBHOOK_URL → runtime.webhook_url`.

- [ ] **Step 3: Rewrite "Configure Provider API Key" write path**

Around lines 2186–2204 of `dashboard.js`. Replace the .env read/concat/write block with:

```js
// Persist provider + key to config.toml
const partial = { llm: { provider } };
if (preset.envKey && apiKey) {
  // preset.envKey is OPENAI_API_KEY etc.; map to provider_keys.<lowername>
  const lower = provider; // provider name already matches keys in DEFAULTS.provider_keys
  partial.provider_keys = { [lower]: apiKey };
}
saveDispatcherConfig(partial);
console.log(`\n  ✅ Updated ~/.j41/dispatcher/config.toml — provider: ${provider}`);
console.log(`  Restart dispatcher to apply.\n`);
```

- [ ] **Step 4: Lint check**

```bash
node --check src/dashboard.js
```

- [ ] **Step 5: Manual smoke**

```bash
node src/cli.js dashboard
```
Navigate to "Global LLM Default", set provider + key, exit, then:

```bash
cat ~/.j41/dispatcher/config.toml
```
Expected: TOML with `[llm]` section + `[provider_keys]` section.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js src/config-loader.js
git commit -m "feat(config): rewrite dashboard read/write to use config-loader"
```

---

### Task 6: Wire `control.js`, `deposit-watcher.js`, `proxy-handler.js`, `logger.js`

**Files:**
- Modify: `src/control.js`
- Modify: `src/deposit-watcher.js`
- Modify: `src/proxy-handler.js`
- Modify: `src/logger.js`

Each file has 1–3 `process.env.X` reads. Same pattern: import `loadDispatcherConfig`, replace.

- [ ] **Step 1: `logger.js`**

Replace lines 13–14:
```js
const LOG_LEVEL = (process.env.J41_LOG_LEVEL || 'info').toLowerCase();
const LOG_FORMAT = (process.env.J41_LOG_FORMAT || 'text').toLowerCase();
```
With:
```js
const { loadDispatcherConfig } = require('./config-loader.js');
const _cfg = loadDispatcherConfig();
const LOG_LEVEL = _cfg.logging.level.toLowerCase();
const LOG_FORMAT = _cfg.logging.format.toLowerCase();
```

- [ ] **Step 2: `control.js`**

Replace line 77's `process.env.J41_HEALTH_PORT` with `cfg.runtime.health_port` (after adding `loadDispatcherConfig` import).

- [ ] **Step 3: `proxy-handler.js`**

Replace line 41's `process.env.J41_ALLOW_LOCAL_UPSTREAM === '1'` with `cfg.runtime.allow_local_upstream`.

- [ ] **Step 4: `deposit-watcher.js`**

Replace line 234's `process.env.J41_API_URL || 'https://api.junction41.io'` with `cfg.platform.api_url`.

- [ ] **Step 5: Lint and run tests**

```bash
node --check src/*.js src/executors/*.js
node --test test/
```
Expected: all green; existing 20 tests + new 5 = 25 passing.

- [ ] **Step 6: Commit**

```bash
git add src/control.js src/deposit-watcher.js src/proxy-handler.js src/logger.js
git commit -m "feat(config): wire control/deposit/proxy/logger to config-loader"
```

---

### Task 7: Update CLAUDE.md, .env.example, docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.env.example` (add deprecation banner; keep file for upgrade clarity)
- Create: `docs/config.toml.example`
- Modify: `README.md`

- [ ] **Step 1: Add "Configuration" section to CLAUDE.md**

Insert after the "File Map" table:

```markdown
### Configuration

Source of truth: `~/.j41/dispatcher/config.toml` (mode 0600). Loaded once at process start by `loadDispatcherConfig()` in `src/config-loader.js`.

- Provider API keys (OpenAI, Anthropic, etc.) live under `[provider_keys]`. They are NEVER read from the dispatcher's `process.env`. They are forwarded explicitly to job containers via `docker run -e`.
- Runtime knobs (log level, max concurrent, etc.) accept env-var overrides per `ENV_OVERRIDES` in `config-loader.js` for ops convenience.
- Legacy `.env` files at the install dir are auto-migrated on first load and marked with a banner.

To edit: `j41-dispatcher dashboard` → "Configure Executor" / "Global LLM Default", or hand-edit the file.
```

- [ ] **Step 2: Add deprecation banner to `.env.example`**

Prepend:

```
# DEPRECATED — config has moved to ~/.j41/dispatcher/config.toml
# This file is no longer read by the dispatcher. See docs/config.toml.example
# for the new format. Existing .env files are auto-migrated on first start.
```

- [ ] **Step 3: Create `docs/config.toml.example`**

Copy the schema block from this plan's "TOML schema (locked)" section verbatim.

- [ ] **Step 4: Update README.md install/configure section**

Replace any `cp .env.example .env && edit .env` instruction with `j41-dispatcher dashboard → Configure Executor` (or hand-edit `~/.j41/dispatcher/config.toml`).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .env.example docs/config.toml.example README.md
git commit -m "docs(config): document TOML config; deprecate .env"
```

---

### Task 8: End-to-end verification + version bump

**Files:**
- Modify: `package.json` (already bumped in Task 1)

- [ ] **Step 1: Fresh-install scenario**

```bash
rm -rf /tmp/j41-test-home && mkdir -p /tmp/j41-test-home
HOME=/tmp/j41-test-home node src/cli.js --help
```
Expected: starts cleanly, `~/.j41/dispatcher/config.toml` does NOT exist (lazy-created on first save).

- [ ] **Step 2: Existing-`.env` migration scenario**

```bash
mkdir -p /tmp/j41-test-home2 && rm -rf /tmp/j41-test-home2/*
echo 'J41_NETWORK=verus' > .env  # in repo root
HOME=/tmp/j41-test-home2 node src/cli.js --help
cat /tmp/j41-test-home2/.j41/dispatcher/config.toml
head -3 .env  # banner present
```
Expected: config.toml created with `[platform] network = "verus"`, .env starts with `# MIGRATED`.

(Restore .env afterwards: `git checkout .env` — note: we keep the file in git.)

- [ ] **Step 3: Env-override scenario**

```bash
HOME=/tmp/j41-test-home J41_API_URL=https://staging.example node -e "
  const {loadDispatcherConfig} = require('./src/config-loader.js');
  console.log(loadDispatcherConfig().platform.api_url);
"
```
Expected: `https://staging.example`.

- [ ] **Step 4: Security-regression spot checks**

(a) Confirm provider keys do NOT enter dispatcher's `process.env`:
```bash
echo 'OPENAI_API_KEY=sk-leak-test' > .env
HOME=/tmp/j41-test-home3 node -e "
  require('./src/config-loader.js').loadDispatcherConfig({ legacyEnvFile: './.env' });
  console.log('process.env.OPENAI_API_KEY =', process.env.OPENAI_API_KEY || '(unset, good)');
"
git checkout .env
```
Expected: `(unset, good)`. Provider key is now in `~/.j41/dispatcher/config.toml` under `[provider_keys]`, not in `process.env`.

(b) Add a unit test that drives `buildContainerEnv()` end-to-end. Append to `test/config-loader.test.js` (or a sibling `test/cli-container-env.test.js` if you prefer to keep config-loader tests pure):

```js
test('buildContainerEnv sources provider key from cfg, not process.env', withTmpHome(async (t, tmp) => {
  const { saveDispatcherConfig, _resetMigrationState } = require('../src/config-loader.js');
  _resetMigrationState();
  saveDispatcherConfig({
    platform: { api_url: 'https://api.test', network: 'verus' },
    llm: { provider: 'openai', model: 'gpt-4.1' },
    provider_keys: { openai: 'sk-from-toml' },
  });
  // Critical: process.env.OPENAI_API_KEY MUST NOT be set for this test
  delete process.env.OPENAI_API_KEY;
  // Re-require cli.js fresh so it picks up the saved config
  delete require.cache[require.resolve('../src/cli.js')];
  // cli.js exports buildContainerEnv via a test hook (add one if not present):
  //   if (process.env.NODE_ENV === 'test') module.exports = { buildContainerEnv };
  process.env.NODE_ENV = 'test';
  const { buildContainerEnv } = require('../src/cli.js');
  const env = buildContainerEnv(
    { id: 'job-1', lifecycle: {} },
    { id: 'agent-1', identity: 'test@' },
    null,
    'canary-token-xxx',
    '/tmp/jobdir',
    '/tmp/keys.json'
  );
  assert.strictEqual(env.OPENAI_API_KEY, 'sk-from-toml');
  assert.strictEqual(env.J41_LLM_API_KEY, 'sk-from-toml');
  assert.strictEqual(env.J41_LLM_PROVIDER, 'openai');
  // The dispatcher's own process.env still doesn't have it:
  assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
}));
```

Note: this test requires cli.js to expose `buildContainerEnv` for testing. Add a guarded export at the bottom of cli.js:

```js
if (process.env.NODE_ENV === 'test') {
  module.exports = { buildContainerEnv, loadAgentConfig };
}
```

Run: `node --test test/`
Expected: passes — provider key flows from TOML into container env without ever touching dispatcher's `process.env.OPENAI_API_KEY`.

(c) Confirm the install-dir auto-loader is gone:
```bash
grep -n "Auto-load .env\|_envPath" src/cli.js
```
Expected: no matches.

- [ ] **Step 5: Confirm full test suite**

```bash
yarn test
```
Expected: all green; new 7 (6 in config-loader + 1 buildContainerEnv) + existing 20 = 27 tests.

- [ ] **Step 6: Confirm lint**

```bash
node --check src/*.js src/executors/*.js
```

- [ ] **Step 7: Manual dashboard smoke**

```bash
node src/cli.js dashboard
```
Navigate every screen that touches config, confirm it reads/writes config.toml, no crashes.

- [ ] **Step 8: Final commit**

```bash
git add -u
git commit -m "chore(release): dispatcher 2.1.5 — config.toml migration"
```

---

## Verification commands (full suite)

```bash
node --check src/*.js src/executors/*.js   # syntax
yarn test                                  # unit tests (25 expected)
node src/cli.js dashboard                  # smoke TUI
HOME=/tmp/x node src/cli.js --help         # fresh-install path
```

## Critical Files

| File | Action | Notes |
|------|--------|-------|
| `src/config-loader.js` | Create | Central loader, ~180 LOC |
| `test/config-loader.test.js` | Create | 5 tests |
| `package.json` | Modify | Add `@iarna/toml`; version 2.1.4→2.1.5 |
| `src/cli.js` | Modify | ~12 env reads → cfg lookups |
| `src/dashboard.js` | Modify | ~10 env reads → cfg lookups; rewrite write path |
| `src/control.js` | Modify | 1 env read |
| `src/deposit-watcher.js` | Modify | 1 env read |
| `src/proxy-handler.js` | Modify | 1 env read |
| `src/logger.js` | Modify | 2 env reads |
| `CLAUDE.md` | Modify | Add Configuration section |
| `.env.example` | Modify | Deprecation banner |
| `docs/config.toml.example` | Create | Reader-friendly sample |
| `README.md` | Modify | Update install instructions |

## Out-of-scope but related (track separately)

- Consolidating `~/.j41/dispatcher/config.json` (runtime state) into `config.toml` — would require migrating per-agent state and is a separate, larger refactor.
- Encrypting `config.toml` at rest with a passphrase — defer; mode 0600 + `~/.j41` parent is current standard.
- Migrating per-agent `agent-config.json` to TOML — defer; that file is already 0600, machine-edited, and JSON is fine for that.

## Rollback

If a regression ships:
- Operators can keep their old `.env` (it's preserved with a banner). Reverting one minor version restores the previous read path.
- The `config.toml` file is additive; deleting it returns the dispatcher to defaults.
