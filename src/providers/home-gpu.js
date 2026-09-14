'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
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
  // RFC1918 is warn-only here so rental-setup / TUI can still write config.
  // Accept and deliverSealed refuse unless J41_ALLOW_LAN_RENTAL=1.
  try {
    const { isLanSshHost } = require('../ssh-host');
    if (isLanSshHost(host)) {
      console.warn(`HOME_GPU_LAN_HOST: ssh_hostname ${host.trim()} is RFC1918/LAN — gpu-rental jobs will not be accepted until a named TCP tunnel is set or J41_ALLOW_LAN_RENTAL=1`);
    }
  } catch { /* warn is best-effort */ }
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

function generateRenterKeypair(execFileSync) {
  const run = execFileSync || require('child_process').execFileSync;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-renter-'));
  const keyPath = path.join(dir, 'id_ed25519');
  try {
    run('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q', '-C', 'j41-renter'], { stdio: 'pipe' });
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    // Public line MUST be derived from the sealed private file (ssh-keygen -y),
    // not a sibling .pub that could drift.
    const publicKey = String(run('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' })).trim();
    if (!/BEGIN OPENSSH PRIVATE KEY|BEGIN PRIVATE KEY/.test(privateKey) || !publicKey.startsWith('ssh-ed25519')) {
      throw new Error('HOME_GPU_KEYGEN: ssh-keygen did not write an ed25519 pair');
    }
    return { privateKey, publicKey };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function tarAuthorizedKeys(publicKey) {
  const tar = require('tar-stream');
  const pack = tar.pack();
  pack.entry({
    name: 'authorized_keys',
    mode: 0o600,
    uid: 1000,
    gid: 1000,
    type: 'file',
  }, `${String(publicKey).trim()}\n`);
  pack.finalize();
  return pack;
}

function tarPlainFile(name, body, mode = 0o644) {
  const tar = require('tar-stream');
  const pack = tar.pack();
  pack.entry({ name, mode, uid: 0, gid: 0, type: 'file' }, body);
  pack.finalize();
  return pack;
}

const NVIDIA_LIB_RE = /^(libcuda\.so|libnvidia-ml\.so|libnvidia-ptxjitcompiler\.so|libnvidia-nvvm\.so|libnvidia-nvvm70\.so|libnvidia-gpucomp\.so|libnvidia-allocator\.so|libnvidia-cfg\.so)/;
const NVIDIA_LIB_DIR = '/usr/lib/x86_64-linux-gnu';

function collectNvidiaUserspace() {
  const out = [];
  if (fs.existsSync('/usr/bin/nvidia-smi')) out.push('/usr/bin/nvidia-smi');
  let names = [];
  try { names = fs.readdirSync(NVIDIA_LIB_DIR); } catch { return out; }
  for (const n of names) {
    if (NVIDIA_LIB_RE.test(n)) out.push(path.join(NVIDIA_LIB_DIR, n));
  }
  return out;
}

function nvidiaDeviceSpecs(deviceIndex) {
  const n = Number(deviceIndex);
  const idx = Number.isInteger(n) && n >= 0 ? n : 0;
  const nodes = [
    `/dev/nvidia${idx}`,
    '/dev/nvidiactl',
    '/dev/nvidia-uvm',
    '/dev/nvidia-uvm-tools',
    '/dev/nvidia-modeset',
  ];
  return nodes.filter((p) => fs.existsSync(p)).map((p) => ({
    PathOnHost: p,
    PathInContainer: p,
    CgroupPermissions: 'rwm',
  }));
}

function tarHostFiles(absPaths) {
  const tar = require('tar-stream');
  const pack = tar.pack();
  const files = (absPaths || []).filter((p) => typeof p === 'string' && p.startsWith('/') && !p.includes('..'));
  const pump = async () => {
    for (const abs of files) {
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      const name = abs.slice(1);
      if (!name) continue;
      if (st.isSymbolicLink()) {
        const linkname = fs.readlinkSync(abs);
        await new Promise((resolve, reject) => {
          pack.entry({ name, type: 'symlink', linkname }, (err) => (err ? reject(err) : resolve()));
        });
      } else if (st.isFile()) {
        await new Promise((resolve, reject) => {
          const entry = pack.entry({
            name,
            type: 'file',
            mode: st.mode & 0o777,
            size: st.size,
            uid: 0,
            gid: 0,
          }, (err) => (err ? reject(err) : resolve()));
          fs.createReadStream(abs).on('error', reject).pipe(entry);
        });
      }
    }
    pack.finalize();
  };
  pump().catch((err) => { try { pack.destroy(err); } catch { /* already torn down */ } });
  return pack;
}

const JAIL_RESOLV_CONF = 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n';

const JAIL_NETWORK = 'j41-gpu-jail';
const JAIL_APPARMOR = 'j41-gpu-jail';
const JAIL_APPARMOR_PROFILE = path.join(__dirname, '..', '..', 'docker', 'apparmor-gpu-jail');
const JAIL_APPARMOR_DENIED_WARN = 'AppArmor j41-gpu-jail not loaded (policy admin denied). mountinfo glob deny inactive.';

function homeGpuNoNet(detail) {
  const err = new Error(`HOME_GPU_NO_NET: ${detail}`);
  err.code = 'HOME_GPU_NO_NET';
  return err;
}

async function ensureJailNetwork(docker) {
  if (!docker || typeof docker.createNetwork !== 'function') {
    throw homeGpuNoNet('docker.createNetwork required for j41-gpu-jail (no docker0 fallback)');
  }
  if (typeof docker.getNetwork === 'function') {
    try {
      await docker.getNetwork(JAIL_NETWORK).inspect();
      return JAIL_NETWORK;
    } catch { /* create */ }
  }
  try {
    await docker.createNetwork({
      Name: JAIL_NETWORK,
      Driver: 'bridge',
      Attachable: false,
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      IPAM: { Config: [{ Subnet: '10.255.255.0/24', Gateway: '10.255.255.1' }] },
    });
    return JAIL_NETWORK;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already exists/i.test(msg)) return JAIL_NETWORK;
    throw homeGpuNoNet(msg);
  }
}

let _jailApparmorDeniedWarned = false;

function resetJailApparmorWarned() {
  _jailApparmorDeniedWarned = false;
}

function warnApparmorDeniedOnce() {
  if (_jailApparmorDeniedWarned) return;
  _jailApparmorDeniedWarned = true;
  console.warn(JAIL_APPARMOR_DENIED_WARN);
}

function loadJailApparmor(execFileSync) {
  if (!fs.existsSync(JAIL_APPARMOR_PROFILE)) {
    warnApparmorDeniedOnce();
    return false;
  }
  const run = execFileSync || require('child_process').execFileSync;
  try {
    run('apparmor_parser', ['-r', '--skip-cache', JAIL_APPARMOR_PROFILE], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      run('apparmor_parser', ['-r', JAIL_APPARMOR_PROFILE], { stdio: 'pipe' });
      return true;
    } catch {
      // Policy admin denied: hire still proceeds, glob deny on mountinfo is off.
      warnApparmorDeniedOnce();
      return false;
    }
  }
}

async function injectRenterAuthorizedKeys(container, publicKey) {
  if (!container || typeof container.putArchive !== 'function') {
    throw new Error('HOME_GPU_KEYGEN: container.putArchive required to inject authorized_keys');
  }
  await container.putArchive(tarAuthorizedKeys(publicKey), { path: '/home/renter/.ssh' });
}

async function injectNvidiaUserspace(container, files) {
  if (!container || typeof container.putArchive !== 'function') {
    throw new Error('HOME_GPU_NO_NVIDIA: container.putArchive required to inject nvidia userspace');
  }
  await container.putArchive(tarHostFiles(files), { path: '/' });
}

async function injectResolvConf(container) {
  if (!container || typeof container.putArchive !== 'function') return;
  await container.putArchive(tarPlainFile('resolv.conf', JAIL_RESOLV_CONF), { path: '/etc' });
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

// Docker replaces its defaults if we set MaskedPaths — keep the OCI list and
// add host-fingerprint files. uname(2) still reports the host kernel; a
// container cannot hide that without a VM. Masking /proc/self/mountinfo only
// blanks pid 1; the renter's /proc/$$/mountinfo still lists mounts, so nvidia
// userspace is copied onto the overlay (no host-LV binds) instead of relying
// on that mask.
const JAIL_MASKED_PATHS = Object.freeze([
  '/proc/asound', '/proc/acpi', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/timer_list', '/proc/timer_stats',
  '/proc/sched_debug', '/proc/scsi',
  '/sys/firmware', '/sys/devices/virtual/powercap',
  '/proc/cpuinfo', '/proc/meminfo', '/proc/version', '/proc/cmdline',
  '/proc/mounts', '/proc/diskstats', '/proc/partitions', '/proc/swaps',
  '/proc/mdstat', '/sys/class/dmi', '/sys/devices/virtual/dmi',
  '/proc/self/mountinfo', '/proc/self/mounts',
  '/proc/1/mountinfo', '/proc/1/mounts', '/etc/mtab',
  '/proc/modules', '/proc/config.gz', '/proc/kallsyms',
  '/proc/uptime', '/proc/loadavg', '/proc/stat', '/proc/interrupts',
  '/proc/softirqs', '/proc/zoneinfo', '/proc/buddyinfo',
  '/proc/sys/kernel/random/boot_id',
  '/proc/sys/kernel/osrelease', '/proc/sys/kernel/version',
  '/proc/sys/kernel/hostname', '/proc/sys/kernel/domainname',
  '/proc/net/arp', '/proc/net/route', '/proc/net/fib_trie', '/proc/net/fib_rules',
  '/sys/block', '/sys/class/block', '/sys/class/nvme', '/sys/dev/block',
  '/sys/devices/virtual/block',
]);
const JAIL_READONLY_PATHS = Object.freeze([
  '/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger',
]);
// SYS_ADMIN+SETPCAP are only for gpu-jail-init (umount Docker hosts/resolv
// binds, then drop both from the bounding set before exec sshd).
const JAIL_CAP_ADD = Object.freeze([
  'NET_BIND_SERVICE', 'SETUID', 'SETGID', 'SYS_CHROOT', 'CHOWN', 'AUDIT_WRITE', 'KILL',
  'SYS_ADMIN', 'SETPCAP',
]);

// wx-lock is a file. Operator drop / crash that skipped release() leaves it
// and the next paid hire is HOME_GPU_BUSY with no jail. Reclaim locks whose
// device has no live lease. Do not steal a lock that still has a ready lease.
function reclaimStaleHomeGpuLocks(leases = []) {
  const held = new Set();
  for (const l of leases || []) {
    if (!l || l.state === 'released' || l.state === 'release-pending') continue;
    const idx = l.meta && l.meta.device_index != null ? l.meta.device_index : 0;
    held.add(Number(idx));
  }
  const dir = path.join(os.homedir(), '.j41', 'dispatcher', 'locks');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const m = /^gpu-(\d+)\.lock$/.exec(name);
    if (!m) continue;
    if (held.has(Number(m[1]))) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      n += 1;
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) throw e;
    }
  }
  return n;
}

// Loopback-only TCP probe. Never dials the tunnel hostname. Do not read the
// SSH banner — that starts a kex sshd logs as 172.17.0.1 kex-closed.
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
    sock.once('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
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
    this.__probeSsh = cfg.__probeSsh || null;
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
      meta: { device_index: this.cfg.device_index },
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
      const gen = this.cfg.__generateKeypair || generateRenterKeypair;
      const pair = gen();
      if (!pair || !pair.privateKey || !pair.publicKey) {
        throw new Error('HOME_GPU_KEYGEN: renter keypair required');
      }
      if (lease.meta) lease.meta.publicKey = pair.publicKey;
      else lease.meta = { publicKey: pair.publicKey };

      const jailDir = path.join(os.homedir(), '.j41', 'dispatcher', 'jails', String(lease.id));
      fs.mkdirSync(jailDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(jailDir, 0o700);
      const sshDir = path.join(jailDir, 'ssh');
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(sshDir, 0o700);
      fs.writeFileSync(path.join(sshDir, 'authorized_keys'), `${pair.publicKey}\n`, { mode: 0o600 });

      const networkMode = await ensureJailNetwork(this.docker);
      const apparmor = loadJailApparmor(this.cfg.__apparmorParser);
      const securityOpt = ['no-new-privileges:true'];
      if (apparmor) securityOpt.push(`apparmor=${JAIL_APPARMOR}`);
      const nvidiaFiles = Object.prototype.hasOwnProperty.call(this.cfg, '__nvidiaFiles')
        ? this.cfg.__nvidiaFiles
        : collectNvidiaUserspace();
      const devices = Object.prototype.hasOwnProperty.call(this.cfg, '__nvidiaDevices')
        ? this.cfg.__nvidiaDevices
        : nvidiaDeviceSpecs(this._deviceIndex());
      if (!Object.prototype.hasOwnProperty.call(this.cfg, '__nvidiaFiles') && !nvidiaFiles.length) {
        throw new Error('HOME_GPU_NO_NVIDIA: nvidia-smi / libcuda not found on host');
      }
      if (!devices.length) {
        throw new Error(`HOME_GPU_NO_NVIDIA: /dev/nvidia${deviceId} (and ctl/uvm) not present`);
      }
      try {
        container = await this.docker.createContainer({
          Image: jailImageRef(this.cfg),
          Hostname: 'gpu-jail',
          ExposedPorts: { '22/tcp': {} },
          HostConfig: {
            NetworkMode: networkMode,
            PortBindings: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: String(tunnelPort) }] },
            Memory: memoryMb * 1024 * 1024,
            // No host binds. Keys and nvidia userspace go in via putArchive on
            // the overlay so findmnt/df cannot name host LVs. Device nodes are
            // mknod copies (not udev bind-mounts). Do not use DeviceRequests:
            // the nvidia-container-toolkit prestart hook bind-mounts driver
            // files from the host LV and udev.
            Binds: [],
            Dns: ['1.1.1.1', '8.8.8.8'],
            DnsOptions: [],
            DnsSearch: [],
            MaskedPaths: [...JAIL_MASKED_PATHS],
            ReadonlyPaths: [...JAIL_READONLY_PATHS],
            StorageOpt: { size: `${diskGb}G` },
            PidsLimit: 1024,
            CapDrop: ['ALL'],
            CapAdd: [...JAIL_CAP_ADD],
            SecurityOpt: securityOpt,
            Devices: devices,
            Sysctls: {
              'net.ipv6.conf.all.disable_ipv6': '1',
              'net.ipv6.conf.default.disable_ipv6': '1',
            },
          },
        });
      } catch (err) {
        const msg = String((err && err.message) || '');
        if (/storage-opt|storage opt|storage option|\bquota\b/i.test(msg)) {
          throw new Error(`HOME_GPU_NO_DISK_QUOTA: host docker cannot cap disk_gb (need overlay2 over XFS -o prjquota, or btrfs/zfs): ${err.message}`);
        }
        throw err;
      }
      // Record before start so a throw cannot orphan the jail or hide the id from release.
      this._containerId = container.id;
      lease.meta.containerId = container.id;

      await injectRenterAuthorizedKeys(container, pair.publicKey);
      if (nvidiaFiles.length) await injectNvidiaUserspace(container, nvidiaFiles);
      await container.start();
      try { await injectResolvConf(container); } catch { /* Docker may mount resolv.conf; CMD also writes it */ }
      const inspect = await container.inspect();
      const binding = inspect && inspect.NetworkSettings && inspect.NetworkSettings.Ports
        && inspect.NetworkSettings.Ports['22/tcp'] && inspect.NetworkSettings.Ports['22/tcp'][0];
      const publishedPort = binding ? Number(binding.HostPort) : tunnelPort;
      lease.meta.publishedPort = publishedPort;

      const ssh = {
        host: hostname,
        port: tunnelPort,
        user: 'renter',
        privateKey: pair.privateKey,
      };

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let up = false;
        try {
          if (typeof this.__probeSsh === 'function') {
            up = !!(await this.__probeSsh(tunnelPort));
          } else {
            const ins = await container.inspect();
            up = !!(ins && ins.State && ins.State.Running);
          }
        } catch { up = false; }
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
      void port;
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: (err && err.message) || 'inspect failed' };
    }
  }

  async release(lease) {
    const id = (lease && lease.meta && lease.meta.containerId) || this._containerId;
    await this._forceRemove(id);
    this._containerId = null;
    // Host jail dir holds only the per-job key material (workspace is overlay and
    // dies with the container). Best-effort: a failure here must never block freeing the card.
    if (lease && lease.id) {
      const jailDir = path.join(os.homedir(), '.j41', 'dispatcher', 'jails', String(lease.id));
      try { fs.rmSync(jailDir, { recursive: true, force: true }); }
      catch (e) { console.error(`[home-gpu] could not remove jail dir ${jailDir}: ${e && e.message}`); }
    }
    this._unlock(lease);
    return { ...lease, state: 'released' };
  }

  describeCost(lease) {
    const usd = Number(lease && lease.usdPerHour);
    return { usdPerHour: Number.isFinite(usd) ? usd : (Number(this.cfg.usd_per_hour) || 0), source: 'declared' };
  }
}

module.exports = {
  HomeGpuProvider, assertTunnelHostname, assertTunnelPort, assertJailResources,
  jailImageRef, deviceLockPath, generateRenterKeypair, reclaimStaleHomeGpuLocks,
  JAIL_MASKED_PATHS, JAIL_READONLY_PATHS, JAIL_CAP_ADD, tarAuthorizedKeys, injectRenterAuthorizedKeys,
  ensureJailNetwork, JAIL_NETWORK, collectNvidiaUserspace, nvidiaDeviceSpecs,
  tarHostFiles, injectNvidiaUserspace, injectResolvConf, JAIL_RESOLV_CONF,
  loadJailApparmor, JAIL_APPARMOR_PROFILE, JAIL_APPARMOR_DENIED_WARN, resetJailApparmorWarned,
};
