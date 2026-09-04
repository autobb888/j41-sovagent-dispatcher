'use strict';
/**
 * Wave 2 wiring: CLI/TUI must consume doctor classifiers and must not teach
 * local mode, "N registered", or /tmp logs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const CLI = fs.readFileSync(path.join(SRC, 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(SRC, 'dashboard.js'), 'utf8');

test('cli.js registers doctor command', () => {
  assert.match(CLI, /\.command\('doctor'\)/);
});

test('getActiveJobs does not recommend config --runtime local', () => {
  assert.equal((CLI.match(/config --runtime local/g) || []).length, 0,
    'cli.js still tells operators to switch to local mode');
});

test('status does not print Agents: N registered', () => {
  assert.doesNotMatch(CLI, /Agents: \$\{agents\.length\} registered/);
});

test('dashboard header does not say N registered', () => {
  assert.doesNotMatch(DASH, /Agents: \$\{agents\.length\} registered/);
  assert.doesNotMatch(DASH, /View listings \(\$\{agents\.length\} registered\)/);
});

test('dashboard Start does not log to /tmp/dispatcher.log', () => {
  assert.doesNotMatch(DASH, /openSync\('\/tmp\/dispatcher\.log'/);
  assert.match(DASH, /dispatcher\.log/);
});

test('dashboard hides compute kind on darwin/win32', () => {
  assert.match(DASH, /gpuOffered|platform === 'linux'|process\.platform !== 'linux'/);
});

test('cli.js uses dockerAdviceFromError or classifyDockerError for Docker errors', () => {
  assert.match(CLI, /dockerAdviceFromError|classifyDockerError/);
});
