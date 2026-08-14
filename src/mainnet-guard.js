'use strict';

/**
 * List insecure flags that must not be set when running on mainnet.
 *
 * The rule for what belongs here: a flag qualifies if setting it makes the
 * dispatcher LESS safe than its default. Flags that only tighten behaviour, and
 * flags already enforced elsewhere, do not belong — e.g. `J41_PLATFORM_SIGNER`
 * is deliberately absent because the SDK already refuses to run on mainnet
 * without it (audit H9, client/index.ts), so duplicating it here would only
 * create a second place to forget.
 *
 * Both dispatcher-side and SDK-side flags are checked. The dispatcher's env is
 * what gets forwarded into job containers, so an SDK bypass set here reaches the
 * containers too.
 *
 * Pure: depends only on its arguments; never throws; no I/O.
 * @param {object} env - process.env (or a test double)
 * @param {{devUnsafe?: boolean}} [opts] - parsed start options
 * @returns {string[]} human-readable violation messages (empty = safe)
 */
function findMainnetSecurityViolations(env, opts) {
  const e = env || {};
  const o = opts || {};
  const v = [];
  if (e.J41_SIGNING_BROKER === '0') v.push('J41_SIGNING_BROKER=0 — broker signing disabled; the host-side signing broker is mandatory so the agent WIF never enters the job container');
  if (o.devUnsafe) v.push('--dev-unsafe — local mode with zero container isolation');
  if (e.J41_DISABLE_BWRAP === '1') v.push('J41_DISABLE_BWRAP=1 — disables the bwrap entrypoint sandbox');
  if (e.J41_ALLOW_LOCAL_UPSTREAM === '1') v.push('J41_ALLOW_LOCAL_UPSTREAM=1 — disables SSRF protection on the proxy');
  if (e.J41_SKIP_STATUS_CHECK === '1') v.push('J41_SKIP_STATUS_CHECK=1 — skips agent platform-status checks');
  if (e.J41_ALLOW_LEGACY_REVOKE === '1') v.push('J41_ALLOW_LEGACY_REVOKE=1 — accepts replayable legacy revoke webhooks');
  if (e.J41_WITNESS_VERIFY === 'off') v.push('J41_WITNESS_VERIFY=off — disables platform-witness verification of on-chain job records');

  // ── Added 2026-08-05 after an audit asked why the list stopped where it did ──
  // Each of these downgrades a default that exists because something went wrong
  // once. The gate's job is to make "temporarily loosened for a testnet debug
  // session" impossible to carry into a mainnet deployment by accident.
  //
  // Money:
  if (e.J41_ALLOW_UNPRICED_JOBS === '1') v.push('J41_ALLOW_UNPRICED_JOBS=1 — admits jobs with no payment record at all; the agent does the work and may never be paid');

  // Prompt-injection / untrusted input:
  if (e.J41_SCAN_BUYER_CHAT === '0') v.push('J41_SCAN_BUYER_CHAT=0 — disables SovGuard scanning of inbound buyer messages before they reach the executor');

  // Transport and signing:
  if (e.J41_ALLOW_INSECURE === '1') v.push('J41_ALLOW_INSECURE=1 — permits plaintext HTTP to the platform; credentials cross the wire in the clear');
  if (e.J41_LOCAL_SIGNER_TEST_MODE === '1') v.push('J41_LOCAL_SIGNER_TEST_MODE=1 — lets the local signer sign a deliver message without the authoritative jobHash; a test-only path that must never reach production');
  if (e.J41_TRUST_PLATFORM_RESOLUTION === '1') v.push('J41_TRUST_PLATFORM_RESOLUTION=1 — trusts platform-supplied identity resolution instead of verifying locally, so the platform decides where a payment goes');

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
