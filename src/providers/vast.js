'use strict';
const crypto = require('crypto');
const { ComputeProvider } = require('./base');
const { scoreOffers } = require('./vast-offers');

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function sshBuf(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([u32be(b.length), b]);
}

// OpenSSH-format ed25519 pair so Bob can `ssh -i` the sealed privateKey.
function generateRenterSshKeyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const rawPub = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const rawSeed = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const keyType = Buffer.from('ssh-ed25519');
  const pubBlob = Buffer.concat([sshBuf(keyType), sshBuf(rawPub)]);
  const publicKey = `ssh-ed25519 ${pubBlob.toString('base64')} j41-renter`;
  const check = crypto.randomBytes(4);
  const comment = Buffer.from('j41-renter');
  const privInner = Buffer.concat([
    check, check,
    sshBuf(keyType),
    sshBuf(rawPub),
    sshBuf(Buffer.concat([rawSeed, rawPub])),
    sshBuf(comment),
  ]);
  const padLen = (8 - (privInner.length % 8)) % 8;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshBuf(Buffer.from('none')),
    sshBuf(Buffer.from('none')),
    sshBuf(Buffer.alloc(0)),
    u32be(1),
    sshBuf(pubBlob),
    sshBuf(Buffer.concat([privInner, pad])),
  ]);
  const wrapped = body.toString('base64').match(/.{1,70}/g).join('\n');
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { publicKey, privateKey };
}

function authorizedKeysOnstart(publicKey, existing) {
  const line = String(publicKey).replace(/[\r\n']/g, '').trim();
  const inject = `mkdir -p /root/.ssh && echo '${line}' >> /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys`;
  return existing ? `${inject}; ${existing}` : inject;
}

function resolveInterruptible(candidate, spec, cfgValue) {
  if (spec && spec.jobId) return false;
  if (spec && spec.interruptible === false) return false;
  if (candidate && candidate.meta && candidate.meta.interruptible === false) return false;
  if (spec && spec.interruptible === true) return true;
  if (candidate && candidate.meta && candidate.meta.interruptible === true) return true;
  return cfgValue !== false;
}

function instSshPassword(inst) {
  return (inst && (inst.ssh_password || inst.password || inst.ssh_pw)) || null;
}
function instSshPrivateKey(inst) {
  return (inst && (inst.ssh_private_key || inst.private_key || inst.ssh_key)) || null;
}

// Vast.ai provider. All HTTP goes through an injectable fetch (llm-health.js idiom),
// so CI drives it with fixtures and never spends a dollar.
//
// Money-safety invariants (hardened after adversarial review):
//   - release() marks a lease released ONLY on 404/410/2xx. Any other status (401 from
//     a mis-keyed provider, 429, 5xx) THROWS so the caller keeps retrying — a box wrongly
//     marked released bills forever.
//   - Cat-1 rentals are on-demand: when interruptible=false, acquire() omits the bid
//     `price`, so the instance can't be reclaimed mid-hour.
//   - probe() is service-level (a running instance with a dead vLLM is NOT healthy).
class VastProvider extends ComputeProvider {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.base = (cfg.base || 'https://cloud.vast.ai/api/v0').replace(/\/$/, '');
    this.fetchImpl = cfg.fetchImpl || globalThis.fetch;
    // Config tables are snake_case ([compute.providers.*]); accept camelCase too.
    this.minVramGb = cfg.min_vram_gb ?? cfg.minVramGb;
    this.maxUsdPerHour = cfg.max_usd_per_hour ?? cfg.maxUsdPerHour;
    this.minGpuCount = cfg.min_gpu_count ?? cfg.minGpuCount;
    this.interruptible = cfg.interruptible !== undefined ? cfg.interruptible : true;
    this.image = cfg.image || 'vllm/vllm-openai:latest';
    this.diskGb = Number(cfg.disk_gb) || 40;
    this.onstart = cfg.onstart || null; // vLLM launch command (model arg etc.)
  }

  async _req(method, path, body) {
    return this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.api_key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async discover(spec = {}) {
    const res = await this._req('GET', '/bundles/');
    if (!res.ok) throw new Error(`VAST_DISCOVER_FAILED status=${res.status}`);
    const data = await res.json();
    return scoreOffers(data.offers || [], {
      minVramGb: this.minVramGb, maxUsdPerHour: this.maxUsdPerHour, minGpuCount: this.minGpuCount,
      interruptible: this.interruptible, ...spec,
    });
  }

  async acquire(candidate, spec = {}) {
    const askId = candidate && candidate.meta && candidate.meta.askId;
    const interruptible = resolveInterruptible(candidate, spec, this.interruptible);
    const isRental = !!(spec && spec.jobId)
      || (candidate && candidate.meta && candidate.meta.interruptible === false);
    const body = { disk: this.diskGb, image: this.image };
    if (this.onstart) body.onstart = this.onstart;
    // On-demand (interruptible=false) omits the bid price; a bid price makes the
    // instance interruptible and reclaimable — never for a Cat-1 rental.
    if (interruptible) body.price = candidate.usdPerHour;
    let renterKey = null;
    if (isRental) {
      renterKey = generateRenterSshKeyPair();
      // PUT /asks OpenAPI has no ssh_key field; inject via onstart (existing body)
      // so Bob's pubkey lands in authorized_keys without a new HTTP surface.
      body.onstart = authorizedKeysOnstart(renterKey.publicKey, body.onstart);
    }
    const res = await this._req('PUT', `/asks/${askId}/`, body);
    if (res.status === 410) throw new Error('VAST_OFFER_GONE');
    if (res.status === 429) throw new Error('VAST_RATE_LIMITED');
    if (res.status === 400) throw new Error(`VAST_CONFIG_ERROR ${await res.text()}`);
    if (!res.ok) throw new Error(`VAST_ACQUIRE_FAILED status=${res.status}`);
    const data = await res.json();
    const instanceId = data.new_contract || data.instance_id;
    return {
      id: `vast:${instanceId}`, provider: 'vast', state: 'pending', baseUrl: null, ssh: null,
      gpu: candidate.gpu || null, usdPerHour: candidate.usdPerHour, acquiredAt: Date.now(), expiresAt: null,
      private: false,
      meta: {
        instanceId, askId, interruptible,
        ...(renterKey ? { sshPublicKey: renterKey.publicKey, sshPrivateKey: renterKey.privateKey } : {}),
      },
    };
  }

  async _instance(instanceId) {
    const res = await this._req('GET', '/instances/');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.instances || []).find((i) => String(i.id) === String(instanceId)) || null;
  }

  _baseUrlFor(inst, lease) {
    const hostPort = inst.ports && inst.ports['8000/tcp'] && inst.ports['8000/tcp'][0] && inst.ports['8000/tcp'][0].HostPort;
    return this.cfg.public_url_for ? this.cfg.public_url_for(lease) : `http://${inst.ssh_host}:${hostPort || 8000}/v1`;
  }

  async waitReady(lease, { timeoutMs = 300000, readyFor = 'service' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const inst = await this._instance(lease.meta.instanceId);
      if (inst && inst.actual_status === 'running' && inst.ssh_host) {
        const baseUrl = this._baseUrlFor(inst, lease);
        const ssh = { host: inst.ssh_host, port: inst.ssh_port, user: 'root' };
        const password = instSshPassword(inst) || (lease.ssh && lease.ssh.password) || (lease.meta && lease.meta.password) || null;
        const privateKey = (lease.meta && lease.meta.sshPrivateKey)
          || (lease.ssh && lease.ssh.privateKey)
          || instSshPrivateKey(inst)
          || null;
        if (password) ssh.password = password;
        if (privateKey) ssh.privateKey = privateKey;
        // Cat-1 rental: SSH-ready only. Do not wait on vLLM /models.
        // Fail closed: never ship a root shell Bob cannot open.
        if (readyFor === 'ssh') {
          if (!ssh.password && !ssh.privateKey) {
            return { ...lease, state: 'degraded', ssh: null };
          }
          return { ...lease, state: 'ready', baseUrl, ssh };
        }
        // Cat-2 attach: the instance is up AND vLLM answers /models.
        if (await this._serviceUp(baseUrl)) {
          return { ...lease, state: 'ready', baseUrl, ssh };
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...lease, state: 'degraded' };
      await new Promise((r) => setTimeout(r, Math.min(5000, remaining)));
    }
  }

  async _serviceUp(baseUrl) {
    try { const res = await this.fetchImpl(baseUrl + '/models', { method: 'GET' }); return res.status === 200; }
    catch { return false; }
  }

  async probe(lease) {
    const inst = await this._instance(lease.meta.instanceId);
    if (!inst || inst.actual_status !== 'running') {
      return { healthy: false, reason: inst ? inst.actual_status : 'instance not found' };
    }
    // Cat-1 rental (job-bound): SSH-ready is health. Reconcile releases job-bound
    // unhealthy leases instead of replacing them — requiring /models here would
    // yank a paid box the moment the buyer stops vLLM (or before vLLM ever starts).
    if (lease.jobId) {
      const ok = !!inst.ssh_host;
      return { healthy: ok, reason: ok ? undefined : 'ssh not published' };
    }
    // Cat-2 attach: a running instance whose vLLM has crashed is NOT healthy.
    const base = lease.baseUrl || this._baseUrlFor(inst, lease);
    const up = await this._serviceUp(base);
    return { healthy: up, reason: up ? undefined : 'models endpoint not serving' };
  }

  async release(lease) {
    const res = await this._req('DELETE', `/instances/${lease.meta.instanceId}/`);
    // Idempotent success ONLY on already-gone (404/410) or a real 2xx. Any other
    // status — 401 (mis-keyed), 403, 429, 5xx — means the box may still be billing:
    // THROW so the reconcile/boot loop keeps the lease and retries. Network errors
    // from fetchImpl propagate for the same reason.
    if (res.status === 404 || res.status === 410 || (res.status >= 200 && res.status < 300)) {
      return { ...lease, state: 'released' };
    }
    throw new Error(`VAST_RELEASE_FAILED status=${res.status}`);
  }

  describeCost(lease) { return { usdPerHour: Number(lease.usdPerHour) || 0, source: 'quoted' }; }

  get capabilities() { return { canProvision: true, canSsh: true, canScaleToZero: false, isElastic: true }; }
}
module.exports = { VastProvider, generateRenterSshKeyPair, resolveInterruptible };
