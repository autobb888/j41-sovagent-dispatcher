'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { homeGpuConfigured } = require('../src/rental-setup.js');

test('package.json files includes Dockerfile.gpu-jail', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.files.includes('Dockerfile.gpu-jail'));
});

test('homeGpuConfigured is true only when compute is on and a home-gpu provider exists', () => {
  assert.equal(homeGpuConfigured({ compute: { enabled: false, providers: { c: { type: 'home-gpu' } } } }), false);
  assert.equal(homeGpuConfigured({ compute: { enabled: true, providers: { c: { type: 'vast' } } } }), false);
  assert.equal(homeGpuConfigured({ compute: { enabled: true, providers: { c: { type: 'home-gpu' } } } }), true);
});

test('cli.js start gate names j41-dispatcher build-image when home-gpu is configured', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(src, /jailImageExists/);
  assert.match(src, /JAIL_IMAGE|j41\/gpu-jail/);
});

test('build-image still builds the jail when the job image already exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const helper = src.indexOf('function buildJailImageScriptPath(');
  assert.ok(helper > 0, 'buildJailImageScriptPath sibling must exist');
  assert.match(src.slice(helper, helper + 200), /build-jail-image\.sh/);
  const start = src.indexOf(".command('build-image')");
  assert.ok(start > 0, 'build-image command must exist');
  const next = src.indexOf(".command('start')", start);
  const body = src.slice(start, next > start ? next : start + 5000);
  assert.match(body, /buildJailImageScriptPath/);
  assert.match(body, /jailImageExists/);
  const skip = body.match(/if \(!options\.force && jobImageExists\(\)\) \{[\s\S]*?\n    \}/);
  assert.ok(skip, 'job-image skip block must exist');
  assert.doesNotMatch(skip[0], /\breturn\b/, 'skipping the job image must not return before the jail build');
});

test('start jail gate inspects jailImageRef per home-gpu provider, not only env JAIL_IMAGE', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const refuse = src.indexOf('the jail image');
  assert.ok(refuse > 0);
  const body = src.slice(refuse - 900, refuse + 1200);
  assert.match(body, /homeGpuConfigured/);
  assert.match(body, /jailImageRef/);
  assert.match(body, /assertHomeGpuHostReady/);
  assert.match(body, /NODE_ENV !== 'test'/);
  assert.match(body, /RUNTIME !== 'local'/);
  assert.match(body, /no buyer can pay into this fleet/);
  assert.match(body, /j41-dispatcher build-image/);
});

test('JAIL_IMAGE constant is jailImageRef({})', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(src, /const JAIL_IMAGE = jailImageRef\(\{\}\)/);
});
