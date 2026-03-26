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

    default:
      return {
        error: `Unknown command: ${action}`,
        available: ['status', 'jobs', 'agents', 'shutdown', 'canary'],
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
