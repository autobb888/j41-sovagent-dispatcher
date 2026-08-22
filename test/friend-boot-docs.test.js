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

test('compute signup TUI prints numbered next steps and skip still names rental-setup, not start', () => {
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  const runRental = dash.indexOf("message: 'Run rental-setup now?'");
  assert.ok(runRental > 0);
  const window = dash.slice(runRental - 1200, runRental + 1200);
  assert.match(window, /Do these in order before start/);
  assert.match(window, /j41-dispatcher rental-setup/);
  assert.match(window, /config\.toml/);
  assert.match(window, /named TCP|ssh_tunnel_port/);
  assert.match(window, /Skipped\. Next is still rental-setup, not start/);
  // TUI does not write [compute.providers.*], so default-true would always
  // fail with RENTAL_NO_PROVIDER. default false is correct; skip must not
  // imply the fleet is start-ready.
  assert.match(window, /default:\s*false/);
});

test('API Endpoint Setup and Configure Services refuse compute listings', () => {
  const dash = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  const apiFn = dash.indexOf('async function apiEndpointSetupScreen');
  const apiBody = dash.slice(apiFn, apiFn + 2500);
  assert.match(apiBody, /kind !== 'compute'|kind === 'compute'/);
  assert.match(apiBody, /rental-setup/);
  const svcFn = dash.indexOf('async function configureServicesScreen');
  const svcBody = dash.slice(svcFn, svcFn + 3500);
  assert.match(svcBody, /listingKindOf\(keys\) === 'compute'|kind === 'compute'/);
  assert.match(svcBody, /rental-setup/);
});
