#!/usr/bin/env node
/**
 * J41 Dispatcher v2 — Ephemeral Job Containers
 *
 * Manages pool of pre-registered agents, spawns ephemeral containers per job.
 * Queue if at capacity. Default max concurrent from config.toml (0 = unlimited).
 */

// Defense-in-depth (2.1.11): force a strict umask for the entire process so
// any future fs.writeFileSync / mkdirSync that forgets an explicit mode still
// produces 0700 dirs and 0600 files. Operators on systems with looser umasks
// (e.g. Ubuntu's user-private-groups default 0002 → 0775/0664) would otherwise
// inherit world-readable agent identity files.
process.umask(0o077);

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getRuntime, persistActiveJobs, loadActiveJobs, saveConfig, loadConfig, persistReactivationQueue, loadReactivationQueue } = require('./config');
const rq = require('./reactivation-queue.js');
const {
  isDeadLettered,
  recordInboxFailure,
  clearInboxFailure,
  pruneInboxFailures,
  MAX_INBOX_ATTEMPTS,
  classifyInboxFailure,
  isFundingFailure,
  shouldDeferForPendingWrite,
  recordBatchFailure,
  clearBatchFailure,
} = require('./inbox-deadletter.js');
const { shouldAttemptAuth, recordAuthFailure, clearAuthFailure } = require('./auth-backoff.js');
const {
  summarizeUtxos,
  writesAffordable,
  planFeeSweep,
  executeFeeSweep,
  DEFAULT_FLOOR_WRITES,
  FEE_SATS,
  SWEEP_PENDING_BACKSTOP_MS,
} = require('./fee-tank.js');
// Operator-side counterpart of fee-tank.js, behind the `wallet` command. Every
// decision about whether money may move lives there or in fee-tank.js; this file
// only parses arguments, loads keys, prompts, renders and records.
const {
  parseVrscAmount,
  formatVrsc,
  resolveOwnRAddress,
  buildWalletRow,
  summarizeFleet,
  planManualSweep,
  planFleetSend,
  executeSend,
} = require('./wallet.js');

/**
 * Single prefix for every "this agent cannot pay fees" alert, shared by the
 * inbox batch handler and the fee-tank sweep.
 *
 * Load-bearing: the sweep retracts a stale alert by matching this prefix, and
 * nothing else clears _agentErrors except a successful activation. Two different
 * strings for the same condition means one of them never retracts, leaving a
 * critical alert on a money surface lit after the problem is fixed.
 */
const FEE_TANK_ERROR_PREFIX = 'FEE TANK EMPTY';
const log = require('./logger');
const { loadDispatcherConfig, fileConfiguredNetwork } = require('./config-loader.js');
const { SignChannelHost } = require('./sign-channel-host.js');
const { EgressProxyHost, deriveAllowedHosts, isolatedGatewayIp, EGRESS_PROXY_PORT } = require('./egress-proxy.js');
const { defaultExecutors, expiryForIdentity } = require('./broker-executors.js');
const { findMainnetSecurityViolations, resolveIsMainnet } = require('./mainnet-guard.js');
const { resolveLogRetention, shouldArchiveLog, applyLogCap, selectLogsToPrune, liveLogPath, archiveLogPath } = require('./job-log.js');
const { shouldRefundOrphan, isRefundAlreadyHandled, buildAbandonedJobRefund } = require('./refund.js');
const { isValidJobId } = require('./job-id.js');
const { verifyInboxJobRecord } = require('./inbox-job-record.js');
const { writeKeysFile, readKeysFile } = require('./keys-file.js');
const keystore = require('./keystore.js');
const { encryptAllKeys, decryptAllKeys, listPlaintextKeys } = require('./keys-migrate.js');
const { preflightAllowsAccept } = require('./preflight-gate.js');
const crypto = require('crypto');

/** Feature flag: route in-container signing through the host-side broker
 *  instead of mounting the WIF into the container. Default ON; opt out only
 *  with an explicit J41_SIGNING_BROKER=0 (testnet only — blocked on mainnet
 *  by the mainnet security gate). See
 *  src/sign-broker.js / src/sign-channel-host.js / src/job-signer.js. */
const SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER !== '0';
const cfg = loadDispatcherConfig();

const RUNTIME = getRuntime();

let Docker, docker;
if (RUNTIME === 'docker') {
  try {
    Docker = require('dockerode');
    docker = new Docker();
  } catch {
    // dockerode not available — will fail at runtime if docker commands are used
  }
}

// Security profile detection (from @junction41/secure-setup)
let secureSetup;
try {
  secureSetup = require('@junction41/secure-setup');
} catch {
  // @junction41/secure-setup not installed — security features will be skipped
}

const J41_DIR = path.join(os.homedir(), '.j41');
const DISPATCHER_DIR = path.join(J41_DIR, 'dispatcher');
const MASTER_KEY_PATH = path.join(DISPATCHER_DIR, 'master-key.json');
keystore.setMasterKeyPath(MASTER_KEY_PATH);
const AGENTS_DIR = path.join(DISPATCHER_DIR, 'agents');
const QUEUE_DIR = path.join(DISPATCHER_DIR, 'queue');
const JOBS_DIR = path.join(DISPATCHER_DIR, 'jobs');
const SEEN_JOBS_PATH = path.join(DISPATCHER_DIR, 'seen-jobs.json');
const PENDING_REFUNDS_PATH = path.join(DISPATCHER_DIR, 'pending-refunds.json');
const REFUNDED_JOBS_PATH = path.join(DISPATCHER_DIR, 'refunded-jobs.json');
const REFUND_LOCKS_DIR = path.join(DISPATCHER_DIR, 'refund-locks');
const FINALIZE_STATE_FILENAME = 'finalize-state.json';

const J41_API_URL = cfg.platform.api_url;
const J41_NETWORK = cfg.platform.network;
const IS_MAINNET = resolveIsMainnet(fileConfiguredNetwork(), J41_NETWORK);
const _cfg = loadConfig();
const { computeMaxAgents, capacityLine, resolveCapacity, DEFAULTS: SIZING_DEFAULTS } = require('./hardware-sizing.js');

// The cap auto-follows the hardware estimate unless the OWNER explicitly sets a
// positive max_concurrent in config.toml (source of truth) or J41_MAX_CONCURRENT.
// A stale legacy config.json `maxConcurrent` is deliberately NOT consulted here —
// it must not act as a phantom override the owner never chose.
const _autoMax = computeMaxAgents({ totalMemBytes: os.totalmem(), cpuCount: os.cpus().length });
const _cap = resolveCapacity({ configMax: cfg.runtime.max_concurrent, estimate: _autoMax });
const MAX_AGENTS = _cap.maxAgents;
const MAX_AGENTS_AUTO = _cap.auto;
const JOB_TIMEOUT_MS = (_cfg.jobTimeoutMin || 60) * 60 * 1000;
const MAX_RETRIES = 2;
const SEEN_JOBS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Job statuses that are permanently done — never re-run (H1: terminal-status check on retry).
const TERMINAL_STATUSES = ['delivered', 'completed', 'cancelled', 'resolved', 'resolved_rejected'];

// ── Financial Allowlist (Plan C) ──
const ALLOWLIST_PATH = path.join(os.homedir(), '.j41', 'financial-allowlist.json');

function loadFinancialAllowlist() {
  try {
    if (!fs.existsSync(ALLOWLIST_PATH)) {
      // Create deny-all default
      const dir = path.dirname(ALLOWLIST_PATH);
      fs.mkdirSync(dir, { recursive: true });
      const empty = { permanent: [], operator: [], active_jobs: [] };
      fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(empty, null, 2));
      return empty;
    }
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    console.error(`[allowlist] Failed to load ${ALLOWLIST_PATH}: ${err.message} — deny-all mode`);
    return { permanent: [], operator: [], active_jobs: [] };
  }
}

function isAddressInAllowlist(allowlist, address) {
  const all = [
    ...allowlist.permanent.map(e => e.address),
    ...allowlist.operator.map(e => e.address),
    ...allowlist.active_jobs.map(e => e.address),
  ];
  return all.includes(address);
}

function addActiveJobToAllowlist(jobId, buyerAddress) {
  try {
    const list = loadFinancialAllowlist();
    if (list.active_jobs.some(e => e.jobId === jobId)) return;
    list.active_jobs.push({
      address: buyerAddress,
      jobId,
      added: new Date().toISOString(),
    });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2));
    console.log(`[allowlist] Added buyer address ${buyerAddress} for job ${jobId}`);
  } catch (err) {
    console.error(`[allowlist] Failed to add job address: ${err.message}`);
  }
}

function removeActiveJobFromAllowlist(jobId) {
  try {
    const list = loadFinancialAllowlist();
    list.active_jobs = list.active_jobs.filter(e => e.jobId !== jobId);
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2));
    console.log(`[allowlist] Removed buyer address for job ${jobId}`);
  } catch (err) {
    console.error(`[allowlist] Failed to remove job address: ${err.message}`);
  }
}

function addToRefundAllowlist(address, jobId) {
  try {
    fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
    const list = loadFinancialAllowlist();
    if (!list.permanent.some(e => e.address === address)) {
      list.permanent.push({ address, jobId, added: new Date().toISOString(), via: 'refund-approve' });
    }
    const tmp = `${ALLOWLIST_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ALLOWLIST_PATH);
    console.log(`[refund] owner-approved allowlist add ${address} for job ${jobId}`);
  } catch (err) {
    console.error(`[allowlist] Failed to add refund address: ${err.message}`);
    throw err;
  }
}

// Dispatcher-side rate limiting (in-memory, resets on restart)
const dispatcherSendHistory = { global: [], perJob: new Map() };
const DISPATCHER_RATE_LIMITS = {
  maxSendsPerJob: 3,
  maxSendsPerHour: 10,
  cooldownMs: 30_000,
};
let dispatcherFinancialSuspended = false;

function checkDispatcherRateLimit(jobId, amount, jobPrice) {
  if (dispatcherFinancialSuspended) {
    return { allowed: false, reason: 'Financial operations suspended (API outage)' };
  }
  const now = Date.now();
  const jobHistory = dispatcherSendHistory.perJob.get(jobId) || [];

  if (jobHistory.length >= DISPATCHER_RATE_LIMITS.maxSendsPerJob) {
    return { allowed: false, reason: `Max sends per job (${DISPATCHER_RATE_LIMITS.maxSendsPerJob})` };
  }

  const maxValue = jobPrice * 1.1;
  const totalSent = jobHistory.reduce((s, r) => s + r.amount, 0);
  if (totalSent + amount > maxValue) {
    return { allowed: false, reason: 'Total value exceeds job price + 10%' };
  }

  const oneHourAgo = now - 3_600_000;
  const recentGlobal = dispatcherSendHistory.global.filter(r => r.timestamp > oneHourAgo);
  if (recentGlobal.length >= DISPATCHER_RATE_LIMITS.maxSendsPerHour) {
    return { allowed: false, reason: `Hourly global limit (${DISPATCHER_RATE_LIMITS.maxSendsPerHour})` };
  }

  if (jobHistory.length > 0) {
    const last = jobHistory[jobHistory.length - 1];
    if (now - last.timestamp < DISPATCHER_RATE_LIMITS.cooldownMs) {
      return { allowed: false, reason: 'Cooldown active' };
    }
  }

  return { allowed: true };
}

function recordDispatcherSend(jobId, amount) {
  const record = { timestamp: Date.now(), amount };
  if (!dispatcherSendHistory.perJob.has(jobId)) {
    dispatcherSendHistory.perJob.set(jobId, []);
  }
  dispatcherSendHistory.perJob.get(jobId).push(record);
  dispatcherSendHistory.global.push(record);

  // Prune entries older than 1 hour to prevent unbounded growth
  const oneHourAgo = Date.now() - 3_600_000;
  dispatcherSendHistory.global = dispatcherSendHistory.global.filter(r => r.timestamp > oneHourAgo);
}

// ── Dispatcher-side allowlist sweep timer ──
let dispatcherApiOutageSince = null;
const DISPATCHER_SWEEP_INTERVAL = 10 * 60 * 1000; // 10 minutes

function startDispatcherSweep(state) {
  const timer = setInterval(async () => {
    try {
      const list = loadFinancialAllowlist();
      if (list.active_jobs.length === 0) {
        if (dispatcherApiOutageSince) {
          dispatcherApiOutageSince = null;
          dispatcherFinancialSuspended = false;
        }
        return;
      }

      let apiReachable = false;

      for (const entry of [...list.active_jobs]) {
        // Find an authenticated agent session to check the API
        const agentInfo = state.agents?.[0];
        if (!agentInfo) continue;

        try {
          const session = await getAgentSession(state, agentInfo);
          const job = await session.client.getJob(entry.jobId);
          apiReachable = true;

          const activeStatuses = ['requested', 'accepted', 'in_progress', 'delivered', 'rework'];
          if (!activeStatuses.includes(job.status)) {
            removeActiveJobFromAllowlist(entry.jobId);
            dispatcherSendHistory.perJob.delete(entry.jobId);
            console.log(`[allowlist-sweep] Removed stale job ${entry.jobId} (${job.status})`);
          }
        } catch (err) {
          console.error(`[allowlist-sweep] API check failed for ${entry.jobId}: ${err.message}`);
        }
      }

      if (apiReachable) {
        if (dispatcherApiOutageSince) {
          console.log('[allowlist-sweep] API restored — resuming financial operations');
          dispatcherApiOutageSince = null;
          dispatcherFinancialSuspended = false;
        }
      } else {
        const now = Date.now();
        if (!dispatcherApiOutageSince) dispatcherApiOutageSince = now;
        if (now - dispatcherApiOutageSince >= 30 * 60 * 1000) {
          if (!dispatcherFinancialSuspended) {
            dispatcherFinancialSuspended = true;
            console.error('[allowlist-sweep] API outage >30min — ALL financial ops suspended');
          }
        }
      }
    } catch (err) {
      console.error(`[allowlist-sweep] Unhandled error: ${err.message}`);
    }
  }, DISPATCHER_SWEEP_INTERVAL);

  timer.unref();
  console.log(`[allowlist] Dispatcher sweep timer started (every ${DISPATCHER_SWEEP_INTERVAL / 60_000} min)`);
  return timer;
}

/**
 * Validate that a URL is safe to use as an executor endpoint.
 * Rejects non-https schemes and private/internal IP ranges.
 */
function validateExecutorUrl(url, varName) {
  if (!url) return; // Optional — skip if not set
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${varName}: invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'https:') {
    // Allow localhost/127.0.0.1 for development explicitly
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error(`${varName}: only HTTPS URLs are allowed (got "${parsed.protocol}")`);
    }
  }
  // Reject private IP ranges (SSRF protection)
  const PRIVATE_PATTERNS = [
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,   // link-local
    /^fc00::/i,               // IPv6 ULA
    /^fe80::/i,               // IPv6 link-local
    /^::1$/,                  // IPv6 loopback
    /^0\.0\.0\.0$/,           // unspecified / wildcard
  ];
  if (PRIVATE_PATTERNS.some(p => p.test(parsed.hostname))) {
    throw new Error(`${varName}: private/internal IP address rejected for "${url}" (SSRF protection)`);
  }
}

/**
 * Build the canonical J41-ACCEPT message for job acceptance signing.
 */
function buildAcceptMessage(job, timestamp) {
  return `J41-ACCEPT|Job:${job.jobHash}|Buyer:${job.buyerVerusId}|Amt:${job.amount} ${job.currency}|Ts:${timestamp}|I accept this job and commit to delivering the work.`;
}

const program = new Command();

function ensureDirs() {
  [J41_DIR, DISPATCHER_DIR, AGENTS_DIR, QUEUE_DIR, JOBS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  });
  // Ensure _live dir (host-only; never bind-mounted). Mode 0o700 — only dispatcher UID.
  try { fs.mkdirSync(path.join(JOBS_DIR, '_live'), { recursive: true, mode: 0o700 }); } catch {}
  // Best-effort sweep: remove stale _live/*.log whose job id is not in state.active.
  // state is not available in ensureDirs scope (called before start), so just ensure dir exists.
  // Actual stale-log cleanup happens at dispatcher start (see startup sweep below).
  // Defense-in-depth: re-lock any existing agent dirs / keys that older
  // dispatcher versions (or unrelated tools) may have created with looser
  // permissions. Cheap idempotent sweep — runs on every CLI invocation.
  try {
    if (fs.existsSync(AGENTS_DIR)) {
      for (const id of fs.readdirSync(AGENTS_DIR)) {
        const agentDir = path.join(AGENTS_DIR, id);
        try {
          const st = fs.statSync(agentDir);
          if (!st.isDirectory()) continue;
          if ((st.mode & 0o777) !== 0o700) fs.chmodSync(agentDir, 0o700);
          // Sensitive per-agent files: lock to 0600 if present
          for (const f of ['keys.json', 'agent-config.json', 'finalize-state.json', 'vdxf-update.json', 'vdxf-update.cmd']) {
            const p = path.join(agentDir, f);
            try {
              if (fs.existsSync(p) && (fs.statSync(p).mode & 0o777) !== 0o600) {
                fs.chmodSync(p, 0o600);
              }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
}

function loadAgentKeys(agentId) {
  // P2-4: Validate agentId format to prevent path traversal
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId) || agentId.includes('..')) {
    throw new Error(`Invalid agent ID format: ${agentId}`);
  }
  const keysPath = path.join(AGENTS_DIR, agentId, 'keys.json');
  if (!fs.existsSync(keysPath)) return null;
  return readKeysFile(keysPath);
}

// When the pool is encrypted (master-key.json exists), ensure the keystore is
// unlocked before we read or write agent keys — so a freshly generated WIF is
// stored encrypted (not silently plaintext) and an existing encrypted key is
// not downgraded. Interactive prompt if a TTY, else env/systemd-cred, else
// fail closed. No-op on a plaintext (default) install.
async function ensureKeystoreUnlockedIfEncrypted() {
  if (!fs.existsSync(MASTER_KEY_PATH) || keystore.isUnlocked()) return;
  try {
    const pass = await keystore.resolvePassphrase({ promptFn: () => keystore.promptHidden('🔐 Key pool is encrypted — unlock passphrase: ') });
    keystore.unlock(pass, MASTER_KEY_PATH);
  } catch (e) {
    console.error(`\n❌ The key pool is encrypted; unlock required for this operation: ${e.message}`);
    process.exit(1);
  }
}

function listRegisteredAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter(name => {
    const keysPath = path.join(AGENTS_DIR, name, 'keys.json');
    return fs.existsSync(keysPath);
  });
}

function loadFinalizeState(agentId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId) || agentId.includes('..')) {
    throw new Error(`Invalid agent ID format: ${agentId}`);
  }
  const p = path.join(AGENTS_DIR, agentId, FINALIZE_STATE_FILENAME);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // Same absent-vs-corrupt distinction as loadSeenJobs. null here reads as
    // "this agent was never finalized", which can send an operator back through
    // a registration flow that writes on-chain and costs money. If the file
    // exists but cannot be parsed, that is a fault, not a fresh agent.
    console.error(`[State] ⚠️  ${p} exists but is unreadable (${e.message}) — treating ${agentId} as NOT finalized.`);
    console.error('[State]    If it was previously finalized, inspect that file before re-running finalize.');
    return null;
  }
}

function isFinalizedReady(agentId) {
  const state = loadFinalizeState(agentId);
  return !!state && state.stage === 'ready';
}

function loadSeenJobs() {
  if (!fs.existsSync(SEEN_JOBS_PATH)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_JOBS_PATH, 'utf8'));
    // Migrate from old array format to timestamped map
    if (Array.isArray(data)) {
      const map = new Map();
      const now = Date.now();
      data.forEach(id => map.set(id, now));
      return map;
    }
    return new Map(Object.entries(data));
  } catch (e) {
    // A CORRUPT file is not the same as an ABSENT one, and conflating them is
    // dangerous: `state.seen` is what stops an already-handled job being picked
    // up again, so returning an empty Map here silently re-opens every job the
    // dispatcher has ever completed. Truncation is reachable — this file used to
    // be written non-atomically, so any crash mid-write produced exactly this.
    //
    // Absent → legitimately empty, stay quiet. Corrupt → say so, loudly, and
    // preserve the evidence rather than overwriting it on the next save.
    const quarantine = `${SEEN_JOBS_PATH}.corrupt.${Date.now()}`;
    try { fs.renameSync(SEEN_JOBS_PATH, quarantine); } catch { /* best effort */ }
    console.error(`[State] ⚠️  ${SEEN_JOBS_PATH} is unreadable (${e.message}).`);
    console.error(`[State]    Moved to ${quarantine}. Jobs completed before now may be re-processed`);
    console.error('[State]    once each — they are re-checked against the platform before any work starts.');
    return new Map();
  }
}

function saveSeenJobs(seen) {
  const obj = Object.fromEntries(seen);
  // Atomic: write to a temp file in the same directory, then rename. A crash
  // mid-write previously left a truncated file that loadSeenJobs read as "no
  // jobs seen". rename(2) is atomic, so a reader sees either the old file or
  // the complete new one, never a partial.
  const tmp = `${SEEN_JOBS_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SEEN_JOBS_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    console.error(`[State] Could not persist seen-jobs: ${e.message}`);
  }
}

/**
 * Prune seen-jobs entries older than SEEN_JOBS_TTL_MS (7 days).
 */
function pruneSeenJobs(seen) {
  const cutoff = Date.now() - SEEN_JOBS_TTL_MS;
  let pruned = 0;
  for (const [jobId, ts] of seen) {
    if (ts < cutoff) {
      seen.delete(jobId);
      pruned++;
    }
  }
  if (pruned > 0) {
    saveSeenJobs(seen);
    console.log(`[Prune] Removed ${pruned} expired seen-job entries`);
  }
}

/**
 * Parse a JSON array string, or return undefined on bad input.
 * Used for --profile-endpoints and --profile-capabilities.
 */
function parseJsonArray(val) {
  try {
    const parsed = JSON.parse(val);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (e) {
    console.error(`⚠️  Invalid JSON array: ${e.message}`);
    return undefined;
  }
}

/**
 * Build a full agent profile from CLI options, including session and platform keys.
 */
function buildFullProfile(options) {
  const profile = {
    name: options.profileName,
    type: options.profileType || 'autonomous',
    description: options.profileDescription,
    payAddress: options.payAddress,
    network: {
      capabilities: options.profileCapabilities || [],
      endpoints: options.profileEndpoints || [],
      protocols: options.profileProtocols || [],
    },
    profile: {
      category: options.profileCategory,
      tags: options.profileTags,
      website: options.profileWebsite,
      avatar: options.profileAvatar,
    },
    platformConfig: {
      datapolicy: options.dataPolicy,
      trustlevel: options.trustLevel,
      disputeresolution: options.disputeResolution,
    },
  };

  // Session limits
  const hasSession = options.sessionDuration != null || options.sessionTokenLimit != null ||
    options.sessionImageLimit != null || options.sessionMessageLimit != null ||
    options.sessionMaxFileSize != null || options.sessionAllowedFileTypes;
  if (hasSession) {
    profile.session = {};
    if (options.sessionDuration != null) profile.session.duration = options.sessionDuration;
    if (options.sessionTokenLimit != null) profile.session.tokenLimit = options.sessionTokenLimit;
    if (options.sessionImageLimit != null) profile.session.imageLimit = options.sessionImageLimit;
    if (options.sessionMessageLimit != null) profile.session.messageLimit = options.sessionMessageLimit;
    if (options.sessionMaxFileSize != null) profile.session.maxFileSize = options.sessionMaxFileSize;
    if (options.sessionAllowedFileTypes) profile.session.allowedFileTypes = options.sessionAllowedFileTypes;
  }

  // LLM models declaration
  if (options.models) {
    profile.models = Array.isArray(options.models) ? options.models : options.models.split(',').map(m => m.trim());
  }

  // Markup
  if (options.markup != null) {
    const m = parseInt(options.markup, 10);
    if (m >= 1 && m <= 50) profile.markup = m;
  }

  // Workspace capability
  if (options.workspace) {
    profile.workspaceCapability = {
      workspace: true,
      modes: options.workspaceModes
        ? options.workspaceModes.split(',').map(m => m.trim())
        : ['supervised', 'standard'],
      tools: options.workspaceTools
        ? options.workspaceTools.split(',').map(t => t.trim())
        : ['read_file', 'write_file', 'list_directory'],
    };
  }

  return profile;
}

// ── Interactive profile setup ──────────────────────────────────────

/**
 * Interactive walkthrough that prompts for every VDXF field.
 * Returns { profile, services } ready for buildAgentContentMultimap.
 */
async function interactiveProfileSetup(keys, soulContent) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) => new Promise(resolve => {
    const prompt = def != null ? `${q} [${def}]: ` : `${q}: `;
    rl.question(prompt, answer => resolve(answer.trim() || (def != null ? String(def) : '')));
  });
  const yesNo = async (q, def = 'Y') => {
    const a = (await ask(q, def)).toLowerCase();
    return a === 'y' || a === 'yes';
  };

  // Extract defaults from SOUL.md
  const soulName = (soulContent.match(/^#\s+(.+?)(?:\s*—.*)?$/m) || [])[1] || keys.identity;
  const soulDesc = (soulContent.match(/^(?!#)(?!\s*$)(.+)$/m) || [])[1] || '';

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Agent Profile Setup                             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('  Press Enter to accept defaults shown in [brackets].\n');

  // ── About your agent (3 questions) ──
  console.log('── About Your Agent ──');
  const name = await ask('  What should buyers see as the agent name?', soulName);
  const description = await ask('  Describe what this agent does (shown on marketplace)', soulDesc);
  const type = 'autonomous'; // 99% of agents are autonomous, don't ask

  // ── What does it do? ──
  console.log('\n── Skills & Category ──');

  // Fetch categories from platform and show as numbered list
  let category = 'general';
  try {
    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const tmpAgent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
    await tmpAgent.authenticate();
    const cats = await tmpAgent.client.getServiceCategories();
    tmpAgent.stop();
    const catList = Array.isArray(cats) ? cats : (cats?.data || []);
    if (catList.length > 0) {
      console.log('');
      for (let i = 0; i < catList.length; i++) {
        const c = catList[i];
        const subs = c.subs?.length > 0 ? ` (${c.subs.join(', ')})` : '';
        console.log(`  ${String(i + 1).padStart(2)}) ${c.icon || ''} ${c.name}${subs}`);
      }
      console.log('');
      const catPick = await ask('  Select category number (or type a custom name)', '1');
      const catIdx = parseInt(catPick, 10) - 1;
      if (catIdx >= 0 && catIdx < catList.length) {
        category = catList[catIdx].id;
        // If subcategories exist, ask
        if (catList[catIdx].subs?.length > 0) {
          console.log('');
          for (let j = 0; j < catList[catIdx].subs.length; j++) {
            console.log(`    ${String(j + 1).padStart(2)}) ${catList[catIdx].subs[j]}`);
          }
          const subPick = await ask('  Subcategory number (Enter to skip)', '');
          const subIdx = parseInt(subPick, 10) - 1;
          if (subIdx >= 0 && subIdx < catList[catIdx].subs.length) {
            const subSlug = catList[catIdx].subs[subIdx].toLowerCase().replace(/[^a-z0-9]/g, '-');
            category = `${catList[catIdx].id}:${subSlug}`;
          }
        }
      } else {
        category = catPick; // custom name
      }
    } else {
      category = await ask('  Category', 'general');
    }
  } catch {
    category = await ask('  Category (e.g. development, writing, data, design)', 'general');
  }
  console.log(`  → Category: ${category}`);

  const tagsRaw = await ask('  Keywords for search (comma-separated)', 'ai,' + category.split(':')[0]);
  const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  // ── Payment ──
  console.log('\n── Payment ──');
  const payAddress = await ask('  Where should you get paid? (your i-address or R-address)', keys.iAddress || keys.address);

  // ── LLM Model ──
  console.log('\n── AI Model ──');
  const modelsRaw = await ask('  Which LLM model does this agent use?', 'claude-sonnet-4-6');
  const models = modelsRaw ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  // ── How buyers reach your agent ──
  console.log('\n── Connection ──');
  const endpoint = await ask('  Agent endpoint URL (your VPS URL, or Enter for platform default)', `${cfg.platform.api_url}/v1`);
  const endpoints = endpoint ? [endpoint] : [`${cfg.platform.api_url}/v1`];
  const protosRaw = await ask('  Protocols your agent supports (MCP, REST, A2A, WebSocket)', 'MCP,REST');
  const protocols = protosRaw ? protosRaw.split(',').map(s => s.trim()).filter(Boolean) : ['MCP', 'REST'];

  // ── Service listing (the thing buyers actually see) ──
  console.log('\n── Marketplace Listing ──');
  console.log('  This is what buyers see when they browse services.\n');
  const services = [];
  let addService = await yesNo('  Create a service listing?', 'Y');
  while (addService) {
    const svcName = await ask('    Service name (e.g. "Code Review", "Write Blog Post")');
    if (!svcName) break;
    const svcDesc = await ask('    What does the buyer get?', description);
    const svcPrice = parseFloat(await ask('    Price in VRSCTEST', '0.5')) || 0.5;
    const svcTurnaround = await ask('    How long does it take? (e.g. "15 min", "1 hour")', '15 min');

    services.push({
      name: svcName,
      description: svcDesc || undefined,
      category: category || undefined,
      price: svcPrice,
      currency: 'VRSCTEST',
      turnaround: svcTurnaround,
      paymentTerms: 'prepay',
      sovguard: true,
      resolutionWindow: 72,
      refundPolicy: { policy: 'fixed', percent: 100 },
    });
    console.log(`    ✓ "${svcName}" — ${svcPrice} VRSCTEST\n`);

    addService = await yesNo('  Add another service?', 'N');
  }

  // ── Workspace (simple yes/no) ──
  console.log('\n── Workspace Access ──');
  console.log('  Workspace lets the agent read/write files in a buyer\'s local project.');
  const wsEnabled = await yesNo('  Enable workspace (file access)?', 'N');
  let workspaceCapability;
  if (wsEnabled) {
    workspaceCapability = {
      workspace: true,
      modes: ['supervised', 'standard'],
      tools: ['read_file', 'write_file', 'list_directory'],
    };
    console.log('  ✓ Workspace enabled (supervised + standard modes)');
  }

  // ── Advanced settings (hidden behind a toggle) ──
  let markup = 1;
  let duration = 7200;
  let tokenLimit = 200000;
  let messageLimit = 100;
  let maxFileSize = 10485760;
  let datapolicy = 'ephemeral';
  let trustlevel = 'verified';
  let disputeresolution = 'platform';
  let disputePolicy = {
    defaultAction: 'rework',
    maxRefundPercent: 100,
    maxReworkCycles: 2,
    reworkBudgetPercent: 50,
    escalateAfter: 'max_rework',
    systemCrashRefund: 100,
  };

  const wantAdvanced = await yesNo('\n  Configure advanced settings? (pricing markup, session limits, dispute policy)', 'N');
  if (wantAdvanced) {
    console.log('\n── Pricing ──');
    const markupRaw = await ask('  Markup on LLM costs (% above base cost, 1-50)', '1');
    markup = Math.max(1, Math.min(50, parseInt(markupRaw, 10) || 1));

    console.log('\n── Session Limits ──');
    const durationHours = parseFloat(await ask('  Max session duration (hours)', '2')) || 2;
    duration = Math.round(durationHours * 3600);
    tokenLimit = parseInt(await ask('  Max tokens per session', '200000'), 10) || 200000;
    messageLimit = parseInt(await ask('  Max messages per session', '100'), 10) || 100;
    const maxFileSizeGB = parseFloat(await ask('  Max file size (GB, e.g. 0.01 = 10MB)', '0.01')) || 0.01;
    maxFileSize = Math.round(maxFileSizeGB * 1073741824);

    console.log('\n── Dispute Policy ──');
    console.log('  What happens if a buyer disputes the work?\n');
    const defaultAction = await ask('  Default response (rework / refund / reject)', 'rework');
    const maxRefundPercent = parseInt(await ask('  Max refund (% of job cost, 0-100)', '100'), 10);
    const maxReworkCycles = parseInt(await ask('  How many rework attempts before escalation?', '2'), 10);

    disputePolicy = {
      defaultAction,
      maxRefundPercent: Math.min(Math.max(maxRefundPercent, 0), 100),
      maxReworkCycles: Math.max(maxReworkCycles, 0),
      reworkBudgetPercent: 50,
      escalateAfter: 'max_rework',
      systemCrashRefund: 100,
    };

    console.log('\n── Data & Trust ──');
    datapolicy = await ask('  Data handling (ephemeral = deleted after job, session = kept during job)', 'ephemeral');
    trustlevel = await ask('  Trust level (basic / verified / audited)', 'verified');
  }

  rl.close();

  // Auto-fill everything the user didn't need to think about
  const profile = {
    name,
    type,
    description,
    payAddress,
    network: {
      capabilities: tags.length > 0 ? tags : ['general'],
      endpoints,
      protocols,
    },
    profile: {
      category,
      tags,
    },
    models,
    markup,
    session: { duration, tokenLimit, messageLimit, maxFileSize },
    platformConfig: { datapolicy, trustlevel, disputeresolution },
    ...(workspaceCapability ? { workspaceCapability } : {}),
  };

  return { profile, services, disputePolicy };
}

/**
 * Build a service object from CLI options.
 * Shared by register, finalize, and setup commands.
 */
function buildServiceFromOptions(options, descriptionFallback) {
  if (!options.serviceName || !options.servicePrice) return [];
  const svc = {
    name: options.serviceName,
    description: options.serviceDescription || descriptionFallback || 'J41 agent service.',
    price: options.servicePrice,
    currency: options.serviceCurrency || 'VRSC',
    category: options.serviceCategory || 'general',
    turnaround: options.serviceTurnaround || '1h',
    paymentTerms: options.servicePaymentTerms || 'prepay',
    privateMode: options.servicePrivateMode === true || options.servicePrivateMode === 'true',
    sovguard: options.serviceSovguard !== false && options.serviceSovguard !== 'false', // default true
  };
  // Multi-currency: parse accepted currencies if provided
  if (options.serviceAcceptedCurrencies) {
    try {
      svc.acceptedCurrencies = typeof options.serviceAcceptedCurrencies === 'string'
        ? JSON.parse(options.serviceAcceptedCurrencies)
        : options.serviceAcceptedCurrencies;
    } catch (e) {
      console.warn(`⚠️  Invalid --service-accepted-currencies JSON: ${e.message}`);
    }
  }
  // Default: single currency from price/currency
  if (!svc.acceptedCurrencies) {
    svc.acceptedCurrencies = [{ currency: svc.currency, price: parseFloat(svc.price) || 0 }];
  }
  // Dispute resolution fields
  svc.resolutionWindow = parseInt(options.resolutionWindow, 10) || 60;
  if (options.refundPolicy) {
    try {
      svc.refundPolicy = typeof options.refundPolicy === 'string'
        ? JSON.parse(options.refundPolicy)
        : options.refundPolicy;
    } catch (e) {
      console.warn(`⚠️  Invalid --refund-policy JSON: ${e.message}`);
    }
  }
  // Service lifecycle fields
  const idleTimeout = parseInt(options.idleTimeout, 10);
  if (idleTimeout >= 5 && idleTimeout <= 2880) svc.idleTimeout = idleTimeout;
  const pauseTtl = parseInt(options.pauseTtl, 10);
  if (pauseTtl >= 15 && pauseTtl <= 10080) svc.pauseTTL = pauseTtl;
  const reactivationFee = parseFloat(options.reactivationFee);
  if (reactivationFee >= 0 && reactivationFee <= 1000) svc.reactivationFee = reactivationFee;
  return [svc];
}

/**
 * Add service CLI options to a command.
 */
function addServiceOptions(cmd) {
  return cmd
    .option('--service-name <name>', 'Service name for marketplace')
    .option('--service-description <desc>', 'Service description')
    .option('--service-price <price>', 'Service price')
    .option('--service-currency <currency>', 'Service currency', 'VRSC')
    .option('--service-category <cat>', 'Service category')
    .option('--service-turnaround <time>', 'Service turnaround time', '1h')
    .option('--service-payment-terms <terms>', 'Payment terms (prepay|postpay|split)', 'prepay')
    .option('--service-private-mode', 'Enable private mode for this service')
    .option('--service-sovguard', 'Require SovGuard protection (default: true)')
    .option('--service-accepted-currencies <json>', 'Accepted currencies as JSON array: [{"currency":"VRSC","price":10}]')
    .option('--resolution-window <minutes>', 'Resolution window in minutes (default: 60)', '60')
    .option('--refund-policy <json>', 'Refund policy JSON: {"policy":"fixed","percent":50}')
    .option('--idle-timeout <minutes>', 'Minutes before auto-idle (5-2880, default: 10)', '10')
    .option('--pause-ttl <minutes>', 'Minutes paused before auto-cancel (15-10080, default: 60)', '60')
    .option('--reactivation-fee <amount>', 'Cost to wake idle agent (0-1000, default: 0)', '0');
}

/**
 * Interactive walkthrough — prompts for all profile and service fields.
 * Used by setup --interactive.
 */
async function interactiveOnboarding(identityName) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) => new Promise(resolve => {
    const prompt = def != null ? `  ${q} [${def}]: ` : `  ${q}: `;
    rl.question(prompt, answer => resolve(answer.trim() || (def != null ? String(def) : '')));
  });

  console.log('\n── Agent Profile ──\n');
  const profileName = await ask('Display name', identityName);
  const profileType = await ask('Type (autonomous|assisted|hybrid|tool)', 'autonomous');
  const profileDescription = await ask('Description');
  const profileCategory = await ask('Categories (comma-separated, max 3: development,research,ai-assistant)', 'ai-assistant');
  const profileTags = await ask('Tags (comma-separated)', 'dispatcher,worker');
  const profileProtocols = await ask('Protocols (MCP,REST,A2A,WebSocket)', 'MCP');
  const profileWebsite = await ask('Website URL (optional)', '');
  const profileAvatar = await ask('Avatar URL (optional)', '');

  console.log('\n── Session Limits ──\n');
  const sessionDuration = await ask('Max session duration (minutes)', '60');
  const sessionTokenLimit = await ask('Max tokens per session', '100000');
  const sessionMessageLimit = await ask('Max messages per session', '50');
  const sessionImageLimit = await ask('Max images per session (optional)', '');
  const sessionMaxFileSize = await ask('Max file size in bytes (optional)', '');

  console.log('\n── Platform Policies ──\n');
  const dataPolicy = await ask('Data policy (ephemeral|retained|encrypted)', 'ephemeral');
  const trustLevel = await ask('Trust level (basic|verified|audited)', 'basic');
  const disputeResolution = await ask('Dispute resolution (platform|arbitration|mutual)', 'platform');

  console.log('\n── Service Listing ──\n');
  const serviceName = await ask('Service name');
  const serviceDescription = await ask('Service description', profileDescription);
  const servicePrice = await ask('Primary price', '0.5');
  const serviceCurrency = await ask('Primary currency', 'VRSC');
  const serviceCategory = await ask('Service category', 'development');
  const serviceTurnaround = await ask('Turnaround time', '5 minutes');
  const servicePaymentTerms = await ask('Payment terms (prepay|postpay|split)', 'prepay');
  const servicePrivateMode = await ask('Private mode? (y/N)', 'N');
  const serviceSovguard = await ask('Require SovGuard? (Y/n)', 'Y');

  // Multi-currency pricing
  const addMoreCurrencies = await ask('Accept additional currencies? (y/N)', 'N');
  const serviceAcceptedCurrencies = [{ currency: serviceCurrency, price: parseFloat(servicePrice) || 0 }];
  if (addMoreCurrencies.toLowerCase() === 'y') {
    let addMore = true;
    while (addMore && serviceAcceptedCurrencies.length < 20) {
      const cur = await ask('  Currency (e.g. tBTC.vETH, vETH)');
      if (!cur) break;
      const price = await ask(`  Price in ${cur}`);
      if (!price) break;
      serviceAcceptedCurrencies.push({ currency: cur, price: parseFloat(price) || 0 });
      const more = await ask('  Add another? (y/N)', 'N');
      addMore = more.toLowerCase() === 'y';
    }
  }

  rl.close();

  return {
    profileName,
    profileType,
    profileDescription,
    profileCategory,
    profileTags: profileTags.split(',').map(t => t.trim()).filter(Boolean),
    profileProtocols: profileProtocols.split(',').map(p => p.trim()).filter(Boolean),
    profileWebsite: profileWebsite || undefined,
    profileAvatar: profileAvatar || undefined,
    sessionDuration: sessionDuration ? parseInt(sessionDuration) * 60 : undefined, // minutes → seconds
    sessionTokenLimit: sessionTokenLimit ? parseInt(sessionTokenLimit) : undefined,
    sessionMessageLimit: sessionMessageLimit ? parseInt(sessionMessageLimit) : undefined,
    sessionImageLimit: sessionImageLimit ? parseInt(sessionImageLimit) : undefined,
    sessionMaxFileSize: sessionMaxFileSize ? parseInt(sessionMaxFileSize) : undefined,
    dataPolicy,
    trustLevel,
    disputeResolution,
    serviceName,
    serviceDescription,
    servicePrice,
    serviceCurrency,
    serviceCategory,
    serviceTurnaround,
    servicePaymentTerms,
    servicePrivateMode: servicePrivateMode.toLowerCase() === 'y' || servicePrivateMode.toLowerCase() === 'yes',
    serviceSovguard: serviceSovguard.toLowerCase() !== 'n' && serviceSovguard.toLowerCase() !== 'no',
    serviceAcceptedCurrencies,
  };
}

function createFinalizeHooks(agentId, identityName, profile, services = [], disputePolicy) {
  const agentDir = path.join(AGENTS_DIR, agentId);
  const keys = loadAgentKeys(agentId) || {};
  const primaryaddresses = Array.isArray(keys.primaryaddresses)
    ? keys.primaryaddresses
    : (keys.address ? [keys.address] : []);
  const planPath = path.join(agentDir, 'vdxf-update.json');
  const cmdPath = path.join(agentDir, 'vdxf-update.cmd');

  return {
    publishVdxf: async () => {
      const {
        J41Agent,
        VDXF_KEYS,
        buildAgentContentMultimap,
        buildCanonicalAgentUpdate,
        buildUpdateIdentityCommand,
        getCanonicalVdxfDefinitionCount,
      } = require('@junction41/sovagent-sdk/dist/index.js');
      const { buildIdentityUpdateTx } = require('@junction41/sovagent-sdk/dist/identity/update.js');

      const fields = profile
        ? {
            displayName: profile.name,
            type: profile.type,
            description: profile.description,
            status: 'active',
            services: JSON.stringify(services.map((svc) => ({
              name: svc.name,
              description: svc.description,
              category: svc.category,
              pricing: [{ currency: svc.currency, amount: String(svc.price) }],
              turnaround: svc.turnaround,
              status: 'active',
              resolutionWindow: svc.resolutionWindow,
              refundPolicy: svc.refundPolicy,
            }))),
            networkCapabilities: JSON.stringify(profile.network?.capabilities || []),
            networkEndpoints: JSON.stringify(profile.network?.endpoints || []),
            networkProtocols: JSON.stringify(profile.network?.protocols || []),
            profileTags: JSON.stringify(profile.profile?.tags || []),
            profileWebsite: profile.profile?.website || '',
            profileAvatar: profile.profile?.avatar || '',
            profileCategory: profile.profile?.category || '',
          }
        : { services: '[]' };

      const payload = buildCanonicalAgentUpdate({
        fullName: identityName,
        parent: 'agentplatform',
        primaryaddresses,
        minimumsignatures: keys.minimumsignatures || 1,
        vdxfKeys: VDXF_KEYS.agent,
        fields,
      });

      // Save plan for reference
      fs.writeFileSync(planPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        identity: identityName,
        canonicalDefinitionCount: getCanonicalVdxfDefinitionCount(),
        payload,
      }, null, 2));

      // Also save the verus CLI command for manual fallback
      const commandArgs = buildUpdateIdentityCommand(payload, J41_NETWORK);
      const commandStr = commandArgs.map(a => a.includes(' ') || a.includes('{') ? `'${a}'` : a).join(' ');
      fs.writeFileSync(cmdPath, `${commandStr}\n`);
      fs.chmodSync(cmdPath, 0o700);

      // Offline signing: authenticate, get identity data + UTXOs, build tx, broadcast
      console.log(`   ↳ Building offline identity update for ${identityName}...`);

      const agent = new J41Agent({
        apiUrl: J41_API_URL,
        wif: keys.wif,
        identityName: identityName,
        iAddress: keys.iAddress,
      });
      await agent.authenticate();

      // Build VDXF contentmultimap from profile
      const vdxfAdditions = buildAgentContentMultimap(profile, services, disputePolicy);

      // Get current identity data and UTXOs from platform
      const identityRawResp = await agent.client.getIdentityRaw();
      const identityData = identityRawResp.data || identityRawResp;
      const utxoResp = await agent.client.getUtxos();
      const utxos = utxoResp.utxos || utxoResp;
      console.log(`   ↳ Identity data retrieved, ${utxos.length} UTXO(s) available`);

      if (!utxos.length) {
        // F1 — this used to `return`, and the SDK cannot distinguish that from a
        // completed publish: it marked `vdxf_published` and walked the agent to
        // `ready`, so `setup` printed "Setup Complete" over an EMPTY on-chain
        // identity. Unconditional for every first agent, because a fresh identity has
        // no UTXOs. Worse, the documented recovery is a no-op — `finalize` never
        // clears state, so the `ready` marker makes a rerun return instantly.
        // Throwing is what stops the state machine advancing on a step that did not
        // happen.
        console.log('   ⚠️  No UTXOs available — identity needs funds for tx fee');
        console.log(`   ↳ Send at least 0.0001 VRSCTEST to ${keys.address}`);
        console.log(`   ↳ VDXF plan saved to: ${planPath}`);
        console.log('   ↳ Then re-run this step; nothing was published on-chain.');
        throw new Error(
          `VDXF publish skipped: ${keys.address} has no spendable UTXOs for the transaction fee. ` +
          'Fund it with at least 0.0001 and run setup again. ' +
          'Nothing was published in THIS run — any previously published data is unchanged.',
        );
      }

      const _ci = await agent.client.getChainInfo();
      // Build and sign the transaction offline
      const rawhex = buildIdentityUpdateTx({
        wif: keys.wif,
        identityData,
        utxos,
        vdxfAdditions,
        network: J41_NETWORK,
        expiryHeight: expiryForIdentity(_ci.blockHeight),
      });
      console.log(`   ↳ Transaction signed (${rawhex.length / 2} bytes)`);

      // Broadcast via platform API
      const txResult = await agent.client.broadcast(rawhex);
      console.log(`   ✅ Identity updated on-chain: ${txResult.txid || txResult}`);
      // Trigger backend to re-index immediately
      try {
        await agent.client.refreshAgent(keys.iAddress || identityName);
        console.log('   ✅ Backend refreshed — marketplace updated');
      } catch (e) {
        console.log(`   ⚠️  Backend refresh failed: ${e.message.slice(0, 60)}`);
      }
    },
    verifyVdxf: async () => {
      console.log('   ↳ Verification deferred to index stage');
    },
    waitForIndexed: async () => {
      console.log('   ↳ Index visibility check deferred (implement API/RPC verification hook next)');
    },
  };
}

function getActiveJobs() {
  if (RUNTIME === 'local') {
    const jobs = loadActiveJobs();
    return Promise.resolve(
      Object.entries(jobs)
        .filter(([_, info]) => {
          if (!info.pid) return false;
          try { process.kill(info.pid, 0); return true; } catch { return false; }
        })
        .map(([jobId, info]) => ({
          Names: [`/j41-job-${jobId}`],
          Status: `Running (PID ${info.pid}, ${Math.round((Date.now() - info.startedAt) / 60000)}m)`,
        }))
    );
  }
  // Docker mode
  if (!docker) {
    console.error('❌ Docker runtime selected but Docker is not available.');
    console.error('   Install Docker or switch to local mode: j41-dispatcher config --runtime local');
    return Promise.resolve([]);
  }
  return docker.listContainers().then(containers => {
    return containers.filter(c =>
      c.Names.some(n => n.startsWith('/j41-job-'))
    );
  }).catch(e => {
    console.error(`❌ Docker error: ${e.message}`);
    console.error('   Install Docker or switch to local mode: j41-dispatcher config --runtime local');
    return [];
  });
}

program
  .name('j41-dispatcher')
  .description('Ephemeral job container orchestrator for J41')
  .version(require('../package.json').version);

// Config command — view/change runtime settings
program
  .command('config')
  .description('View or change dispatcher configuration')
  .option('--runtime <mode>', 'Set runtime mode: docker or local')
  .option('--max-concurrent <n>', 'Max concurrent jobs (agent slots)')
  .option('--job-timeout <min>', 'Job timeout in minutes')
  .option('--extension-auto-approve <bool>', 'Auto-approve extensions (true/false)')
  .option('--extension-max-cpu <percent>', 'Max CPU load % before rejecting extensions (0-100)')
  .option('--extension-min-free-mb <mb>', 'Min free RAM (MB) before rejecting extensions')
  .option('--show', 'Show current configuration')
  .action(async (options) => {
    ensureDirs();
    const config = loadConfig();
    let changed = false;

    if (options.runtime) {
      if (!['docker', 'local'].includes(options.runtime)) {
        console.error('❌ Invalid runtime mode. Use: docker or local');
        process.exit(1);
      }
      config.runtime = options.runtime;
      changed = true;
    }

    if (options.maxConcurrent !== undefined) {
      const n = parseInt(options.maxConcurrent);
      // 0 is the AUTO sentinel (resolveCapacity falls back to the hardware estimate).
      // `if (options.maxConcurrent)` treated it as absent, so once an operator set a
      // value there was no way back to auto — and the command said nothing.
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        console.error('❌ --max-concurrent must be 0 (auto) or 1-1000');
        process.exit(1);
      }
      // L8 — this wrote `maxConcurrent` into the legacy config.json, but `start`
      // resolves capacity from `config.toml`'s runtime.max_concurrent and the comment
      // there says the legacy key is "deliberately NOT consulted". So the command
      // printed success and changed nothing. Write where the value is actually read.
      config.maxConcurrent = n; // legacy mirror, harmless
      try {
        const { saveDispatcherConfig } = require('./config-loader.js');
        saveDispatcherConfig({ runtime: { max_concurrent: n } });
      } catch (e) {
        console.error(`❌ Could not write max_concurrent to config.toml: ${e.message}`);
        process.exit(1);
      }
      changed = true;
    }

    if (options.jobTimeout) {
      const m = parseInt(options.jobTimeout);
      if (m < 1 || m > 1440) {
        console.error('❌ --job-timeout must be 1-1440 minutes');
        process.exit(1);
      }
      config.jobTimeoutMin = m;
      changed = true;
    }

    if (options.extensionAutoApprove !== undefined) {
      config.extensionAutoApprove = options.extensionAutoApprove === 'true';
      changed = true;
    }

    if (options.extensionMaxCpu) {
      const pct = parseInt(options.extensionMaxCpu);
      if (pct < 10 || pct > 100) {
        console.error('❌ --extension-max-cpu must be 10-100');
        process.exit(1);
      }
      config.extensionMaxCpuPercent = pct;
      changed = true;
    }

    if (options.extensionMinFreeMb) {
      const mb = parseInt(options.extensionMinFreeMb);
      if (mb < 64 || mb > 65536) {
        console.error('❌ --extension-min-free-mb must be 64-65536');
        process.exit(1);
      }
      config.extensionMinFreeMB = mb;
      changed = true;
    }

    if (changed) {
      saveConfig(config);
      console.log('✅ Configuration updated');
    }

    // Show config
    const os = require('os');
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Dispatcher Configuration             ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`  Runtime:          ${config.runtime}`);
    console.log(`  Max concurrent:   ${config.maxConcurrent || 'unlimited'}`);
    console.log(`  Job timeout:      ${config.jobTimeoutMin || 60} min`);
    console.log(`  Config file:      ${require('./config').CONFIG_PATH}`);
    console.log('');
    console.log('  Extension auto-approve:');
    console.log(`    Enabled:        ${config.extensionAutoApprove !== false}`);
    console.log(`    Max CPU load:   ${config.extensionMaxCpuPercent || 80}%`);
    console.log(`    Min free RAM:   ${config.extensionMinFreeMB || 512} MB`);
    console.log('');
    console.log('  System:');
    console.log(`    CPUs:           ${os.cpus().length}`);
    console.log(`    Total RAM:      ${Math.round(os.totalmem() / 1024 / 1024)} MB`);
    console.log(`    Free RAM:       ${Math.round(os.freemem() / 1024 / 1024)} MB`);
    console.log(`    Load avg:       ${os.loadavg().map(l => l.toFixed(2)).join(', ')}`);
    console.log('');
  });

// Init command — create N agent identities
program
  .command('quickstart')
  .description('Guided first-run setup — creates agent, picks template, configures LLM')
  .action(async () => {
    ensureDirs();
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q, def) => new Promise(resolve => {
      const prompt = def != null ? `${q} [${def}]: ` : `${q}: `;
      rl.question(prompt, answer => resolve(answer.trim() || (def != null ? String(def) : '')));
    });

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     J41 Dispatcher — Quick Start         ║');
    console.log('╚══════════════════════════════════════════╝\n');

    // 1. Identity name
    const name = await ask('Choose a name for your agent (lowercase, no spaces)', '');
    if (!name) { console.error('❌ Name required'); rl.close(); process.exit(1); }

    // 2. Template
    const tplDir = path.join(__dirname, '..', 'templates');
    const templates = fs.readdirSync(tplDir).filter(d => fs.existsSync(path.join(tplDir, d, 'config.json')));
    console.log(`\nAvailable templates: ${templates.join(', ')}`);
    const template = await ask('Choose a template', 'general-assistant');

    // 3. LLM provider
    // F3 — "claude" is not a preset. The real ones are claude-opus / claude-sonnet /
    // claude-haiku (they route via OpenRouter, because Anthropic's native API uses
    // /messages rather than /chat/completions). Offering a name that does not resolve
    // sent the operator straight to a fleet that declines every job.
    console.log('\nPopular LLM providers: openai, claude-sonnet, groq, deepseek, ollama');
    const { LLM_PRESETS: _PRESETS } = require('./executors/local-llm.js');
    let provider = await ask('LLM provider', 'openai');
    while (provider && !_PRESETS[provider]) {
      console.log(`  ✗ "${provider}" is not a known provider. Valid: ${Object.keys(_PRESETS).join(', ')}`);
      provider = await ask('LLM provider', 'openai');
    }

    // 4. API key
    let apiKey = '';
    if (provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
      apiKey = await ask(`API key for ${provider}`, '');
      if (!apiKey) console.log('  (You can set it later via environment variable)');
    }

    // 5. Runtime
    const runtime = await ask('Runtime mode (docker or local)', 'docker');

    rl.close();

    console.log('\n─── Configuration ───');
    console.log(`  Agent:    ${name}.agentplatform@`);
    console.log(`  Template: ${template}`);
    console.log(`  LLM:      ${provider}`);
    console.log(`  Runtime:  ${runtime}`);
    console.log('');

    // Save config
    const config = loadConfig();
    config.runtime = runtime;
    saveConfig(config);

    // F3 — the key used to be collected and then DISCARDED, with the operator told to
    // `export OPENAI_API_KEY=…`. buildContainerEnv never reads that: provider keys come
    // from config.toml's [provider_keys] (cli.js:7952), deliberately never from the
    // dispatcher's own environment. Following the printed instructions exactly produced
    // a fleet that declined every job. Persist it where the dispatcher actually looks.
    try {
      const { saveDispatcherConfig } = require('./config-loader.js');
      const partial = { llm: { provider } };
      if (apiKey) partial.provider_keys = { [provider]: apiKey };
      saveDispatcherConfig(partial);
      console.log(`\n  ✅ Saved provider${apiKey ? ' + API key' : ''} to ~/.j41/dispatcher/config.toml`);
    } catch (e) {
      console.log(`\n  ⚠️  Could not write config.toml (${e.message}).`);
      console.log(`     Set it by hand: [provider_keys] ${provider} = "<your key>"`);
    }

    console.log('\nNext steps:\n');
    console.log(`  1. Set up your agent:`);
    console.log(`     j41-dispatcher setup agent-1 ${name} --template ${template}`);
    console.log(`\n  2. Start the dispatcher:`);
    console.log(`     j41-dispatcher start`);
    console.log('');
  });

// Init command — create N agent identities
program
  .command('init')
  .description('Initialize dispatcher with N agent identities')
  .option('-n, --agents <number>', 'Number of agents to create', '9')
  .option('--soul <file>', 'SOUL.md template to use for all agents')
  .action(async (options) => {
    // K2 — `init` writes a WIF per agent, so it must respect an encrypted key pool.
    // Without this it wrote every new agent's key in PLAINTEXT onto a pool the
    // operator had deliberately encrypted, silently downgrading custody. This is a
    // gap rather than a decision: test/cli-encryption-guard.test.js names its
    // deliberate exclusions (`start`, `privacy`), and the sibling `setup` calls the
    // guard immediately before the identical write.
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();
    const count = parseInt(options.agents);
    
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     J41 Dispatcher Init                  ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    // Load or generate soul template
    let soulTemplate = '# Generic J41 Agent\n\nA helpful AI assistant.';
    if (options.soul && fs.existsSync(options.soul)) {
      soulTemplate = fs.readFileSync(options.soul, 'utf8');
      console.log(`✓ Loaded SOUL template from ${options.soul}`);
    }
    
    // Generate agent identities
    console.log(`\n→ Creating ${count} agent identities...\n`);
    
    for (let i = 1; i <= count; i++) {
      const agentId = `agent-${i}`;
      const agentDir = path.join(AGENTS_DIR, agentId);
      
      if (fs.existsSync(agentDir)) {
        console.log(`  ${agentId}: already exists ✓`);
        continue;
      }
      
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      
      // Generate keypair using standalone keygen (no SDK build needed)
      console.log(`  ${agentId}: generating keys...`);
      
      const { generateKeypair } = require('./keygen.js');
      const keys = generateKeypair(J41_NETWORK);
      
      writeKeysFile(path.join(agentDir, 'keys.json'), { ...keys, network: J41_NETWORK });
      
      // Write SOUL template
      fs.writeFileSync(
        path.join(agentDir, 'SOUL.md'),
        soulTemplate.replace(/AGENT_NAME/g, agentId)
      );
      
      console.log(`  ${agentId}: created (${keys.address})`);
    }
    
    console.log(`\n✅ ${count} agents initialized`);
    console.log('\nNext steps:');
    console.log('  1. Fund the agent addresses (they need VRSC for registration)');
    console.log('  2. Register each: j41-dispatcher register agent-1 <name>');
    console.log('  3. Finalize each: j41-dispatcher finalize agent-1');
    console.log('  4. Start dispatcher: j41-dispatcher start');
  });

// Register command — register an agent identity on-chain
program
  .command('register <agent-id> <identity-name>')
  .description('Register an agent identity on J41 platform')
  .option('--finalize', 'Run onboarding finalization after identity registration')
  .option('--interactive', 'Interactive finalize mode (prompts for profile/service)')
  .option('--profile-name <name>', 'Profile display name for headless finalize')
  .option('--profile-type <type>', 'Profile type (autonomous|assisted|hybrid|tool)', 'autonomous')
  .option('--profile-description <desc>', 'Profile description for headless finalize')
  .option('--pay-address <address>', 'Payment address (i-address or R-address)')
  .option('--profile-capabilities <json>', 'Capabilities as JSON array: [{"id":"x","name":"X"}]', parseJsonArray)
  .option('--profile-endpoints <json>', 'Endpoints as JSON array: [{"url":"https://...","protocol":"MCP"}]', parseJsonArray)
  .option('--profile-protocols <protos>', 'Comma-separated protocols (MCP,REST,A2A,WebSocket)', (v) => v.split(','))
  .option('--service-name <name>', 'Service name for marketplace listing')
  .option('--service-description <desc>', 'Service description')
  .option('--service-price <price>', 'Service price')
  .option('--service-currency <currency>', 'Service currency', 'VRSC')
  .option('--service-category <cat>', 'Service category')
  .option('--service-turnaround <time>', 'Service turnaround time', '1h')
  .option('--service-payment-terms <terms>', 'Payment terms (prepay|postpay)', 'prepay')
  .option('--service-private-mode', 'Enable private mode for this service')
  .option('--service-sovguard', 'Require SovGuard protection (default: true)')
  .option('--profile-tags <tags>', 'Comma-separated tags', (v) => v.split(','))
  .option('--profile-website <url>', 'Agent website URL')
  .option('--profile-avatar <url>', 'Agent avatar URL')
  .option('--models <models>', 'Comma-separated LLM model names (e.g. "kimi-k2.5,claude-sonnet-4.6")')
  .option('--profile-category <cat>', 'Agent category')
  .option('--session-duration <min>', 'Max session duration in minutes', parseInt)
  .option('--session-token-limit <n>', 'Max tokens per session', parseInt)
  .option('--session-image-limit <n>', 'Max images per session', parseInt)
  .option('--session-message-limit <n>', 'Max messages per session', parseInt)
  .option('--session-max-file-size <bytes>', 'Max file size in bytes', parseInt)
  .option('--session-allowed-file-types <types>', 'Comma-separated MIME types', (v) => v.split(','))
  .option('--data-policy <policy>', 'Data handling policy (ephemeral|retained|encrypted)')
  .option('--trust-level <level>', 'Trust level (basic|verified|audited)')
  .option('--dispute-resolution <method>', 'Dispute resolution method')
  .action(async (agentId, identityName, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found. Run: j41-dispatcher init`);
      process.exit(1);
    }

    // Check if any other local agent already has this name (prevent duplicates)
    const fullName = identityName.includes('@') ? identityName : identityName + '.agentplatform@';
    const allAgents = listRegisteredAgents();
    for (const other of allAgents) {
      if (other === agentId) continue;
      const otherKeys = loadAgentKeys(other);
      if (!otherKeys) continue;
      const otherName = otherKeys.identity || otherKeys.pendingName;
      if (otherName && (otherName === fullName || otherName === identityName || otherName.replace('.agentplatform@', '') === identityName)) {
        const status = otherKeys.registrationStatus || (otherKeys.iAddress ? 'registered' : 'pending');
        console.error(`❌ Name "${identityName}" is already ${status} on ${other}.`);
        if (status === 'timeout') {
          console.error(`   Run: j41-dispatcher recover ${other}`);
        } else if (otherKeys.iAddress) {
          console.error(`   ${other} already owns this identity.`);
        }
        console.error(`   Pick a different name, or clear ${other}'s state first.`);
        process.exit(1);
      }
    }

    console.log(`\n→ Registering ${agentId} as ${identityName}.agentplatform@...`);
    console.log(`   Address: ${keys.address}`);

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif
    });

    try {
      const result = await agent.register(identityName, J41_NETWORK);

      // Save identity to keys file
      keys.identity = result.identity;
      keys.iAddress = result.iAddress;
      writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);

      console.log(`\n✅ ${agentId} identity registered on-chain!`);
      console.log(`   Identity: ${result.identity}`);
      console.log(`   i-Address: ${result.iAddress}`);

      // Build agent profile — interactive walkthrough or flags
      const soulPath = path.join(AGENTS_DIR, agentId, 'SOUL.md');
      const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '';

      let profileData;
      let serviceData = [];
      let disputePolicyData;

      if (options.profileName) {
        // Headless mode — use CLI flags
        profileData = buildFullProfile(options);
        serviceData = buildServiceFromOptions(options, profileData.description);
      } else {
        // Interactive walkthrough — prompt for every VDXF field
        const result = await interactiveProfileSetup(keys, soul);
        profileData = result.profile;
        serviceData = result.services;
        disputePolicyData = result.disputePolicy;
      }

      console.log(`\n→ Registering agent profile on J41 platform...`);
      try {
        // Re-create agent with identity info for platform registration
        const profileAgent = new J41Agent({
          apiUrl: J41_API_URL,
          wif: keys.wif,
          identityName: keys.identity,
          iAddress: keys.iAddress,
        });
        const regResult = await profileAgent.registerWithJ41(profileData);
        console.log(`✅ Agent profile registered! (agentId: ${regResult.agentId})`);

        // Register services
        if (serviceData.length > 0) {
          for (const svc of serviceData) {
            try {
              await profileAgent.registerService(svc);
              console.log(`✅ Service registered: ${svc.name}`);
            } catch (svcErr) {
              console.error(`⚠️  Service "${svc.name}" registration failed: ${svcErr.message}`);
            }
          }
        }
      } catch (profileErr) {
        console.error(`⚠️  Profile registration failed: ${profileErr.message}`);
        console.error(`   You can retry later with: j41-dispatcher finalize ${agentId}`);
      }

      if (options.finalize) {
        const { finalizeOnboarding } = require('@junction41/sovagent-sdk/dist/index.js');
        const finalizeStatePath = path.join(AGENTS_DIR, agentId, FINALIZE_STATE_FILENAME);
        console.log(`\n→ Finalizing onboarding (${options.interactive ? 'interactive' : 'headless'})...`);

        const profile = options.interactive
          ? undefined
          : (options.profileName && options.profileDescription
            ? buildFullProfile(options)
            : undefined);

        const services = buildServiceFromOptions(options, options.profileDescription);

        const finalizeResult = await finalizeOnboarding({
          agent,
          statePath: finalizeStatePath,
          mode: options.interactive ? 'interactive' : 'headless',
          profile,
          services,
          hooks: createFinalizeHooks(agentId, keys.identity, profile, services, disputePolicyData),
        });

        console.log(`✅ Finalize stage: ${finalizeResult.stage}`);
        console.log(`   State file: ${finalizeStatePath}`);
      }
    } catch (e) {
      console.error(`\n❌ Registration failed: ${e.message}`);

      // Save partial state on timeout so the user can recover
      if (e.name === 'RegistrationTimeoutError' || (e.message && e.message.includes('timed out'))) {
        keys.identity = e.identityName || (identityName + '.agentplatform@');
        keys.registrationStatus = 'timeout';
        keys.registrationTimestamp = new Date().toISOString();
        if (e.onboardId) keys.onboardId = e.onboardId;
        if (e.lastStatus) keys.lastOnboardStatus = e.lastStatus;
        writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);
        console.error(`\n⚠️  Partial state saved to keys.json`);
        console.error(`   The identity "${keys.identity}" may already exist on-chain.`);
        console.error(`   To check and recover: j41-dispatcher recover ${agentId}`);
      }

      process.exit(1);
    }
  });

// Finalize command — complete post-onboard lifecycle
program
  .command('finalize <agent-id>')
  .description('Finalize onboarding lifecycle (VDXF/profile/service readiness)')
  .option('--interactive', 'Interactive finalize mode (prompts for profile/service)')
  .option('--profile-name <name>', 'Profile display name for headless finalize')
  .option('--profile-type <type>', 'Profile type (autonomous|assisted|hybrid|tool)', 'autonomous')
  .option('--profile-description <desc>', 'Profile description for headless finalize')
  .option('--pay-address <address>', 'Payment address (i-address or R-address)')
  .option('--profile-capabilities <json>', 'Capabilities as JSON array: [{"id":"x","name":"X"}]', parseJsonArray)
  .option('--profile-endpoints <json>', 'Endpoints as JSON array: [{"url":"https://...","protocol":"MCP"}]', parseJsonArray)
  .option('--profile-protocols <protos>', 'Comma-separated protocols (MCP,REST,A2A,WebSocket)', (v) => v.split(','))
  .option('--profile-tags <tags>', 'Comma-separated tags', (v) => v.split(','))
  .option('--profile-website <url>', 'Agent website URL')
  .option('--profile-avatar <url>', 'Agent avatar URL')
  .option('--models <models>', 'Comma-separated LLM model names (e.g. "kimi-k2.5,claude-sonnet-4.6")')
  .option('--profile-category <cat>', 'Agent category')
  .option('--service-name <name>', 'Service name for marketplace listing')
  .option('--service-description <desc>', 'Service description')
  .option('--service-price <price>', 'Service price')
  .option('--service-currency <currency>', 'Service currency', 'VRSC')
  .option('--service-category <cat>', 'Service category')
  .option('--service-turnaround <time>', 'Service turnaround time', '1h')
  .option('--service-payment-terms <terms>', 'Payment terms (prepay|postpay)', 'prepay')
  .option('--service-private-mode', 'Enable private mode for this service')
  .option('--service-sovguard', 'Require SovGuard protection (default: true)')
  .option('--session-duration <min>', 'Max session duration in minutes', parseInt)
  .option('--session-token-limit <n>', 'Max tokens per session', parseInt)
  .option('--session-image-limit <n>', 'Max images per session', parseInt)
  .option('--session-message-limit <n>', 'Max messages per session', parseInt)
  .option('--session-max-file-size <bytes>', 'Max file size in bytes', parseInt)
  .option('--session-allowed-file-types <types>', 'Comma-separated MIME types', (v) => v.split(','))
  .option('--data-policy <policy>', 'Data handling policy (ephemeral|retained|encrypted)')
  .option('--trust-level <level>', 'Trust level (basic|verified|audited)')
  .option('--dispute-resolution <method>', 'Dispute resolution method')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found. Run: j41-dispatcher init`);
      process.exit(1);
    }
    if (!keys.identity) {
      console.error(`❌ Agent ${agentId} has no platform identity. Run register first.`);
      process.exit(1);
    }

    const { J41Agent, finalizeOnboarding } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    const finalizeStatePath = path.join(AGENTS_DIR, agentId, FINALIZE_STATE_FILENAME);
    console.log(`\n→ Finalizing ${agentId} (${options.interactive ? 'interactive' : 'headless'})...`);

    const profile = options.interactive
      ? undefined
      : (options.profileName && options.profileDescription
        ? buildFullProfile(options)
        : undefined);

    const services = buildServiceFromOptions(options, options.profileDescription);

    const finalizeResult = await finalizeOnboarding({
      agent,
      statePath: finalizeStatePath,
      mode: options.interactive ? 'interactive' : 'headless',
      profile,
      services,
      hooks: createFinalizeHooks(agentId, keys.identity, profile, services),
    });

    console.log(`✅ Finalize stage: ${finalizeResult.stage}`);
    console.log(`   State file: ${finalizeStatePath}`);
    if (finalizeResult.stage !== 'ready') {
      console.log('ℹ️  Finalization can be resumed by rerunning this command.');
    }
  });

// Recover command — resume after a timed-out registration
program
  .command('recover <agent-id>')
  .description('Recover from a timed-out registration by checking on-chain identity status')
  .action(async (agentId) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found. Run: j41-dispatcher init`);
      process.exit(1);
    }

    // Already fully registered?
    if (keys.iAddress && keys.identity && keys.registrationStatus !== 'timeout') {
      console.log(`✅ Agent ${agentId} is already registered.`);
      console.log(`   Identity: ${keys.identity}`);
      console.log(`   i-Address: ${keys.iAddress}`);
      return;
    }

    if (!keys.identity) {
      console.error(`❌ No identity name saved in keys.json — cannot recover.`);
      console.error(`   If you know the identity name, add it to keys.json manually and retry.`);
      process.exit(1);
    }

    console.log(`\n→ Recovering ${agentId} (${keys.identity})...`);

    // Strategy 1: If we have an onboardId, check its status directly
    if (keys.onboardId) {
      console.log(`   Checking onboard status (${keys.onboardId})...`);
      const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
      const agent = new J41Agent({
        apiUrl: J41_API_URL,
        wif: keys.wif,
      });

      try {
        const status = await agent._client.onboardStatus(keys.onboardId);
        console.log(`   Onboard status: ${status.status}`);

        if (status.status === 'registered') {
          // Identity exists — extract iAddress
          let iAddress = status.iAddress;

          // If iAddress is still pending, poll a bit more
          if (!iAddress || iAddress === 'pending-lookup') {
            console.log(`   Waiting for i-address...`);
            let attempts = 0;
            while ((!iAddress || iAddress === 'pending-lookup') && attempts < 18) {
              await new Promise(r => setTimeout(r, 10_000));
              const s = await agent._client.onboardStatus(keys.onboardId);
              iAddress = s.iAddress;
              attempts++;
              if (attempts % 3 === 0) {
                console.log(`   Still waiting... (${attempts * 10}s)`);
              }
            }
          }

          if (iAddress && iAddress !== 'pending-lookup') {
            keys.iAddress = iAddress;
            delete keys.registrationStatus;
            delete keys.registrationTimestamp;
            delete keys.onboardId;
            delete keys.lastOnboardStatus;
            writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);
            console.log(`\n✅ Recovery successful!`);
            console.log(`   Identity: ${keys.identity}`);
            console.log(`   i-Address: ${iAddress}`);
            console.log(`\n   Next: j41-dispatcher finalize ${agentId}`);
            return;
          }
        }

        if (status.status === 'failed') {
          console.error(`\n❌ Registration failed on-chain: ${status.error || 'unknown error'}`);
          console.error(`   You may need to re-register: j41-dispatcher register ${agentId} <name>`);
          // Clean up timeout state so register can be retried
          delete keys.registrationStatus;
          delete keys.onboardId;
          delete keys.lastOnboardStatus;
          delete keys.identity;
          writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);
          process.exit(1);
        }

        // Still confirming — tell user to wait
        console.log(`\n⏳ Identity is still confirming (status: ${status.status}).`);
        console.log(`   Try again in a few minutes: j41-dispatcher recover ${agentId}`);
        return;
      } catch (err) {
        console.error(`   Onboard status check failed: ${err.message}`);
        console.log(`   Falling back to login check...`);
      }
    }

    // Strategy 2: Try to log in — if it works, the identity exists
    console.log(`   Attempting login as ${keys.identity}...`);
    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
    });

    try {
      await agent.authenticate();
      console.log(`   Login succeeded — identity exists on-chain!`);

      // Try to get identity info for iAddress
      try {
        const idRaw = await agent._client.getIdentityRaw();
        const iAddress = idRaw?.data?.identity?.identityaddress || idRaw?.iAddress;
        if (iAddress) {
          keys.iAddress = iAddress;
        }
      } catch {
        // getIdentityRaw may not be available without full auth
      }

      delete keys.registrationStatus;
      delete keys.registrationTimestamp;
      delete keys.onboardId;
      delete keys.lastOnboardStatus;
      writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);

      console.log(`\n✅ Recovery successful!`);
      console.log(`   Identity: ${keys.identity}`);
      if (keys.iAddress) console.log(`   i-Address: ${keys.iAddress}`);
      console.log(`\n   Next: j41-dispatcher finalize ${agentId}`);
    } catch (err) {
      console.error(`   Login with ${agentId}'s key failed: ${err.message}`);

      // Strategy 3: Cross-check other agents — maybe a different agent registered this name
      console.log(`\n   Checking if another agent owns "${keys.identity}"...`);
      const allAgents = listRegisteredAgents();
      let foundOwner = null;

      for (const other of allAgents) {
        if (other === agentId) continue;
        const otherKeys = loadAgentKeys(other);
        if (!otherKeys?.wif) continue;

        try {
          const otherAgent = new J41Agent({
            apiUrl: J41_API_URL,
            wif: otherKeys.wif,
            identityName: keys.identity,
          });
          await otherAgent.authenticate();

          // Success! This agent's key owns the identity
          let iAddress;
          try {
            const idRaw = await otherAgent._client.getIdentityRaw();
            iAddress = idRaw?.data?.identity?.identityaddress || idRaw?.iAddress;
          } catch {}

          foundOwner = { agentId: other, iAddress };
          console.log(`\n   ✓ Identity "${keys.identity}" was registered by ${other}!`);
          break;
        } catch {
          // This agent's key doesn't own it either — continue
        }
      }

      if (foundOwner) {
        console.log(`\n   The identity belongs to ${foundOwner.agentId}, not ${agentId}.`);
        console.log(`   Cleaning up ${agentId}'s stale claim...`);

        // Clean stale state from this agent
        delete keys.identity;
        delete keys.iAddress;
        delete keys.registrationStatus;
        delete keys.onboardId;
        delete keys.lastOnboardStatus;
        delete keys.pendingName;
        writeKeysFile(path.join(AGENTS_DIR, agentId, 'keys.json'), keys);

        // Make sure the owning agent has iAddress if it was missing
        if (foundOwner.iAddress) {
          const ownerKeys = loadAgentKeys(foundOwner.agentId);
          if (ownerKeys && !ownerKeys.iAddress) {
            ownerKeys.iAddress = foundOwner.iAddress;
            delete ownerKeys.registrationStatus;
            writeKeysFile(path.join(AGENTS_DIR, foundOwner.agentId, 'keys.json'), ownerKeys);
          }
        }

        console.log(`\n✅ Resolved. "${keys.identity}" belongs to ${foundOwner.agentId}.`);
        console.log(`   ${agentId} is now clean — register it with a different name.`);
      } else {
        console.error(`\n❌ Identity "${keys.identity}" not found on any local agent's key.`);
        console.error(`   The identity may not exist on-chain yet (wait and retry),`);
        console.error(`   or use "Re-register" in the dashboard to clear state and try again.`);
        process.exit(1);
      }
    }
  });

// Set revoke/recover authorities for an agent's identity
program
  .command('set-authorities <agentId>')
  .description('Set revocation and recovery authorities for an agent identity')
  .requiredOption('--revoke <iAddress>', 'Revocation authority i-address')
  .requiredOption('--recover <iAddress>', 'Recovery authority i-address')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found. Run: j41-dispatcher init`);
      process.exit(1);
    }
    if (!keys.identity) {
      console.error(`❌ Agent ${agentId} has no platform identity. Run register first.`);
      process.exit(1);
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    await agent.authenticate();

    // Show current authorities first
    console.log(`\n→ Checking current authorities for ${agentId} (${keys.identity})...`);
    const current = await agent.checkAuthorities();
    console.log(`  Identity:    ${current.identityaddress}`);
    console.log(`  Revoke auth: ${current.revocationauthority}${current.selfRevoke ? ' ⚠️  (SELF — not secure)' : ''}`);
    console.log(`  Recover auth: ${current.recoveryauthority}${current.selfRecover ? ' ⚠️  (SELF — not secure)' : ''}`);

    console.log(`\n→ Updating authorities...`);
    console.log(`  New revoke:  ${options.revoke}`);
    console.log(`  New recover: ${options.recover}`);

    const txid = await agent.setRevokeRecoverAuthorities(options.revoke, options.recover);
    if (txid === 'already-set') {
      console.log(`\n✅ Authorities are already set to these values.`);
    } else {
      console.log(`\n✅ Authorities updated. Txid: ${txid}`);
      console.log(`   Wait for confirmation before relying on new authorities.`);
    }

    agent.stop();
  });

// Check authorities for all registered agents
program
  .command('check-authorities')
  .description('Check revoke/recover authorities for all registered agents')
  .action(async () => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const agents = listRegisteredAgents();
    if (agents.length === 0) {
      console.log('No registered agents found.');
      process.exit(0);
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    let warnings = 0;

    for (const agentId of agents) {
      const keys = loadAgentKeys(agentId);
      if (!keys || !keys.identity) continue;

      const agent = new J41Agent({
        apiUrl: J41_API_URL,
        wif: keys.wif,
        identityName: keys.identity,
        iAddress: keys.iAddress,
      });

      try {
        await agent.authenticate();
        const auth = await agent.checkAuthorities();
        const status = (auth.selfRevoke || auth.selfRecover) ? '⚠️' : '✅';
        if (auth.selfRevoke || auth.selfRecover) warnings++;
        console.log(`${status} ${agentId} (${keys.identity})`);
        console.log(`   Revoke: ${auth.revocationauthority}${auth.selfRevoke ? ' (SELF)' : ''}`);
        console.log(`   Recover: ${auth.recoveryauthority}${auth.selfRecover ? ' (SELF)' : ''}`);
      } catch (e) {
        console.log(`❌ ${agentId}: ${e.message}`);
      } finally {
        agent.stop();
      }
    }

    if (warnings > 0) {
      console.log(`\n⚠️  ${warnings} agent(s) have self-referential authorities.`);
      console.log(`   Run: j41-dispatcher set-authorities <agentId> --revoke <iAddr> --recover <iAddr>`);
    }
  });

// Deactivate command — remove agent from marketplace
program
  .command('deactivate <agent-id>')
  .description('Deactivate an agent: set status inactive on-chain + platform, remove services')
  .option('--keep-services', 'Keep service listings (only deactivate the agent profile)')
  .option('--platform-only', 'Skip on-chain VDXF status update (platform toggle only)')
  .option('--purge', 'Also delete local finalize state and VDXF files')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found.`);
      process.exit(1);
    }
    if (!keys.identity) {
      console.error(`❌ Agent ${agentId} has no registered identity.`);
      process.exit(1);
    }

    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║     Deactivate Agent                     ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    console.log(`  Agent:     ${agentId}`);
    console.log(`  Identity:  ${keys.identity}`);
    console.log(`  i-Address: ${keys.iAddress || '(unknown)'}`);
    console.log(`  On-chain:  ${options.platformOnly ? 'SKIP' : 'status → inactive'}`);
    console.log(`  Services:  ${options.keepServices ? 'KEEP' : 'REMOVE'}`);
    console.log(`  Purge:     ${options.purge ? 'YES (local files)' : 'no'}`);
    console.log(`\n  This will mark the agent inactive on${options.platformOnly ? ' the platform' : '-chain and on the platform'}.\n`);

    if (!options.yes) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => {
        rl.question('  Continue? (y/N) ', resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('\n  Cancelled.');
        process.exit(0);
      }
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    try {
      // Set services inactive (don't delete — so activate can bring them back)
      let svcDeactivated = 0;
      if (!options.keepServices) {
        try {
          const svcResp = await agent._client.getMyServices();
          const svcs = svcResp.data || [];
          for (const svc of svcs) {
            if (svc.status === 'active') {
              try { await agent._client.updateService(svc.id, { status: 'inactive' }); svcDeactivated++; } catch {}
            }
          }
        } catch {}
      }

      const result = await agent.deactivate({
        removeServices: false, // we handle services above — don't delete them
        onChain: !options.platformOnly,
      });

      // Tell J41 to re-read identity from chain
      try { await agent._client.refreshAgent(keys.iAddress); } catch {}

      console.log(`\n✅ Agent deactivated`);
      console.log(`   Platform status: ${result.status}`);
      if (svcDeactivated > 0) console.log(`   Services deactivated: ${svcDeactivated}`);
      if (result.onChainTxid) {
        console.log(`   On-chain txid: ${result.onChainTxid}`);
      }

      // Update local finalize state
      const agentDir = path.join(AGENTS_DIR, agentId);
      const finalizePath = path.join(agentDir, FINALIZE_STATE_FILENAME);

      if (options.purge) {
        for (const file of [FINALIZE_STATE_FILENAME, 'vdxf-update.json', 'vdxf-update.cmd']) {
          const fp = path.join(agentDir, file);
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
            console.log(`   Removed: ${file}`);
          }
        }
      } else if (fs.existsSync(finalizePath)) {
        const state = JSON.parse(fs.readFileSync(finalizePath, 'utf-8'));
        state.stage = 'deactivated';
        state.deactivatedAt = new Date().toISOString();
        state.notes = state.notes || [];
        state.notes.push(`${new Date().toISOString()} Agent deactivated (on-chain: ${!options.platformOnly})`);
        fs.writeFileSync(finalizePath, JSON.stringify(state, null, 2));
      }

      console.log(`\n   To re-activate: j41-dispatcher activate ${agentId}`);
    } catch (e) {
      console.error(`\n❌ Deactivation failed: ${e.message}`);
      process.exit(1);
    }
  });

// Activate command — bring an agent back online
program
  .command('activate <agent-id>')
  .description('Reactivate a deactivated agent: set status active on-chain + platform')
  .option('--platform-only', 'Skip on-chain VDXF status update (platform toggle only)')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found.`);
      process.exit(1);
    }
    if (!keys.identity) {
      console.error(`❌ Agent ${agentId} has no registered identity.`);
      process.exit(1);
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    try {
      const result = await agent.activate({ onChain: !options.platformOnly });

      // Re-activate services
      let svcCount = 0;
      try {
        const svcResp = await agent._client.getMyServices();
        const svcs = svcResp.data || [];
        for (const svc of svcs) {
          if (svc.status !== 'active') {
            try { await agent._client.updateService(svc.id, { status: 'active' }); svcCount++; } catch {}
          }
        }
      } catch {}

      // Tell J41 to re-read identity from chain
      try { await agent._client.refreshAgent(keys.iAddress); } catch {}

      console.log(`\n✅ Agent activated`);
      console.log(`   Platform status: ${result.status}`);
      if (svcCount > 0) console.log(`   Services reactivated: ${svcCount}`);
      if (result.onChainTxid) {
        console.log(`   On-chain txid: ${result.onChainTxid}`);
      }

      // Update local finalize state
      const agentDir = path.join(AGENTS_DIR, agentId);
      const finalizePath = path.join(agentDir, FINALIZE_STATE_FILENAME);
      if (fs.existsSync(finalizePath)) {
        const state = JSON.parse(fs.readFileSync(finalizePath, 'utf-8'));
        state.stage = 'ready';
        delete state.deactivatedAt;
        state.notes = state.notes || [];
        state.notes.push(`${new Date().toISOString()} Agent reactivated (on-chain: ${!options.platformOnly})`);
        fs.writeFileSync(finalizePath, JSON.stringify(state, null, 2));
      }

      console.log(`\n   Start dispatcher: j41-dispatcher start`);
    } catch (e) {
      console.error(`\n❌ Activation failed: ${e.message}`);
      process.exit(1);
    }
  });

// Activate all agents at once
program
  .command('activate-all')
  .description('Activate all registered agents (platform + on-chain VDXF status)')
  .option('--platform-only', 'Skip on-chain VDXF status update')
  .action(async (options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const allAgentIds = listRegisteredAgents(); // returns string[] of dir names
    const agents = allAgentIds.filter(id => {
      try {
        const k = loadAgentKeys(id);
        return k && k.identity && k.iAddress && k.wif;
      } catch { return false; }
    });

    if (agents.length === 0) {
      console.error('❌ No registered agents found.');
      process.exit(1);
    }

    console.log(`\n→ Activating ${agents.length} agent(s)...\n`);

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    let succeeded = 0;
    let failed = 0;

    for (const agentId of agents) {
      const keys = loadAgentKeys(agentId);
      try {
        const agent = new J41Agent({
          apiUrl: J41_API_URL,
          wif: keys.wif,
          identityName: keys.identity,
          iAddress: keys.iAddress,
        });
        const result = await agent.activate({ onChain: !options.platformOnly });
        // Re-activate services
        try {
          const svcResp = await agent._client.getMyServices();
          for (const svc of (svcResp.data || [])) {
            if (svc.status !== 'active') try { await agent._client.updateService(svc.id, { status: 'active' }); } catch {}
          }
        } catch {}
        try { await agent._client.refreshAgent(keys.iAddress); } catch {}
        console.log(`  ✓ ${agentId} (${keys.identity}) — ${result.status}${result.onChainTxid ? ' tx:' + result.onChainTxid.substring(0, 12) + '...' : ''}`);

        // Update finalize state
        const finalizePath = path.join(AGENTS_DIR, agentId, FINALIZE_STATE_FILENAME);
        if (fs.existsSync(finalizePath)) {
          const state = JSON.parse(fs.readFileSync(finalizePath, 'utf-8'));
          state.stage = 'ready';
          delete state.deactivatedAt;
          state.notes = state.notes || [];
          state.notes.push(`${new Date().toISOString()} Batch activated (on-chain: ${!options.platformOnly})`);
          fs.writeFileSync(finalizePath, JSON.stringify(state, null, 2));
        }
        succeeded++;
      } catch (e) {
        console.log(`  ✗ ${agentId} (${keys?.identity || '?'}) — ${e.message}`);
        failed++;
      }
    }

    console.log(`\n✅ Done: ${succeeded} activated, ${failed} failed`);
  });

// Deactivate all agents at once
program
  .command('deactivate-all')
  .description('Deactivate all registered agents (platform + on-chain VDXF status)')
  .option('--platform-only', 'Skip on-chain VDXF status update')
  .option('--keep-services', 'Keep service listings')
  .action(async (options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const allAgentIds = listRegisteredAgents();
    const agents = allAgentIds.filter(id => {
      try {
        const k = loadAgentKeys(id);
        return k && k.identity && k.iAddress && k.wif;
      } catch { return false; }
    });

    if (agents.length === 0) {
      console.error('❌ No registered agents found.');
      process.exit(1);
    }

    console.log(`\n→ Deactivating ${agents.length} agent(s)...\n`);

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    let succeeded = 0;
    let failed = 0;

    for (const agentId of agents) {
      const keys = loadAgentKeys(agentId);
      try {
        const agent = new J41Agent({
          apiUrl: J41_API_URL,
          wif: keys.wif,
          identityName: keys.identity,
          iAddress: keys.iAddress,
        });
        // Set services inactive (don't delete)
        if (!options.keepServices) {
          try {
            const svcResp = await agent._client.getMyServices();
            for (const svc of (svcResp.data || [])) {
              if (svc.status === 'active') try { await agent._client.updateService(svc.id, { status: 'inactive' }); } catch {}
            }
          } catch {}
        }
        const result = await agent.deactivate({
          onChain: !options.platformOnly,
          removeServices: false, // we set inactive above, don't delete
        });
        try { await agent._client.refreshAgent(keys.iAddress); } catch {}
        console.log(`  ✓ ${agentId} (${keys.identity}) — ${result.status}`);

        // Update finalize state
        const finalizePath = path.join(AGENTS_DIR, agentId, FINALIZE_STATE_FILENAME);
        if (fs.existsSync(finalizePath)) {
          const state = JSON.parse(fs.readFileSync(finalizePath, 'utf-8'));
          state.stage = 'deactivated';
          state.deactivatedAt = new Date().toISOString();
          state.notes = state.notes || [];
          state.notes.push(`${new Date().toISOString()} Batch deactivated (on-chain: ${!options.platformOnly})`);
          fs.writeFileSync(finalizePath, JSON.stringify(state, null, 2));
        }
        succeeded++;
      } catch (e) {
        console.log(`  ✗ ${agentId} (${keys.identity}) — ${e.message}`);
        failed++;
      }
    }

    console.log(`\n✅ Done: ${succeeded} deactivated, ${failed} failed`);
  });

/**
 * The standard dispute policy — identical to what `setup`/`quickstart` writes at
 * onboarding (see the interactive defaults above), so `--dispute-policy default`
 * lands an agent in the same state a fresh setup would.
 */
const DEFAULT_DISPUTE_POLICY = {
  defaultAction: 'rework',
  maxRefundPercent: 100,
  maxReworkCycles: 2,
  reworkBudgetPercent: 50,
  escalateAfter: 'max_rework',
  systemCrashRefund: 100,
};

/**
 * Returns an error string, or null when the policy is well-formed.
 * Deliberately strict: the dispatcher reads `defaultAction` and acts on it, so a
 * typo'd enum would silently change dispute behaviour rather than fail loudly.
 */
function validateDisputePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'must be a JSON object';
  const ACTIONS = ['rework', 'refund', 'reject'];
  const ESCALATE = ['max_rework', '2nd_dispute', 'never'];
  if (!ACTIONS.includes(p.defaultAction)) return `defaultAction must be one of ${ACTIONS.join(' | ')}`;
  if (!ESCALATE.includes(p.escalateAfter)) return `escalateAfter must be one of ${ESCALATE.join(' | ')}`;
  for (const [f, max] of [['maxRefundPercent', 100], ['reworkBudgetPercent', 100], ['systemCrashRefund', 100]]) {
    if (!Number.isFinite(p[f]) || p[f] < 0 || p[f] > max) return `${f} must be a number 0-${max}`;
  }
  if (!Number.isInteger(p.maxReworkCycles) || p.maxReworkCycles < 0) return 'maxReworkCycles must be an integer >= 0';
  return null;
}

// Update profile — single-transaction VDXF write. buildIdentityUpdateTx copies
// every existing key forward and replaces only those named, so other fields
// (incl. review.record) are untouched. NOT gated: do not run while an inbox
// identity tx for this agent is unconfirmed (see /health pendingWrites).
program
  .command('update-profile <agent-id>')
  .description('Update on-chain VDXF profile fields (single transaction; other fields preserved). Do not run while the dispatcher has an unconfirmed identity write for this agent.')
  .option('--display-name <name>', 'Agent display name')
  .option('--description <desc>', 'Agent description')
  .option('--type <type>', 'Agent type (autonomous|assisted|hybrid|tool)')
  .option('--pay-address <addr>', 'Payment address')
  .option('--markup <n>', 'Markup percentage')
  .option('--models <csv>', 'LLM models (comma-separated)')
  .option('--profile-category <cat>', 'Profile category')
  .option('--profile-tags <csv>', 'Profile tags (comma-separated)')
  .option('--profile-website <url>', 'Website URL')
  .option('--profile-avatar <url>', 'Avatar URL')
  .option('--network-capabilities <csv>', 'Capabilities (comma-separated)')
  .option('--network-endpoints <csv>', 'Endpoints (comma-separated URLs)')
  .option('--network-protocols <csv>', 'Protocols (comma-separated)')
  .option('--dispute-policy <json|default>', 'Dispute policy JSON, or "default" for the standard policy')
  .option('--dry-run', 'Print payloads without broadcasting')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found.`);
      process.exit(1);
    }
    if (!keys.identity || !keys.iAddress) {
      console.error(`❌ Agent ${agentId} is not registered on-chain. Register first.`);
      process.exit(1);
    }

    // Map CLI flags to VDXF field names
    const fieldsToUpdate = {};
    if (options.displayName) fieldsToUpdate.displayName = options.displayName;
    if (options.description) fieldsToUpdate.description = options.description;
    if (options.type) fieldsToUpdate.type = options.type;
    if (options.payAddress) fieldsToUpdate.payAddress = options.payAddress;
    if (options.markup) fieldsToUpdate.markup = options.markup;
    if (options.models) fieldsToUpdate.models = JSON.stringify(options.models.split(',').map(s => s.trim()));
    if (options.profileCategory) fieldsToUpdate.profileCategory = options.profileCategory;
    if (options.profileTags) fieldsToUpdate.profileTags = JSON.stringify(options.profileTags.split(',').map(s => s.trim()));
    if (options.profileWebsite) fieldsToUpdate.profileWebsite = options.profileWebsite;
    if (options.profileAvatar) fieldsToUpdate.profileAvatar = options.profileAvatar;
    if (options.networkCapabilities) fieldsToUpdate.networkCapabilities = JSON.stringify(options.networkCapabilities.split(',').map(s => s.trim()));
    if (options.networkEndpoints) fieldsToUpdate.networkEndpoints = JSON.stringify(options.networkEndpoints.split(',').map(s => s.trim()));
    if (options.networkProtocols) fieldsToUpdate.networkProtocols = JSON.stringify(options.networkProtocols.split(',').map(s => s.trim()));
    if (options.disputePolicy) {
      // A malformed policy on-chain is worse than none: the dispatcher would load
      // it and act on garbage, where an absent one degrades to log-only. Validate
      // fully before writing.
      let policy;
      if (options.disputePolicy === 'default') {
        policy = { ...DEFAULT_DISPUTE_POLICY };
      } else {
        try { policy = JSON.parse(options.disputePolicy); }
        catch (e) { console.error(`❌ --dispute-policy is not valid JSON: ${e.message}`); process.exit(1); }
      }
      const err = validateDisputePolicy(policy);
      if (err) { console.error(`❌ --dispute-policy invalid: ${err}`); process.exit(1); }
      fieldsToUpdate.disputePolicy = JSON.stringify(policy);
    }

    if (Object.keys(fieldsToUpdate).length === 0) {
      console.error('❌ No fields specified. Use --display-name, --description, etc.');
      process.exit(1);
    }

    console.log(`\n→ Updating ${Object.keys(fieldsToUpdate).length} VDXF field(s) for ${keys.identity}...\n`);
    for (const [k, v] of Object.entries(fieldsToUpdate)) {
      console.log(`  ${k}: ${typeof v === 'string' && v.length > 60 ? v.substring(0, 60) + '...' : v}`);
    }
    console.log('');

    if (options.dryRun) {
      // Resolve with the SAME function the real run uses, so a dry-run predicts
      // the real outcome including a throw on an unknown/ambiguous field.
      const { resolveVdxfFieldRef } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
      let resolved;
      try {
        resolved = Object.fromEntries(Object.entries(fieldsToUpdate).map(
          ([f, v]) => [`${f} (${resolveVdxfFieldRef(f)})`, v]));
      } catch (e) {
        console.error(`\n❌ ${e.message}`);
        process.exit(1);
      }
      console.log('── Single-transaction write (dry-run) ──');
      console.log('Only these VDXF keys are replaced; every other key on the identity');
      console.log('is copied forward untouched, and prior values stay in identity history.\n');
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const { removeAndRewriteVdxfFields } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');

    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    await agent.authenticate();
    console.log('  ✓ Authenticated\n');

    try {
      const result = await removeAndRewriteVdxfFields({
        agent,
        identityName: keys.identity,
        fieldsToUpdate,
        chain: J41_NETWORK,
        wif: keys.wif,
        onProgress: (msg) => console.log(`  ${msg}`),
      });

      console.log(`\n✅ VDXF update complete!`);
      console.log(`  Write TX:  ${result.writeTxid}`);
    } catch (e) {
      console.error(`\n❌ Update failed: ${e.message}`);
      process.exit(1);
    }
  });

// Inspect command — show everything about an agent
program
  .command('inspect <agent-id>')
  .description('Show full agent state: local files, on-chain identity, platform profile, and services')
  .option('--json', 'Output raw JSON instead of formatted text')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();

    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found. Run: j41-dispatcher init`);
      process.exit(1);
    }

    const agentDir = path.join(AGENTS_DIR, agentId);
    const result = { local: {}, chain: null, platform: null, services: [], reputation: null };

    // ── Local state ──
    result.local.address = keys.address;
    result.local.identity = keys.identity || null;
    result.local.iAddress = keys.iAddress || null;
    result.local.network = keys.network || J41_NETWORK;
    result.local.registrationStatus = keys.registrationStatus || (keys.identity ? 'registered' : 'unregistered');

    const finalizePath = path.join(agentDir, FINALIZE_STATE_FILENAME);
    if (fs.existsSync(finalizePath)) {
      result.local.finalize = JSON.parse(fs.readFileSync(finalizePath, 'utf-8'));
    }

    const soulPath = path.join(agentDir, 'SOUL.md');
    result.local.hasSoul = fs.existsSync(soulPath);

    const vdxfPath = path.join(agentDir, 'vdxf-update.json');
    if (fs.existsSync(vdxfPath)) {
      const vdxf = JSON.parse(fs.readFileSync(vdxfPath, 'utf-8'));
      result.local.vdxfGeneratedAt = vdxf.generatedAt;
      result.local.vdxfDefinitionCount = vdxf.canonicalDefinitionCount;
    }

    // ── On-chain + platform (requires identity) ──
    if (keys.identity && keys.wif) {
      const { J41Agent, decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/index.js');
      const agent = new J41Agent({
        apiUrl: J41_API_URL,
        wif: keys.wif,
        identityName: keys.identity,
        iAddress: keys.iAddress,
      });

      try {
        await agent.authenticate();

        // On-chain identity
        try {
          const idRaw = await agent._client.getIdentityRaw();
          const id = idRaw.data?.identity || idRaw.identity;
          if (id) {
            result.chain = {
              name: id.name,
              identityaddress: id.identityaddress,
              parent: id.parent,
              primaryaddresses: id.primaryaddresses,
              minimumsignatures: id.minimumsignatures,
              revocationauthority: id.revocationauthority,
              recoveryauthority: id.recoveryauthority,
              hasContentMultimap: !!(id.contentmultimap && Object.keys(id.contentmultimap).length),
              vdxfFieldCount: id.contentmultimap ? Object.keys(id.contentmultimap).length : 0,
            };

            // Decode VDXF content
            if (id.contentmultimap && typeof decodeContentMultimap === 'function') {
              try {
                const decoded = decodeContentMultimap(id.contentmultimap);
                result.chain.decodedProfile = decoded.profile || null;
                result.chain.decodedServices = decoded.services || [];
              } catch {
                result.chain.decodedProfile = '(decode failed)';
              }
            }
          }
        } catch (e) {
          result.chain = { error: e.message };
        }

        // Platform profile
        try {
          const agentLookupId = keys.iAddress || keys.identity;
          const profile = await agent._client.getAgent(agentLookupId);
          result.platform = {
            id: profile.id,
            name: profile.name,
            type: profile.type,
            status: profile.status,
            description: profile.description,
            protocols: profile.protocols,
            capabilities: (profile.capabilities || []).map(c => ({ id: c.id, name: c.name })),
            endpoints: profile.endpoints || [],
            privacyTier: profile.privacyTier,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          };
        } catch (e) {
          result.platform = { error: e.message };
        }

        // Services
        try {
          const svcLookupId = keys.iAddress || keys.identity;
          const svcResp = await agent._client.getAgentServices(svcLookupId);
          result.services = (svcResp.data || []).map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            price: s.price,
            currency: s.currency,
            category: s.category,
            turnaround: s.turnaround,
            status: s.status,
          }));
        } catch (e) {
          result.services = [{ error: e.message }];
        }

        // Reputation
        try {
          const repLookupId = keys.iAddress || keys.identity;
          result.reputation = await agent._client.getReputation(repLookupId, true);
        } catch {
          result.reputation = null;
        }
      } catch (e) {
        result.platform = { error: `Login failed: ${e.message}` };
      }
    }

    // ── Output ──
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Formatted output
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║     Agent Inspection: ${agentId.padEnd(18)}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);

    // Local
    console.log(`── Local State ──`);
    console.log(`  Address:      ${result.local.address}`);
    console.log(`  Identity:     ${result.local.identity || '(not registered)'}`);
    console.log(`  i-Address:    ${result.local.iAddress || '(none)'}`);
    console.log(`  Network:      ${result.local.network}`);
    console.log(`  Status:       ${result.local.registrationStatus}`);
    console.log(`  SOUL.md:      ${result.local.hasSoul ? 'yes' : 'no'}`);
    if (result.local.finalize) {
      console.log(`  Finalize:     ${result.local.finalize.stage} (${result.local.finalize.completedAt || 'in progress'})`);
      if (result.local.finalize.notes) {
        result.local.finalize.notes.forEach(n => console.log(`                ${n}`));
      }
    }
    if (result.local.vdxfGeneratedAt) {
      console.log(`  VDXF payload: generated ${result.local.vdxfGeneratedAt} (${result.local.vdxfDefinitionCount} definitions)`);
    }

    // Chain
    if (result.chain && !result.chain.error) {
      console.log(`\n── On-Chain Identity ──`);
      console.log(`  Name:         ${result.chain.name}`);
      console.log(`  i-Address:    ${result.chain.identityaddress}`);
      console.log(`  Parent:       ${result.chain.parent}`);
      console.log(`  Addresses:    ${(result.chain.primaryaddresses || []).join(', ')}`);
      console.log(`  Min sigs:     ${result.chain.minimumsignatures}`);
      console.log(`  Revoke auth:  ${result.chain.revocationauthority}`);
      console.log(`  Recover auth: ${result.chain.recoveryauthority}`);
      console.log(`  VDXF fields:  ${result.chain.vdxfFieldCount}`);
      if (result.chain.decodedProfile && typeof result.chain.decodedProfile === 'object') {
        const p = result.chain.decodedProfile;
        console.log(`  VDXF profile: ${p.name || '?'} (${p.type || '?'})`);
        if (p.description) console.log(`                ${p.description.substring(0, 80)}${p.description.length > 80 ? '...' : ''}`);
        if (p.network) {
          console.log(`  Network:      ${JSON.stringify(p.network)}`);
        }
        if (p.profile) {
          console.log(`  Profile:      ${JSON.stringify(p.profile)}`);
        }
        if (p.platformConfig) {
          console.log(`  Platform:     ${JSON.stringify(p.platformConfig)}`);
        }
      }
      if (result.chain.decodedServices && result.chain.decodedServices.length) {
        console.log(`  VDXF services: ${result.chain.decodedServices.length}`);
        result.chain.decodedServices.forEach((s, i) => {
          console.log(`    [${i + 1}] ${s.name} — ${s.price || '?'} ${s.currency || 'VRSC'} (${s.status || '?'})`);
        });
      }
    } else if (result.chain?.error) {
      console.log(`\n── On-Chain Identity ──`);
      console.log(`  Error: ${result.chain.error}`);
    }

    // Platform
    if (result.platform && !result.platform.error) {
      console.log(`\n── Platform Profile ──`);
      console.log(`  Name:         ${result.platform.name}`);
      console.log(`  Type:         ${result.platform.type}`);
      console.log(`  Status:       ${result.platform.status}`);
      console.log(`  Privacy:      ${result.platform.privacyTier || 'standard'}`);
      console.log(`  Protocols:    ${(result.platform.protocols || []).join(', ') || 'none'}`);
      if (result.platform.description) {
        console.log(`  Description:  ${result.platform.description.substring(0, 80)}${result.platform.description.length > 80 ? '...' : ''}`);
      }
      if (result.platform.capabilities?.length) {
        console.log(`  Capabilities: ${result.platform.capabilities.map(c => c.name).join(', ')}`);
      }
      if (result.platform.endpoints?.length) {
        result.platform.endpoints.forEach(e => console.log(`  Endpoint:     ${e.protocol} ${e.url}${e.public ? ' (public)' : ''}`));
      }
      console.log(`  Created:      ${result.platform.createdAt}`);
      console.log(`  Updated:      ${result.platform.updatedAt}`);
    } else if (result.platform?.error) {
      console.log(`\n── Platform Profile ──`);
      console.log(`  Error: ${result.platform.error}`);
    }

    // Services
    if (result.services.length > 0 && !result.services[0]?.error) {
      console.log(`\n── Marketplace Services (${result.services.length}) ──`);
      result.services.forEach((s, i) => {
        console.log(`  [${i + 1}] ${s.name}`);
        if (s.description) console.log(`      ${s.description.substring(0, 80)}${s.description.length > 80 ? '...' : ''}`);
        console.log(`      Price: ${s.price} ${s.currency} | Category: ${s.category || '?'} | Turnaround: ${s.turnaround || '?'} | Status: ${s.status}`);
      });
    } else if (result.services.length === 0) {
      console.log(`\n── Marketplace Services ──`);
      console.log(`  No services registered`);
    }

    // Reputation
    if (result.reputation) {
      console.log(`\n── Reputation ──`);
      const r = result.reputation;
      console.log(`  Rating:       ${r.averageRating ?? 'no reviews'}`);
      console.log(`  Reviews:      ${r.totalReviews ?? 0}`);
      console.log(`  Jobs done:    ${r.completedJobs ?? 0}`);
    }

    console.log('');
  });

// Setup command — one-command agent onboarding
program
  .command('setup <agent-id> <identity-name>')
  .description('One-command setup: init keys + register on-chain + finalize with profile & service')
  .option('--template <name>', 'Use a template (code-review, general-assistant, data-analyst)')
  .option('--profile-name <name>', 'Profile display name')
  .option('--profile-type <type>', 'Profile type (autonomous|assisted|hybrid|tool)', 'autonomous')
  .option('--profile-description <desc>', 'Profile description')
  .option('--profile-category <cat>', 'Agent category', 'ai-assistant')
  .option('--profile-protocols <protos>', 'Comma-separated protocols', (v) => v.split(','), ['MCP'])
  .option('--profile-tags <tags>', 'Comma-separated tags', (v) => v.split(','))
  .option('--profile-website <url>', 'Agent website URL')
  .option('--profile-avatar <url>', 'Agent avatar URL')
  .option('--models <models>', 'Comma-separated LLM model names (e.g. "kimi-k2.5,claude-sonnet-4.6")')
  .option('--pay-address <address>', 'Payment address (i-address or R-address)')
  .option('--profile-capabilities <json>', 'Capabilities as JSON array', parseJsonArray)
  .option('--profile-endpoints <json>', 'Endpoints as JSON array', parseJsonArray)
  .option('--service-name <name>', 'Service name for marketplace')
  .option('--service-description <desc>', 'Service description')
  .option('--service-price <price>', 'Service price')
  .option('--service-currency <currency>', 'Service currency', 'VRSC')
  .option('--service-category <cat>', 'Service category')
  .option('--service-turnaround <time>', 'Service turnaround time', '1h')
  .option('--service-payment-terms <terms>', 'Payment terms (prepay|postpay)', 'prepay')
  .option('--service-private-mode', 'Enable private mode for this service')
  .option('--service-sovguard', 'Require SovGuard protection (default: true)')
  .option('--session-duration <min>', 'Max session duration in minutes', parseInt)
  .option('--session-token-limit <n>', 'Max tokens per session', parseInt)
  .option('--session-message-limit <n>', 'Max messages per session', parseInt)
  .option('--data-policy <policy>', 'Data handling policy (ephemeral|retained|encrypted)')
  .option('--trust-level <level>', 'Trust level (basic|verified|audited)')
  .option('--dispute-resolution <method>', 'Dispute resolution method')
  .option('--soul <file>', 'SOUL.md file to use')
  .option('-i, --interactive', 'Interactive mode — walk through all fields')
  .action(async (agentId, identityName, options) => {
    ensureDirs();
    await ensureKeystoreUnlockedIfEncrypted();

    // Load template if specified
    if (options.template) {
      const tplDir = path.join(__dirname, '..', 'templates', options.template);
      const tplConfigPath = path.join(tplDir, 'config.json');
      if (!fs.existsSync(tplConfigPath)) {
        const available = fs.readdirSync(path.join(__dirname, '..', 'templates')).filter(d => fs.existsSync(path.join(__dirname, '..', 'templates', d, 'config.json')));
        console.error(`❌ Template "${options.template}" not found. Available: ${available.join(', ')}`);
        process.exit(1);
      }
      const tpl = JSON.parse(fs.readFileSync(tplConfigPath, 'utf8'));
      console.log(`📋 Using template: ${options.template}\n`);

      // Merge template into options (CLI flags override template)
      if (tpl.profile) {
        if (!options.profileName) options.profileName = tpl.profile.name;
        if (!options.profileType) options.profileType = tpl.profile.type;
        if (!options.profileDescription) options.profileDescription = tpl.profile.description;
        if (!options.profileCategory && tpl.profile.profile?.category) options.profileCategory = tpl.profile.profile.category;
        if (!options.profileTags && tpl.profile.profile?.tags) options.profileTags = tpl.profile.profile.tags;
        if (!options.profileProtocols && tpl.profile.network?.protocols) options.profileProtocols = tpl.profile.network.protocols;
        if (!options.models && tpl.profile.models) options.models = tpl.profile.models;
      }
      if (tpl.service) {
        if (!options.serviceName) options.serviceName = tpl.service.name;
        if (!options.serviceDescription) options.serviceDescription = tpl.service.description;
        if (!options.servicePrice) options.servicePrice = tpl.service.price;
        if (!options.serviceCurrency) options.serviceCurrency = tpl.service.currency;
        if (!options.serviceCategory) options.serviceCategory = tpl.service.category;
        if (!options.serviceTurnaround) options.serviceTurnaround = tpl.service.turnaround;
        if (!options.servicePaymentTerms) options.servicePaymentTerms = tpl.service.paymentTerms;
      }
      // Copy SOUL.md if template has one and agent doesn't yet
      options._templateSoulPath = path.join(tplDir, 'SOUL.md');
    }

    // Interactive mode: prompt for all fields before proceeding
    if (options.interactive) {
      const answers = await interactiveOnboarding(identityName);
      // Merge interactive answers into options (CLI flags take precedence)
      for (const [key, value] of Object.entries(answers)) {
        if (options[key] == null || options[key] === undefined) {
          options[key] = value;
        }
      }
    }

    console.log('╔══════════════════════════════════════════╗');
    console.log('║     J41 Agent Setup                      ║');
    console.log(`║     ${agentId.padEnd(37)}║`);
    console.log('╚══════════════════════════════════════════╝\n');

    const agentDir = path.join(AGENTS_DIR, agentId);

    // ── Step 1: Init keys ──
    console.log('Step 1/4: Initialize keys');
    let keys;
    if (fs.existsSync(path.join(agentDir, 'keys.json'))) {
      keys = loadAgentKeys(agentId);
      console.log(`  ✓ Keys exist (${keys.address})`);
    } else {
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const { generateKeypair } = require('./keygen.js');
      keys = generateKeypair(J41_NETWORK);
      keys.network = J41_NETWORK;
      writeKeysFile(path.join(agentDir, 'keys.json'), keys);
      console.log(`  ✓ Keys generated (${keys.address})`);
    }

    // Write SOUL.md — template > --soul flag > default
    if (options._templateSoulPath && fs.existsSync(options._templateSoulPath) && !fs.existsSync(path.join(agentDir, 'SOUL.md'))) {
      fs.copyFileSync(options._templateSoulPath, path.join(agentDir, 'SOUL.md'));
      console.log(`  ✓ SOUL.md from template`);
    } else if (options.soul && fs.existsSync(options.soul)) {
      fs.copyFileSync(options.soul, path.join(agentDir, 'SOUL.md'));
      console.log(`  ✓ SOUL.md copied from ${options.soul}`);
    } else if (!fs.existsSync(path.join(agentDir, 'SOUL.md'))) {
      const name = options.profileName || identityName;
      fs.writeFileSync(path.join(agentDir, 'SOUL.md'), `# ${name}\n\nA helpful AI assistant on the J41 platform.`);
      console.log(`  ✓ Default SOUL.md created`);
    }

    // ── Step 2: Register on-chain ──
    console.log('\nStep 2/4: Register identity on-chain');
    const { J41Agent, finalizeOnboarding, RegistrationTimeoutError } = require('@junction41/sovagent-sdk/dist/index.js');

    if (keys.identity && keys.iAddress && keys.registrationStatus !== 'timeout') {
      console.log(`  ✓ Already registered: ${keys.identity}`);
    } else {
      // Check for duplicate name across local agents
      const setupFullName = identityName + '.agentplatform@';
      const setupAllAgents = listRegisteredAgents();
      for (const other of setupAllAgents) {
        if (other === agentId) continue;
        const otherKeys = loadAgentKeys(other);
        if (!otherKeys) continue;
        const otherName = otherKeys.identity || otherKeys.pendingName;
        if (otherName && (otherName === setupFullName || otherName.replace('.agentplatform@', '') === identityName)) {
          console.error(`  ❌ Name "${identityName}" is already claimed by ${other}.`);
          console.error(`     Pick a different name, or clear ${other}'s state first.`);
          process.exit(1);
        }
      }
      const agent = new J41Agent({
        apiUrl: J41_API_URL,
        wif: keys.wif,
      });

      try {
        console.log(`  → Registering ${identityName}.agentplatform@ (this may take several minutes)...`);
        const regResult = await agent.register(identityName, J41_NETWORK);
        keys.identity = regResult.identity;
        keys.iAddress = regResult.iAddress;
        delete keys.registrationStatus;
        delete keys.onboardId;
        writeKeysFile(path.join(agentDir, 'keys.json'), keys);
        console.log(`  ✓ Registered: ${regResult.identity} (${regResult.iAddress})`);
      } catch (e) {
        if (e.name === 'RegistrationTimeoutError' || (e.message && e.message.includes('timed out'))) {
          keys.identity = e.identityName || (identityName + '.agentplatform@');
          keys.registrationStatus = 'timeout';
          if (e.onboardId) keys.onboardId = e.onboardId;
          writeKeysFile(path.join(agentDir, 'keys.json'), keys);
          console.error(`  ⚠️  Registration timed out. Run: j41-dispatcher recover ${agentId}`);
          console.error(`     Then re-run: j41-dispatcher setup ${agentId} ${identityName} [flags...]`);
          process.exit(1);
        }
        console.error(`  ❌ ${e.message}`);
        process.exit(1);
      }
    }

    // ── Step 3: Register platform profile ──
    console.log('\nStep 3/4: Register platform profile');
    const profileAgent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    let profileData;
    let services = [];
    let disputePolicyData;
    const soulPath = path.join(agentDir, 'SOUL.md');
    const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '';

    if (options.interactive || !options.profileName) {
      // Interactive walkthrough — prompt for every VDXF field
      const result = await interactiveProfileSetup(keys, soul);
      profileData = result.profile;
      services = result.services;
      disputePolicyData = result.disputePolicy;
    } else {
      // Headless mode — use CLI flags
      profileData = buildFullProfile(options);
      services = buildServiceFromOptions(options, profileData.description);
    }

    try {
      const regResult = await profileAgent.registerWithJ41(profileData);
      console.log(`  ✓ Profile registered (${regResult.agentId || 'ok'})`);

      for (const svc of services) {
        try {
          await profileAgent.registerService(svc);
          console.log(`  ✓ Service registered: ${svc.name}`);
        } catch (svcErr) {
          console.error(`  ⚠️  Service "${svc.name}": ${svcErr.message}`);
        }
      }
    } catch (e) {
      console.error(`  ⚠️  Profile: ${e.message}`);
    }

    // ── Step 4: Finalize (VDXF on-chain + service registration) ──
    console.log('\nStep 4/4: Finalize (VDXF on-chain + service registration)');
    const profile = profileData;

    // Remove stale finalize state so it runs fresh
    const finalizeStatePath = path.join(agentDir, FINALIZE_STATE_FILENAME);
    if (fs.existsSync(finalizeStatePath)) {
      fs.unlinkSync(finalizeStatePath);
    }

    try {
      const finalizeResult = await finalizeOnboarding({
        agent: profileAgent,
        statePath: finalizeStatePath,
        mode: 'headless',
        profile: profile || profileData,
        services,
        hooks: createFinalizeHooks(agentId, keys.identity, profile || profileData, services, disputePolicyData),
      });
      console.log(`  ✓ Finalize: ${finalizeResult.stage}`);
    } catch (e) {
      // F1 (follow-up) — 2.21.0 made publishVdxf throw so the SDK stops marking a
      // step that did not happen. That fixed the state machine but NOT the headline
      // claim: this catch swallowed the throw and the "Setup Complete" banner printed
      // regardless, so the operator still walked away believing a fresh, unfunded
      // agent was ready. `runtime.require_finalize` defaults to false, so `start`
      // would then happily run it over an empty on-chain identity. One warning line
      // scrolling past is not a failure report.
      console.error(`\n  ❌ Finalize did not complete: ${e.message}`);
      console.error('');
      console.error('  ╔══════════════════════════════════════════╗');
      console.error('  ║     Setup INCOMPLETE                     ║');
      console.error('  ╚══════════════════════════════════════════╝');
      console.error(`  Agent:    ${agentId}`);
      console.error(`  Identity: ${keys.identity}`);
      console.error(`  i-Address: ${keys.iAddress}`);
      console.error('');
      console.error('  The local agent exists, but its on-chain identity is NOT complete.');
      console.error(`  Fix the cause above, then re-run:  j41-dispatcher setup ${agentId} ${keys.identity}`);
      console.error('  Do NOT start the dispatcher until this succeeds — the agent cannot');
      console.error('  publish reviews, attestations or job records on-chain.');
      process.exit(1);
    }

    // ── Summary ──
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Setup Complete                       ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`  Agent:    ${agentId}`);
    console.log(`  Identity: ${keys.identity}`);
    console.log(`  i-Address: ${keys.iAddress}`);
    console.log(`  Profile:  ${profileData.name} (${profileData.type})`);
    if (services.length) {
      console.log(`  Service:  ${services[0].name} — ${services[0].price} ${services[0].currency}`);
    }
    console.log(`\n  Next: j41-dispatcher start`);
    console.log(`  Verify: j41-dispatcher inspect ${agentId}`);
  });

// List available LLM providers (works without dispatcher running)
program
  .command('providers')
  .description('List available LLM providers and executor types')
  .action(() => {
    const { LLM_PRESETS, LLM_CONFIG } = require('./executors/local-llm.js');
    const { EXECUTOR_ALIASES } = require('./executors/index.js');

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     LLM Providers & Executors            ║');
    console.log('╚══════════════════════════════════════════╝\n');

    console.log('LLM Providers (set J41_LLM_PROVIDER):\n');
    for (const [name, preset] of Object.entries(LLM_PRESETS)) {
      if (name === 'custom') continue;
      const current = LLM_CONFIG.provider === name ? ' ← current' : '';
      console.log(`  ${name.padEnd(14)} ${(preset.model || '(configure)').padEnd(40)} ${preset.envKey || '(no key)'}${current}`);
    }

    console.log('\nExecutor Types (set J41_EXECUTOR):\n');
    console.log('  local-llm    Direct LLM API (default)');
    console.log('  webhook      REST POST endpoint');
    console.log('  langserve    LangChain Runnables');
    console.log('  langgraph    LangGraph Platform');
    console.log('  a2a          Google Agent-to-Agent');
    console.log('  mcp          MCP server + LLM');

    console.log('\nFramework Aliases (route to webhook executor):\n');
    for (const [alias, target] of Object.entries(EXECUTOR_ALIASES)) {
      console.log(`  ${alias.padEnd(14)} → ${target}`);
    }
    console.log('');
  });

// API setup — scriptable equivalent of the dashboard's apiEndpointSetupScreen.
// Writes endpointUrl/auth/modelPricing/rateLimits/publicUrl into agent-config.json
// and registers the service on-platform. Everything is flag-driven so CI or scripts can run it.
program
  .command('api-setup <agent-id>')
  .description('Configure an agent as an API endpoint seller (non-interactive)')
  .option('--name <name>', 'Service name (default: "<identity> API Access")')
  .option('--description <desc>', 'Service description', 'OpenAI-compatible API access')
  .option('--upstream-url <url>', 'Your LLM server URL (e.g. http://localhost:11434/v1)')
  .option('--upstream-auth <token>', 'Bearer token for upstream server (optional)')
  .option('--public-url <url>', 'Your public dispatcher URL (e.g. https://myagent.example.com)')
  .option('--model <spec...>', 'Model pricing: "model:inputPer1M:outputPer1M" (repeatable)')
  .option('--rpm <n>', 'Rate limit: requests/min/buyer', '60')
  .option('--tpm <n>', 'Rate limit: tokens/min/buyer', '100000')
  .option('--category <slug>', 'Marketplace category', 'infrastructure-ops')
  .option('--no-register', 'Skip platform registration (write config only)')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    const agentDir = path.join(AGENTS_DIR, agentId);
    if (!fs.existsSync(agentDir)) {
      console.error(`✗ Agent directory not found: ${agentDir}`);
      process.exit(1);
    }
    if (!options.upstreamUrl) { console.error('✗ --upstream-url is required'); process.exit(1); }
    if (!options.model || options.model.length === 0) { console.error('✗ at least one --model is required'); process.exit(1); }

    const modelPricing = [];
    for (const spec of options.model) {
      const parts = spec.split(':');
      if (parts.length !== 3) { console.error(`✗ bad --model "${spec}" — expected name:inputPer1M:outputPer1M`); process.exit(1); }
      const [model, inp, out] = parts;
      const inputTokenRate = parseFloat(inp) / 1000000;
      const outputTokenRate = parseFloat(out) / 1000000;
      if (!Number.isFinite(inputTokenRate) || !Number.isFinite(outputTokenRate)) {
        console.error(`✗ bad --model rates in "${spec}"`); process.exit(1);
      }
      modelPricing.push({ model, inputTokenRate, outputTokenRate });
    }

    const rateLimits = {
      requestsPerMinute: parseInt(options.rpm, 10),
      tokensPerMinute: parseInt(options.tpm, 10),
    };

    // Merge into agent-config.json
    const configPath = path.join(agentDir, 'agent-config.json');
    let config = {};
    try { if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    config.apiEndpointUrl = options.upstreamUrl;
    if (options.upstreamAuth) config.apiEndpointAuth = options.upstreamAuth.startsWith('Bearer ') ? options.upstreamAuth : `Bearer ${options.upstreamAuth}`;
    if (options.publicUrl) config.publicUrl = options.publicUrl;
    config.modelPricing = modelPricing;
    config.rateLimits = rateLimits;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    try { fs.chmodSync(configPath, 0o600); } catch {}
    console.log(`✓ Wrote ${configPath}`);

    if (!options.register) {
      console.log('Config saved. Skipping platform registration (--no-register).');
      return;
    }

    // Load keys and register service on-platform
    const keysPath = path.join(agentDir, 'keys.json');
    if (!fs.existsSync(keysPath)) { console.error(`✗ keys.json not found for ${agentId}`); process.exit(1); }
    const keys = readKeysFile(keysPath);

    const { J41Agent } = require('@junction41/sovagent-sdk');
    const agent = new J41Agent({
      apiUrl: cfg.platform.api_url,
      identityName: keys.identity,
      wif: keys.wif,
      iAddress: keys.iAddress,
      network: cfg.platform.network,
    });
    try {
      await agent.authenticate();
      const svc = await agent.registerService({
        name: options.name || `${keys.identity} API Access`,
        description: options.description,
        category: options.category,
        price: 0,
        currency: 'VRSCTEST',
        turnaround: 'real-time',
        paymentTerms: 'postpay',
        sovguard: false,
        serviceType: 'api-endpoint',
        endpointUrl: options.upstreamUrl,
        modelPricing,
        rateLimits,
      });
      console.log(`✓ Service registered on platform (id: ${svc?.id || svc?.data?.id || '?'})`);
      console.log('Next: start the dispatcher (j41-dispatcher start) — your service is now discoverable.');
    } catch (e) {
      console.error(`✗ Platform registration failed: ${e.message}`);
      console.error('  Config was still written — rerun with --no-register to skip this step, or fix auth and retry.');
      process.exit(1);
    } finally {
      try { agent.stop?.(); } catch {}
    }
  });

// Dashboard command — launch interactive TUI
program
  .command('dashboard')
  .description('Launch the interactive TUI menu')
  .action(() => { require('./dashboard.js'); });

// Start command — run the dispatcher (listen for jobs)
program
  .command('start')
  .description('Start the dispatcher (listens for jobs, manages pool)')
  .option('--webhook-url <url>', 'Public URL for receiving webhook events (enables webhook mode)')
  .option('--webhook-port <port>', 'Port for webhook HTTP server (default: 9841)', '9841')
  .option('--dev-unsafe', 'Allow local mode (ZERO isolation — development only)')
  .option('--no-fee-sweep', 'Disable the automatic i-address → R-address fee-tank sweep')
  .option('--fee-sweep-floor <writes>', `Sweep when an agent can afford fewer than this many on-chain writes (default: ${DEFAULT_FLOOR_WRITES})`)
  .option('--fee-sweep-interval <minutes>', 'Minutes between fee-tank checks (default: 30)')
  .action(async (options) => {
    ensureDirs();

    // Mainnet security gate (fail-closed): on network=verus, refuse to start
    // if any insecure escape hatch is set. IS_MAINNET comes from config, not env.
    if (IS_MAINNET) {
      const violations = findMainnetSecurityViolations(process.env, { devUnsafe: !!options.devUnsafe });
      if (violations.length) {
        console.error('');
        console.error('  ══════════════════════════════════════════════════');
        console.error('  MAINNET SECURITY GATE — refusing to start');
        console.error('  ══════════════════════════════════════════════════');
        console.error('  These insecure flags are not allowed on mainnet (network=verus):');
        for (const msg of violations) console.error(`  - ${msg}`);
        console.error('');
        console.error('  Unset them, or run on testnet (network=verustest).');
        console.error('');
        process.exit(1);
      }
    }

    // ── Unlock the at-rest key pool (if encryption is enabled) ──
    // One prompt at startup; the master key then lives in memory for the life
    // of the daemon. At-rest encryption protects a stolen disk/backup — NOT a
    // live-compromised running host (the key is resident once unlocked).
    if (fs.existsSync(MASTER_KEY_PATH)) {
      try {
        const pass = await keystore.resolvePassphrase({ promptFn: () => keystore.promptHidden('🔐 Unlock passphrase: ') });
        keystore.unlock(pass, MASTER_KEY_PATH);
        console.log('  🔓 Key pool unlocked (WIFs decrypted in memory only)');
      } catch (e) {
        console.error(`\n❌ Cannot unlock the key pool: ${e.message}`);
        process.exit(1);
      }
    }

    const agents = listRegisteredAgents();
    if (agents.length === 0) {
      console.error('❌ No agents found. Run: j41-dispatcher init');
      process.exit(1);
    }

    // ── PID file: ensure only one dispatcher runs at a time ──
    // Kills previous dispatcher process only — Docker containers stay alive
    // and get adopted by the new instance via polling.
    const PID_FILE = path.join(DISPATCHER_DIR, 'dispatcher.pid');
    try {
      if (fs.existsSync(PID_FILE)) {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
        if (oldPid && oldPid !== process.pid) {
          let alive = true;
          try { process.kill(oldPid, 0); } catch (e) { alive = (e.code === 'EPERM'); }
          if (alive) {
            // WAIT for it to actually die. A flat 1s sleep meant the old dispatcher
            // was still running its full shutdown — per-agent platform + on-chain
            // deactivation, then a drain that can legitimately last hours — while
            // this process started up. Three things went wrong concurrently:
            //   1. its deactivate loop flipped agents inactive while our startup
            //      check read them, so we skipped whatever it had already reached
            //      ("No agents registered" — the fleet-loss bug, second cause);
            //   2. our crash recovery read active-jobs.json, which still listed ITS
            //      draining jobs, and killed those containers + queued refunds for
            //      work that was about to deliver; and
            //   3. both processes broadcast identity transactions against the same
            //      confirmed prevOutput.
            // Its own stall detector guarantees it exits, so waiting is bounded.
            process.kill(oldPid, 'SIGTERM');
            console.log(`  Stopping previous dispatcher (PID ${oldPid})...`);
            const waitMs = Number(process.env.J41_STOP_WAIT_MS) > 0
              ? Number(process.env.J41_STOP_WAIT_MS)
              : 10 * 60 * 1000;
            const startedWait = Date.now();
            let gone = false;
            while (Date.now() - startedWait < waitMs) {
              await new Promise(r => setTimeout(r, 500));
              try { process.kill(oldPid, 0); } catch (e) {
                if (e.code !== 'EPERM') { gone = true; break; }
              }
            }
            if (!gone) {
              // Never proceed into a concurrent-dispatcher state — that is the
              // double-spend class this release exists to prevent. Refuse instead.
              console.error(`\n❌ Previous dispatcher (PID ${oldPid}) did not exit within ${Math.round(waitMs / 60000)} min.`);
              console.error('   It is probably draining active jobs. Wait for it to finish, or stop it with:');
              console.error(`     kill -9 ${oldPid}   # WARNING: orphans running containers; their jobs are refunded on next start`);
              console.error('   Refusing to start a second dispatcher against the same agents.');
              process.exit(1);
            }
            console.log(`  Previous dispatcher exited after ${Math.round((Date.now() - startedWait) / 1000)}s`);
          }
        }
      }
    } catch {}
    fs.writeFileSync(PID_FILE, String(process.pid));
    // Only remove the pid file if it is still OURS. An unconditional unlink meant a
    // departing dispatcher deleted its successor's pid file, after which `ctl` and
    // the dashboard both reported "not running" and the next `start` found no pid
    // to stop — leaving two live dispatchers on the same agents.
    process.on('exit', () => {
      try {
        if (parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) === process.pid) {
          fs.unlinkSync(PID_FILE);
        }
      } catch {}
    });

    console.log('╔══════════════════════════════════════════╗');
    console.log('║     J41 Dispatcher                       ║');
    console.log('║     Ephemeral Job Containers             ║');
    console.log('║     with Privacy Attestation             ║');
    console.log('╚══════════════════════════════════════════╝\n');
    // Store --dev-unsafe flag in state for local mode gate
    const _devUnsafe = !!options.devUnsafe;

    // F7 — refuse local mode HERE, before a single job is accepted.
    //
    // The gate existed only inside `startJobLocal` (see the "Security gate" below), so
    // a dispatcher in local mode without --dev-unsafe started cleanly, advertised its
    // agents, accepted jobs, took the buyer's payment, and only THEN refused to run
    // them. Both installers default to `runtime=local` when Docker is absent — and the
    // `curl | bash` path takes that default silently — so this is the out-of-the-box
    // state for anyone without Docker. Taking money for work we have already decided
    // not to do is the worst possible ordering.
    if (RUNTIME === 'local' && !_devUnsafe) {
      console.error('\n❌ Refusing to start: runtime is "local", which gives containers ZERO isolation.');
      console.error('   Nothing was accepted and no buyer can pay into this fleet.');
      console.error('');
      console.error('   Fix one of these:');
      console.error('     • Install Docker and switch back:  j41-dispatcher config --runtime docker');
      console.error('     • Development only, accepting no isolation:  j41-dispatcher start --dev-unsafe');
      console.error('');
      console.error('   Local mode was most likely selected automatically by the installer because');
      console.error('   Docker was not found on this machine.');
      process.exit(1);
    }

    // Local mode warning timer
    if (RUNTIME === 'local' && _devUnsafe) {
      console.warn('');
      console.warn('  *** WARNING: Running in LOCAL mode — ZERO isolation. NOT safe for real jobs. ***');
      console.warn('');
      setInterval(() => {
        console.warn('  *** WARNING: Running in LOCAL mode — ZERO isolation. NOT safe for real jobs. ***');
      }, 30_000);
    }

    console.log(`Runtime: ${RUNTIME} mode`);
    console.log(`Registered agents: ${agents.length}`);
    console.log(`Max concurrent: ${MAX_AGENTS}${MAX_AGENTS_AUTO ? ' (auto)' : ' (owner override)'}`);
    if (MAX_AGENTS_AUTO) {
      console.log(capacityLine({
        totalMemBytes: os.totalmem(),
        cpuCount: os.cpus().length,
        maxAgents: MAX_AGENTS,
        perContainerMemBytes: SIZING_DEFAULTS.perContainerMemBytes,
        hostReserveBytes: Math.max(SIZING_DEFAULTS.minHostReserveBytes, Math.floor(os.totalmem() * SIZING_DEFAULTS.hostReserveFraction)),
      }));
    } else {
      console.log(`   Owner override via max_concurrent; hardware estimate for this box is ${_autoMax} agents.`);
      if (_autoMax < MAX_AGENTS) {
        console.log(`⚠️  max_concurrent=${MAX_AGENTS} exceeds the safe estimate (${_autoMax}); you may OOM or CPU-contend under load.`);
      }
    }
    console.log(`Job timeout: ${JOB_TIMEOUT_MS / 60000} min`);
    if (RUNTIME === 'docker') {
      console.log(`Keep containers: ${cfg.runtime.keep_containers ? 'ON (debug)' : 'OFF'}`);
    }
    console.log('Privacy: Deletion attestations\n');

    // H5: Validate executor URLs at startup (SSRF protection)
    validateExecutorUrl(cfg.executor.url, 'executor.url');
    validateExecutorUrl(cfg.executor.mcp_url, 'executor.mcp_url');
    validateExecutorUrl(cfg.llm.base_url, 'llm.base_url');

    // Check which agents are registered and ACTIVE on the platform
    const enforceFinalize = cfg.runtime.require_finalize;
    const skipStatusCheck = cfg.runtime.skip_status_check;
    const readyAgents = [];
    // Agents our own last shutdown turned off, and which this start restores.
    const _shutdownDeactivated = readShutdownDeactivated();
    const _reactivatedOnStart = [];
    let _lastSeenPlatformStatus = null;
    for (const agentId of agents) {
      const keys = loadAgentKeys(agentId);
      if (!keys?.identity) {
        console.log(`⚠️  ${agentId}: not registered on platform`);
        continue;
      }

      if (enforceFinalize && !isFinalizedReady(agentId)) {
        console.log(`⚠️  ${agentId}: finalize state not ready (set J41_REQUIRE_FINALIZE=0 to bypass)`);
        continue;
      }

      // Check platform status — only poll for active agents
      if (!skipStatusCheck) {
        try {
          const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
          const tmpAgent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
          await tmpAgent.authenticate();
          let skipThisAgent = false;
          try {
            const profile = await tmpAgent._client.getAgent(keys.iAddress || keys.identity);
            _lastSeenPlatformStatus = profile.status || 'unknown';
            // Already active and listed in the marker: nothing to restore, but it IS
            // dealt with. Leaving it in the marker would make a LATER deliberate
            // `deactivate` get silently undone by the next start.
            if (profile.status === 'active' && _shutdownDeactivated.includes(agentId)) {
              _reactivatedOnStart.push(agentId);
            }
            if (profile.status === 'inactive' || profile.status === 'disabled') {
              // Did WE turn this one off at our last shutdown? If so, starting up is
              // an explicit instruction to bring it back — restore it rather than
              // skipping it and then dying with "No agents registered", a message
              // that sends the operator to re-register and pay for on-chain writes.
              // `disabled` is never auto-restored: that is a platform-side decision.
              if (profile.status === 'inactive' && _shutdownDeactivated.includes(agentId)) {
                // Let it through the gate — do NOT activate here. Startup already
                // activates every ready agent (see "Setting agents active" below),
                // and the skip was the only thing keeping these out of that list.
                // Activating here too would broadcast a second identity tx for the
                // same agent against the same confirmed prevOutput, and the second
                // is rejected (`-25`) — which is precisely the double-spend class
                // this release exists to prevent.
                console.log(`↻  ${agentId} (${keys.identity}): deactivated by our last shutdown — restoring`);
                _reactivatedOnStart.push(agentId);
              } else {
                console.log(`⏸  ${agentId} (${keys.identity}): ${profile.status} on platform — skipping` +
                  (profile.status === 'inactive' ? ` (bring it back with: j41-dispatcher activate ${agentId})` : ''));
                skipThisAgent = true;
              }
            }
          } finally {
            // One exit point for the session, so no path leaks it and no path uses
            // it after stop() — the reactivate call above needs it still live.
            tmpAgent.stop();
          }
          if (skipThisAgent) continue;
        } catch (e) {
          // If we can't check, include the agent anyway (fail-open for polling)
          console.log(`⚠️  ${agentId}: could not check platform status (${e.message}) — including`);
        }
      }

      // platformStatus feeds /health (B1) and lets the activation loop skip a
      // redundant on-chain write (B5).
      readyAgents.push({ id: agentId, ...keys, platformStatus: _lastSeenPlatformStatus || 'unknown' });
      _lastSeenPlatformStatus = null;
    }
    
    // Clear the marker only once every agent in it has been dealt with, so a start
    // that dies partway through still restores the rest on the next attempt.
    if (_shutdownDeactivated.length) {
      if (_reactivatedOnStart.length) {
        console.log(`↻  Reactivated ${_reactivatedOnStart.length}/${_shutdownDeactivated.length} agent(s) deactivated by the last shutdown`);
      }
      const _unrestored = _shutdownDeactivated.filter(id => !_reactivatedOnStart.includes(id));
      if (_unrestored.length === 0) clearShutdownDeactivated();
      else writeShutdownDeactivated(_unrestored);
    }

    if (readyAgents.length === 0) {
      // Never send the operator to `register` for a fleet that is merely offline —
      // re-registering costs on-chain writes and does not fix an inactive agent.
      if (agents.length === 0) {
        console.error('\n❌ No agents registered. Run: j41-dispatcher register <agent> <name>');
      } else {
        console.error(`\n❌ No agents available to poll (${agents.length} registered, none active on the platform).`);
        console.error('   Bring them back online with: j41-dispatcher activate-all');
        console.error('   Do NOT re-register — that costs on-chain writes and will not fix an inactive agent.');
      }
      process.exit(1);
    }

    console.log(`Ready agents: ${readyAgents.length}\n`);
    
    // Start job polling loop
    console.log('→ Starting job listener...\n');
    
    const state = {
      agents: [...readyAgents], // all registered agents (never modified)
      active: new Map(), // jobId -> { agentId, container, startedAt, retries }
      reactivationQueue: loadReactivationQueue(), // paused jobs waiting to respawn (persisted)
      available: [...readyAgents], // pool of idle agents
      queue: [], // pending jobs
      seen: loadSeenJobs(), // completed/claimed jobs with timestamps (Map<jobId, timestamp>)
      retries: new Map(), // jobId -> retry count
      agentSessions: new Map(), // agentId -> { agent: J41Agent, authedAt: number }
      capabilities: new Map(), // agentId -> { workspace: bool, services: [] }
      disputePolicy: new Map(), // agentId -> policy object
      agentMarkup: new Map(), // agentId -> markup percentage
      pendingPayment: new Map(), // jobId -> payment info
      _lastSentStatus: new Map(), // jobId -> last status sent
      _lastExtensionCheck: new Map(), // ext.id -> { ts, jobId } (dedup of dispatched extension requests; pruned by jobId at job teardown)
      _pendingWorkspace: new Map(), // jobId -> workspace connect promise
      _agentErrors: new Map(), // agentId -> last error string (health document)
      _containerCrashes: new Map(), // agentId -> unexpected-exit count (health document)
      _inboxFailures: new Map(), // inbox itemId -> { attempts, deadLettered, lastError } — bounds accept retries (dead-letter)
      _resumeCursor: 0, // round-robin cursor for the poll-mode queued-resume sweep (Task 4)
      _proxyStarted: false, // true once the api-endpoint proxy is wired at boot; drives the heal-time "restart to activate proxy" notice
      _devUnsafe, // security: allows local mode when true
      llmHealth: new Map(), // agentId -> { ok, at } — preflight probe cache (ok-only, 30s TTL)
      _feeSweepPending: new Map(), // agentId -> { txid, at } — guards re-sweeping an unconfirmed sweep
      // agentId -> { feeSats, writes, sweepableSats, reason, at } — the last tank
      // observation, for /health. Free: checkFeeTanks already fetches every
      // agent's UTXOs each cycle, so this is a Map.set on data we threw away.
      _feeTankLast: new Map(),
      // Fee-tank sweep config. Precedence: CLI flag > config.toml/env > default.
      // Commander sets feeSweep=TRUE when --no-fee-sweep is absent (not
      // undefined), so the check must be `=== false` to mean "explicitly
      // disabled on the command line". Note this means the CLI can only ever
      // disable: there is no positive --fee-sweep flag, so config `enabled=false`
      // cannot be overridden back on from the command line.
      feeSweep: {
        enabled: options.feeSweep === false
          ? false
          : (cfg.fee_sweep?.enabled !== false),
        floorWrites: Math.max(1,
          parseInt(options.feeSweepFloor, 10)
          || cfg.fee_sweep?.floor_writes
          || DEFAULT_FLOOR_WRITES),
        intervalMs: Math.max(60000,
          (parseInt(options.feeSweepInterval, 10) * 60000)
          || cfg.fee_sweep?.interval_ms
          || 30 * 60000),
      },
    };

    // ── Startup sweep: remove stale _live/*.log for jobs not in active state ──
    // Guards against dispatcher crash leaving orphaned live-log files.
    // IMPORTANT: do NOT delete logs whose job is in active-jobs.json — those are
    // jobs that were running when the dispatcher crashed. handleCrashRecovery()
    // (called below) will issue refunds for them, and the operator may need the
    // logs to diagnose what went wrong.
    try {
      const liveDir = path.join(JOBS_DIR, '_live');
      if (fs.existsSync(liveDir)) {
        // Load persisted orphan IDs from the same source handleCrashRecovery uses.
        const orphanIds = new Set(Object.keys(loadActiveJobs()));
        for (const f of fs.readdirSync(liveDir)) {
          if (!f.endsWith('.log')) continue;
          const jobIdFromFile = f.slice(0, -4);
          if (!state.active.has(jobIdFromFile) && !orphanIds.has(jobIdFromFile)) {
            try { fs.rmSync(path.join(liveDir, f), { force: true }); } catch {}
          }
        }
      }
    } catch {}

    // ── Task 18: First-run security setup ──────────────────────
    const initMarker = path.join(os.homedir(), '.j41', 'dispatcher-security-initialized');
    if (!fs.existsSync(initMarker)) {
      console.log('');
      console.log('  ╔══════════════════════════════════════════════════╗');
      console.log('  ║  J41 Dispatcher Security Setup (first run)      ║');
      console.log('  ╚══════════════════════════════════════════════════╝');
      console.log('');
      if (secureSetup) {
        try {
          // Timeout security setup — don't block startup if sudo hangs
          await Promise.race([
            secureSetup.setup('dispatcher'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout (sudo may be required — run manually)')), 10000)),
          ]);
          console.log('  ✓ Security setup complete');
        } catch (e) {
          console.error(`  Security setup: ${e.message}`);
          console.error('  Run manually with sudo: sudo npx @junction41/secure-setup --dispatcher');
          // Continue — non-fatal
        }
      } else {
        console.warn('  @junction41/secure-setup not installed. Install it:');
        console.warn('    yarn add @junction41/secure-setup');
        console.warn('  Or run manually:');
        console.warn('    yarn dlx @junction41/secure-setup --dispatcher');
      }
      console.log('');
    }

    // ── Task 19: Startup security quick-check ──────────────────
    if (secureSetup) {
      try {
        const checkResult = await Promise.race([
          secureSetup.quickCheck('dispatcher'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);
        if (!checkResult.passed) {
          console.error('');
          console.error('  ══════════════════════════════════════════════════');
          console.error('  SECURITY CHECK FAILED — dispatcher will not start');
          console.error('  ══════════════════════════════════════════════════');
          for (const issue of (checkResult.checks || []).filter(c => c.status === 'fail')) {
            console.error(`  - ${issue.name}: ${issue.detail}`);
          }
          console.error('');
          console.error('  Fix: yarn dlx @junction41/secure-setup --dispatcher --fix');
          console.error('');
          if (!state._devUnsafe) {
            process.exit(1);
          }
          console.warn('  Continuing anyway (--dev-unsafe mode)...');
        } else {
          console.log(`  Security: ${checkResult.score}/10 (${checkResult.mode})`);
        }
      } catch (e) {
        console.warn(`  Security quick-check unavailable: ${e.message}`);
      }
    }

    // ── Load on-chain capabilities for VDXF policy enforcement ──
    console.log('→ Loading on-chain agent capabilities...\n');
    for (let i = 0; i < readyAgents.length; i++) {
      // Stagger 2s between agents to avoid rate limiting
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
      await loadAgentCapabilities(state, readyAgents[i]);
    }
    console.log('');

    // Self-healing retry: re-run full capability load for failed agents every 60s
    // until all agents succeed — no restart required after a boot-time chain-sync gap.
    const { stillFailed } = require('./capability-retry.js');
    const failedAgents = stillFailed(state, readyAgents);
    if (failedAgents.length > 0) {
      console.log(`  ⚠  ${failedAgents.length} agent(s) failed capability fetch — self-healing retry every 60s`);
      const retryTimer = setInterval(async () => {
        const pending = stillFailed(state, readyAgents);
        if (pending.length === 0) { clearInterval(retryTimer); return; }
        console.log(`[Capabilities] Retrying ${pending.length} agent(s)...`);
        for (const agentInfo of pending) {
          const ok = await loadAgentCapabilities(state, agentInfo);   // re-runs full load, clears _fetchFailed on success
          if (ok) {
            await loadAgentDisputePolicy(state, agentInfo);
            console.log(`[Capabilities] ✓ ${agentInfo.id} healed`);
            // The proxy is a boot-time snapshot (built once from state.capabilities);
            // reloading capabilities does NOT wire it. If an api-endpoint agent only
            // became visible after healing and no proxy was started at boot, the
            // operator must restart to serve it.
            const cap = state.capabilities.get(agentInfo.id);
            const nowApi = cap?.services?.some(s => s.serviceType === 'api-endpoint' || s.endpointUrl || s._isApiEndpoint);
            if (nowApi && !state._proxyStarted) {
              console.log(`[Capabilities] ⚠  ${agentInfo.id} exposes an api-endpoint — restart dispatcher to activate the proxy`);
            }
          }
        }
        if (stillFailed(state, readyAgents).length === 0) {
          console.log('[Capabilities] ✅ all agents healed');
          clearInterval(retryTimer);
        }
      }, 60 * 1000);
      retryTimer.unref();
    }

    // Cache dispute policy and markup per agent from VDXF
    for (const agentInfo of readyAgents) await loadAgentDisputePolicy(state, agentInfo);
    console.log('');

    // Guard all interval callbacks against unhandled rejections
    // (async setInterval callbacks that throw will crash Node v20+)
    const safeInterval = (fn, ms, label) => {
      setInterval(async () => {
        try {
          await fn();
        } catch (e) {
          console.error(`[${label}] Unhandled error (non-fatal): ${e.message}`);
        }
      }, ms);
    };

    // ── Mode selection: Webhook (push) vs Poll (pull) ──
    // B4: config.toml is documented as the source of truth, but `start` read only the
    // CLI flag — so `runtime.webhook_url` parsed and did nothing, while the dashboard
    // printed "Mode: webhook" from the same value and confirmed the operator's wrong
    // belief. The api-endpoint proxy is webhook-mode-only, so it silently never started.
    if (!options.webhookUrl && cfg.runtime && cfg.runtime.webhook_url) {
      options.webhookUrl = cfg.runtime.webhook_url;
      console.log(`  Webhook mode from config.toml: ${options.webhookUrl}`);
    }
    if (options.webhookUrl) {
      // ── WEBHOOK MODE ──
      const webhookPort = parseInt(options.webhookPort) || 9841;
      const webhookUrl = options.webhookUrl.replace(/\/+$/, '');
      const { generateWebhookSecret } = require('@junction41/sovagent-sdk/dist/webhook/verify.js');

      console.log(`Mode: WEBHOOK (event-driven)`);
      console.log(`  Base URL: ${webhookUrl}/webhook/<agent-id>`);
      console.log(`  Listen port: ${webhookPort}\n`);

      // Register webhook for each agent
      const agentWebhooks = new Map(); // agentId -> {secret, identity}
      for (const agentInfo of readyAgents) {
        try {
          const agent = await getAgentSession(state, agentInfo);
          const agentDir = path.join(AGENTS_DIR, agentInfo.id);
          const configPath = path.join(agentDir, 'webhook-config.json');

          // Load or generate secret
          let whConfig = {};
          try {
            if (fs.existsSync(configPath)) whConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          } catch {}
          if (!whConfig.secret) {
            whConfig.secret = generateWebhookSecret();
            fs.writeFileSync(configPath, JSON.stringify(whConfig, null, 2));
            fs.chmodSync(configPath, 0o600);
          }

          agentWebhooks.set(agentInfo.id, { secret: whConfig.secret, identity: agentInfo.identity });

          // Register if not already registered for this URL
          try {
            const agentWebhookUrl = `${webhookUrl}/webhook/${agentInfo.id}`;
            const existing = await agent.client.listWebhooks();
            const found = existing.find(w => w.url === agentWebhookUrl);
            if (!found) {
              await agent.client.registerWebhook(agentWebhookUrl, ['*'], whConfig.secret);
              console.log(`  ${agentInfo.id}: webhook registered`);
            } else {
              console.log(`  ${agentInfo.id}: webhook exists (${found.status})`);
            }
          } catch (e) {
            console.log(`  ${agentInfo.id}: webhook registration skipped (${e.message})`);
          }
        } catch (e) {
          console.error(`  ${agentInfo.id}: setup failed (${e.message})`);
        }
      }

      // Build proxy context for api-endpoint agents
      let proxyContext = null;
      const apiAgents = state.agents.filter(a => {
        const cap = state.capabilities.get(a.id);
        return cap?.services?.some(s => s.serviceType === 'api-endpoint' || s.endpointUrl || s._isApiEndpoint);
      });
      state._proxyStarted = apiAgents.length > 0; // the proxy is wired here, once, from this boot-time snapshot
      if (apiAgents.length > 0) {
        const { mintAccessEnvelope, verifyAccessRequest } = require('@junction41/sovagent-sdk/dist/crypto/envelope.js');
        const { validateEnvelope, canonicalBytes, verifyCanonicalSignatures, CanonicalError } = require('@junction41/sovagent-sdk/dist/crypto/canonical.js');
        const { mintApiKey } = require('./api-key-manager');

        const agentConfigs = new Map();
        for (const a of apiAgents) {
          const cap = state.capabilities.get(a.id);
          const apiSvc = cap?.services?.find(s => s.serviceType === 'api-endpoint' || s.endpointUrl || s._isApiEndpoint);
          if (apiSvc) {
            // Pull modelPricing/rateLimits/upstreamAuth from agent-config.json as fallback when
            // the platform service is missing them (old services registered before Bug 1 fix, or
            // operators using local-only config without platform registration).
            let localCfg = {};
            try {
              const localCfgPath = path.join(AGENTS_DIR, a.id, 'agent-config.json');
              if (fs.existsSync(localCfgPath)) localCfg = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'));
            } catch {}
            const modelPricing = (Array.isArray(apiSvc.modelPricing) && apiSvc.modelPricing.length)
              ? apiSvc.modelPricing
              : (localCfg.modelPricing || []);
            const rateLimits = (apiSvc.rateLimits && Object.keys(apiSvc.rateLimits).length)
              ? apiSvc.rateLimits
              : (localCfg.rateLimits || {});
            // T6 — the TUI's API-endpoint screen saves the credential into
            // agent-config.json as `upstreamAuth`, but this only ever read
            // `apiEndpointAuth`, so a key configured through the dashboard was NEVER
            // sent upstream: the proxy forwarded unauthenticated and every request
            // failed with no indication why. Accept both names; `apiEndpointAuth` is
            // what `api-setup --upstream-auth` writes.
            const upstreamAuth = apiSvc.upstreamAuth || localCfg.upstreamAuth || localCfg.apiEndpointAuth || '';
            agentConfigs.set(a.id, {
              endpointUrl: apiSvc.endpointUrl,
              modelPricing,
              rateLimits,
              identity: a.identity,
              iAddress: a.iAddress,
              payAddress: a.iAddress || a.address,
              upstreamAuth,
            });
            console.log(`  API Proxy: ${a.id} (${a.identity}) → ${apiSvc.endpointUrl} (${modelPricing.length} model(s) priced)`);
          }
        }

        proxyContext = {
          agentConfigs,
          onAccessRequest: async (wireBody) => {
            // Detect v2 canonical envelope vs v1 pipe-format AccessRequest.
            // Rule per spec §Dispatch: v2 iff body.envelope is object AND body.signatures is array.
            const isV2 = wireBody && typeof wireBody.envelope === 'object' && Array.isArray(wireBody.signatures);

            let accessRequest; // normalized to v1-like shape for downstream use
            let canonicalMessage = null; // bytes that were signed (v2 only)
            let signaturesV2 = null;

            if (isV2) {
              const { envelope, signatures } = wireBody;
              if (signatures.length === 0) throw new Error('signatures array must be non-empty');

              // Validate structure (steps 3–10 of backend verifier flow).
              try { validateEnvelope(envelope); }
              catch (e) {
                if (e instanceof CanonicalError) throw new Error(`Canonical validation failed: ${e.code} ${e.message}`);
                throw e;
              }

              if (envelope.action !== 'request-access') {
                throw new Error(`Wrong action for /j41/discovery/request-access: got "${envelope.action}"`);
              }

              canonicalMessage = canonicalBytes(envelope).toString('utf8');
              signaturesV2 = signatures;

              // Replay protection (2.1.13) happens AFTER signature verification below
              // (audit fix — recording the nonce before the signature is checked would
              // let an unauthenticated caller populate the nonce cache with junk).

              // Normalize to v1-like shape so downstream code (mintAccessEnvelope, meter, etc.) stays unchanged.
              accessRequest = {
                buyerVerusId: envelope.buyer.iaddress,
                sellerVerusId: envelope.seller.iaddress,
                ephemeralPubKey: envelope.payload.ephemeralPubKey,
                nonce: envelope.nonce,
                timestamp: Math.floor(Date.parse(envelope.issuedAt) / 1000),
                signature: signatures[0], // kept for compatibility; verify path uses signaturesV2 below
              };
              console.log(`[Discovery] Received v2 canonical envelope from ${accessRequest.buyerVerusId}`);
            } else {
              accessRequest = wireBody;
              console.log(`[Discovery] Received v1 pipe-format envelope from ${accessRequest.buyerVerusId}`);
            }

            // Find which agent the request is for
            const sellerAgent = state.agents.find(a =>
              a.iAddress === accessRequest.sellerVerusId || a.identity === accessRequest.sellerVerusId
            );
            if (!sellerAgent) throw new Error('Seller not found on this dispatcher');
            const cfg = agentConfigs.get(sellerAgent.id);
            if (!cfg) throw new Error('Seller has no api-endpoint service');

            // Verify buyer's signature locally. Fail-closed, no escape hatch, no trust delegation.
            //
            // v1 (pipe-format): R-address is embedded in the AccessRequest — verified directly
            //   via bitcoinjs-message.
            // v2 (canonical): i-address only. Resolved to primary R-addresses + multisig
            //   threshold via J41's public GET /v1/identity/:id/keys endpoint, then verified
            //   the same way as v1. minimumSignatures from the resolver is enforced.
            const sessionAgent = await getAgentSession(state, sellerAgent);
            const client = sessionAgent._client || sessionAgent.client;

            if (isV2) {
              const verified = await verifyCanonicalSignatures(wireBody.envelope, signaturesV2, client, J41_NETWORK);
              if (!verified) throw new Error('Buyer signature verification failed (v2)');
              console.log(`[Discovery] Buyer signature verified (v2): ${accessRequest.buyerVerusId}`);

              // Replay protection (2.1.13): reject any nonce we've already accepted
              // within its expiry window. Recorded ONLY now that the signature has
              // verified — an invalid-signature request never touches the nonce cache.
              const { checkNonceAfterVerify } = require('./nonce-cache.js');
              const expiresMs = Date.parse(wireBody.envelope.expiresAt);
              const replayCheck = checkNonceAfterVerify(verified, wireBody.envelope.nonce, expiresMs);
              if (!replayCheck.ok) {
                throw new Error(`v2 envelope rejected: ${replayCheck.reason} (nonce=${wireBody.envelope.nonce.slice(0, 8)}…)`);
              }
            } else {
              // Enforce freshness + single-use nonce (replay protection) in
              // addition to the signature. The nonce-cache check-and-records,
              // so a captured request cannot be re-submitted to re-mint a key.
              const { checkAndRecordNonce } = require('./nonce-cache');
              const verified = await verifyAccessRequest(accessRequest, client, J41_NETWORK, {
                isReplay: (nonce) => !checkAndRecordNonce(String(nonce), Date.now() + 10 * 60 * 1000).ok,
              });
              if (!verified) throw new Error('Buyer signature verification failed, stale, or replayed (v1)');
              console.log(`[Discovery] Buyer signature verified (v1): ${accessRequest.buyerVerusId}`);
            }

            // Mint API key
            const keyRecord = mintApiKey(sellerAgent.id, accessRequest.buyerVerusId);

            // Build encrypted envelope
            const payload = {
              apiKey: keyRecord.key,
              endpointUrl: cfg.endpointUrl,
              expiresAt: keyRecord.expiresAt,
              models: (cfg.modelPricing || []).map(p => p.model),
              modelPricing: cfg.modelPricing,
              rateLimits: cfg.rateLimits,
            };

            const envelope = mintAccessEnvelope(accessRequest, sellerAgent.wif, payload, J41_NETWORK);
            console.log(`[Discovery] Minted key for ${accessRequest.buyerVerusId} → ${sellerAgent.id}`);
            return envelope;
          },
          onDepositReport: async (report) => {
            const { reportDeposit } = require('./deposit-watcher');
            const sellerAgent = state.agents.find(a =>
              a.iAddress === report.sellerVerusId || a.identity === report.sellerVerusId
            );
            if (!sellerAgent) return { credited: false, message: 'Seller not found on this dispatcher', code: 'SELLER_NOT_FOUND' };
            const agent = await getAgentSession(state, sellerAgent);
            const payAddress = sellerAgent.iAddress || sellerAgent.address;
            return reportDeposit(sellerAgent.id, agent._client || agent.client, report, payAddress, J41_NETWORK);
          },
          onApiAccessRevoke: async ({ sellerVerusId, buyerVerusId, apiKey }) => {
            // Platform → dispatcher webhook called from DELETE /v1/me/api-access/:grantId
            // Mark all matching API keys as revoked locally so the proxy refuses further calls.
            const { listActiveKeys, revokeApiKey, findKeyOwner } = require('./api-key-manager');
            const sellerAgent = state.agents.find(a =>
              a.iAddress === sellerVerusId || a.identity === sellerVerusId
            );
            if (!sellerAgent) return { revoked: 0, reason: 'seller-not-found' };

            // Path A: caller specified an exact apiKey
            if (apiKey) {
              const owner = findKeyOwner(apiKey);
              if (!owner || owner.agentId !== sellerAgent.id) {
                return { revoked: 0, reason: 'key-not-found' };
              }
              const ok = revokeApiKey(sellerAgent.id, apiKey);
              return { revoked: ok ? 1 : 0, buyerVerusId: owner.record.buyerVerusId };
            }

            // Path B: caller specified a buyer — revoke ALL active keys this buyer holds for this seller
            if (buyerVerusId) {
              // Audit 2026-06-02 M-DISPATCHER-auth-3 (Family 3): normalize
              // both forms before comparing so e.g. 'buyer.agentplatform@'
              // vs 'buyer.agentplatform' match.
              const _normId = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/@+$/, '') : s);
              const wantNorm = _normId(buyerVerusId);
              const active = listActiveKeys(sellerAgent.id).filter(r => _normId(r.buyerVerusId) === wantNorm);
              let count = 0;
              for (const r of active) {
                if (revokeApiKey(sellerAgent.id, r.key)) count++;
              }
              return { revoked: count };
            }

            return { revoked: 0, reason: 'no-target' };
          },
          lookupAgentSecret: (sellerVerusId) => {
            const sellerAgent = state.agents.find(a =>
              a.iAddress === sellerVerusId || a.identity === sellerVerusId
            );
            if (!sellerAgent) return null;
            const w = agentWebhooks.get(sellerAgent.id);
            return w?.secret || null;
          },
        };

        // Set notify context per api-endpoint agent for J41 webhook notifications
        const { startDepositPoller, setNotifyContext } = require('./deposit-watcher');
        for (const a of apiAgents) {
          setNotifyContext(a.id, {
            sellerWif: a.wif,
            sellerVerusId: a.iAddress || a.identity,
            network: J41_NETWORK,
          });
        }

        // Start background deposit poller for pending confirmations
        startDepositPoller(state, getAgentSession);
        console.log(`  API Proxy: ${apiAgents.length} agent(s) with api-endpoint services`);
        console.log(`  Deposit watcher: polling every 60s for pending confirmations`);

        // Start upstream LLM health poller
        const { startHealthPoller } = require('./upstream-health');
        const cfgForHealth = loadDispatcherConfig();
        startHealthPoller(agentConfigs, undefined, cfgForHealth.proxy.circuit_threshold);
        console.log(`  Upstream health: polling every 60s (circuit threshold=${cfgForHealth.proxy.circuit_threshold})`);

        // Backend feature-flag check (soft-required: signing.canonical-v1).
        // Matches the rollout pattern from auth.rpc-unavailable-code. Warn at startup if backend
        // hasn't yet advertised canonical-v1; dispatcher still accepts v1 and continues.
        try {
          const { checkRequiredFeatures } = require('@junction41/sovagent-sdk/dist/backend-features.js');
          const operatorIaddress = apiAgents[0]?.iAddress || null;
          checkRequiredFeatures({
            apiUrl: J41_API_URL,
            softRequired: ['signing.canonical-v1'],
            operatorIAddress: operatorIaddress,
            dispatcherVersion: require('../package.json').version,
          }).then(r => {
            if (r.missing.softRequired.length === 0) {
              console.log(`  Backend features: ${r.missing.softRequired.length === 0 ? 'signing.canonical-v1 present ✓' : ''}`);
            }
            // emitFeatureWarning inside checkRequiredFeatures already logged to stderr for missing features
          }).catch(() => { /* non-fatal */ });
        } catch {
          // backend-features helper not present on older SDK — skip silently
        }
      }

      // Start webhook HTTP server (with proxy context if api-endpoint agents exist)
      const { startWebhookServer } = require('./webhook-server');
      startWebhookServer(webhookPort, agentWebhooks, async (agentId, payload) => {
        await handleWebhookEvent(state, agentId, payload);
      }, proxyContext);

      // Safety-net: lightweight inbox count check every 5 minutes
      safeInterval(async () => {
        for (const agentInfo of state.agents) {
          try {
            const agent = await getAgentSession(state, agentInfo);
            const count = await agent.client.getInboxCount();
            if (count.pending > 0) {
              console.log(`[Safety] ${agentInfo.id}: ${count.pending} pending inbox items — triggering poll`);
              await pollForJobs(state);
              break;
            }
          } catch {
            state.agentSessions.delete(agentInfo.id);
          }
        }
      }, 300000, 'SafetyPoll');

    } else {
      // ── POLL MODE (default — works behind NAT) ──
      // Warn if api-endpoint agents exist but no webhook URL
      const apiEndpointAgents = state.agents.filter(a => {
        const cap = state.capabilities.get(a.id);
        return cap?.services?.some(s => s.serviceType === 'api-endpoint' || s.endpointUrl || s._isApiEndpoint);
      });
      if (apiEndpointAgents.length > 0) {
        console.log(`⚠️  ${apiEndpointAgents.length} agent(s) have api-endpoint services but --webhook-url is not set.`);
        console.log(`   API proxy requires webhook mode. Add --webhook-url to enable.\n`);
      }
      console.log(`Mode: POLL (60s interval)\n`);

      // WebSocket listeners for instant notification (supplement to polling)
      let wsConnected = 0;
      for (const agentInfo of readyAgents) {
        try {
          const agent = await getAgentSession(state, agentInfo);
          const sessionToken = agent.client.getSessionToken();
          if (sessionToken) {
            const { ChatClient } = require('@junction41/sovagent-sdk/dist/chat/client.js');
            const chat = new ChatClient({ apiUrl: J41_API_URL, sessionToken });
            chat.onJobStatusChanged((event) => {
              if (event.status === 'requested' && !state.seen.has(event.jobId) && !state.active.has(event.jobId)) {
                console.log(`[WS] ${agentInfo.id}: job notification ${event.jobId} — triggering poll`);
                pollForJobs(state).catch(e => console.error(`[WS Poll] ${e.message}`));
              }
            });
            // Re-authenticate on reconnect failure (session may have expired)
            chat.onReconnectFailed = async (err) => {
              console.log(`[WS] ${agentInfo.id}: reconnect failed (${err.message}) — re-authenticating...`);
              try {
                const freshAgent = await getAgentSession(state, agentInfo);
                await freshAgent.authenticate();
                const freshToken = freshAgent.client.getSessionToken();
                if (freshToken) {
                  chat.config.sessionToken = freshToken;
                  await chat.connect();
                  console.log(`[WS] ${agentInfo.id}: reconnected with fresh session`);
                }
              } catch (reAuthErr) {
                console.error(`[WS] ${agentInfo.id}: re-auth failed: ${reAuthErr.message}`);
              }
            };
            chat.connect();
            wsConnected++;
          }
        } catch (e) {
          console.log(`[WS] ${agentInfo.id}: skipped (${e.message})`);
        }
      }
      if (wsConnected > 0) console.log(`WebSocket: ${wsConnected} agent(s) connected`);

      // Poll interval scales with agent count — 60s base, +500ms per agent stagger
      // 5 agents:  60s cycle (2.5s stagger total)
      // 50 agents: 60s cycle (25s stagger, fits within interval)
      // 100 agents: 90s cycle (50s stagger, needs wider interval)
      const agentCount = state.agents.length;
      // S1 — honour an explicit interval when the operator sets one. The auto value
      // is a floor-based heuristic; a large fleet or a slow platform legitimately
      // needs a longer cycle, and until now there was no way to ask for one.
      const _cfgPoll = Number(loadDispatcherConfig().poll?.interval_ms) || 0;
      const pollInterval = _cfgPoll > 0
        ? Math.max(1000, _cfgPoll)
        : Math.max(60000, agentCount * 1000);
      const reviewInterval = Math.max(60000, agentCount * 1000);
      console.log(`  Poll interval: ${Math.round(pollInterval / 1000)}s ` +
        `(${_cfgPoll > 0 ? 'configured' : `auto, ${agentCount} agent${agentCount !== 1 ? 's' : ''}`})`);

      // Poll for jobs
      safeInterval(() => pollForJobs(state), pollInterval, 'Poll');

      // Check for pending reviews
      safeInterval(() => checkPendingInbox(state), reviewInterval, 'Inbox');
    }

    // ── Fee-tank sweep ──────────────────────────────────────────────────────
    // Without this an agent's R-address only drains and it eventually goes
    // silent on-chain while holding unswept earnings (round 4, agent-6).
    // Enabled by default: the failure it prevents is silent, and the sweep moves
    // an agent's own funds between its own two addresses — never to a third party.
    if (state.feeSweep.enabled) {
      console.log(`  Fee-tank sweep: every ${state.feeSweep.intervalMs / 60000}min, floor ${state.feeSweep.floorWrites} writes`);
      safeInterval(() => checkFeeTanks(state), state.feeSweep.intervalMs, 'FeeTank');
      // Run once at startup rather than waiting out the first interval — a
      // dispatcher restarted BECAUSE an agent ran dry should not stay dry for
      // another 30 minutes.
      setTimeout(() => { checkFeeTanks(state).catch(e => console.error(`[FeeTank] ${e.message}`)); }, 15000);
    } else {
      console.log(`  Fee-tank sweep: DISABLED (${options.feeSweep === false ? '--no-fee-sweep' : 'config/env fee_sweep.enabled=false'}) — agents will not refill their own fee wallets`);
    }

    // ── Profile sync — detect on-chain changes and re-register with platform ──
    const _profileHashes = new Map(); // agentId -> last known contentmultimap hash
    safeInterval(async () => {
      const { decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
      for (const agentInfo of state.agents) {
        try {
          const agent = await getAgentSession(state, agentInfo);
          const idRaw = await agent.client.getIdentityRaw();
          const cmm = idRaw.data?.identity?.contentmultimap || idRaw.identity?.contentmultimap;
          if (!cmm) continue;

          // Hash the contentmultimap to detect changes
          const hash = require('crypto').createHash('sha256').update(JSON.stringify(cmm)).digest('hex').slice(0, 16);
          const prev = _profileHashes.get(agentInfo.id);

          if (!prev) {
            // First run — just record
            _profileHashes.set(agentInfo.id, hash);
            continue;
          }

          if (hash !== prev) {
            console.log(`[ProfileSync] ${agentInfo.id}: on-chain profile changed (${prev} → ${hash}) — re-syncing with platform`);
            _profileHashes.set(agentInfo.id, hash);

            // Decode and push to platform
            const decoded = decodeContentMultimap(cmm);
            const profile = decoded.profile || {};
            await agent.client.updateAgent(agentInfo.iAddress || agentInfo.identity, {
              displayName: profile.name,
              type: profile.type,
              description: profile.description,
              payAddress: profile.payAddress,
              profileCategory: profile.profile?.category,
              profileTags: profile.profile?.tags,
              models: profile.models,
              markup: profile.markup,
            });
            console.log(`[ProfileSync] ✅ ${agentInfo.id}: platform profile updated`);
            // Trigger backend re-index for VDXF changes
            try {
              await agent.client.refreshAgent(agentInfo.iAddress || agentInfo.identity);
              console.log(`[ProfileSync] ✅ ${agentInfo.id}: backend refreshed`);
            } catch (e) {
              console.log(`[ProfileSync] ⚠️  ${agentInfo.id}: backend refresh failed`);
            }
          }
        } catch (e) {
          // Non-fatal — will retry next cycle
          if (!e.message?.includes('not registered')) {
            state.agentSessions.delete(agentInfo.id);
          }
        }
      }
    }, 300000, 'ProfileSync'); // Every 5 minutes

    // ── Common intervals (both modes) ──
    // Start financial allowlist sweep timer
    startDispatcherSweep(state);

    // Check for completed jobs
    safeInterval(() => cleanupCompletedJobs(state), 10000, 'Cleanup');

    // Re-drive owed refunds that failed to send (RPC blip, momentary funds/UTXO
    // issue). Without this, drainPendingRefunds runs ONLY at boot, so a transient
    // send failure leaves a buyer's owed refund unpaid for the entire daemon
    // uptime. markJobRefunded/loadRefundedJobs make the drain idempotent, so a
    // periodic re-drive is safe and simply pays anything still pending.
    safeInterval(() => drainPendingRefunds(state), 5 * 60 * 1000, 'RefundDrain');
    safeInterval(() => sweepDisputesForRefund(state), 5 * 60 * 1000, 'DisputeSweep');

    // Status report every minute
    setInterval(() => {
      console.log(`[${new Date().toISOString()}] Active: ${state.active.size}/${MAX_AGENTS}, Queue: ${state.queue.length}, Available: ${state.available.length}, Seen: ${state.seen.size}`);
      pruneSeenJobs(state.seen);
    }, 60000);

    // Catch unhandled rejections
    process.on('unhandledRejection', (reason) => {
      console.error(`[Dispatcher] Unhandled rejection (non-fatal):`, reason?.message || reason);
    });

    // Drain any pending refunds left over from a previous crash mid-loop
    await drainPendingRefunds(state, { startup: true });
    sweepDisputesForRefund(state).catch(e =>
      console.error(`[DisputeSweep] Boot sweep failed (non-fatal): ${e.message}`)
    );

    // Log restored reactivation queue entries (loaded above in state initialisation)
    if (state.reactivationQueue.length) {
      console.log(`[Reactivation] Restored ${state.reactivationQueue.length} paused job(s) from disk`);
    }

    // Crash recovery — process orphaned jobs before accepting new ones
    await handleCrashRecovery(state);

    // Initial poll (catch-up for anything missed while offline)
    await pollForJobs(state);

    // ── Shutdown state, declared BEFORE the control plane ──
    //
    // The control server can request a shutdown the moment it binds, but the
    // graceful handler's state used to be declared ~80 lines further down. A
    // `ctl shutdown` arriving during startup therefore hit a TDZ on
    // `shuttingDown`, which as an unhandled async rejection left the process
    // running while claiming to stop. Declare first, and refuse to run the
    // graceful path until startup has actually finished.
    let shuttingDown = false;
    let readyForShutdown = false;

    // gracefulShutdown is async. If it rejects, the rejection is unhandled and
    // the process keeps running while having ANNOUNCED that it stopped. Every
    // caller must attach this.
    function onShutdownFailed(e) {
      console.error(`\n❌ Graceful shutdown failed: ${e && e.message}`);
      console.error('   Exiting anyway — a half-stopped dispatcher must never keep polling.');
      process.exit(1);
    }

    function requestShutdown(signal) {
      if (!readyForShutdown) {
        // Nothing is running yet worth draining, and the graceful path's state
        // is not initialised. Exit immediately rather than hang.
        console.error(`\n⚠️  Shutdown requested during startup (${signal}) — exiting immediately.`);
        process.exit(1);
      }
      return gracefulShutdown(signal).catch(onShutdownFailed);
    }

    // ── Start control plane ──
    const { startControlServer, stopControlServer } = require('./control');
    const controlServer = startControlServer(state, {
      onShutdown: (source) => requestShutdown(`control-plane (${source})`),
      getAgentSession,
    });

    // ── Start headless control API (WP-D1/D2) ──
    // Versioned, token-gated HTTP surface on its own port. The event bus is
    // attached to state so lifecycle points can emit without importing the
    // module; every call site guards with state.emitEvent?.() so a failed
    // API start never breaks job processing.
    const { startControlApi, stopControlApi } = require('./control-api');
    let controlApi = null;
    try {
      controlApi = startControlApi(state, { getAgentSession }, {
        port: cfg.runtime.control_api_port,
      });
      state.emitEvent = (type, data) => controlApi.bus.emit(type, data);
    } catch (e) {
      console.error(`[ControlAPI] Failed to start (continuing without it): ${e.message}`);
      state.emitEvent = () => {};
    }

    // ── Start egress proxy (sole outbound path for sandboxed job containers) ──
    state.gatewayIp = isolatedGatewayIp();
    state.egressProxy = new EgressProxyHost({
      host: state.gatewayIp,
      port: EGRESS_PROXY_PORT,
      log: (m) => console.log(`[egress] ${m}`),
      allowLocalUpstream: !!cfg.runtime.allow_local_upstream,
    });
    try {
      await state.egressProxy.start();
    } catch (err) {
      console.error(`[egress] FATAL: proxy failed to bind ${state.gatewayIp}:${EGRESS_PROXY_PORT} — refusing to start (jobs would have no egress path): ${err}`);
      process.exit(1);
    }
    console.log(`[egress] proxy listening on ${state.gatewayIp}:${EGRESS_PROXY_PORT}`);

    // ── Start VRSC/USD rate poller (WP-D4 P0-2) ──
    startVrscRatePoller();

    // ── Set agents active on-chain + platform ──
    // J41_NO_STATUS_TOGGLE=1: leave platform state alone at startup. Useful for
    // broker-validation runs where the operator pre-activates specific agents
    // and does not want the dispatcher to bulk-activate every "ready" agent
    // (which fires an on-chain identity-update tx per agent).
    if (process.env.J41_NO_STATUS_TOGGLE === '1') {
      console.log('\n→ Skipping auto-activate (J41_NO_STATUS_TOGGLE=1) — using current platform state');
    } else {
      // B5: the routine start/stop cycle used to broadcast 2N on-chain identity
      // transactions — N deactivations at shutdown, N activations at start — that the
      // operator never asked for and pays fees for (18 per restart on a 9-agent fleet).
      // The MARKETPLACE gates on platform status, so the on-chain write buys nothing
      // per restart; it only matters when the agent's standing genuinely changes, which
      // is what the explicit `activate` / `deactivate` commands are for (they still
      // write on-chain, unchanged). Opt back in with J41_STATUS_TOGGLE_ONCHAIN=1.
      // DEFAULT ON — reverted from 2.18.0's platform-only default after backend
      // explained the crack (2026-08-09 §1). Their hire gate reads `agents.status` and
      // nothing else, and their indexer OVERWRITES that column from on-chain
      // `data.status` on every re-index. So a platform-set `inactive` is best-effort:
      // while we are stopped with on-chain still `active`, any re-index — an identity
      // tx, a /refresh, or indexer catch-up after their daily downtime — reverts us to
      // active. A hire landing in that window sends the buyer's funds to a down agent,
      // and there is NO ESCROW. Saving 18 transactions is not worth that trade.
      // On-chain deactivate is the durable lever; opt out with J41_STATUS_TOGGLE_ONCHAIN=0.
      const _toggleOnChain = process.env.J41_STATUS_TOGGLE_ONCHAIN !== '0';
      console.log(`\n→ Setting agents active${_toggleOnChain ? '' : ' (PLATFORM ONLY — J41_STATUS_TOGGLE_ONCHAIN=0; a re-index can revert this and let a hire land on a stopped agent)'}...`);
      for (let i = 0; i < readyAgents.length; i++) {
        const agentInfo = readyAgents[i];
        // Stagger activation — 1s between agents to avoid rate limits at scale
        if (i > 0) await new Promise(r => setTimeout(r, 1000));
        try {
          const agent = await getAgentSession(state, agentInfo);
          if (agentInfo.platformStatus === 'active' && !_toggleOnChain) {
            agentInfo.platformStatus = 'active';
            console.log(`  ✅ ${agentInfo.id}: already active — no write needed`);
            state._agentErrors.delete(agentInfo.id);
            state.emitEvent?.('agent.online', { agentId: agentInfo.id, identity: agentInfo.identity });
            continue;
          }
          const result = await agent.activate({ onChain: _toggleOnChain });
          agentInfo.platformStatus = 'active';
          console.log(`  ✅ ${agentInfo.id}: active (on-chain txid: ${result.onChainTxid || 'skipped'})`);
          state._agentErrors.delete(agentInfo.id);
          state.emitEvent?.('agent.online', { agentId: agentInfo.id, identity: agentInfo.identity });
          // Trigger backend re-index so marketplace reflects active status immediately
          try {
            await agent.client.refreshAgent(agentInfo.iAddress || agentInfo.identity);
            console.log(`  ✅ ${agentInfo.id}: backend refreshed`);
          } catch (e) {
            console.log(`  ⚠️  ${agentInfo.id}: backend refresh failed (${e.message.slice(0, 60)})`);
          }
        } catch (e) {
          console.log(`  ⚠️  ${agentInfo.id}: activation failed (${e.message.slice(0, 60)})`);
          state._agentErrors.set(agentInfo.id, `activation failed: ${e.message.slice(0, 120)}`);
          state.emitEvent?.('agent.offline', { agentId: agentInfo.id, error: e.message.slice(0, 120) });
        }
      }
    }

    console.log('\n✅ Dispatcher running. Press Ctrl+C to stop.\n');

    // ── Graceful shutdown handler ──

    async function gracefulShutdown(signal) {
      if (shuttingDown) {
        // Second signal during drain — emergency exit
        console.log('\n⚠️  Second signal received — emergency exit. Remaining jobs will be refunded on next startup.');
        process.exit(1);
      }
      shuttingDown = true;

      // Watchdog: shutdown MUST terminate the process.
      //
      // Live failure 2026-08-04: `ctl shutdown` logged "✅ No active jobs.
      // Shutting down." and then kept polling for 27 more cycles with /health
      // still serving 200. A cleanup step below threw, and because this function
      // is async that became an unhandled rejection — process.exit was never
      // reached and the operator got a success message either way.
      //
      // That is worse than a crash: a "restart" that leaves the old process alive
      // gives you two dispatchers polling the same agents and writing identity
      // transactions against the same prevOutput — the double-spend class this
      // release exists to prevent. Never let shutdown be best-effort.
      // It is a STALL detector, not a deadline. The original 30s wall-clock version
      // could not tell a hung cleanup from healthy work, and it force-exited both:
      //   - a drain is designed to run up to drainTimeoutMs (2 x jobTimeoutMin =
      //     120 min by default), so every drain longer than 30s was killed, its
      //     containers orphaned, and the jobs refunded on next start even though
      //     they would have delivered; and
      //   - the deactivate loop below does ~3 network calls plus an on-chain
      //     transaction PER AGENT, serially, so a large fleet blew the budget
      //     mid-loop and left some agents active and some inactive. That is the
      //     mechanism behind "the restart lost my fleet, but only sometimes".
      // `unref()` never helped: it stops the timer holding the loop open, not from
      // firing.
      //
      // Now each step of shutdown kicks it. No progress for HARD_EXIT_MS means
      // genuinely stuck, which is what the 2026-08-04 fix was actually for.
      const HARD_EXIT_MS = 30000;
      let hardExit = null;
      const kickWatchdog = (label) => {
        if (hardExit) clearTimeout(hardExit);
        hardExit = setTimeout(() => {
          console.error(`\n⚠️  Graceful shutdown made no progress for ${HARD_EXIT_MS / 1000}s` +
            `${label ? ` (last step: ${label})` : ''} — forcing exit.`);
          process.exit(1);
        }, HARD_EXIT_MS);
        hardExit.unref?.(); // must not itself keep the loop alive if we exit cleanly
      };
      kickWatchdog('start');

      /** Run a cleanup step so one failure can never strand the process. */
      const safely = (label, fn) => {
        try { return fn(); }
        catch (e) { console.error(`   ⚠️  shutdown: ${label} failed (continuing): ${e && e.message}`); }
      };

      log.warn('Graceful shutdown starting (drain mode)', { signal, activeJobs: state.active.size });
      // Visible to every loop, not just this closure — see pollForJobs (B2).
      state.shuttingDown = true;

      // Tell every worker to wrap up. Without this the drain simply WAITED for
      // containers that had no reason to exit: a mid-job worker runs to its own
      // timeout, and a worker parked on an open dispute waits for a deadline days
      // away. Both handlers already existed in the container and neither was ever
      // triggered — `type: 'shutdown'` was sent from nowhere in this file.
      // It is graceful, not a kill: mid-job workers deliver current work first.
      for (const [jobId, activeInfo] of state.active.entries()) {
        try {
          sendToJobAgent(activeInfo, { type: 'shutdown', jobId });
        } catch (e) {
          console.log(`   ⚠️  ${jobId.substring(0, 8)}: could not signal shutdown (${e.message}) — the drain timeout still bounds it`);
        }
      }

      console.log(`\n🔄 Draining: ${state.active.size} active job(s). Waiting for containers to finish...`);
      console.log('   Press Ctrl+C again for emergency exit.\n');

      // 1. Set agents offline (stop accepting new jobs)
      // J41_NO_STATUS_TOGGLE=1: don't flip platform state on shutdown.
      const _skipStatusToggle = process.env.J41_NO_STATUS_TOGGLE === '1';
      const _deactivatedByShutdown = [];
      for (const agentInfo of state.agents) {
        if (_skipStatusToggle) {
          console.log(`   ⏭️  ${agentInfo.id}: skipping deactivate (J41_NO_STATUS_TOGGLE=1)`);
          continue;
        }
        // Each agent is ~3 network calls plus an on-chain tx; on a large fleet the
        // loop legitimately outlives any fixed budget. Report progress per agent so
        // the stall detector only fires if an agent genuinely wedges.
        kickWatchdog(`deactivate ${agentInfo.id}`);
        try {
          const agent = await getAgentSession(state, agentInfo);
          const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
          const verusId = agentInfo.iAddress || agentInfo.identity;
          const timestamp = Math.floor(Date.now() / 1000);
          const { randomUUID } = require('crypto');
          const nonce = randomUUID();
          const message = `J41-STATUS|Agent:${verusId}|Status:inactive|Ts:${timestamp}|Nonce:${nonce}`;
          const signature = signMessage(agentInfo.wif, message, J41_NETWORK);
          await agent.client.setAgentStatus(verusId, 'inactive', signature, timestamp, nonce);
          console.log(`   ✅ ${agentInfo.id}: status → inactive`);
          agentInfo.platformStatus = 'inactive';
          _deactivatedByShutdown.push(agentInfo.id);
          // L1 — persist after EVERY agent, not once after the loop. Each agent costs
          // ~4 serial platform calls whose SDK worst case is ~93s (30s timeout x 3
          // attempts + backoff), so a slow platform — the usual reason to restart —
          // can blow the stall budget mid-loop. The marker written only at the end
          // meant a watchdog exit recorded NOTHING, and the next start skipped every
          // agent it had just deactivated with "No agents available to poll".
          writeShutdownDeactivated(_deactivatedByShutdown);
          // Deactivating an agent is progress; the budget is for a WEDGED call, not
          // for the loop as a whole.
          kickWatchdog(`deactivated ${agentInfo.id}`);
          // On-chain deactivate is what actually keeps a hire off a stopped agent —
          // see the activation loop. Default on; J41_STATUS_TOGGLE_ONCHAIN=0 opts out.
          // Announce the outcome. This is the write B5 calls "the durable lever" —
          // the one that actually keeps a hire off a stopped agent — and it was
          // swallowed by a bare `catch {}` while the line above had already printed
          // "✅ status → inactive". A drained fee tank is the routine cause, and the
          // operator would never know the on-chain half did not happen. The
          // activation path reports its txid; this one reported nothing.
          if (process.env.J41_STATUS_TOGGLE_ONCHAIN !== '0') {
            try {
              await agent.setOnChainStatus('inactive');
              console.log(`   ✅ ${agentInfo.id}: on-chain status → inactive`);
            } catch (e) {
              console.error(`   ⚠️  ${agentInfo.id}: on-chain deactivate FAILED (${e.message}). ` +
                'The platform shows inactive, but a re-index can revert that from chain — ' +
                'a hire could still land on this stopped agent. Run: j41-dispatcher deactivate ' +
                `${agentInfo.id}`);
            }
          }
          // Trigger backend re-index so marketplace shows offline immediately
          try {
            await agent.client.refreshAgent(agentInfo.iAddress || agentInfo.identity);
          } catch {}
        } catch (e) {
          console.log(`   ⚠️  ${agentInfo.id}: failed to mark offline`);
        }
      }

      // Already persisted incrementally above (L1); this is the final confirmation
      // for the case where the loop completed normally.
      writeShutdownDeactivated(_deactivatedByShutdown);
      if (_deactivatedByShutdown.length) {
        console.log(`   📝 Recorded ${_deactivatedByShutdown.length} agent(s) to reactivate on next start`);
      }

      // 2. Calculate drain timeout
      const cfg = loadConfig();
      const drainTimeoutMs = (cfg.drainTimeoutMin || (cfg.jobTimeoutMin || 60) * 2) * 60 * 1000;

      // 3. If no active jobs, exit immediately
      if (state.active.size === 0) {
        console.log('\n✅ No active jobs. Shutting down.\n');
        safely('persistActiveJobs', () => persistActiveJobs(state.active));
        try { if (state.egressProxy) await state.egressProxy.stop(); } catch { /* best-effort */ }
        safely('stopControlServer', () => stopControlServer(controlServer));
        safely('stopControlApi', () => stopControlApi(controlApi));
        safely('stopVrscRatePoller', () => stopVrscRatePoller());
        clearTimeout(hardExit);
        process.exit(0);
      }

      // 4. Monitor until all containers finish or timeout
      const drainStart = Date.now();
      const drainInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - drainStart) / 1000);
        // A ticking drain IS progress. The drain has its own drainTimeoutMs bound
        // below; the stall detector must not pre-empt it.
        kickWatchdog(`draining ${state.active.size} job(s)`);
        console.log(`   Draining: ${state.active.size} job(s) remaining (${elapsed}s elapsed)`);

        if (state.active.size === 0) {
          clearInterval(drainInterval);
          console.log('\n✅ All jobs finished. Shutting down.\n');
          state.active.clear();
          safely('persistActiveJobs', () => persistActiveJobs(state.active));
          if (state.egressProxy) state.egressProxy.stop().catch(() => {});
          safely('stopControlServer', () => stopControlServer(controlServer));
          safely('stopControlApi', () => stopControlApi(controlApi));
          safely('stopVrscRatePoller', () => stopVrscRatePoller());
          clearTimeout(hardExit);
          process.exit(0);
        }

        if (Date.now() - drainStart > drainTimeoutMs) {
          clearInterval(drainInterval);
          console.log(`\n⚠️  Drain timeout (${Math.round(drainTimeoutMs / 60000)}min) — remaining ${state.active.size} job(s) will be refunded on next startup.`);
          // Don't clear active-jobs.json — crash recovery will handle refunds
          if (state.egressProxy) state.egressProxy.stop().catch(() => {});
          safely('stopControlServer', () => stopControlServer(controlServer));
          safely('stopControlApi', () => stopControlApi(controlApi));
          safely('stopVrscRatePoller', () => stopVrscRatePoller());
          clearTimeout(hardExit);
          process.exit(1);
        }
      }, 10000);
    }

    process.on('SIGINT', () => requestShutdown('SIGINT'));
    process.on('SIGTERM', () => requestShutdown('SIGTERM'));

    // Startup is complete — the graceful drain path is now safe to enter.
    // Logged because "Ready agents: N" appears much earlier (before the on-chain
    // activation pass), so it is NOT a reliable "safe to stop" marker. Anything
    // scripting a restart should wait for this line.
    readyForShutdown = true;
    // Gates the /health platform-status degrade: agents are activated in a staggered
    // loop above, and degrading before that finishes would alert on every restart.
    state.startupComplete = true;
    console.log('✅ Startup complete — graceful shutdown enabled.');
    // Zeroize the in-memory master key on any exit (after all WIF use is done).
    process.on('exit', () => { try { keystore.lock(); } catch (_) {} });

    // Keep alive
    await new Promise(() => {});
  });

program
  .command('encrypt-keys')
  .description('Encrypt all agent WIFs at rest with a passphrase (opt-in)')
  .action(async () => {
    if (fs.existsSync(MASTER_KEY_PATH)) {
      // A master key alone does not mean the pool is encrypted. encrypt-keys
      // writes the master key first and then re-encrypts each agent in turn, so
      // a crash mid-loop leaves stragglers in the clear. Refusing outright left
      // those WIFs plaintext forever while reporting the pool as protected.
      const stragglers = listPlaintextKeys(AGENTS_DIR);
      if (stragglers.length === 0) {
        console.error('❌ Keys are already encrypted (master-key.json exists). Use change-passphrase.');
        process.exit(1);
      }
      console.error(`⚠️  Encryption is INCOMPLETE: ${stragglers.length} key file(s) are still plaintext.`);
      console.error(`   (${stragglers.join(', ')}) — most likely a previous run was interrupted.`);
      console.error('   Unlocking with the EXISTING passphrase to finish the job.\n');
      let pass;
      try {
        pass = await keystore.resolvePassphrase({ promptFn: () => keystore.promptHidden('Existing passphrase: ') });
      } catch (e) {
        console.error(`❌ ${e.message}`);
        console.error('   Nothing changed; those key files are still plaintext.');
        process.exit(1);
      }
      if (!pass) {
        console.error('❌ No passphrase given. Nothing changed; those key files are still plaintext.');
        process.exit(1);
      }
      try { keystore.unlock(pass, MASTER_KEY_PATH); }
      catch (e) {
        console.error(`❌ ${e.message}`);
        console.error('   Nothing changed; those key files are still plaintext.');
        process.exit(1);
      }
      const done = encryptAllKeys(AGENTS_DIR);
      keystore.lock();
      console.log(`\n🔐 Completed encryption for ${done} remaining key file(s).`);
      return;
    }
    // Setting a NEW passphrase is deliberate, so it is not read from the
    // environment — but a non-TTY must fail loudly rather than silently leave
    // the keys in plaintext while reporting success.
    if (!process.stdin.isTTY) {
      console.error('❌ encrypt-keys needs a terminal to set a new passphrase — stdin is not a TTY.');
      console.error('   Nothing was encrypted; your keys are still plaintext at rest.');
      console.error('   Run it in an interactive shell. (J41_KEYS_PASSPHRASE is for UNLOCKING later, not for setting one here.)');
      process.exit(1);
    }
    const p1 = await keystore.promptHidden('New passphrase: ');
    const p2 = await keystore.promptHidden('Confirm passphrase: ');
    if (!p1 || p1 !== p2) { console.error('❌ Passphrases empty or do not match. Nothing was encrypted.'); process.exit(1); }
    keystore.initMasterKey(p1, MASTER_KEY_PATH); // creates file + unlocks
    const n = encryptAllKeys(AGENTS_DIR);
    keystore.lock();
    console.log(`\n🔐 Encrypted ${n} agent key file(s).`);
    console.log('   The daemon will prompt for this passphrase on `start`.');
    console.log('   Unattended: set J41_KEYS_PASSPHRASE or a systemd credential (j41-keys-passphrase).');
    console.log('   Note: at-rest encryption protects a stolen disk/backup, not a live-compromised host.');
  });

program
  .command('decrypt-keys')
  .description('Remove at-rest encryption; store WIFs as plaintext again')
  .action(async () => {
    if (!fs.existsSync(MASTER_KEY_PATH)) { console.error('❌ Keys are not encrypted.'); process.exit(1); }
    const pass = await keystore.resolvePassphrase({ promptFn: () => keystore.promptHidden('Passphrase: ') });
    try { keystore.unlock(pass, MASTER_KEY_PATH); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    const n = decryptAllKeys(AGENTS_DIR); // locks the keystore internally
    fs.rmSync(MASTER_KEY_PATH);
    console.log(`\n🔓 Decrypted ${n} agent key file(s). WIFs are now plaintext at rest (mode 0600 only).`);
  });

program
  .command('change-passphrase')
  .description('Change the at-rest encryption passphrase')
  .action(async () => {
    if (!fs.existsSync(MASTER_KEY_PATH)) { console.error('❌ Keys are not encrypted.'); process.exit(1); }
    if (!process.stdin.isTTY) {
      console.error('❌ change-passphrase needs a terminal — stdin is not a TTY. The passphrase was NOT changed.');
      process.exit(1);
    }
    const oldPass = await keystore.promptHidden('Current passphrase: ');
    const n1 = await keystore.promptHidden('New passphrase: ');
    const n2 = await keystore.promptHidden('Confirm new passphrase: ');
    if (!n1 || n1 !== n2) { console.error('❌ New passphrases empty or do not match. The passphrase was NOT changed.'); process.exit(1); }
    try { keystore.changePassphrase(oldPass, n1, MASTER_KEY_PATH); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    console.log('\n🔐 Passphrase changed.');
  });

// Status command
program
  .command('status')
  .description('Show dispatcher status')
  .action(async () => {
    ensureDirs();
    
    const agents = listRegisteredAgents();
    const activeJobs = await getActiveJobs();
    const queueFiles = fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR) : [];
    
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Dispatcher Status                    ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    const finalized = agents.filter(a => isFinalizedReady(a)).length;
    console.log(`Agents: ${agents.length} registered`);
    console.log(`Finalized ready: ${finalized}/${agents.length}`);
    console.log(`Active jobs: ${activeJobs.length}/${MAX_AGENTS}`);
    console.log(`Queue: ${queueFiles.length} pending\n`);
    
    if (activeJobs.length > 0) {
      console.log('Active containers:');
      activeJobs.forEach(job => {
        const name = job.Names[0].replace('/j41-job-', '');
        console.log(`  ${name}: ${job.Status}`);
      });
      console.log('');
    }
    
    // Show privacy attestation stats
    let attestationCount = 0;
    activeJobs.forEach(job => {
      const jobDir = path.join(JOBS_DIR, job.Names[0].replace('/j41-job-', ''));
      if (fs.existsSync(path.join(jobDir, 'creation-attestation.json'))) {
        attestationCount++;
      }
    });
    
    if (attestationCount > 0) {
      console.log(`Privacy attestations: ${attestationCount} active\n`);
    }
  });

// Logs command — view job logs
program
  .command('logs [job-id]')
  .description('View job logs. Without job-id, lists recent jobs. With job-id (or prefix), tails the log.')
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .option('--agent <agent-id>', 'Filter jobs by agent')
  .action(async (jobId, options) => {
    ensureDirs();

    if (!jobId) {
      // List all jobs with logs: _live/*.log (active) + _logs/*.log (archived).
      const liveDir = path.join(JOBS_DIR, '_live');
      const liveFiles = fs.existsSync(liveDir)
        ? fs.readdirSync(liveDir).filter(f => f.endsWith('.log') && (() => { try { return !fs.lstatSync(path.join(liveDir, f)).isSymbolicLink(); } catch { return false; } })())
        : [];
      const archiveDir = path.join(JOBS_DIR, '_logs');
      const archived = fs.existsSync(archiveDir)
        ? fs.readdirSync(archiveDir).filter(f => f.endsWith('.log') && (() => { try { return !fs.lstatSync(path.join(archiveDir, f)).isSymbolicLink(); } catch { return false; } })())
        : [];

      if (liveFiles.length === 0 && archived.length === 0) {
        console.log('No job logs found. Logs are written when the dispatcher runs jobs.');
        return;
      }

      if (liveFiles.length) {
        console.log(`\n── Active Job Logs (${liveFiles.length}) ──\n`);
        for (const f of liveFiles.slice(-20)) {
          const p = path.join(liveDir, f);
          const jobLogId = f.slice(0, -4);
          const stat = fs.statSync(p);
          const bf = path.join(JOBS_DIR, jobLogId, 'buyer.txt');
          // NOFOLLOW guard: refuse symlinks atomically (no TOCTOU vs lstat+read).
          const buyerRaw = fs.existsSync(bf) ? readJobFileNoFollow(bf) : null;
          const buyer = buyerRaw !== null ? buyerRaw.trim() : '?';
          const size = (stat.size / 1024).toFixed(1);
          console.log(`  ${jobLogId.substring(0, 8)}  ${stat.mtime.toISOString().substring(0, 19)}  ${size}KB  buyer: ${buyer}  [active]`);
        }
      }

      // Drop archives that already appear in the live section to avoid
      // listing the same job id twice.
      const liveIdSet = new Set(liveFiles.map(f => f.slice(0, -4)));
      const archivedOnly = archived.filter(f => !liveIdSet.has(f.slice(0, -4)));

      if (archivedOnly.length) {
        console.log(`\n── Archived Logs (${archivedOnly.length}) ──\n`);
        for (const f of archivedOnly.slice(-20)) {
          const p = path.join(archiveDir, f);
          const stat = fs.statSync(p);
          const size = (stat.size / 1024).toFixed(1);
          console.log(`  ${f.slice(0, -4).substring(0, 8)}  ${stat.mtime.toISOString().substring(0, 19)}  ${size}KB  [archived]`);
        }
      }

      console.log(`\n  View: j41-dispatcher logs <job-id-prefix>`);
      console.log(`  Tail: j41-dispatcher logs <job-id-prefix> -f`);
      return;
    }

    // Resolve the job prefix to a _live/<id>.log (active) or _logs/<id>.log (archived).
    const archiveDir = path.join(JOBS_DIR, '_logs');
    const liveDir = path.join(JOBS_DIR, '_live');
    const liveIds = fs.existsSync(liveDir)
      ? fs.readdirSync(liveDir).filter(f => f.endsWith('.log') && f.slice(0, -4).startsWith(jobId)).map(f => f.slice(0, -4))
      : [];
    const archivedIds = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir).filter(f => f.endsWith('.log') && f.slice(0, -4).startsWith(jobId)).map(f => f.slice(0, -4))
      : [];
    const matchIds = Array.from(new Set([...liveIds, ...archivedIds]));

    if (matchIds.length === 0) {
      console.error(`❌ No job found matching "${jobId}"`);
      process.exit(1);
    }
    if (matchIds.length > 1) {
      console.error(`❌ Ambiguous prefix "${jobId}" — matches ${matchIds.length} jobs:`);
      matchIds.forEach(m => console.error(`   ${m}`));
      process.exit(1);
    }

    const fullJobId = matchIds[0];
    const liveCandidatePath = liveLogPath(JOBS_DIR, fullJobId);
    // lstat-guard: skip if the resolved path is a symlink
    const liveExists = fs.existsSync(liveCandidatePath) && !fs.lstatSync(liveCandidatePath).isSymbolicLink();
    const logPath = liveExists ? liveCandidatePath : archiveLogPath(JOBS_DIR, fullJobId);

    if (!fs.existsSync(logPath) || fs.lstatSync(logPath).isSymbolicLink()) {
      console.error(`❌ No log file for job ${fullJobId}`);
      process.exit(1);
    }

    if (options.follow) {
      // tail -f mode
      console.log(`── Following ${fullJobId.substring(0, 8)} (Ctrl+C to stop) ──\n`);
      // NOFOLLOW guard: refuse symlinks that may have been planted between the
      // lstat check above and this read (TOCTOU).
      const content = readJobFileNoFollow(logPath) ?? '';
      const lines = content.split('\n');
      const n = parseInt(options.lines) || 50;
      const tail = lines.slice(-n);
      process.stdout.write(tail.join('\n'));

      // Watch for changes
      let pos = fs.statSync(logPath).size;
      fs.watchFile(logPath, { interval: 500 }, () => {
        const newSize = fs.statSync(logPath).size;
        if (newSize > pos) {
          let fd;
          try { fd = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
          catch { return; } // symlink appeared mid-watch — skip
          try {
            const buf = Buffer.alloc(newSize - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            process.stdout.write(buf.toString());
            pos = newSize;
          } finally { fs.closeSync(fd); }
        }
      });

      // Keep alive
      await new Promise(() => {});
    } else {
      // Static output
      // NOFOLLOW guard: refuse symlinks (TOCTOU between lstat check and read).
      const content = readJobFileNoFollow(logPath) ?? '';
      const lines = content.split('\n');
      const n = parseInt(options.lines) || 50;
      const tail = lines.slice(-n);
      console.log(`── ${fullJobId.substring(0, 8)} (last ${Math.min(n, lines.length)} lines) ──\n`);
      console.log(tail.join('\n'));
    }
  });

// Privacy command — show attestation status
program
  .command('privacy')
  .description('Show privacy attestation status')
  .action(async () => {
    ensureDirs();
    
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Privacy Attestation Status           ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    const completedJobs = fs.readdirSync(JOBS_DIR).filter(id => {
      return fs.existsSync(path.join(JOBS_DIR, id, 'deletion-attestation.json'));
    });
    
    console.log(`Jobs with privacy attestations: ${completedJobs.length}\n`);
    
    if (completedJobs.length > 0) {
      console.log('Recent attestations:');
      completedJobs.slice(-5).forEach(jobId => {
        const attPath = path.join(JOBS_DIR, jobId, 'deletion-attestation.json');
        const raw = readJobFileNoFollow(attPath);
        if (raw === null) return; // skip symlinked attestation (possible exfil attempt)
        const att = JSON.parse(raw);
        console.log(`  ${jobId.substring(0, 8)}...`);
        console.log(`    Created:  ${att.createdAt}`);
        console.log(`    Deleted:  ${att.destroyedAt}`);
        console.log(`    Duration: ${(new Date(att.destroyedAt) - new Date(att.createdAt)) / 1000}s`);
        console.log(`    Method:   ${att.deletionMethod}`);
        console.log(`    Verified: ${att.signature ? '✅ Signed' : '❌ No signature'}`);
        console.log('');
      });
    }
    
    console.log(`Privacy Features (runtime: ${RUNTIME}):`);
    if (RUNTIME === 'docker') {
      console.log('  ✅ Ephemeral containers (auto-remove)');
      console.log('  ✅ Isolated job data (per-container volumes)');
      console.log('  ✅ Resource limits (2GB RAM, 1 CPU)');
      console.log('  ✅ Security hardening (read-only rootfs, no capabilities)');
    } else {
      console.log('  ⚠️  Local process mode (no container isolation)');
      console.log('  ✅ Ephemeral job data (cleaned up after completion)');
    }
    console.log('  ✅ Creation attestation (signed proof of start)');
    console.log('  ✅ Deletion attestation (signed proof of destruction)');
    console.log('  ✅ Timeout protection (auto-kill after 1 hour)');
    console.log('');
  });

// Get or create a cached authenticated J41Agent session.
// Sessions are reused for 10 minutes before re-authenticating.
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min

// ── VRSC/USD rate poller (WP-D4 P0-2) ──
// Polls the platform's rate endpoint and caches the latest value. buildContainerEnv
// stamps it into job containers as the DEFAULT rate source (operator config still
// overrides). Fails closed: until a real rate is fetched, _polledVrscRate stays
// null and the container falls back to fallback_token_budget — never an unlimited
// budget. Dormant-but-safe until the backend ships GET /v1/pricing/vrsc-rate.
let _polledVrscRate = null; // { usdPerVrsc, at: ms-epoch }
let _vrscRateWarned = false;
let _vrscRateTimer = null;

function startVrscRatePoller() {
  // Operator-set rate wins outright — don't bother polling.
  if (cfg.budget.vrsc_usd_rate > 0) {
    console.log('[Rate] Using operator-set vrsc_usd_rate from config; rate poller idle.');
    return;
  }
  const { J41Client } = require('@junction41/sovagent-sdk/dist/index.js');
  const client = new J41Client({ apiUrl: J41_API_URL });

  async function poll() {
    let nextMs = 300000; // default 5m between polls
    try {
      const rate = await client.getVrscUsdRate();
      if (rate && Number.isFinite(rate.usdPerVrsc) && rate.usdPerVrsc > 0) {
        _polledVrscRate = { usdPerVrsc: rate.usdPerVrsc, at: Date.now() };
        _vrscRateWarned = false;
        if (rate.ttlSeconds && rate.ttlSeconds > 0) nextMs = rate.ttlSeconds * 1000;
        console.log(`[Rate] VRSC/USD = ${rate.usdPerVrsc} (source: ${rate.source || 'platform'})`);
      } else if (!_vrscRateWarned) {
        // The call succeeded but returned an empty/malformed rate (e.g. an
        // envelope-shape mismatch). Don't fail SILENTLY — warn once, then stay
        // fail-closed on fallback budgets. This is the signal that would have
        // surfaced the 2026-06-12 {data} envelope bug immediately.
        console.log(`[Rate] Endpoint returned an empty/malformed rate — staying on fallback budgets. ` +
          `Got: ${JSON.stringify(rate)?.slice(0, 80)}`);
        _vrscRateWarned = true;
      }
    } catch (e) {
      // Endpoint missing (404) or unreachable → stay fail-closed, warn once.
      if (!_vrscRateWarned) {
        console.log(`[Rate] No platform VRSC rate yet (${e.message?.slice(0, 60)}). ` +
          'Jobs use fallback budgets until a rate is available or [budget].vrsc_usd_rate is set.');
        _vrscRateWarned = true;
      }
    }
    _vrscRateTimer = setTimeout(poll, nextMs);
  }
  poll();
}

function stopVrscRatePoller() {
  if (_vrscRateTimer) { clearTimeout(_vrscRateTimer); _vrscRateTimer = null; }
}

async function getAgentSession(state, agentInfo) {
  if (process.env.NODE_ENV === 'test' && state._testAgentSession) return state._testAgentSession;
  const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
  const baseUrl = J41_API_URL;

  const cached = state.agentSessions.get(agentInfo.id);
  if (cached && (Date.now() - cached.authedAt) < SESSION_TTL_MS) {
    return cached.agent;
  }

  // Back off when the platform is down. A failed session is never cached, so
  // without this every caller re-authenticates every cycle: the 2026-07-31
  // outage produced ~908 failures and ended with the
  // platform returning 429, which outlasted the 503 that started it. See
  // src/auth-backoff.js.
  if (!state._authBackoff) state._authBackoff = new Map();
  const now = Date.now();
  const gate = shouldAttemptAuth(state._authBackoff.get(agentInfo.id), now);
  if (!gate.attempt) {
    const e = new Error(
      `auth backoff: platform unavailable for ${agentInfo.id} (${gate.failures} failure(s)), retrying in ${Math.ceil(gate.waitMs / 1000)}s`
    );
    e.code = 'AUTH_BACKOFF';
    throw e;
  }

  const agent = new J41Agent({
    apiUrl: baseUrl,
    wif: agentInfo.wif,
    identityName: agentInfo.identity,
    iAddress: agentInfo.iAddress,
  });
  try {
    await agent.authenticate();
  } catch (e) {
    const rec = recordAuthFailure(state._authBackoff.get(agentInfo.id), e, { now });
    state._authBackoff.set(agentInfo.id, rec);
    if (rec.retryable) {
      // Log the transition only, not every cycle — an outage should not also
      // produce a log flood.
      if (rec.failures === 1 || rec.failures % 10 === 0) {
        console.warn(`[Auth] ${agentInfo.id}: platform unavailable (${e.message}). Backing off ${Math.round((rec.delayMs || 0) / 1000)}s (failure ${rec.failures}).`);
      }
    } else {
      // Not something waiting fixes — say so every time.
      console.error(`[Auth] ${agentInfo.id}: authentication rejected (${e.message}). This will not resolve on its own.`);
    }
    throw e;
  }
  clearAuthFailure(state._authBackoff, agentInfo.id);
  state.agentSessions.set(agentInfo.id, { agent, authedAt: Date.now() });
  return agent;
}

/**
 * Load on-chain capabilities for one agent into state.capabilities.
 * Returns true on success, false on error (stores _fetchFailed sentinel).
 * Called at boot and by the self-healing retry (Task 2).
 */
async function loadAgentCapabilities(state, agentInfo) {
  try {
    const agent = await getAgentSession(state, agentInfo);

    // Fetch on-chain VDXF data
    const idRaw = await agent.client.getIdentityRaw();
    const id = idRaw.data?.identity || idRaw.identity;

    // Also fetch platform services (has serviceType, endpointUrl, modelPricing)
    let platformServices = [];
    try {
      const svcResp = await agent.client.getAgentServices(agentInfo.iAddress || agentInfo.identity);
      platformServices = svcResp.data || svcResp || [];
    } catch {}

    const { decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');

    if (id?.contentmultimap) {
      const decoded = decodeContentMultimap(id.contentmultimap);
      const hasWorkspace = !!decoded.profile?.workspaceCapability;
      const { VDXF_KEYS: VK, PARENT_KEYS: PK } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
      const hasWorkspaceKey = !!id.contentmultimap[VK.workspace.capability] || !!id.contentmultimap[PK.workspace];
      // Merge on-chain services with platform services
      const services = platformServices.length > 0 ? platformServices : (decoded.services || []);
      // Check if this agent has api-endpoint capabilities.
      // Sources: (a) on-chain profile type, (b) on-chain networkEndpoints, (c) any platform
      // service declared as serviceType='api-endpoint', (d) agent-config.json apiEndpointUrl.
      // Any of these flips the agent into proxy mode — operators who fix one but not the
      // others shouldn't silently lose proxy support.
      const agentType = decoded.profile?.type;
      const hasEndpoints = decoded.profile?.network?.endpoints?.length > 0;
      const hasApiService = services.some(s => s.serviceType === 'api-endpoint');
      let hasConfiguredUpstream = false;
      try {
        const agentCfgPath = path.join(AGENTS_DIR, agentInfo.id, 'agent-config.json');
        if (fs.existsSync(agentCfgPath)) {
          const agentCfg = JSON.parse(fs.readFileSync(agentCfgPath, 'utf8'));
          hasConfiguredUpstream = !!(agentCfg.apiEndpointUrl || agentCfg.endpointUrl);
        }
      } catch {}
      if (agentType === 'api-provider' || hasEndpoints || hasApiService || hasConfiguredUpstream) {
        const { VDXF_KEYS: VK2 } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
        const endpointsRaw = id.contentmultimap[VK2.agent.networkEndpoints];
        let onChainEndpoint = '';
        if (endpointsRaw) {
          try {
            const epEntry = Array.isArray(endpointsRaw) ? endpointsRaw[0] : endpointsRaw;
            const dd = epEntry['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
            const endpoints = JSON.parse(dd?.objectdata?.message || '[]');
            onChainEndpoint = endpoints[0] || '';
          } catch {}
        }
        // Also check agent-config.json for apiEndpointUrl (upstream LLM backend)
        let agentConfigEndpoint = '';
        try {
          const agentCfgPath = path.join(AGENTS_DIR, agentInfo.id, 'agent-config.json');
          if (fs.existsSync(agentCfgPath)) {
            const agentCfg = JSON.parse(fs.readFileSync(agentCfgPath, 'utf8'));
            agentConfigEndpoint = agentCfg.apiEndpointUrl || agentCfg.endpointUrl || '';
          }
        } catch {}

        for (const svc of services) {
          svc._isApiEndpoint = true;
          // Priority: agent-config > on-chain VDXF networkEndpoints
          if (!svc.endpointUrl) svc.endpointUrl = agentConfigEndpoint || onChainEndpoint;
          if (!svc.modelPricing && decoded.services?.length > 0) {
            const onChainSvc = decoded.services.find(s => s.modelPricing);
            if (onChainSvc) svc.modelPricing = onChainSvc.modelPricing;
          }
        }
      }
      state.capabilities.set(agentInfo.id, {
        workspace: hasWorkspace,
        hasWorkspaceKey,
        services,
        profile: decoded.profile,
      });
      const apiCount = services.filter(s => s.serviceType === 'api-endpoint' || s.endpointUrl || s._isApiEndpoint).length;
      console.log(`  ${agentInfo.id}: workspace=${hasWorkspace || hasWorkspaceKey}, services=${services.length}${apiCount > 0 ? `, api-endpoints=${apiCount}` : ''}`);
    } else {
      state.capabilities.set(agentInfo.id, { workspace: false, services: platformServices, profile: null });
      console.log(`  ${agentInfo.id}: no VDXF data on-chain, ${platformServices.length} platform services`);
    }
    return true;
  } catch (e) {
    state.capabilities.set(agentInfo.id, { workspace: false, services: [], profile: null, _fetchFailed: true });
    console.log(`  ${agentInfo.id}: capability fetch failed (${e.message})`);
    return false;
  }
}

/**
 * Load dispute policy and markup for one agent into state.disputePolicy / state.agentMarkup.
 * Never throws (logs on error). Called at boot and after a capability heal (Task 2).
 */
async function loadAgentDisputePolicy(state, agentInfo) {
  try {
    const agent = await getAgentSession(state, agentInfo);
    const identity = await agent.client.getMyIdentity();
    if (identity?.contentmultimap) {
      const { decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
      const decoded = decodeContentMultimap(identity.contentmultimap);
      if (decoded.disputePolicy) {
        state.disputePolicy.set(agentInfo.id, decoded.disputePolicy);
        console.log(`  ✅ ${agentInfo.id}: dispute policy loaded (default=${decoded.disputePolicy.defaultAction})`);
      } else {
        console.log(`  ⚠️  ${agentInfo.id}: no dispute policy on-chain — disputes will log only`);
      }
      if (decoded.profile?.markup != null) {
        state.agentMarkup.set(agentInfo.id, decoded.profile.markup);
      }
    }
  } catch (e) {
    console.log(`  ⚠️  ${agentInfo.id}: failed to load dispute policy (${e.message.slice(0, 60)})`);
  }
}

/**
 * Send an IPC-style message to a running job-agent.
 * Local mode: process.send()  |  Docker mode: writes to /tmp/ipc-msg.json inside container
 */
function sendToJobAgent(activeInfo, msg) {
  if (activeInfo.process?.send) {
    activeInfo.process.send(msg);
    return true;
  }
  if (activeInfo.container) {
    try {
      const msgJson = JSON.stringify(msg);
      require('child_process').execFileSync('docker', [
        'exec', '-i', activeInfo.container.id,
        'sh', '-c', 'cat >> /tmp/ipc-msg.jsonl'
      ], { input: msgJson + '\n', timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  }
  return false;
}

// Free a paused job's container and move it to the reactivation queue. The
// container is torn down (0 CPU/RAM/slot); the job waits in the queue until the
// buyer resumes (respawn) or pause_ttl expires (refund). Reuses the job's
// stored info from state.active.
async function moveJobToReactivationQueue(state, jobId, { persist = true } = {}) {
  const info = state.active.get(jobId);
  if (!info) return false;
  info._pausing = true; // guard: prevents cleanupCompletedJobs from respawning mid-teardown (I3)

  // C1: enqueue + persist BEFORE touching the container so a crash at any point
  // leaves the job safely recoverable (never active-only, never silently dropped).
  rq.enqueue(state.reactivationQueue, {
    job: info.job || { id: jobId },
    agentId: info.agentId,
    pausedAt: Date.now(),
    pauseTtlMin: info.pauseTtlMin || 60,
    readyToRespawn: false,
  });
  if (persist) persistReactivationQueue(state.reactivationQueue);

  // Remove from active map and flush so active-jobs.json no longer lists it.
  state.active.delete(jobId);
  if (persist) persistActiveJobs(state.active);

  // Best-effort teardown LAST — failure here cannot lose the job.
  if (info.container) {
    await info.container.stop().catch(() => {});
    await info.container.remove().catch(() => {});
  } else if (info.process) {
    try { info.process.kill(); } catch {}
  }

  console.log(`[Reactivation] Job ${jobId.substring(0, 8)} paused → container freed, queued (active=${state.active.size}/${MAX_AGENTS}, queued=${state.reactivationQueue.length})`);
  return true;
}

// Respawn buyer-resumed jobs from the reactivation queue, oldest-first, until
// capacity is reached. deps.maxAgents defaults to the module MAX_AGENTS; injected
// in tests. Reuses the normal startJob spawn path — the fresh worker reloads all
// state from the platform (stateless respawn).
async function respawnReadyResumes(state, deps = {}) {
  const startJobFn = deps.startJob || startJob;
  const findAgent = deps.findAgentById || ((id) => state.agents.find(a => a.id === id));
  const cap = deps.maxAgents != null ? deps.maxAgents : MAX_AGENTS;
  let count = 0;
  while (state.active.size < cap) {
    if (!hasMemoryHeadroom(os.freemem(), SIZING_DEFAULTS.perContainerMemBytes)) {
      console.warn('[Reactivation] Low free memory — deferring respawn');
      break;
    }
    const entry = rq.nextReady(state.reactivationQueue);
    if (!entry) break;
    rq.removeJob(state.reactivationQueue, entry.job.id);
    try {
      await startJobFn(state, entry.job, findAgent(entry.agentId));
      // C2: startJobContainer swallows its own boot failures (catch ~6241 logs +
      // returns agent to pool, does NOT rethrow). Verify placement explicitly so a
      // silently-dropped boot doesn't lose the paid job.
      if (!state.active.has(entry.job.id)) {
        console.error(`[Reactivation] Respawn did not place ${entry.job.id.substring(0, 8)} — re-queuing`);
        rq.enqueue(state.reactivationQueue, entry);
        persistReactivationQueue(state.reactivationQueue);
        break; // stop this pass; retry next cycle
      }
      count++;
    } catch (e) {
      console.error(`[Reactivation] Respawn failed for ${entry.job.id.substring(0, 8)}: ${e.message} — re-queuing`);
      rq.enqueue(state.reactivationQueue, entry); // leave ready for the next pass
      persistReactivationQueue(state.reactivationQueue);
      break; // avoid a tight failure loop
    }
  }
  if (count > 0) persistReactivationQueue(state.reactivationQueue);
  return count;
}

const DISPUTE_RESPAWN_TTL_MIN = 720; // 12 h window for operator to respond

// Route a job.disputed observation to a worker. Live jobs get the dispute
// forwarded to their running container; torn-down jobs are respawned via the
// same reactivation-queue machinery job.resumed uses. Never silently drops:
// an unresolvable seller emits dispute.unresolved_agent. The respawned worker
// fetches the authoritative deadline itself (getDispute) — we plumb no deadline.
async function queueDisputedJobForRespawn(state, jobId, opts = {}) {
  const send = opts.sendToJobAgent || sendToJobAgent;
  const respawn = opts.respawnReadyResumes || respawnReadyResumes;
  const persist = opts.persistReactivationQueue || persistReactivationQueue;

  const active = state.active.get(jobId);
  if (active) {
    send(active, { type: 'dispute.filed', data: { jobId, reason: opts.reason } });
    return { forwarded: true };
  }

  // Torn-down: resolve the job + its local agent, then respawn.
  const findAgent = (id) => state.agents.find(a => a.id === id);
  const agentInfo = opts.agentId ? findAgent(opts.agentId) : null;
  let job;
  try {
    if (opts.getJob) job = await opts.getJob(jobId);
    else if (agentInfo) {
      const session = await getAgentSession(state, agentInfo);
      job = await session.client.getJob(jobId);
    }
  } catch (e) {
    console.error(`[Dispute] Could not fetch torn-down job ${jobId.substring(0, 8)}: ${e.message}`);
  }
  if (!job) {
    state.emitEvent?.('dispute.unresolved_agent', { jobId, reason: 'job-fetch-failed' });
    return { unresolved: true };
  }

  const sellerId = job.sellerVerusId || job.seller || job.agentVerusId;
  // Prefer the already-verified agentInfo when it matches the seller OR when no
  // seller field is present (platform field-name mismatch → sellerId undefined).
  // Fall back to a full agents-list search so a provided agentInfo that
  // demonstrably mismatches a known seller is never blindly trusted.
  const match = (agentInfo && (agentInfo.iAddress === sellerId || agentInfo.identity === sellerId || !sellerId))
    ? agentInfo
    : state.agents.find(a => a.iAddress === sellerId || a.identity === sellerId);
  if (!match) {
    console.error(`[Dispute] job ${jobId.substring(0, 8)} seller ${sellerId} not a local agent — cannot respawn`);
    state.emitEvent?.('dispute.unresolved_agent', { jobId, seller: sellerId });
    return { unresolved: true };
  }

  rq.enqueue(state.reactivationQueue, {
    job, agentId: match.id, pausedAt: Date.now(),
    pauseTtlMin: DISPUTE_RESPAWN_TTL_MIN, readyToRespawn: true, dispute: true,
  });
  persist(state.reactivationQueue);
  console.log(`[Dispute] job ${jobId.substring(0, 8)} torn-down → queued + respawning for ${match.id}`);
  await respawn(state);
  return { respawned: true };
}


// ── Rework cycle accounting (durable, seller-side) ───────────────────────────
//
// `maxReworkCycles` was enforced only by a counter inside the worker container,
// which resets to zero whenever that worker is replaced — and a dispute can now
// outlive its worker, so respawns between cycles are normal. Round 8 did not hit
// that (the worker survived), but the limit was unenforceable by construction.
//
// The seller counting its OWN rework offers is durable across restarts and worker
// deaths, and it is the number that actually matters: what we have promised.
const REWORK_CYCLES_PATH = path.join(DISPATCHER_DIR, 'rework-cycles.json');

function readReworkCycles(file = REWORK_CYCLES_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {}; // absent is normal; corrupt must not block a dispute response
  }
}

function reworkCyclesFor(jobId, store = readReworkCycles()) {
  const n = store[jobId];
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function bumpReworkCycle(jobId, file = REWORK_CYCLES_PATH) {
  try {
    const store = readReworkCycles(file);
    store[jobId] = reworkCyclesFor(jobId, store) + 1;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic — a torn count must not reset the limit
    return store[jobId];
  } catch (e) {
    // Never fail a dispute response because bookkeeping failed; log loudly instead,
    // because an uncounted cycle is how the limit silently stops being enforced.
    console.error(`  ⚠️  Could not record rework cycle for ${jobId.substring(0, 8)}: ${e.message}`);
    return null;
  }
}

/** Read the agent's on-chain dispute policy via its live session. Null if absent. */
async function readDisputePolicyFor(agent) {
  const identity = await agent.client.getMyIdentity();
  if (!identity?.contentmultimap) return null;
  const { decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
  const decoded = decodeContentMultimap(identity.contentmultimap);
  return decoded?.disputePolicy || null;
}

// ── Shutdown/start fleet-state handoff ───────────────────────────────────────
//
// `gracefulShutdown` sets every agent inactive on the platform and on-chain so a
// stopped dispatcher stops taking work. `start` then SKIPPED inactive agents and
// exited with "No agents registered. Run: j41-dispatcher register <agent> <name>"
// — pointing the operator at re-registration, which is both wrong and pays for
// on-chain writes. A routine stop/start lost the whole fleet.
//
// We record exactly which agents WE turned off, so start restores those and only
// those. An agent the operator deactivated deliberately stays deactivated — that
// distinction is the whole reason this is a marker file and not "activate anything
// that looks inactive".
const SHUTDOWN_DEACTIVATED_FILE = path.join(DISPATCHER_DIR, 'shutdown-deactivated.json');

function readShutdownDeactivated(file = SHUTDOWN_DEACTIVATED_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.agents) ? parsed.agents.filter(a => typeof a === 'string') : [];
  } catch {
    return []; // absent is the normal case (clean prior start); corrupt = restore nothing
  }
}

function writeShutdownDeactivated(agentIds, file = SHUTDOWN_DEACTIVATED_FILE) {
  try {
    if (!agentIds.length) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), agents: agentIds }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic: a torn file must not strand the fleet
  } catch (e) {
    console.error(`   ⚠️  Could not record deactivated agents (${e.message}) — next start may need: j41-dispatcher activate-all`);
  }
}

function clearShutdownDeactivated(file = SHUTDOWN_DEACTIVATED_FILE) {
  try { fs.unlinkSync(file); } catch {}
}

/**
 * Statuses that mean "this job still needs us, and may have no worker alive".
 * A disputed job's deadline is days away; a worker's post-delivery hold is hours
 * at most. The gap between those two numbers is where jobs used to vanish.
 */
const ORPHANABLE_STATUSES = ['disputed', 'rework'];

// Never respawn more than this many workers in a single sweep. On first run after
// an upgrade the platform can return every historical dispute at once; spawning a
// container for each would be a thundering herd against the host and the platform.
// Anything deferred is REPORTED, never silently dropped, and the next sweep picks
// it up.
const MAX_RECONCILE_RESPAWNS_PER_SWEEP = 3;

// How many times we will respawn a worker for the SAME job before giving up and
// asking for a human.
//
// A job can be stuck in `disputed` with nothing that can ever resolve it — round 7
// produced exactly that: the platform's second-dispute insert failed on a unique
// constraint (Postgres 23505) but the status was moved to `disputed` anyway, so the
// job reports disputed while no dispute record exists. Our sweep respawned a worker
// for it 14 times. Retrying forever is not resilience; it is a silent resource leak
// that gets worse with fleet size. Give up loudly instead.
const MAX_RECONCILE_ATTEMPTS_PER_JOB = 3;

/**
 * Should a worker be respawned for this orphaned job?
 *
 * Pure so it can be tested without a fleet. The rule is "only when a worker could
 * actually DO something":
 *
 *  - `rework`  — there is work to redo. Always actionable.
 *  - `disputed` — only while the dispute is unanswered AND its deadline is still in
 *    the future. A dispute the seller already answered needs no worker (the refund
 *    or rework path owns it), and a lapsed one cannot be influenced by anything we
 *    spawn — the platform has already decided it on default terms.
 *
 * Without this, the first sweep after an upgrade respawns every historical dispute
 * on the account, including months-old ones already sitting in the operator's
 * refund-approval queue.
 */
function shouldReconcileJob(job, nowMs = Date.now(), opts = {}) {
  if (!job || !job.id) return { respawn: false, why: 'malformed' };

  // Already the operator's problem. A job with a refund ledger entry is awaiting a
  // human approval step, and no worker we spawn can advance it. This check is the
  // load-bearing one in practice: `getMyJobs` list items do NOT carry a nested
  // `dispute` object, so the deadline/answered rules below see `{}` and default
  // every historical dispute to "open and unanswered". Live, that meant 24 months-
  // old outage jobs all classified as actionable, respawning 3 per poll cycle
  // forever.
  const ledger = opts.refundLedger;
  if (ledger && Object.prototype.hasOwnProperty.call(ledger, job.id)) {
    return { respawn: false, why: 'queued for operator refund approval' };
  }

  if (job.status === 'rework') return { respawn: true, why: 'rework pending' };
  if (job.status !== 'disputed') return { respawn: false, why: `status ${job.status}` };

  const d = job.dispute || {};
  const action = d.action || d.status || 'pending';
  if (action !== 'pending') return { respawn: false, why: `dispute already answered (${action})` };

  // No deadline reported → treat as open. Refusing to act on missing data would
  // silently recreate the very hole this sweep exists to close.
  const deadline = d.deadline_at || d.deadlineAt || null;
  if (deadline) {
    const t = Date.parse(deadline);
    if (Number.isFinite(t) && t <= nowMs) {
      return { respawn: false, why: `dispute deadline passed (${deadline})` };
    }
  }
  return { respawn: true, why: 'dispute open and unanswered' };
}

/**
 * Own the jobs nobody else does.
 *
 * Before this, a job in `disputed` or `rework` whose container had exited was
 * invisible to the entire dispatcher: `pollForJobs` keeps only
 * requested/accepted/in_progress, and the post-delivery transition check iterates
 * `state.active`, which by definition no longer holds it. No surface, no respawn,
 * no operator alert — the dispute deadline simply lapsed on the platform's default
 * terms. Every test we ran passed only because the buyer happened to act inside the
 * worker's ~90-minute window.
 *
 * This reconciler closes that hole from the durable side. It is deliberately
 * idempotent and cheap: it respawns only for jobs with no live worker, and
 * `queueDisputedJobForRespawn` forwards rather than respawns when one exists.
 *
 * Scale notes: one `getMyJobs` call per agent per status, and the respawn path is
 * already gated on memory headroom (`hasMemoryHeadroom`) and the reactivation
 * queue, so a fleet with many simultaneous disputes degrades by queueing rather
 * than by exhausting the host. Failures are per-agent and never abort the sweep.
 */
async function reconcileOrphanedDisputes(state, opts = {}) {
  const queueFn = opts.queueDisputedJobForRespawn || queueDisputedJobForRespawn;
  const getSession = opts.getAgentSession || getAgentSession;
  // Read once per sweep, not per job — the ledger is small but this runs every poll.
  if (!state._reconcileAttempts) state._reconcileAttempts = new Map();
  const attempts = state._reconcileAttempts;
  let refundLedger = opts.refundLedger;
  if (refundLedger === undefined) {
    try { refundLedger = loadPendingRefunds(); } catch { refundLedger = {}; }
  }
  const summary = { checked: 0, orphaned: 0, respawned: 0, skipped: 0, deferred: 0, stuck: 0, failed: 0 };

  for (const agentInfo of state.agents || []) {
    let jobs = [];
    try {
      const session = await getSession(state, agentInfo);
      for (const status of ORPHANABLE_STATUSES) {
        const res = await session.client.getMyJobs({ status, role: 'seller' });
        for (const j of (res?.data || [])) if (j?.id) jobs.push(j);
      }
    } catch (e) {
      // One unreachable agent must not stop the fleet-wide sweep.
      summary.failed++;
      console.error(`[DisputeReconcile] ${agentInfo.id}: could not list disputed/rework jobs: ${e.message}`);
      continue;
    }

    for (const job of jobs) {
      summary.checked++;
      if (state.active.has(job.id)) continue;      // a live worker already owns it
      if (state.queue.some(j => j.id === job.id)) continue;
      if (rq.has(state.reactivationQueue, job.id)) continue; // already waiting for capacity

      const verdict = shouldReconcileJob(job, Date.now(), { refundLedger });
      if (!verdict.respawn) {
        summary.skipped++;
        continue;
      }

      // Give up loudly on a job we cannot make progress on, rather than respawning
      // a container for it every poll cycle forever.
      const priorAttempts = attempts.get(job.id) || 0;
      if (priorAttempts >= MAX_RECONCILE_ATTEMPTS_PER_JOB) {
        summary.stuck++;
        if (priorAttempts === MAX_RECONCILE_ATTEMPTS_PER_JOB) {
          attempts.set(job.id, priorAttempts + 1); // log once, then stay quiet
          console.error(`[DisputeReconcile] ⛔ GIVING UP on ${job.id.substring(0, 8)} (${agentInfo.id}) after ` +
            `${MAX_RECONCILE_ATTEMPTS_PER_JOB} respawns — it reports "${job.status}" but never progresses. ` +
            'This usually means the platform has a job whose dispute record is missing or unresolvable. ' +
            `Inspect with: j41-dispatcher ctl jobs   —   it will not be retried until the dispatcher restarts.`);
          state.emitEvent?.('dispute.reconcile_gave_up', { jobId: job.id, agentId: agentInfo.id, status: job.status, attempts: priorAttempts });
        }
        continue;
      }

      summary.orphaned++;
      if (summary.respawned >= MAX_RECONCILE_RESPAWNS_PER_SWEEP) {
        summary.deferred++;
        continue; // reported below — never a silent truncation
      }
      console.log(`[DisputeReconcile] job ${job.id.substring(0, 8)} is ${job.status} with no worker (${verdict.why}) — respawning for ${agentInfo.id}`);
      try {
        // Same entry point the webhook uses, so there is exactly one respawn path.
        // Once the worker is up, the post-delivery transition check sees the job in
        // `state.active` and sends the `rework`/`disputed` message — and because a
        // fresh container clears `_lastSentStatus`, that message is not suppressed
        // as "already sent" to the process that died.
        attempts.set(job.id, priorAttempts + 1);
        const r = await queueFn(state, job.id, { agentId: agentInfo.id, reason: job.dispute?.reason });
        if (r?.respawned || r?.forwarded) summary.respawned++;
      } catch (e) {
        summary.failed++;
        console.error(`[DisputeReconcile] respawn failed for ${job.id.substring(0, 8)}: ${e.message}`);
      }
    }
  }

  if (summary.orphaned > 0 || summary.failed > 0 || summary.stuck > 0) {
    console.log(`[DisputeReconcile] checked=${summary.checked} actionable=${summary.orphaned} ` +
      `respawned=${summary.respawned} deferred=${summary.deferred} not-actionable=${summary.skipped} ` +
      `stuck=${summary.stuck} failed=${summary.failed}`);
  }
  if (summary.deferred > 0) {
    console.log(`[DisputeReconcile] ${summary.deferred} actionable job(s) deferred past this sweep's cap of ` +
      `${MAX_RECONCILE_RESPAWNS_PER_SWEEP} — they will be picked up on the next poll cycle`);
  }
  state._disputeReconcile = summary;
  return summary;
}

const REACTIVATION_MEM_MARGIN_BYTES = 512 * 1024 * 1024; // 0.5 GB host margin

function hasMemoryHeadroom(freeBytes, perContainerBytes, marginBytes = REACTIVATION_MEM_MARGIN_BYTES) {
  return freeBytes >= perContainerBytes + marginBytes;
}

// Remove queued jobs whose pause_ttl has elapsed. The platform owns the
// cancel+refund path (via pause_ttl webhook/poll), so the dispatcher only
// needs to drop the local queue entry and log. deps.now() is injectable for tests.
async function sweepExpiredQueue(state, deps = {}) {
  const now = (deps.now || Date.now)();
  const expired = rq.findExpired(state.reactivationQueue, now);
  for (const e of expired) {
    if (e.dispute) {
      console.error(`[TTL] dispute job ${e.job.id.substring(0, 8)} dropped from respawn queue after ${e.pauseTtlMin} min — surfacing failed; operator must respond via the dispute CLI`);
      state.emitEvent?.('dispute.surfacing_expired', { jobId: e.job.id });
    } else {
      console.log(`[TTL] queued job ${e.job.id.substring(0, 8)} exceeded pause_ttl (${e.pauseTtlMin}min) — removed from reactivation queue (platform auto-cancels/refunds)`);
    }
    rq.removeJob(state.reactivationQueue, e.job.id);
  }
  if (expired.length) persistReactivationQueue(state.reactivationQueue);
  return expired.map(e => e.job.id);
}

/**
 * VDXF Policy Check: verify agent has workspace.capability on-chain before
 * forwarding workspace_ready to job-agent. Returns true if allowed.
 *
 * Jailbox park gate: the "agent works inside the buyer's environment" sandbox
 * (legacy "workspace", aka jailbox) is PARKED by default in favour of
 * deliver-and-review (see JAILBOX_PARKED.md and docs spec
 * 2026-06-12-vdxf-v2-schema-design §3b). When cfg.jailbox.enabled is false the
 * dispatcher refuses to start a jailbox session — clear log, no workspace_ready
 * forwarded. Set JAILBOX_ENABLED=1 to re-enable; behaviour is then unchanged.
 * This gates ONLY the session entry — the audit-log / attestation machinery is
 * left fully intact.
 */
function checkWorkspaceCapability(state, agentId) {
  if (!cfg.jailbox.enabled) {
    console.warn(`[JAILBOX] ${agentId}: jailbox parked — set JAILBOX_ENABLED=true to re-enable (refusing to start jailbox session)`);
    return false;
  }
  const caps = state.capabilities.get(agentId);
  if (!caps) {
    console.warn(`[VDXF-POLICY] ${agentId}: no capability data — blocking workspace`);
    return false;
  }
  // Check decoded profile OR raw contentmultimap for workspace parent key
  if (!caps.workspace && !caps.hasWorkspaceKey) {
    console.warn(`[VDXF-POLICY] ${agentId}: workspace.capability NOT set on-chain — blocking workspace`);
    return false;
  }
  return true;
}

// ── Pending-refunds durability helpers ──────────────────────────────────────

/** Load the durable pending-refunds ledger (object keyed by jobId).
 *  @param {string} [filePath] — override path for tests (defaults to PENDING_REFUNDS_PATH). */
function loadPendingRefunds(filePath = PENDING_REFUNDS_PATH) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // corrupted — treat as empty
  }
  return {};
}

/** Persist the pending-refunds ledger atomically (mode 0600).
 *  Writes to a temp file then renames — rename is atomic on POSIX, so a crash
 *  mid-write can never leave a corrupted ledger that loadPendingRefunds() would
 *  silently treat as empty (which would permanently drop owed refunds).
 *  @param {string} [filePath] — override path for tests (defaults to PENDING_REFUNDS_PATH). */
function savePendingRefunds(obj, filePath = PENDING_REFUNDS_PATH) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[refund] Could not save pending-refunds ledger: ${e.message}`);
  }
}

/** Load the durable set of jobIds already refunded (de-dup guard). */
function loadRefundedJobs() {
  try {
    if (fs.existsSync(REFUNDED_JOBS_PATH)) {
      const arr = JSON.parse(fs.readFileSync(REFUNDED_JOBS_PATH, 'utf8'));
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    // corrupted — treat as empty (fail toward not-yet-refunded; pending ledger
    // still gates against unbounded retries since each entry is removed on send)
  }
  return new Set();
}

/** Durably mark a jobId as refunded so it is never paid twice (atomic). */
function markJobRefunded(jobId) {
  try {
    const refunded = loadRefundedJobs();
    refunded.add(jobId);
    fs.mkdirSync(DISPATCHER_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${REFUNDED_JOBS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...refunded], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, REFUNDED_JOBS_PATH);
  } catch (e) {
    console.error(`[refund] Could not mark job ${jobId.substring(0, 8)} refunded: ${e.message}`);
  }
}

/**
 * Crash-safe intent marker for an irreversible refund send.
 *
 * `sendCurrency` broadcasts to an EXTERNAL buyer address; `markJobRefunded`
 * records that it happened. A SIGKILL between the two leaves the job
 * `status: 'approved'` in pending-refunds.json, so the next startup drain sends
 * a SECOND confirmed refund to that address. This is the only place in the
 * codebase where money can leave the fleet twice.
 *
 * The old comment called the window "a hardware fault between two syscalls".
 * It is not: any crash, OOM kill, deploy or Ctrl-C in that gap does it, and
 * fault-injection reaches it trivially.
 *
 * So we write intent BEFORE broadcasting and clear it after the send is
 * recorded. A marker found at drain time means "we may already have paid this,
 * and we cannot tell" — which must never be resolved by paying again. The drain
 * refuses and asks for on-chain verification instead. Fail closed: the cost of
 * a false positive is one manual check; the cost of a false negative is a
 * duplicate payment we cannot claw back.
 */
function refundInflightPath(jobId) {
  return path.join(REFUND_LOCKS_DIR, `${String(jobId).replace(/[^A-Za-z0-9._-]/g, '_')}.inflight.json`);
}

function markRefundInflight(jobId, meta) {
  fs.mkdirSync(REFUND_LOCKS_DIR, { recursive: true, mode: 0o700 });
  const p = refundInflightPath(jobId);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ jobId, at: Date.now(), pid: process.pid, ...meta }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p); // atomic: the marker either exists complete or not at all
}

/**
 * Record that the send FAILED after the marker was written.
 *
 * The marker still stands — we genuinely cannot tell whether the broadcast left
 * — but it now carries why, so the operator sees a diagnosable blocked refund
 * rather than a bare "in flight" for a process that never died.
 */
function noteRefundInflightFailure(jobId, message) {
  const cur = readRefundInflight(jobId);
  if (!cur) return;
  try {
    markRefundInflight(jobId, { ...cur, failedAt: Date.now(), lastError: String(message || '').slice(0, 300) });
  } catch { /* best effort — the marker itself is what matters */ }
}

function clearRefundInflight(jobId) {
  try { fs.unlinkSync(refundInflightPath(jobId)); } catch { /* already gone */ }
}

function readRefundInflight(jobId) {
  let p;
  try { p = refundInflightPath(jobId); } catch { return null; }
  if (!fs.existsSync(p)) return null; // genuinely no marker
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // ENOENT here means it vanished between existsSync and readFileSync — a
    // genuine absence, and blocking on it would be a spurious over-block.
    if (e && e.code === 'ENOENT') return null;
    // Otherwise the file EXISTS but cannot be read. Returning null would mean
    // "no marker" and the drain would pay — resolving an unreadable record of a
    // possible payment by making another one. Fail closed, same standard as the
    // steal gate: an unusable marker still blocks.
    return { unreadable: true, error: String(e && e.message).slice(0, 200) };
  }
}

const REFUND_LOCK_STALE_MS = 120000;
/** The steal gate is held for microseconds; this only has to survive a crash inside it. */
const STEAL_GATE_STALE_MS = 30000;

/**
 * Acquire an inter-process send lock for a single jobId.
 * Returns true if the lock was acquired (caller owns it), false if another
 * process is mid-send.  On EEXIST checks the timestamp in the lock file; if
 * older than REFUND_LOCK_STALE_MS (or unparseable) the lock is stolen.
 */
function acquireSendLock(jobId) {
  // A lock is only a lock if it names one job. `undefined`/'' would stringify to
  // a single shared file, so unrelated sends would serialise against each other
  // while concurrent sends for the SAME job would not — the opposite of the
  // intent. Also keeps the filename inside the locks directory.
  if (typeof jobId !== 'string' || !jobId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId)) {
    console.error(`  [refund] refusing to lock an invalid job id: ${JSON.stringify(jobId)}`);
    return false;
  }
  fs.mkdirSync(REFUND_LOCKS_DIR, { recursive: true, mode: 0o700 });
  const lockPath = path.join(REFUND_LOCKS_DIR, `${jobId}.lock`);
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}:${Date.now()}`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Lock exists. Decide whether the holder is DEAD, not merely SLOW.
    //
    // Age alone is the wrong test. `wallet send` holds this lock across an
    // interactive confirmation prompt, so a human who takes longer than
    // REFUND_LOCK_STALE_MS to answer looks identical to a crashed process — the
    // lock gets stolen from a live holder and BOTH broadcast. That is the exact
    // double-send this lock exists to prevent, reachable by nothing more exotic
    // than reading the prompt carefully.
    //
    // So: liveness first (`kill(pid, 0)` — signal 0 tests existence without
    // delivering anything), age only as the fallback for a lock whose owner we
    // cannot identify. A live holder is never robbed, however long it takes.
    let stale = false;
    let holderPid = null;
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      const [pidStr, tsStr] = content.split(':');
      holderPid = parseInt(pidStr, 10);
      const ts = parseInt(tsStr, 10);
      if (Number.isInteger(holderPid) && holderPid > 0) {
        let alive = true;
        try { process.kill(holderPid, 0); } catch (err) { alive = (err.code === 'EPERM'); }
        // EPERM means it exists but belongs to another user — still alive.
        stale = !alive;
      } else {
        stale = !ts || (Date.now() - ts) > REFUND_LOCK_STALE_MS;
      }
    } catch {
      stale = true; // unreadable → treat as stale
    }
    if (stale) {
      // Serialise the steal behind an exclusive gate, and RE-CHECK inside it.
      //
      // Three approaches were measured with 10 processes racing one stale lock
      // (a dead holder's leftover). Two are wrong in ways that cost money:
      //
      //   unlink-then-create      12/15 rounds had 2-5 winners
      //   rename-ours + read back 15/15 rounds had 7-9 winners
      //   rename-stale-away       15/20 rounds had 2-7 winners
      //
      // All three share one flaw: the staleness decision is made against the OLD
      // lock, but the action lands on whatever occupies the path by then — which
      // may already be another contender's fresh, live lock. Check one file, act
      // on a different one.
      //
      // O_EXCL create IS atomic, so use it on a separate gate file: exactly one
      // contender enters the critical section, and inside it re-reads the real
      // lock. If a peer already stole it, the holder is now alive and this
      // contender correctly stands down. The gate is held for microseconds, so a
      // short staleness bound on the gate itself is enough to survive a crash
      // inside it.
      const gatePath = `${lockPath}.steal`;
      const gateTag = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
      let gate;
      try {
        gate = fs.openSync(gatePath, 'wx');
        fs.writeSync(gate, gateTag);
      } catch (ge) {
        if (ge.code !== 'EEXIST') return false;
        // Reclaiming an orphaned gate is itself a steal, so it needs the same
        // discipline as the lock it guards — and the first version did not have
        // it: an age check followed by unlink-then-create, exactly the
        // non-atomic pattern this release condemned one layer down.
        //
        // Age is the wrong test anyway. "Old" flips over time and can be
        // misjudged by a peer that is merely slow; "the holder is dead" is
        // stable — a dead pid stays dead. So read the gate's owner and reuse the
        // liveness check. A gate held by a LIVE process is never taken, however
        // long it has been held; the gate is held for microseconds, so a live
        // holder means a peer is genuinely mid-steal.
        let owner = null;
        try { owner = parseInt(String(fs.readFileSync(gatePath, 'utf8')).split('.')[0], 10); }
        catch { return false; } // unreadable or vanished — a peer is active; stand down
        if (Number.isInteger(owner) && owner > 0) {
          let alive = true;
          try { process.kill(owner, 0); } catch (err) { alive = (err.code === 'EPERM'); }
          if (alive) return false; // a peer is mid-steal
        } else {
          // No usable owner. Fall back to age, which is all we have.
          let gateAge = 0;
          try { gateAge = Date.now() - fs.statSync(gatePath).mtimeMs; } catch { return false; }
          if (!Number.isFinite(gateAge) || gateAge < STEAL_GATE_STALE_MS) return false;
        }
        // The gate's owner is provably gone. Reclaim in two atomic steps.
        //
        // Read-back verification is NOT enough here and measurably fails (2 bad
        // rounds in 25): two contenders each unlink, create, and read their own
        // tag back before the other overwrites, so both believe they won. The
        // atomic claim has to be the rename — exactly one process can rename a
        // given source, the rest get ENOENT — and the acquire has to be O_EXCL
        // create, which lets a third contender that legitimately grabbed the
        // freed path win instead, with us standing down.
        try {
          fs.renameSync(gatePath, `${gatePath}.dead.${gateTag}`);
        } catch {
          return false; // another contender claimed the reclaim
        }
        try { fs.unlinkSync(`${gatePath}.dead.${gateTag}`); } catch { /* already gone */ }
        try {
          gate = fs.openSync(gatePath, 'wx');
          fs.writeSync(gate, gateTag);
        } catch {
          return false; // someone took the freed slot first — stand down
        }
      }
      try {
        // Re-read under the gate: a peer may have completed its steal already.
        let stillStale = false;
        try {
          const cur = fs.readFileSync(lockPath, 'utf8');
          const curPid = parseInt(cur.split(':')[0], 10);
          if (Number.isInteger(curPid) && curPid > 0) {
            let alive = true;
            try { process.kill(curPid, 0); } catch (err) { alive = (err.code === 'EPERM'); }
            stillStale = !alive;
          } else if (cur === '') {
            // EMPTY, not absent. openSync(wx) creates the file and writeSync
            // fills it a moment later, so a zero-length lock usually means a
            // peer is mid-write — the youngest possible lock, not a stale one.
            // Reading it as stale let a contender steal a lock that was being
            // created (a second "winner" whose lock named a different pid).
            //
            // But "mid-write" lasts microseconds. An empty lock that is SECONDS
            // old is not mid-write — it is the debris of a crash between the
            // create and the write, or of a writeSync that failed with ENOSPC.
            // Treating that as forever-young wedges the agent permanently: no
            // pid to prove dead, no timestamp to age out, nothing acquirable
            // ever again. Bound it by mtime, the same fallback the steal gate
            // already had and this path did not.
            let emptyAge = 0;
            try { emptyAge = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { emptyAge = 0; }
            stillStale = Number.isFinite(emptyAge) && emptyAge > STEAL_GATE_STALE_MS;
            if (stillStale) {
              console.warn(`  [refund] reclaiming a zero-length lock for ${jobId.substring(0, 8)} (${Math.round(emptyAge / 1000)}s old — crashed mid-write)`);
            }
          } else {
            const curTs = parseInt(cur.split(':')[1], 10);
            stillStale = !curTs || (Date.now() - curTs) > REFUND_LOCK_STALE_MS;
          }
        } catch (e) {
          // ENOENT means genuinely gone and free to take. Anything else (EACCES,
          // EIO) is doubt, and doubt does not license taking a money lock.
          stillStale = (e && e.code === 'ENOENT');
        }
        if (!stillStale) return false; // a peer stole it first; it is alive now

        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid}:${Date.now()}`);
        fs.closeSync(fd);
        // Final proof of ownership. Cheap, and it catches any interleaving the
        // reasoning above missed — a caller that broadcasts while another
        // process owns the lock is the whole failure mode.
        try {
          const back = fs.readFileSync(lockPath, 'utf8');
          if (parseInt(back.split(':')[0], 10) !== process.pid) return false;
        } catch { return false; }
        return true;
      } catch {
        return false;
      } finally {
        try { fs.closeSync(gate); } catch { /* already closed */ }
        try { fs.unlinkSync(gatePath); } catch { /* already gone */ }
      }
    }

    console.log(`  [refund] Lock held by another process for ${jobId.substring(0, 8)} — skipping (will retry next drain)`);
    return false;
  }
}

/** Release the send lock for a jobId (unlinks the lock file, guarded). */
function releaseSendLock(jobId) {
  const lockPath = path.join(REFUND_LOCKS_DIR, `${jobId}.lock`);
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

/**
 * Attempt a single pending refund entry.  On success, removes the entry from
 * the durable ledger.  On failure, leaves it for the next startup drain.
 * Returns true if the refund was sent successfully (or should be dropped).
 *
 * Idempotency: a jobId in refunded-jobs.json is never paid again, even if the
 * platform still reports it non-terminal (e.g. submitRefundTxid failed after the
 * on-chain send). The on-chain send is the point of no return, so it is the
 * point at which we durably mark the job refunded — BEFORE recording on the
 * platform — so a crash in between can never trigger a second send.
 */
async function attemptPendingRefund(state, jobId, entry, ledgerPath = PENDING_REFUNDS_PATH) {
  const { agentInfoId, orphan, refundAmount, refundPercent, buyerAddress } = entry;

  // Inter-process lock: prevents a concurrent `refunds approve` process and a
  // daemon drain tick from both passing the de-dup check and double-sending.
  if (!acquireSendLock(jobId)) return false;
  try {
    // Hard de-dup (inside lock): never re-send a refund for a job already paid.
    if (loadRefundedJobs().has(jobId)) {
      console.log(`  [refund] ⏭️  Job ${jobId.substring(0, 8)} already refunded — clearing ledger entry`);
      return true;
    }

    const agentInfo = state.agents.find(a => a.id === agentInfoId);
    if (!agentInfo) {
      console.log(`  [refund] Agent ${agentInfoId} not found for ${jobId.substring(0, 8)} — will retry later`);
      return false;
    }

    const agent = await getAgentSession(state, agentInfo);

    // ── Allowlist check before refund ──
    const allowlist = loadFinancialAllowlist();
    if (!isAddressInAllowlist(allowlist, buyerAddress)) {
      console.error(`  [refund] ❌ BLOCKED: Refund address ${buyerAddress} not in allowlist — skipping refund for ${jobId.substring(0, 8)}`);
      // Drop this entry permanently (allowlist block is not a transient failure).
      return true;
    }

    console.log(`  [refund] 💸 Sending ${refundPercent}% refund: ${refundAmount} ${orphan.currency || 'VRSC'} to ${buyerAddress} (job ${jobId.substring(0, 8)})`);
    // Intent BEFORE the irreversible broadcast — see refundInflightPath. If we
    // die after this line, the next drain finds the marker and refuses to pay
    // again rather than guessing.
    markRefundInflight(jobId, { buyerAddress, amount: refundAmount, currency: orphan.currency || 'VRSC' });
    const txid = await agent.sendCurrency(buyerAddress, refundAmount);
    // Mark refunded immediately after the irreversible on-chain send, BEFORE any
    // platform-record step that could fail and leave the platform reporting the
    // job non-terminal. This is what prevents the double-pay interleaving.
    // RESIDUAL WINDOW: if markJobRefunded's writeFileSync→renameSync is interrupted
    // by a disk fault after the send, the job stays in pending-refunds.json and is
    // retried next startup → possible double send. Strictly smaller than the
    // original software bug (requires a hardware fault between two syscalls);
    // unavoidable without a transactional FS / distributed lock.
    markJobRefunded(jobId);
    clearRefundInflight(jobId); // the send is now recorded; intent resolved
    console.log(`  [refund] ✅ Refund TX: ${txid}`);

    // Persist txid to the ledger BEFORE the platform call that follows, so a crash
    // between the on-chain send and the platform-submit can never lose the txid.
    entry.refundTxid = txid;
    const _l = loadPendingRefunds(ledgerPath);
    if (_l[jobId]) { _l[jobId].refundTxid = txid; savePendingRefunds(_l, ledgerPath); }

    // Only close the dispute on-chain when this refund is tied to a dispute.
    if (entry.disputeId) {
      try {
        await agent.client.submitRefundTxid(jobId, txid);
      } catch (e) {
        console.log(`  [refund] ⚠️  Could not record refund on platform: ${e.message}`);
      }
    }

    try {
      await agent.client.sendChatMessage(jobId, `System failure — ${refundPercent}% refund issued. TX: ${txid}`);
    } catch (e) {
      console.log(`  [refund] ⚠️  Could not notify buyer: ${e.message}`);
    }

    // Record final status on the in-memory entry (drain removes from ledger on success).
    entry.status = 'refunded';
    entry.refundedAt = new Date().toISOString();

    return true;
  } catch (e) {
    // A throw here is one of two very different things, and the marker must not
    // treat them alike:
    //
    //  - PRE-broadcast (an empty fee tank, a validation refusal): sendCurrency
    //    failed while building, nothing left the host. Retrying is correct and
    //    safe, so the marker must be cleared or the refund is wedged forever.
    //    That was the 2.11.2 regression — a routine dry tank during a drain
    //    turned an owed refund into a permanently unpaid one, while the log
    //    promised a retry that could never happen.
    //  - AMBIGUOUS (a timeout, a dropped connection mid-request): the broadcast
    //    may well have landed. Keep the marker; paying again to resolve the
    //    doubt is the one outcome we cannot undo.
    if (isFundingFailure(e)) {
      clearRefundInflight(jobId);
      console.error(`  [refund] ❌ ${jobId.substring(0, 8)}: send failed BEFORE broadcast (${e.message}).`);
      console.error('  [refund]    Nothing was sent. Fund the agent and it will retry on the next drain.');
    } else if (readRefundInflight(jobId)) {
      noteRefundInflightFailure(jobId, e.message);
      console.error(`  [refund] ⛔ ${jobId.substring(0, 8)}: send failed and we CANNOT tell whether it broadcast: ${e.message}`);
      console.error('  [refund]    BLOCKED to avoid paying twice. Verify the buyer address on-chain, then:');
      console.error(`  [refund]      j41-dispatcher refunds unblock ${jobId}   (after confirming it did NOT arrive)`);
    } else {
      // We threw BEFORE the marker was written — no session, auth backoff, agent
      // missing, allowlist. Nothing was sent and nothing is blocked, so telling
      // the operator to verify on-chain and run `unblock` would be false twice
      // over (and `unblock` would answer "not blocked"). During an outage this
      // branch fires for every approved refund in the drain.
      console.error(`  [refund] ${jobId.substring(0, 8)}: could not start the send (${e.message}) — nothing was sent; will retry.`);
    }
    return false;
  } finally {
    releaseSendLock(jobId);
  }
}

/**
 * Drain any leftover entries in pending-refunds.json.  Called at startup
 * BEFORE handleCrashRecovery so prior-crash unsent refunds are retried first.
 *
 * Only entries with `status === 'approved'` are sent.  Entries with status
 * 'pending_approval', 'needs_review', 'rejected', or no status (legacy) are
 * left untouched — only owner approval via `j41-dispatcher refunds approve`
 * can promote them to 'approved' and trigger a send.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath] — override ledger file path (tests / custom installs).
 */
async function drainPendingRefunds(state, opts = {}) {
  // Called at startup AND every 5 minutes (safeInterval, 'RefundDrain'). The
  // log line below used to say "Startup drain" unconditionally, so an operator
  // watching a healthy daemon saw "Startup drain" every five minutes and could
  // only conclude it was restart-looping.
  const isStartup = opts.startup === true;
  const ledgerPath = (opts && opts.ledgerPath) || PENDING_REFUNDS_PATH;
  const pending = loadPendingRefunds(ledgerPath);
  const jobIds = Object.keys(pending);
  if (jobIds.length === 0) return;

  // Refuse anything that was mid-broadcast when we died. The marker means the
  // money MAY already have left; paying again to resolve the ambiguity is the
  // one outcome we cannot undo. Surface it for on-chain verification instead.
  const inflightIds = jobIds.filter(id => !!readRefundInflight(id));
  for (const id of inflightIds) {
    const m = readRefundInflight(id) || {};
    const why = m.unreadable ? `has an UNREADABLE marker (${m.error || 'parse failed'})`
      : m.lastError ? `failed mid-send (${m.lastError})` : 'was interrupted mid-send';
    const what = m.unreadable ? 'a refund' : `a refund of ${m.amount} ${m.currency || ''} to ${m.buyerAddress}`;
    console.error(`  [refund] ⛔ ${id.substring(0, 8)}: ${what} ${why}.`);
    console.error('           NOT re-sending — it may already be on-chain. Verify that address, then:');
    console.error(`             j41-dispatcher refunds unblock ${id}   (only after confirming it did NOT arrive)`);
  }

  const approvedIds = jobIds.filter(id => pending[id].status === 'approved' && !readRefundInflight(id));
  const skippedCount = jobIds.length - approvedIds.length;

  console.log(`\n⚠️  ${isStartup ? 'Startup' : 'Periodic'} refund drain: ${approvedIds.length} approved refund(s) to send` +
    (skippedCount > 0 ? ` (${skippedCount} awaiting owner approval — skipped)` : ''));

  for (const jobId of approvedIds) {
    const success = await attemptPendingRefund(state, jobId, pending[jobId], ledgerPath);
    if (success) {
      delete pending[jobId];
      savePendingRefunds(pending, ledgerPath);
    }
  }
  console.log(`✅ Pending-refunds drain complete\n`);
}

// ── Pillar C: dispute sweep — auto-acknowledge + enqueue for owner approval ──

const OUTAGE_APOLOGY =
  'Our LLM provider was unavailable during your session, so no work was delivered. ' +
  'Refunding your payment in full — apologies for the inconvenience.';

/**
 * Periodically find disputes this agent caused (undelivered, no tokens, dispute.action=pending)
 * and auto-respond refund 100% (honest acknowledgement — NOT owner-gated), then enqueue the
 * refund send for owner approval via `j41-dispatcher refunds approve`.
 *
 * Idempotent: jobs already in the pending-refunds ledger or already refunded are skipped.
 * Per-agent failures do not abort the rest of the sweep.
 */
async function sweepDisputesForRefund(state) {
  const { selectRefundableDisputes, buildDisputeRefundEntry } = require('./dispute-sweep.js');
  const { resolveRefundTarget } = require('./refund-target.js');

  const selfAddresses = new Set();
  for (const a of state.agents) {
    if (a.address) selfAddresses.add(a.address);
    if (a.iAddress) selfAddresses.add(a.iAddress);
  }

  for (const agentInfo of state.agents) {
    try {
      const agent = await getAgentSession(state, agentInfo);

      let jobs;
      try {
        const res = await agent.client.getMyJobs({ role: 'seller', status: 'disputed' });
        jobs = res && res.data ? res.data : (Array.isArray(res) ? res : []);
      } catch (e) {
        console.error(`[DisputeSweep] ${agentInfo.id}: failed to fetch jobs — ${e.message}`);
        continue;
      }

      const disputeByJobId = {};
      for (const job of jobs) {
        if (!job || !job.id) continue;
        try {
          const dispute = await agent.client.getDispute(job.id);
          if (dispute) disputeByJobId[job.id] = dispute;
        } catch (_) {
          // 404 / no dispute — skip
        }
      }

      const refundable = selectRefundableDisputes(jobs, disputeByJobId);
      if (refundable.length === 0) continue;

      const ledger = loadPendingRefunds();
      const refunded = loadRefundedJobs();

      for (const job of refundable) {
        const jobId = job.id;

        if (ledger[jobId] || refunded.has(jobId)) continue;

        const dispute = disputeByJobId[jobId];

        let nameMap = new Map();
        try {
          if (job.buyerVerusId) {
            // resolveNames returns a map { iaddress: name }, NOT an array.
            const nameByAddr = await agent.client.resolveNames([job.buyerVerusId]);
            for (const [ia, nm] of Object.entries(nameByAddr || {})) {
              if (ia && nm) nameMap.set(ia, { name: nm, iaddress: ia });
            }
          }
        } catch (e) {
          console.warn(`[DisputeSweep] ${agentInfo.id}: name resolution failed for ${jobId.substring(0, 8)}: ${e.message}`);
        }

        const ctx = {
          selfAddresses,
          platformFeeAddress: null,
          resolveName: (addr) => nameMap.get(addr) || null,
        };

        const target = resolveRefundTarget(job, dispute, ctx);

        // Only respond if the seller has NOT already answered.
        //
        // A dispute already at action:'refund' carries a human-authored response
        // and a resolved_at. Responding again is wrong both ways:
        //   - it fails, we `continue`, and the ledger entry is never written —
        //     so the buyer is silently never paid while the sweep retries and
        //     re-fails every 5 minutes. That is the exact silent-failure class
        //     this queue exists to prevent.
        //   - or it succeeds and overwrites the operator's own words with a
        //     canned outage apology, and forces refundPercent 100 over whatever
        //     partial the seller actually agreed to.
        // The seller has already decided; the sweep's only remaining job is to
        // put the obligation in front of the owner for approval.
        if (dispute.action !== 'refund') {
          try {
            await agent.respondToDispute(jobId, {
              action: 'refund',
              refundPercent: 100,
              message: OUTAGE_APOLOGY,
            });
          } catch (e) {
            console.error(`[DisputeSweep] ${agentInfo.id}: respondToDispute failed for ${jobId.substring(0, 8)}: ${e.message} — will retry next sweep`);
            continue;
          }
        } else {
          console.log(`[DisputeSweep] ${agentInfo.id}: ${jobId.substring(0, 8)} — seller already agreed to refund; queueing for owner approval without re-responding`);
        }

        const entry = buildDisputeRefundEntry(job, dispute, agentInfo.id, target, new Date().toISOString());
        ledger[jobId] = entry;
        savePendingRefunds(ledger);

        const eventType = entry.status === 'needs_review' ? 'refund.needs_review' : 'refund.pending_approval';
        state.emitEvent?.(eventType, {
          jobId,
          agentId: agentInfo.id,
          amount: entry.refundAmount,
          buyerAddress: entry.buyerAddress,
          displayName: entry.buyerDisplayName,
          reason: entry.reason,
        });

        if (entry.status === 'needs_review') {
          console.error(`\x1b[31m[DisputeSweep] ⚠️  needs_review: ${jobId.substring(0, 8)} → ${entry.buyerAddress || '?'} — ${entry.reason}\x1b[0m`);
        } else {
          console.log(`[DisputeSweep] ⏸️  Queued for owner approval: ${jobId.substring(0, 8)} → ${entry.buyerAddress} (${entry.refundAmount} ${entry.orphan?.currency || 'VRSC'})`);
        }
      }

    } catch (e) {
      console.error(`[DisputeSweep] Agent ${agentInfo.id} sweep failed: ${e.message}`);
    }
  }
}

// ── Owner-facing refund CLI handlers ─────────────────────────────────────────

/**
 * List pending-refund entries.
 * Default shows pending_approval + needs_review. Pass {all:true} for every entry.
 * Returns the array of entries shown (for tests).
 */
function refundsList(state, opts = {}, ledgerPath) {
  const ledger = loadPendingRefunds(ledgerPath);
  const entries = Object.entries(ledger).map(([jobId, entry]) => ({ jobId, ...entry }));
  // A refund blocked by an in-flight marker is `approved`, so the default filter
  // hid it entirely and `refunds list` printed "No pending refunds." while money
  // was stuck. A blocked refund needs a human more urgently than a pending one.
  const blocked = entries.filter(e => !!readRefundInflight(e.jobId));
  const blockedIds = new Set(blocked.map(e => e.jobId));

  // Markers whose ledger entry has gone. Blocked entries are derived from the
  // ledger, so if the ledger is lost or hand-edited the marker becomes invisible
  // — and it is the ONLY record that a payment may have happened. There is no
  // double-pay risk (nothing left to drain), but the operator loses the pointer
  // precisely when the ledger is broken, which is when they need it most.
  let orphans = [];
  try {
    orphans = fs.readdirSync(REFUND_LOCKS_DIR)
      .filter(f => f.endsWith('.inflight.json'))
      .map(f => f.slice(0, -'.inflight.json'.length))
      .filter(id => !blockedIds.has(id));
  } catch { /* no locks dir yet */ }
  if (orphans.length) {
    console.log(`\n⚠️  ${orphans.length} in-flight marker(s) with NO ledger entry — a possible payment with no record:`);
    for (const id of orphans) {
      const m = readRefundInflight(id) || {};
      console.log(`   ${id}  ${m.amount ?? '?'} ${m.currency || ''} → ${m.buyerAddress || '(unknown)'}`);
      console.log(`      verify on-chain, then: j41-dispatcher refunds unblock ${id}`);
    }
  }
  const visible = opts.all
    ? entries
    : entries.filter(e => blockedIds.has(e.jobId) || e.status === 'pending_approval' || e.status === 'needs_review');

  if (blocked.length) {
    console.log(`\n⛔ ${blocked.length} refund(s) BLOCKED — a send failed and we cannot tell whether it broadcast.`);
    for (const e of blocked) {
      const m = readRefundInflight(e.jobId) || {};
      console.log(`   ${e.jobId.substring(0, 8)}  ${m.amount} ${m.currency || ''} → ${m.buyerAddress}`);
      if (m.lastError) console.log(`      last error: ${m.lastError}`);
      console.log(`      verify on-chain, then: j41-dispatcher refunds unblock ${e.jobId}`);
    }
  }

  if (visible.length === 0) {
    console.log('No pending refunds.');
    return visible;
  }

  const W = { job: 12, agent: 10, amt: 16, status: 18, age: 8 };
  console.log(
    `\n${'JobId'.padEnd(W.job)} ${'Agent'.padEnd(W.agent)} ${'Amount'.padEnd(W.amt)} ` +
    `${'Status'.padEnd(W.status)} ${'Age'.padEnd(W.age)} Buyer`
  );
  console.log('─'.repeat(100));

  for (const e of visible) {
    const isBlocked = blockedIds.has(e.jobId);
    const age = e.enqueuedAt
      ? Math.round((Date.now() - new Date(e.enqueuedAt).getTime()) / 60000) + 'm'
      : '?';
    const amount = `${e.refundAmount ?? '?'} ${e.orphan?.currency || 'VRSC'}`;
    const buyer = e.buyerDisplayName
      ? `${e.buyerDisplayName} (${e.buyerAddress})`
      : (e.buyerAddress || '?');
    console.log(
      `${(e.jobId || '').substring(0, 10).padEnd(W.job)} ` +
      `${(e.agentInfoId || '').substring(0, 8).padEnd(W.agent)} ` +
      `${amount.padEnd(W.amt)} ` +
      `${(isBlocked ? 'BLOCKED-inflight' : (e.status || '')).padEnd(W.status)} ` +
      `${age.padEnd(W.age)} ${buyer}`
    );
    if (e.reason) console.log(`  ${e.reason.substring(0, 80)}`);
    if (e.addressChecks) {
      for (const [check, result] of Object.entries(e.addressChecks)) {
        console.log(`  ${result ? '✓' : '✗'} ${check}`);
      }
    }
  }
  console.log(`\nTotal: ${visible.length}`);
  return visible;
}

/**
 * Reject a pending-refund entry. Sets status:'rejected', stores reason.
 * NO send, NO allowlist change. Returns the updated entry.
 */
function refundsReject(state, jobId, opts = {}, ledgerPath) {
  const ledger = loadPendingRefunds(ledgerPath);
  const entry = ledger[jobId];
  if (!entry) throw new Error(`No pending refund entry for job ${jobId}`);

  entry.status = 'rejected';
  entry.rejectedReason = opts.reason || 'owner-rejected';
  entry.rejectedAt = new Date().toISOString();
  ledger[jobId] = entry;
  savePendingRefunds(ledger, ledgerPath);
  console.log(`[refunds] Rejected ${jobId.substring(0, 8)}: ${entry.rejectedReason}`);
  return entry;
}

/**
 * Approve a single pending-refund entry with re-verification at approve time.
 * This is the gated send path — fail closed on any verification failure.
 *
 * opts.yes = true → proceed without interactive confirm (handler is non-interactive;
 * the Commander wrapper is responsible for the confirmation prompt when yes=false).
 */
async function refundsApprove(state, jobId, opts = {}, ledgerPath) {
  const ledger = loadPendingRefunds(ledgerPath);
  const entry = ledger[jobId];
  if (!entry) throw new Error(`No pending refund entry for job ${jobId}`);

  if (entry.status === 'refunded' || entry.status === 'rejected' || entry.status === 'approved') {
    console.log(`[refunds] Job ${jobId.substring(0, 8)} already ${entry.status} — no action`);
    return entry;
  }

  // needs_review: refuse — never attempt to send an address that failed verification
  if (entry.status === 'needs_review') {
    console.error(`[refunds] ❌ REFUSED: ${jobId.substring(0, 8)} is needs_review — address unverifiable.`);
    console.error('  Fix the underlying data or use "refunds reject" to close the entry.');
    if (entry.addressChecks) {
      for (const [check, result] of Object.entries(entry.addressChecks)) {
        console.error(`  ${result ? '✓' : '✗'} ${check}`);
      }
    }
    return entry;
  }

  // pending_approval: re-verify before allowing any funds to move
  const agentForEntry = state.agents.find(a => a.id === entry.agentInfoId);
  if (!agentForEntry) throw new Error(`Agent ${entry.agentInfoId} not found for job ${jobId}`);

  const agent = await getAgentSession(state, agentForEntry);

  const selfAddresses = new Set();
  for (const a of state.agents) {
    if (a.address) selfAddresses.add(a.address);
    if (a.iAddress) selfAddresses.add(a.iAddress);
  }

  let verifiedTarget = null;

  if (entry.disputeId) {
    // ── Dispute entry: re-fetch job + dispute, re-run resolveRefundTarget ──────
    const job = await agent.client.getJob(jobId);
    const dispute = await agent.client.getDispute(jobId);

    let nameMap = new Map();
    try {
      if (job.buyerVerusId) {
        // resolveNames returns a map { iaddress: name }, NOT an array.
        const nameByAddr = await agent.client.resolveNames([job.buyerVerusId]);
        for (const [ia, nm] of Object.entries(nameByAddr || {})) {
          if (ia && nm) nameMap.set(ia, { name: nm, iaddress: ia });
        }
      }
    } catch (e) {
      console.warn(`[refunds] Name resolution failed: ${e.message}`);
    }

    const { resolveRefundTarget } = require('./refund-target.js');
    const ctx = {
      selfAddresses,
      platformFeeAddress: null,
      resolveName: (addr) => nameMap.get(addr) || null,
    };
    const target = resolveRefundTarget(job, dispute, ctx);

    if (!target.confident) {
      const failing = Object.entries(target.checks).filter(([, v]) => !v).map(([k]) => k);
      console.error(`[refunds] ❌ ABORT: Re-verify failed for ${jobId.substring(0, 8)} — ${failing.join(', ')}`);
      entry.status = 'needs_review';
      entry.addressChecks = target.checks;
      ledger[jobId] = entry;
      savePendingRefunds(ledger, ledgerPath);
      return entry;
    }

    if (target.address !== entry.buyerAddress) {
      console.error(
        `[refunds] ❌ ABORT: Re-resolved address (${target.address}) differs from stored ` +
        `buyerAddress (${entry.buyerAddress}) for ${jobId.substring(0, 8)}`
      );
      entry.status = 'needs_review';
      entry.addressChecks = { ...target.checks, addressChanged: false };
      ledger[jobId] = entry;
      savePendingRefunds(ledger, ledgerPath);
      return entry;
    }

    console.log(`[refunds] Re-verify OK — ${target.displayName || target.address} (${target.address})`);
    for (const [check, result] of Object.entries(target.checks)) {
      console.log(`  ${result ? '✓' : '✗'} ${check}`);
    }
    verifiedTarget = target;

  } else {
    // ── Crash-recovery entry: basic safety checks on stored buyerAddress ───────
    // R-addresses are valid crash-recovery targets (buyer paid from an R-address).
    // No i-address requirement here — do NOT run resolveRefundTarget.
    const addr = entry.buyerAddress;
    if (!addr) {
      console.error(`[refunds] ❌ ABORT: Missing buyerAddress on crash-recovery entry for ${jobId.substring(0, 8)}`);
      entry.status = 'needs_review';
      entry.addressChecks = { hasAddress: false };
      ledger[jobId] = entry;
      savePendingRefunds(ledger, ledgerPath);
      return entry;
    }
    if (selfAddresses.has(addr)) {
      console.error(`[refunds] ❌ ABORT: buyerAddress ${addr} is a self-address for ${jobId.substring(0, 8)}`);
      entry.status = 'needs_review';
      entry.addressChecks = { notSelf: false };
      ledger[jobId] = entry;
      savePendingRefunds(ledger, ledgerPath);
      return entry;
    }
    console.log(`[refunds] Crash-recovery verify OK — ${addr}`);
  }

  // ── Owner confirmation gate (skipped when opts.yes===true) ───────────────────
  if (!opts.yes) {
    const ok = opts.confirmFn ? await opts.confirmFn(entry, verifiedTarget) : true;
    if (!ok) {
      console.log(`[refunds] Approval cancelled for ${jobId.substring(0, 8)} — no funds sent`);
      return entry; // status stays pending_approval
    }
  }

  // Add verified address to the financial allowlist with an audit line
  addToRefundAllowlist(entry.buyerAddress, jobId);

  // Mark approved and persist before the irreversible send
  entry.status = 'approved';
  entry.approvedAt = new Date().toISOString();
  ledger[jobId] = entry;
  savePendingRefunds(ledger, ledgerPath);

  const ok = await attemptPendingRefund(state, jobId, entry, ledgerPath);
  if (ok) {
    // attemptPendingRefund persists only refundTxid; it marks 'refunded' in-memory
    // because the DRAIN path deletes the entry on success. The approve path keeps the
    // entry for the audit trail, so persist the terminal 'refunded' status here — else
    // the file lingers as 'approved' and drainPendingRefunds would re-attempt an
    // already-sent entry (de-dup catches it, but the state would be wrong).
    const finalLedger = loadPendingRefunds(ledgerPath);
    if (finalLedger[jobId]) {
      finalLedger[jobId].status = 'refunded';
      if (entry.refundTxid) finalLedger[jobId].refundTxid = entry.refundTxid;
      finalLedger[jobId].refundedAt = entry.refundedAt || new Date().toISOString();
      savePendingRefunds(finalLedger, ledgerPath);
    }
    entry.status = 'refunded';
    if (entry.refundTxid) console.log(`[refunds] ✅ Sent for ${jobId.substring(0, 8)}: ${entry.refundTxid}`);
  }
  return entry;
}

/**
 * Approve all pending_approval entries (still audited + re-verified per entry).
 * Skips needs_review — those require explicit per-entry action.
 * Returns array of { jobId, entry } results.
 */
async function refundsApproveAll(state, opts = {}, ledgerPath) {
  const ledger = loadPendingRefunds(ledgerPath);
  const pendingIds = Object.keys(ledger).filter(id => ledger[id].status === 'pending_approval');
  const skippedCount = Object.keys(ledger).filter(id => ledger[id].status === 'needs_review').length;

  if (pendingIds.length === 0) {
    console.log(
      'No pending_approval entries to approve.' +
      (skippedCount > 0 ? ` (${skippedCount} needs_review skipped — handle individually)` : '')
    );
    return [];
  }
  if (skippedCount > 0) console.log(`[refunds] Skipping ${skippedCount} needs_review entries.`);

  const results = [];
  for (const jobId of pendingIds) {
    const entry = await refundsApprove(state, jobId, opts, ledgerPath);
    results.push({ jobId, entry });
  }
  console.log(`[refunds] approve-all: processed ${results.length} entries`);
  return results;
}

/**
 * Handle crash recovery: detect orphaned jobs from active-jobs.json,
 * issue refunds for interrupted jobs, clean up Docker containers.
 */
async function handleCrashRecovery(state) {
  const orphanedJobs = loadActiveJobs();
  const jobIds = Object.keys(orphanedJobs);
  if (jobIds.length === 0) return;

  console.log(`\n⚠️  Crash recovery: found ${jobIds.length} orphaned job(s)`);

  // Load any refunds already recorded by a prior run / the startup drain.
  // active-jobs.json is only cleared at Step 4, so a job that drainPendingRefunds
  // already paid (and removed from the ledger) would otherwise be re-classified
  // here from active-jobs.json and refunded a SECOND time. Guard against that:
  // any jobId still in the ledger is mid-flight; any jobId NOT in active-jobs.json
  // that the drain already cleared simply won't appear in this loop's orphan set,
  // but to be safe we never re-queue a jobId that is already in the ledger, and we
  // MERGE (never overwrite) so concurrent ledger entries are preserved.
  const existingPending = loadPendingRefunds();

  // ── Step 1: build the set of jobs that need a refund ────────────────────
  const pendingRefunds = {};

  const alreadyRefunded = loadRefundedJobs();

  for (const jobId of jobIds) {
    const orphan = orphanedJobs[jobId];
    console.log(`  Processing ${jobId.substring(0, 8)}...`);

    // Skip intentionally-paused jobs — they are queued for reactivation, not orphaned.
    if (rq.has(state.reactivationQueue, jobId)) {
      console.log(`    ⏭️  Job is in reactivation queue (paused) — skipping crash refund`);
      continue;
    }

    // Never re-queue a job already paid by a prior run / the startup drain.
    if (isRefundAlreadyHandled(jobId, alreadyRefunded, existingPending)) {
      console.log(`    ⏭️  Already refunded or queued — skipping`);
      continue;
    }

    try {
      // Find the agent session
      const agentInfo = state.agents.find(a => a.id === orphan.agentInfoId);
      if (!agentInfo) {
        console.log(`    ⚠️  Agent ${orphan.agentInfoId} not found — skipping`);
        continue;
      }

      const agent = await getAgentSession(state, agentInfo);

      // Query platform for current job state
      let currentJob;
      try {
        currentJob = await agent.client.getJob(jobId);
      } catch (e) {
        console.log(`    ⚠️  Could not fetch job status: ${e.message}`);
        if (orphan.jobAmount && orphan.buyerPayAddress) {
          console.log(`    Using persisted data for refund`);
          currentJob = { status: 'in_progress', amount: orphan.jobAmount };
        } else {
          continue;
        }
      }

      // 'delivered' is terminal here: the work was delivered (and payment earned),
      // so a dispatcher restart must NOT auto-refund it — that would make the
      // operator eat the compute AND the payout. Disputes handle disagreements.
      if (!shouldRefundOrphan(currentJob)) {
        console.log(`    ✅ Job already ${currentJob.status} — cleaning up`);
        continue;
      }

      // Job was interrupted — queue for refund
      const policy = state.disputePolicy?.get(agentInfo.id);
      const refundPercent = policy?.systemCrashRefund ?? 100;
      const jobAmount = orphan.jobAmount || currentJob.amount || 0;
      const refundAmount = jobAmount * (refundPercent / 100);
      const buyerAddress = orphan.buyerPayAddress || currentJob.buyerPayAddress;

      if (refundAmount > 0 && buyerAddress) {
        pendingRefunds[jobId] = {
          agentInfoId: orphan.agentInfoId,
          orphan,
          refundAmount,
          refundPercent,
          buyerAddress,
          status: 'pending_approval',
          reason: 'crash-recovery: job interrupted (dispatcher restart) — undelivered paid job',
        };
      } else {
        console.log(`    ⚠️  Cannot issue refund — missing amount (${jobAmount}) or address (${buyerAddress})`);
      }

      // Kill orphaned Docker containers
      if (RUNTIME === 'docker') {
        try {
          const Docker = require('dockerode');
          const docker = new Docker();
          const containers = await docker.listContainers({
            all: true,
            filters: { label: [`j41.job.id=${jobId}`] },
          });
          for (const containerInfo of containers) {
            try {
              const container = docker.getContainer(containerInfo.Id);
              await container.stop().catch(() => {});
              await container.remove().catch(() => {});
              console.log(`    🗑️  Removed container ${containerInfo.Id.substring(0, 12)}`);
            } catch (e) {
              console.log(`    ⚠️  Container cleanup failed: ${e.message}`);
            }
          }
        } catch (e) {
          console.log(`    ⚠️  Docker cleanup failed: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`  ❌ Recovery failed for ${jobId.substring(0, 8)}: ${e.message}`);
    }
  }

  // ── Step 2: write pending-refunds BEFORE sending anything (crash-safe) ──
  // MERGE with any existing ledger entries (e.g. an entry a concurrent/prior
  // drain left in place) rather than overwriting — never lose an owed refund.
  const ledger = { ...existingPending, ...pendingRefunds };
  if (Object.keys(pendingRefunds).length > 0) {
    savePendingRefunds(ledger);
  }

  // ── Step 3: notify owner; entries wait for approval (no auto-send) ──────
  // All crash-recovery refunds require owner approval before funds move.
  // Use `j41-dispatcher refunds approve <jobId>` to approve and send.
  for (const jobId of Object.keys(pendingRefunds)) {
    const entry = pendingRefunds[jobId];
    state.emitEvent?.('refund.pending_approval', {
      jobId,
      agentId: entry.agentInfoId,
      amount: entry.refundAmount,
      buyerAddress: entry.buyerAddress,
      reason: entry.reason,
    });
    console.log('  [refund] ⏸️  Queued for owner approval (j41-dispatcher refunds approve): ' + jobId.substring(0, 8) + ' → ' + entry.buyerAddress);
  }

  // ── Step 4: clear the active-jobs ledger (orphans are now handled) ───────
  // This ONLY clears active-jobs.json. pending-refunds.json retains any unsent
  // refunds so they survive the next crash without duplication.
  persistActiveJobs(new Map());
  console.log(`✅ Crash recovery complete\n`);
}

/**
 * Refund a PAID job that cleanupCompletedJobs ABANDONED after exhausting its docker
 * launch retries. stopJobContainer deletes the job from state.active BEFORE any
 * restart, so handleCrashRecovery (which only refunds jobs still in active-jobs.json)
 * would never see it — the buyer's payment would be stuck with no delivery. This
 * routes it into the SAME durable pending-refunds ledger crash-recovery uses, so the
 * periodic drainPendingRefunds pays it out, and reuses the same idempotency guards
 * (loadRefundedJobs / the ledger) so it is never refunded twice. No-op for a job that
 * recorded no payment.
 */
async function refundAbandonedJob(state, jobId, active) {
  const agentId = active?.agentInfoId || active?.agentInfo?.id || null;
  const refundPercent = state.disputePolicy?.get(agentId)?.systemCrashRefund ?? 100;

  const refundedJobs = loadRefundedJobs();
  const pending = loadPendingRefunds();

  const record = buildAbandonedJobRefund(active, jobId, refundPercent, refundedJobs, pending);
  if (!record) {
    // Unpaid, already refunded, or already queued — nothing to enqueue.
    return;
  }

  console.log(`  [refund] Enqueuing abandoned-job refund: ${record.refundPercent}% = ${record.refundAmount} ${record.orphan.currency} → ${record.buyerAddress} (job ${jobId.substring(0, 8)})`);

  // Persist to the durable ledger BEFORE sending (crash-safe), merging so a
  // concurrent entry is never clobbered — mirrors handleCrashRecovery Step 2.
  const ledger = { ...pending, [jobId]: record };
  savePendingRefunds(ledger);

  // Notify owner; entry waits for approval before funds move (no auto-send).
  // Use `j41-dispatcher refunds approve <jobId>` to approve and send.
  state.emitEvent?.('refund.pending_approval', {
    jobId,
    agentId: record.agentInfoId,
    amount: record.refundAmount,
    buyerAddress: record.buyerAddress,
    reason: record.reason,
  });
  console.log('  [refund] ⏸️  Queued for owner approval (j41-dispatcher refunds approve): ' + jobId.substring(0, 8) + ' → ' + record.buyerAddress);
}

/**
 * Auto-approve or reject extension requests based on system capacity.
 * Approve if: queue empty + slots open + system has headroom.
 * Reject with reason otherwise.
 */
async function handleExtensionRequest(state, jobId, extensionId, agentInfo) {
  const os = require('os');
  const cfg = loadConfig();

  if (cfg.extensionAutoApprove === false) {
    console.log(`[Extension] Auto-approve disabled — ignoring ${extensionId.substring(0, 8)}`);
    return;
  }

  const maxCpuPct = cfg.extensionMaxCpuPercent || 80;
  const minFreeMB = cfg.extensionMinFreeMB || 512;

  const queueEmpty = state.queue.length === 0;
  const slotsOpen = state.active.size < MAX_AGENTS;
  const loadAvg1m = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuOk = loadAvg1m < cpuCount * (maxCpuPct / 100);
  const freeMem = os.freemem();
  const memOk = freeMem > minFreeMB * 1024 * 1024;

  const canApprove = queueEmpty && slotsOpen && cpuOk && memOk;

  try {
    const agent = await getAgentSession(state, agentInfo);
    if (canApprove) {
      await agent.client.approveExtension(jobId, extensionId);
      console.log(`[Extension] Auto-approved ${extensionId.substring(0, 8)} for job ${jobId.substring(0, 8)} (queue=0, slots=${MAX_AGENTS - state.active.size}, load=${loadAvg1m.toFixed(1)}/${cpuCount}, mem=${Math.round(freeMem / 1024 / 1024)}MB)`);
    } else {
      const reasons = [];
      if (!queueEmpty) reasons.push(`queue=${state.queue.length}`);
      if (!slotsOpen) reasons.push('no slots');
      if (!cpuOk) reasons.push(`load=${loadAvg1m.toFixed(1)}/${cpuCount}`);
      if (!memOk) reasons.push(`mem=${Math.round(freeMem / 1024 / 1024)}MB`);
      await agent.client.rejectExtension(jobId, extensionId);
      console.log(`[Extension] Rejected ${extensionId.substring(0, 8)} for job ${jobId.substring(0, 8)} — ${reasons.join(', ')}`);
    }
  } catch (e) {
    console.error(`[Extension] Failed to handle ${extensionId.substring(0, 8)}: ${e.message}`);
  }
}

/**
 * Insert a job into the priority queue. Sorted by:
 *  1. Amount descending (higher-paying jobs first)
 *  2. createdAt ascending (older jobs first, as tiebreaker)
 * Falls back to FIFO if amount/createdAt are missing.
 */
function queueInsertByPriority(queue, job) {
  const amt = parseFloat(job.amount) || 0;
  const ts = job.createdAt ? new Date(job.createdAt).getTime() : Date.now();

  // Find insertion index: first position where the new job has higher priority
  let idx = queue.length; // default: append at end
  for (let i = 0; i < queue.length; i++) {
    const qAmt = parseFloat(queue[i].amount) || 0;
    const qTs = queue[i].createdAt ? new Date(queue[i].createdAt).getTime() : Date.now();

    if (amt > qAmt || (amt === qAmt && ts < qTs)) {
      idx = i;
      break;
    }
  }
  queue.splice(idx, 0, job);
}

// Poll for new jobs — check ALL agents, not just available ones
// (an agent with an active job can still have new jobs queued for it)
let _polling = false;
/** Cycles the poll loop skipped because the previous one overran. Surfaced on /health. */
let _pollSkips = 0;
async function pollForJobs(state) {
  // B2: once shutdown begins, stop taking on new work. `shuttingDown` used to be a
  // closure variable no other function could see, so this loop kept signing and
  // accepting jobs during a drain — after every agent had been marked offline. A
  // buyer could pay into a job whose seller was mid-shutdown, stranding their money.
  // Post-delivery transitions and the dispute reconciler below still run: work
  // already in flight must keep being serviced while we drain.
  if (state.shuttingDown) {
    if (!state._loggedDrainPollSkip) {
      state._loggedDrainPollSkip = true;
      console.log('[Poll] Shutting down — not accepting new jobs (in-flight work continues to drain)');
    }
    return;
  }
  if (_polling) {
    // A skipped cycle is the symptom of the poll loop taking longer than its own
    // interval — at N agents that is (N-1)*500ms of stagger plus N API round
    // trips against a max(60s, N*1s) budget, so it bites from ~30 agents at a
    // 1.5s round trip. Returning silently means the fleet quietly stops looking
    // for work with nothing in the log and nothing on /health. Count it and say
    // so; a dispatcher that cannot keep up must not look idle.
    _pollSkips++;
    state._pollSkips = _pollSkips; // mirror onto state so /health can report it
    console.warn(`[Poll] previous cycle still running — skipping this one (${_pollSkips} skipped). The poll interval is shorter than a full sweep of ${state.agents.length} agent(s).`);
    return;
  }
  _polling = true;
  try {
  for (let i = 0; i < state.agents.length; i++) {
    const agentInfo = state.agents[i];
    // Stagger API calls — 500ms between agents to avoid rate limits at scale
    if (i > 0) await new Promise(r => setTimeout(r, 500));
    try {
      console.log(`[Poll] Checking ${agentInfo.id} (${agentInfo.identity || agentInfo.address})`);

      const agent = await getAgentSession(state, agentInfo);

      // Default getMyJobs({role:'seller'}) excludes in_progress server-side, so
      // jobs that transitioned to in_progress between polls (e.g. paid in another
      // session) become invisible. Fetch in_progress explicitly and merge.
      const [defaultRes, inProgRes] = await Promise.all([
        agent.client.getMyJobs({ role: 'seller' }),
        agent.client.getMyJobs({ role: 'seller', status: 'in_progress' }),
      ]);
      // Audit 2026-06-02 M-DISPATCHER-ddos-5: cap response sizes so a
      // compromised/buggy platform cannot blow memory by returning enormous
      // arrays (e.g. 100k jobs in one response).
      const MAX_JOBS_PER_RESPONSE = Number(process.env.J41_MAX_JOBS_PER_POLL || 200);
      const safeDefault = (defaultRes?.data || []).slice(0, MAX_JOBS_PER_RESPONSE);
      const safeInProg = (inProgRes?.data || []).slice(0, MAX_JOBS_PER_RESPONSE);
      if ((defaultRes?.data || []).length > MAX_JOBS_PER_RESPONSE ||
          (inProgRes?.data || []).length > MAX_JOBS_PER_RESPONSE) {
        console.error(`[Poll] ${agentInfo.id}: platform returned more than ${MAX_JOBS_PER_RESPONSE} jobs in a single response — truncating. Set J41_MAX_JOBS_PER_POLL to raise.`);
      }
      const _merged = new Map();
      for (const j of safeDefault) _merged.set(j.id, j);
      for (const j of safeInProg) _merged.set(j.id, j);
      const allJobs = [..._merged.values()];
      const jobs = allJobs.filter(j =>
        j.status === 'requested' || j.status === 'accepted' || j.status === 'in_progress'
      );
      console.log(`[Poll] ${agentInfo.id} jobs fetched: ${jobs.length}`);

      for (const job of jobs) {
        if (!job?.id) {
          console.warn(`[Poll] ${agentInfo.id} skipping malformed job:`, JSON.stringify(job).slice(0, 160));
          continue;
        }

        // Check if already handling or already processed
        if (state.seen.has(job.id)) {
          continue;
        }
        if (state.active.has(job.id)) {
          continue;
        }
        if (state.queue.some(j => j.id === job.id)) {
          continue;
        }

        // Skip jobs in terminal states (delivered, completed, cancelled, resolved)
        if (TERMINAL_STATUSES.includes(job.status)) {
          state.seen.set(job.id, Date.now());
          continue;
        }

        // ── Step 1: Accept the job (sign commitment) if not already accepted ──
        const pending = state.pendingPayment.get(job.id);

        if (job.status === 'requested' && !pending?.accepted) {
          try {
            const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
            const fullJob = await agent.client.getJob(job.id);
            if (fullJob?.jobHash && fullJob?.buyerVerusId) {
              if (!(await preflightAllowsAccept(state, agentInfo, loadAgentConfig(agentInfo.id), loadDispatcherConfig()))) {
                console.log(`[PREFLIGHT] LLM unavailable for ${agentInfo.id} — declining job ${job.id.substring(0, 8)}, buyer not charged`);
                state.emitEvent?.('job.declined_llm_down', { jobId: job.id, agentId: agentInfo.id });
                continue;
              }
              const timestamp = Math.floor(Date.now() / 1000);
              const acceptSig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
              await agent.client.acceptJob(job.id, acceptSig, timestamp, agentInfo.address);
              console.log(`✅ Job ${job.id} accepted (signed, pay→${agentInfo.address.slice(0, 8)}...) — awaiting buyer payment`);
              state.emitEvent?.('job.accepted', { jobId: job.id, agentId: agentInfo.id });

              // ── Allowlist lifecycle: add buyer refund address ──
              const buyerPayAddr = fullJob.buyerPayAddress || fullJob.buyer?.payAddress;
              if (buyerPayAddr) {
                addActiveJobToAllowlist(job.id, buyerPayAddr);
              }

              state.pendingPayment.set(job.id, { accepted: true, agentInfo });
            }
          } catch (acceptErr) {
            // May fail if already accepted or other issue — log and continue
            if (acceptErr.message?.includes('already accepted') || acceptErr.message?.includes('already')) {
              state.pendingPayment.set(job.id, { accepted: true, agentInfo });
            } else {
              console.error(`[Poll] Failed to accept job ${job.id}: ${acceptErr.message}`);
            }
          }
        }

        // ── Step 2: Check if ready to start ──
        // in_progress = platform confirmed payment and moved the job forward
        // accepted + payment.verified = payment confirmed
        // accepted + payment.status === 'confirmed'/'completed' = payment confirmed
        // accepted + no payment object = platform doesn't enforce payment (let it through)
        const allowUnpriced = process.env.J41_ALLOW_UNPRICED_JOBS === '1';
        if (allowUnpriced && !job.payment) console.warn(`[Payment] Admitting job ${job.id} with NO payment record (J41_ALLOW_UNPRICED_JOBS=1)`);
        const isPaid = job.status === 'in_progress' ||
          (job.payment && job.payment.verified === true) ||
          (job.payment && (job.payment.status === 'confirmed' || job.payment.status === 'completed')) ||
          (allowUnpriced && !job.payment); // explicit opt-in required — bare no-payment no longer trusted (M8)

        if (!isPaid) {
          if (!state.pendingPayment.has(job.id)) {
            console.log(`⏳ Job ${job.id} (${job.amount} ${job.currency}) — awaiting payment (status: ${job.status}, payment: ${JSON.stringify(job.payment || 'none').slice(0, 120)})`);
            state.pendingPayment.set(job.id, { accepted: true, agentInfo });
          }
          continue;
        }

        // Ready to go
        if (state.pendingPayment.has(job.id)) {
          console.log(`💰 Payment confirmed for job ${job.id}`);
          state.pendingPayment.delete(job.id);
        }

        console.log(`📥 New job: ${job.id} (${job.amount} ${job.currency})`);

        // Mark seen BEFORE starting to prevent duplicate spawns from concurrent polls
        state.seen.set(job.id, Date.now());
        saveSeenJobs(state.seen);

        if (state.active.size >= MAX_AGENTS) {
          console.log(`   → Queueing (max capacity, ${job.amount || '?'} ${job.currency || 'VRSC'})`);
          queueInsertByPriority(state.queue, { ...job, assignedAgent: agentInfo });
        } else {
          console.log(`   → Starting job with ${agentInfo.id} (${RUNTIME})`);
          await startJob(state, job, agentInfo);
        }
      }
    } catch (e) {
      // Surface SovGuard/platform quota limits — don't silently retry
      if (e.statusCode === 429 && (e.upgrade_url || e.plan || (e.message && e.message.includes('upgrade')))) {
        console.error(`\n⛔ [Poll] ${agentInfo.id}: ${e.message}`);
        if (e.upgrade_url) console.error(`   Upgrade your plan: ${e.upgrade_url}`);
        // Don't invalidate session — this is a quota issue, not auth
      } else {
        // Invalidate session on auth/request errors so next poll re-authenticates
        state.agentSessions.delete(agentInfo.id);
        console.error(`[Poll] Error for ${agentInfo.id}:`, e.message);
      }
    }
  }

  // Check for post-delivery status transitions (poll mode fallback)
  // Track last-sent status per job to avoid duplicate IPC messages
  for (const [jobId, activeInfo] of state.active.entries()) {
    try {
      const agentSession = await getAgentSession(state, activeInfo.agentInfo);
      const currentJob = await agentSession.client.getJob(jobId);
      const lastStatus = state._lastSentStatus.get(jobId);
      if (currentJob.status === lastStatus) continue; // Already sent this status
      if (currentJob.status === 'completed') {
        sendToJobAgent(activeInfo, { type: 'job.completed', data: { jobId } });
        state.emitEvent?.('job.completed', { jobId, agentId: activeInfo.agentInfo?.id });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'disputed') {
        await queueDisputedJobForRespawn(state, jobId, { agentId: activeInfo.agentInfo?.id, reason: currentJob.dispute?.reason });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'resolved' || currentJob.status === 'resolved_rejected') {
        sendToJobAgent(activeInfo, { type: 'dispute.resolved', data: { jobId, action: currentJob.dispute?.action } });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'rework') {
        sendToJobAgent(activeInfo, { type: 'dispute.rework_accepted', data: { jobId } });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'delivered' && lastStatus !== 'delivered') {
        // Auto-deliver detected via poll (pause_ttl_expired)
        console.log(`[Poll] Job ${jobId.substring(0, 8)} auto-delivered`);
        sendToJobAgent(activeInfo, { type: 'end_session_request', jobId });
        state.emitEvent?.('job.delivered', { jobId, agentId: activeInfo.agentInfo?.id });
        state._lastSentStatus.set(jobId, currentJob.status);
      }

      // Poll-mode fallback: detect paused → in_progress (resume happened without webhook)
      if (currentJob.status === 'in_progress' && activeInfo.paused) {
        console.log(`[Poll] Job ${jobId.substring(0, 8)} resumed (was paused) — unthrottling`);
        if (rq.markReady(state.reactivationQueue, jobId)) {
          persistReactivationQueue(state.reactivationQueue);
          await respawnReadyResumes(state);
        } else {
          activeInfo.paused = false;
          activeInfo.pausedAt = null;
          activeInfo.resumedAt = Date.now();
          state.available = state.available.filter(a => a.id !== activeInfo.agentInfo?.id);
          sendToJobAgent(activeInfo, { type: 'reconnect', jobId });
          state._lastSentStatus.set(jobId, currentJob.status);
        }
      }

      // Poll-mode fallback: detect in_progress → paused (pause happened without a
      // webhook / without a working job_idle IPC in Docker). Free the container.
      const { shouldPauseOnPoll } = require('./reactivation-poll.js');
      if (shouldPauseOnPoll(currentJob, activeInfo)) {
        console.log(`[Poll] Job ${jobId.substring(0, 8)} paused (platform) — freeing container`);
        await moveJobToReactivationQueue(state, jobId);
        state._lastSentStatus.set(jobId, currentJob.status);
      }
    } catch (e) {
      // Job may have been deleted — ignore
    }
  }

  // Own disputed/rework jobs whose worker is already gone. The loop above can only
  // ever see jobs in `state.active`; this is the half that covers the rest, and
  // without it a dispute filed after the worker's post-delivery hold expired was
  // invisible to the whole dispatcher until its deadline lapsed.
  try {
    await reconcileOrphanedDisputes(state);
  } catch (e) {
    console.error(`[DisputeReconcile] sweep failed: ${e.message}`);
  }

  // Poll-mode fallback: resume queued (container-freed) jobs whose platform status
  // returned to in_progress — the webhook (job.resumed) path may be absent in poll
  // mode. Batched round-robin so 100 queued jobs don't hammer the platform.
  const RESUME_POLL_BATCH = 10;
  if (state.reactivationQueue.length > 0 && state.active.size < MAX_AGENTS) {
    const { pickResumeBatch } = require('./reactivation-poll.js');
    const { batch, nextCursor } = pickResumeBatch(state.reactivationQueue, state._resumeCursor || 0, RESUME_POLL_BATCH);
    state._resumeCursor = nextCursor;
    for (const entry of batch) {
      const jobId = entry.job.id;
      if (entry.readyToRespawn) continue; // already flagged
      try {
        const agentInfo = state.agents.find(a => a.id === entry.agentId);
        if (!agentInfo) continue;
        const session = await getAgentSession(state, agentInfo);
        const full = await session.client.getJob(jobId);
        if (full?.status === 'in_progress') {
          console.log(`[Poll] Queued job ${jobId.substring(0, 8)} resumed (platform) — respawning`);
          if (rq.markReady(state.reactivationQueue, jobId)) {
            persistReactivationQueue(state.reactivationQueue);
            await respawnReadyResumes(state);
          }
        }
      } catch { /* transient — retried next sweep */ }
    }
  }

  // Poll-mode fallback: check for pending extension requests on active jobs
  for (const [jobId, activeInfo] of state.active.entries()) {
    if (activeInfo.paused) continue; // Don't check paused jobs
    try {
      const agentSession = await getAgentSession(state, activeInfo.agentInfo);
      const extensions = await agentSession.client.getExtensions(jobId);
      const pending = (extensions || []).filter(e => e.status === 'pending');
      if (pending?.length > 0) {
        for (const ext of pending) {
          if (state._lastExtensionCheck.has(ext.id)) continue;
          state._lastExtensionCheck.set(ext.id, { ts: Date.now(), jobId });
          await handleExtensionRequest(state, jobId, ext.id, activeInfo.agentInfo);
        }
      }
    } catch {
      // Ignore — extensions endpoint may not exist for this job
    }
  }

  // Sweep queued reactivation entries whose pause_ttl has elapsed.
  // (Nothing in state.active is ever paused — pause deletes the active entry.)
  await sweepExpiredQueue(state);

  // Flush queued workspace messages for newly-spawned job-agents
  if (state._pendingWorkspace?.size) {
    for (const [pendingJobId, wsData] of state._pendingWorkspace) {
      const activeInfo = state.active.get(pendingJobId);
      // Fork-gated: a Docker worker never drained this queue, so a workspace that
      // arrived before spawn stayed queued for the life of the job.
      if (activeInfo) {
        if (!checkWorkspaceCapability(state, activeInfo.agentId)) {
          state._pendingWorkspace.delete(pendingJobId);
          continue;
        }
        sendToJobAgent(activeInfo, {
          type: 'workspace_ready',
          jobId: pendingJobId,
          sessionId: wsData.sessionId,
          permissions: wsData.permissions,
          mode: wsData.mode,
        });
        activeInfo.workspaceNotified = true;
        state._pendingWorkspace.delete(pendingJobId);
        console.log(`[Poll] Flushed queued workspace_ready → job-agent ${pendingJobId.substring(0, 8)}`);
      }
    }
  }

  // Check workspace status for active jobs that haven't been notified
  for (const [activeJobId, activeInfo] of state.active) {
    if (activeInfo.workspaceNotified) continue;
    if (!activeInfo.process?.send && !activeInfo.container) continue;
    if (!checkWorkspaceCapability(state, activeInfo.agentId)) {
      activeInfo.workspaceNotified = true; // Don't check again
      continue;
    }
    try {
      const agentSession = await getAgentSession(state, activeInfo.agentInfo);
      const wsStatus = await agentSession.client.getWorkspaceStatus(activeJobId);
      if (wsStatus?.status === 'active' || wsStatus?.status === 'pending') {
        sendToJobAgent(activeInfo, {
          type: 'workspace_ready',
          jobId: activeJobId,
          sessionId: wsStatus.id || wsStatus.sessionId || '',
          permissions: wsStatus.permissions || { read: true, write: true },
          mode: wsStatus.mode || 'supervised',
        });
        activeInfo.workspaceNotified = true;
        console.log(`[Poll] Workspace ${wsStatus.status} — notified job-agent ${activeJobId.substring(0, 8)}`);
      }
    } catch {
      // Don't give up — will retry next poll cycle
    }
  }

  // Resumes claim free slots first (priority over new jobs)
  await respawnReadyResumes(state);

  // Process queue if slots available (D3: re-queue on failure instead of dropping)
  while (state.queue.length > 0 && state.active.size < MAX_AGENTS && state.available.length > 0) {
    // I4: OOM valve — guard every spawn path, not just respawns.
    if (!hasMemoryHeadroom(os.freemem(), SIZING_DEFAULTS.perContainerMemBytes)) {
      console.warn('[Scheduler] Low free memory — deferring new job start');
      break;
    }
    const queuedJob = state.queue.shift();
    const agent = state.available.pop();
    console.log(`   → Processing queued job ${queuedJob.id} with ${agent.id}`);
    try {
      await startJob(state, queuedJob, agent);
    } catch (e) {
      console.error(`   ❌ Failed to start job ${queuedJob.id}: ${e.message}`);
      // Return agent to pool and re-queue the job at the back
      state.available.push(agent);
      state.queue.push(queuedJob);
      break; // Don't keep trying if container creation is failing
    }
  }
  } finally {
    _polling = false;
  }
}

// Handle incoming webhook event (webhook mode)
// Normalize platform webhook event names to the WP-D2 event vocabulary so
// the /v1/events feed is stable regardless of platform-side naming.
const WEBHOOK_EVENT_MAP = {
  'job.extension_request': 'extension.requested',
  'job.extension_approved': 'extension.approved',
  'job.extension_rejected': 'extension.rejected',
  'job.dispute.filed': 'dispute.filed',
  'job.disputed': 'dispute.filed',
  'job.dispute.resolved': 'dispute.resolved',
  'job.dispute.responded': 'dispute.responded',
  'job.dispute.rework_accepted': 'dispute.rework_accepted',
};

async function handleWebhookEvent(state, agentId, payload) {
  const agentInfo = state.agents.find(a => a.id === agentId);
  if (!agentInfo) {
    console.error(`[Webhook] Unknown agent: ${agentId}`);
    return;
  }

  const { event, data } = payload;
  const jobId = data?.jobId || payload.jobId;
  console.log(`[Webhook] ${agentInfo.id}: ${event}${jobId ? ' ' + jobId.substring(0, 8) : ''}`);

  // WP-D2: mirror every inbound platform event into the control-API event
  // feed, normalized to the documented vocabulary so a polling client
  // (brainbox 🔔, a monitor, a script) sees one consistent stream. This is
  // observation only — the switch below still does the actual work.
  const evType = WEBHOOK_EVENT_MAP[event] || event;
  state.emitEvent?.(evType, { jobId: jobId || null, agentId: agentInfo.id, ...(data || {}) });

  switch (event) {
    case 'job.requested': {
      if (!jobId || state.seen.has(jobId) || state.active.has(jobId)) return;
      try {
        const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
        const agent = await getAgentSession(state, agentInfo);
        const fullJob = await agent.client.getJob(jobId);
        if (fullJob?.jobHash && fullJob?.buyerVerusId) {
          if (!(await preflightAllowsAccept(state, agentInfo, loadAgentConfig(agentInfo.id), loadDispatcherConfig()))) {
            console.log(`[PREFLIGHT] LLM unavailable for ${agentInfo.id} — declining job ${jobId.substring(0, 8)}, buyer not charged`);
            state.emitEvent?.('job.declined_llm_down', { jobId, agentId: agentInfo.id });
            return;
          }
          const timestamp = Math.floor(Date.now() / 1000);
          const sig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
          await agent.client.acceptJob(jobId, sig, timestamp, agentInfo.address);
          console.log(`[Webhook] ✅ Job ${jobId.substring(0, 8)} accepted (pay→${agentInfo.address.slice(0, 8)}...)`);
          state.emitEvent?.('job.accepted', { jobId, agentId: agentInfo.id });

          // ── Allowlist lifecycle: add buyer refund address ──
          const buyerPayAddr = fullJob.buyerPayAddress || fullJob.buyer?.payAddress;
          if (buyerPayAddr) {
            addActiveJobToAllowlist(jobId, buyerPayAddr);
          }
        }
      } catch (e) {
        if (!e.message?.includes('already')) console.error(`[Webhook] Accept failed: ${e.message}`);
      }
      break;
    }

    case 'job.started': {
      if (!jobId || state.active.has(jobId) || state.seen.has(jobId)) return;
      try {
        const agent = await getAgentSession(state, agentInfo);
        const job = await agent.client.getJob(jobId);
        if (state.active.size >= MAX_AGENTS) {
          queueInsertByPriority(state.queue, { ...job, assignedAgent: agentInfo });
          console.log(`[Webhook] Job ${jobId.substring(0, 8)} queued (priority, ${job.amount || '?'} ${job.currency || 'VRSC'})`);
        } else {
          console.log(`[Webhook] Starting job ${jobId.substring(0, 8)} with ${agentInfo.id}`);
          await startJob(state, job, agentInfo);
        }
      } catch (e) {
        console.error(`[Webhook] Start failed: ${e.message}`);
      }
      break;
    }

    case 'file.uploaded': {
      if (!jobId) return;
      // The job-agent handles this via chat message detection
      console.log(`[Webhook] File uploaded for job ${jobId.substring(0, 8)}: ${data?.filename || '?'}`);
      break;
    }

    case 'review.received': {
      try {
        const agent = await getAgentSession(state, agentInfo);
        // Check inbox for the review
        const inbox = await agent.client.getInbox('pending', 10);
        const reviews = (inbox.data || []).filter(i => i.type === 'review' || i.rating != null);
        for (const review of reviews) {
          try {
            await agent.acceptReview(review.id);
            console.log(`[Webhook] ✅ Review ${review.id.substring(0, 8)} processed for ${agentInfo.id}`);
            // Trigger backend re-index so review is visible on marketplace immediately
            try {
              await agent.client.refreshAgent(agentInfo.iAddress || agentInfo.identity);
            } catch {}
          } catch (e) {
            console.error(`[Webhook] Review failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`[Webhook] Review check failed: ${e.message}`);
      }
      break;
    }

    case 'job.cancelled': {
      if (!jobId) return;
      if (state.active.has(jobId)) {
        console.log(`[Webhook] Job ${jobId.substring(0, 8)} cancelled — cleaning up`);
        // Mark cancelled as an abnormal exit so its log is archived under the
        // default 'errors' retention (deterministic + symmetric with local).
        const cancelActive = state.active.get(jobId);
        if (cancelActive) cancelActive._killed = true;
        if (RUNTIME === 'docker') {
          await stopJobContainer(state, jobId);
        } else {
          await stopJobLocal(state, jobId);
        }
      }
      state.queue = state.queue.filter(j => j.id !== jobId);
      state.seen.set(jobId, Date.now());
      saveSeenJobs(state.seen);
      break;
    }

    case 'job.delivery_rejected': {
      console.log(`[Webhook] ⚠️  Delivery rejected for job ${jobId?.substring(0, 8)} — reason: ${data?.reason || '?'}`);
      break;
    }

    case 'job.disputed':
    case 'job.dispute.filed': {
      console.log(`[Webhook] ⚠️  Dispute filed for job ${jobId?.substring(0, 8)} by ${data?.disputedBy || '?'}: ${data?.reason || '?'}`);
      await queueDisputedJobForRespawn(state, jobId, { agentId, reason: data?.reason });
      // Record that we've surfaced the dispute so the next pollForJobs cycle
      // sees the correct status and does NOT double-fire to the buyer.
      if (jobId) state._lastSentStatus.set(jobId, 'disputed');
      break;
    }

    case 'job.dispute.responded': {
      console.log(`[Webhook] Dispute response for job ${jobId?.substring(0, 8)}: action=${data?.action || '?'}`);
      break;
    }

    case 'job.dispute.resolved': {
      console.log(`[Webhook] ✅ Dispute resolved for job ${jobId?.substring(0, 8)}: ${data?.action || '?'}`);
      const resolvedJob = state.active.get(jobId);
      // sendToJobAgent, not process.send: `.process` exists only for local forks, so
      // gating on it silently dropped this for every Docker container — the same
      // defect class as dispute_policy, which was migrated while these were missed.
      if (resolvedJob) sendToJobAgent(resolvedJob, { type: 'dispute.resolved', data });
      break;
    }

    case 'job.dispute.rework_accepted': {
      console.log(`[Webhook] 🔄 Rework accepted for job ${jobId?.substring(0, 8)}`);
      const reworkJob = state.active.get(jobId);
      // See dispute.resolved above — this one silently never reached a Docker
      // worker, so webhook-mode rework never ran at all.
      if (reworkJob) sendToJobAgent(reworkJob, { type: 'dispute.rework_accepted', data });
      break;
    }

    case 'job.completed': {
      console.log(`[Webhook] ✅ Job ${jobId?.substring(0, 8)} completed`);
      const completedJob = state.active.get(jobId);
      if (completedJob) {
        sendToJobAgent(completedJob, { type: 'job.completed', data });
      } else {
        // Job not active — just mark as seen
        if (jobId) {
          state.seen.set(jobId, Date.now());
          saveSeenJobs(state.seen);
        }
      }
      break;
    }

    case 'workspace.ready': {
      const activeInfo = state.active.get(jobId);
      // Docker workers have `.container`, never `.process` — gating on the fork
      // channel queued every containerised workspace as "not spawned yet".
      if (activeInfo) {
        if (!checkWorkspaceCapability(state, activeInfo.agentId)) {
          console.log(`[Webhook] Workspace ready — BLOCKED by VDXF policy for ${activeInfo.agentId}`);
          break;
        }
        sendToJobAgent(activeInfo, {
          type: 'workspace_ready',
          jobId: jobId,
          sessionId: data.sessionId,
          permissions: data.permissions,
          mode: data.mode,
        });
        activeInfo.workspaceNotified = true;
        console.log(`[Webhook] Workspace ready — notified job-agent ${jobId?.substring(0, 8)}`);
      } else {
        // Job-agent not spawned yet or no IPC — queue for delivery when ready
        state._pendingWorkspace.set(jobId, {
          sessionId: data.sessionId,
          permissions: data.permissions,
          mode: data.mode,
        });
        console.log(`[Webhook] Workspace ready — queued for job-agent ${jobId?.substring(0, 8)} (not spawned yet)`);
      }
      break;
    }

    case 'workspace.disconnected':
    case 'workspace.completed': {
      const activeInfo2 = state.active.get(jobId);
      if (activeInfo2) {
        sendToJobAgent(activeInfo2, {
          type: 'workspace_closed',
          jobId: jobId,
          reason: event,
        });
        console.log(`[Webhook] Workspace closed (${event}) — notified job-agent ${jobId?.substring(0, 8)}`);
      }
      break;
    }

    case 'job.end_session_request': {
      console.log(`[Webhook] End-session requested for job ${jobId?.substring(0, 8)}`);
      const endSessionJob = state.active.get(jobId);
      if (endSessionJob) {
        sendToJobAgent(endSessionJob, { type: 'end_session_request', jobId });
      }
      break;
    }

    case 'job.extension_request': {
      console.log(`[Webhook] Extension requested for job ${jobId?.substring(0, 8)}`);
      const extensionJob = state.active.get(jobId);
      if (extensionJob && data?.extensionId) {
        await handleExtensionRequest(state, jobId, data.extensionId, extensionJob.agentInfo);
      }
      break;
    }

    case 'job.reconnect': {
      console.log(`[Webhook] Reconnect requested for job ${jobId?.substring(0, 8)}`);
      const reconnectJob = state.active.get(jobId);
      if (reconnectJob && sendToJobAgent(reconnectJob, { type: 'reconnect', jobId })) {
        console.log(`[Webhook] Sent reconnect to job-agent ${jobId?.substring(0, 8)}`);
      } else {
        // Job-agent not active — try to re-pick it up on next poll
        if (jobId) {
          state.seen.delete(jobId);
          console.log(`[Webhook] Job-agent not active — cleared from seen so it will be re-picked on next poll`);
        }
      }
      break;
    }

    case 'job.resumed': {
      console.log(`[Webhook] Job resumed — unthrottling ${jobId?.substring(0, 8)}`);
      if (rq.markReady(state.reactivationQueue, jobId)) {
        persistReactivationQueue(state.reactivationQueue);
        await respawnReadyResumes(state);
      } else if (state.active.has(jobId)) {
        const resumeInfo = state.active.get(jobId);
        resumeInfo.paused = false;
        resumeInfo.pausedAt = null;
        resumeInfo.resumedAt = Date.now();
        state.available = state.available.filter(a => a.id !== resumeInfo.agentInfo?.id);
        sendToJobAgent(resumeInfo, { type: 'reconnect', jobId });
      }
      break;
    }

    case 'job.paused': {
      const pauseReason = data?.auto ? ` (auto: ${data.reason || 'idle'})` : '';
      console.log(`[Webhook] Job ${jobId?.substring(0, 8)} paused${pauseReason}`);
      const pauseInfo = state.active.get(jobId);
      if (pauseInfo && !pauseInfo.paused && !pauseInfo._pausing) {
        pauseInfo._pausing = true;   // synchronous guard — survives the await yields below
        // For free-lifecycle agents, auto-extend to resume before tearing down
        if (data?.auto && pauseInfo.reactivationFee === 0) {
          try {
            const agentSession = await getAgentSession(state, pauseInfo.agentInfo);
            // SDK signature is (jobId, amount, reason) — an object here sent NaN to the platform
            await agentSession.client.requestExtension(jobId, 0, 'Auto-resume (free lifecycle)');
            console.log(`[Webhook] Auto-extended paused job ${jobId?.substring(0, 8)} (free lifecycle)`);
          } catch (extErr) {
            console.warn(`[Webhook] Auto-extend failed: ${extErr.message}`);
          }
        }
        await moveJobToReactivationQueue(state, jobId);
      }
      break;
    }

    case 'job.delivered': {
      const deliverReason = data?.auto ? ` (auto: ${data.reason || 'pause_ttl'})` : '';
      console.log(`[Webhook] Job ${jobId?.substring(0, 8)} delivered${deliverReason}`);
      const deliverInfo = state.active.get(jobId);
      if (deliverInfo) {
        // Tell container to clean up workspace and finalize
        sendToJobAgent(deliverInfo, { type: 'end_session_request', jobId });
      }
      break;
    }

    case 'bounty.awarded': {
      console.log(`[Webhook] Bounty awarded — treating as new job request`);
      const bountyJobId = data?.jobId || jobId;
      if (!bountyJobId || state.seen.has(bountyJobId) || state.active.has(bountyJobId)) return;
      try {
        const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
        const agent = await getAgentSession(state, agentInfo);
        const fullJob = await agent.client.getJob(bountyJobId);
        if (fullJob?.jobHash && fullJob?.buyerVerusId) {
          if (!(await preflightAllowsAccept(state, agentInfo, loadAgentConfig(agentInfo.id), loadDispatcherConfig()))) {
            console.log(`[PREFLIGHT] LLM unavailable for ${agentInfo.id} — declining job ${bountyJobId.substring(0, 8)}, buyer not charged`);
            state.emitEvent?.('job.declined_llm_down', { jobId: bountyJobId, agentId: agentInfo.id });
            return;
          }
          const timestamp = Math.floor(Date.now() / 1000);
          const sig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
          await agent.client.acceptJob(bountyJobId, sig, timestamp, agentInfo.address);
          console.log(`[Webhook] ✅ Bounty job ${bountyJobId.substring(0, 8)} accepted (pay→${agentInfo.address.slice(0, 8)}...)`);

          // ── Allowlist lifecycle: add buyer refund address ──
          const bountyBuyerAddr = fullJob.buyerPayAddress || fullJob.buyer?.payAddress;
          if (bountyBuyerAddr) {
            addActiveJobToAllowlist(bountyJobId, bountyBuyerAddr);
          }

          state.seen.set(bountyJobId, Date.now());

          // Start the job — same as poll-mode acceptance
          try {
            // X1 — signature is (state, job, agentInfo); this site had them swapped, so
            // every bounty-awarded job was accepted, signed and allowlisted and then
            // never started: agent-1..9 fail isValidJobId's 8-char floor and silently
            // early-return, agent-10+ throw on undefined.
            await startJob(state, fullJob, agentInfo);
          } catch (startErr) {
            console.error(`[Webhook] Bounty job start failed: ${startErr.message}`);
          }
        }
      } catch (e) {
        if (!e.message?.includes('already')) console.error(`[Webhook] Bounty accept failed: ${e.message}`);
      }
      break;
    }

    case 'job.extension_approved': {
      console.log(`[Webhook] ✅ Extension approved for job ${jobId?.substring(0, 8)}`);
      const extJob = state.active.get(jobId);
      if (extJob) {
        // Prefer the platform's echo, fall back to what the job-agent asked
        // for (recorded on extension_needed). sendToJobAgent reaches Docker
        // containers too — process.send alone left them budget-locked.
        const additionalTokens = data?.estimatedTokens || extJob.pendingExtensionTokens || 0;
        extJob.pendingExtensionTokens = null;
        if (additionalTokens > 0) {
          sendToJobAgent(extJob, { type: 'budget_increased', data: { additionalTokens } });
        } else {
          console.warn(`[Webhook] Extension approved but token count unknown — job-agent will re-request`);
        }
      }
      break;
    }

    case 'job.extension_rejected': {
      console.log(`[Webhook] ❌ Extension rejected for job ${jobId?.substring(0, 8)}`);
      // Job-agent continues with remaining budget
      break;
    }

    // ── SovGuard limit webhooks ──
    case 'limit.warning': {
      const usage = data?.usage || '?';
      const limit = data?.limit || '?';
      const plan = data?.plan || '?';
      const threshold = data?.threshold || 0.8;
      console.warn(`\n⚠️  [SovGuard] Usage warning: ${usage}/${limit} tokens (${Math.round(threshold * 100)}%) — plan: ${plan}`);
      if (data?.upgrade_url) console.warn(`   Upgrade: ${data.upgrade_url}`);
      break;
    }
    case 'limit.reached': {
      const plan = data?.plan || '?';
      console.error(`\n⛔ [SovGuard] Token limit reached — plan: ${plan}. Scans will be rejected.`);
      if (data?.upgrade_url) console.error(`   Upgrade: ${data.upgrade_url}`);
      break;
    }

    default:
      // Log unhandled events for debugging
      break;
  }
}

// Per-item inbox accept routing, extracted for testability. Returns
// { accepted:true } on a real accept, { skip:true, reason } for a transient
// job_record skip, { accepted:false } for an unhandled type. Throws bubble to
// the caller's dead-letter handling.
async function dispatchInboxAccept(agent, item, deps) {
  if (item.type === 'review') {
    console.log(`[Inbox] Processing review ${item.id}`);
    await agent.acceptReview(item.id);
    console.log(`[Inbox] ✅ Review accepted`);
    return { accepted: true };
  }
  if (item.type === 'attestation') {
    console.log(`[Inbox] Processing attestation ${item.id}`);
    await agent.acceptAttestationTuple(item.id);
    console.log(`[Inbox] ✅ Attestation accepted`);
    return { accepted: true };
  }
  if (item.type === 'job_record') {
    console.log(`[Inbox] Processing job record ${item.id}`);
    const { data: inboxItemDetail } = await agent.client.getInboxItem(item.id);
    const gateResult = await deps.verifyInboxJobRecord({
      inboxItemDetail,
      getJobWitness: (jobId) => agent.client.getJobWitness(jobId),
      verifyWitness: deps.verifyWitness,
      client: agent.client,
      network: deps.network,
    });
    if (gateResult && gateResult.skip) {
      console.log(`[Inbox] ⏭ Skipping job_record ${item.id} (transient): ${gateResult.reason}`);
      return { skip: true, reason: gateResult.reason };
    }
    await agent.acceptJobRecord(item.id);
    console.log(`[Inbox] ✅ Job record written on-chain`);
    return { accepted: true };
  }
  return { accepted: false };
}

/**
 * Process one agent's pending inbox items in a single identity transaction.
 *
 * Replaces the old per-item loop, which wrote N transactions to the same VerusID
 * back-to-back: the first spends the identity prevOutput and sits in the mempool
 * while the platform keeps serving the last *confirmed* prevOutput, so every tx
 * after it double-spends and is rejected. Observed live on 3/3 agents.
 *
 * Retry semantics, by bucket:
 *  - acked / alreadyDone → clear the failure record
 *  - rejected            → count it; 5 strikes dead-letters that item alone
 *  - deferred / ackFailed→ neither counted nor cleared (the existing skip contract)
 *  - batch-level throw   → not attributable to one item, so uncounted — but
 *                          bounded by recordBatchFailure so nothing spins forever
 *
 * `deps` is injected so the whole function is testable with no daemon or chain.
 */
/** The only inbox types that result in an on-chain write. */
const INBOX_ACTIONABLE_TYPES = ['review', 'attestation', 'job_record'];

async function processInboxForAgent(agent, agentInfo, pending, state, deps = {}) {
  const now = deps.now || Date.now;
  const noteFailure = (id, type, err) => {
    const dl = recordInboxFailure(state._inboxFailures, id, err, undefined, { agentId: agentInfo.id, type, firstFailedAt: now() });
    if (dl.justDeadLettered) {
      console.error(
        `[Inbox] ☠️  DEAD-LETTER ${type} ${String(id).substring(0, 8)} for ${agentInfo.id} ` +
        `after ${dl.attempts} attempts — quarantined, will NOT retry until restart or 'ctl inbox-redrive'. Last error: ${err}`,
      );
      state._agentErrors.set(agentInfo.id,
        `inbox ${type} ${String(id).substring(0, 8)} dead-lettered (${dl.attempts}x): ${String(err).slice(0, 100)}`);
      if (typeof state.emitEvent === 'function') {
        state.emitEvent('inbox.dead_lettered', { agentId: agentInfo.id, itemId: id, type, attempts: dl.attempts });
      }
    } else {
      console.error(`[Inbox] ❌ Failed to process ${type} ${String(id).substring(0, 8)} (attempt ${dl.attempts}/${MAX_INBOX_ATTEMPTS}): ${err}`);
    }
  };

  // ── Pending-write gate ────────────────────────────────────────────────────
  // Never build a second identity tx while the previous one is unconfirmed —
  // that IS the double-spend. Evaluated even when there is nothing pending, so
  // a confirmed gate cannot linger in /health as a stale pendingWrite forever.
  const lastWrite = state._inboxLastWrite.get(agentInfo.id);
  if (lastWrite) {
    let prevOutTxid = null;
    let chainHeight = null;
    try {
      const { data: idRaw } = await agent.client.getIdentityRaw();
      prevOutTxid = idRaw && idRaw.prevOutput ? idRaw.prevOutput.txid : null;
      const ci = await agent.client.getChainInfo();
      chainHeight = ci ? ci.blockHeight : null;
    } catch {
      // Can't tell — assume still pending. Deferring is always the safe choice.
    }
    const gate = shouldDeferForPendingWrite(lastWrite, prevOutTxid, chainHeight, now());
    if (gate.defer) {
      console.log(`[Inbox] ⏸ ${agentInfo.id}: last identity write ${String(lastWrite.txid).slice(0, 8)} not yet confirmed — deferring this cycle`);
      return { deferredAgent: true, reason: gate.reason };
    }
    if (gate.reason !== 'confirmed') {
      console.warn(`[Inbox] ${agentInfo.id}: pending-write gate released by ${gate.reason} (tx ${String(lastWrite.txid).slice(0, 8)} — likely a concurrent writer or an expired tx)`);
      if (typeof state.emitEvent === 'function') {
        state.emitEvent('inbox.pending_write_expired', { agentId: agentInfo.id, txid: lastWrite.txid, reason: gate.reason });
      }
    }
    state._inboxLastWrite.delete(agentInfo.id);
  }

  if (!pending || pending.length === 0) return { empty: true };

  // ── Build the batch ───────────────────────────────────────────────────────
  const batch = [];
  for (const it of pending) {
    if (isDeadLettered(state._inboxFailures, it.id)) continue;

    // job_record keeps its dispatcher-side witness gate: it needs getJobWitness +
    // verifyWitness + network policy, which the SDK batch has no business doing.
    if (it.type === 'job_record' && deps.verifyInboxJobRecord) {
      try {
        // Verify against the DETAIL, not the getInbox list row. Every previously
        // live-proven path used getInboxItem, and jobDetails is detail-only — a
        // list row missing vdxfData would make decodeInboxJobRecord throw, which
        // classifies HARD and would dead-letter every job_record in 5 cycles.
        let detail = it;
        if (agent.client && typeof agent.client.getInboxItem === 'function') {
          const res = await agent.client.getInboxItem(it.id);
          detail = (res && res.data) || it;
        }
        const gateResult = await deps.verifyInboxJobRecord({
          inboxItemDetail: detail,
          getJobWitness: (jobId) => agent.client.getJobWitness(jobId),
          verifyWitness: deps.verifyWitness,
          client: agent.client,
          network: deps.network,
        });
        if (gateResult && gateResult.skip) {
          console.log(`[Inbox] ⏭ Skipping job_record ${String(it.id).substring(0, 8)} (transient): ${gateResult.reason}`);
          continue;
        }
      } catch (e) {
        // Only a real verification failure is the item's fault. A network blip is
        // not — counting it would let 5 API hiccups dead-letter a healthy record.
        if (classifyInboxFailure(e) === 'hard') noteFailure(it.id, 'job_record', e.message);
        else console.warn(`[Inbox] job_record ${String(it.id).substring(0, 8)} gate transient (uncounted): ${e.message}`);
        continue;
      }
    }
    batch.push({ id: it.id, type: it.type });
  }
  if (batch.length === 0) return { empty: true };

  // ── Legacy fallback: SDK older than the batch API ─────────────────────────
  if (typeof agent.acceptInboxBatch !== 'function') {
    for (const ref of batch) {
      try {
        const r = await dispatchInboxAccept(agent, ref, {
          verifyInboxJobRecord: deps.verifyInboxJobRecord, verifyWitness: deps.verifyWitness, network: deps.network,
        });
        // Preserve the original contract: a transient skip is neither counted NOR
        // cleared. Clearing would wipe accumulated attempts, so a flapping item
        // could never reach the dead-letter threshold.
        if (r && r.skip) continue;
        clearInboxFailure(state._inboxFailures, ref.id);
      } catch (e) {
        // Even on the old path, contention must not burn the budget.
        // Only 'hard' — the item's own fault — may burn the dead-letter budget.
        // Exempting contention alone was the 2026-08-05 incident: a dry fee tank
        // classifies 'transient', and striking items for it quarantined three
        // perfectly valid ones. This path is the older non-batched fallback, so
        // it must honour the same rule the batched path does or the bug simply
        // lives on wherever acceptInboxBatch is unavailable.
        const cls = classifyInboxFailure(e);
        if (cls !== 'hard') {
          console.warn(`[Inbox] ${ref.type} ${String(ref.id).substring(0, 8)}: ${cls} (uncounted) — ${e.message}`);
        } else {
          noteFailure(ref.id, ref.type, e.message);
        }
      }
    }
    return { legacy: true };
  }

  // ── Batched path ──────────────────────────────────────────────────────────
  let res;
  try {
    res = await agent.acceptInboxBatch(batch);
  } catch (e) {
    const cls = classifyInboxFailure(e);
    const bf = recordBatchFailure(state._inboxBatchFailures, agentInfo.id, batch.map(b => b.id), cls);
    const funding = isFundingFailure(e);
    state._agentErrors.set(
      agentInfo.id,
      funding
        ? `${FEE_TANK_ERROR_PREFIX} (${bf.consecutive}x) — fund this agent's R-address; earnings at the i-address cannot pay fees`
        : `inbox batch ${cls} (${bf.consecutive}x): ${String(e.message).slice(0, 100)}`
    );
    if (funding) {
      // The one failure class an operator can actually fix, so name the remedy
      // rather than let it read as a generic batch failure. Uncounted (transient)
      // by design — no item is at fault and all of them succeed once funded.
      console.error(`[Inbox] 💸 ${agentInfo.id}: ${FEE_TANK_ERROR_PREFIX} (${bf.consecutive}x) — ${batch.length} item(s) stalled, none struck. ${e.message}`);
      if (state.emitEvent) state.emitEvent('fee_tank_empty', { agentId: agentInfo.id, stalled: batch.length, consecutive: bf.consecutive });
    } else if (cls === 'contention') {
      console.warn(`[Inbox] ${agentInfo.id}: chain contention — waiting for confirmation (uncounted, attempt ${bf.consecutive})`);
    } else {
      console.error(`[Inbox] ${agentInfo.id}: batch failed (${cls}, ${bf.consecutive}x): ${e.message}`);
    }
    if (bf.escalate) {
      // Uncounted must not mean unbounded. The same batch has failed
      // non-contention N times, so start counting its items individually — they
      // can then dead-letter instead of retrying forever.
      console.error(`[Inbox] ${agentInfo.id}: batch failed ${bf.consecutive}x with the same items — escalating to per-item counting`);
      if (typeof state.emitEvent === 'function') {
        state.emitEvent('inbox.batch_escalated', { agentId: agentInfo.id, items: batch.map(b => b.id), classification: cls });
      }
      for (const ref of batch) noteFailure(ref.id, ref.type, e.message);
    }
    return { batchError: cls };
  }

  clearBatchFailure(state._inboxBatchFailures, agentInfo.id);
  // A successful batch proves the tank is payable again, so retract our own
  // fee-tank alert. Without this it stays lit on /health until the process
  // restarts — a stale critical warning on a money surface is how operators
  // learn to ignore the surface. Prefix-scoped so we never erase another
  // subsystem's error.
  if (String(state._agentErrors.get(agentInfo.id) || '').startsWith(FEE_TANK_ERROR_PREFIX)) {
    state._agentErrors.delete(agentInfo.id);
  }

  if (res.txid) {
    state._inboxLastWrite.set(agentInfo.id, {
      txid: res.txid, at: now(), expiryHeight: res.expiryHeight ?? deps.expiryHeight ?? null,
    });
  }
  for (const id of res.acked) clearInboxFailure(state._inboxFailures, id);
  for (const id of res.alreadyDone) clearInboxFailure(state._inboxFailures, id);
  for (const r of res.rejected) noteFailure(r.id, r.type, r.error);
  for (const d of res.deferred) {
    console.log(`[Inbox] ⏭ ${d.type} ${String(d.id).substring(0, 8)} deferred (uncounted): ${d.reason}`);
  }
  // Track consecutive ack failures. These items sit in no other bucket — never
  // counted, never dead-lettered — so without this they are invisible apart from
  // a console line, while each retry cycle could rebroadcast at 10,000 sats.
  if (!state._inboxAckFailures) state._inboxAckFailures = new Map();
  for (const id of res.acked) state._inboxAckFailures.delete(id);
  for (const id of res.alreadyDone) state._inboxAckFailures.delete(id);
  for (const f of res.ackFailed) {
    const ref = batch.find(b => b.id === f.id);
    const prev = state._inboxAckFailures.get(f.id);
    state._inboxAckFailures.set(f.id, {
      agentId: agentInfo.id,
      type: ref ? ref.type : null,
      txid: res.txid || null,
      consecutive: (prev ? prev.consecutive : 0) + 1,
      lastError: String(f.error).slice(0, 200),
    });
    console.warn(`[Inbox] ${String(f.id).substring(0, 8)} written on-chain but ack failed (uncounted): ${f.error}`);
  }
  if (res.acked.length > 0) {
    console.log(`[Inbox] ✅ ${agentInfo.id}: ${res.acked.length} item(s) accepted${res.txid ? ` in tx ${String(res.txid).slice(0, 8)}` : ' (already on-chain)'}`);
  }
  return res;
}

/**
 * Keep every agent able to pay its own transaction fees.
 *
 * Job payments land at the i-address; identity-update fees are payable only from
 * the R-address. Without this the R-address only drains, and an agent eventually
 * goes silent on-chain while holding earnings it never touches — which is exactly
 * what happened to agent-6 in round 4 (see src/fee-tank.js).
 *
 * Deliberately its own low-frequency timer rather than a step in the inbox sweep:
 * this costs one getUtxos per agent, and the inbox cycle runs every 60s.
 */
async function checkFeeTanks(state) {
  if (state._feeSweepRunning) {
    // Same reentrancy hazard as the inbox sweep — but silence here is worse than
    // for polling. A fee-tank check that quietly stops running is precisely how
    // agent-6 drained to zero and went silent on-chain on 2026-08-05.
    state._feeSweepSkips = (state._feeSweepSkips || 0) + 1;
    console.warn(`[FeeTank] previous check still running — skipping this cycle (${state._feeSweepSkips} skipped). Tanks are not being watched while this persists.`);
    return;
  }
  if (!state._feeSweepPending) state._feeSweepPending = new Map();
  if (!state._feeTankLast) state._feeTankLast = new Map(); // defensive: older state objects
  state._feeSweepRunning = true;
  try {
    const { buildPayment } = require('@junction41/sovagent-sdk/dist/index.js');
    const cfg = state.feeSweep || {};
    const now = Date.now();

    for (const agentInfo of state.agents) {
      if (!agentInfo.identity || !agentInfo.wif || !agentInfo.iAddress) continue;
      try {
        const agent = await getAgentSession(state, agentInfo);
        const u = await agent.client.getUtxos();
        // Derive the destination from OUR key, never from the platform response —
        // see resolveOwnRAddress. This loop auto-broadcasts with no operator
        // prompt, so a trusted-but-wrong address here would drain the fleet.
        const { wifToAddress } = require('@junction41/sovagent-sdk/dist/index.js');
        const own = resolveOwnRAddress({
          derived: wifToAddress(agentInfo.wif, J41_NETWORK),
          platformAddress: u.address,
          agentId: agentInfo.id,
        });
        if (!own.ok) {
          state._agentErrors.set(agentInfo.id, own.error);
          console.error(`[FeeTank] 🛑 ${own.error}`);
          continue;
        }
        const rAddress = own.rAddress;
        const s = summarizeUtxos(u.utxos, rAddress);

        const plan = planFeeSweep({
          feeSats: s.feeSats,
          sweepableSats: s.sweepableSats,
          floorWrites: cfg.floorWrites,
          pending: state._feeSweepPending.get(agentInfo.id) || null,
          now,
        });

        // Record BEFORE the branches, so every outcome is observable — including
        // the two that `continue` (needs-external-funding, sweep-pending) and the
        // healthy above-floor case. A snapshot that only existed on the sweep
        // path would show nothing precisely when nothing is wrong, and nothing
        // when an agent is stuck.
        state._feeTankLast.set(agentInfo.id, {
          feeSats: s.feeSats,
          writes: writesAffordable(s.feeSats),
          sweepableSats: s.sweepableSats,
          reason: plan.reason,
          at: now,
        });

        if (plan.reason === 'needs-external-funding') {
          // Cannot self-heal: it has never earned. Only an operator transfer fixes
          // this, so say so by name rather than let it surface as a batch failure.
          const msg = `${FEE_TANK_ERROR_PREFIX} and nothing to sweep — fund ${rAddress} externally`;
          state._agentErrors.set(agentInfo.id, msg);
          console.error(`[FeeTank] 💸 ${agentInfo.id}: ${msg}`);
          if (state.emitEvent) state.emitEvent('fee_tank_empty', { agentId: agentInfo.id, rAddress, selfFundable: false });
          continue;
        }
        // A deferred sweep is otherwise a silent `continue`, so a wedged agent
        // (e.g. a clock jump stamping `pending.at` in the future) is invisible.
        if (plan.reason === 'sweep-pending') {
          console.log(`[FeeTank] ${agentInfo.id}: sweep already broadcast and unconfirmed — skipping this cycle`);
          continue;
        }

        // Retract our own stale alert once the tank recovers. Nothing else clears
        // _agentErrors except a successful activation, so without this an agent
        // funded after a FEE TANK EMPTY warning would keep reporting broken for
        // the life of the process. Scoped to OUR message so we never erase a job
        // or activation failure set by another subsystem.
        if (plan.reason === 'above-floor' && String(state._agentErrors.get(agentInfo.id) || '').startsWith(FEE_TANK_ERROR_PREFIX)) {
          state._agentErrors.delete(agentInfo.id);
          console.log(`[FeeTank] ${agentInfo.id}: tank recovered (${writesAffordable(s.feeSats)} writes) — clearing alert`);
        }

        if (!plan.sweep) continue;

        console.log(`[FeeTank] ${agentInfo.id}: ${writesAffordable(s.feeSats)} writes left — sweeping ${(plan.amountSats / 1e8).toFixed(8)} VRSC from ${s.sweepableUtxos.length} i-address UTXO(s)`);
        const res = await executeFeeSweep({
          buildPayment,
          broadcast: (hex) => agent.client.broadcast(hex),
          wif: agentInfo.wif,
          network: J41_NETWORK,
          rAddress,
          sweepableUtxos: s.sweepableUtxos,
          amountSats: plan.amountSats,
        });

        if (res.swept) {
          state._feeSweepPending.set(agentInfo.id, { txid: res.txid, at: now });
          const after = writesAffordable(s.feeSats + plan.amountSats);
          console.log(`[FeeTank] ✅ ${agentInfo.id}: swept in ${res.txid.substring(0, 12)} — ~${after} writes once confirmed`);
          if (state.emitEvent) state.emitEvent('fee_sweep', { agentId: agentInfo.id, txid: res.txid, amountSats: plan.amountSats });
        } else {
          console.error(`[FeeTank] ${agentInfo.id}: sweep failed — ${res.reason}${res.detail ? ` (${res.detail})` : ''}`);
        }
      } catch (e) {
        console.error(`[FeeTank] ${agentInfo.id}: ${e.message}`);
      }
    }
  } finally {
    state._feeSweepRunning = false;
  }
}

// Check for pending inbox items (reviews + job records) and process them
async function checkPendingInbox(state) {
  // Reentrancy guard: safeInterval is a plain setInterval, so a sweep slower than
  // the 60s floor would overlap the next one — two concurrent batches per agent,
  // racing _inboxLastWrite and re-creating the contention this all exists to stop.
  if (state._inboxSweepRunning) {
    console.warn('[Inbox] previous sweep still running — skipping this cycle');
    return;
  }
  state._inboxSweepRunning = true;
  try {
    return await runInboxSweep(state);
  } finally {
    state._inboxSweepRunning = false;
  }
}

async function runInboxSweep(state) {
  if (!state._inboxFailures) state._inboxFailures = new Map(); // defensive: older state objects
  if (!state._inboxLastWrite) state._inboxLastWrite = new Map();
  if (!state._inboxBatchFailures) state._inboxBatchFailures = new Map();
  if (!state._inboxAckFailures) state._inboxAckFailures = new Map();
  const seenInboxIds = new Set(); // every pending id observed this cycle (for pruning)
  let completeView = true; // false if any agent failed to poll — then we prune nothing

  for (let i = 0; i < state.agents.length; i++) {
    const agentInfo = state.agents[i];
    if (!agentInfo.identity || !agentInfo.wif || !agentInfo.iAddress) continue;
    if (i > 0) await new Promise(r => setTimeout(r, 500));

    try {
      const agent = await getAgentSession(state, agentInfo);
      // Declared before first use: the zero-pending branch below also needs it,
      // and a `const` referenced above its declaration is a TDZ ReferenceError,
      // not a hoisted undefined.
      const { verifyWitness } = require('@junction41/sovagent-sdk/dist/index.js');
      // Filter server-side to the three types that cause chain writes. Informational
      // items (job_accepted / job_delivered / notification) are never consumed and
      // accumulate — the platform returns newest-first, so a large informational
      // backlog would push a genuine review past the 20-row window and make it
      // invisible with no error anywhere. A backend without the filter ignores the
      // param, so this is safe to ship ahead of it.
      const inbox = await agent.client.getInbox('pending', 20, INBOX_ACTIONABLE_TYPES);
      const pending = (inbox?.data || []).filter(
        item => item.type === 'review' || item.type === 'job_record' || item.type === 'attestation'
      );
      if (pending.length === 0) {
        // Still evaluate the pending-write gate: it is what clears a confirmed
        // write out of state (and out of /health.pendingWrites). Skipping it here
        // would leave a permanently stale entry once an inbox empties.
        await processInboxForAgent(agent, agentInfo, [], state, {
          verifyInboxJobRecord, verifyWitness, network: J41_NETWORK,
        });
        continue;
      }
      console.log(`[Inbox] ${agentInfo.id}: ${pending.length} pending item(s)`);

      for (const item of pending) seenInboxIds.add(item.id);
      await processInboxForAgent(agent, agentInfo, pending, state, {
        verifyInboxJobRecord, verifyWitness, network: J41_NETWORK,
      });
    } catch (e) {
      completeView = false; // this agent's pending set is unknown → don't prune its items
      state.agentSessions.delete(agentInfo.id);
      if (!e.message.includes('not registered')) {
        console.error(`[Inbox] Error checking ${agentInfo.id}:`, e.message);
      }
    }
  }

  // Drop tracking for items no longer pending (accepted or expired), so a
  // long-lived daemon's failure map can't grow without bound. Only safe with a
  // complete view — see pruneInboxFailures.
  pruneInboxFailures(state._inboxFailures, seenInboxIds, completeView);
}

// Load per-agent config (agent-config.json with fallback to executor fields in keys.json).
// Returns {} if nothing is set. Used by both getExecutorEnvVars() and buildContainerEnv().
function loadAgentConfig(agentId) {
  const agentDir = path.join(AGENTS_DIR, agentId);
  let config = {};
  try {
    const configPath = path.join(agentDir, 'agent-config.json');
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } else {
      const keys = readKeysFile(path.join(agentDir, 'keys.json'), { allowLocked: true });
      if (keys.executor) config = keys;
    }
  } catch {
    // No config — caller falls back to defaults
  }
  return config;
}

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
    J41_SOUL_FILE: path.join(path.dirname(keysPath), 'SOUL.md'),
    J41_CANARY_TOKEN: canaryToken,
    JOB_TIMEOUT_MS: String(JOB_TIMEOUT_MS),
    // How long a worker may hold itself open for an OPEN DISPUTE. Read by
    // job-agent.js, which runs INSIDE the container — so setting it on the
    // dispatcher alone did nothing, and the knob silently had no effect. Only
    // forwarded when set, so the container keeps its own default otherwise.
    ...(process.env.J41_DISPUTE_HOLD_MAX_MS
      ? { J41_DISPUTE_HOLD_MAX_MS: String(process.env.J41_DISPUTE_HOLD_MAX_MS) }
      : {}),
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
  if (cfg.debug.poll || process.env.J41_DEBUG_POLL === '1') env.J41_DEBUG_POLL = '1';

  // Jailbox park gate forwarded into the container. In Docker mode the job-agent's
  // workspace poller talks to the platform directly (bypassing the dispatcher's
  // checkWorkspaceCapability gate), so connectWorkspace() re-checks JAILBOX_ENABLED
  // from process.env — its only env channel — and refuses unless opted in.
  // Parked by default: only forward when an operator has explicitly re-enabled it.
  if (cfg.jailbox.enabled) env.JAILBOX_ENABLED = '1';

  // Container-side retry tuning. job-agent.js reads this from process.env directly
  // (Docker is its only env channel); without forwarding, the configured value would
  // never reach the container.
  env.J41_RATE_LIMIT_BACKOFF_MULTIPLIER = String(cfg.retry.rate_limit_backoff_multiplier);

  // Token budget enforcement (WP-D4) — same dual-read pattern. The exchange
  // rate is stamped with a timestamp so token-budget.js can fail closed on
  // staleness. Operator-set config wins; otherwise the polled platform rate
  // (P0-2) is the default source; if neither exists nothing is forwarded and
  // the container falls back to fallback_token_budget.
  if (cfg.budget.vrsc_usd_rate > 0) {
    env.J41_VRSC_USD_RATE = String(cfg.budget.vrsc_usd_rate);
    env.J41_VRSC_USD_RATE_AT = String(Date.now());
  } else if (_polledVrscRate && _polledVrscRate.usdPerVrsc > 0) {
    env.J41_VRSC_USD_RATE = String(_polledVrscRate.usdPerVrsc);
    env.J41_VRSC_USD_RATE_AT = String(_polledVrscRate.at);
  }
  env.J41_VRSC_RATE_MAX_AGE_MS = String(cfg.budget.rate_max_age_ms);
  env.J41_BUDGET_SPEND_FRACTION = String(cfg.budget.spend_fraction);
  env.J41_FALLBACK_TOKEN_BUDGET = String(cfg.budget.fallback_token_budget);
  env.J41_BUDGET_WARNING_PERCENT = String(cfg.budget.warning_percent);
  env.J41_BUDGET_EXTENSION_WAIT_MS = String(cfg.budget.extension_wait_ms);

  return env;
}

// M7: Read per-agent executor config and return as env vars for container
function getExecutorEnvVars(agentInfo) {
  const envVars = [];
  const config = loadAgentConfig(agentInfo.id);

  if (config.executor) envVars.push(`J41_EXECUTOR=${config.executor}`);
  if (config.executorUrl) envVars.push(`J41_EXECUTOR_URL=${config.executorUrl}`);
  if (config.executorAuth) envVars.push(`J41_EXECUTOR_AUTH=${config.executorAuth}`);
  if (config.executorTimeout) envVars.push(`J41_EXECUTOR_TIMEOUT=${config.executorTimeout}`);
  // LangGraph-specific
  if (config.executorAssistant) envVars.push(`J41_EXECUTOR_ASSISTANT=${config.executorAssistant}`);
  // MCP-specific
  if (config.mcpCommand) envVars.push(`J41_MCP_COMMAND=${config.mcpCommand}`);
  if (config.mcpUrl) envVars.push(`J41_MCP_URL=${config.mcpUrl}`);
  if (config.mcpMaxRounds) envVars.push(`J41_MCP_MAX_ROUNDS=${config.mcpMaxRounds}`);
  // Per-agent LLM config (overrides global J41_LLM_* env vars)
  if (config.llmProvider) envVars.push(`J41_LLM_PROVIDER=${config.llmProvider}`);
  if (config.llmModel) envVars.push(`J41_LLM_MODEL=${config.llmModel}`);
  if (config.llmBaseUrl) envVars.push(`J41_LLM_BASE_URL=${config.llmBaseUrl}`);
  if (config.llmApiKey) {
    envVars.push(`J41_LLM_API_KEY=${config.llmApiKey}`);
    // Also set the provider-specific env var so resolveLLMConfig() picks it up
    if (config.llmProvider) {
      try {
        const { LLM_PRESETS } = require('./executors/local-llm.js');
        const preset = LLM_PRESETS[config.llmProvider];
        if (preset?.envKey) envVars.push(`${preset.envKey}=${config.llmApiKey}`);
      } catch {}
    }
  }

  return envVars;
}

// --- Dispatcher container security helpers (Plan B) ---

function buildDispatcherSecurityOpt() {
  const opts = ['no-new-privileges:true'];

  // Seccomp profile — deployed by @junction41/secure-setup
  // H5: check both /etc/j41 (system) and ~/.j41 (user) — prefer system install.
  const seccompPathSystem = '/etc/j41/seccomp-agent.json';
  const seccompPathUser   = path.join(os.homedir(), '.j41', 'seccomp-agent.json');
  let seccompPath = null;
  if (fs.existsSync(seccompPathSystem)) {
    seccompPath = seccompPathSystem;
  } else if (fs.existsSync(seccompPathUser)) {
    seccompPath = seccompPathUser;
  }
  if (seccompPath) {
    // The dockerode HostConfig.SecurityOpt API expects the seccomp profile
    // CONTENT (JSON), not a file path — only the `docker` CLI reads the file.
    // Passing a path makes the daemon try to JSON-parse "/etc/..." → HTTP 500.
    try {
      const profileJson = fs.readFileSync(seccompPath, 'utf8');
      JSON.parse(profileJson); // validate before handing it to the daemon
      opts.push(`seccomp=${profileJson}`);
    } catch (e) {
      console.warn(`[security] seccomp profile at ${seccompPath} unreadable/invalid JSON (${e.message}) — container runs WITHOUT syscall filtering`);
    }
  } else {
    console.warn('[security] seccomp profile not found at /etc/j41 or ~/.j41 — container runs WITHOUT syscall filtering');
  }

  // AppArmor — Linux only
  if (process.platform === 'linux') {
    try {
      const profiles = fs.readFileSync('/sys/kernel/security/apparmor/profiles', 'utf8');
      if (profiles.includes('j41-agent-profile')) {
        opts.push('apparmor=j41-agent-profile');
      } else {
        console.warn('[security] AppArmor profile j41-agent-profile not found — container runs WITHOUT AppArmor confinement');
      }
    } catch {
      // AppArmor not available — skip
    }
  }

  return opts;
}

function getDispatcherNetworkMode() {
  // Use the j41-isolated network only if the operator's secure-setup created it.
  // It MUST be egress-capable — the job agent has to reach the platform API + the
  // LLM endpoint. Do NOT auto-create it here: a dispatcher-created `--internal`
  // network has no external DNS/egress and silently breaks every job (M10 regression).
  try {
    require('child_process').execSync('docker network inspect j41-isolated', { stdio: 'ignore', timeout: 5000 });
    return 'j41-isolated';
  } catch {
    console.warn('[security] j41-isolated network absent — using the default bridge (egress works; less network isolation). Run @junction41/secure-setup to provision an egress-capable j41-isolated.');
    return 'bridge';
  }
}

function getDispatcherBwrapConfig() {
  // J41_DISABLE_BWRAP=1: skip the bubblewrap entrypoint wrapper. Useful for
  // broker validation where the bwrap --ro-bind /app /app re-mount obscures
  // the bind-mounted job-dir permissions. Trades the extra isolation layer
  // for clarity — Docker --user + ReadonlyRootfs + CapDrop still apply.
  if (process.env.J41_DISABLE_BWRAP === '1') return {};
  // If gVisor is NOT the runtime and bwrap IS installed, use bwrap entrypoint
  if (!secureSetup) return {};

  try {
    const isolation = secureSetup.detectIsolation();
    if (isolation.mode === 'bwrap') {
      const entrypointPath = path.join(
        require.resolve('@junction41/secure-setup').replace(/lib\/index\.js$/, ''),
        'scripts', 'entrypoint-agent.sh'
      );
      if (fs.existsSync(entrypointPath)) {
        // Audit 2026-06-02 L-DISPATCHER-funds-1 review note: SYS_ADMIN is
        // unavoidable here — bwrap needs it to call `unshare(CLONE_NEWNS|
        // CLONE_NEWUSER)`. The mitigating context is the LAYERED defense
        // around it:
        //   - Container is non-root (User: <uid>:<gid> in HostConfig)
        //   - ReadonlyRootfs: true
        //   - seccomp profile (no network/ptrace/mount syscalls)
        //   - AppArmor confinement
        //   - The bwrap-spawned inner namespace drops all caps again
        // So inside-the-container code that gains SYS_ADMIN sees only its
        // own bwrap-bounded view — it can't escape to the host. Auditors
        // should treat the SYS_ADMIN cap as scoped to the bwrap helper
        // process startup, not the agent process.
        return {
          CapAdd: ['SYS_ADMIN'],
          CapDrop: [], // Override: bwrap needs SYS_ADMIN for unshare
          Entrypoint: ['/bin/sh', entrypointPath],
        };
      }
    }
  } catch {
    // Detection failed — skip bwrap
  }

  return {};
}

function isGvisorAvailable() {
  try {
    const rt = require('child_process').execSync(
      'docker info --format "{{.DefaultRuntime}}"',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return rt === 'runsc';
  } catch {
    return false;
  }
}

let _storageOptSupported = null;
function supportsStorageOpt() {
  if (_storageOptSupported !== null) return _storageOptSupported;
  try {
    const driver = require('child_process').execSync(
      'docker info --format "{{.Driver}}"',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (driver !== 'overlay2') { _storageOptSupported = false; return false; }
    require('child_process').execSync(
      `mount | grep pquota`,
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    _storageOptSupported = true;
  } catch {
    _storageOptSupported = false;
  }
  return _storageOptSupported;
}

// Returns a write(text) fn that appends to logStream but never lets the file
// exceed maxBytes; emits a single truncation notice when the cap is first hit.
function makeCappedLogWriter(logStream, maxBytes) {
  let written = 0;
  let noticed = false;
  return (text) => {
    const r = applyLogCap(written, Buffer.from(text), maxBytes);
    written = r.written;
    if (r.data.length) logStream.write(r.data);
    if (r.truncated && !noticed) {
      noticed = true;
      logStream.write(`\n[output.log truncated at ${maxBytes} bytes]\n`);
    }
  };
}

// Read a file that may live under a container-writable job dir, refusing to
// follow symlinks — a malicious container could plant one to exfiltrate a host
// secret. Returns the content, or null if the path is a symlink (ELOOP) or
// the file no longer exists (ENOENT — handles concurrent removal safely).
/**
 * I2 — write a job file without following a symlink.
 *
 * Pause tears the container down but leaves `jobDir` in place; on resume
 * `startJobContainer` re-wrote `description.txt` with a plain `writeFileSync`, which
 * FOLLOWS symlinks. A container that plants one before it is paused gets an arbitrary
 * host path overwritten with up to 1 MB of buyer-authored text, running as the operator
 * user. The read path already had `readJobFileNoFollow`; the write path had no
 * counterpart — the same "control exists, not applied at the second site" shape the
 * audits reported four times.
 *
 * O_NOFOLLOW fails with ELOOP on a symlink; we unlink and retry once so a planted link
 * cannot wedge a legitimate resume.
 */
function writeJobFileNoFollow(p, data) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(p, flags, 0o600);
  } catch (e) {
    if (e.code !== 'ELOOP') throw e;
    console.warn(`  ⚠️  ${p} is a symlink — refusing to follow it. Removing and rewriting.`);
    try { fs.unlinkSync(p); } catch {}
    fd = fs.openSync(p, flags, 0o600);
  }
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}

function readJobFileNoFollow(p, enc = 'utf8') {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ELOOP' || e.code === 'ENOENT') return null; throw e; }
  try { return fs.readFileSync(fd, enc); } finally { fs.closeSync(fd); }
}

// Item C — host reports the one attach failure the container can't: it never
// spawned. Gated on non-reconnect status (a dispute/delivered respawn would 409)
// and fail-open (advisory — never affect the failure-cleanup path).
async function reportSpawnAttachFailed(state, agentInfo, job, reason, deps = {}) {
  if (job.status === 'delivered' || job.status === 'disputed') return;
  const getSession = deps.getAgentSession || getAgentSession;
  try {
    const agent = await getSession(state, agentInfo);
    await agent.client.reportWorkerAttachFailed(job.id, reason);
  } catch (e) {
    console.error(`[ATTACH] host spawn-fail report failed (non-fatal): ${e.message}`);
  }
}

// Start a job container
async function startJobContainer(state, job, agentInfo) {
  if (!isValidJobId(job.id)) { console.error(`[security] Refusing job with invalid id: ${String(job.id).slice(0,40)}`); return; }
  if (!docker) {
    throw new Error('Docker not available. Switch to local mode: j41-dispatcher config --runtime local');
  }
  const jobDir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  // Ensure writable by the dispatcher UID only (container runs as User: <uid>:<gid>
  // so the bind-mounted jobDir is accessible). 0o700 keeps other host users out.
  try {
    fs.chmodSync(jobDir, 0o700);
  } catch {
    // best effort
  }
  
  // Audit 2026-06-02 M-DISPATCHER-ddos-4: cap platform-supplied job.description
  // length before writing to disk. A compromised/MITM'd platform could otherwise
  // ship a 100 GB description and exhaust the operator's disk.
  const MAX_DESCRIPTION_BYTES = Number(process.env.J41_JOB_DESCRIPTION_MAX_BYTES || 1024 * 1024); // 1 MB
  const desc = typeof job.description === 'string' ? job.description : '';
  if (desc.length > MAX_DESCRIPTION_BYTES) {
    throw new Error(`job.description exceeds ${MAX_DESCRIPTION_BYTES} bytes (${desc.length}); refusing to write`);
  }

  // Write job data
  writeJobFileNoFollow(path.join(jobDir, 'description.txt'), desc);
  // I2 — every one of these is the same symlink-following write on the same
  // pause/resume rewrite path. Guarding description.txt alone left four more: a
  // container that plants `buyer.txt -> ~/.ssh/authorized_keys` before pause gets
  // that file truncated and overwritten with buyer-controlled text on resume. The
  // payload is smaller than description's 1 MB; the primitive is identical.
  writeJobFileNoFollow(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);
  writeJobFileNoFollow(path.join(jobDir, 'amount.txt'), String(job.amount));
  writeJobFileNoFollow(path.join(jobDir, 'currency.txt'), job.currency);

  // Mandatory canary token (Plan B: every job gets one)
  const canaryToken = require('crypto').randomBytes(32).toString('hex');
  writeJobFileNoFollow(path.join(jobDir, 'canary.token'), canaryToken);
  try { fs.chmodSync(path.join(jobDir, 'canary.token'), 0o600); } catch {}

  const agentDir = path.join(AGENTS_DIR, agentInfo.id);
  const keysPath = path.join(agentDir, 'keys.json');

  // BROKER MODE (mandatory): the WIF stays on host inside a SignChannelHost
  // closure; the container only ever sees the bind-mounted JSON channel at
  // /app/sign. The legacy path that copied keys.json into the (prompt-
  // injectable, network-egress) job container has been removed entirely.
  let signerChannelDir = null;
  let signerHost = null;
  let signerTeardown = null;
  let egressToken;
  const hostKeys = readKeysFile(keysPath);

  // Audit C3: mounting the agent's private key inside a prompt-injectable job
  // container that has network egress let untrusted in-container code read it
  // (the :ro flag blocks writes, not reads) and sign/spend arbitrarily. The
  // host-side signing broker fully supersedes that path, so broker signing is
  // now MANDATORY on every network. Fail closed if it is disabled.
  if (!SIGNING_BROKER_ENABLED) {
    throw new Error(
      'Refusing to launch a job with J41_SIGNING_BROKER=0: the host-side signing broker is required ' +
      'so the agent WIF never enters the prompt-injectable job container. Remove J41_SIGNING_BROKER=0.',
    );
  }

  {
    signerChannelDir = path.join(os.tmpdir(), `j41-sign-${job.id}`);
    const { executors, teardown } = defaultExecutors({
      apiUrl: cfg.platform.api_url,
      wif: hostKeys.wif,
      identityName: agentInfo.identity,
      iAddress: hostKeys.iAddress,
      network: cfg.platform.network,
    });
    signerTeardown = teardown;
    signerHost = new SignChannelHost({
      channelDir: signerChannelDir,
      jobId: job.id,
      wif: hostKeys.wif,
      network: cfg.platform.network,
      // Authoritative job lookup: re-fetch from the platform every time the
      // broker needs to verify a sign request. The dispatcher trusts ONLY
      // the platform for amount/buyer/jobHash — never the container.
      getJob: async () => {
        // Lazy + cheap: use a temporary J41Client session per call. The
        // platform's read endpoint is cached server-side so this is fine.
        // eslint-disable-next-line global-require
        const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
        const a = new J41Agent({
          apiUrl: cfg.platform.api_url,
          wif: hostKeys.wif,
          identityName: agentInfo.identity,
          iAddress: hostKeys.iAddress,
        });
        await a.authenticate();
        try {
          const j = await a.client.getJob(job.id);
          return j;
        } finally {
          a.stop();
        }
      },
      executors,
      log: (line) => console.log(`  [sign-channel ${job.id.substring(0, 8)}] ${line}`),
    });
    await signerHost.start();
    console.log(`  🔒 Signing broker active for ${job.id} (channel: ${signerChannelDir})`);
  }

  try {
    const keepContainers = cfg.runtime.keep_containers;
    const containerName = `j41-job-${job.id}`;

    // Remove stale container with same name (leftover from crash/restart)
    try {
      require('child_process').execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 10000 });
      console.log(`  ♻️  Removed stale container ${containerName}`);
    } catch {}

    // Broker env: tell job-agent.js to use the channel and pass the iAddress
    // (there is no keys.json inside the container to read it from). The
    // defensive guard in job-agent.js refuses to start if J41_SIGNING_BROKER=1
    // and /app/keys.json *also* exists.
    const brokerEnv = [`J41_SIGNING_BROKER=1`, `J41_SIGNING_CHANNEL_DIR=/app/sign`, `J41_IADDRESS=${hostKeys.iAddress}`];

    // The container only ever sees the bind-mounted JSON signing channel — never the WIF.
    const signingBinds = [`${signerChannelDir}:/app/sign`]; // rw — container writes req/, reads resp/

    // M1: build HostConfig as a variable so we can patch CapDrop after the
    // bwrap spread (which returns CapDrop:[] + CapAdd:['SYS_ADMIN'] and would
    // otherwise silently wipe the 'ALL' drop).
    const hostConfig = {
      Binds: [
        // job dir must be writable for attestation artifacts (creation/deletion json)
        `${jobDir}:/app/job`,
        ...signingBinds,
        `${path.join(agentDir, 'SOUL.md')}:/app/SOUL.md:ro`,
      ],
      AutoRemove: !keepContainers,
      Memory: 2 * 1024 * 1024 * 1024, // 2GB
      CpuQuota: 100000, // 1 CPU core
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      PidsLimit: 64,
      CapDrop: ['ALL'],
      // The sandbox performs NO DNS — all name resolution happens at the host egress
      // proxy, which receives the hostname via HTTP CONNECT. Setting an unusable resolver
      // (0.0.0.0) prevents the container from falling back to Docker's embedded
      // 127.0.0.11 resolver, which the bridge firewall cannot block (dockerd forwards
      // those lookups from the host netns, not via the bridge).
      Dns: ['0.0.0.0'],
      // --- Security hardening (Plan B) ---
      SecurityOpt: buildDispatcherSecurityOpt(),
      NetworkMode: getDispatcherNetworkMode(),
      ...(supportsStorageOpt() ? { StorageOpt: { size: '1G' } } : {}),
      OomScoreAdj: 1000,
      // gVisor runtime (if configured as Docker default)
      ...(isGvisorAvailable() ? { Runtime: 'runsc' } : {}),
      ...(getDispatcherBwrapConfig()),
    };
    // M1: if bwrap added SYS_ADMIN (CapDrop:[] wipes the 'ALL' drop), restore
    // a scoped explicit drop-list keeping ONLY SYS_ADMIN.
    if (hostConfig.CapAdd && hostConfig.CapAdd.includes('SYS_ADMIN')) {
      hostConfig.CapDrop = ['CHOWN','DAC_OVERRIDE','FOWNER','FSETID','KILL','MKNOD','NET_BIND_SERVICE','NET_RAW','SETGID','SETUID','SETFCAP','SETPCAP','SYS_CHROOT','AUDIT_WRITE'];
    }
    // Per-job egress allowlist + token (sandbox reaches ONLY the proxy).
    const containerEnvObj = buildContainerEnv(job, agentInfo, loadAgentConfig(agentInfo.id), canaryToken, jobDir, keysPath);
    egressToken = crypto.randomBytes(32).toString('hex');
    // Derive allowlist from the FULLY-MERGED effective env — same overlay precedence
    // as the container Env array below (getExecutorEnvVars non-LLM entries win over base).
    // Without this merge, agents using per-agent executorUrl/mcpUrl would have their
    // real endpoint absent from the allowlist and every outbound call 403'd.
    const mergedEnvForEgress = { ...containerEnvObj };
    for (const s of getExecutorEnvVars(agentInfo)) {
      if (s.startsWith('J41_LLM_')) continue; // filtered in container Env array too
      const eq = s.indexOf('=');
      if (eq > 0) mergedEnvForEgress[s.slice(0, eq)] = s.slice(eq + 1);
    }
    const egressHosts = deriveAllowedHosts(mergedEnvForEgress);
    if (state.egressProxy) state.egressProxy.register(egressToken, egressHosts);

    const container = await docker.createContainer({
      name: containerName,
      Image: 'j41/job-agent:latest',  // PRE-BAKED IMAGE
      // Run as host UID so bind-mounted job dir is writable. MUST be at the
      // top level of the createContainer body — `User` under HostConfig is
      // silently ignored by the Docker engine, which then falls back to the
      // Dockerfile's USER j41-agent (UID ~999) and EACCES on bind-mounted
      // files written by the host user.
      User: `${process.getuid()}:${process.getgid()}`,
      // Docker bind-mounts SOUL.md/job (and the /app/sign channel) into /app/* —
      // strip the host-path env vars buildContainerEnv emits (they're host paths and
      // would override the in-container defaults the job-agent expects).
      Env: Object.entries(containerEnvObj)
            .filter(([k, v]) => v !== undefined && v !== '' &&
              k !== 'J41_KEYS_FILE' && k !== 'J41_SOUL_FILE' && k !== 'J41_JOB_DIR')
            .map(([k, v]) => `${k}=${v}`)
            .concat(getExecutorEnvVars(agentInfo).filter(s => !s.startsWith('J41_LLM_')))
            .concat(brokerEnv)
            .concat([
              `J41_EGRESS_PROXY=http://${state.gatewayIp}:${EGRESS_PROXY_PORT}`,
              `J41_EGRESS_TOKEN=${egressToken}`,
            ]),
      HostConfig: hostConfig,
      Labels: {
        'j41.job.id': job.id,
        'j41.agent.id': agentInfo.id,
        'j41.started': String(Date.now()),
        'j41.ephemeral': 'true',
      },
    });
    
    await container.start();

    // A brand-new container has received NOTHING. `_lastSentStatus` survives the
    // death of the container it describes, and the transition check skips any
    // status equal to it — so a respawned worker (dispute respawn, crash retry)
    // would never be told the job is in `rework`, and would sit waiting for an
    // IPC that was "already sent" to a process that no longer exists.
    state._lastSentStatus.delete(job.id);

    state.active.set(job.id, {
      agentId: agentInfo.id,
      job,
      container,
      startedAt: Date.now(),
      agentInfo,
      workspaceNotified: false,
      workspaceChecked: false,
      jobAmount: job.amount || 0,
      buyerPayAddress: job.buyerPayAddress || job.buyer?.payAddress || null,
      currency: job.currency || 'VRSC',
      agentInfoId: agentInfo.id,
      reworkCount: 0,
      reactivationFee: job.lifecycle?.reactivationFee ?? null,
      pauseCount: 0,
      pauseTtlMin: job.lifecycle?.pauseTTL || 60,
      // Broker-mode resources — tracked here so stopJobContainer can tear them down.
      _signerHost: signerHost,
      _signerChannelDir: signerChannelDir,
      _signerTeardown: signerTeardown,
      _egressToken: egressToken,
    });

    // Deliver the dispute policy + markup to the container.
    //
    // The local-fork path sends this over Node IPC (`child.send`), which a Docker
    // container does not have — so until now `_disputePolicy` was null in EVERY
    // production container. Two things silently did not work as a result:
    //   - the rework token budget (30% share) was never applied, so rework ran
    //     unmetered; and
    //   - the `maxReworkCycles` guard was inert, so rework cycles were unbounded.
    // The container's file-IPC handler already accepts `dispute_policy`
    // (job-agent.js), so this only ever needed sending down the right channel.
    // Best-effort by design: a failure here must not fail the job, but it is
    // logged rather than swallowed so an inert policy is visible.
    try {
      const sent = sendToJobAgent(state.active.get(job.id), {
        type: 'dispute_policy',
        disputePolicy: state.disputePolicy?.get(agentInfo.id) || null,
        agentMarkup: state.agentMarkup?.get(agentInfo.id) || 15,
      });
      if (!sent) console.warn(`[Start] ${agentInfo.id}: could not deliver dispute policy to the container — rework will be unmetered for job ${job.id.substring(0, 8)}`);
    } catch (e) {
      console.warn(`[Start] ${agentInfo.id}: dispute policy delivery failed (${e.message}) — rework will be unmetered`);
    }

    state.emitEvent?.('container.started', {
      jobId: job.id, agentId: agentInfo.id, container: container?.name || null, runtime: 'docker',
    });
    state.emitEvent?.('job.started', { jobId: job.id, agentId: agentInfo.id });

    // Mark as seen immediately to avoid duplicate pickup loops while status remains requested
    state.seen.set(job.id, Date.now());
    try { saveSeenJobs(state.seen); } catch (e) { console.error(`[Start] saveSeenJobs failed: ${e.message}`); }
    
    // Remove from available pool
    state.available = state.available.filter(a => a.id !== agentInfo.id);
    persistActiveJobs(state.active);

    console.log(`✅ Container started for job ${job.id}`);

    // Stream container logs to the dispatcher console AND a per-job output.log,
    // so `logs`/`logs -f`/the TUI tail work for container jobs (parity with the
    // local-exec path). Best-effort: log failures never affect the job.
    try {
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: false,
      });
      const shortId = job.id.substring(0, 8);
      fs.mkdirSync(path.join(JOBS_DIR, '_live'), { recursive: true, mode: 0o700 });
      const logPath = liveLogPath(JOBS_DIR, job.id);
      const fileStream = fs.createWriteStream(logPath, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, mode: 0o600 });
      fileStream.on('error', () => {}); // disk full / racey rm — non-fatal
      fileStream.write(`[${new Date().toISOString()}] Container started — agent: ${agentInfo.id}, container: ${containerName}\n`);
      const writeCapped = makeCappedLogWriter(fileStream, cfg.runtime.job_log_max_bytes);

      const activeEntry = state.active.get(job.id);

      // Capture the container's exit status for retention decisions at teardown.
      // Bind to THIS generation's active entry (not a re-fetch by id) so a
      // late-resolving wait() from a retried same-id container can't stamp its
      // StatusCode onto the new entry and wrongly archive a clean retry.
      container.wait().then((r) => {
        if (activeEntry) activeEntry._exitCode = r && r.StatusCode;
      }).catch(() => {});

      logStream.on('data', (chunk) => {
        // Docker multiplexed stream: first 8 bytes are header, rest is payload
        const lines = chunk.toString('utf8').replace(/[\x00-\x08]/g, '').trim();
        if (lines) {
          writeCapped(lines + '\n');
          for (const line of lines.split('\n')) {
            const clean = line.trim();
            if (clean) console.log(`  [${shortId}] ${clean}`);
          }
        }
      });
      logStream.on('end', () => {
        try { fileStream.end(`[${new Date().toISOString()}] Container exited\n`); } catch { /* already closed */ }
      });
      logStream.on('error', () => { try { fileStream.end(); } catch { /* noop */ } });

      if (activeEntry) activeEntry._logStream = fileStream;
    } catch (e) {
      // Non-fatal: log streaming is for debugging only
    }

    // Set timeout — offset +60s from container's internal timeout
    // so the container can self-terminate and submit attestation first
    const _timeoutTimer = setTimeout(async function _onJobTimeout() {
      const active = state.active.get(job.id);
      // L3 — do NOT kill a worker that is legitimately holding an open dispute.
      //
      // 2.17.1 taught the CONTAINER's own timer to defer for a dispute hold, and that
      // was reported as the fix. It was half of it: this dispatcher-side timer fires
      // at JOB_TIMEOUT_MS + 60s and kills the container regardless. The reconciler then
      // respawns, each replacement dies at ~61 min, and after 3 attempts it gives up
      // "until the dispatcher restarts" — roughly three hours against a deadline
      // measured in days. A fourth clock nobody had counted.
      //
      // Uses the status the transition check already maintains, so this costs no API
      // call. Bounded by the container's own dispute hold (J41_DISPUTE_HOLD_MAX_MS),
      // which still ends the worker, so this cannot defer forever.
      const _st = state._lastSentStatus?.get(job.id);
      if (active && (_st === 'disputed' || _st === 'rework')) {
        active._disputeDeferrals = (active._disputeDeferrals || 0) + 1;
        if (active._disputeDeferrals <= 12) { // 12 x (timeout+60s) ~= 12h ceiling
          console.log(`⏰ Job ${job.id.substring(0, 8)} hit the dispatcher timeout but is ${_st} — ` +
            `deferring the kill (${active._disputeDeferrals}/12); the container's own hold still bounds it.`);
          active._timeoutTimer = setTimeout(_onJobTimeout, JOB_TIMEOUT_MS + 60000);
          return;
        }
        console.log(`⏰ Job ${job.id.substring(0, 8)} is ${_st} but has deferred 12 times — killing.`);
      }
      if (active) {
        active._killed = true;
        console.log(`⏰ Job ${job.id} timeout, killing container`);
        await stopJobContainer(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);

    // Store timer ref so it can be cleared on job cleanup
    const activeEntry = state.active.get(job.id);
    if (activeEntry) activeEntry._timeoutTimer = _timeoutTimer;

  } catch (e) {
    console.error(`❌ Failed to start container for ${job.id}:`, e.message);
    await reportSpawnAttachFailed(state, agentInfo, job, 'spawn-error: ' + e.message);
    // Clean up broker/signer resources that were allocated before the failure
    // (state.active was never set, so stopJobContainer would early-return)
    try { if (signerHost) await signerHost.destroy(); } catch {}
    try { if (signerTeardown) await signerTeardown(); } catch {}
    try { if (state.egressProxy && egressToken) state.egressProxy.revoke(egressToken); } catch {}
    // Return agent to pool
    state.available.push(agentInfo);
  }
}

// Archive a finished job's live log (_live/<jobId>.log) to _logs/<jobId>.log
// when the retention policy says to keep it, then prune to job_log_max_retained.
// Reads and writes via fd with O_NOFOLLOW to refuse symlink attacks.
// Best-effort: never throws into the cleanup path.
function archiveJobLog(jobsDir, jobId, exitInfo) {
  try {
    const live = liveLogPath(jobsDir, jobId);
    let fd;
    try { fd = fs.openSync(live, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (e) {
      if (e.code === 'ENOENT') return;
      if (e.code === 'ELOOP') { console.error(`[Logs] refusing symlinked log for ${jobId}`); return; }
      throw e;
    }
    try {
      const retention = resolveLogRetention(cfg);
      if (shouldArchiveLog(retention, exitInfo)) {
        const archiveDir = path.join(jobsDir, '_logs');
        fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
        const data = fs.readFileSync(fd);
        const wfd = fs.openSync(archiveLogPath(jobsDir, jobId), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(wfd, data); } finally { fs.closeSync(wfd); }
        const entries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.log'))
          .map(f => ({ id: f.slice(0, -4), mtimeMs: fs.statSync(path.join(archiveDir, f)).mtimeMs }));
        for (const id of selectLogsToPrune(entries, cfg.runtime.job_log_max_retained))
          fs.rmSync(path.join(archiveDir, `${id}.log`), { force: true });
      }
    } finally { fs.closeSync(fd); }
    fs.rmSync(live, { force: true });
  } catch (e) { console.error(`[Logs] archive failed for ${jobId}: ${e.message}`); }
}

// Prune _lastExtensionCheck entries for a finished job. The map is keyed by
// ext.id (not jobId), so we can't delete(jobId) — we scan and drop every entry
// whose stored { ts, jobId } belongs to this job. This keeps the map bounded
// across many jobs. n is tiny (extension requests for active jobs only).
function pruneExtensionChecks(state, jobId) {
  for (const [extId, val] of state._lastExtensionCheck) {
    if (val && val.jobId === jobId) state._lastExtensionCheck.delete(extId);
  }
}

// Stop a job container
async function stopJobContainer(state, jobId, skipReturnAgent = false) {
  const active = state.active.get(jobId);
  if (!active) return;
  if (active._stopping) return;
  active._stopping = true;

  try {
    await active.container.stop();
    // AutoRemove will delete it
  } catch (e) {
    if (String(e.message || '').includes('404') || String(e.message || '').includes('No such container')) {
      // already gone; ignore noisy Docker cleanup errors
    } else {
      console.error(`[Cleanup] Error stopping ${jobId}:`, e.message);
    }
  }

  // Tear down the signing broker (broker mode): stop the watcher, run the
  // executor teardown (closes the cached J41Agent inside the executors), and
  // remove the channel directory. Best-effort — log on failure but don't
  // block job cleanup.
  if (active._signerHost) {
    try {
      await active._signerHost.destroy();   // includes channel-dir rm
    } catch (e) {
      console.error(`[Cleanup] signer host destroy failed for ${jobId}:`, e.message);
    }
  }
  if (active._signerTeardown) {
    try { await active._signerTeardown(); } catch { /* best-effort */ }
  }
  if (active._egressToken && state.egressProxy) {
    try { state.egressProxy.revoke(active._egressToken); } catch { /* best-effort */ }
  }

  // Drain the per-job log stream before archiving. end() only *initiates* the
  // flush; we await 'finish' so copyFileSync sees the final buffered bytes
  // (exit banner + any queued tail) rather than racing them to disk.
  if (active._logStream) {
    await new Promise(resolve => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      try { active._logStream.end(fin); } catch { fin(); /* already closed */ }
      setTimeout(fin, 1000).unref(); // never block teardown on a wedged/destroyed stream
    });
  }

  // Cleanup job dir (retain for debugging if requested). Archive even when
  // keep_containers is on; the _logs/ copy is independent of the retained dir.
  const jobDir = path.join(JOBS_DIR, jobId);
  archiveJobLog(JOBS_DIR, jobId, { exitCode: active._exitCode, killed: active._killed });
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    try { fs.rmSync(jobDir, { recursive: true }); }
    catch (e) { console.error(`[Cleanup] failed to remove ${jobDir}: ${e.message}`); }
  }

  // Return agent to pool (unless retrying or already returned during pause)
  if (!skipReturnAgent && !active.paused) {
    state.available.push(active.agentInfo);
    state.retries.delete(jobId);
  } else if (!skipReturnAgent && active.paused) {
    state.retries.delete(jobId);
  }
  // Clear timeout timer to prevent leak
  if (active._timeoutTimer) clearTimeout(active._timeoutTimer);

  state.active.delete(jobId);
  persistActiveJobs(state.active);

  // Prune per-job tracking Maps to prevent memory leaks
  state._lastSentStatus.delete(jobId);
  pruneExtensionChecks(state, jobId);
  state._pendingWorkspace.delete(jobId);
  state.pendingPayment.delete(jobId);

  // ── Allowlist lifecycle: remove buyer address ──
  removeActiveJobFromAllowlist(jobId);
  dispatcherSendHistory.perJob.delete(jobId);

  if (!skipReturnAgent) {
    console.log(`✅ Job ${jobId} complete, agent returned to pool`);
  }
}

// ─────────────────────────────────────────
// Local process mode — spawn job-agent.js as child process
// ─────────────────────────────────────────

async function startJobLocal(state, job, agentInfo) {
  if (!isValidJobId(job.id)) { console.error(`[security] Refusing job with invalid id: ${String(job.id).slice(0,40)}`); return; }
  // Security gate: block local mode unless --dev-unsafe was passed
  if (!state._devUnsafe) {
    console.error('');
    console.error('  ============================================================');
    console.error('  BLOCKED: Local mode runs agents with ZERO isolation.');
    console.error('  The agent process has full access to this machine.');
    console.error('');
    console.error('  To use local mode for development ONLY:');
    console.error('    j41-dispatcher start --dev-unsafe');
    console.error('');
    console.error('  For production: switch to docker runtime:');
    console.error('    j41-dispatcher config --runtime docker');
    console.error('  ============================================================');
    console.error('');
    throw new Error('Local mode blocked — use --dev-unsafe for development');
  }
  const jobDir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  // Write job data (same as Docker mode)
  writeJobFileNoFollow(path.join(jobDir, 'description.txt'), job.description);
  // I2 — every one of these is the same symlink-following write on the same
  // pause/resume rewrite path. Guarding description.txt alone left four more: a
  // container that plants `buyer.txt -> ~/.ssh/authorized_keys` before pause gets
  // that file truncated and overwritten with buyer-controlled text on resume. The
  // payload is smaller than description's 1 MB; the primitive is identical.
  writeJobFileNoFollow(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);
  writeJobFileNoFollow(path.join(jobDir, 'amount.txt'), String(job.amount));
  writeJobFileNoFollow(path.join(jobDir, 'currency.txt'), job.currency);

  // Mandatory canary token (Plan B: every job gets one)
  const canaryToken = require('crypto').randomBytes(32).toString('hex');
  writeJobFileNoFollow(path.join(jobDir, 'canary.token'), canaryToken);
  try { fs.chmodSync(path.join(jobDir, 'canary.token'), 0o600); } catch {}

  const agentDir = path.join(AGENTS_DIR, agentInfo.id);
  const keysPath = path.join(agentDir, 'keys.json');

  // Build env vars — explicit whitelist only (C2 fix: no ...process.env spread)
  const WHITELISTED_ENV = [
    'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'NODE_ENV',
    'HOSTNAME', 'TZ', 'NODE_PATH',
  ];
  const env = {};
  for (const key of WHITELISTED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // Platform/job/LLM config — sourced from cfg, NOT process.env. Provider keys
  // come from cfg.provider_keys; never inherit from dispatcher's environment.
  const containerEnv = buildContainerEnv(job, agentInfo, loadAgentConfig(agentInfo.id), canaryToken, jobDir, keysPath);
  for (const [k, v] of Object.entries(containerEnv)) {
    if (v !== undefined && v !== '') env[k] = String(v);
  }
  // Per-agent executor env vars (from agent-config.json) — preserves webhook /
  // langgraph URLs and other per-agent fields not covered by buildContainerEnv.
  const executorVars = getExecutorEnvVars(agentInfo);
  for (const s of executorVars) {
    const eq = s.indexOf('=');
    if (eq > 0 && !s.startsWith('J41_LLM_')) env[s.slice(0, eq)] = s.slice(eq + 1);
  }

  try {
    const child = spawn('node', [path.join(__dirname, 'job-agent.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: path.resolve(__dirname, '..'),
    });

    const shortId = job.id.substring(0, 8);
    fs.mkdirSync(path.join(JOBS_DIR, '_live'), { recursive: true, mode: 0o700 });
    const logPath = liveLogPath(JOBS_DIR, job.id);
    const logStream = fs.createWriteStream(logPath, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, mode: 0o600 });
    logStream.write(`[${new Date().toISOString()}] Job started — agent: ${agentInfo.id}, PID: ${child.pid}\n`);
    const writeCapped = makeCappedLogWriter(logStream, cfg.runtime.job_log_max_bytes);

    child.stdout.on('data', (data) => {
      const text = data.toString();
      writeCapped(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  [${shortId}] ${line.trim()}`);
      });
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      writeCapped(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.error(`  [${shortId}] ${line.trim()}`);
      });
    });

    child.on('exit', (code, signal) => {
      logStream.write(`[${new Date().toISOString()}] Job process exited\n`);
      logStream.end();
      const a = state.active.get(job.id);
      if (a) { a._exitCode = code; a._killed = !!signal; }
      // Unexpected exit (non-zero, not a clean signal) counts as a crash for
      // the health document's containers_unhealthy rollup.
      if (code && code !== 0) {
        const n = (state._containerCrashes.get(agentInfo.id) || 0) + 1;
        state._containerCrashes.set(agentInfo.id, n);
        state._agentErrors.set(agentInfo.id, `job process exited with code ${code}${signal ? ` (${signal})` : ''}`);
        state.emitEvent?.('container.died', { jobId: job.id, agentId: agentInfo.id, code, signal: signal || null });
      }
    });

    // Handle IPC from job-agent
    child.on('message', (msg) => {
      if (msg?.type === 'job_idle') {
        const info = state.active.get(msg.jobId);
        // Guard: don't re-pause if a resume webhook already cleared it (race condition)
        if (info && !info.paused && !info.resumedAt) {
          moveJobToReactivationQueue(state, msg.jobId).catch(e => console.error('[Reactivation] pause failed:', e.message));
        }
      }
      if (msg?.type === 'extension_needed') {
        console.log(`[Extension] Job ${msg.jobId?.substring(0, 8)} requesting extension: ${msg.amount} ${msg.currency || 'VRSC'} for ~${msg.estimatedTokens} tokens`);
        // Remember the ask so extension_approved can grant the right token
        // count even when the platform webhook doesn't echo estimatedTokens.
        const extInfo = state.active.get(msg.jobId);
        if (extInfo) extInfo.pendingExtensionTokens = msg.estimatedTokens;
        state.emitEvent?.('extension.requested', {
          jobId: msg.jobId, amount: msg.amount, currency: msg.currency || 'VRSC',
          estimatedTokens: msg.estimatedTokens, reason: msg.reason,
        });
        (async () => {
          try {
            const agent = await getAgentSession(state, agentInfo);
            // Pass estimatedTokens (SDK 2.7.0) so the platform can echo it on
            // approval and we grant exactly the requested amount (WP-D4 P1-1).
            await agent.client.requestExtension(msg.jobId, msg.amount, msg.reason, msg.estimatedTokens);
            console.log(`[Extension] Submitted to platform for buyer approval`);
          } catch (e) {
            console.error(`[Extension] Failed to submit: ${e.message}`);
          }
        })();
      }
      if (msg?.type === 'token_usage') {
        const info = state.active.get(msg.jobId);
        if (info) {
          info.tokenUsage = msg.usage;
          console.log(`[TOKENS] Job ${msg.jobId.substring(0, 8)}: ${msg.usage.llmCalls} calls, ${msg.usage.promptTokens} in, ${msg.usage.completionTokens} out, ${msg.usage.totalTokens} total`);
        }
      }
    });

    // Send dispute policy + markup via IPC (complex objects, not suitable for env)
    if (child.connected) {
      child.send({
        type: 'dispute_policy',
        disputePolicy: state.disputePolicy?.get(agentInfo.id) || null,
        agentMarkup: state.agentMarkup?.get(agentInfo.id) || 15,
      });
    }

    // See the Docker path: a fresh worker has received nothing, so a stale
    // last-sent status must not suppress the next transition message.
    state._lastSentStatus.delete(job.id);

    state.active.set(job.id, {
      agentId: agentInfo.id,
      job,
      process: child,
      pid: child.pid,
      startedAt: Date.now(),
      agentInfo,
      workspaceNotified: false,
      workspaceChecked: false,
      pauseTTL: job.lifecycle?.pauseTTL || 60,
      pauseTtlMin: job.lifecycle?.pauseTTL || 60,
      jobAmount: job.amount || 0,
      buyerPayAddress: job.buyerPayAddress || job.buyer?.payAddress || null,
      currency: job.currency || 'VRSC',
      agentInfoId: agentInfo.id,
      reworkCount: 0,
      _logStream: logStream,
    });

    state.emitEvent?.('container.started', {
      jobId: job.id, agentId: agentInfo.id, pid: child.pid, runtime: 'local',
    });
    state.emitEvent?.('job.started', { jobId: job.id, agentId: agentInfo.id });

    state.seen.set(job.id, Date.now());
    saveSeenJobs(state.seen);
    state.available = state.available.filter(a => a.id !== agentInfo.id);
    persistActiveJobs(state.active);

    log.info('Job process started', { jobId: job.id, pid: child.pid, agentId: agentInfo.id });

    // Timeout
    const _timeoutTimer = setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        console.log(`⏰ Job ${job.id} timeout, killing process`);
        await stopJobLocal(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);

    // Store timer ref so it can be cleared on job cleanup
    const activeEntry = state.active.get(job.id);
    if (activeEntry) activeEntry._timeoutTimer = _timeoutTimer;

  } catch (e) {
    console.error(`❌ Failed to start local process for ${job.id}:`, e.message);
    await reportSpawnAttachFailed(state, agentInfo, job, 'spawn-error: ' + e.message);
    state.available.push(agentInfo);
  }
}

async function stopJobLocal(state, jobId, skipReturnAgent = false) {
  const active = state.active.get(jobId);
  if (!active) return;
  if (active._stopping) return;
  active._stopping = true;

  // Kill the child process
  try {
    if (active.process && !active.process.killed) {
      active.process.kill('SIGTERM');
      // Give 5s for graceful shutdown, then SIGKILL
      await new Promise(resolve => {
        const forceTimer = setTimeout(() => {
          try { if (!active.process.killed) active.process.kill('SIGKILL'); } catch {}
          resolve();
        }, 5000);
        active.process.on('exit', () => { clearTimeout(forceTimer); resolve(); });
      });
    }
  } catch {
    // already dead
  }

  // Drain the per-job log stream before archiving. The child's exit handler
  // calls logStream.end() but that flush is async; await 'finish' so the
  // archive copy includes the last buffered bytes.
  if (active._logStream) {
    await new Promise(resolve => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      try { active._logStream.end(fin); } catch { fin(); /* already closed */ }
      setTimeout(fin, 1000).unref(); // never block teardown on a wedged/destroyed stream
    });
  }

  // Cleanup job dir. Archive even when keep_containers is on; the _logs/ copy
  // is independent of the retained dir.
  const jobDir = path.join(JOBS_DIR, jobId);
  archiveJobLog(JOBS_DIR, jobId, { exitCode: active._exitCode, killed: active._killed });
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    try { fs.rmSync(jobDir, { recursive: true }); }
    catch (e) { console.error(`[Cleanup] failed to remove ${jobDir}: ${e.message}`); }
  }

  // Only return agent to pool if not already returned during pause
  if (!skipReturnAgent && !active.paused) {
    state.available.push(active.agentInfo);
    state.retries.delete(jobId);
  } else if (!skipReturnAgent && active.paused) {
    // Agent already in available pool from pause — just clean up retries
    state.retries.delete(jobId);
  }
  // Clear timeout timer to prevent leak
  if (active._timeoutTimer) clearTimeout(active._timeoutTimer);

  state.active.delete(jobId);
  persistActiveJobs(state.active);

  // Prune per-job tracking Maps to prevent memory leaks
  state._lastSentStatus.delete(jobId);
  pruneExtensionChecks(state, jobId);
  state._pendingWorkspace.delete(jobId);
  state.pendingPayment.delete(jobId);

  // ── Allowlist lifecycle: remove buyer address ──
  removeActiveJobFromAllowlist(jobId);
  dispatcherSendHistory.perJob.delete(jobId);

  if (!skipReturnAgent) {
    console.log(`✅ Job ${jobId} complete, agent returned to pool`);
  }
}

// Unified dispatch — routes to Docker or local based on runtime config
async function startJob(state, job, agentInfo) {
  if (RUNTIME === 'docker') {
    await startJobContainer(state, job, agentInfo);
  } else {
    await startJobLocal(state, job, agentInfo);
  }
}

// Cleanup completed jobs — includes retry logic (F-14)
async function cleanupCompletedJobs(state) {
  for (const [jobId, active] of state.active) {
    if (RUNTIME === 'local') {
      // Local mode: check if child process exited
      if (active.process && active.process.exitCode !== null) {
        const exitCode = active.process.exitCode;
        console.log(`🗑️  Process for job ${jobId} stopped (exit ${exitCode})`);

        if (exitCode !== 0) {
          const retries = state.retries.get(jobId) || 0;
          if (retries < MAX_RETRIES) {
            state.retries.set(jobId, retries + 1);
            console.log(`🔄 Retrying job ${jobId} (attempt ${retries + 2}/${MAX_RETRIES + 1})`);
            const agentInfo = active.agentInfo;
            let job;
            try {
              const agent = await getAgentSession(state, agentInfo);
              job = await agent.client.getJob(jobId);
            } catch (fetchErr) {
              console.error(`❌ Could not re-fetch job ${jobId} for retry: ${fetchErr.message}`);
              await stopJobLocal(state, jobId);
              continue;
            }
            if (job && TERMINAL_STATUSES.includes(job.status)) {
              console.log(`✅ Job ${jobId} already ${job.status} — skipping retry`);
              await stopJobLocal(state, jobId);
              continue;
            }
            await stopJobLocal(state, jobId, true);
            await startJobLocal(state, job, agentInfo);
            continue;
          }
          console.log(`❌ Job ${jobId} failed after ${MAX_RETRIES + 1} attempts`);
        }
        await stopJobLocal(state, jobId);
      }
    } else {
      // Docker mode
      // I3: skip jobs mid-teardown (moveJobToReactivationQueue sets _pausing before
      // deleting from active; the flag closes the race where cleanup sees a stopped
      // container and tries to respawn a job that is already being paused).
      if (active._pausing) continue;
      try {
        const container = docker.getContainer(`j41-job-${jobId}`);
        const info = await container.inspect();

        if (!info.State.Running) {
          const exitCode = info.State.ExitCode;
          if (active) active._exitCode = info.State.ExitCode;
          console.log(`🗑️  Container for job ${jobId} stopped (exit ${exitCode})`);

          if (exitCode !== 0) {
            const retries = state.retries.get(jobId) || 0;
            if (retries < MAX_RETRIES) {
              state.retries.set(jobId, retries + 1);
              console.log(`🔄 Retrying job ${jobId} (attempt ${retries + 2}/${MAX_RETRIES + 1})`);
              const agentInfo = active.agentInfo;
              let job;
              try {
                const agent = await getAgentSession(state, agentInfo);
                job = await agent.client.getJob(jobId);
              } catch (fetchErr) {
                // Same shape as the 404 path: a network blip on the re-fetch used to
                // consume the retry AND tear the job down — no delivery, no retry, no
                // refund, and gone from active-jobs.json so crash recovery cannot see
                // it either. Give the attempt back and re-evaluate next cycle.
                state.retries.set(jobId, retries);
                console.warn(`[cleanup] ${jobId.substring(0, 8)}: could not re-fetch after exit ` +
                  `(${fetchErr.message}) — retry not consumed; will re-evaluate next cycle.`);
                continue;
              }
              if (job && TERMINAL_STATUSES.includes(job.status)) {
                console.log(`✅ Job ${jobId} already ${job.status} — skipping retry`);
                await stopJobContainer(state, jobId);
                continue;
              }
              await stopJobContainer(state, jobId, true);
              await startJobContainer(state, job, agentInfo);
              continue;
            }
            console.log(`❌ Job ${jobId} failed after ${MAX_RETRIES + 1} attempts`);
            // Abandoned-after-exhaustion: this paid job will never deliver. The
            // docker path had NO health signal and NO refund (stopJobContainer
            // frees the agent and deletes the job from active-jobs.json before
            // handleCrashRecovery could ever see it). Signal health (parity with
            // the local-mode child.on('exit') handler) and auto-refund the buyer
            // via the shared durable ledger BEFORE stopJobContainer tears down.
            try {
              const abandonedAgentId = active.agentInfoId || active.agentInfo?.id || null;
              if (abandonedAgentId) {
                const n = (state._containerCrashes.get(abandonedAgentId) || 0) + 1;
                state._containerCrashes.set(abandonedAgentId, n);
                state._agentErrors.set(abandonedAgentId, `job ${jobId} abandoned after ${MAX_RETRIES + 1} docker launch attempts`);
                state.emitEvent?.('container.died', { jobId, agentId: abandonedAgentId, code: active._exitCode ?? null, signal: null });
              }
              await refundAbandonedJob(state, jobId, active);
            } catch (refundErr) {
              console.error(`[refund] Could not process abandoned-job refund for ${jobId.substring(0, 8)}: ${refundErr.message}`);
            }
          }
          await stopJobContainer(state, jobId);
        }
      } catch (e) {
        // L2 — `AutoRemove: true` means Docker deletes an exited container
        // immediately, so this 10s poller's inspect() usually 404s before it ever
        // sees the exit. Treating that as "gone" skipped the ENTIRE non-zero-exit
        // branch above: no retry, no refundAbandonedJob, no `container.died`, and
        // `_containerCrashes` never incremented — which pins
        // `summary.containers_unhealthy`, the README's canonical "tell me when
        // anything is wrong" watch, at 0 in the production runtime. A buyer OOMing
        // the 2 GB container was recorded as a clean completion.
        //
        // The exit code is already on the active entry: container.wait() records it
        // at the spawn site. Consult it instead of discarding the event.
        const _code = active?._exitCode;
        const _crashed = typeof _code === 'number' && _code !== 0;
        if (_crashed) {
          const crashedAgentId = active.agentInfoId || active.agentInfo?.id || null;
          console.log(`🗑️  Container for job ${jobId} gone — exited ${_code} (auto-removed before inspect)`);
          if (crashedAgentId) {
            const n = (state._containerCrashes.get(crashedAgentId) || 0) + 1;
            state._containerCrashes.set(crashedAgentId, n);
            state._agentErrors.set(crashedAgentId, `job ${jobId} container exited ${_code}`);
            state.emitEvent?.('container.died', { jobId, agentId: crashedAgentId, code: _code, signal: null });
          }
          const retries = state.retries.get(jobId) || 0;
          if (retries < MAX_RETRIES) {
            state.retries.set(jobId, retries + 1);
            console.log(`🔄 Retrying job ${jobId} (attempt ${retries + 2}/${MAX_RETRIES + 1})`);
            const agentInfo = active.agentInfo;
            let job = null;
            try {
              const agent = await getAgentSession(state, agentInfo);
              job = await agent.client.getJob(jobId);
            } catch (fetchErr) {
              console.error(`❌ Could not re-fetch job ${jobId} for retry: ${fetchErr.message}`);
            }
            if (job && !TERMINAL_STATUSES.includes(job.status)) {
              await stopJobContainer(state, jobId, true);
              await startJobContainer(state, job, agentInfo);
              continue;
            }
            // The re-fetch failed (network blip), so we cannot tell whether the job is
            // still live. Give the retry back rather than consuming it: falling
            // through here used to burn an attempt AND drop the job with neither a
            // retry nor a refund — the silent-loss class this batch exists to remove.
            if (!job) {
              state.retries.set(jobId, retries);
              console.warn(`[cleanup] ${jobId.substring(0, 8)}: could not re-fetch after crash — ` +
                'retry not consumed; will re-evaluate next cycle.');
              continue;
            }
          } else {
            console.log(`❌ Job ${jobId} failed after ${MAX_RETRIES + 1} attempts`);
            try { await refundAbandonedJob(state, jobId, active); }
            catch (refundErr) { console.error(`[refund] Could not process abandoned-job refund for ${jobId.substring(0, 8)}: ${refundErr.message}`); }
          }
        } else {
          console.log(`🗑️  Container for job ${jobId} gone`);
        }
        await stopJobContainer(state, jobId);
      }
    }
  }
}

program
  .command('respond-dispute <jobId>')
  .description('Respond to a dispute on a job')
  .requiredOption('--agent <agentId>', 'Agent ID to respond as')
  .requiredOption('--action <action>', 'Response action: refund, rework, or rejected')
  .option('--refund-percent <percent>', 'Refund percentage (1-100, required for refund action)')
  .option('--rework-cost <cost>', 'Additional cost for rework (default: 0)', '0')
  .requiredOption('--message <message>', 'Agent statement / reason')
  .action(async (jobId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    try {
      const { action, agent: agentId, message } = options;
      if (!['refund', 'rework', 'rejected'].includes(action)) {
        console.error('❌ --action must be refund, rework, or rejected');
        process.exit(1);
      }
      if (action === 'refund' && !options.refundPercent) {
        console.error('❌ --refund-percent is required for refund action');
        process.exit(1);
      }

      const agentDir = path.join(AGENTS_DIR, agentId);
      const keysPath = path.join(agentDir, 'keys.json');
      if (!fs.existsSync(keysPath)) {
        console.error(`❌ Agent ${agentId} not found (no keys.json)`);
        process.exit(1);
      }

      const keys = readKeysFile(keysPath);
      const { J41Agent } = require('@junction41/sovagent-sdk');
      const agent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
      await agent.authenticate();

      // Do not promise a rework the worker is going to refuse. Round 8: the operator
      // offered a 3rd rework against a policy of 2, the buyer accepted, the platform
      // moved the job to `rework`, and the container declined it internally — leaving
      // the job dead-ended with a SELLER-owned deadline ticking toward auto-default.
      // The two halves disagreed and nothing checked between them.
      if (action === 'rework') {
        try {
          const pol = await readDisputePolicyFor(agent);
          const max = pol && Number.isInteger(pol.maxReworkCycles) ? pol.maxReworkCycles : null;
          if (max !== null) {
            const priorReworks = reworkCyclesFor(jobId);
            if (priorReworks >= max) {
              // TELL THE BUYER. The worker has an over-limit announcement too, but it
              // only runs on `dispute.rework_accepted` — and this guard prevents the
              // offer, so the buyer can never accept and that IPC never arrives. The
              // two halves of the 2.16.0 fix were mutually exclusive: the notice could
              // only fire in the scenario the guard makes impossible. Round 9 found it
              // exactly there ("worker over-limit chat message: MISSING, both jobs").
              // The dispatcher is the only side that knows a refusal happened, so the
              // dispatcher is what has to say so.
              try {
                await agent.connectChat();
                agent.joinJobChat(jobId);
                await agent.sendChatMessage(jobId,
                  `I'm not able to take another rework on this job — my published dispute policy allows ${max}, ` +
                  `and ${priorReworks} ${priorReworks === 1 ? 'has' : 'have'} been delivered. ` +
                  'The operator has been notified and will respond to this dispute directly; ' +
                  'you do not need to wait for another delivery.');
                console.log('  💬 Told the buyer in chat that no further rework is coming.');
              } catch (e) {
                console.error(`  ⚠️  Could not tell the buyer in chat (${e.message}) — they will see only the dispute notice.`);
              }
              console.error(`\n❌ Refusing: this agent's dispute policy allows ${max} rework cycle(s) and ${priorReworks} ` +
                'have already been delivered.');
              console.error('   The worker WILL decline this rework, and the job would dead-end with a');
              console.error('   seller-owned deadline — auto-defaulting the agent for honouring its own policy.');
              console.error(`   Escalate instead:  j41-dispatcher respond-dispute ${jobId} --agent ${agentId} --action refund --refund-percent <n> --message "..."`);
              console.error('   Or raise the limit in the agent\'s on-chain dispute policy first.');
              process.exit(1);
            }
          }
        } catch (e) {
          // Never block a legitimate response because the policy could not be read.
          console.log(`  ⚠️  Could not check the rework-cycle limit (${e.message}) — proceeding`);
        }
      }

      const result = await agent.respondToDispute(jobId, {
        action,
        refundPercent: options.refundPercent ? parseInt(options.refundPercent, 10) : undefined,
        reworkCost: parseFloat(options.reworkCost) || 0,
        message,
      });

      if (action === 'rework') {
        const n = bumpReworkCycle(jobId);
        if (n !== null) console.log(`  ↻ rework cycle ${n} recorded for this job`);
      }
      console.log('✅ Dispute response submitted:');
      console.log(JSON.stringify(result, null, 2));
      agent.stop();
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

// ── Control Plane Client ──
program
  .command('ctl <command>')
  .description('Send command to running dispatcher: status, jobs, agents, resources, earnings, history, providers, inbox, inbox-redrive, shutdown, canary')
  .option('--agent <id>', 'Agent ID (for canary command)')
  .option('--item <id>', 'Inbox item ID (for inbox-redrive; omit to redrive ALL dead letters)')
  .option('--json', 'Raw JSON output')
  .action(async (command, options) => {
    const { sendCommand } = require('./control');

    try {
      const cmd = { action: command };
      if (options.agent) cmd.agentId = options.agent;
      // Without this, `ctl inbox-redrive <id>` silently drops the id (commander
      // allows excess args) and redrives EVERY dead letter — an operator would
      // hand fresh budgets to genuinely poisoned items believing they targeted one.
      if (options.item) cmd.itemId = options.item;

      const result = await sendCommand(cmd);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Pretty-print based on command
      switch (command) {
        case 'status':
          console.log('\n╔══════════════════════════════════════════╗');
          console.log('║     Dispatcher Status (Live)             ║');
          console.log('╚══════════════════════════════════════════╝\n');
          console.log(`  Uptime:     ${result.uptime}`);
          console.log(`  Agents:     ${result.agents?.available || 0} available / ${result.agents?.total || 0} total`);
          console.log(`  Active:     ${result.active} job(s)`);
          console.log(`  Queue:      ${result.queue} pending`);
          console.log(`  Seen:       ${result.seen} (lifetime)`);
          console.log('');
          break;

        case 'jobs':
          if (!result.active || result.active.length === 0) {
            console.log('\nNo active jobs.\n');
          } else {
            console.log(`\nActive jobs (${result.active.length}):\n`);
            for (const j of result.active) {
              console.log(`  ${j.jobId.substring(0, 8)}  agent=${j.agentId}  PID=${j.pid}  running=${j.runningFor}${j.paused ? '  PAUSED' : ''}${j.workspace ? '  WORKSPACE' : ''}`);
            }
            console.log('');
          }
          break;

        case 'agents':
          console.log(`\nAgents (${result.agents?.length || 0}):\n`);
          for (const a of (result.agents || [])) {
            const statusIcon = a.status === 'available' ? '🟢' : '🔴';
            const wsIcon = a.workspace ? ' [WS]' : '';
            console.log(`  ${statusIcon} ${a.id}  ${a.identity}  ${a.status}${wsIcon}  svc=${a.services}${a.currentJob ? `  job=${a.currentJob}` : ''}`);
          }
          console.log('');
          break;

        case 'shutdown':
          console.log(result.ok ? '\n✅ Shutdown initiated.\n' : `\n❌ ${result.error}\n`);
          break;

        case 'canary':
          if (result.error) {
            console.log(`\n❌ ${result.agentId || ''}: ${result.error}\n`);
          } else {
            console.log(`\n${result.agentId}: ${JSON.stringify(result.canary, null, 2)}\n`);
          }
          break;

        case 'resources':
          console.log('\n╔══════════════════════════════════════════╗');
          console.log('║     System Resources                     ║');
          console.log('╚══════════════════════════════════════════╝\n');
          if (result.cpu) {
            console.log(`  CPU:  ${result.cpu.cores} cores (${result.cpu.model.substring(0, 40)})`);
            console.log(`        Load: ${result.cpu.load1m} / ${result.cpu.load5m} / ${result.cpu.load15m}  (${result.cpu.usagePercent}%)`);
          }
          if (result.memory) {
            console.log(`  RAM:  ${result.memory.usedMB}MB / ${result.memory.totalMB}MB  (${result.memory.usagePercent}% used, ${result.memory.freeMB}MB free)`);
          }
          if (result.capacity) {
            console.log(`  Slots: ${result.capacity.active}/${result.capacity.maxSlots} active, ${result.capacity.available} available`);
            console.log(`  Headroom: ${result.capacity.headroom}`);
          }
          if (result.jobs?.length > 0) {
            console.log('\n  Job processes:');
            for (const j of result.jobs) {
              console.log(`    ${j.jobId}  PID=${j.pid}  ${j.memMB != null ? j.memMB + 'MB' : '?'}  ${j.agentId}`);
            }
          }
          console.log('');
          break;

        case 'history':
          console.log(`\nRecent jobs (${(result.jobs || []).length}):\n`);
          for (const j of (result.jobs || [])) {
            const t = j.tokens ? `${j.tokens.totalTokens} tok (${j.tokens.calls} calls)` : 'no token data';
            const att = j.hasAttestation ? 'attested' : '';
            console.log(`  ${j.jobId}  ${j.agent.padEnd(10)}  ${t.padEnd(28)}  ${att}`);
          }
          console.log('');
          break;

        case 'providers':
          if (result.error) {
            console.log(`\n❌ ${result.error}\n`);
          } else {
            console.log(`\nCurrent: ${result.current?.provider} (${result.current?.model})`);
            console.log(`Available: ${(result.available || []).join(', ')}\n`);
          }
          break;

        case 'earnings':
          console.log('\n╔══════════════════════════════════════════╗');
          console.log('║     Earnings Summary                     ║');
          console.log('╚══════════════════════════════════════════╝\n');
          for (const a of (result.agents || [])) {
            if (a.error) {
              console.log(`  ${a.id}: error (${a.error})`);
            } else {
              console.log(`  ${a.id}  ${a.identity}  ${a.jobs} jobs  ${a.earned} ${a.currency}`);
            }
          }
          console.log(`\n  Total: ${result.total?.jobs || 0} jobs, ${result.total?.earned || 0} VRSC earned\n`);
          break;

        default:
          console.log(JSON.stringify(result, null, 2));
      }
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

// ── Interactive TUI Menu (no-args default) ──────────────────────────

async function mainMenu() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, answer => resolve(answer.trim())));

  const clear = () => process.stdout.write('\x1B[2J\x1B[0f');

  async function showMain() {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║           J41 Dispatcher                  ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('  1. Run Agents');
    console.log('  2. Setup Agents');
    console.log('  3. System Settings');
    console.log('  q. Quit');
    console.log('');
    const choice = await ask('  Select: ');

    switch (choice) {
      case '1': rl.close(); program.parse(['node', 'cli.js', 'start']); return;
      case '2': await showAgentList(); break;
      case '3': await showSystemSettings(); break;
      case 'q': case 'Q': rl.close(); process.exit(0);
      default: await showMain();
    }
  }

  async function showAgentList() {
    console.log('');
    console.log('── Agent Setup ──');
    console.log('');

    ensureDirs();
    const agents = [];
    if (fs.existsSync(AGENTS_DIR)) {
      const dirs = fs.readdirSync(AGENTS_DIR).filter(d => fs.existsSync(path.join(AGENTS_DIR, d, 'keys.json'))).sort();
      for (const dir of dirs) {
        const keys = readKeysFile(path.join(AGENTS_DIR, dir, 'keys.json'), { allowLocked: true });
        agents.push({ id: dir, identity: keys.identity || '(not registered)', iAddress: keys.iAddress || '-', address: keys.address });
      }
    }

    if (agents.length === 0) {
      console.log('  No agents found.\n');
    } else {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const status = a.identity && a.identity !== '(not registered)' ? a.identity : `(unregistered — ${a.address.slice(0, 12)}...)`;
        console.log(`  ${i + 1}. ${a.id.padEnd(12)} ${status}`);
      }
    }
    console.log(`  +. Create new agent`);
    console.log(`  b. Back`);
    console.log('');
    const choice = await ask('  Select: ');

    if (choice === 'b' || choice === 'B') { await showMain(); return; }
    if (choice === '+') { await createNewAgent(); await showAgentList(); return; }

    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < agents.length) {
      await showAgentDetail(agents[idx]);
    }
    await showAgentList();
  }

  async function showAgentDetail(agent) {
    console.log('');
    console.log(`── ${agent.id}: ${agent.identity} ──`);
    console.log(`   i-Address: ${agent.iAddress}`);
    console.log('');
    console.log('  1. Edit Profile (25-key VDXF walkthrough)');
    console.log('  2. View Current On-Chain Profile');
    console.log('  3. Register Identity On-Chain');
    console.log('  4. Publish VDXF Update');
    console.log('  b. Back');
    console.log('');
    const choice = await ask('  Select: ');

    switch (choice) {
      case '1': await editAgentProfile(agent); break;
      case '2': await viewAgentProfile(agent); break;
      case '3': await registerAgentIdentity(agent); break;
      case '4': await publishVdxfUpdate(agent); break;
      case 'b': case 'B': return;
    }
  }

  async function editAgentProfile(agent) {
    const keysPath = path.join(AGENTS_DIR, agent.id, 'keys.json');
    const keys = readKeysFile(keysPath);
    const soulPath = path.join(AGENTS_DIR, agent.id, 'SOUL.md');
    const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '';

    // Close current rl so interactiveProfileSetup can create its own
    rl.close();
    const result = await interactiveProfileSetup(keys, soul);

    // Save profile to agent dir for reference
    const profilePath = path.join(AGENTS_DIR, agent.id, 'profile.json');
    fs.writeFileSync(profilePath, JSON.stringify({ profile: result.profile, services: result.services, disputePolicy: result.disputePolicy }, null, 2));
    console.log(`\n  Profile saved to ${profilePath}`);
    console.log('  Use "Publish VDXF Update" to write on-chain.\n');

    // Re-create rl for menu
    const readline2 = require('readline');
    const rl2 = readline2.createInterface({ input: process.stdin, output: process.stdout });
    // Can't easily re-enter menu after rl close; just exit
    console.log('  (Returning to shell — run j41-dispatcher again to continue)');
    rl2.close();
    process.exit(0);
  }

  async function viewAgentProfile(agent) {
    const keysPath = path.join(AGENTS_DIR, agent.id, 'keys.json');
    const keys = readKeysFile(keysPath, { allowLocked: true });

    if (!keys.identity || !keys.iAddress) {
      console.log('\n  Agent not registered on-chain yet.\n');
      return;
    }

    try {
      const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
      const { VDXF_KEYS, PARENT_KEYS, decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');

      const a = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
      await a.login();
      const { data } = await a.client.getIdentityRaw();
      const cmm = data.identity?.contentmultimap || {};

      // Build reverse map
      const keyNames = {};
      for (const [group, gkeys] of Object.entries(VDXF_KEYS)) {
        for (const [field, iAddr] of Object.entries(gkeys)) { keyNames[iAddr] = group + '.' + field; }
      }
      for (const [group, iAddr] of Object.entries(PARENT_KEYS)) { keyNames[iAddr] = 'LEGACY:' + group; }

      console.log(`\n  On-chain: ${Object.keys(cmm).length} keys\n`);
      for (const [iAddr, values] of Object.entries(cmm)) {
        const name = keyNames[iAddr] || '??? ' + iAddr;
        let val = '(complex)';
        if (Array.isArray(values) && values.length > 0) {
          const dd = values[values.length - 1];
          const inner = dd?.['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
          if (inner?.objectdata?.message) { val = inner.objectdata.message; if (val.length > 60) val = val.slice(0, 57) + '...'; }
        }
        console.log(`  ${name.padEnd(28)} = ${val}`);
      }

      const decoded = decodeContentMultimap(cmm);
      if (decoded.services.length) {
        console.log(`\n  Services: ${decoded.services.map(s => s.name).join(', ')}`);
      }
      console.log('');
    } catch (e) {
      console.error(`\n  Error: ${e.message}\n`);
    }
  }

  async function registerAgentIdentity(agent) {
    // Writes a WIF at the end of this function. It survived on an encrypted pool only
    // because the plain readKeysFile below throws ELOCKED first — incidental, not a
    // guard, and it would break the moment that read changed. Found by tightening the
    // derived guard test to require the guard BEFORE the first key write rather than
    // merely somewhere in the block.
    await ensureKeystoreUnlockedIfEncrypted();
    const keysPath = path.join(AGENTS_DIR, agent.id, 'keys.json');
    const keys = readKeysFile(keysPath);

    if (keys.identity && keys.iAddress) {
      console.log(`\n  Already registered: ${keys.identity} (${keys.iAddress})\n`);
      return;
    }

    const name = await ask('  Identity name (without .agentplatform@): ');
    if (!name) return;

    console.log(`  Registering ${name}.agentplatform@... (this may take several minutes)`);
    try {
      const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
      const a = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif });
      const result = await a.register(name, J41_NETWORK);
      keys.identity = result.identity;
      keys.iAddress = result.iAddress;
      writeKeysFile(keysPath, keys);
      console.log(`  Done: ${result.identity} (${result.iAddress})\n`);
    } catch (e) {
      console.error(`  Failed: ${e.message}\n`);
    }
  }

  async function publishVdxfUpdate(agent) {
    const keysPath = path.join(AGENTS_DIR, agent.id, 'keys.json');
    const keys = readKeysFile(keysPath);
    const profilePath = path.join(AGENTS_DIR, agent.id, 'profile.json');

    if (!keys.identity || !keys.iAddress) {
      console.log('\n  Agent not registered on-chain yet.\n');
      return;
    }
    if (!fs.existsSync(profilePath)) {
      console.log('\n  No saved profile. Run "Edit Profile" first.\n');
      return;
    }

    const { profile, services, disputePolicy } = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

    try {
      const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
      const { buildAgentContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
      const { buildIdentityUpdateTx } = require('@junction41/sovagent-sdk/dist/identity/update.js');

      const a = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
      await a.login();
      const { data: identityData } = await a.client.getIdentityRaw();
      const utxoResp = await a.client.getUtxos();
      const utxos = utxoResp.utxos || utxoResp;

      if (!utxos.length) { console.log('\n  No UTXOs — fund the agent first.\n'); return; }

      const _ci = await a.client.getChainInfo();
      const newCmm = buildAgentContentMultimap(profile, services || [], disputePolicy);
      const rawhex = buildIdentityUpdateTx({
        wif: keys.wif, identityData, utxos, vdxfAdditions: newCmm,
        network: J41_NETWORK, clearContentmultimap: true,
        expiryHeight: expiryForIdentity(_ci.blockHeight),
      });

      const result = await a.client.broadcast(rawhex);
      console.log(`\n  Published: ${result.txid || result}`);
      console.log(`  ${Object.keys(newCmm).length} flat VDXF keys written. Wait ~60s for confirmation.\n`);
      // Trigger backend to re-index immediately
      try {
        await a.client.refreshAgent(keys.iAddress || keys.identity);
        console.log('  ✅ Backend refreshed — marketplace updated\n');
      } catch (e) {
        console.log(`  ⚠️  Backend refresh failed: ${e.message.slice(0, 60)}\n`);
      }
    } catch (e) {
      console.error(`\n  Failed: ${e.message}\n`);
    }
  }

  async function createNewAgent() {
    const id = await ask('  New agent ID (e.g. agent-6): ');
    if (!id) return;

    const agentDir = path.join(AGENTS_DIR, id);
    if (fs.existsSync(path.join(agentDir, 'keys.json'))) {
      console.log(`  ${id} already exists.\n`);
      return;
    }

    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    await ensureKeystoreUnlockedIfEncrypted();
    const { generateKeypair } = require('./keygen.js');
    const keys = generateKeypair(J41_NETWORK);
    keys.network = J41_NETWORK;
    writeKeysFile(path.join(agentDir, 'keys.json'), keys);
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), `# ${id}\n\nA helpful AI assistant on the J41 platform.`);
    console.log(`\n  Created ${id} (${keys.address})`);
    console.log(`  Fund this address with VRSCTEST, then register the identity.\n`);
  }

  async function showSystemSettings() {
    const cfg = loadConfig();
    console.log('');
    console.log('── System Settings ──');
    console.log('');
    console.log(`  API URL:           ${J41_API_URL}`);
    console.log(`  Runtime:           ${cfg.runtime || 'local'}`);
    console.log(`  Max Concurrent:    ${cfg.maxConcurrent || 'unlimited'}`);
    console.log(`  Job Timeout:       ${cfg.jobTimeoutMin || 60} min`);
    console.log(`  Network:           verustest`);
    console.log(`  Auto-Approve Ext:  ${cfg.extensionAutoApprove !== false ? 'yes' : 'no'}`);
    console.log(`  Ext Max CPU:       ${cfg.extensionMaxCpuPercent || 80}%`);
    console.log(`  Ext Min Free RAM:  ${cfg.extensionMinFreeMB || 512} MB`);
    console.log('');
    console.log('  1. Edit settings');
    console.log('  b. Back');
    console.log('');
    const choice = await ask('  Select: ');

    if (choice === '1') {
      const runtime = await ask(`  Runtime (local|docker) [${cfg.runtime || 'local'}]: `) || cfg.runtime || 'local';
      const maxConcurrentInput = await ask(`  Max concurrent agents [${cfg.maxConcurrent || 'unlimited'}]: `);
      const maxConcurrent = maxConcurrentInput ? parseInt(maxConcurrentInput) : cfg.maxConcurrent;
      const jobTimeoutMin = parseInt(await ask(`  Job timeout minutes [${cfg.jobTimeoutMin || 60}]: `)) || cfg.jobTimeoutMin || 60;
      const extensionAutoApprove = (await ask(`  Auto-approve extensions? (y/n) [${cfg.extensionAutoApprove !== false ? 'y' : 'n'}]: `) || (cfg.extensionAutoApprove !== false ? 'y' : 'n')).toLowerCase() !== 'n';

      const newCfg = { ...cfg, runtime, maxConcurrent, jobTimeoutMin, extensionAutoApprove };
      saveConfig(newCfg);
      console.log('\n  Settings saved.\n');
    }
    await showMain();
  }

  await showMain();
}

// ── Bounty commands ──

program
  .command('post-bounty <agent-id>')
  .description('Post a new bounty using the specified agent')
  .requiredOption('--title <title>', 'Bounty title')
  .requiredOption('--description <text>', 'Bounty description')
  .requiredOption('--amount <number>', 'Bounty amount')
  .option('--currency <currency>', 'Currency', 'VRSCTEST')
  .option('--category <category>', 'Category')
  .option('--max-claimants <n>', 'Max number of winners', '1')
  .option('--deadline <date>', 'Application deadline (YYYY-MM-DD)')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();
    const keys = loadAgentKeys(agentId);
    if (!keys || !keys.identity) {
      console.error(`❌ Agent ${agentId} not found or not registered.`);
      process.exit(1);
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
    await agent.authenticate();

    try {
      const result = await agent.postBounty({
        title: options.title,
        description: options.description,
        amount: parseFloat(options.amount),
        currency: options.currency,
        category: options.category,
        maxClaimants: parseInt(options.maxClaimants) || 1,
        ...(options.deadline ? { applicationDeadline: new Date(options.deadline).toISOString() } : {}),
      });
      console.log(`✅ Bounty posted: ${result.id || result.bountyId || JSON.stringify(result)}`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

program
  .command('list-bounties')
  .description('Browse open bounties on the platform')
  .option('--category <category>', 'Filter by category')
  .option('--limit <n>', 'Number to show', '20')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();
    const agents = listRegisteredAgents();
    if (agents.length === 0) {
      console.error('❌ No agents registered. Need at least one for API access.');
      process.exit(1);
    }

    const keys = loadAgentKeys(agents[0]);
    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
    await agent.authenticate();

    try {
      const params = { limit: parseInt(options.limit) || 20 };
      if (options.category) params.category = options.category;
      const result = await agent.client.getBounties(params);
      const bounties = result.data || result || [];

      if (options.json) {
        console.log(JSON.stringify(bounties, null, 2));
        return;
      }

      if (bounties.length === 0) {
        console.log('No open bounties found.');
        return;
      }

      console.log(`\n${'Title'.padEnd(32)} ${'Amount'.padEnd(16)} ${'Category'.padEnd(14)} ${'Status'.padEnd(10)} Apps`);
      console.log(`${'─'.repeat(32)} ${'─'.repeat(16)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(4)}`);
      for (const b of bounties) {
        const title = (b.title || b.id).substring(0, 30).padEnd(32);
        const amt = `${b.amount} ${b.currency || 'VRSC'}`.padEnd(16);
        const cat = (b.category || '').padEnd(14);
        const status = (b.status || '').padEnd(10);
        const apps = b.applications?.length || 0;
        console.log(`${title} ${amt} ${cat} ${status} ${apps}`);
      }
      console.log(`\nTotal: ${bounties.length}`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

program
  .command('my-bounties <agent-id>')
  .description('List bounties posted or applied to by an agent')
  .option('--role <role>', 'Filter: poster or applicant')
  .option('--json', 'Output raw JSON')
  .action(async (agentId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();
    const keys = loadAgentKeys(agentId);
    if (!keys || !keys.identity) {
      console.error(`❌ Agent ${agentId} not found or not registered.`);
      process.exit(1);
    }

    const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
    await agent.authenticate();

    try {
      const params = { limit: 30 };
      if (options.role) params.role = options.role;
      const result = await agent.client.getMyBounties(params);
      const bounties = result.data || result || [];

      if (options.json) {
        console.log(JSON.stringify(bounties, null, 2));
        return;
      }

      if (bounties.length === 0) {
        console.log('No bounties found.');
        return;
      }

      for (const b of bounties) {
        const apps = b.applications?.length || 0;
        console.log(`  ${(b.title || b.id).padEnd(30)} ${b.amount} ${b.currency || 'VRSC'}  (${b.status}, ${apps} applicants)`);
      }
      console.log(`\nTotal: ${bounties.length}`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

// ── Fleet wallet commands ─────────────────────────────────────────────────────
//
// The operator's half of the two-address problem `fee-tank.js` solves for the
// daemon: payments land at the i-address, fees debit only the R-address, so a
// tank strictly drains and an agent eventually goes silent on-chain while
// holding unswept earnings.
//
// NOTHING HERE DECIDES WHETHER MONEY MOVES. What is sweepable, what a send
// costs, whether the reserve survives it, whether a broadcast is still in
// flight — all of that is `src/wallet.js` / `src/fee-tank.js`, pure and tested.
// This section is the impure rind: argument parsing, key loading, sessions,
// confirmation prompts, rendering, and the pending-stamp file.

/** Per-agent record of the last transaction THIS CLI broadcast. */
const WALLET_PENDING_FILENAME = 'wallet-pending.json';

/** Human currency label. Only ever cosmetic — never used in arithmetic. */
function walletCoin() {
  return IS_MAINNET ? 'VRSC' : 'VRSCTEST';
}

/**
 * The reserve a `send` may not breach, taken from the same config knob the
 * daemon's sweep floor uses so the two surfaces cannot disagree about what
 * "low" means. Never a fresh hardcoded number.
 */
function walletFloorWrites() {
  const v = parseInt(cfg.fee_sweep && cfg.fee_sweep.floor_writes, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_FLOOR_WRITES;
}

function walletPendingPath(agentId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId) || agentId.includes('..')) {
    throw new Error(`Invalid agent ID format: ${agentId}`);
  }
  return path.join(AGENTS_DIR, agentId, WALLET_PENDING_FILENAME);
}

/**
 * Read the stamp written after every broadcast.
 *
 * Returns null when nothing is recorded, the record when it is readable, and a
 * deliberately UNUSABLE record (`at: null`) when the file exists but cannot be
 * read or parsed. `isPendingBlocked` in wallet.js treats a record without a
 * numeric `at` as blocking, so a corrupt stamp defers instead of being ignored:
 * "something was broadcast but we cannot tell when" is the worst possible state
 * in which to broadcast again.
 */
function loadWalletPending(agentId) {
  let p;
  try {
    p = walletPendingPath(agentId);
  } catch {
    return { at: null, malformed: true };
  }
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { at: null, malformed: true };
    return raw;
  } catch {
    return { at: null, malformed: true };
  }
}

/** Record a broadcast. Atomic rename so a reader never sees a half-written stamp. */
/**
 * Drop a pending stamp whose transaction has actually confirmed.
 *
 * The stamp exists to stop us rebuilding a second transaction from the platform's
 * CONFIRMED view while the first is still in the mempool. Once the tx confirms
 * that hazard is gone — but a pure wall-clock backstop keeps blocking for the
 * full 30 minutes anyway, and tells the operator the tx is "unconfirmed" when it
 * demonstrably is not. Found by live-testing the sweep: agent-1's tx confirmed in
 * ~90s and the next command still refused.
 *
 * Fails CLOSED: any doubt (no txid, lookup error, zero/absent confirmations) keeps
 * the stamp. Costs one getTxStatus, and only when a stamp is actually present.
 */
async function resolveWalletPending(client, agentId, stamp) {
  if (!stamp || stamp.malformed) return stamp;
  const txid = stamp.txid;
  if (!txid || typeof txid !== 'string') return stamp;
  if (!client || typeof client.getTxStatus !== 'function') return stamp;
  try {
    const st = await client.getTxStatus(txid);
    const confs = st && typeof st.confirmations === 'number' ? st.confirmations : 0;
    if (confs > 0) {
      try { fs.unlinkSync(walletPendingPath(agentId)); } catch { /* already gone — fine */ }
      return null;
    }
  } catch {
    return stamp; // lookup failed: keep the guard rather than guess
  }
  return stamp;
}

function saveWalletPending(agentId, record) {
  const p = walletPendingPath(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * Best-effort look at what a RUNNING dispatcher has in flight.
 *
 * The platform serves the CONFIRMED UTXO view, so a manual tx built while the
 * daemon's own identity write is unconfirmed can spend the same inputs twice.
 * One of the two broadcasts is then rejected at zero cost — a nuisance, not a
 * loss — which is why this is a check and not a lock.
 *
 * No pid file → nothing is running → no warning, proceed. Pid file but an
 * unreachable socket → warn once and proceed, because the residual race costs a
 * rejected broadcast, not money.
 */
async function walletPendingWrites() {
  const pidFile = path.join(DISPATCHER_DIR, 'dispatcher.pid');
  const empty = { running: false, reachable: false, byAgent: new Map(), warned: false };
  if (!fs.existsSync(pidFile)) return empty;
  try {
    const { sendCommand } = require('./control');
    const surface = await sendCommand({ action: 'inbox' });
    const byAgent = new Map();
    for (const w of (surface && surface.pendingWrites) || []) {
      if (!w || !w.agentId) continue;
      // An unknown age is treated as "just now" — fail closed.
      byAgent.set(w.agentId, typeof w.ageMs === 'number' && Number.isFinite(w.ageMs) ? w.ageMs : 0);
    }
    return { running: true, reachable: true, byAgent, warned: false };
  } catch (e) {
    return { running: true, reachable: false, error: e.message, byAgent: new Map(), warned: false };
  }
}

/** Should we defer to the running daemon for this agent? Prints its own reasons. */
function walletDaemonBlocks(daemon, agentId, force) {
  if (!daemon || !daemon.running) return false;
  if (!daemon.reachable) {
    if (!daemon.warned) {
      daemon.warned = true;
      console.warn(`⚠️  A dispatcher pid file exists but its control socket did not answer (${daemon.error || 'unreachable'}).`);
      console.warn('   Proceeding without the in-flight check — worst case one broadcast is rejected at no cost.');
    }
    return false;
  }
  const age = daemon.byAgent.get(agentId);
  if (age === undefined) return false;
  if (age >= SWEEP_PENDING_BACKSTOP_MS) return false;
  if (force) {
    console.warn(`⚠️  ${agentId}: the running dispatcher has an identity write in flight (${Math.round(age / 1000)}s ago) — proceeding anyway because --force was given.`);
    return false;
  }
  console.error(`❌ ${agentId}: the running dispatcher broadcast an identity write ${Math.round(age / 1000)}s ago and it is not confirmed yet.`);
  console.error('   Building from the confirmed UTXO view now would double-spend its inputs. Wait, or pass --force.');
  return true;
}

/**
 * Every agent that has keys, registered or not, plus an empty session cache —
 * the same shape `buildRefundsState` produces.
 *
 * Unregistered agents are KEPT, not filtered out: one still has an R-address
 * that can be funded, and hiding it is how an operator concludes an agent does
 * not exist and funds it twice.
 */
function buildWalletState() {
  const agents = [];
  for (const id of listRegisteredAgents()) {
    const keys = loadAgentKeys(id);
    if (keys) agents.push({ id, ...keys });
  }
  return { agents, agentSessions: new Map() };
}

function walletIsRegistered(a) {
  return !!(a && a.identity && a.wif && a.iAddress);
}

/**
 * Resolve a command-line token to a fleet agent. EXACT match only.
 *
 * No prefix matching, ever: the `refunds` precedent resolves job-id prefixes,
 * but a prefix must never pick a money destination. Raw addresses are refused
 * outright — `send` funds a fleet agent by id, and the one failure mode that
 * actually loses money is a typo'd address on an irreversible transaction.
 */
function walletResolveAgent(state, token, what) {
  if (!token) {
    console.error(`❌ Missing ${what} agent-id.`);
    return null;
  }
  const hit = state.agents.find(a => a.id === token);
  if (hit) return hit;

  if (/^[Ri][A-Za-z0-9]{25,}$/.test(token)) {
    console.error(`❌ ${what}: '${token}' looks like a raw address.`);
    console.error("   `wallet send` resolves a FLEET AGENT-ID to that agent's own R-address and refuses raw");
    console.error('   addresses on purpose. Use an id from `j41-dispatcher wallet list`.');
  } else {
    const known = state.agents.map(a => a.id).join(', ') || '(none)';
    console.error(`❌ ${what}: unknown agent '${token}'. Known agents: ${known}`);
  }
  return null;
}

/**
 * The SDK's payment builder, lazily required (repo convention) and overridable
 * in tests only — same shape and same NODE_ENV gate as `getAgentSession`.
 */
function walletBuildPayment(state) {
  if (process.env.NODE_ENV === 'test' && state && state._testBuildPayment) return state._testBuildPayment;
  return require('@junction41/sovagent-sdk/dist/index.js').buildPayment;
}

/**
 * --dry-run broadcaster: captures the signed hex and returns without touching
 * the network. Injected in place of the real broadcast so the dry run still
 * goes through the executor's address-class invariant — the guard is the part
 * most worth exercising.
 */
function walletDryRunBroadcast(sink) {
  return async (hex) => {
    sink.hex = hex;
    return { txid: 'dry-run-not-broadcast' };
  };
}

const DRY_RUN_CAVEAT =
  'NOTE: a successful build proves NOTHING about acceptance — utxo-lib will happily sign what the daemon rejects.';

/** Print a satoshi count, or the em dash that means "we never looked". */
function walletSats(v) {
  return formatVrsc(v);
}

function walletWrites(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

/**
 * `dt3worker1.agentplatform@` → `dt3worker1@` for the fleet table only. Every
 * agent shares the parent, so it is column width spent on nothing; the full
 * name is still printed by `wallet show` and by `--json`.
 */
function walletShortIdentity(identity) {
  const m = /^([^.@]+)\.[^@]*@$/.exec(String(identity || ''));
  return m ? `${m[1]}@` : String(identity || '');
}

/**
 * Query every agent. Balances are null — never 0 — for any agent we could not
 * ask (unregistered, or the query failed). Zero means "we looked and the tank
 * is empty"; null means "we could not look", and printing 0 for the second is
 * how a second, unnecessary transfer gets sent.
 */
async function walletCollect(state) {
  const floorWrites = walletFloorWrites();
  const rows = [];
  for (const a of state.agents) {
    if (!walletIsRegistered(a)) {
      rows.push({
        ...buildWalletRow({
          agentId: a.id,
          identity: a.identity || null,
          registered: false,
          rAddress: a.address || null,
          iAddress: a.iAddress || null,
        }),
        error: null,
        utxos: [],
      });
      continue;
    }
    try {
      const agent = await getAgentSession(state, a);
      const u = await agent.client.getUtxos();
      // Same provenance rule as the spend paths: our key is authoritative, the
      // platform's value is only corroboration. This path moves no money, but a
      // disputed address would mis-classify every UTXO as sweepable and show the
      // operator a table that is confidently wrong.
      const { wifToAddress: _w2a } = require('@junction41/sovagent-sdk/dist/index.js');
      const ownRow = resolveOwnRAddress({
        derived: a.wif ? _w2a(a.wif, J41_NETWORK) : a.address,
        platformAddress: u.address,
        agentId: a.id,
      });
      if (!ownRow.ok) {
        rows.push({
          ...buildWalletRow({ agentId: a.id, identity: a.identity || null, registered: false,
            rAddress: a.address || null, iAddress: a.iAddress || null }),
          status: 'error', error: ownRow.error, utxos: [],
        });
        continue;
      }
      const rAddress = ownRow.rAddress;
      rows.push({
        ...buildWalletRow({
          agentId: a.id,
          identity: a.identity,
          registered: true,
          rAddress,
          iAddress: u.iAddress || a.iAddress || null,
          utxos: u.utxos,
          floorWrites,
        }),
        error: null,
        utxos: Array.isArray(u.utxos) ? u.utxos : [],
      });
    } catch (e) {
      rows.push({
        agentId: a.id,
        identity: a.identity || null,
        rAddress: a.address || null,
        iAddress: a.iAddress || null,
        feeSats: null,
        writes: null,
        sweepableSats: null,
        sweepableCount: null,
        status: 'error',
        error: e.message,
        utxos: [],
      });
    }
  }
  return rows;
}

/** Last column of the fleet table: what this row means and what to do about it. */
function walletStatusText(r) {
  switch (r.status) {
    case 'ok':
      return 'ok';
    case 'low':
      return r.sweepableSats > 0
        ? `LOW — run: j41-dispatcher wallet sweep ${r.agentId}`
        : `LOW — nothing to sweep; j41-dispatcher wallet send <from-agent> ${r.agentId} <amount>`;
    case 'empty-sweepable':
      return `EMPTY — earnings are at the i-address; run: j41-dispatcher wallet sweep ${r.agentId}`;
    case 'empty-unfunded':
      // Full address, not a truncation: this line exists to be copied.
      return `EMPTY — never earned; fund ${r.rAddress || '(no address)'} externally`;
    case 'unregistered':
      return `unregistered — never queried; fund ${r.rAddress || '(no address)'} externally`;
    case 'error':
      return `error — ${r.error}`;
    default:
      return String(r.status);
  }
}

function walletRowJson(r) {
  return {
    id: r.agentId,
    identity: r.identity,
    rAddress: r.rAddress,
    iAddress: r.iAddress,
    feeSats: r.feeSats,
    writesAffordable: r.writes,
    sweepableSats: r.sweepableSats,
    sweepableCount: r.sweepableCount,
    status: r.status,
    error: r.error || null,
  };
}

/** `wallet list` — the safe default. Read-only; broadcasts nothing. */
async function walletList(state, opts = {}) {
  const rows = await walletCollect(state);
  const totals = summarizeFleet(rows);
  const floorWrites = walletFloorWrites();

  if (opts.json) {
    // Sats as integers only — money never leaves this program as a float.
    console.log(JSON.stringify({
      network: J41_NETWORK,
      apiUrl: J41_API_URL,
      floorWrites,
      agents: rows.map(walletRowJson),
      totals: {
        feeSats: totals.totalFeeSats,
        sweepableSats: totals.totalSweepableSats,
        counts: totals.counts,
      },
    }, null, 2));
    return { rows, totals };
  }

  console.log(`\nFleet Wallet — ${J41_NETWORK} (${J41_API_URL})\n`);
  // Widths follow the data. Agent ids are NEVER truncated: the id in this column
  // is what the operator types into `wallet sweep`, and a clipped one cannot be.
  const label = r => (r.identity ? walletShortIdentity(r.identity) : '(not registered)');
  const W = {
    agent: Math.max(5, ...rows.map(r => String(r.agentId).length)),
    identity: Math.max(8, ...rows.map(r => label(r).length)),
    tank: 14, writes: 8, sweep: 14,
  };
  console.log(
    `  ${'AGENT'.padEnd(W.agent)} ${'IDENTITY'.padEnd(W.identity)} ${'FEE TANK'.padStart(W.tank)} ` +
    `${'WRITES'.padStart(W.writes)} ${'SWEEPABLE'.padStart(W.sweep)}  STATUS`
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.agentId).padEnd(W.agent)} ${label(r).padEnd(W.identity)} ` +
      `${walletSats(r.feeSats).padStart(W.tank)} ${walletWrites(r.writes).padStart(W.writes)} ` +
      `${walletSats(r.sweepableSats).padStart(W.sweep)}  ${walletStatusText(r)}`
    );
  }

  const coin = walletCoin();
  console.log(
    `\n  Fleet: ${walletSats(totals.totalFeeSats)} ${coin} in tanks ` +
    `(${writesAffordable(totals.totalFeeSats)} writes) / ${walletSats(totals.totalSweepableSats)} sweepable`
  );
  const c = totals.counts;
  const bits = [];
  if (c.empty) bits.push(`${c.empty} tank${c.empty === 1 ? '' : 's'} empty`);
  if (c.low) bits.push(`${c.low} low`);
  if (c.unregistered) bits.push(`${c.unregistered} unregistered`);
  const errored = rows.filter(r => r.status === 'error').length;
  if (errored) bits.push(`${errored} unreadable`);
  console.log(`  ${bits.length ? bits.join(', ') + ' ' : ''}(floor ${floorWrites} writes)`);
  if (rows.some(r => r.feeSats === null)) {
    console.log('  — means never queried, NOT zero. Those totals exclude it.');
  }
  console.log('');
  return { rows, totals };
}

/** `wallet show <agent-id>` — per-agent detail, including the pending stamp. */
async function walletShow(state, agentId, opts = {}) {
  const a = walletResolveAgent(state, agentId, 'show');
  if (!a) return null;

  const single = { agents: [a], agentSessions: state.agentSessions, _testAgentSession: state._testAgentSession };
  const rows = await walletCollect(single);
  const r = rows[0];
  // Resolve, don't just load: reporting "pending" for a tx that confirmed ten
  // minutes ago is the same stale-information defect resolveWalletPending was
  // written to kill on the sweep/send paths, and `show` is what an operator
  // reads before deciding whether to --force.
  let showClient = null;
  try { showClient = walletIsRegistered(a) ? (await getAgentSession(state, a)).client : null; } catch { showClient = null; }
  const pending = await resolveWalletPending(showClient, a.id, loadWalletPending(a.id));

  // Classify by asking summarizeUtxos, never by re-deriving the rule here: it
  // also drops UTXOs with no usable value (a 0-satoshi identity output, a string
  // amount), and a renderer that called those "sweepable" would contradict the
  // count printed one line above it.
  const split = summarizeUtxos(r.utxos, r.rAddress);
  const feeSet = new Set(split.feeUtxos);
  const sweepSet = new Set(split.sweepableUtxos);
  const utxoClass = (u) => (feeSet.has(u) ? 'R (fee)' : sweepSet.has(u) ? 'i (sweepable)' : 'ignored — no spendable value');

  if (opts.json) {
    console.log(JSON.stringify({
      ...walletRowJson(r),
      utxos: r.utxos.map(u => ({ txid: u.txid, vout: u.vout, satoshis: u.satoshis, address: u.address || null, class: utxoClass(u) })),
      pending: pending || null,
    }, null, 2));
    return r;
  }

  console.log(`\nAgent ${r.agentId} — ${r.identity || '(not registered)'}`);
  console.log(`  R-address (pays fees):    ${r.rAddress || '(none)'}`);
  console.log(`  i-address (receives pay): ${r.iAddress || '(none)'}`);
  console.log(`  Fee tank:  ${walletSats(r.feeSats)} ${walletCoin()} (${walletWrites(r.writes)} writes)`);
  console.log(`  Sweepable: ${walletSats(r.sweepableSats)} across ${r.sweepableCount === null ? '—' : r.sweepableCount} UTXO(s)`);
  console.log(`  Status:    ${walletStatusText(r)}`);
  if (r.utxos.length) {
    console.log('\n  UTXOs:');
    for (const u of r.utxos) {
      console.log(`    ${String(u.txid).substring(0, 16)}:${u.vout}  ${walletSats(u.satoshis).padStart(14)}  ${utxoClass(u)}`);
    }
  }
  if (pending) {
    const age = typeof pending.at === 'number' ? `${Math.round((Date.now() - pending.at) / 60000)}m ago` : 'UNKNOWN AGE — treated as in flight';
    console.log(`\n  Pending ${pending.kind || 'tx'} ${String(pending.txid || '(no txid)').substring(0, 12)}, broadcast ${age}`);
  }
  console.log('');
  return r;
}

/**
 * Sweep one agent's i-address earnings into its own R-address.
 *
 * Destination is derived from the agent's own keys, so funds cannot leave the
 * agent — which is why a sweep is allowed a plain y/N even on mainnet. Never
 * throws: `--all` loops the fleet and one agent's failure must not abort the
 * rest.
 */
async function walletSweepOne(state, agentInfo, opts = {}) {
  const id = agentInfo.id;
  const out = { agentId: id, swept: false, dryRun: false, txid: null, amountSats: 0, reason: null };
  try {
    if (walletDaemonBlocks(opts.daemon, id, opts.force)) {
      out.reason = 'daemon-write-pending';
      return out;
    }

    const agent = await getAgentSession(state, agentInfo);
    const u = await agent.client.getUtxos();
    // Destination comes from OUR key, not the platform's response — see
    // resolveOwnRAddress. A disputed address is a hard refusal.
    const { wifToAddress } = require('@junction41/sovagent-sdk/dist/index.js');
    const own = resolveOwnRAddress({
      derived: agentInfo.wif ? wifToAddress(agentInfo.wif, J41_NETWORK) : agentInfo.address,
      platformAddress: u.address,
      agentId: id,
    });
    if (!own.ok) {
      out.reason = 'address-mismatch';
      console.error(`❌ ${own.error}`);
      return out;
    }
    const rAddress = own.rAddress;
    const s = summarizeUtxos(u.utxos, rAddress);

    const stamp = await resolveWalletPending(agent.client, id, loadWalletPending(id));
    if (stamp && opts.force) {
      console.warn(`⚠️  ${id}: ignoring the pending stamp for ${String(stamp.txid || '?').substring(0, 12)} because --force was given.`);
    }
    const plan = planManualSweep({
      feeSats: s.feeSats,
      sweepableSats: s.sweepableSats,
      pending: opts.force ? null : stamp,
      now: Date.now(),
    });

    if (!plan.ok) {
      out.reason = plan.reason;
      if (plan.reason === 'needs-external-funding') {
        console.error(`❌ ${id}: nothing at the i-address to sweep. Fund ${rAddress} externally, or use \`wallet send\`.`);
      } else if (plan.reason === 'sweep-pending') {
        console.error(`❌ ${id}: a wallet transaction is recorded as unconfirmed. Wait for it, or pass --force.`);
      } else if (plan.reason === 'below-min-sweep') {
        console.error(`❌ ${id}: ${walletSats(s.sweepableSats)} sweepable does not cover the ${walletSats(FEE_SATS)} fee usefully.`);
      } else {
        console.error(`❌ ${id}: refusing to sweep — ${plan.reason}`);
      }
      return out;
    }

    out.amountSats = plan.amountSats;
    console.log(
      `\n[wallet] Sweep ${id}: ${walletSats(plan.amountSats)} ${walletCoin()} from ${s.sweepableUtxos.length} i-address UTXO(s)`
    );
    console.log(`  Into:   ${rAddress}  (tank ${walletSats(s.feeSats)}, ${writesAffordable(s.feeSats)} writes)`);
    console.log(`  After:  ~${walletSats(s.feeSats + plan.amountSats)} (${writesAffordable(s.feeSats + plan.amountSats)} writes) once confirmed`);

    if (!opts.yes) {
      if (typeof opts.confirmFn !== 'function') {
        out.reason = 'no-confirmation';
        console.error('❌ Refusing to broadcast without a confirmation.');
        return out;
      }
      const okay = await opts.confirmFn({ kind: 'sweep', agentId: id, amountSats: plan.amountSats, question: 'Sweep?' });
      if (!okay) {
        out.reason = 'cancelled';
        console.log('[wallet] Cancelled — nothing broadcast.');
        return out;
      }
    }

    const sink = {};
    const res = await executeFeeSweep({
      buildPayment: walletBuildPayment(state),
      broadcast: opts.dryRun ? walletDryRunBroadcast(sink) : (hex) => agent.client.broadcast(hex),
      wif: agentInfo.wif,
      network: J41_NETWORK,
      rAddress,
      sweepableUtxos: s.sweepableUtxos,
      amountSats: plan.amountSats,
    });

    if (opts.dryRun) {
      // Branch BEFORE reading res.swept: the injected broadcaster returns a
      // placeholder txid, and no stamp may ever be written for a tx that was
      // never sent.
      out.dryRun = true;
      out.bytes = sink.hex ? sink.hex.length / 2 : 0;
      if (!sink.hex) {
        out.reason = res.reason || 'build-failed';
        console.error(`❌ ${id}: dry run stopped before broadcast — ${out.reason}`);
        return out;
      }
      console.log(`  DRY RUN — built ${out.bytes} bytes, nothing broadcast.`);
      console.log(`  ${DRY_RUN_CAVEAT}`);
      return out;
    }

    if (!res.swept) {
      out.reason = res.reason;
      console.error(`❌ ${id}: sweep failed — ${res.reason}${res.detail ? ` (${res.detail})` : ''}`);
      return out;
    }

    out.swept = true;
    out.txid = res.txid;
    try {
      saveWalletPending(id, { txid: res.txid, at: Date.now(), kind: 'sweep' });
    } catch (e) {
      console.error(`⚠️  BROADCAST ${res.txid} but the pending stamp could not be written (${e.message}).`);
      console.error('   Do not run another wallet command for this agent for 30 minutes.');
    }
    console.log(`✅ ${id}: swept in ${String(res.txid).substring(0, 12)} — confirms in a block or two.`);
    return out;
  } catch (e) {
    out.reason = e.message;
    console.error(`❌ ${id}: ${e.message}`);
    return out;
  }
}

/** `wallet sweep <agent-id>` / `wallet sweep --all`. */
async function walletSweep(state, agentId, opts = {}) {
  const daemon = opts.daemon || await walletPendingWrites();
  const targets = [];

  if (opts.all) {
    targets.push(...state.agents.filter(walletIsRegistered));
    if (targets.length === 0) {
      console.error('❌ No registered agents to sweep.');
      return { results: [] };
    }
  } else {
    const a = walletResolveAgent(state, agentId, 'sweep');
    if (!a) return { results: [] };
    if (!walletIsRegistered(a)) {
      console.error(`❌ ${a.id} is not registered — it has no session to broadcast with, and nothing has ever been paid to it.`);
      console.error(`   Fund ${a.address || 'its R-address'} externally instead.`);
      return { results: [] };
    }
    targets.push(a);
  }

  const results = [];
  for (const a of targets) {
    results.push(await walletSweepOne(state, a, { ...opts, daemon }));
  }

  if (opts.json) console.log(JSON.stringify({ results }, null, 2));
  return { results };
}

/**
 * `wallet send <from-agent> <to-agent> <amount>` — R→R inside the fleet.
 *
 * Spends ONLY the source's R-address (tank) UTXOs; `executeSend` refuses any
 * other input class, address-less ones included. The destination is another
 * fleet agent's own R-address, never a typed address.
 */

/**
 * Serialise spends for one agent across PROCESSES (audit S1).
 *
 * The pending stamp guards a *sequence* of commands; it cannot guard two running
 * at once. Both read "no stamp", both sit at the confirmation prompt for as long
 * as the operator takes, both broadcast. Usually the chain rejects one — the
 * SDK's greedy selector makes the input sets overlap — but with equal-valued
 * UTXOs the selections can be disjoint, both confirm, and the agent has spent
 * twice against one intent (and blown the reserve, since both plans were
 * computed from the same pre-send snapshot).
 *
 * Reuses the refund lock primitive: exclusive create, with staleness recovery so
 * a killed process cannot wedge the agent permanently.
 */
function acquireWalletLock(agentId) {
  try { return acquireSendLock(`wallet-${agentId}`); } catch { return false; }
}
function releaseWalletLock(agentId) {
  try { releaseSendLock(`wallet-${agentId}`); } catch { /* best effort */ }
}

async function walletSend(state, fromId, toId, amountStr, opts = {}) {
  const out = { sent: false, dryRun: false, txid: null, amountSats: 0, reason: null };

  // Opt-in to stricter, never opt-in to bypass: a real mainnet install is
  // mainnet no matter what the caller passes.
  const mainnet = IS_MAINNET || opts.forceMainnetRules === true;

  if (mainnet && opts.yes) {
    console.error('❌ --yes is refused for `wallet send` on mainnet. Confirm interactively by retyping the amount.');
    out.reason = 'mainnet-yes-refused';
    return out;
  }

  const parsed = parseVrscAmount(amountStr);
  if (!parsed.ok) {
    console.error(`❌ ${parsed.error}`);
    out.reason = 'invalid-amount';
    return out;
  }

  const from = walletResolveAgent(state, fromId, 'send source');
  if (!from) { out.reason = 'unknown-agent'; return out; }
  const to = walletResolveAgent(state, toId, 'send destination');
  if (!to) { out.reason = 'unknown-agent'; return out; }

  if (from.id === to.id) {
    console.error('❌ Source and destination are the same agent — that only burns a fee.');
    out.reason = 'self-send';
    return out;
  }
  if (!to.address) {
    console.error(`❌ ${to.id} has no R-address in its keys — it cannot be a destination.`);
    out.reason = 'no-destination-address';
    return out;
  }
  if (!walletIsRegistered(from)) {
    console.error(`❌ ${from.id} is not registered — no session to query balances or broadcast with.`);
    out.reason = 'unregistered-source';
    return out;
  }

  const daemon = opts.daemon || await walletPendingWrites();
  if (walletDaemonBlocks(daemon, from.id, opts.force)) {
    out.reason = 'daemon-write-pending';
    return out;
  }

  let agent, u;
  try {
    agent = await getAgentSession(state, from);
    u = await agent.client.getUtxos();
  } catch (e) {
    console.error(`❌ ${from.id}: could not read balances — ${e.message}`);
    out.reason = 'query-failed';
    return out;
  }

  // Serialise against a concurrent CLI invocation for this same agent (audit S1).
  // Held across the confirmation prompt and the broadcast, because that whole
  // span is the window in which two processes can each decide to spend.
  if (!acquireWalletLock(from.id)) {
    console.error(`❌ ${from.id}: another wallet command is already spending for this agent. Wait for it to finish.`);
    return { sent: false, reason: 'locked' };
  }
  try {

  // Source address from OUR key. The destination already comes from the target
  // agent's keys.json (to.address); this closes the same hole on the spend side.
  const { wifToAddress: _wifToAddress } = require('@junction41/sovagent-sdk/dist/index.js');
  const fromOwn = resolveOwnRAddress({
    derived: from.wif ? _wifToAddress(from.wif, J41_NETWORK) : from.address,
    platformAddress: u.address,
    agentId: from.id,
  });
  if (!fromOwn.ok) {
    console.error(`❌ ${fromOwn.error}`);
    return { sent: false, reason: 'address-mismatch' };
  }
  const rAddress = fromOwn.rAddress;
  const s = summarizeUtxos(u.utxos, rAddress);

  const stamp = await resolveWalletPending(agent.client, from.id, loadWalletPending(from.id));
  if (stamp && opts.force) {
    console.warn(`⚠️  ${from.id}: ignoring the pending stamp for ${String(stamp.txid || '?').substring(0, 12)} because --force was given.`);
  }

  const reserveWrites = walletFloorWrites();
  const plan = planFleetSend({
    feeSats: s.feeSats,
    amountSats: parsed.sats,
    reserveWrites,
    allowDrain: !!opts.allowDrain,
    fromAgentId: from.id,
    toAgentId: to.id,
    pending: opts.force ? null : stamp,
    now: Date.now(),
  });

  if (!plan.ok) {
    out.reason = plan.reason;
    if (plan.reason === 'insufficient-funds') {
      console.error(`❌ ${from.id}: tank holds ${walletSats(s.feeSats)}; ${walletSats(parsed.sats)} + ${walletSats(FEE_SATS)} fee does not fit.`);
    } else if (plan.reason === 'below-reserve') {
      console.error(`❌ ${from.id}: that send leaves it below the ${reserveWrites}-write reserve — the outage would just move to the source.`);
      console.error('   Sweep its earnings first, or pass --allow-drain if you really mean it.');
    } else if (plan.reason === 'send-pending') {
      console.error(`❌ ${from.id}: a wallet transaction is recorded as unconfirmed. Wait for it, or pass --force.`);
    } else {
      console.error(`❌ Refusing to send — ${plan.reason}`);
    }
    return out;
  }

  // Best effort, read-only: never invent the destination's balance. If it is
  // unregistered or the query fails it stays "never queried", not zero.
  let toTank = null;
  if (walletIsRegistered(to)) {
    try {
      const toAgent = await getAgentSession(state, to);
      const tu = await toAgent.client.getUtxos();
      toTank = summarizeUtxos(tu.utxos, tu.address || to.address).feeSats;
    } catch { toTank = null; }
  }

  const coin = walletCoin();
  console.log('\n[wallet] Send:');
  console.log(`  From:    ${from.id}  (${rAddress})   tank ${walletSats(s.feeSats)} (${writesAffordable(s.feeSats)} writes)`);
  console.log(`  To:      ${to.id}  (${to.address})   tank ${walletSats(toTank)}${toTank === null ? ' (never queried)' : ` (${writesAffordable(toTank)} writes)`}`);
  console.log(`  Amount:  ${walletSats(plan.sendSats)} ${coin}`);
  console.log(`  Fee:     ${walletSats(FEE_SATS)}`);
  console.log(`  After:   ${from.id} → ${walletSats(plan.remainingSats)} (${plan.remainingWrites} writes)   ${to.id} → +${walletSats(plan.sendSats)} once confirmed`);
  if (opts.allowDrain && plan.remainingWrites < reserveWrites) {
    console.log(`  ⚠️  --allow-drain: this leaves the source under the ${reserveWrites}-write reserve.`);
  }

  if (!opts.yes) {
    if (typeof opts.confirmFn !== 'function') {
      console.error('❌ Refusing to broadcast without a confirmation.');
      out.reason = 'no-confirmation';
      return out;
    }
    const okay = await opts.confirmFn({
      kind: 'send',
      fromAgentId: from.id,
      toAgentId: to.id,
      amountSats: plan.sendSats,
      amountText: String(amountStr).trim(),
      // Mainnet is real money and irreversible: pressing one key is not consent.
      requireTypedAmount: mainnet,
      question: 'Send?',
    });
    if (!okay) {
      console.log('[wallet] Cancelled — nothing broadcast.');
      out.reason = 'cancelled';
      return out;
    }
  }

  const sink = {};
  const res = await executeSend({
    buildPayment: walletBuildPayment(state),
    broadcast: opts.dryRun ? walletDryRunBroadcast(sink) : (hex) => agent.client.broadcast(hex),
    wif: from.wif,
    network: J41_NETWORK,
    rAddress,
    toAddress: to.address,
    utxos: s.feeUtxos,
    amountSats: plan.sendSats,
  });

  out.amountSats = plan.sendSats;

  if (opts.dryRun) {
    out.dryRun = true;
    out.bytes = sink.hex ? sink.hex.length / 2 : 0;
    if (!sink.hex) {
      out.reason = res.reason || 'build-failed';
      console.error(`❌ dry run stopped before broadcast — ${out.reason}`);
    } else {
      console.log(`  DRY RUN — built ${out.bytes} bytes, nothing broadcast.`);
      console.log(`  ${DRY_RUN_CAVEAT}`);
    }
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    return out;
  }

  if (!res.sent) {
    out.reason = res.reason;
    console.error(`❌ send failed — ${res.reason}${res.detail ? ` (${res.detail})` : ''}`);
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    return out;
  }

  out.sent = true;
  out.txid = res.txid;
  try {
    saveWalletPending(from.id, { txid: res.txid, at: Date.now(), kind: 'send' });
  } catch (e) {
    console.error(`⚠️  BROADCAST ${res.txid} but the pending stamp could not be written (${e.message}).`);
    console.error('   Do not run another wallet command for this agent for 30 minutes.');
  }
  console.log(`✅ Sent ${walletSats(plan.sendSats)} ${coin} ${from.id} → ${to.id} in ${String(res.txid).substring(0, 12)}`);
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  return out;

  } finally {
    releaseWalletLock(from.id);
  }
}

/** Interactive confirmation. Typed-amount on mainnet, plain y/N otherwise. */
async function walletConfirm(ctx) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (ctx.requireTypedAmount) {
      console.log('\n  ⚠️  MAINNET — this moves real funds and cannot be undone.');
      const typed = await new Promise(resolve => rl.question(`  Retype the exact amount (${ctx.amountText}) to confirm: `, resolve));
      if (typed.trim() !== String(ctx.amountText).trim()) {
        console.log('  Amount did not match.');
        return false;
      }
      return true;
    }
    const answer = await new Promise(resolve => rl.question(`\n  ${ctx.question || 'Proceed?'} (y/N) `, resolve));
    const a = answer.trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

// One registration, internal dispatch — Commander uses only the FIRST word as
// the command name, so `wallet sweep` as its own `.command()` would collide on
// "wallet". Same shape as `refunds [action] [job-id]` below.
program
  .command('wallet [action] [args...]')
  .description('Fleet wallet — actions: list (default) | show <agent-id> | sweep <agent-id>|--all | send <from-agent> <to-agent> <amount>')
  .option('--json', 'Raw JSON output (satoshis as integers, never floats)')
  .option('--dry-run', 'Plan and build without broadcasting — a successful build proves nothing')
  .option('--yes', 'Skip the interactive confirmation (send: refused on mainnet)')
  .option('--all', 'sweep: sweep every registered agent that has a sweepable balance')
  .option('--allow-drain', 'send: permit leaving the source tank below the write reserve')
  .option('--force', 'Proceed despite a pending unconfirmed tx recorded for this agent')
  .action(async (action, args = [], options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();
    const state = buildWalletState();
    action = (action || 'list').toLowerCase();

    if (action === 'list') {
      await walletList(state, { json: options.json });
      return;
    }

    if (action === 'show') {
      const r = await walletShow(state, args[0], { json: options.json });
      if (!r) process.exit(1);
      return;
    }

    if (action === 'sweep') {
      if (!options.all && !args[0]) {
        console.error('❌ Provide an <agent-id> or --all');
        process.exit(1);
      }
      const daemon = await walletPendingWrites();

      // One prompt for the whole batch, then run non-interactively — the same
      // shape as `refunds approve --all`.
      let yes = options.yes || false;
      if (options.all && !yes && !options.dryRun) {
        const ids = state.agents.filter(walletIsRegistered).map(a => a.id);
        console.log(`\n[wallet] Sweeping every registered agent with a sweepable balance: ${ids.join(', ') || '(none)'}`);
        console.log('  Each sweep sends an agent\'s own earnings to its own fee address; funds cannot leave the agent.');
        if (!(await walletConfirm({ question: 'Sweep all?' }))) {
          console.log('[wallet] Cancelled — nothing broadcast.');
          return;
        }
        yes = true;
      }

      const { results } = await walletSweep(state, args[0], {
        all: options.all,
        yes,
        dryRun: options.dryRun,
        force: options.force,
        json: options.json,
        daemon,
        confirmFn: walletConfirm,
      });
      // Exit non-zero when nothing succeeded. Previously `--all` was exempt
      // (exit 0 even if every sweep failed) and a dry run whose BUILD failed
      // still set dryRun:true, so scripts saw success on failure.
      const anyOk = results.some(r => r && (r.swept || (r.dryRun && r.bytes > 0)));
      if (!results.length || !anyOk) process.exit(1);
      return;
    }

    if (action === 'send') {
      const [fromId, toId, amount] = args;
      if (!fromId || !toId || !amount) {
        console.error('❌ Usage: wallet send <from-agent> <to-agent> <amount>');
        process.exit(1);
      }
      const res = await walletSend(state, fromId, toId, amount, {
        yes: options.yes,
        dryRun: options.dryRun,
        force: options.force,
        allowDrain: options.allowDrain,
        json: options.json,
        confirmFn: walletConfirm,
      });
      if (!res.sent && !res.dryRun) process.exit(1);
      return;
    }

    console.error(`❌ Unknown wallet action '${action}'. Use: list | show | sweep | send`);
    process.exit(1);
  });

// ── Refunds management commands ───────────────────────────────────────────────

/**
 * Build a minimal dispatcher state for refund CLI commands (no running process needed).
 * Loads all registered agent keys so getAgentSession can authenticate for re-verify.
 */
function buildRefundsState() {
  const agentIds = listRegisteredAgents();
  const agents = [];
  for (const id of agentIds) {
    const keys = loadAgentKeys(id);
    if (keys) agents.push({ id, ...keys });
  }
  return { agents, agentSessions: new Map() };
}

// Single dispatcher command — Commander uses only the FIRST word as the command
// name, so separate `.command('refunds approve ...')` registrations all collide on
// "refunds". One `refunds [action] [job-id]` command dispatches on the action.
program
  .command('refunds [action] [job-id]')
  .description('Refund approval queue — actions: list (default) | approve <job-id>|--all | reject <job-id> | unblock <job-id>')
  .option('--all', 'list: include refunded/rejected; approve: approve every pending_approval entry')
  .option('--yes', 'approve: skip the interactive confirmation prompt')
  .option('--reason <text>', 'reject: rejection reason', 'owner-rejected')
  .action(async (action, jobId, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    ensureDirs();
    const state = buildRefundsState();
    action = (action || 'list').toLowerCase();

    // Owner types short jobId prefixes from `refunds list` — resolve to the full
    // ledger key. Refuse on ambiguity so a prefix can never approve the wrong job.
    if (jobId && (action === 'approve' || action === 'reject' || action === 'unblock')) {
      const led = loadPendingRefunds();
      if (!led[jobId]) {
        const matches = Object.keys(led).filter(k => k.startsWith(jobId));
        if (matches.length === 1) {
          jobId = matches[0];
        } else if (matches.length > 1) {
          console.error(`❌ Ambiguous job-id '${jobId}' — matches ${matches.length} entries; use the full id`);
          process.exit(1);
        }
      }
    }

    if (action === 'list') {
      refundsList(state, { all: options.all });
      return;
    }

    if (action === 'unblock') {
      // Clears a marker left by a send whose outcome we could not determine.
      // Deliberately manual and deliberately loud: the marker exists because
      // paying twice is unrecoverable, so only a human who has checked the chain
      // may decide the money never arrived.
      if (!jobId) { console.error('❌ Provide a <job-id> to unblock'); process.exit(1); }
      const m = readRefundInflight(jobId);
      if (!m) { console.error(`❌ ${jobId.substring(0, 8)} is not blocked — no in-flight marker.`); process.exit(1); }
      console.log(`\n[refunds] Blocked refund for ${jobId}`);
      console.log(`  Amount:  ${m.amount} ${m.currency || ''}`);
      console.log(`  To:      ${m.buyerAddress}`);
      console.log(`  Marked:  ${new Date(m.at).toISOString()}${m.failedAt ? ` (failed ${new Date(m.failedAt).toISOString()})` : ''}`);
      if (m.lastError) console.log(`  Error:   ${m.lastError}`);
      console.log('\n  Unblocking allows this refund to be SENT AGAIN on the next drain.');
      console.log(`  Confirm on-chain that ${m.buyerAddress} did NOT receive ${m.amount} before continuing.\n`);
      // Deliberately NOT skippable with --yes. Every other confirmation in this
      // CLI guards a decision the operator can reason about from the screen;
      // this one asserts a fact they must have checked ON-CHAIN. A flag cannot
      // stand in for having looked, and the cost of being wrong is paying twice.
      if (options.yes) {
        console.error('❌ --yes is not accepted for `refunds unblock`. It asserts you verified on-chain that the money did NOT arrive; confirm interactively.');
        process.exit(1);
      }
      const ok = await new Promise((resolve) => {
        const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
        rl.question('  Verified it did NOT arrive? Type "yes" to unblock: ', (a) => { rl.close(); resolve(a.trim() === 'yes'); });
      });
      if (!ok) { console.log('  Left blocked.'); return; }
      // Take the send lock: the drain runs every 5 minutes, and clearing a
      // marker while a send is in flight loses the blocked state — if that send
      // then fails ambiguously, noteRefundInflightFailure finds no marker to
      // annotate and the next drain pays again.
      if (!acquireSendLock(jobId)) {
        console.error(`❌ ${jobId.substring(0, 8)}: a send is in progress for this job. Try again in a moment.`);
        process.exit(1);
      }
      try {
        clearRefundInflight(jobId);
      } finally {
        releaseSendLock(jobId);
      }
      console.log(`✅ ${jobId.substring(0, 8)} unblocked — it will be retried on the next drain.`);
      return;
    }

    if (action === 'reject') {
      if (!jobId) { console.error('❌ Provide a <job-id> to reject'); process.exit(1); }
      refundsReject(state, jobId, { reason: options.reason });
      return;
    }

    if (action === 'approve') {
      const yes = options.yes || false;

      function printWhyReport(entry, target) {
        const checks = target ? target.checks : (entry.addressChecks || {});
        console.log(`\n[refunds] Pending approval:`);
        console.log(`  Job:     ${jobId}`);
        console.log(`  Amount:  ${entry.refundAmount} ${entry.orphan?.currency || 'VRSC'}`);
        console.log(`  Buyer:   ${entry.buyerAddress}`);
        if (entry.buyerDisplayName) console.log(`  Name:    ${entry.buyerDisplayName}`);
        if (entry.reason) console.log(`  Reason:  ${entry.reason}`);
        for (const [check, result] of Object.entries(checks)) {
          console.log(`  ${result ? '✓' : '✗'} ${check}`);
        }
      }

      async function confirmSingle(entry, target) {
        printWhyReport(entry, target);
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => rl.question('\n  Send refund? (y/N) ', resolve));
        rl.close();
        return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
      }

      if (options.all) {
        if (!yes) {
          const pending = loadPendingRefunds();
          const ids = Object.keys(pending).filter(id => pending[id].status === 'pending_approval');
          if (ids.length === 0) {
            console.log('[refunds] No pending_approval entries to approve.');
            return;
          }
          const total = ids.reduce((s, id) => s + (pending[id].refundAmount || 0), 0);
          const currency = pending[ids[0]].orphan?.currency || 'VRSC';
          console.log(`\n[refunds] Approving ${ids.length} pending refund(s), total ~${total.toFixed(4)} ${currency}:`);
          for (const id of ids) {
            const e = pending[id];
            console.log(`  ${id.substring(0, 10)}  ${e.buyerAddress}  ${e.refundAmount} ${e.orphan?.currency || 'VRSC'}`);
          }
          const readline = require('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise(resolve => rl.question('\n  Approve all? (y/N) ', resolve));
          rl.close();
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('[refunds] Cancelled — no funds sent.');
            return;
          }
        }
        await refundsApproveAll(state, { yes: true });
      } else if (jobId) {
        const confirmFn = yes ? undefined : confirmSingle;
        await refundsApprove(state, jobId, { yes, confirmFn });
      } else {
        console.error('❌ Provide a <job-id> or --all');
        process.exit(1);
      }
      return;
    }

    console.error(`❌ Unknown refunds action '${action}'. Use: list | approve | reject`);
    process.exit(1);
  });

// ── Entry point ──

if (process.env.NODE_ENV === 'test') {
  module.exports = { buildContainerEnv, loadAgentConfig, moveJobToReactivationQueue, respawnReadyResumes, sweepExpiredQueue, hasMemoryHeadroom, loadAgentCapabilities, loadAgentDisputePolicy, drainPendingRefunds, attemptPendingRefund, refundAbandonedJob, refundsList, refundsReject, refundsApprove, refundsApproveAll, preflightAllowsAccept, sweepDisputesForRefund, OUTAGE_APOLOGY, acquireSendLock, releaseSendLock, dispatchInboxAccept, processInboxForAgent, checkPendingInbox, queueDisputedJobForRespawn, reconcileOrphanedDisputes, readReworkCycles, reworkCyclesFor, bumpReworkCycle, REWORK_CYCLES_PATH, shouldReconcileJob, MAX_RECONCILE_RESPAWNS_PER_SWEEP, MAX_RECONCILE_ATTEMPTS_PER_JOB, readShutdownDeactivated, writeShutdownDeactivated, clearShutdownDeactivated, SHUTDOWN_DEACTIVATED_FILE, reportSpawnAttachFailed, walletList, walletShow, walletSweep, walletSend, buildWalletState, loadWalletPending, saveWalletPending, walletPendingPath, resolveWalletPending, checkFeeTanks, markRefundInflight, clearRefundInflight, readRefundInflight, noteRefundInflightFailure, refundInflightPath, loadSeenJobs, saveSeenJobs, loadFinalizeState };
} else if (process.argv.length <= 2) {
  // No command — launch interactive dashboard
  require('./dashboard.js');
} else {
  program.parse();
}
