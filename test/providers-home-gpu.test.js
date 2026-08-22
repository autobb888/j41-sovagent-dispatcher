'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-home-gpu-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { HomeGpuProvider, assertTunnelHostname } = require('../src/providers/home-gpu');
const { listProviderTypes } = require('../src/providers');

test('assertTunnelHostname refuses loopback, wildcard, and HTTP webhook URLs', () => {
  assert.throws(() => assertTunnelHostname(''), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelHostname('127.0.0.1'), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelHostname('0.0.0.0'), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelHostname('https://alice.example.com'), /HOME_GPU_NO_TUNNEL/);
  assert.equal(assertTunnelHostname('gpu.alice.example.com'), 'gpu.alice.example.com');
});

function stubDocker({ publishedPort = 22001, startError, createError } = {}) {
  const created = []; const removed = [];
  return {
    created, removed,
    async createContainer(spec) {
      if (createError) throw createError;
      created.push(spec);
      const id = 'ctr-' + created.length;
      return {
        id,
        async start() { if (startError) throw startError; },
        async inspect() {
          return { NetworkSettings: { Ports: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: String(publishedPort) }] } } };
        },
      };
    },
    getContainer(id) {
      return { id, async inspect() { return { State: { Running: true } }; }, async remove(opts) { removed.push({ id, opts }); } };
    },
  };
}

function lockPath(deviceIndex = 0) {
  return path.join(TEST_HOME, '.j41', 'dispatcher', 'locks', `gpu-${deviceIndex}.lock`);
}

function clearLocks() {
  const dir = path.join(TEST_HOME, '.j41', 'dispatcher', 'locks');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
  }
}

test.afterEach(() => { clearLocks(); });

test('home-gpu capabilities: contained SSH, not elastic', () => {
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com' });
  assert.deepEqual(p.capabilities, { canProvision: true, canSsh: true, canScaleToZero: true, isElastic: false });
});

test('registry lists home-gpu alongside local and vast only', () => {
  const types = listProviderTypes();
  assert.ok(types.includes('home-gpu'));
  assert.ok(types.includes('local'));
  assert.ok(types.includes('vast'));
});

test('waitReady publishes 22/tcp on 127.0.0.1, never 0.0.0.0, never host net, and ssh.host is the tunnel hostname', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({
    id: 'card0', device_index: 0, memory_mb: 8192, disk_gb: 40, gpu: 'RTX 5090', vram_gb: 32,
    ssh_hostname: 'gpu.example.com', ssh_tunnel_port: 2222, jail_image: 'j41/gpu-jail:test',
    docker, __probeSsh: async () => true,
  });
  const cand = (await p.discover())[0];
  let lease = await p.acquire(cand);
  lease = await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal(lease.state, 'ready');
  assert.equal(lease.ssh.host, 'gpu.example.com');
  assert.equal(lease.ssh.port, 2222);
  assert.equal(lease.ssh.user, 'renter');
  const spec = docker.created[0];
  assert.equal(spec.HostConfig.NetworkMode, 'bridge');
  assert.notEqual(spec.HostConfig.NetworkMode, 'host');
  assert.deepEqual(spec.HostConfig.PortBindings['22/tcp'][0], { HostIp: '127.0.0.1', HostPort: '0' });
  assert.equal(spec.HostConfig.Memory, 8192 * 1024 * 1024);
  assert.deepEqual(spec.HostConfig.DeviceRequests[0].DeviceIDs, ['0']);
  assert.ok(spec.HostConfig.CapDrop.includes('ALL'));
  assert.ok(spec.HostConfig.CapAdd.includes('SETUID'));
  assert.ok(spec.HostConfig.CapAdd.includes('SETGID'));
  assert.ok(spec.HostConfig.CapAdd.includes('NET_BIND_SERVICE'));
  await p.release(lease);
});

test('waitReady fails closed without ssh_hostname and unlocks so discover is not stuck', async () => {
  const p = new HomeGpuProvider({ device_index: 0, docker: stubDocker(), __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 100 }), /HOME_GPU_NO_TUNNEL/);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('waitReady start failure removes the container and does not stick the lock', async () => {
  const docker = stubDocker({ startError: new Error('start failed') });
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker, __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 1000 }), /start failed/);
  assert.equal(docker.removed.length, 1);
  assert.equal(docker.removed[0].opts.force, true);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('waitReady createContainer failure unlocks', async () => {
  const docker = stubDocker({ createError: new Error('create blew up') });
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker, __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 1000 }), /create blew up/);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('second discover is empty while the card is leased', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker, __probeSsh: async () => true });
  assert.equal((await p.discover()).length, 1);
  const lease = await p.acquire((await p.discover())[0]);
  assert.equal((await p.discover()).length, 0);
  assert.equal(fs.existsSync(lockPath(0)), true);
  await p.release(lease);
});

test('release unlocks; discover returns the card again', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker, __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal((await p.discover()).length, 0);
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('file lock fails closed for a second provider instance on the same device_index', async () => {
  const p1 = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker: stubDocker(), __probeSsh: async () => true });
  await p1.acquire((await p1.discover())[0]);
  const p2 = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker: stubDocker(), __probeSsh: async () => true });
  await assert.rejects(() => p2.acquire({}), /HOME_GPU_BUSY|EEXIST/);
  await p1.release({});
});

test('release twice is success', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', device_index: 0, docker, __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal(fs.existsSync(lockPath(0)), false);
});
