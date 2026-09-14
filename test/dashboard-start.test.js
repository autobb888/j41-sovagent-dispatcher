'use strict';
/**
 * Dashboard Start readiness (F9): seek-to-end, THIS child's [Health] line,
 * then GET that URL. HOME/logs under /tmp only — never the live orchard.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const { seekLogEnd, waitForDispatcherReady, HEALTH_LINE_RE } = require('../src/tui/start-ready');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

function startBlock() {
  const start = DASH.indexOf("case 'start':");
  const end = DASH.indexOf("case 'stop':");
  assert.ok(start > -1 && end > start);
  return DASH.slice(start, end);
}

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dash-start-'));
  return { dir, logPath: path.join(dir, 'dispatcher.log') };
}

test('dashboard Start seeks the log before spawn and waits for [Health], not 2.5s/PID', () => {
  const block = startBlock();
  const seekAt = block.indexOf('seekLogEnd');
  const spawnAt = block.indexOf('spawn(');
  const waitAt = block.indexOf('waitForDispatcherReady');
  assert.ok(seekAt > -1, 'Start must seek-to-end of dispatcher.log');
  assert.ok(spawnAt > seekAt, 'seek-to-end must run BEFORE spawn');
  assert.ok(waitAt > spawnAt, 'waitForDispatcherReady must run after spawn');
  assert.match(block, /still starting/);
  assert.match(block, /tail -f/);
  assert.doesNotMatch(block, /2500/);
  assert.doesNotMatch(block, /formatIdentitySummary/);
  assert.doesNotMatch(block, /dispatcher\.pid/);
});

test('README first start checks; installing to /etc/j41 needs sudo npx secure-setup', () => {
  assert.match(README, /sudo npx @junction41\/secure-setup --dispatcher/);
  assert.doesNotMatch(README, /On first start, the dispatcher automatically:/);
  assert.doesNotMatch(README, /Installs gVisor \(if KVM\)/);
});

test('HEALTH_LINE_RE matches control.js bind line and not the busy warning', () => {
  const ok = '[Health] http://127.0.0.1:9842/health';
  const busy = '[Health] port 9842 busy — retrying';
  assert.match(ok, HEALTH_LINE_RE);
  assert.equal(HEALTH_LINE_RE.test(busy), false);
  assert.equal(ok.match(HEALTH_LINE_RE)[1], 'http://127.0.0.1:9842/health');
});

test('leftover [Health] from a previous spawn does not count after seek-to-end', async () => {
  const { dir, logPath } = tmpLog();
  try {
    fs.writeFileSync(logPath, '[Health] http://127.0.0.1:9842/health\nAgents: 3 local\n');
    const startOffset = seekLogEnd(logPath);
    const child = new EventEmitter();
    const urls = [];
    const r = await waitForDispatcherReady({
      logPath,
      startOffset,
      child,
      timeoutMs: 150,
      pollMs: 20,
      httpGet: async (url) => { urls.push(url); return { statusCode: 200 }; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.equal(urls.length, 0, 'must not GET leftover :9842');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('leftover HTTP 200 on 9842 without a new [Health] line after seek does not count', async () => {
  const { dir, logPath } = tmpLog();
  const leftover = http.createServer((_req, res) => { res.writeHead(200); res.end('old'); });
  await new Promise((resolve) => leftover.listen(0, '127.0.0.1', resolve));
  const port = leftover.address().port;
  try {
    fs.writeFileSync(logPath, `[Health] http://127.0.0.1:${port}/health\n`);
    const startOffset = seekLogEnd(logPath);
    const child = new EventEmitter();
    const r = await waitForDispatcherReady({
      logPath,
      startOffset,
      child,
      timeoutMs: 200,
      pollMs: 20,
      // Real GET would 200 on the leftover server — we still must not probe it
      // because no NEW [Health] line appeared after seek-to-end.
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  } finally {
    leftover.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('new [Health] line after seek + GET 200 is success; leftover 9842 is ignored', async () => {
  const { dir, logPath } = tmpLog();
  try {
    fs.writeFileSync(logPath, '[Health] http://127.0.0.1:9842/health\n');
    const startOffset = seekLogEnd(logPath);
    fs.appendFileSync(logPath, '[Health] http://127.0.0.1:19999/health\n');
    const child = new EventEmitter();
    const urls = [];
    const r = await waitForDispatcherReady({
      logPath,
      startOffset,
      child,
      timeoutMs: 400,
      pollMs: 20,
      httpGet: async (url) => { urls.push(url); return { statusCode: 200 }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'http://127.0.0.1:19999/health');
    assert.deepEqual(urls, ['http://127.0.0.1:19999/health']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identity-summary banner is not a ready signal', async () => {
  const { dir, logPath } = tmpLog();
  try {
    const startOffset = seekLogEnd(logPath);
    fs.writeFileSync(logPath, 'Agents: 3 local, 0 on-chain\nRuntime: docker mode\n');
    const child = new EventEmitter();
    const urls = [];
    const r = await waitForDispatcherReady({
      logPath,
      startOffset,
      child,
      timeoutMs: 150,
      pollMs: 20,
      httpGet: async (url) => { urls.push(url); return { statusCode: 200 }; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.equal(urls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('child exit is failure even if leftover [Health] and GET would 200', async () => {
  const { dir, logPath } = tmpLog();
  try {
    fs.writeFileSync(logPath, '[Health] http://127.0.0.1:9842/health\n');
    const startOffset = seekLogEnd(logPath);
    const child = new EventEmitter();
    child.exitCode = 1;
    const r = await waitForDispatcherReady({
      logPath,
      startOffset,
      child,
      timeoutMs: 150,
      pollMs: 20,
      httpGet: async () => ({ statusCode: 200 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exit');
    assert.equal(r.code, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeout is fail (still starting), never success', async () => {
  const { dir, logPath } = tmpLog();
  try {
    const startOffset = seekLogEnd(logPath);
    const child = new EventEmitter();
    const r = await waitForDispatcherReady({
      logPath,
      startOffset,
      child,
      timeoutMs: 80,
      pollMs: 20,
      httpGet: async () => ({ statusCode: 200 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
