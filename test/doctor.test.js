'use strict';
/**
 * Contract tests for src/doctor.js (docs/spec-kit/mass-onboarding/contracts/doctor.md).
 * Injected deps only — no live Docker, API, or ~/.j41.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  CHECK_IDS,
  runDoctor,
  formatDoctorTable,
  formatIdentitySummary,
  classifyDockerError,
  classifyIdentities,
  dockerAdviceFromError,
  firstPasteCommand,
  listingAdvertiseRefusal,
  identityNext,
  pickNext,
} = require('../src/doctor');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-doctor-'));
}

function writeKeys(home, id, keys) {
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(keys), { mode: 0o600 });
}

function writeFinalize(home, id, stage) {
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'finalize-state.json'), JSON.stringify({ stage }));
}

function writeRuntime(home, runtime) {
  const dir = path.join(home, '.j41', 'dispatcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ runtime }));
}

function check(report, id) {
  return report.checks.find((c) => c.id === id);
}

function dockerExec({ version = 'Docker version 27.0.0', infoOk = true, infoErr, images = {}, driver = 'overlay2' } = {}) {
  return (cmd) => {
    const c = String(cmd);
    if (c.includes('docker --version') || c === 'docker --version') return version;
    if (c.includes('docker info')) {
      if (!infoOk) {
        const err = new Error(infoErr && infoErr.message ? infoErr.message : 'Cannot connect to the Docker daemon');
        if (infoErr && infoErr.code) err.code = infoErr.code;
        throw err;
      }
      if (c.includes('.Driver')) return `${driver}\n`;
      return 'Server Version: 27.0.0\n';
    }
    if (c.includes('docker image inspect')) {
      const name = c.includes('gpu-jail') ? 'gpu-jail' : 'job-agent';
      if (images[name]) return '';
      const err = new Error('no such image');
      err.code = 'ENOENT';
      throw err;
    }
    throw new Error(`unexpected exec: ${c}`);
  };
}

function baseOpts(over = {}) {
  const home = over.homedir || tmpHome();
  const now = over.now || Date.parse('2026-09-04T12:00:00Z');
  return {
    homedir: home,
    now: () => now,
    platform: 'linux',
    arch: 'x64',
    release: '6.8.0',
    nodeVersion: 'v22.19.0',
    packageVersion: '2.36.0',
    pathBinaryVersion: '2.36.0',
    env: {},
    procVersion: 'Linux',
    osReleaseId: 'ubuntu',
    osReleaseVersion: '24.04',
    dockerDesktopWSL2: null,
    execSync: dockerExec({ images: { 'job-agent': true } }),
    fetchDateHeader: new Date(now).toUTCString(),
    fetchOk: true,
    llm: { provider: 'groq', configured: true },
    computeEnabled: false,
    nvidiaRuntime: false,
    dockerDriver: 'overlay2',
    supportsStorageOpt: () => false,
    feeTankRows: [],
    ...over,
    homedir: home,
  };
}

test('Ubuntu 24.04, node 18.19.1: node fail, ok false', async () => {
  const report = await runDoctor(baseOpts({ nodeVersion: 'v18.19.1' }));
  assert.equal(check(report, 'node').status, 'fail');
  assert.equal(report.ok, false);
  assert.match(check(report, 'node').detail, /18/);
  assert.doesNotMatch(check(report, 'node').detail || '', /apt install nodejs/);
});

test('PATH j41-dispatcher reports 2.0.0: package fail, nextCommand scoped', async () => {
  const report = await runDoctor(baseOpts({ pathBinaryVersion: '2.0.0' }));
  assert.equal(check(report, 'package').status, 'fail');
  assert.match(check(report, 'package').nextCommand, /@junction41\/dispatcher/);
  assert.doesNotMatch(check(report, 'package').nextCommand, /npm i -g j41-dispatcher$/);
  assert.doesNotMatch(check(report, 'package').nextCommand, /npm install -g j41-dispatcher/);
});

test('Darwin 22 (macOS 13): os fail, gpuOffered false', async () => {
  const report = await runDoctor(baseOpts({
    platform: 'darwin',
    arch: 'arm64',
    release: '22.6.0',
    execSync: dockerExec({ images: { 'job-agent': true } }),
  }));
  assert.equal(report.os.macOSMajor, 22);
  assert.equal(report.os.supported, false);
  assert.equal(check(report, 'os').status, 'fail');
  assert.equal(report.gpuOffered, false);
  assert.equal(check(report, 'gpu.nvidia').status, 'skip');
  assert.equal(check(report, 'gpu.storage').status, 'skip');
  assert.equal(report.nextCommand, 'j41-dispatcher doctor');
  const next = nextSection(formatDoctorTable(report));
  assert.doesNotMatch(next, /macOS 14\+/);
  assert.doesNotMatch(next, /Start Docker/);
});

test('Darwin 23+ Docker Desktop sock: os pass, gpu skip', async () => {
  const home = tmpHome();
  const sock = path.join(home, '.docker', 'run', 'docker.sock');
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  fs.writeFileSync(sock, '');
  const report = await runDoctor(baseOpts({
    homedir: home,
    platform: 'darwin',
    arch: 'arm64',
    release: '23.6.0',
    dockerSockExists: (p) => p === sock || p.endsWith('docker.sock'),
  }));
  assert.equal(report.os.supported, true);
  assert.equal(check(report, 'os').status, 'pass');
  assert.equal(check(report, 'gpu.nvidia').status, 'skip');
  assert.equal(check(report, 'gpu.storage').status, 'skip');
  assert.equal(report.gpuOffered, false);
});

test('win32 Hyper-V (not WSL2): os fail', async () => {
  const report = await runDoctor(baseOpts({
    platform: 'win32',
    dockerDesktopWSL2: false,
  }));
  assert.equal(check(report, 'os').status, 'fail');
  assert.equal(report.os.supported, false);
  assert.equal(report.gpuOffered, false);
});

test('win32 Docker Desktop WSL2: os pass if daemon reachable', async () => {
  const report = await runDoctor(baseOpts({
    platform: 'win32',
    dockerDesktopWSL2: true,
  }));
  assert.equal(check(report, 'os').status, 'pass');
  assert.equal(report.os.supported, true);
});

test('docker EACCES: docker.group fail, never config --runtime local', async () => {
  const err = new Error('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock');
  err.code = 'EACCES';
  const report = await runDoctor(baseOpts({
    execSync: dockerExec({ infoOk: false, infoErr: err, images: {} }),
  }));
  assert.equal(check(report, 'docker.group').status, 'fail');
  const blob = JSON.stringify(report) + formatDoctorTable(report);
  assert.doesNotMatch(blob, /config --runtime local/);
  assert.match(check(report, 'docker.group').nextCommand, /newgrp docker/);
});

test('classifyDockerError maps ENOENT vs EACCES', () => {
  const a = classifyDockerError(Object.assign(new Error('connect EACCES /var/run/docker.sock'), { code: 'EACCES' }));
  const n = classifyDockerError(Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' }));
  assert.equal(a, 'eacces');
  assert.equal(n, 'enoent');
});

test('Mac ENOENT on default sock, Desktop sock present: docker.sock pass', async () => {
  const home = tmpHome();
  const desktop = path.join(home, '.docker', 'run', 'docker.sock');
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, '');
  let seen = [];
  const execSync = (cmd) => {
    seen.push(String(cmd));
    const c = String(cmd);
    if (c.includes('--version')) return 'Docker version 27.0.0';
    if (c.includes('docker info') && process.env.DOCKER_HOST && process.env.DOCKER_HOST.includes('docker.sock')) {
      return 'Server Version: 27\n';
    }
    if (c.includes('docker info')) {
      const err = new Error('connect ENOENT /var/run/docker.sock');
      err.code = 'ENOENT';
      throw err;
    }
    if (c.includes('image inspect')) return '';
    throw new Error(c);
  };
  const report = await runDoctor(baseOpts({
    homedir: home,
    platform: 'darwin',
    release: '23.6.0',
    execSync,
    dockerSockExists: (p) => p === desktop,
  }));
  assert.equal(check(report, 'docker.sock').status, 'pass');
});

test('config.json runtime local: runtime fail, nextCommand docker not local', async () => {
  const home = tmpHome();
  writeRuntime(home, 'local');
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'runtime').status, 'fail');
  assert.match(check(report, 'runtime').nextCommand, /config --runtime docker/);
  assert.doesNotMatch(check(report, 'runtime').nextCommand, /--runtime local/);
});

test('clock skew 65 min: clock fail, NTP copy-paste', async () => {
  const now = Date.parse('2026-09-04T12:00:00Z');
  const report = await runDoctor(baseOpts({
    now: () => now,
    fetchDateHeader: new Date(now + 65 * 60 * 1000).toUTCString(),
  }));
  assert.equal(check(report, 'clock').status, 'fail');
  assert.match(check(report, 'clock').copyPasteBlock, /timedatectl set-ntp true/);
});

test('omitted feeTankRows loads fee-tank-status.json from homedir (32 writes is low)', async () => {
  const home = tmpHome();
  writeKeys(home, 'gpu-1', { identity: 'testgpu01.agentplatform@', iAddress: 'iSeRTHj42a5QBHkX1njACV4iup5t4eqHYF', kind: 'compute' });
  writeFinalize(home, 'gpu-1', 'ready');
  const dir = path.join(home, '.j41', 'dispatcher');
  fs.writeFileSync(path.join(dir, 'fee-tank-status.json'), JSON.stringify({
    at: Date.now(),
    agents: [{ agentId: 'gpu-1', writes: 32, reason: 'below-floor-unfunded', needsFunding: false }],
  }));
  const opts = baseOpts({ homedir: home });
  delete opts.feeTankRows;
  const report = await runDoctor(opts);
  const ft = check(report, 'fee-tank');
  assert.equal(ft.status, 'warn');
  assert.match(ft.detail, /low/i);
  assert.doesNotMatch(ft.detail, /EMPTY/);
  assert.doesNotMatch(ft.detail, /no snapshot/);
});

test('wallet row 32 writes: fee-tank warn low, detail MUST NOT contain EMPTY', async () => {
  const home = tmpHome();
  writeKeys(home, 'gpu-1', { identity: 'testgpu01.agentplatform@', iAddress: 'iSeRTHj42a5QBHkX1njACV4iup5t4eqHYF', kind: 'compute' });
  writeFinalize(home, 'gpu-1', 'ready');
  const report = await runDoctor(baseOpts({
    homedir: home,
    feeTankRows: [{ agentId: 'gpu-1', writes: 32, status: 'low' }],
  }));
  const ft = check(report, 'fee-tank');
  assert.equal(ft.status, 'warn');
  assert.match(ft.detail, /low/i);
  assert.doesNotMatch(ft.detail, /EMPTY/);
  assert.equal(report.identities[0].feeTank, 'low');
});

test('wallet row 0 feeSats, sweepable: fee-tank fail empty-sweepable', async () => {
  const home = tmpHome();
  writeKeys(home, 'agent-1', { identity: 'a.agentplatform@', iAddress: 'iXXXX', kind: 'agent' });
  const report = await runDoctor(baseOpts({
    homedir: home,
    feeTankRows: [{ agentId: 'agent-1', writes: 0, status: 'empty-sweepable' }],
  }));
  assert.equal(check(report, 'fee-tank').status, 'fail');
  assert.match(check(report, 'fee-tank').nextCommand, /wallet sweep/);
});

test('5 local keys.json, 0 iAddress: all local-only; summary must not say registered', async () => {
  const home = tmpHome();
  for (let i = 1; i <= 5; i++) writeKeys(home, `agent-${i}`, { kind: 'agent' });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(report.identities.length, 5);
  assert.ok(report.identities.every((r) => r.stage === 'local-only'));
  const summary = formatIdentitySummary(report.identities);
  assert.doesNotMatch(summary, /registered/i);
  const table = formatDoctorTable(report);
  assert.doesNotMatch(table, /5 registered/);
  assert.match(summary, /local-only/);
});

test('linux overlayfs + compute configured: gpu.storage fail', async () => {
  const home = tmpHome();
  writeKeys(home, 'gpu-1', { identity: 'g.agentplatform@', iAddress: 'iABC', kind: 'compute' });
  const report = await runDoctor(baseOpts({
    homedir: home,
    computeEnabled: true,
    nvidiaRuntime: true,
    dockerDriver: 'overlayfs',
    supportsStorageOpt: () => false,
    execSync: dockerExec({ images: { 'job-agent': true, 'gpu-jail': true }, driver: 'overlayfs' }),
  }));
  assert.equal(report.gpuOffered, true);
  assert.equal(check(report, 'gpu.storage').status, 'fail');
  assert.match(check(report, 'gpu.storage').detail, /overlay2|prjquota|overlayfs/i);
  assert.equal(report.nextCommand, 'j41-dispatcher doctor');
  const next = nextSection(formatDoctorTable(report));
  assert.doesNotMatch(next, /Linux NVIDIA hosts only/);
});

test('darwin doctor JSON: gpu checks skip, not fail', async () => {
  const report = await runDoctor(baseOpts({ platform: 'darwin', release: '23.0.0' }));
  assert.equal(check(report, 'gpu.nvidia').status, 'skip');
  assert.equal(check(report, 'gpu.storage').status, 'skip');
  assert.equal(report.gpuOffered, false);
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /"id":"gpu.nvidia","name":".+","status":"fail"/);
});

test('JSON report has required top-level keys and no secrets', async () => {
  const home = tmpHome();
  writeKeys(home, 'agent-1', {
    identity: 'x.agentplatform@',
    iAddress: 'iABC',
    wif: 'UwJthisisnotarealwifbutlongenough',
    kind: 'agent',
  });
  const report = await runDoctor(baseOpts({
    homedir: home,
    llm: { provider: 'groq', configured: true, apiKey: 'gsk_SECRETKEYVALUE' },
  }));
  for (const k of ['ok', 'generatedAt', 'version', 'os', 'checks', 'identities', 'nextCommand', 'copyPasteBlock', 'gpuOffered']) {
    assert.ok(k in report, `missing ${k}`);
  }
  const blob = JSON.stringify(report);
  assert.doesNotMatch(blob, /UwJthisisnotarealwifbutlongenough/);
  assert.doesNotMatch(blob, /gsk_SECRETKEYVALUE/);
});

test('classifyIdentities: local vs on-chain vs finalized', () => {
  const home = tmpHome();
  writeKeys(home, 'a', { kind: 'agent' });
  writeKeys(home, 'b', { identity: 'b.agentplatform@', iAddress: 'iBBB', kind: 'agent' });
  writeKeys(home, 'c', { identity: 'c.agentplatform@', iAddress: 'iCCC', kind: 'agent' });
  writeFinalize(home, 'c', 'ready');
  const rows = classifyIdentities(path.join(home, '.j41', 'dispatcher', 'agents'));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.a.stage, 'local-only');
  assert.equal(byId.b.stage, 'on-chain');
  assert.equal(byId.c.stage, 'finalized');
  assert.equal(byId.a.onChain, false);
  assert.equal(byId.c.finalized, true);
});

test('formatDoctorTable never recommends runtime local', async () => {
  const err = new Error('connect ENOENT /var/run/docker.sock');
  err.code = 'ENOENT';
  const report = await runDoctor(baseOpts({
    execSync: dockerExec({ infoOk: false, infoErr: err, images: {} }),
  }));
  const table = formatDoctorTable(report);
  assert.doesNotMatch(table, /config --runtime local/);
  assert.match(table, /Next:/);
});

function nextSection(table) {
  const after = String(table).split('Next:')[1] || '';
  return after.split('Copy-paste:')[0];
}

test('darwin no Docker CLI: nextCommand is open -a Docker, Next is not start', async () => {
  const report = await runDoctor(baseOpts({
    platform: 'darwin',
    arch: 'arm64',
    release: '23.6.0',
    execSync: () => { throw new Error('command not found: docker'); },
  }));
  assert.equal(check(report, 'docker.cli').status, 'fail');
  assert.match(report.nextCommand, /open -a Docker/);
  const next = nextSection(formatDoctorTable(report));
  assert.doesNotMatch(next, /j41-dispatcher start/);
  assert.doesNotMatch(next, /Start Docker Desktop/);
  assert.match(next, /open -a Docker/);
});

test('darwin ENOENT sock: sock detail is Desktop path, nextCommand open -a Docker', async () => {
  const home = tmpHome();
  const err = new Error('connect ENOENT /var/run/docker.sock');
  err.code = 'ENOENT';
  const report = await runDoctor(baseOpts({
    homedir: home,
    platform: 'darwin',
    arch: 'arm64',
    release: '23.6.0',
    execSync: dockerExec({ infoOk: false, infoErr: err, images: {} }),
    dockerSockExists: () => false,
  }));
  const sock = check(report, 'docker.sock');
  assert.equal(sock.status, 'fail');
  assert.match(sock.detail, /\.docker\/run\/docker\.sock/);
  assert.match(report.nextCommand, /open -a Docker/);
  const next = nextSection(formatDoctorTable(report));
  assert.doesNotMatch(next, /j41-dispatcher start/);
  assert.doesNotMatch(next, /Start Docker Desktop/);
});

test('darwin GPU human table: exactly one GPU line, not three linux NVIDIA chapter lines', async () => {
  const report = await runDoctor(baseOpts({
    platform: 'darwin',
    arch: 'arm64',
    release: '23.6.0',
  }));
  assert.equal(check(report, 'gpu.nvidia').status, 'skip');
  assert.equal(check(report, 'gpu.storage').status, 'skip');
  const table = formatDoctorTable(report);
  const gpuLines = table.split('\n').filter((l) => /\bGPU\b/.test(l));
  assert.equal(gpuLines.length, 1, table);
  assert.match(gpuLines[0], /Linux NVIDIA hosts only/);
  assert.doesNotMatch(table, /linux NVIDIA chapter/);
});

test('win32 no Docker CLI: nextCommand is wsl.exe, not Start Docker Desktop', async () => {
  const report = await runDoctor(baseOpts({
    platform: 'win32',
    dockerDesktopWSL2: true,
    execSync: () => { throw new Error('not found'); },
  }));
  assert.equal(check(report, 'docker.cli').status, 'fail');
  assert.match(report.nextCommand, /wsl\.exe -e docker info/);
  const next = nextSection(formatDoctorTable(report));
  assert.doesNotMatch(next, /j41-dispatcher start/);
  assert.doesNotMatch(next, /Start Docker Desktop/);
});

test('firstPasteCommand allowlists argv only', () => {
  assert.equal(firstPasteCommand('Linux NVIDIA hosts only.\nopen -a Docker'), 'open -a Docker');
  assert.equal(firstPasteCommand('macOS 14+ (Sonoma) and Docker Desktop are required.'), null);
  assert.equal(firstPasteCommand('sudo apt install docker.io'), 'sudo apt install docker.io');
});

test('dockerAdviceFromError darwin eacces does not claim /var/run/docker.sock', () => {
  const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const advice = dockerAdviceFromError(err, 'darwin');
  assert.doesNotMatch(advice.message, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(advice.message, /group docker/);
  assert.equal(advice.nextCommand, 'open -a Docker');
});

function writeAgentConfig(home, id, config) {
  const dir = path.join(home, '.j41', 'dispatcher', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-config.json'), JSON.stringify(config), { mode: 0o600 });
}

test('CHECK_IDS includes rental.ssh_public, model.public_url, model.webhook, data.endpoint, image.canonicalize', () => {
  for (const id of ['rental.ssh_public', 'model.public_url', 'model.webhook', 'data.endpoint', 'image.canonicalize']) {
    assert.ok(CHECK_IDS.includes(id), id);
  }
});

test('compute agent RFC1918 ssh_hostname: rental.ssh_public fail', async () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  delete process.env.J41_ALLOW_LAN_RENTAL;
  try {
    const home = tmpHome();
    writeKeys(home, 'gpu-1', { identity: 'g.sovcompute@', iAddress: 'iABC', kind: 'compute' });
    const report = await runDoctor(baseOpts({
      homedir: home,
      computeEnabled: true,
      nvidiaRuntime: true,
      supportsStorageOpt: () => true,
      execSync: dockerExec({ images: { 'job-agent': true, 'gpu-jail': true } }),
      cfg: {
        compute: {
          enabled: true,
          providers: {
            card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: '192.168.1.69', ssh_tunnel_port: 2222 },
          },
        },
      },
    }));
    assert.equal(check(report, 'rental.ssh_public').status, 'fail');
    assert.match(check(report, 'rental.ssh_public').detail, /RENTAL_LAN_HOST|192\.168\.1\.69/);
    assert.equal(report.ok, false);
  } finally {
    if (prev === undefined) delete process.env.J41_ALLOW_LAN_RENTAL;
    else process.env.J41_ALLOW_LAN_RENTAL = prev;
  }
});

test('compute agent public ssh_hostname: rental.ssh_public pass', async () => {
  const home = tmpHome();
  writeKeys(home, 'gpu-1', { identity: 'g.sovcompute@', iAddress: 'iABC', kind: 'compute' });
  const report = await runDoctor(baseOpts({
    homedir: home,
    computeEnabled: true,
    nvidiaRuntime: true,
    supportsStorageOpt: () => true,
    execSync: dockerExec({ images: { 'job-agent': true, 'gpu-jail': true } }),
    cfg: {
      compute: {
        enabled: true,
        providers: {
          card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: 'gpu.example.com', ssh_tunnel_port: 2222 },
        },
      },
    },
  }));
  assert.equal(check(report, 'rental.ssh_public').status, 'pass');
});

test('api-endpoint agent missing publicUrl: model.public_url fail', async () => {
  const home = tmpHome();
  writeKeys(home, 'model-1', { identity: 'm.sovmodel@', iAddress: 'iMDL', kind: 'model' });
  writeAgentConfig(home, 'model-1', { serviceType: 'api-endpoint', apiEndpointUrl: 'http://127.0.0.1:11434/v1' });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'model.public_url').status, 'fail');
  assert.equal(report.ok, false);
});

test('api-endpoint agent with publicUrl: model.public_url pass', async () => {
  const home = tmpHome();
  writeKeys(home, 'model-1', { identity: 'm.sovmodel@', iAddress: 'iMDL', kind: 'model' });
  writeAgentConfig(home, 'model-1', {
    serviceType: 'api-endpoint',
    apiEndpointUrl: 'http://127.0.0.1:11434/v1',
    publicUrl: 'https://proxy.example.com',
  });
  const report = await runDoctor(baseOpts({
    homedir: home,
    cfg: { runtime: { webhook_url: 'https://proxy.example.com' } },
  }));
  assert.equal(check(report, 'model.public_url').status, 'pass');
});

test('api-endpoint listed without webhook bind: model.webhook fail', async () => {
  const home = tmpHome();
  writeKeys(home, 'model-1', { identity: 'm.sovmodel@', iAddress: 'iMDL', kind: 'model' });
  writeAgentConfig(home, 'model-1', {
    serviceType: 'api-endpoint',
    publicUrl: 'https://proxy.example.com',
  });
  const report = await runDoctor(baseOpts({
    homedir: home,
    cfg: { runtime: { webhook_url: '' } },
  }));
  assert.equal(check(report, 'model.webhook').status, 'fail');
});

test('api-endpoint listed with webhook_url: model.webhook pass', async () => {
  const home = tmpHome();
  writeKeys(home, 'model-1', { identity: 'm.sovmodel@', iAddress: 'iMDL', kind: 'model' });
  writeAgentConfig(home, 'model-1', {
    serviceType: 'api-endpoint',
    publicUrl: 'https://proxy.example.com',
  });
  const report = await runDoctor(baseOpts({
    homedir: home,
    cfg: { runtime: { webhook_url: 'https://proxy.example.com' } },
  }));
  assert.equal(check(report, 'model.webhook').status, 'pass');
});

test('no compute/model listings: rental.ssh_public and model checks skip', async () => {
  const home = tmpHome();
  writeKeys(home, 'agent-1', { identity: 'a.agentplatform@', iAddress: 'iAAA', kind: 'agent' });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'rental.ssh_public').status, 'skip');
  assert.equal(check(report, 'model.public_url').status, 'skip');
  assert.equal(check(report, 'model.webhook').status, 'skip');
  assert.equal(check(report, 'data.endpoint').status, 'skip');
});

test('0 identities: identity Next is labour setup agent-1; llm skip', async () => {
  const report = await runDoctor(baseOpts({ llm: { configured: false } }));
  assert.equal(check(report, 'llm').status, 'skip');
  assert.equal(check(report, 'identity').status, 'warn');
  assert.match(check(report, 'identity').nextCommand, /setup agent-1 .* --template code-review/);
  assert.doesNotMatch(check(report, 'identity').nextCommand, /data-1/);
});

test('existing data-1 folder must not invent agent-1', async () => {
  const home = tmpHome();
  writeKeys(home, 'data-1', { kind: 'data' });
  const report = await runDoctor(baseOpts({ homedir: home, llm: { configured: false } }));
  assert.equal(check(report, 'llm').status, 'skip');
  assert.equal(check(report, 'identity').status, 'warn');
  assert.match(check(report, 'identity').nextCommand, /setup data-1 /);
  assert.match(check(report, 'identity').nextCommand, /--kind data/);
  assert.doesNotMatch(check(report, 'identity').nextCommand, /agent-1/);
  assert.equal(check(report, 'data.endpoint').status, 'skip');
});

test('on-chain data listing without HTTP(S) endpoint: data.endpoint fail', async () => {
  const home = tmpHome();
  writeKeys(home, 'data-1', { identity: 'corpus.agentplatform@', iAddress: 'iDATA', kind: 'data' });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'data.endpoint').status, 'fail');
  assert.match(check(report, 'data.endpoint').nextCommand, /data-setup data-1 --website https:\/\//);
  assert.equal(report.ok, false);
});

test('on-chain data listing with ephemeral URL: data.endpoint fail', async () => {
  const home = tmpHome();
  writeKeys(home, 'data-1', { identity: 'corpus.agentplatform@', iAddress: 'iDATA', kind: 'data' });
  writeAgentConfig(home, 'data-1', { website: 'https://dead.trycloudflare.com/apples.json' });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'data.endpoint').status, 'fail');
  assert.match(check(report, 'data.endpoint').detail, /ephemeral|trycloudflare/);
});

test('on-chain data listing with HTTP(S) website: data.endpoint pass', async () => {
  const home = tmpHome();
  writeKeys(home, 'data-1', { identity: 'corpus.agentplatform@', iAddress: 'iDATA', kind: 'data' });
  writeAgentConfig(home, 'data-1', { website: 'https://data.example/apples.json' });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'data.endpoint').status, 'pass');
});

test('on-chain data listing with local-only URL: data.endpoint fail', async () => {
  const home = tmpHome();
  writeKeys(home, 'data-1', { identity: 'corpus.agentplatform@', iAddress: 'iDATA', kind: 'data' });
  writeAgentConfig(home, 'data-1', { website: 'https://data.example/apples.json', dataEndpointLocalOnly: true });
  const report = await runDoctor(baseOpts({ homedir: home }));
  assert.equal(check(report, 'data.endpoint').status, 'fail');
  assert.match(check(report, 'data.endpoint').detail, /local-only|browse will not see/);
  assert.match(check(report, 'data.endpoint').nextCommand, /data-setup data-1 --website/);
  assert.equal(report.ok, false);
});

test('listingAdvertiseRefusal data without endpoint', () => {
  const home = tmpHome();
  writeKeys(home, 'data-1', { identity: 'corpus.agentplatform@', kind: 'data' });
  const missing = listingAdvertiseRefusal({
    agentId: 'data-1',
    keys: { identity: 'corpus.agentplatform@', kind: 'data' },
    agentsDir: path.join(home, '.j41', 'dispatcher', 'agents'),
  });
  assert.equal(missing.code, 'data.endpoint');

  writeAgentConfig(home, 'data-1', { website: 'https://data.example/apples.json' });
  const ok = listingAdvertiseRefusal({
    agentId: 'data-1',
    keys: { identity: 'corpus.agentplatform@', kind: 'data' },
    agentsDir: path.join(home, '.j41', 'dispatcher', 'agents'),
  });
  assert.equal(ok, null);

  writeAgentConfig(home, 'data-1', { website: 'https://data.example/apples.json', dataEndpointLocalOnly: true });
  const localOnly = listingAdvertiseRefusal({
    agentId: 'data-1',
    keys: { identity: 'corpus.agentplatform@', kind: 'data' },
    agentsDir: path.join(home, '.j41', 'dispatcher', 'agents'),
  });
  assert.equal(localOnly.code, 'data.endpoint');
});

test('pickNext includes data.endpoint, model.webhook, model.public_url', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'doctor.js'), 'utf8');
  assert.match(src, /data\.endpoint.*model\.webhook.*model\.public_url/);
  const hit = pickNext([
    { id: 'os', status: 'pass' },
    { id: 'data.endpoint', status: 'fail', nextCommand: 'j41-dispatcher data-setup data-1 --website https://...' },
  ]);
  assert.match(hit.nextCommand, /data-setup data-1/);
});

test('pickNext all-green data-only is listings --kind data, not start', () => {
  const data = pickNext(
    [{ id: 'os', status: 'pass' }, { id: 'data.endpoint', status: 'pass' }],
    [{ id: 'data-1', kind: 'data', onChain: true, identity: 'corpus.agentplatform@' }],
  );
  assert.equal(data.nextCommand, 'j41-dispatcher listings --kind data');
  assert.match(data.copyPasteBlock, /browse corpus\.agentplatform@/);
  assert.doesNotMatch(data.nextCommand, /start/);

  const labour = pickNext(
    [{ id: 'os', status: 'pass' }],
    [{ id: 'agent-1', kind: 'agent', onChain: true, identity: 'alice.agentplatform@' }],
  );
  assert.equal(labour.nextCommand, 'j41-dispatcher start');

  const mixed = pickNext(
    [{ id: 'os', status: 'pass' }],
    [
      { id: 'data-1', kind: 'data', onChain: true, identity: 'corpus.agentplatform@' },
      { id: 'agent-1', kind: 'agent', onChain: true, identity: 'alice.agentplatform@' },
    ],
  );
  assert.equal(mixed.nextCommand, 'j41-dispatcher start');
});

test('identityNext: 0 identities keep labour default; data-1 is not agent-1', () => {
  const none = identityNext([]);
  assert.match(none.nextCommand, /setup agent-1 <name> --template code-review/);
  const data = identityNext([{ id: 'data-1', kind: 'data' }]);
  assert.match(data.nextCommand, /setup data-1 <name> --kind data/);
  assert.doesNotMatch(data.nextCommand, /agent-1/);
});

test('image.canonicalize warns when docker is missing', async () => {
  const report = await runDoctor(baseOpts({
    execSync: () => { throw new Error('command not found: docker'); },
  }));
  assert.equal(check(report, 'docker.cli').status, 'fail');
  assert.equal(check(report, 'image.canonicalize').status, 'warn');
});

test('image.canonicalize fails on linux labour host when pin is missing', async () => {
  const home = tmpHome();
  writeKeys(home, 'agent-1', { identity: 'a.agentplatform@', iAddress: 'iAAA', kind: 'agent' });
  const report = await runDoctor(baseOpts({
    homedir: home,
    jobAgentPackageJson: JSON.stringify({ dependencies: { undici: '^5.29.0' } }),
    execSync: dockerExec({ images: { 'job-agent': true } }),
  }));
  assert.equal(check(report, 'image.canonicalize').status, 'fail');
});

test('image.canonicalize passes when json-canonicalize@2.0.0 is pinned', async () => {
  const home = tmpHome();
  writeKeys(home, 'agent-1', { identity: 'a.agentplatform@', iAddress: 'iAAA', kind: 'agent' });
  const report = await runDoctor(baseOpts({
    homedir: home,
    jobAgentPackageJson: JSON.stringify({
      dependencies: { 'json-canonicalize': '2.0.0' },
    }),
    execSync: dockerExec({ images: { 'job-agent': true } }),
  }));
  assert.equal(check(report, 'image.canonicalize').status, 'pass');
});

test('listingAdvertiseRefusal skips labour; refuses LAN compute and model without publicUrl', () => {
  const prev = process.env.J41_ALLOW_LAN_RENTAL;
  delete process.env.J41_ALLOW_LAN_RENTAL;
  try {
    assert.equal(listingAdvertiseRefusal({
      agentId: 'agent-1',
      keys: { identity: 'a.agentplatform@', kind: 'agent' },
      cfg: {},
      agentsDir: '/tmp/nope',
    }), null);

    const lan = listingAdvertiseRefusal({
      agentId: 'gpu-1',
      keys: { identity: 'g.sovcompute@', kind: 'compute' },
      cfg: {
        compute: { providers: { card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: '192.168.1.69' } } },
      },
    });
    assert.equal(lan.code, 'rental.ssh_public');

    const edge = listingAdvertiseRefusal({
      agentId: 'gpu-1',
      keys: { identity: 'g.sovcompute@', kind: 'compute' },
      cfg: {
        compute: { providers: { card0: { type: 'home-gpu', agent_id: 'gpu-1', ssh_hostname: '192.168.1.69' } } },
      },
      outboundSshV1: true,
    });
    assert.equal(edge, null);

    const home = tmpHome();
    writeAgentConfig(home, 'model-1', { serviceType: 'api-endpoint' });
    const missing = listingAdvertiseRefusal({
      agentId: 'model-1',
      keys: { identity: 'm.sovmodel@', kind: 'model' },
      cfg: { runtime: { webhook_url: 'https://proxy.example.com' } },
      agentsDir: path.join(home, '.j41', 'dispatcher', 'agents'),
    });
    assert.equal(missing.code, 'model.public_url');
  } finally {
    if (prev === undefined) delete process.env.J41_ALLOW_LAN_RENTAL;
    else process.env.J41_ALLOW_LAN_RENTAL = prev;
  }
});
