/**
 * Dispatcher Control Plane — Unix domain socket for runtime commands.
 *
 * Listens on ~/.j41/dispatcher/control.sock
 * Accepts newline-delimited JSON commands, returns JSON responses.
 *
 * Commands:
 *   status  — active jobs, queue, available agents, uptime
 *   jobs    — list active jobs with details
 *   agents  — list all registered agents and their state
 *   shutdown — trigger graceful shutdown
 *   canary <agent-id> — check canary status for an agent
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SOCKET_PATH = path.join(os.homedir(), '.j41', 'dispatcher', 'control.sock');

/**
 * Start the control plane server.
 * @param {object} state — dispatcher state (agents, active, available, queue, seen)
 * @param {object} handlers — { onShutdown: fn, getAgentSession: fn }
 * @returns {net.Server}
 */
function startControlServer(state, handlers) {
  // Clean up stale socket
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch {}

  const startedAt = Date.now();

  // Audit 2026-06-02 M-DISPATCHER-ddos-1: bound the per-connection input
  // buffer. Without this a client could send 1 GB of arbitrary bytes with no
  // newline and OOM the dispatcher. Default 64 KB is way above the largest
  // legitimate ctl command (a few hundred bytes max).
  const MAX_CTL_BUFFER_BYTES = Number(process.env.J41_CTL_MAX_BUFFER_BYTES || 64 * 1024);

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (data) => {
      buf += data.toString();
      if (buf.length > MAX_CTL_BUFFER_BYTES) {
        conn.write(JSON.stringify({ error: 'input too large (control protocol is line-delimited JSON)' }) + '\n');
        conn.destroy();
        return;
      }
      // Process newline-delimited messages
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let cmd;
        try {
          cmd = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ error: 'invalid JSON' }) + '\n');
          continue;
        }

        handleCommand(cmd, state, handlers, startedAt)
          .then((result) => {
            conn.write(JSON.stringify(result) + '\n');
          })
          .catch((err) => {
            conn.write(JSON.stringify({ error: err.message }) + '\n');
          });
      }
    });
    conn.on('error', () => {}); // ignore client disconnect
  });

  server.listen(SOCKET_PATH, () => {
    // Restrict socket permissions to owner only
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    console.log(`[Control] Listening on ${SOCKET_PATH}`);
  });

  server.on('error', (err) => {
    console.error(`[Control] Server error: ${err.message}`);
  });

  // HTTP health check on port 9842 (for Docker/k8s/monitoring)
  const http = require('http');
  const { loadDispatcherConfig } = require('./config-loader.js');
  const healthPort = loadDispatcherConfig().runtime.health_port;
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      // WP-D2: the health document is the monitor-room contract. Its field
      // PATHS are versioned API — spec-8 http-api probes extract dotted
      // paths (agents.0.status, containers.0.state, summary.containers_unhealthy)
      // and break silently if a path drifts. Treat a renamed field like a
      // removed endpoint. See buildHealthDocument().
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildHealthDocument(state, startedAt)));
    } else if (req.url === '/metrics') {
      // Prometheus-style metrics
      const uptimeMs = Date.now() - startedAt;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end([
        `# HELP j41_uptime_seconds Dispatcher uptime in seconds`,
        `j41_uptime_seconds ${Math.floor(uptimeMs / 1000)}`,
        `# HELP j41_agents_total Total registered agents`,
        `j41_agents_total ${state.agents.length}`,
        `# HELP j41_jobs_active Currently active jobs`,
        `j41_jobs_active ${state.active.size}`,
        `# HELP j41_jobs_queue Queued jobs waiting for slots`,
        `j41_jobs_queue ${state.queue.length}`,
        `# HELP j41_agents_available Available agent slots`,
        `j41_agents_available ${state.available.length}`,
        `# HELP j41_jobs_seen_total Total jobs seen (lifetime)`,
        `j41_jobs_seen_total ${state.seen.size}`,
        '',
      ].join('\n'));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  healthServer.listen(healthPort, '127.0.0.1', () => {
    console.log(`[Health] http://127.0.0.1:${healthPort}/health`);
  });
  // B1: swallowing the error meant a dispatcher that lost the port race (e.g. a
  // restart overlapping its predecessor) ran its ENTIRE life with no /health, and
  // monitoring read that as "down" or, worse, kept reading the OLD process's numbers.
  // Retry a bounded number of times so the successor picks the port up once the old
  // process exits, and say so if it never does.
  let _healthBindAttempts = 0;
  healthServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && _healthBindAttempts < 10) {
      _healthBindAttempts++;
      setTimeout(() => {
        // Do not resurrect a server we have since been asked to close: the retry
        // would re-bind the port up to 3s AFTER stopControlServer(), which in any
        // process that stops the control plane without exiting leaves the port held
        // by a dispatcher that has stopped serving.
        if (healthServer._closing) return;
        try { healthServer.listen(healthPort, '127.0.0.1'); } catch {}
      }, 3000).unref?.();
      if (_healthBindAttempts === 1) console.warn(`[Health] port ${healthPort} busy — retrying`);
      return;
    }
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[Health] port ${healthPort} still busy after ${_healthBindAttempts} retries — ` +
        'running WITHOUT /health. Monitoring will see this dispatcher as down.');
    }
  });

  // The health server was a local, so `stopControlServer()` closed the control
  // socket and left the health port listening — a handle with no owner.
  //
  // Today all three call sites are immediately followed by process exit, so the
  // OS reclaims it and the production impact is nil. It matters for anything
  // that stops the control plane WITHOUT exiting: the execution harness does
  // exactly that between scenarios, and every one of them leaked a bound port.
  // "Cleanup that only works because the process dies next" is a fragile
  // contract to keep relying on.
  server._healthServer = healthServer;

  return server;
}

// ─────────────────────────────────────────
// Read-model builders (WP-D1)
//
// The single source of truth for the dispatcher's read surface. Both the
// Unix-socket control plane (handleCommand) and the HTTP control API
// (src/control-api.js) project state through these, so `ctl status` and
// `GET /v1/status` can never drift apart.
// ─────────────────────────────────────────

function buildStatus(state, startedAt) {
  const uptimeMs = Date.now() - startedAt;
  const uptimeMin = Math.floor(uptimeMs / 60000);
  const uptimeHr = Math.floor(uptimeMin / 60);
  const uptime = uptimeHr > 0 ? `${uptimeHr}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
  return {
    uptime,
    uptimeMs,
    agents: {
      total: state.agents.length,
      available: state.available.length,
      busy: state.agents.length - state.available.length,
    },
    active: state.active.size,
    queue: state.queue.length,
    seen: state.seen.size,
  };
}

function buildJobs(state) {
  const jobs = [];
  for (const [jobId, active] of state.active) {
    jobs.push({
      jobId,
      agentId: active.agentId,
      pid: active.pid || null,
      startedAt: active.startedAt,
      runningFor: `${Math.floor((Date.now() - active.startedAt) / 60000)}m`,
      paused: active.paused || false,
      workspace: active.workspaceNotified || false,
      tokens: active.tokenUsage || null,
    });
  }
  return { active: jobs, queue: state.queue.length };
}

/** Detail for one active job, or null if it's not running. */
function buildJob(state, jobId) {
  const active = state.active.get(jobId);
  if (!active) return null;
  return {
    jobId,
    agentId: active.agentId,
    pid: active.pid || null,
    startedAt: active.startedAt,
    runningFor: `${Math.floor((Date.now() - active.startedAt) / 60000)}m`,
    paused: active.paused || false,
    pauseCount: active.pauseCount || 0,
    reworkCount: active.reworkCount || 0,
    workspace: active.workspaceNotified || false,
    container: active.container?.name || null,
    jobAmount: active.jobAmount ?? null,
    currency: active.currency || 'VRSC',
    tokens: active.tokenUsage || null,
  };
}

function buildAgents(state) {
  const agents = state.agents.map((a) => {
    const busy = [...state.active.values()].find(v => v.agentId === a.id);
    const caps = state.capabilities?.get(a.id);
    return {
      id: a.id,
      identity: a.identity,
      status: busy ? 'busy' : 'available',
      workspace: caps?.workspace || false,
      services: caps?.services?.length || 0,
      currentJob: busy ? [...state.active.entries()].find(([, v]) => v.agentId === a.id)?.[0]?.substring(0, 8) : null,
    };
  });
  return { agents };
}

async function buildEarnings(state, getAgentSession) {
  const earnings = { agents: [], total: { jobs: 0, earned: 0, tokenCost: 0 } };
  for (const agentInfo of state.agents) {
    try {
      const agent = await getAgentSession(state, agentInfo);
      const completed = await agent.client.getMyJobs({ status: 'completed', role: 'seller' });
      const delivered = await agent.client.getMyJobs({ status: 'delivered', role: 'seller' });
      const jobs = [...(completed.data || []), ...(delivered.data || [])];
      let earned = 0;
      for (const j of jobs) earned += parseFloat(j.amount) || 0;
      earnings.agents.push({
        id: agentInfo.id,
        identity: agentInfo.identity,
        jobs: jobs.length,
        earned: Math.round(earned * 1000) / 1000,
        currency: jobs[0]?.currency || 'VRSC',
      });
      earnings.total.jobs += jobs.length;
      earnings.total.earned += earned;
    } catch (e) {
      earnings.agents.push({ id: agentInfo.id, error: e.message });
    }
  }
  earnings.total.earned = Math.round(earnings.total.earned * 1000) / 1000;
  return earnings;
}

/**
 * Per-agent upstream-health snapshot for the local control socket.
 * Reads the in-process poller map (same process). null = never probed.
 * @param {object} state - dispatcher state with an `agents` array
 * @returns {Object<string, object|null>} agentId → health entry or null
 */
function buildUpstreamHealth(state) {
  const { getHealth } = require('./upstream-health.js');
  const out = {};
  for (const a of state.agents) {
    out[a.id] = getHealth(a.id) || null;
  }
  return out;
}

/**
 * The health document (WP-D2). Stable dotted paths for the monitor room:
 *   agents.N.status / agents.N.lastError
 *   containers.N.name / containers.N.state / containers.N.crashes
 *   summary.containers_unhealthy (numeric → `above:0` is the canonical
 *     "tell me when anything is wrong" watch)
 * Back-compat scalars (active/queue/available) are retained so existing
 * 200-checks keep working; `agents` is now an array (the intended v1 shape).
 */
// Observability: a provable stamp of exactly which code is running — the
// dispatcher's version+commit and the digest of the job-agent image it spawns.
// The tester's highest-leverage ask ("add a commit stamp"), applied to our side,
// so which build is live is a fact in /health, not something read out by hand.
let _verBase = null;        // {dispatcher, commit, node} — computed once
let _imgId = 'unknown';     // job-agent image digest — refreshed on a TTL
let _imgAt = 0;
function getVersionStamp() {
  if (!_verBase) {
    let dispatcher = 'unknown';
    try { dispatcher = require('../package.json').version || 'unknown'; } catch { /* not packaged */ }
    let commit = 'unknown';
    try {
      commit = require('child_process')
        .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim() || 'unknown';
    } catch { /* not a git checkout (npm install) */ }
    _verBase = { dispatcher, commit, node: process.version };
  }
  // The image can change between restarts; refresh at most once a minute. docker
  // inspect is bounded by a short timeout and never throws out of here.
  const now = Date.now();
  if (now - _imgAt > 60000) {
    try {
      _imgId = require('child_process')
        .execSync("docker image inspect j41/job-agent:latest --format '{{.Id}}'", { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500 })
        .toString().trim() || 'unknown';
    } catch { _imgId = 'unknown'; }
    _imgAt = now;
  }
  return { ..._verBase, jobAgentImage: _imgId };
}

/**
 * Structured read model of inbox health.
 *
 * The pre-existing surface was a single per-agent `lastError` string, overwritten
 * by each new failure — so a dead-lettered review whose data never reached the
 * chain was invisible the moment anything else failed. Silent loss of on-chain
 * reputation data is exactly what must not be quiet, hence a non-lossy list.
 *
 * Pure read model: no mutation, tolerant of a state object predating these maps.
 */
function buildInboxSurface(state) {
  const { listInboxFailures } = require('./inbox-deadletter.js');
  const failures = state._inboxFailures || new Map();
  const { deadLettered, retrying } = listInboxFailures(failures);

  const now = Date.now();
  const pendingWrites = [...(state._inboxLastWrite || new Map()).entries()].map(([agentId, w]) => ({
    agentId,
    txid: w.txid,
    ageMs: typeof w.at === 'number' ? now - w.at : null,
    expiryHeight: w.expiryHeight ?? null,
  }));

  // Items written on-chain whose backend ack keeps failing. They sit in no other
  // bucket (never counted, never dead-lettered), so without this they are
  // invisible apart from a console warning.
  const ackFailed = [...(state._inboxAckFailures || new Map()).entries()].map(([itemId, a]) => ({
    itemId,
    agentId: a.agentId || null,
    type: a.type || null,
    consecutive: a.consecutive || 0,
    lastError: a.lastError || null,
  }));

  return { deadLettered, retrying, ackFailed, pendingWrites };
}

/**
 * Read model of the deposit ledger, for every transport at once.
 *
 * Wraps `listDepositAnomalies` (which owns the on-disk format) so the socket,
 * the health document, `GET /v1/deposits` and the `deposits` CLI all consume one
 * builder — the same reason `buildInboxSurface` exists.
 *
 * Reads disk rather than dispatcher state on purpose: a `needsOperator` flag is
 * durable and survives restarts, so gating it on `startupComplete` (as the
 * status axes are gated) would hide the very thing it exists to show.
 */
function buildDepositSurface(state) {
  try {
    const { listDepositAnomalies } = require('./deposit-watcher.js');
    return listDepositAnomalies((state.agents || []).map((a) => a.id));
  } catch (e) {
    // A read model must never be the reason /health stops answering.
    return { agents: [], summary: { deposits_unconfirmed_open: 0, deposits_needs_operator: 0 }, error: String(e.message || e) };
  }
}

/**
 * Read model of one agent's fee tank, from the sample `checkFeeTanks` records in
 * `state._feeTankLast` each cycle. Read side only — nothing here fetches UTXOs.
 *
 * The R-address is the only address that can pay a transaction fee, and it only
 * ever drains. When it empties the agent silently stops writing on-chain (no
 * reviews, no attestations, no job records) while still holding unswept
 * earnings — which is exactly how 2026-08-05 went unnoticed. Balance had no
 * surface anywhere; now it has one.
 *
 * Null-tolerant like the inbox surface: a state object predating the map, or an
 * agent the sweep loop has not reached yet (it runs on its own 30-min timer, so
 * every agent reads null for the first ~15s of a run), yields null rather than
 * a zero that would read as "empty tank".
 */
function buildFeeTank(state, agentId, now) {
  const last = state._feeTankLast;
  const t = (last && typeof last.get === 'function') ? last.get(agentId) : null;
  if (!t || typeof t !== 'object') return null;

  const { writesAffordable } = require('./fee-tank.js');
  const numOrNull = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const feeSats = numOrNull(t.feeSats);
  // Trust the recorded count; derive it only when the sample lacks one, so the
  // fees-per-write constant stays owned by fee-tank.js either way.
  const writes = numOrNull(t.writes) ?? (feeSats === null ? null : writesAffordable(feeSats));

  return {
    feeSats,
    writes,
    sweepableSats: numOrNull(t.sweepableSats),
    reason: t.reason || null,
    ageMs: typeof t.at === 'number' && Number.isFinite(t.at) ? now - t.at : null,
  };
}

// How long a startup may reasonably take before not-finishing is itself a fault.
// Covers the 3-minute deactivate-confirmation wait, a staggered activation of a
// large fleet, and the inbox sweep's own 10-minute startup grace, with room over.
const STARTUP_EXPECTED_MS = 20 * 60 * 1000;

/** Does this status value block a hire? Mirrors the platform's fail-closed AND.
 *  `unknown` does not block — it means "not checked yet", and treating absence of
 *  information as failure makes every cold start look like an outage. */
function _axisBlocks(v) {
  // Anything that is not positively `active` and not `unknown` blocks. Listing only
  // `inactive`/`disabled` contradicted the rule effectiveAgentStatus enforces — that
  // an unrecognised value beats `active` — so the day the backend adds a blocking
  // state (`suspended`, `throttled`, …) the hire gate would refuse work while
  // /health reported ok. That "fleet unhireable, every surface green" shape is the
  // one this whole area exists to make impossible, and it must not depend on us
  // having enumerated the backend's vocabulary in advance.
  if (v === undefined || v === null || v === '') return false;
  const t = String(v).trim().toLowerCase();
  return t !== 'active' && t !== 'unknown';
}

function buildHealthDocument(state, startedAt) {
  const uptime = Date.now() - startedAt;
  const now = Date.now();

  const agents = state.agents.map((a) => {
    const busyEntry = [...state.active.entries()].find(([, v]) => v.agentId === a.id);
    return {
      id: a.id,
      identity: a.identity || null,
      status: busyEntry ? (busyEntry[1].paused ? 'paused' : 'busy') : 'available',
      // B1: local job assignment says nothing about whether the PLATFORM still
      // considers this agent online. During the 2026-08-06 fleet outage every agent
      // reported "available" while the platform had all nine inactive, and /health
      // stayed green throughout. An agent that is inactive upstream cannot receive
      // work no matter how idle it looks here.
      platformStatus: a.platformStatus || 'unknown',
      // The SECOND axis, and a hire needs both. On-chain `status` is no longer
      // written on a routine restart, so it can sit at `inactive` from an older
      // dispatcher while the platform axis reads `active`. The startup loop stamps
      // `platformStatus = 'active'` after a successful platform write, so reporting
      // only that field would hide a fleet the hire gate is blocking — every local
      // surface green, zero work possible, which is the 2026-08-06 shape.
      chainStatus: a.chainStatus || 'unknown',
      currentJob: busyEntry ? busyEntry[0] : null,
      lastError: state._agentErrors?.get(a.id) || null,
      feeTank: buildFeeTank(state, a.id, now),
    };
  });

  const containers = [...state.active.entries()].map(([jobId, v]) => ({
    name: v.container?.name || `job-${jobId.substring(0, 8)}`,
    jobId,
    agentId: v.agentId || null,
    state: v.paused ? 'paused' : 'running',
    startedAt: v.startedAt || null,
    crashes: state._containerCrashes?.get(v.agentId) || 0,
  }));

  // Unhealthy = a container that has crashed at least once in this run.
  const crashTotal = state._containerCrashes
    ? [...state._containerCrashes.values()].reduce((n, c) => n + (c > 0 ? 1 : 0), 0)
    : 0;
  const containersUnhealthy = crashTotal;

  const agentsBusy = agents.filter((a) => a.status !== 'available').length;

  const inbox = buildInboxSurface(state);
  const deposits = buildDepositSurface(state);

  // Sampled tanks that cannot afford even one on-chain write. Deliberately NOT
  // folded into `status`: `_agentErrors` already carries FEE TANK EMPTY into
  // `agents[].lastError`, and an empty tank on a freshly-created agent is normal
  // during onboarding — not a degraded dispatcher.
  const feeTanksEmpty = agents.filter((a) => a.feeTank && a.feeTank.writes === 0).length;

  return {
    // A dead-lettered inbox item means on-chain reputation data silently did not
    // land, which is a degraded dispatcher even when every container is healthy.
    // B1: a fleet the platform considers inactive cannot take work, so reporting `ok`
    // is actively misleading — that is exactly what happened through the 2026-08-06
    // outage. `unknown` does NOT degrade: it only means we have not checked yet.
    // Platform status only degrades AFTER startup activation has finished. The health
    // server binds before agents are activated (staggered ~1s each), so degrading
    // during that window would fire an alert on every single restart — and an alert
    // that cries wolf on every restart is precisely how the 2026-08-06 outage went
    // unnoticed in the first place.
    status: (containersUnhealthy > 0
      || inbox.deadLettered.length > 0
      // A needsOperator deposit means a buyer's balance may be wrong and only a
      // human can say which way. That is strictly worse than a dead-lettered
      // inbox item, and those already degrade. Durable disk state, so no
      // startupComplete gating — it is true before the fleet finishes starting.
      //
      // Be aware this signal is weak in practice: `_containerCrashes` only ever
      // increments, so one crash pins /health to `degraded` for the rest of the
      // run and every later trigger is masked. `summary.deposits_needs_operator`
      // above:0 is the watch that actually carries information.
      || deposits.summary.deposits_needs_operator > 0
      // An agent carrying a live error cannot work, whatever its status axes say.
      // Both axes read `unknown` when the pre-start status check fails — which is
      // what happens during the daily platform outage — so a restart into that
      // window activated nothing, recorded "activation failed: 503" on all nine,
      // and still reported `ok`. `unknown` deliberately does not degrade on its own
      // ("not checked yet" is not "broken"), and that is exactly why the error
      // itself has to.
      || (state.startupComplete === true && agents.some(a => a.lastError))
      // Startup that never finishes is the zombie shape: the axis degrade below is
      // gated on startupComplete, so a startup that dies partway leaves /health
      // green forever while the process sits there doing nothing. Past a generous
      // bound, not having finished IS the fault.
      || (state.startupComplete !== true && state.startedAt
          && (now - state.startedAt) > STARTUP_EXPECTED_MS)
      || (state.startupComplete === true
          && agents.some(a => _axisBlocks(a.platformStatus) || _axisBlocks(a.chainStatus))))
      ? 'degraded' : 'ok',
    inbox,
    deposits,
    uptime,
    version: getVersionStamp(),
    agents,
    containers,
    // back-compat scalars (pre-WP-D2 consumers / Docker healthcheck)
    active: state.active.size,
    queue: state.queue.length,
    available: state.available.length,
    summary: {
      agents_total: state.agents.length,
      agents_busy: agentsBusy,
      agents_available: state.available.length,
      containers_total: containers.length,
      containers_unhealthy: containersUnhealthy,
      fee_tanks_empty: feeTanksEmpty,
      // 0-conf credits the reconciler is still tracking. Not itself a fault —
      // it is the normal resting state of a small deposit — but a number that
      // climbs and never falls means the reconciler has stopped resolving them.
      deposits_unconfirmed_open: deposits.summary.deposits_unconfirmed_open,
      // Buyers whose balance may be wrong, where only a human can decide.
      // THE watch for this feature; see the degrade note above.
      deposits_needs_operator: deposits.summary.deposits_needs_operator,
      // Agents whose auth is deliberately paused because the platform is down.
      // Without this an outage looks identical to a hang: agents present, no
      // work moving, nothing obviously wrong.
      auth_backoff_agents: (() => {
        try {
          const { summarizeAuthBackoff } = require('./auth-backoff.js');
          return summarizeAuthBackoff(state._authBackoff, Date.now()).waiting;
        } catch { return 0; }
      })(),
      // Cycles a loop skipped because the previous one had not finished. Non-zero
      // means the dispatcher cannot keep up with its own interval at this agent
      // count — the fleet stops looking for work, and tanks stop being watched,
      // while everything else still reports healthy. A log line nobody greps is
      // not observability.
      poll_cycles_skipped: Number.isFinite(state._pollSkips) ? state._pollSkips : 0,
      fee_tank_cycles_skipped: Number.isFinite(state._feeSweepSkips) ? state._feeSweepSkips : 0,
      jobs_active: state.active.size,
      jobs_queued: state.queue.length,
      jobs_seen: state.seen.size,
    },
  };
}

async function handleCommand(cmd, state, handlers, startedAt) {
  const action = cmd.action || cmd.command || cmd.cmd;

  switch (action) {
    case 'status':
      return buildStatus(state, startedAt);

    case 'jobs':
      return buildJobs(state);

    case 'agents':
      return buildAgents(state);

    case 'upstream_health':
      return buildUpstreamHealth(state);

    case 'inbox':
      return buildInboxSurface(state);

    case 'deposits':
      return buildDepositSurface(state);

    case 'inbox-redrive': {
      // Clear dead-letter quarantine without a restart, granting a fresh full
      // budget. Deliberate operator action — nothing calls this automatically.
      const { redriveDeadLetters } = require('./inbox-deadletter.js');
      const redriven = redriveDeadLetters(state._inboxFailures || new Map(), cmd.itemId);
      return { redriven, itemId: cmd.itemId || null };
    }

    case 'shutdown': {
      if (handlers.onShutdown) {
        // Respond before shutting down
        setTimeout(() => handlers.onShutdown('control-plane'), 100);
        return { ok: true, message: 'Graceful shutdown initiated' };
      }
      return { error: 'No shutdown handler registered' };
    }

    case 'canary': {
      const agentId = cmd.agentId || cmd.agent;
      if (!agentId) return { error: 'agentId required' };
      const agentInfo = state.agents.find(a => a.id === agentId);
      if (!agentInfo) return { error: `Agent ${agentId} not found` };
      try {
        const agent = await handlers.getAgentSession(state, agentInfo);
        const result = await agent.client.checkCanaryLeak(agentInfo.identity);
        return { agentId, canary: result };
      } catch (e) {
        return { agentId, error: e.message };
      }
    }

    case 'earnings':
      return buildEarnings(state, handlers.getAgentSession);

    case 'resources': {
      const cpus = os.cpus();
      const loadAvg = os.loadavg();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      // Per-job process memory (if available)
      const jobProcesses = [];
      for (const [jobId, active] of state.active) {
        if (active.pid) {
          try {
            const stat = fs.readFileSync(`/proc/${active.pid}/status`, 'utf8');
            const vmRss = stat.match(/VmRSS:\s+(\d+)/);
            jobProcesses.push({
              jobId: jobId.substring(0, 8),
              pid: active.pid,
              memMB: vmRss ? Math.round(parseInt(vmRss[1]) / 1024) : null,
              agentId: active.agentId,
            });
          } catch {
            jobProcesses.push({ jobId: jobId.substring(0, 8), pid: active.pid, memMB: null, agentId: active.agentId });
          }
        }
      }

      return {
        cpu: {
          cores: cpus.length,
          model: cpus[0]?.model || 'unknown',
          load1m: Math.round(loadAvg[0] * 100) / 100,
          load5m: Math.round(loadAvg[1] * 100) / 100,
          load15m: Math.round(loadAvg[2] * 100) / 100,
          usagePercent: Math.round((loadAvg[0] / cpus.length) * 100),
        },
        memory: {
          totalMB: Math.round(totalMem / 1024 / 1024),
          usedMB: Math.round(usedMem / 1024 / 1024),
          freeMB: Math.round(freeMem / 1024 / 1024),
          usagePercent: Math.round((usedMem / totalMem) * 100),
        },
        jobs: jobProcesses,
        capacity: {
          maxSlots: state.agents.length,
          active: state.active.size,
          available: state.available.length,
          headroom: `${Math.round((1 - loadAvg[0] / cpus.length) * 100)}% CPU, ${Math.round(freeMem / 1024 / 1024)}MB RAM free`,
        },
      };
    }

    case 'history': {
      // Recent completed jobs from disk — read from _live (active) and _logs (archived)
      const JOBS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'jobs');
      const jobs = [];
      try {
        // Collect job ids from both _live and _logs dirs, deduplicated, newest-first
        const liveDir = path.join(JOBS_DIR, '_live');
        const archiveDir = path.join(JOBS_DIR, '_logs');
        const liveIds = fs.existsSync(liveDir)
          ? fs.readdirSync(liveDir).filter(f => f.endsWith('.log')).map(f => f.slice(0, -4))
          : [];
        const archiveIds = fs.existsSync(archiveDir)
          ? fs.readdirSync(archiveDir).filter(f => f.endsWith('.log')).map(f => f.slice(0, -4))
          : [];
        const allIds = Array.from(new Set([...liveIds, ...archiveIds])).sort().reverse().slice(0, cmd.limit || 20);
        for (const jobId of allIds) {
          // Prefer _live, fall back to _logs
          const livePath = path.join(liveDir, `${jobId}.log`);
          const archivePath = path.join(archiveDir, `${jobId}.log`);
          let logPath = null;
          // lstat-guard: skip symlinks
          if (fs.existsSync(livePath) && !fs.lstatSync(livePath).isSymbolicLink()) logPath = livePath;
          else if (fs.existsSync(archivePath) && !fs.lstatSync(archivePath).isSymbolicLink()) logPath = archivePath;
          if (!logPath) continue;
          let fd;
          try { fd = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
          catch { continue; }
          let log;
          try { log = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
          const tokenMatch = log.match(/\[TOKENS\] Session: (\d+) calls, (\d+) in, (\d+) out, (\d+) total/);
          const agentMatch = log.match(/Job started — agent: (agent-\d+)/);
          jobs.push({
            jobId: jobId.substring(0, 8),
            agent: agentMatch?.[1] || 'unknown',
            tokens: tokenMatch ? { calls: +tokenMatch[1], promptTokens: +tokenMatch[2], completionTokens: +tokenMatch[3], totalTokens: +tokenMatch[4] } : null,
            hasAttestation: fs.existsSync(path.join(JOBS_DIR, jobId, 'deletion-attestation.json')),
          });
        }
      } catch {}
      return { jobs };
    }

    case 'providers': {
      // List available LLM providers and current config
      try {
        const { LLM_PRESETS, LLM_CONFIG } = require('./executors/local-llm.js');
        return {
          current: { provider: LLM_CONFIG?.provider, model: LLM_CONFIG?.model, baseUrl: LLM_CONFIG?.baseUrl },
          available: Object.keys(LLM_PRESETS || {}),
        };
      } catch {
        return { error: 'Could not load LLM presets' };
      }
    }

    default:
      return {
        error: `Unknown command: ${action}`,
        available: ['status', 'jobs', 'agents', 'resources', 'earnings', 'history', 'providers', 'inbox', 'deposits', 'shutdown', 'canary'],
      };
  }
}

/**
 * Send a command to the running dispatcher's control plane.
 * @param {object} cmd — command object (e.g. { action: 'status' })
 * @returns {Promise<object>} — response
 */
function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      reject(new Error('Dispatcher is not running (no control socket)'));
      return;
    }

    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(cmd) + '\n');
    });

    let buf = '';
    client.on('data', (data) => {
      buf += data.toString();
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch {
          reject(new Error('Invalid response from dispatcher'));
        }
        client.end();
      }
    });

    client.on('error', (err) => {
      reject(new Error(`Cannot connect to dispatcher: ${err.message}`));
    });

    // Timeout
    setTimeout(() => {
      client.destroy();
      reject(new Error('Control plane timeout (5s)'));
    }, 5000);
  });
}

/**
 * Clean up the socket file on shutdown.
 */
function stopControlServer(server) {
  if (server) {
    server.close();
    if (server._healthServer) {
      // Set BEFORE close(): the EADDRINUSE retry timer checks this flag, and a
      // pending retry would otherwise re-listen seconds after we closed.
      server._healthServer._closing = true;
      try { server._healthServer.close(); } catch { /* never bound */ }
    }
  }
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch {}
}

module.exports = {
  SOCKET_PATH,
  startControlServer,
  stopControlServer,
  sendCommand,
  // Read-model builders — shared with src/control-api.js (WP-D1)
  buildStatus,
  buildJobs,
  buildJob,
  buildAgents,
  buildUpstreamHealth,
  buildEarnings,
  buildHealthDocument,
  buildInboxSurface,
  buildDepositSurface,
  handleCommand,
  getVersionStamp,
};
