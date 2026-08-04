'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Structural cover for job-agent.js teardown behaviour.
 *
 * HONEST LIMITATION, stated up front: job-agent.js is a container entrypoint
 * script with no exports, so these are source-structure assertions, not
 * behavioural tests. They cannot prove the runtime behaviour — only round-4 live
 * testing can. What they CAN do is fail loudly if someone reintroduces a
 * regression that already cost us real incidents, which is exactly what happened
 * with each of the three below.
 *
 * They are deliberately written to be falsifiable: each one fails if the guarded
 * call disappears or the deprecated call returns. Verified by inverting each
 * assertion during authoring.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'job-agent.js'), 'utf8');

/** Source with comments stripped, so a mention in prose never satisfies a test. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
  .replace(/^\s*\/\/.*$/gm, '');        // line comments

test('deprecated getDeletionAttestationMessage flow is not CALLED anywhere', () => {
  // The broker correctly refuses to sign `J41-DELETE-…` (signing-oracle guard).
  // Both shutdown handlers used to call this, so every SIGTERM'd or timed-out
  // job silently produced no privacy proof. Mentions in comments are fine;
  // a call is not.
  assert.ok(
    !CODE.includes('getDeletionAttestationMessage'),
    'getDeletionAttestationMessage must not be called — use signAndSubmitDeletionAttestation()',
  );
  assert.ok(
    SRC.includes('getDeletionAttestationMessage'),
    'the explanatory comment should survive so nobody reintroduces the flow',
  );
});

test('all three teardown paths sign the attestation through the single helper', () => {
  const calls = CODE.match(/await signAndSubmitDeletionAttestation\(/g) || [];
  assert.strictEqual(calls.length, 3,
    `expected 3 call sites (completion, SIGTERM, timeout), found ${calls.length}`);
  assert.ok(CODE.includes("require('./job-agent-teardown.js')"),
    'teardown logic must live in the testable module, not inline');

  // Each path writes its own artifact so they can be told apart on disk.
  for (const f of ['deletion-attestation.json', 'deletion-attestation-sigterm.json', 'deletion-attestation-timeout.json']) {
    assert.ok(CODE.includes(f), `missing attestation artifact name: ${f}`);
  }
});

test('the canary is released on every teardown path, AFTER the attestation', () => {
  const calls = CODE.match(/await releaseCanary\(/g) || [];
  assert.strictEqual(calls.length, 3,
    `canary must be released on all 3 teardown paths, found ${calls.length}`);

  // Ordering matters: the SIGTERM grace period can be as short as 5s and
  // deleteCanary can hang for 30s. The privacy proof must not be sacrificed to
  // canary hygiene, so attest first and release last on every path.
  let from = 0;
  for (let i = 0; i < 3; i++) {
    const att = CODE.indexOf('await signAndSubmitDeletionAttestation(', from);
    const rel = CODE.indexOf('await releaseCanary(', from);
    assert.ok(att !== -1 && rel !== -1, 'both calls must be present on each path');
    assert.ok(att < rel, `path ${i + 1}: attestation must come BEFORE canary release`);
    from = rel + 1;
  }
});

test('the startup job fetch validates INSIDE the retry', () => {
  // The observed failure was a RESOLVED response with missing fields — no
  // throw — so validating after withRetry() returns would never retry it.
  const m = CODE.match(/withRetry\(async \(\) => \{[\s\S]*?\}, 'getJob'/);
  assert.ok(m, 'getJob must be retried with an async validating wrapper');
  assert.ok(/incomplete job data/.test(m[0]),
    'the incomplete-body check must be inside the retried function');
  assert.ok(
    !/const fullJob = await agent\.client\.getJob\(/.test(CODE),
    'the bare un-retried getJob must not come back',
  );
});

test('canary registration failure is reported as a security-posture warning', () => {
  // "non-fatal" is true for execution and misleading for security: it means this
  // job runs unwatched by SovGuard.
  assert.ok(
    /SovGuard-side leak detection is DISABLED/.test(CODE),
    'registration failure must say leak detection is disabled for the job',
  );
});
