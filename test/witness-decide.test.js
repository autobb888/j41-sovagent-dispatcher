'use strict';
/**
 * Unit tests for `decideWitnessWrite` — the fail-closed gate that decides
 * whether to proceed with writing the platform-witnessed record.job on-chain.
 *
 * Isolated from network, client, and SDK by testing the exported helper
 * directly. The full executor path is exercised by sign-channel.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { decideWitnessWrite } = require('../src/broker-executors.js');

const JOB_ID = 'job-test-1234';

// ── verified=true ─────────────────────────────────────────────────────────────

test('decideWitnessWrite: verified=true on testnet — proceeds (no throw)', () => {
  assert.doesNotThrow(() =>
    decideWitnessWrite({ verified: true }, { network: 'verustest', jobId: JOB_ID }),
  );
});

test('decideWitnessWrite: verified=true on mainnet — proceeds (no throw)', () => {
  assert.doesNotThrow(() =>
    decideWitnessWrite({ verified: true }, { network: 'verus', jobId: JOB_ID }),
  );
});

// ── verified=false, mainnet — ALWAYS fail-closed ──────────────────────────────

test('decideWitnessWrite: verified=false on mainnet — throws even with J41_WITNESS_VERIFY=off', () => {
  const prev = process.env.J41_WITNESS_VERIFY;
  process.env.J41_WITNESS_VERIFY = 'off';
  try {
    assert.throws(
      () => decideWitnessWrite({ verified: false, reason: 'bad_sig' }, { network: 'verus', jobId: JOB_ID }),
      (e) => /witness verification failed/.test(e.message) && e.message.includes(JOB_ID),
    );
  } finally {
    if (prev === undefined) delete process.env.J41_WITNESS_VERIFY;
    else process.env.J41_WITNESS_VERIFY = prev;
  }
});

test('decideWitnessWrite: verified=false on mainnet without env — throws', () => {
  const prev = process.env.J41_WITNESS_VERIFY;
  delete process.env.J41_WITNESS_VERIFY;
  try {
    assert.throws(
      () => decideWitnessWrite({ verified: false, reason: 'unsupported_algorithm' }, { network: 'verus', jobId: JOB_ID }),
      (e) => /witness verification failed/.test(e.message) && /unsupported_algorithm/.test(e.message),
    );
  } finally {
    if (prev === undefined) delete process.env.J41_WITNESS_VERIFY;
    else process.env.J41_WITNESS_VERIFY = prev;
  }
});

// ── verified=false, testnet, no env — fail-closed ────────────────────────────

test('decideWitnessWrite: verified=false on testnet without J41_WITNESS_VERIFY — throws', () => {
  const prev = process.env.J41_WITNESS_VERIFY;
  delete process.env.J41_WITNESS_VERIFY;
  try {
    assert.throws(
      () => decideWitnessWrite({ verified: false, reason: 'no_match' }, { network: 'verustest', jobId: JOB_ID }),
      (e) => /witness verification failed/.test(e.message) && e.message.includes(JOB_ID),
    );
  } finally {
    if (prev === undefined) delete process.env.J41_WITNESS_VERIFY;
    else process.env.J41_WITNESS_VERIFY = prev;
  }
});

// ── break-glass: J41_WITNESS_VERIFY=off on testnet only ─────────────────────

test('decideWitnessWrite: verified=false on testnet with J41_WITNESS_VERIFY=off — warns but does not throw', () => {
  const prev = process.env.J41_WITNESS_VERIFY;
  process.env.J41_WITNESS_VERIFY = 'off';
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.doesNotThrow(() =>
      decideWitnessWrite({ verified: false, reason: 'no_match' }, { network: 'verustest', jobId: JOB_ID }),
    );
    assert.ok(warnings.some((w) => w.includes('J41_WITNESS_VERIFY=off')), 'must emit a warning');
    assert.ok(warnings.some((w) => w.includes(JOB_ID)), 'warning must include jobId');
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.J41_WITNESS_VERIFY;
    else process.env.J41_WITNESS_VERIFY = prev;
  }
});
