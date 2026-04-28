/**
 * Upstream LLM Health Poller — periodic health checks for api-endpoint agents.
 * Marks services as healthy/down so the dashboard can surface status and the
 * proxy can short-circuit 503 instead of timing out against a dead upstream.
 *
 * Circuit breaker (2.1.14): tracks `consecutive_failures` and `circuitOpenedAt`
 * per agent. When consecutive_failures FIRST crosses the threshold, we mark
 * `circuitOpenedAt = Date.now()`. The proxy reads this via getHealth() to
 * fail-fast with 503 inside the open window. We deliberately do NOT use
 * `lastCheck` for the close window — it's set on every poll, so it'd never close.
 * `circuitOpenedAt` is sticky once tripped (subsequent failures don't advance it)
 * and is reset to null on the next successful probe.
 */

const { loadDispatcherConfig } = require('./config-loader.js');

const _health = new Map(); // agentId → { healthy, lastCheck, consecutive_failures, circuitOpenedAt, status?, error? }

const DEFAULT_CIRCUIT_THRESHOLD = 3;

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
 * Record a probe result and update circuit-breaker state for the agent.
 * Exported as `_setHealth` for tests; used internally by the poller.
 *
 * @param {string} agentId
 * @param {{healthy: boolean, status?: number, error?: string}} result - probe outcome
 * @param {number} threshold - consecutive_failures count that opens the circuit
 */
function _setHealth(agentId, result, threshold = DEFAULT_CIRCUIT_THRESHOLD) {
  const prev = _health.get(agentId) || { consecutive_failures: 0, circuitOpenedAt: null };
  const consecutive_failures = result.healthy
    ? 0
    : (prev.consecutive_failures || 0) + 1;
  let circuitOpenedAt = prev.circuitOpenedAt || null;
  if (result.healthy) {
    // Successful probe → close the circuit
    circuitOpenedAt = null;
  } else if (!circuitOpenedAt && consecutive_failures >= threshold) {
    // Just crossed the threshold → open the circuit, mark the moment.
    // Sticky: while still open, subsequent failures don't update this stamp.
    circuitOpenedAt = Date.now();
  }
  _health.set(agentId, {
    ...result,
    consecutive_failures,
    circuitOpenedAt,
    lastCheck: Date.now(),
  });
}

/**
 * Test-only: clear all tracked health state.
 */
function _reset() {
  _health.clear();
}

/**
 * Start a background poller that checks each api-endpoint agent's upstream URL.
 *
 * @param {Map<string, {endpointUrl: string}>} agentConfigs - Map from agentId to config
 * @param {number} [intervalMs] - Poll interval (defaults to config.health.poll_interval_ms)
 * @param {number} [threshold] - Consecutive failures before circuit opens (defaults to 3)
 * @returns {NodeJS.Timer} Timer handle (unref'd — won't keep process alive)
 */
function startHealthPoller(agentConfigs, intervalMs, threshold) {
  intervalMs = intervalMs ?? loadDispatcherConfig().health.poll_interval_ms;
  const thr = threshold ?? DEFAULT_CIRCUIT_THRESHOLD;
  // Run an immediate check, then periodically
  const runCheck = async () => {
    for (const [agentId, cfg] of agentConfigs.entries()) {
      if (!cfg.endpointUrl) continue;
      const result = await checkUpstream(cfg.endpointUrl);
      _setHealth(agentId, result, thr);
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

module.exports = { checkUpstream, startHealthPoller, getHealth, _setHealth, _reset };
