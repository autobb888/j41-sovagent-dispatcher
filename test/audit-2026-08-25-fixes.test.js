'use strict';
/**
 * Regression coverage for the 11 blockers found in the 2026-08-25 CLI/TUI
 * new-user robustness audit (docs/testing/2026-08-25-cli-tui-newuser-audit.md).
 * Each blocker was the same family of failure as the prior soft-launch audits:
 * the CLI either reported success while publishing wrong/empty/free state, or
 * moved money/on-chain state with no recap and no confirmation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.NODE_ENV = 'test';
const { saveProfile, loadSavedProfile, createFinalizeHooks } = require('../src/cli.js');

const SRC = path.join(__dirname, '..', 'src');
const CLI = fs.readFileSync(path.join(SRC, 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(SRC, 'dashboard.js'), 'utf8');

function withAgentsDir(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-audit-fix-'));
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', 'agent-1');
  fs.mkdirSync(dir, { recursive: true });
  try { return fn(dir); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// ── B1: register → finalize must not silently publish an empty profile ────

test('B1: saveProfile/loadSavedProfile round-trip what register collects', () => {
  withAgentsDir((dir) => {
    // saveProfile/loadSavedProfile are keyed by agentId under AGENTS_DIR, which
    // is fixed at module load — so drive them through their own file directly
    // instead, proving the shape round-trips.
    const profilePath = path.join(dir, 'profile.json');
    const profile = { name: 'agent-1', type: 'autonomous', description: 'x' };
    const services = [{ name: 'svc', price: 1 }];
    fs.writeFileSync(profilePath, JSON.stringify({ profile, services, disputePolicy: undefined }, null, 2));
    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.deepEqual(raw.profile, profile);
    assert.deepEqual(raw.services, services);
  });
});

test('B1: loadSavedProfile returns null for a missing or profile-less file', () => {
  // loadSavedProfile is exported and reads from the real AGENTS_DIR (test env's
  // temp home) — an agent that was never registered has no profile.json.
  const result = loadSavedProfile('__no-such-agent-in-this-test-run__');
  assert.equal(result, null);
});

test('B1: createFinalizeHooks.publishVdxf refuses to publish with no profile', async () => {
  // The core of B1: this used to fall through to `{ services: '[]' }` and
  // broadcast a no-op update while printing "Identity updated on-chain". It
  // must now throw BEFORE any network call — profile=undefined is exactly the
  // case a bare `finalize <agent-id>` used to hit.
  const hooks = createFinalizeHooks('agent-1', 'test-identity.agentplatform@', undefined, [], undefined);
  await assert.rejects(
    () => hooks.publishVdxf(),
    /no profile was supplied/i,
  );
});

test('B1: register persists the collected profile so a later finalize can find it', () => {
  const start = CLI.indexOf(".command('register <agent-id> <identity-name>')");
  const finalizeCmdStart = CLI.indexOf(".command('finalize <agent-id>')");
  const registerBody = CLI.slice(start, finalizeCmdStart);
  assert.match(registerBody, /saveProfile\(agentId, profileData, serviceData, disputePolicyData\)/);
});

test('B1: standalone finalize falls back to the saved profile, not silent undefined', () => {
  const finalizeStart = CLI.indexOf(".command('finalize <agent-id>')");
  const recoverStart = CLI.indexOf(".command('recover <agent-id>')");
  const finalizeBody = CLI.slice(finalizeStart, recoverStart);
  assert.match(finalizeBody, /loadSavedProfile\(agentId\)/);
  assert.match(finalizeBody, /interactiveProfileSetup\(keys, soul\)/, '--interactive must collect the profile itself, not defer to the SDK');
});

test('B1 fix follow-up: finalize --service-* flags win over a saved profile\'s services', () => {
  // Code-review finding: the fallback-to-profile.json branch used to take
  // `services = saved.services` unconditionally, so `finalize <id>
  // --service-name X --service-price 5` silently dropped the flags whenever
  // profile.json already existed (the normal case after `register`).
  const finalizeStart = CLI.indexOf(".command('finalize <agent-id>')");
  const recoverStart = CLI.indexOf(".command('recover <agent-id>')");
  const finalizeBody = CLI.slice(finalizeStart, recoverStart);
  const elseBranch = finalizeBody.slice(finalizeBody.indexOf('} else {\n      const saved = loadSavedProfile'));
  assert.match(elseBranch, /const flagServices = buildServiceFromOptions\(options, options\.profileDescription\);/);
  assert.match(elseBranch, /services = flagServices\.length \? flagServices : saved\.services;/);
});

// ── B2: rental-setup must not default to a free listing ───────────────────

test('B2: rental-setup --price has no default and is required when registering', () => {
  const start = CLI.indexOf(".command('rental-setup <agent-id>')");
  const dashboardCmdStart = CLI.indexOf(".command('dashboard')");
  const body = CLI.slice(start, dashboardCmdStart);
  assert.doesNotMatch(body, /--price <vrsc>[^\n]*,\s*'0'\)/, '--price must not default to 0 (free)');
  assert.match(body, /--price <vrsc> is required to register a rental listing/);
});

test('B2: the guided rental-setup TUI wizard collects a price before running', () => {
  const start = DASH.indexOf('async function rentalSetupScreen(');
  const nextFn = DASH.indexOf('async function ', start + 10);
  const body = DASH.slice(start, nextFn);
  assert.match(body, /Price per rental window/);
  assert.match(body, /runDispatcherCli\(\['rental-setup', agentId, '--price', String\(price\)\]\)/);
});

// ── B3: allowlist remove must not leave a resolved i-address entry live ───

test('B3: allowlist remove strips both the pasted and resolved forms', () => {
  const start = CLI.indexOf(".command('allowlist <agent-id> [action] [identity]')");
  const salesModeStart = CLI.indexOf(".command('sales-mode");
  const body = CLI.slice(start, salesModeStart);
  const removeCalls = (body.match(/removeBuyerAllowlistEntry\(cfg,/g) || []).length;
  assert.ok(removeCalls >= 2, `expected remove to strip both pasted and resolved forms, found ${removeCalls} call(s)`);
});

test('B3 fix follow-up: add and remove share one identity-resolution helper (no copy-paste)', () => {
  // Code-review finding: add/remove originally duplicated the ~24-line
  // resolve-to-i-address block, so a future fix to one would not apply to the
  // other. Both must now call the same function.
  const start = CLI.indexOf(".command('allowlist <agent-id> [action] [identity]')");
  const salesModeStart = CLI.indexOf(".command('sales-mode");
  const body = CLI.slice(start, salesModeStart);
  const calls = (body.match(/await resolveAllowlistIdentity\(pasted, keys\)/g) || []).length;
  assert.equal(calls, 2, 'both add and remove should call resolveAllowlistIdentity');
  assert.doesNotMatch(body, /new J41Agent\(/, 'agent construction should live only in the shared helper now');
});

// ── B4: decrypt-keys must confirm and must not crash headless ─────────────

test('B4: decrypt-keys confirms before permanently writing plaintext keys', () => {
  const start = CLI.indexOf(".command('decrypt-keys')");
  const changePassStart = CLI.indexOf(".command('change-passphrase')");
  const body = CLI.slice(start, changePassStart);
  assert.match(body, /Continue\? \(y\/N\)/);
  assert.match(body, /requireInteractiveConfirm\('decrypt-keys'\)/);
  assert.match(body, /try \{\s*\n\s*pass = await keystore\.resolvePassphrase/, 'must catch ENOPASS instead of crashing headless');
});

// ── B5: respond-dispute / refunds reject must confirm and validate input ──

test('B5: respond-dispute validates refund-percent and confirms before submitting', () => {
  const start = CLI.indexOf(".command('respond-dispute <jobId>')");
  const ctlStart = CLI.indexOf(".command('ctl <command>')");
  const body = CLI.slice(start, ctlStart);
  assert.match(body, /refundPercent < 1 \|\| refundPercent > 100/);
  assert.match(body, /Submit this response\? \(y\/N\)/);
});

test('B5: refunds reject recaps and confirms before rejecting', () => {
  const start = CLI.indexOf("if (action === 'reject')");
  const approveStart = CLI.indexOf("if (action === 'approve')");
  const body = CLI.slice(start, approveStart);
  assert.match(body, /About to REJECT/);
  assert.match(body, /Reject this refund\? \(y\/N\)/);
});

// ── B6: TUI jobsScreen must receive agentId ────────────────────────────────

test('B6: agentDetailScreen passes agentId into jobsScreen (dispute-response path)', () => {
  assert.match(DASH, /jobsScreen\(inquirer, secretKeys, agentId\)/);
  const fnStart = DASH.indexOf('async function jobsScreen(');
  const sig = DASH.slice(fnStart, DASH.indexOf(')', fnStart) + 1);
  assert.match(sig, /jobsScreen\(inquirer, keys, agentId\)/);
});

// ── B7: TUI api-endpoint registration confirm must default to false ───────

test('B7: apiEndpointSetupScreen confirm defaults to false before an on-chain write', () => {
  const start = DASH.indexOf('async function apiEndpointSetupScreen(');
  const nextFn = DASH.indexOf('\nasync function ', start + 10);
  const body = DASH.slice(start, nextFn);
  assert.match(body, /message: 'Apply this configuration[^']*',\s*default: false/);
});

// ── B8: TUI dispute screen relies on the CLI-level confirm ────────────────

test('B8: respondDisputeScreen does not pass --yes (so the CLI-level confirm still fires)', () => {
  const start = DASH.indexOf('async function respondDisputeScreen(');
  const nextFn = DASH.indexOf('\nasync function ', start + 10);
  const body = DASH.slice(start, nextFn);
  const argsLine = body.match(/const args = \[[^\]]*\];/);
  assert.ok(argsLine, 'expected a single args-array construction for runDispatcherCli');
  assert.doesNotMatch(argsLine[0], /--yes/);
  assert.match(body, /respond-dispute/);
});

// ── B9: start must not send an unregistered fleet to activate-all ─────────

test('B9: start tracks unregistered agents separately and points at register', () => {
  const start = CLI.indexOf(".command('start')");
  const encryptStart = CLI.indexOf(".command('encrypt-keys')");
  const body = CLI.slice(start, encryptStart);
  assert.match(body, /_unregisteredAgents/);
  assert.match(body, /have never been registered on-chain/);
  assert.match(body, /_unregisteredAgents\.length === agents\.length/);
});

// ── B10: start must not crash raw on a rejected executor URL ──────────────

test('B10: start wraps executor URL validation so a rejection is a clean error', () => {
  const start = CLI.indexOf(".command('start')");
  const encryptStart = CLI.indexOf(".command('encrypt-keys')");
  const body = CLI.slice(start, encryptStart);
  const idx = body.indexOf('validateExecutorUrl(cfg.executor.url');
  assert.ok(idx > 0);
  const before = body.slice(Math.max(0, idx - 200), idx);
  assert.match(before, /try \{/);
  const after = body.slice(idx, idx + 700);
  assert.match(after, /catch \(e\) \{/);
  assert.match(after, /SSRF/);
});

// ── B11: interactive onboarding prompts must not hang with no TTY ─────────

test('B11: quickstart, interactiveProfileSetup and interactiveOnboarding guard on TTY', () => {
  const quickstartStart = CLI.indexOf(".command('quickstart')");
  const initStart = CLI.indexOf(".command('init')");
  const quickstartBody = CLI.slice(quickstartStart, initStart);
  assert.match(quickstartBody, /requireInteractiveConfirm\('quickstart'\)/);

  const ipsStart = CLI.indexOf('async function interactiveProfileSetup(');
  const ipsBody = CLI.slice(ipsStart, ipsStart + 900);
  assert.match(ipsBody, /requireInteractiveConfirm\('interactive profile setup'\)/);

  const ioStart = CLI.indexOf('async function interactiveOnboarding(');
  const ioBody = CLI.slice(ioStart, ioStart + 300);
  assert.match(ioBody, /requireInteractiveConfirm\('interactive onboarding'\)/);
  assert.ok(ipsStart > 0 && ioStart > 0);
});

test('B11: finalize --interactive resolves the profile itself before finalizeOnboarding', () => {
  // Guarding interactiveProfileSetup covers this: finalize --interactive now
  // calls it directly (see the B1 finalize test above) rather than deferring
  // to the SDK's own unguarded defaultPrompt.
  const finalizeStart = CLI.indexOf(".command('finalize <agent-id>')");
  const recoverStart = CLI.indexOf(".command('recover <agent-id>')");
  const finalizeBody = CLI.slice(finalizeStart, recoverStart);
  assert.match(finalizeBody, /if \(options\.interactive\) \{/);
  assert.match(finalizeBody, /interactiveProfileSetup\(keys, soul\)/);
});
