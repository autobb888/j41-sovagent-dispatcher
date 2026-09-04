'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveJobAgentJs,
  ensureJobAgentVisibleToSecureSetup,
  packageRootFromJobAgent,
} = require('../src/job-agent-path');

test('resolveJobAgentJs finds this checkout src/job-agent.js', () => {
  const p = resolveJobAgentJs();
  assert.ok(p && p.endsWith(`${path.sep}src${path.sep}job-agent.js`));
  assert.ok(fs.existsSync(p));
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /_sdkCanaryCheck/);
});

test('already-visible search path is a no-op (does not symlink)', () => {
  const job = resolveJobAgentJs();
  const calls = { symlink: 0 };
  const r = ensureJobAgentVisibleToSecureSetup({
    fromDir: job,
    searchPaths: [job],
    symlinkSync: () => { calls.symlink += 1; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'already-visible');
  assert.equal(calls.symlink, 0);
});

test('nested alias: symlink scoped package to npm prefix when missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-jap-'));
  const job = path.join(home, 'j41-dispatcher', 'node_modules', '@junction41', 'dispatcher', 'src', 'job-agent.js');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, '// canary _sdkCanaryCheck\n');
  const prefix = path.join(home, 'prefix');
  const dests = [];
  const r = ensureJobAgentVisibleToSecureSetup({
    fromDir: job,
    npmPrefix: prefix,
    searchPaths: [path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher', 'src', 'job-agent.js')],
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    symlinkSync: (t, p) => { dests.push({ t, p }); fs.symlinkSync(t, p); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'symlinked');
  assert.equal(dests.length, 1);
  assert.equal(dests[0].t, packageRootFromJobAgent(job));
  const linked = path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher', 'src', 'job-agent.js');
  assert.equal(fs.existsSync(linked), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('empty leftover dest directory is replaced with a symlink (O2-2)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-jap-'));
  const job = path.join(home, 'src', 'job-agent.js');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, '// _sdkCanaryCheck\n');
  const prefix = path.join(home, 'prefix');
  const dest = path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher');
  fs.mkdirSync(dest, { recursive: true });
  const r = ensureJobAgentVisibleToSecureSetup({
    fromDir: job,
    npmPrefix: prefix,
    searchPaths: [path.join(dest, 'src', 'job-agent.js')],
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'symlinked');
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(dest, 'src', 'job-agent.js')), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dangling dest symlink is replaced', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-jap-'));
  const job = path.join(home, 'src', 'job-agent.js');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, '// _sdkCanaryCheck\n');
  const prefix = path.join(home, 'prefix');
  const dest = path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(path.join(home, 'missing-target'), dest);
  const r = ensureJobAgentVisibleToSecureSetup({
    fromDir: job,
    npmPrefix: prefix,
    searchPaths: [path.join(dest, 'src', 'job-agent.js')],
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'symlinked');
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(dest, 'src', 'job-agent.js')), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('does not overwrite a non-empty real directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-jap-'));
  const job = path.join(home, 'src', 'job-agent.js');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, 'x');
  const prefix = path.join(home, 'prefix');
  const dest = path.join(prefix, 'lib', 'node_modules', '@junction41', 'dispatcher');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'not-ours'), 'keep');
  const r = ensureJobAgentVisibleToSecureSetup({
    fromDir: job,
    npmPrefix: prefix,
    searchPaths: [path.join(dest, 'src', 'job-agent.js')],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dest-exists');
  assert.equal(fs.existsSync(path.join(dest, 'not-ours')), true);
  fs.rmSync(home, { recursive: true, force: true });
});
