'use strict';
/**
 * inbox-job-record — pure helpers for the Inbox `job_record` verify+accept gate.
 *
 * Integrity ②: before `acceptJobRecord` writes any VDXF data on-chain, we
 * must confirm that the bytes the platform placed in the inbox item are exactly
 * the cryptographically-verified platform-witnessed record.  Two checks:
 *
 *   A. `verifyWitness` + `decideWitnessWrite`  — is the witnessed record's
 *      signature valid? (same gate the broker executor already enforces for
 *      the completion path).
 *
 *   B. Cross-check (this is the crux) — does the inbox item's decoded
 *      `job.record` value equal `{ ...authRecord, witness: authWitness }`?
 *      If it differs, the platform tampered with the inbox after signing, and
 *      we refuse to write it.
 *
 * Pure functions only — no network calls, no file I/O, no side-effects.
 * The caller (cli.js checkPendingInbox) owns all async logic.
 */

const {
  VDXF_KEYS,
  DATA_DESCRIPTOR_KEY,
  jcsDatahash,
} = require('@junction41/sovagent-sdk/dist/index.js');

const {
  decideWitnessWrite,
} = require('./broker-executors.js');

/**
 * Decode the `job.record` value from an inbox item's `vdxfData`.
 *
 * The platform stores:
 *   vdxfData[VDXF_KEYS.job.record] = [ makeSubDD(iAddr, JSON.stringify({...record, witness})) ]
 *
 * Returns the parsed JS object `{ ...record, witness }`, or throws if the
 * key is absent / malformed.
 *
 * @param {Record<string, unknown> | null} vdxfData
 * @returns {{ [key: string]: unknown }}
 */
function decodeInboxJobRecord(vdxfData) {
  const jobRecordKey = VDXF_KEYS.job.record; // 'iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn'
  if (!vdxfData || !vdxfData[jobRecordKey]) {
    throw new Error(
      `inbox job_record: vdxfData is missing key ${jobRecordKey} (job.record) — cannot verify`,
    );
  }

  const raw = vdxfData[jobRecordKey];

  // Platform inbox format (confirmed live 2026-07-08): the job.record value is a
  // bare hex-encoded JSON string of `{ ...record, witness }`, served directly at
  // the key — NOT wrapped in the on-chain sub-DataDescriptor array. Decode it
  // directly. The on-chain contentmultimap representation (sub-DD array) is still
  // supported below. Either way, security is enforced downstream by
  // crossCheckInboxVsWitness against the independently-fetched platform witness,
  // so accepting this shape does not weaken the fail-closed gate.
  if (typeof raw === 'string') {
    let jsonStr;
    try {
      jsonStr = Buffer.from(raw, 'hex').toString('utf-8');
    } catch {
      throw new Error(`inbox job_record: vdxfData[${jobRecordKey}] is a string but not valid hex`);
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`inbox job_record: JSON.parse failed on hex-decoded job.record: ${e.message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`inbox job_record: hex-decoded job.record is not an object`);
    }
    return parsed;
  }

  const entries = raw;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `inbox job_record: vdxfData[${jobRecordKey}] is not a non-empty array`,
    );
  }

  // Fail-closed: platform must write exactly one entry (buildJobCompletionAdditions
  // creates a single-element array). If there were >1 entries, earlier ones would
  // pass through unverified — refuse.
  if (entries.length > 1) {
    throw new Error(
      `decodeInboxJobRecord: job.record has ${entries.length} entries; refusing (platform must write exactly one)`,
    );
  }

  const subDD = entries[0];
  if (typeof subDD !== 'object' || subDD === null) {
    throw new Error(`inbox job_record: sub-DD entry is not an object`);
  }

  const dd = subDD[DATA_DESCRIPTOR_KEY];
  if (typeof dd !== 'object' || dd === null) {
    throw new Error(`inbox job_record: sub-DD entry missing DataDescriptor key ${DATA_DESCRIPTOR_KEY}`);
  }

  const objectdata = dd.objectdata;

  let jsonStr;
  if (typeof objectdata === 'object' && objectdata !== null && typeof objectdata.message === 'string') {
    // Standard makeSubDD path: { message: "<json>" }
    jsonStr = objectdata.message;
  } else if (typeof objectdata === 'string') {
    // Hex-encoded fallback (legacy path).
    try {
      jsonStr = Buffer.from(objectdata, 'hex').toString('utf-8');
    } catch {
      throw new Error(`inbox job_record: objectdata is a string but not valid hex`);
    }
  } else {
    throw new Error(`inbox job_record: unexpected objectdata shape — cannot decode`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`inbox job_record: JSON.parse failed on decoded objectdata: ${e.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`inbox job_record: decoded objectdata is not an object`);
  }

  return parsed;
}

/**
 * Resolve the job's UUID from an inbox item detail.
 *
 * Primary: `inboxItemDetail.jobDetails.id` (the full job object embedded
 * in the detail response).
 * Fallback: not provided — throws, because without jobId we cannot call
 * `getJobWitness`.
 *
 * @param {{ jobDetails?: Record<string, unknown> | null }} inboxItemDetail
 * @returns {string}
 */
function resolveJobId(inboxItemDetail) {
  const id = inboxItemDetail?.jobDetails?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  throw new Error(
    `inbox job_record: cannot resolve jobId from inboxItemDetail.jobDetails.id — ` +
    `jobDetails=${JSON.stringify(inboxItemDetail?.jobDetails)}`,
  );
}

/**
 * Cross-check that the inbox item's decoded record equals the verified
 * witnessed record that `getJobWitness` returned.
 *
 * The inbox should contain exactly `{ ...authRecord, witness: authWitness }`.
 * We verify this by:
 *   1. Comparing the JCS-datahash of the bare record fields (inbox minus
 *      `witness`) with the JCS-datahash of `authRecord`.
 *   2. Comparing the witness object by JCS-datahash.
 *
 * Throws with a clear mismatch message if they differ.
 *
 * @param {Record<string, unknown>} inboxRecord   Decoded from inbox vdxfData.
 * @param {object} authRecord   From `getJobWitness`.
 * @param {object} authWitness  From `getJobWitness`.
 * @param {string} jobId        For error messages.
 */
function crossCheckInboxVsWitness(inboxRecord, authRecord, authWitness, jobId) {
  // Extract the bare record from inboxRecord (everything except `witness`).
  const { witness: inboxWitness, ...inboxBareRecord } = inboxRecord;

  const inboxBareHash = jcsDatahash(inboxBareRecord);
  const authBareHash = jcsDatahash(authRecord);

  if (inboxBareHash !== authBareHash) {
    throw new Error(
      `[Inbox] job_record cross-check FAILED for job ${jobId}: ` +
      `inbox bare-record hash ${inboxBareHash} ≠ auth-witness record hash ${authBareHash}. ` +
      `The inbox content does not match the verified witnessed record — refusing to write.`,
    );
  }

  const inboxWitnessHash = jcsDatahash(inboxWitness);
  const authWitnessHash = jcsDatahash(authWitness);

  if (inboxWitnessHash !== authWitnessHash) {
    throw new Error(
      `[Inbox] job_record cross-check FAILED for job ${jobId}: ` +
      `inbox witness hash ${inboxWitnessHash} ≠ auth-witness hash ${authWitnessHash}. ` +
      `The witness block in the inbox does not match the platform witness — refusing to write.`,
    );
  }
}

/**
 * Full fail-closed gate for a `job_record` inbox item.
 *
 * Combines verify + decideWitnessWrite + cross-check into a single call so the
 * caller (checkPendingInbox) stays readable.
 *
 * Returns `{ skip: true, reason }` for transient conditions (409 — job not yet
 * witnessable) so the caller can skip without throwing.
 *
 * Throws for hard failures (bad signature, mismatch, invalid network).  The
 * caller's per-item try/catch already isolates these.
 *
 * @param {{
 *   inboxItemDetail: object,
 *   getJobWitness: (jobId: string) => Promise<{ record: object, witness: object }>,
 *   verifyWitness: (record: object, witness: object, client: object, network: string) => Promise<{ verified: boolean, reason?: string }>,
 *   client: object,
 *   network: string,
 * }} opts
 * @returns {Promise<void | { skip: true, reason: string }>}
 */
async function verifyInboxJobRecord({
  inboxItemDetail,
  getJobWitness,
  verifyWitness,
  client,
  network,
}) {
  // ── Network validation (same fail-closed rule as broker-executors.js) ────────
  if (network !== 'verus' && network !== 'verustest') {
    throw new Error(
      `[Inbox] job_record: invalid/absent network '${network}' — refusing to accept`,
    );
  }

  // ── Decode the inbox vdxfData to get the object the platform intends to write ─
  const inboxRecord = decodeInboxJobRecord(inboxItemDetail.vdxfData);

  // ── Resolve jobId ────────────────────────────────────────────────────────────
  const jobId = resolveJobId(inboxItemDetail);

  // ── Fetch the authoritative platform witness ──────────────────────────────────
  let authRecord, authWitness;
  try {
    const result = await getJobWitness(jobId);
    authRecord = result.record;
    authWitness = result.witness;
  } catch (e) {
    // 409 = job not yet in `completed` state → transient, retry next poll.
    // Treat as transient ONLY when the HTTP status is 409 or the backend's
    // documented error code `NOT_WITNESSABLE` is present. Broad string patterns
    // (e.g. "not yet") are intentionally excluded to avoid masking real errors.
    if (e && (e.statusCode === 409 || (typeof e.message === 'string' && e.message.includes('NOT_WITNESSABLE')))) {
      return { skip: true, reason: `getJobWitness 409 (not yet witnessable): ${e.message}` };
    }
    throw e;
  }

  // ── Cryptographic verification ────────────────────────────────────────────────
  const v = await verifyWitness(authRecord, authWitness, client, network);

  // Fail-closed gate — throws on bad sig; warns for break-glass on verustest.
  decideWitnessWrite(v, { network, jobId });

  // ── Cross-check: inbox bytes must equal verified witness bytes ────────────────
  crossCheckInboxVsWitness(inboxRecord, authRecord, authWitness, jobId);
}

module.exports = {
  decodeInboxJobRecord,
  resolveJobId,
  crossCheckInboxVsWitness,
  verifyInboxJobRecord,
};
