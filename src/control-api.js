/**
 * Dispatcher Control API (WP-D1 / WP-D2) — the headless-first control surface.
 *
 * A versioned, localhost-bound HTTP API that exposes the dispatcher's read
 * model and event stream to ANY client: brainbox's shop/monitor rooms, a cron
 * script, somebody else's orchestrator. The TUI and the `ctl` socket become
 * just other clients of the same data (shared read-model builders live in
 * control.js).
 *
 * This daemon moves money, so unlike the open `:9842` health/metrics server,
 * EVERYTHING under /v1/* requires a bearer token — even from localhost. The
 * token file is 0600, so same-user access is trivial and other-user access is
 * impossible. This mirrors brainbox's serve.token / auth.py idiom so the two
 * daemons feel the same to operate.
 *
 * v1 surface (read-only skeleton; write endpoints land in a later increment):
 *   GET /v1/status          — uptime, pool, queue
 *   GET /v1/agents          — registered agents + state
 *   GET /v1/jobs            — active jobs + queue depth
 *   GET /v1/jobs/:id        — one active job's detail
 *   GET /v1/earnings        — per-agent rollups (hits the platform)
 *   GET /v1/events?since=N  — monotonic event feed (polling transport)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DISPATCHER_DIR = () => path.join(os.homedir(), '.j41', 'dispatcher');
const TOKEN_PATH = () => path.join(DISPATCHER_DIR(), 'control.token');
const EVENTS_PATH = () => path.join(DISPATCHER_DIR(), 'events.jsonl');

// In-memory ring + on-disk tail are both capped at this many events. The file
// is compacted (rewritten to the last RING_CAP lines) when it grows past 2×.
const RING_CAP = 1000;

// ─────────────────────────────────────────
// Bearer token
// ─────────────────────────────────────────

/**
 * Return the control token, creating it (32 random bytes hex, mode 0600) on
 * first call. The directory is created by the dispatcher long before this.
 */
function ensureToken() {
  const p = TOKEN_PATH();
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  } catch { /* missing — create below */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DISPATCHER_DIR(), { recursive: true });
  fs.writeFileSync(p, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
  return token;
}

/** Constant-time bearer check against the Authorization header. */
function checkAuth(req, token) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  const want = Buffer.from(token);
  // timingSafeEqual throws on length mismatch — guard first, but still run a
  // comparison so the timing doesn't leak length.
  if (got.length !== want.length) {
    crypto.timingSafeEqual(want, want);
    return false;
  }
  return crypto.timingSafeEqual(got, want);
}

// ─────────────────────────────────────────
// Event ring buffer (WP-D2)
// ─────────────────────────────────────────

/**
 * File-backed, monotonic event ring. `seq` survives restart (re-seeded from
 * the persisted tail) so a polling client's `since` cursor stays valid across
 * a dispatcher bounce. Returns { emit, query, cursor }.
 */
function createEventBus() {
  let seq = 0;
  let ring = [];

  // Re-seed from disk so seq is monotonic across restarts.
  try {
    const raw = fs.readFileSync(EVENTS_PATH(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines.slice(-RING_CAP)) {
      try {
        const ev = JSON.parse(line);
        if (typeof ev.seq === 'number') {
          ring.push(ev);
          if (ev.seq > seq) seq = ev.seq;
        }
      } catch { /* skip corrupt line */ }
    }
  } catch { /* no prior events — fresh start */ }

  let appendsSinceCompaction = 0;

  function emit(type, data = {}) {
    if (!type) return null;
    seq += 1;
    const ev = { seq, ts: Date.now(), type, ...data };
    ring.push(ev);
    if (ring.length > RING_CAP) ring = ring.slice(-RING_CAP);
    try {
      fs.appendFileSync(EVENTS_PATH(), JSON.stringify(ev) + '\n');
      // Compact opportunistically so the file can't grow without bound.
      if (++appendsSinceCompaction >= RING_CAP) {
        fs.writeFileSync(EVENTS_PATH(), ring.map(e => JSON.stringify(e)).join('\n') + '\n');
        appendsSinceCompaction = 0;
      }
    } catch { /* disk full / readonly — in-memory ring still serves */ }
    return ev;
  }

  function query(since = 0) {
    const from = Number.isFinite(since) ? since : 0;
    const events = ring.filter(e => e.seq > from);
    return { events, cursor: seq };
  }

  return { emit, query, cursor: () => seq };
}

// ─────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Start the control API.
 * @param {object} state — dispatcher state (shared with the ctl socket)
 * @param {object} handlers — { getAgentSession }
 * @param {object} opts — { port, startedAt, bus }
 * @returns {{ server, bus, token }}
 */
function startControlApi(state, handlers, opts = {}) {
  const {
    buildStatus, buildJobs, buildJob, buildAgents, buildEarnings,
  } = require('./control.js');

  const token = ensureToken();
  const bus = opts.bus || createEventBus();
  const startedAt = opts.startedAt || Date.now();
  const port = opts.port ?? 9843; // allow port 0 (ephemeral) for tests

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname;

      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed (v1 is read-only)' });
      }
      if (!route.startsWith('/v1/')) {
        return sendJson(res, 404, { error: 'not found', hint: 'API is under /v1/' });
      }
      if (!checkAuth(req, token)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return sendJson(res, 401, { error: 'unauthorized — send Authorization: Bearer <control.token>' });
      }

      if (route === '/v1/status') {
        return sendJson(res, 200, buildStatus(state, startedAt));
      }
      if (route === '/v1/agents') {
        return sendJson(res, 200, buildAgents(state));
      }
      if (route === '/v1/jobs') {
        return sendJson(res, 200, buildJobs(state));
      }
      const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(route);
      if (jobMatch) {
        const detail = buildJob(state, decodeURIComponent(jobMatch[1]));
        if (!detail) return sendJson(res, 404, { error: 'job not active' });
        return sendJson(res, 200, detail);
      }
      if (route === '/v1/earnings') {
        return sendJson(res, 200, await buildEarnings(state, handlers.getAgentSession));
      }
      if (route === '/v1/events') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        return sendJson(res, 200, bus.query(Number.isNaN(since) ? 0 : since));
      }

      return sendJson(res, 404, { error: `unknown endpoint: ${route}` });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const bound = server.address()?.port ?? port;
    console.log(`[ControlAPI] http://127.0.0.1:${bound}/v1/  (bearer token: ${TOKEN_PATH()})`);
  });
  server.on('error', (err) => {
    console.error(`[ControlAPI] Server error: ${err.message}`);
  });

  return { server, bus, token };
}

function stopControlApi(handle) {
  if (handle?.server) {
    try { handle.server.close(); } catch {}
  }
}

module.exports = {
  startControlApi,
  stopControlApi,
  createEventBus,
  ensureToken,
  checkAuth,
  TOKEN_PATH,
  EVENTS_PATH,
  RING_CAP,
};
