'use strict';
/**
 * Wave 1: the advertised installer must not clone a 404, write runtime=local,
 * apt-install Node 18, or tell anyone to init -n 9.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');

test('install.sh does not clone the 404 junction41 org repo', () => {
  assert.doesNotMatch(INSTALL, /github\.com\/junction41\/j41-sovagent-dispatcher/);
});

test('install.sh never writes runtime local', () => {
  assert.doesNotMatch(INSTALL, /RUNTIME=["']local["']/);
  assert.doesNotMatch(INSTALL, /"runtime":\s*"local"/);
  assert.doesNotMatch(INSTALL, /runtime:\s*["']local["']/);
});

test('install.sh never apt/dnf/nodesource-installs nodejs', () => {
  assert.doesNotMatch(INSTALL, /apt-get install\s+[^\n]*nodejs/);
  assert.doesNotMatch(INSTALL, /apt install\s+[^\n]*nodejs/);
  assert.doesNotMatch(INSTALL, /dnf install[^\n]*nodejs/);
  assert.doesNotMatch(INSTALL, /deb\.nodesource\.com/);
  assert.doesNotMatch(INSTALL, /rpm\.nodesource\.com/);
});

test('install.sh does not pipe get.docker.com into sh as the default action', () => {
  assert.doesNotMatch(INSTALL, /get\.docker\.com\s*\|\s*sh/);
  assert.doesNotMatch(INSTALL, /get\.docker\.com \| sudo/);
});

test('install.sh next step is doctor, not init -n 9', () => {
  assert.doesNotMatch(INSTALL, /init -n 9/);
  assert.match(INSTALL, /j41-dispatcher doctor/);
});

test('setup.sh is not a silent-local / init -n 9 path', () => {
  assert.doesNotMatch(SETUP, /RUNTIME=["']local["']/);
  assert.doesNotMatch(SETUP, /init -n 9/);
});

test('install.sh fail-closed: missing docker, no runtime=local config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-inst-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const realNode = process.execPath;
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec "${realNode}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho npm-stub "$@" >&2\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -s ] && echo Linux && exit 0\n[ "$1" = -m ] && echo x86_64 && exit 0\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "docker: command not found" >&2\nexit 127\n', { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:/bin`,
    J41_SKIP_NPM: '1',
    J41_INSTALL_NONINTERACTIVE: '1',
  };
  delete env.DOCKER_HOST;
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install.sh')], {
    env, encoding: 'utf8', timeout: 20000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.notEqual(r.status, 0, `expected fail-closed, got 0\n${out}`);
  assert.doesNotMatch(out, /runtime: local/i);
  const cfg = path.join(home, '.j41', 'dispatcher', 'config.json');
  if (fs.existsSync(cfg)) {
    const body = fs.readFileSync(cfg, 'utf8');
    assert.doesNotMatch(body, /"runtime"\s*:\s*"local"/);
  }
  assert.match(out, /docker/i);
});
