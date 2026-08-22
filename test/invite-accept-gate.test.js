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
  assert.match(act, /readChainSalesStatus/);
  assert.match(act, /shouldWriteChainActiveOnActivate/);
  assert.match(act, /sales-mode open/);

  const all = CLI.slice(CLI.indexOf(".command('activate-all')"), CLI.indexOf(".command('deactivate-all')"));
  assert.match(all, /readChainSalesStatus/);
  assert.match(all, /shouldWriteChainActiveOnActivate/);
  assert.match(all, /sales-mode open/);
});

test('accept-job does not consult decideAutoAccept', () => {
  const start = CLI.indexOf(".command('accept-job <agent-id> <job-id>')");
  assert.ok(start > -1, 'accept-job command is registered');
  const next = CLI.indexOf('\n  .command(', start + 1);
  const body = CLI.slice(start, next === -1 ? start + 4000 : next);
  assert.equal(body.includes('decideAutoAccept'), false);
  assert.match(body, /acceptJob/);
  assert.match(body, /buildAcceptMessage/);
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
