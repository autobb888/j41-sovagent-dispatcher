'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { ComputeProvider } = require('./base');

function assertTunnelHostname(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) throw new Error('HOME_GPU_NO_TUNNEL: ssh_hostname is required (TCP tunnel to 127.0.0.1:ssh, not the webhook URL)');
  if (h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '[::]') {
    throw new Error('HOME_GPU_NO_TUNNEL: ssh_hostname must not be loopback or 0.0.0.0');
  }
  if (h.startsWith('http://') || h.startsWith('https://')) {
    throw new Error('HOME_GPU_NO_TUNNEL: webhook URL is HTTP, not SSH');
  }
  return host.trim();
}

// Alice's TCP tunnel targets this loopback port. Never HostPort 0 (ephemeral) —
// the deliverable port would miss the jail.
function assertTunnelPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('HOME_GPU_NO_TUNNEL: ssh_tunnel_port must be an integer 1-65535');
  }
  return n;
}

function assertJailResources(cfg) {
  const memoryMb = Number(cfg.memory_mb);
  const diskGb = Number(cfg.disk_gb);
  if (!Number.isFinite(memoryMb) || memoryMb < 256) throw new Error('HOME_GPU_NO_RAM: memory_mb must be >= 256');
  if (!Number.isFinite(diskGb) || diskGb < 1) throw new Error('HOME_GPU_NO_DISK: disk_gb must be >= 1');
  return { memoryMb, diskGb };
}

function jailImageRef(pcfg = {}) {
  if (pcfg && pcfg.jail_image) return String(pcfg.jail_image);
  const name = process.env.J41_JAIL_IMAGE || 'j41/gpu-jail';
  const tag = process.env.J41_JAIL_TAG || 'latest';
  return `${name}:${tag}`;
}

function deviceLockPath(deviceIndex) {
  return path.join(os.homedir(), '.j41', 'dispatcher', 'locks', `gpu-${deviceIndex}.lock`);
}

// Loopback-only SSH banner probe. Never dials the tunnel hostname.
function defaultProbeSsh(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!p) return resolve(false);
    let settled = false;
    let sock;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already closed */ }
      resolve(!!ok);
    };
    try { sock = net.connect({ host: '127.0.0.1', port: p }); }
    catch { return resolve(false); }
    sock.setTimeout(timeoutMs);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('ascii');
      if (buf.includes('SSH-2.0')) finish(true);
    });
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.on('end', () => finish(false));
    sock.on('close', () => finish(false));
  });
}

function gone(err) {
  const code = err && (err.statusCode || err.status);
  const msg = String((err && err.message) || '');
  return code === 404 || /no such container/i.test(msg) || /\b404\b/.test(msg);
}

class HomeGpuProvider extends ComputeProvider {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.docker = cfg.docker || new (require('dockerode'))();
    this.__probeSsh = cfg.__probeSsh || defaultProbeSsh;
    this._busy = false;
    this._containerId = null;
    this._lockFd = null;
    this._lockPath = null;
  }

  get capabilities() {
    return { canProvision: true, canSsh: true, canScaleToZero: true, isElastic: false };
  }

  _deviceIndex() {
    return this.cfg.device_index ?? 0;
  }

  _gpu() {
    return {
      name: this.cfg.gpu || null,
      vramGb: this.cfg.vram_gb || null,
      count: this.cfg.gpu_count || 1,
    };
  }

  _takeFileLock() {
    const lockPath = deviceLockPath(this._deviceIndex());
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        throw new Error(`HOME_GPU_BUSY: device_index ${this._deviceIndex()} lock held at ${lockPath}`);
      }
      throw err;
    }
    this._lockFd = fd;
    this._lockPath = lockPath;
  }

  _dropFileLock(lease) {
    if (this._lockFd != null) {
      try { fs.closeSync(this._lockFd); } catch { /* already closed */ }
      this._lockFd = null;
    }
    // Always unlink the device lock, even if this instance did not open the fd
    // (reconstructed provider after crash still has to free the card).
    const idx = (lease && lease.meta && lease.meta.device_index != null)
      ? lease.meta.device_index
      : this._deviceIndex();
    const lockPath = this._lockPath || deviceLockPath(idx);
    try { fs.unlinkSync(lockPath); } catch (err) {
      if (!(err && err.code === 'ENOENT')) throw err;
    }
    this._lockPath = null;
  }

  _unlock(lease) {
    this._busy = false;
    this._dropFileLock(lease);
  }

  async discover() {
    if (this._busy) return [];
    return [{
      provider: 'home-gpu',
      usdPerHour: Number(this.cfg.usd_per_hour) || 0,
      gpu: this._gpu(),
      meta: { id: this.cfg.id, device_index: this.cfg.device_index },
    }];
  }

  async acquire(candidate) {
    if (this._busy) {
      throw new Error(`HOME_GPU_BUSY: device_index ${this._deviceIndex()} already leased`);
    }
    this._takeFileLock();
    this._busy = true;
    const password = crypto.randomBytes(16).toString('hex');
    return {
      id: this.cfg.id || `home-gpu:${this._deviceIndex()}`,
      provider: 'home-gpu',
      state: 'pending',
      baseUrl: null,
      ssh: null,
      gpu: (candidate && candidate.gpu) || this._gpu(),
      usdPerHour: Number(this.cfg.usd_per_hour) || 0,
      acquiredAt: Date.now(),
      expiresAt: null,
      private: true,
      meta: { password, device_index: this.cfg.device_index },
    };
  }

  async _forceRemove(id) {
    if (!id) return;
    try {
      await this.docker.getContainer(id).remove({ force: true });
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }

  async waitReady(lease, { timeoutMs = 60000 } = {}) {
    let container = null;
    try {
      const hostname = assertTunnelHostname(this.cfg.ssh_hostname);
      const tunnelPort = assertTunnelPort(this.cfg.ssh_tunnel_port);
      const { memoryMb, diskGb } = assertJailResources(this.cfg);
      const deviceId = String(this._deviceIndex());
      const password = (lease.meta && lease.meta.password) || crypto.randomBytes(16).toString('hex');
      if (lease.meta) lease.meta.password = password;
      else lease.meta = { password };

      const jailDir = path.join(os.homedir(), '.j41', 'dispatcher', 'jails', String(lease.id));
      fs.mkdirSync(jailDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(jailDir, 0o700);

      try {
        container = await this.docker.createContainer({
          Image: jailImageRef(this.cfg),
          Env: [`J41_RENTER_PASSWORD=${password}`],
          ExposedPorts: { '22/tcp': {} },
          HostConfig: {
            NetworkMode: 'bridge',
            PortBindings: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: String(tunnelPort) }] },
            Memory: memoryMb * 1024 * 1024,
            Binds: [`${jailDir}:/workspace`],
            StorageOpt: { size: `${diskGb}G` },
            PidsLimit: 1024,
            CapDrop: ['ALL'],
            CapAdd: ['NET_BIND_SERVICE', 'SETUID', 'SETGID', 'SYS_CHROOT', 'CHOWN', 'AUDIT_WRITE', 'KILL'],
            SecurityOpt: ['no-new-privileges:true'],
            DeviceRequests: [{
              Driver: 'nvidia',
              DeviceIDs: [deviceId],
              Capabilities: [['gpu']],
            }],
          },
        });
      } catch (err) {
        const msg = String((err && err.message) || '');
        if (/storage-opt|storage opt|storage option|\bquota\b/i.test(msg)) {
          throw new Error(`HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb (need overlay2 size or xfs pquota): ${err.message}`);
        }
        throw err;
      }
      // Record before start so a throw cannot orphan the jail or hide the id from release.
      this._containerId = container.id;
      lease.meta.containerId = container.id;

      await container.start();
      const inspect = await container.inspect();
      const binding = inspect && inspect.NetworkSettings && inspect.NetworkSettings.Ports
        && inspect.NetworkSettings.Ports['22/tcp'] && inspect.NetworkSettings.Ports['22/tcp'][0];
      const publishedPort = binding ? Number(binding.HostPort) : tunnelPort;
      lease.meta.publishedPort = publishedPort;

      const ssh = {
        host: hostname,
        port: tunnelPort,
        user: 'renter',
        password,
      };

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let up = false;
        try { up = !!(await this.__probeSsh(tunnelPort)); } catch { up = false; }
        if (up) return { ...lease, state: 'ready', ssh, meta: { ...lease.meta } };
        if (Date.now() >= deadline) return { ...lease, state: 'degraded', ssh, meta: { ...lease.meta } };
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (err) {
      try { await this._forceRemove(this._containerId || (container && container.id)); } catch { /* still unlock */ }
      this._containerId = null;
      this._unlock(lease);
      throw err;
    }
  }

  async probe(lease) {
    const id = (lease.meta && lease.meta.containerId) || this._containerId;
    if (!id) return { healthy: false, reason: 'no container' };
    try {
      const info = await this.docker.getContainer(id).inspect();
      if (!info.State || !info.State.Running) {
        return { healthy: false, reason: 'container not running' };
      }
      const port = Number.isInteger(Number(this.cfg.ssh_tunnel_port))
        ? Number(this.cfg.ssh_tunnel_port)
        : ((lease.meta && lease.meta.publishedPort) || 0);
      let up = false;
      try { up = !!(await this.__probeSsh(port)); } catch { up = false; }
      return { healthy: up, reason: up ? undefined : 'ssh not accepting' };
    } catch (err) {
      return { healthy: false, reason: (err && err.message) || 'inspect failed' };
    }
  }

  async release(lease) {
    const id = (lease && lease.meta && lease.meta.containerId) || this._containerId;
    await this._forceRemove(id);
    this._containerId = null;
    this._unlock(lease);
    return { ...lease, state: 'released' };
  }

  describeCost(lease) {
    const usd = Number(lease && lease.usdPerHour);
    return { usdPerHour: Number.isFinite(usd) ? usd : (Number(this.cfg.usd_per_hour) || 0), source: 'declared' };
  }
}

module.exports = { HomeGpuProvider, assertTunnelHostname, assertTunnelPort, assertJailResources, jailImageRef, deviceLockPath };
