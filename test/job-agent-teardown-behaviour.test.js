'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  signAndSubmitDeletionAttestation,
  releaseCanary,
  resolveCanaryId,
  purgeStaleCanaries,
  parseCanaryTimestamp,
} = require('../src/job-agent-teardown.js');

/**
 * BEHAVIOURAL cover for job-container teardown.
 *
 * These exist because the previous attempt was structural (regex over source)
 * and passed 5/5 against a helper that threw `ReferenceError` on EVERY
 * invocation — it read `_usageRecord`, a const scoped inside another function.
 * Regex cannot see scope. These call the real code.
 */

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-teardown-'));
}

/** Minimal stand-ins for the SDK attestation primitives. */
const fakeSdk = {
  generateAttestationPayload: (p) => ({ ...p, schemaVersion: 2 }),
  signAttestationWith: async (payload, sign) => ({
    ...payload,
    signature: await sign('canonical-json-bytes'),
  }),
};

const signer = { signMessage: async () => 'SIGNATURE' };

test('attestation: signs, writes the artifact, and submits', async () => {
  const dir = tmpdir();
  const submitted = [];
  const res = await signAndSubmitDeletionAttestation({
    client: { submitAttestation: async (a) => { submitted.push(a); return { id: 'x' }; } },
    signer, jobId: 'job-1', containerId: 'c1', jobDir: dir,
    identityName: 'a.agentplatform@', usageRecord: null,
    outFile: 'deletion-attestation.json', sdk: fakeSdk,
  });

  assert.deepStrictEqual(res, { signed: true, submitted: true });
  assert.strictEqual(submitted.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'deletion-attestation.json'), 'utf8'));
  assert.strictEqual(written.jobId, 'job-1');
  assert.strictEqual(written.signature, 'SIGNATURE');
  assert.strictEqual(written.attestedBy, 'a.agentplatform@');
});

test('attestation: a submit failure still leaves the signed artifact on disk', async () => {
  const dir = tmpdir();
  const res = await signAndSubmitDeletionAttestation({
    client: { submitAttestation: async () => { throw new Error('platform down'); } },
    signer, jobId: 'job-2', containerId: 'c1', jobDir: dir,
    identityName: 'a@', usageRecord: null,
    outFile: 'deletion-attestation-sigterm.json', sdk: fakeSdk,
  });
  assert.strictEqual(res.signed, true);
  assert.strictEqual(res.submitted, false);
  assert.match(res.error, /platform down/);
  assert.ok(fs.existsSync(path.join(dir, 'deletion-attestation-sigterm.json')),
    'the proof must survive a submit failure — that is why it is written first');
});

test('attestation: usageRecord is SIGNED, and the unsigned detail is filed separately', async () => {
  const dir = tmpdir();
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, model: 'x', amountUsd: 0.01 };
  await signAndSubmitDeletionAttestation({
    client: { submitAttestation: async () => ({}) },
    signer, jobId: 'job-3', containerId: 'c1', jobDir: dir,
    identityName: 'a@', usageRecord: usage,
    outFile: 'a.json', sdk: fakeSdk,
  });
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  // Inside the signed payload...
  assert.deepStrictEqual(w.tokenUsage, usage);
  // ...and mirrored unsigned for local audit. Overwriting the signed copy would
  // break the file's signature against its own contents.
  assert.deepStrictEqual(w.tokenUsageDetail, usage);
});

test('attestation: works with NO usage record (the shutdown paths pass null)', async () => {
  const dir = tmpdir();
  const res = await signAndSubmitDeletionAttestation({
    client: { submitAttestation: async () => ({}) },
    signer, jobId: 'job-4', containerId: 'c1', jobDir: dir,
    identityName: 'a@', usageRecord: null, outFile: 'b.json', sdk: fakeSdk,
  });
  assert.strictEqual(res.signed, true);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'));
  assert.ok(!('tokenUsage' in w));
  assert.ok(!('tokenUsageDetail' in w));
});

test('canary: id is resolved by TOKEN match, not from the register response', async () => {
  // registerCanary is typed `{ status }`; reading id/canaryId off it is a guess,
  // and a wrong guess makes release a permanent silent no-op.
  const client = {
    getCanaries: async () => ([
      { id: 'other', token: 'not-ours' },
      { id: 'mine', token: 'our-token' },
    ]),
  };
  assert.strictEqual(await resolveCanaryId(client, 'our-token'), 'mine');
  assert.strictEqual(await resolveCanaryId(client, 'absent'), null);
});

test('canary: release deletes the matching registration', async () => {
  const deleted = [];
  const client = {
    getCanaries: async () => ([{ id: 'mine', token: 'tok' }]),
    deleteCanary: async (id) => { deleted.push(id); },
  };
  const r = await releaseCanary({ client, token: 'tok' });
  assert.strictEqual(r.released, true);
  assert.match(r.reason, /released mine/);
  assert.deepStrictEqual(deleted, ['mine']);
});

test('canary: release is best-effort — a failure never throws', async () => {
  const client = {
    getCanaries: async () => { throw new Error('boom'); },
    deleteCanary: async () => { throw new Error('boom'); },
  };
  // Every outcome must carry a REASON — a cleanup step that fails silently is
  // exactly what this whole change set exists to remove.
  // A platform outage must NOT read as "no registration found" — collapsing
  // those two was the whole misleading-diagnostic problem. resolveCanaryId
  // therefore propagates instead of swallowing. Asserting only that SOME reason
  // exists is what let that dead branch hide.
  const failed = await releaseCanary({ client, token: 'tok' });
  assert.strictEqual(failed.released, false);
  assert.match(failed.reason, /lookup failed: boom/,
    'an API failure must be reported as a lookup failure, not as a missing registration');

  const noClient = await releaseCanary({ client: null, token: 'tok' });
  assert.strictEqual(noClient.released, false);
  assert.match(noClient.reason, /no client/);

  const noMethod = await releaseCanary({ client: {}, token: 'tok' });
  assert.strictEqual(noMethod.released, false);
  assert.match(noMethod.reason, /no client/);

  // Registration never succeeded => nothing to release, and it must SAY so.
  const none = await releaseCanary({ client: { getCanaries: async () => [], deleteCanary: async () => {} }, token: 'tok' });
  assert.strictEqual(none.released, false);
  assert.match(none.reason, /no registration found/);

  // Delete itself failing must be distinguishable from not finding one.
  const delFail = await releaseCanary({
    client: { getCanaries: async () => ([{ id: 'x', token: 'tok' }]), deleteCanary: async () => { throw new Error('nope'); } },
    token: 'tok',
  });
  assert.strictEqual(delFail.released, false);
  assert.match(delFail.reason, /delete failed: nope/);
});

test('canary: purge deletes only ABANDONED slots, never a concurrent live job\'s', async () => {
  // The cap is per AGENT and round 3 ran 10 concurrent jobs on one agent against
  // a cap of 5. An earlier rule ("delete any token that isn't mine") would have
  // had job 6 purge jobs 1-5's LIVE canaries and silently disabled leak
  // detection on running jobs — worse than the bug. Selection is by AGE.
  const now = Date.parse('2026-08-04T12:00:00Z');
  const deleted = [];
  const client = {
    getCanaries: async () => ([
      { id: 'ancient',   token: 't-old',   created_at: '2026-03-15 05:15:39' },
      { id: 'live-a',    token: 't-a',     created_at: '2026-08-04 11:58:00' },
      { id: 'live-b',    token: 't-b',     created_at: '2026-08-04 11:30:00' },
      { id: 'mine',      token: 'current', created_at: '2026-08-04 11:59:59' },
      { id: 'yesterday', token: 't-y',     created_at: '2026-08-02 09:00:00' },
    ]),
    deleteCanary: async (id) => { deleted.push(id); },
  };
  const n = await purgeStaleCanaries({ client, keepToken: 'current', now });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(deleted.sort(), ['ancient', 'yesterday']);
  assert.ok(!deleted.includes('live-a'), 'must not delete a 2-minute-old concurrent canary');
  assert.ok(!deleted.includes('live-b'), 'must not delete a 30-minute-old concurrent canary');
  assert.ok(!deleted.includes('mine'), 'must never delete the live job own canary');
});

test('canary: purge KEEPS a registration whose age cannot be determined', async () => {
  const deleted = [];
  const client = {
    getCanaries: async () => ([
      { id: 'no-ts', token: 't1' },
      { id: 'bad-ts', token: 't2', created_at: 'not-a-date' },
    ]),
    deleteCanary: async (id) => { deleted.push(id); },
  };
  assert.strictEqual(await purgeStaleCanaries({ client, keepToken: 'x' }), 0);
  assert.deepStrictEqual(deleted, [], 'never delete on a guess');
});

test('canary: Postgres space-format timestamps are read as UTC, not local', async () => {
  const t = parseCanaryTimestamp('2026-08-04 11:00:00.123');
  assert.strictEqual(t, Date.parse('2026-08-04T11:00:00.123Z'));
  assert.strictEqual(parseCanaryTimestamp('2026-08-04T11:00:00Z'), Date.parse('2026-08-04T11:00:00Z'));
  assert.strictEqual(parseCanaryTimestamp('garbage'), null);
  assert.strictEqual(parseCanaryTimestamp(null), null);
});

test('canary: purge tolerates individual delete failures', async () => {
  const client = {
    getCanaries: async () => ([
      { id: 'a', token: 't1', created_at: '2026-01-01 00:00:00' },
      { id: 'b', token: 't2', created_at: '2026-01-01 00:00:00' },
    ]),
    deleteCanary: async (id) => { if (id === 'a') throw new Error('nope'); },
  };
  assert.strictEqual(await purgeStaleCanaries({ client, keepToken: 'x' }), 1);
});

// ---------------------------------------------------------------------------
// Against the REAL SDK attestation primitives.
//
// The mocks above are convenient but they hide the exact bug this change exists
// to fix: `fakeSdk` hands the signer a placeholder string, so nothing proves we
// sign JCS-canonical JSON rather than a `J41-…` protocol message — which the
// broker refuses, and which silently killed every abnormal-termination
// attestation. The real module is pure and offline, so use it.
// ---------------------------------------------------------------------------

test('REAL SDK: the signed bytes are JCS JSON, never a J41- protocol message', async () => {
  const dir = tmpdir();
  const seen = [];
  const strictSigner = {
    signMessage: async (msg) => {
      seen.push(msg);
      // This is precisely what sign-broker.js does via assertNotProtocolMessage.
      if (/^\s*j41-[a-z0-9-]*\|/i.test(String(msg))) {
        throw new Error('Refusing to sign a J41-protocol-formatted challenge');
      }
      return 'SIG';
    },
  };

  const res = await signAndSubmitDeletionAttestation({
    client: { submitAttestation: async () => ({ id: 'ok' }) },
    signer: strictSigner,
    jobId: 'job-real', containerId: 'c-real', jobDir: dir,
    identityName: 'a.agentplatform@',
    usageRecord: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    outFile: 'real.json',
    // no `sdk` → the real @junction41/sovagent-sdk attestation module
  });

  assert.strictEqual(res.signed, true, 'the broker-style guard must not reject our bytes');
  assert.strictEqual(res.submitted, true);
  assert.strictEqual(seen.length, 1);
  assert.ok(!/^j41-/i.test(seen[0]), 'signed bytes must not be a J41-prefixed protocol string');
  assert.doesNotThrow(() => JSON.parse(seen[0]), 'signed bytes must be JSON (JCS canonical)');
});

test('REAL SDK: tokenUsage in the artifact is the NORMALIZED signed form', async () => {
  // The mocked test asserts the raw record survives verbatim. It does not: the
  // real generateAttestationPayload normalizes it. Overwriting the signed copy
  // with the raw one would break the file's signature against its own contents,
  // which is why the richer detail is filed separately as tokenUsageDetail.
  const dir = tmpdir();
  const raw = {
    promptTokens: 10, completionTokens: 5, totalTokens: 15,
    model: 'gpt-oss-120b', amountUsd: 0.01,
  };
  await signAndSubmitDeletionAttestation({
    client: { submitAttestation: async () => ({}) },
    signer: { signMessage: async () => 'SIG' },
    jobId: 'job-norm', containerId: 'c1', jobDir: dir,
    identityName: 'a@', usageRecord: raw, outFile: 'norm.json',
  });
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'norm.json'), 'utf8'));
  assert.ok(w.tokenUsage, 'signed tokenUsage must be present');
  assert.strictEqual(w.tokenUsage.totalTokens, 15, 'core counts survive normalization');
  // The unsigned sidecar keeps everything the normalizer drops.
  assert.strictEqual(w.tokenUsageDetail.model, 'gpt-oss-120b');
  assert.strictEqual(w.tokenUsageDetail.amountUsd, 0.01);
});
