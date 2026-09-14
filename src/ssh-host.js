'use strict';
// Public-host checks for Cat-1 gpu-rental. RFC1918/loopback/.local must not be
// accepted or sealed unless J41_ALLOW_LAN_RENTAL=1. Buyer complete stays honest
// even with the override — leftovers can close, but never with a success checkmark.
const net = require('net');
const { isPrivateIp } = require('./proxy-handler');

let _lanOverrideLogged = false;

function lanRentalAllowed() {
  return process.env.J41_ALLOW_LAN_RENTAL === '1';
}

function logLanOverrideOnce() {
  if (_lanOverrideLogged) return;
  _lanOverrideLogged = true;
  console.warn('LAN rental override on — ssh.host is not reachable off this network');
}

function normalizeSshHost(host) {
  let h = String(host == null ? '' : host).trim().toLowerCase();
  const bracket = h.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    h = bracket[1];
  } else {
    const ipv4OrNamePort = h.match(/^([^:]+):(\d+)$/);
    if (ipv4OrNamePort) h = ipv4OrNamePort[1];
  }
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function isLanSshHost(host) {
  const h = normalizeSshHost(host);
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.') return true;
  if (h.endsWith('.local') || h.endsWith('.local.')) return true;
  if (h.endsWith('.internal') || h.endsWith('.internal.')) return true;
  if (isPrivateIp(h)) return true;
  return false;
}

function assertPublicSshHost(host) {
  const trimmed = String(host == null ? '' : host).trim();
  if (lanRentalAllowed()) {
    if (isLanSshHost(host)) logLanOverrideOnce();
    return trimmed;
  }
  if (isLanSshHost(host)) {
    const err = new Error(
      'RENTAL_LAN_HOST: ssh host is RFC1918/loopback/LAN'
      + (trimmed ? ` (${trimmed})` : '')
      + '; need compute.outbound-ssh-v1 on GET /v1/version (retry) or a public ssh_hostname',
    );
    err.code = 'RENTAL_LAN_HOST';
    throw err;
  }
  return trimmed;
}

function sshHostnameForAgent(agentId, cfg) {
  const { providerCfgForAgent } = require('./rental-setup');
  const found = providerCfgForAgent(cfg, agentId);
  if (!found) return '';
  const pcfg = found[1] || {};
  if (pcfg.ssh_hostname != null && String(pcfg.ssh_hostname).trim() !== '') {
    return pcfg.ssh_hostname;
  }
  // Vast SSH is assigned at acquire; there is no static tunnel hostname to gate.
  if (String(pcfg.type || '') === 'vast') return null;
  return '';
}

function assertRentalHostPublic(agentId, cfg) {
  const resolved = cfg && typeof cfg === 'object'
    ? cfg
    : require('./config-loader').loadDispatcherConfig();
  const host = sshHostnameForAgent(agentId, resolved);
  if (host === null) return;
  return assertPublicSshHost(host);
}

function shouldRefuseLanGpuRental(agentId, job, services, cfg, opts = {}) {
  if (opts && opts.outboundSshV1) return false;
  const { isGpuRentalJob } = require('./rental-worker');
  const rental = isGpuRentalJob(job, services)
    || (services || []).some((s) => s && s.serviceType === 'gpu-rental');
  if (!rental) return false;
  try {
    assertRentalHostPublic(agentId, cfg);
    return false;
  } catch (e) {
    if (e && (e.code === 'RENTAL_LAN_HOST' || /RENTAL_LAN_HOST/.test(String(e.message || e)))) {
      const id = job && job.id != null ? job.id : '';
      console.error(`[Rental] RENTAL_LAN_HOST — not accepting job ${id}; need compute.outbound-ssh-v1 or a public ssh_hostname`);
      return true;
    }
    throw e;
  }
}

function probeSshHost({ host, port } = {}, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;
  const connect = typeof opts.connect === 'function' ? opts.connect : (a) => net.connect(a);
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.destroy(); } catch { /* ignore */ }
      resolve(!!ok);
    };
    try {
      socket = connect({ host, port: Number(port) });
    } catch {
      resolve(false);
      return;
    }
    if (!socket || typeof socket.once !== 'function') {
      resolve(false);
      return;
    }
    if (typeof socket.setTimeout === 'function') socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function rentalSshFromAccess(access) {
  if (!access || typeof access !== 'object') return { host: undefined, port: undefined };
  const body = (access.data && typeof access.data === 'object' && !access.ssh)
    ? access.data
    : access;
  const ssh = (body && body.ssh && typeof body.ssh === 'object') ? body.ssh : {};
  return { host: ssh.host, port: ssh.port };
}

function rentalAccessNotFound(err) {
  if (!err) return false;
  const status = Number(err.statusCode || err.status || (err.response && err.response.status));
  return status === 404;
}

// Buyer leftover complete: observe rental the way GET /v1/jobs/:id actually
// looks (serviceId, not serviceType). Try getRentalAccess; ssh.host → honesty;
// 404 / no host → labour (caller may print the success checkmark).
async function leftoverCompleteHonesty(getRentalAccess, jobId, opts) {
  let access = null;
  try {
    access = await getRentalAccess(jobId);
  } catch (e) {
    if (rentalAccessNotFound(e)) return { warning: null };
    access = null;
  }
  const { host } = rentalSshFromAccess(access);
  if (host == null || String(host).trim() === '') return { warning: null };
  return completeRentalHonesty(access, opts);
}

async function completeRentalHonesty(access, { probe = probeSshHost } = {}) {
  if (!access || typeof access !== 'object') {
    return {
      warning: 'COMPLETE_HOST_UNREACHABLE',
      message: 'Job completed. Sealed SSH host is not reachable.',
    };
  }
  const { host, port } = rentalSshFromAccess(access);
  if (isLanSshHost(host)) {
    return {
      warning: 'COMPLETE_LAN_ONLY',
      message: 'Job completed. Sealed SSH host is RFC1918 — not reachable off the seller LAN.',
    };
  }
  let ok = false;
  try {
    ok = await probe({ host, port });
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      warning: 'COMPLETE_HOST_UNREACHABLE',
      message: 'Job completed. Sealed SSH host is not reachable.',
    };
  }
  return { warning: null, message: null, host, port };
}

function formatBuyerCompleteOutput({ jobId, status, warning, witness } = {}) {
  if (warning === 'COMPLETE_LAN_ONLY') {
    return {
      human: 'Job completed. Sealed SSH host is RFC1918 — not reachable off the seller LAN.',
      json: { ok: true, jobId, status, warning, witness },
    };
  }
  if (warning === 'COMPLETE_HOST_UNREACHABLE') {
    return {
      human: 'Job completed. Sealed SSH host is not reachable.',
      json: { ok: true, jobId, status, warning, witness },
    };
  }
  return {
    human: `✅ Job ${jobId} completed (status=${status || 'completed'})`,
    json: { ok: true, jobId, status, witness },
  };
}

module.exports = {
  isLanSshHost,
  assertPublicSshHost,
  assertRentalHostPublic,
  shouldRefuseLanGpuRental,
  sshHostnameForAgent,
  probeSshHost,
  rentalSshFromAccess,
  leftoverCompleteHonesty,
  completeRentalHonesty,
  formatBuyerCompleteOutput,
};
