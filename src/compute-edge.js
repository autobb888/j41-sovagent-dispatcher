'use strict';
// J41 compute edge (vanilla SSH). Seller dials out; buyer ssh's attach 200 host:port.
// Token compute.outbound-ssh-v1 is the only advertise/accept gate. No LAN fallback.
const net = require('net');
const { assertPublicSshHost } = require('./ssh-host');

const COMPUTE_OUTBOUND_SSH_V1 = 'compute.outbound-ssh-v1';

function featuresFromVersion(version) {
  if (!version) return [];
  if (Array.isArray(version.features)) return version.features.map(String);
  if (version.data && Array.isArray(version.data.features)) return version.data.features.map(String);
  return [];
}

function hasOutboundSshV1(version) {
  return featuresFromVersion(version).includes(COMPUTE_OUTBOUND_SSH_V1);
}

// GET /v1/version; any miss is false. Callers must not treat a throw as "token on".
async function fetchOutboundSshV1(opts = {}) {
  try {
    const client = opts.client && typeof opts.client.request === 'function'
      ? opts.client
      : null;
    let version;
    if (client) {
      version = await client.request('GET', '/v1/version');
    } else {
      const apiUrl = opts.apiUrl;
      if (!apiUrl) return false;
      const { J41Client } = require('@junction41/sovagent-sdk/dist/index.js');
      version = await new J41Client({ apiUrl }).request('GET', '/v1/version');
    }
    return hasOutboundSshV1(version);
  } catch {
    return false;
  }
}

function buildAttachMessage(jobId, timestamp) {
  return `J41-COMPUTE-ATTACH|Job:${jobId}|Ts:${timestamp}`;
}

function unwrapData(body) {
  if (body && body.data && typeof body.data === 'object' && (body.data.message != null || body.data.host != null || body.data.timestamp != null)) {
    return body.data;
  }
  return body || {};
}

function parseDial(dial, fallbackHost, fallbackPort) {
  const s = String(dial || '').trim();
  const m = s.match(/^tcp:\/\/\[([^\]]+)\]:(\d+)$/i) || s.match(/^tcp:\/\/([^:/]+):(\d+)$/i);
  if (m) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error('COMPUTE_EDGE_BAD_DIAL: port out of range'), { code: 'COMPUTE_EDGE_BAD_DIAL' });
    }
    return { dialHost: m[1], dialPort: port };
  }
  return { dialHost: fallbackHost, dialPort: fallbackPort };
}

function parseAttachBody(body) {
  const d = unwrapData(body);
  const host = d.host != null ? String(d.host).trim() : '';
  const port = Number(d.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('COMPUTE_EDGE_BAD_ATTACH: host and port required'), { code: 'COMPUTE_EDGE_BAD_ATTACH' });
  }
  assertPublicSshHost(host);
  const dialRaw = d.dial != null ? String(d.dial).trim() : `tcp://${host}:${port}`;
  const { dialHost, dialPort } = parseDial(dialRaw, host, port);
  return { host, port, dial: dialRaw, dialHost, dialPort };
}

function rethrowEdgeHttp(e) {
  const status = Number(e && (e.statusCode || e.status));
  if (status === 402) {
    throw Object.assign(
      new Error('COMPUTE_EDGE_UNPAID: challenge/attach requires payment_verified'),
      { code: 'COMPUTE_EDGE_UNPAID', statusCode: 402 },
    );
  }
  throw e;
}

async function challengeAndAttach({ client, jobId, signMessage }) {
  if (!client || typeof client.request !== 'function') {
    throw Object.assign(new Error('COMPUTE_EDGE_NO_CLIENT'), { code: 'COMPUTE_EDGE_NO_CLIENT' });
  }
  if (!jobId) throw Object.assign(new Error('COMPUTE_EDGE_NO_JOB'), { code: 'COMPUTE_EDGE_NO_JOB' });
  if (typeof signMessage !== 'function') {
    throw Object.assign(new Error('COMPUTE_EDGE_NO_SIGNER'), { code: 'COMPUTE_EDGE_NO_SIGNER' });
  }
  let ch;
  try {
    ch = await client.request('GET', `/v1/jobs/${encodeURIComponent(jobId)}/compute-edge/challenge`);
  } catch (e) {
    rethrowEdgeHttp(e);
  }
  const data = unwrapData(ch);
  const timestamp = Number(data.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw Object.assign(new Error('COMPUTE_EDGE_BAD_CHALLENGE: timestamp required'), { code: 'COMPUTE_EDGE_BAD_CHALLENGE' });
  }
  const expected = buildAttachMessage(jobId, timestamp);
  const message = data.message != null ? String(data.message) : expected;
  if (message !== expected) {
    throw Object.assign(
      new Error('COMPUTE_EDGE_BAD_CHALLENGE: message must be J41-COMPUTE-ATTACH|Job:<id>|Ts:<unix>'),
      { code: 'COMPUTE_EDGE_BAD_CHALLENGE' },
    );
  }
  const signature = await signMessage(message);
  let att;
  try {
    att = await client.request('POST', `/v1/jobs/${encodeURIComponent(jobId)}/compute-edge/attach`, {
      timestamp,
      signature,
    });
  } catch (e) {
    rethrowEdgeHttp(e);
  }
  return parseAttachBody(att);
}

// Idle NAT on the GPU box dropped 764f781e in ~2.5 min. Node/libuv sets
// TCP_KEEPIDLE from this delay, TCP_KEEPINTVL=1s, TCP_KEEPCNT=10.
const KEEP_ALIVE_MS = 15000;
// A long SSH copy (hundreds of MB) drops the seller→edge TCP. Three reseals
// froze port 40023 mid-scp. Keep offering a new port for the life of the lease.
const REATTACH_MAX = 30;

function applyTcpKeepAlive(sock, delayMs = KEEP_ALIVE_MS) {
  if (!sock) return sock;
  try {
    if (typeof sock.setKeepAlive === 'function') sock.setKeepAlive(true, delayMs);
  } catch { /* ignore */ }
  try {
    if (typeof sock.setNoDelay === 'function') sock.setNoDelay(true);
  } catch { /* ignore */ }
  return sock;
}

function defaultConnect(opts) {
  return net.connect({
    host: opts.host,
    port: opts.port,
    keepAlive: true,
    keepAliveInitialDelay: KEEP_ALIVE_MS,
    noDelay: true,
  });
}

function connectOnce(connect, opts) {
  return new Promise((resolve, reject) => {
    let sock;
    try {
      sock = connect(opts);
    } catch (e) {
      reject(e);
      return;
    }
    const fail = (err) => {
      try { sock.destroy(); } catch { /* ignore */ }
      reject(err || new Error('COMPUTE_EDGE_DIAL'));
    };
    if (!sock || typeof sock.once !== 'function') {
      fail(new Error('COMPUTE_EDGE_DIAL: connect did not return a socket'));
      return;
    }
    sock.once('connect', () => {
      if (typeof sock.removeListener === 'function') sock.removeListener('error', fail);
      applyTcpKeepAlive(sock);
      resolve(sock);
    });
    sock.once('error', fail);
  });
}

// L4 splice: seller→edge TCP is the public door. A failed SSH closes only
// jail sshd. Default pipe() would FIN `remote` on local 'end' and the edge
// drops the port (Mac retry: connection reset by peer). { end: false } keeps
// the outbound TCP for the whole lease; we reconnect 127.0.0.1:2222.
const SPLICE_OPTS = { end: false };

function holdRemoteToLocal(remote, { localHost, localPort, connect }) {
  let currentLocal = null;
  let stopped = false;
  // Buyer bytes, not the jail sshd banner. LoginGraceTime is 60s. Splicing
  // sshd at attach time starts that clock before anyone dials, the banner
  // counts as "bytes moved", and the grace close then burns the public port.
  // Wait for the buyer. A second sshd banner on a socket the buyer already
  // touched is still a MAC failure, so that close destroys the edge socket.
  let bytesMoved = false;
  let started = false;
  const stop = () => {
    stopped = true;
    try { if (currentLocal) currentLocal.destroy(); } catch { /* ignore */ }
  };
  const attachLocal = (buffered) => {
    if (started || stopped || !remote || remote.destroyed) return;
    started = true;
    connectOnce(connect, { host: localHost, port: localPort }).then((local) => {
      if (stopped || remote.destroyed) {
        try { local.destroy(); } catch { /* ignore */ }
        return;
      }
      currentLocal = local;
      if (buffered && buffered.length && typeof local.write === 'function') {
        try { local.write(buffered); } catch { /* the pipe below still carries the rest */ }
      }
      if (typeof remote.pipe === 'function' && typeof local.pipe === 'function') {
        remote.pipe(local, SPLICE_OPTS);
        local.pipe(remote, SPLICE_OPTS);
      }
      const onLocalGone = () => {
        try { if (typeof remote.unpipe === 'function') remote.unpipe(local); } catch { /* ignore */ }
        try { if (typeof local.unpipe === 'function') local.unpipe(remote); } catch { /* ignore */ }
        currentLocal = null;
        if (stopped || remote.destroyed) return;
        if (bytesMoved) {
          try { if (typeof remote.destroy === 'function') remote.destroy(); } catch { /* ignore */ }
          return;
        }
        started = false;
        setTimeout(() => attachLocal(), 50);
      };
      local.once('close', onLocalGone);
      local.once('error', onLocalGone);
    }).catch(() => {
      started = false;
      if (!stopped && !remote.destroyed && !bytesMoved) setTimeout(() => attachLocal(buffered), 200);
    });
  };
  if (remote && typeof remote.on === 'function') {
    const onBuyer = (chunk) => {
      bytesMoved = true;
      if (typeof remote.pause === 'function') {
        try { remote.pause(); } catch { /* ignore */ }
      }
      if (typeof remote.removeListener === 'function') remote.removeListener('data', onBuyer);
      attachLocal(chunk);
      if (typeof remote.resume === 'function') {
        try { remote.resume(); } catch { /* ignore */ }
      }
    };
    remote.on('data', onBuyer);
  }
  if (typeof remote.once === 'function') {
    remote.once('close', stop);
    remote.once('error', stop);
  }
  return {
    stop,
    get local() { return currentLocal; },
    get bytesMoved() { return bytesMoved; },
  };
}

// Seller MUST be the first TCP accept on the allocated port. Call immediately after attach 200.
async function attachAndDial(opts = {}) {
  const attached = await challengeAndAttach(opts);
  const connect = typeof opts.connect === 'function' ? opts.connect : defaultConnect;
  const remote = await connectOnce(connect, { host: attached.dialHost, port: attached.dialPort });
  const localPort = Number(opts.localPort);
  const localHost = opts.localHost || '127.0.0.1';
  if (!Number.isInteger(localPort) || localPort < 1) {
    try { remote.destroy(); } catch { /* ignore */ }
    throw Object.assign(new Error('COMPUTE_EDGE_NO_LOCAL: local SSH port required'), { code: 'COMPUTE_EDGE_NO_LOCAL' });
  }
  const held = holdRemoteToLocal(remote, { localHost, localPort, connect });
  return { ...attached, remote, get local() { return held.local; }, stopHold: held.stop };
}

// Keep seller→edge TCP for the lease. If outbound dies (NAT, edge drop after
// a failed SSH, local FIN), re-attach — new port — then POST rental-secret.
// API allows challenge/attach/secret while delivered; complete/cancel still 400.
// A failed login still saw SSH bytes; that must not freeze the public port.
function keepOutboundUntilBuyer(session, opts = {}) {
  if (!session || !session.remote) return session;
  const attach = typeof opts.attach === 'function' ? opts.attach : attachAndDial;
  const max = Number.isInteger(opts.maxReattach) ? opts.maxReattach : REATTACH_MAX;
  const log = typeof opts.log === 'function' ? opts.log : ((m) => console.warn(m));
  let stopped = false;
  let attempts = 0;
  let busy = false;

  const stopWatch = () => { stopped = true; };
  session.stopWatch = stopWatch;

  const adopt = (next) => {
    session.host = next.host;
    session.port = next.port;
    session.dial = next.dial;
    session.dialHost = next.dialHost;
    session.dialPort = next.dialPort;
    session.remote = next.remote;
    session.stopHold = next.stopHold;
    try {
      Object.defineProperty(session, 'local', {
        configurable: true,
        enumerable: true,
        get: () => next.local,
      });
    } catch { /* non-configurable in tests */ }
  };

  const arm = (sess) => {
    const remote = sess && sess.remote;
    if (!remote) return;
    applyTcpKeepAlive(remote);
    let handled = false;
    const startAttempt = () => {
      if (stopped || busy) return;
      if (attempts >= max) {
        log('[ComputeEdge] outbound TCP died; re-attach budget exhausted');
        return;
      }
      busy = true;
      attempts += 1;
      log(`[ComputeEdge] outbound TCP died — re-attaching (${attempts}/${max})`);
      Promise.resolve()
        .then(() => {
          try { if (typeof sess.stopHold === 'function') sess.stopHold(); } catch { /* ignore */ }
          if (stopped) return null;
          return attach(opts.attachOpts || {});
        })
        .then(async (next) => {
          if (stopped) return;
          if (!next) throw new Error('COMPUTE_EDGE_REATTACH_EMPTY');
          adopt(next);
          // A rental-secret POST failure must not leave the new socket
          // unwatched. The old once('close') already fired.
          try {
            if (typeof opts.onReattached === 'function') {
              await opts.onReattached({ host: next.host, port: next.port, session });
            }
          } catch (e) {
            log(`[ComputeEdge] rental-secret after re-attach failed: ${e && e.message}`);
          }
          if (!stopped) arm(session);
        })
        .catch((e) => {
          log(`[ComputeEdge] re-attach failed: ${e && e.message}`);
          if (!stopped && attempts < max) setTimeout(() => startAttempt(), 200);
        })
        .finally(() => { busy = false; });
    };
    const onGone = () => {
      if (handled || stopped || busy) return;
      handled = true;
      startAttempt();
    };
    if (typeof remote.once === 'function') {
      remote.once('close', onGone);
      remote.once('error', onGone);
    }
  };

  arm(session);
  return session;
}

function dropEdgeSockets(rec) {
  if (!rec) return;
  try { if (typeof rec.stopWatch === 'function') rec.stopWatch(); } catch { /* ignore */ }
  try { if (typeof rec.stopHold === 'function') rec.stopHold(); } catch { /* ignore */ }
  for (const s of [rec.remote, rec.local, rec.edgeSocket]) {
    if (s && typeof s.destroy === 'function') {
      try { s.destroy(); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  COMPUTE_OUTBOUND_SSH_V1,
  KEEP_ALIVE_MS,
  featuresFromVersion,
  hasOutboundSshV1,
  fetchOutboundSshV1,
  buildAttachMessage,
  parseAttachBody,
  parseDial,
  challengeAndAttach,
  attachAndDial,
  holdRemoteToLocal,
  keepOutboundUntilBuyer,
  applyTcpKeepAlive,
  dropEdgeSockets,
  SPLICE_OPTS,
};
