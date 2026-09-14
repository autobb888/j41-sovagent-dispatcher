'use strict';
/**
 * First-run security policy (F4/F5) and quickCheck fail-closed timeout.
 * HOME is a harness temp dir under os.tmpdir() — never the real ~/.j41.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runStart } = require('./helpers/dispatcher-harness');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

const agent = [{
  id: 'agent-1',
  identity: 'agent1@',
  iAddress: 'iAgent1',
  chainStatus: 'active',
  platformStatus: 'active',
}];

function setupCalls(r) {
  return r.sideEffects.filter((s) => s.call === 'secureSetup.setup');
}

test('cli.js first-run block never Promise.races setup() and never prints a fake ✓', () => {
  const start = CLI.indexOf('Task 18: First-run security setup');
  const end = CLI.indexOf('Task 19: Startup security quick-check');
  assert.ok(start > -1 && end > start);
  const block = CLI.slice(start, end);
  assert.doesNotMatch(block, /Promise\.race/);
  assert.doesNotMatch(block, /✓ Security setup complete/);
  assert.match(block, /process\.getuid\(\) === 0/);
  assert.match(block, /stdin\.isTTY/);
  assert.match(block, /sudo npx @junction41\/secure-setup --dispatcher/);
  assert.match(block, /Security Setup/);
});

test('cli.js quickCheck timeout is fail-closed (not "unavailable" + continue)', () => {
  const start = CLI.indexOf('Task 19: Startup security quick-check');
  const end = CLI.indexOf('Load on-chain capabilities');
  assert.ok(start > -1 && end > start);
  const block = CLI.slice(start, end);
  assert.match(block, /checkFailed|checkError/);
  assert.doesNotMatch(block, /quick-check unavailable/);
  assert.match(block, /process\.exit\(1\)/);
  assert.match(block, /_devUnsafe/);
});

test('marker present: start does not call setup()', async (t) => {
  const r = await runStart({ agents: agent, timeoutMs: 15000 });
  t.after(() => r.teardown());
  assert.equal(setupCalls(r).length, 0);
  assert.equal(r.exits.length, 0);
  assert.equal(r.state && r.state.startupComplete, true);
});

test('marker absent, not root: does not call setup(), prints sudo, no ✓', async (t) => {
  const r = await runStart({
    agents: agent,
    skipSecurityMarker: true,
    tty: false,
    asRoot: false,
    timeoutMs: 15000,
  });
  t.after(() => r.teardown());
  assert.equal(setupCalls(r).length, 0, 'non-root first start must not call setup()');
  assert.ok(r.logged('sudo npx @junction41/secure-setup --dispatcher'));
  assert.ok(r.logged('Security Setup'));
  assert.equal(r.logged('✓ Security setup complete'), false);
  assert.equal(r.logged('✅ Setup complete'), false);
  assert.equal(r.exits.length, 0);
  assert.equal(r.state && r.state.startupComplete, true);
});

test('marker absent, root + TTY: calls setup() with no timeout and branches on success', async (t) => {
  const r = await runStart({
    agents: agent,
    skipSecurityMarker: true,
    asRoot: true,
    tty: true,
    timeoutMs: 15000,
    secureSetup: {
      setup: () => new Promise((resolve) => setTimeout(() => resolve({
        success: true, score: 9, mode: 'gvisor', log: ['installed profiles'],
      }), 15000)),
    },
  });
  t.after(() => r.teardown());
  assert.equal(setupCalls(r).length, 1);
  assert.deepEqual(setupCalls(r)[0].args, ['dispatcher']);
  assert.ok(r.logged('✅ Setup complete. Score: 9/10 (gvisor)'));
  assert.ok(r.logged('installed profiles'));
  assert.equal(r.logged('✓ Security setup complete'), false);
  assert.equal(r.exits.length, 0);
  assert.equal(r.state && r.state.startupComplete, true);
});

test('marker absent, root + TTY, setup {success:false}: no ✓, prints issues', async (t) => {
  const r = await runStart({
    agents: agent,
    skipSecurityMarker: true,
    asRoot: true,
    tty: true,
    timeoutMs: 15000,
    secureSetup: {
      setup: async () => ({ success: false, score: 0, mode: 'none', log: ['[setup] Aborting.'] }),
    },
  });
  t.after(() => r.teardown());
  assert.equal(setupCalls(r).length, 1);
  assert.ok(r.logged('❌ Setup had issues. Score: 0/10'));
  assert.ok(r.logged('[setup] Aborting.'));
  assert.equal(r.logged('✓ Security setup complete'), false);
  assert.equal(r.logged('✅ Setup complete'), false);
});

test('quickCheck timeout exits 1 unless --dev-unsafe', async (t) => {
  const r = await runStart({
    agents: agent,
    timeoutMs: 15000,
    secureSetup: { quickCheck: () => new Promise(() => {}) },
  });
  t.after(() => r.teardown());
  assert.ok(r.exits.includes(1));
  assert.ok(r.logged('SECURITY CHECK FAILED'));
  assert.ok(r.logged('quick-check: timeout'));
  assert.notEqual(r.state && r.state.startupComplete, true, 'must not complete startup after a failed check');
  assert.equal(r.logged('quick-check unavailable'), false);
});

test('quickCheck timeout continues with --dev-unsafe', async (t) => {
  const r = await runStart({
    agents: agent,
    argv: ['--dev-unsafe'],
    timeoutMs: 15000,
    secureSetup: { quickCheck: () => new Promise(() => {}) },
  });
  t.after(() => r.teardown());
  assert.ok(r.logged('SECURITY CHECK FAILED'));
  assert.ok(r.logged('Continuing anyway (--dev-unsafe mode)'));
  assert.equal(r.exits.length, 0);
  assert.equal(r.state && r.state.startupComplete, true);
});
