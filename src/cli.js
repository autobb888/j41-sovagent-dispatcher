#!/usr/bin/env node
/**
 * J41 Dispatcher v2 — Ephemeral Job Containers
 * 
 * Manages pool of pre-registered agents, spawns ephemeral containers per job.
 * Queue if at capacity. Default max concurrent from config.toml (0 = unlimited).
 */

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getRuntime, persistActiveJobs, loadActiveJobs, saveConfig, loadConfig } = require('./config');
const log = require('./logger');
const { loadDispatcherConfig } = require('./config-loader.js');
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
const AGENTS_DIR = path.join(DISPATCHER_DIR, 'agents');
const QUEUE_DIR = path.join(DISPATCHER_DIR, 'queue');
const JOBS_DIR = path.join(DISPATCHER_DIR, 'jobs');
const SEEN_JOBS_PATH = path.join(DISPATCHER_DIR, 'seen-jobs.json');
const FINALIZE_STATE_FILENAME = 'finalize-state.json';

const J41_API_URL = cfg.platform.api_url;
const J41_NETWORK = cfg.platform.network;
const _cfg = loadConfig();
const MAX_AGENTS = cfg.runtime.max_concurrent > 0
  ? cfg.runtime.max_concurrent
  : (_cfg.maxConcurrent ? parseInt(_cfg.maxConcurrent) : Infinity);
const JOB_TIMEOUT_MS = (_cfg.jobTimeoutMin || 60) * 60 * 1000;
const MAX_RETRIES = 2;
const SEEN_JOBS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  return JSON.parse(fs.readFileSync(keysPath, 'utf8'));
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
  } catch {
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
  } catch {
    return new Map();
  }
}

function saveSeenJobs(seen) {
  const obj = Object.fromEntries(seen);
  fs.writeFileSync(SEEN_JOBS_PATH, JSON.stringify(obj, null, 2));
  try { fs.chmodSync(SEEN_JOBS_PATH, 0o600); } catch {}
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
    reworkBudgetPercent: 30,
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
      reworkBudgetPercent: 30,
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
        console.log('   ⚠️  No UTXOs available — identity needs funds for tx fee');
        console.log(`   ↳ Send at least 0.0001 VRSCTEST to ${keys.address}`);
        console.log(`   ↳ VDXF plan saved to: ${planPath}`);
        return;
      }

      // Build and sign the transaction offline
      const rawhex = buildIdentityUpdateTx({
        wif: keys.wif,
        identityData,
        utxos,
        vdxfAdditions,
        network: J41_NETWORK,
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
    console.error('   Install Docker or switch to local mode: node src/cli.js config --runtime local');
    return Promise.resolve([]);
  }
  return docker.listContainers().then(containers => {
    return containers.filter(c =>
      c.Names.some(n => n.startsWith('/j41-job-'))
    );
  }).catch(e => {
    console.error(`❌ Docker error: ${e.message}`);
    console.error('   Install Docker or switch to local mode: node src/cli.js config --runtime local');
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

    if (options.maxConcurrent) {
      const n = parseInt(options.maxConcurrent);
      if (n < 1 || n > 1000) {
        console.error('❌ --max-concurrent must be a positive number');
        process.exit(1);
      }
      config.maxConcurrent = n;
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
    console.log('\nPopular LLM providers: openai, claude, groq, deepseek, ollama');
    const provider = await ask('LLM provider', 'openai');

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

    // Write env hints
    const envHints = [`J41_LLM_PROVIDER=${provider}`];
    if (apiKey) {
      const { LLM_PRESETS } = require('./executors/local-llm.js');
      const preset = LLM_PRESETS[provider];
      if (preset?.envKey) envHints.push(`${preset.envKey}=${apiKey}`);
    }

    console.log('Next steps:\n');
    console.log(`  1. Export your LLM config:`);
    for (const hint of envHints) console.log(`     export ${hint}`);
    console.log(`\n  2. Set up your agent:`);
    console.log(`     node src/cli.js setup agent-1 ${name} --template ${template}`);
    console.log(`\n  3. Start the dispatcher:`);
    console.log(`     node src/cli.js start`);
    console.log('');
  });

// Init command — create N agent identities
program
  .command('init')
  .description('Initialize dispatcher with N agent identities')
  .option('-n, --agents <number>', 'Number of agents to create', '9')
  .option('--soul <file>', 'SOUL.md template to use for all agents')
  .action(async (options) => {
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
      
      fs.writeFileSync(
        path.join(agentDir, 'keys.json'),
        JSON.stringify({ ...keys, network: J41_NETWORK }, null, 2)
      );
      fs.chmodSync(path.join(agentDir, 'keys.json'), 0o600);
      
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
    console.log('  3. Start dispatcher: j41-dispatcher start');
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
      fs.writeFileSync(
        path.join(AGENTS_DIR, agentId, 'keys.json'),
        JSON.stringify(keys, null, 2)
      );

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
        console.error(`   You can retry later with: node src/cli.js finalize ${agentId}`);
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
        fs.writeFileSync(
          path.join(AGENTS_DIR, agentId, 'keys.json'),
          JSON.stringify(keys, null, 2)
        );
        fs.chmodSync(path.join(AGENTS_DIR, agentId, 'keys.json'), 0o600);
        console.error(`\n⚠️  Partial state saved to keys.json`);
        console.error(`   The identity "${keys.identity}" may already exist on-chain.`);
        console.error(`   To check and recover: node src/cli.js recover ${agentId}`);
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
            fs.writeFileSync(
              path.join(AGENTS_DIR, agentId, 'keys.json'),
              JSON.stringify(keys, null, 2)
            );
            fs.chmodSync(path.join(AGENTS_DIR, agentId, 'keys.json'), 0o600);
            console.log(`\n✅ Recovery successful!`);
            console.log(`   Identity: ${keys.identity}`);
            console.log(`   i-Address: ${iAddress}`);
            console.log(`\n   Next: node src/cli.js finalize ${agentId}`);
            return;
          }
        }

        if (status.status === 'failed') {
          console.error(`\n❌ Registration failed on-chain: ${status.error || 'unknown error'}`);
          console.error(`   You may need to re-register: node src/cli.js register ${agentId} <name>`);
          // Clean up timeout state so register can be retried
          delete keys.registrationStatus;
          delete keys.onboardId;
          delete keys.lastOnboardStatus;
          delete keys.identity;
          fs.writeFileSync(
            path.join(AGENTS_DIR, agentId, 'keys.json'),
            JSON.stringify(keys, null, 2)
          );
          process.exit(1);
        }

        // Still confirming — tell user to wait
        console.log(`\n⏳ Identity is still confirming (status: ${status.status}).`);
        console.log(`   Try again in a few minutes: node src/cli.js recover ${agentId}`);
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
      fs.writeFileSync(
        path.join(AGENTS_DIR, agentId, 'keys.json'),
        JSON.stringify(keys, null, 2)
      );
      fs.chmodSync(path.join(AGENTS_DIR, agentId, 'keys.json'), 0o600);

      console.log(`\n✅ Recovery successful!`);
      console.log(`   Identity: ${keys.identity}`);
      if (keys.iAddress) console.log(`   i-Address: ${keys.iAddress}`);
      console.log(`\n   Next: node src/cli.js finalize ${agentId}`);
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
        fs.writeFileSync(path.join(AGENTS_DIR, agentId, 'keys.json'), JSON.stringify(keys, null, 2));
        fs.chmodSync(path.join(AGENTS_DIR, agentId, 'keys.json'), 0o600);

        // Make sure the owning agent has iAddress if it was missing
        if (foundOwner.iAddress) {
          const ownerKeys = loadAgentKeys(foundOwner.agentId);
          if (ownerKeys && !ownerKeys.iAddress) {
            ownerKeys.iAddress = foundOwner.iAddress;
            delete ownerKeys.registrationStatus;
            fs.writeFileSync(path.join(AGENTS_DIR, foundOwner.agentId, 'keys.json'), JSON.stringify(ownerKeys, null, 2));
            fs.chmodSync(path.join(AGENTS_DIR, foundOwner.agentId, 'keys.json'), 0o600);
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
      console.log(`   Run: node src/cli.js set-authorities <agentId> --revoke <iAddr> --recover <iAddr>`);
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

      console.log(`\n   To re-activate: node src/cli.js activate ${agentId}`);
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

      console.log(`\n   Start dispatcher: node src/cli.js start`);
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

// Update profile — remove old VDXF values and write new ones (two-block transaction)
program
  .command('update-profile <agent-id>')
  .description('Update on-chain VDXF profile fields (two-transaction remove + rewrite)')
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
  .option('--dry-run', 'Print payloads without broadcasting')
  .action(async (agentId, options) => {
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
      const { buildContentMultimapRemove, VDXF_KEYS } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
      const iAddrs = Object.keys(fieldsToUpdate).map(f => {
        for (const [, keys] of Object.entries(VDXF_KEYS)) { if (keys[f]) return keys[f]; }
        return f;
      });
      console.log('── Remove Payload (dry-run) ──');
      console.log(JSON.stringify(buildContentMultimapRemove(keys.identity, iAddrs), null, 2));
      console.log('\n── Write Values (dry-run) ──');
      console.log(JSON.stringify(fieldsToUpdate, null, 2));
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
      console.log(`  Remove TX: ${result.removeTxid}`);
      console.log(`  Write TX:  ${result.writeTxid}`);
      console.log(`  Blocks waited: ${result.blocksWaited}`);
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
      fs.writeFileSync(path.join(agentDir, 'keys.json'), JSON.stringify(keys, null, 2));
      fs.chmodSync(path.join(agentDir, 'keys.json'), 0o600);
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
        fs.writeFileSync(path.join(agentDir, 'keys.json'), JSON.stringify(keys, null, 2));
        fs.chmodSync(path.join(agentDir, 'keys.json'), 0o600);
        console.log(`  ✓ Registered: ${regResult.identity} (${regResult.iAddress})`);
      } catch (e) {
        if (e.name === 'RegistrationTimeoutError' || (e.message && e.message.includes('timed out'))) {
          keys.identity = e.identityName || (identityName + '.agentplatform@');
          keys.registrationStatus = 'timeout';
          if (e.onboardId) keys.onboardId = e.onboardId;
          fs.writeFileSync(path.join(agentDir, 'keys.json'), JSON.stringify(keys, null, 2));
          console.error(`  ⚠️  Registration timed out. Run: node src/cli.js recover ${agentId}`);
          console.error(`     Then re-run: node src/cli.js setup ${agentId} ${identityName} [flags...]`);
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
      console.error(`  ⚠️  Finalize: ${e.message}`);
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
    console.log(`\n  Next: node src/cli.js start`);
    console.log(`  Verify: node src/cli.js inspect ${agentId}`);
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
    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

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

// Start command — run the dispatcher (listen for jobs)
program
  .command('start')
  .description('Start the dispatcher (listens for jobs, manages pool)')
  .option('--webhook-url <url>', 'Public URL for receiving webhook events (enables webhook mode)')
  .option('--webhook-port <port>', 'Port for webhook HTTP server (default: 9841)', '9841')
  .option('--dev-unsafe', 'Allow local mode (ZERO isolation — development only)')
  .action(async (options) => {
    ensureDirs();

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
          try {
            process.kill(oldPid, 0); // check if alive (throws if dead)
            process.kill(oldPid, 'SIGTERM');
            console.log(`  Stopped previous dispatcher (PID ${oldPid})`);
            await new Promise(r => setTimeout(r, 1000));
          } catch {}
        }
      }
    } catch {}
    fs.writeFileSync(PID_FILE, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });

    console.log('╔══════════════════════════════════════════╗');
    console.log('║     J41 Dispatcher                       ║');
    console.log('║     Ephemeral Job Containers             ║');
    console.log('║     with Privacy Attestation             ║');
    console.log('╚══════════════════════════════════════════╝\n');
    // Store --dev-unsafe flag in state for local mode gate
    const _devUnsafe = !!options.devUnsafe;

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
    console.log(`Max concurrent: ${MAX_AGENTS === Infinity ? 'unlimited' : MAX_AGENTS}`);
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
          const profile = await tmpAgent._client.getAgent(keys.iAddress || keys.identity);
          tmpAgent.stop();
          if (profile.status === 'inactive' || profile.status === 'disabled') {
            console.log(`⏸  ${agentId} (${keys.identity}): ${profile.status} on platform — skipping`);
            continue;
          }
        } catch (e) {
          // If we can't check, include the agent anyway (fail-open for polling)
          console.log(`⚠️  ${agentId}: could not check platform status (${e.message}) — including`);
        }
      }

      readyAgents.push({ id: agentId, ...keys });
    }
    
    if (readyAgents.length === 0) {
      console.error('\n❌ No agents registered. Run: j41-dispatcher register <agent> <name>');
      process.exit(1);
    }
    
    console.log(`Ready agents: ${readyAgents.length}\n`);
    
    // Start job polling loop
    console.log('→ Starting job listener...\n');
    
    const state = {
      agents: [...readyAgents], // all registered agents (never modified)
      active: new Map(), // jobId -> { agentId, container, startedAt, retries }
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
      _lastExtensionCheck: new Map(), // jobId -> last extension check timestamp
      _pendingWorkspace: new Map(), // jobId -> workspace connect promise
      _devUnsafe, // security: allows local mode when true
    };

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
    const { decodeContentMultimap } = require('@junction41/sovagent-sdk/dist/onboarding/vdxf.js');
    for (let i = 0; i < readyAgents.length; i++) {
      const agentInfo = readyAgents[i];
      // Stagger 2s between agents to avoid rate limiting
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
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
      } catch (e) {
        state.capabilities.set(agentInfo.id, { workspace: false, services: [], profile: null, _fetchFailed: true });
        console.log(`  ${agentInfo.id}: capability fetch failed (${e.message})`);
      }
    }
    console.log('');

    // Retry loop: if any agents failed capability fetch AND no api-endpoint found,
    // retry every 5 minutes. Operator must restart dispatcher once detected.
    const failedAgents = readyAgents.filter(a => state.capabilities.get(a.id)?._fetchFailed);
    const hasApiAfterLoad = readyAgents.some(a => {
      const cap = state.capabilities.get(a.id);
      return cap?.services?.some(s => s.serviceType === 'api-endpoint' || s.endpointUrl || s._isApiEndpoint);
    });
    if (failedAgents.length > 0 && !hasApiAfterLoad) {
      console.log(`  ⚠  ${failedAgents.length} agent(s) failed capability fetch — retrying every 5min`);
      const retryTimer = setInterval(async () => {
        console.log('[Capabilities] Retrying failed agents...');
        for (const agentInfo of failedAgents) {
          try {
            const agent = await getAgentSession(state, agentInfo);
            const svcResp = await agent.client.getAgentServices(agentInfo.iAddress || agentInfo.identity);
            const platformServices = svcResp.data || svcResp || [];
            if (platformServices.some(s => s.serviceType === 'api-endpoint' || s.endpointUrl)) {
              console.log('[Capabilities] ✓ api-endpoint agent detected — restart dispatcher to activate proxy');
              clearInterval(retryTimer);
              return;
            }
          } catch {}
        }
      }, 5 * 60 * 1000);
      retryTimer.unref();
    }

    // Cache dispute policy and markup per agent from VDXF
    for (const agentInfo of readyAgents) {
      try {
        const agent = await getAgentSession(state, agentInfo);
        const identity = await agent.client.getMyIdentity();
        if (identity?.contentmultimap) {
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
            const upstreamAuth = apiSvc.upstreamAuth || localCfg.apiEndpointAuth || '';
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
            } else {
              const verified = await verifyAccessRequest(accessRequest, client, J41_NETWORK);
              if (!verified) throw new Error('Buyer signature verification failed (v1)');
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
          onDepositReport: async ({ buyerVerusId, sellerVerusId, txid, amount }) => {
            const { reportDeposit } = require('./deposit-watcher');
            const sellerAgent = state.agents.find(a =>
              a.iAddress === sellerVerusId || a.identity === sellerVerusId
            );
            if (!sellerAgent) return { credited: false, message: 'Seller not found on this dispatcher' };
            const agent = await getAgentSession(state, sellerAgent);
            const payAddress = sellerAgent.iAddress || sellerAgent.address;
            return reportDeposit(sellerAgent.id, agent._client || agent.client, buyerVerusId, txid, amount, payAddress);
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
        startHealthPoller(agentConfigs);
        console.log(`  Upstream health: polling every 60s`);

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
      const pollInterval = Math.max(60000, agentCount * 1000);
      const reviewInterval = Math.max(60000, agentCount * 1000);
      console.log(`  Poll interval: ${Math.round(pollInterval / 1000)}s (${agentCount} agent${agentCount !== 1 ? 's' : ''})`);

      // Poll for jobs
      safeInterval(() => pollForJobs(state), pollInterval, 'Poll');

      // Check for pending reviews
      safeInterval(() => checkPendingInbox(state), reviewInterval, 'Inbox');
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

    // Status report every minute
    setInterval(() => {
      console.log(`[${new Date().toISOString()}] Active: ${state.active.size}/${MAX_AGENTS}, Queue: ${state.queue.length}, Available: ${state.available.length}, Seen: ${state.seen.size}`);
      pruneSeenJobs(state.seen);
    }, 60000);

    // Catch unhandled rejections
    process.on('unhandledRejection', (reason) => {
      console.error(`[Dispatcher] Unhandled rejection (non-fatal):`, reason?.message || reason);
    });

    // Crash recovery — process orphaned jobs before accepting new ones
    await handleCrashRecovery(state);

    // Initial poll (catch-up for anything missed while offline)
    await pollForJobs(state);

    // ── Start control plane ──
    const { startControlServer, stopControlServer } = require('./control');
    const controlServer = startControlServer(state, {
      onShutdown: (source) => gracefulShutdown(`control-plane (${source})`),
      getAgentSession,
    });

    // ── Set agents active on-chain + platform ──
    console.log('\n→ Setting agents active...');
    for (let i = 0; i < readyAgents.length; i++) {
      const agentInfo = readyAgents[i];
      // Stagger activation — 1s between agents to avoid rate limits at scale
      if (i > 0) await new Promise(r => setTimeout(r, 1000));
      try {
        const agent = await getAgentSession(state, agentInfo);
        const result = await agent.activate({ onChain: true });
        console.log(`  ✅ ${agentInfo.id}: active (on-chain txid: ${result.onChainTxid || 'skipped'})`);
        // Trigger backend re-index so marketplace reflects active status immediately
        try {
          await agent.client.refreshAgent(agentInfo.iAddress || agentInfo.identity);
          console.log(`  ✅ ${agentInfo.id}: backend refreshed`);
        } catch (e) {
          console.log(`  ⚠️  ${agentInfo.id}: backend refresh failed (${e.message.slice(0, 60)})`);
        }
      } catch (e) {
        console.log(`  ⚠️  ${agentInfo.id}: activation failed (${e.message.slice(0, 60)})`);
      }
    }

    console.log('\n✅ Dispatcher running. Press Ctrl+C to stop.\n');

    // ── Graceful shutdown handler ──
    let shuttingDown = false;

    async function gracefulShutdown(signal) {
      if (shuttingDown) {
        // Second signal during drain — emergency exit
        console.log('\n⚠️  Second signal received — emergency exit. Remaining jobs will be refunded on next startup.');
        process.exit(1);
      }
      shuttingDown = true;
      log.warn('Graceful shutdown starting (drain mode)', { signal, activeJobs: state.active.size });
      console.log(`\n🔄 Draining: ${state.active.size} active job(s). Waiting for containers to finish...`);
      console.log('   Press Ctrl+C again for emergency exit.\n');

      // 1. Set agents offline (stop accepting new jobs)
      for (const agentInfo of state.agents) {
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
          try { await agent.setOnChainStatus('inactive'); } catch {}
          // Trigger backend re-index so marketplace shows offline immediately
          try {
            await agent.client.refreshAgent(agentInfo.iAddress || agentInfo.identity);
          } catch {}
        } catch (e) {
          console.log(`   ⚠️  ${agentInfo.id}: failed to mark offline`);
        }
      }

      // 2. Calculate drain timeout
      const cfg = loadConfig();
      const drainTimeoutMs = (cfg.drainTimeoutMin || (cfg.jobTimeoutMin || 60) * 2) * 60 * 1000;

      // 3. If no active jobs, exit immediately
      if (state.active.size === 0) {
        console.log('\n✅ No active jobs. Shutting down.\n');
        persistActiveJobs(state.active);
        stopControlServer(controlServer);
        process.exit(0);
      }

      // 4. Monitor until all containers finish or timeout
      const drainStart = Date.now();
      const drainInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - drainStart) / 1000);
        console.log(`   Draining: ${state.active.size} job(s) remaining (${elapsed}s elapsed)`);

        if (state.active.size === 0) {
          clearInterval(drainInterval);
          console.log('\n✅ All jobs finished. Shutting down.\n');
          state.active.clear();
          persistActiveJobs(state.active);
          stopControlServer(controlServer);
          process.exit(0);
        }

        if (Date.now() - drainStart > drainTimeoutMs) {
          clearInterval(drainInterval);
          console.log(`\n⚠️  Drain timeout (${Math.round(drainTimeoutMs / 60000)}min) — remaining ${state.active.size} job(s) will be refunded on next startup.`);
          // Don't clear active-jobs.json — crash recovery will handle refunds
          stopControlServer(controlServer);
          process.exit(1);
        }
      }, 10000);
    }

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Keep alive
    await new Promise(() => {});
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
      // List all jobs with logs
      if (!fs.existsSync(JOBS_DIR)) {
        console.log('No job logs found.');
        return;
      }
      const jobDirs = fs.readdirSync(JOBS_DIR).filter(d => {
        return fs.existsSync(path.join(JOBS_DIR, d, 'output.log'));
      });

      if (jobDirs.length === 0) {
        console.log('No job logs found. Logs are written when the dispatcher runs jobs.');
        return;
      }

      console.log(`\n── Job Logs (${jobDirs.length}) ──\n`);
      for (const dir of jobDirs.slice(-20)) { // last 20
        const logPath = path.join(JOBS_DIR, dir, 'output.log');
        const stat = fs.statSync(logPath);
        const agentFile = path.join(JOBS_DIR, dir, 'buyer.txt');
        const buyer = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf-8').trim() : '?';
        const size = (stat.size / 1024).toFixed(1);
        console.log(`  ${dir.substring(0, 8)}  ${stat.mtime.toISOString().substring(0, 19)}  ${size}KB  buyer: ${buyer}`);
      }
      console.log(`\n  View: node src/cli.js logs <job-id-prefix>`);
      console.log(`  Tail: node src/cli.js logs <job-id-prefix> -f`);
      return;
    }

    // Find matching job dir (supports prefix match)
    if (!fs.existsSync(JOBS_DIR)) {
      console.error(`❌ No jobs directory found.`);
      process.exit(1);
    }
    const matches = fs.readdirSync(JOBS_DIR).filter(d => d.startsWith(jobId));
    if (matches.length === 0) {
      console.error(`❌ No job found matching "${jobId}"`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`❌ Ambiguous prefix "${jobId}" — matches ${matches.length} jobs:`);
      matches.forEach(m => console.error(`   ${m}`));
      process.exit(1);
    }

    const fullJobId = matches[0];
    const logPath = path.join(JOBS_DIR, fullJobId, 'output.log');

    if (!fs.existsSync(logPath)) {
      console.error(`❌ No log file for job ${fullJobId}`);
      // Show what files exist
      const files = fs.readdirSync(path.join(JOBS_DIR, fullJobId));
      console.log(`   Files: ${files.join(', ')}`);
      process.exit(1);
    }

    if (options.follow) {
      // tail -f mode
      console.log(`── Following ${fullJobId.substring(0, 8)} (Ctrl+C to stop) ──\n`);
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      const n = parseInt(options.lines) || 50;
      const tail = lines.slice(-n);
      process.stdout.write(tail.join('\n'));

      // Watch for changes
      let pos = fs.statSync(logPath).size;
      fs.watchFile(logPath, { interval: 500 }, () => {
        const newSize = fs.statSync(logPath).size;
        if (newSize > pos) {
          const fd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(newSize - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          process.stdout.write(buf.toString());
          pos = newSize;
        }
      });

      // Keep alive
      await new Promise(() => {});
    } else {
      // Static output
      const content = fs.readFileSync(logPath, 'utf-8');
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
        const att = JSON.parse(fs.readFileSync(attPath, 'utf8'));
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

async function getAgentSession(state, agentInfo) {
  const { J41Agent } = require('@junction41/sovagent-sdk/dist/index.js');
  const baseUrl = J41_API_URL;

  const cached = state.agentSessions.get(agentInfo.id);
  if (cached && (Date.now() - cached.authedAt) < SESSION_TTL_MS) {
    return cached.agent;
  }

  const agent = new J41Agent({
    apiUrl: baseUrl,
    wif: agentInfo.wif,
    identityName: agentInfo.identity,
    iAddress: agentInfo.iAddress,
  });
  await agent.authenticate();
  state.agentSessions.set(agentInfo.id, { agent, authedAt: Date.now() });
  return agent;
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

/**
 * VDXF Policy Check: verify agent has workspace.capability on-chain before
 * forwarding workspace_ready to job-agent. Returns true if allowed.
 */
function checkWorkspaceCapability(state, agentId) {
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

/**
 * Handle crash recovery: detect orphaned jobs from active-jobs.json,
 * issue refunds for interrupted jobs, clean up Docker containers.
 */
async function handleCrashRecovery(state) {
  const orphanedJobs = loadActiveJobs();
  const jobIds = Object.keys(orphanedJobs);
  if (jobIds.length === 0) return;

  console.log(`\n⚠️  Crash recovery: found ${jobIds.length} orphaned job(s)`);

  for (const jobId of jobIds) {
    const orphan = orphanedJobs[jobId];
    console.log(`  Processing ${jobId.substring(0, 8)}...`);

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

      const finishedStatuses = ['completed', 'resolved', 'resolved_rejected', 'cancelled'];
      if (finishedStatuses.includes(currentJob.status)) {
        console.log(`    ✅ Job already ${currentJob.status} — cleaning up`);
        continue;
      }

      // Job was interrupted — issue refund
      const policy = state.disputePolicy?.get(agentInfo.id);
      const refundPercent = policy?.systemCrashRefund ?? 100;
      const jobAmount = orphan.jobAmount || currentJob.amount || 0;
      const refundAmount = jobAmount * (refundPercent / 100);
      const buyerAddress = orphan.buyerPayAddress || currentJob.buyerPayAddress;

      if (refundAmount > 0 && buyerAddress) {
        // ── Allowlist check before refund ──
        const allowlist = loadFinancialAllowlist();
        if (!isAddressInAllowlist(allowlist, buyerAddress)) {
          console.error(`    ❌ BLOCKED: Refund address ${buyerAddress} not in allowlist — skipping refund`);
        } else {
          console.log(`    💸 Issuing ${refundPercent}% refund: ${refundAmount} ${orphan.currency || 'VRSC'} to ${buyerAddress}`);
          try {
            const txid = await agent.sendCurrency(buyerAddress, refundAmount);
            console.log(`    ✅ Refund TX: ${txid}`);

            try {
              await agent.client.submitRefundTxid(jobId, txid);
            } catch (e) {
              console.log(`    ⚠️  Could not record refund on platform: ${e.message}`);
            }

            try {
              await agent.client.sendChatMessage(jobId, `System failure — ${refundPercent}% refund issued. TX: ${txid}`);
            } catch (e) {
              console.log(`    ⚠️  Could not notify buyer: ${e.message}`);
            }
          } catch (e) {
            console.error(`    ❌ Refund TX failed: ${e.message}`);
          }
        }
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

  // Clear orphaned jobs file
  persistActiveJobs(new Map());
  console.log(`✅ Crash recovery complete\n`);
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
async function pollForJobs(state) {
  if (_polling) return; // guard against concurrent polls
  _polling = true;
  try {
  for (let i = 0; i < state.agents.length; i++) {
    const agentInfo = state.agents[i];
    // Stagger API calls — 500ms between agents to avoid rate limits at scale
    if (i > 0) await new Promise(r => setTimeout(r, 500));
    try {
      console.log(`[Poll] Checking ${agentInfo.id} (${agentInfo.identity || agentInfo.address})`);

      const agent = await getAgentSession(state, agentInfo);

      // Fetch all active jobs in one call (requested + accepted + in_progress)
      // Single API call instead of 3 separate ones to reduce rate limiting
      const result = await agent.client.getMyJobs({ role: 'seller' });
      const allJobs = Array.isArray(result?.data) ? result.data : [];
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
        const TERMINAL_STATUSES = ['delivered', 'completed', 'cancelled', 'resolved', 'resolved_rejected'];
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
              const timestamp = Math.floor(Date.now() / 1000);
              const acceptSig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
              await agent.client.acceptJob(job.id, acceptSig, timestamp, agentInfo.address);
              console.log(`✅ Job ${job.id} accepted (signed, pay→${agentInfo.address.slice(0, 8)}...) — awaiting buyer payment`);

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
        const isPaid = job.status === 'in_progress' ||
          (job.payment && job.payment.verified === true) ||
          (job.payment && (job.payment.status === 'confirmed' || job.payment.status === 'completed')) ||
          (!job.payment); // platform doesn't populate payment → don't block

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
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'disputed') {
        sendToJobAgent(activeInfo, { type: 'dispute.filed', data: { jobId, reason: currentJob.dispute?.reason } });
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
        state._lastSentStatus.set(jobId, currentJob.status);
      }

      // Poll-mode fallback: detect paused → in_progress (resume happened without webhook)
      if (currentJob.status === 'in_progress' && activeInfo.paused) {
        console.log(`[Poll] Job ${jobId.substring(0, 8)} resumed (was paused) — unthrottling`);
        activeInfo.paused = false;
        activeInfo.pausedAt = null;
        activeInfo.resumedAt = Date.now();
        state.available = state.available.filter(a => a.id !== activeInfo.agentInfo?.id);
        sendToJobAgent(activeInfo, { type: 'reconnect', jobId });
        state._lastSentStatus.set(jobId, currentJob.status);
      }
    } catch (e) {
      // Job may have been deleted — ignore
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
          state._lastExtensionCheck.set(ext.id, Date.now());
          await handleExtensionRequest(state, jobId, ext.id, activeInfo.agentInfo);
        }
      }
    } catch {
      // Ignore — extensions endpoint may not exist for this job
    }
  }

  // Check paused jobs for TTL expiry
  for (const [jobId, info] of state.active) {
    if (!info.paused || !info.pausedAt) continue;
    const pauseMinutes = (Date.now() - info.pausedAt) / 60000;
    const ttl = info.pauseTTL || 60;
    if (pauseMinutes >= ttl) {
      console.log(`[TTL] Job ${jobId.substring(0, 8)} paused for ${Math.round(pauseMinutes)}min (TTL: ${ttl}min) — auto-delivering`);
      if (info.process?.send) {
        info.process.send({ type: 'ttl_expired', jobId });
      }
      // Remove agent from available pool (was freed on pause) so stopJob can return it cleanly
      state.available = state.available.filter(a => a.id !== info.agentInfo?.id);
      // Mark as no longer paused to avoid re-sending
      info.paused = false;
      info.pausedAt = null;
    }
  }

  // Flush queued workspace messages for newly-spawned job-agents
  if (state._pendingWorkspace?.size) {
    for (const [pendingJobId, wsData] of state._pendingWorkspace) {
      const activeInfo = state.active.get(pendingJobId);
      if (activeInfo?.process?.send) {
        if (!checkWorkspaceCapability(state, activeInfo.agentId)) {
          state._pendingWorkspace.delete(pendingJobId);
          continue;
        }
        activeInfo.process.send({
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
    if (!activeInfo.process?.send) continue;
    if (!checkWorkspaceCapability(state, activeInfo.agentId)) {
      activeInfo.workspaceNotified = true; // Don't check again
      continue;
    }
    try {
      const agentSession = await getAgentSession(state, activeInfo.agentInfo);
      const wsStatus = await agentSession.client.getWorkspaceStatus(activeJobId);
      if (wsStatus?.status === 'active' || wsStatus?.status === 'pending') {
        activeInfo.process.send({
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

  // Process queue if slots available (D3: re-queue on failure instead of dropping)
  while (state.queue.length > 0 && state.active.size < MAX_AGENTS && state.available.length > 0) {
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
async function handleWebhookEvent(state, agentId, payload) {
  const agentInfo = state.agents.find(a => a.id === agentId);
  if (!agentInfo) {
    console.error(`[Webhook] Unknown agent: ${agentId}`);
    return;
  }

  const { event, data } = payload;
  const jobId = data?.jobId || payload.jobId;
  console.log(`[Webhook] ${agentInfo.id}: ${event}${jobId ? ' ' + jobId.substring(0, 8) : ''}`);

  switch (event) {
    case 'job.requested': {
      if (!jobId || state.seen.has(jobId) || state.active.has(jobId)) return;
      try {
        const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
        const agent = await getAgentSession(state, agentInfo);
        const fullJob = await agent.client.getJob(jobId);
        if (fullJob?.jobHash && fullJob?.buyerVerusId) {
          const timestamp = Math.floor(Date.now() / 1000);
          const sig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
          await agent.client.acceptJob(jobId, sig, timestamp, agentInfo.address);
          console.log(`[Webhook] ✅ Job ${jobId.substring(0, 8)} accepted (pay→${agentInfo.address.slice(0, 8)}...)`);

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
      // Forward to running job-agent via IPC
      const activeJob = state.active.get(jobId);
      if (activeJob?.process?.send) {
        activeJob.process.send({ type: 'dispute.filed', data: { reason: data?.reason, disputedBy: data?.disputedBy } });
      }
      break;
    }

    case 'job.dispute.responded': {
      console.log(`[Webhook] Dispute response for job ${jobId?.substring(0, 8)}: action=${data?.action || '?'}`);
      break;
    }

    case 'job.dispute.resolved': {
      console.log(`[Webhook] ✅ Dispute resolved for job ${jobId?.substring(0, 8)}: ${data?.action || '?'}`);
      const resolvedJob = state.active.get(jobId);
      if (resolvedJob?.process?.send) {
        resolvedJob.process.send({ type: 'dispute.resolved', data });
      }
      break;
    }

    case 'job.dispute.rework_accepted': {
      console.log(`[Webhook] 🔄 Rework accepted for job ${jobId?.substring(0, 8)}`);
      const reworkJob = state.active.get(jobId);
      if (reworkJob?.process?.send) {
        reworkJob.process.send({ type: 'dispute.rework_accepted', data });
      }
      break;
    }

    case 'job.completed': {
      console.log(`[Webhook] ✅ Job ${jobId?.substring(0, 8)} completed`);
      const completedJob = state.active.get(jobId);
      if (completedJob?.process?.send) {
        completedJob.process.send({ type: 'job.completed', data });
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
      if (activeInfo?.process?.send) {
        if (!checkWorkspaceCapability(state, activeInfo.agentId)) {
          console.log(`[Webhook] Workspace ready — BLOCKED by VDXF policy for ${activeInfo.agentId}`);
          break;
        }
        activeInfo.process.send({
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
      if (activeInfo2?.process?.send) {
        activeInfo2.process.send({
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
      if (endSessionJob?.process?.send) {
        endSessionJob.process.send({ type: 'end_session_request', jobId });
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
      const resumeInfo = state.active.get(jobId);
      if (resumeInfo) {
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
      if (pauseInfo && !pauseInfo.paused) {
        pauseInfo.paused = true;
        pauseInfo.pausedAt = Date.now();
        pauseInfo.pauseCount = (pauseInfo.pauseCount || 0) + 1;
        state.available.push(pauseInfo.agentInfo);
        // For free-lifecycle agents, auto-extend to resume
        if (data?.auto && pauseInfo.reactivationFee === 0) {
          try {
            const agentSession = await getAgentSession(state, pauseInfo.agentInfo);
            await agentSession.client.requestExtension(jobId, { amount: 0, currency: pauseInfo.currency || 'VRSC', reason: 'Auto-resume (free lifecycle)' });
            console.log(`[Webhook] Auto-extended paused job ${jobId?.substring(0, 8)} (free lifecycle)`);
          } catch (extErr) {
            console.warn(`[Webhook] Auto-extend failed: ${extErr.message}`);
          }
        }
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
            await startJob(state, agentInfo, fullJob);
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
      if (extJob?.process?.send) {
        extJob.process.send({ type: 'budget_increased', data: { additionalTokens: data?.estimatedTokens || 5000 } });
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

// Check for pending inbox items (reviews + job records) and process them
async function checkPendingInbox(state) {
  for (let i = 0; i < state.agents.length; i++) {
    const agentInfo = state.agents[i];
    if (!agentInfo.identity || !agentInfo.wif || !agentInfo.iAddress) continue;
    if (i > 0) await new Promise(r => setTimeout(r, 500));

    try {
      const agent = await getAgentSession(state, agentInfo);
      const inbox = await agent.client.getInbox('pending', 20);
      const pending = (inbox?.data || []).filter(
        item => item.type === 'review' || item.type === 'job_record'
      );
      if (pending.length === 0) continue;

      console.log(`[Inbox] ${agentInfo.id}: ${pending.length} pending item(s)`);

      for (const item of pending) {
        try {
          if (item.type === 'review') {
            console.log(`[Inbox] Processing review ${item.id}`);
            await agent.acceptReview(item.id);
            console.log(`[Inbox] ✅ Review accepted for ${agentInfo.id}`);
          } else if (item.type === 'job_record') {
            console.log(`[Inbox] Processing job record ${item.id}`);
            await agent.acceptJobRecord(item.id);
            console.log(`[Inbox] ✅ Job record written on-chain for ${agentInfo.id}`);
          }
        } catch (e) {
          console.error(`[Inbox] ❌ Failed to process ${item.type} ${item.id}:`, e.message);
        }
      }
    } catch (e) {
      state.agentSessions.delete(agentInfo.id);
      if (!e.message.includes('not registered')) {
        console.error(`[Inbox] Error checking ${agentInfo.id}:`, e.message);
      }
    }
  }
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
      const keys = JSON.parse(fs.readFileSync(path.join(agentDir, 'keys.json'), 'utf8'));
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

  // Container-side retry tuning. job-agent.js reads this from process.env directly
  // (Docker is its only env channel); without forwarding, the configured value would
  // never reach the container.
  env.J41_RATE_LIMIT_BACKOFF_MULTIPLIER = String(cfg.retry.rate_limit_backoff_multiplier);

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
  const seccompPath = process.platform === 'linux'
    ? '/etc/j41/seccomp-agent.json'
    : path.join(os.homedir(), '.j41', 'seccomp-agent.json');

  if (fs.existsSync(seccompPath)) {
    opts.push(`seccomp=${seccompPath}`);
  }

  // AppArmor — Linux only
  if (process.platform === 'linux') {
    try {
      const profiles = fs.readFileSync('/sys/kernel/security/apparmor/profiles', 'utf8');
      if (profiles.includes('j41-agent-profile')) {
        opts.push('apparmor=j41-agent-profile');
      }
    } catch {
      // AppArmor not available — skip
    }
  }

  return opts;
}

function getDispatcherNetworkMode() {
  // Use j41-isolated network if it exists, otherwise default bridge
  try {
    require('child_process').execSync('docker network inspect j41-isolated', { stdio: 'ignore', timeout: 5000 });
    return 'j41-isolated';
  } catch {
    return 'bridge';
  }
}

function getDispatcherBwrapConfig() {
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

// Start a job container
async function startJobContainer(state, job, agentInfo) {
  if (!docker) {
    throw new Error('Docker not available. Switch to local mode: node src/cli.js config --runtime local');
  }
  const jobDir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  // Ensure writable across rootless/user-namespaced container runtimes
  // Use 0o755 — NOT 0o777 which lets any host process read/tamper job data
  try {
    fs.chmodSync(jobDir, 0o755);
  } catch {
    // best effort
  }
  
  // Write job data
  fs.writeFileSync(path.join(jobDir, 'description.txt'), job.description);
  fs.writeFileSync(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);
  fs.writeFileSync(path.join(jobDir, 'amount.txt'), String(job.amount));
  fs.writeFileSync(path.join(jobDir, 'currency.txt'), job.currency);

  // Mandatory canary token (Plan B: every job gets one)
  const canaryToken = require('crypto').randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(jobDir, 'canary.token'), canaryToken, { mode: 0o600 });

  const agentDir = path.join(AGENTS_DIR, agentInfo.id);
  const keysPath = path.join(agentDir, 'keys.json');

  // Copy keys to a temp file OUTSIDE the writable job dir to avoid double-exposing the WIF.
  // The job dir is mounted rw (/app/job), so keys must not be inside it.
  const tmpKeysDir = path.join(os.tmpdir(), `j41-keys-${job.id}`);
  fs.mkdirSync(tmpKeysDir, { recursive: true, mode: 0o700 });
  const tmpKeysPath = path.join(tmpKeysDir, 'keys.json');
  fs.copyFileSync(keysPath, tmpKeysPath);
  try {
    fs.chmodSync(tmpKeysPath, 0o644); // container process needs read access; mount is :ro
  } catch {
    // best effort on systems that don't support chmod
  }

  try {
    const keepContainers = cfg.runtime.keep_containers;
    const containerName = `j41-job-${job.id}`;

    // Remove stale container with same name (leftover from crash/restart)
    try {
      require('child_process').execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 10000 });
      console.log(`  ♻️  Removed stale container ${containerName}`);
    } catch {}

    const container = await docker.createContainer({
      name: containerName,
      Image: 'j41/job-agent:latest',  // PRE-BAKED IMAGE
      // Docker bind-mounts keys.json/SOUL.md/job into /app/* — strip the
      // host-path env vars buildContainerEnv emits (they're host paths and would
      // override the in-container defaults the job-agent expects: /app/keys.json,
      // /app/SOUL.md, /app/job).
      Env: Object.entries(buildContainerEnv(job, agentInfo, loadAgentConfig(agentInfo.id), canaryToken, jobDir, tmpKeysPath))
            .filter(([k, v]) => v !== undefined && v !== '' &&
              k !== 'J41_KEYS_FILE' && k !== 'J41_SOUL_FILE' && k !== 'J41_JOB_DIR')
            .map(([k, v]) => `${k}=${v}`)
            .concat(getExecutorEnvVars(agentInfo).filter(s => !s.startsWith('J41_LLM_'))),
      HostConfig: {
        Binds: [
          // job dir must be writable for attestation artifacts (creation/deletion json)
          `${jobDir}:/app/job`,
          `${tmpKeysPath}:/app/keys.json:ro`,
          `${path.join(agentDir, 'SOUL.md')}:/app/SOUL.md:ro`,
        ],
        // Run as host UID so bind-mounted job dir is writable
        User: `${process.getuid()}:${process.getgid()}`,
        AutoRemove: !keepContainers,
        Memory: 2 * 1024 * 1024 * 1024, // 2GB
        CpuQuota: 100000, // 1 CPU core
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        PidsLimit: 64,
        CapDrop: ['ALL'],
        Dns: ['8.8.8.8', '1.1.1.1'], // j41-isolated network can't use host systemd-resolved
        // --- Security hardening (Plan B) ---
        SecurityOpt: buildDispatcherSecurityOpt(),
        NetworkMode: getDispatcherNetworkMode(),
        ...(supportsStorageOpt() ? { StorageOpt: { size: '1G' } } : {}),
        OomScoreAdj: 1000,
        // gVisor runtime (if configured as Docker default)
        ...(isGvisorAvailable() ? { Runtime: 'runsc' } : {}),
        ...(getDispatcherBwrapConfig()),
      },
      Labels: {
        'j41.job.id': job.id,
        'j41.agent.id': agentInfo.id,
        'j41.started': String(Date.now()),
        'j41.ephemeral': 'true',
      },
    });
    
    await container.start();
    
    state.active.set(job.id, {
      agentId: agentInfo.id,
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
    });

    // Mark as seen immediately to avoid duplicate pickup loops while status remains requested
    state.seen.set(job.id, Date.now());
    saveSeenJobs(state.seen);
    
    // Remove from available pool
    state.available = state.available.filter(a => a.id !== agentInfo.id);
    persistActiveJobs(state.active);

    console.log(`✅ Container started for job ${job.id}`);

    // Stream container logs to dispatcher stdout for debugging
    try {
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: false,
      });
      const shortId = job.id.substring(0, 8);
      logStream.on('data', (chunk) => {
        // Docker multiplexed stream: first 8 bytes are header, rest is payload
        const lines = chunk.toString('utf8').replace(/[\x00-\x08]/g, '').trim();
        if (lines) {
          for (const line of lines.split('\n')) {
            const clean = line.trim();
            if (clean) console.log(`  [${shortId}] ${clean}`);
          }
        }
      });
      logStream.on('error', () => {}); // ignore stream errors when container exits
    } catch (e) {
      // Non-fatal: log streaming is for debugging only
    }

    // Set timeout — offset +60s from container's internal timeout
    // so the container can self-terminate and submit attestation first
    const _timeoutTimer = setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        console.log(`⏰ Job ${job.id} timeout, killing container`);
        await stopJobContainer(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);

    // Store timer ref so it can be cleared on job cleanup
    const activeEntry = state.active.get(job.id);
    if (activeEntry) activeEntry._timeoutTimer = _timeoutTimer;

  } catch (e) {
    console.error(`❌ Failed to start container for ${job.id}:`, e.message);
    // Return agent to pool
    state.available.push(agentInfo);
  }
}

// Stop a job container
async function stopJobContainer(state, jobId, skipReturnAgent = false) {
  const active = state.active.get(jobId);
  if (!active) return;

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

  // H3: No need to restore keys.json chmod — original was never modified.
  // The temp copy in jobDir will be cleaned up below.

  // Cleanup job dir (retain for debugging if requested)
  const jobDir = path.join(JOBS_DIR, jobId);
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    fs.rmSync(jobDir, { recursive: true });
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

  // Prune per-job tracking Maps to prevent memory leaks
  state._lastSentStatus.delete(jobId);
  state._lastExtensionCheck.delete(jobId);
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
  // Security gate: block local mode unless --dev-unsafe was passed
  if (!state._devUnsafe) {
    console.error('');
    console.error('  ============================================================');
    console.error('  BLOCKED: Local mode runs agents with ZERO isolation.');
    console.error('  The agent process has full access to this machine.');
    console.error('');
    console.error('  To use local mode for development ONLY:');
    console.error('    node src/cli.js start --dev-unsafe');
    console.error('');
    console.error('  For production: switch to docker runtime:');
    console.error('    node src/cli.js config --runtime docker');
    console.error('  ============================================================');
    console.error('');
    throw new Error('Local mode blocked — use --dev-unsafe for development');
  }
  const jobDir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  // Write job data (same as Docker mode)
  fs.writeFileSync(path.join(jobDir, 'description.txt'), job.description);
  fs.writeFileSync(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);
  fs.writeFileSync(path.join(jobDir, 'amount.txt'), String(job.amount));
  fs.writeFileSync(path.join(jobDir, 'currency.txt'), job.currency);

  // Mandatory canary token (Plan B: every job gets one)
  const canaryToken = require('crypto').randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(jobDir, 'canary.token'), canaryToken, { mode: 0o600 });

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
    const logPath = path.join(jobDir, 'output.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] Job started — agent: ${agentInfo.id}, PID: ${child.pid}\n`);

    child.stdout.on('data', (data) => {
      const text = data.toString();
      logStream.write(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  [${shortId}] ${line.trim()}`);
      });
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      logStream.write(text);
      text.trim().split('\n').forEach(line => {
        if (line.trim()) console.error(`  [${shortId}] ${line.trim()}`);
      });
    });

    child.on('exit', () => {
      logStream.write(`[${new Date().toISOString()}] Job process exited\n`);
      logStream.end();
    });

    // Handle IPC from job-agent
    child.on('message', (msg) => {
      if (msg?.type === 'job_idle') {
        const info = state.active.get(msg.jobId);
        // Guard: don't re-pause if a resume webhook already cleared it (race condition)
        if (info && !info.paused && !info.resumedAt) {
          info.paused = true;
          info.pausedAt = Date.now();
          info.pauseTTL = parseInt(env.PAUSE_TTL_MS || '3600000') / 60000;
          // Free the agent slot
          if (info.agentInfo && !state.available.some(a => a.id === info.agentInfo.id)) {
            state.available.push(info.agentInfo);
          }
          console.log(`[IDLE] Job ${msg.jobId.substring(0, 8)} paused — agent slot freed`);
          persistActiveJobs(state.active);
        }
      }
      if (msg?.type === 'extension_needed') {
        console.log(`[Extension] Job ${msg.jobId?.substring(0, 8)} requesting extension: $${msg.amount} for ~${msg.estimatedTokens} tokens`);
        (async () => {
          try {
            const agent = await getAgentSession(state, agentInfo);
            await agent.client.requestExtension(msg.jobId, msg.amount, msg.reason);
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

    state.active.set(job.id, {
      agentId: agentInfo.id,
      process: child,
      pid: child.pid,
      startedAt: Date.now(),
      agentInfo,
      workspaceNotified: false,
      workspaceChecked: false,
      paused: false,
      pausedAt: null,
      pauseTTL: job.lifecycle?.pauseTTL || 60,
      jobAmount: job.amount || 0,
      buyerPayAddress: job.buyerPayAddress || job.buyer?.payAddress || null,
      currency: job.currency || 'VRSC',
      agentInfoId: agentInfo.id,
      reworkCount: 0,
    });

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
    state.available.push(agentInfo);
  }
}

async function stopJobLocal(state, jobId, skipReturnAgent = false) {
  const active = state.active.get(jobId);
  if (!active) return;

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

  // Cleanup job dir
  const jobDir = path.join(JOBS_DIR, jobId);
  if (fs.existsSync(jobDir) && !cfg.runtime.keep_containers) {
    fs.rmSync(jobDir, { recursive: true });
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
  state._lastExtensionCheck.delete(jobId);
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
      try {
        const container = docker.getContainer(`j41-job-${jobId}`);
        const info = await container.inspect();

        if (!info.State.Running) {
          const exitCode = info.State.ExitCode;
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
                console.error(`❌ Could not re-fetch job ${jobId} for retry: ${fetchErr.message}`);
                await stopJobContainer(state, jobId);
                continue;
              }
              await stopJobContainer(state, jobId, true);
              await startJobContainer(state, job, agentInfo);
              continue;
            }
            console.log(`❌ Job ${jobId} failed after ${MAX_RETRIES + 1} attempts`);
          }
          await stopJobContainer(state, jobId);
        }
      } catch (e) {
        console.log(`🗑️  Container for job ${jobId} gone`);
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

      const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
      const { J41Agent } = require('@junction41/sovagent-sdk');
      const agent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
      await agent.authenticate();

      const result = await agent.respondToDispute(jobId, {
        action,
        refundPercent: options.refundPercent ? parseInt(options.refundPercent, 10) : undefined,
        reworkCost: parseFloat(options.reworkCost) || 0,
        message,
      });

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
  .description('Send command to running dispatcher: status, jobs, agents, resources, earnings, history, providers, shutdown, canary')
  .option('--agent <id>', 'Agent ID (for canary command)')
  .option('--json', 'Raw JSON output')
  .action(async (command, options) => {
    const { sendCommand } = require('./control');

    try {
      const cmd = { action: command };
      if (options.agent) cmd.agentId = options.agent;

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
        const keys = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, dir, 'keys.json'), 'utf8'));
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
    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
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
    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

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
    const keysPath = path.join(AGENTS_DIR, agent.id, 'keys.json');
    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

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
      fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));
      console.log(`  Done: ${result.identity} (${result.iAddress})\n`);
    } catch (e) {
      console.error(`  Failed: ${e.message}\n`);
    }
  }

  async function publishVdxfUpdate(agent) {
    const keysPath = path.join(AGENTS_DIR, agent.id, 'keys.json');
    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
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

      const newCmm = buildAgentContentMultimap(profile, services || [], disputePolicy);
      const rawhex = buildIdentityUpdateTx({
        wif: keys.wif, identityData, utxos, vdxfAdditions: newCmm,
        network: J41_NETWORK, clearContentmultimap: true,
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
    const { generateKeypair } = require('./keygen.js');
    const keys = generateKeypair(J41_NETWORK);
    keys.network = J41_NETWORK;
    fs.writeFileSync(path.join(agentDir, 'keys.json'), JSON.stringify(keys, null, 2));
    fs.chmodSync(path.join(agentDir, 'keys.json'), 0o600);
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

// ── Entry point ──

if (process.env.NODE_ENV === 'test') {
  module.exports = { buildContainerEnv, loadAgentConfig };
} else if (process.argv.length <= 2) {
  // No command — launch interactive dashboard
  require('./dashboard.js');
} else {
  program.parse();
}
