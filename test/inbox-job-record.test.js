'use strict';
/**
 * Unit tests for the Inbox `job_record` verify+accept gate in
 * `src/inbox-job-record.js`.
 *
 * Tests the pure helpers (`decodeInboxJobRecord`, `resolveJobId`,
 * `crossCheckInboxVsWitness`) and the async coordinator (`verifyInboxJobRecord`)
 * in isolation — no real network, no real client.
 *
 * Test structure mirrors `test/witness-decide.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  decodeInboxJobRecord,
  resolveJobId,
  crossCheckInboxVsWitness,
  verifyInboxJobRecord,
} = require('../src/inbox-job-record.js');

const {
  VDXF_KEYS,
  DATA_DESCRIPTOR_KEY,
  jcsDatahash,
} = require('@junction41/sovagent-sdk/dist/index.js');

const JOB_RECORD_KEY = VDXF_KEYS.job.record; // 'iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn'
const JOB_ID = 'job-inbox-test-1234';

// ── Helper: build a valid vdxfData matching makeSubDD encoding ─────────────────

function makeSubDDEntry(iAddr, jsonStr) {
  return {
    [DATA_DESCRIPTOR_KEY]: {
      version: 1,
      flags: 96,
      mimetype: 'text/plain',
      objectdata: { message: jsonStr },
      label: iAddr,
    },
  };
}

/** Build vdxfData with a valid job.record sub-DD containing the given object. */
function makeVdxfData(recordObj) {
  return {
    [JOB_RECORD_KEY]: [makeSubDDEntry(JOB_RECORD_KEY, JSON.stringify(recordObj))],
  };
}

/**
 * Build vdxfData in the PLATFORM INBOX format (confirmed live 2026-07-08): the
 * job.record value is a bare hex-encoded JSON string of the record, served
 * directly at the key (NOT wrapped in a sub-DataDescriptor array).
 */
function makeHexVdxfData(recordObj) {
  return {
    [JOB_RECORD_KEY]: Buffer.from(JSON.stringify(recordObj), 'utf8').toString('hex'),
  };
}

test('decodeInboxJobRecord accepts the platform inbox format (bare hex string)', () => {
  const record = { ...SAMPLE_RECORD, witness: { schemaVersion: 1, signedByName: 'agentplatform@', signature: 'AgWzXhEA==' } };
  const decoded = decodeInboxJobRecord(makeHexVdxfData(record));
  assert.deepStrictEqual(decoded, record);
});

test('decodeInboxJobRecord rejects a non-hex / non-JSON string (fail-closed)', () => {
  assert.throws(() => decodeInboxJobRecord({ [JOB_RECORD_KEY]: 'not-hex-zz' }));
});

const SAMPLE_RECORD = {
  amount: 5,
  buyerVerusId: 'buyer.agentplatform@',
  completedAt: '2026-06-20T10:00:00Z',
  currency: 'VRSCTEST',
  jobHash: 'a'.repeat(64),
  schemaVersion: 1,
  sellerVerusId: 'seller.agentplatform@',
  serviceId: null,
  status: 'completed',
};

const SAMPLE_WITNESS = {
  schemaVersion: 1,
  signedBy: 'iAgentPlatformAddress',
  signedByName: 'agentplatform@',
  signature: 'AgFakeBase64Signature==',
  signatureHeight: 12345,
  algorithm: 'VerusID_CIdentitySignature_v2',
};

const SAMPLE_INBOX_RECORD = { ...SAMPLE_RECORD, witness: SAMPLE_WITNESS };

// ── decodeInboxJobRecord ───────────────────────────────────────────────────────

test('decodeInboxJobRecord: successfully decodes well-formed vdxfData', () => {
  const vdxfData = makeVdxfData(SAMPLE_INBOX_RECORD);
  const result = decodeInboxJobRecord(vdxfData);
  assert.deepStrictEqual(result, SAMPLE_INBOX_RECORD);
});

test('decodeInboxJobRecord: throws when vdxfData is null', () => {
  assert.throws(
    () => decodeInboxJobRecord(null),
    (e) => /missing key/.test(e.message) && e.message.includes(JOB_RECORD_KEY),
  );
});

test('decodeInboxJobRecord: throws when job.record key is absent', () => {
  assert.throws(
    () => decodeInboxJobRecord({ 'iSomeOtherKey': [] }),
    (e) => /missing key/.test(e.message),
  );
});

test('decodeInboxJobRecord: throws when the array is empty', () => {
  assert.throws(
    () => decodeInboxJobRecord({ [JOB_RECORD_KEY]: [] }),
    (e) => /non-empty array/.test(e.message),
  );
});

test('decodeInboxJobRecord: throws when objectdata.message is invalid JSON', () => {
  const bad = {
    [JOB_RECORD_KEY]: [makeSubDDEntry(JOB_RECORD_KEY, 'not-json{')],
  };
  assert.throws(
    () => decodeInboxJobRecord(bad),
    (e) => /JSON.parse failed/.test(e.message),
  );
});

test('decodeInboxJobRecord: throws when DataDescriptor key is missing from entry', () => {
  assert.throws(
    () => decodeInboxJobRecord({ [JOB_RECORD_KEY]: [{ wrongKey: {} }] }),
    (e) => /DataDescriptor key/.test(e.message) || /missing DataDescriptor/.test(e.message) ||
           /sub-DD entry missing/.test(e.message),
  );
});

test('decodeInboxJobRecord: throws when job.record has more than one entry (fail-closed)', () => {
  // Platform must write exactly one entry; >1 means earlier entries pass through
  // unverified, so we refuse rather than silently taking the last.
  const first = { ...SAMPLE_INBOX_RECORD, amount: 1 };
  const second = { ...SAMPLE_INBOX_RECORD, amount: 99 };
  const vdxfData = {
    [JOB_RECORD_KEY]: [
      makeSubDDEntry(JOB_RECORD_KEY, JSON.stringify(first)),
      makeSubDDEntry(JOB_RECORD_KEY, JSON.stringify(second)),
    ],
  };
  assert.throws(
    () => decodeInboxJobRecord(vdxfData),
    (e) =>
      /refusing \(platform must write exactly one\)/.test(e.message) &&
      e.message.includes('2 entries'),
  );
});

// ── resolveJobId ──────────────────────────────────────────────────────────────

test('resolveJobId: returns jobDetails.id when present', () => {
  const detail = { jobDetails: { id: JOB_ID, jobHash: 'abc' } };
  assert.strictEqual(resolveJobId(detail), JOB_ID);
});

test('resolveJobId: throws when jobDetails is null', () => {
  assert.throws(
    () => resolveJobId({ jobDetails: null }),
    (e) => /cannot resolve jobId/.test(e.message),
  );
});

test('resolveJobId: throws when jobDetails.id is absent', () => {
  assert.throws(
    () => resolveJobId({ jobDetails: { jobHash: 'abc' } }),
    (e) => /cannot resolve jobId/.test(e.message),
  );
});

test('resolveJobId: throws when jobDetails.id is an empty string', () => {
  assert.throws(
    () => resolveJobId({ jobDetails: { id: '' } }),
    (e) => /cannot resolve jobId/.test(e.message),
  );
});

test('resolveJobId: throws when inboxItemDetail itself is null', () => {
  assert.throws(
    () => resolveJobId(null),
    (e) => /cannot resolve jobId/.test(e.message),
  );
});

// ── crossCheckInboxVsWitness ──────────────────────────────────────────────────

test('crossCheckInboxVsWitness: matching records — does not throw', () => {
  assert.doesNotThrow(() =>
    crossCheckInboxVsWitness(SAMPLE_INBOX_RECORD, SAMPLE_RECORD, SAMPLE_WITNESS, JOB_ID),
  );
});

test('crossCheckInboxVsWitness: tampered bare record — throws with mismatch message', () => {
  const tamperedInboxRecord = { ...SAMPLE_INBOX_RECORD, amount: 999 };
  assert.throws(
    () => crossCheckInboxVsWitness(tamperedInboxRecord, SAMPLE_RECORD, SAMPLE_WITNESS, JOB_ID),
    (e) =>
      /cross-check FAILED/.test(e.message) &&
      /bare-record hash/.test(e.message) &&
      e.message.includes(JOB_ID),
  );
});

test('crossCheckInboxVsWitness: tampered witness — throws with mismatch message', () => {
  const tamperedWitness = { ...SAMPLE_WITNESS, signatureHeight: 99999 };
  const inboxWithTamperedWitness = { ...SAMPLE_RECORD, witness: tamperedWitness };
  assert.throws(
    () => crossCheckInboxVsWitness(inboxWithTamperedWitness, SAMPLE_RECORD, SAMPLE_WITNESS, JOB_ID),
    (e) =>
      /cross-check FAILED/.test(e.message) &&
      /witness hash/.test(e.message) &&
      e.message.includes(JOB_ID),
  );
});

test('crossCheckInboxVsWitness: extra field on inbox bare record — throws (hash differs)', () => {
  // A field not present in authRecord but in the inbox bare record → hashes differ
  const inboxWithExtra = { ...SAMPLE_RECORD, extraMaliciousField: 'injected', witness: SAMPLE_WITNESS };
  assert.throws(
    () => crossCheckInboxVsWitness(inboxWithExtra, SAMPLE_RECORD, SAMPLE_WITNESS, JOB_ID),
    (e) => /cross-check FAILED/.test(e.message) && /bare-record hash/.test(e.message),
  );
});

// ── verifyInboxJobRecord (async coordinator) ──────────────────────────────────

/**
 * Builds a fake context for verifyInboxJobRecord.
 * Override any option to inject failures.
 */
function makeCtx({
  inboxRecord = SAMPLE_INBOX_RECORD,
  authRecord = SAMPLE_RECORD,
  authWitness = SAMPLE_WITNESS,
  verifyResult = { verified: true },
  network = 'verustest',
  getJobWitnessError = null,
} = {}) {
  const inboxItemDetail = {
    id: 'inbox-item-1',
    jobDetails: { id: JOB_ID },
    vdxfData: makeVdxfData(inboxRecord),
  };
  const getJobWitness = async (jobId) => {
    if (getJobWitnessError) throw getJobWitnessError;
    return { record: authRecord, witness: authWitness };
  };
  const verifyWitness = async () => verifyResult;
  const client = {}; // not used by the pure helpers; verifyWitness is injected
  return { inboxItemDetail, getJobWitness, verifyWitness, client, network };
}

test('verifyInboxJobRecord: all-green path — resolves without return value', async () => {
  const ctx = makeCtx();
  const result = await verifyInboxJobRecord(ctx);
  // Should return undefined (no skip) when everything is fine.
  assert.ok(result === undefined || result === null);
});

test('verifyInboxJobRecord: 409 from getJobWitness — returns skip=true (transient)', async () => {
  const err = Object.assign(new Error('Job not yet completed'), { statusCode: 409 });
  const ctx = makeCtx({ getJobWitnessError: err });
  const result = await verifyInboxJobRecord(ctx);
  assert.ok(result && result.skip === true, 'must return skip:true for 409');
  assert.ok(typeof result.reason === 'string', 'must include a reason');
});

test('verifyInboxJobRecord: non-409 error from getJobWitness — propagates as throw', async () => {
  const err = new Error('Network timeout');
  const ctx = makeCtx({ getJobWitnessError: err });
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => e.message === 'Network timeout',
  );
});

test('verifyInboxJobRecord: generic "not yet synced" error (no statusCode 409, no NOT_WITNESSABLE) — propagates, not skip', async () => {
  // "not yet" wording must NOT be treated as transient — only statusCode===409
  // or explicit NOT_WITNESSABLE qualify. A broad regex would mask real errors.
  const err = new Error('indexer not yet synced');
  const ctx = makeCtx({ getJobWitnessError: err });
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => e.message === 'indexer not yet synced',
  );
});

test('verifyInboxJobRecord: invalid network — throws fail-closed', async () => {
  const ctx = makeCtx({ network: 'unknown' });
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => /invalid\/absent network/.test(e.message),
  );
});

test('verifyInboxJobRecord: undefined network — throws fail-closed', async () => {
  // Build manually — makeCtx defaults network='verustest', so we must override directly.
  const ctx = makeCtx();
  ctx.network = undefined;
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => /invalid\/absent network/.test(e.message),
  );
});

test('verifyInboxJobRecord: verified=false, mainnet — throws fail-closed', async () => {
  const ctx = makeCtx({ verifyResult: { verified: false, reason: 'bad_sig' }, network: 'verus' });
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => /witness verification failed/.test(e.message),
  );
});

test('verifyInboxJobRecord: verified=false, verustest, no env — throws fail-closed', async () => {
  const prev = process.env.J41_WITNESS_VERIFY;
  delete process.env.J41_WITNESS_VERIFY;
  try {
    const ctx = makeCtx({ verifyResult: { verified: false, reason: 'bad_sig' }, network: 'verustest' });
    await assert.rejects(
      () => verifyInboxJobRecord(ctx),
      (e) => /witness verification failed/.test(e.message),
    );
  } finally {
    if (prev === undefined) delete process.env.J41_WITNESS_VERIFY;
    else process.env.J41_WITNESS_VERIFY = prev;
  }
});

test('verifyInboxJobRecord: verified=false, verustest, J41_WITNESS_VERIFY=off — warns, proceeds (cross-check passes)', async () => {
  const prev = process.env.J41_WITNESS_VERIFY;
  process.env.J41_WITNESS_VERIFY = 'off';
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // Verify=false but break-glass is on, and inbox bytes match auth bytes → should pass
    const ctx = makeCtx({ verifyResult: { verified: false, reason: 'bad_sig' }, network: 'verustest' });
    const result = await verifyInboxJobRecord(ctx);
    assert.ok(result === undefined || result === null, 'should pass (no skip)');
    assert.ok(warnings.some((w) => w.includes('J41_WITNESS_VERIFY=off')), 'must emit warning');
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.J41_WITNESS_VERIFY;
    else process.env.J41_WITNESS_VERIFY = prev;
  }
});

test('verifyInboxJobRecord: inbox record tampered (cross-check fails) — throws even when verify=true', async () => {
  const tamperedInboxRecord = { ...SAMPLE_RECORD, amount: 999, witness: SAMPLE_WITNESS };
  const ctx = makeCtx({ inboxRecord: tamperedInboxRecord }); // verify=true, but inbox != auth
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => /cross-check FAILED/.test(e.message) && /bare-record hash/.test(e.message),
  );
});

test('verifyInboxJobRecord: witness tampered in inbox (cross-check) — throws even when verify=true', async () => {
  const tamperedWitness = { ...SAMPLE_WITNESS, signatureHeight: 99999 };
  const tamperedInboxRecord = { ...SAMPLE_RECORD, witness: tamperedWitness };
  const ctx = makeCtx({ inboxRecord: tamperedInboxRecord });
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => /cross-check FAILED/.test(e.message) && /witness hash/.test(e.message),
  );
});

test('verifyInboxJobRecord: missing jobDetails — throws fail-closed', async () => {
  const ctx = makeCtx();
  ctx.inboxItemDetail.jobDetails = null;
  await assert.rejects(
    () => verifyInboxJobRecord(ctx),
    (e) => /cannot resolve jobId/.test(e.message),
  );
});

test('verifyInboxJobRecord: mainnet, verified=true, cross-check passes — succeeds', async () => {
  const ctx = makeCtx({ network: 'verus' });
  const result = await verifyInboxJobRecord(ctx);
  assert.ok(result === undefined || result === null);
});
