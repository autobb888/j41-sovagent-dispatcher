#!/usr/bin/env node
/**
 * J41 Dispatcher — Interactive Dashboard
 * Arrow-key TUI for managing agents, viewing VDXF data, configuring LLM, etc.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_DIR = path.join(__dirname, '..');
const J41_DIR = path.join(os.homedir(), '.j41');
const DISPATCHER_DIR = path.join(J41_DIR, 'dispatcher');
const AGENTS_DIR = path.join(DISPATCHER_DIR, 'agents');
const CONFIG_FILE = path.join(DISPATCHER_DIR, 'config.json');
const ENV_FILE = path.join(REPO_DIR, '.env');

// ── VDXF key → human name mapping ──
const VDXF_KEY_NAMES = {
  'iKkdwxhdupLgf7v2qn4JGBQHntsBb17kjW': 'agent.displayName',
  'iNxeLSDFARVQezfEt4i8CBZjTSRpFTPAyP': 'agent.type',
  'iQr3yKEn2DXaG4GQGVAVYivC3jwcvScfzk': 'agent.description',
  'iLy373iaKafmRCY43ahty4m8aLQx32y8Fh': 'agent.status',
  'iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD': 'agent.payAddress',
  'i8Wk7fcbsBWtcf965Z3WvDUjahF1aTH1tu': 'agent.services',
  'iQJUQmdFSmM49cvLJfKLZnuRYsjXSmTTHY': 'agent.models',
  'iBLx3rga8DewiN6gyQyC5avFin8fnnojnS': 'agent.markup',
  'iF7174LxgcAnu3qZ7iJzSyJYthDJXBzQNw': 'agent.networkCapabilities',
  'i5VzGsiFmJYuRr7b8aUyHzAS8vd9DC4puS': 'agent.networkEndpoints',
  'iSAVTXMb9TyWWuDDnWopFhgZpjm21WPigv': 'agent.networkProtocols',
  'iKM57qfzmgM1sxBgR3XBQa2XCRURZ2YVo2': 'agent.profileTags',
  'i7HY93tqfqCkpyKYiNtcDbioAgF8gRL9TQ': 'agent.profileWebsite',
  'iALo91Z75iXZxMvymvQMRwo7GAeHv5veKc': 'agent.profileAvatar',
  'iD3quozCGbzJyZ29uvRCeecr12np2dMsvN': 'agent.profileCategory',
  'iFxerhcrMr2e5eWyvHiXuWHXj2dnhEZF8p': 'agent.disputePolicy',
  'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad': 'review.record',
  'i6PC1B9vgVf8bLtHcdsNunLtr6ibtnL7ZC': 'bounty.record',
  'iE8Z7gZmAs4NU8AqEJzV9MWHUCoUBQqfum': 'bounty.application',
  'iMs3n1aCWQh5rmkXCNLRi8WqbzZrq3F7Ye': 'platform.config',
  'iHjLTt9P8Jb1uCYSpVpwXFbwzbPYWW4n8p': 'session.params',
  'i8xp9AgvueoAHyYXbxNACMgRQfEXF82V5D': 'workspace.attestation',
  'iMxAXRfTWUkKBmLGEZtEJbKj58kDi1GjZ9': 'workspace.capability',
  'iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn': 'job.record',
};

// ── Helpers ──

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

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

function getAgents() {
  try {
    return fs.readdirSync(AGENTS_DIR)
      .filter(d => fs.existsSync(path.join(AGENTS_DIR, d, 'keys.json')))
      .map(id => {
        const keys = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, id, 'keys.json'), 'utf8'));
        const soul = fs.existsSync(path.join(AGENTS_DIR, id, 'SOUL.md'))
          ? fs.readFileSync(path.join(AGENTS_DIR, id, 'SOUL.md'), 'utf8').substring(0, 100)
          : '(none)';
        return { id, ...keys, soulPreview: soul };
      });
  } catch { return []; }
}

function getDispatcherStatus() {
  const pidFile = path.join(DISPATCHER_DIR, 'dispatcher.pid');
  if (!fs.existsSync(pidFile)) return { running: false };
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
  try { process.kill(pid, 0); return { running: true, pid }; } catch { return { running: false, stalePid: pid }; }
}

function extractVdxfValue(entry) {
  if (typeof entry === 'string') {
    // Hex-encoded (like review records)
    try { return Buffer.from(entry, 'hex').toString('utf8'); } catch { return entry; }
  }
  if (entry && typeof entry === 'object') {
    // Nested DD format
    const inner = Object.values(entry)[0];
    if (inner?.objectdata?.message) return inner.objectdata.message;
    if (inner?.objectdata) return JSON.stringify(inner.objectdata);
  }
  return JSON.stringify(entry);
}

// ── Agent factory (suppress SDK logs) ──

async function createAgent(keys) {
  const { J41Agent } = require('@junction41/sovagent-sdk');
  const origLog = console.log;
  console.log = () => {};
  try {
    const agent = new J41Agent({
      apiUrl: process.env.J41_API_URL || loadEnv().J41_API_URL || 'https://api.junction41.io',
      wif: keys.wif,
      identityName: keys.identity,
      iAddress: keys.iAddress,
    });
    await agent.authenticate();
    console.log = origLog;
    // Patch stop() to suppress [J41] Stopped. log
    const origStop = agent.stop.bind(agent);
    agent.stop = () => { const ol = console.log; console.log = () => {}; origStop(); console.log = ol; };
    return agent;
  } catch (e) {
    console.log = origLog;
    throw e;
  }
}

// ── ESC-to-back support ──

const BACK = Symbol('BACK');

/** Wrap inquirer.prompt to support ESC key → throws BACK */
function promptWithEsc(inquirer, questions) {
  return new Promise((resolve, reject) => {
    // Listen for ESC on raw stdin
    const onKeypress = (chunk) => {
      if (chunk && chunk[0] === 27 && chunk.length === 1) { // ESC key
        process.stdin.removeListener('data', onKeypress);
        reject(BACK);
      }
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false); // inquirer handles raw mode
    }
    process.stdin.on('data', onKeypress);

    inquirer.prompt(questions).then((result) => {
      process.stdin.removeListener('data', onKeypress);
      resolve(result);
    }).catch((err) => {
      process.stdin.removeListener('data', onKeypress);
      reject(err);
    });
  });
}

/**
 * Run an external command asynchronously with stdio inherited.
 * Ctrl+C kills the child and returns null. No timeout — registration can take 20+ min.
 */
function runCommandAsync(cmd, args, cwd) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });

    const onSigint = () => {
      child.kill('SIGTERM');
      resolve(null);
    };
    process.on('SIGINT', onSigint);

    child.on('close', (code) => {
      process.removeListener('SIGINT', onSigint);
      resolve(code);
    });

    child.on('error', (err) => {
      process.removeListener('SIGINT', onSigint);
      console.error(`  Error spawning command: ${err.message}`);
      resolve(1);
    });
  });
}

/** Run a screen function, catch BACK to return silently */
async function withBack(fn) {
  try {
    await fn();
  } catch (e) {
    if (e === BACK) return; // ESC pressed — go back
    throw e;
  }
}

// ── Screens ──

async function mainMenu(inquirer) {
  const agents = getAgents();
  const status = getDispatcherStatus();
  const config = loadConfig();
  const env = loadEnv();

  console.clear();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  J41 Dispatcher — Setup & Management             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  Agents: ${agents.length} registered`);
  console.log(`  Dispatcher: ${status.running ? `running (PID ${status.pid})` : 'stopped'}`);
  console.log(`  Runtime: ${config.runtime || 'docker'}`);
  console.log(`  Global LLM: ${env.J41_LLM_PROVIDER || '(not configured)'}`);
  console.log(`  Executor: ${env.J41_EXECUTOR || 'local-llm'} (global default — per-agent overrides via [3])`);
  console.log('');

  const { choice } = await promptWithEsc(inquirer, [{
    type: 'list', pageSize: 20,
    name: 'choice',
    message: 'What would you like to do?',
    choices: [
      { name: `[1]  View Agents (${agents.length} registered)`, value: 'agents' },
      { name: '[2]  Add New Agent', value: 'add' },
      { name: '[3]  Configure Agent Executor', value: 'executor' },
      { name: '[4]  Configure Global LLM Default', value: 'llm' },
      { name: '[5]  Configure Services', value: 'services' },
      { name: '[6]  Security Setup', value: 'security' },
      new inquirer.Separator('  ── Dispatcher ──'),
      { name: `[7]  Start Dispatcher ${status.running ? '\x1b[32m(running)\x1b[0m' : ''}`, value: 'start' },
      { name: `[8]  Stop Dispatcher ${status.running ? '' : '\x1b[2m(not running)\x1b[0m'}`, value: 'stop' },
      { name: '[9]  View Logs', value: 'logs' },
      { name: '[10] Status & Health', value: 'status' },
      new inquirer.Separator('  ── Tools ──'),
      { name: '[11] Inspect Agent (on-chain)', value: 'inspect' },
      { name: '[12] Check Inbox', value: 'inbox' },
      { name: '[13] Earnings Summary', value: 'earnings' },
      { name: '[14] Docker Containers', value: 'docker' },
      new inquirer.Separator('  ── Marketplace ──'),
      { name: '[15] Bounties', value: 'bounties' },
      new inquirer.Separator(),
      { name: '     Quit', value: 'quit' },
    ],
  }]);

  return choice;
}

async function agentListScreen(inquirer) {
  const agents = getAgents();
  if (agents.length === 0) {
    console.log('\n  No agents registered. Use "Add New Agent" to create one.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const { agentId } = await promptWithEsc(inquirer, [{
    type: 'list', pageSize: 20,
    name: 'agentId',
    message: 'Select an agent:',
    choices: [
      ...agents.map(a => ({
        name: `  ${a.id.padEnd(10)} ${(a.identity || '').padEnd(30)} ${a.network || ''}`,
        value: a.id,
      })),
      new inquirer.Separator(),
      { name: '  ← Back', value: '__back' },
    ],
  }]);

  if (agentId === '__back') return;
  await agentDetailScreen(inquirer, agentId);
}

async function agentDetailScreen(inquirer, agentId) {
  const agentDir = path.join(AGENTS_DIR, agentId);
  const keys = JSON.parse(fs.readFileSync(path.join(agentDir, 'keys.json'), 'utf8'));

  console.clear();
  console.log(`\n  ═══ ${keys.identity || agentId} ═══\n`);
  console.log(`  ID:        ${agentId}`);
  console.log(`  Identity:  ${keys.identity || '(not set)'}`);
  console.log(`  i-Address: ${keys.iAddress || '(not set)'}`);
  console.log(`  R-Address: ${keys.address}`);
  console.log(`  Network:   ${keys.network || 'verustest'}`);
  console.log(`  Pubkey:    ${keys.pubkey?.substring(0, 20)}...`);

  // Check SOUL.md
  const soulPath = path.join(agentDir, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    const soul = fs.readFileSync(soulPath, 'utf8');
    console.log(`  SOUL.md:   ${soul.substring(0, 80).replace(/\n/g, ' ')}...`);
  }

  // Detect registration state
  const needsRegister = !keys.identity || !keys.iAddress;
  const finalizeStatePath = path.join(agentDir, 'finalize-state.json');
  const hasFinalize = fs.existsSync(finalizeStatePath);
  let finalizeIncomplete = false;
  let needsFinalize = false;

  if (needsRegister) {
    console.log(`  Status:    \x1b[33m⚠ NOT REGISTERED (has R-address only)\x1b[0m`);
  } else if (hasFinalize) {
    try {
      const fState = JSON.parse(fs.readFileSync(finalizeStatePath, 'utf8'));
      if (fState.stage && fState.stage !== 'ready') {
        console.log(`  Status:    \x1b[33m⚠ Finalize incomplete (stage: ${fState.stage})\x1b[0m`);
        finalizeIncomplete = true;
      } else {
        console.log(`  Status:    \x1b[32m✓ Registered & finalized\x1b[0m`);
      }
    } catch { finalizeIncomplete = true; }
  } else if (keys.identity && keys.iAddress) {
    // Registered but finalize never ran — no finalize-state.json, no VDXF keys
    console.log(`  Status:    \x1b[33m⚠ Registered but NOT FINALIZED (no profile/services on-chain)\x1b[0m`);
    needsFinalize = true;
  }
  console.log('');

  const choices = [
    { name: '  View VDXF Keys (on-chain data)', value: 'vdxf' },
    { name: '  View Platform Profile', value: 'platform' },
    { name: '  View Services', value: 'services' },
    { name: '  View SOUL.md', value: 'soul' },
    { name: '  View Jobs', value: 'jobs' },
  ];

  // Update profile option — only for fully registered agents
  if (!needsRegister && !needsFinalize && !finalizeIncomplete) {
    choices.push(new inquirer.Separator('  ── Edit ──'));
    choices.push({ name: '  Update Profile (change on-chain VDXF fields)', value: 'update_profile' });
  }

  // Add retry/register/finalize options for incomplete agents
  if (needsRegister) {
    choices.push(new inquirer.Separator('  ── Fix ──'));
    choices.push({ name: '  \x1b[33mRetry Registration (on-chain identity)\x1b[0m', value: 'retry_register' });
  }
  if (finalizeIncomplete || needsFinalize) {
    choices.push(new inquirer.Separator('  ── Fix ──'));
    choices.push({ name: '  \x1b[33mRun Finalize (publish profile/services on-chain)\x1b[0m', value: 'retry_finalize' });
  }

  choices.push(new inquirer.Separator());
  choices.push({ name: '  ← Back to agents', value: '__back' });

  const { action } = await promptWithEsc(inquirer, [{
    type: 'list', pageSize: 20,
    name: 'action',
    message: 'Agent options:',
    choices,
  }]);

  switch (action) {
    case 'vdxf': await vdxfScreen(inquirer, keys); break;
    case 'platform': await platformScreen(inquirer, keys); break;
    case 'services': await servicesScreen(inquirer, keys); break;
    case 'soul': await soulScreen(inquirer, agentDir); break;
    case 'jobs': await jobsScreen(inquirer, keys); break;
    case 'update_profile': await updateProfileScreen(inquirer, agentId, keys); break;
    case 'retry_register': await retryRegisterScreen(inquirer, agentId, keys); break;
    case 'retry_finalize': await retryFinalizeScreen(inquirer, agentId); break;
    case '__back': return;
  }

  // Loop back to agent detail
  await agentDetailScreen(inquirer, agentId);
}

// All VDXF keys in display order
const ALL_VDXF_KEYS = [
  // Agent keys
  { iAddr: 'iKkdwxhdupLgf7v2qn4JGBQHntsBb17kjW', name: 'agent.displayName' },
  { iAddr: 'iNxeLSDFARVQezfEt4i8CBZjTSRpFTPAyP', name: 'agent.type' },
  { iAddr: 'iQr3yKEn2DXaG4GQGVAVYivC3jwcvScfzk', name: 'agent.description' },
  { iAddr: 'iLy373iaKafmRCY43ahty4m8aLQx32y8Fh', name: 'agent.status' },
  { iAddr: 'iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD', name: 'agent.payAddress' },
  { iAddr: 'iBLx3rga8DewiN6gyQyC5avFin8fnnojnS', name: 'agent.markup' },
  { iAddr: 'iQJUQmdFSmM49cvLJfKLZnuRYsjXSmTTHY', name: 'agent.models' },
  { iAddr: 'iD3quozCGbzJyZ29uvRCeecr12np2dMsvN', name: 'agent.profileCategory' },
  { iAddr: 'iKM57qfzmgM1sxBgR3XBQa2XCRURZ2YVo2', name: 'agent.profileTags' },
  { iAddr: 'i7HY93tqfqCkpyKYiNtcDbioAgF8gRL9TQ', name: 'agent.profileWebsite' },
  { iAddr: 'iALo91Z75iXZxMvymvQMRwo7GAeHv5veKc', name: 'agent.profileAvatar' },
  { iAddr: 'iF7174LxgcAnu3qZ7iJzSyJYthDJXBzQNw', name: 'agent.networkCapabilities' },
  { iAddr: 'i5VzGsiFmJYuRr7b8aUyHzAS8vd9DC4puS', name: 'agent.networkEndpoints' },
  { iAddr: 'iSAVTXMb9TyWWuDDnWopFhgZpjm21WPigv', name: 'agent.networkProtocols' },
  { iAddr: 'iFxerhcrMr2e5eWyvHiXuWHXj2dnhEZF8p', name: 'agent.disputePolicy' },
  // Service
  { iAddr: 'i8Wk7fcbsBWtcf965Z3WvDUjahF1aTH1tu', name: 'agent.services' },
  // Session
  { iAddr: 'iHjLTt9P8Jb1uCYSpVpwXFbwzbPYWW4n8p', name: 'session.params' },
  // Platform config
  { iAddr: 'iMs3n1aCWQh5rmkXCNLRi8WqbzZrq3F7Ye', name: 'platform.config' },
  // Workspace
  { iAddr: 'iMxAXRfTWUkKBmLGEZtEJbKj58kDi1GjZ9', name: 'workspace.capability' },
  { iAddr: 'i8xp9AgvueoAHyYXbxNACMgRQfEXF82V5D', name: 'workspace.attestation' },
  // Records
  { iAddr: 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad', name: 'review.record' },
  { iAddr: 'iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn', name: 'job.record' },
  { iAddr: 'i6PC1B9vgVf8bLtHcdsNunLtr6ibtnL7ZC', name: 'bounty.record' },
  { iAddr: 'iE8Z7gZmAs4NU8AqEJzV9MWHUCoUBQqfum', name: 'bounty.application' },
];

const EDITABLE_PROFILE_FIELDS = [
  { label: 'Display Name',    field: 'displayName',          flag: '--display-name' },
  { label: 'Description',     field: 'description',          flag: '--description' },
  { label: 'Type',            field: 'type',                 flag: '--type' },
  { label: 'Pay Address',     field: 'payAddress',           flag: '--pay-address' },
  { label: 'Markup %',        field: 'markup',               flag: '--markup' },
  { label: 'Models',          field: 'models',               flag: '--models',               isCsv: true },
  { label: 'Category',        field: 'profileCategory',      flag: '--profile-category' },
  { label: 'Tags',            field: 'profileTags',          flag: '--profile-tags',          isCsv: true },
  { label: 'Website',         field: 'profileWebsite',       flag: '--profile-website' },
  { label: 'Avatar URL',      field: 'profileAvatar',        flag: '--profile-avatar' },
  { label: 'Capabilities',    field: 'networkCapabilities',  flag: '--network-capabilities',  isCsv: true },
  { label: 'Endpoints',       field: 'networkEndpoints',     flag: '--network-endpoints',     isCsv: true },
  { label: 'Protocols',       field: 'networkProtocols',     flag: '--network-protocols',     isCsv: true },
];

// Map VDXF field names to i-addresses for reading current values
const VDXF_FIELD_TO_IADDR = {
  displayName: 'iKkdwxhdupLgf7v2qn4JGBQHntsBb17kjW',
  type: 'iNxeLSDFARVQezfEt4i8CBZjTSRpFTPAyP',
  description: 'iQr3yKEn2DXaG4GQGVAVYivC3jwcvScfzk',
  payAddress: 'iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD',
  markup: 'iBLx3rga8DewiN6gyQyC5avFin8fnnojnS',
  models: 'iQJUQmdFSmM49cvLJfKLZnuRYsjXSmTTHY',
  profileCategory: 'iD3quozCGbzJyZ29uvRCeecr12np2dMsvN',
  profileTags: 'iKM57qfzmgM1sxBgR3XBQa2XCRURZ2YVo2',
  profileWebsite: 'i7HY93tqfqCkpyKYiNtcDbioAgF8gRL9TQ',
  profileAvatar: 'iALo91Z75iXZxMvymvQMRwo7GAeHv5veKc',
  networkCapabilities: 'iF7174LxgcAnu3qZ7iJzSyJYthDJXBzQNw',
  networkEndpoints: 'i5VzGsiFmJYuRr7b8aUyHzAS8vd9DC4puS',
  networkProtocols: 'iSAVTXMb9TyWWuDDnWopFhgZpjm21WPigv',
};

async function updateProfileScreen(inquirer, agentId, keys) {
  console.clear();
  console.log(`\n  ═══ Update Profile: ${keys.identity} ═══\n`);

  // Fetch current on-chain values
  let currentValues = {};
  try {
    const agent = await createAgent(keys);
    let rawId;
    try { rawId = (await agent.client.getIdentityRaw()).data; } finally { agent.stop(); }
    const cmap = rawId?.identity?.contentmultimap || {};

    for (const f of EDITABLE_PROFILE_FIELDS) {
      const iAddr = VDXF_FIELD_TO_IADDR[f.field];
      if (iAddr && cmap[iAddr]) {
        const val = extractVdxfValue(Array.isArray(cmap[iAddr]) ? cmap[iAddr][0] : cmap[iAddr]);
        currentValues[f.field] = val;
      }
    }
  } catch (e) {
    console.log(`  Could not fetch current values: ${e.message}\n`);
  }

  // Show current values and let user pick which to change
  const fieldChoices = EDITABLE_PROFILE_FIELDS.map(f => {
    const cur = currentValues[f.field] || '(not set)';
    const display = typeof cur === 'string' && cur.length > 50 ? cur.substring(0, 50) + '...' : cur;
    return { name: `  ${f.label.padEnd(20)} ${display}`, value: f.field };
  });

  const { fields } = await promptWithEsc(inquirer, [{
    type: 'checkbox',
    pageSize: 20,
    name: 'fields',
    message: 'Select fields to update (space to select, enter to confirm):',
    choices: fieldChoices,
  }]);

  if (!fields || fields.length === 0) {
    console.log('\n  No fields selected.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  // Prompt for new values
  const updates = {};
  for (const fieldName of fields) {
    const f = EDITABLE_PROFILE_FIELDS.find(e => e.field === fieldName);
    const curVal = currentValues[fieldName] || '';
    const displayCur = typeof curVal === 'string' ? curVal : JSON.stringify(curVal);

    if (f.isCsv) {
      // Show as comma-separated for easier editing
      let csvDefault = '';
      try {
        const parsed = typeof curVal === 'string' ? JSON.parse(curVal) : curVal;
        csvDefault = Array.isArray(parsed) ? parsed.join(', ') : displayCur;
      } catch { csvDefault = displayCur; }
      const { val } = await promptWithEsc(inquirer, [{ type: 'input', name: 'val', message: `  ${f.label} (comma-separated):`, default: csvDefault }]);
      updates[fieldName] = val;
    } else {
      const { val } = await promptWithEsc(inquirer, [{ type: 'input', name: 'val', message: `  ${f.label}:`, default: displayCur }]);
      updates[fieldName] = val;
    }
  }

  // Summary
  console.log('\n  ─── Changes ───');
  for (const [fieldName, newVal] of Object.entries(updates)) {
    const f = EDITABLE_PROFILE_FIELDS.find(e => e.field === fieldName);
    const oldVal = currentValues[fieldName] || '(not set)';
    const oldDisplay = typeof oldVal === 'string' && oldVal.length > 40 ? oldVal.substring(0, 40) + '...' : oldVal;
    const newDisplay = typeof newVal === 'string' && newVal.length > 40 ? newVal.substring(0, 40) + '...' : newVal;
    console.log(`  ${f.label}: ${oldDisplay} → ${newDisplay}`);
  }

  console.log('\n  ⚠️  This is a blockchain transaction — changes are permanent.');
  console.log('  Two transactions required: remove old values → wait for block → write new values.');
  console.log('  This typically takes 1-3 minutes.\n');

  const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: 'Proceed?', default: true }]);
  if (!confirm) return;

  // Build CLI flags
  const cliArgs = ['node', 'src/cli.js', 'update-profile', agentId];
  for (const [fieldName, newVal] of Object.entries(updates)) {
    const f = EDITABLE_PROFILE_FIELDS.find(e => e.field === fieldName);
    cliArgs.push(f.flag, newVal);
  }

  console.log('');
  const exitCode = await runCommandAsync(cliArgs[0], cliArgs.slice(1), REPO_DIR);

  if (exitCode === 0) {
    console.log('\n  ✅ Profile updated on-chain!\n');
  } else if (exitCode === null) {
    console.log('\n  ⚠️  Interrupted. Check transaction status manually.\n');
  } else {
    console.log(`\n  ❌ Update failed (exit ${exitCode}).\n`);
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function vdxfScreen(inquirer, keys) {
  console.clear();
  console.log(`\n  ═══ VDXF Keys: ${keys.identity} ═══\n`);

  try {
    const agent = await createAgent(keys);
    let rawId;
    try { rawId = (await agent.client.getIdentityRaw()).data; } finally { agent.stop(); }

    const cmap = rawId.identity?.contentmultimap || {};

    // Show ALL keys, marking empty ones
    for (const keyDef of ALL_VDXF_KEYS) {
      const nameCol = `  ${keyDef.name}`.padEnd(32);
      const entries = cmap[keyDef.iAddr];

      if (!entries) {
        console.log(`${nameCol} \x1b[2m(not set)\x1b[0m`);
        continue;
      }

      const values = Array.isArray(entries) ? entries : [entries];
      for (let i = 0; i < values.length; i++) {
        const val = extractVdxfValue(values[i]);
        const displayVal = val.length > 100 ? val.substring(0, 97) + '...' : val;
        const label = i === 0 ? nameCol : `  ${''}`.padEnd(32);
        console.log(`${label} ${displayVal}`);
      }
    }

    // Show any unknown keys not in our mapping
    const knownAddrs = new Set(ALL_VDXF_KEYS.map(k => k.iAddr));
    for (const [iAddr, entries] of Object.entries(cmap)) {
      if (knownAddrs.has(iAddr)) continue;
      const values = Array.isArray(entries) ? entries : [entries];
      for (const entry of values) {
        const val = extractVdxfValue(entry);
        const displayVal = val.length > 80 ? val.substring(0, 77) + '...' : val;
        console.log(`  \x1b[33m${iAddr.substring(0, 20)}...\x1b[0m`.padEnd(44) + ` ${displayVal}`);
      }
    }

    console.log(`\n  Block height: ${rawId.blockHeight || '?'}`);
    console.log(`  Last TX: ${rawId.txid?.substring(0, 16) || '?'}...`);
  } catch (e) {
    console.log(`  Error fetching VDXF data: ${e.message}\n`);
  }

  console.log('');
  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function platformScreen(inquirer, keys) {
  console.clear();
  console.log(`\n  ═══ Platform Profile: ${keys.identity} ═══\n`);

  try {
    const agent = await createAgent(keys);
    let d;
    try {
      d = await agent.client.getAgent(keys.iAddress || keys.identity);
    } finally { agent.stop(); }
    d = d?.data || d;
    console.log(`  Name:           ${d.name || '(none)'}`);
    console.log(`  Status:         ${d.status || '?'} ${d.online ? '● online' : '○ offline'}`);
    console.log(`  Type:           ${d.type || '?'}`);
    console.log(`  Trust Tier:     ${d.trustTier || '?'}`);
    console.log(`  Reviews:        ${d.chainReviewCount || 0}`);
    console.log(`  Workspace:      ${d.workspaceCapable ? 'enabled' : 'disabled'}`);
    console.log(`  Models:         ${(d.models || []).join(', ') || '(none)'}`);
    console.log(`  Category:       ${d.category || '(none)'}`);
    console.log(`  Last Seen:      ${d.lastSeenAt || '(never)'}`);
    console.log(`  Created:        ${d.createdAt || '?'}`);
    console.log(`  Description:    ${(d.description || '(none)').substring(0, 100)}`);
  } catch (e) {
    console.log(`  Error: ${e.message}\n`);
  }

  console.log('');
  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function servicesScreen(inquirer, keys) {
  console.clear();
  console.log(`\n  ═══ Services: ${keys.identity} ═══\n`);

  try {
    const agent = await createAgent(keys);
    let result;
    try { result = await agent.client.getAgentServices(keys.iAddress || keys.identity); } finally { agent.stop(); }

    const list = result.data || result || [];
    if (list.length === 0) {
      console.log('  (no services registered)\n');
    } else {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        console.log(`  [${i + 1}] ${s.name}`);
        console.log(`      Price: ${s.price} ${s.currency}  |  Status: ${s.status}  |  Category: ${s.category || '?'}`);
        console.log(`      Turnaround: ${s.turnaround || '?'}  |  SovGuard: ${s.sovguard ? 'yes' : 'no'}  |  Workspace: ${s.workspaceCapable ? 'yes' : 'no'}`);
        console.log(`      ID: ${s.id}`);
        console.log(`      ${(s.description || '').substring(0, 100)}`);
        console.log('');
      }
    }
  } catch (e) {
    console.log(`  Error: ${e.message}\n`);
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function soulScreen(inquirer, agentDir) {
  console.clear();
  const soulPath = path.join(agentDir, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    console.log(`\n  ═══ SOUL.md ═══\n`);
    console.log(fs.readFileSync(soulPath, 'utf8'));
  } else {
    console.log('\n  (no SOUL.md found)\n');
  }
  console.log('');

  const { action } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'action', message: 'Options:', choices: [
    { name: '  Edit SOUL.md', value: 'edit' },
    { name: '  ← Back', value: '__back' },
  ]}]);

  if (action === '__back') return;

  // Edit SOUL.md
  console.log('\n  Build the personality line by line.\n');
  const { role } = await promptWithEsc(inquirer, [{ type: 'input', name: 'role', message: 'Who is this agent?:' }]);
  const { personality } = await promptWithEsc(inquirer, [{ type: 'input', name: 'personality', message: 'Personality traits:' }]);
  const { rules } = await promptWithEsc(inquirer, [{ type: 'input', name: 'rules', message: 'Rules/constraints:' }]);
  const { style } = await promptWithEsc(inquirer, [{ type: 'input', name: 'style', message: 'Communication style:' }]);
  const { catchphrases } = await promptWithEsc(inquirer, [{ type: 'input', name: 'catchphrases', message: 'Key phrases (comma-separated):' }]);
  const { extra } = await promptWithEsc(inquirer, [{ type: 'input', name: 'extra', message: 'Anything else:' }]);

  const lines = [role || 'You are an AI agent.'];
  if (personality) lines.push('', 'Personality: ' + personality);
  if (rules) lines.push('', 'Rules:', ...rules.split(',').map(r => '- ' + r.trim()).filter(r => r !== '- '));
  if (style) lines.push('', 'Style: ' + style);
  if (catchphrases) lines.push('', 'Key phrases:', ...catchphrases.split(',').map(p => '- "' + p.trim() + '"').filter(p => p !== '- ""'));
  if (extra) lines.push('', extra);
  const newSoul = lines.join('\n');

  console.log('\n  ── Preview ──\n');
  console.log(newSoul.split('\n').map(l => '  ' + l).join('\n'));
  console.log('');

  const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: 'Save this SOUL.md?', default: true }]);
  if (confirm) {
    fs.writeFileSync(soulPath, newSoul);
    console.log('\n  ✅ SOUL.md saved.\n');
  }
  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function jobsScreen(inquirer, keys) {
  console.clear();
  console.log(`\n  ═══ Recent Jobs: ${keys.identity} ═══\n`);

  try {
    const agent = await createAgent(keys);
    let result;
    try { result = await agent.client.getMyJobs({ role: 'seller' }); } finally { agent.stop(); }

    const jobs = (result.data || []).slice(0, 15);
    if (jobs.length === 0) {
      console.log('  (no jobs)\n');
    } else {
      console.log(`  ${'ID'.padEnd(10)} ${'Status'.padEnd(12)} ${'Amount'.padEnd(12)} ${'Created'.padEnd(22)} Description`);
      console.log(`  ${'─'.repeat(10)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(22)} ${'─'.repeat(30)}`);
      for (const j of jobs) {
        const created = j.timestamps?.created ? new Date(j.timestamps.created).toISOString().substring(0, 16) : '?';
        console.log(`  ${j.id.substring(0, 8).padEnd(10)} ${(j.status || '?').padEnd(12)} ${(j.amount + ' ' + (j.currency || '')).padEnd(12)} ${created.padEnd(22)} ${(j.description || '').substring(0, 40)}`);
      }
      console.log(`\n  Total: ${result.data?.length || jobs.length} jobs`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}\n`);
  }

  console.log('');
  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function statusScreen(inquirer) {
  console.clear();
  console.log(`\n  ═══ Dispatcher Status ═══\n`);

  const status = getDispatcherStatus();
  const config = loadConfig();
  const env = loadEnv();

  console.log(`  Running:    ${status.running ? `yes (PID ${status.pid})` : 'no'}`);
  console.log(`  Runtime:    ${config.runtime || 'docker'}`);
  console.log(`  LLM:        ${env.J41_LLM_PROVIDER || '(not set)'}`);
  console.log(`  API:        ${env.J41_API_URL || 'https://api.junction41.io'}`);

  // Check Docker
  try {
    const docker = require('child_process').execSync('docker ps --filter name=j41-job --format "{{.Names}} {{.Status}}"', { encoding: 'utf8', timeout: 5000 }).trim();
    const containers = docker ? docker.split('\n') : [];
    console.log(`\n  Active containers: ${containers.length}`);
    for (const c of containers) console.log(`    ${c}`);
  } catch {
    console.log(`\n  Docker: not available`);
  }

  // Check security
  try {
    const secureSetup = require('@junction41/secure-setup');
    const isolation = await secureSetup.detectIsolation();
    console.log(`\n  Security:   ${isolation.score}/10 (${isolation.mode})`);
  } catch {
    console.log(`\n  Security:   (secure-setup not available)`);
  }

  console.log('');
  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

/** Fetch categories from platform — cached per session */
let _cachedCategories = null;
async function fetchCategories() {
  if (_cachedCategories) return _cachedCategories;
  try {
    const agents = getAgents();
    if (agents.length === 0) return [];
    const agent = await createAgent(agents[0]);
    try {
      const result = await agent.client.getServiceCategories();
      _cachedCategories = Array.isArray(result) ? result : (result?.data || []);
    } finally { agent.stop(); }
  } catch {
    _cachedCategories = [];
  }
  return _cachedCategories;
}

/** Show category picker with subcategories */
async function pickCategory(inquirer, defaultVal) {
  const categories = await fetchCategories();

  if (categories.length > 0 && categories[0]?.id) {
    const catChoices = [];
    for (const cat of categories) {
      catChoices.push({ name: `  ${cat.icon || ''} ${cat.name}`, value: cat.id });
      if (cat.subs?.length > 0) {
        for (const sub of cat.subs) {
          catChoices.push({ name: `     └─ ${sub}`, value: `${cat.id}:${sub.toLowerCase().replace(/[^a-z0-9]/g, '-')}` });
        }
      }
    }
    const { cat } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'cat', message: 'Category:', choices: catChoices }]);
    return cat;
  }
  const { cat } = await promptWithEsc(inquirer, [{ type: 'input', name: 'cat', message: 'Category:', default: defaultVal || 'development' }]);
  return cat;
}

async function createCustomTemplate(inquirer, tplDir) {
  console.clear();
  console.log('\n  ═══ Create Custom Template ═══\n');
  console.log('  Fill in the profile and service details. This will be saved as a\n  reusable template for future agents.\n');

  // Template name
  const { rawTplName } = await promptWithEsc(inquirer, [{ type: 'input', name: 'rawTplName', message: 'Template name (lowercase, dashes):' }]);
  if (!rawTplName) { console.log('\n  ❌ Name required.\n'); return null; }
  const tplName = rawTplName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!tplName) { console.log('\n  ❌ Invalid name.\n'); return null; }
  if (fs.existsSync(path.join(tplDir, tplName))) { console.log(`\n  ❌ Template "${tplName}" already exists.\n`); return null; }
  if (tplName !== rawTplName) console.log(`  → Normalized to: ${tplName}`);

  console.log('\n  ── Agent Profile ──\n');

  const { profileName } = await promptWithEsc(inquirer, [{ type: 'input', name: 'profileName', message: 'Display name:', default: 'My Agent' }]);
  const { profileType } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'profileType', message: 'Agent type:', choices: [
    { name: '  autonomous — fully automated, no human in the loop', value: 'autonomous' },
    { name: '  assisted — human-assisted AI', value: 'assisted' },
    { name: '  hybrid — mix of automated and manual', value: 'hybrid' },
    { name: '  tool — utility/function agent', value: 'tool' },
  ]}]);
  const { profileDesc } = await promptWithEsc(inquirer, [{ type: 'input', name: 'profileDesc', message: 'Description:' }]);
  const profileCategory = await pickCategory(inquirer, 'development');
  const { profileTags } = await promptWithEsc(inquirer, [{ type: 'input', name: 'profileTags', message: 'Tags (comma-separated):', default: 'ai,assistant' }]);
  const { profileMarkup } = await promptWithEsc(inquirer, [{ type: 'input', name: 'profileMarkup', message: 'Markup % (0-50):', default: '0' }]);
  const { profileModels } = await promptWithEsc(inquirer, [{ type: 'input', name: 'profileModels', message: 'Models (comma-separated):', default: 'moonshotai/kimi-k2.5' }]);
  const { profileProtocols } = await promptWithEsc(inquirer, [{ type: 'checkbox', pageSize: 20, name: 'profileProtocols', message: 'Protocols:', choices: ['MCP', 'REST', 'A2A', 'WebSocket'], default: ['MCP', 'REST'] }]);
  const { profileCapabilities } = await promptWithEsc(inquirer, [{ type: 'input', name: 'profileCapabilities', message: 'Capabilities (comma-separated):', default: 'code-review,analysis' }]);

  // Workspace
  const { workspaceEnabled } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'workspaceEnabled', message: 'Enable workspace (file access)?', default: true }]);
  let workspaceModes = ['supervised'];
  if (workspaceEnabled) {
    const { modes } = await promptWithEsc(inquirer, [{ type: 'checkbox', pageSize: 20, name: 'modes', message: 'Workspace modes:', choices: ['supervised', 'standard'], default: ['supervised'] }]);
    workspaceModes = modes;
  }

  // Session params
  console.log('\n  ── Session Limits ──\n');
  const { sessDuration } = await promptWithEsc(inquirer, [{ type: 'input', name: 'sessDuration', message: 'Max duration (seconds):', default: '7200' }]);
  const { sessTokenLimit } = await promptWithEsc(inquirer, [{ type: 'input', name: 'sessTokenLimit', message: 'Token limit:', default: '200000' }]);
  const { sessMessageLimit } = await promptWithEsc(inquirer, [{ type: 'input', name: 'sessMessageLimit', message: 'Message limit:', default: '100' }]);

  // Service
  console.log('\n  ── Default Service ──\n');
  const { svcName } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcName', message: 'Service name:', default: profileName }]);
  const { svcDesc } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcDesc', message: 'Service description:', default: profileDesc }]);
  const { svcPrice } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcPrice', message: 'Price:', default: '0.5' }]);
  const { svcCurrency } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcCurrency', message: 'Currency:', default: 'VRSCTEST' }]);
  const svcCategory = await pickCategory(inquirer, profileCategory);
  const { svcTurnaround } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcTurnaround', message: 'Turnaround:', default: '15 minutes' }]);
  const { svcPayment } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'svcPayment', message: 'Payment terms:', choices: ['prepay', 'postpay', 'split'], default: 'prepay' }]);
  const { svcSovguard } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'svcSovguard', message: 'Enable SovGuard?', default: true }]);

  // SOUL.md
  console.log('\n  ── Agent Personality (SOUL.md) ──\n');
  const defaultSoul = `You are ${profileName}, a ${profileType} AI agent.\n\n${profileDesc}\n\nBe helpful, concise, and professional.`;

  const { soulChoice } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'soulChoice', message: 'SOUL.md (system prompt):', choices: [
    { name: '  Use default (auto-generated from profile)', value: 'default' },
    { name: '  Write custom personality', value: 'custom' },
  ]}]);

  let soulPrompt = defaultSoul;
  if (soulChoice === 'custom') {
    console.log('\n  Build your agent\'s personality line by line.\n  Enter each section, or leave blank to skip.\n');

    const { role } = await promptWithEsc(inquirer, [{ type: 'input', name: 'role', message: 'Who is this agent? (e.g. "You are Shreck, an ogre who lives in a swamp"):', default: `You are ${profileName}` }]);
    const { personality } = await promptWithEsc(inquirer, [{ type: 'input', name: 'personality', message: 'Personality traits (e.g. "Grumpy but kind, speaks with a Scottish accent"):' }]);
    const { rules } = await promptWithEsc(inquirer, [{ type: 'input', name: 'rules', message: 'Rules/constraints (e.g. "Never break character, never say you are an AI"):' }]);
    const { style } = await promptWithEsc(inquirer, [{ type: 'input', name: 'style', message: 'Communication style (e.g. "Short sentences, uses metaphors about onions"):' }]);
    const { catchphrases } = await promptWithEsc(inquirer, [{ type: 'input', name: 'catchphrases', message: 'Key phrases/catchphrases (comma-separated):' }]);
    const { extra } = await promptWithEsc(inquirer, [{ type: 'input', name: 'extra', message: 'Anything else to add:' }]);

    const lines = [role];
    if (personality) lines.push('', 'Personality: ' + personality);
    if (rules) lines.push('', 'Rules:', ...rules.split(',').map(r => '- ' + r.trim()).filter(r => r !== '- '));
    if (style) lines.push('', 'Style: ' + style);
    if (catchphrases) lines.push('', 'Key phrases:', ...catchphrases.split(',').map(p => '- "' + p.trim() + '"').filter(p => p !== '- ""'));
    if (extra) lines.push('', extra);
    soulPrompt = lines.join('\n');

    console.log('\n  ── Preview ──\n');
    console.log(soulPrompt.split('\n').map(l => '  ' + l).join('\n'));
    console.log('');

    const { confirmSoul } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirmSoul', message: 'Use this personality?', default: true }]);
    if (!confirmSoul) soulPrompt = defaultSoul;
  }

  // Build config
  const config = {
    template: tplName,
    profile: {
      name: profileName,
      type: profileType,
      description: profileDesc,
      network: {
        capabilities: profileCapabilities.split(',').map(s => s.trim()).filter(Boolean),
        protocols: profileProtocols,
      },
      profile: {
        category: profileCategory,
        tags: profileTags.split(',').map(s => s.trim()).filter(Boolean),
      },
      models: profileModels.split(',').map(s => s.trim()).filter(Boolean),
      markup: parseInt(profileMarkup) || 0,
      session: {
        duration: parseInt(sessDuration) || 7200,
        tokenLimit: parseInt(sessTokenLimit) || 200000,
        messageLimit: parseInt(sessMessageLimit) || 100,
      },
      workspace: workspaceEnabled ? {
        enabled: true,
        modes: workspaceModes,
        tools: ['read_file', 'write_file', 'list_directory'],
      } : { enabled: false },
    },
    service: {
      name: svcName,
      description: svcDesc,
      price: svcPrice,
      currency: svcCurrency,
      category: svcCategory,
      turnaround: svcTurnaround,
      paymentTerms: svcPayment,
      sovguard: svcSovguard,
    },
  };

  // Save template
  const tplPath = path.join(tplDir, tplName);
  fs.mkdirSync(tplPath, { recursive: true });
  fs.writeFileSync(path.join(tplPath, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(tplPath, 'SOUL.md'), soulPrompt);

  console.log(`\n  ✅ Template "${tplName}" saved to templates/${tplName}/`);
  console.log(`  Files: config.json, SOUL.md\n`);

  return tplName;
}

async function addAgentScreen(inquirer) {
  console.clear();
  console.log('\n  ═══ Add New Agent ═══\n');

  const agents = getAgents();
  const nextNum = agents.length + 1;
  const defaultId = `agent-${nextNum}`;

  const { agentId } = await promptWithEsc(inquirer, [{ type: 'input', name: 'agentId', message: 'Agent ID (local identifier):', default: defaultId }]);
  if (fs.existsSync(path.join(AGENTS_DIR, agentId, 'keys.json'))) {
    console.log(`\n  ❌ Agent ${agentId} already exists.\n`);
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const { name } = await promptWithEsc(inquirer, [{ type: 'input', name: 'name', message: 'Identity name (lowercase, no spaces — becomes <name>.agentplatform@):' }]);
  if (!name) { console.log('\n  ❌ Name required.\n'); return; }

  // Check available templates
  const tplDir = path.join(__dirname, '..', 'templates');
  let templates = [];
  try { templates = fs.readdirSync(tplDir).filter(d => fs.existsSync(path.join(tplDir, d, 'config.json'))); } catch {}

  const { tpl } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'tpl', message: 'Select template:', choices: [
    ...templates.map(t => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(tplDir, t, 'config.json'), 'utf8'));
        return { name: `  ${t.padEnd(22)} ${cfg.profile?.description?.substring(0, 50) || ''}`, value: t };
      } catch { return { name: `  ${t}`, value: t }; }
    }),
    new inquirer.Separator(),
    { name: '  + Create Custom Template', value: '__custom' },
  ]}]);

  let template = tpl;

  if (template === '__custom') {
    template = await createCustomTemplate(inquirer, tplDir);
    if (!template) return;
  }

  console.log(`\n  ─── Creating Agent ───`);
  console.log(`  ID:       ${agentId}`);
  console.log(`  Identity: ${name}.agentplatform@`);
  console.log(`  Template: ${template}\n`);

  const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: 'Proceed with setup?', default: true }]);
  if (!confirm) return;

  // Run the setup command (async — registration can take 20+ minutes for block confirmations)
  try {
    console.log('');
    console.log('  ℹ️  Registration waits for block confirmations (can take 5-20 min).');
    console.log('  Press Ctrl+C to return to menu — registration continues on the platform.\n');
    const exitCode = await runCommandAsync('node', ['src/cli.js', 'setup', agentId, name, '--template', template], REPO_DIR);
    if (exitCode === 0) {
      console.log('\n  ✅ Agent created successfully.\n');

      // Offer immediate executor configuration
      const { configNow } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'configNow', message: 'Configure executor for this agent now?', default: true }]);
      if (configNow) {
        const execConfig = { executor: 'local-llm' };

        const { execType } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'execType', message: 'Executor type:', choices: [
          ...Object.entries(EXECUTOR_DESCRIPTIONS).map(([key, desc]) => ({
            name: `  ${key.padEnd(12)} ${desc}`,
            value: key,
          })),
        ]}]);
        execConfig.executor = execType;

        if (execType === 'local-llm' || execType === 'mcp') {
          await configureLLMProvider(inquirer, execConfig);
        }
        if (execType === 'webhook' || execType === 'langserve' || execType === 'langgraph' || execType === 'a2a') {
          const { url } = await promptWithEsc(inquirer, [{ type: 'input', name: 'url', message: 'Endpoint URL:' }]);
          execConfig.executorUrl = url;
          const { auth } = await promptWithEsc(inquirer, [{ type: 'password', name: 'auth', message: 'Authorization header (leave empty for none):', mask: '*' }]);
          if (auth) execConfig.executorAuth = auth;
        }
        if (execType === 'mcp') {
          const { cmd } = await promptWithEsc(inquirer, [{ type: 'input', name: 'cmd', message: 'MCP server command (or leave empty for HTTP):', default: '' }]);
          if (cmd) execConfig.mcpCommand = cmd;
          else {
            const { url } = await promptWithEsc(inquirer, [{ type: 'input', name: 'url', message: 'MCP server URL:' }]);
            execConfig.mcpUrl = url;
          }
        }

        saveAgentConfig(agentId, execConfig);
        console.log(`\n  ✅ Executor config saved. You can change it later via "Configure Agent Executor".\n`);
      }
    } else {
      console.log(`\n  ❌ Setup failed (exit code ${exitCode}).`);
      console.log('     If registration was in progress, use "Retry Registration" from the agent detail screen.\n');
    }
  } catch (e) {
    console.log(`\n  ❌ Setup failed: ${e.message}\n`);
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function configureServicesScreen(inquirer) {
  const agents = getAgents();
  if (agents.length === 0) {
    console.log('\n  No agents registered. Add an agent first.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const { agentId } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'agentId', message: 'Select agent to manage services:', choices: agents.map(a => ({ name: `  ${a.id.padEnd(10)} ${a.identity}`, value: a.id })) }]);
  const keys = agents.find(a => a.id === agentId);
  if (!keys) return;

  while (true) {
    console.clear();
    console.log(`\n  ═══ Services: ${keys.identity} ═══\n`);

    // Fetch existing services
    let list = [];
    try {
      const agent = await createAgent(keys);
      try { const result = await agent.client.getAgentServices(keys.iAddress || keys.identity); list = result.data || result || []; } finally { agent.stop(); }
    } catch (e) {
      console.log(`  Could not fetch services: ${e.message}\n`);
    }

    if (list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        console.log(`  [${i + 1}] ${s.name}`);
        console.log(`      Price: ${s.price} ${s.currency}  |  Status: ${s.status || 'active'}  |  Category: ${s.category || '?'}`);
        console.log(`      Turnaround: ${s.turnaround || '?'}  |  SovGuard: ${s.sovguard ? 'yes' : 'no'}`);
        if (s.description) console.log(`      ${s.description.substring(0, 80)}`);
        console.log(`      ID: ${s.id}`);
        console.log('');
      }
    } else {
      console.log('  No services registered yet.\n');
    }

    // Build action choices
    const actionChoices = [
      { name: '  Add new service', value: 'add' },
    ];
    if (list.length > 0) {
      actionChoices.push({ name: '  Edit a service', value: 'edit' });
      actionChoices.push({ name: '  Delete a service', value: 'delete' });
    }
    actionChoices.push(new inquirer.Separator());
    actionChoices.push({ name: '  ← Back', value: '__back' });

    const { action } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'action', message: 'What would you like to do?', choices: actionChoices }]);

    if (action === '__back') return;

    if (action === 'add') {
      const { svcName } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcName', message: 'Service name:', default: 'Code Review' }]);
      const { svcDesc } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcDesc', message: 'Description:' }]);
      const { svcPrice } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcPrice', message: 'Price:', default: '0.5' }]);
      const { svcCurrency } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcCurrency', message: 'Currency:', default: 'VRSCTEST' }]);
      const svcCategory = await pickCategory(inquirer, 'development');
      const { svcTurnaround } = await promptWithEsc(inquirer, [{ type: 'input', name: 'svcTurnaround', message: 'Turnaround:', default: '15 minutes' }]);
      const { svcSovguard } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'svcSovguard', message: 'Enable SovGuard?', default: true }]);

      try {
        const agent = await createAgent(keys);
        try {
          await agent.registerService({
            name: svcName,
            description: svcDesc,
            price: parseFloat(svcPrice),
            currency: svcCurrency,
            category: svcCategory,
            turnaround: svcTurnaround,
            paymentTerms: 'prepay',
            sovguard: svcSovguard,
          });
          console.log('\n  ✅ Service registered.\n');
        } finally { agent.stop(); }
      } catch (e) {
        console.log(`\n  ❌ Failed: ${e.message}\n`);
      }
      await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter to continue' }]);
      continue; // loop back to show updated list
    }

    if (action === 'edit') {
      const { svcIdx } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'svcIdx', message: 'Select service to edit:', choices: list.map((s, i) => ({ name: `  [${i + 1}] ${s.name} — ${s.price} ${s.currency}`, value: i })) }]);
      const svc = list[svcIdx];

      console.log(`\n  Editing: ${svc.name} (${svc.id})`);
      console.log('  Press Enter to keep current value.\n');

      const { newName } = await promptWithEsc(inquirer, [{ type: 'input', name: 'newName', message: 'Name:', default: svc.name }]);
      const { newDesc } = await promptWithEsc(inquirer, [{ type: 'input', name: 'newDesc', message: 'Description:', default: svc.description || '' }]);
      const { newPrice } = await promptWithEsc(inquirer, [{ type: 'input', name: 'newPrice', message: 'Price:', default: String(svc.price) }]);
      const newCategory = await pickCategory(inquirer, svc.category || 'development');
      const { newTurnaround } = await promptWithEsc(inquirer, [{ type: 'input', name: 'newTurnaround', message: 'Turnaround:', default: svc.turnaround || '15 minutes' }]);

      try {
        const agent = await createAgent(keys);
        try {
          await agent.client.updateService(svc.id, {
            name: newName,
            description: newDesc,
            price: parseFloat(newPrice),
            category: newCategory,
            turnaround: newTurnaround,
          });
          console.log('\n  ✅ Service updated.\n');
        } finally { agent.stop(); }
      } catch (e) {
        console.log(`\n  ❌ Failed: ${e.message}\n`);
      }
      await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter to continue' }]);
      continue;
    }

    if (action === 'delete') {
      const { svcIdx } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'svcIdx', message: 'Select service to delete:', choices: list.map((s, i) => ({ name: `  [${i + 1}] ${s.name} — ${s.price} ${s.currency}`, value: i })) }]);
      const svc = list[svcIdx];

      const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: `Delete "${svc.name}"? This cannot be undone.`, default: false }]);
      if (!confirm) continue;

      try {
        const agent = await createAgent(keys);
        try {
          await agent.client.deleteService(svc.id);
          console.log('\n  ✅ Service deleted.\n');
        } finally { agent.stop(); }
      } catch (e) {
        console.log(`\n  ❌ Failed: ${e.message}\n`);
      }
      await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter to continue' }]);
      continue;
    }
  }
}

// ── Per-Agent Executor Configuration ──

const EXECUTOR_DESCRIPTIONS = {
  'local-llm': 'Direct LLM API — call any OpenAI-compatible provider directly',
  'webhook':   'REST webhook — POST to n8n, Zapier, CrewAI, Dify, Flowise, or any HTTP endpoint',
  'langserve': 'LangChain Runnables — call a LangServe /invoke endpoint',
  'langgraph': 'LangGraph Platform — stateful threads + runs (Postgres-backed)',
  'a2a':       'Google Agent-to-Agent — JSON-RPC 2.0 tasks/send protocol',
  'mcp':       'MCP server + LLM — tool-calling agent loop with MCP tools',
};

function loadAgentConfig(agentId) {
  const configPath = path.join(AGENTS_DIR, agentId, 'agent-config.json');
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {}
  return {};
}

function saveAgentConfig(agentId, config) {
  const agentDir = path.join(AGENTS_DIR, agentId);
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(agentDir, 'agent-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

async function executorConfigScreen(inquirer) {
  const agents = getAgents();
  if (agents.length === 0) {
    console.log('\n  No agents registered. Add an agent first.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  // Select agent
  const { agentId } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'agentId', message: 'Select agent to configure:', choices: [
    ...agents.map(a => {
      const cfg = loadAgentConfig(a.id);
      const exec = cfg.executor || 'local-llm';
      const prov = cfg.llmProvider || loadEnv().J41_LLM_PROVIDER || '(global default)';
      const label = exec === 'local-llm' ? `${exec} → ${prov}` : exec;
      return { name: `  ${a.id.padEnd(10)} ${(a.identity || '').padEnd(28)} [${label}]`, value: a.id };
    }),
    new inquirer.Separator(),
    { name: '  ← Back', value: '__back' },
  ]}]);
  if (agentId === '__back') return;

  const config = loadAgentConfig(agentId);

  console.clear();
  const agentKeys = agents.find(a => a.id === agentId);
  console.log(`\n  ═══ Executor Config: ${agentKeys?.identity || agentId} ═══\n`);

  // Show current config
  if (Object.keys(config).length > 0) {
    console.log('  Current configuration:');
    if (config.executor) console.log(`    Executor:  ${config.executor}`);
    if (config.llmProvider) console.log(`    Provider:  ${config.llmProvider}`);
    if (config.llmModel) console.log(`    Model:     ${config.llmModel}`);
    if (config.executorUrl) console.log(`    URL:       ${config.executorUrl}`);
    if (config.mcpCommand) console.log(`    MCP cmd:   ${config.mcpCommand}`);
    if (config.mcpUrl) console.log(`    MCP URL:   ${config.mcpUrl}`);
    const hasKey = config.llmApiKey || config.executorAuth;
    if (hasKey) console.log(`    Auth:      ${hasKey.length > 12 ? '****' + hasKey.slice(-4) : '(set)'}`);
    console.log('');
  } else {
    console.log('  No per-agent config — using global defaults from .env\n');
  }

  // Select executor type
  const { executor } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'executor', message: 'Select executor type:', choices: [
    ...Object.entries(EXECUTOR_DESCRIPTIONS).map(([key, desc]) => ({
      name: `  ${key.padEnd(12)} ${desc}`,
      value: key,
    })),
    new inquirer.Separator(),
    { name: '  Reset to global defaults (remove per-agent config)', value: '__reset' },
    { name: '  ← Back (no change)', value: '__back' },
  ]}]);
  if (executor === '__back') return;

  if (executor === '__reset') {
    const configPath = path.join(AGENTS_DIR, agentId, 'agent-config.json');
    try { fs.unlinkSync(configPath); } catch {}
    console.log('\n  ✅ Per-agent config removed. Agent will use global .env defaults.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const newConfig = { executor };

  // ── Executor-specific config ──

  if (executor === 'local-llm' || executor === 'mcp') {
    // LLM provider selection
    await configureLLMProvider(inquirer, newConfig);
  }

  if (executor === 'webhook') {
    console.log('\n  Webhook tips:');
    console.log('    n8n:      use your n8n webhook trigger URL');
    console.log('    CrewAI:   use your crew kickoff API endpoint');
    console.log('    Dify:     use your Dify workflow API endpoint');
    console.log('    Flowise:  use your Flowise chatflow API endpoint');
    console.log('    Zapier:   use your Zapier webhook catch URL');
    console.log('    Custom:   any REST endpoint that accepts POST\n');
  }

  if (executor === 'webhook' || executor === 'langserve' || executor === 'langgraph' || executor === 'a2a') {
    const { url } = await promptWithEsc(inquirer, [{ type: 'input', name: 'url', message: 'Endpoint URL:', default: config.executorUrl || '' }]);
    if (!url) {
      console.log('\n  ❌ Endpoint URL is required for this executor.\n');
      await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      return;
    }
    newConfig.executorUrl = url;

    const { auth } = await promptWithEsc(inquirer, [{ type: 'password', name: 'auth', message: 'Authorization header (e.g. Bearer xxx, leave empty for none):', mask: '*', default: '' }]);
    if (auth) newConfig.executorAuth = auth;

    const { timeout } = await promptWithEsc(inquirer, [{ type: 'input', name: 'timeout', message: 'Timeout (ms):', default: executor === 'langgraph' || executor === 'a2a' ? '120000' : '60000' }]);
    newConfig.executorTimeout = timeout;
  }

  if (executor === 'langgraph') {
    const { assistant } = await promptWithEsc(inquirer, [{ type: 'input', name: 'assistant', message: 'Assistant ID:', default: config.executorAssistant || 'agent' }]);
    newConfig.executorAssistant = assistant;
  }

  if (executor === 'mcp') {
    const { transport } = await promptWithEsc(inquirer, [{ type: 'list', name: 'transport', message: 'MCP transport:', choices: [
      { name: '  stdio   — spawn a local process (e.g. node server.js)', value: 'stdio' },
      { name: '  http    — connect to a Streamable HTTP URL', value: 'http' },
    ]}]);

    if (transport === 'stdio') {
      const { cmd } = await promptWithEsc(inquirer, [{ type: 'input', name: 'cmd', message: 'Command to start MCP server:', default: config.mcpCommand || 'node mcp-server.js' }]);
      newConfig.mcpCommand = cmd;
    } else {
      const { url } = await promptWithEsc(inquirer, [{ type: 'input', name: 'url', message: 'MCP server URL:', default: config.mcpUrl || '' }]);
      newConfig.mcpUrl = url;
    }

    const { maxRounds } = await promptWithEsc(inquirer, [{ type: 'input', name: 'maxRounds', message: 'Max tool-calling rounds per message:', default: config.mcpMaxRounds || '10' }]);
    newConfig.mcpMaxRounds = maxRounds;
  }

  // ── Summary & confirm ──

  console.log('\n  ─── New Configuration ───');
  console.log(`    Executor:  ${newConfig.executor}`);
  if (newConfig.llmProvider) console.log(`    Provider:  ${newConfig.llmProvider}`);
  if (newConfig.llmModel) console.log(`    Model:     ${newConfig.llmModel}`);
  if (newConfig.executorUrl) console.log(`    URL:       ${newConfig.executorUrl}`);
  if (newConfig.mcpCommand) console.log(`    MCP cmd:   ${newConfig.mcpCommand}`);
  if (newConfig.mcpUrl) console.log(`    MCP URL:   ${newConfig.mcpUrl}`);
  if (newConfig.executorAssistant) console.log(`    Assistant: ${newConfig.executorAssistant}`);
  if (newConfig.llmApiKey) console.log(`    API Key:   ${newConfig.llmApiKey.length > 12 ? '****' + newConfig.llmApiKey.slice(-4) : '(set)'}`);
  if (newConfig.executorAuth) console.log(`    Auth:      ${newConfig.executorAuth.length > 12 ? '****' + newConfig.executorAuth.slice(-4) : '(set)'}`);
  console.log('');

  const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: 'Save this configuration?', default: true }]);
  if (!confirm) return;

  saveAgentConfig(agentId, newConfig);
  console.log(`\n  ✅ Saved to ~/.j41/dispatcher/agents/${agentId}/agent-config.json`);
  console.log('  Restart dispatcher to apply.\n');

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function configureLLMProvider(inquirer, config) {
  const { LLM_PRESETS } = require('./executors/local-llm.js');

  // Group providers by category for readability
  const openai = ['openai', 'openai-mini', 'openai-o3'];
  const claude = ['claude-opus', 'claude-sonnet', 'claude-haiku'];
  const google = ['gemini', 'gemini-flash'];
  const xai = ['grok'];
  const commercial = ['mistral', 'deepseek', 'cohere', 'perplexity'];
  const fast = ['groq', 'together', 'fireworks'];
  const enterprise = ['azure', 'nvidia'];
  const kimi = ['kimi', 'kimi-nvidia'];
  const routers = ['openrouter'];
  const local = ['ollama', 'lmstudio', 'vllm'];

  const makeChoice = (p) => {
    const preset = LLM_PRESETS[p];
    const keyLabel = preset.envKey ? `(${preset.envKey})` : '(no key needed)';
    return { name: `  ${p.padEnd(14)} ${(preset.model || '').padEnd(35)} ${keyLabel}`, value: p };
  };

  const { provider } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 30, name: 'provider', message: 'Select LLM provider:', choices: [
    new inquirer.Separator('  ── OpenAI ──'),
    ...openai.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Anthropic Claude (via OpenRouter) ──'),
    ...claude.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Google Gemini ──'),
    ...google.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── xAI ──'),
    ...xai.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Other Commercial ──'),
    ...commercial.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Fast Inference ──'),
    ...fast.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Enterprise ──'),
    ...enterprise.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Kimi / Moonshot ──'),
    ...kimi.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Multi-Provider Routers ──'),
    ...routers.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator('  ── Self-Hosted / Local ──'),
    ...local.filter(p => LLM_PRESETS[p]).map(makeChoice),
    new inquirer.Separator(),
    { name: '  custom        (set base URL + key manually)', value: 'custom' },
  ]}]);

  config.llmProvider = provider;
  const preset = LLM_PRESETS[provider] || {};

  // Provider-specific guidance
  if (provider === 'azure' && !preset.baseUrl) {
    console.log('\n  ⚠  Azure requires your deployment URL (e.g. https://YOUR.openai.azure.com/openai/deployments/YOUR-MODEL/v1)');
    console.log('     You must set the base URL below.\n');
  }

  // Prompt for API key using the provider's specific key name
  if (preset.envKey) {
    const { key } = await promptWithEsc(inquirer, [{ type: 'password', name: 'key', message: `${preset.envKey}:`, mask: '*' }]);
    if (key) config.llmApiKey = key;
  } else if (provider === 'custom') {
    const { baseUrl } = await promptWithEsc(inquirer, [{ type: 'input', name: 'baseUrl', message: 'Base URL (e.g. https://my-api.com/v1):' }]);
    if (baseUrl) config.llmBaseUrl = baseUrl;
    const { key } = await promptWithEsc(inquirer, [{ type: 'password', name: 'key', message: 'API Key (leave empty for none):', mask: '*' }]);
    if (key) config.llmApiKey = key;
  }
  // else: local providers (ollama, lmstudio, vllm) — no key needed

  // Model override
  const { model } = await promptWithEsc(inquirer, [{ type: 'input', name: 'model', message: 'Model (Enter for default):', default: preset.model || '' }]);
  if (model && model !== preset.model) config.llmModel = model;

  // Custom base URL override for non-custom providers
  if (provider !== 'custom' && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'vllm') {
    const { baseOverride } = await promptWithEsc(inquirer, [{ type: 'input', name: 'baseOverride', message: 'Base URL override (Enter for default):', default: '' }]);
    if (baseOverride) config.llmBaseUrl = baseOverride;
  }
}

async function retryRegisterScreen(inquirer, agentId, keys) {
  console.clear();
  console.log(`\n  ═══ Retry Registration: ${agentId} ═══\n`);
  console.log(`  R-Address: ${keys.address}`);
  console.log(`  Network:   ${keys.network || 'verustest'}\n`);

  // Check if we have a name from a previous attempt
  const keysPath = path.join(AGENTS_DIR, agentId, 'keys.json');
  const keysData = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  let identityName = keysData.identityName || keysData.pendingName || '';

  // Offer choice: recover existing (if name was already sent) or register fresh
  const { action } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'action', message: 'What happened?', choices: [
    { name: '  Registration timed out — name was already sent to J41 (recover it)', value: 'recover' },
    { name: '  Registration never started or name was rejected (register new)', value: 'register' },
    new inquirer.Separator(),
    { name: '  ← Back', value: '__back' },
  ]}]);

  if (action === '__back') return;

  if (action === 'recover') {
    if (!identityName) {
      const { name } = await promptWithEsc(inquirer, [{ type: 'input', name: 'name', message: 'What name did you register? (e.g. "myagent" for myagent.agentplatform@):' }]);
      if (!name) { console.log('\n  ❌ Name required.\n'); return; }
      identityName = name;
    }

    // Save the name to keys.json so the recover command can find it
    keysData.identity = identityName.includes('@') ? identityName : identityName + '.agentplatform@';
    keysData.registrationStatus = 'timeout';
    fs.writeFileSync(keysPath, JSON.stringify(keysData, null, 2));

    console.log(`\n  Recovering ${keysData.identity}...\n`);
    const exitCode = await runCommandAsync('node', ['src/cli.js', 'recover', agentId], REPO_DIR);

    if (exitCode === 0) {
      console.log('\n  ✅ Recovery successful!\n');
    } else {
      console.log(`\n  ❌ Recovery failed. The identity may not be on-chain yet.`);
      console.log('     Wait a few minutes and try again.\n');
    }
  } else {
    if (!identityName) {
      const { name } = await promptWithEsc(inquirer, [{ type: 'input', name: 'name', message: 'Identity name (lowercase, no spaces — becomes <name>.agentplatform@):' }]);
      if (!name) { console.log('\n  ❌ Name required.\n'); return; }
      identityName = name;
    } else {
      const { name } = await promptWithEsc(inquirer, [{ type: 'input', name: 'name', message: 'Identity name:', default: identityName }]);
      identityName = name;
    }

    const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: `Register ${identityName}.agentplatform@ on-chain?`, default: true }]);
    if (!confirm) return;

    // Save pending name so we can recover later if it times out
    keysData.pendingName = identityName;
    fs.writeFileSync(keysPath, JSON.stringify(keysData, null, 2));

    console.log('');
    console.log('  ℹ️  Registration waits for block confirmations (can take 5-20 min).');
    console.log('  Press Ctrl+C to return to menu — registration continues on the platform.\n');
    const exitCode = await runCommandAsync('node', ['src/cli.js', 'register', agentId, identityName], REPO_DIR);

    if (exitCode === 0) {
      console.log('\n  ✅ Registration successful!\n');
    } else if (exitCode === null) {
      console.log('\n  ⚠️  Interrupted. Registration may still be processing on the platform.');
      console.log('     Use "Retry Registration" → "recover" to check on it.\n');
    } else {
      console.log(`\n  ❌ Registration failed (exit ${exitCode}).`);
      console.log('     If the name was already committed, use "recover" instead of "register new".\n');
    }
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function retryFinalizeScreen(inquirer, agentId) {
  console.clear();
  console.log(`\n  ═══ Retry Finalize: ${agentId} ═══\n`);

  console.log('  Resuming finalization...\n');
  const exitCode = await runCommandAsync('node', ['src/cli.js', 'finalize', agentId, '--interactive'], REPO_DIR);

  if (exitCode === 0) {
    console.log('\n  ✅ Finalize complete!\n');
  } else {
    console.log(`\n  ❌ Finalize failed (exit ${exitCode}).`);
    console.log('     You can retry again later.\n');
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function securityScreen(inquirer) {
  console.clear();
  console.log('\n  ═══ Security Setup ═══\n');

  // Check current security status
  try {
    const secureSetup = require('@junction41/secure-setup');
    const isolation = await secureSetup.detectIsolation();
    const platform = await secureSetup.detectPlatform();

    console.log(`  Platform:    ${platform.os} ${platform.arch} ${platform.distro || ''}`);
    console.log(`  Docker:      ${platform.hasDocker ? 'yes' : 'no'}`);
    console.log(`  KVM:         ${platform.hasKVM ? 'yes' : 'no'}`);
    console.log(`  gVisor:      ${isolation.gvisorInstalled ? 'installed' + (isolation.gvisorDefault ? ' (default runtime)' : '') : 'not installed'}`);
    console.log(`  Bubblewrap:  ${isolation.bwrapInstalled ? 'installed' : 'not installed'}`);
    console.log(`  Seccomp:     ${isolation.seccompProfilesDeployed ? 'profiles deployed' : 'not deployed'}`);
    console.log(`  Score:       ${isolation.score}/10 (${isolation.mode})`);
    console.log('');

    if (isolation.score < 8) {
      console.log('  ⚠️  Security score below 8 — consider running setup to improve.\n');
    } else {
      console.log('  ✅ Security is properly configured.\n');
    }
  } catch (e) {
    console.log(`  @junction41/secure-setup not available: ${e.message}`);
    console.log('  Install: yarn add @junction41/secure-setup\n');
  }

  const { action } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'action', message: 'Options:', choices: [
    { name: '  Run security setup (install/update profiles)', value: 'setup' },
    { name: '  Run self-test (container escape attempts)', value: 'test' },
    { name: '  Check profile integrity', value: 'check' },
    { name: '  ← Back', value: '__back' },
  ]}]);

  if (action === '__back') return;

  try {
    const secureSetup = require('@junction41/secure-setup');
    switch (action) {
      case 'setup': {
        console.log('\n  Running security setup...\n');
        const setupResult = await secureSetup.setup('dispatcher');
        if (setupResult.success) {
          console.log('  ✅ Setup complete. Score: ' + setupResult.score + '/10 (' + setupResult.mode + ')');
        } else {
          console.log('  ❌ Setup had issues. Score: ' + setupResult.score + '/10');
        }
        if (setupResult.log && setupResult.log.length > 0) {
          console.log('');
          for (const line of setupResult.log) console.log('  ' + line);
        }
        break;
      }
      case 'test': {
        console.log('\n  Running self-test...\n');
        const testResult = await secureSetup.selfTest('dispatcher');
        for (const t of (testResult.results || [])) {
          console.log((t.passed ? '  ✅' : '  ❌') + ' ' + t.name + (t.error ? ': ' + t.error : ''));
        }
        console.log('\n  Score: ' + testResult.score + '/10 (' + testResult.mode + ')');
        console.log('  ' + (testResult.passed ? '✅ All tests passed' : '❌ Some tests failed'));
        break;
      }
      case 'check': {
        console.log('\n  Checking profiles...\n');
        const checkResult = await secureSetup.quickCheck('dispatcher');
        for (const c of (checkResult.checks || [])) {
          const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️ ' : c.status === 'skip' ? '⏭️ ' : '❌';
          console.log('  ' + icon + ' ' + c.name + ': ' + c.detail);
        }
        console.log('\n  Score: ' + checkResult.score + '/10 (' + checkResult.mode + ')');
        break;
      }
    }
  } catch (e) {
    console.log(`\n  Error: ${e.message}`);
  }

  console.log('');
  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function llmScreen(inquirer) {
  console.clear();
  console.log(`\n  ═══ LLM Provider Configuration ═══\n`);

  const env = loadEnv();
  console.log(`  Current: ${env.J41_LLM_PROVIDER || '(not set)'}`);
  console.log(`  API Key: ${env.KIMI_API_KEY ? '****' + env.KIMI_API_KEY.slice(-8) : '(not set)'}\n`);

  try {
    const { LLM_PRESETS } = require('./executors/local-llm.js');
    const providers = Object.keys(LLM_PRESETS);

    const { provider } = await promptWithEsc(inquirer, [{
      type: 'list', pageSize: 20,
      name: 'provider',
      message: 'Select LLM provider:',
      choices: [
        ...providers.map(p => {
          const preset = LLM_PRESETS[p];
          const current = env.J41_LLM_PROVIDER === p ? ' ◄ current' : '';
          return { name: `  ${p.padEnd(14)} ${(preset.model || '').padEnd(40)} ${preset.envKey || ''}${current}`, value: p };
        }),
        new inquirer.Separator(),
        { name: '  ← Back (no change)', value: '__back' },
      ],
    }]);

    if (provider === '__back') return;

    const preset = LLM_PRESETS[provider];
    let apiKey = env[preset.envKey] || '';

    if (preset.envKey && !apiKey) {
      const { key } = await promptWithEsc(inquirer, [{
        type: 'password',
        name: 'key',
        message: `Enter API key for ${provider} (${preset.envKey}):`,
        mask: '*',
      }]);
      apiKey = key;
    }

    // Write to .env
    let envContent = '';
    try { envContent = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
    // Update or add provider
    if (envContent.includes('J41_LLM_PROVIDER=')) {
      envContent = envContent.replace(/J41_LLM_PROVIDER=.*/, `J41_LLM_PROVIDER=${provider}`);
    } else {
      envContent += `\nJ41_LLM_PROVIDER=${provider}`;
    }
    // Update or add API key
    if (preset.envKey && apiKey) {
      if (envContent.includes(`${preset.envKey}=`)) {
        envContent = envContent.replace(new RegExp(`${preset.envKey}=.*`), `${preset.envKey}=${apiKey}`);
      } else {
        envContent += `\n${preset.envKey}=${apiKey}`;
      }
    }
    fs.writeFileSync(ENV_FILE, envContent.trim() + '\n');
    console.log(`\n  ✅ Updated .env — provider: ${provider}`);
    console.log(`  Restart dispatcher to apply.\n`);
  } catch (e) {
    console.log(`  Error: ${e.message}\n`);
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

// ── Bounties ──

async function bountiesMenuScreen(inquirer) {
  while (true) {
    console.clear();
    console.log('\n  ═══ Bounties ═══\n');

    const { action } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'action', message: 'What would you like to do?', choices: [
      { name: '  Browse open bounties', value: 'browse' },
      { name: '  Post a bounty', value: 'post' },
      { name: '  My bounties (posted & applied)', value: 'mine' },
      new inquirer.Separator(),
      { name: '  ← Back', value: '__back' },
    ]}]);

    if (action === '__back') return;

    switch (action) {
      case 'browse': await browseBountiesScreen(inquirer); break;
      case 'post': await postBountyScreen(inquirer); break;
      case 'mine': await myBountiesScreen(inquirer); break;
    }
  }
}

async function browseBountiesScreen(inquirer) {
  console.clear();
  console.log('\n  ═══ Open Bounties ═══\n');

  const agents = getAgents();
  if (agents.length === 0) {
    console.log('  No agents registered. Add an agent first.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  let bounties = [];
  try {
    const agent = await createAgent(agents[0]);
    try {
      const result = await agent.client.getBounties({ limit: 20 });
      bounties = result.data || result || [];
    } finally { agent.stop(); }
  } catch (e) {
    console.log(`  Error fetching bounties: ${e.message}\n`);
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  if (bounties.length === 0) {
    console.log('  No open bounties found.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const choices = bounties.map(b => {
    const apps = b.applications?.length || 0;
    const amt = `${b.amount} ${b.currency || 'VRSC'}`;
    return {
      name: `  ${(b.title || b.description?.substring(0, 30) || b.id).padEnd(32)} ${amt.padEnd(16)} ${(b.category || '').padEnd(14)} ${apps} applicants`,
      value: b.id,
    };
  });
  choices.push(new inquirer.Separator());
  choices.push({ name: '  ← Back', value: '__back' });

  const { bountyId } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'bountyId', message: 'Select a bounty to view:', choices }]);
  if (bountyId === '__back') return;

  await bountyDetailScreen(inquirer, bountyId, agents[0]);
}

async function postBountyScreen(inquirer) {
  console.clear();
  console.log('\n  ═══ Post a Bounty ═══\n');

  const agents = getAgents().filter(a => a.identity && a.iAddress);
  if (agents.length === 0) {
    console.log('  No registered agents. Register an agent first.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  // Pick which agent posts the bounty
  const { agentId } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'agentId', message: 'Post as which agent?', choices: agents.map(a => ({ name: `  ${a.id.padEnd(10)} ${a.identity}`, value: a.id })) }]);
  const agentKeys = agents.find(a => a.id === agentId);

  const { title } = await promptWithEsc(inquirer, [{ type: 'input', name: 'title', message: 'Bounty title:' }]);
  if (!title) { console.log('\n  Title required.\n'); return; }

  const { description } = await promptWithEsc(inquirer, [{ type: 'input', name: 'description', message: 'What do you need done?' }]);
  const { amount } = await promptWithEsc(inquirer, [{ type: 'input', name: 'amount', message: 'Bounty amount:', default: '1' }]);
  const { currency } = await promptWithEsc(inquirer, [{ type: 'input', name: 'currency', message: 'Currency:', default: 'VRSCTEST' }]);
  const category = await pickCategory(inquirer, 'development');
  const { maxClaimants } = await promptWithEsc(inquirer, [{ type: 'input', name: 'maxClaimants', message: 'Max winners (how many people can claim this):', default: '1' }]);
  const { deadline } = await promptWithEsc(inquirer, [{ type: 'input', name: 'deadline', message: 'Application deadline (YYYY-MM-DD or leave blank):' }]);

  // Validate deadline if provided
  if (deadline) {
    const d = new Date(deadline);
    if (isNaN(d.getTime())) {
      console.log('\n  Invalid date format. Use YYYY-MM-DD.\n');
      await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      return;
    }
  }

  console.log('\n  ─── Bounty Summary ───');
  console.log(`  Title:     ${title}`);
  console.log(`  Amount:    ${amount} ${currency}`);
  console.log(`  Category:  ${category}`);
  console.log(`  Max winners: ${maxClaimants}`);
  if (deadline) console.log(`  Deadline:  ${deadline}`);
  if (description) console.log(`  Description: ${description.substring(0, 80)}`);
  console.log('');

  const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: 'Post this bounty?', default: true }]);
  if (!confirm) return;

  try {
    const agent = await createAgent(agentKeys);
    try {
      const result = await agent.postBounty({
        title,
        description: description || title,
        amount: parseFloat(amount),
        currency,
        category,
        maxClaimants: parseInt(maxClaimants) || 1,
        ...(deadline ? { applicationDeadline: new Date(deadline).toISOString() } : {}),
      });
      console.log(`\n  ✅ Bounty posted!`);
      console.log(`  ID: ${result.id || result.bountyId || JSON.stringify(result).substring(0, 80)}\n`);
    } finally { agent.stop(); }
  } catch (e) {
    console.log(`\n  ❌ Failed: ${e.message}\n`);
  }

  await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
}

async function myBountiesScreen(inquirer) {
  console.clear();
  console.log('\n  ═══ My Bounties ═══\n');

  const agents = getAgents().filter(a => a.identity && a.iAddress);
  if (agents.length === 0) {
    console.log('  No registered agents.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const { agentId } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'agentId', message: 'View bounties for:', choices: agents.map(a => ({ name: `  ${a.id.padEnd(10)} ${a.identity}`, value: a.id })) }]);
  const agentKeys = agents.find(a => a.id === agentId);

  let posted = [], applied = [];
  try {
    const agent = await createAgent(agentKeys);
    try {
      const [postedRes, appliedRes] = await Promise.all([
        agent.client.getMyBounties({ role: 'poster', limit: 20 }).catch(() => ({ data: [] })),
        agent.client.getMyBounties({ role: 'applicant', limit: 20 }).catch(() => ({ data: [] })),
      ]);
      posted = postedRes.data || postedRes || [];
      applied = appliedRes.data || appliedRes || [];
    } finally { agent.stop(); }
  } catch (e) {
    console.log(`  Error: ${e.message}\n`);
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  if (posted.length === 0 && applied.length === 0) {
    console.log('  No bounties found for this agent.\n');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  const choices = [];
  if (posted.length > 0) {
    choices.push(new inquirer.Separator('  ── Posted by you ──'));
    for (const b of posted) {
      const apps = b.applications?.length || 0;
      choices.push({ name: `  ${(b.title || b.id).padEnd(30)} ${b.amount} ${b.currency || 'VRSC'}  (${b.status}, ${apps} applicants)`, value: b.id });
    }
  }
  if (applied.length > 0) {
    choices.push(new inquirer.Separator('  ── Applied to ──'));
    for (const b of applied) {
      choices.push({ name: `  ${(b.title || b.id).padEnd(30)} ${b.amount} ${b.currency || 'VRSC'}  (${b.status})`, value: b.id });
    }
  }
  choices.push(new inquirer.Separator());
  choices.push({ name: '  ← Back', value: '__back' });

  const { bountyId } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'bountyId', message: 'Select a bounty:', choices }]);
  if (bountyId === '__back') return;

  await bountyDetailScreen(inquirer, bountyId, agentKeys);
}

async function bountyDetailScreen(inquirer, bountyId, agentKeys) {
  console.clear();
  console.log('\n  ═══ Bounty Detail ═══\n');

  let bounty;
  try {
    const agent = await createAgent(agentKeys);
    try {
      bounty = await agent.client.getBounty(bountyId);
      if (bounty.data) bounty = bounty.data;
    } finally { agent.stop(); }
  } catch (e) {
    console.log(`  Error: ${e.message}\n`);
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
    return;
  }

  console.log(`  Title:       ${bounty.title || '(none)'}`);
  console.log(`  Amount:      ${bounty.amount} ${bounty.currency || 'VRSC'}`);
  console.log(`  Status:      ${bounty.status}`);
  console.log(`  Category:    ${bounty.category || '(none)'}`);
  console.log(`  Posted by:   ${bounty.poster_verus_id || bounty.posterVerusId || '?'}`);
  console.log(`  Max winners: ${bounty.max_claimants || bounty.maxClaimants || 1}`);
  if (bounty.application_deadline || bounty.applicationDeadline) {
    console.log(`  Deadline:    ${bounty.application_deadline || bounty.applicationDeadline}`);
  }
  console.log(`  ID:          ${bounty.id}`);
  if (bounty.description) {
    console.log(`\n  Description:\n  ${bounty.description}`);
  }

  const applications = bounty.applications || [];
  if (applications.length > 0) {
    console.log(`\n  ── Applicants (${applications.length}) ──`);
    for (const app of applications) {
      const selected = app.selected ? ' ✅' : '';
      console.log(`  • ${app.applicant_verus_id || app.applicantVerusId}${selected}`);
      if (app.message) console.log(`    "${app.message.substring(0, 60)}"`);
    }
  }
  console.log('');

  // Build action menu based on context
  const posterAddr = bounty.poster_verus_id || bounty.posterVerusId;
  const isPoster = agentKeys.iAddress && posterAddr === agentKeys.iAddress;

  const actionChoices = [];
  if (isPoster && applications.length > 0 && bounty.status === 'open') {
    actionChoices.push({ name: '  Select winners', value: 'select' });
  }
  if (isPoster && (bounty.status === 'open' || bounty.status === 'active')) {
    actionChoices.push({ name: '  Cancel bounty', value: 'cancel' });
  }
  actionChoices.push(new inquirer.Separator());
  actionChoices.push({ name: '  ← Back', value: '__back' });

  const { action } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 10, name: 'action', message: 'Options:', choices: actionChoices }]);
  if (action === '__back') return;

  if (action === 'select') {
    // Checkbox to select winners
    const appChoices = applications.map(app => ({
      name: `  ${app.applicant_verus_id || app.applicantVerusId} — ${(app.message || '').substring(0, 50)}`,
      value: app.id,
    }));

    const { selectedIds } = await promptWithEsc(inquirer, [{ type: 'checkbox', pageSize: 20, name: 'selectedIds', message: 'Select winners (space to toggle, enter to confirm):', choices: appChoices }]);

    if (!selectedIds || selectedIds.length === 0) {
      console.log('\n  No winners selected.\n');
      await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      return;
    }

    const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: `Select ${selectedIds.length} winner(s)? This creates jobs for each.`, default: true }]);
    if (!confirm) return;

    try {
      const { buildSelectClaimantsMessage, signMessage } = require('@junction41/sovagent-sdk');
      const timestamp = Math.floor(Date.now() / 1000);
      const msg = buildSelectClaimantsMessage(bountyId, selectedIds, timestamp);
      const signature = signMessage(agentKeys.wif, msg, agentKeys.network || 'verustest');

      const agent = await createAgent(agentKeys);
      try {
        const result = await agent.client.selectBountyClaimants(bountyId, { applicantIds: selectedIds, signature, timestamp });
        console.log(`\n  ✅ Winners selected!`);
        if (result.jobsCreated) {
          console.log(`  Jobs created: ${result.jobsCreated.map(j => j.id || j).join(', ')}`);
        }
      } finally { agent.stop(); }
    } catch (e) {
      console.log(`\n  ❌ Failed: ${e.message}`);
    }
    console.log('');
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
  }

  if (action === 'cancel') {
    const { confirm } = await promptWithEsc(inquirer, [{ type: 'confirm', name: 'confirm', message: 'Cancel this bounty? This cannot be undone.', default: false }]);
    if (!confirm) return;

    try {
      const agent = await createAgent(agentKeys);
      try {
        await agent.cancelBounty(bountyId);
        console.log('\n  ✅ Bounty cancelled.\n');
      } finally { agent.stop(); }
    } catch (e) {
      console.log(`\n  ❌ Failed: ${e.message}\n`);
    }
    await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
  }
}

// ── Main Loop ──

async function main() {
  // inquirer v9 is ESM-only, use dynamic import
  const mod = await import('inquirer');
  const inquirer = mod.default || mod;

  while (true) {
    let choice;
    try { choice = await mainMenu(inquirer); } catch (e) { if (e === BACK) continue; throw e; }

    switch (choice) {
      case 'agents': await withBack(() => agentListScreen(inquirer)); break;
      case 'add': await withBack(() => addAgentScreen(inquirer)); break;
      case 'executor': await withBack(() => executorConfigScreen(inquirer)); break;
      case 'llm': await withBack(() => llmScreen(inquirer)); break;
      case 'services': await withBack(() => configureServicesScreen(inquirer)); break;
      case 'security': await withBack(() => securityScreen(inquirer)); break;
      case 'start': await withBack(async () => {
        const status = getDispatcherStatus();
        if (status.running) {
          console.log(`\n  Dispatcher already running (PID ${status.pid})\n`);
        } else {
          const { spawn } = require('child_process');
          const child = spawn('node', ['src/cli.js', 'start'], {
            cwd: REPO_DIR,
            detached: true,
            stdio: ['ignore', fs.openSync('/tmp/dispatcher.log', 'a'), fs.openSync('/tmp/dispatcher.log', 'a')],
          });
          child.unref();
          console.log(`\n  ✅ Dispatcher started (PID ${child.pid})\n  Logs: tail -f /tmp/dispatcher.log\n`);
        }
        await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      }); break;
      case 'stop': await withBack(async () => {
        const status = getDispatcherStatus();
        if (!status.running) {
          console.log('\n  Dispatcher is not running.\n');
        } else {
          try {
            process.kill(status.pid, 'SIGTERM');
            console.log(`\n  ✅ Sent SIGTERM to dispatcher (PID ${status.pid})`);
            console.log('  Dispatcher will drain active jobs and shut down gracefully.\n');
          } catch (e) {
            console.log(`\n  Failed to stop: ${e.message}\n`);
          }
        }
        await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      }); break;
      case 'logs': {
        console.clear();
        console.log('\n  ═══ Dispatcher Logs ═══\n');
        if (!fs.existsSync('/tmp/dispatcher.log')) {
          console.log('  No log file found. Start the dispatcher first.\n');
          await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
          break;
        }
        console.log('  Streaming /tmp/dispatcher.log — press Ctrl+C to stop\n');
        const { spawn } = require('child_process');
        const tail = spawn('tail', ['-f', '-n', '40', '/tmp/dispatcher.log'], { stdio: 'inherit' });
        let resolved = false;
        await new Promise((resolve) => {
          const done = () => { if (resolved) return; resolved = true; process.removeListener('SIGINT', handler); resolve(); };
          const handler = () => { tail.kill(); done(); };
          tail.on('close', done);
          process.on('SIGINT', handler);
        });
        break;
      }
      case 'status': await withBack(() => statusScreen(inquirer)); break;
      case 'inspect': await withBack(async () => {
        const agents = getAgents();
        if (agents.length === 0) { console.log('\n  No agents.\n'); return; }
        const { id } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'id', message: 'Select agent to inspect:', choices: agents.map(a => ({ name: `  ${a.id.padEnd(10)} ${a.identity}`, value: a.id })) }]);
        const keys = agents.find(a => a.id === id);
        if (keys) await vdxfScreen(inquirer, keys);
      }); break;
      case 'inbox': await withBack(async () => {
        const agents = getAgents();
        if (agents.length === 0) { console.log('\n  No agents.\n'); return; }
        const { id } = await promptWithEsc(inquirer, [{ type: 'list', pageSize: 20, name: 'id', message: 'Check inbox for:', choices: agents.map(a => ({ name: `  ${a.id.padEnd(10)} ${a.identity}`, value: a.id })) }]);
        const keys = agents.find(a => a.id === id);
        if (!keys) return;
        console.clear();
        console.log(`\n  ═══ Inbox: ${keys.identity} ═══\n`);
        try {
          const agent = await createAgent(keys);
          let inbox;
          try { inbox = await agent.client.getInbox('pending', 20); } finally { agent.stop(); }
          const items = inbox.data || [];
          if (items.length === 0) { console.log('  (no pending items)\n'); }
          else {
            console.log(`  ${'Type'.padEnd(16)} ${'ID'.padEnd(10)} Status`);
            console.log(`  ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
            for (const i of items) console.log(`  ${(i.type || '?').padEnd(16)} ${i.id.substring(0,8).padEnd(10)} ${i.status}`);
            console.log(`\n  Total: ${items.length} pending`);
          }
        } catch(e) { console.log(`  Error: ${e.message}`); }
        console.log('');
        await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      }); break;
      case 'earnings': await withBack(async () => {
        console.clear();
        console.log('\n  ═══ Earnings Summary ═══\n');
        const agents = getAgents();
        for (const a of agents) {
          try {
            const agent = await createAgent(a);
            let bal, result;
            try { bal = await agent.client.getBalance(); result = await agent.client.getMyJobs({ role: 'seller' }); } finally { agent.stop(); }
            const completed = (result.data || []).filter(j => j.status === 'completed' || j.status === 'delivered');
            const total = completed.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);
            const balances = bal.balances || (bal.balance != null ? [{ amount: bal.balance, currency: bal.currency || 'VRSCTEST' }] : []);
            const balStr = balances.map(b => `${b.amount} ${b.currency}`).join(', ') || '0';
            console.log(`  ${a.id.padEnd(10)} ${(a.identity || '').padEnd(30)} Balance: ${balStr.padEnd(20)} Jobs: ${completed.length} (${total.toFixed(2)} earned)`);
          } catch(e) {
            console.log(`  ${a.id.padEnd(10)} ${(a.identity || '').padEnd(30)} Error: ${e.message.substring(0, 40)}`);
          }
        }
        console.log('');
        await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      }); break;
      case 'docker': await withBack(async () => {
        console.clear();
        console.log('\n  ═══ Docker Containers ═══\n');
        try {
          const out = require('child_process').execSync('docker ps -a --filter name=j41-job --format "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}"', { encoding: 'utf8', timeout: 5000 });
          console.log(out || '  (no j41 containers)\n');
        } catch(e) { console.log(`  Error: ${e.message}`); }
        console.log('');
        await promptWithEsc(inquirer, [{ type: 'input', name: 'ok', message: 'Press Enter or ESC to go back' }]);
      }); break;
      case 'bounties': await withBack(() => bountiesMenuScreen(inquirer)); break;
      case 'quit': process.exit(0);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
