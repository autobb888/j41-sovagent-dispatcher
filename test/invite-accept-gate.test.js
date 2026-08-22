'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CLI = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');

test('poll and webhook accept call decideAutoAccept before acceptJob', () => {
  const poll = CLI.slice(CLI.indexOf("job.status === 'requested'"), CLI.indexOf('Step 2: Check if ready'));
  assert.match(poll, /decideAutoAccept/);
  assert.match(poll, /acceptJob/);
  const pollAccept = poll.indexOf('acceptJob');
  assert.ok(poll.indexOf('decideAutoAccept') < pollAccept);

  const requested = CLI.slice(CLI.indexOf("case 'job.requested'"), CLI.indexOf("case 'job.started'"));
  assert.match(requested, /decideAutoAccept/);
  const whAccept = requested.indexOf('acceptJob');
  assert.ok(requested.indexOf('decideAutoAccept') < whAccept);
  assert.match(requested, /INVITE/);
  assert.match(requested, /preferAllowlist|hasAllowlistedSibling/);
});

test('cli registers allowlist, sales-mode, and accept-job', () => {
  assert.match(CLI, /\.command\('allowlist <agent-id>/);
  assert.match(CLI, /\.command\('sales-mode <agent-id>/);
  assert.match(CLI, /\.command\('accept-job <agent-id> <job-id>'\)/);
});

test('activate and activate-all skip chain write when invite; sales-mode open is the floodgate', () => {
  const act = CLI.slice(CLI.indexOf(".command('activate <agent-id>')"), CLI.indexOf(".command('activate-all')"));
  assert.match(act, /inspectChainSalesStatus/);
  assert.match(act, /shouldWriteChainActiveOnActivate/);
  assert.match(act, /sales-mode open/);
  assert.match(act, /skipping chain write/);
  assert.doesNotMatch(act, /proceed with requested onChain/);

  const all = CLI.slice(CLI.indexOf(".command('activate-all')"), CLI.indexOf(".command('deactivate-all')"));
  assert.match(all, /inspectChainSalesStatus/);
  assert.match(all, /shouldWriteChainActiveOnActivate/);
  assert.match(all, /sales-mode open/);
  assert.doesNotMatch(all, /proceed with requested onChain/);
});

test('accept-job does not consult decideAutoAccept', () => {
  const start = CLI.indexOf(".command('accept-job <agent-id> <job-id>')");
  assert.ok(start > -1, 'accept-job command is registered');
  const next = CLI.indexOf('\n  .command(', start + 1);
  const body = CLI.slice(start, next === -1 ? start + 4000 : next);
  assert.equal(body.includes('decideAutoAccept'), false);
  assert.match(body, /acceptJob/);
  assert.match(body, /buildAcceptMessage/);
  assert.match(body, /addActiveJobToAllowlist/);
  assert.match(body, /buyerPayAddress \|\| .*\.payAddress/);
});

test('poll and webhook fail closed on unread/unparseable chain status', () => {
  const poll = CLI.slice(CLI.indexOf("job.status === 'requested'"), CLI.indexOf('Step 2: Check if ready'));
  assert.match(poll, /inspectChainSalesStatus/);
  assert.match(poll, /status unread/);
  assert.match(poll, /status unparseable/);
  assert.doesNotMatch(poll, /getIdentityRaw\([^)]*\)\.catch\(\(\) => null\)/);
  assert.match(poll, /getAgent/);

  const requested = CLI.slice(CLI.indexOf("case 'job.requested'"), CLI.indexOf("case 'job.started'"));
  assert.match(requested, /inspectChainSalesStatus/);
  assert.match(requested, /status unread/);
  assert.match(requested, /status unparseable/);
  assert.doesNotMatch(requested, /getIdentityRaw\([^)]*\)\.catch\(\(\) => null\)/);
  assert.match(requested, /getAgent/);
});

test('empty-allowlist log is once per agent via _inviteHeld', () => {
  const poll = CLI.slice(CLI.indexOf("job.status === 'requested'"), CLI.indexOf('Step 2: Check if ready'));
  const emptyIdx = poll.indexOf("decision.reason === 'empty allowlist'");
  assert.ok(emptyIdx > -1);
  const emptyBranch = poll.slice(emptyIdx, emptyIdx + 500);
  assert.match(emptyBranch, /_inviteHeld/);

  const requested = CLI.slice(CLI.indexOf("case 'job.requested'"), CLI.indexOf("case 'job.started'"));
  const whEmpty = requested.indexOf("decision.reason === 'empty allowlist'");
  assert.ok(whEmpty > -1);
  assert.match(requested.slice(whEmpty, whEmpty + 500), /_inviteHeld/);
});

test('allowlist add stores resolved i-address and warns if unresolved', () => {
  const start = CLI.indexOf(".command('allowlist <agent-id>");
  assert.ok(start > -1);
  const next = CLI.indexOf('\n  .command(', start + 1);
  const body = CLI.slice(start, next === -1 ? start + 5000 : next);
  assert.match(body, /resolveAllowlistEntries/);
  assert.match(body, /getAgent/);
  assert.match(body, /Could not resolve/);
});

test('start chain repair only when chain is inactive, not invite', () => {
  assert.match(CLI, /chainNeedsRepair = chain === 'inactive'/);
});

test('sales-mode writes invite or active VDXF and clears sales-status cache', () => {
  const start = CLI.indexOf(".command('sales-mode <agent-id>");
  assert.ok(start > -1, 'sales-mode command is registered');
  const next = CLI.indexOf('\n  .command(', start + 1);
  const body = CLI.slice(start, next === -1 ? start + 4000 : next);
  assert.match(body, /setOnChainStatus\('invite'\)/);
  assert.match(body, /setOnChainStatus\('active'\)/);
  assert.match(body, /clearSalesStatusCache/);
  assert.match(body, /pendingWrites|pending inbox/);
});

test('dashboard offers preferAllowlist confirm, not a VDXF write', () => {
  const DASH = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(DASH, /Prefer allowlist even when open\?/);
  assert.match(DASH, /preferAllowlist/);
});

test('TUI agent detail offers allowlist, sales-mode, and accept-job (operator does not need CLI)', () => {
  const DASH = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  assert.match(DASH, /Buyer allowlist/);
  assert.match(DASH, /Sales mode \(invite \/ open\)/);
  assert.match(DASH, /Accept stacked job/);
  const detail = DASH.slice(DASH.indexOf('async function agentDetailScreen'), DASH.indexOf('async function updateProfileScreen'));
  assert.match(detail, /allowlistScreen/);
  assert.match(detail, /salesModeScreen/);
  assert.match(detail, /acceptJobScreen/);
  assert.match(DASH, /'allowlist'/);
  assert.match(DASH, /'sales-mode'/);
  assert.match(DASH, /'accept-job'/);
});

test('README documents sales-mode and allowlist', () => {
  const README = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  assert.match(README, /sales-mode/);
  assert.match(README, /allowlist/);
});
