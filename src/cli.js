#!/usr/bin/env node
/**
 * J41 Dispatcher v2 — Ephemeral Job Containers
 * 
 * Manages pool of pre-registered agents, spawns ephemeral containers per job.
 * Max 9 concurrent. Queue if at capacity.
 */

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getRuntime, persistActiveJobs, loadActiveJobs, saveConfig, loadConfig } = require('./config');
const log = require('./logger');

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

const J41_DIR = path.join(os.homedir(), '.j41');
const DISPATCHER_DIR = path.join(J41_DIR, 'dispatcher');
const AGENTS_DIR = path.join(DISPATCHER_DIR, 'agents');
const QUEUE_DIR = path.join(DISPATCHER_DIR, 'queue');
const JOBS_DIR = path.join(DISPATCHER_DIR, 'jobs');
const SEEN_JOBS_PATH = path.join(DISPATCHER_DIR, 'seen-jobs.json');
const FINALIZE_STATE_FILENAME = 'finalize-state.json';

const J41_API_URL = process.env.J41_API_URL || 'https://api.junction41.io';
const J41_NETWORK = process.env.J41_NETWORK || 'verustest';
const _cfg = loadConfig();
const MAX_AGENTS = parseInt(process.env.J41_MAX_CONCURRENT || _cfg.maxConcurrent || 9);
const JOB_TIMEOUT_MS = (_cfg.jobTimeoutMin || 60) * 60 * 1000;
const MAX_RETRIES = 2;
const SEEN_JOBS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
}

function loadAgentKeys(agentId) {
  // P2-4: Validate agentId format to prevent path traversal
  if (!/^agent-[1-9][0-9]*$/.test(agentId)) {
    throw new Error('Invalid agent ID format');
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
  if (!/^agent-[1-9][0-9]*$/.test(agentId)) {
    throw new Error('Invalid agent ID format');
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

  // Extract defaults from SOUL.md
  const soulName = (soulContent.match(/^#\s+(.+?)(?:\s*—.*)?$/m) || [])[1] || keys.identity;
  const soulDesc = (soulContent.match(/^(?!#)(?!\s*$)(.+)$/m) || [])[1] || '';

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Agent Profile Setup — 25-key VDXF flat format   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Core fields ──
  console.log('── Core Agent Fields ──');
  const name = await ask('  Display name', soulName);
  const type = await ask('  Type (autonomous|assisted|hybrid|tool)', 'autonomous');
  const description = await ask('  Description', soulDesc);
  const payAddress = await ask('  Payment address (i-addr or R-addr)', keys.iAddress);

  // ── Network ──
  console.log('\n── Network ──');
  const capsRaw = await ask('  Capabilities (comma-separated)', 'research,writing,analysis');
  const capabilities = capsRaw ? capsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const epsRaw = await ask('  Endpoints (comma-separated URLs)', 'https://api.junction41.io/v1');
  const endpoints = epsRaw ? epsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const protosRaw = await ask('  Protocols (comma-separated: MCP,REST,A2A,WebSocket)', 'MCP,REST');
  const protocols = protosRaw ? protosRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  // ── Profile ──
  console.log('\n── Profile Metadata ──');
  const category = await ask('  Category', 'general');
  const tagsRaw = await ask('  Tags (comma-separated)', 'ai,autonomous');
  const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const website = await ask('  Website URL (optional)');
  const avatar = await ask('  Avatar URL (optional)');

  // ── Models & Pricing ──
  console.log('\n── Models & Pricing ──');
  const modelsRaw = await ask('  LLM models (comma-separated)', 'claude-opus-4-6');
  const models = modelsRaw ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const markupRaw = await ask('  Markup multiplier (1-50)', '1');
  const markup = Math.max(1, Math.min(50, parseInt(markupRaw, 10) || 1));

  // ── Session Limits ──
  console.log('\n── Session Limits ──');
  const duration = parseInt(await ask('  Max duration in seconds', '7200'), 10) || 7200;
  const tokenLimit = parseInt(await ask('  Token limit per session', '200000'), 10) || 200000;
  const messageLimit = parseInt(await ask('  Message limit per session', '100'), 10) || 100;
  const maxFileSize = parseInt(await ask('  Max file size in bytes', '10485760'), 10) || 10485760;

  // ── Platform Config ──
  console.log('\n── Platform Config ──');
  const datapolicy = await ask('  Data policy (ephemeral|session|persistent)', 'ephemeral');
  const trustlevel = await ask('  Trust level (basic|verified|audited)', 'verified');
  const disputeresolution = await ask('  Dispute resolution (platform|arbitration|mutual)', 'platform');

  // Dispute policy (VDXF)
  console.log('\n── Dispute Policy (published on-chain) ──');
  const defaultAction = await ask('  Default action on dispute (rework/refund/reject)', 'rework');
  const maxRefundPercent = parseInt(await ask('  Max refund percent (0-100)', '100'), 10);
  const maxReworkCycles = parseInt(await ask('  Max rework cycles', '2'), 10);
  const reworkBudgetPercent = parseInt(await ask('  Rework budget per cycle (% of job cost)', '30'), 10);
  const escalateAfter = await ask('  Escalate after (max_rework/2nd_dispute/never)', 'max_rework');
  const systemCrashRefund = parseInt(await ask('  System crash refund % (0-100)', '100'), 10);

  const disputePolicy = {
    defaultAction,
    maxRefundPercent: Math.min(Math.max(maxRefundPercent, 0), 100),
    maxReworkCycles: Math.max(maxReworkCycles, 0),
    reworkBudgetPercent: Math.min(Math.max(reworkBudgetPercent, 0), 100),
    escalateAfter,
    systemCrashRefund: Math.min(Math.max(systemCrashRefund, 0), 100),
  };

  // ── Workspace ──
  console.log('\n── Workspace ──');
  const wsEnabled = (await ask('  Enable workspace file access? (y/N)', 'N')).toLowerCase();
  let workspaceCapability;
  if (wsEnabled === 'y' || wsEnabled === 'yes') {
    const modesRaw = await ask('  Workspace modes (comma-separated: supervised,standard)', 'supervised,standard');
    const toolsRaw = await ask('  Workspace tools', 'read_file,write_file,list_directory');
    workspaceCapability = {
      workspace: true,
      modes: modesRaw.split(',').map(s => s.trim()),
      tools: toolsRaw.split(',').map(s => s.trim()),
    };
  }

  // ── Service ──
  console.log('\n── Service Definition ──');
  const services = [];
  let addService = (await ask('  Add a service? (Y/n)', 'Y')).toLowerCase();
  while (addService !== 'n' && addService !== 'no') {
    const svcName = await ask('    Service name');
    if (!svcName) break;
    const svcDesc = await ask('    Description');
    const svcCategory = await ask('    Category', category);
    const svcPrice = parseFloat(await ask('    Price (in VRSC)', '0.5')) || 0.5;
    const svcCurrency = await ask('    Currency', 'VRSCTEST');
    const svcTurnaround = await ask('    Turnaround time', '1h');
    const svcTerms = await ask('    Payment terms (prepay|postpay|split)', 'prepay');
    const svcSovguard = (await ask('    Require SovGuard? (Y/n)', 'Y')).toLowerCase() !== 'n';
    const svcWindow = parseInt(await ask('    Dispute resolution window (hours)', '72'), 10) || 72;

    services.push({
      name: svcName,
      description: svcDesc || undefined,
      category: svcCategory || undefined,
      price: svcPrice,
      currency: svcCurrency,
      turnaround: svcTurnaround,
      paymentTerms: svcTerms,
      sovguard: svcSovguard,
      resolutionWindow: svcWindow,
      refundPolicy: { policy: 'fixed', percent: 100 },
    });

    addService = (await ask('  Add another service? (y/N)', 'N')).toLowerCase();
  }

  // Service pricing calculation
  if (models.length > 0 && services.length > 0) {
    console.log('\n── Service Cost Estimation ──');
    for (const svc of services) {
      const svcModel = await ask(`  Model for "${svc.name}" (${models.join('/')})`, models[0]);
      const inputTokens = parseInt(await ask('  Estimated input tokens per job', '8000'), 10);
      const outputTokens = parseInt(await ask('  Estimated output tokens per job', '2000'), 10);
      const apiCallsCount = parseInt(await ask('  API calls per job (0 if none)', '0'), 10);

      try {
        const { calculateListedPrice } = require('@j41/sovagent-sdk/dist/pricing/calculator.js');
        const result = calculateListedPrice({
          model: svcModel,
          inputTokens,
          outputTokens,
          markupPercent: markup || 15,
        });
        console.log(`  Raw cost: $${result.rawCost} → Listed: $${result.listedPrice} (${markup}% markup)`);
        svc.costBreakdown = {
          model: svcModel,
          estimatedInputTokens: inputTokens,
          estimatedOutputTokens: outputTokens,
          rawCost: result.rawCost,
          apiCalls: apiCallsCount,
          markup: markup || 15,
        };
      } catch (e) {
        console.log(`  ⚠️  Could not calculate price: ${e.message}`);
      }
    }
  }

  rl.close();

  const profile = {
    name,
    type,
    description,
    payAddress,
    network: { capabilities, endpoints, protocols },
    profile: {
      category,
      tags,
      ...(website ? { website } : {}),
      ...(avatar ? { avatar } : {}),
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
      } = require('@j41/sovagent-sdk/dist/index.js');
      const { buildIdentityUpdateTx } = require('@j41/sovagent-sdk/dist/identity/update.js');

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
  .version('0.2.0');

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
        console.error('❌ --max-concurrent must be 1-1000');
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
    console.log(`  Max concurrent:   ${config.maxConcurrent || 9}`);
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
    const runtime = await ask('Runtime mode (local or docker)', 'local');

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
      
      fs.mkdirSync(agentDir, { recursive: true });
      
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

    console.log(`\n→ Registering ${agentId} as ${identityName}.agentplatform@...`);
    console.log(`   Address: ${keys.address}`);

    const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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
        const { finalizeOnboarding } = require('@j41/sovagent-sdk/dist/index.js');
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

    const { J41Agent, finalizeOnboarding } = require('@j41/sovagent-sdk/dist/index.js');
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
      const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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
    const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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
      console.error(`\n❌ Login failed: ${err.message}`);
      console.error(`   The identity may not exist on-chain yet.`);
      console.error(`   Wait a few minutes and retry, or re-register.`);
      process.exit(1);
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

    const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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

    const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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

    const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    try {
      const result = await agent.deactivate({
        removeServices: !options.keepServices,
        onChain: !options.platformOnly,
      });

      console.log(`\n✅ Agent deactivated`);
      console.log(`   Platform status: ${result.status}`);
      console.log(`   Services removed: ${result.servicesRemoved}`);
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

    const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
    const agent = new J41Agent({
      apiUrl: J41_API_URL,
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });

    try {
      const result = await agent.activate({ onChain: !options.platformOnly });

      console.log(`\n✅ Agent activated`);
      console.log(`   Platform status: ${result.status}`);
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
      const { J41Agent, decodeContentMultimap } = require('@j41/sovagent-sdk/dist/index.js');
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
      fs.mkdirSync(agentDir, { recursive: true });
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
    const { J41Agent, finalizeOnboarding, RegistrationTimeoutError } = require('@j41/sovagent-sdk/dist/index.js');

    if (keys.identity && keys.iAddress && keys.registrationStatus !== 'timeout') {
      console.log(`  ✓ Already registered: ${keys.identity}`);
    } else {
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

// Start command — run the dispatcher (listen for jobs)
program
  .command('start')
  .description('Start the dispatcher (listens for jobs, manages pool)')
  .option('--webhook-url <url>', 'Public URL for receiving webhook events (enables webhook mode)')
  .option('--webhook-port <port>', 'Port for webhook HTTP server (default: 9841)', '9841')
  .action(async (options) => {
    ensureDirs();

    const agents = listRegisteredAgents();
    if (agents.length === 0) {
      console.error('❌ No agents found. Run: j41-dispatcher init');
      process.exit(1);
    }
    
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     J41 Dispatcher                       ║');
    console.log('║     Ephemeral Job Containers             ║');
    console.log('║     with Privacy Attestation             ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`Runtime: ${RUNTIME} mode`);
    console.log(`Registered agents: ${agents.length}`);
    console.log(`Max concurrent: ${MAX_AGENTS}`);
    console.log(`Job timeout: ${JOB_TIMEOUT_MS / 60000} min`);
    if (RUNTIME === 'docker') {
      console.log(`Keep containers: ${process.env.J41_KEEP_CONTAINERS === '1' ? 'ON (debug)' : 'OFF'}`);
    }
    console.log('Privacy: Deletion attestations\n');

    // H5: Validate executor URLs at startup (SSRF protection)
    validateExecutorUrl(process.env.J41_EXECUTOR_URL, 'J41_EXECUTOR_URL');
    validateExecutorUrl(process.env.J41_MCP_URL, 'J41_MCP_URL');
    validateExecutorUrl(process.env.KIMI_BASE_URL, 'KIMI_BASE_URL');

    // Check which agents are registered on platform (+ optional finalize readiness)
    const enforceFinalize = process.env.J41_REQUIRE_FINALIZE === '1';
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
    };

    // ── Load on-chain capabilities for VDXF policy enforcement ──
    console.log('→ Loading on-chain agent capabilities...\n');
    const { decodeContentMultimap } = require('@j41/sovagent-sdk/dist/onboarding/vdxf.js');
    for (const agentInfo of readyAgents) {
      try {
        const agent = await getAgentSession(state, agentInfo);
        const idRaw = await agent.client.getIdentityRaw();
        const id = idRaw.data?.identity || idRaw.identity;
        if (id?.contentmultimap) {
          const decoded = decodeContentMultimap(id.contentmultimap);
          const hasWorkspace = !!decoded.profile?.workspaceCapability;
          // Also check raw CMM for workspace key (flat format or legacy parent key)
          const { VDXF_KEYS: VK, PARENT_KEYS: PK } = require('@j41/sovagent-sdk/dist/onboarding/vdxf.js');
          const hasWorkspaceKey = !!id.contentmultimap[VK.workspace.capability] || !!id.contentmultimap[PK.workspace];
          const services = decoded.services || [];
          state.capabilities.set(agentInfo.id, {
            workspace: hasWorkspace,
            hasWorkspaceKey,
            services: services.map(s => ({ name: s.name, type: s.type })),
            profile: decoded.profile,
          });
          console.log(`  ${agentInfo.id}: workspace=${hasWorkspace || hasWorkspaceKey}, services=${services.length}`);
        } else {
          state.capabilities.set(agentInfo.id, { workspace: false, services: [], profile: null });
          console.log(`  ${agentInfo.id}: no VDXF data on-chain`);
        }
      } catch (e) {
        state.capabilities.set(agentInfo.id, { workspace: false, services: [], profile: null });
        console.log(`  ${agentInfo.id}: capability fetch failed (${e.message})`);
      }
    }
    console.log('');

    // Cache dispute policy and markup per agent from VDXF
    if (!state.disputePolicy) state.disputePolicy = new Map();
    if (!state.agentMarkup) state.agentMarkup = new Map();
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
      const { generateWebhookSecret } = require('@j41/sovagent-sdk/dist/webhook/verify.js');

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

      // Start webhook HTTP server
      const { startWebhookServer } = require('./webhook-server');
      startWebhookServer(webhookPort, agentWebhooks, async (agentId, payload) => {
        await handleWebhookEvent(state, agentId, payload);
      });

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
      console.log(`Mode: POLL (60s interval)\n`);

      // WebSocket listeners for instant notification (supplement to polling)
      let wsConnected = 0;
      for (const agentInfo of readyAgents) {
        try {
          const agent = await getAgentSession(state, agentInfo);
          const sessionToken = agent.client.getSessionToken();
          if (sessionToken) {
            const { ChatClient } = require('@j41/sovagent-sdk/dist/chat/client.js');
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

      // Poll for jobs
      safeInterval(() => pollForJobs(state), 60000, 'Poll');

      // Check for pending reviews every 60s
      safeInterval(() => checkPendingReviews(state), 60000, 'Reviews');
    }

    // ── Profile sync — detect on-chain changes and re-register with platform ──
    const _profileHashes = new Map(); // agentId -> last known contentmultimap hash
    safeInterval(async () => {
      const { decodeContentMultimap } = require('@j41/sovagent-sdk/dist/onboarding/vdxf.js');
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

    // ── Set agents active on-chain ──
    console.log('\n→ Setting agents active on-chain...');
    for (const agentInfo of readyAgents) {
      try {
        const agent = await getAgentSession(state, agentInfo);
        await agent.setOnChainStatus('active');
        console.log(`  ✅ ${agentInfo.id}: on-chain status → active`);
      } catch (e) {
        console.log(`  ⚠️  ${agentInfo.id}: on-chain status update failed (${e.message.slice(0, 60)})`);
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
          const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');
          const verusId = agentInfo.iAddress || agentInfo.identity;
          const timestamp = Math.floor(Date.now() / 1000);
          const { randomUUID } = require('crypto');
          const nonce = randomUUID();
          const message = `J41-STATUS|Agent:${verusId}|Status:inactive|Ts:${timestamp}|Nonce:${nonce}`;
          const signature = signMessage(agentInfo.wif, message, J41_NETWORK);
          await agent.client.setAgentStatus(verusId, 'inactive', signature, timestamp, nonce);
          console.log(`   ✅ ${agentInfo.id}: status → inactive`);
          try { await agent.setOnChainStatus('inactive'); } catch {}
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
  const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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

// Poll for new jobs — check ALL agents, not just available ones
// (an agent with an active job can still have new jobs queued for it)
async function pollForJobs(state) {
  for (const agentInfo of [...state.agents]) {
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
          state.seen.add(job.id);
          continue;
        }

        // ── Step 1: Accept the job (sign commitment) if not already accepted ──
        if (!state.pendingPayment) state.pendingPayment = new Map(); // jobId -> { accepted }
        const pending = state.pendingPayment.get(job.id);

        if (job.status === 'requested' && !pending?.accepted) {
          try {
            const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');
            const fullJob = await agent.client.getJob(job.id);
            if (fullJob?.jobHash && fullJob?.buyerVerusId) {
              const timestamp = Math.floor(Date.now() / 1000);
              const acceptSig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
              await agent.client.acceptJob(job.id, acceptSig, timestamp, agentInfo.address);
              console.log(`✅ Job ${job.id} accepted (signed, pay→${agentInfo.address.slice(0, 8)}...) — awaiting buyer payment`);
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
        // accepted + no payment object = platform doesn't enforce payment (let it through)
        const isPaid = job.status === 'in_progress' ||
          (job.payment && job.payment.verified === true) ||
          (!job.payment); // platform doesn't populate payment → don't block

        if (!isPaid) {
          if (!state.pendingPayment.has(job.id)) {
            console.log(`⏳ Job ${job.id} (${job.amount} ${job.currency}) — awaiting payment`);
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

        if (state.active.size >= MAX_AGENTS) {
          console.log(`   → Queueing (max capacity)`);
          state.queue.push({ ...job, assignedAgent: agentInfo });
        } else {
          console.log(`   → Starting job with ${agentInfo.id} (${RUNTIME})`);
          await startJob(state, job, agentInfo);
        }
      }
    } catch (e) {
      // Invalidate session on auth/request errors so next poll re-authenticates
      state.agentSessions.delete(agentInfo.id);
      console.error(`[Poll] Error for ${agentInfo.id}:`, e.message);
    }
  }

  // Check for post-delivery status transitions (poll mode fallback)
  // Track last-sent status per job to avoid duplicate IPC messages
  if (!state._lastSentStatus) state._lastSentStatus = new Map();
  for (const [jobId, activeInfo] of state.active.entries()) {
    try {
      const agentSession = await getAgentSession(state, activeInfo.agentInfo);
      const currentJob = await agentSession.client.getJob(jobId);
      const lastStatus = state._lastSentStatus.get(jobId);
      if (currentJob.status === lastStatus) continue; // Already sent this status
      if (currentJob.status === 'completed' && activeInfo.process?.send) {
        activeInfo.process.send({ type: 'job.completed', data: { jobId } });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'disputed' && activeInfo.process?.send) {
        activeInfo.process.send({ type: 'dispute.filed', data: { jobId, reason: currentJob.dispute?.reason } });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if ((currentJob.status === 'resolved' || currentJob.status === 'resolved_rejected') && activeInfo.process?.send) {
        activeInfo.process.send({ type: 'dispute.resolved', data: { jobId, action: currentJob.dispute?.action } });
        state._lastSentStatus.set(jobId, currentJob.status);
      } else if (currentJob.status === 'rework' && activeInfo.process?.send) {
        activeInfo.process.send({ type: 'dispute.rework_accepted', data: { jobId } });
        state._lastSentStatus.set(jobId, currentJob.status);
      }

      // Poll-mode fallback: detect paused → in_progress (resume happened without webhook)
      if (currentJob.status === 'in_progress' && activeInfo.paused) {
        console.log(`[Poll] Job ${jobId.substring(0, 8)} resumed (was paused) — unthrottling`);
        activeInfo.paused = false;
        activeInfo.pausedAt = null;
        activeInfo.resumedAt = Date.now();
        state.available = state.available.filter(a => a.id !== activeInfo.agentInfo?.id);
        if (activeInfo.process?.send) {
          activeInfo.process.send({ type: 'reconnect', jobId });
        }
        state._lastSentStatus.set(jobId, currentJob.status);
      }
    } catch (e) {
      // Job may have been deleted — ignore
    }
  }

  // Poll-mode fallback: check for pending extension requests on active jobs
  if (!state._lastExtensionCheck) state._lastExtensionCheck = new Map();
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
        const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');
        const agent = await getAgentSession(state, agentInfo);
        const fullJob = await agent.client.getJob(jobId);
        if (fullJob?.jobHash && fullJob?.buyerVerusId) {
          const timestamp = Math.floor(Date.now() / 1000);
          const sig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
          await agent.client.acceptJob(jobId, sig, timestamp, agentInfo.address);
          console.log(`[Webhook] ✅ Job ${jobId.substring(0, 8)} accepted (pay→${agentInfo.address.slice(0, 8)}...)`);
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
          state.queue.push({ ...job, assignedAgent: agentInfo });
          console.log(`[Webhook] Job ${jobId.substring(0, 8)} queued (max capacity)`);
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
        if (!state._pendingWorkspace) state._pendingWorkspace = new Map();
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
      if (reconnectJob?.process?.send) {
        reconnectJob.process.send({ type: 'reconnect', jobId });
        console.log(`[Webhook] Sent reconnect IPC to job-agent ${jobId?.substring(0, 8)}`);
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
        resumeInfo.resumedAt = Date.now(); // Sentinel: prevents late job_idle IPC from re-pausing
        // Reclaim slot — remove from available pool
        state.available = state.available.filter(a => a.id !== resumeInfo.agentInfo?.id);
        // Tell job-agent to resume
        if (resumeInfo.process?.send) {
          resumeInfo.process.send({ type: 'reconnect', jobId });
        }
      }
      break;
    }

    case 'job.paused': {
      // Platform confirmed pause — update local state if not already done via IPC
      const pauseInfo = state.active.get(jobId);
      if (pauseInfo && !pauseInfo.paused) {
        pauseInfo.paused = true;
        pauseInfo.pausedAt = Date.now();
        state.available.push(pauseInfo.agentInfo);
        console.log(`[Webhook] Job ${jobId?.substring(0, 8)} paused — slot freed`);
      }
      break;
    }

    case 'bounty.awarded': {
      console.log(`[Webhook] Bounty awarded — treating as new job request`);
      const bountyJobId = data?.jobId || jobId;
      if (!bountyJobId || state.seen.has(bountyJobId) || state.active.has(bountyJobId)) return;
      try {
        const { signMessage } = require('@j41/sovagent-sdk/dist/identity/signer.js');
        const agent = await getAgentSession(state, agentInfo);
        const fullJob = await agent.client.getJob(bountyJobId);
        if (fullJob?.jobHash && fullJob?.buyerVerusId) {
          const timestamp = Math.floor(Date.now() / 1000);
          const sig = signMessage(agentInfo.wif, buildAcceptMessage(fullJob, timestamp), J41_NETWORK);
          await agent.client.acceptJob(bountyJobId, sig, timestamp, agentInfo.address);
          console.log(`[Webhook] ✅ Bounty job ${bountyJobId.substring(0, 8)} accepted (pay→${agentInfo.address.slice(0, 8)}...)`);
          state.seen.set(bountyJobId, Date.now());
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

    default:
      // Log unhandled events for debugging
      break;
  }
}

// Check for pending reviews and process them (runs from dispatcher, not container)
async function checkPendingReviews(state) {
  // Check all registered agents (not just available ones — reviews arrive after job is done)
  for (const agentInfo of state.agents) {
    if (!agentInfo.identity || !agentInfo.wif || !agentInfo.iAddress) continue;

    try {
      const agent = await getAgentSession(state, agentInfo);

      // Check inbox for pending review/completion items only
      const inbox = await agent.client.getInbox('pending', 20);
      const pending = (inbox?.data || []).filter(
        item => item.type === 'review'
      );
      if (pending.length === 0) continue;

      console.log(`[Reviews] ${agentInfo.id}: ${pending.length} pending review(s)`);

      for (const item of pending) {
        try {
          console.log(`[Reviews] Processing ${item.type} ${item.id}`);
          await agent.acceptReview(item.id);
          console.log(`[Reviews] ✅ Review accepted and identity updated for ${agentInfo.id}`);
        } catch (e) {
          console.error(`[Reviews] ❌ Failed to process ${item.id}:`, e.message);
        }
      }
    } catch (e) {
      // Invalidate session on error so next cycle re-authenticates
      state.agentSessions.delete(agentInfo.id);
      if (!e.message.includes('not registered')) {
        console.error(`[Reviews] Error checking ${agentInfo.id}:`, e.message);
      }
    }
  }
}

// M7: Read per-agent executor config and return as env vars for container
function getExecutorEnvVars(agentInfo) {
  const envVars = [];
  const agentDir = path.join(AGENTS_DIR, agentInfo.id);

  // Try agent-config.json first, then fall back to keys.json
  let config = {};
  try {
    const configPath = path.join(agentDir, 'agent-config.json');
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } else {
      // Fall back to executor fields in keys.json
      const keys = JSON.parse(fs.readFileSync(path.join(agentDir, 'keys.json'), 'utf8'));
      if (keys.executor) config = keys;
    }
  } catch {
    // No config — use defaults
  }

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
  if (config.llmApiKey) envVars.push(`J41_LLM_API_KEY=${config.llmApiKey}`);

  return envVars;
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
  
  const agentDir = path.join(AGENTS_DIR, agentInfo.id);
  const keysPath = path.join(agentDir, 'keys.json');

  // H3 fix: Copy keys to a temp file at 0o640 — do NOT chmod the original.
  // This ensures the original stays at 0o600 even if the process crashes.
  const tmpKeysPath = path.join(jobDir, 'keys.json');
  fs.copyFileSync(keysPath, tmpKeysPath);
  try {
    fs.chmodSync(tmpKeysPath, 0o644);
  } catch {
    // best effort on systems that don't support chmod
  }

  try {
    const keepContainers = process.env.J41_KEEP_CONTAINERS === '1';

    const container = await docker.createContainer({
      name: `j41-job-${job.id}`,
      Image: 'j41/job-agent:latest',  // PRE-BAKED IMAGE
      Env: [
        `J41_API_URL=${J41_API_URL}`,
        `J41_NETWORK=${J41_NETWORK}`,
        `J41_AGENT_ID=${agentInfo.id}`,
        `J41_IDENTITY=${agentInfo.identity}`,
        `J41_JOB_ID=${job.id}`,
        `JOB_TIMEOUT_MS=${JOB_TIMEOUT_MS}`,
        // LLM config (pass through from dispatcher env — new generic + legacy)
        ...['J41_LLM_PROVIDER','J41_LLM_BASE_URL','J41_LLM_API_KEY','J41_LLM_MODEL',
            'KIMI_API_KEY','KIMI_BASE_URL','KIMI_MODEL',
            'ANTHROPIC_API_KEY','OPENAI_API_KEY','GROQ_API_KEY','DEEPSEEK_API_KEY',
            'MISTRAL_API_KEY','GOOGLE_API_KEY','XAI_API_KEY','OPENROUTER_API_KEY',
            'IDLE_TIMEOUT_MS','J41_EXECUTOR','MAX_CONVERSATION_LOG',
        ].filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`),
        // Per-agent executor config (from agent-config.json or keys.json)
        ...getExecutorEnvVars(agentInfo),
      ],
      HostConfig: {
        Binds: [
          // job dir must be writable for attestation artifacts (creation/deletion json)
          `${jobDir}:/app/job`,
          `${tmpKeysPath}:/app/keys.json:ro`,
          `${path.join(agentDir, 'SOUL.md')}:/app/SOUL.md:ro`,
        ],
        AutoRemove: !keepContainers, // Keep container for debugging when J41_KEEP_CONTAINERS=1
        Memory: 2 * 1024 * 1024 * 1024, // 2GB limit
        CpuQuota: 100000, // 1 CPU core
        // Security: No new privileges
        SecurityOpt: ['no-new-privileges:true'],
        // Read-only root filesystem
        ReadonlyRootfs: true,
        // tmpfs for /tmp so processes can write temp files on readonly rootfs (X6)
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        // Limit process count to prevent fork bombs (X7)
        PidsLimit: 64,
        // Drop all capabilities
        CapDrop: ['ALL'],
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
    setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        console.log(`⏰ Job ${job.id} timeout, killing container`);
        await stopJobContainer(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);
    
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
  if (fs.existsSync(jobDir) && process.env.J41_KEEP_CONTAINERS !== '1') {
    fs.rmSync(jobDir, { recursive: true });
  }

  // Return agent to pool (unless retrying or already returned during pause)
  if (!skipReturnAgent && !active.paused) {
    state.available.push(active.agentInfo);
    state.retries.delete(jobId);
  } else if (!skipReturnAgent && active.paused) {
    state.retries.delete(jobId);
  }
  state.active.delete(jobId);

  if (!skipReturnAgent) {
    console.log(`✅ Job ${jobId} complete, agent returned to pool`);
  }
}

// ─────────────────────────────────────────
// Local process mode — spawn job-agent.js as child process
// ─────────────────────────────────────────

async function startJobLocal(state, job, agentInfo) {
  const jobDir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  // Write job data (same as Docker mode)
  fs.writeFileSync(path.join(jobDir, 'description.txt'), job.description);
  fs.writeFileSync(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);
  fs.writeFileSync(path.join(jobDir, 'amount.txt'), String(job.amount));
  fs.writeFileSync(path.join(jobDir, 'currency.txt'), job.currency);

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

  // Platform config — required for job-agent
  env.J41_API_URL = J41_API_URL;
  env.J41_NETWORK = J41_NETWORK;
  env.J41_AGENT_ID = agentInfo.id;
  env.J41_IDENTITY = agentInfo.identity;
  env.J41_JOB_ID = job.id;
  env.JOB_TIMEOUT_MS = String(JOB_TIMEOUT_MS);
  env.J41_KEYS_FILE = keysPath;
  env.J41_SOUL_FILE = path.join(agentDir, 'SOUL.md');
  env.J41_JOB_DIR = jobDir;

  // Session lifecycle config from service (passed via job API response)
  if (job.lifecycle?.idleTimeout) env.IDLE_TIMEOUT_MS = String(job.lifecycle.idleTimeout * 60000);
  if (job.lifecycle?.pauseTTL) env.PAUSE_TTL_MS = String(job.lifecycle.pauseTTL * 60000);

  // Optional LLM config — only pass through if set in parent
  const OPTIONAL_PASSTHROUGH = [
    // LLM provider (new generic)
    'J41_LLM_PROVIDER', 'J41_LLM_BASE_URL', 'J41_LLM_API_KEY', 'J41_LLM_MODEL',
    // Legacy Kimi env vars (backwards compatible)
    'KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL',
    // Provider-specific API keys (for presets)
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
    'GOOGLE_API_KEY', 'XAI_API_KEY', 'COHERE_API_KEY', 'PERPLEXITY_API_KEY',
    'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'NVIDIA_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENROUTER_API_KEY',
    // Other
    'IDLE_TIMEOUT_MS', 'J41_MCP_COMMAND', 'J41_MCP_URL',
    'J41_EXECUTOR_AUTH', 'J41_EXECUTOR_TIMEOUT', 'J41_MCP_MAX_ROUNDS',
    'J41_EXECUTOR', 'MAX_CONVERSATION_LOG',
  ];
  for (const key of OPTIONAL_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // Per-agent executor env vars (from agent-config.json)
  const executorVars = getExecutorEnvVars(agentInfo);
  executorVars.forEach(v => {
    const [key, ...rest] = v.split('=');
    env[key] = rest.join('=');
  });

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
    setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        console.log(`⏰ Job ${job.id} timeout, killing process`);
        await stopJobLocal(state, job.id);
      }
    }, JOB_TIMEOUT_MS + 60000);

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
  if (fs.existsSync(jobDir) && process.env.J41_KEEP_CONTAINERS !== '1') {
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
  state.active.delete(jobId);
  persistActiveJobs(state.active);

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
      const { J41Agent } = require('@j41/sovagent-sdk');
      const agent = new J41Agent({ apiUrl: J41_API_URL, wif: keys.wif, identityName: keys.identity, iAddress: keys.iAddress });
      await agent.authenticate();

      const result = await agent.respondToDispute(jobId, {
        action,
        refundPercent: options.refundPercent ? parseInt(options.refundPercent, 10) : undefined,
        reworkCost: parseFloat(options.reworkCost) ?? 0,
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
      const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
      const { VDXF_KEYS, PARENT_KEYS, decodeContentMultimap } = require('@j41/sovagent-sdk/dist/onboarding/vdxf.js');

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
      const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
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
      const { J41Agent } = require('@j41/sovagent-sdk/dist/index.js');
      const { buildAgentContentMultimap } = require('@j41/sovagent-sdk/dist/onboarding/vdxf.js');
      const { buildIdentityUpdateTx } = require('@j41/sovagent-sdk/dist/identity/update.js');

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

    fs.mkdirSync(agentDir, { recursive: true });
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
    console.log(`  Max Concurrent:    ${cfg.maxConcurrent || 9}`);
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
      const maxConcurrent = parseInt(await ask(`  Max concurrent agents [${cfg.maxConcurrent || 9}]: `)) || cfg.maxConcurrent || 9;
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

// ── Entry point ──

if (process.argv.length <= 2) {
  // No command — launch interactive menu
  mainMenu().catch(e => { console.error(e); process.exit(1); });
} else {
  program.parse();
}
