'use strict';
/**
 * Teardown steps for an ephemeral job container: the deletion attestation and
 * the SovGuard canary release.
 *
 * WHY THIS IS A SEPARATE MODULE. `job-agent.js` is a container entrypoint with
 * no exports, so its teardown logic could only be "tested" by regex. That is how
 * a helper referencing `_usageRecord` — a `const` scoped inside another function
 * — passed 5/5 structural tests while throwing `ReferenceError` on every
 * invocation at runtime, silently breaking the completion path that had worked.
 *
 * Everything here takes explicit parameters. A free variable cannot exist, and
 * every path is behaviourally testable with plain mocks.
 */

const fs = require('fs');
const path = require('path');

/**
 * Sign and submit a deletion attestation — the ONE way this codebase does it.
 *
 * Signs the JCS canonicalization of the payload: JSON, not a `J41-`-prefixed
 * protocol string, so it passes the broker's `assertNotProtocolMessage`
 * signing-oracle guard cleanly.
 *
 * The SIGTERM and timeout handlers used to call the older
 * `getDeletionAttestationMessage()` → `signMessage("J41-DELETE-…")` flow, which
 * the broker CORRECTLY refuses. Only the completion path had been migrated, so
 * every abnormally-terminated job silently produced no privacy proof. Do not
 * reintroduce that flow and do not weaken the guard — route new callers here.
 *
 * Writes the local artifact BEFORE submitting, so a submit failure still leaves
 * the signed proof on disk.
 *
 * @param {object}   o
 * @param {object}   o.client        SDK client (needs `submitAttestation`).
 * @param {object}   o.signer        Anything with `signMessage(msg)`.
 * @param {string}   o.jobId
 * @param {string}   o.containerId
 * @param {string}   o.jobDir        Directory the artifact is written to.
 * @param {string}   o.identityName  Becomes `attestedBy`.
 * @param {object|null} o.usageRecord Token usage, or null. EXPLICIT — never a free variable.
 * @param {string}   o.outFile
 * @param {object}   [o.extra]       Extra unsigned fields for the local artifact.
 * @param {Function} [o.sdk]         Injectable require, for tests.
 * @returns {Promise<{signed: boolean, submitted: boolean, error?: string}>}
 */
async function signAndSubmitDeletionAttestation({
  client, signer, jobId, containerId, jobDir, identityName,
  usageRecord = null, outFile, extra = {}, sdk,
}) {
  const { generateAttestationPayload, signAttestationWith } =
    sdk || require('@junction41/sovagent-sdk/dist/privacy/attestation.js');

  const now = new Date().toISOString();
  const payload = generateAttestationPayload({
    jobId,
    containerId,
    createdAt: now,
    destroyedAt: now,
    dataVolumes: [jobDir],
    attestedBy: identityName,
    // WP-D4 #6: usage is inside the SIGNED bytes (attestation schema v2).
    ...(usageRecord ? { tokenUsage: usageRecord } : {}),
  });

  const attestation = await signAttestationWith(payload, (msg) => signer.signMessage(msg));

  // The spread keeps the SIGNED, normalized tokenUsage from `attestation`
  // intact — do NOT overwrite it with usageRecord, or the file's signature would
  // no longer verify against its own tokenUsage. The richer unsigned detail is
  // filed separately under tokenUsageDetail for local audit only.
  fs.writeFileSync(
    path.join(jobDir, outFile),
    JSON.stringify({
      ...attestation,
      ...extra,
      ...(usageRecord ? { tokenUsageDetail: usageRecord } : {}),
    }, null, 2),
  );

  try {
    await client.submitAttestation(attestation);
    return { signed: true, submitted: true };
  } catch (e) {
    // Local artifact is already on disk — a submit failure must not lose it.
    return { signed: true, submitted: false, error: e && e.message };
  }
}

/**
 * Resolve this job's SovGuard canary id by matching the token.
 *
 * Deliberately does NOT trust the shape of the `registerCanary` response: it is
 * typed `{ status }` in the SDK, so reading `id`/`canaryId` off it is a guess,
 * and a wrong guess makes the whole release path a silent no-op. `getCanaries()`
 * is typed and returns records carrying `id` and `token`.
 *
 * @returns {Promise<string|null>}
 */
async function resolveCanaryId(client, token) {
  if (!client || !token || typeof client.getCanaries !== 'function') return null;
  try {
    const list = await client.getCanaries();
    const arr = Array.isArray(list) ? list : (list && list.canaries) || [];
    const hit = arr.find((c) => c && c.token === token);
    return (hit && (hit.id || hit.canaryId)) || null;
  } catch {
    return null;
  }
}

/**
 * Release this job's canary registration.
 *
 * Registrations are capped at 5 per agent and nothing ever released them, so
 * slots were consumed permanently — one agent still held a slot from
 * 2026-03-15, and every agent past its 5th job ever ran with SovGuard-side leak
 * detection silently off.
 *
 * Best-effort: never let cleanup affect the job. Call this AFTER the attestation
 * — the privacy proof is worth more than canary hygiene, and container kill
 * windows are as short as 5s.
 *
 * @returns {Promise<boolean>} true if a registration was deleted.
 */
async function releaseCanary({ client, token, canaryId = null }) {
  if (!client || typeof client.deleteCanary !== 'function') return false;
  try {
    const id = canaryId || await resolveCanaryId(client, token);
    if (!id) return false;
    await client.deleteCanary(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Age threshold for treating a canary registration as abandoned. Comfortably
 * longer than any possible job (default job timeout is 60 min), so a live
 * concurrent job's canary can never qualify.
 */
const STALE_CANARY_MS = 25 * 60 * 60 * 1000; // 25h

/**
 * Parse a canary `created_at`. The platform serves Postgres space-format
 * timestamps ("YYYY-MM-DD HH:MM:SS.mmm"), which `new Date()` parses as LOCAL
 * time. Normalise to UTC explicitly — guessing wrong here would either spare
 * every stale token or, far worse, age-out a live one.
 *
 * @returns {number|null} epoch ms, or null if unparseable.
 */
function parseCanaryTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;
  // Space-separated and no timezone marker → treat as UTC.
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Free ABANDONED canary slots so registration can succeed.
 *
 * Without this the fix cannot bootstrap: every existing agent is already at the
 * 5-token cap, so registration fails, no id is recorded, the release path
 * no-ops, and the slots are never freed — inert forever.
 *
 * ⚠️ SELECTION RULE IS AGE, NOT TOKEN IDENTITY. An earlier version deleted every
 * registration whose token was not the current job's, reasoning "one canary per
 * job, so the rest are finished". That is FALSE under concurrency: the cap is
 * per AGENT, and round 3 ran 10 concurrent jobs on one agent against a cap of 5.
 * Job 6 would have purged jobs 1-5's LIVE canaries, silently disabling
 * SovGuard-side leak detection on running jobs — strictly worse than the bug it
 * was fixing. Only delete registrations older than any job could possibly be.
 *
 * Residual, and correct: with more genuinely-concurrent jobs than the cap, the
 * later ones run unwatched. That is the platform cap doing its job; raising it
 * is a backend conversation, not something to work around here.
 *
 * A registration with an unparseable/absent timestamp is KEPT — never delete on
 * a guess.
 *
 * @returns {Promise<number>} how many abandoned registrations were deleted.
 */
async function purgeStaleCanaries({ client, keepToken, now = Date.now(), maxAgeMs = STALE_CANARY_MS }) {
  if (!client || typeof client.getCanaries !== 'function' || typeof client.deleteCanary !== 'function') return 0;
  let deleted = 0;
  try {
    const list = await client.getCanaries();
    const arr = Array.isArray(list) ? list : (list && list.canaries) || [];
    for (const c of arr) {
      if (!c || !c.id) continue;
      if (keepToken && c.token === keepToken) continue;      // never our own
      const created = parseCanaryTimestamp(c.created_at || c.createdAt);
      if (created === null) continue;                         // unknown age → keep
      if (now - created < maxAgeMs) continue;                 // could be a live job
      try { await client.deleteCanary(c.id); deleted++; } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  return deleted;
}

module.exports = {
  signAndSubmitDeletionAttestation,
  releaseCanary,
  resolveCanaryId,
  purgeStaleCanaries,
  parseCanaryTimestamp,
  STALE_CANARY_MS,
};
