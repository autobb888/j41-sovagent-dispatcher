const test = require('node:test');
const assert = require('node:assert');
const { checkAndRecordNonce, checkNonceAfterVerify, _reset, _size, DEFAULT_TTL_MS } = require('../src/nonce-cache.js');

test('first sighting of a nonce is accepted', () => {
  _reset();
  const r = checkAndRecordNonce('a'.repeat(32), Date.now() + 60_000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(_size(), 1);
});

test('replayed nonce within window is rejected', () => {
  _reset();
  const n = 'b'.repeat(32);
  const exp = Date.now() + 60_000;
  assert.strictEqual(checkAndRecordNonce(n, exp).ok, true);
  const r = checkAndRecordNonce(n, exp);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'replay');
});

test('expired entry — TTL falls back to DEFAULT_TTL_MS when expiresAt is in the past', () => {
  _reset();
  const n = 'c'.repeat(32);
  // expiresAtMs in the past — first call should still record (the envelope's
  // own expiresAt is past, so signature verification will reject anyway, but
  // nonce-cache shouldn't crash on this input). The recorded TTL should fall
  // back to DEFAULT_TTL_MS, NOT to "now" (which would let immediate replays through).
  const before = Date.now();
  assert.strictEqual(checkAndRecordNonce(n, before - 1000).ok, true);
  // Same nonce within DEFAULT_TTL_MS window must be rejected as replay
  const r = checkAndRecordNonce(n, Date.now() + 1000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'replay');
});

test('invalid nonce is rejected', () => {
  _reset();
  assert.strictEqual(checkAndRecordNonce(undefined, Date.now() + 60_000).ok, false);
  assert.strictEqual(checkAndRecordNonce('', Date.now() + 60_000).ok, false);
  assert.strictEqual(checkAndRecordNonce(123, Date.now() + 60_000).ok, false);
});

// ── checkNonceAfterVerify: nonce must never be recorded before the caller's
// signature verification succeeds (wire-audit fix — an unauthenticated caller
// could otherwise burn/churn the bounded nonce cache with junk nonces). ──────
test('checkNonceAfterVerify: verified=false never touches the cache', () => {
  _reset();
  const n = 'd'.repeat(32);
  const r = checkNonceAfterVerify(false, n, Date.now() + 60_000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'signature-invalid');
  assert.strictEqual(_size(), 0, 'an invalid-signature request must not record a nonce');
  // Proof the cache is untouched: the SAME nonce, now presented as verified,
  // is accepted as a first sighting rather than being rejected as a replay.
  const r2 = checkNonceAfterVerify(true, n, Date.now() + 60_000);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(_size(), 1);
});

test('checkNonceAfterVerify: verified=true records the nonce; a replayed valid request is rejected', () => {
  _reset();
  const n = 'e'.repeat(32);
  const exp = Date.now() + 60_000;
  const first = checkNonceAfterVerify(true, n, exp);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(_size(), 1);
  // Same nonce, verified again (e.g. the same envelope replayed) — rejected.
  const replay = checkNonceAfterVerify(true, n, exp);
  assert.strictEqual(replay.ok, false);
  assert.strictEqual(replay.reason, 'replay');
});
