/**
 * Runtime config helper — reads/writes ~/.j41/dispatcher/config.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DISPATCHER_DIR = path.join(os.homedir(), '.j41', 'dispatcher');
const CONFIG_PATH = path.join(DISPATCHER_DIR, 'config.json');
const ACTIVE_JOBS_PATH = path.join(DISPATCHER_DIR, 'active-jobs.json');
const REACTIVATION_QUEUE_PATH = path.join(DISPATCHER_DIR, 'reactivation-queue.json');
const LEASES_PATH = path.join(DISPATCHER_DIR, 'leases.json');

const DEFAULTS = {
  runtime: 'docker',
  jobTimeoutMin: 60,
  // Extension auto-approve thresholds
  extensionAutoApprove: true,
  extensionMaxCpuPercent: 80,   // reject if load avg > this % of cores
  extensionMinFreeMB: 512,      // reject if free RAM below this
  drainTimeoutMin: null,  // default: 2 * jobTimeoutMin, null = auto-calculate
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch {
    // corrupted — return defaults
  }
  return { ...DEFAULTS };
}

function saveConfig(obj) {
  fs.mkdirSync(DISPATCHER_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function getRuntime() {
  return loadConfig().runtime || 'docker';
}

function persistActiveJobs(activeMap) {
  const jobs = {};
  for (const [jobId, active] of activeMap) {
    jobs[jobId] = {
      agentId: active.agentId,
      pid: active.pid || null,
      startedAt: active.startedAt,
      // Crash recovery fields
      jobAmount: active.jobAmount || null,
      buyerPayAddress: active.buyerPayAddress || null,
      currency: active.currency || null,
      agentInfoId: active.agentInfoId || null,
      reworkCount: active.reworkCount || 0,
    };
  }
  try {
    // Atomic write: this is the crash-recovery refund input. A torn bare write →
    // loadActiveJobs absorbs it as {} → handleCrashRecovery sees zero orphans →
    // NO refunds for jobs in-flight at the crash. tmp→rename (same pattern as
    // persistReactivationQueue below) makes the replace atomic. mkdirSync mirrors
    // persistReactivationQueue too — the prior bare write assumed the dir existed.
    fs.mkdirSync(DISPATCHER_DIR, { recursive: true });
    const tmp = ACTIVE_JOBS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmp, ACTIVE_JOBS_PATH);
  } catch (e) {
    console.error(`[config] Failed to persist active jobs: ${e.message}`);
  }
}

function loadActiveJobs() {
  try {
    if (fs.existsSync(ACTIVE_JOBS_PATH)) {
      return JSON.parse(fs.readFileSync(ACTIVE_JOBS_PATH, 'utf8'));
    }
  } catch {
    // corrupted
  }
  return {};
}

function persistReactivationQueue(arr) {
  try {
    fs.mkdirSync(DISPATCHER_DIR, { recursive: true });
    const tmp = REACTIVATION_QUEUE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr || [], null, 2));
    fs.renameSync(tmp, REACTIVATION_QUEUE_PATH); // atomic replace
  } catch (e) {
    console.error(`[config] Failed to persist reactivation queue: ${e.message}`);
  }
}

function loadReactivationQueue() {
  try {
    if (!fs.existsSync(REACTIVATION_QUEUE_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(REACTIVATION_QUEUE_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error(`[config] Failed to load reactivation queue (starting empty): ${e.message}`);
    return [];
  }
}

// S5 — compute leases. The lease file is the source of truth for crash-recovery
// release: a leaked lease is capacity (and eventually money) burning, so the write
// is atomic tmp→rename like the other financial-adjacent state above.
function persistLeases(leaseMap) {
  try {
    fs.mkdirSync(DISPATCHER_DIR, { recursive: true });
    const obj = leaseMap instanceof Map ? Object.fromEntries(leaseMap) : (leaseMap || {});
    const tmp = LEASES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, LEASES_PATH); // atomic replace
  } catch (e) {
    console.error(`[config] Failed to persist leases: ${e.message}`);
  }
}

function loadLeases() {
  try {
    if (!fs.existsSync(LEASES_PATH)) return {};
    return JSON.parse(fs.readFileSync(LEASES_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

module.exports = {
  CONFIG_PATH,
  ACTIVE_JOBS_PATH,
  REACTIVATION_QUEUE_PATH,
  LEASES_PATH,
  loadConfig,
  saveConfig,
  getRuntime,
  persistActiveJobs,
  loadActiveJobs,
  persistReactivationQueue,
  loadReactivationQueue,
  persistLeases,
  loadLeases,
};
