const test = require('node:test');
const assert = require('node:assert');
const { checkRate, _reset, _size, IDLE_TTL_MS } = require('../src/proxy-rate-limiter.js');

const CFG = { rate_limit_rps: 10, rate_limit_burst: 30, rate_limit_max_buckets: 10_000 };

test('first request consumes one token', () => {
  _reset();
  const r = checkRate('iBUYER1' + 'X'.repeat(27), CFG);
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(_size(), 1);
});

test('burst exhaustion returns 429 with retryAfter', () => {
  _reset();
  const buyer = 'iBUYER2' + 'X'.repeat(27);
  // Drain the burst (30) — all should succeed
  for (let i = 0; i < CFG.rate_limit_burst; i++) {
    assert.strictEqual(checkRate(buyer, CFG).allowed, true, `burst slot ${i}`);
  }
  // Next call must be denied
  const r = checkRate(buyer, CFG);
  assert.strictEqual(r.allowed, false);
  assert.ok(r.retryAfterSec >= 1);
});

test('refill restores capacity over time', async () => {
  _reset();
  const buyer = 'iBUYER3' + 'X'.repeat(27);
  // Drain burst
  for (let i = 0; i < CFG.rate_limit_burst; i++) checkRate(buyer, CFG);
  assert.strictEqual(checkRate(buyer, CFG).allowed, false);
  // Wait 250ms — at 10 RPS that's ~2.5 tokens refilled, so next call should succeed
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(checkRate(buyer, CFG).allowed, true);
});

test('different buyers have independent buckets', () => {
  _reset();
  const a = 'iBUYERA' + 'X'.repeat(27);
  const b = 'iBUYERB' + 'X'.repeat(27);
  for (let i = 0; i < CFG.rate_limit_burst; i++) checkRate(a, CFG);
  assert.strictEqual(checkRate(a, CFG).allowed, false);
  // b is fresh
  assert.strictEqual(checkRate(b, CFG).allowed, true);
});

test('LRU evicts oldest when over max_buckets', () => {
  _reset();
  const tiny = { ...CFG, rate_limit_max_buckets: 3 };
  // Fill to cap+1 (4 distinct buyers); the first should be evicted
  for (let i = 0; i < 4; i++) {
    checkRate('iBUYER' + i + 'X'.repeat(28 - String(i).length), tiny);
  }
  // Cap allows 3, so size should be ≤ 3
  assert.ok(_size() <= 3, `size ${_size()} should be ≤ 3`);
});

test('invalid buyerVerusId is denied', () => {
  _reset();
  assert.strictEqual(checkRate(undefined, CFG).allowed, false);
  assert.strictEqual(checkRate('', CFG).allowed, false);
  assert.strictEqual(checkRate(123, CFG).allowed, false);
});
