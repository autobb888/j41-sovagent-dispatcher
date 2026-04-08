/**
 * Runtime config helper — reads/writes ~/.j41/dispatcher/config.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DISPATCHER_DIR = path.join(os.homedir(), '.j41', 'dispatcher');
const CONFIG_PATH = path.join(DISPATCHER_DIR, 'config.json');
const ACTIVE_JOBS_PATH = path.join(DISPATCHER_DIR, 'active-jobs.json');

const DEFAULTS = {
  runtime: 'docker',
  maxConcurrent: 9,
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
    fs.writeFileSync(ACTIVE_JOBS_PATH, JSON.stringify(jobs, null, 2));
  } catch {
    // best effort
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

module.exports = {
  CONFIG_PATH,
  ACTIVE_JOBS_PATH,
  loadConfig,
  saveConfig,
  getRuntime,
  persistActiveJobs,
  loadActiveJobs,
};
