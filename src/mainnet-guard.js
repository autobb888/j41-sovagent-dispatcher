'use strict';

/**
 * List insecure flags that must not be set when running on mainnet.
 * Pure: depends only on its arguments; never throws; no I/O.
 * @param {object} env - process.env (or a test double)
 * @param {{devUnsafe?: boolean}} [opts] - parsed start options
 * @returns {string[]} human-readable violation messages (empty = safe)
 */
function findMainnetSecurityViolations(env, opts) {
  const e = env || {};
  const o = opts || {};
  const v = [];
  if (e.J41_SIGNING_BROKER === '0') v.push('J41_SIGNING_BROKER=0 — broker signing disabled; the agent WIF would be mounted into the job container');
  if (e.J41_ALLOW_INSECURE_WIF_MOUNT === '1') v.push('J41_ALLOW_INSECURE_WIF_MOUNT=1 — mounts the agent WIF into a prompt-injectable container');
  if (o.devUnsafe) v.push('--dev-unsafe — local mode with zero container isolation');
  if (e.J41_DISABLE_BWRAP === '1') v.push('J41_DISABLE_BWRAP=1 — disables the bwrap entrypoint sandbox');
  if (e.J41_ALLOW_LOCAL_UPSTREAM === '1') v.push('J41_ALLOW_LOCAL_UPSTREAM=1 — disables SSRF protection on the proxy');
  if (e.J41_SKIP_STATUS_CHECK === '1') v.push('J41_SKIP_STATUS_CHECK=1 — skips agent platform-status checks');
  if (e.J41_ALLOW_LEGACY_REVOKE === '1') v.push('J41_ALLOW_LEGACY_REVOKE=1 — accepts replayable legacy revoke webhooks');
  return v;
}

/**
 * Resolve whether we're on mainnet for security purposes. Mainnet is "sticky":
 * true if EITHER the on-disk config file OR the (possibly env-overridden)
 * effective network is 'verus'. So J41_NETWORK env can never DOWNGRADE a
 * mainnet deployment to testnet to disable the security gate.
 * @param {string|null|undefined} fileNetwork - platform.network from the raw config file
 * @param {string|null|undefined} effectiveNetwork - cfg.platform.network (after env overrides)
 * @returns {boolean}
 */
function resolveIsMainnet(fileNetwork, effectiveNetwork) {
  return fileNetwork === 'verus' || effectiveNetwork === 'verus';
}

module.exports = { findMainnetSecurityViolations, resolveIsMainnet };
