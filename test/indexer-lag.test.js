'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isIndexerLagError,
  retryRegisterWithJ41,
  INDEXER_LAG_HINT,
  planOnboardingAfterProfile,
} = require('../src/indexer-lag');

test('isIndexerLagError: Invalid request format and 400/409 indexed codes', () => {
  assert.equal(isIndexerLagError(new Error('Invalid request format')), true);
  assert.equal(isIndexerLagError(Object.assign(new Error('bad json'), { status: 400 })), false);
  assert.equal(isIndexerLagError(Object.assign(new Error('Invalid request format'), { status: 400 })), true);
  assert.equal(isIndexerLagError(Object.assign(new Error('not indexed yet'), { status: 409 })), true);
  assert.equal(isIndexerLagError(Object.assign(new Error('IDENTITY_NOT_INDEXED'), { statusCode: 409 })), true);
  assert.equal(isIndexerLagError(new Error('network down')), false);
  assert.equal(isIndexerLagError(null), false);
});

test('retryRegisterWithJ41 retries indexer lag 3 times then returns lag flag', async () => {
  let n = 0;
  const sleeps = [];
  const out = await retryRegisterWithJ41(async () => {
    n += 1;
    throw Object.assign(new Error('Invalid request format'), { status: 400 });
  }, { attempts: 3, delayMs: 5000, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(out.ok, false);
  assert.equal(out.indexerLag, true);
  assert.equal(out.attempts, 3);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.match(INDEXER_LAG_HINT, /indexer has not caught the new identity/i);
  assert.match(INDEXER_LAG_HINT, /finalize/);
});

test('retryRegisterWithJ41 succeeds on later attempt and does not retry other errors', async () => {
  let n = 0;
  const ok = await retryRegisterWithJ41(async () => {
    n += 1;
    if (n < 2) throw new Error('Invalid request format');
    return { agentId: 'a1' };
  }, { attempts: 3, delayMs: 1, sleep: async () => {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.agentId, 'a1');
  assert.equal(ok.attempts, 2);

  let hardN = 0;
  const hard = await retryRegisterWithJ41(async () => {
    hardN += 1;
    throw new Error('WIF missing');
  }, { attempts: 3, delayMs: 1, sleep: async () => {} });
  assert.equal(hard.ok, false);
  assert.equal(hard.indexerLag, false);
  assert.equal(hardN, 1);
  assert.match(hard.error.message, /WIF missing/);
});

test('isIndexerLagError: 401 SIGNATURE_INVALID is not lag; UTXO skip is not lag', () => {
  assert.equal(isIndexerLagError(Object.assign(new Error('bad sig'), { status: 401, code: 'SIGNATURE_INVALID' })), false);
  assert.equal(isIndexerLagError(new Error('VDXF publish skipped: Rxxx has no spendable UTXOs for the transaction fee.')), false);
  assert.equal(isIndexerLagError(Object.assign(new Error('unindexed'), { status: 409, code: 'IDENTITY_NOT_INDEXED' })), true);
});

test('planOnboardingAfterProfile: indexer lag skips finalize and exits 0', () => {
  const lag = planOnboardingAfterProfile({
    mintOk: true,
    profile: { ok: false, indexerLag: true },
  });
  assert.equal(lag.runFinalize, false);
  assert.equal(lag.exitCode, 0);
  assert.match(lag.hint, /finalize/);

  const ok = planOnboardingAfterProfile({ mintOk: true, profile: { ok: true } });
  assert.equal(ok.runFinalize, true);
  assert.equal(ok.exitCode, 0);

  const other = planOnboardingAfterProfile({
    mintOk: true,
    profile: { ok: false, indexerLag: false },
  });
  assert.equal(other.runFinalize, true);
});

test('cli setup and register --finalize use planOnboardingAfterProfile', () => {
  const fs = require('fs');
  const path = require('path');
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /planOnboardingAfterProfile/);
  assert.match(cli, /if \(!afterProfile\.runFinalize\)/);
});
