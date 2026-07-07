'use strict';
// In-container: route ALL global fetch through the host egress proxy via undici
// ProxyAgent (HTTP CONNECT + per-job token). Note: the undici package's
// setGlobalDispatcher does NOT reroute Node's built-in fetch, so we also replace
// globalThis.fetch with undici's fetch. Must run BEFORE any code captures fetch.
function installEgressProxy({ env = process.env, undici } = {}) {
  const uri = env.J41_EGRESS_PROXY;
  const token = env.J41_EGRESS_TOKEN;
  if (!uri || !token) return false;
  const u = undici || require('undici');
  const agent = new u.ProxyAgent({ uri, token: `Bearer ${token}` });
  u.setGlobalDispatcher(agent);
  globalThis.fetch = u.fetch;
  return true;
}
module.exports = { installEgressProxy };
