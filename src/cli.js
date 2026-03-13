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

const MAX_AGENTS = 9;
const JOB_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 2;
const SEEN_JOBS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    owner: options.profileOwner,
    category: options.profileCategory,
    tags: options.profileTags,
    website: options.profileWebsite,
    avatar: options.profileAvatar,
    capabilities: options.profileCapabilities,
    endpoints: options.profileEndpoints,
    protocols: options.profileProtocols,
    datapolicy: options.dataPolicy,
    trustlevel: options.trustLevel,
    disputeresolution: options.disputeResolution,
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

  return profile;
}

function createFinalizeHooks(agentId, identityName, profile, services = []) {
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
            version: '1',
            type: profile.type,
            name: profile.name,
            description: profile.description,
            status: 'active',
            services: services.map((svc) => ({
              name: svc.name,
              description: svc.description,
              category: svc.category,
              price: svc.price,
              currency: svc.currency,
              turnaround: svc.turnaround,
              status: 'active',
            })),
          }
        : { services: [] };

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
      const commandArgs = buildUpdateIdentityCommand(payload, 'verustest');
      const commandStr = commandArgs.map(a => a.includes(' ') || a.includes('{') ? `'${a}'` : a).join(' ');
      fs.writeFileSync(cmdPath, `${commandStr}\n`);
      fs.chmodSync(cmdPath, 0o700);

      // Offline signing: authenticate, get identity data + UTXOs, build tx, broadcast
      console.log(`   ↳ Building offline identity update for ${identityName}...`);

      const agent = new J41Agent({
        apiUrl: process.env.J41_API_URL || 'https://api.autobb.app',
        wif: keys.wif,
        identityName: identityName,
        iAddress: keys.iAddress,
      });
      await agent.authenticate();

      // Build VDXF contentmultimap from profile
      const vdxfAdditions = buildAgentContentMultimap(profile, services);

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
        network: 'verustest',
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
  .option('--show', 'Show current configuration')
  .action(async (options) => {
    ensureDirs();
    const config = loadConfig();

    if (options.runtime) {
      if (!['docker', 'local'].includes(options.runtime)) {
        console.error('❌ Invalid runtime mode. Use: docker or local');
        process.exit(1);
      }
      config.runtime = options.runtime;
      saveConfig(config);
      console.log(`✅ Runtime set to: ${options.runtime}`);
      if (options.runtime === 'docker') {
        console.log('\nMake sure Docker is installed and running.');
        console.log('Build the job image: ./scripts/build-image.sh');
      } else {
        console.log('\nLocal process mode — no Docker required.');
        console.log('Jobs will run as child processes on this machine.');
      }
      return;
    }

    // Default: show config
    console.log('\nJ41 Dispatcher Configuration:');
    console.log(`  Runtime: ${config.runtime}`);
    console.log(`  Config:  ${require('./config').CONFIG_PATH}`);
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
      const keys = generateKeypair('verustest');
      
      fs.writeFileSync(
        path.join(agentDir, 'keys.json'),
        JSON.stringify({ ...keys, network: 'verustest' }, null, 2)
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
  .option('--profile-owner <owner>', 'Owner VerusID (e.g., 33test@)')
  .option('--profile-capabilities <json>', 'Capabilities as JSON array: [{"id":"x","name":"X"}]', parseJsonArray)
  .option('--profile-endpoints <json>', 'Endpoints as JSON array: [{"url":"https://...","protocol":"MCP"}]', parseJsonArray)
  .option('--profile-protocols <protos>', 'Comma-separated protocols (MCP,REST,A2A,WebSocket)', (v) => v.split(','))
  .option('--service-name <name>', 'Service name for marketplace listing')
  .option('--service-description <desc>', 'Service description')
  .option('--service-price <price>', 'Service price')
  .option('--service-currency <currency>', 'Service currency', 'VRSC')
  .option('--service-category <cat>', 'Service category')
  .option('--service-turnaround <time>', 'Service turnaround time', '1h')
  .option('--profile-tags <tags>', 'Comma-separated tags', (v) => v.split(','))
  .option('--profile-website <url>', 'Agent website URL')
  .option('--profile-avatar <url>', 'Agent avatar URL')
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
      apiUrl: process.env.J41_API_URL || 'https://api.autobb.app',
      wif: keys.wif
    });

    try {
      const result = await agent.register(identityName, 'verustest');

      // Save identity to keys file
      keys.identity = result.identity;
      keys.iAddress = result.iAddress;
      fs.writeFileSync(
        path.join(AGENTS_DIR, agentId, 'keys.json'),
        JSON.stringify(keys, null, 2)
      );

      console.log(`\n✅ ${agentId} registered!`);
      console.log(`   Identity: ${result.identity}`);
      console.log(`   i-Address: ${result.iAddress}`);

      if (options.finalize) {
        const { finalizeOnboarding } = require('@j41/sovagent-sdk/dist/index.js');
        const finalizeStatePath = path.join(AGENTS_DIR, agentId, FINALIZE_STATE_FILENAME);
        console.log(`\n→ Finalizing onboarding (${options.interactive ? 'interactive' : 'headless'})...`);

        const profile = options.interactive
          ? undefined
          : (options.profileName && options.profileDescription
            ? buildFullProfile(options)
            : undefined);

        const services = (options.serviceName && options.servicePrice)
          ? [{
              name: options.serviceName,
              description: options.serviceDescription || options.profileDescription,
              price: options.servicePrice,
              currency: options.serviceCurrency,
              category: options.serviceCategory || 'general',
              turnaround: options.serviceTurnaround,
            }]
          : [];

        const finalizeResult = await finalizeOnboarding({
          agent,
          statePath: finalizeStatePath,
          mode: options.interactive ? 'interactive' : 'headless',
          profile,
          hooks: createFinalizeHooks(agentId, keys.identity, profile, services),
        });

        console.log(`✅ Finalize stage: ${finalizeResult.stage}`);
        console.log(`   State file: ${finalizeStatePath}`);
      }
    } catch (e) {
      console.error(`\n❌ Registration failed: ${e.message}`);
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
  .option('--profile-owner <owner>', 'Owner VerusID (e.g., 33test@)')
  .option('--profile-capabilities <json>', 'Capabilities as JSON array: [{"id":"x","name":"X"}]', parseJsonArray)
  .option('--profile-endpoints <json>', 'Endpoints as JSON array: [{"url":"https://...","protocol":"MCP"}]', parseJsonArray)
  .option('--profile-protocols <protos>', 'Comma-separated protocols (MCP,REST,A2A,WebSocket)', (v) => v.split(','))
  .option('--profile-tags <tags>', 'Comma-separated tags', (v) => v.split(','))
  .option('--profile-website <url>', 'Agent website URL')
  .option('--profile-avatar <url>', 'Agent avatar URL')
  .option('--profile-category <cat>', 'Agent category')
  .option('--service-name <name>', 'Service name for marketplace listing')
  .option('--service-description <desc>', 'Service description')
  .option('--service-price <price>', 'Service price')
  .option('--service-currency <currency>', 'Service currency', 'VRSC')
  .option('--service-category <cat>', 'Service category')
  .option('--service-turnaround <time>', 'Service turnaround time', '1h')
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
      apiUrl: process.env.J41_API_URL || 'https://api.autobb.app',
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

    const services = (options.serviceName && options.servicePrice)
      ? [{
          name: options.serviceName,
          description: options.serviceDescription || options.profileDescription,
          price: options.servicePrice,
          currency: options.serviceCurrency,
          category: options.serviceCategory || 'general',
          turnaround: options.serviceTurnaround,
        }]
      : [];

    const finalizeResult = await finalizeOnboarding({
      agent,
      statePath: finalizeStatePath,
      mode: options.interactive ? 'interactive' : 'headless',
      profile,
      hooks: createFinalizeHooks(agentId, keys.identity, profile, services),
    });

    console.log(`✅ Finalize stage: ${finalizeResult.stage}`);
    console.log(`   State file: ${finalizeStatePath}`);
    if (finalizeResult.stage !== 'ready') {
      console.log('ℹ️  Finalization can be resumed by rerunning this command.');
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
      apiUrl: process.env.J41_API_URL || 'https://api.autobb.app',
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
        apiUrl: process.env.J41_API_URL || 'https://api.autobb.app',
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

// Start command — run the dispatcher (listen for jobs)
program
  .command('start')
  .description('Start the dispatcher (listens for jobs, manages pool)')
  .action(async () => {
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
    };
    
    // Poll for jobs
    setInterval(async () => {
      await pollForJobs(state);
    }, 30000); // Every 30s
    
    // Check for completed jobs
    setInterval(async () => {
      await cleanupCompletedJobs(state);
    }, 10000); // Every 10s
    
    // Check for pending reviews every 60s
    setInterval(async () => {
      await checkPendingReviews(state);
    }, 60000);

    // Status report every minute + prune old seen-jobs
    setInterval(() => {
      console.log(`[${new Date().toISOString()}] Active: ${state.active.size}/${MAX_AGENTS}, Queue: ${state.queue.length}, Available: ${state.available.length}, Seen: ${state.seen.size}`);
      pruneSeenJobs(state.seen);
    }, 60000);

    // Initial poll
    await pollForJobs(state);
    
    console.log('\n✅ Dispatcher running. Press Ctrl+C to stop.\n');
    
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
  const baseUrl = process.env.J41_API_URL || 'https://api.autobb.app';

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

// Poll for new jobs
async function pollForJobs(state) {
  for (const agentInfo of [...state.available]) {
    try {
      console.log(`[Poll] Checking ${agentInfo.id} (${agentInfo.identity || agentInfo.address})`);

      const agent = await getAgentSession(state, agentInfo);

      // Fetch pending jobs via SDK client
      const result = await agent.client.getMyJobs({ status: 'requested', role: 'seller' });
      const jobs = Array.isArray(result?.data) ? result.data : [];
      console.log(`[Poll] ${agentInfo.id} jobs fetched: ${jobs.length}`);

      for (const job of jobs) {
        if (!job?.id) {
          console.warn(`[Poll] ${agentInfo.id} skipping malformed job:`, JSON.stringify(job).slice(0, 160));
          continue;
        }

        // Check if already handling or already processed
        if (state.seen.has(job.id)) {
          console.log(`[Poll] ${agentInfo.id} skipping ${job.id} (seen)`);
          continue;
        }
        if (state.active.has(job.id)) {
          console.log(`[Poll] ${agentInfo.id} skipping ${job.id} (already active)`);
          continue;
        }
        if (state.queue.some(j => j.id === job.id)) {
          console.log(`[Poll] ${agentInfo.id} skipping ${job.id} (already queued)`);
          continue;
        }

        console.log(`📥 New job: ${job.id} (${job.amount} ${job.currency})`);

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
        item => item.type === 'job_completed' || item.type === 'review'
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

  // Ensure key file is readable inside rootless/uid-remapped containers
  // (was 0600 from init, causing EACCES in job-agent)
  // Use 0o640 (owner rw, group r) — NOT 0o644 which makes WIF world-readable
  try {
    fs.chmodSync(keysPath, 0o640);
  } catch {
    // best effort
  }
  
  try {
    const keepContainers = process.env.J41_KEEP_CONTAINERS === '1';

    const container = await docker.createContainer({
      name: `j41-job-${job.id}`,
      Image: 'j41/job-agent:latest',  // PRE-BAKED IMAGE
      Env: [
        `J41_API_URL=${process.env.J41_API_URL || 'https://api.autobb.app'}`,
        `J41_AGENT_ID=${agentInfo.id}`,
        `J41_IDENTITY=${agentInfo.identity}`,
        `J41_JOB_ID=${job.id}`,
        `JOB_TIMEOUT_MS=${JOB_TIMEOUT_MS}`,
        // LLM config (pass through from dispatcher env)
        ...(process.env.KIMI_API_KEY    ? [`KIMI_API_KEY=${process.env.KIMI_API_KEY}`]       : []),
        ...(process.env.KIMI_BASE_URL   ? [`KIMI_BASE_URL=${process.env.KIMI_BASE_URL}`]     : []),
        ...(process.env.KIMI_MODEL      ? [`KIMI_MODEL=${process.env.KIMI_MODEL}`]            : []),
        ...(process.env.IDLE_TIMEOUT_MS ? [`IDLE_TIMEOUT_MS=${process.env.IDLE_TIMEOUT_MS}`]  : []),
        // M7: Per-agent executor config (from agent-config.json or keys.json)
        ...getExecutorEnvVars(agentInfo),
      ],
      HostConfig: {
        Binds: [
          // job dir must be writable for attestation artifacts (creation/deletion json)
          `${jobDir}:/app/job`,
          `${keysPath}:/app/keys.json:ro`,
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
    });

    // Mark as seen immediately to avoid duplicate pickup loops while status remains requested
    state.seen.set(job.id, Date.now());
    saveSeenJobs(state.seen);
    
    // Remove from available pool
    state.available = state.available.filter(a => a.id !== agentInfo.id);
    
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

  // Restore keys.json to 0o600 (was relaxed to 0o640 for container access)
  try {
    const agentDir = path.join(AGENTS_DIR, active.agentInfo.id);
    fs.chmodSync(path.join(agentDir, 'keys.json'), 0o600);
  } catch {
    // best effort
  }

  // Cleanup job dir (retain for debugging if requested)
  const jobDir = path.join(JOBS_DIR, jobId);
  if (fs.existsSync(jobDir) && process.env.J41_KEEP_CONTAINERS !== '1') {
    fs.rmSync(jobDir, { recursive: true });
  }

  // Return agent to pool (unless retrying)
  if (!skipReturnAgent) {
    state.available.push(active.agentInfo);
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

  // Build env vars — same set as the Docker container gets
  const env = {
    ...process.env,
    J41_API_URL: process.env.J41_API_URL || 'https://api.autobb.app',
    J41_AGENT_ID: agentInfo.id,
    J41_IDENTITY: agentInfo.identity,
    J41_JOB_ID: job.id,
    JOB_TIMEOUT_MS: String(JOB_TIMEOUT_MS),
    // Override /app/ paths for local mode
    J41_KEYS_FILE: keysPath,
    J41_SOUL_FILE: path.join(agentDir, 'SOUL.md'),
    J41_JOB_DIR: jobDir,
  };

  // Per-agent executor env vars
  const executorVars = getExecutorEnvVars(agentInfo);
  executorVars.forEach(v => {
    const [key, ...rest] = v.split('=');
    env[key] = rest.join('=');
  });

  try {
    const child = spawn('node', [path.join(__dirname, 'job-agent.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(__dirname, '..'),
    });

    const shortId = job.id.substring(0, 8);
    child.stdout.on('data', (data) => {
      data.toString().trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  [${shortId}] ${line.trim()}`);
      });
    });
    child.stderr.on('data', (data) => {
      data.toString().trim().split('\n').forEach(line => {
        if (line.trim()) console.error(`  [${shortId}] ${line.trim()}`);
      });
    });

    state.active.set(job.id, {
      agentId: agentInfo.id,
      process: child,
      pid: child.pid,
      startedAt: Date.now(),
      agentInfo,
    });

    state.seen.set(job.id, Date.now());
    saveSeenJobs(state.seen);
    state.available = state.available.filter(a => a.id !== agentInfo.id);
    persistActiveJobs(state.active);

    console.log(`✅ Local process started for job ${job.id} (PID ${child.pid})`);

    child.on('exit', (code) => {
      console.log(`🗑️  Process for job ${job.id} exited (code ${code})`);
    });

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

  if (!skipReturnAgent) {
    state.available.push(active.agentInfo);
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

program.parse();
