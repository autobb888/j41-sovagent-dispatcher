'use strict';
/**
 * F10 — `init -n <non-numeric>` must exit 1, not report "✅ NaN agents initialized".
 * Count must be an integer 1–100. Default remains 9.
 * Spawns the real CLI with HOME under os.tmpdir() — never the real ~/.j41.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
const PARENT_NM = process.env.NODE_PATH
  || [
    path.join(ROOT, 'node_modules'),
    '/home/xd322/src/j41-sovagent-dispatcher-integrate/node_modules',
  ].find((p) => fs.existsSync(path.join(p, 'commander')));

function runInit(home, args) {
  const env = { ...process.env, HOME: home };
  if (PARENT_NM) env.NODE_PATH = PARENT_NM;
  delete env.NODE_ENV;
  return spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'init', ...args], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('init -n default remains 9', () => {
  const start = CLI.indexOf(".command('init')");
  const body = CLI.slice(start, CLI.indexOf(".command('register", start));
  assert.match(body, /--agents <number>.*'9'/);
  assert.match(body, /parseInt\(options\.agents, 10\)/);
  assert.match(body, /Number\.isInteger\(count\) \|\| count < 1 \|\| count > 100/);
  assert.match(body, /process\.exit\(1\)/);
});

test('init -n non-numeric / 0 / 101 exit 1 and write no agents', () => {
  for (const n of ['abc', '0', '101', 'NaN', '-1']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-init-'));
    try {
      const r = runInit(home, ['-n', n]);
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      assert.equal(r.status, 1, `init -n ${n} should exit 1\n${out}`);
      assert.doesNotMatch(out, /NaN agents initialized/);
      assert.match(out, /1 to 100/);
      const agents = path.join(home, '.j41', 'dispatcher', 'agents');
      assert.equal(fs.existsSync(agents), false, `invalid -n ${n} must not create agents/`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('init -n 1 creates one agent under HOME tmp', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-init-'));
  try {
    const r = runInit(home, ['-n', '1']);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    assert.equal(r.status, 0, `init -n 1 failed\n${out}`);
    assert.match(out, /1 agents initialized/);
    const agentDir = path.join(home, '.j41', 'dispatcher', 'agents', 'agent-1');
    assert.equal(fs.existsSync(path.join(agentDir, 'keys.json')), true);
    assert.equal(fs.existsSync(path.join(home, '.j41', 'dispatcher', 'agents', 'agent-2')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
