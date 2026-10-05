'use strict';
// A second agent hire is priced from its own payment. Pause-and-return is the
// same job until pause TTL, and it is not a rehire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { initialTokenBudget } = require('../src/token-budget');
const { findExpired } = require('../src/reactivation-queue');

const SRC = path.join(__dirname, '..', 'src');
const rateEnv = {
  J41_VRSC_USD_RATE: '1',
  J41_VRSC_USD_RATE_AT: String(Date.now()),
  J41_VRSC_RATE_MAX_AGE_MS: String(24 * 60 * 60 * 1000),
};

test('a second hire budget is the second payment only', () => {
  const first = initialTokenBudget({ model: 'deepseek-v3', amountVrsc: 1 }, rateEnv);
  const second = initialTokenBudget({ model: 'deepseek-v3', amountVrsc: 0.05 }, rateEnv);
  const again = initialTokenBudget({ model: 'deepseek-v3', amountVrsc: 0.05 }, rateEnv);
  assert.equal(typeof first.tokens, 'number');
  assert.equal(typeof second.tokens, 'number');
  assert.ok(first.tokens > second.tokens);
  assert.equal(second.tokens, again.tokens);
  assert.notEqual(second.tokens, first.tokens + second.tokens);
  const src = fs.readFileSync(path.join(SRC, 'token-budget.js'), 'utf8');
  assert.equal(src.includes('readFile'), false);
  assert.equal(src.includes('unused'), false);
  assert.match(initialTokenBudget.toString(), /amountVrsc/);
  assert.equal(/unused|remainder|leftover/.test(initialTokenBudget.toString()), false);
});

test('a paused job stays the same job until its pause time', () => {
  const pausedAt = 1_000_000;
  const entry = { job: { id: 'job-a' }, pausedAt, pauseTtlMin: 60, readyToRespawn: true };
  assert.deepEqual(findExpired([entry], pausedAt + 59 * 60000), []);
  assert.equal(findExpired([entry], pausedAt + 60 * 60000).length, 1);
  const cli = fs.readFileSync(path.join(SRC, 'cli.js'), 'utf8');
  assert.match(cli, /--pause-ttl <minutes>.*15-10080, default: 60/);
  const reactivate = cli.slice(
    cli.indexOf(".command('reactivate <buyer-agent-id> <job-id>')"),
    cli.indexOf(".command('pay-shielded <agent-id> <job-id>')"),
  );
  assert.match(reactivate, /\/reactivate`, \{\}\)/);
});
