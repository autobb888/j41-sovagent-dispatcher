'use strict';
/**
 * F12 — quickstart persists only docker|local (canonical lowercase).
 * getRuntime: unknown ⇒ docker. Only exact "local" (any case) is local.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveRuntime, persistableRuntime } = require('../src/config.js');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

test('resolveRuntime: only exact local (any case) is local; unknown is docker', () => {
  assert.equal(resolveRuntime('local'), 'local');
  assert.equal(resolveRuntime('LOCAL'), 'local');
  assert.equal(resolveRuntime('Local'), 'local');
  assert.equal(resolveRuntime('docker'), 'docker');
  assert.equal(resolveRuntime('Docker'), 'docker');
  assert.equal(resolveRuntime('k8s'), 'docker');
  assert.equal(resolveRuntime(''), 'docker');
  assert.equal(resolveRuntime(null), 'docker');
  assert.equal(resolveRuntime(undefined), 'docker');
  assert.equal(resolveRuntime(' local'), 'docker');
});

test('persistableRuntime accepts only docker|local case-insensitive canonical lowercase', () => {
  assert.equal(persistableRuntime('docker'), 'docker');
  assert.equal(persistableRuntime('DOCKER'), 'docker');
  assert.equal(persistableRuntime('local'), 'local');
  assert.equal(persistableRuntime('Local'), 'local');
  assert.equal(persistableRuntime('k8s'), null);
  assert.equal(persistableRuntime(''), null);
  assert.equal(persistableRuntime(null), null);
});

test('quickstart persists persistableRuntime and refuses anything else', () => {
  const start = CLI.indexOf(".command('quickstart')");
  const body = CLI.slice(start, CLI.indexOf(".command('init')", start));
  assert.match(body, /persistableRuntime/);
  assert.match(body, /Runtime must be docker or local/);
  assert.match(body, /process\.exit\(1\)/);
});

test('getRuntime uses resolveRuntime so unknown stored values become docker', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  const fn = src.slice(src.indexOf('function getRuntime('), src.indexOf('function persistActiveJobs('));
  assert.match(fn, /resolveRuntime\(loadConfig\(\)\.runtime\)/);
});
