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
  healthServer.on('error', () => {}); // non-fatal if port is busy

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
function buildHealthDocument(state, startedAt) {
  const uptime = Date.now() - startedAt;

  const agents = state.agents.map((a) => {
    const busyEntry = [...state.active.entries()].find(([, v]) => v.agentId === a.id);
    return {
      id: a.id,
      identity: a.identity || null,
      status: busyEntry ? (busyEntry[1].paused ? 'paused' : 'busy') : 'available',
      currentJob: busyEntry ? busyEntry[0] : null,
      lastError: state._agentErrors?.get(a.id) || null,
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

  return {
    status: containersUnhealthy > 0 ? 'degraded' : 'ok',
    uptime,
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
      // Recent completed jobs from disk
      const JOBS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'jobs');
      const jobs = [];
      try {
        const dirs = fs.readdirSync(JOBS_DIR).sort().reverse().slice(0, cmd.limit || 20);
        for (const dir of dirs) {
          const logPath = path.join(JOBS_DIR, dir, 'output.log');
          if (!fs.existsSync(logPath)) continue;
          const log = fs.readFileSync(logPath, 'utf8');
          const tokenMatch = log.match(/\[TOKENS\] Session: (\d+) calls, (\d+) in, (\d+) out, (\d+) total/);
          const agentMatch = log.match(/Job started — agent: (agent-\d+)/);
          jobs.push({
            jobId: dir.substring(0, 8),
            agent: agentMatch?.[1] || 'unknown',
            tokens: tokenMatch ? { calls: +tokenMatch[1], promptTokens: +tokenMatch[2], completionTokens: +tokenMatch[3], totalTokens: +tokenMatch[4] } : null,
            hasAttestation: fs.existsSync(path.join(JOBS_DIR, dir, 'deletion-attestation.json')),
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
        available: ['status', 'jobs', 'agents', 'resources', 'earnings', 'history', 'providers', 'shutdown', 'canary'],
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
};
