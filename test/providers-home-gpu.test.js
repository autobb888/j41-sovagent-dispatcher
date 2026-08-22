'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HomeGpuProvider } = require('../src/providers/home-gpu');
const { listProviderTypes } = require('../src/providers');

function stubDocker({ publishedPort = 22001, startError } = {}) {
  const created = []; const removed = [];
  return {
    created, removed,
    async createContainer(spec) {
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
});

test('waitReady fails closed without ssh_hostname', async () => {
  const p = new HomeGpuProvider({ docker: stubDocker(), __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 100 }), /HOME_GPU_NO_TUNNEL/);
});

test('waitReady start failure removes the container and does not stick the lock', async () => {
  const docker = stubDocker({ startError: new Error('start failed') });
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', docker, __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await assert.rejects(() => p.waitReady(lease, { timeoutMs: 1000 }), /start failed/);
  assert.equal(docker.removed.length, 1);
  assert.equal(docker.removed[0].opts.force, true);
  assert.equal((await p.discover()).length, 1);
});

test('release twice is success', async () => {
  const docker = stubDocker();
  const p = new HomeGpuProvider({ ssh_hostname: 'gpu.example.com', docker, __probeSsh: async () => true });
  const lease = await p.acquire((await p.discover())[0]);
  await p.waitReady(lease, { timeoutMs: 1000 });
  assert.equal((await p.release(lease)).state, 'released');
  assert.equal((await p.release(lease)).state, 'released');
});
