/**
 * S3 — an unauthenticated caller must not be able to burn nonces.
 *
 * `/j41/deposit/report` recorded the nonce and fired an outbound `getIdentityKeys`
 * BEFORE checking the signature, unauthenticated and unrated. `nonce-cache.js:78-88`
 * documents exactly this attack and ships `checkNonceAfterVerify` for it — the v2
 * access path uses it; this route did not. The cache is bounded at 100k entries and
 * SHARED with that path, so junk nonces here evict legitimate entries and reopen the
 * replay window on the paid proxy.
 *
 * Replay protection must survive the reordering: a genuine replay still finds the
 * nonce recorded from the first time it verified.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const nonceCache = require('../src/nonce-cache');

test('a failed verification leaves the nonce cache untouched', () => {
  nonceCache._reset();
  const before = nonceCache._size();
  const r = nonceCache.checkNonceAfterVerify(false, 'attacker-nonce-1', Date.now() + 60000);
  assert.equal(r.ok, false, 'an unverified caller must be rejected');
  assert.equal(nonceCache._size(), before, 'and must not have consumed a cache slot');
});

test('a thousand unverified attempts consume zero cache', () => {
  nonceCache._reset();
  for (let i = 0; i < 1000; i++) {
    nonceCache.checkNonceAfterVerify(false, `junk-${i}`, Date.now() + 60000);
  }
  assert.equal(nonceCache._size(), 0,
    'this is the eviction attack the shared cache is vulnerable to');
});

test('a verified caller records the nonce', () => {
  nonceCache._reset();
  const r = nonceCache.checkNonceAfterVerify(true, 'good-nonce', Date.now() + 60000);
  assert.equal(r.ok, true);
  assert.equal(nonceCache._size(), 1);
});

test('replay protection still works after the reorder', () => {
  nonceCache._reset();
  assert.equal(nonceCache.checkNonceAfterVerify(true, 'once', Date.now() + 60000).ok, true);
  assert.equal(nonceCache.checkNonceAfterVerify(true, 'once', Date.now() + 60000).ok, false,
    'the second use of a verified nonce must be refused');
});

test('deposit-watcher records the nonce only after the signature check', () => {
  // Order matters, not just the helper: assert the source calls the verify-gated
  // helper and no longer records unconditionally on this path.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/deposit-watcher.js'), 'utf8');
  const verifyAt = src.indexOf('BAD_SIGNATURE');
  const nonceAt = src.indexOf('checkNonceAfterVerify(true');
  assert.ok(verifyAt > -1 && nonceAt > -1, 'both the signature check and the gated nonce call must exist');
  assert.ok(nonceAt > verifyAt,
    'the nonce must be recorded AFTER the signature is verified');
});
