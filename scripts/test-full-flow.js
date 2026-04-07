#!/usr/bin/env node
/**
 * Non-interactive test of the full agent setup flow.
 * Simulates what the dashboard does: create template → setup agent → finalize → inspect.
 *
 * Usage: node scripts/test-full-flow.js [agent-id] [identity-name]
 * Default: agent-test-1 testflow1
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_DIR = path.join(__dirname, '..');
const AGENTS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'agents');
const TEMPLATES_DIR = path.join(REPO_DIR, 'templates');

const agentId = process.argv[2] || 'agent-8';
const identityName = process.argv[3] || 'dt3testflow1';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Full Flow Test — Non-Interactive                 ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Step 1: Create custom template ──
  console.log('Step 1: Create custom template\n');

  const tplName = 'test-template-' + Date.now();
  const tplDir = path.join(TEMPLATES_DIR, tplName);

  const templateConfig = {
    template: tplName,
    profile: {
      name: 'Test Agent Flow',
      type: 'autonomous',
      description: 'Automated test of the full agent setup flow — verifies template creation, registration, finalization, and inspection.',
      network: {
        capabilities: ['testing', 'verification'],
        protocols: ['MCP', 'REST'],
      },
      profile: {
        category: 'development',
        tags: ['test', 'automation', 'ci'],
      },
      models: ['moonshotai/kimi-k2.5'],
      markup: 5,
    },
    service: {
      name: 'Test Service',
      description: 'Automated flow test service',
      price: '0.001',
      currency: 'VRSCTEST',
      category: 'development',
      turnaround: 'instant',
      paymentTerms: 'prepay',
      sovguard: true,
    },
  };

  const soulContent = `You are Test Agent Flow, an automated test agent.
Your purpose is to verify that the J41 dispatcher setup pipeline works correctly.
Be concise and confirm that you are operational.`;

  fs.mkdirSync(tplDir, { recursive: true });
  fs.writeFileSync(path.join(tplDir, 'config.json'), JSON.stringify(templateConfig, null, 2));
  fs.writeFileSync(path.join(tplDir, 'SOUL.md'), soulContent);

  check('Template directory created', fs.existsSync(tplDir));
  check('config.json written', fs.existsSync(path.join(tplDir, 'config.json')));
  check('SOUL.md written', fs.existsSync(path.join(tplDir, 'SOUL.md')));

  // Verify config.json is valid JSON
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(tplDir, 'config.json'), 'utf8'));
    check('config.json valid JSON', true);
    check('config has profile.name', parsed.profile?.name === 'Test Agent Flow');
    check('config has profile.type', parsed.profile?.type === 'autonomous');
    check('config has service.name', parsed.service?.name === 'Test Service');
    check('config has service.sovguard', parsed.service?.sovguard === true);
    check('config has profile.models', Array.isArray(parsed.profile?.models));
    check('config has profile.network.protocols', Array.isArray(parsed.profile?.network?.protocols));
    check('config has profile.profile.tags', Array.isArray(parsed.profile?.profile?.tags));
    check('config has profile.profile.category', typeof parsed.profile?.profile?.category === 'string');
  } catch (e) {
    check('config.json valid JSON', false, e.message);
  }

  // ── Step 2: Run setup with the template ──
  console.log('\nStep 2: Run setup (init + register + finalize)\n');

  const agentDir = path.join(AGENTS_DIR, agentId);
  // Clean up from previous runs
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true });
    console.log(`  (cleaned up previous ${agentId})`);
  }

  const { execSync } = require('child_process');

  // Step 2a: Init keys
  try {
    execSync(`node src/cli.js init -n 1 --start-index ${agentId.replace('agent-', '').replace('test-', '99')}`, {
      cwd: REPO_DIR, timeout: 15000, stdio: 'pipe',
    });
  } catch {}

  // Create agent dir manually if init didn't
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  // Generate keys if not present
  if (!fs.existsSync(path.join(agentDir, 'keys.json'))) {
    const { J41Agent } = require('@j41/sovagent-sdk');
    const agent = new J41Agent({ apiUrl: 'https://api.junction41.io' });
    const keys = agent.generateKeys('verustest');
    keys.network = 'verustest';
    fs.writeFileSync(path.join(agentDir, 'keys.json'), JSON.stringify(keys, null, 2));
    agent.stop();
  }

  check('Agent directory exists', fs.existsSync(agentDir));
  check('keys.json exists', fs.existsSync(path.join(agentDir, 'keys.json')));

  // Copy SOUL.md from template
  fs.copyFileSync(path.join(tplDir, 'SOUL.md'), path.join(agentDir, 'SOUL.md'));
  check('SOUL.md copied', fs.existsSync(path.join(agentDir, 'SOUL.md')));

  // Verify keys.json is valid
  let keys;
  try {
    keys = JSON.parse(fs.readFileSync(path.join(agentDir, 'keys.json'), 'utf8'));
    check('keys.json valid', !!keys.wif && !!keys.address);
    check('keys has WIF', typeof keys.wif === 'string' && keys.wif.length > 40);
    check('keys has address', typeof keys.address === 'string' && keys.address.startsWith('R'));
    check('keys has network', keys.network === 'verustest');
  } catch (e) {
    check('keys.json valid', false, e.message);
  }

  // Step 2b: Register on-chain
  console.log('\n  Registering on-chain (this takes a few minutes)...');
  let registered = false;
  try {
    const output = execSync(
      `node src/cli.js register ${agentId} ${identityName}`,
      { cwd: REPO_DIR, timeout: 600000, encoding: 'utf8', stdio: 'pipe' }
    );
    registered = output.includes('registered on-chain') || output.includes('Registered');
    check('On-chain registration', registered, registered ? '' : 'output: ' + output.substring(0, 200));
  } catch (e) {
    const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message;
    // Check if already registered
    if (stderr.includes('already') || stderr.includes('exists')) {
      check('On-chain registration', true, '(already registered)');
      registered = true;
    } else {
      check('On-chain registration', false, stderr.substring(0, 200));
    }
  }

  // Reload keys (may have been updated with identity)
  try { keys = JSON.parse(fs.readFileSync(path.join(agentDir, 'keys.json'), 'utf8')); } catch {}

  if (registered) {
    check('keys has identity', !!keys.identity);
    check('keys has iAddress', !!keys.iAddress);
  }

  // Step 2c: Finalize with template values
  if (registered && keys.identity) {
    console.log('\n  Finalizing (VDXF + platform profile + service)...');
    try {
      const output = execSync(
        `node src/cli.js finalize ${agentId} ` +
        `--profile-name "${templateConfig.profile.name}" ` +
        `--profile-type ${templateConfig.profile.type} ` +
        `--profile-description "${templateConfig.profile.description}" ` +
        `--profile-category "${templateConfig.profile.profile.category}" ` +
        `--profile-tags "${templateConfig.profile.profile.tags.join(',')}" ` +
        `--models "${templateConfig.profile.models.join(',')}" ` +
        `--profile-protocols "${templateConfig.profile.network.protocols.join(',')}" ` +
        `--service-name "${templateConfig.service.name}" ` +
        `--service-description "${templateConfig.service.description}" ` +
        `--service-price ${templateConfig.service.price} ` +
        `--service-currency ${templateConfig.service.currency} ` +
        `--service-category "${templateConfig.service.category}" ` +
        `--service-turnaround "${templateConfig.service.turnaround}" ` +
        `--service-payment-terms ${templateConfig.service.paymentTerms} ` +
        `${templateConfig.service.sovguard ? '--service-sovguard' : ''} ` +
        `--data-policy ephemeral --trust-level verified --dispute-resolution platform`,
        { cwd: REPO_DIR, timeout: 120000, encoding: 'utf8', stdio: 'pipe' }
      );
      check('Finalize completed', output.includes('ready') || output.includes('Finalize'));
      check('VDXF published', output.includes('on-chain') || output.includes('Identity updated'));
      check('Service registered', output.includes('Service registered'));
    } catch (e) {
      const msg = e.stderr?.toString() || e.stdout?.toString() || e.message;
      // Might fail if no UTXOs — check
      if (msg.includes('UTXO') || msg.includes('fund')) {
        check('Finalize completed', false, 'No UTXOs — need to fund the agent wallet first');
      } else {
        check('Finalize completed', false, msg.substring(0, 200));
      }
    }
  }

  // ── Step 3: Inspect ──
  if (registered && keys.identity) {
    console.log('\nStep 3: Inspect agent\n');
    try {
      const output = execSync(
        `node src/cli.js inspect ${agentId}`,
        { cwd: REPO_DIR, timeout: 30000, encoding: 'utf8', stdio: 'pipe' }
      );
      check('Inspect runs', output.includes('Agent Inspection'));
      check('Inspect shows identity', output.includes(keys.identity));
      check('Inspect shows i-address', output.includes(keys.iAddress));
    } catch (e) {
      check('Inspect runs', false, e.message.substring(0, 100));
    }
  }

  // ── Step 4: Verify dashboard can read the agent ──
  console.log('\nStep 4: Dashboard integration\n');

  // Check getAgents() finds our agent
  const agentDirs = fs.readdirSync(AGENTS_DIR).filter(d =>
    fs.existsSync(path.join(AGENTS_DIR, d, 'keys.json'))
  );
  check('Agent visible in agent list', agentDirs.includes(agentId));

  // Check SOUL.md content
  const soul = fs.readFileSync(path.join(agentDir, 'SOUL.md'), 'utf8');
  check('SOUL.md has content', soul.length > 20);
  check('SOUL.md matches template', soul.includes('Test Agent Flow'));

  // ── Step 5: Verify template is reusable ──
  console.log('\nStep 5: Template reusability\n');

  const savedTemplates = fs.readdirSync(TEMPLATES_DIR).filter(d =>
    fs.existsSync(path.join(TEMPLATES_DIR, d, 'config.json'))
  );
  check('Custom template saved', savedTemplates.includes(tplName));
  check('Template has config.json', fs.existsSync(path.join(tplDir, 'config.json')));
  check('Template has SOUL.md', fs.existsSync(path.join(tplDir, 'SOUL.md')));

  // Clean up test template
  fs.rmSync(tplDir, { recursive: true });
  check('Test template cleaned up', !fs.existsSync(tplDir));

  // ── Summary ──
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(e => { console.error('Test crashed:', e); process.exit(1); });
