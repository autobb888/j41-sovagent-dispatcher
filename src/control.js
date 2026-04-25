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

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (data) => {
      buf += data.toString();
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
      const uptimeMs = Date.now() - startedAt;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: uptimeMs,
        agents: state.agents.length,
        active: state.active.size,
        queue: state.queue.length,
        available: state.available.length,
      }));
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

async function handleCommand(cmd, state, handlers, startedAt) {
  const action = cmd.action || cmd.command || cmd.cmd;

  switch (action) {
    case 'status': {
      const uptimeMs = Date.now() - startedAt;
      const uptimeMin = Math.floor(uptimeMs / 60000);
      const uptimeHr = Math.floor(uptimeMin / 60);
      const uptime = uptimeHr > 0
        ? `${uptimeHr}h ${uptimeMin % 60}m`
        : `${uptimeMin}m`;

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

    case 'jobs': {
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

    case 'agents': {
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

    case 'earnings': {
      const earnings = { agents: [], total: { jobs: 0, earned: 0, tokenCost: 0 } };
      for (const agentInfo of state.agents) {
        try {
          const agent = await handlers.getAgentSession(state, agentInfo);
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
};
