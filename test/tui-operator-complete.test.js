'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DASH = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');

test('TUI can build jail images, rental-setup a compute listing, and activate this listing', () => {
  assert.match(DASH, /Build job-agent \+ gpu-jail images|build_image/);
  assert.match(DASH, /'build-image'/);
  assert.match(DASH, /Rental-setup \(Cat-1 jail\)/);
  assert.match(DASH, /'rental-setup'/);
  assert.match(DASH, /Activate this listing/);
  assert.match(DASH, /Deactivate this listing/);
});

test('TUI money screens can approve refunds, credit deposits, and sweep without dumping to CLI-only', () => {
  assert.match(DASH, /Approve a refund/);
  assert.match(DASH, /\['refunds', action, id\]/);
  assert.match(DASH, /Credit a deposit/);
  assert.match(DASH, /\['deposits', action, agentId, tx\]/);
  assert.match(DASH, /\['wallet', 'sweep'/);
  assert.match(DASH, /\['wallet', 'send'/);
});

test('TUI jobs screen can accept stacked hires and respond to disputes', () => {
  assert.match(DASH, /Respond to a dispute/);
  assert.match(DASH, /'respond-dispute'/);
});

test('compute Configure Services offers rental-setup instead of CLI-only copy', () => {
  const cfg = DASH.slice(DASH.indexOf('async function configureServicesScreen'), DASH.indexOf('while (true)'));
  assert.match(cfg, /listingKindOf\(keys\) === 'compute'/);
  assert.match(cfg, /computeProviderScreen/);
  assert.match(cfg, /rentalSetupScreen/);
});
