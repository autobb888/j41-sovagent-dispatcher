'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-home-gpu-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { HomeGpuProvider, assertTunnelHostname, assertTunnelPort, assertJailResources, jailImageRef } = require('../src/providers/home-gpu');
const { listProviderTypes } = require('../src/providers');

test('jailImageRef prefers cfg.jail_image over env default', () => {
  assert.equal(jailImageRef({ jail_image: 'j41/gpu-jail:custom' }), 'j41/gpu-jail:custom');
});

test('jailImageRef default matches J41_JAIL_IMAGE:J41_JAIL_TAG or j41/gpu-jail:latest', () => {
  const prevI = process.env.J41_JAIL_IMAGE;
  const prevT = process.env.J41_JAIL_TAG;
  delete process.env.J41_JAIL_IMAGE;
  delete process.env.J41_JAIL_TAG;
  try {
    assert.equal(jailImageRef({}), 'j41/gpu-jail:latest');
    assert.equal(jailImageRef({}), jailImageRef({ jail_image: undefined }));
  } finally {
    if (prevI === undefined) delete process.env.J41_JAIL_IMAGE; else process.env.J41_JAIL_IMAGE = prevI;
    if (prevT === undefined) delete process.env.J41_JAIL_TAG; else process.env.J41_JAIL_TAG = prevT;
  }
});

test('waitReady creates jailImageRef(cfg), not a hardcoded latest that ignores env', async () => {
  const docker = stubDocker();
  const provider = new HomeGpuProvider(homeCfg({
    jail_image: 'j41/gpu-jail:from-toml',
    docker,
    __probeSsh: async () => true,
  }));
  const lease = await provider.acquire();
  await provider.waitReady(lease);
  assert.equal(docker.created[0].Image, 'j41/gpu-jail:from-toml');
  await provider.release(lease);
});

test('assertTunnelHostname refuses loopback, wildcard, and HTTP webhook URLs', () => {
  assert.throws(() => assertTunnelHostname(''), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelHostname('127.0.0.1'), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelHostname('0.0.0.0'), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelHostname('https://alice.example.com'), /HOME_GPU_NO_TUNNEL/);
  assert.equal(assertTunnelHostname('gpu.alice.example.com'), 'gpu.alice.example.com');
});

test('assertTunnelPort requires integer 1-65535', () => {
  assert.throws(() => assertTunnelPort(undefined), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelPort(0), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelPort(65536), /HOME_GPU_NO_TUNNEL/);
  assert.throws(() => assertTunnelPort(22.5), /HOME_GPU_NO_TUNNEL/);
  assert.equal(assertTunnelPort(2222), 2222);
  assert.equal(assertTunnelPort('22'), 22);
});

test('assertJailResources requires memory_mb >= 256 and disk_gb >= 1', () => {
  assert.equal(typeof assertJailResources, 'function');
  assert.throws(() => assertJailResources({}), /HOME_GPU_NO_RAM/);
  assert.throws(() => assertJailResources({ memory_mb: 255, disk_gb: 40 }), /HOME_GPU_NO_RAM/);
  assert.throws(() => assertJailResources({ memory_mb: 0, disk_gb: 40 }), /HOME_GPU_NO_RAM/);
  assert.throws(() => assertJailResources({ memory_mb: 8192 }), /HOME_GPU_NO_DISK/);
  assert.throws(() => assertJailResources({ memory_mb: 8192, disk_gb: 0 }), /HOME_GPU_NO_DISK/);
  assert.deepEqual(assertJailResources({ memory_mb: 256, disk_gb: 1 }), { memoryMb: 256, diskGb: 1 });
  assert.deepEqual(assertJailResources({ memory_mb: '8192', disk_gb: '40' }), { memoryMb: 8192, diskGb: 40 });
});

function stubDocker({ publishedPort, startError, createError } = {}) {
  const created = []; const removed = [];
  return {
    created, removed,
    async createContainer(spec) {
      if (createError) throw createError;
      created.push(spec);
      const id = 'ctr-' + created.length;
      const bind = spec.HostConfig && spec.HostConfig.PortBindings && spec.HostConfig.PortBindings['22/tcp']
        && spec.HostConfig.PortBindings['22/tcp'][0];
      const hp = publishedPort != null ? String(publishedPort) : ((bind && bind.HostPort) || '0');
      const hip = (bind && bind.HostIp) || '127.0.0.1';
      return {
        id,
        async start() { if (startError) throw startError; },
        async inspect() {
          return { NetworkSettings: { Ports: { '22/tcp': [{ HostIp: hip, HostPort: hp }] } } };
        },
      };
    },
    getContainer(id) {
      return { id, async inspect() { return { State: { Running: true } }; }, async remove(opts) { removed.push({ id, opts }); } };
    },
  };
}

function homeCfg(extra = {}) {
  return {
    ssh_hostname: 'gpu.example.com',
    ssh_tunnel_port: 2222,
    device_index: 0,
    memory_mb: 8192,
    disk_gb: 40,
    docker: stubDocker(),
    __probeSsh: async () => true,
    ...extra,
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

test('waitReady publishes 22/tcp on 127.0.0.1:ssh_tunnel_port, never 0.0.0.0, never host net, and ssh has password', async () => {
  const probed = [];
  const docker = stubDocker();
  const p = new HomeGpuProvider({
    id: 'card0', device_index: 0, memory_mb: 8192, disk_gb: 40, gpu: 'RTX 5090', vram_gb: 32,
    ssh_hostname: 'gpu.example.com', ssh_tunnel_port: 2222, jail_image: 'j41/gpu-jail:test',
    docker, __probeSsh: async (port) => { probed.push(port); return true; },
  });
  const cand = (await p.discover())[0];
  let lease = await p.acquire(cand);
  lease = await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal(lease.state, 'ready');
  assert.equal(lease.ssh.host, 'gpu.example.com');
  assert.equal(lease.ssh.port, 2222);
  assert.equal(lease.ssh.user, 'renter');
  assert.ok(lease.ssh.password);
  assert.equal(lease.ssh.password, lease.meta.password);
  const spec = docker.created[0];
  assert.equal(spec.HostConfig.NetworkMode, 'bridge');
  assert.notEqual(spec.HostConfig.NetworkMode, 'host');
  assert.deepEqual(spec.HostConfig.PortBindings['22/tcp'][0], { HostIp: '127.0.0.1', HostPort: '2222' });
  assert.notEqual(spec.HostConfig.PortBindings['22/tcp'][0].HostIp, '0.0.0.0');
  assert.equal(spec.HostConfig.Memory, 8192 * 1024 * 1024);
  assert.ok(spec.HostConfig.Memory > 0);
  assert.ok(spec.HostConfig.Binds.some((b) => b.endsWith(':/workspace')));
  const jailDir = path.join(TEST_HOME, '.j41', 'dispatcher', 'jails', lease.id);
  assert.ok(spec.HostConfig.Binds.includes(`${jailDir}:/workspace`));
  assert.equal(fs.statSync(jailDir).mode & 0o777, 0o700);
  assert.equal(spec.HostConfig.StorageOpt.size, '40G');
  assert.deepEqual(spec.HostConfig.DeviceRequests[0].DeviceIDs, ['0']);
  assert.ok(spec.HostConfig.CapDrop.includes('ALL'));
  assert.ok(spec.HostConfig.CapAdd.includes('SETUID'));
  assert.ok(spec.HostConfig.CapAdd.includes('SETGID'));
  assert.ok(spec.HostConfig.CapAdd.includes('NET_BIND_SERVICE'));
  assert.deepEqual(probed, [2222]);
  assert.ok(spec.Env.includes(`J41_RENTER_PASSWORD=${lease.ssh.password}`));
  await p.release(lease);
});

test('waitReady fails closed without ssh_hostname and unlocks so discover is not stuck', async () => {
  const p = new HomeGpuProvider(homeCfg({ ssh_hostname: undefined, docker: stubDocker() }));
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 100 }), /HOME_GPU_NO_TUNNEL/);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('waitReady fails closed without ssh_tunnel_port and unlocks', async () => {
  const p = new HomeGpuProvider(homeCfg({ ssh_tunnel_port: undefined, docker: stubDocker() }));
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 100 }), /HOME_GPU_NO_TUNNEL|ssh_tunnel_port/);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('waitReady start failure removes the container and does not stick the lock', async () => {
  const docker = stubDocker({ startError: new Error('start failed') });
  const p = new HomeGpuProvider(homeCfg({ docker }));
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 1000 }), /start failed/);
  assert.equal(docker.removed.length, 1);
  assert.equal(docker.removed[0].opts.force, true);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('waitReady createContainer failure unlocks', async () => {
  const docker = stubDocker({ createError: new Error('create blew up') });
  const p = new HomeGpuProvider(homeCfg({ docker }));
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 1000 }), /create blew up/);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('waitReady requires memory_mb and disk_gb and never Memory 0', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({
    ssh_hostname: 'gpu.example.com', ssh_tunnel_port: 2222,
    docker, __probeSsh: async () => true,
    // no memory_mb / disk_gb
  });
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 100 }), /HOME_GPU_NO_RAM|HOME_GPU_NO_DISK/);
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
  assert.equal(docker.created.length, 0);
});

test('waitReady HostConfig has Memory, workspace bind, StorageOpt size', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({
    ssh_hostname: 'gpu.example.com', ssh_tunnel_port: 2222,
    memory_mb: 8192, disk_gb: 40, device_index: 0,
    docker, __probeSsh: async () => true,
  });
  await p.waitReady(await p.acquire((await p.discover())[0]), { timeoutMs: 1000 });
  const spec = docker.created[0];
  assert.equal(spec.HostConfig.Memory, 8192 * 1024 * 1024);
  assert.ok(spec.HostConfig.Binds.some((b) => b.endsWith(':/workspace')));
  assert.equal(spec.HostConfig.StorageOpt.size, '40G');
});

test('waitReady wraps storage-opt quota errors as HOME_GPU_NO_DISK_QUOTA and unlocks', async () => {
  const docker = stubDocker({
    createError: new Error("--storage-opt is supported only for overlay over xfs with 'pquota' mount option"),
  });
  const p = new HomeGpuProvider(homeCfg({ docker }));
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(
    () => p.waitReady(lease, { timeoutMs: 1000 }),
    /HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb \(need overlay2 over XFS -o prjquota, or btrfs\/zfs\):/,
  );
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('second discover is empty while the card is leased', async () => {
  const p = new HomeGpuProvider(homeCfg());
  assert.equal((await p.discover()).length, 1);
  const lease = await p.acquire((await p.discover())[0]);
  assert.equal((await p.discover()).length, 0);
  assert.equal(fs.existsSync(lockPath(0)), true);
  await p.release(lease);
});

test('release unlocks; discover returns the card again', async () => {
  const p = new HomeGpuProvider(homeCfg());
  const lease = await p.acquire((await p.discover())[0]);
  await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal((await p.discover()).length, 0);
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal((await p.discover()).length, 1);
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('file lock fails closed for a second provider instance on the same device_index', async () => {
  const p1 = new HomeGpuProvider(homeCfg({ docker: stubDocker() }));
  await p1.acquire((await p1.discover())[0]);
  const p2 = new HomeGpuProvider(homeCfg({ docker: stubDocker() }));
  await assert.rejects(() => p2.acquire({}), /HOME_GPU_BUSY|EEXIST/);
  await p1.release({});
});

test('release twice is success', async () => {
  const p = new HomeGpuProvider(homeCfg());
  const lease = await p.acquire((await p.discover())[0]);
  await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal(fs.existsSync(lockPath(0)), false);
});

test('reconstructed provider release unlinks the device lock so the next acquire is not HOME_GPU_BUSY', async () => {
  const docker1 = stubDocker();
  const p1 = new HomeGpuProvider(homeCfg({ docker: docker1 }));
  const lease = await p1.acquire((await p1.discover())[0]);
  await p1.waitReady(lease, { timeoutMs: 1000 });
  assert.equal(fs.existsSync(lockPath(0)), true);
  assert.ok(lease.meta.containerId);

  const docker2 = stubDocker();
  const crashed = new HomeGpuProvider(homeCfg({ docker: docker2 }));
  assert.equal(crashed._lockPath, null);
  assert.equal((await crashed.release(lease)).state, 'released');
  assert.equal(fs.existsSync(lockPath(0)), false);
  assert.equal(docker2.removed.length, 1);
  assert.equal(docker2.removed[0].id, lease.meta.containerId);

  const p3 = new HomeGpuProvider(homeCfg({ docker: stubDocker() }));
  const again = await p3.acquire((await p3.discover())[0]);
  assert.equal(again.state, 'pending');
  await p3.release(again);
});
