'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const CLAUDE = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'docs/config.toml.example'), 'utf8');
const CLI = fs.readFileSync(path.join(ROOT, 'src/cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'src/dashboard.js'), 'utf8');

test('README command table: build-image builds job-agent and gpu-jail; rental-setup exists', () => {
  assert.match(README, /build-image[\s\S]{0,200}gpu-jail/);
  assert.match(README, /rental-setup/);
  assert.match(README, /home-gpu/);
});

test('README Cat-1 section: named TCP tunnel, not HTTP webhook, never 0.0.0.0', () => {
  assert.match(README, /named TCP/i);
  assert.match(README, /127\.0\.0\.1:\$ssh_tunnel_port|127\.0\.0\.1:\$\{?ssh_tunnel_port\}?/);
  assert.match(README, /not (the )?HTTP webhook/i);
  assert.match(README, /0\.0\.0\.0/);
  assert.match(README, /rental-setup <agent-id>|rental-setup <id>/);
  assert.match(README, /RENTAL_SECRETS_KEY/);
  assert.match(README, /not a dispatcher/i);
});

test('CLAUDE.md quick reference names gpu-jail and rental-setup', () => {
  assert.match(CLAUDE, /gpu-jail/);
  assert.match(CLAUDE, /rental-setup/);
  assert.match(CLAUDE, /home-gpu/);
});

test('config.toml.example keeps compute off by default and ships a paste-ready home-gpu recipe', () => {
  assert.match(EXAMPLE, /\[compute\][\s\S]*?enabled\s*=\s*false/);
  assert.match(EXAMPLE, /PASTE RECIPE|paste recipe/);
  assert.match(EXAMPLE, /type\s*=\s*"home-gpu"/);
  assert.match(EXAMPLE, /ssh_hostname/);
  assert.match(EXAMPLE, /ssh_tunnel_port/);
  assert.match(EXAMPLE, /memory_mb/);
  assert.match(EXAMPLE, /disk_gb/);
  assert.match(EXAMPLE, /default_provider\s*=\s*"home-gpu"/);
});

test('build-image description names gpu-jail', () => {
  const start = CLI.indexOf(".command('build-image')");
  assert.ok(start > 0);
  const body = CLI.slice(start, start + 400);
  assert.match(body, /gpu-jail/);
});

test('rental-setup registration error names RENTAL_SECRETS_KEY as platform-side', () => {
  const start = CLI.indexOf(".command('rental-setup <agent-id>')");
  const body = CLI.slice(start, CLI.indexOf('\n  .command(', start + 1));
  assert.match(body, /RENTAL_SECRETS_KEY_MISSING/);
  assert.match(body, /not a dispatcher/i);
});

test('compute signup TUI routes to provider config then rental-setup, not straight to start', () => {
  // 2026-08-25: rewritten. The old assertions anchored on `message: 'Run
  // rental-setup now?'` and text ("Do these in order before start", "Skipped.
  // Next is still rental-setup, not start") that no longer exists anywhere in
  // dashboard.js — this was already failing before this session's changes
  // (confirmed via `git stash` against the pre-session baseline), from an
  // earlier compute-signup wizard redesign (commits around 18d31e4/daf5fcd)
  // that was never reflected here. The wizard's shape changed; the safety
  // property it was checking — a compute listing cannot be signed up straight
  // into "start" without being walked through provider config and
  // rental-setup — still holds in the current code. Assert that instead.
  const signupIdx = DASH.indexOf("if (kind === 'compute') {");
  assert.ok(signupIdx > 0, 'the post-setup dispatch on listing kind must exist');
  const signupWindow = DASH.slice(signupIdx, signupIdx + 500);
  assert.match(signupWindow, /await computeProviderScreen\(inquirer, agentId\)/);
  assert.match(signupWindow, /await rentalSetupScreen\(inquirer, agentId\)/);
  assert.match(signupWindow, /Do not use API Endpoint Setup on this listing/i);

  const providerBody = dashScreenBody('computeProviderScreen');
  assert.match(providerBody, /config\.toml/);
  assert.match(providerBody, /TCP tunnel/);

  const rentalBody = dashScreenBody('rentalSetupScreen');
  assert.match(rentalBody, /rental-setup/);
  // Declining the provider-write step must not silently proceed as if the
  // listing were ready — it must say so and stop, not fall through to a
  // rental-setup invocation that would just fail with RENTAL_NO_PROVIDER.
  assert.match(rentalBody, /rental-setup will fail without a provider/);
  // The final "run rental-setup now" confirm must default to false — this is
  // the B2 fix from this session (rental-setup used to default --price to 0
  // and this wizard never asked for one at all).
  assert.match(rentalBody, /message: `Run rental-setup at \$\{price\} \$\{NATIVE_COIN\} now\?`,\s*\n\s*default: false,/);
});

test('API Endpoint Setup and Configure Services refuse compute listings', () => {
  const apiBody = dashScreenBody('apiEndpointSetupScreen');
  assert.match(apiBody, /kind !== 'compute'|kind === 'compute'/);
  assert.match(apiBody, /rental-setup/);
  const svcBody = dashScreenBody('configureServicesScreen');
  assert.match(svcBody, /listingKindOf\(keys\) === 'compute'|kind === 'compute'/);
  // 2026-08-25: this used to require the literal substring "rental-setup"
  // inside configureServicesScreen's body, but that function only ever
  // referenced `rentalSetupScreen` (the function), never the hyphenated CLI
  // command name — so this assertion was failing before this session's
  // changes too (confirmed via the pre-session baseline). The real property
  // worth checking is that a compute listing gets routed to the actual
  // rental-setup screen, which it does.
  assert.match(svcBody, /rentalSetupScreen\(inquirer, agentId\)/);
});

/** Slice a named async function's body out of dashboard.js (up to the next top-level async function). */
function dashScreenBody(name) {
  const start = DASH.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} must exist in dashboard.js`);
  const next = DASH.indexOf('\nasync function ', start + 10);
  return DASH.slice(start, next === -1 ? start + 3500 : next);
}
