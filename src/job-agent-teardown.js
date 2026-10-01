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
const { isValidJobId } = require('./job-id');

/** The parent writes this. randomBytes(32).hex. Anything else is not our token. */
const CANARY_TOKEN_RE = /^[0-9a-f]{64}$/;

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
  // Deliberately does NOT swallow errors. Doing so collapsed "the platform is
  // down" into "no registration found", so an outage read as a registration bug
  // — the exact misleading-diagnostic problem this module exists to remove.
  // Callers decide how to report a lookup failure.
  const list = await client.getCanaries();
  const arr = Array.isArray(list) ? list : (list && list.canaries) || [];
  const hit = arr.find((c) => c && c.token === token);
  return (hit && (hit.id || hit.canaryId)) || null;
}

/**
 * Release this job's canary registration.
 *
 * Registrations are capped at 32 per agent (CANARY_MAX_PER_AGENT). Nothing
 * released them, so slots were consumed permanently — one agent still held a
 * slot from 2026-03-15, and once the cap was full every later job ran with
 * SovGuard-side leak detection off. The parent dispatcher releases this job's
 * own token when the container exits. This in-container call still runs when
 * the process itself reaches teardown.
 *
 * Best-effort: never let cleanup affect the job. Call this AFTER the attestation
 * — the privacy proof is worth more than canary hygiene, and container kill
 * windows are as short as 5s.
 *
 * Returns a REASON, not just a boolean, so the caller can log every outcome. An
 * earlier version returned a bare boolean and logged nothing, which made the
 * release invisible in both directions — a cleanup step that can fail silently
 * is the exact pattern the rest of this work exists to remove. Verified live on
 * 2026-08-05: the release was unobservable in the job log.
 *
 * @returns {Promise<{released: boolean, reason: string}>}
 */
async function releaseCanary({ client, token, canaryId = null }) {
  if (!client || typeof client.deleteCanary !== 'function') {
    return { released: false, reason: 'no client' };
  }
  let id = canaryId;
  try {
    if (!id) id = await resolveCanaryId(client, token);
  } catch (e) {
    return { released: false, reason: `lookup failed: ${e && e.message}` };
  }
  if (!id) return { released: false, reason: 'no registration found for this token' };
  try {
    await client.deleteCanary(id);
    return { released: true, reason: `released ${id}` };
  } catch (e) {
    return { released: false, reason: `delete failed: ${e && e.message}` };
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
 * Without this the fix cannot bootstrap: an agent already at the 32-token cap
 * fails registration, no id is recorded, the release path no-ops, and the slots
 * are never freed — inert forever.
 *
 * ⚠️ SELECTION RULE IS AGE, NOT TOKEN IDENTITY. An earlier version deleted every
 * registration whose token was not the current job's, reasoning "one canary per
 * job, so the rest are finished". That is FALSE under concurrency: the cap is
 * per AGENT. Round 3 ran 10 concurrent jobs on one agent against a cap of 5.
 * The cap is 32 now. Age is still the only selection rule.
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

/**
 * Host-only copy of the token this dispatcher minted for one job.
 * The job directory is bind-mounted into the container, so the copy inside it
 * can be replaced. This file sits beside that directory and is not mounted.
 * A restart can still release the token after the in-memory handle is gone.
 */
function hostCanaryPath(jobsDir, jobId) {
  if (!isValidJobId(jobId)) {
    const err = new Error('invalid job id');
    err.code = 'CANARY_JOB_ID';
    throw err;
  }
  return path.join(jobsDir, '_canaries', jobId);
}

function writeHostCanary(jobsDir, jobId, token, fsImpl = fs) {
  if (!CANARY_TOKEN_RE.test(token)) {
    const err = new Error('invalid canary token');
    err.code = 'CANARY_TOKEN';
    throw err;
  }
  const file = hostCanaryPath(jobsDir, jobId);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fsImpl.openSync(
    file,
    fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_TRUNC | fsImpl.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fsImpl.writeFileSync(fd, token);
  } finally {
    fsImpl.closeSync(fd);
  }
  try { fsImpl.chmodSync(file, 0o600); } catch { /* umask already restricts it */ }
}

function readHostCanary(jobsDir, jobId, fsImpl = fs) {
  let file;
  try { file = hostCanaryPath(jobsDir, jobId); } catch { return null; }
  let fd;
  try {
    fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | fsImpl.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP') return null;
    throw e;
  }
  try {
    const text = fsImpl.readFileSync(fd, 'utf8').trim();
    return CANARY_TOKEN_RE.test(text) ? text : null;
  } finally {
    fsImpl.closeSync(fd);
  }
}

function removeHostCanary(jobsDir, jobId, fsImpl = fs) {
  let file;
  try { file = hostCanaryPath(jobsDir, jobId); } catch { return; }
  try { fsImpl.rmSync(file, { force: true }); } catch { /* best-effort */ }
}

/** A second delete, or a token that was never registered, means the slot is free. */
function parentReleaseSucceeded(result) {
  if (!result) return false;
  if (result.released) return true;
  if (result.reason === 'no registration found for this token') return true;
  return /^delete failed:/i.test(result.reason || '') && /not found|404/i.test(result.reason);
}

/**
 * Remember the token the new container will register.
 * If this host still has a different token from an earlier container for the
 * same job, release that one first. The new token is what we track either way:
 * the live container's token must not be forgotten because an old delete failed.
 */
async function claimHostCanary({ client, jobsDir, jobId, token, release = releaseCanary }) {
  const previous = readHostCanary(jobsDir, jobId);
  let prior = { released: true, reason: 'no previous host canary' };
  if (previous && previous !== token) {
    if (!client) prior = { released: false, reason: 'no client' };
    else prior = await release({ client, token: previous });
  }
  writeHostCanary(jobsDir, jobId, token);
  return { claimed: true, prior };
}

/**
 * Release the token this host minted, once the container is gone.
 * Deletes only registrations whose token equals that value. A different job's
 * token is never selected. A network failure keeps the host file so a later
 * stop can retry. Success, or "already gone", removes the host file.
 */
async function releaseParentJobCanary({ client, jobsDir, jobId, token = null, release = releaseCanary }) {
  const fromMemory = token && CANARY_TOKEN_RE.test(token) ? token : null;
  const fromFile = readHostCanary(jobsDir, jobId);
  const tokens = [];
  if (fromMemory) tokens.push(fromMemory);
  if (fromFile && fromFile !== fromMemory) tokens.push(fromFile);
  if (tokens.length === 0) return { released: false, reason: 'no host canary for this job' };

  let freed = false;
  let stuck = null;
  for (const tok of tokens) {
    const result = await release({ client, token: tok });
    if (parentReleaseSucceeded(result)) freed = true;
    else stuck = result && result.reason ? result.reason : 'not released';
  }
  if (!stuck) removeHostCanary(jobsDir, jobId);
  if (stuck) return { released: false, reason: stuck };
  return { released: freed, reason: freed ? 'released' : 'no host canary for this job' };
}

module.exports = {
  signAndSubmitDeletionAttestation,
  releaseCanary,
  resolveCanaryId,
  purgeStaleCanaries,
  parseCanaryTimestamp,
  STALE_CANARY_MS,
  CANARY_TOKEN_RE,
  hostCanaryPath,
  writeHostCanary,
  readHostCanary,
  removeHostCanary,
  claimHostCanary,
  releaseParentJobCanary,
  parentReleaseSucceeded,
};
