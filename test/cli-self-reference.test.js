'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('no printed hint tells users to run "node src/cli.js"', () => {
  assert.equal(CLI.includes('node src/cli.js'), false, 'cli.js still references node src/cli.js in a hint');
});

test('dashboard spawns do not hardcode node + src/cli.js', () => {
  assert.equal(/['"]node['"]\s*,\s*\[\s*['"]src\/cli\.js['"]/.test(DASH), false, 'dashboard still spawns node src/cli.js');
});

test('a dashboard command is registered', () => {
  assert.match(CLI, /\.command\(['"]dashboard['"]\)/);
});

test('init next-step mentions finalize', () => {
  // The init "Next steps" block must include a finalize step.
  const idx = CLI.indexOf('agents initialized');
  assert.ok(idx > -1);
  const block = CLI.slice(idx, idx + 500);
  assert.match(block, /finalize/i, 'init next-step block does not mention finalize');
});
