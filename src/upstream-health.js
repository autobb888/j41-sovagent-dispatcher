/**
 * Upstream LLM Health Poller — periodic health checks for api-endpoint agents.
 * Marks services as healthy/down so the dashboard can surface status and the
 * proxy can short-circuit 503 instead of timing out against a dead upstream.
 */

const _health = new Map(); // agentId → { healthy: bool, lastCheck: number, status?: number, error?: string }

/**
 * Check a single upstream URL by calling /models with a short timeout.
 * Treats 200 and 404 as healthy (some servers don't implement /models but still serve chat).
 */
async function checkUpstream(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/models`, { signal: controller.signal });
    clearTimeout(t);
    return { healthy: res.ok || res.status === 404, status: res.status };
  } catch (e) {
    clearTimeout(t);
    return { healthy: false, error: e.message };
  }
}

/**
 * Start a background poller that checks each api-endpoint agent's upstream URL.
 *
 * @param {Map<string, {endpointUrl: string}>} agentConfigs - Map from agentId to config
 * @param {number} [intervalMs=60000] - Poll interval
 * @returns {NodeJS.Timer} Timer handle (unref'd — won't keep process alive)
 */
function startHealthPoller(agentConfigs, intervalMs = 60000) {
  // Run an immediate check, then periodically
  const runCheck = async () => {
    for (const [agentId, cfg] of agentConfigs.entries()) {
      if (!cfg.endpointUrl) continue;
      const result = await checkUpstream(cfg.endpointUrl);
      _health.set(agentId, { ...result, lastCheck: Date.now() });
      if (!result.healthy) {
        console.warn(`[Health] ${agentId} upstream ${cfg.endpointUrl}: ${result.error || ('status ' + result.status)}`);
      }
    }
  };

  runCheck().catch(() => {});
  const timer = setInterval(() => { runCheck().catch(() => {}); }, intervalMs);
  timer.unref();
  return timer;
}

/** Get the last health check result for an agent (undefined if never checked). */
function getHealth(agentId) {
  return _health.get(agentId);
}

module.exports = { checkUpstream, startHealthPoller, getHealth };
